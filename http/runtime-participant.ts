import {
  parseAuthorizedParticipantAccess,
  type AuthorizedParticipantAccess,
} from "../domain/participant-home-resource.ts";

export const PARTICIPANT_ACCESS_HEADER = "x-investor-app-participant-access";
const MAX_SERIALIZED_ACCESS_LENGTH = 2_048;

export function participantAccessFromRuntimeHeader(
  value: string | null,
): AuthorizedParticipantAccess | null {
  if (value === null || value.length > MAX_SERIALIZED_ACCESS_LENGTH) return null;

  try {
    return parseAuthorizedParticipantAccess(JSON.parse(value));
  } catch {
    return null;
  }
}

/** Replaces any client value with the server-authorized renderer projection. */
export function withRuntimeParticipantAccess(
  request: Request,
  participant: AuthorizedParticipantAccess | null,
): Request {
  const headers = new Headers(request.headers);
  headers.delete(PARTICIPANT_ACCESS_HEADER);

  if (participant !== null) {
    const serialized = JSON.stringify(participant);
    if (serialized.length <= MAX_SERIALIZED_ACCESS_LENGTH) {
      headers.set(PARTICIPANT_ACCESS_HEADER, serialized);
    }
  }

  return new Request(request, { headers });
}
