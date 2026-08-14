import { chatGPTSignInPath } from "../../domain/auth-navigation.ts";
import {
  createOwnerReviewExportsResource,
  OWNER_REVIEW_CSV_PATH,
  OWNER_REVIEW_EXPORTS_PATH,
  OWNER_REVIEW_JSON_BACKUP_PATH,
  type OwnerReviewExportsResource,
} from "../../domain/owner-review-export-resource.ts";
import {
  INVESTOR_APP_API_VERSION,
  INVESTOR_APP_MEDIA_TYPE,
} from "../../domain/public-campaign-resource.ts";
import { parseStorageOperationId } from "../../domain/storage-adapter.ts";
import {
  acceptsMediaType,
  negotiateRepresentation,
} from "../../http/content-negotiation.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  MutationSecurityFailure,
  toPublicMutationSecurityFailure,
  type BrowserMutationGuard,
} from "../../http/mutation-security.ts";
import {
  OwnerReviewExportFailure,
  type AuditedOwnerReviewExport,
  type OwnerReviewExportService,
} from "../../services/owner-review-export.ts";
import type {
  ApplicationRouteContext,
  ApplicationRouteHandler,
} from "../contracts.ts";

type ExportRoute =
  | Readonly<{ kind: "workspace" }>
  | Readonly<{ kind: "review-csv" }>
  | Readonly<{ kind: "json-backup" }>;

type Representation = "html" | "hypermedia-json";

export type OwnerReviewExportRouteDependencies = Readonly<{
  service: OwnerReviewExportService;
  guardMutation: BrowserMutationGuard;
  csrfToken: (request: Request) => Promise<string>;
  issueOperationId?: (
    exportType: "review-csv" | "json-backup",
  ) => string;
}>;

export function createOwnerReviewExportRouteHandler(
  dependencies: OwnerReviewExportRouteDependencies,
): ApplicationRouteHandler {
  const issueOperationId = dependencies.issueOperationId ?? defaultOperationId;

  return async (context) => {
    const route = parseRoute(context.url.pathname);
    if (route === null) return null;

    if (context.actor === null) {
      return authenticationRequiredResponse(context);
    }
    if (!context.isOwner) {
      return errorResponse(context.resourceUrl, 404, "not_found",
        "The requested resource was not found.");
    }
    if ([...context.url.searchParams].length !== 0) {
      return errorResponse(context.resourceUrl, 400, "invalid_request",
        "The request is invalid.");
    }

    if (route.kind === "workspace") {
      if (context.request.method !== "GET") {
        return errorResponse(context.resourceUrl, 405, "method_not_allowed",
          "The request method is not allowed.", { Allow: "GET" });
      }
      const negotiated = negotiateRepresentation(
        context.request.headers.get("accept"),
      );
      if (negotiated.kind === "not-acceptable") {
        return errorResponse(context.resourceUrl, 406, "not_acceptable",
          "The requested representation is not available.");
      }
      try {
        const resource = createOwnerReviewExportsResource(
          context.resourceUrl,
          dependencies.service.limits,
          {
            reviewCsv: requiredOperationId(issueOperationId("review-csv")),
            jsonBackup: requiredOperationId(issueOperationId("json-backup")),
          },
        );
        const csrf = requiredCsrfToken(
          await dependencies.csrfToken(context.request),
        );
        const response = negotiated.kind === "hypermedia-json"
          ? privateHypermediaResponse(resource.document)
          : privateHtmlResponse(renderWorkspace(resource, csrf));
        return withCsrfToken(response, csrf);
      } catch {
        return errorResponse(context.resourceUrl, 503, "temporarily_unavailable",
          "This resource is temporarily unavailable.");
      }
    }

    if (context.request.method !== "POST") {
      return errorResponse(context.resourceUrl, 405, "method_not_allowed",
        "The request method is not allowed.", { Allow: "POST" });
    }
    const offeredType = route.kind === "review-csv"
      ? "text/csv"
      : "application/json";
    if (!acceptsMediaType(
      context.request.headers.get("accept"),
      offeredType,
    )) {
      return errorResponse(context.resourceUrl, 406, "not_acceptable",
        "The requested representation is not available.");
    }

    try {
      const verified = await dependencies.guardMutation(context.request);
      if (
        verified.method !== "POST" ||
        verified.actor.type !== "owner" ||
        verified.actor.subject !== context.actor.userId
      ) {
        throw new MutationSecurityFailure("REQUEST_REJECTED");
      }
      const operationId = parseExportMutation(verified.body);
      const request = {
        ownerSubject: verified.actor.subject,
        operationId,
        sourceUrl: context.resourceUrl,
      };
      const generated = route.kind === "review-csv"
        ? await dependencies.service.createReviewCsv(request)
        : await dependencies.service.createJsonBackup(request);
      return downloadResponse(generated);
    } catch (error) {
      if (error instanceof MutationSecurityFailure) {
        const failure = toPublicMutationSecurityFailure(error);
        return errorResponse(
          context.resourceUrl,
          failure.status,
          failure.body.error.code.toLowerCase(),
          failure.body.error.message,
        );
      }
      if (
        error instanceof OwnerReviewExportFailure &&
        error.code === "LIMIT_EXCEEDED"
      ) {
        return errorResponse(context.resourceUrl, 413, "export_too_large",
          "The export exceeds this deployment's configured limits.");
      }
      if (
        error instanceof OwnerReviewExportFailure &&
        error.code === "STALE_OPERATION"
      ) {
        return errorResponse(
          context.resourceUrl,
          409,
          "export_operation_stale",
          "This export operation has already been used. Request a fresh export action.",
          {},
          [{
            rel: ["review-exports"],
            href: new URL(OWNER_REVIEW_EXPORTS_PATH, context.resourceUrl).href,
          }],
        );
      }
      return errorResponse(context.resourceUrl, 503, "temporarily_unavailable",
        "This resource is temporarily unavailable.");
    }
  };
}

function parseRoute(pathname: string): ExportRoute | null {
  if (pathname === OWNER_REVIEW_EXPORTS_PATH) return { kind: "workspace" };
  if (pathname === OWNER_REVIEW_CSV_PATH) return { kind: "review-csv" };
  if (pathname === OWNER_REVIEW_JSON_BACKUP_PATH) {
    return { kind: "json-backup" };
  }
  return null;
}

function parseExportMutation(
  body: Readonly<Record<string, unknown>>,
): string {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "operation-id") {
    throw new MutationSecurityFailure("INVALID_REQUEST");
  }
  return requiredOperationId(body["operation-id"]);
}

function requiredOperationId(value: unknown): string {
  const parsed = parseStorageOperationId(value);
  if (!parsed.ok) throw new MutationSecurityFailure("INVALID_REQUEST");
  return parsed.value;
}

function requiredCsrfToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 256 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new OwnerReviewExportFailure("UNAVAILABLE");
  }
  return value;
}

function defaultOperationId(exportType: "review-csv" | "json-backup"): string {
  try {
    return `owner-export:${exportType}:${crypto.randomUUID()}`;
  } catch {
    throw new OwnerReviewExportFailure("UNAVAILABLE");
  }
}

function downloadResponse(generated: AuditedOwnerReviewExport): Response {
  let index = 0;
  const chunks = generated.chunks;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      index = chunks.length;
    },
  });
  const headers = privateHeaders();
  headers.set("Content-Disposition",
    `attachment; filename="${generated.filename}"`);
  headers.set("Content-Length", String(generated.byteLength));
  headers.set("Content-Type", generated.contentType);
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  return new Response(body, { status: 200, headers });
}

function authenticationRequiredResponse(
  context: ApplicationRouteContext,
): Response {
  const representation = preferredErrorRepresentation(context.request);
  const signIn = new URL(
    chatGPTSignInPath(OWNER_REVIEW_EXPORTS_PATH),
    context.resourceUrl,
  );
  if (representation === "html") {
    return privateHtmlResponse(
      page(
        "Sign in",
        `<main class="exports-main exports-message"><p class="exports-kicker">Owner workspace</p><h1>Sign in to continue</h1><a href="${escapeAttribute(signIn.href)}">Sign in</a></main>`,
      ),
      401,
    );
  }
  return privateHypermediaResponse({
    api_version: INVESTOR_APP_API_VERSION,
    type: "error",
    id: "authentication-required",
    data: {
      code: "authentication_required",
      message: "Sign in is required to continue.",
    },
    links: [{ rel: ["self"], href: new URL(context.resourceUrl).href }],
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

function preferredErrorRepresentation(request: Request): Representation {
  const negotiated = negotiateRepresentation(request.headers.get("accept"));
  return negotiated.kind === "html" ? "html" : "hypermedia-json";
}

function errorResponse(
  requestUrl: string,
  status: number,
  code: string,
  message: string,
  extraHeaders: HeadersInit = {},
  additionalLinks: readonly Readonly<{
    rel: readonly string[];
    href: string;
  }>[] = [],
): Response {
  const response = privateHypermediaResponse({
    api_version: INVESTOR_APP_API_VERSION,
    type: "error",
    id: code,
    data: { code, message },
    links: [
      { rel: ["self"], href: new URL(requestUrl).href },
      ...additionalLinks,
    ],
    actions: [],
  }, status);
  const headers = new Headers(response.headers);
  new Headers(extraHeaders).forEach((value, name) => headers.set(name, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function renderWorkspace(
  resource: OwnerReviewExportsResource,
  csrf: string,
): string {
  const document = resource.document;
  return page(
    "Review exports",
    `<main class="exports-main"><a class="exports-back" href="/owner">Campaign workspace</a><div class="exports-title"><p class="exports-kicker">Private owner data</p><h1>Review exports</h1><p>Download only when needed. These files contain private participant information and are not retained by the app.</p></div><section class="exports-options" aria-label="Available exports"><article><div><p>Spreadsheet review</p><h2>Current review data</h2><p>Participant profiles, investment indications, and founder applications in a bounded CSV file.</p></div>${renderDownloadForm(resource.reviewCsvForm, csrf, "Download CSV")}</article><article><div><p>Current-state backup</p><h2>Campaign data</h2><p>Current campaign, package, participant, indication, founder, and aggregate records in JSON.</p></div>${renderDownloadForm(resource.jsonBackupForm, csrf, "Download JSON")}</article></section><p class="exports-limit">Each export is limited to ${document.data.maximum_rows.toLocaleString("en-US")} review records, ${document.data.maximum_history_entries.toLocaleString("en-US")} history entries per record, and ${formatBytes(document.data.maximum_bytes)}.</p></main>`,
  );
}

function renderDownloadForm(
  form: OwnerReviewExportsResource["reviewCsvForm"],
  csrf: string,
  button: string,
): string {
  const fields = [
    ...form.hiddenFields.map((field) =>
      `<input type="hidden" name="${escapeAttribute(field.name)}" value="${escapeAttribute(field.value)}">`
    ),
    ...form.fields.map((field) => {
      if (field.inputType !== "hidden" || typeof field.value !== "string") {
        throw new OwnerReviewExportFailure("UNAVAILABLE");
      }
      return `<input type="hidden" name="${escapeAttribute(field.name)}" value="${escapeAttribute(field.value)}">`;
    }),
  ].join("");
  return `<form action="${escapeAttribute(form.action)}" method="post" accept-charset="utf-8"><input type="hidden" name="${MUTATION_CSRF_FIELD}" value="${escapeAttribute(csrf)}">${fields}<button type="submit">${escapeHtml(button)}</button></form>`;
}

function formatBytes(value: number): string {
  if (value % (1024 * 1024) === 0) {
    return `${value / (1024 * 1024)} MiB`;
  }
  return `${value.toLocaleString("en-US")} bytes`;
}

function page(title: string, body: string): string {
  return `<!doctype html><html class="exports-page" lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/owner-exports.css"></head><body class="exports-page-body"><header class="exports-header"><a href="/owner">Campaign workspace</a><nav aria-label="Owner navigation"><a href="/">View campaign</a></nav></header>${body}</body></html>`;
}

function privateHtmlResponse(body: string, status = 200): Response {
  const headers = privateHeaders();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy",
    "default-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  return new Response(body, { status, headers });
}

function privateHypermediaResponse(document: unknown, status = 200): Response {
  const headers = privateHeaders();
  headers.set("Content-Type",
    `${INVESTOR_APP_MEDIA_TYPE}; version=${INVESTOR_APP_API_VERSION}; charset=utf-8`);
  headers.set("Investor-App-API-Version", INVESTOR_APP_API_VERSION);
  return new Response(JSON.stringify(document), { status, headers });
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

function privateHeaders(): Headers {
  return new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "Cross-Origin-Resource-Policy": "same-origin",
    Expires: "0",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    Vary:
      "Accept, Cookie, oai-authenticated-user-id, oai-authenticated-user-email",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
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
