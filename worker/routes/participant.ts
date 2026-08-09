import type { ApplicationRouteHandler } from "../contracts.ts";
import { composeRouteHandlers } from "./compose.ts";
import {
  createParticipantHomeRouteHandler,
  type ParticipantRouteCapabilities,
} from "./participant-home.ts";

export {
  createFounderInterestRouteHandler,
  type FounderInterestRouteDependencies,
} from "./founder-interest.ts";

export {
  createInvestmentInterestRouteHandler,
  type InvestmentInterestRouteDependencies,
} from "./investment-interest.ts";

export {
  createParticipantRegistrationRouteHandler,
  type ParticipantRegistrationRouteDependencies,
} from "./participant-registration.ts";

export function createParticipantRouteHandler(
  resourceHandlers: readonly ApplicationRouteHandler[] = [],
  capabilities: ParticipantRouteCapabilities = {},
): ApplicationRouteHandler {
  return composeRouteHandlers([
    createParticipantHomeRouteHandler(capabilities),
    ...resourceHandlers,
  ]);
}

export const handleParticipantRoutes = createParticipantRouteHandler();
