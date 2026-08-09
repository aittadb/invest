import assert from "node:assert/strict";
import test from "node:test";

import {
  parseContributionAreaChoices,
  type ContributionAreaChoice,
  type FounderApplicationId,
} from "../domain/founder-application.ts";
import {
  parseActorSubject,
  parseStableId,
  parseTimestamp,
  type ActorSubject,
  type Timestamp,
} from "../domain/foundation.ts";
import {
  FOUNDER_INTEREST_PATH,
  FOUNDER_SECONDARY_AREAS_FIELD,
} from "../domain/participant-founder-interest-resource.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  MUTATION_METHOD_FIELD,
  hashCsrfToken,
  type TrustedMutationSession,
} from "../http/mutation-security.ts";
import type { ApplicationRouteContext } from "../worker/contracts.ts";
import { createParticipantFounderInterestService } from "../worker/founder-interest-service.ts";
import { createFounderInterestRouteHandler } from "../worker/routes/founder-interest.ts";
import { createParticipantRouteHandler } from "../worker/routes/participant.ts";
import { syntheticPublicCampaign } from "./fixtures/public-campaign.ts";
import {
  FounderApplicationRepositoryFixture,
  FounderApplicationRepositoryFixtureState,
} from "./support/founder-application-repository-fixture.ts";

const APP_ORIGIN = "https://campaign.example";
const CSRF_TOKEN = "founder_csrf_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALICE = subject("issuer.invalid/participant:alice");
const BOB = subject("issuer.invalid/participant:bob");
const CHARLIE = subject("issuer.invalid/participant:charlie");
const APPLICATION_ID = applicationId("founder-application:self");
const CHOICES = contributionChoices([
  { id: "area:engineering", label: "Engineering" },
  { id: "area:product", label: "Product" },
  { id: "area:operations", label: "Operations" },
]);

test("participant founder route completes lifecycle, retry, stale-write, and history behavior independently", async () => {
  const harness = await createHarness();
  const investmentState = Object.freeze({
    revision: 7,
    records: Object.freeze(["investment-indication:unchanged"]),
  });

  const createBody = founderBody("founder-operation:route-create", {
    note: "Original private note.",
  });
  const createdResponse = await harness.dispatch(
    jsonMutation(ALICE, "POST", createBody),
    ALICE,
  );
  assert.equal(createdResponse.status, 201);
  const created = await jsonDocument(createdResponse);
  assert.equal(resourceData(created).status, "received");
  assert.equal(resourceData(created).revision, 1);
  assert.equal(historyOf(created).length, 1);
  assert.equal(
    dataOf(historyOf(created)[0]).fields &&
      dataOf(dataOf(historyOf(created)[0]).fields).note,
    "Original private note.",
  );

  const createReplay = await harness.dispatch(
    jsonMutation(ALICE, "POST", createBody),
    ALICE,
  );
  assert.equal(createReplay.status, 200);
  assert.equal(historyOf(await jsonDocument(createReplay)).length, 1);

  const changedRetry = await harness.dispatch(
    jsonMutation(
      ALICE,
      "POST",
      founderBody("founder-operation:route-create", {
        note: "Changed retry must not replace history.",
      }),
    ),
    ALICE,
  );
  assert.equal(changedRetry.status, 409);
  assert.equal(resourceData(await jsonDocument(changedRetry)).code, "conflict");

  const editBody = founderBody("founder-operation:route-edit", {
    "expected-revision": 1,
    "intended-contribution": "Lead product validation with the founding team.",
    note: "Updated private note.",
  });
  const editedResponse = await harness.dispatch(
    jsonMutation(ALICE, "PATCH", editBody),
    ALICE,
  );
  assert.equal(editedResponse.status, 200);
  const edited = await jsonDocument(editedResponse);
  assert.equal(resourceData(edited).revision, 2);
  assert.equal(historyOf(edited).length, 2);
  const firstHistoryFields = dataOf(dataOf(historyOf(edited)[0]).fields);
  const secondHistoryFields = dataOf(dataOf(historyOf(edited)[1]).fields);
  assert.equal(firstHistoryFields.note, "Original private note.");
  assert.equal(secondHistoryFields.note, "Updated private note.");
  assert.equal(
    firstHistoryFields.intended_contribution,
    "Contribute to product development and validation.",
  );

  const editReplay = await harness.dispatch(
    jsonMutation(ALICE, "PATCH", editBody),
    ALICE,
  );
  assert.equal(editReplay.status, 200);
  assert.equal(historyOf(await jsonDocument(editReplay)).length, 2);

  const stale = await harness.dispatch(
    jsonMutation(
      ALICE,
      "PATCH",
      founderBody("founder-operation:route-stale", {
        "expected-revision": 1,
        note: "Stale write.",
      }),
    ),
    ALICE,
  );
  assert.equal(stale.status, 412);
  assert.equal(resourceData(await jsonDocument(stale)).code, "precondition_failed");

  const withdrawBody = {
    "operation-id": "founder-operation:route-withdraw",
    "expected-revision": 2,
    "confirm-withdrawal": true,
  };
  const withdrawnResponse = await harness.dispatch(
    jsonMutation(ALICE, "DELETE", withdrawBody),
    ALICE,
  );
  assert.equal(withdrawnResponse.status, 200);
  const withdrawn = await jsonDocument(withdrawnResponse);
  assert.equal(resourceData(withdrawn).status, "withdrawn");
  assert.equal(resourceData(withdrawn).revision, 3);
  assert.equal(historyOf(withdrawn).length, 3);
  assert.deepEqual(
    historyOf(withdrawn).map((entry) => dataOf(entry).kind),
    ["created", "edited", "withdrawn"],
  );
  assert.equal(
    dataOf(dataOf(historyOf(withdrawn)[0]).fields).note,
    "Original private note.",
  );
  assert.deepEqual(actionsOf(withdrawn), []);

  const withdrawReplay = await harness.dispatch(
    jsonMutation(ALICE, "DELETE", withdrawBody),
    ALICE,
  );
  assert.equal(withdrawReplay.status, 200);
  assert.equal(historyOf(await jsonDocument(withdrawReplay)).length, 3);
  assert.deepEqual(investmentState, {
    revision: 7,
    records: ["investment-indication:unchanged"],
  });
});

test("founder resource keeps HTML forms and JSON actions in parity", async () => {
  const harness = await createHarness();
  const initialJson = await jsonDocument(
    await harness.dispatch(getRequest(ALICE, "application/json"), ALICE),
  );
  const initialHtmlResponse = await harness.dispatch(
    getRequest(ALICE, "text/html"),
    ALICE,
  );
  assert.equal(initialHtmlResponse.status, 200);
  assert.match(
    initialHtmlResponse.headers.get("content-type") ?? "",
    /^text\/html/u,
  );
  const initialHtml = await initialHtmlResponse.text();
  assertActionFormParity(initialJson, initialHtml);
  assert.match(initialHtml, /<h1 id="founder-title">Founder application<\/h1>/u);

  const formResponse = await harness.dispatch(
    formMutation(ALICE, [
      [MUTATION_CSRF_FIELD, CSRF_TOKEN],
      ["operation-id", "founder-operation:form-create"],
      ["expertise-summary", "Experience with systems and product delivery."],
      ["intended-contribution", "Support engineering and operating cadence."],
      ["primary-contribution-area-id", "area:engineering"],
      [FOUNDER_SECONDARY_AREAS_FIELD, "area:product"],
      [FOUNDER_SECONDARY_AREAS_FIELD, "area:operations"],
      ["approximate-availability", "Three days each week."],
      ["possible-start-timing", "After mutual confirmation."],
      ["compensation-expectation", "Open to discussion."],
      ["professional-profile-links", "https://profiles.invalid/alice"],
      ["note", "<script>alert('private')</script>"],
    ]),
    ALICE,
  );
  assert.equal(formResponse.status, 201);
  const createdHtml = await formResponse.text();
  assert.match(createdHtml, /Received/u);
  assert.doesNotMatch(createdHtml, /<script>alert/u);
  assert.match(createdHtml, /&lt;script&gt;alert/u);

  const receivedJson = await jsonDocument(
    await harness.dispatch(getRequest(ALICE, "application/json"), ALICE),
  );
  const receivedHtml = await (
    await harness.dispatch(getRequest(ALICE, "text/html"), ALICE)
  ).text();
  assert.deepEqual(
    actionsOf(receivedJson).map((action) => dataOf(action).name),
    ["edit-founder-application", "withdraw-founder-application"],
  );
  assertActionFormParity(receivedJson, receivedHtml);
  assert.match(
    receivedHtml,
    new RegExp(`name="${MUTATION_METHOD_FIELD}" type="hidden" value="PATCH"`, "u"),
  );
  assert.match(
    receivedHtml,
    new RegExp(`name="${MUTATION_METHOD_FIELD}" type="hidden" value="DELETE"`, "u"),
  );
  assert.match(
    receivedHtml,
    new RegExp(`name="${FOUNDER_SECONDARY_AREAS_FIELD}"[^>]* multiple`, "u"),
  );

  const editedFormResponse = await harness.dispatch(
    formMutation(ALICE, [
      [MUTATION_CSRF_FIELD, CSRF_TOKEN],
      [MUTATION_METHOD_FIELD, "PATCH"],
      ["operation-id", "founder-operation:form-edit"],
      ["expected-revision", "1"],
      ["expertise-summary", "Experience with systems and product delivery."],
      ["intended-contribution", "Lead engineering validation and delivery."],
      ["primary-contribution-area-id", "area:engineering"],
      [FOUNDER_SECONDARY_AREAS_FIELD, "area:product"],
      ["approximate-availability", "Four days each week."],
      ["possible-start-timing", "After mutual confirmation."],
      ["compensation-expectation", "Open to discussion."],
      ["professional-profile-links", "https://profiles.invalid/alice"],
      ["note", "Updated through the participant form."],
    ]),
    ALICE,
  );
  assert.equal(editedFormResponse.status, 200);
  assert.match(await editedFormResponse.text(), /Revision 2/u);

  const withdrawnFormResponse = await harness.dispatch(
    formMutation(ALICE, [
      [MUTATION_CSRF_FIELD, CSRF_TOKEN],
      [MUTATION_METHOD_FIELD, "DELETE"],
      ["operation-id", "founder-operation:form-withdraw"],
      ["expected-revision", "2"],
      ["confirm-withdrawal", "true"],
    ]),
    ALICE,
  );
  assert.equal(withdrawnFormResponse.status, 200);
  const withdrawnHtml = await withdrawnFormResponse.text();
  assert.match(withdrawnHtml, /Withdrawn/u);
  assert.doesNotMatch(withdrawnHtml, /<form /u);

  const withdrawnJson = await jsonDocument(
    await harness.dispatch(getRequest(ALICE, "application/json"), ALICE),
  );
  assert.equal(resourceData(withdrawnJson).revision, 3);
  assert.equal(historyOf(withdrawnJson).length, 3);
  assert.deepEqual(actionsOf(withdrawnJson), []);
});

test("founder route enforces negotiation, mutation security, and bounded validation", async () => {
  const harness = await createHarness();

  const unsupported = await harness.dispatch(
    getRequest(
      ALICE,
      "application/vnd.aittadb-invest+json; version=9.0",
    ),
    ALICE,
  );
  assert.equal(unsupported.status, 406);

  const crossOrigin = jsonMutation(
    ALICE,
    "POST",
    founderBody("founder-operation:cross-origin"),
    { origin: "https://attacker.example" },
  );
  const crossOriginResponse = await harness.dispatch(crossOrigin, ALICE);
  assert.equal(crossOriginResponse.status, 403);
  assert.doesNotMatch(await crossOriginResponse.text(), /attacker|expertise/u);

  const invalidArea = await harness.dispatch(
    jsonMutation(
      BOB,
      "POST",
      founderBody("founder-operation:invalid-area", {
        "primary-contribution-area-id": "area:not-configured",
      }),
    ),
    BOB,
  );
  assert.equal(invalidArea.status, 400);

  const oversizedField = await harness.dispatch(
    jsonMutation(
      BOB,
      "POST",
      founderBody("founder-operation:oversized", {
        "expertise-summary": "x".repeat(4_001),
      }),
    ),
    BOB,
  );
  assert.equal(oversizedField.status, 400);

  const spoofedActor = await harness.dispatch(
    jsonMutation(
      CHARLIE,
      "POST",
      {
        ...founderBody("founder-operation:spoofed"),
        applicantSubject: ALICE,
      },
    ),
    CHARLIE,
  );
  assert.equal(spoofedActor.status, 400);
  const charlieState = await jsonDocument(
    await harness.dispatch(getRequest(CHARLIE, "application/json"), CHARLIE),
  );
  assert.equal(resourceData(charlieState).status, "not_submitted");
});

test("anonymous and foreign participants cannot discover or mutate another application", async () => {
  const harness = await createHarness();
  await harness.dispatch(
    jsonMutation(
      ALICE,
      "POST",
      founderBody("founder-operation:alice-private", {
        note: "Alice only private founder note.",
      }),
    ),
    ALICE,
  );

  const anonymous = await harness.dispatch(getRequest(null, "application/json"), null);
  assert.equal(anonymous.status, 401);
  assert.doesNotMatch(await anonymous.text(), /Alice only|participant:alice/u);

  const foreign = await jsonDocument(
    await harness.dispatch(getRequest(BOB, "application/json"), BOB),
  );
  assert.equal(resourceData(foreign).status, "not_submitted");
  assert.doesNotMatch(JSON.stringify(foreign), /Alice only|participant:alice/u);

  const anonymousMutation = await harness.dispatch(
    jsonMutation(null, "PATCH", {
      ...founderBody("founder-operation:anonymous-edit"),
      "expected-revision": 1,
    }),
    null,
  );
  assert.equal(anonymousMutation.status, 401);

  const missingEdit = {
    ...founderBody("founder-operation:foreign-edit"),
    "expected-revision": 1,
  };
  const bobFailure = await harness.dispatch(
    jsonMutation(BOB, "PATCH", missingEdit),
    BOB,
  );
  const charlieFailure = await harness.dispatch(
    jsonMutation(CHARLIE, "PATCH", missingEdit),
    CHARLIE,
  );
  assert.equal(bobFailure.status, 404);
  assert.equal(charlieFailure.status, 404);
  assert.deepEqual(await bobFailure.json(), await charlieFailure.json());
});

type TestHarness = Readonly<{
  state: FounderApplicationRepositoryFixtureState;
  dispatch(request: Request, actor: ActorSubject | null): Promise<Response>;
}>;

async function createHarness(): Promise<TestHarness> {
  const state = new FounderApplicationRepositoryFixtureState();
  const csrfHash = await hashCsrfToken(CSRF_TOKEN);
  let clockMinute = 0;
  let actionSequence = 0;
  const founderInterestRoute = createFounderInterestRouteHandler({
    serviceFor: (actorSubject) =>
      createParticipantFounderInterestService({
        actorSubject,
        applicationId: APPLICATION_ID,
        contributionAreaChoices: CHOICES,
        repository: new FounderApplicationRepositoryFixture(
          state,
          actorSubject,
          CHOICES,
        ),
        canCreate: () => true,
        now: () => {
          const value = new Date(
            Date.parse("2026-08-09T10:00:00.000Z") + clockMinute * 60_000,
          );
          clockMinute += 1;
          return value;
        },
      }),
    mutationSecurity: {
      allowedOrigins: [APP_ORIGIN],
      resolveSession: async (request) => {
        const value = request.headers.get("x-test-auth-subject");
        if (!value) return null;
        const actorSubject = subject(value);
        return session(actorSubject, csrfHash);
      },
      now: () => new Date("2026-08-09T09:00:00.000Z"),
    },
    csrfTokenFor: (request, actorSubject) =>
      request.headers.get("x-test-auth-subject") === actorSubject
        ? CSRF_TOKEN
        : null,
    createOperationId: () => {
      actionSequence += 1;
      return `founder-form-operation:${actionSequence}`;
    },
  });
  const route = createParticipantRouteHandler([founderInterestRoute]);

  return Object.freeze({
    state,
    async dispatch(request, actor) {
      const response = await route(routeContext(request, actor));
      assert(response);
      return response;
    },
  });
}

function routeContext(
  request: Request,
  actor: ActorSubject | null,
): ApplicationRouteContext {
  return {
    request,
    url: new URL(request.url),
    resourceUrl: request.url,
    actor: actor
      ? {
          userId: actor,
          email: `${actor.split(":").at(-1) ?? "participant"}@example.test`,
          displayName: actor,
        }
      : null,
    isOwner: false,
    participantAccess: null,
    campaign: syntheticPublicCampaign,
    renderApplication: async () => {
      throw new Error("The founder route owns this resource.");
    },
  };
}

function getRequest(
  actor: ActorSubject | null,
  accept: string,
): Request {
  return new Request(`${APP_ORIGIN}${FOUNDER_INTEREST_PATH}`, {
    headers: {
      accept,
      ...(actor ? { "x-test-auth-subject": actor } : {}),
    },
  });
}

function jsonMutation(
  actor: ActorSubject | null,
  method: "POST" | "PATCH" | "DELETE",
  body: Readonly<Record<string, unknown>>,
  overrides: Readonly<{ origin?: string; csrf?: string }> = {},
): Request {
  return new Request(`${APP_ORIGIN}${FOUNDER_INTEREST_PATH}`, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: overrides.origin ?? APP_ORIGIN,
      [MUTATION_CSRF_HEADER]: overrides.csrf ?? CSRF_TOKEN,
      ...(actor ? { "x-test-auth-subject": actor } : {}),
    },
    body: JSON.stringify(body),
  });
}

function formMutation(
  actor: ActorSubject,
  entries: readonly (readonly [string, string])[],
): Request {
  const body = new URLSearchParams();
  for (const [name, value] of entries) body.append(name, value);
  return new Request(`${APP_ORIGIN}${FOUNDER_INTEREST_PATH}`, {
    method: "POST",
    headers: {
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
      origin: APP_ORIGIN,
      "x-test-auth-subject": actor,
    },
    body,
  });
}

function founderBody(
  operationId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    "operation-id": operationId,
    "expertise-summary": "Experience developing data systems.",
    "intended-contribution": "Contribute to product development and validation.",
    "primary-contribution-area-id": "area:engineering",
    [FOUNDER_SECONDARY_AREAS_FIELD]: ["area:product"],
    "approximate-availability": "Part-time during the initial phase.",
    "possible-start-timing": "After mutual confirmation.",
    "compensation-expectation": "Open to discussion.",
    "professional-profile-links": "https://profiles.invalid/alice",
    note: "Initial application note.",
    ...overrides,
  };
}

function session(
  actorSubject: ActorSubject,
  csrfHash: Awaited<ReturnType<typeof hashCsrfToken>>,
): TrustedMutationSession {
  return Object.freeze({
    actor: Object.freeze({ type: "participant", subject: actorSubject }),
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

function historyOf(document: Record<string, unknown>): Record<string, unknown>[] {
  const history = resourceData(document).history;
  assert(Array.isArray(history));
  return history.map(dataOf);
}

function resourceData(document: Record<string, unknown>): Record<string, unknown> {
  return dataOf(document.data);
}

function actionsOf(document: Record<string, unknown>): Record<string, unknown>[] {
  assert(Array.isArray(document.actions));
  return document.actions.map(dataOf);
}

function assertActionFormParity(
  document: Record<string, unknown>,
  html: string,
): void {
  const actions = actionsOf(document);
  const forms = extractForms(html);
  assert.deepEqual(
    forms.map((form) => form.name),
    actions.map((action) => action.name),
  );

  for (const action of actions) {
    const actionName = String(action.name);
    const form = forms.find((candidate) => candidate.name === actionName);
    assert(form);
    assert.equal(form.action, action.href);
    const actionFields = action.fields;
    assert(Array.isArray(actionFields));
    assert.deepEqual(
      form.fields.filter(
        (name) => name !== MUTATION_CSRF_FIELD && name !== MUTATION_METHOD_FIELD,
      ),
      actionFields.map((field) => String(dataOf(field).name)),
    );
  }
}

function extractForms(html: string): readonly Readonly<{
  name: string;
  action: string;
  fields: readonly string[];
}>[] {
  return [...html.matchAll(/<form action="([^"]+)" data-action-name="([^"]+)"[\s\S]*?<\/form>/gu)]
    .map((match) => ({
      action: match[1] ?? "",
      name: match[2] ?? "",
      fields: [...(match[0] ?? "").matchAll(/<(?:input|select|textarea)\b[^>]*\bname="([^"]+)"/gu)].map(
        (field) => field[1] ?? "",
      ),
    }));
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

function applicationId(value: string): FounderApplicationId {
  const parsed = parseStableId<"founder-application">(value);
  assert(parsed.ok);
  return parsed.value;
}

function contributionChoices(value: unknown): readonly ContributionAreaChoice[] {
  const parsed = parseContributionAreaChoices(value);
  assert(parsed.ok);
  return parsed.value;
}
