import assert from "node:assert/strict";
import test from "node:test";

import {
  StorageFailure,
  assertStorageListBoundary,
  assertStorageTransactionBoundary,
  storageKeyString,
  toPublicStorageFailure,
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
  CAMPAIGN_OPERATION_INTENT_MAX_RECORD_BYTES,
  DevelopmentInMemoryCampaignRepository,
  DevelopmentInMemoryPublicCampaignPresentationReader,
  parseCampaignSetup,
} from "../repositories/in-memory-campaign-repository.ts";
import { DevelopmentInMemoryAuditRepository } from "../repositories/in-memory-audit-notification-repositories.ts";
import { syntheticPublicCampaign } from "./fixtures/public-campaign.ts";
import {
  FIRST_CAMPAIGN_SAVE as FIRST_SAVE,
  SECOND_CAMPAIGN_SAVE as SECOND_SAVE,
  campaignSaveRequest as saveRequest,
  captureStorageFailure,
  explicitCampaignSetup as explicitSetup,
  verifyCampaignRepositoryContract,
} from "./support/campaign-repository-contract.ts";

test("adapter-backed development repository passes the campaign contract", async () => {
  await verifyCampaignRepositoryContract(() => {
    const state = new MemoryStorageState();
    const ownerStorage = new DeterministicMemoryStorageAdapter(state, true);
    return {
      owner: new DevelopmentInMemoryCampaignRepository(ownerStorage),
      outsider: new DevelopmentInMemoryCampaignRepository(
        new DeterministicMemoryStorageAdapter(state, false),
      ),
      reopenOwner: () => new DevelopmentInMemoryCampaignRepository(ownerStorage),
    };
  });
});

test("setup parsing requires every deployment choice and supplies no defaults", async () => {
  const missing = parseCampaignSetup({});
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.deepEqual(missing.issues, [
    { code: "required", path: "setup.publicCampaign" },
    { code: "required", path: "setup.phases" },
    { code: "required", path: "setup.amountAggregate" },
    { code: "required", path: "setup.campaignPolicy" },
  ]);

  const noPhase = parseCampaignSetup({
    ...explicitSetup(),
    phases: [],
  });
  assert.deepEqual(noPhase, {
    ok: false,
    issues: [{ code: "out_of_range", path: "setup.phases" }],
  });

  const parsed = parseCampaignSetup(explicitSetup());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.publicCampaign.id, syntheticPublicCampaign.id);
  assert.deepEqual(parsed.value.phases[0]?.enabledParticipationPaths, [
    "founder",
    "investor",
  ]);
  assert.deepEqual(parsed.value.phases[0]?.countryEligibility, {
    mode: "allow",
    countries: ["FI", "SE"],
  });
  assert.equal(parsed.value.amountAggregate.amount.currency, "SEK");
  assert.equal(parsed.value.amountAggregate.publicAggregate.visibility, "non_zero");

  const state = new MemoryStorageState();
  const repository = new DevelopmentInMemoryCampaignRepository(
    new DeterministicMemoryStorageAdapter(state, true),
  );
  assert.equal(repository.storageKind, "development-in-memory");
  const error = await captureStorageFailure(() => repository.saveSetup(
    saveRequest({
      operationId: "campaign-operation:invalid",
      recordedAt: FIRST_SAVE,
      expectedRevision: null,
      setup: {},
    }),
  ));
  assert.equal(error.code, "INVALID_REQUEST");
  assert.equal(state.transactionCalls, 0);
  assert.equal(await repository.readSetup(), null);
});

test("setup revisions and their adapter records remain immutable", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state, true);
  const repository = new DevelopmentInMemoryCampaignRepository(adapter);

  const first = await repository.saveSetup(saveRequest({
    operationId: "campaign-operation:immutable-create",
    recordedAt: FIRST_SAVE,
    expectedRevision: null,
    setup: explicitSetup(),
  }));
  const second = await repository.saveSetup(saveRequest({
    operationId: "campaign-operation:immutable-update",
    recordedAt: SECOND_SAVE,
    expectedRevision: 1,
    setup: (() => {
      const setup = explicitSetup({
        campaignName: "Northstar Systems",
        phaseState: "closed",
      });
      return {
        ...setup,
        campaignPolicy: {
          ...setup.campaignPolicy,
          notices: {
            ...setup.campaignPolicy.notices,
            processEmail: "Updated required process message.",
          },
        },
      };
    })(),
  }));

  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.setup), true);
  assert.equal(Object.isFrozen(first.setup.phases), true);
  assert.equal(Object.isFrozen(first.setup.phases[0]?.countryEligibility), true);
  assert.equal(Object.isFrozen(first.setup.campaignPolicy), true);
  assert.equal(
    Object.isFrozen(first.setup.campaignPolicy.founderContributionChoices),
    true,
  );
  assert.equal(first.setup.publicCampaign.name, syntheticPublicCampaign.name);
  assert.equal(second.setup.publicCampaign.name, "Northstar Systems");
  assert.notEqual(
    first.setup.campaignPolicy.notices.processEmail,
    second.setup.campaignPolicy.notices.processEmail,
  );

  const history = await repository.listSetupHistory({ limit: 10 });
  assert.deepEqual(history.items.map((item) => ({
    revision: item.revision,
    name: item.setup.publicCampaign.name,
    state: item.setup.phases[0]?.state,
    processEmail: item.setup.campaignPolicy.notices.processEmail,
  })), [
    {
      revision: 1,
      name: syntheticPublicCampaign.name,
      state: "open",
      processEmail: explicitSetup().campaignPolicy.notices.processEmail,
    },
    {
      revision: 2,
      name: "Northstar Systems",
      state: "closed",
      processEmail: "Updated required process message.",
    },
  ]);
  assert.equal(Object.isFrozen(history), true);
  assert.equal(Object.isFrozen(history.items), true);
  assert.equal(
    [...state.records.values()].filter((record) =>
      record.key.collection === "campaign-setup-chunks"
    ).length,
    2,
  );
  assert.equal(state.records.size, 10);

  const reopened = new DevelopmentInMemoryCampaignRepository(adapter);
  assert.deepEqual(await reopened.readSetup(), second);
  assert.equal(state.readCalls > 0, true);
  assert.equal(state.listCalls > 0, true);
});

test("legacy private campaign setup records fail closed", async () => {
  const state = new MemoryStorageState();
  const repository = new DevelopmentInMemoryCampaignRepository(
    new DeterministicMemoryStorageAdapter(state, true),
  );
  await repository.saveSetup(saveRequest({
    operationId: "campaign-operation:legacy-schema",
    recordedAt: FIRST_SAVE,
    expectedRevision: null,
    setup: explicitSetup(),
  }));

  const entry = [...state.records.entries()].find(([, record]) =>
    record.key.collection === "campaign-setup-current"
  );
  assert(entry);
  const [key, record] = entry;
  state.records.set(key, freezeRecord({
    key: record.key,
    revision: record.revision,
    value: { ...record.value, schemaVersion: 2 },
  }));

  const failure = await captureStorageFailure(() => repository.readSetup());
  assert.equal(failure.code, "UNAVAILABLE");
});

test("operation IDs are retry-stable and cannot be reused for changed setup", async () => {
  const state = new MemoryStorageState();
  const repository = new DevelopmentInMemoryCampaignRepository(
    new DeterministicMemoryStorageAdapter(state, true),
  );
  const request = saveRequest({
    operationId: "campaign-operation:retry",
    recordedAt: FIRST_SAVE,
    expectedRevision: null,
    setup: explicitSetup(),
  });

  const first = await repository.saveSetup(request);
  assert.deepEqual(await repository.saveSetup(request), first);
  const conflict = await captureStorageFailure(() => repository.saveSetup(
    saveRequest({
      ...request,
      setup: explicitSetup({ campaignName: "Changed Retry" }),
    }),
  ));
  assert.equal(conflict.code, "CONFLICT");
  assert.equal((await repository.listSetupHistory({ limit: 10 })).items.length, 1);
});

test("audited campaign creation atomically records one unpublished draft", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state, true);
  const repository = new DevelopmentInMemoryCampaignRepository(adapter);
  const publicReader = new DevelopmentInMemoryPublicCampaignPresentationReader(adapter);
  const request = {
    operationId: "campaign-operation:audited-create",
    ownerSubject: "owner-subject",
    recordedAt: FIRST_SAVE,
    expectedRevision: null,
    setup: {
      ...explicitSetup(),
      publicCampaign: { ...syntheticPublicCampaign, published: false },
    },
    transition: "created" as const,
  };

  const first = await repository.saveSetupWithAudit(request);
  assert.equal(first.campaign.revision, 1);
  assert.equal(first.campaign.setup.publicCampaign.published, false);
  assert.equal(first.replayed, false);
  assert.deepEqual(first.auditEvent.detail, {
    kind: "resource-transition",
    resource: {
      type: "campaign",
      id: `campaign:${syntheticPublicCampaign.id}`,
    },
    transition: "created",
  });
  assert.equal(await publicReader.readPublishedCampaign(), null);
  assert.deepEqual(
    (await repository.listSetupHistory({ limit: 10 })).items,
    [first.campaign],
  );

  const replay = await repository.saveSetupWithAudit(request);
  assert.deepEqual(replay.campaign, first.campaign);
  assert.deepEqual(replay.auditEvent, first.auditEvent);
  assert.equal(replay.replayed, true);
  assert.deepEqual(
    (await new DevelopmentInMemoryAuditRepository(adapter).list({ limit: 10 }))
      .items,
    [first.auditEvent],
  );
  assert.equal(
    [...state.records.values()].filter((record) =>
      record.key.collection === "campaign-setup-chunks"
    ).length,
    1,
  );
  assert.equal(state.records.size, 7);
});

test("schema-4 audited saves replay after schema-5 publication without changing current state", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state, true);
  const repository = new DevelopmentInMemoryCampaignRepository(adapter);
  const legacyRequest = {
    operationId: "campaign-operation:legacy-cross-version",
    ownerSubject: "owner-subject",
    recordedAt: FIRST_SAVE,
    expectedRevision: null,
    setup: {
      ...explicitSetup(),
      publicCampaign: { ...syntheticPublicCampaign, published: false },
    },
    transition: "created" as const,
  };
  const legacyResult = await repository.saveSetupWithAudit(legacyRequest);
  downgradeCommittedPublicPresentationToSchema4(
    state,
    legacyRequest.operationId,
  );

  const currentResult = await repository.saveSetupWithAudit({
    operationId: "campaign-operation:schema-5-publication",
    ownerSubject: "owner-subject",
    recordedAt: SECOND_SAVE,
    expectedRevision: 1,
    setup: {
      ...legacyRequest.setup,
      publicCampaign: { ...syntheticPublicCampaign, published: true },
    },
    transition: "published",
  });
  assert.equal(currentResult.campaign.revision, 2);
  const publicReader = new DevelopmentInMemoryPublicCampaignPresentationReader(
    adapter,
  );
  assert.deepEqual(await publicReader.readPublishedProjection(), {
    revision: 2,
    publicCampaign: syntheticPublicCampaign,
    amountAggregate: currentResult.campaign.setup.amountAggregate,
  });

  const recordsBeforeReplay = JSON.stringify([...state.records.entries()]);
  const operationsBeforeReplay = JSON.stringify([...state.operations.entries()]);
  const unverified = await captureStorageFailure(() =>
    new DevelopmentInMemoryCampaignRepository(
      withNonReplayLegacyResult(adapter),
    ).saveSetupWithAudit(legacyRequest)
  );
  assert.equal(unverified.code, "UNAVAILABLE");
  assert.equal(JSON.stringify([...state.records.entries()]), recordsBeforeReplay);
  assert.equal(
    JSON.stringify([...state.operations.entries()]),
    operationsBeforeReplay,
  );

  const replay = await new DevelopmentInMemoryCampaignRepository(adapter)
    .saveSetupWithAudit(legacyRequest);

  assert.deepEqual(replay.campaign, legacyResult.campaign);
  assert.deepEqual(replay.auditEvent, legacyResult.auditEvent);
  assert.equal(replay.replayed, true);
  assert.equal((await repository.readSetup())?.revision, 2);
  assert.equal(
    (await publicReader.readPublishedProjection())?.revision,
    2,
  );
  assert.equal(JSON.stringify([...state.records.entries()]), recordsBeforeReplay);
  assert.equal(
    JSON.stringify([...state.operations.entries()]),
    operationsBeforeReplay,
  );
  assert.equal(
    (await new DevelopmentInMemoryAuditRepository(adapter).list({ limit: 10 }))
      .items.length,
    2,
  );
});

test("audited campaign creation rejects invalid and changed transitions", async () => {
  for (const [label, setup, transition] of [
    [
      "mislabeled",
      { ...explicitSetup(), publicCampaign: { ...syntheticPublicCampaign, published: false } },
      "updated",
    ],
    ["published", explicitSetup(), "created"],
  ] as const) {
    const state = new MemoryStorageState();
    const repository = new DevelopmentInMemoryCampaignRepository(
      new DeterministicMemoryStorageAdapter(state, true),
    );
    const failure = await captureStorageFailure(() =>
      repository.saveSetupWithAudit({
        operationId: `campaign-operation:invalid-create-${label}`,
        ownerSubject: "owner-subject",
        recordedAt: FIRST_SAVE,
        expectedRevision: null,
        setup,
        transition,
      })
    );
    assert.equal(failure.code, "INVALID_REQUEST");
    assert.equal(state.transactionCalls, 0);
    assert.equal(await repository.readSetup(), null);
  }

  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state, true);
  const repository = new DevelopmentInMemoryCampaignRepository(adapter);
  const request = {
    operationId: "campaign-operation:stable-create",
    ownerSubject: "owner-subject",
    recordedAt: FIRST_SAVE,
    expectedRevision: null,
    setup: {
      ...explicitSetup(),
      publicCampaign: { ...syntheticPublicCampaign, published: false },
    },
    transition: "created" as const,
  };
  const first = await repository.saveSetupWithAudit(request);

  const stale = await captureStorageFailure(() =>
    repository.saveSetupWithAudit({
      ...request,
      operationId: "campaign-operation:stale-create",
    })
  );
  assert.equal(stale.code, "PRECONDITION_FAILED");

  const changedRetry = await captureStorageFailure(() =>
    repository.saveSetupWithAudit({
      ...request,
      setup: {
        ...request.setup,
        publicCampaign: {
          ...request.setup.publicCampaign,
          name: "Changed retry",
        },
      },
    })
  );
  assert.equal(changedRetry.code, "CONFLICT");
  assert.deepEqual(await repository.readSetup(), first.campaign);
  assert.deepEqual(
    (await repository.listSetupHistory({ limit: 10 })).items,
    [first.campaign],
  );
  assert.deepEqual(
    (await new DevelopmentInMemoryAuditRepository(adapter).list({ limit: 10 }))
      .items,
    [first.auditEvent],
  );
});

test("an initial audit failure leaves only an intent and unreachable immutable setup chunks", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state, true, true);
  const repository = new DevelopmentInMemoryCampaignRepository(adapter);
  const failure = await captureStorageFailure(() =>
    repository.saveSetupWithAudit({
      operationId: "campaign-operation:failed-audited-create",
      ownerSubject: "owner-subject",
      recordedAt: FIRST_SAVE,
      expectedRevision: null,
      setup: {
        ...explicitSetup(),
        publicCampaign: { ...syntheticPublicCampaign, published: false },
      },
      transition: "created",
    })
  );

  assert.equal(failure.code, "UNAVAILABLE");
  assert.equal(await repository.readSetup(), null);
  assert.equal(await repository.findSetupByOperationId(
    "campaign-operation:failed-audited-create",
  ), null);
  assert.deepEqual(await repository.listSetupHistory({ limit: 10 }), {
    items: [],
    nextCursor: null,
  });
  assert.deepEqual(
    await new DevelopmentInMemoryAuditRepository(adapter).list({ limit: 10 }),
    { items: [], nextCursor: null },
  );
  assert.equal(state.records.size, 2);
  assert.equal(
    [...state.records.values()].every((record) =>
      record.key.collection === "campaign-setup-intents" ||
      record.key.collection === "campaign-setup-chunks"
    ),
    true,
  );
});

test("campaign transactions reject a compact malformed result matrix", async (context) => {
  const commonCorruptions: readonly TransactionResultCorruption[] = [
    {
      name: "custom result prototype",
      corrupt: (result) => withCustomObjectPrototype(result),
    },
    {
      name: "custom records array prototype",
      corrupt: (result) => ({
        ...result,
        records: withCustomArrayPrototype(result.records),
      }),
    },
    {
      name: "sparse records array",
      corrupt: (result) => ({
        ...result,
        records: sparseArray(result.records),
      }),
    },
    {
      name: "records array accessor",
      corrupt: (result) => ({
        ...result,
        records: withArrayAccessor(result.records, 0),
      }),
    },
    {
      name: "records array symbol",
      corrupt: (result) => ({
        ...result,
        records: withArraySymbol(result.records),
      }),
    },
    {
      name: "result accessor",
      corrupt: (result) => withObjectAccessor(result, "replayed"),
    },
    {
      name: "result symbol",
      corrupt: (result) => withObjectSymbol(result),
    },
    {
      name: "extra result member",
      corrupt: (result) => ({ ...result, ignored: true }),
    },
    {
      name: "non-boolean replayed",
      corrupt: (result) => ({ ...result, replayed: "false" }),
    },
    {
      name: "missing record",
      corrupt: (result) => ({
        ...result,
        records: result.records.slice(0, -1),
      }),
    },
    {
      name: "extra record",
      corrupt: (result) => ({
        ...result,
        records: [...result.records, result.records[0] ?? null],
      }),
    },
    {
      name: "null record",
      corrupt: (result) => replaceTransactionRecord(result, 0, null),
    },
    {
      name: "custom record prototype",
      corrupt: (result) => replaceTransactionRecord(
        result,
        0,
        withCustomObjectPrototype(requiredTransactionRecord(result, 0)),
      ),
    },
    {
      name: "custom key prototype",
      corrupt: (result) => {
        const record = requiredTransactionRecord(result, 0);
        return replaceTransactionRecord(result, 0, {
          ...record,
          key: withCustomObjectPrototype(record.key),
        });
      },
    },
    {
      name: "custom value prototype",
      corrupt: (result) => {
        const record = requiredTransactionRecord(result, 0);
        return replaceTransactionRecord(result, 0, {
          ...record,
          value: withCustomObjectPrototype(record.value),
        });
      },
    },
    {
      name: "record accessor",
      corrupt: (result) => replaceTransactionRecord(
        result,
        0,
        withObjectAccessor(requiredTransactionRecord(result, 0), "revision"),
      ),
    },
    {
      name: "key symbol",
      corrupt: (result) => {
        const record = requiredTransactionRecord(result, 0);
        return replaceTransactionRecord(result, 0, {
          ...record,
          key: withObjectSymbol(record.key),
        });
      },
    },
    {
      name: "value accessor",
      corrupt: (result) => {
        const record = requiredTransactionRecord(result, 0);
        return replaceTransactionRecord(result, 0, {
          ...record,
          value: withObjectAccessor(
            record.value,
            requiredObjectKey(record.value),
          ),
        });
      },
    },
    {
      name: "extra record member",
      corrupt: (result) => replaceTransactionRecord(
        result,
        0,
        { ...requiredTransactionRecord(result, 0), ignored: true },
      ),
    },
    {
      name: "wrong key",
      corrupt: (result) => {
        const record = requiredTransactionRecord(result, 0);
        return replaceTransactionRecord(result, 0, {
          ...record,
          key: { ...record.key, id: `${record.key.id}-wrong` },
        });
      },
    },
    {
      name: "wrong revision",
      corrupt: (result) => {
        const record = requiredTransactionRecord(result, 0);
        return replaceTransactionRecord(result, 0, {
          ...record,
          revision: record.revision + 1,
        });
      },
    },
    {
      name: "changed value",
      corrupt: (result) => {
        const record = requiredTransactionRecord(result, 0);
        return replaceTransactionRecord(result, 0, {
          ...record,
          value: { ...record.value, resultMismatch: true },
        });
      },
    },
  ];
  const finalCorruptions: readonly TransactionResultCorruption[] = [
    {
      name: "custom audit record prototype",
      corrupt: (result) => replaceTransactionRecord(
        result,
        4,
        withCustomObjectPrototype(requiredTransactionRecord(result, 4)),
      ),
    },
    {
      name: "custom audit key prototype",
      corrupt: (result) => {
        const record = requiredTransactionRecord(result, 4);
        return replaceTransactionRecord(result, 4, {
          ...record,
          key: withCustomObjectPrototype(record.key),
        });
      },
    },
    {
      name: "custom audit value prototype",
      corrupt: (result) => {
        const record = requiredTransactionRecord(result, 4);
        return replaceTransactionRecord(result, 4, {
          ...record,
          value: withCustomObjectPrototype(record.value),
        });
      },
    },
    {
      name: "audit record accessor",
      corrupt: (result) => replaceTransactionRecord(
        result,
        4,
        withObjectAccessor(requiredTransactionRecord(result, 4), "revision"),
      ),
    },
    {
      name: "audit key symbol",
      corrupt: (result) => {
        const record = requiredTransactionRecord(result, 4);
        return replaceTransactionRecord(result, 4, {
          ...record,
          key: withObjectSymbol(record.key),
        });
      },
    },
    {
      name: "audit value accessor",
      corrupt: (result) => {
        const record = requiredTransactionRecord(result, 4);
        return replaceTransactionRecord(result, 4, {
          ...record,
          value: withObjectAccessor(
            record.value,
            requiredObjectKey(record.value),
          ),
        });
      },
    },
    {
      name: "campaign and audit out of order",
      corrupt: (result) => {
        const records = [...result.records];
        [records[0], records[4]] = [records[4], records[0]];
        return { ...result, records };
      },
    },
    {
      name: "null audit record",
      corrupt: (result) => replaceTransactionRecord(result, 4, null),
    },
    {
      name: "extra audit record member",
      corrupt: (result) => replaceTransactionRecord(
        result,
        4,
        { ...requiredTransactionRecord(result, 4), ignored: true },
      ),
    },
    {
      name: "changed audit value",
      corrupt: (result) => {
        const record = requiredTransactionRecord(result, 4);
        return replaceTransactionRecord(result, 4, {
          ...record,
          value: { ...record.value, resultMismatch: true },
        });
      },
    },
  ];

  for (const stage of ["intent", "chunk", "final"] as const) {
    const corruptions = stage === "final"
      ? [...commonCorruptions, ...finalCorruptions]
      : commonCorruptions;
    for (const corruption of corruptions) {
      await context.test(`${stage}: ${corruption.name}`, async () => {
        const state = new MemoryStorageState();
        const adapter = new DeterministicMemoryStorageAdapter(state, true);
        const storage = corruptFirstCampaignTransactionResult(
          adapter,
          stage,
          corruption.corrupt,
        );
        const repository = new DevelopmentInMemoryCampaignRepository(storage);
        const request = {
          operationId: `campaign-operation:malformed-${stage}-${corruption.name.replaceAll(" ", "-")}`,
          ownerSubject: "owner-subject",
          recordedAt: FIRST_SAVE,
          expectedRevision: null,
          setup: {
            ...explicitSetup(),
            publicCampaign: { ...syntheticPublicCampaign, published: false },
          },
          transition: "created" as const,
        };

        const failure = await captureStorageFailure(() =>
          repository.saveSetupWithAudit(request)
        );
        assert.equal(failure.code, "UNAVAILABLE");
        const visibleRecords = [...state.records.values()].filter((record) =>
          record.key.collection === "campaign-setup-current" ||
          record.key.collection === "campaign-setup-history" ||
          record.key.collection === "campaign-setup-operations" ||
          record.key.collection === "campaign-public-presentation" ||
          record.key.collection === "audit-events"
        );
        assert.equal(visibleRecords.length, stage === "final" ? 5 : 0);

        const recovered = await new DevelopmentInMemoryCampaignRepository(adapter)
          .saveSetupWithAudit(request);
        assert.equal(recovered.replayed, stage === "final");
        assert.equal(recovered.campaign.revision, 1);
      });
    }
  }
});

test("campaign transactions accept canonical null-prototype JSON objects", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state, true);
  const nullPrototypeAdapter: StorageAdapter = Object.freeze({
    read: adapter.read.bind(adapter),
    list: adapter.list.bind(adapter),
    async transact(request: StorageTransactionRequest) {
      return toNullPrototypeJson(
        await adapter.transact(request),
      ) as StorageTransactionResult;
    },
  });
  const repository = new DevelopmentInMemoryCampaignRepository(
    nullPrototypeAdapter,
  );
  const result = await repository.saveSetupWithAudit({
    operationId: "campaign-operation:null-prototype-result",
    ownerSubject: "owner-subject",
    recordedAt: FIRST_SAVE,
    expectedRevision: null,
    setup: {
      ...explicitSetup(),
      publicCampaign: { ...syntheticPublicCampaign, published: false },
    },
    transition: "created",
  });

  assert.equal(result.campaign.revision, 1);
  assert.equal(result.replayed, false);
});

test("stored operation intents reject malformed envelopes, identity, and bytes", async (context) => {
  const corruptions: readonly Readonly<{
    name: string;
    corrupt(record: StorageRecord): StorageRecord;
  }>[] = [
    {
      name: "custom record prototype",
      corrupt: (record) =>
        withCustomObjectPrototype(record) as StorageRecord,
    },
    {
      name: "custom key prototype",
      corrupt: (record) => ({
        ...record,
        key: withCustomObjectPrototype(record.key),
      }) as StorageRecord,
    },
    {
      name: "custom value prototype",
      corrupt: (record) => ({
        ...record,
        value: withCustomObjectPrototype(record.value),
      }) as StorageRecord,
    },
    {
      name: "custom actor prototype",
      corrupt: (record) => ({
        ...record,
        value: {
          ...record.value,
          actor: withCustomObjectPrototype(
            requiredObjectMember(record.value, "actor"),
          ),
        },
      }) as StorageRecord,
    },
    {
      name: "record accessor",
      corrupt: (record) =>
        withObjectAccessor(record, "revision") as StorageRecord,
    },
    {
      name: "key symbol",
      corrupt: (record) => ({
        ...record,
        key: withObjectSymbol(record.key),
      }) as StorageRecord,
    },
    {
      name: "value accessor",
      corrupt: (record) => ({
        ...record,
        value: withObjectAccessor(record.value, "mode"),
      }) as StorageRecord,
    },
    {
      name: "extra record member",
      corrupt: (record) => ({ ...record, ignored: true }) as StorageRecord,
    },
    {
      name: "wrong key",
      corrupt: (record) =>
        ({
          ...record,
          key: { ...record.key, id: `${record.key.id}-wrong` },
        }) as unknown as StorageRecord,
    },
    {
      name: "wrong revision",
      corrupt: (record) => ({ ...record, revision: 2 }),
    },
    {
      name: "extra value member",
      corrupt: (record) => ({
        ...record,
        value: { ...record.value, ignored: true },
      }),
    },
    {
      name: "mismatched operation identity",
      corrupt: (record) => ({
        ...record,
        value: {
          ...record.value,
          operationId: "campaign-operation:different-intent",
        },
      }),
    },
    {
      name: "record exceeds byte boundary",
      corrupt: (record) => ({
        ...record,
        value: {
          ...record.value,
          actor: { type: "owner", subject: "x".repeat(2_048) },
        },
      }),
    },
  ];

  for (const corruption of corruptions) {
    await context.test(corruption.name, async () => {
      const state = new MemoryStorageState();
      const adapter = new DeterministicMemoryStorageAdapter(state, true, true);
      const repository = new DevelopmentInMemoryCampaignRepository(adapter);
      const request = {
        operationId: `campaign-operation:stored-intent-${corruption.name.replaceAll(" ", "-")}`,
        ownerSubject: "owner-subject",
        recordedAt: FIRST_SAVE,
        expectedRevision: null,
        setup: {
          ...explicitSetup(),
          publicCampaign: { ...syntheticPublicCampaign, published: false },
        },
        transition: "created" as const,
      };
      const initialFailure = await captureStorageFailure(() =>
        repository.saveSetupWithAudit(request)
      );
      assert.equal(initialFailure.code, "UNAVAILABLE");
      const intentEntry = [...state.records.entries()].find(([, record]) =>
        record.key.collection === "campaign-setup-intents"
      );
      assert.ok(intentEntry);
      const [, intentRecord] = intentEntry;
      assert.equal(
        documentByteLength(intentRecord.value) <=
          CAMPAIGN_OPERATION_INTENT_MAX_RECORD_BYTES,
        true,
      );
      const malformed = corruption.corrupt(intentRecord);
      if (corruption.name === "record exceeds byte boundary") {
        assert.equal(
          documentByteLength(malformed.value) >
            CAMPAIGN_OPERATION_INTENT_MAX_RECORD_BYTES,
          true,
        );
      }
      const transactionCalls = state.transactionCalls;
      const malformedReadAdapter: StorageAdapter = Object.freeze({
        async read(key: StorageKey) {
          return key.collection === "campaign-setup-intents"
            ? malformed
            : adapter.read(key);
        },
        list: adapter.list.bind(adapter),
        transact: adapter.transact.bind(adapter),
      });

      const failure = await captureStorageFailure(() =>
        new DevelopmentInMemoryCampaignRepository(malformedReadAdapter)
          .saveSetupWithAudit(request)
      );
      assert.equal(failure.code, "UNAVAILABLE");
      assert.equal(state.transactionCalls, transactionCalls);
    });
  }
});

test("audited campaign saves commit the revision, history, and audit atomically", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state, true);
  const repository = new DevelopmentInMemoryCampaignRepository(adapter);
  await repository.saveSetup(saveRequest({
    operationId: "campaign-operation:audited-seed",
    recordedAt: FIRST_SAVE,
    expectedRevision: null,
    setup: explicitSetup(),
  }));
  const request = {
    operationId: "campaign-operation:audited-unpublish",
    ownerSubject: "owner-subject",
    recordedAt: SECOND_SAVE,
    expectedRevision: 1,
    setup: {
      ...explicitSetup(),
      publicCampaign: {
        ...syntheticPublicCampaign,
        published: false,
      },
    },
    transition: "unpublished" as const,
  };

  const first = await repository.saveSetupWithAudit(request);
  assert.equal(first.campaign.revision, 2);
  assert.equal(first.campaign.setup.publicCampaign.published, false);
  assert.equal(first.replayed, false);
  assert.deepEqual(first.auditEvent.actor, {
    type: "owner",
    subject: "owner-subject",
  });
  assert.deepEqual(first.auditEvent.detail, {
    kind: "resource-transition",
    resource: {
      type: "campaign",
      id: `campaign:${syntheticPublicCampaign.id}`,
    },
    transition: "unpublished",
  });

  const replay = await repository.saveSetupWithAudit(request);
  assert.deepEqual(replay.campaign, first.campaign);
  assert.deepEqual(replay.auditEvent, first.auditEvent);
  assert.equal(replay.replayed, true);
  assert.deepEqual(
    (await new DevelopmentInMemoryAuditRepository(adapter).list({ limit: 10 }))
      .items,
    [first.auditEvent],
  );
  assert.deepEqual(
    (await repository.listSetupHistory({ limit: 10 })).items.map(({ revision }) =>
      revision
    ),
    [1, 2],
  );
});

test("audited campaign repository recovers an exact operation lookup race", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state, true);
  const baseRepository = new DevelopmentInMemoryCampaignRepository(adapter);
  const initialSetup = {
    ...explicitSetup(),
    publicCampaign: { ...syntheticPublicCampaign, published: false },
  };
  await baseRepository.saveSetupWithAudit({
    operationId: "campaign-operation:race-seed",
    ownerSubject: "owner-subject",
    recordedAt: FIRST_SAVE,
    expectedRevision: null,
    setup: initialSetup,
    transition: "created",
  });
  const request = {
    operationId: "campaign-operation:race-update",
    ownerSubject: "owner-subject",
    recordedAt: SECOND_SAVE,
    expectedRevision: 1,
    setup: {
      ...initialSetup,
      publicCampaign: {
        ...initialSetup.publicCampaign,
        name: "Concurrent Northstar",
      },
    },
    transition: "updated" as const,
  };

  let readSequence = 0;
  let concurrentSave = false;
  const racingAdapter: StorageAdapter = {
    read: async (key) => {
      readSequence += 1;
      if (readSequence === 2) {
        concurrentSave = true;
        const committed = await baseRepository.saveSetupWithAudit(request);
        assert.equal(committed.replayed, false);
      }
      return adapter.read(key);
    },
    list: adapter.list.bind(adapter),
    transact: adapter.transact.bind(adapter),
  };
  const repository = new DevelopmentInMemoryCampaignRepository(racingAdapter);
  const replay = await repository.saveSetupWithAudit(request);

  assert.equal(concurrentSave, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.campaign.revision, 2);
  assert.equal(replay.campaign.setup.publicCampaign.name, "Concurrent Northstar");
  assert.deepEqual(
    (await repository.listSetupHistory({ limit: 10 })).items.map(
      ({ revision }) => revision,
    ),
    [1, 2],
  );
  assert.equal(
    (await new DevelopmentInMemoryAuditRepository(adapter).list({ limit: 10 }))
      .items.length,
    2,
  );
  assert.equal((await repository.readSetup())?.revision, 2);
});

test("public projection reads expose only published presentation state", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state, true);
  const owner = new DevelopmentInMemoryCampaignRepository(adapter);
  const publicReader = new DevelopmentInMemoryPublicCampaignPresentationReader(adapter);

  await owner.saveSetup(saveRequest({
    operationId: "campaign-operation:public-projection",
    recordedAt: FIRST_SAVE,
    expectedRevision: null,
    setup: explicitSetup(),
  }));
  const publicCampaign = await publicReader.readPublishedCampaign();
  const parsedSetup = parseCampaignSetup(explicitSetup());
  assert(parsedSetup.ok);
  assert.deepEqual(publicCampaign, syntheticPublicCampaign);
  assert.deepEqual(await publicReader.readPublishedProjection(), {
    revision: 1,
    publicCampaign: syntheticPublicCampaign,
    amountAggregate: parsedSetup.value.amountAggregate,
  });
  const privateRecord = [...state.records.values()].find((record) =>
    record.key.collection === "campaign-setup-current"
  );
  const publicRecord = [...state.records.values()].find((record) =>
    record.key.collection === "campaign-public-presentation"
  );
  assert(privateRecord);
  assert(publicRecord);
  assert.equal(
    (privateRecord.value as { schemaVersion?: unknown }).schemaVersion,
    4,
  );
  assert.equal(
    (publicRecord.value as { schemaVersion?: unknown }).schemaVersion,
    5,
  );
  assert.deepEqual(Object.keys(publicRecord.value).sort(), [
    "amountAggregate",
    "kind",
    "publicCampaign",
    "revision",
    "schemaVersion",
  ]);
  assert.equal(
    JSON.stringify(publicCampaign).includes(
      explicitSetup().campaignPolicy.notices.legalBoundary,
    ),
    false,
  );
  assert.equal(
    JSON.stringify(publicCampaign).includes(
      explicitSetup().campaignPolicy.notices.processEmail,
    ),
    false,
  );
  assert.equal(
    JSON.stringify(publicCampaign).includes(
      explicitSetup().campaignPolicy.notices.marketingConsent,
    ),
    false,
  );

  await owner.saveSetupWithAudit({
    operationId: "campaign-operation:public-projection-unpublish",
    ownerSubject: "owner-subject",
    recordedAt: SECOND_SAVE,
    expectedRevision: 1,
    setup: {
      ...explicitSetup(),
      publicCampaign: { ...syntheticPublicCampaign, published: false },
    },
    transition: "unpublished",
  });
  assert.equal(await publicReader.readPublishedCampaign(), null);
});

test("malformed and unknown public presentation schemas do not alter private setup evolution", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state, true);
  const owner = new DevelopmentInMemoryCampaignRepository(adapter);
  const publicReader = new DevelopmentInMemoryPublicCampaignPresentationReader(
    adapter,
  );
  await owner.saveSetup(saveRequest({
    operationId: "campaign-operation:public-schema",
    recordedAt: FIRST_SAVE,
    expectedRevision: null,
    setup: explicitSetup(),
  }));

  const entry = [...state.records.entries()].find(([, record]) =>
    record.key.collection === "campaign-public-presentation"
  );
  assert(entry);
  const [key, record] = entry;
  for (const schemaVersion of [4, 6]) {
    state.records.set(key, freezeRecord({
      key: record.key,
      revision: record.revision,
      value: { ...record.value, schemaVersion },
    }));

    const failure = await captureStorageFailure(() =>
      publicReader.readPublishedProjection()
    );
    assert.equal(failure.code, "UNAVAILABLE");
  }
  assert.equal((await owner.readSetup())?.revision, 1);
  assert.equal(
    (([...state.records.values()].find((candidate) =>
      candidate.key.collection === "campaign-setup-current"
    )?.value ?? {}) as { schemaVersion?: unknown }).schemaVersion,
    4,
  );
});

test("audited campaign transition labels are enforced before any atomic side effect", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state, true);
  const repository = new DevelopmentInMemoryCampaignRepository(adapter);
  const publicReader = new DevelopmentInMemoryPublicCampaignPresentationReader(adapter);
  await repository.saveSetup(saveRequest({
    operationId: "campaign-operation:transition-seed",
    recordedAt: FIRST_SAVE,
    expectedRevision: null,
    setup: explicitSetup(),
  }));
  const transactionCalls = state.transactionCalls;

  const failure = await captureStorageFailure(() => repository.saveSetupWithAudit({
    operationId: "campaign-operation:mislabeled-update",
    ownerSubject: "owner-subject",
    recordedAt: SECOND_SAVE,
    expectedRevision: 1,
    setup: {
      ...explicitSetup(),
      publicCampaign: { ...syntheticPublicCampaign, published: false },
    },
    transition: "updated",
  }));
  assert.equal(failure.code, "INVALID_REQUEST");
  assert.equal(state.transactionCalls, transactionCalls);
  assert.equal(await repository.findSetupByOperationId(
    "campaign-operation:mislabeled-update",
  ), null);
  assert.deepEqual(await publicReader.readPublishedCampaign(), syntheticPublicCampaign);
  assert.equal((await repository.readSetup())?.setup.publicCampaign.published, true);
  assert.deepEqual(
    (await repository.listSetupHistory({ limit: 10 })).items.map(({ revision }) => revision),
    [1],
  );
  assert.deepEqual(
    await new DevelopmentInMemoryAuditRepository(adapter).list({ limit: 10 }),
    { items: [], nextCursor: null },
  );
});

test("an audit write failure leaves campaign current and history unchanged", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state, true, true);
  const repository = new DevelopmentInMemoryCampaignRepository(adapter);
  const publicReader = new DevelopmentInMemoryPublicCampaignPresentationReader(adapter);
  await repository.saveSetup(saveRequest({
    operationId: "campaign-operation:failed-audit-seed",
    recordedAt: FIRST_SAVE,
    expectedRevision: null,
    setup: explicitSetup(),
  }));

  const failure = await captureStorageFailure(() => repository.saveSetupWithAudit({
    operationId: "campaign-operation:failed-audit-update",
    ownerSubject: "owner-subject",
    recordedAt: SECOND_SAVE,
    expectedRevision: 1,
    setup: explicitSetup({ campaignName: "Must Not Persist" }),
    transition: "updated",
  }));
  assert.equal(failure.code, "UNAVAILABLE");
  assert.equal((await repository.readSetup())?.revision, 1);
  assert.equal(
    (await repository.readSetup())?.setup.publicCampaign.name,
    syntheticPublicCampaign.name,
  );
  assert.equal(await repository.findSetupByOperationId(
    "campaign-operation:failed-audit-update",
  ), null);
  assert.deepEqual(await publicReader.readPublishedCampaign(), syntheticPublicCampaign);
  assert.deepEqual(
    (await repository.listSetupHistory({ limit: 10 })).items.map(({ revision }) =>
      revision
    ),
    [1],
  );
  assert.deepEqual(
    await new DevelopmentInMemoryAuditRepository(adapter).list({ limit: 10 }),
    { items: [], nextCursor: null },
  );
});

test("stale and inaccessible records fail without disclosing campaign data", async () => {
  const existingState = new MemoryStorageState();
  const owner = new DevelopmentInMemoryCampaignRepository(
    new DeterministicMemoryStorageAdapter(existingState, true),
  );
  await owner.saveSetup(saveRequest({
    operationId: "campaign-operation:private-create",
    recordedAt: FIRST_SAVE,
    expectedRevision: null,
    setup: explicitSetup(),
  }));
  await owner.saveSetup(saveRequest({
    operationId: "campaign-operation:private-update",
    recordedAt: SECOND_SAVE,
    expectedRevision: 1,
    setup: explicitSetup({ campaignName: "Private Current Name" }),
  }));

  const stale = await captureStorageFailure(() => owner.saveSetup(saveRequest({
    operationId: "campaign-operation:private-stale",
    recordedAt: SECOND_SAVE,
    expectedRevision: 1,
    setup: explicitSetup({ campaignName: "Private Stale Name" }),
  })));
  assert.equal(stale.code, "PRECONDITION_FAILED");
  assert.equal(stale.message.includes("Private"), false);

  const outsiderExisting = new DevelopmentInMemoryCampaignRepository(
    new DeterministicMemoryStorageAdapter(existingState, false),
  );
  const outsiderMissing = new DevelopmentInMemoryCampaignRepository(
    new DeterministicMemoryStorageAdapter(new MemoryStorageState(), false),
  );
  assert.equal(await outsiderExisting.readSetup(), null);
  assert.equal(await outsiderMissing.readSetup(), null);
  assert.deepEqual(await outsiderExisting.listSetupHistory({ limit: 10 }), {
    items: [],
    nextCursor: null,
  });

  const deniedExisting = await captureStorageFailure(() =>
    outsiderExisting.saveSetup(saveRequest({
      operationId: "campaign-operation:denied-existing",
      recordedAt: SECOND_SAVE,
      expectedRevision: 2,
      setup: explicitSetup({ campaignName: "Never Visible" }),
    })),
  );
  const deniedMissing = await captureStorageFailure(() =>
    outsiderMissing.saveSetup(saveRequest({
      operationId: "campaign-operation:denied-missing",
      recordedAt: SECOND_SAVE,
      expectedRevision: 2,
      setup: explicitSetup({ campaignName: "Never Visible" }),
    })),
  );
  assert.deepEqual(
    toPublicStorageFailure(deniedExisting),
    toPublicStorageFailure(deniedMissing),
  );
  const publicFailure = JSON.stringify(toPublicStorageFailure(deniedExisting));
  assert.equal(publicFailure.includes("Never Visible"), false);
  assert.equal(publicFailure.includes(syntheticPublicCampaign.id), false);
  assert.equal((await owner.readSetup())?.setup.publicCampaign.name, "Private Current Name");
  assert.equal((await owner.listSetupHistory({ limit: 10 })).items.length, 2);
});

class MemoryStorageState {
  readonly records = new Map<string, StorageRecord>();
  readonly operations = new Map<
    string,
    Readonly<{ fingerprint: string; result: StorageTransactionResult }>
  >();
  readCalls = 0;
  listCalls = 0;
  transactionCalls = 0;
}

class DeterministicMemoryStorageAdapter implements StorageAdapter {
  private readonly state: MemoryStorageState;
  private readonly permitted: boolean;
  private readonly failAuditMutation: boolean;

  constructor(
    state: MemoryStorageState,
    permitted: boolean,
    failAuditMutation = false,
  ) {
    this.state = state;
    this.permitted = permitted;
    this.failAuditMutation = failAuditMutation;
  }

  async read(key: StorageKey): Promise<StorageRecord | null> {
    this.state.readCalls += 1;
    if (!this.permitted) return null;
    return cloneRecord(this.state.records.get(storageKeyString(key)) ?? null);
  }

  async list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    this.state.listCalls += 1;
    assertStorageListBoundary(request);
    if (!this.permitted) return { items: [], nextCursor: null };

    const start = request.cursor === undefined ? 0 : parseCursor(request.cursor);
    const all = [...this.state.records.values()]
      .filter((record) => record.key.collection === request.collection)
      .sort((left, right) => left.key.id.localeCompare(right.key.id));
    if (start < 0 || start > all.length) {
      throw new StorageFailure("INVALID_REQUEST");
    }

    const items = all.slice(start, start + request.limit).map(cloneRecord);
    const next = start + items.length;
    return {
      items: items.filter((item): item is StorageRecord => item !== null),
      nextCursor: next < all.length ? (`memory-cursor:${next}` as StorageCursor) : null,
    };
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    this.state.transactionCalls += 1;
    assertStorageTransactionBoundary(request);
    if (!this.permitted) throw new StorageFailure("NOT_FOUND");
    if (
      this.failAuditMutation &&
      request.mutations.some((mutation) =>
        mutation.type === "put" && mutation.value.kind === "audit-event"
      )
    ) {
      throw new StorageFailure("UNAVAILABLE");
    }

    const operationKey = request.operationId as string;
    const fingerprint = JSON.stringify(request);
    const prior = this.state.operations.get(operationKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new StorageFailure("CONFLICT");
      return cloneResult(prior.result, true);
    }

    for (const mutation of request.mutations) {
      const current = this.state.records.get(storageKeyString(mutation.key));
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

    const nextRecords = new Map(this.state.records);
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

    this.state.records.clear();
    for (const [key, record] of nextRecords) this.state.records.set(key, record);
    const result = Object.freeze({
      replayed: false,
      records: Object.freeze(resultRecords.map(cloneRecord)),
    });
    this.state.operations.set(operationKey, { fingerprint, result });
    return cloneResult(result, false);
  }
}

function parseCursor(cursor: StorageCursor): number {
  const match = /^memory-cursor:(\d+)$/.exec(cursor);
  if (!match) throw new StorageFailure("INVALID_REQUEST");
  return Number.parseInt(match[1], 10);
}

type CampaignTransactionStage = "intent" | "chunk" | "final";

type TransactionResultCorruption = Readonly<{
  name: string;
  corrupt(result: StorageTransactionResult): unknown;
}>;

function corruptFirstCampaignTransactionResult(
  storage: StorageAdapter,
  target: CampaignTransactionStage,
  corrupt: (result: StorageTransactionResult) => unknown,
): StorageAdapter {
  let pending = true;
  return Object.freeze({
    read: storage.read.bind(storage),
    list: storage.list.bind(storage),
    async transact(request: StorageTransactionRequest) {
      const result = await storage.transact(request);
      if (
        !pending ||
        campaignTransactionStage(request.operationId as string) !== target
      ) {
        return result;
      }
      pending = false;
      return corrupt(result) as StorageTransactionResult;
    },
  });
}

function campaignTransactionStage(
  operationId: string,
): CampaignTransactionStage {
  if (operationId.startsWith("campaign-intent-claim:")) return "intent";
  if (operationId.startsWith("campaign-chunk-stage:")) return "chunk";
  return "final";
}

function requiredTransactionRecord(
  result: StorageTransactionResult,
  index: number,
): StorageRecord {
  const record = result.records[index];
  assert.ok(record);
  return record;
}

function replaceTransactionRecord(
  result: StorageTransactionResult,
  index: number,
  replacement: unknown,
): unknown {
  const records: unknown[] = [...result.records];
  records[index] = replacement;
  return { ...result, records };
}

function withCustomObjectPrototype(value: object): unknown {
  return Object.create(
    Object.freeze({ inherited: true }),
    Object.getOwnPropertyDescriptors(value),
  ) as unknown;
}

function withCustomArrayPrototype(
  values: readonly unknown[],
): unknown[] {
  const copy = [...values];
  Object.setPrototypeOf(copy, Object.create(Array.prototype) as object);
  return copy;
}

function sparseArray(values: readonly unknown[]): unknown[] {
  const sparse = new Array<unknown>(values.length);
  for (let index = 1; index < values.length; index += 1) {
    sparse[index] = values[index];
  }
  return sparse;
}

function withArrayAccessor(
  values: readonly unknown[],
  index: number,
): unknown[] {
  const copy = [...values];
  Object.defineProperty(copy, String(index), {
    configurable: true,
    enumerable: true,
    get: unexpectedAccessor,
  });
  return copy;
}

function withArraySymbol(values: readonly unknown[]): unknown[] {
  const copy = [...values];
  Object.defineProperty(copy, Symbol("ignored"), {
    configurable: true,
    enumerable: true,
    value: true,
  });
  return copy;
}

function withObjectAccessor(value: object, key: string): unknown {
  const source = value as Record<PropertyKey, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(source);
  assert.ok(Object.hasOwn(descriptors, key));
  delete descriptors[key];
  const copy = Object.create(Object.prototype, descriptors) as object;
  Object.defineProperty(copy, key, {
    configurable: true,
    enumerable: true,
    get: unexpectedAccessor,
  });
  return copy;
}

function withObjectSymbol(value: object): unknown {
  const copy = Object.create(
    Object.getPrototypeOf(value) as object | null,
    Object.getOwnPropertyDescriptors(value),
  ) as object;
  Object.defineProperty(copy, Symbol("ignored"), {
    configurable: true,
    enumerable: true,
    value: true,
  });
  return copy;
}

function unexpectedAccessor(): never {
  throw new Error("The exact-data validator invoked a hostile accessor.");
}

function requiredObjectKey(value: object): string {
  const key = Object.keys(value)[0];
  assert.ok(key);
  return key;
}

function requiredObjectMember(value: object, key: string): object {
  const member = (value as Record<string, unknown>)[key];
  assert.equal(typeof member, "object");
  assert.notEqual(member, null);
  assert.equal(Array.isArray(member), false);
  return member as object;
}

function toNullPrototypeJson(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map(toNullPrototypeJson);
  const copy = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value)) {
    copy[key] = toNullPrototypeJson(child);
  }
  return copy;
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

function downgradeCommittedPublicPresentationToSchema4(
  state: MemoryStorageState,
  operationId: string,
): void {
  const committed = state.operations.get(operationId);
  assert(committed);
  const request = JSON.parse(committed.fingerprint) as StorageTransactionRequest;
  const publicMutationIndex = request.mutations.findIndex((mutation) =>
    mutation.type === "put" &&
    mutation.key.collection === "campaign-public-presentation"
  );
  assert.notEqual(publicMutationIndex, -1);
  const publicMutation = request.mutations[publicMutationIndex];
  assert(publicMutation?.type === "put");
  const legacyValue = legacyPublicPresentation(publicMutation.value);
  const legacyRequest = {
    ...request,
    mutations: request.mutations.map((mutation, index) =>
      index === publicMutationIndex
        ? { ...publicMutation, value: legacyValue }
        : mutation
    ),
  } satisfies StorageTransactionRequest;
  assertStorageTransactionBoundary(legacyRequest);

  const publicResultRecord = requiredTransactionRecord(
    committed.result,
    publicMutationIndex,
  );
  const legacyResult = Object.freeze({
    replayed: false,
    records: Object.freeze(committed.result.records.map((record, index) =>
      index === publicMutationIndex
        ? freezeRecord({
            key: publicResultRecord.key,
            revision: publicResultRecord.revision,
            value: legacyValue,
          })
        : cloneRecord(record)
    )),
  });
  state.operations.set(operationId, Object.freeze({
    fingerprint: JSON.stringify(legacyRequest),
    result: legacyResult,
  }));

  const publicEntry = [...state.records.entries()].find(([, record]) =>
    record.key.collection === "campaign-public-presentation"
  );
  assert(publicEntry);
  const [key, record] = publicEntry;
  state.records.set(key, freezeRecord({
    key: record.key,
    revision: record.revision,
    value: legacyValue,
  }));
}

function withNonReplayLegacyResult(storage: StorageAdapter): StorageAdapter {
  return Object.freeze({
    read: storage.read.bind(storage),
    list: storage.list.bind(storage),
    async transact(request: StorageTransactionRequest) {
      const result = await storage.transact(request);
      const legacy = request.mutations.some((mutation) =>
        mutation.type === "put" &&
        mutation.value.kind === "campaign-public-presentation" &&
        mutation.value.schemaVersion === 4
      );
      return legacy ? Object.freeze({ ...result, replayed: false }) : result;
    },
  });
}

function legacyPublicPresentation(value: StorageDocument): StorageDocument {
  assert.equal(value.kind, "campaign-public-presentation");
  assert.equal(value.schemaVersion, 5);
  assert.equal(typeof value.revision, "number");
  assert.equal(typeof value.publicCampaign, "object");
  assert.notEqual(value.publicCampaign, null);
  return deepFreeze({
    kind: "campaign-public-presentation",
    schemaVersion: 4,
    revision: value.revision,
    publicCampaign: value.publicCampaign,
  });
}

function cloneDocument(value: StorageDocument): StorageDocument {
  return JSON.parse(JSON.stringify(value)) as StorageDocument;
}

function documentByteLength(value: StorageDocument): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
