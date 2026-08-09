import assert from "node:assert/strict";
import test from "node:test";

import type {
  ApplicationRouteContext,
  ApplicationRouteHandler,
  InvestorAppEnv,
  WorkerExecutionContext,
} from "../worker/contracts.ts";
import { createApplicationWorker } from "../worker/application-worker.ts";
import { createApplicationRouteDispatcher } from "../worker/routes/application.ts";
import { handleOwnerRoutes } from "../worker/routes/owner.ts";
import { createParticipantRouteHandler } from "../worker/routes/participant.ts";
import { handlePublicRoutes } from "../worker/routes/public.ts";
import { APP_ORIGIN_HEADER } from "../http/app-origin.ts";
import {
  campaignFromRuntimeHeader,
  CAMPAIGN_CONFIGURATION_HEADER,
} from "../http/runtime-campaign.ts";
import { OWNER_EMAIL_HEADER } from "../http/runtime-owner.ts";
import { syntheticPublicCampaign } from "./fixtures/public-campaign.ts";

const executionContext: WorkerExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

test("application composition keeps public, participant, and owner handlers isolated", async () => {
  const calls: string[] = [];
  const publicHandler = recordingHandler("public", calls, "/");
  const participantHandler = createParticipantRouteHandler([
    recordingHandler("participant", calls, "/participant/profile"),
  ]);
  const ownerHandler = recordingHandler("owner", calls, "/owner");
  const dispatch = createApplicationRouteDispatcher({
    public: publicHandler,
    participant: participantHandler,
    owner: ownerHandler,
  });

  const participantResponse = requiredResponse(
    await dispatch(routeContext("https://campaign.example/participant/profile")),
  );
  assert.equal(await participantResponse.text(), "participant");
  assert.deepEqual(calls, ["public", "participant"]);

  calls.length = 0;
  const ownerResponse = requiredResponse(
    await dispatch(routeContext("https://campaign.example/owner")),
  );
  assert.equal(await ownerResponse.text(), "owner");
  assert.deepEqual(calls, ["public", "participant", "owner"]);

  calls.length = 0;
  const publicResponse = requiredResponse(
    await dispatch(routeContext("https://campaign.example/")),
  );
  assert.equal(await publicResponse.text(), "public");
  assert.deepEqual(calls, ["public"]);
});

test("public routes preserve root negotiation and HTML Vary behavior", async () => {
  let renderCount = 0;
  const jsonResponse = requiredResponse(
    await handlePublicRoutes(
      routeContext("https://campaign.example/", {
        requestHeaders: { accept: "application/json" },
        renderApplication: async () => {
          renderCount += 1;
          return new Response("html");
        },
      }),
    ),
  );

  assert.equal(jsonResponse.status, 200);
  assert.equal(jsonResponse.headers.get("investor-app-api-version"), "0.1");
  assert.equal((await jsonResponse.json()).type, "investment-pre-registration");
  assert.equal(renderCount, 0);

  const unsupportedResponse = requiredResponse(
    await handlePublicRoutes(
      routeContext("https://campaign.example/", {
        requestHeaders: {
          accept: "application/vnd.aittadb-invest+json; version=9.0",
        },
      }),
    ),
  );
  assert.equal(unsupportedResponse.status, 406);
  assert.equal((await unsupportedResponse.json()).data.code, "not_acceptable");

  const htmlResponse = requiredResponse(
    await handlePublicRoutes(
      routeContext("https://campaign.example/", {
        requestHeaders: { accept: "text/html" },
        renderApplication: async () =>
          new Response("html", { headers: { Vary: "Origin" } }),
      }),
    ),
  );
  assert.equal(await htmlResponse.text(), "html");
  assert.equal(htmlResponse.headers.get("vary"), "Origin, Accept");

  const nonRoot = await handlePublicRoutes(
    routeContext("https://campaign.example/about"),
  );
  assert.equal(nonRoot, null);
});

test("owner routes preserve authentication, authorization, and representation behavior", async () => {
  const anonymous = requiredResponse(
    await handleOwnerRoutes(
      routeContext("https://campaign.example/owner", {
        requestHeaders: { accept: "application/json" },
      }),
    ),
  );
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).data.code, "authentication_required");

  const foreign = requiredResponse(
    await handleOwnerRoutes(
      routeContext("https://campaign.example/owner", {
        requestHeaders: { accept: "application/json" },
        actor: {
          userId: "foreign-subject",
          email: "foreign@example.com",
          displayName: "foreign@example.com",
        },
      }),
    ),
  );
  assert.equal(foreign.status, 404);
  assert.equal((await foreign.json()).data.code, "not_found");

  const owner = requiredResponse(
    await handleOwnerRoutes(
      routeContext("https://campaign.example/owner", {
        requestHeaders: { accept: "application/json" },
        actor: {
          userId: "owner-subject",
          email: "owner@example.com",
          displayName: "owner@example.com",
        },
        isOwner: true,
      }),
    ),
  );
  assert.equal(owner.status, 200);
  assert.equal((await owner.json()).type, "owner-home");

  const unsupported = requiredResponse(
    await handleOwnerRoutes(
      routeContext("https://campaign.example/owner", {
        requestHeaders: {
          accept: "application/vnd.aittadb-invest+json; version=9.0",
        },
      }),
    ),
  );
  assert.equal(unsupported.status, 406);

  const html = requiredResponse(
    await handleOwnerRoutes(
      routeContext("https://campaign.example/owner", {
        requestHeaders: { accept: "text/html" },
        renderApplication: async () =>
          new Response("owner html", { headers: { Vary: "Origin" } }),
      }),
    ),
  );
  assert.equal(await html.text(), "owner html");
  assert.equal(html.headers.get("vary"), "Origin, Accept");
});

test("the Worker keeps image dispatch separate from application fallback", async () => {
  const applicationRequests: Request[] = [];
  const imageRequests: Request[] = [];
  const worker = createApplicationWorker({
    fetchApplication: async (request) => {
      applicationRequests.push(request);
      return new Response("application fallback", { status: 418 });
    },
    fetchOptimizedImage: async (request) => {
      imageRequests.push(request);
      return new Response("optimized image", { status: 202 });
    },
  });
  const env = testEnvironment();

  const imageResponse = await worker.fetch(
    new Request("https://campaign.example/_vinext/image?url=%2Fhero.jpg&w=640&q=75"),
    env,
    executionContext,
  );
  assert.equal(imageResponse.status, 202);
  assert.equal(await imageResponse.text(), "optimized image");
  assert.equal(imageRequests.length, 1);
  assert.equal(applicationRequests.length, 0);

  const fallbackResponse = await worker.fetch(
    new Request("https://campaign.example/not-a-special-resource"),
    env,
    executionContext,
  );
  assert.equal(fallbackResponse.status, 418);
  assert.equal(await fallbackResponse.text(), "application fallback");
  assert.equal(applicationRequests.length, 1);
});

test("application rendering receives the same normalized runtime headers", async () => {
  const renderedRequests: Request[] = [];
  const worker = createApplicationWorker({
    fetchApplication: async (request) => {
      renderedRequests.push(request);
      return new Response("rendered");
    },
    fetchOptimizedImage: async () => new Response("image"),
  });
  const env = testEnvironment({
    APP_BASE_URL: "https://invest.example.com",
    OWNER_EMAIL: " OWNER@Example.COM ",
    CAMPAIGN_CONFIG_JSON: JSON.stringify(syntheticPublicCampaign),
  });

  const response = await worker.fetch(
    new Request("https://sites-host.example/fallback"),
    env,
    executionContext,
  );
  assert.equal(await response.text(), "rendered");
  assert.equal(renderedRequests.length, 1);
  const renderedRequest = renderedRequests[0];
  assert.equal(
    renderedRequest.headers.get(APP_ORIGIN_HEADER),
    "https://invest.example.com",
  );
  assert.equal(
    renderedRequest.headers.get(OWNER_EMAIL_HEADER),
    "owner@example.com",
  );
  assert.deepEqual(
    campaignFromRuntimeHeader(
      renderedRequest.headers.get(CAMPAIGN_CONFIGURATION_HEADER),
    ),
    syntheticPublicCampaign,
  );
});

function routeContext(
  url: string,
  overrides: Readonly<{
    requestHeaders?: HeadersInit;
    actor?: ApplicationRouteContext["actor"];
    isOwner?: boolean;
    renderApplication?: () => Promise<Response>;
  }> = {},
): ApplicationRouteContext {
  return {
    request: new Request(url, { headers: overrides.requestHeaders }),
    url: new URL(url),
    actor: overrides.actor ?? null,
    isOwner: overrides.isOwner ?? false,
    campaign: syntheticPublicCampaign,
    renderApplication:
      overrides.renderApplication ?? (async () => new Response("html")),
  };
}

function recordingHandler(
  name: string,
  calls: string[],
  matchingPath: string,
): ApplicationRouteHandler {
  return async ({ url }) => {
    calls.push(name);
    return url.pathname === matchingPath ? new Response(name) : null;
  };
}

function requiredResponse(response: Response | null): Response {
  assert.ok(response);
  return response;
}

function testEnvironment(
  overrides: Partial<InvestorAppEnv> = {},
): InvestorAppEnv {
  return {
    ASSETS: {
      fetch: async () => new Response("asset"),
    },
    IMAGES: {
      input() {
        throw new Error("The injected image handler owns this test boundary.");
      },
    },
    ...overrides,
  };
}
