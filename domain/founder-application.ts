import {
  invalid,
  parseActorSubject,
  parseStableId,
  parseTimestamp,
  valid,
  type ActorSubject,
  type StableId,
  type Timestamp,
  type ValidationResult,
} from "./foundation.ts";

/** Stable identity of one founder application. */
export type FounderApplicationId = StableId<"founder-application">;

/** Stable identity of a deployment-configured contribution area. */
export type ContributionAreaId = StableId<"founder-contribution-area">;

/** Stable identity of one immutable founder-application history entry. */
export type FounderApplicationHistoryEntryId =
  StableId<"founder-application-history-entry">;

/**
 * One owner-configured contribution choice. Investor App supplies no default
 * choices; each deployment provides and labels its own list.
 */
export type ContributionAreaChoice = Readonly<{
  id: ContributionAreaId;
  label: string;
}>;

/** Validated, complete fields submitted by a founder candidate. */
export type FounderApplicationFields = Readonly<{
  expertiseSummary: string;
  intendedContribution: string;
  primaryContributionAreaId: ContributionAreaId;
  secondaryContributionAreaIds: readonly ContributionAreaId[];
  approximateAvailability: string;
  possibleStartTiming: string;
  compensationExpectation: string;
  professionalProfileLinks: readonly string[];
  note: string | null;
}>;

/** Version one records receipt and withdrawal, not founder-selection decisions. */
export type FounderApplicationStatus = "received" | "withdrawn";

export type FounderApplicationHistoryKind = "created" | "edited" | "withdrawn";

type FounderApplicationHistoryEntryBase = Readonly<{
  id: FounderApplicationHistoryEntryId;
  applicationId: FounderApplicationId;
  applicantSubject: ActorSubject;
  occurredAt: Timestamp;
  revision: number;
  fields: FounderApplicationFields;
}>;

/** Immutable snapshot of a create, edit, or withdrawal transition. */
export type FounderApplicationHistoryEntry =
  | (FounderApplicationHistoryEntryBase &
      Readonly<{
        kind: "created" | "edited";
        status: "received";
      }>)
  | (FounderApplicationHistoryEntryBase &
      Readonly<{
        kind: "withdrawn";
        status: "withdrawn";
      }>);

type FounderApplicationBase = Readonly<{
  id: FounderApplicationId;
  applicantSubject: ActorSubject;
  fields: FounderApplicationFields;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  revision: number;
  history: readonly FounderApplicationHistoryEntry[];
}>;

/** A received application remains editable by its applicant subject. */
export type ReceivedFounderApplication = FounderApplicationBase &
  Readonly<{
    status: "received";
    withdrawnAt: null;
  }>;

/** A withdrawn application is retained as immutable historical evidence. */
export type WithdrawnFounderApplication = FounderApplicationBase &
  Readonly<{
    status: "withdrawn";
    withdrawnAt: Timestamp;
  }>;

/** Current founder application state and its complete immutable history. */
export type FounderApplication =
  | ReceivedFounderApplication
  | WithdrawnFounderApplication;

/**
 * Founder and investment participation coexist without gating one another.
 * Founder transitions consume only `founderApplication`; the generic investment
 * records remain owned by the separate investment domain.
 */
export type IndependentParticipationRecords<InvestmentRecord> = Readonly<{
  founderApplication: FounderApplication | null;
  investmentRecords: readonly InvestmentRecord[];
}>;

/**
 * Founder history is returned as one bounded resource. Reserve the final
 * transition for withdrawal so every received application can still be
 * withdrawn after the maximum supported number of edits.
 */
export const MAX_FOUNDER_APPLICATION_REVISIONS = 16;

export function canEditFounderApplication(
  application: FounderApplication,
): application is ReceivedFounderApplication {
  return application.status === "received" &&
    application.revision < MAX_FOUNDER_APPLICATION_REVISIONS - 1;
}

export function canWithdrawFounderApplication(
  application: FounderApplication,
): application is ReceivedFounderApplication {
  return application.status === "received" &&
    application.revision < MAX_FOUNDER_APPLICATION_REVISIONS;
}

const MAX_CONTRIBUTION_AREA_CHOICES = 64;
const MAX_CONTRIBUTION_AREA_LABEL_LENGTH = 120;
export const MAX_SECONDARY_CONTRIBUTION_AREAS = 16;
const MAX_LONG_TEXT_LENGTH = 4_000;
const MAX_SHORT_TEXT_LENGTH = 500;
export const MAX_PROFILE_LINKS = 8;
export const MAX_PROFILE_LINK_LENGTH = 2_048;
export const MAX_CANONICAL_PROFILE_LINK_LENGTH = MAX_PROFILE_LINK_LENGTH * 9;
export const MAX_CANONICAL_PROFILE_LINK_BYTES =
  MAX_CANONICAL_PROFILE_LINK_LENGTH;

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNamedStableId<Entity extends string>(
  value: unknown,
  path: string,
): ValidationResult<StableId<Entity>> {
  const result = parseStableId<Entity>(value);
  if (result.ok) {
    return result;
  }

  return {
    ok: false,
    issues: result.issues.map((issue) => ({ ...issue, path })),
  };
}

function parseNamedSubject(
  value: unknown,
  path: string,
): ValidationResult<ActorSubject> {
  const result = parseActorSubject(value);
  if (result.ok) {
    return result;
  }

  return {
    ok: false,
    issues: result.issues.map((issue) => ({ ...issue, path })),
  };
}

function parseNamedTimestamp(
  value: unknown,
  path: string,
): ValidationResult<Timestamp> {
  const result = parseTimestamp(value);
  if (result.ok) {
    return result;
  }

  return {
    ok: false,
    issues: result.issues.map((issue) => ({ ...issue, path })),
  };
}

function hasDisallowedControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint === 127 ||
        (codePoint < 32 && codePoint !== 9 && codePoint !== 10))
    ) {
      return true;
    }
  }

  return false;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function parseRequiredText(
  value: unknown,
  path: string,
  maximumLength: number,
): ValidationResult<string> {
  if (typeof value !== "string") {
    return invalid({ code: "invalid_type", path });
  }

  const normalized = normalizeText(value);
  if (normalized.length === 0) {
    return invalid({ code: "required", path });
  }

  if (
    normalized.length > maximumLength ||
    hasDisallowedControlCharacter(normalized)
  ) {
    return invalid({ code: "out_of_range", path });
  }

  return valid(normalized);
}

function parseOptionalText(
  value: unknown,
  path: string,
  maximumLength: number,
): ValidationResult<string | null> {
  if (value === undefined || value === null || value === "") {
    return valid(null);
  }

  const result = parseRequiredText(value, path, maximumLength);
  return result.ok ? result : result;
}

/** Parse and freeze deployment-supplied contribution-area choices. */
export function parseContributionAreaChoices(
  value: unknown,
): ValidationResult<readonly ContributionAreaChoice[]> {
  if (!Array.isArray(value)) {
    return invalid({ code: "invalid_type", path: "contributionAreaChoices" });
  }

  if (value.length > MAX_CONTRIBUTION_AREA_CHOICES) {
    return invalid({ code: "out_of_range", path: "contributionAreaChoices" });
  }

  const choices: ContributionAreaChoice[] = [];
  const seenIds = new Set<string>();

  for (const [index, candidate] of value.entries()) {
    const path = `contributionAreaChoices[${index}]`;
    if (!isRecord(candidate)) {
      return invalid({ code: "invalid_type", path });
    }

    const id = parseNamedStableId<"founder-contribution-area">(
      candidate.id,
      `${path}.id`,
    );
    if (!id.ok) {
      return id;
    }

    const label = parseRequiredText(
      candidate.label,
      `${path}.label`,
      MAX_CONTRIBUTION_AREA_LABEL_LENGTH,
    );
    if (!label.ok) {
      return label;
    }

    if (seenIds.has(id.value)) {
      return invalid({ code: "invalid_rule", path: `${path}.id` });
    }

    seenIds.add(id.value);
    choices.push(Object.freeze({ id: id.value, label: label.value }));
  }

  return valid(Object.freeze(choices));
}

function parseContributionAreaId(
  value: unknown,
  path: string,
  allowedIds: ReadonlySet<string>,
): ValidationResult<ContributionAreaId> {
  const id = parseNamedStableId<"founder-contribution-area">(value, path);
  if (!id.ok) {
    return id;
  }

  if (!allowedIds.has(id.value)) {
    return invalid({ code: "invalid_rule", path });
  }

  return id;
}

function parseSecondaryContributionAreaIds(
  value: unknown,
  primaryId: ContributionAreaId,
  allowedIds: ReadonlySet<string>,
): ValidationResult<readonly ContributionAreaId[]> {
  if (value === undefined) {
    return valid(Object.freeze([]));
  }

  if (!Array.isArray(value)) {
    return invalid({
      code: "invalid_type",
      path: "fields.secondaryContributionAreaIds",
    });
  }

  if (value.length > MAX_SECONDARY_CONTRIBUTION_AREAS) {
    return invalid({
      code: "out_of_range",
      path: "fields.secondaryContributionAreaIds",
    });
  }

  const ids: ContributionAreaId[] = [];
  const seenIds = new Set<string>();

  for (const [index, candidate] of value.entries()) {
    const path = `fields.secondaryContributionAreaIds[${index}]`;
    const id = parseContributionAreaId(candidate, path, allowedIds);
    if (!id.ok) {
      return id;
    }

    if (id.value === primaryId || seenIds.has(id.value)) {
      return invalid({ code: "invalid_rule", path });
    }

    seenIds.add(id.value);
    ids.push(id.value);
  }

  return valid(Object.freeze(ids));
}

function parseProfessionalProfileLinks(
  value: unknown,
): ValidationResult<readonly string[]> {
  if (value === undefined) {
    return valid(Object.freeze([]));
  }

  if (!Array.isArray(value)) {
    return invalid({
      code: "invalid_type",
      path: "fields.professionalProfileLinks",
    });
  }

  if (value.length > MAX_PROFILE_LINKS) {
    return invalid({
      code: "out_of_range",
      path: "fields.professionalProfileLinks",
    });
  }

  const links: string[] = [];
  const seenLinks = new Set<string>();

  for (const [index, candidate] of value.entries()) {
    const path = `fields.professionalProfileLinks[${index}]`;
    if (typeof candidate !== "string") {
      return invalid({ code: "invalid_format", path });
    }

    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      return invalid({ code: "invalid_format", path });
    }

    const canonicalBytes = new TextEncoder().encode(parsed.href).byteLength;
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.length === 0 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.href.length > MAX_CANONICAL_PROFILE_LINK_LENGTH ||
      canonicalBytes > MAX_CANONICAL_PROFILE_LINK_BYTES ||
      (candidate.length > MAX_PROFILE_LINK_LENGTH && candidate !== parsed.href) ||
      seenLinks.has(parsed.href)
    ) {
      return invalid({ code: "invalid_format", path });
    }

    seenLinks.add(parsed.href);
    links.push(parsed.href);
  }

  return valid(Object.freeze(links));
}

/** Parse complete founder fields against the deployment's contribution choices. */
export function parseFounderApplicationFields(
  value: unknown,
  contributionAreaChoices: readonly ContributionAreaChoice[],
): ValidationResult<FounderApplicationFields> {
  if (!isRecord(value)) {
    return invalid({ code: "invalid_type", path: "fields" });
  }

  const expertiseSummary = parseRequiredText(
    value.expertiseSummary,
    "fields.expertiseSummary",
    MAX_LONG_TEXT_LENGTH,
  );
  if (!expertiseSummary.ok) {
    return expertiseSummary;
  }

  const intendedContribution = parseRequiredText(
    value.intendedContribution,
    "fields.intendedContribution",
    MAX_LONG_TEXT_LENGTH,
  );
  if (!intendedContribution.ok) {
    return intendedContribution;
  }

  const allowedIds = new Set(contributionAreaChoices.map((choice) => choice.id));
  const primaryContributionAreaId = parseContributionAreaId(
    value.primaryContributionAreaId,
    "fields.primaryContributionAreaId",
    allowedIds,
  );
  if (!primaryContributionAreaId.ok) {
    return primaryContributionAreaId;
  }

  const secondaryContributionAreaIds = parseSecondaryContributionAreaIds(
    value.secondaryContributionAreaIds,
    primaryContributionAreaId.value,
    allowedIds,
  );
  if (!secondaryContributionAreaIds.ok) {
    return secondaryContributionAreaIds;
  }

  const approximateAvailability = parseRequiredText(
    value.approximateAvailability,
    "fields.approximateAvailability",
    MAX_SHORT_TEXT_LENGTH,
  );
  if (!approximateAvailability.ok) {
    return approximateAvailability;
  }

  const possibleStartTiming = parseRequiredText(
    value.possibleStartTiming,
    "fields.possibleStartTiming",
    MAX_SHORT_TEXT_LENGTH,
  );
  if (!possibleStartTiming.ok) {
    return possibleStartTiming;
  }

  const compensationExpectation = parseRequiredText(
    value.compensationExpectation,
    "fields.compensationExpectation",
    MAX_SHORT_TEXT_LENGTH,
  );
  if (!compensationExpectation.ok) {
    return compensationExpectation;
  }

  const professionalProfileLinks = parseProfessionalProfileLinks(
    value.professionalProfileLinks,
  );
  if (!professionalProfileLinks.ok) {
    return professionalProfileLinks;
  }

  const note = parseOptionalText(value.note, "fields.note", MAX_LONG_TEXT_LENGTH);
  if (!note.ok) {
    return note;
  }

  return valid(
    Object.freeze({
      expertiseSummary: expertiseSummary.value,
      intendedContribution: intendedContribution.value,
      primaryContributionAreaId: primaryContributionAreaId.value,
      secondaryContributionAreaIds: secondaryContributionAreaIds.value,
      approximateAvailability: approximateAvailability.value,
      possibleStartTiming: possibleStartTiming.value,
      compensationExpectation: compensationExpectation.value,
      professionalProfileLinks: professionalProfileLinks.value,
      note: note.value,
    }),
  );
}

function parseOperationInput(value: unknown): ValidationResult<UnknownRecord> {
  return isRecord(value)
    ? valid(value)
    : invalid({ code: "invalid_type", path: "input" });
}

function parseHistoryEntryId(
  value: unknown,
): ValidationResult<FounderApplicationHistoryEntryId> {
  return parseNamedStableId<"founder-application-history-entry">(
    value,
    "historyEntryId",
  );
}

function validateTransitionMetadata(
  application: FounderApplication,
  actorSubject: ActorSubject,
  occurredAt: Timestamp,
  historyEntryId: FounderApplicationHistoryEntryId,
): ValidationResult<true> {
  if (actorSubject !== application.applicantSubject) {
    return invalid({ code: "invalid_rule", path: "actorSubject" });
  }

  if (occurredAt < application.updatedAt) {
    return invalid({ code: "out_of_range", path: "occurredAt" });
  }

  if (application.history.some((entry) => entry.id === historyEntryId)) {
    return invalid({ code: "invalid_rule", path: "historyEntryId" });
  }

  return valid(true);
}

/**
 * Create a received founder application from unknown boundary input. The input
 * must contain `id`, `applicantSubject`, `occurredAt`, `historyEntryId`, and
 * complete `fields`.
 */
export function createFounderApplication(
  value: unknown,
  contributionAreaChoices: readonly ContributionAreaChoice[],
): ValidationResult<ReceivedFounderApplication> {
  const input = parseOperationInput(value);
  if (!input.ok) {
    return input;
  }

  const id = parseNamedStableId<"founder-application">(input.value.id, "id");
  if (!id.ok) {
    return id;
  }

  const applicantSubject = parseNamedSubject(
    input.value.applicantSubject,
    "applicantSubject",
  );
  if (!applicantSubject.ok) {
    return applicantSubject;
  }

  const occurredAt = parseNamedTimestamp(input.value.occurredAt, "occurredAt");
  if (!occurredAt.ok) {
    return occurredAt;
  }

  const historyEntryId = parseHistoryEntryId(input.value.historyEntryId);
  if (!historyEntryId.ok) {
    return historyEntryId;
  }

  const fields = parseFounderApplicationFields(
    input.value.fields,
    contributionAreaChoices,
  );
  if (!fields.ok) {
    return fields;
  }

  const historyEntry: FounderApplicationHistoryEntry = Object.freeze({
    id: historyEntryId.value,
    applicationId: id.value,
    applicantSubject: applicantSubject.value,
    occurredAt: occurredAt.value,
    revision: 1,
    kind: "created",
    status: "received",
    fields: fields.value,
  });

  return valid(
    Object.freeze({
      id: id.value,
      applicantSubject: applicantSubject.value,
      fields: fields.value,
      status: "received",
      createdAt: occurredAt.value,
      updatedAt: occurredAt.value,
      withdrawnAt: null,
      revision: 1,
      history: Object.freeze([historyEntry]),
    }),
  );
}

/** Replace all editable fields on a received application owned by the actor. */
export function editFounderApplication(
  application: FounderApplication,
  value: unknown,
  contributionAreaChoices: readonly ContributionAreaChoice[],
): ValidationResult<ReceivedFounderApplication> {
  if (!canEditFounderApplication(application)) {
    return invalid({ code: "invalid_rule", path: "status" });
  }

  const input = parseOperationInput(value);
  if (!input.ok) {
    return input;
  }

  const actorSubject = parseNamedSubject(input.value.actorSubject, "actorSubject");
  if (!actorSubject.ok) {
    return actorSubject;
  }

  const occurredAt = parseNamedTimestamp(input.value.occurredAt, "occurredAt");
  if (!occurredAt.ok) {
    return occurredAt;
  }

  const historyEntryId = parseHistoryEntryId(input.value.historyEntryId);
  if (!historyEntryId.ok) {
    return historyEntryId;
  }

  const transition = validateTransitionMetadata(
    application,
    actorSubject.value,
    occurredAt.value,
    historyEntryId.value,
  );
  if (!transition.ok) {
    return transition;
  }

  const fields = parseFounderApplicationFields(
    input.value.fields,
    contributionAreaChoices,
  );
  if (!fields.ok) {
    return fields;
  }

  const revision = application.revision + 1;
  const historyEntry: FounderApplicationHistoryEntry = Object.freeze({
    id: historyEntryId.value,
    applicationId: application.id,
    applicantSubject: application.applicantSubject,
    occurredAt: occurredAt.value,
    revision,
    kind: "edited",
    status: "received",
    fields: fields.value,
  });

  return valid(
    Object.freeze({
      ...application,
      fields: fields.value,
      updatedAt: occurredAt.value,
      revision,
      history: Object.freeze([...application.history, historyEntry]),
    }),
  );
}

/** Withdraw a received application without changing or deleting its field history. */
export function withdrawFounderApplication(
  application: FounderApplication,
  value: unknown,
): ValidationResult<WithdrawnFounderApplication> {
  if (!canWithdrawFounderApplication(application)) {
    return invalid({ code: "invalid_rule", path: "status" });
  }

  const input = parseOperationInput(value);
  if (!input.ok) {
    return input;
  }

  const actorSubject = parseNamedSubject(input.value.actorSubject, "actorSubject");
  if (!actorSubject.ok) {
    return actorSubject;
  }

  const occurredAt = parseNamedTimestamp(input.value.occurredAt, "occurredAt");
  if (!occurredAt.ok) {
    return occurredAt;
  }

  const historyEntryId = parseHistoryEntryId(input.value.historyEntryId);
  if (!historyEntryId.ok) {
    return historyEntryId;
  }

  const transition = validateTransitionMetadata(
    application,
    actorSubject.value,
    occurredAt.value,
    historyEntryId.value,
  );
  if (!transition.ok) {
    return transition;
  }

  const revision = application.revision + 1;
  const historyEntry: FounderApplicationHistoryEntry = Object.freeze({
    id: historyEntryId.value,
    applicationId: application.id,
    applicantSubject: application.applicantSubject,
    occurredAt: occurredAt.value,
    revision,
    kind: "withdrawn",
    status: "withdrawn",
    fields: application.fields,
  });

  return valid(
    Object.freeze({
      ...application,
      status: "withdrawn",
      updatedAt: occurredAt.value,
      withdrawnAt: occurredAt.value,
      revision,
      history: Object.freeze([...application.history, historyEntry]),
    }),
  );
}
