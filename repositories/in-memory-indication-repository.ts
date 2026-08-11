import {
  parseAmountAggregateConfiguration,
  type AmountConfiguration,
} from "../domain/amount-aggregate-configuration.ts";
import {
  DomainError,
  parseActorSubject,
  parseStableId,
  parseTimestamp,
  type ActorSubject,
  type Timestamp,
  type ValidationResult,
} from "../domain/foundation.ts";
import {
  activeIndicationUniquenessKey,
  createInvestmentIndication,
  editInvestmentIndication,
  MAX_INVESTMENT_INDICATION_REVISIONS,
  parseInvestmentIndicationFields,
  reactivateInvestmentIndication,
  rejectInvestmentIndication,
  withdrawInvestmentIndication,
  type ActiveIndicationUniquenessKey,
  type ActiveInvestmentIndication,
  type CompanyInvestmentIndicationFields,
  type InvestmentIndication,
  type InvestmentIndicationFields,
  type InvestmentIndicationHistoryEntry,
  type InvestmentIndicationHistoryEntryId,
  type InvestmentIndicationId,
  type InvestmentIndicationParsingOptions,
  type OwnerIndicationActor,
  type ParticipantIndicationActor,
  type RejectedInvestmentIndication,
  type TrustedPackageAcknowledgmentContext,
  type WithdrawnInvestmentIndication,
} from "../domain/investment-indication.ts";
import type {
  PackageAcceptanceRecord,
  PackageContentHash,
  PackageVersion,
} from "../domain/package-content.ts";
import {
  assertStorageListBoundary,
  MAX_STORAGE_TRANSACTION_MUTATIONS,
  StorageFailure,
  parseStorageCollection,
  parseStorageKey,
  parseStorageOperationId,
  type StorageAdapter,
  type StorageCollection,
  type StorageCursor,
  type StorageDocument,
  type StorageKey,
  type StorageMutation,
  type StorageOperationId,
  type StorageRecord,
} from "../domain/storage-adapter.ts";
import type {
  OwnerIndicationModerationListRequest,
  OwnerIndicationReviewCollectionRepository,
  OwnerIndicationReviewPage,
  OwnerIndicationReviewSummary,
} from "../services/owner-indication-moderation.ts";
import {
  MAX_OWNER_INDICATION_REVIEW_CURSOR_LENGTH,
  type OwnerIndicationReviewTokenBoundary,
} from "../services/owner-indication-review-tokens.ts";

export {
  MAX_OWNER_INDICATION_REVIEW_CURSOR_LENGTH,
} from "../services/owner-indication-review-tokens.ts";

const INDICATION_SCHEMA_VERSION = 4;
const CURRENT_INDICATIONS = storageCollection("investment-indications");
const INDICATION_HISTORY = storageCollection("investment-indication-history");
const INDICATION_FIELDS = storageCollection("investment-indication-fields");
const ACTIVE_UNIQUENESS_KEYS = storageCollection(
  "investment-indication-active-keys",
);
const OWNERSHIP_WITNESSES = storageCollection(
  "investment-indication-ownership-witnesses",
);
const OWNERSHIP_WITNESS_SCHEMA_VERSION = 2;
export const MAX_INDICATION_STORAGE_RECORD_BYTES = 65_536;
export const MAX_INDICATION_STORAGE_TRANSACTION_BYTES = 1_048_576;
export const MAX_SERIALIZED_INDICATION_FIELDS_BYTES = 65_536;
export const MAX_INDICATION_CANONICAL_DEPTH = 32;
export const MAX_INDICATION_CANONICAL_NODES = 4_096;
export const MAX_OWNED_INVESTMENT_INDICATIONS = 100;
export const INDICATION_FIELDS_CHUNK_RAW_BYTES = 8_192;
export const MAX_INDICATION_FIELDS_CHUNKS = Math.ceil(
  MAX_SERIALIZED_INDICATION_FIELDS_BYTES / INDICATION_FIELDS_CHUNK_RAW_BYTES,
);
export const MAX_INDICATION_MATERIALIZATION_READS =
  2 + MAX_INVESTMENT_INDICATION_REVISIONS *
    (1 + MAX_INDICATION_FIELDS_CHUNKS);
export const MAX_INDICATION_STORAGE_READS =
  2 + 2 * MAX_INDICATION_MATERIALIZATION_READS;
export const MAX_INDICATION_STORAGE_MUTATIONS =
  5 + MAX_INDICATION_FIELDS_CHUNKS;
export const MAX_OWNER_INDICATION_REVIEW_PAGE_SIZE = 25;
export const MAX_OWNER_INDICATION_REVIEW_ITEM_READS =
  2 + MAX_INDICATION_FIELDS_CHUNKS;
export const MAX_OWNER_INDICATION_REVIEW_PAGE_RECORD_READS =
  MAX_OWNER_INDICATION_REVIEW_PAGE_SIZE *
  MAX_OWNER_INDICATION_REVIEW_ITEM_READS;
const MAX_OWNER_INDICATION_REVIEW_BACKEND_CURSOR_LENGTH = 2_048;

export type OwnerIndicationCurrentProjection = Readonly<{
  indication: InvestmentIndication;
  terminalOperationId: StorageOperationId;
}>;

const CURRENT_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "operationId",
  "operationFingerprint",
  "requestFingerprint",
  "indicationId",
  "participantSubject",
  "revision",
  "fields",
]);
const TRANSITION_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "operationId",
  "operationFingerprint",
  "requestFingerprint",
  "indicationId",
  "participantSubject",
  "historyEntryId",
  "occurredAt",
  "revision",
  "transitionKind",
  "fields",
  "acknowledgment",
  "actor",
  "rejection",
]);
const FIELDS_REFERENCE_KEYS = new Set([
  "revision",
  "hash",
  "bytes",
  "chunks",
]);
const FIELDS_CHUNK_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "indicationId",
  "participantSubject",
  "fieldsRevision",
  "fieldsHash",
  "fieldsBytes",
  "chunkIndex",
  "chunkCount",
  "data",
]);
const PERSONAL_FIELDS_DOCUMENT_KEYS = new Set([
  "kind",
  "residenceCountry",
  "amount",
  "currency",
  "availabilityPeriod",
  "note",
]);
const COMPANY_FIELDS_DOCUMENT_KEYS = new Set([
  "kind",
  "companyName",
  "registrationCountry",
  "companyIdentifier",
  "representativeName",
  "representativeAuthorityDeclared",
  "amount",
  "currency",
  "availabilityPeriod",
  "note",
]);
const STORAGE_RECORD_KEYS = new Set(["key", "revision", "value"]);
const STORAGE_KEY_KEYS = new Set(["collection", "id"]);
const TRANSACTION_RESULT_KEYS = new Set(["replayed", "records"]);
const LEASE_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "indicationId",
  "uniquenessFingerprint",
]);
const OWNER_REVIEW_LIST_REQUEST_KEYS = new Set(["limit"]);
const OWNER_REVIEW_CURSOR_REQUEST_KEYS = new Set(["limit", "cursor"]);
const OWNER_REVIEW_PAGE_KEYS = new Set(["items", "nextCursor"]);
const OWNERSHIP_WITNESS_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "revision",
  "indications",
]);
const OWNERSHIP_ENTRY_DOCUMENT_KEYS = new Set([
  "indicationId",
  "indicationRevision",
  "lifecycleStatus",
]);

export type IndicationMutationResult<
  Indication extends InvestmentIndication = InvestmentIndication,
> = Readonly<{
  revision: number;
  snapshot: Indication;
  replayed: boolean;
}>;

export type ParticipantIndicationOwnershipEntry = Readonly<{
  indicationId: InvestmentIndicationId;
  indicationRevision: number;
  lifecycleStatus: InvestmentIndication["lifecycle"]["status"];
}>;

export type ParticipantIndicationCompletenessWitness = Readonly<{
  record: StorageRecord | null;
  indications: readonly ParticipantIndicationOwnershipEntry[];
}>;

export type ParticipantIndicationOwnershipHead = Readonly<{
  indicationId: InvestmentIndicationId;
  indicationRevision: number;
  lifecycleStatus: InvestmentIndication["lifecycle"]["status"];
}>;

type IndicationMutationRequest = Readonly<{
  operationId: unknown;
  id: unknown;
  occurredAt: unknown;
  historyEntryId: unknown;
}>;

export type CreateIndicationRequest = IndicationMutationRequest &
  Readonly<{
    expectedRevision: null;
    fields: unknown;
  }>;

export type EditIndicationRequest = IndicationMutationRequest &
  Readonly<{
    expectedRevision: number;
    fields: unknown;
  }>;

export type WithdrawIndicationRequest = IndicationMutationRequest &
  Readonly<{ expectedRevision: number }>;

export type ReactivateIndicationRequest = IndicationMutationRequest &
  Readonly<{ expectedRevision: number }>;

export type RejectIndicationRequest = IndicationMutationRequest &
  Readonly<{
    expectedRevision: number;
    reason: unknown;
  }>;

export type ParticipantIndicationMutationKind =
  | "create"
  | "edit"
  | "withdraw"
  | "reactivate";

export type ParticipantIndicationMutationRequest =
  | CreateIndicationRequest
  | EditIndicationRequest
  | WithdrawIndicationRequest
  | ReactivateIndicationRequest;

/** Closed descriptor shared with the atomic participant mutation coordinator. */
export type PreparedParticipantIndicationMutation = Readonly<{
  kind: ParticipantIndicationMutationKind;
  participantSubject: ActorSubject;
  operationId: StorageOperationId;
  id: InvestmentIndicationId;
  occurredAt: Timestamp;
  expectedRevision: number | null;
  resultingRevision: number;
  requestFingerprint: string;
  fingerprint: string;
}>;

/** Config-independent descriptor used to verify an immutable exact retry. */
export type PreparedParticipantIndicationReplay = Omit<
  PreparedParticipantIndicationMutation,
  "fingerprint"
>;

/**
 * Validate the stable mutation envelope and fingerprint the exact submitted
 * request without applying deployment amount or normalization policy.
 */
export async function prepareParticipantIndicationReplay(
  kind: ParticipantIndicationMutationKind,
  participantSubject: unknown,
  request: ParticipantIndicationMutationRequest,
): Promise<PreparedParticipantIndicationReplay> {
  if (
    kind !== "create" &&
    kind !== "edit" &&
    kind !== "withdraw" &&
    kind !== "reactivate"
  ) invalidRequest();
  const subject = requiredActorSubject(participantSubject);
  const expectedRevision = kind === "create"
    ? null
    : requiredExpectedRevision(request.expectedRevision);
  const envelope = parseMutationEnvelope(request, expectedRevision);
  const actor = Object.freeze({
    type: "participant" as const,
    subject,
  });
  return Object.freeze({
    kind,
    participantSubject: subject,
    operationId: envelope.operationId,
    id: envelope.id,
    occurredAt: envelope.occurredAt,
    expectedRevision,
    resultingRevision: nextRevision(expectedRevision),
    requestFingerprint: await exactRequestFingerprint(kind, actor, envelope),
  });
}

/** Subject-bound persistence contract for participant and configured-owner use. */
export interface IndicationRepository {
  create(
    request: CreateIndicationRequest,
    acknowledgmentContext: TrustedPackageAcknowledgmentContext,
  ): Promise<IndicationMutationResult<ActiveInvestmentIndication>>;
  get(id: InvestmentIndicationId): Promise<InvestmentIndication | null>;
  edit(
    request: EditIndicationRequest,
    acknowledgmentContext: TrustedPackageAcknowledgmentContext,
  ): Promise<IndicationMutationResult<ActiveInvestmentIndication>>;
  withdraw(
    request: WithdrawIndicationRequest,
  ): Promise<IndicationMutationResult<WithdrawnInvestmentIndication>>;
  reactivate(
    request: ReactivateIndicationRequest,
    acknowledgmentContext: TrustedPackageAcknowledgmentContext,
  ): Promise<IndicationMutationResult<ActiveInvestmentIndication>>;
  reject(
    request: RejectIndicationRequest,
  ): Promise<IndicationMutationResult<RejectedInvestmentIndication>>;
}

/** Validate and fingerprint one participant mutation without touching storage. */
export async function prepareParticipantIndicationMutation(
  kind: ParticipantIndicationMutationKind,
  participantSubject: unknown,
  request: ParticipantIndicationMutationRequest,
  amountConfiguration: AmountConfiguration,
  parsingOptions: InvestmentIndicationParsingOptions = {},
): Promise<PreparedParticipantIndicationMutation> {
  const replay = await prepareParticipantIndicationReplay(
    kind,
    participantSubject,
    request,
  );
  const subject = replay.participantSubject;
  const amount = requiredAmountConfiguration(amountConfiguration);
  const options = Object.freeze({ ...parsingOptions });
  const parsed = kind === "create"
    ? parseCreateRequest(request as CreateIndicationRequest, amount, options)
    : kind === "edit"
    ? parseEditRequest(request as EditIndicationRequest, amount, options)
    : parseTransitionRequest(
        request as WithdrawIndicationRequest | ReactivateIndicationRequest,
      );
  const actor = Object.freeze({
    type: "participant" as const,
    subject,
  });
  return Object.freeze({
    ...replay,
    fingerprint: await operationFingerprint(
      kind,
      actor,
      parsed,
      replay.requestFingerprint,
    ),
  });
}

type MutationKind =
  | "create"
  | "edit"
  | "withdraw"
  | "reactivate"
  | "reject";

type ParsedMutationRequest = Readonly<{
  operationId: StorageOperationId;
  id: InvestmentIndicationId;
  occurredAt: Timestamp;
  historyEntryId: InvestmentIndicationHistoryEntryId;
  expectedRevision: number | null;
  fields?: InvestmentIndicationFields;
  reason?: string;
}>;

type ParsedMutationEnvelope = Omit<
  ParsedMutationRequest,
  "fields" | "reason"
> & Readonly<{
  fields?: unknown;
  reason?: unknown;
}>;

type StoredFieldsReference = Readonly<{
  revision: number;
  hash: string;
  bytes: number;
  chunks: number;
}>;

type PreparedFieldsChunk = Readonly<{
  key: StorageKey;
  value: StorageDocument;
}>;

type StoredFields = Readonly<{
  reference: StoredFieldsReference;
  fields: InvestmentIndicationFields;
  chunks: readonly PreparedFieldsChunk[];
}>;

type StoredTransition = Readonly<{
  operationId: StorageOperationId;
  operationFingerprint: string;
  requestFingerprint: string;
  indicationId: InvestmentIndicationId;
  participantSubject: ActorSubject;
  historyEntryId: InvestmentIndicationHistoryEntryId;
  occurredAt: Timestamp;
  revision: number;
  transitionKind: InvestmentIndicationHistoryEntry["transition"];
  fields: StoredFieldsReference;
  document: StorageDocument;
}>;

type StoredCurrent = Readonly<{
  operationId: StorageOperationId;
  operationFingerprint: string;
  requestFingerprint: string;
  indicationId: InvestmentIndicationId;
  participantSubject: ActorSubject;
  revision: number;
  fields: StoredFieldsReference;
  document: StorageDocument;
  record: StorageRecord;
}>;

type MaterializedIndication = Readonly<{
  indication: InvestmentIndication;
  terminal: StoredTransition;
  fieldsByRevision: ReadonlyMap<number, StoredFields>;
}>;

type PreparedSnapshotMutation = Readonly<{
  indication: InvestmentIndication;
  currentDocument: StorageDocument;
  transitionDocument: StorageDocument;
  fieldsChunks: readonly PreparedFieldsChunk[];
}>;

type ActiveLease = Readonly<{
  uniquenessKey: ActiveIndicationUniquenessKey;
  key: StorageKey;
  fingerprint: string;
  document: StorageDocument;
}>;

/** Read the bounded subject-owned ID witness used to prove index completeness. */
export async function readParticipantIndicationCompletenessWitness(
  storage: Pick<StorageAdapter, "read">,
  participantSubject: ActorSubject,
): Promise<ParticipantIndicationCompletenessWitness> {
  const subject = requiredActorSubject(participantSubject);
  const key = await ownershipWitnessKey(subject);
  const record = await storage.read(key);
  if (record === null) {
    return Object.freeze({
      record: null,
      indications: Object.freeze([]),
    });
  }
  const source = exactStoredDocument(
    record,
    key,
    OWNERSHIP_WITNESS_DOCUMENT_KEYS,
    "investment-indication-ownership-witness",
    OWNERSHIP_WITNESS_SCHEMA_VERSION,
  );
  if (
    source.schemaVersion !== OWNERSHIP_WITNESS_SCHEMA_VERSION ||
    !Number.isSafeInteger(source.revision) ||
    (source.revision as number) < 1 ||
    source.revision !== record.revision
  ) unavailable();
  const values = exactDenseArray(
    source.indications,
    MAX_OWNED_INVESTMENT_INDICATIONS,
  );
  const indications: ParticipantIndicationOwnershipEntry[] = [];
  for (const value of values) {
    const entry = exactRecord(value, OWNERSHIP_ENTRY_DOCUMENT_KEYS);
    const parsed = parseStableId<"investment-indication">(entry.indicationId);
    if (
      !parsed.ok ||
      indications.some((candidate) =>
        candidate.indicationId === parsed.value
      ) ||
      !Number.isSafeInteger(entry.indicationRevision) ||
      (entry.indicationRevision as number) < 1 ||
      (entry.indicationRevision as number) > MAX_INVESTMENT_INDICATION_REVISIONS ||
      !isInvestmentIndicationLifecycleStatus(entry.lifecycleStatus)
    ) unavailable();
    indications.push(Object.freeze({
      indicationId: parsed.value,
      indicationRevision: entry.indicationRevision as number,
      lifecycleStatus: entry.lifecycleStatus,
    }));
  }
  if (
    !sameStrings(
      indications.map(({ indicationId }) => indicationId),
      indications.map(({ indicationId }) => indicationId).sort(compareStrings),
    )
  ) {
    unavailable();
  }
  return Object.freeze({
    record: Object.freeze({
      key,
      revision: record.revision,
      value: source as StorageDocument,
    }),
    indications: Object.freeze(indications),
  });
}

/** Read the exact current and terminal ownership heads without replaying ancestry. */
export async function readParticipantIndicationOwnershipHead(
  storage: Pick<StorageAdapter, "read">,
  participantSubject: ActorSubject,
  id: InvestmentIndicationId,
): Promise<ParticipantIndicationOwnershipHead | null> {
  const subject = requiredActorSubject(participantSubject);
  const indicationId = requiredIndicationId(id);
  const key = await currentIndicationKey(indicationId);
  const record = await storage.read(key);
  if (record === null) return null;
  if (peekParticipantSubject(record) !== subject) return null;
  const current = decodeStoredCurrent(record, key, indicationId, subject);
  const transitionKey = await indicationHistoryKey(
    indicationId,
    current.revision,
  );
  const transitionRecord = await storage.read(transitionKey);
  if (transitionRecord === null) unavailable();
  const transition = decodeStoredTransition(
    transitionRecord,
    transitionKey,
    subject,
    indicationId,
    current.revision,
  );
  if (
    transition.operationId !== current.operationId ||
    transition.operationFingerprint !== current.operationFingerprint ||
    transition.requestFingerprint !== current.requestFingerprint ||
    canonicalJson(transition.fields) !== canonicalJson(current.fields) ||
    (current.revision === 1) !== (transition.transitionKind === "created")
  ) unavailable();
  const lifecycleStatus = lifecycleStatusForTransition(transition.transitionKind);
  await verifyOwnershipTransition(transition, lifecycleStatus);
  return Object.freeze({
    indicationId: current.indicationId,
    indicationRevision: current.revision,
    lifecycleStatus,
  });
}

/**
 * Subject-bound storage repository with bounded metadata, immutable transitions,
 * and chunked field payloads. It retains no process-local records.
 */
export class DevelopmentInMemoryIndicationRepository
  implements IndicationRepository
{
  readonly storageKind = "storage-adapter" as const;

  readonly #storage: StorageAdapter;
  readonly #authenticatedSubject: ActorSubject | null;
  readonly #configuredOwnerSubject: ActorSubject | null;
  readonly #amountConfiguration: AmountConfiguration;
  readonly #parsingOptions: InvestmentIndicationParsingOptions;

  constructor(
    storage: StorageAdapter,
    authenticatedSubject: ActorSubject | null,
    configuredOwnerSubject: ActorSubject | null,
    amountConfiguration: AmountConfiguration,
    parsingOptions: InvestmentIndicationParsingOptions = {},
  ) {
    this.#storage = storage;
    this.#authenticatedSubject = authenticatedSubject === null
      ? null
      : requiredActorSubject(authenticatedSubject);
    this.#configuredOwnerSubject = configuredOwnerSubject === null
      ? null
      : requiredActorSubject(configuredOwnerSubject);
    this.#amountConfiguration = requiredAmountConfiguration(amountConfiguration);
    this.#parsingOptions = Object.freeze({ ...parsingOptions });
  }

  async create(
    request: CreateIndicationRequest,
    acknowledgmentContext: TrustedPackageAcknowledgmentContext,
  ): Promise<IndicationMutationResult<ActiveInvestmentIndication>> {
    const actor = this.#requiredParticipantActor();
    const envelope = parseMutationEnvelope(request, null);
    const replay = await this.#replayIfKnown("create", actor, envelope);
    if (replay !== null) return activeResult(replay);
    const parsed = parseCreateRequest(
      request,
      this.#amountConfiguration,
      this.#parsingOptions,
    );
    const requestFingerprint = await exactRequestFingerprint(
      "create",
      actor,
      envelope,
    );
    const fingerprint = await operationFingerprint(
      "create",
      actor,
      parsed,
      requestFingerprint,
    );

    const created = domainMutation(() =>
      createInvestmentIndication(
        {
          id: parsed.id,
          occurredAt: parsed.occurredAt,
          historyEntryId: parsed.historyEntryId,
          fields: domainFieldsInput(parsed.fields),
        },
        actor,
        this.#amountConfiguration,
        acknowledgmentContext,
        this.#parsingOptions,
      ),
    );

    return activeResult(
      await this.#writeSnapshot(
        created,
        null,
        parsed,
        fingerprint,
        requestFingerprint,
      ),
    );
  }

  async get(id: InvestmentIndicationId): Promise<InvestmentIndication | null> {
    const subject = this.#authenticatedSubject;
    if (subject === null) return null;
    return this.#readCurrent(
      requiredIndicationId(id),
      subject === this.#configuredOwnerSubject ? "owner" : "participant",
      subject,
    ).then((stored) => stored?.indication ?? null);
  }

  /** Resolve one owner-authenticated current-record key without listing. */
  async getOwnerProjectionByCurrentKey(
    value: unknown,
  ): Promise<OwnerIndicationCurrentProjection | null> {
    const actor = this.#requiredOwnerActor();
    const key = requiredCurrentIndicationStorageKey(value);
    const record = await this.#storage.read(key);
    if (record === null) return null;
    const source = exactRecord(record.value, CURRENT_DOCUMENT_KEYS);
    const id = storedIndicationId(source.indicationId);
    const expectedKey = await currentIndicationKey(id);
    if (
      key.collection !== expectedKey.collection ||
      key.id !== expectedKey.id
    ) unavailable();
    const materialized = await this.#materializeCurrent(
      record,
      key,
      id,
      null,
      actor.subject,
    );
    return Object.freeze({
      indication: materialized.indication,
      terminalOperationId: materialized.terminal.operationId,
    });
  }

  /** Reopen one immutable operation result without projecting a later head. */
  async readPreparedParticipantMutation(
    prepared: PreparedParticipantIndicationReplay,
  ): Promise<IndicationMutationResult | null> {
    const subject = this.#authenticatedSubject;
    if (
      subject === null ||
      subject === this.#configuredOwnerSubject ||
      prepared.participantSubject !== subject ||
      prepared.resultingRevision !== nextRevision(prepared.expectedRevision) ||
      !isSha256(prepared.requestFingerprint)
    ) {
      return null;
    }
    const key = await indicationHistoryKey(
      prepared.id,
      prepared.resultingRevision,
    );
    const record = await this.#storage.read(key);
    if (record === null) return null;
    const transition = decodeStoredTransition(
      record,
      key,
      subject,
      prepared.id,
      prepared.resultingRevision,
    );
    if (
      transition.operationId !== prepared.operationId ||
      transition.requestFingerprint !== prepared.requestFingerprint ||
      transition.occurredAt !== prepared.occurredAt
    ) {
      throw new StorageFailure("CONFLICT");
    }
    const materialized = await materializeIndication(
      this.#storage,
      subject,
      prepared.id,
      prepared.resultingRevision,
      transition,
    );
    return mutationResult(materialized.indication, true);
  }

  /** Read one current collection item through its bounded immutable ancestry. */
  async readCurrentParticipantProjection(
    id: InvestmentIndicationId,
  ): Promise<InvestmentIndication | null> {
    const subject = this.#authenticatedSubject;
    if (subject === null || subject === this.#configuredOwnerSubject) return null;
    const stored = await this.#readCurrent(
      requiredIndicationId(id),
      "participant",
      subject,
    );
    return stored?.indication ?? null;
  }

  async edit(
    request: EditIndicationRequest,
    acknowledgmentContext: TrustedPackageAcknowledgmentContext,
  ): Promise<IndicationMutationResult<ActiveInvestmentIndication>> {
    const actor = this.#requiredParticipantActor();
    const envelope = parseMutationEnvelope(
      request,
      requiredExpectedRevision(request.expectedRevision),
    );
    const replay = await this.#replayIfKnown("edit", actor, envelope);
    if (replay !== null) return activeResult(replay);
    const parsed = parseEditRequest(
      request,
      this.#amountConfiguration,
      this.#parsingOptions,
    );
    const requestFingerprint = await exactRequestFingerprint(
      "edit",
      actor,
      envelope,
    );
    const fingerprint = await operationFingerprint(
      "edit",
      actor,
      parsed,
      requestFingerprint,
    );

    const current = await this.#readCurrent(
      parsed.id,
      "participant",
      actor.subject,
    );
    if (current === null) notFound();
    requireCurrentRevision(current.indication, parsed.expectedRevision);
    const edited = domainMutation(() =>
      editInvestmentIndication(
        current.indication,
        {
          occurredAt: parsed.occurredAt,
          historyEntryId: parsed.historyEntryId,
          fields: domainFieldsInput(parsed.fields),
        },
        actor,
        this.#amountConfiguration,
        acknowledgmentContext,
        this.#parsingOptions,
      ),
    );

    return activeResult(
      await this.#writeSnapshot(
        edited,
        current,
        parsed,
        fingerprint,
        requestFingerprint,
      ),
    );
  }

  async withdraw(
    request: WithdrawIndicationRequest,
  ): Promise<IndicationMutationResult<WithdrawnInvestmentIndication>> {
    const actor = this.#requiredParticipantActor();
    const envelope = parseMutationEnvelope(
      request,
      requiredExpectedRevision(request.expectedRevision),
    );
    const replay = await this.#replayIfKnown("withdraw", actor, envelope);
    if (replay !== null) return withdrawnResult(replay);
    const parsed = parseTransitionRequest(request);
    const requestFingerprint = await exactRequestFingerprint(
      "withdraw",
      actor,
      envelope,
    );
    const fingerprint = await operationFingerprint(
      "withdraw",
      actor,
      parsed,
      requestFingerprint,
    );

    const current = await this.#readCurrent(
      parsed.id,
      "participant",
      actor.subject,
    );
    if (current === null) notFound();
    requireCurrentRevision(current.indication, parsed.expectedRevision);
    const withdrawn = domainMutation(() =>
      withdrawInvestmentIndication(
        current.indication,
        {
          occurredAt: parsed.occurredAt,
          historyEntryId: parsed.historyEntryId,
        },
        actor,
      ),
    );

    return withdrawnResult(
      await this.#writeSnapshot(
        withdrawn,
        current,
        parsed,
        fingerprint,
        requestFingerprint,
      ),
    );
  }

  async reactivate(
    request: ReactivateIndicationRequest,
    acknowledgmentContext: TrustedPackageAcknowledgmentContext,
  ): Promise<IndicationMutationResult<ActiveInvestmentIndication>> {
    const actor = this.#requiredParticipantActor();
    const envelope = parseMutationEnvelope(
      request,
      requiredExpectedRevision(request.expectedRevision),
    );
    const replay = await this.#replayIfKnown("reactivate", actor, envelope);
    if (replay !== null) return activeResult(replay);
    const parsed = parseTransitionRequest(request);
    const requestFingerprint = await exactRequestFingerprint(
      "reactivate",
      actor,
      envelope,
    );
    const fingerprint = await operationFingerprint(
      "reactivate",
      actor,
      parsed,
      requestFingerprint,
    );

    const current = await this.#readCurrent(
      parsed.id,
      "participant",
      actor.subject,
    );
    if (current === null) notFound();
    requireCurrentRevision(current.indication, parsed.expectedRevision);
    const reactivated = domainMutation(() =>
      reactivateInvestmentIndication(
        current.indication,
        {
          occurredAt: parsed.occurredAt,
          historyEntryId: parsed.historyEntryId,
        },
        actor,
        acknowledgmentContext,
      ),
    );

    return activeResult(
      await this.#writeSnapshot(
        reactivated,
        current,
        parsed,
        fingerprint,
        requestFingerprint,
      ),
    );
  }

  async reject(
    request: RejectIndicationRequest,
  ): Promise<IndicationMutationResult<RejectedInvestmentIndication>> {
    const actor = this.#requiredOwnerActor();
    const envelope = parseMutationEnvelope(
      request,
      requiredExpectedRevision(request.expectedRevision),
    );
    const replay = await this.#replayIfKnown("reject", actor, envelope);
    if (replay !== null) return rejectedResult(replay);
    const parsed = parseRejectRequest(request);
    const requestFingerprint = await exactRequestFingerprint(
      "reject",
      actor,
      envelope,
    );
    const fingerprint = await operationFingerprint(
      "reject",
      actor,
      parsed,
      requestFingerprint,
    );

    const current = await this.#readCurrent(parsed.id, "owner", actor.subject);
    if (current === null) notFound();
    requireCurrentRevision(current.indication, parsed.expectedRevision);
    const rejected = domainMutation(() =>
      rejectInvestmentIndication(
        current.indication,
        {
          occurredAt: parsed.occurredAt,
          historyEntryId: parsed.historyEntryId,
          reason: parsed.reason,
        },
        actor,
      ),
    );

    return rejectedResult(
      await this.#writeSnapshot(
        rejected,
        current,
        parsed,
        fingerprint,
        requestFingerprint,
      ),
    );
  }

  #requiredParticipantActor(): ParticipantIndicationActor {
    if (this.#authenticatedSubject === null) notFound();
    return Object.freeze({
      type: "participant",
      subject: this.#authenticatedSubject,
    });
  }

  #requiredOwnerActor(): OwnerIndicationActor {
    if (
      this.#configuredOwnerSubject === null ||
      this.#authenticatedSubject === null ||
      this.#authenticatedSubject !== this.#configuredOwnerSubject
    ) {
      notFound();
    }
    return Object.freeze({
      type: "owner",
      subject: this.#configuredOwnerSubject,
    });
  }

  async #readCurrent(
    id: InvestmentIndicationId,
    access: "participant" | "owner",
    subject: ActorSubject,
  ): Promise<MaterializedIndication | null> {
    const key = await currentIndicationKey(id);
    const record = await this.#storage.read(key);
    if (record === null) return null;

    if (access === "participant") {
      const storedSubject = peekParticipantSubject(record);
      if (storedSubject !== subject) return null;
    } else if (subject !== this.#configuredOwnerSubject) {
      return null;
    }

    return this.#materializeCurrent(
      record,
      key,
      id,
      access === "participant" ? subject : null,
      subject,
    );
  }

  async #materializeCurrent(
    record: StorageRecord,
    key: StorageKey,
    id: InvestmentIndicationId,
    expectedParticipantSubject: ActorSubject | null,
    authorizedSubject: ActorSubject,
  ): Promise<MaterializedIndication> {
    if (
      expectedParticipantSubject === null &&
      authorizedSubject !== this.#configuredOwnerSubject
    ) unavailable();
    const current = decodeStoredCurrent(
      record,
      key,
      id,
      expectedParticipantSubject,
    );
    const materialized = await materializeIndication(
      this.#storage,
      current.participantSubject,
      id,
      current.revision,
      null,
    );
    if (
      canonicalJson(currentIndicationDocument(
        materialized.indication,
        materialized.terminal.operationId,
        materialized.terminal.operationFingerprint,
        materialized.terminal.requestFingerprint,
        materialized.terminal.fields,
      )) !== canonicalJson(current.document)
    ) {
      unavailable();
    }
    await this.#verifyActiveLease(materialized.indication);
    return materialized;
  }

  async #verifyActiveLease(indication: InvestmentIndication): Promise<void> {
    const lease = await activeLease(indication);
    if (lease === null) return;
    const record = await this.#storage.read(lease.key);
    if (record === null) unavailable();
    verifyLeaseRecord(record, lease, indication.id);
  }

  async #replayIfKnown(
    kind: MutationKind,
    actor: ParticipantIndicationActor | OwnerIndicationActor,
    request: ParsedMutationEnvelope,
  ): Promise<IndicationMutationResult | null> {
    const revision = nextRevision(request.expectedRevision);
    const historyKey = await indicationHistoryKey(request.id, revision);
    const record = await this.#storage.read(historyKey);
    if (record === null) return null;

    if (
      actor.type === "participant" &&
      peekParticipantSubject(record) !== actor.subject
    ) {
      return null;
    }

    const transition = decodeStoredTransition(
      record,
      historyKey,
      actor.type === "participant" ? actor.subject : null,
      request.id,
      revision,
    );
    if (transition.operationId !== request.operationId) {
      throw new StorageFailure(
        request.expectedRevision === null ? "CONFLICT" : "PRECONDITION_FAILED",
      );
    }
    if (mutationKindForTransition(transition.transitionKind) !== kind) {
      throw new StorageFailure("CONFLICT");
    }
    let requestFingerprint: string;
    try {
      requestFingerprint = await exactRequestFingerprint(kind, actor, request);
    } catch {
      throw new StorageFailure("CONFLICT");
    }
    if (requestFingerprint !== transition.requestFingerprint) {
      throw new StorageFailure("CONFLICT");
    }
    const materialized = await materializeIndication(
      this.#storage,
      transition.participantSubject,
      request.id,
      revision,
      transition,
    );
    const current = await this.#readCurrent(
      request.id,
      actor.type === "owner" ? "owner" : "participant",
      actor.subject,
    );
    if (current === null || current.indication.revision < revision) unavailable();
    await requireParticipantOwnershipWitness(
      this.#storage,
      transition.participantSubject,
      request.id,
    );
    return mutationResult(materialized.indication, true);
  }

  async #writeSnapshot(
    indication: InvestmentIndication,
    previous: MaterializedIndication | null,
    request: ParsedMutationRequest,
    fingerprint: string,
    requestFingerprint: string,
  ): Promise<IndicationMutationResult> {
    if (indication.revision !== nextRevision(request.expectedRevision)) {
      unavailable();
    }
    const transition = indication.history.at(-1);
    if (transition === undefined) unavailable();
    const storedFields = transition.transition === "created" ||
        transition.transition === "edited"
      ? await prepareStoredFields(
          indication.participantSubject,
          indication.id,
          indication.revision,
          indication.fields,
        )
      : previous?.fieldsByRevision.get(previous.terminal.fields.revision);
    if (storedFields === undefined) unavailable();
    const prepared = prepareSnapshotMutation(
      indication,
      request.operationId,
      fingerprint,
      requestFingerprint,
      storedFields.reference,
      transition.transition === "created" || transition.transition === "edited"
        ? storedFields.chunks
        : Object.freeze([]),
    );
    const currentKey = await currentIndicationKey(request.id);
    const historyKey = await indicationHistoryKey(
      request.id,
      indication.revision,
    );
    const uniquenessMutations = await activeLeaseMutations(
      previous?.indication ?? null,
      indication,
    );
    const ownershipMutation = await participantOwnershipWitnessMutation(
      this.#storage,
      previous?.indication ?? null,
      indication,
    );
    const mutations: readonly StorageMutation[] = Object.freeze([
      Object.freeze({
        type: "put" as const,
        key: currentKey,
        expectedRevision: request.expectedRevision,
        value: prepared.currentDocument,
      }),
      Object.freeze({
        type: "put" as const,
        key: historyKey,
        expectedRevision: null,
        value: prepared.transitionDocument,
      }),
      ...prepared.fieldsChunks.map((chunk) => Object.freeze({
        type: "put" as const,
        key: chunk.key,
        expectedRevision: null,
        value: chunk.value,
      })),
      ...uniquenessMutations,
      ownershipMutation,
    ]);
    if (
      mutations.length > MAX_STORAGE_TRANSACTION_MUTATIONS ||
      mutations.length > MAX_INDICATION_STORAGE_MUTATIONS
    ) invalidRequest();
    const transaction = Object.freeze({
      operationId: request.operationId,
      mutations,
    });
    if (jsonByteLength(transaction) > MAX_INDICATION_STORAGE_TRANSACTION_BYTES) {
      invalidRequest();
    }
    const result = await this.#storage.transact(transaction);
    verifyMutationResult(result, mutations);
    return mutationResult(prepared.indication, result.replayed);
  }
}

type OwnerIndicationReviewStorage = Pick<StorageAdapter, "list" | "read">;

/** Persistent owner-only summary projection over current indication records. */
export class StorageOwnerIndicationReviewCollectionRepository
  implements OwnerIndicationReviewCollectionRepository
{
  readonly #storage: OwnerIndicationReviewStorage;
  readonly #configuredOwnerSubject: ActorSubject;
  readonly #tokens: OwnerIndicationReviewTokenBoundary;
  readonly #permitted: boolean;

  constructor(
    storage: OwnerIndicationReviewStorage,
    authenticatedSubject: ActorSubject | null,
    configuredOwnerSubject: ActorSubject,
    tokens: OwnerIndicationReviewTokenBoundary,
  ) {
    this.#storage = requiredOwnerIndicationReviewStorage(storage);
    this.#configuredOwnerSubject = requiredActorSubject(configuredOwnerSubject);
    this.#tokens = requiredOwnerIndicationReviewTokenBoundary(tokens);
    const actorSubject = authenticatedSubject === null
      ? null
      : requiredActorSubject(authenticatedSubject);
    this.#permitted = actorSubject === this.#configuredOwnerSubject;
    Object.freeze(this);
  }

  async list(
    request: OwnerIndicationModerationListRequest,
  ): Promise<OwnerIndicationReviewPage> {
    if (!this.#permitted) notFound();

    try {
      const parsed = parseOwnerIndicationReviewListRequest(request);
      const backendCursor = parsed.cursor === undefined
        ? undefined
        : await openOwnerIndicationReviewCursor(
          this.#tokens,
          parsed.cursor,
          this.#configuredOwnerSubject,
          parsed.limit,
        );
      const storageRequest = Object.freeze({
        collection: CURRENT_INDICATIONS,
        limit: parsed.limit,
        ...(backendCursor === undefined ? {} : { cursor: backendCursor }),
      });
      assertStorageListBoundary(storageRequest);
      const page = exactOwnerIndicationReviewStoragePage(
        await this.#storage.list(storageRequest),
        Object.freeze({
          limit: parsed.limit,
          ...(backendCursor === undefined ? {} : { cursor: backendCursor }),
        }),
      );
      const items = await Promise.all(page.items.map((record) =>
        decodeOwnerIndicationReviewSummary(
          this.#storage,
          record,
          this.#tokens,
          this.#configuredOwnerSubject,
        )
      ));
      const nextCursor = page.nextCursor === null
        ? null
        : await sealOwnerIndicationReviewCursor(
          this.#tokens,
          page.nextCursor,
          this.#configuredOwnerSubject,
          parsed.limit,
        );
      return Object.freeze({
        items: Object.freeze(items),
        nextCursor,
      });
    } catch (error) {
      if (
        error instanceof StorageFailure &&
        error.code === "INVALID_REQUEST"
      ) {
        throw new StorageFailure("INVALID_REQUEST");
      }
      throw new StorageFailure("UNAVAILABLE");
    }
  }
}

function parseOwnerIndicationReviewListRequest(
  value: unknown,
): OwnerIndicationModerationListRequest {
  const source = objectRecord(value);
  const hasCursor = source !== null && Object.hasOwn(source, "cursor");
  if (
    source === null ||
    !hasExactKeys(
      source,
      hasCursor
        ? OWNER_REVIEW_CURSOR_REQUEST_KEYS
        : OWNER_REVIEW_LIST_REQUEST_KEYS,
    ) ||
    !Number.isSafeInteger(source.limit) ||
    (source.limit as number) < 1 ||
    (source.limit as number) > MAX_OWNER_INDICATION_REVIEW_PAGE_SIZE
  ) {
    invalidRequest();
  }
  const cursor = hasCursor
    ? requiredOwnerIndicationReviewCursor(source.cursor, invalidRequest)
    : undefined;
  return Object.freeze({
    limit: source.limit as number,
    ...(cursor === undefined ? {} : { cursor }),
  });
}

function exactOwnerIndicationReviewStoragePage(
  value: unknown,
  request: OwnerIndicationModerationListRequest,
): Readonly<{
  items: readonly StorageRecord[];
  nextCursor: StorageCursor | null;
}> {
  const source = exactRecord(value, OWNER_REVIEW_PAGE_KEYS);
  const candidates = exactDenseArray(source.items, request.limit);
  const items = candidates.map(exactOwnerIndicationReviewStorageRecord);
  let priorId: string | null = null;
  for (const item of items) {
    if (
      item.key.collection !== CURRENT_INDICATIONS ||
      (priorId !== null && priorId >= item.key.id)
    ) {
      unavailable();
    }
    priorId = item.key.id;
  }

  const nextCursor = source.nextCursor === null
    ? null
    : requiredOwnerIndicationReviewBackendCursor(
      source.nextCursor,
      unavailable,
    );
  if (
    nextCursor !== null &&
    (items.length === 0 || nextCursor === request.cursor)
  ) {
    unavailable();
  }
  return Object.freeze({ items: Object.freeze(items), nextCursor });
}

function exactOwnerIndicationReviewStorageRecord(value: unknown): StorageRecord {
  const source = exactRecord(value, STORAGE_RECORD_KEYS);
  const keySource = exactRecord(source.key, STORAGE_KEY_KEYS);
  const parsedKey = parseStorageKey(keySource.collection, keySource.id);
  if (
    !parsedKey.ok ||
    !Number.isSafeInteger(source.revision) ||
    (source.revision as number) < 1 ||
    objectRecord(source.value) === null
  ) {
    unavailable();
  }
  return Object.freeze({
    key: Object.freeze({ ...parsedKey.value }),
    revision: source.revision as number,
    value: source.value as StorageDocument,
  });
}

async function decodeOwnerIndicationReviewSummary(
  storage: OwnerIndicationReviewStorage,
  record: StorageRecord,
  tokens: OwnerIndicationReviewTokenBoundary,
  ownerSubject: ActorSubject,
): Promise<OwnerIndicationReviewSummary> {
  const coordinates = storedIndicationCoordinates(record.value);
  const currentKey = await currentIndicationKey(coordinates.id);
  const current = decodeStoredCurrent(
    record,
    currentKey,
    coordinates.id,
    coordinates.subject,
  );
  const terminalKey = await indicationHistoryKey(
    coordinates.id,
    current.revision,
  );
  const terminalRecord = await storage.read(terminalKey);
  if (terminalRecord === null) unavailable();
  const terminal = decodeStoredTransition(
    terminalRecord,
    terminalKey,
    coordinates.subject,
    coordinates.id,
    current.revision,
  );
  requireCurrentMatchesTerminal(current, terminal);
  const fields = await readStoredFields(
    storage,
    coordinates.subject,
    coordinates.id,
    current.fields,
  );
  const status = await verifyOwnerReviewTerminal(
    terminal,
    fields.fields,
  );
  await verifyOwnerReviewActiveLease(storage, current, fields.fields, status);
  return Object.freeze({
    reviewId: await tokens.reviewIdForCurrentKey(currentKey, ownerSubject),
    kind: fields.fields.kind,
    status,
    amount: fields.fields.amount,
    currency: fields.fields.currency,
    updatedAt: terminal.occurredAt,
    revision: current.revision,
  });
}

function storedIndicationCoordinates(value: unknown): Readonly<{
  subject: ActorSubject;
  id: InvestmentIndicationId;
}> {
  const source = exactRecord(value, CURRENT_DOCUMENT_KEYS);
  return Object.freeze({
    subject: storedActorSubject(source.participantSubject),
    id: storedIndicationId(source.indicationId),
  });
}

function requireCurrentMatchesTerminal(
  current: StoredCurrent,
  terminal: StoredTransition,
): void {
  if (
    current.operationId !== terminal.operationId ||
    current.operationFingerprint !== terminal.operationFingerprint ||
    current.requestFingerprint !== terminal.requestFingerprint ||
    current.indicationId !== terminal.indicationId ||
    current.participantSubject !== terminal.participantSubject ||
    current.revision !== terminal.revision ||
    canonicalJson(fieldsReferenceDocument(current.fields)) !==
      canonicalJson(fieldsReferenceDocument(terminal.fields))
  ) {
    unavailable();
  }
}

async function verifyOwnerReviewTerminal(
  terminal: StoredTransition,
  fields: InvestmentIndicationFields,
): Promise<InvestmentIndication["lifecycle"]["status"]> {
  const source = exactRecord(terminal.document, TRANSITION_DOCUMENT_KEYS);
  const acknowledgment = storedAcknowledgment(source.acknowledgment);
  if (
    acknowledgment.participantSubject !== terminal.participantSubject ||
    canonicalJson(acknowledgmentDocument(acknowledgment)) !==
      canonicalJson(source.acknowledgment)
  ) {
    unavailable();
  }

  let actor: ParticipantIndicationActor | OwnerIndicationActor;
  let status: InvestmentIndication["lifecycle"]["status"];
  let reason: string | undefined;
  if (terminal.transitionKind === "rejected") {
    actor = storedOwnerActor(source.actor);
    const rejection = exactRecord(
      source.rejection,
      new Set(["reason", "rejectedAt", "rejectedBy"]),
    );
    const rejectedAt = storedTimestamp(rejection.rejectedAt);
    const rejectedBy = storedOwnerActor(rejection.rejectedBy);
    reason = parseRejectionReason(rejection.reason) ?? unavailable();
    if (
      rejectedAt !== terminal.occurredAt ||
      rejectedBy.subject !== actor.subject ||
      canonicalJson(actorDocument(actor)) !== canonicalJson(source.actor) ||
      canonicalJson({
        reason,
        rejectedAt,
        rejectedBy: actorDocument(rejectedBy),
      }) !== canonicalJson(source.rejection)
    ) {
      unavailable();
    }
    status = "rejected";
  } else {
    actor = storedParticipantActor(source.actor);
    if (
      actor.subject !== terminal.participantSubject ||
      source.rejection !== null ||
      canonicalJson(actorDocument(actor)) !== canonicalJson(source.actor)
    ) {
      unavailable();
    }
    status = terminal.transitionKind === "withdrawn" ? "withdrawn" : "active";
  }

  if (
    terminal.transitionKind === "created"
      ? terminal.revision !== 1 || terminal.fields.revision !== 1
      : terminal.revision <= 1 ||
        (terminal.transitionKind === "edited"
          ? terminal.fields.revision !== terminal.revision
          : terminal.fields.revision >= terminal.revision)
  ) {
    unavailable();
  }
  const request = Object.freeze({
    operationId: terminal.operationId,
    id: terminal.indicationId,
    occurredAt: terminal.occurredAt,
    historyEntryId: terminal.historyEntryId,
    expectedRevision: terminal.revision === 1 ? null : terminal.revision - 1,
    ...(terminal.transitionKind === "created" ||
        terminal.transitionKind === "edited"
      ? { fields }
      : {}),
    ...(reason === undefined ? {} : { reason }),
  }) satisfies ParsedMutationRequest;
  if (
    terminal.operationFingerprint !== await operationFingerprint(
      mutationKindForTransition(terminal.transitionKind),
      actor,
      request,
      terminal.requestFingerprint,
    )
  ) {
    unavailable();
  }

  return status;
}

async function verifyOwnerReviewActiveLease(
  storage: Pick<StorageAdapter, "read">,
  current: StoredCurrent,
  fields: InvestmentIndicationFields,
  status: InvestmentIndication["lifecycle"]["status"],
): Promise<void> {
  if (status !== "active") return;
  const uniquenessKey = (fields.kind === "personal"
    ? JSON.stringify(["personal", current.participantSubject])
    : JSON.stringify([
        "company",
        fields.registrationCountry,
        fields.companyIdentifier,
      ])) as ActiveIndicationUniquenessKey;
  const hexadecimal = await sha256Hex(
    `active-indication-uniqueness\u0000${uniquenessKey}`,
  );
  const fingerprint = `sha256:${hexadecimal}`;
  const key = requiredStorageKey(
    ACTIVE_UNIQUENESS_KEYS,
    `active-key:${hexadecimal}`,
  );
  const lease = Object.freeze({
    uniquenessKey,
    key,
    fingerprint,
    document: Object.freeze({
      kind: "active-indication-lease",
      schemaVersion: INDICATION_SCHEMA_VERSION,
      indicationId: current.indicationId,
      uniquenessFingerprint: fingerprint,
    }),
  });
  const record = await storage.read(key);
  if (record === null) unavailable();
  verifyLeaseRecord(record, lease, current.indicationId);
}

function requiredOwnerIndicationReviewCursor(
  value: unknown,
  fail: () => never,
): StorageCursor {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_OWNER_INDICATION_REVIEW_CURSOR_LENGTH
  ) {
    return fail();
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return fail();
    }
  }
  return value as StorageCursor;
}

function requiredOwnerIndicationReviewBackendCursor(
  value: unknown,
  fail: () => never,
): StorageCursor {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_OWNER_INDICATION_REVIEW_BACKEND_CURSOR_LENGTH
  ) {
    return fail();
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return fail();
    }
  }
  return value as StorageCursor;
}

function requiredOwnerIndicationReviewStorage(
  value: OwnerIndicationReviewStorage,
): OwnerIndicationReviewStorage {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.list !== "function" ||
    typeof value.read !== "function"
  ) {
    invalidRequest();
  }
  return value;
}

function requiredOwnerIndicationReviewTokenBoundary(
  value: OwnerIndicationReviewTokenBoundary,
): OwnerIndicationReviewTokenBoundary {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.sealCursor !== "function" ||
    typeof value.openCursor !== "function" ||
    typeof value.reviewIdForCurrentKey !== "function" ||
    typeof value.currentKeyForReviewId !== "function"
  ) {
    invalidRequest();
  }
  return value;
}

async function openOwnerIndicationReviewCursor(
  tokens: OwnerIndicationReviewTokenBoundary,
  publicCursor: StorageCursor,
  ownerSubject: ActorSubject,
  limit: number,
): Promise<StorageCursor> {
  try {
    return await tokens.openCursor(publicCursor, ownerSubject, limit);
  } catch {
    return invalidRequest();
  }
}

async function sealOwnerIndicationReviewCursor(
  tokens: OwnerIndicationReviewTokenBoundary,
  backendCursor: StorageCursor,
  ownerSubject: ActorSubject,
  limit: number,
): Promise<StorageCursor> {
  try {
    return await tokens.sealCursor(backendCursor, ownerSubject, limit);
  } catch {
    return unavailable();
  }
}

function parseCreateRequest(
  request: CreateIndicationRequest,
  amountConfiguration: AmountConfiguration,
  parsingOptions: InvestmentIndicationParsingOptions,
): ParsedMutationRequest & Readonly<{ fields: InvestmentIndicationFields }> {
  if (request.expectedRevision !== null) invalidRequest();
  return parseMutationRequest(
    request,
    null,
    amountConfiguration,
    parsingOptions,
    "fields",
  ) as ParsedMutationRequest & Readonly<{ fields: InvestmentIndicationFields }>;
}

function parseMutationEnvelope(
  request: IndicationMutationRequest & Readonly<{
    expectedRevision: number | null;
    fields?: unknown;
    reason?: unknown;
  }>,
  expectedRevision: number | null,
): ParsedMutationEnvelope {
  if (request.expectedRevision !== expectedRevision) invalidRequest();
  const parsed = parseMutationRequest(
    request,
    expectedRevision,
    null,
    {},
    "none",
  );
  return Object.freeze({
    ...parsed,
    ...(Object.hasOwn(request, "fields") ? { fields: request.fields } : {}),
    ...(Object.hasOwn(request, "reason") ? { reason: request.reason } : {}),
  });
}

function parseEditRequest(
  request: EditIndicationRequest,
  amountConfiguration: AmountConfiguration,
  parsingOptions: InvestmentIndicationParsingOptions,
): ParsedMutationRequest & Readonly<{ fields: InvestmentIndicationFields }> {
  return parseMutationRequest(
    request,
    requiredExpectedRevision(request.expectedRevision),
    amountConfiguration,
    parsingOptions,
    "fields",
  ) as ParsedMutationRequest & Readonly<{ fields: InvestmentIndicationFields }>;
}

function parseTransitionRequest(
  request: WithdrawIndicationRequest | ReactivateIndicationRequest,
): ParsedMutationRequest {
  return parseMutationRequest(
    request,
    requiredExpectedRevision(request.expectedRevision),
    null,
    {},
    "none",
  );
}

function parseRejectRequest(
  request: RejectIndicationRequest,
): ParsedMutationRequest & Readonly<{ reason: string }> {
  return parseMutationRequest(
    request,
    requiredExpectedRevision(request.expectedRevision),
    null,
    {},
    "reason",
  ) as ParsedMutationRequest & Readonly<{ reason: string }>;
}

function parseMutationRequest(
  request: IndicationMutationRequest &
    Readonly<{
      expectedRevision: number | null;
      fields?: unknown;
      reason?: unknown;
    }>,
  expectedRevision: number | null,
  amountConfiguration: AmountConfiguration | null,
  parsingOptions: InvestmentIndicationParsingOptions,
  payload: "none" | "fields" | "reason",
): ParsedMutationRequest {
  const operationId = parseStorageOperationId(request.operationId);
  const id = parseStableId<"investment-indication">(request.id);
  const occurredAt = parseTimestamp(request.occurredAt);
  const historyEntryId = parseStableId<"investment-indication-history-entry">(
    request.historyEntryId,
  );
  const fields = payload === "fields" && amountConfiguration !== null
    ? parseInvestmentIndicationFields(
        request.fields,
        amountConfiguration,
        parsingOptions,
      )
    : null;
  const reason = payload === "reason"
    ? parseRejectionReason(request.reason)
    : null;

  if (
    !operationId.ok ||
    !id.ok ||
    !occurredAt.ok ||
    !historyEntryId.ok ||
    (fields !== null && !fields.ok) ||
    (payload === "reason" && reason === null)
  ) {
    invalidRequest();
  }

  return Object.freeze({
    operationId: operationId.value,
    id: id.value,
    occurredAt: occurredAt.value,
    historyEntryId: historyEntryId.value,
    expectedRevision,
    ...(fields === null ? {} : { fields: fields.value }),
    ...(reason === null ? {} : { reason }),
  });
}

function parseRejectionReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0 || normalized.length > 500) return null;
  for (const character of normalized) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint === 127) return null;
    if (codePoint < 32 && character !== "\n" && character !== "\t") {
      return null;
    }
    if (
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2060 && codePoint <= 0x206f) ||
      codePoint === 0xfeff
    ) {
      return null;
    }
  }
  return normalized;
}

function requiredExpectedRevision(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) >= Number.MAX_SAFE_INTEGER
  ) {
    invalidRequest();
  }
  return value as number;
}

function requireCurrentRevision(
  indication: InvestmentIndication,
  expectedRevision: number | null,
): void {
  if (
    expectedRevision === null ||
    indication.revision !== expectedRevision
  ) {
    throw new StorageFailure("PRECONDITION_FAILED");
  }
}

function nextRevision(expectedRevision: number | null): number {
  return expectedRevision === null ? 1 : expectedRevision + 1;
}

function domainMutation<Value>(
  operation: () => ValidationResult<Value>,
): Value {
  try {
    const result = operation();
    if (!result.ok) invalidRequest();
    return result.value;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    switch (error.code) {
      case "INVALID_INPUT":
        return invalidRequest();
      case "AUTHENTICATION_REQUIRED":
      case "ACCESS_DENIED":
      case "RESOURCE_NOT_FOUND":
        return notFound();
      case "RESOURCE_CONFLICT":
        throw new StorageFailure("CONFLICT");
      case "PRECONDITION_FAILED":
        throw new StorageFailure("PRECONDITION_FAILED");
      default:
        return unavailable();
    }
  }
}

function reconstructStoredTransition<Value>(
  operation: () => ValidationResult<Value>,
): Value {
  try {
    const result = operation();
    if (!result.ok) unavailable();
    return result.value;
  } catch (error) {
    if (error instanceof StorageFailure && error.code === "UNAVAILABLE") {
      throw error;
    }
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
}

function decodeStoredCurrent(
  record: StorageRecord,
  expectedKey: StorageKey,
  expectedId: InvestmentIndicationId,
  expectedSubject: ActorSubject | null,
): StoredCurrent {
  const source = exactStoredDocument(
    record,
    expectedKey,
    CURRENT_DOCUMENT_KEYS,
    "investment-indication-current",
  );
  const operationId = storedOperationId(source.operationId);
  const operationFingerprint = storedFingerprint(source.operationFingerprint);
  const requestFingerprint = storedFingerprint(source.requestFingerprint);
  const indicationId = storedIndicationId(source.indicationId);
  const participantSubject = storedActorSubject(source.participantSubject);
  const revision = storedRevision(source.revision);
  const fields = storedFieldsReference(source.fields);
  if (
    indicationId !== expectedId ||
    (expectedSubject !== null && participantSubject !== expectedSubject) ||
    record.revision !== revision
  ) unavailable();
  return Object.freeze({
    operationId,
    operationFingerprint,
    requestFingerprint,
    indicationId,
    participantSubject,
    revision,
    fields,
    document: record.value,
    record,
  });
}

function decodeStoredTransition(
  record: StorageRecord,
  expectedKey: StorageKey,
  expectedSubject: ActorSubject | null,
  expectedId: InvestmentIndicationId,
  expectedRevision: number,
): StoredTransition {
  const source = exactStoredDocument(
    record,
    expectedKey,
    TRANSITION_DOCUMENT_KEYS,
    "investment-indication-transition",
  );
  const operationId = storedOperationId(source.operationId);
  const operationFingerprint = storedFingerprint(source.operationFingerprint);
  const requestFingerprint = storedFingerprint(source.requestFingerprint);
  const indicationId = storedIndicationId(source.indicationId);
  const participantSubject = storedActorSubject(source.participantSubject);
  const historyEntryId = storedHistoryEntryId(source.historyEntryId);
  const occurredAt = storedTimestamp(source.occurredAt);
  const revision = storedRevision(source.revision);
  const transitionKind = storedTransitionKind(source.transitionKind);
  const fields = storedFieldsReference(source.fields);
  if (
    indicationId !== expectedId ||
    (expectedSubject !== null && participantSubject !== expectedSubject) ||
    revision !== expectedRevision ||
    record.revision !== 1
  ) unavailable();
  return Object.freeze({
    operationId,
    operationFingerprint,
    requestFingerprint,
    indicationId,
    participantSubject,
    historyEntryId,
    occurredAt,
    revision,
    transitionKind,
    fields,
    document: record.value,
  });
}

async function materializeIndication(
  storage: StorageAdapter,
  subject: ActorSubject,
  id: InvestmentIndicationId,
  revision: number,
  knownTerminal: StoredTransition | null,
): Promise<MaterializedIndication> {
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    revision > MAX_INVESTMENT_INDICATION_REVISIONS
  ) unavailable();
  const transitions = await Promise.all(
    Array.from({ length: revision }, async (_, index) => {
      const currentRevision = index + 1;
      if (knownTerminal !== null && currentRevision === knownTerminal.revision) {
        return knownTerminal;
      }
      const key = await indicationHistoryKey(id, currentRevision);
      const record = await storage.read(key);
      if (record === null) unavailable();
      return decodeStoredTransition(
        record,
        key,
        subject,
        id,
        currentRevision,
      );
    }),
  );

  const references = new Map<number, StoredFieldsReference>();
  let prior: StoredFieldsReference | null = null;
  for (const transition of transitions) {
    if (
      transition.transitionKind === "created" ||
      transition.transitionKind === "edited"
    ) {
      if (transition.fields.revision !== transition.revision) unavailable();
    } else if (
      prior === null ||
      canonicalJson(fieldsReferenceDocument(prior)) !==
        canonicalJson(fieldsReferenceDocument(transition.fields))
    ) unavailable();
    const known = references.get(transition.fields.revision);
    if (
      known !== undefined &&
      canonicalJson(fieldsReferenceDocument(known)) !==
        canonicalJson(fieldsReferenceDocument(transition.fields))
    ) unavailable();
    references.set(transition.fields.revision, transition.fields);
    prior = transition.fields;
  }
  const fieldsByRevision = new Map<number, StoredFields>(await Promise.all(
    [...references.entries()].map(async ([fieldsRevision, reference]) => [
      fieldsRevision,
      await readStoredFields(storage, subject, id, reference),
    ] as const),
  ));

  let indication: InvestmentIndication | null = null;
  for (const transition of transitions) {
    const storedFields = fieldsByRevision.get(transition.fields.revision);
    if (storedFields === undefined) unavailable();
    const source = exactRecord(transition.document, TRANSITION_DOCUMENT_KEYS);
    const acknowledgment = storedAcknowledgment(source.acknowledgment);
    const amount = storedAmountConfiguration(storedFields.fields);
    const options = storedParsingOptions();
    if (transition.transitionKind === "created") {
      if (indication !== null) unavailable();
      indication = reconstructStoredTransition(() => createInvestmentIndication({
        id,
        occurredAt: transition.occurredAt,
        historyEntryId: transition.historyEntryId,
        fields: domainFieldsInput(storedFields.fields),
      }, storedParticipantActor(source.actor), amount, storedAcknowledgmentContext(
        acknowledgment,
      ), options));
    } else if (transition.transitionKind === "edited") {
      if (indication === null) unavailable();
      indication = reconstructStoredTransition(() => editInvestmentIndication(indication!, {
        occurredAt: transition.occurredAt,
        historyEntryId: transition.historyEntryId,
        fields: domainFieldsInput(storedFields.fields),
      }, storedParticipantActor(source.actor), amount, storedAcknowledgmentContext(
        acknowledgment,
      ), options));
    } else if (transition.transitionKind === "withdrawn") {
      if (indication === null) unavailable();
      indication = reconstructStoredTransition(() => withdrawInvestmentIndication(
        indication!,
        {
        occurredAt: transition.occurredAt,
        historyEntryId: transition.historyEntryId,
        },
        storedParticipantActor(source.actor),
      ));
    } else if (transition.transitionKind === "reactivated") {
      if (indication === null) unavailable();
      indication = reconstructStoredTransition(() => reactivateInvestmentIndication(
        indication!,
        {
        occurredAt: transition.occurredAt,
        historyEntryId: transition.historyEntryId,
        },
        storedParticipantActor(source.actor),
        storedAcknowledgmentContext(acknowledgment),
      ));
    } else {
      if (indication === null) unavailable();
      const rejection = exactRecord(source.rejection, new Set([
        "reason",
        "rejectedAt",
        "rejectedBy",
      ]));
      indication = reconstructStoredTransition(() => rejectInvestmentIndication(
        indication!,
        {
        occurredAt: transition.occurredAt,
        historyEntryId: transition.historyEntryId,
        reason: rejection.reason,
        },
        storedOwnerActor(source.actor),
      ));
    }
    const fingerprint = await fingerprintForStoredIndication(
      indication,
      transition.operationId,
      transition.requestFingerprint,
    );
    if (
      fingerprint !== transition.operationFingerprint ||
      canonicalJson(transitionIndicationDocument(
        indication,
        transition.operationId,
        transition.operationFingerprint,
        transition.requestFingerprint,
        transition.fields,
      )) !== canonicalJson(transition.document)
    ) unavailable();
  }
  if (indication === null) unavailable();
  const terminal = transitions.at(-1);
  if (terminal === undefined) unavailable();
  return Object.freeze({ indication, terminal, fieldsByRevision });
}

function exactStoredDocument(
  record: StorageRecord,
  expectedKey: StorageKey,
  expectedKeys: ReadonlySet<string>,
  expectedKind: string,
  expectedSchemaVersion = INDICATION_SCHEMA_VERSION,
): Record<string, unknown> {
  const envelope = exactRecord(record, STORAGE_RECORD_KEYS);
  const key = exactRecord(envelope.key, STORAGE_KEY_KEYS);
  const source = exactRecord(envelope.value, expectedKeys);
  if (
    key.collection !== expectedKey.collection ||
    key.id !== expectedKey.id ||
    !Number.isSafeInteger(envelope.revision) ||
    envelope.revision !== record.revision ||
    source.kind !== expectedKind ||
    source.schemaVersion !== expectedSchemaVersion ||
    jsonByteLength(source) > MAX_INDICATION_STORAGE_RECORD_BYTES
  ) unavailable();
  return source;
}

function storedOperationId(value: unknown): StorageOperationId {
  const parsed = parseStorageOperationId(value);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function storedFingerprint(value: unknown): string {
  if (typeof value !== "string" || !isSha256(value)) unavailable();
  return value;
}

function storedIndicationId(value: unknown): InvestmentIndicationId {
  const parsed = parseStableId<"investment-indication">(value);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function storedActorSubject(value: unknown): ActorSubject {
  const parsed = parseActorSubject(value);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function storedHistoryEntryId(
  value: unknown,
): InvestmentIndicationHistoryEntryId {
  const parsed = parseStableId<"investment-indication-history-entry">(value);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function storedTimestamp(value: unknown): Timestamp {
  const parsed = parseTimestamp(value);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function storedRevision(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_INVESTMENT_INDICATION_REVISIONS
  ) unavailable();
  return value as number;
}

function storedTransitionKind(
  value: unknown,
): InvestmentIndicationHistoryEntry["transition"] {
  if (
    value !== "created" &&
    value !== "edited" &&
    value !== "withdrawn" &&
    value !== "reactivated" &&
    value !== "rejected"
  ) unavailable();
  return value;
}

function storedFieldsReference(value: unknown): StoredFieldsReference {
  const source = exactRecord(value, FIELDS_REFERENCE_KEYS);
  const revision = storedRevision(source.revision);
  if (
    typeof source.hash !== "string" ||
    !isSha256(source.hash) ||
    !Number.isSafeInteger(source.bytes) ||
    (source.bytes as number) < 1 ||
    (source.bytes as number) > MAX_SERIALIZED_INDICATION_FIELDS_BYTES ||
    !Number.isSafeInteger(source.chunks) ||
    (source.chunks as number) < 1 ||
    (source.chunks as number) > MAX_INDICATION_FIELDS_CHUNKS ||
    Math.ceil(
      (source.bytes as number) / INDICATION_FIELDS_CHUNK_RAW_BYTES,
    ) !== source.chunks
  ) unavailable();
  return Object.freeze({
    revision,
    hash: source.hash,
    bytes: source.bytes as number,
    chunks: source.chunks as number,
  });
}

function requireBoundedRecord(value: StorageDocument): void {
  if (jsonByteLength(value) > MAX_INDICATION_STORAGE_RECORD_BYTES) {
    invalidRequest();
  }
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

function verifyMutationResult(
  result: unknown,
  mutations: readonly StorageMutation[],
): void {
  const source = exactRecord(result, TRANSACTION_RESULT_KEYS);
  if (typeof source.replayed !== "boolean") unavailable();
  const records = exactDenseArray(source.records, mutations.length);
  if (records.length !== mutations.length) unavailable();
  for (let index = 0; index < mutations.length; index += 1) {
    const mutation = mutations[index];
    const actual = records[index];
    if (mutation === undefined) unavailable();
    if (mutation.type === "delete") {
      if (actual !== null) unavailable();
      continue;
    }
    if (mutation.type === "check") {
      if (mutation.expectedRevision === null) {
        if (actual !== null) unavailable();
      } else if (
        !sameCheckedRecord(actual, mutation.key, mutation.expectedRevision)
      ) {
        unavailable();
      }
      continue;
    }
    const expectedRevision = (mutation.expectedRevision ?? 0) + 1;
    if (!sameStoredRecord(actual, mutation.key, expectedRevision, mutation.value)) {
      unavailable();
    }
  }
}

function sameCheckedRecord(
  value: unknown,
  expectedKey: StorageKey,
  expectedRevision: number,
): boolean {
  try {
    const record = exactRecord(value, STORAGE_RECORD_KEYS);
    const key = exactRecord(record.key, STORAGE_KEY_KEYS);
    if (
      key.collection !== expectedKey.collection ||
      key.id !== expectedKey.id ||
      record.revision !== expectedRevision ||
      objectRecord(record.value) === null
    ) return false;
    canonicalJson(record.value);
    return true;
  } catch {
    return false;
  }
}

function sameStoredRecord(
  value: unknown,
  expectedKey: StorageKey,
  expectedRevision: number,
  expectedValue: StorageDocument,
): boolean {
  try {
    const record = exactRecord(value, STORAGE_RECORD_KEYS);
    const key = exactRecord(record.key, STORAGE_KEY_KEYS);
    return key.collection === expectedKey.collection &&
      key.id === expectedKey.id &&
      record.revision === expectedRevision &&
      canonicalJson(record.value) === canonicalJson(expectedValue);
  } catch {
    return false;
  }
}

function exactDenseArray(value: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) unavailable();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.at(-1) !== "length") {
    unavailable();
  }
  const entries: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (keys[index] !== String(index)) unavailable();
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) unavailable();
    entries.push(descriptor.value);
  }
  return Object.freeze(entries);
}

function storedParticipantActor(value: unknown): ParticipantIndicationActor {
  const source = objectRecord(value);
  if (source === null || source.type !== "participant") unavailable();
  const subject = parseActorSubject(source.subject);
  if (!subject.ok) unavailable();
  return Object.freeze({ type: "participant", subject: subject.value });
}

function storedOwnerActor(value: unknown): OwnerIndicationActor {
  const source = objectRecord(value);
  if (source === null || source.type !== "owner") unavailable();
  const subject = parseActorSubject(source.subject);
  if (!subject.ok) unavailable();
  return Object.freeze({ type: "owner", subject: subject.value });
}

function storedAcknowledgment(value: unknown): PackageAcceptanceRecord {
  const source = objectRecord(value);
  if (source === null) unavailable();
  const id = parseStableId<"package-acceptance">(source.id);
  const participantSubject = parseActorSubject(source.participantSubject);
  const acceptedAt = parseTimestamp(source.acceptedAt);
  const acceptedVersionId = parseStableId<"package-version">(
    source.acceptedVersionId,
  );
  if (
    !id.ok ||
    !participantSubject.ok ||
    !acceptedAt.ok ||
    !acceptedVersionId.ok ||
    typeof source.acceptedContentHash !== "string" ||
    !isSha256(source.acceptedContentHash) ||
    typeof source.satisfiedRequirementHash !== "string" ||
    !isSha256(source.satisfiedRequirementHash)
  ) {
    unavailable();
  }
  return Object.freeze({
    id: id.value,
    participantSubject: participantSubject.value,
    acceptedAt: acceptedAt.value,
    acceptedVersionId: acceptedVersionId.value,
    acceptedContentHash: source.acceptedContentHash as PackageContentHash,
    satisfiedRequirementHash:
      source.satisfiedRequirementHash as PackageContentHash,
  });
}

function storedAcknowledgmentContext(
  acknowledgment: PackageAcceptanceRecord,
): TrustedPackageAcknowledgmentContext {
  const version = Object.freeze({
    id: acknowledgment.acceptedVersionId,
    createdAt: acknowledgment.acceptedAt,
    changeSummary: "Stored acknowledgment reconstruction",
    materialChange: false,
    acknowledgmentText: "Stored acknowledgment" as PackageVersion["acknowledgmentText"],
    sections: Object.freeze([]),
    contentHash: acknowledgment.acceptedContentHash,
    requiredAcceptanceHash: acknowledgment.satisfiedRequirementHash,
  }) satisfies PackageVersion;
  return Object.freeze({ currentVersion: version, latestAcceptance: acknowledgment });
}

async function prepareStoredFields(
  subject: ActorSubject,
  id: InvestmentIndicationId,
  revision: number,
  fields: InvestmentIndicationFields,
): Promise<StoredFields> {
  const bytes = new TextEncoder().encode(canonicalJson(fieldsDocument(fields)));
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_SERIALIZED_INDICATION_FIELDS_BYTES
  ) invalidRequest();
  const reference = Object.freeze({
    revision,
    hash: `sha256:${await sha256BytesHex(bytes)}`,
    bytes: bytes.byteLength,
    chunks: Math.ceil(bytes.byteLength / INDICATION_FIELDS_CHUNK_RAW_BYTES),
  });
  if (
    reference.chunks < 1 ||
    reference.chunks > MAX_INDICATION_FIELDS_CHUNKS
  ) invalidRequest();
  const chunks: PreparedFieldsChunk[] = [];
  for (let index = 0; index < reference.chunks; index += 1) {
    const start = index * INDICATION_FIELDS_CHUNK_RAW_BYTES;
    const chunk = bytes.slice(
      start,
      Math.min(start + INDICATION_FIELDS_CHUNK_RAW_BYTES, bytes.byteLength),
    );
    const value = fieldsChunkDocument(
      subject,
      id,
      reference,
      index,
      base64UrlEncode(chunk),
    );
    requireBoundedRecord(value);
    chunks.push(Object.freeze({
      key: await indicationFieldsChunkKey(id, revision, index),
      value,
    }));
  }
  return Object.freeze({
    reference,
    fields,
    chunks: Object.freeze(chunks),
  });
}

async function readStoredFields(
  storage: Pick<StorageAdapter, "read">,
  subject: ActorSubject,
  id: InvestmentIndicationId,
  reference: StoredFieldsReference,
): Promise<StoredFields> {
  const parts = await Promise.all(
    Array.from({ length: reference.chunks }, async (_, index) => {
      const key = await indicationFieldsChunkKey(id, reference.revision, index);
      const record = await storage.read(key);
      if (record === null) unavailable();
      const source = exactStoredDocument(
        record,
        key,
        FIELDS_CHUNK_DOCUMENT_KEYS,
        "investment-indication-fields-chunk",
      );
      if (
        record.revision !== 1 ||
        source.indicationId !== id ||
        source.participantSubject !== subject ||
        source.fieldsRevision !== reference.revision ||
        source.fieldsHash !== reference.hash ||
        source.fieldsBytes !== reference.bytes ||
        source.chunkIndex !== index ||
        source.chunkCount !== reference.chunks ||
        typeof source.data !== "string"
      ) unavailable();
      const bytes = base64UrlDecode(source.data);
      const expectedBytes = index === reference.chunks - 1
        ? reference.bytes - index * INDICATION_FIELDS_CHUNK_RAW_BYTES
        : INDICATION_FIELDS_CHUNK_RAW_BYTES;
      if (bytes.byteLength !== expectedBytes) unavailable();
      return bytes;
    }),
  );
  const bytes = new Uint8Array(reference.bytes);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  if (
    offset !== reference.bytes ||
    `sha256:${await sha256BytesHex(bytes)}` !== reference.hash
  ) unavailable();
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    return unavailable();
  }
  const source = storedFieldsDocument(parsed);
  const amount = storedAmountConfigurationFromDocument(source);
  const fields = parseInvestmentIndicationFields(
    storedDomainFieldsInput(source),
    amount,
    storedParsingOptions(),
  );
  if (
    !fields.ok ||
    canonicalJson(fieldsDocument(fields.value)) !== text
  ) unavailable();
  return Object.freeze({
    reference,
    fields: fields.value,
    chunks: Object.freeze([]),
  });
}

function prepareSnapshotMutation(
  indication: InvestmentIndication,
  operationId: StorageOperationId,
  fingerprint: string,
  requestFingerprint: string,
  fields: StoredFieldsReference,
  fieldsChunks: readonly PreparedFieldsChunk[],
): PreparedSnapshotMutation {
  const currentDocument = currentIndicationDocument(
    indication,
    operationId,
    fingerprint,
    requestFingerprint,
    fields,
  );
  const transitionDocument = transitionIndicationDocument(
    indication,
    operationId,
    fingerprint,
    requestFingerprint,
    fields,
  );
  requireBoundedRecord(currentDocument);
  requireBoundedRecord(transitionDocument);
  return Object.freeze({
    indication,
    currentDocument,
    transitionDocument,
    fieldsChunks,
  });
}

function currentIndicationDocument(
  indication: InvestmentIndication,
  operationId: StorageOperationId,
  fingerprint: string,
  requestFingerprint: string,
  fields: StoredFieldsReference,
): StorageDocument {
  return Object.freeze({
    kind: "investment-indication-current",
    schemaVersion: INDICATION_SCHEMA_VERSION,
    operationId,
    operationFingerprint: fingerprint,
    requestFingerprint,
    indicationId: indication.id,
    participantSubject: indication.participantSubject,
    revision: indication.revision,
    fields: fieldsReferenceDocument(fields),
  });
}

function transitionIndicationDocument(
  indication: InvestmentIndication,
  operationId: StorageOperationId,
  fingerprint: string,
  requestFingerprint: string,
  fields: StoredFieldsReference,
): StorageDocument {
  const entry = indication.history.at(-1);
  if (entry === undefined || entry.revision !== indication.revision) unavailable();
  return Object.freeze({
    kind: "investment-indication-transition",
    schemaVersion: INDICATION_SCHEMA_VERSION,
    operationId,
    operationFingerprint: fingerprint,
    requestFingerprint,
    indicationId: indication.id,
    participantSubject: indication.participantSubject,
    historyEntryId: entry.id,
    occurredAt: entry.occurredAt,
    revision: entry.revision,
    transitionKind: entry.transition,
    fields: fieldsReferenceDocument(fields),
    acknowledgment: acknowledgmentDocument(entry.acknowledgment),
    actor: actorDocument(entry.actor),
    rejection: entry.rejection === null ? null : rejectionDocument(entry.rejection),
  });
}

function fieldsReferenceDocument(
  reference: StoredFieldsReference,
): StorageDocument {
  return Object.freeze({
    revision: reference.revision,
    hash: reference.hash,
    bytes: reference.bytes,
    chunks: reference.chunks,
  });
}

function fieldsChunkDocument(
  subject: ActorSubject,
  id: InvestmentIndicationId,
  reference: StoredFieldsReference,
  index: number,
  data: string,
): StorageDocument {
  return Object.freeze({
    kind: "investment-indication-fields-chunk",
    schemaVersion: INDICATION_SCHEMA_VERSION,
    indicationId: id,
    participantSubject: subject,
    fieldsRevision: reference.revision,
    fieldsHash: reference.hash,
    fieldsBytes: reference.bytes,
    chunkIndex: index,
    chunkCount: reference.chunks,
    data,
  });
}

function fieldsDocument(fields: InvestmentIndicationFields): StorageDocument {
  if (fields.kind === "personal") {
    return {
      kind: fields.kind,
      residenceCountry: fields.residenceCountry,
      amount: fields.amount,
      currency: fields.currency,
      availabilityPeriod: fields.availabilityPeriod,
      note: fields.note,
    };
  }
  return companyFieldsDocument(fields);
}

function storedFieldsDocument(value: unknown): Record<string, unknown> {
  const source = objectRecord(value);
  if (source === null) unavailable();
  return source.kind === "personal"
    ? exactRecord(source, PERSONAL_FIELDS_DOCUMENT_KEYS)
    : source.kind === "company"
    ? exactRecord(source, COMPANY_FIELDS_DOCUMENT_KEYS)
    : unavailable();
}

function storedAmountConfiguration(
  fields: InvestmentIndicationFields,
): AmountConfiguration {
  return storedAmountConfigurationFromDocument(fieldsDocument(fields));
}

function storedAmountConfigurationFromDocument(
  value: unknown,
): AmountConfiguration {
  const source = objectRecord(value);
  const parsed = parseAmountAggregateConfiguration({
    amount: {
      currency: source?.currency,
      minimum: 0,
      increment: 1,
      maximum: null,
    },
    publicAggregate: { visibility: "hidden" },
  });
  if (!parsed.ok) unavailable();
  return parsed.value.amount;
}

function storedParsingOptions(): InvestmentIndicationParsingOptions {
  return Object.freeze({
    country: Object.freeze({ normalize: (value: string) => value }),
    companyIdentifier: Object.freeze({
      normalize: (value: string) => value,
    }),
  });
}

function domainFieldsInput(fields: InvestmentIndicationFields): StorageDocument {
  const input = { ...fieldsDocument(fields) } as Record<string, unknown>;
  delete input.currency;
  return input as StorageDocument;
}

function storedDomainFieldsInput(value: unknown): StorageDocument {
  const source = objectRecord(value);
  if (source === null || !("currency" in source)) unavailable();
  const input = { ...source };
  delete input.currency;
  return input as StorageDocument;
}

function companyFieldsDocument(
  fields: CompanyInvestmentIndicationFields,
): StorageDocument {
  return {
    kind: fields.kind,
    companyName: fields.companyName,
    registrationCountry: fields.registrationCountry,
    companyIdentifier: fields.companyIdentifier,
    representativeName: fields.representativeName,
    representativeAuthorityDeclared: fields.representativeAuthorityDeclared,
    amount: fields.amount,
    currency: fields.currency,
    availabilityPeriod: fields.availabilityPeriod,
    note: fields.note,
  };
}

function acknowledgmentDocument(
  acknowledgment: PackageAcceptanceRecord,
): StorageDocument {
  return {
    id: acknowledgment.id,
    participantSubject: acknowledgment.participantSubject,
    acceptedAt: acknowledgment.acceptedAt,
    acceptedVersionId: acknowledgment.acceptedVersionId,
    acceptedContentHash: acknowledgment.acceptedContentHash,
    satisfiedRequirementHash: acknowledgment.satisfiedRequirementHash,
  };
}

function rejectionDocument(
  rejection: NonNullable<InvestmentIndication["lifecycle"]["rejection"]>,
): StorageDocument {
  return {
    reason: rejection.reason,
    rejectedAt: rejection.rejectedAt,
    rejectedBy: actorDocument(rejection.rejectedBy),
  };
}

function actorDocument(
  actor: ParticipantIndicationActor | OwnerIndicationActor,
): StorageDocument {
  return { type: actor.type, subject: actor.subject };
}

async function fingerprintForStoredIndication(
  indication: InvestmentIndication,
  operationId: StorageOperationId,
  requestFingerprint: string,
): Promise<string> {
  const entry = indication.history[indication.history.length - 1];
  if (entry === undefined) unavailable();
  return operationFingerprint(
    mutationKindForTransition(entry.transition),
    entry.actor,
    Object.freeze({
      operationId,
      id: indication.id,
      occurredAt: entry.occurredAt,
      historyEntryId: entry.id,
      expectedRevision: indication.revision === 1
        ? null
        : indication.revision - 1,
      ...(entry.transition === "created" || entry.transition === "edited"
        ? { fields: entry.fields }
        : {}),
      ...(entry.transition === "rejected" && entry.rejection !== null
        ? { reason: entry.rejection.reason }
        : {}),
    }),
    requestFingerprint,
  );
}

function mutationKindForTransition(
  transition: InvestmentIndicationHistoryEntry["transition"],
): MutationKind {
  switch (transition) {
    case "created":
      return "create";
    case "edited":
      return "edit";
    case "withdrawn":
      return "withdraw";
    case "reactivated":
      return "reactivate";
    case "rejected":
      return "reject";
  }
}

async function operationFingerprint(
  kind: MutationKind,
  actor: ParticipantIndicationActor | OwnerIndicationActor,
  request: ParsedMutationRequest,
  requestFingerprint: string,
): Promise<string> {
  const payload: StorageDocument = {
    kind,
    operationId: request.operationId,
    actor: actorDocument(actor),
    expectedRevision: request.expectedRevision,
    id: request.id,
    occurredAt: request.occurredAt,
    historyEntryId: request.historyEntryId,
    requestFingerprint,
    ...(request.fields === undefined
      ? {}
      : { fields: fieldsDocument(request.fields) }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
  };
  return hashDocument(payload);
}

async function exactRequestFingerprint(
  kind: MutationKind,
  actor: ParticipantIndicationActor | OwnerIndicationActor,
  request: ParsedMutationEnvelope,
): Promise<string> {
  const payload = {
    kind,
    operationId: request.operationId,
    actor: actorDocument(actor),
    expectedRevision: request.expectedRevision,
    id: request.id,
    occurredAt: request.occurredAt,
    historyEntryId: request.historyEntryId,
    ...(Object.hasOwn(request, "fields") ? { fields: request.fields } : {}),
    ...(Object.hasOwn(request, "reason") ? { reason: request.reason } : {}),
  };
  let serialized: string;
  try {
    serialized = canonicalJson(payload);
  } catch {
    return invalidRequest();
  }
  return `sha256:${await sha256Hex(serialized)}`;
}

async function hashDocument(value: StorageDocument): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(value))}`;
}

async function activeLease(
  indication: InvestmentIndication,
): Promise<ActiveLease | null> {
  const uniquenessKey = activeIndicationUniquenessKey(indication);
  if (uniquenessKey === null) return null;
  const hexadecimal = await sha256Hex(
    `active-indication-uniqueness\u0000${uniquenessKey}`,
  );
  const fingerprint = `sha256:${hexadecimal}`;
  const key = requiredStorageKey(
    ACTIVE_UNIQUENESS_KEYS,
    `active-key:${hexadecimal}`,
  );
  return Object.freeze({
    uniquenessKey,
    key,
    fingerprint,
    document: Object.freeze({
      kind: "active-indication-lease",
      schemaVersion: INDICATION_SCHEMA_VERSION,
      indicationId: indication.id,
      uniquenessFingerprint: fingerprint,
    }),
  });
}

async function activeLeaseMutations(
  previous: InvestmentIndication | null,
  next: InvestmentIndication,
): Promise<readonly StorageMutation[]> {
  const previousLease = previous === null ? null : await activeLease(previous);
  const nextLease = await activeLease(next);
  if (
    previousLease !== null &&
    nextLease !== null &&
    previousLease.uniquenessKey === nextLease.uniquenessKey
  ) {
    return Object.freeze([]);
  }
  const mutations: StorageMutation[] = [];
  if (previousLease !== null) {
    mutations.push({
      type: "delete",
      key: previousLease.key,
      expectedRevision: 1,
    });
  }
  if (nextLease !== null) {
    mutations.push({
      type: "put",
      key: nextLease.key,
      expectedRevision: null,
      value: nextLease.document,
    });
  }
  return Object.freeze(mutations);
}

function verifyLeaseRecord(
  record: StorageRecord,
  expected: ActiveLease,
  indicationId: InvestmentIndicationId,
): void {
  const source = exactStoredDocument(
    record,
    expected.key,
    LEASE_DOCUMENT_KEYS,
    "active-indication-lease",
  );
  if (
    record.revision !== 1 ||
    source.indicationId !== indicationId ||
    source.uniquenessFingerprint !== expected.fingerprint ||
    canonicalJson(source) !== canonicalJson(expected.document)
  ) {
    unavailable();
  }
}

async function participantOwnershipWitnessMutation(
  storage: Pick<StorageAdapter, "read">,
  previous: InvestmentIndication | null,
  next: InvestmentIndication,
): Promise<StorageMutation> {
  const participantSubject = next.participantSubject;
  const indicationId = next.id;
  if (
    previous !== null &&
    (previous.id !== indicationId ||
      previous.participantSubject !== participantSubject)
  ) unavailable();
  const current = await readParticipantIndicationCompletenessWitness(
    storage,
    participantSubject,
  );
  const currentEntry = current.indications.find((entry) =>
    entry.indicationId === indicationId
  );
  let indications: readonly ParticipantIndicationOwnershipEntry[];
  if (previous === null) {
    if (
      currentEntry !== undefined ||
      current.indications.length >= MAX_OWNED_INVESTMENT_INDICATIONS
    ) {
      throw new StorageFailure("CONFLICT");
    }
    indications = Object.freeze(
      [...current.indications, ownershipEntry(next)].sort(compareOwnershipEntries),
    );
  } else {
    if (
      currentEntry === undefined ||
      currentEntry.indicationRevision !== previous.revision ||
      currentEntry.lifecycleStatus !== previous.lifecycle.status
    ) unavailable();
    indications = Object.freeze(current.indications.map((entry) =>
      entry.indicationId === indicationId ? ownershipEntry(next) : entry
    ));
  }
  const revision = (current.record?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) unavailable();
  const value = Object.freeze({
    kind: "investment-indication-ownership-witness",
    schemaVersion: OWNERSHIP_WITNESS_SCHEMA_VERSION,
    revision,
    indications: Object.freeze(indications.map(ownershipEntryDocument)),
  });
  requireBoundedRecord(value);
  return Object.freeze({
    type: "put" as const,
    key: await ownershipWitnessKey(participantSubject),
    expectedRevision: current.record?.revision ?? null,
    value,
  });
}

async function requireParticipantOwnershipWitness(
  storage: Pick<StorageAdapter, "read">,
  participantSubject: ActorSubject,
  indicationId: InvestmentIndicationId,
): Promise<void> {
  const witness = await readParticipantIndicationCompletenessWitness(
    storage,
    participantSubject,
  );
  if (
    !witness.indications.some((entry) =>
      entry.indicationId === indicationId
    )
  ) unavailable();
}

function ownershipEntry(
  indication: InvestmentIndication,
): ParticipantIndicationOwnershipEntry {
  return Object.freeze({
    indicationId: indication.id,
    indicationRevision: indication.revision,
    lifecycleStatus: indication.lifecycle.status,
  });
}

function ownershipEntryDocument(
  entry: ParticipantIndicationOwnershipEntry,
): StorageDocument {
  return Object.freeze({
    indicationId: entry.indicationId,
    indicationRevision: entry.indicationRevision,
    lifecycleStatus: entry.lifecycleStatus,
  });
}

function compareOwnershipEntries(
  left: ParticipantIndicationOwnershipEntry,
  right: ParticipantIndicationOwnershipEntry,
): number {
  return compareStrings(left.indicationId, right.indicationId);
}

function lifecycleStatusForTransition(
  transition: InvestmentIndicationHistoryEntry["transition"],
): InvestmentIndication["lifecycle"]["status"] {
  if (transition === "withdrawn") return "withdrawn";
  if (transition === "rejected") return "rejected";
  return "active";
}

async function verifyOwnershipTransition(
  transition: StoredTransition,
  lifecycleStatus: InvestmentIndication["lifecycle"]["status"],
): Promise<void> {
  const source = exactRecord(transition.document, TRANSITION_DOCUMENT_KEYS);
  const acknowledgment = storedAcknowledgment(source.acknowledgment);
  if (acknowledgment.participantSubject !== transition.participantSubject) {
    unavailable();
  }
  const request = Object.freeze({
    operationId: transition.operationId,
    id: transition.indicationId,
    occurredAt: transition.occurredAt,
    historyEntryId: transition.historyEntryId,
    expectedRevision: transition.revision - 1,
  });
  if (lifecycleStatus === "active") {
    const actor = storedParticipantActor(source.actor);
    if (
      actor.subject !== transition.participantSubject ||
      source.rejection !== null
    ) unavailable();
    if (transition.transitionKind !== "reactivated") return;
    const fingerprint = await operationFingerprint(
      "reactivate",
      actor,
      request,
      transition.requestFingerprint,
    );
    if (fingerprint !== transition.operationFingerprint) unavailable();
    return;
  }
  let fingerprint: string;
  if (transition.transitionKind === "withdrawn") {
    const actor = storedParticipantActor(source.actor);
    if (
      actor.subject !== transition.participantSubject ||
      source.rejection !== null
    ) unavailable();
    fingerprint = await operationFingerprint(
      "withdraw",
      actor,
      request,
      transition.requestFingerprint,
    );
  } else if (transition.transitionKind === "rejected") {
    const actor = storedOwnerActor(source.actor);
    const rejection = exactRecord(source.rejection, new Set([
      "reason",
      "rejectedAt",
      "rejectedBy",
    ]));
    const rejectedAt = parseTimestamp(rejection.rejectedAt);
    const rejectedBy = storedOwnerActor(rejection.rejectedBy);
    if (
      typeof rejection.reason !== "string" ||
      !rejectedAt.ok ||
      rejectedAt.value !== transition.occurredAt ||
      rejectedBy.subject !== actor.subject
    ) unavailable();
    fingerprint = await operationFingerprint(
      "reject",
      actor,
      Object.freeze({ ...request, reason: rejection.reason }),
      transition.requestFingerprint,
    );
  } else {
    return unavailable();
  }
  if (fingerprint !== transition.operationFingerprint) unavailable();
}

async function currentIndicationKey(
  id: InvestmentIndicationId,
): Promise<StorageKey> {
  return requiredStorageKey(
    CURRENT_INDICATIONS,
    await hashedStorageId("indication-current", id),
  );
}

/** Internal current key used by owner-only opaque review resources. */
export async function ownerIndicationCurrentStorageKey(
  id: unknown,
): Promise<StorageKey> {
  return currentIndicationKey(requiredIndicationId(id));
}

function requiredCurrentIndicationStorageKey(value: unknown): StorageKey {
  const source = exactRecord(value, new Set(["collection", "id"]));
  const parsed = parseStorageKey(source.collection, source.id);
  if (
    !parsed.ok ||
    parsed.value.collection !== CURRENT_INDICATIONS ||
    !/^indication-current:[0-9a-f]{64}$/u.test(parsed.value.id)
  ) invalidRequest();
  return parsed.value;
}

async function ownershipWitnessKey(
  participantSubject: ActorSubject,
): Promise<StorageKey> {
  return requiredStorageKey(
    OWNERSHIP_WITNESSES,
    await hashedStorageId("indication-ownership", participantSubject),
  );
}

async function indicationHistoryKey(
  id: InvestmentIndicationId,
  revision: number,
): Promise<StorageKey> {
  return requiredStorageKey(
    INDICATION_HISTORY,
    await hashedStorageId(
      "indication-history",
      `${id}\u0000${revision}`,
    ),
  );
}

async function indicationFieldsChunkKey(
  id: InvestmentIndicationId,
  revision: number,
  index: number,
): Promise<StorageKey> {
  return requiredStorageKey(
    INDICATION_FIELDS,
    await hashedStorageId(
      "indication-fields",
      `${id}\u0000${revision}\u0000${index}`,
    ),
  );
}

async function hashedStorageId(
  namespace: string,
  value: string,
): Promise<string> {
  return `${namespace}:${await sha256Hex(`${namespace}\u0000${value}`)}`;
}

async function sha256Hex(value: string): Promise<string> {
  return sha256BytesHex(new TextEncoder().encode(value));
}

async function sha256BytesHex(value: Uint8Array): Promise<string> {
  let digest: ArrayBuffer;
  try {
    const input = new Uint8Array(value.byteLength);
    input.set(value);
    digest = await crypto.subtle.digest(
      "SHA-256",
      input,
    );
  } catch {
    unavailable();
  }
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) unavailable();
  const padding = (4 - value.length % 4) % 4;
  let binary: string;
  try {
    binary = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat(padding),
    );
  } catch {
    return unavailable();
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64UrlEncode(bytes) !== value) unavailable();
  return bytes;
}

function peekParticipantSubject(record: StorageRecord): ActorSubject {
  const envelope = exactRecord(record, STORAGE_RECORD_KEYS);
  const source = objectRecord(envelope.value);
  if (source === null) unavailable();
  const parsed = parseActorSubject(source.participantSubject);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function requiredAmountConfiguration(
  value: AmountConfiguration,
): AmountConfiguration {
  const parsed = parseAmountAggregateConfiguration({
    amount: value,
    publicAggregate: { visibility: "hidden" },
  });
  if (!parsed.ok) invalidRequest();
  return Object.freeze({ ...parsed.value.amount });
}

function requiredActorSubject(value: unknown): ActorSubject {
  const parsed = parseActorSubject(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function requiredIndicationId(value: unknown): InvestmentIndicationId {
  const parsed = parseStableId<"investment-indication">(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function requiredStorageKey(
  collection: StorageCollection,
  id: string,
): StorageKey {
  const parsed = parseStorageKey(collection, id);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function storageCollection(value: string): StorageCollection {
  const parsed = parseStorageCollection(value);
  if (!parsed.ok) throw new Error("Invalid indication repository collection.");
  return parsed.value;
}

function hasExactKeys(
  source: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(source);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) return null;
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) return null;
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function exactRecord(
  value: unknown,
  expected: ReadonlySet<string>,
): Record<string, unknown> {
  const source = objectRecord(value);
  if (source === null || !hasExactKeys(source, expected)) unavailable();
  return source;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isInvestmentIndicationLifecycleStatus(
  value: unknown,
): value is InvestmentIndication["lifecycle"]["status"] {
  return value === "active" || value === "withdrawn" || value === "rejected";
}

function isSha256(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

type CanonicalJsonState = {
  nodes: number;
};

function canonicalJson(value: unknown): string {
  return canonicalJsonValue(value, 0, new Set<object>(), { nodes: 0 });
}

function canonicalJsonValue(
  value: unknown,
  depth: number,
  ancestors: ReadonlySet<object>,
  state: CanonicalJsonState,
): string {
  state.nodes += 1;
  if (
    depth > MAX_INDICATION_CANONICAL_DEPTH ||
    state.nodes > MAX_INDICATION_CANONICAL_NODES
  ) unavailable();
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) unavailable();
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) unavailable();
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    const entries = exactDenseArray(value, value.length);
    return `[${
      entries.map((entry) =>
        canonicalJsonValue(entry, depth + 1, nextAncestors, state)
      ).join(",")
    }]`;
  }
  const source = objectRecord(value);
  if (source === null) unavailable();
  return `{${Object.keys(source)
    .sort()
    .map((key) =>
      `${JSON.stringify(key)}:${
        canonicalJsonValue(source[key], depth + 1, nextAncestors, state)
      }`
    )
    .join(",")}}`;
}

function mutationResult<Indication extends InvestmentIndication>(
  indication: Indication,
  replayed: boolean,
): IndicationMutationResult<Indication> {
  return Object.freeze({
    revision: indication.revision,
    snapshot: indication,
    replayed,
  });
}

function activeResult(
  result: IndicationMutationResult,
): IndicationMutationResult<ActiveInvestmentIndication> {
  if (result.snapshot.lifecycle.status !== "active") unavailable();
  return result as IndicationMutationResult<ActiveInvestmentIndication>;
}

function withdrawnResult(
  result: IndicationMutationResult,
): IndicationMutationResult<WithdrawnInvestmentIndication> {
  if (result.snapshot.lifecycle.status !== "withdrawn") unavailable();
  return result as IndicationMutationResult<WithdrawnInvestmentIndication>;
}

function rejectedResult(
  result: IndicationMutationResult,
): IndicationMutationResult<RejectedInvestmentIndication> {
  if (result.snapshot.lifecycle.status !== "rejected") unavailable();
  return result as IndicationMutationResult<RejectedInvestmentIndication>;
}

function invalidRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
}

function notFound(): never {
  throw new StorageFailure("NOT_FOUND");
}

function unavailable(): never {
  throw new StorageFailure("UNAVAILABLE");
}
