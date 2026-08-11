import {
  StorageFailure,
  assertStorageListBoundary,
  normalizeStorageTransactionRequest,
  storageKeyString,
  type StorageAdapter,
  type StorageCursor,
  type StorageDocument,
  type StoragePage,
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../../domain/storage-adapter.ts";

export class MemoryStorageState {
  readonly records = new Map<string, StorageRecord>();
  readonly operations = new Map<
    string,
    Readonly<{ fingerprint: string; result: StorageTransactionResult }>
  >();
}

/** Deterministic StorageAdapter fixture with atomic retries and revisions. */
export class MemoryStorageAdapter implements StorageAdapter {
  readonly #state: MemoryStorageState;

  constructor(state = new MemoryStorageState()) {
    this.#state = state;
  }

  async read(key: Parameters<StorageAdapter["read"]>[0]): Promise<StorageRecord | null> {
    return cloneRecord(this.#state.records.get(storageKeyString(key)) ?? null);
  }

  async list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    assertStorageListBoundary(request);
    const start = request.cursor === undefined ? 0 : parseCursor(request.cursor);
    const records = [...this.#state.records.values()]
      .filter((record) => record.key.collection === request.collection)
      .sort((left, right) => left.key.id.localeCompare(right.key.id));
    if (start < 0 || start > records.length) invalidRequest();

    const items = records
      .slice(start, start + request.limit)
      .map((record) => cloneRecord(record))
      .filter((record): record is StorageRecord => record !== null);
    const next = start + items.length;
    return Object.freeze({
      items: Object.freeze(items),
      nextCursor: next < records.length
        ? (`cursor:${next}` as StorageCursor)
        : null,
    });
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    const snapshot = normalizeStorageTransactionRequest(request);
    const operationKey = snapshot.operationId as string;
    const fingerprint = JSON.stringify(snapshot);
    const prior = this.#state.operations.get(operationKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new StorageFailure("CONFLICT");
      }
      return cloneResult(prior.result, true);
    }

    for (const mutation of snapshot.mutations) {
      const current = this.#state.records.get(storageKeyString(mutation.key));
      if (mutation.type === "check") {
        if (
          mutation.expectedRevision === null
            ? current !== undefined
            : current?.revision !== mutation.expectedRevision
        ) {
          throw new StorageFailure("PRECONDITION_FAILED");
        }
      } else if (mutation.expectedRevision === null) {
        if (current) throw new StorageFailure("CONFLICT");
      } else if (!current || current.revision !== mutation.expectedRevision) {
        throw new StorageFailure("PRECONDITION_FAILED");
      }
    }

    const nextRecords = new Map(this.#state.records);
    const changed: (StorageRecord | null)[] = [];
    for (const mutation of snapshot.mutations) {
      const key = storageKeyString(mutation.key);
      const current = nextRecords.get(key);
      if (mutation.type === "check") {
        changed.push(cloneRecord(current ?? null));
        continue;
      }
      if (mutation.type === "delete") {
        nextRecords.delete(key);
        changed.push(null);
        continue;
      }
      const record = freezeRecord({
        key: mutation.key,
        revision: (current?.revision ?? 0) + 1,
        value: mutation.value,
      });
      nextRecords.set(key, record);
      changed.push(record);
    }

    this.#state.records.clear();
    for (const [key, record] of nextRecords) this.#state.records.set(key, record);
    const result: StorageTransactionResult = Object.freeze({
      replayed: false,
      records: Object.freeze(changed.map(cloneRecord)),
    });
    this.#state.operations.set(operationKey, { fingerprint, result });
    return cloneResult(result, false);
  }
}

function parseCursor(cursor: StorageCursor): number {
  const match = /^cursor:(\d+)$/.exec(cursor);
  if (!match) invalidRequest();
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
  return record === null
    ? null
    : freezeRecord({
        key: record.key,
        revision: record.revision,
        value: record.value,
      });
}

function freezeRecord(input: StorageRecord): StorageRecord {
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

function invalidRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
}
