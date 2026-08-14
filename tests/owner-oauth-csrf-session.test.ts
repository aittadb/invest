import assert from "node:assert/strict";
import test from "node:test";

import { OWNER_OAUTH_PROOF_PATH } from "../domain/owner-oauth-proof-resource.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  MutationSecurityFailure,
} from "../http/mutation-security.ts";
import {
  createOwnerOAuthCsrfSession,
  DEFAULT_OWNER_OAUTH_CSRF_COOKIE,
  type OwnerOAuthCsrfProof,
  type OwnerOAuthCsrfSession,
} from "../http/owner-oauth-csrf-session.ts";

const APP_ORIGIN = "https://campaign.example.test";
const OTHER_ORIGIN = "https://other.example.test";
const OWNER_SUBJECT = "sites:configured-owner";
const OTHER_OWNER = "sites:other-owner";
const NOW = new Date("2026-08-09T12:00:00.000Z");
const TTL_SECONDS = 300;

test("encrypted owner session supports equivalent form and JSON CSRF proofs", async () => {
  const session = await configuredSession();
  const htmlProof = await issue(session);

  assert.match(htmlProof.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(
    htmlProof.setCookie,
    new RegExp(`^${DEFAULT_OWNER_OAUTH_CSRF_COOKIE}=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+;`, "u"),
  );
  assert.match(htmlProof.setCookie, /Path=\/owner\/aittadb-connection/u);
  assert.match(htmlProof.setCookie, /Max-Age=300/u);
  assert.match(htmlProof.setCookie, /Secure/u);
  assert.match(htmlProof.setCookie, /HttpOnly/u);
  assert.match(htmlProof.setCookie, /SameSite=Lax/u);
  assert.doesNotMatch(htmlProof.setCookie, /Domain=/iu);
  assert.doesNotMatch(htmlProof.setCookie, new RegExp(htmlProof.token, "u"));
  assert.doesNotMatch(htmlProof.setCookie, /configured-owner|campaign\.example/u);

  const form = await session.verifyMutation(
    formRequest(htmlProof),
    OWNER_SUBJECT,
    APP_ORIGIN,
  );
  assert.deepEqual(form, {
    actor: { type: "owner", subject: OWNER_SUBJECT },
    method: "POST",
    mediaType: "application/x-www-form-urlencoded",
    body: {},
  });

  const jsonProof = await issue(session);
  assert.notEqual(jsonProof.token, htmlProof.token);
  const json = await session.verifyMutation(
    jsonRequest(jsonProof),
    OWNER_SUBJECT,
    APP_ORIGIN,
  );
  assert.deepEqual(json, {
    actor: { type: "owner", subject: OWNER_SUBJECT },
    method: "POST",
    mediaType: "application/json",
    body: {},
  });
});

test("tampering, token substitution, and duplicate cookies fail closed", async () => {
  const session = await configuredSession();
  const proof = await issue(session);
  const cookie = cookieHeader(proof.setCookie);
  const last = cookie.at(-1);
  assert.ok(last);
  const tamperedCookie = `${cookie.slice(0, -1)}${last === "A" ? "B" : "A"}`;

  const tampered = await captureFailure(() =>
    session.verifyMutation(
      formRequest(proof, { cookie: tamperedCookie }),
      OWNER_SUBJECT,
      APP_ORIGIN,
    )
  );
  assert.equal(tampered.code, "REQUEST_REJECTED");

  const substituted = await captureFailure(() =>
    session.verifyMutation(
      formRequest(proof, { token: "A".repeat(43) }),
      OWNER_SUBJECT,
      APP_ORIGIN,
    )
  );
  assert.equal(substituted.code, "REQUEST_REJECTED");

  const duplicate = await captureFailure(() =>
    session.verifyMutation(
      formRequest(proof, { cookie: `${cookie}; ${cookie}` }),
      OWNER_SUBJECT,
      APP_ORIGIN,
    )
  );
  assert.equal(duplicate.code, "REQUEST_REJECTED");

  const missing = await captureFailure(() =>
    session.verifyMutation(
      formRequest(proof, { cookie: "unrelated=value" }),
      OWNER_SUBJECT,
      APP_ORIGIN,
    )
  );
  assert.equal(missing.code, "AUTHENTICATION_REQUIRED");
});

test("expiry, actor mismatch, and every origin mismatch fail closed", async () => {
  let now = NOW;
  const key = await aesKey();
  const session = configuredSessionWithKey(key, () => now, APP_ORIGIN);
  const proof = await issue(session);

  now = new Date(NOW.valueOf() + TTL_SECONDS * 1_000);
  const expired = await captureFailure(() =>
    session.verifyMutation(
      formRequest(proof),
      OWNER_SUBJECT,
      APP_ORIGIN,
    )
  );
  assert.equal(expired.code, "REQUEST_REJECTED");

  now = NOW;
  const actorMismatch = await captureFailure(() =>
    session.verifyMutation(
      formRequest(proof),
      OTHER_OWNER,
      APP_ORIGIN,
    )
  );
  assert.equal(actorMismatch.code, "REQUEST_REJECTED");

  const configuredOriginMismatch = await captureFailure(() =>
    session.verifyMutation(
      formRequest(proof),
      OWNER_SUBJECT,
      OTHER_ORIGIN,
    )
  );
  assert.equal(configuredOriginMismatch.code, "REQUEST_REJECTED");

  const requestUrlMismatch = await captureFailure(() =>
    session.verifyMutation(
      formRequest(proof, { requestOrigin: OTHER_ORIGIN }),
      OWNER_SUBJECT,
      APP_ORIGIN,
    )
  );
  assert.equal(requestUrlMismatch.code, "REQUEST_REJECTED");

  const browserOriginMismatch = await captureFailure(() =>
    session.verifyMutation(
      formRequest(proof, { originHeader: OTHER_ORIGIN }),
      OWNER_SUBJECT,
      APP_ORIGIN,
    )
  );
  assert.equal(browserOriginMismatch.code, "REQUEST_REJECTED");

  const otherDeployment = configuredSessionWithKey(key, () => NOW, OTHER_ORIGIN);
  const boundCiphertext = await captureFailure(() =>
    otherDeployment.verifyMutation(
      formRequest(proof, {
        requestOrigin: OTHER_ORIGIN,
        originHeader: OTHER_ORIGIN,
      }),
      OWNER_SUBJECT,
      OTHER_ORIGIN,
    )
  );
  assert.equal(boundCiphertext.code, "REQUEST_REJECTED");
});

test("missing or unsuitable key material cannot create a capability", async () => {
  assert.throws(
    () => configuredSessionWithKey(undefined, () => NOW, APP_ORIGIN),
    /configuration/u,
  );

  const extractable = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from({ length: 32 }, (_, index) => index),
    "AES-GCM",
    true,
    ["encrypt", "decrypt"],
  );
  assert.throws(
    () => configuredSessionWithKey(extractable, () => NOW, APP_ORIGIN),
    /configuration/u,
  );

  const encryptOnly = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  assert.throws(
    () => configuredSessionWithKey(encryptOnly, () => NOW, APP_ORIGIN),
    /configuration/u,
  );
});

async function configuredSession(): Promise<OwnerOAuthCsrfSession> {
  return configuredSessionWithKey(await aesKey(), () => NOW, APP_ORIGIN);
}

function configuredSessionWithKey(
  cookieKey: CryptoKey | null | undefined,
  now: () => Date,
  appOrigin: string,
): OwnerOAuthCsrfSession {
  let randomCall = 0;
  return createOwnerOAuthCsrfSession({
    appOrigin,
    cookieKey,
    now,
    ttlSeconds: TTL_SECONDS,
    randomBytes(length) {
      randomCall += 1;
      return Uint8Array.from(
        { length },
        (_, index) => (randomCall * 47 + index) % 256,
      );
    },
  });
}

async function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from({ length: 32 }, (_, index) => index + 11),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

async function issue(
  session: OwnerOAuthCsrfSession,
): Promise<OwnerOAuthCsrfProof> {
  return session.issue(
    new Request(`${APP_ORIGIN}${OWNER_OAUTH_PROOF_PATH}`),
    OWNER_SUBJECT,
    APP_ORIGIN,
  );
}

type RequestOverrides = Readonly<{
  cookie?: string;
  token?: string;
  requestOrigin?: string;
  originHeader?: string;
}>;

function formRequest(
  proof: OwnerOAuthCsrfProof,
  overrides: RequestOverrides = {},
): Request {
  const requestOrigin = overrides.requestOrigin ?? APP_ORIGIN;
  return new Request(`${requestOrigin}${OWNER_OAUTH_PROOF_PATH}`, {
    method: "POST",
    headers: {
      cookie: overrides.cookie ?? cookieHeader(proof.setCookie),
      origin: overrides.originHeader ?? APP_ORIGIN,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      [MUTATION_CSRF_FIELD]: overrides.token ?? proof.token,
    }),
  });
}

function jsonRequest(proof: OwnerOAuthCsrfProof): Request {
  return new Request(`${APP_ORIGIN}${OWNER_OAUTH_PROOF_PATH}`, {
    method: "POST",
    headers: {
      cookie: cookieHeader(proof.setCookie),
      origin: APP_ORIGIN,
      "content-type": "application/json",
      [MUTATION_CSRF_HEADER]: proof.token,
    },
    body: JSON.stringify({}),
  });
}

function cookieHeader(setCookie: string): string {
  return setCookie.split(";", 1)[0] ?? "";
}

async function captureFailure(
  operation: () => Promise<unknown>,
): Promise<MutationSecurityFailure> {
  try {
    await operation();
    assert.fail("Expected owner OAuth CSRF verification to fail.");
  } catch (error) {
    assert(error instanceof MutationSecurityFailure);
    return error;
  }
}
