import assert from "node:assert/strict";
import test from "node:test";

import {
  StorageFailure,
  parseStorageKey,
  type StorageAdapter,
  type StorageCursor,
  type StoragePage,
  type StorageRecord,
} from "../domain/storage-adapter.ts";
import {
  DevelopmentInMemoryAuditRepository,
  MAX_OWNER_AUDIT_CURSOR_LENGTH,
  StorageAuditEventReader,
} from "../repositories/in-memory-audit-notification-repositories.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";

const PRIVATE_SENTINEL = "PRIVATE AUDIT DETAIL MUST NOT ESCAPE";

test("persistent audit reader pages canonical events across reconstruction", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const writer = new DevelopmentInMemoryAuditRepository(storage);
  await writer.append(auditIntent("audit-event:01", "audit-operation:01"));
  await writer.append(auditIntent("audit-event:02", "audit-operation:02"));

  const first = await new StorageAuditEventReader(storage).list({ limit: 1 });
  assert.deepEqual(first.items.map(({ id }) => id), ["audit-event:01"]);
  assert.notEqual(first.nextCursor, null);

  const reopened = new StorageAuditEventReader(
    new MemoryStorageAdapter(state),
  );
  const second = await reopened.list({
    limit: 1,
    cursor: requiredCursor(first.nextCursor),
  });
  assert.deepEqual(second.items.map(({ id }) => id), ["audit-event:02"]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(second.items[0]?.detail, {
    kind: "resource-transition",
    resource: { type: "campaign", id: "campaign:public" },
    transition: "updated",
  });
});

test("audit reader rejects malformed requests before storage access", async () => {
  let listCalls = 0;
  const reader = new StorageAuditEventReader(pageAdapter(() => {
    listCalls += 1;
    return { items: [], nextCursor: null };
  }));
  const malformed = [
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: 1, cursor: "" },
    { limit: 1, cursor: "line\nbreak" },
    { limit: 1, cursor: "x".repeat(MAX_OWNER_AUDIT_CURSOR_LENGTH + 1) },
    { limit: 1, unexpected: true },
  ] as const;

  for (const request of malformed) {
    await expectFailure(
      () => reader.list(request as never),
      "INVALID_REQUEST",
    );
  }
  assert.equal(listCalls, 0);
});

test("audit reader rejects unknown and private stored evidence without evaluating it", async () => {
  let accessorEvaluated = false;
  const hostileDetail = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(hostileDetail, "kind", {
    enumerable: true,
    get() {
      accessorEvaluated = true;
      throw new Error(PRIVATE_SENTINEL);
    },
  });

  const corruptions: readonly StorageRecord[] = [
    auditRecord({ kind: "future-private-evidence", private: PRIVATE_SENTINEL }),
    auditRecord({
      kind: "export-created",
      exportType: "review-csv",
      private: PRIVATE_SENTINEL,
    }),
    auditRecord(hostileDetail),
  ];
  for (const record of corruptions) {
    const error = await expectFailure(
      () => new StorageAuditEventReader(
        pageAdapter(() => ({ items: [record], nextCursor: null })),
      ).list({ limit: 1 }),
      "UNAVAILABLE",
    );
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(JSON.stringify(error), new RegExp(PRIVATE_SENTINEL, "u"));
  }
  assert.equal(accessorEvaluated, false);

  const dependencyFailure = await expectFailure(
    () => new StorageAuditEventReader(pageAdapter(() => {
      throw new Error(PRIVATE_SENTINEL);
    })).list({ limit: 1 }),
    "UNAVAILABLE",
  );
  assert.equal(dependencyFailure.cause, undefined);
  assert.doesNotMatch(
    JSON.stringify(dependencyFailure),
    new RegExp(PRIVATE_SENTINEL, "u"),
  );
});

test("audit reader fails closed on corrupt records and non-finite pages", async () => {
  const valid = auditRecord({
    kind: "export-created",
    exportType: "review-csv",
  });
  const wrongRevision = { ...valid, revision: 2 };
  const wrongKey = {
    ...valid,
    key: auditKey("audit-event:wrong-key"),
  };
  const customPrototype = Object.assign(Object.create({ private: PRIVATE_SENTINEL }), valid);
  const cases: readonly Readonly<{
    request?: Readonly<{ limit: number; cursor?: StorageCursor }>;
    page: StoragePage;
  }>[] = [
    { page: { items: [wrongRevision], nextCursor: null } as StoragePage },
    { page: { items: [wrongKey], nextCursor: null } as StoragePage },
    { page: { items: [customPrototype], nextCursor: null } as StoragePage },
    { page: { items: [valid, valid], nextCursor: null } as StoragePage },
    {
      request: { limit: 2 },
      page: { items: [valid, valid], nextCursor: null } as StoragePage,
    },
    {
      request: { limit: 1, cursor: "cursor:1" as StorageCursor },
      page: { items: [valid], nextCursor: "cursor:1" as StorageCursor },
    },
    {
      page: { items: [], nextCursor: "cursor:1" as StorageCursor },
    },
  ];

  for (const [index, candidate] of cases.entries()) {
    const error = await expectFailure(
      () => new StorageAuditEventReader(
        pageAdapter(() => candidate.page),
      ).list(candidate.request ?? { limit: 1 }),
      "UNAVAILABLE",
    );
    assert.equal(error.cause, undefined, `case ${index}`);
  }
});

function auditIntent(id: string, operationId: string) {
  return {
    type: "append-audit-event",
    event: {
      id,
      operationId,
      occurredAt: "2026-08-11T08:00:00.000Z",
      actor: { type: "owner", subject: "oidc:configured-owner" },
      detail: {
        kind: "resource-transition",
        resource: { type: "campaign", id: "campaign:public" },
        transition: "updated",
      },
    },
  } as const;
}

function auditRecord(detail: unknown): StorageRecord {
  return {
    key: auditKey("audit-event:stored"),
    revision: 1,
    value: {
      kind: "audit-event",
      schemaVersion: 1,
      event: {
        id: "audit-event:stored",
        operationId: "audit-operation:stored",
        occurredAt: "2026-08-11T08:00:00.000Z",
        actor: { type: "owner", subject: "oidc:configured-owner" },
        detail,
      },
    },
  } as unknown as StorageRecord;
}

function auditKey(id: string) {
  const parsed = parseStorageKey("audit-events", id);
  assert(parsed.ok);
  return parsed.value;
}

function pageAdapter(page: () => StoragePage): StorageAdapter {
  return {
    read: async () => null,
    list: async () => page(),
    transact: async () => {
      throw new StorageFailure("UNAVAILABLE");
    },
  };
}

function requiredCursor(value: StorageCursor | null): StorageCursor {
  assert.notEqual(value, null);
  return value as StorageCursor;
}

async function expectFailure(
  operation: () => Promise<unknown>,
  code: StorageFailure["code"],
): Promise<StorageFailure> {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof StorageFailure);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail("Expected a StorageFailure.");
}
