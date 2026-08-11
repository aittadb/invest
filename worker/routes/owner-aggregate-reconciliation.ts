import { chatGPTSignInPath } from "../../domain/auth-navigation.ts";
import { parseMinorUnits } from "../../domain/foundation.ts";
import {
  createOwnerAggregateReconciliationResource,
  ownerAggregateCorrectionAvailable,
  type AggregateCorrectionConsistency,
  type OwnerAggregateReconciliationResource,
} from "../../domain/owner-aggregate-reconciliation-resource.ts";
import {
  INVESTOR_APP_API_VERSION,
} from "../../domain/public-campaign-resource.ts";
import {
  previewInvestmentAggregateReconciliation,
  APPLY_CALCULATED_AGGREGATE_CONFIRMATION,
  type InvestmentAggregateCorrectionConfirmation,
  type InvestmentAggregateCorrectionTerminalReplay,
  type InvestmentAggregateReconciliationPreview,
} from "../../domain/investment-aggregate.ts";
import {
  parseStorageOperationId,
  StorageFailure,
  type StorageOperationId,
} from "../../domain/storage-adapter.ts";
import { negotiateRepresentation } from "../../http/content-negotiation.ts";
import type {
  BrowserMutationProof,
} from "../../http/browser-mutation-session.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  MutationSecurityFailure,
  toPublicMutationSecurityFailure,
  type MutationMediaType,
  type VerifiedMutationRequest,
} from "../../http/mutation-security.ts";
import type {
  CampaignRevisionBoundAggregateCorrectionRepository,
  InvestmentAggregateRepository,
} from "../../repositories/in-memory-aggregate-repository.ts";
import type { ApplicationRouteHandler } from "../contracts.ts";
import {
  hypermediaResponse,
  notAcceptableResponse,
} from "./responses.ts";

const RECONCILIATION_PATH = "/owner/aggregate-reconciliation";
const CORRECTION_REPLAY_SCOPE_PREFIX =
  "owner-aggregate-correction-replay:v1";
const MUTATION_KEYS = new Set([
  "operation-id",
  "expected-campaign-revision",
  "confirmation",
  "expected-stored-revision",
  "expected-stored-amount",
  "expected-stored-count",
  "expected-calculated-amount",
  "expected-calculated-count",
]);

/** Eight correction fields plus the form-only CSRF field, all short scalars. */
export const MAX_OWNER_AGGREGATE_RECONCILIATION_MUTATION_BYTES = 4_096;
export const MAX_OWNER_AGGREGATE_RECONCILIATION_JSON_FIELDS = MUTATION_KEYS.size;
export const MAX_OWNER_AGGREGATE_RECONCILIATION_FORM_FIELDS =
  MUTATION_KEYS.size + 1;

export function ownerAggregateReconciliationMutationFieldLimit(
  request: Request,
): number {
  const contentType = request.headers.get("content-type");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/x-www-form-urlencoded"
    ? MAX_OWNER_AGGREGATE_RECONCILIATION_FORM_FIELDS
    : MAX_OWNER_AGGREGATE_RECONCILIATION_JSON_FIELDS;
}

export function isExactOwnerAggregateReconciliationMutation(
  request: VerifiedMutationRequest,
): boolean {
  const keys = Object.keys(request.body);
  return request.method === "POST" &&
    keys.length === MUTATION_KEYS.size &&
    keys.every((key) => MUTATION_KEYS.has(key));
}

export function ownerAggregateCorrectionReplayScopeFor(
  request: VerifiedMutationRequest,
): string | null {
  try {
    if (request.method !== "POST") return null;
    return ownerAggregateCorrectionReplayScope(parseCorrectionMutation(
      request.body,
      request.mediaType,
    ));
  } catch {
    return null;
  }
}

export function ownerAggregateCorrectionReplayScope(
  replay: InvestmentAggregateCorrectionTerminalReplay,
): string {
  try {
    const parsed = parseCorrectionMutation(
      terminalReplayBody(replay),
      "application/json",
    );
    return JSON.stringify([
      CORRECTION_REPLAY_SCOPE_PREFIX,
      "POST",
      RECONCILIATION_PATH,
      parsed.operationId,
      parsed.expectedCampaignRevision,
      parsed.confirmation.confirmation,
      parsed.confirmation.expectedStoredRevision,
      parsed.confirmation.expectedStoredAmount,
      parsed.confirmation.expectedStoredContributingIndicationCount,
      parsed.confirmation.expectedCalculatedAmount,
      parsed.confirmation.expectedCalculatedContributingIndicationCount,
    ]);
  } catch {
    throw new MutationSecurityFailure("SERVICE_UNAVAILABLE");
  }
}

type OwnerAggregateReconciliationMutationVerifier = (
  request: Request,
) => Promise<
  VerifiedMutationRequest & Readonly<{ clearCookie?: string }>
>;

export type ReadOnlyAggregateReconciliationRepository = Pick<
  InvestmentAggregateRepository,
  "previewReconciliation"
> & Readonly<{ correctionConsistency: "unavailable" }>;

export type OwnerAggregateReconciliationRepository =
  | CampaignRevisionBoundAggregateCorrectionRepository
  | ReadOnlyAggregateReconciliationRepository;

export type OwnerAggregateReconciliationRouteOptions = Readonly<{
  repository: OwnerAggregateReconciliationRepository;
  guardMutation: OwnerAggregateReconciliationMutationVerifier;
  csrfToken: (
    request: Request,
    exactReplayScope: string | null,
  ) => Promise<string | BrowserMutationProof | null>;
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
      return notAcceptableResponse(context.resourceUrl);
    }
    if (context.actor === null) {
      return authenticationRequiredResponse(
        representation.kind,
        context.resourceUrl,
      );
    }
    if (!context.isOwner) {
      return errorResponse(
        representation.kind,
        context.resourceUrl,
        404,
        "not_found",
        "The requested resource was not found.",
      );
    }
    if (context.request.method !== "GET" && context.request.method !== "POST") {
      return errorResponse(
        representation.kind,
        context.resourceUrl,
        405,
        "method_not_allowed",
        "This resource supports GET and POST.",
      );
    }

    let clearCookie: string | null = null;
    let preview: InvestmentAggregateReconciliationPreview | null = null;
    let terminalReplay: InvestmentAggregateCorrectionTerminalReplay | null =
      null;
    try {
      if (context.request.method === "POST") {
        if (options.repository.correctionConsistency !==
          "atomic-aggregate-audit") {
          return errorResponse(
            representation.kind,
            context.resourceUrl,
            503,
            "consistency_unavailable",
            "Aggregate correction is temporarily unavailable.",
          );
        }
        const verified = await options.guardMutation(context.request);
        if (
          Object.hasOwn(verified, "clearCookie") &&
          !validSetCookie(verified.clearCookie)
        ) {
          throw new StorageFailure("UNAVAILABLE");
        }
        clearCookie = validSetCookie(verified.clearCookie)
          ? verified.clearCookie
          : null;
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
        const correction = await options.repository
          .applyConfirmedCorrectionWithAudit({
            operationId: mutation.operationId,
            expectedCampaignRevision: mutation.expectedCampaignRevision,
            confirmation: mutation.confirmation,
            ownerSubject: verified.actor.subject,
            occurredAt: currentTimestamp(now),
          });
        if (correction.replayed) {
          const current = await options.repository.previewReconciliationState();
          preview = current.preview;
          terminalReplay = current.terminalReplay;
        } else {
          try {
            preview = previewInvestmentAggregateReconciliation(
              correction.stored,
              correction.preview.calculated,
            );
          } catch {
            throw new StorageFailure("UNAVAILABLE");
          }
          if (preview.correctionRequired) {
            throw new StorageFailure("UNAVAILABLE");
          }
          terminalReplay = terminalReplayFromMutation(mutation);
        }
      }

      const consistency = options.repository.correctionConsistency satisfies
        AggregateCorrectionConsistency;
      const campaignRevision =
        options.repository.correctionConsistency === "atomic-aggregate-audit"
          ? options.repository.campaignRevision
          : null;
      if (preview === null) {
        if (options.repository.correctionConsistency ===
          "atomic-aggregate-audit") {
          const state = await options.repository.previewReconciliationState();
          preview = state.preview;
          terminalReplay = state.terminalReplay;
        } else {
          preview = await options.repository.previewReconciliation();
        }
      }
      const operationId = ownerAggregateCorrectionAvailable(
          preview,
          consistency,
          campaignRevision,
        )
        ? requiredOperationId(issueOperationId())
        : null;
      const resource = createOwnerAggregateReconciliationResource(
        context.resourceUrl,
        preview,
        consistency,
        campaignRevision,
        operationId,
        terminalReplay,
      );
      const csrf = resource.correctionForm === null
        ? null
        : requiredCsrfProof(await options.csrfToken(
            context.request,
            terminalReplay === null
              ? null
              : ownerAggregateCorrectionReplayScope(terminalReplay),
          ));
      const response = representation.kind === "hypermedia-json"
        ? hypermediaResponse(resource.document)
        : htmlResponse(renderResource(resource, csrf?.token ?? null));
      if (csrf !== null) {
        response.headers.set(MUTATION_CSRF_HEADER, csrf.token);
      }
      return withSetCookies(response, [clearCookie, csrf?.setCookie ?? null]);
    } catch (error) {
      if (error instanceof MutationSecurityFailure) {
        const failure = toPublicMutationSecurityFailure(error);
        return withSetCookie(errorResponse(
          representation.kind,
          context.resourceUrl,
          failure.status,
          failure.body.error.code.toLowerCase(),
          failure.body.error.message,
        ), clearCookie);
      }
      const storage = storageError(error);
      return withSetCookie(errorResponse(
        representation.kind,
        context.resourceUrl,
        storage.status,
        storage.code,
        storage.message,
      ), clearCookie);
    }
  };
}

type ParsedCorrectionMutation = Readonly<{
  operationId: StorageOperationId;
  expectedCampaignRevision: number;
  confirmation: InvestmentAggregateCorrectionConfirmation;
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
    expectedCampaignRevision: requiredPositiveInteger(
      body["expected-campaign-revision"],
      mediaType,
    ),
    confirmation: Object.freeze({
      confirmation: requiredConfirmation(body.confirmation),
      expectedStoredRevision: requiredInteger(
        body["expected-stored-revision"],
        mediaType,
      ),
      expectedStoredAmount: requiredMinorUnits(
        body["expected-stored-amount"],
        mediaType,
      ),
      expectedStoredContributingIndicationCount: requiredInteger(
        body["expected-stored-count"],
        mediaType,
      ),
      expectedCalculatedAmount: requiredMinorUnits(
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

function terminalReplayFromMutation(
  mutation: ParsedCorrectionMutation,
): InvestmentAggregateCorrectionTerminalReplay {
  return Object.freeze({
    operationId: mutation.operationId,
    expectedCampaignRevision: mutation.expectedCampaignRevision,
    confirmation: mutation.confirmation,
  });
}

function terminalReplayBody(
  replay: InvestmentAggregateCorrectionTerminalReplay,
): Readonly<Record<string, unknown>> {
  return {
    "operation-id": replay.operationId,
    "expected-campaign-revision": replay.expectedCampaignRevision,
    confirmation: replay.confirmation.confirmation,
    "expected-stored-revision": replay.confirmation.expectedStoredRevision,
    "expected-stored-amount": replay.confirmation.expectedStoredAmount,
    "expected-stored-count":
      replay.confirmation.expectedStoredContributingIndicationCount,
    "expected-calculated-amount": replay.confirmation.expectedCalculatedAmount,
    "expected-calculated-count":
      replay.confirmation.expectedCalculatedContributingIndicationCount,
  };
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

function requiredPositiveInteger(
  value: unknown,
  mediaType: MutationMediaType,
): number {
  const parsed = requiredInteger(value, mediaType);
  if (parsed < 1) throw new StorageFailure("INVALID_REQUEST");
  return parsed;
}

function requiredMinorUnits(
  value: unknown,
  mediaType: MutationMediaType,
) {
  const parsed = parseMinorUnits(requiredInteger(value, mediaType));
  if (!parsed.ok) throw new StorageFailure("INVALID_REQUEST");
  return parsed.value;
}

function requiredConfirmation(
  value: unknown,
): typeof APPLY_CALCULATED_AGGREGATE_CONFIRMATION {
  if (value !== APPLY_CALCULATED_AGGREGATE_CONFIRMATION) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return value;
}

function requiredOperationId(value: unknown): StorageOperationId {
  const parsed = parseStorageOperationId(value);
  if (!parsed.ok) throw new StorageFailure("INVALID_REQUEST");
  return parsed.value;
}

function validCsrfToken(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= 32 &&
    value.length <= 256 &&
    /^[A-Za-z0-9_-]+$/.test(value);
}

function requiredCsrfProof(
  value: string | BrowserMutationProof | null,
): Readonly<{ token: string; setCookie: string | null }> {
  if (typeof value === "string") {
    if (!validCsrfToken(value)) throw new StorageFailure("UNAVAILABLE");
    return Object.freeze({ token: value, setCookie: null });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !validCsrfToken(value.token) ||
    !validSetCookie(value.setCookie)
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return Object.freeze({ token: value.token, setCookie: value.setCookie });
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
      ? data.correction_consistency === "atomic-aggregate-audit"
        ? "<p>Correction is unavailable for this stored revision.</p>"
        : "<p>Correction is unavailable until atomic aggregate and audit storage is configured.</p>"
      : ""
    : renderCorrectionForm(resource.correctionForm, csrf);
  return page(
    "Aggregate reconciliation",
    `<main><p class="section-kicker">Owner workspace</p><h1>Aggregate reconciliation</h1><p>${escapeHtml(status)}</p><p>Campaign revision: ${data.campaign_revision === null ? "unavailable" : data.campaign_revision}</p><table><thead><tr><th scope="col">Source</th><th scope="col">Revision</th><th scope="col">Amount</th><th scope="col">Currency</th><th scope="col">Indications</th></tr></thead><tbody><tr><th scope="row">Stored</th><td>${data.stored.revision}</td><td>${data.stored.amount}</td><td>${escapeHtml(data.stored.currency)}</td><td>${data.stored.contributing_indication_count}</td></tr><tr><th scope="row">Calculated</th><td>-</td><td>${data.calculated.amount}</td><td>${escapeHtml(data.calculated.currency)}</td><td>${data.calculated.contributing_indication_count}</td></tr></tbody></table>${form}<p><a href="/owner">Back to owner workspace</a></p></main>`,
  );
}

function renderCorrectionForm(
  form: NonNullable<OwnerAggregateReconciliationResource["correctionForm"]>,
  csrf: string,
): string {
  const hidden = form.fields
    .filter((field) => field.presentation === "hidden")
    .map((field) =>
      `<input type="hidden" name="${escapeAttribute(field.name)}" value="${escapeAttribute(String(field.value ?? ""))}">`
    ).join("");
  const confirmation = form.fields.find((field) =>
    field.name === "confirmation" && field.presentation !== "hidden"
  );
  if (confirmation?.value !== APPLY_CALCULATED_AGGREGATE_CONFIRMATION) {
    throw new StorageFailure("UNAVAILABLE");
  }
  const confirmationLabel = confirmation.choices?.find((choice) =>
    choice.value === APPLY_CALCULATED_AGGREGATE_CONFIRMATION
  )?.label;
  if (confirmationLabel === undefined) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return `<form action="${escapeAttribute(form.action)}" method="post" data-action-name="${escapeAttribute(form.name)}"><input type="hidden" name="${MUTATION_CSRF_FIELD}" value="${escapeAttribute(csrf)}">${hidden}<label><input type="checkbox" name="confirmation" value="${APPLY_CALCULATED_AGGREGATE_CONFIRMATION}" required> ${escapeHtml(confirmationLabel)}</label><button type="submit">${escapeHtml(form.title)}</button></form>`;
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

function validSetCookie(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !/[\r\n]/u.test(value);
}

function withSetCookie(response: Response, cookie: string | null): Response {
  return withSetCookies(response, [cookie]);
}

function withSetCookies(
  response: Response,
  cookies: readonly (string | null)[],
): Response {
  const selected = cookies.filter(validSetCookie);
  if (selected.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const cookie of selected) headers.append("Set-Cookie", cookie);
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
