import {
  parseActorSubject,
  parseStableId,
  type ActorSubject,
} from "../domain/foundation.ts";
import type {
  ContributionAreaChoice,
  FounderApplicationId,
} from "../domain/founder-application.ts";
import { isConfiguredOwner } from "../domain/owner-identity.ts";
import {
  authorizeParticipantAccess,
  participantWorkflowAccess,
  type AuthorizedParticipantAccess,
  type ParticipantAccessStateReader,
} from "../domain/participant-home-resource.ts";
import { isPhaseAcceptingParticipation } from "../domain/phase-configuration.ts";
import { parseParticipantAccount } from "../domain/participant-profile.ts";
import {
  parsePublicCampaignConfiguration,
  type PublicCampaignConfiguration,
} from "../domain/public-campaign-configuration.ts";
import {
  FOUNDER_INTEREST_PATH,
  FOUNDER_SECONDARY_AREAS_FIELD,
} from "../domain/participant-founder-interest-resource.ts";
import { resolveAppOrigin, withAppOrigin } from "../http/app-origin.ts";
import { withRuntimeCapabilities } from "../http/runtime-capabilities.ts";
import { withRuntimeCampaign } from "../http/runtime-campaign.ts";
import { withRuntimeOwner } from "../http/runtime-owner.ts";
import { withRuntimeParticipantAccess } from "../http/runtime-participant.ts";
import {
  withRuntimeCampaignPreview,
  type RuntimeCampaignPreview,
} from "../http/runtime-preview.ts";
import type { PublicCampaignPresentationReader } from "../repositories/in-memory-campaign-repository.ts";
import type { ParticipantRequestRepositoryScope } from "../repositories/storage-application-repository-factory.ts";
import type { ParticipantRepository } from "../repositories/in-memory-participant-repository.ts";
import {
  StorageFailure,
  parseStorageOperationId,
  type StorageOperationId,
} from "../domain/storage-adapter.ts";
import type {
  ApplicationFetcher,
  ApplicationRouteContext,
  ApplicationRouteHandler,
  AuthenticatedActor,
  ImageFetcher,
  InvestorAppEnv,
  WorkerExecutionContext,
} from "./contracts.ts";
import type {
  ApplicationRuntimeDeploymentCapability,
  CampaignWorkspaceDeploymentCapability,
} from "./deployment-capabilities.ts";
import { hasHostedAittaDBApplicationRuntimeValues } from "./hosted-application-configuration.ts";
import {
  createApplicationRouteDispatcher,
  dispatchApplicationRoute,
} from "./routes/application.ts";
import {
  createOwnerIndicationModerationRouteHandler,
  type OwnerIndicationModerationRouteDependencies,
} from "./routes/owner-indication-moderation.ts";
import { createOwnerCampaignEditorRouteHandler } from "./routes/owner-campaign-editor.ts";
import { createOwnerInitialSetupRouteHandler } from "./routes/owner-initial-setup.ts";
import { createOwnerRouteHandler } from "./routes/owner.ts";
import {
  createOwnerPackageRouteHandler,
  MAX_OWNER_PACKAGE_MUTATION_BYTES,
  MAX_OWNER_PACKAGE_MUTATION_FIELDS,
  type OwnerPackageRouteDependencies,
} from "./routes/owner-package.ts";
import {
  createFounderInterestRouteHandler,
  createInvestmentInterestRouteHandler,
  createParticipantPackageAcknowledgmentRouteHandler,
  createParticipantPackageReaderRouteHandler,
  createParticipantRouteHandler,
  MAX_ACKNOWLEDGMENT_MUTATION_BYTES,
  MAX_ACKNOWLEDGMENT_MUTATION_FIELDS,
  MAX_FOUNDER_INTEREST_MUTATION_BYTES,
  MAX_FOUNDER_INTEREST_MUTATION_FIELDS,
  type FounderInterestRouteDependencies,
  type InvestmentInterestRouteDependencies,
  type ParticipantPackageAcknowledgmentRouteDependencies,
  type ParticipantPackageReaderDependencies,
} from "./routes/participant.ts";
import { createParticipantFounderInterestService } from "./founder-interest-service.ts";
import {
  createOwnerOAuthProofRouteHandler,
  type OwnerOAuthProofRouteDependencies,
} from "./routes/owner-oauth-proof.ts";
import {
  createOwnerReviewExportRouteHandler,
  type OwnerReviewExportRouteDependencies,
} from "./routes/owner-review-exports.ts";
import { handlePublicRoutes } from "./routes/public.ts";

export type ApplicationWorkerDependencies = Readonly<{
  fetchApplication: ApplicationFetcher;
  fetchOptimizedImage: ImageFetcher;
  dispatchRoute?: ApplicationRouteHandler;
  ownerPackage?: OwnerPackageRouteDependencies;
  ownerIndicationModeration?: OwnerIndicationModerationRouteDependencies;
  ownerReviewExports?: OwnerReviewExportRouteDependencies;
  participantFounderInterest?: FounderInterestRouteDependencies;
  participantInvestmentInterests?: InvestmentInterestRouteDependencies;
  participantPackageReader?: ParticipantPackageReaderDependencies;
  participantPackageAcknowledgment?: ParticipantPackageAcknowledgmentRouteDependencies;
  participantAccessReader?: ParticipantAccessStateReader;
  ownerOAuthProof?: OwnerOAuthProofRouteDependencies;
  resolveOwnerOAuthProof?: (
    env: InvestorAppEnv,
  ) => Promise<OwnerOAuthProofRouteDependencies | null | undefined>;
  applicationRuntime?: ApplicationRuntimeDeploymentCapability;
  resolveApplicationRuntime?: (
    env: InvestorAppEnv,
  ) => Promise<ApplicationRuntimeDeploymentCapability | null | undefined>;
  publicCampaignReader?: PublicCampaignPresentationReader;
  campaignWorkspace?: CampaignWorkspaceDeploymentCapability;
  resolveCampaignWorkspace?: () =>
    CampaignWorkspaceDeploymentCapability | null | undefined;
}>;

export function createApplicationWorker(
  dependencies: ApplicationWorkerDependencies,
): Readonly<{
  fetch(
    request: Request,
    env: InvestorAppEnv,
    context: WorkerExecutionContext,
  ): Promise<Response>;
}> {
  return {
    async fetch(request, env, executionContext) {
      const url = new URL(request.url);
      const appOrigin = resolveAppOrigin(request.url, env.APP_BASE_URL);
      const resourceUrl = canonicalResourceUrl(url, appOrigin);
      const actor = authenticatedActor(request);
      const isOwner = isConfiguredOwner(actor?.email, env.OWNER_EMAIL);
      const applicationRuntime = await resolveApplicationRuntime(
        dependencies,
        env,
      );
      const participantRequest = runtimeParticipantRequest(
        applicationRuntime,
        actor,
        isOwner,
        url.pathname,
      );
      const packageRoutes = dependencies.dispatchRoute === undefined &&
          applicationRuntime !== null
        ? runtimePackageRoutes(
            applicationRuntime,
            actor,
            isOwner,
            resourceUrl,
            participantRequest,
          )
        : null;
      const ownerPackage = dependencies.dispatchRoute === undefined
        ? dependencies.ownerPackage ?? packageRoutes?.owner
        : undefined;
      const participantPackageReader = dependencies.dispatchRoute === undefined
        ? dependencies.participantPackageReader ?? packageRoutes?.participantReader
        : undefined;
      const participantPackageAcknowledgment =
        dependencies.dispatchRoute === undefined
          ? dependencies.participantPackageAcknowledgment ??
            packageRoutes?.participantAcknowledgment
          : undefined;
      const ownerPackageAvailable = ownerPackage !== undefined;
      const ownerIndicationModerationAvailable =
        dependencies.dispatchRoute === undefined &&
        dependencies.ownerIndicationModeration !== undefined;
      const ownerReviewExportsAvailable =
        dependencies.dispatchRoute === undefined &&
        dependencies.ownerReviewExports !== undefined;
      const participantInvestmentInterestsAvailable =
        dependencies.dispatchRoute === undefined &&
        dependencies.participantInvestmentInterests !== undefined;
      const ownerOAuthProof = dependencies.dispatchRoute === undefined
        ? await resolveOwnerOAuthProof(dependencies, env)
        : null;
      const ownerOAuthProofAvailable = ownerOAuthProof !== null;
      const campaignWorkspace = dependencies.dispatchRoute === undefined
        ? resolveCampaignWorkspace(dependencies, applicationRuntime, appOrigin)
        : null;
      const publicCampaign = await resolvePublicCampaign(
        campaignWorkspace?.publicReader ?? dependencies.publicCampaignReader,
        hasHostedAittaDBApplicationRuntimeValues(env)
          ? undefined
          : env.CAMPAIGN_CONFIG_JSON,
      );
      const campaign = isOwner && isOwnerPath(url.pathname) && campaignWorkspace
        ? await resolveOwnerCampaign(campaignWorkspace, publicCampaign)
        : publicCampaign;
      const participantAccessReader = dependencies.participantAccessReader ??
        participantRequest?.participantAccessReader();
      const participantAccess = await resolveParticipantAccess(
        actor,
        participantAccessReader,
      );
      const participantFounderInterest = dependencies.dispatchRoute === undefined
        ? dependencies.participantFounderInterest ??
          await runtimeParticipantFounderInterestRoute(
            applicationRuntime,
            actor,
            isOwner,
            participantAccess,
            resourceUrl,
            url.pathname,
            participantRequest,
          )
        : undefined;
      const participantFounderInterestAvailable =
        participantFounderInterest !== undefined &&
        participantFounderInterest !== null;
      const renderEnvironment = applicationRenderEnvironment(env);
      const campaignEditorAvailable = campaignWorkspace !== null;
      const renderApplication: ApplicationRouteContext["renderApplication"] = (
        options = {},
      ) => {
        const preview = options.preview ?? null;
        const normalApplication = preview === null;
        return dependencies.fetchApplication(
          withRuntimeConfiguration(
            options.request ?? request,
            env,
            normalApplication ? participantAccess : null,
            Object.hasOwn(options, "campaign")
              ? options.campaign ?? null
              : campaign,
            {
              ownerPackageWorkspace:
                normalApplication && ownerPackageAvailable && isOwner,
              ownerIndicationModeration:
                normalApplication && ownerIndicationModerationAvailable,
              ownerReviewExports:
                normalApplication && ownerReviewExportsAvailable,
              participantFounderInterest:
                normalApplication && participantFounderInterestAvailable,
              participantInvestmentInterests:
                normalApplication && participantInvestmentInterestsAvailable,
              ownerCampaignEditor:
                normalApplication && campaignEditorAvailable,
              ownerCampaignSetup:
                normalApplication && campaignEditorAvailable,
              ownerAittadbConnection:
                normalApplication && ownerOAuthProofAvailable,
            },
            preview,
          ),
          renderEnvironment,
          executionContext,
        );
      };

      const hasInjectedRoutes = ownerPackageAvailable ||
        participantPackageReader !== undefined ||
        participantPackageAcknowledgment !== undefined ||
        ownerIndicationModerationAvailable ||
        ownerReviewExportsAvailable ||
        participantFounderInterestAvailable ||
        participantInvestmentInterestsAvailable ||
        campaignEditorAvailable ||
        ownerOAuthProofAvailable;
      const dispatchRoute = dependencies.dispatchRoute ??
        (hasInjectedRoutes
          ? createInjectedRouteDispatcher(
              dependencies,
              campaignWorkspace,
              ownerOAuthProof,
              participantFounderInterest ?? null,
              {
                owner: ownerPackage,
                participantReader: participantPackageReader,
                participantAcknowledgment: participantPackageAcknowledgment,
              },
              {
                ownerPackageAvailable,
                ownerIndicationModerationAvailable,
                ownerReviewExportsAvailable,
                participantFounderInterestAvailable,
                participantInvestmentInterestsAvailable,
                campaignEditorAvailable,
                campaignSetupAvailable: campaignEditorAvailable,
                ownerOAuthProofAvailable,
              },
            )
          : dispatchApplicationRoute);

      const routeResponse = await dispatchRoute({
        request,
        url,
        resourceUrl,
        actor,
        isOwner,
        participantAccess,
        campaign,
        renderApplication,
      });
      if (routeResponse) return routeResponse;

      if (url.pathname === "/_vinext/image") {
        return dependencies.fetchOptimizedImage(request, renderEnvironment);
      }

      return renderApplication();
    },
  };
}

function applicationRenderEnvironment(
  env: InvestorAppEnv,
): Readonly<Pick<InvestorAppEnv, "ASSETS" | "IMAGES">> {
  return Object.freeze({
    ASSETS: env.ASSETS,
    IMAGES: env.IMAGES,
  });
}

type InjectedRouteAvailability = Readonly<{
  ownerPackageAvailable: boolean;
  ownerIndicationModerationAvailable: boolean;
  ownerReviewExportsAvailable: boolean;
  participantFounderInterestAvailable: boolean;
  participantInvestmentInterestsAvailable: boolean;
  campaignEditorAvailable: boolean;
  campaignSetupAvailable: boolean;
  ownerOAuthProofAvailable: boolean;
}>;

type ResolvedPackageRoutes = Readonly<{
  owner?: OwnerPackageRouteDependencies;
  participantReader?: ParticipantPackageReaderDependencies;
  participantAcknowledgment?: ParticipantPackageAcknowledgmentRouteDependencies;
}>;

function createInjectedRouteDispatcher(
  dependencies: ApplicationWorkerDependencies,
  campaignWorkspace: CampaignWorkspaceDeploymentCapability | null,
  ownerOAuthProof: OwnerOAuthProofRouteDependencies | null,
  participantFounderInterest: FounderInterestRouteDependencies | null,
  packageRoutes: ResolvedPackageRoutes,
  available: InjectedRouteAvailability,
): ApplicationRouteHandler {
  const issueCampaignOperationId = campaignWorkspace?.issueOperationId;
  return createApplicationRouteDispatcher({
    public: handlePublicRoutes,
    participant: createParticipantRouteHandler(
      [
        ...(packageRoutes.participantReader
          ? [createParticipantPackageReaderRouteHandler(
              packageRoutes.participantReader,
            )]
          : []),
        ...(packageRoutes.participantAcknowledgment
          ? [createParticipantPackageAcknowledgmentRouteHandler(
              packageRoutes.participantAcknowledgment,
            )]
          : []),
        ...(participantFounderInterest
          ? [createFounderInterestRouteHandler(
              participantFounderInterest,
            )]
          : []),
        ...(dependencies.participantInvestmentInterests
          ? [createInvestmentInterestRouteHandler(
              dependencies.participantInvestmentInterests,
            )]
          : []),
      ],
      {
        founderInterest: available.participantFounderInterestAvailable,
        investmentInterests: available.participantInvestmentInterestsAvailable,
      },
    ),
    owner: createOwnerRouteHandler(
      [
        ...(packageRoutes.owner
          ? [createOwnerPackageRouteHandler(packageRoutes.owner)]
          : []),
        ...(dependencies.ownerIndicationModeration
          ? [createOwnerIndicationModerationRouteHandler(
              dependencies.ownerIndicationModeration,
            )]
          : []),
        ...(dependencies.ownerReviewExports
          ? [createOwnerReviewExportRouteHandler(
              dependencies.ownerReviewExports,
            )]
          : []),
        ...(campaignWorkspace
          ? [
              createOwnerInitialSetupRouteHandler({
                repository: campaignWorkspace.repository,
                checkPublicationReadiness:
                  campaignWorkspace.checkPublicationReadiness,
                mutationSession: campaignWorkspace.mutationSession,
                appOrigin: campaignWorkspace.appOrigin,
                ...(issueCampaignOperationId
                  ? {
                      issueOperationId: () =>
                        issueCampaignOperationId("setup"),
                    }
                  : {}),
                ...(campaignWorkspace.now ? { now: campaignWorkspace.now } : {}),
              }),
              createOwnerCampaignEditorRouteHandler(campaignWorkspace),
            ]
          : []),
        ...(ownerOAuthProof
          ? [createOwnerOAuthProofRouteHandler(ownerOAuthProof)]
          : []),
      ],
      {
        managePackage: available.ownerPackageAvailable,
        indicationModeration: available.ownerIndicationModerationAvailable,
        reviewExports: available.ownerReviewExportsAvailable,
        campaignEditor: available.campaignEditorAvailable,
        campaignSetup: available.campaignSetupAvailable,
        aittadbConnection: available.ownerOAuthProofAvailable,
      },
    ),
  });
}

async function runtimeParticipantFounderInterestRoute(
  runtime: ApplicationRuntimeDeploymentCapability | null,
  actor: AuthenticatedActor | null,
  isOwner: boolean,
  participantAccess: AuthorizedParticipantAccess | null,
  resourceUrl: string,
  pathname: string,
  participantRequest: ParticipantRequestRepositoryScope | null,
): Promise<FounderInterestRouteDependencies | null> {
  const exactFounderResource = pathname === FOUNDER_INTEREST_PATH;
  if (
    runtime === null ||
    (pathname !== "/participant" && !exactFounderResource)
  ) {
    return null;
  }
  const unavailableRoute = exactFounderResource
    ? unavailableFounderInterestRoute()
    : null;
  if (
    actor === null ||
    isOwner ||
    participantAccess === null ||
    participantAccess.subject !== actor.userId ||
    !participantWorkflowAccess(participantAccess, { founderInterest: true })
      .founderInterest
  ) {
    return unavailableRoute;
  }

  const account = parseParticipantAccount({
    subject: actor.userId,
    accountEmailLabel: actor.email,
  });
  if (!account.ok) return unavailableRoute;

  try {
    const repositories = runtime.repositoryFactory;
    const campaign = await repositories.campaignRepository().readSetup();
    const contributionAreaChoices = campaign?.setup.campaignPolicy
      .founderContributionChoices ?? Object.freeze([]);

    const founder = requiredParticipantRequest(participantRequest)
      .participantFounderApplications(
      contributionAreaChoices,
    );

    const appOrigin = new URL(resourceUrl).origin;
    const identity = Object.freeze({
      type: "participant" as const,
      subject: account.value.subject,
    });
    const applicationId = selfFounderApplicationId();

    return Object.freeze({
      serviceFor(candidateSubject) {
        if (candidateSubject !== account.value.subject) {
          throw new Error("Founder application is unavailable.");
        }
        return createParticipantFounderInterestService({
          actorSubject: account.value.subject,
          applicationId,
          contributionAreaChoices,
          repository: founder.applications,
          canCreate: () => founderCreationAllowed(
            repositories,
            founder.participant,
            account.value.subject,
            contributionAreaChoices,
          ),
          now: runtime.now,
        });
      },
      verifyMutation: (request: Request) =>
        runtime.mutationSession.verifyMutation(
          request,
          identity,
          appOrigin,
          {
            maxBodyBytes: MAX_FOUNDER_INTEREST_MUTATION_BYTES,
            maxFields: MAX_FOUNDER_INTEREST_MUTATION_FIELDS,
            repeatedFormFields: [FOUNDER_SECONDARY_AREAS_FIELD],
          },
        ),
      csrfTokenFor: (request, candidateSubject) =>
        candidateSubject === account.value.subject
          ? runtime.mutationSession.issue(request, identity, appOrigin)
          : Promise.resolve(null),
      createOperationId: () => randomOperationId("founder-operation"),
    });
  } catch {
    return unavailableRoute;
  }
}

function unavailableFounderInterestRoute(): FounderInterestRouteDependencies {
  return Object.freeze({
    serviceFor() {
      throw new StorageFailure("NOT_FOUND");
    },
    async verifyMutation() {
      throw new StorageFailure("NOT_FOUND");
    },
    csrfTokenFor: () => null,
  });
}

async function founderCreationAllowed(
  repositories: ApplicationRuntimeDeploymentCapability["repositoryFactory"],
  participant: Pick<ParticipantRepository, "current">,
  subject: ActorSubject,
  expectedChoices: readonly ContributionAreaChoice[],
): Promise<boolean> {
  const [campaign, currentParticipant] = await Promise.all([
    repositories.campaignRepository().readSetup(),
    participant.current(),
  ]);
  if (
    campaign === null ||
    expectedChoices.length === 0 ||
    currentParticipant === null ||
    !profilePermitsFounder(currentParticipant.snapshot, subject) ||
    campaign.setup.publicCampaign.published !== true ||
    campaign.setup.publicCampaign.status !== "open" ||
    !sameContributionAreaChoices(
      campaign.setup.campaignPolicy.founderContributionChoices,
      expectedChoices,
    )
  ) {
    return false;
  }

  return campaign.setup.phases.some((phase) => {
    const result = isPhaseAcceptingParticipation(
      phase,
      "founder",
      currentParticipant.snapshot.country,
    );
    return result.ok && result.value;
  });
}

function profilePermitsFounder(
  profile: Readonly<{
    subject: ActorSubject;
    declaredInterest: string;
    accountDeletionRequest: Readonly<{ state: string }>;
  }>,
  subject: ActorSubject,
): boolean {
  return profile.subject === subject &&
    profile.accountDeletionRequest.state === "not-requested" &&
    (profile.declaredInterest === "founder" ||
      profile.declaredInterest === "both");
}

function sameContributionAreaChoices(
  left: readonly ContributionAreaChoice[],
  right: readonly ContributionAreaChoice[],
): boolean {
  return left.length === right.length && left.every((choice, index) =>
    choice.id === right[index]?.id && choice.label === right[index]?.label
  );
}

function selfFounderApplicationId(): FounderApplicationId {
  const parsed = parseStableId<"founder-application">(
    "founder-application:self",
  );
  if (!parsed.ok) throw new Error("Founder application is unavailable.");
  return parsed.value;
}

function runtimePackageRoutes(
  runtime: ApplicationRuntimeDeploymentCapability,
  actor: AuthenticatedActor | null,
  isOwner: boolean,
  resourceUrl: string,
  participantRequest: ParticipantRequestRepositoryScope | null,
): ResolvedPackageRoutes | null {
  try {
    const appOrigin = new URL(resourceUrl).origin;
    const ownerIdentity = actor !== null && isOwner
      ? Object.freeze({ type: "owner" as const, subject: actor.userId })
      : null;
    const participantIdentity = actor !== null && !isOwner
      ? Object.freeze({ type: "participant" as const, subject: actor.userId })
      : null;
    const repositories = runtime.repositoryFactory;
    const session = runtime.mutationSession;

    return Object.freeze({
      owner: Object.freeze({
        workspace: repositories.ownerPackageWorkspace(),
        verifyMutation: (request: Request) =>
          session.verifyMutation(request, ownerIdentity, appOrigin, {
            maxBodyBytes: MAX_OWNER_PACKAGE_MUTATION_BYTES,
            maxFields: MAX_OWNER_PACKAGE_MUTATION_FIELDS,
            repeatedFormFields: [],
          }),
        csrfToken: (request: Request, owner: Readonly<{ subject: string }>) =>
          ownerIdentity !== null && owner.subject === ownerIdentity.subject
            ? session.issue(request, ownerIdentity, appOrigin)
            : Promise.resolve(null),
        issueOperationId: () => randomOperationId("package-operation"),
      }),
      participantReader: Object.freeze({
        repositoryFor: (participantSubject: ActorSubject) =>
          requiredParticipantRequest(participantRequest)
            .participantPackageReader(participantSubject),
      }),
      participantAcknowledgment: Object.freeze({
        repositoryFor: (participantSubject: ActorSubject) =>
          requiredParticipantRequest(participantRequest)
            .participantPackageAcknowledgments(participantSubject),
        verifyMutation: (request: Request) =>
          session.verifyMutation(
            request,
            participantIdentity,
            appOrigin,
            {
              maxBodyBytes: MAX_ACKNOWLEDGMENT_MUTATION_BYTES,
              maxFields: MAX_ACKNOWLEDGMENT_MUTATION_FIELDS,
              repeatedFormFields: [],
            },
          ),
        csrfTokenFor: (
          request: Request,
          participantSubject: string,
        ) =>
          participantIdentity !== null &&
            participantSubject === participantIdentity.subject
            ? session.issue(request, participantIdentity, appOrigin)
            : Promise.resolve(null),
        now: runtime.now,
        createOperationId: () =>
          randomOperationId("package-acknowledgment"),
      }),
    });
  } catch {
    return null;
  }
}

function randomOperationId(namespace: string): StorageOperationId {
  const parsed = parseStorageOperationId(
    `${namespace}:${crypto.randomUUID()}`,
  );
  if (!parsed.ok) throw new Error("Unable to issue a package operation ID.");
  return parsed.value;
}

async function resolveApplicationRuntime(
  dependencies: ApplicationWorkerDependencies,
  env: InvestorAppEnv,
): Promise<ApplicationRuntimeDeploymentCapability | null> {
  if (dependencies.applicationRuntime !== undefined) {
    return dependencies.applicationRuntime;
  }
  try {
    return await dependencies.resolveApplicationRuntime?.(env) ?? null;
  } catch {
    return null;
  }
}

async function resolveOwnerOAuthProof(
  dependencies: ApplicationWorkerDependencies,
  env: InvestorAppEnv,
): Promise<OwnerOAuthProofRouteDependencies | null> {
  if (dependencies.ownerOAuthProof !== undefined) {
    return dependencies.ownerOAuthProof;
  }
  try {
    return await dependencies.resolveOwnerOAuthProof?.(env) ?? null;
  } catch {
    return null;
  }
}

function canonicalResourceUrl(url: URL, appOrigin: string): string {
  return new URL(`${url.pathname}${url.search}`, `${appOrigin}/`).href;
}

function withRuntimeConfiguration(
  request: Request,
  env: InvestorAppEnv,
  participantAccess: AuthorizedParticipantAccess | null,
  campaign: PublicCampaignConfiguration | null,
  capabilities: Readonly<{
    ownerPackageWorkspace: boolean;
    ownerIndicationModeration: boolean;
    ownerReviewExports: boolean;
    participantFounderInterest: boolean;
    participantInvestmentInterests: boolean;
    ownerCampaignEditor: boolean;
    ownerCampaignSetup: boolean;
    ownerAittadbConnection: boolean;
  }>,
  preview: RuntimeCampaignPreview | null,
): Request {
  return withRuntimeCampaignPreview(
    withRuntimeCapabilities(
      withRuntimeParticipantAccess(
        withRuntimeCampaign(
          withRuntimeOwner(
            withAppOrigin(request, env.APP_BASE_URL),
            preview === null ? env.OWNER_EMAIL : undefined,
          ),
          campaign === null ? undefined : JSON.stringify(campaign),
        ),
        participantAccess,
      ),
      capabilities,
    ),
    preview,
  );
}

async function resolvePublicCampaign(
  reader: PublicCampaignPresentationReader | undefined,
  bootstrapConfiguration: string | undefined,
): Promise<PublicCampaignConfiguration | null> {
  if (reader === undefined) {
    return parsePublicCampaignConfiguration(bootstrapConfiguration);
  }
  try {
    return await reader.readPublishedCampaign();
  } catch {
    return null;
  }
}

async function resolveOwnerCampaign(
  workspace: CampaignWorkspaceDeploymentCapability,
  fallback: PublicCampaignConfiguration | null,
): Promise<PublicCampaignConfiguration | null> {
  try {
    return (await workspace.repository.readSetup())?.setup.publicCampaign ?? fallback;
  } catch {
    return fallback;
  }
}

function resolveCampaignWorkspace(
  dependencies: ApplicationWorkerDependencies,
  runtime: ApplicationRuntimeDeploymentCapability | null,
  appOrigin: string,
): CampaignWorkspaceDeploymentCapability | null {
  if (dependencies.campaignWorkspace) return dependencies.campaignWorkspace;
  try {
    const injected = dependencies.resolveCampaignWorkspace?.() ?? null;
    if (injected !== null) return injected;
    if (runtime === null) return null;
    return Object.freeze({
      repository: runtime.repositoryFactory.campaignRepository(),
      publicReader: runtime.repositoryFactory.publicCampaignReader(),
      checkPublicationReadiness: async () => runtime.publicationReady === true,
      mutationSession: runtime.mutationSession,
      appOrigin,
      now: runtime.now,
    });
  } catch {
    return null;
  }
}

function isOwnerPath(pathname: string): boolean {
  return pathname === "/owner" || pathname.startsWith("/owner/");
}

async function resolveParticipantAccess(
  actor: AuthenticatedActor | null,
  reader: ParticipantAccessStateReader | undefined,
): Promise<AuthorizedParticipantAccess | null> {
  if (actor === null || reader === undefined) return null;

  const account = parseParticipantAccount({
    subject: actor.userId,
    accountEmailLabel: actor.email,
  });
  if (!account.ok) return null;

  try {
    return authorizeParticipantAccess(
      account.value,
      await reader.read(account.value),
    );
  } catch {
    return null;
  }
}

function runtimeParticipantRequest(
  runtime: ApplicationRuntimeDeploymentCapability | null,
  actor: AuthenticatedActor | null,
  isOwner: boolean,
  pathname: string,
): ParticipantRequestRepositoryScope | null {
  if (
    runtime === null ||
    actor === null ||
    isOwner ||
    !isParticipantAccessPath(pathname)
  ) {
    return null;
  }
  const account = parseParticipantAccount({
    subject: actor.userId,
    accountEmailLabel: actor.email,
  });
  if (!account.ok) return null;
  try {
    return runtime.repositoryFactory.participantRequest(account.value);
  } catch {
    return null;
  }
}

function requiredParticipantRequest(
  value: ParticipantRequestRepositoryScope | null,
): ParticipantRequestRepositoryScope {
  if (value === null) {
    throw new Error("Participant request repositories are unavailable.");
  }
  return value;
}

function isParticipantAccessPath(pathname: string): boolean {
  return pathname === "/" ||
    pathname === "/participant" ||
    pathname.startsWith("/participant/");
}

function authenticatedActor(request: Request): AuthenticatedActor | null {
  const userId = request.headers.get("oai-authenticated-user-id")?.trim();
  const email = request.headers.get("oai-authenticated-user-email")?.trim();

  if (!userId || !email) return null;
  const subject = parseActorSubject(userId);
  if (!subject.ok) return null;

  return {
    userId: subject.value,
    email,
    displayName: email,
  };
}
