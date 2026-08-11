import { chatGPTSignInPath } from "../../domain/auth-navigation.ts";
import {
  createOwnerFounderReviewCollectionDocument,
  createOwnerFounderReviewDetailDocument,
  type OwnerFounderReviewCollectionDocument,
  type OwnerFounderReviewDetailDocument,
} from "../../domain/owner-founder-review-resource.ts";
import {
  INVESTOR_APP_API_VERSION,
} from "../../domain/public-campaign-resource.ts";
import { StorageFailure, type StorageCursor } from "../../domain/storage-adapter.ts";
import { negotiateRepresentation } from "../../http/content-negotiation.ts";
import type {
  FounderApplicationReviewCollectionRepository,
  FounderApplicationReviewDetailRepository,
  FounderApplicationReviewRepository,
} from "../../repositories/in-memory-founder-application-repository.ts";
import {
  MAX_FOUNDER_APPLICATION_REVIEW_CURSOR_CHARACTERS,
  MAX_FOUNDER_APPLICATION_REVIEW_PAGE_SIZE,
} from "../../repositories/in-memory-founder-application-repository.ts";
import type { ApplicationRouteHandler } from "../contracts.ts";
import {
  hypermediaResponse,
  notAcceptableResponse,
} from "./responses.ts";

export const OWNER_FOUNDER_REVIEW_COLLECTION_PATH =
  "/owner/founder-applications";
const DEFAULT_PAGE_SIZE = 25;
const REVIEW_ID_PATTERN = /^founder-review:[0-9a-f]{64}$/u;

export function createOwnerFounderReviewCollectionRouteHandler(
  repository: FounderApplicationReviewCollectionRepository,
): ApplicationRouteHandler {
  return createFounderReviewHandler(repository, null);
}

export function createOwnerFounderReviewRouteHandler(
  repository: FounderApplicationReviewRepository,
): ApplicationRouteHandler {
  return createFounderReviewHandler(repository, repository);
}

export function createOwnerFounderReviewDetailRouteHandler(
  repository: FounderApplicationReviewDetailRepository,
): ApplicationRouteHandler {
  return createFounderReviewHandler(null, repository);
}

function createFounderReviewHandler(
  collection: FounderApplicationReviewCollectionRepository | null,
  detail: FounderApplicationReviewDetailRepository | null,
): ApplicationRouteHandler {
  return async (context) => {
    const route = parseRoute(
      context.url,
      collection !== null,
      detail !== null,
    );
    if (route === null) return null;
    const safeResourceUrl = safeFounderReviewResourceUrl(
      context.resourceUrl,
      route,
    );

    const representation = negotiateRepresentation(
      context.request.headers.get("accept"),
    );
    if (representation.kind === "not-acceptable") {
      return privateResponse(notAcceptableResponse(safeResourceUrl));
    }
    if (context.actor === null) {
      return authenticationRequiredResponse(
        representation.kind,
        safeResourceUrl,
      );
    }
    if (!context.isOwner) {
      return errorResponse(
        representation.kind,
        safeResourceUrl,
        404,
        "not_found",
        "The requested resource was not found.",
      );
    }
    if (context.request.method !== "GET") {
      return errorResponse(
        representation.kind,
        safeResourceUrl,
        405,
        "method_not_allowed",
        "This resource is read-only.",
      );
    }

    try {
      if (route.kind === "collection") {
        if (collection === null) return null;
        const request = parsePageRequest(context.url);
        const resourceUrl = canonicalCollectionResourceUrl(
          context.resourceUrl,
          request,
        );
        const document = createOwnerFounderReviewCollectionDocument(
          resourceUrl,
          await collection.list(request),
          request.limit,
          detail !== null,
        );
        return representation.kind === "hypermedia-json"
          ? privateResponse(hypermediaResponse(document))
          : htmlResponse(renderCollection(document));
      }

      if (detail === null) return null;
      if (route.reviewId === null || context.url.search !== "") {
        throw new StorageFailure("INVALID_REQUEST");
      }
      const item = await detail.get(route.reviewId);
      if (item === null) {
        return errorResponse(
          representation.kind,
          safeResourceUrl,
          404,
          "not_found",
          "The requested resource was not found.",
        );
      }
      const document = createOwnerFounderReviewDetailDocument(
        safeResourceUrl,
        item,
      );
      return representation.kind === "hypermedia-json"
        ? privateResponse(hypermediaResponse(document))
        : htmlResponse(renderDetail(document));
    } catch (error) {
      const invalid = error instanceof StorageFailure &&
        error.code === "INVALID_REQUEST";
      return errorResponse(
        representation.kind,
        safeResourceUrl,
        invalid ? 400 : 503,
        invalid ? "invalid_request" : "temporarily_unavailable",
        invalid
          ? "The request is invalid."
          : "This resource is temporarily unavailable.",
      );
    }
  };
}

type FounderReviewRoute =
  | Readonly<{ kind: "collection" }>
  | Readonly<{ kind: "detail"; reviewId: string | null }>;

function parseRoute(
  url: URL,
  collectionAvailable: boolean,
  detailAvailable: boolean,
): FounderReviewRoute | null {
  if (url.pathname === OWNER_FOUNDER_REVIEW_COLLECTION_PATH) {
    return collectionAvailable ? { kind: "collection" } : null;
  }
  if (!detailAvailable) return null;
  const prefix = `${OWNER_FOUNDER_REVIEW_COLLECTION_PATH}/`;
  if (!url.pathname.startsWith(prefix)) return null;
  const encoded = url.pathname.slice(prefix.length);
  if (encoded.length === 0 || encoded.includes("/")) return null;
  let reviewId: string;
  try {
    reviewId = decodeURIComponent(encoded);
  } catch {
    return { kind: "detail", reviewId: null };
  }
  return {
    kind: "detail",
    reviewId: REVIEW_ID_PATTERN.test(reviewId) ? reviewId : null,
  };
}

function parsePageRequest(
  url: URL,
): Readonly<{ limit: number; cursor?: StorageCursor }> {
  const queryNames = [...url.searchParams.keys()];
  const pageSizeValues = url.searchParams.getAll("page_size");
  const cursorValues = url.searchParams.getAll("cursor");
  if (
    queryNames.some((name) => name !== "page_size" && name !== "cursor") ||
    pageSizeValues.length > 1 ||
    cursorValues.length > 1 ||
    (cursorValues.length === 1 && pageSizeValues.length !== 1)
  ) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  const serializedPageSize = pageSizeValues[0];
  const limit = serializedPageSize === undefined
    ? DEFAULT_PAGE_SIZE
    : Number(serializedPageSize);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_FOUNDER_APPLICATION_REVIEW_PAGE_SIZE ||
    (serializedPageSize !== undefined &&
      String(limit) !== serializedPageSize)
  ) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  const cursor = cursorValues[0];
  if (
    cursor !== undefined &&
    (cursor.length === 0 ||
      cursor.length > MAX_FOUNDER_APPLICATION_REVIEW_CURSOR_CHARACTERS ||
      hasControlCharacter(cursor))
  ) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return {
    limit,
    ...(cursor === undefined ? {} : { cursor: cursor as StorageCursor }),
  };
}

function safeFounderReviewResourceUrl(
  requestUrl: string,
  route: FounderReviewRoute,
): string {
  const safe = new URL(requestUrl);
  safe.pathname = route.kind === "collection"
    ? OWNER_FOUNDER_REVIEW_COLLECTION_PATH
    : `${OWNER_FOUNDER_REVIEW_COLLECTION_PATH}/${
      encodeURIComponent(route.reviewId ?? "invalid")
    }`;
  safe.search = "";
  safe.hash = "";
  return safe.href;
}

function canonicalCollectionResourceUrl(
  requestUrl: string,
  request: Readonly<{ limit: number; cursor?: StorageCursor }>,
): string {
  const incoming = new URL(requestUrl);
  const canonical = new URL(
    OWNER_FOUNDER_REVIEW_COLLECTION_PATH,
    incoming.origin,
  );
  if (incoming.searchParams.has("page_size")) {
    canonical.searchParams.set("page_size", String(request.limit));
  }
  if (request.cursor !== undefined) {
    canonical.searchParams.set("cursor", request.cursor);
  }
  return canonical.href;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point <= 31 || point === 127)) return true;
  }
  return false;
}

function authenticationRequiredResponse(
  representation: "html" | "hypermedia-json",
  requestUrl: string,
): Response {
  const signIn = new URL(chatGPTSignInPath(new URL(requestUrl).pathname), requestUrl);
  if (representation === "html") {
    return htmlResponse(
      page(
        "Sign in",
        `<main><p class="section-kicker">Owner workspace</p><h1>Sign in to continue</h1><p><a href="${escapeAttribute(signIn.href)}">Sign in</a></p></main>`,
      ),
      401,
    );
  }
  return privateResponse(hypermediaResponse({
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
  }, 401));
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
      page(
        status === 404 ? "Not found" : "Founder applications",
        `<main><h1>${escapeHtml(message)}</h1></main>`,
      ),
      status,
    );
  }
  return privateResponse(hypermediaResponse({
    api_version: INVESTOR_APP_API_VERSION,
    type: "error",
    id: code,
    data: { code, message },
    links: [{ rel: ["self"], href: new URL(requestUrl).href }],
    actions: [],
  }, status));
}

function renderCollection(
  document: OwnerFounderReviewCollectionDocument,
): string {
  const items = document.data.items.length === 0
    ? "<p>No founder applications are ready for review.</p>"
    : `<ol class="review-list">${document.data.items.map((item) => {
      const link = document.links.find((candidate) =>
        candidate.rel.includes("item") &&
        candidate.href.endsWith(encodeURIComponent(item.review_id))
      );
      const detailLink = link === undefined
        ? ""
        : `<a href="${escapeAttribute(link.href)}">Review application</a>`;
      return `<li><article><p>${escapeHtml(item.status)}</p><h2>${escapeHtml(item.primary_contribution_area_id)}</h2><dl><dt>Reference</dt><dd><code>${escapeHtml(item.review_id)}</code></dd><dt>Updated</dt><dd>${escapeHtml(item.updated_at)}</dd><dt>Revision</dt><dd>${item.revision}</dd></dl>${detailLink}</article></li>`;
    }).join("")}</ol>`;
  const next = document.links.find((link) => link.rel.includes("next"));
  const owner = document.links.find((link) => link.rel.includes("owner"));
  return page(
    "Founder applications",
    `<main><p class="section-kicker">Owner review</p><h1>Founder applications</h1>${items}${next ? `<p><a href="${escapeAttribute(next.href)}">Next page</a></p>` : ""}${owner ? `<p><a href="${escapeAttribute(owner.href)}">Back to campaign workspace</a></p>` : ""}</main>`,
  );
}

function renderDetail(document: OwnerFounderReviewDetailDocument): string {
  const data = document.data;
  const profileLinks = data.professional_profile_links.length === 0
    ? "<p>None provided.</p>"
    : `<ul>${data.professional_profile_links.map((href) =>
      `<li><a href="${escapeAttribute(href)}" rel="noreferrer">${escapeHtml(href)}</a></li>`
    ).join("")}</ul>`;
  const history = `<ol>${data.history.map((entry) =>
    `<li>${escapeHtml(entry.transition)} · ${escapeHtml(entry.occurred_at)} · revision ${entry.revision}</li>`
  ).join("")}</ol>`;
  return page(
    "Founder application",
    `<main><p class="section-kicker">Owner review</p><h1>Founder application</h1><p>Status: <strong>${escapeHtml(data.status)}</strong></p><dl><dt>Expertise</dt><dd>${escapeHtml(data.expertise_summary)}</dd><dt>Intended contribution</dt><dd>${escapeHtml(data.intended_contribution)}</dd><dt>Primary contribution area</dt><dd>${escapeHtml(data.primary_contribution_area_id)}</dd><dt>Other contribution areas</dt><dd>${escapeHtml(data.secondary_contribution_area_ids.join(", ") || "None provided")}</dd><dt>Availability</dt><dd>${escapeHtml(data.approximate_availability)}</dd><dt>Possible start</dt><dd>${escapeHtml(data.possible_start_timing)}</dd><dt>Compensation expectation</dt><dd>${escapeHtml(data.compensation_expectation)}</dd><dt>Note</dt><dd>${escapeHtml(data.note || "None provided")}</dd></dl><section><h2>Professional profiles</h2>${profileLinks}</section><section><h2>Application history</h2>${history}</section><p><a href="/owner/founder-applications">Back to founder applications</a></p></main>`,
  );
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
      "Referrer-Policy": "no-referrer",
      Vary: "Accept",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
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
