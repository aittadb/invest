export const OWNER_PACKAGE_WORKSPACE_HEADER =
  "x-investor-app-owner-package-workspace";
export const OWNER_INDICATION_MODERATION_HEADER =
  "x-investor-app-owner-indication-moderation";

export function withRuntimeCapabilities(
  request: Request,
  capabilities: Readonly<{
    ownerPackageWorkspace: boolean;
    ownerIndicationModeration?: boolean;
  }>,
): Request {
  const headers = new Headers(request.headers);
  headers.delete(OWNER_PACKAGE_WORKSPACE_HEADER);
  headers.delete(OWNER_INDICATION_MODERATION_HEADER);
  if (capabilities.ownerPackageWorkspace) {
    headers.set(OWNER_PACKAGE_WORKSPACE_HEADER, "available");
  }
  if (capabilities.ownerIndicationModeration) {
    headers.set(OWNER_INDICATION_MODERATION_HEADER, "available");
  }
  return new Request(request, { headers });
}

export function hasOwnerPackageWorkspace(value: string | null): boolean {
  return value === "available";
}

export function hasOwnerIndicationModeration(value: string | null): boolean {
  return value === "available";
}
