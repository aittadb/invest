export const OWNER_PACKAGE_WORKSPACE_HEADER =
  "x-investor-app-owner-package-workspace";

export function withRuntimeCapabilities(
  request: Request,
  capabilities: Readonly<{ ownerPackageWorkspace: boolean }>,
): Request {
  const headers = new Headers(request.headers);
  headers.delete(OWNER_PACKAGE_WORKSPACE_HEADER);
  if (capabilities.ownerPackageWorkspace) {
    headers.set(OWNER_PACKAGE_WORKSPACE_HEADER, "available");
  }
  return new Request(request, { headers });
}

export function hasOwnerPackageWorkspace(value: string | null): boolean {
  return value === "available";
}
