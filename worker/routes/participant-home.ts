import {
  createParticipantAuthenticationRequiredDocument,
  createParticipantHomeDocument,
  createParticipantRegistrationRequiredDocument,
  createPrivatePackageDocument,
  type ParticipantHomeCapabilities,
} from "../../domain/participant-home-resource.ts";
import {
  PARTICIPANT_HOME_PATH,
  PRIVATE_PACKAGE_PATH,
} from "../../domain/participant-navigation.ts";
import { PARTICIPANT_REGISTRATION_PATH } from "../../domain/participant-registration-resource.ts";
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
> & Readonly<{ registration?: boolean }>;

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
        if (capabilities.registration && !context.isOwner) {
          return hypermediaResponse(
            createParticipantRegistrationRequiredDocument(context.resourceUrl),
          );
        }
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

    if (
      !context.participantAccess &&
      context.actor !== null &&
      !context.isOwner &&
      capabilities.registration
    ) {
      return withAcceptVary(new Response(null, {
        status: 303,
        headers: {
          "Cache-Control": "no-store",
          Location: new URL(
            PARTICIPANT_REGISTRATION_PATH,
            context.resourceUrl,
          ).href,
        },
      }));
    }

    return withAcceptVary(await context.renderApplication());
  };
}

export const handleParticipantHomeRoutes =
  createParticipantHomeRouteHandler();
