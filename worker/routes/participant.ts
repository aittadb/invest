import type { ApplicationRouteHandler } from "../contracts.ts";
import { composeRouteHandlers } from "./compose.ts";
import { handleParticipantHomeRoutes } from "./participant-home.ts";

export {
  createFounderInterestRouteHandler,
  type FounderInterestRouteDependencies,
} from "./founder-interest.ts";

export {
  createInvestmentInterestRouteHandler,
  type InvestmentInterestRouteDependencies,
} from "./investment-interest.ts";

export function createParticipantRouteHandler(
  resourceHandlers: readonly ApplicationRouteHandler[] = [
    handleParticipantHomeRoutes,
  ],
): ApplicationRouteHandler {
  return composeRouteHandlers(resourceHandlers);
}

export const handleParticipantRoutes = createParticipantRouteHandler();
