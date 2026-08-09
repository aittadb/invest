import assert from "node:assert/strict";
import test from "node:test";

import {
  AittaDBServiceTokenFailure,
  createAittaDBServiceTokenProvider,
  type AittaDBServiceTokenDependencies,
} from "../services/aittadb-service-token.ts";

const ISSUER = "https://database.example.test";
const TRANSPORT_ORIGIN = "https://database-runtime.example.test";
const BROWSER_ORIGIN = "https://browser.example.test";
const CLIENT_ID = "investor-app-service";
const CLIENT_SECRET = "hosted-service-secret";
const ACCESS_TOKEN = "private-service-access-token";
const REPLACEMENT_TOKEN = "replacement-service-access-token";
const NOW = new Date("2026-08-09T12:00:00.000Z");
const SCOPES = ["storage.read", "storage.write"] as const;

type CapturedRequest = Readonly<{
  url: string;
  method: string;
  redirect: RequestRedirect;
  headers: Headers;
  body: Readonly<Record<string, string>>;
  signal: AbortSignal;
}>;

test("defaults backend transport to the logical issuer and caches the token", async () => {
  const harness = createHarness();

  assert.equal(await harness.provider.accessToken(), ACCESS_TOKEN);
  assert.equal(await harness.provider.accessToken(), ACCESS_TOKEN);
  assert.equal(harness.requests.length, 1);

  const request = harness.requests[0];
  assert.ok(request);
  assert.equal(request.url, `${ISSUER}/oauth/token`);
  assert.equal(request.method, "POST");
  assert.equal(request.redirect, "manual");
  assert.equal(request.headers.get("accept"), "application/json");
  assert.equal(request.headers.get("cache-control"), "no-store");
  assert.equal(
    request.headers.get("content-type"),
    "application/x-www-form-urlencoded",
  );
  assert.equal(
    request.headers.get("authorization"),
    `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
  );
  assert.equal(request.headers.get("cookie"), null);
  assert.equal(request.headers.get("origin"), null);
  assert.equal(request.headers.get("referer"), null);
  assert.deepEqual(request.body, {
    grant_type: "client_credentials",
    scope: SCOPES.join(" "),
  });
  assert.equal("client_id" in request.body, false);
  assert.equal("client_secret" in request.body, false);
  assert.equal("redirect_uri" in request.body, false);

  assert.deepEqual(Object.keys(harness.provider), ["accessToken"]);
  assert.equal(Object.isFrozen(harness.provider), true);
  const serialized = JSON.stringify(harness.provider);
  assert.doesNotMatch(serialized, secretPattern(CLIENT_SECRET));
  assert.doesNotMatch(serialized, secretPattern(ACCESS_TOKEN));
  assert.doesNotMatch(serialized, secretPattern(ISSUER));
  assert.doesNotMatch(serialized, secretPattern(TRANSPORT_ORIGIN));
});

test("uses a distinct transport origin only for the backend token URL", async () => {
  const harness = createHarness({ transportOrigin: TRANSPORT_ORIGIN });

  assert.equal(await harness.provider.accessToken(), ACCESS_TOKEN);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0]?.url, `${TRANSPORT_ORIGIN}/oauth/token`);
  assert.equal(harness.requests[0]?.body.grant_type, "client_credentials");
  assert.equal(harness.requests[0]?.body.scope, SCOPES.join(" "));

  const requestProjection = JSON.stringify({
    method: harness.requests[0]?.method,
    body: harness.requests[0]?.body,
  });
  assert.doesNotMatch(requestProjection, secretPattern(ISSUER));
  assert.doesNotMatch(requestProjection, secretPattern(TRANSPORT_ORIGIN));
  assert.deepEqual(Object.keys(harness.provider), ["accessToken"]);
  assert.doesNotMatch(JSON.stringify(harness.provider), secretPattern(ISSUER));
  assert.doesNotMatch(
    JSON.stringify(harness.provider),
    secretPattern(TRANSPORT_ORIGIN),
  );
});

test("ignores browser-shaped arguments and never derives transport from a request", async () => {
  const harness = createHarness({ transportOrigin: TRANSPORT_ORIGIN });
  const browserRequest = new Request(`${BROWSER_ORIGIN}/private/path`, {
    headers: {
      Cookie: "private-browser-cookie=value",
      Origin: BROWSER_ORIGIN,
      Referer: `${BROWSER_ORIGIN}/previous`,
    },
  });
  const backendOnlyAccessToken = harness.provider.accessToken as unknown as (
    request: Request,
    browserOrigin: string,
  ) => Promise<string>;

  assert.equal(
    await backendOnlyAccessToken(browserRequest, BROWSER_ORIGIN),
    ACCESS_TOKEN,
  );
  const request = harness.requests[0];
  assert.equal(request?.url, `${TRANSPORT_ORIGIN}/oauth/token`);
  assert.equal(request?.headers.get("origin"), null);
  assert.equal(request?.headers.get("referer"), null);
  assert.equal(request?.headers.get("cookie"), null);
  assert.equal(JSON.stringify(request?.body).includes(BROWSER_ORIGIN), false);
});

test("accepts only explicit canonical least-privilege storage scope subsets", async (t) => {
  for (const scopes of [
    ["storage.read"],
    ["storage.write"],
    ["storage.delete"],
    ["storage.read", "storage.write"],
    ["storage.read", "storage.delete"],
    ["storage.write", "storage.delete"],
    ["storage.read", "storage.write", "storage.delete"],
  ] as const) {
    await t.test(scopes.join(" "), async () => {
      const harness = createHarness({ storageScopes: scopes });
      assert.equal(await harness.provider.accessToken(), ACCESS_TOKEN);
      assert.equal(harness.requests[0]?.body.scope, scopes.join(" "));
    });
  }

  const invalidScopes: readonly unknown[] = [
    [],
    ["storage.write", "storage.read"],
    ["storage.read", "storage.read"],
    ["openid"],
    ["storage.read", "offline_access"],
    ["storage.read", "storage.write", "storage.delete", "storage.read"],
    "storage.read",
  ];
  for (const storageScopes of invalidScopes) {
    assert.throws(
      () => createHarness({ storageScopes }).provider,
      publicFailure,
    );
  }
});

test("rejects malformed runtime configuration with one redacted failure", () => {
  const cases: readonly Partial<Record<keyof AittaDBServiceTokenDependencies, unknown>>[] = [
    { issuer: undefined },
    { issuer: "http://database.example.test" },
    { issuer: `${ISSUER}/oauth` },
    { issuer: `${ISSUER}?secret=${CLIENT_SECRET}` },
    { issuer: "https://user@database.example.test" },
    { issuer: "not a URL" },
    { transportOrigin: "" },
    { transportOrigin: "http://database-runtime.example.test" },
    { transportOrigin: `${TRANSPORT_ORIGIN}/oauth` },
    { transportOrigin: `${TRANSPORT_ORIGIN}?private=value` },
    { transportOrigin: `${TRANSPORT_ORIGIN}#private` },
    { transportOrigin: "https://user@database-runtime.example.test" },
    { clientId: undefined },
    { clientId: "" },
    { clientId: "client:ambiguous" },
    { clientId: "client\nidentifier" },
    { clientSecret: undefined },
    { clientSecret: "too-short" },
    { clientSecret: `${CLIENT_SECRET}\n` },
    { storageScopes: undefined },
    { expirySkewSeconds: undefined },
    { expirySkewSeconds: 0 },
    { expirySkewSeconds: 301 },
    { expirySkewSeconds: 1.5 },
    { requestTimeoutMs: undefined },
    { requestTimeoutMs: 0 },
    { requestTimeoutMs: 60_001 },
    { requestTimeoutMs: 1.5 },
    { fetch: undefined },
    { fetch: null },
    { now: undefined },
    { now: null },
  ];

  for (const values of cases) {
    assert.throws(
      () => createHarness(values).provider,
      publicFailure,
      JSON.stringify(Object.keys(values)),
    );
  }
});

test("renews exactly at the expiry-skew boundary", async () => {
  let now = NOW;
  const harness = createHarness({
    now: () => now,
    responses: [
      jsonResponse(tokenDocument({ expires_in: 120 })),
      jsonResponse(tokenDocument({
        access_token: REPLACEMENT_TOKEN,
        expires_in: 120,
      })),
    ],
  });

  assert.equal(await harness.provider.accessToken(), ACCESS_TOKEN);
  now = new Date(NOW.valueOf() + 89_000);
  assert.equal(await harness.provider.accessToken(), ACCESS_TOKEN);
  assert.equal(harness.requests.length, 1);

  now = new Date(NOW.valueOf() + 90_000);
  assert.equal(await harness.provider.accessToken(), REPLACEMENT_TOKEN);
  assert.equal(harness.requests.length, 2);
});

test("clock rollback and clock failure never extend cached-token authority", async () => {
  let now = NOW;
  let clockFails = false;
  const harness = createHarness({
    now() {
      if (clockFails) throw new Error(`${CLIENT_SECRET} ${ACCESS_TOKEN}`);
      return now;
    },
    responses: [
      jsonResponse(tokenDocument()),
      jsonResponse(tokenDocument({ access_token: REPLACEMENT_TOKEN })),
    ],
  });

  assert.equal(await harness.provider.accessToken(), ACCESS_TOKEN);
  now = new Date(NOW.valueOf() - 1_000);
  assert.equal(await harness.provider.accessToken(), REPLACEMENT_TOKEN);
  assert.equal(harness.requests.length, 2);

  clockFails = true;
  await assert.rejects(harness.provider.accessToken(), publicFailure);
  assert.equal(harness.requests.length, 2);
});

test("coalesces concurrent acquisition into one credential-bearing request", async () => {
  const response = deferred<Response>();
  const harness = createHarness({ responses: [response.promise] });

  const acquisitions = [
    harness.provider.accessToken(),
    harness.provider.accessToken(),
    harness.provider.accessToken(),
  ];
  assert.equal(harness.fetchCalls(), 1);
  response.resolve(jsonResponse(tokenDocument()));

  assert.deepEqual(await Promise.all(acquisitions), [
    ACCESS_TOKEN,
    ACCESS_TOKEN,
    ACCESS_TOKEN,
  ]);
  assert.equal(harness.requests.length, 1);
});

test("coalesces a failed acquisition, clears it, and permits a fresh retry", async () => {
  const failure = deferred<Response>();
  const harness = createHarness({
    responses: [
      failure.promise,
      jsonResponse(tokenDocument()),
    ],
  });

  const first = harness.provider.accessToken();
  const second = harness.provider.accessToken();
  assert.equal(harness.fetchCalls(), 1);
  failure.reject(new Error(`${CLIENT_SECRET} ${ACCESS_TOKEN}`));
  await Promise.all([
    assert.rejects(first, publicFailure),
    assert.rejects(second, publicFailure),
  ]);

  assert.equal(await harness.provider.accessToken(), ACCESS_TOKEN);
  assert.equal(harness.fetchCalls(), 2);
});

test("aborts a stalled acquisition, clears renewal, and permits a retry", async () => {
  const stalled = deferred<Response>();
  const harness = createHarness({
    requestTimeoutMs: 10,
    responses: [stalled.promise, jsonResponse(tokenDocument())],
  });

  await assert.rejects(harness.provider.accessToken(), publicFailure);
  assert.equal(harness.fetchCalls(), 1);
  assert.equal(harness.requests[0]?.signal.aborted, true);

  assert.equal(await harness.provider.accessToken(), ACCESS_TOKEN);
  assert.equal(harness.fetchCalls(), 2);
});

test("fails closed during renewal instead of falling back to the old token", async () => {
  let now = NOW;
  const harness = createHarness({
    now: () => now,
    responses: [
      jsonResponse(tokenDocument({ expires_in: 60 })),
      new Error(`${CLIENT_SECRET} ${ACCESS_TOKEN}`),
      jsonResponse(tokenDocument({ access_token: REPLACEMENT_TOKEN })),
    ],
  });

  assert.equal(await harness.provider.accessToken(), ACCESS_TOKEN);
  now = new Date(NOW.valueOf() + 30_000);
  await assert.rejects(harness.provider.accessToken(), publicFailure);
  assert.equal(harness.fetchCalls(), 2);
  assert.equal(await harness.provider.accessToken(), REPLACEMENT_TOKEN);
  assert.equal(harness.fetchCalls(), 3);
});

test("rejects redirects, non-200 statuses, and non-JSON media types", async (t) => {
  const cases: readonly [string, Response][] = [
    [
      "redirect",
      new Response(null, {
        status: 302,
        headers: { location: `https://foreign.example.test/${CLIENT_SECRET}` },
      }),
    ],
    ["created", jsonResponse(tokenDocument(), { status: 201 })],
    [
      "provider error",
      new Response(`${CLIENT_SECRET} ${ACCESS_TOKEN}`, {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    ],
    [
      "plain text",
      new Response(JSON.stringify(tokenDocument()), {
        headers: { "content-type": "text/plain" },
      }),
    ],
    [
      "invalid JSON parameter",
      new Response(JSON.stringify(tokenDocument()), {
        headers: { "content-type": "application/json; private=value" },
      }),
    ],
    [
      "missing type",
      new Response(JSON.stringify(tokenDocument())),
    ],
  ];

  for (const [name, response] of cases) {
    await t.test(name, async () => {
      const harness = createHarness({ responses: [response] });
      await assert.rejects(harness.provider.accessToken(), publicFailure);
      assert.equal(harness.requests[0]?.redirect, "manual");
    });
  }
});

test("bounds response declarations, streams, UTF-8, JSON, and shape", async (t) => {
  const oversizedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(16_385));
      controller.close();
    },
  });
  const invalidUtf8 = Uint8Array.from([0xc3, 0x28]);
  const tooManyKeys = Object.fromEntries(
    Array.from({ length: 33 }, (_, index) => [`field_${index}`, index]),
  );
  const cases: readonly [string, Response][] = [
    [
      "oversized declaration",
      new Response("{}", {
        headers: {
          "content-length": "16385",
          "content-type": "application/json",
        },
      }),
    ],
    [
      "malformed declaration",
      new Response("{}", {
        headers: {
          "content-length": "private",
          "content-type": "application/json",
        },
      }),
    ],
    [
      "oversized stream",
      new Response(oversizedStream, {
        headers: { "content-type": "application/json" },
      }),
    ],
    [
      "missing body",
      new Response(null, {
        headers: { "content-type": "application/json" },
      }),
    ],
    [
      "invalid UTF-8",
      new Response(invalidUtf8, {
        headers: { "content-type": "application/json" },
      }),
    ],
    [
      "malformed JSON",
      new Response(`{"private":"${CLIENT_SECRET}"`, {
        headers: { "content-type": "application/json" },
      }),
    ],
    ["array", jsonResponse([])],
    ["null", jsonResponse(null)],
    ["too many fields", jsonResponse(tooManyKeys)],
  ];

  for (const [name, response] of cases) {
    await t.test(name, async () => {
      const harness = createHarness({ responses: [response] });
      await assert.rejects(harness.provider.accessToken(), publicFailure);
    });
  }
});

test("strictly validates token fields, lifetime, and exact returned scope", async (t) => {
  const valid = tokenDocument();
  const cases: readonly [string, Record<string, unknown>][] = [
    ["extra field", { ...valid, refresh_token: ACCESS_TOKEN }],
    [
      "missing field",
      Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "scope")),
    ],
    ["empty token", { ...valid, access_token: "" }],
    ["whitespace token", { ...valid, access_token: "token with space" }],
    ["oversized token", { ...valid, access_token: "x".repeat(4_097) }],
    ["wrong token type", { ...valid, token_type: "DPoP" }],
    ["non-string token type", { ...valid, token_type: 1 }],
    ["zero lifetime", { ...valid, expires_in: 0 }],
    ["fractional lifetime", { ...valid, expires_in: 30.5 }],
    ["long lifetime", { ...valid, expires_in: 3_601 }],
    ["skew-only lifetime", { ...valid, expires_in: 30 }],
    ["missing scope", { ...valid, scope: "storage.read" }],
    ["added scope", { ...valid, scope: `${SCOPES.join(" ")} storage.delete` }],
    ["reordered scope", { ...valid, scope: "storage.write storage.read" }],
    ["duplicate scope", { ...valid, scope: "storage.read storage.read" }],
    ["non-string scope", { ...valid, scope: SCOPES }],
  ];

  for (const [name, document] of cases) {
    await t.test(name, async () => {
      const harness = createHarness({ responses: [jsonResponse(document)] });
      await assert.rejects(harness.provider.accessToken(), publicFailure);
    });
  }

  const caseInsensitiveBearer = createHarness({
    responses: [jsonResponse(tokenDocument({ token_type: "bearer" }))],
  });
  assert.equal(
    await caseInsensitiveBearer.provider.accessToken(),
    ACCESS_TOKEN,
  );
});

test("redacts transport, response, parsing, and clock exceptions", async () => {
  const privateValues = [
    CLIENT_SECRET,
    ACCESS_TOKEN,
    ISSUER,
    TRANSPORT_ORIGIN,
  ];
  const cases = [
    createHarness({
      responses: [new Error(privateValues.join(" "))],
    }).provider.accessToken(),
    createHarness({
      responses: [
        new Response(JSON.stringify({ error: privateValues.join(" ") }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ],
    }).provider.accessToken(),
    createHarness({
      now() {
        throw new Error(privateValues.join(" "));
      },
    }).provider.accessToken(),
  ];

  for (const operation of cases) {
    await assert.rejects(operation, (error: unknown) => {
      assert.equal(publicFailure(error), true);
      const serialized = `${JSON.stringify(error)}\n${String(error)}`;
      for (const value of privateValues) {
        assert.doesNotMatch(serialized, secretPattern(value));
      }
      return true;
    });
  }
});

function createHarness(
  options: Readonly<{
    issuer?: unknown;
    transportOrigin?: unknown;
    clientId?: unknown;
    clientSecret?: unknown;
    storageScopes?: unknown;
    expirySkewSeconds?: unknown;
    requestTimeoutMs?: unknown;
    fetch?: unknown;
    now?: unknown;
    responses?: readonly (Response | Error | Promise<Response>)[];
  }> = {},
) {
  const requests: CapturedRequest[] = [];
  let fetchCalls = 0;
  const responses = [...(options.responses ?? [])];
  const responseScope = Array.isArray(options.storageScopes)
    ? options.storageScopes.join(" ")
    : SCOPES.join(" ");
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    fetchCalls += 1;
    const request = new Request(input, init);
    const body = Object.freeze(Object.fromEntries(
      new URLSearchParams(await request.clone().text()),
    ));
    requests.push(Object.freeze({
      url: request.url,
      method: request.method,
      redirect: request.redirect,
      headers: new Headers(request.headers),
      body,
      signal: request.signal,
    }));
    const next = responses.shift() ?? jsonResponse(
      tokenDocument({ scope: responseScope }),
    );
    if (next instanceof Error) throw next;
    return await next;
  };
  const dependencies = {
    issuer: "issuer" in options ? options.issuer : ISSUER,
    transportOrigin: "transportOrigin" in options
      ? options.transportOrigin
      : undefined,
    clientId: "clientId" in options ? options.clientId : CLIENT_ID,
    clientSecret: "clientSecret" in options
      ? options.clientSecret
      : CLIENT_SECRET,
    storageScopes: "storageScopes" in options
      ? options.storageScopes
      : SCOPES,
    expirySkewSeconds: "expirySkewSeconds" in options
      ? options.expirySkewSeconds
      : 30,
    requestTimeoutMs: "requestTimeoutMs" in options
      ? options.requestTimeoutMs
      : 1_000,
    fetch: "fetch" in options ? options.fetch : fetch,
    now: "now" in options ? options.now : () => NOW,
  } as AittaDBServiceTokenDependencies;

  return {
    provider: createAittaDBServiceTokenProvider(dependencies),
    requests,
    fetchCalls: () => fetchCalls,
  };
}

function tokenDocument(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    access_token: ACCESS_TOKEN,
    token_type: "Bearer",
    expires_in: 300,
    scope: SCOPES.join(" "),
    ...overrides,
  };
}

function jsonResponse(
  value: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(value), { ...init, headers });
}

function publicFailure(error: unknown): boolean {
  assert.ok(error instanceof AittaDBServiceTokenFailure);
  assert.equal(error.name, "AittaDBServiceTokenFailure");
  assert.equal(error.code, "service_unavailable");
  assert.equal(error.message, "AittaDB service authentication is unavailable.");
  assert.equal("cause" in error, false);
  const serialized = `${JSON.stringify(error)}\n${String(error)}\n${error.stack ?? ""}`;
  for (const value of [
    CLIENT_SECRET,
    ACCESS_TOKEN,
    REPLACEMENT_TOKEN,
    ISSUER,
    TRANSPORT_ORIGIN,
  ]) {
    assert.doesNotMatch(serialized, secretPattern(value));
  }
  return true;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function secretPattern(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u");
}
