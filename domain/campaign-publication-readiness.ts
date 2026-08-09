import { checkPhaseSetup } from "./phase-configuration.ts";
import type { CampaignSetup } from "../repositories/in-memory-campaign-repository.ts";

export type CampaignPublicationReadinessBlocker =
  | "phase-setup-incomplete"
  | "deployment-not-ready";

export type CampaignPublicationReadiness = Readonly<{
  ready: boolean;
  blockers: readonly CampaignPublicationReadinessBlocker[];
}>;

/** Deployment-owned check for prerequisites outside the campaign setup record. */
export type DeploymentPublicationReadinessCheck = (
  setup: CampaignSetup,
) => boolean | Promise<boolean>;

export async function assessCampaignPublicationReadiness(
  setup: CampaignSetup,
  checkDeployment: DeploymentPublicationReadinessCheck,
): Promise<CampaignPublicationReadiness> {
  const blockers: CampaignPublicationReadinessBlocker[] = [];
  if (setup.phases.some((phase) => !checkPhaseSetup(phase).complete)) {
    blockers.push("phase-setup-incomplete");
  }
  let deploymentReady = false;
  try {
    deploymentReady = await checkDeployment(setup) === true;
  } catch {
    deploymentReady = false;
  }
  if (!deploymentReady) {
    blockers.push("deployment-not-ready");
  }
  return Object.freeze({
    ready: blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
}
