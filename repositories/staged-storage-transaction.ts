import {
  MAX_STORAGE_TRANSACTION_MUTATIONS,
  StorageFailure,
  assertStorageListBoundary,
  normalizeStorageTransactionRequest,
  parseStorageKey,
  parseStorageOperationId,
  storageKeyString,
  type JsonValue,
  type StorageAdapter,
  type StorageCollection,
  type StorageDocument,
  type StorageKey,
  type StorageListRequest,
  type StorageMutation,
  type StorageOperationId,
  type StoragePage,
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";

export const MAX_STAGED_STORAGE_TRANSACTION_BYTES = 1_048_576;

const STORAGE_RECORD_KEYS = new Set(["key", "revision", "value"]);
const STORAGE_KEY_KEYS = new Set(["collection", "id"]);
const TRANSACTION_RESULT_KEYS = new Set(["replayed", "records"]);

/**
 * In-request transaction overlay used to compose existing repositories into
 * one final atomic StorageAdapter transaction.
 */
export class StagedStorageTransaction implements StorageAdapter {
  readonly #storage: StorageAdapter;
  readonly #operationId: StorageOperationId;
  readonly #overlay = new Map<string, StorageRecord | null>();
  readonly #mutations: StorageMutation[] = [];
  readonly #records: (StorageRecord | null)[] = [];
  readonly #listedCollections = new Set<StorageCollection>();
  readonly #mutatedCollections = new Set<StorageCollection>();
  #committed: StorageTransactionResult | null = null;

  constructor(storage: StorageAdapter, operationId: unknown) {
    this.#storage = requiredStorageAdapter(storage);
    const parsed = parseStorageOperationId(operationId);
    if (!parsed.ok) invalidRequest();
    this.#operationId = parsed.value;
  }

  async read(key: StorageKey): Promise<StorageRecord | null> {
    try {
      const expectedKey = requiredStorageKey(key);
      const identity = storageKeyString(expectedKey);
      if (this.#overlay.has(identity)) {
        return this.#overlay.get(identity) ?? null;
      }
      return snapshotReadResult(
        await this.#storage.read(expectedKey),
        expectedKey,
      );
    } catch (error) {
      sanitizedFailure(error);
    }
  }

  async list(request: StorageListRequest): Promise<StoragePage> {
    try {
      assertStorageListBoundary(request);
      if (this.#mutatedCollections.has(request.collection)) invalidRequest();
      const page = await this.#storage.list(request);
      this.#listedCollections.add(request.collection);
      return page;
    } catch (error) {
      sanitizedFailure(error);
    }
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    try {
      if (this.#committed !== null) conflict();
      const next = normalizeStorageTransactionRequest(request);
      if (next.operationId !== this.#operationId) invalidRequest();
      if (
        this.#mutations.length + next.mutations.length >
          MAX_STORAGE_TRANSACTION_MUTATIONS
      ) {
        invalidRequest();
      }

      const combined = normalizeStorageTransactionRequest({
        operationId: this.#operationId,
        mutations: [...this.#mutations, ...next.mutations],
      });
      if (transactionBytes(combined) > MAX_STAGED_STORAGE_TRANSACTION_BYTES) {
        invalidRequest();
      }

      for (const mutation of next.mutations) {
        if (
          mutation.type !== "check" &&
          this.#listedCollections.has(mutation.key.collection)
        ) {
          invalidRequest();
        }
      }

      const projected: (StorageRecord | null)[] = [];
      const stagedOverlay = new Map<string, StorageRecord | null>();
      for (const mutation of next.mutations) {
        const current = await this.read(mutation.key);
        const record = projectMutation(mutation, current);
        projected.push(record);
        if (mutation.type !== "check") {
          stagedOverlay.set(storageKeyString(mutation.key), record);
        }
      }

      this.#mutations.push(...next.mutations);
      this.#records.push(...projected);
      for (const [identity, record] of stagedOverlay) {
        this.#overlay.set(identity, record);
      }
      for (const mutation of next.mutations) {
        if (mutation.type !== "check") {
          this.#mutatedCollections.add(mutation.key.collection);
        }
      }
      return frozenResult(false, projected);
    } catch (error) {
      sanitizedFailure(error);
    }
  }

  /** Commits every staged mutation in exactly one durable adapter call. */
  async commit(): Promise<StorageTransactionResult> {
    try {
      if (this.#committed !== null) return this.#committed;
      if (this.#mutations.length < 1) invalidRequest();
      const request = normalizeStorageTransactionRequest({
        operationId: this.#operationId,
        mutations: this.#mutations,
      });
      if (transactionBytes(request) > MAX_STAGED_STORAGE_TRANSACTION_BYTES) {
        invalidRequest();
      }
      const result = verifyCommitResult(
        await this.#storage.transact(request),
        this.#records,
      );
      this.#committed = result;
      return result;
    } catch (error) {
      sanitizedFailure(error);
    }
  }
}

function projectMutation(
  mutation: StorageMutation,
  current: StorageRecord | null,
): StorageRecord | null {
  if (mutation.type === "check") {
    if (
      mutation.expectedRevision === null
        ? current !== null
        : current?.revision !== mutation.expectedRevision
    ) {
      preconditionFailed();
    }
    return current;
  }

  if (mutation.expectedRevision === null) {
    if (current !== null) conflict();
  } else if (
    current === null || current.revision !== mutation.expectedRevision
  ) {
    preconditionFailed();
  }

  if (mutation.type === "delete") return null;
  const revision = (mutation.expectedRevision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) preconditionFailed();
  return Object.freeze({
    key: mutation.key,
    revision,
    value: mutation.value,
  });
}

function verifyCommitResult(
  value: unknown,
  expected: readonly (StorageRecord | null)[],
): StorageTransactionResult {
  try {
    const source = exactDataRecord(value, TRANSACTION_RESULT_KEYS);
    if (typeof source.replayed !== "boolean") unavailable();
    const records = exactDenseArray(source.records, expected.length);
    for (const [index, expectedRecord] of expected.entries()) {
      const candidate = records[index];
      if (expectedRecord === null) {
        if (candidate !== null) unavailable();
        continue;
      }
      const actual = snapshotStorageRecord(candidate, expectedRecord.key);
      if (
        actual.revision !== expectedRecord.revision ||
        canonicalJson(actual.value) !== canonicalJson(expectedRecord.value)
      ) {
        unavailable();
      }
    }
    return frozenResult(source.replayed, expected);
  } catch {
    unavailable();
  }
}

function snapshotReadResult(
  value: unknown,
  expectedKey: StorageKey,
): StorageRecord | null {
  if (value === null) return null;
  try {
    return snapshotStorageRecord(value, expectedKey);
  } catch {
    unavailable();
  }
}

function snapshotStorageRecord(
  value: unknown,
  expectedKey: StorageKey,
): StorageRecord {
  const source = exactDataRecord(value, STORAGE_RECORD_KEYS);
  const key = requiredStorageKey(source.key);
  if (storageKeyString(key) !== storageKeyString(expectedKey)) unavailable();
  if (
    !Number.isSafeInteger(source.revision) ||
    (source.revision as number) < 1
  ) {
    unavailable();
  }
  return Object.freeze({
    key,
    revision: source.revision as number,
    value: snapshotStorageDocument(source.value),
  });
}

function requiredStorageKey(value: unknown): StorageKey {
  const source = exactDataRecord(value, STORAGE_KEY_KEYS);
  const parsed = parseStorageKey(source.collection, source.id);
  if (!parsed.ok) invalidRequest();
  return Object.freeze({ ...parsed.value });
}

function snapshotStorageDocument(value: unknown): StorageDocument {
  const snapshot = snapshotJson(value, {
    seen: new WeakSet<object>(),
    nodes: 0,
  });
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot)
  ) {
    unavailable();
  }
  return snapshot as StorageDocument;
}

function snapshotJson(
  value: unknown,
  state: { seen: WeakSet<object>; nodes: number },
): JsonValue {
  state.nodes += 1;
  if (state.nodes > 65_536) unavailable();
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) unavailable();
    return value;
  }
  if (typeof value !== "object" || state.seen.has(value)) unavailable();
  state.seen.add(value);

  if (Array.isArray(value)) {
    return Object.freeze(exactDenseArray(value, value.length).map((entry) =>
      snapshotJson(entry, state)
    ));
  }

  const source = requiredDataRecord(value);
  const snapshot: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string") unavailable();
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      unavailable();
    }
    snapshot[key] = snapshotJson(descriptor.value, state);
  }
  return Object.freeze(snapshot);
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

function frozenResult(
  replayed: boolean,
  records: readonly (StorageRecord | null)[],
): StorageTransactionResult {
  return Object.freeze({ replayed, records: Object.freeze([...records]) });
}

function transactionBytes(request: StorageTransactionRequest): number {
  try {
    return new TextEncoder().encode(JSON.stringify(request)).byteLength;
  } catch {
    invalidRequest();
  }
}

function exactDenseArray(value: unknown, length: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== length
  ) {
    unavailable();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes("length")) unavailable();
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      unavailable();
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function exactDataRecord(
  value: unknown,
  expectedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const source = requiredDataRecord(value);
  const keys = Reflect.ownKeys(source);
  if (
    keys.length !== expectedKeys.size ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
  ) {
    unavailable();
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      unavailable();
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function requiredDataRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    unavailable();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) unavailable();
  return value as Record<string, unknown>;
}

function requiredStorageAdapter(value: StorageAdapter): StorageAdapter {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.read !== "function" ||
    typeof value.list !== "function" ||
    typeof value.transact !== "function"
  ) {
    invalidRequest();
  }
  return value;
}

function sanitizedFailure(error: unknown): never {
  if (error instanceof StorageFailure) throw new StorageFailure(error.code);
  throw new StorageFailure("UNAVAILABLE");
}

function invalidRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
}

function conflict(): never {
  throw new StorageFailure("CONFLICT");
}

function preconditionFailed(): never {
  throw new StorageFailure("PRECONDITION_FAILED");
}

function unavailable(): never {
  throw new StorageFailure("UNAVAILABLE");
}
