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
  assert.equal(state.records.size, 6);

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
  assert.equal(state.records.size, 5);
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

test("an initial audit failure leaves every campaign record absent", async () => {
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
  assert.equal(state.records.size, 0);
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
  assert.deepEqual(publicCampaign, syntheticPublicCampaign);
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
      if (mutation.expectedRevision === null) {
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
