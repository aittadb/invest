import type { DeploymentPublicationReadinessCheck } from "../domain/campaign-publication-readiness.ts";
import type { BrowserMutationGuard } from "../http/mutation-security.ts";
import type { PublicCampaignPresentationReader } from "../repositories/in-memory-campaign-repository.ts";
import type { OwnerCampaignEditorRepository } from "../services/owner-campaign-editor.ts";

export type CampaignWorkspaceOperationKind = "save" | "publish" | "unpublish";

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
