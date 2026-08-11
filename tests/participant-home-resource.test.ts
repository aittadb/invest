import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeParticipantAccess,
  createParticipantHomeDocument,
  createParticipantRegistrationRequiredDocument,
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
import type { SanitizedPublicInvestmentAggregate } from "../domain/investment-aggregate.ts";
import {
  parseParticipantAccount,
  registerParticipantProfile,
  requestParticipantAccountDeletion,
  type ParticipantProfile,
} from "../domain/participant-profile.ts";
import { createPublicCampaignDocument } from "../domain/public-campaign-resource.ts";
import {
  parseStorageOperationId,
  StorageFailure,
  type StorageAdapter,
  type StorageRecord,
} from "../domain/storage-adapter.ts";
import {
  StorageAcknowledgmentRepository,
  StoragePackageVersionRepository,
} from "../repositories/in-memory-content-repository.ts";
import {
  createRepositoryParticipantAccessStateReader,
  readParticipantAuthorizationState,
} from "../services/participant-access.ts";
import { syntheticPublicCampaign } from "./fixtures/public-campaign.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";
import { testParticipantRegistrationNoticeEvidence } from "./support/participant-registration-notice-evidence.ts";

test("participant authorization binds private state to the exact trusted account", () => {
  const alice = account("oidc:alice", "alice@example.test");
  const authorized = authorizeParticipantAccess(
    alice,
    authorizationState(alice.subject, alice.accountEmailLabel),
  );
  assert.ok(authorized);
  assert.equal(authorized.subject, alice.subject);
  assert.equal(authorized.email, alice.accountEmailLabel);
  assert.equal(authorized.currentPackage?.changeSummary, "Private current package");

  const foreign = authorizeParticipantAccess(
    alice,
    authorizationState(actorSubject("oidc:bob"), "bob@example.test"),
  );
  assert.equal(foreign, null);
  const changedProviderEmail = account(
    "oidc:alice",
    "alice.changed@example.test",
  );
  assert.equal(
    authorizeParticipantAccess(
      changedProviderEmail,
      authorizationState(alice.subject, alice.accountEmailLabel),
    ),
    null,
  );
  assert.equal(authorizeParticipantAccess(alice, null), null);

  const malformed = {
    ...authorizationState(alice.subject, alice.accountEmailLabel),
    currentPackage: {
      ...authorizationState(alice.subject, alice.accountEmailLabel)
        .currentPackage,
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
    authorizationState(alice.subject, alice.accountEmailLabel),
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
    authorizationState(alice.subject, alice.accountEmailLabel),
  );
  assert.ok(participant);

  const visitor = createPublicCampaignDocument(
    "https://campaign.example/",
    syntheticPublicCampaign,
    {
      publicAggregate: {
        amount: 12_500,
        currency: "EUR",
        label: "Indicated interest",
        qualifier: "Current self-declared interest.",
        oversubscription: null,
      } as SanitizedPublicInvestmentAggregate,
    },
  );
  assert.deepEqual(visitor.data.aggregate_interest, {
    amount_minor_units: 12_500,
    currency: "EUR",
    label: "Indicated interest",
    qualifier: "Current self-declared interest.",
    verification: {
      self_declared: true,
      verified: false,
      binding: false,
    },
    oversubscription: null,
  });
  assert.doesNotMatch(
    JSON.stringify(visitor.data.aggregate_interest),
    /participant|company|note|count|moderation|backend/iu,
  );
  assert.equal(
    new URL(visitor.actions[0]?.href ?? "https://campaign.example/")
      .searchParams.get("return_to"),
    "/participant",
  );
  assert.ok(visitor.actions.every((action) =>
    new URL(action.href).searchParams.get("return_to") === "/participant"
  ));
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
    [
      "open-participant-home",
      "open-founder-interest",
      "open-investment-interests",
      "sign-out",
    ],
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
    ["sign-out"],
  );
  assert.equal(inactiveHome.data.current_package, null);
  assert.doesNotMatch(
    JSON.stringify(inactiveHome),
    /founder-interest|investment-interests/u,
  );
});

test("participant entry and profile capabilities reflect registration state", () => {
  const entry = createParticipantRegistrationRequiredDocument(
    "https://campaign.example/participant",
  );
  assert.equal(entry.type, "participant-entry");
  assert.equal(entry.data.status, "registration_required");
  assert.deepEqual(entry.actions.map(({ name }) => name), [
    "open-participant-registration",
  ]);
  assert.equal(
    entry.actions[0]?.href,
    "https://campaign.example/participant/registration",
  );
  assert.ok(
    entry.links.some(({ rel }) => rel.includes("participant-registration")),
  );

  const active = createParticipantHomeDocument(
    "https://campaign.example/participant",
    authorizedParticipant("both"),
    syntheticPublicCampaign.name,
    { profileSelfService: true },
  );
  assert.deepEqual(active.actions.map(({ name }) => name), [
    "read-private-package",
    "open-participant-profile",
    "sign-out",
  ]);
  assert.equal(
    active.actions.find(({ name }) => name === "open-participant-profile")
      ?.title,
    "Manage profile",
  );
  assert.ok(
    active.links.some(({ rel }) => rel.includes("participant-profile")),
  );

  const deletionRequested = createParticipantHomeDocument(
    "https://campaign.example/participant",
    {
      ...authorizedParticipant("both"),
      accountStatus: "deletion-requested",
    },
    syntheticPublicCampaign.name,
    {
      profileSelfService: true,
      founderInterest: true,
      investmentInterests: true,
    },
  );
  assert.deepEqual(deletionRequested.actions.map(({ name }) => name), [
    "open-participant-profile",
    "sign-out",
  ]);
  assert.equal(deletionRequested.data.current_package, null);
  assert.equal(
    deletionRequested.actions.find(
      ({ name }) => name === "open-participant-profile"
    )?.title,
    "View profile",
  );
  assert.doesNotMatch(
    JSON.stringify(deletionRequested),
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
      currentAcceptanceStatus: async () => {
        acknowledgmentReads += 1;
        return acceptanceStatus(version, 1, true);
      },
    },
  });
  assert.equal(state?.profile.subject, alice.subject);
  assert.equal(state?.profile.accountEmailLabel, alice.accountEmailLabel);
  assert.equal(state?.currentPackage?.requiresCurrentAcceptance, true);
  assert.equal(profileReads, 2);
  assert.equal(packageReads, 2);
  assert.equal(acknowledgmentReads, 1);
});

test("repository projection detaches and validates closed acceptance evidence", async () => {
  const alice = account("oidc:alice", "alice@example.test");
  const profile = registeredProfile(alice);
  const version = await packageVersion("acceptance-evidence", "Stable package");
  const sharedStatus = { ...acceptanceStatus(version, 1, true) };
  let packageReads = 0;
  const state = await readParticipantAuthorizationState({
    participant: {
      current: async () => ({ revision: 1, snapshot: profile }),
    },
    packages: {
      current: async () => {
        packageReads += 1;
        if (packageReads === 2) sharedStatus.requiresCurrentAcceptance = false;
        return { revision: 1, snapshot: version };
      },
    },
    acknowledgments: {
      currentAcceptanceStatus: async () => sharedStatus,
    },
  });
  assert.equal(state?.currentPackage?.requiresCurrentAcceptance, true);

  let accessorCalls = 0;
  const accessorStatus = { ...acceptanceStatus(version, 1, true) };
  Object.defineProperty(accessorStatus, "contentHash", {
    configurable: true,
    enumerable: true,
    get() {
      accessorCalls += 1;
      return version.contentHash;
    },
  });
  const malformed = [
    { ...acceptanceStatus(version, 1, true), bindingRevision: 0 },
    { ...acceptanceStatus(version, 1, true), versionId: " package:private " },
    { ...acceptanceStatus(version, 1, true), contentHash: "sha256:private" },
    {
      ...acceptanceStatus(version, 1, true),
      requiredAcceptanceHash: `sha256:${"A".repeat(64)}`,
    },
    {
      ...acceptanceStatus(version, 1, true),
      requiresCurrentAcceptance: "false",
    },
    { ...acceptanceStatus(version, 1, true), extra: "private" },
    accessorStatus,
  ];
  for (const candidate of malformed) {
    await assert.rejects(
      readParticipantAuthorizationState({
        participant: {
          current: async () => ({ revision: 1, snapshot: profile }),
        },
        packages: {
          current: async () => ({ revision: 1, snapshot: version }),
        },
        acknowledgments: {
          currentAcceptanceStatus: async () => candidate as never,
        },
      }),
      unavailableFailure,
    );
  }
  assert.equal(accessorCalls, 0);
});

test("repository access reader reconstructs state through fresh storage-backed readers", async () => {
  const alice = account("oidc:alice", "alice@example.test");
  const profile = registeredProfile(alice);
  const storageState = new MemoryStorageState();
  const operation = parseStorageOperationId("operation:participant-access-package");
  assert(operation.ok);
  const ownerPackages = new StoragePackageVersionRepository(
    new MemoryStorageAdapter(storageState),
  );
  await ownerPackages.append({
    operationId: operation.value,
    expectedRevision: null,
    draft: packageDraft(
      "package-version:stored-reader",
      "Storage-backed package",
    ),
  });

  const createReader = () => createRepositoryParticipantAccessStateReader(() => {
    const storage = new MemoryStorageAdapter(storageState);
    const packages = new StoragePackageVersionRepository(storage);
    return {
      participant: {
        current: async () => ({ revision: 1, snapshot: profile }),
      },
      packages,
      acknowledgments: new StorageAcknowledgmentRepository(
        storage,
        packages,
        alice.subject,
      ),
    };
  });

  const first = await createReader().read(alice);
  const reconstructed = await createReader().read(alice);
  assert.deepEqual(reconstructed, first);
  assert.notEqual(reconstructed, first);
  assert.equal(first?.currentPackage?.id, "package-version:stored-reader");
  assert.equal(first?.currentPackage?.requiresCurrentAcceptance, true);
});

test("repository access reader sanitizes resolver failures without retaining a cause", async () => {
  const alice = account("oidc:alice", "alice@example.test");
  const privateDetail = "private-resolver-token-value";
  const reader = createRepositoryParticipantAccessStateReader(async () => {
    throw new Error(privateDetail);
  });

  await assertUnavailableMasks(reader.read(alice), privateDetail);
});

test("repository projection retries a participant change and returns deletion-requested state", async () => {
  const alice = account("oidc:alice", "alice@example.test");
  const initial = registeredProfile(alice);
  const requestedAt = parseTimestamp("2026-08-09T10:00:00.000Z");
  assert(requestedAt.ok);
  const deleted = requestParticipantAccountDeletion(initial, requestedAt.value);
  const version = await packageVersion("profile-race", "Stable package");
  const sharedSnapshot = mutableParticipantProfile(initial);
  const sharedSample = { revision: 1, snapshot: sharedSnapshot };
  let profileRead = 0;
  let packageRead = 0;
  let acknowledgmentReads = 0;

  const state = await readParticipantAuthorizationState({
    participant: {
      current: async () => {
        profileRead += 1;
        return sharedSample;
      },
    },
    packages: {
      current: async () => {
        packageRead += 1;
        if (packageRead === 1) {
          sharedSample.revision = 2;
          Object.assign(
            sharedSnapshot,
            mutableParticipantProfile(deleted.profile),
          );
        }
        return { revision: 1, snapshot: version };
      },
    },
    acknowledgments: {
      currentAcceptanceStatus: async () => {
        acknowledgmentReads += 1;
        return acceptanceStatus(version, 1, false);
      },
    },
  });

  assert.equal(state?.profile.accountDeletionRequested, true);
  assert.equal(profileRead, 4);
  assert.equal(packageRead, 4);
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
      currentAcceptanceStatus: async () => {
        const requiresCurrentAcceptance = acceptance[acknowledgmentRead++];
        if (requiresCurrentAcceptance === undefined) {
          return assert.fail("Unexpected acknowledgment read");
        }
        return acceptanceStatus(
          acknowledgmentRead === 1 ? first : second,
          acknowledgmentRead,
          requiresCurrentAcceptance,
        );
      },
    },
  });

  assert.equal(state?.currentPackage?.id, second.id);
  assert.equal(state?.currentPackage?.changeSummary, "Second package");
  assert.equal(state?.currentPackage?.requiresCurrentAcceptance, true);
  assert.equal(packageRead, 4);
  assert.equal(acknowledgmentRead, 2);
});

test("repository projection rejects a stable package head with a stale accepted gate", async () => {
  const alice = account("oidc:alice", "alice@example.test");
  const profile = registeredProfile(alice);
  const storageState = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(storageState);
  const packages = new StoragePackageVersionRepository(storage);
  const acknowledgments = new StorageAcknowledgmentRepository(
    storage,
    packages,
    alice.subject,
  );
  const firstOperation = parseStorageOperationId("operation:stale-gate-v1");
  const acceptanceOperation = parseStorageOperationId(
    "operation:stale-gate-accept-v1",
  );
  const secondOperation = parseStorageOperationId("operation:stale-gate-v2");
  const acceptanceId = parseStableId<"package-acceptance">(
    "acceptance:stale-gate-v1",
  );
  const acceptedAt = parseTimestamp("2026-08-09T09:05:00.000Z");
  assert(firstOperation.ok);
  assert(acceptanceOperation.ok);
  assert(secondOperation.ok);
  assert(acceptanceId.ok);
  assert(acceptedAt.ok);

  const first = await packages.append({
    operationId: firstOperation.value,
    expectedRevision: null,
    draft: packageDraft("package-version:stale-gate-v1", "First package"),
  });
  await acknowledgments.record({
    operationId: acceptanceOperation.value,
    expectedRevision: null,
    id: acceptanceId.value,
    acceptedAt: acceptedAt.value,
    acceptedVersionId: first.snapshot.id,
  });
  const staleGate = [...storageState.records.values()].find((record) =>
    record.key.collection === "private-package-acceptance-bindings"
  );
  assert(staleGate);
  await packages.append({
    operationId: secondOperation.value,
    expectedRevision: first.revision,
    draft: packageDraft("package-version:stale-gate-v2", "Second package"),
  });

  const corruptedStorage = storageWithGate(storage, staleGate);
  const corruptedPackages = new StoragePackageVersionRepository(
    corruptedStorage,
  );
  const corruptedAcknowledgments = new StorageAcknowledgmentRepository(
    corruptedStorage,
    corruptedPackages,
    alice.subject,
  );
  await assert.rejects(
    readParticipantAuthorizationState({
      participant: {
        current: async () => ({ revision: 1, snapshot: profile }),
      },
      packages: corruptedPackages,
      acknowledgments: corruptedAcknowledgments,
    }),
    unavailableFailure,
  );
});

test("repository projection detaches a mutable package alias before acceptance changes it", async () => {
  const alice = account("oidc:alice", "alice@example.test");
  const profile = registeredProfile(alice);
  const first = await packageVersion("aliased-v1", "Aliased first package");
  const second = await packageVersion("aliased-v2", "Aliased second package");
  const sharedSnapshot = mutablePackageVersion(first);
  const sharedSample = { revision: 1, snapshot: sharedSnapshot };
  let acknowledgmentRead = 0;

  const state = await readParticipantAuthorizationState({
    participant: {
      current: async () => ({ revision: 1, snapshot: profile }),
    },
    packages: {
      current: async () => sharedSample,
    },
    acknowledgments: {
      currentAcceptanceStatus: async () => {
        acknowledgmentRead += 1;
        if (acknowledgmentRead === 1) {
          sharedSample.revision = 2;
          Object.assign(sharedSnapshot, mutablePackageVersion(second));
          return acceptanceStatus(first, 1, false);
        }
        return acceptanceStatus(second, 2, true);
      },
    },
  });

  assert.equal(acknowledgmentRead, 2);
  assert.equal(state?.currentPackage?.id, second.id);
  assert.equal(state?.currentPackage?.changeSummary, "Aliased second package");
  assert.equal(state?.currentPackage?.requiresCurrentAcceptance, true);
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
        currentAcceptanceStatus: async () =>
          acceptanceStatus(version, packageRead, false),
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
      currentAcceptanceStatus: async () =>
        assert.fail("Acknowledgment state must stay unread."),
    },
  });
  assert.equal(missing, null);
});

test("repository projection rejects malformed participant snapshots before package access", async () => {
  const alice = account("oidc:alice", "alice@example.test");
  const profile = registeredProfile(alice);
  let accessorCalls = 0;
  const accessorProfile = mutableParticipantProfile(profile);
  Object.defineProperty(accessorProfile, "displayName", {
    configurable: true,
    enumerable: true,
    get() {
      accessorCalls += 1;
      return "Accessor participant";
    },
  });
  const customPrototypeProfile = Object.assign(
    Object.create({ inherited: true }) as Record<string, unknown>,
    mutableParticipantProfile(profile),
  );
  const malformed = [
    { revision: 0, snapshot: profile },
    { revision: Number.MAX_SAFE_INTEGER + 1, snapshot: profile },
    {
      revision: 1,
      snapshot: {
        ...mutableParticipantProfile(profile),
        subject: " oidc:alice",
      },
    },
    {
      revision: 1,
      snapshot: {
        ...mutableParticipantProfile(profile),
        accountEmailLabel: "alice@example.test ",
      },
    },
    {
      revision: 1,
      snapshot: { ...mutableParticipantProfile(profile), country: "fin" },
    },
    {
      revision: 1,
      snapshot: {
        ...mutableParticipantProfile(profile),
        processEmailNoticeAcknowledgedAt: "2026-08-09T08:00:01.000Z",
      },
    },
    {
      revision: 1,
      snapshot: {
        ...mutableParticipantProfile(profile),
        updatedAt: "2026-08-09T07:59:59.000Z",
      },
    },
    {
      revision: 1,
      snapshot: {
        ...mutableParticipantProfile(profile),
        marketingConsent: {
          state: "granted",
          grantedAt: "2026-08-09T09:00:00.000Z",
        },
      },
    },
    {
      revision: 1,
      snapshot: {
        ...mutableParticipantProfile(profile),
        accountDeletionRequest: {
          state: "requested",
          requestedAt: "2026-08-09T10:00:00.000Z",
          activeInterestDisposition: "retain",
        },
      },
    },
    { revision: 1, snapshot: accessorProfile },
    { revision: 1, snapshot: customPrototypeProfile },
    {
      revision: 1,
      snapshot: { ...mutableParticipantProfile(profile), extra: "private" },
    },
  ];

  for (const candidate of malformed) {
    await assert.rejects(
      readParticipantAuthorizationState({
        participant: { current: async () => candidate as never },
        packages: {
          current: async () => assert.fail("Package state must stay unread."),
        },
        acknowledgments: {
          currentAcceptanceStatus: async () =>
            assert.fail("Acknowledgment state must stay unread."),
        },
      }),
      unavailableFailure,
    );
  }
  assert.equal(accessorCalls, 0);
});

test("repository projection rejects unbounded or non-data package snapshots", async () => {
  const alice = account("oidc:alice", "alice@example.test");
  const profile = registeredProfile(alice);
  const version = await packageVersion("malformed-package", "Valid package");
  const base = mutablePackageVersion(version);
  let accessorCalls = 0;
  let arrayAccessorCalls = 0;
  const accessorPackage = mutablePackageVersion(version);
  Object.defineProperty(accessorPackage, "changeSummary", {
    configurable: true,
    enumerable: true,
    get() {
      accessorCalls += 1;
      return "Accessor package";
    },
  });
  const sparsePackage = mutablePackageVersion(version);
  sparsePackage.sections = new Array(1);
  const accessorArrayPackage = mutablePackageVersion(version);
  Object.defineProperty(accessorArrayPackage.sections, "0", {
    configurable: true,
    enumerable: true,
    get() {
      arrayAccessorCalls += 1;
      return base.sections[0];
    },
  });
  const oversizedPackage = mutablePackageVersion(version);
  oversizedPackage.sections = Array.from({ length: 65 }, (_, index) => ({
    ...base.sections[0]!,
    id: `package-section:oversized-${index}`,
    order: index,
  })) as never;
  const customPrototypePackage = Object.assign(
    Object.create({ inherited: true }) as Record<string, unknown>,
    mutablePackageVersion(version),
  );
  const customArrayPackage = mutablePackageVersion(version);
  customArrayPackage.sections = Object.setPrototypeOf(
    [...base.sections],
    Object.create(Array.prototype),
  ) as typeof customArrayPackage.sections;
  const malformed = [
    { revision: 0, snapshot: base },
    {
      revision: 1,
      snapshot: { ...mutablePackageVersion(version), contentHash: "private" },
    },
    { revision: 1, snapshot: sparsePackage },
    { revision: 1, snapshot: accessorArrayPackage },
    { revision: 1, snapshot: oversizedPackage },
    { revision: 1, snapshot: accessorPackage },
    { revision: 1, snapshot: customPrototypePackage },
    { revision: 1, snapshot: customArrayPackage },
    {
      revision: 1,
      snapshot: { ...mutablePackageVersion(version), method: () => true },
    },
  ];

  for (const candidate of malformed) {
    await assert.rejects(
      readParticipantAuthorizationState({
        participant: {
          current: async () => ({ revision: 1, snapshot: profile }),
        },
        packages: { current: async () => candidate as never },
        acknowledgments: {
          currentAcceptanceStatus: async () =>
            assert.fail("Acknowledgment state must stay unread."),
        },
      }),
      unavailableFailure,
    );
  }
  assert.equal(accessorCalls, 0);
  assert.equal(arrayAccessorCalls, 0);
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
        currentAcceptanceStatus: async () =>
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
        currentAcceptanceStatus: async () => {
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
        currentAcceptanceStatus: async () => privateDetail as never,
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
        currentAcceptanceStatus: async () =>
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
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.message, new RegExp(privateDetail, "u"));
      assert.doesNotMatch(error.stack ?? "", new RegExp(privateDetail, "u"));
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
    testParticipantRegistrationNoticeEvidence(),
  );
  assert(profile.ok);
  return profile.value;
}

async function packageVersion(suffix: string, changeSummary: string) {
  const version = await createPackageVersion(
    packageDraft(`package-version:${suffix}`, changeSummary),
  );
  assert(version.ok);
  return version.value;
}

function acceptanceStatus(
  version: Awaited<ReturnType<typeof packageVersion>>,
  bindingRevision: number,
  requiresCurrentAcceptance: boolean,
) {
  return Object.freeze({
    bindingRevision,
    versionId: version.id,
    contentHash: version.contentHash,
    requiredAcceptanceHash: version.requiredAcceptanceHash,
    requiresCurrentAcceptance,
  });
}

function storageWithGate(
  delegate: StorageAdapter,
  gate: StorageRecord,
): StorageAdapter {
  return Object.freeze({
    async read(key: Parameters<StorageAdapter["read"]>[0]) {
      return key.collection === "private-package-acceptance-bindings"
        ? gate
        : await delegate.read(key);
    },
    list(request: Parameters<StorageAdapter["list"]>[0]) {
      return delegate.list(request);
    },
    transact(request: Parameters<StorageAdapter["transact"]>[0]) {
      return delegate.transact(request);
    },
  });
}

function packageDraft(id: string, changeSummary: string) {
  return {
    id,
    createdAt: "2026-08-09T09:00:00.000Z",
    changeSummary,
    materialChange: true,
    acknowledgmentText: "I acknowledge the current information package.",
    sections: [
      {
        id: `package-section:${id}`,
        order: 0,
        title: "Company and product",
        markdown: "# Company and product\n\nPrivate package content.",
        enabled: true,
      },
    ],
  };
}

function mutableParticipantProfile(profile: ParticipantProfile) {
  return {
    ...profile,
    marketingConsent: { ...profile.marketingConsent },
    accountDeletionRequest: { ...profile.accountDeletionRequest },
  };
}

function mutablePackageVersion(version: Awaited<ReturnType<typeof packageVersion>>) {
  return {
    ...version,
    sections: version.sections.map((section) => ({ ...section })),
  };
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
  accountEmailLabel = "alice@example.test",
): ParticipantAuthorizationState {
  const profileAccount = parseParticipantAccount({
    subject,
    accountEmailLabel,
  });
  const id = parseStableId<"package-version">("package-version:current");
  const createdAt = parseTimestamp("2026-08-09T09:00:00.000Z");
  assert(profileAccount.ok);
  assert(id.ok);
  assert(createdAt.ok);

  return {
    profile: {
      subject: profileAccount.value.subject,
      accountEmailLabel: profileAccount.value.accountEmailLabel,
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
  const state = authorizationState(alice.subject, alice.accountEmailLabel);
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
