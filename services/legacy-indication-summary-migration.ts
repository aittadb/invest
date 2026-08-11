import {
  MAX_ACTOR_SUBJECT_LENGTH,
  MAX_STABLE_ID_LENGTH,
  parseActorSubject,
  parseStableId,
  type ActorSubject,
} from "../domain/foundation.ts";
import type { InvestmentIndicationId } from "../domain/investment-indication.ts";
import {
  StorageFailure,
  type StorageAdapter,
} from "../domain/storage-adapter.ts";
import { migrateLegacyIndicationCurrentSummary } from "../repositories/in-memory-indication-repository.ts";

export const LEGACY_INDICATION_SUMMARY_MIGRATION_MANIFEST_VERSION = 1;
export const MAX_LEGACY_INDICATION_SUMMARY_MIGRATION_ENTRIES = 100;
const MAX_JSON_STRING_BYTES_PER_CODE_UNIT = 6;
const MAX_MANIFEST_ACTOR_SUBJECT_JSON_BYTES =
  2 + MAX_ACTOR_SUBJECT_LENGTH * MAX_JSON_STRING_BYTES_PER_CODE_UNIT;
const MAX_MANIFEST_INDICATION_ID_JSON_BYTES = 2 + MAX_STABLE_ID_LENGTH;
const MANIFEST_PREFIX_BYTES = '{"schemaVersion":1,"indications":['.length;
const MANIFEST_SUFFIX_BYTES = "]}".length;
const MANIFEST_ENTRY_OVERHEAD_BYTES =
  '{"participantSubject":'.length + ',"indicationId":'.length + "}".length;
export const MAX_LEGACY_INDICATION_SUMMARY_MIGRATION_MANIFEST_BYTES =
  MANIFEST_PREFIX_BYTES + MANIFEST_SUFFIX_BYTES +
  MAX_LEGACY_INDICATION_SUMMARY_MIGRATION_ENTRIES * (
    MANIFEST_ENTRY_OVERHEAD_BYTES +
    MAX_MANIFEST_ACTOR_SUBJECT_JSON_BYTES +
    MAX_MANIFEST_INDICATION_ID_JSON_BYTES
  ) +
  (MAX_LEGACY_INDICATION_SUMMARY_MIGRATION_ENTRIES - 1);

const MANIFEST_KEYS = new Set(["schemaVersion", "indications"]);
const ENTRY_KEYS = new Set(["participantSubject", "indicationId"]);

export type LegacyIndicationSummaryMigrationEntry = Readonly<{
  participantSubject: ActorSubject;
  indicationId: InvestmentIndicationId;
}>;

export type LegacyIndicationSummaryMigrationInventory = Readonly<{
  entries: readonly LegacyIndicationSummaryMigrationEntry[];
}>;

export type LegacyIndicationSummaryMigrationResult = Readonly<{
  scanned: number;
  migrated: number;
  alreadyCurrent: number;
}>;

/** Parse one closed, sorted, explicitly authoritative migration inventory. */
export function parseLegacyIndicationSummaryMigrationInventory(
  value: unknown,
): LegacyIndicationSummaryMigrationInventory {
  try {
    const source = exactRecord(value, MANIFEST_KEYS);
    if (
      source.schemaVersion !==
        LEGACY_INDICATION_SUMMARY_MIGRATION_MANIFEST_VERSION
    ) invalidRequest();
    const candidates = denseArray(
      source.indications,
      MAX_LEGACY_INDICATION_SUMMARY_MIGRATION_ENTRIES,
    );
    const entries: LegacyIndicationSummaryMigrationEntry[] = [];
    let priorIdentity: string | null = null;
    for (const candidate of candidates) {
      const entry = exactRecord(candidate, ENTRY_KEYS);
      const participantSubject = parseActorSubject(entry.participantSubject);
      const indicationId = parseStableId<"investment-indication">(
        entry.indicationId,
      );
      if (!participantSubject.ok || !indicationId.ok) invalidRequest();
      const identity = `${participantSubject.value}\u0000${indicationId.value}`;
      if (priorIdentity !== null && identity <= priorIdentity) invalidRequest();
      priorIdentity = identity;
      entries.push(Object.freeze({
        participantSubject: participantSubject.value,
        indicationId: indicationId.value,
      }));
    }
    return Object.freeze({ entries: Object.freeze(entries) });
  } catch (error) {
    if (error instanceof StorageFailure) throw error;
    invalidRequest();
  }
}

/** Run a bounded migration without returning subjects, IDs, or stored values. */
export async function runLegacyIndicationSummaryMigration(
  storage: StorageAdapter,
  inventory: unknown,
): Promise<LegacyIndicationSummaryMigrationResult> {
  const parsed = parseLegacyIndicationSummaryMigrationInventory(inventory);
  let migrated = 0;
  let alreadyCurrent = 0;
  for (const entry of parsed.entries) {
    const status = await migrateLegacyIndicationCurrentSummary(
      storage,
      entry.participantSubject,
      entry.indicationId,
    );
    if (status === "migrated") migrated += 1;
    else alreadyCurrent += 1;
  }
  return Object.freeze({
    scanned: parsed.entries.length,
    migrated,
    alreadyCurrent,
  });
}

function denseArray(value: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) invalidRequest();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.at(-1) !== "length") {
    invalidRequest();
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (keys[index] !== String(index)) invalidRequest();
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) invalidRequest();
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function exactRecord(
  value: unknown,
  expectedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) invalidRequest();
  const result = Object.create(null) as Record<string, unknown>;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.size ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
  ) invalidRequest();
  for (const key of keys) {
    if (typeof key !== "string") invalidRequest();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) invalidRequest();
    result[key] = descriptor.value;
  }
  return result;
}

function invalidRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
}
