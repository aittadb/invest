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
  MAX_REGISTRATION_MUTATION_BYTES,
  MAX_REGISTRATION_MUTATION_FIELDS,
  type ParticipantRegistrationMutationVerifier,
  type ParticipantRegistrationRouteDependencies,
} from "./participant-registration.ts";

export {
  createParticipantProfileRouteHandler,
  MAX_PROFILE_DELETE_MUTATION_BYTES,
  MAX_PROFILE_DELETE_MUTATION_FIELDS,
  MAX_PROFILE_PATCH_MUTATION_BYTES,
  MAX_PROFILE_PATCH_MUTATION_FIELDS,
  MAX_PROFILE_POST_MUTATION_BYTES,
  MAX_PROFILE_POST_MUTATION_FIELDS,
  participantProfileMutationLimits,
  type ParticipantProfileMutationVerifier,
  type ParticipantProfileRouteDependencies,
} from "./participant-profile.ts";

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
