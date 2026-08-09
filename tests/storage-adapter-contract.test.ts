import assert from "node:assert/strict";
import test from "node:test";

import {
  StorageFailure,
  assertStorageListBoundary,
  assertStorageTransactionBoundary,
  storageKeyString,
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
  StorageAdapterContractViolation,
  verifyStorageAdapterContract,
  type StorageAdapterContractFixture,
} from "./support/storage-adapter-contract.ts";

type Fault = "authorization" | "duplicate" | "drift" | "disclosure" | null;

test("the shared storage contract accepts a conforming minimal fake", async () => {
  await verifyStorageAdapterContract(() => createFixture(null));
});

for (const [fault, invariant] of [
  ["authorization", "authorization.foreign-read"],
  ["duplicate", "duplicate.create"],
  ["drift", "compare-and-set.stale-write"],
  ["disclosure", "authorization.read-shape"],
] as const) {
  test(`the shared harness detects ${fault} contract failures`, async () => {
    await assert.rejects(
      () => verifyStorageAdapterContract(() => createFixture(fault)),
      (error) =>
        error instanceof StorageAdapterContractViolation &&
        error.invariant.startsWith(invariant),
    );
  });
}

function createFixture(fault: Fault): StorageAdapterContractFixture {
  const state = new FakeStorageState(fault);
  return {
    owner: new MinimalFakeStorageAdapter(state, true),
    outsider: new MinimalFakeStorageAdapter(state, false),
  };
}

class FakeStorageState {
  readonly records = new Map<string, StorageRecord>();
  readonly operations = new Map<
    string,
    Readonly<{ fingerprint: string; result: StorageTransactionResult }>
  >();
  readonly fault: Fault;

  constructor(fault: Fault) {
    this.fault = fault;
  }
}

class MinimalFakeStorageAdapter implements StorageAdapter {
  private readonly state: FakeStorageState;
  private readonly permitted: boolean;

  constructor(
    state: FakeStorageState,
    permitted: boolean,
  ) {
    this.state = state;
    this.permitted = permitted;
  }

  async read(key: StorageKey): Promise<StorageRecord | null> {
    const stored = this.state.records.get(storageKeyString(key)) ?? null;
    if (this.permitted) return cloneRecord(stored);
    if (this.state.fault === "authorization") return cloneRecord(stored);
    if (this.state.fault === "disclosure" && stored) {
      throw new Error(`Denied ${storageKeyString(key)}`);
    }
    return null;
  }

  async list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    assertStorageListBoundary(request);
    if (!this.permitted) return { items: [], nextCursor: null };

    const start = request.cursor === undefined
      ? 0
      : parseCursor(request.cursor);
    const all = [...this.state.records.values()]
      .filter((record) => record.key.collection === request.collection)
      .sort((left, right) => left.key.id.localeCompare(right.key.id));
    if (start < 0 || start > all.length) throw new StorageFailure("INVALID_REQUEST");

    const items = all.slice(start, start + request.limit).map((record) => cloneRecord(record));
    const next = start + items.length;
    return {
      items: items.filter((record): record is StorageRecord => record !== null),
      nextCursor: next < all.length ? (`cursor:${next}` as StorageCursor) : null,
    };
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    assertStorageTransactionBoundary(request);
    if (!this.permitted) throw new StorageFailure("NOT_FOUND");

    const operationKey = request.operationId as string;
    const fingerprint = JSON.stringify(request);
    const prior = this.state.operations.get(operationKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new StorageFailure("CONFLICT");
      return cloneResult(prior.result, true);
    }

    for (const mutation of request.mutations) {
      const current = this.state.records.get(storageKeyString(mutation.key));
      if (mutation.expectedRevision === null) {
        if (current && this.state.fault !== "duplicate") {
          throw new StorageFailure("CONFLICT");
        }
      } else if (
        (!current || current.revision !== mutation.expectedRevision) &&
        this.state.fault !== "drift"
      ) {
        throw new StorageFailure("PRECONDITION_FAILED");
      }
    }

    const nextRecords = new Map(this.state.records);
    const results: (StorageRecord | null)[] = [];
    for (const mutation of request.mutations) {
      const key = storageKeyString(mutation.key);
      const current = nextRecords.get(key);
      if (mutation.type === "delete") {
        nextRecords.delete(key);
        results.push(null);
        continue;
      }

      const record = freezeRecord({
        key: mutation.key,
        revision: (current?.revision ?? 0) + 1,
        value: mutation.value,
      });
      nextRecords.set(key, record);
      results.push(record);
    }

    this.state.records.clear();
    for (const [key, record] of nextRecords) this.state.records.set(key, record);
    const result = Object.freeze({
      replayed: false,
      records: Object.freeze(results.map((record) => cloneRecord(record))),
    });
    this.state.operations.set(operationKey, { fingerprint, result });
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
    records: Object.freeze(result.records.map((record) => cloneRecord(record))),
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
