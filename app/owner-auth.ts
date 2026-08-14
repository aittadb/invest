import { headers } from "next/headers";
import { notFound } from "next/navigation";

import {
  getChatGPTUser,
  requireChatGPTUser,
  type ChatGPTUser,
} from "./chatgpt-auth";
import { isConfiguredOwner } from "../domain/owner-identity";
import { OWNER_EMAIL_HEADER } from "../http/runtime-owner";

export async function getOwnerUser(): Promise<ChatGPTUser | null> {
  const user = await getChatGPTUser();
  if (!user) return null;

  const requestHeaders = await headers();
  return isConfiguredOwner(user.email, requestHeaders.get(OWNER_EMAIL_HEADER))
    ? user
    : null;
}

export async function requireOwnerUser(returnTo: string): Promise<ChatGPTUser> {
  const user = await requireChatGPTUser(returnTo);
  const requestHeaders = await headers();

  if (!isConfiguredOwner(user.email, requestHeaders.get(OWNER_EMAIL_HEADER))) {
    notFound();
  }

  return user;
}
