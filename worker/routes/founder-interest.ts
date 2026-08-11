import {
  MAX_SECONDARY_CONTRIBUTION_AREAS,
  type ContributionAreaChoice,
  type FounderApplication,
  type FounderApplicationFields,
} from "../../domain/founder-application.ts";
import { parseActorSubject, type ActorSubject } from "../../domain/foundation.ts";
import {
  FOUNDER_INTEREST_PATH,
  FOUNDER_SECONDARY_AREAS_FIELD,
  MAX_PROFILE_LINK_FORM_BYTES,
  createFounderInterestCapabilityModel,
  type FounderInterestCapabilityModel,
} from "../../domain/participant-founder-interest-resource.ts";
import {
  INVESTOR_APP_API_VERSION,
  type HypermediaAction,
  type HypermediaLink,
} from "../../domain/public-campaign-resource.ts";
import { chatGPTSignInPath } from "../../domain/auth-navigation.ts";
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
import type { BrowserMutationProof } from "../../http/browser-mutation-session.ts";
import type { ApplicationRouteHandler } from "../contracts.ts";
import type {
  FounderInterestState,
  ParticipantFounderInterestService,
  ParticipantFounderInterestServiceFactory,
} from "../founder-interest-service.ts";
import {
  hypermediaResponse,
  notAcceptableResponse,
} from "./responses.ts";

const OPERATION_ID_FIELD = "operation-id";
const EXPECTED_REVISION_FIELD = "expected-revision";
const CONFIRM_WITHDRAWAL_FIELD = "confirm-withdrawal";
const FOUNDER_INTEREST_ALLOW = "GET, POST, PATCH, DELETE";

const FOUNDER_FIELD_NAMES = Object.freeze([
  "expertise-summary",
  "intended-contribution",
  "primary-contribution-area-id",
  FOUNDER_SECONDARY_AREAS_FIELD,
  "approximate-availability",
  "possible-start-timing",
  "compensation-expectation",
  "professional-profile-links",
  "note",
]);
const FOUNDER_SINGLE_VALUE_FIELD_COUNT = FOUNDER_FIELD_NAMES.length - 1;
const FOUNDER_OPERATION_ID_FIELD_COUNT = 1;
const FOUNDER_EXPECTED_REVISION_FIELD_COUNT = 1;
const FOUNDER_CSRF_FIELD_COUNT = 1;
const FOUNDER_METHOD_OVERRIDE_FIELD_COUNT = 1;
export const MAX_FOUNDER_INTEREST_MUTATION_FIELDS =
  FOUNDER_SINGLE_VALUE_FIELD_COUNT +
  MAX_SECONDARY_CONTRIBUTION_AREAS +
  FOUNDER_OPERATION_ID_FIELD_COUNT +
  FOUNDER_EXPECTED_REVISION_FIELD_COUNT +
  FOUNDER_CSRF_FIELD_COUNT +
  FOUNDER_METHOD_OVERRIDE_FIELD_COUNT;

const MAX_URL_ENCODED_BYTES_PER_UTF8_BYTE = 3;
const MAX_UTF8_BYTES_PER_UTF16_CODE_UNIT = 3;
const MAX_STABLE_ID_BYTES = 128;
const MAX_CSRF_TOKEN_BYTES = 256;
const MAX_REVISION_BYTES = String(Number.MAX_SAFE_INTEGER - 1).length;
const MAX_METHOD_OVERRIDE_BYTES = "DELETE".length;
const MAX_TEXT_VALUE_CODE_UNITS = 4_000 + 4_000 + 500 + 500 + 500 + 4_000;
const MAX_NON_PROFILE_VALUE_BYTES =
  MAX_TEXT_VALUE_CODE_UNITS * MAX_UTF8_BYTES_PER_UTF16_CODE_UNIT +
  MAX_STABLE_ID_BYTES * (2 + MAX_SECONDARY_CONTRIBUTION_AREAS) +
  MAX_CSRF_TOKEN_BYTES +
  MAX_REVISION_BYTES +
  MAX_METHOD_OVERRIDE_BYTES;
const MAX_FORM_NAME_AND_SEPARATOR_BYTES =
  FOUNDER_FIELD_NAMES.reduce((total, name) => total + name.length + 2, 0) +
  (MAX_SECONDARY_CONTRIBUTION_AREAS - 1) *
    (FOUNDER_SECONDARY_AREAS_FIELD.length + 2) +
  OPERATION_ID_FIELD.length + 2 +
  EXPECTED_REVISION_FIELD.length + 2 +
  "_csrf".length + 2 +
  "_method".length + 2;

/**
 * A browser may resubmit eight maximally expanded canonical URLs. Each raw
 * UTF-8 byte can occupy three bytes in form encoding; other text can occupy
 * three UTF-8 bytes per UTF-16 code unit. The final allowance includes every
 * valid edit field name, equals sign, and separator once.
 */
export const MAX_FOUNDER_INTEREST_MUTATION_BYTES =
  (MAX_PROFILE_LINK_FORM_BYTES + MAX_NON_PROFILE_VALUE_BYTES) *
    MAX_URL_ENCODED_BYTES_PER_UTF8_BYTE +
  MAX_FORM_NAME_AND_SEPARATOR_BYTES;

export type FounderInterestCsrfTokenProvider = (
  request: Request,
  actorSubject: ActorSubject,
) =>
  | string
  | BrowserMutationProof
  | null
  | Promise<string | BrowserMutationProof | null>;

export type FounderInterestMutationVerifier = (
  request: Request,
) => Promise<VerifiedMutationRequest & Readonly<{ clearCookie: string }>>;

export type FounderInterestRouteDependencies = Readonly<{
  serviceFor: ParticipantFounderInterestServiceFactory;
  mutationSecurity?: BrowserMutationGuardOptions;
  verifyMutation?: FounderInterestMutationVerifier;
  csrfTokenFor: FounderInterestCsrfTokenProvider;
  createOperationId?: () => string;
}>;

/** Create the participant-owned founder resource without global repositories. */
export function createFounderInterestRouteHandler(
  dependencies: FounderInterestRouteDependencies,
): ApplicationRouteHandler {
  if (
    typeof dependencies.serviceFor !== "function" ||
    typeof dependencies.csrfTokenFor !== "function" ||
    (dependencies.verifyMutation === undefined) ===
      (dependencies.mutationSecurity === undefined)
  ) {
    throw new Error("Invalid founder-interest route configuration.");
  }

  const createOperationId = dependencies.createOperationId ?? randomOperationId;
  if (typeof createOperationId !== "function") {
    throw new Error("Invalid founder-interest route configuration.");
  }
  const hostedMutationVerifier = dependencies.verifyMutation;
  const mutationGuard: (
    request: Request,
  ) => Promise<VerifiedMutationRequest & Readonly<{ clearCookie?: string }>> =
    hostedMutationVerifier ??
    createBrowserMutationGuard({
      ...(dependencies.mutationSecurity as BrowserMutationGuardOptions),
      maxBodyBytes: Math.min(
        dependencies.mutationSecurity?.maxBodyBytes ??
          MAX_FOUNDER_INTEREST_MUTATION_BYTES,
        MAX_FOUNDER_INTEREST_MUTATION_BYTES,
      ),
      maxFields: Math.min(
        dependencies.mutationSecurity?.maxFields ??
          MAX_FOUNDER_INTEREST_MUTATION_FIELDS,
        MAX_FOUNDER_INTEREST_MUTATION_FIELDS,
      ),
      repeatedFormFields: [FOUNDER_SECONDARY_AREAS_FIELD],
    });

  return async (context) => {
    if (context.url.pathname !== FOUNDER_INTEREST_PATH) return null;

    const representation = negotiateRepresentation(
      context.request.headers.get("accept"),
    );
    if (representation.kind === "not-acceptable") {
      return notAcceptableResponse(context.resourceUrl);
    }

    const actorSubject = context.actor
      ? participantSubject(context.actor.userId)
      : null;
    if (actorSubject === null) {
      return errorResponse(
        authenticationRequiredError(context.resourceUrl),
        representation.kind,
      );
    }

    let service: ParticipantFounderInterestService;
    try {
      service = dependencies.serviceFor(actorSubject);
    } catch (error) {
      return errorResponse(
        publicRouteError(error, context.resourceUrl),
        representation.kind,
      );
    }

    if (context.request.method === "GET") {
      try {
        return await resourceResponse({
          context,
          representation: representation.kind,
          actorSubject,
          service,
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

    if (!isSupportedMutationMethod(context.request.method)) {
      const response = errorResponse(
        routeError(
          context.resourceUrl,
          405,
          "method_not_allowed",
          "This request method is not available for the application.",
        ),
        representation.kind,
      );
      const headers = new Headers(response.headers);
      headers.set("Allow", FOUNDER_INTEREST_ALLOW);
      return new Response(response.body, {
        status: response.status,
        headers,
      });
    }

    let clearCookie: string | null = null;
    try {
      const verified = await mutationGuard(context.request);
      if (hostedMutationVerifier !== undefined) {
        if (!validSetCookie(verified.clearCookie)) {
          throw new MutationSecurityFailure("SERVICE_UNAVAILABLE");
        }
        clearCookie = verified.clearCookie;
      }
      assertExactResourceOrigin(context.request, context.resourceUrl);
      const contextSubject = context.actor === null
        ? null
        : participantSubject(context.actor.userId);
      if (
        verified.actor.type !== "participant" ||
        contextSubject === null ||
        verified.actor.subject !== contextSubject
      ) {
        throw new StorageFailure("NOT_FOUND");
      }

      const mutation = parseFounderMutation(verified);
      let replayed = false;
      if (mutation.kind === "create") {
        replayed = (await service.create(mutation.input)).replayed;
      } else if (mutation.kind === "edit") {
        replayed = (await service.edit(mutation.input)).replayed;
      } else {
        replayed = (await service.withdraw(mutation.input)).replayed;
      }

      return withSetCookie(await resourceResponse({
        context,
        representation: representation.kind,
        actorSubject: verified.actor.subject,
        service,
        csrfTokenFor: dependencies.csrfTokenFor,
        createOperationId,
        status: mutation.kind === "create" && !replayed ? 201 : 200,
      }), clearCookie);
    } catch (error) {
      return withSetCookie(errorResponse(
        publicRouteError(error, context.resourceUrl),
        representation.kind,
      ), clearCookie);
    }
  };
}

type FounderMutation =
  | Readonly<{
      kind: "create";
      input: Readonly<{ operationId: string; fields: FounderApplicationFields }>;
    }>
  | Readonly<{
      kind: "edit";
      input: Readonly<{
        operationId: string;
        expectedRevision: number;
        fields: FounderApplicationFields;
      }>;
    }>
  | Readonly<{
      kind: "withdraw";
      input: Readonly<{ operationId: string; expectedRevision: number }>;
    }>;

function parseFounderMutation(
  request: VerifiedMutationRequest,
): FounderMutation {
  if (request.method === "POST") {
    assertExactFields(request.body, [OPERATION_ID_FIELD, ...FOUNDER_FIELD_NAMES], [
      FOUNDER_SECONDARY_AREAS_FIELD,
      "professional-profile-links",
      "note",
    ]);
    return Object.freeze({
      kind: "create",
      input: Object.freeze({
        operationId: requiredString(request.body[OPERATION_ID_FIELD]),
        fields: parseFounderFields(request.body),
      }),
    });
  }

  if (request.method === "PATCH") {
    assertExactFields(
      request.body,
      [OPERATION_ID_FIELD, EXPECTED_REVISION_FIELD, ...FOUNDER_FIELD_NAMES],
      [
        FOUNDER_SECONDARY_AREAS_FIELD,
        "professional-profile-links",
        "note",
      ],
    );
    return Object.freeze({
      kind: "edit",
      input: Object.freeze({
        operationId: requiredString(request.body[OPERATION_ID_FIELD]),
        expectedRevision: requiredRevision(
          request.body[EXPECTED_REVISION_FIELD],
        ),
        fields: parseFounderFields(request.body),
      }),
    });
  }

  if (request.method === "DELETE") {
    assertExactFields(request.body, [
      OPERATION_ID_FIELD,
      EXPECTED_REVISION_FIELD,
      CONFIRM_WITHDRAWAL_FIELD,
    ]);
    if (!requiredConfirmation(request.body[CONFIRM_WITHDRAWAL_FIELD])) {
      invalidRequest();
    }
    return Object.freeze({
      kind: "withdraw",
      input: Object.freeze({
        operationId: requiredString(request.body[OPERATION_ID_FIELD]),
        expectedRevision: requiredRevision(
          request.body[EXPECTED_REVISION_FIELD],
        ),
      }),
    });
  }

  invalidRequest();
}

function parseFounderFields(
  body: Readonly<Record<string, unknown>>,
): FounderApplicationFields {
  return Object.freeze({
    expertiseSummary: requiredString(body["expertise-summary"]),
    intendedContribution: requiredString(body["intended-contribution"]),
    primaryContributionAreaId: requiredString(
      body["primary-contribution-area-id"],
    ) as FounderApplicationFields["primaryContributionAreaId"],
    secondaryContributionAreaIds: Object.freeze(
      stringList(body[FOUNDER_SECONDARY_AREAS_FIELD]) as FounderApplicationFields["secondaryContributionAreaIds"],
    ),
    approximateAvailability: requiredString(
      body["approximate-availability"],
    ),
    possibleStartTiming: requiredString(body["possible-start-timing"]),
    compensationExpectation: requiredString(
      body["compensation-expectation"],
    ),
    professionalProfileLinks: Object.freeze(
      profileLinks(body["professional-profile-links"]),
    ),
    note: optionalString(body.note),
  });
}

function assertExactFields(
  body: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowedNames = new Set(allowed);
  const optionalNames = new Set(optional);
  if (Object.keys(body).some((name) => !allowedNames.has(name))) invalidRequest();
  for (const name of allowed) {
    if (!optionalNames.has(name) && !Object.hasOwn(body, name)) invalidRequest();
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") invalidRequest();
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value);
}

function stringList(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  const values = Array.isArray(value) ? value : [value];
  if (
    values.length > MAX_SECONDARY_CONTRIBUTION_AREAS ||
    values.some((candidate) => typeof candidate !== "string")
  ) {
    invalidRequest();
  }
  return Object.freeze([...(values as string[])]);
}

function profileLinks(value: unknown): readonly string[] {
  if (value === undefined || value === null || value === "") {
    return Object.freeze([]);
  }
  if (typeof value !== "string") invalidRequest();
  const links = value
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((link) => link.trim())
    .filter(Boolean);
  if (links.length > 8) invalidRequest();
  return Object.freeze(links);
}

function requiredRevision(value: unknown): number {
  const parsed = typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)
    ? Number(value)
    : value;
  if (
    !Number.isSafeInteger(parsed) ||
    typeof parsed !== "number" ||
    parsed < 1 ||
    parsed >= Number.MAX_SAFE_INTEGER
  ) {
    invalidRequest();
  }
  return parsed;
}

function requiredConfirmation(value: unknown): boolean {
  return value === true || value === "true" || value === "on";
}

type ResourceResponseInput = Readonly<{
  context: Parameters<ApplicationRouteHandler>[0];
  representation: "html" | "hypermedia-json";
  actorSubject: ActorSubject;
  service: ParticipantFounderInterestService;
  csrfTokenFor: FounderInterestCsrfTokenProvider;
  createOperationId: () => string;
  status: number;
}>;

async function resourceResponse(input: ResourceResponseInput): Promise<Response> {
  const state = await input.service.getState();
  const model = createFounderInterestCapabilityModel({
    requestUrl: input.context.resourceUrl,
    ...state,
    operationIds: {
      create: input.createOperationId(),
      edit: input.createOperationId(),
      withdraw: input.createOperationId(),
    },
  });

  const hasMutationAction = model.actionContracts.some(
    (action) => action.method !== "GET",
  );
  const csrf = hasMutationAction
    ? await requiredCsrfProof(
        await input.csrfTokenFor(input.context.request, input.actorSubject),
      )
    : null;

  if (input.representation === "hypermedia-json") {
    return withSetCookie(hypermediaResponseWithCsrf(
      model.document,
      input.status,
      csrf?.token ?? null,
    ), csrf?.setCookie ?? null);
  }

  return withSetCookie(htmlResponse(
    renderFounderInterestHtml(
      model,
      state,
      csrf?.token ?? null,
      input.context.campaign?.name ?? "Campaign",
    ),
    input.status,
  ), csrf?.setCookie ?? null);
}

async function requiredCsrfProof(
  value: unknown,
): Promise<Readonly<{ token: string; setCookie: string | null }>> {
  const token = typeof value === "string"
    ? value
    : typeof value === "object" && value !== null && "token" in value
    ? value.token
    : null;
  const setCookie = typeof value === "object" && value !== null &&
      "setCookie" in value
    ? value.setCookie
    : null;
  if (
    typeof token !== "string" ||
    (setCookie !== null && !validSetCookie(setCookie))
  ) {
    throw new MutationSecurityFailure("SERVICE_UNAVAILABLE");
  }
  try {
    await hashCsrfToken(token);
  } catch (error) {
    throw new MutationSecurityFailure("SERVICE_UNAVAILABLE", { cause: error });
  }
  return Object.freeze({ token, setCookie });
}

function hypermediaResponseWithCsrf(
  document: FounderInterestCapabilityModel["document"],
  status: number,
  csrfToken: string | null,
): Response {
  const response = hypermediaResponse(document, status);
  if (csrfToken === null) return response;
  const headers = new Headers(response.headers);
  headers.set(MUTATION_CSRF_HEADER, csrfToken);
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
    href: new URL(chatGPTSignInPath(FOUNDER_INTEREST_PATH), requestUrl).href,
    requestMediaType: "text/html",
    fields: [],
  }));
  return routeError(
    requestUrl,
    401,
    "authentication_required",
    "Sign in to view your founder application.",
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
        message: "Check the application details and try again.",
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
        message: "This request conflicts with the current application state.",
      };
    case "PRECONDITION_FAILED":
      return {
        status: 412,
        code: "precondition_failed",
        message: "Your application has changed. Reload it and try again.",
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
          href: new URL(FOUNDER_INTEREST_PATH, requestUrl).href,
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
    return hypermediaResponse(error.document, error.status);
  }
  return htmlResponse(renderErrorHtml(error.document), error.status);
}

function renderFounderInterestHtml(
  model: FounderInterestCapabilityModel,
  state: FounderInterestState,
  csrfToken: string | null,
  campaignName: string,
): string {
  const application = state.application;
  const statusLabel = application === null
    ? "Not submitted"
    : application.status === "received"
      ? "Received"
      : "Withdrawn";

  return pageShell(
    `${campaignName} founder application`,
    campaignName,
    `<main class="founder-main">
      <section class="founder-intro" aria-labelledby="founder-title">
        <p class="eyebrow">Founder interest</p>
        <h1 id="founder-title">Founder application</h1>
        <p class="lede">Share the experience, contribution, and availability you would bring to this campaign.</p>
        <p class="boundary">This records non-binding founder interest. Any role, compensation, or other arrangement requires separate discussion and documentation.</p>
      </section>
      <section class="founder-state" aria-labelledby="application-status-title">
        <div>
          <p class="section-label">Current state</p>
          <h2 id="application-status-title">${escapeHtml(statusLabel)}</h2>
          ${application ? `<p>Revision ${application.revision}, updated ${formatTimestamp(application.updatedAt)}</p>` : "<p>No founder application has been submitted from this account.</p>"}
        </div>
        ${application ? renderFields(application.fields, state.contributionAreaChoices) : ""}
      </section>
      ${renderForms(model.forms, csrfToken)}
      ${application ? renderHistory(application, state.contributionAreaChoices) : ""}
    </main>`,
  );
}

function renderForms(
  forms: readonly HtmlFormAction[],
  csrfToken: string | null,
): string {
  if (forms.length === 0) return "";
  if (csrfToken === null) {
    throw new MutationSecurityFailure("SERVICE_UNAVAILABLE");
  }

  return forms
    .map((form) => {
      const withdrawal = form.name === "withdraw-founder-application";
      return `<section class="founder-form-band${withdrawal ? " founder-form-band--withdraw" : ""}" aria-labelledby="${escapeAttribute(form.name)}-title">
        <div class="founder-form-heading">
          <p class="section-label">${withdrawal ? "Application status" : "Your details"}</p>
          <h2 id="${escapeAttribute(form.name)}-title">${escapeHtml(form.title)}</h2>
          ${withdrawal ? "<p>Withdrawal closes this application while preserving its history.</p>" : "<p>All required fields describe your current founder interest.</p>"}
        </div>
        ${renderForm(form, csrfToken)}
      </section>`;
    })
    .join("");
}

function renderForm(form: HtmlFormAction, csrfToken: string): string {
  const hidden = [
    ...form.hiddenFields.map((field) =>
      hiddenInput(field.name, field.value)
    ),
    hiddenInput("_csrf", csrfToken),
  ].join("");
  const fields = form.fields.map(renderFormField).join("");

  return `<form action="${escapeAttribute(form.action)}" data-action-name="${escapeAttribute(form.name)}" enctype="${form.encoding ?? "application/x-www-form-urlencoded"}" method="${form.method}">
    ${hidden}${fields}
    <button class="founder-submit" type="submit">${escapeHtml(form.title)}</button>
  </form>`;
}

function renderFormField(field: HtmlFormField): string {
  if (field.presentation === "hidden" || field.inputType === "hidden") {
    return hiddenInput(field.name, field.value ?? field.defaultValue ?? "");
  }

  const id = `field-${field.name}`;
  if (field.inputType === "checkbox") {
    return `<label class="checkbox-field" for="${escapeAttribute(id)}">
      <input id="${escapeAttribute(id)}" name="${escapeAttribute(field.name)}" type="checkbox" value="true"${field.required ? " required" : ""}${field.value === true || field.defaultValue === true ? " checked" : ""}>
      <span>${escapeHtml(field.label)}</span>
    </label>`;
  }

  if (field.control === "textarea") {
    return `<label class="form-field" for="${escapeAttribute(id)}">
      <span>${escapeHtml(field.label)}</span>
      <textarea id="${escapeAttribute(id)}" name="${escapeAttribute(field.name)}"${field.required ? " required" : ""}${numericAttribute("minlength", field.minLength)}${numericAttribute("maxlength", field.maxLength)}>${escapeHtml(String(field.value ?? field.defaultValue ?? ""))}</textarea>
    </label>`;
  }

  if (field.control === "select") {
    const selected = new Set(
      field.multiple
        ? field.values ?? field.defaultValues ?? []
        : [String(field.value ?? field.defaultValue ?? "")],
    );
    const options = [
      ...(field.multiple
        ? []
        : [`<option value="">Select an area</option>`]),
      ...(field.choices ?? []).map((choice) =>
        `<option value="${escapeAttribute(choice.value)}"${selected.has(choice.value) ? " selected" : ""}>${escapeHtml(choice.label)}</option>`
      ),
    ].join("");
    return `<label class="form-field" for="${escapeAttribute(id)}">
      <span>${escapeHtml(field.label)}</span>
      <select id="${escapeAttribute(id)}" name="${escapeAttribute(field.name)}"${field.required ? " required" : ""}${field.multiple ? " multiple" : ""}>${options}</select>
    </label>`;
  }

  return `<label class="form-field" for="${escapeAttribute(id)}">
    <span>${escapeHtml(field.label)}</span>
    <input id="${escapeAttribute(id)}" name="${escapeAttribute(field.name)}" type="${escapeAttribute(field.inputType ?? "text")}" value="${escapeAttribute(String(field.value ?? field.defaultValue ?? ""))}"${field.required ? " required" : ""}${numericAttribute("minlength", field.minLength)}${numericAttribute("maxlength", field.maxLength)}${numericAttribute("min", field.minimum)}${numericAttribute("max", field.maximum)}${numericAttribute("step", field.step)}>
  </label>`;
}

function renderFields(
  fields: FounderApplicationFields,
  choices: readonly ContributionAreaChoice[],
): string {
  const labels = new Map(choices.map((choice) => [choice.id, choice.label]));
  const secondary = fields.secondaryContributionAreaIds.length > 0
    ? fields.secondaryContributionAreaIds
        .map((id) => labels.get(id) ?? id)
        .join(", ")
    : "None";
  const links = fields.professionalProfileLinks.length > 0
    ? `<ul>${fields.professionalProfileLinks.map((href) =>
        `<li><a href="${escapeAttribute(href)}" rel="noreferrer noopener">${escapeHtml(href)}</a></li>`
      ).join("")}</ul>`
    : "Not provided";

  return `<dl class="application-fields">
    ${detail("Expertise summary", fields.expertiseSummary)}
    ${detail("Intended contribution", fields.intendedContribution)}
    ${detail("Primary contribution area", labels.get(fields.primaryContributionAreaId) ?? fields.primaryContributionAreaId)}
    ${detail("Secondary contribution areas", secondary)}
    ${detail("Approximate availability", fields.approximateAvailability)}
    ${detail("Possible start timing", fields.possibleStartTiming)}
    ${detail("Compensation expectation", fields.compensationExpectation)}
    <div><dt>Professional profile links</dt><dd>${links}</dd></div>
    ${detail("Additional note", fields.note ?? "Not provided")}
  </dl>`;
}

function renderHistory(
  application: FounderApplication,
  choices: readonly ContributionAreaChoice[],
): string {
  return `<section class="founder-history" aria-labelledby="application-history-title">
    <p class="section-label">Application record</p>
    <h2 id="application-history-title">History</h2>
    <ol>${[...application.history].reverse().map((entry) =>
      `<li>
        <details>
          <summary>Revision ${entry.revision}: ${historyLabel(entry.kind)} <span>${formatTimestamp(entry.occurredAt)}</span></summary>
          ${renderFields(entry.fields, choices)}
        </details>
      </li>`
    ).join("")}</ol>
  </section>`;
}

function historyLabel(kind: FounderApplication["history"][number]["kind"]): string {
  if (kind === "created") return "Submitted";
  if (kind === "edited") return "Updated";
  return "Withdrawn";
}

function renderErrorHtml(document: RouteErrorDocument): string {
  const actions = document.actions.map((action) =>
    `<a class="founder-submit" href="${escapeAttribute(action.href)}">${escapeHtml(action.title)}</a>`
  ).join("");
  const self = document.links.find((link) => link.rel.includes("self"));
  const campaign = document.links.find((link) => link.rel.includes("campaign"));
  return pageShell(
    "Founder application",
    "Campaign",
    `<main class="founder-main error-main">
      <p class="eyebrow">Founder interest</p>
      <h1>Founder application</h1>
      <p class="lede">${escapeHtml(document.data.message)}</p>
      <div class="error-actions">${actions}${self ? `<a href="${escapeAttribute(self.href)}">Return to founder application</a>` : ""}${campaign ? `<a href="${escapeAttribute(campaign.href)}">Return to campaign</a>` : ""}</div>
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
  <style>${FOUNDER_STYLES}</style>
</head>
<body>
  <header class="founder-header"><a href="/">${escapeHtml(campaignName)}</a><span>Founder interest</span></header>
  ${main}
</body>
</html>`;
}

function detail(label: string, value: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function hiddenInput(name: string, value: string | number | boolean): string {
  return `<input name="${escapeAttribute(name)}" type="hidden" value="${escapeAttribute(String(value))}">`;
}

function numericAttribute(name: string, value: number | undefined): string {
  return value === undefined ? "" : ` ${name}="${value}"`;
}

function formatTimestamp(value: string): string {
  try {
    return escapeHtml(new Date(value).toISOString().replace("T", " ").replace(".000Z", " UTC"));
  } catch {
    return escapeHtml(value);
  }
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

function participantSubject(value: unknown): ActorSubject | null {
  const parsed = parseActorSubject(value);
  return parsed.ok ? parsed.value : null;
}

function isSupportedMutationMethod(value: string): boolean {
  return value === "POST" || value === "PATCH" || value === "DELETE";
}

function assertExactResourceOrigin(request: Request, resourceUrl: string): void {
  let requestOrigin: string;
  let resourceOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
    resourceOrigin = new URL(resourceUrl).origin;
  } catch {
    throw new MutationSecurityFailure("REQUEST_REJECTED");
  }
  if (requestOrigin !== resourceOrigin) {
    throw new MutationSecurityFailure("REQUEST_REJECTED");
  }
}

function randomOperationId(): string {
  return `founder-operation:${crypto.randomUUID()}`;
}

function invalidRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
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
  if (!validSetCookie(cookie)) return response;
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const FOUNDER_STYLES = `
:root{--paper:#f7f8f5;--white:#fff;--ink:#13211c;--muted:#5e6c65;--line:#d7dfda;--green:#0f6b59;--green-dark:#063d34;--green-pale:#e6f1ed;--coral:#cf4f36}*{box-sizing:border-box;letter-spacing:0}body{min-width:320px;margin:0;background:var(--paper);color:var(--ink);font-family:system-ui,"Segoe UI",sans-serif}a{color:var(--green);text-underline-offset:3px}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid rgba(15,107,89,.28);outline-offset:3px}.founder-header{display:flex;width:min(1080px,calc(100% - 40px));min-height:68px;align-items:center;justify-content:space-between;margin:0 auto;border-bottom:1px solid var(--line);font-size:.82rem;font-weight:720}.founder-header a{color:var(--ink);font-size:1rem;font-weight:820;text-decoration:none}.founder-main{width:min(1080px,calc(100% - 40px));margin:0 auto;padding:68px 0}.founder-intro{max-width:760px}.eyebrow,.section-label{margin:0 0 10px;color:var(--green);font-size:.75rem;font-weight:800;text-transform:uppercase}h1{margin:0;font-size:3rem;line-height:1.06}h2{margin:0;font-size:1.65rem;line-height:1.16}.lede{max-width:680px;margin:18px 0 0;color:var(--muted);font-size:1.05rem;line-height:1.6}.boundary{max-width:760px;margin:20px 0 0;padding:15px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);color:var(--muted);font-size:.82rem;line-height:1.55}.founder-state,.founder-form-band{display:grid;grid-template-columns:minmax(0,.72fr) minmax(420px,1.28fr);gap:64px;margin-top:56px;padding:30px 0;border-top:1px solid var(--line)}.founder-state>div:first-child>p:last-child,.founder-form-heading p:last-child{color:var(--muted);line-height:1.55}.application-fields{margin:0;border-top:1px solid var(--line)}.application-fields>div{display:grid;grid-template-columns:180px minmax(0,1fr);gap:22px;padding:13px 0;border-bottom:1px solid var(--line)}.application-fields dt{color:var(--muted);font-size:.8rem}.application-fields dd{min-width:0;margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:.9rem;line-height:1.5}.application-fields ul{margin:0;padding-left:18px}.founder-form-band{align-items:start}.founder-form-band form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 20px}.form-field{display:grid;min-width:0;gap:7px}.form-field:has(textarea),.form-field:has(select[multiple]){grid-column:1/-1}.form-field>span{font-size:.8rem;font-weight:720}.form-field input,.form-field textarea,.form-field select{width:100%;min-height:42px;padding:10px 11px;border:1px solid #aebbb5;border-radius:6px;background:var(--white);color:var(--ink);font:inherit}.form-field textarea{min-height:112px;resize:vertical}.form-field select[multiple]{min-height:132px}.checkbox-field{display:flex;grid-column:1/-1;gap:10px;align-items:flex-start;padding:12px 0;font-size:.9rem;font-weight:680}.checkbox-field input{width:18px;height:18px;flex:0 0 18px;margin:1px 0}.founder-submit{display:inline-flex;min-height:42px;grid-column:1/-1;align-items:center;justify-content:center;justify-self:start;padding:10px 16px;border:1px solid var(--green-dark);border-radius:6px;background:var(--green-dark);color:#fff;font:inherit;font-size:.84rem;font-weight:760;text-decoration:none;cursor:pointer}.founder-form-band--withdraw{border-top-color:#e0b9b0}.founder-form-band--withdraw .founder-submit{border-color:var(--coral);background:var(--coral)}.founder-history{margin-top:58px;padding-top:30px;border-top:1px solid var(--line)}.founder-history ol{margin:24px 0 0;padding:0;border-top:1px solid var(--line);list-style:none}.founder-history li{border-bottom:1px solid var(--line)}.founder-history summary{display:flex;justify-content:space-between;gap:20px;padding:18px 0;cursor:pointer;font-weight:720}.founder-history summary span{color:var(--muted);font-size:.78rem;font-weight:500}.founder-history details .application-fields{margin-bottom:24px;padding-left:24px;border-left:3px solid var(--green-pale)}.error-main{max-width:760px}.error-actions{display:flex;flex-wrap:wrap;gap:18px;align-items:center;margin-top:28px}@media(max-width:760px){.founder-main{padding:48px 0}.founder-state,.founder-form-band{grid-template-columns:1fr;gap:28px}.application-fields>div{grid-template-columns:1fr;gap:5px}.founder-form-band form{grid-template-columns:1fr}.form-field:has(textarea),.form-field:has(select[multiple]){grid-column:auto}.founder-submit{width:100%;justify-self:stretch}h1{font-size:2.25rem}.founder-history summary{display:grid;gap:6px}.founder-history details .application-fields{padding-left:12px}}
`;
