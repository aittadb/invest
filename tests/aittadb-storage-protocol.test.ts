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
  normalizeStorageTransactionRequest,
  parseStorageKey,
  parseStorageOperationId,
  storageKeyString,
  type StorageDocument,
  type StorageKey,
  type StorageRecord,
  type StorageTransactionRequest,
} from "../domain/storage-adapter.ts";
import {
  AittaDBStorageAdapter,
  type AittaDBStorageAdapterDependencies,
} from "../repositories/aittadb-storage-adapter.ts";
import {
  verifyStorageAdapterContract,
  type StorageAdapterContractFixture,
} from "./support/storage-adapter-contract.ts";

const ORIGIN = "https://storage.protocol.example";
const ENTRY_HREF = `${ORIGIN}/entry/records`;
const READ_HREF = `${ORIGIN}/resources/{collection}/{id}`;
const LIST_HREF = `${ORIGIN}/pages/records`;
const TRANSACT_HREF = `${ORIGIN}/operations/atomic-records`;
const TRANSPORT_ORIGIN = "https://storage-transport.example";
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
    "storage.read",
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
        "One operation_id and an ordered mutations array of compare-and-set put, delete, or non-mutating check entries.",
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
  const missingCheck = {
    ...document,
    data: {
      ...document.data,
      capabilities: document.data.capabilities.filter(
        (capability) => capability !== "atomic-read-revision-check",
      ),
    },
  };
  assertStorageFailure(
    () => parseStorageProtocolDiscovery(missingCheck, ORIGIN),
    "UNAVAILABLE",
  );
  const malformedCheckShape = {
    ...document,
    data: {
      ...document.data,
      transaction_shape: {
        ...document.data.transaction_shape,
        mutations: {
          ...document.data.transaction_shape.mutations,
          check: "best-effort",
        },
      },
    },
  };
  assertStorageFailure(
    () => parseStorageProtocolDiscovery(malformedCheckShape, ORIGIN),
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

test("unsupported check discovery fails before the adapter sends a transaction", async () => {
  const unsupported = discoveryDocument();
  const malformed = {
    ...unsupported,
    data: {
      ...unsupported.data,
      capabilities: unsupported.data.capabilities.filter(
        (capability) => capability !== "atomic-read-revision-check",
      ),
    },
  };
  let calls = 0;
  const adapter = new AittaDBStorageAdapter({
    issuer: ORIGIN,
    entryHref: ENTRY_HREF,
    accessToken: () => OWNER_TOKEN,
    async fetch() {
      calls += 1;
      return protocolResponse(200, malformed);
    },
  });

  await assert.rejects(
    () => adapter.transact(transaction("operation:unsupported-check", [
      check(key("unsupported-check"), null),
    ])),
    unavailableStorageFailure,
  );
  assert.equal(calls, 1);
});

test("the adapter discovers arbitrary targets and preserves put/check/delete result order", async () => {
  const fixture = createFixture();
  const first = key("first");
  const second = key("second");
  await fixture.owner.transact(transaction("operation:create-pair", [
    put(first, null, { state: "first" }),
    put(second, null, { state: "second" }),
  ]));

  const changed = transaction("operation:update-pair", [
    check(second, 1),
    { type: "delete", key: first, expectedRevision: 1 },
    put(key("third"), null, { state: "changed" }),
  ]);
  const result = await fixture.owner.transact(changed);
  assert.equal(result.replayed, false);
  assert.deepEqual(result.records[0], record(second, 1, { state: "second" }));
  assert.equal(result.records[1], null);
  assert.equal(result.records[2]?.revision, 1);
  assert.equal(await fixture.owner.read(first), null);
  assert.equal((await fixture.owner.read(second))?.value.state, "second");

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

test("pagination uses deterministic code-unit ordering", async () => {
  const fixture = createFixture();
  const ids = ["sort-a", "sort-A", "sort_0", "sort-0"];
  for (const [index, id] of ids.entries()) {
    await fixture.owner.transact(transaction(`operation:${id}`, [
      put(key(id), null, { index }),
    ]));
  }

  const page = await fixture.owner.list({
    collection: key("sort-a").collection,
    limit: ids.length,
  });
  assert.deepEqual(
    page.items.map((item) => item.key.id),
    [...ids].sort(compareCodeUnits),
  );
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
  assert.deepEqual(await fixture.outsider.list({
    collection: existing.collection,
    limit: 10,
  }), { items: [], nextCursor: null });

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
    }, LIMITS, `${LIST_HREF}?collection=${recordKey.collection}&limit=1`),
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

test("check commands encode exactly and malformed ordered evidence fails closed", () => {
  const existing = key("decode-check-existing");
  const missing = key("decode-check-missing");
  const request = transaction("operation:decode-check", [
    check(existing, 3),
    check(missing, null),
  ]);
  assert.deepEqual(toStorageProtocolTransactionCommand(request), {
    transaction: {
      operation_id: "operation:decode-check",
      mutations: [
        {
          type: "check",
          key: { collection: "private-records", id: "decode-check-existing" },
          expected_revision: 3,
        },
        {
          type: "check",
          key: { collection: "private-records", id: "decode-check-missing" },
          expected_revision: null,
        },
      ],
    },
  });

  const existingRecord = record(existing, 3, { state: "unchanged" });
  assert.deepEqual(
    parseStorageProtocolTransaction(
      transactionDocument(request, [existingRecord, null], false),
      request,
      LIMITS.max_record_bytes,
    ),
    { replayed: false, records: [existingRecord, null] },
  );

  const malformedRecords = [
    [null, null],
    [record(existing, 2, { state: "stale" }), null],
    [record(key("decode-check-wrong-key"), 3, { state: "wrong" }), null],
    [existingRecord, record(missing, 1, { state: "present" })],
    [{ key: existing, revision: 3, value: [] }, null],
    [{ ...existingRecord, unexpected: true }, null],
  ] as const;
  for (const records of malformedRecords) {
    const document = {
      ...transactionDocument(request, [existingRecord, null], false),
      data: {
        ...transactionDocument(request, [existingRecord, null], false).data,
        records,
      },
    };
    assertStorageFailure(
      () => parseStorageProtocolTransaction(
        document,
        request,
        LIMITS.max_record_bytes,
      ),
      "UNAVAILABLE",
    );
  }
});

test("positive checks receive a bounded full-record response budget", async () => {
  const limits = Object.freeze({
    ...LIMITS,
    max_record_bytes: 100_000,
    max_transaction_bytes: 1_024,
  });
  const discovery = defineStorageProtocolDiscovery({
    entryHref: ENTRY_HREF,
    readRecordHref: READ_HREF,
    listRecordsHref: LIST_HREF,
    transactRecordsHref: TRANSACT_HREF,
    limits,
  });
  const checkedKey = key("large-check-result");
  const request = transaction("operation:large-check-result", [
    check(checkedKey, 9),
  ]);
  const checked = record(checkedKey, 9, { payload: "x".repeat(90_000) });
  const accepted = responseHarness([
    protocolResponse(200, discovery),
    protocolResponse(200, transactionDocument(request, [checked], false)),
  ]);
  const result = await accepted.adapter.transact(request);
  assert.equal(result.records[0]?.value.payload, checked.value.payload);

  const oversized = record(checkedKey, 9, {
    payload: "x".repeat(limits.max_record_bytes + 1),
  });
  const rejected = responseHarness([
    protocolResponse(200, discovery),
    protocolResponse(200, transactionDocument(request, [oversized], false)),
  ]);
  await assert.rejects(
    () => rejected.adapter.transact(request),
    unavailableStorageFailure,
  );
});

test("the adapter maps only backend transport while preserving logical hypermedia identity", async () => {
  const service = new DeterministicStorageProtocolService();
  const captured: Request[] = [];
  let tokenCalls = 0;
  const adapter = new AittaDBStorageAdapter({
    issuer: ORIGIN,
    entryHref: ENTRY_HREF,
    transportOrigin: TRANSPORT_ORIGIN,
    accessToken() {
      tokenCalls += 1;
      return OWNER_TOKEN;
    },
    async fetch(input, init) {
      const request = new Request(input, init);
      captured.push(request);
      const physical = new URL(request.url);
      assert.equal(physical.origin, TRANSPORT_ORIGIN);
      const logical = new URL(physical.href);
      const issuer = new URL(ORIGIN);
      logical.protocol = issuer.protocol;
      logical.host = issuer.host;
      return service.fetch(logical.href, init);
    },
  });

  const created = await adapter.transact(transaction("operation:transport", [
    put(key("transport"), null, { state: "stored" }),
  ]));
  assert.equal(created.records[0]?.value.state, "stored");
  assert.equal(tokenCalls, 2);
  assert.deepEqual(
    captured.map((request) => request.url),
    [
      `${TRANSPORT_ORIGIN}/entry/records`,
      `${TRANSPORT_ORIGIN}/operations/atomic-records`,
    ],
  );
  for (const request of captured) {
    assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("accept"), AITTADB_HYPERMEDIA_MEDIA_TYPE);
    assert.equal(request.headers.get("authorization"), `Bearer ${OWNER_TOKEN}`);
    assert.equal(request.headers.get("cache-control"), "no-store");
    assert.equal(request.url.includes(OWNER_TOKEN), false);
  }
  assert.equal(captured[0]?.headers.get("content-type"), null);
  assert.equal(captured[1]?.headers.get("content-type"), "application/json");
  assert.deepEqual(service.requests, [ENTRY_HREF, TRANSACT_HREF]);
});

test("constructor accepts only explicit canonical same-issuer boundaries", () => {
  const privateValue = "private-runtime-boundary";
  const base: AittaDBStorageAdapterDependencies = {
    issuer: ORIGIN,
    entryHref: ENTRY_HREF,
    accessToken: () => OWNER_TOKEN,
    fetch: async () => protocolResponse(200, discoveryDocument()),
  };
  const cases: readonly Record<string, unknown>[] = [
    { issuer: `${ORIGIN}/oauth` },
    { issuer: `${ORIGIN}?${privateValue}=1` },
    { entryHref: "https://foreign.example/entry" },
    { entryHref: `${ENTRY_HREF}?${privateValue}=1` },
    { transportOrigin: `${TRANSPORT_ORIGIN}/backend` },
    { transportOrigin: `https://user@storage-transport.example` },
    { accessToken: privateValue },
    { fetch: privateValue },
    { requestTimeoutMs: 9 },
    { requestTimeoutMs: 60_001 },
    { requestTimeoutMs: Number.NaN },
  ];

  for (const overrides of cases) {
    assert.throws(
      () => new AittaDBStorageAdapter({
        ...base,
        ...overrides,
      } as AittaDBStorageAdapterDependencies),
      (error: unknown) => {
        assert.equal(
          error instanceof StorageFailure && error.code === "UNAVAILABLE",
          true,
        );
        assert.equal(String(error).includes(privateValue), false);
        return true;
      },
    );
  }
});

test("advertised actions cannot smuggle undeclared base query values", async () => {
  const discovery = defineStorageProtocolDiscovery({
    entryHref: ENTRY_HREF,
    readRecordHref: `${READ_HREF}?private=transport-value`,
    listRecordsHref: LIST_HREF,
    transactRecordsHref: TRANSACT_HREF,
    limits: LIMITS,
  });
  const harness = responseHarness([protocolResponse(200, discovery)]);
  await assert.rejects(
    () => harness.adapter.read(key("query-control")),
    unavailableStorageFailure,
  );
  assert.equal(harness.calls(), 1);
});

test("redirects, media, declarations, streams, encoding, and JSON fail closed", async (t) => {
  const discoveryFailures: readonly Readonly<{
    name: string;
    response: () => Response;
  }>[] = [
    {
      name: "redirect",
      response: () => new Response(null, {
        status: 302,
        headers: { location: "https://foreign.example/redirect" },
      }),
    },
    {
      name: "already followed response",
      response: () => responseWithMetadata(
        protocolResponse(200, discoveryDocument()),
        { redirected: true },
      ),
    },
    {
      name: "mismatched final URL",
      response: () => responseWithMetadata(
        protocolResponse(200, discoveryDocument()),
        { url: "https://foreign.example/final" },
      ),
    },
    {
      name: "wrong media type",
      response: () => new Response(JSON.stringify(discoveryDocument()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    },
    {
      name: "oversized declaration",
      response: () => new Response("{}", {
        status: 200,
        headers: {
          "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE,
          "content-length": "65537",
        },
      }),
    },
    {
      name: "malformed declaration",
      response: () => new Response("{}", {
        status: 200,
        headers: {
          "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE,
          "content-length": "private",
        },
      }),
    },
    {
      name: "oversized stream",
      response: () => new Response("x".repeat(65_537), {
        status: 200,
        headers: { "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE },
      }),
    },
    {
      name: "missing body",
      response: () => new Response(null, {
        status: 200,
        headers: { "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE },
      }),
    },
    {
      name: "locked body",
      response: () => {
        const response = protocolResponse(200, discoveryDocument());
        response.body?.getReader();
        return response;
      },
    },
    {
      name: "invalid UTF-8",
      response: () => new Response(new Uint8Array([0xc3, 0x28]), {
        status: 200,
        headers: { "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE },
      }),
    },
    {
      name: "malformed JSON",
      response: () => new Response("{", {
        status: 200,
        headers: { "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE },
      }),
    },
  ];

  for (const current of discoveryFailures) {
    await t.test(current.name, async () => {
      const harness = responseHarness([current.response()]);
      await assert.rejects(
        () => harness.adapter.read(key("bounded-response")),
        unavailableStorageFailure,
      );
      assert.equal(harness.calls(), 1);
    });
  }

  for (const current of [
    {
      name: "redirect body cancellation",
      status: 302,
      metadata: {},
    },
    {
      name: "followed body cancellation",
      status: 200,
      metadata: { redirected: true },
    },
    {
      name: "mismatched final URL body cancellation",
      status: 200,
      metadata: { url: "https://foreign.example/final" },
    },
  ] as const) {
    await t.test(current.name, async () => {
      let canceled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      });
      const response = responseWithMetadata(
        new Response(body, {
          status: current.status,
          headers: { "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE },
        }),
        current.metadata,
      );
      const harness = responseHarness([response]);
      await assert.rejects(
        () => harness.adapter.read(key("cancel-redirect-response")),
        unavailableStorageFailure,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(canceled, true);
    });
  }

  for (const current of [
    {
      name: "wrong media cancellation",
      headers: new Headers({ "content-type": "application/json" }),
    },
    {
      name: "oversized declaration cancellation",
      headers: new Headers({
        "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE,
        "content-length": "65537",
      }),
    },
    {
      name: "malformed declaration cancellation",
      headers: new Headers({
        "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE,
        "content-length": "private",
      }),
    },
  ]) {
    await t.test(current.name, async () => {
      let canceled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      });
      const harness = responseHarness([
        new Response(body, { status: 200, headers: current.headers }),
      ]);
      await assert.rejects(
        () => harness.adapter.read(key("cancel-rejected-response")),
        unavailableStorageFailure,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(canceled, true);
    });
  }

  await t.test("oversized record response", async () => {
    const maximum = LIMITS.max_record_bytes + 65_536;
    const harness = responseHarness([
      protocolResponse(200, discoveryDocument()),
      new Response("{}", {
        status: 200,
        headers: {
          "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE,
          "content-length": String(maximum + 1),
        },
      }),
    ]);
    await assert.rejects(
      () => harness.adapter.read(key("oversized-record-response")),
      unavailableStorageFailure,
    );
    assert.equal(harness.calls(), 2);
  });

  await t.test("oversized error response", async () => {
    const harness = responseHarness([
      protocolResponse(200, discoveryDocument()),
      new Response("x".repeat(16_385), {
        status: 503,
        headers: { "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE },
      }),
    ]);
    await assert.rejects(
      () => harness.adapter.read(key("oversized-error-response")),
      unavailableStorageFailure,
    );
    assert.equal(harness.calls(), 2);
  });

  await t.test("foreign page identity", async () => {
    const request = {
      collection: key("foreign-page").collection,
      limit: 1,
    } as const;
    const foreign = new URL(
      `https://foreign.example/pages?collection=${request.collection}&limit=1`,
    );
    const harness = responseHarness([
      protocolResponse(200, discoveryDocument()),
      protocolResponse(
        200,
        pageDocument(foreign, request.collection, request.limit, [], null),
      ),
    ]);
    await assert.rejects(
      () => harness.adapter.list(request),
      unavailableStorageFailure,
    );
    assert.equal(harness.calls(), 2);
  });

  await t.test("unexpected decoder recursion", async () => {
    const recordKey = key("deep-protocol-value");
    const nested = `${"[".repeat(12_000)}null${"]".repeat(12_000)}`;
    const body = `{"api_version":"${AITTADB_HYPERMEDIA_API_VERSION}","type":"bounded-storage-record","id":"deep","data":{"key":{"collection":"${recordKey.collection}","id":"${recordKey.id}"},"revision":1,"value":{"deep":${nested}}},"links":[],"actions":[]}`;
    const harness = responseHarness([
      protocolResponse(200, discoveryDocument()),
      new Response(body, {
        status: 200,
        headers: { "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE },
      }),
    ]);
    await assert.rejects(
      () => harness.adapter.read(recordKey),
      unavailableStorageFailure,
    );
    assert.equal(harness.calls(), 2);
  });
});

test("token, fetch, and streamed response work stay time and chunk bounded", async (t) => {
  await t.test("token wait", async () => {
    let calls = 0;
    const adapter = new AittaDBStorageAdapter({
      issuer: ORIGIN,
      entryHref: ENTRY_HREF,
      requestTimeoutMs: 10,
      accessToken: () => new Promise<string>(() => undefined),
      async fetch() {
        calls += 1;
        return protocolResponse(200, discoveryDocument());
      },
    });
    await assert.rejects(
      () => adapter.read(key("stalled-token")),
      unavailableStorageFailure,
    );
    assert.equal(calls, 0);
  });

  await t.test("fetch wait", async () => {
    const adapter = new AittaDBStorageAdapter({
      issuer: ORIGIN,
      entryHref: ENTRY_HREF,
      requestTimeoutMs: 10,
      accessToken: () => OWNER_TOKEN,
      fetch: () => new Promise<Response>(() => undefined),
    });
    await assert.rejects(
      () => adapter.read(key("stalled-fetch")),
      unavailableStorageFailure,
    );
  });

  await t.test("stream wait", async () => {
    let cancelled = false;
    const adapter = new AittaDBStorageAdapter({
      issuer: ORIGIN,
      entryHref: ENTRY_HREF,
      requestTimeoutMs: 10,
      accessToken: () => OWNER_TOKEN,
      async fetch() {
        return new Response(new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(() => undefined),
          cancel() {
            cancelled = true;
          },
        }), {
          status: 200,
          headers: { "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE },
        });
      },
    });
    await assert.rejects(
      () => adapter.read(key("stalled-stream")),
      unavailableStorageFailure,
    );
    assert.equal(cancelled, true);
  });

  await t.test("fragmented stream", async () => {
    let chunks = 0;
    let cancelled = false;
    const adapter = new AittaDBStorageAdapter({
      issuer: ORIGIN,
      entryHref: ENTRY_HREF,
      requestTimeoutMs: 1_000,
      accessToken: () => OWNER_TOKEN,
      async fetch() {
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            chunks += 1;
            controller.enqueue(Uint8Array.of(0x20));
          },
          cancel() {
            cancelled = true;
          },
        }), {
          status: 200,
          headers: { "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE },
        });
      },
    });
    await assert.rejects(
      () => adapter.read(key("fragmented-stream")),
      unavailableStorageFailure,
    );
    assert.equal(chunks >= 4_097 && chunks <= 4_098, true);
    assert.equal(cancelled, true);
  });
});

test("failed discovery clears its cache and concurrent discovery is coalesced", async () => {
  const service = new DeterministicStorageProtocolService();
  let discoveryCalls = 0;
  let tokenCalls = 0;
  let rejectFirstDiscovery = true;
  const adapter = new AittaDBStorageAdapter({
    issuer: ORIGIN,
    entryHref: ENTRY_HREF,
    accessToken() {
      tokenCalls += 1;
      return OWNER_TOKEN;
    },
    async fetch(input, init) {
      if (String(input) === ENTRY_HREF) {
        discoveryCalls += 1;
        if (rejectFirstDiscovery) {
          rejectFirstDiscovery = false;
          return protocolResponse(503, storageProtocolErrorDocument("unavailable"));
        }
      }
      return service.fetch(input, init);
    },
  });

  await assert.rejects(
    () => adapter.read(key("first-discovery-failure")),
    unavailableStorageFailure,
  );
  assert.equal(await adapter.read(key("retry-after-discovery-failure")), null);
  assert.equal(discoveryCalls, 2);

  const beforeConcurrentTokens = tokenCalls;
  assert.deepEqual(
    await Promise.all([
      adapter.read(key("concurrent-one")),
      adapter.read(key("concurrent-two")),
    ]),
    [null, null],
  );
  assert.equal(discoveryCalls, 2);
  assert.equal(tokenCalls - beforeConcurrentTokens, 2);

  const failureService = new DeterministicStorageProtocolService();
  let failConcurrently = true;
  let failureDiscoveryCalls = 0;
  const concurrentFailure = new AittaDBStorageAdapter({
    issuer: ORIGIN,
    entryHref: ENTRY_HREF,
    accessToken: () => OWNER_TOKEN,
    async fetch(input, init) {
      if (String(input) === ENTRY_HREF) {
        failureDiscoveryCalls += 1;
        if (failConcurrently) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return protocolResponse(
            400,
            storageProtocolErrorDocument("invalid_request"),
          );
        }
      }
      return failureService.fetch(input, init);
    },
  });
  const concurrentFailures = await Promise.allSettled([
    concurrentFailure.read(key("concurrent-failure-one")),
    concurrentFailure.read(key("concurrent-failure-two")),
  ]);
  assert.equal(concurrentFailures.every((result) =>
    result.status === "rejected" && unavailableStorageFailure(result.reason)
  ), true);
  assert.equal(failureDiscoveryCalls, 1);
  failConcurrently = false;
  assert.equal(await concurrentFailure.read(key("after-concurrent-failure")), null);
  assert.equal(failureDiscoveryCalls, 2);

  const freshService = new DeterministicStorageProtocolService();
  let freshDiscoveryCalls = 0;
  const fresh = new AittaDBStorageAdapter({
    issuer: ORIGIN,
    entryHref: ENTRY_HREF,
    accessToken: () => OWNER_TOKEN,
    async fetch(input, init) {
      if (String(input) === ENTRY_HREF) freshDiscoveryCalls += 1;
      return freshService.fetch(input, init);
    },
  });
  assert.deepEqual(
    await Promise.all([
      fresh.read(key("coalesced-one")),
      fresh.read(key("coalesced-two")),
    ]),
    [null, null],
  );
  assert.equal(freshDiscoveryCalls, 1);
});

test("request boundaries fail before unsafe transport and honor discovered limits", async () => {
  let calls = 0;
  const adapter = new AittaDBStorageAdapter({
    issuer: ORIGIN,
    entryHref: ENTRY_HREF,
    accessToken: () => OWNER_TOKEN,
    async fetch() {
      calls += 1;
      return protocolResponse(200, discoveryDocument());
    },
  });

  await assert.rejects(
    () => adapter.read({ collection: "INVALID", id: "bad id" } as StorageKey),
    invalidStorageRequest,
  );
  await assert.rejects(
    () => adapter.list({ collection: "INVALID", limit: 1 } as Parameters<typeof adapter.list>[0]),
    invalidStorageRequest,
  );
  await assert.rejects(
    () => adapter.transact({
      operationId: "bad operation id",
      mutations: [put(key("bad-operation"), null, { value: 1 })],
    } as unknown as StorageTransactionRequest),
    invalidStorageRequest,
  );
  await assert.rejects(
    () => adapter.transact(transaction("operation:bad-check-revision", [
      check(key("bad-check-revision"), 0),
    ])),
    invalidStorageRequest,
  );
  await assert.rejects(
    () => adapter.transact({
      operationId: operationId("operation:decorated-check"),
      mutations: [{
        type: "check",
        key: key("decorated-check"),
        expectedRevision: null,
        value: { forbidden: true },
      }],
    } as unknown as StorageTransactionRequest),
    invalidStorageRequest,
  );
  const duplicateCheckKey = key("duplicate-check-key");
  await assert.rejects(
    () => adapter.transact(transaction("operation:duplicate-check-key", [
      check(duplicateCheckKey, null),
      put(duplicateCheckKey, null, { forbidden: true }),
    ])),
    invalidStorageRequest,
  );
  const overriddenMutations = [
    put(key("must-remain-put"), null, { value: 1 }),
  ];
  Object.defineProperty(overriddenMutations, "map", {
    configurable: true,
    value: () => [{
      type: "delete",
      key: key("must-remain-put"),
      expectedRevision: 1,
    }],
  });
  await assert.rejects(
    () => adapter.transact({
      operationId: operationId("operation:overridden-map"),
      mutations: overriddenMutations,
    }),
    invalidStorageRequest,
  );
  let operationGetterCalls = 0;
  const accessorRequest = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(accessorRequest, {
    operationId: {
      enumerable: true,
      get() {
        operationGetterCalls += 1;
        return operationId("operation:accessor");
      },
    },
    mutations: {
      enumerable: true,
      value: [put(key("accessor"), null, { value: 1 })],
    },
  });
  await assert.rejects(
    () => adapter.transact(
      accessorRequest as unknown as StorageTransactionRequest,
    ),
    invalidStorageRequest,
  );
  assert.equal(operationGetterCalls, 0);
  await assert.rejects(
    () => adapter.transact({
      operationId: operationId("operation:bad-discriminator"),
      mutations: [{
        type: "unexpected",
        key: key("must-not-delete"),
        expectedRevision: 1,
      }],
    } as unknown as StorageTransactionRequest),
    invalidStorageRequest,
  );
  await assert.rejects(
    () => adapter.transact({
      operationId: operationId("operation:bad-key"),
      mutations: [{
        type: "delete",
        key: { collection: "INVALID", id: "bad id" },
        expectedRevision: 1,
      }],
    } as unknown as StorageTransactionRequest),
    invalidStorageRequest,
  );
  await assert.rejects(
    () => adapter.transact(transaction("operation:non-finite", [
      put(key("non-finite"), null, { value: Number.NaN }),
    ])),
    invalidStorageRequest,
  );
  await assert.rejects(
    () => adapter.transact(transaction("operation:global-oversize", [
      put(key("global-oversize"), null, { value: "x".repeat(1_100_000) }),
    ])),
    invalidStorageRequest,
  );
  assert.equal(calls, 0);

  await assert.rejects(
    () => adapter.list({
      collection: key("cursor").collection,
      limit: 1,
      cursor: "x".repeat(LIMITS.max_cursor_length + 1) as Parameters<
        typeof adapter.list
      >[0]["cursor"],
    }),
    invalidStorageRequest,
  );
  assert.equal(calls, 1);

  await assert.rejects(
    () => adapter.transact(transaction("operation:record-oversize", [
      put(key("record-oversize"), null, { value: "x".repeat(5_000) }),
    ])),
    invalidStorageRequest,
  );
  assert.equal(calls, 1);

  await assert.rejects(
    () => adapter.transact(transaction("operation:advertised-oversize", [
      put(key("advertised-oversize"), null, { value: "x".repeat(70_000) }),
    ])),
    invalidStorageRequest,
  );
  assert.equal(calls, 1);
});

test("tokens and private transport failures never enter adapter errors", async () => {
  const secrets = [
    "private-token-provider-failure",
    "private-fetch-token",
    "private-response-body",
    "private invalid token",
  ] as const;
  const adapters = [
    new AittaDBStorageAdapter({
      issuer: ORIGIN,
      entryHref: ENTRY_HREF,
      accessToken() {
        throw new Error(secrets[0]);
      },
      fetch: async () => assert.fail("Token failure must precede fetch."),
    }),
    new AittaDBStorageAdapter({
      issuer: ORIGIN,
      entryHref: ENTRY_HREF,
      accessToken: () => secrets[1],
      fetch: async () => {
        throw new Error(secrets[1]);
      },
    }),
    new AittaDBStorageAdapter({
      issuer: ORIGIN,
      entryHref: ENTRY_HREF,
      accessToken: () => OWNER_TOKEN,
      fetch: async () => protocolResponse(200, { private: secrets[2] }),
    }),
    new AittaDBStorageAdapter({
      issuer: ORIGIN,
      entryHref: ENTRY_HREF,
      accessToken: () => secrets[3],
      fetch: async () => assert.fail("Invalid bearer token must precede fetch."),
    }),
  ];

  for (const adapter of adapters) {
    await assert.rejects(
      () => adapter.read(key("redaction")),
      (error: unknown) => {
        assert.equal(unavailableStorageFailure(error), true);
        const serialized = `${String(error)}\n${JSON.stringify(error)}\n${JSON.stringify(adapter)}`;
        for (const secret of secrets) assert.equal(serialized.includes(secret), false);
        return true;
      },
    );
  }
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
    owner: new AittaDBStorageAdapter({
      issuer: ORIGIN,
      entryHref: ENTRY_HREF,
      accessToken: () => OWNER_TOKEN,
      fetch: service.fetch,
    }),
    outsider: new AittaDBStorageAdapter({
      issuer: ORIGIN,
      entryHref: ENTRY_HREF,
      accessToken: () => OUTSIDER_TOKEN,
      fetch: service.fetch,
    }),
  };
}

type ProtocolFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

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
      .sort((left, right) => compareCodeUnits(left.key.id, right.key.id));
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
      if (mutation.type === "check") {
        if (
          mutation.expectedRevision === null
            ? current !== undefined
            : current?.revision !== mutation.expectedRevision
        ) {
          return this.failure("precondition_failed");
        }
      } else if (mutation.expectedRevision === null) {
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
      if (mutation.type === "check") {
        changed.push(cloneRecord(current ?? null));
        continue;
      }
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
    } else if (
      candidate.type === "check" &&
      validExpectedRevision(candidate.expected_revision, true)
    ) {
      mutations.push({
        type: "check",
        key: parsedKey.value,
        expectedRevision: candidate.expected_revision,
      });
    } else {
      return invalidTransactionResponse();
    }
  }
  try {
    return normalizeStorageTransactionRequest({
      operationId: operation.value,
      mutations,
    });
  } catch {
    return invalidTransactionResponse();
  }
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

function responseHarness(responses: readonly Response[]) {
  const pending = [...responses];
  let calls = 0;
  const adapter = new AittaDBStorageAdapter({
    issuer: ORIGIN,
    entryHref: ENTRY_HREF,
    accessToken: () => OWNER_TOKEN,
    async fetch() {
      calls += 1;
      const next = pending.shift();
      if (next === undefined) throw new Error("Missing synthetic response.");
      return next;
    },
  });
  return Object.freeze({ adapter, calls: () => calls });
}

function responseWithMetadata(
  response: Response,
  metadata: Readonly<{ redirected?: boolean; url?: string }>,
): Response {
  for (const [name, value] of Object.entries(metadata)) {
    Object.defineProperty(response, name, { value });
  }
  return response;
}

function unavailableStorageFailure(error: unknown): boolean {
  return error instanceof StorageFailure && error.code === "UNAVAILABLE";
}

function invalidStorageRequest(error: unknown): boolean {
  return error instanceof StorageFailure && error.code === "INVALID_REQUEST";
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

function check(
  recordKey: StorageKey,
  expectedRevision: number | null,
): StorageTransactionRequest["mutations"][number] {
  return { type: "check", key: recordKey, expectedRevision };
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
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([name, child]) => [name, canonicalValue(child)]),
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
