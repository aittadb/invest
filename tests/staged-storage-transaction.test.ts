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
  const recovered = await staged.commit();
  assert.equal(recovered.replayed, true);
  assert.equal(flaky.transactionCalls, 2);
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

class CommitThenUnavailableAdapter implements StorageAdapter {
  transactionCalls = 0;
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

async function assertStorageFailure(
  action: () => Promise<unknown>,
  code: StorageFailure["code"],
): Promise<void> {
  await assert.rejects(
    action,
    (error) => error instanceof StorageFailure && error.code === code,
  );
}
