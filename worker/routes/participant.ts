import type { ApplicationRouteHandler } from "../contracts.ts";
import { composeRouteHandlers } from "./compose.ts";
import {
  createParticipantHomeRouteHandler,
  type ParticipantRouteCapabilities,
} from "./participant-home.ts";

export {
  createFounderInterestRouteHandler,
  MAX_FOUNDER_INTEREST_MUTATION_BYTES,
  MAX_FOUNDER_INTEREST_MUTATION_FIELDS,
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

export {
  createParticipantPackageReaderRouteHandler,
  type ParticipantPackageReaderDependencies,
} from "./participant-package-reader.ts";

export {
  createParticipantPackageAcknowledgmentRouteHandler,
  MAX_ACKNOWLEDGMENT_MUTATION_BYTES,
  MAX_ACKNOWLEDGMENT_MUTATION_FIELDS,
  type ParticipantPackageAcknowledgmentRouteDependencies,
} from "./participant-package-acknowledgment.ts";

export function createParticipantRouteHandler(
  resourceHandlers: readonly ApplicationRouteHandler[] = [],
  capabilities: ParticipantRouteCapabilities = {},
): ApplicationRouteHandler {
  return composeRouteHandlers([
    ...resourceHandlers,
    createParticipantHomeRouteHandler(capabilities),
  ]);
}

export const handleParticipantRoutes = createParticipantRouteHandler();
