import assert from "node:assert/strict";
import test from "node:test";

import {
  parseMinorUnits,
  parseStableId,
} from "../domain/foundation.ts";
import type { OwnerAggregateReconciliationDocument } from "../domain/owner-aggregate-reconciliation-resource.ts";
import type { OwnerHomeDocument } from "../domain/owner-home-resource.ts";
import {
  parseStorageKey,
  parseStorageOperationId,
} from "../domain/storage-adapter.ts";
import {
  MUTATION_CSRF_HEADER,
} from "../http/mutation-security.ts";
import { OWNER_AGGREGATE_RECONCILIATION_HEADER } from "../http/runtime-capabilities.ts";
import { AittaDBStorageAdapter } from "../repositories/aittadb-storage-adapter.ts";
import {
  DevelopmentInMemoryAggregateRepository,
} from "../repositories/in-memory-aggregate-repository.ts";
import { DevelopmentInMemoryAuditRepository } from "../repositories/in-memory-audit-notification-repositories.ts";
import { StorageCampaignRepository } from "../repositories/in-memory-campaign-repository.ts";
import { createApplicationWorker } from "../worker/application-worker.ts";
import type {
  InvestorAppEnv,
  WorkerExecutionContext,
} from "../worker/contracts.ts";
import { createHostedApplicationRuntimeResolver } from "../worker/hosted-application-composition.ts";
import { explicitCampaignSetup } from "./support/campaign-repository-contract.ts";
import { SyntheticAittaDBStorageService } from "./support/synthetic-aittadb-storage-service.ts";

const APP_ORIGIN = "https://invest.example.test";
const ISSUER = "https://storage.example.test";
const TRANSPORT_ORIGIN = "https://storage-runtime.example.test";
const ENTRY_HREF = `${ISSUER}/bounded-storage`;
const CLIENT_ID = "investor-app-aggregate-reconciliation";
const CLIENT_SECRET = "private-aggregate-client-secret";
const ACCESS_TOKEN = "private-aggregate-access-token";
const SCOPES = "storage.read storage.write storage.delete";
const OWNER_SUBJECT = "oidc:configured-owner";
const OWNER_EMAIL = "owner@example.test";
const NOW = new Date("2026-08-11T09:00:00.000Z");
const MUTATION_KEY = keyMaterial(53);
const PATH = "/owner/aggregate-reconciliation";

const executionContext: WorkerExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

test("hosted owner reconciles a persistent AittaDB aggregate and audit atomically", async () => {
  const service = storageService();
  const seeded = await seedMismatch(service);
  const worker = hostedWorker(service);
  const env = environment();

  const homeResponse = await worker.fetch(
    ownerRequest("/owner"),
    env,
    executionContext,
  );
  assert.equal(homeResponse.status, 200);
  const home = await homeResponse.json() as OwnerHomeDocument;
  assert.equal(home.links.some((link) =>
    link.rel.includes("aggregate-reconciliation") &&
    link.href === `${APP_ORIGIN}${PATH}`
  ), true);

  const renderedHome = await worker.fetch(
    ownerRequest("/owner", "text/html"),
    env,
    executionContext,
  );
  assert.equal(await renderedHome.text(), "available");

  const resourceResponse = await worker.fetch(
    ownerRequest(PATH),
    env,
    executionContext,
  );
  assert.equal(resourceResponse.status, 200);
  assert.equal(resourceResponse.headers.get("cache-control"), "no-store");
  const proof = mutationProof(resourceResponse);
  const resource = await resourceResponse.json() as
    OwnerAggregateReconciliationDocument;
  assert.equal(resource.data.status, "mismatch");
  assert.equal(resource.data.stored.amount, 45_000);
  assert.equal(resource.data.calculated.amount, 50_000);
  assert.equal(resource.data.correction_available, true);
  assert.deepEqual(resource.actions.map(({ name }) => name), [
    "apply-calculated-aggregate",
  ]);

  const htmlResponse = await worker.fetch(
    ownerRequest(PATH, "text/html"),
    env,
    executionContext,
  );
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.match(html, /Stored and calculated totals differ/u);
  assert.match(html, /<form[^>]+method="post"/u);
  assert.match(html, /name="_csrf"/u);
  for (const field of requiredAction(resource).fields) {
    assert.match(html, new RegExp(`name="${field.name}"`, "u"));
  }

  const correctedResponse = await worker.fetch(
    ownerMutation(actionBody(resource), proof),
    env,
    executionContext,
  );
  assert.equal(correctedResponse.status, 200);
  assert.match(correctedResponse.headers.get("set-cookie") ?? "", /Max-Age=0/u);
  assert.equal(correctedResponse.headers.get(MUTATION_CSRF_HEADER), null);
  const corrected = await correctedResponse.json() as
    OwnerAggregateReconciliationDocument;
  assert.equal(corrected.data.status, "match");
  assert.equal(corrected.data.stored.amount, 50_000);
  assert.deepEqual(corrected.actions, []);

  const restarted = hostedWorker(service);
  const persistedResponse = await restarted.fetch(
    ownerRequest(PATH),
    env,
    executionContext,
  );
  const persisted = await persistedResponse.json() as
    OwnerAggregateReconciliationDocument;
  assert.equal(persisted.data.status, "match");
  assert.deepEqual(persisted.actions, []);
  assert.equal(persistedResponse.headers.get(MUTATION_CSRF_HEADER), null);
  assert.equal(persistedResponse.headers.get("set-cookie"), null);

  const preview = await seeded.aggregate.previewReconciliation();
  assert.equal(preview.status, "match");
  const audits = await new DevelopmentInMemoryAuditRepository(
    seeded.adapter,
  ).list({ limit: 10 });
  assert.equal(audits.items.length, 1);
  assert.equal(audits.items[0]?.actor.type, "owner");
  if (audits.items[0]?.actor.type !== "owner") assert.fail("Owner audit expected.");
  assert.equal(audits.items[0]?.actor.subject, OWNER_SUBJECT);
  assert.deepEqual(audits.items[0]?.detail, {
    kind: "resource-transition",
    resource: {
      type: "aggregate",
      id: "aggregate:investment-interest",
    },
    transition: "reconciled",
  });
});

test("hosted reconciliation rejects stale previews and consumes their proof", async () => {
  const service = storageService();
  const seeded = await seedMismatch(service);
  const worker = hostedWorker(service);
  const env = environment();
  const resourceResponse = await worker.fetch(
    ownerRequest(PATH),
    env,
    executionContext,
  );
  const proof = mutationProof(resourceResponse);
  const resource = await resourceResponse.json() as
    OwnerAggregateReconciliationDocument;

  await driftAggregate(seeded.adapter, 40_000, "aggregate-seed:stale-drift");
  const response = await worker.fetch(
    ownerMutation(actionBody(resource), proof),
    env,
    executionContext,
  );
  const body = await response.text();
  assert.equal(response.status, 412);
  assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/u);
  assert.doesNotMatch(body, /client-secret|access-token|configured-owner/iu);
  assert.equal(
    (await new DevelopmentInMemoryAuditRepository(seeded.adapter).list({
      limit: 10,
    })).items.length,
    0,
  );
});

test("hosted native form applies the same bounded correction action", async () => {
  const service = storageService();
  await seedMismatch(service);
  const worker = hostedWorker(service);
  const env = environment();
  const jsonResponse = await worker.fetch(
    ownerRequest(PATH),
    env,
    executionContext,
  );
  const resource = await jsonResponse.json() as
    OwnerAggregateReconciliationDocument;
  const htmlResponse = await worker.fetch(
    ownerRequest(PATH, "text/html"),
    env,
    executionContext,
  );
  const proof = mutationProof(htmlResponse);

  const response = await worker.fetch(
    ownerFormMutation(actionBody(resource), proof),
    env,
    executionContext,
  );
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Stored and calculated totals match/u);
  assert.doesNotMatch(html, /<form/u);
  assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/u);
});

test("hosted reconciliation rejects unauthorized callers and storage failure without disclosure", async () => {
  const service = storageService({
    rejectTransaction: (operationId) =>
      operationId.startsWith("aggregate-correction:")
        ? "unavailable"
        : null,
  });
  await seedMismatch(service);
  const worker = hostedWorker(service);
  const env = environment();

  const anonymous = await worker.fetch(
    new Request(`${APP_ORIGIN}${PATH}`, {
      headers: { accept: "application/json" },
    }),
    env,
    executionContext,
  );
  assert.equal(anonymous.status, 401);

  const foreign = await worker.fetch(
    new Request(`${APP_ORIGIN}${PATH}`, {
      headers: {
        accept: "application/json",
        "oai-authenticated-user-id": "oidc:foreign",
        "oai-authenticated-user-email": "foreign@example.test",
      },
    }),
    env,
    executionContext,
  );
  assert.equal(foreign.status, 404);

  const resourceResponse = await worker.fetch(
    ownerRequest(PATH),
    env,
    executionContext,
  );
  const proof = mutationProof(resourceResponse);
  const resource = await resourceResponse.json() as
    OwnerAggregateReconciliationDocument;
  const failed = await worker.fetch(
    ownerMutation(actionBody(resource), proof),
    env,
    executionContext,
  );
  const failedBody = await failed.text();
  assert.equal(failed.status, 503);
  assert.match(failed.headers.get("set-cookie") ?? "", /Max-Age=0/u);
  assert.doesNotMatch(
    `${await foreign.text()}${failedBody}`,
    new RegExp(`${CLIENT_SECRET}|${ACCESS_TOKEN}|${OWNER_SUBJECT}`, "u"),
  );
});

type SeededAggregate = Readonly<{
  adapter: AittaDBStorageAdapter;
  aggregate: DevelopmentInMemoryAggregateRepository;
}>;

async function seedMismatch(
  service: SyntheticAittaDBStorageService,
): Promise<SeededAggregate> {
  const adapter = storageAdapter(service);
  const campaign = await new StorageCampaignRepository(adapter).saveSetup({
    operationId: "campaign-operation:aggregate-reconciliation-setup",
    recordedAt: NOW.toISOString(),
    expectedRevision: null,
    setup: explicitCampaignSetup(),
  });
  const aggregate = new DevelopmentInMemoryAggregateRepository(
    adapter,
    campaign.setup.amountAggregate.amount.currency,
  );
  const indicationId = parseStableId<"investment-indication">(
    "indication:hosted-reconciliation",
  );
  const amount = parseMinorUnits(50_000);
  assert(indicationId.ok);
  assert(amount.ok);
  await aggregate.applyContribution({
    operationId: "aggregate-seed:active-contribution",
    expectedStoredRevision: 0,
    contribution: {
      indicationId: indicationId.value,
      indicationRevision: 1,
      status: "active",
      amount: amount.value,
      currency: campaign.setup.amountAggregate.amount.currency,
    },
  });
  await driftAggregate(adapter, 45_000, "aggregate-seed:initial-drift");
  return Object.freeze({ adapter, aggregate });
}

async function driftAggregate(
  adapter: AittaDBStorageAdapter,
  storedAmount: number,
  operationIdValue: string,
): Promise<void> {
  const key = parseStorageKey(
    "investment-aggregate-states",
    "current-investment-aggregate",
  );
  const operationId = parseStorageOperationId(operationIdValue);
  assert(key.ok);
  assert(operationId.ok);
  const current = await adapter.read(key.value);
  assert(current);
  const source = record(current.value);
  const snapshot = record(source.snapshot);
  assert.equal(source.kind, "investment-aggregate-state");
  assert.equal(source.schemaVersion, 1);
  assert.equal(typeof snapshot.currency, "string");
  assert.equal(typeof snapshot.contributingIndicationCount, "number");
  await adapter.transact({
    operationId: operationId.value,
    mutations: [{
      type: "put",
      key: key.value,
      expectedRevision: current.revision,
      value: {
        kind: "investment-aggregate-state",
        schemaVersion: 1,
        snapshot: {
          revision: current.revision + 1,
          totalAmount: storedAmount,
          currency: snapshot.currency as string,
          contributingIndicationCount:
            snapshot.contributingIndicationCount as number,
        },
      },
    }],
  });
}

function hostedWorker(service: SyntheticAittaDBStorageService) {
  let randomSeed = 7;
  return createApplicationWorker({
    fetchApplication: async (request) =>
      new Response(
        request.headers.get(OWNER_AGGREGATE_RECONCILIATION_HEADER) ??
          "missing",
      ),
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: createHostedApplicationRuntimeResolver({
      fetch: service.fetch,
      now: () => NOW,
      randomBytes: (length) => {
        randomSeed = (randomSeed + 1) % 255;
        return new Uint8Array(length).fill(randomSeed);
      },
    }),
  });
}

function storageService(
  overrides: Partial<ConstructorParameters<typeof SyntheticAittaDBStorageService>[0]> = {},
): SyntheticAittaDBStorageService {
  return new SyntheticAittaDBStorageService({
    issuer: ISSUER,
    transportOrigin: TRANSPORT_ORIGIN,
    entryHref: ENTRY_HREF,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    accessToken: ACCESS_TOKEN,
    scopes: SCOPES,
    ...overrides,
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

function ownerRequest(path: string, accept = "application/json"): Request {
  return new Request(new URL(path, APP_ORIGIN), {
    headers: {
      accept,
      "oai-authenticated-user-id": OWNER_SUBJECT,
      "oai-authenticated-user-email": OWNER_EMAIL,
    },
  });
}

function ownerMutation(
  body: Readonly<Record<string, unknown>>,
  proof: Readonly<{ token: string; cookie: string }>,
): Request {
  return new Request(`${APP_ORIGIN}${PATH}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      cookie: proof.cookie,
      origin: APP_ORIGIN,
      [MUTATION_CSRF_HEADER]: proof.token,
      "oai-authenticated-user-id": OWNER_SUBJECT,
      "oai-authenticated-user-email": OWNER_EMAIL,
    },
    body: JSON.stringify(body),
  });
}

function ownerFormMutation(
  body: Readonly<Record<string, unknown>>,
  proof: Readonly<{ token: string; cookie: string }>,
): Request {
  const fields = new URLSearchParams();
  for (const [name, value] of Object.entries(body)) {
    fields.set(name, String(value));
  }
  fields.set("_csrf", proof.token);
  return new Request(`${APP_ORIGIN}${PATH}`, {
    method: "POST",
    headers: {
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
      cookie: proof.cookie,
      origin: APP_ORIGIN,
      "oai-authenticated-user-id": OWNER_SUBJECT,
      "oai-authenticated-user-email": OWNER_EMAIL,
    },
    body: fields,
  });
}

function mutationProof(
  response: Response,
): Readonly<{ token: string; cookie: string }> {
  const token = response.headers.get(MUTATION_CSRF_HEADER);
  const setCookie = response.headers.get("set-cookie");
  assert(token);
  assert(setCookie);
  const cookie = setCookie.split(";", 1)[0];
  assert(cookie);
  return Object.freeze({ token, cookie });
}

function requiredAction(document: OwnerAggregateReconciliationDocument) {
  const action = document.actions.find((candidate) =>
    candidate.name === "apply-calculated-aggregate"
  );
  assert(action);
  return action;
}

function actionBody(
  document: OwnerAggregateReconciliationDocument,
): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(
    requiredAction(document).fields.map((field) => {
      assert.notEqual(field.value, undefined);
      return [field.name, field.value] as const;
    }),
  ));
}

function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function environment(): InvestorAppEnv {
  return {
    APP_BASE_URL: APP_ORIGIN,
    AITTADB_STORAGE_ISSUER: ISSUER,
    AITTADB_STORAGE_TRANSPORT_ORIGIN: TRANSPORT_ORIGIN,
    AITTADB_STORAGE_ENTRY_HREF: ENTRY_HREF,
    AITTADB_STORAGE_CLIENT_ID: CLIENT_ID,
    AITTADB_STORAGE_CLIENT_SECRET: CLIENT_SECRET,
    AITTADB_STORAGE_SCOPES: SCOPES,
    BROWSER_MUTATION_SESSION_KEY: MUTATION_KEY,
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
