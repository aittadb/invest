import {
  createParticipantAuthenticationRequiredDocument,
  createParticipantHomeDocument,
  createPrivatePackageDocument,
  type ParticipantHomeCapabilities,
} from "../../domain/participant-home-resource.ts";
import {
  PARTICIPANT_HOME_PATH,
  PRIVATE_PACKAGE_PATH,
} from "../../domain/participant-navigation.ts";
import { negotiateRepresentation } from "../../http/content-negotiation.ts";
import type { ApplicationRouteHandler } from "../contracts.ts";
import {
  hypermediaResponse,
  notAcceptableResponse,
  resourceNotFoundResponse,
  withAcceptVary,
} from "./responses.ts";

export type ParticipantRouteCapabilities = Omit<
  ParticipantHomeCapabilities,
  "manageCampaign"
>;

export function createParticipantHomeRouteHandler(
  capabilities: ParticipantRouteCapabilities = {},
): ApplicationRouteHandler {
  return async (context) => {
    if (
      context.request.method !== "GET" ||
      context.url.pathname !== PARTICIPANT_HOME_PATH &&
        context.url.pathname !== PRIVATE_PACKAGE_PATH
    ) {
      return null;
    }

    const representation = negotiateRepresentation(
      context.request.headers.get("accept"),
    );

    if (representation.kind === "not-acceptable") {
      return notAcceptableResponse(context.resourceUrl);
    }

    if (representation.kind === "hypermedia-json") {
      if (!context.actor) {
        return hypermediaResponse(
          createParticipantAuthenticationRequiredDocument(
            context.resourceUrl,
            context.url.pathname,
          ),
          401,
        );
      }

      if (!context.participantAccess) {
        return resourceNotFoundResponse(context.resourceUrl);
      }

      if (context.url.pathname === PRIVATE_PACKAGE_PATH) {
        const document = createPrivatePackageDocument(
          context.resourceUrl,
          context.participantAccess,
          { ...capabilities, manageCampaign: context.isOwner },
        );
        return document === null
          ? resourceNotFoundResponse(context.resourceUrl)
          : hypermediaResponse(document);
      }

      return hypermediaResponse(createParticipantHomeDocument(
        context.resourceUrl,
        context.participantAccess,
        context.campaign?.name ?? null,
        { ...capabilities, manageCampaign: context.isOwner },
      ));
    }

    return withAcceptVary(await context.renderApplication());
  };
}

export const handleParticipantHomeRoutes =
  createParticipantHomeRouteHandler();
