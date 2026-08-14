import assert from "node:assert/strict";
import test from "node:test";

import { assessCampaignPublicationReadiness } from "../domain/campaign-publication-readiness.ts";
import { parseCampaignSetup } from "../repositories/in-memory-campaign-repository.ts";
import { explicitCampaignSetup } from "./support/campaign-repository-contract.ts";

test("publication readiness combines phase, policy review, and deployment gates", async () => {
  const complete = requiredSetup(explicitCampaignSetup());
  assert.deepEqual(
    await assessCampaignPublicationReadiness(complete, () => true),
    { ready: true, blockers: [] },
  );

  const raw = explicitCampaignSetup();
  const incomplete = requiredSetup({
    ...raw,
    phases: [{ ...raw.phases[0], enabledParticipationPaths: [] }],
    campaignPolicy: {
      ...raw.campaignPolicy,
      publicationReadiness: {
        ...raw.campaignPolicy.publicationReadiness,
        legalNoticesReviewed: false,
      },
    },
  });
  assert.deepEqual(
    await assessCampaignPublicationReadiness(incomplete, () => false),
    {
      ready: false,
      blockers: [
        "phase-setup-incomplete",
        "campaign-policy-incomplete",
        "deployment-not-ready",
      ],
    },
  );
});

function requiredSetup(value: unknown) {
  const parsed = parseCampaignSetup(value);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) throw new Error("Expected valid campaign setup.");
  return parsed.value;
}
