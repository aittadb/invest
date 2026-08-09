import {
  parseAmountAggregateConfiguration,
  type AmountAggregateConfiguration,
} from "../domain/amount-aggregate-configuration.ts";
import {
  parseActorSubject,
  parseTimestamp,
  type Timestamp,
  type ValidationIssue,
  type ValidationResult,
} from "../domain/foundation.ts";
import type { AuditEvent } from "../domain/audit-notification.ts";
import {
  parseCampaignSetupPolicy,
  type CampaignSetupPolicy,
} from "../domain/campaign-setup-policy.ts";
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
import {
  prepareAuditAppend,
  verifyPreparedAuditAppend,
} from "./in-memory-audit-notification-repositories.ts";

const CAMPAIGN_SETUP_SCHEMA_VERSION = 3;
const MAX_CAMPAIGN_PHASES = 32;
const CURRENT_SETUP_KEY = storageKey("campaign-setup-current", "configured-campaign");
const HISTORY_COLLECTION = storageKey(
  "campaign-setup-history",
  "campaign-setup-revision:0000000000000001",
).collection;
const OPERATION_COLLECTION = storageKey(
  "campaign-setup-operations",
  "campaign-operation:example",
).collection;
const PUBLIC_PRESENTATION_KEY = storageKey(
  "campaign-public-presentation",
  "configured-campaign",
);

const SETUP_KEYS = new Set([
  "publicCampaign",
  "phases",
  "amountAggregate",
  "campaignPolicy",
]);
const STORED_REVISION_KEYS = new Set([
  "kind",
  "schemaVersion",
  "revision",
  "recordedAt",
  "operationId",
  "setup",
]);
const PUBLIC_PRESENTATION_KEYS = new Set([
  "kind",
  "schemaVersion",
  "revision",
  "publicCampaign",
]);

/** All campaign-specific setup that must be supplied explicitly by a deployment. */
export type CampaignSetup = Readonly<{
  publicCampaign: PublicCampaignConfiguration;
  phases: readonly PhaseConfiguration[];
  amountAggregate: AmountAggregateConfiguration;
  campaignPolicy: CampaignSetupPolicy;
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

export type CampaignAuditTransition =
  | "created"
  | "updated"
  | "published"
  | "unpublished";
export type CampaignMutationConsistency =
  | "atomic-campaign-audit"
  | "unavailable";

export type SaveCampaignSetupWithAuditRequest = SaveCampaignSetupRequest &
  Readonly<{
    ownerSubject: unknown;
    transition: CampaignAuditTransition;
  }>;

export type AuditedCampaignSetupSaveResult = Readonly<{
  campaign: CampaignSetupRevision;
  auditEvent: AuditEvent;
  replayed: boolean;
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
  findSetupByOperationId(
    operationId: unknown,
  ): Promise<CampaignSetupRevision | null>;
  saveSetup(request: SaveCampaignSetupRequest): Promise<CampaignSetupRevision>;
  listSetupHistory(
    request: CampaignSetupHistoryRequest,
  ): Promise<CampaignSetupHistoryPage>;
}

/** Public-only projection contract; implementations must not return setup data. */
export interface PublicCampaignPresentationReader {
  readPublishedCampaign(): Promise<PublicCampaignConfiguration | null>;
}

/** Campaign mutations that commit their audit evidence in the same transaction. */
export interface AtomicCampaignAuditRepository extends CampaignRepository {
  readonly mutationConsistency: "atomic-campaign-audit";
  saveSetupWithAudit(
    request: SaveCampaignSetupWithAuditRequest,
  ): Promise<AuditedCampaignSetupSaveResult>;
}

/**
 * Development/test campaign repository composed over an in-memory StorageAdapter.
 *
 * The repository has no durable state of its own: a fresh instance reads all
 * state through the supplied adapter. It is not production storage. Production
 * deployments must use the separately validated AittaDB campaign repository.
 */
export class DevelopmentInMemoryCampaignRepository
  implements AtomicCampaignAuditRepository {
  readonly storageKind = "development-in-memory" as const;
  readonly mutationConsistency = "atomic-campaign-audit" as const;

  private readonly storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  async readSetup(): Promise<CampaignSetupRevision | null> {
    const record = await this.storage.read(CURRENT_SETUP_KEY);
    return record === null ? null : decodeCurrentRevision(record);
  }

  async findSetupByOperationId(
    operationId: unknown,
  ): Promise<CampaignSetupRevision | null> {
    const parsed = parseStorageOperationId(operationId);
    if (!parsed.ok) throw new StorageFailure("INVALID_REQUEST");
    const record = await this.storage.read(setupOperationKey(parsed.value));
    return record === null ? null : decodeOperationRevision(record);
  }

  async saveSetup(
    request: SaveCampaignSetupRequest,
  ): Promise<CampaignSetupRevision> {
    const prepared = prepareCampaignSave(request);
    const result = await this.storage.transact({
      operationId: prepared.revision.operationId,
      mutations: [
        {
          type: "put",
          key: CURRENT_SETUP_KEY,
          expectedRevision: request.expectedRevision,
          value: prepared.value,
        },
        {
          type: "put",
          key: prepared.historyKey,
          expectedRevision: null,
          value: prepared.value,
        },
        {
          type: "put",
          key: prepared.operationKey,
          expectedRevision: null,
          value: prepared.value,
        },
        publicPresentationMutation(prepared, request.expectedRevision),
      ],
    });

    return verifyCampaignSave(
      prepared,
      result.records[0],
      result.records[1],
      result.records[2],
      result.records[3],
    );
  }

  async saveSetupWithAudit(
    request: SaveCampaignSetupWithAuditRequest,
  ): Promise<AuditedCampaignSetupSaveResult> {
    const prepared = prepareCampaignSave(request);
    const ownerSubject = parseActorSubject(request.ownerSubject);
    if (!ownerSubject.ok || !isCampaignAuditTransition(request.transition)) {
      throw new StorageFailure("INVALID_REQUEST");
    }
    const existing = await this.findSetupByOperationId(
      prepared.revision.operationId,
    );
    if (existing === null) {
      const current = await this.readSetup();
      assertCampaignAuditTransition(
        current,
        request.expectedRevision,
        prepared.revision,
        request.transition,
      );
    }

    const audit = prepareAuditAppend({
      type: "append-audit-event",
      event: {
        id: await campaignAuditEventId(prepared.revision.operationId),
        operationId: prepared.revision.operationId,
        occurredAt: prepared.revision.recordedAt,
        actor: { type: "owner", subject: ownerSubject.value },
        detail: {
          kind: "resource-transition",
          resource: {
            type: "campaign",
            id: `campaign:${prepared.revision.setup.publicCampaign.id}`,
          },
          transition: request.transition,
        },
      },
    });
    if (audit.operationId !== prepared.revision.operationId) {
      throw new StorageFailure("INVALID_REQUEST");
    }

    const result = await this.storage.transact({
      operationId: prepared.revision.operationId,
      mutations: [
        {
          type: "put",
          key: CURRENT_SETUP_KEY,
          expectedRevision: request.expectedRevision,
          value: prepared.value,
        },
        {
          type: "put",
          key: prepared.historyKey,
          expectedRevision: null,
          value: prepared.value,
        },
        {
          type: "put",
          key: prepared.operationKey,
          expectedRevision: null,
          value: prepared.value,
        },
        publicPresentationMutation(prepared, request.expectedRevision),
        audit.mutation,
      ],
    });

    return deepFreeze({
      campaign: verifyCampaignSave(
        prepared,
        result.records[0],
        result.records[1],
        result.records[2],
        result.records[3],
      ),
      auditEvent: verifyPreparedAuditAppend(audit, result.records[4]),
      replayed: result.replayed,
    });
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

/** Development/test reader bound only to the public projection key. */
export class DevelopmentInMemoryPublicCampaignPresentationReader
implements PublicCampaignPresentationReader {
  private readonly storage: Pick<StorageAdapter, "read">;

  constructor(storage: Pick<StorageAdapter, "read">) {
    this.storage = storage;
  }

  async readPublishedCampaign(): Promise<PublicCampaignConfiguration | null> {
    const record = await this.storage.read(PUBLIC_PRESENTATION_KEY);
    if (record === null) return null;
    const campaign = decodePublicPresentation(record);
    return campaign.published ? campaign : null;
  }
}

type PreparedCampaignSave = Readonly<{
  revision: CampaignSetupRevision;
  value: StorageDocument;
  historyKey: StorageKey;
  operationKey: StorageKey;
}>;

function prepareCampaignSave(
  request: SaveCampaignSetupRequest,
): PreparedCampaignSave {
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
  return Object.freeze({
    revision,
    value: encodeRevision(revision),
    historyKey: setupHistoryKey(nextRevision),
    operationKey: setupOperationKey(revision.operationId),
  });
}

function verifyCampaignSave(
  prepared: PreparedCampaignSave,
  currentRecord: StorageRecord | null | undefined,
  historyRecord: StorageRecord | null | undefined,
  operationRecord: StorageRecord | null | undefined,
  publicRecord: StorageRecord | null | undefined,
): CampaignSetupRevision {
  if (!currentRecord || !historyRecord || !operationRecord || !publicRecord) {
    throw new StorageFailure("UNAVAILABLE");
  }

  const current = decodeCurrentRevision(currentRecord);
  const history = decodeHistoryRevision(historyRecord);
  const operation = decodeOperationRevision(operationRecord);
  const publicCampaign = decodePublicPresentation(publicRecord);
  if (
    JSON.stringify(current) !== JSON.stringify(history) ||
    JSON.stringify(current) !== JSON.stringify(operation) ||
    JSON.stringify(current.setup.publicCampaign) !== JSON.stringify(publicCampaign) ||
    JSON.stringify(current) !== JSON.stringify(prepared.revision)
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return current;
}

function assertCampaignAuditTransition(
  current: CampaignSetupRevision | null,
  expectedRevision: number | null,
  next: CampaignSetupRevision,
  transition: CampaignAuditTransition,
): void {
  if (current === null) {
    const validCreation = expectedRevision === null &&
      next.revision === 1 &&
      !next.setup.publicCampaign.published &&
      transition === "created";
    if (!validCreation) throw new StorageFailure("INVALID_REQUEST");
    return;
  }
  if (expectedRevision === null) {
    throw new StorageFailure("PRECONDITION_FAILED");
  }
  if (current.revision !== expectedRevision) {
    throw new StorageFailure("PRECONDITION_FAILED");
  }

  const before = current.setup.publicCampaign.published;
  const after = next.setup.publicCampaign.published;
  const valid = transition === "updated"
    ? before === after
    : transition === "published"
      ? before === false && after === true
      : before === true && after === false;
  if (!valid) throw new StorageFailure("INVALID_REQUEST");
}

function isCampaignAuditTransition(
  value: unknown,
): value is CampaignAuditTransition {
  return value === "created" || value === "updated" ||
    value === "published" || value === "unpublished";
}

async function campaignAuditEventId(operationId: StorageOperationId): Promise<string> {
  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`campaign-audit:${operationId}`),
    );
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
  const fingerprint = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `campaign-audit:${fingerprint}`;
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
  const campaignPolicy = parseCampaignPolicy(source, issues);

  if (
    issues.length > 0 ||
    publicCampaign === null ||
    phases === null ||
    amountAggregate === null ||
    campaignPolicy === null
  ) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: deepFreeze({
      publicCampaign,
      phases,
      amountAggregate,
      campaignPolicy,
    }),
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

function parseCampaignPolicy(
  source: Record<string, unknown>,
  issues: ValidationIssue[],
): CampaignSetupPolicy | null {
  const path = "setup.campaignPolicy";
  if (!Object.hasOwn(source, "campaignPolicy")) {
    issues.push({ code: "required", path });
    return null;
  }

  const result = parseCampaignSetupPolicy(source.campaignPolicy);
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

function decodeOperationRevision(record: StorageRecord): CampaignSetupRevision {
  const revision = decodeRevision(record.value);
  const expectedKey = setupOperationKey(revision.operationId);
  if (
    record.key.collection !== expectedKey.collection ||
    record.key.id !== expectedKey.id ||
    record.revision !== 1
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return revision;
}

function publicPresentationMutation(
  prepared: PreparedCampaignSave,
  expectedRevision: number | null,
) {
  return Object.freeze({
    type: "put" as const,
    key: PUBLIC_PRESENTATION_KEY,
    expectedRevision,
    value: encodePublicPresentation(prepared.revision),
  });
}

function encodePublicPresentation(
  revision: CampaignSetupRevision,
): StorageDocument {
  return deepFreeze({
    kind: "campaign-public-presentation",
    schemaVersion: CAMPAIGN_SETUP_SCHEMA_VERSION,
    revision: revision.revision,
    publicCampaign: revision.setup.publicCampaign,
  });
}

function decodePublicPresentation(
  record: StorageRecord,
): PublicCampaignConfiguration {
  const source = recordValue(record.value);
  if (
    source === null ||
    !hasExactKeys(source, PUBLIC_PRESENTATION_KEYS) ||
    source.kind !== "campaign-public-presentation" ||
    source.schemaVersion !== CAMPAIGN_SETUP_SCHEMA_VERSION ||
    !Number.isSafeInteger(source.revision) ||
    (source.revision as number) < 1 ||
    record.key.collection !== PUBLIC_PRESENTATION_KEY.collection ||
    record.key.id !== PUBLIC_PRESENTATION_KEY.id ||
    record.revision !== source.revision
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(source.publicCampaign);
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
  const campaign = parsePublicCampaignConfiguration(serialized);
  if (campaign === null) throw new StorageFailure("UNAVAILABLE");
  return campaign;
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

function setupOperationKey(operationId: StorageOperationId): StorageKey {
  return storageKey(OPERATION_COLLECTION, operationId);
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return record(value);
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
