import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { ActionJsonValue } from "../domain/hypermedia-action.ts";
import {
  OWNER_INITIAL_SETUP_JSON_FIELD_NAMES,
  OWNER_INITIAL_SETUP_MAX_BYTES,
  OWNER_INITIAL_SETUP_PATH,
  OWNER_INITIAL_SETUP_PREVIEW_PATH,
} from "../domain/owner-initial-setup-resource.ts";
import { parseActorSubject, parseTimestamp } from "../domain/foundation.ts";
import { createPublicCampaignDocument } from "../domain/public-campaign-resource.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  createBrowserMutationGuard,
  hashCsrfToken,
  type BrowserMutationGuardOptions,
  type TrustedMutationSession,
} from "../http/mutation-security.ts";
import type { BrowserMutationVerificationLimits } from "../http/browser-mutation-session.ts";
import {
  DevelopmentInMemoryCampaignRepository,
  DevelopmentInMemoryPublicCampaignPresentationReader,
  parseCampaignSetup,
  type AtomicCampaignAuditRepository,
  type CampaignRepository,
  type CampaignSetupHistoryPage,
  type CampaignSetupRevision,
} from "../repositories/in-memory-campaign-repository.ts";
import { DevelopmentInMemoryAuditRepository } from "../repositories/in-memory-audit-notification-repositories.ts";
import type { ApplicationRouteContext } from "../worker/contracts.ts";
import {
  OWNER_INITIAL_SETUP_MAX_FIELDS,
  OWNER_INITIAL_SETUP_WIRE_MAX_BYTES,
  createOwnerInitialSetupRouteHandler,
} from "../worker/routes/owner-initial-setup.ts";
import { explicitCampaignSetup } from "./support/campaign-repository-contract.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";

const CANONICAL_ORIGIN = "https://canonical.example";
const REQUEST_ORIGIN = "https://worker.internal";
const OWNER_SUBJECT = "owner-subject";
const CSRF_TOKEN = "owner_setup_csrf_token_0123456789ABCDEFGHIJKLMN";
const CLEAR_SETUP_COOKIE =
  "__Host-test_setup=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax";
const NOW = new Date("2026-08-09T12:00:00.000Z");

test("unconfigured owners receive no campaign defaults and one complete setup action", async () => {
  const harness = await createHarness();
  const json = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    { accept: "application/json" },
  )));
  assert.equal(json.status, 200);
  assert.equal(json.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  const document = await json.json();
  assert.deepEqual(document.data, {
    configured: false,
    revision: null,
    recorded_at: null,
    publication: "not-configured",
    mutation_consistency: "atomic-campaign-audit",
    readiness: {
      ready: false,
      blockers: ["setup-not-configured"],
      phase_requirements: [],
      campaign_policy_requirements: [],
      deployment_ready: null,
    },
    setup: null,
  });
  const action = requiredAction(document, "create-campaign-setup");
  assert.equal(action.type, "application/json");
  assert.deepEqual(action.fields.map(({ name }) => name), [
    ...OWNER_INITIAL_SETUP_JSON_FIELD_NAMES,
  ]);
  assert.equal(fieldValue(action, "expected-revision"), null);
  for (const name of [
    "public-campaign",
    "phases",
    "amount-aggregate",
    "campaign-policy",
  ]) {
    const field = action.fields.find((candidate) => candidate.name === name);
    assert.ok(field);
    assert.equal(field.max_bytes, OWNER_INITIAL_SETUP_MAX_BYTES);
    assert.equal(Object.hasOwn(field, "value"), false);
    assert.equal(Object.hasOwn(field, "default"), false);
  }

  const html = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    { accept: "text/html" },
  )));
  const body = await html.text();
  assert.equal((body.match(/<h1\b/gu) ?? []).length, 1);
  assert.match(body, /<h1>Initial setup<\/h1>/u);
  assert.match(body, /name="notice-process-email"/u);
  assert.match(body, /name="notice-marketing-consent"/u);
  assert.match(body, /data-repeatable="phase"/u);
  assert.match(body, /data-repeatable="contribution-choice"/u);
  assert.match(body, /name="amount-minimum"/u);
  assert.match(body, /name="review-privacy-retention"/u);
  assert.doesNotMatch(body, /Northstar|SEK|Sweden|Finland|\(JSON\)|name="setup"/iu);
});

test("JSON creation commits unpublished setup and one owner audit atomically", async () => {
  const harness = await createHarness();
  const discovery = await setupDocument(harness.handler);
  const action = requiredAction(discovery, "create-campaign-setup");
  const setup = draftSetup();
  const operationId = String(fieldValue(action, "operation-id"));
  const response = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    {},
    {
      request: jsonMutationRequest(
        OWNER_INITIAL_SETUP_PATH,
        jsonCommand(operationId, null, setup),
      ),
    },
  )));
  assert.equal(response.status, 200);
  const document = await response.json();
  assert.equal(document.data.revision, 1);
  assert.equal(document.data.publication, "unpublished");
  assert.equal(document.actions[0]?.name, "revise-campaign-setup");

  const current = await harness.repository.readSetup();
  assert.equal(current?.revision, 1);
  assert.equal(current?.setup.campaignPolicy.notices.processEmail,
    setup.campaignPolicy.notices.processEmail);
  assert.equal(current?.setup.campaignPolicy.notices.marketingConsent,
    setup.campaignPolicy.notices.marketingConsent);
  assert.equal(await harness.publicReader.readPublishedCampaign(), null);
  const audit = await harness.auditRepository.list({ limit: 10 });
  assert.equal(audit.items.length, 1);
  assert.deepEqual(audit.items[0]?.actor, {
    type: "owner",
    subject: OWNER_SUBJECT,
  });
  assert.equal(resourceTransition(audit.items[0]), "created");
  assert.equal(harness.state.records.size, 7);
});

test("structured HTML creates the same complete setup without a JSON editor", async () => {
  const harness = await createHarness();
  const discovery = await setupDocument(harness.handler);
  const action = requiredAction(discovery, "create-campaign-setup");
  const setup = draftSetup();
  const parameters = structuredFormCommand(
    String(fieldValue(action, "operation-id")),
    null,
    setup,
  );
  const response = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    {},
    {
      request: formMutationRequest(
        OWNER_INITIAL_SETUP_PATH,
        parameters,
        "text/html",
      ),
    },
  )));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"),
    `${CANONICAL_ORIGIN}${OWNER_INITIAL_SETUP_PATH}`);
  const current = await harness.repository.readSetup();
  assert.ok(current);
  const expected = parseCampaignSetup(setup);
  assert.ok(expected.ok);
  assert.deepEqual(current.setup, expected.value);
  assert.equal(current.setup.publicCampaign.published, false);
  assert.equal(current.setup.publicCampaign.name, setup.publicCampaign.name);
  assert.deepEqual(current.setup.phases[0]?.enabledParticipationPaths, [
    "founder",
    "investor",
  ]);
  assert.deepEqual(current.setup.phases[0]?.countryEligibility.countries, [
    "FI",
    "SE",
  ]);
  assert.equal(current.setup.amountAggregate.amount.currency, "SEK");
  assert.equal(current.setup.campaignPolicy.notices.processEmail,
    setup.campaignPolicy.notices.processEmail);
  assert.equal(current.setup.campaignPolicy.notices.marketingConsent,
    setup.campaignPolicy.notices.marketingConsent);
});

test("structured HTML accepts the maximum rows, root-relative media, and 128-character IDs", async () => {
  const harness = await createHarness();
  const discovery = await setupDocument(harness.handler);
  const action = requiredAction(discovery, "create-campaign-setup");
  const base = draftSetup();
  const phase = base.phases[0];
  assert.ok(phase);
  const setup = {
    ...base,
    publicCampaign: {
      ...base.publicCampaign,
      brandMarkUrl: "/brand-mark.svg",
      heroImageUrl: "/campaign-hero.jpg",
      socialImageUrl: "/campaign-social.jpg",
    },
    phases: Array.from({ length: 32 }, (_, index) => ({
      ...phase,
      id: index === 0 ? "p".repeat(128) : `phase:${index}`,
      enabledParticipationPaths: [...phase.enabledParticipationPaths],
      countryEligibility: {
        ...phase.countryEligibility,
        countries: [...phase.countryEligibility.countries],
      },
    })),
    campaignPolicy: {
      ...base.campaignPolicy,
      founderContributionChoices: Array.from({ length: 64 }, (_, index) => ({
        id: index === 0 ? "c".repeat(128) : `area:${index}`,
        label: `Contribution area ${index + 1}`,
      })),
    },
  };
  const parameters = structuredFormCommand(
    String(fieldValue(action, "operation-id")),
    null,
    setup,
  );
  assert.ok([...parameters].length > 256);
  assert.ok([...parameters].length <= OWNER_INITIAL_SETUP_MAX_FIELDS);

  const html = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    { accept: "text/html" },
  )));
  const body = await html.text();
  assert.match(body, /name="brand-mark-url" type="text"/u);
  assert.match(body, /name="hero-image-url" type="text"/u);
  assert.match(body, /name="social-image-url" type="text"/u);
  assert.match(body, /name="phase-__INDEX__-id"[^>]+maxlength="128"/u);
  assert.match(body, /name="contribution-choice-__INDEX__-id"[^>]+maxlength="128"/u);

  const response = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    {},
    {
      request: formMutationRequest(
        OWNER_INITIAL_SETUP_PATH,
        parameters,
        "text/html",
      ),
    },
  )));
  assert.equal(response.status, 303);
  const current = await harness.repository.readSetup();
  assert.equal(current?.setup.phases.length, 32);
  assert.equal(
    current?.setup.campaignPolicy.founderContributionChoices.length,
    64,
  );
  assert.equal(current?.setup.publicCampaign.brandMarkUrl, "/brand-mark.svg");
  assert.equal(current?.setup.phases[0]?.id.length, 128);
  assert.equal(
    current?.setup.campaignPolicy.founderContributionChoices[0]?.id.length,
    128,
  );
});

test("near-maximum UTF-8 setup form uses the distinct setup wire ceiling", async () => {
  const harness = await createHarness();
  const discovery = await setupDocument(harness.handler);
  const action = requiredAction(discovery, "create-campaign-setup");
  const setup = nearMaximumUtf8Setup();
  const parameters = structuredFormCommand(
    String(fieldValue(action, "operation-id")),
    null,
    setup,
  );
  const decodedBytes = byteLength(JSON.stringify(setup));
  const wireBytes = byteLength(parameters.toString());
  assert.equal(decodedBytes <= OWNER_INITIAL_SETUP_MAX_BYTES, true);
  assert.equal(wireBytes > OWNER_INITIAL_SETUP_MAX_BYTES, true);
  assert.equal(wireBytes <= OWNER_INITIAL_SETUP_WIRE_MAX_BYTES, true);
  assert.equal([...parameters].length <= OWNER_INITIAL_SETUP_MAX_FIELDS, true);

  const response = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    {},
    {
      request: formMutationRequest(
        OWNER_INITIAL_SETUP_PATH,
        parameters,
        "text/html",
      ),
    },
  )));
  assert.equal(response.status, 303);
  const current = await harness.repository.readSetup();
  assert.equal(current?.setup.phases.length, 32);
  assert.equal(
    current?.setup.campaignPolicy.founderContributionChoices.length,
    64,
  );
  assert.deepEqual(current?.setup.publicCampaign, setup.publicCampaign);
});

test("UTF-8 campaign values remain renderable within the aggregate setup bound", async () => {
  const harness = await createHarness();
  const base = draftSetup();
  const repeated = "\u00e4";
  const setup = {
    ...base,
    publicCampaign: {
      ...base.publicCampaign,
      hero: {
        ...base.publicCampaign.hero,
        summary: repeated.repeat(500),
        invitation: repeated.repeat(800),
        note: repeated.repeat(500),
      },
      risks: {
        ...base.publicCampaign.risks,
        items: Array.from({ length: 12 }, () => repeated.repeat(500)),
      },
    },
  };
  const serializedCampaign = JSON.stringify(setup.publicCampaign);
  assert.ok(serializedCampaign.length <= 16_000);
  assert.ok(new TextEncoder().encode(serializedCampaign).byteLength > 16_000);

  const discovery = await setupDocument(harness.handler);
  const action = requiredAction(discovery, "create-campaign-setup");
  const response = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    {},
    {
      request: jsonMutationRequest(
        OWNER_INITIAL_SETUP_PATH,
        jsonCommand(
          String(fieldValue(action, "operation-id")),
          null,
          setup,
        ),
      ),
    },
  )));
  assert.equal(response.status, 200);
  const document = await response.json();
  const revise = requiredAction(document, "revise-campaign-setup");
  assert.equal(
    revise.fields.find(({ name }) => name === "public-campaign")?.max_bytes,
    OWNER_INITIAL_SETUP_MAX_BYTES,
  );

  const reread = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    { accept: "application/json" },
  )));
  assert.equal(reread.status, 200);
  assert.equal((await reread.json()).data.revision, 1);
});

test("revisions preserve publication and exact retries append no duplicate evidence", async () => {
  const harness = await createHarness();
  const created = await createThroughJson(harness);
  const revisionAction = requiredAction(
    await setupDocument(harness.handler),
    "revise-campaign-setup",
  );
  const operationId = String(fieldValue(revisionAction, "operation-id"));
  const edited = {
    ...created.setup,
    publicCampaign: {
      ...created.setup.publicCampaign,
      name: "Northstar Systems",
    },
    phases: [{
      ...created.setup.phases[0],
      state: "closed" as const,
    }],
    amountAggregate: {
      ...created.setup.amountAggregate,
      amount: {
        ...created.setup.amountAggregate.amount,
        minimum: 30_000,
      },
    },
    campaignPolicy: {
      ...created.setup.campaignPolicy,
      notices: {
        ...created.setup.campaignPolicy.notices,
        processEmail: "Updated required messages concern registration review.",
        marketingConsent: "Updated optional messages still require separate consent.",
      },
      publicationReadiness: {
        ...created.setup.campaignPolicy.publicationReadiness,
        legalNoticesReviewed: false,
      },
    },
  };
  const command = jsonCommand(operationId, 1, edited);
  const first = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    {},
    { request: jsonMutationRequest(OWNER_INITIAL_SETUP_PATH, command) },
  )));
  assert.equal(first.status, 200);
  const replay = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    {},
    { request: jsonMutationRequest(OWNER_INITIAL_SETUP_PATH, command) },
  )));
  assert.equal(replay.status, 200);
  const current = await harness.repository.readSetup();
  assert.equal(current?.revision, 2);
  assert.equal(current?.setup.publicCampaign.published, false);
  assert.equal(current?.setup.publicCampaign.name, "Northstar Systems");
  assert.equal(current?.setup.campaignPolicy.notices.processEmail,
    edited.campaignPolicy.notices.processEmail);
  assert.deepEqual(
    (await harness.repository.listSetupHistory({ limit: 10 })).items.map(
      ({ revision }) => revision,
    ),
    [1, 2],
  );
  const audit = await harness.auditRepository.list({ limit: 10 });
  assert.deepEqual(audit.items.map(resourceTransition), ["updated", "created"]);

  const changedRetry = jsonCommand(operationId, 1, {
    ...edited,
    publicCampaign: { ...edited.publicCampaign, name: "Changed retry" },
  });
  const conflict = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    {},
    { request: jsonMutationRequest(OWNER_INITIAL_SETUP_PATH, changedRetry) },
  )));
  assert.equal(conflict.status, 409);
  assert.equal((await harness.repository.readSetup())?.revision, 2);
});

test("an exact concurrent retry is recovered after the operation lookup races", async () => {
  const state = new MemoryStorageState();
  const adapter = new MemoryStorageAdapter(state);
  const baseRepository = new DevelopmentInMemoryCampaignRepository(adapter);
  const initial = draftSetup();
  await baseRepository.saveSetupWithAudit({
    operationId: "owner-setup:race-create",
    ownerSubject: OWNER_SUBJECT,
    recordedAt: "2026-08-09T11:00:00.000Z",
    expectedRevision: null,
    setup: initial,
    transition: "created",
  });

  const operationId = "owner-setup:race-update";
  const edited = {
    ...initial,
    publicCampaign: {
      ...initial.publicCampaign,
      name: "Concurrent Northstar",
    },
  };
  let firstOperationLookup = true;
  let raceCommitted = false;
  const racingRepository: AtomicCampaignAuditRepository = {
    mutationConsistency: "atomic-campaign-audit",
    readSetup: async () => {
      if (!raceCommitted) {
        raceCommitted = true;
        await baseRepository.saveSetupWithAudit({
          operationId,
          ownerSubject: OWNER_SUBJECT,
          recordedAt: NOW.toISOString(),
          expectedRevision: 1,
          setup: edited,
          transition: "updated",
        });
      }
      return baseRepository.readSetup();
    },
    findSetupByOperationId: async (candidate) => {
      if (candidate === operationId && firstOperationLookup) {
        firstOperationLookup = false;
        return null;
      }
      return baseRepository.findSetupByOperationId(candidate);
    },
    saveSetup: baseRepository.saveSetup.bind(baseRepository),
    saveSetupWithAudit: baseRepository.saveSetupWithAudit.bind(baseRepository),
    listSetupHistory: baseRepository.listSetupHistory.bind(baseRepository),
  };
  const harness = await createHarness({ repository: racingRepository });
  const response = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    {},
    {
      request: jsonMutationRequest(
        OWNER_INITIAL_SETUP_PATH,
        jsonCommand(operationId, 1, edited),
      ),
    },
  )));
  assert.equal(response.status, 200);
  assert.equal((await baseRepository.readSetup())?.revision, 2);
  assert.deepEqual(
    (await baseRepository.listSetupHistory({ limit: 10 })).items.map(
      ({ revision }) => revision,
    ),
    [1, 2],
  );
});

test("stale, published-create, unknown-field, and bounded-body requests fail closed", async () => {
  const publishedHarness = await createHarness();
  const publishedAction = requiredAction(
    await setupDocument(publishedHarness.handler),
    "create-campaign-setup",
  );
  const publishedSetup = explicitCampaignSetup();
  const published = requiredResponse(await publishedHarness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    {},
    {
      request: jsonMutationRequest(OWNER_INITIAL_SETUP_PATH, jsonCommand(
        String(fieldValue(publishedAction, "operation-id")),
        null,
        publishedSetup,
      )),
    },
  )));
  assert.equal(published.status, 400);
  assert.equal(await publishedHarness.repository.readSetup(), null);

  const harness = await createHarness();
  const created = await createThroughJson(harness);
  const stale = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    {},
    {
      request: jsonMutationRequest(OWNER_INITIAL_SETUP_PATH,
        jsonCommand("owner-setup:stale", 7, created.setup)),
    },
  )));
  assert.equal(stale.status, 412);
  const unknown = jsonCommand("owner-setup:unknown", 1, {
    ...created.setup,
    publicCampaign: {
      ...created.setup.publicCampaign,
      privateDraftNote: "must not be accepted",
    },
  });
  const unknownResponse = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    {},
    { request: jsonMutationRequest(OWNER_INITIAL_SETUP_PATH, unknown) },
  )));
  assert.equal(unknownResponse.status, 400);
  assert.equal((await harness.repository.readSetup())?.revision, 1);

  const boundedHarness = await createHarness();
  const tooLarge = requiredResponse(await boundedHarness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    {},
    {
      request: jsonMutationRequest(OWNER_INITIAL_SETUP_PATH, {
        "operation-id": "owner-setup:oversized",
        "expected-revision": null,
        "public-campaign": {
          filler: "x".repeat(OWNER_INITIAL_SETUP_WIRE_MAX_BYTES),
        },
        phases: [],
        "amount-aggregate": {},
        "campaign-policy": {},
      }),
    },
  )));
  assert.equal(tooLarge.status, 413);
  assert.equal(await boundedHarness.repository.readSetup(), null);
});

test("post-verification setup failures clear exactly one consumed proof cookie", async () => {
  const malformedHarness = await createHarness();
  const malformedAction = requiredAction(
    await setupDocument(malformedHarness.handler),
    "create-campaign-setup",
  );
  const malformed = {
    ...jsonCommand(
      String(fieldValue(malformedAction, "operation-id")),
      null,
      draftSetup(),
    ),
    unexpected: "rejected",
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = requiredResponse(await malformedHarness.handler(routeContext(
      OWNER_INITIAL_SETUP_PATH,
      { accept: "application/json" },
      { request: jsonMutationRequest(OWNER_INITIAL_SETUP_PATH, malformed) },
    )));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("set-cookie"), CLEAR_SETUP_COOKIE);
  }

  const staleHarness = await createHarness();
  const current = await createThroughJson(staleHarness);
  const stale = jsonCommand(
    "owner-setup:stale-cookie-test",
    7,
    current.setup,
  );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = requiredResponse(await staleHarness.handler(routeContext(
      OWNER_INITIAL_SETUP_PATH,
      { accept: "application/json" },
      { request: jsonMutationRequest(OWNER_INITIAL_SETUP_PATH, stale) },
    )));
    assert.equal(response.status, 412);
    assert.equal(response.headers.get("set-cookie"), CLEAR_SETUP_COOKIE);
  }
});

test("readiness exposes objective details and preview never publishes", async () => {
  const harness = await createHarness({ deploymentReady: false });
  const setup = draftSetup();
  setup.phases[0] = {
    ...setup.phases[0],
    enabledParticipationPaths: [],
    countryEligibility: { mode: "allow", countries: [] },
  };
  setup.campaignPolicy.publicationReadiness = {
    publicPresentationReviewed: false,
    legalNoticesReviewed: false,
    privacyAndRetentionReviewed: false,
  };
  await createThroughJson(harness, setup);
  const document = await setupDocument(harness.handler);
  assert.deepEqual(document.data.readiness.blockers, [
    "phase-setup-incomplete",
    "campaign-policy-incomplete",
    "deployment-not-ready",
  ]);
  assert.deepEqual(document.data.readiness.phase_requirements, [{
    phase_id: "phase:domestic",
    missing: ["enabledParticipationPaths", "countryEligibility.countries"],
  }]);
  assert.deepEqual(document.data.readiness.campaign_policy_requirements, [
    "publicationReadiness.publicPresentationReviewed",
    "publicationReadiness.legalNoticesReviewed",
    "publicationReadiness.privacyAndRetentionReviewed",
  ]);
  assert.equal(document.data.readiness.deployment_ready, false);

  let previewOptions: Parameters<ApplicationRouteContext["renderApplication"]>[0];
  const preview = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PREVIEW_PATH,
    { accept: "text/html" },
    {
      renderApplication: async (options) => {
        previewOptions = options;
        return new Response(`<h1>${options?.campaign?.name}</h1>`);
      },
    },
  )));
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-location"),
    OWNER_INITIAL_SETUP_PREVIEW_PATH);
  assert.equal(previewOptions?.campaign?.published, true);
  assert.equal((await harness.repository.readSetup())?.setup.publicCampaign.published,
    false);
  assert.equal(await harness.publicReader.readPublishedCampaign(), null);

  const jsonPreview = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PREVIEW_PATH,
    { accept: "application/json" },
  )));
  const previewDocument = await jsonPreview.json();
  const visitor = createPublicCampaignDocument(
    `${CANONICAL_ORIGIN}/`,
    previewDocument.data.public_campaign,
  );
  assert.deepEqual(previewDocument.data.rendered, visitor.data);
  assert.deepEqual(previewDocument.actions, visitor.actions);
});

test("anonymous, non-owner, wrong-session, origin, and CSRF paths do not mutate", async () => {
  const harness = await createHarness();
  const anonymous = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    { accept: "application/json" },
    { actor: null },
  )));
  assert.equal(anonymous.status, 401);
  const foreign = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    { accept: "application/json" },
    { isOwner: false },
  )));
  assert.equal(foreign.status, 404);
  assert.equal(harness.repositoryReads(), 0);

  const setup = draftSetup();
  for (const options of [
    { origin: "https://attacker.example" },
    { csrf: "wrong_csrf_token_0123456789ABCDEFGHIJKLMN" },
  ]) {
    const response = requiredResponse(await harness.handler(routeContext(
      OWNER_INITIAL_SETUP_PATH,
      {},
      {
        request: jsonMutationRequest(
          OWNER_INITIAL_SETUP_PATH,
          jsonCommand("owner-setup:rejected", null, setup),
          options,
        ),
      },
    )));
    assert.equal(response.status, 403);
  }
  const wrongSession = await createHarness({ sessionSubject: "other-owner" });
  const rejected = requiredResponse(await wrongSession.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    {},
    {
      request: jsonMutationRequest(
        OWNER_INITIAL_SETUP_PATH,
        jsonCommand("owner-setup:wrong-session", null, setup),
      ),
    },
  )));
  assert.equal(rejected.status, 403);
  assert.equal(await harness.repository.readSetup(), null);
  assert.equal(await wrongSession.repository.readSetup(), null);
});

test("non-atomic repositories advertise no mutation and reject direct POST before guard", async () => {
  const repository = new ReadOnlyCampaignRepository();
  let guardCalls = 0;
  const harness = await createHarness({
    repository,
    onGuard: () => {
      guardCalls += 1;
    },
  });
  const document = await setupDocument(harness.handler);
  assert.equal(document.data.mutation_consistency, "unavailable");
  assert.deepEqual(document.actions, []);
  const response = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    {},
    {
      request: jsonMutationRequest(OWNER_INITIAL_SETUP_PATH, {}),
    },
  )));
  assert.equal(response.status, 503);
  assert.equal(guardCalls, 0);
});

test("content negotiation, methods, CSP, and responsive CSS remain closed and scoped", async () => {
  const harness = await createHarness();
  const unsupported = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    { accept: "application/vnd.aittadb-invest+json; version=99" },
  )));
  assert.equal(unsupported.status, 406);
  const wrongMethodRequest = new Request(
    `${REQUEST_ORIGIN}${OWNER_INITIAL_SETUP_PREVIEW_PATH}`,
    { method: "DELETE", headers: { Accept: "application/json" } },
  );
  const wrongMethod = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PREVIEW_PATH,
    {},
    { request: wrongMethodRequest },
  )));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");

  const html = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    { accept: "text/html" },
  )));
  assert.equal(
    html.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  assert.equal(html.headers.get("cross-origin-resource-policy"), "same-origin");
  const body = await html.text();
  assert.match(body, /<link rel="stylesheet" href="\/owner-initial-setup\.css">/u);
  assert.match(body, /<script src="\/owner-campaign\.js" defer><\/script>/u);
  assert.doesNotMatch(body, /<style\b|<script(?! src)/iu);

  const css = await readFile(
    new URL("../public/owner-initial-setup.css", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    css,
    /(^|\})\s*(?::root|body|html|a|button|input|textarea|select|h[1-6])\b/mu,
  );
  assert.doesNotMatch(css, /gradient\s*\(/iu);
  assert.match(css, /\.owner-setup-page \*/u);
  assert.match(css, /@media \(max-width: 780px\)/u);
});

type HarnessOptions = Readonly<{
  repository?: CampaignRepository;
  deploymentReady?: boolean;
  sessionSubject?: string;
  onGuard?: () => void;
}>;

async function createHarness(options: HarnessOptions = {}) {
  const state = new MemoryStorageState();
  const adapter = new MemoryStorageAdapter(state);
  const baseRepository = new DevelopmentInMemoryCampaignRepository(adapter);
  let repositoryReads = 0;
  const source = options.repository ?? baseRepository;
  const atomicSource = isAtomicRepository(source) ? source : null;
  const repository: CampaignRepository = {
    readSetup: () => {
      repositoryReads += 1;
      return source.readSetup();
    },
    findSetupByOperationId: (operationId) =>
      source.findSetupByOperationId(operationId),
    saveSetup: (request) => source.saveSetup(request),
    listSetupHistory: (request) => source.listSetupHistory(request),
    ...(atomicSource !== null
      ? {
          mutationConsistency: "atomic-campaign-audit" as const,
          saveSetupWithAudit: atomicSource.saveSetupWithAudit.bind(atomicSource),
        }
      : {}),
  };
  const tokenHash = await hashCsrfToken(CSRF_TOKEN);
  let operationSequence = 0;
  const handler = createOwnerInitialSetupRouteHandler({
    repository,
    checkPublicationReadiness: async () => options.deploymentReady ?? true,
    mutationSession: mutationSession({
      allowedOrigins: [CANONICAL_ORIGIN],
      maxBodyBytes: 1_048_576,
      maxFields: OWNER_INITIAL_SETUP_MAX_FIELDS,
      now: () => NOW,
      resolveSession: async () => {
        options.onGuard?.();
        return trustedSession(options.sessionSubject ?? OWNER_SUBJECT, tokenHash);
      },
    }),
    appOrigin: CANONICAL_ORIGIN,
    issueOperationId: () =>
      `owner-setup:route-${String(++operationSequence).padStart(3, "0")}`,
    now: () => NOW,
  });
  return {
    handler,
    repository,
    repositoryReads: () => repositoryReads,
    publicReader: new DevelopmentInMemoryPublicCampaignPresentationReader(adapter),
    auditRepository: new DevelopmentInMemoryAuditRepository(adapter),
    state,
  };
}

function mutationSession(
  options: BrowserMutationGuardOptions,
) {
  const expiresAt = parseTimestamp("2026-08-09T13:00:00.000Z");
  assert(expiresAt.ok);
  return Object.freeze({
    async issue() {
      return Object.freeze({
        token: CSRF_TOKEN,
        expiresAt: expiresAt.value,
        setCookie: "__Host-test_setup=proof; Path=/; Secure; HttpOnly; SameSite=Lax",
      });
    },
    async issueExactReplay() {
      return Object.freeze({
        token: CSRF_TOKEN,
        expiresAt: expiresAt.value,
        setCookie: "__Host-test_setup=proof; Path=/; Secure; HttpOnly; SameSite=Lax",
      });
    },
    async verifyMutation(
      request: Request,
      _identity: unknown,
      _appOrigin: string,
      limits?: BrowserMutationVerificationLimits,
    ) {
      const guard = createBrowserMutationGuard({
        ...options,
        ...(limits === undefined
          ? {}
          : {
              maxBodyBytes: limits.maxBodyBytes,
              maxFields: limits.maxFields,
              ...(limits.repeatedFormFields === undefined
                ? {}
                : { repeatedFormFields: limits.repeatedFormFields }),
            }),
      });
      return Object.freeze({
        ...await guard(request),
        clearCookie: CLEAR_SETUP_COOKIE,
      });
    },
  });
}

function trustedSession(
  subjectValue: string,
  tokenHash: Awaited<ReturnType<typeof hashCsrfToken>>,
): TrustedMutationSession {
  const subject = parseActorSubject(subjectValue);
  const expiresAt = parseTimestamp("2026-08-09T13:00:00.000Z");
  assert(subject.ok);
  assert(expiresAt.ok);
  return Object.freeze({
    actor: Object.freeze({ type: "owner", subject: subject.value }),
    expiresAt: expiresAt.value,
    csrf: Object.freeze({ tokenHash, expiresAt: expiresAt.value }),
  });
}

function routeContext(
  pathname: string,
  headers: HeadersInit,
  overrides: Readonly<{
    request?: Request;
    actor?: ApplicationRouteContext["actor"];
    isOwner?: boolean;
    renderApplication?: ApplicationRouteContext["renderApplication"];
  }> = {},
): ApplicationRouteContext {
  const request = overrides.request ?? new Request(
    `${REQUEST_ORIGIN}${pathname}`,
    { headers },
  );
  return {
    request,
    url: new URL(request.url),
    resourceUrl: `${CANONICAL_ORIGIN}${pathname}`,
    actor: Object.hasOwn(overrides, "actor")
      ? overrides.actor ?? null
      : {
          userId: OWNER_SUBJECT,
          email: "owner@example.com",
          displayName: "Owner",
        },
    isOwner: overrides.isOwner ?? true,
    participantAccess: null,
    campaign: null,
    renderApplication: overrides.renderApplication ??
      (async () => new Response("preview")),
  };
}

function jsonMutationRequest(
  pathname: string,
  body: unknown,
  options: Readonly<{
    origin?: string;
    csrf?: string;
  }> = {},
): Request {
  return new Request(`${REQUEST_ORIGIN}${pathname}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: options.origin ?? CANONICAL_ORIGIN,
      [MUTATION_CSRF_HEADER]: options.csrf ?? CSRF_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

function formMutationRequest(
  pathname: string,
  body: URLSearchParams,
  accept = "application/json",
): Request {
  return new Request(`${REQUEST_ORIGIN}${pathname}`, {
    method: "POST",
    headers: {
      Accept: accept,
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: CANONICAL_ORIGIN,
    },
    body,
  });
}

async function setupDocument(
  handler: ReturnType<typeof createOwnerInitialSetupRouteHandler>,
) {
  const response = requiredResponse(await handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    { accept: "application/json" },
  )));
  assert.equal(response.status, 200);
  return response.json();
}

type TestAction = Readonly<{
  name: string;
  type: string;
  fields: readonly Readonly<{
    name: string;
    value?: ActionJsonValue;
    default?: ActionJsonValue;
    max_bytes?: number;
  }>[];
}>;

function requiredAction(
  document: Readonly<{ actions: readonly TestAction[] }>,
  name: string,
): TestAction {
  const action = document.actions.find((candidate) => candidate.name === name);
  assert.ok(action);
  return action;
}

function fieldValue(action: TestAction, name: string): ActionJsonValue {
  const field = action.fields.find((candidate) => candidate.name === name);
  assert.ok(field);
  if (Object.hasOwn(field, "value")) return field.value as ActionJsonValue;
  if (Object.hasOwn(field, "default")) return field.default as ActionJsonValue;
  assert.fail(`Missing action value for ${name}`);
}

function jsonCommand(
  operationId: string,
  expectedRevision: number | null,
  setup: Readonly<{
    publicCampaign: unknown;
    phases: unknown;
    amountAggregate: unknown;
    campaignPolicy: unknown;
  }>,
): Record<string, unknown> {
  return {
    "operation-id": operationId,
    "expected-revision": expectedRevision,
    "public-campaign": setup.publicCampaign,
    phases: setup.phases,
    "amount-aggregate": setup.amountAggregate,
    "campaign-policy": setup.campaignPolicy,
  };
}

function draftSetup() {
  const setup = explicitCampaignSetup();
  return {
    ...setup,
    publicCampaign: { ...setup.publicCampaign, published: false },
    phases: setup.phases.map((phase) => ({
      ...phase,
      enabledParticipationPaths: [...phase.enabledParticipationPaths],
      countryEligibility: {
        ...phase.countryEligibility,
        countries: [...phase.countryEligibility.countries],
      },
    })),
    campaignPolicy: {
      ...setup.campaignPolicy,
      founderContributionChoices: setup.campaignPolicy.founderContributionChoices
        .map((choice) => ({ ...choice })),
      notices: {
        ...setup.campaignPolicy.notices,
        privacyContact: { ...setup.campaignPolicy.notices.privacyContact },
      },
      publicationReadiness: {
        ...setup.campaignPolicy.publicationReadiness,
      },
    },
  };
}

function nearMaximumUtf8Setup() {
  const base = draftSetup();
  const repeated = "\u754c";
  const countries = Array.from(
    { length: 26 * 26 },
    (_, index) =>
      String.fromCharCode(65 + Math.floor(index / 26)) +
      String.fromCharCode(65 + index % 26),
  );
  const candidate = {
    ...base,
    publicCampaign: {
      ...base.publicCampaign,
      hero: {
        ...base.publicCampaign.hero,
        summary: repeated.repeat(500),
        invitation: repeated.repeat(800),
        note: repeated.repeat(500),
      },
      risks: {
        ...base.publicCampaign.risks,
        items: Array.from({ length: 12 }, () => repeated.repeat(500)),
      },
      faq: {
        ...base.publicCampaign.faq,
        items: Array.from({ length: 4 }, () => ({
          question: repeated.repeat(240),
          answer: repeated.repeat(800),
        })),
      },
    },
    phases: Array.from({ length: 32 }, (_, index) => ({
      id: `phase:max-${String(index).padStart(2, "0")}`,
      state: "open",
      enabledParticipationPaths: ["investor", "founder"],
      countryEligibility: { mode: "allow", countries },
    })),
    campaignPolicy: {
      ...base.campaignPolicy,
      founderContributionChoices: Array.from({ length: 64 }, (_, index) => ({
        id: `area:max-${String(index).padStart(2, "0")}`,
        label: repeated.repeat(120),
      })),
      notices: {
        ...base.campaignPolicy.notices,
        legalBoundary: repeated.repeat(4_000),
        nonBindingInterest: repeated.repeat(4_000),
        processEmail: repeated.repeat(4_000),
        marketingConsent: repeated.repeat(4_000),
        retention: repeated.repeat(4_000),
      },
    },
  };
  const parsed = parseCampaignSetup(candidate);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("Invalid near-maximum setup fixture.");
  return parsed.value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function createThroughJson(
  harness: Awaited<ReturnType<typeof createHarness>>,
  setup = draftSetup(),
): Promise<CampaignSetupRevision> {
  const discovery = await setupDocument(harness.handler);
  const action = requiredAction(discovery, "create-campaign-setup");
  const response = requiredResponse(await harness.handler(routeContext(
    OWNER_INITIAL_SETUP_PATH,
    {},
    {
      request: jsonMutationRequest(OWNER_INITIAL_SETUP_PATH, jsonCommand(
        String(fieldValue(action, "operation-id")),
        null,
        setup,
      )),
    },
  )));
  assert.equal(response.status, 200);
  const current = await harness.repository.readSetup();
  assert.ok(current);
  return current;
}

function structuredFormCommand(
  operationId: string,
  expectedRevision: number | null,
  candidate: unknown,
): URLSearchParams {
  const parsed = parseCampaignSetup(candidate);
  assert.ok(parsed.ok);
  const setup = parsed.value;
  const campaign = setup.publicCampaign;
  const amount = setup.amountAggregate;
  const policy = setup.campaignPolicy;
  const parameters = new URLSearchParams({
    [MUTATION_CSRF_FIELD]: CSRF_TOKEN,
    "operation-id": operationId,
    "expected-revision": expectedRevision === null ? "" : String(expectedRevision),
    published: String(campaign.published),
    "campaign-id": campaign.id,
    status: campaign.status,
    name: campaign.name,
    "page-title": campaign.pageTitle,
    "page-description": campaign.pageDescription,
    "phase-label": campaign.phaseLabel,
    "status-label": campaign.statusLabel,
    "brand-mark-url": campaign.brandMarkUrl ?? "",
    "hero-image-url": campaign.heroImageUrl ?? "",
    "social-image-url": campaign.socialImageUrl ?? "",
    "hero-summary": campaign.hero.summary,
    "hero-invitation": campaign.hero.invitation,
    "hero-primary-action-label": campaign.hero.primaryActionLabel,
    "hero-secondary-label": campaign.hero.secondaryAction?.label ?? "",
    "hero-secondary-href": campaign.hero.secondaryAction?.href ?? "",
    "hero-note": campaign.hero.note,
    "participation-eyebrow": campaign.participation.eyebrow,
    "participation-title": campaign.participation.title,
    "risks-eyebrow": campaign.risks.eyebrow,
    "risks-title": campaign.risks.title,
    "closing-eyebrow": campaign.closing.eyebrow,
    "closing-title": campaign.closing.title,
    "closing-action-label": campaign.closing.actionLabel,
    "footer-tagline": campaign.footer.tagline,
    "amount-currency": amount.amount.currency,
    "amount-minimum": String(amount.amount.minimum),
    "amount-increment": String(amount.amount.increment),
    "amount-maximum": amount.amount.maximum === null
      ? ""
      : String(amount.amount.maximum),
    "aggregate-visibility": amount.publicAggregate.visibility,
    "aggregate-label": amount.publicAggregate.visibility === "non_zero"
      ? amount.publicAggregate.label
      : "",
    "aggregate-qualifier": amount.publicAggregate.visibility === "non_zero"
      ? amount.publicAggregate.qualifier
      : "",
    "notice-legal-boundary": policy.notices.legalBoundary,
    "notice-non-binding-interest": policy.notices.nonBindingInterest,
    "notice-process-email": policy.notices.processEmail,
    "notice-marketing-consent": policy.notices.marketingConsent,
    "privacy-contact-label": policy.notices.privacyContact.label,
    "privacy-contact-href": policy.notices.privacyContact.href,
    "notice-retention": policy.notices.retention,
  });
  if (campaign.hero.secondaryAction) {
    parameters.set("hero-secondary-enabled", "true");
  }
  campaign.navigation.forEach((item, index) =>
    setRow(parameters, "navigation", index, item)
  );
  campaign.facts.forEach((item, index) =>
    setRow(parameters, "fact", index, item)
  );
  campaign.participation.paths.forEach((item, index) =>
    setRow(parameters, "participation-path", index, {
      kind: item.kind,
      title: item.title,
      description: item.description,
      "action-label": item.actionLabel,
    })
  );
  if (campaign.product) {
    parameters.set("product-enabled", "true");
    parameters.set("product-eyebrow", campaign.product.eyebrow);
    parameters.set("product-title", campaign.product.title);
    parameters.set("product-description", campaign.product.description);
    campaign.product.links.forEach((item, index) =>
      setLinkRow(parameters, "product-link", index, item)
    );
    campaign.product.capabilities.forEach((item, index) =>
      setRow(parameters, "product-capability", index, item)
    );
  }
  if (campaign.process) {
    parameters.set("process-enabled", "true");
    parameters.set("process-eyebrow", campaign.process.eyebrow);
    parameters.set("process-title", campaign.process.title);
    campaign.process.steps.forEach((item, index) =>
      setRow(parameters, "process-step", index, item)
    );
  }
  campaign.risks.items.forEach((item, index) =>
    setRow(parameters, "risk", index, { text: item })
  );
  if (campaign.faq) {
    parameters.set("faq-enabled", "true");
    parameters.set("faq-eyebrow", campaign.faq.eyebrow);
    parameters.set("faq-title", campaign.faq.title);
    campaign.faq.items.forEach((item, index) =>
      setRow(parameters, "faq-item", index, item)
    );
  }
  campaign.footer.links.forEach((item, index) =>
    setLinkRow(parameters, "footer-link", index, item)
  );
  setup.phases.forEach((phase, index) => {
    parameters.set(`phase-${index}-id`, phase.id);
    parameters.set(`phase-${index}-state`, phase.state);
    if (phase.enabledParticipationPaths.includes("founder")) {
      parameters.set(`phase-${index}-founder-enabled`, "true");
    }
    if (phase.enabledParticipationPaths.includes("investor")) {
      parameters.set(`phase-${index}-investor-enabled`, "true");
    }
    parameters.set(`phase-${index}-country-mode`, phase.countryEligibility.mode);
    parameters.set(`phase-${index}-countries`,
      phase.countryEligibility.countries.join(" "));
  });
  policy.founderContributionChoices.forEach((choice, index) =>
    setRow(parameters, "contribution-choice", index, choice)
  );
  if (policy.publicationReadiness.publicPresentationReviewed) {
    parameters.set("review-public-presentation", "true");
  }
  if (policy.publicationReadiness.legalNoticesReviewed) {
    parameters.set("review-legal-notices", "true");
  }
  if (policy.publicationReadiness.privacyAndRetentionReviewed) {
    parameters.set("review-privacy-retention", "true");
  }
  return parameters;
}

function setRow(
  parameters: URLSearchParams,
  prefix: string,
  index: number,
  values: Readonly<Record<string, string>>,
): void {
  for (const [name, value] of Object.entries(values)) {
    parameters.set(`${prefix}-${index}-${name}`, value);
  }
}

function setLinkRow(
  parameters: URLSearchParams,
  prefix: string,
  index: number,
  link: Readonly<{ label: string; href: string; rel: readonly string[] }>,
): void {
  setRow(parameters, prefix, index, {
    label: link.label,
    href: link.href,
    rel: link.rel.join(" "),
  });
}

function resourceTransition(
  event: Awaited<ReturnType<DevelopmentInMemoryAuditRepository["list"]>>["items"][number] | undefined,
): string | null {
  return event?.detail.kind === "resource-transition"
    ? event.detail.transition
    : null;
}

function requiredResponse(response: Response | null): Response {
  assert.ok(response);
  return response;
}

function isAtomicRepository(
  repository: CampaignRepository,
): repository is AtomicCampaignAuditRepository {
  const candidate = repository as Partial<AtomicCampaignAuditRepository>;
  return candidate.mutationConsistency === "atomic-campaign-audit" &&
    typeof candidate.saveSetupWithAudit === "function";
}

class ReadOnlyCampaignRepository implements CampaignRepository {
  async readSetup(): Promise<CampaignSetupRevision | null> {
    return null;
  }

  async findSetupByOperationId(): Promise<CampaignSetupRevision | null> {
    return null;
  }

  async saveSetup(): Promise<CampaignSetupRevision> {
    throw new Error("unavailable");
  }

  async listSetupHistory(): Promise<CampaignSetupHistoryPage> {
    return { items: [], nextCursor: null };
  }
}
