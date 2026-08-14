import assert from "node:assert/strict";

import { StorageFailure } from "../../domain/storage-adapter.ts";
import type { CampaignRepository } from "../../repositories/in-memory-campaign-repository.ts";
import { syntheticPublicCampaign } from "../fixtures/public-campaign.ts";

export const FIRST_CAMPAIGN_SAVE = "2026-08-09T08:00:00.000Z";
export const SECOND_CAMPAIGN_SAVE = "2026-08-09T09:00:00.000Z";

export type CampaignRepositoryContractFixture = Readonly<{
  owner: CampaignRepository;
  outsider: CampaignRepository;
  reopenOwner: () => CampaignRepository;
}>;

export type CampaignRepositoryContractFactory =
  () => CampaignRepositoryContractFixture;

/** Reusable behavior contract for development and production repositories. */
export async function verifyCampaignRepositoryContract(
  createFixture: CampaignRepositoryContractFactory,
): Promise<void> {
  const fixture = createFixture();
  assert.equal(await fixture.owner.readSetup(), null);
  assert.deepEqual(await fixture.owner.listSetupHistory({ limit: 10 }), {
    items: [],
    nextCursor: null,
  });
  assert.equal(
    await fixture.owner.findSetupByOperationId("campaign-operation:missing"),
    null,
  );

  const create = campaignSaveRequest({
    operationId: "campaign-operation:create",
    recordedAt: FIRST_CAMPAIGN_SAVE,
    expectedRevision: null,
    setup: explicitCampaignSetup(),
  });
  const first = await fixture.owner.saveSetup(create);
  assert.equal(first.revision, 1);
  assert.equal(first.setup.publicCampaign.name, syntheticPublicCampaign.name);
  assert.deepEqual(
    await fixture.owner.findSetupByOperationId("campaign-operation:create"),
    first,
  );

  const replay = await fixture.owner.saveSetup(create);
  assert.deepEqual(replay, first);

  const reopened = fixture.reopenOwner();
  assert.deepEqual(await reopened.readSetup(), first);
  assert.deepEqual(
    await reopened.findSetupByOperationId("campaign-operation:create"),
    first,
  );

  const second = await fixture.owner.saveSetup(campaignSaveRequest({
    operationId: "campaign-operation:update",
    recordedAt: SECOND_CAMPAIGN_SAVE,
    expectedRevision: 1,
    setup: explicitCampaignSetup({ campaignName: "Northstar Systems" }),
  }));
  assert.equal(second.revision, 2);
  assert.deepEqual(
    await fixture.owner.findSetupByOperationId("campaign-operation:update"),
    second,
  );

  const stale = await captureStorageFailure(() => fixture.owner.saveSetup(
    campaignSaveRequest({
      operationId: "campaign-operation:stale",
      recordedAt: SECOND_CAMPAIGN_SAVE,
      expectedRevision: 1,
      setup: explicitCampaignSetup({ campaignName: "Stale Campaign Name" }),
    }),
  ));
  assert.equal(stale.code, "PRECONDITION_FAILED");

  const firstPage = await reopened.listSetupHistory({ limit: 1 });
  assert.deepEqual(firstPage.items.map(({ revision }) => revision), [1]);
  assert.notEqual(firstPage.nextCursor, null);
  const secondPage = await reopened.listSetupHistory({
    limit: 1,
    ...(firstPage.nextCursor ? { cursor: firstPage.nextCursor } : {}),
  });
  assert.deepEqual(secondPage.items.map(({ revision }) => revision), [2]);
  assert.equal(secondPage.nextCursor, null);

  assert.equal(await fixture.outsider.readSetup(), null);
  assert.equal(
    await fixture.outsider.findSetupByOperationId("campaign-operation:create"),
    null,
  );
  assert.deepEqual(await fixture.outsider.listSetupHistory({ limit: 10 }), {
    items: [],
    nextCursor: null,
  });
}

export type ExplicitCampaignSetupOptions = Readonly<{
  campaignName?: string;
  currency?: string;
  phaseState?: "closed" | "open";
}>;

export function explicitCampaignSetup(
  options: ExplicitCampaignSetupOptions = {},
) {
  return {
    publicCampaign: {
      ...syntheticPublicCampaign,
      name: options.campaignName ?? syntheticPublicCampaign.name,
    },
    phases: [
      {
        id: "phase:domestic",
        state: options.phaseState ?? "open",
        enabledParticipationPaths: ["investor", "founder"],
        countryEligibility: {
          mode: "allow",
          countries: ["se", "FI"],
        },
      },
    ],
    amountAggregate: {
      amount: {
        currency: options.currency ?? "sek",
        minimum: 25_000,
        increment: 5_000,
        maximum: 500_000,
      },
      publicAggregate: {
        visibility: "non_zero",
        label: "Recorded non-binding interest",
        qualifier: "Self-declared, unverified, and non-binding.",
      },
    },
    campaignPolicy: {
      founderContributionChoices: [
        { id: "area:engineering", label: "Engineering" },
        { id: "area:product", label: "Product" },
      ],
      notices: {
        legalBoundary:
          "This registration records interest and is not a securities offer.",
        nonBindingInterest:
          "No payment, allocation, reservation, or commitment is created.",
        processEmail:
          "Required messages concern this registration and its review.",
        marketingConsent:
          "Optional updates require separate consent and can be declined.",
        privacyContact: {
          label: "Northstar privacy contact",
          href: "https://northstar.example/privacy",
        },
        retention:
          "The published privacy notice explains retention and deletion handling.",
      },
      publicationReadiness: {
        publicPresentationReviewed: true,
        legalNoticesReviewed: true,
        privacyAndRetentionReviewed: true,
      },
    },
  };
}

export function campaignSaveRequest(input: Readonly<{
  operationId: unknown;
  recordedAt: unknown;
  expectedRevision: number | null;
  setup: unknown;
}>) {
  return input;
}

export async function captureStorageFailure(
  operation: () => Promise<unknown>,
): Promise<StorageFailure> {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof StorageFailure);
    return error;
  }
  assert.fail("Expected a StorageFailure.");
}
