/** Cloudflare Worker entry point for the Investor App Sites build. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

import { createApplicationWorker } from "./application-worker.ts";
import type { ParticipantAccessStateReader } from "../domain/participant-home-resource.ts";
import type { PublicCampaignStateReader } from "../repositories/storage-public-campaign-state-reader.ts";
import { createHostedApplicationRuntimeResolver } from "./hosted-application-composition.ts";
import { createHostedOwnerOAuthProofResolver } from "./hosted-oauth-composition.ts";
import type {
  FounderInterestRouteDependencies,
  InvestmentInterestRouteDependencies,
  ParticipantProfileRouteDependencies,
} from "./routes/participant.ts";

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

export function createInvestorAppWorker(
  dependencies: Readonly<{
    participantAccessReader?: ParticipantAccessStateReader;
    participantProfile?: ParticipantProfileRouteDependencies;
    participantFounderInterest?: FounderInterestRouteDependencies;
    participantInvestmentInterests?: InvestmentInterestRouteDependencies;
    publicCampaignStateReader?: PublicCampaignStateReader;
  }> = {},
) {
  return createApplicationWorker({
    fetchApplication: (request, env, context) =>
      handler.fetch(request, env, context),
    fetchOptimizedImage: (request, env) => {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(
        request,
        {
          fetchAsset: (path) =>
            env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage: async (body, { width, format, quality }) => {
            const result = await env.IMAGES.input(body)
              .transform(width > 0 ? { width } : {})
              .output({ format, quality });
            return result.response();
          },
        },
        allowedWidths,
      );
    },
    participantAccessReader: dependencies.participantAccessReader,
    participantProfile: dependencies.participantProfile,
    participantFounderInterest: dependencies.participantFounderInterest,
    participantInvestmentInterests: dependencies.participantInvestmentInterests,
    publicCampaignStateReader: dependencies.publicCampaignStateReader,
    resolveApplicationRuntime: createHostedApplicationRuntimeResolver(),
    resolveOwnerOAuthProof: createHostedOwnerOAuthProofResolver(),
  });
}

export default createInvestorAppWorker();
