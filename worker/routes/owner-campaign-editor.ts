import { chatGPTSignInPath } from "../../domain/auth-navigation.ts";
import type { DeploymentPublicationReadinessCheck } from "../../domain/campaign-publication-readiness.ts";
import {
  CAMPAIGN_PUBLICATION_FIELD_NAMES,
  OWNER_CAMPAIGN_EDITOR_PATH,
  OWNER_CAMPAIGN_PREVIEW_PATH,
  OWNER_CAMPAIGN_PUBLICATION_PATH,
  createOwnerCampaignEditorResource,
  createOwnerCampaignPreviewDocument,
  type OwnerCampaignEditorResource,
} from "../../domain/owner-campaign-editor-resource.ts";
import { INVESTOR_APP_API_VERSION } from "../../domain/public-campaign-resource.ts";
import {
  StorageFailure,
  parseStorageOperationId,
} from "../../domain/storage-adapter.ts";
import { negotiateRepresentation } from "../../http/content-negotiation.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  MutationSecurityFailure,
  toPublicMutationSecurityFailure,
  type MutationMediaType,
} from "../../http/mutation-security.ts";
import type {
  BrowserMutationProof,
  BrowserMutationSession,
} from "../../http/browser-mutation-session.ts";
import type {
  CampaignSetupRevision,
} from "../../repositories/in-memory-campaign-repository.ts";
import {
  CampaignPublicationNotReady,
  createOwnerCampaignEditorService,
  type OwnerCampaignEditorRepository,
  type OwnerCampaignEditorService,
} from "../../services/owner-campaign-editor.ts";
import type { ApplicationRouteHandler } from "../contracts.ts";
import {
  hypermediaResponse,
  notAcceptableResponse,
} from "./responses.ts";
import {
  parseCampaignPresentationMutation,
  renderCampaignPresentationForm,
} from "./owner-campaign-editor-form.ts";

type Representation = "html" | "hypermedia-json";
type OperationKind = "save" | "publish" | "unpublish";

const PUBLICATION_KEYS = new Set<string>(CAMPAIGN_PUBLICATION_FIELD_NAMES);
export const OWNER_CAMPAIGN_MUTATION_MAX_BYTES = 262_144;
export const OWNER_CAMPAIGN_MUTATION_MAX_FIELDS = 256;

export type OwnerCampaignEditorRouteOptions = Readonly<{
  repository: OwnerCampaignEditorRepository;
  checkPublicationReadiness: DeploymentPublicationReadinessCheck;
  mutationSession: BrowserMutationSession;
  appOrigin: string;
  issueOperationId?: (kind: OperationKind) => string;
  now?: () => Date;
}>;

export function createOwnerCampaignEditorRouteHandler(
  options: OwnerCampaignEditorRouteOptions,
): ApplicationRouteHandler {
  const service = createOwnerCampaignEditorService(
    options.repository,
    options.checkPublicationReadiness,
  );
  const issueOperationId = options.issueOperationId ?? defaultOperationId;
  const now = options.now ?? (() => new Date());

  return async (context) => {
    if (!isCampaignEditorPath(context.url.pathname)) return null;
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
        context.url.pathname,
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

    let clearCookie: string | null = null;
    try {
      if (context.url.pathname === OWNER_CAMPAIGN_PREVIEW_PATH) {
        if (context.request.method !== "GET") {
          return methodNotAllowed(representation, context.resourceUrl, "GET");
        }
        const current = await requiredCurrent(service);
        const preview = createOwnerCampaignPreviewDocument(
          context.resourceUrl,
          current,
        );
        if (representation === "hypermedia-json") {
          return hypermediaResponse(preview);
        }
        const previewRequest = new Request(
          new URL("/", context.request.url),
          context.request,
        );
        return previewResponse(await context.renderApplication({
          request: previewRequest,
          campaign: preview.data.public_campaign,
          preview: {
            sourceRevision: preview.data.source_revision,
            sourcePublication: preview.data.source_publication,
          },
        }));
      }

      if (context.url.pathname === OWNER_CAMPAIGN_EDITOR_PATH) {
        if (context.request.method !== "GET" && context.request.method !== "POST") {
          return methodNotAllowed(representation, context.resourceUrl, "GET, POST");
        }
        if (context.request.method === "POST") {
          assertMutationAvailable(service.mutationConsistency);
          const verified = await verifiedOwnerMutation(
            options.mutationSession,
            context.request,
            context.actor.userId,
            options.appOrigin,
          );
          clearCookie = requiredClearMutationCookie(verified.clearCookie);
          const mutation = parseCampaignPresentationMutation(
            verified.body,
            verified.mediaType,
          );
          await service.savePresentation({
            ...mutation,
            ownerSubject: verified.actor.subject,
            recordedAt: currentTimestamp(now),
          });
          return mutationSuccessResponse(
            representation,
            context.resourceUrl,
            context.request,
            await requiredCurrent(service),
            service,
            options,
            issueOperationId,
            context.actor.userId,
            clearCookie,
          );
        }
      } else {
        if (context.request.method !== "POST") {
          return methodNotAllowed(representation, context.resourceUrl, "POST");
        }
        assertMutationAvailable(service.mutationConsistency);
        const verified = await verifiedOwnerMutation(
          options.mutationSession,
          context.request,
          context.actor.userId,
          options.appOrigin,
        );
        clearCookie = requiredClearMutationCookie(verified.clearCookie);
        const mutation = parsePublicationMutation(
          verified.body,
          verified.mediaType,
        );
        await service.setPublication({
          operationId: mutation.operationId,
          expectedRevision: mutation.expectedRevision,
          ownerSubject: verified.actor.subject,
          recordedAt: currentTimestamp(now),
          published: mutation.command === "publish",
        });
        return mutationSuccessResponse(
          representation,
          context.resourceUrl,
          context.request,
          await requiredCurrent(service),
          service,
          options,
          issueOperationId,
          context.actor.userId,
          clearCookie,
        );
      }

      return await editorResponse(
        representation,
        context.resourceUrl,
        context.request,
        await service.read(),
        service,
        options,
        issueOperationId,
        context.actor.userId,
      );
    } catch (error) {
      if (error instanceof MutationSecurityFailure) {
        const failure = toPublicMutationSecurityFailure(error);
        return withOptionalClearedMutationCookie(errorResponse(
          representation,
          context.resourceUrl,
          failure.status,
          failure.body.error.code.toLowerCase(),
          failure.body.error.message,
        ), clearCookie);
      }
      if (error instanceof CampaignPublicationNotReady) {
        return withOptionalClearedMutationCookie(errorResponse(
          representation,
          context.resourceUrl,
          412,
          "publication_not_ready",
          "Complete the campaign publication requirements before publishing.",
        ), clearCookie);
      }
      const failure = storageError(error);
      return withOptionalClearedMutationCookie(errorResponse(
        representation,
        context.resourceUrl,
        failure.status,
        failure.code,
        failure.message,
      ), clearCookie);
    }
  };
}

function isCampaignEditorPath(pathname: string): boolean {
  return pathname === OWNER_CAMPAIGN_EDITOR_PATH ||
    pathname === OWNER_CAMPAIGN_PUBLICATION_PATH ||
    pathname === OWNER_CAMPAIGN_PREVIEW_PATH;
}

async function verifiedOwnerMutation(
  session: BrowserMutationSession,
  request: Request,
  expectedSubject: string,
  appOrigin: string,
) {
  const verified = await session.verifyMutation(
    request,
    { type: "owner", subject: expectedSubject },
    appOrigin,
    {
      maxBodyBytes: OWNER_CAMPAIGN_MUTATION_MAX_BYTES,
      maxFields: OWNER_CAMPAIGN_MUTATION_MAX_FIELDS,
    },
  );
  if (
    verified.method !== "POST" ||
    verified.actor.type !== "owner" ||
    verified.actor.subject !== expectedSubject
  ) {
    throw new MutationSecurityFailure("REQUEST_REJECTED");
  }
  return verified;
}

function assertMutationAvailable(consistency: string): void {
  if (consistency !== "atomic-campaign-audit") {
    throw new StorageFailure("UNAVAILABLE");
  }
}

type ParsedPublicationMutation = Readonly<{
  operationId: string;
  expectedRevision: number;
  command: "publish" | "unpublish";
}>;

function parsePublicationMutation(
  body: Readonly<Record<string, unknown>>,
  mediaType: MutationMediaType,
): ParsedPublicationMutation {
  assertExactKeys(body, PUBLICATION_KEYS);
  const command = body["publication-command"];
  if (command !== "publish" && command !== "unpublish") {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return Object.freeze({
    operationId: requiredOperationId(body["operation-id"]),
    expectedRevision: requiredPositiveInteger(
      body["expected-revision"],
      mediaType,
    ),
    command,
  });
}

function assertExactKeys(
  body: Readonly<Record<string, unknown>>,
  expected: ReadonlySet<string>,
): void {
  const keys = Object.keys(body);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new StorageFailure("INVALID_REQUEST");
  }
}

function requiredPositiveInteger(
  value: unknown,
  mediaType: MutationMediaType,
): number {
  const parsed = mediaType === "application/x-www-form-urlencoded"
    ? typeof value === "string" && /^[1-9]\d*$/.test(value)
      ? Number(value)
      : Number.NaN
    : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 1) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return parsed as number;
}

function requiredOperationId(value: unknown): string {
  const parsed = parseStorageOperationId(value);
  if (!parsed.ok) throw new StorageFailure("INVALID_REQUEST");
  return parsed.value;
}

function currentTimestamp(now: () => Date): string {
  let value: Date;
  try {
    value = now();
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return value.toISOString();
}

function defaultOperationId(kind: OperationKind): string {
  try {
    return `campaign-${kind}:${crypto.randomUUID()}`;
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
}

async function requiredCurrent(
  service: OwnerCampaignEditorService,
): Promise<CampaignSetupRevision> {
  const current = await service.read();
  if (current === null) throw new StorageFailure("NOT_FOUND");
  return current;
}

async function editorResponse(
  representation: Representation,
  requestUrl: string,
  request: Request,
  current: CampaignSetupRevision | null,
  service: OwnerCampaignEditorService,
  options: OwnerCampaignEditorRouteOptions,
  issueOperationId: (kind: OperationKind) => string,
  ownerSubject: string,
): Promise<Response> {
  const readiness = current === null
    ? null
    : await service.publicationReadiness(current);
  const resource = createOwnerCampaignEditorResource(
    requestUrl,
    current,
    readiness,
    service.mutationConsistency,
    operationIds(
      current !== null && service.mutationConsistency === "atomic-campaign-audit",
      issueOperationId,
      current,
    ),
  );
  const proof = resource.presentationForm || resource.publicationForm
    ? requiredMutationProof(await options.mutationSession.issue(
        request,
        { type: "owner", subject: ownerSubject },
        options.appOrigin,
      ))
    : null;
  const response = representation === "hypermedia-json"
    ? hypermediaResponse(resource.document)
    : htmlResponse(renderEditor(resource, proof?.token ?? null));
  return proof === null ? response : withMutationProof(response, proof);
}

async function mutationSuccessResponse(
  representation: Representation,
  requestUrl: string,
  request: Request,
  current: CampaignSetupRevision,
  service: OwnerCampaignEditorService,
  options: OwnerCampaignEditorRouteOptions,
  issueOperationId: (kind: OperationKind) => string,
  ownerSubject: string,
  clearCookie: string,
): Promise<Response> {
  const editorUrl = new URL(OWNER_CAMPAIGN_EDITOR_PATH, requestUrl).href;
  if (representation === "html") {
    return withClearedMutationCookie(new Response(null, {
      status: 303,
      headers: {
        "Cache-Control": "no-store",
        Location: editorUrl,
        Vary: "Accept",
      },
    }), clearCookie);
  }
  return withClearedMutationCookie(await editorResponse(
    representation,
    editorUrl,
    request,
    current,
    service,
    options,
    issueOperationId,
    ownerSubject,
  ), clearCookie);
}

function operationIds(
  available: boolean,
  issueOperationId: (kind: OperationKind) => string,
  current: CampaignSetupRevision | null,
) {
  if (!available || current === null) {
    return Object.freeze({
      save: "campaign-save:unavailable",
      publication: "campaign-publication:unavailable",
    });
  }
  return Object.freeze({
    save: requiredOperationId(issueOperationId("save")),
    publication: requiredOperationId(
      issueOperationId(current.setup.publicCampaign.published ? "unpublish" : "publish"),
    ),
  });
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

function requiredMutationProof(value: BrowserMutationProof): BrowserMutationProof {
  requiredCsrfToken(value.token);
  if (
    typeof value.setCookie !== "string" ||
    value.setCookie.length < 1 ||
    value.setCookie.length > 4_096 ||
    /[\r\n]/u.test(value.setCookie)
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return value;
}

function requiredClearMutationCookie(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    /[\r\n]/u.test(value)
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return value;
}

function renderEditor(
  resource: OwnerCampaignEditorResource,
  csrf: string | null,
): string {
  const data = resource.document.data;
  const preview = resource.document.links.find((link) => link.rel.includes("preview"));
  const status = data.publication === "published" ? "Published" :
    data.publication === "unpublished" ? "Unpublished" : "Not configured";
  const unavailable = data.configured && data.mutation_consistency === "unavailable"
    ? `<p class="owner-campaign-notice">Saving and publication are temporarily unavailable.</p>`
    : "";
  const readiness = data.publication_readiness === null
    ? ""
    : data.publication_readiness.ready
      ? `<p class="owner-campaign-readiness owner-campaign-readiness-ready">Ready to publish</p>`
      : `<p class="owner-campaign-readiness">Publishing remains unavailable until the campaign setup is complete.</p>`;
  const content = data.configured
    ? `${unavailable}${resource.presentationForm && csrf ? renderCampaignPresentationForm(resource.presentationForm, csrf) : ""}`
    : `<section class="owner-campaign-empty"><h2>No campaign setup found</h2><p>Complete campaign setup before editing its public presentation.</p></section>`;

  return page(
    `${data.public_campaign?.name ?? "Campaign"} editor`,
    `<header class="owner-campaign-header"><a class="owner-campaign-brand" href="/owner">Owner workspace</a><nav aria-label="Campaign editor navigation"><a href="/">View public campaign</a>${preview ? `<a href="${escapeAttribute(preview.href)}">Preview saved draft</a>` : ""}</nav></header><main class="owner-campaign-main"><div class="owner-campaign-title"><div><p class="owner-campaign-kicker">Public campaign</p><h1>Campaign presentation</h1><p>Edit the information visitors see before signing in.</p></div><div class="owner-campaign-state"><span>${escapeHtml(status)}</span>${data.revision ? `<small>Saved revision ${data.revision}</small>` : ""}</div></div>${readiness}${content}${renderPublication(resource, csrf)}</main>`,
  );
}

function renderPublication(
  resource: OwnerCampaignEditorResource,
  csrf: string | null,
): string {
  const form = resource.publicationForm;
  const data = resource.document.data;
  if (!data.configured) return "";
  if (!form || !csrf) {
    return data.publication === "unpublished" && data.mutation_consistency !== "unavailable"
      ? `<section class="owner-campaign-publication" aria-labelledby="publication-title"><div><h2 id="publication-title">Publication</h2><p>Complete the campaign setup requirements before publishing this saved revision.</p></div></section>`
      : "";
  }
  const hidden = form.fields.map((field) => {
    const value = field.value ?? field.defaultValue ?? "";
    return `<input type="hidden" name="${escapeAttribute(field.name)}" value="${escapeAttribute(String(value))}">`;
  }).join("");
  const unpublish = form.name === "unpublish-campaign";
  return `<section class="owner-campaign-publication" aria-labelledby="publication-title"><div><h2 id="publication-title">Publication</h2><p>${unpublish ? "Unpublishing removes the campaign presentation from the public route." : "Publishing makes the saved presentation visible on the public route."}</p></div><form action="${escapeAttribute(form.action)}" method="post"><input type="hidden" name="${MUTATION_CSRF_FIELD}" value="${escapeAttribute(csrf)}">${hidden}<button class="${unpublish ? "owner-campaign-danger" : ""}" type="submit">${escapeHtml(form.title)}</button></form></section>`;
}

function authenticationRequiredResponse(
  representation: Representation,
  requestUrl: string,
  returnTo: string,
): Response {
  const signIn = new URL(chatGPTSignInPath(returnTo), requestUrl).href;
  if (representation === "html") {
    return htmlResponse(page(
      "Sign in",
      `<main class="owner-campaign-message"><h1>Sign in to continue</h1><p><a href="${escapeAttribute(signIn)}">Sign in</a></p></main>`,
    ), 401);
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
      method: "GET",
      href: signIn,
      type: "text/html",
      fields: [],
    }],
  }, 401);
}

function methodNotAllowed(
  representation: Representation,
  requestUrl: string,
  allow: string,
): Response {
  const response = errorResponse(
    representation,
    requestUrl,
    405,
    "method_not_allowed",
    "This request method is not supported.",
  );
  const headers = new Headers(response.headers);
  headers.set("Allow", allow);
  return new Response(response.body, { status: response.status, headers });
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
      return { status: 409, code: "conflict", message: "The request conflicts with current state." };
    case "PRECONDITION_FAILED":
      return { status: 412, code: "precondition_failed", message: "The campaign has changed. Review the current revision before saving." };
    case "NOT_FOUND":
      return { status: 404, code: "not_found", message: "The requested resource was not found." };
    default:
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
    return htmlResponse(page(
      "Campaign presentation",
      `<main class="owner-campaign-message"><h1>${escapeHtml(message)}</h1><p><a href="${OWNER_CAMPAIGN_EDITOR_PATH}">Return to campaign presentation</a></p></main>`,
    ), status);
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/owner-campaign.css"><script src="/owner-campaign.js" defer></script></head><body class="owner-campaign-page">${body}</body></html>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      Vary: "Accept",
    },
  });
}

function previewResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Location", OWNER_CAMPAIGN_PREVIEW_PATH);
  headers.set("Vary", mergeVary(headers.get("Vary"), "Accept"));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withMutationProof(
  response: Response,
  proof: BrowserMutationProof,
): Response {
  const headers = new Headers(response.headers);
  headers.set(MUTATION_CSRF_HEADER, proof.token);
  headers.append("Set-Cookie", proof.setCookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withClearedMutationCookie(response: Response, value: string): Response {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", requiredClearMutationCookie(value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withOptionalClearedMutationCookie(
  response: Response,
  value: string | null,
): Response {
  return value === null ? response : withClearedMutationCookie(response, value);
}

function mergeVary(current: string | null, value: string): string {
  const values = (current ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) values.push(value);
  return values.join(", ");
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
