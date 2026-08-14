import type { ApplicationRouteHandler } from "../contracts.ts";
import { composeRouteHandlers } from "./compose.ts";
import { handleOwnerRoutes } from "./owner.ts";
import { handleParticipantRoutes } from "./participant.ts";
import { handlePublicRoutes } from "./public.ts";

export type ApplicationRouteHandlers = Readonly<{
  public: ApplicationRouteHandler;
  participant: ApplicationRouteHandler;
  owner: ApplicationRouteHandler;
}>;

const defaultHandlers: ApplicationRouteHandlers = {
  public: handlePublicRoutes,
  participant: handleParticipantRoutes,
  owner: handleOwnerRoutes,
};

export function createApplicationRouteDispatcher(
  handlers: ApplicationRouteHandlers = defaultHandlers,
): ApplicationRouteHandler {
  return composeRouteHandlers([
    handlers.public,
    handlers.participant,
    handlers.owner,
  ]);
}

export const dispatchApplicationRoute = createApplicationRouteDispatcher();
