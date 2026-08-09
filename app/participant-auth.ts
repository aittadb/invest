import { headers } from "next/headers";
import { notFound } from "next/navigation";

import {
  participantAccessFromRuntimeHeader,
  PARTICIPANT_ACCESS_HEADER,
} from "@/http/runtime-participant";
import type { AuthorizedParticipantAccess } from "@/domain/participant-home-resource";
import {
  getChatGPTUser,
  requireChatGPTUser,
  type ChatGPTUser,
} from "./chatgpt-auth";

export async function getParticipantAccess(): Promise<
  AuthorizedParticipantAccess | null
> {
  const user = await getChatGPTUser();
  if (user === null) return null;
  return participantAccessForUser(user);
}

export async function requireParticipantAccess(
  returnTo: string,
): Promise<AuthorizedParticipantAccess> {
  const user = await requireChatGPTUser(returnTo);
  const participant = await participantAccessForUser(user);
  if (participant === null) notFound();
  return participant;
}

async function participantAccessForUser(
  user: ChatGPTUser,
): Promise<AuthorizedParticipantAccess | null> {
  const requestHeaders = await headers();
  const participant = participantAccessFromRuntimeHeader(
    requestHeaders.get(PARTICIPANT_ACCESS_HEADER),
  );

  return participant?.subject === user.userId.trim() ? participant : null;
}
