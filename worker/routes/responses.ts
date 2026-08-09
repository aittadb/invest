import {
  INVESTOR_APP_API_VERSION,
  INVESTOR_APP_MEDIA_TYPE,
} from "../../domain/public-campaign-resource.ts";

export function hypermediaResponse(document: unknown, status = 200): Response {
  return new Response(JSON.stringify(document), {
    status,
    headers: representationHeaders(),
  });
}

export function resourceNotFoundResponse(requestUrl: string): Response {
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

export function notAcceptableResponse(requestUrl: string): Response {
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

export function withAcceptVary(response: Response): Response {
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

function representationHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Type": `${INVESTOR_APP_MEDIA_TYPE}; version=${INVESTOR_APP_API_VERSION}; charset=utf-8`,
    "Investor-App-API-Version": INVESTOR_APP_API_VERSION,
    Vary: "Accept",
  });
}
