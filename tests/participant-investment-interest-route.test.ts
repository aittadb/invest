import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAmountAggregateConfiguration,
  type AmountConfiguration,
} from "../domain/amount-aggregate-configuration.ts";
import {
  parseActorSubject,
  parseStableId,
  parseTimestamp,
  type ActorSubject,
} from "../domain/foundation.ts";
import type {
  InvestmentIndicationId,
  TrustedPackageAcknowledgmentContext,
} from "../domain/investment-indication.ts";
import {
  createPackageAcceptance,
  createPackageVersion,
  type PackageAcceptanceRecord,
  type PackageVersion,
} from "../domain/package-content.ts";
import {
  INVESTMENT_INTEREST_PATH,
  investmentInterestItemPath,
} from "../domain/participant-investment-interest-resource.ts";
import type { AuthorizedParticipantAccess } from "../domain/participant-home-resource.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  MUTATION_METHOD_FIELD,
  hashCsrfToken,
  type TrustedMutationSession,
} from "../http/mutation-security.ts";
import type { ApplicationRouteContext } from "../worker/contracts.ts";
import {
  createParticipantInvestmentInterestService,
  type InvestmentInterestPermissions,
} from "../worker/investment-interest-service.ts";
import { createInvestmentInterestRouteHandler } from "../worker/routes/investment-interest.ts";
import { syntheticPublicCampaign } from "./fixtures/public-campaign.ts";
import {
  InvestmentInterestRepositoryFixture,
  InvestmentInterestRepositoryFixtureState,
} from "./support/investment-interest-repository-fixture.ts";

const REQUEST_ORIGIN = "https://request.example";
const CANONICAL_ORIGIN = "https://canonical.example";
const CSRF_TOKEN = "investment_csrf_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALICE = subject("issuer.invalid/participant:alice-route-investment");
const BOB = subject("issuer.invalid/participant:bob-route-investment");
const AMOUNT = configuredAmount();
const ALLOW_ALL = Object.freeze({
  createPersonal: true,
  createCompany: true,
  reactivatePersonal: true,
  reactivateCompany: true,
}) satisfies InvestmentInterestPermissions;

test("participant investment route completes personal create, edit, withdraw, reactivate, and retry lifecycle", async () => {
  const harness = await createHarness();
  const initialResponse = await harness.dispatch(
    getRequest(INVESTMENT_INTEREST_PATH, ALICE),
    ALICE,
  );
  assert.equal(initialResponse.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  const initialText = await initialResponse.text();
  assert.doesNotMatch(initialText, new RegExp(CSRF_TOKEN, "u"));
  assert.doesNotMatch(initialText, new RegExp(MUTATION_CSRF_HEADER, "iu"));
  const initial = dataOf(JSON.parse(initialText));
  assert.deepEqual(actionNames(initial), [
    "create-personal-investment-interest",
    "create-company-investment-interest",
  ]);
  assert.equal(resourceData(initial).acknowledgment_current, true);

  const operationId = "investment-operation:route-personal-create";
  const createdResponse = await harness.dispatch(
    jsonMutation(
      INVESTMENT_INTEREST_PATH,
      ALICE,
      "POST",
      personalBody(operationId),
    ),
    ALICE,
  );
  assert.equal(createdResponse.status, 201);
  assert.equal(createdResponse.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  const createdText = await createdResponse.text();
  assert.doesNotMatch(createdText, new RegExp(CSRF_TOKEN, "u"));
  assert.doesNotMatch(createdText, new RegExp(MUTATION_CSRF_HEADER, "iu"));
  const created = dataOf(JSON.parse(createdText));
  assert.equal(created.id, operationId);
  assert.equal(resourceData(created).status, "active");
  assert.equal(resourceData(created).revision, 1);
  assert.equal(historyOf(created).length, 1);
  assert.equal(
    linkFor(created, "self"),
    `${CANONICAL_ORIGIN}${investmentInterestItemPath(operationId)}`,
  );
  assert.deepEqual(actionNames(created), [
    "edit-investment-interest",
    "withdraw-investment-interest",
  ]);

  const createReplay = await harness.dispatch(
    jsonMutation(
      INVESTMENT_INTEREST_PATH,
      ALICE,
      "POST",
      personalBody(operationId),
    ),
    ALICE,
  );
  assert.equal(createReplay.status, 200);
  assert.equal(historyOf(await jsonDocument(createReplay)).length, 1);

  const itemPath = investmentInterestItemPath(operationId);
  const editBody = personalBody("investment-operation:route-personal-edit", {
    "expected-revision": 1,
    amount: 1_500,
    note: "Updated participant note.",
  });
  const editedResponse = await harness.dispatch(
    jsonMutation(itemPath, ALICE, "PATCH", editBody),
    ALICE,
  );
  assert.equal(editedResponse.status, 200);
  assert.equal(editedResponse.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  const edited = await jsonDocument(editedResponse);
  assert.equal(resourceData(edited).revision, 2);
  assert.equal(historyOf(edited).length, 2);
  assert.equal(dataOf(dataOf(historyOf(edited)[0]).fields).note, "Initial note.");
  assert.equal(
    dataOf(dataOf(historyOf(edited)[1]).fields).note,
    "Updated participant note.",
  );

  const editReplay = await harness.dispatch(
    jsonMutation(itemPath, ALICE, "PATCH", editBody),
    ALICE,
  );
  assert.equal(editReplay.status, 200);
  assert.equal(historyOf(await jsonDocument(editReplay)).length, 2);

  const stale = await harness.dispatch(
    jsonMutation(
      itemPath,
      ALICE,
      "PATCH",
      personalBody("investment-operation:route-personal-stale", {
        "expected-revision": 1,
        note: "Stale private value.",
      }),
    ),
    ALICE,
  );
  assert.equal(stale.status, 412);
  assert.equal(
    resourceData(await jsonDocument(stale)).code,
    "precondition_failed",
  );

  const withdrawBody = {
    "operation-id": "investment-operation:route-personal-withdraw",
    "expected-revision": 2,
    "confirm-withdrawal": true,
  };
  const withdrawnResponse = await harness.dispatch(
    jsonMutation(itemPath, ALICE, "DELETE", withdrawBody),
    ALICE,
  );
  assert.equal(withdrawnResponse.status, 200);
  assert.equal(withdrawnResponse.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  const withdrawn = await jsonDocument(withdrawnResponse);
  assert.equal(resourceData(withdrawn).status, "withdrawn");
  assert.deepEqual(actionNames(withdrawn), ["reactivate-investment-interest"]);
  assert.deepEqual(
    historyOf(withdrawn).map((entry) => dataOf(entry).transition),
    ["created", "edited", "withdrawn"],
  );

  const withdrawReplay = await harness.dispatch(
    jsonMutation(itemPath, ALICE, "DELETE", withdrawBody),
    ALICE,
  );
  assert.equal(withdrawReplay.status, 200);
  assert.equal(historyOf(await jsonDocument(withdrawReplay)).length, 3);

  const reactivatedResponse = await harness.dispatch(
    jsonMutation(itemPath, ALICE, "POST", {
      "operation-id": "investment-operation:route-personal-reactivate",
      "expected-revision": 3,
      "confirm-reactivation": true,
    }),
    ALICE,
  );
  assert.equal(reactivatedResponse.status, 200);
  assert.equal(
    reactivatedResponse.headers.get(MUTATION_CSRF_HEADER),
    CSRF_TOKEN,
  );
  const reactivated = await jsonDocument(reactivatedResponse);
  assert.equal(resourceData(reactivated).status, "active");
  assert.equal(resourceData(reactivated).revision, 4);
  assert.deepEqual(
    historyOf(reactivated).map((entry) => dataOf(entry).transition),
    ["created", "edited", "withdrawn", "reactivated"],
  );
});

test("native company forms match hypermedia actions and duplicate failures disclose no owner", async () => {
  const harness = await createHarness();
  const collectionJson = await jsonDocument(
    await harness.dispatch(getRequest(INVESTMENT_INTEREST_PATH, ALICE), ALICE),
  );
  const collectionHtmlResponse = await harness.dispatch(
    getRequest(INVESTMENT_INTEREST_PATH, ALICE, "text/html"),
    ALICE,
  );
  assert.match(
    collectionHtmlResponse.headers.get("content-security-policy") ?? "",
    /form-action 'self'/u,
  );
  assert.equal(
    collectionHtmlResponse.headers.get("referrer-policy"),
    "no-referrer",
  );
  const collectionHtml = await collectionHtmlResponse.text();
  assertActionFormParity(collectionJson, collectionHtml);
  assert.match(collectionHtml, /<h1 id="investment-title">Your investment interest<\/h1>/u);
  assert.match(
    collectionHtml,
    new RegExp(
      `name="${MUTATION_CSRF_FIELD}" type="hidden" value="${CSRF_TOKEN}"`,
      "u",
    ),
  );
  assert.doesNotMatch(collectionHtml, /TASK-|implementation|features to build/iu);

  const companyOperation = "investment-operation:route-company-alice";
  const companyResponse = await harness.dispatch(
    formMutation(INVESTMENT_INTEREST_PATH, ALICE, [
      [MUTATION_CSRF_FIELD, CSRF_TOKEN],
      ["operation-id", companyOperation],
      ["kind", "company"],
      ["company-name", "Synthetic Alpha Ltd"],
      ["registration-country", "fi"],
      ["company-identifier", " FI-123 456 "],
      ["representative-name", "Alice Example"],
      ["representative-authority-declared", "true"],
      ["amount", "2000"],
      ["availability-period", "During the next twelve months."],
      ["note", "<script>private marker</script>"],
    ]),
    ALICE,
  );
  assert.equal(companyResponse.status, 201);
  const companyHtml = await companyResponse.text();
  assert.match(companyHtml, /Synthetic Alpha Ltd/u);
  assert.doesNotMatch(companyHtml, /<script>private marker/u);
  assert.match(companyHtml, /&lt;script&gt;private marker/u);

  const itemPath = investmentInterestItemPath(companyOperation);
  const itemJson = await jsonDocument(
    await harness.dispatch(getRequest(itemPath, ALICE), ALICE),
  );
  const itemHtml = await (
    await harness.dispatch(getRequest(itemPath, ALICE, "text/html"), ALICE)
  ).text();
  assertActionFormParity(itemJson, itemHtml);
  assert.match(
    itemHtml,
    new RegExp(`name="${MUTATION_METHOD_FIELD}" type="hidden" value="PATCH"`, "u"),
  );
  assert.match(
    itemHtml,
    new RegExp(`name="${MUTATION_METHOD_FIELD}" type="hidden" value="DELETE"`, "u"),
  );
  assert.equal(
    linkFor(itemJson, "self"),
    `${CANONICAL_ORIGIN}${itemPath}`,
  );
  assert.equal(dataOf(resourceData(itemJson).fields).company_identifier, "FI-123456");

  const duplicateName = "Bob should remain private";
  const duplicateIdentifier = " fi-123 456 ";
  const duplicate = await harness.dispatch(
    jsonMutation(
      INVESTMENT_INTEREST_PATH,
      BOB,
      "POST",
      companyBody("investment-operation:route-company-bob-duplicate", {
        "company-name": duplicateName,
        "company-identifier": duplicateIdentifier,
      }),
    ),
    BOB,
  );
  assert.equal(duplicate.status, 409);
  const duplicateText = await duplicate.text();
  assert.doesNotMatch(
    duplicateText,
    /Synthetic Alpha|Alice Example|FI-123456|Bob should remain private|fi-123 456/u,
  );

  const foreign = await harness.dispatch(getRequest(itemPath, BOB), BOB);
  const missing = await harness.dispatch(
    getRequest(
      investmentInterestItemPath("investment-operation:missing-private"),
      BOB,
    ),
    BOB,
  );
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  const foreignDocument = dataOf(await foreign.json());
  const missingDocument = dataOf(await missing.json());
  assert.deepEqual(resourceData(foreignDocument), resourceData(missingDocument));
  assert.deepEqual(actionNames(foreignDocument), actionNames(missingDocument));
  assert.doesNotMatch(
    JSON.stringify(foreignDocument),
    /Synthetic Alpha|Alice Example|FI-123456|private marker/u,
  );
});

test("participant authorization, current acknowledgment, and kind permissions gate capabilities", async () => {
  const harness = await createHarness();
  const signedOut = await harness.dispatch(
    getRequest(INVESTMENT_INTEREST_PATH, null),
    null,
  );
  assert.equal(signedOut.status, 401);
  assert.deepEqual(actionNames(await jsonDocument(signedOut)), ["sign-in"]);

  const founderOnly = await harness.dispatch(
    getRequest(INVESTMENT_INTEREST_PATH, ALICE),
    ALICE,
    { declaredInterest: "founder" },
  );
  assert.equal(founderOnly.status, 404);

  harness.permissions.set(ALICE, Object.freeze({
    ...ALLOW_ALL,
    createCompany: false,
  }));
  const personalOnly = await jsonDocument(
    await harness.dispatch(getRequest(INVESTMENT_INTEREST_PATH, ALICE), ALICE),
  );
  assert.deepEqual(actionNames(personalOnly), [
    "create-personal-investment-interest",
  ]);
  const disallowedCompany = await harness.dispatch(
    jsonMutation(
      INVESTMENT_INTEREST_PATH,
      ALICE,
      "POST",
      companyBody("investment-operation:permission-company"),
    ),
    ALICE,
  );
  assert.equal(disallowedCompany.status, 412);

  harness.permissions.set(ALICE, ALLOW_ALL);
  harness.contexts.set(ALICE, await staleContext(ALICE, "route-stale"));
  const staleResponse = await harness.dispatch(
    getRequest(INVESTMENT_INTEREST_PATH, ALICE),
    ALICE,
  );
  assert.equal(staleResponse.headers.get(MUTATION_CSRF_HEADER), null);
  const stale = await jsonDocument(staleResponse);
  assert.equal(resourceData(stale).acknowledgment_current, false);
  assert.deepEqual(actionNames(stale), []);
  const staleCreate = await harness.dispatch(
    jsonMutation(
      INVESTMENT_INTEREST_PATH,
      ALICE,
      "POST",
      personalBody("investment-operation:stale-create"),
    ),
    ALICE,
  );
  assert.equal(staleCreate.status, 412);
  assert.doesNotMatch(
    JSON.stringify(await staleCreate.json()),
    /content_hash|acceptance_hash|participant:alice/u,
  );
});

test("hypermedia mutation discovery fails closed without a valid CSRF proof", async () => {
  const invalidCsrf = "not-a-valid-proof";
  const harness = await createHarness({
    csrfTokenFor: () => invalidCsrf,
  });
  const response = await harness.dispatch(
    getRequest(INVESTMENT_INTEREST_PATH, ALICE),
    ALICE,
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get(MUTATION_CSRF_HEADER), null);
  const text = await response.text();
  assert.doesNotMatch(text, new RegExp(invalidCsrf, "u"));
  assert.doesNotMatch(text, new RegExp(CSRF_TOKEN, "u"));
  assert.deepEqual(actionNames(dataOf(JSON.parse(text))), []);
});

test("resources without mutations do not require operation ID issuance", async () => {
  const harness = await createHarness({
    createOperationId: () => {
      throw new Error("An unavailable action must not issue an operation ID.");
    },
  });
  harness.contexts.set(ALICE, await staleContext(ALICE, "no-actions"));

  const response = await harness.dispatch(
    getRequest(INVESTMENT_INTEREST_PATH, ALICE),
    ALICE,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(actionNames(await jsonDocument(response)), []);
});

test("route rejects cross-origin, forged, extra, malformed, and stale mutations with fixed responses", async () => {
  const harness = await createHarness();
  const privateMarker = "private-cross-origin-marker";
  const crossOrigin = await harness.dispatch(
    jsonMutation(
      INVESTMENT_INTEREST_PATH,
      ALICE,
      "POST",
      personalBody("investment-operation:cross-origin", {
        note: privateMarker,
      }),
      { origin: "https://attacker.example" },
    ),
    ALICE,
  );
  assert.equal(crossOrigin.status, 403);
  assert.doesNotMatch(await crossOrigin.text(), new RegExp(privateMarker, "u"));

  const extraField = await harness.dispatch(
    jsonMutation(
      INVESTMENT_INTEREST_PATH,
      ALICE,
      "POST",
      {
        ...personalBody("investment-operation:extra-field"),
        participantSubject: BOB,
      },
    ),
    ALICE,
  );
  assert.equal(extraField.status, 400);

  const invalidIncrement = await harness.dispatch(
    jsonMutation(
      INVESTMENT_INTEREST_PATH,
      ALICE,
      "POST",
      personalBody("investment-operation:invalid-increment", { amount: 1_251 }),
    ),
    ALICE,
  );
  assert.equal(invalidIncrement.status, 400);

  const missingAuthorityBody = companyBody(
    "investment-operation:missing-authority",
  );
  delete (missingAuthorityBody as Record<string, unknown>)[
    "representative-authority-declared"
  ];
  const missingAuthority = await harness.dispatch(
    jsonMutation(
      INVESTMENT_INTEREST_PATH,
      ALICE,
      "POST",
      missingAuthorityBody,
    ),
    ALICE,
  );
  assert.equal(missingAuthority.status, 400);

  const forgedSession = await harness.dispatch(
    jsonMutation(
      INVESTMENT_INTEREST_PATH,
      ALICE,
      "POST",
      personalBody("investment-operation:forged-session"),
      { sessionSubject: BOB },
    ),
    ALICE,
  );
  assert.equal(forgedSession.status, 404);

  const badCsrf = await harness.dispatch(
    jsonMutation(
      INVESTMENT_INTEREST_PATH,
      ALICE,
      "POST",
      personalBody("investment-operation:bad-csrf"),
      { csrfToken: "wrong-but-bounded-csrf-token-0123456789" },
    ),
    ALICE,
  );
  assert.equal(badCsrf.status, 403);

  const created = await harness.dispatch(
    jsonMutation(
      INVESTMENT_INTEREST_PATH,
      ALICE,
      "POST",
      personalBody("investment-operation:stale-route-create"),
    ),
    ALICE,
  );
  assert.equal(created.status, 201);
  const staleEdit = await harness.dispatch(
    jsonMutation(
      investmentInterestItemPath("investment-operation:stale-route-create"),
      ALICE,
      "PATCH",
      personalBody("investment-operation:stale-route-edit", {
        "expected-revision": 7,
      }),
    ),
    ALICE,
  );
  assert.equal(staleEdit.status, 412);
});

test("route negotiates versions, bounds paths, and declares methods", async () => {
  const harness = await createHarness();
  const unsupported = await harness.dispatch(
    getRequest(
      INVESTMENT_INTEREST_PATH,
      ALICE,
      "application/vnd.aittadb-invest+json; version=9.0",
    ),
    ALICE,
  );
  assert.equal(unsupported.status, 406);

  const invalidPath = await harness.dispatch(
    getRequest(`${INVESTMENT_INTEREST_PATH}/bad%2Fid`, ALICE),
    ALICE,
  );
  assert.equal(invalidPath.status, 404);

  const putCollection = await harness.dispatch(
    rawRequest(INVESTMENT_INTEREST_PATH, ALICE, "PUT"),
    ALICE,
  );
  assert.equal(putCollection.status, 405);
  assert.equal(putCollection.headers.get("allow"), "GET, POST");

  const unrelated = await harness.dispatch(getRequest("/unrelated", ALICE), ALICE);
  assert.equal(unrelated.status, 599);
});

type Harness = Readonly<{
  state: InvestmentInterestRepositoryFixtureState;
  contexts: Map<ActorSubject, TrustedPackageAcknowledgmentContext>;
  permissions: Map<ActorSubject, InvestmentInterestPermissions>;
  dispatch(
    request: Request,
    actorSubject: ActorSubject | null,
    options?: Readonly<{ declaredInterest?: "founder" | "investor" | "both" }>,
  ): Promise<Response>;
}>;

type HarnessOptions = Readonly<{
  csrfTokenFor?: () => string | null | Promise<string | null>;
  createOperationId?: () => string;
}>;

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const state = new InvestmentInterestRepositoryFixtureState();
  const contexts = new Map<ActorSubject, TrustedPackageAcknowledgmentContext>([
    [ALICE, await currentContext(ALICE, "route-alice")],
    [BOB, await currentContext(BOB, "route-bob")],
  ]);
  const permissions = new Map<ActorSubject, InvestmentInterestPermissions>([
    [ALICE, ALLOW_ALL],
    [BOB, ALLOW_ALL],
  ]);
  const clocks = new Map<ActorSubject, number>();
  let operationCounter = 0;
  const csrfHash = await hashCsrfToken(CSRF_TOKEN);
  const handler = createInvestmentInterestRouteHandler({
    serviceFor: (actorSubject) =>
      {
        const persistence = new InvestmentInterestRepositoryFixture(
          state,
          actorSubject,
          AMOUNT,
        );
        return createParticipantInvestmentInterestService({
        actorSubject,
        amountConfiguration: AMOUNT,
        reader: persistence,
        mutations: persistence,
        loadAcknowledgmentContext: () => contexts.get(actorSubject) ?? null,
        loadPermissions: () => permissions.get(actorSubject) ?? ALLOW_ALL,
        indicationIdForOperation,
        now: () => {
          const next = (clocks.get(actorSubject) ?? 9) + 1;
          clocks.set(actorSubject, next);
          return new Date(
            `2026-08-12T${String(next).padStart(2, "0")}:00:00.000Z`,
          );
        },
        });
      },
    mutationSecurity: {
      allowedOrigins: [REQUEST_ORIGIN],
      resolveSession: async (request) => {
        const candidate = request.headers.get("x-test-session-subject");
        const parsed = parseActorSubject(candidate);
        if (!parsed.ok) return null;
        return Object.freeze({
          actor: Object.freeze({ type: "participant", subject: parsed.value }),
          expiresAt: timestamp("2026-08-13T00:00:00.000Z"),
          csrf: Object.freeze({
            tokenHash: csrfHash,
            expiresAt: timestamp("2026-08-13T00:00:00.000Z"),
          }),
        }) satisfies TrustedMutationSession;
      },
      now: () => new Date("2026-08-12T09:00:00.000Z"),
      maxBodyBytes: 32_000,
      maxFields: 32,
    },
    csrfTokenFor: options.csrfTokenFor ?? (() => CSRF_TOKEN),
    createOperationId: options.createOperationId ??
      (() => `investment-operation:form-${++operationCounter}`),
  });

  return Object.freeze({
    state,
    contexts,
    permissions,
    async dispatch(request, actorSubject, options = {}) {
      const url = new URL(request.url);
      const context = routeContext(
        request,
        url,
        actorSubject,
        contexts.get(actorSubject ?? ALICE) ?? null,
        options.declaredInterest ?? "investor",
      );
      return (await handler(context)) ?? new Response("unhandled", { status: 599 });
    },
  });
}

function routeContext(
  request: Request,
  url: URL,
  actorSubject: ActorSubject | null,
  acknowledgment: TrustedPackageAcknowledgmentContext | null,
  declaredInterest: "founder" | "investor" | "both",
): ApplicationRouteContext {
  const participantAccess = actorSubject === null
    ? null
    : Object.freeze({
        subject: actorSubject,
        email: "participant@example.invalid",
        displayName: "Synthetic Participant",
        declaredInterest,
        participationContext: "individual",
        accountStatus: "active",
        currentPackage: acknowledgment === null
          ? null
          : Object.freeze({
              id: acknowledgment.currentVersion.id,
              createdAt: acknowledgment.currentVersion.createdAt,
              changeSummary: acknowledgment.currentVersion.changeSummary,
              materialChange: acknowledgment.currentVersion.materialChange,
              requiresCurrentAcceptance: false,
            }),
      }) as AuthorizedParticipantAccess;
  return Object.freeze({
    request,
    url,
    resourceUrl: `${CANONICAL_ORIGIN}${url.pathname}${url.search}`,
    actor: actorSubject === null
      ? null
      : Object.freeze({
          userId: actorSubject,
          email: "participant@example.invalid",
          displayName: "Synthetic Participant",
        }),
    isOwner: false,
    participantAccess,
    campaign: syntheticPublicCampaign,
    renderApplication: async () => new Response("unexpected", { status: 598 }),
  });
}

function getRequest(
  path: string,
  subjectValue: ActorSubject | null,
  accept = "application/json",
): Request {
  return rawRequest(path, subjectValue, "GET", { accept });
}

function rawRequest(
  path: string,
  subjectValue: ActorSubject | null,
  method: string,
  headers: Readonly<Record<string, string>> = {},
): Request {
  return new Request(`${REQUEST_ORIGIN}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(subjectValue === null
        ? {}
        : {
            "oai-authenticated-user-id": subjectValue,
            "oai-authenticated-user-email": "participant@example.invalid",
          }),
      ...headers,
    },
  });
}

function jsonMutation(
  path: string,
  subjectValue: ActorSubject,
  method: "POST" | "PATCH" | "DELETE",
  body: Readonly<Record<string, unknown>>,
  overrides: Readonly<{
    origin?: string;
    sessionSubject?: ActorSubject;
    csrfToken?: string;
  }> = {},
): Request {
  return new Request(`${REQUEST_ORIGIN}${path}`, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: overrides.origin ?? REQUEST_ORIGIN,
      [MUTATION_CSRF_HEADER]: overrides.csrfToken ?? CSRF_TOKEN,
      "x-test-session-subject": overrides.sessionSubject ?? subjectValue,
      "oai-authenticated-user-id": subjectValue,
      "oai-authenticated-user-email": "participant@example.invalid",
    },
    body: JSON.stringify(body),
  });
}

function formMutation(
  path: string,
  subjectValue: ActorSubject,
  entries: readonly (readonly [string, string])[],
): Request {
  const body = new URLSearchParams();
  for (const [name, value] of entries) body.append(name, value);
  return new Request(`${REQUEST_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
      origin: REQUEST_ORIGIN,
      "x-test-session-subject": subjectValue,
      "oai-authenticated-user-id": subjectValue,
      "oai-authenticated-user-email": "participant@example.invalid",
    },
    body: body.toString(),
  });
}

function personalBody(
  operationId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    "operation-id": operationId,
    kind: "personal",
    "residence-country": "fi",
    amount: 1_250,
    "availability-period": "Within twelve months.",
    note: "Initial note.",
    ...overrides,
  };
}

function companyBody(
  operationId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    "operation-id": operationId,
    kind: "company",
    "company-name": "Synthetic company",
    "registration-country": "FI",
    "company-identifier": "SYNTHETIC-123",
    "representative-name": "Synthetic representative",
    "representative-authority-declared": true,
    amount: 2_000,
    "availability-period": "Within twelve months.",
    note: null,
    ...overrides,
  };
}

function assertActionFormParity(document: JsonRecord, html: string): void {
  for (const action of actionsOf(document)) {
    const value = dataOf(action);
    assert.match(
      html,
      new RegExp(`data-action-name="${escapeRegExp(String(value.name))}"`, "u"),
    );
    assert.match(
      html,
      new RegExp(`data-effective-method="${escapeRegExp(String(value.method))}"`, "u"),
    );
    assert.match(
      html,
      new RegExp(`action="${escapeRegExp(String(value.href))}"`, "u"),
    );
  }
  const formNames = [...html.matchAll(/data-action-name="([^"]+)"/gu)].map(
    (match) => match[1],
  );
  assert.deepEqual(formNames, actionNames(document));
}

type JsonRecord = Readonly<Record<string, unknown>>;

async function jsonDocument(response: Response): Promise<JsonRecord> {
  assert.match(
    response.headers.get("content-type") ?? "",
    /(?:application\/json|application\/vnd\.aittadb-invest\+json)/u,
  );
  return dataOf(await response.json());
}

function dataOf(value: unknown): JsonRecord {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as JsonRecord;
}

function actionsOf(document: JsonRecord): readonly JsonRecord[] {
  assert(Array.isArray(document.actions));
  return document.actions.map(dataOf);
}

function resourceData(document: JsonRecord): JsonRecord {
  return dataOf(document.data);
}

function actionNames(document: JsonRecord): readonly string[] {
  return actionsOf(document).map((action) => String(action.name));
}

function historyOf(document: JsonRecord): readonly JsonRecord[] {
  const data = dataOf(document.data);
  assert(Array.isArray(data.history));
  return data.history.map(dataOf);
}

function linkFor(document: JsonRecord, relation: string): string | null {
  assert(Array.isArray(document.links));
  for (const candidate of document.links) {
    const link = dataOf(candidate);
    if (Array.isArray(link.rel) && link.rel.includes(relation)) {
      return String(link.href);
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function configuredAmount(): AmountConfiguration {
  const parsed = parseAmountAggregateConfiguration({
    amount: {
      currency: "eur",
      minimum: 1_000,
      increment: 250,
      maximum: 10_000,
    },
    publicAggregate: { visibility: "hidden" },
  });
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value.amount;
}

async function currentContext(
  participantSubject: ActorSubject,
  suffix: string,
): Promise<TrustedPackageAcknowledgmentContext> {
  const version = await packageVersion(`package-version:${suffix}`);
  return Object.freeze({
    currentVersion: version,
    latestAcceptance: acceptance(
      version,
      participantSubject,
      `package-acceptance:${suffix}`,
    ),
  });
}

async function staleContext(
  participantSubject: ActorSubject,
  suffix: string,
): Promise<TrustedPackageAcknowledgmentContext> {
  const initial = await packageVersion(`package-version:${suffix}:initial`);
  const current = await packageVersion(
    `package-version:${suffix}:material`,
    initial,
    true,
  );
  return Object.freeze({
    currentVersion: current,
    latestAcceptance: acceptance(
      initial,
      participantSubject,
      `package-acceptance:${suffix}:initial`,
    ),
  });
}

async function packageVersion(
  id: string,
  previous: PackageVersion | null = null,
  materialChange = false,
): Promise<PackageVersion> {
  const parsed = await createPackageVersion(
    {
      id,
      createdAt: previous === null
        ? "2026-08-09T08:00:00.000Z"
        : "2026-08-11T08:00:00.000Z",
      changeSummary: materialChange
        ? "Material synthetic update"
        : "Initial synthetic package",
      materialChange,
      acknowledgmentText:
        "This non-binding indication can be edited or withdrawn.",
      sections: [{
        id: "package-section:route-investment-overview",
        order: 0,
        title: "Overview",
        markdown: materialChange
          ? "Updated synthetic package."
          : "Synthetic package.",
        enabled: true,
      }],
    },
    previous,
  );
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function acceptance(
  version: PackageVersion,
  participantSubject: ActorSubject,
  id: string,
): PackageAcceptanceRecord {
  const parsed = createPackageAcceptance(
    {
      id,
      participantSubject,
      acceptedAt: "2026-08-09T09:00:00.000Z",
    },
    version,
  );
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function subject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function indicationIdForOperation(value: unknown): InvestmentIndicationId {
  const parsed = parseStableId<"investment-indication">(value);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function timestamp(value: string) {
  const parsed = parseTimestamp(value);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}
