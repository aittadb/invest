import {
  MAX_ACTOR_SUBJECT_LENGTH,
  MAX_STABLE_ID_LENGTH,
  parseActorSubject,
  parseStableId,
  type ActorSubject,
} from "../domain/foundation.ts";
import {
  MAX_INVESTMENT_INDICATION_REVISIONS,
  type InvestmentIndication,
  type InvestmentIndicationId,
} from "../domain/investment-indication.ts";
import {
  StorageFailure,
  parseStorageOperationId,
  type StorageAdapter,
  type StorageOperationId,
} from "../domain/storage-adapter.ts";
import { MAX_OWNED_INVESTMENT_INDICATIONS } from "../repositories/in-memory-indication-repository.ts";
import {
  initializeParticipantInvestmentOwnership,
  type ParticipantInvestmentOwnershipInitializationEntry,
} from "../repositories/storage-participant-investment-repository.ts";
import { MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS } from "../worker/participant-investment-mutation-port.ts";

export const LEGACY_INVESTMENT_OWNERSHIP_MIGRATION_MANIFEST_VERSION = 1;
export const MAX_LEGACY_INVESTMENT_OWNERSHIP_MIGRATION_SUBJECTS = 100;

const MAX_UTF8_BYTES_PER_WELL_FORMED_CODE_UNIT = 3;
const MAX_SUBJECT_JSON_BYTES =
  2 + MAX_ACTOR_SUBJECT_LENGTH * MAX_UTF8_BYTES_PER_WELL_FORMED_CODE_UNIT;
const MAX_STABLE_ID_JSON_BYTES = 2 + MAX_STABLE_ID_LENGTH;
const MAX_REVISION_JSON_BYTES = String(
  MAX_INVESTMENT_INDICATION_REVISIONS,
).length;
const MAX_LIFECYCLE_JSON_BYTES = Math.max(
  JSON.stringify("active").length,
  JSON.stringify("withdrawn").length,
  JSON.stringify("rejected").length,
);
const MANIFEST_PREFIX_BYTES = '{"schemaVersion":1,"participants":['.length;
const MANIFEST_SUFFIX_BYTES = "]}".length;
const PARTICIPANT_PREFIX_BYTES = '{"participantSubject":'.length;
const PARTICIPANT_OPERATION_BYTES = ',"operationId":'.length;
const PARTICIPANT_INDICATIONS_PREFIX_BYTES = ',"indications":['.length;
const PARTICIPANT_SUFFIX_BYTES = "]}".length;
const INDICATION_PREFIX_BYTES = '{"indicationId":'.length;
const INDICATION_REVISION_BYTES = ',"indicationRevision":'.length;
const INDICATION_LIFECYCLE_BYTES = ',"lifecycleStatus":'.length;
const INDICATION_SUFFIX_BYTES = "}".length;
const MAX_INDICATION_JSON_BYTES =
  INDICATION_PREFIX_BYTES + MAX_STABLE_ID_JSON_BYTES +
  INDICATION_REVISION_BYTES + MAX_REVISION_JSON_BYTES +
  INDICATION_LIFECYCLE_BYTES + MAX_LIFECYCLE_JSON_BYTES +
  INDICATION_SUFFIX_BYTES;
const MAX_PARTICIPANT_JSON_BYTES =
  PARTICIPANT_PREFIX_BYTES + MAX_SUBJECT_JSON_BYTES +
  PARTICIPANT_OPERATION_BYTES + MAX_STABLE_ID_JSON_BYTES +
  PARTICIPANT_INDICATIONS_PREFIX_BYTES +
  MAX_OWNED_INVESTMENT_INDICATIONS * MAX_INDICATION_JSON_BYTES +
  Math.max(0, MAX_OWNED_INVESTMENT_INDICATIONS - 1) +
  PARTICIPANT_SUFFIX_BYTES;

export const MAX_LEGACY_INVESTMENT_OWNERSHIP_MIGRATION_MANIFEST_BYTES =
  MANIFEST_PREFIX_BYTES +
  MAX_LEGACY_INVESTMENT_OWNERSHIP_MIGRATION_SUBJECTS *
    MAX_PARTICIPANT_JSON_BYTES +
  Math.max(0, MAX_LEGACY_INVESTMENT_OWNERSHIP_MIGRATION_SUBJECTS - 1) +
  MANIFEST_SUFFIX_BYTES;

const MANIFEST_KEYS = new Set(["schemaVersion", "participants"]);
const PARTICIPANT_KEYS = new Set([
  "participantSubject",
  "operationId",
  "indications",
]);
const INDICATION_KEYS = new Set([
  "indicationId",
  "indicationRevision",
  "lifecycleStatus",
]);

export type LegacyInvestmentOwnershipMigrationIndication = Readonly<{
  indicationId: InvestmentIndicationId;
  indicationRevision: number;
  lifecycleStatus: InvestmentIndication["lifecycle"]["status"];
}>;

export type LegacyInvestmentOwnershipMigrationEntry = Readonly<{
  participantSubject: ActorSubject;
  operationId: StorageOperationId;
  indications: readonly LegacyInvestmentOwnershipMigrationIndication[];
}>;

export type LegacyInvestmentOwnershipMigrationInventory = Readonly<{
  entries: readonly LegacyInvestmentOwnershipMigrationEntry[];
}>;

export type LegacyInvestmentOwnershipMigrationResult = Readonly<{
  scanned: number;
  initialized: number;
  alreadyInitialized: number;
  indications: number;
}>;

/** Parse one closed, sorted, explicitly authoritative subject inventory. */
export function parseLegacyInvestmentOwnershipMigrationInventory(
  value: unknown,
): LegacyInvestmentOwnershipMigrationInventory {
  try {
    const source = exactRecord(value, MANIFEST_KEYS);
    if (
      source.schemaVersion !==
        LEGACY_INVESTMENT_OWNERSHIP_MIGRATION_MANIFEST_VERSION
    ) invalidRequest();
    const candidates = denseArray(
      source.participants,
      MAX_LEGACY_INVESTMENT_OWNERSHIP_MIGRATION_SUBJECTS,
    );
    const entries: LegacyInvestmentOwnershipMigrationEntry[] = [];
    const indicationIds = new Set<string>();
    const operationIds = new Set<string>();
    let previousSubject: string | null = null;
    for (const candidate of candidates) {
      const entry = exactRecord(candidate, PARTICIPANT_KEYS);
      const participantSubject = parseActorSubject(entry.participantSubject);
      const operationId = parseStorageOperationId(entry.operationId);
      if (!participantSubject.ok || !operationId.ok) invalidRequest();
      if (
        previousSubject !== null &&
        compareCodeUnits(participantSubject.value, previousSubject) <= 0
      ) invalidRequest();
      if (operationIds.has(operationId.value)) invalidRequest();
      previousSubject = participantSubject.value;
      operationIds.add(operationId.value);
      const indications = parseIndications(entry.indications, indicationIds);
      if (
        indications.filter(({ lifecycleStatus }) =>
          lifecycleStatus === "active"
        ).length > MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS
      ) invalidRequest();
      entries.push(Object.freeze({
        participantSubject: participantSubject.value,
        operationId: operationId.value,
        indications,
      }));
    }
    return Object.freeze({ entries: Object.freeze(entries) });
  } catch (error) {
    if (error instanceof StorageFailure) throw error;
    invalidRequest();
  }
}

/** Run bounded initialization and return only content-free counters. */
export async function runLegacyInvestmentOwnershipMigration(
  storage: StorageAdapter,
  inventory: unknown,
): Promise<LegacyInvestmentOwnershipMigrationResult> {
  const parsed = parseLegacyInvestmentOwnershipMigrationInventory(inventory);
  let initialized = 0;
  let alreadyInitialized = 0;
  let indications = 0;
  for (const entry of parsed.entries) {
    const result = await initializeParticipantInvestmentOwnership(
      storage,
      entry.participantSubject,
      {
        operationId: entry.operationId,
        indications: entry.indications satisfies readonly ParticipantInvestmentOwnershipInitializationEntry[],
      },
    );
    if (result.replayed) alreadyInitialized += 1;
    else initialized += 1;
    indications += result.indicationCount;
  }
  return Object.freeze({
    scanned: parsed.entries.length,
    initialized,
    alreadyInitialized,
    indications,
  });
}

function parseIndications(
  value: unknown,
  manifestIndicationIds: Set<string>,
): readonly LegacyInvestmentOwnershipMigrationIndication[] {
  const candidates = denseArray(value, MAX_OWNED_INVESTMENT_INDICATIONS);
  const indications: LegacyInvestmentOwnershipMigrationIndication[] = [];
  let previousId: string | null = null;
  for (const candidate of candidates) {
    const entry = exactRecord(candidate, INDICATION_KEYS);
    const indicationId = parseStableId<"investment-indication">(
      entry.indicationId,
    );
    if (
      !indicationId.ok ||
      previousId !== null && compareCodeUnits(indicationId.value, previousId) <= 0 ||
      indicationId.ok && manifestIndicationIds.has(indicationId.value) ||
      !Number.isSafeInteger(entry.indicationRevision) ||
      (entry.indicationRevision as number) < 1 ||
      (entry.indicationRevision as number) > MAX_INVESTMENT_INDICATION_REVISIONS ||
      !isLifecycleStatus(entry.lifecycleStatus)
    ) invalidRequest();
    previousId = indicationId.value;
    manifestIndicationIds.add(indicationId.value);
    indications.push(Object.freeze({
      indicationId: indicationId.value,
      indicationRevision: entry.indicationRevision as number,
      lifecycleStatus: entry.lifecycleStatus,
    }));
  }
  return Object.freeze(indications);
}

function isLifecycleStatus(
  value: unknown,
): value is InvestmentIndication["lifecycle"]["status"] {
  return value === "active" || value === "withdrawn" || value === "rejected";
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
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.size ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
  ) invalidRequest();
  const result = Object.create(null) as Record<string, unknown>;
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

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
}
