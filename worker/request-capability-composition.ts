import type {
  FounderApplicationReviewCollectionRepository,
  FounderApplicationReviewDetailRepository,
  FounderApplicationReviewListRequest,
  FounderApplicationReviewRepository,
} from "../repositories/in-memory-founder-application-repository.ts";
import type { CampaignWorkspaceDeploymentCapability } from "./deployment-capabilities.ts";
import type { ApplicationRouteHandler } from "./contracts.ts";
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
  createOwnerAuditNotificationHistoryRouteHandler,
  type OwnerAuditHistoryRouteDependencies,
  type OwnerAuditNotificationRouteDependencies,
} from "./routes/owner-audit-notification-history.ts";
import { createOwnerCampaignEditorRouteHandler } from "./routes/owner-campaign-editor.ts";
import {
  createOwnerFounderReviewCollectionRouteHandler,
  createOwnerFounderReviewDetailRouteHandler,
  createOwnerFounderReviewRouteHandler,
} from "./routes/owner-founder-review.ts";
import { createOwnerInitialSetupRouteHandler } from "./routes/owner-initial-setup.ts";
import { createOwnerRouteHandler } from "./routes/owner.ts";
import {
  createOwnerAggregateReconciliationRouteHandler,
  type OwnerAggregateReconciliationRouteOptions,
} from "./routes/owner-aggregate-reconciliation.ts";
import {
  createOwnerPackageRouteHandler,
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
  type FounderInterestRouteDependencies,
  type InvestmentInterestRouteDependencies,
  type ParticipantPackageAcknowledgmentRouteDependencies,
  type ParticipantPackageReaderDependencies,
  type ParticipantProfileRouteDependencies,
  type ParticipantRegistrationRouteDependencies,
} from "./routes/participant.ts";
import {
  createOwnerOAuthProofRouteHandler,
  type OwnerOAuthProofRouteDependencies,
} from "./routes/owner-oauth-proof.ts";
import {
  createOwnerReviewExportRouteHandler,
  type OwnerReviewExportRouteDependencies,
} from "./routes/owner-review-exports.ts";
import { handlePublicRoutes } from "./routes/public.ts";

/** The exact availability projection consumed by the React runtime boundary. */
export type RuntimeCapabilityProjection = Readonly<{
  ownerPackageWorkspace: boolean;
  ownerIndicationModeration: boolean;
  ownerReviewExports: boolean;
  ownerAuditHistory: boolean;
  ownerFounderReview: boolean;
  ownerNotificationHistory: boolean;
  ownerAggregateReconciliation: boolean;
  participantFounderInterest: boolean;
  participantInvestmentInterests: boolean;
  participantProfileSelfService: boolean;
  ownerCampaignEditor: boolean;
  ownerCampaignSetup: boolean;
  ownerAittadbConnection: boolean;
}>;

const unavailableRuntimeCapabilities: RuntimeCapabilityProjection = Object.freeze({
  ownerPackageWorkspace: false,
  ownerIndicationModeration: false,
  ownerReviewExports: false,
  ownerAuditHistory: false,
  ownerFounderReview: false,
  ownerNotificationHistory: false,
  ownerAggregateReconciliation: false,
  participantFounderInterest: false,
  participantInvestmentInterests: false,
  participantProfileSelfService: false,
  ownerCampaignEditor: false,
  ownerCampaignSetup: false,
  ownerAittadbConnection: false,
});

export function unavailableRequestRuntimeCapabilities(): RuntimeCapabilityProjection {
  return unavailableRuntimeCapabilities;
}

export type RequestPackageRoutes = Readonly<{
  owner?: OwnerPackageRouteDependencies;
  participantReader?: ParticipantPackageReaderDependencies;
  participantAcknowledgment?: ParticipantPackageAcknowledgmentRouteDependencies;
}>;

export type RequestCapabilityCompositionInput = Readonly<{
  injectedRoute?: ApplicationRouteHandler;
  ownerPackage?: OwnerPackageRouteDependencies;
  ownerIndicationModeration?: OwnerIndicationModerationRouteDependencies;
  ownerReviewExports?: OwnerReviewExportRouteDependencies;
  ownerAuditHistory?: OwnerAuditHistoryRouteDependencies;
  ownerFounderReview?: FounderApplicationReviewCollectionRepository;
  ownerFounderReviewDetail?: FounderApplicationReviewDetailRepository;
  ownerAuditNotificationHistory?: OwnerAuditNotificationRouteDependencies;
  ownerAggregateReconciliation?: OwnerAggregateReconciliationRouteOptions;
  participantRegistration: ParticipantRegistrationRouteDependencies | null;
  participantProfile: ParticipantProfileRouteDependencies | null;
  participantFounderInterest: FounderInterestRouteDependencies | null;
  participantInvestmentInterests: InvestmentInterestRouteDependencies | null;
  ownerOAuthProof: OwnerOAuthProofRouteDependencies | null;
  campaignWorkspace: CampaignWorkspaceDeploymentCapability | null;
  packageRoutes: RequestPackageRoutes;
  isOwner: boolean;
}>;

/**
 * Binds one request's already-authorized route dependencies to both dispatch
 * and renderer-visible availability. No dependency is inferred from headers.
 */
export type RequestCapabilityComposition = Readonly<{
  dispatchRoute: ApplicationRouteHandler;
  runtimeCapabilities: RuntimeCapabilityProjection;
}>;

export function composeRequestCapabilities(
  input: RequestCapabilityCompositionInput,
): RequestCapabilityComposition {
  if (input.injectedRoute !== undefined) {
    return Object.freeze({
      dispatchRoute: input.injectedRoute,
      runtimeCapabilities: unavailableRuntimeCapabilities,
    });
  }
  const availability = routeAvailability(input);
  const hasInjectedRoutes = Object.values(availability).some(Boolean) ||
    input.ownerFounderReviewDetail !== undefined ||
    input.ownerAggregateReconciliation !== undefined ||
    input.packageRoutes.participantReader !== undefined ||
    input.packageRoutes.participantAcknowledgment !== undefined;
  const dispatchRoute = hasInjectedRoutes
    ? createInjectedRouteDispatcher(input, availability)
    : dispatchApplicationRoute;

  return Object.freeze({
    dispatchRoute,
    runtimeCapabilities: Object.freeze({
      ownerPackageWorkspace: availability.ownerPackageAvailable && input.isOwner,
      ownerIndicationModeration: availability.ownerIndicationModerationAvailable,
      ownerReviewExports: availability.ownerReviewExportsAvailable,
      ownerAuditHistory: availability.ownerAuditHistoryAvailable && input.isOwner,
      ownerFounderReview: availability.ownerFounderReviewAvailable && input.isOwner,
      ownerNotificationHistory:
        availability.ownerNotificationHistoryAvailable && input.isOwner,
      ownerAggregateReconciliation:
        availability.ownerAggregateReconciliationAvailable && input.isOwner,
      participantFounderInterest: availability.participantFounderInterestAvailable,
      participantInvestmentInterests:
        availability.participantInvestmentInterestsAvailable,
      participantProfileSelfService: availability.participantProfileAvailable,
      ownerCampaignEditor: availability.campaignEditorAvailable,
      ownerCampaignSetup: availability.campaignSetupAvailable,
      ownerAittadbConnection: availability.ownerOAuthProofAvailable,
    }),
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
  ownerNotificationHistoryAvailable: boolean;
  ownerAggregateReconciliationAvailable: boolean;
  participantFounderInterestAvailable: boolean;
  participantInvestmentInterestsAvailable: boolean;
  campaignEditorAvailable: boolean;
  campaignSetupAvailable: boolean;
  ownerOAuthProofAvailable: boolean;
}>;

function routeAvailability(
  input: RequestCapabilityCompositionInput,
): InjectedRouteAvailability {
  const ownerNotificationHistoryAvailable =
    input.ownerAuditNotificationHistory !== undefined;
  const ownerAuditHistoryAvailable = ownerNotificationHistoryAvailable ||
    input.ownerAuditHistory !== undefined;
  const campaignEditorAvailable = input.campaignWorkspace !== null;
  return Object.freeze({
    ownerPackageAvailable: input.ownerPackage !== undefined,
    participantRegistrationAvailable: input.participantRegistration !== null,
    participantProfileAvailable: input.participantProfile !== null,
    ownerIndicationModerationAvailable: input.ownerIndicationModeration !== undefined,
    ownerReviewExportsAvailable: input.ownerReviewExports !== undefined,
    ownerAuditHistoryAvailable,
    ownerFounderReviewAvailable: input.ownerFounderReview !== undefined,
    ownerNotificationHistoryAvailable,
    ownerAggregateReconciliationAvailable:
      input.ownerAggregateReconciliation?.repository.correctionConsistency ===
        "atomic-aggregate-audit",
    participantFounderInterestAvailable:
      input.participantFounderInterest !== null,
    participantInvestmentInterestsAvailable:
      input.participantInvestmentInterests !== null,
    campaignEditorAvailable,
    campaignSetupAvailable: campaignEditorAvailable,
    ownerOAuthProofAvailable: input.ownerOAuthProof !== null,
  });
}

function ownerFounderReviewRouteHandlers(
  collection: FounderApplicationReviewCollectionRepository | undefined,
  detail: FounderApplicationReviewDetailRepository | undefined,
): readonly ApplicationRouteHandler[] {
  if (collection !== undefined && detail !== undefined) {
    const repository: FounderApplicationReviewRepository = Object.freeze({
      list: (request: FounderApplicationReviewListRequest) => collection.list(request),
      get: (reviewId: unknown) => detail.get(reviewId),
    });
    return Object.freeze([createOwnerFounderReviewRouteHandler(repository)]);
  }
  if (collection !== undefined) {
    return Object.freeze([createOwnerFounderReviewCollectionRouteHandler(collection)]);
  }
  if (detail !== undefined) {
    return Object.freeze([createOwnerFounderReviewDetailRouteHandler(detail)]);
  }
  return Object.freeze([]);
}

function createInjectedRouteDispatcher(
  input: RequestCapabilityCompositionInput,
  available: InjectedRouteAvailability,
): ApplicationRouteHandler {
  const { campaignWorkspace, packageRoutes } = input;
  const issueCampaignOperationId = campaignWorkspace?.issueOperationId;
  return createApplicationRouteDispatcher({
    public: handlePublicRoutes,
    participant: createParticipantRouteHandler(
      [
        ...(input.participantRegistration ? [createParticipantRegistrationRouteHandler(input.participantRegistration)] : []),
        ...(input.participantProfile ? [createParticipantProfileRouteHandler(input.participantProfile)] : []),
        ...(packageRoutes.participantReader ? [createParticipantPackageReaderRouteHandler(packageRoutes.participantReader)] : []),
        ...(packageRoutes.participantAcknowledgment ? [createParticipantPackageAcknowledgmentRouteHandler(packageRoutes.participantAcknowledgment)] : []),
        ...(input.participantFounderInterest ? [createFounderInterestRouteHandler(input.participantFounderInterest)] : []),
        ...(input.participantInvestmentInterests ? [createInvestmentInterestRouteHandler(input.participantInvestmentInterests)] : []),
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
        ...(packageRoutes.owner ? [createOwnerPackageRouteHandler(packageRoutes.owner)] : []),
        ...(input.ownerIndicationModeration ? [createOwnerIndicationModerationRouteHandler(input.ownerIndicationModeration)] : []),
        ...(input.ownerReviewExports ? [createOwnerReviewExportRouteHandler(input.ownerReviewExports)] : []),
        ...(input.ownerAuditNotificationHistory ? [createOwnerAuditNotificationHistoryRouteHandler(input.ownerAuditNotificationHistory)] : input.ownerAuditHistory ? [createOwnerAuditHistoryRouteHandler(input.ownerAuditHistory)] : []),
        ...ownerFounderReviewRouteHandlers(
          input.ownerFounderReview,
          input.ownerFounderReviewDetail,
        ),
        ...(input.ownerAggregateReconciliation ? [createOwnerAggregateReconciliationRouteHandler(input.ownerAggregateReconciliation)] : []),
        ...(campaignWorkspace ? [
          createOwnerInitialSetupRouteHandler({
            repository: campaignWorkspace.repository,
            checkPublicationReadiness: campaignWorkspace.checkPublicationReadiness,
            mutationSession: campaignWorkspace.mutationSession,
            appOrigin: campaignWorkspace.appOrigin,
            ...(issueCampaignOperationId ? {
              issueOperationId: () => issueCampaignOperationId("setup"),
            } : {}),
            ...(campaignWorkspace.now ? { now: campaignWorkspace.now } : {}),
          }),
          createOwnerCampaignEditorRouteHandler(campaignWorkspace),
        ] : []),
        ...(input.ownerOAuthProof ? [createOwnerOAuthProofRouteHandler(input.ownerOAuthProof)] : []),
      ],
      {
        managePackage: available.ownerPackageAvailable,
        indicationModeration: available.ownerIndicationModerationAvailable,
        reviewExports: available.ownerReviewExportsAvailable,
        auditHistory: available.ownerAuditHistoryAvailable,
        founderApplicationReview: available.ownerFounderReviewAvailable,
        auditNotificationHistory: available.ownerNotificationHistoryAvailable,
        aggregateReconciliation: available.ownerAggregateReconciliationAvailable,
        campaignEditor: available.campaignEditorAvailable,
        campaignSetup: available.campaignSetupAvailable,
        aittadbConnection: available.ownerOAuthProofAvailable,
      },
    ),
  });
}
