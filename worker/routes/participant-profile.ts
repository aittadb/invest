import { chatGPTSignInPath } from "../../domain/auth-navigation.ts";
import {
  parseTimestamp,
  type Timestamp,
} from "../../domain/foundation.ts";
import {
  defineAction,
  toHypermediaAction,
  type HtmlFormAction,
  type HtmlFormField,
} from "../../domain/hypermedia-action.ts";
import {
  parseAuthorizedParticipantAccess,
  type AuthorizedParticipantAccess,
} from "../../domain/participant-home-resource.ts";
import {
  PARTICIPANT_PROFILE_PATH,
  createParticipantProfileCapabilityModel,
  participantProfileOperations,
  validateParticipantProfileResourceState,
  type ParticipantProfileAcknowledgmentState,
  type ParticipantProfileCapabilityModel,
  type ParticipantProfileOperation,
  type ParticipantProfileOperationIds,
} from "../../domain/participant-profile-resource.ts";
import {
  isParticipantProfileDescendantProjection,
  parseParticipantAccount,
  requestParticipantAccountDeletion,
  updateParticipantProfile,
  withdrawMarketingConsent,
  type ParticipantAccount,
  type ParticipantProfile,
} from "../../domain/participant-profile.ts";
import {
  INVESTOR_APP_API_VERSION,
  type HypermediaAction,
  type HypermediaLink,
} from "../../domain/public-campaign-resource.ts";
import {
  StorageFailure,
  parseStorageOperationId,
  type StorageFailureCode,
  type StorageOperationId,
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
  BrowserMutationProof,
  BrowserMutationVerificationLimits,
} from "../../http/browser-mutation-session.ts";
import type {
  ParticipantProfileMutationResult,
  ParticipantProfileSnapshot,
  ParticipantRepository,
} from "../../repositories/in-memory-participant-repository.ts";
import type { ApplicationRouteHandler } from "../contracts.ts";
import {
  hypermediaResponse,
  notAcceptableResponse,
} from "./responses.ts";

const OPERATION_ID_FIELD = "operation-id";
const EXPECTED_REVISION_FIELD = "expected-revision";
const DISPLAY_NAME_FIELD = "display-name";
const COUNTRY_FIELD = "country";
const DECLARED_INTEREST_FIELD = "declared-interest";
const PARTICIPATION_CONTEXT_FIELD = "participation-context";
const MARKETING_CONFIRMATION_FIELD =
  "confirm-marketing-consent-withdrawal";
const DELETION_CONFIRMATION_FIELD = "confirm-account-deletion-request";

const UPDATE_FIELDS = Object.freeze([
  OPERATION_ID_FIELD,
  EXPECTED_REVISION_FIELD,
  DISPLAY_NAME_FIELD,
  COUNTRY_FIELD,
  DECLARED_INTEREST_FIELD,
  PARTICIPATION_CONTEXT_FIELD,
]);
const MARKETING_WITHDRAWAL_FIELDS = Object.freeze([
  OPERATION_ID_FIELD,
  EXPECTED_REVISION_FIELD,
  MARKETING_CONFIRMATION_FIELD,
]);
const DELETION_REQUEST_FIELDS = Object.freeze([
  OPERATION_ID_FIELD,
  EXPECTED_REVISION_FIELD,
  DELETION_CONFIRMATION_FIELD,
]);

export const MAX_PROFILE_POST_MUTATION_BYTES = 2_048;
export const MAX_PROFILE_POST_MUTATION_FIELDS = 8;
export const MAX_PROFILE_PATCH_MUTATION_BYTES = 2_048;
export const MAX_PROFILE_PATCH_MUTATION_FIELDS = 6;
export const MAX_PROFILE_DELETE_MUTATION_BYTES = 512;
export const MAX_PROFILE_DELETE_MUTATION_FIELDS = 3;

const PROFILE_MUTATION_LIMITS = Object.freeze({
  POST: Object.freeze({
    maxBodyBytes: MAX_PROFILE_POST_MUTATION_BYTES,
    maxFields: MAX_PROFILE_POST_MUTATION_FIELDS,
    repeatedFormFields: Object.freeze([]),
  }),
  PATCH: Object.freeze({
    maxBodyBytes: MAX_PROFILE_PATCH_MUTATION_BYTES,
    maxFields: MAX_PROFILE_PATCH_MUTATION_FIELDS,
    repeatedFormFields: Object.freeze([]),
  }),
  DELETE: Object.freeze({
    maxBodyBytes: MAX_PROFILE_DELETE_MUTATION_BYTES,
    maxFields: MAX_PROFILE_DELETE_MUTATION_FIELDS,
    repeatedFormFields: Object.freeze([]),
  }),
} satisfies Readonly<
  Record<"POST" | "PATCH" | "DELETE", BrowserMutationVerificationLimits>
>);

/** Route-owned limits selected before hosted or compatibility verification. */
export function participantProfileMutationLimits(
  requestMethod: string,
): BrowserMutationVerificationLimits {
  if (
    requestMethod !== "POST" &&
    requestMethod !== "PATCH" &&
    requestMethod !== "DELETE"
  ) {
    throw new MutationSecurityFailure("INVALID_REQUEST");
  }
  return PROFILE_MUTATION_LIMITS[requestMethod];
}

export type ParticipantProfileRepositoryFactory = (
  account: ParticipantAccount,
) => ParticipantRepository;

export type ParticipantProfileCsrfTokenProvider = (
  request: Request,
  account: ParticipantAccount,
) =>
  | string
  | BrowserMutationProof
  | null
  | Promise<string | BrowserMutationProof | null>;

export type ParticipantProfileMutationVerifier = (
  request: Request,
) => Promise<
  VerifiedMutationRequest & Readonly<{ clearCookie: string }>
>;

export type ParticipantProfileRouteDependencies = Readonly<{
  repositoryFor: ParticipantProfileRepositoryFactory;
  mutationSecurity?: BrowserMutationGuardOptions;
  verifyMutation?: ParticipantProfileMutationVerifier;
  csrfTokenFor: ParticipantProfileCsrfTokenProvider;
  now?: () => Date;
  createOperationId?: (operation: ParticipantProfileOperation) => string;
}>;

/** Create participant self-service without installing global persistence. */
export function createParticipantProfileRouteHandler(
  dependencies: ParticipantProfileRouteDependencies,
): ApplicationRouteHandler {
  if (
    typeof dependencies.repositoryFor !== "function" ||
    typeof dependencies.csrfTokenFor !== "function" ||
    (dependencies.verifyMutation === undefined) ===
      (dependencies.mutationSecurity === undefined)
  ) {
    throw new Error("Invalid participant-profile route configuration.");
  }
  const now = dependencies.now ?? (() => new Date());
  const createOperationId = dependencies.createOperationId ?? randomOperationId;
  if (typeof now !== "function" || typeof createOperationId !== "function") {
    throw new Error("Invalid participant-profile route configuration.");
  }
  const hostedMutationVerifier = dependencies.verifyMutation;
  const mutationGuard: (
    request: Request,
  ) => Promise<VerifiedMutationRequest & Readonly<{ clearCookie?: string }>> =
    hostedMutationVerifier ?? createLegacyMutationVerifier(
      dependencies.mutationSecurity as BrowserMutationGuardOptions,
    );

  return async (context) => {
    if (context.url.pathname !== PARTICIPANT_PROFILE_PATH) return null;

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
        const authorized = requiredAuthorizedParticipant(context);
        const repository = requiredRepository(
          dependencies.repositoryFor,
          authorized.account,
        );
        const current = requireCurrentProfile(
          await repository.current(),
          authorized,
        );
        return await resourceResponse({
          context,
          representation: representation.kind,
          account: authorized.account,
          current,
          acknowledgment: acknowledgmentState(authorized.access),
          csrfTokenFor: dependencies.csrfTokenFor,
          createOperationId,
        });
      } catch (error) {
        return errorResponse(
          publicRouteError(error, context.resourceUrl),
          representation.kind,
        );
      }
    }

    if (
      context.request.method !== "POST" &&
      context.request.method !== "PATCH" &&
      context.request.method !== "DELETE"
    ) {
      return methodNotAllowedResponse(context.resourceUrl, representation.kind);
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
      const authorized = requiredAuthorizedParticipant(context);
      if (
        verified.actor.type !== "participant" ||
        verified.actor.subject !== authorized.account.subject
      ) {
        notFound();
      }

      const repository = requiredRepository(
        dependencies.repositoryFor,
        authorized.account,
      );
      const current = requireCurrentProfile(
        await repository.current(),
        authorized,
      );
      const mutation = parseProfileMutation(verified);
      requireMutationAvailable(current, mutation);
      const applied = await applyMutationWithReplayRecovery(
        repository,
        authorized.account,
        mutation,
        current,
        now,
      );
      requireMutationResult(
        applied.result,
        current,
        applied.base,
        mutation,
        applied.occurredAt,
        authorized.account,
      );
      const latest = requireLatestProfileAfterMutation(
        await repository.current(),
        authorized.account,
        current,
        applied.result,
      );

      return withSetCookie(await resourceResponse({
        context,
        representation: representation.kind,
        account: authorized.account,
        current: latest,
        acknowledgment: acknowledgmentState(authorized.access),
        csrfTokenFor: dependencies.csrfTokenFor,
        createOperationId,
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
): (request: Request) => Promise<VerifiedMutationRequest> {
  const guards = Object.freeze({
    POST: createBrowserMutationGuard(
      legacyGuardOptions(options, PROFILE_MUTATION_LIMITS.POST),
    ),
    PATCH: createBrowserMutationGuard(
      legacyGuardOptions(options, PROFILE_MUTATION_LIMITS.PATCH),
    ),
    DELETE: createBrowserMutationGuard(
      legacyGuardOptions(options, PROFILE_MUTATION_LIMITS.DELETE),
    ),
  });
  return (request) => {
    const method = request.method;
    if (method !== "POST" && method !== "PATCH" && method !== "DELETE") {
      throw new MutationSecurityFailure("INVALID_REQUEST");
    }
    return guards[method](request);
  };
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

type ProfileMutation =
  | Readonly<{
      kind: "update";
      operationId: StorageOperationId;
      expectedRevision: number;
      changes: Readonly<{
        displayName: string;
        country: string;
        declaredInterest: string;
        participationContext: string;
      }>;
    }>
  | Readonly<{
      kind: "withdraw-marketing-consent";
      operationId: StorageOperationId;
      expectedRevision: number;
    }>
  | Readonly<{
      kind: "request-account-deletion";
      operationId: StorageOperationId;
      expectedRevision: number;
    }>;

function parseProfileMutation(request: VerifiedMutationRequest): ProfileMutation {
  if (request.method === "PATCH") {
    assertExactFields(request.body, UPDATE_FIELDS);
    return Object.freeze({
      kind: "update" as const,
      operationId: requiredOperationId(request.body[OPERATION_ID_FIELD]),
      expectedRevision: requiredRevision(
        request.body[EXPECTED_REVISION_FIELD],
      ),
      changes: Object.freeze({
        displayName: requiredString(request.body[DISPLAY_NAME_FIELD]),
        country: requiredString(request.body[COUNTRY_FIELD]),
        declaredInterest: requiredString(
          request.body[DECLARED_INTEREST_FIELD],
        ),
        participationContext: requiredString(
          request.body[PARTICIPATION_CONTEXT_FIELD],
        ),
      }),
    });
  }

  if (request.method === "DELETE") {
    assertExactFields(request.body, MARKETING_WITHDRAWAL_FIELDS);
    if (!requiredConfirmation(request.body[MARKETING_CONFIRMATION_FIELD])) {
      invalidRequest();
    }
    return Object.freeze({
      kind: "withdraw-marketing-consent" as const,
      operationId: requiredOperationId(request.body[OPERATION_ID_FIELD]),
      expectedRevision: requiredRevision(
        request.body[EXPECTED_REVISION_FIELD],
      ),
    });
  }

  if (request.method === "POST") {
    assertExactFields(request.body, DELETION_REQUEST_FIELDS);
    if (!requiredConfirmation(request.body[DELETION_CONFIRMATION_FIELD])) {
      invalidRequest();
    }
    return Object.freeze({
      kind: "request-account-deletion" as const,
      operationId: requiredOperationId(request.body[OPERATION_ID_FIELD]),
      expectedRevision: requiredRevision(
        request.body[EXPECTED_REVISION_FIELD],
      ),
    });
  }

  invalidRequest();
}

function assertExactFields(
  body: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const allowed = new Set(expected);
  const fields = Object.keys(body);
  if (
    fields.length !== expected.length ||
    fields.some((name) => !allowed.has(name)) ||
    expected.some((name) => !Object.hasOwn(body, name))
  ) {
    invalidRequest();
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") invalidRequest();
  return value;
}

function requiredOperationId(value: unknown): StorageOperationId {
  const parsed = parseStorageOperationId(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function requiredRevision(value: unknown): number {
  const candidate = typeof value === "string" && /^[1-9]\d*$/u.test(value)
    ? Number(value)
    : value;
  if (
    !Number.isSafeInteger(candidate) ||
    (candidate as number) < 1 ||
    (candidate as number) >= Number.MAX_SAFE_INTEGER
  ) {
    invalidRequest();
  }
  return candidate as number;
}

function requiredConfirmation(value: unknown): boolean {
  return value === true || value === "true" || value === "on";
}

function requireMutationAvailable(
  current: ParticipantProfileSnapshot,
  mutation: ProfileMutation,
): void {
  if (mutation.expectedRevision !== current.revision) return;
  requireMutationAvailableFromBase(current, mutation);
}

function requireMutationAvailableFromBase(
  base: ParticipantProfileSnapshot,
  mutation: ProfileMutation,
): void {
  if (base.revision !== mutation.expectedRevision) unavailable();
  const available = new Set(participantProfileOperations(base.snapshot));
  if (!available.has(mutation.kind)) conflict();
}

async function applyMutation(
  repository: ParticipantRepository,
  mutation: ProfileMutation,
  occurredAt: Timestamp,
): Promise<ParticipantProfileMutationResult> {
  if (mutation.kind === "update") {
    return repository.update({
      operationId: mutation.operationId,
      expectedRevision: mutation.expectedRevision,
      updatedAt: occurredAt,
      changes: mutation.changes,
    });
  }
  if (mutation.kind === "withdraw-marketing-consent") {
    return repository.withdrawMarketingConsent({
      operationId: mutation.operationId,
      expectedRevision: mutation.expectedRevision,
      withdrawnAt: occurredAt,
    });
  }
  return repository.requestAccountDeletion({
    operationId: mutation.operationId,
    expectedRevision: mutation.expectedRevision,
    requestedAt: occurredAt,
  });
}

type AppliedProfileMutation = Readonly<{
  result: ParticipantProfileMutationResult;
  occurredAt: Timestamp;
  base: ParticipantProfileSnapshot;
}>;

async function applyMutationWithReplayRecovery(
  repository: ParticipantRepository,
  account: ParticipantAccount,
  mutation: ProfileMutation,
  current: ParticipantProfileSnapshot,
  now: () => Date,
): Promise<AppliedProfileMutation> {
  const replayContext = await profileMutationReplayContext(
    repository,
    account,
    mutation,
    current,
    now,
  );
  try {
    return Object.freeze({
      result: await applyMutation(
        repository,
        mutation,
        replayContext.occurredAt,
      ),
      ...replayContext,
    });
  } catch (error) {
    if (
      !(error instanceof StorageFailure) ||
      (error.code !== "CONFLICT" && error.code !== "PRECONDITION_FAILED")
    ) {
      throw error;
    }

    const replay = requireOwnedCurrentProfile(
      await repository.current(),
      account,
    );
    if (replay.revision <= mutation.expectedRevision) throw error;
    const recovered = await profileMutationReplayContext(
      repository,
      account,
      mutation,
      replay,
      now,
    );
    return Object.freeze({
      result: await applyMutation(
        repository,
        mutation,
        recovered.occurredAt,
      ),
      ...recovered,
    });
  }
}

function requireMutationResult(
  result: ParticipantProfileMutationResult,
  current: ParticipantProfileSnapshot,
  base: ParticipantProfileSnapshot,
  mutation: ProfileMutation,
  occurredAt: Timestamp,
  account: ParticipantAccount,
): void {
  if (
    typeof result.replayed !== "boolean" ||
    !Number.isSafeInteger(result.revision) ||
    result.revision !== mutation.expectedRevision + 1 ||
    base.revision !== mutation.expectedRevision ||
    !Array.isArray(result.intents) ||
    result.snapshot.updatedAt !== occurredAt ||
    !result.replayed && current.revision !== mutation.expectedRevision
  ) {
    unavailable();
  }
  requireOwnedProfile(result.snapshot, account);
  const expected = expectedProfileTransition(
    base.snapshot,
    mutation,
    occurredAt,
  );
  if (
    !sameParticipantProfile(result.snapshot, expected.profile) ||
    !sameParticipantIntents(result.intents, expected.intents)
  ) unavailable();
}

function requireLatestProfileAfterMutation(
  value: ParticipantProfileSnapshot | null,
  account: ParticipantAccount,
  current: ParticipantProfileSnapshot,
  result: ParticipantProfileMutationResult,
): ParticipantProfileSnapshot {
  const latest = requireOwnedCurrentProfile(value, account);
  if (
    !isParticipantProfileSnapshotDescendant(current, latest) ||
    !isParticipantProfileSnapshotDescendant(result, latest)
  ) {
    unavailable();
  }
  return latest;
}

function isParticipantProfileSnapshotDescendant(
  ancestor: Readonly<{ revision: number; snapshot: ParticipantProfile }>,
  descendant: ParticipantProfileSnapshot,
): boolean {
  if (descendant.revision < ancestor.revision) return false;
  if (descendant.revision === ancestor.revision) {
    return sameParticipantProfile(descendant.snapshot, ancestor.snapshot);
  }
  if (
    ancestor.snapshot.accountDeletionRequest.state === "requested" &&
    descendant.revision !== ancestor.revision + 1
  ) {
    return false;
  }
  return isParticipantProfileDescendantProjection(
    ancestor.snapshot,
    descendant.snapshot,
    descendant.revision - ancestor.revision,
  );
}

function expectedProfileTransition(
  current: ParticipantProfile,
  mutation: ProfileMutation,
  occurredAt: Timestamp,
): Readonly<{
  profile: ParticipantProfile;
  intents: ParticipantProfileMutationResult["intents"];
}> {
  if (mutation.kind === "update") {
    const updated = updateParticipantProfile(
      current,
      mutation.changes,
      occurredAt,
    );
    if (!updated.ok) unavailable();
    return Object.freeze({
      profile: updated.value,
      intents: Object.freeze([]),
    });
  }
  if (mutation.kind === "withdraw-marketing-consent") {
    return Object.freeze({
      profile: withdrawMarketingConsent(current, occurredAt),
      intents: Object.freeze([]),
    });
  }
  const transition = requestParticipantAccountDeletion(current, occurredAt);
  return Object.freeze({
    profile: transition.profile,
    intents: transition.intents,
  });
}

function sameParticipantProfile(
  left: ParticipantProfile,
  right: ParticipantProfile,
): boolean {
  return left.subject === right.subject &&
    left.accountEmailLabel === right.accountEmailLabel &&
    left.displayName === right.displayName &&
    left.country === right.country &&
    left.declaredInterest === right.declaredInterest &&
    left.participationContext === right.participationContext &&
    left.processEmailNoticeAcknowledgedAt ===
      right.processEmailNoticeAcknowledgedAt &&
    sameMarketingConsent(left.marketingConsent, right.marketingConsent) &&
    sameDeletionRequest(
      left.accountDeletionRequest,
      right.accountDeletionRequest,
    ) &&
    left.registeredAt === right.registeredAt &&
    left.updatedAt === right.updatedAt;
}

function sameMarketingConsent(
  left: ParticipantProfile["marketingConsent"],
  right: ParticipantProfile["marketingConsent"],
): boolean {
  if (left.state !== right.state) return false;
  if (left.state === "not-granted" || right.state === "not-granted") {
    return true;
  }
  if (left.state === "granted" || right.state === "granted") {
    return left.state === "granted" &&
      right.state === "granted" &&
      left.grantedAt === right.grantedAt;
  }
  return left.grantedAt === right.grantedAt &&
    left.withdrawnAt === right.withdrawnAt;
}

function sameDeletionRequest(
  left: ParticipantProfile["accountDeletionRequest"],
  right: ParticipantProfile["accountDeletionRequest"],
): boolean {
  if (left.state !== right.state) return false;
  return left.state === "not-requested" ||
    (right.state === "requested" &&
      left.requestedAt === right.requestedAt &&
      left.activeInterestDisposition === right.activeInterestDisposition);
}

function sameParticipantIntents(
  left: ParticipantProfileMutationResult["intents"],
  right: ParticipantProfileMutationResult["intents"],
): boolean {
  return left.length === right.length && left.every((intent, index) => {
    const expected = right[index];
    return expected !== undefined &&
      intent.type === expected.type &&
      intent.subject === expected.subject &&
      intent.reason === expected.reason &&
      intent.requestedAt === expected.requestedAt;
  });
}

type ResourceResponseInput = Readonly<{
  context: Parameters<ApplicationRouteHandler>[0];
  representation: "html" | "hypermedia-json";
  account: ParticipantAccount;
  current: ParticipantProfileSnapshot;
  acknowledgment: ParticipantProfileAcknowledgmentState;
  csrfTokenFor: ParticipantProfileCsrfTokenProvider;
  createOperationId: (operation: ParticipantProfileOperation) => string;
}>;

async function resourceResponse(input: ResourceResponseInput): Promise<Response> {
  const operationIds = profileOperationIds(
    input.current.snapshot,
    input.createOperationId,
  );
  const model = createParticipantProfileCapabilityModel({
    requestUrl: input.context.resourceUrl,
    account: input.account,
    revision: input.current.revision,
    profile: input.current.snapshot,
    acknowledgment: input.acknowledgment,
    operationIds,
  });
  const csrf = model.actionContracts.length === 0
    ? null
    : await requiredCsrfProof(
        await input.csrfTokenFor(input.context.request, input.account),
      );

  if (input.representation === "hypermedia-json") {
    return withSetCookie(
      hypermediaResponseWithCsrf(model.document, csrf?.token ?? null),
      csrf?.setCookie ?? null,
    );
  }
  return withSetCookie(htmlResponse(
    renderParticipantProfileHtml(
      model,
      csrf?.token ?? null,
      input.context.campaign?.name ?? "Campaign",
    ),
  ), csrf?.setCookie ?? null);
}

function profileOperationIds(
  profile: ParticipantProfile,
  createOperationId: (operation: ParticipantProfileOperation) => string,
): ParticipantProfileOperationIds {
  const available = new Set(participantProfileOperations(profile));
  const issue = (operation: ParticipantProfileOperation): string | null => {
    if (!available.has(operation)) return null;
    let value: unknown;
    try {
      value = createOperationId(operation);
    } catch (error) {
      throw new StorageFailure("UNAVAILABLE", { cause: error });
    }
    const parsed = parseStorageOperationId(value);
    if (!parsed.ok) unavailable();
    return parsed.value;
  };
  return Object.freeze({
    update: issue("update"),
    withdrawMarketingConsent: issue("withdraw-marketing-consent"),
    requestAccountDeletion: issue("request-account-deletion"),
  });
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
  document: unknown,
  csrfToken: string | null,
  status = 200,
): Response {
  const response = hypermediaResponse(document, status);
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  if (csrfToken !== null) headers.set(MUTATION_CSRF_HEADER, csrfToken);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type AuthorizedProfileRequest = Readonly<{
  account: ParticipantAccount;
  access: AuthorizedParticipantAccess;
}>;

function requiredAuthorizedParticipant(
  context: Parameters<ApplicationRouteHandler>[0],
): AuthorizedProfileRequest {
  if (
    context.actor === null ||
    context.isOwner ||
    context.participantAccess === null
  ) {
    notFound();
  }
  const account = parseParticipantAccount({
    subject: context.actor.userId,
    accountEmailLabel: context.actor.email,
  });
  const access = parseAuthorizedParticipantAccess(context.participantAccess);
  if (
    !account.ok ||
    access === null ||
    access.subject !== account.value.subject ||
    access.email !== account.value.accountEmailLabel
  ) {
    notFound();
  }
  return Object.freeze({ account: account.value, access });
}

function requiredRepository(
  factory: ParticipantProfileRepositoryFactory,
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
    typeof repository.revision !== "function" ||
    typeof repository.update !== "function" ||
    typeof repository.withdrawMarketingConsent !== "function" ||
    typeof repository.requestAccountDeletion !== "function"
  ) {
    unavailable();
  }
  return repository;
}

function requireCurrentProfile(
  value: ParticipantProfileSnapshot | null,
  authorized: AuthorizedProfileRequest,
): ParticipantProfileSnapshot {
  const current = requireOwnedCurrentProfile(value, authorized.account);
  const deletionRequested =
    current.snapshot.accountDeletionRequest.state === "requested";
  if (
    current.snapshot.displayName !== authorized.access.displayName ||
    current.snapshot.declaredInterest !== authorized.access.declaredInterest ||
    current.snapshot.participationContext !==
      authorized.access.participationContext ||
    authorized.access.accountStatus !==
      (deletionRequested ? "deletion-requested" : "active")
  ) {
    unavailable();
  }
  return current;
}

function requireOwnedCurrentProfile(
  value: ParticipantProfileSnapshot | null,
  account: ParticipantAccount,
): ParticipantProfileSnapshot {
  if (value === null) notFound();
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) unavailable();
  requireOwnedProfile(value.snapshot, account);
  validateParticipantProfileResourceState(account, value.snapshot);
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

function acknowledgmentState(
  access: AuthorizedParticipantAccess,
): ParticipantProfileAcknowledgmentState {
  return access.currentPackage === null
    ? null
    : Object.freeze({
        packageVersionId: access.currentPackage.id,
        requiresCurrentAcceptance:
          access.currentPackage.requiresCurrentAcceptance,
      });
}

async function profileMutationReplayContext(
  repository: ParticipantRepository,
  account: ParticipantAccount,
  mutation: ProfileMutation,
  current: ParticipantProfileSnapshot,
  now: () => Date,
): Promise<Readonly<{
  base: ParticipantProfileSnapshot;
  occurredAt: Timestamp;
}>> {
  const expectedRevision = mutation.expectedRevision;
  const base = current.revision === expectedRevision
    ? current
    : requireOwnedProfileRevision(
        await repository.revision(expectedRevision),
        account,
        expectedRevision,
      );
  requireMutationAvailableFromBase(base, mutation);
  const committed = current.revision <= expectedRevision
    ? null
    : current.revision === expectedRevision + 1
    ? current
    : requireOwnedProfileRevision(
        await repository.revision(expectedRevision + 1),
        account,
        expectedRevision + 1,
      );
  return Object.freeze({
    base,
    occurredAt: committed === null
      ? currentTimestamp(now)
      : profileUpdatedAt(committed),
  });
}

function requireOwnedProfileRevision(
  value: ParticipantProfileSnapshot | null,
  account: ParticipantAccount,
  revision: number,
): ParticipantProfileSnapshot {
  const snapshot = requireOwnedCurrentProfile(value, account);
  if (snapshot.revision !== revision) unavailable();
  return snapshot;
}

function profileUpdatedAt(profile: ParticipantProfileSnapshot): Timestamp {
  const parsed = parseTimestamp(profile.snapshot.updatedAt);
  if (!parsed.ok) unavailable();
  return parsed.value;
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
      chatGPTSignInPath(PARTICIPANT_PROFILE_PATH),
      requestUrl,
    ).href,
    requestMediaType: "text/html",
    fields: [],
  }));
  return routeError(
    requestUrl,
    401,
    "authentication_required",
    "Sign in to view your participant profile.",
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
    "The participant profile is temporarily unavailable.",
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
        message: "Check the profile request and try again.",
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
        message: "This request conflicts with the current profile state.",
      };
    case "PRECONDITION_FAILED":
      return {
        status: 412,
        code: "precondition_failed",
        message: "Your profile changed. Reload and try again.",
      };
    case "UNAVAILABLE":
      return {
        status: 503,
        code: "service_unavailable",
        message: "The participant profile is temporarily unavailable.",
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
      type: "error" as const,
      id: code,
      data: Object.freeze({ code, message }),
      links: Object.freeze([
        Object.freeze({
          rel: Object.freeze(["self"]),
          href: new URL(PARTICIPANT_PROFILE_PATH, requestUrl).href,
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

function methodNotAllowedResponse(
  requestUrl: string,
  representation: "html" | "hypermedia-json",
): Response {
  const response = errorResponse(
    routeError(
      requestUrl,
      405,
      "method_not_allowed",
      "This request method is not available for the participant profile.",
    ),
    representation,
  );
  const headers = new Headers(response.headers);
  headers.set("Allow", "GET, POST, PATCH, DELETE");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function errorResponse(
  error: RouteError,
  representation: "html" | "hypermedia-json",
): Response {
  return representation === "hypermedia-json"
    ? hypermediaResponseWithCsrf(error.document, null, error.status)
    : htmlResponse(renderErrorHtml(error.document), error.status);
}

function renderParticipantProfileHtml(
  model: ParticipantProfileCapabilityModel,
  csrfToken: string | null,
  campaignName: string,
): string {
  const data = model.document.data;
  const update = model.forms.find(
    (form) => form.name === "update-participant-profile",
  );
  const marketing = model.forms.find(
    (form) => form.name === "withdraw-marketing-consent",
  );
  const deletion = model.forms.find(
    (form) => form.name === "request-account-deletion",
  );
  if (model.forms.length > 0 && csrfToken === null) {
    throw new MutationSecurityFailure("SERVICE_UNAVAILABLE");
  }

  const editSection = update === undefined
    ? `<section class="profile-band" aria-labelledby="profile-details-title">
        <div class="profile-band-heading"><p>Profile details</p><h2 id="profile-details-title">Profile changes are closed</h2><p>Your deletion request is pending, so profile details can no longer be changed here.</p></div>
        ${profileSummary(data)}
      </section>`
    : `<section class="profile-band" aria-labelledby="profile-details-title">
        <div class="profile-band-heading"><p>Profile details</p><h2 id="profile-details-title">How you may participate</h2><p>Keep these self-declared details current while you consider the campaign.</p></div>
        ${renderUpdateForm(update, csrfToken ?? "")}
      </section>`;

  const marketingSection = `<section class="profile-band" aria-labelledby="profile-marketing-title">
    <div class="profile-band-heading"><p>Optional messages</p><h2 id="profile-marketing-title">Marketing consent</h2><p>Required process messages remain separate from optional marketing messages.</p></div>
    <div class="profile-state">
      <p class="profile-state-value">${marketingConsentLabel(data.marketing_consent_state)}</p>
      ${data.marketing_consent_granted_at === null ? "" : timestampLine("Granted", data.marketing_consent_granted_at)}
      ${data.marketing_consent_withdrawn_at === null ? "" : timestampLine("Withdrawn", data.marketing_consent_withdrawn_at)}
      ${marketing === undefined ? "" : renderConfirmationForm(marketing, csrfToken ?? "", "profile-button profile-button--secondary")}
    </div>
  </section>`;

  const deletionSection = `<section class="profile-band profile-band--deletion" aria-labelledby="profile-deletion-title">
    <div class="profile-band-heading"><p>Account request</p><h2 id="profile-deletion-title">Account deletion</h2><p>A deletion request is handled under the campaign retention policy. It does not erase retained records immediately.</p></div>
    <div class="profile-state">
      <p class="profile-state-value">${deletionStateLabel(data.account_deletion_state)}</p>
      ${data.account_deletion_requested_at === null ? "" : timestampLine("Requested", data.account_deletion_requested_at)}
      ${deletion === undefined ? "" : renderConfirmationForm(deletion, csrfToken ?? "", "profile-button profile-button--danger")}
    </div>
  </section>`;

  return pageShell(
    `${campaignName} participant profile`,
    campaignName,
    `<main class="profile-main">
      <header class="profile-title">
        <p>Your participation</p>
        <h1>Your profile</h1>
        <p>Review your account details, current package acknowledgment, and participation preferences.</p>
      </header>
      <section class="profile-overview" aria-label="Account and acknowledgment status">
        <div><p>Signed-in account</p><strong>${escapeHtml(data.account_email)}</strong><span>Managed by your identity provider</span></div>
        <div><p>Current acknowledgment</p><strong>${acknowledgmentLabel(data.current_acknowledgment_status)}</strong><span>${acknowledgmentDetail(data.current_acknowledgment_status)}</span></div>
      </section>
      <section class="profile-band" aria-labelledby="profile-record-title">
        <div class="profile-band-heading"><p>Registration record</p><h2 id="profile-record-title">Account status</h2><p>Your identity, required process acknowledgment, and registration record are read-only.</p></div>
        <dl class="profile-summary">
          ${detail("Process notice", "Acknowledged")}
          ${timeDetail("Acknowledged", data.process_email_notice_acknowledged_at)}
          ${timeDetail("Registered", data.registered_at)}
          ${timeDetail("Last updated", data.updated_at)}
          ${detail("Profile revision", String(data.revision))}
        </dl>
      </section>
      ${editSection}
      ${marketingSection}
      ${deletionSection}
    </main>`,
  );
}

function renderUpdateForm(form: HtmlFormAction, csrfToken: string): string {
  const hidden = renderHiddenFields(form, csrfToken);
  const fields = form.fields
    .filter((field) => field.presentation !== "hidden")
    .map(renderEditableField)
    .join("");
  return `<form class="profile-form" action="${escapeAttribute(form.action)}" data-action-name="${escapeAttribute(form.name)}" enctype="${form.encoding ?? "application/x-www-form-urlencoded"}" method="${form.method}">
    ${hidden}${fields}
    <button class="profile-button" type="submit">${escapeHtml(form.title)}</button>
  </form>`;
}

function renderConfirmationForm(
  form: HtmlFormAction,
  csrfToken: string,
  buttonClass: string,
): string {
  const confirmation = form.fields.find(
    (field) => field.presentation !== "hidden",
  );
  if (confirmation === undefined || confirmation.inputType !== "checkbox") {
    throw new StorageFailure("UNAVAILABLE");
  }
  const id = `profile-field-${confirmation.name}`;
  return `<form class="profile-confirmation" action="${escapeAttribute(form.action)}" data-action-name="${escapeAttribute(form.name)}" enctype="${form.encoding ?? "application/x-www-form-urlencoded"}" method="${form.method}">
    ${renderHiddenFields(form, csrfToken)}
    <label for="${escapeAttribute(id)}"><input id="${escapeAttribute(id)}" name="${escapeAttribute(confirmation.name)}" type="checkbox" value="true" required><span>${escapeHtml(confirmation.label)}</span></label>
    <button class="${escapeAttribute(buttonClass)}" type="submit">${escapeHtml(form.title)}</button>
  </form>`;
}

function renderHiddenFields(form: HtmlFormAction, csrfToken: string): string {
  return [
    ...form.hiddenFields.map((field) => hiddenInput(field.name, field.value)),
    ...form.fields
      .filter((field) => field.presentation === "hidden")
      .map((field) =>
        hiddenInput(field.name, field.value ?? field.defaultValue ?? "")
      ),
    hiddenInput("_csrf", csrfToken),
  ].join("");
}

function renderEditableField(field: HtmlFormField): string {
  const id = `profile-field-${field.name}`;
  if (field.control === "select") {
    const selected = String(field.value ?? field.defaultValue ?? "");
    const options = (field.choices ?? []).map((choice) =>
      `<option value="${escapeAttribute(choice.value)}"${selected === choice.value ? " selected" : ""}>${escapeHtml(choice.label)}</option>`
    ).join("");
    return `<label class="profile-field" for="${escapeAttribute(id)}"><span>${escapeHtml(field.label)}</span><select id="${escapeAttribute(id)}" name="${escapeAttribute(field.name)}"${field.required ? " required" : ""}>${options}</select></label>`;
  }
  return `<label class="profile-field" for="${escapeAttribute(id)}"><span>${escapeHtml(field.label)}</span><input id="${escapeAttribute(id)}" name="${escapeAttribute(field.name)}" type="${escapeAttribute(field.inputType ?? "text")}" value="${escapeAttribute(String(field.value ?? field.defaultValue ?? ""))}"${field.required ? " required" : ""}${numericAttribute("minlength", field.minLength)}${numericAttribute("maxlength", field.maxLength)}></label>`;
}

function profileSummary(
  data: ParticipantProfileCapabilityModel["document"]["data"],
): string {
  return `<dl class="profile-summary">
    ${detail("Display name", data.display_name)}
    ${detail("Country", data.country)}
    ${detail("Interest", interestLabel(data.declared_interest))}
    ${detail("Context", contextLabel(data.participation_context))}
  </dl>`;
}

function renderErrorHtml(document: RouteErrorDocument): string {
  const actions = document.actions.map((action) =>
    `<a class="profile-button" href="${escapeAttribute(action.href)}">${escapeHtml(action.title)}</a>`
  ).join("");
  return pageShell(
    "Participant profile",
    "Campaign",
    `<main class="profile-main profile-error"><p>Your participation</p><h1>Profile unavailable</h1><p>${escapeHtml(document.data.message)}</p><div>${actions}<a href="/">Return to campaign</a></div></main>`,
  );
}

function pageShell(title: string, campaignName: string, main: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/participant-profile.css">
</head>
<body class="profile-page">
  <header class="profile-header"><a href="/">${escapeHtml(campaignName)}</a><a href="/participant">Your participation</a></header>
  ${main}
</body>
</html>`;
}

function detail(label: string, value: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function timeDetail(label: string, value: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd><time datetime="${escapeAttribute(value)}">${escapeHtml(value)}</time></dd></div>`;
}

function timestampLine(label: string, value: string): string {
  return `<p class="profile-state-time">${escapeHtml(label)} <time datetime="${escapeAttribute(value)}">${escapeHtml(value)}</time></p>`;
}

function acknowledgmentLabel(
  value: ParticipantProfileCapabilityModel["document"]["data"]["current_acknowledgment_status"],
): string {
  if (value === "required") return "Required";
  if (value === "current") return "Current";
  return "Package unavailable";
}

function acknowledgmentDetail(
  value: ParticipantProfileCapabilityModel["document"]["data"]["current_acknowledgment_status"],
): string {
  if (value === "required") return "Review the current package acknowledgment";
  if (value === "current") return "Current package requirement satisfied";
  return "No current package requirement is available";
}

function marketingConsentLabel(
  value: ParticipantProfile["marketingConsent"]["state"],
): string {
  if (value === "granted") return "Granted";
  if (value === "withdrawn") return "Withdrawn";
  return "Not granted";
}

function deletionStateLabel(
  value: ParticipantProfile["accountDeletionRequest"]["state"],
): string {
  return value === "requested" ? "Deletion requested" : "Not requested";
}

function interestLabel(value: ParticipantProfile["declaredInterest"]): string {
  if (value === "founder") return "Founder";
  if (value === "investor") return "Investor";
  return "Founder and investor";
}

function contextLabel(
  value: ParticipantProfile["participationContext"],
): string {
  return value === "individual" ? "Individual" : "Company";
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

function randomOperationId(operation: ParticipantProfileOperation): string {
  return `participant-profile:${operation}:${crypto.randomUUID()}`;
}

function invalidRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
}

function notFound(): never {
  throw new StorageFailure("NOT_FOUND");
}

function conflict(): never {
  throw new StorageFailure("CONFLICT");
}

function unavailable(): never {
  throw new StorageFailure("UNAVAILABLE");
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      Vary: "Accept",
      "X-Content-Type-Options": "nosniff",
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

function withNoSniff(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
