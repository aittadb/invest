import assert from "node:assert/strict";
import test from "node:test";

import type {
  ApplicationRouteContext,
  ApplicationRouteHandler,
  InvestorAppEnv,
  WorkerExecutionContext,
} from "../worker/contracts.ts";
import { createApplicationWorker } from "../worker/application-worker.ts";
import {
  composeRequestCapabilities,
  unavailableRequestRuntimeCapabilities,
} from "../worker/request-capability-composition.ts";
import type { OwnerPackageRouteDependencies } from "../worker/routes/owner-package.ts";
import type { OwnerAggregateReconciliationRouteOptions } from "../worker/routes/owner-aggregate-reconciliation.ts";
import { createApplicationRouteDispatcher } from "../worker/routes/application.ts";
import {
  createOwnerRouteHandler,
  handleOwnerRoutes,
} from "../worker/routes/owner.ts";
import { handleParticipantHomeRoutes } from "../worker/routes/participant-home.ts";
import { createParticipantRouteHandler } from "../worker/routes/participant.ts";
import { handlePublicRoutes } from "../worker/routes/public.ts";
import { APP_ORIGIN_HEADER } from "../http/app-origin.ts";
import { OWNER_PACKAGE_WORKSPACE_HEADER } from "../http/runtime-capabilities.ts";
import {
  campaignFromRuntimeHeader,
  CAMPAIGN_CONFIGURATION_HEADER,
} from "../http/runtime-campaign.ts";
import { OWNER_EMAIL_HEADER } from "../http/runtime-owner.ts";
import {
  participantAccessFromRuntimeHeader,
  PARTICIPANT_ACCESS_HEADER,
} from "../http/runtime-participant.ts";
import {
  publicAggregateFromRuntimeHeader,
  PUBLIC_AGGREGATE_HEADER,
} from "../http/runtime-public-aggregate.ts";
import type { SanitizedPublicInvestmentAggregate } from "../domain/investment-aggregate.ts";
import {
  authorizeParticipantAccess,
  type ParticipantAuthorizationState,
} from "../domain/participant-home-resource.ts";
import {
  parseStableId,
  parseTimestamp,
} from "../domain/foundation.ts";
import { parseParticipantAccount } from "../domain/participant-profile.ts";
import { syntheticPublicCampaign } from "./fixtures/public-campaign.ts";
import {
  parseCampaignSetup,
  type CampaignSetupRevision,
} from "../repositories/in-memory-campaign-repository.ts";
import {
  parseStorageOperationId,
  StorageFailure,
  type StorageAdapter,
} from "../domain/storage-adapter.ts";
import { StoragePublicCampaignStateReader } from "../repositories/storage-public-campaign-state-reader.ts";
import { explicitCampaignSetup } from "./support/campaign-repository-contract.ts";

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

test("public routes add only the authorized participant capabilities", async () => {
  const access = participantAccess("participant-subject", "participant@example.com");
  const response = requiredResponse(
    await handlePublicRoutes(
      routeContext("https://campaign.example/", {
        requestHeaders: { accept: "application/json" },
        actor: actor("participant-subject", "participant@example.com"),
        participantAccess: access,
      }),
    ),
  );
  const document = await response.json();
  assert.deepEqual(
    document.actions.map((action: { name: string }) => action.name),
    ["open-participant-home", "read-private-package"],
  );
  assert.ok(
    document.links.some((link: { rel: string[] }) =>
      link.rel.includes("participant-home")
    ),
  );
  assert.ok(
    document.links.some((link: { rel: string[] }) =>
      link.rel.includes("private-package")
    ),
  );

  const visitor = requiredResponse(
    await handlePublicRoutes(
      routeContext("https://campaign.example/", {
        requestHeaders: { accept: "application/json" },
      }),
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(await visitor.json()),
    /participant-home|private-package|participant@example\.com/u,
  );
});

test("participant resources preserve authentication, ownership, and negotiation", async () => {
  const anonymous = requiredResponse(
    await handleParticipantHomeRoutes(
      routeContext("https://campaign.example/participant", {
        requestHeaders: { accept: "application/json" },
      }),
    ),
  );
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).data.code, "authentication_required");

  const foreign = requiredResponse(
    await handleParticipantHomeRoutes(
      routeContext("https://campaign.example/participant", {
        requestHeaders: { accept: "application/json" },
        actor: actor("foreign-subject", "foreign@example.com"),
      }),
    ),
  );
  assert.equal(foreign.status, 404);
  assert.equal((await foreign.json()).data.code, "not_found");

  const access = participantAccess("participant-subject", "participant@example.com");
  const participant = requiredResponse(
    await handleParticipantHomeRoutes(
      routeContext("https://campaign.example/participant", {
        requestHeaders: { accept: "application/json" },
        actor: actor("participant-subject", "participant@example.com"),
        participantAccess: access,
      }),
    ),
  );
  assert.equal(participant.status, 200);
  const participantDocument = await participant.json();
  assert.equal(participantDocument.type, "participant-home");
  assert.equal(participantDocument.data.account_email, "participant@example.com");

  const privatePackage = requiredResponse(
    await handleParticipantHomeRoutes(
      routeContext("https://campaign.example/participant/package", {
        requestHeaders: { accept: "application/json" },
        actor: actor("participant-subject", "participant@example.com"),
        participantAccess: access,
      }),
    ),
  );
  assert.equal(privatePackage.status, 200);
  assert.equal((await privatePackage.json()).type, "private-package");

  const ownerParticipant = requiredResponse(
    await handleParticipantHomeRoutes(
      routeContext("https://campaign.example/participant", {
        requestHeaders: { accept: "application/json" },
        actor: actor("participant-subject", "participant@example.com"),
        participantAccess: access,
        isOwner: true,
      }),
    ),
  );
  assert.ok(
    (await ownerParticipant.json()).actions.some(
      (action: { name: string }) => action.name === "manage-campaign",
    ),
  );

  const unsupported = requiredResponse(
    await handleParticipantHomeRoutes(
      routeContext("https://campaign.example/participant", {
        requestHeaders: {
          accept: "application/vnd.aittadb-invest+json; version=9.0",
        },
      }),
    ),
  );
  assert.equal(unsupported.status, 406);

  const html = requiredResponse(
    await handleParticipantHomeRoutes(
      routeContext("https://campaign.example/participant", {
        requestHeaders: { accept: "text/html" },
        actor: actor("participant-subject", "participant@example.com"),
        participantAccess: access,
        renderApplication: async () =>
          new Response("participant html", { headers: { Vary: "Origin" } }),
      }),
    ),
  );
  assert.equal(await html.text(), "participant html");
  assert.equal(html.headers.get("vary"), "Origin, Accept");
});

test("participant route composition advertises only injected workflow handlers", async () => {
  const handler = createParticipantRouteHandler(
    [],
    {
      profileSelfService: true,
      founderInterest: true,
      investmentInterests: true,
    },
  );
  const response = requiredResponse(
    await handler(
      routeContext("https://campaign.example/participant", {
        requestHeaders: { accept: "application/json" },
        actor: actor("participant-subject", "participant@example.com"),
        participantAccess: participantAccess(
          "participant-subject",
          "participant@example.com",
        ),
      }),
    ),
  );
  const document = await response.json();
  assert.deepEqual(
    document.actions.map((action: { name: string }) => action.name),
    [
      "read-private-package",
      "open-participant-profile",
      "open-founder-interest",
      "open-investment-interests",
      "sign-out",
    ],
  );
});

test("participant entry negotiates registration for HTML and JSON", async () => {
  const handler = createParticipantRouteHandler([], { registration: true });
  const signedIn = actor("participant-subject", "participant@example.com");
  const json = requiredResponse(
    await handler(
      routeContext("https://campaign.example/participant", {
        requestHeaders: { accept: "application/json" },
        actor: signedIn,
      }),
    ),
  );
  assert.equal(json.status, 200);
  assert.equal(json.headers.get("vary"), "Accept");
  const document = await json.json();
  assert.equal(document.type, "participant-entry");
  assert.equal(document.data.status, "registration_required");
  assert.deepEqual(
    document.actions.map((action: { name: string }) => action.name),
    ["open-participant-registration"],
  );

  const html = requiredResponse(
    await handler(
      routeContext("https://campaign.example/participant", {
        requestHeaders: { accept: "text/html" },
        actor: signedIn,
      }),
    ),
  );
  assert.equal(html.status, 303);
  assert.equal(document.actions.length, 1);
  assert.equal(
    html.headers.get("location"),
    document.actions[0]?.href,
  );
  assert.equal(html.headers.get("cache-control"), "no-store");
  assert.equal(html.headers.get("vary"), "Accept");

  const owner = requiredResponse(
    await handler(
      routeContext("https://campaign.example/participant", {
        requestHeaders: { accept: "application/json" },
        actor: signedIn,
        isOwner: true,
      }),
    ),
  );
  assert.equal(owner.status, 404);

  const unavailable = requiredResponse(
    await handleParticipantHomeRoutes(
      routeContext("https://campaign.example/participant", {
        requestHeaders: { accept: "application/json" },
        actor: signedIn,
      }),
    ),
  );
  assert.equal(unavailable.status, 404);
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
  const ownerDocument = await owner.json() as {
    type: string;
    data: Record<string, unknown>;
  };
  assert.equal(ownerDocument.type, "owner-home");
  assert.deepEqual(Object.keys(ownerDocument.data).sort(), [
    "campaign_name",
    "publication",
    "setup_status",
  ]);

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

test("owner home advertises the injected AittaDB connection resource", async () => {
  const handler = createOwnerRouteHandler([], { aittadbConnection: true });
  const response = requiredResponse(await handler(
    routeContext("https://campaign.example/owner", {
      requestHeaders: { accept: "application/json" },
      actor: actor("owner-subject", "owner@example.com"),
      isOwner: true,
    }),
  ));
  const document = await response.json();
  assert.ok(document.links.some((link: { rel: string[]; href: string }) =>
    link.rel.includes("aittadb-connection") &&
    link.href === "https://campaign.example/owner/aittadb-connection"
  ));
  assert.ok(document.actions.some((action: { name: string }) =>
    action.name === "review-aittadb-connection"
  ));
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

test("request capability composition keeps an injected dispatcher ahead of route wiring", async () => {
  const composition = composeRequestCapabilities({
    injectedRoute: async () => new Response("injected"),
    participantRegistration: null,
    participantProfile: null,
    participantFounderInterest: null,
    participantInvestmentInterests: null,
    ownerOAuthProof: null,
    campaignWorkspace: null,
    packageRoutes: {},
    isOwner: false,
  });

  assert.deepEqual(
    composition.runtimeCapabilities,
    unavailableRequestRuntimeCapabilities(),
  );
  const response = requiredResponse(
    await composition.dispatchRoute(routeContext("https://campaign.example/owner")),
  );
  assert.equal(await response.text(), "injected");
});

test("request capability composition dispatches explicitly unavailable owner routes", async () => {
  const unavailableAggregate: OwnerAggregateReconciliationRouteOptions = {
    repository: {
      correctionConsistency: "unavailable",
      previewReconciliation: async () => {
        throw new Error("unavailable aggregate");
      },
    },
    guardMutation: async () => {
      throw new Error("unavailable aggregate");
    },
    csrfToken: async () => null,
  };
  const composition = composeRequestCapabilities({
    ownerAggregateReconciliation: unavailableAggregate,
    participantRegistration: null,
    participantProfile: null,
    participantFounderInterest: null,
    participantInvestmentInterests: null,
    ownerOAuthProof: null,
    campaignWorkspace: null,
    packageRoutes: {},
    isOwner: true,
  });

  assert.equal(
    composition.runtimeCapabilities.ownerAggregateReconciliation,
    false,
  );
  const response = requiredResponse(await composition.dispatchRoute(
    routeContext("https://campaign.example/owner/aggregate-reconciliation", {
      requestHeaders: { accept: "application/json" },
    }),
  ));
  assert.equal(response.status, 401);
});

test("request capability composition keeps owner rendering capability isolated by actor", async () => {
  const renderedRequests: Request[] = [];
  // This resource is not requested in this test; dispatch construction must not
  // make its opaque service available to a non-owner renderer.
  const ownerPackage = {} as unknown as OwnerPackageRouteDependencies;
  const worker = createApplicationWorker({
    fetchApplication: async (request) => {
      renderedRequests.push(request);
      return new Response("rendered");
    },
    fetchOptimizedImage: async () => new Response("image"),
    ownerPackage,
  });
  const env = testEnvironment({ OWNER_EMAIL: "owner@example.com" });

  const ownerHome = await worker.fetch(
    new Request("https://campaign.example/owner", {
      headers: {
        accept: "application/json",
        "oai-authenticated-user-id": "owner-subject",
        "oai-authenticated-user-email": "owner@example.com",
      },
    }),
    env,
    executionContext,
  );
  const ownerDocument = await ownerHome.json();
  assert.ok(ownerDocument.actions.some((action: { name: string }) =>
    action.name === "manage-information-package"
  ));

  await worker.fetch(
    new Request("https://campaign.example/fallback", {
      headers: {
        "oai-authenticated-user-id": "owner-subject",
        "oai-authenticated-user-email": "owner@example.com",
      },
    }),
    env,
    executionContext,
  );
  await worker.fetch(
    new Request("https://campaign.example/fallback", {
      headers: {
        "oai-authenticated-user-id": "participant-subject",
        "oai-authenticated-user-email": "participant@example.com",
      },
    }),
    env,
    executionContext,
  );

  assert.equal(
    renderedRequests[0]?.headers.get(OWNER_PACKAGE_WORKSPACE_HEADER),
    "available",
  );
  assert.equal(
    renderedRequests[1]?.headers.get(OWNER_PACKAGE_WORKSPACE_HEADER),
    null,
  );
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
  assert.equal(
    renderedRequest.headers.get(PARTICIPANT_ACCESS_HEADER),
    null,
  );
});

test("an injected public campaign reader controls the public resource and fails closed", async () => {
  let current = storedCampaignRevision(1, false, "Repository Campaign");
  let unavailable = false;
  const worker = createApplicationWorker({
    fetchApplication: async () => new Response("rendered"),
    fetchOptimizedImage: async () => new Response("image"),
    publicCampaignReader: {
      readPublishedCampaign: async () => {
        if (unavailable) throw new Error("private backend detail");
        return current.setup.publicCampaign.published
          ? current.setup.publicCampaign
          : null;
      },
    },
  });
  const env = testEnvironment({
    CAMPAIGN_CONFIG_JSON: JSON.stringify(syntheticPublicCampaign),
  });

  const draft = await worker.fetch(
    new Request("https://campaign.example/", {
      headers: { Accept: "application/json" },
    }),
    env,
    executionContext,
  );
  const draftDocument = await draft.json();
  assert.equal(draftDocument.data.published, false);
  assert.equal(draftDocument.data.name, null);

  current = storedCampaignRevision(2, true, "Repository Campaign");
  const published = await worker.fetch(
    new Request("https://campaign.example/", {
      headers: { Accept: "application/json" },
    }),
    env,
    executionContext,
  );
  const publishedDocument = await published.json();
  assert.equal(publishedDocument.data.published, true);
  assert.equal(publishedDocument.data.name, "Repository Campaign");

  unavailable = true;
  const failed = await worker.fetch(
    new Request("https://campaign.example/", {
      headers: { Accept: "application/json" },
    }),
    env,
    executionContext,
  );
  const failedDocument = await failed.json();
  assert.equal(failedDocument.data.published, false);
  assert.equal(failedDocument.data.name, null);
  assert.doesNotMatch(JSON.stringify(failedDocument), /Northstar|private backend/u);
});

test("public HTML and hypermedia share one sanitized aggregate projection", async () => {
  const rendered: Request[] = [];
  let unavailable = false;
  const aggregate = Object.freeze({
    amount: 12_500,
    currency: "EUR",
    label: "Indicated interest",
    qualifier: "Current self-declared interest.",
    oversubscription: null,
  }) as SanitizedPublicInvestmentAggregate;
  const worker = createApplicationWorker({
    fetchApplication: async (request) => {
      rendered.push(request);
      return new Response("rendered");
    },
    fetchOptimizedImage: async () => new Response("image"),
    publicCampaignStateReader: {
      readPublishedState: async () => {
        if (unavailable) throw new Error("private aggregate backend detail");
        return Object.freeze({
          campaign: syntheticPublicCampaign,
          aggregate,
        });
      },
    },
  });
  const env = testEnvironment();

  const json = await worker.fetch(
    new Request("https://campaign.example/", {
      headers: { Accept: "application/vnd.aittadb-invest+json; version=0.1" },
    }),
    env,
    executionContext,
  );
  assert.equal(json.status, 200);
  const document = await json.json();
  assert.deepEqual(document.data.aggregate_interest, {
    amount_minor_units: 12_500,
    currency: "EUR",
    label: "Indicated interest",
    qualifier: "Current self-declared interest.",
    verification: {
      self_declared: true,
      verified: false,
      binding: false,
    },
    oversubscription: null,
  });
  assert.doesNotMatch(
    JSON.stringify(document),
    /private-subject|company note|contributing_indication_count/iu,
  );

  const html = await worker.fetch(
    new Request("https://campaign.example/", {
      headers: {
        Accept: "text/html",
        [PUBLIC_AGGREGATE_HEADER]: btoa(JSON.stringify({
          participantSubject: "private-subject",
        })),
      },
    }),
    env,
    executionContext,
  );
  assert.equal(await html.text(), "rendered");
  assert.equal(rendered.length, 1);
  assert.deepEqual(
    publicAggregateFromRuntimeHeader(
      rendered[0]?.headers.get(PUBLIC_AGGREGATE_HEADER),
    ),
    aggregate,
  );
  assert.doesNotMatch(
    rendered[0]?.headers.get(PUBLIC_AGGREGATE_HEADER) ?? "",
    /private-subject/iu,
  );

  unavailable = true;
  const failed = await worker.fetch(
    new Request("https://campaign.example/", {
      headers: { Accept: "application/vnd.aittadb-invest+json; version=0.1" },
    }),
    env,
    executionContext,
  );
  const failedDocument = await failed.json();
  assert.equal(failedDocument.data.published, false);
  assert.equal(failedDocument.data.aggregate_interest, null);
  assert.doesNotMatch(
    JSON.stringify(failedDocument),
    /private aggregate backend detail|Indicated interest/iu,
  );
});

test("the Worker renders schema-4 published campaign state without an aggregate", async () => {
  const rendered: Request[] = [];
  const legacy = legacyPublicPresentationFixture(true);
  const worker = createApplicationWorker({
    fetchApplication: async (request) => {
      rendered.push(request);
      return new Response("rendered");
    },
    fetchOptimizedImage: async () => new Response("image"),
    publicCampaignStateReader: new StoragePublicCampaignStateReader(
      legacy.storage,
    ),
  });
  const env = testEnvironment();

  const json = await worker.fetch(
    new Request("https://campaign.example/", {
      headers: { accept: "application/json" },
    }),
    env,
    executionContext,
  );
  const document = await json.json();
  assert.equal(document.data.published, true);
  assert.equal(document.data.name, legacy.campaign.name);
  assert.equal(document.data.aggregate_interest, null);

  const html = await worker.fetch(
    new Request("https://campaign.example/", {
      headers: { accept: "text/html" },
    }),
    env,
    executionContext,
  );
  assert.equal(await html.text(), "rendered");
  assert.equal(rendered.length, 1);
  assert.deepEqual(
    campaignFromRuntimeHeader(
      rendered[0]?.headers.get(CAMPAIGN_CONFIGURATION_HEADER) ?? null,
    ),
    legacy.campaign,
  );
  assert.equal(rendered[0]?.headers.get(PUBLIC_AGGREGATE_HEADER), null);
  assert.equal(legacy.reads.aggregate, 0);
});

test("the Worker keeps schema-4 unpublished campaign state unavailable", async () => {
  const rendered: Request[] = [];
  const legacy = legacyPublicPresentationFixture(false);
  const worker = createApplicationWorker({
    fetchApplication: async (request) => {
      rendered.push(request);
      return new Response("rendered");
    },
    fetchOptimizedImage: async () => new Response("image"),
    publicCampaignStateReader: new StoragePublicCampaignStateReader(
      legacy.storage,
    ),
  });
  const env = testEnvironment();

  const json = await worker.fetch(
    new Request("https://campaign.example/", {
      headers: { accept: "application/json" },
    }),
    env,
    executionContext,
  );
  const document = await json.json();
  assert.equal(document.data.published, false);
  assert.equal(document.data.name, null);
  assert.equal(document.data.aggregate_interest, null);

  const html = await worker.fetch(
    new Request("https://campaign.example/", {
      headers: { accept: "text/html" },
    }),
    env,
    executionContext,
  );
  assert.equal(await html.text(), "rendered");
  assert.equal(rendered.length, 1);
  assert.equal(
    rendered[0]?.headers.get(CAMPAIGN_CONFIGURATION_HEADER),
    null,
  );
  assert.equal(rendered[0]?.headers.get(PUBLIC_AGGREGATE_HEADER), null);
  assert.equal(legacy.reads.aggregate, 0);
});

test("the Worker resolves participant state from the trusted actor and replaces spoofed state", async () => {
  const renderedRequests: Request[] = [];
  const state = participantAuthorizationState(
    "participant-subject",
    "participant@example.com",
  );
  const worker = createApplicationWorker({
    fetchApplication: async (request) => {
      renderedRequests.push(request);
      return new Response("rendered");
    },
    fetchOptimizedImage: async () => new Response("image"),
    participantAccessReader: {
      read: async (account) => {
        if (account.subject === "participant-subject") {
          assert.equal(account.accountEmailLabel, "participant@example.com");
        }
        return state;
      },
    },
  });
  const env = testEnvironment();

  await worker.fetch(
    new Request("https://campaign.example/", {
      headers: {
        "oai-authenticated-user-id": "participant-subject",
        "oai-authenticated-user-email": "participant@example.com",
        [PARTICIPANT_ACCESS_HEADER]: JSON.stringify({
          subject: "spoofed-subject",
          email: "spoofed@example.com",
        }),
      },
    }),
    env,
    executionContext,
  );
  const authorized = participantAccessFromRuntimeHeader(
    renderedRequests[0]?.headers.get(PARTICIPANT_ACCESS_HEADER) ?? null,
  );
  assert.ok(authorized);
  assert.equal(authorized.subject, "participant-subject");
  assert.equal(authorized.email, "participant@example.com");

  await worker.fetch(
    new Request("https://campaign.example/", {
      headers: {
        "oai-authenticated-user-id": "foreign-subject",
        "oai-authenticated-user-email": "foreign@example.com",
        [PARTICIPANT_ACCESS_HEADER]: JSON.stringify(authorized),
      },
    }),
    testEnvironment(),
    executionContext,
  );
  assert.equal(
    renderedRequests[1]?.headers.get(PARTICIPANT_ACCESS_HEADER),
    null,
  );

  const workerWithoutParticipantReader = createApplicationWorker({
    fetchApplication: async (request) => {
      renderedRequests.push(request);
      return new Response("rendered");
    },
    fetchOptimizedImage: async () => new Response("image"),
  });
  await workerWithoutParticipantReader.fetch(
    new Request("https://campaign.example/", {
      headers: {
        "oai-authenticated-user-id": "participant-subject",
        "oai-authenticated-user-email": "participant@example.com",
        [PARTICIPANT_ACCESS_HEADER]: JSON.stringify(authorized),
      },
    }),
    testEnvironment(),
    executionContext,
  );
  assert.equal(
    renderedRequests[2]?.headers.get(PARTICIPANT_ACCESS_HEADER),
    null,
  );
});

function routeContext(
  url: string,
  overrides: Readonly<{
    requestHeaders?: HeadersInit;
    actor?: ApplicationRouteContext["actor"];
    isOwner?: boolean;
    participantAccess?: ApplicationRouteContext["participantAccess"];
    renderApplication?: () => Promise<Response>;
  }> = {},
): ApplicationRouteContext {
  return {
    request: new Request(url, { headers: overrides.requestHeaders }),
    url: new URL(url),
    resourceUrl: url,
    actor: overrides.actor ?? null,
    isOwner: overrides.isOwner ?? false,
    participantAccess: overrides.participantAccess ?? null,
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

function actor(userId: string, email: string) {
  return { userId, email, displayName: email };
}

function participantAccess(userId: string, email: string) {
  const account = parseParticipantAccount({
    subject: userId,
    accountEmailLabel: email,
  });
  assert(account.ok);
  const access = authorizeParticipantAccess(
    account.value,
    participantAuthorizationState(userId, email),
  );
  assert(access);
  return access;
}

function participantAuthorizationState(
  userId: string,
  email: string,
): ParticipantAuthorizationState {
  const account = parseParticipantAccount({
    subject: userId,
    accountEmailLabel: email,
  });
  const id = parseStableId<"package-version">("package-version:current");
  const createdAt = parseTimestamp("2026-08-09T09:00:00.000Z");
  assert(account.ok);
  assert(id.ok);
  assert(createdAt.ok);

  return {
    profile: {
      subject: account.value.subject,
      accountEmailLabel: account.value.accountEmailLabel,
      displayName: "Private Participant Name",
      declaredInterest: "both",
      participationContext: "company",
      accountDeletionRequested: false,
    },
    currentPackage: {
      id: id.value,
      createdAt: createdAt.value,
      changeSummary: "Confidential allocation discussion",
      materialChange: true,
      requiresCurrentAcceptance: true,
    },
  };
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

function storedCampaignRevision(
  revision: number,
  published: boolean,
  name: string,
): CampaignSetupRevision {
  const operationId = parseStorageOperationId(
    `campaign-operation:worker-revision-${revision}`,
  );
  const recordedAt = parseTimestamp(`2026-08-09T0${revision}:00:00.000Z`);
  const setup = parseCampaignSetup({
    ...explicitCampaignSetup(),
    publicCampaign: { ...syntheticPublicCampaign, published, name },
  });
  assert(operationId.ok);
  assert(recordedAt.ok);
  assert(setup.ok);
  return {
    revision,
    operationId: operationId.value,
    recordedAt: recordedAt.value,
    setup: setup.value,
  };
}

function legacyPublicPresentationFixture(published: boolean) {
  const reads = { aggregate: 0 };
  const campaign = Object.freeze({
    ...syntheticPublicCampaign,
    published,
  });
  const storage: StorageAdapter = {
    async read(key) {
      if (key.collection === "investment-aggregate-states") {
        reads.aggregate += 1;
        return null;
      }
      if (
        key.collection !== "campaign-public-presentation" ||
        key.id !== "configured-campaign"
      ) return null;
      return Object.freeze({
        key: Object.freeze({ ...key }),
        revision: 1,
        value: Object.freeze({
          kind: "campaign-public-presentation",
          schemaVersion: 4,
          revision: 1,
          publicCampaign: campaign,
        }),
      });
    },
    async list() {
      throw new StorageFailure("UNAVAILABLE");
    },
    async transact() {
      throw new StorageFailure("UNAVAILABLE");
    },
  };
  return Object.freeze({ campaign, reads, storage });
}
