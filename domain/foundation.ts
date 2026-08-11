declare const domainBrand: unique symbol;

type Branded<Value, Name extends string> = Value & {
  readonly [domainBrand]: Name;
};

export type MinorUnits = Branded<number, "MinorUnits">;
export type Timestamp = Branded<string, "Timestamp">;
export type StableId<Entity extends string = "entity"> = Branded<
  string,
  `StableId:${Entity}`
>;
export type ActorSubject = Branded<string, "ActorSubject">;
export type CountryCode = Branded<string, "CountryCode">;

export const MAX_STABLE_ID_LENGTH = 128;

export type Actor =
  | Readonly<{ type: "visitor" }>
  | Readonly<{ type: "participant"; subject: ActorSubject }>
  | Readonly<{ type: "owner"; subject: ActorSubject }>
  | Readonly<{ type: "system" }>;

export type ValidationIssueCode =
  | "required"
  | "invalid_type"
  | "invalid_format"
  | "out_of_range"
  | "invalid_rule";

export type ValidationIssue = Readonly<{
  code: ValidationIssueCode;
  path?: string;
}>;

export type ValidationResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; issues: readonly ValidationIssue[] }>;

export function valid<Value>(value: Value): ValidationResult<Value> {
  return { ok: true, value };
}

export function invalid<Value = never>(
  ...issues: readonly [ValidationIssue, ...ValidationIssue[]]
): ValidationResult<Value> {
  return { ok: false, issues };
}

export type MinorUnitBounds = Readonly<{
  minimum?: number;
  maximum?: number;
}>;

export function parseMinorUnits(
  value: unknown,
  bounds: MinorUnitBounds = {},
): ValidationResult<MinorUnits> {
  if (typeof value !== "number") {
    return invalid({ code: "invalid_type", path: "amount" });
  }

  if (!Number.isSafeInteger(value)) {
    return invalid({ code: "invalid_format", path: "amount" });
  }

  const minimum = bounds.minimum ?? 0;
  const maximum = bounds.maximum ?? Number.MAX_SAFE_INTEGER;

  if (
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    minimum < 0 ||
    minimum > maximum
  ) {
    return invalid({ code: "invalid_rule", path: "amount" });
  }

  if (value < minimum || value > maximum) {
    return invalid({ code: "out_of_range", path: "amount" });
  }

  return valid(value as MinorUnits);
}

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseTimestamp(value: unknown): ValidationResult<Timestamp> {
  if (typeof value !== "string") {
    return invalid({ code: "invalid_type", path: "timestamp" });
  }

  if (!TIMESTAMP_PATTERN.test(value)) {
    return invalid({ code: "invalid_format", path: "timestamp" });
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    return invalid({ code: "invalid_format", path: "timestamp" });
  }

  return valid(value as Timestamp);
}

const STABLE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/;

export function parseStableId<Entity extends string = "entity">(
  value: unknown,
): ValidationResult<StableId<Entity>> {
  if (typeof value !== "string") {
    return invalid({ code: "invalid_type", path: "id" });
  }

  if (
    value.length > MAX_STABLE_ID_LENGTH ||
    !STABLE_ID_PATTERN.test(value)
  ) {
    return invalid({ code: value.length === 0 ? "required" : "invalid_format", path: "id" });
  }

  return valid(value as StableId<Entity>);
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

export function parseActorSubject(
  value: unknown,
): ValidationResult<ActorSubject> {
  if (typeof value !== "string") {
    return invalid({ code: "invalid_type", path: "subject" });
  }

  if (value.length === 0) {
    return invalid({ code: "required", path: "subject" });
  }

  if (
    value.length > 255 ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    return invalid({ code: "invalid_format", path: "subject" });
  }

  return valid(value as ActorSubject);
}

export type CountryCodeNormalizer = (value: string) => string;

export type CountryCodeOptions = Readonly<{
  normalize?: CountryCodeNormalizer;
}>;

export const normalizeCountryCode: CountryCodeNormalizer = (value) =>
  value.trim().toUpperCase();

export function parseCountryCode(
  value: unknown,
  options: CountryCodeOptions = {},
): ValidationResult<CountryCode> {
  if (typeof value !== "string") {
    return invalid({ code: "invalid_type", path: "country" });
  }

  let normalized: string;
  try {
    normalized = (options.normalize ?? normalizeCountryCode)(value);
  } catch {
    return invalid({ code: "invalid_format", path: "country" });
  }

  if (!/^[A-Z]{2}$/.test(normalized)) {
    return invalid({
      code: normalized.length === 0 ? "required" : "invalid_format",
      path: "country",
    });
  }

  return valid(normalized as CountryCode);
}

export type DomainErrorCode =
  | "INVALID_INPUT"
  | "AUTHENTICATION_REQUIRED"
  | "ACCESS_DENIED"
  | "RESOURCE_NOT_FOUND"
  | "RESOURCE_CONFLICT"
  | "PRECONDITION_FAILED"
  | "RATE_LIMITED"
  | "DEPENDENCY_UNAVAILABLE"
  | "INTERNAL_FAILURE";

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, options: ErrorOptions = {}) {
    super("The requested operation could not be completed.", options);
    this.name = "DomainError";
    this.code = code;
  }
}

export type PublicDomainErrorCode =
  | "INVALID_REQUEST"
  | "AUTHENTICATION_REQUIRED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PRECONDITION_FAILED"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export type PublicDomainError = Readonly<{
  status: number;
  body: Readonly<{
    error: Readonly<{
      code: PublicDomainErrorCode;
      message: string;
    }>;
  }>;
}>;

const PUBLIC_ERRORS: Readonly<
  Record<DomainErrorCode, PublicDomainError>
> = {
  INVALID_INPUT: publicError(400, "INVALID_REQUEST", "The request is invalid."),
  AUTHENTICATION_REQUIRED: publicError(
    401,
    "AUTHENTICATION_REQUIRED",
    "Sign in is required.",
  ),
  ACCESS_DENIED: publicError(404, "NOT_FOUND", "The requested resource was not found."),
  RESOURCE_NOT_FOUND: publicError(
    404,
    "NOT_FOUND",
    "The requested resource was not found.",
  ),
  RESOURCE_CONFLICT: publicError(409, "CONFLICT", "The request conflicts with current state."),
  PRECONDITION_FAILED: publicError(
    412,
    "PRECONDITION_FAILED",
    "A required condition has changed.",
  ),
  RATE_LIMITED: publicError(429, "RATE_LIMITED", "Please try again later."),
  DEPENDENCY_UNAVAILABLE: publicError(
    503,
    "SERVICE_UNAVAILABLE",
    "The service is temporarily unavailable.",
  ),
  INTERNAL_FAILURE: publicError(500, "INTERNAL_ERROR", "The request could not be completed."),
};

function publicError(
  status: number,
  code: PublicDomainErrorCode,
  message: string,
): PublicDomainError {
  return { status, body: { error: { code, message } } };
}

export function toPublicDomainError(error: unknown): PublicDomainError {
  if (error instanceof DomainError) {
    return PUBLIC_ERRORS[error.code];
  }

  return PUBLIC_ERRORS.INTERNAL_FAILURE;
}
