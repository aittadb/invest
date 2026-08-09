import {
  createOwnerAuthenticationRequiredDocument,
  createOwnerHomeDocument,
  type OwnerHomeCapabilities,
} from "../../domain/owner-home-resource.ts";
import { negotiateRepresentation } from "../../http/content-negotiation.ts";
import type { ApplicationRouteHandler } from "../contracts.ts";
import { composeRouteHandlers } from "./compose.ts";
import {
  hypermediaResponse,
  notAcceptableResponse,
  resourceNotFoundResponse,
  withAcceptVary,
} from "./responses.ts";

export function createOwnerHomeRouteHandler(
  capabilities: OwnerHomeCapabilities = {},
): ApplicationRouteHandler {
  return async (context) => {
    if (context.request.method !== "GET" || context.url.pathname !== "/owner") {
      return null;
    }

    const representation = negotiateRepresentation(
      context.request.headers.get("accept"),
    );

    if (representation.kind === "not-acceptable") {
      return notAcceptableResponse(context.request.url);
    }

    if (representation.kind === "hypermedia-json") {
      if (!context.actor) {
        return hypermediaResponse(
          createOwnerAuthenticationRequiredDocument(context.request.url),
          401,
        );
      }

      if (!context.isOwner) {
        return resourceNotFoundResponse(context.request.url);
      }

      return hypermediaResponse(
        createOwnerHomeDocument(
          context.request.url,
          context.actor,
          context.campaign,
          capabilities,
        ),
      );
    }

    return withAcceptVary(await context.renderApplication());
  };
}

export const handleOwnerHomeRoute = createOwnerHomeRouteHandler();

export function createOwnerRouteHandler(
  resourceHandlers: readonly ApplicationRouteHandler[] = [],
  homeCapabilities: OwnerHomeCapabilities = {},
): ApplicationRouteHandler {
  return composeRouteHandlers([
    createOwnerHomeRouteHandler(homeCapabilities),
    ...resourceHandlers,
  ]);
}

export const handleOwnerRoutes = createOwnerRouteHandler();
