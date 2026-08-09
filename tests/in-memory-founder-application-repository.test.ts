import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseContributionAreaChoices,
  type ContributionAreaChoice,
  type FounderApplicationId,
} from "../domain/founder-application.ts";
import {
  parseActorSubject,
  parseStableId,
  type ActorSubject,
} from "../domain/foundation.ts";
import {
  StorageFailure,
  assertStorageListBoundary,
  assertStorageTransactionBoundary,
  storageKeyString,
  toPublicStorageFailure,
  type StorageAdapter,
  type StorageCursor,
  type StorageDocument,
  type StorageKey,
  type StoragePage,
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import {
  DevelopmentInMemoryFounderApplicationReviewRepository,
  DevelopmentInMemoryFounderApplicationRepository,
  type CreateFounderApplicationRequest,
  type EditFounderApplicationRequest,
  type FounderApplicationRepository,
  type WithdrawFounderApplicationRequest,
} from "../repositories/in-memory-founder-application-repository.ts";

const ALICE_SUBJECT = actorSubject("issuer.invalid/subject:alice");
const BOB_SUBJECT = actorSubject("issuer.invalid/subject:bob");
const OWNER_SUBJECT = actorSubject("issuer.invalid/subject:owner");
const APPLICATION_ID = applicationId("founder-application:alice");

const contributionAreaChoices = choices([
  { id: "area:engineering", label: "Engineering" },
  { id: "area:product", label: "Product" },
  { id: "area:operations", label: "Operations" },
]);

export type FounderApplicationRepositoryContractFixture = Readonly<{
  owner: FounderApplicationRepository;
  reopenOwner: () => FounderApplicationRepository;
  foreign: FounderApplicationRepository;
  anonymous: FounderApplicationRepository;
  denied: FounderApplicationRepository;
  missing: FounderApplicationRepository;
}>;

export type FounderApplicationRepositoryContractFactory =
  () => FounderApplicationRepositoryContractFixture;

/** Reusable behavior contract for development and production founder repositories. */
export async function verifyFounderApplicationRepositoryContract(
  createFixture: FounderApplicationRepositoryContractFactory,
): Promise<void> {
  const fixture = createFixture();
  assert.equal(await fixture.owner.get(APPLICATION_ID), null);

  const mutableCreateFields = fields();
  const create = {
    operationId: "founder-operation:create",
    expectedRevision: null,
    id: APPLICATION_ID,
    occurredAt: "2026-08-09T10:00:00.000Z",
    historyEntryId: "founder-history:create",
    fields: mutableCreateFields,
    applicantSubject: BOB_SUBJECT,
  } satisfies CreateFounderApplicationRequest &
    Readonly<{ applicantSubject: ActorSubject }>;

  const created = await fixture.owner.create(create);
  const createReplay = await fixture.owner.create(create);
  assert.equal(created.replayed, false);
  assert.equal(createReplay.replayed, true);
  assert.equal(created.revision, 1);
  assert.equal(created.snapshot.applicantSubject, ALICE_SUBJECT);
  assert.equal(created.snapshot.status, "received");
  assert.deepEqual(createReplay.snapshot, created.snapshot);
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(created.snapshot), true);
  assert.equal(Object.isFrozen(created.snapshot.history), true);

  const reopenedAfterCreate = fixture.reopenOwner();
  assert.deepEqual(
    await reopenedAfterCreate.get(APPLICATION_ID),
    created.snapshot,
  );

  mutableCreateFields.note = "Changed retry must not replace private history.";
  mutableCreateFields.secondaryContributionAreaIds.push("area:operations");
  await rejectsStorage(
    () => fixture.owner.create(create),
    "CONFLICT",
  );
  const unchangedAfterChangedCreate = await fixture.owner.get(APPLICATION_ID);
  assert.equal(unchangedAfterChangedCreate?.history[0]?.fields.note, "Initial note.");
  assert.deepEqual(
    unchangedAfterChangedCreate?.history[0]?.fields.secondaryContributionAreaIds,
    ["area:product"],
  );

  const edit = editRequest({
    operationId: "founder-operation:edit",
    expectedRevision: 1,
    occurredAt: "2026-08-09T11:00:00.000Z",
    historyEntryId: "founder-history:edit",
    fields: fields({
      intendedContribution: "Lead a bounded product validation project.",
      secondaryContributionAreaIds: ["area:operations"],
      note: "Edited note.",
    }),
  });
  const edited = await fixture.owner.edit(edit);
  const editReplay = await fixture.reopenOwner().edit(edit);
  assert.equal(edited.replayed, false);
  assert.equal(editReplay.replayed, true);
  assert.equal(edited.revision, 2);
  assert.equal(edited.snapshot.history.length, 2);
  assert.equal(edited.snapshot.history[1]?.kind, "edited");
  assert.equal(
    edited.snapshot.fields.intendedContribution,
    "Lead a bounded product validation project.",
  );
  assert.deepEqual(edited.snapshot.history[0], created.snapshot.history[0]);
  assert.equal(created.snapshot.fields.note, "Initial note.");

  await rejectsStorage(
    () => fixture.owner.edit({
      ...edit,
      fields: fields({ note: "Changed edit retry." }),
    }),
    "CONFLICT",
  );
  await rejectsStorage(
    () => fixture.owner.edit(editRequest({
      operationId: "founder-operation:stale-edit",
      expectedRevision: 1,
      occurredAt: "2026-08-09T11:30:00.000Z",
      historyEntryId: "founder-history:stale-edit",
      fields: fields({ note: "Stale private edit." }),
    })),
    "PRECONDITION_FAILED",
  );

  const reopenedAfterEdit = fixture.reopenOwner();
  const persistedEdit = await reopenedAfterEdit.get(APPLICATION_ID);
  assert.deepEqual(persistedEdit, edited.snapshot);
  assert.equal(Object.isFrozen(persistedEdit?.history[0]), true);
  assert.equal(
    Reflect.set(persistedEdit?.history[0] ?? {}, "revision", 99),
    false,
  );

  const withdraw = withdrawRequest({
    operationId: "founder-operation:withdraw",
    expectedRevision: 2,
    occurredAt: "2026-08-09T12:00:00.000Z",
    historyEntryId: "founder-history:withdraw",
  });
  const withdrawn = await fixture.owner.withdraw(withdraw);
  const withdrawReplay = await fixture.reopenOwner().withdraw(withdraw);
  assert.equal(withdrawn.replayed, false);
  assert.equal(withdrawReplay.replayed, true);
  assert.equal(withdrawn.revision, 3);
  assert.equal(withdrawn.snapshot.status, "withdrawn");
  assert.equal(withdrawn.snapshot.history[2]?.kind, "withdrawn");
  assert.deepEqual(withdrawn.snapshot.history[0], created.snapshot.history[0]);
  assert.deepEqual(withdrawn.snapshot.history[1], edited.snapshot.history[1]);

  await rejectsStorage(
    () => fixture.owner.withdraw({
      ...withdraw,
      occurredAt: "2026-08-09T12:01:00.000Z",
    }),
    "CONFLICT",
  );

  assert.equal(await fixture.foreign.get(APPLICATION_ID), null);
  assert.equal(await fixture.anonymous.get(APPLICATION_ID), null);
  assert.equal(await fixture.denied.get(APPLICATION_ID), null);
  assert.equal(await fixture.missing.get(APPLICATION_ID), null);

  const foreignWrite = await captureStorageFailure(() =>
    fixture.foreign.edit(editRequest({
      operationId: "founder-operation:foreign-edit",
      expectedRevision: 3,
      occurredAt: "2026-08-09T13:00:00.000Z",
      historyEntryId: "founder-history:foreign-edit",
      fields: fields({ note: "Foreign private edit." }),
    })),
  );
  const missingWrite = await captureStorageFailure(() =>
    fixture.missing.edit(editRequest({
      operationId: "founder-operation:missing-edit",
      expectedRevision: 3,
      occurredAt: "2026-08-09T13:00:00.000Z",
      historyEntryId: "founder-history:missing-edit",
      fields: fields({ note: "Missing private edit." }),
    })),
  );
  const anonymousWrite = await captureStorageFailure(() =>
    fixture.anonymous.withdraw(withdrawRequest({
      operationId: "founder-operation:anonymous-withdraw",
      expectedRevision: 3,
      occurredAt: "2026-08-09T13:00:00.000Z",
      historyEntryId: "founder-history:anonymous-withdraw",
    })),
  );
  const deniedWrite = await captureStorageFailure(() =>
    fixture.denied.withdraw(withdrawRequest({
      operationId: "founder-operation:denied-withdraw",
      expectedRevision: 3,
      occurredAt: "2026-08-09T13:00:00.000Z",
      historyEntryId: "founder-history:denied-withdraw",
    })),
  );
  const anonymousCreate = await captureStorageFailure(() =>
    fixture.anonymous.create({
      operationId: "founder-operation:anonymous-create",
      expectedRevision: null,
      id: "founder-application:anonymous",
      occurredAt: "2026-08-09T13:00:00.000Z",
      historyEntryId: "founder-history:anonymous-create",
      fields: fields(),
    }),
  );

  for (const failure of [
    foreignWrite,
    missingWrite,
    anonymousWrite,
    deniedWrite,
    anonymousCreate,
  ]) {
    assert.equal(failure.code, "NOT_FOUND");
    assert.deepEqual(
      toPublicStorageFailure(failure),
      toPublicStorageFailure(missingWrite),
    );
  }
  const publicFailure = JSON.stringify(toPublicStorageFailure(foreignWrite));
  assert.equal(publicFailure.includes("Foreign private edit"), false);
  assert.equal(publicFailure.includes(APPLICATION_ID), false);
  assert.deepEqual(await fixture.owner.get(APPLICATION_ID), withdrawn.snapshot);
}

test("adapter-backed development repository passes the founder contract", async () => {
  await verifyFounderApplicationRepositoryContract(() => {
    const state = new MemoryStorageState();
    const ownerStorage = new DeterministicMemoryStorageAdapter(state, true);
    return {
      owner: repository(ownerStorage, ALICE_SUBJECT),
      reopenOwner: () => repository(ownerStorage, ALICE_SUBJECT),
      foreign: repository(ownerStorage, BOB_SUBJECT),
      anonymous: repository(ownerStorage, null),
      denied: repository(
        new DeterministicMemoryStorageAdapter(state, false),
        ALICE_SUBJECT,
      ),
      missing: repository(
        new DeterministicMemoryStorageAdapter(
          new MemoryStorageState(),
          true,
        ),
        ALICE_SUBJECT,
      ),
    };
  });
});

test("current records are checked against immutable adapter history", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state, true);
  const owner = repository(adapter, ALICE_SUBJECT);
  await owner.create(createRequest());
  await owner.edit(editRequest({
    operationId: "founder-operation:integrity-edit",
    expectedRevision: 1,
    occurredAt: "2026-08-10T11:00:00.000Z",
    historyEntryId: "founder-history:integrity-edit",
    fields: fields({ note: "Current note." }),
  }));

  const currentEntry = [...state.records.entries()].find(([, record]) =>
    record.key.collection === "founder-applications"
  );
  assert.notEqual(currentEntry, undefined);
  if (currentEntry === undefined) return;
  const [key, current] = currentEntry;
  const corrupted = cloneDocument(current.value) as MutableRecord;
  const application = mutableRecord(corrupted.application);
  const history = application.history as MutableRecord[];
  const firstFields = mutableRecord(history[0]?.fields);
  firstFields.note = "Consistently rewritten prior history.";
  state.records.set(key, freezeRecord({
    key: current.key,
    revision: current.revision,
    value: corrupted as StorageDocument,
  }));

  await rejectsStorage(
    () => repository(adapter, ALICE_SUBJECT).get(APPLICATION_ID),
    "UNAVAILABLE",
  );
});

test("configured owner can page and inspect opaque founder review records", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state, true);
  const alice = repository(adapter, ALICE_SUBJECT);
  const bob = repository(adapter, BOB_SUBJECT);
  const aliceApplication = await alice.create(createRequest());
  await bob.create({
    ...createRequest(),
    operationId: "founder-operation:bob-create",
    id: "founder-application:bob",
    historyEntryId: "founder-history:bob-create",
    fields: fields({ note: "Bob private note." }),
  });

  const owner = new DevelopmentInMemoryFounderApplicationReviewRepository(
    adapter,
    OWNER_SUBJECT,
    OWNER_SUBJECT,
    contributionAreaChoices,
  );
  const firstPage = await owner.list({ limit: 1 });
  assert.equal(firstPage.items.length, 1);
  assert.notEqual(firstPage.nextCursor, null);
  const secondPage = await owner.list({
    limit: 1,
    ...(firstPage.nextCursor ? { cursor: firstPage.nextCursor } : {}),
  });
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.nextCursor, null);

  const allItems = [...firstPage.items, ...secondPage.items];
  assert.equal(new Set(allItems.map((item) => item.reviewId)).size, 2);
  for (const item of allItems) {
    assert.match(item.reviewId, /^founder-review:[0-9a-f]{64}$/);
    assert.equal(item.reviewId.includes(item.application.applicantSubject), false);
    assert.equal(Object.isFrozen(item), true);
  }
  const aliceReview = allItems.find(
    (item) => item.application.id === APPLICATION_ID,
  );
  assert.notEqual(aliceReview, undefined);
  if (aliceReview === undefined) return;
  assert.deepEqual(await owner.get(aliceReview.reviewId), aliceReview);
  assert.deepEqual(aliceReview.application, aliceApplication.snapshot);

  for (const actor of [BOB_SUBJECT, null]) {
    const foreign = new DevelopmentInMemoryFounderApplicationReviewRepository(
      adapter,
      actor,
      OWNER_SUBJECT,
      contributionAreaChoices,
    );
    assert.deepEqual(await foreign.list({ limit: 10 }), {
      items: [],
      nextCursor: null,
    });
    assert.equal(await foreign.get(aliceReview.reviewId), null);
    assert.equal(await foreign.get("malformed-review-id"), null);
  }
});

test("founder repository has no investment-indication dependency", async () => {
  const source = await readFile(
    new URL(
      "../repositories/in-memory-founder-application-repository.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(source, /investment-indication|indication-repository/);
});

function repository(
  storage: StorageAdapter,
  subject: ActorSubject | null,
): DevelopmentInMemoryFounderApplicationRepository {
  return new DevelopmentInMemoryFounderApplicationRepository(
    storage,
    subject,
    contributionAreaChoices,
  );
}

function createRequest(): CreateFounderApplicationRequest {
  return {
    operationId: "founder-operation:integrity-create",
    expectedRevision: null,
    id: APPLICATION_ID,
    occurredAt: "2026-08-10T10:00:00.000Z",
    historyEntryId: "founder-history:integrity-create",
    fields: fields(),
  };
}

function editRequest(
  input: Omit<EditFounderApplicationRequest, "id">,
): EditFounderApplicationRequest {
  return { id: APPLICATION_ID, ...input };
}

function withdrawRequest(
  input: Omit<WithdrawFounderApplicationRequest, "id">,
): WithdrawFounderApplicationRequest {
  return { id: APPLICATION_ID, ...input };
}

function fields(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    expertiseSummary: "Experience developing data systems.",
    intendedContribution: "Contribute to product development and validation.",
    primaryContributionAreaId: "area:engineering",
    secondaryContributionAreaIds: ["area:product"],
    approximateAvailability: "Part-time during the initial phase.",
    possibleStartTiming: "After mutual confirmation.",
    compensationExpectation: "Open to discussion.",
    professionalProfileLinks: ["https://profiles.invalid/alice"],
    note: "Initial note.",
    ...overrides,
  } as {
    expertiseSummary: string;
    intendedContribution: string;
    primaryContributionAreaId: string;
    secondaryContributionAreaIds: string[];
    approximateAvailability: string;
    possibleStartTiming: string;
    compensationExpectation: string;
    professionalProfileLinks: string[];
    note: string | null;
  };
}

function choices(value: unknown): readonly ContributionAreaChoice[] {
  const parsed = parseContributionAreaChoices(value);
  assert(parsed.ok);
  return parsed.value;
}

function actorSubject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  assert(parsed.ok);
  return parsed.value;
}

function applicationId(value: string): FounderApplicationId {
  const parsed = parseStableId<"founder-application">(value);
  assert(parsed.ok);
  return parsed.value;
}

async function rejectsStorage(
  operation: () => Promise<unknown>,
  code: StorageFailure["code"],
): Promise<void> {
  const failure = await captureStorageFailure(operation);
  assert.equal(failure.code, code);
}

async function captureStorageFailure(
  operation: () => Promise<unknown>,
): Promise<StorageFailure> {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof StorageFailure);
    return error;
  }
  assert.fail("Expected a StorageFailure.");
}

class MemoryStorageState {
  readonly records = new Map<string, StorageRecord>();
  readonly operations = new Map<
    string,
    Readonly<{ fingerprint: string; result: StorageTransactionResult }>
  >();
}

class DeterministicMemoryStorageAdapter implements StorageAdapter {
  readonly #state: MemoryStorageState;
  readonly #permitted: boolean;

  constructor(state: MemoryStorageState, permitted: boolean) {
    this.#state = state;
    this.#permitted = permitted;
  }

  async read(key: StorageKey): Promise<StorageRecord | null> {
    if (!this.#permitted) return null;
    return cloneRecord(this.#state.records.get(storageKeyString(key)) ?? null);
  }

  async list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    assertStorageListBoundary(request);
    if (!this.#permitted) return { items: [], nextCursor: null };

    const start = request.cursor === undefined ? 0 : parseCursor(request.cursor);
    const all = [...this.#state.records.values()]
      .filter((record) => record.key.collection === request.collection)
      .sort((left, right) => left.key.id.localeCompare(right.key.id));
    if (start < 0 || start > all.length) {
      throw new StorageFailure("INVALID_REQUEST");
    }
    const items = all.slice(start, start + request.limit).map(cloneRecord);
    const next = start + items.length;
    return {
      items: items.filter((item): item is StorageRecord => item !== null),
      nextCursor: next < all.length
        ? (`memory-cursor:${next}` as StorageCursor)
        : null,
    };
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    assertStorageTransactionBoundary(request);
    if (!this.#permitted) throw new StorageFailure("NOT_FOUND");

    const operationKey = request.operationId as string;
    const fingerprint = JSON.stringify(request);
    const prior = this.#state.operations.get(operationKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new StorageFailure("CONFLICT");
      }
      return cloneResult(prior.result, true);
    }

    for (const mutation of request.mutations) {
      const current = this.#state.records.get(storageKeyString(mutation.key));
      if (mutation.expectedRevision === null) {
        if (current) throw new StorageFailure("CONFLICT");
      } else if (!current || current.revision !== mutation.expectedRevision) {
        throw new StorageFailure("PRECONDITION_FAILED");
      }
    }

    const nextRecords = new Map(this.#state.records);
    const resultRecords: (StorageRecord | null)[] = [];
    for (const mutation of request.mutations) {
      const key = storageKeyString(mutation.key);
      const current = nextRecords.get(key);
      if (mutation.type === "delete") {
        nextRecords.delete(key);
        resultRecords.push(null);
        continue;
      }
      const record = freezeRecord({
        key: mutation.key,
        revision: (current?.revision ?? 0) + 1,
        value: mutation.value,
      });
      nextRecords.set(key, record);
      resultRecords.push(record);
    }

    this.#state.records.clear();
    for (const [key, record] of nextRecords) {
      this.#state.records.set(key, record);
    }
    const result = Object.freeze({
      replayed: false,
      records: Object.freeze(resultRecords.map(cloneRecord)),
    });
    this.#state.operations.set(operationKey, { fingerprint, result });
    return cloneResult(result, false);
  }
}

function parseCursor(cursor: StorageCursor): number {
  const match = /^memory-cursor:(\d+)$/.exec(cursor);
  if (!match) throw new StorageFailure("INVALID_REQUEST");
  return Number.parseInt(match[1], 10);
}

function cloneResult(
  result: StorageTransactionResult,
  replayed: boolean,
): StorageTransactionResult {
  return Object.freeze({
    replayed,
    records: Object.freeze(result.records.map(cloneRecord)),
  });
}

function cloneRecord(record: StorageRecord | null): StorageRecord | null {
  if (record === null) return null;
  return freezeRecord({
    key: record.key,
    revision: record.revision,
    value: record.value,
  });
}

function freezeRecord(input: Readonly<{
  key: StorageKey;
  revision: number;
  value: StorageDocument;
}>): StorageRecord {
  return Object.freeze({
    key: Object.freeze({ ...input.key }),
    revision: input.revision,
    value: deepFreeze(cloneDocument(input.value)),
  });
}

type MutableRecord = Record<string, unknown>;

function mutableRecord(value: unknown): MutableRecord {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as MutableRecord;
}

function cloneDocument(value: StorageDocument): StorageDocument {
  return JSON.parse(JSON.stringify(value)) as StorageDocument;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
