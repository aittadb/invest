import assert from "node:assert/strict";
import test from "node:test";

import {
  parseActorSubject,
  parseStableId,
  parseTimestamp,
  type ActorSubject,
  type StableId,
  type Timestamp,
} from "../domain/foundation.ts";
import {
  StorageFailure,
  assertStorageListBoundary,
  assertStorageTransactionBoundary,
  parseStorageOperationId,
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
  InMemoryAcknowledgmentRepository,
  InMemoryPackageVersionRepository,
  type RecordPackageAcceptanceRequest,
} from "../repositories/in-memory-content-repository.ts";

test("both content repositories honor replay, revision, and stale-write contracts", async () => {
  const fixture = createFixture();
  const firstDraft = packageDraft(
    "package:v1",
    "2026-08-01T09:00:00.000Z",
    true,
    "Private first version",
  );
  const firstRequest = {
    operationId: operationId("operation:package-v1"),
    expectedRevision: null,
    draft: firstDraft,
  };

  const first = await fixture.ownerPackages.append(firstRequest);
  const firstReplay = await fixture.ownerPackages.append(firstRequest);
  assert.equal(first.revision, 1);
  assert.equal(first.replayed, false);
  assert.equal(firstReplay.replayed, true);
  assert.deepEqual(firstReplay.snapshot, first.snapshot);

  await rejectsStorage(
    () => fixture.ownerPackages.append({
      ...firstRequest,
      draft: packageDraft(
        "package:v1",
        "2026-08-01T09:00:00.000Z",
        true,
        "Changed retry",
      ),
    }),
    "CONFLICT",
  );

  const second = await fixture.ownerPackages.append({
    operationId: operationId("operation:package-v2"),
    expectedRevision: 1,
    draft: packageDraft(
      "package:v2",
      "2026-08-01T10:00:00.000Z",
      false,
      "Private second version",
    ),
  });
  assert.equal(second.revision, 2);

  await rejectsStorage(
    () => fixture.ownerPackages.append({
      operationId: operationId("operation:package-v3-stale"),
      expectedRevision: 1,
      draft: packageDraft(
        "package:v3",
        "2026-08-01T11:00:00.000Z",
        true,
        "Stale package version",
      ),
    }),
    "PRECONDITION_FAILED",
  );
  assert.equal(
    await fixture.ownerPackages.get(stableId("package:v3")),
    null,
  );

  const firstAcceptanceRequest = acceptanceRequest(
    "acceptance:one",
    "package:v2",
    "2026-08-01T10:05:00.000Z",
    "operation:acceptance-one",
    null,
  );
  const firstAcceptance = await fixture.aliceAcknowledgments.record(
    firstAcceptanceRequest,
  );
  const acceptanceReplay = await fixture.aliceAcknowledgments.record(
    firstAcceptanceRequest,
  );
  assert.equal(firstAcceptance.revision, 1);
  assert.equal(acceptanceReplay.replayed, true);
  assert.deepEqual(acceptanceReplay.snapshot, firstAcceptance.snapshot);

  await rejectsStorage(
    () => fixture.aliceAcknowledgments.record({
      ...firstAcceptanceRequest,
      acceptedAt: timestamp("2026-08-01T10:06:00.000Z"),
    }),
    "CONFLICT",
  );

  const third = await fixture.ownerPackages.append({
    operationId: operationId("operation:package-v3"),
    expectedRevision: 2,
    draft: packageDraft(
      "package:v3",
      "2026-08-01T11:00:00.000Z",
      true,
      "Current third version",
    ),
  });
  const secondAcceptance = await fixture.aliceAcknowledgments.record(
    acceptanceRequest(
      "acceptance:two",
      third.snapshot.id,
      "2026-08-01T11:05:00.000Z",
      "operation:acceptance-two",
      1,
    ),
  );
  assert.equal(secondAcceptance.revision, 2);

  const fourth = await fixture.ownerPackages.append({
    operationId: operationId("operation:package-v4"),
    expectedRevision: 3,
    draft: packageDraft(
      "package:v4",
      "2026-08-01T12:00:00.000Z",
      true,
      "Current fourth version",
    ),
  });
  const staleAcceptanceId = stableId<"package-acceptance">("acceptance:stale");
  await rejectsStorage(
    () => fixture.aliceAcknowledgments.record({
      operationId: operationId("operation:acceptance-stale"),
      expectedRevision: 1,
      id: staleAcceptanceId,
      acceptedAt: timestamp("2026-08-01T12:05:00.000Z"),
      acceptedVersionId: fourth.snapshot.id,
    }),
    "PRECONDITION_FAILED",
  );
  assert.equal(
    await fixture.aliceAcknowledgments.get(staleAcceptanceId),
    null,
  );
  assert.equal((await fixture.ownerPackages.current())?.revision, 4);
  assert.equal((await fixture.aliceAcknowledgments.latest())?.revision, 2);
});

test("snapshots stay immutable and material changes renew acceptance", async () => {
  const fixture = createFixture();
  const mutableDraft = packageDraft(
    "package:material-v1",
    "2026-08-02T09:00:00.000Z",
    true,
    "Original private title",
  );
  const first = await fixture.ownerPackages.append({
    operationId: operationId("operation:material-v1"),
    expectedRevision: null,
    draft: mutableDraft,
  });

  mutableDraft.changeSummary = "Mutated input";
  mutableDraft.sections[0].title = "Mutated private title";
  const historical = await fixture.ownerPackages.get(first.snapshot.id);
  assert.equal(historical?.changeSummary, "Version package:material-v1");
  assert.equal(historical?.sections[0].title, "Original private title");
  assert.equal(Object.isFrozen(historical), true);
  assert.equal(Object.isFrozen(historical?.sections), true);
  assert.equal(Object.isFrozen(historical?.sections[0]), true);
  assert.equal(
    Reflect.set(historical as object, "changeSummary", "Changed output"),
    false,
  );

  assert.equal(
    await fixture.aliceAcknowledgments.requiresCurrentAcceptance(),
    true,
  );
  const acceptedFirst = await fixture.aliceAcknowledgments.record(
    acceptanceRequest(
      "acceptance:material-v1",
      first.snapshot.id,
      "2026-08-02T09:05:00.000Z",
      "operation:material-accept-v1",
      null,
    ),
  );
  assert.equal(Object.isFrozen(acceptedFirst.snapshot), true);
  assert.equal(
    await fixture.aliceAcknowledgments.requiresCurrentAcceptance(),
    false,
  );

  const nonMaterial = await fixture.ownerPackages.append({
    operationId: operationId("operation:material-v2"),
    expectedRevision: 1,
    draft: packageDraft(
      "package:material-v2",
      "2026-08-02T10:00:00.000Z",
      false,
      "Editorial correction",
    ),
  });
  assert.notEqual(nonMaterial.snapshot.contentHash, first.snapshot.contentHash);
  assert.equal(
    nonMaterial.snapshot.requiredAcceptanceHash,
    first.snapshot.requiredAcceptanceHash,
  );
  assert.equal(
    await fixture.aliceAcknowledgments.requiresCurrentAcceptance(),
    false,
  );

  const materialDraft = packageDraft(
    "package:material-v3",
    "2026-08-02T11:00:00.000Z",
    true,
    "Material terms changed",
  ) as ReturnType<typeof packageDraft> & {
    requiredAcceptanceHash?: string;
  };
  materialDraft.requiredAcceptanceHash = first.snapshot.requiredAcceptanceHash;
  const material = await fixture.ownerPackages.append({
    operationId: operationId("operation:material-v3"),
    expectedRevision: 2,
    draft: materialDraft,
  });
  assert.equal(
    material.snapshot.requiredAcceptanceHash,
    material.snapshot.contentHash,
  );
  assert.notEqual(
    material.snapshot.requiredAcceptanceHash,
    first.snapshot.requiredAcceptanceHash,
  );
  assert.equal(
    await fixture.aliceAcknowledgments.requiresCurrentAcceptance(),
    true,
  );

  await rejectsStorage(
    () => fixture.aliceAcknowledgments.record(
      acceptanceRequest(
        "acceptance:historical",
        nonMaterial.snapshot.id,
        "2026-08-02T11:05:00.000Z",
        "operation:historical-acceptance",
        1,
      ),
    ),
    "PRECONDITION_FAILED",
  );

  const acceptedMaterial = await fixture.aliceAcknowledgments.record(
    acceptanceRequest(
      "acceptance:material-v3",
      material.snapshot.id,
      "2026-08-02T11:06:00.000Z",
      "operation:material-accept-v3",
      1,
    ),
  );
  assert.equal(
    acceptedMaterial.snapshot.satisfiedRequirementHash,
    material.snapshot.requiredAcceptanceHash,
  );
  assert.equal(
    await fixture.aliceAcknowledgments.requiresCurrentAcceptance(),
    false,
  );
});

test("subjects and adapter grants prevent private or foreign disclosure", async () => {
  const fixture = createFixture();
  const privateDraft = packageDraft(
    "package:private",
    "2026-08-03T09:00:00.000Z",
    true,
    "Confidential allocation discussion",
  );
  privateDraft.sections[0].markdown = "Private package value: never disclose";
  const stored = await fixture.ownerPackages.append({
    operationId: operationId("operation:private-package"),
    expectedRevision: null,
    draft: privateDraft,
  });

  assert.equal(
    (await fixture.participantPackages.current())?.snapshot.id,
    stored.snapshot.id,
  );
  assert.equal(await fixture.visitorPackages.current(), null);
  assert.equal(await fixture.visitorPackages.get(stored.snapshot.id), null);

  const deniedPackageError = await captureStorageFailure(
    () => fixture.visitorPackages.append({
      operationId: operationId("operation:visitor-private-write"),
      expectedRevision: null,
      draft: privateDraft,
    }),
  );
  assert.equal(deniedPackageError.code, "NOT_FOUND");
  const publicFailure = JSON.stringify(
    toPublicStorageFailure(deniedPackageError),
  );
  assert.equal(publicFailure.includes("never disclose"), false);
  assert.equal(publicFailure.includes("package:private"), false);

  const maliciousRequest = {
    ...acceptanceRequest(
      "acceptance:alice-private",
      stored.snapshot.id,
      "2026-08-03T09:05:00.000Z",
      "operation:alice-private-acceptance",
      null,
    ),
    participantSubject: fixture.bob,
    acceptedContentHash: "sha256:client-controlled",
    satisfiedRequirementHash: "sha256:client-controlled",
  } as unknown as RecordPackageAcceptanceRequest;
  const accepted = await fixture.aliceAcknowledgments.record(maliciousRequest);
  assert.equal(accepted.snapshot.participantSubject, fixture.alice);
  assert.equal(
    accepted.snapshot.acceptedContentHash,
    stored.snapshot.contentHash,
  );
  assert.equal(
    accepted.snapshot.satisfiedRequirementHash,
    stored.snapshot.requiredAcceptanceHash,
  );

  assert.equal(
    await fixture.bobAcknowledgments.get(accepted.snapshot.id),
    null,
  );
  assert.equal(await fixture.bobAcknowledgments.latest(), null);
  assert.equal(
    await fixture.visitorAcknowledgments.get(accepted.snapshot.id),
    null,
  );
  assert.equal(await fixture.visitorAcknowledgments.latest(), null);

  const visitorAcceptanceError = await captureStorageFailure(
    () => fixture.visitorAcknowledgments.record(
      acceptanceRequest(
        "acceptance:visitor",
        stored.snapshot.id,
        "2026-08-03T09:06:00.000Z",
        "operation:visitor-acceptance",
        null,
      ),
    ),
  );
  assert.equal(visitorAcceptanceError.code, "NOT_FOUND");
  assert.deepEqual(
    toPublicStorageFailure(visitorAcceptanceError),
    toPublicStorageFailure(deniedPackageError),
  );
  await rejectsStorage(
    () => fixture.visitorAcknowledgments.requiresCurrentAcceptance(),
    "NOT_FOUND",
  );
});

type Fixture = Readonly<{
  alice: ActorSubject;
  bob: ActorSubject;
  ownerPackages: InMemoryPackageVersionRepository;
  participantPackages: InMemoryPackageVersionRepository;
  visitorPackages: InMemoryPackageVersionRepository;
  aliceAcknowledgments: InMemoryAcknowledgmentRepository;
  bobAcknowledgments: InMemoryAcknowledgmentRepository;
  visitorAcknowledgments: InMemoryAcknowledgmentRepository;
}>;

function createFixture(): Fixture {
  const state = new MemoryStorageState();
  const ownerStorage = new DeterministicMemoryStorageAdapter(
    state,
    () => true,
    () => true,
  );
  const participantStorage = new DeterministicMemoryStorageAdapter(
    state,
    () => true,
    (key) => key.collection.startsWith("private-package-acceptance"),
  );
  const visitorStorage = new DeterministicMemoryStorageAdapter(
    state,
    () => false,
    () => false,
  );
  const ownerPackages = new InMemoryPackageVersionRepository(ownerStorage);
  const participantPackages = new InMemoryPackageVersionRepository(
    participantStorage,
  );
  const visitorPackages = new InMemoryPackageVersionRepository(visitorStorage);
  const alice = actorSubject("oidc:alice");
  const bob = actorSubject("oidc:bob");

  return {
    alice,
    bob,
    ownerPackages,
    participantPackages,
    visitorPackages,
    aliceAcknowledgments: new InMemoryAcknowledgmentRepository(
      participantStorage,
      participantPackages,
      alice,
    ),
    bobAcknowledgments: new InMemoryAcknowledgmentRepository(
      participantStorage,
      participantPackages,
      bob,
    ),
    visitorAcknowledgments: new InMemoryAcknowledgmentRepository(
      visitorStorage,
      visitorPackages,
      null,
    ),
  };
}

function packageDraft(
  id: string,
  createdAt: string,
  materialChange: boolean,
  title: string,
) {
  return {
    id,
    createdAt,
    changeSummary: `Version ${id}`,
    materialChange,
    acknowledgmentText: "I acknowledge this information package.",
    sections: [
      {
        id: `section:${id}`,
        order: 0,
        title,
        markdown: `# ${title}`,
        enabled: true,
      },
    ],
  };
}

function acceptanceRequest(
  id: string,
  versionId: string,
  acceptedAt: string,
  operation: string,
  expectedRevision: number | null,
): RecordPackageAcceptanceRequest {
  return {
    operationId: operationId(operation),
    expectedRevision,
    id: stableId<"package-acceptance">(id),
    acceptedAt: timestamp(acceptedAt),
    acceptedVersionId: stableId<"package-version">(versionId),
  };
}

function actorSubject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  assert(parsed.ok);
  return parsed.value;
}

function stableId<Entity extends string>(value: string): StableId<Entity> {
  const parsed = parseStableId<Entity>(value);
  assert(parsed.ok);
  return parsed.value;
}

function timestamp(value: string): Timestamp {
  const parsed = parseTimestamp(value);
  assert(parsed.ok);
  return parsed.value;
}

function operationId(value: string) {
  const parsed = parseStorageOperationId(value);
  assert(parsed.ok);
  return parsed.value;
}

async function rejectsStorage(
  operation: () => Promise<unknown>,
  code: StorageFailure["code"],
): Promise<void> {
  const error = await captureStorageFailure(operation);
  assert.equal(error.code, code);
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

type StorageAccess = (key: StorageKey) => boolean;

class MemoryStorageState {
  readonly records = new Map<string, StorageRecord>();
  readonly operations = new Map<
    string,
    Readonly<{ fingerprint: string; result: StorageTransactionResult }>
  >();
}

class DeterministicMemoryStorageAdapter implements StorageAdapter {
  readonly #state: MemoryStorageState;
  readonly #canRead: StorageAccess;
  readonly #canWrite: StorageAccess;

  constructor(
    state: MemoryStorageState,
    canRead: StorageAccess,
    canWrite: StorageAccess,
  ) {
    this.#state = state;
    this.#canRead = canRead;
    this.#canWrite = canWrite;
  }

  async read(key: StorageKey): Promise<StorageRecord | null> {
    if (!this.#canRead(key)) return null;
    return cloneRecord(this.#state.records.get(storageKeyString(key)) ?? null);
  }

  async list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    assertStorageListBoundary(request);
    const start = request.cursor === undefined ? 0 : parseCursor(request.cursor);
    const all = [...this.#state.records.values()]
      .filter(
        (record) =>
          record.key.collection === request.collection &&
          this.#canRead(record.key),
      )
      .sort((left, right) => left.key.id.localeCompare(right.key.id));
    if (start < 0 || start > all.length) {
      throw new StorageFailure("INVALID_REQUEST");
    }
    const items = all
      .slice(start, start + request.limit)
      .map((record) => cloneRecord(record))
      .filter((record): record is StorageRecord => record !== null);
    const next = start + items.length;
    return {
      items: Object.freeze(items),
      nextCursor: next < all.length
        ? (`cursor:${next}` as StorageCursor)
        : null,
    };
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    assertStorageTransactionBoundary(request);
    if (request.mutations.some((mutation) => !this.#canWrite(mutation.key))) {
      throw new StorageFailure("NOT_FOUND");
    }

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
    const records: (StorageRecord | null)[] = [];
    for (const mutation of request.mutations) {
      const key = storageKeyString(mutation.key);
      const current = nextRecords.get(key);
      if (mutation.type === "delete") {
        nextRecords.delete(key);
        records.push(null);
        continue;
      }
      const record = freezeRecord({
        key: mutation.key,
        revision: (current?.revision ?? 0) + 1,
        value: mutation.value,
      });
      nextRecords.set(key, record);
      records.push(record);
    }

    this.#state.records.clear();
    for (const [key, record] of nextRecords) {
      this.#state.records.set(key, record);
    }
    const result: StorageTransactionResult = Object.freeze({
      replayed: false,
      records: Object.freeze(records.map((record) => cloneRecord(record))),
    });
    this.#state.operations.set(operationKey, { fingerprint, result });
    return cloneResult(result, false);
  }
}

function parseCursor(cursor: StorageCursor): number {
  const match = /^cursor:(\d+)$/.exec(cursor);
  if (!match) throw new StorageFailure("INVALID_REQUEST");
  return Number.parseInt(match[1], 10);
}

function cloneResult(
  result: StorageTransactionResult,
  replayed: boolean,
): StorageTransactionResult {
  return Object.freeze({
    replayed,
    records: Object.freeze(
      result.records.map((record) => cloneRecord(record)),
    ),
  });
}

function cloneRecord(record: StorageRecord | null): StorageRecord | null {
  return record === null
    ? null
    : freezeRecord({
        key: record.key,
        revision: record.revision,
        value: record.value,
      });
}

function freezeRecord(input: {
  key: StorageKey;
  revision: number;
  value: StorageDocument;
}): StorageRecord {
  return Object.freeze({
    key: Object.freeze({ ...input.key }),
    revision: input.revision,
    value: deepFreeze(cloneJson(input.value)),
  });
}

function cloneJson(value: StorageDocument): StorageDocument {
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
