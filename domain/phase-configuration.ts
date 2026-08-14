import {
  parseCountryCode,
  parseStableId,
  type CountryCode,
  type CountryCodeOptions,
  type StableId,
  type ValidationIssue,
  type ValidationResult,
} from "./foundation.ts";

export const PHASE_STATES = ["closed", "open"] as const;
export const PARTICIPATION_PATHS = ["founder", "investor"] as const;

export type PhaseState = (typeof PHASE_STATES)[number];
export type ParticipationPath = (typeof PARTICIPATION_PATHS)[number];

/** An explicit country allow-list or deny-list for one phase. */
export type CountryEligibilityRule = Readonly<{
  mode: "allow" | "deny";
  countries: readonly CountryCode[];
}>;

/** Framework-independent participation settings for one campaign phase. */
export type PhaseConfiguration = Readonly<{
  id: StableId<"phase">;
  state: PhaseState;
  enabledParticipationPaths: readonly ParticipationPath[];
  countryEligibility: CountryEligibilityRule;
}>;

export type PhaseSetupRequirement =
  | "countryEligibility.countries"
  | "enabledParticipationPaths";

export type PhaseSetupStatus = Readonly<{
  complete: boolean;
  missing: readonly PhaseSetupRequirement[];
}>;

const PHASE_KEYS = new Set([
  "id",
  "state",
  "enabledParticipationPaths",
  "countryEligibility",
]);
const COUNTRY_RULE_KEYS = new Set(["mode", "countries"]);
const MAX_COUNTRY_CODES = 26 * 26;

/** Parses unknown phase input without introducing campaign or country defaults. */
export function parsePhaseConfiguration(
  value: unknown,
  countryOptions: CountryCodeOptions = {},
): ValidationResult<PhaseConfiguration> {
  const source = record(value);
  if (source === null) {
    return failure({ code: "invalid_type", path: "phase" });
  }

  const issues: ValidationIssue[] = [];
  rejectUnknownKeys(source, PHASE_KEYS, "", issues);

  const id = parsePhaseId(source, issues);
  const state = parsePhaseState(source, issues);
  const enabledParticipationPaths = parseEnabledPaths(source, issues);
  const countryEligibility = parseCountryRule(
    source,
    countryOptions,
    issues,
  );

  if (
    issues.length > 0 ||
    id === null ||
    state === null ||
    enabledParticipationPaths === null ||
    countryEligibility === null
  ) {
    return failures(issues);
  }

  return {
    ok: true,
    value: {
      id,
      state,
      enabledParticipationPaths,
      countryEligibility,
    },
  };
}

/** Reports whether all choices required before opening a phase are explicit. */
export function checkPhaseSetup(
  phase: PhaseConfiguration,
): PhaseSetupStatus {
  const missing: PhaseSetupRequirement[] = [];

  if (phase.enabledParticipationPaths.length === 0) {
    missing.push("enabledParticipationPaths");
  }
  if (
    phase.countryEligibility.mode === "allow" &&
    phase.countryEligibility.countries.length === 0
  ) {
    missing.push("countryEligibility.countries");
  }

  return { complete: missing.length === 0, missing };
}

/** Evaluates one normalized country against an explicit phase rule. */
export function isCountryEligible(
  rule: CountryEligibilityRule,
  country: unknown,
  options: CountryCodeOptions = {},
): ValidationResult<boolean> {
  const parsed = parseCountryCode(country, options);
  if (!parsed.ok) {
    return {
      ok: false,
      issues: parsed.issues.map((issue) => ({ ...issue, path: "country" })),
    };
  }

  const listed = rule.countries.includes(parsed.value);
  return { ok: true, value: rule.mode === "allow" ? listed : !listed };
}

/** Checks phase state, enabled path, setup readiness, and country eligibility. */
export function isPhaseAcceptingParticipation(
  phase: PhaseConfiguration,
  path: unknown,
  country: unknown,
  options: CountryCodeOptions = {},
): ValidationResult<boolean> {
  const parsedPath = parseParticipationPath(path);
  if (!parsedPath.ok) return parsedPath;

  const countryResult = isCountryEligible(
    phase.countryEligibility,
    country,
    options,
  );
  if (!countryResult.ok) return countryResult;

  return {
    ok: true,
    value:
      phase.state === "open" &&
      checkPhaseSetup(phase).complete &&
      phase.enabledParticipationPaths.includes(parsedPath.value) &&
      countryResult.value,
  };
}

/** Parses one supported participation path from untrusted input. */
export function parseParticipationPath(
  value: unknown,
): ValidationResult<ParticipationPath> {
  if (typeof value !== "string") {
    return failure({ code: "invalid_type", path: "participationPath" });
  }
  if (!isParticipationPath(value)) {
    return failure({ code: "invalid_format", path: "participationPath" });
  }
  return { ok: true, value };
}

function parsePhaseId(
  source: Record<string, unknown>,
  issues: ValidationIssue[],
): StableId<"phase"> | null {
  if (!Object.hasOwn(source, "id")) {
    issues.push({ code: "required", path: "id" });
    return null;
  }

  const result = parseStableId<"phase">(source.id);
  if (!result.ok) {
    issues.push(...result.issues.map((issue) => ({ ...issue, path: "id" })));
    return null;
  }
  return result.value;
}

function parsePhaseState(
  source: Record<string, unknown>,
  issues: ValidationIssue[],
): PhaseState | null {
  if (!Object.hasOwn(source, "state")) {
    issues.push({ code: "required", path: "state" });
    return null;
  }
  if (typeof source.state !== "string") {
    issues.push({ code: "invalid_type", path: "state" });
    return null;
  }
  if (!isPhaseState(source.state)) {
    issues.push({ code: "invalid_format", path: "state" });
    return null;
  }
  return source.state;
}

function parseEnabledPaths(
  source: Record<string, unknown>,
  issues: ValidationIssue[],
): readonly ParticipationPath[] | null {
  const path = "enabledParticipationPaths";
  if (!Object.hasOwn(source, path)) {
    issues.push({ code: "required", path });
    return null;
  }
  if (!Array.isArray(source.enabledParticipationPaths)) {
    issues.push({ code: "invalid_type", path });
    return null;
  }
  if (source.enabledParticipationPaths.length > PARTICIPATION_PATHS.length) {
    issues.push({ code: "out_of_range", path });
    return null;
  }

  const parsed: ParticipationPath[] = [];
  for (const [index, candidate] of source.enabledParticipationPaths.entries()) {
    const candidatePath = `${path}[${index}]`;
    if (typeof candidate !== "string") {
      issues.push({ code: "invalid_type", path: candidatePath });
    } else if (!isParticipationPath(candidate)) {
      issues.push({ code: "invalid_format", path: candidatePath });
    } else if (parsed.includes(candidate)) {
      issues.push({ code: "invalid_rule", path: candidatePath });
    } else {
      parsed.push(candidate);
    }
  }

  return parsed.sort(compareBy(PARTICIPATION_PATHS));
}

function parseCountryRule(
  source: Record<string, unknown>,
  options: CountryCodeOptions,
  issues: ValidationIssue[],
): CountryEligibilityRule | null {
  const path = "countryEligibility";
  if (!Object.hasOwn(source, path)) {
    issues.push({ code: "required", path });
    return null;
  }

  const rule = record(source.countryEligibility);
  if (rule === null) {
    issues.push({ code: "invalid_type", path });
    return null;
  }
  rejectUnknownKeys(rule, COUNTRY_RULE_KEYS, `${path}.`, issues);

  const mode = parseCountryRuleMode(rule, path, issues);
  const countries = parseCountryRuleCountries(rule, path, options, issues);
  return mode === null || countries === null ? null : { mode, countries };
}

function parseCountryRuleMode(
  source: Record<string, unknown>,
  parentPath: string,
  issues: ValidationIssue[],
): CountryEligibilityRule["mode"] | null {
  const path = `${parentPath}.mode`;
  if (!Object.hasOwn(source, "mode")) {
    issues.push({ code: "required", path });
    return null;
  }
  if (typeof source.mode !== "string") {
    issues.push({ code: "invalid_type", path });
    return null;
  }
  if (source.mode !== "allow" && source.mode !== "deny") {
    issues.push({ code: "invalid_format", path });
    return null;
  }
  return source.mode;
}

function parseCountryRuleCountries(
  source: Record<string, unknown>,
  parentPath: string,
  options: CountryCodeOptions,
  issues: ValidationIssue[],
): readonly CountryCode[] | null {
  const path = `${parentPath}.countries`;
  if (!Object.hasOwn(source, "countries")) {
    issues.push({ code: "required", path });
    return null;
  }
  if (!Array.isArray(source.countries)) {
    issues.push({ code: "invalid_type", path });
    return null;
  }
  if (source.countries.length > MAX_COUNTRY_CODES) {
    issues.push({ code: "out_of_range", path });
    return null;
  }

  const parsed: CountryCode[] = [];
  for (const [index, candidate] of source.countries.entries()) {
    const result = parseCountryCode(candidate, options);
    const candidatePath = `${path}[${index}]`;
    if (!result.ok) {
      issues.push(
        ...result.issues.map((issue) => ({ ...issue, path: candidatePath })),
      );
    } else if (parsed.includes(result.value)) {
      issues.push({ code: "invalid_rule", path: candidatePath });
    } else {
      parsed.push(result.value);
    }
  }

  return parsed.sort((left, right) => left.localeCompare(right, "en"));
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

function isPhaseState(value: string): value is PhaseState {
  return (PHASE_STATES as readonly string[]).includes(value);
}

function isParticipationPath(value: string): value is ParticipationPath {
  return (PARTICIPATION_PATHS as readonly string[]).includes(value);
}

function compareBy<const Value extends string>(
  order: readonly Value[],
): (left: Value, right: Value) => number {
  return (left, right) => order.indexOf(left) - order.indexOf(right);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function failure<Value = never>(
  issue: ValidationIssue,
): ValidationResult<Value> {
  return { ok: false, issues: [issue] };
}

function failures<Value = never>(
  issues: readonly ValidationIssue[],
): ValidationResult<Value> {
  if (issues.length === 0) {
    return failure({ code: "invalid_rule", path: "phase" });
  }
  return { ok: false, issues };
}
