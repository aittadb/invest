import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAmountAggregateConfiguration,
  type AmountAggregateConfiguration,
  type CurrencyCode,
} from "../domain/amount-aggregate-configuration.ts";
import {
  parseMinorUnits,
  parseStableId,
  type MinorUnits,
} from "../domain/foundation.ts";
import {
  APPLY_CALCULATED_AGGREGATE_CONFIRMATION,
  type InvestmentAggregateContribution,
  type InvestmentAggregateCorrectionConfirmation,
  type InvestmentAggregateReconciliationPreview,
} from "../domain/investment-aggregate.ts";
import {
  StorageFailure,
  MAX_STORAGE_PAGE_SIZE,
  assertStorageListBoundary,
  assertStorageTransactionBoundary,
  parseStorageKey,
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
  DevelopmentInMemoryAggregateRepository,
  MAX_AGGREGATE_CONTRIBUTION_LIST_PAGES,
  MAX_AGGREGATE_CONTRIBUTION_LIST_READS,
  MAX_AGGREGATE_CONTRIBUTION_RECORDS,
  type AggregateCorrectionRevisionAssertion,
  type ApplyAggregateContributionRequest,
  type InvestmentAggregateRepository,
} from "../repositories/in-memory-aggregate-repository.ts";
import {
  DevelopmentInMemoryAuditRepository,
} from "../repositories/in-memory-audit-notification-repositories.ts";

const currency = "XYZ" as CurrencyCode;
const evolvedCurrency = "EUR" as CurrencyCode;

export type InvestmentAggregateRepositoryContractFixture = Readonly<{
  repository: InvestmentAggregateRepository;
  reopen: () => InvestmentAggregateRepository;
}>;

export type InvestmentAggregateRepositoryContractFactory =
  () => InvestmentAggregateRepositoryContractFixture;

/** Reusable behavior contract for development and production aggregate repositories. */
export async function verifyInvestmentAggregateRepositoryContract(
  createFixture: InvestmentAggregateRepositoryContractFactory,
): Promise<void> {
  const fixture = createFixture();
  assert.deepEqual(await fixture.repository.readStored(), stored(0, 0, 0));
  assert.deepEqual(await fixture.repository.calculate(), summary(0, 0));
  assert.deepEqual(await fixture.repository.previewReconciliation(), {
    status: "match",
    stored: stored(0, 0, 0),
    calculated: summary(0, 0),
    correctionRequired: false,
  });

  const firstRequest = applyRequest(
    "aggregate-operation:first-active",
    0,
    contribution("indication:first", 1, "active", 100),
  );
  const first = await fixture.repository.applyContribution(firstRequest);
  assert.deepEqual(first, {
    disposition: "applied",
    stored: stored(1, 100, 1),
    calculated: summary(100, 1),
    replayed: false,
  });
  assert.deepEqual(
    await fixture.repository.applyContribution(firstRequest),
    { ...first, replayed: true },
  );

  await rejectsStorage(
    () => fixture.repository.applyContribution({
      ...firstRequest,
      contribution: contribution("indication:first", 1, "active", 200),
    }),
    "CONFLICT",
  );

  const duplicate = await fixture.repository.applyContribution(applyRequest(
    "aggregate-operation:first-duplicate",
    1,
    contribution("indication:first", 1, "active", 100),
  ));
  assert.deepEqual(duplicate, {
    disposition: "duplicate",
    stored: stored(1, 100, 1),
    calculated: summary(100, 1),
    replayed: false,
  });

  await rejectsStorage(
    () => fixture.repository.applyContribution(applyRequest(
      "aggregate-operation:first-conflict",
      1,
      contribution("indication:first", 1, "withdrawn", 100),
    )),
    "CONFLICT",
  );

  const second = await fixture.repository.applyContribution(applyRequest(
    "aggregate-operation:second-active",
    1,
    contribution("indication:second", 1, "active", 250),
  ));
  assert.deepEqual(second.stored, stored(2, 350, 2));

  const withdrawn = await fixture.repository.applyContribution(applyRequest(
    "aggregate-operation:first-withdrawn",
    2,
    contribution("indication:first", 2, "withdrawn", 100),
  ));
  assert.deepEqual(withdrawn, {
    disposition: "applied",
    stored: stored(3, 250, 1),
    calculated: summary(250, 1),
    replayed: false,
  });

  const rejected = await fixture.repository.applyContribution(applyRequest(
    "aggregate-operation:second-rejected",
    3,
    contribution("indication:second", 2, "rejected", 250),
  ));
  assert.deepEqual(rejected.stored, stored(4, 0, 0));

  const superseded = await fixture.repository.applyContribution(applyRequest(
    "aggregate-operation:first-superseded",
    4,
    contribution("indication:first", 1, "active", 100),
  ));
  assert.deepEqual(superseded, {
    disposition: "superseded",
    stored: stored(4, 0, 0),
    calculated: summary(0, 0),
    replayed: false,
  });

  const reopened = await fixture.repository.applyContribution(applyRequest(
    "aggregate-operation:first-reopened",
    4,
    contribution("indication:first", 3, "active", 120),
  ));
  assert.deepEqual(reopened.stored, stored(5, 120, 1));

  await rejectsStorage(
    () => fixture.repository.applyContribution(applyRequest(
      "aggregate-operation:stale",
      4,
      contribution("indication:second", 3, "active", 250),
    )),
    "PRECONDITION_FAILED",
  );

  const freshRepository = fixture.reopen();
  assert.deepEqual(await freshRepository.readStored(), stored(5, 120, 1));
  assert.deepEqual(await freshRepository.calculate(), summary(120, 1));
  assert.equal(
    (await freshRepository.previewReconciliation()).correctionRequired,
    false,
  );

  const delayedReplay = await freshRepository.applyContribution(firstRequest);
  assert.deepEqual(delayedReplay, { ...first, replayed: true });
  assert.deepEqual(await freshRepository.readStored(), stored(5, 120, 1));
}

test("adapter-backed development repository passes the aggregate contract", async () => {
  await verifyInvestmentAggregateRepositoryContract(() => {
    const state = new MemoryStorageState();
    const adapter = new DeterministicMemoryStorageAdapter(state);
    return {
      repository: new DevelopmentInMemoryAggregateRepository(adapter, currency),
      reopen: () =>
        new DevelopmentInMemoryAggregateRepository(adapter, currency),
    };
  });
});

test("persisted mismatches require an exact preview-bound correction", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state);
  const repository = new DevelopmentInMemoryAggregateRepository(
    adapter,
    currency,
  );
  await repository.applyContribution(applyRequest(
    "aggregate-operation:mismatch-seed",
    0,
    contribution("indication:mismatch", 1, "active", 10_000),
  ));

  mutateAggregateRecord(state, (snapshot) => {
    snapshot.totalAmount = 8_000;
  });
  const transactionsBeforePreview = state.transactionCalls;
  const preview = await repository.previewReconciliation();
  assert.deepEqual(preview, {
    status: "mismatch",
    stored: stored(1, 8_000, 1),
    calculated: summary(10_000, 1),
    correctionRequired: true,
  });
  assert.equal(state.transactionCalls, transactionsBeforePreview);

  await rejectsStorage(
    () => repository.applyContribution(applyRequest(
      "aggregate-operation:blocked-during-mismatch",
      1,
      contribution("indication:other", 1, "active", 500),
    )),
    "PRECONDITION_FAILED",
  );
  assert.deepEqual(await repository.readStored(), stored(1, 8_000, 1));

  const wrongConfirmation = confirmationFor(preview, {
    expectedCalculatedAmount: minorUnits(10_001),
  });
  await rejectsStorage(
    () => repository.applyConfirmedCorrection({
      operationId: "aggregate-operation:wrong-correction",
      confirmation: wrongConfirmation,
    }),
    "PRECONDITION_FAILED",
  );
  assert.equal(state.transactionCalls, transactionsBeforePreview);

  await rejectsStorage(
    () => repository.applyConfirmedCorrection({
      operationId: "aggregate-operation:invalid-correction",
      confirmation: {
        ...confirmationFor(preview),
        confirmation: "yes",
      },
    }),
    "INVALID_REQUEST",
  );
  assert.equal(state.transactionCalls, transactionsBeforePreview);

  const correctionRequest = {
    operationId: "aggregate-operation:exact-correction",
    confirmation: confirmationFor(preview),
  };
  const correction = await repository.applyConfirmedCorrection(
    correctionRequest,
  );
  assert.deepEqual(correction, {
    preview,
    stored: stored(2, 10_000, 1),
    replayed: false,
  });
  assert.deepEqual(
    await new DevelopmentInMemoryAggregateRepository(
      adapter,
      currency,
    ).applyConfirmedCorrection(correctionRequest),
    { ...correction, replayed: true },
  );

  await rejectsStorage(
    () => repository.applyConfirmedCorrection({
      ...correctionRequest,
      confirmation: confirmationFor(preview, {
        expectedStoredAmount: minorUnits(8_001),
      }),
    }),
    "CONFLICT",
  );
  await rejectsStorage(
    () => repository.applyConfirmedCorrection({
      operationId: "aggregate-operation:stale-correction",
      confirmation: confirmationFor(preview),
    }),
    "PRECONDITION_FAILED",
  );
  assert.deepEqual(await repository.previewReconciliation(), {
    status: "match",
    stored: stored(2, 10_000, 1),
    calculated: summary(10_000, 1),
    correctionRequired: false,
  });
});

test("audited corrections commit one retry-stable aggregate and audit transaction", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state);
  const campaignKey = requiredTestStorageKey(
    "campaign-setup-current",
    "configured-campaign",
  );
  setCampaignRevision(state, campaignKey, 1);
  const repository = new DevelopmentInMemoryAggregateRepository(
    adapter,
    currency,
    revisionAssertion(campaignKey, 1),
  );
  await repository.applyContribution(applyRequest(
    "aggregate-operation:audited-seed",
    0,
    contribution("indication:audited", 1, "active", 25_000),
  ));
  mutateAggregateRecord(state, (snapshot) => {
    snapshot.totalAmount = 20_000;
  });
  const preview = await repository.previewReconciliation();
  const request = {
    operationId: "aggregate-operation:audited-correction",
    expectedCampaignRevision: 1,
    confirmation: confirmationFor(preview),
    ownerSubject: "issuer.invalid/subject:owner",
    occurredAt: "2026-08-09T12:00:00.000Z",
  };

  const before = state.transactionCalls;
  const correction = await repository.applyConfirmedCorrectionWithAudit(request);
  assert.equal(state.transactionCalls, before + 1);
  assert.equal(correction.replayed, false);
  assert.deepEqual(correction.stored, stored(2, 25_000, 1));
  assert.deepEqual(correction.auditEvent.actor, {
    type: "owner",
    subject: "issuer.invalid/subject:owner",
  });
  assert.deepEqual(correction.auditEvent.detail, {
    kind: "resource-transition",
    resource: {
      type: "aggregate",
      id: "aggregate:investment-interest",
    },
    transition: "reconciled",
  });

  const restartedState = await new DevelopmentInMemoryAggregateRepository(
    adapter,
    currency,
    revisionAssertion(campaignKey, 1),
  ).previewReconciliationState();
  assert.equal(restartedState.preview.status, "match");
  assert.deepEqual(restartedState.terminalReplay, {
    operationId: request.operationId,
    expectedCampaignRevision: request.expectedCampaignRevision,
    confirmation: request.confirmation,
  });

  const events = await new DevelopmentInMemoryAuditRepository(adapter).list({
    limit: 10,
  });
  assert.deepEqual(events.items, [correction.auditEvent]);

  const replay = await new DevelopmentInMemoryAggregateRepository(
    adapter,
    currency,
    revisionAssertion(campaignKey, 1),
  ).applyConfirmedCorrectionWithAudit({
    ...request,
    occurredAt: "2026-08-09T12:05:00.000Z",
  });
  assert.deepEqual(replay, { ...correction, replayed: true });
  assert.deepEqual((await new DevelopmentInMemoryAuditRepository(adapter).list({
    limit: 10,
  })).items, [correction.auditEvent]);

  await rejectsStorage(
    () => repository.applyConfirmedCorrectionWithAudit({
      ...request,
      ownerSubject: "issuer.invalid/subject:other-owner",
    }),
    "CONFLICT",
  );

  await repository.applyContribution(applyRequest(
    "aggregate-operation:after-terminal-correction",
    2,
    contribution("indication:after-terminal-correction", 1, "active", 5_000),
  ));
  const advanced = await new DevelopmentInMemoryAggregateRepository(
    adapter,
    currency,
  ).previewReconciliationState();
  assert.equal(advanced.preview.status, "match");
  assert.equal(advanced.terminalReplay, null);
});

test("overlapping exact audited corrections boundedly recover the winning receipt", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state);
  const campaignKey = requiredTestStorageKey(
    "campaign-setup-current",
    "configured-campaign",
  );
  setCampaignRevision(state, campaignKey, 1);
  const seed = new DevelopmentInMemoryAggregateRepository(adapter, currency);
  await seed.applyContribution(applyRequest(
    "aggregate-operation:overlap-seed",
    0,
    contribution("indication:overlap", 1, "active", 25_000),
  ));
  mutateAggregateRecord(state, (snapshot) => {
    snapshot.totalAmount = 20_000;
  });
  const preview = await seed.previewReconciliation();
  const overlapping = new OverlappingAuditedCorrectionAdapter(adapter);
  const repositories = [
    new DevelopmentInMemoryAggregateRepository(
      overlapping,
      currency,
      revisionAssertion(campaignKey, 1),
    ),
    new DevelopmentInMemoryAggregateRepository(
      overlapping,
      currency,
      revisionAssertion(campaignKey, 1),
    ),
  ] as const;
  const baseRequest = {
    operationId: "aggregate-operation:overlapping-correction",
    expectedCampaignRevision: 1,
    confirmation: confirmationFor(preview),
    ownerSubject: "issuer.invalid/subject:owner",
  };

  const results = await Promise.all([
    repositories[0].applyConfirmedCorrectionWithAudit({
      ...baseRequest,
      occurredAt: "2026-08-09T12:00:00.000Z",
    }),
    repositories[1].applyConfirmedCorrectionWithAudit({
      ...baseRequest,
      occurredAt: "2026-08-09T12:05:00.000Z",
    }),
  ]);
  const winner = results.find((result) => !result.replayed);
  const recovered = results.find((result) => result.replayed);
  assert(winner);
  assert(recovered);
  assert.deepEqual(recovered, { ...winner, replayed: true });
  assert.equal(overlapping.auditedTransactions, 2);
  assert.equal(overlapping.operationReads, 3);
  assert.equal(overlapping.auditReads, 1);
  assert.deepEqual(
    (await new DevelopmentInMemoryAuditRepository(adapter).list({ limit: 10 }))
      .items,
    [winner.auditEvent],
  );
});

test("audited correction atomically asserts its advertised campaign revision", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state);
  const seed = new DevelopmentInMemoryAggregateRepository(adapter, currency);
  await seed.applyContribution(applyRequest(
    "aggregate-operation:campaign-race-seed",
    0,
    contribution("indication:campaign-race", 1, "active", 25_000),
  ));
  mutateAggregateRecord(state, (snapshot) => {
    snapshot.totalAmount = 20_000;
  });
  const preview = await seed.previewReconciliation();
  const campaignKey = requiredTestStorageKey(
    "campaign-setup-current",
    "configured-campaign",
  );
  setCampaignRevision(state, campaignKey, 1);
  const request = {
    operationId: "aggregate-operation:campaign-race-correction",
    expectedCampaignRevision: 1,
    confirmation: confirmationFor(preview),
    ownerSubject: "issuer.invalid/subject:owner",
    occurredAt: "2026-08-09T12:00:00.000Z",
  };
  const raced = new CampaignRevisionRaceAdapter(
    adapter,
    state,
    campaignKey,
  );
  const boundToRevisionOne = new DevelopmentInMemoryAggregateRepository(
    raced,
    currency,
    revisionAssertion(campaignKey, 1),
  );

  await rejectsStorage(
    () => boundToRevisionOne.applyConfirmedCorrectionWithAudit(request),
    "PRECONDITION_FAILED",
  );
  assert.equal(raced.raced, true);
  assert.equal(
    state.records.get(storageKeyString(campaignKey))?.revision,
    2,
  );
  assert.deepEqual(await seed.previewReconciliation(), preview);
  assert.equal(hasStoredOperation(state, "audited-correction"), false);
  assert.deepEqual(
    (await new DevelopmentInMemoryAuditRepository(adapter).list({ limit: 10 }))
      .items,
    [],
  );

  const reopened = new DevelopmentInMemoryAggregateRepository(
    adapter,
    currency,
    revisionAssertion(campaignKey, 2),
  );
  await rejectsStorage(
    () => reopened.applyConfirmedCorrectionWithAudit(request),
    "PRECONDITION_FAILED",
  );
  const restartedRequest = {
    ...request,
    operationId: "aggregate-operation:campaign-race-restarted",
    expectedCampaignRevision: 2,
  };
  const corrected = await reopened.applyConfirmedCorrectionWithAudit(
    restartedRequest,
  );
  assert.equal(corrected.replayed, false);
  assert.deepEqual(corrected.stored, stored(2, 25_000, 1));
  const replayed = await new DevelopmentInMemoryAggregateRepository(
    adapter,
    currency,
    revisionAssertion(campaignKey, 2),
  ).applyConfirmedCorrectionWithAudit({
    ...restartedRequest,
    occurredAt: "2026-08-09T12:05:00.000Z",
  });
  assert.deepEqual(replayed, { ...corrected, replayed: true });
});

test("delayed exact correction retry survives campaign and currency evolution", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state);
  const campaignKey = requiredTestStorageKey(
    "campaign-setup-current",
    "configured-campaign",
  );
  setCampaignRevision(state, campaignKey, 1);
  const seed = new DevelopmentInMemoryAggregateRepository(adapter, currency);
  await seed.applyContribution(applyRequest(
    "aggregate-operation:delayed-retry-seed",
    0,
    contribution("indication:delayed-retry", 1, "active", 25_000),
  ));
  mutateAggregateRecord(state, (snapshot) => {
    snapshot.totalAmount = 20_000;
  });
  const preview = await seed.previewReconciliation();
  const request = {
    operationId: "aggregate-operation:delayed-correction",
    expectedCampaignRevision: 1,
    confirmation: confirmationFor(preview),
    ownerSubject: "issuer.invalid/subject:owner",
    occurredAt: "2026-08-09T12:00:00.000Z",
  };
  const committed = await new DevelopmentInMemoryAggregateRepository(
    adapter,
    currency,
    revisionAssertion(campaignKey, 1),
  ).applyConfirmedCorrectionWithAudit(request);
  assert.equal(committed.replayed, false);

  setCampaignRevision(state, campaignKey, 2);
  const revisionTwoRepository = new DevelopmentInMemoryAggregateRepository(
    adapter,
    evolvedCurrency,
    revisionAssertion(campaignKey, 2),
  );
  const terminalState = await revisionTwoRepository.previewReconciliationState();
  assert.equal(terminalState.preview.status, "match");
  assert.equal(terminalState.preview.stored.currency, currency);
  assert.deepEqual(terminalState.terminalReplay, {
    operationId: request.operationId,
    expectedCampaignRevision: request.expectedCampaignRevision,
    confirmation: request.confirmation,
  });
  const uncorruptedAggregate = mutateAggregateTerminalReplay(
    state,
    (terminalReplay) => {
      const confirmation = mutableRecord(terminalReplay.confirmation);
      confirmation.expectedCalculatedAmount = 25_001;
    },
  );
  await rejectsStorage(
    () => revisionTwoRepository.previewReconciliationState(),
    "UNAVAILABLE",
  );
  state.records.set(
    storageKeyString(uncorruptedAggregate.key),
    uncorruptedAggregate,
  );
  const transactionsBeforeRetries = state.transactionCalls;
  const delayed = await revisionTwoRepository.applyConfirmedCorrectionWithAudit({
    ...request,
    occurredAt: "2026-08-10T12:00:00.000Z",
  });
  assert.deepEqual(delayed, { ...committed, replayed: true });
  assert.equal(delayed.stored.currency, currency);

  await rejectsStorage(
    () => revisionTwoRepository.applyConfirmedCorrectionWithAudit({
      ...request,
      expectedCampaignRevision: 2,
      occurredAt: "2026-08-10T12:05:00.000Z",
    }),
    "CONFLICT",
  );
  await rejectsStorage(
    () => revisionTwoRepository.applyConfirmedCorrectionWithAudit({
      ...request,
      operationId: "aggregate-operation:new-stale-correction",
      occurredAt: "2026-08-10T12:10:00.000Z",
    }),
    "PRECONDITION_FAILED",
  );
  await rejectsStorage(
    () => revisionTwoRepository.applyConfirmedCorrectionWithAudit({
      ...request,
      operationId: "aggregate-operation:new-current-currency-correction",
      expectedCampaignRevision: 2,
      occurredAt: "2026-08-10T12:15:00.000Z",
    }),
    "UNAVAILABLE",
  );
  assert.equal(state.transactionCalls, transactionsBeforeRetries);
  assert.deepEqual(
    (await new DevelopmentInMemoryAuditRepository(adapter).list({ limit: 10 }))
      .items,
    [committed.auditEvent],
  );
});

test("audited corrections reject a closed malformed transaction result matrix", async (t) => {
  const corruptions: readonly Readonly<{
    name: string;
    apply(result: StorageTransactionResult): unknown;
  }>[] = [
    {
      name: "primitive envelope",
      apply: () => null,
    },
    {
      name: "extra envelope member",
      apply: (result) => ({ ...result, extra: true }),
    },
    {
      name: "custom envelope prototype",
      apply: (result) => Object.assign(Object.create({}), result),
    },
    {
      name: "replayed accessor",
      apply: (result) => Object.defineProperty(
        { records: result.records },
        "replayed",
        { enumerable: true, get: () => result.replayed },
      ),
    },
    {
      name: "non-boolean replay marker",
      apply: (result) => ({ ...result, replayed: "false" }),
    },
    {
      name: "records accessor",
      apply: (result) => Object.defineProperty(
        { replayed: result.replayed },
        "records",
        { enumerable: true, get: () => result.records },
      ),
    },
    {
      name: "custom records prototype",
      apply: (result) => ({
        ...result,
        records: Object.setPrototypeOf([...result.records], null),
      }),
    },
    {
      name: "sparse records",
      apply: (result) => {
        const records = new Array(result.records.length);
        records[0] = result.records[0];
        return { ...result, records };
      },
    },
    {
      name: "missing record",
      apply: (result) => ({
        ...result,
        records: result.records.slice(0, -1),
      }),
    },
    {
      name: "extra record",
      apply: (result) => ({
        ...result,
        records: [...result.records, result.records[0]],
      }),
    },
    {
      name: "reversed record order",
      apply: (result) => ({
        ...result,
        records: [...result.records].reverse(),
      }),
    },
    {
      name: "extra record member",
      apply: (result) => replaceTransactionResultRecord(
        result,
        0,
        (record) => ({ ...record, extra: true }),
      ),
    },
    {
      name: "custom record prototype",
      apply: (result) => replaceTransactionResultRecord(
        result,
        0,
        (record) => Object.assign(Object.create({}), record),
      ),
    },
    {
      name: "extra key member",
      apply: (result) => replaceTransactionResultRecord(
        result,
        0,
        (record) => ({ ...record, key: { ...record.key, extra: true } }),
      ),
    },
    {
      name: "changed aggregate value",
      apply: (result) => replaceTransactionResultRecord(
        result,
        0,
        (record) => ({ ...record, value: { changed: true } }),
      ),
    },
    {
      name: "changed operation value",
      apply: (result) => replaceTransactionResultRecord(
        result,
        1,
        (record) => ({
          ...record,
          value: {
            ...record.value,
            operationFingerprint: `sha256:${"0".repeat(64)}`,
          },
        }),
      ),
    },
    {
      name: "changed audit value",
      apply: (result) => replaceTransactionResultRecord(
        result,
        2,
        (record) => ({
          ...record,
          value: { ...record.value, kind: "changed-audit" },
        }),
      ),
    },
    {
      name: "changed campaign check revision",
      apply: (result) => replaceTransactionResultRecord(
        result,
        3,
        (record) => ({ ...record, revision: record.revision + 1 }),
      ),
    },
    {
      name: "malformed campaign check value",
      apply: (result) => replaceTransactionResultRecord(
        result,
        3,
        (record) => ({ ...record, value: { kind: "campaign-setup-revision" } }),
      ),
    },
    {
      name: "changed campaign check value revision",
      apply: (result) => replaceTransactionResultRecord(
        result,
        3,
        (record) => ({
          ...record,
          value: { ...record.value, revision: record.revision + 1 },
        }),
      ),
    },
  ];

  for (const corruption of corruptions) {
    await t.test(corruption.name, async () => {
      const state = new MemoryStorageState();
      const adapter = new DeterministicMemoryStorageAdapter(state);
      const campaignKey = requiredTestStorageKey(
        "campaign-setup-current",
        "configured-campaign",
      );
      setCampaignRevision(state, campaignKey, 1);
      const seed = new DevelopmentInMemoryAggregateRepository(adapter, currency);
      await seed.applyContribution(applyRequest(
        `aggregate-operation:malformed-seed-${corruption.name.replaceAll(" ", "-")}`,
        0,
        contribution("indication:malformed-result", 1, "active", 25_000),
      ));
      mutateAggregateRecord(state, (snapshot) => {
        snapshot.totalAmount = 20_000;
      });
      const preview = await seed.previewReconciliation();
      const request = {
        operationId:
          `aggregate-operation:malformed-${corruption.name.replaceAll(" ", "-")}`,
        expectedCampaignRevision: 1,
        confirmation: confirmationFor(preview),
        ownerSubject: "issuer.invalid/subject:owner",
        occurredAt: "2026-08-09T12:00:00.000Z",
      };
      const malformed = new DevelopmentInMemoryAggregateRepository(
        new MalformedTransactionResultStorageAdapter(adapter, corruption.apply),
        currency,
        revisionAssertion(campaignKey, 1),
      );

      await rejectsStorage(
        () => malformed.applyConfirmedCorrectionWithAudit(request),
        "UNAVAILABLE",
      );
      const recovered = await new DevelopmentInMemoryAggregateRepository(
        adapter,
        evolvedCurrency,
        revisionAssertion(campaignKey, 1),
      ).applyConfirmedCorrectionWithAudit({
        ...request,
        occurredAt: "2026-08-09T12:05:00.000Z",
      });
      assert.equal(recovered.replayed, true);
      assert.equal(recovered.stored.currency, currency);
      assert.deepEqual(
        (await new DevelopmentInMemoryAuditRepository(adapter).list({ limit: 10 }))
          .items,
        [recovered.auditEvent],
      );
    });
  }
});

test("aggregate contribution listing rejects oversized legitimate collections finitely", async () => {
  const adapter = new ScriptedContributionListAdapter((call) => {
    const start = call * MAX_STORAGE_PAGE_SIZE;
    const remaining = MAX_AGGREGATE_CONTRIBUTION_RECORDS + 1 - start;
    const length = Math.min(MAX_STORAGE_PAGE_SIZE, remaining);
    return {
      items: Array.from(
        { length },
        (_, index) => contributionStorageRecord(start + index),
      ),
      nextCursor: start + length < MAX_AGGREGATE_CONTRIBUTION_RECORDS + 1
        ? (`aggregate-test-cursor:${start + length}` as StorageCursor)
        : null,
    };
  });
  const repository = new DevelopmentInMemoryAggregateRepository(
    adapter,
    currency,
  );

  await rejectsStorage(() => repository.previewReconciliation(), "UNAVAILABLE");
  assert.equal(
    adapter.listCalls,
    Math.ceil(MAX_AGGREGATE_CONTRIBUTION_RECORDS / MAX_STORAGE_PAGE_SIZE),
  );
  assert.ok(adapter.listCalls <= MAX_AGGREGATE_CONTRIBUTION_LIST_READS);
});

test("aggregate contribution listing stops endless unique cursors at its page and read ceilings", async () => {
  const adapter = new ScriptedContributionListAdapter((call) => ({
    items: [contributionStorageRecord(call)],
    nextCursor: `aggregate-test-cursor:${call + 1}` as StorageCursor,
  }));
  const repository = new DevelopmentInMemoryAggregateRepository(
    adapter,
    currency,
  );

  await rejectsStorage(() => repository.previewReconciliation(), "UNAVAILABLE");
  assert.equal(adapter.listCalls, MAX_AGGREGATE_CONTRIBUTION_LIST_PAGES);
  assert.equal(adapter.listCalls, MAX_AGGREGATE_CONTRIBUTION_LIST_READS);
});

test("aggregate contribution listing rejects malformed and no-progress pages after one read", async () => {
  const pages = [
    {
      items: [],
      nextCursor: "aggregate-test-cursor:no-progress" as StorageCursor,
    },
    {
      items: [contributionStorageRecord(1)],
      nextCursor: "" as StorageCursor,
    },
    {
      items: Array.from(
        { length: MAX_STORAGE_PAGE_SIZE + 1 },
        (_, index) => contributionStorageRecord(index),
      ),
      nextCursor: null,
    },
  ] satisfies readonly StoragePage[];

  for (const page of pages) {
    const adapter = new ScriptedContributionListAdapter(() => page);
    const repository = new DevelopmentInMemoryAggregateRepository(
      adapter,
      currency,
    );
    await rejectsStorage(
      () => repository.previewReconciliation(),
      "UNAVAILABLE",
    );
    assert.equal(adapter.listCalls, 1);
  }
});

test("audited correction failure leaves both aggregate and audit untouched", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state);
  const seed = new DevelopmentInMemoryAggregateRepository(adapter, currency);
  await seed.applyContribution(applyRequest(
    "aggregate-operation:atomic-failure-seed",
    0,
    contribution("indication:atomic-failure", 1, "active", 5_000),
  ));
  mutateAggregateRecord(state, (snapshot) => {
    snapshot.totalAmount = 4_000;
  });
  const preview = await seed.previewReconciliation();
  const campaignKey = requiredTestStorageKey(
    "campaign-setup-current",
    "configured-campaign",
  );
  setCampaignRevision(state, campaignKey, 1);
  const failing = new DevelopmentInMemoryAggregateRepository(
    new RejectAuditedCorrectionAdapter(adapter),
    currency,
    revisionAssertion(campaignKey, 1),
  );

  await rejectsStorage(
    () => failing.applyConfirmedCorrectionWithAudit({
      operationId: "aggregate-operation:atomic-failure",
      expectedCampaignRevision: 1,
      confirmation: confirmationFor(preview),
      ownerSubject: "issuer.invalid/subject:owner",
      occurredAt: "2026-08-09T12:00:00.000Z",
    }),
    "UNAVAILABLE",
  );
  assert.deepEqual(await seed.previewReconciliation(), preview);
  assert.deepEqual(
    (await new DevelopmentInMemoryAuditRepository(adapter).list({ limit: 10 }))
      .items,
    [],
  );
});

test("integer overflow and malformed projections fail without partial writes", async () => {
  const state = new MemoryStorageState();
  const repository = new DevelopmentInMemoryAggregateRepository(
    new DeterministicMemoryStorageAdapter(state),
    currency,
  );
  await repository.applyContribution(applyRequest(
    "aggregate-operation:max-safe",
    0,
    contribution(
      "indication:max-safe",
      1,
      "active",
      Number.MAX_SAFE_INTEGER,
    ),
  ));
  const transactionsBeforeOverflow = state.transactionCalls;

  await rejectsStorage(
    () => repository.applyContribution(applyRequest(
      "aggregate-operation:amount-overflow",
      1,
      contribution("indication:overflow", 1, "active", 1),
    )),
    "INVALID_REQUEST",
  );
  assert.equal(state.transactionCalls, transactionsBeforeOverflow);
  assert.deepEqual(
    await repository.readStored(),
    stored(1, Number.MAX_SAFE_INTEGER, 1),
  );
  assert.deepEqual(
    await repository.calculate(),
    summary(Number.MAX_SAFE_INTEGER, 1),
  );

  await rejectsStorage(
    () => repository.applyContribution({
      operationId: "aggregate-operation:fractional",
      expectedStoredRevision: 1,
      contribution: {
        ...contribution("indication:fractional", 1, "active", 1),
        amount: 1.5,
      } as unknown as InvestmentAggregateContribution,
    }),
    "INVALID_REQUEST",
  );

  mutateAggregateRecord(state, (snapshot) => {
    snapshot.revision = Number.MAX_SAFE_INTEGER;
  }, Number.MAX_SAFE_INTEGER);
  await rejectsStorage(
    () => repository.applyContribution(applyRequest(
      "aggregate-operation:revision-overflow",
      Number.MAX_SAFE_INTEGER,
      contribution("indication:max-safe", 2, "withdrawn", 0),
    )),
    "PRECONDITION_FAILED",
  );
  assert.equal(state.transactionCalls, transactionsBeforeOverflow);
});

test("public reads use the closed sanitizer and expose no private aggregate facts", async () => {
  const state = new MemoryStorageState();
  const repository = new DevelopmentInMemoryAggregateRepository(
    new DeterministicMemoryStorageAdapter(state),
    currency,
  );
  const privateProjection = {
    ...contribution("indication:private", 1, "active", 12_500),
    participantSubject: "issuer.invalid/subject:private",
    companyName: "Private Company",
    note: "Private strategic note",
  } as unknown as InvestmentAggregateContribution;
  await rejectsStorage(
    () => repository.applyContribution({
      operationId: "aggregate-operation:leaky-projection",
      expectedStoredRevision: 0,
      contribution: privateProjection,
    }),
    "INVALID_REQUEST",
  );

  await repository.applyContribution(applyRequest(
    "aggregate-operation:public-value",
    0,
    contribution("indication:public-value", 1, "active", 12_500),
  ));
  const publicAggregate = await repository.readPublicAggregate(
    visibleConfiguration(),
    10_000,
  );
  assert.deepEqual(publicAggregate, {
    amount: 12_500,
    currency: "XYZ",
    label: "Recorded non-binding interest",
    qualifier: "Self-declared, unverified, and non-binding.",
    oversubscription: {
      status: "oversubscribed",
      targetAmount: 10_000,
      remainingAmount: 0,
      amountOverTarget: 2_500,
    },
  });
  assert.deepEqual(Object.keys(publicAggregate ?? {}), [
    "amount",
    "currency",
    "label",
    "qualifier",
    "oversubscription",
  ]);
  assert.doesNotMatch(
    JSON.stringify(publicAggregate),
    /participant|subject|company|note|contributing|count|indicationId|active|withdrawn|rejected/iu,
  );
  assert.equal(Object.isFrozen(publicAggregate), true);
  assert.equal(
    await repository.readPublicAggregate(hiddenConfiguration(), 10_000),
    null,
  );
});

function applyRequest(
  operationId: string,
  expectedStoredRevision: number,
  value: InvestmentAggregateContribution,
): ApplyAggregateContributionRequest {
  return {
    operationId,
    expectedStoredRevision,
    contribution: value,
  };
}

function contribution(
  id: string,
  indicationRevision: number,
  status: InvestmentAggregateContribution["status"],
  amount: number,
): InvestmentAggregateContribution {
  const parsedId = parseStableId<"investment-indication">(id);
  assert(parsedId.ok);
  return Object.freeze({
    indicationId: parsedId.value,
    indicationRevision,
    status,
    amount: minorUnits(amount),
    currency,
  });
}

function stored(
  revision: number,
  totalAmount: number,
  contributingIndicationCount: number,
) {
  return Object.freeze({
    revision,
    totalAmount: minorUnits(totalAmount),
    currency,
    contributingIndicationCount,
  });
}

function summary(totalAmount: number, contributingIndicationCount: number) {
  return Object.freeze({
    totalAmount: minorUnits(totalAmount),
    currency,
    contributingIndicationCount,
  });
}

function confirmationFor(
  preview: InvestmentAggregateReconciliationPreview,
  overrides: Partial<InvestmentAggregateCorrectionConfirmation> = {},
): InvestmentAggregateCorrectionConfirmation {
  return {
    confirmation: APPLY_CALCULATED_AGGREGATE_CONFIRMATION,
    expectedStoredRevision: preview.stored.revision,
    expectedStoredAmount: preview.stored.totalAmount,
    expectedStoredContributingIndicationCount:
      preview.stored.contributingIndicationCount,
    expectedCalculatedAmount: preview.calculated.totalAmount,
    expectedCalculatedContributingIndicationCount:
      preview.calculated.contributingIndicationCount,
    ...overrides,
  };
}

function visibleConfiguration(): AmountAggregateConfiguration {
  return amountConfiguration({
    visibility: "non_zero",
    label: "Recorded non-binding interest",
    qualifier: "Self-declared, unverified, and non-binding.",
  });
}

function hiddenConfiguration(): AmountAggregateConfiguration {
  return amountConfiguration({ visibility: "hidden" });
}

function amountConfiguration(publicAggregate: unknown) {
  const parsed = parseAmountAggregateConfiguration({
    amount: {
      currency,
      minimum: 0,
      increment: 1,
      maximum: null,
    },
    publicAggregate,
  });
  assert(parsed.ok);
  return parsed.value;
}

function minorUnits(value: number): MinorUnits {
  const parsed = parseMinorUnits(value);
  assert(parsed.ok);
  return parsed.value;
}

async function rejectsStorage(
  operation: () => Promise<unknown>,
  code: StorageFailure["code"],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof StorageFailure);
    assert.equal(error.code, code);
    return;
  }
  assert.fail("Expected a StorageFailure.");
}

type MutableRecord = Record<string, unknown>;

function mutateAggregateRecord(
  state: MemoryStorageState,
  mutation: (snapshot: MutableRecord) => void,
  storageRevision?: number,
): void {
  const entry = [...state.records.entries()].find(([, record]) =>
    record.value.kind === "investment-aggregate-state"
  );
  assert.notEqual(entry, undefined);
  if (entry === undefined) return;
  const [key, record] = entry;
  const document = cloneDocument(record.value) as MutableRecord;
  const snapshot = mutableRecord(document.snapshot);
  mutation(snapshot);
  state.records.set(key, freezeRecord({
    key: record.key,
    revision: storageRevision ?? record.revision,
    value: document as StorageDocument,
  }));
}

function mutateAggregateTerminalReplay(
  state: MemoryStorageState,
  mutation: (terminalReplay: MutableRecord) => void,
): StorageRecord {
  const entry = [...state.records.entries()].find(([, record]) =>
    record.value.kind === "investment-aggregate-state"
  );
  assert.notEqual(entry, undefined);
  if (entry === undefined) assert.fail("Aggregate record expected.");
  const [key, record] = entry;
  const document = cloneDocument(record.value) as MutableRecord;
  const terminalReplay = mutableRecord(document.terminalCorrectionReplay);
  mutation(terminalReplay);
  state.records.set(key, freezeRecord({
    key: record.key,
    revision: record.revision,
    value: document as StorageDocument,
  }));
  return record;
}

function mutableRecord(value: unknown): MutableRecord {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as MutableRecord;
}

function requiredTestStorageKey(collection: string, id: string): StorageKey {
  const parsed = parseStorageKey(collection, id);
  assert(parsed.ok);
  return parsed.value;
}

function revisionAssertion(
  key: StorageKey,
  expectedRevision: number,
): AggregateCorrectionRevisionAssertion {
  return Object.freeze({ type: "check", key, expectedRevision });
}

function setCampaignRevision(
  state: MemoryStorageState,
  key: StorageKey,
  revision: number,
): void {
  state.records.set(storageKeyString(key), freezeRecord({
    key,
    revision,
    value: campaignRevisionDocument(revision),
  }));
}

function campaignRevisionDocument(revision: number): StorageDocument {
  return Object.freeze({
    kind: "campaign-setup-revision",
    schemaVersion: 4,
    revision,
    recordedAt: "2026-08-09T00:00:00.000Z",
    operationId: `campaign-operation:aggregate-fixture-${revision}`,
    setupHash: `sha256:${"0".repeat(64)}`,
    setupBytes: 1,
    setupChunks: 1,
  });
}

function hasStoredOperation(
  state: MemoryStorageState,
  kind: string,
): boolean {
  return [...state.records.values()].some((record) =>
    record.value.operationKind === kind
  );
}

function contributionStorageRecord(index: number): StorageRecord {
  const indicationId = `indication:bounded-${String(index).padStart(4, "0")}`;
  return freezeRecord({
    key: requiredTestStorageKey(
      "investment-aggregate-contributions",
      indicationId,
    ),
    revision: 1,
    value: {
      kind: "investment-aggregate-contribution",
      schemaVersion: 1,
      indicationId,
      indicationRevision: 1,
      status: "active",
      amount: 1,
      currency,
    },
  });
}

class MemoryStorageState {
  readonly records = new Map<string, StorageRecord>();
  readonly operations = new Map<
    string,
    Readonly<{ fingerprint: string; result: StorageTransactionResult }>
  >();
  transactionCalls = 0;
}

class RejectAuditedCorrectionAdapter implements StorageAdapter {
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
    if (
      request.mutations.some((mutation) =>
        mutation.type === "put" && mutation.value.kind === "audit-event"
      )
    ) {
      throw new StorageFailure("UNAVAILABLE");
    }
    return this.#delegate.transact(request);
  }
}

class MalformedTransactionResultStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #apply: (result: StorageTransactionResult) => unknown;

  constructor(
    delegate: StorageAdapter,
    apply: (result: StorageTransactionResult) => unknown,
  ) {
    this.#delegate = delegate;
    this.#apply = apply;
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
    return this.#apply(
      await this.#delegate.transact(request),
    ) as StorageTransactionResult;
  }
}

class CampaignRevisionRaceAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #state: MemoryStorageState;
  readonly #campaignKey: StorageKey;
  raced = false;

  constructor(
    delegate: StorageAdapter,
    state: MemoryStorageState,
    campaignKey: StorageKey,
  ) {
    this.#delegate = delegate;
    this.#state = state;
    this.#campaignKey = campaignKey;
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
    if (
      !this.raced &&
      request.mutations.some((mutation) =>
        mutation.type === "check" &&
        storageKeyString(mutation.key) === storageKeyString(this.#campaignKey)
      )
    ) {
      const key = storageKeyString(this.#campaignKey);
      const current = this.#state.records.get(key);
      assert(current);
      this.#state.records.set(key, freezeRecord({
        key: current.key,
        revision: current.revision + 1,
        value: campaignRevisionDocument(current.revision + 1),
      }));
      this.raced = true;
    }
    return this.#delegate.transact(request);
  }
}

class OverlappingAuditedCorrectionAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #bothArrived: Promise<void>;
  readonly #winnerCommitted: Promise<void>;
  #releaseBothArrived: () => void = () => {};
  #releaseWinnerCommitted: () => void = () => {};
  #arrivals = 0;
  auditedTransactions = 0;
  operationReads = 0;
  auditReads = 0;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
    this.#bothArrived = new Promise((resolve) => {
      this.#releaseBothArrived = resolve;
    });
    this.#winnerCommitted = new Promise((resolve) => {
      this.#releaseWinnerCommitted = resolve;
    });
  }

  read(key: StorageKey): Promise<StorageRecord | null> {
    if (key.collection === "investment-aggregate-operations") {
      this.operationReads += 1;
    } else if (key.collection === "audit-events") {
      this.auditReads += 1;
    }
    return this.#delegate.read(key);
  }

  list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    return this.#delegate.list(request);
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    if (!request.mutations.some((mutation) =>
      mutation.type === "put" && mutation.value.kind === "audit-event"
    )) {
      return this.#delegate.transact(request);
    }

    this.auditedTransactions += 1;
    this.#arrivals += 1;
    if (this.#arrivals === 1) {
      await this.#bothArrived;
      try {
        return await this.#delegate.transact(request);
      } finally {
        this.#releaseWinnerCommitted();
      }
    }

    this.#releaseBothArrived();
    await this.#winnerCommitted;
    return this.#delegate.transact(request);
  }
}

class ScriptedContributionListAdapter implements StorageAdapter {
  readonly #page: (call: number) => StoragePage;
  listCalls = 0;

  constructor(page: (call: number) => StoragePage) {
    this.#page = page;
  }

  async read(): Promise<null> {
    return null;
  }

  async list(
    request: Parameters<StorageAdapter["list"]>[0],
  ): Promise<StoragePage> {
    assertStorageListBoundary(request);
    const call = this.listCalls;
    this.listCalls += 1;
    return this.#page(call);
  }

  async transact(): Promise<StorageTransactionResult> {
    throw new StorageFailure("UNAVAILABLE");
  }
}

class DeterministicMemoryStorageAdapter implements StorageAdapter {
  readonly #state: MemoryStorageState;

  constructor(state: MemoryStorageState) {
    this.#state = state;
  }

  async read(key: StorageKey): Promise<StorageRecord | null> {
    return cloneRecord(this.#state.records.get(storageKeyString(key)) ?? null);
  }

  async list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    assertStorageListBoundary(request);
    const start = request.cursor === undefined ? 0 : parseCursor(request.cursor);
    const records = [...this.#state.records.values()]
      .filter((record) => record.key.collection === request.collection)
      .sort((left, right) => left.key.id.localeCompare(right.key.id));
    if (start < 0 || start > records.length) {
      throw new StorageFailure("INVALID_REQUEST");
    }
    const items = records.slice(start, start + request.limit).map(cloneRecord);
    const next = start + items.length;
    return Object.freeze({
      items: Object.freeze(
        items.filter((item): item is StorageRecord => item !== null),
      ),
      nextCursor: next < records.length
        ? (`aggregate-cursor:${next}` as StorageCursor)
        : null,
    });
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    assertStorageTransactionBoundary(request);
    this.#state.transactionCalls += 1;
    const operationKey = request.operationId as string;
    const fingerprint = JSON.stringify(request);
    const prior = this.#state.operations.get(operationKey);
    if (prior !== undefined) {
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
        if (current !== undefined) throw new StorageFailure("CONFLICT");
      } else if (
        current === undefined ||
        current.revision !== mutation.expectedRevision
      ) {
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
  const match = /^aggregate-cursor:(\d+)$/.exec(cursor);
  if (match === null) throw new StorageFailure("INVALID_REQUEST");
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

function replaceTransactionResultRecord(
  result: StorageTransactionResult,
  index: number,
  replace: (record: StorageRecord) => unknown,
): unknown {
  const record = result.records[index];
  assert(record);
  const records: unknown[] = [...result.records];
  records[index] = replace(record);
  return { ...result, records };
}

function cloneRecord(record: StorageRecord | null): StorageRecord | null {
  return record === null
    ? null
    : freezeRecord({
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
