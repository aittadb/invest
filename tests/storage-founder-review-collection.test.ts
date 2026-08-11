import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseContributionAreaChoices,
  type ContributionAreaChoice,
} from "../domain/founder-application.ts";
import { parseActorSubject, type ActorSubject } from "../domain/foundation.ts";
import {
  StorageFailure,
  storageKeyString,
  type StorageAdapter,
  type StorageCursor,
  type StorageDocument,
  type StoragePage,
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import {
  MAX_FOUNDER_APPLICATION_FIELDS_CHUNKS,
  MAX_FOUNDER_APPLICATION_REVIEW_PAGE_RECORD_READS,
  MAX_FOUNDER_APPLICATION_REVIEW_PAGE_SIZE,
  StorageFounderApplicationRepository,
  StorageFounderApplicationReviewCollectionRepository,
} from "../repositories/in-memory-founder-application-repository.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";

const ALICE = subject("issuer.invalid/subject:founder-alice");
const BOB = subject("issuer.invalid/subject:founder-bob");
const PRIVATE_NOTE = "Private founder note must not enter the collection.";
const CHOICES = contributionChoices();

test("persistent founder review paging is opaque, bounded, and restartable", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await seedApplication(storage, ALICE, "alice", "area:engineering");
  await seedApplication(storage, BOB, "bob", "area:product");
  const operationCount = state.operations.size;
  const observed = new ObservedStorageAdapter(storage);

  const firstRepository =
    new StorageFounderApplicationReviewCollectionRepository(observed);
  const first = await firstRepository.list({ limit: 1 });
  assert.equal(first.items.length, 1);
  assert.notEqual(first.nextCursor, null);
  assert.equal(first.nextCursor?.includes(ALICE), false);
  assert.equal(first.nextCursor?.includes(BOB), false);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.items), true);
  assert.deepEqual(Object.keys(first.items[0] ?? {}), [
    "reviewId",
    "status",
    "primaryContributionAreaId",
    "updatedAt",
    "revision",
  ]);
  assert.match(first.items[0]?.reviewId ?? "", /^founder-review:[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(first), /founder-application:self|Private founder note/u);
  assert.equal(observed.listCalls, 1);
  assert.ok(observed.readCalls <= MAX_FOUNDER_APPLICATION_FIELDS_CHUNKS);

  observed.reset();
  const restarted = new StorageFounderApplicationReviewCollectionRepository(
    observed,
  );
  const second = await restarted.list({
    limit: 1,
    cursor: requiredCursor(first.nextCursor),
  });
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(observed.listCalls, 1);
  assert.ok(observed.readCalls <= MAX_FOUNDER_APPLICATION_FIELDS_CHUNKS);
  assert.equal(state.operations.size, operationCount);
  assert.equal(
    new Set([...first.items, ...second.items].map((item) => item.reviewId)).size,
    2,
  );

  const all = await restarted.list({ limit: 2 });
  assert.deepEqual(
    new Set(all.items.map((item) => item.primaryContributionAreaId)),
    new Set(["area:engineering", "area:product"]),
  );
  assert.ok(
    observed.readCalls <= MAX_FOUNDER_APPLICATION_REVIEW_PAGE_RECORD_READS,
  );
});

test("persistent founder review rejects malformed requests and backend pages finitely", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await seedApplication(storage, ALICE, "alice", "area:engineering");
  const repository = new StorageFounderApplicationReviewCollectionRepository(
    storage,
  );

  for (const request of [
    { limit: 0 },
    { limit: MAX_FOUNDER_APPLICATION_REVIEW_PAGE_SIZE + 1 },
    { limit: 1, cursor: "" },
    { limit: 1, cursor: "line\nbreak" },
    { limit: 1, cursor: "x".repeat(2_049) },
    { limit: 1, privateSubject: ALICE },
  ]) {
    await rejectsStorage(
      () => repository.list(request as never),
      "INVALID_REQUEST",
    );
  }

  const current = [...state.records.values()].find(
    (record) => record.key.collection === "founder-applications",
  );
  assert(current);
  const noProgress = new StorageFounderApplicationReviewCollectionRepository({
    read: (key) => storage.read(key),
    async list(request) {
      return {
        items: [current],
        nextCursor: request.cursor ?? ("opaque:next" as StorageCursor),
      };
    },
    transact: (request) => storage.transact(request),
  });
  await rejectsStorage(
    () => noProgress.list({
      limit: 1,
      cursor: "opaque:next" as StorageCursor,
    }),
    "UNAVAILABLE",
  );

  for (const nextCursor of ["", "line\nbreak", "x".repeat(2_049)]) {
    const malformedCursor =
      new StorageFounderApplicationReviewCollectionRepository({
        read: (key) => storage.read(key),
        async list() {
          return {
            items: [current],
            nextCursor: nextCursor as StorageCursor,
          };
        },
        transact: (request) => storage.transact(request),
      });
    await rejectsStorage(
      () => malformedCursor.list({ limit: 1 }),
      "UNAVAILABLE",
    );
  }

  const privateCause = `${ALICE}: private backend failure`;
  const failed = new StorageFounderApplicationReviewCollectionRepository({
    read: (key) => storage.read(key),
    async list() {
      throw new StorageFailure("UNAVAILABLE", {
        cause: new Error(privateCause),
      });
    },
    transact: (request) => storage.transact(request),
  });
  await assert.rejects(
    failed.list({ limit: 1 }),
    (error) =>
      error instanceof StorageFailure &&
      error.code === "UNAVAILABLE" &&
      error.cause === undefined &&
      !error.message.includes(privateCause),
  );
});

test("persistent founder review corruption fails within the page read ceiling", async () => {
  const baseline = new MemoryStorageState();
  await seedApplication(
    new MemoryStorageAdapter(baseline),
    ALICE,
    "alice",
    "area:engineering",
  );

  const corruptions: readonly Readonly<{
    name: string;
    apply(state: MemoryStorageState): void;
  }>[] = [
    {
      name: "unknown current status",
      apply: (state) => mutateFirstRecord(
        state,
        "founder-applications",
        (value) => {
          value.status = "private-corrupt-status";
        },
      ),
    },
    {
      name: "subject and key mismatch",
      apply: (state) => mutateFirstRecord(
        state,
        "founder-applications",
        (value) => {
          value.applicantSubject = BOB;
        },
      ),
    },
    {
      name: "missing current field chunk",
      apply: (state) => {
        const entry = [...state.records.entries()].find(([, record]) =>
          record.key.collection === "founder-application-fields"
        );
        assert(entry);
        state.records.delete(entry[0]);
      },
    },
    {
      name: "changed current field bytes",
      apply: (state) => mutateFirstRecord(
        state,
        "founder-application-fields",
        (value) => {
          const data = String(value.data);
          value.data = `${data.startsWith("A") ? "B" : "A"}${data.slice(1)}`;
        },
      ),
    },
  ];

  for (const corruption of corruptions) {
    const state = cloneState(baseline);
    corruption.apply(state);
    const observed = new ObservedStorageAdapter(
      new MemoryStorageAdapter(state),
    );
    const repository = new StorageFounderApplicationReviewCollectionRepository(
      observed,
    );
    await rejectsStorage(
      () => repository.list({ limit: 1 }),
      "UNAVAILABLE",
      corruption.name,
    );
    assert.equal(observed.listCalls, 1, corruption.name);
    assert.ok(
      observed.readCalls <= MAX_FOUNDER_APPLICATION_FIELDS_CHUNKS,
      corruption.name,
    );
  }
});

test("founder review collection implementation has no logging surface", async () => {
  const source = await readFile(
    new URL(
      "../repositories/in-memory-founder-application-repository.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const route = await readFile(
    new URL("../worker/routes/owner-founder-review.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(`${source}\n${route}`, /console\s*\.|logger\s*\./u);
});

class ObservedStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  listCalls = 0;
  readCalls = 0;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  reset(): void {
    this.listCalls = 0;
    this.readCalls = 0;
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
  primaryContributionAreaId: string,
): Promise<void> {
  const repository = new StorageFounderApplicationRepository(
    storage,
    applicantSubject,
    CHOICES,
  );
  const result = await repository.create({
    operationId: `founder-operation:${suffix}-create`,
    expectedRevision: null,
    id: "founder-application:self",
    occurredAt: "2026-08-10T10:00:00.000Z",
    historyEntryId: `founder-history:${suffix}-create`,
    fields: {
      expertiseSummary: "Experience developing data products.",
      intendedContribution: "Contribute to product delivery and validation.",
      primaryContributionAreaId,
      secondaryContributionAreaIds: [],
      approximateAvailability: "Two days each week.",
      possibleStartTiming: "After mutual confirmation.",
      compensationExpectation: "Open to discussion.",
      professionalProfileLinks: [],
      note: PRIVATE_NOTE,
    },
  });
  assert.equal(result.revision, 1);
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

function requiredCursor(value: StorageCursor | null): StorageCursor {
  assert(value);
  return value;
}

function mutateFirstRecord(
  state: MemoryStorageState,
  collection: string,
  mutate: (value: Record<string, unknown>) => void,
): void {
  const record = [...state.records.values()].find(
    (candidate) => candidate.key.collection === collection,
  );
  assert(record);
  const value = structuredClone(record.value) as Record<string, unknown>;
  mutate(value);
  state.records.set(storageKeyString(record.key), Object.freeze({
    key: record.key,
    revision: record.revision,
    value: value as StorageDocument,
  }));
}

function cloneState(source: MemoryStorageState): MemoryStorageState {
  const state = new MemoryStorageState();
  for (const [key, record] of source.records) {
    state.records.set(key, structuredClone(record));
  }
  return state;
}

async function rejectsStorage(
  operation: () => Promise<unknown>,
  code: StorageFailure["code"],
  message?: string,
): Promise<void> {
  await assert.rejects(
    operation,
    (error) =>
      error instanceof StorageFailure &&
      error.code === code &&
      error.cause === undefined,
    message,
  );
}
