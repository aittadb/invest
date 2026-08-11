import assert from "node:assert/strict";
import test from "node:test";

import { parseStableId } from "../domain/foundation.ts";
import type { InvestmentAggregateContribution } from "../domain/investment-aggregate.ts";
import {
  StorageFailure,
  type StorageAdapter,
  type StorageRecord,
} from "../domain/storage-adapter.ts";
import { DevelopmentInMemoryAggregateRepository } from "../repositories/in-memory-aggregate-repository.ts";
import {
  parseCampaignSetup,
  StorageCampaignRepository,
} from "../repositories/in-memory-campaign-repository.ts";
import { StoragePublicCampaignStateReader } from "../repositories/storage-public-campaign-state-reader.ts";
import {
  campaignSaveRequest,
  explicitCampaignSetup,
  FIRST_CAMPAIGN_SAVE,
  SECOND_CAMPAIGN_SAVE,
} from "./support/campaign-repository-contract.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";

test("published public state exposes only the configured sanitized aggregate", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const campaign = new StorageCampaignRepository(storage);
  const parsedSetup = parseCampaignSetup(explicitCampaignSetup());
  assert(parsedSetup.ok);
  const setup = parsedSetup.value;
  await campaign.saveSetup(campaignSaveRequest({
    operationId: "campaign-operation:public-aggregate",
    recordedAt: FIRST_CAMPAIGN_SAVE,
    expectedRevision: null,
    setup,
  }));
  const reader = new StoragePublicCampaignStateReader(storage);
  const aggregate = new DevelopmentInMemoryAggregateRepository(
    storage,
    setup.amountAggregate.amount.currency,
  );

  assert.deepEqual(await reader.readPublishedState(), {
    campaign: setup.publicCampaign,
    aggregate: null,
  });

  await aggregate.applyContribution(request(
    "aggregate-operation:public-create",
    0,
    contribution("indication:public-state", 1, "active", 12_500),
  ));
  const active = await reader.readPublishedState();
  assert.deepEqual(active?.aggregate, {
    amount: 12_500,
    currency: "SEK",
    label: "Recorded non-binding interest",
    qualifier: "Self-declared, unverified, and non-binding.",
    oversubscription: null,
  });
  assert.deepEqual(Object.keys(active?.aggregate ?? {}), [
    "amount",
    "currency",
    "label",
    "qualifier",
    "oversubscription",
  ]);
  assert.doesNotMatch(
    JSON.stringify(active?.aggregate),
    /participant|subject|company|note|contributing|count|indicationId|moderation|backend/iu,
  );

  await aggregate.applyContribution(request(
    "aggregate-operation:public-edit",
    1,
    contribution("indication:public-state", 2, "active", 15_000),
  ));
  assert.equal((await reader.readPublishedState())?.aggregate?.amount, 15_000);

  const withdrawal = request(
    "aggregate-operation:public-withdraw",
    2,
    contribution("indication:public-state", 3, "withdrawn", 15_000),
  );
  await Promise.all([
    aggregate.applyContribution(withdrawal),
    new DevelopmentInMemoryAggregateRepository(
      storage,
      setup.amountAggregate.amount.currency,
    ).applyContribution(withdrawal),
  ]);
  assert.equal((await reader.readPublishedState())?.aggregate, null);

  await aggregate.applyContribution(request(
    "aggregate-operation:public-reactivate",
    3,
    contribution("indication:public-state", 4, "active", 16_000),
  ));
  assert.equal((await reader.readPublishedState())?.aggregate?.amount, 16_000);

  await campaign.saveSetup(campaignSaveRequest({
    operationId: "campaign-operation:hide-public-aggregate",
    recordedAt: SECOND_CAMPAIGN_SAVE,
    expectedRevision: 1,
    setup: {
      ...setup,
      amountAggregate: {
        ...setup.amountAggregate,
        publicAggregate: { visibility: "hidden" },
      },
    },
  }));
  let hiddenAggregateReads = 0;
  const hiddenStorage: StorageAdapter = {
    async read(key) {
      if (key.collection === "investment-aggregate-states") {
        hiddenAggregateReads += 1;
        throw new Error("hidden aggregate must not be read");
      }
      return storage.read(key);
    },
    list: storage.list.bind(storage),
    transact: storage.transact.bind(storage),
  };
  assert.equal(
    (await new StoragePublicCampaignStateReader(hiddenStorage)
      .readPublishedState())?.aggregate,
    null,
  );
  assert.equal(hiddenAggregateReads, 0);

  await campaign.saveSetup(campaignSaveRequest({
    operationId: "campaign-operation:show-public-aggregate",
    recordedAt: "2026-08-09T10:00:00.000Z",
    expectedRevision: 2,
    setup,
  }));
  assert.equal((await reader.readPublishedState())?.aggregate?.amount, 16_000);

  await aggregate.applyContribution(request(
    "aggregate-operation:public-reject",
    4,
    contribution("indication:public-state", 5, "rejected", 16_000),
  ));
  assert.equal((await reader.readPublishedState())?.aggregate, null);
});

test("schema-4 published public state preserves campaign without reading an aggregate", async () => {
  const fixture = legacyPublicPresentationFixture(true);

  assert.deepEqual(
    await new StoragePublicCampaignStateReader(fixture.storage)
      .readPublishedState(),
    {
      campaign: fixture.campaign,
      aggregate: null,
    },
  );
  assert.equal(fixture.reads.publicPresentation, 2);
  assert.equal(fixture.reads.aggregate, 0);
});

test("schema-4 unpublished public state remains hidden without reading an aggregate", async () => {
  const fixture = legacyPublicPresentationFixture(false);

  assert.equal(
    await new StoragePublicCampaignStateReader(fixture.storage)
      .readPublishedState(),
    null,
  );
  assert.equal(fixture.reads.publicPresentation, 1);
  assert.equal(fixture.reads.aggregate, 0);
});

test("public state retries a concurrent published-policy change as one projection", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const campaign = new StorageCampaignRepository(storage);
  const parsedSetup = parseCampaignSetup(explicitCampaignSetup());
  assert(parsedSetup.ok);
  const setup = parsedSetup.value;
  await campaign.saveSetup(campaignSaveRequest({
    operationId: "campaign-operation:public-race-seed",
    recordedAt: FIRST_CAMPAIGN_SAVE,
    expectedRevision: null,
    setup,
  }));
  const aggregate = new DevelopmentInMemoryAggregateRepository(
    storage,
    setup.amountAggregate.amount.currency,
  );
  await aggregate.applyContribution(request(
    "aggregate-operation:public-race-seed",
    0,
    contribution("indication:public-race", 1, "active", 22_500),
  ));

  let raced = false;
  let publicReads = 0;
  let aggregateReads = 0;
  const racingStorage: StorageAdapter = {
    async read(key) {
      if (key.collection === "campaign-public-presentation") {
        publicReads += 1;
      }
      if (key.collection === "investment-aggregate-states") {
        aggregateReads += 1;
        if (!raced) {
          raced = true;
          await campaign.saveSetup(campaignSaveRequest({
            operationId: "campaign-operation:public-race-update",
            recordedAt: SECOND_CAMPAIGN_SAVE,
            expectedRevision: 1,
            setup: {
              ...setup,
              publicCampaign: {
                ...setup.publicCampaign,
                name: "Updated published campaign",
              },
              amountAggregate: {
                ...setup.amountAggregate,
                publicAggregate: {
                  visibility: "non_zero",
                  label: "Updated aggregate label",
                  qualifier: "Updated public aggregate qualifier.",
                },
              },
            },
          }));
        }
      }
      return storage.read(key);
    },
    list: storage.list.bind(storage),
    transact: storage.transact.bind(storage),
  };

  const result = await new StoragePublicCampaignStateReader(
    racingStorage,
  ).readPublishedState();
  assert.equal(raced, true);
  assert.equal(publicReads, 4);
  assert.equal(aggregateReads, 2);
  assert.equal(result?.campaign.name, "Updated published campaign");
  assert.equal(result?.aggregate?.amount, 22_500);
  assert.equal(result?.aggregate?.label, "Updated aggregate label");
  assert.equal(
    result?.aggregate?.qualifier,
    "Updated public aggregate qualifier.",
  );
});

test("public state observes a concurrent indication update atomically", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const campaign = new StorageCampaignRepository(storage);
  const parsedSetup = parseCampaignSetup(explicitCampaignSetup());
  assert(parsedSetup.ok);
  const setup = parsedSetup.value;
  await campaign.saveSetup(campaignSaveRequest({
    operationId: "campaign-operation:aggregate-race",
    recordedAt: FIRST_CAMPAIGN_SAVE,
    expectedRevision: null,
    setup,
  }));
  const aggregate = new DevelopmentInMemoryAggregateRepository(
    storage,
    setup.amountAggregate.amount.currency,
  );
  await aggregate.applyContribution(request(
    "aggregate-operation:aggregate-race-create",
    0,
    contribution("indication:aggregate-race", 1, "active", 10_000),
  ));

  let updated = false;
  const racingStorage: StorageAdapter = {
    async read(key) {
      if (
        !updated &&
        key.collection === "investment-aggregate-states"
      ) {
        updated = true;
        await aggregate.applyContribution(request(
          "aggregate-operation:aggregate-race-edit",
          1,
          contribution("indication:aggregate-race", 2, "active", 17_500),
        ));
      }
      return storage.read(key);
    },
    list: storage.list.bind(storage),
    transact: storage.transact.bind(storage),
  };

  const result = await new StoragePublicCampaignStateReader(
    racingStorage,
  ).readPublishedState();
  assert.equal(updated, true);
  assert.equal(result?.aggregate?.amount, 17_500);
  assert.equal(
    (await new StoragePublicCampaignStateReader(storage).readPublishedState())
      ?.aggregate?.amount,
    17_500,
  );
});

test("public state hides corrupt private aggregate detail and bounds policy retries", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const campaign = new StorageCampaignRepository(storage);
  const parsedSetup = parseCampaignSetup(explicitCampaignSetup());
  assert(parsedSetup.ok);
  const setup = parsedSetup.value;
  await campaign.saveSetup(campaignSaveRequest({
    operationId: "campaign-operation:public-failure",
    recordedAt: FIRST_CAMPAIGN_SAVE,
    expectedRevision: null,
    setup,
  }));
  const aggregate = new DevelopmentInMemoryAggregateRepository(
    storage,
    setup.amountAggregate.amount.currency,
  );
  await aggregate.applyContribution(request(
    "aggregate-operation:public-failure",
    0,
    contribution("indication:public-failure", 1, "active", 12_500),
  ));

  const aggregateEntry = [...state.records.entries()].find(([, record]) =>
    record.key.collection === "investment-aggregate-states"
  );
  assert(aggregateEntry);
  const [aggregateKey, aggregateRecord] = aggregateEntry;
  state.records.set(aggregateKey, Object.freeze({
    ...aggregateRecord,
    value: Object.freeze({
      ...(aggregateRecord.value as Record<string, unknown>),
      participantSubject: "private-subject",
      companyNote: "private-company-note",
    }),
  }) as StorageRecord);

  const hidden = await new StoragePublicCampaignStateReader(
    storage,
  ).readPublishedState();
  assert.equal(hidden?.campaign.name, setup.publicCampaign.name);
  assert.equal(hidden?.aggregate, null);
  assert.doesNotMatch(
    JSON.stringify(hidden),
    /private-subject|private-company-note/iu,
  );

  let publicReads = 0;
  const unstableStorage: StorageAdapter = {
    async read(key) {
      if (key.collection === "campaign-public-presentation") {
        publicReads += 1;
        const record = await storage.read(key);
        if (record === null) return null;
        return Object.freeze({
          ...record,
          revision: publicReads,
          value: Object.freeze({
            ...(record.value as Record<string, unknown>),
            revision: publicReads,
          }),
        }) as StorageRecord;
      }
      return storage.read(key);
    },
    list: storage.list.bind(storage),
    transact: storage.transact.bind(storage),
  };
  await assert.rejects(
    () => new StoragePublicCampaignStateReader(unstableStorage)
      .readPublishedState(),
    (error: unknown) =>
      error instanceof StorageFailure && error.code === "UNAVAILABLE",
  );
  assert.equal(publicReads, 4);
});

function request(
  operationId: string,
  expectedStoredRevision: number,
  value: InvestmentAggregateContribution,
) {
  return Object.freeze({
    operationId,
    expectedStoredRevision,
    contribution: value,
  });
}

function contribution(
  id: string,
  revision: number,
  status: InvestmentAggregateContribution["status"],
  amount: number,
): InvestmentAggregateContribution {
  const parsed = parseStableId<"investment-indication">(id);
  assert(parsed.ok);
  return Object.freeze({
    indicationId: parsed.value,
    indicationRevision: revision,
    status,
    amount: amount as InvestmentAggregateContribution["amount"],
    currency: "SEK" as InvestmentAggregateContribution["currency"],
  });
}

function legacyPublicPresentationFixture(published: boolean) {
  const reads = { publicPresentation: 0, aggregate: 0 };
  const campaign = Object.freeze({
    ...explicitCampaignSetup().publicCampaign,
    published,
  });
  const storage: StorageAdapter = {
    async read(key) {
      if (key.collection === "investment-aggregate-states") {
        reads.aggregate += 1;
        return null;
      }
      if (
        key.collection !== "campaign-public-presentation" ||
        key.id !== "configured-campaign"
      ) return null;
      reads.publicPresentation += 1;
      return Object.freeze({
        key: Object.freeze({ ...key }),
        revision: 1,
        value: Object.freeze({
          kind: "campaign-public-presentation",
          schemaVersion: 4,
          revision: 1,
          publicCampaign: campaign,
        }),
      });
    },
    async list() {
      throw new StorageFailure("UNAVAILABLE");
    },
    async transact() {
      throw new StorageFailure("UNAVAILABLE");
    },
  };
  return Object.freeze({ campaign, reads, storage });
}
