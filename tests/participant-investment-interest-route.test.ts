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
  INVESTMENT_WITHDRAWAL_REPLAY_ACTION,
  investmentInterestItemPath,
  investmentWithdrawalReplayPath,
} from "../domain/participant-investment-interest-resource.ts";
import type { AuthorizedParticipantAccess } from "../domain/participant-home-resource.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  MUTATION_METHOD_FIELD,
  MutationSecurityFailure,
  hashCsrfToken,
  type TrustedMutationSession,
} from "../http/mutation-security.ts";
import {
  createBrowserMutationSession,
  type BrowserMutationProof,
  type BrowserMutationReplayClaim,
  type BrowserMutationSession,
  type BrowserMutationVerificationLimits,
  type TrustedSitesMutationIdentity,
} from "../http/browser-mutation-session.ts";
import type { ApplicationRouteContext } from "../worker/contracts.ts";
import {
  createParticipantInvestmentInterestService,
  type InvestmentInterestPermissions,
} from "../worker/investment-interest-service.ts";
import {
  createInvestmentInterestRouteHandler,
  investmentInterestMutationLimits,
  investmentWithdrawalReplayScope,
  MAX_INVESTMENT_DELETE_MUTATION_BYTES,
  MAX_INVESTMENT_DELETE_MUTATION_FIELDS,
  MAX_INVESTMENT_PATCH_MUTATION_BYTES,
  MAX_INVESTMENT_PATCH_MUTATION_FIELDS,
  MAX_INVESTMENT_POST_MUTATION_BYTES,
  MAX_INVESTMENT_POST_MUTATION_FIELDS,
  type InvestmentInterestMutationVerifier,
} from "../worker/routes/investment-interest.ts";
import { syntheticPublicCampaign } from "./fixtures/public-campaign.ts";
import {
  InvestmentInterestRepositoryFixture,
  InvestmentInterestRepositoryFixtureState,
} from "./support/investment-interest-repository-fixture.ts";

const REQUEST_ORIGIN = "https://request.example";
const CANONICAL_ORIGIN = "https://canonical.example";
const CSRF_TOKEN = "investment_csrf_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ISSUED_COOKIE =
  "__Host-investor_mutation_investment=encrypted; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Strict";
const CLEAR_COOKIE =
  "__Host-investor_mutation_investment=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict";
const FORM_PREFLIGHT_DEADLINE_MS = 1_000;
const ALICE = subject("issuer.invalid/participant:alice-route-investment");
const BOB = subject("issuer.invalid/participant:bob-route-investment");
const PARTICIPANT_IDENTITY = Object.freeze({
  type: "participant",
  subject: ALICE,
}) satisfies TrustedSitesMutationIdentity;
const OWNER_IDENTITY = Object.freeze({
  type: "owner",
  subject: ALICE,
}) satisfies TrustedSitesMutationIdentity;
const AMOUNT = configuredAmount();
const ALLOW_ALL = Object.freeze({
  createPersonal: true,
  createCompany: true,
  edit: true,
  reactivatePersonal: true,
  reactivateCompany: true,
}) satisfies InvestmentInterestPermissions;

test("withdrawal replay scope stays bounded at accepted identity and command maxima", async () => {
  const maximum = await investmentWithdrawalReplayScope(
    "s".repeat(255),
    "i".repeat(128),
    Object.freeze({
      operationId: "o".repeat(127),
      expectedRevision: Number.MAX_SAFE_INTEGER - 2,
      resultingRevision: Number.MAX_SAFE_INTEGER - 1,
    }),
  );

  assert.match(
    maximum,
    /^participant-investment-withdrawal-replay:v1:sha256:[0-9a-f]{64}$/u,
  );
  assert.ok(new TextEncoder().encode(maximum).byteLength < 512);
  assert.notEqual(
    await investmentWithdrawalReplayScope(
      `t${"s".repeat(254)}`,
      "i".repeat(128),
      Object.freeze({
        operationId: "o".repeat(127),
        expectedRevision: Number.MAX_SAFE_INTEGER - 2,
        resultingRevision: Number.MAX_SAFE_INTEGER - 1,
      }),
    ),
    maximum,
  );
});

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

  const replayPath = investmentWithdrawalReplayPath(operationId);
  const activeReplay = await harness.dispatch(
    getRequest(replayPath, ALICE),
    ALICE,
  );
  assert.equal(activeReplay.status, 404);

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
  assert.equal(
    linkFor(withdrawn, "withdrawal-replay"),
    `${CANONICAL_ORIGIN}${replayPath}`,
  );
  assert.deepEqual(
    historyOf(withdrawn).map((entry) => dataOf(entry).transition),
    ["created", "edited", "withdrawn"],
  );

  const replayResource = await harness.dispatch(
    getRequest(replayPath, ALICE),
    ALICE,
  );
  assert.equal(replayResource.status, 200);
  const replayDocument = await jsonDocument(replayResource);
  assert.equal(replayDocument.type, "participant-investment-withdrawal-replay");
  assert.deepEqual(actionNames(replayDocument), [
    INVESTMENT_WITHDRAWAL_REPLAY_ACTION,
  ]);
  const unsupportedReplay = await harness.dispatch(
    rawRequest(replayPath, ALICE, "PUT"),
    ALICE,
  );
  assert.equal(unsupportedReplay.status, 405);
  assert.equal(unsupportedReplay.headers.get("allow"), "GET, DELETE");

  const withdrawReplay = await harness.dispatch(
    jsonMutation(replayPath, ALICE, "DELETE", withdrawBody),
    ALICE,
  );
  assert.equal(withdrawReplay.status, 200);
  assert.equal(
    (await jsonDocument(withdrawReplay)).type,
    "participant-investment-withdrawal-replay",
  );

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

test("hosted investment discovery keeps proof cookies out of representations", async () => {
  const proof = Object.freeze({
    token: CSRF_TOKEN,
    expiresAt: timestamp("2026-08-12T09:05:00.000Z"),
    setCookie: ISSUED_COOKIE,
  }) satisfies BrowserMutationProof;
  const harness = await createHarness({ csrfTokenFor: () => proof });

  const jsonResponse = await harness.dispatch(
    getRequest(INVESTMENT_INTEREST_PATH, ALICE),
    ALICE,
  );
  assert.equal(jsonResponse.status, 200);
  assert.equal(jsonResponse.headers.get("set-cookie"), ISSUED_COOKIE);
  assert.equal(jsonResponse.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  const json = await jsonResponse.text();
  assert.doesNotMatch(json, new RegExp(CSRF_TOKEN, "u"));
  assert.doesNotMatch(json, /set-cookie|encrypted|HttpOnly/iu);

  const htmlResponse = await harness.dispatch(
    getRequest(INVESTMENT_INTEREST_PATH, ALICE, "text/html"),
    ALICE,
  );
  assert.equal(htmlResponse.status, 200);
  assert.equal(htmlResponse.headers.get("set-cookie"), ISSUED_COOKIE);
  const html = await htmlResponse.text();
  assert.match(html, new RegExp(`name="_csrf"[^>]+value="${CSRF_TOKEN}"`, "u"));
  assert.doesNotMatch(html, /set-cookie|encrypted|HttpOnly/iu);
});

test("hosted investment mutations clear consumed proofs after verification", async () => {
  const operationId = "investment-operation:hosted-success";
  const success = await createHarness({
    verifyMutation: investmentVerifierFor(
      "POST",
      personalBody(operationId),
      CLEAR_COOKIE,
    ),
  });
  const successResponse = await success.dispatch(
    jsonMutation(
      INVESTMENT_INTEREST_PATH,
      ALICE,
      "POST",
      personalBody(operationId),
    ),
    ALICE,
  );
  assert.equal(successResponse.status, 201);
  assertSingleCookie(successResponse, CLEAR_COOKIE);

  const parser = await createHarness({
    verifyMutation: investmentVerifierFor("POST", {
      ...personalBody("investment-operation:hosted-parser"),
      unexpected: "private parser value",
    }, CLEAR_COOKIE),
  });
  const parserResponse = await parser.dispatch(
    jsonMutation(
      INVESTMENT_INTEREST_PATH,
      ALICE,
      "POST",
      personalBody("investment-operation:hosted-parser"),
    ),
    ALICE,
  );
  assert.equal(parserResponse.status, 400);
  assertSingleCookie(parserResponse, CLEAR_COOKIE);
  assert.doesNotMatch(
    await parserResponse.text(),
    /private parser value|Max-Age=0/iu,
  );

  const rejected = await createHarness({
    async verifyMutation() {
      throw new MutationSecurityFailure("REQUEST_REJECTED");
    },
  });
  const rejectedResponse = await rejected.dispatch(
    jsonMutation(
      INVESTMENT_INTEREST_PATH,
      ALICE,
      "POST",
      personalBody("investment-operation:hosted-rejected"),
    ),
    ALICE,
  );
  assert.equal(rejectedResponse.status, 403);
  assert.equal(rejectedResponse.headers.get("set-cookie"), null);
});

test("hosted investment verification requires a valid clear cookie", async () => {
  for (const [name, clearCookie] of [
    ["missing", undefined],
    ["malformed", "bad\r\nclear-cookie"],
  ] as const) {
    const body = personalBody(`investment-operation:hosted-${name}`);
    const verified = await investmentVerifierFor(
      "POST",
      body,
      CLEAR_COOKIE,
    )(
      jsonMutation(INVESTMENT_INTEREST_PATH, ALICE, "POST", body),
      investmentInterestMutationLimits("POST"),
    );
    const harness = await createHarness({
      verifyMutation: (async () => clearCookie === undefined
        ? {
            actor: verified.actor,
            method: verified.method,
            mediaType: verified.mediaType,
            body: verified.body,
          } as never
        : { ...verified, clearCookie } as never) as InvestmentInterestMutationVerifier,
    });
    const response = await harness.dispatch(
      jsonMutation(INVESTMENT_INTEREST_PATH, ALICE, "POST", body),
      ALICE,
    );
    assert.equal(response.status, 503, name);
    assert.equal(response.headers.get("set-cookie"), null, name);
    assert.equal(harness.state.indications.size, 0, name);
  }
});

test("investment route owns finite per-method mutation limits", () => {
  assert.deepEqual(investmentInterestMutationLimits("POST"), {
    maxBodyBytes: MAX_INVESTMENT_POST_MUTATION_BYTES,
    maxFields: MAX_INVESTMENT_POST_MUTATION_FIELDS,
    repeatedFormFields: [],
  });
  assert.deepEqual(investmentInterestMutationLimits("PATCH"), {
    maxBodyBytes: MAX_INVESTMENT_PATCH_MUTATION_BYTES,
    maxFields: MAX_INVESTMENT_PATCH_MUTATION_FIELDS,
    repeatedFormFields: [],
  });
  assert.deepEqual(investmentInterestMutationLimits("DELETE"), {
    maxBodyBytes: MAX_INVESTMENT_DELETE_MUTATION_BYTES,
    maxFields: MAX_INVESTMENT_DELETE_MUTATION_FIELDS,
    repeatedFormFields: [],
  });
  assert.throws(
    () => investmentInterestMutationLimits("PUT"),
    MutationSecurityFailure,
  );
});

test("above-POST-cap override preflight completes without consuming its proof", async () => {
  const hosted = await createHostedMutationSession();
  const proof = await issueHostedInvestmentProof(
    hosted.session,
    PARTICIPANT_IDENTITY,
  );
  let verificationCalls = 0;
  const harness = await createHarness({
    verifyMutation(request, limits) {
      verificationCalls += 1;
      return hosted.session.verifyMutation(
        request,
        PARTICIPANT_IDENTITY,
        CANONICAL_ORIGIN,
        limits,
      );
    },
    csrfTokenFor: () => proof,
  });
  const response = await completesWithin(
    harness.dispatch(
      hostedInvestmentFormMutation(
        proof,
        investmentInterestItemPath(
          "investment-operation:hosted-post-cap-target",
        ),
        [
          [MUTATION_METHOD_FIELD, "DELETE"],
          ["operation-id", "investment-operation:hosted-post-cap"],
          ["expected-revision", "1"],
          ["confirm-withdrawal", "x".repeat(70 * 1_024)],
        ],
      ),
      ALICE,
    ),
    FORM_PREFLIGHT_DEADLINE_MS,
  );

  assert.equal(response.status, 413);
  assert.equal(verificationCalls, 0);
  assert.deepEqual(hosted.claims.calls, []);
  assert.equal(harness.serviceCalls(), 0);
  assert.equal(harness.state.indications.size, 0);
});

test("hosted investment rejects a wrong origin before preflight or proof consumption", async () => {
  const hosted = await createHostedMutationSession();
  const proof = await issueHostedInvestmentProof(
    hosted.session,
    PARTICIPANT_IDENTITY,
  );
  const replacements: BrowserMutationProof[] = [];
  let verificationCalls = 0;
  const harness = await createHarness({
    verifyMutation(request, limits) {
      verificationCalls += 1;
      return hosted.session.verifyMutation(
        request,
        PARTICIPANT_IDENTITY,
        CANONICAL_ORIGIN,
        limits,
      );
    },
    async csrfTokenFor(request) {
      const replacement = await hosted.session.issue(
        request,
        PARTICIPANT_IDENTITY,
        CANONICAL_ORIGIN,
      );
      replacements.push(replacement);
      return replacement;
    },
  });
  const privateMarker = "wrong-origin-private-investment-marker";

  const rejected = await completesWithin(
    harness.dispatch(
      hostedInvestmentFormMutation(
        proof,
        INVESTMENT_INTEREST_PATH,
        [
          ["operation-id", "investment-operation:wrong-origin"],
          ["kind", "personal"],
          ["residence-country", "FI"],
          ["amount", "1250"],
          ["availability-period", "Within twelve months."],
          [
            "note",
            `${privateMarker}${"x".repeat(70 * 1_024)}`,
          ],
        ],
        "https://attacker.example",
      ),
      ALICE,
    ),
    FORM_PREFLIGHT_DEADLINE_MS,
  );

  assert.equal(rejected.status, 403);
  assert.deepEqual(rejected.headers.getSetCookie(), []);
  assert.doesNotMatch(await rejected.text(), new RegExp(privateMarker, "u"));
  assert.equal(verificationCalls, 0);
  assert.deepEqual(hosted.claims.calls, []);
  assert.equal(harness.serviceCalls(), 0);
  assert.equal(harness.state.indications.size, 0);

  const corrected = await harness.dispatch(
    hostedInvestmentJsonMutation(
      proof,
      INVESTMENT_INTEREST_PATH,
      "POST",
      personalBody("investment-operation:corrected-origin"),
    ),
    ALICE,
  );
  assert.equal(corrected.status, 201);
  assert.equal(verificationCalls, 1);
  assert.equal(hosted.claims.calls.length, 1);
  assert.equal(harness.serviceCalls(), 1);
  assert.equal(harness.state.indications.size, 1);
  assert.equal(replacements.length, 1);
});

test("real hosted investment verification applies method limits before replay or persistence", async () => {
  const hosted = await createHostedMutationSession();
  const proof = await issueHostedInvestmentProof(
    hosted.session,
    PARTICIPANT_IDENTITY,
  );
  let verificationCalls = 0;
  const harness = await createHarness({
    verifyMutation: (request, limits) => {
      verificationCalls += 1;
      return hosted.session.verifyMutation(
        request,
        PARTICIPANT_IDENTITY,
        CANONICAL_ORIGIN,
        limits,
      );
    },
    csrfTokenFor: () => proof,
  });
  const itemPath = investmentInterestItemPath(
    "investment-operation:hosted-limit-target",
  );

  for (const [name, request] of [
    [
      "post",
      hostedInvestmentJsonMutation(
        proof,
        INVESTMENT_INTEREST_PATH,
        "POST",
        personalBody("investment-operation:hosted-post-limit", {
          note: "x".repeat(MAX_INVESTMENT_POST_MUTATION_BYTES),
        }),
      ),
    ],
    [
      "patch",
      hostedInvestmentJsonMutation(
        proof,
        itemPath,
        "PATCH",
        personalBody("investment-operation:hosted-patch-limit", {
          "expected-revision": 1,
          note: "x".repeat(MAX_INVESTMENT_PATCH_MUTATION_BYTES),
        }),
      ),
    ],
    [
      "delete",
      hostedInvestmentJsonMutation(
        proof,
        itemPath,
        "DELETE",
        {
          "operation-id": "investment-operation:hosted-delete-limit",
          "expected-revision": 1,
          "confirm-withdrawal": "x".repeat(
            MAX_INVESTMENT_DELETE_MUTATION_BYTES,
          ),
        },
      ),
    ],
  ] as const) {
    const response = await harness.dispatch(request, ALICE);
    assert.equal(response.status, 413, name);
  }

  const excessBody = Object.freeze({
    ...personalBody("investment-operation:hosted-excess-fields"),
    ...Object.fromEntries(
      Array.from(
        { length: MAX_INVESTMENT_POST_MUTATION_FIELDS },
        (_, index) => [`unexpected-${index}`, "private"],
      ),
    ),
  });
  assert(
    Object.keys(excessBody).length > MAX_INVESTMENT_POST_MUTATION_FIELDS,
  );
  const excess = await harness.dispatch(
    hostedInvestmentJsonMutation(
      proof,
      INVESTMENT_INTEREST_PATH,
      "POST",
      excessBody,
    ),
    ALICE,
  );
  assert.equal(excess.status, 400);

  const repeated = await harness.dispatch(
    hostedInvestmentFormMutation(proof, INVESTMENT_INTEREST_PATH, [
      ["operation-id", "investment-operation:hosted-repeated-field"],
      ["kind", "personal"],
      ["residence-country", "FI"],
      ["amount", "1250"],
      ["availability-period", "Within twelve months."],
      ["note", "First private note"],
      ["note", "Second private note"],
    ]),
    ALICE,
  );
  assert.equal(repeated.status, 400);

  const callsBeforeOverrides = verificationCalls;
  const oversizedOverride = await harness.dispatch(
    hostedInvestmentFormMutation(proof, itemPath, [
      [MUTATION_METHOD_FIELD, "DELETE"],
      ["operation-id", "investment-operation:hosted-override-size"],
      ["expected-revision", "1"],
      [
        "confirm-withdrawal",
        "x".repeat(MAX_INVESTMENT_DELETE_MUTATION_BYTES),
      ],
    ]),
    ALICE,
  );
  assert.equal(oversizedOverride.status, 413);

  const excessDeleteOverride = await harness.dispatch(
    hostedInvestmentFormMutation(proof, itemPath, [
      [MUTATION_METHOD_FIELD, "DELETE"],
      ["operation-id", "investment-operation:hosted-override-fields"],
      ["expected-revision", "1"],
      ["confirm-withdrawal", "true"],
      ["unexpected", "private"],
    ]),
    ALICE,
  );
  assert.equal(excessDeleteOverride.status, 400);

  const excessPatchOverride = await harness.dispatch(
    hostedInvestmentFormMutation(proof, itemPath, [
      [MUTATION_METHOD_FIELD, "PATCH"],
      ["operation-id", "investment-operation:hosted-patch-fields"],
      ["expected-revision", "1"],
      ["kind", "company"],
      ["company-name", "Synthetic company"],
      ["registration-country", "FI"],
      ["company-identifier", "SYNTHETIC-123"],
      ["representative-name", "Synthetic representative"],
      ["representative-authority-declared", "true"],
      ["amount", "2000"],
      ["availability-period", "Within twelve months."],
      ["note", "Private"],
      ["unexpected", "private"],
    ]),
    ALICE,
  );
  assert.equal(excessPatchOverride.status, 400);

  assert.equal(harness.serviceCalls(), 0);
  assert.equal(harness.state.indications.size, 0);
  assert.deepEqual(hosted.claims.calls, []);
  assert.equal(verificationCalls, callsBeforeOverrides);
});

test("real hosted PATCH and DELETE override forms use effective limits and remain usable", async () => {
  const hosted = await createHostedMutationSession();
  const proof = await issueHostedInvestmentProof(
    hosted.session,
    PARTICIPANT_IDENTITY,
  );
  const replacements: BrowserMutationProof[] = [];
  const limitsSeen: BrowserMutationVerificationLimits[] = [];
  const harness = await createHarness({
    verifyMutation(request, limits) {
      limitsSeen.push(limits);
      return hosted.session.verifyMutation(
        request,
        PARTICIPANT_IDENTITY,
        CANONICAL_ORIGIN,
        limits,
      );
    },
    async csrfTokenFor(request) {
      const replacement = await hosted.session.issue(
        request,
        PARTICIPANT_IDENTITY,
        CANONICAL_ORIGIN,
      );
      replacements.push(replacement);
      return replacement;
    },
  });
  const indicationId = "investment-operation:hosted-override-lifecycle";
  const itemPath = investmentInterestItemPath(indicationId);

  const created = await harness.dispatch(
    hostedInvestmentJsonMutation(
      proof,
      INVESTMENT_INTEREST_PATH,
      "POST",
      personalBody(indicationId),
    ),
    ALICE,
  );
  assert.equal(created.status, 201);
  const editProof = replacements[0];
  assert(editProof);

  const edited = await harness.dispatch(
    hostedInvestmentFormMutation(editProof, itemPath, [
      [MUTATION_METHOD_FIELD, "PATCH"],
      ["operation-id", "investment-operation:hosted-override-edit"],
      ["expected-revision", "1"],
      ["kind", "personal"],
      ["residence-country", "FI"],
      ["amount", "1500"],
      ["availability-period", "Within six months."],
      ["note", "Updated through the HTML form."],
    ]),
    ALICE,
  );
  assert.equal(edited.status, 200);
  const withdrawProof = replacements[1];
  assert(withdrawProof);

  const withdrawn = await harness.dispatch(
    hostedInvestmentFormMutation(withdrawProof, itemPath, [
      [MUTATION_METHOD_FIELD, "DELETE"],
      ["operation-id", "investment-operation:hosted-override-withdraw"],
      ["expected-revision", "2"],
      ["confirm-withdrawal", "true"],
    ]),
    ALICE,
  );
  assert.equal(withdrawn.status, 200);
  assert.deepEqual(limitsSeen, [
    investmentInterestMutationLimits("POST"),
    {
      ...investmentInterestMutationLimits("PATCH"),
      maxFields: MAX_INVESTMENT_PATCH_MUTATION_FIELDS + 2,
    },
    {
      ...investmentInterestMutationLimits("DELETE"),
      maxFields: MAX_INVESTMENT_DELETE_MUTATION_FIELDS + 2,
    },
  ]);
  assert.equal(hosted.claims.calls.length, 3);
  assert.equal(harness.serviceCalls(), 3);
  assert.equal(harness.state.indications.size, 1);
  const persisted = [...harness.state.indications.values()][0];
  assert(persisted);
  assert.equal(persisted.lifecycle.status, "withdrawn");
});

test("real hosted investment proofs are participant-bound, one-time, and replaced after use", async () => {
  const hosted = await createHostedMutationSession();
  const participantProof = await issueHostedInvestmentProof(
    hosted.session,
    PARTICIPANT_IDENTITY,
  );
  const replacements: BrowserMutationProof[] = [];
  const harness = await createHarness({
    verifyMutation: (request, limits) => hosted.session.verifyMutation(
      request,
      PARTICIPANT_IDENTITY,
      CANONICAL_ORIGIN,
      limits,
    ),
    async csrfTokenFor(request, actorSubject) {
      assert.equal(actorSubject, ALICE);
      const replacement = await hosted.session.issue(
        request,
        PARTICIPANT_IDENTITY,
        CANONICAL_ORIGIN,
      );
      replacements.push(replacement);
      return replacement;
    },
  });
  const body = personalBody("investment-operation:hosted-real-session");

  const successful = await harness.dispatch(
    hostedInvestmentJsonMutation(
      participantProof,
      INVESTMENT_INTEREST_PATH,
      "POST",
      body,
    ),
    ALICE,
  );
  assert.equal(successful.status, 201);
  assert.equal(replacements.length, 1);
  const replacement = replacements[0];
  assert(replacement);
  assert.notEqual(cookieName(participantProof), cookieName(replacement));
  assert.equal(
    successful.headers.get(MUTATION_CSRF_HEADER),
    replacement.token,
  );
  assert.deepEqual(
    successful.headers.getSetCookie().sort(),
    [
      replacement.setCookie,
      expiredProofCookie(participantProof),
    ].sort(),
  );
  const successfulBody = await successful.text();
  assert.doesNotMatch(
    successfulBody,
    new RegExp(`${participantProof.token}|${replacement.token}`, "u"),
  );
  assert.doesNotMatch(successfulBody, /set-cookie|Max-Age=0|HttpOnly/iu);
  assert.equal(harness.serviceCalls(), 1);
  assert.equal(harness.state.indications.size, 1);
  assert.equal(hosted.claims.calls.length, 1);

  const replay = await harness.dispatch(
    hostedInvestmentJsonMutation(
      participantProof,
      INVESTMENT_INTEREST_PATH,
      "POST",
      body,
    ),
    ALICE,
  );
  assert.equal(replay.status, 403);
  assert.deepEqual(replay.headers.getSetCookie(), []);
  assert.equal(harness.serviceCalls(), 1);
  assert.equal(harness.state.indications.size, 1);
  assert.equal(hosted.claims.calls.length, 2);
  assert.equal(
    hosted.claims.calls[0]?.capabilityId,
    hosted.claims.calls[1]?.capabilityId,
  );

  const ownerProof = await issueHostedInvestmentProof(
    hosted.session,
    OWNER_IDENTITY,
  );
  const ownerAttempt = await harness.dispatch(
    hostedInvestmentJsonMutation(
      ownerProof,
      INVESTMENT_INTEREST_PATH,
      "POST",
      personalBody("investment-operation:hosted-owner-proof"),
    ),
    ALICE,
  );
  assert.equal(ownerAttempt.status, 403);
  assert.deepEqual(ownerAttempt.headers.getSetCookie(), []);
  assert.equal(harness.serviceCalls(), 1);
  assert.equal(harness.state.indications.size, 1);
  assert.equal(hosted.claims.calls.length, 2);
});

test("a correctly verified owner proof reaches fixed participant-only denial", async () => {
  const hosted = await createHostedMutationSession();
  const ownerProof = await issueHostedInvestmentProof(
    hosted.session,
    OWNER_IDENTITY,
  );
  const harness = await createHarness({
    verifyMutation: (request, limits) => hosted.session.verifyMutation(
      request,
      OWNER_IDENTITY,
      CANONICAL_ORIGIN,
      limits,
    ),
    csrfTokenFor() {
      assert.fail("Owner denial must not issue a participant replacement proof.");
    },
  });
  const ownerAttempt = await harness.dispatch(
    hostedInvestmentJsonMutation(
      ownerProof,
      INVESTMENT_INTEREST_PATH,
      "POST",
      personalBody("investment-operation:hosted-owner-proof"),
    ),
    ALICE,
  );

  assert.equal(ownerAttempt.status, 404);
  assert.deepEqual(ownerAttempt.headers.getSetCookie(), [
    expiredProofCookie(ownerProof),
  ]);
  const document = await jsonDocument(ownerAttempt);
  assert.deepEqual(resourceData(document), {
    code: "not_found",
    message: "The requested resource was not found.",
  });
  assert.deepEqual(actionNames(document), []);
  assert.doesNotMatch(
    JSON.stringify(document),
    /owner|alice-route-investment|hosted-owner-proof/iu,
  );
  assert.equal(hosted.claims.calls.length, 1);
  assert.equal(harness.serviceCalls(), 0);
  assert.equal(harness.state.indications.size, 0);
});

type Harness = Readonly<{
  state: InvestmentInterestRepositoryFixtureState;
  contexts: Map<ActorSubject, TrustedPackageAcknowledgmentContext>;
  permissions: Map<ActorSubject, InvestmentInterestPermissions>;
  serviceCalls(): number;
  dispatch(
    request: Request,
    actorSubject: ActorSubject | null,
    options?: Readonly<{ declaredInterest?: "founder" | "investor" | "both" }>,
  ): Promise<Response>;
}>;

type HarnessOptions = Readonly<{
  csrfTokenFor?: (
    request: Request,
    actorSubject: ActorSubject,
  ) =>
    | string
    | BrowserMutationProof
    | null
    | Promise<string | BrowserMutationProof | null>;
  verifyMutation?: InvestmentInterestMutationVerifier;
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
  let serviceCalls = 0;
  const csrfHash = await hashCsrfToken(CSRF_TOKEN);
  const handler = createInvestmentInterestRouteHandler({
    serviceFor: (actorSubject) => {
      serviceCalls += 1;
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
    ...(options.verifyMutation === undefined
      ? {
          mutationSecurity: {
            allowedOrigins: [CANONICAL_ORIGIN],
            resolveSession: async (request: Request) => {
              const candidate = request.headers.get("x-test-session-subject");
              const parsed = parseActorSubject(candidate);
              if (!parsed.ok) return null;
              return Object.freeze({
                actor: Object.freeze({
                  type: "participant" as const,
                  subject: parsed.value,
                }),
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
        }
      : { verifyMutation: options.verifyMutation }),
    csrfTokenFor: options.csrfTokenFor ?? (() => CSRF_TOKEN),
    createOperationId: options.createOperationId ??
      (() => `investment-operation:form-${++operationCounter}`),
  });

  return Object.freeze({
    state,
    contexts,
    permissions,
    serviceCalls: () => serviceCalls,
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
      origin: overrides.origin ?? CANONICAL_ORIGIN,
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
      origin: CANONICAL_ORIGIN,
      "x-test-session-subject": subjectValue,
      "oai-authenticated-user-id": subjectValue,
      "oai-authenticated-user-email": "participant@example.invalid",
    },
    body: body.toString(),
  });
}

class AtomicBrowserMutationClaims {
  readonly calls: BrowserMutationReplayClaim[] = [];
  readonly #claimed = new Set<string>();

  async claim(claim: BrowserMutationReplayClaim): Promise<boolean> {
    this.calls.push(claim);
    if (this.#claimed.has(claim.capabilityId)) return false;
    this.#claimed.add(claim.capabilityId);
    return true;
  }
}

async function createHostedMutationSession(): Promise<Readonly<{
  session: BrowserMutationSession;
  claims: AtomicBrowserMutationClaims;
}>> {
  const claims = new AtomicBrowserMutationClaims();
  let randomCall = 0;
  const session = createBrowserMutationSession({
    appOrigin: CANONICAL_ORIGIN,
    encryptionKey: await aesKey(73),
    claimReplay: (claim) => claims.claim(claim),
    now: () => new Date("2026-08-12T09:00:00.000Z"),
    randomBytes(length) {
      randomCall += 1;
      return Uint8Array.from(
        { length },
        (_, index) => (randomCall * 41 + index) % 256,
      );
    },
    ttlSeconds: 300,
  });
  return Object.freeze({ session, claims });
}

function issueHostedInvestmentProof(
  session: BrowserMutationSession,
  identity: TrustedSitesMutationIdentity,
): Promise<BrowserMutationProof> {
  return session.issue(
    new Request(`${CANONICAL_ORIGIN}${INVESTMENT_INTEREST_PATH}`),
    identity,
    CANONICAL_ORIGIN,
  );
}

function hostedInvestmentJsonMutation(
  proof: BrowserMutationProof,
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body: Readonly<Record<string, unknown>>,
): Request {
  return new Request(`${CANONICAL_ORIGIN}${path}`, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      cookie: proofCookieHeader(proof),
      origin: CANONICAL_ORIGIN,
      [MUTATION_CSRF_HEADER]: proof.token,
    },
    body: JSON.stringify(body),
  });
}

function hostedInvestmentFormMutation(
  proof: BrowserMutationProof,
  path: string,
  entries: readonly (readonly [string, string])[],
  origin = CANONICAL_ORIGIN,
): Request {
  const body = new URLSearchParams();
  body.append(MUTATION_CSRF_FIELD, proof.token);
  for (const [name, value] of entries) body.append(name, value);
  return new Request(`${CANONICAL_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
      cookie: proofCookieHeader(proof),
      origin,
    },
    body,
  });
}

function proofCookieHeader(proof: BrowserMutationProof): string {
  const value = proof.setCookie.split(";", 1)[0];
  assert(value);
  return value;
}

function cookieName(proof: BrowserMutationProof): string {
  const name = proofCookieHeader(proof).split("=", 1)[0];
  assert(name);
  return name;
}

function expiredProofCookie(proof: BrowserMutationProof): string {
  return `${cookieName(proof)}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Strict`;
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

async function completesWithin<T>(
  operation: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Operation exceeded ${milliseconds}ms deadline.`)),
      milliseconds,
    );
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

function investmentVerifierFor(
  method: "POST" | "PATCH" | "DELETE",
  body: Readonly<Record<string, unknown>>,
  clearCookie: string,
): InvestmentInterestMutationVerifier {
  return async () => Object.freeze({
    actor: Object.freeze({ type: "participant" as const, subject: ALICE }),
    method,
    mediaType: "application/json" as const,
    body: Object.freeze({ ...body }),
    clearCookie,
  });
}

function assertSingleCookie(response: Response, expected: string): void {
  const value = response.headers.get("set-cookie");
  assert.equal(value, expected);
  assert.equal(value?.split(expected).length, 2);
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
