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
import {
  StorageCampaignRepository,
  type CampaignSetup,
} from "../repositories/in-memory-campaign-repository.ts";
import { createApplicationWorker } from "../worker/application-worker.ts";
import {
  MAX_OWNER_AGGREGATE_RECONCILIATION_FORM_FIELDS,
  MAX_OWNER_AGGREGATE_RECONCILIATION_JSON_FIELDS,
} from "../worker/routes/owner-aggregate-reconciliation.ts";
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
  assert.equal(resource.data.campaign_revision, 1);
  assert.equal(resource.data.stored.revision, 2);
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
  assert.match(html, /Campaign revision: 1/u);
  assert.match(html, /<th scope="row">Stored<\/th><td>2<\/td>/u);
  assert.match(html, /<form[^>]+method="post"/u);
  assert.match(html, /name="_csrf"/u);
  for (const field of requiredAction(resource).fields) {
    assert.match(html, new RegExp(`name="${field.name}"`, "u"));
  }

  const listRequestsBeforeCorrection = service.listRequests;
  const correctedResponse = await worker.fetch(
    ownerMutation(actionBody(resource), proof),
    env,
    executionContext,
  );
  assert.equal(correctedResponse.status, 200);
  assert.equal(service.listRequests, listRequestsBeforeCorrection + 1);
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

test("hosted exact retry survives campaign currency evolution and restart", async () => {
  const service = storageService();
  await seedMismatch(service);
  const worker = hostedWorker(service);
  const env = environment();
  const attempts: Array<Readonly<{
    proof: Readonly<{ token: string; cookie: string }>;
    resource: OwnerAggregateReconciliationDocument;
  }>> = [];
  for (let index = 0; index < 4; index += 1) {
    const response = await worker.fetch(
      ownerRequest(PATH),
      env,
      executionContext,
    );
    attempts.push(Object.freeze({
      proof: mutationProof(response),
      resource: await response.json() as OwnerAggregateReconciliationDocument,
    }));
  }
  const original = attempts[0];
  assert(original);
  const originalBody = actionBody(original.resource);
  const originalCurrency = original.resource.data.stored.currency;

  const committed = await worker.fetch(
    ownerMutation(originalBody, original.proof),
    env,
    executionContext,
  );
  assert.equal(committed.status, 200);

  const campaigns = new StorageCampaignRepository(storageAdapter(service));
  const revisionOne = await campaigns.readSetup();
  assert(revisionOne);
  await campaigns.saveSetup({
    operationId: "campaign-operation:currency-evolution-after-correction",
    recordedAt: "2026-08-11T09:01:00.000Z",
    expectedRevision: revisionOne.revision,
    setup: campaignSetupWithCurrency(
      revisionOne.setup,
      "EUR",
      "Currency-evolved campaign",
    ),
  });

  const restarted = hostedWorker(service, service.fetch, 41);
  const listRequestsBeforeRetries = service.listRequests;
  const exactAttempt = attempts[1];
  assert(exactAttempt);
  const exact = await restarted.fetch(
    ownerMutation(originalBody, exactAttempt.proof),
    env,
    executionContext,
  );
  assert.equal(exact.status, 200);
  const exactResource = await exact.json() as
    OwnerAggregateReconciliationDocument;
  assert.equal(exactResource.data.campaign_revision, 2);
  assert.equal(exactResource.data.status, "match");
  assert.equal(exactResource.data.stored.currency, originalCurrency);
  assert.equal(exactResource.data.calculated.currency, originalCurrency);
  assert.deepEqual(exactResource.actions, []);

  const changedAttempt = attempts[2];
  assert(changedAttempt);
  const changed = await restarted.fetch(
    ownerMutation({
      ...originalBody,
      "expected-campaign-revision": 2,
    }, changedAttempt.proof),
    env,
    executionContext,
  );
  assert.equal(changed.status, 409);

  const staleAttempt = attempts[3];
  assert(staleAttempt);
  const stale = await restarted.fetch(
    ownerMutation({
      ...originalBody,
      "operation-id": "aggregate-correction:new-stale-after-currency-evolution",
    }, staleAttempt.proof),
    env,
    executionContext,
  );
  assert.equal(stale.status, 412);
  assert.equal(service.listRequests, listRequestsBeforeRetries);
  assert.equal(
    (await new DevelopmentInMemoryAuditRepository(storageAdapter(service)).list({
      limit: 10,
    })).items.length,
    1,
  );
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

test("hosted mutation field boundaries reject before consuming the one-use proof", async () => {
  for (const mediaType of ["json", "form"] as const) {
    const service = storageService();
    await seedMismatch(service);
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
    const valid = actionBody(resource);
    assert.equal(
      Object.keys(valid).length,
      mediaType === "json"
        ? MAX_OWNER_AGGREGATE_RECONCILIATION_JSON_FIELDS
        : MAX_OWNER_AGGREGATE_RECONCILIATION_FORM_FIELDS - 1,
    );
    assert.equal(MAX_OWNER_AGGREGATE_RECONCILIATION_JSON_FIELDS, 8);
    assert.equal(MAX_OWNER_AGGREGATE_RECONCILIATION_FORM_FIELDS, 9);
    const overLimit = { ...valid, unexpected: "extra" };
    const wrongShape = { ...valid, unexpected: "replacement" } as
      Record<string, unknown>;
    delete wrongShape.confirmation;

    for (const invalid of [overLimit, wrongShape]) {
      const response = await worker.fetch(
        mediaType === "json"
          ? ownerMutation(invalid, proof)
          : ownerFormMutation(invalid, proof),
        env,
        executionContext,
      );
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(
        service.recordKeys().filter((key) =>
          key.startsWith("browser-mutation-replays/")
        ).length,
        0,
      );
    }

    const corrected = await worker.fetch(
      mediaType === "json"
        ? ownerMutation(valid, proof)
        : ownerFormMutation(valid, proof),
      env,
      executionContext,
    );
    assert.equal(corrected.status, 200);
    assert.match(corrected.headers.get("set-cookie") ?? "", /Max-Age=0/u);
  }
});

test("hosted rev1 preview cannot correct after the campaign advances to rev2", async () => {
  const service = storageService();
  const seeded = await seedMismatch(service);
  const campaigns = new StorageCampaignRepository(storageAdapter(service));
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
  const advertised = actionBody(resource);
  assert.equal(resource.data.campaign_revision, 1);
  assert.equal(advertised["expected-campaign-revision"], 1);

  const revisionOne = await campaigns.readSetup();
  assert(revisionOne);
  await campaigns.saveSetup({
    operationId: "campaign-operation:advance-before-correction",
    recordedAt: "2026-08-11T09:01:00.000Z",
    expectedRevision: revisionOne.revision,
    setup: campaignSetupWithCurrency(
      revisionOne.setup,
      "SEK",
      "Advanced campaign",
    ),
  });
  const listRequestsBeforePost = service.listRequests;

  const failed = await worker.fetch(
    ownerMutation(advertised, proof),
    env,
    executionContext,
  );
  assert.equal(failed.status, 412);
  assert.match(failed.headers.get("set-cookie") ?? "", /Max-Age=0/u);
  assert.equal(service.listRequests, listRequestsBeforePost);
  assert.equal((await campaigns.readSetup())?.revision, 2);
  assert.equal((await seeded.aggregate.previewReconciliation()).status, "mismatch");
  assert.deepEqual(
    (await new DevelopmentInMemoryAuditRepository(seeded.adapter).list({
      limit: 10,
    })).items,
    [],
  );
  assert.equal(
    service.recordKeys().some((key) =>
      key.startsWith("investment-aggregate-operations/aggregate-correction:")
    ),
    false,
  );
});

test("hosted maximum aggregate revision exposes comparison without action or proof", async () => {
  const service = storageService();
  await seedMismatch(service);
  service.setRecord({
    collection: "investment-aggregate-states",
    id: "current-investment-aggregate",
    revision: Number.MAX_SAFE_INTEGER,
    value: {
      kind: "investment-aggregate-state",
      schemaVersion: 1,
      snapshot: {
        revision: Number.MAX_SAFE_INTEGER,
        totalAmount: 45_000,
        currency: "SEK",
        contributingIndicationCount: 1,
      },
    },
  });
  const worker = hostedWorker(service);
  const env = environment();

  const jsonResponse = await worker.fetch(
    ownerRequest(PATH),
    env,
    executionContext,
  );
  const resource = await jsonResponse.json() as
    OwnerAggregateReconciliationDocument;
  assert.equal(jsonResponse.status, 200);
  assert.equal(resource.data.status, "mismatch");
  assert.equal(resource.data.stored.revision, Number.MAX_SAFE_INTEGER);
  assert.equal(resource.data.correction_required, true);
  assert.equal(resource.data.correction_available, false);
  assert.deepEqual(resource.actions, []);
  assert.equal(jsonResponse.headers.get(MUTATION_CSRF_HEADER), null);
  assert.equal(jsonResponse.headers.get("set-cookie"), null);

  const htmlResponse = await worker.fetch(
    ownerRequest(PATH, "text/html"),
    env,
    executionContext,
  );
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.match(
    html,
    new RegExp(`<th scope="row">Stored</th><td>${Number.MAX_SAFE_INTEGER}</td>`, "u"),
  );
  assert.match(html, /Correction is unavailable for this stored revision\./u);
  assert.doesNotMatch(html, /<form/u);
  assert.equal(htmlResponse.headers.get(MUTATION_CSRF_HEADER), null);
  assert.equal(htmlResponse.headers.get("set-cookie"), null);
});

test("hosted correction rolls back on a concurrent campaign change and succeeds after restart", async () => {
  const service = storageService();
  const seeded = await seedMismatch(service);
  const campaigns = new StorageCampaignRepository(storageAdapter(service));
  let raced = false;
  const racingFetch: typeof service.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (
      !raced &&
      request.method === "POST" &&
      new URL(request.url).pathname === "/records/transactions"
    ) {
      const body = record(await request.clone().json());
      const transaction = record(body.transaction);
      const operationId = transaction.operation_id;
      if (
        typeof operationId === "string" &&
        operationId.startsWith("aggregate-correction:")
      ) {
        const current = await campaigns.readSetup();
        assert(current);
        await campaigns.saveSetup({
          operationId: "campaign-operation:aggregate-reconciliation-race",
          recordedAt: "2026-08-11T09:01:00.000Z",
          expectedRevision: current.revision,
          setup: campaignSetupWithCurrency(current.setup, "EUR", "Raced campaign"),
        });
        raced = true;
      }
    }
    return service.fetch(request);
  };
  const worker = hostedWorker(service, racingFetch);
  const env = environment();
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
  assert.equal(failed.status, 412);
  assert.equal(raced, true);
  assert.equal((await campaigns.readSetup())?.revision, 2);
  assert.equal((await seeded.aggregate.previewReconciliation()).status, "mismatch");
  assert.equal(
    (await new DevelopmentInMemoryAuditRepository(seeded.adapter).list({
      limit: 10,
    })).items.length,
    0,
  );
  assert.equal(
    service.recordKeys().some((key) =>
      key.startsWith("investment-aggregate-operations/aggregate-correction:")
    ),
    false,
  );

  const racedCampaign = await campaigns.readSetup();
  assert(racedCampaign);
  await campaigns.saveSetup({
    operationId: "campaign-operation:aggregate-reconciliation-restore",
    recordedAt: "2026-08-11T09:02:00.000Z",
    expectedRevision: racedCampaign.revision,
    setup: campaignSetupWithCurrency(
      racedCampaign.setup,
      "SEK",
      "Restored campaign",
    ),
  });
  const restarted = hostedWorker(service, service.fetch, 31);
  const retryResourceResponse = await restarted.fetch(
    ownerRequest(PATH),
    env,
    executionContext,
  );
  const retryProof = mutationProof(retryResourceResponse);
  const retryResource = await retryResourceResponse.json() as
    OwnerAggregateReconciliationDocument;
  const corrected = await restarted.fetch(
    ownerMutation(actionBody(retryResource), retryProof),
    env,
    executionContext,
  );
  assert.equal(corrected.status, 200);

  const verified = await hostedWorker(service).fetch(
    ownerRequest(PATH),
    env,
    executionContext,
  );
  const verifiedResource = await verified.json() as
    OwnerAggregateReconciliationDocument;
  assert.equal(verifiedResource.data.status, "match");
  assert.deepEqual(verifiedResource.actions, []);
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

function hostedWorker(
  service: SyntheticAittaDBStorageService,
  fetch: typeof service.fetch = service.fetch,
  initialRandomSeed = 7,
) {
  let randomSeed = initialRandomSeed;
  return createApplicationWorker({
    fetchApplication: async (request) =>
      new Response(
        request.headers.get(OWNER_AGGREGATE_RECONCILIATION_HEADER) ??
          "missing",
      ),
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: createHostedApplicationRuntimeResolver({
      fetch,
      now: () => NOW,
      randomBytes: (length) => {
        randomSeed = (randomSeed + 1) % 255;
        return new Uint8Array(length).fill(randomSeed);
      },
    }),
  });
}

function campaignSetupWithCurrency(
  setup: CampaignSetup,
  currency: string,
  name: string,
) {
  return {
    ...setup,
    publicCampaign: { ...setup.publicCampaign, name },
    amountAggregate: {
      ...setup.amountAggregate,
      amount: { ...setup.amountAggregate.amount, currency },
    },
  };
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
