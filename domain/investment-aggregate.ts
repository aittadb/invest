/**
 * Framework-independent investment aggregate and reconciliation contracts.
 *
 * Aggregate inputs are private, minimal projections of indication records.
 * Public output is rebuilt from an explicit allowlist and cannot carry record
 * identity, participant data, notes, lifecycle state, counts, or moderation.
 *
 * @packageDocumentation
 */

import {
  DomainError,
  invalid,
  parseMinorUnits,
  parseStableId,
  valid,
  type MinorUnits,
  type ValidationResult,
} from "./foundation.ts";
import {
  createSanitizedPublicAggregateDisplay,
  parseAmountAggregateConfiguration,
  type AmountAggregateConfiguration,
  type CurrencyCode,
  type SanitizedPublicAggregateDisplay,
} from "./amount-aggregate-configuration.ts";
import type {
  InvestmentIndicationId,
  InvestmentIndicationStatus,
} from "./investment-indication.ts";

/** Narrow indication view accepted by the aggregate projection boundary. */
export type AggregatableInvestmentIndication = Readonly<{
  id: InvestmentIndicationId;
  revision: number;
  lifecycle: Readonly<{ status: InvestmentIndicationStatus }>;
  fields: Readonly<{ amount: MinorUnits; currency: CurrencyCode }>;
}>;

/** Private aggregate-relevant facts projected from one indication revision. */
export type InvestmentAggregateContribution = Readonly<{
  indicationId: InvestmentIndicationId;
  indicationRevision: number;
  status: InvestmentIndicationStatus;
  amount: MinorUnits;
  currency: CurrencyCode;
}>;

/** Private calculated state. Counts must not be copied into public output. */
export type InvestmentAggregateSummary = Readonly<{
  totalAmount: MinorUnits;
  currency: CurrencyCode;
  contributingIndicationCount: number;
}>;

/** Persisted aggregate state used as the compare-and-set reconciliation base. */
export type StoredInvestmentAggregateSnapshot = Readonly<{
  revision: number;
  totalAmount: MinorUnits;
  currency: CurrencyCode;
  contributingIndicationCount: number;
}>;

export type InvestmentAggregateReconciliationPreview = Readonly<{
  status: "match" | "mismatch";
  stored: StoredInvestmentAggregateSnapshot;
  calculated: InvestmentAggregateSummary;
  correctionRequired: boolean;
}>;

export const APPLY_CALCULATED_AGGREGATE_CONFIRMATION =
  "apply-calculated-aggregate" as const;

/** Explicit owner/application confirmation bound to one reconciliation preview. */
export type InvestmentAggregateCorrectionConfirmation = Readonly<{
  confirmation: typeof APPLY_CALCULATED_AGGREGATE_CONFIRMATION;
  expectedStoredRevision: number;
  expectedStoredAmount: MinorUnits;
  expectedStoredContributingIndicationCount: number;
  expectedCalculatedAmount: MinorUnits;
  expectedCalculatedContributingIndicationCount: number;
}>;

/** Retry-stable correction intent; persistence still performs compare-and-set. */
export type ConfirmedInvestmentAggregateCorrection = Readonly<{
  confirmed: true;
  expectedStoredRevision: number;
  replacement: StoredInvestmentAggregateSnapshot;
}>;

/** Public target progress represented only by non-negative minor-unit amounts. */
export type PublicOversubscriptionDisplayData = Readonly<{
  status: "below_target" | "target_reached" | "oversubscribed";
  targetAmount: MinorUnits;
  remainingAmount: MinorUnits;
  amountOverTarget: MinorUnits;
}>;

/**
 * Complete public aggregate shape. No private summary or per-record fields are
 * structurally available in this projection.
 */
export type SanitizedPublicInvestmentAggregate =
  SanitizedPublicAggregateDisplay &
    Readonly<{
      oversubscription: PublicOversubscriptionDisplayData | null;
    }>;

const CORRECTION_CONFIRMATION_KEYS = new Set([
  "confirmation",
  "expectedStoredRevision",
  "expectedStoredAmount",
  "expectedStoredContributingIndicationCount",
  "expectedCalculatedAmount",
  "expectedCalculatedContributingIndicationCount",
]);
const PUBLIC_AGGREGATE_KEYS = new Set([
  "amount",
  "currency",
  "label",
  "qualifier",
  "oversubscription",
]);
const PUBLIC_OVERSUBSCRIPTION_KEYS = new Set([
  "status",
  "targetAmount",
  "remainingAmount",
  "amountOverTarget",
]);

/** Strip an indication down to the facts the aggregate calculation consumes. */
export function projectInvestmentIndicationForAggregation(
  indication: AggregatableInvestmentIndication,
): InvestmentAggregateContribution {
  return Object.freeze({
    indicationId: indication.id,
    indicationRevision: indication.revision,
    status: indication.lifecycle.status,
    amount: indication.fields.amount,
    currency: indication.fields.currency,
  });
}

/**
 * Calculate the active-only total from current or repeated indication facts.
 *
 * For each indication ID, only the highest revision contributes. Repeating the
 * same revision with the same aggregate facts is an idempotent retry. Conflicting
 * facts at the same revision fail instead of selecting an input-order winner.
 */
export function calculateInvestmentAggregateSummary(
  contributions: readonly InvestmentAggregateContribution[],
  currency: CurrencyCode,
): InvestmentAggregateSummary {
  assertCurrency(currency);
  const latestByIndication = new Map<string, InvestmentAggregateContribution>();

  for (const candidate of contributions) {
    const normalized = normalizeContribution(candidate, currency);
    const key = normalized.indicationId as string;
    const current = latestByIndication.get(key);

    if (current === undefined || normalized.indicationRevision > current.indicationRevision) {
      latestByIndication.set(key, normalized);
      continue;
    }
    if (normalized.indicationRevision < current.indicationRevision) continue;
    if (!sameAggregateFact(normalized, current)) {
      throw new DomainError("RESOURCE_CONFLICT");
    }
  }

  let total = 0;
  let contributingIndicationCount = 0;
  for (const contribution of latestByIndication.values()) {
    if (contribution.status !== "active") continue;
    if (total > Number.MAX_SAFE_INTEGER - contribution.amount) {
      throw new DomainError("INVALID_INPUT");
    }
    total += contribution.amount;
    contributingIndicationCount += 1;
  }

  return Object.freeze({
    totalAmount: total as MinorUnits,
    currency,
    contributingIndicationCount,
  });
}

/** Compare persisted state with a freshly calculated active-only summary. */
export function previewInvestmentAggregateReconciliation(
  stored: StoredInvestmentAggregateSnapshot,
  calculated: InvestmentAggregateSummary,
): InvestmentAggregateReconciliationPreview {
  const frozenStored = normalizeStoredSnapshot(stored);
  const frozenCalculated = normalizeSummary(calculated, frozenStored.currency);
  const matches =
    frozenStored.totalAmount === frozenCalculated.totalAmount &&
    frozenStored.contributingIndicationCount ===
      frozenCalculated.contributingIndicationCount;

  return Object.freeze({
    status: matches ? "match" : "mismatch",
    stored: frozenStored,
    calculated: frozenCalculated,
    correctionRequired: !matches,
  });
}

/**
 * Turn a mismatch preview into a correction intent only after an exact,
 * explicit confirmation. Stale or altered confirmation facts fail with one
 * fixed precondition error and expose no aggregate details.
 */
export function confirmInvestmentAggregateCorrection(
  preview: InvestmentAggregateReconciliationPreview,
  value: unknown,
): ValidationResult<ConfirmedInvestmentAggregateCorrection> {
  const parsed = parseCorrectionConfirmation(value);
  if (!parsed.ok) return parsed;

  const confirmation = parsed.value;
  if (
    preview.status !== "mismatch" ||
    !preview.correctionRequired ||
    confirmation.expectedStoredRevision !== preview.stored.revision ||
    confirmation.expectedStoredAmount !== preview.stored.totalAmount ||
    confirmation.expectedStoredContributingIndicationCount !==
      preview.stored.contributingIndicationCount ||
    confirmation.expectedCalculatedAmount !== preview.calculated.totalAmount ||
    confirmation.expectedCalculatedContributingIndicationCount !==
      preview.calculated.contributingIndicationCount
  ) {
    throw new DomainError("PRECONDITION_FAILED");
  }

  if (preview.stored.revision === Number.MAX_SAFE_INTEGER) {
    throw new DomainError("PRECONDITION_FAILED");
  }

  return valid(
    Object.freeze({
      confirmed: true,
      expectedStoredRevision: preview.stored.revision,
      replacement: Object.freeze({
        revision: preview.stored.revision + 1,
        totalAmount: preview.calculated.totalAmount,
        currency: preview.calculated.currency,
        contributingIndicationCount:
          preview.calculated.contributingIndicationCount,
      }),
    }),
  );
}

/** Derive stable target/oversubscription display fields without floating point. */
export function createPublicOversubscriptionDisplayData(
  totalAmount: unknown,
  targetAmount: unknown,
): ValidationResult<PublicOversubscriptionDisplayData> {
  const total = parseNamedMinorUnits(totalAmount, "totalAmount", 0);
  if (!total.ok) return total;
  const target = parseNamedMinorUnits(targetAmount, "targetAmount", 1);
  if (!target.ok) return target;

  const zero = 0 as MinorUnits;
  if (total.value < target.value) {
    return valid(
      Object.freeze({
        status: "below_target",
        targetAmount: target.value,
        remainingAmount: (target.value - total.value) as MinorUnits,
        amountOverTarget: zero,
      }),
    );
  }
  if (total.value === target.value) {
    return valid(
      Object.freeze({
        status: "target_reached",
        targetAmount: target.value,
        remainingAmount: zero,
        amountOverTarget: zero,
      }),
    );
  }
  return valid(
    Object.freeze({
      status: "oversubscribed",
      targetAmount: target.value,
      remainingAmount: zero,
      amountOverTarget: (total.value - target.value) as MinorUnits,
    }),
  );
}

/**
 * Build public data from an allowlist. A null target omits target progress, and
 * hidden or zero aggregate policy returns no public aggregate at all.
 */
export function createSanitizedPublicInvestmentAggregate(
  summary: InvestmentAggregateSummary,
  configuration: AmountAggregateConfiguration,
  publicTargetAmount: unknown | null,
): ValidationResult<SanitizedPublicInvestmentAggregate | null> {
  let normalized: InvestmentAggregateSummary;
  try {
    normalized = normalizeSummary(summary, configuration.amount.currency);
  } catch {
    return invalid({ code: "invalid_rule", path: "summary" });
  }

  const display = createSanitizedPublicAggregateDisplay(
    normalized.totalAmount,
    configuration,
  );
  if (!display.ok) return display;
  if (display.value === null) return valid(null);

  let oversubscription: PublicOversubscriptionDisplayData | null = null;
  if (publicTargetAmount !== null) {
    const result = createPublicOversubscriptionDisplayData(
      normalized.totalAmount,
      publicTargetAmount,
    );
    if (!result.ok) return result;
    oversubscription = result.value;
  }

  return valid(
    Object.freeze({
      amount: display.value.amount,
      currency: display.value.currency,
      label: display.value.label,
      qualifier: display.value.qualifier,
      oversubscription,
    }),
  );
}

/** Parse the exact public aggregate shape at a serialization boundary. */
export function parseSanitizedPublicInvestmentAggregate(
  value: unknown,
): ValidationResult<SanitizedPublicInvestmentAggregate> {
  const source = record(value);
  if (source === null || !hasExactKeys(source, PUBLIC_AGGREGATE_KEYS)) {
    return invalid({ code: "invalid_type", path: "aggregate" });
  }
  const amount = parseMinorUnits(source.amount, { minimum: 1 });
  if (!amount.ok) return amount;
  const configuration = parseAmountAggregateConfiguration({
    amount: {
      currency: source.currency,
      minimum: 0,
      increment: 1,
      maximum: null,
    },
    publicAggregate: {
      visibility: "non_zero",
      label: source.label,
      qualifier: source.qualifier,
    },
  });
  if (!configuration.ok) {
    return invalid({ code: "invalid_rule", path: "aggregate" });
  }
  const display = configuration.value.publicAggregate;
  if (display.visibility !== "non_zero") {
    return invalid({ code: "invalid_rule", path: "aggregate" });
  }

  let oversubscription: PublicOversubscriptionDisplayData | null = null;
  if (source.oversubscription !== null) {
    const progress = record(source.oversubscription);
    if (
      progress === null ||
      !hasExactKeys(progress, PUBLIC_OVERSUBSCRIPTION_KEYS)
    ) {
      return invalid({ code: "invalid_type", path: "oversubscription" });
    }
    const expected = createPublicOversubscriptionDisplayData(
      amount.value,
      progress.targetAmount,
    );
    if (
      !expected.ok ||
      expected.value.status !== progress.status ||
      expected.value.remainingAmount !== progress.remainingAmount ||
      expected.value.amountOverTarget !== progress.amountOverTarget
    ) {
      return invalid({ code: "invalid_rule", path: "oversubscription" });
    }
    oversubscription = expected.value;
  }

  return valid(Object.freeze({
    amount: amount.value,
    currency: configuration.value.amount.currency,
    label: display.label,
    qualifier: display.qualifier,
    oversubscription,
  }));
}

function normalizeContribution(
  contribution: InvestmentAggregateContribution,
  currency: CurrencyCode,
): InvestmentAggregateContribution {
  const id = parseStableId<"investment-indication">(contribution.indicationId);
  if (!id.ok) throw new DomainError("INVALID_INPUT");
  assertPositiveSafeInteger(contribution.indicationRevision);
  assertStatus(contribution.status);
  const amount = parseMinorUnits(contribution.amount);
  if (!amount.ok || contribution.currency !== currency) {
    throw new DomainError("INVALID_INPUT");
  }

  return Object.freeze({
    indicationId: id.value,
    indicationRevision: contribution.indicationRevision,
    status: contribution.status,
    amount: amount.value,
    currency,
  });
}

function normalizeSummary(
  summary: InvestmentAggregateSummary,
  currency: CurrencyCode,
): InvestmentAggregateSummary {
  assertCurrency(currency);
  const total = parseMinorUnits(summary.totalAmount);
  if (!total.ok || summary.currency !== currency) {
    throw new DomainError("INVALID_INPUT");
  }
  assertNonNegativeSafeInteger(summary.contributingIndicationCount);
  return Object.freeze({
    totalAmount: total.value,
    currency,
    contributingIndicationCount: summary.contributingIndicationCount,
  });
}

function normalizeStoredSnapshot(
  stored: StoredInvestmentAggregateSnapshot,
): StoredInvestmentAggregateSnapshot {
  assertCurrency(stored.currency);
  assertNonNegativeSafeInteger(stored.revision);
  const total = parseMinorUnits(stored.totalAmount);
  if (!total.ok) throw new DomainError("INVALID_INPUT");
  assertNonNegativeSafeInteger(stored.contributingIndicationCount);
  return Object.freeze({
    revision: stored.revision,
    totalAmount: total.value,
    currency: stored.currency,
    contributingIndicationCount: stored.contributingIndicationCount,
  });
}

function sameAggregateFact(
  left: InvestmentAggregateContribution,
  right: InvestmentAggregateContribution,
): boolean {
  return (
    left.indicationId === right.indicationId &&
    left.indicationRevision === right.indicationRevision &&
    left.status === right.status &&
    left.amount === right.amount &&
    left.currency === right.currency
  );
}

function parseCorrectionConfirmation(
  value: unknown,
): ValidationResult<InvestmentAggregateCorrectionConfirmation> {
  const source = record(value);
  if (source === null) {
    return invalid({ code: "invalid_type", path: "confirmation" });
  }
  for (const key of Object.keys(source)) {
    if (!CORRECTION_CONFIRMATION_KEYS.has(key)) {
      return invalid({ code: "invalid_rule", path: key });
    }
  }
  if (!Object.hasOwn(source, "confirmation")) {
    return invalid({ code: "required", path: "confirmation" });
  }
  if (source.confirmation !== APPLY_CALCULATED_AGGREGATE_CONFIRMATION) {
    return invalid({ code: "invalid_rule", path: "confirmation" });
  }

  const storedRevision = parseNamedInteger(
    source.expectedStoredRevision,
    "expectedStoredRevision",
  );
  if (!storedRevision.ok) return storedRevision;
  const storedAmount = parseNamedMinorUnits(
    source.expectedStoredAmount,
    "expectedStoredAmount",
    0,
  );
  if (!storedAmount.ok) return storedAmount;
  const storedCount = parseNamedInteger(
    source.expectedStoredContributingIndicationCount,
    "expectedStoredContributingIndicationCount",
  );
  if (!storedCount.ok) return storedCount;
  const calculatedAmount = parseNamedMinorUnits(
    source.expectedCalculatedAmount,
    "expectedCalculatedAmount",
    0,
  );
  if (!calculatedAmount.ok) return calculatedAmount;
  const calculatedCount = parseNamedInteger(
    source.expectedCalculatedContributingIndicationCount,
    "expectedCalculatedContributingIndicationCount",
  );
  if (!calculatedCount.ok) return calculatedCount;

  return valid(
    Object.freeze({
      confirmation: APPLY_CALCULATED_AGGREGATE_CONFIRMATION,
      expectedStoredRevision: storedRevision.value,
      expectedStoredAmount: storedAmount.value,
      expectedStoredContributingIndicationCount: storedCount.value,
      expectedCalculatedAmount: calculatedAmount.value,
      expectedCalculatedContributingIndicationCount: calculatedCount.value,
    }),
  );
}

function parseNamedMinorUnits(
  value: unknown,
  path: string,
  minimum: number,
): ValidationResult<MinorUnits> {
  const parsed = parseMinorUnits(value, { minimum });
  return parsed.ok
    ? parsed
    : invalid({ ...parsed.issues[0], path });
}

function parseNamedInteger(
  value: unknown,
  path: string,
): ValidationResult<number> {
  if (typeof value !== "number") {
    return invalid({ code: "invalid_type", path });
  }
  if (!Number.isSafeInteger(value)) {
    return invalid({ code: "invalid_format", path });
  }
  if (value < 0) return invalid({ code: "out_of_range", path });
  return valid(value);
}

function assertCurrency(currency: CurrencyCode): void {
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new DomainError("INVALID_INPUT");
  }
}

function assertStatus(status: InvestmentIndicationStatus): void {
  if (status !== "active" && status !== "withdrawn" && status !== "rejected") {
    throw new DomainError("INVALID_INPUT");
  }
}

function assertPositiveSafeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DomainError("INVALID_INPUT");
  }
}

function assertNonNegativeSafeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("INVALID_INPUT");
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(
  source: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(source);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}
