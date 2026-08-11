import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_FOUNDER_APPLICATION_REVISIONS,
  MAX_PROFILE_LINKS,
  MAX_PROFILE_LINK_LENGTH,
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
  FOUNDER_APPLICATION_FIELDS_CHUNK_RAW_BYTES,
  MAX_FOUNDER_APPLICATION_REVIEW_DETAIL_RECORD_READS,
  MAX_FOUNDER_APPLICATION_REVIEW_LOOKUP_BACKFILL_READS,
  StorageFounderApplicationRepository,
  StorageFounderApplicationReviewDetailRepository,
  StorageFounderApplicationReviewLookupBackfillRepository,
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
  const reviewId = await reviewIdForApplication(ALICE);
  const currentKey = currentRecordFor(state, ALICE).key.id;
  assert.notEqual(
    reviewId.slice("founder-review:".length),
    currentKey.slice("founder-current:".length),
  );
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

test("legacy review IDs gain one bounded backend-only lookup without changing identity", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await seedApplication(storage, ALICE, "alice-backfill");
  const reviewId = await reviewIdForApplication(ALICE);
  const lookupOperationId =
    `founder-review-index:${reviewId.slice("founder-review:".length)}`;
  const lookupEntry = [...state.records.entries()].find(([, record]) =>
    record.key.collection === "founder-review-lookups"
  );
  assert(lookupEntry);
  state.records.delete(lookupEntry[0]);
  state.operations.delete(lookupOperationId);

  const before = await new StorageFounderApplicationReviewDetailRepository(
    storage,
  ).get(reviewId);
  assert.equal(before, null);

  const responseLoss = new CommitThenUnavailableStorageAdapter(storage);
  const observed = new ObservedStorageAdapter(responseLoss);
  const backfill = new StorageFounderApplicationReviewLookupBackfillRepository(
    observed,
  );
  assert.equal(await backfill.backfill({
    applicantSubject: ALICE,
    applicationId: "founder-application:self",
  }), reviewId);
  assert.equal(observed.listCalls, 0);
  assert.equal(responseLoss.transactionCalls, 1);
  assert.ok(
    observed.readCalls <=
      MAX_FOUNDER_APPLICATION_REVIEW_LOOKUP_BACKFILL_READS,
  );
  const durableRecordCount = state.records.size;
  const durableOperationCount = state.operations.size;

  observed.reset();
  const restartedBackfill =
    new StorageFounderApplicationReviewLookupBackfillRepository(observed);
  assert.equal(await restartedBackfill.backfill({
    applicantSubject: ALICE,
    applicationId: "founder-application:self",
  }), reviewId);
  assert.equal(responseLoss.transactionCalls, 2);
  assert.equal(state.records.size, durableRecordCount);
  assert.equal(state.operations.size, durableOperationCount);
  assert.equal(observed.listCalls, 0);
  assert.ok(
    observed.readCalls <=
      MAX_FOUNDER_APPLICATION_REVIEW_LOOKUP_BACKFILL_READS,
  );

  observed.reset();
  const restored = await new StorageFounderApplicationReviewDetailRepository(
    observed,
  ).get(reviewId);
  assert(restored);
  assert.equal(restored.reviewId, reviewId);
  assert.equal(restored.application.applicantSubject, ALICE);
  assert.equal(observed.listCalls, 0);
  assert.ok(
    observed.readCalls <= MAX_FOUNDER_APPLICATION_REVIEW_DETAIL_RECORD_READS,
  );
});

test("valid revision-16 maximum fields resolve directly inside the finite read ceiling", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const configuredChoices = maximumContributionAreaChoices();
  const participant = new StorageFounderApplicationRepository(
    storage,
    ALICE,
    configuredChoices,
  );
  const fields = maximumFounderFields("\u0800", configuredChoices);
  await participant.create({
    operationId: "founder-operation:maximum-detail-create",
    expectedRevision: null,
    id: "founder-application:self",
    occurredAt: "2026-08-11T10:00:00.000Z",
    historyEntryId: "founder-history:maximum-detail-create",
    fields,
  });
  for (
    let revision = 1;
    revision < MAX_FOUNDER_APPLICATION_REVISIONS - 1;
    revision += 1
  ) {
    await participant.edit({
      operationId: `founder-operation:maximum-detail-edit-${revision}`,
      expectedRevision: revision,
      id: "founder-application:self",
      occurredAt: new Date(
        Date.parse("2026-08-11T10:00:00.000Z") + revision * 60_000,
      ).toISOString(),
      historyEntryId: `founder-history:maximum-detail-edit-${revision}`,
      fields,
    });
  }
  const withdrawn = await participant.withdraw({
    operationId: "founder-operation:maximum-detail-withdraw",
    expectedRevision: MAX_FOUNDER_APPLICATION_REVISIONS - 1,
    id: "founder-application:self",
    occurredAt: "2026-08-11T12:00:00.000Z",
    historyEntryId: "founder-history:maximum-detail-withdraw",
  });
  assert.equal(withdrawn.revision, MAX_FOUNDER_APPLICATION_REVISIONS);

  const fieldRecords = [...state.records.values()].filter((record) =>
    record.key.collection === "founder-application-fields"
  );
  const editableRevisions = MAX_FOUNDER_APPLICATION_REVISIONS - 1;
  assert.equal(fieldRecords.length % editableRevisions, 0);
  const chunksPerEditableRevision = fieldRecords.length / editableRevisions;
  const maximumFieldBytes = new TextEncoder().encode(
    JSON.stringify(withdrawn.snapshot.fields),
  ).byteLength;
  assert.equal(
    chunksPerEditableRevision,
    Math.ceil(
      maximumFieldBytes / FOUNDER_APPLICATION_FIELDS_CHUNK_RAW_BYTES,
    ),
  );
  assert.equal(chunksPerEditableRevision, 5);

  const observed = new ObservedStorageAdapter(storage);
  const reviewId = await reviewIdForApplication(ALICE);
  const detail = await new StorageFounderApplicationReviewDetailRepository(
    observed,
  ).get(reviewId);
  assert(detail);
  assert.equal(detail.application.revision, MAX_FOUNDER_APPLICATION_REVISIONS);
  assert.equal(
    detail.application.history.length,
    MAX_FOUNDER_APPLICATION_REVISIONS,
  );
  assert.equal(
    detail.application.fields.professionalProfileLinks.length,
    MAX_PROFILE_LINKS,
  );
  assert.equal(observed.listCalls, 0);
  assert.equal(
    observed.readCalls,
    2 + MAX_FOUNDER_APPLICATION_REVISIONS + fieldRecords.length,
  );
  assert.ok(
    observed.readCalls <= MAX_FOUNDER_APPLICATION_REVIEW_DETAIL_RECORD_READS,
  );
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
      name: "crossed review lookup",
      apply(state) {
        const alice = reviewLookupRecordFor(state, ALICE);
        const bob = reviewLookupRecordFor(state, BOB);
        replaceRecord(state, alice, bob.value, alice.revision);
      },
    },
    {
      name: "missing current record",
      apply(state) {
        const current = currentRecordFor(state, ALICE);
        const entry = [...state.records.entries()].find(([, record]) =>
          record === current
        );
        assert(entry);
        state.records.delete(entry[0]);
      },
    },
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
    const reviewId = await reviewIdForApplication(ALICE);
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

class CommitThenUnavailableStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  transactionCalls = 0;
  #failed = false;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  read: StorageAdapter["read"] = (key) => this.#delegate.read(key);
  list: StorageAdapter["list"] = (request) => this.#delegate.list(request);

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    this.transactionCalls += 1;
    const result = await this.#delegate.transact(request);
    if (!this.#failed) {
      this.#failed = true;
      throw new StorageFailure("UNAVAILABLE");
    }
    return result;
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

async function reviewIdForApplication(
  applicantSubject: ActorSubject,
): Promise<string> {
  const applicationId = "founder-application:self";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `founder-review\u0000${applicantSubject}\u0000${applicationId}`,
    ),
  );
  return `founder-review:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
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

function reviewLookupRecordFor(
  state: MemoryStorageState,
  applicantSubject: ActorSubject,
): StorageRecord {
  const record = [...state.records.values()].find((candidate) =>
    candidate.key.collection === "founder-review-lookups" &&
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

function maximumContributionAreaChoices(): readonly ContributionAreaChoice[] {
  const parsed = parseContributionAreaChoices(
    Array.from({ length: 64 }, (_, index) => {
      const prefix = `area:${index}:`;
      return {
        id: `${prefix}${"x".repeat(128 - prefix.length)}`,
        label: `Area ${index}`,
      };
    }),
  );
  assert(parsed.ok);
  return parsed.value;
}

function maximumFounderFields(
  character: string,
  configuredChoices: readonly ContributionAreaChoice[],
) {
  return {
    expertiseSummary: character.repeat(4_000),
    intendedContribution: character.repeat(4_000),
    primaryContributionAreaId: configuredChoices[0]?.id,
    secondaryContributionAreaIds: configuredChoices
      .slice(1, 17)
      .map((choice) => choice.id),
    approximateAvailability: character.repeat(500),
    possibleStartTiming: character.repeat(500),
    compensationExpectation: character.repeat(500),
    professionalProfileLinks: Array.from(
      { length: MAX_PROFILE_LINKS },
      (_, index) => {
        const prefix = `https://profiles.invalid/${index}/`;
        return `${prefix}${character.repeat(MAX_PROFILE_LINK_LENGTH - prefix.length)}`;
      },
    ),
    note: character.repeat(4_000),
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
