import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AITTADB_HYPERMEDIA_API_VERSION,
  AITTADB_HYPERMEDIA_MEDIA_TYPE,
  defineStorageProtocolDiscovery,
  storageProtocolErrorDocument,
  storageProtocolErrorStatus,
  type StorageProtocolErrorCode,
} from "../domain/aittadb-storage-protocol.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  MUTATION_METHOD_FIELD,
  MutationSecurityFailure,
} from "../http/mutation-security.ts";
import {
  OWNER_PACKAGE_WORKSPACE_HEADER,
  PARTICIPANT_FOUNDER_INTEREST_HEADER,
  PARTICIPANT_PROFILE_SELF_SERVICE_HEADER,
  PARTICIPANT_INVESTMENT_INTERESTS_HEADER,
  hasParticipantProfileSelfService,
} from "../http/runtime-capabilities.ts";
import {
  PARTICIPANT_ACCESS_HEADER,
  participantAccessFromRuntimeHeader,
} from "../http/runtime-participant.ts";
import type { OwnerPackageDocument } from "../domain/owner-package-resource.ts";
import {
  FOUNDER_INTEREST_PATH,
  FOUNDER_SECONDARY_AREAS_FIELD,
  FOUNDER_WITHDRAWAL_REPLAY_ACTION,
  type FounderInterestDocument,
} from "../domain/participant-founder-interest-resource.ts";
import { parseContributionAreaChoices } from "../domain/founder-application.ts";
import {
  PARTICIPANT_REGISTRATION_PATH,
  parseParticipantRegistrationOperationId,
  type ParticipantRegistrationDocument,
} from "../domain/participant-registration-resource.ts";
import {
  PARTICIPANT_PROFILE_PATH,
  type ParticipantProfileDocument,
} from "../domain/participant-profile-resource.ts";
import {
  INVESTMENT_INTEREST_PATH,
  type InvestmentInterestCollectionDocument,
  type InvestmentInterestItemDocument,
} from "../domain/participant-investment-interest-resource.ts";
import { parseParticipantAccount } from "../domain/participant-profile.ts";
import {
  MAX_STABLE_ID_LENGTH,
  parseActorSubject,
  parseStableId,
  parseTimestamp,
  type ActorSubject,
  type StableId,
} from "../domain/foundation.ts";
import {
  StorageFailure,
  parseStorageOperationId,
  type StorageAdapter,
  type StorageRecord,
} from "../domain/storage-adapter.ts";
import { AittaDBStorageAdapter } from "../repositories/aittadb-storage-adapter.ts";
import { StorageCampaignRepository } from "../repositories/in-memory-campaign-repository.ts";
import {
  StorageAcknowledgmentRepository,
  StoragePackageVersionRepository,
} from "../repositories/in-memory-content-repository.ts";
import type { ParticipantRegistrationRepository } from "../repositories/in-memory-participant-repository.ts";
import {
  MAX_INVESTMENT_COLLECTION_STORAGE_READS,
  PARTICIPANT_AUTHORIZATION_STORAGE_READ_LIMIT,
  PARTICIPANT_FOUNDER_ROUTE_STORAGE_READ_LIMIT,
  PARTICIPANT_REQUEST_ROUTE_STORAGE_READ_LIMIT,
  PARTICIPANT_REQUEST_STORAGE_READ_LIMIT,
  StorageApplicationRepositoryFactory,
} from "../repositories/storage-application-repository-factory.ts";
import { StorageParticipantInvestmentInterestRepository } from "../repositories/storage-participant-investment-repository.ts";
import { createApplicationWorker } from "../worker/application-worker.ts";
import { createParticipantInvestmentInterestService } from "../worker/investment-interest-service.ts";
import { MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS } from "../worker/participant-investment-mutation-port.ts";
import type {
  InvestorAppEnv,
  WorkerExecutionContext,
} from "../worker/contracts.ts";
import { createHostedApplicationRuntimeResolver } from "../worker/hosted-application-composition.ts";
import {
  MAX_FOUNDER_INTEREST_MUTATION_BYTES,
  MAX_FOUNDER_INTEREST_MUTATION_FIELDS,
} from "../worker/routes/founder-interest.ts";
import {
  MAX_OWNER_PACKAGE_MUTATION_BYTES,
  MAX_OWNER_PACKAGE_MUTATION_FIELDS,
} from "../worker/routes/owner-package.ts";
import { explicitCampaignSetup } from "./support/campaign-repository-contract.ts";
import { testParticipantRegistrationNoticeEvidence } from "./support/participant-registration-notice-evidence.ts";

const APP_ORIGIN = "https://invest.example.test";
const ISSUER = "https://storage.example.test";
const TRANSPORT_ORIGIN = "https://storage-runtime.example.test";
const ENTRY_HREF = `${ISSUER}/bounded-storage`;
const TRANSACTION_HREF = `${ISSUER}/records/transactions`;
const SERVICE_CLIENT_ID = "investor-app-service";
const SERVICE_CLIENT_SECRET = "application-service-client-secret";
const ACCESS_TOKEN = "synthetic-access-token-that-must-stay-private";
const STORAGE_SCOPES = "storage.read storage.write storage.delete";
const NOW = new Date("2026-08-10T12:00:00.000Z");
const MUTATION_KEY = keyMaterial(17);
const OWNER = Object.freeze({
  type: "owner",
  subject: "sites-owner-subject",
} as const);
const OWNER_EMAIL = "owner@example.test";
const PARTICIPANT_SUBJECT = "sites-participant-subject";
const PARTICIPANT_EMAIL = "participant@example.test";
const PRIVATE_DRAFT_SENTINEL = "PRIVATE DRAFT SENTINEL MUST STAY HIDDEN";
const PRIVATE_POLICY_SENTINEL = "PRIVATE CAMPAIGN POLICY MUST STAY HIDDEN";
const MAX_HOSTED_RECORD_BYTES = 65_536;
const MAX_HOSTED_TRANSACTION_MUTATIONS = 25;
const MAX_HOSTED_TRANSACTION_BYTES = 1_048_576;

const executionContext: WorkerExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

test("hosted runtime composes once and closes credentials behind repositories", async () => {
  const service = new SyntheticAittaDBService();
  let randomSeed = 0;
  const resolver = createHostedApplicationRuntimeResolver({
    fetch: service.fetch,
    now: () => NOW,
    randomBytes(length) {
      randomSeed += 1;
      return Uint8Array.from(
        { length },
        (_, index) => (randomSeed * 29 + index) % 256,
      );
    },
  });
  const env = configuredEnvironment();
  const [runtime, concurrent] = await Promise.all([
    resolver(env),
    resolver(env),
  ]);

  assert.ok(runtime);
  assert.equal(concurrent, runtime);
  assert.equal(Object.isFrozen(runtime), true);
  assert.deepEqual(Object.keys(runtime).sort(), [
    "mutationSession",
    "now",
    "publicationReady",
    "repositoryFactory",
  ]);
  assert.equal(runtime.publicationReady, false);
  const serialized = JSON.stringify(runtime);
  for (const secret of [
    SERVICE_CLIENT_SECRET,
    ACCESS_TOKEN,
    MUTATION_KEY,
    SERVICE_CLIENT_ID,
    ISSUER,
    TRANSPORT_ORIGIN,
  ]) {
    assert.equal(serialized.includes(secret), false);
  }

  await assert.rejects(
    runtime.mutationSession.issue(
      new Request("https://forged-request-host.example.test/owner/setup"),
      OWNER,
      "https://forged-request-host.example.test",
    ),
    (error) => error instanceof MutationSecurityFailure &&
      error.code === "REQUEST_REJECTED",
  );

  const proof = await runtime.mutationSession.issue(
    new Request(`${APP_ORIGIN}/owner/setup`),
    OWNER,
    APP_ORIGIN,
  );
  const verified = await runtime.mutationSession.verifyMutation(
    mutationRequest(proof),
    OWNER,
    APP_ORIGIN,
  );
  assert.equal(verified.actor.subject, OWNER.subject);
  assert.equal(verified.method, "POST");
  assert.match(verified.clearCookie, /Max-Age=0/u);

  await assert.rejects(
    runtime.mutationSession.verifyMutation(
      mutationRequest(proof),
      OWNER,
      APP_ORIGIN,
    ),
    (error) => error instanceof MutationSecurityFailure &&
      error.code === "REQUEST_REJECTED" &&
      error.cause === undefined,
  );

  assert.equal(service.tokenRequests, 1);
  assert.equal(service.discoveryRequests, 1);
  assert.equal(service.transactionRequests, 2);
  assert.equal(service.records.size, 1);
  const persisted = JSON.stringify([...service.records.values()]);
  assert.match(persisted, /"schemaVersion":1/u);
  assert.match(persisted, /"expiresAt":"2026-08-10T12:05:00.000Z"/u);
  assert.doesNotMatch(
    persisted,
    /sites-owner|csrf|cookie|credential|synthetic-access|invest\.example/iu,
  );
});

test("runtime resolution is fail-closed and never advertises feature routes", async () => {
  let providerCalls = 0;
  const resolver = createHostedApplicationRuntimeResolver({
    async fetch() {
      providerCalls += 1;
      throw new Error("Provider must remain unreachable.");
    },
  });
  const complete = configuredEnvironment();
  const partial = { ...complete };
  delete partial.AITTADB_STORAGE_CLIENT_SECRET;
  const variants: InvestorAppEnv[] = [
    baseEnvironment(),
    partial,
    configuredEnvironment({
      AITTADB_STORAGE_ENTRY_HREF: "https://foreign.example.test/storage",
    }),
  ];

  for (const env of variants) {
    const routed: boolean[] = [];
    const rendered: Request[] = [];
    const worker = createApplicationWorker({
      fetchApplication: async (request) => {
        rendered.push(request);
        return new Response("application");
      },
      fetchOptimizedImage: async () => new Response("image"),
      resolveApplicationRuntime: resolver,
      dispatchRoute: async (context) => {
        routed.push("applicationRuntime" in context);
        return null;
      },
    });
    const response = await worker.fetch(
      new Request("https://forged-request-host.example.test/owner", {
        headers: {
          "oai-authenticated-user-id": OWNER.subject,
          "oai-authenticated-user-email": "owner@example.test",
        },
      }),
      env,
      executionContext,
    );
    assert.equal(await response.text(), "application");
    assert.deepEqual(routed, [false]);
    assert.equal(rendered.length, 1);
    assert.deepEqual(
      [...rendered[0]!.headers].filter(([, value]) =>
        value === "available"
      ),
      [],
    );
  }
  assert.equal(providerCalls, 0);
});

test("complete runtime stays outside route and rendering capabilities", async () => {
  const resolver = createHostedApplicationRuntimeResolver({
    fetch: new SyntheticAittaDBService().fetch,
  });
  const env = configuredEnvironment();
  let routeHasRuntime = true;
  let renderedEnvironment: unknown;
  const rendered: Request[] = [];
  const worker = createApplicationWorker({
    fetchApplication: async (request, renderEnvironment) => {
      rendered.push(request);
      renderedEnvironment = renderEnvironment;
      return new Response("application");
    },
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: resolver,
    dispatchRoute: async (context) => {
      routeHasRuntime = "applicationRuntime" in context;
      return null;
    },
  });

  await worker.fetch(
    new Request("https://forged-request-host.example.test/"),
    env,
    executionContext,
  );
  const expected = await resolver(env);
  assert.ok(expected);
  assert.equal(routeHasRuntime, false);
  assert.equal(rendered.length, 1);
  assert.deepEqual(Object.keys(renderedEnvironment as object).sort(), [
    "ASSETS",
    "IMAGES",
  ]);
  const renderedHeaders = JSON.stringify([...rendered[0]!.headers]);
  assert.equal(
    [...rendered[0]!.headers].some(([, value]) => value === "available"),
    false,
  );
  for (const secret of [
    SERVICE_CLIENT_SECRET,
    ACCESS_TOKEN,
    MUTATION_KEY,
    SERVICE_CLIENT_ID,
    ISSUER,
    TRANSPORT_ORIGIN,
  ]) {
    assert.equal(renderedHeaders.includes(secret), false);
    assert.equal(JSON.stringify(renderedEnvironment).includes(secret), false);
  }
});

test("complete runtime centrally installs the owner setup route", async () => {
  const resolver = createHostedApplicationRuntimeResolver({
    fetch: new SyntheticAittaDBService().fetch,
  });
  const rendered: Request[] = [];
  const worker = createApplicationWorker({
    fetchApplication: async (request) => {
      rendered.push(request);
      return new Response("application fallback", { status: 418 });
    },
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: resolver,
  });

  const response = await worker.fetch(
    new Request(`${APP_ORIGIN}/owner/setup`, {
      headers: {
        "oai-authenticated-user-id": OWNER.subject,
        "oai-authenticated-user-email": "owner@example.test",
      },
    }),
    configuredEnvironment({ OWNER_EMAIL: "owner@example.test" }),
    executionContext,
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /campaign setup/iu);
  assert.equal(rendered.length, 0);
});

test("complete runtime advertises package capability on owner rendering", async () => {
  const resolver = createHostedApplicationRuntimeResolver({
    fetch: new SyntheticAittaDBService().fetch,
  });
  const rendered: Request[] = [];
  const worker = createApplicationWorker({
    fetchApplication: async (request) => {
      rendered.push(request);
      return new Response("application fallback", { status: 418 });
    },
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: resolver,
  });

  const response = await worker.fetch(
    new Request(`${APP_ORIGIN}/owner`, {
      headers: {
        "oai-authenticated-user-id": OWNER.subject,
        "oai-authenticated-user-email": "owner@example.test",
      },
    }),
    configuredEnvironment({ OWNER_EMAIL: "owner@example.test" }),
    executionContext,
  );
  assert.equal(response.status, 418);
  assert.equal(await response.text(), "application fallback");
  assert.equal(rendered.length, 1);
  assert.equal(
    rendered[0]!.headers.get(OWNER_PACKAGE_WORKSPACE_HEADER),
    "available",
  );
});

test("hosted participant access is subject-bound and excludes the configured owner", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Private participant profile",
    "participant-operation:subject-bound-participant",
  );
  await registerHostedParticipant(
    service,
    OWNER.subject,
    OWNER_EMAIL,
    "Private owner profile",
    "participant-operation:subject-bound-owner",
  );
  const worker = hostedPackageWorker(service);

  const owner = await worker.fetch(
    new Request(`${APP_ORIGIN}/participant`, {
      headers: {
        accept: "application/json",
        "oai-authenticated-user-id": OWNER.subject,
        "oai-authenticated-user-email": OWNER_EMAIL,
      },
    }),
    env,
    executionContext,
  );
  assert.equal(owner.status, 404);
  assert.doesNotMatch(await owner.text(), /Private owner profile/u);

  const foreign = await worker.fetch(
    new Request(`${APP_ORIGIN}/participant`, {
      headers: {
        accept: "application/json",
        "oai-authenticated-user-id": "sites-foreign-participant",
        "oai-authenticated-user-email": "foreign@example.test",
      },
    }),
    env,
    executionContext,
  );
  assert.equal(foreign.status, 404);
  assert.doesNotMatch(
    await foreign.text(),
    /Private participant profile|Private owner profile/u,
  );
});

test("hosted participant access requires the persisted provider email label", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  const displayName = "Exact email participant";
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    displayName,
    "participant-operation:exact-email-binding",
  );
  await appendHostedPackageVersion(service, 1, 0);
  await new StorageCampaignRepository(hostedStorageAdapter(service)).saveSetup({
    operationId: "campaign-operation:exact-email-binding",
    recordedAt: "2026-08-10T09:00:00.000Z",
    expectedRevision: null,
    setup: explicitCampaignSetup(),
  });
  const worker = hostedPackageWorker(service);

  const valid = await worker.fetch(
    participantRequestFor(
      "/participant",
      PARTICIPANT_SUBJECT,
      PARTICIPANT_EMAIL,
    ),
    env,
    executionContext,
  );
  assert.equal(valid.status, 200);
  const validDocument = await valid.json() as HostedParticipantHomeDocument;
  assert.equal(validDocument.data.display_name, displayName);
  assert.equal(validDocument.data.account_email, PARTICIPANT_EMAIL);
  const validPackage = await worker.fetch(
    participantRequestFor(
      "/participant/package",
      PARTICIPANT_SUBJECT,
      PARTICIPANT_EMAIL,
    ),
    env,
    executionContext,
  );
  assert.equal(validPackage.status, 200);
  assert.match(await validPackage.text(), /Private package budget content 1/u);

  const changedEmail = await worker.fetch(
    participantRequestFor(
      "/participant",
      PARTICIPANT_SUBJECT,
      "changed-provider-email@example.test",
    ),
    env,
    executionContext,
  );
  assert.equal(changedEmail.status, 404);
  assert.doesNotMatch(
    await changedEmail.text(),
    /Exact email participant|participant@example\.test/u,
  );
  const changedEmailPackage = await worker.fetch(
    participantRequestFor(
      "/participant/package",
      PARTICIPANT_SUBJECT,
      "changed-provider-email@example.test",
    ),
    env,
    executionContext,
  );
  assert.equal(changedEmailPackage.status, 404);
  assert.doesNotMatch(
    await changedEmailPackage.text(),
    /Exact email participant|participant@example\.test|Private package budget content/u,
  );
});

test("hosted first sign-in requires a published open campaign before registration", async () => {
  const env = configuredEnvironment({ OWNER_EMAIL });
  for (const campaign of [
    { label: "closed", published: true, status: "closed" },
    { label: "unpublished", published: false, status: "open" },
  ] as const) {
    const service = new SyntheticAittaDBService();
    const setup = explicitCampaignSetup();
    await new StorageCampaignRepository(hostedStorageAdapter(service)).saveSetup({
      operationId: `campaign-operation:entry-${campaign.label}`,
      recordedAt: "2026-08-10T09:00:00.000Z",
      expectedRevision: null,
      setup: {
        ...setup,
        publicCampaign: {
          ...setup.publicCampaign,
          published: campaign.published,
          status: campaign.status,
        },
      },
    });
    const worker = hostedPackageWorker(service);

    for (const path of ["/participant", PARTICIPANT_REGISTRATION_PATH]) {
      const response = await worker.fetch(
        participantRequest(path),
        env,
        executionContext,
      );
      assert.equal(response.status, 404, `${campaign.label} ${path}`);
      assert.equal(response.headers.get(MUTATION_CSRF_HEADER), null);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.doesNotMatch(
        await response.text(),
        /participant@example\.test|registration_required|register-participant-access|Required messages concern/u,
      );
    }
  }
});

test("hosted participant projection failures do not become registration capability", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  await new StorageCampaignRepository(hostedStorageAdapter(service)).saveSetup({
    operationId: "campaign-operation:projection-failure",
    recordedAt: "2026-08-10T09:00:00.000Z",
    expectedRevision: null,
    setup: explicitCampaignSetup(),
  });
  const worker = createApplicationWorker({
    fetchApplication: async () => new Response("application fallback", {
      status: 404,
    }),
    fetchOptimizedImage: async () => new Response("image"),
    participantAccessReader: {
      async read() {
        throw new Error("synthetic private participant read failure");
      },
    },
    resolveApplicationRuntime: createHostedApplicationRuntimeResolver({
      fetch: service.fetch,
      now: () => NOW,
    }),
  });

  const response = await worker.fetch(
    participantRequest("/participant"),
    env,
    executionContext,
  );
  assert.equal(response.status, 404);
  assert.equal(response.headers.get(MUTATION_CSRF_HEADER), null);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.doesNotMatch(
    await response.text(),
    /participant@example\.test|registration_required|synthetic private/u,
  );
});

test("hosted participant request scopes isolate alternating and concurrent subjects", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  const participants = [
    {
      subject: "sites-alternating-participant-a",
      email: "alternating-a@example.test",
      displayName: "Alternating participant A",
      operationId: "participant-operation:alternating-a",
    },
    {
      subject: "sites-alternating-participant-b",
      email: "alternating-b@example.test",
      displayName: "Alternating participant B",
      operationId: "participant-operation:alternating-b",
    },
  ] as const;
  for (const participant of participants) {
    await registerHostedParticipant(
      service,
      participant.subject,
      participant.email,
      participant.displayName,
      participant.operationId,
    );
  }
  const worker = hostedPackageWorker(service);

  const assertOwnProfile = async (
    participant: (typeof participants)[number],
  ): Promise<void> => {
    const response = await worker.fetch(
      participantRequestFor(
        "/participant",
        participant.subject,
        participant.email,
      ),
      env,
      executionContext,
    );
    assert.equal(response.status, 200);
    const document = await response.json() as HostedParticipantHomeDocument;
    assert.equal(document.data.display_name, participant.displayName);
    assert.equal(document.data.account_email, participant.email);
    const other = participants.find(
      (candidate) => candidate.subject !== participant.subject,
    );
    assert(other);
    assert.equal(JSON.stringify(document).includes(other.displayName), false);
    assert.equal(JSON.stringify(document).includes(other.email), false);
  };

  for (const participant of [
    participants[0],
    participants[1],
    participants[0],
    participants[1],
  ]) {
    await assertOwnProfile(participant);
  }
  await Promise.all(
    Array.from(
      { length: 12 },
      (_, index) => assertOwnProfile(participants[index % 2]!),
    ),
  );
});

test("participant access reconstructs maximum package history once per request", async () => {
  const service = new SyntheticAittaDBService();
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Package history participant",
    "participant-operation:package-history-budget",
  );
  const current = await appendHostedPackageHistory(service, 32);
  const account = parseParticipantAccount({
    subject: PARTICIPANT_SUBJECT,
    accountEmailLabel: PARTICIPANT_EMAIL,
  });
  assert(account.ok);
  await hostedParticipantRepository(service).update({
    operationId: "participant-operation:package-history-profile-update",
    expectedRevision: 1,
    updatedAt: "2026-08-10T10:30:00.000Z",
    changes: { displayName: "Later package history participant" },
  });
  assert.equal(PARTICIPANT_AUTHORIZATION_STORAGE_READ_LIMIT, 551);

  const unacceptedFactory = new StorageApplicationRepositoryFactory(
    hostedStorageAdapter(service),
    () => NOW,
  );
  const unacceptedRequest = unacceptedFactory.participantRequest(account.value);
  const beforeUnaccepted = service.readRequests;
  const unaccepted = await unacceptedRequest.participantAccessReader().read(
    account.value,
  );
  const unacceptedReads = service.readRequests - beforeUnaccepted;
  assert.equal(unaccepted?.currentPackage?.id, current.snapshot.id);
  assert.equal(unaccepted?.currentPackage?.requiresCurrentAcceptance, true);
  assert.equal(unacceptedReads, 139);
  assert.ok(unacceptedReads <= PARTICIPANT_AUTHORIZATION_STORAGE_READ_LIMIT);

  const subject = parseActorSubject(PARTICIPANT_SUBJECT);
  const operationId = parseStorageOperationId(
    "operation:package-history-acceptance",
  );
  const acceptanceId = parseStableId<"package-acceptance">(
    "acceptance:package-history-budget",
  );
  const acceptedAt = parseTimestamp("2026-08-10T11:30:00.000Z");
  assert(subject.ok);
  assert(operationId.ok);
  assert(acceptanceId.ok);
  assert(acceptedAt.ok);
  const acceptancePackages = hostedPackageRepository(service);
  const acknowledgments = new StorageAcknowledgmentRepository(
    hostedStorageAdapter(service),
    acceptancePackages,
    subject.value,
  );
  await acknowledgments.record({
    operationId: operationId.value,
    expectedRevision: null,
    id: acceptanceId.value,
    acceptedAt: acceptedAt.value,
    acceptedVersionId: current.snapshot.id,
  });

  const acceptedFactory = new StorageApplicationRepositoryFactory(
    hostedStorageAdapter(service),
    () => NOW,
  );
  const acceptedRequest = acceptedFactory.participantRequest(account.value);
  const beforeAccepted = service.readRequests;
  const accepted = await acceptedRequest.participantAccessReader().read(
    account.value,
  );
  const acceptedReads = service.readRequests - beforeAccepted;
  assert.equal(accepted?.currentPackage?.requiresCurrentAcceptance, false);
  assert.equal(acceptedReads, 140);
  assert.ok(acceptedReads <= PARTICIPANT_AUTHORIZATION_STORAGE_READ_LIMIT);
});

test("participant access keeps nested package retry reads inside one budget", async () => {
  const service = new SyntheticAittaDBService();
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Package race participant",
    "participant-operation:package-race-budget",
  );
  await appendHostedPackageHistory(service, 8);
  const account = parseParticipantAccount({
    subject: PARTICIPANT_SUBJECT,
    accountEmailLabel: PARTICIPANT_EMAIL,
  });
  assert(account.ok);
  const baseStorage = hostedStorageAdapter(service);
  let delegatedReads = 0;
  let publishedDuringGateRead = false;
  const racingStorage: StorageAdapter = Object.freeze({
    async read(key: Parameters<StorageAdapter["read"]>[0]) {
      delegatedReads += 1;
      const result = await baseStorage.read(key);
      if (
        !publishedDuringGateRead &&
        key.collection === "private-package-acceptance-bindings"
      ) {
        publishedDuringGateRead = true;
        await appendHostedPackageVersion(service, 9, 8);
      }
      return result;
    },
    list: (request: Parameters<StorageAdapter["list"]>[0]) =>
      baseStorage.list(request),
    transact: (request: Parameters<StorageAdapter["transact"]>[0]) =>
      baseStorage.transact(request),
  });
  const factory = new StorageApplicationRepositoryFactory(
    racingStorage,
    () => NOW,
  );
  const participantRequest = factory.participantRequest(account.value);

  const state = await participantRequest.participantAccessReader().read(
    account.value,
  );
  assert.equal(publishedDuringGateRead, true);
  assert.equal(state?.currentPackage?.id, "package:budget-v9");
  assert.ok(delegatedReads < 100, `unexpected reads: ${delegatedReads}`);
  assert.ok(delegatedReads <= PARTICIPANT_REQUEST_STORAGE_READ_LIMIT);
});

test("participant request scope enforces exact maximum route and retry read budgets", async () => {
  assert.equal(PARTICIPANT_AUTHORIZATION_STORAGE_READ_LIMIT, 551);
  assert.equal(PARTICIPANT_FOUNDER_ROUTE_STORAGE_READ_LIMIT, 1_063);
  assert.equal(PARTICIPANT_REQUEST_ROUTE_STORAGE_READ_LIMIT, 1_063);
  assert.equal(PARTICIPANT_REQUEST_STORAGE_READ_LIMIT, 1_614);
  assert.equal(MAX_INVESTMENT_COLLECTION_STORAGE_READS, 512);

  const service = new SyntheticAittaDBService();
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Maximum request participant",
    "participant-operation:maximum-request-budget",
  );
  const current = await appendHostedMaximumReadPackage(service);
  const account = parseParticipantAccount({
    subject: PARTICIPANT_SUBJECT,
    accountEmailLabel: PARTICIPANT_EMAIL,
  });
  const subject = parseActorSubject(PARTICIPANT_SUBJECT);
  const founderApplicationId = parseStableId<"founder-application">(
    "founder-application:self",
  );
  assert(account.ok);
  assert(subject.ok);
  assert(founderApplicationId.ok);

  let routeOnlyReads = 0;
  const routeOnlyStorage: StorageAdapter = Object.freeze({
    async read() {
      routeOnlyReads += 1;
      return null;
    },
    async list() {
      throw new StorageFailure("UNAVAILABLE");
    },
    async transact() {
      throw new StorageFailure("UNAVAILABLE");
    },
  });
  const packageOnlyRequest = new StorageApplicationRepositoryFactory(
    routeOnlyStorage,
    () => NOW,
  ).participantRequest(account.value);
  assert.equal(
    await packageOnlyRequest.participantPackageReader(subject.value).current(),
    null,
  );
  await assert.rejects(
    packageOnlyRequest.participantPackageReader(subject.value).current(),
    (error) => error instanceof StorageFailure && error.code === "UNAVAILABLE",
  );
  assert.equal(routeOnlyReads, 1);

  routeOnlyReads = 0;
  const founderChoices = parseContributionAreaChoices([
    { id: "area:engineering", label: "Engineering" },
  ]);
  assert(founderChoices.ok);
  const founderOnlyRequest = new StorageApplicationRepositoryFactory(
    routeOnlyStorage,
    () => NOW,
  ).participantRequest(account.value);
  const founderOnly = founderOnlyRequest.participantFounderApplications()
    .applications(founderChoices.value);
  for (
    let index = 0;
    index < PARTICIPANT_FOUNDER_ROUTE_STORAGE_READ_LIMIT;
    index += 1
  ) {
    assert.equal(await founderOnly.get(founderApplicationId.value), null);
  }
  await assert.rejects(
    founderOnly.get(founderApplicationId.value),
    (error) => error instanceof StorageFailure && error.code === "UNAVAILABLE",
  );
  assert.equal(routeOnlyReads, PARTICIPANT_FOUNDER_ROUTE_STORAGE_READ_LIMIT);
  await recordHostedAcceptance(
    service,
    subject.value,
    current.snapshot.id,
    "acceptance:maximum-request-budget",
    "operation:maximum-request-budget-acceptance",
  );

  const packageReads = observeStorageReads(hostedStorageAdapter(service));
  const packageRequest = new StorageApplicationRepositoryFactory(
    packageReads.storage,
    () => NOW,
  ).participantRequest(account.value);
  const packageAccess = await packageRequest.participantAccessReader().read(
    account.value,
  );
  assert.equal(packageAccess?.currentPackage?.id, current.snapshot.id);
  assert.equal(packageReads.count(), 521);
  assert.equal(
    (await packageRequest.participantPackageReader(subject.value).current())
      ?.snapshot.id,
    current.snapshot.id,
  );
  assert.equal(packageReads.count(), 522);

  const acknowledgmentReads = observeStorageReads(hostedStorageAdapter(service));
  const acknowledgmentRequest = new StorageApplicationRepositoryFactory(
    acknowledgmentReads.storage,
    () => NOW,
  ).participantRequest(account.value);
  await acknowledgmentRequest.participantAccessReader().read(account.value);
  const acknowledgmentRepositories =
    acknowledgmentRequest.participantPackageAcknowledgments(subject.value);
  await acknowledgmentRepositories.packages.current();
  await acknowledgmentRepositories.acknowledgments.latest();
  await acknowledgmentRepositories.packages.current();
  assert.equal(acknowledgmentReads.count(), 525);

  const env = configuredEnvironment({ OWNER_EMAIL });
  const worker = hostedPackageWorker(service);
  const packageReadsBefore = service.readRequests;
  const packageResponse = await worker.fetch(
    participantRequest("/participant/package?limit=1"),
    env,
    executionContext,
  );
  assert.equal(packageResponse.status, 200);
  assert.equal(service.readRequests - packageReadsBefore, 523);
  const acknowledgmentReadsBefore = service.readRequests;
  const acknowledgmentResponse = await participantAcknowledgment(worker, env);
  assert.equal(acknowledgmentResponse.document.data.status, "satisfied");
  assert.equal(service.readRequests - acknowledgmentReadsBefore, 526);

  const gateOffsets = [0, 1, 1, 2, 2, 2] as const;
  let gateReadIndex = 0;
  const gateReads = observeStorageReads(
    hostedStorageAdapter(service),
    (key, record) => {
      if (key.collection !== "private-package-acceptance-bindings") {
        return record;
      }
      const offset = gateOffsets[gateReadIndex];
      assert.notEqual(offset, undefined);
      gateReadIndex += 1;
      return revisedStorageRecord(record, offset);
    },
  );
  const gateRequest = new StorageApplicationRepositoryFactory(
    gateReads.storage,
    () => NOW,
  ).participantRequest(account.value);
  const gateState = await gateRequest.participantAccessReader().read(
    account.value,
  );
  assert.equal(gateState?.currentPackage?.id, current.snapshot.id);
  assert.equal(gateReadIndex, 6);
  assert.equal(gateReads.count(), 529);

  let profileUpdated = false;
  const profileReads = observeStorageReads(
    hostedStorageAdapter(service),
    async (key, record) => {
      if (
        !profileUpdated &&
        key.collection === "private-package-version-heads"
      ) {
        profileUpdated = true;
        await hostedParticipantRepository(service).update({
          operationId: "participant-operation:maximum-outer-retry",
          expectedRevision: 1,
          updatedAt: "2026-08-10T11:35:00.000Z",
          changes: { displayName: "Maximum request participant updated" },
        });
      }
      return record;
    },
  );
  const profileRequest = new StorageApplicationRepositoryFactory(
    profileReads.storage,
    () => NOW,
  ).participantRequest(account.value);
  const profileState = await profileRequest.participantAccessReader().read(
    account.value,
  );
  assert.equal(profileUpdated, true);
  assert.equal(
    profileState?.profile.displayName,
    "Maximum request participant updated",
  );
  assert.equal(profileReads.count(), 534);

  const combinedGateOffsets = [
    0,
    1,
    1,
    2,
    2,
    2,
    2,
    3,
    3,
    4,
    4,
    4,
  ] as const;
  let combinedGateReadIndex = 0;
  let combinedProfileUpdated = false;
  const combinedReads = observeStorageReads(
    hostedStorageAdapter(service),
    async (key, record) => {
      if (
        !combinedProfileUpdated &&
        key.collection === "private-package-version-heads"
      ) {
        combinedProfileUpdated = true;
        await hostedParticipantRepository(service).update({
          operationId: "participant-operation:maximum-combined-retry",
          expectedRevision: 2,
          updatedAt: "2026-08-10T11:40:00.000Z",
          changes: { displayName: "Maximum combined retry participant" },
        });
      }
      if (key.collection !== "private-package-acceptance-bindings") {
        return record;
      }
      const offset = combinedGateOffsets[combinedGateReadIndex];
      assert.notEqual(offset, undefined);
      combinedGateReadIndex += 1;
      return revisedStorageRecord(record, offset);
    },
  );
  const combinedRequest = new StorageApplicationRepositoryFactory(
    combinedReads.storage,
    () => NOW,
  ).participantRequest(account.value);
  const combinedState = await combinedRequest.participantAccessReader().read(
    account.value,
  );
  assert.equal(combinedProfileUpdated, true);
  assert.equal(combinedGateReadIndex, 12);
  assert.equal(combinedState?.currentPackage?.id, current.snapshot.id);
  assert.equal(combinedReads.count(), 551);

  const scopedProfile = await combinedRequest.participantProfileRepository()
    .current();
  assert.equal(
    scopedProfile?.snapshot.displayName,
    "Maximum combined retry participant",
  );
  assert.equal(combinedReads.count(), 554);
  assert.throws(
    () => combinedRequest.participantPackageAcknowledgments(subject.value),
    (error) => error instanceof StorageFailure && error.code === "UNAVAILABLE",
  );
  assert.equal(combinedReads.count(), 554);
});

test("request-scoped cache rejects over-limit hosted ancestry like a fresh reader", async () => {
  const childService = new SyntheticAittaDBService();
  const parentService = new SyntheticAittaDBService();
  await appendHostedNamedPackageHistory(
    childService,
    "cache-child",
    31,
    "2026-08-10T09:00:00.000Z",
  );
  await appendHostedNamedPackageHistory(
    parentService,
    "cache-parent",
    10,
    "2026-08-10T08:00:00.000Z",
  );

  const immutableCollections = new Set([
    "private-package-versions",
    "private-package-operation-intents",
    "private-package-version-sections",
    "private-package-section-chunks",
  ]);
  for (const [key, record] of parentService.records) {
    if (immutableCollections.has(record.key.collection)) {
      childService.records.set(key, record);
    }
  }
  let manifestUpdated = false;
  let intentUpdated = false;
  for (const [key, record] of childService.records) {
    if (
      record.key.collection === "private-package-versions" &&
      record.value.id === "package:cache-child-v1"
    ) {
      childService.records.set(key, Object.freeze({
        ...record,
        value: Object.freeze({
          ...record.value,
          previousVersionId: "package:cache-parent-v10",
          acceptanceBindingExpectedRevision: 10,
        }),
      }));
      manifestUpdated = true;
    }
    if (
      record.key.collection === "private-package-operation-intents" &&
      record.value.packageVersionId === "package:cache-child-v1"
    ) {
      childService.records.set(key, Object.freeze({
        ...record,
        value: Object.freeze({
          ...record.value,
          expectedOwnerRevision: 10,
          previousVersionId: "package:cache-parent-v10",
          acceptanceBindingExpectedRevision: 10,
        }),
      }));
      intentUpdated = true;
    }
  }
  assert.equal(manifestUpdated, true);
  assert.equal(intentUpdated, true);

  const childStorage = hostedStorageAdapter(childService);
  const parentStorage = hostedStorageAdapter(parentService);
  let delegatedReads = 0;
  let headReads = 0;
  const switchingStorage: StorageAdapter = Object.freeze({
    async read(key: Parameters<StorageAdapter["read"]>[0]) {
      delegatedReads += 1;
      if (
        key.collection === "private-package-version-heads" &&
        ++headReads === 1
      ) {
        return await parentStorage.read(key);
      }
      return await childStorage.read(key);
    },
    list: (request: Parameters<StorageAdapter["list"]>[0]) =>
      childStorage.list(request),
    transact: (request: Parameters<StorageAdapter["transact"]>[0]) =>
      childStorage.transact(request),
  });
  const cached = StoragePackageVersionRepository.requestScopedReader(
    switchingStorage,
  );
  assert.equal(
    (await cached.current())?.snapshot.id,
    "package:cache-parent-v10",
  );
  await assert.rejects(
    cached.current(),
    (error) => error instanceof StorageFailure && error.code === "UNAVAILABLE",
  );
  assert.equal(delegatedReads, 73);

  const freshReads = observeStorageReads(childStorage);
  await assert.rejects(
    new StoragePackageVersionRepository(freshReads.storage).current(),
    (error) => error instanceof StorageFailure && error.code === "UNAVAILABLE",
  );
  assert.equal(freshReads.count(), 33);
});

test("hosted participant home discovers founder access without reading application state", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  await configureHostedFounderCampaign(service);
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Founder participant",
    "participant-operation:founder-discovery",
    { declaredInterest: "founder" },
  );

  const privateNote = "PRIVATE FOUNDER DISCOVERY STATE";
  const seedWorker = hostedPackageWorker(service);
  const seedProof = await founderResource(seedWorker, env);
  const seedAction = requiredAction(
    seedProof.document,
    "create-founder-application",
  );
  assert.equal(
    (await submitFounderMutation(
      seedWorker,
      env,
      seedProof,
      "POST",
      actionBody(seedAction, founderFields({ note: privateNote })),
    )).status,
    201,
  );

  const readsBefore = service.readCollections.length;
  const worker = hostedPackageWorker(service);
  const response = await worker.fetch(
    participantRequest("/participant"),
    env,
    executionContext,
  );
  assert.equal(response.status, 200);
  const document = await response.json() as Readonly<{
    links: readonly Readonly<{ rel: readonly string[]; href: string }>[];
  }>;
  assert.doesNotMatch(JSON.stringify(document), new RegExp(privateNote, "u"));
  assert.ok(document.links.some((link) =>
    link.rel.includes("founder-interest") &&
    link.href === `${APP_ORIGIN}${FOUNDER_INTEREST_PATH}`
  ));
  assert.deepEqual(
    service.readCollections.slice(readsBefore).filter((collection) =>
      collection.startsWith("founder-application")
    ),
    [],
  );

  const rendered: Request[] = [];
  const htmlWorker = createApplicationWorker({
    fetchApplication: async (request) => {
      rendered.push(request);
      return new Response("participant application");
    },
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: createHostedApplicationRuntimeResolver({
      fetch: service.fetch,
      now: () => NOW,
    }),
  });
  const htmlHome = await htmlWorker.fetch(
    new Request(`${APP_ORIGIN}/participant`, {
      headers: {
        accept: "text/html",
        "oai-authenticated-user-id": PARTICIPANT_SUBJECT,
        "oai-authenticated-user-email": PARTICIPANT_EMAIL,
      },
    }),
    env,
    executionContext,
  );
  assert.equal(htmlHome.status, 200);
  assert.equal(
    rendered[0]?.headers.get(PARTICIPANT_FOUNDER_INTEREST_HEADER),
    "available",
  );

  for (const accept of ["application/json", "text/html"]) {
    const anonymous = await hostedPackageWorker(service).fetch(
      new Request(`${APP_ORIGIN}${FOUNDER_INTEREST_PATH}`, {
        headers: { accept },
      }),
      env,
      executionContext,
    );
    assert.equal(anonymous.status, 401);
  }
  const unsupported = await hostedPackageWorker(service).fetch(
    new Request(`${APP_ORIGIN}${FOUNDER_INTEREST_PATH}`, {
      headers: {
        accept: "application/vnd.aittadb-invest+json; version=99.0",
      },
    }),
    env,
    executionContext,
  );
  assert.equal(unsupported.status, 406);
  const unauthorized = await hostedPackageWorker(service).fetch(
    new Request(`${APP_ORIGIN}${FOUNDER_INTEREST_PATH}`, {
      headers: {
        accept: "application/json",
        "oai-authenticated-user-id": "sites-unregistered-founder",
        "oai-authenticated-user-email": "unregistered@example.test",
      },
    }),
    env,
    executionContext,
  );
  assert.equal(unauthorized.status, 404);
});

test("hosted founder applications persist their complete lifecycle across workers", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  await configureHostedFounderCampaign(service);
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Founder participant",
    "participant-operation:hosted-founder-participant",
    { declaredInterest: "both" },
  );
  const worker = hostedPackageWorker(service);

  const initial = await founderResource(worker, env);
  assert.equal(initial.document.data.status, "not_submitted");
  const createAction = requiredAction(
    initial.document,
    "create-founder-application",
  );
  assert.deepEqual(
    createAction.fields.find(({ name }) =>
      name === "primary-contribution-area-id"
    )?.choices,
    [
      { value: "area:engineering", title: "Engineering" },
      { value: "area:product", title: "Product" },
    ],
  );
  const createBody = actionBody(createAction, founderFields({
    note: "Private hosted founder note.",
    [FOUNDER_SECONDARY_AREAS_FIELD]: ["area:product"],
  }));
  const createdResponse = await submitFounderMutation(
    worker,
    env,
    initial,
    "POST",
    createBody,
  );
  assert.equal(createdResponse.status, 201);
  assert.match(createdResponse.headers.get("set-cookie") ?? "", /Max-Age=0/u);
  const created = await createdResponse.json() as FounderInterestDocument;
  assert.equal(created.data.status, "received");
  assert.equal(created.data.revision, 1);
  assert.equal(created.data.history.length, 1);
  assert.deepEqual(
    created.data.fields?.secondary_contribution_area_ids,
    ["area:product"],
  );

  const replayProof = await founderResource(worker, env);
  const replay = await submitFounderMutation(
    worker,
    env,
    replayProof,
    "POST",
    createBody,
  );
  assert.equal(replay.status, 200);
  assert.equal(
    (await replay.json() as FounderInterestDocument).data.history.length,
    1,
  );

  const editResource = await founderResource(worker, env);
  const editAction = requiredAction(
    editResource.document,
    "edit-founder-application",
  );
  const editBody = actionBody(editAction, founderFields({
    "expected-revision": 1,
    "intended-contribution": "Lead hosted product and engineering delivery.",
    note: "Updated private hosted founder note.",
    [FOUNDER_SECONDARY_AREAS_FIELD]: ["area:product"],
  }));
  const editedResponse = await submitFounderMutation(
    worker,
    env,
    editResource,
    "PATCH",
    editBody,
  );
  assert.equal(editedResponse.status, 200);
  const edited = await editedResponse.json() as FounderInterestDocument;
  assert.equal(edited.data.revision, 2);
  assert.deepEqual(
    edited.data.history.map(({ kind }) => kind),
    ["created", "edited"],
  );
  assert.equal(
    edited.data.history[0]?.fields.note,
    "Private hosted founder note.",
  );

  const staleResource = await founderResource(worker, env);
  const staleAction = requiredAction(
    staleResource.document,
    "edit-founder-application",
  );
  const staleResponse = await submitFounderMutation(
    worker,
    env,
    staleResource,
    "PATCH",
    actionBody(staleAction, founderFields({
      "operation-id": "founder-operation:hosted-stale",
      "expected-revision": 1,
      note: "A stale write must not be stored.",
      [FOUNDER_SECONDARY_AREAS_FIELD]: ["area:product"],
    })),
  );
  assert.equal(staleResponse.status, 412);

  const restartedWorker = hostedPackageWorker(service);
  const reopened = await founderResource(restartedWorker, env);
  assert.equal(reopened.document.data.revision, 2);
  assert.equal(reopened.document.data.history.length, 2);
  const withdrawAction = requiredAction(
    reopened.document,
    "withdraw-founder-application",
  );
  const withdrawnResponse = await submitFounderMutation(
    restartedWorker,
    env,
    reopened,
    "DELETE",
    actionBody(withdrawAction, { "confirm-withdrawal": true }),
  );
  assert.equal(withdrawnResponse.status, 200);

  const final = await founderResource(hostedPackageWorker(service), env);
  assert.equal(final.document.data.status, "withdrawn");
  assert.equal(final.document.data.revision, 3);
  assert.deepEqual(
    final.document.data.history.map(({ kind }) => kind),
    ["created", "edited", "withdrawn"],
  );
  assert.deepEqual(actionNames(final.document), [
    FOUNDER_WITHDRAWAL_REPLAY_ACTION,
  ]);
  assert.equal(recordsIn(service, "founder-applications").length, 1);
  assert.equal(recordsIn(service, "founder-application-history").length, 3);
  for (const collection of [
    "investment-indications",
    "investment-indication-history",
    "investment-aggregate-states",
    "investment-aggregate-operations",
  ]) {
    assert.deepEqual(recordsIn(service, collection), []);
  }
});

test("hosted founder HTML and hypermedia project the same persistent state and actions", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  await configureHostedFounderCampaign(service);
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Founder participant",
    "participant-operation:founder-hosted-parity",
    { declaredInterest: "founder" },
  );

  const initialJson = await founderResource(hostedPackageWorker(service), env);
  const initialHtml = await founderHtmlResource(
    hostedPackageWorker(service),
    env,
  );
  assert.deepEqual(
    profileHtmlActionNames(initialHtml.html),
    actionNames(initialJson.document),
  );
  assert.match(initialHtml.html, /Not submitted/u);

  const privateNote = "Hosted parity founder note";
  const created = await submitFounderMutation(
    hostedPackageWorker(service),
    env,
    initialJson,
    "POST",
    actionBody(
      requiredAction(initialJson.document, "create-founder-application"),
      founderFields({ note: privateNote }),
    ),
  );
  assert.equal(created.status, 201);

  const restartedJson = await founderResource(
    hostedPackageWorker(service),
    env,
  );
  const restartedHtml = await founderHtmlResource(
    hostedPackageWorker(service),
    env,
  );
  assert.equal(restartedJson.document.data.status, "received");
  assert.equal(restartedJson.document.data.revision, 1);
  assert.equal(restartedJson.document.data.fields?.note, privateNote);
  assert.deepEqual(
    profileHtmlActionNames(restartedHtml.html),
    actionNames(restartedJson.document),
  );
  assert.match(restartedHtml.html, /Received/u);
  assert.match(restartedHtml.html, /Revision 1/u);
  assert.match(restartedHtml.html, new RegExp(privateNote, "u"));
  assert.match(restartedHtml.html, /Engineering/u);
});

test("hosted terminal withdrawal recovery uses one exact scoped proof across response loss and restart", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  await configureHostedFounderCampaign(service);
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Founder participant",
    "participant-operation:founder-terminal-replay",
    { declaredInterest: "founder" },
  );

  const worker = hostedPackageWorker(service);
  const initial = await founderResource(worker, env);
  assert.equal(
    (await submitFounderMutation(
      worker,
      env,
      initial,
      "POST",
      actionBody(
        requiredAction(initial.document, "create-founder-application"),
        founderFields({ note: "Private terminal replay note." }),
      ),
    )).status,
    201,
  );

  const received = await founderResource(worker, env);
  const maximumOperationId = "w".repeat(MAX_STABLE_ID_LENGTH);
  const withdrawalAction = requiredAction(
    received.document,
    "withdraw-founder-application",
  );
  const operationField = withdrawalAction.fields.find(
    (field) => field.name === "operation-id",
  );
  assert(operationField);
  assert.equal(operationField.max_length, MAX_STABLE_ID_LENGTH);
  assert.equal(operationField.max_bytes, MAX_STABLE_ID_LENGTH);
  const withdrawalBody = actionBody(
    withdrawalAction,
    {
      "operation-id": maximumOperationId,
      "confirm-withdrawal": true,
    },
  );
  const operationId = String(withdrawalBody["operation-id"]);
  assert.equal(operationId, maximumOperationId);
  const lostResponse = await submitFounderMutation(
    worker,
    env,
    received,
    "DELETE",
    withdrawalBody,
  );
  assert.equal(lostResponse.status, 200);
  const projectedDocument = await lostResponse.clone().json() as
    FounderInterestDocument;
  assert.equal(projectedDocument.data.status, "withdrawn");
  assert.equal(projectedDocument.data.revision, 2);
  assert.deepEqual(actionNames(projectedDocument), [
    FOUNDER_WITHDRAWAL_REPLAY_ACTION,
  ]);
  await lostResponse.body?.cancel();

  const spentOriginalProof = await submitFounderMutation(
    worker,
    env,
    received,
    "DELETE",
    withdrawalBody,
  );
  assert.equal(spentOriginalProof.status, 403);

  const terminal = await founderResource(worker, env);
  assert.equal(terminal.document.data.status, "withdrawn");
  assert.equal(terminal.document.data.revision, 2);
  assert.deepEqual(actionNames(terminal.document), [
    FOUNDER_WITHDRAWAL_REPLAY_ACTION,
  ]);
  const replayAction = requiredAction(
    terminal.document,
    FOUNDER_WITHDRAWAL_REPLAY_ACTION,
  );
  const replayBody = actionBody(replayAction, {
    "confirm-withdrawal": true,
  });
  assert.deepEqual(replayBody, withdrawalBody);
  assert(terminal.csrfToken);
  assert(terminal.cookie);
  assert.doesNotMatch(terminal.cookie, /founder-operation|participant|withdraw/u);

  const terminalHtml = await founderHtmlResource(worker, env);
  assert.deepEqual(profileHtmlActionNames(terminalHtml.html), [
    FOUNDER_WITHDRAWAL_REPLAY_ACTION,
  ]);
  assert.match(terminalHtml.html, /Retry recorded withdrawal/u);
  assert.match(
    terminalHtml.html,
    new RegExp(
      `name="operation-id" type="hidden" value="${maximumOperationId}"`,
      "u",
    ),
  );
  assert.doesNotMatch(
    terminalHtml.html,
    /data-action-name="(?:create|edit|withdraw)-founder-application"/u,
  );

  const committedFounder = founderCollectionSnapshot(service);
  const committedOperation = service.operations.get(operationId);
  assert(committedOperation);
  const claimsBeforeExact = recordsIn(service, "browser-mutation-replays").length;
  const exactHtml = await submitFounderHtmlMutation(
    worker,
    env,
    terminalHtml.cookie,
    [
      [MUTATION_CSRF_FIELD, terminalHtml.csrfToken],
      [MUTATION_METHOD_FIELD, "DELETE"],
      ["operation-id", maximumOperationId],
      ["expected-revision", "1"],
      ["confirm-withdrawal", "true"],
    ],
  );
  assert.equal(exactHtml.status, 200);
  assert.match(
    exactHtml.headers.get("content-type") ?? "",
    /^text\/html/u,
  );
  const exactHtmlBody = await exactHtml.text();
  assert.match(exactHtmlBody, /Withdrawn/u);
  assert.match(exactHtmlBody, /Retry recorded withdrawal/u);
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    claimsBeforeExact + 1,
  );
  assert.deepEqual(founderCollectionSnapshot(service), committedFounder);
  assert.strictEqual(service.operations.get(operationId), committedOperation);

  const exact = await submitFounderMutation(
    worker,
    env,
    terminal,
    "DELETE",
    replayBody,
  );
  assert.equal(exact.status, 200);
  const exactDocument = await exact.json() as FounderInterestDocument;
  assert.equal(exactDocument.data.status, "withdrawn");
  assert.equal(exactDocument.data.revision, 2);
  assert.deepEqual(actionNames(exactDocument), [
    FOUNDER_WITHDRAWAL_REPLAY_ACTION,
  ]);
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    claimsBeforeExact + 2,
  );
  assert.deepEqual(founderCollectionSnapshot(service), committedFounder);
  assert.strictEqual(service.operations.get(operationId), committedOperation);

  const reused = await submitFounderMutation(
    worker,
    env,
    terminal,
    "DELETE",
    replayBody,
  );
  assert.equal(reused.status, 403);

  const restartedWorker = hostedPackageWorker(service);
  const restarted = await founderResource(restartedWorker, env);
  assert.deepEqual(actionNames(restarted.document), [
    FOUNDER_WITHDRAWAL_REPLAY_ACTION,
  ]);
  const claimsBeforeRejected = recordsIn(
    service,
    "browser-mutation-replays",
  ).length;
  const changed = await submitFounderMutation(
    restartedWorker,
    env,
    restarted,
    "DELETE",
    { ...replayBody, "operation-id": "founder-operation:changed-terminal-retry" },
  );
  assert.equal(changed.status, 400);
  const stale = await submitFounderMutation(
    restartedWorker,
    env,
    restarted,
    "DELETE",
    { ...replayBody, "expected-revision": 2 },
  );
  assert.equal(stale.status, 400);
  const unrelated = await submitFounderMutation(
    restartedWorker,
    env,
    restarted,
    "PATCH",
    replayBody,
  );
  assert.equal(unrelated.status, 400);
  const foreign = await submitFounderMutation(
    restartedWorker,
    env,
    restarted,
    "DELETE",
    replayBody,
    {
      subject: "sites-foreign-founder-terminal-retry",
      email: "foreign-founder-terminal-retry@example.test",
    },
  );
  assert.equal(foreign.status, 404);
  assert.doesNotMatch(
    await foreign.text(),
    /Private terminal replay note|founder-operation|participant-subject/u,
  );
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    claimsBeforeRejected,
  );

  const restartedExact = await submitFounderMutation(
    restartedWorker,
    env,
    restarted,
    "DELETE",
    replayBody,
  );
  assert.equal(restartedExact.status, 200);
  assert.deepEqual(founderCollectionSnapshot(service), committedFounder);
  assert.strictEqual(service.operations.get(operationId), committedOperation);
  const restartedReuse = await submitFounderMutation(
    restartedWorker,
    env,
    restarted,
    "DELETE",
    replayBody,
  );
  assert.equal(restartedReuse.status, 403);
});

test("hosted founder withdrawal rejects one-over stable operation IDs before JSON or HTML mutation", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  await configureHostedFounderCampaign(service);
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Founder participant",
    "participant-operation:founder-operation-limit",
    { declaredInterest: "founder" },
  );

  const worker = hostedPackageWorker(service);
  const initial = await founderResource(worker, env);
  assert.equal(
    (await submitFounderMutation(
      worker,
      env,
      initial,
      "POST",
      actionBody(
        requiredAction(initial.document, "create-founder-application"),
        founderFields(),
      ),
    )).status,
    201,
  );

  const overLimitOperationId = "x".repeat(MAX_STABLE_ID_LENGTH + 1);
  const before = founderCollectionSnapshot(service);
  const received = await founderResource(worker, env);
  const withdrawalAction = requiredAction(
    received.document,
    "withdraw-founder-application",
  );
  const overLimitBody = actionBody(withdrawalAction, {
    "operation-id": overLimitOperationId,
    "confirm-withdrawal": true,
  });
  const jsonRejected = await submitFounderMutation(
    worker,
    env,
    received,
    "DELETE",
    overLimitBody,
  );
  assert.equal(jsonRejected.status, 400);
  assert.match(
    jsonRejected.headers.get("content-type") ?? "",
    /^application\/vnd\.aittadb-invest\+json/u,
  );
  assert.doesNotMatch(
    await jsonRejected.text(),
    new RegExp(overLimitOperationId, "u"),
  );
  assert.deepEqual(founderCollectionSnapshot(service), before);
  assert.equal(service.operations.has(overLimitOperationId), false);

  const htmlResource = await founderHtmlResource(worker, env);
  const htmlRejected = await submitFounderHtmlMutation(
    worker,
    env,
    htmlResource.cookie,
    [
      [MUTATION_CSRF_FIELD, htmlResource.csrfToken],
      [MUTATION_METHOD_FIELD, "DELETE"],
      ["operation-id", overLimitOperationId],
      ["expected-revision", "1"],
      ["confirm-withdrawal", "true"],
    ],
  );
  assert.equal(htmlRejected.status, 400);
  assert.match(
    htmlRejected.headers.get("content-type") ?? "",
    /^text\/html/u,
  );
  assert.doesNotMatch(
    await htmlRejected.text(),
    new RegExp(overLimitOperationId, "u"),
  );
  assert.deepEqual(founderCollectionSnapshot(service), before);
  assert.equal(service.operations.has(overLimitOperationId), false);

  const unchanged = await founderResource(hostedPackageWorker(service), env);
  assert.equal(unchanged.document.data.status, "received");
  assert.equal(unchanged.document.data.revision, 1);
  assert.deepEqual(actionNames(unchanged.document), [
    "edit-founder-application",
    "withdraw-founder-application",
  ]);
});

test("hosted founder applications remain readable and withdrawable after interest and phase changes", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  const privateNote = "PRIVATE RETAINED FOUNDER APPLICATION";
  await configureHostedFounderCampaign(service);
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Founder participant",
    "participant-operation:founder-interest-change",
    { declaredInterest: "founder" },
  );

  const initial = await founderResource(hostedPackageWorker(service), env);
  const created = await submitFounderMutation(
    hostedPackageWorker(service),
    env,
    initial,
    "POST",
    actionBody(
      requiredAction(initial.document, "create-founder-application"),
      founderFields({ note: privateNote }),
    ),
  );
  assert.equal(created.status, 201);

  await updateHostedParticipantInterest(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "investor",
    "participant-operation:founder-to-investor",
  );
  await configureHostedFounderCampaign(service, "closed");

  const participantHome = await hostedPackageWorker(service).fetch(
    participantRequest("/participant"),
    env,
    executionContext,
  );
  assert.equal(participantHome.status, 200);
  const homeDocument = await participantHome.json() as Readonly<{
    links: readonly Readonly<{ rel: readonly string[]; href: string }>[];
  }>;
  assert.ok(homeDocument.links.some((link) =>
    link.rel.includes("founder-interest") &&
    link.href === `${APP_ORIGIN}${FOUNDER_INTEREST_PATH}`
  ));

  const retained = await founderResource(hostedPackageWorker(service), env);
  assert.equal(retained.document.data.status, "received");
  assert.equal(retained.document.data.fields?.note, privateNote);
  assert.deepEqual(
    actionNames(retained.document).sort(),
    ["edit-founder-application", "withdraw-founder-application"],
  );
  assert.equal(
    actionNames(retained.document).includes("create-founder-application"),
    false,
  );

  const investorSubject = "sites-investor-without-founder-application";
  const investorEmail = "investor-without-founder@example.test";
  await registerHostedParticipant(
    service,
    investorSubject,
    investorEmail,
    "Investor participant",
    "participant-operation:investor-without-founder",
    { declaredInterest: "investor" },
  );
  const ineligibleNew = await founderResource(
    hostedPackageWorker(service),
    env,
    investorSubject,
    investorEmail,
  );
  assert.equal(ineligibleNew.document.data.status, "not_submitted");
  assert.deepEqual(actionNames(ineligibleNew.document), []);
  assert.doesNotMatch(JSON.stringify(ineligibleNew.document), new RegExp(privateNote, "u"));

  const owner = await hostedPackageWorker(service).fetch(
    ownerRequest(FOUNDER_INTEREST_PATH),
    env,
    executionContext,
  );
  assert.equal(owner.status, 404);
  assert.doesNotMatch(await owner.text(), new RegExp(privateNote, "u"));

  const withdraw = requiredAction(
    retained.document,
    "withdraw-founder-application",
  );
  const withdrawn = await submitFounderMutation(
    hostedPackageWorker(service),
    env,
    retained,
    "DELETE",
    actionBody(withdraw, { "confirm-withdrawal": true }),
  );
  assert.equal(withdrawn.status, 200);
  const final = await founderResource(hostedPackageWorker(service), env);
  assert.equal(final.document.data.status, "withdrawn");
  assert.deepEqual(actionNames(final.document), [
    FOUNDER_WITHDRAWAL_REPLAY_ACTION,
  ]);
});

test("unsupported founder PUT leaves hosted JSON and HTML proofs reusable", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  await configureHostedFounderCampaign(service);
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Founder participant",
    "participant-operation:founder-put-proof",
    { declaredInterest: "founder" },
  );
  const worker = hostedPackageWorker(service);

  const unsupportedPutAs = (
    subject: string | null,
    email: string | null,
  ): Promise<Response> =>
    worker.fetch(
      new Request(`${APP_ORIGIN}${FOUNDER_INTEREST_PATH}`, {
        method: "PUT",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(subject === null || email === null
            ? {}
            : {
                "oai-authenticated-user-id": subject,
                "oai-authenticated-user-email": email,
              }),
        },
        body: "{}",
      }),
      env,
      executionContext,
    );
  const claimsBeforeAuthorization = recordsIn(
    service,
    "browser-mutation-replays",
  ).length;
  const anonymousPut = await unsupportedPutAs(null, null);
  const ownerPut = await unsupportedPutAs(OWNER.subject, OWNER_EMAIL);
  const foreignPut = await unsupportedPutAs(
    "sites-foreign-founder-subject",
    "foreign-founder@example.test",
  );
  assert.equal(anonymousPut.status, 401);
  assert.equal(anonymousPut.headers.get("allow"), null);
  assert.equal(ownerPut.status, 404);
  assert.equal(foreignPut.status, 404);
  assert.equal(ownerPut.headers.get("allow"), null);
  assert.deepEqual(await ownerPut.json(), await foreignPut.json());
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    claimsBeforeAuthorization,
  );

  const jsonProof = await founderResource(worker, env);
  const createBody = actionBody(
    requiredAction(jsonProof.document, "create-founder-application"),
    founderFields(),
  );
  const claimsBeforeJsonPut = recordsIn(
    service,
    "browser-mutation-replays",
  ).length;
  const jsonPut = await submitUnsupportedFounderPut(
    worker,
    env,
    jsonProof,
    "application/json",
    JSON.stringify(createBody),
  );
  assert.equal(jsonPut.status, 405);
  assert.equal(jsonPut.headers.get("allow"), "GET, POST, PATCH, DELETE");
  assert.equal(jsonPut.headers.get("set-cookie"), null);
  assert.match(
    jsonPut.headers.get("content-type") ?? "",
    /^application\/vnd\.aittadb-invest\+json/u,
  );
  assert.equal(
    (await jsonPut.json() as Readonly<{ data: Readonly<{ code: string }> }>).data
      .code,
    "method_not_allowed",
  );
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    claimsBeforeJsonPut,
  );

  const created = await submitFounderMutation(
    worker,
    env,
    jsonProof,
    "POST",
    createBody,
  );
  assert.equal(created.status, 201);
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    claimsBeforeJsonPut + 1,
  );

  const htmlProof = await founderHtmlResource(worker, env);
  const claimsBeforeHtmlPut = recordsIn(
    service,
    "browser-mutation-replays",
  ).length;
  const htmlBody = new URLSearchParams([
    [MUTATION_CSRF_FIELD, htmlProof.csrfToken],
  ]);
  const htmlPut = await submitUnsupportedFounderPut(
    worker,
    env,
    htmlProof,
    "text/html",
    htmlBody,
  );
  assert.equal(htmlPut.status, 405);
  assert.equal(htmlPut.headers.get("allow"), "GET, POST, PATCH, DELETE");
  assert.equal(htmlPut.headers.get("set-cookie"), null);
  assert.match(htmlPut.headers.get("content-type") ?? "", /^text\/html/u);
  assert.match(await htmlPut.text(), /request method is not available/u);
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    claimsBeforeHtmlPut,
  );

  const withdrawn = await submitFounderHtmlMutation(
    worker,
    env,
    htmlProof.cookie,
    [
      [MUTATION_CSRF_FIELD, htmlProof.csrfToken],
      [MUTATION_METHOD_FIELD, "DELETE"],
      ["operation-id", "founder-operation:proof-after-html-put"],
      ["expected-revision", "1"],
      ["confirm-withdrawal", "true"],
    ],
  );
  assert.equal(withdrawn.status, 200);
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    claimsBeforeHtmlPut + 1,
  );
});

test("hosted founder bounds reject malformed and oversized bodies with exact proof semantics", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  await configureHostedFounderCampaign(service);
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Founder participant",
    "participant-operation:founder-hosted-bounds",
    { declaredInterest: "founder" },
  );
  const worker = hostedPackageWorker(service);

  const malformedProof = await founderResource(worker, env);
  const malformedBody = {
    ...actionBody(
      requiredAction(
        malformedProof.document,
        "create-founder-application",
      ),
      founderFields(),
    ),
    unexpected: "must be rejected",
  };
  const claimsBeforeMalformed = recordsIn(
    service,
    "browser-mutation-replays",
  ).length;
  const malformed = await submitFounderMutation(
    worker,
    env,
    malformedProof,
    "POST",
    malformedBody,
  );
  assert.equal(malformed.status, 400);
  assert.match(malformed.headers.get("set-cookie") ?? "", /Max-Age=0/u);
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    claimsBeforeMalformed + 1,
  );
  const consumedProof = await submitFounderMutation(
    worker,
    env,
    malformedProof,
    "POST",
    malformedBody,
  );
  assert.equal(consumedProof.status, 403);
  assert.deepEqual(recordsIn(service, "founder-applications"), []);

  const oversizedProof = await founderResource(worker, env);
  const oversizedBody = actionBody(
    requiredAction(oversizedProof.document, "create-founder-application"),
    founderFields({ note: "x".repeat(MAX_FOUNDER_INTEREST_MUTATION_BYTES) }),
  );
  const claimsBeforeOversized = recordsIn(
    service,
    "browser-mutation-replays",
  ).length;
  const oversized = await submitFounderMutation(
    worker,
    env,
    oversizedProof,
    "POST",
    oversizedBody,
  );
  assert.equal(oversized.status, 413);
  assert.equal(oversized.headers.get("set-cookie"), null);
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    claimsBeforeOversized,
  );

  const corrected = await submitFounderMutation(
    worker,
    env,
    oversizedProof,
    "POST",
    actionBody(
      requiredAction(oversizedProof.document, "create-founder-application"),
      founderFields({ note: "Corrected bounded founder submission." }),
    ),
  );
  assert.equal(corrected.status, 201);
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    claimsBeforeOversized + 1,
  );
});

test("hosted founder creation rechecks campaign policy after action discovery", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  await configureHostedFounderCampaign(service);
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Founder participant",
    "participant-operation:hosted-founder-policy",
    { declaredInterest: "founder" },
  );
  const worker = hostedPackageWorker(service);
  const discovered = await founderResource(worker, env);
  const action = requiredAction(
    discovered.document,
    "create-founder-application",
  );

  await configureHostedFounderCampaign(service, "closed");
  const denied = await submitFounderMutation(
    worker,
    env,
    discovered,
    "POST",
    actionBody(action, founderFields()),
  );
  assert.equal(denied.status, 412);
  assert.deepEqual(recordsIn(service, "founder-applications"), []);
  assert.deepEqual(recordsIn(service, "founder-application-history"), []);

  const closed = await founderResource(hostedPackageWorker(service), env);
  assert.equal(closed.document.data.status, "not_submitted");
  assert.deepEqual(actionNames(closed.document), []);
});

test("hosted founder create atomically rejects phase closure after its final policy sample", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  await configureHostedFounderCampaign(service);
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Founder participant",
    "participant-operation:founder-create-policy-race",
    { declaredInterest: "founder" },
  );

  const discovered = await founderResource(hostedPackageWorker(service), env);
  const createBody = actionBody(
    requiredAction(discovered.document, "create-founder-application"),
    founderFields({ note: "Atomic phase-race founder submission." }),
  );
  const founderBeforeRace = founderCollectionSnapshot(service);
  let phaseClosedDuringTransaction = false;
  service.raceNextTransactionContaining("founder-applications", async () => {
    await configureHostedFounderCampaign(service, "closed");
    phaseClosedDuringTransaction = true;
  });

  const raced = await submitFounderMutation(
    hostedPackageWorker(service),
    env,
    discovered,
    "POST",
    createBody,
  );
  assert.equal(raced.status, 412);
  assert.equal(phaseClosedDuringTransaction, true);
  assert.deepEqual(founderCollectionSnapshot(service), founderBeforeRace);

  await configureHostedFounderCampaign(service, "open");
  const retryProof = await founderResource(hostedPackageWorker(service), env);
  const retried = await submitFounderMutation(
    hostedPackageWorker(service),
    env,
    retryProof,
    "POST",
    createBody,
  );
  assert.equal(retried.status, 201);
  assert.equal(
    (await retried.json() as FounderInterestDocument).data.history.length,
    1,
  );
  assert.equal(
    recordsIn(service, "founder-application-policy-revisions").length,
    1,
  );
  const committedReceipt = cloneSyntheticRecord(
    recordsIn(service, "founder-application-policy-revisions")[0]!,
  );
  assert.equal(committedReceipt.value.schemaVersion, 2);
  assert.equal(committedReceipt.value.participantProfileRevision, 1);

  await configureHostedFounderCampaign(service, "closed");
  await updateHostedParticipantProfile(
    service,
    { declaredInterest: "investor", country: "US" },
    "participant-operation:founder-create-retry-profile-evolution",
  );
  const replayProof = await founderResource(hostedPackageWorker(service), env);
  const replay = await submitFounderMutation(
    hostedPackageWorker(service),
    env,
    replayProof,
    "POST",
    createBody,
  );
  assert.equal(replay.status, 200);
  assert.equal(
    (await replay.json() as FounderInterestDocument).data.history.length,
    1,
  );
  assert.equal(
    recordsIn(service, "founder-application-policy-revisions").length,
    1,
  );
  assert.deepEqual(
    recordsIn(service, "founder-application-policy-revisions")[0],
    committedReceipt,
  );
});

test("hosted founder create atomically rejects participant eligibility changes after its final sample", async (t) => {
  const scenarios = [
    {
      name: "country",
      mutate: (service: SyntheticAittaDBService) =>
        updateHostedParticipantProfile(
          service,
          { country: "US" },
          "participant-operation:founder-create-country-race",
        ),
    },
    {
      name: "declared interest",
      mutate: (service: SyntheticAittaDBService) =>
        updateHostedParticipantProfile(
          service,
          { declaredInterest: "investor" },
          "participant-operation:founder-create-interest-race",
        ),
    },
    {
      name: "deletion request",
      mutate: async (service: SyntheticAittaDBService) => {
        const repository = hostedParticipantRepository(service);
        const current = await repository.current();
        assert(current);
        const result = await repository.requestAccountDeletion({
          operationId: "participant-operation:founder-create-deletion-race",
          expectedRevision: current.revision,
          requestedAt: "2026-08-10T11:00:00.000Z",
        });
        assert.equal(result.revision, current.revision + 1);
        assert.equal(result.snapshot.accountDeletionRequest.state, "requested");
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const service = new SyntheticAittaDBService();
      const env = configuredEnvironment({ OWNER_EMAIL });
      await configureHostedFounderCampaign(service);
      await registerHostedParticipant(
        service,
        PARTICIPANT_SUBJECT,
        PARTICIPANT_EMAIL,
        "Founder participant",
        `participant-operation:founder-create-${scenario.name.replaceAll(" ", "-")}`,
        { declaredInterest: "founder" },
      );

      const discovered = await founderResource(hostedPackageWorker(service), env);
      const createBody = actionBody(
        requiredAction(discovered.document, "create-founder-application"),
        founderFields({ note: `Atomic ${scenario.name} race submission.` }),
      );
      const founderOperationId = String(createBody["operation-id"]);
      const founderBeforeRace = founderCollectionSnapshot(service);
      const auditBeforeRace = recordsIn(service, "audit-events").map(
        cloneSyntheticRecord,
      );
      let profileChangedDuringTransaction = false;
      service.raceNextTransactionContaining("founder-applications", async () => {
        await scenario.mutate(service);
        profileChangedDuringTransaction = true;
      });

      const raced = await submitFounderMutation(
        hostedPackageWorker(service),
        env,
        discovered,
        "POST",
        createBody,
      );
      assert.equal(raced.status, 412);
      assert.equal(profileChangedDuringTransaction, true);
      assert.deepEqual(founderCollectionSnapshot(service), founderBeforeRace);
      assert.deepEqual(
        recordsIn(service, "audit-events").map(cloneSyntheticRecord),
        auditBeforeRace,
      );
      assert.equal(service.operations.has(founderOperationId), false);
      assert.equal(
        recordsIn(service, "founder-application-policy-revisions").length,
        0,
      );
      assert.equal((await hostedParticipantRepository(service).current())?.revision, 2);

      if (scenario.name === "deletion request") {
        const unavailable = await hostedPackageWorker(service).fetch(
          new Request(`${APP_ORIGIN}${FOUNDER_INTEREST_PATH}`, {
            headers: {
              accept: "application/json",
              "oai-authenticated-user-id": PARTICIPANT_SUBJECT,
              "oai-authenticated-user-email": PARTICIPANT_EMAIL,
            },
          }),
          env,
          executionContext,
        );
        assert.equal(unavailable.status, 404);
      } else {
        const afterRace = await founderResource(
          hostedPackageWorker(service),
          env,
        );
        assert.equal(
          actionNames(afterRace.document).includes("create-founder-application"),
          false,
        );
      }
    });
  }
});

test("hosted overlapping exact founder create recovers after null policy and restart", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  await configureHostedFounderCampaign(service);
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Founder participant",
    "participant-operation:founder-create-overlap-recovery",
    { declaredInterest: "founder" },
  );
  const losingWorker = hostedPackageWorker(
    service,
    () => new Date("2026-08-11T12:02:00.000Z"),
  );
  const winningWorker = hostedPackageWorker(
    service,
    () => new Date("2026-08-11T12:01:00.000Z"),
  );
  const losingProof = await founderResource(losingWorker, env);
  const winningProof = await founderResource(winningWorker, env);
  const submission = founderFields({
    note: "Overlapping exact founder create.",
  });
  const losingBody = actionBody(
    requiredAction(losingProof.document, "create-founder-application"),
    submission,
  );
  const operationId = String(losingBody["operation-id"]);
  const winningBody = actionBody(
    requiredAction(winningProof.document, "create-founder-application"),
    { ...submission, "operation-id": operationId },
  );
  const evolvedChoices = [
    { id: "area:commercial", label: "Commercial" },
    { id: "area:delivery", label: "Delivery" },
  ] as const;
  let winningStatus: number | null = null;
  let founderAfterWinner: readonly SyntheticRecord[] | null = null;
  let auditAfterEvolution: readonly SyntheticRecord[] | null = null;

  service.raceNextReadFrom("founder-applications", async () => {
    const winning = await submitFounderMutation(
      winningWorker,
      env,
      winningProof,
      "POST",
      winningBody,
    );
    winningStatus = winning.status;
    const winningDocument = await winning.json() as FounderInterestDocument;
    assert.equal(winningDocument.data.revision, 1);
    assert.equal(
      winningDocument.data.history[0]?.occurred_at,
      "2026-08-11T12:01:00.000Z",
    );
    founderAfterWinner = founderCollectionSnapshot(service);
    await configureHostedFounderCampaign(service, "closed", evolvedChoices);
    await updateHostedParticipantProfile(
      service,
      { country: "US", declaredInterest: "investor" },
      "participant-operation:founder-create-overlap-policy-evolution",
    );
    auditAfterEvolution = recordsIn(service, "audit-events").map(
      cloneSyntheticRecord,
    );
  });

  const losing = await submitFounderMutation(
    losingWorker,
    env,
    losingProof,
    "POST",
    losingBody,
  );
  assert.equal(winningStatus, 201);
  assert.equal(losing.status, 200);
  const losingDocument = await losing.json() as FounderInterestDocument;
  assert.equal(losingDocument.data.revision, 1);
  assert.equal(
    losingDocument.data.history[0]?.occurred_at,
    "2026-08-11T12:01:00.000Z",
  );
  assert(founderAfterWinner);
  assert(auditAfterEvolution);
  assert.deepEqual(founderCollectionSnapshot(service), founderAfterWinner);
  assert.deepEqual(
    recordsIn(service, "audit-events").map(cloneSyntheticRecord),
    auditAfterEvolution,
  );
  const committedOperation = service.operations.get(operationId);
  assert(committedOperation);

  const restartedWorker = hostedPackageWorker(
    service,
    () => new Date("2026-08-11T12:03:00.000Z"),
  );
  const restartProof = await founderResource(restartedWorker, env);
  const restartedReplay = await submitFounderMutation(
    restartedWorker,
    env,
    restartProof,
    "POST",
    losingBody,
  );
  assert.equal(restartedReplay.status, 200);
  const restartedDocument = await restartedReplay.json() as FounderInterestDocument;
  assert.equal(restartedDocument.data.revision, 1);
  assert.equal(
    restartedDocument.data.history[0]?.occurred_at,
    "2026-08-11T12:01:00.000Z",
  );

  const changedWorker = hostedPackageWorker(
    service,
    () => new Date("2026-08-11T12:04:00.000Z"),
  );
  const changedProof = await founderResource(changedWorker, env);
  const changed = await submitFounderMutation(
    changedWorker,
    env,
    changedProof,
    "POST",
    { ...losingBody, note: "Changed overlapping founder create." },
  );
  assert.equal(changed.status, 409);

  const newOperationId = "founder-operation:overlap-create-new";
  const newWorker = hostedPackageWorker(
    service,
    () => new Date("2026-08-11T12:05:00.000Z"),
  );
  const newProof = await founderResource(newWorker, env);
  const newCreate = await submitFounderMutation(
    newWorker,
    env,
    newProof,
    "POST",
    { ...losingBody, "operation-id": newOperationId },
  );
  assert.equal(newCreate.status, 412);
  assert.equal(service.operations.has(newOperationId), false);
  assert.strictEqual(service.operations.get(operationId), committedOperation);
  assert.deepEqual(founderCollectionSnapshot(service), founderAfterWinner);
  assert.deepEqual(
    recordsIn(service, "audit-events").map(cloneSyntheticRecord),
    auditAfterEvolution,
  );
});

test("hosted founder edit atomically rejects contribution changes after its final policy sample", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  await configureHostedFounderCampaign(service);
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Founder participant",
    "participant-operation:founder-edit-policy-race",
    { declaredInterest: "founder" },
  );

  const createProof = await founderResource(hostedPackageWorker(service), env);
  const created = await submitFounderMutation(
    hostedPackageWorker(service),
    env,
    createProof,
    "POST",
    actionBody(
      requiredAction(createProof.document, "create-founder-application"),
      founderFields(),
    ),
  );
  assert.equal(created.status, 201);

  const editProof = await founderResource(hostedPackageWorker(service), env);
  const editBody = actionBody(
    requiredAction(editProof.document, "edit-founder-application"),
    founderFields({
      "expected-revision": 1,
      note: "Atomic contribution-choice race edit.",
    }),
  );
  const evolvedChoices = [
    { id: "area:commercial", label: "Commercial" },
    { id: "area:delivery", label: "Delivery" },
  ] as const;
  const founderBeforeRace = founderCollectionSnapshot(service);
  let choicesChangedDuringTransaction = false;
  service.raceNextTransactionContaining("founder-applications", async () => {
    await configureHostedFounderCampaign(service, "open", evolvedChoices);
    choicesChangedDuringTransaction = true;
  });

  const raced = await submitFounderMutation(
    hostedPackageWorker(service),
    env,
    editProof,
    "PATCH",
    editBody,
  );
  assert.equal(raced.status, 412);
  assert.equal(choicesChangedDuringTransaction, true);
  assert.deepEqual(founderCollectionSnapshot(service), founderBeforeRace);

  await configureHostedFounderCampaign(service, "open");
  const retryProof = await founderResource(hostedPackageWorker(service), env);
  const retried = await submitFounderMutation(
    hostedPackageWorker(service),
    env,
    retryProof,
    "PATCH",
    editBody,
  );
  assert.equal(retried.status, 200);
  assert.equal(
    (await retried.json() as FounderInterestDocument).data.history.length,
    2,
  );
  assert.equal(
    recordsIn(service, "founder-application-policy-revisions").length,
    2,
  );

  await configureHostedFounderCampaign(service, "open", evolvedChoices);
  const replayProof = await founderResource(hostedPackageWorker(service), env);
  const replay = await submitFounderMutation(
    hostedPackageWorker(service),
    env,
    replayProof,
    "PATCH",
    editBody,
  );
  assert.equal(replay.status, 200);
  assert.equal(
    (await replay.json() as FounderInterestDocument).data.history.length,
    2,
  );
  assert.equal(
    recordsIn(service, "founder-application-policy-revisions").length,
    2,
  );
});

test("hosted overlapping exact founder edit recovers after choice change and restart", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  await configureHostedFounderCampaign(service);
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Founder participant",
    "participant-operation:founder-edit-overlap-recovery",
    { declaredInterest: "founder" },
  );
  const initialWorker = hostedPackageWorker(service);
  const createProof = await founderResource(initialWorker, env);
  assert.equal(
    (await submitFounderMutation(
      initialWorker,
      env,
      createProof,
      "POST",
      actionBody(
        requiredAction(createProof.document, "create-founder-application"),
        founderFields(),
      ),
    )).status,
    201,
  );

  const losingWorker = hostedPackageWorker(
    service,
    () => new Date("2026-08-11T12:02:00.000Z"),
  );
  const winningWorker = hostedPackageWorker(
    service,
    () => new Date("2026-08-11T12:01:00.000Z"),
  );
  const losingProof = await founderResource(losingWorker, env);
  const winningProof = await founderResource(winningWorker, env);
  const editFields = founderFields({
    "expected-revision": 1,
    note: "Overlapping exact founder edit.",
  });
  const losingBody = actionBody(
    requiredAction(losingProof.document, "edit-founder-application"),
    editFields,
  );
  const operationId = String(losingBody["operation-id"]);
  const winningBody = actionBody(
    requiredAction(winningProof.document, "edit-founder-application"),
    { ...editFields, "operation-id": operationId },
  );
  const evolvedChoices = [
    { id: "area:commercial", label: "Commercial" },
    { id: "area:delivery", label: "Delivery" },
  ] as const;
  let winningStatus: number | null = null;
  let founderAfterWinner: readonly SyntheticRecord[] | null = null;
  let auditAfterEvolution: readonly SyntheticRecord[] | null = null;

  service.raceNextReadFrom("founder-applications", async () => {
    const winning = await submitFounderMutation(
      winningWorker,
      env,
      winningProof,
      "PATCH",
      winningBody,
    );
    winningStatus = winning.status;
    const winningDocument = await winning.json() as FounderInterestDocument;
    assert.equal(winningDocument.data.revision, 2);
    assert.equal(
      winningDocument.data.history[1]?.occurred_at,
      "2026-08-11T12:01:00.000Z",
    );
    founderAfterWinner = founderCollectionSnapshot(service);
    await configureHostedFounderCampaign(service, "open", evolvedChoices);
    auditAfterEvolution = recordsIn(service, "audit-events").map(
      cloneSyntheticRecord,
    );
  });

  const losing = await submitFounderMutation(
    losingWorker,
    env,
    losingProof,
    "PATCH",
    losingBody,
  );
  assert.equal(winningStatus, 200);
  assert.equal(losing.status, 200);
  const losingDocument = await losing.json() as FounderInterestDocument;
  assert.equal(losingDocument.data.revision, 2);
  assert.equal(
    losingDocument.data.history[1]?.occurred_at,
    "2026-08-11T12:01:00.000Z",
  );
  assert(founderAfterWinner);
  assert(auditAfterEvolution);
  assert.deepEqual(founderCollectionSnapshot(service), founderAfterWinner);
  assert.deepEqual(
    recordsIn(service, "audit-events").map(cloneSyntheticRecord),
    auditAfterEvolution,
  );
  const committedOperation = service.operations.get(operationId);
  assert(committedOperation);

  const restartedWorker = hostedPackageWorker(
    service,
    () => new Date("2026-08-11T12:03:00.000Z"),
  );
  const restartProof = await founderResource(restartedWorker, env);
  const restartedReplay = await submitFounderMutation(
    restartedWorker,
    env,
    restartProof,
    "PATCH",
    losingBody,
  );
  assert.equal(restartedReplay.status, 200);
  const restartedDocument = await restartedReplay.json() as FounderInterestDocument;
  assert.equal(restartedDocument.data.revision, 2);
  assert.equal(
    restartedDocument.data.history[1]?.occurred_at,
    "2026-08-11T12:01:00.000Z",
  );

  const changedWorker = hostedPackageWorker(
    service,
    () => new Date("2026-08-11T12:04:00.000Z"),
  );
  const changedProof = await founderResource(changedWorker, env);
  const changed = await submitFounderMutation(
    changedWorker,
    env,
    changedProof,
    "PATCH",
    { ...losingBody, note: "Changed overlapping founder edit." },
  );
  assert.equal(changed.status, 409);

  const staleOperationId = "founder-operation:overlap-edit-stale";
  const staleWorker = hostedPackageWorker(
    service,
    () => new Date("2026-08-11T12:05:00.000Z"),
  );
  const staleProof = await founderResource(staleWorker, env);
  const staleBody = actionBody(
    requiredAction(staleProof.document, "edit-founder-application"),
    founderFields({
      "operation-id": staleOperationId,
      "expected-revision": 1,
      "primary-contribution-area-id": "area:commercial",
      [FOUNDER_SECONDARY_AREAS_FIELD]: ["area:delivery"],
      note: "Stale edit after overlapping winner.",
    }),
  );
  const laterChoices = [
    { id: "area:operations", label: "Operations" },
    { id: "area:legal", label: "Legal" },
  ] as const;
  service.raceNextReadFrom("founder-applications", async () => {
    await configureHostedFounderCampaign(service, "open", laterChoices);
  });
  const stale = await submitFounderMutation(
    staleWorker,
    env,
    staleProof,
    "PATCH",
    staleBody,
  );
  assert.equal(stale.status, 412);
  assert.equal(service.operations.has(staleOperationId), false);
  assert.strictEqual(service.operations.get(operationId), committedOperation);
  assert.deepEqual(founderCollectionSnapshot(service), founderAfterWinner);
});

test("hosted founder history and exact retries survive contribution choice evolution", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  await configureHostedFounderCampaign(service);
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Founder participant",
    "participant-operation:founder-choice-evolution",
    { declaredInterest: "founder" },
  );
  const worker = hostedPackageWorker(service);
  const initial = await founderResource(worker, env);
  const createBody = actionBody(
    requiredAction(initial.document, "create-founder-application"),
    founderFields(),
  );
  assert.equal(
    (await submitFounderMutation(worker, env, initial, "POST", createBody)).status,
    201,
  );

  const evolvedChoices = [
    { id: "area:commercial", label: "Commercial" },
    { id: "area:delivery", label: "Delivery" },
  ] as const;
  await configureHostedFounderCampaign(service, "open", evolvedChoices);
  const reopened = await founderResource(hostedPackageWorker(service), env);
  assert.equal(
    reopened.document.data.history[0]?.fields.primary_contribution_area_id,
    "area:engineering",
  );

  const replay = await submitFounderMutation(
    hostedPackageWorker(service),
    env,
    reopened,
    "POST",
    createBody,
  );
  assert.equal(replay.status, 200);
  assert.equal(
    (await replay.json() as FounderInterestDocument).data.history.length,
    1,
  );

  const invalidProof = await founderResource(hostedPackageWorker(service), env);
  const invalidAction = requiredAction(
    invalidProof.document,
    "edit-founder-application",
  );
  const removedChoice = await submitFounderMutation(
    hostedPackageWorker(service),
    env,
    invalidProof,
    "PATCH",
    actionBody(invalidAction, founderFields({
      "operation-id": "founder-operation:removed-choice",
      "expected-revision": 1,
    })),
  );
  assert.equal(removedChoice.status, 400);

  const currentProof = await founderResource(hostedPackageWorker(service), env);
  const currentAction = requiredAction(
    currentProof.document,
    "edit-founder-application",
  );
  const currentChoice = await submitFounderMutation(
    hostedPackageWorker(service),
    env,
    currentProof,
    "PATCH",
    actionBody(currentAction, founderFields({
      "operation-id": "founder-operation:current-choice",
      "expected-revision": 1,
      "primary-contribution-area-id": "area:commercial",
      [FOUNDER_SECONDARY_AREAS_FIELD]: ["area:delivery"],
    })),
  );
  assert.equal(currentChoice.status, 200);
  const edited = await currentChoice.json() as FounderInterestDocument;
  assert.deepEqual(
    edited.data.history.map((entry) => entry.fields.primary_contribution_area_id),
    ["area:engineering", "area:commercial"],
  );
});

test("hosted maximum founder payloads remain bounded across restart, retry, edit, and withdrawal", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  const choices = maximumHostedContributionChoices();
  await configureHostedFounderCampaign(service, "open", choices);
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Founder participant",
    "participant-operation:maximum-founder-storage",
    { declaredInterest: "founder" },
  );
  const worker = hostedPackageWorker(service);
  const initial = await founderResource(worker, env);
  const createBody = actionBody(
    requiredAction(initial.document, "create-founder-application"),
    maximumHostedFounderFields("\u0800"),
  );
  assert.equal(
    (await submitFounderMutation(worker, env, initial, "POST", createBody)).status,
    201,
  );

  const restarted = await founderResource(hostedPackageWorker(service), env);
  assert.equal(restarted.document.data.revision, 1);
  const replay = await submitFounderMutation(
    hostedPackageWorker(service),
    env,
    restarted,
    "POST",
    createBody,
  );
  assert.equal(replay.status, 200);

  const editProof = await founderResource(hostedPackageWorker(service), env);
  const editBody = actionBody(
    requiredAction(editProof.document, "edit-founder-application"),
    maximumHostedFounderFields("\u0801", { "expected-revision": 1 }),
  );
  assert.equal(
    (await submitFounderMutation(
      hostedPackageWorker(service),
      env,
      editProof,
      "PATCH",
      editBody,
    )).status,
    200,
  );

  const withdrawProof = await founderResource(hostedPackageWorker(service), env);
  assert.equal(
    (await submitFounderMutation(
      hostedPackageWorker(service),
      env,
      withdrawProof,
      "DELETE",
      actionBody(
        requiredAction(withdrawProof.document, "withdraw-founder-application"),
        { "confirm-withdrawal": true },
      ),
    )).status,
    200,
  );
  assert.ok(recordsIn(service, "founder-application-fields").length > 2);
  assert.ok(service.maximumRecordBytesSeen <= MAX_HOSTED_RECORD_BYTES);
  assert.ok(
    service.maximumTransactionMutationsSeen <= MAX_HOSTED_TRANSACTION_MUTATIONS,
  );
  assert.ok(
    service.maximumTransactionBytesSeen <= MAX_HOSTED_TRANSACTION_BYTES,
  );
  for (const record of [
    ...recordsIn(service, "founder-applications"),
    ...recordsIn(service, "founder-application-history"),
  ]) {
    assert.equal(Object.hasOwn(record.value, "application"), false);
    assert.equal(Object.hasOwn(record.value, "history"), false);
    assert.ok(JSON.stringify(record.value).length < 4_096);
  }
});

test("hosted HTML founder create and edit accept all valid repeated fields", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  const choices = maximumHostedContributionChoices();
  await configureHostedFounderCampaign(service, "open", choices);
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Founder participant",
    "participant-operation:maximum-founder-form",
    { declaredInterest: "founder" },
  );
  assert.equal(MAX_FOUNDER_INTEREST_MUTATION_FIELDS, 28);

  const createProof = await founderHtmlResource(
    hostedPackageWorker(service),
    env,
  );
  const createEntries = maximumFounderFormEntries(
    createProof.csrfToken,
    "founder-operation:maximum-form-create",
  );
  assert.equal(createEntries.length, 26);
  const created = await submitFounderHtmlMutation(
    hostedPackageWorker(service),
    env,
    createProof.cookie,
    createEntries,
  );
  assert.equal(created.status, 201);
  assert.match(await created.text(), /Revision 1/u);

  const editProof = await founderHtmlResource(
    hostedPackageWorker(service),
    env,
  );
  const editEntries = maximumFounderFormEntries(
    editProof.csrfToken,
    "founder-operation:maximum-form-edit",
    1,
  );
  assert.equal(editEntries.length, MAX_FOUNDER_INTEREST_MUTATION_FIELDS);
  const edited = await submitFounderHtmlMutation(
    hostedPackageWorker(service),
    env,
    editProof.cookie,
    editEntries,
  );
  assert.equal(edited.status, 200);
  assert.match(await edited.text(), /Revision 2/u);
});

test("hosted founder state and mutation proofs remain participant-bound", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  const privateNote = "PRIMARY PARTICIPANT PRIVATE FOUNDER NOTE";
  await configureHostedFounderCampaign(service);
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Founder participant",
    "participant-operation:hosted-founder-primary",
    { declaredInterest: "founder" },
  );
  await registerHostedParticipant(
    service,
    "sites-foreign-founder",
    "foreign-founder@example.test",
    "Foreign founder",
    "participant-operation:hosted-founder-foreign",
    { declaredInterest: "founder" },
  );
  await registerHostedParticipant(
    service,
    OWNER.subject,
    OWNER_EMAIL,
    "Configured owner",
    "participant-operation:hosted-founder-owner",
    { declaredInterest: "founder" },
  );
  const worker = hostedPackageWorker(service);
  const primary = await founderResource(worker, env);
  const create = requiredAction(primary.document, "create-founder-application");
  const createResponse = await submitFounderMutation(
    worker,
    env,
    primary,
    "POST",
    actionBody(create, founderFields({ note: privateNote })),
  );
  assert.equal(createResponse.status, 201);

  const foreign = await founderResource(
    hostedPackageWorker(service),
    env,
    "sites-foreign-founder",
    "foreign-founder@example.test",
  );
  assert.equal(foreign.document.data.status, "not_submitted");
  assert.doesNotMatch(JSON.stringify(foreign.document), new RegExp(privateNote, "u"));

  for (const [request, expectedStatus] of [
    [new Request(`${APP_ORIGIN}${FOUNDER_INTEREST_PATH}`, {
      headers: { accept: "application/json" },
    }), 401],
    [ownerRequest(FOUNDER_INTEREST_PATH), 404],
  ] as const) {
    const response = await hostedPackageWorker(service).fetch(
      request,
      env,
      executionContext,
    );
    assert.equal(response.status, expectedStatus);
    assert.doesNotMatch(await response.text(), new RegExp(privateNote, "u"));
  }

  const subjectProof = await founderResource(worker, env);
  const mismatched = await submitFounderMutation(
    worker,
    env,
    subjectProof,
    "PATCH",
    actionBody(
      requiredAction(subjectProof.document, "edit-founder-application"),
      founderFields({
        "expected-revision": 1,
        note: "Foreign mutation must be denied.",
      }),
    ),
    {
      subject: "sites-foreign-founder",
      email: "foreign-founder@example.test",
    },
  );
  assert.equal(mismatched.status, 403);
  assert.doesNotMatch(await mismatched.text(), new RegExp(privateNote, "u"));

  const originProof = await founderResource(worker, env);
  const crossOrigin = await submitFounderMutation(
    worker,
    env,
    originProof,
    "PATCH",
    actionBody(
      requiredAction(originProof.document, "edit-founder-application"),
      founderFields({ "expected-revision": 1 }),
    ),
    { origin: "https://attacker.example.test" },
  );
  assert.equal(crossOrigin.status, 403);

  const missingCookieProof = await founderResource(worker, env);
  const missingCookie = await submitFounderMutation(
    worker,
    env,
    missingCookieProof,
    "PATCH",
    actionBody(
      requiredAction(missingCookieProof.document, "edit-founder-application"),
      founderFields({ "expected-revision": 1 }),
    ),
    { cookie: "" },
  );
  assert.equal(missingCookie.status, 403);

  const unchanged = await founderResource(hostedPackageWorker(service), env);
  assert.equal(unchanged.document.data.revision, 1);
  assert.equal(unchanged.document.data.history.length, 1);
});

test("hosted investment interests persist their full lifecycle across workers and representations", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  await configureHostedInvestmentFixture(service);
  const firstWorker = hostedPackageWorker(service);

  const initial = await investmentResource(firstWorker, env);
  assert.deepEqual(actionNames(initial.document), [
    "create-personal-investment-interest",
    "create-company-investment-interest",
  ]);
  assert.equal(initial.document.data.acknowledgment_current, true);
  assert.deepEqual(initial.document.data.amount, {
    currency: "SEK",
    minimum: 25_000,
    increment: 5_000,
    maximum: 500_000,
  });

  const rendered: Request[] = [];
  const homeWorker = createApplicationWorker({
    fetchApplication: async (request) => {
      rendered.push(request);
      return new Response("participant application");
    },
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: createHostedApplicationRuntimeResolver({
      fetch: service.fetch,
      now: () => NOW,
    }),
  });
  const participantHome = await homeWorker.fetch(
    participantHtmlRequest("/participant"),
    env,
    executionContext,
  );
  assert.equal(participantHome.status, 200);
  assert.equal(
    rendered[0]?.headers.get(PARTICIPANT_INVESTMENT_INTERESTS_HEADER),
    "available",
  );

  const htmlResponse = await firstWorker.fetch(
    participantHtmlRequest(INVESTMENT_INTEREST_PATH),
    env,
    executionContext,
  );
  assert.equal(htmlResponse.status, 200);
  const html = await htmlResponse.text();
  assert.deepEqual(investmentHtmlActionNames(html), actionNames(initial.document));
  assert.doesNotMatch(html, /TASK-|implementation|features to build/iu);

  const personalOperation = "investment-operation:hosted-personal-create";
  const personalAction = requiredAction(
    initial.document,
    "create-personal-investment-interest",
  );
  const personalBody = actionBody(personalAction, {
    "operation-id": personalOperation,
    "residence-country": "fi",
    amount: 25_000,
    "availability-period": "Within the next twelve months.",
    note: "Private hosted investment note.",
  });
  const createdResponse = await submitInvestmentMutation(
    firstWorker,
    env,
    initial,
    personalAction,
    personalBody,
  );
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as InvestmentInterestItemDocument;
  assert.equal(created.id, personalOperation);
  assert.equal(created.data.status, "active");
  assert.equal(created.data.revision, 1);
  assert.deepEqual(actionNames(created), [
    "edit-investment-interest",
    "withdraw-investment-interest",
  ]);

  const replayProof = await investmentResource(
    hostedPackageWorker(service),
    env,
  );
  const replayResponse = await submitInvestmentMutation(
    hostedPackageWorker(service),
    env,
    replayProof,
    personalAction,
    personalBody,
  );
  assert.equal(replayResponse.status, 200);
  assert.equal(
    (await replayResponse.json() as InvestmentInterestItemDocument).data.history
      .length,
    1,
  );

  const itemPath = investmentItemPath(personalOperation);
  const editProof = await investmentResource(
    hostedPackageWorker(service),
    env,
    itemPath,
  );
  const editAction = requiredAction(editProof.document, "edit-investment-interest");
  const editBody = actionBody(editAction, {
    "operation-id": "investment-operation:hosted-personal-edit",
    "expected-revision": 1,
    amount: 30_000,
    note: "Updated private hosted investment note.",
  });
  const editedResponse = await submitInvestmentMutation(
    hostedPackageWorker(service),
    env,
    editProof,
    editAction,
    editBody,
  );
  assert.equal(editedResponse.status, 200);
  const edited = await editedResponse.json() as InvestmentInterestItemDocument;
  assert.equal(edited.data.revision, 2);
  assert.deepEqual(
    edited.data.history.map(({ transition }) => transition),
    ["created", "edited"],
  );

  const staleProof = await investmentResource(
    hostedPackageWorker(service),
    env,
    itemPath,
  );
  const staleAction = requiredAction(staleProof.document, "edit-investment-interest");
  const staleResponse = await submitInvestmentMutation(
    hostedPackageWorker(service),
    env,
    staleProof,
    staleAction,
    actionBody(staleAction, {
      "operation-id": "investment-operation:hosted-personal-stale",
      "expected-revision": 1,
      note: "A stale hosted value must not be stored.",
    }),
  );
  assert.equal(staleResponse.status, 412);

  const withdrawProof = await investmentResource(
    hostedPackageWorker(service),
    env,
    itemPath,
  );
  const withdrawAction = requiredAction(
    withdrawProof.document,
    "withdraw-investment-interest",
  );
  const withdrawnResponse = await submitInvestmentMutation(
    hostedPackageWorker(service),
    env,
    withdrawProof,
    withdrawAction,
    actionBody(withdrawAction, {
      "operation-id": "investment-operation:hosted-personal-withdraw",
      "expected-revision": 2,
      "confirm-withdrawal": true,
    }),
  );
  assert.equal(withdrawnResponse.status, 200);
  const withdrawn = await withdrawnResponse.json() as InvestmentInterestItemDocument;
  assert.equal(withdrawn.data.status, "withdrawn");
  assert.deepEqual(actionNames(withdrawn), ["reactivate-investment-interest"]);

  const reactivateProof = await investmentResource(
    hostedPackageWorker(service),
    env,
    itemPath,
  );
  const reactivateAction = requiredAction(
    reactivateProof.document,
    "reactivate-investment-interest",
  );
  const reactivatedResponse = await submitInvestmentMutation(
    hostedPackageWorker(service),
    env,
    reactivateProof,
    reactivateAction,
    actionBody(reactivateAction, {
      "operation-id": "investment-operation:hosted-personal-reactivate",
      "expected-revision": 3,
      "confirm-reactivation": true,
    }),
  );
  assert.equal(reactivatedResponse.status, 200);
  const reactivated = await reactivatedResponse.json() as
    InvestmentInterestItemDocument;
  assert.equal(reactivated.data.status, "active");
  assert.equal(reactivated.data.revision, 4);

  const companyProof = await investmentResource(
    hostedPackageWorker(service),
    env,
  );
  const companyAction = requiredAction(
    companyProof.document,
    "create-company-investment-interest",
  );
  const companyBody = actionBody(companyAction, {
    "operation-id": "investment-operation:hosted-company-create",
    "company-name": "Hosted Example Oy",
    "registration-country": "FI",
    "company-identifier": "FI-123 456",
    "representative-name": "Hosted Representative",
    "representative-authority-declared": true,
    amount: 50_000,
    "availability-period": "Within the next twelve months.",
    note: "Private company interest note.",
  });
  const companyHtmlProof = await investmentHtmlResource(
    hostedPackageWorker(service),
    env,
  );
  assert.ok(
    investmentHtmlActionNames(companyHtmlProof.html).includes(
      "create-company-investment-interest",
    ),
  );
  const companyResponse = await submitInvestmentForm(
    hostedPackageWorker(service),
    env,
    companyHtmlProof,
    companyAction,
    companyBody,
  );
  assert.equal(companyResponse.status, 201);
  const companyHtml = await companyResponse.text();
  assert.match(companyHtml, /Hosted Example Oy/u);
  assert.match(companyHtml, /Private company interest note/u);
  assert.equal(recordsIn(service, "investment-indications").length, 2);
  assert.equal(recordsIn(service, "investment-indication-history").length, 5);
  assert.equal(recordsIn(service, "participant-investment-indexes").length, 1);
  assert.equal(recordsIn(service, "investment-aggregate-states").length, 1);
});

test("hosted investment creation and reactivation recheck phase and package policy", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  await configureHostedInvestmentFixture(service);

  const openProof = await investmentResource(hostedPackageWorker(service), env);
  const openAction = requiredAction(
    openProof.document,
    "create-personal-investment-interest",
  );
  await configureHostedInvestmentCampaign(service, "closed");
  const closedResponse = await submitInvestmentMutation(
    hostedPackageWorker(service),
    env,
    openProof,
    openAction,
    actionBody(openAction, {
      "operation-id": "investment-operation:hosted-closed-create",
      "residence-country": "FI",
      amount: 25_000,
      "availability-period": "Within twelve months.",
    }),
  );
  assert.equal(closedResponse.status, 412);
  const closed = await investmentResource(hostedPackageWorker(service), env);
  assert.deepEqual(actionNames(closed.document), []);

  await configureHostedInvestmentCampaign(service, "open");
  const lifecycleProof = await investmentResource(
    hostedPackageWorker(service),
    env,
  );
  const lifecycleCreate = requiredAction(
    lifecycleProof.document,
    "create-personal-investment-interest",
  );
  const lifecycleOperation = "investment-operation:hosted-policy-lifecycle";
  const lifecycleCreated = await submitInvestmentMutation(
    hostedPackageWorker(service),
    env,
    lifecycleProof,
    lifecycleCreate,
    actionBody(lifecycleCreate, {
      "operation-id": lifecycleOperation,
      "residence-country": "FI",
      amount: 25_000,
      "availability-period": "Within twelve months.",
    }),
  );
  assert.equal(lifecycleCreated.status, 201);
  const lifecyclePath = investmentItemPath(lifecycleOperation);
  const withdrawProof = await investmentResource(
    hostedPackageWorker(service),
    env,
    lifecyclePath,
  );
  const withdrawAction = requiredAction(
    withdrawProof.document,
    "withdraw-investment-interest",
  );
  const withdrawn = await submitInvestmentMutation(
    hostedPackageWorker(service),
    env,
    withdrawProof,
    withdrawAction,
    actionBody(withdrawAction, {
      "operation-id": "investment-operation:hosted-policy-withdraw",
      "expected-revision": 1,
      "confirm-withdrawal": true,
    }),
  );
  assert.equal(withdrawn.status, 200);
  const reactivateProof = await investmentResource(
    hostedPackageWorker(service),
    env,
    lifecyclePath,
  );
  const reactivateAction = requiredAction(
    reactivateProof.document,
    "reactivate-investment-interest",
  );
  await configureHostedInvestmentCampaign(service, "closed");
  const closedReactivation = await submitInvestmentMutation(
    hostedPackageWorker(service),
    env,
    reactivateProof,
    reactivateAction,
    actionBody(reactivateAction, {
      "operation-id": "investment-operation:hosted-closed-reactivate",
      "expected-revision": 2,
      "confirm-reactivation": true,
    }),
  );
  assert.equal(closedReactivation.status, 412);
  const retained = await investmentResource(
    hostedPackageWorker(service),
    env,
    lifecyclePath,
  );
  assert.equal(retained.document.data.status, "withdrawn");
  assert.deepEqual(actionNames(retained.document), []);

  await configureHostedInvestmentCampaign(service, "open");
  const currentProof = await investmentResource(hostedPackageWorker(service), env);
  const currentAction = requiredAction(
    currentProof.document,
    "create-personal-investment-interest",
  );
  await appendHostedPackageVersion(service, 2, 1);
  const stalePackageResponse = await submitInvestmentMutation(
    hostedPackageWorker(service),
    env,
    currentProof,
    currentAction,
    actionBody(currentAction, {
      "operation-id": "investment-operation:hosted-stale-package-create",
      "residence-country": "FI",
      amount: 25_000,
      "availability-period": "Within twelve months.",
    }),
  );
  assert.equal(stalePackageResponse.status, 412);
  const stalePackage = await investmentResource(
    hostedPackageWorker(service),
    env,
  );
  assert.equal(stalePackage.document.data.acknowledgment_current, false);
  assert.deepEqual(actionNames(stalePackage.document), []);
  assert.equal(recordsIn(service, "investment-indications").length, 1);
  assert.equal(recordsIn(service, "investment-indication-history").length, 2);
  assert.equal(recordsIn(service, "investment-aggregate-states").length, 1);
});

test("hosted investment mutation rejects policy heads changed during one request", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  await configureHostedInvestmentFixture(service);
  const proof = await investmentResource(hostedPackageWorker(service), env);
  const action = requiredAction(
    proof.document,
    "create-personal-investment-interest",
  );
  service.interceptReadAfter("campaign-setup-current", 2, async () => {
    await configureHostedInvestmentCampaign(service, "closed");
  });

  const response = await submitInvestmentMutation(
    hostedPackageWorker(service),
    env,
    proof,
    action,
    actionBody(action, {
      "operation-id": "investment-operation:hosted-policy-race",
      "residence-country": "FI",
      amount: 25_000,
      "availability-period": "Within twelve months.",
    }),
  );

  assert.equal(response.status, 503);
  assert.equal(recordsIn(service, "investment-indications").length, 0);
  assert.equal(recordsIn(service, "investment-indication-history").length, 0);
  assert.equal(recordsIn(service, "investment-aggregate-states").length, 0);
});

test("hosted maximum active investment collection stays inside the shared request budget", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  await configureHostedInvestmentFixture(service);
  await seedHostedMaximumActiveInvestmentCollection(service);

  const readsBefore = service.readRequests;
  const response = await hostedPackageWorker(service).fetch(
    participantRequest(INVESTMENT_INTEREST_PATH),
    env,
    executionContext,
  );
  assert.equal(response.status, 200);
  const document = await response.json() as InvestmentInterestCollectionDocument;
  assert.equal(
    document.data.indications.length,
    MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS,
  );
  assert.ok(
    service.readRequests - readsBefore <=
      PARTICIPANT_REQUEST_STORAGE_READ_LIMIT,
  );
});

test("hosted investment state and mutation proofs remain participant-bound and non-disclosing", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  const packageVersionId = await configureHostedInvestmentFixture(service);
  const foreignSubject = "sites-foreign-investor";
  const foreignEmail = "foreign-investor@example.test";
  await registerHostedAcceptedInvestor(
    service,
    foreignSubject,
    foreignEmail,
    packageVersionId,
    "foreign",
  );

  const initial = await investmentResource(hostedPackageWorker(service), env);
  const createAction = requiredAction(
    initial.document,
    "create-personal-investment-interest",
  );
  const privateNote = "PRIVATE HOSTED INVESTMENT SENTINEL";
  const createResponse = await submitInvestmentMutation(
    hostedPackageWorker(service),
    env,
    initial,
    createAction,
    actionBody(createAction, {
      "operation-id": "investment-operation:hosted-private-create",
      "residence-country": "FI",
      amount: 25_000,
      "availability-period": "Within twelve months.",
      note: privateNote,
    }),
  );
  assert.equal(createResponse.status, 201);
  const itemPath = investmentItemPath(
    "investment-operation:hosted-private-create",
  );

  for (const request of [
    ownerRequest(itemPath),
    participantRequestFor(itemPath, foreignSubject, foreignEmail),
  ]) {
    const response = await hostedPackageWorker(service).fetch(
      request,
      env,
      executionContext,
    );
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), new RegExp(privateNote, "u"));
  }

  const editProof = await investmentResource(
    hostedPackageWorker(service),
    env,
    itemPath,
  );
  const editAction = requiredAction(editProof.document, "edit-investment-interest");
  const editBody = actionBody(editAction, {
    "operation-id": "investment-operation:hosted-proof-edit",
    "expected-revision": 1,
    note: "Proof failure private value.",
  });
  const missingCookie = await submitInvestmentMutation(
    hostedPackageWorker(service),
    env,
    editProof,
    editAction,
    editBody,
    { cookie: null },
  );
  assert.equal(missingCookie.status, 403);
  assert.doesNotMatch(await missingCookie.text(), /Proof failure private value/u);

  const originProof = await investmentResource(
    hostedPackageWorker(service),
    env,
    itemPath,
  );
  const crossOrigin = await submitInvestmentMutation(
    hostedPackageWorker(service),
    env,
    originProof,
    requiredAction(originProof.document, "edit-investment-interest"),
    editBody,
    { origin: "https://attacker.example.test" },
  );
  assert.equal(crossOrigin.status, 403);

  const unchanged = await investmentResource(
    hostedPackageWorker(service),
    env,
    itemPath,
  );
  assert.equal(unchanged.document.data.revision, 1);
  assert.equal(unchanged.document.data.history.length, 1);
  const disclosureProbe = JSON.stringify({
    owner: await (await hostedPackageWorker(service).fetch(
      ownerRequest(itemPath),
      env,
      executionContext,
    )).text(),
    foreign: await (await hostedPackageWorker(service).fetch(
      participantRequestFor(itemPath, foreignSubject, foreignEmail),
      env,
      executionContext,
    )).text(),
  });
  for (const secret of [
    privateNote,
    SERVICE_CLIENT_SECRET,
    ACCESS_TOKEN,
    MUTATION_KEY,
    SERVICE_CLIENT_ID,
    TRANSPORT_ORIGIN,
  ]) {
    assert.equal(disclosureProbe.includes(secret), false);
  }
});

test("hosted participant registration persists policy-bound submissions across retries and restarts", async () => {
  const service = new SyntheticAittaDBService();
  const setup = explicitCampaignSetup();
  await new StorageCampaignRepository(hostedStorageAdapter(service)).saveSetup({
    operationId: "campaign-operation:registration-policy",
    recordedAt: "2026-08-10T09:00:00.000Z",
    expectedRevision: null,
    setup: {
      ...setup,
      campaignPolicy: {
        ...setup.campaignPolicy,
        notices: {
          ...setup.campaignPolicy.notices,
          legalBoundary: PRIVATE_POLICY_SENTINEL,
          processEmail: "Persisted process notice for registration.",
          marketingConsent: "Persisted optional marketing notice.",
        },
      },
    },
  });
  const env = configuredEnvironment({ OWNER_EMAIL });
  let clockTick = 0;
  const worker = hostedPackageWorker(
    service,
    () => new Date(NOW.valueOf() + clockTick++),
  );

  const anonymousReads = service.readRequests;
  const anonymous = await worker.fetch(
    new Request(`${APP_ORIGIN}${PARTICIPANT_REGISTRATION_PATH}`, {
      headers: { accept: "application/json" },
    }),
    env,
    executionContext,
  );
  assert.equal(anonymous.status, 404);
  assert.equal(service.readRequests, anonymousReads + 1);

  const ownerReads = service.readRequests;
  const owner = await worker.fetch(
    ownerRequest(PARTICIPANT_REGISTRATION_PATH),
    env,
    executionContext,
  );
  assert.equal(owner.status, 404);
  assert.equal(service.readRequests, ownerReads + 1);
  assert.doesNotMatch(await owner.text(), /Persisted process|PRIVATE CAMPAIGN/u);

  const [first, retry, exactJson, changed, malformed] = await Promise.all([
    participantRegistration(worker, env),
    participantRegistration(worker, env),
    participantRegistration(worker, env),
    participantRegistration(worker, env),
    participantRegistration(worker, env),
  ]);
  for (const resource of [first, retry, exactJson, changed, malformed]) {
    assert.equal(resource.document.data.status, "registration_required");
    assert.equal(
      resource.document.data.process_email_notice,
      "Persisted process notice for registration.",
    );
    assert.equal(
      resource.document.data.marketing_notice,
      "Persisted optional marketing notice.",
    );
    assert.doesNotMatch(
      JSON.stringify(resource.document),
      new RegExp(PRIVATE_POLICY_SENTINEL, "u"),
    );
  }
  const action = requiredAction(
    first.document,
    "register-participant-access",
  );
  const body = actionBody(action, {
    "display-name": "Hosted participant",
    country: "FI",
    "declared-interest": "investor",
    "participation-context": "individual",
    "process-email-notice-acknowledged": true,
    "marketing-consent": false,
  });
  assert.notEqual(
    parseParticipantRegistrationOperationId(body["operation-id"]),
    null,
  );
  const retryAction = requiredAction(
    retry.document,
    "register-participant-access",
  );
  const retryBody = actionBody(retryAction, {
    ...body,
    "operation-id": body["operation-id"],
  });

  const replayClaimsBeforeMalformed = recordsIn(
    service,
    "browser-mutation-replays",
  ).length;
  const malformedResponse = await submitRegistration(
    worker,
    env,
    malformed,
    actionBody(
      requiredAction(malformed.document, "register-participant-access"),
      {
        ...body,
        "operation-id": "alice@example.test private retry label",
      },
    ),
  );
  assert.equal(malformedResponse.status, 400);
  assert.doesNotMatch(
    await malformedResponse.text(),
    /alice@example|private|retry label/iu,
  );
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    replayClaimsBeforeMalformed,
  );
  assert.equal(await hostedParticipantRepository(service).current(), null);

  const missingProof = await submitRegistration(
    worker,
    env,
    first,
    body,
    { cookie: null },
  );
  assert.equal(missingProof.status, 403);
  assert.equal(await hostedParticipantRepository(service).current(), null);

  const foreignOrigin = await submitRegistration(
    worker,
    env,
    first,
    body,
    { origin: "https://foreign.example.test" },
  );
  assert.equal(foreignOrigin.status, 403);
  assert.equal(await hostedParticipantRepository(service).current(), null);

  const created = await submitRegistration(worker, env, first, body);
  assert.equal(created.status, 201);
  assert.match(created.headers.get("set-cookie") ?? "", /Max-Age=0/u);
  const createdDocument = await created.json() as ParticipantRegistrationDocument;
  assert.equal(createdDocument.data.status, "registered");
  assert.deepEqual(actionNames(createdDocument), []);
  assert.equal(
    recordsIn(service, "participant-investment-ownership-roots").length,
    1,
  );
  assert.equal(recordsIn(service, "participant-investment-indexes").length, 1);
  assert.equal(
    recordsIn(service, "investment-indication-ownership-witnesses").length,
    1,
  );

  await new StorageCampaignRepository(hostedStorageAdapter(service)).saveSetup({
    operationId: "campaign-operation:registration-policy-update",
    recordedAt: "2026-08-10T09:30:00.000Z",
    expectedRevision: 1,
    setup: {
      ...setup,
      campaignPolicy: {
        ...setup.campaignPolicy,
        notices: {
          ...setup.campaignPolicy.notices,
          processEmail: "Updated process notice after registration.",
          marketingConsent: "Updated marketing notice after registration.",
        },
      },
    },
  });
  const restarted = hostedPackageWorker(service);
  const htmlRetry = await submitRegistration(
    restarted,
    env,
    retry,
    retryBody,
    { accept: "text/html" },
  );
  assert.equal(htmlRetry.status, 200);
  assert.match(htmlRetry.headers.get("set-cookie") ?? "", /Max-Age=0/u);
  const retryHtml = await htmlRetry.text();
  assert.match(retryHtml, /Registration complete/u);
  assert.match(retryHtml, /Process notice acknowledged<\/dt><dd>Yes/u);
  assert.match(retryHtml, /Persisted process notice for registration/u);
  assert.match(retryHtml, /Persisted optional marketing notice/u);
  assert.doesNotMatch(
    retryHtml,
    /Updated process notice|Updated marketing notice|<form\b|name="_csrf"/u,
  );

  const exactJsonAction = requiredAction(
    exactJson.document,
    "register-participant-access",
  );
  const exactJsonResponse = await submitRegistration(
    restarted,
    env,
    exactJson,
    actionBody(exactJsonAction, {
      ...body,
      "operation-id": body["operation-id"],
    }),
  );
  assert.equal(exactJsonResponse.status, 200);
  const exactJsonDocument =
    await exactJsonResponse.json() as ParticipantRegistrationDocument;
  assert.equal(
    exactJsonDocument.data.notice_evidence_version,
    createdDocument.data.notice_evidence_version,
  );
  assert.equal(
    exactJsonDocument.data.process_email_notice,
    "Persisted process notice for registration.",
  );
  assert.equal(
    exactJsonDocument.data.process_email_notice_acknowledged,
    true,
  );

  const changedAction = requiredAction(
    changed.document,
    "register-participant-access",
  );
  const duplicate = await submitRegistration(
    restarted,
    env,
    changed,
    actionBody(changedAction, {
      ...body,
      "operation-id": body["operation-id"],
      "display-name": "Changed duplicate",
    }),
  );
  assert.equal(duplicate.status, 409);
  assert.doesNotMatch(await duplicate.text(), /Hosted participant|Changed duplicate/u);
  assert.equal(
    recordsIn(service, "participant-investment-ownership-roots").length,
    1,
  );

  const persisted = await participantRegistration(restarted, env);
  assert.equal(persisted.document.data.status, "registered");
  assert.equal(persisted.document.data.display_name, "Hosted participant");
  assert.equal(
    persisted.document.data.process_email_notice,
    "Persisted process notice for registration.",
  );
  assert.equal(
    persisted.document.data.marketing_notice,
    "Persisted optional marketing notice.",
  );
  assert.equal(
    persisted.document.data.notice_evidence_version,
    createdDocument.data.notice_evidence_version,
  );
  assert.equal(persisted.document.data.process_email_notice_acknowledged, true);
  assert.equal(persisted.csrfToken, null);
  assert.equal(persisted.cookie, null);
  assert.deepEqual(actionNames(persisted.document), []);

  const foreign = await participantRegistrationFor(
    restarted,
    env,
    "sites-foreign-participant",
    "foreign@example.test",
  );
  assert.equal(foreign.document.data.status, "registration_required");
  assert.equal(foreign.document.data.display_name, null);
  assert.equal(
    foreign.document.data.process_email_notice,
    "Updated process notice after registration.",
  );
  assert.notEqual(
    foreign.document.data.notice_evidence_version,
    persisted.document.data.notice_evidence_version,
  );
  assert.doesNotMatch(
    JSON.stringify(foreign.document),
    /Hosted participant|PRIVATE CAMPAIGN POLICY/u,
  );

  const disclosureProbe = JSON.stringify({
    created: createdDocument,
    persisted: persisted.document,
    foreign: foreign.document,
  });
  for (const privateValue of [
    SERVICE_CLIENT_SECRET,
    ACCESS_TOKEN,
    MUTATION_KEY,
    PRIVATE_POLICY_SENTINEL,
  ]) {
    assert.doesNotMatch(disclosureProbe, new RegExp(privateValue, "u"));
  }
});

test("hosted participant profile self-service persists bounded actions across retries and restarts", async () => {
  const service = new SyntheticAittaDBService();
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Hosted profile participant",
    "participant-operation:profile-self-service",
    { marketingConsent: true },
  );
  await registerHostedParticipant(
    service,
    "sites-foreign-participant",
    "foreign@example.test",
    "Foreign private profile",
    "participant-operation:profile-foreign",
  );
  await registerHostedParticipant(
    service,
    OWNER.subject,
    OWNER_EMAIL,
    "Owner private profile",
    "participant-operation:profile-owner",
  );
  const env = configuredEnvironment({ OWNER_EMAIL });
  let clockTick = 0;
  const worker = hostedPackageWorker(
    service,
    () => new Date(NOW.valueOf() + clockTick++ * 1_000),
  );

  const anonymousReads = service.readRequests;
  const anonymous = await worker.fetch(
    new Request(`${APP_ORIGIN}${PARTICIPANT_PROFILE_PATH}`, {
      headers: { accept: "application/json" },
    }),
    env,
    executionContext,
  );
  assert.equal(anonymous.status, 404);
  assert.equal(service.readRequests, anonymousReads + 1);

  const ownerReads = service.readRequests;
  const owner = await worker.fetch(
    ownerRequest(PARTICIPANT_PROFILE_PATH),
    env,
    executionContext,
  );
  assert.equal(owner.status, 404);
  assert.equal(service.readRequests, ownerReads + 1);
  assert.doesNotMatch(await owner.text(), /Owner private profile/u);

  const profileReads = service.readRequests;
  const first = await participantProfile(worker, env);
  assert.equal(service.readRequests, profileReads + 9);
  assert.equal(first.document.data.revision, 1);
  assert.equal(first.document.data.display_name, "Hosted profile participant");
  assert.equal(first.document.data.account_email, PARTICIPANT_EMAIL);
  assert.equal(first.document.data.marketing_consent_state, "granted");
  assert.equal(first.document.data.account_deletion_state, "not-requested");
  assert.deepEqual(actionNames(first.document), [
    "update-participant-profile",
    "withdraw-marketing-consent",
    "request-account-deletion",
  ]);

  const html = await worker.fetch(
    new Request(`${APP_ORIGIN}${PARTICIPANT_PROFILE_PATH}`, {
      headers: {
        accept: "text/html",
        "oai-authenticated-user-id": PARTICIPANT_SUBJECT,
        "oai-authenticated-user-email": PARTICIPANT_EMAIL,
      },
    }),
    env,
    executionContext,
  );
  assert.equal(html.status, 200);
  assert.match(html.headers.get("set-cookie") ?? "", /HttpOnly/u);
  const htmlBody = await html.text();
  assert.match(htmlBody, /<h1>Your profile<\/h1>/u);
  assert.match(htmlBody, /data-action-name="update-participant-profile"/u);
  assert.doesNotMatch(
    htmlBody,
    /application-service-client-secret|synthetic-access-token|storage-runtime/iu,
  );

  const [retry, changed, stale] = await Promise.all([
    participantProfile(worker, env),
    participantProfile(worker, env),
    participantProfile(worker, env),
  ]);
  const updateAction = requiredAction(first.document, "update-participant-profile");
  const updateBody = actionBody(updateAction, {
    "display-name": "Updated hosted participant",
    country: "SE",
    "declared-interest": "both",
    "participation-context": "company",
  });
  const retryBody = actionBody(
    requiredAction(retry.document, "update-participant-profile"),
    {
      ...updateBody,
      "operation-id": updateBody["operation-id"],
    },
  );
  const updateResponses = await Promise.all([
    submitProfile(worker, env, first, updateAction, updateBody),
    submitProfile(
      worker,
      env,
      retry,
      requiredAction(retry.document, "update-participant-profile"),
      retryBody,
    ),
  ]);
  assert.deepEqual(updateResponses.map(({ status }) => status), [200, 200]);
  for (const [index, response] of updateResponses.entries()) {
    assertProfileMutationCookieLifecycle(
      response,
      true,
      [first, retry][index]?.cookie ?? null,
    );
    const document = await response.json() as ParticipantProfileDocument;
    assert.equal(document.data.revision, 2);
    assert.equal(document.data.display_name, "Updated hosted participant");
  }

  const persistedUpdate = await hostedParticipantRepository(service).current();
  assert(persistedUpdate);
  assert.equal(persistedUpdate.revision, 2);
  assert.equal(persistedUpdate.snapshot.subject, PARTICIPANT_SUBJECT);
  assert.equal(persistedUpdate.snapshot.accountEmailLabel, PARTICIPANT_EMAIL);
  assert.equal(
    persistedUpdate.snapshot.processEmailNoticeAcknowledgedAt,
    "2026-08-10T10:00:00.000Z",
  );
  assert.equal(persistedUpdate.snapshot.registeredAt, "2026-08-10T10:00:00.000Z");
  const committedUpdateTimestamp = persistedUpdate.snapshot.updatedAt;

  const changedAction = requiredAction(
    changed.document,
    "update-participant-profile",
  );
  const changedResponse = await submitProfile(
    worker,
    env,
    changed,
    changedAction,
    actionBody(changedAction, {
      ...updateBody,
      "operation-id": updateBody["operation-id"],
      "display-name": "PRIVATE CHANGED RETRY VALUE",
    }),
  );
  assert.equal(changedResponse.status, 409);
  assertProfileMutationCookieLifecycle(changedResponse, false, changed.cookie);
  assert.doesNotMatch(
    await changedResponse.text(),
    /PRIVATE CHANGED RETRY VALUE|Hosted profile participant/u,
  );

  const staleAction = requiredAction(stale.document, "update-participant-profile");
  const staleResponse = await submitProfile(
    worker,
    env,
    stale,
    staleAction,
    actionBody(staleAction, {
      ...updateBody,
      "operation-id": "participant-profile-operation:hosted-stale",
    }),
  );
  assert.equal(staleResponse.status, 412);
  assertProfileMutationCookieLifecycle(staleResponse, false, stale.cookie);
  assert.doesNotMatch(await staleResponse.text(), /Updated hosted participant/u);

  const restartEpoch = Date.parse("2026-08-11T12:00:00.000Z");
  const restarted = hostedPackageWorker(service, () => new Date(restartEpoch));
  const afterUpdate = await participantProfile(restarted, env);
  assert.equal(afterUpdate.document.data.revision, 2);
  assert.equal(afterUpdate.document.data.display_name, "Updated hosted participant");

  const withdrawalRetry = await participantProfile(restarted, env);
  const withdrawalAction = requiredAction(
    afterUpdate.document,
    "withdraw-marketing-consent",
  );
  const withdrawalBody = actionBody(withdrawalAction, {
    "confirm-marketing-consent-withdrawal": true,
  });
  const withdrawalRetryAction = requiredAction(
    withdrawalRetry.document,
    "withdraw-marketing-consent",
  );
  const withdrawalResponses = await Promise.all([
    submitProfileForm(
      restarted,
      env,
      afterUpdate,
      withdrawalAction,
      withdrawalBody,
    ),
    submitProfile(
      restarted,
      env,
      withdrawalRetry,
      withdrawalRetryAction,
      actionBody(withdrawalRetryAction, {
        ...withdrawalBody,
        "operation-id": withdrawalBody["operation-id"],
      }),
    ),
  ]);
  assert.deepEqual(
    withdrawalResponses.map(({ status }) => status),
    [200, 200],
    JSON.stringify({
      withdrawalBody,
      withdrawalRetryAction,
      responses: await Promise.all(
        withdrawalResponses.map((response) => response.clone().text()),
      ),
    }),
  );
  assert.match(
    withdrawalResponses[0]?.headers.get("content-type") ?? "",
    /^text\/html/iu,
  );
  const withdrawalHtml = await withdrawalResponses[0]!.clone().text();
  assert.match(withdrawalHtml, /<h1>Your profile<\/h1>/u);
  assert.match(
    withdrawalHtml,
    /<dt>Profile revision<\/dt>\s*<dd>3<\/dd>/u,
  );
  assert.deepEqual(profileHtmlActionNames(withdrawalHtml), [
    "update-participant-profile",
    "request-account-deletion",
  ]);
  const withdrawalJson = await withdrawalResponses[1]!.clone().json() as
    ParticipantProfileDocument;
  assert.equal(withdrawalJson.data.revision, 3);
  assert.equal(withdrawalJson.data.marketing_consent_state, "withdrawn");
  assert.deepEqual(actionNames(withdrawalJson), [
    "update-participant-profile",
    "request-account-deletion",
  ]);
  for (const [index, response] of withdrawalResponses.entries()) {
    assertProfileMutationCookieLifecycle(
      response,
      true,
      [afterUpdate, withdrawalRetry][index]?.cookie ?? null,
    );
  }
  const afterWithdrawal = await participantProfile(
    hostedPackageWorker(service, () => new Date(restartEpoch + 60_000)),
    env,
  );
  assert.equal(afterWithdrawal.document.data.revision, 3);
  assert.equal(afterWithdrawal.document.data.marketing_consent_state, "withdrawn");
  assert.deepEqual(actionNames(afterWithdrawal.document), [
    "update-participant-profile",
    "request-account-deletion",
  ]);

  const delayedHtmlProofReads = service.readRequests;
  const delayedAfterWithdrawalHtmlProof = await participantProfile(
    hostedPackageWorker(service, () => new Date(restartEpoch + 60_000)),
    env,
  );
  assert.equal(service.readRequests, delayedHtmlProofReads + 12);

  const delayedJsonReads = service.readRequests;
  const delayedAfterWithdrawalResponse = await submitProfile(
    hostedPackageWorker(service, () => new Date(restartEpoch + 60_000)),
    env,
    afterWithdrawal,
    requiredAction(afterWithdrawal.document, "update-participant-profile"),
    updateBody,
  );
  assert.equal(delayedAfterWithdrawalResponse.status, 200);
  assert.equal(service.readRequests, delayedJsonReads + 22);
  assertProfileMutationCookieLifecycle(
    delayedAfterWithdrawalResponse,
    true,
    afterWithdrawal.cookie,
  );
  assert.notEqual(
    delayedAfterWithdrawalResponse.headers.get(MUTATION_CSRF_HEADER),
    null,
  );
  const delayedAfterWithdrawal = await delayedAfterWithdrawalResponse.json() as
    ParticipantProfileDocument;
  assert.equal(delayedAfterWithdrawal.data.revision, 3);
  assert.equal(delayedAfterWithdrawal.data.marketing_consent_state, "withdrawn");
  assert.deepEqual(actionNames(delayedAfterWithdrawal), [
    "update-participant-profile",
    "request-account-deletion",
  ]);

  const delayedHtmlReads = service.readRequests;
  const delayedAfterWithdrawalHtmlResponse = await submitProfileForm(
    hostedPackageWorker(service, () => new Date(restartEpoch + 60_000)),
    env,
    delayedAfterWithdrawalHtmlProof,
    requiredAction(
      delayedAfterWithdrawalHtmlProof.document,
      "update-participant-profile",
    ),
    updateBody,
  );
  assert.equal(delayedAfterWithdrawalHtmlResponse.status, 200);
  assert.equal(service.readRequests, delayedHtmlReads + 22);
  assertProfileMutationCookieLifecycle(
    delayedAfterWithdrawalHtmlResponse,
    true,
    delayedAfterWithdrawalHtmlProof.cookie,
  );
  assert.equal(
    delayedAfterWithdrawalHtmlResponse.headers.get(MUTATION_CSRF_HEADER),
    null,
  );
  const delayedAfterWithdrawalHtml =
    await delayedAfterWithdrawalHtmlResponse.text();
  assert.match(
    delayedAfterWithdrawalHtml,
    /<dt>Profile revision<\/dt>\s*<dd>3<\/dd>/u,
  );
  assert.deepEqual(
    profileHtmlActionNames(delayedAfterWithdrawalHtml),
    actionNames(delayedAfterWithdrawal),
  );
  const delayedAfterWithdrawalHtmlTokens = profileHtmlCsrfTokens(
    delayedAfterWithdrawalHtml,
  );
  assert.equal(delayedAfterWithdrawalHtmlTokens.length, 2);
  assert.equal(new Set(delayedAfterWithdrawalHtmlTokens).size, 1);
  assert.ok(delayedAfterWithdrawalHtmlTokens[0]?.length);
  const historicalUpdate = await hostedParticipantRepository(service).revision(2);
  assert(historicalUpdate);
  assert.equal(historicalUpdate.snapshot.updatedAt, committedUpdateTimestamp);

  const deletionDiscoveryWorker = hostedPackageWorker(
    service,
    () => new Date(restartEpoch + 60_000),
  );
  const [
    deletionFirst,
    deletionRetry,
    delayedAfterDeletionProof,
    delayedAfterDeletionHtmlProof,
  ] =
    await Promise.all([
      participantProfile(deletionDiscoveryWorker, env),
      participantProfile(deletionDiscoveryWorker, env),
      participantProfile(deletionDiscoveryWorker, env),
      participantProfile(deletionDiscoveryWorker, env),
    ]);
  const deletionAction = requiredAction(
    deletionFirst.document,
    "request-account-deletion",
  );
  const deletionBody = actionBody(deletionAction, {
    "confirm-account-deletion-request": true,
  });
  const deletionRetryAction = requiredAction(
    deletionRetry.document,
    "request-account-deletion",
  );
  const deletionWorker = hostedPackageWorker(
    service,
    () => new Date(restartEpoch + 120_000),
  );
  const deletionResponses = await Promise.all([
    submitProfile(
      deletionWorker,
      env,
      deletionFirst,
      deletionAction,
      deletionBody,
    ),
    submitProfile(
      deletionWorker,
      env,
      deletionRetry,
      deletionRetryAction,
      actionBody(deletionRetryAction, {
        ...deletionBody,
        "operation-id": deletionBody["operation-id"],
      }),
    ),
  ]);
  assert.deepEqual(deletionResponses.map(({ status }) => status), [200, 200]);
  for (const [index, response] of deletionResponses.entries()) {
    assertProfileMutationCookieLifecycle(
      response,
      false,
      [deletionFirst, deletionRetry][index]?.cookie ?? null,
    );
  }

  const participantRecordsBeforeClosedReplay = JSON.stringify([
    ...recordsIn(service, "participant-profiles"),
    ...recordsIn(service, "participant-profile-revisions"),
  ]);
  const delayedTerminalJsonReads = service.readRequests;
  const delayedAfterDeletionResponse = await submitProfile(
    deletionWorker,
    env,
    delayedAfterDeletionProof,
    requiredAction(
      delayedAfterDeletionProof.document,
      "update-participant-profile",
    ),
    updateBody,
  );
  assert.equal(delayedAfterDeletionResponse.status, 200);
  assert.equal(service.readRequests, delayedTerminalJsonReads + 22);
  assert.equal(
    delayedAfterDeletionResponse.headers.get(MUTATION_CSRF_HEADER),
    null,
  );
  assertProfileMutationCookieLifecycle(
    delayedAfterDeletionResponse,
    false,
    delayedAfterDeletionProof.cookie,
  );
  const delayedAfterDeletion = await delayedAfterDeletionResponse.json() as
    ParticipantProfileDocument;
  assert.equal(delayedAfterDeletion.data.revision, 4);
  assert.equal(delayedAfterDeletion.data.account_deletion_state, "requested");
  assert.equal(delayedAfterDeletion.data.marketing_consent_state, "withdrawn");
  assert.deepEqual(actionNames(delayedAfterDeletion), []);

  const delayedTerminalHtmlReads = service.readRequests;
  const delayedAfterDeletionHtmlResponse = await submitProfileForm(
    deletionWorker,
    env,
    delayedAfterDeletionHtmlProof,
    requiredAction(
      delayedAfterDeletionHtmlProof.document,
      "update-participant-profile",
    ),
    updateBody,
  );
  assert.equal(delayedAfterDeletionHtmlResponse.status, 200);
  assert.equal(service.readRequests, delayedTerminalHtmlReads + 22);
  assert.equal(
    delayedAfterDeletionHtmlResponse.headers.get(MUTATION_CSRF_HEADER),
    null,
  );
  assertProfileMutationCookieLifecycle(
    delayedAfterDeletionHtmlResponse,
    false,
    delayedAfterDeletionHtmlProof.cookie,
  );
  const delayedAfterDeletionHtml = await delayedAfterDeletionHtmlResponse.text();
  assert.match(
    delayedAfterDeletionHtml,
    /<dt>Profile revision<\/dt>\s*<dd>4<\/dd>/u,
  );
  assert.deepEqual(profileHtmlActionNames(delayedAfterDeletionHtml), []);
  assert.deepEqual(profileHtmlCsrfTokens(delayedAfterDeletionHtml), []);
  assert.equal(
    JSON.stringify([
      ...recordsIn(service, "participant-profiles"),
      ...recordsIn(service, "participant-profile-revisions"),
    ]),
    participantRecordsBeforeClosedReplay,
  );
  assert.equal(
    (await hostedParticipantRepository(service).revision(2))?.snapshot.updatedAt,
    committedUpdateTimestamp,
  );

  const finalWorker = hostedPackageWorker(
    service,
    () => new Date(restartEpoch + 180_000),
  );
  const final = await participantProfile(finalWorker, env);
  assert.equal(final.document.data.revision, 4);
  assert.equal(final.document.data.account_deletion_state, "requested");
  assert.equal(final.document.data.marketing_consent_state, "withdrawn");
  assert.deepEqual(actionNames(final.document), []);
  assert.equal(final.csrfToken, null);
  assert.equal(final.cookie, null);
  const deletionIntent = await hostedParticipantRepository(service)
    .pendingDeletionIntent();
  assert.deepEqual(deletionIntent, {
    type: "withdraw-active-interest",
    subject: PARTICIPANT_SUBJECT,
    reason: "account-deletion-request",
    requestedAt: final.document.data.account_deletion_requested_at,
  });

  const foreign = await participantProfileFor(
    finalWorker,
    env,
    "sites-foreign-participant",
    "foreign@example.test",
  );
  assert.equal(foreign.document.data.display_name, "Foreign private profile");
  assert.doesNotMatch(
    JSON.stringify(foreign.document),
    /Updated hosted participant|Hosted profile participant/u,
  );

  const disclosureProbe = JSON.stringify({
    first: first.document,
    final: final.document,
    foreign: foreign.document,
  });
  for (const privateValue of [
    SERVICE_CLIENT_SECRET,
    ACCESS_TOKEN,
    MUTATION_KEY,
    TRANSPORT_ORIGIN,
    PRIVATE_POLICY_SENTINEL,
  ]) {
    assert.doesNotMatch(disclosureProbe, new RegExp(privateValue, "u"));
  }
});

test("hosted delayed profile replays reject impossible consent ancestry and preserve valid withdrawal replay", async () => {
  const env = configuredEnvironment({ OWNER_EMAIL });
  const impossibleService = new SyntheticAittaDBService();
  await registerHostedParticipant(
    impossibleService,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "No-consent hosted participant",
    "participant-operation:no-consent-hosted-register",
    { marketingConsent: false },
  );
  const impossibleEpoch = Date.parse("2026-08-12T12:00:00.000Z");
  const impossibleWorker = hostedPackageWorker(
    impossibleService,
    () => new Date(impossibleEpoch),
  );
  const impossibleProofReads = impossibleService.readRequests;
  const [commitUpdateProof, impossibleJsonProof, impossibleHtmlProof] =
    await Promise.all([
      participantProfile(impossibleWorker, env),
      participantProfile(impossibleWorker, env),
      participantProfile(impossibleWorker, env),
    ]);
  assert.equal(impossibleService.readRequests, impossibleProofReads + 27);
  for (const proof of [
    commitUpdateProof,
    impossibleJsonProof,
    impossibleHtmlProof,
  ]) {
    assert.equal(proof.document.data.revision, 1);
    assert.equal(proof.document.data.marketing_consent_state, "not-granted");
    assert.deepEqual(actionNames(proof.document), [
      "update-participant-profile",
      "request-account-deletion",
    ]);
  }

  const commitUpdateAction = requiredAction(
    commitUpdateProof.document,
    "update-participant-profile",
  );
  const commitUpdateBody = actionBody(commitUpdateAction, {
    "display-name": "Updated no-consent participant",
    country: "SE",
    "declared-interest": "both",
    "participation-context": "company",
  });
  const commitUpdateResponse = await submitProfile(
    impossibleWorker,
    env,
    commitUpdateProof,
    commitUpdateAction,
    commitUpdateBody,
  );
  assert.equal(commitUpdateResponse.status, 200);
  assertProfileMutationCookieLifecycle(
    commitUpdateResponse,
    true,
    commitUpdateProof.cookie,
  );
  const committedUpdate = await commitUpdateResponse.json() as
    ParticipantProfileDocument;
  assert.equal(committedUpdate.data.revision, 2);
  assert.equal(committedUpdate.data.marketing_consent_state, "not-granted");

  const impossibleRepository = hostedParticipantRepository(impossibleService);
  const impossibleWithdrawal = await impossibleRepository
    .withdrawMarketingConsent({
      operationId: "participant-operation:impossible-hosted-withdrawal",
      expectedRevision: 2,
      withdrawnAt: "2026-08-12T12:01:00.000Z",
    });
  assert.equal(impossibleWithdrawal.revision, 3);
  assert.equal(impossibleWithdrawal.snapshot.subject, PARTICIPANT_SUBJECT);
  assert.equal(
    impossibleWithdrawal.snapshot.accountEmailLabel,
    PARTICIPANT_EMAIL,
  );
  assert.deepEqual(impossibleWithdrawal.snapshot.marketingConsent, {
    state: "withdrawn",
    withdrawnAt: "2026-08-12T12:01:00.000Z",
  });

  const impossibleProfileRecords = JSON.stringify([
    ...recordsIn(impossibleService, "private-participant-profiles"),
    ...recordsIn(impossibleService, "private-participant-profile-revisions"),
  ]);
  const impossibleReplayWorker = hostedPackageWorker(
    impossibleService,
    () => new Date(impossibleEpoch + 120_000),
  );
  const impossibleJsonReads = impossibleService.readRequests;
  const impossibleJsonResponse = await submitProfile(
    impossibleReplayWorker,
    env,
    impossibleJsonProof,
    requiredAction(
      impossibleJsonProof.document,
      "update-participant-profile",
    ),
    commitUpdateBody,
  );
  assert.equal(impossibleJsonResponse.status, 503);
  assert.equal(impossibleService.readRequests, impossibleJsonReads + 22);
  assert.equal(impossibleJsonResponse.headers.get(MUTATION_CSRF_HEADER), null);
  assertProfileMutationCookieLifecycle(
    impossibleJsonResponse,
    false,
    impossibleJsonProof.cookie,
  );
  const impossibleJson = await impossibleJsonResponse.text();
  assert.doesNotMatch(
    impossibleJson,
    /No-consent hosted participant|Updated no-consent participant|participant@example\.test|sites-participant-subject|2026-08-12T12:01:00\.000Z/u,
  );

  const impossibleHtmlReads = impossibleService.readRequests;
  const impossibleHtmlResponse = await submitProfileForm(
    impossibleReplayWorker,
    env,
    impossibleHtmlProof,
    requiredAction(
      impossibleHtmlProof.document,
      "update-participant-profile",
    ),
    commitUpdateBody,
  );
  assert.equal(impossibleHtmlResponse.status, 503);
  assert.equal(impossibleService.readRequests, impossibleHtmlReads + 22);
  assert.equal(impossibleHtmlResponse.headers.get(MUTATION_CSRF_HEADER), null);
  assertProfileMutationCookieLifecycle(
    impossibleHtmlResponse,
    false,
    impossibleHtmlProof.cookie,
  );
  const impossibleHtml = await impossibleHtmlResponse.text();
  assert.deepEqual(profileHtmlActionNames(impossibleHtml), []);
  assert.deepEqual(profileHtmlCsrfTokens(impossibleHtml), []);
  assert.doesNotMatch(
    impossibleHtml,
    /No-consent hosted participant|Updated no-consent participant|participant@example\.test|sites-participant-subject|2026-08-12T12:01:00\.000Z/u,
  );
  assert.equal(
    JSON.stringify([
      ...recordsIn(impossibleService, "private-participant-profiles"),
      ...recordsIn(impossibleService, "private-participant-profile-revisions"),
    ]),
    impossibleProfileRecords,
  );

  const validService = new SyntheticAittaDBService();
  await registerHostedParticipant(
    validService,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Granted hosted participant",
    "participant-operation:granted-hosted-register",
    { marketingConsent: true },
  );
  const validEpoch = Date.parse("2026-08-13T12:00:00.000Z");
  const validWorker = hostedPackageWorker(
    validService,
    () => new Date(validEpoch),
  );
  const validProofReads = validService.readRequests;
  const [commitWithdrawalProof, validJsonProof, validHtmlProof] =
    await Promise.all([
      participantProfile(validWorker, env),
      participantProfile(validWorker, env),
      participantProfile(validWorker, env),
    ]);
  assert.equal(validService.readRequests, validProofReads + 27);
  for (const proof of [
    commitWithdrawalProof,
    validJsonProof,
    validHtmlProof,
  ]) {
    assert.equal(proof.document.data.revision, 1);
    assert.equal(proof.document.data.marketing_consent_state, "granted");
    assert.deepEqual(actionNames(proof.document), [
      "update-participant-profile",
      "withdraw-marketing-consent",
      "request-account-deletion",
    ]);
  }

  const commitWithdrawalAction = requiredAction(
    commitWithdrawalProof.document,
    "withdraw-marketing-consent",
  );
  const commitWithdrawalBody = actionBody(commitWithdrawalAction, {
    "confirm-marketing-consent-withdrawal": true,
  });
  const commitWithdrawalResponse = await submitProfile(
    validWorker,
    env,
    commitWithdrawalProof,
    commitWithdrawalAction,
    commitWithdrawalBody,
  );
  assert.equal(commitWithdrawalResponse.status, 200);
  assertProfileMutationCookieLifecycle(
    commitWithdrawalResponse,
    true,
    commitWithdrawalProof.cookie,
  );
  const committedWithdrawal = await commitWithdrawalResponse.json() as
    ParticipantProfileDocument;
  assert.equal(committedWithdrawal.data.revision, 2);
  assert.equal(committedWithdrawal.data.marketing_consent_state, "withdrawn");
  assert.deepEqual(actionNames(committedWithdrawal), [
    "update-participant-profile",
    "request-account-deletion",
  ]);

  const validRepository = hostedParticipantRepository(validService);
  const validLatest = await validRepository.update({
    operationId: "participant-operation:valid-hosted-intervening-update",
    expectedRevision: 2,
    updatedAt: "2026-08-13T12:01:00.000Z",
    changes: { displayName: "Latest valid withdrawn participant" },
  });
  assert.equal(validLatest.revision, 3);
  assert.equal(validLatest.snapshot.subject, PARTICIPANT_SUBJECT);
  assert.equal(validLatest.snapshot.accountEmailLabel, PARTICIPANT_EMAIL);
  assert.equal(validLatest.snapshot.marketingConsent.state, "withdrawn");

  const validProfileRecords = JSON.stringify([
    ...recordsIn(validService, "private-participant-profiles"),
    ...recordsIn(validService, "private-participant-profile-revisions"),
  ]);
  const validReplayWorker = hostedPackageWorker(
    validService,
    () => new Date(validEpoch + 120_000),
  );
  const validJsonReads = validService.readRequests;
  const validJsonResponse = await submitProfile(
    validReplayWorker,
    env,
    validJsonProof,
    requiredAction(validJsonProof.document, "withdraw-marketing-consent"),
    commitWithdrawalBody,
  );
  assert.equal(validJsonResponse.status, 200);
  assert.equal(validService.readRequests, validJsonReads + 22);
  assert.notEqual(validJsonResponse.headers.get(MUTATION_CSRF_HEADER), null);
  assertProfileMutationCookieLifecycle(
    validJsonResponse,
    true,
    validJsonProof.cookie,
  );
  const validJson = await validJsonResponse.json() as ParticipantProfileDocument;
  assert.equal(validJson.data.revision, 3);
  assert.equal(validJson.data.display_name, "Latest valid withdrawn participant");
  assert.equal(validJson.data.marketing_consent_state, "withdrawn");
  assert.deepEqual(actionNames(validJson), [
    "update-participant-profile",
    "request-account-deletion",
  ]);

  const validHtmlReads = validService.readRequests;
  const validHtmlResponse = await submitProfileForm(
    validReplayWorker,
    env,
    validHtmlProof,
    requiredAction(validHtmlProof.document, "withdraw-marketing-consent"),
    commitWithdrawalBody,
  );
  assert.equal(validHtmlResponse.status, 200);
  assert.equal(validService.readRequests, validHtmlReads + 22);
  assert.equal(validHtmlResponse.headers.get(MUTATION_CSRF_HEADER), null);
  assertProfileMutationCookieLifecycle(
    validHtmlResponse,
    true,
    validHtmlProof.cookie,
  );
  const validHtml = await validHtmlResponse.text();
  assert.match(validHtml, /Latest valid withdrawn participant/u);
  assert.match(validHtml, /<dt>Profile revision<\/dt>\s*<dd>3<\/dd>/u);
  assert.deepEqual(profileHtmlActionNames(validHtml), actionNames(validJson));
  const validHtmlTokens = profileHtmlCsrfTokens(validHtml);
  assert.equal(validHtmlTokens.length, 2);
  assert.equal(new Set(validHtmlTokens).size, 1);
  assert.ok(validHtmlTokens[0]?.length);
  assert.equal(
    JSON.stringify([
      ...recordsIn(validService, "private-participant-profiles"),
      ...recordsIn(validService, "private-participant-profile-revisions"),
    ]),
    validProfileRecords,
  );
});

test("hosted signed-in entry advances through registration and trusted participant states", async () => {
  const service = new SyntheticAittaDBService();
  const setup = explicitCampaignSetup();
  await new StorageCampaignRepository(hostedStorageAdapter(service)).saveSetup({
    operationId: "campaign-operation:participant-entry",
    recordedAt: "2026-08-10T09:00:00.000Z",
    expectedRevision: null,
    setup,
  });
  const currentPackage = await appendHostedPackageHistory(service, 1);
  const renderedRequests: Request[] = [];
  let clockTick = 0;
  const createEntryWorker = () => createApplicationWorker({
    async fetchApplication(request) {
      renderedRequests.push(request);
      return new Response(
        "<main><h1>Participant application</h1></main>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: createHostedApplicationRuntimeResolver({
      fetch: service.fetch,
      now: () => new Date(NOW.valueOf() + clockTick++ * 1_000),
    }),
  });
  const env = configuredEnvironment({ OWNER_EMAIL });
  const identityHeaders = {
    "oai-authenticated-user-id": PARTICIPANT_SUBJECT,
    "oai-authenticated-user-email": PARTICIPANT_EMAIL,
  };
  const firstWorker = createEntryWorker();

  const publicEntry = await firstWorker.fetch(
    new Request(`${APP_ORIGIN}/`, { headers: { accept: "application/json" } }),
    env,
    executionContext,
  );
  assert.equal(publicEntry.status, 200);
  const publicDocument = await publicEntry.json() as {
    actions: readonly TestAction[];
  };
  assert.ok(publicDocument.actions.length > 0);
  assert.ok(publicDocument.actions.every((action) =>
    new URL(action.href).searchParams.get("return_to") === "/participant"
  ));

  const entryJson = await firstWorker.fetch(
    new Request(`${APP_ORIGIN}/participant`, {
      headers: { accept: "application/json", ...identityHeaders },
    }),
    env,
    executionContext,
  );
  assert.equal(entryJson.status, 200);
  assert.equal(entryJson.headers.get(MUTATION_CSRF_HEADER), null);
  assert.equal(entryJson.headers.get("set-cookie"), null);
  const entryDocument = await entryJson.json() as {
    type: string;
    data: { status: string };
    actions: readonly TestAction[];
  };
  assert.equal(entryDocument.type, "participant-entry");
  assert.equal(entryDocument.data.status, "registration_required");
  assert.deepEqual(actionNames(entryDocument), [
    "open-participant-registration",
  ]);

  const entryHtml = await firstWorker.fetch(
    new Request(`${APP_ORIGIN}/participant`, {
      headers: { accept: "text/html", ...identityHeaders },
      redirect: "manual",
    }),
    env,
    executionContext,
  );
  assert.equal(entryHtml.status, 303);
  assert.equal(
    entryHtml.headers.get("location"),
    requiredAction(entryDocument, "open-participant-registration").href,
  );
  assert.equal(entryHtml.headers.get("cache-control"), "no-store");
  assert.equal(renderedRequests.length, 0);

  const unsupported = await firstWorker.fetch(
    new Request(`${APP_ORIGIN}/participant`, {
      headers: {
        accept: "application/vnd.aittadb-invest+json; version=9.0",
        ...identityHeaders,
      },
    }),
    env,
    executionContext,
  );
  assert.equal(unsupported.status, 406);

  const malformedIdentity = await firstWorker.fetch(
    new Request(`${APP_ORIGIN}/participant`, {
      headers: {
        accept: "application/json",
        "oai-authenticated-user-id": "   ",
        "oai-authenticated-user-email": PARTICIPANT_EMAIL,
      },
    }),
    env,
    executionContext,
  );
  assert.equal(malformedIdentity.status, 401);

  const ownerEntry = await firstWorker.fetch(
    ownerRequest("/participant"),
    env,
    executionContext,
  );
  assert.equal(ownerEntry.status, 404);
  assert.doesNotMatch(
    await ownerEntry.text(),
    /participant@example\.test|Required process|Optional campaign/u,
  );

  const unavailableService = new SyntheticAittaDBService();
  const unavailableWorker = createApplicationWorker({
    fetchApplication: async () => new Response("application fallback", {
      status: 404,
    }),
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: createHostedApplicationRuntimeResolver({
      fetch: unavailableService.fetch,
      now: () => NOW,
    }),
  });
  const unavailableEntry = await unavailableWorker.fetch(
    new Request(`${APP_ORIGIN}/participant`, {
      headers: { accept: "application/json", ...identityHeaders },
    }),
    env,
    executionContext,
  );
  assert.equal(unavailableEntry.status, 404);
  assert.doesNotMatch(
    await unavailableEntry.text(),
    /participant@example\.test|registration_required/u,
  );

  const registration = await participantRegistration(firstWorker, env);
  const registrationAction = requiredAction(
    registration.document,
    "register-participant-access",
  );
  const registered = await submitRegistration(
    firstWorker,
    env,
    registration,
    actionBody(registrationAction, {
      "display-name": "Entry flow participant",
      country: "FI",
      "declared-interest": "both",
      "participation-context": "individual",
      "process-email-notice-acknowledged": true,
      "marketing-consent": false,
    }),
  );
  assert.equal(registered.status, 201);

  const activeWorker = createEntryWorker();
  const activeJson = await activeWorker.fetch(
    participantRequest("/participant"),
    env,
    executionContext,
  );
  assert.equal(activeJson.status, 200);
  const activeDocument = await activeJson.json() as {
    type: string;
    data: {
      account_status: string;
      current_package: { version_id: string } | null;
    };
    actions: readonly TestAction[];
  };
  assert.equal(activeDocument.type, "participant-home");
  assert.equal(activeDocument.data.account_status, "active");
  assert.equal(
    activeDocument.data.current_package?.version_id,
    currentPackage.snapshot.id,
  );
  assert.deepEqual(actionNames(activeDocument), [
    "read-private-package",
    "open-participant-profile",
    "open-founder-interest",
    "sign-out",
  ]);

  const activePackage = await activeWorker.fetch(
    participantRequest(
      new URL(requiredAction(activeDocument, "read-private-package").href)
        .pathname,
    ),
    env,
    executionContext,
  );
  assert.equal(activePackage.status, 200);
  const activePackageDocument = await activePackage.json() as {
    type: string;
    id: string;
  };
  assert.equal(activePackageDocument.type, "participant-package");
  assert.equal(activePackageDocument.id, currentPackage.snapshot.id);

  const activeHtml = await activeWorker.fetch(
    new Request(`${APP_ORIGIN}/participant`, {
      headers: { accept: "text/html", ...identityHeaders },
    }),
    env,
    executionContext,
  );
  assert.equal(activeHtml.status, 200);
  const activeMarkup = await activeHtml.text();
  assert.match(activeMarkup, /<h1>Participant application<\/h1>/u);
  assert.equal(renderedRequests.length, 1);
  assert.equal(
    participantAccessFromRuntimeHeader(
      renderedRequests[0]?.headers.get(PARTICIPANT_ACCESS_HEADER) ?? null,
    )?.accountStatus,
    "active",
  );
  assert.equal(
    hasParticipantProfileSelfService(
      renderedRequests[0]?.headers.get(
        PARTICIPANT_PROFILE_SELF_SERVICE_HEADER,
      ) ?? null,
    ),
    true,
  );

  const profile = await participantProfile(activeWorker, env);
  const deletionAction = requiredAction(
    profile.document,
    "request-account-deletion",
  );
  const deleted = await submitProfile(
    activeWorker,
    env,
    profile,
    deletionAction,
    actionBody(deletionAction, {
      "confirm-account-deletion-request": true,
    }),
  );
  assert.equal(deleted.status, 200);

  const deletedWorker = createEntryWorker();
  const deletedJson = await deletedWorker.fetch(
    participantRequest("/participant"),
    env,
    executionContext,
  );
  assert.equal(deletedJson.status, 200);
  const deletedDocument = await deletedJson.json() as {
    data: { account_status: string };
    actions: readonly TestAction[];
  };
  assert.equal(deletedDocument.data.account_status, "deletion-requested");
  assert.deepEqual(actionNames(deletedDocument), [
    "read-private-package",
    "open-participant-profile",
    "sign-out",
  ]);
  assert.equal(
    requiredAction(deletedDocument, "open-participant-profile").name,
    "open-participant-profile",
  );
  assert.doesNotMatch(
    JSON.stringify(deletedDocument),
    /founder-interest|investment-interests/u,
  );

  const deletionHtml = await deletedWorker.fetch(
    new Request(`${APP_ORIGIN}/participant`, {
      headers: { accept: "text/html", ...identityHeaders },
    }),
    env,
    executionContext,
  );
  assert.equal(deletionHtml.status, 200);
  const deletionMarkup = await deletionHtml.text();
  assert.match(deletionMarkup, /<h1>Participant application<\/h1>/u);
  assert.equal(renderedRequests.length, 2);
  assert.equal(
    participantAccessFromRuntimeHeader(
      renderedRequests[1]?.headers.get(PARTICIPANT_ACCESS_HEADER) ?? null,
    )?.accountStatus,
    "deletion-requested",
  );
  assert.equal(
    renderedRequests[1]?.headers.get(PARTICIPANT_FOUNDER_INTEREST_HEADER),
    null,
  );

  const disclosureProbe = JSON.stringify({
    entryDocument,
    activeDocument,
    deletedDocument,
  });
  for (const privateValue of [
    SERVICE_CLIENT_SECRET,
    ACCESS_TOKEN,
    MUTATION_KEY,
    TRANSPORT_ORIGIN,
    PRIVATE_POLICY_SENTINEL,
  ]) {
    assert.doesNotMatch(disclosureProbe, new RegExp(privateValue, "u"));
  }
});

test("hosted package routes persist atomic private versions and current acknowledgments", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  const firstWorker = hostedPackageWorker(service);

  const initial = await ownerWorkspace(firstWorker, env);
  assert.equal(initial.document.data.revision, 0);
  assert.equal((await submitOwnerSection(firstWorker, env, initial, {
    title: "Participant overview",
    markdown: "Visible package content for registered participants.",
    enabled: true,
    acknowledgmentText: "I understand this indication remains non-binding.",
    changeSummary: "Created participant overview",
    materialChange: true,
  })).status, 200);

  const afterFirst = await ownerWorkspace(firstWorker, env);
  assert.equal((await submitOwnerSection(firstWorker, env, afterFirst, {
    title: "Internal draft",
    markdown: PRIVATE_DRAFT_SENTINEL,
    enabled: false,
    changeSummary: "Saved a private draft",
    materialChange: false,
  })).status, 200);

  const firstVersion = recordsIn(service, "private-package-versions")[0];
  assert(firstVersion);
  const immutableFirstVersion = JSON.stringify(firstVersion);

  const publicReadsBefore = service.readRequests;
  const publicResponse = await firstWorker.fetch(
    new Request(`${APP_ORIGIN}/`, { headers: { accept: "application/json" } }),
    env,
    executionContext,
  );
  const publicBody = await publicResponse.text();
  assert.equal(service.readRequests, publicReadsBefore + 1);
  assert.doesNotMatch(
    publicBody,
    /Participant overview|Visible package content|PRIVATE DRAFT SENTINEL/u,
  );

  const gatedWorker = hostedPackageWorker(service);
  const gatedReadsBefore = service.readRequests;
  const gated = await gatedWorker.fetch(
    participantRequest("/participant/package"),
    env,
    executionContext,
  );
  assert.equal(gated.status, 404);
  assert.equal(service.readRequests, gatedReadsBefore + 2);
  assert.doesNotMatch(await gated.text(), /package content|PRIVATE DRAFT/u);

  const concurrencyWorker = hostedPackageWorker(service);
  const [leftWorkspace, rightWorkspace] = await Promise.all([
    ownerWorkspace(concurrencyWorker, env),
    ownerWorkspace(concurrencyWorker, env),
  ]);
  assert.equal(leftWorkspace.document.data.revision, 2);
  assert.equal(rightWorkspace.document.data.revision, 2);
  const concurrent = await Promise.all([
    submitOwnerSection(concurrencyWorker, env, leftWorkspace, {
      title: "Concurrent winner A",
      markdown: "First bounded concurrent draft.",
      enabled: true,
      changeSummary: "Concurrent package update A",
      materialChange: false,
    }),
    submitOwnerSection(concurrencyWorker, env, rightWorkspace, {
      title: "Concurrent winner B",
      markdown: "Second bounded concurrent draft.",
      enabled: true,
      changeSummary: "Concurrent package update B",
      materialChange: false,
    }),
  ]);
  assert.deepEqual(
    concurrent.map(({ status }) => status).sort((left, right) => left - right),
    [200, 412],
  );

  const reopenedOwner = hostedPackageWorker(service);
  const currentOwner = await ownerWorkspace(reopenedOwner, env);
  assert.equal(currentOwner.document.data.revision, 3);
  assert.equal(recordsIn(service, "private-package-versions").length, 3);
  assert.equal(recordsIn(service, "audit-events").length, 3);
  assert.equal(JSON.stringify(recordsIn(service, "private-package-versions")[0]),
    immutableFirstVersion);
  assert.doesNotMatch(
    JSON.stringify(recordsIn(service, "audit-events")),
    /Visible package content|PRIVATE DRAFT SENTINEL|Concurrent package update/u,
  );

  const participantRepository = hostedParticipantRepository(service);
  const registration = await participantRepository.register({
    operationId: "participant-operation:hosted-access-registration",
    expectedRevision: null,
    registeredAt: "2026-08-10T10:00:00.000Z",
    registration: {
      displayName: "Synthetic participant",
      country: "FI",
      declaredInterest: "investor",
      participationContext: "individual",
      processEmailNoticeAcknowledged: true,
      marketingConsent: false,
    },
    noticeEvidence: testParticipantRegistrationNoticeEvidence(),
  });
  assert.equal(registration.revision, 1);
  const participantWorker = hostedPackageWorker(service);
  const reader = await participantWorker.fetch(
    participantRequest("/participant/package"),
    env,
    executionContext,
  );
  assert.equal(reader.status, 200);
  const readerBody = await reader.text();
  assert.match(readerBody, /Participant overview|Visible package content/u);
  assert.doesNotMatch(readerBody, /PRIVATE DRAFT SENTINEL|Internal draft/u);

  const [firstAcknowledgment, secondAcknowledgment] = await Promise.all([
    participantAcknowledgment(participantWorker, env),
    participantAcknowledgment(participantWorker, env),
  ]);
  assert.equal(firstAcknowledgment.document.data.status, "acceptance_required");
  const replayClaimsBeforeAcknowledgment = recordsIn(
    service,
    "browser-mutation-replays",
  ).length;
  const acknowledgmentAction = requiredAction(
    firstAcknowledgment.document,
    "acknowledge-current-package",
  );
  const oversizedAcknowledgment = await submitAcknowledgment(
    participantWorker,
    env,
    firstAcknowledgment,
    {
      ...actionBody(acknowledgmentAction, {}),
      extra: "x".repeat(600),
    },
  );
  assert.equal(oversizedAcknowledgment.status, 413);
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    replayClaimsBeforeAcknowledgment,
  );
  const acknowledgmentResponses = await Promise.all([
    submitAcknowledgment(
      participantWorker,
      env,
      firstAcknowledgment,
    ),
    submitAcknowledgment(
      participantWorker,
      env,
      secondAcknowledgment,
    ),
  ]);
  const acknowledgmentFailureBodies = await Promise.all(
    acknowledgmentResponses.map((response) => response.clone().text()),
  );
  assert.deepEqual(
    acknowledgmentResponses
      .map(({ status }) => status)
      .sort((left, right) => left - right),
    [201, 409],
    JSON.stringify({
      bodies: acknowledgmentFailureBodies,
      replayClaimsBeforeAcknowledgment,
      replayClaimsAfterAcknowledgment: recordsIn(
        service,
        "browser-mutation-replays",
      ).length,
      acceptanceRecords: recordsIn(
        service,
        "private-package-acceptances",
      ).length,
    }),
  );
  assert.equal(recordsIn(service, "private-package-acceptances").length, 1);
  assert.equal(recordsIn(service, "private-package-acceptance-heads").length, 1);

  const restartedParticipant = hostedPackageWorker(service);
  const satisfied = await participantAcknowledgment(restartedParticipant, env);
  assert.equal(satisfied.document.data.status, "satisfied");
  assert.deepEqual(actionNames(satisfied.document), []);

  const editorialOwner = hostedPackageWorker(service);
  const editorialWorkspace = await ownerWorkspace(editorialOwner, env);
  const editorialResponse = await submitOwnerSection(
    editorialOwner,
    env,
    editorialWorkspace,
    {
      title: "Editorial note",
      markdown: "An editorial clarification.",
      enabled: true,
      changeSummary: "Clarified package wording",
      materialChange: false,
    },
  );
  assert.equal(editorialResponse.status, 200);
  const editorialState = await participantAcknowledgment(
    hostedPackageWorker(service),
    env,
  );
  assert.equal(editorialState.document.data.status, "satisfied");

  const materialOwner = hostedPackageWorker(service);
  const materialWorkspace = await ownerWorkspace(materialOwner, env);
  const materialResponse = await submitOwnerSection(
    materialOwner,
    env,
    materialWorkspace,
    {
      title: "Material update",
      markdown: "A material package change.",
      enabled: true,
      changeSummary: "Changed material package information",
      materialChange: true,
    },
  );
  assert.equal(materialResponse.status, 200);
  const renewed = await participantAcknowledgment(
    hostedPackageWorker(service),
    env,
  );
  assert.equal(renewed.document.data.status, "acceptance_required");
  assert.deepEqual(actionNames(renewed.document), [
    "acknowledge-current-package",
  ]);

  const disclosureProbe = JSON.stringify({
    publicBody,
    readerBody,
    satisfied: satisfied.document,
    renewed: renewed.document,
  });
  for (const secret of [
    SERVICE_CLIENT_SECRET,
    ACCESS_TOKEN,
    MUTATION_KEY,
    SERVICE_CLIENT_ID,
    TRANSPORT_ORIGIN,
  ]) {
    assert.equal(disclosureProbe.includes(secret), false);
  }
  assert.doesNotMatch(
    JSON.stringify(satisfied.document),
    /participant-subject|contentHash|requiredAcceptanceHash|storage-runtime/iu,
  );
});

test("hosted package staging respects advertised limits and resumes after final publication failure", async () => {
  const service = new SyntheticAittaDBService();
  const repository = hostedPackageRepository(service);
  const operationId = parseStorageOperationId(
    "operation:hosted-package-record-limits",
  );
  const ownerSubject = parseActorSubject(OWNER.subject);
  assert(operationId.ok);
  assert(ownerSubject.ok);
  const maximumUnicodeMarkdown = "\u0800".repeat(50_000);
  const draft = {
    id: "package:hosted-record-limits-v1",
    createdAt: "2026-08-10T11:00:00.000Z",
    changeSummary: "Stored a bounded maximum package",
    materialChange: true,
    acknowledgmentText: "I acknowledge this bounded package.",
    sections: Array.from({ length: 64 }, (_, index) => ({
      id: `section:hosted-limit-${index}`,
      order: index,
      title: `Bounded section ${index + 1}`,
      markdown: index < 2
        ? maximumUnicodeMarkdown
        : `# Bounded section ${index + 1}`,
      enabled: true,
    })),
  };
  const request = Object.freeze({
    operationId: operationId.value,
    expectedRevision: null,
    draft,
    ownerSubject: ownerSubject.value,
  });

  service.failNextTransactionContaining("private-package-versions");
  await assert.rejects(
    repository.appendWithAudit(request),
    (error) => error instanceof StorageFailure && error.code === "UNAVAILABLE",
  );
  assert.equal(recordsIn(service, "private-package-versions").length, 0);
  assert.equal(recordsIn(service, "private-package-version-heads").length, 0);
  assert.equal(
    recordsIn(service, "private-package-acceptance-bindings").length,
    0,
  );
  assert.equal(recordsIn(service, "audit-events").length, 0);
  assert.equal(
    recordsIn(service, "private-package-operation-intents").length,
    1,
  );
  assert.equal(recordsIn(service, "private-package-version-sections").length, 64);
  assert.ok(recordsIn(service, "private-package-section-chunks").length > 64);
  const stagedRecordCount = service.records.size;
  const changedDrafts = [
    { ...draft, changeSummary: "Changed metadata after failure" },
    { ...draft, materialChange: false },
    { ...draft, acknowledgmentText: "Changed unstaged acknowledgment." },
    {
      ...draft,
      sections: draft.sections.map((section, index) =>
        index === 0 ? { ...section, markdown: "Changed staged content" } : section
      ),
    },
  ];
  for (const changedDraft of changedDrafts) {
    await assert.rejects(
      repository.appendWithAudit({ ...request, draft: changedDraft }),
      (error) => error instanceof StorageFailure && error.code === "CONFLICT",
    );
    assert.equal(service.records.size, stagedRecordCount);
  }
  await assert.rejects(
    repository.appendWithAudit({ ...request, expectedRevision: 1 }),
    (error) => error instanceof StorageFailure && error.code === "CONFLICT",
  );
  assert.equal(service.records.size, stagedRecordCount);
  const otherOwner = parseActorSubject("sites-other-owner-subject");
  assert(otherOwner.ok);
  await assert.rejects(
    repository.appendWithAudit({
      ...request,
      ownerSubject: otherOwner.value,
    }),
    (error) => error instanceof StorageFailure && error.code === "CONFLICT",
  );
  assert.equal(service.records.size, stagedRecordCount);
  await assert.rejects(
    repository.append({
      operationId: request.operationId,
      expectedRevision: request.expectedRevision,
      draft: request.draft,
    }),
    (error) => error instanceof StorageFailure && error.code === "CONFLICT",
  );
  assert.equal(service.records.size, stagedRecordCount);
  await assert.rejects(
    repository.appendWithAudit({
      ...request,
      mutationFingerprint: `sha256:${"0".repeat(64)}`,
    }),
    (error) => error instanceof StorageFailure && error.code === "CONFLICT",
  );
  assert.equal(service.records.size, stagedRecordCount);

  const restarted = hostedPackageRepository(service);
  const stored = await restarted.appendWithAudit(request);
  assert.equal(stored.revision, 1);
  assert.equal(stored.replayed, false);
  assert.equal(stored.snapshot.sections.length, 64);
  assert.equal(stored.snapshot.sections[0]?.markdown, maximumUnicodeMarkdown);
  assert.equal(stored.snapshot.sections[1]?.markdown, maximumUnicodeMarkdown);
  const replay = await hostedPackageRepository(service).appendWithAudit(request);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.snapshot, stored.snapshot);

  const reopened = await hostedPackageRepository(service).current();
  assert.deepEqual(reopened, {
    revision: 1,
    snapshot: stored.snapshot,
  });
  assert.equal(recordsIn(service, "private-package-versions").length, 1);
  assert.equal(recordsIn(service, "private-package-version-heads").length, 1);
  assert.equal(
    recordsIn(service, "private-package-acceptance-bindings").length,
    1,
  );
  assert.equal(recordsIn(service, "audit-events").length, 1);
  const manifest = recordsIn(service, "private-package-versions")[0];
  assert(manifest);
  assert.equal("sections" in manifest.value, false);
  assert.equal(Array.isArray(manifest.value.sectionRecordIds), true);
  assert.equal(service.maximumRecordBytesSeen <= MAX_HOSTED_RECORD_BYTES, true);
  assert.equal(
    service.maximumTransactionMutationsSeen <=
      MAX_HOSTED_TRANSACTION_MUTATIONS,
    true,
  );
  assert.equal(
    service.maximumTransactionBytesSeen <= MAX_HOSTED_TRANSACTION_BYTES,
    true,
  );
});

test("package intent survives a mid-stage failure and rejects changed retry work", async () => {
  const service = new SyntheticAittaDBService();
  const repository = hostedPackageRepository(service);
  const parsedOperation = parseStorageOperationId(
    "operation:hosted-package-mid-stage-intent",
  );
  const parsedOwner = parseActorSubject(OWNER.subject);
  assert(parsedOperation.ok);
  assert(parsedOwner.ok);
  const request = Object.freeze({
    operationId: parsedOperation.value,
    expectedRevision: null,
    ownerSubject: parsedOwner.value,
    draft: {
      id: "package:hosted-mid-stage-intent",
      createdAt: "2026-08-10T11:30:00.000Z",
      changeSummary: "Started a bounded staged package",
      materialChange: true,
      acknowledgmentText: "I acknowledge this staged package.",
      sections: [{
        id: "section:hosted-mid-stage-intent",
        order: 0,
        title: "Large staged section",
        markdown: "\u0800".repeat(50_000),
        enabled: true,
      }],
    },
  });
  service.failTransactionContainingAfter("private-package-section-chunks", 1);
  await assert.rejects(
    repository.appendWithAudit(request),
    (error) => error instanceof StorageFailure && error.code === "UNAVAILABLE",
  );
  assert.equal(
    recordsIn(service, "private-package-operation-intents").length,
    1,
  );
  assert.equal(recordsIn(service, "private-package-section-chunks").length, 1);
  assert.equal(recordsIn(service, "private-package-version-sections").length, 0);
  assert.equal(recordsIn(service, "private-package-versions").length, 0);
  assert.equal(recordsIn(service, "private-package-version-heads").length, 0);
  const recordCount = service.records.size;
  await assert.rejects(
    repository.appendWithAudit({
      ...request,
      draft: {
        ...request.draft,
        sections: [{
          ...request.draft.sections[0],
          markdown: "Changed after a partial stage",
        }],
      },
    }),
    (error) => error instanceof StorageFailure && error.code === "CONFLICT",
  );
  assert.equal(service.records.size, recordCount);

  const completed = await hostedPackageRepository(service).appendWithAudit(
    request,
  );
  assert.equal(completed.replayed, false);
  assert.equal(completed.revision, 1);
  assert.equal(
    completed.snapshot.sections[0]?.markdown,
    request.draft.sections[0]?.markdown,
  );
  assert.deepEqual(
    await hostedPackageRepository(service).current(),
    { revision: 1, snapshot: completed.snapshot },
  );
});

test("owner package body and field bounds reject before consuming mutation proof", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  const worker = hostedPackageWorker(service);
  const workspace = await ownerWorkspace(worker, env);
  const action = requiredAction(workspace.document, "create-package-section");
  const validBody = actionBody(action, {
    title: "Maximum Unicode section",
    markdown: "\u0800".repeat(50_000),
    enabled: true,
    "acknowledgment-text": "I acknowledge this package.",
    "change-summary": "Added maximum Unicode package content",
    "material-change": true,
  });
  assert.equal(Object.keys(validBody).length <= MAX_OWNER_PACKAGE_MUTATION_FIELDS, true);
  assert.equal(
    new TextEncoder().encode(JSON.stringify(validBody)).byteLength <
      MAX_OWNER_PACKAGE_MUTATION_BYTES,
    true,
  );
  const maximumFormBody = new URLSearchParams({
    "operation-id": "o".repeat(128),
    "expected-revision": Number.MAX_SAFE_INTEGER.toString(),
    "change-summary": "\u0800".repeat(500),
    "material-change": "true",
    title: "\u0800".repeat(160),
    markdown: "\u0800".repeat(50_000),
    enabled: "true",
    "acknowledgment-text": "\u0800".repeat(4_000),
    [MUTATION_CSRF_FIELD]: "c".repeat(65),
  }).toString();
  assert.equal(
    new TextEncoder().encode(maximumFormBody).byteLength <=
      MAX_OWNER_PACKAGE_MUTATION_BYTES,
    true,
  );
  const claimsBefore = recordsIn(service, "browser-mutation-replays").length;
  const overLimit = await submitOwnerBody(
    worker,
    env,
    workspace,
    action,
    {
      ...validBody,
      markdown: "x".repeat(MAX_OWNER_PACKAGE_MUTATION_BYTES),
    },
  );
  assert.equal(overLimit.status, 413);
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    claimsBefore,
  );

  const accepted = await submitOwnerBody(
    worker,
    env,
    workspace,
    action,
    validBody,
  );
  assert.equal(accepted.status, 200);
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    claimsBefore + 1,
  );
  const current = await ownerWorkspace(hostedPackageWorker(service), env);
  assert.equal(
    current.document.data.sections[0]?.markdown,
    "\u0800".repeat(50_000),
  );

  const fieldWorkspace = await ownerWorkspace(hostedPackageWorker(service), env);
  const fieldAction = requiredAction(
    fieldWorkspace.document,
    "create-package-section",
  );
  const nextValidBody = actionBody(fieldAction, {
    title: "Bounded field proof",
    markdown: "A bounded follow-up section.",
    enabled: true,
    "change-summary": "Proved the field envelope",
    "material-change": false,
  });
  const claimsBeforeFieldLimit = recordsIn(
    service,
    "browser-mutation-replays",
  ).length;
  const excessFields = await submitOwnerBody(
    hostedPackageWorker(service),
    env,
    fieldWorkspace,
    fieldAction,
    { ...nextValidBody, extra1: "x", extra2: "x", extra3: "x" },
  );
  assert.equal(excessFields.status, 400);
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    claimsBeforeFieldLimit,
  );
  const acceptedAfterFieldLimit = await submitOwnerBody(
    hostedPackageWorker(service),
    env,
    fieldWorkspace,
    fieldAction,
    nextValidBody,
  );
  assert.equal(acceptedAfterFieldLimit.status, 200);
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    claimsBeforeFieldLimit + 1,
  );
});

test("the production entry point installs the fail-closed application resolver", () => {
  const entrypoint = readFileSync(
    new URL("../worker/index.ts", import.meta.url),
    "utf8",
  );
  const composition = readFileSync(
    new URL("../worker/hosted-application-composition.ts", import.meta.url),
    "utf8",
  );
  assert.match(entrypoint, /createHostedApplicationRuntimeResolver\(\)/u);
  assert.match(entrypoint, /resolveApplicationRuntime:/u);
  assert.doesNotMatch(`${entrypoint}\n${composition}`, /console\s*\./u);
  assert.doesNotMatch(
    `${entrypoint}\n${composition}`,
    /aittadb\.com|chatgpt\.site|jheusala@/iu,
  );
});

class SyntheticAittaDBService {
  readonly records = new Map<string, SyntheticRecord>();
  readonly operations = new Map<
    string,
    Readonly<{
      fingerprint: string;
      records: readonly (SyntheticRecord | null)[];
    }>
  >();
  tokenRequests = 0;
  discoveryRequests = 0;
  readRequests = 0;
  readonly readCollections: string[] = [];
  transactionRequests = 0;
  maximumRecordBytesSeen = 0;
  maximumTransactionMutationsSeen = 0;
  maximumTransactionBytesSeen = 0;
  #transactionFailure: Readonly<{
    collection: string;
    successfulMatchesRemaining: number;
  }> | null = null;
  #transactionRace: Readonly<{
    collection: string;
    run: () => Promise<void>;
  }> | null = null;
  #readRace: Readonly<{
    collection: string;
    run: () => Promise<void>;
  }> | null = null;
  #readInterception: Readonly<{
    collection: string;
    successfulMatchesRemaining: number;
    run(): void | Promise<void>;
  }> | null = null;

  failNextTransactionContaining(collection: string): void {
    this.failTransactionContainingAfter(collection, 0);
  }

  failTransactionContainingAfter(
    collection: string,
    successfulMatches: number,
  ): void {
    assert.ok(Number.isSafeInteger(successfulMatches));
    assert.ok(successfulMatches >= 0);
    this.#transactionFailure = Object.freeze({
      collection,
      successfulMatchesRemaining: successfulMatches,
    });
  }

  raceNextTransactionContaining(
    collection: string,
    run: () => Promise<void>,
  ): void {
    assert.ok(collection.length > 0);
    this.#transactionRace = Object.freeze({ collection, run });
  }

  raceNextReadFrom(collection: string, run: () => Promise<void>): void {
    assert.ok(collection.length > 0);
    this.#readRace = Object.freeze({ collection, run });
  }

  interceptReadAfter(
    collection: string,
    successfulMatches: number,
    run: () => void | Promise<void>,
  ): void {
    assert.ok(collection.length > 0);
    assert.ok(Number.isSafeInteger(successfulMatches));
    assert.ok(successfulMatches >= 0);
    this.#readInterception = Object.freeze({
      collection,
      successfulMatchesRemaining: successfulMatches,
      run,
    });
  }

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.url === `${TRANSPORT_ORIGIN}/oauth/token`) {
      this.tokenRequests += 1;
      assert.equal(request.method, "POST");
      assert.equal(
        request.headers.get("authorization"),
        `Basic ${btoa(`${SERVICE_CLIENT_ID}:${SERVICE_CLIENT_SECRET}`)}`,
      );
      assert.deepEqual(
        Object.fromEntries(new URLSearchParams(await request.text())),
        { grant_type: "client_credentials", scope: STORAGE_SCOPES },
      );
      return jsonResponse({
        access_token: ACCESS_TOKEN,
        token_type: "Bearer",
        expires_in: 3_600,
        scope: STORAGE_SCOPES,
      });
    }

    assert.equal(request.headers.get("authorization"), `Bearer ${ACCESS_TOKEN}`);
    assert.equal(request.headers.get("cookie"), null);
    if (request.url === `${TRANSPORT_ORIGIN}/bounded-storage`) {
      this.discoveryRequests += 1;
      return protocolResponse(defineStorageProtocolDiscovery({
        entryHref: ENTRY_HREF,
        readRecordHref: `${ISSUER}/records/{collection}/{id}`,
        listRecordsHref: `${ISSUER}/records`,
        transactRecordsHref: TRANSACTION_HREF,
        limits: {
          max_record_bytes: MAX_HOSTED_RECORD_BYTES,
          max_page_size: 100,
          max_transaction_mutations: MAX_HOSTED_TRANSACTION_MUTATIONS,
          max_transaction_bytes: MAX_HOSTED_TRANSACTION_BYTES,
          max_cursor_length: 2_048,
        },
      }));
    }
    const url = new URL(request.url);
    const read = /^\/records\/([^/]+)\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "GET" && read !== null) {
      this.readRequests += 1;
      const collection = decodeURIComponent(read[1] ?? "");
      const id = decodeURIComponent(read[2] ?? "");
      this.readCollections.push(collection);
      const interception = this.#readInterception;
      if (interception?.collection === collection) {
        if (interception.successfulMatchesRemaining === 0) {
          this.#readInterception = null;
          await interception.run();
        } else {
          this.#readInterception = Object.freeze({
            ...interception,
            successfulMatchesRemaining:
              interception.successfulMatchesRemaining - 1,
          });
        }
      }
      const record = this.records.get(`${collection}/${id}`);
      const race = this.#readRace;
      if (race !== null && race.collection === collection) {
        this.#readRace = null;
        await race.run();
      }
      return record === undefined
        ? protocolFailure("not_found")
        : protocolResponse(recordDocument(record));
    }
    assert.equal(request.url, `${TRANSPORT_ORIGIN}/records/transactions`);
    assert.equal(request.method, "POST");
    this.transactionRequests += 1;
    const transactionBody = await request.text();
    const transactionBytes = new TextEncoder().encode(transactionBody).byteLength;
    this.maximumTransactionBytesSeen = Math.max(
      this.maximumTransactionBytesSeen,
      transactionBytes,
    );
    if (transactionBytes > MAX_HOSTED_TRANSACTION_BYTES) {
      return protocolFailure("invalid_request");
    }
    return await this.transact(JSON.parse(transactionBody) as unknown);
  };

  private async transact(value: unknown): Promise<Response> {
    const transaction = requiredObject(requiredObject(value).transaction);
    const operationId = requiredString(transaction.operation_id);
    const mutations = transaction.mutations;
    if (!Array.isArray(mutations) || mutations.length < 1) {
      throw new Error("Unexpected synthetic transaction shape.");
    }
    this.maximumTransactionMutationsSeen = Math.max(
      this.maximumTransactionMutationsSeen,
      mutations.length,
    );
    if (mutations.length > MAX_HOSTED_TRANSACTION_MUTATIONS) {
      return protocolFailure("invalid_request");
    }
    const fingerprint = JSON.stringify(transaction);
    const prior = this.operations.get(operationId);
    if (prior !== undefined) {
      return prior.fingerprint === fingerprint
        ? protocolResponse(transactionDocument(
            operationId,
            prior.records,
            true,
          ))
        : protocolFailure("conflict");
    }

    const mutationCollections = mutations.map((candidate) =>
      requiredString(requiredObject(requiredObject(candidate).key).collection)
    );
    const race = this.#transactionRace;
    if (race !== null && mutationCollections.includes(race.collection)) {
      this.#transactionRace = null;
      await race.run();
    }
    const failure = this.#transactionFailure;
    if (failure !== null && mutationCollections.includes(failure.collection)) {
      if (failure.successfulMatchesRemaining === 0) {
        this.#transactionFailure = null;
        return protocolFailure("unavailable");
      }
      this.#transactionFailure = Object.freeze({
        ...failure,
        successfulMatchesRemaining: failure.successfulMatchesRemaining - 1,
      });
    }

    const staged = new Map(this.records);
    const changed: (SyntheticRecord | null)[] = [];
    const keys = new Set<string>();
    for (const candidate of mutations) {
      const mutation = requiredObject(candidate);
      const key = requiredObject(mutation.key);
      const collection = requiredString(key.collection);
      const id = requiredString(key.id);
      const storageKey = `${collection}/${id}`;
      if (keys.has(storageKey)) return protocolFailure("invalid_request");
      keys.add(storageKey);
      const current = staged.get(storageKey);
      const expectedRevision = mutation.expected_revision;
      if (mutation.type === "check") {
        if (
          expectedRevision === null
            ? current !== undefined
            : !positiveSyntheticRevision(expectedRevision) ||
              current?.revision !== expectedRevision
        ) {
          return protocolFailure("precondition_failed");
        }
        changed.push(current === undefined ? null : cloneSyntheticRecord(current));
        continue;
      }
      if (mutation.type === "delete") {
        if (
          !positiveSyntheticRevision(expectedRevision) ||
          current?.revision !== expectedRevision
        ) {
          return protocolFailure("precondition_failed");
        }
        staged.delete(storageKey);
        changed.push(null);
        continue;
      }
      if (mutation.type !== "put") return protocolFailure("invalid_request");
      if (expectedRevision === null && current !== undefined) {
        return protocolFailure("conflict");
      }
      if (
        expectedRevision !== null &&
        (!positiveSyntheticRevision(expectedRevision) ||
          current?.revision !== expectedRevision)
      ) {
        return protocolFailure("precondition_failed");
      }
      const recordBytes = new TextEncoder().encode(
        JSON.stringify(requiredObject(mutation.value)),
      ).byteLength;
      this.maximumRecordBytesSeen = Math.max(
        this.maximumRecordBytesSeen,
        recordBytes,
      );
      if (recordBytes > MAX_HOSTED_RECORD_BYTES) {
        return protocolFailure("invalid_request");
      }
      const next = Object.freeze({
        key: Object.freeze({ collection, id }),
        revision: (current?.revision ?? 0) + 1,
        value: structuredClone(requiredObject(mutation.value)),
      });
      staged.set(storageKey, next);
      changed.push(next);
    }

    this.records.clear();
    for (const [storageKey, record] of staged) this.records.set(storageKey, record);
    const result = Object.freeze(changed.map((record) =>
      record === null ? null : cloneSyntheticRecord(record)
    ));
    this.operations.set(operationId, Object.freeze({
      fingerprint,
      records: result,
    }));
    return protocolResponse(transactionDocument(operationId, result, false));
  }
}

type SyntheticRecord = Readonly<{
  key: Readonly<{ collection: string; id: string }>;
  revision: number;
  value: Record<string, unknown>;
}>;

function positiveSyntheticRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function cloneSyntheticRecord(record: SyntheticRecord): SyntheticRecord {
  return Object.freeze({
    key: Object.freeze({ ...record.key }),
    revision: record.revision,
    value: structuredClone(record.value),
  });
}

function recordDocument(record: SyntheticRecord) {
  return {
    api_version: AITTADB_HYPERMEDIA_API_VERSION,
    type: "bounded-storage-record",
    id: `${record.key.collection}/${record.key.id}`,
    data: record,
    links: [],
    actions: [],
  };
}

function transactionDocument(
  operationId: string,
  records: readonly (SyntheticRecord | null)[],
  replayed: boolean,
) {
  return {
    api_version: AITTADB_HYPERMEDIA_API_VERSION,
    type: "bounded-storage-transaction",
    id: operationId,
    data: {
      operation_id: operationId,
      replayed,
      records,
    },
    links: [],
    actions: [],
  };
}

function protocolFailure(code: StorageProtocolErrorCode): Response {
  return protocolResponse(
    storageProtocolErrorDocument(code),
    storageProtocolErrorStatus(code),
  );
}

function mutationRequest(proof: Readonly<{ token: string; setCookie: string }>) {
  return new Request(`${APP_ORIGIN}/owner/setup`, {
    method: "POST",
    headers: {
      cookie: proof.setCookie.split(";", 1)[0] ?? "",
      origin: APP_ORIGIN,
      "content-type": "application/json",
      [MUTATION_CSRF_HEADER]: proof.token,
    },
    body: JSON.stringify({ operation: "save" }),
  });
}

function hostedPackageWorker(
  service: SyntheticAittaDBService,
  now: () => Date = () => NOW,
) {
  return createApplicationWorker({
    fetchApplication: async () =>
      new Response("application fallback", { status: 404 }),
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: createHostedApplicationRuntimeResolver({
      fetch: service.fetch,
      now,
    }),
  });
}

type StorageReadObserver = (
  key: Parameters<StorageAdapter["read"]>[0],
  record: StorageRecord | null,
) => StorageRecord | null | Promise<StorageRecord | null>;

function observeStorageReads(
  storage: StorageAdapter,
  observer: StorageReadObserver = (_key, record) => record,
): Readonly<{ storage: StorageAdapter; count(): number }> {
  let readCount = 0;
  return Object.freeze({
    storage: Object.freeze({
      async read(key: Parameters<StorageAdapter["read"]>[0]) {
        readCount += 1;
        return await observer(key, await storage.read(key));
      },
      list: (request: Parameters<StorageAdapter["list"]>[0]) =>
        storage.list(request),
      transact: (request: Parameters<StorageAdapter["transact"]>[0]) =>
        storage.transact(request),
    }),
    count: () => readCount,
  });
}

function revisedStorageRecord(
  record: StorageRecord | null,
  revisionOffset: number,
): StorageRecord {
  assert(record);
  assert.ok(Number.isSafeInteger(revisionOffset));
  assert.ok(revisionOffset >= 0);
  return Object.freeze({
    key: record.key,
    revision: record.revision + revisionOffset,
    value: record.value,
  });
}

async function appendHostedMaximumReadPackage(
  service: SyntheticAittaDBService,
) {
  const twoChunkMarkdown = "\u0800".repeat(30_000);
  const sections = (
    prefix: string,
    count: number,
    twoChunkIndex: number | null,
  ) => Array.from({ length: count }, (_, index) => ({
      id: `section:${prefix}-${index}`,
      order: index,
      title: `Bounded section ${index + 1}`,
      markdown: index === twoChunkIndex
        ? twoChunkMarkdown
        : `Bounded package content ${index + 1}.`,
      enabled: true,
    }));
  const repository = hostedPackageRepository(service);
  let current: Awaited<ReturnType<typeof repository.append>> | null = null;
  for (let index = 1; index <= 4; index += 1) {
    const operationId = parseStorageOperationId(
      `operation:maximum-request-package-v${index}`,
    );
    assert(operationId.ok);
    current = await repository.append({
      operationId: operationId.value,
      expectedRevision: index === 1 ? null : index - 1,
      draft: {
        id: `package:maximum-request-v${index}`,
        createdAt: new Date(
          Date.parse("2026-08-10T10:00:00.000Z") + index * 10 * 60_000,
        ).toISOString(),
        changeSummary: `Maximum request package ${index}`,
        materialChange: true,
        acknowledgmentText: `I acknowledge maximum request package ${index}.`,
        sections: sections(
          `maximum-request-v${index}`,
          index < 4 ? 64 : 59,
          index === 4 ? 0 : null,
        ),
      },
    });
  }
  assert(current);
  return current;
}

async function recordHostedAcceptance(
  service: SyntheticAittaDBService,
  subject: ActorSubject,
  versionId: StableId<"package-version">,
  acceptanceValue: string,
  operationValue: string,
): Promise<void> {
  const acceptanceId = parseStableId<"package-acceptance">(acceptanceValue);
  const operationId = parseStorageOperationId(operationValue);
  const acceptedAt = parseTimestamp("2026-08-10T11:30:00.000Z");
  assert(acceptanceId.ok);
  assert(operationId.ok);
  assert(acceptedAt.ok);
  const packages = hostedPackageRepository(service);
  await new StorageAcknowledgmentRepository(
    hostedStorageAdapter(service),
    packages,
    subject,
  ).record({
    operationId: operationId.value,
    expectedRevision: null,
    id: acceptanceId.value,
    acceptedAt: acceptedAt.value,
    acceptedVersionId: versionId,
  });
}

function hostedPackageRepository(
  service: SyntheticAittaDBService,
): StoragePackageVersionRepository {
  return new StoragePackageVersionRepository(hostedStorageAdapter(service));
}

async function appendHostedPackageHistory(
  service: SyntheticAittaDBService,
  count: number,
) {
  let current: Awaited<
    ReturnType<StoragePackageVersionRepository["append"]>
  > | null = null;
  for (let index = 1; index <= count; index += 1) {
    current = await appendHostedPackageVersion(service, index, index - 1);
  }
  assert(current);
  return current;
}

async function appendHostedNamedPackageHistory(
  service: SyntheticAittaDBService,
  prefix: string,
  count: number,
  start: string,
): Promise<void> {
  const repository = hostedPackageRepository(service);
  for (let index = 1; index <= count; index += 1) {
    const operationId = parseStorageOperationId(
      `operation:${prefix}-v${index}`,
    );
    assert(operationId.ok);
    await repository.append({
      operationId: operationId.value,
      expectedRevision: index === 1 ? null : index - 1,
      draft: {
        id: `package:${prefix}-v${index}`,
        createdAt: new Date(
          Date.parse(start) + index * 60_000,
        ).toISOString(),
        changeSummary: `${prefix} version ${index}`,
        materialChange: true,
        acknowledgmentText: `I acknowledge ${prefix} version ${index}.`,
        sections: [{
          id: `section:${prefix}-v${index}`,
          order: 0,
          title: `${prefix} version ${index}`,
          markdown: `${prefix} private content ${index}.`,
          enabled: true,
        }],
      },
    });
  }
}

async function appendHostedPackageVersion(
  service: SyntheticAittaDBService,
  index: number,
  expectedRevision: number,
) {
  const operationId = parseStorageOperationId(
    `operation:package-budget-v${index}`,
  );
  assert(operationId.ok);
  return hostedPackageRepository(service).append({
    operationId: operationId.value,
    expectedRevision: expectedRevision === 0 ? null : expectedRevision,
    draft: {
      id: `package:budget-v${index}`,
      createdAt: new Date(
        Date.parse("2026-08-09T08:00:00.000Z") + index * 60_000,
      ).toISOString(),
      changeSummary: `Package budget version ${index}`,
      materialChange: true,
      acknowledgmentText: `I acknowledge package budget version ${index}.`,
      sections: [{
        id: `section:package-budget-v${index}`,
        order: 0,
        title: `Package budget version ${index}`,
        markdown: `Private package budget content ${index}.`,
        enabled: true,
      }],
    },
  });
}

function hostedParticipantRepository(
  service: SyntheticAittaDBService,
): ParticipantRegistrationRepository {
  return hostedParticipantRepositoryFor(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
  );
}

function hostedParticipantRepositoryFor(
  service: SyntheticAittaDBService,
  subject: string,
  email: string,
): ParticipantRegistrationRepository {
  const account = parseParticipantAccount({
    subject,
    accountEmailLabel: email,
  });
  assert(account.ok);
  return new StorageApplicationRepositoryFactory(
    hostedStorageAdapter(service),
    () => NOW,
  ).participantRepository(account.value);
}

async function registerHostedParticipant(
  service: SyntheticAittaDBService,
  subject: string,
  email: string,
  displayName: string,
  operationId: string,
  options: Readonly<{
    country?: string;
    declaredInterest?: "founder" | "investor" | "both";
    marketingConsent?: boolean;
  }> = {},
): Promise<void> {
  const result = await hostedParticipantRepositoryFor(
    service,
    subject,
    email,
  ).register({
    operationId,
    expectedRevision: null,
    registeredAt: "2026-08-10T10:00:00.000Z",
    registration: {
      displayName,
      country: options.country ?? "FI",
      declaredInterest: options.declaredInterest ?? "investor",
      participationContext: "individual",
      processEmailNoticeAcknowledged: true,
      marketingConsent: options.marketingConsent ?? false,
    },
    noticeEvidence: testParticipantRegistrationNoticeEvidence(),
  });
  assert.equal(result.revision, 1);
}

async function updateHostedParticipantInterest(
  service: SyntheticAittaDBService,
  subject: string,
  email: string,
  declaredInterest: "founder" | "investor" | "both",
  operationId: string,
): Promise<void> {
  const repository = hostedParticipantRepositoryFor(service, subject, email);
  const current = await repository.current();
  assert(current);
  const result = await repository.update({
    operationId,
    expectedRevision: current.revision,
    updatedAt: "2026-08-10T11:00:00.000Z",
    changes: { declaredInterest },
  });
  assert.equal(result.revision, current.revision + 1);
  assert.equal(result.snapshot.declaredInterest, declaredInterest);
}

async function updateHostedParticipantProfile(
  service: SyntheticAittaDBService,
  changes: Readonly<{
    country?: string;
    declaredInterest?: "founder" | "investor" | "both";
  }>,
  operationId: string,
): Promise<void> {
  const repository = hostedParticipantRepository(service);
  const current = await repository.current();
  assert(current);
  const result = await repository.update({
    operationId,
    expectedRevision: current.revision,
    updatedAt: "2026-08-10T11:00:00.000Z",
    changes,
  });
  assert.equal(result.revision, current.revision + 1);
}

async function configureHostedInvestmentFixture(
  service: SyntheticAittaDBService,
): Promise<StableId<"package-version">> {
  await configureHostedInvestmentCampaign(service, "open");
  const packageVersion = await appendHostedPackageVersion(service, 1, 0);
  await registerHostedAcceptedInvestor(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    packageVersion.snapshot.id,
    "primary",
  );
  return packageVersion.snapshot.id;
}

async function seedHostedMaximumActiveInvestmentCollection(
  service: SyntheticAittaDBService,
): Promise<void> {
  const adapter = hostedStorageAdapter(service);
  const campaign = await new StorageCampaignRepository(adapter).readSetup();
  const subject = parseActorSubject(PARTICIPANT_SUBJECT);
  assert(campaign);
  assert(subject.ok);
  const packages = new StoragePackageVersionRepository(adapter);
  const currentPackage = await packages.current();
  assert(currentPackage);
  const latestAcceptance = await new StorageAcknowledgmentRepository(
    adapter,
    packages,
    subject.value,
  ).latest();
  assert(latestAcceptance);
  const repository = new StorageParticipantInvestmentInterestRepository(
    adapter,
    subject.value,
    campaign.setup.amountAggregate.amount,
  );
  const interestService = createParticipantInvestmentInterestService({
    actorSubject: subject.value,
    amountConfiguration: campaign.setup.amountAggregate.amount,
    reader: repository,
    mutations: repository,
    loadAcknowledgmentContext: () => Object.freeze({
      currentVersion: currentPackage.snapshot,
      latestAcceptance: latestAcceptance.snapshot,
    }),
    loadPermissions: () => Object.freeze({
      createPersonal: true,
      createCompany: true,
      reactivatePersonal: true,
      reactivateCompany: true,
    }),
    indicationIdForOperation: (operationId) => {
      const id = parseStableId<"investment-indication">(operationId);
      if (!id.ok) throw new Error("Invalid maximum-collection operation ID.");
      return id.value;
    },
    now: () => NOW,
  });

  for (
    let index = 0;
    index < MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS;
    index += 1
  ) {
    const suffix = String(index).padStart(3, "0");
    await interestService.create({
      operationId: `investment-operation:maximum-collection-${suffix}`,
      fields: {
        kind: "company",
        companyName: `Maximum collection company ${suffix}`,
        registrationCountry: "FI",
        companyIdentifier: `SYNTHETIC-${suffix}`,
        representativeName: `Representative ${suffix}`,
        representativeAuthorityDeclared: true,
        amount: 25_000,
        availabilityPeriod: "Within twelve months.",
      },
    });
  }
}

async function registerHostedAcceptedInvestor(
  service: SyntheticAittaDBService,
  subjectValue: string,
  email: string,
  packageVersionId: StableId<"package-version">,
  suffix: string,
): Promise<void> {
  await registerHostedParticipant(
    service,
    subjectValue,
    email,
    `Hosted investor ${suffix}`,
    `participant-operation:hosted-investor-${suffix}`,
    { declaredInterest: "investor" },
  );
  const subject = parseActorSubject(subjectValue);
  assert(subject.ok);
  await recordHostedAcceptance(
    service,
    subject.value,
    packageVersionId,
    `package-acceptance:hosted-investor-${suffix}`,
    `package-acceptance-operation:hosted-investor-${suffix}`,
  );
}

async function configureHostedInvestmentCampaign(
  service: SyntheticAittaDBService,
  phaseState: "closed" | "open",
): Promise<void> {
  const repository = new StorageCampaignRepository(hostedStorageAdapter(service));
  const current = await repository.readSetup();
  const expectedRevision = current?.revision ?? null;
  const result = await repository.saveSetup({
    operationId: `campaign-operation:hosted-investment-${phaseState}-${
      expectedRevision ?? "new"
    }`,
    expectedRevision,
    recordedAt: "2026-08-10T10:30:00.000Z",
    setup: explicitCampaignSetup({ phaseState }),
  });
  assert.equal(result.setup.phases[0]?.state, phaseState);
}

async function configureHostedFounderCampaign(
  service: SyntheticAittaDBService,
  phaseState: "closed" | "open" = "open",
  founderContributionChoices?: readonly Readonly<{
    id: string;
    label: string;
  }>[],
): Promise<void> {
  const repository = new StorageCampaignRepository(hostedStorageAdapter(service));
  const current = await repository.readSetup();
  const expectedRevision = current?.revision ?? null;
  const result = await repository.saveSetup({
    operationId: `campaign-operation:hosted-founder-${phaseState}-${
      expectedRevision ?? "new"
    }`,
    expectedRevision,
    recordedAt: "2026-08-10T10:30:00.000Z",
    setup: {
      ...explicitCampaignSetup({ phaseState }),
      ...(founderContributionChoices === undefined
        ? {}
        : {
            campaignPolicy: {
              ...explicitCampaignSetup({ phaseState }).campaignPolicy,
              founderContributionChoices,
            },
          }),
    },
  });
  assert.equal(result.setup.phases[0]?.state, phaseState);
}

function hostedStorageAdapter(
  service: SyntheticAittaDBService,
): AittaDBStorageAdapter {
  return new AittaDBStorageAdapter({
    issuer: ISSUER,
    transportOrigin: TRANSPORT_ORIGIN,
    entryHref: ENTRY_HREF,
    accessToken: () => ACCESS_TOKEN,
    fetch: service.fetch,
  });
}

type TestWorker = ReturnType<typeof hostedPackageWorker>;
type TestAction = Readonly<{
  name: string;
  href: string;
  method: string;
  fields: readonly Readonly<{
    name: string;
    value?: unknown;
    default?: unknown;
    max_length?: number;
    max_bytes?: number;
    choices?: readonly Readonly<{ value: string; title: string }>[];
  }>[];
}>;

type FounderResourceResponse = Readonly<{
  document: FounderInterestDocument;
  csrfToken: string | null;
  cookie: string | null;
}>;

type InvestmentCollectionResponse = Readonly<{
  document: InvestmentInterestCollectionDocument;
  csrfToken: string | null;
  cookie: string | null;
}>;

type InvestmentItemResponse = Readonly<{
  document: InvestmentInterestItemDocument;
  csrfToken: string | null;
  cookie: string | null;
}>;

type InvestmentHtmlResponse = Readonly<{
  html: string;
  csrfToken: string;
  cookie: string;
}>;

type OwnerWorkspaceResponse = Readonly<{
  document: OwnerPackageDocument;
  csrfToken: string;
  cookie: string;
}>;

function investmentResource(
  worker: TestWorker,
  env: InvestorAppEnv,
): Promise<InvestmentCollectionResponse>;
function investmentResource(
  worker: TestWorker,
  env: InvestorAppEnv,
  pathname: string,
): Promise<InvestmentItemResponse>;
async function investmentResource(
  worker: TestWorker,
  env: InvestorAppEnv,
  pathname = INVESTMENT_INTEREST_PATH,
): Promise<InvestmentCollectionResponse | InvestmentItemResponse> {
  const response = await worker.fetch(
    participantRequest(pathname),
    env,
    executionContext,
  );
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  const proof = Object.freeze({
    document: await response.json() as
      | InvestmentInterestCollectionDocument
      | InvestmentInterestItemDocument,
    csrfToken: response.headers.get(MUTATION_CSRF_HEADER),
    cookie: setCookie === null ? null : cookieHeader(setCookie),
  });
  return proof as InvestmentCollectionResponse | InvestmentItemResponse;
}

async function submitInvestmentMutation(
  worker: TestWorker,
  env: InvestorAppEnv,
  resource: Readonly<{ csrfToken: string | null; cookie: string | null }>,
  action: TestAction,
  body: Readonly<Record<string, unknown>>,
  options: Readonly<{
    cookie?: string | null;
    csrfToken?: string | null;
    origin?: string;
    subject?: string;
    email?: string;
    accept?: "application/json" | "text/html";
  }> = {},
): Promise<Response> {
  const cookie = Object.hasOwn(options, "cookie")
    ? options.cookie ?? null
    : resource.cookie;
  const csrfToken = Object.hasOwn(options, "csrfToken")
    ? options.csrfToken ?? null
    : resource.csrfToken;
  const headers = new Headers({
    accept: options.accept ?? "application/json",
    "content-type": "application/json",
    origin: options.origin ?? APP_ORIGIN,
    "oai-authenticated-user-id": options.subject ?? PARTICIPANT_SUBJECT,
    "oai-authenticated-user-email": options.email ?? PARTICIPANT_EMAIL,
  });
  if (cookie !== null) headers.set("cookie", cookie);
  if (csrfToken !== null) headers.set(MUTATION_CSRF_HEADER, csrfToken);
  return worker.fetch(
    new Request(action.href, {
      method: action.method,
      headers,
      body: JSON.stringify(body),
    }),
    env,
    executionContext,
  );
}

async function investmentHtmlResource(
  worker: TestWorker,
  env: InvestorAppEnv,
  pathname = INVESTMENT_INTEREST_PATH,
): Promise<InvestmentHtmlResponse> {
  const response = await worker.fetch(
    participantHtmlRequest(pathname),
    env,
    executionContext,
  );
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert(setCookie);
  const html = await response.text();
  const tokens = [...html.matchAll(
    new RegExp(
      `<input name="${MUTATION_CSRF_FIELD}" type="hidden" value="([^"]+)">`,
      "gu",
    ),
  )].map((match) => match[1] ?? "");
  assert.ok(tokens.length > 0);
  assert.equal(new Set(tokens).size, 1);
  const csrfToken = tokens[0];
  assert(csrfToken);
  return Object.freeze({
    html,
    csrfToken,
    cookie: cookieHeader(setCookie),
  });
}

async function submitInvestmentForm(
  worker: TestWorker,
  env: InvestorAppEnv,
  resource: InvestmentHtmlResponse,
  action: TestAction,
  body: Readonly<Record<string, unknown>>,
): Promise<Response> {
  const form = new URLSearchParams();
  form.set(MUTATION_CSRF_FIELD, resource.csrfToken);
  if (action.method !== "POST") form.set(MUTATION_METHOD_FIELD, action.method);
  for (const [name, value] of Object.entries(body)) {
    if (value !== null && value !== undefined) form.set(name, String(value));
  }
  return worker.fetch(
    new Request(action.href, {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: resource.cookie,
        origin: APP_ORIGIN,
        "oai-authenticated-user-id": PARTICIPANT_SUBJECT,
        "oai-authenticated-user-email": PARTICIPANT_EMAIL,
      },
      body: form,
    }),
    env,
    executionContext,
  );
}

function investmentItemPath(operationId: string): string {
  return `${INVESTMENT_INTEREST_PATH}/${encodeURIComponent(operationId)}`;
}

function investmentHtmlActionNames(html: string): string[] {
  return [...html.matchAll(/\bdata-action-name="([^"]+)"/gu)]
    .map((match) => match[1] ?? "");
}

async function founderResource(
  worker: TestWorker,
  env: InvestorAppEnv,
  subject = PARTICIPANT_SUBJECT,
  email = PARTICIPANT_EMAIL,
): Promise<FounderResourceResponse> {
  const response = await worker.fetch(
    new Request(`${APP_ORIGIN}${FOUNDER_INTEREST_PATH}`, {
      headers: {
        accept: "application/json",
        "oai-authenticated-user-id": subject,
        "oai-authenticated-user-email": email,
      },
    }),
    env,
    executionContext,
  );
  assert.equal(response.status, 200);
  const csrfToken = response.headers.get(MUTATION_CSRF_HEADER);
  const setCookie = response.headers.get("set-cookie");
  return Object.freeze({
    document: await response.json() as FounderInterestDocument,
    csrfToken,
    cookie: setCookie === null ? null : cookieHeader(setCookie),
  });
}

async function submitFounderMutation(
  worker: TestWorker,
  env: InvestorAppEnv,
  resource: FounderResourceResponse,
  method: "POST" | "PATCH" | "DELETE",
  body: Readonly<Record<string, unknown>>,
  overrides: Readonly<{
    cookie?: string;
    csrfToken?: string;
    origin?: string;
    subject?: string;
    email?: string;
  }> = {},
): Promise<Response> {
  const cookie = Object.hasOwn(overrides, "cookie")
    ? overrides.cookie ?? ""
    : resource.cookie;
  const csrfToken = overrides.csrfToken ?? resource.csrfToken;
  if (cookie === null || csrfToken === null) {
    assert.fail("Founder mutation proof is unavailable.");
  }
  return worker.fetch(
    new Request(`${APP_ORIGIN}${FOUNDER_INTEREST_PATH}`, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie,
        origin: overrides.origin ?? APP_ORIGIN,
        [MUTATION_CSRF_HEADER]: csrfToken,
        "oai-authenticated-user-id": overrides.subject ?? PARTICIPANT_SUBJECT,
        "oai-authenticated-user-email": overrides.email ?? PARTICIPANT_EMAIL,
      },
      body: JSON.stringify(body),
    }),
    env,
    executionContext,
  );
}

async function submitUnsupportedFounderPut(
  worker: TestWorker,
  env: InvestorAppEnv,
  proof: Readonly<{ csrfToken: string | null; cookie: string | null }>,
  accept: "application/json" | "text/html",
  body: BodyInit,
): Promise<Response> {
  if (proof.cookie === null || proof.csrfToken === null) {
    assert.fail("Founder mutation proof is unavailable.");
  }
  return worker.fetch(
    new Request(`${APP_ORIGIN}${FOUNDER_INTEREST_PATH}`, {
      method: "PUT",
      headers: {
        accept,
        "content-type": accept === "application/json"
          ? "application/json"
          : "application/x-www-form-urlencoded",
        cookie: proof.cookie,
        origin: APP_ORIGIN,
        ...(accept === "application/json"
          ? { [MUTATION_CSRF_HEADER]: proof.csrfToken }
          : {}),
        "oai-authenticated-user-id": PARTICIPANT_SUBJECT,
        "oai-authenticated-user-email": PARTICIPANT_EMAIL,
      },
      body,
    }),
    env,
    executionContext,
  );
}

function founderFields(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    "expertise-summary": "Experience developing hosted data products.",
    "intended-contribution": "Contribute to product delivery and validation.",
    "primary-contribution-area-id": "area:engineering",
    [FOUNDER_SECONDARY_AREAS_FIELD]: ["area:product"],
    "approximate-availability": "Three days each week.",
    "possible-start-timing": "After mutual confirmation.",
    "compensation-expectation": "Open to discussion.",
    "professional-profile-links": "https://profiles.invalid/founder",
    note: "Initial hosted founder note.",
    ...overrides,
  });
}

function maximumHostedContributionChoices() {
  return Object.freeze(Array.from({ length: 17 }, (_, index) => Object.freeze({
    id: `area:${index}`,
    label: `Area ${index}`,
  })));
}

function maximumHostedFounderFields(
  character: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const profileLinks = Array.from({ length: 8 }, (_, index) => {
    const prefix = `https://profiles.invalid/${index}/`;
    return `${prefix}${character.repeat(2_048 - prefix.length)}`;
  });
  return founderFields({
    "expertise-summary": character.repeat(4_000),
    "intended-contribution": character.repeat(4_000),
    "primary-contribution-area-id": "area:0",
    [FOUNDER_SECONDARY_AREAS_FIELD]: Array.from(
      { length: 16 },
      (_, index) => `area:${index + 1}`,
    ),
    "approximate-availability": character.repeat(500),
    "possible-start-timing": character.repeat(500),
    "compensation-expectation": character.repeat(500),
    "professional-profile-links": profileLinks.join("\n"),
    note: character.repeat(4_000),
    ...overrides,
  });
}

type FounderHtmlProof = Readonly<{
  csrfToken: string;
  cookie: string;
  html: string;
}>;

async function founderHtmlResource(
  worker: TestWorker,
  env: InvestorAppEnv,
): Promise<FounderHtmlProof> {
  const response = await worker.fetch(
    new Request(`${APP_ORIGIN}${FOUNDER_INTEREST_PATH}`, {
      headers: {
        accept: "text/html",
        "oai-authenticated-user-id": PARTICIPANT_SUBJECT,
        "oai-authenticated-user-email": PARTICIPANT_EMAIL,
      },
    }),
    env,
    executionContext,
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  const csrfToken = /name="_csrf" type="hidden" value="([^"]+)"/u.exec(html)?.[1];
  const setCookie = response.headers.get("set-cookie");
  assert(csrfToken);
  assert(setCookie);
  return Object.freeze({
    csrfToken,
    cookie: cookieHeader(setCookie),
    html,
  });
}

function maximumFounderFormEntries(
  csrfToken: string,
  operationId: string,
  expectedRevision?: number,
): readonly (readonly [string, string])[] {
  return Object.freeze([
    [MUTATION_CSRF_FIELD, csrfToken] as const,
    ...(expectedRevision === undefined
      ? []
      : [
          [MUTATION_METHOD_FIELD, "PATCH"] as const,
          ["expected-revision", String(expectedRevision)] as const,
        ]),
    ["operation-id", operationId] as const,
    ["expertise-summary", "Maximum valid form expertise."] as const,
    ["intended-contribution", "Maximum valid form contribution."] as const,
    ["primary-contribution-area-id", "area:0"] as const,
    ...Array.from({ length: 16 }, (_, index) =>
      [FOUNDER_SECONDARY_AREAS_FIELD, `area:${index + 1}`] as const
    ),
    ["approximate-availability", "Three days each week."] as const,
    ["possible-start-timing", "After mutual confirmation."] as const,
    ["compensation-expectation", "Open to discussion."] as const,
    ["professional-profile-links", "https://profiles.invalid/founder"] as const,
    ["note", "All repeated fields are present."] as const,
  ]);
}

async function submitFounderHtmlMutation(
  worker: TestWorker,
  env: InvestorAppEnv,
  cookie: string,
  entries: readonly (readonly [string, string])[],
): Promise<Response> {
  const body = new URLSearchParams();
  for (const [name, value] of entries) body.append(name, value);
  return worker.fetch(
    new Request(`${APP_ORIGIN}${FOUNDER_INTEREST_PATH}`, {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        origin: APP_ORIGIN,
        "oai-authenticated-user-id": PARTICIPANT_SUBJECT,
        "oai-authenticated-user-email": PARTICIPANT_EMAIL,
      },
      body,
    }),
    env,
    executionContext,
  );
}

async function ownerWorkspace(
  worker: TestWorker,
  env: InvestorAppEnv,
): Promise<OwnerWorkspaceResponse> {
  const response = await worker.fetch(
    ownerRequest("/owner/package"),
    env,
    executionContext,
  );
  assert.equal(response.status, 200);
  const csrfToken = response.headers.get(MUTATION_CSRF_HEADER);
  const setCookie = response.headers.get("set-cookie");
  assert(csrfToken);
  assert(setCookie);
  return Object.freeze({
    document: await response.json() as OwnerPackageDocument,
    csrfToken,
    cookie: cookieHeader(setCookie),
  });
}

async function submitOwnerSection(
  worker: TestWorker,
  env: InvestorAppEnv,
  workspace: OwnerWorkspaceResponse,
  values: Readonly<{
    title: string;
    markdown: string;
    enabled: boolean;
    acknowledgmentText?: string;
    changeSummary: string;
    materialChange: boolean;
  }>,
): Promise<Response> {
  const action = requiredAction(
    workspace.document,
    "create-package-section",
  );
  const body = actionBody(action, {
    title: values.title,
    markdown: values.markdown,
    enabled: values.enabled,
    ...(values.acknowledgmentText === undefined
      ? {}
      : { "acknowledgment-text": values.acknowledgmentText }),
    "change-summary": values.changeSummary,
    "material-change": values.materialChange,
  });
  return worker.fetch(
    new Request(action.href, {
      method: action.method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie: workspace.cookie,
        origin: APP_ORIGIN,
        [MUTATION_CSRF_HEADER]: workspace.csrfToken,
        "oai-authenticated-user-id": OWNER.subject,
        "oai-authenticated-user-email": OWNER_EMAIL,
      },
      body: JSON.stringify(body),
    }),
    env,
    executionContext,
  );
}

async function submitOwnerBody(
  worker: TestWorker,
  env: InvestorAppEnv,
  workspace: OwnerWorkspaceResponse,
  action: TestAction,
  body: Readonly<Record<string, unknown>>,
): Promise<Response> {
  return worker.fetch(
    new Request(action.href, {
      method: action.method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie: workspace.cookie,
        origin: APP_ORIGIN,
        [MUTATION_CSRF_HEADER]: workspace.csrfToken,
        "oai-authenticated-user-id": OWNER.subject,
        "oai-authenticated-user-email": OWNER_EMAIL,
      },
      body: JSON.stringify(body),
    }),
    env,
    executionContext,
  );
}

type TestAcknowledgmentDocument = Readonly<{
  data: Readonly<{ status: "acceptance_required" | "satisfied" }>;
  actions: readonly TestAction[];
}>;

type HostedParticipantHomeDocument = Readonly<{
  data: Readonly<{
    display_name: string;
    account_email: string;
  }>;
}>;

type ParticipantRegistrationResponse = Readonly<{
  document: ParticipantRegistrationDocument;
  csrfToken: string | null;
  cookie: string | null;
}>;

type ParticipantProfileResponse = Readonly<{
  document: ParticipantProfileDocument;
  csrfToken: string | null;
  cookie: string | null;
}>;

async function participantProfile(
  worker: TestWorker,
  env: InvestorAppEnv,
): Promise<ParticipantProfileResponse> {
  return participantProfileFor(
    worker,
    env,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
  );
}

async function participantProfileFor(
  worker: TestWorker,
  env: InvestorAppEnv,
  subject: string,
  email: string,
): Promise<ParticipantProfileResponse> {
  const response = await worker.fetch(
    new Request(`${APP_ORIGIN}${PARTICIPANT_PROFILE_PATH}`, {
      headers: {
        accept: "application/json",
        "oai-authenticated-user-id": subject,
        "oai-authenticated-user-email": email,
      },
    }),
    env,
    executionContext,
  );
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  return Object.freeze({
    document: await response.json() as ParticipantProfileDocument,
    csrfToken: response.headers.get(MUTATION_CSRF_HEADER),
    cookie: setCookie === null ? null : cookieHeader(setCookie),
  });
}

async function submitProfile(
  worker: TestWorker,
  env: InvestorAppEnv,
  resource: ParticipantProfileResponse,
  action: TestAction,
  body: Readonly<Record<string, unknown>>,
): Promise<Response> {
  assert(resource.csrfToken);
  assert(resource.cookie);
  return worker.fetch(
    new Request(action.href, {
      method: action.method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie: resource.cookie,
        origin: APP_ORIGIN,
        [MUTATION_CSRF_HEADER]: resource.csrfToken,
        "oai-authenticated-user-id": PARTICIPANT_SUBJECT,
        "oai-authenticated-user-email": PARTICIPANT_EMAIL,
      },
      body: JSON.stringify(body),
    }),
    env,
    executionContext,
  );
}

async function submitProfileForm(
  worker: TestWorker,
  env: InvestorAppEnv,
  resource: ParticipantProfileResponse,
  action: TestAction,
  body: Readonly<Record<string, unknown>>,
): Promise<Response> {
  assert(resource.csrfToken);
  assert(resource.cookie);
  const fields = new URLSearchParams();
  fields.append(MUTATION_CSRF_FIELD, resource.csrfToken);
  if (action.method !== "POST") {
    fields.append(MUTATION_METHOD_FIELD, action.method);
  }
  for (const [name, value] of Object.entries(body)) {
    assert(
      typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean",
    );
    fields.append(name, String(value));
  }
  return worker.fetch(
    new Request(action.href, {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: resource.cookie,
        origin: APP_ORIGIN,
        "oai-authenticated-user-id": PARTICIPANT_SUBJECT,
        "oai-authenticated-user-email": PARTICIPANT_EMAIL,
      },
      body: fields,
    }),
    env,
    executionContext,
  );
}

async function participantRegistration(
  worker: TestWorker,
  env: InvestorAppEnv,
): Promise<ParticipantRegistrationResponse> {
  return participantRegistrationFor(
    worker,
    env,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
  );
}

async function participantRegistrationFor(
  worker: TestWorker,
  env: InvestorAppEnv,
  subject: string,
  email: string,
): Promise<ParticipantRegistrationResponse> {
  const response = await worker.fetch(
    new Request(`${APP_ORIGIN}${PARTICIPANT_REGISTRATION_PATH}`, {
      headers: {
        accept: "application/json",
        "oai-authenticated-user-id": subject,
        "oai-authenticated-user-email": email,
      },
    }),
    env,
    executionContext,
  );
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  return Object.freeze({
    document: await response.json() as ParticipantRegistrationDocument,
    csrfToken: response.headers.get(MUTATION_CSRF_HEADER),
    cookie: setCookie === null ? null : cookieHeader(setCookie),
  });
}

async function submitRegistration(
  worker: TestWorker,
  env: InvestorAppEnv,
  resource: ParticipantRegistrationResponse,
  body: Readonly<Record<string, unknown>>,
  options: Readonly<{
    cookie?: string | null;
    origin?: string;
    accept?: "application/json" | "text/html";
  }> = {},
): Promise<Response> {
  const action = requiredAction(
    resource.document,
    "register-participant-access",
  );
  assert(resource.csrfToken);
  const cookie = options.cookie === undefined ? resource.cookie : options.cookie;
  const headers = new Headers({
    accept: options.accept ?? "application/json",
    "content-type": "application/json",
    origin: options.origin ?? APP_ORIGIN,
    [MUTATION_CSRF_HEADER]: resource.csrfToken,
    "oai-authenticated-user-id": PARTICIPANT_SUBJECT,
    "oai-authenticated-user-email": PARTICIPANT_EMAIL,
  });
  if (cookie !== null) headers.set("cookie", cookie);
  return worker.fetch(
    new Request(action.href, {
      method: action.method,
      headers,
      body: JSON.stringify(body),
    }),
    env,
    executionContext,
  );
}

type ParticipantAcknowledgmentResponse = Readonly<{
  document: TestAcknowledgmentDocument;
  csrfToken: string | null;
  cookie: string | null;
}>;

async function participantAcknowledgment(
  worker: TestWorker,
  env: InvestorAppEnv,
): Promise<ParticipantAcknowledgmentResponse> {
  const response = await worker.fetch(
    participantRequest("/participant/package/acknowledgment"),
    env,
    executionContext,
  );
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  return Object.freeze({
    document: await response.json() as TestAcknowledgmentDocument,
    csrfToken: response.headers.get(MUTATION_CSRF_HEADER),
    cookie: setCookie === null ? null : cookieHeader(setCookie),
  });
}

async function submitAcknowledgment(
  worker: TestWorker,
  env: InvestorAppEnv,
  resource: ParticipantAcknowledgmentResponse,
  bodyOverride?: Readonly<Record<string, unknown>>,
): Promise<Response> {
  const action = requiredAction(
    resource.document,
    "acknowledge-current-package",
  );
  assert(resource.csrfToken);
  assert(resource.cookie);
  return worker.fetch(
    new Request(action.href, {
      method: action.method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie: resource.cookie,
        origin: APP_ORIGIN,
        [MUTATION_CSRF_HEADER]: resource.csrfToken,
        "oai-authenticated-user-id": PARTICIPANT_SUBJECT,
        "oai-authenticated-user-email": PARTICIPANT_EMAIL,
      },
      body: JSON.stringify(bodyOverride ?? actionBody(action, {})),
    }),
    env,
    executionContext,
  );
}

function requiredAction(
  document: Readonly<{ actions: readonly TestAction[] }>,
  name: string,
): TestAction {
  const action = document.actions.find((candidate) => candidate.name === name);
  assert(action, `Missing action ${name}.`);
  return action;
}

function actionBody(
  action: TestAction,
  overrides: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of action.fields) {
    const value = Object.hasOwn(overrides, field.name)
      ? overrides[field.name]
      : field.value ?? field.default;
    if (value !== undefined) body[field.name] = value;
  }
  return body;
}

function actionNames(
  document: Readonly<{ actions: readonly TestAction[] }>,
): string[] {
  return document.actions.map(({ name }) => name);
}

function ownerRequest(pathname: string): Request {
  return new Request(`${APP_ORIGIN}${pathname}`, {
    headers: {
      accept: "application/json",
      "oai-authenticated-user-id": OWNER.subject,
      "oai-authenticated-user-email": OWNER_EMAIL,
    },
  });
}

function participantRequest(pathname: string): Request {
  return participantRequestFor(
    pathname,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
  );
}

function participantHtmlRequest(pathname: string): Request {
  return new Request(`${APP_ORIGIN}${pathname}`, {
    headers: {
      accept: "text/html",
      "oai-authenticated-user-id": PARTICIPANT_SUBJECT,
      "oai-authenticated-user-email": PARTICIPANT_EMAIL,
    },
  });
}

function participantRequestFor(
  pathname: string,
  subject: string,
  email: string,
): Request {
  return new Request(`${APP_ORIGIN}${pathname}`, {
    headers: {
      accept: "application/json",
      "oai-authenticated-user-id": subject,
      "oai-authenticated-user-email": email,
    },
  });
}

function cookieHeader(setCookie: string): string {
  const value = setCookie.split(";", 1)[0];
  assert(value);
  return value;
}

function assertProfileMutationCookieLifecycle(
  response: Response,
  replacementExpected: boolean,
  consumedCookie: string | null,
): void {
  assert(consumedCookie);
  const separator = consumedCookie.indexOf("=");
  assert.ok(separator > 0);
  const consumedName = consumedCookie.slice(0, separator);
  const setCookie = response.headers.get("set-cookie") ?? "";
  assert.equal((setCookie.match(/Max-Age=0/gu) ?? []).length, 1);
  assert.equal(
    setCookie.split(`${consumedName}=`).length - 1,
    1,
  );
  assert.match(
    setCookie,
    new RegExp(`${consumedName}=; Path=/; Max-Age=0;`, "u"),
  );
  assert.equal(
    (setCookie.match(/__Host-investor_app_mutation_/gu) ?? []).length,
    replacementExpected ? 2 : 1,
  );
  assert.equal(
    (setCookie.match(/Max-Age=300/gu) ?? []).length,
    replacementExpected ? 1 : 0,
  );
}

function profileHtmlActionNames(html: string): string[] {
  return [...html.matchAll(/\bdata-action-name="([^"]+)"/gu)]
    .map((match) => match[1] ?? "");
}

function profileHtmlCsrfTokens(html: string): string[] {
  return [...html.matchAll(
    new RegExp(
      `<input name="${MUTATION_CSRF_FIELD}" type="hidden" value="([^"]+)">`,
      "gu",
    ),
  )].map((match) => match[1] ?? "");
}

function recordsIn(
  service: SyntheticAittaDBService,
  collection: string,
): SyntheticRecord[] {
  return [...service.records.values()].filter(
    (record) => record.key.collection === collection,
  );
}

function founderCollectionSnapshot(
  service: SyntheticAittaDBService,
): readonly SyntheticRecord[] {
  return Object.freeze(
    [...service.records.values()]
      .filter((record) =>
        record.key.collection.startsWith("founder-application")
      )
      .sort((left, right) => {
        const leftKey = `${left.key.collection}/${left.key.id}`;
        const rightKey = `${right.key.collection}/${right.key.id}`;
        return leftKey.localeCompare(rightKey);
      })
      .map(cloneSyntheticRecord),
  );
}

function configuredEnvironment(
  overrides: Partial<InvestorAppEnv> = {},
): InvestorAppEnv {
  return baseEnvironment({
    APP_BASE_URL: APP_ORIGIN,
    AITTADB_STORAGE_ISSUER: ISSUER,
    AITTADB_STORAGE_TRANSPORT_ORIGIN: TRANSPORT_ORIGIN,
    AITTADB_STORAGE_ENTRY_HREF: ENTRY_HREF,
    AITTADB_STORAGE_CLIENT_ID: SERVICE_CLIENT_ID,
    AITTADB_STORAGE_CLIENT_SECRET: SERVICE_CLIENT_SECRET,
    AITTADB_STORAGE_SCOPES: STORAGE_SCOPES,
    BROWSER_MUTATION_SESSION_KEY: MUTATION_KEY,
    ...overrides,
  });
}

function baseEnvironment(
  overrides: Partial<InvestorAppEnv> = {},
): InvestorAppEnv {
  return {
    ASSETS: { fetch: async () => new Response("asset") },
    IMAGES: {
      input: () => ({
        transform: () => ({
          output: async () => ({ response: new Response("image") }),
        }),
      }),
    },
    ...overrides,
  } as InvestorAppEnv;
}

function protocolResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE },
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function requiredObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected synthetic object.");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected synthetic string.");
  return value;
}

function keyMaterial(seed: number): string {
  const bytes = Uint8Array.from(
    { length: 32 },
    (_, index) => (seed + index) % 256,
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
