import type { CampaignSetupPolicy } from "./campaign-setup-policy.ts";

const NOTICE_EVIDENCE_KEYS = new Set([
  "version",
  "campaignRevision",
  "processEmail",
  "marketing",
]);
const NOTICE_EVIDENCE_PREFIX = "participant-registration-notice:v1:";
const MAX_NOTICE_CODE_UNITS = 4_000;

export const PARTICIPANT_REGISTRATION_NOTICE_LIMITS = Object.freeze({
  maxCodeUnits: MAX_NOTICE_CODE_UNITS,
  maxUtf8Bytes: MAX_NOTICE_CODE_UNITS * 3,
  maxVersionCharacters: NOTICE_EVIDENCE_PREFIX.length + 16,
});

export type ParticipantRegistrationNotices = Readonly<{
  processEmail: string;
  marketing: string;
}>;

/** Immutable evidence for the exact campaign notices accepted at registration. */
export type ParticipantRegistrationNoticeEvidence = Readonly<{
  version: string;
  campaignRevision: number;
  processEmail: string;
  marketing: string;
}>;

/** Validate deployment-supplied notice text without adding defaults. */
export function defineParticipantRegistrationNotices(
  value: unknown,
): ParticipantRegistrationNotices {
  const source = exactDataRecord(value, new Set(["processEmail", "marketing"]));
  if (source === null) throw new ParticipantRegistrationNoticeEvidenceError();
  return Object.freeze({
    processEmail: requiredNotice(source.processEmail),
    marketing: requiredNotice(source.marketing),
  });
}

/** Map only registration notices out of the validated private campaign policy. */
export function participantRegistrationNoticesFromCampaignPolicy(
  policy: CampaignSetupPolicy,
): ParticipantRegistrationNotices {
  const notices = policy?.notices;
  if (notices === undefined) throw new ParticipantRegistrationNoticeEvidenceError();
  return defineParticipantRegistrationNotices({
    processEmail: notices.processEmail,
    marketing: notices.marketingConsent,
  });
}

/** Bind exact notice text to one immutable persisted campaign setup revision. */
export function createParticipantRegistrationNoticeEvidence(
  campaignRevision: number,
  notices: ParticipantRegistrationNotices,
): ParticipantRegistrationNoticeEvidence {
  const revision = requiredCampaignRevision(campaignRevision);
  const bounded = defineParticipantRegistrationNotices(notices);
  return Object.freeze({
    version: noticeEvidenceVersion(revision),
    campaignRevision: revision,
    processEmail: bounded.processEmail,
    marketing: bounded.marketing,
  });
}

/** Revalidate persisted or injected evidence as one closed immutable value. */
export function defineParticipantRegistrationNoticeEvidence(
  value: unknown,
): ParticipantRegistrationNoticeEvidence {
  const source = exactDataRecord(value, NOTICE_EVIDENCE_KEYS);
  if (source === null) {
    throw new ParticipantRegistrationNoticeEvidenceError();
  }
  const evidence = createParticipantRegistrationNoticeEvidence(
    requiredCampaignRevision(source.campaignRevision),
    {
      processEmail: requiredNotice(source.processEmail),
      marketing: requiredNotice(source.marketing),
    },
  );
  if (source.version !== evidence.version) {
    throw new ParticipantRegistrationNoticeEvidenceError();
  }
  return evidence;
}

export function parseParticipantRegistrationNoticeEvidenceVersion(
  value: unknown,
): Readonly<{ version: string; campaignRevision: number }> | null {
  if (
    typeof value !== "string" ||
    value.length !== PARTICIPANT_REGISTRATION_NOTICE_LIMITS.maxVersionCharacters ||
    !value.startsWith(NOTICE_EVIDENCE_PREFIX)
  ) {
    return null;
  }
  const encodedRevision = value.slice(NOTICE_EVIDENCE_PREFIX.length);
  if (!/^[0-9]{16}$/u.test(encodedRevision)) return null;
  const campaignRevision = Number(encodedRevision);
  if (!validCampaignRevision(campaignRevision)) return null;
  if (noticeEvidenceVersion(campaignRevision) !== value) return null;
  return Object.freeze({ version: value, campaignRevision });
}

export class ParticipantRegistrationNoticeEvidenceError extends Error {
  constructor() {
    super("The participant registration notice evidence is invalid.");
    this.name = "ParticipantRegistrationNoticeEvidenceError";
  }
}

function noticeEvidenceVersion(campaignRevision: number): string {
  return `${NOTICE_EVIDENCE_PREFIX}${String(campaignRevision).padStart(16, "0")}`;
}

function requiredCampaignRevision(value: unknown): number {
  if (!validCampaignRevision(value)) {
    throw new ParticipantRegistrationNoticeEvidenceError();
  }
  return value;
}

function validCampaignRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function requiredNotice(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > PARTICIPANT_REGISTRATION_NOTICE_LIMITS.maxCodeUnits ||
    value.trim() !== value ||
    hasControlCharacter(value) ||
    new TextEncoder().encode(value).byteLength >
      PARTICIPANT_REGISTRATION_NOTICE_LIMITS.maxUtf8Bytes
  ) {
    throw new ParticipantRegistrationNoticeEvidenceError();
  }
  return value;
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

function exactDataRecord(
  value: unknown,
  expectedKeys: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.size ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
  ) {
    return null;
  }

  const source: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return null;
    }
    source[key] = descriptor.value;
  }
  return source;
}
