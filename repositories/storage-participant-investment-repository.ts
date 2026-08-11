import {
  parseAmountAggregateConfiguration,
  type AmountConfiguration,
} from "../domain/amount-aggregate-configuration.ts";
import {
  parseAuditAppendIntent,
  type AuditEvent,
  type ResourceTransition,
} from "../domain/audit-notification.ts";
import {
  DomainError,
  parseActorSubject,
  parseMinorUnits,
  parseStableId,
  parseTimestamp,
  type ActorSubject,
  type Timestamp,
} from "../domain/foundation.ts";
import {
  projectInvestmentIndicationForAggregation,
  type StoredInvestmentAggregateSnapshot,
} from "../domain/investment-aggregate.ts";
import {
  MAX_INVESTMENT_INDICATION_REVISIONS,
  type InvestmentIndication,
  type InvestmentIndicationHistoryEntryId,
  type InvestmentIndicationId,
  type InvestmentIndicationParsingOptions,
  type WithdrawnInvestmentIndication,
} from "../domain/investment-indication.ts";
import {
  MAX_STORAGE_TRANSACTION_MUTATIONS,
  StorageFailure,
  normalizeStorageTransactionRequest,
  parseStorageCollection,
  parseStorageKey,
  parseStorageOperationId,
  storageKeyString,
  type StorageAdapter,
  type StorageCollection,
  type StorageDocument,
  type StorageKey,
  type StorageListRequest,
  type StorageMutation,
  type StorageOperationId,
  type StoragePage,
  type StoragePutMutation,
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import {
  DevelopmentInMemoryAggregateRepository,
  MAX_ATOMIC_AGGREGATE_WITHDRAWAL_CONTRIBUTIONS,
  prepareAtomicAggregateContribution,
  prepareAtomicAggregateWithdrawalSet,
  readAtomicAggregateContributionReplay,
} from "./in-memory-aggregate-repository.ts";
import {
  prepareAuditAppend,
  verifyPreparedAuditAppend,
  type PreparedAuditAppend,
} from "./in-memory-audit-notification-repositories.ts";
import {
  DevelopmentInMemoryIndicationRepository,
  MAX_INDICATION_FIELDS_CHUNKS,
  MAX_INDICATION_STORAGE_READS,
  MAX_INDICATION_CANONICAL_DEPTH,
  MAX_INDICATION_CANONICAL_NODES,
  MAX_OWNED_INVESTMENT_INDICATIONS,
  prepareParticipantIndicationMutation,
  prepareParticipantIndicationReplay,
  readParticipantIndicationCompletenessWitness,
  readParticipantIndicationOwnershipHead,
  type IndicationMutationResult,
  type ParticipantIndicationCompletenessWitness,
  type ParticipantIndicationOwnershipEntry,
  type PreparedParticipantIndicationMutation,
  type PreparedParticipantIndicationReplay,
} from "./in-memory-indication-repository.ts";
import {
  MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS,
  PARTICIPANT_INVESTMENT_MUTATION_CONSISTENCY,
  type AtomicParticipantInvestmentInterestCommand,
  type AtomicParticipantInvestmentInterestMutationPort,
  type AtomicParticipantInvestmentInterestResult,
  type ParticipantInvestmentInterestReader,
} from "../worker/participant-investment-mutation-port.ts";
import { StagedStorageTransaction as SharedStagedStorageTransaction } from "./staged-storage-transaction.ts";
import type { ParticipantRegistrationProvisioning } from "./in-memory-participant-repository.ts";

const PARTICIPANT_INDEX_SCHEMA_VERSION = 1;
const PARTICIPANT_OPERATION_SCHEMA_VERSION = 2;
const PARTICIPANT_OWNERSHIP_ROOT_SCHEMA_VERSION = 1;
const PARTICIPANT_OWNERSHIP_WITNESS_SCHEMA_VERSION = 2;
const LEGACY_OWNERSHIP_WITNESS_SCHEMA_VERSION = 4;
export const MAX_PARTICIPANT_INDEX_SNAPSHOT_READS = 4;
export const MAX_PARTICIPANT_ACTIVE_LEASE_PROOF_READS =
  MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS *
  (MAX_INDICATION_FIELDS_CHUNKS + 1);
export const MAX_PARTICIPANT_CAPACITY_READS =
  MAX_PARTICIPANT_INDEX_SNAPSHOT_READS +
    2 * MAX_OWNED_INVESTMENT_INDICATIONS +
    MAX_PARTICIPANT_ACTIVE_LEASE_PROOF_READS;
export const MAX_PARTICIPANT_OWNERSHIP_FIRST_INITIALIZATION_READS =
  3 + 2 * MAX_OWNED_INVESTMENT_INDICATIONS +
  MAX_PARTICIPANT_ACTIVE_LEASE_PROOF_READS;
export const MAX_PARTICIPANT_OWNERSHIP_RESTART_READS =
  1 + MAX_PARTICIPANT_CAPACITY_READS;
export const MAX_PARTICIPANT_OWNERSHIP_CONCURRENT_REPLAY_READS =
  MAX_PARTICIPANT_OWNERSHIP_FIRST_INITIALIZATION_READS +
    MAX_PARTICIPANT_CAPACITY_READS;
export const MAX_PARTICIPANT_ACCOUNT_DELETION_WITHDRAWAL_SET_READS =
  MAX_PARTICIPANT_CAPACITY_READS +
  MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS *
    (MAX_INDICATION_STORAGE_READS + 9) + 4;
const PARTICIPANT_INDEXES = collection("participant-investment-indexes");
const PARTICIPANT_OPERATIONS = collection("participant-investment-operations");
const PARTICIPANT_OWNERSHIP_ROOTS = collection(
  "participant-investment-ownership-roots",
);
const PARTICIPANT_OWNERSHIP_WITNESSES = collection(
  "investment-indication-ownership-witnesses",
);
const INDEX_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "revision",
  "indicationIds",
]);
const RECEIPT_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "operationKind",
  "operationFingerprint",
  "indicationId",
  "indicationRevision",
  "aggregate",
  "auditEventId",
]);
const OWNERSHIP_ROOT_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "operationId",
  "initializationFingerprint",
]);
const LEGACY_OWNERSHIP_WITNESS_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "revision",
  "indicationIds",
]);
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
const AGGREGATE_KEYS = new Set([
  "revision",
  "totalAmount",
  "currency",
  "contributingIndicationCount",
]);
const TRANSACTION_RESULT_KEYS = new Set(["replayed", "records"]);
const STORAGE_RECORD_KEYS = new Set(["key", "revision", "value"]);
const STORAGE_KEY_KEYS = new Set(["collection", "id"]);
const ACCOUNT_DELETION_WITHDRAWAL_SET_REQUEST_KEYS = new Set([
  "operationId",
  "requestedAt",
]);

type ParticipantIndex = Readonly<{
  record: StorageRecord | null;
  ids: readonly InvestmentIndicationId[];
}>;

type CompleteParticipantIndex = Readonly<{
  root: ParticipantOwnershipRoot;
  index: ParticipantIndex;
  witness: ParticipantIndicationCompletenessWitness;
}>;

type ParticipantOwnershipRoot = Readonly<{
  record: StorageRecord;
  operationId: StorageOperationId;
  initializationFingerprint: string;
}>;

export type ParticipantInvestmentOwnershipInitializationEntry = Readonly<{
  indicationId: unknown;
  indicationRevision: unknown;
  lifecycleStatus: unknown;
}>;

export type ParticipantInvestmentOwnershipInitializationRequest = Readonly<{
  operationId: unknown;
  indications: unknown;
}>;

export type ParticipantInvestmentOwnershipInitializationResult = Readonly<{
  replayed: boolean;
  indicationCount: number;
  activeCount: number;
}>;

export type ParticipantAccountDeletionInvestmentWithdrawalSetRequest = Readonly<{
  operationId: unknown;
  requestedAt: unknown;
}>;

export type PreparedParticipantAccountDeletionInvestmentWithdrawal = Readonly<{
  operationId: StorageOperationId;
  historyEntryId: InvestmentIndicationHistoryEntryId;
  indication: WithdrawnInvestmentIndication;
}>;

export type PreparedParticipantAccountDeletionInvestmentWithdrawalSet = Readonly<{
  participantSubject: ActorSubject;
  operationId: StorageOperationId;
  requestedAt: Timestamp;
  withdrawals: readonly PreparedParticipantAccountDeletionInvestmentWithdrawal[];
  aggregate: StoredInvestmentAggregateSnapshot;
  mutationCount: number;
}>;

/** Prepare the authoritative empty ownership side of first registration. */
export function createParticipantRegistrationInvestmentProvisioning(
  storage: StorageAdapter,
): ParticipantRegistrationProvisioning {
  const adapter = requiredStorageAdapter(storage);
  const provisioning: ParticipantRegistrationProvisioning = {
    async prepare(
      subject: ActorSubject,
      operationId: StorageOperationId,
    ) {
      const trustedSubject = requiredSubject(subject);
      const parsed = await parseOwnershipInitializationRequest(
        trustedSubject,
        { operationId, indications: Object.freeze([]) },
      );
      const root: StoragePutMutation = Object.freeze({
        type: "put",
        key: await participantOwnershipRootKey(trustedSubject),
        expectedRevision: null,
        value: ownershipRootDocument(parsed),
      });
      const index = await participantIndexMutation(
        trustedSubject,
        Object.freeze({ record: null, ids: Object.freeze([]) }),
        Object.freeze([]),
      );
      const witness = await participantOwnershipWitnessMutation(
        trustedSubject,
        null,
        Object.freeze([]),
      );
      const mutations: readonly [
        StoragePutMutation,
        StoragePutMutation,
        StoragePutMutation,
      ] = Object.freeze([root, index, witness]);
      return mutations;
    },
    async verifyExactReplay(
      subject: ActorSubject,
      operationId: StorageOperationId,
    ) {
      const trustedSubject = requiredSubject(subject);
      const parsed = await parseOwnershipInitializationRequest(
        trustedSubject,
        { operationId, indications: Object.freeze([]) },
      );
      const complete = await readCompleteParticipantIndex(
        adapter,
        trustedSubject,
      );
      requireMatchingInitializationRoot(complete.root, parsed, "request");
    },
  };
  return Object.freeze(provisioning);
}

type ParsedOwnershipInitialization = Readonly<{
  operationId: StorageOperationId;
  indications: readonly ParticipantIndicationOwnershipEntry[];
  fingerprint: string;
}>;

type ParsedAccountDeletionWithdrawalSetRequest = Readonly<{
  operationId: StorageOperationId;
  requestedAt: Timestamp;
}>;

type AccountDeletionWithdrawalIdentity = Readonly<{
  operationId: StorageOperationId;
  historyEntryId: InvestmentIndicationHistoryEntryId;
}>;

type ParticipantMigrationWitness = Readonly<{
  record: StorageRecord;
  indicationIds: readonly InvestmentIndicationId[];
  indications: readonly ParticipantIndicationOwnershipEntry[] | null;
}>;

type PreparedReplayCommand = Readonly<{
  command: AtomicParticipantInvestmentInterestCommand;
  indication: PreparedParticipantIndicationReplay;
  audit: PreparedAuditAppend;
  fingerprint: string;
}>;

type PreparedCommand = Omit<PreparedReplayCommand, "indication"> & Readonly<{
  indication: PreparedParticipantIndicationMutation;
}>;

type StoredOperationReceipt = Readonly<{
  operationKind: AtomicParticipantInvestmentInterestCommand["kind"];
  operationFingerprint: string;
  indicationId: InvestmentIndicationId;
  indicationRevision: number;
  aggregate: StoredInvestmentAggregateSnapshot;
  auditEventId: string;
}>;

/**
 * Explicit deployment/migration boundary for one subject's ownership metadata.
 * Ordinary participant reads and writes never infer initialization from absence.
 */
export async function initializeParticipantInvestmentOwnership(
  storage: StorageAdapter,
  participantSubject: unknown,
  request: ParticipantInvestmentOwnershipInitializationRequest,
): Promise<ParticipantInvestmentOwnershipInitializationResult> {
  try {
    const adapter = requiredStorageAdapter(storage);
    const subject = requiredSubject(participantSubject);
    const parsed = await parseOwnershipInitializationRequest(subject, request);
    if (
      parsed.indications.filter((entry) =>
        entry.lifecycleStatus === "active"
      ).length > MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS
    ) unavailable();
    const existingRoot = await readParticipantOwnershipRoot(adapter, subject);
    if (existingRoot !== null) {
      requireMatchingInitializationRoot(existingRoot, parsed, "request");
      const complete = await readCompleteParticipantIndex(adapter, subject);
      requireMatchingInitializationRoot(complete.root, parsed, "stored");
      return ownershipInitializationResult(parsed.indications, true);
    }

    const index = await readParticipantIndex(adapter, subject);
    const migrationWitness = await readParticipantMigrationWitness(
      adapter,
      subject,
    );
    const expectedIds = ownershipEntryIds(parsed.indications);
    if (
      (index.record !== null && !sameStrings(index.ids, expectedIds)) ||
      (migrationWitness !== null &&
        !sameStrings(migrationWitness.indicationIds, expectedIds)) ||
      (migrationWitness?.indications !== null &&
        migrationWitness?.indications !== undefined &&
        !sameOwnershipEntries(
          migrationWitness.indications,
          parsed.indications,
        ))
    ) unavailable();
    await verifyOwnershipHeads(adapter, subject, parsed.indications);

    const rootKey = await participantOwnershipRootKey(subject);
    const rootMutation = Object.freeze({
      type: "put" as const,
      key: rootKey,
      expectedRevision: null,
      value: ownershipRootDocument(parsed),
    });
    const indexMutation = await participantIndexMutation(
      subject,
      index,
      expectedIds,
    );
    const witnessMutation = await participantOwnershipWitnessMutation(
      subject,
      migrationWitness?.record ?? null,
      parsed.indications,
    );
    const transaction = normalizeStorageTransactionRequest({
      operationId: parsed.operationId,
      mutations: Object.freeze([
        rootMutation,
        indexMutation,
        witnessMutation,
      ]),
    });
    const result = await adapter.transact(transaction);
    verifyInitializationTransactionResult(result, transaction.mutations);
    if (result.replayed) {
      const complete = await readCompleteParticipantIndex(adapter, subject);
      requireMatchingInitializationRoot(complete.root, parsed, "stored");
    }
    return ownershipInitializationResult(parsed.indications, result.replayed);
  } catch (error) {
    return mapRepositoryError(error);
  }
}

/**
 * Stage every active investment withdrawal needed by one account-deletion
 * coordinator. This function never commits the supplied staging boundary.
 */
export async function stageParticipantAccountDeletionInvestmentWithdrawalSet(
  staged: SharedStagedStorageTransaction,
  participantSubject: unknown,
  amountConfiguration: AmountConfiguration,
  request: ParticipantAccountDeletionInvestmentWithdrawalSetRequest,
  parsingOptions: InvestmentIndicationParsingOptions = {},
): Promise<PreparedParticipantAccountDeletionInvestmentWithdrawalSet> {
  try {
    const boundary = requiredDeletionStagingBoundary(staged);
    const subject = requiredSubject(participantSubject);
    const amount = requiredAmountConfiguration(amountConfiguration);
    const parsed = parseAccountDeletionWithdrawalSetRequest(request);
    const complete = await readCompleteParticipantIndex(boundary, subject);
    const active = complete.witness.indications.filter((entry) =>
      entry.lifecycleStatus === "active"
    );
    if (
      active.length > MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS ||
      active.length > MAX_ATOMIC_AGGREGATE_WITHDRAWAL_CONTRIBUTIONS
    ) {
      unavailable();
    }

    const witnessKey = await participantOwnershipWitnessKey(subject);
    const withdrawals: PreparedParticipantAccountDeletionInvestmentWithdrawal[] = [];
    const indicationMutations: StorageMutation[] = [];
    let simulatedStorage: StorageAdapter = boundary;
    let nextOwnership = complete.witness.indications;
    for (const entry of active) {
      const identity = await accountDeletionWithdrawalIdentity(
        parsed.operationId,
        subject,
        entry.indicationId,
      );
      const layer = new StagedStorageTransaction(
        simulatedStorage,
        identity.operationId,
      );
      const indications = new DevelopmentInMemoryIndicationRepository(
        layer,
        subject,
        null,
        amount,
        parsingOptions,
      );
      const result = await indications.withdraw({
        operationId: identity.operationId,
        id: entry.indicationId,
        occurredAt: parsed.requestedAt,
        historyEntryId: identity.historyEntryId,
        expectedRevision: entry.indicationRevision,
      });
      if (
        result.replayed ||
        result.snapshot.participantSubject !== subject ||
        result.snapshot.id !== entry.indicationId ||
        result.snapshot.revision !== entry.indicationRevision + 1 ||
        result.snapshot.lifecycle.status !== "withdrawn"
      ) {
        unavailable();
      }
      indicationMutations.push(...preparedWithdrawalMutations(
        layer.request(),
        identity.operationId,
        witnessKey,
        entry.indicationRevision,
      ));
      nextOwnership = replaceOwnershipEntry(
        nextOwnership,
        result.snapshot,
        false,
      );
      withdrawals.push(Object.freeze({
        ...identity,
        indication: result.snapshot,
      }));
      simulatedStorage = layer;
    }

    const indexMutation = await participantIndexMutation(
      subject,
      complete.index,
      complete.index.ids,
    );
    const witnessMutation = await participantOwnershipWitnessMutation(
      subject,
      complete.witness.record,
      nextOwnership,
    );
    const aggregate = await prepareAtomicAggregateWithdrawalSet(
      boundary,
      Object.freeze(withdrawals.map(({ indication }) =>
        projectInvestmentIndicationForAggregation(indication)
      )),
      amount.currency,
    );
    const mutations = Object.freeze([
      ...indicationMutations,
      indexMutation,
      witnessMutation,
      ...aggregate.mutations,
    ] satisfies readonly StorageMutation[]);
    if (
      mutations.length !== 4 * withdrawals.length +
        (withdrawals.length === 0 ? 2 : 3) ||
      mutations.length > 19 ||
      mutations.length > MAX_STORAGE_TRANSACTION_MUTATIONS ||
      new Set(mutations.map(({ key }) => storageKeyString(key))).size !==
        mutations.length
    ) {
      unavailable();
    }
    const stagedResult = await boundary.transact(Object.freeze({
      operationId: parsed.operationId,
      mutations,
    }));
    if (stagedResult.replayed || stagedResult.records.length !== mutations.length) {
      unavailable();
    }
    return Object.freeze({
      participantSubject: subject,
      operationId: parsed.operationId,
      requestedAt: parsed.requestedAt,
      withdrawals: Object.freeze(withdrawals),
      aggregate: aggregate.stored,
      mutationCount: mutations.length,
    });
  } catch (error) {
    return mapRepositoryError(error);
  }
}

/**
 * Participant-owned reads and one strong indication/aggregate/audit write port.
 * Every durable fact lives behind the supplied credential-bound adapter.
 */
export class StorageParticipantInvestmentInterestRepository
  implements
    ParticipantInvestmentInterestReader,
    AtomicParticipantInvestmentInterestMutationPort
{
  readonly mutationConsistency = PARTICIPANT_INVESTMENT_MUTATION_CONSISTENCY;

  readonly #storage: StorageAdapter;
  readonly #subject: ActorSubject;
  readonly #amount: AmountConfiguration;
  readonly #parsingOptions: InvestmentIndicationParsingOptions;
  readonly #indications: DevelopmentInMemoryIndicationRepository;

  constructor(
    storage: StorageAdapter,
    participantSubject: unknown,
    amountConfiguration: AmountConfiguration,
    parsingOptions: InvestmentIndicationParsingOptions = {},
  ) {
    this.#storage = requiredStorageAdapter(storage);
    this.#subject = requiredSubject(participantSubject);
    this.#amount = requiredAmountConfiguration(amountConfiguration);
    this.#parsingOptions = Object.freeze({ ...parsingOptions });
    this.#indications = new DevelopmentInMemoryIndicationRepository(
      this.#storage,
      this.#subject,
      null,
      this.#amount,
      this.#parsingOptions,
    );
    Object.freeze(this);
  }

  async get(id: InvestmentIndicationId): Promise<InvestmentIndication | null> {
    try {
      return await this.#indications.get(requiredIndicationId(id));
    } catch (error) {
      return mapRepositoryError(error);
    }
  }

  async listOwned(): Promise<readonly InvestmentIndication[]> {
    try {
      const { index } = await readCompleteParticipantIndex(
        this.#storage,
        this.#subject,
      );
      const indications: InvestmentIndication[] = [];
      for (const id of index.ids) {
        const indication = await this.#indications
          .readCurrentParticipantProjection(id);
        if (
          indication === null ||
          indication.id !== id ||
          indication.participantSubject !== this.#subject
        ) {
          unavailable();
        }
        indications.push(indication);
      }
      return Object.freeze(indications);
    } catch (error) {
      return mapRepositoryError(error);
    }
  }

  async commit(
    command: AtomicParticipantInvestmentInterestCommand,
  ): Promise<AtomicParticipantInvestmentInterestResult> {
    try {
      const replayPrepared = await prepareReplayCommand(
        command,
        this.#subject,
      );
      const known = await this.#replay(replayPrepared);
      if (known !== null) return known;

      const prepared = await prepareCommand(
        command,
        this.#subject,
        this.#amount,
        this.#parsingOptions,
        replayPrepared,
      );

      try {
        return await this.#commitNew(prepared);
      } catch (error) {
        if (
          error instanceof StorageFailure &&
          (error.code === "CONFLICT" ||
            error.code === "PRECONDITION_FAILED")
        ) {
          const replay = await this.#replay(prepared);
          if (replay !== null) return replay;
        }
        throw error;
      }
    } catch (error) {
      return mapRepositoryError(error);
    }
  }

  async #commitNew(
    prepared: PreparedCommand,
  ): Promise<AtomicParticipantInvestmentInterestResult> {
    const operationId = prepared.indication.operationId;
    const staged = new StagedStorageTransaction(this.#storage, operationId);
    const indications = new DevelopmentInMemoryIndicationRepository(
      staged,
      this.#subject,
      null,
      this.#amount,
      this.#parsingOptions,
    );
    const capacity = await readParticipantCapacity(
      staged,
      this.#subject,
    );
    if (capacity.activeCount > MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS) {
      unavailable();
    }
    if (
      (prepared.command.kind === "create" ||
        prepared.command.kind === "reactivate") &&
      capacity.activeCount >= MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS
    ) {
      conflict();
    }
    if (prepared.command.kind === "create") {
      if (capacity.index.ids.includes(prepared.indication.id)) conflict();
      if (
        capacity.index.ids.length >= MAX_OWNED_INVESTMENT_INDICATIONS
      ) conflict();
    } else if (!capacity.index.ids.includes(prepared.indication.id)) {
      unavailable();
    }

    const indication = await applyIndication(indications, prepared.command);
    if (indication.replayed) conflict();
    const nextIndexIds = prepared.command.kind === "create"
      ? Object.freeze(
        [...capacity.index.ids, indication.snapshot.id].sort(compareIds),
      )
      : capacity.index.ids;
    const nextOwnershipEntries = replaceOwnershipEntry(
      capacity.witness.indications,
      indication.snapshot,
      prepared.command.kind === "create",
    );
    const stagedWitness = await readParticipantIndicationCompletenessWitness(
      staged,
      this.#subject,
    );
    if (
      stagedWitness.record === null ||
      stagedWitness.record.revision !==
        (capacity.witness.record?.revision ?? 0) + 1 ||
      !sameOwnershipEntries(
        stagedWitness.indications,
        nextOwnershipEntries,
      ) ||
      !sameStrings(ownershipEntryIds(stagedWitness.indications), nextIndexIds)
    ) unavailable();

    const aggregateBefore = await new DevelopmentInMemoryAggregateRepository(
      staged,
      this.#amount.currency,
    ).readStored();
    const aggregate = await prepareAtomicAggregateContribution(staged, {
      operationId,
      expectedStoredRevision: aggregateBefore.revision,
      contribution: projectInvestmentIndicationForAggregation(
        indication.snapshot,
      ),
    }, this.#amount.currency);
    await staged.stage(aggregate.mutations);

    if (
      prepared.command.kind === "create" ||
      prepared.command.kind === "withdraw" ||
      prepared.command.kind === "reactivate"
    ) {
      await staged.stage([await participantIndexMutation(
        this.#subject,
        capacity.index,
        nextIndexIds,
      )]);
    }

    const receiptKey = await operationReceiptKey(operationId);
    await staged.stage([
      prepared.audit.mutation,
      operationReceiptMutation(
        prepared,
        aggregate.result.stored,
        receiptKey,
      ),
    ]);
    const transaction = await this.#storage.transact(staged.request());
    staged.verify(transaction);

    const receiptRecord = transaction.records.at(-1);
    const receipt = decodeOperationReceipt(
      receiptRecord,
      receiptKey,
      this.#amount,
    );
    requireMatchingReceipt(receipt, prepared);
    verifyPreparedAuditAppend(
      prepared.audit,
      transaction.records.at(-2),
    );

    return Object.freeze({
      indication: mutationResult(
        indication.snapshot,
        transaction.replayed,
      ),
      aggregate: receipt.aggregate,
      auditEvent: prepared.audit.event,
    });
  }

  async #replay(
    prepared: PreparedReplayCommand,
  ): Promise<AtomicParticipantInvestmentInterestResult | null> {
    const receiptKey = await operationReceiptKey(
      prepared.indication.operationId,
    );
    const record = await this.#storage.read(receiptKey);
    if (record === null) return null;
    const receipt = decodeOperationReceipt(record, receiptKey, this.#amount);
    requireMatchingReceipt(receipt, prepared);

    const indication = await this.#indications
      .readPreparedParticipantMutation(prepared.indication);
    if (indication === null) unavailable();
    let aggregate;
    try {
      aggregate = await readAtomicAggregateContributionReplay(
        this.#storage,
        {
          operationId: prepared.indication.operationId,
          expectedStoredRevision: receipt.aggregate.revision - 1,
          contribution: projectInvestmentIndicationForAggregation(
            indication.snapshot,
          ),
        },
        this.#amount.currency,
      );
    } catch (error) {
      if (error instanceof StorageFailure) unavailable();
      throw error;
    }
    if (
      aggregate === null ||
      aggregate.disposition !== "applied" ||
      !sameAggregate(aggregate.stored, receipt.aggregate)
    ) unavailable();
    await requireIndexedIndication(
      this.#storage,
      this.#subject,
      indication.snapshot.id,
    );
    const auditRecord = await this.#storage.read(prepared.audit.mutation.key);
    const auditEvent = verifyPreparedAuditAppend(prepared.audit, auditRecord);

    return Object.freeze({
      indication: mutationResult(indication.snapshot, true),
      aggregate: receipt.aggregate,
      auditEvent,
    });
  }
}

async function prepareCommand(
  command: AtomicParticipantInvestmentInterestCommand,
  subject: ActorSubject,
  amount: AmountConfiguration,
  parsingOptions: InvestmentIndicationParsingOptions,
  replayPrepared: PreparedReplayCommand,
): Promise<PreparedCommand> {
  const indication = await prepareParticipantIndicationMutation(
    command.kind,
    subject,
    command.request,
    amount,
    parsingOptions,
  );
  if (
    indication.kind !== replayPrepared.indication.kind ||
    indication.participantSubject !==
      replayPrepared.indication.participantSubject ||
    indication.operationId !== replayPrepared.indication.operationId ||
    indication.id !== replayPrepared.indication.id ||
    indication.occurredAt !== replayPrepared.indication.occurredAt ||
    indication.expectedRevision !== replayPrepared.indication.expectedRevision ||
    indication.resultingRevision !== replayPrepared.indication.resultingRevision ||
    indication.requestFingerprint !==
      replayPrepared.indication.requestFingerprint
  ) unavailable();
  return Object.freeze({ ...replayPrepared, indication });
}

async function prepareReplayCommand(
  command: AtomicParticipantInvestmentInterestCommand,
  subject: ActorSubject,
): Promise<PreparedReplayCommand> {
  if (
    typeof command !== "object" ||
    command === null ||
    !isParticipantCommandKind(command.kind)
  ) invalid();
  const indication = await prepareParticipantIndicationReplay(
    command.kind,
    subject,
    command.request,
  );
  const parsedAudit = parseAuditAppendIntent(command.auditIntent);
  if (!parsedAudit.ok) invalid();
  const audit = prepareAuditAppend(parsedAudit.value);
  requireMatchingAudit(command.kind, indication, audit.event, subject);
  if (audit.operationId !== indication.operationId) invalid();

  const fingerprint = await sha256(
    canonicalJson({
      kind: command.kind,
      indication: indication.requestFingerprint,
      audit: parsedAudit.value,
    }),
  );
  return Object.freeze({ command, indication, audit, fingerprint });
}

async function applyIndication(
  repository: DevelopmentInMemoryIndicationRepository,
  command: AtomicParticipantInvestmentInterestCommand,
): Promise<IndicationMutationResult> {
  if (command.kind === "create") {
    return repository.create(command.request, command.acknowledgmentContext);
  }
  if (command.kind === "edit") {
    return repository.edit(command.request, command.acknowledgmentContext);
  }
  if (command.kind === "withdraw") {
    return repository.withdraw(command.request);
  }
  return repository.reactivate(command.request, command.acknowledgmentContext);
}

function requireMatchingAudit(
  kind: AtomicParticipantInvestmentInterestCommand["kind"],
  indication: PreparedParticipantIndicationReplay,
  event: AuditEvent,
  subject: ActorSubject,
): void {
  const detail = event.detail;
  if (
    String(event.operationId) !== String(indication.operationId) ||
    event.occurredAt !== indication.occurredAt ||
    event.actor.type !== "participant" ||
    event.actor.subject !== subject ||
    detail.kind !== "resource-transition" ||
    detail.resource.type !== "investment-indication" ||
    String(detail.resource.id) !== String(indication.id) ||
    detail.transition !== transitionFor(kind)
  ) invalid();
}

function transitionFor(
  kind: AtomicParticipantInvestmentInterestCommand["kind"],
): Extract<
  ResourceTransition,
  "created" | "updated" | "withdrawn" | "reactivated"
> {
  if (kind === "create") return "created";
  if (kind === "edit") return "updated";
  if (kind === "withdraw") return "withdrawn";
  return "reactivated";
}

function operationReceiptMutation(
  prepared: PreparedReplayCommand,
  aggregate: StoredInvestmentAggregateSnapshot,
  receiptKey: StorageKey,
): StorageMutation {
  return Object.freeze({
    type: "put" as const,
    key: receiptKey,
    expectedRevision: null,
    value: Object.freeze({
      kind: "participant-investment-operation",
      schemaVersion: PARTICIPANT_OPERATION_SCHEMA_VERSION,
      operationKind: prepared.command.kind,
      operationFingerprint: prepared.fingerprint,
      indicationId: prepared.indication.id,
      indicationRevision: prepared.indication.resultingRevision,
      aggregate: aggregateDocument(aggregate),
      auditEventId: prepared.audit.event.id,
    }),
  });
}

function decodeOperationReceipt(
  record: StorageRecord | null | undefined,
  expectedKey: StorageKey,
  amount: AmountConfiguration,
): StoredOperationReceipt {
  if (!record) unavailable();
  const envelope = exactStoredRecordEnvelope(record, expectedKey);
  if (envelope.revision !== 1) unavailable();
  const source = exactRecord(envelope.value, RECEIPT_DOCUMENT_KEYS);
  if (
    source.kind !== "participant-investment-operation" ||
    source.schemaVersion !== PARTICIPANT_OPERATION_SCHEMA_VERSION ||
    !isParticipantCommandKind(source.operationKind) ||
    typeof source.operationFingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(source.operationFingerprint)
  ) unavailable();
  const indicationId = parseStableId<"investment-indication">(
    source.indicationId,
  );
  const auditEventId = parseStableId<"audit-event">(source.auditEventId);
  const aggregate = decodeAggregate(source.aggregate, amount);
  if (
    !indicationId.ok ||
    !auditEventId.ok ||
    aggregate.revision < 1 ||
    !Number.isSafeInteger(source.indicationRevision) ||
    (source.indicationRevision as number) < 1
  ) unavailable();
  return Object.freeze({
    operationKind: source.operationKind,
    operationFingerprint: source.operationFingerprint,
    indicationId: indicationId.value,
    indicationRevision: source.indicationRevision as number,
    aggregate,
    auditEventId: auditEventId.value,
  });
}

function requireMatchingReceipt(
  receipt: StoredOperationReceipt,
  prepared: PreparedReplayCommand,
): void {
  if (receipt.operationFingerprint !== prepared.fingerprint) conflict();
  if (
    receipt.operationKind !== prepared.command.kind ||
    receipt.indicationId !== prepared.indication.id ||
    receipt.indicationRevision !== prepared.indication.resultingRevision ||
    receipt.auditEventId !== prepared.audit.event.id
  ) unavailable();
}

async function readParticipantIndex(
  storage: Pick<StorageAdapter, "read">,
  subject: ActorSubject,
): Promise<ParticipantIndex> {
  const key = await participantIndexKey(subject);
  const record = await storage.read(key);
  if (record === null) {
    return Object.freeze({ record: null, ids: Object.freeze([]) });
  }
  const envelope = exactStoredRecordEnvelope(record, key);
  const source = exactRecord(envelope.value, INDEX_DOCUMENT_KEYS);
  if (
    source.kind !== "participant-investment-index" ||
    source.schemaVersion !== PARTICIPANT_INDEX_SCHEMA_VERSION ||
    source.revision !== envelope.revision
  ) unavailable();
  const values = exactDenseArray(
    source.indicationIds,
    MAX_OWNED_INVESTMENT_INDICATIONS,
  );
  const ids: InvestmentIndicationId[] = [];
  for (const value of values) {
    const parsed = parseStableId<"investment-indication">(value);
    if (!parsed.ok || ids.includes(parsed.value)) unavailable();
    ids.push(parsed.value);
  }
  if (!sameStrings(ids, [...ids].sort(compareIds))) unavailable();
  return Object.freeze({
    record: Object.freeze({
      key,
      revision: envelope.revision,
      value: source as StorageDocument,
    }),
    ids: Object.freeze(ids),
  });
}

async function readParticipantOwnershipRoot(
  storage: Pick<StorageAdapter, "read">,
  subject: ActorSubject,
): Promise<ParticipantOwnershipRoot | null> {
  const expectedKey = await participantOwnershipRootKey(subject);
  const record = await storage.read(expectedKey);
  if (record === null) return null;
  const envelope = exactStoredRecordEnvelope(record, expectedKey);
  if (envelope.revision !== 1) unavailable();
  const source = exactRecord(envelope.value, OWNERSHIP_ROOT_DOCUMENT_KEYS);
  const operationId = parseStorageOperationId(source.operationId);
  if (
    source.kind !== "participant-investment-ownership-root" ||
    source.schemaVersion !== PARTICIPANT_OWNERSHIP_ROOT_SCHEMA_VERSION ||
    !operationId.ok ||
    typeof source.initializationFingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(source.initializationFingerprint)
  ) unavailable();
  return Object.freeze({
    record: Object.freeze({
      key: expectedKey,
      revision: envelope.revision,
      value: source as StorageDocument,
    }),
    operationId: operationId.value,
    initializationFingerprint: source.initializationFingerprint,
  });
}

async function readParticipantMigrationWitness(
  storage: Pick<StorageAdapter, "read">,
  subject: ActorSubject,
): Promise<ParticipantMigrationWitness | null> {
  const expectedKey = await participantOwnershipWitnessKey(subject);
  const record = await storage.read(expectedKey);
  if (record === null) return null;
  const envelope = exactStoredRecordEnvelope(record, expectedKey);
  const value = envelope.value;
  const candidate = exactDataRecord(value);
  if (candidate.schemaVersion === LEGACY_OWNERSHIP_WITNESS_SCHEMA_VERSION) {
    const source = exactRecord(value, LEGACY_OWNERSHIP_WITNESS_DOCUMENT_KEYS);
    if (
      source.kind !== "investment-indication-ownership-witness" ||
      source.revision !== envelope.revision
    ) unavailable();
    const indicationIds = parseStoredIndicationIds(source.indicationIds);
    return Object.freeze({
      record: Object.freeze({
        key: expectedKey,
        revision: envelope.revision,
        value: source as StorageDocument,
      }),
      indicationIds,
      indications: null,
    });
  }
  const source = exactRecord(value, OWNERSHIP_WITNESS_DOCUMENT_KEYS);
  if (
    source.kind !== "investment-indication-ownership-witness" ||
    source.schemaVersion !== PARTICIPANT_OWNERSHIP_WITNESS_SCHEMA_VERSION ||
    source.revision !== envelope.revision
  ) unavailable();
  const indications = parseOwnershipEntries(source.indications, "stored");
  return Object.freeze({
    record: Object.freeze({
      key: expectedKey,
      revision: envelope.revision,
      value: source as StorageDocument,
    }),
    indicationIds: ownershipEntryIds(indications),
    indications,
  });
}

async function verifyOwnershipHeads(
  storage: Pick<StorageAdapter, "read">,
  subject: ActorSubject,
  indications: readonly ParticipantIndicationOwnershipEntry[],
): Promise<void> {
  for (const expected of indications) {
    const actual = await readParticipantIndicationOwnershipHead(
      storage,
      subject,
      expected.indicationId,
    );
    if (
      actual === null ||
      actual.indicationId !== expected.indicationId ||
      actual.indicationRevision !== expected.indicationRevision ||
      actual.lifecycleStatus !== expected.lifecycleStatus
    ) unavailable();
  }
}

function parseAccountDeletionWithdrawalSetRequest(
  request: ParticipantAccountDeletionInvestmentWithdrawalSetRequest,
): ParsedAccountDeletionWithdrawalSetRequest {
  let source: Record<string, unknown>;
  try {
    source = exactRecord(request, ACCOUNT_DELETION_WITHDRAWAL_SET_REQUEST_KEYS);
  } catch {
    return invalid();
  }
  const operationId = parseStorageOperationId(source.operationId);
  const requestedAt = parseTimestamp(source.requestedAt);
  if (!operationId.ok || !requestedAt.ok) invalid();
  return Object.freeze({
    operationId: operationId.value,
    requestedAt: requestedAt.value,
  });
}

async function accountDeletionWithdrawalIdentity(
  operationId: StorageOperationId,
  subject: ActorSubject,
  indicationId: InvestmentIndicationId,
): Promise<AccountDeletionWithdrawalIdentity> {
  const suffix = await digest(canonicalJson({
    kind: "participant-account-deletion-investment-withdrawal",
    operationId,
    participantSubject: subject,
    indicationId,
  }));
  const withdrawalOperationId = parseStorageOperationId(
    `account-deletion-withdrawal:${suffix}`,
  );
  const historyEntryId = parseStableId<"investment-indication-history-entry">(
    `indication-history:account-deletion-${suffix}`,
  );
  if (!withdrawalOperationId.ok || !historyEntryId.ok) unavailable();
  return Object.freeze({
    operationId: withdrawalOperationId.value,
    historyEntryId: historyEntryId.value,
  });
}

function preparedWithdrawalMutations(
  request: StorageTransactionRequest,
  operationId: StorageOperationId,
  witnessKey: StorageKey,
  expectedRevision: number,
): readonly StorageMutation[] {
  const normalized = normalizeStorageTransactionRequest(request);
  if (
    normalized.operationId !== operationId ||
    normalized.mutations.length !== 4
  ) {
    unavailable();
  }
  const [current, history, lease, witness] = normalized.mutations;
  if (
    current?.type !== "put" ||
    current.expectedRevision !== expectedRevision ||
    history?.type !== "put" ||
    history.expectedRevision !== null ||
    lease?.type !== "delete" ||
    lease.expectedRevision !== 1 ||
    witness?.type !== "put" ||
    storageKeyString(witness.key) !== storageKeyString(witnessKey) ||
    [current, history, lease].some((mutation) =>
      storageKeyString(mutation.key) === storageKeyString(witnessKey)
    ) ||
    new Set([current, history, lease].map(({ key }) => storageKeyString(key)))
        .size !== 3
  ) {
    unavailable();
  }
  return Object.freeze([current, history, lease]);
}

async function parseOwnershipInitializationRequest(
  subject: ActorSubject,
  request: ParticipantInvestmentOwnershipInitializationRequest,
): Promise<ParsedOwnershipInitialization> {
  let source: Record<string, unknown>;
  let indications: readonly ParticipantIndicationOwnershipEntry[];
  try {
    source = exactRecord(request, new Set(["operationId", "indications"]));
    indications = parseOwnershipEntries(source.indications, "input");
  } catch {
    return invalid();
  }
  const operationId = parseStorageOperationId(source.operationId);
  if (!operationId.ok) invalid();
  const fingerprint = await sha256(canonicalJson({
    kind: "participant-investment-ownership-initialization",
    participantSubject: subject,
    indications: indications.map(ownershipEntryDocument),
  }));
  return Object.freeze({
    operationId: operationId.value,
    indications,
    fingerprint,
  });
}

function parseOwnershipEntries(
  value: unknown,
  mode: "input" | "stored",
): readonly ParticipantIndicationOwnershipEntry[] {
  let values: readonly unknown[];
  try {
    values = exactDenseArray(value, MAX_OWNED_INVESTMENT_INDICATIONS);
  } catch {
    return mode === "input" ? invalid() : unavailable();
  }
  const indications: ParticipantIndicationOwnershipEntry[] = [];
  for (const value of values) {
    let source: Record<string, unknown>;
    try {
      source = exactRecord(value, OWNERSHIP_ENTRY_DOCUMENT_KEYS);
    } catch {
      return mode === "input" ? invalid() : unavailable();
    }
    const indicationId = parseStableId<"investment-indication">(
      source.indicationId,
    );
    if (
      !indicationId.ok ||
      indications.some((entry) =>
        entry.indicationId === indicationId.value
      ) ||
      !Number.isSafeInteger(source.indicationRevision) ||
      (source.indicationRevision as number) < 1 ||
      (source.indicationRevision as number) >
        MAX_INVESTMENT_INDICATION_REVISIONS ||
      !isOwnershipLifecycleStatus(source.lifecycleStatus)
    ) {
      return mode === "input" ? invalid() : unavailable();
    }
    indications.push(Object.freeze({
      indicationId: indicationId.value,
      indicationRevision: source.indicationRevision as number,
      lifecycleStatus: source.lifecycleStatus,
    }));
  }
  const sorted = [...indications].sort(compareOwnershipEntries);
  if (
    mode === "stored" &&
    !sameStrings(ownershipEntryIds(indications), ownershipEntryIds(sorted))
  ) unavailable();
  return Object.freeze(sorted);
}

function parseStoredIndicationIds(
  value: unknown,
): readonly InvestmentIndicationId[] {
  const values = exactDenseArray(value, MAX_OWNED_INVESTMENT_INDICATIONS);
  const ids: InvestmentIndicationId[] = [];
  for (const value of values) {
    const parsed = parseStableId<"investment-indication">(value);
    if (!parsed.ok || ids.includes(parsed.value)) unavailable();
    ids.push(parsed.value);
  }
  if (!sameStrings(ids, [...ids].sort(compareIds))) unavailable();
  return Object.freeze(ids);
}

function ownershipRootDocument(
  parsed: ParsedOwnershipInitialization,
): StorageDocument {
  return Object.freeze({
    kind: "participant-investment-ownership-root",
    schemaVersion: PARTICIPANT_OWNERSHIP_ROOT_SCHEMA_VERSION,
    operationId: parsed.operationId,
    initializationFingerprint: parsed.fingerprint,
  });
}

async function participantOwnershipWitnessMutation(
  subject: ActorSubject,
  current: StorageRecord | null,
  indications: readonly ParticipantIndicationOwnershipEntry[],
): Promise<StoragePutMutation> {
  const revision = (current?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) unavailable();
  return Object.freeze({
    type: "put" as const,
    key: await participantOwnershipWitnessKey(subject),
    expectedRevision: current?.revision ?? null,
    value: Object.freeze({
      kind: "investment-indication-ownership-witness",
      schemaVersion: PARTICIPANT_OWNERSHIP_WITNESS_SCHEMA_VERSION,
      revision,
      indications: Object.freeze(indications.map(ownershipEntryDocument)),
    }),
  });
}

function ownershipInitializationResult(
  indications: readonly ParticipantIndicationOwnershipEntry[],
  replayed: boolean,
): ParticipantInvestmentOwnershipInitializationResult {
  return Object.freeze({
    replayed,
    indicationCount: indications.length,
    activeCount: indications.filter((entry) =>
      entry.lifecycleStatus === "active"
    ).length,
  });
}

function requireMatchingInitializationRoot(
  root: ParticipantOwnershipRoot,
  parsed: ParsedOwnershipInitialization,
  mismatch: "request" | "stored",
): void {
  if (
    root.operationId === parsed.operationId &&
    root.initializationFingerprint === parsed.fingerprint
  ) return;
  if (mismatch === "request") conflict();
  unavailable();
}

function verifyInitializationTransactionResult(
  result: unknown,
  mutations: readonly StorageMutation[],
): void {
  const source = exactRecord(result, TRANSACTION_RESULT_KEYS);
  if (typeof source.replayed !== "boolean") unavailable();
  const records = exactDenseArray(source.records, mutations.length);
  if (records.length !== mutations.length) unavailable();
  for (let index = 0; index < mutations.length; index += 1) {
    const mutation = mutations[index];
    if (mutation === undefined || mutation.type !== "put") unavailable();
    const expected = Object.freeze({
      key: mutation.key,
      revision: (mutation.expectedRevision ?? 0) + 1,
      value: mutation.value,
    });
    if (!sameRecord(records[index], expected)) unavailable();
  }
}

function replaceOwnershipEntry(
  current: readonly ParticipantIndicationOwnershipEntry[],
  indication: InvestmentIndication,
  create: boolean,
): readonly ParticipantIndicationOwnershipEntry[] {
  const entry = ownershipEntryFromIndication(indication);
  const existing = current.find((candidate) =>
    candidate.indicationId === indication.id
  );
  if (create) {
    if (existing !== undefined) conflict();
    return Object.freeze([...current, entry].sort(compareOwnershipEntries));
  }
  if (existing === undefined) unavailable();
  return Object.freeze(current.map((candidate) =>
    candidate.indicationId === indication.id ? entry : candidate
  ));
}

function ownershipEntryFromIndication(
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

function ownershipEntryIds(
  indications: readonly ParticipantIndicationOwnershipEntry[],
): readonly InvestmentIndicationId[] {
  return Object.freeze(indications.map(({ indicationId }) => indicationId));
}

function sameOwnershipEntries(
  left: readonly ParticipantIndicationOwnershipEntry[],
  right: readonly ParticipantIndicationOwnershipEntry[],
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      entry.indicationId === candidate.indicationId &&
      entry.indicationRevision === candidate.indicationRevision &&
      entry.lifecycleStatus === candidate.lifecycleStatus;
  });
}

function compareOwnershipEntries(
  left: ParticipantIndicationOwnershipEntry,
  right: ParticipantIndicationOwnershipEntry,
): number {
  return compareIds(left.indicationId, right.indicationId);
}

function isOwnershipLifecycleStatus(
  value: unknown,
): value is InvestmentIndication["lifecycle"]["status"] {
  return value === "active" || value === "withdrawn" || value === "rejected";
}

async function readCompleteParticipantIndex(
  storage: Pick<StorageAdapter, "read">,
  subject: ActorSubject,
): Promise<CompleteParticipantIndex> {
  const root = await readParticipantOwnershipRoot(storage, subject);
  if (root === null) unavailable();
  const witnessBefore = await readParticipantIndicationCompletenessWitness(
    storage,
    subject,
  );
  const index = await readParticipantIndex(storage, subject);
  if (witnessBefore.record === null || index.record === null) unavailable();
  const witnessIds = ownershipEntryIds(witnessBefore.indications);
  if (!sameStrings(index.ids, witnessIds)) unavailable();
  if (
    witnessBefore.indications.filter((entry) =>
      entry.lifecycleStatus === "active"
    ).length > MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS
  ) unavailable();
  await verifyOwnershipHeads(storage, subject, witnessBefore.indications);
  const witnessAfter = await readParticipantIndicationCompletenessWitness(
    storage,
    subject,
  );
  if (!sameWitness(witnessBefore, witnessAfter)) unavailable();
  return Object.freeze({ root, index, witness: witnessAfter });
}

async function readParticipantCapacity(
  storage: Pick<StorageAdapter, "read">,
  subject: ActorSubject,
): Promise<Readonly<{
  index: ParticipantIndex;
  witness: ParticipantIndicationCompletenessWitness;
  activeCount: number;
}>> {
  const complete = await readCompleteParticipantIndex(storage, subject);
  return Object.freeze({
    ...complete,
    activeCount: complete.witness.indications.filter((entry) =>
      entry.lifecycleStatus === "active"
    ).length,
  });
}

async function participantIndexMutation(
  subject: ActorSubject,
  current: ParticipantIndex,
  ids: readonly InvestmentIndicationId[],
): Promise<StoragePutMutation> {
  const revision = (current.record?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) unavailable();
  return Object.freeze({
    type: "put" as const,
    key: await participantIndexKey(subject),
    expectedRevision: current.record?.revision ?? null,
    value: Object.freeze({
      kind: "participant-investment-index",
      schemaVersion: PARTICIPANT_INDEX_SCHEMA_VERSION,
      revision,
      indicationIds: Object.freeze([...ids]),
    }),
  });
}

async function requireIndexedIndication(
  storage: Pick<StorageAdapter, "read">,
  subject: ActorSubject,
  id: InvestmentIndicationId,
): Promise<void> {
  const { index } = await readCompleteParticipantIndex(storage, subject);
  if (!index.ids.includes(id)) unavailable();
}

function sameWitness(
  left: ParticipantIndicationCompletenessWitness,
  right: ParticipantIndicationCompletenessWitness,
): boolean {
  if (left.record === null || right.record === null) {
    return left.record === null && right.record === null;
  }
  return left.record.revision === right.record.revision &&
    sameOwnershipEntries(left.indications, right.indications);
}

class StagedStorageTransaction implements StorageAdapter {
  readonly #storage: StorageAdapter;
  readonly #operationId: StorageOperationId;
  readonly #overlay = new Map<string, StorageRecord | null>();
  readonly #mutations: StorageMutation[] = [];
  readonly #records: (StorageRecord | null)[] = [];
  readonly #keys = new Set<string>();
  readonly #collections = new Set<StorageCollection>();

  constructor(storage: StorageAdapter, operationId: StorageOperationId) {
    this.#storage = storage;
    this.#operationId = operationId;
  }

  async read(key: StorageKey): Promise<StorageRecord | null> {
    const identity = storageKeyString(key);
    return this.#overlay.has(identity)
      ? this.#overlay.get(identity) ?? null
      : this.#storage.read(key);
  }

  async list(request: StorageListRequest): Promise<StoragePage> {
    if (this.#collections.has(request.collection)) unavailable();
    return this.#storage.list(request);
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    const normalized = normalizeStorageTransactionRequest(request);
    if (normalized.operationId !== this.#operationId) invalid();
    return this.#stageNormalized(normalized.mutations);
  }

  async stage(mutations: readonly StorageMutation[]): Promise<void> {
    await this.transact(Object.freeze({
      operationId: this.#operationId,
      mutations,
    }));
  }

  request(): StorageTransactionRequest {
    return normalizeStorageTransactionRequest({
      operationId: this.#operationId,
      mutations: this.#mutations,
    });
  }

  verify(result: StorageTransactionResult): void {
    const source = exactRecord(result, TRANSACTION_RESULT_KEYS);
    if (
      typeof source.replayed !== "boolean"
    ) unavailable();
    const records = exactDenseArray(source.records, this.#records.length);
    if (records.length !== this.#records.length) unavailable();
    for (let index = 0; index < this.#records.length; index += 1) {
      if (!sameRecord(records[index], this.#records[index])) unavailable();
    }
  }

  async #stageNormalized(
    mutations: readonly StorageMutation[],
  ): Promise<StorageTransactionResult> {
    if (
      this.#mutations.length + mutations.length >
        MAX_STORAGE_TRANSACTION_MUTATIONS
    ) invalid();
    const records: (StorageRecord | null)[] = [];
    const overlay = new Map<string, StorageRecord | null>();
    for (const mutation of mutations) {
      const identity = storageKeyString(mutation.key);
      if (this.#keys.has(identity) || overlay.has(identity)) invalid();
      const current = await this.read(mutation.key);
      if (mutation.type === "check") {
        if (
          mutation.expectedRevision === null
            ? current !== null
            : current === null ||
              current.revision !== mutation.expectedRevision
        ) precondition();
        records.push(current);
      } else if (mutation.type === "put") {
        if (mutation.expectedRevision === null) {
          if (current !== null) conflict();
        } else if (
          current === null ||
          current.revision !== mutation.expectedRevision
        ) precondition();
        const revision = (mutation.expectedRevision ?? 0) + 1;
        if (!Number.isSafeInteger(revision)) precondition();
        const record = Object.freeze({
          key: mutation.key,
          revision,
          value: mutation.value,
        });
        overlay.set(identity, record);
        records.push(record);
      } else {
        if (
          current === null ||
          current.revision !== mutation.expectedRevision
        ) precondition();
        overlay.set(identity, null);
        records.push(null);
      }
    }
    for (const [identity, record] of overlay) {
      this.#overlay.set(identity, record);
      this.#keys.add(identity);
    }
    for (const mutation of mutations) {
      this.#collections.add(mutation.key.collection);
      this.#keys.add(storageKeyString(mutation.key));
      this.#mutations.push(mutation);
    }
    this.#records.push(...records);
    return Object.freeze({ replayed: false, records: Object.freeze(records) });
  }
}

function sameRecord(
  actual: unknown,
  expected: StorageRecord | null | undefined,
): boolean {
  if (actual === null) return expected === null;
  if (expected === null || expected === undefined) return false;
  try {
    const record = exactRecord(actual, STORAGE_RECORD_KEYS);
    const key = exactRecord(record.key, STORAGE_KEY_KEYS);
    return key.collection === expected.key.collection &&
      key.id === expected.key.id &&
      Number.isSafeInteger(record.revision) &&
      record.revision === expected.revision &&
      sameDocument(record.value, expected.value);
  } catch {
    return false;
  }
}

function sameAggregate(
  left: StoredInvestmentAggregateSnapshot,
  right: StoredInvestmentAggregateSnapshot,
): boolean {
  return left.revision === right.revision &&
    left.totalAmount === right.totalAmount &&
    left.currency === right.currency &&
    left.contributingIndicationCount === right.contributingIndicationCount;
}

function sameDocument(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
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
  ) invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) invalid();

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) invalid();
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== value.length + 1 ||
      keys.at(-1) !== "length"
    ) invalid();
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (keys[index] !== String(index)) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) invalid();
      entries.push(canonicalJsonValue(
        descriptor.value,
        depth + 1,
        nextAncestors,
        state,
      ));
    }
    return `[${entries.join(",")}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const source = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(source);
  if (keys.some((candidate) => typeof candidate !== "string")) invalid();
  const fields = (keys as string[]).sort().map((candidate) => {
    const descriptor = Object.getOwnPropertyDescriptor(source, candidate);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) invalid();
    return `${JSON.stringify(candidate)}:${canonicalJsonValue(
      descriptor.value,
      depth + 1,
      nextAncestors,
      state,
    )}`;
  });
  return `{${fields.join(",")}}`;
}

function decodeAggregate(
  value: unknown,
  amount: AmountConfiguration,
): StoredInvestmentAggregateSnapshot {
  const source = exactRecord(value, AGGREGATE_KEYS);
  const totalAmount = parseMinorUnits(source.totalAmount);
  if (
    !nonNegativeInteger(source.revision) ||
    !totalAmount.ok ||
    source.currency !== amount.currency ||
    !nonNegativeInteger(source.contributingIndicationCount)
  ) unavailable();
  return Object.freeze({
    revision: source.revision,
    totalAmount: totalAmount.value,
    currency: amount.currency,
    contributingIndicationCount: source.contributingIndicationCount,
  });
}

function aggregateDocument(
  aggregate: StoredInvestmentAggregateSnapshot,
): StorageDocument {
  return Object.freeze({
    revision: aggregate.revision,
    totalAmount: aggregate.totalAmount,
    currency: aggregate.currency,
    contributingIndicationCount: aggregate.contributingIndicationCount,
  });
}

function mutationResult(
  snapshot: InvestmentIndication,
  replayed: boolean,
): IndicationMutationResult {
  return Object.freeze({ revision: snapshot.revision, snapshot, replayed });
}

async function participantIndexKey(subject: ActorSubject): Promise<StorageKey> {
  return key(PARTICIPANT_INDEXES, `participant-index:${await digest(subject)}`);
}

async function participantOwnershipRootKey(
  subject: ActorSubject,
): Promise<StorageKey> {
  return key(
    PARTICIPANT_OWNERSHIP_ROOTS,
    `participant-ownership-root:${await digest(subject)}`,
  );
}

async function participantOwnershipWitnessKey(
  subject: ActorSubject,
): Promise<StorageKey> {
  return key(
    PARTICIPANT_OWNERSHIP_WITNESSES,
    `indication-ownership:${
      await digest(`indication-ownership\u0000${subject}`)
    }`,
  );
}

async function operationReceiptKey(
  operationId: StorageOperationId,
): Promise<StorageKey> {
  return key(
    PARTICIPANT_OPERATIONS,
    `participant-operation:${await digest(operationId)}`,
  );
}

async function digest(value: string): Promise<string> {
  const hashed = await sha256(value);
  return hashed.slice("sha256:".length);
}

async function sha256(value: string): Promise<string> {
  let digestValue: ArrayBuffer;
  try {
    digestValue = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
  return `sha256:${[...new Uint8Array(digestValue)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function collection(value: string): StorageCollection {
  const parsed = parseStorageCollection(value);
  if (!parsed.ok) throw new Error("Invalid storage collection.");
  return parsed.value;
}

function key(collectionValue: StorageCollection, id: string): StorageKey {
  const parsed = parseStorageKey(collectionValue, id);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function requiredStorageAdapter(value: StorageAdapter): StorageAdapter {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.read !== "function" ||
    typeof value.list !== "function" ||
    typeof value.transact !== "function"
  ) throw new Error("Invalid participant investment repository configuration.");
  return value;
}

function requiredDeletionStagingBoundary(
  value: SharedStagedStorageTransaction,
): SharedStagedStorageTransaction {
  if (!(value instanceof SharedStagedStorageTransaction)) {
    throw new Error("Invalid account-deletion staging boundary.");
  }
  return value;
}

function requiredSubject(value: unknown): ActorSubject {
  const parsed = parseActorSubject(value);
  if (!parsed.ok) invalid();
  return parsed.value;
}

function requiredAmountConfiguration(
  value: AmountConfiguration,
): AmountConfiguration {
  const parsed = parseAmountAggregateConfiguration({
    amount: value,
    publicAggregate: { visibility: "hidden" },
  });
  if (!parsed.ok) invalid();
  return parsed.value.amount;
}

function requiredIndicationId(value: unknown): InvestmentIndicationId {
  const parsed = parseStableId<"investment-indication">(value);
  if (!parsed.ok) invalid();
  return parsed.value;
}

function exactStoredRecordEnvelope(
  value: unknown,
  expectedKey: StorageKey,
): Readonly<{ revision: number; value: unknown }> {
  const envelope = exactRecord(value, STORAGE_RECORD_KEYS);
  const keyValue = exactRecord(envelope.key, STORAGE_KEY_KEYS);
  if (
    keyValue.collection !== expectedKey.collection ||
    keyValue.id !== expectedKey.id ||
    !Number.isSafeInteger(envelope.revision) ||
    (envelope.revision as number) < 1
  ) unavailable();
  return Object.freeze({
    revision: envelope.revision as number,
    value: envelope.value,
  });
}

function exactRecord(
  value: unknown,
  keys: ReadonlySet<string>,
): Record<string, unknown> {
  const source = exactDataRecord(value);
  const actual = Reflect.ownKeys(source);
  if (
    actual.length !== keys.size ||
    actual.some((candidate) =>
      typeof candidate !== "string" || !keys.has(candidate)
    )
  ) unavailable();
  return source;
}

function exactDataRecord(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) unavailable();
  const source = value as Record<string, unknown>;
  const actual = Reflect.ownKeys(source);
  if (actual.some((candidate) => typeof candidate !== "string")) unavailable();
  for (const candidate of actual) {
    if (typeof candidate !== "string") unavailable();
    const descriptor = Object.getOwnPropertyDescriptor(source, candidate);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) unavailable();
  }
  return source;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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

function isParticipantCommandKind(
  value: unknown,
): value is AtomicParticipantInvestmentInterestCommand["kind"] {
  return value === "create" || value === "edit" ||
    value === "withdraw" || value === "reactivate";
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof StorageFailure) throw error;
  if (error instanceof DomainError) return mapDomainError(error);
  unavailable();
}

function mapDomainError(error: DomainError): never {
  if (error.code === "RESOURCE_CONFLICT") conflict();
  if (error.code === "PRECONDITION_FAILED") precondition();
  if (
    error.code === "RESOURCE_NOT_FOUND" ||
    error.code === "ACCESS_DENIED" ||
    error.code === "AUTHENTICATION_REQUIRED"
  ) notFound();
  invalid();
}

function invalid(): never {
  throw new StorageFailure("INVALID_REQUEST");
}

function notFound(): never {
  throw new StorageFailure("NOT_FOUND");
}

function conflict(): never {
  throw new StorageFailure("CONFLICT");
}

function precondition(): never {
  throw new StorageFailure("PRECONDITION_FAILED");
}

function unavailable(): never {
  throw new StorageFailure("UNAVAILABLE");
}
