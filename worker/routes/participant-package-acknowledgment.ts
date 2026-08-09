import { chatGPTSignInPath } from "../../domain/auth-navigation.ts";
import {
  parseActorSubject,
  parseStableId,
  parseTimestamp,
  type ActorSubject,
  type Timestamp,
} from "../../domain/foundation.ts";
import {
  defineAction,
  toHypermediaAction,
  type HtmlFormAction,
  type HypermediaAction,
} from "../../domain/hypermedia-action.ts";
import type {
  PackageAcceptanceRecord,
  PackageVersion,
} from "../../domain/package-content.ts";
import {
  PARTICIPANT_PACKAGE_ACKNOWLEDGMENT_PATH,
  createParticipantPackageAcknowledgmentCapabilityModel,
  defineParticipantPackageAcknowledgmentState,
  type ParticipantPackageAcknowledgmentCapabilityModel,
  type ParticipantPackageAcknowledgmentState,
} from "../../domain/participant-package-acknowledgment-resource.ts";
import {
  INVESTOR_APP_API_VERSION,
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
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  MutationSecurityFailure,
  createBrowserMutationGuard,
  hashCsrfToken,
  toPublicMutationSecurityFailure,
  type BrowserMutationGuardOptions,
  type VerifiedMutationRequest,
} from "../../http/mutation-security.ts";
import type {
  AcknowledgmentRepository,
  PackageVersionRepository,
  RepositoryMutationResult,
  RevisionedSnapshot,
} from "../../repositories/in-memory-content-repository.ts";
import type {
  ApplicationRouteContext,
  ApplicationRouteHandler,
} from "../contracts.ts";
import {
  hypermediaResponse,
  notAcceptableResponse,
} from "./responses.ts";

const OPERATION_ID_FIELD = "operation-id";
const MAX_ACKNOWLEDGMENT_MUTATION_BYTES = 512;
const MAX_ACKNOWLEDGMENT_MUTATION_FIELDS = 2;

export type ParticipantPackageAcknowledgmentRepositories = Readonly<{
  packages: Pick<PackageVersionRepository, "current">;
  acknowledgments: Pick<
    AcknowledgmentRepository,
    "get" | "latest" | "record"
  >;
}>;

export type ParticipantPackageAcknowledgmentRepositoryFactory = (
  participantSubject: ActorSubject,
) => ParticipantPackageAcknowledgmentRepositories;

export type ParticipantPackageAcknowledgmentCsrfTokenProvider = (
  request: Request,
  participantSubject: ActorSubject,
) => string | null | Promise<string | null>;

export type ParticipantPackageAcknowledgmentRouteDependencies = Readonly<{
  repositoryFor: ParticipantPackageAcknowledgmentRepositoryFactory;
  mutationSecurity: BrowserMutationGuardOptions;
  csrfTokenFor: ParticipantPackageAcknowledgmentCsrfTokenProvider;
  now?: () => Date;
  createOperationId?: () => string;
}>;

/** Create the current-package acknowledgment resource without global persistence. */
export function createParticipantPackageAcknowledgmentRouteHandler(
  dependencies: ParticipantPackageAcknowledgmentRouteDependencies,
): ApplicationRouteHandler {
  if (
    typeof dependencies.repositoryFor !== "function" ||
    typeof dependencies.csrfTokenFor !== "function"
  ) {
    throw new Error("Invalid package-acknowledgment route configuration.");
  }
  const now = dependencies.now ?? (() => new Date());
  const createOperationId = dependencies.createOperationId ?? randomOperationId;
  if (typeof now !== "function" || typeof createOperationId !== "function") {
    throw new Error("Invalid package-acknowledgment route configuration.");
  }
  const mutationGuard = createBrowserMutationGuard({
    ...dependencies.mutationSecurity,
    maxBodyBytes: MAX_ACKNOWLEDGMENT_MUTATION_BYTES,
    maxFields: MAX_ACKNOWLEDGMENT_MUTATION_FIELDS,
    repeatedFormFields: [],
  });

  return async (context) => {
    if (context.url.pathname !== PARTICIPANT_PACKAGE_ACKNOWLEDGMENT_PATH) {
      return null;
    }

    const representation = negotiateRepresentation(
      context.request.headers.get("accept"),
    );
    if (representation.kind === "not-acceptable") {
      return withPrivateHeaders(notAcceptableResponse(context.resourceUrl));
    }
    if (context.url.search !== "") {
      return errorResponse(
        routeError(
          context.resourceUrl,
          400,
          "invalid_request",
          "Check the acknowledgment request and try again.",
        ),
        representation.kind,
      );
    }

    if (context.request.method === "GET") {
      if (context.actor === null) {
        return errorResponse(
          authenticationRequiredError(context.resourceUrl),
          representation.kind,
        );
      }

      try {
        const subject = requiredParticipantSubject(context);
        const repositories = requiredRepositories(
          dependencies.repositoryFor,
          subject,
        );
        const state = await readCurrentState(context, repositories, subject);
        return await resourceResponse({
          context,
          representation: representation.kind,
          state,
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
      return methodNotAllowedResponse(context.resourceUrl, representation.kind);
    }

    try {
      const verified = await mutationGuard(context.request);
      assertExactResourceOrigin(context.request, context.resourceUrl);
      const subject = requiredParticipantSubject(context);
      if (
        verified.actor.type !== "participant" ||
        verified.actor.subject !== subject
      ) {
        notFound();
      }
      const mutation = parseAcknowledgmentMutation(verified);
      const repositories = requiredRepositories(
        dependencies.repositoryFor,
        subject,
      );
      const current = await readCurrentState(context, repositories, subject);
      const acceptanceId = acceptanceIdFor(mutation.operationId);
      const existing = await repositories.acknowledgments.get(acceptanceId);

      if (existing !== null) {
        requireOwnAcceptance(existing, acceptanceId, subject, current.currentVersion);
        return await resourceResponse({
          context,
          representation: representation.kind,
          state: current,
          csrfTokenFor: dependencies.csrfTokenFor,
          createOperationId,
          status: 200,
        });
      }
      if (!current.acceptanceRequired) {
        throw new StorageFailure("CONFLICT");
      }

      const acceptedAt = currentTimestamp(now);
      if (acceptedAt < current.currentVersion.createdAt) unavailable();
      let result: RepositoryMutationResult<PackageAcceptanceRecord>;
      try {
        result = await repositories.acknowledgments.record({
          operationId: mutation.operationId,
          expectedRevision: current.latestAcceptance === null
            ? null
            : requiredLatestRevision(current),
          id: acceptanceId,
          acceptedAt,
          acceptedVersionId: current.currentVersion.id,
        });
      } catch (error) {
        if (error instanceof StorageFailure && error.code === "CONFLICT") {
          const replay = await repositories.acknowledgments.get(acceptanceId);
          if (replay !== null) {
            requireOwnAcceptance(
              replay,
              acceptanceId,
              subject,
              current.currentVersion,
            );
            const replayState = requiredAcknowledgmentState(
              subject,
              current.currentVersion,
              replay,
            );
            if (replayState.acceptanceRequired) unavailable();
            return await resourceResponse({
              context,
              representation: representation.kind,
              state: replayState,
              csrfTokenFor: dependencies.csrfTokenFor,
              createOperationId,
              status: 200,
            });
          }
        }
        throw error;
      }

      requireMutationResult(
        result,
        acceptanceId,
        subject,
        acceptedAt,
        current.currentVersion,
      );
      const acceptedState = requiredAcknowledgmentState(
        subject,
        current.currentVersion,
        result.snapshot,
      );
      if (acceptedState.acceptanceRequired) unavailable();
      return await resourceResponse({
        context,
        representation: representation.kind,
        state: acceptedState,
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

type CurrentState = ParticipantPackageAcknowledgmentState & Readonly<{
  latestAcceptanceRevision: number | null;
}>;

async function readCurrentState(
  context: ApplicationRouteContext,
  repositories: ParticipantPackageAcknowledgmentRepositories,
  subject: ActorSubject,
): Promise<CurrentState> {
  const first = await repositories.packages.current();
  if (first === null) notFound();
  requireRevision(first);
  const latest = await repositories.acknowledgments.latest();
  if (latest !== null) requireRevision(latest);
  const second = await repositories.packages.current();
  if (second === null) throw new StorageFailure("PRECONDITION_FAILED");
  requireRevision(second);
  if (!sameCurrentPackage(first, second)) {
    throw new StorageFailure("PRECONDITION_FAILED");
  }

  const state = requiredAcknowledgmentState(
    subject,
    second.snapshot,
    latest?.snapshot ?? null,
  );
  assertCurrentProjection(context, state);
  return Object.freeze({
    ...state,
    latestAcceptanceRevision: latest?.revision ?? null,
  });
}

function requiredLatestRevision(state: CurrentState): number {
  const revision = state.latestAcceptanceRevision;
  if (revision === null) unavailable();
  return revision;
}

function sameCurrentPackage(
  left: RevisionedSnapshot<PackageVersion>,
  right: RevisionedSnapshot<PackageVersion>,
): boolean {
  return left.revision === right.revision &&
    left.snapshot.id === right.snapshot.id &&
    left.snapshot.createdAt === right.snapshot.createdAt &&
    left.snapshot.changeSummary === right.snapshot.changeSummary &&
    left.snapshot.materialChange === right.snapshot.materialChange &&
    left.snapshot.acknowledgmentText === right.snapshot.acknowledgmentText &&
    left.snapshot.contentHash === right.snapshot.contentHash &&
    left.snapshot.requiredAcceptanceHash ===
      right.snapshot.requiredAcceptanceHash;
}

function assertCurrentProjection(
  context: ApplicationRouteContext,
  state: ParticipantPackageAcknowledgmentState,
): void {
  const projection = context.participantAccess?.currentPackage;
  const version = state.currentVersion;
  if (
    projection === null ||
    projection === undefined ||
    projection.id !== version.id ||
    projection.createdAt !== version.createdAt ||
    projection.changeSummary !== version.changeSummary ||
    projection.materialChange !== version.materialChange ||
    projection.requiresCurrentAcceptance !== state.acceptanceRequired
  ) {
    throw new StorageFailure("PRECONDITION_FAILED");
  }
}

function parseAcknowledgmentMutation(
  request: VerifiedMutationRequest,
): Readonly<{ operationId: StorageOperationId }> {
  if (request.method !== "POST") invalidRequest();
  const fields = Object.keys(request.body);
  if (
    fields.length !== 1 ||
    fields[0] !== OPERATION_ID_FIELD ||
    !Object.hasOwn(request.body, OPERATION_ID_FIELD)
  ) {
    invalidRequest();
  }
  const operationId = parseStorageOperationId(request.body[OPERATION_ID_FIELD]);
  if (!operationId.ok) invalidRequest();
  return Object.freeze({ operationId: operationId.value });
}

function acceptanceIdFor(
  operationId: StorageOperationId,
): ReturnType<typeof requiredAcceptanceId> {
  return requiredAcceptanceId(operationId);
}

function requiredAcceptanceId(value: unknown) {
  const parsed = parseStableId<"package-acceptance">(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function requireOwnAcceptance(
  acceptance: PackageAcceptanceRecord,
  expectedId: ReturnType<typeof requiredAcceptanceId>,
  subject: ActorSubject,
  currentVersion: PackageVersion,
): void {
  const id = parseStableId<"package-acceptance">(acceptance?.id);
  const participantSubject = parseActorSubject(acceptance?.participantSubject);
  if (participantSubject.ok && participantSubject.value !== subject) notFound();
  if (!id.ok || id.value !== expectedId || !participantSubject.ok) unavailable();
  requiredAcknowledgmentState(subject, currentVersion, acceptance);
}

function requiredAcknowledgmentState(
  subject: ActorSubject,
  currentVersion: PackageVersion,
  latestAcceptance: PackageAcceptanceRecord | null,
): ParticipantPackageAcknowledgmentState {
  if (latestAcceptance !== null) {
    const evidenceSubject = parseActorSubject(
      latestAcceptance.participantSubject,
    );
    if (evidenceSubject.ok && evidenceSubject.value !== subject) notFound();
  }
  try {
    return defineParticipantPackageAcknowledgmentState(
      subject,
      currentVersion,
      latestAcceptance,
    );
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
}

function requireMutationResult(
  result: RepositoryMutationResult<PackageAcceptanceRecord>,
  expectedId: ReturnType<typeof requiredAcceptanceId>,
  subject: ActorSubject,
  acceptedAt: Timestamp,
  version: PackageVersion,
): void {
  if (
    typeof result !== "object" ||
    result === null ||
    !Number.isSafeInteger(result.revision) ||
    result.revision < 1 ||
    typeof result.replayed !== "boolean"
  ) {
    unavailable();
  }
  requireOwnAcceptance(result.snapshot, expectedId, subject, version);
  if (
    result.snapshot.acceptedAt !== acceptedAt ||
    result.snapshot.acceptedVersionId !== version.id ||
    result.snapshot.acceptedContentHash !== version.contentHash ||
    result.snapshot.satisfiedRequirementHash !== version.requiredAcceptanceHash
  ) {
    unavailable();
  }
}

type ResourceResponseInput = Readonly<{
  context: ApplicationRouteContext;
  representation: "html" | "hypermedia-json";
  state: ParticipantPackageAcknowledgmentState;
  csrfTokenFor: ParticipantPackageAcknowledgmentCsrfTokenProvider;
  createOperationId: () => string;
  status: number;
}>;

async function resourceResponse(input: ResourceResponseInput): Promise<Response> {
  const operationId = input.state.acceptanceRequired
    ? input.createOperationId()
    : null;
  const model = createParticipantPackageAcknowledgmentCapabilityModel({
    requestUrl: input.context.resourceUrl,
    state: input.state,
    operationId,
  });
  const hasMutation = model.actionContracts.some(
    (action) => action.method !== "GET",
  );
  const csrfToken = hasMutation
    ? await requiredCsrfToken(
        await input.csrfTokenFor(
          input.context.request,
          input.state.participantSubject,
        ),
      )
    : null;

  if (input.representation === "hypermedia-json") {
    return hypermediaResponseWithCsrf(model.document, input.status, csrfToken);
  }
  return htmlResponse(
    renderAcknowledgmentHtml(
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
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
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
      chatGPTSignInPath(PARTICIPANT_PACKAGE_ACKNOWLEDGMENT_PATH),
      requestUrl,
    ).href,
    requestMediaType: "text/html",
    fields: [],
  }));
  return routeError(
    requestUrl,
    401,
    "authentication_required",
    "Sign in and complete access registration to continue.",
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
    "The acknowledgment resource is temporarily unavailable.",
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
        message: "Check the acknowledgment request and try again.",
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
        message: "This request conflicts with the current acknowledgment state.",
      };
    case "PRECONDITION_FAILED":
      return {
        status: 412,
        code: "precondition_failed",
        message: "The information package changed. Reload and try again.",
      };
    case "UNAVAILABLE":
      return {
        status: 503,
        code: "service_unavailable",
        message: "The acknowledgment resource is temporarily unavailable.",
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
          href: new URL(
            PARTICIPANT_PACKAGE_ACKNOWLEDGMENT_PATH,
            requestUrl,
          ).href,
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
  return representation === "hypermedia-json"
    ? hypermediaResponseWithCsrf(error.document, error.status, null)
    : htmlResponse(renderErrorHtml(error.document), error.status);
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
      "This request method is not available for acknowledgment.",
    ),
    representation,
  );
  const headers = new Headers(response.headers);
  headers.set("Allow", "GET, POST");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function renderAcknowledgmentHtml(
  model: ParticipantPackageAcknowledgmentCapabilityModel,
  csrfToken: string | null,
  campaignName: string,
): string {
  const data = model.document.data;
  const evidence = data.latest_acceptance;
  const status = data.status === "acceptance_required"
    ? `<aside class="package-ack-status package-ack-status--required"><strong>Renewed acknowledgment required</strong><p>Review the current acknowledgment before continuing with an investment indication.</p></aside>`
    : `<aside class="package-ack-status package-ack-status--satisfied"><strong>Current requirement satisfied</strong><p>Your recorded acceptance satisfies this package requirement.</p></aside>`;
  const evidenceSection = evidence === null
    ? ""
    : `<section class="package-ack-evidence" aria-labelledby="package-ack-evidence-title">
        <div><p class="package-ack-label">Recorded evidence</p><h2 id="package-ack-evidence-title">Latest acceptance</h2></div>
        <dl>
          ${detail("Accepted", formatTimestamp(evidence.accepted_at))}
          ${detail("Accepted package", evidence.accepted_version_id)}
          ${detail("Current requirement", evidence.satisfies_current_requirement ? "Satisfied" : "Renewal required")}
        </dl>
      </section>`;

  return pageShell(
    `${campaignName} package acknowledgment`,
    campaignName,
    `<main class="package-ack-main">
      <a class="package-ack-back" href="/participant/package">Information package</a>
      <header class="package-ack-intro">
        <p class="package-ack-label">Current package</p>
        <h1>Package acknowledgment</h1>
        <p>Confirm the current non-binding acknowledgment after reviewing the information package.</p>
      </header>
      ${status}
      <section class="package-ack-summary" aria-labelledby="package-ack-summary-title">
        <div><p class="package-ack-label">Package version</p><h2 id="package-ack-summary-title">Current requirement</h2></div>
        <dl>
          ${detail("Updated", formatTimestamp(data.current_package.created_at))}
          ${detail("Change", data.current_package.change_summary)}
          ${detail("Classification", data.current_package.material_change ? "Material" : "Editorial")}
        </dl>
      </section>
      <section class="package-ack-statement" aria-labelledby="package-ack-statement-title">
        <p class="package-ack-label">Acknowledgment</p>
        <h2 id="package-ack-statement-title">Please review</h2>
        <p>${escapeHtml(data.acknowledgment_text)}</p>
      </section>
      ${renderAcknowledgmentForm(model.forms, csrfToken)}
      ${evidenceSection}
      <nav class="package-ack-navigation" aria-label="Participant navigation"><a href="/participant/package">Return to package</a><a href="/participant">Your participation</a></nav>
    </main>`,
  );
}

function renderAcknowledgmentForm(
  forms: readonly HtmlFormAction[],
  csrfToken: string | null,
): string {
  if (forms.length === 0) return "";
  const form = forms[0];
  if (!form || forms.length !== 1 || csrfToken === null) {
    throw new MutationSecurityFailure("SERVICE_UNAVAILABLE");
  }
  const hidden = [
    ...form.hiddenFields.map((field) => hiddenInput(field.name, field.value)),
    ...form.fields.map((field) => {
      if (field.presentation !== "hidden") unavailable();
      return hiddenInput(field.name, field.value ?? field.defaultValue ?? "");
    }),
    hiddenInput(MUTATION_CSRF_FIELD, csrfToken),
  ].join("");
  return `<section class="package-ack-action" aria-labelledby="package-ack-action-title">
    <div><p class="package-ack-label">Your response</p><h2 id="package-ack-action-title">Record your acknowledgment</h2><p>This records when you acknowledged the current package requirement.</p></div>
    <form action="${escapeHtml(form.action)}" data-action-name="${escapeHtml(form.name)}" enctype="${form.encoding ?? "application/x-www-form-urlencoded"}" method="${form.method}">${hidden}<button type="submit">${escapeHtml(form.title)}</button></form>
  </section>`;
}

function renderErrorHtml(document: RouteErrorDocument): string {
  const signIn = document.actions.find((action) => action.name === "sign-in");
  return pageShell(
    "Package acknowledgment",
    "Campaign",
    `<main class="package-ack-main package-ack-error">
      <p class="package-ack-label">Package acknowledgment</p>
      <h1>Acknowledgment unavailable</h1>
      <p>${escapeHtml(document.data.message)}</p>
      <div>${signIn ? `<a class="package-ack-primary" href="${escapeHtml(signIn.href)}">${escapeHtml(signIn.title)}</a>` : ""}<a href="/">Return to campaign</a></div>
    </main>`,
  );
}

function pageShell(title: string, campaignName: string, main: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/participant-package-acknowledgment.css">
</head>
<body class="package-ack-page">
  <header class="package-ack-header"><a href="/">${escapeHtml(campaignName)}</a><span>Private participant area</span></header>
  ${main}
</body>
</html>`;
}

function requiredParticipantSubject(context: ApplicationRouteContext): ActorSubject {
  if (context.actor === null) authenticationRequired();
  const access = context.participantAccess;
  const subject = parseActorSubject(context.actor.userId);
  if (
    context.isOwner ||
    access === null ||
    access.accountStatus !== "active" ||
    !subject.ok ||
    subject.value !== access.subject
  ) {
    notFound();
  }
  return subject.value;
}

function requiredRepositories(
  factory: ParticipantPackageAcknowledgmentRepositoryFactory,
  subject: ActorSubject,
): ParticipantPackageAcknowledgmentRepositories {
  let repositories: ParticipantPackageAcknowledgmentRepositories;
  try {
    repositories = factory(subject);
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
  if (
    typeof repositories !== "object" ||
    repositories === null ||
    typeof repositories.packages !== "object" ||
    repositories.packages === null ||
    typeof repositories.packages.current !== "function" ||
    typeof repositories.acknowledgments !== "object" ||
    repositories.acknowledgments === null ||
    typeof repositories.acknowledgments.get !== "function" ||
    typeof repositories.acknowledgments.latest !== "function" ||
    typeof repositories.acknowledgments.record !== "function"
  ) {
    unavailable();
  }
  return repositories;
}

function requireRevision<Value>(value: RevisionedSnapshot<Value>): void {
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !("snapshot" in value)
  ) {
    unavailable();
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function randomOperationId(): string {
  return `package-acknowledgment:${crypto.randomUUID()}`;
}

function authenticationRequired(): never {
  throw new MutationSecurityFailure("AUTHENTICATION_REQUIRED");
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
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      Vary: "Accept",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function withPrivateHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
