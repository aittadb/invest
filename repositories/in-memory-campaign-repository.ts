import {
  parseAmountAggregateConfiguration,
  type AmountAggregateConfiguration,
} from "../domain/amount-aggregate-configuration.ts";
import {
  parseTimestamp,
  type Timestamp,
  type ValidationIssue,
  type ValidationResult,
} from "../domain/foundation.ts";
import {
  parsePhaseConfiguration,
  type PhaseConfiguration,
} from "../domain/phase-configuration.ts";
import {
  parsePublicCampaignConfiguration,
  type PublicCampaignConfiguration,
} from "../domain/public-campaign-configuration.ts";
import {
  StorageFailure,
  assertStorageListBoundary,
  parseStorageKey,
  parseStorageOperationId,
  type StorageAdapter,
  type StorageCursor,
  type StorageDocument,
  type StorageKey,
  type StorageOperationId,
  type StorageRecord,
} from "../domain/storage-adapter.ts";

const CAMPAIGN_SETUP_SCHEMA_VERSION = 1;
const MAX_CAMPAIGN_PHASES = 32;
const CURRENT_SETUP_KEY = storageKey("campaign-setup-current", "configured-campaign");
const HISTORY_COLLECTION = storageKey(
  "campaign-setup-history",
  "campaign-setup-revision:0000000000000001",
).collection;

const SETUP_KEYS = new Set(["publicCampaign", "phases", "amountAggregate"]);
const STORED_REVISION_KEYS = new Set([
  "kind",
  "schemaVersion",
  "revision",
  "recordedAt",
  "operationId",
  "setup",
]);

/** All campaign-specific setup that must be supplied explicitly by a deployment. */
export type CampaignSetup = Readonly<{
  publicCampaign: PublicCampaignConfiguration;
  phases: readonly PhaseConfiguration[];
  amountAggregate: AmountAggregateConfiguration;
}>;

/** One immutable campaign setup revision. */
export type CampaignSetupRevision = Readonly<{
  revision: number;
  recordedAt: Timestamp;
  operationId: StorageOperationId;
  setup: CampaignSetup;
}>;

export type SaveCampaignSetupRequest = Readonly<{
  operationId: unknown;
  recordedAt: unknown;
  expectedRevision: number | null;
  setup: unknown;
}>;

export type CampaignSetupHistoryRequest = Readonly<{
  limit: number;
  cursor?: StorageCursor;
}>;

export type CampaignSetupHistoryPage = Readonly<{
  items: readonly CampaignSetupRevision[];
  nextCursor: StorageCursor | null;
}>;

/** Narrow one-campaign-per-deployment persistence contract. */
export interface CampaignRepository {
  readSetup(): Promise<CampaignSetupRevision | null>;
  saveSetup(request: SaveCampaignSetupRequest): Promise<CampaignSetupRevision>;
  listSetupHistory(
    request: CampaignSetupHistoryRequest,
  ): Promise<CampaignSetupHistoryPage>;
}

/**
 * Development/test campaign repository composed over an in-memory StorageAdapter.
 *
 * The repository has no durable state of its own: a fresh instance reads all
 * state through the supplied adapter. It is not production storage. Production
 * deployments must use the separately validated AittaDB campaign repository.
 */
export class DevelopmentInMemoryCampaignRepository implements CampaignRepository {
  readonly storageKind = "development-in-memory" as const;

  private readonly storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  async readSetup(): Promise<CampaignSetupRevision | null> {
    const record = await this.storage.read(CURRENT_SETUP_KEY);
    return record === null ? null : decodeCurrentRevision(record);
  }

  async saveSetup(
    request: SaveCampaignSetupRequest,
  ): Promise<CampaignSetupRevision> {
    const operationId = parseStorageOperationId(request.operationId);
    const recordedAt = parseTimestamp(request.recordedAt);
    const setup = parseCampaignSetup(request.setup);
    const nextRevision = parseNextRevision(request.expectedRevision);

    if (!operationId.ok || !recordedAt.ok || !setup.ok || nextRevision === null) {
      throw new StorageFailure("INVALID_REQUEST");
    }

    const revision = deepFreeze({
      revision: nextRevision,
      recordedAt: recordedAt.value,
      operationId: operationId.value,
      setup: setup.value,
    });
    const value = encodeRevision(revision);
    const historyKey = setupHistoryKey(nextRevision);
    const result = await this.storage.transact({
      operationId: operationId.value,
      mutations: [
        {
          type: "put",
          key: CURRENT_SETUP_KEY,
          expectedRevision: request.expectedRevision,
          value,
        },
        {
          type: "put",
          key: historyKey,
          expectedRevision: null,
          value,
        },
      ],
    });

    const currentRecord = result.records[0];
    const historyRecord = result.records[1];
    if (!currentRecord || !historyRecord) {
      throw new StorageFailure("UNAVAILABLE");
    }

    const current = decodeCurrentRevision(currentRecord);
    const history = decodeHistoryRevision(historyRecord);
    if (JSON.stringify(current) !== JSON.stringify(history)) {
      throw new StorageFailure("UNAVAILABLE");
    }
    return current;
  }

  async listSetupHistory(
    request: CampaignSetupHistoryRequest,
  ): Promise<CampaignSetupHistoryPage> {
    assertStorageListBoundary({
      collection: HISTORY_COLLECTION,
      limit: request.limit,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    });
    const page = await this.storage.list({
      collection: HISTORY_COLLECTION,
      limit: request.limit,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    });

    return deepFreeze({
      items: page.items.map(decodeHistoryRevision),
      nextCursor: page.nextCursor,
    });
  }
}

/** Parses setup without supplying a campaign, phase, country, currency, or display default. */
export function parseCampaignSetup(
  value: unknown,
): ValidationResult<CampaignSetup> {
  const source = record(value);
  if (source === null) {
    return failure({ code: "invalid_type", path: "setup" });
  }

  const issues: ValidationIssue[] = [];
  rejectUnknownKeys(source, SETUP_KEYS, "setup.", issues);

  const publicCampaign = parsePublicCampaign(source, issues);
  const phases = parsePhases(source, issues);
  const amountAggregate = parseAmountAggregate(source, issues);

  if (
    issues.length > 0 ||
    publicCampaign === null ||
    phases === null ||
    amountAggregate === null
  ) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: deepFreeze({ publicCampaign, phases, amountAggregate }),
  };
}

function parsePublicCampaign(
  source: Record<string, unknown>,
  issues: ValidationIssue[],
): PublicCampaignConfiguration | null {
  const path = "setup.publicCampaign";
  if (!Object.hasOwn(source, "publicCampaign")) {
    issues.push({ code: "required", path });
    return null;
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(source.publicCampaign);
  } catch {
    issues.push({ code: "invalid_format", path });
    return null;
  }
  const parsed = parsePublicCampaignConfiguration(serialized);
  if (parsed === null) {
    issues.push({ code: "invalid_format", path });
    return null;
  }
  return parsed;
}

function parsePhases(
  source: Record<string, unknown>,
  issues: ValidationIssue[],
): readonly PhaseConfiguration[] | null {
  const path = "setup.phases";
  if (!Object.hasOwn(source, "phases")) {
    issues.push({ code: "required", path });
    return null;
  }
  if (!Array.isArray(source.phases)) {
    issues.push({ code: "invalid_type", path });
    return null;
  }
  if (source.phases.length < 1 || source.phases.length > MAX_CAMPAIGN_PHASES) {
    issues.push({ code: "out_of_range", path });
    return null;
  }

  const parsed: PhaseConfiguration[] = [];
  const phaseIds = new Set<string>();
  for (const [index, candidate] of source.phases.entries()) {
    const result = parsePhaseConfiguration(candidate);
    if (!result.ok) {
      issues.push(
        ...result.issues.map((issue) => ({
          ...issue,
          path: `${path}[${index}]${issue.path ? `.${issue.path}` : ""}`,
        })),
      );
      continue;
    }
    if (phaseIds.has(result.value.id)) {
      issues.push({ code: "invalid_rule", path: `${path}[${index}].id` });
      continue;
    }
    phaseIds.add(result.value.id);
    parsed.push(result.value);
  }

  return parsed;
}

function parseAmountAggregate(
  source: Record<string, unknown>,
  issues: ValidationIssue[],
): AmountAggregateConfiguration | null {
  const path = "setup.amountAggregate";
  if (!Object.hasOwn(source, "amountAggregate")) {
    issues.push({ code: "required", path });
    return null;
  }

  const result = parseAmountAggregateConfiguration(source.amountAggregate);
  if (!result.ok) {
    issues.push(
      ...result.issues.map((issue) => ({
        ...issue,
        path: `${path}${issue.path ? `.${issue.path}` : ""}`,
      })),
    );
    return null;
  }
  return result.value;
}

function parseNextRevision(expectedRevision: number | null): number | null {
  if (expectedRevision === null) return 1;
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1 ||
    expectedRevision >= Number.MAX_SAFE_INTEGER
  ) {
    return null;
  }
  return expectedRevision + 1;
}

function encodeRevision(revision: CampaignSetupRevision): StorageDocument {
  return deepFreeze({
    kind: "campaign-setup-revision",
    schemaVersion: CAMPAIGN_SETUP_SCHEMA_VERSION,
    revision: revision.revision,
    recordedAt: revision.recordedAt,
    operationId: revision.operationId,
    setup: revision.setup,
  });
}

function decodeCurrentRevision(record: StorageRecord): CampaignSetupRevision {
  const revision = decodeRevision(record.value);
  if (
    record.key.collection !== CURRENT_SETUP_KEY.collection ||
    record.key.id !== CURRENT_SETUP_KEY.id ||
    record.revision !== revision.revision
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return revision;
}

function decodeHistoryRevision(record: StorageRecord): CampaignSetupRevision {
  const revision = decodeRevision(record.value);
  const expectedKey = setupHistoryKey(revision.revision);
  if (
    record.key.collection !== expectedKey.collection ||
    record.key.id !== expectedKey.id ||
    record.revision !== 1
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return revision;
}

function decodeRevision(value: StorageDocument): CampaignSetupRevision {
  const source = record(value);
  if (source === null || !hasExactKeys(source, STORED_REVISION_KEYS)) {
    throw new StorageFailure("UNAVAILABLE");
  }
  if (
    source.kind !== "campaign-setup-revision" ||
    source.schemaVersion !== CAMPAIGN_SETUP_SCHEMA_VERSION ||
    !Number.isSafeInteger(source.revision) ||
    (source.revision as number) < 1
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }

  const recordedAt = parseTimestamp(source.recordedAt);
  const operationId = parseStorageOperationId(source.operationId);
  const setup = parseCampaignSetup(source.setup);
  if (!recordedAt.ok || !operationId.ok || !setup.ok) {
    throw new StorageFailure("UNAVAILABLE");
  }

  return deepFreeze({
    revision: source.revision as number,
    recordedAt: recordedAt.value,
    operationId: operationId.value,
    setup: setup.value,
  });
}

function setupHistoryKey(revision: number): StorageKey {
  return storageKey(
    HISTORY_COLLECTION,
    `campaign-setup-revision:${String(revision).padStart(16, "0")}`,
  );
}

function storageKey(collection: unknown, id: unknown): StorageKey {
  const result = parseStorageKey(collection, id);
  if (!result.ok) throw new StorageFailure("INVALID_REQUEST");
  return result.value;
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

function hasExactKeys(
  source: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(source);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
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

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
