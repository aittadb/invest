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
  PARTICIPANT_REGISTRATION_PATH,
  ParticipantRegistrationResourceError,
  createParticipantRegistrationCapabilityModel,
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
  hashCsrfToken,
  type TrustedMutationSession,
} from "../http/mutation-security.ts";
import {
  DevelopmentInMemoryParticipantRepository,
  type ParticipantProfileSnapshot,
} from "../repositories/in-memory-participant-repository.ts";
import type { ApplicationRouteContext } from "../worker/contracts.ts";
import { createParticipantRouteHandler } from "../worker/routes/participant.ts";
import { createParticipantRegistrationRouteHandler } from "../worker/routes/participant-registration.ts";
import { syntheticPublicCampaign } from "./fixtures/public-campaign.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";

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
  assert.deepEqual(
    actionFields.map((field) => field.name),
    [
      "operation-id",
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
    notices: {
      processEmail: PROCESS_NOTICE,
      marketing: MARKETING_NOTICE,
    },
  } as const;
  for (const operationId of [null, "not a stable operation id"] as const) {
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
      ["operation-id", "participant-operation:bob-register"],
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
  assert.equal(operationId, "participant-form-operation:1");
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
  options: Readonly<{ csrfToken?: string | null }> = {},
): Promise<TestHarness> {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const csrfHash = await hashCsrfToken(CSRF_TOKEN);
  const issuedCsrfToken = Object.hasOwn(options, "csrfToken")
    ? options.csrfToken ?? null
    : CSRF_TOKEN;
  let csrfCalls = 0;
  let timeCalls = 0;
  let operationSequence = 0;
  const repositoryFor = (account: ParticipantAccount) =>
    new DevelopmentInMemoryParticipantRepository(storage, account);
  const registrationRoute = createParticipantRegistrationRouteHandler({
    repositoryFor,
    notices: {
      processEmail: PROCESS_NOTICE,
      marketing: MARKETING_NOTICE,
    },
    mutationSecurity: {
      allowedOrigins: [APP_ORIGIN, SECOND_ALLOWED_ORIGIN],
      resolveSession: async (request) => {
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
      maxBodyBytes: 1_024,
      maxFields: 16,
    },
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
      return `participant-form-operation:${operationSequence}`;
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

function registrationBody(
  operationId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    "operation-id": operationId,
    "display-name": "  Alice Example  ",
    country: "fi",
    "declared-interest": "both",
    "participation-context": "individual",
    "process-email-notice-acknowledged": true,
    ...overrides,
  };
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
  const match = new RegExp(
    `<input name="${MUTATION_CSRF_FIELD}" type="hidden" value="([^"]+)">`,
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
