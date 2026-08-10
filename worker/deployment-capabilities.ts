import type { DeploymentPublicationReadinessCheck } from "../domain/campaign-publication-readiness.ts";
import type {
  BrowserMutationReplayClaimer,
  BrowserMutationSession,
} from "../http/browser-mutation-session.ts";
import type {
  AtomicCampaignAuditRepository,
  PublicCampaignPresentationReader,
} from "../repositories/in-memory-campaign-repository.ts";
import type { ParticipantAccount } from "../domain/participant-profile.ts";
import type { ParticipantRequestRepositoryScope } from "../repositories/storage-application-repository-factory.ts";
import type { OwnerCampaignEditorRepository } from "../services/owner-campaign-editor.ts";
import type { OwnerPackageWorkspaceService } from "../services/owner-package-workspace.ts";

export type CampaignWorkspaceOperationKind =
  | "setup"
  | "save"
  | "publish"
  | "unpublish";

export type ApplicationRepositoryFactory = Readonly<{
  browserMutationReplayClaimer(): BrowserMutationReplayClaimer;
  campaignRepository(): AtomicCampaignAuditRepository;
  publicCampaignReader(): PublicCampaignPresentationReader;
  ownerPackageWorkspace(): OwnerPackageWorkspaceService;
  participantRequest(
    account: ParticipantAccount,
  ): ParticipantRequestRepositoryScope;
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
