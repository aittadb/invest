import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AITTADB_HYPERMEDIA_API_VERSION,
  AITTADB_HYPERMEDIA_MEDIA_TYPE,
  defineStorageProtocolDiscovery,
} from "../domain/aittadb-storage-protocol.ts";
import {
  MUTATION_CSRF_HEADER,
  MutationSecurityFailure,
} from "../http/mutation-security.ts";
import { createApplicationWorker } from "../worker/application-worker.ts";
import type {
  InvestorAppEnv,
  WorkerExecutionContext,
} from "../worker/contracts.ts";
import { createHostedApplicationRuntimeResolver } from "../worker/hosted-application-composition.ts";

const APP_ORIGIN = "https://invest.example.test";
const ISSUER = "https://storage.example.test";
const TRANSPORT_ORIGIN = "https://storage-runtime.example.test";
const ENTRY_HREF = `${ISSUER}/bounded-storage`;
const TRANSACTION_HREF = `${ISSUER}/records/transactions`;
const SERVICE_CLIENT_ID = "investor-app-service";
const SERVICE_CLIENT_SECRET = "application-service-client-secret";
const ACCESS_TOKEN = "synthetic-access-token-that-must-stay-private";
const STORAGE_SCOPES = "storage.read storage.write storage.delete";
const NOW = new Date("2026-08-10T12:00:00.000Z");
const MUTATION_KEY = keyMaterial(17);
const OWNER = Object.freeze({
  type: "owner",
  subject: "sites-owner-subject",
} as const);

const executionContext: WorkerExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

test("hosted runtime composes once and closes credentials behind repositories", async () => {
  const service = new SyntheticAittaDBService();
  let randomSeed = 0;
  const resolver = createHostedApplicationRuntimeResolver({
    fetch: service.fetch,
    now: () => NOW,
    randomBytes(length) {
      randomSeed += 1;
      return Uint8Array.from(
        { length },
        (_, index) => (randomSeed * 29 + index) % 256,
      );
    },
  });
  const env = configuredEnvironment();
  const [runtime, concurrent] = await Promise.all([
    resolver(env),
    resolver(env),
  ]);

  assert.ok(runtime);
  assert.equal(concurrent, runtime);
  assert.equal(Object.isFrozen(runtime), true);
  assert.deepEqual(Object.keys(runtime).sort(), [
    "mutationSession",
    "publicationReady",
    "repositoryFactory",
  ]);
  assert.equal(runtime.publicationReady, false);
  const serialized = JSON.stringify(runtime);
  for (const secret of [
    SERVICE_CLIENT_SECRET,
    ACCESS_TOKEN,
    MUTATION_KEY,
    SERVICE_CLIENT_ID,
    ISSUER,
    TRANSPORT_ORIGIN,
  ]) {
    assert.equal(serialized.includes(secret), false);
  }

  await assert.rejects(
    runtime.mutationSession.issue(
      new Request("https://forged-request-host.example.test/owner/setup"),
      OWNER,
      "https://forged-request-host.example.test",
    ),
    (error) => error instanceof MutationSecurityFailure &&
      error.code === "REQUEST_REJECTED",
  );

  const proof = await runtime.mutationSession.issue(
    new Request(`${APP_ORIGIN}/owner/setup`),
    OWNER,
    APP_ORIGIN,
  );
  const verified = await runtime.mutationSession.verifyMutation(
    mutationRequest(proof),
    OWNER,
    APP_ORIGIN,
  );
  assert.equal(verified.actor.subject, OWNER.subject);
  assert.equal(verified.method, "POST");
  assert.match(verified.clearCookie, /Max-Age=0/u);

  await assert.rejects(
    runtime.mutationSession.verifyMutation(
      mutationRequest(proof),
      OWNER,
      APP_ORIGIN,
    ),
    (error) => error instanceof MutationSecurityFailure &&
      error.code === "REQUEST_REJECTED" &&
      error.cause === undefined,
  );

  assert.equal(service.tokenRequests, 1);
  assert.equal(service.discoveryRequests, 1);
  assert.equal(service.transactionRequests, 2);
  assert.equal(service.records.size, 1);
  const persisted = JSON.stringify([...service.records.values()]);
  assert.match(persisted, /"schemaVersion":1/u);
  assert.match(persisted, /"expiresAt":"2026-08-10T12:05:00.000Z"/u);
  assert.doesNotMatch(
    persisted,
    /sites-owner|csrf|cookie|credential|synthetic-access|invest\.example/iu,
  );
});

test("runtime resolution is fail-closed and never advertises feature routes", async () => {
  let providerCalls = 0;
  const resolver = createHostedApplicationRuntimeResolver({
    async fetch() {
      providerCalls += 1;
      throw new Error("Provider must remain unreachable.");
    },
  });
  const complete = configuredEnvironment();
  const partial = { ...complete };
  delete partial.AITTADB_STORAGE_CLIENT_SECRET;
  const variants: InvestorAppEnv[] = [
    baseEnvironment(),
    partial,
    configuredEnvironment({
      AITTADB_STORAGE_ENTRY_HREF: "https://foreign.example.test/storage",
    }),
  ];

  for (const env of variants) {
    const routed: boolean[] = [];
    const rendered: Request[] = [];
    const worker = createApplicationWorker({
      fetchApplication: async (request) => {
        rendered.push(request);
        return new Response("application");
      },
      fetchOptimizedImage: async () => new Response("image"),
      resolveApplicationRuntime: resolver,
      dispatchRoute: async (context) => {
        routed.push("applicationRuntime" in context);
        return null;
      },
    });
    const response = await worker.fetch(
      new Request("https://forged-request-host.example.test/owner", {
        headers: {
          "oai-authenticated-user-id": OWNER.subject,
          "oai-authenticated-user-email": "owner@example.test",
        },
      }),
      env,
      executionContext,
    );
    assert.equal(await response.text(), "application");
    assert.deepEqual(routed, [false]);
    assert.equal(rendered.length, 1);
    assert.deepEqual(
      [...rendered[0]!.headers].filter(([, value]) =>
        value === "available"
      ),
      [],
    );
  }
  assert.equal(providerCalls, 0);
});

test("complete runtime stays outside route and rendering capabilities", async () => {
  const resolver = createHostedApplicationRuntimeResolver({
    fetch: new SyntheticAittaDBService().fetch,
  });
  const env = configuredEnvironment();
  let routeHasRuntime = true;
  let renderedEnvironment: unknown;
  const rendered: Request[] = [];
  const worker = createApplicationWorker({
    fetchApplication: async (request, renderEnvironment) => {
      rendered.push(request);
      renderedEnvironment = renderEnvironment;
      return new Response("application");
    },
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: resolver,
    dispatchRoute: async (context) => {
      routeHasRuntime = "applicationRuntime" in context;
      return null;
    },
  });

  await worker.fetch(
    new Request("https://forged-request-host.example.test/"),
    env,
    executionContext,
  );
  const expected = await resolver(env);
  assert.ok(expected);
  assert.equal(routeHasRuntime, false);
  assert.equal(rendered.length, 1);
  assert.deepEqual(Object.keys(renderedEnvironment as object).sort(), [
    "ASSETS",
    "IMAGES",
  ]);
  const renderedHeaders = JSON.stringify([...rendered[0]!.headers]);
  assert.equal(
    [...rendered[0]!.headers].some(([, value]) => value === "available"),
    false,
  );
  for (const secret of [
    SERVICE_CLIENT_SECRET,
    ACCESS_TOKEN,
    MUTATION_KEY,
    SERVICE_CLIENT_ID,
    ISSUER,
    TRANSPORT_ORIGIN,
  ]) {
    assert.equal(renderedHeaders.includes(secret), false);
    assert.equal(JSON.stringify(renderedEnvironment).includes(secret), false);
  }
});

test("complete runtime centrally installs an owner route that fails closed", async () => {
  const resolver = createHostedApplicationRuntimeResolver({
    fetch: new SyntheticAittaDBService().fetch,
  });
  const rendered: Request[] = [];
  const worker = createApplicationWorker({
    fetchApplication: async (request) => {
      rendered.push(request);
      return new Response("application fallback", { status: 418 });
    },
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: resolver,
  });

  const response = await worker.fetch(
    new Request(`${APP_ORIGIN}/owner/setup`, {
      headers: {
        "oai-authenticated-user-id": OWNER.subject,
        "oai-authenticated-user-email": "owner@example.test",
      },
    }),
    configuredEnvironment({ OWNER_EMAIL: "owner@example.test" }),
    executionContext,
  );
  assert.equal(response.status, 503);
  assert.match(await response.text(), /temporarily unavailable/u);
  assert.equal(rendered.length, 0);
});

test("the production entry point installs the fail-closed application resolver", () => {
  const entrypoint = readFileSync(
    new URL("../worker/index.ts", import.meta.url),
    "utf8",
  );
  const composition = readFileSync(
    new URL("../worker/hosted-application-composition.ts", import.meta.url),
    "utf8",
  );
  assert.match(entrypoint, /createHostedApplicationRuntimeResolver\(\)/u);
  assert.match(entrypoint, /resolveApplicationRuntime:/u);
  assert.doesNotMatch(`${entrypoint}\n${composition}`, /console\s*\./u);
  assert.doesNotMatch(
    `${entrypoint}\n${composition}`,
    /aittadb\.com|chatgpt\.site|jheusala@/iu,
  );
});

class SyntheticAittaDBService {
  readonly records = new Map<string, Record<string, unknown>>();
  readonly operations = new Map<string, string>();
  tokenRequests = 0;
  discoveryRequests = 0;
  transactionRequests = 0;

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.url === `${TRANSPORT_ORIGIN}/oauth/token`) {
      this.tokenRequests += 1;
      assert.equal(request.method, "POST");
      assert.equal(
        request.headers.get("authorization"),
        `Basic ${btoa(`${SERVICE_CLIENT_ID}:${SERVICE_CLIENT_SECRET}`)}`,
      );
      assert.deepEqual(
        Object.fromEntries(new URLSearchParams(await request.text())),
        { grant_type: "client_credentials", scope: STORAGE_SCOPES },
      );
      return jsonResponse({
        access_token: ACCESS_TOKEN,
        token_type: "Bearer",
        expires_in: 3_600,
        scope: STORAGE_SCOPES,
      });
    }

    assert.equal(request.headers.get("authorization"), `Bearer ${ACCESS_TOKEN}`);
    assert.equal(request.headers.get("cookie"), null);
    if (request.url === `${TRANSPORT_ORIGIN}/bounded-storage`) {
      this.discoveryRequests += 1;
      return protocolResponse(defineStorageProtocolDiscovery({
        entryHref: ENTRY_HREF,
        readRecordHref: `${ISSUER}/records/{collection}/{id}`,
        listRecordsHref: `${ISSUER}/records`,
        transactRecordsHref: TRANSACTION_HREF,
        limits: {
          max_record_bytes: 65_536,
          max_page_size: 100,
          max_transaction_mutations: 25,
          max_transaction_bytes: 1_048_576,
          max_cursor_length: 2_048,
        },
      }));
    }
    assert.equal(request.url, `${TRANSPORT_ORIGIN}/records/transactions`);
    this.transactionRequests += 1;
    return this.transact(await request.json());
  };

  private transact(value: unknown): Response {
    const transaction = requiredObject(requiredObject(value).transaction);
    const operationId = requiredString(transaction.operation_id);
    const mutations = transaction.mutations;
    if (!Array.isArray(mutations) || mutations.length !== 1) {
      throw new Error("Unexpected synthetic transaction shape.");
    }
    const mutation = requiredObject(mutations[0]);
    const key = requiredObject(mutation.key);
    const collection = requiredString(key.collection);
    const id = requiredString(key.id);
    const storageKey = `${collection}/${id}`;
    const fingerprint = JSON.stringify(transaction);
    const prior = this.operations.get(operationId);
    if (prior !== undefined) {
      assert.equal(prior, fingerprint);
      return protocolResponse(transactionDocument(
        operationId,
        collection,
        id,
        requiredObject(mutation.value),
        true,
      ));
    }
    assert.equal(mutation.type, "put");
    assert.equal(mutation.expected_revision, null);
    assert.equal(this.records.has(storageKey), false);
    const stored = structuredClone(requiredObject(mutation.value));
    this.records.set(storageKey, stored);
    this.operations.set(operationId, fingerprint);
    return protocolResponse(transactionDocument(
      operationId,
      collection,
      id,
      stored,
      false,
    ));
  }
}

function transactionDocument(
  operationId: string,
  collection: string,
  id: string,
  value: Record<string, unknown>,
  replayed: boolean,
) {
  return {
    api_version: AITTADB_HYPERMEDIA_API_VERSION,
    type: "bounded-storage-transaction",
    id: operationId,
    data: {
      operation_id: operationId,
      replayed,
      records: [{
        key: { collection, id },
        revision: 1,
        value,
      }],
    },
    links: [],
    actions: [],
  };
}

function mutationRequest(proof: Readonly<{ token: string; setCookie: string }>) {
  return new Request(`${APP_ORIGIN}/owner/setup`, {
    method: "POST",
    headers: {
      cookie: proof.setCookie.split(";", 1)[0] ?? "",
      origin: APP_ORIGIN,
      "content-type": "application/json",
      [MUTATION_CSRF_HEADER]: proof.token,
    },
    body: JSON.stringify({ operation: "save" }),
  });
}

function configuredEnvironment(
  overrides: Partial<InvestorAppEnv> = {},
): InvestorAppEnv {
  return baseEnvironment({
    APP_BASE_URL: APP_ORIGIN,
    AITTADB_STORAGE_ISSUER: ISSUER,
    AITTADB_STORAGE_TRANSPORT_ORIGIN: TRANSPORT_ORIGIN,
    AITTADB_STORAGE_ENTRY_HREF: ENTRY_HREF,
    AITTADB_STORAGE_CLIENT_ID: SERVICE_CLIENT_ID,
    AITTADB_STORAGE_CLIENT_SECRET: SERVICE_CLIENT_SECRET,
    AITTADB_STORAGE_SCOPES: STORAGE_SCOPES,
    BROWSER_MUTATION_SESSION_KEY: MUTATION_KEY,
    ...overrides,
  });
}

function baseEnvironment(
  overrides: Partial<InvestorAppEnv> = {},
): InvestorAppEnv {
  return {
    ASSETS: { fetch: async () => new Response("asset") },
    IMAGES: {
      input: () => ({
        transform: () => ({
          output: async () => ({ response: new Response("image") }),
        }),
      }),
    },
    ...overrides,
  } as InvestorAppEnv;
}

function protocolResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE },
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function requiredObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected synthetic object.");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected synthetic string.");
  return value;
}

function keyMaterial(seed: number): string {
  const bytes = Uint8Array.from(
    { length: 32 },
    (_, index) => (seed + index) % 256,
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
