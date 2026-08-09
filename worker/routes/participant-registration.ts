import { chatGPTSignInPath } from "../../domain/auth-navigation.ts";
import {
  parseTimestamp,
  type Timestamp,
} from "../../domain/foundation.ts";
import {
  PARTICIPANT_REGISTRATION_PATH,
  createParticipantRegistrationCapabilityModel,
  defineParticipantRegistrationNotices,
  type ParticipantRegistrationCapabilityModel,
  type ParticipantRegistrationNotices,
} from "../../domain/participant-registration-resource.ts";
import {
  parseParticipantAccount,
  type ParticipantAccount,
  type ParticipantProfile,
} from "../../domain/participant-profile.ts";
import {
  INVESTOR_APP_API_VERSION,
  type HypermediaAction,
  type HypermediaLink,
} from "../../domain/public-campaign-resource.ts";
import {
  defineAction,
  toHypermediaAction,
  type HtmlFormAction,
  type HtmlFormField,
} from "../../domain/hypermedia-action.ts";
import {
  StorageFailure,
  type StorageFailureCode,
} from "../../domain/storage-adapter.ts";
import { negotiateRepresentation } from "../../http/content-negotiation.ts";
import {
  MUTATION_CSRF_HEADER,
  MutationSecurityFailure,
  createBrowserMutationGuard,
  hashCsrfToken,
  toPublicMutationSecurityFailure,
  type BrowserMutationGuardOptions,
  type VerifiedMutationRequest,
} from "../../http/mutation-security.ts";
import type {
  ParticipantProfileSnapshot,
  ParticipantRepository,
} from "../../repositories/in-memory-participant-repository.ts";
import type { ApplicationRouteHandler } from "../contracts.ts";
import {
  hypermediaResponse,
  notAcceptableResponse,
} from "./responses.ts";

const OPERATION_ID_FIELD = "operation-id";
const DISPLAY_NAME_FIELD = "display-name";
const COUNTRY_FIELD = "country";
const DECLARED_INTEREST_FIELD = "declared-interest";
const PARTICIPATION_CONTEXT_FIELD = "participation-context";
const PROCESS_NOTICE_FIELD = "process-email-notice-acknowledged";
const MARKETING_CONSENT_FIELD = "marketing-consent";

const REQUIRED_REGISTRATION_FIELDS = Object.freeze([
  OPERATION_ID_FIELD,
  DISPLAY_NAME_FIELD,
  COUNTRY_FIELD,
  DECLARED_INTEREST_FIELD,
  PARTICIPATION_CONTEXT_FIELD,
  PROCESS_NOTICE_FIELD,
]);
const ALLOWED_REGISTRATION_FIELDS = Object.freeze([
  ...REQUIRED_REGISTRATION_FIELDS,
  MARKETING_CONSENT_FIELD,
]);

export type ParticipantRegistrationRepositoryFactory = (
  account: ParticipantAccount,
) => ParticipantRepository;

export type ParticipantRegistrationCsrfTokenProvider = (
  request: Request,
  account: ParticipantAccount,
) => string | null | Promise<string | null>;

export type ParticipantRegistrationRouteDependencies = Readonly<{
  repositoryFor: ParticipantRegistrationRepositoryFactory;
  mutationSecurity: BrowserMutationGuardOptions;
  csrfTokenFor: ParticipantRegistrationCsrfTokenProvider;
  notices: ParticipantRegistrationNotices;
  now?: () => Date;
  createOperationId?: () => string;
}>;

/** Create the first-access resource without global or production repositories. */
export function createParticipantRegistrationRouteHandler(
  dependencies: ParticipantRegistrationRouteDependencies,
): ApplicationRouteHandler {
  if (
    typeof dependencies.repositoryFor !== "function" ||
    typeof dependencies.csrfTokenFor !== "function"
  ) {
    throw new Error("Invalid participant-registration route configuration.");
  }
  const notices = defineParticipantRegistrationNotices(dependencies.notices);
  const now = dependencies.now ?? (() => new Date());
  const createOperationId = dependencies.createOperationId ?? randomOperationId;
  if (typeof now !== "function" || typeof createOperationId !== "function") {
    throw new Error("Invalid participant-registration route configuration.");
  }
  const mutationGuard = createBrowserMutationGuard(
    dependencies.mutationSecurity,
  );

  return async (context) => {
    if (context.url.pathname !== PARTICIPANT_REGISTRATION_PATH) return null;

    const representation = negotiateRepresentation(
      context.request.headers.get("accept"),
    );
    if (representation.kind === "not-acceptable") {
      return withNoSniff(notAcceptableResponse(context.resourceUrl));
    }

    if (context.request.method === "GET") {
      if (context.actor === null) {
        return errorResponse(
          authenticationRequiredError(context.resourceUrl),
          representation.kind,
        );
      }

      try {
        const account = requiredParticipantAccount(context);
        const repository = requiredRepository(dependencies.repositoryFor, account);
        const current = requireOwnedSnapshot(await repository.current(), account);
        return await resourceResponse({
          context,
          representation: representation.kind,
          account,
          profile: current?.snapshot ?? null,
          notices,
          csrfTokenFor: dependencies.csrfTokenFor,
          createOperationId,
          status: 200,
        });
      } catch (error) {
        return errorResponse(
          publicRouteError(error, context.resourceUrl),
          representation.kind,
        );
      }
    }

    if (context.request.method !== "POST") {
      const response = errorResponse(
        routeError(
          context.resourceUrl,
          405,
          "method_not_allowed",
          "This request method is not available for registration.",
        ),
        representation.kind,
      );
      const headers = new Headers(response.headers);
      headers.set("Allow", "GET, POST");
      return new Response(response.body, {
        status: response.status,
        headers,
      });
    }

    try {
      const verified = await mutationGuard(context.request);
      assertExactResourceOrigin(context.request, context.resourceUrl);
      const account = requiredParticipantAccount(context);
      if (
        verified.actor.type !== "participant" ||
        verified.actor.subject !== account.subject
      ) {
        notFound();
      }

      const repository = requiredRepository(dependencies.repositoryFor, account);
      const current = requireOwnedSnapshot(await repository.current(), account);
      const mutation = parseRegistrationMutation(verified);
      const result = await repository.register({
        operationId: mutation.operationId,
        expectedRevision: null,
        registeredAt: current?.snapshot.registeredAt ?? currentTimestamp(now),
        registration: mutation.registration,
      });
      requireOwnedProfile(result.snapshot, account);

      return await resourceResponse({
        context,
        representation: representation.kind,
        account,
        profile: result.snapshot,
        notices,
        csrfTokenFor: dependencies.csrfTokenFor,
        createOperationId,
        status: result.replayed ? 200 : 201,
      });
    } catch (error) {
      return errorResponse(
        publicRouteError(error, context.resourceUrl),
        representation.kind,
      );
    }
  };
}

type RegistrationMutation = Readonly<{
  operationId: string;
  registration: Readonly<{
    displayName: string;
    country: string;
    declaredInterest: string;
    participationContext: string;
    processEmailNoticeAcknowledged: true;
    marketingConsent: boolean;
  }>;
}>;

function parseRegistrationMutation(
  request: VerifiedMutationRequest,
): RegistrationMutation {
  assertExactFields(request.body);
  if (!requiredConfirmation(request.body[PROCESS_NOTICE_FIELD])) {
    invalidRequest();
  }
  return Object.freeze({
    operationId: requiredString(request.body[OPERATION_ID_FIELD]),
    registration: Object.freeze({
      displayName: requiredString(request.body[DISPLAY_NAME_FIELD]),
      country: requiredString(request.body[COUNTRY_FIELD]),
      declaredInterest: requiredString(request.body[DECLARED_INTEREST_FIELD]),
      participationContext: requiredString(
        request.body[PARTICIPATION_CONTEXT_FIELD],
      ),
      processEmailNoticeAcknowledged: true as const,
      marketingConsent: optionalConfirmation(
        request.body[MARKETING_CONSENT_FIELD],
      ),
    }),
  });
}

function assertExactFields(body: Readonly<Record<string, unknown>>): void {
  const allowed = new Set(ALLOWED_REGISTRATION_FIELDS);
  if (Object.keys(body).some((name) => !allowed.has(name))) invalidRequest();
  if (REQUIRED_REGISTRATION_FIELDS.some((name) => !Object.hasOwn(body, name))) {
    invalidRequest();
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") invalidRequest();
  return value;
}

function requiredConfirmation(value: unknown): boolean {
  return value === true || value === "true" || value === "on";
}

function optionalConfirmation(value: unknown): boolean {
  if (value === undefined || value === false) return false;
  if (value === true || value === "true" || value === "on") return true;
  invalidRequest();
}

type ResourceResponseInput = Readonly<{
  context: Parameters<ApplicationRouteHandler>[0];
  representation: "html" | "hypermedia-json";
  account: ParticipantAccount;
  profile: ParticipantProfile | null;
  notices: ParticipantRegistrationNotices;
  csrfTokenFor: ParticipantRegistrationCsrfTokenProvider;
  createOperationId: () => string;
  status: number;
}>;

async function resourceResponse(input: ResourceResponseInput): Promise<Response> {
  const model = createParticipantRegistrationCapabilityModel({
    requestUrl: input.context.resourceUrl,
    account: input.account,
    profile: input.profile,
    notices: input.notices,
    operationId: input.profile === null ? input.createOperationId() : null,
  });
  const hasMutationAction = model.actionContracts.some(
    (action) => action.method !== "GET",
  );
  const csrfToken = hasMutationAction
    ? await requiredCsrfToken(
        await input.csrfTokenFor(input.context.request, input.account),
      )
    : null;

  if (input.representation === "hypermedia-json") {
    return hypermediaResponseWithCsrf(
      model.document,
      input.status,
      csrfToken,
    );
  }

  return htmlResponse(
    renderParticipantRegistrationHtml(
      model,
      csrfToken,
      input.context.campaign?.name ?? "Campaign",
    ),
    input.status,
  );
}

async function requiredCsrfToken(value: unknown): Promise<string> {
  if (typeof value !== "string") {
    throw new MutationSecurityFailure("SERVICE_UNAVAILABLE");
  }
  try {
    await hashCsrfToken(value);
  } catch (error) {
    throw new MutationSecurityFailure("SERVICE_UNAVAILABLE", { cause: error });
  }
  return value;
}

function hypermediaResponseWithCsrf(
  document: unknown,
  status: number,
  csrfToken: string | null,
): Response {
  const response = hypermediaResponse(document, status);
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  if (csrfToken !== null) headers.set(MUTATION_CSRF_HEADER, csrfToken);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type RouteErrorDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "error";
  id: string;
  data: Readonly<{ code: string; message: string }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

type RouteError = Readonly<{
  status: number;
  document: RouteErrorDocument;
}>;

function authenticationRequiredError(requestUrl: string): RouteError {
  const signIn = toHypermediaAction(defineAction({
    name: "sign-in",
    title: "Sign in",
    method: "GET",
    href: new URL(
      chatGPTSignInPath(PARTICIPANT_REGISTRATION_PATH),
      requestUrl,
    ).href,
    requestMediaType: "text/html",
    fields: [],
  }));
  return routeError(
    requestUrl,
    401,
    "authentication_required",
    "Sign in to complete access registration.",
    [signIn],
  );
}

function publicRouteError(error: unknown, requestUrl: string): RouteError {
  if (error instanceof MutationSecurityFailure) {
    const failure = toPublicMutationSecurityFailure(error);
    return routeError(
      requestUrl,
      failure.status,
      failure.body.error.code.toLowerCase(),
      failure.body.error.message,
    );
  }

  if (error instanceof StorageFailure) {
    const mapped = storageError(error.code);
    return routeError(requestUrl, mapped.status, mapped.code, mapped.message);
  }

  return routeError(
    requestUrl,
    503,
    "service_unavailable",
    "The application is temporarily unavailable.",
  );
}

function storageError(code: StorageFailureCode): Readonly<{
  status: number;
  code: string;
  message: string;
}> {
  switch (code) {
    case "INVALID_REQUEST":
      return {
        status: 400,
        code: "invalid_request",
        message: "Check the registration details and try again.",
      };
    case "NOT_FOUND":
      return {
        status: 404,
        code: "not_found",
        message: "The requested resource was not found.",
      };
    case "CONFLICT":
      return {
        status: 409,
        code: "conflict",
        message: "This request conflicts with the current registration state.",
      };
    case "PRECONDITION_FAILED":
      return {
        status: 412,
        code: "precondition_failed",
        message: "The registration state changed. Reload and try again.",
      };
    case "UNAVAILABLE":
      return {
        status: 503,
        code: "service_unavailable",
        message: "The application is temporarily unavailable.",
      };
  }
}

function routeError(
  requestUrl: string,
  status: number,
  code: string,
  message: string,
  actions: readonly HypermediaAction[] = [],
): RouteError {
  return Object.freeze({
    status,
    document: Object.freeze({
      api_version: INVESTOR_APP_API_VERSION,
      type: "error",
      id: code,
      data: Object.freeze({ code, message }),
      links: Object.freeze([
        Object.freeze({
          rel: Object.freeze(["self"]),
          href: new URL(PARTICIPANT_REGISTRATION_PATH, requestUrl).href,
        }),
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
  error: RouteError,
  representation: "html" | "hypermedia-json",
): Response {
  if (representation === "hypermedia-json") {
    return hypermediaResponseWithCsrf(error.document, error.status, null);
  }
  return htmlResponse(renderErrorHtml(error.document), error.status);
}

function renderParticipantRegistrationHtml(
  model: ParticipantRegistrationCapabilityModel,
  csrfToken: string | null,
  campaignName: string,
): string {
  const data = model.document.data;
  const registered = data.status === "registered";
  const content = registered
    ? `<section class="registration-state" aria-labelledby="registration-title">
        <p class="registration-eyebrow">Access registration</p>
        <h1 id="registration-title">Registration complete</h1>
        <p class="registration-lede">Your access registration is active.</p>
        <dl class="registration-summary">
          ${detail("Display name", data.display_name ?? "")}
          ${detail("Account email", data.account_email)}
          ${detail("Country", data.country ?? "")}
          ${detail("Interest", interestLabel(data.declared_interest))}
          ${detail("Context", contextLabel(data.participation_context))}
          ${detail("Marketing consent", consentLabel(data.marketing_consent_state))}
        </dl>
        <div class="registration-actions"><a class="registration-button" href="/participant/package">Read the information package</a><a href="/participant">Open participant view</a></div>
      </section>`
    : `<section class="registration-intro" aria-labelledby="registration-title">
        <p class="registration-eyebrow">Access registration</p>
        <h1 id="registration-title">Register your interest</h1>
        <p class="registration-lede">Tell us how you may want to take part. Your registration records non-binding interest and gives you access to the information package.</p>
      </section>
      <section class="registration-account" aria-labelledby="registration-account-title">
        <div>
          <p class="registration-section-label">Signed-in account</p>
          <h2 id="registration-account-title">Account email</h2>
          <p>This label comes from your identity provider and cannot be edited here.</p>
        </div>
        <output>${escapeHtml(data.account_email)}</output>
      </section>
      ${renderRegistrationForm(model.forms, csrfToken, data.process_email_notice, data.marketing_notice)}`;

  return pageShell(
    `${campaignName} access registration`,
    campaignName,
    `<main class="registration-main">${content}</main>`,
  );
}

function renderRegistrationForm(
  forms: readonly HtmlFormAction[],
  csrfToken: string | null,
  processNotice: string,
  marketingNotice: string,
): string {
  const form = forms[0];
  if (!form) return "";
  if (forms.length !== 1 || csrfToken === null) {
    throw new MutationSecurityFailure("SERVICE_UNAVAILABLE");
  }
  const hidden = [
    ...form.hiddenFields.map((field) => hiddenInput(field.name, field.value)),
    hiddenInput("_csrf", csrfToken),
  ].join("");
  const fields = form.fields.map((field) => {
    if (field.presentation === "hidden" || field.inputType === "hidden") {
      return hiddenInput(field.name, field.value ?? field.defaultValue ?? "");
    }
    if (field.name === PROCESS_NOTICE_FIELD) {
      return noticeCheckbox(field, processNotice, "Required process notice");
    }
    if (field.name === MARKETING_CONSENT_FIELD) {
      return noticeCheckbox(field, marketingNotice, "Optional marketing consent");
    }
    return renderFormField(field);
  }).join("");

  return `<section class="registration-form-band" aria-labelledby="registration-form-title">
    <div class="registration-form-heading">
      <p class="registration-section-label">Your interest</p>
      <h2 id="registration-form-title">Complete access registration</h2>
      <p>All fields marked required must be completed before registration.</p>
    </div>
    <form action="${escapeAttribute(form.action)}" data-action-name="${escapeAttribute(form.name)}" enctype="${form.encoding ?? "application/x-www-form-urlencoded"}" method="${form.method}">
      ${hidden}${fields}
      <button class="registration-button" type="submit">${escapeHtml(form.title)}</button>
    </form>
  </section>`;
}

function renderFormField(field: HtmlFormField): string {
  const id = `registration-field-${field.name}`;
  if (field.control === "select") {
    const selected = String(field.value ?? field.defaultValue ?? "");
    const options = [
      `<option value="">Select an option</option>`,
      ...(field.choices ?? []).map((choice) =>
        `<option value="${escapeAttribute(choice.value)}"${selected === choice.value ? " selected" : ""}>${escapeHtml(choice.label)}</option>`
      ),
    ].join("");
    return `<label class="registration-field" for="${escapeAttribute(id)}">
      <span>${escapeHtml(field.label)}</span>
      <select id="${escapeAttribute(id)}" name="${escapeAttribute(field.name)}"${field.required ? " required" : ""}>${options}</select>
    </label>`;
  }

  return `<label class="registration-field" for="${escapeAttribute(id)}">
    <span>${escapeHtml(field.label)}</span>
    <input id="${escapeAttribute(id)}" name="${escapeAttribute(field.name)}" type="${escapeAttribute(field.inputType ?? "text")}" value="${escapeAttribute(String(field.value ?? field.defaultValue ?? ""))}"${field.required ? " required" : ""}${numericAttribute("minlength", field.minLength)}${numericAttribute("maxlength", field.maxLength)}>
  </label>`;
}

function noticeCheckbox(
  field: HtmlFormField,
  notice: string,
  heading: string,
): string {
  const id = `registration-field-${field.name}`;
  return `<div class="registration-notice">
    <p><strong>${escapeHtml(heading)}</strong></p>
    <p>${escapeHtml(notice)}</p>
    <label for="${escapeAttribute(id)}">
      <input id="${escapeAttribute(id)}" name="${escapeAttribute(field.name)}" type="checkbox" value="true"${field.required ? " required" : ""}${field.value === true || field.defaultValue === true ? " checked" : ""}>
      <span>${escapeHtml(field.label)}</span>
    </label>
  </div>`;
}

function renderErrorHtml(document: RouteErrorDocument): string {
  const actions = document.actions.map((action) =>
    `<a class="registration-button" href="${escapeAttribute(action.href)}">${escapeHtml(action.title)}</a>`
  ).join("");
  return pageShell(
    "Access registration",
    "Campaign",
    `<main class="registration-main registration-error">
      <p class="registration-eyebrow">Access registration</p>
      <h1>Registration unavailable</h1>
      <p class="registration-lede">${escapeHtml(document.data.message)}</p>
      <div class="registration-actions">${actions}<a href="/">Return to campaign</a></div>
    </main>`,
  );
}

function pageShell(title: string, campaignName: string, main: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/participant-registration.css">
</head>
<body class="registration-page">
  <header class="registration-header"><a href="/">${escapeHtml(campaignName)}</a><span>Access registration</span></header>
  ${main}
</body>
</html>`;
}

function requiredParticipantAccount(
  context: Parameters<ApplicationRouteHandler>[0],
): ParticipantAccount {
  if (context.actor === null || context.isOwner) notFound();
  const parsed = parseParticipantAccount({
    subject: context.actor.userId,
    accountEmailLabel: context.actor.email,
  });
  if (!parsed.ok) notFound();
  return parsed.value;
}

function requiredRepository(
  factory: ParticipantRegistrationRepositoryFactory,
  account: ParticipantAccount,
): ParticipantRepository {
  let repository: ParticipantRepository;
  try {
    repository = factory(account);
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
  if (
    typeof repository !== "object" ||
    repository === null ||
    typeof repository.current !== "function" ||
    typeof repository.register !== "function"
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return repository;
}

function requireOwnedSnapshot(
  value: ParticipantProfileSnapshot | null,
  account: ParticipantAccount,
): ParticipantProfileSnapshot | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) unavailable();
  requireOwnedProfile(value.snapshot, account);
  return value;
}

function requireOwnedProfile(
  profile: ParticipantProfile,
  account: ParticipantAccount,
): void {
  if (
    profile.subject !== account.subject ||
    profile.accountEmailLabel !== account.accountEmailLabel
  ) {
    notFound();
  }
}

function assertExactResourceOrigin(request: Request, resourceUrl: string): void {
  let expected: string;
  try {
    expected = new URL(resourceUrl).origin;
  } catch (error) {
    throw new MutationSecurityFailure("SERVICE_UNAVAILABLE", { cause: error });
  }
  if (request.headers.get("origin") !== expected) {
    throw new MutationSecurityFailure("REQUEST_REJECTED");
  }
}

function currentTimestamp(now: () => Date): Timestamp {
  let value: Date;
  try {
    value = now();
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) unavailable();
  const parsed = parseTimestamp(value.toISOString());
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function detail(label: string, value: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function interestLabel(
  value: ParticipantProfile["declaredInterest"] | null,
): string {
  if (value === "founder") return "Founder";
  if (value === "investor") return "Investor";
  if (value === "both") return "Founder and investor";
  return "";
}

function contextLabel(
  value: ParticipantProfile["participationContext"] | null,
): string {
  if (value === "individual") return "Individual";
  if (value === "company") return "Company";
  return "";
}

function consentLabel(value: ParticipantProfile["marketingConsent"]["state"]): string {
  if (value === "granted") return "Granted";
  if (value === "withdrawn") return "Withdrawn";
  return "Not granted";
}

function hiddenInput(name: string, value: string | number | boolean): string {
  return `<input name="${escapeAttribute(name)}" type="hidden" value="${escapeAttribute(String(value))}">`;
}

function numericAttribute(name: string, value: number | undefined): string {
  return value === undefined ? "" : ` ${name}="${value}"`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const escapeAttribute = escapeHtml;

function randomOperationId(): string {
  return `participant-registration:${crypto.randomUUID()}`;
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

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      Vary: "Accept",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function withNoSniff(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
