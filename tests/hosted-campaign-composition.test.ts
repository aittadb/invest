import assert from "node:assert/strict";
import test from "node:test";

import type { ActionJsonValue } from "../domain/hypermedia-action.ts";
import { StorageFailure } from "../domain/storage-adapter.ts";
import {
  CAMPAIGN_CONFIGURATION_HEADER,
  campaignFromRuntimeHeader,
} from "../http/runtime-campaign.ts";
import { MUTATION_CSRF_HEADER } from "../http/mutation-security.ts";
import { createApplicationWorker } from "../worker/application-worker.ts";
import type {
  InvestorAppEnv,
  WorkerExecutionContext,
} from "../worker/contracts.ts";
import { createHostedApplicationRuntimeResolver } from "../worker/hosted-application-composition.ts";
import {
  parseCampaignSetup,
  type AtomicCampaignAuditRepository,
  type CampaignSetup,
  type SaveCampaignSetupWithAuditRequest,
} from "../repositories/in-memory-campaign-repository.ts";
import { explicitCampaignSetup } from "./support/campaign-repository-contract.ts";
import {
  SyntheticAittaDBStorageService,
  type SyntheticAittaDBStorageServiceOptions,
} from "./support/synthetic-aittadb-storage-service.ts";

const APP_ORIGIN = "https://invest.example.test";
const ISSUER = "https://storage.example.test";
const TRANSPORT_ORIGIN = "https://storage-runtime.example.test";
const ENTRY_HREF = `${ISSUER}/bounded-storage`;
const SERVICE_CLIENT_ID = "investor-app-campaign-service";
const SERVICE_CLIENT_SECRET = "campaign-service-client-secret";
const ACCESS_TOKEN = "campaign-access-token-must-stay-private";
const STORAGE_SCOPES = "storage.read storage.write storage.delete";
const MUTATION_KEY = keyMaterial(61);
const OWNER_EMAIL = "owner@example.test";
const OWNER_SUBJECT = "owner-subject";
const FOREIGN_PROFILE_KEY =
  "private-participant-profiles/subject:ee1bd506c8e5801aa4de32eca0b5ee8e6bc9e92049eeac71a21f9ad35b6beb9c";
const NOW = new Date("2026-08-10T12:00:00.000Z");

const executionContext: WorkerExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

test("hosted campaign setup, editing, publication, restart, and concurrency stay persistent and scoped", async () => {
  const service = storageService();
  const blockedEnvironment = environment("false");
  const blockedResolver = resolver(service, 11);
  const blockedWorker = worker(blockedResolver);

  service.readKeys.length = 0;
  const anonymous = await blockedWorker.fetch(
    request("/owner/setup", { accept: "application/json" }),
    blockedEnvironment,
    executionContext,
  );
  assert.equal(anonymous.status, 401);
  assert.deepEqual(service.readKeys, [
    "campaign-public-presentation/configured-campaign",
  ]);
  assertPrivateMaterialAbsent(await anonymous.text());

  service.readKeys.length = 0;
  const foreign = await blockedWorker.fetch(
    request("/owner/setup", {
      accept: "application/json",
      userId: "foreign-subject",
      email: "foreign@example.test",
    }),
    blockedEnvironment,
    executionContext,
  );
  assert.equal(foreign.status, 404);
  assert.deepEqual(service.readKeys, [
    "campaign-public-presentation/configured-campaign",
    FOREIGN_PROFILE_KEY,
  ]);
  assertPrivateMaterialAbsent(await foreign.text());

  const setupHtml = await blockedWorker.fetch(
    ownerRequest("/owner/setup", "text/html"),
    blockedEnvironment,
    executionContext,
  );
  assert.equal(setupHtml.status, 200);
  assert.match(await setupHtml.text(), /<form[^>]+action="https:\/\/invest\.example\.test\/owner\/setup"/u);

  const setupResponse = await blockedWorker.fetch(
    ownerRequest("/owner/setup", "application/json"),
    blockedEnvironment,
    executionContext,
  );
  const setupProof = mutationProof(setupResponse);
  const setupDocument = await setupResponse.json();
  const createSetup = requiredAction(setupDocument, "create-campaign-setup");
  const fixtureSetup = explicitCampaignSetup();
  const setup = {
    ...fixtureSetup,
    publicCampaign: { ...fixtureSetup.publicCampaign, published: false },
  };
  const created = await blockedWorker.fetch(
    ownerMutation(
      "/owner/setup",
      {
        "operation-id": fieldValue(createSetup, "operation-id"),
        "expected-revision": null,
        "public-campaign": setup.publicCampaign,
        phases: setup.phases,
        "amount-aggregate": setup.amountAggregate,
        "campaign-policy": setup.campaignPolicy,
      },
      setupProof,
    ),
    blockedEnvironment,
    executionContext,
  );
  const createdBody = await created.text();
  assert.equal(created.status, 200, createdBody);
  const createdDocument = JSON.parse(createdBody);
  assert.equal(createdDocument.data.revision, 1);
  assert.equal(createdDocument.data.publication, "unpublished");
  assert.deepEqual(createdDocument.data.readiness.blockers, [
    "deployment-not-ready",
  ]);

  const setupPreview = await blockedWorker.fetch(
    ownerRequest("/owner/setup/preview", "application/json"),
    blockedEnvironment,
    executionContext,
  );
  assert.equal(setupPreview.status, 200);
  assert.equal((await setupPreview.json()).data.source_revision, 1);

  const ownerHome = await blockedWorker.fetch(
    ownerRequest("/owner", "application/json"),
    blockedEnvironment,
    executionContext,
  );
  const ownerHomeDocument = await ownerHome.json();
  assert.equal(hasLink(ownerHomeDocument, "campaign-setup"), true);
  assert.equal(hasLink(ownerHomeDocument, "campaign-editor"), true);

  const editor = await blockedWorker.fetch(
    ownerRequest("/owner/campaign", "application/json"),
    blockedEnvironment,
    executionContext,
  );
  const editorProof = mutationProof(editor);
  const editorDocument = await editor.json();
  assert.equal(editorDocument.data.publication_readiness.ready, false);
  assert.equal(hasAction(editorDocument, "publish-campaign"), false);
  const savePresentation = requiredAction(editorDocument, "save-campaign-presentation");
  const presentation = structuredClone(
    fieldValue(savePresentation, "public-campaign") as Record<string, unknown>,
  );
  presentation.pageTitle = "Hosted campaign preview";
  const edited = await blockedWorker.fetch(
    ownerMutation(
      "/owner/campaign",
      {
        ...actionCommand(savePresentation),
        "public-campaign": presentation,
      },
      editorProof,
    ),
    blockedEnvironment,
    executionContext,
  );
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).data.revision, 2);

  const blockedEditor = await blockedWorker.fetch(
    ownerRequest("/owner/campaign", "application/json"),
    blockedEnvironment,
    executionContext,
  );
  const blockedProof = mutationProof(blockedEditor);
  const blockedPublication = await blockedWorker.fetch(
    ownerMutation(
      "/owner/campaign/publication",
      {
        "operation-id": "campaign-publication:blocked-hosted-attempt",
        "expected-revision": 2,
        "publication-command": "publish",
      },
      blockedProof,
    ),
    blockedEnvironment,
    executionContext,
  );
  assert.equal(blockedPublication.status, 412);
  assert.equal((await blockedPublication.json()).data.code, "publication_not_ready");

  const readyEnvironment = environment("true");
  const readyResolver = resolver(service, 31);
  const readyWorker = worker(readyResolver);
  const readyEditor = await readyWorker.fetch(
    ownerRequest("/owner/campaign", "application/json"),
    readyEnvironment,
    executionContext,
  );
  const readyProof = mutationProof(readyEditor);
  const readyDocument = await readyEditor.json();
  const publish = requiredAction(readyDocument, "publish-campaign");
  const published = await readyWorker.fetch(
    ownerMutation(
      "/owner/campaign/publication",
      actionCommand(publish),
      readyProof,
    ),
    readyEnvironment,
    executionContext,
  );
  assert.equal(published.status, 200);
  assert.equal((await published.json()).data.publication, "published");

  service.readKeys.length = 0;
  const publicCampaign = await readyWorker.fetch(
    request("/", { accept: "application/json" }),
    readyEnvironment,
    executionContext,
  );
  const publicDocument = await publicCampaign.json();
  assert.equal(publicDocument.data.published, true);
  assert.equal(publicDocument.data.name, setup.publicCampaign.name);
  assert.deepEqual(service.readKeys, [
    "campaign-public-presentation/configured-campaign",
  ]);
  assertPrivateMaterialAbsent(JSON.stringify(publicDocument));

  const restartedEnvironment = environment("true");
  const restartedResolver = resolver(service, 51);
  const restartedWorker = worker(restartedResolver);
  const restartedPublic = await restartedWorker.fetch(
    request("/", { accept: "application/json" }),
    restartedEnvironment,
    executionContext,
  );
  assert.equal((await restartedPublic.json()).data.published, true);

  const restartedRuntime = await restartedResolver(restartedEnvironment);
  assert.ok(restartedRuntime);
  const repository = restartedRuntime.repositoryFactory.campaignRepository();
  const current = await repository.readSetup();
  assert.ok(current);
  assert.equal(current.revision, 3);
  const concurrentRequests = ["Alpha", "Beta"].map((suffix, index) => ({
    operationId: `campaign-operation:hosted-concurrent-${index + 1}`,
    ownerSubject: OWNER_SUBJECT,
    recordedAt: `2026-08-10T12:01:0${index}.000Z`,
    expectedRevision: current.revision,
    setup: {
      ...current.setup,
      publicCampaign: {
        ...current.setup.publicCampaign,
        name: `${current.setup.publicCampaign.name} ${suffix}`,
      },
    },
    transition: "updated" as const,
  }));
  const concurrent = await Promise.allSettled(
    concurrentRequests.map((candidate) => repository.saveSetupWithAudit(candidate)),
  );
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
  const failure = concurrent.find((result) => result.status === "rejected");
  assert(failure?.status === "rejected");
  assert(failure.reason instanceof StorageFailure);
  assert.equal(failure.reason.code, "PRECONDITION_FAILED");
  const winnerIndex = concurrent.findIndex((result) => result.status === "fulfilled");
  const winnerRequest = concurrentRequests[winnerIndex];
  assert.ok(winnerRequest);
  const replay = await repository.saveSetupWithAudit(winnerRequest);
  assert.equal(replay.replayed, true);
  assert.equal(replay.campaign.revision, 4);

  const history = await repository.listSetupHistory({ limit: 100 });
  assert.equal(history.items.length, 4);
  assert.deepEqual(history.items.map((item) => item.revision), [1, 2, 3, 4]);
  assert.equal(
    service.recordKeys().filter((storedKey) =>
      storedKey.startsWith("audit-events/")
    ).length,
    4,
  );

  const editorPreview = await restartedWorker.fetch(
    ownerRequest("/owner/campaign/preview", "application/json"),
    restartedEnvironment,
    executionContext,
  );
  assert.equal(editorPreview.status, 200);
  assert.equal((await editorPreview.json()).data.source_revision, 4);

  const publishedEditor = await restartedWorker.fetch(
    ownerRequest("/owner/campaign", "application/json"),
    restartedEnvironment,
    executionContext,
  );
  const unpublishProof = mutationProof(publishedEditor);
  const unpublish = requiredAction(await publishedEditor.json(), "unpublish-campaign");
  const unpublished = await restartedWorker.fetch(
    ownerMutation(
      "/owner/campaign/publication",
      actionCommand(unpublish),
      unpublishProof,
    ),
    restartedEnvironment,
    executionContext,
  );
  assert.equal(unpublished.status, 200);
  assert.equal((await unpublished.json()).data.publication, "unpublished");

  service.readKeys.length = 0;
  const hidden = await restartedWorker.fetch(
    request("/", { accept: "application/json" }),
    restartedEnvironment,
    executionContext,
  );
  assert.equal((await hidden.json()).data.published, false);
  assert.deepEqual(service.readKeys, [
    "campaign-public-presentation/configured-campaign",
  ]);
  const finalHistory = await repository.listSetupHistory({ limit: 100 });
  assert.deepEqual(finalHistory.items.map((item) => item.revision), [1, 2, 3, 4, 5]);
  assert.equal(
    service.recordKeys().filter((storedKey) =>
      storedKey.startsWith("audit-events/")
    ).length,
    5,
  );

  assert.equal(service.tokenRequests >= 3, true);
  assert.equal(service.discoveryRequests >= 3, true);
  assert.equal(service.transactionRequests > 10, true);
});

test("hosted campaign persistence chunks near-limit setup records and survives restart and retries", async () => {
  const service = storageService({
    limits: {
      max_record_bytes: 61_440,
      max_transaction_bytes: 65_536,
    },
  });
  const firstRuntime = await resolver(service, 83)(environment("true"));
  assert.ok(firstRuntime);
  const firstRepository = firstRuntime.repositoryFactory.campaignRepository();
  const setup = largeCampaignSetup("A");
  const setupBytes = byteLength(JSON.stringify(setup));
  assert.equal(setupBytes > 140_000, true);
  assert.equal(setupBytes < 262_144, true);
  const request = {
    operationId: "campaign-operation:near-limit-create",
    ownerSubject: OWNER_SUBJECT,
    recordedAt: "2026-08-10T12:10:00.000Z",
    expectedRevision: null,
    setup,
    transition: "created" as const,
  };

  const created = await firstRepository.saveSetupWithAudit(request);
  assert.equal(created.campaign.revision, 1);
  assert.equal(created.replayed, false);
  assert.equal(service.largestRecordBytes > 60_000, true);
  assert.equal(service.largestRecordBytes <= 61_440, true);
  assert.equal(service.largestTransactionBytes > 60_000, true);
  assert.equal(service.largestTransactionBytes <= 65_536, true);
  assert.equal(
    service.recordKeys().filter((storedKey) =>
      storedKey.startsWith("campaign-setup-chunks/")
    ).length,
    4,
  );

  const restartedRuntime = await resolver(service, 89)(environment("true"));
  assert.ok(restartedRuntime);
  const restarted = restartedRuntime.repositoryFactory.campaignRepository();
  assert.deepEqual(await restarted.readSetup(), created.campaign);
  const replay = await restarted.saveSetupWithAudit(request);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.campaign, created.campaign);

  await assert.rejects(
    restarted.saveSetupWithAudit({
      ...request,
      setup: largeCampaignSetup("B"),
    }),
    (error) => error instanceof StorageFailure && error.code === "CONFLICT",
  );
  assert.deepEqual(await restarted.readSetup(), created.campaign);
  assert.equal(
    service.recordKeys().filter((storedKey) =>
      storedKey.startsWith("campaign-setup-current/") ||
      storedKey.startsWith("campaign-setup-history/") ||
      storedKey.startsWith("campaign-setup-operations/") ||
      storedKey.startsWith("campaign-public-presentation/") ||
      storedKey.startsWith("audit-events/")
    ).length,
    5,
  );
});

test("hosted campaign intent rejects changed retries before resuming a failed chunk stage", async () => {
  let rejectSecondChunk = true;
  const service = storageService({
    limits: {
      max_record_bytes: 61_440,
      max_transaction_bytes: 65_536,
    },
    rejectTransaction(operationId) {
      if (
        rejectSecondChunk &&
        operationId.startsWith("campaign-chunk-stage:") &&
        operationId.endsWith(":0001")
      ) {
        rejectSecondChunk = false;
        return "unavailable";
      }
      return null;
    },
  });
  const runtime = await resolver(service, 97)(environment("true"));
  assert.ok(runtime);
  const repository = runtime.repositoryFactory.campaignRepository();
  const request = {
    operationId: "campaign-operation:failed-chunk-stage",
    ownerSubject: OWNER_SUBJECT,
    recordedAt: "2026-08-10T12:20:00.000Z",
    expectedRevision: null,
    setup: largeCampaignSetup("C"),
    transition: "created" as const,
  };

  await assert.rejects(
    repository.saveSetupWithAudit(request),
    (error) => error instanceof StorageFailure && error.code === "UNAVAILABLE",
  );
  assert.equal(service.recordCount(), 2);
  assert.equal(
    service.recordKeys().filter((storedKey) =>
      storedKey.startsWith("campaign-setup-intents/")
    ).length,
    1,
  );
  assert.equal(
    service.recordKeys().every((storedKey) =>
      storedKey.startsWith("campaign-setup-intents/") ||
      storedKey.startsWith("campaign-setup-chunks/")
    ),
    true,
  );

  const restartedRuntime = await resolver(service, 101)(environment("true"));
  assert.ok(restartedRuntime);
  const restarted = restartedRuntime.repositoryFactory.campaignRepository();
  assert.equal(
    await restarted.readSetup(),
    null,
  );
  assert.equal(
    await restartedRuntime.repositoryFactory
      .publicCampaignReader()
      .readPublishedCampaign(),
    null,
  );

  await assertChangedCampaignRetriesConflict(
    restarted,
    service,
    request,
    largeCampaignSetup("D"),
  );

  const resumed = await restarted.saveSetupWithAudit(request);
  assert.equal(resumed.replayed, false);
  assert.equal(resumed.campaign.revision, 1);
  const exactRestart = await resolver(service, 107)(environment("true"));
  assert.ok(exactRestart);
  const replay = await exactRestart.repositoryFactory
    .campaignRepository()
    .saveSetupWithAudit(request);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.campaign, resumed.campaign);
  assert.equal(
    service.transactionOperationIds.filter((operationId) =>
      operationId.startsWith("campaign-intent-claim:")
    ).length,
    1,
  );
});

test("hosted campaign intent rejects changed retries after a committed final response failure", async () => {
  const operationId = "campaign-operation:failed-final-response";
  let failFinalResponse = true;
  const service = storageService({
    limits: {
      max_record_bytes: 61_440,
      max_transaction_bytes: 65_536,
    },
    failCommittedTransaction(candidate) {
      if (failFinalResponse && candidate === operationId) {
        failFinalResponse = false;
        return "unavailable";
      }
      return null;
    },
  });
  const runtime = await resolver(service, 109)(environment("true"));
  assert.ok(runtime);
  const repository = runtime.repositoryFactory.campaignRepository();
  const request = {
    operationId,
    ownerSubject: OWNER_SUBJECT,
    recordedAt: "2026-08-10T12:30:00.000Z",
    expectedRevision: null,
    setup: largeCampaignSetup("E"),
    transition: "created" as const,
  };

  await assert.rejects(
    repository.saveSetupWithAudit(request),
    (error) => error instanceof StorageFailure && error.code === "UNAVAILABLE",
  );

  const restartedRuntime = await resolver(service, 113)(environment("true"));
  assert.ok(restartedRuntime);
  const restarted = restartedRuntime.repositoryFactory.campaignRepository();
  assert.equal((await restarted.readSetup())?.revision, 1);
  assert.equal(
    (await restartedRuntime.repositoryFactory
      .publicCampaignReader()
      .readPublishedCampaign()),
    null,
  );
  assert.equal(
    service.recordKeys().filter((storedKey) =>
      storedKey.startsWith("campaign-setup-current/") ||
      storedKey.startsWith("campaign-setup-history/") ||
      storedKey.startsWith("campaign-setup-operations/") ||
      storedKey.startsWith("campaign-public-presentation/") ||
      storedKey.startsWith("audit-events/")
    ).length,
    5,
  );

  await assertChangedCampaignRetriesConflict(
    restarted,
    service,
    request,
    largeCampaignSetup("F"),
  );

  const replay = await restarted.saveSetupWithAudit(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.campaign.revision, 1);
  assert.equal(
    service.transactionOperationIds.filter((candidate) =>
      candidate.startsWith("campaign-intent-claim:")
    ).length,
    1,
  );
});

test("hosted parser failure clears a consumed mutation cookie only once", async () => {
  const service = storageService();
  const hostedEnvironment = environment("false");
  const application = worker(resolver(service, 103));
  const setup = await application.fetch(
    ownerRequest("/owner/setup", "application/json"),
    hostedEnvironment,
    executionContext,
  );
  const proof = mutationProof(setup);
  const malformedBody = {
    "operation-id": "owner-setup:malformed-cookie-test",
    "expected-revision": null,
    "public-campaign": {},
    phases: [],
    "amount-aggregate": {},
    "campaign-policy": {},
  };

  const failed = await application.fetch(
    ownerMutation("/owner/setup", malformedBody, proof),
    hostedEnvironment,
    executionContext,
  );
  assert.equal(failed.status, 400);
  const cookieName = proof.cookie.slice(0, proof.cookie.indexOf("="));
  assert.equal(
    failed.headers.get("set-cookie"),
    `${cookieName}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Strict`,
  );

  const replayedFailure = await application.fetch(
    ownerMutation("/owner/setup", malformedBody, proof),
    hostedEnvironment,
    executionContext,
  );
  assert.equal(replayedFailure.status, 403);
  assert.equal(replayedFailure.headers.get("set-cookie"), null);
  assert.equal(
    service.recordKeys().filter((storedKey) =>
      storedKey.startsWith("browser-mutation-replays/")
    ).length,
    1,
  );
});

test("malformed hosted readiness installs no campaign authority or scalar fallback", async () => {
  const service = storageService();
  const malformed = environment("yes");
  malformed.CAMPAIGN_CONFIG_JSON = JSON.stringify(
    explicitCampaignSetup().publicCampaign,
  );
  const rendered: Request[] = [];
  const application = createApplicationWorker({
    fetchApplication: async (request) => {
      rendered.push(request);
      return new Response("application fallback", { status: 418 });
    },
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: resolver(service, 71),
  });

  const ownerSetup = await application.fetch(
    ownerRequest("/owner/setup", "application/json"),
    malformed,
    executionContext,
  );
  assert.equal(ownerSetup.status, 418);
  assert.equal(await ownerSetup.text(), "application fallback");

  const root = await application.fetch(
    request("/", { accept: "application/json" }),
    malformed,
    executionContext,
  );
  assert.equal((await root.json()).data.published, false);
  assert.equal(service.tokenRequests, 0);
  assert.equal(service.discoveryRequests, 0);
  assert.equal(service.transactionRequests, 0);
  assert.equal(rendered.length, 1);
});

test("an installed hosted resolver preserves scalar fixtures only without runtime values", async () => {
  const service = storageService();
  const scalarEnvironment: InvestorAppEnv = {
    APP_BASE_URL: APP_ORIGIN,
    OWNER_EMAIL,
    CAMPAIGN_CONFIG_JSON: JSON.stringify(
      explicitCampaignSetup().publicCampaign,
    ),
    ASSETS: { fetch: async () => new Response("asset") },
    IMAGES: {
      input: () => ({
        transform: () => ({
          output: async () => ({ response: () => new Response("image") }),
        }),
      }),
    },
  };
  const application = worker(resolver(service, 79));

  const root = await application.fetch(
    request("/", { accept: "application/json" }),
    scalarEnvironment,
    executionContext,
  );
  const document = await root.json();
  assert.equal(root.status, 200);
  assert.equal(document.data.published, true);
  assert.equal(
    document.data.name,
    explicitCampaignSetup().publicCampaign.name,
  );
  assert.equal(service.tokenRequests, 0);
  assert.equal(service.discoveryRequests, 0);
  assert.equal(service.transactionRequests, 0);
});

function worker(
  resolveApplicationRuntime: ReturnType<typeof createHostedApplicationRuntimeResolver>,
) {
  return createApplicationWorker({
    fetchApplication: async (request) => {
      const campaign = campaignFromRuntimeHeader(
        request.headers.get(CAMPAIGN_CONFIGURATION_HEADER),
      );
      return new Response(
        `<main><h1>${campaign?.name ?? "Campaign unavailable"}</h1></main>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime,
  });
}

function resolver(service: SyntheticAittaDBStorageService, seed: number) {
  let randomCall = seed;
  return createHostedApplicationRuntimeResolver({
    fetch: service.fetch,
    now: () => NOW,
    randomBytes(length) {
      randomCall += 1;
      return Uint8Array.from(
        { length },
        (_, index) => (randomCall * 37 + index) % 256,
      );
    },
  });
}

function storageService(
  overrides: Pick<
    SyntheticAittaDBStorageServiceOptions,
    "limits" | "rejectTransaction" | "failCommittedTransaction"
  > = {},
): SyntheticAittaDBStorageService {
  return new SyntheticAittaDBStorageService({
    issuer: ISSUER,
    transportOrigin: TRANSPORT_ORIGIN,
    entryHref: ENTRY_HREF,
    clientId: SERVICE_CLIENT_ID,
    clientSecret: SERVICE_CLIENT_SECRET,
    accessToken: ACCESS_TOKEN,
    scopes: STORAGE_SCOPES,
    ...overrides,
  });
}

async function assertChangedCampaignRetriesConflict(
  repository: AtomicCampaignAuditRepository,
  service: SyntheticAittaDBStorageService,
  request: SaveCampaignSetupWithAuditRequest,
  changedSetup: CampaignSetup,
): Promise<void> {
  const transactionCount = service.transactionOperationIds.length;
  const changedRequests: readonly SaveCampaignSetupWithAuditRequest[] = [
    { ...request, setup: changedSetup },
    { ...request, ownerSubject: "changed-owner-subject" },
    { ...request, recordedAt: "2026-08-10T12:59:00.000Z" },
    { ...request, transition: "updated" },
    { ...request, expectedRevision: 1 },
  ];
  for (const changed of changedRequests) {
    await assert.rejects(
      repository.saveSetupWithAudit(changed),
      (error) => error instanceof StorageFailure && error.code === "CONFLICT",
    );
  }
  await assert.rejects(
    repository.saveSetup({
      operationId: request.operationId,
      recordedAt: request.recordedAt,
      expectedRevision: request.expectedRevision,
      setup: request.setup,
    }),
    (error) => error instanceof StorageFailure && error.code === "CONFLICT",
  );
  assert.equal(service.transactionOperationIds.length, transactionCount);
}

function largeCampaignSetup(marker: string): CampaignSetup {
  const base = explicitCampaignSetup();
  const countries = Array.from(
    { length: 26 * 26 },
    (_, index) =>
      String.fromCharCode(65 + Math.floor(index / 26)) +
      String.fromCharCode(65 + index % 26),
  );
  const candidate = {
    ...base,
    publicCampaign: { ...base.publicCampaign, published: false },
    phases: Array.from({ length: 32 }, (_, index) => ({
      id: `phase:large-${String(index).padStart(2, "0")}`,
      state: "open",
      enabledParticipationPaths: ["investor", "founder"],
      countryEligibility: { mode: "allow", countries },
    })),
    campaignPolicy: {
      ...base.campaignPolicy,
      founderContributionChoices: Array.from({ length: 64 }, (_, index) => ({
        id: `area:large-${String(index).padStart(2, "0")}`,
        label: `${marker}${String(index).padStart(2, "0")}${"L".repeat(117)}`,
      })),
      notices: {
        ...base.campaignPolicy.notices,
        legalBoundary: marker.repeat(4_000),
        nonBindingInterest: "B".repeat(4_000),
        processEmail: "C".repeat(4_000),
        marketingConsent: "D".repeat(4_000),
        retention: "E".repeat(4_000),
      },
    },
  };
  const parsed = parseCampaignSetup(candidate);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("Invalid near-limit campaign setup fixture.");
  return parsed.value;
}

function environment(readiness: string): InvestorAppEnv {
  return {
    APP_BASE_URL: APP_ORIGIN,
    OWNER_EMAIL,
    AITTADB_STORAGE_ISSUER: ISSUER,
    AITTADB_STORAGE_TRANSPORT_ORIGIN: TRANSPORT_ORIGIN,
    AITTADB_STORAGE_ENTRY_HREF: ENTRY_HREF,
    AITTADB_STORAGE_CLIENT_ID: SERVICE_CLIENT_ID,
    AITTADB_STORAGE_CLIENT_SECRET: SERVICE_CLIENT_SECRET,
    AITTADB_STORAGE_SCOPES: STORAGE_SCOPES,
    BROWSER_MUTATION_SESSION_KEY: MUTATION_KEY,
    DEPLOYMENT_PUBLICATION_READY: readiness,
    ASSETS: { fetch: async () => new Response("asset") },
    IMAGES: {
      input: () => ({
        transform: () => ({
          output: async () => ({ response: () => new Response("image") }),
        }),
      }),
    },
  };
}

function request(
  pathname: string,
  options: Readonly<{
    accept?: string;
    userId?: string;
    email?: string;
  }> = {},
): Request {
  return new Request(`${APP_ORIGIN}${pathname}`, {
    headers: {
      ...(options.accept ? { Accept: options.accept } : {}),
      ...(options.userId ? { "oai-authenticated-user-id": options.userId } : {}),
      ...(options.email ? { "oai-authenticated-user-email": options.email } : {}),
    },
  });
}

function ownerRequest(pathname: string, accept: string): Request {
  return request(pathname, {
    accept,
    userId: OWNER_SUBJECT,
    email: OWNER_EMAIL,
  });
}

function ownerMutation(
  pathname: string,
  body: unknown,
  proof: Readonly<{ token: string; cookie: string }>,
): Request {
  return new Request(`${APP_ORIGIN}${pathname}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: proof.cookie,
      Origin: APP_ORIGIN,
      [MUTATION_CSRF_HEADER]: proof.token,
      "oai-authenticated-user-id": OWNER_SUBJECT,
      "oai-authenticated-user-email": OWNER_EMAIL,
    },
    body: JSON.stringify(body),
  });
}

function mutationProof(
  response: Response,
): Readonly<{ token: string; cookie: string }> {
  const token = response.headers.get(MUTATION_CSRF_HEADER);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(token);
  assert.ok(setCookie);
  const cookie = setCookie.split(";", 1)[0];
  assert.ok(cookie);
  return Object.freeze({ token, cookie });
}

type Action = Readonly<{
  name: string;
  fields: readonly Readonly<{
    name: string;
    value?: ActionJsonValue;
    default?: ActionJsonValue;
  }>[];
}>;

function requiredAction(
  document: Readonly<{ actions: readonly Action[] }>,
  name: string,
): Action {
  const action = document.actions.find((candidate) => candidate.name === name);
  assert.ok(action);
  return action;
}

function hasAction(
  document: Readonly<{ actions: readonly Action[] }>,
  name: string,
): boolean {
  return document.actions.some((candidate) => candidate.name === name);
}

function hasLink(
  document: Readonly<{ links: readonly Readonly<{ rel: readonly string[] }>[] }>,
  relation: string,
): boolean {
  return document.links.some((link) => link.rel.includes(relation));
}

function fieldValue(action: Action, name: string): ActionJsonValue {
  const field = action.fields.find((candidate) => candidate.name === name);
  assert.ok(field);
  const value = field.value ?? field.default;
  assert.notEqual(value, undefined);
  return value as ActionJsonValue;
}

function actionCommand(action: Action): Record<string, ActionJsonValue> {
  return Object.fromEntries(
    action.fields.map((field) => [field.name, fieldValue(action, field.name)]),
  );
}

function assertPrivateMaterialAbsent(value: string): void {
  for (const privateValue of [
    SERVICE_CLIENT_ID,
    SERVICE_CLIENT_SECRET,
    ACCESS_TOKEN,
    MUTATION_KEY,
    ISSUER,
    TRANSPORT_ORIGIN,
    OWNER_SUBJECT,
  ]) {
    assert.equal(value.includes(privateValue), false);
  }
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

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
