import {
  MAX_STORAGE_PAGE_SIZE,
  MAX_STORAGE_TRANSACTION_MUTATIONS,
  StorageFailure,
  assertStorageListBoundary,
  assertStorageTransactionBoundary,
  parseStorageKey,
  storageKeyString,
  type JsonValue,
  type StorageCursor,
  type StorageDocument,
  type StorageKey,
  type StoragePage,
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "./storage-adapter.ts";

export const AITTADB_HYPERMEDIA_API_VERSION = "0.1";
export const AITTADB_HYPERMEDIA_MEDIA_TYPE =
  "application/vnd.aittadb+json; version=0.1";
export const BOUNDED_STORAGE_PROTOCOL_VERSION = "1.0";

export const MAX_STORAGE_PROTOCOL_RECORD_BYTES = 262_144;
export const MAX_STORAGE_PROTOCOL_TRANSACTION_BYTES = 1_048_576;
export const MAX_STORAGE_PROTOCOL_CURSOR_LENGTH = 2_048;

export const REQUIRED_STORAGE_PROTOCOL_CAPABILITIES = Object.freeze([
  "bounded-record-read",
  "opaque-cursor-page",
  "atomic-multi-record-compare-and-set",
  "idempotent-operation-id",
  "atomic-rollback",
  "quota-preflight",
  "non-disclosing-authorization",
] as const);

export type StorageProtocolCapability =
  (typeof REQUIRED_STORAGE_PROTOCOL_CAPABILITIES)[number];

export type StorageProtocolLimits = Readonly<{
  max_record_bytes: number;
  max_page_size: number;
  max_transaction_mutations: number;
  max_transaction_bytes: number;
  max_cursor_length: number;
}>;

export type StorageProtocolLink = Readonly<{
  rel: readonly string[];
  href: string;
  type: typeof AITTADB_HYPERMEDIA_MEDIA_TYPE;
  templated?: boolean;
}>;

export type StorageProtocolField = Readonly<{
  name: string;
  title: string;
  type: "string" | "integer" | "object";
  location: "path" | "query" | "body";
  required: boolean;
  min?: number;
  max?: number;
  min_length?: number;
  max_length?: number;
  max_bytes?: number;
  description?: string;
}>;

export type StorageProtocolAction = Readonly<{
  name: "read-record" | "list-records" | "transact-records";
  title: string;
  method: "GET" | "POST";
  href: string;
  type?: "application/json";
  accept: typeof AITTADB_HYPERMEDIA_MEDIA_TYPE;
  templated?: boolean;
  authorization: Readonly<{
    scheme: "bearer";
    scopes: readonly ("storage.read" | "storage.write" | "storage.delete")[];
  }>;
  fields: readonly StorageProtocolField[];
}>;

export type StorageProtocolDiscoveryData = Readonly<{
  protocol: "bounded-record-storage";
  protocol_version: typeof BOUNDED_STORAGE_PROTOCOL_VERSION;
  capabilities: readonly StorageProtocolCapability[];
  limits: StorageProtocolLimits;
  preconditions: "compare-and-set-revision";
  idempotency: "canonical-request-per-operation-id";
  rollback: "all-mutations-and-operation-receipt";
  quota: "reject-before-commit";
  authorization: "missing-and-denied-are-not-found";
  pagination: "opaque-cursor-with-next-link";
  transaction_shape: Readonly<{
    operation_id: Readonly<{
      format: "stable-id";
      min_length: 1;
      max_length: 128;
    }>;
    mutations: Readonly<{
      min_items: 1;
      max_items: typeof MAX_STORAGE_TRANSACTION_MUTATIONS;
      unique_keys: true;
      order: "preserved";
      put: "null-creates-positive-revision-replaces";
      delete: "positive-revision-required";
    }>;
    results: "ordered-record-or-null-per-mutation";
  }>;
}>;

export type StorageProtocolDiscoveryDocument = Readonly<{
  api_version: typeof AITTADB_HYPERMEDIA_API_VERSION;
  type: "bounded-record-storage";
  id: string;
  data: StorageProtocolDiscoveryData;
  links: readonly StorageProtocolLink[];
  actions: readonly StorageProtocolAction[];
}>;

export type StorageProtocolWireKey = Readonly<{
  collection: string;
  id: string;
}>;

export type StorageProtocolWireRecord = Readonly<{
  key: StorageProtocolWireKey;
  revision: number;
  value: StorageDocument;
}>;

export type StorageProtocolWireMutation =
  | Readonly<{
      type: "put";
      key: StorageProtocolWireKey;
      expected_revision: number | null;
      value: StorageDocument;
    }>
  | Readonly<{
      type: "delete";
      key: StorageProtocolWireKey;
      expected_revision: number;
    }>;

export type StorageProtocolTransactionCommand = Readonly<{
  transaction: Readonly<{
    operation_id: string;
    mutations: readonly StorageProtocolWireMutation[];
  }>;
}>;

export type StorageProtocolRecordDocument = Readonly<{
  api_version: typeof AITTADB_HYPERMEDIA_API_VERSION;
  type: "bounded-storage-record";
  id: string;
  data: StorageProtocolWireRecord;
  links: readonly StorageProtocolLink[];
  actions: readonly StorageProtocolAction[];
}>;

export type StorageProtocolPageDocument = Readonly<{
  api_version: typeof AITTADB_HYPERMEDIA_API_VERSION;
  type: "bounded-storage-records-page";
  id: string;
  data: Readonly<{
    collection: string;
    page_size: number;
    items: readonly StorageProtocolWireRecord[];
    next_cursor: string | null;
  }>;
  links: readonly StorageProtocolLink[];
  actions: readonly StorageProtocolAction[];
}>;

export type StorageProtocolTransactionDocument = Readonly<{
  api_version: typeof AITTADB_HYPERMEDIA_API_VERSION;
  type: "bounded-storage-transaction";
  id: string;
  data: Readonly<{
    operation_id: string;
    replayed: boolean;
    records: readonly (StorageProtocolWireRecord | null)[];
  }>;
  links: readonly StorageProtocolLink[];
  actions: readonly StorageProtocolAction[];
}>;

export type StorageProtocolErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "precondition_failed"
  | "quota_exceeded"
  | "unavailable";

export type StorageProtocolErrorDocument = Readonly<{
  api_version: typeof AITTADB_HYPERMEDIA_API_VERSION;
  type: "bounded-storage-error";
  data: Readonly<{
    code: StorageProtocolErrorCode;
    message: string;
  }>;
  links: readonly [];
  actions: readonly [];
}>;

export type StorageProtocolDiscoveryInput = Readonly<{
  entryHref: string;
  readRecordHref: string;
  listRecordsHref: string;
  transactRecordsHref: string;
  limits: StorageProtocolLimits;
}>;

const ERROR_STATUS = Object.freeze({
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  quota_exceeded: 507,
  unavailable: 503,
} as const satisfies Readonly<Record<StorageProtocolErrorCode, number>>);

const ERROR_MESSAGE = Object.freeze({
  invalid_request: "The storage request is invalid.",
  not_found: "The storage resource was not found.",
  conflict: "The storage request conflicts with current state.",
  precondition_failed: "The storage resource has changed.",
  quota_exceeded: "The storage quota would be exceeded.",
  unavailable: "Storage is temporarily unavailable.",
} as const satisfies Readonly<Record<StorageProtocolErrorCode, string>>);

export function defineStorageProtocolDiscovery(
  input: StorageProtocolDiscoveryInput,
): StorageProtocolDiscoveryDocument {
  const entry = exactHttpsUrl(input.entryHref);
  const list = exactHttpsUrl(input.listRecordsHref);
  const transaction = exactHttpsUrl(input.transactRecordsHref);
  const read = templatedReadUrl(input.readRecordHref);
  if (
    list.origin !== entry.origin ||
    transaction.origin !== entry.origin ||
    read.origin !== entry.origin
  ) {
    throw new StorageFailure("INVALID_REQUEST");
  }

  const limits = validateProtocolLimits(input.limits);
  return deepFreeze({
    api_version: AITTADB_HYPERMEDIA_API_VERSION,
    type: "bounded-record-storage",
    id: entry.href,
    data: {
      protocol: "bounded-record-storage",
      protocol_version: BOUNDED_STORAGE_PROTOCOL_VERSION,
      capabilities: [...REQUIRED_STORAGE_PROTOCOL_CAPABILITIES],
      limits: { ...limits },
      preconditions: "compare-and-set-revision",
      idempotency: "canonical-request-per-operation-id",
      rollback: "all-mutations-and-operation-receipt",
      quota: "reject-before-commit",
      authorization: "missing-and-denied-are-not-found",
      pagination: "opaque-cursor-with-next-link",
      transaction_shape: {
        operation_id: {
          format: "stable-id",
          min_length: 1,
          max_length: 128,
        },
        mutations: {
          min_items: 1,
          max_items: MAX_STORAGE_TRANSACTION_MUTATIONS,
          unique_keys: true,
          order: "preserved",
          put: "null-creates-positive-revision-replaces",
          delete: "positive-revision-required",
        },
        results: "ordered-record-or-null-per-mutation",
      },
    },
    links: [
      protocolLink("self", entry.href),
      protocolLink("records", list.href),
    ],
    actions: [
      {
        name: "read-record",
        title: "Read record",
        method: "GET",
        href: input.readRecordHref,
        accept: AITTADB_HYPERMEDIA_MEDIA_TYPE,
        templated: true,
        authorization: { scheme: "bearer", scopes: ["storage.read"] },
        fields: [
          textField("collection", "Collection", "path", true, 1, 64),
          textField("id", "Record ID", "path", true, 1, 128),
        ],
      },
      {
        name: "list-records",
        title: "List records",
        method: "GET",
        href: list.href,
        accept: AITTADB_HYPERMEDIA_MEDIA_TYPE,
        authorization: { scheme: "bearer", scopes: ["storage.read"] },
        fields: [
          textField("collection", "Collection", "query", true, 1, 64),
          {
            name: "limit",
            title: "Page size",
            type: "integer",
            location: "query",
            required: true,
            min: 1,
            max: MAX_STORAGE_PAGE_SIZE,
          },
          textField(
            "cursor",
            "Opaque continuation cursor",
            "query",
            false,
            1,
            limits.max_cursor_length,
          ),
        ],
      },
      {
        name: "transact-records",
        title: "Apply record transaction",
        method: "POST",
        href: transaction.href,
        type: "application/json",
        accept: AITTADB_HYPERMEDIA_MEDIA_TYPE,
        authorization: {
          scheme: "bearer",
          scopes: ["storage.write", "storage.delete"],
        },
        fields: [
          {
            name: "transaction",
            title: "Atomic transaction",
            type: "object",
            location: "body",
            required: true,
            max_bytes: limits.max_transaction_bytes,
            description:
              "One operation_id and an ordered mutations array of compare-and-set put or delete entries.",
          },
        ],
      },
    ],
  });
}

export function parseStorageProtocolDiscovery(
  value: unknown,
  expectedOrigin: string,
): StorageProtocolDiscoveryDocument {
  const object = requiredObject(value);
  if (
    object.api_version !== AITTADB_HYPERMEDIA_API_VERSION ||
    object.type !== "bounded-record-storage" ||
    typeof object.id !== "string"
  ) {
    invalidProtocol();
  }
  const data = requiredObject(object.data);
  const limits = parseProtocolLimits(data.limits);
  if (
    data.protocol !== "bounded-record-storage" ||
    data.protocol_version !== BOUNDED_STORAGE_PROTOCOL_VERSION ||
    data.preconditions !== "compare-and-set-revision" ||
    data.idempotency !== "canonical-request-per-operation-id" ||
    data.rollback !== "all-mutations-and-operation-receipt" ||
    data.quota !== "reject-before-commit" ||
    data.authorization !== "missing-and-denied-are-not-found" ||
    data.pagination !== "opaque-cursor-with-next-link" ||
    !hasRequiredCapabilities(data.capabilities)
  ) {
    invalidProtocol();
  }

  const actions = requiredArray(object.actions);
  const read = requiredAction(actions, "read-record");
  const list = requiredAction(actions, "list-records");
  const transaction = requiredAction(actions, "transact-records");
  const expected = defineStorageProtocolDiscovery({
    entryHref: object.id,
    readRecordHref: requiredString(read.href),
    listRecordsHref: requiredString(list.href),
    transactRecordsHref: requiredString(transaction.href),
    limits,
  });
  const origin = exactHttpsOrigin(expectedOrigin);
  if (new URL(expected.id).origin !== origin) invalidProtocol();

  const links = requiredArray(object.links);
  for (const expectedLink of expected.links) {
    const actual = requiredLink(links, expectedLink.rel[0] ?? "");
    if (canonicalJson(actual) !== canonicalJson(expectedLink)) invalidProtocol();
  }
  if (
    canonicalJson(data.transaction_shape) !==
      canonicalJson(expected.data.transaction_shape)
  ) {
    invalidProtocol();
  }

  for (const expectedAction of expected.actions) {
    const actual = requiredAction(actions, expectedAction.name);
    if (canonicalJson(actual) !== canonicalJson(expectedAction)) invalidProtocol();
  }
  return expected;
}

export function toStorageProtocolTransactionCommand(
  request: StorageTransactionRequest,
): StorageProtocolTransactionCommand {
  assertStorageTransactionBoundary(request);
  const command: StorageProtocolTransactionCommand = {
    transaction: {
      operation_id: request.operationId,
      mutations: request.mutations.map((mutation) =>
        mutation.type === "put"
          ? {
              type: "put",
              key: { ...mutation.key },
              expected_revision: mutation.expectedRevision,
              value: cloneStorageDocument(mutation.value),
            }
          : {
              type: "delete",
              key: { ...mutation.key },
              expected_revision: mutation.expectedRevision,
            }
      ),
    },
  };
  return deepFreeze(command);
}

export function parseStorageProtocolRecord(
  value: unknown,
  expectedKey: StorageKey,
  maxRecordBytes: number,
): StorageRecord {
  const object = protocolDocument(value, "bounded-storage-record");
  requiredArray(object.links);
  requiredArray(object.actions);
  return parseWireRecord(object.data, expectedKey, maxRecordBytes);
}

export function parseStorageProtocolPage(
  value: unknown,
  request: Parameters<import("./storage-adapter.ts").StorageAdapter["list"]>[0],
  limits: StorageProtocolLimits,
): StoragePage {
  assertStorageListBoundary(request);
  const object = protocolDocument(value, "bounded-storage-records-page");
  const data = requiredObject(object.data);
  if (
    data.collection !== request.collection ||
    data.page_size !== request.limit
  ) {
    invalidProtocol();
  }
  const id = requiredString(object.id);
  const self = exactHttpsUrl(id);
  if (!matchesPageUrl(self, request.collection, request.limit, request.cursor ?? null)) {
    invalidProtocol();
  }
  const wireItems = requiredArray(data.items);
  if (wireItems.length > request.limit) invalidProtocol();
  const items = wireItems.map((item) =>
    parseWireRecord(item, undefined, limits.max_record_bytes)
  );
  const seen = new Set<string>();
  let priorId: string | null = null;
  for (const item of items) {
    if (item.key.collection !== request.collection) invalidProtocol();
    const key = storageKeyString(item.key);
    if (seen.has(key) || (priorId !== null && priorId.localeCompare(item.key.id) >= 0)) {
      invalidProtocol();
    }
    seen.add(key);
    priorId = item.key.id;
  }
  const cursor = parseCursor(data.next_cursor, limits.max_cursor_length);
  const links = requiredArray(object.links);
  const selfLink = requiredLink(links, "self");
  if (
    canonicalJson(selfLink) !== canonicalJson(protocolLink("self", self.href))
  ) {
    invalidProtocol();
  }
  const nextLinks = matchingLinks(links, "next");
  if (cursor === null) {
    if (nextLinks.length !== 0) invalidProtocol();
  } else {
    if (
      nextLinks.length !== 1 ||
      items.length === 0 ||
      cursor === request.cursor
    ) {
      invalidProtocol();
    }
    const nextLink = requiredObject(nextLinks[0]);
    if (
      nextLink.type !== AITTADB_HYPERMEDIA_MEDIA_TYPE ||
      canonicalJson(nextLink.rel) !== canonicalJson(["next"])
    ) {
      invalidProtocol();
    }
    const next = exactHttpsUrl(requiredString(nextLink.href));
    if (
      next.origin !== self.origin ||
      next.pathname !== self.pathname ||
      !matchesPageUrl(next, request.collection, request.limit, cursor)
    ) {
      invalidProtocol();
    }
  }
  requiredArray(object.actions);
  return deepFreeze({ items, nextCursor: cursor });
}

export function parseStorageProtocolTransaction(
  value: unknown,
  request: StorageTransactionRequest,
  maxRecordBytes: number,
): StorageTransactionResult {
  assertStorageTransactionBoundary(request);
  const object = protocolDocument(value, "bounded-storage-transaction");
  const data = requiredObject(object.data);
  if (
    object.id !== request.operationId ||
    data.operation_id !== request.operationId ||
    typeof data.replayed !== "boolean"
  ) {
    invalidProtocol();
  }
  requiredArray(object.links);
  requiredArray(object.actions);
  const wireRecords = requiredArray(data.records);
  if (wireRecords.length !== request.mutations.length) invalidProtocol();
  const records = wireRecords.map((wireRecord, index) => {
    const mutation = request.mutations[index];
    if (mutation === undefined) invalidProtocol();
    if (mutation.type === "delete") {
      if (wireRecord !== null) invalidProtocol();
      return null;
    }
    const record = parseWireRecord(wireRecord, mutation.key, maxRecordBytes);
    const expectedRevision = mutation.expectedRevision === null
      ? 1
      : mutation.expectedRevision + 1;
    if (
      record.revision !== expectedRevision ||
      canonicalJson(record.value) !== canonicalJson(mutation.value)
    ) {
      invalidProtocol();
    }
    return record;
  });
  return deepFreeze({ replayed: data.replayed, records });
}

export function storageProtocolErrorDocument(
  code: StorageProtocolErrorCode,
): StorageProtocolErrorDocument {
  return deepFreeze({
    api_version: AITTADB_HYPERMEDIA_API_VERSION,
    type: "bounded-storage-error",
    data: { code, message: ERROR_MESSAGE[code] },
    links: [],
    actions: [],
  });
}

export function storageProtocolErrorStatus(
  code: StorageProtocolErrorCode,
): number {
  return ERROR_STATUS[code];
}

export function storageFailureFromProtocol(
  status: number,
  value: unknown,
): StorageFailure {
  try {
    const object = protocolDocument(value, "bounded-storage-error");
    const data = requiredObject(object.data);
    if (
      !isStorageProtocolErrorCode(data.code) ||
      data.message !== ERROR_MESSAGE[data.code] ||
      ERROR_STATUS[data.code] !== status ||
      canonicalJson(Object.keys(object).sort()) !==
        canonicalJson(["actions", "api_version", "data", "links", "type"]) ||
      canonicalJson(Object.keys(data).sort()) !==
        canonicalJson(["code", "message"]) ||
      requiredArray(object.links).length !== 0 ||
      requiredArray(object.actions).length !== 0
    ) {
      return new StorageFailure("UNAVAILABLE");
    }
    const mapping = {
      invalid_request: "INVALID_REQUEST",
      not_found: "NOT_FOUND",
      conflict: "CONFLICT",
      precondition_failed: "PRECONDITION_FAILED",
      quota_exceeded: "UNAVAILABLE",
      unavailable: "UNAVAILABLE",
    } as const;
    return new StorageFailure(mapping[data.code]);
  } catch {
    return new StorageFailure("UNAVAILABLE");
  }
}

function validateProtocolLimits(limits: StorageProtocolLimits): StorageProtocolLimits {
  if (
    !boundedInteger(limits.max_record_bytes, 1, MAX_STORAGE_PROTOCOL_RECORD_BYTES) ||
    !boundedInteger(
      limits.max_page_size,
      MAX_STORAGE_PAGE_SIZE,
      MAX_STORAGE_PAGE_SIZE,
    ) ||
    !boundedInteger(
      limits.max_transaction_mutations,
      MAX_STORAGE_TRANSACTION_MUTATIONS,
      MAX_STORAGE_TRANSACTION_MUTATIONS,
    ) ||
    !boundedInteger(
      limits.max_transaction_bytes,
      1,
      MAX_STORAGE_PROTOCOL_TRANSACTION_BYTES,
    ) ||
    !boundedInteger(
      limits.max_cursor_length,
      1,
      MAX_STORAGE_PROTOCOL_CURSOR_LENGTH,
    )
  ) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return Object.freeze({ ...limits });
}

function parseProtocolLimits(value: unknown): StorageProtocolLimits {
  const object = requiredObject(value);
  return validateProtocolLimits({
    max_record_bytes: requiredNumber(object.max_record_bytes),
    max_page_size: requiredNumber(object.max_page_size),
    max_transaction_mutations: requiredNumber(
      object.max_transaction_mutations,
    ),
    max_transaction_bytes: requiredNumber(object.max_transaction_bytes),
    max_cursor_length: requiredNumber(object.max_cursor_length),
  });
}

function parseWireRecord(
  value: unknown,
  expectedKey: StorageKey | undefined,
  maxRecordBytes: number,
): StorageRecord {
  if (!boundedInteger(maxRecordBytes, 1, MAX_STORAGE_PROTOCOL_RECORD_BYTES)) {
    invalidProtocol();
  }
  const object = requiredObject(value);
  const wireKey = requiredObject(object.key);
  const parsedKey = parseStorageKey(wireKey.collection, wireKey.id);
  if (!parsedKey.ok) invalidProtocol();
  if (
    expectedKey !== undefined &&
    storageKeyString(parsedKey.value) !== storageKeyString(expectedKey)
  ) {
    invalidProtocol();
  }
  if (!boundedInteger(object.revision, 1, Number.MAX_SAFE_INTEGER)) {
    invalidProtocol();
  }
  const document = parseStorageDocument(object.value);
  if (jsonByteLength(document) > maxRecordBytes) invalidProtocol();
  return deepFreeze({
    key: parsedKey.value,
    revision: object.revision,
    value: document,
  });
}

function parseStorageDocument(value: unknown): StorageDocument {
  if (!isPlainObject(value)) invalidProtocol();
  return cloneStorageDocument(value as Readonly<Record<string, JsonValue>>);
}

function cloneStorageDocument(value: StorageDocument): StorageDocument {
  return cloneJson(value) as StorageDocument;
}

function cloneJson(value: JsonValue): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidProtocol();
    return value;
  }
  if (Array.isArray(value)) return value.map(cloneJson);
  if (!isPlainObject(value)) invalidProtocol();
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, cloneJson(child)]),
  );
}

function parseCursor(value: unknown, maxLength: number): StorageCursor | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    hasControlCharacter(value)
  ) {
    invalidProtocol();
  }
  return value as StorageCursor;
}

function protocolDocument(
  value: unknown,
  type:
    | StorageProtocolRecordDocument["type"]
    | StorageProtocolPageDocument["type"]
    | StorageProtocolTransactionDocument["type"]
    | StorageProtocolErrorDocument["type"],
): Readonly<Record<string, unknown>> {
  const object = requiredObject(value);
  if (
    object.api_version !== AITTADB_HYPERMEDIA_API_VERSION ||
    object.type !== type
  ) {
    invalidProtocol();
  }
  return object;
}

function requiredAction(
  actions: readonly unknown[],
  name: StorageProtocolAction["name"],
): Readonly<Record<string, unknown>> {
  const matches = actions.filter(
    (action) => isPlainObject(action) && action.name === name,
  );
  if (matches.length !== 1) invalidProtocol();
  return matches[0] as Readonly<Record<string, unknown>>;
}

function requiredLink(
  links: readonly unknown[],
  relation: string,
): Readonly<Record<string, unknown>> {
  const matches = matchingLinks(links, relation);
  if (matches.length !== 1) invalidProtocol();
  return requiredObject(matches[0]);
}

function matchingLinks(
  links: readonly unknown[],
  relation: string,
): readonly unknown[] {
  return links.filter((link) => {
    if (!isPlainObject(link) || !Array.isArray(link.rel)) return false;
    return link.rel.includes(relation);
  });
}

function hasRequiredCapabilities(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== REQUIRED_STORAGE_PROTOCOL_CAPABILITIES.length) {
    return false;
  }
  const values = new Set(value);
  return REQUIRED_STORAGE_PROTOCOL_CAPABILITIES.every((item) => values.has(item));
}

function protocolLink(rel: string, href: string): StorageProtocolLink {
  return { rel: [rel], href, type: AITTADB_HYPERMEDIA_MEDIA_TYPE };
}

function textField(
  name: string,
  title: string,
  location: "path" | "query",
  required: boolean,
  minLength: number,
  maxLength: number,
): StorageProtocolField {
  return {
    name,
    title,
    type: "string",
    location,
    required,
    min_length: minLength,
    max_length: maxLength,
  };
}

function exactHttpsOrigin(value: string): string {
  const url = exactHttpsUrl(value);
  if (url.href !== `${url.origin}/`) invalidProtocol();
  return url.origin;
}

function exactHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidProtocol();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    invalidProtocol();
  }
  return url;
}

function templatedReadUrl(value: string): URL {
  if (
    (value.match(/\{collection\}/g) ?? []).length !== 1 ||
    (value.match(/\{id\}/g) ?? []).length !== 1 ||
    /\{(?!collection\}|id\})/.test(value)
  ) {
    invalidProtocol();
  }
  return exactHttpsUrl(
    value.replace("{collection}", "collection").replace("{id}", "record"),
  );
}

function matchesPageUrl(
  url: URL,
  collection: string,
  limit: number,
  cursor: string | null,
): boolean {
  const names = [...url.searchParams.keys()].sort();
  const expectedNames = cursor === null
    ? ["collection", "limit"]
    : ["collection", "cursor", "limit"];
  return canonicalJson(names) === canonicalJson(expectedNames) &&
    url.searchParams.get("collection") === collection &&
    url.searchParams.get("limit") === String(limit) &&
    url.searchParams.get("cursor") === cursor;
}

function requiredObject(value: unknown): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) invalidProtocol();
  return value;
}

function requiredArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) invalidProtocol();
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") invalidProtocol();
  return value;
}

function requiredNumber(value: unknown): number {
  if (typeof value !== "number") invalidProtocol();
  return value;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= maximum;
}

function isStorageProtocolErrorCode(value: unknown): value is StorageProtocolErrorCode {
  return typeof value === "string" && value in ERROR_STATUS;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

function jsonByteLength(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invalidProtocol();
  }
  return new TextEncoder().encode(serialized).byteLength;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function invalidProtocol(): never {
  throw new StorageFailure("UNAVAILABLE");
}
