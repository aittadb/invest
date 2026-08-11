import assert from "node:assert/strict";
import test from "node:test";

import { parseAmountAggregateConfiguration } from "../domain/amount-aggregate-configuration.ts";
import { parseActorSubject, parseStableId, type ActorSubject } from "../domain/foundation.ts";
import type {
  InvestmentIndicationId,
  TrustedPackageAcknowledgmentContext,
} from "../domain/investment-indication.ts";
import type {
  OwnerIndicationCollectionDocument,
  OwnerIndicationDetailDocument,
} from "../domain/owner-indication-moderation-resource.ts";
import {
  createPackageAcceptance,
  createPackageVersion,
} from "../domain/package-content.ts";
import type { PublicCampaignDocument } from "../domain/public-campaign-resource.ts";
import { MUTATION_CSRF_HEADER } from "../http/mutation-security.ts";
import { OWNER_INDICATION_MODERATION_HEADER } from "../http/runtime-capabilities.ts";
import { AittaDBStorageAdapter } from "../repositories/aittadb-storage-adapter.ts";
import { StorageCampaignRepository } from "../repositories/in-memory-campaign-repository.ts";
import {
  StorageParticipantInvestmentInterestRepository,
  initializeParticipantInvestmentOwnership,
} from "../repositories/storage-participant-investment-repository.ts";
import { createApplicationWorker } from "../worker/application-worker.ts";
import type {
  InvestorAppEnv,
  WorkerExecutionContext,
} from "../worker/contracts.ts";
import { createHostedApplicationRuntimeResolver } from "../worker/hosted-application-composition.ts";
import { createParticipantInvestmentInterestService } from "../worker/investment-interest-service.ts";
import {
  campaignSaveRequest,
  explicitCampaignSetup,
} from "./support/campaign-repository-contract.ts";
import { SyntheticAittaDBStorageService } from "./support/synthetic-aittadb-storage-service.ts";

const APP_ORIGIN = "https://invest.example.test";
const ISSUER = "https://storage.example.test";
const TRANSPORT_ORIGIN = "https://storage-runtime.example.test";
const ENTRY_HREF = `${ISSUER}/bounded-storage`;
const CLIENT_ID = "investor-app-service";
const CLIENT_SECRET = "test-service-secret-material";
const ACCESS_TOKEN = "test-storage-access-token";
const STORAGE_SCOPES = "storage.read storage.write storage.delete";
const OWNER_EMAIL = "owner@example.test";
const OWNER_SUBJECT = "sites-owner-subject";
const PARTICIPANT = subject("sites-investor-participant");
const PRIVATE_NOTE = "Private hosted indication note.";
const NOW = new Date("2026-08-12T12:00:00.000Z");

const executionContext: WorkerExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

test("hosted owner moderation persists opaque review and atomic rejection", async () => {
  const service = storageService();
  const storage = storageAdapter(service);
  await seedCampaign(storage);
  await seedIndication(storage);
  const env = configuredEnvironment();
  const firstWorker = hostedWorker(service, []);

  const publicBefore = await publicCampaign(firstWorker, env);
  assert.equal(publicBefore.data.aggregate_interest?.amount_minor_units, 25_000);

  const collectionResponse = await firstWorker.fetch(
    ownerRequest("/owner/investment-indications?page_size=1"),
    env,
    executionContext,
  );
  assert.equal(collectionResponse.status, 200);
  assert.equal(collectionResponse.headers.get("cache-control"), "no-store");
  const collection = await collectionResponse.json() as
    OwnerIndicationCollectionDocument;
  assert.equal(collection.data.items.length, 1);
  const summary = collection.data.items[0];
  assert(summary);
  assert.deepEqual(Object.keys(summary), [
    "review_id",
    "kind",
    "status",
    "amount",
    "currency",
    "updated_at",
    "revision",
  ]);
  assert.match(summary.review_id, /^oiri\.v1\./u);
  assert.equal(summary.status, "active");
  assert.equal(summary.amount, 25_000);
  assert.equal(summary.currency, "SEK");
  assert.doesNotMatch(
    JSON.stringify(collection),
    /sites-investor-participant|Private hosted indication note/u,
  );

  const htmlCollectionResponse = await firstWorker.fetch(
    ownerRequest("/owner/investment-indications", "text/html"),
    env,
    executionContext,
  );
  assert.equal(htmlCollectionResponse.status, 200);
  const htmlCollection = await htmlCollectionResponse.text();
  assert.match(htmlCollection, /Investment indications/u);
  assert.match(htmlCollection, /25,?000 SEK/u);
  assert.doesNotMatch(
    htmlCollection,
    /sites-investor-participant|Private hosted indication note/u,
  );

  const detailPath = `/owner/investment-indications/${
    encodeURIComponent(summary.review_id)
  }`;
  const restartedWorker = hostedWorker(service, []);
  const detailResponse = await restartedWorker.fetch(
    ownerRequest(detailPath),
    env,
    executionContext,
  );
  assert.equal(detailResponse.status, 200);
  const csrf = detailResponse.headers.get(MUTATION_CSRF_HEADER);
  const setCookie = detailResponse.headers.get("set-cookie");
  assert(csrf);
  assert(setCookie);
  const detail = await detailResponse.json() as OwnerIndicationDetailDocument;
  assert.equal(detail.data.status, "active");
  assert.equal(detail.data.participant_subject, PARTICIPANT);
  assert.equal(detail.data.note, PRIVATE_NOTE);
  const retryProofResponse = await restartedWorker.fetch(
    ownerRequest(detailPath),
    env,
    executionContext,
  );
  assert.equal(retryProofResponse.status, 200);
  const retryCsrf = retryProofResponse.headers.get(MUTATION_CSRF_HEADER);
  const retrySetCookie = retryProofResponse.headers.get("set-cookie");
  assert(retryCsrf);
  assert(retrySetCookie);
  const reject = detail.actions.find((action) =>
    action.name === "reject-investment-indication"
  );
  assert(reject);
  const operationId = actionFieldValue(reject, "operation-id");
  const expectedRevision = actionFieldValue(reject, "expected-revision");
  const transactionsBefore = service.transactionRequests;

  const rejectedResponse = await restartedWorker.fetch(
    new Request(reject.href, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie: cookieHeader(setCookie),
        origin: APP_ORIGIN,
        [MUTATION_CSRF_HEADER]: csrf,
        "oai-authenticated-user-id": OWNER_SUBJECT,
        "oai-authenticated-user-email": OWNER_EMAIL,
      },
      body: JSON.stringify({
        "operation-id": operationId,
        "expected-revision": expectedRevision,
        reason: "Outside the current review scope.",
      }),
    }),
    env,
    executionContext,
  );
  assert.equal(rejectedResponse.status, 200);
  assert.match(rejectedResponse.headers.get("set-cookie") ?? "", /Max-Age=0/iu);
  const rejected = await rejectedResponse.json() as OwnerIndicationDetailDocument;
  assert.equal(rejected.data.status, "rejected");
  assert.equal(
    rejected.data.rejection?.reason,
    "Outside the current review scope.",
  );
  assert.deepEqual(rejected.actions, []);
  assert.equal(service.transactionRequests, transactionsBefore + 2);
  const nonReplayRecordsAfterCommit = service.recordKeys()
    .filter((key) => !key.startsWith("browser-mutation-replays/"))
    .sort();
  const retriedResponse = await hostedWorker(service, []).fetch(
    new Request(reject.href, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie: cookieHeader(retrySetCookie),
        origin: APP_ORIGIN,
        [MUTATION_CSRF_HEADER]: retryCsrf,
        "oai-authenticated-user-id": OWNER_SUBJECT,
        "oai-authenticated-user-email": OWNER_EMAIL,
      },
      body: JSON.stringify({
        "operation-id": operationId,
        "expected-revision": expectedRevision,
        reason: "Outside the current review scope.",
      }),
    }),
    env,
    executionContext,
  );
  assert.equal(retriedResponse.status, 200);
  assert.match(retriedResponse.headers.get("set-cookie") ?? "", /Max-Age=0/iu);
  assert.equal(
    (await retriedResponse.json() as OwnerIndicationDetailDocument).data.status,
    "rejected",
  );
  assert.equal(service.transactionRequests, transactionsBefore + 3);
  assert.deepEqual(
    service.recordKeys()
      .filter((key) => !key.startsWith("browser-mutation-replays/"))
      .sort(),
    nonReplayRecordsAfterCommit,
  );
  for (const collectionName of [
    "investment-indications",
    "investment-aggregate-states",
    "investment-aggregate-contributions",
    "audit-events",
    "manual-notifications",
    "owner-indication-moderation-operations",
  ]) {
    assert.ok(
      service.recordKeys().some((key) => key.startsWith(`${collectionName}/`)),
      collectionName,
    );
  }

  const publicAfter = await publicCampaign(hostedWorker(service, []), env);
  assert.equal(publicAfter.data.aggregate_interest, null);
  const restartedDetail = await hostedWorker(service, []).fetch(
    ownerRequest(detailPath),
    env,
    executionContext,
  );
  assert.equal(restartedDetail.status, 200);
  assert.equal(
    (await restartedDetail.json() as OwnerIndicationDetailDocument).data.status,
    "rejected",
  );
});

test("hosted moderation authorization, origin, and proof failures disclose nothing", async () => {
  const service = storageService();
  const storage = storageAdapter(service);
  await seedCampaign(storage);
  await seedIndication(storage);
  const env = configuredEnvironment();
  const rendered: Request[] = [];
  const worker = hostedWorker(service, rendered);
  const listsBefore = service.listCollections.length;

  const anonymous = await worker.fetch(
    new Request(`${APP_ORIGIN}/owner/investment-indications`, {
      headers: { accept: "application/json" },
    }),
    env,
    executionContext,
  );
  assert.equal(anonymous.status, 401);
  const foreign = await worker.fetch(
    new Request(`${APP_ORIGIN}/owner/investment-indications`, {
      headers: {
        accept: "application/json",
        "oai-authenticated-user-id": "sites-foreign-user",
        "oai-authenticated-user-email": "foreign@example.test",
      },
    }),
    env,
    executionContext,
  );
  assert.equal(foreign.status, 404);
  assert.equal(service.listCollections.length, listsBefore);
  assert.doesNotMatch(
    `${await anonymous.text()}${await foreign.text()}`,
    /sites-investor-participant|Private hosted indication note/u,
  );

  const home = await worker.fetch(ownerRequest("/owner"), env, executionContext);
  assert.equal(home.status, 200);
  const homeDocument = await home.json() as {
    links: readonly Readonly<{ rel: readonly string[]; href: string }>[];
  };
  assert.ok(homeDocument.links.some((link) =>
    link.rel.includes("investment-indications") &&
    link.href === `${APP_ORIGIN}/owner/investment-indications`
  ));
  const htmlHome = await worker.fetch(
    ownerRequest("/owner", "text/html"),
    env,
    executionContext,
  );
  assert.equal(htmlHome.status, 404);
  assert.equal(
    rendered.at(-1)?.headers.get(OWNER_INDICATION_MODERATION_HEADER),
    "available",
  );

  const collectionResponse = await worker.fetch(
    ownerRequest("/owner/investment-indications"),
    env,
    executionContext,
  );
  const collection = await collectionResponse.json() as
    OwnerIndicationCollectionDocument;
  const reviewId = collection.data.items[0]?.review_id;
  assert(reviewId);
  const detailPath = `/owner/investment-indications/${encodeURIComponent(reviewId)}`;
  const detailResponse = await worker.fetch(
    ownerRequest(detailPath),
    env,
    executionContext,
  );
  const detail = await detailResponse.json() as OwnerIndicationDetailDocument;
  const reject = detail.actions.find((action) =>
    action.name === "reject-investment-indication"
  );
  const csrf = detailResponse.headers.get(MUTATION_CSRF_HEADER);
  const setCookie = detailResponse.headers.get("set-cookie");
  assert(reject);
  assert(csrf);
  assert(setCookie);
  const body = {
    "operation-id": actionFieldValue(reject, "operation-id"),
    "expected-revision": actionFieldValue(reject, "expected-revision"),
    reason: "Outside the current review scope.",
  };
  const beforeRejectedOrigin = service.transactionRequests;
  const rejectedOrigin = await worker.fetch(
    ownerMutation(reject.href, cookieHeader(setCookie), csrf, body, {
      origin: "https://foreign.example.test",
    }),
    env,
    executionContext,
  );
  assert.equal(rejectedOrigin.status, 403);
  assert.equal(service.transactionRequests, beforeRejectedOrigin);
  assert.doesNotMatch(
    await rejectedOrigin.text(),
    /sites-investor-participant|Private hosted indication note/u,
  );

  const oversized = await worker.fetch(
    ownerMutation(reject.href, cookieHeader(setCookie), csrf, {
      ...body,
      reason: "x".repeat(9_000),
    }),
    env,
    executionContext,
  );
  assert.equal(oversized.status, 413);
  assert.equal(service.transactionRequests, beforeRejectedOrigin);

  const malformed = await worker.fetch(
    ownerMutation(reject.href, cookieHeader(setCookie), csrf, {
      ...body,
      reason: "",
    }),
    env,
    executionContext,
  );
  assert.equal(malformed.status, 400);
  assert.match(malformed.headers.get("set-cookie") ?? "", /Max-Age=0/iu);
  const consumedReplay = await worker.fetch(
    ownerMutation(reject.href, cookieHeader(setCookie), csrf, body),
    env,
    executionContext,
  );
  assert.equal(consumedReplay.status, 403);
  assert.equal(service.transactionRequests, beforeRejectedOrigin + 2);
  assert.equal(
    service.recordKeys().some((key) =>
      key.startsWith("owner-indication-moderation-operations/")
    ),
    false,
  );

  const freshDetailResponse = await worker.fetch(
    ownerRequest(detailPath),
    env,
    executionContext,
  );
  const freshDetail = await freshDetailResponse.json() as
    OwnerIndicationDetailDocument;
  const freshReject = freshDetail.actions.find((action) =>
    action.name === "reject-investment-indication"
  );
  const freshCsrf = freshDetailResponse.headers.get(MUTATION_CSRF_HEADER);
  const freshSetCookie = freshDetailResponse.headers.get("set-cookie");
  assert(freshReject);
  assert(freshCsrf);
  assert(freshSetCookie);
  const freshBody = {
    "operation-id": actionFieldValue(freshReject, "operation-id"),
    "expected-revision": actionFieldValue(freshReject, "expected-revision"),
    reason: "Outside the current review scope.",
  };
  const accepted = await worker.fetch(
    ownerMutation(
      freshReject.href,
      cookieHeader(freshSetCookie),
      freshCsrf,
      freshBody,
    ),
    env,
    executionContext,
  );
  assert.equal(accepted.status, 200);
  const replay = await worker.fetch(
    ownerMutation(
      freshReject.href,
      cookieHeader(freshSetCookie),
      freshCsrf,
      freshBody,
    ),
    env,
    executionContext,
  );
  assert.equal(replay.status, 403);
  assert.doesNotMatch(await replay.text(), /sites-investor-participant|Private/u);
});

test("missing owner review key omits the complete moderation capability", async () => {
  const service = storageService();
  const storage = storageAdapter(service);
  await seedCampaign(storage);
  await seedIndication(storage);
  const env = { ...configuredEnvironment() };
  delete env.OWNER_INDICATION_REVIEW_KEY;
  const rendered: Request[] = [];
  const worker = hostedWorker(service, rendered);

  const home = await worker.fetch(ownerRequest("/owner"), env, executionContext);
  const document = await home.json() as {
    links: readonly Readonly<{ rel: readonly string[] }>[];
  };
  assert.equal(
    document.links.some((link) => link.rel.includes("investment-indications")),
    false,
  );
  const response = await worker.fetch(
    ownerRequest("/owner/investment-indications"),
    env,
    executionContext,
  );
  assert.equal(response.status, 404);
  assert.equal(service.listCollections.includes("investment-indications"), false);
  assert.doesNotMatch(
    await response.text(),
    /sites-investor-participant|Private hosted indication note/u,
  );
});

function hostedWorker(
  service: SyntheticAittaDBStorageService,
  renderedRequests: Request[],
) {
  let randomSeed = 0;
  return createApplicationWorker({
    fetchApplication: async (request) => {
      renderedRequests.push(request);
      return new Response("application fallback", { status: 404 });
    },
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: createHostedApplicationRuntimeResolver({
      fetch: service.fetch,
      now: () => NOW,
      randomBytes(length) {
        randomSeed += 1;
        return Uint8Array.from(
          { length },
          (_, index) => (randomSeed * 37 + index * 11) % 256,
        );
      },
    }),
  });
}

async function seedCampaign(storage: AittaDBStorageAdapter): Promise<void> {
  const saved = await new StorageCampaignRepository(storage).saveSetup(
    campaignSaveRequest({
      operationId: "campaign-operation:hosted-owner-moderation",
      recordedAt: "2026-08-12T08:00:00.000Z",
      expectedRevision: null,
      setup: explicitCampaignSetup(),
    }),
  );
  assert.equal(saved.revision, 1);
}

async function seedIndication(storage: AittaDBStorageAdapter): Promise<void> {
  const parsedAmount = parseAmountAggregateConfiguration(
    explicitCampaignSetup().amountAggregate,
  );
  assert(parsedAmount.ok);
  const amount = parsedAmount.value.amount;
  const ownership = await initializeParticipantInvestmentOwnership(
    storage,
    PARTICIPANT,
    {
      operationId:
        "investment-ownership-initialization:hosted-owner-moderation",
      indications: [],
    },
  );
  assert.equal(ownership.indicationCount, 0);
  assert.equal(ownership.activeCount, 0);
  const repository = new StorageParticipantInvestmentInterestRepository(
    storage,
    PARTICIPANT,
    amount,
  );
  const service = createParticipantInvestmentInterestService({
    actorSubject: PARTICIPANT,
    amountConfiguration: amount,
    reader: repository,
    mutations: repository,
    loadAcknowledgmentContext: () => currentContext(),
    loadPermissions: () => ({
      createPersonal: true,
      createCompany: true,
      reactivatePersonal: true,
      reactivateCompany: true,
    }),
    indicationIdForOperation: () => indicationId(),
    now: () => new Date("2026-08-12T10:00:00.000Z"),
  });
  const created = await service.create({
    operationId: "investment-operation:hosted-owner-moderation",
    fields: {
      kind: "personal",
      residenceCountry: "FI",
      amount: 25_000,
      availabilityPeriod: "Within twelve months.",
      note: PRIVATE_NOTE,
    },
  });
  assert.equal(created.snapshot.revision, 1);
}

async function currentContext(): Promise<TrustedPackageAcknowledgmentContext> {
  const version = await createPackageVersion({
    id: "package-version:hosted-owner-moderation",
    createdAt: "2026-08-12T08:30:00.000Z",
    changeSummary: "Synthetic owner moderation package",
    materialChange: false,
    acknowledgmentText: "This indication remains non-binding.",
    sections: [{
      id: "package-section:hosted-owner-moderation",
      order: 0,
      title: "Overview",
      markdown: "Synthetic package content.",
      enabled: true,
    }],
  }, null);
  assert(version.ok);
  const acceptance = createPackageAcceptance({
    id: "package-acceptance:hosted-owner-moderation",
    participantSubject: PARTICIPANT,
    acceptedAt: "2026-08-12T09:00:00.000Z",
  }, version.value);
  assert(acceptance.ok);
  return Object.freeze({
    currentVersion: version.value,
    latestAcceptance: acceptance.value,
  });
}

async function publicCampaign(
  worker: ReturnType<typeof hostedWorker>,
  env: InvestorAppEnv,
): Promise<PublicCampaignDocument> {
  const response = await worker.fetch(
    new Request(`${APP_ORIGIN}/`, { headers: { accept: "application/json" } }),
    env,
    executionContext,
  );
  assert.equal(response.status, 200);
  return await response.json() as PublicCampaignDocument;
}

function ownerMutation(
  href: string,
  cookie: string,
  csrf: string,
  body: Readonly<Record<string, unknown>>,
  overrides: Readonly<{ origin?: string }> = {},
): Request {
  return new Request(href, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      cookie,
      origin: overrides.origin ?? APP_ORIGIN,
      [MUTATION_CSRF_HEADER]: csrf,
      "oai-authenticated-user-id": OWNER_SUBJECT,
      "oai-authenticated-user-email": OWNER_EMAIL,
    },
    body: JSON.stringify(body),
  });
}

function actionFieldValue(
  action: OwnerIndicationDetailDocument["actions"][number],
  name: string,
): unknown {
  const field = action.fields.find((candidate) => candidate.name === name);
  assert(field);
  assert.notEqual(field.value, undefined);
  return field.value;
}

function ownerRequest(path: string, accept = "application/json"): Request {
  return new Request(new URL(path, APP_ORIGIN), {
    headers: {
      accept,
      "oai-authenticated-user-id": OWNER_SUBJECT,
      "oai-authenticated-user-email": OWNER_EMAIL,
    },
  });
}

function cookieHeader(setCookie: string): string {
  const cookie = setCookie.split(";", 1)[0];
  assert(cookie);
  return cookie;
}

function storageService(): SyntheticAittaDBStorageService {
  return new SyntheticAittaDBStorageService({
    issuer: ISSUER,
    transportOrigin: TRANSPORT_ORIGIN,
    entryHref: ENTRY_HREF,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    accessToken: ACCESS_TOKEN,
    scopes: STORAGE_SCOPES,
  });
}

function storageAdapter(
  service: SyntheticAittaDBStorageService,
): AittaDBStorageAdapter {
  return new AittaDBStorageAdapter({
    issuer: ISSUER,
    transportOrigin: TRANSPORT_ORIGIN,
    entryHref: ENTRY_HREF,
    accessToken: () => ACCESS_TOKEN,
    fetch: service.fetch,
  });
}

function configuredEnvironment(): InvestorAppEnv {
  return {
    APP_BASE_URL: APP_ORIGIN,
    AITTADB_STORAGE_ISSUER: ISSUER,
    AITTADB_STORAGE_TRANSPORT_ORIGIN: TRANSPORT_ORIGIN,
    AITTADB_STORAGE_ENTRY_HREF: ENTRY_HREF,
    AITTADB_STORAGE_CLIENT_ID: CLIENT_ID,
    AITTADB_STORAGE_CLIENT_SECRET: CLIENT_SECRET,
    AITTADB_STORAGE_SCOPES: STORAGE_SCOPES,
    BROWSER_MUTATION_SESSION_KEY: keyMaterial(1),
    OWNER_INDICATION_REVIEW_KEY: keyMaterial(2),
    OWNER_EMAIL,
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

function keyMaterial(seed: number): string {
  const binary = String.fromCharCode(...Uint8Array.from(
    { length: 32 },
    (_, index) => (seed * 29 + index * 13) % 256,
  ));
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function indicationId(): InvestmentIndicationId {
  const parsed = parseStableId<"investment-indication">(
    "investment-indication:hosted-owner-moderation",
  );
  assert(parsed.ok);
  return parsed.value;
}

function subject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  assert(parsed.ok);
  return parsed.value;
}
