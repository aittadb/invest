import assert from "node:assert/strict";

import {
  AITTADB_HYPERMEDIA_API_VERSION,
  AITTADB_HYPERMEDIA_MEDIA_TYPE,
  defineStorageProtocolDiscovery,
  storageProtocolErrorDocument,
  storageProtocolErrorStatus,
  type StorageProtocolErrorCode,
  type StorageProtocolLimits,
  type StorageProtocolWireRecord,
} from "../../domain/aittadb-storage-protocol.ts";
import type { StorageDocument } from "../../domain/storage-adapter.ts";

type StoredRecord = Readonly<{
  revision: number;
  value: StorageDocument;
}>;

type OperationReceipt = Readonly<{
  fingerprint: string;
  records: readonly (StorageProtocolWireRecord | null)[];
}>;

export type SyntheticAittaDBStorageServiceOptions = Readonly<{
  issuer: string;
  transportOrigin: string;
  entryHref: string;
  clientId: string;
  clientSecret: string;
  accessToken: string;
  scopes: string;
  limits?: Partial<StorageProtocolLimits>;
  rejectTransaction?: (
    operationId: string,
  ) => StorageProtocolErrorCode | null;
  failCommittedTransaction?: (
    operationId: string,
  ) => StorageProtocolErrorCode | null;
}>;

const DEFAULT_LIMITS = Object.freeze({
  max_record_bytes: 65_536,
  max_page_size: 100,
  max_transaction_mutations: 25,
  max_transaction_bytes: 1_048_576,
  max_cursor_length: 2_048,
} satisfies StorageProtocolLimits);

/** Exact bounded-storage protocol fixture shared by hosted composition tests. */
export class SyntheticAittaDBStorageService {
  readonly #options: SyntheticAittaDBStorageServiceOptions;
  readonly #limits: StorageProtocolLimits;
  readonly #records = new Map<string, StoredRecord>();
  readonly #operations = new Map<string, OperationReceipt>();
  readonly readKeys: string[] = [];
  readonly transactionOperationIds: string[] = [];
  tokenRequests = 0;
  discoveryRequests = 0;
  transactionRequests = 0;
  largestRecordBytes = 0;
  largestTransactionBytes = 0;

  constructor(options: SyntheticAittaDBStorageServiceOptions) {
    this.#options = Object.freeze({ ...options });
    this.#limits = Object.freeze({
      ...DEFAULT_LIMITS,
      ...options.limits,
    });
  }

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const logical = this.#logicalUrl(request.url);
    if (logical.href === `${this.#options.issuer}/oauth/token`) {
      return this.#token(request);
    }

    assert.equal(
      request.headers.get("authorization"),
      `Bearer ${this.#options.accessToken}`,
    );
    assert.equal(request.headers.get("cookie"), null);
    if (logical.href === this.#options.entryHref) {
      this.discoveryRequests += 1;
      return protocolResponse(defineStorageProtocolDiscovery({
        entryHref: this.#options.entryHref,
        readRecordHref: `${this.#options.issuer}/records/{collection}/{id}`,
        listRecordsHref: `${this.#options.issuer}/records`,
        transactRecordsHref: `${this.#options.issuer}/records/transactions`,
        limits: this.#limits,
      }));
    }
    if (
      logical.pathname === "/records/transactions" &&
      request.method === "POST"
    ) {
      this.transactionRequests += 1;
      const body = await request.text();
      const bodyBytes = byteLength(body);
      this.largestTransactionBytes = Math.max(
        this.largestTransactionBytes,
        bodyBytes,
      );
      if (bodyBytes > this.#limits.max_transaction_bytes) {
        return errorResponse("quota_exceeded");
      }
      try {
        return this.#transact(JSON.parse(body));
      } catch {
        return errorResponse("invalid_request");
      }
    }
    if (logical.pathname === "/records" && request.method === "GET") {
      return this.#list(logical);
    }
    if (logical.pathname.startsWith("/records/") && request.method === "GET") {
      return this.#read(logical);
    }
    return errorResponse("not_found");
  };

  recordCount(): number {
    return this.#records.size;
  }

  operationCount(): number {
    return this.#operations.size;
  }

  recordKeys(): readonly string[] {
    return Object.freeze([...this.#records.keys()].sort(compareCodeUnits));
  }

  async #token(request: Request): Promise<Response> {
    this.tokenRequests += 1;
    assert.equal(request.method, "POST");
    assert.equal(
      request.headers.get("authorization"),
      `Basic ${btoa(`${this.#options.clientId}:${this.#options.clientSecret}`)}`,
    );
    assert.deepEqual(
      Object.fromEntries(new URLSearchParams(await request.text())),
      { grant_type: "client_credentials", scope: this.#options.scopes },
    );
    return jsonResponse({
      access_token: this.#options.accessToken,
      token_type: "Bearer",
      expires_in: 3_600,
      scope: this.#options.scopes,
    });
  }

  #read(url: URL): Response {
    const parts = url.pathname.split("/");
    if (parts.length !== 4) return errorResponse("not_found");
    const collection = decodeURIComponent(parts[2] ?? "");
    const id = decodeURIComponent(parts[3] ?? "");
    const storageKey = key(collection, id);
    this.readKeys.push(storageKey);
    const record = this.#records.get(storageKey);
    if (record === undefined) return errorResponse("not_found");
    return protocolResponse({
      api_version: AITTADB_HYPERMEDIA_API_VERSION,
      type: "bounded-storage-record",
      id: `${collection}/${id}`,
      data: wireRecord(collection, id, record),
      links: [],
      actions: [],
    });
  }

  #list(url: URL): Response {
    const collection = url.searchParams.get("collection") ?? "";
    const limit = Number(url.searchParams.get("limit"));
    const cursorValue = url.searchParams.get("cursor");
    const offset = cursorValue === null ? 0 : Number(cursorValue);
    if (
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(offset) || offset < 0
    ) {
      return errorResponse("invalid_request");
    }
    const records = [...this.#records.entries()]
      .flatMap(([storedKey, record]) => {
        const [recordCollection, ...idParts] = storedKey.split("/");
        return recordCollection === collection
          ? [wireRecord(recordCollection, idParts.join("/"), record)]
          : [];
      })
      .sort((left, right) => compareCodeUnits(left.key.id, right.key.id));
    const items = records.slice(offset, offset + limit);
    const nextCursor = offset + items.length < records.length
      ? String(offset + items.length)
      : null;
    const logicalSelf = new URL(`${url.pathname}${url.search}`, this.#options.issuer);
    const links = [{
      rel: ["self"],
      href: logicalSelf.href,
      type: AITTADB_HYPERMEDIA_MEDIA_TYPE,
    }];
    if (nextCursor !== null) {
      const next = new URL(logicalSelf);
      next.searchParams.set("cursor", nextCursor);
      links.push({
        rel: ["next"],
        href: next.href,
        type: AITTADB_HYPERMEDIA_MEDIA_TYPE,
      });
    }
    return protocolResponse({
      api_version: AITTADB_HYPERMEDIA_API_VERSION,
      type: "bounded-storage-records-page",
      id: logicalSelf.href,
      data: {
        collection,
        page_size: limit,
        items,
        next_cursor: nextCursor,
      },
      links,
      actions: [],
    });
  }

  #transact(value: unknown): Response {
    const transaction = requiredObject(requiredObject(value).transaction);
    const operationId = requiredString(transaction.operation_id);
    this.transactionOperationIds.push(operationId);
    const mutations = requiredArray(transaction.mutations).map(requiredObject);
    if (mutations.length > this.#limits.max_transaction_mutations) {
      return errorResponse("quota_exceeded");
    }
    const rejection = this.#options.rejectTransaction?.(operationId) ?? null;
    if (rejection !== null) return errorResponse(rejection);
    const fingerprint = JSON.stringify(transaction);
    const prior = this.#operations.get(operationId);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) return errorResponse("conflict");
      return this.#completedTransactionResponse(operationId, prior.records, true);
    }

    const staged = new Map(this.#records);
    const records: (StorageProtocolWireRecord | null)[] = [];
    for (const mutation of mutations) {
      const mutationKey = requiredObject(mutation.key);
      const collection = requiredString(mutationKey.collection);
      const id = requiredString(mutationKey.id);
      const storageKey = key(collection, id);
      const current = staged.get(storageKey);
      const expected = mutation.expected_revision;
      if (mutation.type === "put") {
        const mutationValue = requiredObject(mutation.value);
        const recordBytes = byteLength(JSON.stringify(mutationValue));
        this.largestRecordBytes = Math.max(
          this.largestRecordBytes,
          recordBytes,
        );
        if (recordBytes > this.#limits.max_record_bytes) {
          return errorResponse("quota_exceeded");
        }
        if (
          expected === null ? current !== undefined :
            !Number.isSafeInteger(expected) || current?.revision !== expected
        ) {
          return errorResponse("precondition_failed");
        }
        const next = Object.freeze({
          revision: expected === null ? 1 : Number(expected) + 1,
          value: structuredClone(mutationValue) as StorageDocument,
        });
        staged.set(storageKey, next);
        records.push(wireRecord(collection, id, next));
      } else if (mutation.type === "delete") {
        if (!Number.isSafeInteger(expected) || current?.revision !== expected) {
          return errorResponse("precondition_failed");
        }
        staged.delete(storageKey);
        records.push(null);
      } else {
        return errorResponse("invalid_request");
      }
    }

    this.#records.clear();
    for (const [storageKey, record] of staged) {
      this.#records.set(storageKey, record);
    }
    const receipt = Object.freeze({
      fingerprint,
      records: Object.freeze(structuredClone(records)),
    });
    this.#operations.set(operationId, receipt);
    return this.#completedTransactionResponse(operationId, receipt.records, false);
  }

  #completedTransactionResponse(
    operationId: string,
    records: readonly (StorageProtocolWireRecord | null)[],
    replayed: boolean,
  ): Response {
    const failure = this.#options.failCommittedTransaction?.(operationId) ?? null;
    return failure === null
      ? transactionResponse(operationId, records, replayed)
      : errorResponse(failure);
  }

  #logicalUrl(value: string): URL {
    const url = new URL(value);
    if (url.origin === this.#options.transportOrigin) {
      return new URL(`${url.pathname}${url.search}`, this.#options.issuer);
    }
    return url;
  }
}

function wireRecord(
  collection: string,
  id: string,
  record: StoredRecord,
): StorageProtocolWireRecord {
  return {
    key: { collection, id },
    revision: record.revision,
    value: structuredClone(record.value),
  };
}

function transactionResponse(
  operationId: string,
  records: readonly (StorageProtocolWireRecord | null)[],
  replayed: boolean,
): Response {
  return protocolResponse({
    api_version: AITTADB_HYPERMEDIA_API_VERSION,
    type: "bounded-storage-transaction",
    id: operationId,
    data: { operation_id: operationId, replayed, records },
    links: [],
    actions: [],
  });
}

function errorResponse(code: StorageProtocolErrorCode): Response {
  return protocolResponse(
    storageProtocolErrorDocument(code),
    storageProtocolErrorStatus(code),
  );
}

function protocolResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE },
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function key(collection: string, id: string): string {
  return `${collection}/${id}`;
}

function requiredObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected synthetic object.");
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected synthetic array.");
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected synthetic string.");
  return value;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
