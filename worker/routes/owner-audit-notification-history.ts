import { chatGPTSignInPath } from "../../domain/auth-navigation.ts";
import {
  createOwnerAuditCollectionDocument,
  createOwnerNotificationCollectionDocument,
  createOwnerNotificationDetailResource,
  type OwnerAuditCollectionDocument,
  type OwnerNotificationCollectionDocument,
  type OwnerNotificationControl,
  type OwnerNotificationDetailResource,
  type OwnerNotificationOperationIdIssuer,
} from "../../domain/owner-audit-notification-resource.ts";
import type { HtmlFormAction } from "../../domain/hypermedia-action.ts";
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
  AtomicManualNotificationActivityRepository,
  AuditEventReader,
  AuditRepository,
} from "../../repositories/in-memory-audit-notification-repositories.ts";
import type {
  ApplicationRouteContext,
  ApplicationRouteHandler,
} from "../contracts.ts";
import {
  hypermediaResponse,
  notAcceptableResponse,
} from "./responses.ts";

const AUDIT_PATH = "/owner/audit-events";
const NOTIFICATION_PATH = "/owner/manual-notifications";
const DEFAULT_PAGE_SIZE = 25;
const MUTATION_FIELDS = new Set(["operation-id", "expected-revision"]);

type Representation = "html" | "hypermedia-json";
type Activity = "template-copied" | "sent-marked";

type HistoryRoute =
  | Readonly<{ kind: "notification-collection" }>
  | Readonly<{ kind: "notification-detail"; notificationId: string }>
  | Readonly<{
    kind: "notification-activity";
    notificationId: string;
    activity: Activity;
  }>;

export type OwnerAuditNotificationRouteDependencies = Readonly<{
  audit: AuditRepository;
  notifications: AtomicManualNotificationActivityRepository;
  verifyMutation: BrowserMutationGuard;
  csrfToken: (request: Request) => Promise<string | null>;
  issueOperationId: OwnerNotificationOperationIdIssuer;
  now?: () => Date;
}>;

export type OwnerAuditHistoryRouteDependencies = Readonly<{
  audit: AuditEventReader;
}>;

/** Composes only the persistent read-only audit resource. */
export function createOwnerAuditHistoryRouteHandler(
  dependencies: OwnerAuditHistoryRouteDependencies,
): ApplicationRouteHandler {
  return async (context) => {
    if (context.url.pathname !== AUDIT_PATH) return null;
    return ownerAuditCollectionResponse(context, dependencies.audit, false);
  };
}

export function createOwnerAuditNotificationHistoryRouteHandler(
  dependencies: OwnerAuditNotificationRouteDependencies,
): ApplicationRouteHandler {
  const issueOperationId = checkedOperationIssuer(
    dependencies.issueOperationId,
  );
  const now = dependencies.now ?? (() => new Date());

  return async (context) => {
    if (context.url.pathname === AUDIT_PATH) {
      return ownerAuditCollectionResponse(context, dependencies.audit, true);
    }
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
      if (route.kind === "notification-activity") {
        if (context.request.method !== "POST") {
          return methodNotAllowedResponse(representation, context.resourceUrl);
        }
        if (dependencies.notifications.activityConsistency !==
          "atomic-notification-audit") {
          throw new StorageFailure("UNAVAILABLE");
        }
        return await mutateNotification(
          context,
          route,
          representation,
          dependencies,
          issueOperationId,
          now,
        );
      }
      if (context.request.method !== "GET") {
        return methodNotAllowedResponse(representation, context.resourceUrl);
      }

      if (route.kind === "notification-collection") {
        const pageRequest = parsePageRequest(context.url);
        const document = createOwnerNotificationCollectionDocument(
          context.resourceUrl,
          await dependencies.notifications.list(pageRequest),
          pageRequest.limit,
        );
        return representation === "hypermedia-json"
          ? hypermediaResponse(document)
          : htmlResponse(renderNotificationCollection(document));
      }

      assertNoQuery(context.url);
      const snapshot = await dependencies.notifications.get(
        route.notificationId,
      );
      if (snapshot === null) throw new StorageFailure("NOT_FOUND");
      return detailResponse(
        context,
        representation,
        createOwnerNotificationDetailResource(
          context.resourceUrl,
          snapshot,
          issueOperationId,
        ),
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

async function ownerAuditCollectionResponse(
  context: ApplicationRouteContext,
  audit: AuditEventReader,
  manualNotificationsAvailable: boolean,
): Promise<Response> {
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
  if (context.request.method !== "GET") {
    return methodNotAllowedResponse(representation, context.resourceUrl);
  }

  try {
    const pageRequest = parsePageRequest(context.url);
    const document = createOwnerAuditCollectionDocument(
      context.resourceUrl,
      await audit.list(pageRequest),
      pageRequest.limit,
      { manualNotificationsAvailable },
    );
    return representation === "hypermedia-json"
      ? hypermediaResponse(document)
      : htmlResponse(renderAuditCollection(document));
  } catch (error) {
    return mappedFailureResponse(
      representation,
      context.resourceUrl,
      error,
    );
  }
}

async function mutateNotification(
  context: ApplicationRouteContext,
  route: Extract<HistoryRoute, Readonly<{ kind: "notification-activity" }>>,
  representation: Representation,
  dependencies: OwnerAuditNotificationRouteDependencies,
  issueOperationId: OwnerNotificationOperationIdIssuer,
  now: () => Date,
): Promise<Response> {
  assertNoQuery(context.url);
  const verified = await dependencies.verifyMutation(context.request);
  if (
    verified.method !== "POST" ||
    verified.actor.type !== "owner" ||
    verified.actor.subject !== context.actor?.userId
  ) {
    throw new MutationSecurityFailure("REQUEST_REJECTED");
  }
  const mutation = parseMutation(verified.body, verified.mediaType);
  const request = {
    operationId: mutation.operationId,
    notificationId: route.notificationId,
    expectedRevision: mutation.expectedRevision,
    ownerSubject: verified.actor.subject,
    occurredAt: currentTimestamp(now),
  };
  if (route.activity === "template-copied") {
    await dependencies.notifications.recordCopyWithAudit(request);
  } else {
    await dependencies.notifications.markSentWithAudit(request);
  }

  const detailUrl = new URL(
    `${NOTIFICATION_PATH}/${encodeURIComponent(route.notificationId)}`,
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

  const current = await dependencies.notifications.get(route.notificationId);
  if (current === null) throw new StorageFailure("UNAVAILABLE");
  return detailResponse(
    { ...context, resourceUrl: detailUrl },
    representation,
    createOwnerNotificationDetailResource(
      detailUrl,
      current,
      issueOperationId,
    ),
    dependencies.csrfToken,
  );
}

async function detailResponse(
  context: ApplicationRouteContext,
  representation: Representation,
  resource: OwnerNotificationDetailResource,
  csrfToken: OwnerAuditNotificationRouteDependencies["csrfToken"],
): Promise<Response> {
  const hasMutation = resource.recordCopy !== null || resource.markSent !== null;
  const token = hasMutation
    ? requiredCsrfToken(await csrfToken(context.request))
    : null;
  const response = representation === "hypermedia-json"
    ? hypermediaResponse(resource.document)
    : htmlResponse(renderNotificationDetail(resource, token));
  return token === null ? response : withCsrfToken(response, token);
}

function parseRoute(url: URL): HistoryRoute | null {
  if (url.pathname === NOTIFICATION_PATH) {
    return { kind: "notification-collection" };
  }
  const prefix = `${NOTIFICATION_PATH}/`;
  if (!url.pathname.startsWith(prefix)) return null;
  const segments = url.pathname.slice(prefix.length).split("/");
  if (segments.length < 1 || segments.length > 2 || segments[0] === "") {
    return null;
  }
  const notificationId = decodeSegment(segments[0]);
  if (notificationId === null) {
    return { kind: "notification-detail", notificationId: "invalid" };
  }
  if (segments.length === 1) {
    return { kind: "notification-detail", notificationId };
  }
  if (segments[1] === "copies") {
    return {
      kind: "notification-activity",
      notificationId,
      activity: "template-copied",
    };
  }
  if (segments[1] === "sent-marker") {
    return {
      kind: "notification-activity",
      notificationId,
      activity: "sent-marked",
    };
  }
  return null;
}

function decodeSegment(value: string | undefined): string | null {
  if (value === undefined || value.length === 0 || value.length > 384) {
    return null;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parsePageRequest(
  url: URL,
): Readonly<{ limit: number; cursor?: StorageCursor }> {
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "page_size" && key !== "cursor")) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  const pageSizes = url.searchParams.getAll("page_size");
  const cursors = url.searchParams.getAll("cursor");
  if (pageSizes.length > 1 || cursors.length > 1) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  const serializedPageSize = pageSizes[0];
  const limit = serializedPageSize === undefined
    ? DEFAULT_PAGE_SIZE
    : Number(serializedPageSize);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (serializedPageSize !== undefined && String(limit) !== serializedPageSize)
  ) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  const cursor = cursors[0];
  if (
    cursor !== undefined &&
    (cursor.length === 0 || cursor.length > 512 || hasControlCharacter(cursor))
  ) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return {
    limit,
    ...(cursor === undefined ? {} : { cursor: cursor as StorageCursor }),
  };
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
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
  return Object.freeze({
    operationId: operationId.value,
    expectedRevision: candidate as number,
  });
}

function checkedOperationIssuer(
  issueOperationId: OwnerNotificationOperationIdIssuer,
): OwnerNotificationOperationIdIssuer {
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
        `<main class="history-main history-message"><p class="history-kicker">Owner workspace</p><h1>Sign in to continue</h1><a href="${escapeAttribute(signIn.href)}">Sign in</a></main>`,
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
        status === 404 ? "Not found" : "Owner activity",
        `<main class="history-main history-message"><h1>${escapeHtml(message)}</h1><a href="/owner">Return to owner workspace</a></main>`,
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

function renderAuditCollection(document: OwnerAuditCollectionDocument): string {
  const rows = document.data.items.length === 0
    ? `<p class="history-empty">No audit events have been recorded.</p>`
    : `<ol class="history-list">${document.data.items.map((item) =>
      `<li><article><div><p>${escapeHtml(auditDetailLabel(item.detail))}</p><h2>${escapeHtml(item.detail.kind)}</h2></div><dl><div><dt>Event</dt><dd>${escapeHtml(item.id)}</dd></div><div><dt>Occurred</dt><dd><time datetime="${escapeAttribute(item.occurred_at)}">${escapeHtml(item.occurred_at)}</time></dd></div><div><dt>Actor</dt><dd>${escapeHtml(item.actor.type)}${item.actor.subject === undefined ? "" : `: ${escapeHtml(item.actor.subject)}`}</dd></div></dl></article></li>`
    ).join("")}</ol>`;
  const next = document.links.find((link) => link.rel.includes("next"));
  const notifications = document.links.find((link) =>
    link.rel.includes("manual-notifications")
  );
  return page(
    "Audit events",
    `<main class="history-main"><div class="history-title"><div><p class="history-kicker">Owner activity</p><h1>Audit events</h1></div>${notifications ? `<a href="${escapeAttribute(notifications.href)}">Manual notifications</a>` : ""}</div>${rows}${next ? `<a class="history-next" href="${escapeAttribute(next.href)}">Next page</a>` : ""}</main>`,
  );
}

function renderNotificationCollection(
  document: OwnerNotificationCollectionDocument,
): string {
  const itemLinks = document.links.filter((link) => link.rel.includes("item"));
  const rows = document.data.items.length === 0
    ? `<p class="history-empty">No manual notifications have been prepared.</p>`
    : `<ol class="history-list">${document.data.items.map((item, index) =>
      `<li><article><div><p>${escapeHtml(item.delivery_state === "marked-sent" ? "Marked sent" : "Not marked sent")}</p><h2>${escapeHtml(item.subject_line)}</h2></div><dl><div><dt>Generated</dt><dd><time datetime="${escapeAttribute(item.generated_at)}">${escapeHtml(item.generated_at)}</time></dd></div><div><dt>Copies</dt><dd>${item.copy_count}</dd></div></dl><a href="${escapeAttribute(itemLinks[index]?.href ?? "#")}">Open notification</a></article></li>`
    ).join("")}</ol>`;
  const next = document.links.find((link) => link.rel.includes("next"));
  return page(
    "Manual notifications",
    `<main class="history-main"><div class="history-title"><div><p class="history-kicker">Owner activity</p><h1>Manual notifications</h1></div><a href="/owner/audit-events">Audit events</a></div>${rows}${next ? `<a class="history-next" href="${escapeAttribute(next.href)}">Next page</a>` : ""}</main>`,
  );
}

function renderNotificationDetail(
  resource: OwnerNotificationDetailResource,
  csrfToken: string | null,
): string {
  const { data } = resource.document;
  const actions = [resource.recordCopy, resource.markSent]
    .filter((value): value is OwnerNotificationControl => value !== null)
    .map((control) => renderActivityForm(control.form, csrfToken))
    .join("");
  const copies = data.copy_history.length === 0
    ? `<p class="history-empty">No template copies have been recorded.</p>`
    : `<ol class="history-evidence">${data.copy_history.map((item) =>
      `<li><time datetime="${escapeAttribute(item.copied_at)}">${escapeHtml(item.copied_at)}</time></li>`
    ).join("")}</ol>`;
  const sent = data.sent_marker === null
    ? "Not marked sent"
    : `Marked sent at ${escapeHtml(data.sent_marker.sent_at)}`;
  return page(
    data.subject_line,
    `<main class="history-main"><a class="history-back" href="/owner/manual-notifications">Manual notifications</a><div class="history-title history-title--detail"><div><p class="history-kicker">${escapeHtml(sent)}</p><h1>${escapeHtml(data.subject_line)}</h1></div><span>Revision ${data.revision}</span></div><dl class="history-metadata"><div><dt>Recipient subject</dt><dd>${escapeHtml(data.recipient_subject)}</dd></div><div><dt>Related resource</dt><dd>${escapeHtml(data.related_resource.type)}</dd></div><div><dt>Generated</dt><dd>${escapeHtml(data.generated_at)}</dd></div></dl><section class="history-template" aria-labelledby="notification-body"><h2 id="notification-body">Message template</h2><pre>${escapeHtml(data.body)}</pre></section><div class="history-actions">${actions}</div><section class="history-copy-log"><h2>Copy history</h2>${copies}</section></main>`,
  );
}

function renderActivityForm(
  form: HtmlFormAction,
  csrfToken: string | null,
): string {
  if (csrfToken === null) return "";
  const fields = form.fields.map((field) =>
    `<input type="hidden" name="${escapeAttribute(field.name)}" value="${escapeAttribute(String(field.value ?? field.defaultValue ?? ""))}">`
  ).join("");
  return `<form data-action="${escapeAttribute(form.name)}" action="${escapeAttribute(form.action)}" method="post"><input type="hidden" name="_csrf" value="${escapeAttribute(csrfToken)}">${fields}<button type="submit">${escapeHtml(form.title)}</button></form>`;
}

function auditDetailLabel(detail: OwnerAuditEventItemDetail): string {
  if (detail.kind === "resource-transition") {
    return `${detail.resource_type} ${detail.resource_id}: ${detail.transition}`;
  }
  if (detail.kind === "export-created") return detail.export_type;
  return `${detail.activity}: ${detail.notification_id}`;
}

type OwnerAuditEventItemDetail =
  OwnerAuditCollectionDocument["data"]["items"][number]["detail"];

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/owner-history.css"></head><body><header class="history-header"><a href="/owner">Campaign workspace</a><nav aria-label="Owner navigation"><a href="/">View campaign</a></nav></header>${body}</body></html>`;
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
