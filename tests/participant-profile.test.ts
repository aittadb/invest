import assert from "node:assert/strict";
import test from "node:test";

import {
  PARTICIPANT_PROFILE_FIELD_RULES,
  isParticipantProfileDescendantProjection,
  parseParticipantAccount,
  registerParticipantProfile,
  requestParticipantAccountDeletion,
  updateParticipantProfile,
  withdrawMarketingConsent,
  type ParticipantAccount,
  type ParticipantProfile,
} from "../domain/participant-profile.ts";
import { parseTimestamp, type Timestamp } from "../domain/foundation.ts";
import { testParticipantRegistrationNoticeEvidence } from "./support/participant-registration-notice-evidence.ts";

const REGISTERED_AT = timestamp("2026-01-01T00:00:00.000Z");
const UPDATED_AT = timestamp("2026-01-02T00:00:00.000Z");
const WITHDRAWN_AT = timestamp("2026-01-03T00:00:00.000Z");
const DELETION_AT = timestamp("2026-01-04T00:00:00.000Z");
const NOTICE_EVIDENCE = testParticipantRegistrationNoticeEvidence();

test("first registration requires profile fields and server-supplied identity", () => {
  const invalidAccount = parseParticipantAccount({
    subject: "issuer.invalid/account-subject",
    accountEmailLabel: "opaque-account-label",
  });
  assert.deepEqual(invalidAccount, {
    ok: false,
    issues: [{ code: "invalid_format", path: "accountEmailLabel" }],
  });
  assert.doesNotMatch(JSON.stringify(invalidAccount), /opaque-account-label/u);

  const accountResult = parseParticipantAccount({
    subject: "issuer.invalid/account-subject",
    accountEmailLabel: "account@example.invalid",
  });
  assert.equal(accountResult.ok, true);
  if (!accountResult.ok) return;

  const result = registerParticipantProfile(
    accountResult.value,
    registrationInput({ marketingConsent: undefined }),
    REGISTERED_AT,
    NOTICE_EVIDENCE,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.value, {
    subject: "issuer.invalid/account-subject",
    accountEmailLabel: "account@example.invalid",
    displayName: "Registered participant",
    country: "AQ",
    declaredInterest: "both",
    participationContext: "individual",
    registrationNoticeEvidence: NOTICE_EVIDENCE,
    processEmailNoticeAcknowledgedAt: REGISTERED_AT,
    marketingConsent: { state: "not-granted" },
    accountDeletionRequest: { state: "not-requested" },
    registeredAt: REGISTERED_AT,
    updatedAt: REGISTERED_AT,
  });

  for (const field of [
    "displayName",
    "country",
    "declaredInterest",
    "participationContext",
    "processEmailNoticeAcknowledged",
  ] as const) {
    const input = registrationInput();
    delete input[field];
    assert.equal(
      registerParticipantProfile(
        accountResult.value,
        input,
        REGISTERED_AT,
        NOTICE_EVIDENCE,
      ).ok,
      false,
      `${field} must be required`,
    );
  }

  assert.deepEqual(
    registerParticipantProfile(
      accountResult.value,
      registrationInput({ processEmailNoticeAcknowledged: false }),
      REGISTERED_AT,
      NOTICE_EVIDENCE,
    ),
    {
      ok: false,
      issues: [{ code: "required", path: "processEmailNoticeAcknowledged" }],
    },
  );
  assert.deepEqual(
    registerParticipantProfile(
      accountResult.value,
      {
        ...registrationInput(),
        accountEmailLabel: "replacement@example.invalid",
      },
      REGISTERED_AT,
      NOTICE_EVIDENCE,
    ),
    {
      ok: false,
      issues: [{ code: "invalid_rule", path: "accountEmailLabel" }],
    },
  );
});

test("profile updates change only fields declared participant-editable", () => {
  const profile = registeredProfile(true);
  const result = updateParticipantProfile(
    profile,
    {
      displayName: "Updated participant",
      country: "bv",
      declaredInterest: "investor",
      participationContext: "company",
    },
    UPDATED_AT,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.displayName, "Updated participant");
  assert.equal(result.value.country, "BV");
  assert.equal(result.value.declaredInterest, "investor");
  assert.equal(result.value.participationContext, "company");
  assert.equal(result.value.subject, profile.subject);
  assert.equal(result.value.accountEmailLabel, profile.accountEmailLabel);
  assert.deepEqual(result.value.marketingConsent, profile.marketingConsent);
  assert.equal(result.value.registrationNoticeEvidence, profile.registrationNoticeEvidence);
  assert.equal(result.value.updatedAt, UPDATED_AT);

  assert.deepEqual(
    updateParticipantProfile(
      profile,
      { accountEmailLabel: "replacement@example.invalid" },
      UPDATED_AT,
    ),
    {
      ok: false,
      issues: [{ code: "invalid_rule", path: "accountEmailLabel" }],
    },
  );
  assert.deepEqual(updateParticipantProfile(profile, {}, UPDATED_AT), {
    ok: false,
    issues: [{ code: "required", path: "profile" }],
  });
  assert.equal(
    PARTICIPANT_PROFILE_FIELD_RULES.accountEmailLabel,
    "identity-provider-managed",
  );
  assert.equal(
    PARTICIPANT_PROFILE_FIELD_RULES.declaredInterest,
    "participant-editable",
  );
  assert.equal(PARTICIPANT_PROFILE_FIELD_RULES.marketingConsent, "withdraw-only");
  assert.equal(
    PARTICIPANT_PROFILE_FIELD_RULES.registrationNoticeEvidence,
    "registration-only",
  );
  assert.deepEqual(
    updateParticipantProfile(
      profile,
      { registrationNoticeEvidence: testParticipantRegistrationNoticeEvidence(2) },
      UPDATED_AT,
    ),
    {
      ok: false,
      issues: [{ code: "invalid_rule", path: "registrationNoticeEvidence" }],
    },
  );
});

test("marketing consent withdrawal is independent and idempotent", () => {
  const profile = registeredProfile(true);
  const withdrawn = withdrawMarketingConsent(profile, WITHDRAWN_AT);

  assert.deepEqual(withdrawn.marketingConsent, {
    state: "withdrawn",
    grantedAt: REGISTERED_AT,
    withdrawnAt: WITHDRAWN_AT,
  });
  assert.equal(withdrawn.processEmailNoticeAcknowledgedAt, REGISTERED_AT);
  assert.equal(withdrawn.updatedAt, WITHDRAWN_AT);
  assert.equal(withdrawMarketingConsent(withdrawn, DELETION_AT), withdrawn);
});

test("deletion requests produce a retry-stable active-interest withdrawal intent", () => {
  const profile = registeredProfile(false);
  const transition = requestParticipantAccountDeletion(profile, DELETION_AT);

  assert.deepEqual(transition.profile.accountDeletionRequest, {
    state: "requested",
    requestedAt: DELETION_AT,
    activeInterestDisposition: "withdraw",
  });
  assert.deepEqual(transition.intents, [
    {
      type: "withdraw-active-interest",
      subject: profile.subject,
      reason: "account-deletion-request",
      requestedAt: DELETION_AT,
    },
  ]);

  const retry = requestParticipantAccountDeletion(transition.profile, WITHDRAWN_AT);
  assert.equal(retry.profile, transition.profile);
  assert.deepEqual(retry.intents, transition.intents);
});

test("descendant projections preserve irreversible profile history", () => {
  const registered = registeredProfile(true);
  const updatedResult = updateParticipantProfile(
    registered,
    { displayName: "Updated participant" },
    UPDATED_AT,
  );
  assert(updatedResult.ok);
  const updated = updatedResult.value;
  const withdrawn = withdrawMarketingConsent(updated, WITHDRAWN_AT);
  const deleted = requestParticipantAccountDeletion(
    withdrawn,
    DELETION_AT,
  ).profile;
  assert.equal(
    isParticipantProfileDescendantProjection(registered, updated),
    true,
  );
  assert.equal(
    isParticipantProfileDescendantProjection(registered, deleted),
    true,
  );
  assert.equal(
    isParticipantProfileDescendantProjection(withdrawn, deleted),
    true,
  );

  const deletionBeforeWithdrawal = requestParticipantAccountDeletion(
    updated,
    WITHDRAWN_AT,
  ).profile;
  const withdrawalAfterDeletion = withdrawMarketingConsent(
    deletionBeforeWithdrawal,
    DELETION_AT,
  );
  assert.equal(
    isParticipantProfileDescendantProjection(
      deletionBeforeWithdrawal,
      withdrawalAfterDeletion,
    ),
    true,
  );

  const laterUpdateResult = updateParticipantProfile(
    withdrawn,
    { displayName: "Later participant" },
    DELETION_AT,
  );
  assert(laterUpdateResult.ok);
  const invalidDescendants: readonly Readonly<{
    ancestor: ParticipantProfile;
    descendant: ParticipantProfile;
  }>[] = [
    {
      ancestor: withdrawn,
      descendant: {
        ...withdrawn,
        marketingConsent: registered.marketingConsent,
        updatedAt: DELETION_AT,
      },
    },
    {
      ancestor: deleted,
      descendant: {
        ...deleted,
        accountDeletionRequest: { state: "not-requested" },
      },
    },
    {
      ancestor: withdrawn,
      descendant: {
        ...withdrawn,
        registeredAt: UPDATED_AT,
        processEmailNoticeAcknowledgedAt: UPDATED_AT,
        marketingConsent: {
          state: "withdrawn",
          grantedAt: UPDATED_AT,
          withdrawnAt: WITHDRAWN_AT,
        },
        updatedAt: DELETION_AT,
      },
    },
    {
      ancestor: laterUpdateResult.value,
      descendant: {
        ...laterUpdateResult.value,
        updatedAt: WITHDRAWN_AT,
      },
    },
    {
      ancestor: withdrawn,
      descendant: {
        ...withdrawn,
        marketingConsent: {
          state: "withdrawn",
          grantedAt: REGISTERED_AT,
          withdrawnAt: DELETION_AT,
        },
        updatedAt: DELETION_AT,
      },
    },
    {
      ancestor: deleted,
      descendant: {
        ...deleted,
        displayName: "Edit after deletion",
        updatedAt: timestamp("2026-01-05T00:00:00.000Z"),
      },
    },
  ];
  for (const { ancestor, descendant } of invalidDescendants) {
    assert.equal(
      isParticipantProfileDescendantProjection(ancestor, descendant),
      false,
    );
  }
});

function registeredProfile(marketingConsent: boolean): ParticipantProfile {
  const result = registerParticipantProfile(
    participantAccount(),
    registrationInput({ marketingConsent }),
    REGISTERED_AT,
    NOTICE_EVIDENCE,
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Test profile must be valid.");
  return result.value;
}

function participantAccount(): ParticipantAccount {
  const result = parseParticipantAccount({
    subject: "issuer.invalid/account-subject",
    accountEmailLabel: "account@example.invalid",
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Test account must be valid.");
  return result.value;
}

function registrationInput(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    displayName: "Registered participant",
    country: "AQ",
    declaredInterest: "both",
    participationContext: "individual",
    processEmailNoticeAcknowledged: true,
    marketingConsent: false,
    ...overrides,
  };
}

function timestamp(value: string): Timestamp {
  const result = parseTimestamp(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Test timestamp must be valid.");
  return result.value;
}
