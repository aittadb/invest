import { chatGPTSignInPath } from "../../domain/auth-navigation.ts";
import { parseActorSubject, type ActorSubject } from "../../domain/foundation.ts";
import {
  PARTICIPANT_PACKAGE_PAGE_LIMITS,
  createParticipantPackagePage,
  type ParticipantPackagePage,
} from "../../domain/participant-package-resource.ts";
import {
  PARTICIPANT_HOME_PATH,
  PRIVATE_PACKAGE_PATH,
} from "../../domain/participant-navigation.ts";
import {
  INVESTOR_APP_API_VERSION,
  type HypermediaAction,
  type HypermediaLink,
} from "../../domain/public-campaign-resource.ts";
import { renderSafeMarkdownHtml } from "../../domain/safe-markdown-html.ts";
import { StorageFailure } from "../../domain/storage-adapter.ts";
import { negotiateRepresentation } from "../../http/content-negotiation.ts";
import type { PackageVersionRepository } from "../../repositories/in-memory-content-repository.ts";
import type { ApplicationRouteHandler } from "../contracts.ts";
import {
  hypermediaResponse,
  notAcceptableResponse,
} from "./responses.ts";

export type ParticipantPackageRepositoryFactory = (
  participantSubject: ActorSubject,
) => Pick<PackageVersionRepository, "current">;

export type ParticipantPackageReaderDependencies = Readonly<{
  repositoryFor: ParticipantPackageRepositoryFactory;
}>;

/** Create the registered-reader resource without installing global persistence. */
export function createParticipantPackageReaderRouteHandler(
  dependencies: ParticipantPackageReaderDependencies,
): ApplicationRouteHandler {
  if (typeof dependencies.repositoryFor !== "function") {
    throw new Error("Invalid participant package reader configuration.");
  }

  return async (context) => {
    if (context.url.pathname !== PRIVATE_PACKAGE_PATH) return null;
    const representation = negotiateRepresentation(
      context.request.headers.get("accept"),
    );
    if (representation.kind === "not-acceptable") {
      return notAcceptableResponse(context.resourceUrl);
    }

    if (context.request.method !== "GET") {
      const response = errorResponse(
        methodNotAllowed(context.resourceUrl),
        representation.kind,
      );
      const headers = new Headers(response.headers);
      headers.set("Allow", "GET");
      return new Response(response.body, {
        status: response.status,
        headers,
      });
    }

    try {
      const subject = requiredParticipantSubject(context);
      const query = parsePageQuery(context.url);
      const repository = requiredRepository(dependencies.repositoryFor, subject);
      const current = await repository.current();
      if (current === null) notFound();
      if (
        !Number.isSafeInteger(current.revision) ||
        current.revision < 1 ||
        context.participantAccess?.currentPackage === null ||
        context.participantAccess?.currentPackage.id !== current.snapshot.id ||
        context.participantAccess.currentPackage.createdAt !==
          current.snapshot.createdAt ||
        context.participantAccess.currentPackage.changeSummary !==
          current.snapshot.changeSummary ||
        context.participantAccess.currentPackage.materialChange !==
          current.snapshot.materialChange
      ) {
        unavailable();
      }

      const page = createParticipantPackagePage({
        requestUrl: context.resourceUrl,
        version: current.snapshot,
        acceptanceRequired:
          context.participantAccess.currentPackage.requiresCurrentAcceptance,
        limit: query.limit,
        after: query.after,
      });
      if (page === null) invalidRequest();

      return representation.kind === "hypermedia-json"
        ? hypermediaResponse(page.document)
        : participantPackageHtmlResponse(
            page,
            context.campaign?.name ?? "Campaign",
          );
    } catch (error) {
      return errorResponse(
        publicReaderError(error, context.resourceUrl),
        representation.kind,
      );
    }
  };
}

function requiredParticipantSubject(
  context: Parameters<ApplicationRouteHandler>[0],
): ActorSubject {
  if (context.actor === null) authenticationRequired();
  const access = context.participantAccess;
  if (
    context.isOwner ||
    access === null ||
    access.accountStatus !== "active"
  ) {
    notFound();
  }
  const subject = parseActorSubject(context.actor.userId);
  if (!subject.ok || subject.value !== access.subject) {
    notFound();
  }
  return subject.value;
}

function requiredRepository(
  factory: ParticipantPackageRepositoryFactory,
  subject: ActorSubject,
): Pick<PackageVersionRepository, "current"> {
  let repository: Pick<PackageVersionRepository, "current">;
  try {
    repository = factory(subject);
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
  if (
    typeof repository !== "object" ||
    repository === null ||
    typeof repository.current !== "function"
  ) {
    unavailable();
  }
  return repository;
}

function parsePageQuery(url: URL): Readonly<{ limit: number; after: string | null }> {
  for (const key of url.searchParams.keys()) {
    if (key !== "limit" && key !== "after") invalidRequest();
  }
  if (
    url.searchParams.getAll("limit").length > 1 ||
    url.searchParams.getAll("after").length > 1
  ) {
    invalidRequest();
  }

  const limitValue = url.searchParams.get("limit");
  const limit = limitValue === null
    ? PARTICIPANT_PACKAGE_PAGE_LIMITS.defaultSections
    : /^(?:[1-9]|1[0-6])$/u.test(limitValue)
    ? Number(limitValue)
    : null;
  if (limit === null) invalidRequest();
  const after = url.searchParams.get("after");
  if (after !== null && (after.length < 1 || after.length > 127)) {
    invalidRequest();
  }
  return Object.freeze({ limit, after });
}

type ReaderErrorDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "error";
  id: string;
  data: Readonly<{ code: string; message: string }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

type ReaderError = Readonly<{
  status: number;
  document: ReaderErrorDocument;
}>;

function publicReaderError(error: unknown, requestUrl: string): ReaderError {
  if (error instanceof StorageFailure) {
    switch (error.code) {
      case "INVALID_REQUEST":
        return readerError(
          requestUrl,
          400,
          "invalid_request",
          "Check the package page request and try again.",
        );
      case "NOT_FOUND":
        return readerError(
          requestUrl,
          404,
          "not_found",
          "The requested resource was not found.",
        );
      case "CONFLICT":
      case "PRECONDITION_FAILED":
        return readerError(
          requestUrl,
          409,
          "conflict",
          "The information package changed. Reload and try again.",
        );
      case "UNAVAILABLE":
        break;
    }
  }
  if (error instanceof ParticipantPackageAuthenticationRequired) {
    return authenticationError(requestUrl);
  }
  return readerError(
    requestUrl,
    503,
    "service_unavailable",
    "The information package is temporarily unavailable.",
  );
}

function authenticationError(requestUrl: string): ReaderError {
  const signInUrl = new URL(
    chatGPTSignInPath(PRIVATE_PACKAGE_PATH),
    requestUrl,
  ).href;
  return readerError(
    requestUrl,
    401,
    "authentication_required",
    "Sign in and complete access registration to read this package.",
    [{
      name: "sign-in",
      title: "Sign in",
      method: "GET",
      href: signInUrl,
      type: "text/html",
      fields: [],
    }],
  );
}

function methodNotAllowed(requestUrl: string): ReaderError {
  return readerError(
    requestUrl,
    405,
    "method_not_allowed",
    "This request method is not available for the information package.",
  );
}

function readerError(
  requestUrl: string,
  status: number,
  code: string,
  message: string,
  actions: readonly HypermediaAction[] = [],
): ReaderError {
  const self = new URL(PRIVATE_PACKAGE_PATH, requestUrl).href;
  return Object.freeze({
    status,
    document: Object.freeze({
      api_version: INVESTOR_APP_API_VERSION,
      type: "error",
      id: code,
      data: Object.freeze({ code, message }),
      links: Object.freeze([
        Object.freeze({ rel: Object.freeze(["self"]), href: self }),
        Object.freeze({
          rel: Object.freeze(["campaign"]),
          href: new URL("/", requestUrl).href,
        }),
      ]),
      actions: Object.freeze([...actions]),
    }),
  });
}

function errorResponse(
  error: ReaderError,
  representation: "html" | "hypermedia-json",
): Response {
  return representation === "hypermedia-json"
    ? hypermediaResponse(error.document, error.status)
    : participantPackageErrorHtmlResponse(error.document, error.status);
}

function participantPackageHtmlResponse(
  page: ParticipantPackagePage,
  campaignName: string,
): Response {
  const data = page.document.data;
  const sections = page.sections.length === 0
    ? `<p class="package-reader-empty">No sections are available in this package.</p>`
    : page.sections.map((section) => `
      <section class="package-reader-section" aria-labelledby="section-${escapeAttribute(section.id)}">
        <h2 id="section-${escapeAttribute(section.id)}">${escapeHtml(section.title)}</h2>
        <div class="package-reader-markdown">${
          renderSafeMarkdownHtml(section.markdown, { headingOffset: 2 })
        }</div>
      </section>`).join("");
  const nextLink = page.document.links.find((link) => link.rel.includes("next"));
  const acceptance = data.acceptance_required
    ? `<p class="package-reader-status package-reader-status--required"><strong>Acknowledgment required.</strong> Review the current text before submitting an indication.</p>`
    : `<p class="package-reader-status"><strong>Acknowledgment current.</strong> Your latest acceptance satisfies this package requirement.</p>`;

  return htmlResponse(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(campaignName)} information package</title>
  <link rel="stylesheet" href="/participant-package.css">
</head>
<body class="package-reader-page">
  <header class="package-reader-header"><a href="/">${escapeHtml(campaignName)}</a><a href="${PARTICIPANT_HOME_PATH}">Your participation</a></header>
  <main class="package-reader-main">
    <header class="package-reader-title">
      <p>Information package</p>
      <h1>${escapeHtml(campaignName)}</h1>
      <dl>
        <div><dt>Updated</dt><dd><time datetime="${escapeAttribute(data.created_at)}">${escapeHtml(data.created_at)}</time></dd></div>
        <div><dt>Change</dt><dd>${escapeHtml(data.change_summary)}</dd></div>
        <div><dt>Classification</dt><dd>${data.material_change ? "Material" : "Editorial"}</dd></div>
      </dl>
      ${acceptance}
    </header>
    <div class="package-reader-sections">${sections}</div>
    <section class="package-reader-acknowledgment" aria-labelledby="package-acknowledgment-title">
      <h2 id="package-acknowledgment-title">Acknowledgment</h2>
      <p>${escapeHtml(data.acknowledgment_text)}</p>
    </section>
    <nav class="package-reader-pagination" aria-label="Package pages"><a href="${PARTICIPANT_HOME_PATH}">Back to your participation</a>${nextLink ? `<a class="package-reader-next" href="${escapeAttribute(nextLink.href)}">Continue reading</a>` : ""}</nav>
  </main>
</body>
</html>`);
}

function participantPackageErrorHtmlResponse(
  document: ReaderErrorDocument,
  status: number,
): Response {
  const signIn = document.actions.find((action) => action.name === "sign-in");
  return htmlResponse(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Information package</title>
  <link rel="stylesheet" href="/participant-package.css">
</head>
<body class="package-reader-page">
  <header class="package-reader-header"><a href="/">Campaign</a><span>Information package</span></header>
  <main class="package-reader-main package-reader-error">
    <p>Information package</p>
    <h1>Package unavailable</h1>
    <p>${escapeHtml(document.data.message)}</p>
    <div>${signIn ? `<a class="package-reader-next" href="${escapeAttribute(signIn.href)}">Sign in</a>` : ""}<a href="/">Return to campaign</a></div>
  </main>
</body>
</html>`, status);
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; img-src 'self' https:; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Cross-Origin-Resource-Policy": "same-origin",
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

class ParticipantPackageAuthenticationRequired extends Error {}

function authenticationRequired(): never {
  throw new ParticipantPackageAuthenticationRequired();
}

function invalidRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
}

function notFound(): never {
  throw new StorageFailure("NOT_FOUND");
}

function unavailable(): never {
  throw new StorageFailure("UNAVAILABLE");
}
