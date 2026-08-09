/** Cloudflare Worker entry point for the Investor App Sites build. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

import {
  createPublicCampaignDocument,
  INVESTOR_APP_API_VERSION,
  INVESTOR_APP_MEDIA_TYPE,
} from "../domain/public-campaign-resource";
import { parsePublicCampaignConfiguration } from "../domain/public-campaign-configuration";
import {
  createOwnerAuthenticationRequiredDocument,
  createOwnerHomeDocument,
} from "../domain/owner-home-resource";
import { isConfiguredOwner } from "../domain/owner-identity";
import { withAppOrigin } from "../http/app-origin";
import { negotiateRepresentation } from "../http/content-negotiation";
import { withRuntimeCampaign } from "../http/runtime-campaign";
import { withRuntimeOwner } from "../http/runtime-owner";

interface Env {
  APP_BASE_URL?: string;
  CAMPAIGN_CONFIG_JSON?: string;
  OWNER_EMAIL?: string;
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const actor = authenticatedActor(request);
    const isOwner = isConfiguredOwner(actor?.email, env.OWNER_EMAIL);
    const campaign = parsePublicCampaignConfiguration(env.CAMPAIGN_CONFIG_JSON);

    if (request.method === "GET" && url.pathname === "/") {
      const representation = negotiateRepresentation(request.headers.get("accept"));

      if (representation.kind === "hypermedia-json") {
        return hypermediaResponse(
          createPublicCampaignDocument(request.url, campaign, {
            manageCampaign: isOwner,
          }),
        );
      }

      if (representation.kind === "not-acceptable") {
        return notAcceptableResponse(request.url);
      }

      const htmlResponse = await handler.fetch(
        withRuntimeConfiguration(request, env),
        env,
        ctx,
      );
      return withAcceptVary(htmlResponse);
    }

    if (request.method === "GET" && url.pathname === "/owner") {
      const representation = negotiateRepresentation(request.headers.get("accept"));

      if (representation.kind === "not-acceptable") {
        return notAcceptableResponse(request.url);
      }

      if (representation.kind === "hypermedia-json") {
        if (!actor) {
          return hypermediaResponse(
            createOwnerAuthenticationRequiredDocument(request.url),
            401,
          );
        }

        if (!isOwner) {
          return resourceNotFoundResponse(request.url);
        }

        return hypermediaResponse(
          createOwnerHomeDocument(request.url, actor, campaign),
        );
      }

      const htmlResponse = await handler.fetch(
        withRuntimeConfiguration(request, env),
        env,
        ctx,
      );
      return withAcceptVary(htmlResponse);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(withRuntimeConfiguration(request, env), env, ctx);
  },
};

function hypermediaResponse(document: unknown, status = 200): Response {
  return new Response(JSON.stringify(document), {
    status,
    headers: representationHeaders(),
  });
}

function resourceNotFoundResponse(requestUrl: string): Response {
  return hypermediaResponse(
    {
      api_version: INVESTOR_APP_API_VERSION,
      type: "error",
      id: "not-found",
      data: {
        code: "not_found",
        message: "The requested resource was not found.",
      },
      links: [{ rel: ["self"], href: new URL(requestUrl).href }],
      actions: [],
    },
    404,
  );
}

function notAcceptableResponse(requestUrl: string): Response {
  return new Response(
    JSON.stringify({
      api_version: INVESTOR_APP_API_VERSION,
      type: "error",
      id: "not-acceptable",
      data: {
        code: "not_acceptable",
        message: "The requested representation is not available.",
      },
      links: [{ rel: ["self"], href: new URL(requestUrl).href }],
      actions: [],
    }),
    {
      status: 406,
      headers: representationHeaders(),
    },
  );
}

function representationHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Type": `${INVESTOR_APP_MEDIA_TYPE}; version=${INVESTOR_APP_API_VERSION}; charset=utf-8`,
    "Investor-App-API-Version": INVESTOR_APP_API_VERSION,
    Vary: "Accept",
  });
}

function withAcceptVary(response: Response): Response {
  const headers = new Headers(response.headers);
  const vary = new Set(
    (headers.get("vary") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  vary.add("Accept");
  headers.set("Vary", [...vary].join(", "));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withRuntimeConfiguration(request: Request, env: Env): Request {
  return withRuntimeCampaign(
    withRuntimeOwner(withAppOrigin(request, env.APP_BASE_URL), env.OWNER_EMAIL),
    env.CAMPAIGN_CONFIG_JSON,
  );
}

function authenticatedActor(
  request: Request,
): Readonly<{ userId: string; email: string; displayName: string }> | null {
  const userId = request.headers.get("oai-authenticated-user-id")?.trim();
  const email = request.headers.get("oai-authenticated-user-email")?.trim();

  if (!userId || !email) return null;

  return {
    userId,
    email,
    displayName: email,
  };
}

export default worker;
