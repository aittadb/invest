import {
  parseAmountAggregateConfiguration,
  type AmountConfiguration,
  type CurrencyCode,
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
  type ActorSubject,
} from "../domain/foundation.ts";
import {
  projectInvestmentIndicationForAggregation,
  type StoredInvestmentAggregateSnapshot,
} from "../domain/investment-aggregate.ts";
import type {
  InvestmentIndication,
  InvestmentIndicationId,
  InvestmentIndicationParsingOptions,
  ParticipantInvestmentIndicationSummary,
} from "../domain/investment-indication.ts";
import {
  MAX_STORAGE_TRANSACTION_MUTATIONS,
  StorageFailure,
  normalizeStorageTransactionRequest,
  parseStorageCollection,
  parseStorageKey,
  storageKeyString,
  type StorageAdapter,
  type StorageCheckMutation,
  type StorageCollection,
  type StorageDocument,
  type StorageKey,
  type StorageListRequest,
  type StorageMutation,
  type StorageOperationId,
  type StoragePage,
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import {
  prepareAtomicAggregateContribution,
  readAtomicAggregateContributionHead,
  readAtomicAggregateContributionReplay,
  readFreshAggregateCurrencyCompatibility,
  type AtomicAggregateCurrencyMode,
} from "./in-memory-aggregate-repository.ts";
import {
  prepareAuditAppend,
  verifyPreparedAuditAppend,
  type PreparedAuditAppend,
} from "./in-memory-audit-notification-repositories.ts";
import {
  DevelopmentInMemoryIndicationRepository,
  MAX_INDICATION_CANONICAL_DEPTH,
  MAX_INDICATION_CANONICAL_NODES,
  MAX_PARTICIPANT_INDICATION_SUMMARY_READS,
  prepareParticipantIndicationMutation,
  prepareParticipantIndicationReplay,
  type IndicationMutationResult,
  type PreparedParticipantIndicationMutation,
  type PreparedParticipantIndicationReplay,
} from "./in-memory-indication-repository.ts";
import {
  PARTICIPANT_INVESTMENT_MUTATION_CONSISTENCY,
  type AtomicParticipantInvestmentInterestCommand,
  type AtomicParticipantInvestmentInterestMutationPort,
  type AtomicParticipantInvestmentInterestResult,
  type ParticipantInvestmentInterestReader,
} from "../worker/participant-investment-mutation-port.ts";
import { MAX_PARTICIPANT_INVESTMENT_INTERESTS } from "../domain/participant-investment-interest-resource.ts";

const PARTICIPANT_INDEX_SCHEMA_VERSION = 1;
const PARTICIPANT_OPERATION_SCHEMA_VERSION = 2;
const PARTICIPANT_INDEXES = collection("participant-investment-indexes");
const PARTICIPANT_OPERATIONS = collection("participant-investment-operations");
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
const AGGREGATE_KEYS = new Set([
  "revision",
  "totalAmount",
  "currency",
  "contributingIndicationCount",
]);
const TRANSACTION_RESULT_KEYS = new Set(["replayed", "records"]);
const STORAGE_RECORD_KEYS = new Set(["key", "revision", "value"]);
const STORAGE_KEY_KEYS = new Set(["collection", "id"]);
const MAX_INVESTMENT_POLICY_ASSERTIONS = 4;
export const MAX_PARTICIPANT_INVESTMENT_COLLECTION_STORAGE_READS =
  1 +
  MAX_PARTICIPANT_INVESTMENT_INTERESTS *
    MAX_PARTICIPANT_INDICATION_SUMMARY_READS;

export type InvestmentPolicyAssertionProvider =
  () => readonly StorageCheckMutation[];

type ParticipantIndex = Readonly<{
  record: StorageRecord | null;
  ids: readonly InvestmentIndicationId[];
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
  readonly #policyAssertions: InvestmentPolicyAssertionProvider | null;

  constructor(
    storage: StorageAdapter,
    participantSubject: unknown,
    amountConfiguration: AmountConfiguration,
    parsingOptions: InvestmentIndicationParsingOptions = {},
    policyAssertions?: InvestmentPolicyAssertionProvider,
  ) {
    this.#storage = requiredStorageAdapter(storage);
    this.#subject = requiredSubject(participantSubject);
    this.#amount = requiredAmountConfiguration(amountConfiguration);
    this.#parsingOptions = Object.freeze({ ...parsingOptions });
    if (
      policyAssertions !== undefined &&
      typeof policyAssertions !== "function"
    ) {
      invalid();
    }
    this.#policyAssertions = policyAssertions ?? null;
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

  async listOwned(): Promise<readonly ParticipantInvestmentIndicationSummary[]> {
    try {
      const index = await readParticipantIndex(this.#storage, this.#subject);
      const indications: ParticipantInvestmentIndicationSummary[] = [];
      for (const id of index.ids) {
        const indication = await this.#indications
          .readCurrentParticipantSummary(id);
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

  async freshMutationCurrencyCompatible(): Promise<boolean> {
    try {
      return await readFreshAggregateCurrencyCompatibility(
        this.#storage,
        this.#amount.currency,
      );
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
    if (
      prepared.command.kind !== "withdraw" &&
      this.#policyAssertions !== null
    ) {
      await staged.stage(
        requiredPolicyAssertions(operationId, this.#policyAssertions),
      );
    }
    const indications = new DevelopmentInMemoryIndicationRepository(
      staged,
      this.#subject,
      null,
      this.#amount,
      this.#parsingOptions,
    );
    const indication = await applyIndication(indications, prepared.command);
    if (indication.replayed) conflict();
    const operationCurrency = requiredIndicationCurrency(indication.snapshot);
    if (
      prepared.command.kind !== "withdraw" &&
      operationCurrency !== this.#amount.currency
    ) precondition();

    const aggregateCurrencyMode: AtomicAggregateCurrencyMode =
      prepared.command.kind === "withdraw"
        ? "strict"
        : "allow-empty-rollover";
    const aggregateBefore = await readAtomicAggregateContributionHead(
      staged,
      operationCurrency,
      aggregateCurrencyMode,
    );
    const aggregate = await prepareAtomicAggregateContribution(staged, {
      operationId,
      expectedStoredRevision: aggregateBefore.revision,
      contribution: projectInvestmentIndicationForAggregation(
        indication.snapshot,
      ),
    }, operationCurrency, aggregateCurrencyMode);
    await staged.stage(aggregate.mutations);

    if (prepared.command.kind === "create") {
      const index = await readParticipantIndex(staged, this.#subject);
      if (index.ids.includes(indication.snapshot.id)) conflict();
      if (
        index.ids.length >= MAX_PARTICIPANT_INVESTMENT_INTERESTS
      ) conflict();
      const ids = Object.freeze(
        [...index.ids, indication.snapshot.id].sort(compareIds),
      );
      await staged.stage([await participantIndexMutation(
        this.#subject,
        index,
        ids,
      )]);
    } else {
      await requireIndexedIndication(
        staged,
        this.#subject,
        indication.snapshot.id,
      );
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
    );
    requireMatchingReceipt(receipt, prepared);
    if (receipt.aggregate.currency !== operationCurrency) unavailable();
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
    const receipt = decodeOperationReceipt(record, receiptKey);
    requireMatchingReceipt(receipt, prepared);
    const indication = await this.#indications
      .readPreparedParticipantMutation(prepared.indication);
    if (indication === null) unavailable();
    const operationCurrency = requiredIndicationCurrency(indication.snapshot);
    if (receipt.aggregate.currency !== operationCurrency) unavailable();
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
        receipt.aggregate.currency,
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

function requiredPolicyAssertions(
  operationId: StorageOperationId,
  provider: InvestmentPolicyAssertionProvider | null,
): readonly StorageCheckMutation[] {
  if (provider === null) return Object.freeze([]);
  let value: unknown;
  try {
    value = provider();
  } catch (error) {
    if (error instanceof StorageFailure) throw error;
    unavailable();
  }
  if (
    !Array.isArray(value) ||
    value.length !== MAX_INVESTMENT_POLICY_ASSERTIONS
  ) {
    invalid();
  }
  const normalized = normalizeStorageTransactionRequest({
    operationId,
    mutations: value as readonly StorageMutation[],
  }).mutations;
  if (normalized.some((mutation) => mutation.type !== "check")) invalid();
  return normalized as readonly StorageCheckMutation[];
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
  const aggregate = decodeAggregate(source.aggregate);
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
    MAX_PARTICIPANT_INVESTMENT_INTERESTS,
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

async function participantIndexMutation(
  subject: ActorSubject,
  current: ParticipantIndex,
  ids: readonly InvestmentIndicationId[],
): Promise<StorageMutation> {
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
  const index = await readParticipantIndex(storage, subject);
  if (!index.ids.includes(id)) unavailable();
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
): StoredInvestmentAggregateSnapshot {
  const source = exactRecord(value, AGGREGATE_KEYS);
  const totalAmount = parseMinorUnits(source.totalAmount);
  const currency = requiredStoredCurrency(source.currency);
  if (
    !nonNegativeInteger(source.revision) ||
    !totalAmount.ok ||
    !nonNegativeInteger(source.contributingIndicationCount)
  ) unavailable();
  return Object.freeze({
    revision: source.revision,
    totalAmount: totalAmount.value,
    currency,
    contributingIndicationCount: source.contributingIndicationCount,
  });
}

function requiredStoredCurrency(value: unknown): CurrencyCode {
  const parsed = parseAmountAggregateConfiguration({
    amount: {
      currency: value,
      minimum: 0,
      increment: 1,
      maximum: null,
    },
    publicAggregate: { visibility: "hidden" },
  });
  if (!parsed.ok) unavailable();
  return parsed.value.amount.currency;
}

function requiredIndicationCurrency(
  indication: InvestmentIndication,
): CurrencyCode {
  const parsed = parseAmountAggregateConfiguration({
    amount: {
      currency: indication.fields.currency,
      minimum: 0,
      increment: 1,
      maximum: null,
    },
    publicAggregate: { visibility: "hidden" },
  });
  if (!parsed.ok) unavailable();
  return parsed.value.amount.currency;
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
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) unavailable();
  const source = value as Record<string, unknown>;
  const actual = Reflect.ownKeys(source);
  if (
    actual.length !== keys.size ||
    actual.some((candidate) =>
      typeof candidate !== "string" || !keys.has(candidate)
    )
  ) unavailable();
  for (const candidate of keys) {
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
