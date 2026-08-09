import type { ApplicationRouteHandler } from "../contracts.ts";
import { composeRouteHandlers } from "./compose.ts";

export function createParticipantRouteHandler(
  resourceHandlers: readonly ApplicationRouteHandler[] = [],
): ApplicationRouteHandler {
  return composeRouteHandlers(resourceHandlers);
}

export const handleParticipantRoutes = createParticipantRouteHandler();
