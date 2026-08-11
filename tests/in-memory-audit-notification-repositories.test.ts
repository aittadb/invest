import assert from "node:assert/strict";
import test from "node:test";

import {
  toPublicStorageFailure,
  StorageFailure,
  assertStorageListBoundary,
  assertStorageTransactionBoundary,
  storageKeyString,
  type StorageAdapter,
  type StorageCursor,
  type StorageDocument,
  type StorageKey,
  type StoragePage,
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import {
  DevelopmentInMemoryAuditRepository,
  DevelopmentInMemoryManualNotificationRepository,
  MAX_MANUAL_NOTIFICATION_STORAGE_READS,
  MAX_OWNER_NOTIFICATION_CURSOR_LENGTH,
  MAX_OWNER_NOTIFICATION_PAGE_SIZE,
  type AuditRepository,
  type ManualNotificationRepository,
} from "../repositories/in-memory-audit-notification-repositories.ts";

const GENERATED_AT = "2026-04-01T09:00:00.000Z";
const COPIED_AT = "2026-04-01T09:01:00.000Z";
const SENT_AT = "2026-04-01T09:02:00.000Z";
const OWNER = Object.freeze({
  type: "owner" as const,
  subject: "issuer.invalid/owner-subject",
});

export type AuditRepositoryContractFixture = Readonly<{
  owner: AuditRepository;
  reopenOwner: () => AuditRepository;
  deniedExisting: AuditRepository;
  deniedMissing: AuditRepository;
}>;

export type ManualNotificationRepositoryContractFixture = Readonly<{
  owner: ManualNotificationRepository;
  reopenOwner: () => ManualNotificationRepository;
  deniedExisting: ManualNotificationRepository;
  deniedMissing: ManualNotificationRepository;
}>;

export type AuditRepositoryContractFactory =
  () => AuditRepositoryContractFixture;
export type ManualNotificationRepositoryContractFactory =
  () => ManualNotificationRepositoryContractFixture;

/** Reusable append, paging, retry, event-vocabulary, and disclosure contract. */
export async function verifyAuditRepositoryContract(
  createFixture: AuditRepositoryContractFactory,
): Promise<void> {
  const fixture = createFixture();
  const exportIntent = auditIntent(
    "audit-event:01-export",
    "audit-operation:01-export",
    { kind: "export-created", exportType: "json-backup" },
  );
  const exported = await fixture.owner.append(exportIntent);
  assert.equal(exported.replayed, false);
  assert.deepEqual(exported.event.detail, {
    kind: "export-created",
    exportType: "json-backup",
  });

  const replay = await fixture.owner.append(exportIntent);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.event, exported.event);
  await expectStorageFailure(
    () => fixture.owner.append({
      ...exportIntent,
      event: {
        ...exportIntent.event,
        detail: { kind: "export-created", exportType: "review-csv" },
      },
    }),
    "CONFLICT",
  );

  await fixture.owner.append(auditIntent(
    "audit-event:02-reconciliation",
    "audit-operation:02-reconciliation",
    {
      kind: "resource-transition",
      resource: { type: "aggregate", id: "aggregate:public-total" },
      transition: "reconciled",
    },
  ));
  await fixture.owner.append(auditIntent(
    "audit-event:03-moderation",
    "audit-operation:03-moderation",
    {
      kind: "resource-transition",
      resource: {
        type: "investment-indication",
        id: "indication:moderated",
      },
      transition: "rejected",
    },
  ));

  const firstPage = await fixture.owner.list({ limit: 2 });
  assert.equal(firstPage.items.length, 2);
  assert.notEqual(firstPage.nextCursor, null);
  const secondPage = await fixture.owner.list({
    limit: 2,
    ...(firstPage.nextCursor === null
      ? {}
      : { cursor: firstPage.nextCursor }),
  });
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.nextCursor, null);
  assert.deepEqual(
    [...firstPage.items, ...secondPage.items].map(({ detail }) => detail),
    [
      { kind: "export-created", exportType: "json-backup" },
      {
        kind: "resource-transition",
        resource: { type: "aggregate", id: "aggregate:public-total" },
        transition: "reconciled",
      },
      {
        kind: "resource-transition",
        resource: {
          type: "investment-indication",
          id: "indication:moderated",
        },
        transition: "rejected",
      },
    ],
  );

  assert.deepEqual(
    await fixture.reopenOwner().get("audit-event:03-moderation"),
    secondPage.items[0],
  );
  assert.equal(await fixture.owner.get("audit-event:missing"), null);
  await expectStorageFailure(
    () => fixture.owner.list({ limit: 101 }),
    "INVALID_REQUEST",
  );

  assert.equal(
    await fixture.deniedExisting.get("audit-event:01-export"),
    null,
  );
  assert.equal(
    await fixture.deniedMissing.get("audit-event:01-export"),
    null,
  );
  assert.deepEqual(await fixture.deniedExisting.list({ limit: 10 }), {
    items: [],
    nextCursor: null,
  });
  const deniedExisting = await captureStorageFailure(() =>
    fixture.deniedExisting.append(auditIntent(
      "audit-event:01-export",
      "audit-operation:denied-existing",
      { kind: "export-created", exportType: "review-csv" },
    ))
  );
  const deniedMissing = await captureStorageFailure(() =>
    fixture.deniedMissing.append(auditIntent(
      "audit-event:01-export",
      "audit-operation:denied-missing",
      { kind: "export-created", exportType: "review-csv" },
    ))
  );
  assert.equal(deniedExisting.code, "NOT_FOUND");
  assert.equal(deniedMissing.code, "NOT_FOUND");
  assert.deepEqual(
    toPublicStorageFailure(deniedExisting),
    toPublicStorageFailure(deniedMissing),
  );
}

/** Reusable private template, immutable revision, and authorization contract. */
export async function verifyManualNotificationRepositoryContract(
  createFixture: ManualNotificationRepositoryContractFactory,
): Promise<void> {
  const fixture = createFixture();
  const createRequest = {
    operationId: "notification-operation:create-01",
    template: templateInput("notification:01"),
  };
  const created = await fixture.owner.create(createRequest);
  assert.equal(created.revision, 1);
  assert.equal(created.replayed, false);
  assert.equal(created.record.sentMarker, null);

  const createReplay = await fixture.owner.create(createRequest);
  assert.equal(createReplay.replayed, true);
  assert.deepEqual(createReplay.record, created.record);
  await expectStorageFailure(
    () => fixture.owner.create({
      ...createRequest,
      template: {
        ...createRequest.template,
        subjectLine: "A changed retry",
      },
    }),
    "CONFLICT",
  );

  const copyRequest = {
    operationId: "notification-operation:copy-01",
    notificationId: "notification:01",
    expectedRevision: 1,
    evidence: {
      id: "notification-copy:01",
      copiedAt: COPIED_AT,
      copiedBy: OWNER,
    },
  };
  const copied = await fixture.owner.recordCopy(copyRequest);
  assert.equal(copied.revision, 2);
  assert.equal(copied.replayed, false);
  assert.equal(copied.record.copyEvidence.length, 1);
  assert.equal(copied.record.sentMarker, null);

  const sent = await fixture.owner.markSent({
    operationId: "notification-operation:sent-01",
    notificationId: "notification:01",
    expectedRevision: 2,
    marker: {
      id: "notification-sent:01",
      sentAt: SENT_AT,
      sentBy: OWNER,
    },
  });
  assert.equal(sent.revision, 3);
  assert.equal(sent.record.copyEvidence.length, 1);
  assert.deepEqual(sent.record.sentMarker, {
    id: "notification-sent:01",
    sentAt: SENT_AT,
    sentBy: OWNER,
  });

  const delayedCopyReplay = await fixture.owner.recordCopy(copyRequest);
  assert.equal(delayedCopyReplay.revision, 2);
  assert.equal(delayedCopyReplay.replayed, true);
  assert.equal(delayedCopyReplay.record.sentMarker, null);
  await expectStorageFailure(
    () => fixture.owner.recordCopy({
      ...copyRequest,
      evidence: {
        ...copyRequest.evidence,
        copiedAt: "2026-04-01T09:01:30.000Z",
      },
    }),
    "CONFLICT",
  );

  assert.deepEqual(
    await fixture.reopenOwner().get("notification:01"),
    { revision: 3, record: sent.record },
  );
  assert.equal(await fixture.owner.get("notification:missing"), null);

  await fixture.owner.create({
    operationId: "notification-operation:create-02",
    template: templateInput("notification:02"),
  });
  await fixture.owner.create({
    operationId: "notification-operation:create-03",
    template: templateInput("notification:03"),
  });
  const firstPage = await fixture.owner.list({ limit: 2 });
  assert.equal(firstPage.items.length, 2);
  assert.notEqual(firstPage.nextCursor, null);
  const secondPage = await fixture.owner.list({
    limit: 2,
    ...(firstPage.nextCursor === null
      ? {}
      : { cursor: firstPage.nextCursor }),
  });
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.nextCursor, null);
  await expectStorageFailure(
    () => fixture.owner.list({ limit: 0 }),
    "INVALID_REQUEST",
  );

  assert.equal(await fixture.deniedExisting.get("notification:01"), null);
  assert.equal(await fixture.deniedMissing.get("notification:01"), null);
  const deniedExisting = await captureStorageFailure(() =>
    fixture.deniedExisting.recordCopy({
      operationId: "notification-operation:denied-existing",
      notificationId: "notification:01",
      expectedRevision: 3,
      evidence: {
        id: "notification-copy:denied-existing",
        copiedAt: "2026-04-01T09:03:00.000Z",
        copiedBy: OWNER,
      },
    })
  );
  const deniedMissing = await captureStorageFailure(() =>
    fixture.deniedMissing.recordCopy({
      operationId: "notification-operation:denied-missing",
      notificationId: "notification:01",
      expectedRevision: 3,
      evidence: {
        id: "notification-copy:denied-missing",
        copiedAt: "2026-04-01T09:03:00.000Z",
        copiedBy: OWNER,
      },
    })
  );
  assert.equal(deniedExisting.code, "NOT_FOUND");
  assert.equal(deniedMissing.code, "NOT_FOUND");
  assert.deepEqual(
    toPublicStorageFailure(deniedExisting),
    toPublicStorageFailure(deniedMissing),
  );
}

test("development audit repository passes the reusable contract", async () => {
  const repository = new DevelopmentInMemoryAuditRepository(
    new DeterministicMemoryStorageAdapter(new MemoryStorageState(), true),
  );
  assert.equal(repository.appendConsistency, "atomic-immutable-audit");
  await verifyAuditRepositoryContract(() => createAuditFixture());
});

test("development notification repository passes the reusable contract", async () => {
  await verifyManualNotificationRepositoryContract(() =>
    createNotificationFixture()
  );
});

test("manual notification copy and sent activity commit separate audit evidence", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const repository = new DevelopmentInMemoryManualNotificationRepository(storage);
  await repository.create({
    operationId: "notification-operation:activity-create",
    template: templateInput("notification:activity"),
  });

  const copyRequest = {
    operationId: "notification-operation:activity-copy",
    notificationId: "notification:activity",
    expectedRevision: 1,
    ownerSubject: OWNER.subject,
    occurredAt: COPIED_AT,
  };
  const copied = await repository.recordCopyWithAudit(copyRequest);
  assert.equal(copied.revision, 2);
  assert.equal(copied.record.copyEvidence.length, 1);
  assert.equal(copied.record.sentMarker, null);
  assert.deepEqual(copied.auditEvent.detail, {
    kind: "manual-notification",
    notificationId: "notification:activity",
    activity: "template-copied",
  });

  const sentRequest = {
    operationId: "notification-operation:activity-sent",
    notificationId: "notification:activity",
    expectedRevision: 2,
    ownerSubject: OWNER.subject,
    occurredAt: SENT_AT,
  };
  const sent = await repository.markSentWithAudit(sentRequest);
  assert.equal(sent.revision, 3);
  assert.equal(sent.record.copyEvidence.length, 1);
  assert.equal(sent.record.sentMarker?.sentAt, SENT_AT);
  assert.deepEqual(sent.auditEvent.detail, {
    kind: "manual-notification",
    notificationId: "notification:activity",
    activity: "sent-marked",
  });

  const auditPage = await new DevelopmentInMemoryAuditRepository(storage).list({
    limit: 10,
  });
  assert.deepEqual(
    auditPage.items.map((event) => event.detail).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    ),
    [copied.auditEvent.detail, sent.auditEvent.detail].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    ),
  );
  const delayedCopyReplay = await new DevelopmentInMemoryManualNotificationRepository(
    storage,
  ).recordCopyWithAudit(copyRequest);
  assert.deepEqual(delayedCopyReplay, { ...copied, replayed: true });
  assert.equal((await new DevelopmentInMemoryAuditRepository(storage).list({
    limit: 10,
  })).items.length, 2);

  const replayWithFreshServerTime = await repository.recordCopyWithAudit({
    ...copyRequest,
    occurredAt: "2026-04-01T09:01:30.000Z",
  });
  assert.deepEqual(replayWithFreshServerTime, {
    ...copied,
    replayed: true,
  });
});

test("manual notification activity failure changes neither history nor audit", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const repository = new DevelopmentInMemoryManualNotificationRepository(storage);
  await repository.create({
    operationId: "notification-operation:atomic-create",
    template: templateInput("notification:atomic-activity"),
  });
  const failing = new DevelopmentInMemoryManualNotificationRepository(
    new RejectAuditMutationAdapter(storage),
  );

  await expectStorageFailure(
    () => failing.markSentWithAudit({
      operationId: "notification-operation:atomic-sent",
      notificationId: "notification:atomic-activity",
      expectedRevision: 1,
      ownerSubject: OWNER.subject,
      occurredAt: SENT_AT,
    }),
    "UNAVAILABLE",
  );
  const unchanged = await repository.get("notification:atomic-activity");
  assert.equal(unchanged?.revision, 1);
  assert.equal(unchanged?.record.sentMarker, null);
  assert.deepEqual(
    (await new DevelopmentInMemoryAuditRepository(storage).list({ limit: 10 }))
      .items,
    [],
  );
});

test("manual notification activity recovers a committed response loss exactly once", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const repository = new DevelopmentInMemoryManualNotificationRepository(storage);
  await repository.create({
    operationId: "notification-operation:response-loss-create",
    template: templateInput("notification:response-loss"),
  });
  const request = {
    operationId: "notification-operation:response-loss-copy",
    notificationId: "notification:response-loss",
    expectedRevision: 1,
    ownerSubject: OWNER.subject,
    occurredAt: COPIED_AT,
  };
  const failed = new DevelopmentInMemoryManualNotificationRepository(
    new CommitThenFailOnceAdapter(
      storage,
      "notification-operation:response-loss-copy",
    ),
  );
  const recoveredResponseLoss = await failed.recordCopyWithAudit(request);
  assert.equal(recoveredResponseLoss.replayed, true);
  assert.equal(recoveredResponseLoss.revision, 2);

  const reopened = new DevelopmentInMemoryManualNotificationRepository(storage);
  const committed = await reopened.get("notification:response-loss");
  assert.equal(committed?.revision, 2);
  assert.equal(committed?.record.copyEvidence.length, 1);
  const replay = await reopened.recordCopyWithAudit({
    ...request,
    occurredAt: "2026-04-01T09:30:00.000Z",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, 2);
  assert.equal(replay.record.copyEvidence[0]?.copiedAt, COPIED_AT);
  assert.equal(
    (await new DevelopmentInMemoryAuditRepository(storage).list({ limit: 10 }))
      .items.length,
    1,
  );
});

test("notification retries bind one operation to its introducing revision", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const repository = new DevelopmentInMemoryManualNotificationRepository(storage);
  await repository.create({
    operationId: "notification-operation:revision-binding-create",
    template: templateInput("notification:revision-binding"),
  });
  const copyRequest = {
    operationId: "notification-operation:revision-binding-copy-a",
    notificationId: "notification:revision-binding",
    expectedRevision: 1,
    ownerSubject: OWNER.subject,
    occurredAt: COPIED_AT,
  };
  const copied = await repository.recordCopyWithAudit(copyRequest);
  assert.equal(copied.revision, 2);
  await repository.markSentWithAudit({
    operationId: "notification-operation:revision-binding-sent-b",
    notificationId: "notification:revision-binding",
    expectedRevision: 2,
    ownerSubject: OWNER.subject,
    occurredAt: SENT_AT,
  });

  const reopened = new DevelopmentInMemoryManualNotificationRepository(storage);
  const [exact, changed] = await Promise.all([
    reopened.recordCopyWithAudit({
      ...copyRequest,
      occurredAt: "2026-04-01T09:30:00.000Z",
    }),
    captureStorageFailure(() =>
      new DevelopmentInMemoryManualNotificationRepository(storage)
        .recordCopyWithAudit({
          ...copyRequest,
          expectedRevision: 2,
          occurredAt: "2026-04-01T09:31:00.000Z",
        })
    ),
  ]);
  assert.equal(exact.replayed, true);
  assert.equal(exact.revision, 2);
  assert.equal(exact.record.sentMarker, null);
  assert.equal(changed.code, "CONFLICT");

  const current = await reopened.get("notification:revision-binding");
  assert.equal(current?.revision, 3);
  assert.equal(current?.record.copyEvidence.length, 1);
  assert.equal(current?.record.sentMarker?.sentAt, SENT_AT);
  assert.equal(
    (await new DevelopmentInMemoryAuditRepository(storage).list({ limit: 10 }))
      .items.length,
    2,
  );
});

test("overlapping exact notification activity returns two stable successes", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const repository = new DevelopmentInMemoryManualNotificationRepository(storage);
  await repository.create({
    operationId: "notification-operation:concurrent-create",
    template: templateInput("notification:concurrent"),
  });
  const request = {
    operationId: "notification-operation:concurrent-copy",
    notificationId: "notification:concurrent",
    expectedRevision: 1,
    ownerSubject: OWNER.subject,
  };

  const results = await Promise.all([
    repository.recordCopyWithAudit({ ...request, occurredAt: COPIED_AT }),
    new DevelopmentInMemoryManualNotificationRepository(storage)
      .recordCopyWithAudit({
        ...request,
        occurredAt: "2026-04-01T09:01:30.000Z",
      }),
  ]);
  assert.deepEqual(results.map(({ revision }) => revision), [2, 2]);
  assert.equal(results.filter(({ replayed }) => replayed).length, 1);
  assert.equal(
    new Set(results.map(({ record }) => record.copyEvidence[0]?.copiedAt)).size,
    1,
  );
  assert.equal((await repository.get("notification:concurrent"))?.revision, 2);
  assert.equal(
    (await new DevelopmentInMemoryAuditRepository(storage).list({ limit: 10 }))
      .items.length,
    1,
  );

  await expectStorageFailure(
    () => repository.markSentWithAudit({
      ...request,
      occurredAt: SENT_AT,
    }),
    "CONFLICT",
  );
});

test("manual notification activity preserves the template owner boundary", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const repository = new DevelopmentInMemoryManualNotificationRepository(storage);
  await repository.create({
    operationId: "notification-operation:owner-boundary-create",
    template: templateInput("notification:owner-boundary"),
  });

  await expectStorageFailure(
    () => repository.recordCopyWithAudit({
      operationId: "notification-operation:owner-boundary-copy",
      notificationId: "notification:owner-boundary",
      expectedRevision: 1,
      ownerSubject: "issuer.invalid/replacement-owner",
      occurredAt: COPIED_AT,
    }),
    "PRECONDITION_FAILED",
  );
  assert.equal((await repository.get("notification:owner-boundary"))?.revision, 1);
  assert.deepEqual(
    (await new DevelopmentInMemoryAuditRepository(storage).list({ limit: 10 }))
      .items,
    [],
  );
});

test("manual notification collection rejects corrupt finite pages", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const repository = new DevelopmentInMemoryManualNotificationRepository(storage);
  await repository.create({
    operationId: "notification-operation:page-create",
    template: templateInput("notification:page"),
  });
  const page = await storage.list({
    collection: "manual-notifications" as StorageKey["collection"],
    limit: 1,
  });
  const item = page.items[0];
  assert.ok(item);

  const malformedPages: readonly StoragePage[] = [
    { items: [item, item], nextCursor: null },
    { items: [], nextCursor: "cursor:next" as StorageCursor },
    { items: [item], nextCursor: "cursor:same" as StorageCursor },
    Object.assign({ items: [item], nextCursor: null }, { private: "hidden" }),
  ];
  for (const malformed of malformedPages) {
    const candidate = new DevelopmentInMemoryManualNotificationRepository(
      new ListResultAdapter(storage, malformed),
    );
    const request = malformed.nextCursor === "cursor:same"
      ? { limit: 2, cursor: "cursor:same" as StorageCursor }
      : { limit: 2 };
    await expectStorageFailure(() => candidate.list(request), "UNAVAILABLE");
  }

  await expectStorageFailure(
    () => repository.list({ limit: MAX_OWNER_NOTIFICATION_PAGE_SIZE + 1 }),
    "INVALID_REQUEST",
  );
  await expectStorageFailure(
    () => repository.list({
      limit: 1,
      cursor: "x".repeat(MAX_OWNER_NOTIFICATION_CURSOR_LENGTH + 1) as StorageCursor,
    }),
    "INVALID_REQUEST",
  );
});

test("manual notification writes require an exact closed transaction result", async () => {
  const malformedResults: readonly unknown[] = [
    { replayed: false, records: [] },
    { replayed: false, records: [null, null, null, null] },
    { replayed: "false", records: [null, null, null] },
    { replayed: false, records: [null, null, null], private: "hidden" },
    Object.assign(Object.create({ inherited: true }), {
      replayed: false,
      records: [null, null, null],
    }),
    { replayed: false, records: new Array(3) },
  ];
  for (const malformed of malformedResults) {
    const state = new MemoryStorageState();
    const storage = new DeterministicMemoryStorageAdapter(state, true);
    const repository = new DevelopmentInMemoryManualNotificationRepository(storage);
    await repository.create({
      operationId: "notification-operation:closed-result-create",
      template: templateInput("notification:closed-result"),
    });
    const candidate = new DevelopmentInMemoryManualNotificationRepository(
      new TransactionResultAdapter(storage, malformed),
    );
    await expectStorageFailure(
      () => candidate.recordCopyWithAudit({
        operationId: "notification-operation:closed-result-copy",
        notificationId: "notification:closed-result",
        expectedRevision: 1,
        ownerSubject: OWNER.subject,
        occurredAt: COPIED_AT,
      }),
      "UNAVAILABLE",
    );
    assert.equal((await repository.get("notification:closed-result"))?.revision, 1);
  }
});

test("manual notification storage failures retain only their fixed code", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const repository = new DevelopmentInMemoryManualNotificationRepository(storage);
  await repository.create({
    operationId: "notification-operation:redacted-failure-create",
    template: templateInput("notification:redacted-failure"),
  });
  const secret = "PRIVATE NOTIFICATION STORAGE CAUSE";
  const readFailure = await captureStorageFailure(() =>
    new DevelopmentInMemoryManualNotificationRepository(
      new FailingStorageAdapter(storage, "read", secret),
    ).get("notification:redacted-failure")
  );
  assert.equal(readFailure.code, "UNAVAILABLE");
  assert.equal(readFailure.cause, undefined);
  assert.doesNotMatch(String(readFailure), new RegExp(secret, "u"));

  const transactionFailure = await captureStorageFailure(() =>
    new DevelopmentInMemoryManualNotificationRepository(
      new FailingStorageAdapter(storage, "transact", secret),
    ).recordCopyWithAudit({
      operationId: "notification-operation:redacted-failure-copy",
      notificationId: "notification:redacted-failure",
      expectedRevision: 1,
      ownerSubject: OWNER.subject,
      occurredAt: COPIED_AT,
    })
  );
  assert.equal(transactionFailure.code, "UNAVAILABLE");
  assert.equal(transactionFailure.cause, undefined);
  assert.equal((await repository.get("notification:redacted-failure"))?.revision, 1);
});

test("repositories reject non-allowlisted evidence without serializing secrets", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const audits = new DevelopmentInMemoryAuditRepository(storage);
  const notifications = new DevelopmentInMemoryManualNotificationRepository(
    storage,
  );
  const secret = "synthetic-credential-must-not-be-serialized";

  await audits.append(auditIntent(
    "audit-event:valid-redacted-control",
    "audit-operation:valid-redacted-control",
    {
      kind: "resource-transition",
      resource: { type: "aggregate", id: "aggregate:redacted-control" },
      transition: "reconciled",
    },
  ));

  await expectStorageFailure(
    () => audits.append({
      ...auditIntent(
        "audit-event:redacted-export",
        "audit-operation:redacted-export",
        { kind: "export-created", exportType: "review-csv" },
      ),
      event: {
        ...auditIntent(
          "audit-event:redacted-export",
          "audit-operation:redacted-export",
          { kind: "export-created", exportType: "review-csv" },
        ).event,
        detail: {
          kind: "export-created",
          exportType: "review-csv",
          exportContent: secret,
          privateNote: secret,
          internalCause: secret,
        },
      },
    }),
    "INVALID_REQUEST",
  );
  await expectStorageFailure(
    () => notifications.create({
      operationId: "notification-operation:redacted-template",
      template: {
        ...templateInput("notification:redacted"),
        credential: secret,
        privateNote: secret,
      },
    }),
    "INVALID_REQUEST",
  );
  assert.doesNotMatch(
    JSON.stringify([...state.records.values()]),
    /credential|privateNote|exportContent|internalCause|synthetic-/u,
  );

  const denied = new StorageFailure("NOT_FOUND", {
    cause: { credential: secret, internalCause: secret },
  });
  assert.doesNotMatch(
    JSON.stringify(toPublicStorageFailure(denied)),
    /credential|internalCause|synthetic-/u,
  );
});

test("private templates and copy evidence enforce their repository bounds", async () => {
  const state = new MemoryStorageState();
  const repository = new DevelopmentInMemoryManualNotificationRepository(
    new DeterministicMemoryStorageAdapter(state, true),
  );

  await repository.create({
    operationId: "notification-operation:bounded-create",
    template: {
      ...templateInput("notification:bounded"),
      subjectLine: "s".repeat(200),
      body: "b".repeat(20_000),
    },
  });
  await expectStorageFailure(
    () => repository.create({
      operationId: "notification-operation:oversized-create",
      template: {
        ...templateInput("notification:oversized"),
        body: "b".repeat(20_001),
      },
    }),
    "INVALID_REQUEST",
  );

  let revision = 1;
  for (let index = 1; index <= 64; index += 1) {
    const copied = await repository.recordCopy({
      operationId: `notification-operation:bounded-copy-${index}`,
      notificationId: "notification:bounded",
      expectedRevision: revision,
      evidence: {
        id: `notification-copy:bounded-${index}`,
        copiedAt: new Date(
          Date.parse("2026-04-01T10:00:00.000Z") + index * 60_000,
        ).toISOString(),
        copiedBy: OWNER,
      },
    });
    revision = copied.revision;
  }
  assert.equal(revision, 65);
  await expectStorageFailure(
    () => repository.recordCopy({
      operationId: "notification-operation:bounded-copy-65",
      notificationId: "notification:bounded",
      expectedRevision: revision,
      evidence: {
        id: "notification-copy:bounded-65",
        copiedAt: "2026-04-01T11:05:00.000Z",
        copiedBy: OWNER,
      },
    }),
    "INVALID_REQUEST",
  );
  assert.equal(
    (await new DevelopmentInMemoryManualNotificationRepository(
      new DeterministicMemoryStorageAdapter(state, true),
    ).get("notification:bounded"))?.record.copyEvidence.length,
    64,
  );

  const sent = await repository.markSent({
    operationId: "notification-operation:bounded-sent",
    notificationId: "notification:bounded",
    expectedRevision: revision,
    marker: {
      id: "notification-sent:bounded",
      sentAt: "2026-04-01T12:00:00.000Z",
      sentBy: OWNER,
    },
  });
  assert.equal(sent.revision, 66);
  const countedStorage = new CountingReadAdapter(
    new DeterministicMemoryStorageAdapter(state, true),
  );
  const reopened = new DevelopmentInMemoryManualNotificationRepository(
    countedStorage,
  );
  assert.equal((await reopened.get("notification:bounded"))?.revision, 66);
  assert.equal(countedStorage.reads, MAX_MANUAL_NOTIFICATION_STORAGE_READS);
});

test("an oversized current notification fails before immutable history reads", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const repository = new DevelopmentInMemoryManualNotificationRepository(storage);
  await repository.create({
    operationId: "notification-operation:oversized-head-create",
    template: templateInput("notification:oversized-head"),
  });
  const currentEntry = [...state.records.entries()].find(([, record]) =>
    record.key.collection === "manual-notifications"
  );
  assert.ok(currentEntry);
  const [key, current] = currentEntry;
  state.records.set(key, {
    key: current.key,
    revision: 67,
    value: { ...current.value, revision: 67 },
  });
  const counted = new CountingReadAdapter(storage);
  await expectStorageFailure(
    () => new DevelopmentInMemoryManualNotificationRepository(counted).get(
      "notification:oversized-head",
    ),
    "UNAVAILABLE",
  );
  assert.equal(counted.reads, 1);
});

function createAuditFixture(): AuditRepositoryContractFixture {
  const existing = new MemoryStorageState();
  const missing = new MemoryStorageState();
  const ownerStorage = new DeterministicMemoryStorageAdapter(existing, true);
  return {
    owner: new DevelopmentInMemoryAuditRepository(ownerStorage),
    reopenOwner: () => new DevelopmentInMemoryAuditRepository(ownerStorage),
    deniedExisting: new DevelopmentInMemoryAuditRepository(
      new DeterministicMemoryStorageAdapter(existing, false),
    ),
    deniedMissing: new DevelopmentInMemoryAuditRepository(
      new DeterministicMemoryStorageAdapter(missing, false),
    ),
  };
}

function createNotificationFixture(): ManualNotificationRepositoryContractFixture {
  const existing = new MemoryStorageState();
  const missing = new MemoryStorageState();
  const ownerStorage = new DeterministicMemoryStorageAdapter(existing, true);
  return {
    owner: new DevelopmentInMemoryManualNotificationRepository(ownerStorage),
    reopenOwner: () =>
      new DevelopmentInMemoryManualNotificationRepository(ownerStorage),
    deniedExisting: new DevelopmentInMemoryManualNotificationRepository(
      new DeterministicMemoryStorageAdapter(existing, false),
    ),
    deniedMissing: new DevelopmentInMemoryManualNotificationRepository(
      new DeterministicMemoryStorageAdapter(missing, false),
    ),
  };
}

function auditIntent(
  id: string,
  operationId: string,
  detail: Readonly<Record<string, unknown>>,
) {
  return {
    type: "append-audit-event",
    event: {
      id,
      operationId,
      occurredAt: GENERATED_AT,
      actor: OWNER,
      detail,
    },
  } as const;
}

function templateInput(id: string) {
  return {
    id,
    purposeId: "moderation-status-update",
    recipientSubject: "issuer.invalid/participant-subject",
    relatedResource: {
      type: "investment-indication",
      id: "indication:notification-subject",
    },
    subjectLine: "An application status update is available",
    body: "Please sign in to review the current status.",
    generatedAt: GENERATED_AT,
    generatedBy: OWNER,
  } as const;
}

async function expectStorageFailure(
  operation: () => Promise<unknown>,
  code: StorageFailure["code"],
): Promise<void> {
  const error = await captureStorageFailure(operation);
  assert.equal(error.code, code);
}

async function captureStorageFailure(
  operation: () => Promise<unknown>,
): Promise<StorageFailure> {
  try {
    await operation();
  } catch (error) {
    assert.equal(error instanceof StorageFailure, true);
    return error as StorageFailure;
  }
  assert.fail("Expected a StorageFailure.");
}

class MemoryStorageState {
  readonly records = new Map<string, StorageRecord>();
  readonly operations = new Map<
    string,
    Readonly<{ fingerprint: string; result: StorageTransactionResult }>
  >();
}

class RejectAuditMutationAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  read(key: StorageKey): Promise<StorageRecord | null> {
    return this.#delegate.read(key);
  }

  list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    return this.#delegate.list(request);
  }

  transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    if (request.mutations.some((mutation) =>
      mutation.type === "put" && mutation.value.kind === "audit-event"
    )) {
      throw new StorageFailure("UNAVAILABLE");
    }
    return this.#delegate.transact(request);
  }
}

class CommitThenFailOnceAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #operationId: string;
  #failed = false;

  constructor(delegate: StorageAdapter, operationId: string) {
    this.#delegate = delegate;
    this.#operationId = operationId;
  }

  read(key: StorageKey): Promise<StorageRecord | null> {
    return this.#delegate.read(key);
  }

  list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    return this.#delegate.list(request);
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    const result = await this.#delegate.transact(request);
    if (!this.#failed && request.operationId === this.#operationId) {
      this.#failed = true;
      throw new StorageFailure("UNAVAILABLE");
    }
    return result;
  }
}

class CountingReadAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  reads = 0;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  read(key: StorageKey): Promise<StorageRecord | null> {
    this.reads += 1;
    return this.#delegate.read(key);
  }

  list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    return this.#delegate.list(request);
  }

  transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    return this.#delegate.transact(request);
  }
}

class ListResultAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #page: StoragePage;

  constructor(delegate: StorageAdapter, page: StoragePage) {
    this.#delegate = delegate;
    this.#page = page;
  }

  read(key: StorageKey): Promise<StorageRecord | null> {
    return this.#delegate.read(key);
  }

  async list(): Promise<StoragePage> {
    return this.#page;
  }

  transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    return this.#delegate.transact(request);
  }
}

class TransactionResultAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #result: unknown;

  constructor(delegate: StorageAdapter, result: unknown) {
    this.#delegate = delegate;
    this.#result = result;
  }

  read(key: StorageKey): Promise<StorageRecord | null> {
    return this.#delegate.read(key);
  }

  list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    return this.#delegate.list(request);
  }

  async transact(): Promise<StorageTransactionResult> {
    return this.#result as StorageTransactionResult;
  }
}

class FailingStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #operation: "read" | "transact";
  readonly #secret: string;

  constructor(
    delegate: StorageAdapter,
    operation: "read" | "transact",
    secret: string,
  ) {
    this.#delegate = delegate;
    this.#operation = operation;
    this.#secret = secret;
  }

  read(key: StorageKey): Promise<StorageRecord | null> {
    if (this.#operation === "read") {
      throw new StorageFailure("UNAVAILABLE", {
        cause: new Error(this.#secret),
      });
    }
    return this.#delegate.read(key);
  }

  list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    return this.#delegate.list(request);
  }

  transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    if (this.#operation === "transact") {
      throw new StorageFailure("UNAVAILABLE", {
        cause: new Error(this.#secret),
      });
    }
    return this.#delegate.transact(request);
  }
}

class DeterministicMemoryStorageAdapter implements StorageAdapter {
  readonly #state: MemoryStorageState;
  readonly #permitted: boolean;

  constructor(state: MemoryStorageState, permitted: boolean) {
    this.#state = state;
    this.#permitted = permitted;
  }

  async read(key: StorageKey): Promise<StorageRecord | null> {
    if (!this.#permitted) return null;
    return cloneRecord(this.#state.records.get(storageKeyString(key)) ?? null);
  }

  async list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    assertStorageListBoundary(request);
    if (!this.#permitted) return { items: [], nextCursor: null };

    const start = request.cursor === undefined ? 0 : parseCursor(request.cursor);
    const all = [...this.#state.records.values()]
      .filter(({ key }) => key.collection === request.collection)
      .sort((left, right) => left.key.id.localeCompare(right.key.id));
    if (start < 0 || start > all.length) {
      throw new StorageFailure("INVALID_REQUEST");
    }
    const items = all.slice(start, start + request.limit).map(cloneRecord);
    const next = start + items.length;
    return {
      items: items.filter((item): item is StorageRecord => item !== null),
      nextCursor: next < all.length
        ? (`audit-notification-cursor:${next}` as StorageCursor)
        : null,
    };
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    assertStorageTransactionBoundary(request);
    if (!this.#permitted) throw new StorageFailure("NOT_FOUND");

    const operationKey = request.operationId as string;
    const fingerprint = JSON.stringify(request);
    const prior = this.#state.operations.get(operationKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new StorageFailure("CONFLICT");
      }
      return cloneResult(prior.result, true);
    }

    for (const mutation of request.mutations) {
      const current = this.#state.records.get(storageKeyString(mutation.key));
      if (mutation.type === "check") {
        if (
          mutation.expectedRevision === null
            ? current !== undefined
            : current?.revision !== mutation.expectedRevision
        ) throw new StorageFailure("PRECONDITION_FAILED");
      } else if (mutation.expectedRevision === null) {
        if (current) throw new StorageFailure("CONFLICT");
      } else if (!current || current.revision !== mutation.expectedRevision) {
        throw new StorageFailure("PRECONDITION_FAILED");
      }
    }

    const nextRecords = new Map(this.#state.records);
    const resultRecords: (StorageRecord | null)[] = [];
    for (const mutation of request.mutations) {
      const key = storageKeyString(mutation.key);
      const current = nextRecords.get(key);
      if (mutation.type === "check") {
        resultRecords.push(cloneRecord(current ?? null));
        continue;
      }
      if (mutation.type === "delete") {
        nextRecords.delete(key);
        resultRecords.push(null);
        continue;
      }
      const record = freezeRecord({
        key: mutation.key,
        revision: (current?.revision ?? 0) + 1,
        value: mutation.value,
      });
      nextRecords.set(key, record);
      resultRecords.push(record);
    }

    this.#state.records.clear();
    for (const [key, record] of nextRecords) this.#state.records.set(key, record);
    const result = Object.freeze({
      replayed: false,
      records: Object.freeze(resultRecords.map(cloneRecord)),
    });
    this.#state.operations.set(operationKey, { fingerprint, result });
    return cloneResult(result, false);
  }
}

function parseCursor(cursor: StorageCursor): number {
  const match = /^audit-notification-cursor:(\d+)$/.exec(cursor);
  if (!match) throw new StorageFailure("INVALID_REQUEST");
  return Number.parseInt(match[1], 10);
}

function cloneResult(
  result: StorageTransactionResult,
  replayed: boolean,
): StorageTransactionResult {
  return Object.freeze({
    replayed,
    records: Object.freeze(result.records.map(cloneRecord)),
  });
}

function cloneRecord(record: StorageRecord | null): StorageRecord | null {
  if (record === null) return null;
  return freezeRecord({
    key: record.key,
    revision: record.revision,
    value: record.value,
  });
}

function freezeRecord(input: Readonly<{
  key: StorageKey;
  revision: number;
  value: StorageDocument;
}>): StorageRecord {
  return Object.freeze({
    key: Object.freeze({ ...input.key }),
    revision: input.revision,
    value: deepFreeze(cloneDocument(input.value)),
  });
}

function cloneDocument(value: StorageDocument): StorageDocument {
  return JSON.parse(JSON.stringify(value)) as StorageDocument;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
