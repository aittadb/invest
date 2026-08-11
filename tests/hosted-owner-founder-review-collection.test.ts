import assert from "node:assert/strict";
import test from "node:test";

import {
  parseContributionAreaChoices,
  type ContributionAreaChoice,
} from "../domain/founder-application.ts";
import { parseActorSubject, type ActorSubject } from "../domain/foundation.ts";
import type {
  OwnerFounderReviewCollectionDocument,
  OwnerFounderReviewDetailDocument,
} from "../domain/owner-founder-review-resource.ts";
import { OWNER_FOUNDER_REVIEW_HEADER } from "../http/runtime-capabilities.ts";
import { AittaDBStorageAdapter } from "../repositories/aittadb-storage-adapter.ts";
import {
  MAX_FOUNDER_APPLICATION_REVIEW_DETAIL_RECORD_READS,
  StorageFounderApplicationRepository,
} from "../repositories/in-memory-founder-application-repository.ts";
import { createApplicationWorker } from "../worker/application-worker.ts";
import type {
  InvestorAppEnv,
  WorkerExecutionContext,
} from "../worker/contracts.ts";
import { createHostedApplicationRuntimeResolver } from "../worker/hosted-application-composition.ts";
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
const ALICE = subject("sites-founder-alice");
const BOB = subject("sites-founder-bob");
const PRIVATE_NOTE = "Private hosted founder note must stay out of summaries.";
const CHOICES = contributionChoices();
const NOW = new Date("2026-08-10T12:00:00.000Z");

const executionContext: WorkerExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

test("hosted owner founder collection pages persistent applications across restart", async () => {
  const service = storageService();
  const storage = storageAdapter(service);
  await seedApplication(storage, ALICE, "alice", "area:engineering");
  await seedApplication(storage, BOB, "bob", "area:product");
  const env = configuredEnvironment();
  const renderedRequests: Request[] = [];
  const firstWorker = hostedWorker(service, renderedRequests);

  const firstResponse = await firstWorker.fetch(
    ownerRequest("/owner/founder-applications?page_size=1"),
    env,
    executionContext,
  );
  assert.equal(firstResponse.status, 200);
  assert.equal(firstResponse.headers.get("cache-control"), "no-store");
  assert.equal(firstResponse.headers.get("referrer-policy"), "no-referrer");
  const first = await firstResponse.json() as OwnerFounderReviewCollectionDocument;
  assert.equal(first.type, "owner-founder-application-collection");
  assert.equal(first.data.items.length, 1);
  const firstSummary = first.data.items[0];
  assert(firstSummary);
  assert.deepEqual(Object.keys(firstSummary), [
    "review_id",
    "status",
    "primary_contribution_area_id",
    "updated_at",
    "revision",
  ]);
  assert.match(firstSummary.review_id, /^founder-review:[0-9a-f]{64}$/u);
  const next = first.links.find((link) => link.rel.includes("next"));
  assert(next);
  const cursor = new URL(next.href).searchParams.get("cursor");
  assert(cursor);
  for (const privateValue of [ALICE, BOB, PRIVATE_NOTE, "founder-application:self"]) {
    assert.equal(JSON.stringify(first).includes(privateValue), false);
    assert.equal(next.href.includes(privateValue), false);
    assert.equal(cursor.includes(privateValue), false);
  }

  const htmlResponse = await firstWorker.fetch(
    ownerRequest("/owner/founder-applications?page_size=1", "text/html"),
    env,
    executionContext,
  );
  assert.equal(htmlResponse.status, 200);
  const html = await htmlResponse.text();
  assert.match(html, /Founder applications/u);
  assert.match(
    html,
    new RegExp(firstSummary.review_id, "u"),
  );
  assert.match(html, new RegExp(firstSummary.status, "u"));
  assert.match(
    html,
    new RegExp(firstSummary.primary_contribution_area_id, "u"),
  );
  assert.match(html, new RegExp(firstSummary.updated_at, "u"));
  assert.match(html, /Next page/u);
  assert.doesNotMatch(
    html,
    /sites-founder-|Private hosted founder note|founder-application:self/u,
  );

  const restartedWorker = hostedWorker(service, []);
  const secondResponse = await restartedWorker.fetch(
    ownerRequest(new URL(next.href).pathname + new URL(next.href).search),
    env,
    executionContext,
  );
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json() as OwnerFounderReviewCollectionDocument;
  assert.equal(second.data.items.length, 1);
  assert.equal(
    second.links.some((link) => link.rel.includes("next")),
    false,
  );
  assert.notEqual(second.data.items[0]?.review_id, firstSummary.review_id);
  assert.deepEqual(service.listCollections, [
    "founder-applications",
    "founder-applications",
    "founder-applications",
  ]);
});

test("hosted collection authorization and owner discovery are non-disclosing", async () => {
  const service = storageService();
  await seedApplication(
    storageAdapter(service),
    ALICE,
    "alice",
    "area:engineering",
  );
  const env = configuredEnvironment();
  const renderedRequests: Request[] = [];
  const worker = hostedWorker(service, renderedRequests);

  const beforeDenied = service.listCollections.length;
  const anonymous = await worker.fetch(
    new Request(`${APP_ORIGIN}/owner/founder-applications`, {
      headers: { accept: "application/json" },
    }),
    env,
    executionContext,
  );
  assert.equal(anonymous.status, 401);
  assert.doesNotMatch(await anonymous.text(), /sites-founder-|Private hosted/u);

  const foreign = await worker.fetch(
    new Request(`${APP_ORIGIN}/owner/founder-applications`, {
      headers: {
        accept: "text/html",
        "oai-authenticated-user-id": "sites-foreign-user",
        "oai-authenticated-user-email": "foreign@example.test",
      },
    }),
    env,
    executionContext,
  );
  assert.equal(foreign.status, 404);
  assert.doesNotMatch(await foreign.text(), /sites-founder-|Private hosted/u);
  assert.equal(service.listCollections.length, beforeDenied);

  const ownerHome = await worker.fetch(
    ownerRequest("/owner"),
    env,
    executionContext,
  );
  assert.equal(ownerHome.status, 200);
  const ownerDocument = await ownerHome.json() as {
    links: readonly Readonly<{ rel: readonly string[]; href: string }>[];
  };
  assert.ok(ownerDocument.links.some((link) =>
    link.rel.includes("founder-applications") &&
    link.href === `${APP_ORIGIN}/owner/founder-applications`
  ));

  const htmlHome = await worker.fetch(
    ownerRequest("/owner", "text/html"),
    env,
    executionContext,
  );
  assert.equal(htmlHome.status, 404);
  const rendered = renderedRequests.at(-1);
  assert(rendered);
  assert.equal(rendered.headers.get(OWNER_FOUNDER_REVIEW_HEADER), "available");

  const publicResponse = await worker.fetch(
    new Request(`${APP_ORIGIN}/`, { headers: { accept: "application/json" } }),
    env,
    executionContext,
  );
  assert.doesNotMatch(
    await publicResponse.text(),
    /sites-founder-|founder-review:|Private hosted founder note/u,
  );
});

test("hosted owner founder detail preserves lifecycle parity across restart", async () => {
  const service = storageService();
  const participant = await seedApplication(
    storageAdapter(service),
    ALICE,
    "alice-detail",
    "area:engineering",
  );
  const edited = await participant.edit({
    operationId: "founder-operation:hosted-review-alice-detail-edit",
    expectedRevision: 1,
    id: "founder-application:self",
    occurredAt: "2026-08-10T11:00:00.000Z",
    historyEntryId: "founder-history:hosted-review-alice-detail-edit",
    fields: founderFields("area:product"),
  });
  assert.equal(edited.revision, 2);
  const withdrawn = await participant.withdraw({
    operationId: "founder-operation:hosted-review-alice-detail-withdraw",
    expectedRevision: 2,
    id: "founder-application:self",
    occurredAt: "2026-08-10T12:00:00.000Z",
    historyEntryId: "founder-history:hosted-review-alice-detail-withdraw",
  });
  assert.equal(withdrawn.revision, 3);

  const env = configuredEnvironment();
  const worker = hostedWorker(service, []);
  const collectionResponse = await worker.fetch(
    ownerRequest("/owner/founder-applications?page_size=1"),
    env,
    executionContext,
  );
  const collection = await collectionResponse.json() as
    OwnerFounderReviewCollectionDocument;
  const itemLink = collection.links.find((link) => link.rel.includes("item"));
  assert(itemLink);
  assert.equal(itemLink.href.includes(ALICE), false);
  const detailUrl = new URL(itemLink.href);
  assert.match(
    detailUrl.pathname,
    /^\/owner\/founder-applications\/founder-review%3A[0-9a-f]{64}$/u,
  );

  const readStart = service.readKeys.length;
  const listStart = service.listCollections.length;
  const jsonResponse = await worker.fetch(
    ownerRequest(detailUrl.pathname),
    env,
    executionContext,
  );
  assert.equal(jsonResponse.status, 200);
  assert.equal(jsonResponse.headers.get("cache-control"), "no-store");
  assert.equal(jsonResponse.headers.get("referrer-policy"), "no-referrer");
  const detail = await jsonResponse.json() as OwnerFounderReviewDetailDocument;
  assert.equal(detail.id, collection.data.items[0]?.review_id);
  assert.equal(detail.data.status, "withdrawn");
  assert.equal(detail.data.revision, 3);
  assert.equal(detail.data.application_id, "founder-application:self");
  assert.equal(detail.data.created_at, "2026-08-10T10:00:00.000Z");
  assert.equal(detail.data.updated_at, "2026-08-10T12:00:00.000Z");
  assert.equal(detail.data.withdrawn_at, "2026-08-10T12:00:00.000Z");
  assert.equal(detail.data.primary_contribution_area_id, "area:product");
  assert.equal(detail.data.note, PRIVATE_NOTE);
  assert.deepEqual(
    detail.data.history.map((entry) => entry.transition),
    ["created", "edited", "withdrawn"],
  );
  assert.deepEqual(
    detail.data.history.map((entry) => entry.status),
    ["received", "received", "withdrawn"],
  );
  assert.equal(detail.links.some((link) =>
    link.rel.includes("collection") &&
    link.href === `${APP_ORIGIN}/owner/founder-applications`
  ), true);
  for (const hidden of [ALICE, OWNER_SUBJECT, OWNER_EMAIL]) {
    assert.equal(JSON.stringify(detail).includes(hidden), false);
    assert.equal(itemLink.href.includes(hidden), false);
  }
  assert.equal(service.listCollections.length, listStart);
  assert.ok(
    service.readKeys.length - readStart <=
      MAX_FOUNDER_APPLICATION_REVIEW_DETAIL_RECORD_READS,
  );

  const htmlReadStart = service.readKeys.length;
  const htmlResponse = await worker.fetch(
    ownerRequest(detailUrl.pathname, "text/html"),
    env,
    executionContext,
  );
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.match(html, /Founder application/u);
  assert.match(html, /Experience developing hosted data products\./u);
  assert.match(html, /area:product/u);
  assert.match(html, /Private hosted founder note must stay out of summaries\./u);
  assert.match(html, /created/u);
  assert.match(html, /edited/u);
  assert.match(html, /withdrawn/u);
  for (const value of [
    detail.data.application_id,
    String(detail.data.revision),
    detail.data.created_at,
    detail.data.updated_at,
    detail.data.withdrawn_at,
  ]) {
    assert(value);
    assert.ok(html.includes(value));
  }
  for (const entry of detail.data.history) {
    assert.ok(
      html.includes(
        `${entry.transition} · ${entry.status} · ${entry.occurred_at} · revision ${entry.revision}`,
      ),
    );
  }
  for (const relation of ["collection", "owner"] as const) {
    const link = detail.links.find((candidate) =>
      candidate.rel.includes(relation)
    );
    assert(link);
    assert.ok(html.includes(`href="${link.href}"`));
  }
  assert.doesNotMatch(html, /sites-founder-|sites-owner-subject|owner@example/u);
  assert.ok(
    service.readKeys.length - htmlReadStart <=
      MAX_FOUNDER_APPLICATION_REVIEW_DETAIL_RECORD_READS,
  );

  const restartedWorker = hostedWorker(service, []);
  const restartReadStart = service.readKeys.length;
  const restartedResponse = await restartedWorker.fetch(
    ownerRequest(detailUrl.pathname),
    env,
    executionContext,
  );
  assert.equal(restartedResponse.status, 200);
  assert.deepEqual(await restartedResponse.json(), detail);
  assert.ok(
    service.readKeys.length - restartReadStart <=
      MAX_FOUNDER_APPLICATION_REVIEW_DETAIL_RECORD_READS,
  );
});

test("hosted founder detail denials and invalid IDs do not disclose or read", async () => {
  const service = storageService();
  await seedApplication(
    storageAdapter(service),
    ALICE,
    "alice-denial",
    "area:engineering",
  );
  const env = configuredEnvironment();
  const renderedRequests: Request[] = [];
  const worker = hostedWorker(service, renderedRequests);
  const collectionResponse = await worker.fetch(
    ownerRequest("/owner/founder-applications?page_size=1"),
    env,
    executionContext,
  );
  const collection = await collectionResponse.json() as
    OwnerFounderReviewCollectionDocument;
  const itemLink = collection.links.find((link) => link.rel.includes("item"));
  assert(itemLink);
  const detailPath = new URL(itemLink.href).pathname;
  const deniedReadStart = founderApplicationReadCount(service);

  const anonymous = await worker.fetch(
    new Request(new URL(detailPath, APP_ORIGIN), {
      headers: { accept: "application/json" },
    }),
    env,
    executionContext,
  );
  assert.equal(anonymous.status, 401);
  assert.doesNotMatch(await anonymous.text(), /sites-founder-|Private hosted/u);

  const foreign = await worker.fetch(
    new Request(new URL(detailPath, APP_ORIGIN), {
      headers: {
        accept: "text/html",
        "oai-authenticated-user-id": "sites-foreign-user",
        "oai-authenticated-user-email": "foreign@example.test",
      },
    }),
    env,
    executionContext,
  );
  assert.equal(foreign.status, 404);
  assert.doesNotMatch(await foreign.text(), /sites-founder-|Private hosted/u);
  assert.equal(founderApplicationReadCount(service), deniedReadStart);

  const malformedPaths = [
    `/owner/founder-applications/${encodeURIComponent(ALICE)}`,
    "/owner/founder-applications/",
    `${detailPath}/`,
    `/owner/founder-applications/${encodeURIComponent(ALICE)}/history`,
  ];
  for (const malformedPath of malformedPaths) {
    const malformed = await worker.fetch(
      ownerRequest(malformedPath),
      env,
      executionContext,
    );
    assert.equal(malformed.status, 400, malformedPath);
    assert.equal(malformed.headers.get("cache-control"), "no-store");
    assert.equal(malformed.headers.get("referrer-policy"), "no-referrer");
    const malformedBody = await malformed.text();
    assert.doesNotMatch(
      malformedBody,
      /sites-founder-|founder-review:|Private hosted/u,
    );
    assert.match(malformedBody, /owner\/founder-applications\/invalid/u);
  }
  assert.equal(founderApplicationReadCount(service), deniedReadStart);
  assert.equal(renderedRequests.length, 0);

  const missingId = `founder-review:${"f".repeat(64)}`;
  const missing = await worker.fetch(
    ownerRequest(
      `/owner/founder-applications/${encodeURIComponent(missingId)}`,
    ),
    env,
    executionContext,
  );
  assert.equal(missing.status, 404);
  const missingBody = await missing.text();
  assert.equal(missingBody.includes(PRIVATE_NOTE), false);
  assert.equal(missingBody.includes(ALICE), false);
  assert.equal(founderApplicationReadCount(service), deniedReadStart + 1);
});

test("hosted founder detail maps corrupt persistent data to a finite error", async () => {
  const service = storageService();
  await seedApplication(
    storageAdapter(service),
    ALICE,
    "alice-corrupt",
    "area:engineering",
  );
  const env = configuredEnvironment();
  const normalWorker = hostedWorker(service, []);
  const collectionResponse = await normalWorker.fetch(
    ownerRequest("/owner/founder-applications?page_size=1"),
    env,
    executionContext,
  );
  const collection = await collectionResponse.json() as
    OwnerFounderReviewCollectionDocument;
  const itemLink = collection.links.find((link) => link.rel.includes("item"));
  assert(itemLink);

  const corruptSubject = "sites-founder-corrupt-crossed-record";
  const corruptWorker = hostedWorker(
    service,
    [],
    corruptCurrentFounderRecordFetch(service, corruptSubject),
  );
  const readStart = service.readKeys.length;
  const listStart = service.listCollections.length;
  const response = await corruptWorker.fetch(
    ownerRequest(new URL(itemLink.href).pathname),
    env,
    executionContext,
  );
  const body = await response.text();
  assert.equal(response.status, 503);
  assert.match(body, /temporarily_unavailable/u);
  for (const hidden of [ALICE, corruptSubject, PRIVATE_NOTE]) {
    assert.equal(body.includes(hidden), false);
  }
  assert.equal(service.listCollections.length, listStart);
  assert.ok(
    service.readKeys.length - readStart <=
      MAX_FOUNDER_APPLICATION_REVIEW_DETAIL_RECORD_READS,
  );
});

function hostedWorker(
  service: SyntheticAittaDBStorageService,
  renderedRequests: Request[],
  applicationFetch: typeof globalThis.fetch = service.fetch,
) {
  return createApplicationWorker({
    fetchApplication: async (request) => {
      renderedRequests.push(request);
      return new Response("application fallback", { status: 404 });
    },
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: createHostedApplicationRuntimeResolver({
      fetch: applicationFetch,
      now: () => NOW,
      randomBytes(length) {
        return Uint8Array.from({ length }, (_, index) => (index + 17) % 256);
      },
    }),
  });
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

async function seedApplication(
  storage: AittaDBStorageAdapter,
  applicantSubject: ActorSubject,
  suffix: string,
  primaryContributionAreaId: string,
): Promise<StorageFounderApplicationRepository> {
  const repository = new StorageFounderApplicationRepository(
    storage,
    applicantSubject,
    CHOICES,
  );
  const result = await repository.create({
    operationId: `founder-operation:hosted-review-${suffix}`,
    expectedRevision: null,
    id: "founder-application:self",
    occurredAt: "2026-08-10T10:00:00.000Z",
    historyEntryId: `founder-history:hosted-review-${suffix}`,
    fields: founderFields(primaryContributionAreaId),
  });
  assert.equal(result.revision, 1);
  return repository;
}

function founderFields(primaryContributionAreaId: string) {
  return {
    expertiseSummary: "Experience developing hosted data products.",
    intendedContribution: "Contribute to focused product delivery.",
    primaryContributionAreaId,
    secondaryContributionAreaIds: [],
    approximateAvailability: "Two days each week.",
    possibleStartTiming: "After mutual confirmation.",
    compensationExpectation: "Open to discussion.",
    professionalProfileLinks: [],
    note: PRIVATE_NOTE,
  };
}

function corruptCurrentFounderRecordFetch(
  service: SyntheticAittaDBStorageService,
  corruptSubject: string,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const response = await service.fetch(request);
    const pathname = new URL(request.url).pathname;
    if (
      request.method !== "GET" ||
      !pathname.startsWith("/records/founder-applications/") ||
      response.status !== 200
    ) {
      return response;
    }
    const document = await response.json() as {
      data: { value: Record<string, unknown> };
    };
    document.data.value.applicantSubject = corruptSubject;
    return new Response(JSON.stringify(document), {
      status: response.status,
      headers: response.headers,
    });
  };
}

function founderApplicationReadCount(
  service: SyntheticAittaDBStorageService,
): number {
  return service.readKeys.filter((storageKey) =>
    storageKey.startsWith("founder-applications/")
  ).length;
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
    BROWSER_MUTATION_SESSION_KEY: keyMaterial(),
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

function keyMaterial(): string {
  const binary = String.fromCharCode(...Uint8Array.from(
    { length: 32 },
    (_, index) => (index * 11 + 7) % 256,
  ));
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function contributionChoices(): readonly ContributionAreaChoice[] {
  const parsed = parseContributionAreaChoices([
    { id: "area:engineering", label: "Engineering" },
    { id: "area:product", label: "Product" },
  ]);
  assert(parsed.ok);
  return parsed.value;
}

function subject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  assert(parsed.ok);
  return parsed.value;
}
