import assert from "node:assert/strict";
import test from "node:test";

import {
  createBrowserMutationSession,
  DEFAULT_BROWSER_MUTATION_COOKIE_PREFIX,
  type BrowserMutationProof,
  type BrowserMutationReplayClaim,
  type BrowserMutationSession,
  type TrustedSitesMutationIdentity,
} from "../http/browser-mutation-session.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  MutationSecurityFailure,
} from "../http/mutation-security.ts";

const APP_ORIGIN = "https://campaign.example.test";
const OTHER_ORIGIN = "https://other.example.test";
const NOW = new Date("2026-08-09T12:00:00.000Z");
const TTL_SECONDS = 300;
const PARTICIPANT = Object.freeze({
  type: "participant",
  subject: "sites:participant-01",
}) satisfies TrustedSitesMutationIdentity;
const FOREIGN_PARTICIPANT = Object.freeze({
  type: "participant",
  subject: "sites:participant-02",
}) satisfies TrustedSitesMutationIdentity;
const OWNER = Object.freeze({
  type: "owner",
  subject: PARTICIPANT.subject,
}) satisfies TrustedSitesMutationIdentity;

test("encrypted actor capability gives forms and JSON equivalent one-time proofs", async () => {
  const harness = await configuredHarness();
  const formProof = await issue(harness.session);

  assert.match(formProof.token, /^[A-Za-z0-9_-]{65}$/u);
  assert.equal(formProof.expiresAt, "2026-08-09T12:05:00.000Z");
  assert.match(
    formProof.setCookie,
    new RegExp(
      `^${DEFAULT_BROWSER_MUTATION_COOKIE_PREFIX}[A-Za-z0-9_-]{22}=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+;`,
      "u",
    ),
  );
  assert.match(formProof.setCookie, /Path=\//u);
  assert.match(formProof.setCookie, /Max-Age=300/u);
  assert.match(formProof.setCookie, /Secure/u);
  assert.match(formProof.setCookie, /HttpOnly/u);
  assert.match(formProof.setCookie, /SameSite=Strict/u);
  assert.doesNotMatch(formProof.setCookie, /Domain=/iu);
  assert.doesNotMatch(formProof.setCookie, new RegExp(formProof.token, "u"));
  assert.doesNotMatch(
    formProof.setCookie,
    /participant-01|campaign\.example/u,
  );

  const form = await harness.session.verifyMutation(
    formRequest(formProof, { body: { note: "Founder interest" } }),
    PARTICIPANT,
    APP_ORIGIN,
  );
  assert.deepEqual(
    {
      actor: form.actor,
      method: form.method,
      mediaType: form.mediaType,
      body: form.body,
    },
    {
      actor: PARTICIPANT,
      method: "POST",
      mediaType: "application/x-www-form-urlencoded",
      body: { note: "Founder interest" },
    },
  );
  assert.match(
    form.clearCookie,
    new RegExp(`^${cookieName(formProof)}=; Path=/; Max-Age=0;`, "u"),
  );

  const jsonProof = await issue(harness.session);
  const json = await harness.session.verifyMutation(
    jsonRequest(jsonProof, { amount_minor: 25_000 }, "PATCH"),
    PARTICIPANT,
    APP_ORIGIN,
  );
  assert.deepEqual(
    {
      actor: json.actor,
      method: json.method,
      mediaType: json.mediaType,
      body: json.body,
    },
    {
      actor: PARTICIPANT,
      method: "PATCH",
      mediaType: "application/json",
      body: { amount_minor: 25_000 },
    },
  );
  assert.equal(Object.isFrozen(json), true);
  assert.equal(Object.isFrozen(json.body), true);

  assert.equal(harness.claims.calls.length, 2);
  for (const claim of harness.claims.calls) {
    assert.match(
      claim.capabilityId,
      /^browser-mutation:v1:[A-Za-z0-9_-]{43}$/u,
    );
    assert.equal(claim.expiresAt, "2026-08-09T12:05:00.000Z");
    assert.doesNotMatch(
      JSON.stringify(claim),
      /participant|campaign\.example|amount|Founder/u,
    );
  }
});

test("anonymous and malformed trusted identities remain unauthenticated", async () => {
  const harness = await configuredHarness();
  const spoofedRequest = new Request(`${APP_ORIGIN}/participant`, {
    headers: {
      "oai-authenticated-user-id": PARTICIPANT.subject,
      "oai-authenticated-user-email": "owner@example.invalid",
    },
  });
  assert.equal(
    (await captureFailure(() =>
      harness.session.issue(spoofedRequest, null, APP_ORIGIN)
    )).code,
    "AUTHENTICATION_REQUIRED",
  );

  const proof = await issue(harness.session);
  assert.equal(
    (await captureFailure(() =>
      harness.session.verifyMutation(
        jsonRequest(proof, {}, "POST", {
          extraHeaders: {
            "oai-authenticated-user-id": PARTICIPANT.subject,
          },
        }),
        null,
        APP_ORIGIN,
      )
    )).code,
    "AUTHENTICATION_REQUIRED",
  );

  const malformed = {
    type: "participant",
    subject: " sites:participant-01 ",
  } as TrustedSitesMutationIdentity;
  assert.equal(
    (await captureFailure(() =>
      harness.session.issue(
        new Request(`${APP_ORIGIN}/participant`),
        malformed,
        APP_ORIGIN,
      )
    )).code,
    "AUTHENTICATION_REQUIRED",
  );
  assert.equal(harness.claims.calls.length, 0);
});

test("actor, request origin, browser origin, and cookie name are exact bindings", async () => {
  const key = await aesKey(11);
  const harness = await configuredHarness({ key });
  const proof = await issue(harness.session);

  const foreign = await captureFailure(() =>
    harness.session.verifyMutation(
      jsonRequest(proof, {}),
      FOREIGN_PARTICIPANT,
      APP_ORIGIN,
    )
  );
  assert.equal(foreign.code, "REQUEST_REJECTED");

  const roleSubstitution = await captureFailure(() =>
    harness.session.verifyMutation(
      jsonRequest(proof, {}),
      OWNER,
      APP_ORIGIN,
    )
  );
  assert.equal(roleSubstitution.code, "REQUEST_REJECTED");

  const configuredOrigin = await captureFailure(() =>
    harness.session.verifyMutation(
      jsonRequest(proof, {}),
      PARTICIPANT,
      OTHER_ORIGIN,
    )
  );
  assert.equal(configuredOrigin.code, "REQUEST_REJECTED");

  const requestOrigin = await captureFailure(() =>
    harness.session.verifyMutation(
      jsonRequest(proof, {}, "POST", { requestOrigin: OTHER_ORIGIN }),
      PARTICIPANT,
      APP_ORIGIN,
    )
  );
  assert.equal(requestOrigin.code, "REQUEST_REJECTED");

  const browserOrigin = await captureFailure(() =>
    harness.session.verifyMutation(
      jsonRequest(proof, {}, "POST", { originHeader: OTHER_ORIGIN }),
      PARTICIPANT,
      APP_ORIGIN,
    )
  );
  assert.equal(browserOrigin.code, "REQUEST_REJECTED");

  const otherDeployment = await configuredHarness({
    key,
    appOrigin: OTHER_ORIGIN,
    claims: harness.claims,
  });
  const boundCiphertext = await captureFailure(() =>
    otherDeployment.session.verifyMutation(
      jsonRequest(proof, {}, "POST", {
        requestOrigin: OTHER_ORIGIN,
        originHeader: OTHER_ORIGIN,
      }),
      PARTICIPANT,
      OTHER_ORIGIN,
    )
  );
  assert.equal(boundCiphertext.code, "REQUEST_REJECTED");

  const renamedId = replaceFirstCharacter(proof.token.slice(0, 22));
  const renamedToken = renamedId + proof.token.slice(22);
  const renamedCookie = `${DEFAULT_BROWSER_MUTATION_COOKIE_PREFIX}${renamedId}=${cookieValue(proof)}`;
  const cookieBinding = await captureFailure(() =>
    harness.session.verifyMutation(
      jsonRequest(proof, {}, "POST", {
        token: renamedToken,
        cookie: renamedCookie,
      }),
      PARTICIPANT,
      APP_ORIGIN,
    )
  );
  assert.equal(cookieBinding.code, "REQUEST_REJECTED");
  assert.equal(harness.claims.calls.length, 0);
});

test("expiry, tampering, substitution, and malformed state fail before replay claim", async () => {
  let now = NOW;
  const harness = await configuredHarness({ now: () => now });
  const expiredProof = await issue(harness.session);
  now = new Date(NOW.valueOf() + TTL_SECONDS * 1_000);
  assert.equal(
    (await captureFailure(() =>
      harness.session.verifyMutation(
        jsonRequest(expiredProof, {}),
        PARTICIPANT,
        APP_ORIGIN,
      )
    )).code,
    "REQUEST_REJECTED",
  );

  now = NOW;
  const tamperedProof = await issue(harness.session);
  const encrypted = cookieValue(tamperedProof);
  const tamperedCookie = `${cookieName(tamperedProof)}=${
    encrypted.slice(0, -1)
  }${encrypted.endsWith("A") ? "B" : "A"}`;
  assert.equal(
    (await captureFailure(() =>
      harness.session.verifyMutation(
        jsonRequest(tamperedProof, {}, "POST", { cookie: tamperedCookie }),
        PARTICIPANT,
        APP_ORIGIN,
      )
    )).code,
    "REQUEST_REJECTED",
  );

  const substitutedProof = await issue(harness.session);
  const substitutedToken = substitutedProof.token.slice(0, 22) + "A".repeat(43);
  assert.equal(
    (await captureFailure(() =>
      harness.session.verifyMutation(
        jsonRequest(substitutedProof, {}, "POST", {
          token: substitutedToken,
        }),
        PARTICIPANT,
        APP_ORIGIN,
      )
    )).code,
    "REQUEST_REJECTED",
  );

  const malformedProof = await issue(harness.session);
  assert.equal(
    (await captureFailure(() =>
      harness.session.verifyMutation(
        jsonRequest(malformedProof, {}, "POST", { token: "not.valid" }),
        PARTICIPANT,
        APP_ORIGIN,
      )
    )).code,
    "REQUEST_REJECTED",
  );
  assert.equal(
    (await captureFailure(() =>
      harness.session.verifyMutation(
        jsonRequest(malformedProof, {}, "POST", { cookie: "" }),
        PARTICIPANT,
        APP_ORIGIN,
      )
    )).code,
    "REQUEST_REJECTED",
  );
  const duplicateCookie = cookieHeader(malformedProof);
  assert.equal(
    (await captureFailure(() =>
      harness.session.verifyMutation(
        jsonRequest(malformedProof, {}, "POST", {
          cookie: `${duplicateCookie}; ${duplicateCookie}`,
        }),
        PARTICIPANT,
        APP_ORIGIN,
      )
    )).code,
    "REQUEST_REJECTED",
  );
  assert.equal(harness.claims.calls.length, 0);
});

test("one proof cannot be replayed and concurrent use has one winner", async () => {
  const harness = await configuredHarness();
  const proof = await issue(harness.session);
  const attempts = await Promise.allSettled([
    harness.session.verifyMutation(
      jsonRequest(proof, { revision: 1 }),
      PARTICIPANT,
      APP_ORIGIN,
    ),
    harness.session.verifyMutation(
      jsonRequest(proof, { revision: 1 }),
      PARTICIPANT,
      APP_ORIGIN,
    ),
  ]);

  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = attempts.find((result) => result.status === "rejected");
  assert(rejected?.status === "rejected");
  assert(rejected.reason instanceof MutationSecurityFailure);
  assert.equal(rejected.reason.code, "REQUEST_REJECTED");

  assert.equal(
    (await captureFailure(() =>
      harness.session.verifyMutation(
        jsonRequest(proof, { revision: 1 }),
        PARTICIPANT,
        APP_ORIGIN,
      )
    )).code,
    "REQUEST_REJECTED",
  );
  assert.equal(harness.claims.claimed.size, 1);
});

test("concurrent refreshes use independent cookies and remain independently usable", async () => {
  const harness = await configuredHarness();
  const [first, second] = await Promise.all([
    issue(harness.session),
    issue(harness.session),
  ]);
  assert.notEqual(first.token, second.token);
  assert.notEqual(cookieName(first), cookieName(second));

  const browserCookies = `${cookieHeader(first)}; ${cookieHeader(second)}`;
  const results = await Promise.all([
    harness.session.verifyMutation(
      jsonRequest(first, { action: "first" }, "POST", {
        cookie: browserCookies,
      }),
      PARTICIPANT,
      APP_ORIGIN,
    ),
    harness.session.verifyMutation(
      formRequest(second, {
        cookie: browserCookies,
        body: { action: "second" },
      }),
      PARTICIPANT,
      APP_ORIGIN,
    ),
  ]);
  assert.deepEqual(results.map((result) => result.body.action).sort(), [
    "first",
    "second",
  ]);
  assert.equal(harness.claims.claimed.size, 2);
});

test("a valid target proof survives many accumulated valid proof cookies", async () => {
  const harness = await configuredHarness();
  const proofs: BrowserMutationProof[] = [];
  for (let index = 0; index < 32; index += 1) {
    proofs.push(await issue(harness.session));
  }
  const target = proofs.at(-1);
  assert(target);
  const browserCookies = proofs.map(cookieHeader).join("; ");
  assert(browserCookies.length > 8_192);

  const verified = await harness.session.verifyMutation(
    jsonRequest(target, { action: "target" }, "POST", {
      cookie: browserCookies,
    }),
    PARTICIPANT,
    APP_ORIGIN,
  );

  assert.equal(verified.body.action, "target");
  assert.equal(harness.claims.calls.length, 1);
  assert.equal(harness.claims.claimed.size, 1);
});

test("many outstanding app proofs do not deny an independently valid form", async () => {
  const harness = await configuredHarness();
  const proofs: BrowserMutationProof[] = [];
  for (let index = 0; index < 64; index += 1) {
    proofs.push(await issue(harness.session));
  }
  const browserCookies = proofs.map(cookieHeader).join("; ");
  assert(browserCookies.length > 8_192);

  const first = proofs[0];
  const last = proofs.at(-1);
  assert(first);
  assert(last);
  const results = await Promise.all([
    harness.session.verifyMutation(
      jsonRequest(first, { action: "first" }, "POST", {
        cookie: browserCookies,
      }),
      PARTICIPANT,
      APP_ORIGIN,
    ),
    harness.session.verifyMutation(
      formRequest(last, {
        cookie: browserCookies,
        body: { action: "last" },
      }),
      PARTICIPANT,
      APP_ORIGIN,
    ),
  ]);
  assert.deepEqual(results.map((result) => result.body.action).sort(), [
    "first",
    "last",
  ]);
  assert.equal(harness.claims.claimed.size, 2);
});

test("malformed and oversized requests fail closed without consuming proof", async () => {
  const harness = await configuredHarness({ maxBodyBytes: 192 });
  const jsonProof = await issue(harness.session);
  const oversizedJson = jsonRequest(
    jsonProof,
    { note: "x".repeat(256) },
  );
  assert.equal(
    (await captureFailure(() =>
      harness.session.verifyMutation(
        oversizedJson,
        PARTICIPANT,
        APP_ORIGIN,
      )
    )).code,
    "PAYLOAD_TOO_LARGE",
  );

  const formProof = await issue(harness.session);
  const oversizedForm = formRequest(formProof, {
    body: { note: "x".repeat(256) },
  });
  assert.equal(
    (await captureFailure(() =>
      harness.session.verifyMutation(
        oversizedForm,
        PARTICIPANT,
        APP_ORIGIN,
      )
    )).code,
    "PAYLOAD_TOO_LARGE",
  );

  const malformedJsonProof = await issue(harness.session);
  const malformedJson = rawRequest(
    malformedJsonProof,
    "{",
    "application/json",
  );
  assert.equal(
    (await captureFailure(() =>
      harness.session.verifyMutation(
        malformedJson,
        PARTICIPANT,
        APP_ORIGIN,
      )
    )).code,
    "INVALID_REQUEST",
  );

  const duplicateProof = await issue(harness.session);
  const duplicateForm = rawRequest(
    duplicateProof,
    `${MUTATION_CSRF_FIELD}=${duplicateProof.token}&${MUTATION_CSRF_FIELD}=${duplicateProof.token}`,
    "application/x-www-form-urlencoded",
  );
  assert.equal(
    (await captureFailure(() =>
      harness.session.verifyMutation(
        duplicateForm,
        PARTICIPANT,
        APP_ORIGIN,
      )
    )).code,
    "REQUEST_REJECTED",
  );

  const cookieProof = await issue(harness.session);
  assert.equal(
    (await captureFailure(() =>
      harness.session.verifyMutation(
        jsonRequest(cookieProof, {}, "POST", {
          cookie: `padding=${"x".repeat(8_300)}; ${cookieHeader(cookieProof)}`,
        }),
        PARTICIPANT,
        APP_ORIGIN,
      )
    )).code,
    "REQUEST_REJECTED",
  );

  const excessiveCookieCountProof = await issue(harness.session);
  const excessiveCookieCount = [
    ...Array.from({ length: 128 }, (_, index) => `padding_${index}=x`),
    cookieHeader(excessiveCookieCountProof),
  ].join("; ");
  assert.equal(
    (await captureFailure(() =>
      harness.session.verifyMutation(
        jsonRequest(excessiveCookieCountProof, {}, "POST", {
          cookie: excessiveCookieCount,
        }),
        PARTICIPANT,
        APP_ORIGIN,
      )
    )).code,
    "REQUEST_REJECTED",
  );

  const mediaProof = await issue(harness.session);
  assert.equal(
    (await captureFailure(() =>
      harness.session.verifyMutation(
        rawRequest(mediaProof, "plain", "text/plain"),
        PARTICIPANT,
        APP_ORIGIN,
      )
    )).code,
    "UNSUPPORTED_MEDIA_TYPE",
  );
  assert.equal(harness.claims.calls.length, 0);
});

test("route verification limits stay narrower than the shared session ceiling", async () => {
  const harness = await configuredHarness({
    maxBodyBytes: 1_024,
    maxFields: 16,
  });
  const oversizedProof = await issue(harness.session);
  const oversizedWithMalformedToken = rawRequest(
    oversizedProof,
    `${MUTATION_CSRF_FIELD}=bad&note=${"x".repeat(256)}`,
    "application/x-www-form-urlencoded",
  );
  assert.equal(
    (await captureFailure(() =>
      harness.session.verifyMutation(
        oversizedWithMalformedToken,
        PARTICIPANT,
        APP_ORIGIN,
        { maxBodyBytes: 192, maxFields: 16 },
      )
    )).code,
    "PAYLOAD_TOO_LARGE",
  );

  const fieldProof = await issue(harness.session);
  assert.equal(
    (await captureFailure(() =>
      harness.session.verifyMutation(
        formRequest(fieldProof, {
          body: { first: "1", second: "2", third: "3" },
        }),
        PARTICIPANT,
        APP_ORIGIN,
        { maxBodyBytes: 1_024, maxFields: 3 },
      )
    )).code,
    "INVALID_REQUEST",
  );

  const invalidLimitsProof = await issue(harness.session);
  assert.equal(
    (await captureFailure(() =>
      harness.session.verifyMutation(
        rawRequest(
          invalidLimitsProof,
          `${MUTATION_CSRF_FIELD}=bad`,
          "application/x-www-form-urlencoded",
        ),
        PARTICIPANT,
        APP_ORIGIN,
        { maxBodyBytes: 1_025, maxFields: 16 },
      )
    )).code,
    "SERVICE_UNAVAILABLE",
  );
  assert.equal(harness.claims.calls.length, 0);
});

test("per-route verification limits can only narrow shared fields and repeats", async () => {
  const harness = await configuredHarness({
    maxBodyBytes: 512,
    maxFields: 4,
    repeatedFormFields: ["tag", "choice"],
  });
  const invalidLimits = [
    { maxBodyBytes: 513, maxFields: 4, repeatedFormFields: ["tag"] },
    { maxBodyBytes: 256, maxFields: 5, repeatedFormFields: ["tag"] },
    { maxBodyBytes: 256, maxFields: 3, repeatedFormFields: ["other"] },
    { maxBodyBytes: 256, maxFields: 1, repeatedFormFields: ["tag", "choice"] },
    { maxBodyBytes: 256, maxFields: 3, repeatedFormFields: ["tag", "tag"] },
  ] as const;
  for (const limits of invalidLimits) {
    const malformed = new Request(`${APP_ORIGIN}/participant/action`, {
      method: "POST",
      headers: {
        origin: APP_ORIGIN,
        "content-type": "application/json",
        [MUTATION_CSRF_HEADER]: "not-a-capability",
      },
      body: "{",
    });
    assert.equal(
      (await captureFailure(() => harness.session.verifyMutation(
        malformed,
        PARTICIPANT,
        APP_ORIGIN,
        limits,
      ))).code,
      "SERVICE_UNAVAILABLE",
    );
  }
  assert.equal(harness.claims.calls.length, 0);
  assert.equal(harness.claims.claimed.size, 0);

  const proof = await issue(harness.session);
  const request = rawRequest(
    proof,
    `${MUTATION_CSRF_FIELD}=${proof.token}&tag=first&tag=second`,
    "application/x-www-form-urlencoded",
  );
  const verified = await harness.session.verifyMutation(
    request,
    PARTICIPANT,
    APP_ORIGIN,
    {
      maxBodyBytes: 256,
      maxFields: 3,
      repeatedFormFields: ["tag"],
    },
  );
  assert.deepEqual(verified.body.tag, ["first", "second"]);
  assert.equal(harness.claims.claimed.size, 1);
});

test("route validation runs after proof verification and before replay claim", async () => {
  const harness = await configuredHarness();
  const proof = await issue(harness.session);
  const validateBeforeReplayClaim = (
    request: Readonly<{ body: Readonly<Record<string, unknown>> }>,
  ) => request.body.operationId === "opaque-server-value";

  const rejected = await captureFailure(() =>
    harness.session.verifyMutation(
      jsonRequest(proof, { operationId: "private stable text" }),
      PARTICIPANT,
      APP_ORIGIN,
      { validateBeforeReplayClaim },
    )
  );
  assert.equal(rejected.code, "INVALID_REQUEST");
  assert.doesNotMatch(rejected.message, /private|stable|text/u);
  assert.equal(harness.claims.calls.length, 0);
  assert.equal(harness.claims.claimed.size, 0);

  const accepted = await harness.session.verifyMutation(
    jsonRequest(proof, { operationId: "opaque-server-value" }),
    PARTICIPANT,
    APP_ORIGIN,
    { validateBeforeReplayClaim },
  );
  assert.equal(accepted.body.operationId, "opaque-server-value");
  assert.equal(harness.claims.calls.length, 1);
  assert.equal(harness.claims.claimed.size, 1);
});

test("missing, shared, or unsuitable hosted key material creates no capability", async () => {
  const claims = new AtomicClaims();
  assert.throws(
    () => createSession(undefined, claims),
    /configuration/u,
  );
  assert.throws(
    () => createSession(null, claims),
    /configuration/u,
  );
  assert.throws(
    () => createSession(null, null),
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
    () => createSession(extractable, claims),
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
    () => createSession(encryptOnly, claims),
    /configuration/u,
  );

  const first = await configuredHarness({ key: await aesKey(21) });
  const proof = await issue(first.session);
  const second = await configuredHarness({ key: await aesKey(22) });
  assert.equal(
    (await captureFailure(() =>
      second.session.verifyMutation(
        jsonRequest(proof, {}),
        PARTICIPANT,
        APP_ORIGIN,
      )
    )).code,
    "REQUEST_REJECTED",
  );
});

test("randomness and durable claim failures are closed service failures", async () => {
  const key = await aesKey(31);
  const claims = new AtomicClaims();
  const badRandom = createBrowserMutationSession({
    appOrigin: APP_ORIGIN,
    encryptionKey: key,
    claimReplay: (claim) => claims.claim(claim),
    now: () => NOW,
    ttlSeconds: TTL_SECONDS,
    randomBytes: (length) => new Uint8Array(length - 1),
  });
  assert.equal(
    (await captureFailure(() => issue(badRandom))).code,
    "SERVICE_UNAVAILABLE",
  );

  const unavailableClaims = await configuredHarness({
    key,
    claimReplay: async () => {
      throw new Error("closed dependency detail");
    },
  });
  const proof = await issue(unavailableClaims.session);
  const failure = await captureFailure(() =>
    unavailableClaims.session.verifyMutation(
      jsonRequest(proof, {}),
      PARTICIPANT,
      APP_ORIGIN,
    )
  );
  assert.equal(failure.code, "SERVICE_UNAVAILABLE");
  assert.doesNotMatch(failure.message, /dependency|detail/u);

  const malformedClaims = await configuredHarness({
    key,
    claimReplay: (async () => "yes") as unknown as (
      claim: BrowserMutationReplayClaim,
    ) => Promise<boolean>,
  });
  const malformedProof = await issue(malformedClaims.session);
  assert.equal(
    (await captureFailure(() =>
      malformedClaims.session.verifyMutation(
        jsonRequest(malformedProof, {}),
        PARTICIPANT,
        APP_ORIGIN,
      )
    )).code,
    "SERVICE_UNAVAILABLE",
  );
});

class AtomicClaims {
  readonly calls: BrowserMutationReplayClaim[] = [];
  readonly claimed = new Set<string>();

  async claim(claim: BrowserMutationReplayClaim): Promise<boolean> {
    this.calls.push(claim);
    if (this.claimed.has(claim.capabilityId)) return false;
    this.claimed.add(claim.capabilityId);
    return true;
  }
}

type HarnessOptions = Readonly<{
  key?: CryptoKey;
  appOrigin?: string;
  now?: () => Date;
  maxBodyBytes?: number;
  maxFields?: number;
  repeatedFormFields?: readonly string[];
  claims?: AtomicClaims;
  claimReplay?: (claim: BrowserMutationReplayClaim) => Promise<boolean>;
}>;

async function configuredHarness(
  options: HarnessOptions = {},
): Promise<Readonly<{ session: BrowserMutationSession; claims: AtomicClaims }>> {
  const claims = options.claims ?? new AtomicClaims();
  const key = options.key ?? await aesKey(11);
  let randomCall = 0;
  const session = createBrowserMutationSession({
    appOrigin: options.appOrigin ?? APP_ORIGIN,
    encryptionKey: key,
    claimReplay: options.claimReplay ?? ((claim) => claims.claim(claim)),
    now: options.now ?? (() => NOW),
    ttlSeconds: TTL_SECONDS,
    randomBytes(length) {
      randomCall += 1;
      return Uint8Array.from(
        { length },
        (_, index) => (randomCall * 47 + index) % 256,
      );
    },
    ...(options.maxBodyBytes === undefined
      ? {}
      : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.maxFields === undefined
      ? {}
      : { maxFields: options.maxFields }),
    ...(options.repeatedFormFields === undefined
      ? {}
      : { repeatedFormFields: options.repeatedFormFields }),
  });
  return Object.freeze({ session, claims });
}

function createSession(
  encryptionKey: CryptoKey | null | undefined,
  claims: AtomicClaims | null,
): BrowserMutationSession {
  return createBrowserMutationSession({
    appOrigin: APP_ORIGIN,
    encryptionKey,
    claimReplay: claims === null ? null : (claim) => claims.claim(claim),
    now: () => NOW,
    ttlSeconds: TTL_SECONDS,
    randomBytes: (length) => new Uint8Array(length),
  });
}

async function aesKey(seed: number): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

async function issue(
  session: BrowserMutationSession,
): Promise<BrowserMutationProof> {
  return session.issue(
    new Request(`${APP_ORIGIN}/participant`),
    PARTICIPANT,
    APP_ORIGIN,
  );
}

type RequestOverrides = Readonly<{
  token?: string;
  cookie?: string;
  requestOrigin?: string;
  originHeader?: string;
  extraHeaders?: HeadersInit;
}>;

function jsonRequest(
  proof: BrowserMutationProof,
  body: Readonly<Record<string, unknown>>,
  method = "POST",
  overrides: RequestOverrides = {},
): Request {
  const requestOrigin = overrides.requestOrigin ?? APP_ORIGIN;
  const headers = new Headers(overrides.extraHeaders);
  headers.set("cookie", overrides.cookie ?? cookieHeader(proof));
  headers.set("origin", overrides.originHeader ?? requestOrigin);
  headers.set("content-type", "application/json");
  headers.set(MUTATION_CSRF_HEADER, overrides.token ?? proof.token);
  return new Request(`${requestOrigin}/participant/action`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

type FormRequestOptions = RequestOverrides &
  Readonly<{ body?: Readonly<Record<string, string>> }>;

function formRequest(
  proof: BrowserMutationProof,
  options: FormRequestOptions = {},
): Request {
  const requestOrigin = options.requestOrigin ?? APP_ORIGIN;
  const headers = new Headers(options.extraHeaders);
  headers.set("cookie", options.cookie ?? cookieHeader(proof));
  headers.set("origin", options.originHeader ?? requestOrigin);
  headers.set("content-type", "application/x-www-form-urlencoded");
  return new Request(`${requestOrigin}/participant/action`, {
    method: "POST",
    headers,
    body: new URLSearchParams({
      [MUTATION_CSRF_FIELD]: options.token ?? proof.token,
      ...(options.body ?? {}),
    }),
  });
}

function rawRequest(
  proof: BrowserMutationProof,
  body: string,
  contentType: string,
): Request {
  return new Request(`${APP_ORIGIN}/participant/action`, {
    method: "POST",
    headers: {
      cookie: cookieHeader(proof),
      origin: APP_ORIGIN,
      "content-type": contentType,
      [MUTATION_CSRF_HEADER]: proof.token,
    },
    body,
  });
}

function cookieHeader(proof: BrowserMutationProof): string {
  return proof.setCookie.split(";", 1)[0] ?? "";
}

function cookieName(proof: BrowserMutationProof): string {
  return cookieHeader(proof).split("=", 1)[0] ?? "";
}

function cookieValue(proof: BrowserMutationProof): string {
  const header = cookieHeader(proof);
  return header.slice(header.indexOf("=") + 1);
}

function replaceFirstCharacter(value: string): string {
  return `${value.startsWith("A") ? "B" : "A"}${value.slice(1)}`;
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
  assert.fail("Expected browser mutation session verification to fail.");
}
