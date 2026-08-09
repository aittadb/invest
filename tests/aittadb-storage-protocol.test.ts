import assert from "node:assert/strict";
import test from "node:test";

import {
  AITTADB_HYPERMEDIA_API_VERSION,
  AITTADB_HYPERMEDIA_MEDIA_TYPE,
  BOUNDED_STORAGE_PROTOCOL_VERSION,
  REQUIRED_STORAGE_PROTOCOL_CAPABILITIES,
  defineStorageProtocolDiscovery,
  parseStorageProtocolDiscovery,
  parseStorageProtocolPage,
  parseStorageProtocolRecord,
  parseStorageProtocolTransaction,
  storageFailureFromProtocol,
  storageProtocolErrorDocument,
  storageProtocolErrorStatus,
  toStorageProtocolTransactionCommand,
  type StorageProtocolAction,
  type StorageProtocolDiscoveryDocument,
  type StorageProtocolErrorCode,
  type StorageProtocolLimits,
  type StorageProtocolPageDocument,
  type StorageProtocolRecordDocument,
  type StorageProtocolTransactionDocument,
  type StorageProtocolWireRecord,
} from "../domain/aittadb-storage-protocol.ts";
import {
  StorageFailure,
  assertStorageTransactionBoundary,
  parseStorageKey,
  parseStorageOperationId,
  storageKeyString,
  type StorageAdapter,
  type StorageDocument,
  type StorageKey,
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import {
  verifyStorageAdapterContract,
  type StorageAdapterContractFixture,
} from "./support/storage-adapter-contract.ts";

const ORIGIN = "https://storage.protocol.example";
const ENTRY_HREF = `${ORIGIN}/entry/records`;
const READ_HREF = `${ORIGIN}/resources/{collection}/{id}`;
const LIST_HREF = `${ORIGIN}/pages/records`;
const TRANSACT_HREF = `${ORIGIN}/operations/atomic-records`;
const OWNER_TOKEN = "fixture-owner-token";
const OUTSIDER_TOKEN = "fixture-outsider-token";

const LIMITS: StorageProtocolLimits = Object.freeze({
  max_record_bytes: 4_096,
  max_page_size: 100,
  max_transaction_mutations: 25,
  max_transaction_bytes: 65_536,
  max_cursor_length: 256,
});

test("discovery describes the complete bounded atomic storage capability", () => {
  const document = discoveryDocument();
  assert.equal(document.api_version, AITTADB_HYPERMEDIA_API_VERSION);
  assert.equal(document.data.protocol_version, BOUNDED_STORAGE_PROTOCOL_VERSION);
  assert.deepEqual(document.data.capabilities, REQUIRED_STORAGE_PROTOCOL_CAPABILITIES);
  assert.deepEqual(
    document.actions.map(({ name, method, href }) => ({ name, method, href })),
    [
      { name: "read-record", method: "GET", href: READ_HREF },
      { name: "list-records", method: "GET", href: LIST_HREF },
      {
        name: "transact-records",
        method: "POST",
        href: TRANSACT_HREF,
      },
    ],
  );
  const transaction = requiredProtocolAction(document, "transact-records");
  assert.deepEqual(transaction.authorization.scopes, [
    "storage.write",
    "storage.delete",
  ]);
  assert.deepEqual(transaction.fields, [
    {
      name: "transaction",
      title: "Atomic transaction",
      type: "object",
      location: "body",
      required: true,
      max_bytes: LIMITS.max_transaction_bytes,
      description:
        "One operation_id and an ordered mutations array of compare-and-set put or delete entries.",
    },
  ]);
  assert.deepEqual(
    parseStorageProtocolDiscovery(document, ORIGIN),
    document,
  );

  const wrongVersion = {
    ...document,
    data: { ...document.data, protocol_version: "2.0" },
  };
  assertStorageFailure(
    () => parseStorageProtocolDiscovery(wrongVersion, ORIGIN),
    "UNAVAILABLE",
  );
  assertStorageFailure(
    () => defineStorageProtocolDiscovery({
      entryHref: ENTRY_HREF,
      readRecordHref: READ_HREF,
      listRecordsHref: "https://foreign.example/pages",
      transactRecordsHref: TRANSACT_HREF,
      limits: LIMITS,
    }),
    "INVALID_REQUEST",
  );
});

test("the deterministic hypermedia fixture passes the complete StorageAdapter contract", async () => {
  await verifyStorageAdapterContract(() => contractFixture());
});

test("the adapter discovers arbitrary targets and preserves put/delete result order", async () => {
  const fixture = createFixture();
  const first = key("first");
  const second = key("second");
  await fixture.owner.transact(transaction("operation:create-pair", [
    put(first, null, { state: "first" }),
    put(second, null, { state: "second" }),
  ]));

  const changed = transaction("operation:update-pair", [
    { type: "delete", key: first, expectedRevision: 1 },
    put(second, 1, { state: "changed" }),
  ]);
  const result = await fixture.owner.transact(changed);
  assert.equal(result.replayed, false);
  assert.equal(result.records[0], null);
  assert.equal(result.records[1]?.revision, 2);
  assert.equal(await fixture.owner.read(first), null);
  assert.equal((await fixture.owner.read(second))?.value.state, "changed");

  const replay = await fixture.owner.transact(changed);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.records, result.records);
  assert.deepEqual(fixture.service.requests.slice(0, 4), [
    ENTRY_HREF,
    TRANSACT_HREF,
    TRANSACT_HREF,
    `${ORIGIN}/resources/private-records/first`,
  ]);
});

test("idempotency compares canonical JSON while preserving mutation order", async () => {
  const fixture = createFixture();
  const canonicalKey = key("canonical-operation");
  const first = await fixture.owner.transact(transaction("operation:canonical", [
    put(canonicalKey, null, { alpha: 1, beta: 2 }),
  ]));
  const replay = await fixture.owner.transact(transaction("operation:canonical", [
    put(canonicalKey, null, { beta: 2, alpha: 1 }),
  ]));
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.records, first.records);
});

test("quota rejection and an injected failure roll back records and receipts", async () => {
  const fixture = createFixture({ namespaceMaxItems: 1 });
  const existing = key("quota-existing");
  const candidate = key("quota-candidate");
  await fixture.owner.transact(transaction("operation:quota-seed", [
    put(existing, null, { state: "before" }),
  ]));
  const quotaRequest = transaction("operation:quota-atomic", [
    put(existing, 1, { state: "after" }),
    put(candidate, null, { state: "candidate" }),
  ]);

  await assert.rejects(
    () => fixture.owner.transact(quotaRequest),
    (error) => error instanceof StorageFailure && error.code === "UNAVAILABLE",
  );
  assert.deepEqual(fixture.service.failures.at(-1), {
    status: 507,
    document: storageProtocolErrorDocument("quota_exceeded"),
  });
  assert.equal((await fixture.owner.read(existing))?.value.state, "before");
  assert.equal(await fixture.owner.read(candidate), null);

  fixture.service.namespaceMaxItems = 2;
  const appliedAfterQuotaChange = await fixture.owner.transact(quotaRequest);
  assert.equal(appliedAfterQuotaChange.replayed, false);

  const third = key("failure-candidate");
  const failureRequest = transaction("operation:injected-failure", [
    put(existing, 2, { state: "not-committed" }),
    put(third, null, { state: "not-committed" }),
  ]);
  fixture.service.namespaceMaxItems = 3;
  fixture.service.failBeforeCommit = true;
  await assert.rejects(
    () => fixture.owner.transact(failureRequest),
    (error) => error instanceof StorageFailure && error.code === "UNAVAILABLE",
  );
  assert.equal((await fixture.owner.read(existing))?.value.state, "after");
  assert.equal(await fixture.owner.read(third), null);
  assert.equal((await fixture.owner.transact(failureRequest)).replayed, false);
});

test("missing and unauthorized resources have identical wire failures", async () => {
  const fixture = createFixture();
  const existing = key("private-existing");
  const missing = key("private-missing");
  const secret = "private-wire-value";
  await fixture.owner.transact(transaction("operation:private-seed", [
    put(existing, null, { secret }),
  ]));

  const existingRead = await fixture.service.fetch(
    fixture.service.recordHref(existing),
    bearer(OUTSIDER_TOKEN),
  );
  const missingRead = await fixture.service.fetch(
    fixture.service.recordHref(missing),
    bearer(OUTSIDER_TOKEN),
  );
  assert.equal(existingRead.status, 404);
  assert.equal(missingRead.status, 404);
  assert.equal(await existingRead.text(), await missingRead.text());

  const deniedWrite = await fixture.service.fetch(TRANSACT_HREF, {
    ...bearer(OUTSIDER_TOKEN),
    method: "POST",
    body: JSON.stringify(toStorageProtocolTransactionCommand(
      transaction("operation:foreign-existing", [
        put(existing, 1, { secret: "changed" }),
      ]),
    )),
  });
  const absentWrite = await fixture.service.fetch(TRANSACT_HREF, {
    ...bearer(OUTSIDER_TOKEN),
    method: "POST",
    body: JSON.stringify(toStorageProtocolTransactionCommand(
      transaction("operation:foreign-missing", [
        put(missing, 1, { secret: "changed" }),
      ]),
    )),
  });
  const deniedBody = await deniedWrite.text();
  assert.equal(deniedWrite.status, 404);
  assert.equal(absentWrite.status, 404);
  assert.equal(deniedBody, await absentWrite.text());
  for (const privateValue of [secret, existing.id, OWNER_TOKEN, OUTSIDER_TOKEN]) {
    assert.equal(deniedBody.includes(privateValue), false);
  }
});

test("protocol decoders fail closed on oversized, malformed, or mismatched data", () => {
  const recordKey = key("bounded");
  const document = recordDocument(record(recordKey, 1, { value: "too long" }));
  assertStorageFailure(
    () => parseStorageProtocolRecord(document, recordKey, 4),
    "UNAVAILABLE",
  );

  const emptyContinuation = pageDocument(
    new URL(`${LIST_HREF}?collection=${recordKey.collection}&limit=1`),
    recordKey.collection,
    1,
    [],
    "opaque-without-progress",
  );
  assertStorageFailure(
    () => parseStorageProtocolPage(emptyContinuation, {
      collection: recordKey.collection,
      limit: 1,
    }, LIMITS),
    "UNAVAILABLE",
  );

  const protocolFailure = storageFailureFromProtocol(
    storageProtocolErrorStatus("precondition_failed"),
    storageProtocolErrorDocument("precondition_failed"),
  );
  assert.equal(protocolFailure.code, "PRECONDITION_FAILED");
  const forgedFailure = storageFailureFromProtocol(404, {
    ...storageProtocolErrorDocument("not_found"),
    data: { code: "not_found", message: "record private-existing exists" },
  });
  assert.equal(forgedFailure.code, "UNAVAILABLE");
  assert.equal(forgedFailure.message.includes("private-existing"), false);
});

function contractFixture(): StorageAdapterContractFixture {
  const fixture = createFixture();
  return { owner: fixture.owner, outsider: fixture.outsider };
}

function createFixture(
  options: Readonly<{ namespaceMaxItems?: number; namespaceMaxBytes?: number }> = {},
) {
  const service = new DeterministicStorageProtocolService(options);
  return {
    service,
    owner: new HypermediaProtocolAdapter(ENTRY_HREF, OWNER_TOKEN, service.fetch),
    outsider: new HypermediaProtocolAdapter(
      ENTRY_HREF,
      OUTSIDER_TOKEN,
      service.fetch,
    ),
  };
}

type ProtocolFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

class HypermediaProtocolAdapter implements StorageAdapter {
  readonly #entryHref: string;
  readonly #token: string;
  readonly #fetch: ProtocolFetch;
  #discovery?: Promise<StorageProtocolDiscoveryDocument>;

  constructor(entryHref: string, token: string, fetch: ProtocolFetch) {
    this.#entryHref = entryHref;
    this.#token = token;
    this.#fetch = fetch;
  }

  async read(key: StorageKey): Promise<StorageRecord | null> {
    const discovery = await this.discovery();
    const control = requiredProtocolAction(discovery, "read-record");
    const href = control.href
      .replace("{collection}", encodeURIComponent(key.collection))
      .replace("{id}", encodeURIComponent(key.id));
    const response = await this.#fetch(href, bearer(this.#token));
    const body = await responseJson(response, discovery.data.limits.max_record_bytes + 8_192);
    if (response.status === 404) {
      const failure = storageFailureFromProtocol(response.status, body);
      if (failure.code === "NOT_FOUND") return null;
      throw failure;
    }
    if (response.status !== 200) throw storageFailureFromProtocol(response.status, body);
    return parseStorageProtocolRecord(
      body,
      key,
      discovery.data.limits.max_record_bytes,
    );
  }

  async list(request: Parameters<StorageAdapter["list"]>[0]) {
    const discovery = await this.discovery();
    const target = new URL(requiredProtocolAction(discovery, "list-records").href);
    target.searchParams.set("collection", request.collection);
    target.searchParams.set("limit", String(request.limit));
    if (request.cursor !== undefined) target.searchParams.set("cursor", request.cursor);
    const response = await this.#fetch(target, bearer(this.#token));
    const body = await responseJson(
      response,
      discovery.data.limits.max_transaction_bytes,
    );
    if (response.status !== 200) throw storageFailureFromProtocol(response.status, body);
    return parseStorageProtocolPage(body, request, discovery.data.limits);
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    const discovery = await this.discovery();
    const target = requiredProtocolAction(discovery, "transact-records").href;
    const body = JSON.stringify(toStorageProtocolTransactionCommand(request));
    if (byteLength(body) > discovery.data.limits.max_transaction_bytes) {
      throw new StorageFailure("INVALID_REQUEST");
    }
    const response = await this.#fetch(target, {
      ...bearer(this.#token),
      method: "POST",
      headers: {
        ...bearerHeaders(this.#token),
        "content-type": "application/json",
      },
      body,
    });
    const document = await responseJson(
      response,
      discovery.data.limits.max_transaction_bytes,
    );
    if (response.status !== 200) {
      throw storageFailureFromProtocol(response.status, document);
    }
    return parseStorageProtocolTransaction(
      document,
      request,
      discovery.data.limits.max_record_bytes,
    );
  }

  private discovery(): Promise<StorageProtocolDiscoveryDocument> {
    this.#discovery ??= (async () => {
      const response = await this.#fetch(this.#entryHref, bearer(this.#token));
      const body = await responseJson(response, 65_536);
      if (response.status !== 200) {
        throw storageFailureFromProtocol(response.status, body);
      }
      return parseStorageProtocolDiscovery(body, new URL(this.#entryHref).origin);
    })();
    return this.#discovery;
  }
}

class DeterministicStorageProtocolService {
  readonly fetch: ProtocolFetch;
  readonly requests: string[] = [];
  readonly failures: Array<Readonly<{
    status: number;
    document: ReturnType<typeof storageProtocolErrorDocument>;
  }>> = [];
  namespaceMaxItems: number;
  namespaceMaxBytes: number;
  failBeforeCommit = false;

  readonly #records = new Map<string, StorageRecord>();
  readonly #operations = new Map<
    string,
    Readonly<{ fingerprint: string; records: readonly (StorageRecord | null)[] }>
  >();
  readonly #cursors = new Map<
    string,
    Readonly<{ collection: string; limit: number; offset: number }>
  >();
  #cursorSequence = 0;

  constructor(
    options: Readonly<{ namespaceMaxItems?: number; namespaceMaxBytes?: number }> = {},
  ) {
    this.namespaceMaxItems = options.namespaceMaxItems ?? 100;
    this.namespaceMaxBytes = options.namespaceMaxBytes ?? 1_000_000;
    this.fetch = async (input, init = {}) => this.handle(input, init);
  }

  recordHref(key: StorageKey): string {
    return READ_HREF
      .replace("{collection}", encodeURIComponent(key.collection))
      .replace("{id}", encodeURIComponent(key.id));
  }

  private async handle(
    input: string | URL | Request,
    init: RequestInit,
  ): Promise<Response> {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    this.requests.push(url.toString());
    const method = (init.method ?? "GET").toUpperCase();
    if (url.origin !== ORIGIN) return this.failure("not_found");
    if (url.pathname === new URL(ENTRY_HREF).pathname && method === "GET") {
      return protocolResponse(200, discoveryDocument());
    }

    const permitted = new Headers(init.headers).get("authorization") ===
      `Bearer ${OWNER_TOKEN}`;
    const readMatch = /^\/resources\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (readMatch && method === "GET") {
      return this.readRecord(readMatch, permitted);
    }
    if (url.pathname === new URL(LIST_HREF).pathname && method === "GET") {
      return this.listRecords(url, permitted);
    }
    if (url.pathname === new URL(TRANSACT_HREF).pathname && method === "POST") {
      return this.transact(init.body, permitted);
    }
    return this.failure("not_found");
  }

  private readRecord(match: RegExpExecArray, permitted: boolean): Response {
    let parsed: ReturnType<typeof parseStorageKey>;
    try {
      parsed = parseStorageKey(
        decodeURIComponent(match[1] ?? ""),
        decodeURIComponent(match[2] ?? ""),
      );
    } catch {
      return this.failure("invalid_request");
    }
    if (!parsed.ok) return this.failure("invalid_request");
    const stored = this.#records.get(storageKeyString(parsed.value));
    if (!permitted || stored === undefined) return this.failure("not_found");
    return protocolResponse(200, recordDocument(stored));
  }

  private listRecords(url: URL, permitted: boolean): Response {
    const collection = url.searchParams.get("collection");
    const limitText = url.searchParams.get("limit");
    const parsedCollection = parseStorageKey(collection, "placeholder");
    const limit = limitText === null ? Number.NaN : Number(limitText);
    if (
      !parsedCollection.ok ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > LIMITS.max_page_size
    ) {
      return this.failure("invalid_request");
    }
    if (!permitted) {
      return protocolResponse(200, pageDocument(url, collection!, limit, [], null));
    }

    const suppliedCursor = url.searchParams.get("cursor");
    let offset = 0;
    if (suppliedCursor !== null) {
      const cursor = this.#cursors.get(suppliedCursor);
      if (
        cursor === undefined ||
        cursor.collection !== collection ||
        cursor.limit !== limit
      ) {
        return this.failure("invalid_request");
      }
      offset = cursor.offset;
    }
    const all = [...this.#records.values()]
      .filter((item) => item.key.collection === collection)
      .sort((left, right) => left.key.id.localeCompare(right.key.id));
    if (offset > all.length) return this.failure("invalid_request");
    const items = all.slice(offset, offset + limit).map(cloneRequiredRecord);
    const nextOffset = offset + items.length;
    let nextCursor: string | null = null;
    if (nextOffset < all.length) {
      nextCursor = `opaque-cursor-${++this.#cursorSequence}`;
      this.#cursors.set(nextCursor, {
        collection: collection!,
        limit,
        offset: nextOffset,
      });
    }
    return protocolResponse(
      200,
      pageDocument(url, collection!, limit, items, nextCursor),
    );
  }

  private transact(body: BodyInit | null | undefined, permitted: boolean): Response {
    const parsed = parseTransactionBody(body);
    if (parsed instanceof Response) return parsed;
    if (!permitted) return this.failure("not_found");

    const command = toStorageProtocolTransactionCommand(parsed);
    const operationKey = parsed.operationId as string;
    const fingerprint = canonicalJson(command.transaction);
    const prior = this.#operations.get(operationKey);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) return this.failure("conflict");
      return protocolResponse(
        200,
        transactionDocument(parsed, prior.records, true),
      );
    }

    for (const mutation of parsed.mutations) {
      const current = this.#records.get(storageKeyString(mutation.key));
      if (mutation.expectedRevision === null) {
        if (current !== undefined) return this.failure("conflict");
      } else if (
        current === undefined ||
        current.revision !== mutation.expectedRevision
      ) {
        return this.failure("precondition_failed");
      }
      if (
        mutation.type === "put" &&
        byteLength(JSON.stringify(mutation.value)) > LIMITS.max_record_bytes
      ) {
        return this.failure("invalid_request");
      }
    }

    const nextRecords = new Map(this.#records);
    const changed: (StorageRecord | null)[] = [];
    for (const mutation of parsed.mutations) {
      const mapKey = storageKeyString(mutation.key);
      const current = nextRecords.get(mapKey);
      if (mutation.type === "delete") {
        nextRecords.delete(mapKey);
        changed.push(null);
      } else {
        const next = record(
          mutation.key,
          (current?.revision ?? 0) + 1,
          mutation.value,
        );
        nextRecords.set(mapKey, next);
        changed.push(next);
      }
    }
    const usedBytes = [...nextRecords.values()].reduce(
      (sum, item) => sum + byteLength(JSON.stringify(item.value)),
      0,
    );
    if (
      nextRecords.size > this.namespaceMaxItems ||
      usedBytes > this.namespaceMaxBytes
    ) {
      return this.failure("quota_exceeded");
    }
    if (this.failBeforeCommit) {
      this.failBeforeCommit = false;
      return this.failure("unavailable");
    }

    this.#records.clear();
    for (const [keyValue, value] of nextRecords) this.#records.set(keyValue, value);
    const result = changed.map(cloneRecord);
    this.#operations.set(operationKey, {
      fingerprint,
      records: result,
    });
    return protocolResponse(200, transactionDocument(parsed, result, false));
  }

  private failure(code: StorageProtocolErrorCode): Response {
    const status = storageProtocolErrorStatus(code);
    const document = storageProtocolErrorDocument(code);
    this.failures.push({ status, document });
    return protocolResponse(status, document);
  }
}

function discoveryDocument(): StorageProtocolDiscoveryDocument {
  return defineStorageProtocolDiscovery({
    entryHref: ENTRY_HREF,
    readRecordHref: READ_HREF,
    listRecordsHref: LIST_HREF,
    transactRecordsHref: TRANSACT_HREF,
    limits: LIMITS,
  });
}

function recordDocument(recordValue: StorageRecord): StorageProtocolRecordDocument {
  return {
    api_version: AITTADB_HYPERMEDIA_API_VERSION,
    type: "bounded-storage-record",
    id: storageKeyString(recordValue.key),
    data: wireRecord(recordValue),
    links: [],
    actions: [],
  };
}

function pageDocument(
  currentUrl: URL,
  collection: string,
  limit: number,
  records: readonly StorageRecord[],
  nextCursor: string | null,
): StorageProtocolPageDocument {
  const self = currentUrl.toString();
  const next = new URL(currentUrl);
  if (nextCursor !== null) next.searchParams.set("cursor", nextCursor);
  return {
    api_version: AITTADB_HYPERMEDIA_API_VERSION,
    type: "bounded-storage-records-page",
    id: self,
    data: {
      collection,
      page_size: limit,
      items: records.map(wireRecord),
      next_cursor: nextCursor,
    },
    links: [
      { rel: ["self"], href: self, type: AITTADB_HYPERMEDIA_MEDIA_TYPE },
      ...(nextCursor === null
        ? []
        : [{
            rel: ["next"],
            href: next.toString(),
            type: AITTADB_HYPERMEDIA_MEDIA_TYPE,
          } as const]),
    ],
    actions: [],
  };
}

function transactionDocument(
  request: StorageTransactionRequest,
  records: readonly (StorageRecord | null)[],
  replayed: boolean,
): StorageProtocolTransactionDocument {
  return {
    api_version: AITTADB_HYPERMEDIA_API_VERSION,
    type: "bounded-storage-transaction",
    id: request.operationId,
    data: {
      operation_id: request.operationId,
      replayed,
      records: records.map((item) => item === null ? null : wireRecord(item)),
    },
    links: [],
    actions: [],
  };
}

function wireRecord(value: StorageRecord): StorageProtocolWireRecord {
  return {
    key: { ...value.key },
    revision: value.revision,
    value: cloneDocument(value.value),
  };
}

function parseTransactionBody(
  body: BodyInit | null | undefined,
): StorageTransactionRequest | Response {
  if (typeof body !== "string" || byteLength(body) > LIMITS.max_transaction_bytes) {
    return protocolResponse(
      storageProtocolErrorStatus("invalid_request"),
      storageProtocolErrorDocument("invalid_request"),
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    return protocolResponse(
      storageProtocolErrorStatus("invalid_request"),
      storageProtocolErrorDocument("invalid_request"),
    );
  }
  if (!plainObject(value) || !plainObject(value.transaction)) {
    return invalidTransactionResponse();
  }
  const operation = parseStorageOperationId(value.transaction.operation_id);
  if (!operation.ok || !Array.isArray(value.transaction.mutations)) {
    return invalidTransactionResponse();
  }
  const mutations: StorageTransactionRequest["mutations"][number][] = [];
  for (const candidate of value.transaction.mutations) {
    if (!plainObject(candidate) || !plainObject(candidate.key)) {
      return invalidTransactionResponse();
    }
    const parsedKey = parseStorageKey(candidate.key.collection, candidate.key.id);
    if (!parsedKey.ok) return invalidTransactionResponse();
    if (candidate.type === "put") {
      if (
        !validExpectedRevision(candidate.expected_revision, true) ||
        !plainObject(candidate.value)
      ) {
        return invalidTransactionResponse();
      }
      mutations.push({
        type: "put",
        key: parsedKey.value,
        expectedRevision: candidate.expected_revision,
        value: cloneDocument(candidate.value as StorageDocument),
      });
    } else if (
      candidate.type === "delete" &&
      typeof candidate.expected_revision === "number" &&
      validExpectedRevision(candidate.expected_revision, false)
    ) {
      mutations.push({
        type: "delete",
        key: parsedKey.value,
        expectedRevision: candidate.expected_revision,
      });
    } else {
      return invalidTransactionResponse();
    }
  }
  const request: StorageTransactionRequest = {
    operationId: operation.value,
    mutations,
  };
  try {
    assertStorageTransactionBoundary(request);
  } catch {
    return invalidTransactionResponse();
  }
  return request;
}

function invalidTransactionResponse(): Response {
  return protocolResponse(
    storageProtocolErrorStatus("invalid_request"),
    storageProtocolErrorDocument("invalid_request"),
  );
}

function validExpectedRevision(
  value: unknown,
  allowNull: boolean,
): value is number | null {
  return (allowNull && value === null) ||
    (Number.isSafeInteger(value) && (value as number) >= 1);
}

function protocolResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE },
  });
}

async function responseJson(response: Response, maxBytes: number): Promise<unknown> {
  if (response.headers.get("content-type") !== AITTADB_HYPERMEDIA_MEDIA_TYPE) {
    throw new StorageFailure("UNAVAILABLE");
  }
  const text = await response.text();
  if (byteLength(text) > maxBytes) throw new StorageFailure("UNAVAILABLE");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new StorageFailure("UNAVAILABLE");
  }
}

function requiredProtocolAction(
  document: StorageProtocolDiscoveryDocument,
  name: StorageProtocolAction["name"],
): StorageProtocolAction {
  const found = document.actions.find((candidate) => candidate.name === name);
  if (found === undefined) throw new StorageFailure("UNAVAILABLE");
  return found;
}

function bearer(token: string): RequestInit {
  return { headers: bearerHeaders(token) };
}

function bearerHeaders(token: string): Record<string, string> {
  return {
    accept: AITTADB_HYPERMEDIA_MEDIA_TYPE,
    authorization: `Bearer ${token}`,
  };
}

function key(id: string): StorageKey {
  const parsed = parseStorageKey("private-records", id);
  assert(parsed.ok);
  return parsed.value;
}

function operationId(value: string): StorageTransactionRequest["operationId"] {
  const parsed = parseStorageOperationId(value);
  assert(parsed.ok);
  return parsed.value;
}

function put(
  recordKey: StorageKey,
  expectedRevision: number | null,
  value: StorageDocument,
): StorageTransactionRequest["mutations"][number] {
  return { type: "put", key: recordKey, expectedRevision, value };
}

function transaction(
  operation: string,
  mutations: StorageTransactionRequest["mutations"],
): StorageTransactionRequest {
  return { operationId: operationId(operation), mutations };
}

function record(
  recordKey: StorageKey,
  revision: number,
  value: StorageDocument,
): StorageRecord {
  return Object.freeze({
    key: Object.freeze({ ...recordKey }),
    revision,
    value: deepFreeze(cloneDocument(value)),
  });
}

function cloneRecord(value: StorageRecord | null): StorageRecord | null {
  return value === null ? null : record(value.key, value.revision, value.value);
}

function cloneRequiredRecord(value: StorageRecord): StorageRecord {
  return record(value.key, value.revision, value.value);
}

function cloneDocument(value: StorageDocument): StorageDocument {
  return JSON.parse(JSON.stringify(value)) as StorageDocument;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!plainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, child]) => [name, canonicalValue(child)]),
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function assertStorageFailure(
  operation: () => unknown,
  code: StorageFailure["code"],
): void {
  assert.throws(
    operation,
    (error) => error instanceof StorageFailure && error.code === code,
  );
}
