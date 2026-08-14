import assert from "node:assert/strict";
import test from "node:test";

import {
  StorageFailure,
  parseStorageKey,
  parseStorageOperationId,
  type StorageAdapter,
  type StorageCollection,
  type StorageDocument,
  type StorageKey,
  type StoragePage,
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import {
  MAX_STAGED_STORAGE_TRANSACTION_BYTES,
  StagedStorageTransaction,
} from "../repositories/staged-storage-transaction.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";

test("stages checks, puts, and deletes without durable work before commit", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const update = key("records", "record:update");
  const checked = key("records", "record:checked");
  const removed = key("records", "record:removed");
  const created = key("records", "record:created");
  await seed(storage, [update, checked, removed]);

  const staged = new StagedStorageTransaction(
    storage,
    operation("operation:staged-complete"),
  );
  const checkResult = await staged.transact({
    operationId: operation("operation:staged-complete"),
    mutations: [{ type: "check", key: checked, expectedRevision: 1 }],
  });
  assert.equal(checkResult.replayed, false);
  assert.equal(checkResult.records[0]?.revision, 1);

  const mutationResult = await staged.transact({
    operationId: operation("operation:staged-complete"),
    mutations: [
      { type: "put", key: update, expectedRevision: 1, value: document("next") },
      { type: "put", key: created, expectedRevision: null, value: document("new") },
      { type: "delete", key: removed, expectedRevision: 1 },
    ],
  });
  assert.deepEqual(
    mutationResult.records.map((record) => record?.revision ?? null),
    [2, 1, null],
  );
  assert.equal((await staged.read(update))?.value.label, "next");
  assert.equal(await staged.read(removed), null);

  assert.equal((await storage.read(update))?.value.label, "seed");
  assert.equal(await storage.read(created), null);
  assert.equal((await storage.read(removed))?.value.label, "seed");

  const committed = await staged.commit();
  assert.equal(committed.replayed, false);
  assert.deepEqual(
    committed.records.map((record) => record?.revision ?? null),
    [1, 2, 1, null],
  );
  assert.equal((await storage.read(update))?.value.label, "next");
  assert.equal((await storage.read(created))?.value.label, "new");
  assert.equal(await storage.read(removed), null);
  assert.strictEqual(await staged.commit(), committed);
});

test("recovers exact replay evidence after a committed response is lost", async () => {
  const state = new MemoryStorageState();
  const durable = new MemoryStorageAdapter(state);
  const flaky = new CommitThenUnavailableAdapter(durable);
  const staged = new StagedStorageTransaction(
    flaky,
    operation("operation:response-loss"),
  );
  const created = key("records", "record:response-loss");
  await staged.transact({
    operationId: operation("operation:response-loss"),
    mutations: [
      { type: "put", key: created, expectedRevision: null, value: document("saved") },
    ],
  });

  await assertStorageFailure(() => staged.commit(), "UNAVAILABLE");
  assert.equal((await durable.read(created))?.value.label, "saved");
  const changed = key("records", "record:changed-after-response-loss");
  await assertStorageFailure(
    () => staged.transact({
      operationId: operation("operation:response-loss"),
      mutations: [
        { type: "put", key: changed, expectedRevision: null, value: document("changed") },
      ],
    }),
    "CONFLICT",
  );
  const recovered = await staged.commit();
  assert.equal(recovered.replayed, true);
  assert.equal(flaky.transactionCalls, 2);
  assert.equal(flaky.requestFingerprints.length, 2);
  assert.equal(flaky.requestFingerprints[0], flaky.requestFingerprints[1]);
  assert.equal(await durable.read(changed), null);
});

test("serializes concurrent staging before enforcing duplicate keys", async () => {
  const durable = new MemoryStorageAdapter();
  const storage = new FirstReadBlockingAdapter(durable);
  const duplicate = key("records", "record:concurrent-duplicate");
  const staged = new StagedStorageTransaction(
    storage,
    operation("operation:concurrent-duplicate"),
  );

  const first = staged.transact({
    operationId: operation("operation:concurrent-duplicate"),
    mutations: [
      { type: "put", key: duplicate, expectedRevision: null, value: document("first") },
    ],
  });
  await storage.waitForFirstRead();
  const secondFailure = assertStorageFailure(
    () => staged.transact({
      operationId: operation("operation:concurrent-duplicate"),
      mutations: [
        { type: "check", key: duplicate, expectedRevision: null },
      ],
    }),
    "INVALID_REQUEST",
  );
  await Promise.resolve();
  const readsBeforeRelease = storage.readCalls;
  storage.releaseFirstRead();

  await Promise.all([first, secondFailure]);
  assert.equal(readsBeforeRelease, 1);
  const committed = await staged.commit();
  assert.equal(committed.records.length, 1);
  assert.equal((await durable.read(duplicate))?.value.label, "first");
});

test("serializes concurrent staging before enforcing count and byte ceilings", async () => {
  const countDurable = new MemoryStorageAdapter();
  const countStorage = new FirstReadBlockingAdapter(countDurable);
  const countStaged = new StagedStorageTransaction(
    countStorage,
    operation("operation:concurrent-count"),
  );
  const firstCount = countStaged.transact({
    operationId: operation("operation:concurrent-count"),
    mutations: checks(0, 13),
  });
  await countStorage.waitForFirstRead();
  const countFailure = assertStorageFailure(
    () => countStaged.transact({
      operationId: operation("operation:concurrent-count"),
      mutations: checks(13, 13),
    }),
    "INVALID_REQUEST",
  );
  await Promise.resolve();
  const countReadsBeforeRelease = countStorage.readCalls;
  countStorage.releaseFirstRead();
  await Promise.all([firstCount, countFailure]);
  assert.equal(countReadsBeforeRelease, 1);
  assert.equal((await countStaged.commit()).records.length, 13);

  const byteDurable = new MemoryStorageAdapter();
  const byteStorage = new FirstReadBlockingAdapter(byteDurable);
  const byteStaged = new StagedStorageTransaction(
    byteStorage,
    operation("operation:concurrent-bytes"),
  );
  const payload = "x".repeat(Math.floor(MAX_STAGED_STORAGE_TRANSACTION_BYTES / 2) + 512);
  const firstKey = key("records", "record:concurrent-bytes-first");
  const secondKey = key("records", "record:concurrent-bytes-second");
  const firstBytes = byteStaged.transact({
    operationId: operation("operation:concurrent-bytes"),
    mutations: [{
      type: "put",
      key: firstKey,
      expectedRevision: null,
      value: { payload },
    }],
  });
  await byteStorage.waitForFirstRead();
  const byteFailure = assertStorageFailure(
    () => byteStaged.transact({
      operationId: operation("operation:concurrent-bytes"),
      mutations: [{
        type: "put",
        key: secondKey,
        expectedRevision: null,
        value: { payload },
      }],
    }),
    "INVALID_REQUEST",
  );
  await Promise.resolve();
  const byteReadsBeforeRelease = byteStorage.readCalls;
  byteStorage.releaseFirstRead();
  await Promise.all([firstBytes, byteFailure]);
  assert.equal(byteReadsBeforeRelease, 1);
  assert.equal((await byteStaged.commit()).records.length, 1);
  assert.equal(await byteDurable.read(secondKey), null);
});

test("serializes list and write lifecycle transitions in invocation order", async () => {
  const listFirstDurable = new MemoryStorageAdapter();
  const listFirstStorage = new FirstListBlockingAdapter(listFirstDurable);
  const listFirst = new StagedStorageTransaction(
    listFirstStorage,
    operation("operation:list-first-race"),
  );
  const page = listFirst.list({ collection: collection("records"), limit: 1 });
  await listFirstStorage.waitForFirstList();
  const writeAfterList = assertStorageFailure(
    () => listFirst.transact({
      operationId: operation("operation:list-first-race"),
      mutations: [{
        type: "put",
        key: key("records", "record:after-pending-list"),
        expectedRevision: null,
        value: document("new"),
      }],
    }),
    "INVALID_REQUEST",
  );
  await Promise.resolve();
  const listFirstReads = listFirstStorage.readCalls;
  listFirstStorage.releaseFirstList();
  await Promise.all([page, writeAfterList]);
  assert.equal(listFirstReads, 0);

  const writeFirstDurable = new MemoryStorageAdapter();
  const writeFirstStorage = new FirstReadBlockingAdapter(writeFirstDurable);
  const writeFirst = new StagedStorageTransaction(
    writeFirstStorage,
    operation("operation:write-first-race"),
  );
  const stagedWrite = writeFirst.transact({
    operationId: operation("operation:write-first-race"),
    mutations: [{
      type: "put",
      key: key("records", "record:before-pending-list"),
      expectedRevision: null,
      value: document("new"),
    }],
  });
  await writeFirstStorage.waitForFirstRead();
  const listAfterWrite = assertStorageFailure(
    () => writeFirst.list({ collection: collection("records"), limit: 1 }),
    "INVALID_REQUEST",
  );
  await Promise.resolve();
  const writeFirstLists = writeFirstStorage.listCalls;
  writeFirstStorage.releaseFirstRead();
  await Promise.all([stagedWrite, listAfterWrite]);
  assert.equal(writeFirstLists, 0);
  assert.equal((await writeFirst.commit()).records.length, 1);
});

test("rejects commit while staging is pending, then seals after it settles", async () => {
  const durable = new MemoryStorageAdapter();
  const storage = new FirstReadBlockingAdapter(durable);
  const staged = new StagedStorageTransaction(
    storage,
    operation("operation:pending-stage"),
  );
  const pending = staged.transact({
    operationId: operation("operation:pending-stage"),
    mutations: [{
      type: "put",
      key: key("records", "record:pending-stage"),
      expectedRevision: null,
      value: document("saved"),
    }],
  });
  await storage.waitForFirstRead();

  await assertStorageFailure(() => staged.commit(), "CONFLICT");
  assert.equal(storage.transactionCalls, 0);
  storage.releaseFirstRead();
  await pending;
  assert.equal((await staged.commit()).records.length, 1);
  assert.equal(storage.transactionCalls, 1);
});

test("synchronously seals commit, rejects late staging, and coalesces commits", async () => {
  const durable = new MemoryStorageAdapter();
  const storage = new CommitBlockingAdapter(durable);
  const staged = new StagedStorageTransaction(
    storage,
    operation("operation:coalesced-commit"),
  );
  const committedKey = key("records", "record:coalesced-commit");
  const lateKey = key("records", "record:late-stage");
  await staged.transact({
    operationId: operation("operation:coalesced-commit"),
    mutations: [{
      type: "put",
      key: committedKey,
      expectedRevision: null,
      value: document("saved"),
    }],
  });

  const first = staged.commit();
  const second = staged.commit();
  const lateStage = assertStorageFailure(
    () => staged.transact({
      operationId: operation("operation:coalesced-commit"),
      mutations: [{
        type: "put",
        key: lateKey,
        expectedRevision: null,
        value: document("late"),
      }],
    }),
    "CONFLICT",
  );
  const lateList = assertStorageFailure(
    () => staged.list({ collection: collection("other-records"), limit: 1 }),
    "CONFLICT",
  );
  await storage.waitForCommit();
  assert.equal(storage.transactionCalls, 1);
  assert.equal(storage.readCalls, 1);
  storage.releaseCommit();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  await Promise.all([lateStage, lateList]);
  assert.strictEqual(firstResult, secondResult);
  assert.equal(storage.transactionCalls, 1);
  assert.equal((await durable.read(committedKey))?.value.label, "saved");
  assert.equal(await durable.read(lateKey), null);
});

test("a changed revision rejects the final transaction and rolls back all writes", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const changed = key("records", "record:changed");
  const untouched = key("records", "record:must-not-exist");
  await seed(storage, [changed]);

  const staged = new StagedStorageTransaction(
    storage,
    operation("operation:stale-final"),
  );
  await staged.transact({
    operationId: operation("operation:stale-final"),
    mutations: [
      { type: "check", key: changed, expectedRevision: 1 },
      { type: "put", key: untouched, expectedRevision: null, value: document("new") },
    ],
  });
  await storage.transact({
    operationId: operation("operation:external-change"),
    mutations: [
      { type: "put", key: changed, expectedRevision: 1, value: document("external") },
    ],
  });

  await assertStorageFailure(() => staged.commit(), "PRECONDITION_FAILED");
  assert.equal(await storage.read(untouched), null);
  assert.equal((await storage.read(changed))?.value.label, "external");
});

test("a failed staging batch leaves neither a partial overlay nor extra commit work", async () => {
  const storage = new MemoryStorageAdapter();
  const first = key("records", "record:first");
  const partial = key("records", "record:partial");
  const missing = key("records", "record:missing");
  const staged = new StagedStorageTransaction(
    storage,
    operation("operation:stage-rollback"),
  );
  await staged.transact({
    operationId: operation("operation:stage-rollback"),
    mutations: [
      { type: "put", key: first, expectedRevision: null, value: document("first") },
    ],
  });

  await assertStorageFailure(
    () => staged.transact({
      operationId: operation("operation:stage-rollback"),
      mutations: [
        { type: "put", key: partial, expectedRevision: null, value: document("partial") },
        { type: "delete", key: missing, expectedRevision: 1 },
      ],
    }),
    "PRECONDITION_FAILED",
  );
  assert.equal(await staged.read(partial), null);

  const result = await staged.commit();
  assert.equal(result.records.length, 1);
  assert.equal((await storage.read(first))?.value.label, "first");
  assert.equal(await storage.read(partial), null);
});

test("enforces the exact transaction count and byte ceilings", async () => {
  const storage = new MemoryStorageAdapter();
  const staged = new StagedStorageTransaction(
    storage,
    operation("operation:max-count"),
  );
  await staged.transact({
    operationId: operation("operation:max-count"),
    mutations: checks(0, 13),
  });
  await staged.transact({
    operationId: operation("operation:max-count"),
    mutations: checks(13, 12),
  });
  await assertStorageFailure(
    () => staged.transact({
      operationId: operation("operation:max-count"),
      mutations: checks(25, 1),
    }),
    "INVALID_REQUEST",
  );
  const maximum = await staged.commit();
  assert.equal(maximum.records.length, 25);

  const oversized = new StagedStorageTransaction(
    storage,
    operation("operation:oversized"),
  );
  await assertStorageFailure(
    () => oversized.transact({
      operationId: operation("operation:oversized"),
      mutations: [{
        type: "put",
        key: key("records", "record:oversized"),
        expectedRevision: null,
        value: { payload: "x".repeat(MAX_STAGED_STORAGE_TRANSACTION_BYTES) },
      }],
    }),
    "INVALID_REQUEST",
  );
  assert.equal(await storage.read(key("records", "record:oversized")), null);
});

test("rejects duplicate keys, changed operation IDs, and unsafe list overlays", async () => {
  const storage = new MemoryStorageAdapter();
  const duplicate = key("records", "record:duplicate");
  const staged = new StagedStorageTransaction(
    storage,
    operation("operation:boundaries"),
  );
  await staged.transact({
    operationId: operation("operation:boundaries"),
    mutations: [
      { type: "check", key: duplicate, expectedRevision: null },
    ],
  });
  await assertStorageFailure(
    () => staged.transact({
      operationId: operation("operation:boundaries"),
      mutations: [{ type: "check", key: duplicate, expectedRevision: null }],
    }),
    "INVALID_REQUEST",
  );
  await assertStorageFailure(
    () => staged.transact({
      operationId: operation("operation:foreign"),
      mutations: checks(30, 1),
    }),
    "INVALID_REQUEST",
  );

  const listed = new StagedStorageTransaction(
    storage,
    operation("operation:list-before-write"),
  );
  await listed.list({ collection: collection("records"), limit: 1 });
  await assertStorageFailure(
    () => listed.transact({
      operationId: operation("operation:list-before-write"),
      mutations: [{
        type: "put",
        key: key("records", "record:after-list"),
        expectedRevision: null,
        value: document("new"),
      }],
    }),
    "INVALID_REQUEST",
  );

  const written = new StagedStorageTransaction(
    storage,
    operation("operation:write-before-list"),
  );
  await written.transact({
    operationId: operation("operation:write-before-list"),
    mutations: [{
      type: "put",
      key: key("records", "record:before-list"),
      expectedRevision: null,
      value: document("new"),
    }],
  });
  await assertStorageFailure(
    () => written.list({ collection: collection("records"), limit: 1 }),
    "INVALID_REQUEST",
  );
});

for (const [name, transform] of [
  ["reordered records", (result: StorageTransactionResult) => ({
    replayed: result.replayed,
    records: [...result.records].reverse(),
  })],
  ["missing records", (result: StorageTransactionResult) => ({
    replayed: result.replayed,
    records: result.records.slice(0, 1),
  })],
  ["non-boolean replay evidence", (result: StorageTransactionResult) => ({
    replayed: "false",
    records: result.records,
  })],
  ["changed record values", (result: StorageTransactionResult) => ({
    replayed: result.replayed,
    records: result.records.map((record, index) =>
      index === 0 && record !== null
        ? { ...record, value: document("altered") }
        : record
    ),
  })],
] as const) {
  test(`fails closed on ${name} in the durable result`, async () => {
    const durable = new MemoryStorageAdapter();
    const storage = new ResultTransformingAdapter(durable, transform);
    const staged = new StagedStorageTransaction(
      storage,
      operation(`operation:malformed-${name.replaceAll(" ", "-")}`),
    );
    await staged.transact({
      operationId: operation(`operation:malformed-${name.replaceAll(" ", "-")}`),
      mutations: [
        {
          type: "put",
          key: key("records", "record:first-result"),
          expectedRevision: null,
          value: document("first"),
        },
        {
          type: "put",
          key: key("records", "record:second-result"),
          expectedRevision: null,
          value: document("second"),
        },
      ],
    });
    await assertStorageFailure(() => staged.commit(), "UNAVAILABLE");
  });
}

test("sanitizes adapter failures without retaining private causes", async () => {
  const storage: StorageAdapter = {
    read: () => Promise.reject(new Error("PRIVATE read value")),
    list: () => Promise.reject(new Error("PRIVATE cursor")),
    transact: () => Promise.reject(
      new StorageFailure("UNAVAILABLE", { cause: new Error("PRIVATE token") }),
    ),
  };
  const staged = new StagedStorageTransaction(
    storage,
    operation("operation:sanitize"),
  );
  let failure: unknown;
  try {
    await staged.transact({
      operationId: operation("operation:sanitize"),
      mutations: [{
        type: "put",
        key: key("records", "record:sanitize"),
        expectedRevision: null,
        value: document("private"),
      }],
    });
    assert.fail("Expected the private adapter failure to be sanitized.");
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof StorageFailure);
  assert.equal(failure.code, "UNAVAILABLE");
  assert.equal(failure.cause, undefined);
  assert.doesNotMatch(failure.message, /PRIVATE|token|value/u);
});

test("preserves only allowlisted runtime StorageFailure codes", async () => {
  for (const code of [
    "INVALID_REQUEST",
    "NOT_FOUND",
    "CONFLICT",
    "PRECONDITION_FAILED",
    "UNAVAILABLE",
  ] as const) {
    const staged = new StagedStorageTransaction(
      readFailureAdapter(
        new StorageFailure(code, { cause: new Error(`PRIVATE ${code}`) }),
      ),
      operation(`operation:allowlisted-${code.toLowerCase()}`),
    );
    const failure = await captureStorageFailure(
      () => staged.read(key("records", `record:allowlisted-${code.toLowerCase()}`)),
      code,
    );
    assert.equal(failure.cause, undefined);
    assert.doesNotMatch(failure.message, /PRIVATE/u);
  }

  const invalidCode = new StorageFailure("UNAVAILABLE");
  Object.defineProperty(invalidCode, "code", {
    configurable: true,
    value: "PRIVATE_FAILURE_CODE",
  });
  const invalidCodeFailure = await captureStorageFailure(
    () => new StagedStorageTransaction(
      readFailureAdapter(invalidCode),
      operation("operation:invalid-failure-code"),
    ).read(key("records", "record:invalid-failure-code")),
    "UNAVAILABLE",
  );
  assert.equal(invalidCodeFailure.message, "Storage is temporarily unavailable.");
  assert.doesNotMatch(invalidCodeFailure.message, /PRIVATE_FAILURE_CODE/u);

  const throwingCode = new StorageFailure("UNAVAILABLE");
  Object.defineProperty(throwingCode, "code", {
    configurable: true,
    get(): never {
      throw new Error("PRIVATE failure-code accessor");
    },
  });
  const throwingCodeFailure = await captureStorageFailure(
    () => new StagedStorageTransaction(
      readFailureAdapter(throwingCode),
      operation("operation:throwing-failure-code"),
    ).read(key("records", "record:throwing-failure-code")),
    "UNAVAILABLE",
  );
  assert.equal(throwingCodeFailure.message, "Storage is temporarily unavailable.");
  assert.equal(throwingCodeFailure.cause, undefined);

  const changingCode = new StorageFailure("UNAVAILABLE");
  let codeReads = 0;
  Object.defineProperty(changingCode, "code", {
    configurable: true,
    get(): string {
      codeReads += 1;
      return codeReads === 1 ? "CONFLICT" : "PRIVATE_FAILURE_CODE";
    },
  });
  const changingCodeFailure = await captureStorageFailure(
    () => new StagedStorageTransaction(
      readFailureAdapter(changingCode),
      operation("operation:changing-failure-code"),
    ).read(key("records", "record:changing-failure-code")),
    "CONFLICT",
  );
  assert.equal(codeReads, 1);
  assert.equal(
    changingCodeFailure.message,
    "The storage request conflicts with current state.",
  );
});

test("rejects throwing StorageAdapter accessors with one fixed failure", () => {
  const valid = new StagedStorageTransaction(
    new MemoryStorageAdapter(),
    operation("operation:valid-adapter"),
  );
  assert.ok(valid instanceof StagedStorageTransaction);

  for (const method of ["read", "list", "transact"] as const) {
    const candidate: StorageAdapter = {
      read: () => Promise.resolve(null),
      list: () => Promise.resolve(Object.freeze({
        items: Object.freeze([]),
        nextCursor: null,
      })),
      transact: () => Promise.resolve(Object.freeze({
        replayed: false,
        records: Object.freeze([]),
      })),
    };
    Object.defineProperty(candidate, method, {
      configurable: true,
      get(): never {
        throw new Error(`PRIVATE ${method} accessor`);
      },
    });

    assert.throws(
      () => new StagedStorageTransaction(
        candidate,
        operation(`operation:throwing-adapter-${method}`),
      ),
      (error) => {
        assert.ok(error instanceof StorageFailure);
        assert.equal(error.code, "INVALID_REQUEST");
        assert.equal(error.message, "The storage request is invalid.");
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(error.message, /PRIVATE|accessor/u);
        return true;
      },
    );
  }
});

class FirstReadBlockingAdapter implements StorageAdapter {
  readCalls = 0;
  listCalls = 0;
  transactionCalls = 0;
  readonly #inner: StorageAdapter;
  readonly #firstReadStarted = deferred<void>();
  readonly #firstReadRelease = deferred<void>();

  constructor(inner: StorageAdapter) {
    this.#inner = inner;
  }

  async read(keyValue: StorageKey): Promise<StorageRecord | null> {
    this.readCalls += 1;
    if (this.readCalls === 1) {
      this.#firstReadStarted.resolve();
      await this.#firstReadRelease.promise;
    }
    return this.#inner.read(keyValue);
  }

  async list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    this.listCalls += 1;
    return this.#inner.list(request);
  }

  async transact(request: StorageTransactionRequest): Promise<StorageTransactionResult> {
    this.transactionCalls += 1;
    return this.#inner.transact(request);
  }

  waitForFirstRead(): Promise<void> {
    return this.#firstReadStarted.promise;
  }

  releaseFirstRead(): void {
    this.#firstReadRelease.resolve();
  }
}

class FirstListBlockingAdapter implements StorageAdapter {
  readCalls = 0;
  listCalls = 0;
  readonly #inner: StorageAdapter;
  readonly #firstListStarted = deferred<void>();
  readonly #firstListRelease = deferred<void>();

  constructor(inner: StorageAdapter) {
    this.#inner = inner;
  }

  async read(keyValue: StorageKey): Promise<StorageRecord | null> {
    this.readCalls += 1;
    return this.#inner.read(keyValue);
  }

  async list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    this.listCalls += 1;
    if (this.listCalls === 1) {
      this.#firstListStarted.resolve();
      await this.#firstListRelease.promise;
    }
    return this.#inner.list(request);
  }

  transact(request: StorageTransactionRequest): Promise<StorageTransactionResult> {
    return this.#inner.transact(request);
  }

  waitForFirstList(): Promise<void> {
    return this.#firstListStarted.promise;
  }

  releaseFirstList(): void {
    this.#firstListRelease.resolve();
  }
}

class CommitBlockingAdapter implements StorageAdapter {
  readCalls = 0;
  transactionCalls = 0;
  readonly #inner: StorageAdapter;
  readonly #commitStarted = deferred<void>();
  readonly #commitRelease = deferred<void>();

  constructor(inner: StorageAdapter) {
    this.#inner = inner;
  }

  async read(keyValue: StorageKey): Promise<StorageRecord | null> {
    this.readCalls += 1;
    return this.#inner.read(keyValue);
  }

  list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    return this.#inner.list(request);
  }

  async transact(request: StorageTransactionRequest): Promise<StorageTransactionResult> {
    this.transactionCalls += 1;
    this.#commitStarted.resolve();
    await this.#commitRelease.promise;
    return this.#inner.transact(request);
  }

  waitForCommit(): Promise<void> {
    return this.#commitStarted.promise;
  }

  releaseCommit(): void {
    this.#commitRelease.resolve();
  }
}

class CommitThenUnavailableAdapter implements StorageAdapter {
  transactionCalls = 0;
  readonly requestFingerprints: string[] = [];
  readonly #inner: StorageAdapter;

  constructor(inner: StorageAdapter) {
    this.#inner = inner;
  }

  read(keyValue: StorageKey): Promise<StorageRecord | null> {
    return this.#inner.read(keyValue);
  }

  list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    return this.#inner.list(request);
  }

  async transact(request: StorageTransactionRequest): Promise<StorageTransactionResult> {
    this.transactionCalls += 1;
    this.requestFingerprints.push(JSON.stringify(request));
    const result = await this.#inner.transact(request);
    if (this.transactionCalls === 1) {
      throw new Error("PRIVATE committed response");
    }
    return result;
  }
}

class ResultTransformingAdapter implements StorageAdapter {
  readonly #inner: StorageAdapter;
  readonly #transform: (result: StorageTransactionResult) => unknown;

  constructor(
    inner: StorageAdapter,
    transform: (result: StorageTransactionResult) => unknown,
  ) {
    this.#inner = inner;
    this.#transform = transform;
  }

  read(keyValue: StorageKey): Promise<StorageRecord | null> {
    return this.#inner.read(keyValue);
  }

  list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    return this.#inner.list(request);
  }

  async transact(request: StorageTransactionRequest): Promise<StorageTransactionResult> {
    return this.#transform(
      await this.#inner.transact(request),
    ) as StorageTransactionResult;
  }
}

async function seed(
  storage: StorageAdapter,
  keys: readonly StorageKey[],
): Promise<void> {
  await storage.transact({
    operationId: operation(`operation:seed-${keys[0]?.id ?? "none"}`),
    mutations: keys.map((seedKey) => ({
      type: "put" as const,
      key: seedKey,
      expectedRevision: null,
      value: document("seed"),
    })),
  });
}

function checks(start: number, count: number) {
  return Array.from({ length: count }, (_, offset) => ({
    type: "check" as const,
    key: key("records", `record:check-${String(start + offset).padStart(2, "0")}`),
    expectedRevision: null,
  }));
}

function key(collectionValue: string, id: string): StorageKey {
  const parsed = parseStorageKey(collectionValue, id);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("Invalid test key.");
  return parsed.value;
}

function collection(value: string): StorageCollection {
  return key(value, "record:collection").collection;
}

function operation(value: string) {
  const parsed = parseStorageOperationId(value);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("Invalid test operation.");
  return parsed.value;
}

function document(label: string): StorageDocument {
  return Object.freeze({ label });
}

function readFailureAdapter(error: unknown): StorageAdapter {
  return {
    read: () => Promise.reject(error),
    list: () => Promise.resolve(Object.freeze({
      items: Object.freeze([]),
      nextCursor: null,
    })),
    transact: () => Promise.resolve(Object.freeze({
      replayed: false,
      records: Object.freeze([]),
    })),
  };
}

function deferred<Value>(): Readonly<{
  promise: Promise<Value>;
  resolve: (value: Value) => void;
}> {
  let resolve: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return Object.freeze({ promise, resolve: resolve! });
}

async function captureStorageFailure(
  action: () => Promise<unknown>,
  code: StorageFailure["code"],
): Promise<StorageFailure> {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof StorageFailure);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`Expected StorageFailure ${code}.`);
}

async function assertStorageFailure(
  action: () => Promise<unknown>,
  code: StorageFailure["code"],
): Promise<void> {
  await assert.rejects(
    action,
    (error) => error instanceof StorageFailure && error.code === code,
  );
}
