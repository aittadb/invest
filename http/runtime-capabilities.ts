export const OWNER_PACKAGE_WORKSPACE_HEADER =
  "x-investor-app-owner-package-workspace";
export const OWNER_INDICATION_MODERATION_HEADER =
  "x-investor-app-owner-indication-moderation";
export const OWNER_REVIEW_EXPORTS_HEADER =
  "x-investor-app-owner-review-exports";
export const PARTICIPANT_FOUNDER_INTEREST_HEADER =
  "x-investor-app-participant-founder-interest";
export const PARTICIPANT_INVESTMENT_INTERESTS_HEADER =
  "x-investor-app-participant-investment-interests";
export const OWNER_AITTADB_CONNECTION_HEADER =
  "x-investor-app-owner-aittadb-connection";
export const OWNER_CAMPAIGN_EDITOR_CAPABILITY_HEADER =
  "x-investor-app-owner-campaign-editor";
export const OWNER_CAMPAIGN_SETUP_CAPABILITY_HEADER =
  "x-investor-app-owner-campaign-setup";

export function withRuntimeCapabilities(
  request: Request,
  capabilities: Readonly<{
    ownerPackageWorkspace: boolean;
    ownerCampaignEditor?: boolean;
    ownerCampaignSetup?: boolean;
    ownerIndicationModeration?: boolean;
    ownerReviewExports?: boolean;
    participantFounderInterest?: boolean;
    participantInvestmentInterests?: boolean;
    ownerAittadbConnection?: boolean;
  }>,
): Request {
  const headers = new Headers(request.headers);
  headers.delete(OWNER_PACKAGE_WORKSPACE_HEADER);
  headers.delete(OWNER_INDICATION_MODERATION_HEADER);
  headers.delete(OWNER_REVIEW_EXPORTS_HEADER);
  headers.delete(PARTICIPANT_FOUNDER_INTEREST_HEADER);
  headers.delete(PARTICIPANT_INVESTMENT_INTERESTS_HEADER);
  headers.delete(OWNER_AITTADB_CONNECTION_HEADER);
  headers.delete(OWNER_CAMPAIGN_EDITOR_CAPABILITY_HEADER);
  headers.delete(OWNER_CAMPAIGN_SETUP_CAPABILITY_HEADER);
  if (capabilities.ownerPackageWorkspace) {
    headers.set(OWNER_PACKAGE_WORKSPACE_HEADER, "available");
  }
  if (capabilities.ownerIndicationModeration) {
    headers.set(OWNER_INDICATION_MODERATION_HEADER, "available");
  }
  if (capabilities.ownerReviewExports) {
    headers.set(OWNER_REVIEW_EXPORTS_HEADER, "available");
  }
  if (capabilities.participantFounderInterest) {
    headers.set(PARTICIPANT_FOUNDER_INTEREST_HEADER, "available");
  }
  if (capabilities.participantInvestmentInterests) {
    headers.set(PARTICIPANT_INVESTMENT_INTERESTS_HEADER, "available");
  }
  if (capabilities.ownerAittadbConnection) {
    headers.set(OWNER_AITTADB_CONNECTION_HEADER, "available");
  }
  if (capabilities.ownerCampaignEditor) {
    headers.set(OWNER_CAMPAIGN_EDITOR_CAPABILITY_HEADER, "available");
  }
  if (capabilities.ownerCampaignSetup) {
    headers.set(OWNER_CAMPAIGN_SETUP_CAPABILITY_HEADER, "available");
  }
  return new Request(request, { headers });
}

export function hasOwnerPackageWorkspace(value: string | null): boolean {
  return value === "available";
}

export function hasOwnerIndicationModeration(value: string | null): boolean {
  return value === "available";
}

export function hasOwnerCampaignEditorCapability(
  value: string | null | undefined,
): boolean {
  return value === "available";
}

export function hasOwnerCampaignSetupCapability(
  value: string | null | undefined,
): boolean {
  return value === "available";
}

export function hasOwnerReviewExports(value: string | null): boolean {
  return value === "available";
}

export function hasParticipantFounderInterest(value: string | null): boolean {
  return value === "available";
}

export function hasParticipantInvestmentInterests(
  value: string | null,
): boolean {
  return value === "available";
}

export function hasOwnerAittaDBConnection(value: string | null): boolean {
  return value === "available";
}
