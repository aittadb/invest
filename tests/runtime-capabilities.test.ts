import assert from "node:assert/strict";
import test from "node:test";

import {
  OWNER_AITTADB_CONNECTION_HEADER,
  OWNER_CAMPAIGN_EDITOR_CAPABILITY_HEADER,
  OWNER_CAMPAIGN_SETUP_CAPABILITY_HEADER,
  OWNER_INDICATION_MODERATION_HEADER,
  OWNER_PACKAGE_WORKSPACE_HEADER,
  OWNER_REVIEW_EXPORTS_HEADER,
  PARTICIPANT_FOUNDER_INTEREST_HEADER,
  PARTICIPANT_INVESTMENT_INTERESTS_HEADER,
  hasOwnerAittaDBConnection,
  hasOwnerCampaignEditorCapability,
  hasOwnerCampaignSetupCapability,
  hasOwnerIndicationModeration,
  hasOwnerPackageWorkspace,
  hasOwnerReviewExports,
  hasParticipantFounderInterest,
  hasParticipantInvestmentInterests,
  withRuntimeCapabilities,
} from "../http/runtime-capabilities.ts";

test("the Worker replaces client-supplied owner feature availability", () => {
  const spoofed = new Request("https://campaign.example/owner", {
    headers: {
      [OWNER_PACKAGE_WORKSPACE_HEADER]: "available",
      [OWNER_CAMPAIGN_EDITOR_CAPABILITY_HEADER]: "available",
      [OWNER_CAMPAIGN_SETUP_CAPABILITY_HEADER]: "available",
      [OWNER_INDICATION_MODERATION_HEADER]: "available",
      [OWNER_REVIEW_EXPORTS_HEADER]: "available",
      [PARTICIPANT_FOUNDER_INTEREST_HEADER]: "available",
      [PARTICIPANT_INVESTMENT_INTERESTS_HEADER]: "available",
      [OWNER_AITTADB_CONNECTION_HEADER]: "available",
    },
  });
  const unavailable = withRuntimeCapabilities(spoofed, {
    ownerPackageWorkspace: false,
    ownerCampaignEditor: false,
    ownerCampaignSetup: false,
    ownerIndicationModeration: false,
    ownerReviewExports: false,
    participantFounderInterest: false,
    participantInvestmentInterests: false,
    ownerAittadbConnection: false,
  });
  assert.equal(unavailable.headers.get(OWNER_PACKAGE_WORKSPACE_HEADER), null);
  assert.equal(
    unavailable.headers.get(OWNER_CAMPAIGN_EDITOR_CAPABILITY_HEADER),
    null,
  );
  assert.equal(
    unavailable.headers.get(OWNER_CAMPAIGN_SETUP_CAPABILITY_HEADER),
    null,
  );
  assert.equal(unavailable.headers.get(OWNER_INDICATION_MODERATION_HEADER), null);
  assert.equal(unavailable.headers.get(OWNER_REVIEW_EXPORTS_HEADER), null);
  assert.equal(unavailable.headers.get(PARTICIPANT_FOUNDER_INTEREST_HEADER), null);
  assert.equal(
    unavailable.headers.get(PARTICIPANT_INVESTMENT_INTERESTS_HEADER),
    null,
  );
  assert.equal(unavailable.headers.get(OWNER_AITTADB_CONNECTION_HEADER), null);
  assert.equal(hasOwnerPackageWorkspace("AVAILABLE"), false);
  assert.equal(hasOwnerCampaignEditorCapability("AVAILABLE"), false);
  assert.equal(hasOwnerCampaignSetupCapability("AVAILABLE"), false);
  assert.equal(hasOwnerIndicationModeration("AVAILABLE"), false);
  assert.equal(hasOwnerReviewExports("AVAILABLE"), false);
  assert.equal(hasParticipantFounderInterest("AVAILABLE"), false);
  assert.equal(hasParticipantInvestmentInterests("AVAILABLE"), false);
  assert.equal(hasOwnerAittaDBConnection("AVAILABLE"), false);

  const available = withRuntimeCapabilities(spoofed, {
    ownerPackageWorkspace: true,
    ownerCampaignEditor: true,
    ownerCampaignSetup: true,
    ownerIndicationModeration: true,
    ownerReviewExports: true,
    participantFounderInterest: true,
    participantInvestmentInterests: true,
    ownerAittadbConnection: true,
  });
  assert.equal(
    available.headers.get(OWNER_PACKAGE_WORKSPACE_HEADER),
    "available",
  );
  assert.equal(
    hasOwnerCampaignEditorCapability(
      available.headers.get(OWNER_CAMPAIGN_EDITOR_CAPABILITY_HEADER),
    ),
    true,
  );
  assert.equal(
    hasOwnerCampaignSetupCapability(
      available.headers.get(OWNER_CAMPAIGN_SETUP_CAPABILITY_HEADER),
    ),
    true,
  );
  assert.equal(
    hasOwnerPackageWorkspace(
      available.headers.get(OWNER_PACKAGE_WORKSPACE_HEADER),
    ),
    true,
  );
  assert.equal(
    hasOwnerIndicationModeration(
      available.headers.get(OWNER_INDICATION_MODERATION_HEADER),
    ),
    true,
  );
  assert.equal(
    hasOwnerReviewExports(
      available.headers.get(OWNER_REVIEW_EXPORTS_HEADER),
    ),
    true,
  );
  assert.equal(
    hasParticipantFounderInterest(
      available.headers.get(PARTICIPANT_FOUNDER_INTEREST_HEADER),
    ),
    true,
  );
  assert.equal(
    hasParticipantInvestmentInterests(
      available.headers.get(PARTICIPANT_INVESTMENT_INTERESTS_HEADER),
    ),
    true,
  );
  assert.equal(
    hasOwnerAittaDBConnection(
      available.headers.get(OWNER_AITTADB_CONNECTION_HEADER),
    ),
    true,
  );
});
