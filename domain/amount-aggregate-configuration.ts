import {
  parseMinorUnits,
  type MinorUnits,
  type ValidationIssue,
  type ValidationResult,
} from "./foundation.ts";

declare const amountConfigurationBrand: unique symbol;

export type CurrencyCode = string & {
  readonly [amountConfigurationBrand]: "CurrencyCode";
};

export type PublicDisplayText = string & {
  readonly [amountConfigurationBrand]: "PublicDisplayText";
};

/** Explicit amount limits for one campaign configuration. */
export type AmountConfiguration = Readonly<{
  currency: CurrencyCode;
  minimum: MinorUnits;
  increment: MinorUnits;
  maximum: MinorUnits | null;
}>;

export type PublicAggregateDisplayConfiguration =
  | Readonly<{ visibility: "hidden" }>
  | Readonly<{
      visibility: "non_zero";
      label: PublicDisplayText;
      qualifier: PublicDisplayText;
    }>;

/** Framework-independent amount and public-display settings. */
export type AmountAggregateConfiguration = Readonly<{
  amount: AmountConfiguration;
  publicAggregate: PublicAggregateDisplayConfiguration;
}>;

/** The complete public projection; private aggregate fields cannot enter it. */
export type SanitizedPublicAggregateDisplay = Readonly<{
  amount: MinorUnits;
  currency: CurrencyCode;
  label: PublicDisplayText;
  qualifier: PublicDisplayText;
}>;

const ROOT_KEYS = new Set(["amount", "publicAggregate"]);
const AMOUNT_KEYS = new Set(["currency", "minimum", "increment", "maximum"]);
const HIDDEN_DISPLAY_KEYS = new Set(["visibility"]);
const VISIBLE_DISPLAY_KEYS = new Set([
  "visibility",
  "label",
  "qualifier",
]);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
export const MAX_PUBLIC_AGGREGATE_LABEL_LENGTH = 120;
export const MAX_PUBLIC_AGGREGATE_QUALIFIER_LENGTH = 500;

/** Parses untrusted settings without supplying currency, amount, or visibility defaults. */
export function parseAmountAggregateConfiguration(
  value: unknown,
): ValidationResult<AmountAggregateConfiguration> {
  const source = record(value);
  if (source === null) {
    return failure({ code: "invalid_type", path: "configuration" });
  }

  const issues: ValidationIssue[] = [];
  rejectUnknownKeys(source, ROOT_KEYS, "", issues);

  const amount = Object.hasOwn(source, "amount")
    ? parseAmountConfiguration(source.amount, issues)
    : required("amount", issues);
  const publicAggregate = Object.hasOwn(source, "publicAggregate")
    ? parsePublicAggregateConfiguration(source.publicAggregate, issues)
    : required("publicAggregate", issues);

  if (issues.length > 0 || amount === null || publicAggregate === null) {
    return failures(issues);
  }

  return { ok: true, value: { amount, publicAggregate } };
}

/** Validates an amount against the configured bounds and increment. */
export function parseConfiguredAmount(
  value: unknown,
  configuration: AmountConfiguration,
): ValidationResult<MinorUnits> {
  const result = parseMinorUnits(value, {
    minimum: configuration.minimum,
    ...(configuration.maximum === null
      ? {}
      : { maximum: configuration.maximum }),
  });
  if (!result.ok) return result;

  if (
    (result.value - configuration.minimum) % configuration.increment !==
    0
  ) {
    return failure({ code: "invalid_rule", path: "amount" });
  }

  return result;
}

/** Creates a non-zero public amount projection or returns null when hidden. */
export function createSanitizedPublicAggregateDisplay(
  total: unknown,
  configuration: AmountAggregateConfiguration,
): ValidationResult<SanitizedPublicAggregateDisplay | null> {
  const parsedTotal = parseMinorUnits(total);
  if (!parsedTotal.ok) return parsedTotal;

  if (
    parsedTotal.value === 0 ||
    configuration.publicAggregate.visibility === "hidden"
  ) {
    return { ok: true, value: null };
  }

  return {
    ok: true,
    value: {
      amount: parsedTotal.value,
      currency: configuration.amount.currency,
      label: configuration.publicAggregate.label,
      qualifier: configuration.publicAggregate.qualifier,
    },
  };
}

function parseAmountConfiguration(
  value: unknown,
  issues: ValidationIssue[],
): AmountConfiguration | null {
  const source = record(value);
  if (source === null) {
    issues.push({ code: "invalid_type", path: "amount" });
    return null;
  }
  rejectUnknownKeys(source, AMOUNT_KEYS, "amount.", issues);

  const currency = parseCurrency(source, issues);
  const minimum = parseRequiredMinorUnits(source, "minimum", 0, issues);
  const increment = parseRequiredMinorUnits(source, "increment", 1, issues);
  const maximum = parseOptionalMaximum(source, issues);

  if (
    minimum !== null &&
    maximum !== undefined &&
    maximum !== null &&
    maximum < minimum
  ) {
    issues.push({ code: "invalid_rule", path: "amount.maximum" });
  }

  if (
    currency === null ||
    minimum === null ||
    increment === null ||
    maximum === undefined
  ) {
    return null;
  }

  return { currency, minimum, increment, maximum };
}

function parseCurrency(
  source: Record<string, unknown>,
  issues: ValidationIssue[],
): CurrencyCode | null {
  const path = "amount.currency";
  if (!Object.hasOwn(source, "currency")) {
    issues.push({ code: "required", path });
    return null;
  }
  if (typeof source.currency !== "string") {
    issues.push({ code: "invalid_type", path });
    return null;
  }

  const normalized = source.currency.trim().toUpperCase();
  if (!CURRENCY_PATTERN.test(normalized)) {
    issues.push({
      code: normalized.length === 0 ? "required" : "invalid_format",
      path,
    });
    return null;
  }
  return normalized as CurrencyCode;
}

function parseRequiredMinorUnits(
  source: Record<string, unknown>,
  key: "minimum" | "increment",
  minimum: number,
  issues: ValidationIssue[],
): MinorUnits | null {
  const path = `amount.${key}`;
  if (!Object.hasOwn(source, key)) {
    issues.push({ code: "required", path });
    return null;
  }

  const result = parseMinorUnits(source[key], { minimum });
  if (!result.ok) {
    issues.push(...result.issues.map((issue) => ({ ...issue, path })));
    return null;
  }
  return result.value;
}

function parseOptionalMaximum(
  source: Record<string, unknown>,
  issues: ValidationIssue[],
): MinorUnits | null | undefined {
  if (!Object.hasOwn(source, "maximum") || source.maximum === null) {
    return null;
  }

  const path = "amount.maximum";
  const result = parseMinorUnits(source.maximum);
  if (!result.ok) {
    issues.push(...result.issues.map((issue) => ({ ...issue, path })));
    return undefined;
  }
  return result.value;
}

function parsePublicAggregateConfiguration(
  value: unknown,
  issues: ValidationIssue[],
): PublicAggregateDisplayConfiguration | null {
  const source = record(value);
  if (source === null) {
    issues.push({ code: "invalid_type", path: "publicAggregate" });
    return null;
  }

  const visibility = parseVisibility(source, issues);
  if (visibility === null) {
    rejectUnknownKeys(source, VISIBLE_DISPLAY_KEYS, "publicAggregate.", issues);
    return null;
  }
  if (visibility === "hidden") {
    rejectUnknownKeys(source, HIDDEN_DISPLAY_KEYS, "publicAggregate.", issues);
    return { visibility };
  }

  rejectUnknownKeys(source, VISIBLE_DISPLAY_KEYS, "publicAggregate.", issues);
  const label = parsePublicDisplayText(
    source,
    "label",
    MAX_PUBLIC_AGGREGATE_LABEL_LENGTH,
    issues,
  );
  const qualifier = parsePublicDisplayText(
    source,
    "qualifier",
    MAX_PUBLIC_AGGREGATE_QUALIFIER_LENGTH,
    issues,
  );
  return label === null || qualifier === null
    ? null
    : { visibility, label, qualifier };
}

function parseVisibility(
  source: Record<string, unknown>,
  issues: ValidationIssue[],
): PublicAggregateDisplayConfiguration["visibility"] | null {
  const path = "publicAggregate.visibility";
  if (!Object.hasOwn(source, "visibility")) {
    issues.push({ code: "required", path });
    return null;
  }
  if (typeof source.visibility !== "string") {
    issues.push({ code: "invalid_type", path });
    return null;
  }
  if (source.visibility !== "hidden" && source.visibility !== "non_zero") {
    issues.push({ code: "invalid_format", path });
    return null;
  }
  return source.visibility;
}

function parsePublicDisplayText(
  source: Record<string, unknown>,
  key: "label" | "qualifier",
  maximumLength: number,
  issues: ValidationIssue[],
): PublicDisplayText | null {
  const path = `publicAggregate.${key}`;
  if (!Object.hasOwn(source, key)) {
    issues.push({ code: "required", path });
    return null;
  }
  if (typeof source[key] !== "string") {
    issues.push({ code: "invalid_type", path });
    return null;
  }

  const normalized = source[key].trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) {
    issues.push({ code: "required", path });
    return null;
  }
  if (
    normalized.length > maximumLength ||
    hasUnsafeDisplayCharacter(normalized)
  ) {
    issues.push({
      code:
        normalized.length > maximumLength ? "out_of_range" : "invalid_format",
      path,
    });
    return null;
  }
  return normalized as PublicDisplayText;
}

function hasUnsafeDisplayCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      character === "<" ||
      character === ">" ||
      codePoint === undefined ||
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

function rejectUnknownKeys(
  source: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  pathPrefix: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(source).sort()) {
    if (!allowed.has(key)) {
      issues.push({ code: "invalid_rule", path: `${pathPrefix}${key}` });
    }
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function required(
  path: string,
  issues: ValidationIssue[],
): null {
  issues.push({ code: "required", path });
  return null;
}

function failure<Value = never>(
  issue: ValidationIssue,
): ValidationResult<Value> {
  return { ok: false, issues: [issue] };
}

function failures<Value = never>(
  issues: readonly ValidationIssue[],
): ValidationResult<Value> {
  return issues.length === 0
    ? failure({ code: "invalid_rule", path: "configuration" })
    : { ok: false, issues };
}
