import { normalizeOwnerEmail } from "../domain/owner-identity.ts";

export const OWNER_EMAIL_HEADER = "x-investor-app-owner-email";

export function withRuntimeOwner(
  request: Request,
  configuredOwnerEmail?: string,
): Request {
  const headers = new Headers(request.headers);
  const ownerEmail = normalizeOwnerEmail(configuredOwnerEmail);

  if (ownerEmail) {
    headers.set(OWNER_EMAIL_HEADER, ownerEmail);
  } else {
    headers.delete(OWNER_EMAIL_HEADER);
  }

  return new Request(request, { headers });
}
