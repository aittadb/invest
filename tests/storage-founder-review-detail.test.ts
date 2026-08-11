import assert from "node:assert/strict";
import test from "node:test";

import {
  parseContributionAreaChoices,
  type ContributionAreaChoice,
} from "../domain/founder-application.ts";
import { parseActorSubject, type ActorSubject } from "../domain/foundation.ts";
import {
  StorageFailure,
  type StorageAdapter,
  type StorageDocument,
  type StoragePage,
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import {
  MAX_FOUNDER_APPLICATION_REVIEW_DETAIL_RECORD_READS,
  StorageFounderApplicationRepository,
  StorageFounderApplicationReviewDetailRepository,
} from "../repositories/in-memory-founder-application-repository.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";

const ALICE = subject("issuer.invalid/subject:founder-detail-alice");
const BOB = subject("issuer.invalid/subject:founder-detail-bob");
const CHOICES = contributionChoices();
const PRIVATE_NOTE = "Private detail visible only to the configured owner.";

test("persistent founder detail resolves one opaque key across restart", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const participant = await seedApplication(storage, ALICE, "alice");
  await participant.edit({
    operationId: "founder-operation:alice-edit",
    expectedRevision: 1,
    id: "founder-application:self",
    occurredAt: "2026-08-11T11:00:00.000Z",
    historyEntryId: "founder-history:alice-edit",
    fields: founderFields("area:product"),
  });
  const reviewId = reviewIdForCurrentRecord(state, ALICE);
  const operationCount = state.operations.size;
  const observed = new ObservedStorageAdapter(storage);

  const first = await new StorageFounderApplicationReviewDetailRepository(
    observed,
  ).get(reviewId);
  assert(first);
  assert.equal(first.reviewId, reviewId);
  assert.equal(first.application.revision, 2);
  assert.equal(first.application.fields.primaryContributionAreaId, "area:product");
  assert.equal(first.application.fields.note, PRIVATE_NOTE);
  assert.deepEqual(
    first.application.history.map((entry) => entry.kind),
    ["created", "edited"],
  );
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.application), true);
  assert.equal(reviewId.includes(ALICE), false);
  assert.equal(observed.listCalls, 0);
  assert.ok(
    observed.readCalls <= MAX_FOUNDER_APPLICATION_REVIEW_DETAIL_RECORD_READS,
  );

  observed.reset();
  const restarted = await new StorageFounderApplicationReviewDetailRepository(
    observed,
  ).get(reviewId);
  assert.deepEqual(restarted, first);
  assert.equal(observed.listCalls, 0);
  assert.ok(
    observed.readCalls <= MAX_FOUNDER_APPLICATION_REVIEW_DETAIL_RECORD_READS,
  );
  assert.equal(state.operations.size, operationCount);
});

test("persistent founder detail rejects malformed and missing IDs finitely", async () => {
  const state = new MemoryStorageState();
  const storage = new ObservedStorageAdapter(new MemoryStorageAdapter(state));
  const repository = new StorageFounderApplicationReviewDetailRepository(
    storage,
  );

  for (const malformed of [
    null,
    "founder-review:short",
    `founder-review:${"g".repeat(64)}`,
    `founder-review:${"f".repeat(64)}:private`,
  ]) {
    await rejectsStorage(() => repository.get(malformed), "INVALID_REQUEST");
  }
  assert.equal(storage.readCalls, 0);
  assert.equal(storage.listCalls, 0);

  const missing = await repository.get(
    `founder-review:${"f".repeat(64)}`,
  );
  assert.equal(missing, null);
  assert.equal(storage.readCalls, 1);
  assert.equal(storage.listCalls, 0);

  const privateCause = `${ALICE}: private storage failure`;
  const failed = new StorageFounderApplicationReviewDetailRepository({
    async read() {
      throw new StorageFailure("UNAVAILABLE", {
        cause: new Error(privateCause),
      });
    },
    async list() {
      throw new Error("detail lookup must not list");
    },
    async transact() {
      throw new Error("detail lookup must not write");
    },
  });
  await assert.rejects(
    failed.get(`founder-review:${"e".repeat(64)}`),
    (error) =>
      error instanceof StorageFailure &&
      error.code === "UNAVAILABLE" &&
      error.cause === undefined &&
      !error.message.includes(privateCause),
  );
});

test("persistent founder detail fails closed on crossed and corrupt records", async () => {
  const corruptions: readonly Readonly<{
    name: string;
    apply(state: MemoryStorageState): void;
  }>[] = [
    {
      name: "crossed current record",
      apply(state) {
        const alice = currentRecordFor(state, ALICE);
        const bob = currentRecordFor(state, BOB);
        replaceRecord(state, alice, bob.value, alice.revision);
      },
    },
    {
      name: "missing immutable history",
      apply(state) {
        const entry = [...state.records.entries()].find(([, record]) =>
          record.key.collection === "founder-application-history"
        );
        assert(entry);
        state.records.delete(entry[0]);
      },
    },
    {
      name: "changed private field chunk",
      apply(state) {
        const chunk = firstRecordIn(state, "founder-application-fields");
        const value = cloneDocument(chunk.value);
        const data = String(value.data);
        value.data = `${data.startsWith("A") ? "B" : "A"}${data.slice(1)}`;
        replaceRecord(state, chunk, value, chunk.revision);
      },
    },
    {
      name: "hostile maximum revision",
      apply(state) {
        const current = currentRecordFor(state, ALICE);
        const value = cloneDocument(current.value);
        value.revision = 16;
        replaceRecord(state, current, value, 16);
      },
    },
  ];

  for (const corruption of corruptions) {
    const state = new MemoryStorageState();
    const storage = new MemoryStorageAdapter(state);
    await seedApplication(storage, ALICE, `alice-${corruption.name}`);
    await seedApplication(storage, BOB, `bob-${corruption.name}`);
    const reviewId = reviewIdForCurrentRecord(state, ALICE);
    corruption.apply(state);
    const observed = new ObservedStorageAdapter(
      new MemoryStorageAdapter(state),
    );
    const repository = new StorageFounderApplicationReviewDetailRepository(
      observed,
    );

    await rejectsStorage(
      () => repository.get(reviewId),
      "UNAVAILABLE",
      corruption.name,
    );
    assert.equal(observed.listCalls, 0, corruption.name);
    assert.ok(
      observed.readCalls <= MAX_FOUNDER_APPLICATION_REVIEW_DETAIL_RECORD_READS,
      corruption.name,
    );
  }
});

class ObservedStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readCalls = 0;
  listCalls = 0;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  reset(): void {
    this.readCalls = 0;
    this.listCalls = 0;
  }

  read(key: Parameters<StorageAdapter["read"]>[0]): Promise<StorageRecord | null> {
    this.readCalls += 1;
    return this.#delegate.read(key);
  }

  list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    this.listCalls += 1;
    return this.#delegate.list(request);
  }

  transact(request: StorageTransactionRequest): Promise<StorageTransactionResult> {
    return this.#delegate.transact(request);
  }
}

async function seedApplication(
  storage: StorageAdapter,
  applicantSubject: ActorSubject,
  suffix: string,
): Promise<StorageFounderApplicationRepository> {
  const repository = new StorageFounderApplicationRepository(
    storage,
    applicantSubject,
    CHOICES,
  );
  const result = await repository.create({
    operationId: `founder-operation:${slug(suffix)}-create`,
    expectedRevision: null,
    id: "founder-application:self",
    occurredAt: "2026-08-11T10:00:00.000Z",
    historyEntryId: `founder-history:${slug(suffix)}-create`,
    fields: founderFields("area:engineering"),
  });
  assert.equal(result.revision, 1);
  return repository;
}

function reviewIdForCurrentRecord(
  state: MemoryStorageState,
  applicantSubject: ActorSubject,
): string {
  const current = currentRecordFor(state, applicantSubject);
  assert.match(current.key.id, /^founder-current:[0-9a-f]{64}$/u);
  return `founder-review:${current.key.id.slice("founder-current:".length)}`;
}

function currentRecordFor(
  state: MemoryStorageState,
  applicantSubject: ActorSubject,
): StorageRecord {
  const record = [...state.records.values()].find((candidate) =>
    candidate.key.collection === "founder-applications" &&
    candidate.value.applicantSubject === applicantSubject
  );
  assert(record);
  return record;
}

function firstRecordIn(
  state: MemoryStorageState,
  collection: string,
): StorageRecord {
  const record = [...state.records.values()].find((candidate) =>
    candidate.key.collection === collection
  );
  assert(record);
  return record;
}

function replaceRecord(
  state: MemoryStorageState,
  original: StorageRecord,
  value: StorageDocument,
  revision: number,
): void {
  const entry = [...state.records.entries()].find(([, record]) =>
    record === original
  );
  assert(entry);
  state.records.set(entry[0], {
    key: original.key,
    revision,
    value,
  });
}

function cloneDocument(
  value: StorageDocument,
): Record<string, StorageDocument[string]> {
  return JSON.parse(JSON.stringify(value)) as Record<
    string,
    StorageDocument[string]
  >;
}

function founderFields(primaryContributionAreaId: string) {
  return {
    expertiseSummary: "Experience developing data products.",
    intendedContribution: "Contribute to product delivery and validation.",
    primaryContributionAreaId,
    secondaryContributionAreaIds: [],
    approximateAvailability: "Two days each week.",
    possibleStartTiming: "After mutual confirmation.",
    compensationExpectation: "Open to discussion.",
    professionalProfileLinks: ["https://profiles.example.invalid/founder"],
    note: PRIVATE_NOTE,
  };
}

function contributionChoices(): readonly ContributionAreaChoice[] {
  const parsed = parseContributionAreaChoices([
    { id: "area:engineering", label: "Engineering" },
    { id: "area:product", label: "Product" },
  ]);
  assert(parsed.ok);
  return parsed.value;
}

function subject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  assert(parsed.ok);
  return parsed.value;
}

function slug(value: string): string {
  return value.replaceAll(/[^a-z]+/gu, "-").replaceAll(/^-|-$/gu, "");
}

async function rejectsStorage(
  action: () => Promise<unknown>,
  code: StorageFailure["code"],
  message?: string,
): Promise<void> {
  await assert.rejects(
    action,
    (error) => error instanceof StorageFailure && error.code === code,
    message,
  );
}
