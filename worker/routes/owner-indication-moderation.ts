import { chatGPTSignInPath } from "../../domain/auth-navigation.ts";
import {
  parseTimestamp,
  type Timestamp,
} from "../../domain/foundation.ts";
import type { HtmlFormAction } from "../../domain/hypermedia-action.ts";
import {
  projectInvestmentIndicationForAggregation,
} from "../../domain/investment-aggregate.ts";
import {
  OWNER_INDICATIONS_PATH,
  createOwnerIndicationCollectionDocument,
  createOwnerIndicationDetailResource,
  type OwnerIndicationCollectionDocument,
  type OwnerIndicationDetailResource,
  type OwnerIndicationOperationIdIssuer,
} from "../../domain/owner-indication-moderation-resource.ts";
import {
  INVESTMENT_INDICATION_LIMITS,
} from "../../domain/investment-indication.ts";
import { INVESTOR_APP_API_VERSION } from "../../domain/public-campaign-resource.ts";
import {
  StorageFailure,
  parseStorageOperationId,
  type StorageCursor,
  type StorageOperationId,
} from "../../domain/storage-adapter.ts";
import { negotiateRepresentation } from "../../http/content-negotiation.ts";
import {
  MUTATION_CSRF_HEADER,
  MutationSecurityFailure,
  toPublicMutationSecurityFailure,
  type BrowserMutationGuard,
  type MutationMediaType,
} from "../../http/mutation-security.ts";
import type {
  AtomicOwnerIndicationModerationRepository,
  RejectIndicationWithEffectsResult,
} from "../../services/owner-indication-moderation.ts";
import type {
  ApplicationRouteContext,
  ApplicationRouteHandler,
} from "../contracts.ts";
import {
  hypermediaResponse,
  notAcceptableResponse,
} from "./responses.ts";

const DEFAULT_PAGE_SIZE = 25;
const MUTATION_FIELDS = new Set([
  "operation-id",
  "expected-revision",
  "reason",
]);

type Representation = "html" | "hypermedia-json";
type ModerationRoute =
  | Readonly<{ kind: "collection" }>
  | Readonly<{ kind: "detail"; reviewId: string }>;

export type OwnerIndicationModerationRouteDependencies = Readonly<{
  repository: AtomicOwnerIndicationModerationRepository;
  verifyMutation: BrowserMutationGuard;
  csrfToken: (request: Request) => Promise<string | null>;
  issueOperationId: OwnerIndicationOperationIdIssuer;
  now?: () => Date;
}>;

export function createOwnerIndicationModerationRouteHandler(
  dependencies: OwnerIndicationModerationRouteDependencies,
): ApplicationRouteHandler {
  const issueOperationId = checkedOperationIssuer(
    dependencies.issueOperationId,
  );
  const now = dependencies.now ?? (() => new Date());

  return async (context) => {
    const route = parseRoute(context.url);
    if (route === null) return null;
    const negotiated = negotiateRepresentation(
      context.request.headers.get("accept"),
    );
    if (negotiated.kind === "not-acceptable") {
      return notAcceptableResponse(context.resourceUrl);
    }
    const representation = negotiated.kind;
    if (context.actor === null) {
      return authenticationRequiredResponse(
        representation,
        context.resourceUrl,
      );
    }
    if (!context.isOwner) {
      return errorResponse(
        representation,
        context.resourceUrl,
        404,
        "not_found",
        "The requested resource was not found.",
      );
    }

    try {
      if (context.request.method === "GET") {
        if (route.kind === "collection") {
          const request = parsePageRequest(context.url);
          const document = createOwnerIndicationCollectionDocument(
            context.resourceUrl,
            await dependencies.repository.list(request),
            request.limit,
          );
          return representation === "hypermedia-json"
            ? hypermediaResponse(document)
            : htmlResponse(renderCollection(document));
        }

        assertNoQuery(context.url);
        const item = await dependencies.repository.get(route.reviewId);
        if (item === null) throw new StorageFailure("NOT_FOUND");
        const resource = createOwnerIndicationDetailResource(
          context.resourceUrl,
          item,
          hasAtomicConsistency(dependencies.repository),
          issueOperationId,
        );
        return detailResponse(
          context,
          representation,
          resource,
          dependencies.csrfToken,
        );
      }

      if (context.request.method !== "POST" || route.kind !== "detail") {
        return methodNotAllowedResponse(representation, context.resourceUrl);
      }
      if (!hasAtomicConsistency(dependencies.repository)) {
        throw new StorageFailure("UNAVAILABLE");
      }
      assertNoQuery(context.url);
      const verified = await dependencies.verifyMutation(context.request);
      if (
        verified.method !== "POST" ||
        verified.actor.type !== "owner" ||
        verified.actor.subject !== context.actor.userId
      ) {
        throw new MutationSecurityFailure("REQUEST_REJECTED");
      }
      const mutation = parseMutation(verified.body, verified.mediaType);
      const occurredAt = currentTimestamp(now);
      const result = await dependencies.repository.rejectWithEffects({
        reviewId: route.reviewId,
        operationId: mutation.operationId,
        expectedRevision: mutation.expectedRevision,
        reason: mutation.reason,
        ownerSubject: verified.actor.subject,
        occurredAt,
      });
      verifyModerationResult(
        result,
        route.reviewId,
        verified.actor.subject,
        mutation.operationId,
        mutation.expectedRevision,
        mutation.reason,
        occurredAt,
      );
      const detailUrl = new URL(
        `${OWNER_INDICATIONS_PATH}/${encodeURIComponent(route.reviewId)}`,
        context.resourceUrl,
      ).href;
      if (representation === "html") {
        return new Response(null, {
          status: 303,
          headers: {
            "Cache-Control": "no-store",
            Location: detailUrl,
            Vary: "Accept",
          },
        });
      }
      const resource = createOwnerIndicationDetailResource(
        detailUrl,
        result.item,
        true,
        issueOperationId,
      );
      return detailResponse(
        { ...context, resourceUrl: detailUrl },
        representation,
        resource,
        dependencies.csrfToken,
      );
    } catch (error) {
      return mappedFailureResponse(
        representation,
        context.resourceUrl,
        error,
      );
    }
  };
}

async function detailResponse(
  context: ApplicationRouteContext,
  representation: Representation,
  resource: OwnerIndicationDetailResource,
  csrfProvider: OwnerIndicationModerationRouteDependencies["csrfToken"],
): Promise<Response> {
  const token = resource.reject === null
    ? null
    : requiredCsrfToken(await csrfProvider(context.request));
  const response = representation === "hypermedia-json"
    ? hypermediaResponse(resource.document)
    : htmlResponse(renderDetail(resource, token));
  return token === null ? response : withCsrfToken(response, token);
}

function parseRoute(url: URL): ModerationRoute | null {
  if (url.pathname === OWNER_INDICATIONS_PATH) return { kind: "collection" };
  const prefix = `${OWNER_INDICATIONS_PATH}/`;
  if (!url.pathname.startsWith(prefix)) return null;
  const encoded = url.pathname.slice(prefix.length);
  if (encoded.length === 0 || encoded.includes("/") || encoded.length > 384) {
    return null;
  }
  try {
    return { kind: "detail", reviewId: decodeURIComponent(encoded) };
  } catch {
    return { kind: "detail", reviewId: "invalid" };
  }
}

function parsePageRequest(
  url: URL,
): Readonly<{ limit: number; cursor?: StorageCursor }> {
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "page_size" && key !== "cursor")) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  const sizes = url.searchParams.getAll("page_size");
  const cursors = url.searchParams.getAll("cursor");
  if (sizes.length > 1 || cursors.length > 1) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  const serialized = sizes[0];
  const limit = serialized === undefined ? DEFAULT_PAGE_SIZE : Number(serialized);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (serialized !== undefined && String(limit) !== serialized)
  ) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  const cursor = cursors[0];
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 512)) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return {
    limit,
    ...(cursor === undefined ? {} : { cursor: cursor as StorageCursor }),
  };
}

function assertNoQuery(url: URL): void {
  if ([...url.searchParams].length !== 0) {
    throw new StorageFailure("INVALID_REQUEST");
  }
}

function parseMutation(
  body: Readonly<Record<string, unknown>>,
  mediaType: MutationMediaType,
): Readonly<{
  operationId: StorageOperationId;
  expectedRevision: number;
  reason: string;
}> {
  const keys = Object.keys(body);
  if (
    keys.length !== MUTATION_FIELDS.size ||
    keys.some((key) => !MUTATION_FIELDS.has(key))
  ) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  const operationId = parseStorageOperationId(body["operation-id"]);
  if (!operationId.ok) throw new StorageFailure("INVALID_REQUEST");
  const candidate = mediaType === "application/x-www-form-urlencoded"
    ? typeof body["expected-revision"] === "string" &&
        /^[1-9]\d*$/.test(body["expected-revision"])
      ? Number(body["expected-revision"])
      : Number.NaN
    : body["expected-revision"];
  if (
    !Number.isSafeInteger(candidate) ||
    (candidate as number) < 1 ||
    (candidate as number) >= Number.MAX_SAFE_INTEGER
  ) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  const reason = typeof body.reason === "string"
    ? body.reason.replace(/\r\n?/gu, "\n").trim()
    : body.reason;
  if (
    typeof reason !== "string" ||
    reason.length < 1 ||
    reason.length > INVESTMENT_INDICATION_LIMITS.rejectionReasonLength ||
    hasUnsafeMultilineCharacter(reason)
  ) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return Object.freeze({
    operationId: operationId.value,
    expectedRevision: candidate as number,
    reason,
  });
}

function verifyModerationResult(
  result: RejectIndicationWithEffectsResult,
  reviewId: string,
  ownerSubject: string,
  operationId: StorageOperationId,
  expectedRevision: number,
  reason: string,
  requestedAt: Timestamp,
): void {
  const indication = result.item.indication;
  const projected = projectInvestmentIndicationForAggregation(indication);
  const notification = result.notification.record.template;
  const detail = result.auditEvent.detail;
  const rejection = indication.lifecycle.rejection;
  const history = indication.history.at(-1);
  if (
    result.item.reviewId !== reviewId ||
    indication.lifecycle.status !== "rejected" ||
    indication.revision !== expectedRevision + 1 ||
    rejection.reason !== reason ||
    history?.transition !== "rejected" ||
    history.revision !== indication.revision ||
    history.occurredAt !== rejection.rejectedAt ||
    result.item.notification?.record.template.id !== notification.id ||
    result.aggregate.contribution.indicationId !== projected.indicationId ||
    result.aggregate.contribution.indicationRevision !==
      projected.indicationRevision ||
    result.aggregate.contribution.status !== "rejected" ||
    result.aggregate.contribution.amount !== projected.amount ||
    result.aggregate.contribution.currency !== projected.currency ||
    result.aggregate.stored.currency !== projected.currency ||
    !isStoredAggregateSnapshot(result.aggregate.stored) ||
    result.auditEvent.actor.type !== "owner" ||
    result.auditEvent.actor.subject !== ownerSubject ||
    String(result.auditEvent.operationId) !== String(operationId) ||
    detail.kind !== "resource-transition" ||
    detail.transition !== "rejected" ||
    detail.resource.type !== "investment-indication" ||
    String(detail.resource.id) !== String(indication.id) ||
    notification.recipientSubject !== indication.participantSubject ||
    notification.relatedResource.type !== "investment-indication" ||
    String(notification.relatedResource.id) !== String(indication.id) ||
    !sameNotificationSnapshot(result.item.notification, result.notification) ||
    notification.generatedAt !== rejection.rejectedAt ||
    result.auditEvent.occurredAt !== rejection.rejectedAt ||
    (!result.replayed && rejection.rejectedAt !== requestedAt) ||
    result.notification.record.copyEvidence.length !== 0 ||
    result.notification.record.sentMarker !== null ||
    notification.generatedBy.type !== "owner" ||
    notification.generatedBy.subject !== ownerSubject
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
}

function isStoredAggregateSnapshot(
  value: RejectIndicationWithEffectsResult["aggregate"]["stored"],
): boolean {
  return Number.isSafeInteger(value.revision) &&
    value.revision >= 1 &&
    Number.isSafeInteger(value.totalAmount) &&
    value.totalAmount >= 0 &&
    Number.isSafeInteger(value.contributingIndicationCount) &&
    value.contributingIndicationCount >= 0;
}

function hasAtomicConsistency(
  repository: AtomicOwnerIndicationModerationRepository,
): boolean {
  return repository.moderationConsistency ===
    "atomic-indication-aggregate-audit-notification";
}

function checkedOperationIssuer(
  issueOperationId: OwnerIndicationOperationIdIssuer,
): OwnerIndicationOperationIdIssuer {
  return () => {
    let value: unknown;
    try {
      value = issueOperationId();
    } catch {
      throw new StorageFailure("UNAVAILABLE");
    }
    const parsed = parseStorageOperationId(value);
    if (!parsed.ok) throw new StorageFailure("UNAVAILABLE");
    return parsed.value;
  };
}

function currentTimestamp(now: () => Date): Timestamp {
  let date: Date;
  try {
    date = now();
  } catch {
    throw new StorageFailure("UNAVAILABLE");
  }
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) {
    throw new StorageFailure("UNAVAILABLE");
  }
  const parsed = parseTimestamp(date.toISOString());
  if (!parsed.ok) throw new StorageFailure("UNAVAILABLE");
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

function hasUnsafeMultilineCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined) return true;
    if (code <= 31 || code === 127) {
      if (character === "\n" || character === "\t") continue;
      return true;
    }
    if (
      (code >= 0x061c && code <= 0x061c) ||
      (code >= 0x200e && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) return true;
  }
  return false;
}

function sameNotificationSnapshot(
  item: RejectIndicationWithEffectsResult["item"]["notification"],
  result: RejectIndicationWithEffectsResult["notification"],
): boolean {
  if (item === null || item.revision !== result.revision) return false;
  const left = item.record;
  const right = result.record;
  return left.template.id === right.template.id &&
    left.template.purposeId === right.template.purposeId &&
    left.template.recipientSubject === right.template.recipientSubject &&
    left.template.relatedResource.type === right.template.relatedResource.type &&
    left.template.relatedResource.id === right.template.relatedResource.id &&
    left.template.subjectLine === right.template.subjectLine &&
    left.template.body === right.template.body &&
    left.template.generatedAt === right.template.generatedAt &&
    left.template.generatedBy.type === right.template.generatedBy.type &&
    left.template.generatedBy.subject === right.template.generatedBy.subject &&
    left.copyEvidence.length === right.copyEvidence.length &&
    left.sentMarker === right.sentMarker;
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

function authenticationRequiredResponse(
  representation: Representation,
  requestUrl: string,
): Response {
  const signIn = new URL(
    chatGPTSignInPath(new URL(requestUrl).pathname),
    requestUrl,
  );
  if (representation === "html") {
    return htmlResponse(
      page(
        "Sign in",
        `<main class="moderation-main moderation-message"><p class="moderation-kicker">Owner review</p><h1>Sign in to continue</h1><a href="${escapeAttribute(signIn.href)}">Sign in</a></main>`,
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

function methodNotAllowedResponse(
  representation: Representation,
  requestUrl: string,
): Response {
  return errorResponse(
    representation,
    requestUrl,
    405,
    "method_not_allowed",
    "The request method is not allowed.",
  );
}

function mappedFailureResponse(
  representation: Representation,
  requestUrl: string,
  error: unknown,
): Response {
  if (error instanceof MutationSecurityFailure) {
    const failure = toPublicMutationSecurityFailure(error);
    return errorResponse(
      representation,
      requestUrl,
      failure.status,
      failure.body.error.code.toLowerCase(),
      failure.body.error.message,
    );
  }
  if (error instanceof StorageFailure) {
    const failure = storageFailure(error.code);
    return errorResponse(
      representation,
      requestUrl,
      failure.status,
      failure.code,
      failure.message,
    );
  }
  return errorResponse(
    representation,
    requestUrl,
    503,
    "temporarily_unavailable",
    "This resource is temporarily unavailable.",
  );
}

function storageFailure(code: StorageFailure["code"]): Readonly<{
  status: number;
  code: string;
  message: string;
}> {
  switch (code) {
    case "INVALID_REQUEST":
      return { status: 400, code: "invalid_request", message: "The request is invalid." };
    case "NOT_FOUND":
      return { status: 404, code: "not_found", message: "The requested resource was not found." };
    case "CONFLICT":
      return { status: 409, code: "conflict", message: "The request conflicts with current state." };
    case "PRECONDITION_FAILED":
      return { status: 412, code: "precondition_failed", message: "A required condition has changed." };
    case "UNAVAILABLE":
      return { status: 503, code: "temporarily_unavailable", message: "This resource is temporarily unavailable." };
  }
}

function errorResponse(
  representation: Representation,
  requestUrl: string,
  status: number,
  code: string,
  message: string,
): Response {
  if (representation === "html") {
    return htmlResponse(
      page(
        status === 404 ? "Not found" : "Investment indications",
        `<main class="moderation-main moderation-message"><h1>${escapeHtml(message)}</h1><a href="/owner">Return to owner workspace</a></main>`,
      ),
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

function renderCollection(
  document: OwnerIndicationCollectionDocument,
): string {
  const itemLinks = document.links.filter((link) => link.rel.includes("item"));
  const items = document.data.items.length === 0
    ? `<p class="moderation-empty">No investment indications are ready for review.</p>`
    : `<ol class="moderation-list">${document.data.items.map((item, index) =>
      `<li><article><div><p>${escapeHtml(item.status)}</p><h2>${escapeHtml(item.kind === "company" ? "Company indication" : "Personal indication")}</h2></div><dl><div><dt>Amount</dt><dd>${item.amount} ${escapeHtml(item.currency)}</dd></div><div><dt>Updated</dt><dd>${escapeHtml(item.updated_at)}</dd></div><div><dt>Revision</dt><dd>${item.revision}</dd></div></dl><a href="${escapeAttribute(itemLinks[index]?.href ?? "#")}">Review indication</a></article></li>`
    ).join("")}</ol>`;
  const next = document.links.find((link) => link.rel.includes("next"));
  return page(
    "Investment indications",
    `<main class="moderation-main"><div class="moderation-title"><div><p class="moderation-kicker">Owner review</p><h1>Investment indications</h1></div><a href="/owner">Campaign workspace</a></div>${items}${next ? `<a class="moderation-next" href="${escapeAttribute(next.href)}">Next page</a>` : ""}</main>`,
  );
}

function renderDetail(
  resource: OwnerIndicationDetailResource,
  csrfToken: string | null,
): string {
  const data = resource.document.data;
  const identity = data.company === null
    ? `<div><dt>Residence</dt><dd>${escapeHtml(data.personal?.residence_country ?? "")}</dd></div>`
    : `<div><dt>Company</dt><dd>${escapeHtml(data.company.name)}</dd></div><div><dt>Registration</dt><dd>${escapeHtml(data.company.registration_country)} / ${escapeHtml(data.company.identifier)}</dd></div><div><dt>Representative</dt><dd>${escapeHtml(data.company.representative_name)}</dd></div>`;
  const rejection = data.rejection === null
    ? ""
    : `<section class="moderation-band"><h2>Rejection</h2><p>${escapeHtml(data.rejection.reason)}</p><time datetime="${escapeAttribute(data.rejection.rejected_at)}">${escapeHtml(data.rejection.rejected_at)}</time></section>`;
  const notification = data.notification === null
    ? ""
    : `<section class="moderation-band"><h2>Manual notification</h2><h3>${escapeHtml(data.notification.subject_line)}</h3><pre>${escapeHtml(data.notification.body)}</pre><a href="/owner/manual-notifications/${encodeURIComponent(data.notification.id)}">Open notification history</a></section>`;
  const form = resource.reject === null || csrfToken === null
    ? ""
    : `<section class="moderation-reject"><div><p class="moderation-kicker">Decision</p><h2>Reject indication</h2><p>The reason is visible to the participant.</p></div>${renderRejectForm(resource.reject.form, csrfToken)}</section>`;
  return page(
    `${data.kind} indication`,
    `<main class="moderation-main"><a class="moderation-back" href="${OWNER_INDICATIONS_PATH}">Investment indications</a><div class="moderation-title moderation-title--detail"><div><p class="moderation-kicker">${escapeHtml(data.status)}</p><h1>${escapeHtml(data.kind === "company" ? "Company indication" : "Personal indication")}</h1></div><span>Revision ${data.revision}</span></div><dl class="moderation-details">${identity}<div><dt>Amount</dt><dd>${data.amount} ${escapeHtml(data.currency)}</dd></div><div><dt>Availability</dt><dd>${escapeHtml(data.availability_period)}</dd></div><div><dt>Participant subject</dt><dd>${escapeHtml(data.participant_subject)}</dd></div><div><dt>Note</dt><dd>${escapeHtml(data.note ?? "Not provided")}</dd></div></dl>${rejection}${notification}${form}</main>`,
  );
}

function renderRejectForm(form: HtmlFormAction, csrfToken: string): string {
  const hidden = form.fields
    .filter((field) => field.presentation === "hidden")
    .map((field) => `<input type="hidden" name="${escapeAttribute(field.name)}" value="${escapeAttribute(String(field.value ?? field.defaultValue ?? ""))}">`)
    .join("");
  return `<form data-action="${escapeAttribute(form.name)}" action="${escapeAttribute(form.action)}" method="post"><input type="hidden" name="_csrf" value="${escapeAttribute(csrfToken)}">${hidden}<label for="rejection-reason">Participant-visible reason</label><textarea id="rejection-reason" name="reason" maxlength="${INVESTMENT_INDICATION_LIMITS.rejectionReasonLength}" required></textarea><button type="submit">${escapeHtml(form.title)}</button></form>`;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/owner-moderation.css"></head><body><header class="moderation-header"><a href="/owner">Campaign workspace</a><nav aria-label="Owner navigation"><a href="/">View campaign</a></nav></header>${body}</body></html>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      Vary: "Accept",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
