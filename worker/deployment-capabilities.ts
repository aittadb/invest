import type { DeploymentPublicationReadinessCheck } from "../domain/campaign-publication-readiness.ts";
import type {
  BrowserMutationReplayClaimer,
  BrowserMutationSession,
} from "../http/browser-mutation-session.ts";
import type {
  AtomicCampaignAuditRepository,
  CampaignSetupRevision,
  PublicCampaignPresentationReader,
} from "../repositories/in-memory-campaign-repository.ts";
import type { ActorSubject } from "../domain/foundation.ts";
import type { AmountConfiguration } from "../domain/amount-aggregate-configuration.ts";
import type { InvestmentIndicationParsingOptions } from "../domain/investment-indication.ts";
import type { ParticipantAccount } from "../domain/participant-profile.ts";
import type { ParticipantRequestRepositoryScope } from "../repositories/storage-application-repository-factory.ts";
import type { ParticipantRegistrationRepository } from "../repositories/in-memory-participant-repository.ts";
import type { FounderApplicationReviewCollectionRepository } from "../repositories/in-memory-founder-application-repository.ts";
import type { OwnerCampaignEditorRepository } from "../services/owner-campaign-editor.ts";
import type { OwnerPackageWorkspaceService } from "../services/owner-package-workspace.ts";
import type {
  AtomicManualNotificationActivityRepository,
  AuditEventReader,
} from "../repositories/in-memory-audit-notification-repositories.ts";
import type { PublicCampaignStateReader } from "../repositories/storage-public-campaign-state-reader.ts";
import type { CampaignRevisionBoundAggregateCorrectionRepository } from "../repositories/in-memory-aggregate-repository.ts";
import type {
  AtomicParticipantInvestmentInterestMutationPort,
  ParticipantInvestmentInterestReader,
} from "./participant-investment-mutation-port.ts";

export type CampaignWorkspaceOperationKind =
  | "setup"
  | "save"
  | "publish"
  | "unpublish";

export type ApplicationRepositoryFactory = Readonly<{
  browserMutationReplayClaimer(): BrowserMutationReplayClaimer;
  campaignRepository(): AtomicCampaignAuditRepository;
  publicCampaignReader(): PublicCampaignPresentationReader;
  publicCampaignStateReader(): PublicCampaignStateReader;
  ownerPackageWorkspace(): OwnerPackageWorkspaceService;
  ownerAuditEvents(): AuditEventReader;
  ownerFounderApplicationReviews(): FounderApplicationReviewCollectionRepository;
  ownerManualNotificationActivity(): AtomicManualNotificationActivityRepository;
  ownerAggregateReconciliation(
    ownerSubject: ActorSubject,
    campaign: CampaignSetupRevision,
  ): CampaignRevisionBoundAggregateCorrectionRepository;
  participantRequest(
    account: ParticipantAccount,
  ): ParticipantRequestRepositoryScope;
  participantInvestmentRepository(
    participantSubject: ActorSubject,
    amountConfiguration: AmountConfiguration,
    parsingOptions?: InvestmentIndicationParsingOptions,
  ): ParticipantInvestmentInterestReader &
    AtomicParticipantInvestmentInterestMutationPort;
  participantRepository(
    account: ParticipantAccount,
  ): ParticipantRegistrationRepository;
}>;

/** Backend-only deployment capability; it contains no serializable credential. */
export type ApplicationRuntimeDeploymentCapability = Readonly<{
  repositoryFactory: ApplicationRepositoryFactory;
  mutationSession: BrowserMutationSession;
  publicationReady: boolean;
  now(): Date;
}>;

/** Trusted, deployment-injected capabilities for one configured campaign. */
export type CampaignWorkspaceDeploymentCapability = Readonly<{
  repository: OwnerCampaignEditorRepository;
  publicReader: PublicCampaignPresentationReader;
  checkPublicationReadiness: DeploymentPublicationReadinessCheck;
  mutationSession: BrowserMutationSession;
  appOrigin: string;
  issueOperationId?: (kind: CampaignWorkspaceOperationKind) => string;
  now?: () => Date;
}>;
