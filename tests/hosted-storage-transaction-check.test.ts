import assert from "node:assert/strict";
import test from "node:test";

import {
  StorageFailure,
  parseStorageKey,
  parseStorageOperationId,
  type StorageDocument,
  type StorageKey,
  type StorageTransactionRequest,
} from "../domain/storage-adapter.ts";
import { AittaDBStorageAdapter } from "../repositories/aittadb-storage-adapter.ts";
import { SyntheticAittaDBStorageService } from "./support/synthetic-aittadb-storage-service.ts";

const ISSUER = "https://hosted-check.example";
const TRANSPORT_ORIGIN = "https://hosted-check-transport.example";
const ENTRY_HREF = `${ISSUER}/bounded-storage`;
const ACCESS_TOKEN = "hosted-check-token";

test("hosted synthetic transport keeps revision checks atomic with writes", async () => {
  const service = new SyntheticAittaDBStorageService({
    issuer: ISSUER,
    transportOrigin: TRANSPORT_ORIGIN,
    entryHref: ENTRY_HREF,
    clientId: "hosted-check-client",
    clientSecret: "hosted-check-secret",
    accessToken: ACCESS_TOKEN,
    scopes: "storage.read storage.write storage.delete",
  });
  const adapter = new AittaDBStorageAdapter({
    issuer: ISSUER,
    entryHref: ENTRY_HREF,
    transportOrigin: TRANSPORT_ORIGIN,
    accessToken: () => ACCESS_TOKEN,
    fetch: service.fetch,
  });
  const guard = storageKey("guard-records", "guard");
  const accepted = storageKey("write-records", "accepted");
  const rolledBack = storageKey("write-records", "rolled-back");

  await adapter.transact(request("operation:hosted-check-seed", [
    put(guard, null, { state: "before" }),
  ]));
  const guarded = request("operation:hosted-check-write", [
    check(guard, 1),
    put(accepted, null, { state: "accepted" }),
  ]);
  const first = await adapter.transact(guarded);
  assert.equal(first.replayed, false);
  assert.deepEqual(first.records, [
    { key: guard, revision: 1, value: { state: "before" } },
    { key: accepted, revision: 1, value: { state: "accepted" } },
  ]);
  assert.equal((await adapter.read(guard))?.revision, 1);

  await adapter.transact(request("operation:hosted-check-advance", [
    put(guard, 1, { state: "after" }),
  ]));
  const replay = await adapter.transact(guarded);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.records, first.records);

  await assert.rejects(
    () => adapter.transact(request("operation:hosted-check-stale", [
      check(guard, 1),
      put(rolledBack, null, { state: "must-not-commit" }),
    ])),
    (error: unknown) =>
      error instanceof StorageFailure && error.code === "PRECONDITION_FAILED",
  );
  assert.equal(await adapter.read(rolledBack), null);
  assert.equal(service.operationCount(), 3);

  const cycleGuard = storageKey("guard-records", "cycle-guard");
  const cycleCandidate = storageKey("write-records", "cycle-candidate");
  await adapter.transact(request("operation:hosted-check-cycle-seed", [
    put(cycleGuard, null, { state: "before" }),
  ]));
  const guardedCycle = request("operation:hosted-check-cycle-guarded", [
    check(cycleGuard, 1),
    put(cycleCandidate, null, { state: "guarded" }),
  ]);
  const competingCycle = request("operation:hosted-check-cycle-competing", [
    check(cycleCandidate, null),
    put(cycleGuard, 1, { state: "after" }),
  ]);
  let releaseStart!: () => void;
  const start = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const run = async (candidate: StorageTransactionRequest) => {
    await start;
    return adapter.transact(candidate);
  };
  const guardedResult = run(guardedCycle);
  const competingResult = run(competingCycle);
  releaseStart();
  const [guardedOutcome, competingOutcome] = await Promise.allSettled([
    guardedResult,
    competingResult,
  ]);
  assert.notEqual(
    guardedOutcome.status === "fulfilled",
    competingOutcome.status === "fulfilled",
  );
  const rejected = guardedOutcome.status === "rejected"
    ? guardedOutcome.reason
    : competingOutcome.status === "rejected"
    ? competingOutcome.reason
    : undefined;
  assert(
    rejected instanceof StorageFailure &&
      rejected.code === "PRECONDITION_FAILED",
  );
  const storedCycleGuard = await adapter.read(cycleGuard);
  const storedCycleCandidate = await adapter.read(cycleCandidate);
  if (guardedOutcome.status === "fulfilled") {
    assert.equal(storedCycleGuard?.revision, 1);
    assert.equal(storedCycleCandidate?.revision, 1);
  } else {
    assert.equal(storedCycleGuard?.revision, 2);
    assert.equal(storedCycleCandidate, null);
  }
  assert.equal(service.operationCount(), 5);
});

function request(
  operation: string,
  mutations: StorageTransactionRequest["mutations"],
): StorageTransactionRequest {
  const operationId = parseStorageOperationId(operation);
  assert(operationId.ok);
  return { operationId: operationId.value, mutations };
}

function storageKey(collection: string, id: string): StorageKey {
  const parsed = parseStorageKey(collection, id);
  assert(parsed.ok);
  return parsed.value;
}

function put(
  key: StorageKey,
  expectedRevision: number | null,
  value: StorageDocument,
): StorageTransactionRequest["mutations"][number] {
  return { type: "put", key, expectedRevision, value };
}

function check(
  key: StorageKey,
  expectedRevision: number | null,
): StorageTransactionRequest["mutations"][number] {
  return { type: "check", key, expectedRevision };
}
