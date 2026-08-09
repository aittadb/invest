export const OWNER_PACKAGE_WORKSPACE_HEADER =
  "x-investor-app-owner-package-workspace";
export const OWNER_INDICATION_MODERATION_HEADER =
  "x-investor-app-owner-indication-moderation";
export const PARTICIPANT_FOUNDER_INTEREST_HEADER =
  "x-investor-app-participant-founder-interest";
export const PARTICIPANT_INVESTMENT_INTERESTS_HEADER =
  "x-investor-app-participant-investment-interests";

export function withRuntimeCapabilities(
  request: Request,
  capabilities: Readonly<{
    ownerPackageWorkspace: boolean;
    ownerIndicationModeration?: boolean;
    participantFounderInterest?: boolean;
    participantInvestmentInterests?: boolean;
  }>,
): Request {
  const headers = new Headers(request.headers);
  headers.delete(OWNER_PACKAGE_WORKSPACE_HEADER);
  headers.delete(OWNER_INDICATION_MODERATION_HEADER);
  headers.delete(PARTICIPANT_FOUNDER_INTEREST_HEADER);
  headers.delete(PARTICIPANT_INVESTMENT_INTERESTS_HEADER);
  if (capabilities.ownerPackageWorkspace) {
    headers.set(OWNER_PACKAGE_WORKSPACE_HEADER, "available");
  }
  if (capabilities.ownerIndicationModeration) {
    headers.set(OWNER_INDICATION_MODERATION_HEADER, "available");
  }
  if (capabilities.participantFounderInterest) {
    headers.set(PARTICIPANT_FOUNDER_INTEREST_HEADER, "available");
  }
  if (capabilities.participantInvestmentInterests) {
    headers.set(PARTICIPANT_INVESTMENT_INTERESTS_HEADER, "available");
  }
  return new Request(request, { headers });
}

export function hasOwnerPackageWorkspace(value: string | null): boolean {
  return value === "available";
}

export function hasOwnerIndicationModeration(value: string | null): boolean {
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
