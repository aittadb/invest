import {
  parseContributionAreaChoices,
  type ContributionAreaChoice,
} from "./founder-application.ts";
import type { PhaseConfiguration } from "./phase-configuration.ts";
import type {
  ValidationIssue,
  ValidationResult,
} from "./foundation.ts";

const POLICY_KEYS = new Set([
  "founderContributionChoices",
  "notices",
  "publicationReadiness",
]);
const NOTICE_KEYS = new Set([
  "legalBoundary",
  "nonBindingInterest",
  "privacyContact",
  "retention",
]);
const PRIVACY_CONTACT_KEYS = new Set(["label", "href"]);
const READINESS_FIELDS = [
  "publicPresentationReviewed",
  "legalNoticesReviewed",
  "privacyAndRetentionReviewed",
] as const;
const READINESS_KEYS = new Set<string>(READINESS_FIELDS);
const MAX_NOTICE_LENGTH = 4_000;
const MAX_CONTACT_LABEL_LENGTH = 160;
const MAX_CONTACT_HREF_LENGTH = 2_048;

export type CampaignPrivacyContact = Readonly<{
  label: string;
  href: string;
}>;

export type CampaignPublicationReview = Readonly<{
  publicPresentationReviewed: boolean;
  legalNoticesReviewed: boolean;
  privacyAndRetentionReviewed: boolean;
}>;

/** Private campaign policy that must be supplied explicitly by each deployment. */
export type CampaignSetupPolicy = Readonly<{
  founderContributionChoices: readonly ContributionAreaChoice[];
  notices: Readonly<{
    legalBoundary: string;
    nonBindingInterest: string;
    privacyContact: CampaignPrivacyContact;
    retention: string;
  }>;
  publicationReadiness: CampaignPublicationReview;
}>;

export type CampaignSetupPolicyRequirement =
  | "founderContributionChoices"
  | `publicationReadiness.${keyof CampaignPublicationReview}`;

export type CampaignSetupPolicyStatus = Readonly<{
  complete: boolean;
  missing: readonly CampaignSetupPolicyRequirement[];
}>;

export type CampaignSetupChangeClassification =
  | "none"
  | "editorial"
  | "material";

export type CampaignSetupChangeInput = Readonly<{
  publicCampaign: unknown;
  phases: readonly PhaseConfiguration[];
  amountAggregate: unknown;
  campaignPolicy: CampaignSetupPolicy;
}>;

/** Parse policy fields without supplying legal, privacy, or publication defaults. */
export function parseCampaignSetupPolicy(
  value: unknown,
): ValidationResult<CampaignSetupPolicy> {
  const source = record(value);
  if (source === null) return failure({ code: "invalid_type", path: "policy" });

  const issues: ValidationIssue[] = [];
  rejectUnknownKeys(source, POLICY_KEYS, "", issues);
  requireKeys(source, POLICY_KEYS, "", issues);

  const founderContributionChoices = Object.hasOwn(
      source,
      "founderContributionChoices",
    )
    ? parseContributionAreaChoices(source.founderContributionChoices)
    : null;
  if (founderContributionChoices && !founderContributionChoices.ok) {
    issues.push(...founderContributionChoices.issues);
  }

  const notices = Object.hasOwn(source, "notices")
    ? parseNotices(source.notices, issues)
    : null;
  const publicationReadiness = Object.hasOwn(source, "publicationReadiness")
    ? parsePublicationReadiness(source.publicationReadiness, issues)
    : null;

  if (
    issues.length > 0 ||
    !founderContributionChoices ||
    !founderContributionChoices.ok ||
    notices === null ||
    publicationReadiness === null
  ) {
    return failures(issues);
  }

  return {
    ok: true,
    value: deepFreeze({
      founderContributionChoices: founderContributionChoices.value,
      notices,
      publicationReadiness,
    }),
  };
}

/** Check explicit owner review gates and founder-path configuration. */
export function checkCampaignSetupPolicy(
  policy: CampaignSetupPolicy,
  phases: readonly PhaseConfiguration[],
): CampaignSetupPolicyStatus {
  const missing: CampaignSetupPolicyRequirement[] = [];
  const founderEnabled = phases.some((phase) =>
    phase.enabledParticipationPaths.includes("founder")
  );
  if (founderEnabled && policy.founderContributionChoices.length === 0) {
    missing.push("founderContributionChoices");
  }
  for (const field of READINESS_FIELDS) {
    if (!policy.publicationReadiness[field]) {
      missing.push(`publicationReadiness.${field}`);
    }
  }
  return Object.freeze({
    complete: missing.length === 0,
    missing: Object.freeze(missing),
  });
}

/** Classify policy, phase, or amount changes as material; copy-only changes are editorial. */
export function classifyCampaignSetupChange(
  previous: CampaignSetupChangeInput,
  next: CampaignSetupChangeInput,
): CampaignSetupChangeClassification {
  if (
    !equivalent(previous.phases, next.phases) ||
    !equivalent(previous.amountAggregate, next.amountAggregate) ||
    !equivalent(previous.campaignPolicy, next.campaignPolicy)
  ) {
    return "material";
  }
  return equivalent(previous.publicCampaign, next.publicCampaign)
    ? "none"
    : "editorial";
}

function parseNotices(
  value: unknown,
  issues: ValidationIssue[],
): CampaignSetupPolicy["notices"] | null {
  const source = record(value);
  if (source === null) {
    issues.push({ code: "invalid_type", path: "notices" });
    return null;
  }
  rejectUnknownKeys(source, NOTICE_KEYS, "notices.", issues);
  requireKeys(source, NOTICE_KEYS, "notices.", issues);

  const legalBoundary = Object.hasOwn(source, "legalBoundary")
    ? requiredText(
        source.legalBoundary,
        "notices.legalBoundary",
        MAX_NOTICE_LENGTH,
        issues,
      )
    : null;
  const nonBindingInterest = Object.hasOwn(source, "nonBindingInterest")
    ? requiredText(
        source.nonBindingInterest,
        "notices.nonBindingInterest",
        MAX_NOTICE_LENGTH,
        issues,
      )
    : null;
  const privacyContact = Object.hasOwn(source, "privacyContact")
    ? parsePrivacyContact(source.privacyContact, issues)
    : null;
  const retention = Object.hasOwn(source, "retention")
    ? requiredText(
        source.retention,
        "notices.retention",
        MAX_NOTICE_LENGTH,
        issues,
      )
    : null;

  return legalBoundary && nonBindingInterest && privacyContact && retention
    ? { legalBoundary, nonBindingInterest, privacyContact, retention }
    : null;
}

function parsePrivacyContact(
  value: unknown,
  issues: ValidationIssue[],
): CampaignPrivacyContact | null {
  const source = record(value);
  if (source === null) {
    issues.push({ code: "invalid_type", path: "notices.privacyContact" });
    return null;
  }
  rejectUnknownKeys(
    source,
    PRIVACY_CONTACT_KEYS,
    "notices.privacyContact.",
    issues,
  );
  requireKeys(
    source,
    PRIVACY_CONTACT_KEYS,
    "notices.privacyContact.",
    issues,
  );
  const label = Object.hasOwn(source, "label")
    ? requiredText(
        source.label,
        "notices.privacyContact.label",
        MAX_CONTACT_LABEL_LENGTH,
        issues,
      )
    : null;
  const href = Object.hasOwn(source, "href")
    ? contactHref(source.href, issues)
    : null;
  return label && href ? { label, href } : null;
}

function parsePublicationReadiness(
  value: unknown,
  issues: ValidationIssue[],
): CampaignPublicationReview | null {
  const source = record(value);
  if (source === null) {
    issues.push({ code: "invalid_type", path: "publicationReadiness" });
    return null;
  }
  rejectUnknownKeys(source, READINESS_KEYS, "publicationReadiness.", issues);
  requireKeys(source, READINESS_KEYS, "publicationReadiness.", issues);

  const result: Partial<Record<keyof CampaignPublicationReview, boolean>> = {};
  for (const field of READINESS_FIELDS) {
    if (!Object.hasOwn(source, field)) continue;
    const candidate = source[field];
    if (typeof candidate !== "boolean") {
      issues.push({
        code: "invalid_type",
        path: `publicationReadiness.${field}`,
      });
    } else {
      result[field] = candidate;
    }
  }
  return Object.keys(result).length === READINESS_FIELDS.length
    ? result as CampaignPublicationReview
    : null;
}

function requiredText(
  value: unknown,
  path: string,
  maximumLength: number,
  issues: ValidationIssue[],
): string | null {
  if (typeof value !== "string") {
    issues.push({ code: "invalid_type", path });
    return null;
  }
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0) {
    issues.push({ code: "required", path });
    return null;
  }
  if (normalized.length > maximumLength || hasDisallowedControl(normalized)) {
    issues.push({ code: "out_of_range", path });
    return null;
  }
  return normalized;
}

function contactHref(value: unknown, issues: ValidationIssue[]): string | null {
  const path = "notices.privacyContact.href";
  if (typeof value !== "string") {
    issues.push({ code: "invalid_type", path });
    return null;
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    issues.push({ code: "required", path });
    return null;
  }
  if (normalized.length > MAX_CONTACT_HREF_LENGTH || normalized !== value) {
    issues.push({ code: "invalid_format", path });
    return null;
  }
  try {
    const url = new URL(normalized);
    const safeHttps = url.protocol === "https:" &&
      !url.username && !url.password && !url.hash;
    const safeEmail = url.protocol === "mailto:" &&
      /^[^@\s/?#]+@[^@\s/?#]+$/u.test(url.pathname) &&
      !url.search && !url.hash;
    if (safeHttps || safeEmail) return url.href;
  } catch {
    // The closed validation error below is intentionally non-descriptive.
  }
  issues.push({ code: "invalid_format", path });
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rejectUnknownKeys(
  source: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) issues.push({ code: "invalid_rule", path: `${prefix}${key}` });
  }
}

function requireKeys(
  source: Record<string, unknown>,
  required: ReadonlySet<string>,
  prefix: string,
  issues: ValidationIssue[],
): void {
  for (const key of required) {
    if (!Object.hasOwn(source, key)) issues.push({ code: "required", path: `${prefix}${key}` });
  }
}

function hasDisallowedControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code === 127 || code < 32 && code !== 9 && code !== 10)) {
      return true;
    }
  }
  return false;
}

function equivalent(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function failure<Value>(issue: ValidationIssue): ValidationResult<Value> {
  return { ok: false, issues: [issue] };
}

function failures<Value>(issues: readonly ValidationIssue[]): ValidationResult<Value> {
  return { ok: false, issues };
}
