import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLY_CALCULATED_AGGREGATE_CONFIRMATION,
  type InvestmentAggregateCorrectionTerminalReplay,
  type InvestmentAggregateReconciliationPreview,
} from "../domain/investment-aggregate.ts";
import { OWNER_AGGREGATE_CORRECTION_REPLAY_ACTION } from "../domain/owner-aggregate-reconciliation-resource.ts";
import { INVESTOR_APP_MEDIA_TYPE } from "../domain/public-campaign-resource.ts";
import { StorageFailure } from "../domain/storage-adapter.ts";
import {
  createBrowserMutationGuard,
  hashCsrfToken,
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
} from "../http/mutation-security.ts";
import type {
  ApplyAuditedAggregateCorrectionRequest,
  ApplyAuditedAggregateCorrectionResult,
  CampaignRevisionBoundAggregateCorrectionRepository,
} from "../repositories/in-memory-aggregate-repository.ts";
import type { ApplicationRouteContext } from "../worker/contracts.ts";
import { createOwnerAggregateReconciliationRouteHandler } from "../worker/routes/owner-aggregate-reconciliation.ts";
import { createOwnerRouteHandler } from "../worker/routes/owner.ts";

const ORIGIN = "https://invest.example";
const PATH = "/owner/aggregate-reconciliation";
const OWNER_SUBJECT = "issuer.invalid/subject:owner";
const CSRF_TOKEN = "owner_reconciliation_csrf_token_1234567890";
const OPERATION_ID = "aggregate-correction:test-operation";
const CAMPAIGN_REVISION = 7;
const OCCURRED_AT = "2026-08-09T12:00:00.000Z";
const PROOF_COOKIE =
  "__Host-investor_app_mutation_test=encrypted; Path=/; Secure; HttpOnly; SameSite=Strict";
const CLEAR_PROOF_COOKIE =
  "__Host-investor_app_mutation_test=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict";

test("owner reconciliation renders one equivalent HTML form and JSON action", async () => {
  const repository = new FakeAtomicReconciliationRepository(mismatchPreview());
  const feature = createOwnerAggregateReconciliationRouteHandler({
    repository,
    guardMutation: await mutationGuard(),
    csrfToken: async () => CSRF_TOKEN,
    issueOperationId: () => OPERATION_ID,
    now: () => new Date(OCCURRED_AT),
  });
  const handler = createOwnerRouteHandler([feature], {
    aggregateReconciliation: true,
  });

  const json = await requiredResponse(await handler(context(new Request(
    `${ORIGIN}${PATH}`,
    { headers: { Accept: `${INVESTOR_APP_MEDIA_TYPE}; version=0.1` } },
  ))));
  assert.equal(json.status, 200);
  assert.equal(json.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  assert.equal(json.headers.get("cache-control"), "no-store");
  const document = await json.json() as {
    type: string;
    data: {
      status: string;
      campaign_revision: number;
      correction_available: boolean;
      stored: { revision: number; amount: number };
      calculated: { amount: number };
    };
    actions: Array<{
      name: string;
      method: string;
      fields: Array<{
        name: string;
        presentation?: string;
        minimum?: number;
        value?: string | number;
      }>;
    }>;
  };
  assert.equal(document.type, "owner-aggregate-reconciliation");
  assert.equal(document.data.campaign_revision, CAMPAIGN_REVISION);
  assert.equal(document.data.status, "mismatch");
  assert.equal(document.data.correction_available, true);
  assert.equal(document.data.stored.revision, 1);
  assert.equal(document.data.stored.amount, 8_000);
  assert.equal(document.data.calculated.amount, 10_000);
  assert.deepEqual(document.actions.map((action) => action.name), [
    "apply-calculated-aggregate",
  ]);
  assert.equal(document.actions[0]?.method, "POST");
  assert.deepEqual(
    document.actions[0]?.fields.map((field) => field.name),
    [...correctionFieldNames()],
  );
  assert.equal(
    document.actions[0]?.fields.find((field) => field.name === "operation-id")
      ?.value,
    OPERATION_ID,
  );
  assert.equal(
    document.actions[0]?.fields.find((field) =>
      field.name === "expected-campaign-revision"
    )?.minimum,
    1,
  );
  for (const name of [
    "expected-stored-revision",
    "expected-stored-amount",
    "expected-stored-count",
    "expected-calculated-amount",
    "expected-calculated-count",
  ]) {
    assert.equal(
      document.actions[0]?.fields.find((field) => field.name === name)?.minimum,
      0,
    );
  }
  assert.deepEqual(
    document.actions[0]?.fields.map((field) => [
      field.name,
      field.presentation,
    ]),
    correctionFieldNames().map((name) => [
      name,
      name === "confirmation" ? "control" : "hidden",
    ]),
  );

  const html = await requiredResponse(await handler(context(new Request(
    `${ORIGIN}${PATH}`,
    { headers: { Accept: "text/html" } },
  ))));
  const body = await html.text();
  assert.equal(html.status, 200);
  assert.equal(html.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  assert.match(body, /Stored and calculated totals differ/);
  assert.match(body, /Campaign revision: 7/u);
  assert.match(body, /<th scope="row">Stored<\/th><td>1<\/td>/u);
  assert.match(body, /name="expected-campaign-revision" value="7"/u);
  assert.match(body, /name="operation-id" value="aggregate-correction:test-operation"/);
  assert.match(body, new RegExp(`name="${MUTATION_CSRF_FIELD}"`));
  assert.match(body, /Apply the calculated totals shown above/);
  assert.match(body, /<button type="submit">Apply calculated totals<\/button>/);
  for (const name of correctionFieldNames().filter((name) =>
    name !== "confirmation"
  )) {
    assert.match(
      body,
      new RegExp(`<input type="hidden" name="${name}"`, "u"),
    );
  }

  const ownerHome = await requiredResponse(await handler(context(new Request(
    `${ORIGIN}/owner`,
    { headers: { Accept: "application/json" } },
  ))));
  const ownerDocument = await ownerHome.json() as {
    links: Array<{ rel: string[]; href: string }>;
  };
  assert.equal(ownerDocument.links.some((link) =>
    link.rel.includes("aggregate-reconciliation") &&
    link.href === `${ORIGIN}${PATH}`
  ), true);
  assert.equal(repository.previewCalls, 2);
});

test("JSON and form mutations enforce the guard and bind the exact preview", async () => {
  for (const mediaType of [
    "application/json",
    "application/x-www-form-urlencoded",
  ] as const) {
    const repository = new FakeAtomicReconciliationRepository(mismatchPreview());
    let operationIdCalls = 0;
    const handler = createOwnerAggregateReconciliationRouteHandler({
      repository,
      guardMutation: await mutationGuard(),
      csrfToken: async () => CSRF_TOKEN,
      issueOperationId: () => {
        operationIdCalls += 1;
        return "aggregate-correction:next-operation";
      },
      now: () => new Date(OCCURRED_AT),
    });
    const fields = correctionFields();
    const request = mediaType === "application/json"
      ? new Request(`${ORIGIN}${PATH}`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": mediaType,
            Origin: ORIGIN,
            [MUTATION_CSRF_HEADER]: CSRF_TOKEN,
          },
          body: JSON.stringify(fields),
        })
      : new Request(`${ORIGIN}${PATH}`, {
          method: "POST",
          headers: {
            Accept: "text/html",
            "Content-Type": mediaType,
            Origin: ORIGIN,
          },
          body: new URLSearchParams({
            ...Object.fromEntries(
              Object.entries(fields).map(([key, value]) => [key, String(value)]),
            ),
            [MUTATION_CSRF_FIELD]: CSRF_TOKEN,
          }),
        });

    const response = await requiredResponse(await handler(context(request)));
    assert.equal(response.status, 200);
    const responseBody = await response.text();
    assert.match(responseBody, mediaType === "application/json"
      ? /"status":"match"/
      : /Stored and calculated totals match/);
    assert.match(responseBody, mediaType === "application/json"
      ? new RegExp(OWNER_AGGREGATE_CORRECTION_REPLAY_ACTION, "u")
      : /Retry recorded correction/u);
    assert.match(
      responseBody,
      mediaType === "application/json"
        ? /"stored":\{"revision":2,/u
        : /<th scope="row">Stored<\/th><td>2<\/td>/u,
    );
    assert.equal(repository.applyCalls.length, 1);
    assert.equal(repository.previewCalls, 0);
    assert.equal(operationIdCalls, 0);
    assert.deepEqual(repository.applyCalls[0], {
      operationId: OPERATION_ID,
      expectedCampaignRevision: CAMPAIGN_REVISION,
      confirmation: {
        confirmation: APPLY_CALCULATED_AGGREGATE_CONFIRMATION,
        expectedStoredRevision: 1,
        expectedStoredAmount: 8_000,
        expectedStoredContributingIndicationCount: 1,
        expectedCalculatedAmount: 10_000,
        expectedCalculatedContributingIndicationCount: 1,
      },
      ownerSubject: OWNER_SUBJECT,
      occurredAt: OCCURRED_AT,
    });
  }
});

test("maximum stored revision omits correction actions and proof in HTML and JSON", async () => {
  const repository = new FakeAtomicReconciliationRepository(overflowPreview());
  let proofCalls = 0;
  let operationIdCalls = 0;
  const handler = createOwnerAggregateReconciliationRouteHandler({
    repository,
    guardMutation: await mutationGuard(),
    csrfToken: async () => {
      proofCalls += 1;
      return CSRF_TOKEN;
    },
    issueOperationId: () => {
      operationIdCalls += 1;
      return OPERATION_ID;
    },
  });

  const json = await requiredResponse(await handler(context(new Request(
    `${ORIGIN}${PATH}`,
    { headers: { Accept: "application/json" } },
  ))));
  const document = await json.json() as {
    data: {
      correction_required: boolean;
      correction_available: boolean;
      stored: { revision: number };
    };
    actions: unknown[];
  };
  assert.equal(document.data.correction_required, true);
  assert.equal(document.data.correction_available, false);
  assert.equal(document.data.stored.revision, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(document.actions, []);
  assert.equal(json.headers.get(MUTATION_CSRF_HEADER), null);
  assert.equal(json.headers.get("set-cookie"), null);

  const html = await requiredResponse(await handler(context(new Request(
    `${ORIGIN}${PATH}`,
    { headers: { Accept: "text/html" } },
  ))));
  const body = await html.text();
  assert.match(
    body,
    new RegExp(`<th scope="row">Stored</th><td>${Number.MAX_SAFE_INTEGER}</td>`, "u"),
  );
  assert.match(body, /Correction is unavailable for this stored revision\./u);
  assert.doesNotMatch(body, /<form/u);
  assert.equal(html.headers.get(MUTATION_CSRF_HEADER), null);
  assert.equal(html.headers.get("set-cookie"), null);
  assert.equal(proofCalls, 0);
  assert.equal(operationIdCalls, 0);
});

test("matching state without a terminal receipt issues no operation or proof", async () => {
  const repository = new FakeAtomicReconciliationRepository(matchingPreview());
  let operationIdCalls = 0;
  let proofCalls = 0;
  const handler = createOwnerAggregateReconciliationRouteHandler({
    repository,
    guardMutation: await mutationGuard(),
    csrfToken: async () => {
      proofCalls += 1;
      return CSRF_TOKEN;
    },
    issueOperationId: () => {
      operationIdCalls += 1;
      return OPERATION_ID;
    },
  });

  for (const accept of ["application/json", "text/html"]) {
    const response = await requiredResponse(await handler(context(new Request(
      `${ORIGIN}${PATH}`,
      { headers: { Accept: accept } },
    ))));
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get(MUTATION_CSRF_HEADER), null);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.doesNotMatch(body, /<form|"actions":\[(?!\])/u);
  }
  assert.equal(operationIdCalls, 0);
  assert.equal(proofCalls, 0);
});

test("terminal retry has equivalent hidden HTML and hypermedia fields without a new operation", async () => {
  const replay = terminalReplay();
  const repository = new FakeAtomicReconciliationRepository(
    matchingPreview(),
    replay,
  );
  const scopes: Array<string | null> = [];
  let operationIdCalls = 0;
  const handler = createOwnerAggregateReconciliationRouteHandler({
    repository,
    guardMutation: await mutationGuard(),
    csrfToken: async (_request, exactReplayScope) => {
      scopes.push(exactReplayScope);
      return CSRF_TOKEN;
    },
    issueOperationId: () => {
      operationIdCalls += 1;
      return "aggregate-correction:must-not-be-issued";
    },
  });

  const json = await requiredResponse(await handler(context(new Request(
    `${ORIGIN}${PATH}`,
    { headers: { Accept: "application/json" } },
  ))));
  const document = await json.json() as {
    data: { correction_available: boolean };
    actions: Array<{
      name: string;
      fields: Array<{
        name: string;
        presentation?: string;
        value?: string | number;
      }>;
    }>;
  };
  assert.equal(document.data.correction_available, false);
  assert.deepEqual(document.actions.map(({ name }) => name), [
    OWNER_AGGREGATE_CORRECTION_REPLAY_ACTION,
  ]);
  const action = document.actions[0];
  assert(action);
  assert.deepEqual(
    Object.fromEntries(action.fields.map((field) => [field.name, field.value])),
    correctionFields(),
  );
  assert.deepEqual(
    action.fields.map((field) => field.presentation),
    correctionFieldNames().map((name) =>
      name === "confirmation" ? "control" : "hidden"
    ),
  );

  const html = await requiredResponse(await handler(context(new Request(
    `${ORIGIN}${PATH}`,
    { headers: { Accept: "text/html" } },
  ))));
  const body = await html.text();
  assert.match(
    body,
    new RegExp(`data-action-name="${OWNER_AGGREGATE_CORRECTION_REPLAY_ACTION}"`, "u"),
  );
  assert.match(body, /<button type="submit">Retry recorded correction<\/button>/u);
  for (const field of action.fields.filter((candidate) =>
    candidate.presentation === "hidden"
  )) {
    assert.match(
      body,
      new RegExp(
        `<input type="hidden" name="${field.name}" value="${String(field.value)}">`,
        "u",
      ),
    );
  }
  assert.equal(operationIdCalls, 0);
  assert.equal(scopes.length, 2);
  assert.equal(typeof scopes[0], "string");
  assert.equal(scopes[0], scopes[1]);
});

test("hosted proof cookies clear the spent proof and issue terminal replay proof", async () => {
  const repository = new FakeAtomicReconciliationRepository(mismatchPreview());
  const guard = await mutationGuard();
  const handler = createOwnerAggregateReconciliationRouteHandler({
    repository,
    guardMutation: async (request) => Object.freeze({
      ...await guard(request),
      clearCookie: CLEAR_PROOF_COOKIE,
    }),
    csrfToken: async () => ({
      token: CSRF_TOKEN,
      expiresAt: "2026-08-09T12:05:00.000Z" as never,
      setCookie: PROOF_COOKIE,
    }),
    issueOperationId: () => OPERATION_ID,
    now: () => new Date(OCCURRED_AT),
  });

  const get = await requiredResponse(await handler(context(new Request(
    `${ORIGIN}${PATH}`,
    { headers: { Accept: "application/json" } },
  ))));
  assert.equal(get.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  assert.equal(get.headers.get("set-cookie"), PROOF_COOKIE);

  const response = await requiredResponse(await handler(context(new Request(
    `${ORIGIN}${PATH}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: ORIGIN,
        [MUTATION_CSRF_HEADER]: CSRF_TOKEN,
      },
      body: JSON.stringify(correctionFields()),
    },
  ))));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/u);
  assert.match(response.headers.get("set-cookie") ?? "", /encrypted/u);
});

test("authentication, ownership, and mutation proofs fail without repository writes", async () => {
  const repository = new FakeAtomicReconciliationRepository(mismatchPreview());
  const handler = createOwnerAggregateReconciliationRouteHandler({
    repository,
    guardMutation: await mutationGuard(),
    csrfToken: async () => CSRF_TOKEN,
    issueOperationId: () => OPERATION_ID,
  });

  const anonymous = await requiredResponse(await handler(context(
    new Request(`${ORIGIN}${PATH}`, { headers: { Accept: "application/json" } }),
    { actor: null, isOwner: false },
  )));
  assert.equal(anonymous.status, 401);

  const foreign = await requiredResponse(await handler(context(
    new Request(`${ORIGIN}${PATH}`, { headers: { Accept: "application/json" } }),
    { actor: participantActor(), isOwner: false },
  )));
  assert.equal(foreign.status, 404);

  const anonymousPut = await requiredResponse(await handler(context(
    new Request(`${ORIGIN}${PATH}`, {
      method: "PUT",
      headers: { Accept: "application/json" },
    }),
    { actor: null, isOwner: false },
  )));
  assert.equal(anonymousPut.status, 401);
  const foreignPut = await requiredResponse(await handler(context(
    new Request(`${ORIGIN}${PATH}`, {
      method: "PUT",
      headers: { Accept: "application/json" },
    }),
    { actor: participantActor(), isOwner: false },
  )));
  assert.equal(foreignPut.status, 404);
  const ownerPut = await requiredResponse(await handler(context(
    new Request(`${ORIGIN}${PATH}`, {
      method: "PUT",
      headers: { Accept: "application/json" },
    }),
  )));
  assert.equal(ownerPut.status, 405);

  const badCsrf = await requiredResponse(await handler(context(new Request(
    `${ORIGIN}${PATH}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: ORIGIN,
        [MUTATION_CSRF_HEADER]: "wrong_token_wrong_token_wrong_token_123",
      },
      body: JSON.stringify(correctionFields()),
    },
  ))));
  assert.equal(badCsrf.status, 403);
  assert.equal(repository.applyCalls.length, 0);
  assert.equal(repository.previewCalls, 0);
});

test("an invalid consumed-proof cookie fails closed before correction", async () => {
  const repository = new FakeAtomicReconciliationRepository(mismatchPreview());
  const guard = await mutationGuard();
  const handler = createOwnerAggregateReconciliationRouteHandler({
    repository,
    guardMutation: async (request) => Object.freeze({
      ...await guard(request),
      clearCookie: "invalid\r\ncookie",
    }),
    csrfToken: async () => CSRF_TOKEN,
    issueOperationId: () => OPERATION_ID,
  });
  const response = await requiredResponse(await handler(context(new Request(
    `${ORIGIN}${PATH}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: ORIGIN,
        [MUTATION_CSRF_HEADER]: CSRF_TOKEN,
      },
      body: JSON.stringify(correctionFields()),
    },
  ))));
  assert.equal(response.status, 503);
  assert.equal(repository.applyCalls.length, 0);
  assert.equal(repository.previewCalls, 0);
});

test("correction is absent and POST fails closed without atomic consistency", async () => {
  let guardCalls = 0;
  let operationIdCalls = 0;
  const repository = {
    correctionConsistency: "unavailable" as const,
    previewReconciliation: async () => mismatchPreview(),
  };
  const handler = createOwnerAggregateReconciliationRouteHandler({
    repository,
    guardMutation: async () => {
      guardCalls += 1;
      throw new Error("guard must not run");
    },
    csrfToken: async () => {
      throw new Error("csrf token must not be requested");
    },
    issueOperationId: () => {
      operationIdCalls += 1;
      return OPERATION_ID;
    },
  });

  const get = await requiredResponse(await handler(context(new Request(
    `${ORIGIN}${PATH}`,
    { headers: { Accept: "application/json" } },
  ))));
  const document = await get.json() as {
    data: { correction_consistency: string; correction_available: boolean };
    actions: unknown[];
  };
  assert.equal(document.data.correction_consistency, "unavailable");
  assert.equal(document.data.correction_available, false);
  assert.deepEqual(document.actions, []);
  assert.equal(get.headers.has(MUTATION_CSRF_HEADER), false);

  const post = await requiredResponse(await handler(context(new Request(
    `${ORIGIN}${PATH}`,
    {
      method: "POST",
      headers: { Accept: "application/json" },
    },
  ))));
  assert.equal(post.status, 503);
  assert.equal(guardCalls, 0);
  assert.equal(operationIdCalls, 0);
});

test("stale correction previews return a fixed precondition failure", async () => {
  const repository = new FakeAtomicReconciliationRepository(mismatchPreview());
  repository.failure = new StorageFailure("PRECONDITION_FAILED");
  const handler = createOwnerAggregateReconciliationRouteHandler({
    repository,
    guardMutation: await mutationGuard(),
    csrfToken: async () => CSRF_TOKEN,
    issueOperationId: () => OPERATION_ID,
  });
  const response = await requiredResponse(await handler(context(new Request(
    `${ORIGIN}${PATH}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: ORIGIN,
        [MUTATION_CSRF_HEADER]: CSRF_TOKEN,
      },
      body: JSON.stringify(correctionFields()),
    },
  ))));
  assert.equal(response.status, 412);
  assert.deepEqual((await response.json() as { data: unknown }).data, {
    code: "precondition_failed",
    message: "The aggregate has changed. Review it again.",
  });
});

class FakeAtomicReconciliationRepository
implements CampaignRevisionBoundAggregateCorrectionRepository {
  readonly correctionConsistency = "atomic-aggregate-audit" as const;
  readonly campaignRevision = CAMPAIGN_REVISION;
  previewCalls = 0;
  applyCalls: ApplyAuditedAggregateCorrectionRequest[] = [];
  failure: StorageFailure | null = null;
  terminalReplay: InvestmentAggregateCorrectionTerminalReplay | null;
  #preview: InvestmentAggregateReconciliationPreview;

  constructor(
    preview: InvestmentAggregateReconciliationPreview,
    terminalReplay: InvestmentAggregateCorrectionTerminalReplay | null = null,
  ) {
    this.#preview = preview;
    this.terminalReplay = terminalReplay;
  }

  async previewReconciliation(): Promise<InvestmentAggregateReconciliationPreview> {
    this.previewCalls += 1;
    return this.#preview;
  }

  async previewReconciliationState() {
    this.previewCalls += 1;
    return Object.freeze({
      preview: this.#preview,
      terminalReplay: this.terminalReplay,
    });
  }

  async applyConfirmedCorrectionWithAudit(
    request: ApplyAuditedAggregateCorrectionRequest,
  ): Promise<ApplyAuditedAggregateCorrectionResult> {
    if (this.failure) throw this.failure;
    this.applyCalls.push(request);
    const previous = this.#preview;
    this.#preview = matchingPreview();
    this.terminalReplay = terminalReplay();
    return {
      preview: previous,
      stored: this.#preview.stored,
      auditEvent: {
        id: "aggregate-audit:test",
        operationId: request.operationId,
        occurredAt: request.occurredAt,
        actor: { type: "owner", subject: request.ownerSubject },
        detail: {
          kind: "resource-transition",
          resource: {
            type: "aggregate",
            id: "aggregate:investment-interest",
          },
          transition: "reconciled",
        },
      },
      replayed: false,
    } as ApplyAuditedAggregateCorrectionResult;
  }
}

async function mutationGuard() {
  const tokenHash = await hashCsrfToken(CSRF_TOKEN);
  return createBrowserMutationGuard({
    allowedOrigins: [ORIGIN],
    now: () => new Date(OCCURRED_AT),
    resolveSession: async () => ({
      actor: { type: "owner", subject: OWNER_SUBJECT as never },
      expiresAt: "2026-08-10T12:00:00.000Z" as never,
      csrf: {
        tokenHash,
        expiresAt: "2026-08-10T12:00:00.000Z" as never,
      },
    }),
  });
}

function correctionFields(): Record<string, string | number> {
  return {
    "operation-id": OPERATION_ID,
    "expected-campaign-revision": CAMPAIGN_REVISION,
    confirmation: APPLY_CALCULATED_AGGREGATE_CONFIRMATION,
    "expected-stored-revision": 1,
    "expected-stored-amount": 8_000,
    "expected-stored-count": 1,
    "expected-calculated-amount": 10_000,
    "expected-calculated-count": 1,
  };
}

function terminalReplay(): InvestmentAggregateCorrectionTerminalReplay {
  return {
    operationId: OPERATION_ID,
    expectedCampaignRevision: CAMPAIGN_REVISION,
    confirmation: {
      confirmation: APPLY_CALCULATED_AGGREGATE_CONFIRMATION,
      expectedStoredRevision: 1,
      expectedStoredAmount: 8_000 as never,
      expectedStoredContributingIndicationCount: 1,
      expectedCalculatedAmount: 10_000 as never,
      expectedCalculatedContributingIndicationCount: 1,
    },
  };
}

function correctionFieldNames(): readonly string[] {
  return [
    "operation-id",
    "expected-campaign-revision",
    "confirmation",
    "expected-stored-revision",
    "expected-stored-amount",
    "expected-stored-count",
    "expected-calculated-amount",
    "expected-calculated-count",
  ];
}

function mismatchPreview(): InvestmentAggregateReconciliationPreview {
  return {
    status: "mismatch",
    stored: {
      revision: 1,
      totalAmount: 8_000,
      currency: "EUR",
      contributingIndicationCount: 1,
    },
    calculated: {
      totalAmount: 10_000,
      currency: "EUR",
      contributingIndicationCount: 1,
    },
    correctionRequired: true,
  } as InvestmentAggregateReconciliationPreview;
}

function matchingPreview(): InvestmentAggregateReconciliationPreview {
  return {
    status: "match",
    stored: {
      revision: 2,
      totalAmount: 10_000,
      currency: "EUR",
      contributingIndicationCount: 1,
    },
    calculated: {
      totalAmount: 10_000,
      currency: "EUR",
      contributingIndicationCount: 1,
    },
    correctionRequired: false,
  } as InvestmentAggregateReconciliationPreview;
}

function overflowPreview(): InvestmentAggregateReconciliationPreview {
  return {
    status: "mismatch",
    stored: {
      revision: Number.MAX_SAFE_INTEGER,
      totalAmount: 8_000,
      currency: "EUR",
      contributingIndicationCount: 1,
    },
    calculated: {
      totalAmount: 10_000,
      currency: "EUR",
      contributingIndicationCount: 1,
    },
    correctionRequired: true,
  } as InvestmentAggregateReconciliationPreview;
}

type ContextOptions = Readonly<{
  actor?: ApplicationRouteContext["actor"];
  isOwner?: boolean;
}>;

function context(
  request: Request,
  options: ContextOptions = {},
): ApplicationRouteContext {
  const actor = options.actor === undefined ? ownerActor() : options.actor;
  return {
    request,
    url: new URL(request.url),
    resourceUrl: request.url,
    actor,
    isOwner: options.isOwner ?? actor?.userId === OWNER_SUBJECT,
    participantAccess: null,
    campaign: null,
    renderApplication: async () => new Response("application fallback"),
  };
}

function ownerActor() {
  return {
    userId: OWNER_SUBJECT,
    email: "owner@example.invalid",
    displayName: "Configured Owner",
  };
}

function participantActor() {
  return {
    userId: "issuer.invalid/subject:participant",
    email: "participant@example.invalid",
    displayName: "Participant",
  };
}

async function requiredResponse(response: Response | null): Promise<Response> {
  assert.notEqual(response, null);
  return response as Response;
}
