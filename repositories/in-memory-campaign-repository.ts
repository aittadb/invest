import {
  parseAmountAggregateConfiguration,
  type AmountAggregateConfiguration,
} from "../domain/amount-aggregate-configuration.ts";
import {
  parseActorSubject,
  parseTimestamp,
  type ActorSubject,
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
  type StorageCheckMutation,
  type StorageCursor,
  type StorageDocument,
  type StorageKey,
  type StorageMutation,
  type StorageOperationId,
  type StoragePutMutation,
  type StorageRecord,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import {
  prepareAuditAppend,
  verifyPreparedAuditAppend,
  type PreparedAuditAppend,
} from "./in-memory-audit-notification-repositories.ts";

const CAMPAIGN_SETUP_SCHEMA_VERSION = 4;
const LEGACY_PUBLIC_PRESENTATION_SCHEMA_VERSION = 4;
const PUBLIC_PRESENTATION_SCHEMA_VERSION = 5;
const MAX_CAMPAIGN_PHASES = 32;
const MAX_SERIALIZED_CAMPAIGN_SETUP_BYTES = 262_144;
const SETUP_CHUNK_RAW_BYTES = 45_000;
const MAX_SETUP_CHUNKS = Math.ceil(
  MAX_SERIALIZED_CAMPAIGN_SETUP_BYTES / SETUP_CHUNK_RAW_BYTES,
);
export const MAX_CAMPAIGN_SETUP_MATERIALIZATION_READS = 1 + MAX_SETUP_CHUNKS;
const MAX_SETUP_CHUNK_RECORD_BYTES = 61_440;
export const CAMPAIGN_OPERATION_INTENT_MAX_RECORD_BYTES = 2_048;
const SETUP_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CURRENT_SETUP_KEY = storageKey("campaign-setup-current", "configured-campaign");
const HISTORY_COLLECTION = storageKey(
  "campaign-setup-history",
  "campaign-setup-revision:0000000000000001",
).collection;
const OPERATION_COLLECTION = storageKey(
  "campaign-setup-operations",
  "campaign-operation:example",
).collection;
const OPERATION_INTENT_COLLECTION = storageKey(
  "campaign-setup-intents",
  "campaign-operation:example",
).collection;
const SETUP_CHUNK_COLLECTION = storageKey(
  "campaign-setup-chunks",
  `campaign-setup-chunk:${"0".repeat(64)}:0000`,
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
  "setupHash",
  "setupBytes",
  "setupChunks",
]);
const STORED_SETUP_CHUNK_KEYS = new Set([
  "kind",
  "schemaVersion",
  "setupHash",
  "setupBytes",
  "chunkIndex",
  "chunkCount",
  "data",
]);
const STORED_OPERATION_INTENT_BASE_KEYS = [
  "kind",
  "schemaVersion",
  "mode",
  "operationId",
  "expectedRevision",
  "resultingRevision",
  "recordedAt",
  "setupHash",
  "setupBytes",
  "setupChunks",
] as const;
const STORED_UNAUDITED_OPERATION_INTENT_KEYS = new Set(
  STORED_OPERATION_INTENT_BASE_KEYS,
);
const STORED_AUDITED_OPERATION_INTENT_KEYS = new Set([
  ...STORED_OPERATION_INTENT_BASE_KEYS,
  "actor",
  "transition",
]);
const LEGACY_PUBLIC_PRESENTATION_KEYS = new Set([
  "kind",
  "schemaVersion",
  "revision",
  "publicCampaign",
]);
const PUBLIC_PRESENTATION_KEYS = new Set([
  ...LEGACY_PUBLIC_PRESENTATION_KEYS,
  "amountAggregate",
]);
type PublicPresentationSchema = "legacy" | "current";

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

/** Exact current-setup assertion used by atomic dependent writes. */
export function campaignSetupRevisionCheck(
  revision: unknown,
): StorageCheckMutation {
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return Object.freeze({
    type: "check",
    key: CURRENT_SETUP_KEY,
    expectedRevision: revision as number,
  });
}

/** Validate unchanged current-setup evidence returned for a positive check. */
export function verifyCampaignSetupRevisionCheckRecord(
  record: unknown,
  expectedRevision: unknown,
): void {
  if (
    !Number.isSafeInteger(expectedRevision) ||
    (expectedRevision as number) < 1
  ) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  const envelope = exactDataObject(record, ["key", "revision", "value"]);
  const key = envelope === null
    ? null
    : exactDataObject(envelope.key, ["collection", "id"]);
  const value = envelope === null
    ? null
    : exactDataObject(envelope.value, [...STORED_REVISION_KEYS]);
  if (
    envelope === null ||
    key === null ||
    value === null ||
    key.collection !== CURRENT_SETUP_KEY.collection ||
    key.id !== CURRENT_SETUP_KEY.id ||
    envelope.revision !== expectedRevision
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  const decoded = decodeRevision(value as StorageDocument);
  if (decoded.revision !== expectedRevision) {
    throw new StorageFailure("UNAVAILABLE");
  }
}

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

/** Public campaign and aggregate policy captured by one published revision. */
export type PublishedCampaignProjection = Readonly<{
  revision: number;
  publicCampaign: PublicCampaignConfiguration;
  amountAggregate: AmountAggregateConfiguration | null;
}>;

/** Public-only projection contract used to bind totals to published policy. */
export interface PublishedCampaignProjectionReader {
  readPublishedProjection(): Promise<PublishedCampaignProjection | null>;
}

/** Campaign mutations that commit their audit evidence in the same transaction. */
export interface AtomicCampaignAuditRepository extends CampaignRepository {
  readonly mutationConsistency: "atomic-campaign-audit";
  saveSetupWithAudit(
    request: SaveCampaignSetupWithAuditRequest,
  ): Promise<AuditedCampaignSetupSaveResult>;
}

/**
 * Atomic campaign repository composed over a caller-supplied StorageAdapter.
 *
 * The repository has no durable state of its own. Production composition must
 * supply the credential-bound AittaDB adapter; development wrappers may supply
 * an explicit deterministic test adapter.
 */
export class StorageCampaignRepository implements AtomicCampaignAuditRepository {
  readonly mutationConsistency = "atomic-campaign-audit" as const;

  readonly #storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.#storage = storage;
  }

  async readSetup(): Promise<CampaignSetupRevision | null> {
    const record = await this.#storage.read(CURRENT_SETUP_KEY);
    return record === null
      ? null
      : materializeRevision(this.#storage, decodeCurrentRevision(record));
  }

  async findSetupByOperationId(
    operationId: unknown,
  ): Promise<CampaignSetupRevision | null> {
    const parsed = parseStorageOperationId(operationId);
    if (!parsed.ok) throw new StorageFailure("INVALID_REQUEST");
    const record = await this.#storage.read(setupOperationKey(parsed.value));
    return record === null
      ? null
      : materializeRevision(this.#storage, decodeOperationRevision(record));
  }

  async saveSetup(
    request: SaveCampaignSetupRequest,
  ): Promise<CampaignSetupRevision> {
    const prepared = await prepareCampaignSave(request);
    const intent = await prepareCampaignOperationIntent(prepared, {
      mode: "unaudited",
    });
    if (!await hasMatchingCampaignOperationIntent(this.#storage, intent)) {
      await persistCampaignOperationIntent(this.#storage, intent);
    }
    await stageSetupChunks(this.#storage, prepared.chunks);
    const transaction = await transactCampaignSave(this.#storage, prepared);

    return verifyCampaignSaveTransactionResult(
      transaction.result,
      prepared,
      transaction.publicPresentationSchema,
    );
  }

  async saveSetupWithAudit(
    request: SaveCampaignSetupWithAuditRequest,
  ): Promise<AuditedCampaignSetupSaveResult> {
    const prepared = await prepareCampaignSave(request);
    const ownerSubject = parseActorSubject(request.ownerSubject);
    const transition = request.transition;
    if (!ownerSubject.ok || !isCampaignAuditTransition(transition)) {
      throw new StorageFailure("INVALID_REQUEST");
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
          transition,
        },
      },
    });
    if (audit.operationId !== prepared.revision.operationId) {
      throw new StorageFailure("INVALID_REQUEST");
    }
    const intent = await prepareCampaignOperationIntent(prepared, {
      mode: "audited",
      actor: { type: "owner", subject: ownerSubject.value },
      transition,
    });
    const intentExists = await hasMatchingCampaignOperationIntent(
      this.#storage,
      intent,
    );
    if (!intentExists) {
      const existing = await this.findSetupByOperationId(
        prepared.revision.operationId,
      );
      if (
        existing !== null &&
        JSON.stringify(existing) !== JSON.stringify(prepared.revision)
      ) {
        throw new StorageFailure("CONFLICT");
      }
      if (existing === null) {
        const current = await this.readSetup();
        try {
          assertCampaignAuditTransition(
            current,
            prepared.expectedRevision,
            prepared.revision,
            transition,
          );
        } catch (error) {
          const raced = await this.findSetupByOperationId(
            prepared.revision.operationId,
          );
          if (
            raced === null ||
            JSON.stringify(raced) !== JSON.stringify(prepared.revision)
          ) {
            throw error;
          }
        }
      }
      await persistCampaignOperationIntent(this.#storage, intent);
    }

    await stageSetupChunks(this.#storage, prepared.chunks);
    const transaction = await transactCampaignSave(
      this.#storage,
      prepared,
      audit.mutation,
    );

    return verifyAuditedCampaignSaveTransactionResult(
      transaction.result,
      prepared,
      audit,
      transaction.publicPresentationSchema,
    );
  }

  async listSetupHistory(
    request: CampaignSetupHistoryRequest,
  ): Promise<CampaignSetupHistoryPage> {
    assertStorageListBoundary({
      collection: HISTORY_COLLECTION,
      limit: request.limit,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    });
    const page = await this.#storage.list({
      collection: HISTORY_COLLECTION,
      limit: request.limit,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    });

    return deepFreeze({
      items: await Promise.all(page.items.map(async (record) =>
        materializeRevision(this.#storage, decodeHistoryRevision(record))
      )),
      nextCursor: page.nextCursor,
    });
  }
}

/** Reader bound only to the separately stored public campaign projection. */
export class StoragePublicCampaignPresentationReader
  implements
    PublicCampaignPresentationReader,
    PublishedCampaignProjectionReader {
  readonly #read: Pick<StorageAdapter, "read">["read"];

  constructor(storage: Pick<StorageAdapter, "read">) {
    this.#read = storage.read.bind(storage);
  }

  async readPublishedCampaign(): Promise<PublicCampaignConfiguration | null> {
    return (await this.readPublishedProjection())?.publicCampaign ?? null;
  }

  async readPublishedProjection(): Promise<PublishedCampaignProjection | null> {
    const record = await this.#read(PUBLIC_PRESENTATION_KEY);
    if (record === null) return null;
    const projection = decodePublicPresentation(record);
    return projection.publicCampaign.published ? projection : null;
  }
}

/** Development compatibility wrapper; never use this name in hosted wiring. */
export class DevelopmentInMemoryCampaignRepository
  extends StorageCampaignRepository {
  readonly storageKind = "development-in-memory" as const;
}

/** Development compatibility wrapper; never use this name in hosted wiring. */
export class DevelopmentInMemoryPublicCampaignPresentationReader
  extends StoragePublicCampaignPresentationReader {}

type StoredSetupReference = Readonly<{
  setupHash: string;
  setupBytes: number;
  setupChunks: number;
}>;

type StoredCampaignSetupRevision = Readonly<{
  revision: number;
  recordedAt: Timestamp;
  operationId: StorageOperationId;
  reference: StoredSetupReference;
}>;

type PreparedSetupChunk = Readonly<{
  key: StorageKey;
  operationId: StorageOperationId;
  value: StorageDocument;
}>;

type PreparedCampaignSave = Readonly<{
  revision: CampaignSetupRevision;
  expectedRevision: number | null;
  reference: StoredSetupReference;
  chunks: readonly PreparedSetupChunk[];
  value: StorageDocument;
  historyKey: StorageKey;
  operationKey: StorageKey;
}>;

type CampaignOperationIntent = Readonly<{
  mode: "unaudited" | "audited";
  operationId: StorageOperationId;
  expectedRevision: number | null;
  resultingRevision: number;
  recordedAt: Timestamp;
  reference: StoredSetupReference;
  actor?: Readonly<{ type: "owner"; subject: ActorSubject }>;
  transition?: CampaignAuditTransition;
}>;

type CampaignOperationIntentInput =
  | Readonly<{ mode: "unaudited" }>
  | Readonly<{
      mode: "audited";
      actor: Readonly<{ type: "owner"; subject: ActorSubject }>;
      transition: CampaignAuditTransition;
    }>;

type PreparedCampaignOperationIntent = Readonly<{
  intent: CampaignOperationIntent;
  key: StorageKey;
  transactionOperationId: StorageOperationId;
  value: StorageDocument;
}>;

async function prepareCampaignSave(
  request: SaveCampaignSetupRequest,
): Promise<PreparedCampaignSave> {
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
  const preparedSetup = await prepareStoredSetup(revision.setup);
  return Object.freeze({
    revision,
    expectedRevision: nextRevision === 1 ? null : nextRevision - 1,
    reference: preparedSetup.reference,
    chunks: preparedSetup.chunks,
    value: encodeRevision(revision, preparedSetup.reference),
    historyKey: setupHistoryKey(nextRevision),
    operationKey: setupOperationKey(revision.operationId),
  });
}

async function prepareCampaignOperationIntent(
  prepared: PreparedCampaignSave,
  input: CampaignOperationIntentInput,
): Promise<PreparedCampaignOperationIntent> {
  const intent = deepFreeze({
    mode: input.mode,
    operationId: prepared.revision.operationId,
    expectedRevision: prepared.expectedRevision,
    resultingRevision: prepared.revision.revision,
    recordedAt: prepared.revision.recordedAt,
    reference: prepared.reference,
    ...(input.mode === "audited"
      ? { actor: input.actor, transition: input.transition }
      : {}),
  }) satisfies CampaignOperationIntent;
  const value = encodeCampaignOperationIntent(intent);
  if (jsonByteLength(value) > CAMPAIGN_OPERATION_INTENT_MAX_RECORD_BYTES) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return Object.freeze({
    intent,
    key: setupOperationIntentKey(intent.operationId),
    transactionOperationId: await setupOperationIntentTransactionId(
      intent.operationId,
    ),
    value,
  });
}

async function hasMatchingCampaignOperationIntent(
  storage: Pick<StorageAdapter, "read">,
  prepared: PreparedCampaignOperationIntent,
): Promise<boolean> {
  const record = await storage.read(prepared.key);
  if (record === null) return false;
  assertMatchingCampaignOperationIntent(record, prepared);
  return true;
}

async function persistCampaignOperationIntent(
  storage: StorageAdapter,
  prepared: PreparedCampaignOperationIntent,
): Promise<void> {
  let result: unknown;
  try {
    result = await storage.transact({
      operationId: prepared.transactionOperationId,
      mutations: [{
        type: "put",
        key: prepared.key,
        expectedRevision: null,
        value: prepared.value,
      }],
    });
  } catch (error) {
    if (
      error instanceof StorageFailure &&
      (error.code === "CONFLICT" ||
        error.code === "PRECONDITION_FAILED" ||
        error.code === "UNAVAILABLE")
    ) {
      let record: StorageRecord | null;
      try {
        record = await storage.read(prepared.key);
      } catch {
        throw new StorageFailure("UNAVAILABLE");
      }
      if (record !== null) {
        assertMatchingCampaignOperationIntent(record, prepared);
        return;
      }
    }
    throw error instanceof StorageFailure
      ? new StorageFailure(error.code)
      : new StorageFailure("UNAVAILABLE");
  }
  verifyCampaignOperationIntentTransactionResult(result, prepared);
}

function verifyCampaignOperationIntentTransactionResult(
  result: unknown,
  prepared: PreparedCampaignOperationIntent,
): void {
  const transaction = exactStorageTransactionResult(result, 1);
  assertMatchingCampaignOperationIntent(transaction.records[0], prepared);
}

function assertMatchingCampaignOperationIntent(
  record: unknown,
  prepared: PreparedCampaignOperationIntent,
): void {
  const stored = decodeCampaignOperationIntentRecord(record);
  if (JSON.stringify(stored) !== JSON.stringify(prepared.intent)) {
    throw new StorageFailure("CONFLICT");
  }
}

function decodeCampaignOperationIntentRecord(
  value: unknown,
): CampaignOperationIntent {
  const envelope = exactDataObject(value, ["key", "revision", "value"]);
  if (envelope === null || envelope.revision !== 1) {
    throw new StorageFailure("UNAVAILABLE");
  }
  const key = exactDataObject(envelope.key, ["collection", "id"]);
  const intent = decodeCampaignOperationIntent(envelope.value);
  const expectedKey = setupOperationIntentKey(intent.operationId);
  if (
    key === null ||
    key.collection !== expectedKey.collection ||
    key.id !== expectedKey.id ||
    jsonByteLength(encodeCampaignOperationIntent(intent)) >
      CAMPAIGN_OPERATION_INTENT_MAX_RECORD_BYTES
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return intent;
}

function decodeCampaignOperationIntent(value: unknown): CampaignOperationIntent {
  const candidate = exactObject(value);
  const modeDescriptor = candidate === null
    ? undefined
    : Object.getOwnPropertyDescriptor(candidate, "mode");
  const mode = modeDescriptor !== undefined &&
      modeDescriptor.enumerable &&
      "value" in modeDescriptor
    ? modeDescriptor.value
    : null;
  const expectedKeys = mode === "audited"
    ? STORED_AUDITED_OPERATION_INTENT_KEYS
    : mode === "unaudited"
      ? STORED_UNAUDITED_OPERATION_INTENT_KEYS
      : null;
  const source = expectedKeys === null
    ? null
    : exactDataObject(value, [...expectedKeys]);
  if (
    source === null ||
    source.kind !== "campaign-setup-operation-intent" ||
    source.schemaVersion !== CAMPAIGN_SETUP_SCHEMA_VERSION
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  const operationId = parseStorageOperationId(source.operationId);
  const recordedAt = parseTimestamp(source.recordedAt);
  const reference = parseStoredSetupReference(source);
  const expectedRevision = source.expectedRevision;
  const resultingRevision = source.resultingRevision;
  if (
    !operationId.ok ||
    !recordedAt.ok ||
    reference === null ||
    (expectedRevision !== null &&
      (!Number.isSafeInteger(expectedRevision) ||
        (expectedRevision as number) < 1)) ||
    !Number.isSafeInteger(resultingRevision) ||
    parseNextRevision(expectedRevision as number | null) !== resultingRevision
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }

  if (mode === "unaudited") {
    return deepFreeze({
      mode,
      operationId: operationId.value,
      expectedRevision: expectedRevision as number | null,
      resultingRevision: resultingRevision as number,
      recordedAt: recordedAt.value,
      reference,
    });
  }

  const actor = exactDataObject(source.actor, ["type", "subject"]);
  const subject = parseActorSubject(actor?.subject);
  if (
    actor === null ||
    actor.type !== "owner" ||
    !subject.ok ||
    !isCampaignAuditTransition(source.transition)
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return deepFreeze({
    mode,
    operationId: operationId.value,
    expectedRevision: expectedRevision as number | null,
    resultingRevision: resultingRevision as number,
    recordedAt: recordedAt.value,
    reference,
    actor: { type: "owner", subject: subject.value },
    transition: source.transition,
  });
}

function encodeCampaignOperationIntent(
  intent: CampaignOperationIntent,
): StorageDocument {
  return deepFreeze({
    kind: "campaign-setup-operation-intent",
    schemaVersion: CAMPAIGN_SETUP_SCHEMA_VERSION,
    mode: intent.mode,
    operationId: intent.operationId,
    expectedRevision: intent.expectedRevision,
    resultingRevision: intent.resultingRevision,
    recordedAt: intent.recordedAt,
    setupHash: intent.reference.setupHash,
    setupBytes: intent.reference.setupBytes,
    setupChunks: intent.reference.setupChunks,
    ...(intent.mode === "audited"
      ? { actor: intent.actor, transition: intent.transition }
      : {}),
  });
}

type CampaignSaveTransaction = Readonly<{
  result: StorageTransactionResult;
  publicPresentationSchema: PublicPresentationSchema;
}>;

async function transactCampaignSave(
  storage: StorageAdapter,
  prepared: PreparedCampaignSave,
  auditMutation?: StoragePutMutation,
): Promise<CampaignSaveTransaction> {
  try {
    return Object.freeze({
      result: await storage.transact({
        operationId: prepared.revision.operationId,
        mutations: campaignSaveMutations(
          prepared,
          "current",
          auditMutation,
        ),
      }),
      publicPresentationSchema: "current" as const,
    });
  } catch (error) {
    if (!(error instanceof StorageFailure) || error.code !== "CONFLICT") {
      throw error;
    }

    const completedOperation = await storage.read(prepared.operationKey);
    if (completedOperation === null) throw error;
    verifyExactStorageRecord(
      completedOperation,
      prepared.operationKey,
      1,
      prepared.value,
    );

    // Only a previously committed schema-4 request can return this as a replay.
    return Object.freeze({
      result: await storage.transact({
        operationId: prepared.revision.operationId,
        mutations: campaignSaveMutations(
          prepared,
          "legacy",
          auditMutation,
        ),
      }),
      publicPresentationSchema: "legacy" as const,
    });
  }
}

function campaignSaveMutations(
  prepared: PreparedCampaignSave,
  publicPresentationSchema: PublicPresentationSchema,
  auditMutation?: StoragePutMutation,
): readonly StorageMutation[] {
  const mutations: StorageMutation[] = [
    {
      type: "put",
      key: CURRENT_SETUP_KEY,
      expectedRevision: prepared.expectedRevision,
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
    publicPresentationMutation(
      prepared,
      prepared.expectedRevision,
      publicPresentationSchema,
    ),
  ];
  if (auditMutation !== undefined) mutations.push(auditMutation);
  return Object.freeze(mutations);
}

function verifyCampaignSaveTransactionResult(
  result: unknown,
  prepared: PreparedCampaignSave,
  publicPresentationSchema: PublicPresentationSchema = "current",
): CampaignSetupRevision {
  const transaction = exactStorageTransactionResult(result, 4);
  if (
    publicPresentationSchema === "legacy" &&
    transaction.replayed !== true
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  const [currentRecord, historyRecord, operationRecord, publicRecord] =
    campaignSaveRecords(
      transaction.records,
      prepared,
      publicPresentationSchema,
    );
  return verifyCampaignSaveRecords(
    prepared,
    currentRecord,
    historyRecord,
    operationRecord,
    publicRecord,
    publicPresentationSchema,
  );
}

function verifyAuditedCampaignSaveTransactionResult(
  result: unknown,
  prepared: PreparedCampaignSave,
  audit: PreparedAuditAppend,
  publicPresentationSchema: PublicPresentationSchema = "current",
): AuditedCampaignSetupSaveResult {
  const transaction = exactStorageTransactionResult(result, 5);
  if (
    publicPresentationSchema === "legacy" &&
    transaction.replayed !== true
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  const [currentRecord, historyRecord, operationRecord, publicRecord] =
    campaignSaveRecords(
      transaction.records,
      prepared,
      publicPresentationSchema,
    );
  const auditRecord = verifyExactStorageRecord(
    transaction.records[4],
    audit.mutation.key,
    1,
    audit.mutation.value,
  );
  return deepFreeze({
    campaign: verifyCampaignSaveRecords(
      prepared,
      currentRecord,
      historyRecord,
      operationRecord,
      publicRecord,
      publicPresentationSchema,
    ),
    auditEvent: verifyPreparedAuditAppend(audit, auditRecord),
    replayed: transaction.replayed,
  });
}

function campaignSaveRecords(
  records: readonly unknown[],
  prepared: PreparedCampaignSave,
  publicPresentationSchema: PublicPresentationSchema,
): readonly [StorageRecord, StorageRecord, StorageRecord, StorageRecord] {
  return Object.freeze([
    verifyExactStorageRecord(
      records[0],
      CURRENT_SETUP_KEY,
      prepared.revision.revision,
      prepared.value,
    ),
    verifyExactStorageRecord(
      records[1],
      prepared.historyKey,
      1,
      prepared.value,
    ),
    verifyExactStorageRecord(
      records[2],
      prepared.operationKey,
      1,
      prepared.value,
    ),
    verifyExactStorageRecord(
      records[3],
      PUBLIC_PRESENTATION_KEY,
      prepared.revision.revision,
      encodePublicPresentation(
        prepared.revision,
        publicPresentationSchema,
      ),
    ),
  ]);
}

function verifyCampaignSaveRecords(
  prepared: PreparedCampaignSave,
  currentRecord: StorageRecord,
  historyRecord: StorageRecord,
  operationRecord: StorageRecord,
  publicRecord: StorageRecord,
  publicPresentationSchema: PublicPresentationSchema,
): CampaignSetupRevision {
  const current = decodeCurrentRevision(currentRecord);
  const history = decodeHistoryRevision(historyRecord);
  const operation = decodeOperationRevision(operationRecord);
  const expected = decodeRevision(prepared.value);
  const publicProjection = decodePublicPresentation(publicRecord);
  if (
    JSON.stringify(current) !== JSON.stringify(history) ||
    JSON.stringify(current) !== JSON.stringify(operation) ||
    JSON.stringify(current) !== JSON.stringify(expected) ||
    JSON.stringify({
      revision: prepared.revision.revision,
      publicCampaign: prepared.revision.setup.publicCampaign,
      amountAggregate: publicPresentationSchema === "legacy"
        ? null
        : prepared.revision.setup.amountAggregate,
    }) !== JSON.stringify(publicProjection)
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return prepared.revision;
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

async function prepareStoredSetup(
  setup: CampaignSetup,
): Promise<Readonly<{
  reference: StoredSetupReference;
  chunks: readonly PreparedSetupChunk[];
}>> {
  let serialized: string;
  try {
    serialized = JSON.stringify(setup);
  } catch (error) {
    throw new StorageFailure("INVALID_REQUEST", { cause: error });
  }
  const bytes = new TextEncoder().encode(serialized);
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_SERIALIZED_CAMPAIGN_SETUP_BYTES
  ) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  const setupHash = await hashSetupBytes(bytes);
  const setupChunks = Math.ceil(bytes.byteLength / SETUP_CHUNK_RAW_BYTES);
  if (setupChunks < 1 || setupChunks > MAX_SETUP_CHUNKS) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  const reference = deepFreeze({
    setupHash,
    setupBytes: bytes.byteLength,
    setupChunks,
  });
  const chunks: PreparedSetupChunk[] = [];
  for (let chunkIndex = 0; chunkIndex < setupChunks; chunkIndex += 1) {
    const start = chunkIndex * SETUP_CHUNK_RAW_BYTES;
    const chunk = bytes.slice(
      start,
      Math.min(start + SETUP_CHUNK_RAW_BYTES, bytes.byteLength),
    );
    const value = deepFreeze({
      kind: "campaign-setup-chunk",
      schemaVersion: CAMPAIGN_SETUP_SCHEMA_VERSION,
      setupHash,
      setupBytes: bytes.byteLength,
      chunkIndex,
      chunkCount: setupChunks,
      data: base64UrlEncode(chunk),
    });
    if (jsonByteLength(value) > MAX_SETUP_CHUNK_RECORD_BYTES) {
      throw new StorageFailure("UNAVAILABLE");
    }
    chunks.push(Object.freeze({
      key: setupChunkKey(setupHash, chunkIndex),
      operationId: setupChunkOperationId(setupHash, chunkIndex),
      value,
    }));
  }
  return Object.freeze({ reference, chunks: Object.freeze(chunks) });
}

async function stageSetupChunks(
  storage: StorageAdapter,
  chunks: readonly PreparedSetupChunk[],
): Promise<void> {
  for (const chunk of chunks) {
    let result: unknown;
    try {
      result = await storage.transact({
        operationId: chunk.operationId,
        mutations: [{
          type: "put",
          key: chunk.key,
          expectedRevision: null,
          value: chunk.value,
        }],
      });
    } catch (error) {
      if (
        error instanceof StorageFailure &&
        (error.code === "CONFLICT" ||
          error.code === "PRECONDITION_FAILED" ||
          error.code === "UNAVAILABLE")
      ) {
        let record: StorageRecord | null;
        try {
          record = await storage.read(chunk.key);
        } catch {
          throw new StorageFailure("UNAVAILABLE");
        }
        if (record !== null) {
          verifyPreparedSetupChunk(record, chunk);
          continue;
        }
      }
      throw error instanceof StorageFailure
        ? new StorageFailure(error.code)
        : new StorageFailure("UNAVAILABLE");
    }
    verifyPreparedSetupChunkTransactionResult(result, chunk);
  }
}

function verifyPreparedSetupChunkTransactionResult(
  result: unknown,
  chunk: PreparedSetupChunk,
): void {
  const transaction = exactStorageTransactionResult(result, 1);
  verifyPreparedSetupChunk(transaction.records[0], chunk);
}

function verifyPreparedSetupChunk(
  record: unknown,
  chunk: PreparedSetupChunk,
): void {
  const envelope = exactDataObject(record, ["key", "revision", "value"]);
  const key = envelope === null
    ? null
    : exactDataObject(envelope.key, ["collection", "id"]);
  if (
    envelope === null ||
    key === null ||
    key.collection !== chunk.key.collection ||
    key.id !== chunk.key.id ||
    envelope.revision !== 1 ||
    !exactJsonDataEqual(envelope.value, chunk.value) ||
    jsonByteLength(envelope.value) > MAX_SETUP_CHUNK_RECORD_BYTES
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
}

function encodeRevision(
  revision: CampaignSetupRevision,
  reference: StoredSetupReference,
): StorageDocument {
  return deepFreeze({
    kind: "campaign-setup-revision",
    schemaVersion: CAMPAIGN_SETUP_SCHEMA_VERSION,
    revision: revision.revision,
    recordedAt: revision.recordedAt,
    operationId: revision.operationId,
    setupHash: reference.setupHash,
    setupBytes: reference.setupBytes,
    setupChunks: reference.setupChunks,
  });
}

function decodeCurrentRevision(record: StorageRecord): StoredCampaignSetupRevision {
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

function decodeHistoryRevision(record: StorageRecord): StoredCampaignSetupRevision {
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

function decodeOperationRevision(record: StorageRecord): StoredCampaignSetupRevision {
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
  schema: PublicPresentationSchema,
) {
  return Object.freeze({
    type: "put" as const,
    key: PUBLIC_PRESENTATION_KEY,
    expectedRevision,
    value: encodePublicPresentation(prepared.revision, schema),
  });
}

function encodePublicPresentation(
  revision: CampaignSetupRevision,
  schema: PublicPresentationSchema,
): StorageDocument {
  if (schema === "legacy") {
    return deepFreeze({
      kind: "campaign-public-presentation",
      schemaVersion: LEGACY_PUBLIC_PRESENTATION_SCHEMA_VERSION,
      revision: revision.revision,
      publicCampaign: revision.setup.publicCampaign,
    });
  }
  return deepFreeze({
    kind: "campaign-public-presentation",
    schemaVersion: PUBLIC_PRESENTATION_SCHEMA_VERSION,
    revision: revision.revision,
    publicCampaign: revision.setup.publicCampaign,
    amountAggregate: revision.setup.amountAggregate,
  });
}

function decodePublicPresentation(
  record: StorageRecord,
): PublishedCampaignProjection {
  const source = recordValue(record.value);
  const schemaVersion = source?.schemaVersion;
  const expectedKeys = schemaVersion === LEGACY_PUBLIC_PRESENTATION_SCHEMA_VERSION
    ? LEGACY_PUBLIC_PRESENTATION_KEYS
    : schemaVersion === PUBLIC_PRESENTATION_SCHEMA_VERSION
    ? PUBLIC_PRESENTATION_KEYS
    : null;
  if (
    source === null ||
    expectedKeys === null ||
    !hasExactKeys(source, expectedKeys) ||
    source.kind !== "campaign-public-presentation" ||
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
  let amountAggregate: AmountAggregateConfiguration | null = null;
  if (schemaVersion === PUBLIC_PRESENTATION_SCHEMA_VERSION) {
    const parsed = parseAmountAggregateConfiguration(source.amountAggregate);
    if (!parsed.ok) throw new StorageFailure("UNAVAILABLE");
    amountAggregate = parsed.value;
  }
  return deepFreeze({
    revision: source.revision as number,
    publicCampaign: campaign,
    amountAggregate,
  });
}

function decodeRevision(value: StorageDocument): StoredCampaignSetupRevision {
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
  const reference = parseStoredSetupReference(source);
  if (!recordedAt.ok || !operationId.ok || reference === null) {
    throw new StorageFailure("UNAVAILABLE");
  }

  return deepFreeze({
    revision: source.revision as number,
    recordedAt: recordedAt.value,
    operationId: operationId.value,
    reference,
  });
}

function parseStoredSetupReference(
  source: Readonly<Record<string, unknown>>,
): StoredSetupReference | null {
  if (
    typeof source.setupHash !== "string" ||
    !SETUP_HASH_PATTERN.test(source.setupHash) ||
    !Number.isSafeInteger(source.setupBytes) ||
    (source.setupBytes as number) < 1 ||
    (source.setupBytes as number) > MAX_SERIALIZED_CAMPAIGN_SETUP_BYTES ||
    !Number.isSafeInteger(source.setupChunks) ||
    (source.setupChunks as number) !== Math.ceil(
      (source.setupBytes as number) / SETUP_CHUNK_RAW_BYTES,
    ) ||
    (source.setupChunks as number) < 1 ||
    (source.setupChunks as number) > MAX_SETUP_CHUNKS
  ) {
    return null;
  }
  return deepFreeze({
    setupHash: source.setupHash,
    setupBytes: source.setupBytes as number,
    setupChunks: source.setupChunks as number,
  });
}

async function materializeRevision(
  storage: Pick<StorageAdapter, "read">,
  stored: StoredCampaignSetupRevision,
): Promise<CampaignSetupRevision> {
  const setup = await readStoredSetup(storage, stored.reference);
  return deepFreeze({
    revision: stored.revision,
    recordedAt: stored.recordedAt,
    operationId: stored.operationId,
    setup,
  });
}

async function readStoredSetup(
  storage: Pick<StorageAdapter, "read">,
  reference: StoredSetupReference,
): Promise<CampaignSetup> {
  const parts = await Promise.all(
    Array.from({ length: reference.setupChunks }, async (_, chunkIndex) => {
      const record = await storage.read(setupChunkKey(reference.setupHash, chunkIndex));
      if (record === null) throw new StorageFailure("UNAVAILABLE");
      return decodeSetupChunk(record, reference, chunkIndex);
    }),
  );
  const bytes = new Uint8Array(reference.setupBytes);
  let offset = 0;
  for (const part of parts) {
    if (offset + part.byteLength > bytes.byteLength) {
      throw new StorageFailure("UNAVAILABLE");
    }
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  if (offset !== bytes.byteLength || await hashSetupBytes(bytes) !== reference.setupHash) {
    throw new StorageFailure("UNAVAILABLE");
  }

  let serialized: string;
  let candidate: unknown;
  try {
    serialized = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    candidate = JSON.parse(serialized);
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
  const setup = parseCampaignSetup(candidate);
  if (!setup.ok || JSON.stringify(setup.value) !== serialized) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return setup.value;
}

function decodeSetupChunk(
  record: StorageRecord,
  reference: StoredSetupReference,
  chunkIndex: number,
): Uint8Array {
  const source = recordValue(record.value);
  const expectedKey = setupChunkKey(reference.setupHash, chunkIndex);
  if (
    source === null ||
    !hasExactKeys(source, STORED_SETUP_CHUNK_KEYS) ||
    source.kind !== "campaign-setup-chunk" ||
    source.schemaVersion !== CAMPAIGN_SETUP_SCHEMA_VERSION ||
    source.setupHash !== reference.setupHash ||
    source.setupBytes !== reference.setupBytes ||
    source.chunkIndex !== chunkIndex ||
    source.chunkCount !== reference.setupChunks ||
    typeof source.data !== "string" ||
    record.key.collection !== expectedKey.collection ||
    record.key.id !== expectedKey.id ||
    record.revision !== 1 ||
    jsonByteLength(record.value) > MAX_SETUP_CHUNK_RECORD_BYTES
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  const bytes = base64UrlDecode(source.data);
  const expectedBytes = chunkIndex === reference.setupChunks - 1
    ? reference.setupBytes - chunkIndex * SETUP_CHUNK_RAW_BYTES
    : SETUP_CHUNK_RAW_BYTES;
  if (bytes.byteLength !== expectedBytes) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return bytes;
}

async function hashSetupBytes(bytes: Uint8Array): Promise<string> {
  let digest: ArrayBuffer;
  try {
    const input = new Uint8Array(bytes.byteLength);
    input.set(bytes);
    digest = await crypto.subtle.digest("SHA-256", input);
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function setupChunkKey(setupHash: string, chunkIndex: number): StorageKey {
  return storageKey(
    SETUP_CHUNK_COLLECTION,
    `campaign-setup-chunk:${setupHash.slice("sha256:".length)}:${chunkSuffix(chunkIndex)}`,
  );
}

function setupChunkOperationId(
  setupHash: string,
  chunkIndex: number,
): StorageOperationId {
  const parsed = parseStorageOperationId(
    `campaign-chunk-stage:${setupHash.slice("sha256:".length)}:${chunkSuffix(chunkIndex)}`,
  );
  if (!parsed.ok) throw new StorageFailure("UNAVAILABLE");
  return parsed.value;
}

function chunkSuffix(chunkIndex: number): string {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= MAX_SETUP_CHUNKS) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return String(chunkIndex).padStart(4, "0");
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new StorageFailure("UNAVAILABLE");
  }
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/") +
    "=".repeat((4 - value.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64UrlEncode(bytes) !== value) throw new StorageFailure("UNAVAILABLE");
  return bytes;
}

function jsonByteLength(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
  return new TextEncoder().encode(serialized).byteLength;
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

function setupOperationIntentKey(operationId: StorageOperationId): StorageKey {
  return storageKey(OPERATION_INTENT_COLLECTION, operationId);
}

async function setupOperationIntentTransactionId(
  operationId: StorageOperationId,
): Promise<StorageOperationId> {
  const digest = await hashSetupBytes(
    new TextEncoder().encode(`campaign-operation-intent:${operationId}`),
  );
  const parsed = parseStorageOperationId(
    `campaign-intent-claim:${digest.slice("sha256:".length)}`,
  );
  if (!parsed.ok) throw new StorageFailure("UNAVAILABLE");
  return parsed.value;
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

function exactObject(value: unknown): Record<PropertyKey, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null
      ? value as Record<PropertyKey, unknown>
      : null;
  } catch {
    return null;
  }
}

function exactDataObject(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    const source = exactObject(value);
    if (source === null) return null;
    const keys = Reflect.ownKeys(source);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) =>
        typeof key !== "string" || !expectedKeys.includes(key)
      )
    ) {
      return null;
    }
    const result: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        return null;
      }
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch {
    return null;
  }
}

function exactStorageTransactionResult(
  value: unknown,
  expectedRecords: number,
): Readonly<{ replayed: boolean; records: readonly unknown[] }> {
  const source = exactDataObject(value, ["replayed", "records"]);
  const records = source === null
    ? null
    : exactArrayValues(source.records, expectedRecords);
  if (
    source === null ||
    typeof source.replayed !== "boolean" ||
    records === null
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return Object.freeze({ replayed: source.replayed, records });
}

function exactArrayValues(
  value: unknown,
  expectedLength: number,
): readonly unknown[] | null {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) return null;
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (
      length === undefined ||
      length.enumerable ||
      !("value" in length) ||
      length.value !== expectedLength
    ) return null;
    const keys = Reflect.ownKeys(value);
    const expectedKeys = [
      ...Array.from({ length: expectedLength }, (_, index) => String(index)),
      "length",
    ];
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) =>
        typeof key !== "string" || !expectedKeys.includes(key)
      )
    ) return null;
    const values: unknown[] = [];
    for (let index = 0; index < expectedLength; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) return null;
      values.push(descriptor.value);
    }
    return Object.freeze(values);
  } catch {
    return null;
  }
}

function verifyExactStorageRecord(
  value: unknown,
  expectedKey: StorageKey,
  expectedRevision: number,
  expectedValue: StorageDocument,
): StorageRecord {
  const envelope = exactDataObject(value, ["key", "revision", "value"]);
  const key = envelope === null
    ? null
    : exactDataObject(envelope.key, ["collection", "id"]);
  if (
    envelope === null ||
    key === null ||
    key.collection !== expectedKey.collection ||
    key.id !== expectedKey.id ||
    envelope.revision !== expectedRevision ||
    !exactJsonDataEqual(envelope.value, expectedValue)
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return Object.freeze({
    key: Object.freeze({ ...expectedKey }),
    revision: expectedRevision,
    value: envelope.value as StorageDocument,
  });
}

function exactJsonDataEqual(actual: unknown, expected: unknown): boolean {
  if (
    actual === null ||
    expected === null ||
    typeof actual !== "object" ||
    typeof expected !== "object"
  ) {
    return Object.is(actual, expected);
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
    const actualValues = exactArrayValues(actual, expected.length);
    return actualValues !== null && actualValues.every((item, index) =>
      exactJsonDataEqual(item, expected[index])
    );
  }
  try {
    const actualPrototype = Object.getPrototypeOf(actual);
    if (actualPrototype !== Object.prototype && actualPrototype !== null) {
      return false;
    }
    const expectedKeys = Object.keys(expected);
    const source = exactDataObject(actual, expectedKeys);
    return source !== null && expectedKeys.every((key) =>
      exactJsonDataEqual(source[key], (expected as Record<string, unknown>)[key])
    );
  } catch {
    return false;
  }
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
