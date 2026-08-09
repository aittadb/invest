import assert from "node:assert/strict";
import test from "node:test";

import {
  OWNER_OAUTH_CALLBACK_PATH,
  OWNER_OAUTH_PROOF_PATH,
} from "../domain/owner-oauth-proof-resource.ts";
import { parseActorSubject, parseTimestamp } from "../domain/foundation.ts";
import {
  createBrowserMutationGuard,
  hashCsrfToken,
} from "../http/mutation-security.ts";
import {
  OWNER_AITTADB_CONNECTION_HEADER,
} from "../http/runtime-capabilities.ts";
import {
  createAittaDBOAuthProofService,
  type AittaDBOAuthProofDependencies,
} from "../services/aittadb-oauth-proof.ts";
import { createApplicationWorker } from "../worker/application-worker.ts";
import type {
  ApplicationRouteContext,
  InvestorAppEnv,
  WorkerExecutionContext,
} from "../worker/contracts.ts";
import {
  createOwnerOAuthProofRouteHandler,
} from "../worker/routes/owner-oauth-proof.ts";

const ORIGIN = "https://campaign.example.test";
const ISSUER = "https://database.example.test";
const CALLBACK = `${ORIGIN}${OWNER_OAUTH_CALLBACK_PATH}`;
const CLIENT_ID = "confidential-client";
const CLIENT_SECRET = "hosted-client-secret";
const ACCESS_TOKEN = "private-access-token";
const AUTHORIZATION_CODE = "one-time-authorization-code";
const OWNER_SUBJECT = "owner-subject";
const AITTADB_SUBJECT = "11111111-1111-4111-8111-111111111111";
const ACCESS_TOKEN_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_EMAIL = "owner@example.test";
const CSRF = "csrf-proof-token-with-enough-entropy";
const NOW = new Date("2026-08-09T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.valueOf() / 1_000);
const HYPERMEDIA = "application/vnd.aittadb-invest+json; version=0.1";

const executionContext: WorkerExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

test("owner connection HTML form and hypermedia action share one capability", async () => {
  const harness = await routeHarness();
  const html = requiredResponse(await harness.handler(context(
    `${ORIGIN}${OWNER_OAUTH_PROOF_PATH}`,
    { accept: "text/html" },
  )));
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("x-investor-app-csrf"), CSRF);
  const htmlBody = await html.text();
  assert.match(htmlBody, /<h1>AittaDB connection<\/h1>/u);
  assert.match(
    htmlBody,
    new RegExp(`action="${ORIGIN}${OWNER_OAUTH_PROOF_PATH}" method="post"`, "u"),
  );
  assert.match(htmlBody, new RegExp(`name="_csrf" value="${CSRF}"`, "u"));
  assert.match(htmlBody, />Verify connection<\/button>/u);

  const json = requiredResponse(await harness.handler(context(
    `${ORIGIN}${OWNER_OAUTH_PROOF_PATH}`,
    { accept: HYPERMEDIA },
  )));
  assert.equal(json.status, 200);
  const document = await json.json();
  assert.equal(document.type, "owner-aittadb-connection");
  assert.equal(document.data.availability, "available");
  assert.deepEqual(document.actions, [{
    name: "verify-aittadb-connection",
    title: "Verify connection",
    method: "POST",
    href: `${ORIGIN}${OWNER_OAUTH_PROOF_PATH}`,
    type: "application/x-www-form-urlencoded",
    fields: [],
  }]);
  assert.equal(json.headers.get("x-investor-app-csrf"), CSRF);
  assertPrivateResponse(html);
  assertPrivateResponse(json);
});

test("initiation requires the configured owner, exact origin, and CSRF before discovery", async () => {
  const anonymousHarness = await routeHarness();
  const anonymous = requiredResponse(await anonymousHarness.handler(context(
    `${ORIGIN}${OWNER_OAUTH_PROOF_PATH}`,
    { accept: HYPERMEDIA, actor: null, isOwner: false },
  )));
  assert.equal(anonymous.status, 401);
  assert.equal(anonymousHarness.networkRequests.length, 0);

  const foreignHarness = await routeHarness();
  const foreign = requiredResponse(await foreignHarness.handler(context(
    `${ORIGIN}${OWNER_OAUTH_PROOF_PATH}`,
    {
      accept: HYPERMEDIA,
      actor: { userId: "foreign-subject", email: "foreign@example.test", displayName: "Foreign" },
      isOwner: false,
    },
  )));
  assert.equal(foreign.status, 404);
  assert.equal(foreignHarness.networkRequests.length, 0);

  for (const [name, headers, body] of [
    [
      "origin",
      { accept: HYPERMEDIA, "content-type": "application/x-www-form-urlencoded" },
      `_csrf=${encodeURIComponent(CSRF)}`,
    ],
    [
      "csrf",
      {
        accept: HYPERMEDIA,
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      "_csrf=wrong-token",
    ],
  ] as const) {
    const harness = await routeHarness();
    const response = requiredResponse(await harness.handler(context(
      `${ORIGIN}${OWNER_OAUTH_PROOF_PATH}`,
      { method: "POST", headers, body },
    )));
    assert.equal(response.status, 403, name);
    assert.equal(harness.networkRequests.length, 0, name);
    assertSecretsAbsent(response, await response.clone().text());
  }

  const validHarness = await routeHarness();
  const valid = requiredResponse(await validHarness.handler(context(
    `${ORIGIN}${OWNER_OAUTH_PROOF_PATH}`,
    {
      method: "POST",
      headers: {
        accept: "text/html",
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `_csrf=${encodeURIComponent(CSRF)}`,
    },
  )));
  assert.equal(valid.status, 303);
  assert.equal(validHarness.networkRequests.length, 1);
  const location = new URL(requiredHeader(valid, "location"));
  assert.equal(location.origin, ISSUER);
  assert.equal(location.searchParams.get("scope"), "storage.read storage.write");
  assert.equal(location.searchParams.has("offline_access"), false);
  assert.match(requiredHeader(valid, "set-cookie"), /Secure; HttpOnly; SameSite=Lax/u);
  assertSecretsAbsent(valid, await valid.clone().text());
});

test("callback validates once, clears its cookie, and returns no credentials", async () => {
  const harness = await routeHarness();
  const start = requiredResponse(await harness.handler(context(
    `${ORIGIN}${OWNER_OAUTH_PROOF_PATH}`,
    {
      method: "POST",
      headers: {
        accept: "text/html",
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `_csrf=${encodeURIComponent(CSRF)}`,
    },
  )));
  const authorization = new URL(requiredHeader(start, "location"));
  const state = authorization.searchParams.get("state");
  assert.ok(state);
  const transactionCookie = cookieHeader(requiredHeader(start, "set-cookie"));
  const callbackUrl = `${CALLBACK}?code=${encodeURIComponent(AUTHORIZATION_CODE)}&state=${encodeURIComponent(state)}`;

  const success = requiredResponse(await harness.handler(context(callbackUrl, {
    accept: HYPERMEDIA,
    headers: { cookie: transactionCookie },
  })));
  assert.equal(success.status, 200);
  assert.equal((await success.clone().json()).data.outcome, "verified");
  assert.match(requiredHeader(success, "set-cookie"), /Max-Age=0/u);
  assert.equal(harness.proofs, 1);
  assert.equal(harness.networkRequests.length, 4);
  assertPrivateResponse(success);
  assertSecretsAbsent(success, await success.clone().text(), state);

  const replay = requiredResponse(await harness.handler(context(callbackUrl, {
    accept: HYPERMEDIA,
    headers: { cookie: transactionCookie },
  })));
  assert.equal(replay.status, 400);
  assert.equal((await replay.clone().json()).data.outcome, "failed");
  assert.equal(harness.networkRequests.length, 4);
  assert.match(requiredHeader(replay, "set-cookie"), /Max-Age=0/u);
  assertSecretsAbsent(replay, await replay.clone().text(), state);
});

test("callback errors, anonymous callers, and foreign callers clear context without network access", async () => {
  const harness = await routeHarness();
  const start = await harness.service.begin(OWNER_SUBJECT);
  const authorization = new URL(start.authorizationUrl);
  const state = authorization.searchParams.get("state");
  assert.ok(state);
  const cookie = cookieHeader(start.setCookie);
  const requestsAfterStart = harness.networkRequests.length;

  const denied = requiredResponse(await harness.handler(context(
    `${CALLBACK}?error=access_denied&state=${encodeURIComponent(state)}`,
    { accept: "text/html", headers: { cookie } },
  )));
  assert.equal(denied.status, 400);
  assert.match(requiredHeader(denied, "set-cookie"), /Max-Age=0/u);
  assert.equal(harness.networkRequests.length, requestsAfterStart);
  assertSecretsAbsent(denied, await denied.clone().text(), state);

  for (const [actor, isOwner, status] of [
    [null, false, 401],
    [
      { userId: "foreign-subject", email: "foreign@example.test", displayName: "Foreign" },
      false,
      404,
    ],
  ] as const) {
    const separate = await routeHarness();
    const response = requiredResponse(await separate.handler(context(
      `${CALLBACK}?code=${AUTHORIZATION_CODE}&state=${"x".repeat(43)}`,
      { accept: HYPERMEDIA, headers: { cookie: "private-cookie" }, actor, isOwner },
    )));
    assert.equal(response.status, status);
    assert.equal(separate.networkRequests.length, 0);
    assert.match(requiredHeader(response, "set-cookie"), /Max-Age=0/u);
    assertSecretsAbsent(response, await response.clone().text());
  }
});

test("application worker exposes the route and trusted UI capability only when injected", async () => {
  const fallbackRequests: Request[] = [];
  const defaultWorker = createApplicationWorker({
    fetchApplication: async (request) => {
      fallbackRequests.push(request);
      return new Response("application fallback");
    },
    fetchOptimizedImage: async () => new Response("image"),
  });
  const routeRequest = ownerRequest(`${ORIGIN}${OWNER_OAUTH_PROOF_PATH}`, {
    accept: HYPERMEDIA,
  });
  const fallback = await defaultWorker.fetch(
    routeRequest,
    environment(),
    executionContext,
  );
  assert.equal(await fallback.text(), "application fallback");
  assert.equal(fallbackRequests.length, 1);
  assert.equal(
    fallbackRequests[0]?.headers.get(OWNER_AITTADB_CONNECTION_HEADER),
    null,
  );

  const harness = await routeHarness();
  const renderedRequests: Request[] = [];
  const injectedWorker = createApplicationWorker({
    fetchApplication: async (request) => {
      renderedRequests.push(request);
      return new Response("rendered");
    },
    fetchOptimizedImage: async () => new Response("image"),
    ownerOAuthProof: harness.dependencies,
  });
  const response = await injectedWorker.fetch(
    ownerRequest(`${ORIGIN}${OWNER_OAUTH_PROOF_PATH}`, { accept: HYPERMEDIA }),
    environment(),
    executionContext,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).type, "owner-aittadb-connection");
  assert.equal(renderedRequests.length, 0);

  await injectedWorker.fetch(
    ownerRequest(`${ORIGIN}/not-a-resource`, {
      [OWNER_AITTADB_CONNECTION_HEADER]: "spoofed",
    }),
    environment(),
    executionContext,
  );
  assert.equal(
    renderedRequests[0]?.headers.get(OWNER_AITTADB_CONNECTION_HEADER),
    "available",
  );
});

async function routeHarness() {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  const networkRequests: string[] = [];
  const claimed = new Set<string>();
  let proofs = 0;
  let randomCall = 0;
  const oauthDependencies: AittaDBOAuthProofDependencies = {
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    callbackUri: CALLBACK,
    allowedStorageScopes: [
      "storage.read",
      "storage.write",
      "storage.delete",
    ],
    requestedStorageScopes: ["storage.read", "storage.write"],
    transactionCookieKey: key,
    transactionTtlSeconds: 300,
    transactionClaimStore: {
      async claim(transaction) {
        if (claimed.has(transaction.fingerprint)) return false;
        claimed.add(transaction.fingerprint);
        return true;
      },
    },
    resultSink: {
      async recordVerifiedProof() {
        proofs += 1;
      },
    },
    async fetch(request) {
      networkRequests.push(request.url);
      if (request.url.endsWith("/.well-known/openid-configuration")) {
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
      if (request.url.endsWith("/oauth/token")) {
        assert.equal(body.get("grant_type"), "authorization_code");
        assert.equal(body.get("code"), AUTHORIZATION_CODE);
        assert.equal(body.get("redirect_uri"), CALLBACK);
        assert.match(body.get("code_verifier") ?? "", /^[\w-]{43}$/u);
        return jsonResponse({
          access_token: ACCESS_TOKEN,
          token_type: "Bearer",
          expires_in: 3_600,
          scope: "storage.read storage.write",
        });
      }
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
        scope: "storage.read storage.write",
        token_use: "access",
      });
    },
    now: () => NOW,
    randomBytes(length) {
      randomCall += 1;
      return Uint8Array.from(
        { length },
        (_, index) => (randomCall * 64 + index) % 256,
      );
    },
  };
  const oauth = createAittaDBOAuthProofService(oauthDependencies);
  const ownerSubject = parseActorSubject(OWNER_SUBJECT);
  const sessionExpiry = parseTimestamp("2026-08-09T13:00:00.000Z");
  const csrfExpiry = parseTimestamp("2026-08-09T12:30:00.000Z");
  assert(ownerSubject.ok);
  assert(sessionExpiry.ok);
  assert(csrfExpiry.ok);
  const csrfHash = await hashCsrfToken(CSRF);
  const dependencies = {
    oauth,
    verifyMutation: createBrowserMutationGuard({
      allowedOrigins: [ORIGIN],
      now: () => NOW,
      resolveSession: async () => ({
        actor: { type: "owner" as const, subject: ownerSubject.value },
        expiresAt: sessionExpiry.value,
        csrf: { tokenHash: csrfHash, expiresAt: csrfExpiry.value },
      }),
    }),
    csrfToken: async () => CSRF,
  };
  return {
    service: oauth,
    dependencies,
    handler: createOwnerOAuthProofRouteHandler(dependencies),
    networkRequests,
    get proofs() {
      return proofs;
    },
  };
}

function context(
  url: string,
  options: Readonly<{
    method?: string;
    accept?: string;
    headers?: HeadersInit;
    body?: BodyInit;
    actor?: ApplicationRouteContext["actor"];
    isOwner?: boolean;
  }> = {},
): ApplicationRouteContext {
  const headers = new Headers(options.headers);
  if (options.accept) headers.set("accept", options.accept);
  const request = new Request(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body,
  });
  return {
    request,
    url: new URL(url),
    resourceUrl: url,
    actor: options.actor === undefined
      ? { userId: OWNER_SUBJECT, email: OWNER_EMAIL, displayName: "Owner" }
      : options.actor,
    isOwner: options.isOwner ?? true,
    participantAccess: null,
    campaign: null,
    renderApplication: async () => new Response("rendered"),
  };
}

function ownerRequest(url: string, headers: HeadersInit): Request {
  return new Request(url, {
    headers: {
      ...Object.fromEntries(new Headers(headers)),
      "oai-authenticated-user-id": OWNER_SUBJECT,
      "oai-authenticated-user-email": OWNER_EMAIL,
    },
  });
}

function environment(): InvestorAppEnv {
  return {
    APP_BASE_URL: ORIGIN,
    OWNER_EMAIL,
    ASSETS: { fetch: async () => new Response("asset") },
    IMAGES: {
      input() {
        throw new Error("Image optimization is outside this route test.");
      },
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function cookieHeader(setCookie: string): string {
  return setCookie.split(";", 1)[0] ?? "";
}

function requiredResponse(value: Response | null): Response {
  assert.ok(value);
  return value;
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  assert.ok(value, `${name} header is required`);
  return value;
}

function assertPrivateResponse(response: Response): void {
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/u);
}

function assertSecretsAbsent(
  response: Response,
  body: string,
  state?: string,
): void {
  const serialized = `${body}\n${[...response.headers].map(([name, value]) =>
    `${name}: ${value}`).join("\n")}`;
  for (const secret of [
    CLIENT_SECRET,
    ACCESS_TOKEN,
    AUTHORIZATION_CODE,
    deterministicToken(128),
    ...(state ? [state] : []),
  ]) {
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(secret), "u"));
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function deterministicToken(seed: number): string {
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
