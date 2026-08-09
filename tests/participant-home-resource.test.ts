import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeParticipantAccess,
  createParticipantHomeDocument,
  createPrivatePackageDocument,
  parseAuthorizedParticipantAccess,
  type ParticipantAuthorizationState,
} from "../domain/participant-home-resource.ts";
import {
  parseActorSubject,
  parseStableId,
  parseTimestamp,
} from "../domain/foundation.ts";
import { createPackageVersion } from "../domain/package-content.ts";
import {
  parseParticipantAccount,
  registerParticipantProfile,
} from "../domain/participant-profile.ts";
import { createPublicCampaignDocument } from "../domain/public-campaign-resource.ts";
import { readParticipantAuthorizationState } from "../services/participant-access.ts";
import { syntheticPublicCampaign } from "./fixtures/public-campaign.ts";

test("participant authorization binds private state to the trusted account subject", () => {
  const alice = account("oidc:alice", "alice@example.test");
  const authorized = authorizeParticipantAccess(
    alice,
    authorizationState(alice.subject),
  );
  assert.ok(authorized);
  assert.equal(authorized.subject, alice.subject);
  assert.equal(authorized.email, alice.accountEmailLabel);
  assert.equal(authorized.currentPackage?.changeSummary, "Private current package");

  const foreign = authorizeParticipantAccess(
    alice,
    authorizationState(actorSubject("oidc:bob")),
  );
  assert.equal(foreign, null);
  assert.equal(authorizeParticipantAccess(alice, null), null);

  const malformed = {
    ...authorizationState(alice.subject),
    currentPackage: {
      ...authorizationState(alice.subject).currentPackage,
      changeSummary: "Private value\u0000must not pass",
    },
  } as ParticipantAuthorizationState;
  assert.equal(authorizeParticipantAccess(alice, malformed), null);
  assert.equal(
    authorizeParticipantAccess(
      alice,
      { profile: null } as unknown as ParticipantAuthorizationState,
    ),
    null,
  );
});

test("authorized state round-trips only through the bounded renderer projection", () => {
  const alice = account("oidc:alice", "alice@example.test");
  const authorized = authorizeParticipantAccess(
    alice,
    authorizationState(alice.subject),
  );
  assert.ok(authorized);

  assert.deepEqual(
    parseAuthorizedParticipantAccess(JSON.parse(JSON.stringify(authorized))),
    authorized,
  );
  assert.equal(
    parseAuthorizedParticipantAccess({
      ...authorized,
      subject: " oidc:alice ",
    }),
    null,
  );
  assert.equal(parseAuthorizedParticipantAccess({ ...authorized, email: "bad" }), null);
});

test("public and participant documents project only authorized capabilities", () => {
  const alice = account("oidc:alice", "alice@example.test");
  const participant = authorizeParticipantAccess(
    alice,
    authorizationState(alice.subject),
  );
  assert.ok(participant);

  const visitor = createPublicCampaignDocument(
    "https://campaign.example/",
    syntheticPublicCampaign,
  );
  assert.equal(
    visitor.links.some((link) => link.rel.includes("participant-home")),
    false,
  );
  assert.equal(
    visitor.links.some((link) => link.rel.includes("private-package")),
    false,
  );

  const signedIn = createPublicCampaignDocument(
    "https://campaign.example/",
    syntheticPublicCampaign,
    { participant: { privatePackage: true }, manageCampaign: true },
  );
  assert.deepEqual(
    signedIn.actions.map((action) => action.name),
    ["open-participant-home", "read-private-package", "manage-campaign"],
  );
  assert.ok(signedIn.links.some((link) => link.rel.includes("participant-home")));
  assert.ok(signedIn.links.some((link) => link.rel.includes("private-package")));

  const home = createParticipantHomeDocument(
    "https://campaign.example/participant",
    participant,
    syntheticPublicCampaign.name,
    { manageCampaign: true },
  );
  assert.equal(home.type, "participant-home");
  assert.equal(home.data.account_email, "alice@example.test");
  assert.deepEqual(
    home.actions.map((action) => action.name),
    ["read-private-package", "manage-campaign", "sign-out"],
  );

  const privatePackage = createPrivatePackageDocument(
    "https://campaign.example/participant/package",
    participant,
  );
  assert.ok(privatePackage);
  assert.equal(privatePackage.type, "private-package");
  assert.equal(privatePackage.data.change_summary, "Private current package");
});

test("participant documents expose only configured and permitted interest workflows", () => {
  const both = authorizedParticipant("both");
  const bothHome = createParticipantHomeDocument(
    "https://campaign.example/participant",
    both,
    syntheticPublicCampaign.name,
    { founderInterest: true, investmentInterests: true },
  );
  assert.deepEqual(
    bothHome.actions.map((action) => action.name),
    [
      "read-private-package",
      "open-founder-interest",
      "open-investment-interests",
      "sign-out",
    ],
  );
  assert.ok(bothHome.links.some((link) => link.rel.includes("founder-interest")));
  assert.ok(
    bothHome.links.some((link) => link.rel.includes("investment-interests")),
  );

  const founderHome = createParticipantHomeDocument(
    "https://campaign.example/participant",
    authorizedParticipant("founder"),
    syntheticPublicCampaign.name,
    { founderInterest: true, investmentInterests: true },
  );
  assert.deepEqual(
    founderHome.actions.map((action) => action.name),
    ["read-private-package", "open-founder-interest", "sign-out"],
  );

  const investorPackage = createPrivatePackageDocument(
    "https://campaign.example/participant/package",
    authorizedParticipant("investor"),
    { founderInterest: true, investmentInterests: true },
  );
  assert.ok(investorPackage);
  assert.deepEqual(
    investorPackage.actions.map((action) => action.name),
    ["open-participant-home", "open-investment-interests", "sign-out"],
  );

  const deletionRequested = {
    ...both,
    accountStatus: "deletion-requested" as const,
  };
  const inactiveHome = createParticipantHomeDocument(
    "https://campaign.example/participant",
    deletionRequested,
    syntheticPublicCampaign.name,
    { founderInterest: true, investmentInterests: true },
  );
  assert.deepEqual(
    inactiveHome.actions.map((action) => action.name),
    ["read-private-package", "sign-out"],
  );
  assert.doesNotMatch(
    JSON.stringify(inactiveHome),
    /founder-interest|investment-interests/u,
  );
});

test("repository projection reads package acknowledgment only for a registered participant", async () => {
  const alice = account("oidc:alice", "alice@example.test");
  const registeredAt = parseTimestamp("2026-08-09T08:00:00.000Z");
  assert(registeredAt.ok);
  const profile = registerParticipantProfile(
    alice,
    {
      displayName: "Alice Participant",
      country: "FI",
      declaredInterest: "both",
      participationContext: "company",
      processEmailNoticeAcknowledged: true,
      marketingConsent: false,
    },
    registeredAt.value,
  );
  assert(profile.ok);

  const version = await createPackageVersion({
    id: "package-version:repository",
    createdAt: "2026-08-09T09:00:00.000Z",
    changeSummary: "Repository-backed package",
    materialChange: true,
    acknowledgmentText: "I acknowledge the current information package.",
    sections: [],
  });
  assert(version.ok);
  let acknowledgmentReads = 0;

  const state = await readParticipantAuthorizationState({
    participant: {
      current: async () => ({ revision: 1, snapshot: profile.value }),
    },
    packages: {
      current: async () => ({ revision: 1, snapshot: version.value }),
    },
    acknowledgments: {
      requiresCurrentAcceptance: async () => {
        acknowledgmentReads += 1;
        return true;
      },
    },
  });
  assert.equal(state?.profile.subject, alice.subject);
  assert.equal(state?.currentPackage?.requiresCurrentAcceptance, true);
  assert.equal(acknowledgmentReads, 1);

  const missing = await readParticipantAuthorizationState({
    participant: { current: async () => null },
    packages: {
      current: async () => assert.fail("Package state must stay unread."),
    },
    acknowledgments: {
      requiresCurrentAcceptance: async () =>
        assert.fail("Acknowledgment state must stay unread."),
    },
  });
  assert.equal(missing, null);
});

function account(subject: string, email: string) {
  const parsed = parseParticipantAccount({
    subject,
    accountEmailLabel: email,
  });
  assert(parsed.ok);
  return parsed.value;
}

function authorizationState(
  subject: ReturnType<typeof actorSubject>,
): ParticipantAuthorizationState {
  const id = parseStableId<"package-version">("package-version:current");
  const createdAt = parseTimestamp("2026-08-09T09:00:00.000Z");
  assert(id.ok);
  assert(createdAt.ok);

  return {
    profile: {
      subject,
      displayName: "Alice Participant",
      declaredInterest: "both",
      participationContext: "company",
      accountDeletionRequested: false,
    },
    currentPackage: {
      id: id.value,
      createdAt: createdAt.value,
      changeSummary: "Private current package",
      materialChange: true,
      requiresCurrentAcceptance: true,
    },
  };
}

function actorSubject(value: string) {
  const parsed = parseActorSubject(value);
  assert(parsed.ok);
  return parsed.value;
}

function authorizedParticipant(
  declaredInterest: "founder" | "investor" | "both",
) {
  const alice = account("oidc:alice", "alice@example.test");
  const state = authorizationState(alice.subject);
  const participant = authorizeParticipantAccess(
    alice,
    {
      ...state,
      profile: {
        ...state.profile,
        declaredInterest,
      },
    },
  );
  assert.ok(participant);
  return participant;
}
