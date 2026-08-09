import {
  invalid,
  parseStableId,
  valid,
  type StableId,
  type ValidationResult,
} from "./foundation.ts";

declare const storageBrand: unique symbol;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;
export type StorageDocument = Readonly<{ [key: string]: JsonValue }>;

export type StorageCollection = string & {
  readonly [storageBrand]: "StorageCollection";
};
export type StorageCursor = string & {
  readonly [storageBrand]: "StorageCursor";
};
export type StorageOperationId = StableId<"storage-operation">;

export type StorageKey = Readonly<{
  collection: StorageCollection;
  id: StableId<"storage-record">;
}>;

export type StorageRecord = Readonly<{
  key: StorageKey;
  revision: number;
  value: StorageDocument;
}>;

export type StoragePutMutation = Readonly<{
  type: "put";
  key: StorageKey;
  /** `null` creates; a positive revision replaces through compare-and-set. */
  expectedRevision: number | null;
  value: StorageDocument;
}>;

export type StorageDeleteMutation = Readonly<{
  type: "delete";
  key: StorageKey;
  expectedRevision: number;
}>;

export type StorageMutation = StoragePutMutation | StorageDeleteMutation;

/**
 * A transaction is atomic and replay-safe. Reusing an operation ID with the
 * identical request returns the original result; reusing it for different work
 * fails with `CONFLICT`.
 */
export type StorageTransactionRequest = Readonly<{
  operationId: StorageOperationId;
  mutations: readonly StorageMutation[];
}>;

export type StorageTransactionResult = Readonly<{
  replayed: boolean;
  records: readonly (StorageRecord | null)[];
}>;

export type StorageListRequest = Readonly<{
  collection: StorageCollection;
  limit: number;
  cursor?: StorageCursor;
}>;

export type StoragePage = Readonly<{
  items: readonly StorageRecord[];
  nextCursor: StorageCursor | null;
}>;

export const MAX_STORAGE_PAGE_SIZE = 100;
export const MAX_STORAGE_TRANSACTION_MUTATIONS = 25;

export type StorageFailureCode =
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PRECONDITION_FAILED"
  | "UNAVAILABLE";

const STORAGE_FAILURE_MESSAGES: Readonly<Record<StorageFailureCode, string>> = {
  INVALID_REQUEST: "The storage request is invalid.",
  NOT_FOUND: "The storage resource was not found.",
  CONFLICT: "The storage request conflicts with current state.",
  PRECONDITION_FAILED: "The storage resource has changed.",
  UNAVAILABLE: "Storage is temporarily unavailable.",
};

/** Fixed-message storage error that never contains keys, values, or credentials. */
export class StorageFailure extends Error {
  readonly code: StorageFailureCode;

  constructor(code: StorageFailureCode, options: ErrorOptions = {}) {
    super(STORAGE_FAILURE_MESSAGES[code], options);
    this.name = "StorageFailure";
    this.code = code;
  }
}

export type PublicStorageFailure = Readonly<{
  error: Readonly<{
    code: StorageFailureCode;
    message: string;
  }>;
}>;

export function toPublicStorageFailure(error: unknown): PublicStorageFailure {
  const code = error instanceof StorageFailure ? error.code : "UNAVAILABLE";
  return { error: { code, message: STORAGE_FAILURE_MESSAGES[code] } };
}

/**
 * One adapter instance is already bound to its backend credential and grants.
 * Authorization denial must be observationally equivalent to a missing record.
 */
export interface StorageAdapter {
  read(key: StorageKey): Promise<StorageRecord | null>;
  list(request: StorageListRequest): Promise<StoragePage>;
  transact(request: StorageTransactionRequest): Promise<StorageTransactionResult>;
}

export function parseStorageKey(
  collection: unknown,
  id: unknown,
): ValidationResult<StorageKey> {
  const parsedCollection = parseStorageCollection(collection);
  if (!parsedCollection.ok) return parsedCollection;

  const parsedId = parseStableId<"storage-record">(id);
  if (!parsedId.ok) {
    return invalid({ code: parsedId.issues[0].code, path: "key.id" });
  }

  return valid(Object.freeze({
    collection: parsedCollection.value,
    id: parsedId.value,
  }));
}

export function parseStorageCollection(
  value: unknown,
): ValidationResult<StorageCollection> {
  if (typeof value !== "string") {
    return invalid({ code: "invalid_type", path: "key.collection" });
  }
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    return invalid({
      code: value.length === 0 ? "required" : "invalid_format",
      path: "key.collection",
    });
  }
  return valid(value as StorageCollection);
}

export function parseStorageOperationId(
  value: unknown,
): ValidationResult<StorageOperationId> {
  const parsed = parseStableId<"storage-operation">(value);
  return parsed.ok
    ? parsed
    : invalid({ code: parsed.issues[0].code, path: "operationId" });
}

export function assertStorageListBoundary(request: StorageListRequest): void {
  if (
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > MAX_STORAGE_PAGE_SIZE
  ) {
    throw new StorageFailure("INVALID_REQUEST");
  }
}

export function assertStorageTransactionBoundary(
  request: StorageTransactionRequest,
): void {
  normalizeStorageTransactionRequest(request);
}

/** Parses untrusted transaction input once into an immutable data-only snapshot. */
export function normalizeStorageTransactionRequest(
  request: StorageTransactionRequest,
): StorageTransactionRequest {
  try {
    const source = exactStorageDataRecord(request, [
      "operationId",
      "mutations",
    ]);
    const operationId = parseStorageOperationId(source.operationId);
    if (!operationId.ok) invalidStorageRequest();
    const candidates = storageArrayValues(source.mutations);
    if (
      candidates.length < 1 ||
      candidates.length > MAX_STORAGE_TRANSACTION_MUTATIONS
    ) {
      invalidStorageRequest();
    }

    const keys = new Set<string>();
    const mutations: StorageMutation[] = [];
    for (const candidate of candidates) {
      const typeRecord = requiredStorageRecord(candidate);
      const typeDescriptor = Object.getOwnPropertyDescriptor(typeRecord, "type");
      if (
        typeDescriptor === undefined ||
        !typeDescriptor.enumerable ||
        !("value" in typeDescriptor)
      ) invalidStorageRequest();
      const put = typeDescriptor.value === "put";
      const remove = typeDescriptor.value === "delete";
      if (!put && !remove) invalidStorageRequest();
      const mutation = exactStorageDataRecord(
        candidate,
        put
          ? ["type", "key", "expectedRevision", "value"]
          : ["type", "key", "expectedRevision"],
      );

      const keySource = exactStorageDataRecord(mutation.key, [
        "collection",
        "id",
      ]);
      const parsedKey = parseStorageKey(keySource.collection, keySource.id);
      if (!parsedKey.ok) invalidStorageRequest();
      const keyIdentity = storageKeyString(parsedKey.value);
      if (keys.has(keyIdentity)) invalidStorageRequest();
      keys.add(keyIdentity);
      const key = Object.freeze({ ...parsedKey.value });

      const expectedRevision = mutation.expectedRevision;
      if (
        expectedRevision !== null &&
        (!Number.isSafeInteger(expectedRevision) ||
          (expectedRevision as number) < 1) ||
        remove && expectedRevision === null
      ) {
        invalidStorageRequest();
      }
      if (put) {
        mutations.push(Object.freeze({
          type: "put",
          key,
          expectedRevision: expectedRevision as number | null,
          value: snapshotStorageDocument(mutation.value),
        }));
      } else {
        mutations.push(Object.freeze({
          type: "delete",
          key,
          expectedRevision: expectedRevision as number,
        }));
      }
    }
    return Object.freeze({
      operationId: operationId.value,
      mutations: Object.freeze(mutations),
    });
  } catch (error) {
    if (error instanceof StorageFailure) throw error;
    invalidStorageRequest();
  }
}

export function storageKeyString(key: StorageKey): string {
  return `${key.collection}/${key.id}`;
}

function snapshotStorageDocument(value: unknown): StorageDocument {
  requiredStorageRecord(value);
  return snapshotJsonValue(value, {
    seen: new WeakSet<object>(),
    nodes: 0,
  }) as StorageDocument;
}

function snapshotJsonValue(
  value: unknown,
  state: { seen: WeakSet<object>; nodes: number },
): JsonValue {
  state.nodes += 1;
  if (state.nodes > 65_536) invalidStorageRequest();
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidStorageRequest();
    return value;
  }
  if (typeof value !== "object") invalidStorageRequest();
  if (state.seen.has(value)) invalidStorageRequest();
  state.seen.add(value);

  if (Array.isArray(value)) {
    const candidates = storageArrayValues(value);
    return Object.freeze(candidates.map((candidate) =>
      snapshotJsonValue(candidate, state)
    ));
  }

  const source = requiredStorageRecord(value);
  const keys = Reflect.ownKeys(source);
  if (keys.some((key) => typeof key !== "string")) invalidStorageRequest();
  const snapshot: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) invalidStorageRequest();
    snapshot[key] = snapshotJsonValue(descriptor.value, state);
  }
  return Object.freeze(snapshot);
}

function requiredStorageRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidStorageRequest();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidStorageRequest();
  return value as Record<string, unknown>;
}

function exactStorageDataRecord(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> {
  const source = requiredStorageRecord(value);
  const keys = Reflect.ownKeys(source);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string" || !expected.includes(key))
  ) invalidStorageRequest();
  const snapshot: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) invalidStorageRequest();
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function storageArrayValues(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalidStorageRequest();
  }
  const length = value.length;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== length + 1 ||
    !keys.includes("length") ||
    keys.some((key) =>
      typeof key !== "string" ||
      key !== "length" &&
        (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= length)
    )
  ) invalidStorageRequest();
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) invalidStorageRequest();
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function invalidStorageRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
}
