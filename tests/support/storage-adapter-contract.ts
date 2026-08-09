import assert from "node:assert/strict";

import {
  MAX_STORAGE_PAGE_SIZE,
  StorageFailure,
  parseStorageKey,
  parseStorageOperationId,
  toPublicStorageFailure,
  type StorageAdapter,
  type StorageKey,
  type StorageOperationId,
  type StorageTransactionRequest,
} from "../../domain/storage-adapter.ts";

export type StorageAdapterContractFixture = Readonly<{
  owner: StorageAdapter;
  outsider: StorageAdapter;
}>;

export type StorageAdapterContractFactory = () => StorageAdapterContractFixture;

export class StorageAdapterContractViolation extends Error {
  readonly invariant: string;

  constructor(invariant: string, options: ErrorOptions = {}) {
    super(`Storage adapter contract failed: ${invariant}`, options);
    this.name = "StorageAdapterContractViolation";
    this.invariant = invariant;
  }
}

/** Runs the reusable behavioral contract against one fresh adapter fixture. */
export async function verifyStorageAdapterContract(
  createFixture: StorageAdapterContractFactory,
): Promise<void> {
  await verifyIdempotency(createFixture());
  await verifyDuplicateProtection(createFixture());
  await verifyCompareAndSet(createFixture());
  await verifyAtomicity(createFixture());
  await verifyAuthorizationAndDisclosure(createFixture());
  await verifyPagination(createFixture());
}

async function verifyIdempotency(fixture: StorageAdapterContractFixture) {
  const request = createRequest("operation:idempotent", privateKey("one"), {
    value: "first",
  });
  const first = await fixture.owner.transact(request);
  const replay = await fixture.owner.transact(request);

  requireInvariant(first.replayed === false, "idempotency.first-application");
  requireInvariant(replay.replayed === true, "idempotency.replay-marker");
  requireInvariant(
    JSON.stringify(first.records) === JSON.stringify(replay.records),
    "idempotency.same-result",
  );

  const changed = createRequest("operation:idempotent", privateKey("two"), {
    value: "different",
  });
  await expectFailure(
    () => fixture.owner.transact(changed),
    "CONFLICT",
    "idempotency.operation-reuse",
  );
}

async function verifyDuplicateProtection(fixture: StorageAdapterContractFixture) {
  const key = privateKey("duplicate");
  await fixture.owner.transact(createRequest("operation:create-one", key, { value: 1 }));
  await expectFailure(
    () => fixture.owner.transact(createRequest("operation:create-two", key, { value: 2 })),
    "CONFLICT",
    "duplicate.create",
  );
  const stored = await fixture.owner.read(key);
  requireInvariant(stored?.value.value === 1, "duplicate.preserved-value");
}

async function verifyCompareAndSet(fixture: StorageAdapterContractFixture) {
  const key = privateKey("drift");
  await fixture.owner.transact(createRequest("operation:drift-create", key, { value: 1 }));
  await fixture.owner.transact(replaceRequest("operation:drift-update", key, 1, { value: 2 }));
  await expectFailure(
    () => fixture.owner.transact(
      replaceRequest("operation:drift-stale", key, 1, { value: 3 }),
    ),
    "PRECONDITION_FAILED",
    "compare-and-set.stale-write",
  );
  const stored = await fixture.owner.read(key);
  requireInvariant(stored?.revision === 2, "compare-and-set.revision");
  requireInvariant(stored?.value.value === 2, "compare-and-set.preserved-value");
}

async function verifyAtomicity(fixture: StorageAdapterContractFixture) {
  const existing = privateKey("atomic-existing");
  const candidate = privateKey("atomic-candidate");
  await fixture.owner.transact(
    createRequest("operation:atomic-seed", existing, { value: "seed" }),
  );

  await expectFailure(
    () => fixture.owner.transact({
      operationId: operationId("operation:atomic-fail"),
      mutations: [
        { type: "put", key: candidate, expectedRevision: null, value: { value: "new" } },
        { type: "put", key: existing, expectedRevision: null, value: { value: "bad" } },
      ],
    }),
    "CONFLICT",
    "transaction.atomic-failure",
  );
  requireInvariant(
    await fixture.owner.read(candidate) === null,
    "transaction.atomic-rollback",
  );
}

async function verifyAuthorizationAndDisclosure(
  fixture: StorageAdapterContractFixture,
) {
  const existing = privateKey("private-existing");
  const missing = privateKey("private-missing");
  const secret = "private-contract-value";
  await fixture.owner.transact(
    createRequest("operation:private-seed", existing, { secret }),
  );

  let existingRead: unknown;
  let missingRead: unknown;
  try {
    existingRead = await fixture.outsider.read(existing);
    missingRead = await fixture.outsider.read(missing);
  } catch (error) {
    throw new StorageAdapterContractViolation("authorization.read-shape", {
      cause: error,
    });
  }
  requireInvariant(existingRead === null, "authorization.foreign-read");
  requireInvariant(missingRead === null, "authorization.missing-read");

  const denied = await captureStorageFailure(
    () => fixture.outsider.transact(
      replaceRequest("operation:foreign-existing", existing, 1, { secret: "changed" }),
    ),
    "authorization.foreign-write",
  );
  const absent = await captureStorageFailure(
    () => fixture.outsider.transact(
      replaceRequest("operation:foreign-missing", missing, 1, { secret: "changed" }),
    ),
    "authorization.missing-write",
  );
  requireInvariant(denied.code === "NOT_FOUND", "authorization.failure-code");
  requireInvariant(absent.code === "NOT_FOUND", "authorization.missing-code");

  const deniedPublic = JSON.stringify(toPublicStorageFailure(denied));
  const absentPublic = JSON.stringify(toPublicStorageFailure(absent));
  requireInvariant(deniedPublic === absentPublic, "disclosure.failure-equivalence");
  requireInvariant(!deniedPublic.includes(secret), "disclosure.private-value");
  requireInvariant(!deniedPublic.includes(existing.id), "disclosure.record-id");

  const stored = await fixture.owner.read(existing);
  requireInvariant(stored?.value.secret === secret, "authorization.no-mutation");
}

async function verifyPagination(fixture: StorageAdapterContractFixture) {
  for (const [index, id] of ["page-a", "page-b", "page-c"].entries()) {
    await fixture.owner.transact(
      createRequest(`operation:page-${index}`, privateKey(id), { index }),
    );
  }

  const first = await fixture.owner.list({
    collection: privateKey("page-a").collection,
    limit: 2,
  });
  requireInvariant(first.items.length === 2, "pagination.first-size");
  requireInvariant(first.nextCursor !== null, "pagination.cursor");

  const second = await fixture.owner.list({
    collection: privateKey("page-a").collection,
    limit: 2,
    ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
  });
  requireInvariant(second.items.length === 1, "pagination.second-size");
  requireInvariant(second.nextCursor === null, "pagination.end");

  await expectFailure(
    () => fixture.owner.list({
      collection: privateKey("page-a").collection,
      limit: MAX_STORAGE_PAGE_SIZE + 1,
    }),
    "INVALID_REQUEST",
    "pagination.boundary",
  );
}

async function captureStorageFailure(
  operation: () => Promise<unknown>,
  invariant: string,
): Promise<StorageFailure> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof StorageFailure) return error;
    throw new StorageAdapterContractViolation(`${invariant}.failure-shape`, {
      cause: error,
    });
  }
  throw new StorageAdapterContractViolation(`${invariant}.missing-failure`);
}

async function expectFailure(
  operation: () => Promise<unknown>,
  code: StorageFailure["code"],
  invariant: string,
) {
  const error = await captureStorageFailure(operation, invariant);
  requireInvariant(error.code === code, `${invariant}.code`);
}

function createRequest(
  operation: string,
  key: StorageKey,
  value: Readonly<Record<string, string | number>>,
): StorageTransactionRequest {
  return {
    operationId: operationId(operation),
    mutations: [{ type: "put", key, expectedRevision: null, value }],
  };
}

function replaceRequest(
  operation: string,
  key: StorageKey,
  expectedRevision: number,
  value: Readonly<Record<string, string | number>>,
): StorageTransactionRequest {
  return {
    operationId: operationId(operation),
    mutations: [{ type: "put", key, expectedRevision, value }],
  };
}

function privateKey(id: string): StorageKey {
  const result = parseStorageKey("private-records", id);
  assert(result.ok);
  return result.value;
}

function operationId(value: string): StorageOperationId {
  const result = parseStorageOperationId(value);
  assert(result.ok);
  return result.value;
}

function requireInvariant(condition: boolean, invariant: string): asserts condition {
  if (!condition) throw new StorageAdapterContractViolation(invariant);
}
