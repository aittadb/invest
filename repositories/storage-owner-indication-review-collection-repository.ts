import {
  parseActorSubject,
  type ActorSubject,
} from "../domain/foundation.ts";
import {
  assertStorageListBoundary,
  StorageFailure,
  parseStorageKey,
  type StorageAdapter,
  type StorageCursor,
  type StorageDocument,
  type StorageRecord,
} from "../domain/storage-adapter.ts";
import type {
  OwnerIndicationModerationListRequest,
  OwnerIndicationReviewCollectionRepository,
  OwnerIndicationReviewPage,
  OwnerIndicationReviewSummary,
} from "../services/owner-indication-moderation.ts";
import {
  MAX_OWNER_INDICATION_REVIEW_CURSOR_LENGTH,
  type OwnerIndicationReviewTokenBoundary,
} from "../services/owner-indication-review-tokens.ts";
import {
  INDICATION_CURRENT_STORAGE_COLLECTION,
  MAX_INDICATION_FIELDS_CHUNKS,
  decodeStoredIndicationCurrent,
  decodeStoredIndicationTransition,
  indicationCoordinatesFromCurrentDocument,
  indicationCurrentStorageKey,
  indicationHistoryStorageKey,
  readStoredIndicationFields,
  requireMatchingCurrentAndTerminal,
  verifyStoredActiveIndicationLease,
  verifyStoredIndicationTerminalProjection,
} from "./storage-indication-read-codec.ts";

export { MAX_OWNER_INDICATION_REVIEW_CURSOR_LENGTH } from "../services/owner-indication-review-tokens.ts";

export const MAX_OWNER_INDICATION_REVIEW_PAGE_SIZE = 25;
export const MAX_OWNER_INDICATION_REVIEW_ITEM_READS =
  2 + MAX_INDICATION_FIELDS_CHUNKS;
export const MAX_OWNER_INDICATION_REVIEW_PAGE_RECORD_READS =
  MAX_OWNER_INDICATION_REVIEW_PAGE_SIZE *
  MAX_OWNER_INDICATION_REVIEW_ITEM_READS;
const MAX_OWNER_INDICATION_REVIEW_BACKEND_CURSOR_LENGTH = 2_048;
const OWNER_REVIEW_LIST_REQUEST_KEYS = new Set(["limit"]);
const OWNER_REVIEW_CURSOR_REQUEST_KEYS = new Set(["limit", "cursor"]);
const OWNER_REVIEW_PAGE_KEYS = new Set(["items", "nextCursor"]);
const STORAGE_RECORD_KEYS = new Set(["key", "revision", "value"]);
const STORAGE_KEY_KEYS = new Set(["collection", "id"]);

type OwnerIndicationReviewStorage = Pick<StorageAdapter, "list" | "read">;

/** Persistent owner-only summary projection over current indication records. */
export class StorageOwnerIndicationReviewCollectionRepository
  implements OwnerIndicationReviewCollectionRepository
{
  readonly #storage: OwnerIndicationReviewStorage;
  readonly #configuredOwnerSubject: ActorSubject;
  readonly #tokens: OwnerIndicationReviewTokenBoundary;
  readonly #permitted: boolean;

  constructor(
    storage: OwnerIndicationReviewStorage,
    authenticatedSubject: ActorSubject | null,
    configuredOwnerSubject: ActorSubject,
    tokens: OwnerIndicationReviewTokenBoundary,
  ) {
    this.#storage = requiredOwnerIndicationReviewStorage(storage);
    this.#configuredOwnerSubject = requiredActorSubject(configuredOwnerSubject);
    this.#tokens = requiredOwnerIndicationReviewTokenBoundary(tokens);
    const actorSubject = authenticatedSubject === null
      ? null
      : requiredActorSubject(authenticatedSubject);
    this.#permitted = actorSubject === this.#configuredOwnerSubject;
    Object.freeze(this);
  }

  async list(
    request: OwnerIndicationModerationListRequest,
  ): Promise<OwnerIndicationReviewPage> {
    if (!this.#permitted) notFound();

    try {
      const parsed = parseOwnerIndicationReviewListRequest(request);
      const backendCursor = parsed.cursor === undefined
        ? undefined
        : await openOwnerIndicationReviewCursor(
          this.#tokens,
          parsed.cursor,
          this.#configuredOwnerSubject,
          parsed.limit,
        );
      const storageRequest = Object.freeze({
        collection: INDICATION_CURRENT_STORAGE_COLLECTION,
        limit: parsed.limit,
        ...(backendCursor === undefined ? {} : { cursor: backendCursor }),
      });
      assertStorageListBoundary(storageRequest);
      const page = exactOwnerIndicationReviewStoragePage(
        await this.#storage.list(storageRequest),
        Object.freeze({
          limit: parsed.limit,
          ...(backendCursor === undefined ? {} : { cursor: backendCursor }),
        }),
      );
      const items = await Promise.all(page.items.map((record) =>
        decodeOwnerIndicationReviewSummary(
          this.#storage,
          record,
          this.#tokens,
          this.#configuredOwnerSubject,
        )
      ));
      const nextCursor = page.nextCursor === null
        ? null
        : await sealOwnerIndicationReviewCursor(
          this.#tokens,
          page.nextCursor,
          this.#configuredOwnerSubject,
          parsed.limit,
        );
      return Object.freeze({
        items: Object.freeze(items),
        nextCursor,
      });
    } catch (error) {
      if (
        error instanceof StorageFailure &&
        error.code === "INVALID_REQUEST"
      ) {
        throw new StorageFailure("INVALID_REQUEST");
      }
      throw new StorageFailure("UNAVAILABLE");
    }
  }
}

function parseOwnerIndicationReviewListRequest(
  value: unknown,
): OwnerIndicationModerationListRequest {
  const source = objectRecord(value);
  const hasCursor = source !== null && Object.hasOwn(source, "cursor");
  if (
    source === null ||
    !hasExactKeys(
      source,
      hasCursor
        ? OWNER_REVIEW_CURSOR_REQUEST_KEYS
        : OWNER_REVIEW_LIST_REQUEST_KEYS,
    ) ||
    !Number.isSafeInteger(source.limit) ||
    (source.limit as number) < 1 ||
    (source.limit as number) > MAX_OWNER_INDICATION_REVIEW_PAGE_SIZE
  ) {
    invalidRequest();
  }
  const cursor = hasCursor
    ? requiredOwnerIndicationReviewCursor(source.cursor, invalidRequest)
    : undefined;
  return Object.freeze({
    limit: source.limit as number,
    ...(cursor === undefined ? {} : { cursor }),
  });
}

function exactOwnerIndicationReviewStoragePage(
  value: unknown,
  request: OwnerIndicationModerationListRequest,
): Readonly<{
  items: readonly StorageRecord[];
  nextCursor: StorageCursor | null;
}> {
  const source = exactRecord(value, OWNER_REVIEW_PAGE_KEYS);
  const candidates = exactDenseArray(source.items, request.limit);
  const items = candidates.map(exactOwnerIndicationReviewStorageRecord);
  let priorId: string | null = null;
  for (const item of items) {
    if (
      item.key.collection !== INDICATION_CURRENT_STORAGE_COLLECTION ||
      (priorId !== null && priorId >= item.key.id)
    ) {
      unavailable();
    }
    priorId = item.key.id;
  }

  const nextCursor = source.nextCursor === null
    ? null
    : requiredOwnerIndicationReviewBackendCursor(
      source.nextCursor,
      unavailable,
    );
  if (
    nextCursor !== null &&
    (items.length === 0 || nextCursor === request.cursor)
  ) {
    unavailable();
  }
  return Object.freeze({ items: Object.freeze(items), nextCursor });
}

function exactOwnerIndicationReviewStorageRecord(value: unknown): StorageRecord {
  const source = exactRecord(value, STORAGE_RECORD_KEYS);
  const keySource = exactRecord(source.key, STORAGE_KEY_KEYS);
  const parsedKey = parseStorageKey(keySource.collection, keySource.id);
  if (
    !parsedKey.ok ||
    !Number.isSafeInteger(source.revision) ||
    (source.revision as number) < 1 ||
    objectRecord(source.value) === null
  ) {
    unavailable();
  }
  return Object.freeze({
    key: Object.freeze({ ...parsedKey.value }),
    revision: source.revision as number,
    value: source.value as StorageDocument,
  });
}

async function decodeOwnerIndicationReviewSummary(
  storage: OwnerIndicationReviewStorage,
  record: StorageRecord,
  tokens: OwnerIndicationReviewTokenBoundary,
  ownerSubject: ActorSubject,
): Promise<OwnerIndicationReviewSummary> {
  const coordinates = indicationCoordinatesFromCurrentDocument(record.value);
  const currentKey = await indicationCurrentStorageKey(coordinates.id);
  const current = decodeStoredIndicationCurrent(
    record,
    currentKey,
    coordinates.id,
    coordinates.subject,
  );
  const terminalKey = await indicationHistoryStorageKey(
    coordinates.id,
    current.revision,
  );
  const terminalRecord = await storage.read(terminalKey);
  if (terminalRecord === null) unavailable();
  const terminal = decodeStoredIndicationTransition(
    terminalRecord,
    terminalKey,
    coordinates.subject,
    coordinates.id,
    current.revision,
  );
  requireMatchingCurrentAndTerminal(current, terminal);
  const fields = await readStoredIndicationFields(
    storage,
    coordinates.subject,
    coordinates.id,
    current.fields,
  );
  const status = await verifyStoredIndicationTerminalProjection(
    terminal,
    fields.fields,
  );
  await verifyStoredActiveIndicationLease(
    storage,
    current,
    fields.fields,
    status,
  );
  return Object.freeze({
    reviewId: await tokens.reviewIdForCurrentKey(currentKey, ownerSubject),
    kind: fields.fields.kind,
    status,
    amount: fields.fields.amount,
    currency: fields.fields.currency,
    updatedAt: terminal.occurredAt,
    revision: current.revision,
  });
}

function requiredOwnerIndicationReviewCursor(
  value: unknown,
  fail: () => never,
): StorageCursor {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_OWNER_INDICATION_REVIEW_CURSOR_LENGTH
  ) {
    return fail();
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return fail();
    }
  }
  return value as StorageCursor;
}

function requiredOwnerIndicationReviewBackendCursor(
  value: unknown,
  fail: () => never,
): StorageCursor {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_OWNER_INDICATION_REVIEW_BACKEND_CURSOR_LENGTH
  ) {
    return fail();
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return fail();
    }
  }
  return value as StorageCursor;
}

function requiredOwnerIndicationReviewStorage(
  value: OwnerIndicationReviewStorage,
): OwnerIndicationReviewStorage {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.list !== "function" ||
    typeof value.read !== "function"
  ) {
    invalidRequest();
  }
  return value;
}

function requiredOwnerIndicationReviewTokenBoundary(
  value: OwnerIndicationReviewTokenBoundary,
): OwnerIndicationReviewTokenBoundary {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.sealCursor !== "function" ||
    typeof value.openCursor !== "function" ||
    typeof value.reviewIdForCurrentKey !== "function" ||
    typeof value.currentKeyForReviewId !== "function"
  ) {
    invalidRequest();
  }
  return value;
}

async function openOwnerIndicationReviewCursor(
  tokens: OwnerIndicationReviewTokenBoundary,
  publicCursor: StorageCursor,
  ownerSubject: ActorSubject,
  limit: number,
): Promise<StorageCursor> {
  try {
    return await tokens.openCursor(publicCursor, ownerSubject, limit);
  } catch {
    return invalidRequest();
  }
}

async function sealOwnerIndicationReviewCursor(
  tokens: OwnerIndicationReviewTokenBoundary,
  backendCursor: StorageCursor,
  ownerSubject: ActorSubject,
  limit: number,
): Promise<StorageCursor> {
  try {
    return await tokens.sealCursor(backendCursor, ownerSubject, limit);
  } catch {
    return unavailable();
  }
}

function requiredActorSubject(value: unknown): ActorSubject {
  const parsed = parseActorSubject(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) return null;
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) return null;
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function hasExactKeys(
  source: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(source);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function exactRecord(
  value: unknown,
  expected: ReadonlySet<string>,
): Record<string, unknown> {
  const source = objectRecord(value);
  if (source === null || !hasExactKeys(source, expected)) unavailable();
  return source;
}

function exactDenseArray(value: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) unavailable();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.at(-1) !== "length") {
    unavailable();
  }
  const entries: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (keys[index] !== String(index)) unavailable();
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) unavailable();
    entries.push(descriptor.value);
  }
  return Object.freeze(entries);
}

function invalidRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
}

function notFound(): never {
  throw new StorageFailure("NOT_FOUND");
}

function unavailable(): never {
  throw new StorageFailure("UNAVAILABLE");
}
