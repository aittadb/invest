import { createPublicCampaignDocument } from "../../domain/public-campaign-resource.ts";
import { negotiateRepresentation } from "../../http/content-negotiation.ts";
import type { ApplicationRouteHandler } from "../contracts.ts";
import {
  hypermediaResponse,
  notAcceptableResponse,
  withAcceptVary,
} from "./responses.ts";

export const handlePublicRoutes: ApplicationRouteHandler = async (context) => {
  if (context.request.method !== "GET" || context.url.pathname !== "/") {
    return null;
  }

  const representation = negotiateRepresentation(
    context.request.headers.get("accept"),
  );

  if (representation.kind === "hypermedia-json") {
    return hypermediaResponse(
      createPublicCampaignDocument(context.request.url, context.campaign, {
        manageCampaign: context.isOwner,
      }),
    );
  }

  if (representation.kind === "not-acceptable") {
    return notAcceptableResponse(context.request.url);
  }

  return withAcceptVary(await context.renderApplication());
};
