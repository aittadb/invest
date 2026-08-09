/** Cloudflare Worker entry point for the Investor App Sites build. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

import {
  createPublicCampaignDocument,
  INVESTOR_APP_API_VERSION,
  INVESTOR_APP_MEDIA_TYPE,
} from "../domain/public-campaign-resource";
import { withAppOrigin } from "../http/app-origin";
import { negotiateRepresentation } from "../http/content-negotiation";

interface Env {
  APP_BASE_URL?: string;
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

    if (request.method === "GET" && url.pathname === "/") {
      const representation = negotiateRepresentation(request.headers.get("accept"));

      if (representation.kind === "hypermedia-json") {
        return hypermediaResponse(createPublicCampaignDocument(request.url));
      }

      if (representation.kind === "not-acceptable") {
        return notAcceptableResponse(request.url);
      }

      const htmlResponse = await handler.fetch(
        withAppOrigin(request, env.APP_BASE_URL),
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

    return handler.fetch(withAppOrigin(request, env.APP_BASE_URL), env, ctx);
  },
};

function hypermediaResponse(document: unknown): Response {
  return new Response(JSON.stringify(document), {
    status: 200,
    headers: representationHeaders(),
  });
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

export default worker;
