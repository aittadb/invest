import {
  parseActorSubject,
  parseStableId,
  type ActorSubject,
} from "../domain/foundation.ts";
import type { AmountConfiguration } from "../domain/amount-aggregate-configuration.ts";
import type {
  ContributionAreaChoice,
  FounderApplicationId,
} from "../domain/founder-application.ts";
import type {
  InvestmentIndicationId,
  TrustedPackageAcknowledgmentContext,
} from "../domain/investment-indication.ts";
import { isConfiguredOwner } from "../domain/owner-identity.ts";
import {
  authorizeParticipantAccess,
  type AuthorizedParticipantAccess,
  type ParticipantAccessStateReader,
} from "../domain/participant-home-resource.ts";
import { isPhaseAcceptingParticipation } from "../domain/phase-configuration.ts";
import {
  PARTICIPANT_REGISTRATION_PATH,
  createParticipantRegistrationNoticeEvidence,
  participantRegistrationNoticesFromCampaignPolicy,
} from "../domain/participant-registration-resource.ts";
import { PARTICIPANT_PROFILE_PATH } from "../domain/participant-profile-resource.ts";
import { PARTICIPANT_HOME_PATH } from "../domain/participant-navigation.ts";
import { parseParticipantAccount } from "../domain/participant-profile.ts";
import {
  parsePublicCampaignConfiguration,
  type PublicCampaignConfiguration,
} from "../domain/public-campaign-configuration.ts";
import {
  FOUNDER_INTEREST_PATH,
  FOUNDER_SECONDARY_AREAS_FIELD,
} from "../domain/participant-founder-interest-resource.ts";
import { INVESTMENT_INTEREST_PATH } from "../domain/participant-investment-interest-resource.ts";
import { resolveAppOrigin, withAppOrigin } from "../http/app-origin.ts";
import { withRuntimeCapabilities } from "../http/runtime-capabilities.ts";
import { withRuntimeCampaign } from "../http/runtime-campaign.ts";
import { withRuntimeOwner } from "../http/runtime-owner.ts";
import { withRuntimeParticipantAccess } from "../http/runtime-participant.ts";
import { withRuntimePublicAggregate } from "../http/runtime-public-aggregate.ts";
import {
  withRuntimeCampaignPreview,
  type RuntimeCampaignPreview,
} from "../http/runtime-preview.ts";
import type { PublicCampaignPresentationReader } from "../repositories/in-memory-campaign-repository.ts";
import type { FounderApplicationReviewCollectionRepository } from "../repositories/in-memory-founder-application-repository.ts";
import type {
  PublicCampaignStateReader,
  PublishedPublicCampaignState,
} from "../repositories/storage-public-campaign-state-reader.ts";
import type {
  ParticipantPackageAcknowledgmentRepositories,
  ParticipantRequestRepositoryScope,
} from "../repositories/storage-application-repository-factory.ts";
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
import {
  createOwnerAuditHistoryRouteHandler,
  type OwnerAuditHistoryRouteDependencies,
} from "./routes/owner-audit-notification-history.ts";
import { createOwnerCampaignEditorRouteHandler } from "./routes/owner-campaign-editor.ts";
import { createOwnerFounderReviewCollectionRouteHandler } from "./routes/owner-founder-review.ts";
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
  createParticipantProfileRouteHandler,
  createParticipantRegistrationRouteHandler,
  createParticipantRouteHandler,
  MAX_ACKNOWLEDGMENT_MUTATION_BYTES,
  MAX_ACKNOWLEDGMENT_MUTATION_FIELDS,
  MAX_FOUNDER_INTEREST_MUTATION_BYTES,
  MAX_FOUNDER_INTEREST_MUTATION_FIELDS,
  MAX_REGISTRATION_MUTATION_BYTES,
  MAX_REGISTRATION_MUTATION_FIELDS,
  participantProfileMutationLimits,
  type FounderInterestRouteDependencies,
  type InvestmentInterestRouteDependencies,
  type ParticipantPackageAcknowledgmentRouteDependencies,
  type ParticipantPackageReaderDependencies,
  type ParticipantProfileRouteDependencies,
  type ParticipantRegistrationRouteDependencies,
} from "./routes/participant.ts";
import { createParticipantFounderInterestService } from "./founder-interest-service.ts";
import {
  createParticipantInvestmentInterestService,
  type InvestmentInterestPermissions,
} from "./investment-interest-service.ts";
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
  ownerAuditHistory?: OwnerAuditHistoryRouteDependencies;
  ownerFounderReview?: FounderApplicationReviewCollectionRepository;
  participantFounderInterest?: FounderInterestRouteDependencies;
  participantInvestmentInterests?: InvestmentInterestRouteDependencies;
  participantProfile?: ParticipantProfileRouteDependencies;
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
  publicCampaignStateReader?: PublicCampaignStateReader;
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
      const ownerAuditHistory = dependencies.dispatchRoute === undefined
        ? dependencies.ownerAuditHistory ??
          runtimeOwnerAuditHistory(applicationRuntime)
        : undefined;
      const ownerAuditHistoryAvailable = ownerAuditHistory !== undefined;
      const ownerFounderReview = dependencies.dispatchRoute === undefined
        ? dependencies.ownerFounderReview ??
          runtimeOwnerFounderReview(applicationRuntime)
        : undefined;
      const ownerFounderReviewAvailable = ownerFounderReview !== undefined;
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
      const publicState = await resolvePublicCampaignState(
        request.method === "GET" && url.pathname === "/"
          ? resolvePublicCampaignStateReader(dependencies, applicationRuntime)
          : undefined,
        campaignWorkspace?.publicReader ?? dependencies.publicCampaignReader,
        hasHostedAittaDBApplicationRuntimeValues(env)
          ? undefined
          : env.CAMPAIGN_CONFIG_JSON,
      );
      const publicCampaign = publicState?.campaign ?? null;
      const publicAggregate = publicState?.aggregate ?? null;
      const campaign = isOwner && isOwnerPath(url.pathname) && campaignWorkspace
        ? await resolveOwnerCampaign(campaignWorkspace, publicCampaign)
        : publicCampaign;
      const participantAccessReader = dependencies.participantAccessReader ??
        participantRequest?.participantAccessReader();
      const participantAccessResolution = await resolveParticipantAccess(
        actor,
        participantAccessReader,
      );
      const participantAccess = participantAccessResolution.access;
      const participantRegistration = dependencies.dispatchRoute === undefined &&
          applicationRuntime !== null &&
          (url.pathname === PARTICIPANT_REGISTRATION_PATH ||
            (url.pathname === PARTICIPANT_HOME_PATH &&
              participantAccessResolution.kind === "missing"))
        ? await runtimeParticipantRegistrationRoute(
            applicationRuntime,
            actor,
            isOwner,
            resourceUrl,
            url.pathname,
          )
        : null;
      const participantProfile = dependencies.dispatchRoute === undefined
        ? dependencies.participantProfile ??
          (applicationRuntime !== null
            ? runtimeParticipantProfileRoute(
                applicationRuntime,
                actor,
                isOwner,
                participantAccess,
                resourceUrl,
                url.pathname,
                participantRequest,
              )
            : null)
        : null;
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
      const participantInvestmentInterests =
        dependencies.dispatchRoute === undefined
          ? dependencies.participantInvestmentInterests ??
            await runtimeParticipantInvestmentInterestRoute(
              applicationRuntime,
              actor,
              isOwner,
              participantAccess,
              resourceUrl,
              url.pathname,
              participantRequest,
            )
          : undefined;
      const participantInvestmentInterestsAvailable =
        participantInvestmentInterests !== undefined &&
        participantInvestmentInterests !== null;
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
            normalApplication
              ? Object.hasOwn(options, "publicAggregate")
                ? options.publicAggregate ?? null
                : publicAggregate
              : null,
            {
              ownerPackageWorkspace:
                normalApplication && ownerPackageAvailable && isOwner,
              ownerIndicationModeration:
                normalApplication && ownerIndicationModerationAvailable,
              ownerReviewExports:
                normalApplication && ownerReviewExportsAvailable,
              ownerAuditHistory:
                normalApplication && ownerAuditHistoryAvailable && isOwner,
              ownerFounderReview:
                normalApplication && ownerFounderReviewAvailable && isOwner,
              participantFounderInterest:
                normalApplication && participantFounderInterestAvailable,
              participantInvestmentInterests:
                normalApplication && participantInvestmentInterestsAvailable,
              participantProfileSelfService:
                normalApplication && participantProfile !== null,
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
        participantRegistration !== null ||
        participantProfile !== null ||
        participantPackageReader !== undefined ||
        participantPackageAcknowledgment !== undefined ||
        ownerIndicationModerationAvailable ||
        ownerReviewExportsAvailable ||
        ownerAuditHistoryAvailable ||
        ownerFounderReviewAvailable ||
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
              participantRegistration,
              participantProfile,
              ownerAuditHistory,
              ownerFounderReview,
              participantFounderInterest ?? null,
              participantInvestmentInterests ?? null,
              {
                owner: ownerPackage,
                participantReader: participantPackageReader,
                participantAcknowledgment: participantPackageAcknowledgment,
              },
              {
                ownerPackageAvailable,
                participantRegistrationAvailable:
                  participantRegistration !== null,
                participantProfileAvailable: participantProfile !== null,
                ownerIndicationModerationAvailable,
                ownerReviewExportsAvailable,
                ownerAuditHistoryAvailable,
                ownerFounderReviewAvailable,
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
        publicAggregate,
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
  participantRegistrationAvailable: boolean;
  participantProfileAvailable: boolean;
  ownerIndicationModerationAvailable: boolean;
  ownerReviewExportsAvailable: boolean;
  ownerAuditHistoryAvailable: boolean;
  ownerFounderReviewAvailable: boolean;
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
  participantRegistration: ParticipantRegistrationRouteDependencies | null,
  participantProfile: ParticipantProfileRouteDependencies | null,
  ownerAuditHistory: OwnerAuditHistoryRouteDependencies | undefined,
  ownerFounderReview:
    | FounderApplicationReviewCollectionRepository
    | undefined,
  participantFounderInterest: FounderInterestRouteDependencies | null,
  participantInvestmentInterests: InvestmentInterestRouteDependencies | null,
  packageRoutes: ResolvedPackageRoutes,
  available: InjectedRouteAvailability,
): ApplicationRouteHandler {
  const issueCampaignOperationId = campaignWorkspace?.issueOperationId;
  return createApplicationRouteDispatcher({
    public: handlePublicRoutes,
    participant: createParticipantRouteHandler(
      [
        ...(participantRegistration
          ? [createParticipantRegistrationRouteHandler(
              participantRegistration,
            )]
          : []),
        ...(participantProfile
          ? [createParticipantProfileRouteHandler(participantProfile)]
          : []),
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
        ...(participantInvestmentInterests
          ? [createInvestmentInterestRouteHandler(
              participantInvestmentInterests,
            )]
          : []),
      ],
      {
        registration: available.participantRegistrationAvailable,
        profileSelfService: available.participantProfileAvailable,
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
        ...(ownerAuditHistory
          ? [createOwnerAuditHistoryRouteHandler(ownerAuditHistory)]
          : []),
        ...(ownerFounderReview
          ? [createOwnerFounderReviewCollectionRouteHandler(
              ownerFounderReview,
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
        auditHistory: available.ownerAuditHistoryAvailable,
        founderApplicationReview: available.ownerFounderReviewAvailable,
        campaignEditor: available.campaignEditorAvailable,
        campaignSetup: available.campaignSetupAvailable,
        aittadbConnection: available.ownerOAuthProofAvailable,
      },
    ),
  });
}

function runtimeParticipantProfileRoute(
  runtime: ApplicationRuntimeDeploymentCapability,
  actor: AuthenticatedActor | null,
  isOwner: boolean,
  participantAccess: AuthorizedParticipantAccess | null,
  resourceUrl: string,
  pathname: string,
  participantRequest: ParticipantRequestRepositoryScope | null,
): ParticipantProfileRouteDependencies | null {
  if (
    (pathname !== PARTICIPANT_HOME_PATH &&
      pathname !== PARTICIPANT_PROFILE_PATH) ||
    actor === null ||
    isOwner ||
    participantAccess === null
  ) {
    return null;
  }

  const account = parseParticipantAccount({
    subject: actor.userId,
    accountEmailLabel: actor.email,
  });
  if (
    !account.ok ||
    participantAccess.subject !== account.value.subject ||
    participantAccess.email !== account.value.accountEmailLabel
  ) {
    return null;
  }

  try {
    const participant = requiredParticipantRequest(participantRequest)
      .participantProfileRepository();
    const appOrigin = new URL(resourceUrl).origin;
    const identity = Object.freeze({
      type: "participant" as const,
      subject: account.value.subject,
    });
    const sameAccount = (candidate: typeof account.value) =>
      candidate.subject === account.value.subject &&
      candidate.accountEmailLabel === account.value.accountEmailLabel;

    return Object.freeze({
      repositoryFor(candidate) {
        if (!sameAccount(candidate)) {
          throw new Error("Participant profile is unavailable.");
        }
        return participant;
      },
      verifyMutation: (request: Request) =>
        runtime.mutationSession.verifyMutation(
          request,
          identity,
          appOrigin,
          participantProfileMutationLimits(request.method),
        ),
      csrfTokenFor: (request, candidate) =>
        sameAccount(candidate)
          ? runtime.mutationSession.issue(request, identity, appOrigin)
          : Promise.resolve(null),
      now: runtime.now,
      createOperationId: (operation) =>
        randomOperationId(`participant-profile-${operation}`),
    });
  } catch {
    return null;
  }
}

async function runtimeParticipantRegistrationRoute(
  runtime: ApplicationRuntimeDeploymentCapability,
  actor: AuthenticatedActor | null,
  isOwner: boolean,
  resourceUrl: string,
  pathname: string,
): Promise<ParticipantRegistrationRouteDependencies | null> {
  if (
    (pathname !== PARTICIPANT_REGISTRATION_PATH &&
      pathname !== PARTICIPANT_HOME_PATH) ||
    actor === null ||
    isOwner
  ) {
    return null;
  }

  const account = parseParticipantAccount({
    subject: actor.userId,
    accountEmailLabel: actor.email,
  });
  if (!account.ok) return null;

  try {
    const repositories = runtime.repositoryFactory;
    const currentCampaign = await repositories.campaignRepository().readSetup();
    if (currentCampaign === null) return null;
    const newRegistrationAllowed =
      currentCampaign.setup.publicCampaign.published === true &&
      currentCampaign.setup.publicCampaign.status === "open";
    if (pathname === PARTICIPANT_HOME_PATH && !newRegistrationAllowed) {
      return null;
    }
    const noticeEvidence = createParticipantRegistrationNoticeEvidence(
      currentCampaign.revision,
      participantRegistrationNoticesFromCampaignPolicy(
        currentCampaign.setup.campaignPolicy,
      ),
    );
    const appOrigin = new URL(resourceUrl).origin;
    const identity = Object.freeze({
      type: "participant" as const,
      subject: account.value.subject,
    });
    const sameAccount = (candidate: typeof account.value) =>
      candidate.subject === account.value.subject &&
      candidate.accountEmailLabel === account.value.accountEmailLabel;

    return Object.freeze({
      repositoryFor(candidate) {
        if (!sameAccount(candidate)) {
          throw new Error("Participant registration is unavailable.");
        }
        return repositories.participantRepository(account.value);
      },
      verifyMutation: (request, validateBeforeReplayClaim) =>
        runtime.mutationSession.verifyMutation(
          request,
          identity,
          appOrigin,
          {
            maxBodyBytes: MAX_REGISTRATION_MUTATION_BYTES,
            maxFields: MAX_REGISTRATION_MUTATION_FIELDS,
            repeatedFormFields: [],
            validateBeforeReplayClaim,
          },
        ),
      csrfTokenFor: (request, candidate) =>
        sameAccount(candidate)
          ? runtime.mutationSession.issue(request, identity, appOrigin)
          : Promise.resolve(null),
      newRegistrationAllowed,
      noticeEvidence,
      now: runtime.now,
      createOperationId: () => randomOperationId("participant-operation"),
    });
  } catch {
    return null;
  }
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
    participantAccess.accountStatus !== "active"
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
      .participantFounderApplications(contributionAreaChoices);
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

async function runtimeParticipantInvestmentInterestRoute(
  runtime: ApplicationRuntimeDeploymentCapability | null,
  actor: AuthenticatedActor | null,
  isOwner: boolean,
  participantAccess: AuthorizedParticipantAccess | null,
  resourceUrl: string,
  pathname: string,
  participantRequest: ParticipantRequestRepositoryScope | null,
): Promise<InvestmentInterestRouteDependencies | null> {
  const investmentResource = pathname === INVESTMENT_INTEREST_PATH ||
    pathname.startsWith(`${INVESTMENT_INTEREST_PATH}/`);
  if (
    runtime === null ||
    (pathname !== "/participant" && !investmentResource)
  ) {
    return null;
  }
  const unavailableRoute = investmentResource
    ? unavailableInvestmentInterestRoute()
    : null;
  if (
    actor === null ||
    isOwner ||
    participantAccess === null ||
    participantAccess.subject !== actor.userId ||
    participantAccess.accountStatus !== "active" ||
    (participantAccess.declaredInterest !== "investor" &&
      participantAccess.declaredInterest !== "both")
  ) {
    return unavailableRoute;
  }

  const account = parseParticipantAccount({
    subject: actor.userId,
    accountEmailLabel: actor.email,
  });
  if (
    !account.ok ||
    participantAccess.email !== account.value.accountEmailLabel
  ) {
    return unavailableRoute;
  }

  try {
    const repositories = runtime.repositoryFactory;
    const campaign = await repositories.campaignRepository().readSetup();
    if (campaign === null) return unavailableRoute;
    const amountConfiguration = campaign.setup.amountAggregate.amount;
    const participantScope = requiredParticipantRequest(participantRequest);
    const participant = participantScope.participantProfileRepository();
    const acknowledgments = participantScope.participantPackageAcknowledgments(
      account.value.subject,
    );
    const interests = repositories.participantInvestmentRepository(
      account.value.subject,
      amountConfiguration,
    );
    const appOrigin = new URL(resourceUrl).origin;
    const identity = Object.freeze({
      type: "participant" as const,
      subject: account.value.subject,
    });

    return Object.freeze({
      serviceFor(candidateSubject) {
        if (candidateSubject !== account.value.subject) {
          throw new Error("Investment interests are unavailable.");
        }
        return createParticipantInvestmentInterestService({
          actorSubject: account.value.subject,
          amountConfiguration,
          reader: interests,
          mutations: interests,
          loadAcknowledgmentContext: () =>
            loadInvestmentAcknowledgmentContext(
              acknowledgments,
              account.value.subject,
            ),
          loadPermissions: () => investmentInterestPermissions(
            repositories,
            participant,
            account.value.subject,
            campaign.revision,
            amountConfiguration,
          ),
          indicationIdForOperation: investmentIndicationIdForOperation,
          now: runtime.now,
        });
      },
      verifyMutation: (request, limits) =>
        runtime.mutationSession.verifyMutation(
          request,
          identity,
          appOrigin,
          limits,
        ),
      csrfTokenFor: (request, candidateSubject) =>
        candidateSubject === account.value.subject
          ? runtime.mutationSession.issue(request, identity, appOrigin)
          : Promise.resolve(null),
      createOperationId: () => randomOperationId("investment-operation"),
    });
  } catch {
    return unavailableRoute;
  }
}

function unavailableInvestmentInterestRoute(): InvestmentInterestRouteDependencies {
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

async function loadInvestmentAcknowledgmentContext(
  repositories: ParticipantPackageAcknowledgmentRepositories,
  subject: ActorSubject,
): Promise<TrustedPackageAcknowledgmentContext | null> {
  const first = await repositories.packages.current();
  if (first === null) return null;
  const latest = await repositories.acknowledgments.latest();
  const second = await repositories.packages.current();
  if (
    second === null ||
    first.revision !== second.revision ||
    first.snapshot.id !== second.snapshot.id ||
    first.snapshot.contentHash !== second.snapshot.contentHash ||
    first.snapshot.requiredAcceptanceHash !==
      second.snapshot.requiredAcceptanceHash ||
    (latest !== null && latest.snapshot.participantSubject !== subject)
  ) {
    throw new StorageFailure("PRECONDITION_FAILED");
  }
  return Object.freeze({
    currentVersion: second.snapshot,
    latestAcceptance: latest?.snapshot ?? null,
  });
}

async function investmentInterestPermissions(
  repositories: ApplicationRuntimeDeploymentCapability["repositoryFactory"],
  participant: Pick<ParticipantRepository, "current">,
  subject: ActorSubject,
  expectedCampaignRevision: number,
  expectedAmountConfiguration: AmountConfiguration,
): Promise<InvestmentInterestPermissions> {
  const [campaign, currentParticipant] = await Promise.all([
    repositories.campaignRepository().readSetup(),
    participant.current(),
  ]);
  const permitted = campaign !== null &&
    campaign.revision === expectedCampaignRevision &&
    sameAmountConfiguration(
      campaign.setup.amountAggregate.amount,
      expectedAmountConfiguration,
    ) &&
    currentParticipant !== null &&
    profilePermitsInvestor(currentParticipant.snapshot, subject) &&
    campaign.setup.publicCampaign.published === true &&
    campaign.setup.publicCampaign.status === "open" &&
    campaign.setup.phases.some((phase) => {
      const result = isPhaseAcceptingParticipation(
        phase,
        "investor",
        currentParticipant.snapshot.country,
      );
      return result.ok && result.value;
    });
  return Object.freeze({
    createPersonal: permitted,
    createCompany: permitted,
    reactivatePersonal: permitted,
    reactivateCompany: permitted,
  });
}

function profilePermitsInvestor(
  profile: Readonly<{
    subject: ActorSubject;
    declaredInterest: string;
    accountDeletionRequest: Readonly<{ state: string }>;
  }>,
  subject: ActorSubject,
): boolean {
  return profile.subject === subject &&
    profile.accountDeletionRequest.state === "not-requested" &&
    (profile.declaredInterest === "investor" ||
      profile.declaredInterest === "both");
}

function sameAmountConfiguration(
  left: AmountConfiguration,
  right: AmountConfiguration,
): boolean {
  return left.currency === right.currency &&
    left.minimum === right.minimum &&
    left.increment === right.increment &&
    left.maximum === right.maximum;
}

function investmentIndicationIdForOperation(
  operationId: StorageOperationId,
): InvestmentIndicationId {
  const parsed = parseStableId<"investment-indication">(operationId);
  if (!parsed.ok) throw new StorageFailure("UNAVAILABLE");
  return parsed.value;
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

function runtimeOwnerAuditHistory(
  runtime: ApplicationRuntimeDeploymentCapability | null,
): OwnerAuditHistoryRouteDependencies | undefined {
  if (runtime === null) return undefined;
  try {
    return Object.freeze({
      audit: runtime.repositoryFactory.ownerAuditEvents(),
    });
  } catch {
    return undefined;
  }
}

function runtimeOwnerFounderReview(
  runtime: ApplicationRuntimeDeploymentCapability | null,
): FounderApplicationReviewCollectionRepository | undefined {
  if (runtime === null) return undefined;
  try {
    return runtime.repositoryFactory.ownerFounderApplicationReviews();
  } catch {
    return undefined;
  }
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
  publicAggregate: PublishedPublicCampaignState["aggregate"],
  capabilities: Readonly<{
    ownerPackageWorkspace: boolean;
    ownerIndicationModeration: boolean;
    ownerReviewExports: boolean;
    ownerAuditHistory: boolean;
    ownerFounderReview: boolean;
    participantFounderInterest: boolean;
    participantInvestmentInterests: boolean;
    participantProfileSelfService: boolean;
    ownerCampaignEditor: boolean;
    ownerCampaignSetup: boolean;
    ownerAittadbConnection: boolean;
  }>,
  preview: RuntimeCampaignPreview | null,
): Request {
  return withRuntimeCampaignPreview(
    withRuntimeCapabilities(
      withRuntimeParticipantAccess(
        withRuntimePublicAggregate(
          withRuntimeCampaign(
            withRuntimeOwner(
              withAppOrigin(request, env.APP_BASE_URL),
              preview === null ? env.OWNER_EMAIL : undefined,
            ),
            campaign === null ? undefined : JSON.stringify(campaign),
          ),
          publicAggregate,
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

function resolvePublicCampaignStateReader(
  dependencies: ApplicationWorkerDependencies,
  runtime: ApplicationRuntimeDeploymentCapability | null,
): PublicCampaignStateReader | undefined {
  if (dependencies.publicCampaignStateReader !== undefined) {
    return dependencies.publicCampaignStateReader;
  }
  if (
    runtime === null ||
    dependencies.publicCampaignReader !== undefined ||
    dependencies.campaignWorkspace !== undefined ||
    dependencies.resolveCampaignWorkspace !== undefined
  ) {
    return undefined;
  }
  try {
    return runtime.repositoryFactory.publicCampaignStateReader();
  } catch {
    return undefined;
  }
}

async function resolvePublicCampaignState(
  stateReader: PublicCampaignStateReader | undefined,
  campaignReader: PublicCampaignPresentationReader | undefined,
  bootstrapConfiguration: string | undefined,
): Promise<PublishedPublicCampaignState | null> {
  if (stateReader !== undefined) {
    try {
      return await stateReader.readPublishedState();
    } catch {
      return null;
    }
  }
  const campaign = await resolvePublicCampaign(
    campaignReader,
    bootstrapConfiguration,
  );
  return campaign === null
    ? null
    : Object.freeze({ campaign, aggregate: null });
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

type ParticipantAccessResolution =
  | Readonly<{ kind: "authorized"; access: AuthorizedParticipantAccess }>
  | Readonly<{ kind: "missing" | "unavailable"; access: null }>;

async function resolveParticipantAccess(
  actor: AuthenticatedActor | null,
  reader: ParticipantAccessStateReader | undefined,
): Promise<ParticipantAccessResolution> {
  if (actor === null || reader === undefined) {
    return Object.freeze({ kind: "unavailable", access: null });
  }

  const account = parseParticipantAccount({
    subject: actor.userId,
    accountEmailLabel: actor.email,
  });
  if (!account.ok) {
    return Object.freeze({ kind: "unavailable", access: null });
  }

  try {
    const state = await reader.read(account.value);
    if (state === null) {
      return Object.freeze({ kind: "missing", access: null });
    }
    const access = authorizeParticipantAccess(account.value, state);
    return access === null
      ? Object.freeze({ kind: "unavailable", access: null })
      : Object.freeze({ kind: "authorized", access });
  } catch {
    return Object.freeze({ kind: "unavailable", access: null });
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
  return pathname !== PARTICIPANT_REGISTRATION_PATH &&
    (pathname === "/" ||
    pathname === "/participant" ||
    pathname.startsWith("/participant/"));
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
