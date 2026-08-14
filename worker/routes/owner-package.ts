import { chatGPTSignInPath } from "../../domain/auth-navigation.ts";
import {
  parseActorSubject,
} from "../../domain/foundation.ts";
import {
  createOwnerPackagePreviewDocument,
  createOwnerPackageResourceModel,
  type OperationIdIssuer,
} from "../../domain/owner-package-resource.ts";
import {
  INVESTOR_APP_API_VERSION,
  type HypermediaAction,
  type HypermediaLink,
} from "../../domain/public-campaign-resource.ts";
import {
  StorageFailure,
  parseStorageOperationId,
  type StorageOperationId,
} from "../../domain/storage-adapter.ts";
import { negotiateRepresentation } from "../../http/content-negotiation.ts";
import {
  MUTATION_CSRF_HEADER,
  MutationSecurityFailure,
  toPublicMutationSecurityFailure,
  type VerifiedMutationRequest,
} from "../../http/mutation-security.ts";
import type { BrowserMutationProof } from "../../http/browser-mutation-session.ts";
import type {
  OwnerPackageWorkspaceService,
  TrustedOwnerActor,
} from "../../services/owner-package-workspace.ts";
import type {
  ApplicationRouteContext,
  ApplicationRouteHandler,
} from "../contracts.ts";
import {
  hypermediaResponse,
  notAcceptableResponse,
  resourceNotFoundResponse,
} from "./responses.ts";
import {
  ownerPackageFailureHtmlResponse,
  ownerPackagePreviewHtmlResponse,
  ownerPackageWorkspaceHtmlResponse,
} from "./owner-package-html.ts";

export type OwnerPackageCsrfTokenProvider = (
  request: Request,
  actor: TrustedOwnerActor,
) => Promise<string | BrowserMutationProof | null>;

export type OwnerPackageMutationVerifier = (
  request: Request,
) => Promise<
  VerifiedMutationRequest & Readonly<{ clearCookie?: string }>
>;

export type OwnerPackageRouteDependencies = Readonly<{
  workspace: OwnerPackageWorkspaceService;
  verifyMutation: OwnerPackageMutationVerifier;
  csrfToken: OwnerPackageCsrfTokenProvider;
  issueOperationId: OperationIdIssuer;
}>;

type Representation = "html" | "hypermedia-json";
type PackageMutationRoute = Readonly<{
  method: "POST" | "PATCH";
  sectionId?: string;
  transition:
    | "create-section"
    | "update-section"
    | "set-section-enabled"
    | "move-section"
    | "update-settings";
}>;

type MutationBodySchema = Readonly<{
  required: readonly string[];
  optional: readonly string[];
}>;

const VERSION_REQUIRED_BODY_FIELDS = Object.freeze([
  "operation-id",
  "expected-revision",
  "change-summary",
]);
const VERSION_OPTIONAL_BODY_FIELDS = Object.freeze(["material-change"]);

/** Supports every domain-valid Unicode package form without inheriting 1 MiB setup limits. */
export const MAX_OWNER_PACKAGE_MUTATION_BYTES = 524_288;
export const MAX_OWNER_PACKAGE_MUTATION_FIELDS = 9;

export function createOwnerPackageRouteHandler(
  dependencies: OwnerPackageRouteDependencies,
): ApplicationRouteHandler {
  return async (context) => {
    if (!isOwnerPackagePath(context.url.pathname)) return null;

    const negotiated = negotiateRepresentation(
      context.request.headers.get("accept"),
    );
    if (negotiated.kind === "not-acceptable") {
      return notAcceptableResponse(context.resourceUrl);
    }
    const representation = negotiated.kind;
    const actor = ownerActor(context);
    if (actor === null) {
      return unauthorizedOwnerPackageResponse(context, representation);
    }

    if (
      context.request.method === "GET" &&
      context.url.pathname === "/owner/package"
    ) {
      return readWorkspace(context, actor, representation, dependencies);
    }
    if (
      context.request.method === "GET" &&
      context.url.pathname === "/owner/package/preview"
    ) {
      return readPreview(context, actor, representation, dependencies);
    }

    const mutationRoute = matchMutationRoute(context);
    if (mutationRoute === null) {
      return failureResponse(
        representation,
        context.resourceUrl,
        404,
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    }
    return mutateWorkspace(
      context,
      actor,
      representation,
      mutationRoute,
      dependencies,
    );
  };
}

async function readWorkspace(
  context: ApplicationRouteContext,
  actor: TrustedOwnerActor,
  representation: Representation,
  dependencies: OwnerPackageRouteDependencies,
): Promise<Response> {
  try {
    const state = await dependencies.workspace.read(actor);
    const model = createOwnerPackageResourceModel(
      context.resourceUrl,
      state,
      checkedOperationIssuer(dependencies.issueOperationId),
    );
    const csrf = requiredCsrfProof(
      await dependencies.csrfToken(context.request, actor),
    );
    if (representation === "hypermedia-json") {
      const response = hypermediaResponse(model.document);
      response.headers.set(MUTATION_CSRF_HEADER, csrf.token);
      return withSetCookie(response, csrf.setCookie);
    }

    return withSetCookie(
      ownerPackageWorkspaceHtmlResponse(model, csrf.token),
      csrf.setCookie,
    );
  } catch (error) {
    return mappedFailureResponse(representation, context.resourceUrl, error);
  }
}

async function readPreview(
  context: ApplicationRouteContext,
  actor: TrustedOwnerActor,
  representation: Representation,
  dependencies: OwnerPackageRouteDependencies,
): Promise<Response> {
  try {
    const preview = await dependencies.workspace.preview(actor);
    if (preview === null) throw new StorageFailure("NOT_FOUND");
    const document = createOwnerPackagePreviewDocument(
      context.resourceUrl,
      preview,
    );
    return representation === "hypermedia-json"
      ? hypermediaResponse(document)
      : ownerPackagePreviewHtmlResponse(document);
  } catch (error) {
    return mappedFailureResponse(representation, context.resourceUrl, error);
  }
}

async function mutateWorkspace(
  context: ApplicationRouteContext,
  actor: TrustedOwnerActor,
  representation: Representation,
  route: PackageMutationRoute,
  dependencies: OwnerPackageRouteDependencies,
): Promise<Response> {
  let clearCookie: string | null = null;
  try {
    const verified = await dependencies.verifyMutation(context.request);
    clearCookie = validSetCookie(verified.clearCookie)
      ? verified.clearCookie
      : null;
    if (
      verified.actor.type !== "owner" ||
      verified.actor.subject !== actor.subject
    ) {
      throw new StorageFailure("NOT_FOUND");
    }
    if (verified.method !== route.method) {
      throw new MutationSecurityFailure("INVALID_REQUEST");
    }
    assertMutationBodyKeys(verified.body, route.transition);

    const metadata = {
      operationId: verified.body["operation-id"],
      expectedRevision: verified.body["expected-revision"],
      changeSummary: verified.body["change-summary"],
      materialChange: verified.body["material-change"],
    };
    switch (route.transition) {
      case "create-section":
        await dependencies.workspace.createSection(actor, {
          ...metadata,
          title: verified.body.title,
          markdown: verified.body.markdown ?? "",
          enabled: verified.body.enabled,
          acknowledgmentText: verified.body["acknowledgment-text"],
        });
        break;
      case "update-section":
        await dependencies.workspace.updateSection(actor, {
          ...metadata,
          sectionId: route.sectionId,
          title: verified.body.title,
          markdown: verified.body.markdown ?? "",
        });
        break;
      case "set-section-enabled":
        await dependencies.workspace.setSectionEnabled(actor, {
          ...metadata,
          sectionId: route.sectionId,
          enabled: verified.body.enabled,
        });
        break;
      case "move-section":
        await dependencies.workspace.moveSection(actor, {
          ...metadata,
          sectionId: route.sectionId,
          direction: verified.body.direction,
        });
        break;
      case "update-settings":
        await dependencies.workspace.updateSettings(actor, {
          ...metadata,
          acknowledgmentText: verified.body["acknowledgment-text"],
        });
        break;
    }

    if (representation === "html") {
      return withSetCookie(new Response(null, {
        status: 303,
        headers: {
          "Cache-Control": "no-store",
          Location: new URL("/owner/package", context.resourceUrl).href,
          Vary: "Accept",
        },
      }), clearCookie);
    }

    const state = await dependencies.workspace.read(actor);
    const model = createOwnerPackageResourceModel(
      context.resourceUrl,
      state,
      checkedOperationIssuer(dependencies.issueOperationId),
    );
    const csrf = requiredCsrfProof(
      await dependencies.csrfToken(context.request, actor),
    );
    const response = hypermediaResponse(model.document);
    response.headers.set(MUTATION_CSRF_HEADER, csrf.token);
    return withSetCookies(response, [clearCookie, csrf.setCookie]);
  } catch (error) {
    return withSetCookie(
      mappedFailureResponse(representation, context.resourceUrl, error),
      clearCookie,
    );
  }
}

function assertMutationBodyKeys(
  body: Readonly<Record<string, unknown>>,
  transition: PackageMutationRoute["transition"],
): void {
  const schema = mutationBodySchema(transition);
  const allowed = new Set([...schema.required, ...schema.optional]);
  if (
    schema.required.some((field) => !Object.hasOwn(body, field)) ||
    Object.keys(body).some((field) => !allowed.has(field))
  ) {
    throw new MutationSecurityFailure("INVALID_REQUEST");
  }
}

function mutationBodySchema(
  transition: PackageMutationRoute["transition"],
): MutationBodySchema {
  switch (transition) {
    case "create-section":
      return {
        required: [...VERSION_REQUIRED_BODY_FIELDS, "title"],
        optional: [
          ...VERSION_OPTIONAL_BODY_FIELDS,
          "markdown",
          "enabled",
          "acknowledgment-text",
        ],
      };
    case "update-section":
      return {
        required: [...VERSION_REQUIRED_BODY_FIELDS, "title"],
        optional: [...VERSION_OPTIONAL_BODY_FIELDS, "markdown"],
      };
    case "set-section-enabled":
      return {
        required: VERSION_REQUIRED_BODY_FIELDS,
        optional: [...VERSION_OPTIONAL_BODY_FIELDS, "enabled"],
      };
    case "move-section":
      return {
        required: [...VERSION_REQUIRED_BODY_FIELDS, "direction"],
        optional: VERSION_OPTIONAL_BODY_FIELDS,
      };
    case "update-settings":
      return {
        required: [
          ...VERSION_REQUIRED_BODY_FIELDS,
          "acknowledgment-text",
        ],
        optional: VERSION_OPTIONAL_BODY_FIELDS,
      };
  }
}

function ownerActor(
  context: ApplicationRouteContext,
): TrustedOwnerActor | null {
  if (!context.actor || !context.isOwner) return null;
  const subject = parseActorSubject(context.actor.userId);
  return subject.ok
    ? Object.freeze({ type: "owner", subject: subject.value })
    : null;
}

function unauthorizedOwnerPackageResponse(
  context: ApplicationRouteContext,
  representation: Representation,
): Response {
  if (context.actor !== null) {
    return representation === "hypermedia-json"
      ? resourceNotFoundResponse(context.resourceUrl)
      : ownerPackageFailureHtmlResponse(
          404,
          "Not found",
          "The requested resource was not found.",
        );
  }
  if (representation === "html") {
    const location = new URL(
      chatGPTSignInPath(context.url.pathname),
      context.resourceUrl,
    ).href;
    return new Response(null, {
      status: 302,
      headers: { "Cache-Control": "no-store", Location: location, Vary: "Accept" },
    });
  }

  return hypermediaResponse(
    authenticationRequiredDocument(context.resourceUrl),
    401,
  );
}

function authenticationRequiredDocument(requestUrl: string): Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "error";
  id: "authentication-required";
  data: Readonly<{ code: "authentication_required"; message: string }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}> {
  const absolute = (href: string) => new URL(href, requestUrl).href;
  return {
    api_version: INVESTOR_APP_API_VERSION,
    type: "error",
    id: "authentication-required",
    data: {
      code: "authentication_required",
      message: "Sign in is required to continue.",
    },
    links: [
      { rel: ["self"], href: new URL(requestUrl).href },
      {
        rel: ["workspace"],
        href: new URL("/owner/package", requestUrl).href,
      },
    ],
    actions: [{
      name: "sign-in",
      title: "Sign in",
      href: absolute(chatGPTSignInPath(new URL(requestUrl).pathname)),
      method: "GET",
      type: "text/html",
      fields: [],
    }],
  };
}

function matchMutationRoute(
  context: ApplicationRouteContext,
): PackageMutationRoute | null {
  const path = context.url.pathname;
  if (path === "/owner/package/sections") {
    return context.request.method === "POST"
      ? { transition: "create-section", method: "POST" }
      : null;
  }
  if (path === "/owner/package/settings") {
    return mutationTransportMethod(context.request.method)
      ? { transition: "update-settings", method: "PATCH" }
      : null;
  }

  const match = /^\/owner\/package\/sections\/([^/]+?)(?:\/(availability|order))?$/.exec(path);
  if (!match || !mutationTransportMethod(context.request.method)) return null;
  const sectionId = decodedSegment(match[1]);
  if (sectionId === null) return null;
  if (match[2] === "availability") {
    return { transition: "set-section-enabled", method: "PATCH", sectionId };
  }
  if (match[2] === "order") {
    return { transition: "move-section", method: "PATCH", sectionId };
  }
  return { transition: "update-section", method: "PATCH", sectionId };
}

function mutationTransportMethod(method: string): boolean {
  return method === "POST" || method === "PATCH";
}

function decodedSegment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isOwnerPackagePath(pathname: string): boolean {
  return pathname === "/owner/package" || pathname.startsWith("/owner/package/");
}

function checkedOperationIssuer(
  issueOperationId: OperationIdIssuer,
): () => StorageOperationId {
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

function validCsrfToken(value: string | null): value is string {
  return value !== null &&
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

function mappedFailureResponse(
  representation: Representation,
  requestUrl: string,
  error: unknown,
): Response {
  if (error instanceof MutationSecurityFailure) {
    const failure = toPublicMutationSecurityFailure(error);
    return failureResponse(
      representation,
      requestUrl,
      failure.status,
      failure.body.error.code,
      failure.body.error.message,
    );
  }
  if (error instanceof StorageFailure) {
    const failure = storageFailure(error.code);
    return failureResponse(
      representation,
      requestUrl,
      failure.status,
      error.code,
      failure.message,
    );
  }
  return failureResponse(
    representation,
    requestUrl,
    503,
    "UNAVAILABLE",
    "The service is temporarily unavailable.",
  );
}

function storageFailure(code: StorageFailure["code"]): Readonly<{
  status: number;
  message: string;
}> {
  switch (code) {
    case "INVALID_REQUEST":
      return { status: 400, message: "The request is invalid." };
    case "NOT_FOUND":
      return { status: 404, message: "The requested resource was not found." };
    case "CONFLICT":
      return { status: 409, message: "The request conflicts with current state." };
    case "PRECONDITION_FAILED":
      return { status: 412, message: "A required condition has changed." };
    case "UNAVAILABLE":
      return { status: 503, message: "The service is temporarily unavailable." };
  }
}

function failureResponse(
  representation: Representation,
  requestUrl: string,
  status: number,
  code: string,
  message: string,
): Response {
  if (representation === "html") {
    return ownerPackageFailureHtmlResponse(status, failureTitle(status), message);
  }
  return hypermediaResponse({
    api_version: INVESTOR_APP_API_VERSION,
    type: "error",
    id: "request-failed",
    data: { code, message },
    links: [{ rel: ["self"], href: new URL(requestUrl).href }],
    actions: [],
  }, status);
}

function failureTitle(status: number): string {
  if (status === 400) return "Invalid request";
  if (status === 401) return "Sign in required";
  if (status === 404) return "Not found";
  if (status === 409 || status === 412) return "Package changed";
  return "Service unavailable";
}
