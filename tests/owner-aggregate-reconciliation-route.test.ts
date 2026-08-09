import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLY_CALCULATED_AGGREGATE_CONFIRMATION,
  type InvestmentAggregateReconciliationPreview,
} from "../domain/investment-aggregate.ts";
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
  AtomicInvestmentAggregateCorrectionRepository,
} from "../repositories/in-memory-aggregate-repository.ts";
import type { ApplicationRouteContext } from "../worker/contracts.ts";
import { createOwnerAggregateReconciliationRouteHandler } from "../worker/routes/owner-aggregate-reconciliation.ts";
import { createOwnerRouteHandler } from "../worker/routes/owner.ts";

const ORIGIN = "https://invest.example";
const PATH = "/owner/aggregate-reconciliation";
const OWNER_SUBJECT = "issuer.invalid/subject:owner";
const CSRF_TOKEN = "owner_reconciliation_csrf_token_1234567890";
const OPERATION_ID = "aggregate-correction:test-operation";
const OCCURRED_AT = "2026-08-09T12:00:00.000Z";

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
      correction_available: boolean;
      stored: { amount: number };
      calculated: { amount: number };
    };
    actions: Array<{
      name: string;
      method: string;
      fields: Array<{ name: string; value?: string | number }>;
    }>;
  };
  assert.equal(document.type, "owner-aggregate-reconciliation");
  assert.equal(document.data.status, "mismatch");
  assert.equal(document.data.correction_available, true);
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

  const html = await requiredResponse(await handler(context(new Request(
    `${ORIGIN}${PATH}`,
    { headers: { Accept: "text/html" } },
  ))));
  const body = await html.text();
  assert.equal(html.status, 200);
  assert.equal(html.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  assert.match(body, /Stored and calculated totals differ/);
  assert.match(body, /name="operation-id" value="aggregate-correction:test-operation"/);
  assert.match(body, new RegExp(`name="${MUTATION_CSRF_FIELD}"`));
  assert.match(body, /Apply the calculated totals shown above/);
  assert.match(body, /<button type="submit">Apply calculated totals<\/button>/);

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
    const handler = createOwnerAggregateReconciliationRouteHandler({
      repository,
      guardMutation: await mutationGuard(),
      csrfToken: async () => CSRF_TOKEN,
      issueOperationId: () => "aggregate-correction:next-operation",
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
    assert.equal(responseBody.includes("apply-calculated-aggregate"), false);
    assert.equal(repository.applyCalls.length, 1);
    assert.deepEqual(repository.applyCalls[0], {
      operationId: OPERATION_ID,
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

test("correction is absent and POST fails closed without atomic consistency", async () => {
  let guardCalls = 0;
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
    issueOperationId: () => OPERATION_ID,
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
implements AtomicInvestmentAggregateCorrectionRepository {
  readonly correctionConsistency = "atomic-aggregate-audit" as const;
  previewCalls = 0;
  applyCalls: ApplyAuditedAggregateCorrectionRequest[] = [];
  failure: StorageFailure | null = null;
  #preview: InvestmentAggregateReconciliationPreview;

  constructor(preview: InvestmentAggregateReconciliationPreview) {
    this.#preview = preview;
  }

  async previewReconciliation(): Promise<InvestmentAggregateReconciliationPreview> {
    this.previewCalls += 1;
    return this.#preview;
  }

  async applyConfirmedCorrectionWithAudit(
    request: ApplyAuditedAggregateCorrectionRequest,
  ): Promise<ApplyAuditedAggregateCorrectionResult> {
    if (this.failure) throw this.failure;
    this.applyCalls.push(request);
    const previous = this.#preview;
    this.#preview = matchingPreview();
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
    confirmation: APPLY_CALCULATED_AGGREGATE_CONFIRMATION,
    "expected-stored-revision": 1,
    "expected-stored-amount": 8_000,
    "expected-stored-count": 1,
    "expected-calculated-amount": 10_000,
    "expected-calculated-count": 1,
  };
}

function correctionFieldNames(): readonly string[] {
  return [
    "operation-id",
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
    actor,
    isOwner: options.isOwner ?? actor?.userId === OWNER_SUBJECT,
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
