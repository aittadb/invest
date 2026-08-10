import {
  invalid,
  parseActorSubject,
  parseCountryCode,
  valid,
  type ActorSubject,
  type CountryCode,
  type Timestamp,
  type ValidationIssue,
  type ValidationResult,
} from "./foundation.ts";
import {
  defineParticipantRegistrationNoticeEvidence,
  type ParticipantRegistrationNoticeEvidence,
} from "./participant-registration-notice-evidence.ts";

declare const participantProfileBrand: unique symbol;

/** A display-only email value supplied by the authenticated identity provider. */
export type AccountEmailLabel = string & {
  readonly [participantProfileBrand]: "AccountEmailLabel";
};

/** Identity-bound values that participant form input is not allowed to replace. */
export type ParticipantAccount = Readonly<{
  subject: ActorSubject;
  accountEmailLabel: AccountEmailLabel;
}>;

/** The participation paths a reader currently intends to pursue. */
export type DeclaredInterest = "founder" | "investor" | "both";

/** Whether the reader expects to participate personally or for a company. */
export type ParticipationContext = "individual" | "company";

/** Optional marketing permission, kept separate from required process email. */
export type MarketingConsent =
  | Readonly<{ state: "not-granted" }>
  | Readonly<{ state: "granted"; grantedAt: Timestamp }>
  | Readonly<{
      state: "withdrawn";
      grantedAt?: Timestamp;
      withdrawnAt: Timestamp;
    }>;

/** A deletion request records that active participation must be withdrawn. */
export type AccountDeletionRequestState =
  | Readonly<{ state: "not-requested" }>
  | Readonly<{
      state: "requested";
      requestedAt: Timestamp;
      activeInterestDisposition: "withdraw";
    }>;

/** The access-registration record owned by one authenticated account. */
export type ParticipantProfile = Readonly<{
  subject: ActorSubject;
  accountEmailLabel: AccountEmailLabel;
  displayName: string;
  country: CountryCode;
  declaredInterest: DeclaredInterest;
  participationContext: ParticipationContext;
  registrationNoticeEvidence: ParticipantRegistrationNoticeEvidence;
  processEmailNoticeAcknowledgedAt: Timestamp;
  marketingConsent: MarketingConsent;
  accountDeletionRequest: AccountDeletionRequestState;
  registeredAt: Timestamp;
  updatedAt: Timestamp;
}>;

export type ParticipantProfileFieldRule =
  | "identity-bound"
  | "identity-provider-managed"
  | "participant-editable"
  | "registration-only"
  | "withdraw-only"
  | "request-only"
  | "system-managed";

/** Authoritative edit policy for every persisted participant-profile field. */
export const PARTICIPANT_PROFILE_FIELD_RULES = {
  subject: "identity-bound",
  accountEmailLabel: "identity-provider-managed",
  displayName: "participant-editable",
  country: "participant-editable",
  declaredInterest: "participant-editable",
  participationContext: "participant-editable",
  registrationNoticeEvidence: "registration-only",
  processEmailNoticeAcknowledgedAt: "registration-only",
  marketingConsent: "withdraw-only",
  accountDeletionRequest: "request-only",
  registeredAt: "system-managed",
  updatedAt: "system-managed",
} as const satisfies Readonly<
  Record<keyof ParticipantProfile, ParticipantProfileFieldRule>
>;

/** A side-effect request for an application service, not proof of withdrawal. */
export type ParticipantProfileIntent = Readonly<{
  type: "withdraw-active-interest";
  subject: ActorSubject;
  reason: "account-deletion-request";
  requestedAt: Timestamp;
}>;

/** A profile mutation and the repository-independent effects it requests. */
export type ParticipantProfileTransition = Readonly<{
  profile: ParticipantProfile;
  intents: readonly ParticipantProfileIntent[];
}>;

const ACCOUNT_FIELDS = new Set(["subject", "accountEmailLabel"]);
const REGISTRATION_FIELDS = new Set([
  "displayName",
  "country",
  "declaredInterest",
  "participationContext",
  "processEmailNoticeAcknowledged",
  "marketingConsent",
]);
const EDITABLE_FIELDS = new Set([
  "displayName",
  "country",
  "declaredInterest",
  "participationContext",
]);
const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_EMAIL_LABEL_LENGTH = 254;

/** Parses server-supplied identity values before registration is evaluated. */
export function parseParticipantAccount(
  value: unknown,
): ValidationResult<ParticipantAccount> {
  const source = record(value);
  if (!source) return invalid({ code: "invalid_type", path: "account" });

  const unknownField = firstUnknownField(source, ACCOUNT_FIELDS);
  if (unknownField) {
    return invalid({ code: "invalid_rule", path: unknownField });
  }

  const subject = parseActorSubject(source.subject);
  const accountEmailLabel = parseAccountEmailLabel(source.accountEmailLabel);
  const issues = collectIssues(subject, accountEmailLabel);
  if (issues.length > 0) return invalidIssues(issues);

  if (!subject.ok || !accountEmailLabel.ok) {
    return invalid({ code: "invalid_type", path: "account" });
  }

  return valid({ subject: subject.value, accountEmailLabel: accountEmailLabel.value });
}

/**
 * Creates a first access-registration profile. The process-email notice must be
 * acknowledged; marketing permission remains optional and independent.
 */
export function registerParticipantProfile(
  account: ParticipantAccount,
  value: unknown,
  registeredAt: Timestamp,
  noticeEvidence: ParticipantRegistrationNoticeEvidence,
): ValidationResult<ParticipantProfile> {
  const source = record(value);
  if (!source) return invalid({ code: "invalid_type", path: "profile" });

  const unknownField = firstUnknownField(source, REGISTRATION_FIELDS);
  if (unknownField) {
    return invalid({ code: "invalid_rule", path: unknownField });
  }

  const displayName = parseDisplayName(source.displayName);
  const country = parseCountryCode(source.country);
  const declaredInterest = parseDeclaredInterest(source.declaredInterest);
  const participationContext = parseParticipationContext(
    source.participationContext,
  );
  const processEmailNotice = parseRequiredAcknowledgment(
    source.processEmailNoticeAcknowledged,
  );
  const marketingConsent = parseOptionalConsent(source.marketingConsent, registeredAt);
  let registrationNoticeEvidence: ParticipantRegistrationNoticeEvidence;
  try {
    registrationNoticeEvidence = defineParticipantRegistrationNoticeEvidence(
      noticeEvidence,
    );
  } catch {
    return invalid({
      code: "invalid_rule",
      path: "registrationNoticeEvidence",
    });
  }
  const issues = collectIssues(
    displayName,
    country,
    declaredInterest,
    participationContext,
    processEmailNotice,
    marketingConsent,
  );
  if (issues.length > 0) return invalidIssues(issues);

  if (
    !displayName.ok ||
    !country.ok ||
    !declaredInterest.ok ||
    !participationContext.ok ||
    !processEmailNotice.ok ||
    !marketingConsent.ok
  ) {
    return invalid({ code: "invalid_type", path: "profile" });
  }

  return valid({
    subject: account.subject,
    accountEmailLabel: account.accountEmailLabel,
    displayName: displayName.value,
    country: country.value,
    declaredInterest: declaredInterest.value,
    participationContext: participationContext.value,
    registrationNoticeEvidence,
    processEmailNoticeAcknowledgedAt: registeredAt,
    marketingConsent: marketingConsent.value,
    accountDeletionRequest: { state: "not-requested" },
    registeredAt,
    updatedAt: registeredAt,
  });
}

/** Applies only participant-editable fields and rejects identity or state fields. */
export function updateParticipantProfile(
  profile: ParticipantProfile,
  value: unknown,
  updatedAt: Timestamp,
): ValidationResult<ParticipantProfile> {
  const source = record(value);
  if (!source) return invalid({ code: "invalid_type", path: "profile" });

  const fields = Object.keys(source);
  if (fields.length === 0) return invalid({ code: "required", path: "profile" });

  const unknownField = firstUnknownField(source, EDITABLE_FIELDS);
  if (unknownField) {
    return invalid({ code: "invalid_rule", path: unknownField });
  }

  const displayName = source.displayName === undefined
    ? valid(profile.displayName)
    : parseDisplayName(source.displayName);
  const country = source.country === undefined
    ? valid(profile.country)
    : parseCountryCode(source.country);
  const declaredInterest = source.declaredInterest === undefined
    ? valid(profile.declaredInterest)
    : parseDeclaredInterest(source.declaredInterest);
  const participationContext = source.participationContext === undefined
    ? valid(profile.participationContext)
    : parseParticipationContext(source.participationContext);
  const issues = collectIssues(
    displayName,
    country,
    declaredInterest,
    participationContext,
  );
  if (issues.length > 0) return invalidIssues(issues);

  if (
    !displayName.ok ||
    !country.ok ||
    !declaredInterest.ok ||
    !participationContext.ok
  ) {
    return invalid({ code: "invalid_type", path: "profile" });
  }

  return valid({
    ...profile,
    displayName: displayName.value,
    country: country.value,
    declaredInterest: declaredInterest.value,
    participationContext: participationContext.value,
    updatedAt,
  });
}

/** Withdraws optional marketing permission without affecting process messages. */
export function withdrawMarketingConsent(
  profile: ParticipantProfile,
  withdrawnAt: Timestamp,
): ParticipantProfile {
  if (profile.marketingConsent.state === "withdrawn") return profile;

  const grantedAt = profile.marketingConsent.state === "granted"
    ? profile.marketingConsent.grantedAt
    : undefined;

  return {
    ...profile,
    marketingConsent: {
      state: "withdrawn",
      ...(grantedAt ? { grantedAt } : {}),
      withdrawnAt,
    },
    updatedAt: withdrawnAt,
  };
}

/**
 * Requests deletion and emits the intent to withdraw all active interest. A
 * retry repeats the same intent and original request timestamp.
 */
export function requestParticipantAccountDeletion(
  profile: ParticipantProfile,
  requestedAt: Timestamp,
): ParticipantProfileTransition {
  const effectiveRequestedAt = profile.accountDeletionRequest.state === "requested"
    ? profile.accountDeletionRequest.requestedAt
    : requestedAt;
  const nextProfile = profile.accountDeletionRequest.state === "requested"
    ? profile
    : {
        ...profile,
        accountDeletionRequest: {
          state: "requested" as const,
          requestedAt: effectiveRequestedAt,
          activeInterestDisposition: "withdraw" as const,
        },
        updatedAt: effectiveRequestedAt,
      };

  return {
    profile: nextProfile,
    intents: [
      {
        type: "withdraw-active-interest",
        subject: profile.subject,
        reason: "account-deletion-request",
        requestedAt: effectiveRequestedAt,
      },
    ],
  };
}

function parseAccountEmailLabel(
  value: unknown,
): ValidationResult<AccountEmailLabel> {
  if (typeof value !== "string") {
    return invalid({ code: "invalid_type", path: "accountEmailLabel" });
  }

  const normalized = value.trim();
  const parts = normalized.split("@");
  if (normalized.length === 0) {
    return invalid({ code: "required", path: "accountEmailLabel" });
  }
  if (
    normalized.length > MAX_EMAIL_LABEL_LENGTH ||
    normalized !== value ||
    hasControlCharacter(normalized) ||
    /\s/u.test(normalized) ||
    parts.length !== 2 ||
    parts[0].length === 0 ||
    parts[1].length === 0
  ) {
    return invalid({ code: "invalid_format", path: "accountEmailLabel" });
  }

  return valid(normalized as AccountEmailLabel);
}

function parseDisplayName(value: unknown): ValidationResult<string> {
  if (typeof value !== "string") {
    return invalid({ code: "invalid_type", path: "displayName" });
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return invalid({ code: "required", path: "displayName" });
  }
  if (
    normalized.length > MAX_DISPLAY_NAME_LENGTH ||
    hasControlCharacter(normalized)
  ) {
    return invalid({ code: "invalid_format", path: "displayName" });
  }

  return valid(normalized);
}

function parseDeclaredInterest(value: unknown): ValidationResult<DeclaredInterest> {
  if (value === "founder" || value === "investor" || value === "both") {
    return valid(value);
  }
  return invalid({
    code: typeof value === "string" ? "invalid_format" : "invalid_type",
    path: "declaredInterest",
  });
}

function parseParticipationContext(
  value: unknown,
): ValidationResult<ParticipationContext> {
  if (value === "individual" || value === "company") return valid(value);
  return invalid({
    code: typeof value === "string" ? "invalid_format" : "invalid_type",
    path: "participationContext",
  });
}

function parseRequiredAcknowledgment(value: unknown): ValidationResult<true> {
  return value === true
    ? valid(true)
    : invalid({ code: "required", path: "processEmailNoticeAcknowledged" });
}

function parseOptionalConsent(
  value: unknown,
  registeredAt: Timestamp,
): ValidationResult<MarketingConsent> {
  if (value === undefined || value === false) {
    return valid({ state: "not-granted" });
  }
  if (value === true) {
    return valid({ state: "granted", grantedAt: registeredAt });
  }
  return invalid({ code: "invalid_type", path: "marketingConsent" });
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstUnknownField(
  source: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): string | null {
  return Object.keys(source).find((field) => !allowed.has(field)) ?? null;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }

  return false;
}

function collectIssues(
  ...results: readonly ValidationResult<unknown>[]
): readonly ValidationIssue[] {
  return results.flatMap((result) => (result.ok ? [] : result.issues));
}

function invalidIssues<Value>(
  issues: readonly ValidationIssue[],
): ValidationResult<Value> {
  return { ok: false, issues };
}
