import assert from "node:assert/strict";
import test from "node:test";

import {
  createAittaDBOAuthProofService,
  OAuthProofFailure,
  type AittaDBOAuthProofDependencies,
  type AittaDBOAuthProofMetadata,
  type OAuthAvailabilityFailureObserver,
  type OAuthTransactionClaim,
} from "../services/aittadb-oauth-proof.ts";

const ISSUER = "https://database.example.test";
const TRANSPORT_ORIGIN = "https://database-runtime.example.test";
const CALLBACK =
  "https://campaign.example.test/owner/aittadb-connection/callback";
const CLIENT_ID = "confidential-client";
const CLIENT_SECRET = "hosted-client-secret";
const ACCESS_TOKEN = "private-access-token";
const AUTHORIZATION_CODE = "one-time-authorization-code";
const OWNER_SUBJECT = "owner-subject";
const AITTADB_SUBJECT = "11111111-1111-4111-8111-111111111111";
const ACCESS_TOKEN_ID = "22222222-2222-4222-8222-222222222222";
const REQUESTED_SCOPES = ["storage.read", "storage.write"] as const;
const NOW = new Date("2026-08-09T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.valueOf() / 1_000);

test("confidential Authorization Code with PKCE validates discovery, token, and introspection", async () => {
  const harness = await createHarness();
  assert.equal(harness.service.authorizationOrigin, ISSUER);
  const start = await harness.service.begin(OWNER_SUBJECT);
  const authorization = new URL(start.authorizationUrl);

  assert.equal(authorization.origin, ISSUER);
  assert.equal(authorization.pathname, "/authorize");
  assert.equal(authorization.searchParams.get("response_type"), "code");
  assert.equal(authorization.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(authorization.searchParams.get("redirect_uri"), CALLBACK);
  assert.equal(
    authorization.searchParams.get("scope"),
    REQUESTED_SCOPES.join(" "),
  );
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.match(authorization.searchParams.get("state") ?? "", /^[\w-]{43}$/u);
  assert.match(
    authorization.searchParams.get("code_challenge") ?? "",
    /^[\w-]{43}$/u,
  );
  assert.equal(authorization.searchParams.has("nonce"), false);
  assert.equal(authorization.searchParams.has("offline_access"), false);
  assert.match(start.setCookie, /^__Host-investor_app_aittadb_oauth=/u);
  assert.match(start.setCookie, /; Path=\//u);
  assert.match(start.setCookie, /; Max-Age=300/u);
  assert.match(start.setCookie, /; Secure/u);
  assert.match(start.setCookie, /; HttpOnly/u);
  assert.match(start.setCookie, /; SameSite=Lax/u);
  assert.doesNotMatch(start.setCookie, /Domain=/iu);
  assert.doesNotMatch(start.setCookie, new RegExp(CLIENT_SECRET, "u"));
  assert.doesNotMatch(start.setCookie, /[.]?[A-Za-z0-9_-]*one-time/iu);

  const state = authorization.searchParams.get("state");
  assert.ok(state);
  assert.doesNotMatch(start.setCookie, new RegExp(escapeRegExp(state), "u"));
  assert.doesNotMatch(
    start.setCookie,
    new RegExp(escapeRegExp(deterministicToken(128)), "u"),
  );
  const proof = await harness.service.complete(
    OWNER_SUBJECT,
    `${CALLBACK}?code=${encodeURIComponent(AUTHORIZATION_CODE)}&state=${encodeURIComponent(state)}`,
    cookieHeader(start.setCookie),
  );

  assert.deepEqual(proof, {
    ownerSubject: OWNER_SUBJECT,
    issuer: ISSUER,
    audience: CLIENT_ID,
    scopes: REQUESTED_SCOPES,
    verifiedAt: NOW.toISOString(),
    tokenExpiresAt: new Date((NOW_SECONDS + 3_600) * 1_000).toISOString(),
  });
  assert.deepEqual(harness.proofs, [proof]);
  assert.equal(harness.claims.length, 1);
  assert.match(harness.claims[0]?.fingerprint ?? "", /^[\w-]{43}$/u);
  assert.equal(harness.requests.length, 4);
  for (const request of harness.requests) {
    assert.equal(request.cookie, null);
    assert.equal(request.redirect, "manual");
  }
  assert.equal(harness.requests[0]?.authorization, null);

  const tokenRequest = harness.requests[2];
  assert.equal(tokenRequest?.url, `${ISSUER}/oauth/token`);
  assert.equal(
    tokenRequest?.authorization,
    `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
  );
  assert.deepEqual(tokenRequest?.body, {
    grant_type: "authorization_code",
    code: AUTHORIZATION_CODE,
    redirect_uri: CALLBACK,
    code_verifier: deterministicToken(128),
  });
  const introspectionRequest = harness.requests[3];
  assert.equal(introspectionRequest?.url, `${ISSUER}/oauth/introspect`);
  assert.equal(introspectionRequest?.authorization, tokenRequest?.authorization);
  assert.deepEqual(introspectionRequest?.body, {
    token: ACCESS_TOKEN,
    token_type_hint: "access_token",
  });

  const serializedProof = JSON.stringify(proof);
  for (const secret of [
    CLIENT_SECRET,
    ACCESS_TOKEN,
    AUTHORIZATION_CODE,
    deterministicToken(128),
    state,
  ]) {
    assert.doesNotMatch(serializedProof, new RegExp(escapeRegExp(secret), "u"));
  }
});

test("authorization origin is derived only from a canonical HTTPS issuer", async (t) => {
  const harness = await createHarness();
  assert.equal(harness.service.authorizationOrigin, ISSUER);

  for (const issuer of [
    "http://database.example.test",
    "https://database.example.test/authorize",
    "https://database.example.test?origin=https://foreign.example.test",
    "https://user@database.example.test",
  ]) {
    await t.test(issuer, async () => {
      await assert.rejects(
        createHarness({ issuer }),
        publicFailure("service_unavailable"),
      );
    });
  }
});

test("server transport can differ without changing the logical OAuth issuer", async () => {
  const harness = await createHarness({ transportOrigin: TRANSPORT_ORIGIN });
  assert.equal(await harness.service.availability(), true);
  const start = await harness.service.begin(OWNER_SUBJECT);
  assert.equal(new URL(start.authorizationUrl).origin, ISSUER);
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  assert.ok(state);
  const proof = await harness.service.complete(
    OWNER_SUBJECT,
    `${CALLBACK}?code=${AUTHORIZATION_CODE}&state=${encodeURIComponent(state)}`,
    cookieHeader(start.setCookie),
  );

  assert.equal(proof.issuer, ISSUER);
  assert.deepEqual(
    harness.requests.map((request) => new URL(request.url).origin),
    [
      TRANSPORT_ORIGIN,
      TRANSPORT_ORIGIN,
      TRANSPORT_ORIGIN,
      TRANSPORT_ORIGIN,
      TRANSPORT_ORIGIN,
    ],
  );
  assert.deepEqual(
    harness.requests.map((request) => new URL(request.url).pathname),
    [
      "/.well-known/openid-configuration",
      "/.well-known/openid-configuration",
      "/.well-known/openid-configuration",
      "/oauth/token",
      "/oauth/introspect",
    ],
  );
});

test("discovery must advertise the exact confidential S256 authorization path", async (t) => {
  const valid = discoveryDocument();
  const cases: readonly [string, Record<string, unknown>][] = [
    ["issuer", { ...valid, issuer: "https://foreign.example.test" }],
    ["authorization endpoint", { ...valid, authorization_endpoint: `${ISSUER}/other` }],
    ["token endpoint", { ...valid, token_endpoint: `${ISSUER}/other` }],
    ["introspection endpoint", { ...valid, introspection_endpoint: `${ISSUER}/other` }],
    ["authorization code grant", { ...valid, grant_types_supported: ["refresh_token"] }],
    ["code response", { ...valid, response_types_supported: ["token"] }],
    ["S256", { ...valid, code_challenge_methods_supported: ["plain"] }],
    ["confidential authentication", { ...valid, token_endpoint_auth_methods_supported: ["none"] }],
    ["requested scopes", { ...valid, scopes_supported: ["storage.read"] }],
  ];

  for (const [name, discovery] of cases) {
    await t.test(name, async () => {
      const harness = await createHarness({ discovery });
      assert.equal(await harness.service.availability(), false);
      assert.deepEqual(harness.availabilityFailures, ["contract"]);
      await assert.rejects(
        harness.service.begin(OWNER_SUBJECT),
        publicFailure("service_unavailable"),
      );
      assert.equal(harness.requests.length, 2);
      assert.equal(harness.claims.length, 0);
      assert.equal(harness.proofs.length, 0);
    });
  }
});

test("availability reports one fixed non-secret discovery failure phase", async (t) => {
  const cases = [
    [
      "fetch",
      { failAt: "discovery", fetchFailure: new Error(CLIENT_SECRET) },
    ],
    [
      "status_redirect",
      {
        discoveryResponse: new Response(CLIENT_SECRET, {
          status: 302,
          headers: { location: `${ISSUER}/private?token=${ACCESS_TOKEN}` },
        }),
      },
    ],
    [
      "status_unauthorized",
      { discoveryResponse: new Response(CLIENT_SECRET, { status: 401 }) },
    ],
    [
      "status_not_found",
      { discoveryResponse: new Response(CLIENT_SECRET, { status: 404 }) },
    ],
    [
      "status_rate_limited",
      { discoveryResponse: new Response(CLIENT_SECRET, { status: 429 }) },
    ],
    [
      "status_server",
      {
        discoveryResponse: new Response(CLIENT_SECRET, {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      },
    ],
    [
      "status_other",
      { discoveryResponse: new Response(CLIENT_SECRET, { status: 418 }) },
    ],
    [
      "content_type",
      {
        discoveryResponse: new Response(CLIENT_SECRET, {
          headers: { "content-type": "text/plain" },
        }),
      },
    ],
    [
      "declared_size",
      {
        discoveryResponse: new Response("{}", {
          headers: {
            "content-length": "20000",
            "content-type": "application/json",
          },
        }),
      },
    ],
    [
      "body",
      {
        discoveryResponse: new Response(null, {
          headers: { "content-type": "application/json" },
        }),
      },
    ],
    [
      "body_size",
      {
        discoveryResponse: new Response("x".repeat(16_385), {
          headers: { "content-type": "application/json" },
        }),
      },
    ],
    [
      "encoding",
      {
        discoveryResponse: new Response(Uint8Array.of(0xc3, 0x28), {
          headers: { "content-type": "application/json" },
        }),
      },
    ],
    [
      "json",
      {
        discoveryResponse: new Response("{", {
          headers: { "content-type": "application/json" },
        }),
      },
    ],
    ["document", { discoveryResponse: jsonResponse([]) }],
    [
      "contract",
      { discovery: { ...discoveryDocument(), issuer: CLIENT_SECRET } },
    ],
  ] as const;

  for (const [expected, options] of cases) {
    await t.test(expected, async () => {
      const harness = await createHarness(options);
      assert.equal(await harness.service.availability(), false);
      assert.deepEqual(harness.availabilityFailures, [expected]);
      const evidence = JSON.stringify(harness.availabilityFailures);
      for (const forbidden of [
        CLIENT_SECRET,
        CLIENT_ID,
        ISSUER,
        TRANSPORT_ORIGIN,
        CALLBACK,
        OWNER_SUBJECT,
        AUTHORIZATION_CODE,
        ACCESS_TOKEN,
      ]) {
        assert.equal(evidence.includes(forbidden), false);
      }
    });
  }

  const available = await createHarness();
  assert.equal(await available.service.availability(), true);
  assert.deepEqual(available.availabilityFailures, []);

  const throwingObserver = await createHarness({
    discovery: { ...discoveryDocument(), issuer: "https://foreign.example.test" },
    availabilityFailureObserver() {
      throw new Error(CLIENT_SECRET);
    },
  });
  assert.equal(await throwingObserver.service.availability(), false);
  assert.deepEqual(throwingObserver.availabilityFailures, ["contract"]);
});

test("availability classifies every HTTP status boundary without retaining provider data", async (t) => {
  const cases = [
    [201, "status_other"],
    [299, "status_other"],
    [300, "status_redirect"],
    [399, "status_redirect"],
    [400, "status_other"],
    [401, "status_unauthorized"],
    [403, "status_unauthorized"],
    [404, "status_not_found"],
    [405, "status_other"],
    [428, "status_other"],
    [429, "status_rate_limited"],
    [430, "status_other"],
    [499, "status_other"],
    [500, "status_server"],
    [599, "status_server"],
  ] as const;

  for (const [status, phase] of cases) {
    await t.test(String(status), async () => {
      const harness = await createHarness({
        discoveryResponse: new Response(CLIENT_SECRET, {
          status,
          headers: {
            location: `${ISSUER}/private?token=${ACCESS_TOKEN}`,
            "content-type": "application/json",
          },
        }),
      });
      assert.equal(await harness.service.availability(), false);
      assert.deepEqual(harness.availabilityFailures, [phase]);
      assert.equal(
        JSON.stringify(harness.availabilityFailures).includes(CLIENT_SECRET),
        false,
      );
    });
  }
});

test("availability reports alternate media, size, body, document, and internal failures once", async (t) => {
  const failingStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error(`${CLIENT_SECRET} ${ACCESS_TOKEN}`));
    },
  });
  const internalResponse = Object.defineProperty({}, "status", {
    get() {
      throw new Error(`${CLIENT_SECRET} ${ISSUER}`);
    },
  }) as Response;
  const cases: readonly Readonly<{
    name: string;
    phase: string;
    response: Response;
  }>[] = [
    {
      name: "missing media type",
      phase: "content_type",
      response: new Response("{}"),
    },
    {
      name: "oversized media type",
      phase: "content_type",
      response: new Response("{}", {
        headers: { "content-type": `application/json;${"a".repeat(1_025)}` },
      }),
    },
    {
      name: "malformed size declaration",
      phase: "declared_size",
      response: new Response("{}", {
        headers: {
          "content-length": "16x",
          "content-type": "application/json",
        },
      }),
    },
    {
      name: "stream read failure",
      phase: "body",
      response: new Response(failingStream, {
        headers: { "content-type": "application/json" },
      }),
    },
    {
      name: "document field ceiling",
      phase: "document",
      response: jsonResponse(Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [`field-${index}`, index]),
      )),
    },
    {
      name: "unexpected response boundary",
      phase: "internal",
      response: internalResponse,
    },
  ];

  for (const { name, phase, response } of cases) {
    await t.test(name, async () => {
      const harness = await createHarness({ discoveryResponse: response });
      assert.equal(await harness.service.availability(), false);
      assert.deepEqual(harness.availabilityFailures, [phase]);
      const evidence = JSON.stringify(harness.availabilityFailures);
      for (const forbidden of [CLIENT_SECRET, ACCESS_TOKEN, ISSUER]) {
        assert.equal(evidence.includes(forbidden), false);
      }
    });
  }
});

test("provider redirects are returned manually and rejected without following", async () => {
  const harness = await createHarness({
    discoveryResponse: new Response(null, {
      status: 302,
      headers: { location: "https://foreign.example.test/private" },
    }),
  });

  assert.equal(await harness.service.availability(), false);
  assert.deepEqual(harness.availabilityFailures, ["status_redirect"]);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0]?.redirect, "manual");
  assert.equal(harness.requests[0]?.authorization, null);
  assert.equal(harness.requests[0]?.cookie, null);
});

test("discovery, token, and introspection require exact HTTP 200", async (t) => {
  await t.test("unexpected discovery success status", async () => {
    const harness = await createHarness({
      discoveryResponse: jsonResponse(discoveryDocument(), { status: 201 }),
    });

    assert.equal(await harness.service.availability(), false);
    assert.deepEqual(harness.availabilityFailures, ["status_other"]);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.proofs.length, 0);
  });

  await t.test("unexpected token success status", async () => {
    const harness = await createHarness({
      tokenResponse: jsonResponse(tokenDocument(), { status: 202 }),
    });
    const callback = await startedCallback(harness);

    await assert.rejects(
      harness.service.complete(
        OWNER_SUBJECT,
        callback.url,
        callback.cookie,
      ),
      publicFailure("service_unavailable"),
    );
    assert.equal(harness.requests.length, 3);
    assert.equal(harness.proofs.length, 0);
  });

  await t.test("unexpected introspection success status", async () => {
    const harness = await createHarness({
      introspectionResponse: jsonResponse(introspectionDocument(), {
        status: 206,
      }),
    });
    const callback = await startedCallback(harness);

    await assert.rejects(
      harness.service.complete(
        OWNER_SUBJECT,
        callback.url,
        callback.cookie,
      ),
      publicFailure("service_unavailable"),
    );
    assert.equal(harness.requests.length, 4);
    assert.equal(harness.proofs.length, 0);
  });
});

test("provider JSON Content-Type uses one exact parsed media type", async (t) => {
  for (const contentType of [
    "application/json",
    "APPLICATION/JSON",
    "application/json ; charset = utf-8",
    'application/json;charset="utf-8"',
    'application/json; charset=UTF-8; profile="schema,version=1"',
  ]) {
    await t.test(`accepts ${contentType}`, async () => {
      const harness = await createHarness({
        discoveryResponse: jsonResponse(discoveryDocument(), {
          headers: { "content-type": contentType },
        }),
      });

      assert.equal(await harness.service.availability(), true);
      assert.deepEqual(harness.availabilityFailures, []);
    });
  }

  for (const contentType of [
    "application/jsonp",
    "application/json-seq",
    "application/json, application/json",
    "application/json; charset=utf-8; CHARSET=utf-8",
    "application/json; charset",
    "application/json; charset=",
    'application/json; charset="utf-8',
    "application/json; charset=utf-8, text/plain",
    "application /json",
    "application/json; charset=(utf-8)",
    "application/json;",
    "application/json; =utf-8",
  ]) {
    await t.test(`rejects ${contentType}`, async () => {
      const harness = await createHarness({
        discoveryResponse: jsonResponse(discoveryDocument(), {
          headers: { "content-type": contentType },
        }),
      });

      assert.equal(await harness.service.availability(), false);
      assert.deepEqual(harness.availabilityFailures, ["content_type"]);
      assert.equal(
        JSON.stringify(harness.availabilityFailures).includes(contentType),
        false,
      );
    });
  }

  for (const [name, responseKey, contentType] of [
    ["token JSON lookalike", "tokenResponse", "application/jsonp"],
    [
      "introspection JSON sequence",
      "introspectionResponse",
      "application/json-seq",
    ],
  ] as const) {
    await t.test(name, async () => {
      const document = responseKey === "tokenResponse"
        ? tokenDocument()
        : introspectionDocument();
      const harness = await createHarness({
        [responseKey]: jsonResponse(document, {
          headers: { "content-type": contentType },
        }),
      });
      const callback = await startedCallback(harness);

      await assert.rejects(
        harness.service.complete(
          OWNER_SUBJECT,
          callback.url,
          callback.cookie,
        ),
        publicFailure("service_unavailable"),
      );
      assert.equal(harness.proofs.length, 0);
    });
  }
});

test("discovery, token, and introspection bodies are bounded and strictly parsed", async (t) => {
  await t.test("oversized discovery", async () => {
    const harness = await createHarness({
      discoveryResponse: jsonResponse(
        { padding: "x".repeat(17_000) },
      ),
    });
    assert.equal(await harness.service.availability(), false);
  });

  await t.test("malformed discovery", async () => {
    const harness = await createHarness({
      discoveryResponse: new Response("{", {
        headers: { "content-type": "application/json" },
      }),
    });
    await assert.rejects(
      harness.service.begin(OWNER_SUBJECT),
      publicFailure("service_unavailable"),
    );
  });

  for (const [name, responseKey, response] of [
    ["oversized token", "tokenResponse", jsonResponse({ padding: "x".repeat(17_000) })],
    ["malformed token", "tokenResponse", jsonResponse({ access_token: ACCESS_TOKEN })],
    ["oversized introspection", "introspectionResponse", jsonResponse({ padding: "x".repeat(17_000) })],
    ["malformed introspection", "introspectionResponse", jsonResponse({ active: true })],
  ] as const) {
    await t.test(name, async () => {
      const harness = await createHarness({ [responseKey]: response });
      const callback = await startedCallback(harness);
      await assert.rejects(
        harness.service.complete(
          OWNER_SUBJECT,
          callback.url,
          callback.cookie,
        ),
        publicFailure("service_unavailable"),
      );
      assert.equal(harness.proofs.length, 0);
    });
  }
});

test("callback rejects mismatch, expiry, replay, and provider errors before credential work", async (t) => {
  await t.test("state mismatch", async () => {
    const harness = await createHarness();
    const callback = await startedCallback(harness);
    await assert.rejects(
      harness.service.complete(
        OWNER_SUBJECT,
        `${CALLBACK}?code=${AUTHORIZATION_CODE}&state=${"x".repeat(43)}`,
        callback.cookie,
      ),
      publicFailure("invalid_callback"),
    );
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.claims.length, 0);
  });

  await t.test("expired transaction", async () => {
    let current = NOW;
    const harness = await createHarness({ now: () => current });
    const callback = await startedCallback(harness);
    current = new Date(NOW.valueOf() + 301_000);
    await assert.rejects(
      harness.service.complete(OWNER_SUBJECT, callback.url, callback.cookie),
      publicFailure("invalid_callback"),
    );
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.claims.length, 0);
  });

  await t.test("different owner subject", async () => {
    const harness = await createHarness();
    const callback = await startedCallback(harness);
    await assert.rejects(
      harness.service.complete("replacement-owner", callback.url, callback.cookie),
      publicFailure("invalid_callback"),
    );
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.claims.length, 0);
  });

  await t.test("replayed transaction", async () => {
    const harness = await createHarness();
    const callback = await startedCallback(harness);
    await harness.service.complete(OWNER_SUBJECT, callback.url, callback.cookie);
    const requestsAfterSuccess = harness.requests.length;
    await assert.rejects(
      harness.service.complete(OWNER_SUBJECT, callback.url, callback.cookie),
      publicFailure("invalid_callback"),
    );
    assert.equal(harness.requests.length, requestsAfterSuccess);
    assert.equal(harness.proofs.length, 1);
  });

  await t.test("provider callback error", async () => {
    const harness = await createHarness();
    const callback = await startedCallback(harness);
    const state = new URL(callback.url).searchParams.get("state");
    assert.ok(state);
    await assert.rejects(
      harness.service.complete(
        OWNER_SUBJECT,
        `${CALLBACK}?error=access_denied&state=${encodeURIComponent(state)}`,
        callback.cookie,
      ),
      publicFailure("invalid_callback"),
    );
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.claims.length, 1);
  });
});

test("introspection rejects inactive, wrong-client, expired, and wrong-scope access tokens", async (t) => {
  const cases: readonly [string, Record<string, unknown>][] = [
    ["inactive", { active: false }],
    ["wrong client", introspectionDocument({ aud: "foreign-client" })],
    ["expired", introspectionDocument({ exp: NOW_SECONDS })],
    ["wrong scope", introspectionDocument({ scope: "storage.read storage.delete" })],
    ["noninteger issued-at", introspectionDocument({ iat: "now" })],
    ["future issued-at", introspectionDocument({ iat: NOW_SECONDS + 61 })],
    ["noninteger not-before", introspectionDocument({ nbf: "now" })],
    ["future not-before", introspectionDocument({ nbf: NOW_SECONDS + 1 })],
    ["noncanonical subject", introspectionDocument({ sub: "local-user" })],
    ["noncanonical token ID", introspectionDocument({ jti: "token-id" })],
  ];

  for (const [name, introspection] of cases) {
    await t.test(name, async () => {
      const harness = await createHarness({ introspection });
      const callback = await startedCallback(harness);
      await assert.rejects(
        harness.service.complete(
          OWNER_SUBJECT,
          callback.url,
          callback.cookie,
        ),
        publicFailure("service_unavailable"),
      );
      assert.equal(harness.proofs.length, 0);
    });
  }
});

test("credential-bearing failures expose no causes or credential values", async () => {
  const secretMessage = [
    CLIENT_SECRET,
    ACCESS_TOKEN,
    AUTHORIZATION_CODE,
    deterministicToken(128),
  ].join(" ");
  const harness = await createHarness({
    failAt: "token",
    fetchFailure: new Error(secretMessage),
  });
  const callback = await startedCallback(harness);
  let failure: unknown;
  try {
    await harness.service.complete(
      OWNER_SUBJECT,
      callback.url,
      callback.cookie,
    );
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof OAuthProofFailure);
  const serialized = `${failure.name} ${failure.message} ${String(failure.stack)}`;
  assert.equal("cause" in failure, false);
  for (const secret of secretMessage.split(" ")) {
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(secret), "u"));
  }
});

test("configuration rejects an extractable transaction cookie key", async () => {
  await assert.rejects(
    createHarness({ cookieKeyExtractable: true }),
    publicFailure("service_unavailable"),
  );
});

type ObservedRequest = Readonly<{
  url: string;
  authorization: string | null;
  cookie: string | null;
  redirect: RequestRedirect;
  body: Readonly<Record<string, string>>;
}>;

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function createHarness(
  options: Readonly<{
    discovery?: Record<string, unknown>;
    introspection?: Record<string, unknown>;
    discoveryResponse?: Response;
    tokenResponse?: Response;
    introspectionResponse?: Response;
    now?: () => Date;
    failAt?: "discovery" | "token" | "introspection";
    fetchFailure?: Error;
    cookieKeyExtractable?: boolean;
    issuer?: string;
    transportOrigin?: string;
    availabilityFailureObserver?: OAuthAvailabilityFailureObserver;
  }> = {},
) {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    "AES-GCM",
    options.cookieKeyExtractable ?? false,
    ["encrypt", "decrypt"],
  );
  const requests: ObservedRequest[] = [];
  const claims: OAuthTransactionClaim[] = [];
  const claimed = new Set<string>();
  const proofs: AittaDBOAuthProofMetadata[] = [];
  const availabilityFailures: string[] = [];
  let randomCall = 0;
  const fetch = async (
    input: string,
    init: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const body = request.method === "POST"
      ? Object.fromEntries(new URLSearchParams(await request.clone().text()))
      : {};
    requests.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      cookie: request.headers.get("cookie"),
      redirect: request.redirect,
      body,
    });
    const kind = request.url.endsWith("/.well-known/openid-configuration")
      ? "discovery"
      : request.url.endsWith("/oauth/token")
        ? "token"
        : "introspection";
    if (options.failAt === kind) throw options.fetchFailure ?? new Error("private");
    if (kind === "discovery") {
      return options.discoveryResponse ?? jsonResponse(
        options.discovery ?? discoveryDocument(),
      );
    }
    if (kind === "token") {
      return options.tokenResponse ?? jsonResponse(tokenDocument());
    }
    return options.introspectionResponse ?? jsonResponse(
      options.introspection ?? introspectionDocument(),
    );
  };
  const dependencies: AittaDBOAuthProofDependencies = {
    issuer: options.issuer ?? ISSUER,
    transportOrigin: options.transportOrigin,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    callbackUri: CALLBACK,
    allowedStorageScopes: [
      "storage.read",
      "storage.write",
      "storage.delete",
    ],
    requestedStorageScopes: REQUESTED_SCOPES,
    transactionCookieKey: key,
    transactionTtlSeconds: 300,
    transactionClaimStore: {
      async claim(claim) {
        claims.push(claim);
        if (claimed.has(claim.fingerprint)) return false;
        claimed.add(claim.fingerprint);
        return true;
      },
    },
    resultSink: {
      async recordVerifiedProof(proof) {
        proofs.push(proof);
      },
    },
    fetch,
    now: options.now ?? (() => NOW),
    randomBytes(length) {
      randomCall += 1;
      return Uint8Array.from(
        { length },
        (_, index) => (randomCall * 64 + index) % 256,
      );
    },
    availabilityFailureObserver(phase) {
      availabilityFailures.push(phase);
      options.availabilityFailureObserver?.(phase);
    },
  };
  return {
    service: createAittaDBOAuthProofService(dependencies),
    requests,
    claims,
    proofs,
    availabilityFailures,
  };
}

async function startedCallback(harness: Harness) {
  const start = await harness.service.begin(OWNER_SUBJECT);
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  assert.ok(state);
  return {
    url: `${CALLBACK}?code=${AUTHORIZATION_CODE}&state=${encodeURIComponent(state)}`,
    cookie: cookieHeader(start.setCookie),
  };
}

function discoveryDocument(): Record<string, unknown> {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    introspection_endpoint: `${ISSUER}/oauth/introspect`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [
      "none",
      "client_secret_basic",
      "client_secret_post",
    ],
    scopes_supported: [
      "openid",
      "offline_access",
      "storage.read",
      "storage.write",
      "storage.delete",
    ],
  };
}

function tokenDocument(): Record<string, unknown> {
  return {
    access_token: ACCESS_TOKEN,
    token_type: "Bearer",
    expires_in: 3_600,
    scope: REQUESTED_SCOPES.join(" "),
  };
}

function introspectionDocument(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    active: true,
    iss: ISSUER,
    sub: AITTADB_SUBJECT,
    aud: CLIENT_ID,
    exp: NOW_SECONDS + 3_600,
    iat: NOW_SECONDS,
    nbf: NOW_SECONDS,
    jti: ACCESS_TOKEN_ID,
    scope: REQUESTED_SCOPES.join(" "),
    token_use: "access",
    ...overrides,
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(value), { ...init, headers });
}

function cookieHeader(setCookie: string): string {
  return setCookie.split(";", 1)[0] ?? "";
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

function publicFailure(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof OAuthProofFailure);
    assert.equal(error.code, code);
    assert.equal("cause" in error, false);
    return true;
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
