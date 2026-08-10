import type { DeploymentPublicationReadinessCheck } from "../domain/campaign-publication-readiness.ts";
import type {
  BrowserMutationReplayClaimer,
  BrowserMutationSession,
} from "../http/browser-mutation-session.ts";
import type {
  AtomicCampaignAuditRepository,
  PublicCampaignPresentationReader,
} from "../repositories/in-memory-campaign-repository.ts";
import type { OwnerCampaignEditorRepository } from "../services/owner-campaign-editor.ts";

export type CampaignWorkspaceOperationKind =
  | "setup"
  | "save"
  | "publish"
  | "unpublish";

export type ApplicationRepositoryFactory = Readonly<{
  browserMutationReplayClaimer(): BrowserMutationReplayClaimer;
  campaignRepository(): AtomicCampaignAuditRepository;
  publicCampaignReader(): PublicCampaignPresentationReader;
}>;

/** Backend-only deployment capability; it contains no serializable credential. */
export type ApplicationRuntimeDeploymentCapability = Readonly<{
  repositoryFactory: ApplicationRepositoryFactory;
  mutationSession: BrowserMutationSession;
  publicationReady: boolean;
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
