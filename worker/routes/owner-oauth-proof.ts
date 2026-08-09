import { chatGPTSignInPath } from "../../domain/auth-navigation.ts";
import type { HtmlFormAction } from "../../domain/hypermedia-action.ts";
import {
  createOwnerOAuthProofResource,
  createOwnerOAuthProofResultDocument,
  OWNER_OAUTH_CALLBACK_PATH,
  OWNER_OAUTH_PROOF_PATH,
  type OwnerOAuthProofResultDocument,
  type OwnerOAuthProofResource,
} from "../../domain/owner-oauth-proof-resource.ts";
import {
  INVESTOR_APP_API_VERSION,
} from "../../domain/public-campaign-resource.ts";
import { negotiateRepresentation } from "../../http/content-negotiation.ts";
import type {
  OwnerOAuthCsrfProof,
  OwnerOAuthCsrfSession,
} from "../../http/owner-oauth-csrf-session.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  MutationSecurityFailure,
  toPublicMutationSecurityFailure,
} from "../../http/mutation-security.ts";
import {
  OAuthProofFailure,
  type AittaDBOAuthProofService,
} from "../../services/aittadb-oauth-proof.ts";
import type {
  ApplicationRouteHandler,
} from "../contracts.ts";
import {
  hypermediaResponse,
  notAcceptableResponse,
} from "./responses.ts";

type Representation = "html" | "hypermedia-json";

export type OwnerOAuthProofRouteDependencies = Readonly<{
  oauth: AittaDBOAuthProofService;
  csrfSession?: OwnerOAuthCsrfSession;
}>;

export function createOwnerOAuthProofRouteHandler(
  dependencies: OwnerOAuthProofRouteDependencies,
): ApplicationRouteHandler {
  return async (context) => {
    if (
      context.url.pathname !== OWNER_OAUTH_PROOF_PATH &&
      context.url.pathname !== OWNER_OAUTH_CALLBACK_PATH
    ) {
      return null;
    }

    const callback = context.url.pathname === OWNER_OAUTH_CALLBACK_PATH;
    const responseResourceUrl = callback
      ? new URL(OWNER_OAUTH_CALLBACK_PATH, context.resourceUrl).href
      : context.resourceUrl;
    const appOrigin = new URL(responseResourceUrl).origin;
    const finish = (response: Response) =>
      callback
        ? withClearedTransactionCookie(response, dependencies.oauth.clearCookie())
        : response;
    const negotiated = negotiateRepresentation(
      context.request.headers.get("accept"),
    );
    if (negotiated.kind === "not-acceptable") {
      return finish(notAcceptableResponse(responseResourceUrl));
    }
    const representation = negotiated.kind;

    if (context.actor === null) {
      return finish(authenticationRequiredResponse(
        representation,
        responseResourceUrl,
      ));
    }
    if (!context.isOwner) {
      return finish(notFoundResponse(representation, responseResourceUrl));
    }

    if (callback) {
      if (context.request.method !== "GET") {
        return finish(methodNotAllowedResponse(
          representation,
          responseResourceUrl,
          "GET",
        ));
      }
      try {
        await dependencies.oauth.complete(
          context.actor.userId,
          context.resourceUrl,
          context.request.headers.get("cookie"),
        );
        return finish(resultResponse(
          representation,
          createOwnerOAuthProofResultDocument(
            responseResourceUrl,
            "verified",
          ),
          200,
        ));
      } catch (error) {
        return finish(oauthFailureResponse(
          representation,
          responseResourceUrl,
          error,
        ));
      }
    }

    if (context.url.search !== "") {
      return failureResponse(
        representation,
        responseResourceUrl,
        400,
        "invalid_request",
        "The request is invalid.",
      );
    }
    if (context.request.method === "GET") {
      const availability = dependencies.csrfSession !== undefined &&
          await dependencies.oauth.availability()
        ? "available"
        : "unavailable";
      const resource = createOwnerOAuthProofResource(
        responseResourceUrl,
        availability,
      );
      let csrfProof: OwnerOAuthCsrfProof | null = null;
      if (resource.start !== null) {
        try {
          csrfProof = await dependencies.csrfSession?.issue(
            context.request,
            context.actor.userId,
            appOrigin,
          ) ?? null;
        } catch {
          csrfProof = null;
        }
        if (!isUsableCsrfProof(csrfProof)) {
          return failureResponse(
            representation,
            responseResourceUrl,
            503,
            "service_unavailable",
            "The connection service is temporarily unavailable.",
          );
        }
      }
      return resourceResponse(
        representation,
        resource,
        csrfProof,
        dependencies.oauth.authorizationOrigin,
      );
    }
    if (context.request.method !== "POST") {
      return methodNotAllowedResponse(
        representation,
        responseResourceUrl,
        "GET, POST",
      );
    }

    if (dependencies.csrfSession === undefined) {
      return failureResponse(
        representation,
        responseResourceUrl,
        503,
        "service_unavailable",
        "The connection service is temporarily unavailable.",
      );
    }
    try {
      const verified = await dependencies.csrfSession.verifyMutation(
        context.request,
        context.actor.userId,
        appOrigin,
      );
      if (
        verified.method !== "POST" ||
        verified.actor.type !== "owner" ||
        verified.actor.subject !== context.actor.userId ||
        Object.keys(verified.body).some((field) => field !== MUTATION_CSRF_FIELD)
      ) {
        throw new MutationSecurityFailure("REQUEST_REJECTED");
      }
      const start = await dependencies.oauth.begin(context.actor.userId);
      return authorizationRedirect(start.authorizationUrl, start.setCookie);
    } catch (error) {
      if (error instanceof MutationSecurityFailure) {
        return mutationFailureResponse(
          representation,
          responseResourceUrl,
          error,
        );
      }
      return oauthFailureResponse(
        representation,
        responseResourceUrl,
        error,
      );
    }
  };
}

function resourceResponse(
  representation: Representation,
  resource: OwnerOAuthProofResource,
  csrfProof: OwnerOAuthCsrfProof | null,
  authorizationOrigin: string,
): Response {
  const response = representation === "hypermedia-json"
    ? withPrivateHeaders(hypermediaResponse(resource.document))
    : privateHtmlResponse(
        renderConnectionResource(resource, csrfProof?.token ?? null),
        200,
        resource.start !== null && csrfProof !== null
          ? authorizationOrigin
          : undefined,
      );
  if (csrfProof === null) return response;
  const headers = new Headers(response.headers);
  headers.set(MUTATION_CSRF_HEADER, csrfProof.token);
  headers.append("Set-Cookie", csrfProof.setCookie);
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

function isUsableCsrfProof(value: OwnerOAuthCsrfProof | null): value is OwnerOAuthCsrfProof {
  return value !== null &&
    typeof value.token === "string" &&
    value.token.length >= 32 &&
    value.token.length <= 256 &&
    /^[A-Za-z0-9_-]+$/.test(value.token) &&
    typeof value.setCookie === "string" &&
    value.setCookie.length > 0 &&
    value.setCookie.length <= 4_096;
}

function resultResponse(
  representation: Representation,
  document: OwnerOAuthProofResultDocument,
  status: number,
): Response {
  return representation === "hypermedia-json"
    ? privateJsonResponse(document, status)
    : privateHtmlResponse(renderResult(document), status);
}

function authorizationRedirect(location: string, setCookie: string): Response {
  return new Response(null, {
    status: 303,
    headers: privateHeaders({
      Location: location,
      "Set-Cookie": setCookie,
    }),
  });
}

function oauthFailureResponse(
  representation: Representation,
  requestUrl: string,
  error: unknown,
): Response {
  const code = error instanceof OAuthProofFailure
    ? error.code
    : "service_unavailable";
  const status = code === "invalid_callback" ? 400 : 503;
  return resultResponse(
    representation,
    createOwnerOAuthProofResultDocument(requestUrl, "failed"),
    status,
  );
}

function mutationFailureResponse(
  representation: Representation,
  requestUrl: string,
  error: unknown,
): Response {
  const failure = toPublicMutationSecurityFailure(error);
  return failureResponse(
    representation,
    requestUrl,
    failure.status,
    failure.body.error.code.toLowerCase(),
    failure.body.error.message,
  );
}

function authenticationRequiredResponse(
  representation: Representation,
  requestUrl: string,
): Response {
  const signIn = new URL(chatGPTSignInPath(OWNER_OAUTH_PROOF_PATH), requestUrl).href;
  const document = errorDocument(
    requestUrl,
    "authentication_required",
    "Sign in is required to continue.",
    [{
      name: "sign-in",
      title: "Sign in",
      method: "GET",
      href: signIn,
      type: "text/html",
      fields: [],
    }],
  );
  return representation === "hypermedia-json"
    ? privateJsonResponse(document, 401)
    : privateHtmlResponse(
        renderSimplePage(
          "Sign in required",
          "Sign in is required to continue.",
          `<a class="oauth-proof-button" href="${escapeAttribute(signIn)}">Sign in</a>`,
        ),
        401,
      );
}

function notFoundResponse(
  representation: Representation,
  requestUrl: string,
): Response {
  return failureResponse(
    representation,
    requestUrl,
    404,
    "not_found",
    "The requested resource was not found.",
  );
}

function methodNotAllowedResponse(
  representation: Representation,
  requestUrl: string,
  allow: string,
): Response {
  const response = failureResponse(
    representation,
    requestUrl,
    405,
    "method_not_allowed",
    "The request method is not available.",
  );
  const headers = new Headers(response.headers);
  headers.set("Allow", allow);
  return new Response(response.body, { status: response.status, headers });
}

function failureResponse(
  representation: Representation,
  requestUrl: string,
  status: number,
  code: string,
  message: string,
): Response {
  const document = errorDocument(requestUrl, code, message, []);
  return representation === "hypermedia-json"
    ? privateJsonResponse(document, status)
    : privateHtmlResponse(
        renderSimplePage("Request unavailable", message, ""),
        status,
      );
}

function errorDocument(
  requestUrl: string,
  code: string,
  message: string,
  actions: readonly Record<string, unknown>[],
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    api_version: INVESTOR_APP_API_VERSION,
    type: "error",
    id: code,
    data: Object.freeze({ code, message }),
    links: Object.freeze([
      Object.freeze({ rel: ["self"], href: new URL(requestUrl).href }),
    ]),
    actions: Object.freeze(actions.map((action) => Object.freeze(action))),
  });
}

function privateJsonResponse(document: unknown, status: number): Response {
  const response = hypermediaResponse(document, status);
  return withPrivateHeaders(response);
}

function privateHtmlResponse(
  body: string,
  status = 200,
  formActionOrigin?: string,
): Response {
  return new Response(body, {
    status,
    headers: privateHeaders(
      { "Content-Type": "text/html; charset=utf-8" },
      formActionOrigin,
    ),
  });
}

function withClearedTransactionCookie(
  response: Response,
  clearCookie: string,
): Response {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", clearCookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withPrivateHeaders(response: Response): Response {
  const headers = privateHeaders(response.headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function privateHeaders(
  init: HeadersInit = {},
  formActionOrigin?: string,
): Headers {
  const headers = new Headers(init);
  const externalFormOrigin = exactHttpsOrigin(formActionOrigin);
  const formAction = externalFormOrigin === null
    ? "'self'"
    : `'self' ${externalFormOrigin}`;
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'self'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
  );
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Pragma", "no-cache");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Vary", "Accept");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return headers;
}

function exactHttpsOrigin(value: string | undefined): string | null {
  if (value === undefined) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === value
    ? value
    : null;
}

function renderConnectionResource(
  resource: OwnerOAuthProofResource,
  csrfToken: string | null,
): string {
  const action = resource.start;
  const controls = action === null || csrfToken === null
    ? "<p class=\"oauth-proof-status\">Try again after OAuth applications are enabled for the configured AittaDB service.</p>"
    : renderStartForm(action.form, csrfToken);
  return page(
    "AittaDB connection",
    `<main class="oauth-proof-main"><a class="oauth-proof-back" href="/owner">Campaign workspace</a><p class="oauth-proof-kicker">Owner connection</p><h1>AittaDB connection</h1><p class="oauth-proof-intro">Verify that this campaign can use its configured private storage access.</p><section class="oauth-proof-panel" aria-labelledby="connection-status"><div><p>Connection check</p><h2 id="connection-status">${resource.document.data.availability === "available" ? "Ready" : "Unavailable"}</h2></div><p>${escapeHtml(resource.document.data.summary)}</p>${controls}</section></main>`,
  );
}

function renderStartForm(form: HtmlFormAction, csrfToken: string): string {
  return `<form class="oauth-proof-form" data-action="${escapeAttribute(form.name)}" action="${escapeAttribute(form.action)}" method="post"><input type="hidden" name="${MUTATION_CSRF_FIELD}" value="${escapeAttribute(csrfToken)}"><button type="submit">${escapeHtml(form.title)}</button></form>`;
}

function renderResult(document: OwnerOAuthProofResultDocument): string {
  const verified = document.data.outcome === "verified";
  const action = verified
    ? `<a class="oauth-proof-button" href="/owner">Return to campaign workspace</a>`
    : `<a class="oauth-proof-button" href="${OWNER_OAUTH_PROOF_PATH}">Start a new check</a>`;
  return page(
    verified ? "Connection verified" : "Connection not verified",
    `<main class="oauth-proof-main"><a class="oauth-proof-back" href="/owner">Campaign workspace</a><p class="oauth-proof-kicker">Owner connection</p><h1>${verified ? "Connection verified" : "Connection not verified"}</h1><p class="oauth-proof-intro">${escapeHtml(document.data.message)}</p>${action}</main>`,
  );
}

function renderSimplePage(
  title: string,
  message: string,
  action: string,
): string {
  return page(
    title,
    `<main class="oauth-proof-main"><p class="oauth-proof-kicker">Campaign workspace</p><h1>${escapeHtml(title)}</h1><p class="oauth-proof-intro">${escapeHtml(message)}</p>${action}</main>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/owner-oauth-proof.css"></head><body class="oauth-proof-page">${body}</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#96;");
}
