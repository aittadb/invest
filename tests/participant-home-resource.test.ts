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
  requestParticipantAccountDeletion,
  type ParticipantProfile,
} from "../domain/participant-profile.ts";
import { createPublicCampaignDocument } from "../domain/public-campaign-resource.ts";
import { StorageFailure } from "../domain/storage-adapter.ts";
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

test("repository projection returns one stable participant, package, and acceptance state", async () => {
  const alice = account("oidc:alice", "alice@example.test");
  const profile = registeredProfile(alice);
  const version = await packageVersion("repository", "Repository-backed package");
  let profileReads = 0;
  let packageReads = 0;
  let acknowledgmentReads = 0;

  const state = await readParticipantAuthorizationState({
    participant: {
      current: async () => {
        profileReads += 1;
        return { revision: 1, snapshot: profile };
      },
    },
    packages: {
      current: async () => {
        packageReads += 1;
        return { revision: 1, snapshot: version };
      },
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
  assert.equal(profileReads, 2);
  assert.equal(packageReads, 2);
  assert.equal(acknowledgmentReads, 1);
});

test("repository projection retries a participant change and returns deletion-requested state", async () => {
  const alice = account("oidc:alice", "alice@example.test");
  const initial = registeredProfile(alice);
  const requestedAt = parseTimestamp("2026-08-09T10:00:00.000Z");
  assert(requestedAt.ok);
  const deleted = requestParticipantAccountDeletion(initial, requestedAt.value);
  const version = await packageVersion("profile-race", "Stable package");
  const profiles = [
    { revision: 1, snapshot: initial },
    { revision: 1, snapshot: deleted.profile },
    { revision: 2, snapshot: deleted.profile },
    { revision: 2, snapshot: deleted.profile },
  ];
  let profileRead = 0;
  let acknowledgmentReads = 0;

  const state = await readParticipantAuthorizationState({
    participant: {
      current: async () => profiles[profileRead++] ?? assert.fail("Unexpected profile read"),
    },
    packages: {
      current: async () => ({ revision: 1, snapshot: version }),
    },
    acknowledgments: {
      requiresCurrentAcceptance: async () => {
        acknowledgmentReads += 1;
        return false;
      },
    },
  });

  assert.equal(state?.profile.accountDeletionRequested, true);
  assert.equal(profileRead, 4);
  assert.equal(acknowledgmentReads, 2);
});

test("repository projection retries package publication around the acceptance read", async () => {
  const alice = account("oidc:alice", "alice@example.test");
  const profile = registeredProfile(alice);
  const first = await packageVersion("package-race-v1", "First package");
  const second = await packageVersion("package-race-v2", "Second package");
  const packages = [
    { revision: 1, snapshot: first },
    { revision: 1, snapshot: second },
    { revision: 2, snapshot: second },
    { revision: 2, snapshot: second },
  ];
  const acceptance = [false, true];
  let packageRead = 0;
  let acknowledgmentRead = 0;

  const state = await readParticipantAuthorizationState({
    participant: {
      current: async () => ({ revision: 1, snapshot: profile }),
    },
    packages: {
      current: async () => packages[packageRead++] ?? assert.fail("Unexpected package read"),
    },
    acknowledgments: {
      requiresCurrentAcceptance: async () =>
        acceptance[acknowledgmentRead++] ?? assert.fail("Unexpected acknowledgment read"),
    },
  });

  assert.equal(state?.currentPackage?.id, second.id);
  assert.equal(state?.currentPackage?.changeSummary, "Second package");
  assert.equal(state?.currentPackage?.requiresCurrentAcceptance, true);
  assert.equal(packageRead, 4);
  assert.equal(acknowledgmentRead, 2);
});

test("repository projection fails closed when participant or package state keeps changing", async () => {
  const alice = account("oidc:alice", "alice@example.test");
  const profile = registeredProfile(alice);
  const version = await packageVersion("continuing-race", "Changing package");
  let profileRead = 0;
  let packageRead = 0;

  await assert.rejects(
    readParticipantAuthorizationState({
      participant: {
        current: async () => ({
          revision: ++profileRead,
          snapshot: profile,
        }),
      },
      packages: {
        current: async () => ({
          revision: ++packageRead,
          snapshot: version,
        }),
      },
      acknowledgments: {
        requiresCurrentAcceptance: async () => false,
      },
    }),
    unavailableFailure,
  );
  assert.equal(profileRead, 4);
  assert.equal(packageRead, 4);
});

test("missing participant short-circuits package and acknowledgment reads", async () => {

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

test("repository projection masks repository exceptions and private details", async () => {
  const alice = account("oidc:alice", "alice@example.test");
  const profile = registeredProfile(alice);
  const version = await packageVersion("repository-failure", "Private package");
  const privateDetail = "private-participant-key:alice";

  await assertUnavailableMasks(
    readParticipantAuthorizationState({
      participant: {
        current: async () => {
          throw new Error(privateDetail);
        },
      },
      packages: {
        current: async () => assert.fail("Package state must stay unread."),
      },
      acknowledgments: {
        requiresCurrentAcceptance: async () =>
          assert.fail("Acknowledgment state must stay unread."),
      },
    }),
    privateDetail,
  );

  await assertUnavailableMasks(
    readParticipantAuthorizationState({
      participant: {
        current: async () => ({ revision: 1, snapshot: profile }),
      },
      packages: {
        current: async () => ({ revision: 1, snapshot: version }),
      },
      acknowledgments: {
        requiresCurrentAcceptance: async () => {
          throw new Error(privateDetail);
        },
      },
    }),
    privateDetail,
  );

  await assertUnavailableMasks(
    readParticipantAuthorizationState({
      participant: {
        current: async () => ({ revision: 1, snapshot: profile }),
      },
      packages: {
        current: async () => ({ revision: 1, snapshot: version }),
      },
      acknowledgments: {
        requiresCurrentAcceptance: async () =>
          privateDetail as unknown as boolean,
      },
    }),
    privateDetail,
  );

  await assertUnavailableMasks(
    readParticipantAuthorizationState({
      participant: {
        current: async () => ({ revision: 1, snapshot: profile }),
      },
      packages: {
        current: async () => {
          throw new Error(privateDetail);
        },
      },
      acknowledgments: {
        requiresCurrentAcceptance: async () =>
          assert.fail("Acknowledgment state must stay unread."),
      },
    }),
    privateDetail,
  );
});

async function assertUnavailableMasks(
  operation: Promise<unknown>,
  privateDetail: string,
): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) => {
      assert.ok(error instanceof StorageFailure);
      assert.equal(error.code, "UNAVAILABLE");
      assert.equal(error.message, "Storage is temporarily unavailable.");
      assert.doesNotMatch(error.message, new RegExp(privateDetail, "u"));
      return true;
    },
  );
}

function registeredProfile(
  participantAccount: ReturnType<typeof account>,
): ParticipantProfile {
  const registeredAt = parseTimestamp("2026-08-09T08:00:00.000Z");
  assert(registeredAt.ok);
  const profile = registerParticipantProfile(
    participantAccount,
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
  return profile.value;
}

async function packageVersion(suffix: string, changeSummary: string) {
  const version = await createPackageVersion({
    id: `package-version:${suffix}`,
    createdAt: "2026-08-09T09:00:00.000Z",
    changeSummary,
    materialChange: true,
    acknowledgmentText: "I acknowledge the current information package.",
    sections: [],
  });
  assert(version.ok);
  return version.value;
}

function unavailableFailure(error: unknown): boolean {
  assert.ok(error instanceof StorageFailure);
  assert.equal(error.code, "UNAVAILABLE");
  assert.equal(error.message, "Storage is temporarily unavailable.");
  return true;
}

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
