import type { DeploymentPublicationReadinessCheck } from "../domain/campaign-publication-readiness.ts";
import type {
  BrowserMutationReplayClaimer,
  BrowserMutationSession,
} from "../http/browser-mutation-session.ts";
import type { BrowserMutationGuard } from "../http/mutation-security.ts";
import type { PublicCampaignPresentationReader } from "../repositories/in-memory-campaign-repository.ts";
import type { OwnerCampaignEditorRepository } from "../services/owner-campaign-editor.ts";

export type CampaignWorkspaceOperationKind = "save" | "publish" | "unpublish";

export type ApplicationRepositoryFactory = Readonly<{
  browserMutationReplayClaimer(): BrowserMutationReplayClaimer;
}>;

/** Backend-only deployment capability; it contains no serializable credential. */
export type ApplicationRuntimeDeploymentCapability = Readonly<{
  repositoryFactory: ApplicationRepositoryFactory;
  mutationSession: BrowserMutationSession;
}>;

/** Trusted, deployment-injected capabilities for one configured campaign. */
export type CampaignWorkspaceDeploymentCapability = Readonly<{
  repository: OwnerCampaignEditorRepository;
  publicReader: PublicCampaignPresentationReader;
  checkPublicationReadiness: DeploymentPublicationReadinessCheck;
  guardMutation: BrowserMutationGuard;
  csrfToken(request: Request): Promise<string>;
  issueOperationId?: (kind: CampaignWorkspaceOperationKind) => string;
  now?: () => Date;
}>;
