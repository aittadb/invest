/**
 * Framework-independent investment-indication shapes and lifecycle rules.
 *
 * Malformed boundary input returns `ValidationResult`. Failures involving
 * authorization, occupied uniqueness keys, lifecycle state, or trusted package
 * state throw the fixed `DomainError` messages defined by the foundation.
 *
 * @packageDocumentation
 */

import {
  DomainError,
  invalid,
  parseCountryCode,
  parseStableId,
  parseTimestamp,
  valid,
  type Actor,
  type CountryCode,
  type CountryCodeOptions,
  type MinorUnits,
  type StableId,
  type Timestamp,
  type ValidationIssue,
  type ValidationResult,
} from "./foundation.ts";
import {
  parseConfiguredAmount,
  type AmountConfiguration,
  type CurrencyCode,
} from "./amount-aggregate-configuration.ts";
import {
  requiresRenewedAcceptance,
  type PackageAcceptanceRecord,
  type PackageVersion,
} from "./package-content.ts";

declare const investmentIndicationBrand: unique symbol;

export type InvestmentIndicationId = StableId<"investment-indication">;
export type InvestmentIndicationHistoryEntryId =
  StableId<"investment-indication-history-entry">;

/** Canonical local registration identifier used only after country normalization. */
export type NormalizedCompanyIdentifier = string & {
  readonly [investmentIndicationBrand]: "NormalizedCompanyIdentifier";
};

/** Opaque internal key for one active personal or company uniqueness scope. */
export type ActiveIndicationUniquenessKey = string & {
  readonly [investmentIndicationBrand]: "ActiveIndicationUniquenessKey";
};

export type ParticipantIndicationActor = Extract<
  Actor,
  Readonly<{ type: "participant" }>
>;
export type OwnerIndicationActor = Extract<
  Actor,
  Readonly<{ type: "owner" }>
>;

/** Participant-entered fields for a personal non-binding indication. */
export type PersonalInvestmentIndicationFields = Readonly<{
  kind: "personal";
  residenceCountry: CountryCode;
  amount: MinorUnits;
  currency: CurrencyCode;
  availabilityPeriod: string;
  note: string | null;
}>;

/** Participant-entered fields for a company non-binding indication. */
export type CompanyInvestmentIndicationFields = Readonly<{
  kind: "company";
  companyName: string;
  registrationCountry: CountryCode;
  companyIdentifier: NormalizedCompanyIdentifier;
  representativeName: string;
  representativeAuthorityDeclared: true;
  amount: MinorUnits;
  currency: CurrencyCode;
  availabilityPeriod: string;
  note: string | null;
}>;

export type InvestmentIndicationFields =
  | PersonalInvestmentIndicationFields
  | CompanyInvestmentIndicationFields;

export type InvestmentIndicationStatus = "active" | "withdrawn" | "rejected";

/** Owner moderation evidence retained in private indication history. */
export type InvestmentIndicationRejection = Readonly<{
  reason: string;
  rejectedAt: Timestamp;
  rejectedBy: OwnerIndicationActor;
}>;

export type ActiveInvestmentIndicationLifecycle = Readonly<{
  status: "active";
  activatedAt: Timestamp;
  withdrawnAt: null;
  rejectedAt: null;
  rejection: null;
}>;

export type WithdrawnInvestmentIndicationLifecycle = Readonly<{
  status: "withdrawn";
  activatedAt: Timestamp;
  withdrawnAt: Timestamp;
  rejectedAt: null;
  rejection: null;
}>;

export type RejectedInvestmentIndicationLifecycle = Readonly<{
  status: "rejected";
  activatedAt: Timestamp;
  withdrawnAt: null;
  rejectedAt: Timestamp;
  rejection: InvestmentIndicationRejection;
}>;

export type InvestmentIndicationLifecycle =
  | ActiveInvestmentIndicationLifecycle
  | WithdrawnInvestmentIndicationLifecycle
  | RejectedInvestmentIndicationLifecycle;

type InvestmentIndicationHistoryEntryBase = Readonly<{
  id: InvestmentIndicationHistoryEntryId;
  indicationId: InvestmentIndicationId;
  occurredAt: Timestamp;
  revision: number;
  fields: InvestmentIndicationFields;
  acknowledgment: PackageAcceptanceRecord;
}>;

/** Immutable participant-authored active-state snapshot. */
export type ActiveInvestmentIndicationHistoryEntry =
  InvestmentIndicationHistoryEntryBase &
    Readonly<{
      transition: "created" | "edited" | "reactivated";
      status: "active";
      actor: ParticipantIndicationActor;
      rejection: null;
    }>;

/** Immutable participant-authored withdrawal snapshot. */
export type WithdrawnInvestmentIndicationHistoryEntry =
  InvestmentIndicationHistoryEntryBase &
    Readonly<{
      transition: "withdrawn";
      status: "withdrawn";
      actor: ParticipantIndicationActor;
      rejection: null;
    }>;

/** Immutable owner-authored rejection snapshot. */
export type RejectedInvestmentIndicationHistoryEntry =
  InvestmentIndicationHistoryEntryBase &
    Readonly<{
      transition: "rejected";
      status: "rejected";
      actor: OwnerIndicationActor;
      rejection: InvestmentIndicationRejection;
    }>;

export type InvestmentIndicationHistoryEntry =
  | ActiveInvestmentIndicationHistoryEntry
  | WithdrawnInvestmentIndicationHistoryEntry
  | RejectedInvestmentIndicationHistoryEntry;

type InvestmentIndicationRecord<
  Fields extends InvestmentIndicationFields,
  Lifecycle extends InvestmentIndicationLifecycle,
> = Readonly<{
  id: InvestmentIndicationId;
  participantSubject: ParticipantIndicationActor["subject"];
  kind: Fields["kind"];
  fields: Fields;
  acknowledgment: PackageAcceptanceRecord;
  lifecycle: Lifecycle;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  revision: number;
  history: readonly InvestmentIndicationHistoryEntry[];
}>;

export type ActivePersonalInvestmentIndication = InvestmentIndicationRecord<
  PersonalInvestmentIndicationFields,
  ActiveInvestmentIndicationLifecycle
>;
export type WithdrawnPersonalInvestmentIndication = InvestmentIndicationRecord<
  PersonalInvestmentIndicationFields,
  WithdrawnInvestmentIndicationLifecycle
>;
export type RejectedPersonalInvestmentIndication = InvestmentIndicationRecord<
  PersonalInvestmentIndicationFields,
  RejectedInvestmentIndicationLifecycle
>;
export type PersonalInvestmentIndication =
  | ActivePersonalInvestmentIndication
  | WithdrawnPersonalInvestmentIndication
  | RejectedPersonalInvestmentIndication;

export type ActiveCompanyInvestmentIndication = InvestmentIndicationRecord<
  CompanyInvestmentIndicationFields,
  ActiveInvestmentIndicationLifecycle
>;
export type WithdrawnCompanyInvestmentIndication = InvestmentIndicationRecord<
  CompanyInvestmentIndicationFields,
  WithdrawnInvestmentIndicationLifecycle
>;
export type RejectedCompanyInvestmentIndication = InvestmentIndicationRecord<
  CompanyInvestmentIndicationFields,
  RejectedInvestmentIndicationLifecycle
>;
export type CompanyInvestmentIndication =
  | ActiveCompanyInvestmentIndication
  | WithdrawnCompanyInvestmentIndication
  | RejectedCompanyInvestmentIndication;

export type ActiveInvestmentIndication =
  | ActivePersonalInvestmentIndication
  | ActiveCompanyInvestmentIndication;
export type WithdrawnInvestmentIndication =
  | WithdrawnPersonalInvestmentIndication
  | WithdrawnCompanyInvestmentIndication;
export type RejectedInvestmentIndication =
  | RejectedPersonalInvestmentIndication
  | RejectedCompanyInvestmentIndication;
export type InvestmentIndication =
  | PersonalInvestmentIndication
  | CompanyInvestmentIndication;

/**
 * This context must be assembled from the trusted current package and the
 * participant's stored acceptance. Request bodies must never supply its hashes.
 */
export type TrustedPackageAcknowledgmentContext = Readonly<{
  currentVersion: PackageVersion;
  latestAcceptance: PackageAcceptanceRecord | null;
}>;

export type ParticipantVisibleIndicationTransition =
  | Readonly<{
      type: "edit";
      acknowledgment: "current-required";
    }>
  | Readonly<{
      type: "withdraw";
      acknowledgment: "not-required";
    }>
  | Readonly<{
      type: "reactivate";
      acknowledgment: "current-required";
    }>;

/** Owner identity is deliberately absent from this participant projection. */
export type ParticipantVisibleIndicationLifecycle = Readonly<{
  status: InvestmentIndicationStatus;
  rejectionReason: string | null;
  transitions: readonly ParticipantVisibleIndicationTransition[];
}>;

/** Current participant-owned fields needed by the collection representation. */
export type ParticipantInvestmentIndicationSummary = Readonly<{
  id: InvestmentIndicationId;
  participantSubject: ParticipantIndicationActor["subject"];
  kind: InvestmentIndication["kind"];
  fields: InvestmentIndicationFields;
  lifecycle: Readonly<{
    status: InvestmentIndicationStatus;
    rejectionReason: string | null;
  }>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  revision: number;
}>;

export type CompanyIdentifierNormalizer = (
  value: string,
  country: CountryCode,
) => string;

export type CompanyIdentifierOptions = Readonly<{
  normalize?: CompanyIdentifierNormalizer;
}>;

export type InvestmentIndicationParsingOptions = Readonly<{
  country?: CountryCodeOptions;
  companyIdentifier?: CompanyIdentifierOptions;
}>;

export const INVESTMENT_INDICATION_LIMITS = Object.freeze({
  identifierInputLength: 256,
  identifierLength: 128,
  nameLength: 200,
  availabilityLength: 500,
  noteLength: 4_000,
  rejectionReasonLength: 500,
});
export const MAX_INVESTMENT_INDICATION_REVISIONS = 16;

const MAX_IDENTIFIER_INPUT_LENGTH = INVESTMENT_INDICATION_LIMITS.identifierInputLength;
const MAX_IDENTIFIER_LENGTH = INVESTMENT_INDICATION_LIMITS.identifierLength;
const MAX_NAME_LENGTH = INVESTMENT_INDICATION_LIMITS.nameLength;
const MAX_AVAILABILITY_LENGTH = INVESTMENT_INDICATION_LIMITS.availabilityLength;
const MAX_NOTE_LENGTH = INVESTMENT_INDICATION_LIMITS.noteLength;
const MAX_REJECTION_REASON_LENGTH =
  INVESTMENT_INDICATION_LIMITS.rejectionReasonLength;

const PERSONAL_FIELD_KEYS = new Set([
  "kind",
  "residenceCountry",
  "amount",
  "availabilityPeriod",
  "note",
]);
const COMPANY_FIELD_KEYS = new Set([
  "kind",
  "companyName",
  "registrationCountry",
  "companyIdentifier",
  "representativeName",
  "representativeAuthorityDeclared",
  "amount",
  "availabilityPeriod",
  "note",
]);
const CREATE_KEYS = new Set(["id", "occurredAt", "historyEntryId", "fields"]);
const EDIT_KEYS = new Set(["occurredAt", "historyEntryId", "fields"]);
const TRANSITION_KEYS = new Set(["occurredAt", "historyEntryId"]);
const REJECTION_KEYS = new Set(["occurredAt", "historyEntryId", "reason"]);

const ACTIVE_PARTICIPANT_TRANSITIONS = Object.freeze([
  Object.freeze({ type: "edit", acknowledgment: "current-required" }),
  Object.freeze({ type: "withdraw", acknowledgment: "not-required" }),
] as const satisfies readonly ParticipantVisibleIndicationTransition[]);
const WITHDRAW_ONLY_PARTICIPANT_TRANSITIONS = Object.freeze([
  Object.freeze({ type: "withdraw", acknowledgment: "not-required" }),
] as const satisfies readonly ParticipantVisibleIndicationTransition[]);
const WITHDRAWN_PARTICIPANT_TRANSITIONS = Object.freeze([
  Object.freeze({ type: "reactivate", acknowledgment: "current-required" }),
] as const satisfies readonly ParticipantVisibleIndicationTransition[]);
const NO_PARTICIPANT_TRANSITIONS = Object.freeze(
  [] as readonly ParticipantVisibleIndicationTransition[],
);

/**
 * Generic canonicalization preserves punctuation but removes formatting
 * whitespace, applies Unicode compatibility normalization, and folds case.
 * Deployments may inject a country-aware normalizer when local rules require it.
 */
export const normalizeCompanyIdentifier: CompanyIdentifierNormalizer = (value) =>
  value.normalize("NFKC").trim().toUpperCase().replace(/\s+/gu, "");

/** Parse and canonicalize a local company identifier before any uniqueness check. */
export function parseNormalizedCompanyIdentifier(
  value: unknown,
  country: CountryCode,
  options: CompanyIdentifierOptions = {},
): ValidationResult<NormalizedCompanyIdentifier> {
  if (typeof value !== "string") {
    return invalid({ code: "invalid_type", path: "companyIdentifier" });
  }
  if (value.length === 0) {
    return invalid({ code: "required", path: "companyIdentifier" });
  }
  if (value.length > MAX_IDENTIFIER_INPUT_LENGTH) {
    return invalid({ code: "out_of_range", path: "companyIdentifier" });
  }

  let normalized: string;
  try {
    normalized = (options.normalize ?? normalizeCompanyIdentifier)(value, country);
  } catch {
    return invalid({ code: "invalid_format", path: "companyIdentifier" });
  }

  if (typeof normalized !== "string") {
    return invalid({ code: "invalid_format", path: "companyIdentifier" });
  }
  if (normalized.length === 0) {
    return invalid({ code: "required", path: "companyIdentifier" });
  }
  if (
    normalized.length > MAX_IDENTIFIER_LENGTH ||
    hasUnsafeIdentifierCharacter(normalized)
  ) {
    return invalid({
      code:
        normalized.length > MAX_IDENTIFIER_LENGTH
          ? "out_of_range"
          : "invalid_format",
      path: "companyIdentifier",
    });
  }

  return valid(normalized as NormalizedCompanyIdentifier);
}

/** Parse complete personal or company fields using trusted amount settings. */
export function parseInvestmentIndicationFields(
  value: unknown,
  amountConfiguration: AmountConfiguration,
  options: InvestmentIndicationParsingOptions = {},
): ValidationResult<InvestmentIndicationFields> {
  const source = asRecord(value);
  if (!source) return invalid({ code: "invalid_type", path: "fields" });

  if (source.kind === "personal") {
    const keys = validateKeys(source, PERSONAL_FIELD_KEYS, "fields");
    if (!keys.ok) return keys;

    const residenceCountry = parseNamedCountry(
      source.residenceCountry,
      "fields.residenceCountry",
      options.country,
    );
    if (!residenceCountry.ok) return residenceCountry;
    const common = parseCommonFields(source, amountConfiguration);
    if (!common.ok) return common;

    return valid(
      Object.freeze({
        kind: "personal",
        residenceCountry: residenceCountry.value,
        ...common.value,
      }),
    );
  }

  if (source.kind === "company") {
    const keys = validateKeys(source, COMPANY_FIELD_KEYS, "fields");
    if (!keys.ok) return keys;

    const companyName = parseRequiredText(
      source.companyName,
      "fields.companyName",
      MAX_NAME_LENGTH,
      false,
    );
    if (!companyName.ok) return companyName;
    const registrationCountry = parseNamedCountry(
      source.registrationCountry,
      "fields.registrationCountry",
      options.country,
    );
    if (!registrationCountry.ok) return registrationCountry;
    const companyIdentifier = parseNormalizedCompanyIdentifier(
      source.companyIdentifier,
      registrationCountry.value,
      options.companyIdentifier,
    );
    if (!companyIdentifier.ok) {
      return remapResult(companyIdentifier, "fields.companyIdentifier");
    }
    const representativeName = parseRequiredText(
      source.representativeName,
      "fields.representativeName",
      MAX_NAME_LENGTH,
      false,
    );
    if (!representativeName.ok) return representativeName;
    if (source.representativeAuthorityDeclared !== true) {
      return invalid({
        code:
          source.representativeAuthorityDeclared === undefined
            ? "required"
            : "invalid_rule",
        path: "fields.representativeAuthorityDeclared",
      });
    }
    const common = parseCommonFields(source, amountConfiguration);
    if (!common.ok) return common;

    return valid(
      Object.freeze({
        kind: "company",
        companyName: companyName.value,
        registrationCountry: registrationCountry.value,
        companyIdentifier: companyIdentifier.value,
        representativeName: representativeName.value,
        representativeAuthorityDeclared: true,
        ...common.value,
      }),
    );
  }

  return invalid({
    code: source.kind === undefined ? "required" : "invalid_format",
    path: "fields.kind",
  });
}

/**
 * Create an active indication. `actor` and `acknowledgmentContext` are trusted
 * application-service inputs and are intentionally absent from the request value.
 */
export function createInvestmentIndication(
  value: unknown,
  actor: ParticipantIndicationActor,
  amountConfiguration: AmountConfiguration,
  acknowledgmentContext: TrustedPackageAcknowledgmentContext,
  options: InvestmentIndicationParsingOptions = {},
): ValidationResult<ActiveInvestmentIndication> {
  assertParticipantActor(actor);
  const source = parseOperation(value, CREATE_KEYS);
  if (!source.ok) return source;

  const id = parseNamedStableId<"investment-indication">(source.value.id, "id");
  if (!id.ok) return id;
  const occurredAt = parseNamedTimestamp(source.value.occurredAt, "occurredAt");
  if (!occurredAt.ok) return occurredAt;
  const historyEntryId = parseHistoryEntryId(source.value.historyEntryId);
  if (!historyEntryId.ok) return historyEntryId;
  const fields = parseInvestmentIndicationFields(
    source.value.fields,
    amountConfiguration,
    options,
  );
  if (!fields.ok) return fields;

  const acknowledgment = requireCurrentPackageAcknowledgment(
    actor,
    acknowledgmentContext,
    occurredAt.value,
  );
  const frozenActor = freezeActor(actor);
  const historyEntry: ActiveInvestmentIndicationHistoryEntry = Object.freeze({
    id: historyEntryId.value,
    indicationId: id.value,
    occurredAt: occurredAt.value,
    revision: 1,
    fields: fields.value,
    acknowledgment,
    transition: "created",
    status: "active",
    actor: frozenActor,
    rejection: null,
  });
  const lifecycle: ActiveInvestmentIndicationLifecycle = Object.freeze({
    status: "active",
    activatedAt: occurredAt.value,
    withdrawnAt: null,
    rejectedAt: null,
    rejection: null,
  });

  return valid(
    buildRecord<
      InvestmentIndicationFields,
      ActiveInvestmentIndicationLifecycle
    >({
      id: id.value,
      participantSubject: actor.subject,
      fields: fields.value,
      acknowledgment,
      lifecycle,
      createdAt: occurredAt.value,
      updatedAt: occurredAt.value,
      revision: 1,
      history: Object.freeze([historyEntry]),
    }),
  );
}

/** Replace all editable fields on an active indication owned by the participant. */
export function editInvestmentIndication(
  indication: InvestmentIndication,
  value: unknown,
  actor: ParticipantIndicationActor,
  amountConfiguration: AmountConfiguration,
  acknowledgmentContext: TrustedPackageAcknowledgmentContext,
  options: InvestmentIndicationParsingOptions = {},
): ValidationResult<ActiveInvestmentIndication> {
  assertParticipantOwns(indication, actor);
  assertStatus(indication, "active");
  if (indication.revision >= MAX_INVESTMENT_INDICATION_REVISIONS - 1) {
    return invalid({ code: "out_of_range", path: "revision" });
  }
  const source = parseOperation(value, EDIT_KEYS);
  if (!source.ok) return source;

  const metadata = parseTransitionMetadata(indication, source.value);
  if (!metadata.ok) return metadata;
  const fields = parseInvestmentIndicationFields(
    source.value.fields,
    amountConfiguration,
    options,
  );
  if (!fields.ok) return fields;
  if (fields.value.kind !== indication.kind) {
    return invalid({ code: "invalid_rule", path: "fields.kind" });
  }

  const acknowledgment = requireCurrentPackageAcknowledgment(
    actor,
    acknowledgmentContext,
    metadata.value.occurredAt,
  );
  const revision = indication.revision + 1;
  const historyEntry: ActiveInvestmentIndicationHistoryEntry = Object.freeze({
    id: metadata.value.historyEntryId,
    indicationId: indication.id,
    occurredAt: metadata.value.occurredAt,
    revision,
    fields: fields.value,
    acknowledgment,
    transition: "edited",
    status: "active",
    actor: freezeActor(actor),
    rejection: null,
  });

  return valid(
    buildRecord<
      InvestmentIndicationFields,
      ActiveInvestmentIndicationLifecycle
    >({
      ...indication,
      fields: fields.value,
      acknowledgment,
      updatedAt: metadata.value.occurredAt,
      revision,
      history: appendHistory(indication, historyEntry),
    }),
  );
}

/** Withdraw an active indication without requiring package re-acceptance. */
export function withdrawInvestmentIndication(
  indication: InvestmentIndication,
  value: unknown,
  actor: ParticipantIndicationActor,
): ValidationResult<WithdrawnInvestmentIndication> {
  assertParticipantOwns(indication, actor);
  assertStatus(indication, "active");
  if (indication.revision >= MAX_INVESTMENT_INDICATION_REVISIONS) {
    return invalid({ code: "out_of_range", path: "revision" });
  }
  const source = parseOperation(value, TRANSITION_KEYS);
  if (!source.ok) return source;
  const metadata = parseTransitionMetadata(indication, source.value);
  if (!metadata.ok) return metadata;

  const revision = indication.revision + 1;
  const historyEntry: WithdrawnInvestmentIndicationHistoryEntry = Object.freeze({
    id: metadata.value.historyEntryId,
    indicationId: indication.id,
    occurredAt: metadata.value.occurredAt,
    revision,
    fields: indication.fields,
    acknowledgment: indication.acknowledgment,
    transition: "withdrawn",
    status: "withdrawn",
    actor: freezeActor(actor),
    rejection: null,
  });
  const lifecycle: WithdrawnInvestmentIndicationLifecycle = Object.freeze({
    status: "withdrawn",
    activatedAt: indication.lifecycle.activatedAt,
    withdrawnAt: metadata.value.occurredAt,
    rejectedAt: null,
    rejection: null,
  });

  return valid(
    buildRecord<
      InvestmentIndicationFields,
      WithdrawnInvestmentIndicationLifecycle
    >({
      ...indication,
      lifecycle,
      updatedAt: metadata.value.occurredAt,
      revision,
      history: appendHistory(indication, historyEntry),
    }),
  );
}

/** Reactivate a withdrawn indication only after accepting the current package. */
export function reactivateInvestmentIndication(
  indication: InvestmentIndication,
  value: unknown,
  actor: ParticipantIndicationActor,
  acknowledgmentContext: TrustedPackageAcknowledgmentContext,
): ValidationResult<ActiveInvestmentIndication> {
  assertParticipantOwns(indication, actor);
  assertStatus(indication, "withdrawn");
  if (indication.revision >= MAX_INVESTMENT_INDICATION_REVISIONS - 1) {
    return invalid({ code: "out_of_range", path: "revision" });
  }
  const source = parseOperation(value, TRANSITION_KEYS);
  if (!source.ok) return source;
  const metadata = parseTransitionMetadata(indication, source.value);
  if (!metadata.ok) return metadata;
  const acknowledgment = requireCurrentPackageAcknowledgment(
    actor,
    acknowledgmentContext,
    metadata.value.occurredAt,
  );

  const revision = indication.revision + 1;
  const historyEntry: ActiveInvestmentIndicationHistoryEntry = Object.freeze({
    id: metadata.value.historyEntryId,
    indicationId: indication.id,
    occurredAt: metadata.value.occurredAt,
    revision,
    fields: indication.fields,
    acknowledgment,
    transition: "reactivated",
    status: "active",
    actor: freezeActor(actor),
    rejection: null,
  });
  const lifecycle: ActiveInvestmentIndicationLifecycle = Object.freeze({
    status: "active",
    activatedAt: metadata.value.occurredAt,
    withdrawnAt: null,
    rejectedAt: null,
    rejection: null,
  });

  return valid(
    buildRecord<
      InvestmentIndicationFields,
      ActiveInvestmentIndicationLifecycle
    >({
      ...indication,
      acknowledgment,
      lifecycle,
      updatedAt: metadata.value.occurredAt,
      revision,
      history: appendHistory(indication, historyEntry),
    }),
  );
}

/** Reject an active indication with a participant-visible, bounded reason. */
export function rejectInvestmentIndication(
  indication: InvestmentIndication,
  value: unknown,
  actor: OwnerIndicationActor,
): ValidationResult<RejectedInvestmentIndication> {
  assertOwnerActor(actor);
  assertStatus(indication, "active");
  if (indication.revision >= MAX_INVESTMENT_INDICATION_REVISIONS) {
    return invalid({ code: "out_of_range", path: "revision" });
  }
  const source = parseOperation(value, REJECTION_KEYS);
  if (!source.ok) return source;
  const metadata = parseTransitionMetadata(indication, source.value);
  if (!metadata.ok) return metadata;
  const reason = parseRequiredText(
    source.value.reason,
    "reason",
    MAX_REJECTION_REASON_LENGTH,
    true,
  );
  if (!reason.ok) return reason;

  const frozenActor = freezeActor(actor);
  const rejection: InvestmentIndicationRejection = Object.freeze({
    reason: reason.value,
    rejectedAt: metadata.value.occurredAt,
    rejectedBy: frozenActor,
  });
  const revision = indication.revision + 1;
  const historyEntry: RejectedInvestmentIndicationHistoryEntry = Object.freeze({
    id: metadata.value.historyEntryId,
    indicationId: indication.id,
    occurredAt: metadata.value.occurredAt,
    revision,
    fields: indication.fields,
    acknowledgment: indication.acknowledgment,
    transition: "rejected",
    status: "rejected",
    actor: frozenActor,
    rejection,
  });
  const lifecycle: RejectedInvestmentIndicationLifecycle = Object.freeze({
    status: "rejected",
    activatedAt: indication.lifecycle.activatedAt,
    withdrawnAt: null,
    rejectedAt: metadata.value.occurredAt,
    rejection,
  });

  return valid(
    buildRecord<
      InvestmentIndicationFields,
      RejectedInvestmentIndicationLifecycle
    >({
      ...indication,
      lifecycle,
      updatedAt: metadata.value.occurredAt,
      revision,
      history: appendHistory(indication, historyEntry),
    }),
  );
}

/** Return only actions valid for the participant in the current lifecycle state. */
export function participantVisibleIndicationLifecycle(
  indication: InvestmentIndication,
): ParticipantVisibleIndicationLifecycle {
  if (indication.lifecycle.status === "active") {
    return Object.freeze({
      status: "active",
      rejectionReason: null,
      transitions:
        indication.revision >= MAX_INVESTMENT_INDICATION_REVISIONS
          ? NO_PARTICIPANT_TRANSITIONS
          : indication.revision === MAX_INVESTMENT_INDICATION_REVISIONS - 1
          ? WITHDRAW_ONLY_PARTICIPANT_TRANSITIONS
          : ACTIVE_PARTICIPANT_TRANSITIONS,
    });
  }
  if (indication.lifecycle.status === "withdrawn") {
    return Object.freeze({
      status: "withdrawn",
      rejectionReason: null,
      transitions:
        indication.revision < MAX_INVESTMENT_INDICATION_REVISIONS - 1
        ? WITHDRAWN_PARTICIPANT_TRANSITIONS
        : NO_PARTICIPANT_TRANSITIONS,
    });
  }
  return Object.freeze({
    status: "rejected",
    rejectionReason: indication.lifecycle.rejection.reason,
    transitions: NO_PARTICIPANT_TRANSITIONS,
  });
}

/** Project one indication without its acknowledgment or immutable history. */
export function participantInvestmentIndicationSummary(
  indication: InvestmentIndication,
): ParticipantInvestmentIndicationSummary {
  const lifecycle = participantVisibleIndicationLifecycle(indication);
  return Object.freeze({
    id: indication.id,
    participantSubject: indication.participantSubject,
    kind: indication.kind,
    fields: indication.fields,
    lifecycle: Object.freeze({
      status: lifecycle.status,
      rejectionReason: lifecycle.rejectionReason,
    }),
    createdAt: indication.createdAt,
    updatedAt: indication.updatedAt,
    revision: indication.revision,
  });
}

/** Derive the uniqueness coordinate authenticated by an indication's fields. */
export function investmentIndicationUniquenessKey(
  indication: InvestmentIndication,
): ActiveIndicationUniquenessKey {
  return (indication.kind === "personal"
    ? JSON.stringify(["personal", indication.participantSubject])
    : JSON.stringify([
        "company",
        indication.fields.registrationCountry,
        indication.fields.companyIdentifier,
      ])) as ActiveIndicationUniquenessKey;
}

/** Derive the internal uniqueness key only while an indication is active. */
export function activeIndicationUniquenessKey(
  indication: InvestmentIndication,
): ActiveIndicationUniquenessKey | null {
  if (indication.lifecycle.status !== "active") return null;
  return investmentIndicationUniquenessKey(indication);
}

/**
 * Enforce one active personal indication per subject and one active company
 * indication per normalized country/identifier pair. The fixed conflict error
 * never discloses which record or participant occupies the key.
 */
export function assertNoActiveIndicationConflict(
  candidate: ActiveInvestmentIndication,
  existing: readonly InvestmentIndication[],
): void {
  const candidateKey = activeIndicationUniquenessKey(candidate);
  for (const indication of existing) {
    if (
      indication.id !== candidate.id &&
      activeIndicationUniquenessKey(indication) === candidateKey
    ) {
      throw new DomainError("RESOURCE_CONFLICT");
    }
  }
}

/**
 * Require acceptance of the trusted current material requirement. All failure
 * modes share one fixed precondition error and expose no hashes or subjects.
 */
export function requireCurrentPackageAcknowledgment(
  actor: ParticipantIndicationActor,
  context: TrustedPackageAcknowledgmentContext,
  occurredAt: Timestamp,
): PackageAcceptanceRecord {
  const acceptance = context.latestAcceptance;
  if (
    acceptance === null ||
    acceptance.participantSubject !== actor.subject ||
    acceptance.acceptedAt > occurredAt ||
    requiresRenewedAcceptance(context.currentVersion, acceptance)
  ) {
    throw new DomainError("PRECONDITION_FAILED");
  }

  return Object.freeze({ ...acceptance });
}

type UnknownRecord = Readonly<Record<string, unknown>>;

type CommonFields = Readonly<{
  amount: MinorUnits;
  currency: CurrencyCode;
  availabilityPeriod: string;
  note: string | null;
}>;

type TransitionMetadata = Readonly<{
  occurredAt: Timestamp;
  historyEntryId: InvestmentIndicationHistoryEntryId;
}>;

type RecordInput<
  Fields extends InvestmentIndicationFields,
  Lifecycle extends InvestmentIndicationLifecycle,
> = Readonly<{
  id: InvestmentIndicationId;
  participantSubject: ParticipantIndicationActor["subject"];
  fields: Fields;
  acknowledgment: PackageAcceptanceRecord;
  lifecycle: Lifecycle;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  revision: number;
  history: readonly InvestmentIndicationHistoryEntry[];
}>;

type BuiltInvestmentIndicationRecord<
  Fields extends InvestmentIndicationFields,
  Lifecycle extends InvestmentIndicationLifecycle,
> = Fields extends PersonalInvestmentIndicationFields
  ? InvestmentIndicationRecord<PersonalInvestmentIndicationFields, Lifecycle>
  : Fields extends CompanyInvestmentIndicationFields
    ? InvestmentIndicationRecord<CompanyInvestmentIndicationFields, Lifecycle>
    : never;

function parseCommonFields(
  source: UnknownRecord,
  amountConfiguration: AmountConfiguration,
): ValidationResult<CommonFields> {
  const amount = parseConfiguredAmount(source.amount, amountConfiguration);
  if (!amount.ok) return remapResult(amount, "fields.amount");
  const availabilityPeriod = parseRequiredText(
    source.availabilityPeriod,
    "fields.availabilityPeriod",
    MAX_AVAILABILITY_LENGTH,
    true,
  );
  if (!availabilityPeriod.ok) return availabilityPeriod;
  const note = parseOptionalText(source.note, "fields.note", MAX_NOTE_LENGTH);
  if (!note.ok) return note;

  return valid(
    Object.freeze({
      amount: amount.value,
      currency: amountConfiguration.currency,
      availabilityPeriod: availabilityPeriod.value,
      note: note.value,
    }),
  );
}

function parseOperation(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): ValidationResult<UnknownRecord> {
  const source = asRecord(value);
  if (!source) return invalid({ code: "invalid_type", path: "input" });
  const keys = validateKeys(source, allowedKeys, "input");
  return keys.ok ? valid(source) : keys;
}

function parseTransitionMetadata(
  indication: InvestmentIndication,
  source: UnknownRecord,
): ValidationResult<TransitionMetadata> {
  const occurredAt = parseNamedTimestamp(source.occurredAt, "occurredAt");
  if (!occurredAt.ok) return occurredAt;
  const historyEntryId = parseHistoryEntryId(source.historyEntryId);
  if (!historyEntryId.ok) return historyEntryId;

  if (
    occurredAt.value < indication.updatedAt ||
    indication.history.some((entry) => entry.id === historyEntryId.value)
  ) {
    throw new DomainError("RESOURCE_CONFLICT");
  }

  return valid({
    occurredAt: occurredAt.value,
    historyEntryId: historyEntryId.value,
  });
}

function parseHistoryEntryId(
  value: unknown,
): ValidationResult<InvestmentIndicationHistoryEntryId> {
  return parseNamedStableId<"investment-indication-history-entry">(
    value,
    "historyEntryId",
  );
}

function parseNamedStableId<Entity extends string>(
  value: unknown,
  path: string,
): ValidationResult<StableId<Entity>> {
  const result = parseStableId<Entity>(value);
  return result.ok ? result : remapResult(result, path);
}

function parseNamedTimestamp(
  value: unknown,
  path: string,
): ValidationResult<Timestamp> {
  const result = parseTimestamp(value);
  return result.ok ? result : remapResult(result, path);
}

function parseNamedCountry(
  value: unknown,
  path: string,
  options: CountryCodeOptions = {},
): ValidationResult<CountryCode> {
  const result = parseCountryCode(value, options);
  return result.ok ? result : remapResult(result, path);
}

function parseRequiredText(
  value: unknown,
  path: string,
  maximumLength: number,
  multiline: boolean,
): ValidationResult<string> {
  if (typeof value !== "string") return invalid({ code: "invalid_type", path });
  const normalized = (multiline ? value.replace(/\r\n?/gu, "\n") : value).trim();
  if (normalized.length === 0) return invalid({ code: "required", path });
  if (normalized.length > maximumLength) {
    return invalid({ code: "out_of_range", path });
  }
  if (hasUnsafeTextCharacter(normalized, multiline)) {
    return invalid({ code: "invalid_format", path });
  }
  return valid(normalized);
}

function parseOptionalText(
  value: unknown,
  path: string,
  maximumLength: number,
): ValidationResult<string | null> {
  if (value === undefined || value === null || value === "") return valid(null);
  return parseRequiredText(value, path, maximumLength, true);
}

function validateKeys(
  source: UnknownRecord,
  allowedKeys: ReadonlySet<string>,
  path: string,
): ValidationResult<true> {
  for (const key of Object.keys(source)) {
    if (!allowedKeys.has(key)) {
      return invalid({ code: "invalid_rule", path: `${path}.${key}` });
    }
  }
  return valid(true);
}

function remapResult<Value>(
  result: Readonly<{ ok: false; issues: readonly ValidationIssue[] }>,
  path: string,
): ValidationResult<Value> {
  return {
    ok: false,
    issues: result.issues.map((issue) => ({ ...issue, path })),
  };
}

function hasUnsafeTextCharacter(value: string, multiline: boolean): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) return true;
    if (codePoint === 127 || codePoint < 32) {
      if (multiline && (character === "\n" || character === "\t")) continue;
      return true;
    }
    if (isDirectionalControl(codePoint)) return true;
  }
  return false;
}

function hasUnsafeIdentifierCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint === 127 ||
      codePoint < 33 ||
      /\s/u.test(character) ||
      isDirectionalControl(codePoint)
    ) {
      return true;
    }
  }
  return false;
}

function isDirectionalControl(codePoint: number): boolean {
  return (
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0xfeff
  );
}

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function freezeActor<ActorType extends ParticipantIndicationActor | OwnerIndicationActor>(
  actor: ActorType,
): ActorType {
  return Object.freeze({ ...actor });
}

function assertParticipantActor(actor: ParticipantIndicationActor): void {
  if (actor.type !== "participant") throw new DomainError("ACCESS_DENIED");
}

function assertOwnerActor(actor: OwnerIndicationActor): void {
  if (actor.type !== "owner") throw new DomainError("ACCESS_DENIED");
}

function assertParticipantOwns(
  indication: InvestmentIndication,
  actor: ParticipantIndicationActor,
): void {
  if (
    actor.type !== "participant" ||
    actor.subject !== indication.participantSubject
  ) {
    throw new DomainError("ACCESS_DENIED");
  }
}

function assertStatus(
  indication: InvestmentIndication,
  expected: "active",
): asserts indication is ActiveInvestmentIndication;
function assertStatus(
  indication: InvestmentIndication,
  expected: "withdrawn",
): asserts indication is WithdrawnInvestmentIndication;
function assertStatus(
  indication: InvestmentIndication,
  expected: "rejected",
): asserts indication is RejectedInvestmentIndication;
function assertStatus(
  indication: InvestmentIndication,
  expected: InvestmentIndicationStatus,
): void {
  if (indication.lifecycle.status !== expected) {
    throw new DomainError("RESOURCE_CONFLICT");
  }
}

function appendHistory(
  indication: InvestmentIndication,
  entry: InvestmentIndicationHistoryEntry,
): readonly InvestmentIndicationHistoryEntry[] {
  return Object.freeze([...indication.history, entry]);
}

function buildRecord<
  Fields extends InvestmentIndicationFields,
  Lifecycle extends InvestmentIndicationLifecycle,
>(
  input: RecordInput<Fields, Lifecycle>,
): BuiltInvestmentIndicationRecord<Fields, Lifecycle> {
  return Object.freeze({
    id: input.id,
    participantSubject: input.participantSubject,
    kind: input.fields.kind,
    fields: input.fields,
    acknowledgment: input.acknowledgment,
    lifecycle: input.lifecycle,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    revision: input.revision,
    history: input.history,
  }) as unknown as BuiltInvestmentIndicationRecord<Fields, Lifecycle>;
}
