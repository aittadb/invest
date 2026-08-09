import assert from "node:assert/strict";
import test from "node:test";

import {
  parseActorSubject,
  parseTimestamp,
  type ActorSubject,
  type Timestamp,
} from "../domain/foundation.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  MUTATION_METHOD_FIELD,
  MutationSecurityFailure,
  createBrowserMutationGuard,
  hashCsrfToken,
  toPublicMutationSecurityFailure,
  type BrowserMutationGuard,
  type TrustedMutationSession,
} from "../http/mutation-security.ts";

const APP_ORIGIN = "https://campaign.example";
const SECOND_APP_ORIGIN = "https://campaign-preview.example";
const NOW = new Date("2026-08-09T12:00:00.000Z");
const CSRF_TOKEN = "csrf_token_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

test("missing trusted identity stays unauthenticated despite spoofed headers", async () => {
  const guard = createBrowserMutationGuard({
    allowedOrigins: [APP_ORIGIN],
    resolveSession: async () => null,
    now: () => NOW,
  });
  const request = jsonRequest(
    { participantSubject: "spoofed-subject" },
    {
      "oai-authenticated-user-id": "spoofed-user",
      "oai-authenticated-user-email": "spoofed@example.invalid",
      [MUTATION_CSRF_HEADER]: CSRF_TOKEN,
    },
  );

  const failure = await captureFailure(() => guard(request));
  assert.deepEqual(toPublicMutationSecurityFailure(failure), {
    status: 401,
    body: {
      error: {
        code: "AUTHENTICATION_REQUIRED",
        message: "Sign in is required.",
      },
    },
  });
  assert.doesNotMatch(
    JSON.stringify(toPublicMutationSecurityFailure(failure)),
    /spoofed|csrf_token/u,
  );
});

test("malformed sessions, bodies, media types, and bounds fail before use", async () => {
  const validSession = await session();
  const malformedSession = {
    ...validSession,
    actor: { type: "participant", subject: " malformed " },
  } as unknown as TrustedMutationSession;
  const malformedGuard = configuredGuard(async () => malformedSession);
  assert.equal(
    (await captureFailure(() => malformedGuard(jsonRequest({})))).code,
    "AUTHENTICATION_REQUIRED",
  );

  const guard = configuredGuard(async () => validSession, { maxBodyBytes: 128 });
  const unsupported = requestWithBody("plain", "text/plain");
  assert.equal(
    (await captureFailure(() => guard(unsupported))).code,
    "UNSUPPORTED_MEDIA_TYPE",
  );

  const malformedJson = requestWithBody("{", "application/json", {
    [MUTATION_CSRF_HEADER]: CSRF_TOKEN,
  });
  assert.equal(
    (await captureFailure(() => guard(malformedJson))).code,
    "INVALID_REQUEST",
  );

  const duplicateForm = requestWithBody(
    `${MUTATION_CSRF_FIELD}=${CSRF_TOKEN}&note=one&note=two`,
    "application/x-www-form-urlencoded",
  );
  assert.equal(
    (await captureFailure(() => guard(duplicateForm))).code,
    "INVALID_REQUEST",
  );

  const oversized = requestWithBody(
    JSON.stringify({ note: "x".repeat(256) }),
    "application/json",
    { [MUTATION_CSRF_HEADER]: CSRF_TOKEN },
  );
  assert.equal(
    (await captureFailure(() => guard(oversized))).code,
    "PAYLOAD_TOO_LARGE",
  );

  const fieldBoundGuard = configuredGuard(async () => validSession, {
    maxFields: 2,
  });
  assert.equal(
    (
      await captureFailure(() =>
        fieldBoundGuard(jsonRequest({ one: 1, two: 2, three: 3 }))
      )
    ).code,
    "INVALID_REQUEST",
  );
});

test("spoofed request identity cannot replace the resolver actor", async () => {
  const trusted = await session({ subject: "oidc:trusted-participant" });
  const guard = configuredGuard(async () => trusted);
  const request = jsonRequest(
    {
      participantSubject: "oidc:request-controlled",
      owner: true,
    },
    {
      "oai-authenticated-user-id": "request-controlled",
      "oai-authenticated-user-email": "owner@example.invalid",
      "x-investor-app-csrf-hash": await hashCsrfToken("different_token_0123456789ABCDEFGHIJKLMN"),
      [MUTATION_CSRF_HEADER]: CSRF_TOKEN,
    },
  );

  const verified = await guard(request);
  assert.equal(verified.actor.type, "participant");
  assert.equal(verified.actor.subject, "oidc:trusted-participant");
  assert.equal(verified.body.participantSubject, "oidc:request-controlled");
  assert.equal(verified.body.owner, true);
});

test("expired session and CSRF state share one non-disclosing rejection", async () => {
  const expiredSession = await session({
    expiresAt: "2026-08-09T11:59:59.999Z",
  });
  const expiredCsrf = await session({
    csrfExpiresAt: "2026-08-09T11:59:59.999Z",
  });

  const sessionFailure = await captureFailure(() =>
    configuredGuard(async () => expiredSession)(jsonRequest({})),
  );
  const csrfFailure = await captureFailure(() =>
    configuredGuard(async () => expiredCsrf)(jsonRequest({})),
  );
  const missingCsrfFailure = await captureFailure(() =>
    configuredGuard(async () => session())(
      jsonRequest({}, { [MUTATION_CSRF_HEADER]: "" }),
    ),
  );

  assert.equal(sessionFailure.code, "REQUEST_REJECTED");
  assert.deepEqual(
    toPublicMutationSecurityFailure(sessionFailure),
    toPublicMutationSecurityFailure(csrfFailure),
  );
  assert.deepEqual(
    toPublicMutationSecurityFailure(sessionFailure),
    toPublicMutationSecurityFailure(missingCsrfFailure),
  );
  assert.equal(toPublicMutationSecurityFailure(sessionFailure).status, 403);
});

test("cross-origin, null-origin, and malformed-origin requests are rejected", async () => {
  const guard = configuredGuard(async () => session());
  const origins = [
    "https://attacker.example",
    "null",
    "https://campaign.example/path",
  ];

  const failures = await Promise.all(
    origins.map((origin) =>
      captureFailure(() => guard(jsonRequest({}, { origin })))
    ),
  );
  assert.deepEqual(
    failures.map((failure) => failure.code),
    ["REQUEST_REJECTED", "REQUEST_REJECTED", "REQUEST_REJECTED"],
  );
  for (const failure of failures) {
    assert.doesNotMatch(
      JSON.stringify(toPublicMutationSecurityFailure(failure)),
      /attacker|path|campaign\.example/u,
    );
  }
});

test("valid JSON and form requests return one verified generic boundary", async () => {
  const trusted = await session({
    type: "owner",
    subject: "oidc:configured-owner",
  });
  const guard = configuredGuard(async () => trusted);

  const json = await guard(
    jsonRequest(
      { revision: 4, publish: true },
      { [MUTATION_CSRF_HEADER]: CSRF_TOKEN },
      "PATCH",
      SECOND_APP_ORIGIN,
    ),
  );
  assert.deepEqual(json, {
    actor: { type: "owner", subject: "oidc:configured-owner" },
    method: "PATCH",
    mediaType: "application/json",
    body: { revision: 4, publish: true },
  });

  const form = await guard(
    requestWithBody(
      new URLSearchParams({
        [MUTATION_CSRF_FIELD]: CSRF_TOKEN,
        [MUTATION_METHOD_FIELD]: "DELETE",
        revision: "4",
        confirmation: "withdraw",
      }).toString(),
      "application/x-www-form-urlencoded; charset=UTF-8",
    ),
  );
  assert.deepEqual(form, {
    actor: { type: "owner", subject: "oidc:configured-owner" },
    method: "DELETE",
    mediaType: "application/x-www-form-urlencoded",
    body: { revision: "4", confirmation: "withdraw" },
  });
  assert.equal(Object.isFrozen(json), true);
  assert.equal(Object.isFrozen(json.actor), true);
  assert.equal(Object.isFrozen(form.body), true);

  const reservedName = await guard(
    requestWithBody(
      `${MUTATION_CSRF_FIELD}=${CSRF_TOKEN}&__proto__=ordinary-field`,
      "application/x-www-form-urlencoded",
    ),
  );
  assert.equal(Object.hasOwn(reservedName.body, "__proto__"), true);
  assert.equal(reservedName.body.__proto__, "ordinary-field");
  assert.equal(Object.getPrototypeOf(reservedName.body), Object.prototype);
});

type SessionOptions = Readonly<{
  type?: "participant" | "owner";
  subject?: string;
  expiresAt?: string;
  csrfExpiresAt?: string;
}>;

async function session(
  options: SessionOptions = {},
): Promise<TrustedMutationSession> {
  return Object.freeze({
    actor: Object.freeze({
      type: options.type ?? "participant",
      subject: actorSubject(options.subject ?? "oidc:participant"),
    }),
    expiresAt: timestamp(options.expiresAt ?? "2026-08-09T13:00:00.000Z"),
    csrf: Object.freeze({
      tokenHash: await hashCsrfToken(CSRF_TOKEN),
      expiresAt: timestamp(
        options.csrfExpiresAt ?? "2026-08-09T12:30:00.000Z",
      ),
    }),
  });
}

function configuredGuard(
  resolveSession: () => Promise<TrustedMutationSession | null>,
  limits: Readonly<{ maxBodyBytes?: number; maxFields?: number }> = {},
): BrowserMutationGuard {
  return createBrowserMutationGuard({
    allowedOrigins: [APP_ORIGIN, SECOND_APP_ORIGIN],
    resolveSession,
    now: () => NOW,
    ...limits,
  });
}

function jsonRequest(
  body: Readonly<Record<string, unknown>>,
  headers: HeadersInit = { [MUTATION_CSRF_HEADER]: CSRF_TOKEN },
  method = "POST",
  origin = APP_ORIGIN,
): Request {
  return requestWithBody(JSON.stringify(body), "application/json", headers, method, origin);
}

function requestWithBody(
  body: BodyInit,
  contentType: string,
  headers: HeadersInit = {},
  method = "POST",
  origin = APP_ORIGIN,
): Request {
  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has("origin")) requestHeaders.set("origin", origin);
  requestHeaders.set("content-type", contentType);
  return new Request(`${APP_ORIGIN}/participant/action`, {
    method,
    headers: requestHeaders,
    body,
  });
}

function actorSubject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  assert(parsed.ok);
  return parsed.value;
}

function timestamp(value: string): Timestamp {
  const parsed = parseTimestamp(value);
  assert(parsed.ok);
  return parsed.value;
}

async function captureFailure(
  operation: () => Promise<unknown>,
): Promise<MutationSecurityFailure> {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof MutationSecurityFailure);
    return error;
  }
  assert.fail("Expected a mutation security failure.");
}
