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
  if (
    request.mutations.length < 1 ||
    request.mutations.length > MAX_STORAGE_TRANSACTION_MUTATIONS
  ) {
    throw new StorageFailure("INVALID_REQUEST");
  }

  const keys = new Set<string>();
  for (const mutation of request.mutations) {
    const key = storageKeyString(mutation.key);
    if (keys.has(key)) throw new StorageFailure("INVALID_REQUEST");
    keys.add(key);

    if (
      mutation.expectedRevision !== null &&
      (!Number.isSafeInteger(mutation.expectedRevision) ||
        mutation.expectedRevision < 1)
    ) {
      throw new StorageFailure("INVALID_REQUEST");
    }
    if (mutation.type === "delete" && mutation.expectedRevision === null) {
      throw new StorageFailure("INVALID_REQUEST");
    }
  }
}

export function storageKeyString(key: StorageKey): string {
  return `${key.collection}/${key.id}`;
}
