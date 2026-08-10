import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseActorSubject,
  parseStableId,
  parseTimestamp,
  type ActorSubject,
  type Timestamp,
} from "../domain/foundation.ts";
import type { AuthorizedParticipantAccess } from "../domain/participant-home-resource.ts";
import {
  PARTICIPANT_PROFILE_PATH,
  ParticipantProfileResourceError,
  createParticipantProfileCapabilityModel,
} from "../domain/participant-profile-resource.ts";
import {
  parseParticipantAccount,
  type ParticipantAccount,
  type ParticipantProfile,
} from "../domain/participant-profile.ts";
import {
  INVESTOR_APP_API_VERSION,
  INVESTOR_APP_MEDIA_TYPE,
} from "../domain/public-campaign-resource.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  MUTATION_METHOD_FIELD,
  MutationSecurityFailure,
  hashCsrfToken,
  type TrustedMutationSession,
} from "../http/mutation-security.ts";
import {
  createBrowserMutationSession,
  type BrowserMutationProof,
  type BrowserMutationReplayClaim,
  type TrustedSitesMutationIdentity,
} from "../http/browser-mutation-session.ts";
import {
  DevelopmentInMemoryParticipantRepository,
  type ParticipantProfileSnapshot,
  type ParticipantRepository,
} from "../repositories/in-memory-participant-repository.ts";
import type { ApplicationRouteContext } from "../worker/contracts.ts";
import { createParticipantRouteHandler } from "../worker/routes/participant.ts";
import {
  MAX_PROFILE_DELETE_MUTATION_BYTES,
  MAX_PROFILE_DELETE_MUTATION_FIELDS,
  MAX_PROFILE_PATCH_MUTATION_BYTES,
  MAX_PROFILE_PATCH_MUTATION_FIELDS,
  MAX_PROFILE_POST_MUTATION_BYTES,
  MAX_PROFILE_POST_MUTATION_FIELDS,
  createParticipantProfileRouteHandler,
  participantProfileMutationLimits,
  type ParticipantProfileMutationVerifier,
} from "../worker/routes/participant-profile.ts";
import { syntheticPublicCampaign } from "./fixtures/public-campaign.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";
import { testParticipantRegistrationNoticeEvidence } from "./support/participant-registration-notice-evidence.ts";

const APP_ORIGIN = "https://campaign.example";
const SECOND_ALLOWED_ORIGIN = "https://other-campaign.example";
const CSRF_TOKEN = "profile_csrf_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALICE = subject("issuer.invalid/participant:alice");
const BOB = subject("issuer.invalid/participant:bob");
const OWNER = subject("issuer.invalid/owner:campaign");
const REGISTERED_AT = timestamp("2026-08-09T08:00:00.000Z");
const PACKAGE_CREATED_AT = timestamp("2026-08-09T09:00:00.000Z");
const PACKAGE_ID = stableId("package-version:participant-profile");
const ISSUED_COOKIE =
  "__Host-investor_mutation_profile=encrypted; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Strict";
const CLEAR_COOKIE =
  "__Host-investor_mutation_profile=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict";

test("profile GET exposes equivalent HTML and hypermedia with only declared editable action fields", async () => {
  const harness = await createHarness({ marketingConsent: true });
  const alice = participant(ALICE, "alice@provider.example");
  const jsonResponse = await harness.dispatch(
    getRequest(mediaType()),
    { actor: alice },
  );
  assert.equal(jsonResponse.status, 200);
  assert.equal(
    jsonResponse.headers.get("content-type"),
    `${INVESTOR_APP_MEDIA_TYPE}; version=${INVESTOR_APP_API_VERSION}; charset=utf-8`,
  );
  assert.equal(jsonResponse.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  assert.equal(jsonResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    jsonResponse.headers.get("cross-origin-resource-policy"),
    "same-origin",
  );
  const jsonText = await jsonResponse.text();
  assert.doesNotMatch(jsonText, new RegExp(CSRF_TOKEN, "u"));
  assert.doesNotMatch(jsonText, new RegExp(MUTATION_CSRF_HEADER, "iu"));
  assert.doesNotMatch(jsonText, /issuer\.invalid\/participant:alice/u);

  const document = objectOf(JSON.parse(jsonText) as unknown);
  assert.equal(document.type, "participant-profile");
  assert.deepEqual(resourceData(document), {
    revision: 1,
    account_email: "alice@provider.example",
    account_email_editable: false,
    display_name: "Alice Participant",
    country: "FI",
    declared_interest: "both",
    participation_context: "company",
    process_email_notice_acknowledged: true,
    process_email_notice_acknowledged_at: REGISTERED_AT,
    marketing_consent_state: "granted",
    marketing_consent_granted_at: REGISTERED_AT,
    marketing_consent_withdrawn_at: null,
    account_deletion_state: "not-requested",
    account_deletion_requested_at: null,
    registered_at: REGISTERED_AT,
    updated_at: REGISTERED_AT,
    current_acknowledgment_status: "required",
    current_package_version_id: PACKAGE_ID,
  });

  const actions = actionsOf(document);
  assert.deepEqual(
    actions.map(({ name, method }) => ({ name, method })),
    [
      { name: "update-participant-profile", method: "PATCH" },
      { name: "withdraw-marketing-consent", method: "DELETE" },
      { name: "request-account-deletion", method: "POST" },
    ],
  );
  assert.deepEqual(fieldsOf(actions[0]).map(({ name }) => name), [
    "operation-id",
    "expected-revision",
    "display-name",
    "country",
    "declared-interest",
    "participation-context",
  ]);
  assert.deepEqual(fieldsOf(actions[1]).map(({ name }) => name), [
    "operation-id",
    "expected-revision",
    "confirm-marketing-consent-withdrawal",
  ]);
  assert.deepEqual(fieldsOf(actions[2]).map(({ name }) => name), [
    "operation-id",
    "expected-revision",
    "confirm-account-deletion-request",
  ]);
  const actionFieldNames = actions.flatMap((action) =>
    fieldsOf(action).map((field) => String(field.name))
  );
  for (const protectedName of [
    "subject",
    "account-email",
    "process-email-notice-acknowledged",
    "marketing-consent",
    "registered-at",
    "updated-at",
    "account-deletion-state",
  ]) {
    assert.equal(actionFieldNames.includes(protectedName), false, protectedName);
  }

  const htmlResponse = await harness.dispatch(
    getRequest("text/html"),
    { actor: alice },
  );
  assert.equal(htmlResponse.status, 200);
  assert.equal(
    htmlResponse.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  const html = await htmlResponse.text();
  assertActionFormParity(document, html);
  assert.equal(hiddenCsrfTokens(html).every((value) => value === CSRF_TOKEN), true);
  assert.equal(hiddenCsrfTokens(html).length, 3);
  assert.match(html, /<link rel="stylesheet" href="\/participant-profile\.css">/u);
  assert.doesNotMatch(html, /<style\b|<script\b/iu);
  assert.equal((html.match(/<h1\b/gu) ?? []).length, 1);
  assert.match(html, /<h1>Your profile<\/h1>/u);
  assert.match(html, /alice@provider\.example/u);
  assert.match(html, /Current acknowledgment/u);
  assert.doesNotMatch(html, /name="(?:subject|account-email|registered-at)/iu);

  const css = await readFile(
    new URL("../public/participant-profile.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /grid-template-columns: minmax\(220px, 0\.68fr\) minmax\(420px, 1\.32fr\)/u,
  );
  assert.match(css, /@media \(max-width: 760px\)/u);
  assert.doesNotMatch(css, /letter-spacing:\s*-/u);
  assert.doesNotMatch(css, /font-size:\s*clamp\([^;]*(?:vw|dvw)/u);
});

test("JSON and HTML mutations preserve protected fields and independent state transitions", async () => {
  const harness = await createHarness({ marketingConsent: true });
  const alice = participant(ALICE, "alice@provider.example");

  const updateResponse = await harness.dispatch(
    jsonMutation("PATCH", ALICE, {
      "operation-id": "participant-profile-operation:update",
      "expected-revision": 1,
      "display-name": "  Updated Participant  ",
      country: "se",
      "declared-interest": "investor",
      "participation-context": "individual",
    }),
    { actor: alice },
  );
  assert.equal(updateResponse.status, 200);
  const updatedDocument = await jsonDocument(updateResponse);
  assert.equal(resourceData(updatedDocument).revision, 2);
  assert.equal(resourceData(updatedDocument).display_name, "Updated Participant");
  assert.equal(resourceData(updatedDocument).country, "SE");
  const updated = await harness.profile(alice);
  assert(updated);
  assert.equal(updated.snapshot.subject, ALICE);
  assert.equal(updated.snapshot.accountEmailLabel, "alice@provider.example");
  assert.equal(updated.snapshot.processEmailNoticeAcknowledgedAt, REGISTERED_AT);
  assert.equal(updated.snapshot.registeredAt, REGISTERED_AT);
  assert.equal(updated.snapshot.marketingConsent.state, "granted");
  assert.equal(updated.snapshot.accountDeletionRequest.state, "not-requested");

  const withdrawalResponse = await harness.dispatch(
    formMutation(ALICE, [
      [MUTATION_CSRF_FIELD, CSRF_TOKEN],
      [MUTATION_METHOD_FIELD, "DELETE"],
      ["operation-id", "participant-profile-operation:withdraw-consent"],
      ["expected-revision", "2"],
      ["confirm-marketing-consent-withdrawal", "true"],
    ]),
    { actor: alice },
  );
  assert.equal(withdrawalResponse.status, 200);
  const withdrawalHtml = await withdrawalResponse.text();
  assert.match(withdrawalHtml, /Withdrawn/u);
  const withdrawn = await harness.profile(alice);
  assert(withdrawn);
  assert.equal(withdrawn.revision, 3);
  assert.deepEqual(withdrawn.snapshot.marketingConsent, {
    state: "withdrawn",
    grantedAt: REGISTERED_AT,
    withdrawnAt: "2026-08-09T10:01:00.000Z",
  });
  assert.equal(
    withdrawn.snapshot.processEmailNoticeAcknowledgedAt,
    REGISTERED_AT,
  );

  const deletionResponse = await harness.dispatch(
    jsonMutation("POST", ALICE, {
      "operation-id": "participant-profile-operation:request-deletion",
      "expected-revision": 3,
      "confirm-account-deletion-request": true,
    }),
    { actor: alice },
  );
  assert.equal(deletionResponse.status, 200);
  assert.equal(deletionResponse.headers.get(MUTATION_CSRF_HEADER), null);
  const deleted = await jsonDocument(deletionResponse);
  assert.equal(resourceData(deleted).revision, 4);
  assert.equal(resourceData(deleted).account_deletion_state, "requested");
  assert.equal(resourceData(deleted).marketing_consent_state, "withdrawn");
  assert.deepEqual(actionsOf(deleted), []);

  const current = await harness.profile(alice);
  assert(current);
  assert.equal(current.snapshot.accountDeletionRequest.state, "requested");
  assert.equal(current.snapshot.marketingConsent.state, "withdrawn");
  assert.deepEqual(
    await harness.repository(alice).pendingDeletionIntent(),
    {
      type: "withdraw-active-interest",
      subject: ALICE,
      reason: "account-deletion-request",
      requestedAt: "2026-08-09T10:02:00.000Z",
    },
  );
  assert.equal(harness.nowCalls(), 3);
});

test("profile mutations preserve exact retries and reject changed or stale operations", async () => {
  const harness = await createHarness({ marketingConsent: true });
  const alice = participant(ALICE, "alice@provider.example");
  const updateBody = {
    "operation-id": "participant-profile-operation:retry-update",
    "expected-revision": 1,
    "display-name": "Replay Stable",
    country: "fi",
    "declared-interest": "both",
    "participation-context": "company",
  } as const;

  const first = await harness.dispatch(
    jsonMutation("PATCH", ALICE, updateBody),
    { actor: alice },
  );
  assert.equal(first.status, 200);
  const replay = await harness.dispatch(
    jsonMutation("PATCH", ALICE, updateBody),
    { actor: alice },
  );
  assert.equal(replay.status, 200);
  assert.equal(resourceData(await jsonDocument(replay)).revision, 2);
  assert.equal(harness.nowCalls(), 1);

  const changedRetry = await harness.dispatch(
    jsonMutation("PATCH", ALICE, {
      ...updateBody,
      "display-name": "Changed private retry value",
    }),
    { actor: alice },
  );
  assert.equal(changedRetry.status, 409);
  assert.doesNotMatch(
    await changedRetry.text(),
    /Changed private|alice@provider|participant:alice/u,
  );

  const stale = await harness.dispatch(
    jsonMutation("PATCH", ALICE, {
      ...updateBody,
      "operation-id": "participant-profile-operation:stale-update",
    }),
    { actor: alice },
  );
  assert.equal(stale.status, 412);

  const withdrawalBody = {
    "operation-id": "participant-profile-operation:retry-withdrawal",
    "expected-revision": 2,
    "confirm-marketing-consent-withdrawal": true,
  } as const;
  assert.equal(
    (await harness.dispatch(
      jsonMutation("DELETE", ALICE, withdrawalBody),
      { actor: alice },
    )).status,
    200,
  );
  assert.equal(
    (await harness.dispatch(
      jsonMutation("DELETE", ALICE, withdrawalBody),
      { actor: alice },
    )).status,
    200,
  );
  assert.equal(harness.nowCalls(), 2);

  const deletionBody = {
    "operation-id": "participant-profile-operation:retry-deletion",
    "expected-revision": 3,
    "confirm-account-deletion-request": true,
  } as const;
  assert.equal(
    (await harness.dispatch(
      jsonMutation("POST", ALICE, deletionBody),
      { actor: alice },
    )).status,
    200,
  );
  assert.equal(
    (await harness.dispatch(
      jsonMutation("POST", ALICE, deletionBody),
      { actor: alice },
    )).status,
    200,
  );
  assert.equal(harness.nowCalls(), 3);
  assert.equal((await harness.profile(alice))?.revision, 4);
});

test("marketing withdrawal remains independent after deletion while profile edits close", async () => {
  const harness = await createHarness({ marketingConsent: true });
  const alice = participant(ALICE, "alice@provider.example");

  const deletion = await harness.dispatch(
    jsonMutation("POST", ALICE, {
      "operation-id": "participant-profile-operation:delete-first",
      "expected-revision": 1,
      "confirm-account-deletion-request": true,
    }),
    { actor: alice },
  );
  assert.equal(deletion.status, 200);
  assert.equal(deletion.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  const deletionDocument = await jsonDocument(deletion);
  assert.deepEqual(
    actionsOf(deletionDocument).map(({ name }) => name),
    ["withdraw-marketing-consent"],
  );
  assert.equal(
    resourceData(deletionDocument).marketing_consent_state,
    "granted",
  );

  const blockedUpdate = await harness.dispatch(
    jsonMutation("PATCH", ALICE, {
      "operation-id": "participant-profile-operation:blocked-update",
      "expected-revision": 2,
      "display-name": "Must Not Change",
      country: "se",
      "declared-interest": "founder",
      "participation-context": "individual",
    }),
    { actor: alice },
  );
  assert.equal(blockedUpdate.status, 409);
  const duplicateDeletion = await harness.dispatch(
    jsonMutation("POST", ALICE, {
      "operation-id": "participant-profile-operation:duplicate-deletion",
      "expected-revision": 2,
      "confirm-account-deletion-request": true,
    }),
    { actor: alice },
  );
  assert.equal(duplicateDeletion.status, 409);

  const withdrawal = await harness.dispatch(
    jsonMutation("DELETE", ALICE, {
      "operation-id": "participant-profile-operation:post-delete-withdrawal",
      "expected-revision": 2,
      "confirm-marketing-consent-withdrawal": true,
    }),
    { actor: alice },
  );
  assert.equal(withdrawal.status, 200);
  assert.equal(withdrawal.headers.get(MUTATION_CSRF_HEADER), null);
  assert.deepEqual(actionsOf(await jsonDocument(withdrawal)), []);
  const profile = await harness.profile(alice);
  assert(profile);
  assert.equal(profile.revision, 3);
  assert.equal(profile.snapshot.displayName, "Alice Participant");
  assert.equal(profile.snapshot.accountDeletionRequest.state, "requested");
  assert.equal(profile.snapshot.marketingConsent.state, "withdrawn");
});

test("anonymous, owner, unregistered, foreign, malformed, and stale access disclose nothing", async () => {
  const harness = await createHarness({ marketingConsent: false });
  const alice = participant(ALICE, "alice@provider.example");
  const aliceAccess = await harness.access(alice);
  assert(aliceAccess);

  const anonymous = await harness.dispatch(getRequest(mediaType()), {
    actor: null,
    access: null,
  });
  assert.equal(anonymous.status, 401);
  assert.equal(harness.repositoryCalls(), 0);

  const owner = await harness.dispatch(getRequest(mediaType()), {
    actor: participant(OWNER, "owner@provider.example", true),
    access: aliceAccess,
  });
  assert.equal(owner.status, 404);
  assert.equal(harness.repositoryCalls(), 0);

  const unregistered = await harness.dispatch(getRequest(mediaType()), {
    actor: participant(BOB, "bob@provider.example"),
    access: null,
  });
  assert.equal(unregistered.status, 404);
  assert.equal(harness.repositoryCalls(), 0);

  const foreign = await harness.dispatch(getRequest(mediaType()), {
    actor: participant(BOB, "bob@provider.example"),
    access: aliceAccess,
  });
  assert.equal(foreign.status, 404);
  assert.equal(harness.repositoryCalls(), 0);

  const malformed = await harness.dispatch(getRequest(mediaType()), {
    actor: participant(ALICE, "malformed-email-label"),
    access: aliceAccess,
  });
  assert.equal(malformed.status, 404);
  assert.equal(harness.repositoryCalls(), 0);

  const staleAccess = Object.freeze({
    ...aliceAccess,
    displayName: "Private stale projection",
  });
  const stale = await harness.dispatch(getRequest(mediaType()), {
    actor: alice,
    access: staleAccess,
  });
  assert.equal(stale.status, 503);
  const staleBody = await stale.text();
  assert.doesNotMatch(
    staleBody,
    /Private stale|alice@provider|participant:alice/u,
  );

  const missingAccess = syntheticAccess(
    BOB,
    "bob@provider.example",
    { displayName: "Missing private participant" },
  );
  const missing = await harness.dispatch(getRequest(mediaType()), {
    actor: participant(BOB, "bob@provider.example"),
    access: missingAccess,
  });
  assert.equal(missing.status, 404);
  assert.doesNotMatch(await missing.text(), /Missing private|bob@provider/u);
});

test("malformed persisted profile state fails before every mutation method", async () => {
  const harness = await createHarness({ marketingConsent: true });
  const alice = participant(ALICE, "alice@provider.example");
  const current = await harness.profile(alice);
  const access = await harness.access(alice);
  assert(current);
  assert(access);

  const malformedValue = "PRIVATE_MALFORMED_CONSENT_TIMESTAMP";
  const malformedProfile = {
    ...current.snapshot,
    marketingConsent: {
      state: "withdrawn",
      grantedAt: REGISTERED_AT,
      withdrawnAt: malformedValue,
    },
  } as unknown as ParticipantProfile;
  const mutationCalls = {
    register: 0,
    update: 0,
    withdrawMarketingConsent: 0,
    requestAccountDeletion: 0,
  };
  const repository: ParticipantRepository = {
    current: async () => ({
      revision: current.revision,
      snapshot: malformedProfile,
    }),
    register: async () => {
      mutationCalls.register += 1;
      throw new Error("A malformed profile must not reach registration.");
    },
    update: async () => {
      mutationCalls.update += 1;
      throw new Error("A malformed profile must not reach update.");
    },
    withdrawMarketingConsent: async () => {
      mutationCalls.withdrawMarketingConsent += 1;
      throw new Error("A malformed profile must not reach consent withdrawal.");
    },
    requestAccountDeletion: async () => {
      mutationCalls.requestAccountDeletion += 1;
      throw new Error("A malformed profile must not reach deletion.");
    },
    pendingDeletionIntent: async () => null,
  };
  const csrfHash = await hashCsrfToken(CSRF_TOKEN);
  let mutationClockCalls = 0;
  const route = createParticipantProfileRouteHandler({
    repositoryFor: (account) => {
      assert.equal(account.subject, ALICE);
      assert.equal(account.accountEmailLabel, "alice@provider.example");
      return repository;
    },
    mutationSecurity: {
      allowedOrigins: [APP_ORIGIN],
      resolveSession: async () => session(ALICE, csrfHash, "participant"),
      now: () => new Date("2026-08-09T09:30:00.000Z"),
      maxBodyBytes: 1_024,
      maxFields: 16,
    },
    csrfTokenFor: () => assert.fail("Malformed state must not issue CSRF."),
    now: () => {
      mutationClockCalls += 1;
      return new Date("2026-08-09T10:00:00.000Z");
    },
    createOperationId: () =>
      assert.fail("Malformed state must not issue an operation ID."),
  });
  const request = jsonMutation("PATCH", ALICE, {
    "operation-id": "participant-profile-operation:malformed-state",
    "expected-revision": 1,
    "display-name": "Must Not Persist",
    country: "se",
    "declared-interest": "investor",
    "participation-context": "individual",
  });
  const response = await route(routeContext(request, alice, access));
  assert(response);
  assert.equal(response.status, 503);
  assert.deepEqual(mutationCalls, {
    register: 0,
    update: 0,
    withdrawMarketingConsent: 0,
    requestAccountDeletion: 0,
  });
  assert.equal(mutationClockCalls, 0);
  const body = await response.text();
  assert.doesNotMatch(
    body,
    new RegExp(
      `${malformedValue}|Must Not Persist|alice@provider|participant:alice`,
      "u",
    ),
  );
});

test("mutations enforce actor binding, exact origin, CSRF, bounds, exact fields, and negotiation", async () => {
  const harness = await createHarness({ marketingConsent: true });
  const alice = participant(ALICE, "alice@provider.example");
  const validBody = {
    "operation-id": "participant-profile-operation:security-update",
    "expected-revision": 1,
    "display-name": "Security Update",
    country: "fi",
    "declared-interest": "both",
    "participation-context": "company",
  } as const;

  const substitution = await harness.dispatch(
    jsonMutation("PATCH", BOB, validBody),
    { actor: alice },
  );
  assert.equal(substitution.status, 404);

  const ownerSession = await harness.dispatch(
    jsonMutation("PATCH", ALICE, validBody, { sessionType: "owner" }),
    { actor: alice },
  );
  assert.equal(ownerSession.status, 404);

  const crossOrigin = await harness.dispatch(
    jsonMutation("PATCH", ALICE, validBody, {
      origin: SECOND_ALLOWED_ORIGIN,
    }),
    { actor: alice },
  );
  assert.equal(crossOrigin.status, 403);

  const badCsrf = await harness.dispatch(
    jsonMutation("PATCH", ALICE, validBody, {
      csrf: "wrong_profile_csrf_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    }),
    { actor: alice },
  );
  assert.equal(badCsrf.status, 403);

  for (const body of [
    { ...validBody, subject: BOB },
    { ...validBody, "account-email": "attacker@example.test" },
    { ...validBody, "marketing-consent": true },
    { ...validBody, "account-deletion-state": "not-requested" },
    { ...validBody, "operation-id": "not a stable operation id" },
    withoutField(validBody, "expected-revision"),
  ]) {
    const response = await harness.dispatch(
      jsonMutation("PATCH", ALICE, body),
      { actor: alice },
    );
    assert.equal(response.status, 400);
    assert.doesNotMatch(
      await response.text(),
      /attacker@example|participant:bob|Security Update/u,
    );
  }

  const missingConfirmation = await harness.dispatch(
    jsonMutation("POST", ALICE, {
      "operation-id": "participant-profile-operation:no-confirmation",
      "expected-revision": 1,
    }),
    { actor: alice },
  );
  assert.equal(missingConfirmation.status, 400);

  const oversized = await harness.dispatch(
    jsonMutation("PATCH", ALICE, {
      ...validBody,
      "display-name": "x".repeat(2_000),
    }),
    { actor: alice },
  );
  assert.equal(oversized.status, 413);

  const unsupportedType = new Request(
    `${APP_ORIGIN}${PARTICIPANT_PROFILE_PATH}`,
    {
      method: "PATCH",
      headers: {
        accept: "application/json",
        "content-type": "text/plain",
        origin: APP_ORIGIN,
        "x-test-auth-subject": ALICE,
        [MUTATION_CSRF_HEADER]: CSRF_TOKEN,
      },
      body: "not supported",
    },
  );
  assert.equal(
    (await harness.dispatch(unsupportedType, { actor: alice })).status,
    415,
  );

  const unsupportedVersion = await harness.dispatch(
    getRequest(`${INVESTOR_APP_MEDIA_TYPE}; version=99`),
    { actor: alice },
  );
  assert.equal(unsupportedVersion.status, 406);

  const unsupportedMethod = await harness.dispatch(
    new Request(`${APP_ORIGIN}${PARTICIPANT_PROFILE_PATH}`, {
      method: "PUT",
      headers: { accept: "application/json" },
    }),
    { actor: alice },
  );
  assert.equal(unsupportedMethod.status, 405);
  assert.equal(
    unsupportedMethod.headers.get("allow"),
    "GET, POST, PATCH, DELETE",
  );
  assert.equal((await harness.profile(alice))?.revision, 1);
});

test("hosted profile discovery emits proof cookies only through response headers", async () => {
  const proof = Object.freeze({
    token: CSRF_TOKEN,
    expiresAt: timestamp("2026-08-09T12:05:00.000Z"),
    setCookie: ISSUED_COOKIE,
  }) satisfies BrowserMutationProof;
  const harness = await createHarness({ csrfToken: proof });
  const alice = participant(ALICE, "alice@provider.example");

  const jsonResponse = await harness.dispatch(getRequest(mediaType()), {
    actor: alice,
  });
  assert.equal(jsonResponse.status, 200);
  assert.equal(jsonResponse.headers.get("set-cookie"), ISSUED_COOKIE);
  assert.equal(jsonResponse.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  const json = await jsonResponse.text();
  assert.doesNotMatch(json, new RegExp(CSRF_TOKEN, "u"));
  assert.doesNotMatch(json, /set-cookie|encrypted|HttpOnly/iu);

  const htmlResponse = await harness.dispatch(getRequest("text/html"), {
    actor: alice,
  });
  assert.equal(htmlResponse.status, 200);
  assert.equal(htmlResponse.headers.get("set-cookie"), ISSUED_COOKIE);
  const html = await htmlResponse.text();
  assert.equal(hiddenCsrfTokens(html).every((value) => value === CSRF_TOKEN), true);
  assert.doesNotMatch(html, /set-cookie|encrypted|HttpOnly/iu);

  const malformed = await createHarness({
    csrfToken: Object.freeze({ ...proof, setCookie: "bad\r\ncookie" }),
  });
  const failure = await malformed.dispatch(getRequest(mediaType()), {
    actor: alice,
  });
  assert.equal(failure.status, 503);
  assert.equal(failure.headers.get("set-cookie"), null);
  assert.doesNotMatch(await failure.text(), /bad|cookie|profile_csrf/iu);
});

test("verified hosted profile mutations clear proof cookies on success and later failures", async () => {
  const alice = participant(ALICE, "alice@provider.example");
  const updateBody = profileUpdateBody(
    "participant-profile-operation:hosted-success",
    1,
  );
  const success = await createHarness({
    verifyMutation: profileVerifierFor("PATCH", updateBody, CLEAR_COOKIE),
  });
  const successResponse = await success.dispatch(
    jsonMutation("PATCH", ALICE, updateBody),
    { actor: alice },
  );
  assert.equal(successResponse.status, 200);
  assertSingleCookie(successResponse, CLEAR_COOKIE);
  assert.doesNotMatch(await successResponse.text(), /set-cookie|Max-Age=0/iu);

  const parser = await createHarness({
    verifyMutation: profileVerifierFor("PATCH", {
      ...updateBody,
      "operation-id": "participant-profile-operation:hosted-parser",
      unexpected: "private parser value",
    }, CLEAR_COOKIE),
  });
  const parserResponse = await parser.dispatch(
    jsonMutation("PATCH", ALICE, updateBody),
    { actor: alice },
  );
  assert.equal(parserResponse.status, 400);
  assertSingleCookie(parserResponse, CLEAR_COOKIE);
  assert.doesNotMatch(
    await parserResponse.text(),
    /private parser value|Max-Age=0/iu,
  );

  const repository = await createHarness({
    verifyMutation: profileVerifierFor("PATCH", {
      ...updateBody,
      "operation-id": "participant-profile-operation:hosted-repository",
    }, CLEAR_COOKIE),
    repositoryFor() {
      throw new Error("private repository failure");
    },
  });
  const repositoryResponse = await repository.dispatch(
    jsonMutation("PATCH", ALICE, updateBody),
    { actor: alice },
  );
  assert.equal(repositoryResponse.status, 503);
  assertSingleCookie(repositoryResponse, CLEAR_COOKIE);
  assert.doesNotMatch(
    await repositoryResponse.text(),
    /private repository failure|Max-Age=0/iu,
  );
});

test("profile hosted verification never clears before verification and requires a valid clear cookie", async () => {
  const alice = participant(ALICE, "alice@provider.example");
  const requestBody = profileUpdateBody(
    "participant-profile-operation:hosted-clear",
    1,
  );
  const rejected = await createHarness({
    async verifyMutation() {
      throw new MutationSecurityFailure("REQUEST_REJECTED");
    },
  });
  const rejectedResponse = await rejected.dispatch(
    jsonMutation("PATCH", ALICE, requestBody),
    { actor: alice },
  );
  assert.equal(rejectedResponse.status, 403);
  assert.equal(rejectedResponse.headers.get("set-cookie"), null);

  for (const [name, clearCookie] of [
    ["missing", undefined],
    ["malformed", "bad\r\nclear-cookie"],
  ] as const) {
    let repositoryCalls = 0;
    const verified = await profileVerifierFor(
      "PATCH",
      { ...requestBody, "operation-id": `participant-profile:${name}` },
      CLEAR_COOKIE,
    )(jsonMutation("PATCH", ALICE, requestBody));
    const harness = await createHarness({
      verifyMutation: (async () => {
        if (clearCookie === undefined) {
          return {
            actor: verified.actor,
            method: verified.method,
            mediaType: verified.mediaType,
            body: verified.body,
          } as never;
        }
        return { ...verified, clearCookie } as never;
      }) as ParticipantProfileMutationVerifier,
      repositoryFor(account) {
        repositoryCalls += 1;
        return new DevelopmentInMemoryParticipantRepository(
          new MemoryStorageAdapter(),
          account,
        );
      },
    });
    const response = await harness.dispatch(
      jsonMutation("PATCH", ALICE, requestBody),
      { actor: alice },
    );
    assert.equal(response.status, 503, name);
    assert.equal(response.headers.get("set-cookie"), null, name);
    assert.equal(repositoryCalls, 0, name);
  }
});

test("hosted profile limits reject oversized, excess, and repeated fields before replay or persistence", async () => {
  assert.deepEqual(participantProfileMutationLimits("POST"), {
    maxBodyBytes: MAX_PROFILE_POST_MUTATION_BYTES,
    maxFields: MAX_PROFILE_POST_MUTATION_FIELDS,
    repeatedFormFields: [],
  });
  assert.deepEqual(participantProfileMutationLimits("PATCH"), {
    maxBodyBytes: MAX_PROFILE_PATCH_MUTATION_BYTES,
    maxFields: MAX_PROFILE_PATCH_MUTATION_FIELDS,
    repeatedFormFields: [],
  });
  assert.deepEqual(participantProfileMutationLimits("DELETE"), {
    maxBodyBytes: MAX_PROFILE_DELETE_MUTATION_BYTES,
    maxFields: MAX_PROFILE_DELETE_MUTATION_FIELDS,
    repeatedFormFields: [],
  });

  const alice = participant(ALICE, "alice@provider.example");
  const identity = Object.freeze({
    type: "participant",
    subject: ALICE,
  }) satisfies TrustedSitesMutationIdentity;
  const claims: BrowserMutationReplayClaim[] = [];
  const session = createBrowserMutationSession({
    appOrigin: APP_ORIGIN,
    encryptionKey: await aesKey(47),
    async claimReplay(claim) {
      claims.push(claim);
      return true;
    },
    now: () => new Date("2026-08-09T09:00:00.000Z"),
    randomBytes: (length) => Uint8Array.from(
      { length },
      (_, index) => (index + 31) % 256,
    ),
    ttlSeconds: 300,
  });
  const proof = await session.issue(getRequest("text/html"), identity, APP_ORIGIN);
  let repositoryCalls = 0;
  const route = createParticipantProfileRouteHandler({
    repositoryFor(account) {
      repositoryCalls += 1;
      return new DevelopmentInMemoryParticipantRepository(
        new MemoryStorageAdapter(),
        account,
      );
    },
    verifyMutation: (request) => session.verifyMutation(
      request,
      identity,
      APP_ORIGIN,
      participantProfileMutationLimits(request.method),
    ),
    csrfTokenFor: async () => proof,
  });
  const access = syntheticAccess(ALICE, "alice@provider.example");

  const oversized = hostedProfileJsonMutation(proof, "PATCH", {
    ...profileUpdateBody("participant-profile:oversized", 1),
    "display-name": "x".repeat(MAX_PROFILE_PATCH_MUTATION_BYTES),
  });
  assert.equal(
    (await route(routeContext(oversized, alice, access)))?.status,
    413,
  );

  const excess = hostedProfileJsonMutation(proof, "PATCH", {
    ...profileUpdateBody("participant-profile:excess", 1),
    unexpected: "private",
  });
  assert.equal((await route(routeContext(excess, alice, access)))?.status, 400);

  const repeated = hostedProfileFormMutation(proof, [
    [MUTATION_METHOD_FIELD, "PATCH"],
    ["operation-id", "participant-profile:repeated"],
    ["expected-revision", "1"],
    ["display-name", "Alice"],
    ["display-name", "Alice again"],
    ["country", "FI"],
    ["declared-interest", "investor"],
  ]);
  assert.equal((await route(routeContext(repeated, alice, access)))?.status, 400);

  const oversizedDelete = hostedProfileJsonMutation(proof, "DELETE", {
    "operation-id": "participant-profile:delete-limit",
    "expected-revision": 1,
    "confirm-marketing-consent-withdrawal": "x".repeat(
      MAX_PROFILE_DELETE_MUTATION_BYTES,
    ),
  });
  assert.equal(
    (await route(routeContext(oversizedDelete, alice, access)))?.status,
    413,
  );
  assert.equal(repositoryCalls, 0);
  assert.deepEqual(claims, []);
});

test("concurrent exact profile retries recover the persisted server timestamp", async () => {
  const harness = await createHarness({ marketingConsent: true });
  const alice = participant(ALICE, "alice@provider.example");
  const body = profileUpdateBody(
    "participant-profile-operation:concurrent-retry",
    1,
  );
  const responses = await Promise.all([
    harness.dispatch(jsonMutation("PATCH", ALICE, body), { actor: alice }),
    harness.dispatch(jsonMutation("PATCH", ALICE, body), { actor: alice }),
  ]);
  assert.deepEqual(responses.map(({ status }) => status), [200, 200]);
  const documents = await Promise.all(responses.map(jsonDocument));
  assert.deepEqual(
    documents.map((document) => resourceData(document).revision),
    [2, 2],
  );
  assert.equal((await harness.profile(alice))?.revision, 2);
  assert.equal(harness.nowCalls(), 2);
});

test("completed request-only state emits no operation IDs or CSRF proof", async () => {
  const harness = await createHarness({ marketingConsent: false });
  const alice = participant(ALICE, "alice@provider.example");
  const discovery = await harness.dispatch(getRequest(mediaType()), {
    actor: alice,
  });
  assert.equal(discovery.status, 200);
  assert.equal(harness.operationIdCalls(), 2);
  assert.equal(harness.csrfCalls(), 1);
  assert.deepEqual(
    actionsOf(await jsonDocument(discovery)).map(({ name }) => name),
    ["update-participant-profile", "request-account-deletion"],
  );

  const deletion = await harness.dispatch(
    jsonMutation("POST", ALICE, {
      "operation-id": "participant-profile-operation:actionless-deletion",
      "expected-revision": 1,
      "confirm-account-deletion-request": true,
    }),
    { actor: alice },
  );
  assert.equal(deletion.status, 200);
  assert.equal(deletion.headers.get(MUTATION_CSRF_HEADER), null);
  assert.deepEqual(actionsOf(await jsonDocument(deletion)), []);
  assert.equal(harness.operationIdCalls(), 2);
  assert.equal(harness.csrfCalls(), 1);

  const actionlessGet = await harness.dispatch(getRequest(mediaType()), {
    actor: alice,
  });
  assert.equal(actionlessGet.headers.get(MUTATION_CSRF_HEADER), null);
  assert.deepEqual(actionsOf(await jsonDocument(actionlessGet)), []);
  assert.equal(harness.operationIdCalls(), 2);
  assert.equal(harness.csrfCalls(), 1);
});

test("resource validation requires operation IDs only for currently available actions", async () => {
  const harness = await createHarness({ marketingConsent: false });
  const alice = participant(ALICE, "alice@provider.example");
  const current = await harness.profile(alice);
  assert(current);
  const account = participantAccount(alice);
  const base = {
    requestUrl: `${APP_ORIGIN}${PARTICIPANT_PROFILE_PATH}`,
    account,
    revision: current.revision,
    profile: current.snapshot,
    acknowledgment: {
      packageVersionId: PACKAGE_ID,
      requiresCurrentAcceptance: false,
    },
  } as const;
  assert.throws(
    () => createParticipantProfileCapabilityModel({
      ...base,
      operationIds: {
        update: null,
        withdrawMarketingConsent: null,
        requestAccountDeletion: "participant-profile-operation:deletion",
      },
    }),
    ParticipantProfileResourceError,
  );

  await harness.repository(alice).requestAccountDeletion({
    operationId: "participant-profile-operation:resource-deletion",
    expectedRevision: 1,
    requestedAt: "2026-08-09T10:00:00.000Z",
  });
  const requested = await harness.profile(alice);
  assert(requested);
  const actionless = createParticipantProfileCapabilityModel({
    ...base,
    revision: requested.revision,
    profile: requested.snapshot,
    operationIds: {
      update: "ignored invalid operation id",
      withdrawMarketingConsent: null,
      requestAccountDeletion: null,
    },
  });
  assert.deepEqual(actionless.document.actions, []);
  assert.equal(
    actionless.document.data.current_acknowledgment_status,
    "current",
  );
});

type TestActor = Readonly<{
  subject: ActorSubject;
  email: string;
  owner: boolean;
}>;

type HarnessOptions = Readonly<{
  marketingConsent?: boolean;
  packageState?: "required" | "current" | "unavailable";
  csrfToken?: string | BrowserMutationProof | null;
  verifyMutation?: ParticipantProfileMutationVerifier;
  repositoryFor?: (account: ParticipantAccount) => ParticipantRepository;
}>;

type DispatchIdentity = Readonly<{
  actor: TestActor | null;
  access?: AuthorizedParticipantAccess | null;
}>;

type TestHarness = Readonly<{
  dispatch(request: Request, identity: DispatchIdentity): Promise<Response>;
  profile(actor: TestActor): Promise<ParticipantProfileSnapshot | null>;
  access(actor: TestActor): Promise<AuthorizedParticipantAccess | null>;
  repository(actor: TestActor): DevelopmentInMemoryParticipantRepository;
  csrfCalls(): number;
  nowCalls(): number;
  operationIdCalls(): number;
  repositoryCalls(): number;
}>;

async function createHarness(
  options: HarnessOptions = {},
): Promise<TestHarness> {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const csrfHash = await hashCsrfToken(CSRF_TOKEN);
  const issuedCsrfToken = Object.hasOwn(options, "csrfToken")
    ? options.csrfToken ?? null
    : CSRF_TOKEN;
  let csrfCalls = 0;
  let timeCalls = 0;
  let operationSequence = 0;
  let repositoryCalls = 0;
  const directRepository = (account: ParticipantAccount) =>
    new DevelopmentInMemoryParticipantRepository(storage, account);
  const routeRepositoryFor = (account: ParticipantAccount): ParticipantRepository => {
    repositoryCalls += 1;
    return options.repositoryFor?.(account) ?? directRepository(account);
  };
  const alice = participant(ALICE, "alice@provider.example");
  await directRepository(participantAccount(alice)).register({
    operationId: "participant-profile-operation:seed-alice",
    expectedRevision: null,
    registeredAt: REGISTERED_AT,
    registration: {
      displayName: "Alice Participant",
      country: "FI",
      declaredInterest: "both",
      participationContext: "company",
      processEmailNoticeAcknowledged: true,
      marketingConsent: options.marketingConsent ?? false,
    },
    noticeEvidence: testParticipantRegistrationNoticeEvidence(),
  });

  const profileRoute = createParticipantProfileRouteHandler({
    repositoryFor: routeRepositoryFor,
    ...(options.verifyMutation === undefined
      ? {
          mutationSecurity: {
            allowedOrigins: [APP_ORIGIN, SECOND_ALLOWED_ORIGIN],
            resolveSession: async (request: Request) => {
              const value = request.headers.get("x-test-auth-subject");
              if (!value) return null;
              return session(
                subject(value),
                csrfHash,
                request.headers.get("x-test-session-type") === "owner"
                  ? "owner"
                  : "participant",
              );
            },
            now: () => new Date("2026-08-09T09:30:00.000Z"),
            maxBodyBytes: 1_024,
            maxFields: 16,
          },
        }
      : { verifyMutation: options.verifyMutation }),
    csrfTokenFor: (request, account) => {
      csrfCalls += 1;
      return request.headers.get("x-test-auth-subject") === account.subject ||
          request.method === "GET"
        ? issuedCsrfToken
        : null;
    },
    now: () => {
      const value = new Date(
        Date.parse("2026-08-09T10:00:00.000Z") + timeCalls * 60_000,
      );
      timeCalls += 1;
      return value;
    },
    createOperationId: (operation) => {
      operationSequence += 1;
      return `participant-profile-form:${operation}:${operationSequence}`;
    },
  });
  const route = createParticipantRouteHandler([profileRoute]);

  const repository = (actor: TestActor) =>
    directRepository(participantAccount(actor));
  const profile = (actor: TestActor) => repository(actor).current();
  const access = async (actor: TestActor) => {
    const current = await profile(actor);
    if (current === null) return null;
    return accessFromProfile(
      actor,
      current,
      options.packageState ?? "required",
    );
  };

  return Object.freeze({
    async dispatch(request, identity) {
      const resolvedAccess = Object.hasOwn(identity, "access")
        ? identity.access ?? null
        : identity.actor === null
        ? null
        : await access(identity.actor);
      const response = await route(
        routeContext(request, identity.actor, resolvedAccess),
      );
      assert(response);
      return response;
    },
    profile,
    access,
    repository,
    csrfCalls: () => csrfCalls,
    nowCalls: () => timeCalls,
    operationIdCalls: () => operationSequence,
    repositoryCalls: () => repositoryCalls,
  });
}

function routeContext(
  request: Request,
  actor: TestActor | null,
  access: AuthorizedParticipantAccess | null,
): ApplicationRouteContext {
  return {
    request,
    url: new URL(request.url),
    resourceUrl: request.url,
    actor: actor === null
      ? null
      : {
          userId: actor.subject,
          email: actor.email,
          displayName: actor.email,
        },
    isOwner: actor?.owner ?? false,
    participantAccess: access,
    campaign: syntheticPublicCampaign,
    renderApplication: async () => {
      throw new Error("The participant profile route owns this resource.");
    },
  };
}

function accessFromProfile(
  actor: TestActor,
  current: ParticipantProfileSnapshot,
  packageState: "required" | "current" | "unavailable",
): AuthorizedParticipantAccess {
  return Object.freeze({
    subject: current.snapshot.subject,
    email: current.snapshot.accountEmailLabel,
    displayName: current.snapshot.displayName,
    declaredInterest: current.snapshot.declaredInterest,
    participationContext: current.snapshot.participationContext,
    accountStatus: current.snapshot.accountDeletionRequest.state === "requested"
      ? "deletion-requested"
      : "active",
    currentPackage: packageState === "unavailable"
      ? null
      : Object.freeze({
          id: PACKAGE_ID,
          createdAt: PACKAGE_CREATED_AT,
          changeSummary: "Current participant package",
          materialChange: true,
          requiresCurrentAcceptance: packageState === "required",
        }),
  });
}

function syntheticAccess(
  actorSubject: ActorSubject,
  email: string,
  overrides: Readonly<{ displayName?: string }> = {},
): AuthorizedParticipantAccess {
  return Object.freeze({
    subject: actorSubject,
    email,
    displayName: overrides.displayName ?? "Synthetic Participant",
    declaredInterest: "both",
    participationContext: "company",
    accountStatus: "active",
    currentPackage: null,
  });
}

function getRequest(accept: string): Request {
  return new Request(`${APP_ORIGIN}${PARTICIPANT_PROFILE_PATH}`, {
    headers: { accept },
  });
}

function jsonMutation(
  method: "POST" | "PATCH" | "DELETE",
  actorSubject: ActorSubject,
  body: Readonly<Record<string, unknown>>,
  overrides: Readonly<{
    origin?: string;
    csrf?: string;
    sessionType?: "participant" | "owner";
  }> = {},
): Request {
  return new Request(`${APP_ORIGIN}${PARTICIPANT_PROFILE_PATH}`, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: overrides.origin ?? APP_ORIGIN,
      "x-test-auth-subject": actorSubject,
      ...(overrides.sessionType
        ? { "x-test-session-type": overrides.sessionType }
        : {}),
      [MUTATION_CSRF_HEADER]: overrides.csrf ?? CSRF_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

function formMutation(
  actorSubject: ActorSubject,
  entries: readonly (readonly [string, string])[],
): Request {
  const body = new URLSearchParams();
  for (const [name, value] of entries) body.append(name, value);
  return new Request(`${APP_ORIGIN}${PARTICIPANT_PROFILE_PATH}`, {
    method: "POST",
    headers: {
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
      origin: APP_ORIGIN,
      "x-test-auth-subject": actorSubject,
    },
    body,
  });
}

function hostedProfileJsonMutation(
  proof: BrowserMutationProof,
  method: "POST" | "PATCH" | "DELETE",
  body: Readonly<Record<string, unknown>>,
): Request {
  return new Request(`${APP_ORIGIN}${PARTICIPANT_PROFILE_PATH}`, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      cookie: proofCookieHeader(proof),
      origin: APP_ORIGIN,
      [MUTATION_CSRF_HEADER]: proof.token,
    },
    body: JSON.stringify(body),
  });
}

function hostedProfileFormMutation(
  proof: BrowserMutationProof,
  entries: readonly (readonly [string, string])[],
): Request {
  const body = new URLSearchParams();
  body.append(MUTATION_CSRF_FIELD, proof.token);
  for (const [name, value] of entries) body.append(name, value);
  return new Request(`${APP_ORIGIN}${PARTICIPANT_PROFILE_PATH}`, {
    method: "POST",
    headers: {
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
      cookie: proofCookieHeader(proof),
      origin: APP_ORIGIN,
    },
    body,
  });
}

function proofCookieHeader(proof: BrowserMutationProof): string {
  const value = proof.setCookie.split(";", 1)[0];
  assert(value);
  return value;
}

function profileVerifierFor(
  method: "POST" | "PATCH" | "DELETE",
  body: Readonly<Record<string, unknown>>,
  clearCookie: string,
): ParticipantProfileMutationVerifier {
  return async () => Object.freeze({
    actor: Object.freeze({ type: "participant" as const, subject: ALICE }),
    method,
    mediaType: "application/json" as const,
    body: Object.freeze({ ...body }),
    clearCookie,
  });
}

function assertSingleCookie(response: Response, expected: string): void {
  const value = response.headers.get("set-cookie");
  assert.equal(value, expected);
  assert.equal(value?.split(expected).length, 2);
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

function profileUpdateBody(
  operationId: string,
  expectedRevision: number,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    "operation-id": operationId,
    "expected-revision": expectedRevision,
    "display-name": "Hosted profile participant",
    country: "se",
    "declared-interest": "investor",
    "participation-context": "individual",
    ...overrides,
  });
}

function withoutField(
  input: Readonly<Record<string, unknown>>,
  field: string,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(input).filter(([name]) => name !== field),
  );
}

function participant(
  actorSubject: ActorSubject,
  email: string,
  owner = false,
): TestActor {
  return Object.freeze({ subject: actorSubject, email, owner });
}

function participantAccount(actor: TestActor): ParticipantAccount {
  const parsed = parseParticipantAccount({
    subject: actor.subject,
    accountEmailLabel: actor.email,
  });
  assert(parsed.ok);
  return parsed.value;
}

function session(
  actorSubject: ActorSubject,
  csrfHash: Awaited<ReturnType<typeof hashCsrfToken>>,
  type: "participant" | "owner",
): TrustedMutationSession {
  return Object.freeze({
    actor: Object.freeze({ type, subject: actorSubject }),
    expiresAt: timestamp("2026-08-09T13:00:00.000Z"),
    csrf: Object.freeze({
      tokenHash: csrfHash,
      expiresAt: timestamp("2026-08-09T12:30:00.000Z"),
    }),
  });
}

function mediaType(): string {
  return `${INVESTOR_APP_MEDIA_TYPE}; version=${INVESTOR_APP_API_VERSION}`;
}

async function jsonDocument(response: Response): Promise<Record<string, unknown>> {
  return objectOf(await response.json() as unknown);
}

function objectOf(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function resourceData(document: Record<string, unknown>): Record<string, unknown> {
  return objectOf(document.data);
}

function actionsOf(document: Record<string, unknown>): Record<string, unknown>[] {
  assert(Array.isArray(document.actions));
  return document.actions.map(objectOf);
}

function fieldsOf(action: unknown): Record<string, unknown>[] {
  const fields = objectOf(action).fields;
  assert(Array.isArray(fields));
  return fields.map(objectOf);
}

function assertActionFormParity(
  document: Record<string, unknown>,
  html: string,
): void {
  const actions = actionsOf(document);
  const forms = [...html.matchAll(
    /<form[^>]*\baction="([^"]+)"[^>]*\bdata-action-name="([^"]+)"[^>]*>[\s\S]*?<\/form>/gu,
  )].map((match) => ({
    action: match[1] ?? "",
    name: match[2] ?? "",
    html: match[0] ?? "",
    fields: [...(match[0] ?? "").matchAll(
      /<(?:input|select|textarea)\b[^>]*\bname="([^"]+)"/gu,
    )].map((field) => field[1] ?? ""),
  }));
  assert.deepEqual(
    forms.map(({ name }) => name),
    actions.map(({ name }) => name),
  );
  for (const action of actions) {
    const form = forms.find(({ name }) => name === action.name);
    assert(form);
    assert.equal(form.action, action.href);
    assert.deepEqual(
      form.fields.filter((name) =>
        name !== MUTATION_CSRF_FIELD && name !== MUTATION_METHOD_FIELD
      ),
      fieldsOf(action).map((field) => String(field.name)),
    );
    const methodOverride = new RegExp(
      `<input name="${MUTATION_METHOD_FIELD}" type="hidden" value="([^"]+)">`,
      "u",
    ).exec(form.html)?.[1];
    assert.equal(
      methodOverride ?? "POST",
      action.method,
      String(action.name),
    );
  }
}

function hiddenCsrfTokens(html: string): string[] {
  return [...html.matchAll(
    new RegExp(
      `<input name="${MUTATION_CSRF_FIELD}" type="hidden" value="([^"]+)">`,
      "gu",
    ),
  )].map((match) => match[1] ?? "");
}

function subject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  assert(parsed.ok);
  return parsed.value;
}

function timestamp(value: string): Timestamp {
  const parsed = parseTimestamp(value);
  assert(parsed.ok);
  return parsed.value;
}

function stableId(value: string) {
  const parsed = parseStableId<"package-version">(value);
  assert(parsed.ok);
  return parsed.value;
}
