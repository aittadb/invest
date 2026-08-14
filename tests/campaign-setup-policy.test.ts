import assert from "node:assert/strict";
import test from "node:test";

import {
  checkCampaignSetupPolicy,
  classifyCampaignSetupChange,
  parseCampaignSetupPolicy,
  type CampaignSetupPolicy,
} from "../domain/campaign-setup-policy.ts";
import {
  participantRegistrationNoticesFromCampaignPolicy,
} from "../domain/participant-registration-resource.ts";
import {
  parsePhaseConfiguration,
  type PhaseConfiguration,
} from "../domain/phase-configuration.ts";

function policy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    founderContributionChoices: [
      { id: "area:engineering", label: "  Engineering  " },
      { id: "area:product", label: "Product" },
    ],
    notices: {
      legalBoundary: "  This service records an expression of interest.  ",
      nonBindingInterest: "No payment or commitment is created.",
      processEmail: "Required messages concern registration and review.",
      marketingConsent: "Optional product updates require separate consent.",
      privacyContact: {
        label: "Privacy contact",
        href: "mailto:privacy@example.test",
      },
      retention: "The published privacy notice explains retention.",
    },
    publicationReadiness: {
      publicPresentationReviewed: true,
      legalNoticesReviewed: true,
      privacyAndRetentionReviewed: true,
    },
    ...overrides,
  };
}

function requiredPolicy(value: unknown = policy()): CampaignSetupPolicy {
  const parsed = parseCampaignSetupPolicy(value);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) throw new Error("Expected valid campaign setup policy.");
  return parsed.value;
}

function phase(paths: readonly string[]): PhaseConfiguration {
  const parsed = parsePhaseConfiguration({
    id: "phase:synthetic",
    state: "open",
    enabledParticipationPaths: paths,
    countryEligibility: { mode: "deny", countries: [] },
  });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) throw new Error("Expected valid phase.");
  return parsed.value;
}

test("campaign policy requires and freezes every deployment-owned decision", () => {
  const parsed = parseCampaignSetupPolicy(policy());
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) return;

  assert.equal(parsed.value.notices.legalBoundary, "This service records an expression of interest.");
  assert.equal(parsed.value.founderContributionChoices[0]?.label, "Engineering");
  assert.equal(parsed.value.notices.privacyContact.href, "mailto:privacy@example.test");
  assert.deepEqual(
    participantRegistrationNoticesFromCampaignPolicy(parsed.value),
    {
      processEmail: "Required messages concern registration and review.",
      marketing: "Optional product updates require separate consent.",
    },
  );
  assert.equal(Object.isFrozen(parsed.value), true);
  assert.equal(Object.isFrozen(parsed.value.notices), true);
  assert.equal(Object.isFrozen(parsed.value.publicationReadiness), true);
  assert.equal(Object.isFrozen(parsed.value.founderContributionChoices), true);
});

test("campaign policy supplies no notice, founder-choice, or review defaults", () => {
  assert.deepEqual(parseCampaignSetupPolicy({}), {
    ok: false,
    issues: [
      { code: "required", path: "founderContributionChoices" },
      { code: "required", path: "notices" },
      { code: "required", path: "publicationReadiness" },
    ],
  });

  const incomplete = parseCampaignSetupPolicy(policy({
    notices: {},
    publicationReadiness: {},
  }));
  assert.equal(incomplete.ok, false);
  if (incomplete.ok) return;
  assert.deepEqual(incomplete.issues, [
    { code: "required", path: "notices.legalBoundary" },
    { code: "required", path: "notices.nonBindingInterest" },
    { code: "required", path: "notices.processEmail" },
    { code: "required", path: "notices.marketingConsent" },
    { code: "required", path: "notices.privacyContact" },
    { code: "required", path: "notices.retention" },
    { code: "required", path: "publicationReadiness.publicPresentationReviewed" },
    { code: "required", path: "publicationReadiness.legalNoticesReviewed" },
    { code: "required", path: "publicationReadiness.privacyAndRetentionReviewed" },
  ]);
});

test("campaign policy rejects unknown, unsafe, duplicate, and malformed values", () => {
  assert.equal(parseCampaignSetupPolicy({ ...policy(), unexpected: true }).ok, false);
  assert.equal(parseCampaignSetupPolicy(policy({
    founderContributionChoices: [
      { id: "area:duplicate", label: "One" },
      { id: "area:duplicate", label: "Two" },
    ],
  })).ok, false);
  assert.equal(parseCampaignSetupPolicy(policy({
    notices: {
      ...(policy().notices as Record<string, unknown>),
      processEmail: "Required process message.\nInjected second line.",
    },
  })).ok, false);
  assert.equal(parseCampaignSetupPolicy(policy({
    notices: {
      ...(policy().notices as Record<string, unknown>),
      privacyContact: { label: "Unsafe", href: "javascript:alert(1)" },
    },
  })).ok, false);
  assert.equal(parseCampaignSetupPolicy(policy({
    publicationReadiness: {
      publicPresentationReviewed: "yes",
      legalNoticesReviewed: true,
      privacyAndRetentionReviewed: true,
    },
  })).ok, false);
});

test("publication policy readiness respects founder paths and every review gate", () => {
  const complete = requiredPolicy();
  assert.deepEqual(checkCampaignSetupPolicy(complete, [phase(["founder", "investor"])]), {
    complete: true,
    missing: [],
  });

  const emptyChoices = requiredPolicy(policy({ founderContributionChoices: [] }));
  assert.deepEqual(checkCampaignSetupPolicy(emptyChoices, [phase(["founder"])]), {
    complete: false,
    missing: ["founderContributionChoices"],
  });
  assert.deepEqual(checkCampaignSetupPolicy(emptyChoices, [phase(["investor"])]), {
    complete: true,
    missing: [],
  });

  const unreviewed = requiredPolicy(policy({
    publicationReadiness: {
      publicPresentationReviewed: false,
      legalNoticesReviewed: false,
      privacyAndRetentionReviewed: true,
    },
  }));
  assert.deepEqual(checkCampaignSetupPolicy(unreviewed, [phase(["investor"])]), {
    complete: false,
    missing: [
      "publicationReadiness.publicPresentationReviewed",
      "publicationReadiness.legalNoticesReviewed",
    ],
  });
});

test("setup changes classify copy separately from participation policy", () => {
  const campaignPolicy = requiredPolicy();
  const base = {
    publicCampaign: { name: "Synthetic campaign", published: false },
    phases: [phase(["founder", "investor"])],
    amountAggregate: { amount: { currency: "XYZ", increment: 1 } },
    campaignPolicy,
  };

  assert.equal(classifyCampaignSetupChange(base, base), "none");
  assert.equal(classifyCampaignSetupChange(base, {
    ...base,
    publicCampaign: { ...base.publicCampaign, name: "Updated copy" },
  }), "editorial");
  assert.equal(classifyCampaignSetupChange(base, {
    ...base,
    phases: [phase(["investor"])],
  }), "material");
  assert.equal(classifyCampaignSetupChange(base, {
    ...base,
    campaignPolicy: requiredPolicy(policy({
      notices: {
        ...(policy().notices as Record<string, unknown>),
        processEmail: "A changed required process message.",
      },
    })),
  }), "material");
});
