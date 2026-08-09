import { chatGPTSignInPath } from "../../domain/auth-navigation.ts";
import {
  createOwnerAggregateReconciliationResource,
  type AggregateCorrectionConsistency,
  type OwnerAggregateReconciliationResource,
} from "../../domain/owner-aggregate-reconciliation-resource.ts";
import {
  INVESTOR_APP_API_VERSION,
} from "../../domain/public-campaign-resource.ts";
import { parseStorageOperationId, StorageFailure } from "../../domain/storage-adapter.ts";
import { negotiateRepresentation } from "../../http/content-negotiation.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  MutationSecurityFailure,
  toPublicMutationSecurityFailure,
  type BrowserMutationGuard,
  type MutationMediaType,
} from "../../http/mutation-security.ts";
import type {
  AtomicInvestmentAggregateCorrectionRepository,
  InvestmentAggregateRepository,
} from "../../repositories/in-memory-aggregate-repository.ts";
import type { ApplicationRouteHandler } from "../contracts.ts";
import {
  hypermediaResponse,
  notAcceptableResponse,
} from "./responses.ts";

const RECONCILIATION_PATH = "/owner/aggregate-reconciliation";
const MUTATION_KEYS = new Set([
  "operation-id",
  "confirmation",
  "expected-stored-revision",
  "expected-stored-amount",
  "expected-stored-count",
  "expected-calculated-amount",
  "expected-calculated-count",
]);

export type ReadOnlyAggregateReconciliationRepository = Pick<
  InvestmentAggregateRepository,
  "previewReconciliation"
> & Readonly<{ correctionConsistency: "unavailable" }>;

export type OwnerAggregateReconciliationRepository =
  | AtomicInvestmentAggregateCorrectionRepository
  | ReadOnlyAggregateReconciliationRepository;

export type OwnerAggregateReconciliationRouteOptions = Readonly<{
  repository: OwnerAggregateReconciliationRepository;
  guardMutation: BrowserMutationGuard;
  csrfToken: (request: Request) => Promise<string>;
  issueOperationId?: () => string;
  now?: () => Date;
}>;

export function createOwnerAggregateReconciliationRouteHandler(
  options: OwnerAggregateReconciliationRouteOptions,
): ApplicationRouteHandler {
  const issueOperationId = options.issueOperationId ?? defaultOperationId;
  const now = options.now ?? (() => new Date());

  return async (context) => {
    if (context.url.pathname !== RECONCILIATION_PATH) return null;
    const representation = negotiateRepresentation(
      context.request.headers.get("accept"),
    );
    if (representation.kind === "not-acceptable") {
      return notAcceptableResponse(context.request.url);
    }
    if (context.request.method !== "GET" && context.request.method !== "POST") {
      return errorResponse(
        representation.kind,
        context.request.url,
        405,
        "method_not_allowed",
        "This resource supports GET and POST.",
      );
    }
    if (context.actor === null) {
      return authenticationRequiredResponse(
        representation.kind,
        context.request.url,
      );
    }
    if (!context.isOwner) {
      return errorResponse(
        representation.kind,
        context.request.url,
        404,
        "not_found",
        "The requested resource was not found.",
      );
    }

    try {
      if (context.request.method === "POST") {
        if (options.repository.correctionConsistency !==
          "atomic-aggregate-audit") {
          return errorResponse(
            representation.kind,
            context.request.url,
            503,
            "consistency_unavailable",
            "Aggregate correction is temporarily unavailable.",
          );
        }
        const verified = await options.guardMutation(context.request);
        if (
          verified.method !== "POST" ||
          verified.actor.type !== "owner" ||
          verified.actor.subject !== context.actor.userId
        ) {
          throw new MutationSecurityFailure("REQUEST_REJECTED");
        }
        const mutation = parseCorrectionMutation(
          verified.body,
          verified.mediaType,
        );
        await options.repository.applyConfirmedCorrectionWithAudit({
          operationId: mutation.operationId,
          confirmation: mutation.confirmation,
          ownerSubject: verified.actor.subject,
          occurredAt: currentTimestamp(now),
        });
      }

      const preview = await options.repository.previewReconciliation();
      const operationId = requiredOperationId(issueOperationId());
      const consistency = options.repository.correctionConsistency satisfies
        AggregateCorrectionConsistency;
      const resource = createOwnerAggregateReconciliationResource(
        context.request.url,
        preview,
        consistency,
        operationId,
      );
      const csrf = resource.correctionForm === null
        ? null
        : requiredCsrfToken(await options.csrfToken(context.request));
      const response = representation.kind === "hypermedia-json"
        ? hypermediaResponse(resource.document)
        : htmlResponse(renderResource(resource, csrf));
      return csrf === null ? response : withCsrfToken(response, csrf);
    } catch (error) {
      if (error instanceof MutationSecurityFailure) {
        const failure = toPublicMutationSecurityFailure(error);
        return errorResponse(
          representation.kind,
          context.request.url,
          failure.status,
          failure.body.error.code.toLowerCase(),
          failure.body.error.message,
        );
      }
      const storage = storageError(error);
      return errorResponse(
        representation.kind,
        context.request.url,
        storage.status,
        storage.code,
        storage.message,
      );
    }
  };
}

type ParsedCorrectionMutation = Readonly<{
  operationId: string;
  confirmation: Readonly<{
    confirmation: string;
    expectedStoredRevision: number;
    expectedStoredAmount: number;
    expectedStoredContributingIndicationCount: number;
    expectedCalculatedAmount: number;
    expectedCalculatedContributingIndicationCount: number;
  }>;
}>;

function parseCorrectionMutation(
  body: Readonly<Record<string, unknown>>,
  mediaType: MutationMediaType,
): ParsedCorrectionMutation {
  const keys = Object.keys(body);
  if (keys.length !== MUTATION_KEYS.size ||
    keys.some((key) => !MUTATION_KEYS.has(key))) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return Object.freeze({
    operationId: requiredOperationId(body["operation-id"]),
    confirmation: Object.freeze({
      confirmation: requiredString(body.confirmation),
      expectedStoredRevision: requiredInteger(
        body["expected-stored-revision"],
        mediaType,
      ),
      expectedStoredAmount: requiredInteger(
        body["expected-stored-amount"],
        mediaType,
      ),
      expectedStoredContributingIndicationCount: requiredInteger(
        body["expected-stored-count"],
        mediaType,
      ),
      expectedCalculatedAmount: requiredInteger(
        body["expected-calculated-amount"],
        mediaType,
      ),
      expectedCalculatedContributingIndicationCount: requiredInteger(
        body["expected-calculated-count"],
        mediaType,
      ),
    }),
  });
}

function requiredInteger(value: unknown, mediaType: MutationMediaType): number {
  const parsed = mediaType === "application/x-www-form-urlencoded"
    ? typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : Number.NaN
    : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return parsed as number;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return value;
}

function requiredOperationId(value: unknown): string {
  const parsed = parseStorageOperationId(value);
  if (!parsed.ok) throw new StorageFailure("INVALID_REQUEST");
  return parsed.value;
}

function requiredCsrfToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return value;
}

function currentTimestamp(now: () => Date): string {
  let value: Date;
  try {
    value = now();
  } catch {
    throw new StorageFailure("UNAVAILABLE");
  }
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return value.toISOString();
}

function defaultOperationId(): string {
  try {
    return `aggregate-correction:${crypto.randomUUID()}`;
  } catch {
    throw new StorageFailure("UNAVAILABLE");
  }
}

function renderResource(
  resource: OwnerAggregateReconciliationResource,
  csrf: string | null,
): string {
  const data = resource.document.data;
  const status = data.status === "match"
    ? "Stored and calculated totals match."
    : "Stored and calculated totals differ.";
  const form = resource.correctionForm === null || csrf === null
    ? data.correction_required
      ? "<p>Correction is unavailable until atomic aggregate and audit storage is configured.</p>"
      : ""
    : renderCorrectionForm(resource.correctionForm, csrf);
  return page(
    "Aggregate reconciliation",
    `<main><p class="section-kicker">Owner workspace</p><h1>Aggregate reconciliation</h1><p>${escapeHtml(status)}</p><table><thead><tr><th scope="col">Source</th><th scope="col">Amount</th><th scope="col">Currency</th><th scope="col">Indications</th></tr></thead><tbody><tr><th scope="row">Stored</th><td>${data.stored.amount}</td><td>${escapeHtml(data.stored.currency)}</td><td>${data.stored.contributing_indication_count}</td></tr><tr><th scope="row">Calculated</th><td>${data.calculated.amount}</td><td>${escapeHtml(data.calculated.currency)}</td><td>${data.calculated.contributing_indication_count}</td></tr></tbody></table>${form}<p><a href="/owner">Back to owner workspace</a></p></main>`,
  );
}

function renderCorrectionForm(
  form: NonNullable<OwnerAggregateReconciliationResource["correctionForm"]>,
  csrf: string,
): string {
  const values = new Map(form.fields.map((field) => [field.name, field.value]));
  const hidden = [...values.entries()]
    .filter(([name]) => name !== "confirmation")
    .map(([name, value]) =>
      `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(String(value ?? ""))}">`
    ).join("");
  return `<form action="${escapeAttribute(form.action)}" method="post"><input type="hidden" name="${MUTATION_CSRF_FIELD}" value="${escapeAttribute(csrf)}">${hidden}<label><input type="checkbox" name="confirmation" value="apply-calculated-aggregate" required> Apply the calculated totals shown above</label><button type="submit">Apply calculated totals</button></form>`;
}

function authenticationRequiredResponse(
  representation: "html" | "hypermedia-json",
  requestUrl: string,
): Response {
  const signIn = new URL(chatGPTSignInPath(RECONCILIATION_PATH), requestUrl);
  if (representation === "html") {
    return htmlResponse(
      page(
        "Sign in",
        `<main><h1>Sign in to continue</h1><p><a href="${escapeAttribute(signIn.href)}">Sign in</a></p></main>`,
      ),
      401,
    );
  }
  return hypermediaResponse({
    api_version: INVESTOR_APP_API_VERSION,
    type: "error",
    id: "authentication-required",
    data: {
      code: "authentication_required",
      message: "Sign in is required to continue.",
    },
    links: [{ rel: ["self"], href: new URL(requestUrl).href }],
    actions: [{
      name: "sign-in",
      title: "Sign in",
      href: signIn.href,
      method: "GET",
      type: "text/html",
      fields: [],
    }],
  }, 401);
}

function storageError(error: unknown): Readonly<{
  status: number;
  code: string;
  message: string;
}> {
  const code = error instanceof StorageFailure ? error.code : "UNAVAILABLE";
  switch (code) {
    case "INVALID_REQUEST":
      return { status: 400, code: "invalid_request", message: "The request is invalid." };
    case "CONFLICT":
      return { status: 409, code: "conflict", message: "The request conflicts with existing work." };
    case "PRECONDITION_FAILED":
      return { status: 412, code: "precondition_failed", message: "The aggregate has changed. Review it again." };
    case "NOT_FOUND":
      return { status: 404, code: "not_found", message: "The requested resource was not found." };
    default:
      return { status: 503, code: "temporarily_unavailable", message: "This resource is temporarily unavailable." };
  }
}

function errorResponse(
  representation: "html" | "hypermedia-json",
  requestUrl: string,
  status: number,
  code: string,
  message: string,
): Response {
  if (representation === "html") {
    return htmlResponse(
      page("Aggregate reconciliation", `<main><h1>${escapeHtml(message)}</h1></main>`),
      status,
    );
  }
  return hypermediaResponse({
    api_version: INVESTOR_APP_API_VERSION,
    type: "error",
    id: code,
    data: { code, message },
    links: [{ rel: ["self"], href: new URL(requestUrl).href }],
    actions: [],
  }, status);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body class="owner-page">${body}</body></html>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      Vary: "Accept",
    },
  });
}

function withCsrfToken(response: Response, token: string): Response {
  const headers = new Headers(response.headers);
  headers.set(MUTATION_CSRF_HEADER, token);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
