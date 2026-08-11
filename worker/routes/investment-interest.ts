import {
  parseActorSubject,
  parseStableId,
  type ActorSubject,
  type StableId,
} from "../../domain/foundation.ts";
import type {
  InvestmentIndication,
} from "../../domain/investment-indication.ts";
import {
  INVESTMENT_INTEREST_PATH,
  createInvestmentInterestCollectionCapabilityModel,
  createInvestmentInterestItemCapabilityModel,
  type InvestmentInterestCollectionCapabilityModel,
  type InvestmentInterestFieldsData,
  type InvestmentInterestItemCapabilityModel,
} from "../../domain/participant-investment-interest-resource.ts";
import { chatGPTSignInPath } from "../../domain/auth-navigation.ts";
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
  parseStorageOperationId,
  type StorageFailureCode,
} from "../../domain/storage-adapter.ts";
import { negotiateRepresentation } from "../../http/content-negotiation.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  MUTATION_METHOD_FIELD,
  MutationSecurityFailure,
  createBrowserMutationGuard,
  hashCsrfToken,
  toPublicMutationSecurityFailure,
  type BrowserMutationGuardOptions,
  type VerifiedMutationRequest,
} from "../../http/mutation-security.ts";
import type {
  BrowserMutationProof,
  BrowserMutationVerificationLimits,
} from "../../http/browser-mutation-session.ts";
import type {
  ApplicationRouteContext,
  ApplicationRouteHandler,
} from "../contracts.ts";
import type {
  InvestmentInterestCollectionState,
  InvestmentInterestItemState,
  ParticipantInvestmentInterestService,
  ParticipantInvestmentInterestServiceFactory,
} from "../investment-interest-service.ts";
import {
  hypermediaResponse,
  notAcceptableResponse,
} from "./responses.ts";

const OPERATION_ID_FIELD = "operation-id";
const EXPECTED_REVISION_FIELD = "expected-revision";
const KIND_FIELD = "kind";
const CONFIRM_WITHDRAWAL_FIELD = "confirm-withdrawal";
const CONFIRM_REACTIVATION_FIELD = "confirm-reactivation";
const FORM_MUTATION_MEDIA_TYPE = "application/x-www-form-urlencoded";
const FORM_TRANSPORT_FIELD_COUNT = 2;

const PERSONAL_FIELD_NAMES = Object.freeze([
  KIND_FIELD,
  "residence-country",
  "amount",
  "availability-period",
  "note",
]);
const COMPANY_FIELD_NAMES = Object.freeze([
  KIND_FIELD,
  "company-name",
  "registration-country",
  "company-identifier",
  "representative-name",
  "representative-authority-declared",
  "amount",
  "availability-period",
  "note",
]);

export const MAX_INVESTMENT_POST_MUTATION_BYTES = 65_536;
export const MAX_INVESTMENT_POST_MUTATION_FIELDS = 13;
export const MAX_INVESTMENT_PATCH_MUTATION_BYTES = 65_536;
export const MAX_INVESTMENT_PATCH_MUTATION_FIELDS = 11;
export const MAX_INVESTMENT_DELETE_MUTATION_BYTES = 512;
export const MAX_INVESTMENT_DELETE_MUTATION_FIELDS = 3;

const INVESTMENT_MUTATION_LIMITS = Object.freeze({
  POST: Object.freeze({
    maxBodyBytes: MAX_INVESTMENT_POST_MUTATION_BYTES,
    maxFields: MAX_INVESTMENT_POST_MUTATION_FIELDS,
    repeatedFormFields: Object.freeze([]),
  }),
  PATCH: Object.freeze({
    maxBodyBytes: MAX_INVESTMENT_PATCH_MUTATION_BYTES,
    maxFields: MAX_INVESTMENT_PATCH_MUTATION_FIELDS,
    repeatedFormFields: Object.freeze([]),
  }),
  DELETE: Object.freeze({
    maxBodyBytes: MAX_INVESTMENT_DELETE_MUTATION_BYTES,
    maxFields: MAX_INVESTMENT_DELETE_MUTATION_FIELDS,
    repeatedFormFields: Object.freeze([]),
  }),
} satisfies Readonly<
  Record<"POST" | "PATCH" | "DELETE", BrowserMutationVerificationLimits>
>);

type InvestmentInterestVerificationLimits = Readonly<{
  maxBodyBytes: number;
  maxFields: number;
  repeatedFormFields: readonly string[];
}>;

/** Route-owned limits selected before hosted or compatibility verification. */
export function investmentInterestMutationLimits(
  requestMethod: string,
): InvestmentInterestVerificationLimits {
  if (
    requestMethod !== "POST" &&
    requestMethod !== "PATCH" &&
    requestMethod !== "DELETE"
  ) {
    throw new MutationSecurityFailure("INVALID_REQUEST");
  }
  return INVESTMENT_MUTATION_LIMITS[requestMethod];
}

export type InvestmentInterestCsrfTokenProvider = (
  request: Request,
  actorSubject: ActorSubject,
) =>
  | string
  | BrowserMutationProof
  | null
  | Promise<string | BrowserMutationProof | null>;

export type InvestmentInterestMutationVerifier = (
  request: Request,
  limits: BrowserMutationVerificationLimits,
) => Promise<VerifiedMutationRequest & Readonly<{ clearCookie: string }>>;

export type InvestmentInterestRouteDependencies = Readonly<{
  serviceFor: ParticipantInvestmentInterestServiceFactory;
  mutationSecurity?: BrowserMutationGuardOptions;
  verifyMutation?: InvestmentInterestMutationVerifier;
  csrfTokenFor: InvestmentInterestCsrfTokenProvider;
  createOperationId?: () => string;
}>;

type MatchedInvestmentInterestRoute =
  | Readonly<{ kind: "collection" }>
  | Readonly<{
      kind: "item";
      indicationId: StableId<"investment-indication">;
    }>
  | Readonly<{ kind: "invalid" }>;

/** Create the participant-owned investment route group from injected services. */
export function createInvestmentInterestRouteHandler(
  dependencies: InvestmentInterestRouteDependencies,
): ApplicationRouteHandler {
  if (
    typeof dependencies.serviceFor !== "function" ||
    typeof dependencies.csrfTokenFor !== "function" ||
    (dependencies.verifyMutation === undefined) ===
      (dependencies.mutationSecurity === undefined)
  ) {
    throw new Error("Invalid investment-interest route configuration.");
  }

  const createOperationId = dependencies.createOperationId ?? randomOperationId;
  const hostedMutationVerifier = dependencies.verifyMutation;
  const verifier: (
    request: Request,
    limits: BrowserMutationVerificationLimits,
  ) => Promise<VerifiedMutationRequest & Readonly<{ clearCookie?: string }>> =
    hostedMutationVerifier ?? createLegacyMutationVerifier(
      dependencies.mutationSecurity as BrowserMutationGuardOptions,
    );

  return async (context) => {
    const matched = matchRoute(context.url.pathname);
    if (matched === null) return null;

    const representation = negotiateRepresentation(
      context.request.headers.get("accept"),
    );
    if (representation.kind === "not-acceptable") {
      return notAcceptableResponse(context.resourceUrl);
    }

    if (matched.kind === "invalid") {
      return errorResponse(
        routeError(
          context.resourceUrl,
          404,
          "not_found",
          "The requested resource was not found.",
        ),
        representation.kind,
      );
    }

    if (context.request.method === "GET") {
      const actorSubject = context.actor
        ? participantSubject(context.actor.userId)
        : null;
      if (actorSubject === null) {
        return errorResponse(
          authenticationRequiredError(context.resourceUrl),
          representation.kind,
        );
      }
      if (!authorizedParticipant(context, actorSubject)) {
        return errorResponse(
          notFoundError(context.resourceUrl),
          representation.kind,
        );
      }

      try {
        return await resourceResponse({
          context,
          representation: representation.kind,
          actorSubject,
          service: dependencies.serviceFor(actorSubject),
          csrfTokenFor: dependencies.csrfTokenFor,
          createOperationId,
          resource: matched,
          status: 200,
        });
      } catch (error) {
        return errorResponse(
          publicRouteError(error, context.resourceUrl),
          representation.kind,
        );
      }
    }

    if (!requestMethodAllowed(matched, context.request.method)) {
      return methodNotAllowedResponse(
        matched,
        context.resourceUrl,
        representation.kind,
      );
    }

    let clearCookie: string | null = null;
    try {
      assertExactResourceOrigin(context.request, context.resourceUrl);
      const verificationLimits = await investmentInterestVerificationLimits(
        context.request,
      );
      const verified = await verifier(context.request, verificationLimits);
      if (hostedMutationVerifier !== undefined) {
        if (!validSetCookie(verified.clearCookie)) {
          throw new MutationSecurityFailure("SERVICE_UNAVAILABLE");
        }
        clearCookie = verified.clearCookie;
      }
      if (
        verified.actor.type !== "participant" ||
        !authorizedParticipant(context, verified.actor.subject)
      ) {
        throw new StorageFailure("NOT_FOUND");
      }
      const service = dependencies.serviceFor(verified.actor.subject);

      if (matched.kind === "collection") {
        const input = parseCreateMutation(verified);
        const result = await service.create(input);
        return withSetCookie(await resourceResponse({
          context,
          representation: representation.kind,
          actorSubject: verified.actor.subject,
          service,
          csrfTokenFor: dependencies.csrfTokenFor,
          createOperationId,
          resource: Object.freeze({
            kind: "item",
            indicationId: result.snapshot.id,
          }),
          status: result.replayed ? 200 : 201,
        }), clearCookie);
      }

      const mutation = parseItemMutation(verified, matched.indicationId);
      if (mutation.kind === "edit") {
        await service.edit(mutation.input);
      } else if (mutation.kind === "withdraw") {
        await service.withdraw(mutation.input);
      } else {
        await service.reactivate(mutation.input);
      }

      return withSetCookie(await resourceResponse({
        context,
        representation: representation.kind,
        actorSubject: verified.actor.subject,
        service,
        csrfTokenFor: dependencies.csrfTokenFor,
        createOperationId,
        resource: matched,
        status: 200,
      }), clearCookie);
    } catch (error) {
      return withSetCookie(errorResponse(
        publicRouteError(error, context.resourceUrl),
        representation.kind,
      ), clearCookie);
    }
  };
}

function createLegacyMutationVerifier(
  options: BrowserMutationGuardOptions,
): (
  request: Request,
  limits: BrowserMutationVerificationLimits,
) => Promise<VerifiedMutationRequest> {
  return (request, limits) =>
    createBrowserMutationGuard(legacyGuardOptions(options, limits))(request);
}

async function investmentInterestVerificationLimits(
  request: Request,
): Promise<InvestmentInterestVerificationLimits> {
  const requestMethod = request.method;
  const direct = investmentInterestMutationLimits(requestMethod);
  if (
    requestMethod !== "POST" ||
    mutationMediaType(request.headers.get("content-type")) !==
      FORM_MUTATION_MEDIA_TYPE
  ) {
    return direct;
  }

  const bytes = await readBoundedPreflightBody(
    request,
    INVESTMENT_MUTATION_LIMITS.POST.maxBodyBytes,
  );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new MutationSecurityFailure("INVALID_REQUEST", { cause: error });
  }

  const entries = [...new URLSearchParams(text).entries()];
  const names = new Set<string>();
  let override: string | undefined;
  let businessFields = 0;
  for (const [name, value] of entries) {
    if (names.has(name)) {
      throw new MutationSecurityFailure("INVALID_REQUEST");
    }
    names.add(name);
    if (name === MUTATION_METHOD_FIELD) {
      override = value;
    } else if (name !== MUTATION_CSRF_FIELD) {
      businessFields += 1;
    }
  }

  if (override === undefined) return direct;
  if (override !== "PATCH" && override !== "DELETE") {
    throw new MutationSecurityFailure("INVALID_REQUEST");
  }

  const effective = investmentInterestMutationLimits(override);
  if (bytes.byteLength > effective.maxBodyBytes) {
    throw new MutationSecurityFailure("PAYLOAD_TOO_LARGE");
  }
  if (businessFields > effective.maxFields) {
    throw new MutationSecurityFailure("INVALID_REQUEST");
  }

  return Object.freeze({
    ...effective,
    maxFields: effective.maxFields + FORM_TRANSPORT_FIELD_COUNT,
  });
}

function mutationMediaType(value: string | null): string | null {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

async function readBoundedPreflightBody(
  request: Request,
  maximum: number,
): Promise<Uint8Array> {
  let copy: Request;
  try {
    copy = request.clone();
  } catch (error) {
    throw new MutationSecurityFailure("INVALID_REQUEST", { cause: error });
  }

  const declaredLength = copy.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(declaredLength)) {
      throw new MutationSecurityFailure("INVALID_REQUEST");
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length)) {
      throw new MutationSecurityFailure("INVALID_REQUEST");
    }
    if (length > maximum) {
      throw new MutationSecurityFailure("PAYLOAD_TOO_LARGE");
    }
  }

  if (copy.body === null) return new Uint8Array();
  const reader = copy.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximum) {
        // A cloned stream's cancellation may wait for its unread tee sibling.
        void reader.cancel().catch(() => undefined);
        throw new MutationSecurityFailure("PAYLOAD_TOO_LARGE");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof MutationSecurityFailure) throw error;
    throw new MutationSecurityFailure("INVALID_REQUEST", { cause: error });
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function legacyGuardOptions(
  options: BrowserMutationGuardOptions,
  limits: BrowserMutationVerificationLimits,
): BrowserMutationGuardOptions {
  return Object.freeze({
    ...options,
    maxBodyBytes: Math.min(
      options.maxBodyBytes ?? limits.maxBodyBytes ?? 1,
      limits.maxBodyBytes ?? 1,
    ),
    maxFields: Math.min(
      options.maxFields ?? limits.maxFields ?? 1,
      limits.maxFields ?? 1,
    ),
    repeatedFormFields: [],
  });
}

function parseCreateMutation(
  request: VerifiedMutationRequest,
): Readonly<{ operationId: string; fields: InvestmentIndicationFieldsInput }> {
  if (request.method !== "POST") invalidRequest();
  const kind = requiredKind(request.body[KIND_FIELD]);
  assertIndicationFields(request.body, kind, true);
  return Object.freeze({
    operationId: requiredString(request.body[OPERATION_ID_FIELD]),
    fields: parseIndicationFields(request.body, kind),
  });
}

type ItemMutation =
  | Readonly<{
      kind: "edit";
      input: Readonly<{
        operationId: string;
        indicationId: StableId<"investment-indication">;
        expectedRevision: number;
        fields: InvestmentIndicationFieldsInput;
      }>;
    }>
  | Readonly<{
      kind: "withdraw" | "reactivate";
      input: Readonly<{
        operationId: string;
        indicationId: StableId<"investment-indication">;
        expectedRevision: number;
      }>;
    }>;

function parseItemMutation(
  request: VerifiedMutationRequest,
  indicationId: StableId<"investment-indication">,
): ItemMutation {
  if (request.method === "PATCH") {
    const kind = requiredKind(request.body[KIND_FIELD]);
    assertIndicationFields(request.body, kind, false);
    return Object.freeze({
      kind: "edit",
      input: Object.freeze({
        operationId: requiredString(request.body[OPERATION_ID_FIELD]),
        indicationId,
        expectedRevision: requiredRevision(
          request.body[EXPECTED_REVISION_FIELD],
        ),
        fields: parseIndicationFields(request.body, kind),
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
        indicationId,
        expectedRevision: requiredRevision(
          request.body[EXPECTED_REVISION_FIELD],
        ),
      }),
    });
  }

  if (request.method === "POST") {
    assertExactFields(request.body, [
      OPERATION_ID_FIELD,
      EXPECTED_REVISION_FIELD,
      CONFIRM_REACTIVATION_FIELD,
    ]);
    if (!requiredConfirmation(request.body[CONFIRM_REACTIVATION_FIELD])) {
      invalidRequest();
    }
    return Object.freeze({
      kind: "reactivate",
      input: Object.freeze({
        operationId: requiredString(request.body[OPERATION_ID_FIELD]),
        indicationId,
        expectedRevision: requiredRevision(
          request.body[EXPECTED_REVISION_FIELD],
        ),
      }),
    });
  }

  invalidRequest();
}

type PersonalFieldsInput = Readonly<{
  kind: "personal";
  residenceCountry: string;
  amount: number;
  availabilityPeriod: string;
  note: string | null;
}>;

type CompanyFieldsInput = Readonly<{
  kind: "company";
  companyName: string;
  registrationCountry: string;
  companyIdentifier: string;
  representativeName: string;
  representativeAuthorityDeclared: true;
  amount: number;
  availabilityPeriod: string;
  note: string | null;
}>;

type InvestmentIndicationFieldsInput = PersonalFieldsInput | CompanyFieldsInput;

function parseIndicationFields(
  body: Readonly<Record<string, unknown>>,
  kind: InvestmentIndication["kind"],
): InvestmentIndicationFieldsInput {
  const common = {
    amount: requiredInteger(body.amount),
    availabilityPeriod: requiredString(body["availability-period"]),
    note: optionalString(body.note),
  };
  if (kind === "personal") {
    return Object.freeze({
      kind,
      residenceCountry: requiredString(body["residence-country"]),
      ...common,
    });
  }
  if (!requiredConfirmation(body["representative-authority-declared"])) {
    invalidRequest();
  }
  return Object.freeze({
    kind,
    companyName: requiredString(body["company-name"]),
    registrationCountry: requiredString(body["registration-country"]),
    companyIdentifier: requiredString(body["company-identifier"]),
    representativeName: requiredString(body["representative-name"]),
    representativeAuthorityDeclared: true,
    ...common,
  });
}

function assertIndicationFields(
  body: Readonly<Record<string, unknown>>,
  kind: InvestmentIndication["kind"],
  creating: boolean,
): void {
  const fields = kind === "personal"
    ? PERSONAL_FIELD_NAMES
    : COMPANY_FIELD_NAMES;
  assertExactFields(
    body,
    [
      OPERATION_ID_FIELD,
      ...(creating ? [] : [EXPECTED_REVISION_FIELD]),
      ...fields,
    ],
    ["note"],
  );
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

function requiredKind(value: unknown): InvestmentIndication["kind"] {
  if (value !== "personal" && value !== "company") invalidRequest();
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") invalidRequest();
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value);
}

function requiredInteger(value: unknown): number {
  const parsed =
    typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)
      ? Number(value)
      : value;
  if (
    typeof parsed !== "number" ||
    !Number.isSafeInteger(parsed) ||
    parsed < 0
  ) {
    invalidRequest();
  }
  return parsed;
}

function requiredRevision(value: unknown): number {
  const parsed = requiredInteger(value);
  if (parsed < 1 || parsed >= Number.MAX_SAFE_INTEGER) invalidRequest();
  return parsed;
}

function requiredConfirmation(value: unknown): boolean {
  return value === true || value === "true" || value === "on";
}

type ResourceResponseInput = Readonly<{
  context: ApplicationRouteContext;
  representation: "html" | "hypermedia-json";
  actorSubject: ActorSubject;
  service: ParticipantInvestmentInterestService;
  csrfTokenFor: InvestmentInterestCsrfTokenProvider;
  createOperationId: () => string;
  resource: Exclude<MatchedInvestmentInterestRoute, { kind: "invalid" }>;
  status: number;
}>;

async function resourceResponse(input: ResourceResponseInput): Promise<Response> {
  if (input.resource.kind === "collection") {
    const state = await input.service.getCollectionState();
    const model = createInvestmentInterestCollectionCapabilityModel({
      requestUrl: input.context.resourceUrl,
      ...state,
      operationIds: {
        createPersonal: state.canCreatePersonal
          ? issueOperationId(input.createOperationId)
          : null,
        createCompany: state.canCreateCompany
          ? issueOperationId(input.createOperationId)
          : null,
      },
    });
    const csrf = await csrfProofForActions(
      model.actionContracts,
      input.context,
      input.actorSubject,
      input.csrfTokenFor,
    );
    if (input.representation === "hypermedia-json") {
      return withSetCookie(hypermediaResponseWithCsrf(
        model.document,
        input.status,
        csrf?.token ?? null,
      ), csrf?.setCookie ?? null);
    }
    return withSetCookie(htmlResponse(
      renderCollectionHtml(
        model,
        state,
        csrf?.token ?? null,
        input.context.campaign?.name ?? "Campaign",
      ),
      input.status,
    ), csrf?.setCookie ?? null);
  }

  const state = await input.service.getItemState(input.resource.indicationId);
  if (state === null) throw new StorageFailure("NOT_FOUND");
  const model = createInvestmentInterestItemCapabilityModel({
    requestUrl: input.context.resourceUrl,
    ...state,
    operationIds: {
      edit: state.canEdit ? issueOperationId(input.createOperationId) : null,
      withdraw: state.canWithdraw
        ? issueOperationId(input.createOperationId)
        : null,
      reactivate: state.canReactivate
        ? issueOperationId(input.createOperationId)
        : null,
    },
  });
  const csrf = await csrfProofForActions(
    model.actionContracts,
    input.context,
    input.actorSubject,
    input.csrfTokenFor,
  );
  if (input.representation === "hypermedia-json") {
    return withSetCookie(hypermediaResponseWithCsrf(
      model.document,
      input.status,
      csrf?.token ?? null,
    ), csrf?.setCookie ?? null);
  }
  return withSetCookie(htmlResponse(
    renderItemHtml(
      model,
      state,
      csrf?.token ?? null,
      input.context.campaign?.name ?? "Campaign",
    ),
    input.status,
  ), csrf?.setCookie ?? null);
}

async function csrfProofForActions(
  actions: readonly Readonly<{ method: string }>[],
  context: ApplicationRouteContext,
  actorSubject: ActorSubject,
  provider: InvestmentInterestCsrfTokenProvider,
): Promise<Readonly<{ token: string; setCookie: string | null }> | null> {
  if (!actions.some((action) => action.method !== "GET")) return null;
  const value = await provider(context.request, actorSubject);
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
  document: unknown,
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
  const target = new URL(requestUrl);
  const returnTo = `${target.pathname}${target.search}`;
  const signIn = toHypermediaAction(defineAction({
    name: "sign-in",
    title: "Sign in",
    method: "GET",
    href: new URL(chatGPTSignInPath(returnTo), requestUrl).href,
    requestMediaType: "text/html",
    fields: [],
  }));
  return routeError(
    requestUrl,
    401,
    "authentication_required",
    "Sign in to view your investment interest.",
    [signIn],
  );
}

function notFoundError(requestUrl: string): RouteError {
  return routeError(
    requestUrl,
    404,
    "not_found",
    "The requested resource was not found.",
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
        message: "Check the indication details and try again.",
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
        message: "This request conflicts with the current indication state.",
      };
    case "PRECONDITION_FAILED":
      return {
        status: 412,
        code: "precondition_failed",
        message: "The indication or information package has changed. Reload and try again.",
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
          href: requestUrl,
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

function methodNotAllowedResponse(
  matched: Exclude<MatchedInvestmentInterestRoute, { kind: "invalid" }>,
  requestUrl: string,
  representation: "html" | "hypermedia-json",
): Response {
  const response = errorResponse(
    routeError(
      requestUrl,
      405,
      "method_not_allowed",
      "This request method is not available for the indication.",
    ),
    representation,
  );
  const headers = new Headers(response.headers);
  headers.set(
    "Allow",
    matched.kind === "collection" ? "GET, POST" : "GET, POST, PATCH, DELETE",
  );
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

function renderCollectionHtml(
  model: InvestmentInterestCollectionCapabilityModel,
  state: InvestmentInterestCollectionState,
  csrfToken: string | null,
  campaignName: string,
): string {
  const packageNotice = state.acknowledgmentCurrent
    ? ""
    : `<aside class="investment-notice"><strong>Review required</strong><p>Review and accept the current information package before adding, editing, or reactivating an indication.</p><a href="${escapeHtml(new URL("/participant/package", model.document.links[0]?.href).href)}">Open information package</a></aside>`;
  const indicationList = state.indications.length === 0
    ? `<p class="investment-empty">You have not submitted an investment indication.</p>`
    : `<ol class="investment-list">${model.document.data.indications.map((item) => `
      <li><a href="${escapeHtml(item.href)}"><span>${escapeHtml(summaryTitle(item.fields))}</span><small>${escapeHtml(statusLabel(item.status))} · ${escapeHtml(formatAmount(item.fields.amount, item.fields.currency))}</small></a></li>`).join("")}</ol>`;
  const forms = renderForms(model.forms, csrfToken);

  return pageShell(
    "Your investment interest",
    campaignName,
    `<main class="investment-main" aria-labelledby="investment-title">
      <a class="investment-back" href="${escapeHtml(new URL("/participant", model.document.links[0]?.href).href)}">Participant home</a>
      <header class="investment-intro">
        <p class="investment-eyebrow">Investment interest</p>
        <h1 id="investment-title">Your investment interest</h1>
        <p>Record a personal or company indication for this campaign. Every indication is non-binding and can be changed or withdrawn while its current actions are available.</p>
      </header>
      ${packageNotice}
      <section class="investment-section" aria-labelledby="current-interests">
        <div><p class="investment-eyebrow">Submitted</p><h2 id="current-interests">Current indications</h2></div>
        <div>${indicationList}</div>
      </section>
      ${forms}
    </main>`,
  );
}

function renderItemHtml(
  model: InvestmentInterestItemCapabilityModel,
  state: InvestmentInterestItemState,
  csrfToken: string | null,
  campaignName: string,
): string {
  const data = model.document.data;
  const title = summaryTitle(data.fields);
  const packageNotice = state.acknowledgmentCurrent
    ? ""
    : `<aside class="investment-notice"><strong>Review required</strong><p>Review and accept the current information package before editing or reactivating this indication.</p><a href="${escapeHtml(new URL("/participant/package", model.document.links[0]?.href).href)}">Open information package</a></aside>`;
  return pageShell(
    title,
    campaignName,
    `<main class="investment-main" aria-labelledby="investment-title">
      <a class="investment-back" href="${escapeHtml(new URL(INVESTMENT_INTEREST_PATH, model.document.links[0]?.href).href)}">All investment interests</a>
      <header class="investment-intro">
        <p class="investment-eyebrow">${escapeHtml(kindLabel(data.kind))}</p>
        <h1 id="investment-title">${escapeHtml(title)}</h1>
        <p>This is a non-binding expression of interest. Its current state and complete revision history are shown below.</p>
      </header>
      ${packageNotice}
      <section class="investment-section" aria-labelledby="indication-state">
        <div><p class="investment-eyebrow">Current state</p><h2 id="indication-state">${escapeHtml(statusLabel(data.status))}</h2><p class="investment-meta">Revision ${data.revision} · Updated ${escapeHtml(formatTimestamp(data.updated_at))}</p></div>
        <dl class="investment-details">${renderFields(data.fields)}${data.rejection_reason ? detail("Review note", data.rejection_reason) : ""}</dl>
      </section>
      ${renderForms(model.forms, csrfToken)}
      ${renderHistory(data.history)}
    </main>`,
  );
}

function renderForms(
  forms: readonly HtmlFormAction[],
  csrfToken: string | null,
): string {
  if (forms.length === 0 || csrfToken === null) return "";
  return forms.map((form) => {
    const destructive = form.effectiveMethod === "DELETE";
    const label = form.name.startsWith("create-company")
      ? "Company indication"
      : form.name.startsWith("create-personal")
        ? "Personal indication"
        : form.title;
    return `<section class="investment-form-band${destructive ? " investment-form-band--danger" : ""}" aria-labelledby="form-${escapeHtml(form.name)}">
      <div><p class="investment-eyebrow">Action</p><h2 id="form-${escapeHtml(form.name)}">${escapeHtml(label)}</h2></div>
      ${renderForm(form, csrfToken)}
    </section>`;
  }).join("");
}

function renderForm(form: HtmlFormAction, csrfToken: string): string {
  const hidden = [
    ...form.hiddenFields.map((field) => hiddenInput(field.name, field.value)),
    hiddenInput("_csrf", csrfToken),
  ].join("");
  return `<form action="${escapeHtml(form.action)}" method="${form.method}"${form.encoding ? ` enctype="${form.encoding}"` : ""} data-action-name="${escapeHtml(form.name)}" data-effective-method="${form.effectiveMethod}">
    ${hidden}${form.fields.map(renderFormField).join("")}
    <button class="investment-submit" type="submit">${escapeHtml(form.title)}</button>
  </form>`;
}

function renderFormField(field: HtmlFormField): string {
  const value = field.value ?? field.defaultValue;
  if (field.presentation === "hidden") {
    return hiddenInput(field.name, value ?? "");
  }
  if (field.inputType === "checkbox") {
    return `<label class="investment-checkbox"><input name="${escapeHtml(field.name)}" type="checkbox" value="true"${value === true ? " checked" : ""}${field.required ? " required" : ""}><span>${escapeHtml(field.label)}</span></label>`;
  }

  const attributes = `${field.required ? " required" : ""}${field.minLength === undefined ? "" : ` minlength="${field.minLength}"`}${field.maxLength === undefined ? "" : ` maxlength="${field.maxLength}"`}${numericAttribute("min", field.minimum)}${numericAttribute("max", field.maximum)}${numericAttribute("step", field.step)}`;
  if (field.control === "textarea") {
    return `<label class="investment-field"><span>${escapeHtml(field.label)}</span><textarea name="${escapeHtml(field.name)}"${attributes}>${escapeHtml(String(value ?? ""))}</textarea></label>`;
  }
  if (field.control === "select") {
    const selected = new Set(
      field.multiple
        ? field.values ?? field.defaultValues ?? []
        : value === undefined
          ? []
          : [String(value)],
    );
    return `<label class="investment-field"><span>${escapeHtml(field.label)}</span><select name="${escapeHtml(field.name)}"${field.multiple ? " multiple" : ""}${attributes}>${(field.choices ?? []).map((choice) => `<option value="${escapeHtml(choice.value)}"${selected.has(choice.value) ? " selected" : ""}>${escapeHtml(choice.label)}</option>`).join("")}</select></label>`;
  }
  return `<label class="investment-field"><span>${escapeHtml(field.label)}</span><input name="${escapeHtml(field.name)}" type="${field.inputType ?? "text"}" value="${escapeHtml(String(value ?? ""))}"${attributes}></label>`;
}

function renderFields(fields: InvestmentInterestFieldsData): string {
  const common = [
    detail("Amount", formatAmount(fields.amount, fields.currency)),
    detail("Availability", fields.availability_period),
    detail("Additional note", fields.note ?? "Not provided"),
  ];
  if (fields.kind === "personal") {
    return [detail("Residence country", fields.residence_country), ...common].join("");
  }
  return [
    detail("Company", fields.company_name),
    detail("Registration country", fields.registration_country),
    detail("Registration identifier", fields.company_identifier),
    detail("Representative", fields.representative_name),
    detail("Authority declaration", "Confirmed"),
    ...common,
  ].join("");
}

function renderHistory(
  history: readonly Readonly<{
    revision: number;
    transition: string;
    occurred_at: string;
    fields: InvestmentInterestFieldsData;
    rejection_reason: string | null;
  }>[],
): string {
  return `<section class="investment-history" aria-labelledby="indication-history"><p class="investment-eyebrow">Record</p><h2 id="indication-history">Revision history</h2><ol>${[...history].reverse().map((entry) => `<li><details${entry.revision === history.length ? " open" : ""}><summary><strong>Revision ${entry.revision} · ${escapeHtml(transitionLabel(entry.transition))}</strong><span>${escapeHtml(formatTimestamp(entry.occurred_at))}</span></summary><dl class="investment-details">${renderFields(entry.fields)}${entry.rejection_reason ? detail("Review note", entry.rejection_reason) : ""}</dl></details></li>`).join("")}</ol></section>`;
}

function renderErrorHtml(document: RouteErrorDocument): string {
  const action = document.actions[0];
  return pageShell(
    document.data.message,
    "Investor App",
    `<main class="investment-main investment-error"><p class="investment-eyebrow">Request unavailable</p><h1>${escapeHtml(document.data.message)}</h1><div class="investment-error-actions">${action ? `<a class="investment-submit" href="${escapeHtml(action.href)}">${escapeHtml(action.title)}</a>` : ""}<a href="${escapeHtml(new URL("/", document.links[0]?.href).href)}">Return to campaign</a></div></main>`,
  );
}

function pageShell(title: string, campaignName: string, main: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} · ${escapeHtml(campaignName)}</title><style>${INVESTMENT_PAGE_CSS}</style></head><body class="investment-page"><header class="investment-topbar"><a href="/">${escapeHtml(campaignName)}</a><span>Private participant area</span></header>${main}</body></html>`;
}

function detail(label: string, value: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function summaryTitle(fields: InvestmentInterestFieldsData): string {
  return fields.kind === "company" ? fields.company_name : "Personal indication";
}

function kindLabel(kind: InvestmentIndication["kind"]): string {
  return kind === "company" ? "Company indication" : "Personal indication";
}

function statusLabel(status: InvestmentIndication["lifecycle"]["status"]): string {
  if (status === "active") return "Active";
  if (status === "withdrawn") return "Withdrawn";
  return "Not proceeding";
}

function transitionLabel(value: string): string {
  if (value === "created") return "Submitted";
  if (value === "edited") return "Updated";
  if (value === "withdrawn") return "Withdrawn";
  if (value === "reactivated") return "Reactivated";
  return "Reviewed";
}

function formatAmount(amount: number, currency: string): string {
  return `${new Intl.NumberFormat("en").format(amount)} ${currency} minor units`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(date);
}

function hiddenInput(name: string, value: string | number | boolean): string {
  return `<input name="${escapeHtml(name)}" type="hidden" value="${escapeHtml(String(value))}">`;
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

function matchRoute(pathname: string): MatchedInvestmentInterestRoute | null {
  if (pathname === INVESTMENT_INTEREST_PATH) {
    return Object.freeze({ kind: "collection" });
  }
  const prefix = `${INVESTMENT_INTEREST_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length);
  if (encoded.length === 0 || encoded.includes("/")) {
    return Object.freeze({ kind: "invalid" });
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return Object.freeze({ kind: "invalid" });
  }
  const id = parseStableId<"investment-indication">(decoded);
  return id.ok
    ? Object.freeze({ kind: "item", indicationId: id.value })
    : Object.freeze({ kind: "invalid" });
}

function authorizedParticipant(
  context: ApplicationRouteContext,
  actorSubject: ActorSubject,
): boolean {
  const actor = context.actor ? participantSubject(context.actor.userId) : null;
  const access = context.participantAccess;
  return actor === actorSubject &&
    access !== null &&
    access.subject === actorSubject &&
    access.accountStatus === "active" &&
    (access.declaredInterest === "investor" ||
      access.declaredInterest === "both");
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

function participantSubject(value: unknown): ActorSubject | null {
  const parsed = parseActorSubject(value);
  return parsed.ok ? parsed.value : null;
}

function requestMethodAllowed(
  route: Exclude<MatchedInvestmentInterestRoute, { kind: "invalid" }>,
  value: string,
): boolean {
  const method = value.toUpperCase();
  return route.kind === "collection"
    ? method === "POST"
    : method === "POST" || method === "PATCH" || method === "DELETE";
}

function randomOperationId(): string {
  return `investment-operation:${crypto.randomUUID()}`;
}

function issueOperationId(createOperationId: () => string): string {
  let value: unknown;
  try {
    value = createOperationId();
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
  const parsed = parseStorageOperationId(value);
  if (!parsed.ok) throw new StorageFailure("UNAVAILABLE");
  return parsed.value;
}

function invalidRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      vary: "Accept",
      "x-content-type-options": "nosniff",
    },
  });
}

const INVESTMENT_PAGE_CSS = `
.investment-page,.investment-page *{box-sizing:border-box}.investment-page{--ink:#12241d;--muted:#5c6c65;--line:#d6dfda;--paper:#f7f9f7;--white:#fff;--green:#176044;--green-dark:#0d4933;--green-pale:#dfeee6;--coral:#a74732;margin:0;background:var(--paper);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}.investment-page a{color:var(--green-dark)}.investment-topbar{display:flex;min-height:62px;align-items:center;justify-content:space-between;gap:20px;padding:0 max(24px,calc((100% - 1120px)/2));border-bottom:1px solid var(--line);background:var(--white)}.investment-topbar a{color:var(--ink);font-weight:800;text-decoration:none}.investment-topbar span{color:var(--muted);font-size:.78rem}.investment-main{width:min(1120px,calc(100% - 48px));margin:0 auto;padding:54px 0 80px}.investment-back{display:inline-block;margin-bottom:42px;font-size:.86rem;font-weight:700}.investment-intro{max-width:760px;margin-bottom:42px}.investment-eyebrow{margin:0 0 9px;color:var(--green);font-size:.76rem;font-weight:800;text-transform:uppercase}.investment-intro h1,.investment-error h1{max-width:820px;margin:0 0 18px;font-size:4rem;line-height:1.02;letter-spacing:0}.investment-intro>p:last-child{max-width:720px;margin:0;color:var(--muted);font-size:1.03rem;line-height:1.65}.investment-notice{display:grid;grid-template-columns:180px minmax(0,1fr) auto;gap:20px;align-items:center;margin:0 0 46px;padding:18px 0;border-top:2px solid var(--coral);border-bottom:1px solid var(--line)}.investment-notice strong{font-size:.9rem}.investment-notice p{margin:0;color:var(--muted);line-height:1.5}.investment-notice a{font-size:.85rem;font-weight:800}.investment-section,.investment-form-band{display:grid;grid-template-columns:minmax(180px,280px) minmax(0,1fr);gap:56px;padding:36px 0;border-top:1px solid var(--line)}.investment-section h2,.investment-form-band h2,.investment-history h2{margin:0;font-size:1.45rem;line-height:1.2}.investment-meta{color:var(--muted);font-size:.8rem}.investment-empty{margin:0;color:var(--muted)}.investment-list{margin:0;padding:0;border-top:1px solid var(--line);list-style:none}.investment-list li{border-bottom:1px solid var(--line)}.investment-list a{display:flex;min-height:74px;align-items:center;justify-content:space-between;gap:20px;padding:14px 2px;color:var(--ink);text-decoration:none}.investment-list a:hover span{text-decoration:underline}.investment-list span{font-weight:760}.investment-list small{color:var(--muted);text-align:right}.investment-details{margin:0}.investment-details>div{display:grid;grid-template-columns:190px minmax(0,1fr);gap:22px;padding:12px 0;border-bottom:1px solid var(--line)}.investment-details dt{color:var(--muted);font-size:.8rem}.investment-details dd{min-width:0;margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:.91rem;line-height:1.5}.investment-form-band{align-items:start}.investment-form-band form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 20px}.investment-field{display:grid;min-width:0;gap:7px}.investment-field:has(textarea){grid-column:1/-1}.investment-field>span{font-size:.8rem;font-weight:720}.investment-field input,.investment-field textarea,.investment-field select{width:100%;min-height:42px;padding:10px 11px;border:1px solid #aebbb5;border-radius:6px;background:var(--white);color:var(--ink);font:inherit}.investment-field textarea{min-height:112px;resize:vertical}.investment-checkbox{display:flex;grid-column:1/-1;gap:10px;align-items:flex-start;padding:12px 0;font-size:.9rem;font-weight:680}.investment-checkbox input{width:18px;height:18px;flex:0 0 18px;margin:1px 0}.investment-submit{display:inline-flex;min-height:42px;grid-column:1/-1;align-items:center;justify-content:center;justify-self:start;padding:10px 16px;border:1px solid var(--green-dark);border-radius:6px;background:var(--green-dark);color:#fff!important;font:inherit;font-size:.84rem;font-weight:760;text-decoration:none;cursor:pointer}.investment-form-band--danger{border-top-color:#dfbbb2}.investment-form-band--danger .investment-submit{border-color:var(--coral);background:var(--coral)}.investment-history{margin-top:42px;padding-top:30px;border-top:1px solid var(--line)}.investment-history ol{margin:24px 0 0;padding:0;border-top:1px solid var(--line);list-style:none}.investment-history li{border-bottom:1px solid var(--line)}.investment-history summary{display:flex;justify-content:space-between;gap:20px;padding:18px 0;cursor:pointer}.investment-history summary span{color:var(--muted);font-size:.78rem}.investment-history details .investment-details{margin-bottom:24px;padding-left:20px;border-left:3px solid var(--green-pale)}.investment-error{max-width:760px}.investment-error-actions{display:flex;flex-wrap:wrap;gap:18px;align-items:center;margin-top:28px}@media(max-width:760px){.investment-topbar{padding:0 20px}.investment-main{width:min(100% - 40px,1120px);padding:42px 0 62px}.investment-back{margin-bottom:32px}.investment-intro h1,.investment-error h1{font-size:2.35rem}.investment-notice,.investment-section,.investment-form-band{grid-template-columns:1fr;gap:24px}.investment-notice a{justify-self:start}.investment-details>div{grid-template-columns:1fr;gap:5px}.investment-form-band form{grid-template-columns:1fr}.investment-field:has(textarea){grid-column:auto}.investment-submit{width:100%;justify-self:stretch}.investment-list a{display:grid;gap:6px}.investment-list small{text-align:left}.investment-history summary{display:grid;gap:6px}.investment-history details .investment-details{padding-left:12px}}
`;
