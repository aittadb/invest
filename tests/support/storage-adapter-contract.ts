import assert from "node:assert/strict";

import {
  MAX_STORAGE_PAGE_SIZE,
  MAX_STORAGE_TRANSACTION_MUTATIONS,
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
  await verifyChecks(createFixture());
  await verifyConcurrentCheckLinearizability(createFixture());
  await verifyAtomicity(createFixture());
  await verifyTransactionBoundaries(createFixture());
  await verifyAuthorizationAndDisclosure(createFixture());
  await verifyPagination(createFixture());
}

async function verifyChecks(fixture: StorageAdapterContractFixture) {
  const existing = privateKey("check-existing");
  const missing = privateKey("check-missing");
  const written = privateKey("check-written");
  const rollback = privateKey("check-rollback");
  await fixture.owner.transact(
    createRequest("operation:check-seed", existing, { value: "before" }),
  );
  const before = await fixture.owner.read(existing);
  requireInvariant(before !== null, "check.seed");

  const request: StorageTransactionRequest = {
    operationId: operationId("operation:check-ordered"),
    mutations: [
      check(existing, 1),
      check(missing, null),
      { type: "put", key: written, expectedRevision: null, value: { value: "new" } },
    ],
  };
  const first = await fixture.owner.transact(request);
  requireInvariant(first.replayed === false, "check.first-application");
  requireInvariant(first.records.length === 3, "check.result-count");
  requireInvariant(
    JSON.stringify(first.records[0]) === JSON.stringify(before),
    "check.unchanged-record-evidence",
  );
  requireInvariant(first.records[1] === null, "check.absence-evidence");
  requireInvariant(first.records[2]?.revision === 1, "check.ordered-write");
  requireInvariant(
    JSON.stringify(await fixture.owner.read(existing)) === JSON.stringify(before),
    "check.non-mutating",
  );

  await expectFailure(
    () => fixture.owner.transact({
      ...request,
      mutations: [
        check(existing, 2),
        ...request.mutations.slice(1),
      ],
    }),
    "CONFLICT",
    "check.idempotency-revision",
  );
  await expectFailure(
    () => fixture.owner.transact({
      ...request,
      mutations: [
        check(privateKey("check-changed-key"), 1),
        ...request.mutations.slice(1),
      ],
    }),
    "CONFLICT",
    "check.idempotency-key",
  );

  await fixture.owner.transact(
    replaceRequest("operation:check-advance", existing, 1, { value: "after" }),
  );
  const replay = await fixture.owner.transact(request);
  requireInvariant(replay.replayed === true, "check.replay-marker");
  requireInvariant(
    JSON.stringify(replay.records) === JSON.stringify(first.records),
    "check.replay-original-evidence",
  );

  await expectFailure(
    () => fixture.owner.transact({
      operationId: operationId("operation:check-stale"),
      mutations: [
        { type: "put", key: rollback, expectedRevision: null, value: { value: "bad" } },
        check(existing, 1),
      ],
    }),
    "PRECONDITION_FAILED",
    "check.stale-positive",
  );
  requireInvariant(
    await fixture.owner.read(rollback) === null,
    "check.stale-rollback",
  );

  const missingRequest: StorageTransactionRequest = {
    operationId: operationId("operation:check-missing"),
    mutations: [
      check(missing, 1),
      { type: "put", key: rollback, expectedRevision: null, value: { value: "repaired" } },
    ],
  };
  await expectFailure(
    () => fixture.owner.transact(missingRequest),
    "PRECONDITION_FAILED",
    "check.missing-positive",
  );
  await fixture.owner.transact(
    createRequest("operation:check-create-missing", missing, { value: "present" }),
  );
  const repaired = await fixture.owner.transact(missingRequest);
  requireInvariant(repaired.replayed === false, "check.failed-operation-no-receipt");
  requireInvariant(repaired.records[0]?.revision === 1, "check.repaired-evidence");

  await expectFailure(
    () => fixture.owner.transact({
      operationId: operationId("operation:check-present"),
      mutations: [check(existing, null)],
    }),
    "PRECONDITION_FAILED",
    "check.failed-absence",
  );
}

async function verifyConcurrentCheckLinearizability(
  fixture: StorageAdapterContractFixture,
) {
  const guard = privateKey("check-concurrent-guard");
  const candidate = privateKey("check-concurrent-candidate");
  await fixture.owner.transact(
    createRequest("operation:check-concurrent-seed", guard, { value: "before" }),
  );
  const guardedWrite: StorageTransactionRequest = {
    operationId: operationId("operation:check-concurrent-guarded-write"),
    mutations: [
      check(guard, 1),
      { type: "put", key: candidate, expectedRevision: null, value: { value: "guarded" } },
    ],
  };
  const competingWrite: StorageTransactionRequest = {
    operationId: operationId("operation:check-concurrent-competing-write"),
    mutations: [
      check(candidate, null),
      { type: "put", key: guard, expectedRevision: 1, value: { value: "after" } },
    ],
  };

  let releaseStart!: () => void;
  const start = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const run = async (request: StorageTransactionRequest) => {
    await start;
    return fixture.owner.transact(request);
  };
  const guarded = run(guardedWrite);
  const competing = run(competingWrite);
  releaseStart();
  const [guardedResult, competingResult] = await Promise.allSettled([
    guarded,
    competing,
  ]);

  const guardedSucceeded = guardedResult.status === "fulfilled";
  const competingSucceeded = competingResult.status === "fulfilled";
  requireInvariant(
    guardedSucceeded !== competingSucceeded,
    "check.concurrent-one-winner",
  );
  const rejection = guardedResult.status === "rejected"
    ? guardedResult.reason
    : competingResult.status === "rejected"
    ? competingResult.reason
    : undefined;
  requireInvariant(
    rejection instanceof StorageFailure &&
      rejection.code === "PRECONDITION_FAILED",
    "check.concurrent-loser-precondition",
  );

  const storedGuard = await fixture.owner.read(guard);
  const storedCandidate = await fixture.owner.read(candidate);
  requireInvariant(storedGuard !== null, "check.concurrent-guard-present");
  if (guardedSucceeded) {
    requireInvariant(
      storedGuard.revision === 1 && storedCandidate?.revision === 1,
      "check.concurrent-guarded-state",
    );
  } else {
    requireInvariant(
      storedGuard.revision === 2 && storedCandidate === null,
      "check.concurrent-competing-state",
    );
  }
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

async function verifyTransactionBoundaries(
  fixture: StorageAdapterContractFixture,
) {
  const duplicate = privateKey("check-duplicate-key");
  await expectFailure(
    () => fixture.owner.transact({
      operationId: operationId("operation:check-duplicate-key"),
      mutations: [
        check(duplicate, null),
        { type: "put", key: duplicate, expectedRevision: null, value: { value: 1 } },
      ],
    }),
    "INVALID_REQUEST",
    "check.duplicate-key",
  );

  const maximum = Array.from(
    { length: MAX_STORAGE_TRANSACTION_MUTATIONS },
    (_, index) => check(privateKey(`check-bound-${index}`), null),
  );
  const result = await fixture.owner.transact({
    operationId: operationId("operation:check-maximum"),
    mutations: maximum,
  });
  requireInvariant(
    result.records.length === MAX_STORAGE_TRANSACTION_MUTATIONS &&
      result.records.every((record) => record === null),
    "check.maximum-bound",
  );
  await expectFailure(
    () => fixture.owner.transact({
      operationId: operationId("operation:check-over-maximum"),
      mutations: [
        ...maximum,
        check(privateKey("check-bound-overflow"), null),
      ],
    }),
    "INVALID_REQUEST",
    "check.over-maximum",
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

  const deniedCheck = await captureStorageFailure(
    () => fixture.outsider.transact(checkRequest(
      "operation:foreign-check-existing",
      existing,
      1,
    )),
    "authorization.foreign-check",
  );
  const absentCheck = await captureStorageFailure(
    () => fixture.outsider.transact(checkRequest(
      "operation:foreign-check-missing",
      missing,
      1,
    )),
    "authorization.missing-check",
  );
  requireInvariant(
    deniedCheck.code === "NOT_FOUND" && absentCheck.code === "NOT_FOUND",
    "authorization.check-equivalence",
  );

  const deniedAbsenceCheck = await captureStorageFailure(
    () => fixture.outsider.transact(checkRequest(
      "operation:foreign-absence-check-existing",
      existing,
      null,
    )),
    "authorization.foreign-absence-check",
  );
  const absentAbsenceCheck = await captureStorageFailure(
    () => fixture.outsider.transact(checkRequest(
      "operation:foreign-absence-check-missing",
      missing,
      null,
    )),
    "authorization.missing-absence-check",
  );
  requireInvariant(
    deniedAbsenceCheck.code === "NOT_FOUND" &&
      absentAbsenceCheck.code === "NOT_FOUND" &&
      JSON.stringify(toPublicStorageFailure(deniedAbsenceCheck)) ===
        JSON.stringify(toPublicStorageFailure(absentAbsenceCheck)),
    "authorization.absence-check-equivalence",
  );

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

function checkRequest(
  operation: string,
  key: StorageKey,
  expectedRevision: number | null,
): StorageTransactionRequest {
  return {
    operationId: operationId(operation),
    mutations: [check(key, expectedRevision)],
  };
}

function check(
  key: StorageKey,
  expectedRevision: number | null,
): StorageTransactionRequest["mutations"][number] {
  return { type: "check", key, expectedRevision };
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
