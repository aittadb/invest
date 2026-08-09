import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";

import {
  MUTATION_CSRF_HEADER,
} from "../http/mutation-security.ts";
import {
  OWNER_AITTADB_CONNECTION_HEADER,
} from "../http/runtime-capabilities.ts";
import type {
  D1OAuthProofDatabase,
  D1OAuthProofStatement,
  D1OAuthProofValue,
} from "../repositories/d1-oauth-proof-store.ts";
import type {
  OAuthAvailabilityFailurePhase,
} from "../services/aittadb-oauth-proof.ts";
import { createApplicationWorker } from "../worker/application-worker.ts";
import type {
  InvestorAppEnv,
  WorkerExecutionContext,
} from "../worker/contracts.ts";
import {
  createHostedOwnerOAuthProofResolver,
  hostedOAuthAvailabilityEvidence,
} from "../worker/hosted-oauth-composition.ts";

const APP_ORIGIN = "https://invest.example.test";
const CALLBACK = `${APP_ORIGIN}/owner/aittadb-connection/callback`;
const CONNECTION = `${APP_ORIGIN}/owner/aittadb-connection`;
const ISSUER = "https://database.example.test";
const OWNER_EMAIL = "owner@example.test";
const OWNER_SUBJECT = "sites-owner-subject";
const CLIENT_ID = "investor-app-acceptance";
const CLIENT_SECRET = "confidential-client-secret";
const ACCESS_TOKEN = "a".repeat(64);
const AUTHORIZATION_CODE = "one-time-authorization-code";
const AITTADB_SUBJECT = "11111111-1111-4111-8111-111111111111";
const ACCESS_TOKEN_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-09T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.valueOf() / 1_000);
const HYPERMEDIA = "application/vnd.aittadb-invest+json; version=0.1";
const MIGRATION = readFileSync(
  new URL("../db/migrations/0001_oauth_proof_persistence.sql", import.meta.url),
  "utf8",
);

const executionContext: WorkerExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

test("hosted Worker composition completes and persists the scoped OAuth proof", async (t) => {
  const database = migratedDatabase(t);
  const providerRequests: Request[] = [];
  let randomCall = 0;
  const resolver = createHostedOwnerOAuthProofResolver({
    fetch: async (input, init) => {
      const request = new Request(input, init);
      providerRequests.push(request.clone());
      if (request.url === `${ISSUER}/.well-known/openid-configuration`) {
        return jsonResponse({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/oauth/token`,
          introspection_endpoint: `${ISSUER}/oauth/introspect`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
          scopes_supported: [
            "storage.read",
            "storage.write",
            "storage.delete",
          ],
        });
      }

      assert.equal(
        request.headers.get("authorization"),
        `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
      );
      const body = new URLSearchParams(await request.clone().text());
      if (request.url === `${ISSUER}/oauth/token`) {
        assert.equal(body.get("grant_type"), "authorization_code");
        assert.equal(body.get("code"), AUTHORIZATION_CODE);
        assert.equal(body.get("redirect_uri"), CALLBACK);
        assert.match(body.get("code_verifier") ?? "", /^[A-Za-z0-9_-]{43}$/u);
        return jsonResponse({
          access_token: ACCESS_TOKEN,
          token_type: "Bearer",
          expires_in: 3_600,
          scope: "storage.read",
        });
      }

      assert.equal(request.url, `${ISSUER}/oauth/introspect`);
      assert.equal(body.get("token"), ACCESS_TOKEN);
      return jsonResponse({
        active: true,
        iss: ISSUER,
        sub: AITTADB_SUBJECT,
        aud: CLIENT_ID,
        exp: NOW_SECONDS + 3_600,
        iat: NOW_SECONDS,
        nbf: NOW_SECONDS,
        jti: ACCESS_TOKEN_ID,
        scope: "storage.read",
        token_use: "access",
      });
    },
    now: () => NOW,
    randomBytes(length) {
      randomCall += 1;
      return Uint8Array.from(
        { length },
        (_, index) => (randomCall * 37 + index) % 256,
      );
    },
  });
  const env = configuredEnvironment(database);
  const firstCapability = await resolver(env);
  assert.ok(firstCapability);
  assert.equal(await resolver(env), firstCapability);
  assert.doesNotMatch(JSON.stringify(firstCapability), new RegExp(CLIENT_SECRET, "u"));

  const fallbackRequests: Request[] = [];
  const worker = createApplicationWorker({
    fetchApplication: async (request) => {
      fallbackRequests.push(request);
      return new Response("fallback");
    },
    fetchOptimizedImage: async () => new Response("image"),
    resolveOwnerOAuthProof: resolver,
  });

  const resource = await worker.fetch(
    ownerRequest(CONNECTION, { headers: { accept: HYPERMEDIA } }),
    env,
    executionContext,
  );
  assert.equal(resource.status, 200);
  assert.equal((await resource.clone().json()).type, "owner-aittadb-connection");
  const csrfToken = requiredHeader(resource, MUTATION_CSRF_HEADER);
  const csrfCookie = cookieHeader(requiredHeader(resource, "set-cookie"));

  const initiation = await worker.fetch(
    ownerRequest(CONNECTION, {
      method: "POST",
      headers: {
        accept: HYPERMEDIA,
        cookie: csrfCookie,
        origin: APP_ORIGIN,
        "content-type": "application/json",
        [MUTATION_CSRF_HEADER]: csrfToken,
      },
      body: JSON.stringify({}),
    }),
    env,
    executionContext,
  );
  assert.equal(initiation.status, 303);
  const authorization = new URL(requiredHeader(initiation, "location"));
  assert.equal(authorization.origin, ISSUER);
  assert.equal(authorization.pathname, "/authorize");
  assert.equal(authorization.searchParams.get("response_type"), "code");
  assert.equal(authorization.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(authorization.searchParams.get("redirect_uri"), CALLBACK);
  assert.equal(authorization.searchParams.get("scope"), "storage.read");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.match(
    authorization.searchParams.get("code_challenge") ?? "",
    /^[A-Za-z0-9_-]{43}$/u,
  );
  const state = authorization.searchParams.get("state");
  assert.match(state ?? "", /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(authorization.href.includes(CLIENT_SECRET), false);
  const transactionCookie = cookieHeader(requiredHeader(initiation, "set-cookie"));

  const callbackUrl = `${CALLBACK}?code=${encodeURIComponent(AUTHORIZATION_CODE)}&state=${encodeURIComponent(state ?? "")}`;
  const callback = await worker.fetch(
    ownerRequest(callbackUrl, {
      headers: { accept: HYPERMEDIA, cookie: transactionCookie },
    }),
    env,
    executionContext,
  );
  assert.equal(callback.status, 200);
  const callbackDocument = await callback.clone().json();
  assert.equal(callbackDocument.data.outcome, "verified");
  assert.match(requiredHeader(callback, "set-cookie"), /Max-Age=0/u);
  assertCredentialsAbsent(callback, await callback.text(), state ?? "");

  const claims = database.sqlite.prepare(
    "SELECT * FROM investor_oauth_transaction_claims",
  ).all();
  const proofs = database.sqlite.prepare(
    "SELECT * FROM investor_oauth_verified_proofs",
  ).all();
  assert.equal(claims.length, 1);
  assert.equal(proofs.length, 1);
  const proof = proofs[0] as Record<string, unknown>;
  assert.equal(proof.issuer, ISSUER);
  assert.equal(proof.audience, CLIENT_ID);
  assert.equal(proof.scopes_json, '["storage.read"]');
  const persisted = JSON.stringify({ claims, proofs });
  for (const forbidden of [
    CLIENT_SECRET,
    ACCESS_TOKEN,
    AUTHORIZATION_CODE,
    OWNER_SUBJECT,
    state ?? "",
  ]) {
    assert.equal(persisted.includes(forbidden), false);
  }

  const requestsBeforeReplay = providerRequests.length;
  const replay = await worker.fetch(
    ownerRequest(callbackUrl, {
      headers: { accept: HYPERMEDIA, cookie: transactionCookie },
    }),
    env,
    executionContext,
  );
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).data.outcome, "failed");
  assert.equal(providerRequests.length, requestsBeforeReplay);
  assert.equal(fallbackRequests.length, 0);
});

test("absent, partial, malformed, or unbound deployments keep OAuth absent", async (t) => {
  const database = migratedDatabase(t);
  let providerCalls = 0;
  const resolver = createHostedOwnerOAuthProofResolver({
    fetch: async () => {
      providerCalls += 1;
      throw new Error("Provider access must remain unreachable.");
    },
  });
  const complete = configuredEnvironment(database);
  const partial = { ...complete };
  delete partial.AITTADB_OAUTH_CLIENT_SECRET;
  const malformed = {
    ...complete,
    AITTADB_OAUTH_CALLBACK_URI: "https://foreign.example.test/callback",
  };
  const variants: InvestorAppEnv[] = [
    baseEnvironment({ OAUTH_PROOF_DB: database }),
    baseEnvironment({ ...complete, OAUTH_PROOF_DB: undefined }),
    partial,
    malformed,
  ];

  for (const env of variants) {
    const rendered: Request[] = [];
    const worker = createApplicationWorker({
      fetchApplication: async (request) => {
        rendered.push(request);
        return new Response("application fallback", { status: 418 });
      },
      fetchOptimizedImage: async () => new Response("image"),
      resolveOwnerOAuthProof: resolver,
    });
    const response = await worker.fetch(
      ownerRequest(CONNECTION, { headers: { accept: HYPERMEDIA } }),
      env,
      executionContext,
    );
    assert.equal(response.status, 418);
    assert.equal(await response.text(), "application fallback");
    assert.equal(rendered.length, 1);
    assert.equal(
      rendered[0]?.headers.get(OWNER_AITTADB_CONNECTION_HEADER),
      null,
    );
  }
  assert.equal(providerCalls, 0);
});

test("hosted availability evidence is fixed and credential-free", async (t) => {
  const phases: OAuthAvailabilityFailurePhase[] = [
    "request",
    "fetch",
    "status",
    "content_type",
    "declared_size",
    "body",
    "body_size",
    "encoding",
    "json",
    "document",
    "contract",
    "internal",
  ];
  assert.deepEqual(
    phases.map(hostedOAuthAvailabilityEvidence),
    phases.map((phase) => `investor_app.oauth.discovery.${phase}`),
  );
  const serialized = JSON.stringify(phases.map(hostedOAuthAvailabilityEvidence));
  for (const forbidden of [CLIENT_SECRET, CLIENT_ID, ISSUER, CALLBACK, OWNER_EMAIL]) {
    assert.equal(serialized.includes(forbidden), false);
  }

  const database = migratedDatabase(t);
  const observed: OAuthAvailabilityFailurePhase[] = [];
  const resolver = createHostedOwnerOAuthProofResolver({
    async fetch() {
      throw new Error(`${CLIENT_SECRET} ${ISSUER}`);
    },
    availabilityFailureObserver(phase) {
      observed.push(phase);
    },
  });
  const capability = await resolver(configuredEnvironment(database));
  assert.ok(capability);
  assert.equal(await capability.oauth.availability(), false);
  assert.deepEqual(observed, ["fetch"]);
});

test("the production entry point installs only the fail-closed hosted resolver", () => {
  const entrypoint = readFileSync(
    new URL("../worker/index.ts", import.meta.url),
    "utf8",
  );
  const composition = readFileSync(
    new URL("../worker/hosted-oauth-composition.ts", import.meta.url),
    "utf8",
  );
  assert.match(entrypoint, /createHostedOwnerOAuthProofResolver\(\)/u);
  assert.match(entrypoint, /resolveOwnerOAuthProof:/u);
  assert.doesNotMatch(entrypoint, /console\s*\./u);
  assert.match(
    composition,
    /console\.warn\(hostedOAuthAvailabilityEvidence\(phase\)\)/u,
  );
  assert.doesNotMatch(
    composition,
    /console\.(?:debug|error|info|log)\s*\(/u,
  );
  assert.doesNotMatch(`${entrypoint}\n${composition}`, /aittadb\.com|chatgpt\.site/iu);
});

function configuredEnvironment(
  database: SqliteD1Database,
): InvestorAppEnv {
  return baseEnvironment({
    APP_BASE_URL: APP_ORIGIN,
    OWNER_EMAIL,
    AITTADB_OAUTH_ISSUER: ISSUER,
    AITTADB_OAUTH_CLIENT_ID: CLIENT_ID,
    AITTADB_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    AITTADB_OAUTH_CALLBACK_URI: CALLBACK,
    AITTADB_OAUTH_STORAGE_SCOPES: "storage.read",
    AITTADB_OAUTH_TRANSACTION_KEY: keyMaterial(1),
    AITTADB_OAUTH_CSRF_KEY: keyMaterial(65),
    OAUTH_PROOF_DB: database,
  });
}

function baseEnvironment(
  values: Partial<InvestorAppEnv> = {},
): InvestorAppEnv {
  return {
    ...values,
    ASSETS: { fetch: async () => new Response("asset") },
    IMAGES: {
      input() {
        throw new Error("Image optimization is outside this test.");
      },
    },
  };
}

function ownerRequest(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("oai-authenticated-user-id", OWNER_SUBJECT);
  headers.set("oai-authenticated-user-email", OWNER_EMAIL);
  return new Request(url, { ...init, headers });
}

function migratedDatabase(t: test.TestContext): SqliteD1Database {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(MIGRATION);
  t.after(() => sqlite.close());
  return new SqliteD1Database(sqlite);
}

class SqliteD1Database implements D1OAuthProofDatabase {
  readonly sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.sqlite = sqlite;
  }

  prepare(sql: string): D1OAuthProofStatement {
    return new SqliteD1Statement(this.sqlite.prepare(sql));
  }
}

class SqliteD1Statement implements D1OAuthProofStatement {
  private values: D1OAuthProofValue[] = [];
  private readonly statement: StatementSync;

  constructor(statement: StatementSync) {
    this.statement = statement;
  }

  bind(...values: D1OAuthProofValue[]): D1OAuthProofStatement {
    this.values = values;
    return this;
  }

  async run() {
    const result = this.statement.run(...this.values);
    return {
      success: true,
      meta: { changes: Number(result.changes) },
    };
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function cookieHeader(setCookie: string): string {
  return setCookie.split(";", 1)[0] ?? "";
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  assert.ok(value, `${name} header is required`);
  return value;
}

function assertCredentialsAbsent(
  response: Response,
  body: string,
  state: string,
): void {
  const serialized = `${body}\n${[...response.headers].map(([name, value]) =>
    `${name}: ${value}`).join("\n")}`;
  for (const credential of [
    CLIENT_SECRET,
    ACCESS_TOKEN,
    AUTHORIZATION_CODE,
    state,
  ]) {
    assert.equal(serialized.includes(credential), false);
  }
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
