import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseActorSubject,
  parseTimestamp,
  type ActorSubject,
  type Timestamp,
} from "../domain/foundation.ts";
import {
  PARTICIPANT_REGISTRATION_OPERATION_ID_LENGTH,
  PARTICIPANT_REGISTRATION_PATH,
  ParticipantRegistrationResourceError,
  createParticipantRegistrationCapabilityModel,
  parseParticipantRegistrationOperationId,
} from "../domain/participant-registration-resource.ts";
import {
  parseParticipantAccount,
  type ParticipantAccount,
} from "../domain/participant-profile.ts";
import {
  INVESTOR_APP_API_VERSION,
  INVESTOR_APP_MEDIA_TYPE,
} from "../domain/public-campaign-resource.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  MutationSecurityFailure,
  hashCsrfToken,
  type TrustedMutationSession,
} from "../http/mutation-security.ts";
import {
  createBrowserMutationSession,
  type BrowserMutationProof,
  type BrowserMutationReplayClaim,
  type TrustedSitesMutationIdentity,
} from "../http/browser-mutation-session.ts";
import {
  DevelopmentInMemoryParticipantRepository,
  type ParticipantRegistrationRepository,
  type ParticipantProfileSnapshot,
} from "../repositories/in-memory-participant-repository.ts";
import type { ApplicationRouteContext } from "../worker/contracts.ts";
import { createParticipantRouteHandler } from "../worker/routes/participant.ts";
import {
  MAX_REGISTRATION_MUTATION_BYTES,
  MAX_REGISTRATION_MUTATION_FIELDS,
  createParticipantRegistrationRouteHandler,
  type ParticipantRegistrationMutationVerifier,
} from "../worker/routes/participant-registration.ts";
import { syntheticPublicCampaign } from "./fixtures/public-campaign.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";
import { testParticipantRegistrationNoticeEvidence } from "./support/participant-registration-notice-evidence.ts";

const APP_ORIGIN = "https://campaign.example";
const SECOND_ALLOWED_ORIGIN = "https://other-campaign.example";
const CSRF_TOKEN = "registration_csrf_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALICE = subject("issuer.invalid/participant:alice");
const BOB = subject("issuer.invalid/participant:bob");
const OWNER = subject("issuer.invalid/owner:campaign");
const PROCESS_NOTICE =
  "Required <process> messages concern registration and campaign participation.";
const MARKETING_NOTICE =
  "Optional marketing messages are separate from required process messages.";
const NOTICE_EVIDENCE = testParticipantRegistrationNoticeEvidence(1, {
  processEmail: PROCESS_NOTICE,
  marketing: MARKETING_NOTICE,
});
const ISSUED_COOKIE =
  "__Host-investor_mutation_test=encrypted; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Strict";
const CLEAR_COOKIE =
  "__Host-investor_mutation_test=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict";

test("registration GET exposes equivalent HTML and versioned hypermedia without browser identity fields", async () => {
  const harness = await createHarness();
  const actor = participant(ALICE, "alice@provider.example");
  const jsonResponse = await harness.dispatch(
    getRequest(ALICE, `${INVESTOR_APP_MEDIA_TYPE}; version=${INVESTOR_APP_API_VERSION}`),
    actor,
  );
  assert.equal(jsonResponse.status, 200);
  assert.equal(
    jsonResponse.headers.get("content-type"),
    `${INVESTOR_APP_MEDIA_TYPE}; version=${INVESTOR_APP_API_VERSION}; charset=utf-8`,
  );
  assert.equal(jsonResponse.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  assert.equal(jsonResponse.headers.get("x-content-type-options"), "nosniff");
  const jsonText = await jsonResponse.text();
  assert.doesNotMatch(jsonText, new RegExp(CSRF_TOKEN, "u"));
  assert.doesNotMatch(jsonText, new RegExp(MUTATION_CSRF_HEADER, "iu"));
  const document = dataOf(JSON.parse(jsonText) as unknown);
  const data = resourceData(document);
  assert.deepEqual(data, {
    status: "registration_required",
    notice_evidence_version: NOTICE_EVIDENCE.version,
    account_email: "alice@provider.example",
    account_email_editable: false,
    display_name: null,
    country: null,
    declared_interest: null,
    participation_context: null,
    process_email_notice: PROCESS_NOTICE,
    process_email_notice_acknowledged: false,
    marketing_notice: MARKETING_NOTICE,
    marketing_consent_state: "not-granted",
  });

  const actions = actionsOf(document);
  assert.equal(actions.length, 1);
  const actionFields = fieldsOf(actions[0]);
  const jsonOperationId = String(actionFields[0]?.value);
  assert.notEqual(
    parseParticipantRegistrationOperationId(jsonOperationId),
    null,
  );
  assert.equal(jsonOperationId.length, PARTICIPANT_REGISTRATION_OPERATION_ID_LENGTH);
  assert.equal(actionFields[0]?.min_length, PARTICIPANT_REGISTRATION_OPERATION_ID_LENGTH);
  assert.equal(actionFields[0]?.max_length, PARTICIPANT_REGISTRATION_OPERATION_ID_LENGTH);
  assert.deepEqual(
    actionFields.map((field) => field.name),
    [
      "operation-id",
      "notice-evidence-version",
      "display-name",
      "country",
      "declared-interest",
      "participation-context",
      "process-email-notice-acknowledged",
      "marketing-consent",
    ],
  );
  assert.equal(
    actionFields.some((field) =>
      ["subject", "account-email", "account-email-label", "email"].includes(
        String(field.name),
      )
    ),
    false,
  );
  assert.equal(
    dataOf(actionFields.at(-2)).required,
    true,
  );
  assert.equal(
    dataOf(actionFields.at(-1)).required,
    false,
  );

  const htmlResponse = await harness.dispatch(
    getRequest(ALICE, "text/html"),
    actor,
  );
  assert.equal(htmlResponse.status, 200);
  assert.equal(htmlResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    htmlResponse.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  const html = await htmlResponse.text();
  assertActionFormParity(document, html);
  assert.equal(hiddenCsrfToken(html), CSRF_TOKEN);
  const htmlOperationId = hiddenInputValue(html, "operation-id");
  assert.notEqual(
    parseParticipantRegistrationOperationId(htmlOperationId),
    null,
  );
  assert.equal(
    htmlOperationId.length,
    PARTICIPANT_REGISTRATION_OPERATION_ID_LENGTH,
  );
  assert.match(
    html,
    /<link rel="stylesheet" href="\/participant-registration\.css">/u,
  );
  assert.doesNotMatch(html, /<style\b/iu);
  assert.match(html, /<h1 id="registration-title">Register your interest<\/h1>/u);
  assert.match(html, /alice@provider\.example/u);
  assert.match(html, /Required &lt;process&gt; messages/u);
  assert.doesNotMatch(html, /name="[^"]*(?:subject|account-email|email-label)/iu);
  assert.match(
    html,
    /name="process-email-notice-acknowledged"[^>]* required/u,
  );
  assert.doesNotMatch(
    html,
    /name="marketing-consent"[^>]* required/u,
  );
  const css = await readFile(
    new URL("../public/participant-registration.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.registration-page/u);
});

test("registration capability requires an operation ID only while advertising registration", async () => {
  const alice = participant(ALICE, "alice@provider.example");
  const account = participantAccount(alice);
  const input = {
    requestUrl: `${APP_ORIGIN}${PARTICIPANT_REGISTRATION_PATH}`,
    account,
    profile: null,
    noticeEvidence: NOTICE_EVIDENCE,
  } as const;
  for (const operationId of [
    null,
    "not a stable operation id",
    "participant-operation:private-retry-label",
    "participant-operation:00000000-0000-1000-8000-000000000001",
  ] as const) {
    assert.throws(
      () => createParticipantRegistrationCapabilityModel({
        ...input,
        operationId,
      }),
      ParticipantRegistrationResourceError,
    );
  }

  const harness = await createHarness();
  const response = await harness.dispatch(
    jsonMutation(
      ALICE,
      registrationBody("participant-operation:nullable-resource"),
    ),
    alice,
  );
  assert.equal(response.status, 201);
  const current = await harness.profile(alice);
  assert(current);
  for (const operationId of [null, "ignored invalid value"] as const) {
    const model = createParticipantRegistrationCapabilityModel({
      ...input,
      profile: current.snapshot,
      operationId,
    });
    assert.deepEqual(model.actionContracts, []);
    assert.deepEqual(model.document.actions, []);
  }
});

test("trusted account registration accepts JSON and HTML while keeping marketing consent independent", async () => {
  const harness = await createHarness();
  const alice = participant(ALICE, "alice@provider.example");
  const createdResponse = await harness.dispatch(
    jsonMutation(ALICE, registrationBody("participant-operation:alice-register")),
    alice,
  );
  assert.equal(createdResponse.status, 201);
  assert.equal(createdResponse.headers.get(MUTATION_CSRF_HEADER), null);
  assert.equal(createdResponse.headers.get("x-content-type-options"), "nosniff");
  const created = await jsonDocument(createdResponse);
  assert.deepEqual(resourceData(created), {
    status: "registered",
    notice_evidence_version: NOTICE_EVIDENCE.version,
    account_email: "alice@provider.example",
    account_email_editable: false,
    display_name: "Alice Example",
    country: "FI",
    declared_interest: "both",
    participation_context: "individual",
    process_email_notice: PROCESS_NOTICE,
    process_email_notice_acknowledged: true,
    marketing_notice: MARKETING_NOTICE,
    marketing_consent_state: "not-granted",
  });
  assert.deepEqual(actionsOf(created), []);
  assert.deepEqual(
    linksOf(created).map((link) => String(link.rel)),
    ["self", "campaign", "participant", "private-package"],
  );
  const aliceProfile = await harness.profile(alice);
  assert(aliceProfile);
  assert.equal(aliceProfile.snapshot.subject, ALICE);
  assert.equal(aliceProfile.snapshot.accountEmailLabel, "alice@provider.example");
  assert.equal(aliceProfile.snapshot.marketingConsent.state, "not-granted");

  const bob = participant(BOB, "bob@provider.example");
  const bobResponse = await harness.dispatch(
    formMutation(BOB, [
      [MUTATION_CSRF_FIELD, CSRF_TOKEN],
      ["operation-id", registrationOperationId("bob-register")],
      ["notice-evidence-version", NOTICE_EVIDENCE.version],
      ["display-name", "Bob Example"],
      ["country", "se"],
      ["declared-interest", "founder"],
      ["participation-context", "company"],
      ["process-email-notice-acknowledged", "true"],
      ["marketing-consent", "true"],
    ]),
    bob,
  );
  assert.equal(bobResponse.status, 201);
  const bobHtml = await bobResponse.text();
  assert.match(bobHtml, /Registration complete/u);
  assert.match(bobHtml, /Granted/u);
  assert.doesNotMatch(bobHtml, /<form /u);
  const bobProfile = await harness.profile(bob);
  assert(bobProfile);
  assert.equal(bobProfile.snapshot.country, "SE");
  assert.equal(bobProfile.snapshot.declaredInterest, "founder");
  assert.equal(bobProfile.snapshot.participationContext, "company");
  assert.equal(bobProfile.snapshot.marketingConsent.state, "granted");
});

test("registration preserves exact repository replay and duplicate behavior", async () => {
  const harness = await createHarness();
  const alice = participant(ALICE, "alice@provider.example");
  const operationId = "participant-operation:retry-registration";
  const body = registrationBody(operationId, { "marketing-consent": true });

  const first = await harness.dispatch(jsonMutation(ALICE, body), alice);
  assert.equal(first.status, 201);
  const firstDocument = await jsonDocument(first);
  assert.equal(resourceData(firstDocument).marketing_consent_state, "granted");

  const replay = await harness.dispatch(jsonMutation(ALICE, body), alice);
  assert.equal(replay.status, 200);
  assert.deepEqual(await jsonDocument(replay), firstDocument);
  assert.equal(harness.nowCalls(), 1);

  const changedRetry = await harness.dispatch(
    jsonMutation(
      ALICE,
      registrationBody(operationId, {
        "display-name": "Changed private retry value",
        "marketing-consent": true,
      }),
    ),
    alice,
  );
  assert.equal(changedRetry.status, 409);
  const changedBody = await changedRetry.text();
  assert.doesNotMatch(changedBody, /Changed private|alice@provider|participant:alice/u);

  const duplicate = await harness.dispatch(
    jsonMutation(
      ALICE,
      registrationBody("participant-operation:new-duplicate"),
    ),
    alice,
  );
  assert.equal(duplicate.status, 409);
  const current = await harness.profile(alice);
  assert(current);
  assert.equal(current.revision, 1);
  assert.equal(current.snapshot.displayName, "Alice Example");
  assert.equal(harness.nowCalls(), 1);
});

test("policy changes reject stale, malformed, and foreign notice evidence without writes", async () => {
  const state = new MemoryStorageState();
  const oldHarness = await createHarness({ state });
  const alice = participant(ALICE, "alice@provider.example");
  const discoveryResponse = await oldHarness.dispatch(
    getRequest(ALICE, "application/json"),
    alice,
  );
  const discovery = await jsonDocument(discoveryResponse);
  const action = actionsOf(discovery)[0];
  assert(action);
  assert.equal(action.name, "register-participant-access");
  const oldVersion = String(
    fieldsOf(action).find(({ name }) => name === "notice-evidence-version")
      ?.value,
  );
  assert.equal(oldVersion, NOTICE_EVIDENCE.version);

  const changedEvidence = testParticipantRegistrationNoticeEvidence(2, {
    processEmail: "Changed required process notice.",
    marketing: "Changed optional marketing notice.",
  });
  const changedHarness = await createHarness({
    state,
    noticeEvidence: changedEvidence,
  });
  for (const [name, version, status] of [
    ["stale", oldVersion, 412],
    ["malformed", "not-a-notice-version", 400],
    [
      "foreign",
      testParticipantRegistrationNoticeEvidence(3).version,
      412,
    ],
  ] as const) {
    const response = await changedHarness.dispatch(
      jsonMutation(
        ALICE,
        registrationBody(`participant-operation:${name}-notice`, {
          "notice-evidence-version": version,
        }),
      ),
      alice,
    );
    assert.equal(response.status, status, name);
    assert.doesNotMatch(
      await response.text(),
      /Changed required|alice@provider|participant:alice/u,
    );
    assert.equal(state.operations.size, 0, name);
    assert.equal(await changedHarness.profile(alice), null, name);
  }
});

test("an exact committed retry recovers its original notices after policy change and restart", async () => {
  const state = new MemoryStorageState();
  const alice = participant(ALICE, "alice@provider.example");
  const operationId = "participant-operation:policy-restart-retry";
  const body = registrationBody(operationId, { "marketing-consent": true });
  const firstHarness = await createHarness({ state });
  const first = await firstHarness.dispatch(jsonMutation(ALICE, body), alice);
  assert.equal(first.status, 201);
  assert.equal(state.operations.size, 1);

  const changedEvidence = testParticipantRegistrationNoticeEvidence(2, {
    processEmail: "New process notice must not replace old evidence.",
    marketing: "New marketing notice must not replace old evidence.",
  });
  const restarted = await createHarness({
    state,
    noticeEvidence: changedEvidence,
  });
  const replay = await restarted.dispatch(jsonMutation(ALICE, body), alice);
  assert.equal(replay.status, 200);
  const replayData = resourceData(await jsonDocument(replay));
  assert.equal(replayData.notice_evidence_version, NOTICE_EVIDENCE.version);
  assert.equal(replayData.process_email_notice, PROCESS_NOTICE);
  assert.equal(replayData.marketing_notice, MARKETING_NOTICE);
  assert.equal(replayData.process_email_notice_acknowledged, true);
  assert.equal(replayData.marketing_consent_state, "granted");
  assert.equal(state.operations.size, 1);

  const profile = await restarted.profile(alice);
  assert(profile);
  assert.deepEqual(profile.snapshot.registrationNoticeEvidence, NOTICE_EVIDENCE);
  const reboundRetry = await restarted.dispatch(
    jsonMutation(ALICE, {
      ...body,
      "notice-evidence-version": changedEvidence.version,
    }),
    alice,
  );
  assert.equal(reboundRetry.status, 409);
  const changedRetry = await restarted.dispatch(
    jsonMutation(ALICE, {
      ...body,
      "display-name": "Changed after committed policy retry",
    }),
    alice,
  );
  assert.equal(changedRetry.status, 409);
  assert.equal(state.operations.size, 1);
  assert.deepEqual(
    (await restarted.profile(alice))?.snapshot.registrationNoticeEvidence,
    NOTICE_EVIDENCE,
  );
});

test("registered HTML and JSON expose the same immutable acknowledged notice state", async () => {
  const harness = await createHarness();
  const alice = participant(ALICE, "alice@provider.example");
  const created = await harness.dispatch(
    jsonMutation(
      ALICE,
      registrationBody("participant-operation:registered-parity"),
    ),
    alice,
  );
  assert.equal(created.status, 201);

  const jsonResponse = await harness.dispatch(
    getRequest(ALICE, "application/json"),
    alice,
  );
  const document = await jsonDocument(jsonResponse);
  const data = resourceData(document);
  assert.equal(data.notice_evidence_version, NOTICE_EVIDENCE.version);
  assert.equal(data.process_email_notice, PROCESS_NOTICE);
  assert.equal(data.process_email_notice_acknowledged, true);
  assert.equal(data.marketing_notice, MARKETING_NOTICE);
  assert.deepEqual(actionsOf(document), []);
  assert.equal(jsonResponse.headers.get(MUTATION_CSRF_HEADER), null);

  const htmlResponse = await harness.dispatch(
    getRequest(ALICE, "text/html"),
    alice,
  );
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.equal(htmlResponse.headers.get(MUTATION_CSRF_HEADER), null);
  assert.match(html, /Process notice acknowledged<\/dt><dd>Yes/u);
  assert.match(html, new RegExp(NOTICE_EVIDENCE.version, "u"));
  assert.match(html, /Required &lt;process&gt; messages/u);
  assert.match(html, /Optional marketing messages are separate/u);
  assert.doesNotMatch(html, /<form\b|name="_csrf"/u);
});

test("concurrent exact registration retries preserve the first server timestamp", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  let waiting = 0;
  let release!: () => void;
  const bothReadMissing = new Promise<void>((resolve) => {
    release = resolve;
  });
  const harness = await createHarness({
    repositoryFor(account) {
      const repository = new DevelopmentInMemoryParticipantRepository(
        storage,
        account,
      );
      return {
        async current() {
          const current = await repository.current();
          if (current === null) {
            waiting += 1;
            if (waiting === 2) release();
            await bothReadMissing;
          }
          return current;
        },
        revision: (revision) => repository.revision(revision),
        register: (request) => repository.register(request),
        recoverRegistration: (request) => repository.recoverRegistration(request),
        update: (request) => repository.update(request),
        withdrawMarketingConsent: (request) =>
          repository.withdrawMarketingConsent(request),
        requestAccountDeletion: (request) =>
          repository.requestAccountDeletion(request),
        pendingDeletionIntent: () => repository.pendingDeletionIntent(),
      };
    },
  });
  const alice = participant(ALICE, "alice@provider.example");
  const body = registrationBody(
    "participant-operation:concurrent-exact-registration",
  );

  const responses = await Promise.all([
    harness.dispatch(jsonMutation(ALICE, body), alice),
    harness.dispatch(jsonMutation(ALICE, body), alice),
  ]);
  assert.deepEqual(
    responses.map(({ status }) => status).sort((left, right) => left - right),
    [200, 201],
  );
  assert.equal(harness.nowCalls(), 2);
  const current = await harness.profile(alice);
  assert(current);
  assert.equal(current.revision, 1);
  assert.equal(
    [
      "2026-08-09T10:00:00.000Z",
      "2026-08-09T10:01:00.000Z",
    ].includes(current.snapshot.registeredAt),
    true,
  );
});

test("registration enforces non-owner identity, exact origin, CSRF, bounds, fields, and negotiation", async () => {
  const harness = await createHarness();
  const alice = participant(ALICE, "alice@provider.example");

  const anonymous = await harness.dispatch(
    getRequest(null, "application/json"),
    null,
  );
  assert.equal(anonymous.status, 401);

  const ownerActor = participant(OWNER, "owner@provider.example", true);
  const ownerGet = await harness.dispatch(
    getRequest(OWNER, "application/json"),
    ownerActor,
  );
  assert.equal(ownerGet.status, 404);
  assert.doesNotMatch(await ownerGet.text(), /owner@provider|owner:campaign/u);

  const ownerPost = await harness.dispatch(
    jsonMutation(
      OWNER,
      registrationBody("participant-operation:owner-register"),
      { sessionType: "owner" },
    ),
    ownerActor,
  );
  assert.equal(ownerPost.status, 404);

  const actorSubstitution = await harness.dispatch(
    jsonMutation(BOB, registrationBody("participant-operation:substitution")),
    alice,
  );
  assert.equal(actorSubstitution.status, 404);
  assert.doesNotMatch(
    await actorSubstitution.text(),
    /alice@provider|participant:alice|participant:bob/u,
  );

  const crossOrigin = await harness.dispatch(
    jsonMutation(
      ALICE,
      registrationBody("participant-operation:cross-origin"),
      { origin: SECOND_ALLOWED_ORIGIN },
    ),
    alice,
  );
  assert.equal(crossOrigin.status, 403);

  const badCsrf = await harness.dispatch(
    jsonMutation(
      ALICE,
      registrationBody("participant-operation:bad-csrf"),
      { csrf: "wrong_csrf_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ" },
    ),
    alice,
  );
  assert.equal(badCsrf.status, 403);

  const oversized = await harness.dispatch(
    jsonMutation(
      ALICE,
      registrationBody("participant-operation:oversized", {
        "display-name": "x".repeat(2_000),
      }),
    ),
    alice,
  );
  assert.equal(oversized.status, 413);

  for (const [name, body] of [
    [
      "identity field",
      registrationBody("participant-operation:spoofed", {
        subject: BOB,
        "account-email": "attacker@example.test",
      }),
    ],
    [
      "missing process notice",
      withoutField(
        registrationBody("participant-operation:missing-notice"),
        "process-email-notice-acknowledged",
      ),
    ],
    [
      "unacknowledged process notice",
      registrationBody("participant-operation:false-notice", {
        "process-email-notice-acknowledged": false,
      }),
    ],
    [
      "invalid marketing consent",
      registrationBody("participant-operation:marketing-string", {
        "marketing-consent": "yes",
      }),
    ],
  ] as const) {
    const response = await harness.dispatch(jsonMutation(ALICE, body), alice);
    assert.equal(response.status, 400, name);
    assert.doesNotMatch(
      await response.text(),
      /attacker@example|participant:bob|marketing-string/u,
    );
  }
  assert.equal(await harness.profile(alice), null);

  const unsupportedType = new Request(
    `${APP_ORIGIN}${PARTICIPANT_REGISTRATION_PATH}`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "text/plain",
        origin: APP_ORIGIN,
        "x-test-auth-subject": ALICE,
        [MUTATION_CSRF_HEADER]: CSRF_TOKEN,
      },
      body: "not accepted",
    },
  );
  assert.equal(
    (await harness.dispatch(unsupportedType, alice)).status,
    415,
  );

  const unsupportedVersion = await harness.dispatch(
    getRequest(
      ALICE,
      `${INVESTOR_APP_MEDIA_TYPE}; version=99`,
    ),
    alice,
  );
  assert.equal(unsupportedVersion.status, 406);

  const method = await harness.dispatch(
    new Request(`${APP_ORIGIN}${PARTICIPANT_REGISTRATION_PATH}`, {
      method: "PATCH",
      headers: { accept: "application/json" },
    }),
    alice,
  );
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET, POST");
});

test("registration discovery fails closed for missing, malformed, or actor-mismatched CSRF proofs", async () => {
  const alice = participant(ALICE, "private-account@provider.example");
  for (const csrfToken of [null, "invalid"] as const) {
    for (const accept of ["text/html", "application/json"] as const) {
      const harness = await createHarness({ csrfToken });
      const response = await harness.dispatch(
        getRequest(ALICE, accept),
        alice,
      );
      assert.equal(response.status, 503);
      assert.equal(response.headers.get(MUTATION_CSRF_HEADER), null);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      const body = await response.text();
      assert.doesNotMatch(body, /private-account@provider|registration_csrf/u);
      assert.match(body, /temporarily unavailable/u);
    }
  }

  const actorBoundHarness = await createHarness();
  const actorMismatch = await actorBoundHarness.dispatch(
    getRequest(BOB, "application/json"),
    alice,
  );
  assert.equal(actorMismatch.status, 503);
  assert.equal(actorMismatch.headers.get(MUTATION_CSRF_HEADER), null);
  assert.doesNotMatch(
    await actorMismatch.text(),
    /private-account@provider|participant:alice|participant:bob/u,
  );
});

test("operation IDs and CSRF proofs are issued only for unregistered discovery", async () => {
  const harness = await createHarness();
  const alice = participant(ALICE, "alice@provider.example");
  assert.equal(harness.operationIdCalls(), 0);
  assert.equal(harness.csrfCalls(), 0);

  const discoveryResponse = await harness.dispatch(
    getRequest(ALICE, "application/json"),
    alice,
  );
  assert.equal(discoveryResponse.status, 200);
  assert.equal(discoveryResponse.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  const discovery = await jsonDocument(discoveryResponse);
  const operationId = String(fieldsOf(actionsOf(discovery)[0])[0]?.value);
  assert.equal(operationId, registrationOperationId("form-1"));
  assert.equal(harness.operationIdCalls(), 1);
  assert.equal(harness.csrfCalls(), 1);

  const postResponse = await harness.dispatch(
    jsonMutation(
      ALICE,
      registrationBody(operationId),
    ),
    alice,
  );
  assert.equal(postResponse.status, 201);
  assert.equal(postResponse.headers.get(MUTATION_CSRF_HEADER), null);
  assert.deepEqual(actionsOf(await jsonDocument(postResponse)), []);
  assert.equal(harness.operationIdCalls(), 1);
  assert.equal(harness.csrfCalls(), 1);

  const registeredGet = await harness.dispatch(
    getRequest(ALICE, "application/json"),
    alice,
  );
  assert.equal(registeredGet.status, 200);
  assert.equal(registeredGet.headers.get(MUTATION_CSRF_HEADER), null);
  const registered = await jsonDocument(registeredGet);
  assert.deepEqual(actionsOf(registered), []);
  assert.equal(resourceData(registered).status, "registered");
  assert.equal(harness.operationIdCalls(), 1);
  assert.equal(harness.csrfCalls(), 1);
});

test("hosted proof discovery emits only the server cookie transport", async () => {
  const proof = Object.freeze({
    token: CSRF_TOKEN,
    expiresAt: timestamp("2026-08-09T12:05:00.000Z"),
    setCookie: ISSUED_COOKIE,
  }) satisfies BrowserMutationProof;
  const harness = await createHarness({ csrfToken: proof });
  const alice = participant(ALICE, "alice@provider.example");

  const jsonResponse = await harness.dispatch(
    getRequest(ALICE, "application/json"),
    alice,
  );
  assert.equal(jsonResponse.status, 200);
  assert.equal(jsonResponse.headers.get("set-cookie"), ISSUED_COOKIE);
  assert.equal(jsonResponse.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  const jsonBody = await jsonResponse.text();
  assert.doesNotMatch(jsonBody, new RegExp(CSRF_TOKEN, "u"));
  assert.doesNotMatch(jsonBody, /set-cookie|encrypted|HttpOnly/iu);

  const htmlResponse = await harness.dispatch(
    getRequest(ALICE, "text/html"),
    alice,
  );
  assert.equal(htmlResponse.status, 200);
  assert.equal(htmlResponse.headers.get("set-cookie"), ISSUED_COOKIE);
  const html = await htmlResponse.text();
  assert.equal(hiddenCsrfToken(html), CSRF_TOKEN);
  assert.doesNotMatch(html, /set-cookie|encrypted|HttpOnly/iu);

  const malformed = await createHarness({
    csrfToken: Object.freeze({ ...proof, setCookie: "bad\r\ncookie" }),
  });
  const failure = await malformed.dispatch(
    getRequest(ALICE, "application/json"),
    alice,
  );
  assert.equal(failure.status, 503);
  assert.equal(failure.headers.get("set-cookie"), null);
  assert.doesNotMatch(await failure.text(), /bad|cookie|registration_csrf/iu);
});

test("verified hosted mutations clear their proof cookie exactly once on success and later failures", async () => {
  const alice = participant(ALICE, "alice@provider.example");
  const success = await createHarness({
    verifyMutation: verifierFor(
      registrationBody("participant-operation:hosted-success"),
      CLEAR_COOKIE,
    ),
  });
  const successResponse = await success.dispatch(
    postRequest(ALICE),
    alice,
  );
  assert.equal(successResponse.status, 201);
  assertSingleCookie(successResponse, CLEAR_COOKIE);
  assert.doesNotMatch(await successResponse.text(), /set-cookie|Max-Age=0/iu);

  const parserFailure = await createHarness({
    verifyMutation: verifierFor(
      registrationBody("participant-operation:hosted-parser", {
        unexpected: "private parser value",
      }),
      CLEAR_COOKIE,
    ),
  });
  const parserResponse = await parserFailure.dispatch(postRequest(ALICE), alice);
  assert.equal(parserResponse.status, 400);
  assertSingleCookie(parserResponse, CLEAR_COOKIE);
  assert.doesNotMatch(await parserResponse.text(), /private parser value|Max-Age=0/iu);

  const repositoryFailure = await createHarness({
    verifyMutation: verifierFor(
      registrationBody("participant-operation:hosted-repository"),
      CLEAR_COOKIE,
    ),
    repositoryFor() {
      throw new Error("private repository failure");
    },
  });
  const repositoryResponse = await repositoryFailure.dispatch(
    postRequest(ALICE),
    alice,
  );
  assert.equal(repositoryResponse.status, 503);
  assertSingleCookie(repositoryResponse, CLEAR_COOKIE);
  assert.doesNotMatch(
    await repositoryResponse.text(),
    /private repository failure|Max-Age=0/iu,
  );

  const renderingFailure = await createHarness({
    verifyMutation: verifierFor(
      registrationBody("participant-operation:hosted-render"),
      CLEAR_COOKIE,
    ),
    repositoryFor: renderingFailureRepository,
  });
  const renderingResponse = await renderingFailure.dispatch(
    postRequest(ALICE),
    alice,
  );
  assert.equal(renderingResponse.status, 503);
  assertSingleCookie(renderingResponse, CLEAR_COOKIE);
  assert.doesNotMatch(
    await renderingResponse.text(),
    /private rendering failure|Max-Age=0/iu,
  );
});

test("pre-verification failures do not clear a hosted proof cookie", async () => {
  const harness = await createHarness({
    async verifyMutation() {
      throw new MutationSecurityFailure("REQUEST_REJECTED");
    },
  });
  const alice = participant(ALICE, "alice@provider.example");
  const response = await harness.dispatch(postRequest(ALICE), alice);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("hosted verification requires one valid cookie-clearing instruction", async () => {
  const alice = participant(ALICE, "alice@provider.example");
  for (const [name, clearCookie] of [
    ["missing", undefined],
    ["malformed", "bad\r\nclear-cookie"],
  ] as const) {
    let repositoryCalls = 0;
    const verified = await verifierFor(
      registrationBody(`participant-operation:hosted-clear-${name}`),
      CLEAR_COOKIE,
    )(postRequest(ALICE), () => true);
    const harness = await createHarness({
      verifyMutation: (async () => {
        if (clearCookie === undefined) {
          return {
            actor: verified.actor,
            method: verified.method,
            mediaType: verified.mediaType,
            body: verified.body,
          } as never;
        }
        return { ...verified, clearCookie } as never;
      }) as ParticipantRegistrationMutationVerifier,
      repositoryFor(account) {
        repositoryCalls += 1;
        return new DevelopmentInMemoryParticipantRepository(
          new MemoryStorageAdapter(),
          account,
        );
      },
    });

    const response = await harness.dispatch(postRequest(ALICE), alice);
    assert.equal(response.status, 503, name);
    assert.equal(response.headers.get("set-cookie"), null, name);
    assert.equal(repositoryCalls, 0, name);
  }
});

test("malformed registration operation IDs are rejected before hosted replay claims", async () => {
  const alice = participant(ALICE, "alice@provider.example");
  const identity = Object.freeze({
    type: "participant",
    subject: ALICE,
  }) satisfies TrustedSitesMutationIdentity;
  const claims: BrowserMutationReplayClaim[] = [];
  const session = createBrowserMutationSession({
    appOrigin: APP_ORIGIN,
    encryptionKey: await aesKey(37),
    async claimReplay(claim) {
      claims.push(claim);
      return true;
    },
    now: () => new Date("2026-08-09T09:00:00.000Z"),
    randomBytes: (length) => Uint8Array.from(
      { length },
      (_, index) => (index + 31) % 256,
    ),
    ttlSeconds: 300,
  });
  const proof = await session.issue(
    getRequest(ALICE, "text/html"),
    identity,
    APP_ORIGIN,
  );
  let repositoryCalls = 0;
  const storage = new MemoryStorageAdapter(new MemoryStorageState());
  const route = createParticipantRegistrationRouteHandler({
    repositoryFor(account) {
      repositoryCalls += 1;
      return new DevelopmentInMemoryParticipantRepository(storage, account);
    },
    verifyMutation: (request, validateBeforeReplayClaim) =>
      session.verifyMutation(request, identity, APP_ORIGIN, {
        maxBodyBytes: MAX_REGISTRATION_MUTATION_BYTES,
        maxFields: MAX_REGISTRATION_MUTATION_FIELDS,
        repeatedFormFields: [],
        validateBeforeReplayClaim,
      }),
    csrfTokenFor: async () => proof,
    noticeEvidence: NOTICE_EVIDENCE,
  });

  const privateText = "alice@example.test private registration retry";
  const jsonFailure = await route(routeContext(
    hostedJsonMutation(
      proof,
      registrationBody("ignored", { "operation-id": privateText }),
    ),
    alice,
  ));
  assert(jsonFailure);
  assert.equal(jsonFailure.status, 400);
  assert.doesNotMatch(await jsonFailure.text(), /alice@example|private|retry/iu);

  const formFailure = await route(routeContext(hostedFormMutation(proof, [
    ["operation-id", "participant-operation:not-a-uuid"],
    ["notice-evidence-version", NOTICE_EVIDENCE.version],
    ["display-name", "Alice Example"],
    ["country", "FI"],
    ["declared-interest", "investor"],
    ["participation-context", "individual"],
    ["process-email-notice-acknowledged", "on"],
  ]), alice));
  assert(formFailure);
  assert.equal(formFailure.status, 400);
  assert.doesNotMatch(await formFailure.text(), /not-a-uuid|alice@example/iu);
  assert.deepEqual(claims, []);
  assert.equal(repositoryCalls, 0);

  const valid = await route(routeContext(
    hostedJsonMutation(
      proof,
      registrationBody("valid-after-malformed-operation-ids"),
    ),
    alice,
  ));
  assert(valid);
  assert.equal(valid.status, 201);
  assert.equal(claims.length, 1);
  assert.equal(repositoryCalls, 1);
});

test("hosted registration limits reject bodies, field counts, and repeats before replay or persistence", async () => {
  assert.equal(MAX_REGISTRATION_MUTATION_BYTES, 2_048);
  assert.equal(MAX_REGISTRATION_MUTATION_FIELDS, 9);
  const maximumValidForm = new URLSearchParams({
    [MUTATION_CSRF_FIELD]: "x".repeat(65),
    "operation-id": registrationOperationId("maximum-valid-form"),
    "notice-evidence-version": NOTICE_EVIDENCE.version,
    "display-name": "\u{1F600}".repeat(120),
    country: "FI",
    "declared-interest": "investor",
    "participation-context": "individual",
    "process-email-notice-acknowledged": "on",
    "marketing-consent": "on",
  });
  assert.equal([...maximumValidForm].length, MAX_REGISTRATION_MUTATION_FIELDS);
  assert(
    new TextEncoder().encode(maximumValidForm.toString()).byteLength <=
      MAX_REGISTRATION_MUTATION_BYTES,
  );
  const alice = participant(ALICE, "alice@provider.example");
  const identity = Object.freeze({
    type: "participant",
    subject: ALICE,
  }) satisfies TrustedSitesMutationIdentity;
  const claims: BrowserMutationReplayClaim[] = [];
  const session = createBrowserMutationSession({
    appOrigin: APP_ORIGIN,
    encryptionKey: await aesKey(29),
    async claimReplay(claim) {
      claims.push(claim);
      return true;
    },
    now: () => new Date("2026-08-09T09:00:00.000Z"),
    randomBytes: (length) => Uint8Array.from(
      { length },
      (_, index) => (index + 17) % 256,
    ),
    ttlSeconds: 300,
  });
  const proof = await session.issue(
    getRequest(ALICE, "text/html"),
    identity,
    APP_ORIGIN,
  );
  let repositoryCalls = 0;
  const storage = new MemoryStorageAdapter(new MemoryStorageState());
  const route = createParticipantRegistrationRouteHandler({
    repositoryFor(account) {
      repositoryCalls += 1;
      return new DevelopmentInMemoryParticipantRepository(storage, account);
    },
    verifyMutation: (request, validateBeforeReplayClaim) => session.verifyMutation(
      request,
      identity,
      APP_ORIGIN,
      {
        maxBodyBytes: MAX_REGISTRATION_MUTATION_BYTES,
        maxFields: MAX_REGISTRATION_MUTATION_FIELDS,
        repeatedFormFields: [],
        validateBeforeReplayClaim,
      },
    ),
    csrfTokenFor: async () => proof,
    noticeEvidence: NOTICE_EVIDENCE,
  });

  const oversized = hostedJsonMutation(proof, registrationBody(
    "participant-operation:hosted-oversized",
    { "display-name": "x".repeat(MAX_REGISTRATION_MUTATION_BYTES) },
  ));
  const oversizedResponse = await route(routeContext(oversized, alice));
  assert(oversizedResponse);
  assert.equal(oversizedResponse.status, 413);

  const excessFields = hostedJsonMutation(proof, registrationBody(
    "participant-operation:hosted-fields",
    { one: "1", two: "2", three: "3" },
  ));
  const fieldsResponse = await route(routeContext(excessFields, alice));
  assert(fieldsResponse);
  assert.equal(fieldsResponse.status, 400);

  const repeated = hostedFormMutation(proof, [
    ["operation-id", registrationOperationId("hosted-repeat")],
    ["notice-evidence-version", NOTICE_EVIDENCE.version],
    ["display-name", "Alice"],
    ["display-name", "Alice again"],
    ["country", "FI"],
    ["declared-interest", "investor"],
    ["participation-context", "individual"],
    ["process-email-notice-acknowledged", "on"],
  ]);
  const repeatedResponse = await route(routeContext(repeated, alice));
  assert(repeatedResponse);
  assert.equal(repeatedResponse.status, 400);

  assert.equal(repositoryCalls, 0);
  assert.deepEqual(claims, []);
});

type TestActor = Readonly<{
  subject: ActorSubject;
  email: string;
  owner: boolean;
}>;

type TestHarness = Readonly<{
  dispatch(request: Request, actor: TestActor | null): Promise<Response>;
  profile(actor: TestActor): Promise<ParticipantProfileSnapshot | null>;
  csrfCalls(): number;
  nowCalls(): number;
  operationIdCalls(): number;
}>;

async function createHarness(
  options: Readonly<{
    csrfToken?: string | BrowserMutationProof | null;
    verifyMutation?: ParticipantRegistrationMutationVerifier;
    repositoryFor?: (
      account: ParticipantAccount,
    ) => ParticipantRegistrationRepository;
    state?: MemoryStorageState;
    noticeEvidence?: typeof NOTICE_EVIDENCE;
  }> = {},
): Promise<TestHarness> {
  const state = options.state ?? new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const csrfHash = await hashCsrfToken(CSRF_TOKEN);
  const issuedCsrfToken = Object.hasOwn(options, "csrfToken")
    ? options.csrfToken ?? null
    : CSRF_TOKEN;
  let csrfCalls = 0;
  let timeCalls = 0;
  let operationSequence = 0;
  const repositoryFor = options.repositoryFor ?? ((account: ParticipantAccount) =>
    new DevelopmentInMemoryParticipantRepository(storage, account));
  const registrationRoute = createParticipantRegistrationRouteHandler({
    repositoryFor,
    noticeEvidence: options.noticeEvidence ?? NOTICE_EVIDENCE,
    ...(options.verifyMutation === undefined
      ? {
          mutationSecurity: {
            allowedOrigins: [APP_ORIGIN, SECOND_ALLOWED_ORIGIN],
            resolveSession: async (request: Request) => {
              const value = request.headers.get("x-test-auth-subject");
              if (!value) return null;
              return session(
                subject(value),
                csrfHash,
                request.headers.get("x-test-session-type") === "owner"
                  ? "owner"
                  : "participant",
              );
            },
            now: () => new Date("2026-08-09T09:00:00.000Z"),
          },
        }
      : { verifyMutation: options.verifyMutation }),
    csrfTokenFor: (request, account) => {
      csrfCalls += 1;
      return request.headers.get("x-test-auth-subject") === account.subject
        ? issuedCsrfToken
        : null;
    },
    now: () => {
      const value = new Date(
        Date.parse("2026-08-09T10:00:00.000Z") + timeCalls * 60_000,
      );
      timeCalls += 1;
      return value;
    },
    createOperationId: () => {
      operationSequence += 1;
      return registrationOperationId(`form-${operationSequence}`);
    },
  });
  const route = createParticipantRouteHandler([registrationRoute]);

  return Object.freeze({
    async dispatch(request, actor) {
      const response = await route(routeContext(request, actor));
      assert(response);
      return response;
    },
    async profile(actor) {
      const account = participantAccount(actor);
      return repositoryFor(account).current();
    },
    csrfCalls: () => csrfCalls,
    nowCalls: () => timeCalls,
    operationIdCalls: () => operationSequence,
  });
}

function routeContext(
  request: Request,
  actor: TestActor | null,
): ApplicationRouteContext {
  return {
    request,
    url: new URL(request.url),
    resourceUrl: request.url,
    actor: actor
      ? {
          userId: actor.subject,
          email: actor.email,
          displayName: actor.email,
        }
      : null,
    isOwner: actor?.owner ?? false,
    participantAccess: null,
    campaign: syntheticPublicCampaign,
    renderApplication: async () => {
      throw new Error("The registration route owns this resource.");
    },
  };
}

function getRequest(
  actorSubject: ActorSubject | null,
  accept: string,
): Request {
  return new Request(`${APP_ORIGIN}${PARTICIPANT_REGISTRATION_PATH}`, {
    headers: {
      accept,
      ...(actorSubject ? { "x-test-auth-subject": actorSubject } : {}),
    },
  });
}

function jsonMutation(
  actorSubject: ActorSubject,
  body: Readonly<Record<string, unknown>>,
  overrides: Readonly<{
    origin?: string;
    csrf?: string;
    sessionType?: "participant" | "owner";
  }> = {},
): Request {
  return new Request(`${APP_ORIGIN}${PARTICIPANT_REGISTRATION_PATH}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: overrides.origin ?? APP_ORIGIN,
      "x-test-auth-subject": actorSubject,
      ...(overrides.sessionType
        ? { "x-test-session-type": overrides.sessionType }
        : {}),
      [MUTATION_CSRF_HEADER]: overrides.csrf ?? CSRF_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

function formMutation(
  actorSubject: ActorSubject,
  entries: readonly (readonly [string, string])[],
): Request {
  const body = new URLSearchParams();
  for (const [name, value] of entries) body.append(name, value);
  return new Request(`${APP_ORIGIN}${PARTICIPANT_REGISTRATION_PATH}`, {
    method: "POST",
    headers: {
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
      origin: APP_ORIGIN,
      "x-test-auth-subject": actorSubject,
    },
    body,
  });
}

function postRequest(actorSubject: ActorSubject): Request {
  return new Request(`${APP_ORIGIN}${PARTICIPANT_REGISTRATION_PATH}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "x-test-auth-subject": actorSubject,
    },
    body: "{}",
  });
}

function hostedJsonMutation(
  proof: BrowserMutationProof,
  body: Readonly<Record<string, unknown>>,
): Request {
  return new Request(`${APP_ORIGIN}${PARTICIPANT_REGISTRATION_PATH}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      cookie: proofCookieHeader(proof),
      origin: APP_ORIGIN,
      [MUTATION_CSRF_HEADER]: proof.token,
    },
    body: JSON.stringify(body),
  });
}

function hostedFormMutation(
  proof: BrowserMutationProof,
  entries: readonly (readonly [string, string])[],
): Request {
  const body = new URLSearchParams();
  body.append(MUTATION_CSRF_FIELD, proof.token);
  for (const [name, value] of entries) body.append(name, value);
  return new Request(`${APP_ORIGIN}${PARTICIPANT_REGISTRATION_PATH}`, {
    method: "POST",
    headers: {
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
      cookie: proofCookieHeader(proof),
      origin: APP_ORIGIN,
    },
    body,
  });
}

function proofCookieHeader(proof: BrowserMutationProof): string {
  const value = proof.setCookie.split(";", 1)[0];
  assert(value);
  return value;
}

function verifierFor(
  body: Readonly<Record<string, unknown>>,
  clearCookie: string,
): ParticipantRegistrationMutationVerifier {
  return async () => Object.freeze({
    actor: Object.freeze({ type: "participant" as const, subject: ALICE }),
    method: "POST" as const,
    mediaType: "application/json" as const,
    body: Object.freeze({ ...body }),
    clearCookie,
  });
}

function renderingFailureRepository(
  account: ParticipantAccount,
): ParticipantRegistrationRepository {
  const snapshot = Object.freeze({
    subject: account.subject,
    accountEmailLabel: account.accountEmailLabel,
    get displayName(): never {
      throw new Error("private rendering failure");
    },
    country: "FI",
    declaredInterest: "investor",
    participationContext: "individual",
    registrationNoticeEvidence: NOTICE_EVIDENCE,
    processEmailNoticeAcknowledgedAt:
      timestamp("2026-08-09T10:00:00.000Z"),
    marketingConsent: Object.freeze({ state: "not-granted" }),
    accountDeletionRequest: Object.freeze({ state: "not-requested" }),
    registeredAt: timestamp("2026-08-09T10:00:00.000Z"),
    updatedAt: timestamp("2026-08-09T10:00:00.000Z"),
  });
  return {
    async current() {
      return null;
    },
    async revision() {
      return null;
    },
    async register() {
      return {
        revision: 1,
        snapshot,
        replayed: false,
        intents: [],
      } as never;
    },
    async recoverRegistration() {
      throw new Error("unused");
    },
    async update() {
      throw new Error("unused");
    },
    async withdrawMarketingConsent() {
      throw new Error("unused");
    },
    async requestAccountDeletion() {
      throw new Error("unused");
    },
    async pendingDeletionIntent() {
      return null;
    },
  };
}

function assertSingleCookie(response: Response, expected: string): void {
  const value = response.headers.get("set-cookie");
  assert.equal(value, expected);
  assert.equal(value?.split(expected).length, 2);
}

async function aesKey(seed: number): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

function registrationBody(
  operationId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    "operation-id": registrationOperationId(operationId),
    "notice-evidence-version": NOTICE_EVIDENCE.version,
    "display-name": "  Alice Example  ",
    country: "fi",
    "declared-interest": "both",
    "participation-context": "individual",
    "process-email-notice-acknowledged": true,
    ...overrides,
  };
}

function registrationOperationId(label: string): string {
  const existing = parseParticipantRegistrationOperationId(label);
  if (existing !== null) return existing;

  const digest = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed) => registrationLabelHash(label, seed))
    .join("")
    .split("");
  digest[12] = "4";
  digest[16] = "8";
  const hexadecimal = digest.join("");
  return `participant-operation:${hexadecimal.slice(0, 8)}-${
    hexadecimal.slice(8, 12)
  }-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${
    hexadecimal.slice(20, 32)
  }`;
}

function registrationLabelHash(label: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < label.length; index += 1) {
    hash = Math.imul(hash ^ label.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function withoutField(
  input: Readonly<Record<string, unknown>>,
  field: string,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(input).filter(([name]) => name !== field),
  );
}

function participant(
  actorSubject: ActorSubject,
  email: string,
  owner = false,
): TestActor {
  return Object.freeze({ subject: actorSubject, email, owner });
}

function participantAccount(actor: TestActor): ParticipantAccount {
  const parsed = parseParticipantAccount({
    subject: actor.subject,
    accountEmailLabel: actor.email,
  });
  assert(parsed.ok);
  return parsed.value;
}

function session(
  actorSubject: ActorSubject,
  csrfHash: Awaited<ReturnType<typeof hashCsrfToken>>,
  type: "participant" | "owner",
): TrustedMutationSession {
  return Object.freeze({
    actor: Object.freeze({ type, subject: actorSubject }),
    expiresAt: timestamp("2026-08-09T13:00:00.000Z"),
    csrf: Object.freeze({
      tokenHash: csrfHash,
      expiresAt: timestamp("2026-08-09T12:30:00.000Z"),
    }),
  });
}

async function jsonDocument(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  return dataOf(value);
}

function dataOf(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function resourceData(document: Record<string, unknown>): Record<string, unknown> {
  return dataOf(document.data);
}

function actionsOf(document: Record<string, unknown>): Record<string, unknown>[] {
  assert(Array.isArray(document.actions));
  return document.actions.map(dataOf);
}

function linksOf(document: Record<string, unknown>): Record<string, unknown>[] {
  assert(Array.isArray(document.links));
  return document.links.map(dataOf);
}

function fieldsOf(action: unknown): Record<string, unknown>[] {
  const fields = dataOf(action).fields;
  assert(Array.isArray(fields));
  return fields.map(dataOf);
}

function assertActionFormParity(
  document: Record<string, unknown>,
  html: string,
): void {
  const actions = actionsOf(document);
  const forms = [...html.matchAll(
    /<form action="([^"]+)" data-action-name="([^"]+)"[\s\S]*?<\/form>/gu,
  )].map((match) => ({
    action: match[1] ?? "",
    name: match[2] ?? "",
    fields: [...(match[0] ?? "").matchAll(
      /<(?:input|select|textarea)\b[^>]*\bname="([^"]+)"/gu,
    )].map((field) => field[1] ?? ""),
  }));
  assert.deepEqual(
    forms.map((form) => form.name),
    actions.map((action) => action.name),
  );
  for (const action of actions) {
    const form = forms.find((candidate) => candidate.name === action.name);
    assert(form);
    assert.equal(form.action, action.href);
    assert.deepEqual(
      form.fields.filter((name) => name !== MUTATION_CSRF_FIELD),
      fieldsOf(action).map((field) => String(field.name)),
    );
  }
}

function hiddenCsrfToken(html: string): string {
  return hiddenInputValue(html, MUTATION_CSRF_FIELD);
}

function hiddenInputValue(html: string, name: string): string {
  const match = new RegExp(
    `<input name="${name}" type="hidden" value="([^"]+)">`,
    "u",
  ).exec(html);
  assert(match?.[1]);
  return match[1];
}

function subject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  assert(parsed.ok);
  return parsed.value;
}

function timestamp(value: string): Timestamp {
  const parsed = parseTimestamp(value);
  assert(parsed.ok);
  return parsed.value;
}
