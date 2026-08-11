import {
  type AmountAggregateConfiguration,
  type CurrencyCode,
} from "../domain/amount-aggregate-configuration.ts";
import {
  DomainError,
  parseActorSubject,
  parseMinorUnits,
  parseStableId,
  parseTimestamp,
  type ActorSubject,
  type MinorUnits,
  type StableId,
  type Timestamp,
} from "../domain/foundation.ts";
import type { AuditEvent } from "../domain/audit-notification.ts";
import {
  APPLY_CALCULATED_AGGREGATE_CONFIRMATION,
  calculateInvestmentAggregateSummary,
  confirmInvestmentAggregateCorrection,
  createSanitizedPublicInvestmentAggregate,
  previewInvestmentAggregateReconciliation,
  type InvestmentAggregateContribution,
  type InvestmentAggregateCorrectionConfirmation,
  type InvestmentAggregateCorrectionTerminalReplay,
  type InvestmentAggregateReconciliationPreview,
  type InvestmentAggregateSummary,
  type SanitizedPublicInvestmentAggregate,
  type StoredInvestmentAggregateSnapshot,
} from "../domain/investment-aggregate.ts";
import {
  MAX_STORAGE_PAGE_SIZE,
  StorageFailure,
  parseStorageCollection,
  parseStorageKey,
  parseStorageOperationId,
  storageKeyString,
  type StorageAdapter,
  type StorageCheckMutation,
  type StorageCollection,
  type StorageCursor,
  type StorageDocument,
  type JsonValue,
  type StorageKey,
  type StorageMutation,
  type StorageOperationId,
  type StoragePage,
  type StorageRecord,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import {
  prepareAuditAppend,
  verifyPreparedAuditAppend,
} from "./in-memory-audit-notification-repositories.ts";
import {
  campaignSetupRevisionCheck,
  verifyCampaignSetupRevisionCheckRecord,
} from "./in-memory-campaign-repository.ts";

const AGGREGATE_SCHEMA_VERSION = 1;
const AGGREGATE_STATES = storageCollection("investment-aggregate-states");
const AGGREGATE_CONTRIBUTIONS = storageCollection(
  "investment-aggregate-contributions",
);
const AGGREGATE_OPERATIONS = storageCollection("investment-aggregate-operations");
const CURRENT_AGGREGATE_KEY = requiredStorageKey(
  AGGREGATE_STATES,
  "current-investment-aggregate",
);

export const MAX_AGGREGATE_CONTRIBUTION_LIST_PAGES = 20;
export const MAX_AGGREGATE_CONTRIBUTION_LIST_READS = 20;
export const MAX_AGGREGATE_CONTRIBUTION_RECORDS = 1_000;
export const MAX_ATOMIC_AGGREGATE_WITHDRAWAL_CONTRIBUTIONS = 4;
const MAX_AGGREGATE_CONTRIBUTION_CURSOR_LENGTH = 2_048;
const MAX_AGGREGATE_TRANSACTION_RESULT_DEPTH = 32;
const MAX_AGGREGATE_TRANSACTION_RESULT_NODES = 4_096;

const TRANSACTION_RESULT_KEYS = ["replayed", "records"] as const;
const STORAGE_RECORD_KEYS = ["key", "revision", "value"] as const;
const STORAGE_KEY_KEYS = ["collection", "id"] as const;

const AGGREGATE_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "snapshot",
]);
const AGGREGATE_DOCUMENT_WITH_REPLAY_KEYS = new Set([
  ...AGGREGATE_DOCUMENT_KEYS,
  "terminalCorrectionReplay",
]);
const TERMINAL_CORRECTION_REPLAY_KEYS = new Set([
  "operationId",
  "expectedCampaignRevision",
  "confirmation",
]);
const CONTRIBUTION_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "indicationId",
  "indicationRevision",
  "status",
  "amount",
  "currency",
]);
const OPERATION_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "operationKind",
  "operationFingerprint",
  "result",
]);
const SNAPSHOT_KEYS = new Set([
  "revision",
  "totalAmount",
  "currency",
  "contributingIndicationCount",
]);
const SUMMARY_KEYS = new Set([
  "totalAmount",
  "currency",
  "contributingIndicationCount",
]);
const CONTRIBUTION_RESULT_KEYS = new Set([
  "disposition",
  "stored",
  "calculated",
]);
const CORRECTION_RESULT_KEYS = new Set(["preview", "stored"]);
const AUDITED_CORRECTION_RESULT_KEYS = new Set([
  "preview",
  "stored",
  "auditEvent",
]);
const PREVIEW_KEYS = new Set([
  "status",
  "stored",
  "calculated",
  "correctionRequired",
]);
const STORAGE_PAGE_KEYS = new Set(["items", "nextCursor"]);
const REVISION_ASSERTION_KEYS = new Set([
  "type",
  "key",
  "expectedRevision",
]);

export type AggregateContributionDisposition =
  | "applied"
  | "duplicate"
  | "superseded";

export type ApplyAggregateContributionRequest = Readonly<{
  operationId: unknown;
  expectedStoredRevision: number;
  contribution: InvestmentAggregateContribution;
}>;

export type ApplyAggregateContributionResult = Readonly<{
  disposition: AggregateContributionDisposition;
  stored: StoredInvestmentAggregateSnapshot;
  calculated: InvestmentAggregateSummary;
  replayed: boolean;
}>;

export type PreparedAtomicAggregateContribution = Readonly<{
  operationId: StorageOperationId;
  operationFingerprint: string;
  contribution: InvestmentAggregateContribution;
  result: Omit<ApplyAggregateContributionResult, "replayed">;
  mutations: readonly StorageMutation[];
}>;

export type PreparedAtomicAggregateWithdrawalSet = Readonly<{
  contributions: readonly InvestmentAggregateContribution[];
  stored: StoredInvestmentAggregateSnapshot;
  mutations: readonly StorageMutation[];
}>;

export type ApplyAggregateCorrectionRequest = Readonly<{
  operationId: unknown;
  confirmation: unknown;
}>;

export type ApplyAggregateCorrectionResult = Readonly<{
  preview: InvestmentAggregateReconciliationPreview;
  stored: StoredInvestmentAggregateSnapshot;
  replayed: boolean;
}>;

export type ApplyAuditedAggregateCorrectionRequest = Readonly<{
  operationId: unknown;
  expectedCampaignRevision: unknown;
  confirmation: unknown;
  ownerSubject: unknown;
  occurredAt: unknown;
}>;

export type ApplyAuditedAggregateCorrectionResult = Readonly<{
  preview: InvestmentAggregateReconciliationPreview;
  stored: StoredInvestmentAggregateSnapshot;
  auditEvent: AuditEvent;
  replayed: boolean;
}>;

export type AggregateCorrectionTerminalReplay =
  InvestmentAggregateCorrectionTerminalReplay;

export type InvestmentAggregateReconciliationState = Readonly<{
  preview: InvestmentAggregateReconciliationPreview;
  terminalReplay: AggregateCorrectionTerminalReplay | null;
}>;

export type AggregateCorrectionRevisionAssertion = StorageCheckMutation &
  Readonly<{ expectedRevision: number }>;

/** Storage-backed aggregate contract shared by development and production adapters. */
export interface InvestmentAggregateRepository {
  readStored(): Promise<StoredInvestmentAggregateSnapshot>;
  calculate(): Promise<InvestmentAggregateSummary>;
  applyContribution(
    request: ApplyAggregateContributionRequest,
  ): Promise<ApplyAggregateContributionResult>;
  previewReconciliation(): Promise<InvestmentAggregateReconciliationPreview>;
  applyConfirmedCorrection(
    request: ApplyAggregateCorrectionRequest,
  ): Promise<ApplyAggregateCorrectionResult>;
  readPublicAggregate(
    configuration: AmountAggregateConfiguration,
    publicTargetAmount: unknown | null,
  ): Promise<SanitizedPublicInvestmentAggregate | null>;
}

/** Correction capability that commits the aggregate, receipt, and audit atomically. */
export interface AtomicInvestmentAggregateCorrectionRepository {
  readonly correctionConsistency: "atomic-aggregate-audit";
  previewReconciliation(): Promise<InvestmentAggregateReconciliationPreview>;
  applyConfirmedCorrectionWithAudit(
    request: ApplyAuditedAggregateCorrectionRequest,
  ): Promise<ApplyAuditedAggregateCorrectionResult>;
}

/** Owner route capability bound to one exact persisted campaign revision. */
export interface CampaignRevisionBoundAggregateCorrectionRepository
  extends AtomicInvestmentAggregateCorrectionRepository {
  readonly campaignRevision: number;
  previewReconciliationState(): Promise<InvestmentAggregateReconciliationState>;
}

type StoredAggregateRecord = Readonly<{
  record: StorageRecord;
  snapshot: StoredInvestmentAggregateSnapshot;
  terminalReplay: AggregateCorrectionTerminalReplay | null;
}>;

type OperationKind = "contribution" | "correction" | "audited-correction";

type StoredOperationResult =
  | Omit<ApplyAggregateContributionResult, "replayed">
  | Omit<ApplyAggregateCorrectionResult, "replayed">
  | Omit<ApplyAuditedAggregateCorrectionResult, "replayed">;

type ParsedAggregateContributionRequest = Readonly<{
  operationId: StorageOperationId;
  expectedStoredRevision: number;
  contribution: InvestmentAggregateContribution;
  fingerprint: string;
}>;

/**
 * Prepare the aggregate side of a larger atomic indication transaction.
 * Unlike the reconciliation-oriented development path, this reads only the
 * current aggregate, this indication's prior contribution, and the operation
 * slot. Every accepted indication revision must advance its contribution by
 * exactly one revision.
 */
export async function prepareAtomicAggregateContribution(
  storage: Pick<StorageAdapter, "read">,
  request: ApplyAggregateContributionRequest,
  currency: CurrencyCode,
): Promise<PreparedAtomicAggregateContribution> {
  const parsed = await parseAggregateContributionRequest(request, currency);
  const operationKey = operationStorageKey(parsed.operationId);
  const operationRecord = await storage.read(operationKey);
  if (operationRecord !== null) {
    decodeOperationRecord(
      operationRecord,
      operationKey,
      "contribution",
      parsed.fingerprint,
      currency,
    );
    unavailable();
  }

  const aggregateRecord = await storage.read(CURRENT_AGGREGATE_KEY);
  const stored = aggregateRecord === null
    ? zeroStoredSnapshot(currency)
    : decodeAggregateRecord(aggregateRecord, currency);
  if (stored.revision !== parsed.expectedStoredRevision) {
    preconditionFailed();
  }

  const contributionKey = contributionStorageKey(
    parsed.contribution.indicationId,
  );
  const currentRecord = await storage.read(contributionKey);
  const current = currentRecord === null
    ? null
    : decodeContributionRecord(currentRecord, currency);
  if (
    current === null
      ? parsed.contribution.indicationRevision !== 1
      : currentRecord?.revision !== current.indicationRevision ||
        parsed.contribution.indicationRevision !==
          current.indicationRevision + 1
  ) {
    unavailable();
  }

  const nextStored = applyContributionDelta(
    stored,
    current,
    parsed.contribution,
  );
  const result = deepFreeze({
    disposition: "applied" as const,
    stored: nextStored,
    calculated: summaryFromStored(nextStored),
  });
  const mutations = Object.freeze([
    Object.freeze({
      type: "put" as const,
      key: CURRENT_AGGREGATE_KEY,
      expectedRevision: aggregateRecord?.revision ?? null,
      value: aggregateDocument(nextStored),
    }),
    Object.freeze({
      type: "put" as const,
      key: contributionKey,
      expectedRevision: currentRecord?.revision ?? null,
      value: contributionDocument(parsed.contribution),
    }),
    Object.freeze({
      type: "put" as const,
      key: operationKey,
      expectedRevision: null,
      value: operationDocument(
        "contribution",
        parsed.fingerprint,
        result,
      ),
    }),
  ] satisfies readonly StorageMutation[]);
  return Object.freeze({
    operationId: parsed.operationId,
    operationFingerprint: parsed.fingerprint,
    contribution: parsed.contribution,
    result,
    mutations,
  });
}

/**
 * Prepare one aggregate revision for a bounded set of account-deletion
 * withdrawals. The caller owns the outer transaction and retry receipt.
 */
export async function prepareAtomicAggregateWithdrawalSet(
  storage: Pick<StorageAdapter, "read">,
  values: unknown,
  currency: CurrencyCode,
): Promise<PreparedAtomicAggregateWithdrawalSet> {
  const expectedCurrency = requiredCurrency(currency);
  const contributions = requiredAggregateWithdrawalContributions(
    values,
    expectedCurrency,
  );
  const aggregateRecord = await storage.read(CURRENT_AGGREGATE_KEY);
  const stored = aggregateRecord === null
    ? zeroStoredSnapshot(expectedCurrency)
    : decodeAggregateRecord(aggregateRecord, expectedCurrency);
  if (contributions.length === 0) {
    return deepFreeze({ contributions, stored, mutations: [] });
  }
  if (stored.revision === Number.MAX_SAFE_INTEGER) preconditionFailed();

  let removedAmount = 0;
  const contributionMutations: StorageMutation[] = [];
  for (const contribution of contributions) {
    const contributionKey = contributionStorageKey(contribution.indicationId);
    const currentRecord = await storage.read(contributionKey);
    if (currentRecord === null) unavailable();
    const current = decodeContributionRecord(currentRecord, expectedCurrency);
    if (
      currentRecord.revision !== current.indicationRevision ||
      current.status !== "active" ||
      contribution.indicationRevision !== current.indicationRevision + 1 ||
      contribution.amount !== current.amount ||
      contribution.currency !== current.currency
    ) {
      unavailable();
    }
    if (removedAmount > Number.MAX_SAFE_INTEGER - current.amount) unavailable();
    removedAmount += current.amount;
    contributionMutations.push(Object.freeze({
      type: "put" as const,
      key: contributionKey,
      expectedRevision: currentRecord.revision,
      value: contributionDocument(contribution),
    }));
  }
  if (
    stored.totalAmount < removedAmount ||
    stored.contributingIndicationCount < contributions.length ||
    (stored.contributingIndicationCount === contributions.length &&
      stored.totalAmount !== removedAmount)
  ) {
    unavailable();
  }
  const nextStored = deepFreeze({
    revision: stored.revision + 1,
    totalAmount: (stored.totalAmount - removedAmount) as MinorUnits,
    currency: stored.currency,
    contributingIndicationCount:
      stored.contributingIndicationCount - contributions.length,
  });
  summaryFromStored(nextStored);
  const mutations = Object.freeze([
    Object.freeze({
      type: "put" as const,
      key: CURRENT_AGGREGATE_KEY,
      expectedRevision: aggregateRecord?.revision ?? null,
      value: aggregateDocument(nextStored),
    }),
    ...contributionMutations,
  ] satisfies readonly StorageMutation[]);
  return deepFreeze({ contributions, stored: nextStored, mutations });
}

/** Verify the immutable aggregate receipt for a completed atomic operation. */
export async function readAtomicAggregateContributionReplay(
  storage: Pick<StorageAdapter, "read">,
  request: ApplyAggregateContributionRequest,
  currency: CurrencyCode,
): Promise<ApplyAggregateContributionResult | null> {
  const parsed = await parseAggregateContributionRequest(request, currency);
  const key = operationStorageKey(parsed.operationId);
  const record = await storage.read(key);
  if (record === null) return null;
  return contributionResult(
    decodeOperationRecord(
      record,
      key,
      "contribution",
      parsed.fingerprint,
      currency,
    ),
    true,
  );
}

/**
 * Deterministic development repository composed entirely through StorageAdapter.
 * It owns no process-local state, so a new repository instance reopens the same
 * aggregate, contribution, reconciliation, and retry records.
 */
export class DevelopmentInMemoryAggregateRepository
  implements
    InvestmentAggregateRepository,
    AtomicInvestmentAggregateCorrectionRepository
{
  readonly storageKind = "development-in-memory" as const;
  readonly correctionConsistency = "atomic-aggregate-audit" as const;

  readonly #storage: StorageAdapter;
  readonly #currency: CurrencyCode;
  readonly #correctionRevisionAssertion:
    AggregateCorrectionRevisionAssertion | null;

  constructor(
    storage: StorageAdapter,
    currency: CurrencyCode,
    correctionRevisionAssertion: AggregateCorrectionRevisionAssertion | null =
      null,
  ) {
    this.#storage = storage;
    this.#currency = requiredCurrency(currency);
    this.#correctionRevisionAssertion = correctionRevisionAssertion === null
      ? null
      : requiredCorrectionRevisionAssertion(correctionRevisionAssertion);
  }

  async readStored(): Promise<StoredInvestmentAggregateSnapshot> {
    const stored = await this.#readStoredRecord();
    return stored?.snapshot ?? zeroStoredSnapshot(this.#currency);
  }

  async calculate(): Promise<InvestmentAggregateSummary> {
    return calculatePersistedSummary(
      await this.#listContributions(),
      this.#currency,
    );
  }

  async applyContribution(
    request: ApplyAggregateContributionRequest,
  ): Promise<ApplyAggregateContributionResult> {
    const operationId = requiredOperationId(request.operationId);
    const expectedRevision = requiredStoredRevision(
      request.expectedStoredRevision,
    );
    const contribution = requiredContribution(
      request.contribution,
      this.#currency,
    );
    const fingerprint = await operationFingerprint({
      kind: "contribution",
      operationId,
      expectedStoredRevision: expectedRevision,
      contribution: contributionDocument(contribution),
    });
    const replay = await this.#readOperation(
      operationId,
      "contribution",
      fingerprint,
    );
    if (replay !== null) {
      return contributionResult(replay, true);
    }

    const aggregate = await this.#readStoredRecord();
    const stored = aggregate?.snapshot ?? zeroStoredSnapshot(this.#currency);
    if (stored.revision !== expectedRevision) preconditionFailed();

    const contributions = await this.#listContributions();
    const currentCalculated = calculatePersistedSummary(
      contributions,
      this.#currency,
    );
    const existing = contributions.find(
      (candidate) => candidate.indicationId === contribution.indicationId,
    );
    const disposition = classifyContribution(existing, contribution);

    if (disposition !== "applied") {
      const persisted = Object.freeze({
        disposition,
        stored,
        calculated: currentCalculated,
      });
      return contributionResult(
        await this.#writeOperationOnly(
          operationId,
          "contribution",
          fingerprint,
          persisted,
        ),
        false,
      );
    }

    const currentPreview = preview(stored, currentCalculated);
    if (currentPreview.correctionRequired) preconditionFailed();
    if (stored.revision === Number.MAX_SAFE_INTEGER) preconditionFailed();

    const nextContributions = existing === undefined
      ? [...contributions, contribution]
      : contributions.map((candidate) =>
          candidate.indicationId === contribution.indicationId
            ? contribution
            : candidate
        );
    const calculated = calculateRequestedSummary(
      nextContributions,
      this.#currency,
    );
    const nextStored = storedSnapshot(
      stored.revision + 1,
      calculated,
    );
    const persisted = Object.freeze({
      disposition,
      stored: nextStored,
      calculated,
    });
    const contributionKey = contributionStorageKey(contribution.indicationId);
    const existingContributionRecord = await this.#storage.read(contributionKey);
    if (
      (existing === undefined) !== (existingContributionRecord === null)
    ) {
      unavailable();
    }
    if (existingContributionRecord !== null) {
      if (existing === undefined) unavailable();
      const decoded = decodeContributionRecord(
        existingContributionRecord,
        this.#currency,
      );
      if (!sameContribution(decoded, existing)) unavailable();
    }

    const receipt = operationDocument(
      "contribution",
      fingerprint,
      persisted,
    );
    const transaction = await this.#storage.transact({
      operationId,
      mutations: [
        {
          type: "put",
          key: CURRENT_AGGREGATE_KEY,
          expectedRevision: aggregate?.record.revision ?? null,
          value: aggregateDocument(nextStored),
        },
        {
          type: "put",
          key: contributionKey,
          expectedRevision: existingContributionRecord?.revision ?? null,
          value: contributionDocument(contribution),
        },
        {
          type: "put",
          key: operationStorageKey(operationId),
          expectedRevision: null,
          value: receipt,
        },
      ],
    });

    const aggregateRecord = transaction.records[0];
    const contributionRecord = transaction.records[1];
    const operationRecord = transaction.records[2];
    if (!aggregateRecord || !contributionRecord || !operationRecord) {
      unavailable();
    }
    const decodedAggregate = decodeAggregateRecord(
      aggregateRecord,
      this.#currency,
    );
    const decodedContribution = decodeContributionRecord(
      contributionRecord,
      this.#currency,
    );
    if (
      !sameSnapshot(decodedAggregate, nextStored) ||
      !sameContribution(decodedContribution, contribution)
    ) {
      unavailable();
    }
    const decodedOperation = decodeOperationRecord(
      operationRecord,
      operationStorageKey(operationId),
      "contribution",
      fingerprint,
      this.#currency,
    );
    return contributionResult(decodedOperation, transaction.replayed);
  }

  async previewReconciliation(): Promise<InvestmentAggregateReconciliationPreview> {
    return (await this.previewReconciliationState()).preview;
  }

  async previewReconciliationState(): Promise<InvestmentAggregateReconciliationState> {
    const record = await this.#storage.read(CURRENT_AGGREGATE_KEY);
    let aggregate: StoredAggregateRecord | null = null;
    if (record !== null) {
      try {
        const decoded = decodeAggregateDocument(record, this.#currency);
        aggregate = Object.freeze({ record, ...decoded });
      } catch (error) {
        if (!(error instanceof StorageFailure) || error.code !== "UNAVAILABLE") {
          throw error;
        }
        const immutableCurrency = immutableAggregateCurrency(record);
        if (immutableCurrency === this.#currency) throw error;
        const decoded = decodeAggregateDocument(record, immutableCurrency);
        if (decoded.terminalReplay === null) throw error;
        aggregate = Object.freeze({ record, ...decoded });
      }
    }
    const stored = aggregate?.snapshot ?? zeroStoredSnapshot(this.#currency);
    const calculated = calculatePersistedSummary(
      await this.#listContributions(stored.currency),
      stored.currency,
    );
    const reconciliation = preview(stored, calculated);
    if (
      stored.currency !== this.#currency &&
      (aggregate?.terminalReplay === null || reconciliation.status !== "match")
    ) unavailable();
    return deepFreeze({
      preview: reconciliation,
      terminalReplay: reconciliation.status === "match"
        ? aggregate?.terminalReplay ?? null
        : null,
    });
  }

  async previewReconciliationStateForOwner(
    ownerSubject: ActorSubject,
  ): Promise<InvestmentAggregateReconciliationState> {
    const subject = requiredOwnerSubject(ownerSubject);
    const state = await this.previewReconciliationState();
    const terminalReplay = state.terminalReplay;
    if (terminalReplay === null) return state;

    const operationId = requiredOperationId(terminalReplay.operationId);
    const fingerprint = await operationFingerprint({
      kind: "audited-correction",
      operationId,
      expectedCampaignRevision: terminalReplay.expectedCampaignRevision,
      confirmation: requiredJsonValue(terminalReplay.confirmation),
      ownerSubject: subject,
    });
    try {
      const replay = await this.#readAuditedCorrectionReplay(
        operationId,
        fingerprint,
        subject,
      );
      if (replay === null || !sameSnapshot(replay.stored, state.preview.stored)) {
        unavailable();
      }
      return state;
    } catch (error) {
      if (error instanceof StorageFailure && error.code === "CONFLICT") {
        return deepFreeze({ preview: state.preview, terminalReplay: null });
      }
      throw error;
    }
  }

  async applyConfirmedCorrection(
    request: ApplyAggregateCorrectionRequest,
  ): Promise<ApplyAggregateCorrectionResult> {
    const operationId = requiredOperationId(request.operationId);
    const fingerprint = await operationFingerprint({
      kind: "correction",
      operationId,
      confirmation: requiredJsonValue(request.confirmation),
    });
    const replay = await this.#readOperation(
      operationId,
      "correction",
      fingerprint,
    );
    if (replay !== null) return correctionResult(replay, true);

    const aggregate = await this.#readStoredRecord();
    const stored = aggregate?.snapshot ?? zeroStoredSnapshot(this.#currency);
    const calculated = await this.calculate();
    const reconciliation = preview(stored, calculated);
    const confirmed = confirmCorrection(reconciliation, request.confirmation);
    const persisted = Object.freeze({
      preview: reconciliation,
      stored: confirmed.replacement,
    });
    const transaction = await this.#storage.transact({
      operationId,
      mutations: [
        {
          type: "put",
          key: CURRENT_AGGREGATE_KEY,
          expectedRevision: aggregate?.record.revision ?? null,
          value: aggregateDocument(confirmed.replacement),
        },
        {
          type: "put",
          key: operationStorageKey(operationId),
          expectedRevision: null,
          value: operationDocument(
            "correction",
            fingerprint,
            persisted,
          ),
        },
      ],
    });

    const aggregateRecord = transaction.records[0];
    const operationRecord = transaction.records[1];
    if (!aggregateRecord || !operationRecord) unavailable();
    const decodedAggregate = decodeAggregateRecord(
      aggregateRecord,
      this.#currency,
    );
    if (!sameSnapshot(decodedAggregate, confirmed.replacement)) unavailable();
    const decodedOperation = decodeOperationRecord(
      operationRecord,
      operationStorageKey(operationId),
      "correction",
      fingerprint,
      this.#currency,
    );
    return correctionResult(decodedOperation, transaction.replayed);
  }

  async applyConfirmedCorrectionWithAudit(
    request: ApplyAuditedAggregateCorrectionRequest,
  ): Promise<ApplyAuditedAggregateCorrectionResult> {
    const operationId = requiredOperationId(request.operationId);
    const expectedCampaignRevision = requiredCampaignRevision(
      request.expectedCampaignRevision,
    );
    const ownerSubject = requiredOwnerSubject(request.ownerSubject);
    const occurredAt = requiredOccurredAt(request.occurredAt);
    const fingerprint = await operationFingerprint({
      kind: "audited-correction",
      operationId,
      expectedCampaignRevision,
      confirmation: requiredJsonValue(request.confirmation),
      ownerSubject,
    });
    const replay = await this.#readAuditedCorrectionReplay(
      operationId,
      fingerprint,
      ownerSubject,
    );
    if (replay !== null) return replay;

    const revisionAssertion = this.#correctionRevisionAssertion;
    if (
      revisionAssertion === null ||
      revisionAssertion.expectedRevision !== expectedCampaignRevision
    ) {
      preconditionFailed();
    }

    const aggregate = await this.#readStoredRecord();
    const stored = aggregate?.snapshot ?? zeroStoredSnapshot(this.#currency);
    const calculated = await this.calculate();
    const reconciliation = preview(stored, calculated);
    const confirmed = confirmCorrection(reconciliation, request.confirmation);
    const auditEvent = await createAggregateReconciledAuditEvent(
      operationId,
      ownerSubject,
      occurredAt,
    );
    const preparedAudit = prepareAuditAppend({
      type: "append-audit-event",
      event: auditEvent,
    });
    if (preparedAudit.operationId !== operationId) unavailable();

    const persisted = Object.freeze({
      preview: reconciliation,
      stored: confirmed.replacement,
      auditEvent,
    });
    const terminalReplay = deepFreeze({
      operationId,
      expectedCampaignRevision,
      confirmation: correctionConfirmation(reconciliation),
    });
    const mutations = Object.freeze([
      {
        type: "put" as const,
        key: CURRENT_AGGREGATE_KEY,
        expectedRevision: aggregate?.record.revision ?? null,
        value: aggregateDocument(confirmed.replacement, terminalReplay),
      },
      {
        type: "put" as const,
        key: operationStorageKey(operationId),
        expectedRevision: null,
        value: operationDocument(
          "audited-correction",
          fingerprint,
          persisted,
        ),
      },
      preparedAudit.mutation,
      revisionAssertion,
    ]) satisfies readonly StorageMutation[];
    let transactionResult: unknown;
    try {
      transactionResult = await this.#storage.transact({
        operationId,
        mutations,
      });
    } catch (error) {
      if (!mayHaveCommittedAuditedCorrection(error)) throw error;
      const recovered = await this.#readAuditedCorrectionReplay(
        operationId,
        fingerprint,
        ownerSubject,
      );
      if (recovered !== null) return recovered;
      throw error;
    }

    const transaction = exactStorageTransactionResult(
      transactionResult,
      mutations,
    );
    const aggregateRecord = transaction.records[0];
    const operationRecord = transaction.records[1];
    if (!aggregateRecord || !operationRecord) unavailable();
    const decodedAggregate = decodeAggregateRecord(
      aggregateRecord,
      this.#currency,
    );
    if (!sameSnapshot(decodedAggregate, confirmed.replacement)) unavailable();
    const decodedOperation = decodeOperationRecord(
      operationRecord,
      operationStorageKey(operationId),
      "audited-correction",
      fingerprint,
      this.#currency,
    );
    const result = auditedCorrectionResult(
      decodedOperation,
      transaction.replayed,
    );
    const expectedAudit = transaction.replayed
      ? prepareAuditAppend({
          type: "append-audit-event",
          event: result.auditEvent,
        })
      : preparedAudit;
    verifyPreparedAuditAppend(expectedAudit, transaction.records[2]);
    verifyCorrectionRevisionAssertion(
      transaction.records[3],
      revisionAssertion,
    );
    await verifyAggregateReconciledAuditEvent(
      result.auditEvent,
      operationId,
      ownerSubject,
    );
    return result;
  }

  async readPublicAggregate(
    configuration: AmountAggregateConfiguration,
    publicTargetAmount: unknown | null,
  ): Promise<SanitizedPublicInvestmentAggregate | null> {
    const stored = await this.readStored();
    const result = createSanitizedPublicInvestmentAggregate(
      summaryFromStored(stored),
      configuration,
      publicTargetAmount,
    );
    if (!result.ok) invalidRequest();
    return result.value;
  }

  async #readStoredRecord(): Promise<StoredAggregateRecord | null> {
    const record = await this.#storage.read(CURRENT_AGGREGATE_KEY);
    if (record === null) return null;
    const decoded = decodeAggregateDocument(record, this.#currency);
    return Object.freeze({
      record,
      snapshot: decoded.snapshot,
      terminalReplay: decoded.terminalReplay,
    });
  }

  async #listContributions(
    currency: CurrencyCode = this.#currency,
  ): Promise<readonly InvestmentAggregateContribution[]> {
    const contributions: InvestmentAggregateContribution[] = [];
    const indicationIds = new Set<string>();
    const cursors = new Set<string>();
    let cursor: StorageCursor | undefined;
    let pageCount = 0;
    let listReads = 0;

    while (true) {
      if (
        pageCount >= MAX_AGGREGATE_CONTRIBUTION_LIST_PAGES ||
        listReads >= MAX_AGGREGATE_CONTRIBUTION_LIST_READS
      ) unavailable();
      listReads += 1;
      const page = requiredContributionPage(await this.#storage.list({
        collection: AGGREGATE_CONTRIBUTIONS,
        limit: MAX_STORAGE_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      }));
      pageCount += 1;
      if (
        contributions.length + page.items.length >
          MAX_AGGREGATE_CONTRIBUTION_RECORDS
      ) unavailable();
      for (const record of page.items) {
        const contribution = decodeContributionRecord(record, currency);
        if (indicationIds.has(contribution.indicationId)) unavailable();
        indicationIds.add(contribution.indicationId);
        contributions.push(contribution);
      }
      if (page.nextCursor === null) {
        break;
      }
      if (
        page.items.length === 0 ||
        pageCount >= MAX_AGGREGATE_CONTRIBUTION_LIST_PAGES ||
        listReads >= MAX_AGGREGATE_CONTRIBUTION_LIST_READS ||
        contributions.length >= MAX_AGGREGATE_CONTRIBUTION_RECORDS ||
        page.nextCursor === cursor ||
        cursors.has(page.nextCursor)
      ) unavailable();
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    return Object.freeze(contributions);
  }

  async #readOperation(
    operationId: StorageOperationId,
    kind: OperationKind,
    fingerprint: string,
  ): Promise<StoredOperationResult | null> {
    const key = operationStorageKey(operationId);
    const record = await this.#storage.read(key);
    return record === null
      ? null
      : decodeOperationRecord(
          record,
          key,
          kind,
          fingerprint,
          this.#currency,
        );
  }

  async #readAuditedCorrectionReplay(
    operationId: StorageOperationId,
    fingerprint: string,
    ownerSubject: ActorSubject,
  ): Promise<ApplyAuditedAggregateCorrectionResult | null> {
    const key = operationStorageKey(operationId);
    const record = await this.#storage.read(key);
    const replay = record === null
      ? null
      : decodeAuditedCorrectionReplayRecord(
          record,
          key,
          fingerprint,
        );
    if (replay === null) return null;

    const result = auditedCorrectionResult(replay, true);
    await verifyAggregateReconciledAuditEvent(
      result.auditEvent,
      operationId,
      ownerSubject,
    );
    const prepared = prepareAuditAppend({
      type: "append-audit-event",
      event: result.auditEvent,
    });
    verifyPreparedAuditAppend(
      prepared,
      await this.#storage.read(prepared.mutation.key),
    );
    return result;
  }

  async #writeOperationOnly(
    operationId: StorageOperationId,
    kind: OperationKind,
    fingerprint: string,
    result: StoredOperationResult,
  ): Promise<StoredOperationResult> {
    const key = operationStorageKey(operationId);
    const transaction = await this.#storage.transact({
      operationId,
      mutations: [
        {
          type: "put",
          key,
          expectedRevision: null,
          value: operationDocument(kind, fingerprint, result),
        },
      ],
    });
    const record = transaction.records[0];
    if (!record) unavailable();
    return decodeOperationRecord(
      record,
      key,
      kind,
      fingerprint,
      this.#currency,
    );
  }
}

/** Per-request configured-owner capability over persistent aggregate storage. */
export class OwnerBoundInvestmentAggregateCorrectionRepository
  implements CampaignRevisionBoundAggregateCorrectionRepository {
  readonly correctionConsistency = "atomic-aggregate-audit" as const;
  readonly campaignRevision: number;
  readonly #ownerSubject: ActorSubject;
  readonly #repository: DevelopmentInMemoryAggregateRepository;

  constructor(
    storage: StorageAdapter,
    ownerSubject: ActorSubject,
    currency: CurrencyCode,
    campaignRevisionAssertion: AggregateCorrectionRevisionAssertion,
  ) {
    this.#ownerSubject = requiredOwnerSubject(ownerSubject);
    const revisionAssertion = requiredCorrectionRevisionAssertion(
      campaignRevisionAssertion,
    );
    this.campaignRevision = revisionAssertion.expectedRevision;
    this.#repository = new DevelopmentInMemoryAggregateRepository(
      storage,
      requiredCurrency(currency),
      revisionAssertion,
    );
    Object.freeze(this);
  }

  previewReconciliation(): Promise<InvestmentAggregateReconciliationPreview> {
    return this.#repository.previewReconciliation();
  }

  previewReconciliationState(): Promise<InvestmentAggregateReconciliationState> {
    return this.#repository.previewReconciliationStateForOwner(
      this.#ownerSubject,
    );
  }

  applyConfirmedCorrectionWithAudit(
    request: ApplyAuditedAggregateCorrectionRequest,
  ): Promise<ApplyAuditedAggregateCorrectionResult> {
    let subject: ActorSubject;
    try {
      subject = requiredOwnerSubject(request.ownerSubject);
    } catch {
      return Promise.reject(new StorageFailure("NOT_FOUND"));
    }
    if (subject !== this.#ownerSubject) {
      return Promise.reject(new StorageFailure("NOT_FOUND"));
    }
    return this.#repository.applyConfirmedCorrectionWithAudit(request);
  }
}

function classifyContribution(
  current: InvestmentAggregateContribution | undefined,
  candidate: InvestmentAggregateContribution,
): AggregateContributionDisposition {
  if (current === undefined || candidate.indicationRevision > current.indicationRevision) {
    return "applied";
  }
  if (candidate.indicationRevision < current.indicationRevision) {
    return "superseded";
  }
  if (!sameContribution(current, candidate)) {
    throw new StorageFailure("CONFLICT");
  }
  return "duplicate";
}

async function parseAggregateContributionRequest(
  request: ApplyAggregateContributionRequest,
  currency: CurrencyCode,
): Promise<ParsedAggregateContributionRequest> {
  const operationId = requiredOperationId(request.operationId);
  const expectedStoredRevision = requiredStoredRevision(
    request.expectedStoredRevision,
  );
  const contribution = requiredContribution(request.contribution, currency);
  const fingerprint = await operationFingerprint({
    kind: "contribution",
    operationId,
    expectedStoredRevision,
    contribution: contributionDocument(contribution),
  });
  return deepFreeze({
    operationId,
    expectedStoredRevision,
    contribution,
    fingerprint,
  });
}

function applyContributionDelta(
  stored: StoredInvestmentAggregateSnapshot,
  current: InvestmentAggregateContribution | null,
  candidate: InvestmentAggregateContribution,
): StoredInvestmentAggregateSnapshot {
  if (stored.revision === Number.MAX_SAFE_INTEGER) preconditionFailed();
  const priorAmount = current?.status === "active" ? current.amount : 0;
  const nextAmount = candidate.status === "active" ? candidate.amount : 0;
  const priorCount = current?.status === "active" ? 1 : 0;
  const nextCount = candidate.status === "active" ? 1 : 0;
  if (
    stored.totalAmount < priorAmount ||
    stored.contributingIndicationCount < priorCount
  ) {
    unavailable();
  }
  const withoutPrior = stored.totalAmount - priorAmount;
  if (withoutPrior > Number.MAX_SAFE_INTEGER - nextAmount) invalidRequest();
  const countWithoutPrior = stored.contributingIndicationCount - priorCount;
  if (countWithoutPrior > Number.MAX_SAFE_INTEGER - nextCount) {
    invalidRequest();
  }
  return deepFreeze({
    revision: stored.revision + 1,
    totalAmount: (withoutPrior + nextAmount) as MinorUnits,
    currency: stored.currency,
    contributingIndicationCount: countWithoutPrior + nextCount,
  });
}

function requiredContribution(
  value: unknown,
  currency: CurrencyCode,
): InvestmentAggregateContribution {
  const source = objectRecord(value);
  if (source === null || !hasExactKeys(source, CONTRIBUTION_DOCUMENT_KEYS, [
    "kind",
    "schemaVersion",
  ])) {
    invalidRequest();
  }
  const indicationId = parseStableId<"investment-indication">(
    source.indicationId,
  );
  const amount = parseMinorUnits(source.amount);
  if (
    !indicationId.ok ||
    !amount.ok ||
    !Number.isSafeInteger(source.indicationRevision) ||
    (source.indicationRevision as number) < 1 ||
    (source.status !== "active" &&
      source.status !== "withdrawn" &&
      source.status !== "rejected") ||
    source.currency !== currency
  ) {
    invalidRequest();
  }

  const contribution = deepFreeze({
    indicationId: indicationId.value,
    indicationRevision: source.indicationRevision as number,
    status: source.status as InvestmentAggregateContribution["status"],
    amount: amount.value,
    currency,
  });
  calculateRequestedSummary([contribution], currency);
  return contribution;
}

function requiredAggregateWithdrawalContributions(
  value: unknown,
  currency: CurrencyCode,
): readonly InvestmentAggregateContribution[] {
  const length = Array.isArray(value) ? exactArrayLength(value) : null;
  const candidates = length === null ||
      length > MAX_ATOMIC_AGGREGATE_WITHDRAWAL_CONTRIBUTIONS
    ? null
    : exactArrayValues(value, length);
  if (candidates === null) invalidRequest();
  const contributions = candidates.map((candidate) =>
    requiredContribution(candidate, currency)
  );
  for (let index = 0; index < contributions.length; index += 1) {
    const candidate = contributions[index];
    const previous = contributions[index - 1];
    if (
      candidate === undefined ||
      candidate.status !== "withdrawn" ||
      (previous !== undefined &&
        previous.indicationId >= candidate.indicationId)
    ) {
      invalidRequest();
    }
  }
  return Object.freeze(contributions);
}

function aggregateDocument(
  snapshot: StoredInvestmentAggregateSnapshot,
  terminalReplay: AggregateCorrectionTerminalReplay | null = null,
): StorageDocument {
  return deepFreeze({
    kind: "investment-aggregate-state",
    schemaVersion: AGGREGATE_SCHEMA_VERSION,
    snapshot: snapshotDocument(snapshot),
    ...(terminalReplay === null
      ? {}
      : { terminalCorrectionReplay: terminalReplayDocument(terminalReplay) }),
  });
}

function terminalReplayDocument(
  replay: AggregateCorrectionTerminalReplay,
): StorageDocument {
  return {
    operationId: replay.operationId,
    expectedCampaignRevision: replay.expectedCampaignRevision,
    confirmation: {
      confirmation: replay.confirmation.confirmation,
      expectedStoredRevision: replay.confirmation.expectedStoredRevision,
      expectedStoredAmount: replay.confirmation.expectedStoredAmount,
      expectedStoredContributingIndicationCount:
        replay.confirmation.expectedStoredContributingIndicationCount,
      expectedCalculatedAmount: replay.confirmation.expectedCalculatedAmount,
      expectedCalculatedContributingIndicationCount:
        replay.confirmation.expectedCalculatedContributingIndicationCount,
    },
  };
}

function contributionDocument(
  contribution: InvestmentAggregateContribution,
): StorageDocument {
  return deepFreeze({
    kind: "investment-aggregate-contribution",
    schemaVersion: AGGREGATE_SCHEMA_VERSION,
    indicationId: contribution.indicationId,
    indicationRevision: contribution.indicationRevision,
    status: contribution.status,
    amount: contribution.amount,
    currency: contribution.currency,
  });
}

function operationDocument(
  operationKind: OperationKind,
  operationFingerprintValue: string,
  result: StoredOperationResult,
): StorageDocument {
  return deepFreeze({
    kind: "investment-aggregate-operation",
    schemaVersion: AGGREGATE_SCHEMA_VERSION,
    operationKind,
    operationFingerprint: operationFingerprintValue,
    result: operationKind === "contribution"
      ? contributionResultDocument(
          result as Omit<ApplyAggregateContributionResult, "replayed">,
        )
      : operationKind === "correction"
      ? correctionResultDocument(
          result as Omit<ApplyAggregateCorrectionResult, "replayed">,
        )
      : auditedCorrectionResultDocument(
          result as Omit<ApplyAuditedAggregateCorrectionResult, "replayed">,
        ),
  });
}

function contributionResultDocument(
  result: Omit<ApplyAggregateContributionResult, "replayed">,
): StorageDocument {
  return {
    disposition: result.disposition,
    stored: snapshotDocument(result.stored),
    calculated: summaryDocument(result.calculated),
  };
}

function correctionResultDocument(
  result: Omit<ApplyAggregateCorrectionResult, "replayed">,
): StorageDocument {
  return {
    preview: previewDocument(result.preview),
    stored: snapshotDocument(result.stored),
  };
}

function auditedCorrectionResultDocument(
  result: Omit<ApplyAuditedAggregateCorrectionResult, "replayed">,
): StorageDocument {
  return {
    preview: previewDocument(result.preview),
    stored: snapshotDocument(result.stored),
    auditEvent: requiredJsonValue(result.auditEvent) as StorageDocument,
  };
}

function snapshotDocument(
  snapshot: StoredInvestmentAggregateSnapshot,
): StorageDocument {
  return {
    revision: snapshot.revision,
    totalAmount: snapshot.totalAmount,
    currency: snapshot.currency,
    contributingIndicationCount: snapshot.contributingIndicationCount,
  };
}

function summaryDocument(summary: InvestmentAggregateSummary): StorageDocument {
  return {
    totalAmount: summary.totalAmount,
    currency: summary.currency,
    contributingIndicationCount: summary.contributingIndicationCount,
  };
}

function previewDocument(
  reconciliation: InvestmentAggregateReconciliationPreview,
): StorageDocument {
  return {
    status: reconciliation.status,
    stored: snapshotDocument(reconciliation.stored),
    calculated: summaryDocument(reconciliation.calculated),
    correctionRequired: reconciliation.correctionRequired,
  };
}

function decodeAggregateRecord(
  record: StorageRecord,
  currency: CurrencyCode,
): StoredInvestmentAggregateSnapshot {
  return decodeAggregateDocument(record, currency).snapshot;
}

function decodeAggregateDocument(
  record: StorageRecord,
  currency: CurrencyCode,
): Readonly<{
  snapshot: StoredInvestmentAggregateSnapshot;
  terminalReplay: AggregateCorrectionTerminalReplay | null;
}> {
  if (storageKeyString(record.key) !== storageKeyString(CURRENT_AGGREGATE_KEY)) {
    unavailable();
  }
  const source = objectRecord(record.value);
  if (
    source === null ||
    (!hasExactKeys(source, AGGREGATE_DOCUMENT_KEYS) &&
      !hasExactKeys(source, AGGREGATE_DOCUMENT_WITH_REPLAY_KEYS)) ||
    source.kind !== "investment-aggregate-state" ||
    source.schemaVersion !== AGGREGATE_SCHEMA_VERSION
  ) {
    unavailable();
  }
  const snapshot = decodeSnapshot(source.snapshot, currency);
  if (record.revision !== snapshot.revision || record.revision < 1) unavailable();
  const terminalReplay = Object.hasOwn(source, "terminalCorrectionReplay")
    ? decodeTerminalCorrectionReplay(
        source.terminalCorrectionReplay,
        snapshot,
        currency,
      )
    : null;
  return deepFreeze({ snapshot, terminalReplay });
}

function immutableAggregateCurrency(record: StorageRecord): CurrencyCode {
  try {
    if (storageKeyString(record.key) !== storageKeyString(CURRENT_AGGREGATE_KEY)) {
      unavailable();
    }
    const source = objectRecord(record.value);
    const snapshot = source === null ? null : objectRecord(source.snapshot);
    if (
      source === null ||
      snapshot === null ||
      (!hasExactKeys(source, AGGREGATE_DOCUMENT_KEYS) &&
        !hasExactKeys(source, AGGREGATE_DOCUMENT_WITH_REPLAY_KEYS)) ||
      source.kind !== "investment-aggregate-state" ||
      source.schemaVersion !== AGGREGATE_SCHEMA_VERSION ||
      !hasExactKeys(snapshot, SNAPSHOT_KEYS) ||
      typeof snapshot.currency !== "string" ||
      !/^[A-Z]{3}$/.test(snapshot.currency)
    ) unavailable();
    return snapshot.currency as CurrencyCode;
  } catch (error) {
    if (error instanceof StorageFailure) throw error;
    unavailable();
  }
}

function decodeTerminalCorrectionReplay(
  value: unknown,
  replacement: StoredInvestmentAggregateSnapshot,
  currency: CurrencyCode,
): AggregateCorrectionTerminalReplay {
  try {
    const source = objectRecord(value);
    if (
      source === null ||
      !hasExactKeys(source, TERMINAL_CORRECTION_REPLAY_KEYS)
    ) unavailable();
    const operationId = requiredOperationId(source.operationId);
    const expectedCampaignRevision = requiredCampaignRevision(
      source.expectedCampaignRevision,
    );
    const confirmationSource = objectRecord(source.confirmation);
    if (confirmationSource === null) unavailable();
    const storedRevision = requiredStoredRevision(
      confirmationSource.expectedStoredRevision,
    );
    const storedAmount = requiredMinorUnits(
      confirmationSource.expectedStoredAmount,
    );
    const storedCount = requiredStoredRevision(
      confirmationSource.expectedStoredContributingIndicationCount,
    );
    const calculatedAmount = requiredMinorUnits(
      confirmationSource.expectedCalculatedAmount,
    );
    const calculatedCount = requiredStoredRevision(
      confirmationSource.expectedCalculatedContributingIndicationCount,
    );
    const reconciliation = preview(
      deepFreeze({
        revision: storedRevision,
        totalAmount: storedAmount,
        currency,
        contributingIndicationCount: storedCount,
      }),
      deepFreeze({
        totalAmount: calculatedAmount,
        currency,
        contributingIndicationCount: calculatedCount,
      }),
    );
    const confirmed = confirmCorrection(reconciliation, confirmationSource);
    if (!sameSnapshot(confirmed.replacement, replacement)) unavailable();
    return deepFreeze({
      operationId,
      expectedCampaignRevision,
      confirmation: correctionConfirmation(reconciliation),
    });
  } catch (error) {
    if (error instanceof StorageFailure && error.code === "UNAVAILABLE") {
      throw error;
    }
    unavailable();
  }
}

function decodeContributionRecord(
  record: StorageRecord,
  currency: CurrencyCode,
): InvestmentAggregateContribution {
  if (
    record.key.collection !== AGGREGATE_CONTRIBUTIONS ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1
  ) {
    unavailable();
  }
  const source = objectRecord(record.value);
  if (
    source === null ||
    !hasExactKeys(source, CONTRIBUTION_DOCUMENT_KEYS) ||
    source.kind !== "investment-aggregate-contribution" ||
    source.schemaVersion !== AGGREGATE_SCHEMA_VERSION
  ) {
    unavailable();
  }
  let contribution: InvestmentAggregateContribution;
  try {
    contribution = requiredContribution(
      {
        indicationId: source.indicationId,
        indicationRevision: source.indicationRevision,
        status: source.status,
        amount: source.amount,
        currency: source.currency,
      },
      currency,
    );
  } catch {
    unavailable();
  }
  if ((record.key.id as string) !== (contribution.indicationId as string)) {
    unavailable();
  }
  return contribution;
}

function decodeOperationRecord(
  record: StorageRecord,
  expectedKey: StorageKey,
  expectedKind: OperationKind,
  expectedFingerprint: string,
  currency: CurrencyCode,
): StoredOperationResult {
  const result = decodeOperationResultValue(
    record,
    expectedKey,
    expectedKind,
    expectedFingerprint,
  );
  return expectedKind === "contribution"
    ? decodeContributionResult(result, currency)
    : expectedKind === "correction"
    ? decodeCorrectionResult(result, currency)
    : decodeAuditedCorrectionResult(result, currency);
}

function decodeAuditedCorrectionReplayRecord(
  record: StorageRecord,
  expectedKey: StorageKey,
  expectedFingerprint: string,
): Omit<ApplyAuditedAggregateCorrectionResult, "replayed"> {
  const result = decodeOperationResultValue(
    record,
    expectedKey,
    "audited-correction",
    expectedFingerprint,
  );
  return decodeAuditedCorrectionResult(
    result,
    immutableAuditedCorrectionCurrency(result),
  );
}

function decodeOperationResultValue(
  record: StorageRecord,
  expectedKey: StorageKey,
  expectedKind: OperationKind,
  expectedFingerprint: string,
): unknown {
  if (
    storageKeyString(record.key) !== storageKeyString(expectedKey) ||
    record.revision !== 1
  ) {
    unavailable();
  }
  const source = objectRecord(record.value);
  if (
    source === null ||
    !hasExactKeys(source, OPERATION_DOCUMENT_KEYS) ||
    source.kind !== "investment-aggregate-operation" ||
    source.schemaVersion !== AGGREGATE_SCHEMA_VERSION ||
    (source.operationKind !== "contribution" &&
      source.operationKind !== "correction" &&
      source.operationKind !== "audited-correction") ||
    typeof source.operationFingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(source.operationFingerprint)
  ) {
    unavailable();
  }
  if (
    source.operationKind !== expectedKind ||
    source.operationFingerprint !== expectedFingerprint
  ) {
    throw new StorageFailure("CONFLICT");
  }
  return source.result;
}

function decodeContributionResult(
  value: unknown,
  currency: CurrencyCode,
): Omit<ApplyAggregateContributionResult, "replayed"> {
  const source = objectRecord(value);
  if (
    source === null ||
    !hasExactKeys(source, CONTRIBUTION_RESULT_KEYS) ||
    (source.disposition !== "applied" &&
      source.disposition !== "duplicate" &&
      source.disposition !== "superseded")
  ) {
    unavailable();
  }
  const stored = decodeSnapshot(source.stored, currency);
  const calculated = decodeSummary(source.calculated, currency);
  if (
    source.disposition === "applied" &&
    (stored.totalAmount !== calculated.totalAmount ||
      stored.contributingIndicationCount !==
        calculated.contributingIndicationCount)
  ) {
    unavailable();
  }
  return deepFreeze({
    disposition: source.disposition,
    stored,
    calculated,
  });
}

function decodeCorrectionResult(
  value: unknown,
  currency: CurrencyCode,
): Omit<ApplyAggregateCorrectionResult, "replayed"> {
  const source = objectRecord(value);
  if (source === null || !hasExactKeys(source, CORRECTION_RESULT_KEYS)) {
    unavailable();
  }
  const reconciliation = decodePreview(source.preview, currency);
  const stored = decodeSnapshot(source.stored, currency);
  if (
    reconciliation.status !== "mismatch" ||
    !reconciliation.correctionRequired ||
    reconciliation.stored.revision === Number.MAX_SAFE_INTEGER ||
    stored.revision !== reconciliation.stored.revision + 1 ||
    stored.totalAmount !== reconciliation.calculated.totalAmount ||
    stored.currency !== reconciliation.calculated.currency ||
    stored.contributingIndicationCount !==
      reconciliation.calculated.contributingIndicationCount
  ) {
    unavailable();
  }
  return deepFreeze({ preview: reconciliation, stored });
}

function decodeAuditedCorrectionResult(
  value: unknown,
  currency: CurrencyCode,
): Omit<ApplyAuditedAggregateCorrectionResult, "replayed"> {
  const source = objectRecord(value);
  if (
    source === null ||
    !hasExactKeys(source, AUDITED_CORRECTION_RESULT_KEYS)
  ) {
    unavailable();
  }
  const correction = decodeCorrectionResult({
    preview: source.preview,
    stored: source.stored,
  }, currency);
  const prepared = prepareAuditAppend({
    type: "append-audit-event",
    event: source.auditEvent,
  });
  assertAggregateReconciledAuditEvent(prepared.event);
  return deepFreeze({ ...correction, auditEvent: prepared.event });
}

function immutableAuditedCorrectionCurrency(value: unknown): CurrencyCode {
  const source = objectRecord(value);
  const stored = source === null ? null : objectRecord(source.stored);
  const currency = stored?.currency;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    unavailable();
  }
  return currency as CurrencyCode;
}

function decodePreview(
  value: unknown,
  currency: CurrencyCode,
): InvestmentAggregateReconciliationPreview {
  const source = objectRecord(value);
  if (source === null || !hasExactKeys(source, PREVIEW_KEYS)) unavailable();
  const stored = decodeSnapshot(source.stored, currency);
  const calculated = decodeSummary(source.calculated, currency);
  const reconstructed = preview(stored, calculated);
  if (
    source.status !== reconstructed.status ||
    source.correctionRequired !== reconstructed.correctionRequired
  ) {
    unavailable();
  }
  return reconstructed;
}

function decodeSnapshot(
  value: unknown,
  currency: CurrencyCode,
): StoredInvestmentAggregateSnapshot {
  const source = objectRecord(value);
  if (
    source === null ||
    !hasExactKeys(source, SNAPSHOT_KEYS) ||
    !Number.isSafeInteger(source.revision) ||
    (source.revision as number) < 0 ||
    source.currency !== currency
  ) {
    unavailable();
  }
  const summary = decodeSummary({
    totalAmount: source.totalAmount,
    currency: source.currency,
    contributingIndicationCount: source.contributingIndicationCount,
  }, currency);
  return deepFreeze({
    revision: source.revision as number,
    ...summary,
  });
}

function decodeSummary(
  value: unknown,
  currency: CurrencyCode,
): InvestmentAggregateSummary {
  const source = objectRecord(value);
  if (
    source === null ||
    !hasExactKeys(source, SUMMARY_KEYS) ||
    source.currency !== currency ||
    !Number.isSafeInteger(source.contributingIndicationCount) ||
    (source.contributingIndicationCount as number) < 0
  ) {
    unavailable();
  }
  const amount = parseMinorUnits(source.totalAmount);
  if (!amount.ok) unavailable();
  return deepFreeze({
    totalAmount: amount.value,
    currency,
    contributingIndicationCount:
      source.contributingIndicationCount as number,
  });
}

function zeroStoredSnapshot(
  currency: CurrencyCode,
): StoredInvestmentAggregateSnapshot {
  return deepFreeze({
    revision: 0,
    totalAmount: 0 as MinorUnits,
    currency,
    contributingIndicationCount: 0,
  });
}

function storedSnapshot(
  revision: number,
  summary: InvestmentAggregateSummary,
): StoredInvestmentAggregateSnapshot {
  return deepFreeze({ revision, ...summary });
}

function summaryFromStored(
  stored: StoredInvestmentAggregateSnapshot,
): InvestmentAggregateSummary {
  return deepFreeze({
    totalAmount: stored.totalAmount,
    currency: stored.currency,
    contributingIndicationCount: stored.contributingIndicationCount,
  });
}

function calculatePersistedSummary(
  contributions: readonly InvestmentAggregateContribution[],
  currency: CurrencyCode,
): InvestmentAggregateSummary {
  try {
    return calculateInvestmentAggregateSummary(contributions, currency);
  } catch {
    unavailable();
  }
}

function calculateRequestedSummary(
  contributions: readonly InvestmentAggregateContribution[],
  currency: CurrencyCode,
): InvestmentAggregateSummary {
  try {
    return calculateInvestmentAggregateSummary(contributions, currency);
  } catch (error) {
    if (error instanceof DomainError) invalidRequest();
    unavailable();
  }
}

function preview(
  stored: StoredInvestmentAggregateSnapshot,
  calculated: InvestmentAggregateSummary,
): InvestmentAggregateReconciliationPreview {
  try {
    return previewInvestmentAggregateReconciliation(stored, calculated);
  } catch {
    unavailable();
  }
}

function confirmCorrection(
  reconciliation: InvestmentAggregateReconciliationPreview,
  confirmation: unknown,
) {
  try {
    const result = confirmInvestmentAggregateCorrection(
      reconciliation,
      confirmation,
    );
    if (!result.ok) invalidRequest();
    return result.value;
  } catch (error) {
    if (error instanceof DomainError && error.code === "PRECONDITION_FAILED") {
      preconditionFailed();
    }
    if (error instanceof StorageFailure) throw error;
    unavailable();
  }
}

function correctionConfirmation(
  reconciliation: InvestmentAggregateReconciliationPreview,
): InvestmentAggregateCorrectionConfirmation {
  return deepFreeze({
    confirmation: APPLY_CALCULATED_AGGREGATE_CONFIRMATION,
    expectedStoredRevision: reconciliation.stored.revision,
    expectedStoredAmount: reconciliation.stored.totalAmount,
    expectedStoredContributingIndicationCount:
      reconciliation.stored.contributingIndicationCount,
    expectedCalculatedAmount: reconciliation.calculated.totalAmount,
    expectedCalculatedContributingIndicationCount:
      reconciliation.calculated.contributingIndicationCount,
  });
}

function contributionResult(
  value: StoredOperationResult,
  replayed: boolean,
): ApplyAggregateContributionResult {
  if (!("disposition" in value)) unavailable();
  return deepFreeze({ ...value, replayed });
}

function correctionResult(
  value: StoredOperationResult,
  replayed: boolean,
): ApplyAggregateCorrectionResult {
  if (!("preview" in value) || "auditEvent" in value) unavailable();
  return deepFreeze({ ...value, replayed });
}

function auditedCorrectionResult(
  value: StoredOperationResult,
  replayed: boolean,
): ApplyAuditedAggregateCorrectionResult {
  if (!("preview" in value) || !("auditEvent" in value)) unavailable();
  return deepFreeze({ ...value, replayed });
}

function sameContribution(
  left: InvestmentAggregateContribution,
  right: InvestmentAggregateContribution,
): boolean {
  return (
    left.indicationId === right.indicationId &&
    left.indicationRevision === right.indicationRevision &&
    left.status === right.status &&
    left.amount === right.amount &&
    left.currency === right.currency
  );
}

function sameSnapshot(
  left: StoredInvestmentAggregateSnapshot,
  right: StoredInvestmentAggregateSnapshot,
): boolean {
  return (
    left.revision === right.revision &&
    left.totalAmount === right.totalAmount &&
    left.currency === right.currency &&
    left.contributingIndicationCount === right.contributingIndicationCount
  );
}

async function operationFingerprint(value: StorageDocument): Promise<string> {
  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalJson(value)),
    );
  } catch (error) {
    if (error instanceof StorageFailure) throw error;
    unavailable();
  }
  const hexadecimal = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hexadecimal}`;
}

async function createAggregateReconciledAuditEvent(
  operationId: StorageOperationId,
  ownerSubject: ActorSubject,
  occurredAt: Timestamp,
): Promise<AuditEvent> {
  const event = deepFreeze({
    id: await aggregateAuditEventId(operationId),
    operationId: requiredStableId<"audit-operation">(operationId),
    occurredAt,
    actor: { type: "owner" as const, subject: ownerSubject },
    detail: {
      kind: "resource-transition" as const,
      resource: {
        type: "aggregate" as const,
        id: requiredStableId<"audit-resource">("aggregate:investment-interest"),
      },
      transition: "reconciled" as const,
    },
  });
  await verifyAggregateReconciledAuditEvent(event, operationId, ownerSubject);
  return event;
}

async function verifyAggregateReconciledAuditEvent(
  event: AuditEvent,
  operationId: StorageOperationId,
  ownerSubject: ActorSubject,
): Promise<void> {
  assertAggregateReconciledAuditEvent(event);
  if (
    event.id !== await aggregateAuditEventId(operationId) ||
    (event.operationId as string) !== (operationId as string) ||
    event.actor.type !== "owner" ||
    event.actor.subject !== ownerSubject
  ) {
    unavailable();
  }
}

function assertAggregateReconciledAuditEvent(event: AuditEvent): void {
  if (
    event.actor.type !== "owner" ||
    event.detail.kind !== "resource-transition" ||
    event.detail.resource.type !== "aggregate" ||
    event.detail.resource.id !== "aggregate:investment-interest" ||
    event.detail.transition !== "reconciled"
  ) {
    unavailable();
  }
}

async function aggregateAuditEventId(
  operationId: StorageOperationId,
): Promise<StableId<"audit-event">> {
  const fingerprint = await operationFingerprint({
    kind: "aggregate-reconciliation-audit",
    operationId,
  });
  return requiredStableId<"audit-event">(
    `aggregate-audit:${fingerprint.slice("sha256:".length)}`,
  );
}

function requiredJsonValue(value: unknown): JsonValue {
  canonicalJson(value);
  return value as JsonValue;
}

function requiredContributionPage(value: unknown): StoragePage {
  try {
    const source = objectRecord(value);
    if (source === null || !hasExactKeys(source, STORAGE_PAGE_KEYS)) unavailable();
    const items = source.items;
    const nextCursor = source.nextCursor;
    if (
      !Array.isArray(items) ||
      items.length > MAX_STORAGE_PAGE_SIZE ||
      (nextCursor !== null &&
        (typeof nextCursor !== "string" ||
          nextCursor.length < 1 ||
          nextCursor.length > MAX_AGGREGATE_CONTRIBUTION_CURSOR_LENGTH))
    ) unavailable();
    return Object.freeze({
      items: Object.freeze([...items] as StorageRecord[]),
      nextCursor: nextCursor as StorageCursor | null,
    });
  } catch (error) {
    if (error instanceof StorageFailure) throw error;
    unavailable();
  }
}

function requiredCorrectionRevisionAssertion(
  value: AggregateCorrectionRevisionAssertion,
): AggregateCorrectionRevisionAssertion {
  try {
    const source = objectRecord(value);
    const key = source === null ? null : objectRecord(source.key);
    const parsedKey = key === null
      ? null
      : parseStorageKey(key.collection, key.id);
    if (
      source === null ||
      !hasExactKeys(source, REVISION_ASSERTION_KEYS) ||
      source.type !== "check" ||
      parsedKey === null ||
      !parsedKey.ok ||
      !Number.isSafeInteger(source.expectedRevision) ||
      (source.expectedRevision as number) < 1
    ) invalidRequest();
    const assertion = campaignSetupRevisionCheck(source.expectedRevision);
    if (storageKeyString(parsedKey.value) !== storageKeyString(assertion.key)) {
      invalidRequest();
    }
    return assertion;
  } catch (error) {
    if (error instanceof StorageFailure) throw error;
    invalidRequest();
  }
}

function requiredCampaignRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalidRequest();
  return value as number;
}

function mayHaveCommittedAuditedCorrection(error: unknown): boolean {
  return error instanceof StorageFailure &&
    (error.code === "CONFLICT" ||
      error.code === "PRECONDITION_FAILED" ||
      error.code === "UNAVAILABLE");
}

function verifyCorrectionRevisionAssertion(
  value: StorageRecord | null | undefined,
  assertion: AggregateCorrectionRevisionAssertion,
): void {
  verifyCampaignSetupRevisionCheckRecord(value, assertion.expectedRevision);
}

function exactStorageTransactionResult(
  value: unknown,
  mutations: readonly StorageMutation[],
): StorageTransactionResult {
  const source = exactDataObject(value, TRANSACTION_RESULT_KEYS);
  const records = source === null
    ? null
    : exactArrayValues(source.records, mutations.length);
  if (
    source === null ||
    typeof source.replayed !== "boolean" ||
    records === null
  ) unavailable();

  return Object.freeze({
    replayed: source.replayed,
    records: Object.freeze(records.map((record, index) => {
      const mutation = mutations[index];
      if (mutation === undefined) unavailable();
      return exactMutationResultRecord(record, mutation);
    })),
  });
}

function exactMutationResultRecord(
  value: unknown,
  mutation: StorageMutation,
): StorageRecord | null {
  if (mutation.type === "delete") {
    if (value !== null) unavailable();
    return null;
  }
  if (mutation.type === "check" && mutation.expectedRevision === null) {
    if (value !== null) unavailable();
    return null;
  }
  if (value === null) unavailable();

  const record = exactStorageRecord(value);
  const expectedRevision = mutation.type === "check"
    ? mutation.expectedRevision
    : (mutation.expectedRevision ?? 0) + 1;
  if (
    expectedRevision === null ||
    storageKeyString(record.key) !== storageKeyString(mutation.key) ||
    record.revision !== expectedRevision
  ) unavailable();

  if (mutation.type === "put") {
    try {
      if (canonicalJson(record.value) !== canonicalJson(mutation.value)) {
        unavailable();
      }
    } catch {
      unavailable();
    }
  }
  return record;
}

function exactStorageRecord(value: unknown): StorageRecord {
  const source = exactDataObject(value, STORAGE_RECORD_KEYS);
  const keySource = source === null
    ? null
    : exactDataObject(source.key, STORAGE_KEY_KEYS);
  const key = keySource === null
    ? null
    : parseStorageKey(keySource.collection, keySource.id);
  if (
    source === null ||
    key === null ||
    !key.ok ||
    !Number.isSafeInteger(source.revision) ||
    (source.revision as number) < 1
  ) unavailable();

  return Object.freeze({
    key: key.value,
    revision: source.revision as number,
    value: snapshotStorageDocument(source.value),
  });
}

function snapshotStorageDocument(value: unknown): StorageDocument {
  const snapshot = snapshotJsonValue(
    value,
    0,
    { nodes: 0, ancestors: new Set<object>() },
  );
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot)
  ) unavailable();
  return snapshot as StorageDocument;
}

function snapshotJsonValue(
  value: unknown,
  depth: number,
  state: { nodes: number; ancestors: Set<object> },
): JsonValue {
  state.nodes += 1;
  if (
    depth > MAX_AGGREGATE_TRANSACTION_RESULT_DEPTH ||
    state.nodes > MAX_AGGREGATE_TRANSACTION_RESULT_NODES
  ) unavailable();
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) unavailable();
    return value;
  }
  if (typeof value !== "object" || state.ancestors.has(value)) unavailable();

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length = exactArrayLength(value);
      const values = length === null ? null : exactArrayValues(value, length);
      if (values === null) unavailable();
      return Object.freeze(
        values.map((candidate) => snapshotJsonValue(candidate, depth + 1, state)),
      );
    }

    const entries = exactDataEntries(value);
    if (entries === null) unavailable();
    const snapshot: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    for (const [key, candidate] of entries) {
      snapshot[key] = snapshotJsonValue(candidate, depth + 1, state);
    }
    return Object.freeze(snapshot);
  } finally {
    state.ancestors.delete(value);
  }
}

function exactDataObject(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  const entries = exactDataEntries(value);
  if (
    entries === null ||
    entries.length !== expectedKeys.length ||
    entries.some(([key]) => !expectedKeys.includes(key))
  ) return null;
  return Object.freeze(Object.fromEntries(entries));
}

function exactDataEntries(
  value: unknown,
): readonly (readonly [string, unknown])[] | null {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return null;
    const entries: Array<readonly [string, unknown]> = [];
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) return null;
      entries.push(Object.freeze([key, descriptor.value] as const));
    }
    return Object.freeze(entries);
  } catch {
    return null;
  }
}

function exactArrayLength(value: readonly unknown[]): number | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    return descriptor !== undefined &&
        !descriptor.enumerable &&
        "value" in descriptor &&
        Number.isSafeInteger(descriptor.value) &&
        descriptor.value >= 0 &&
        descriptor.value <= MAX_AGGREGATE_TRANSACTION_RESULT_NODES
      ? descriptor.value as number
      : null;
  } catch {
    return null;
  }
}

function exactArrayValues(
  value: unknown,
  expectedLength: number,
): readonly unknown[] | null {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      exactArrayLength(value) !== expectedLength
    ) return null;
    const expectedKeys = [
      ...Array.from({ length: expectedLength }, (_, index) => String(index)),
      "length",
    ];
    const keys = Reflect.ownKeys(value);
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

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidRequest();
    return JSON.stringify(value);
  }
  if (typeof value !== "object") invalidRequest();
  if (ancestors.has(value)) invalidRequest();

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, nextAncestors)).join(",")}]`;
  }
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .sort()
    .map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(source[key], nextAncestors)}`
    )
    .join(",")}}`;
}

function requiredOperationId(value: unknown): StorageOperationId {
  const parsed = parseStorageOperationId(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function requiredStableId<Entity extends string>(
  value: unknown,
): StableId<Entity> {
  const parsed = parseStableId<Entity>(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function requiredOwnerSubject(value: unknown): ActorSubject {
  const parsed = parseActorSubject(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function requiredOccurredAt(value: unknown): Timestamp {
  const parsed = parseTimestamp(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function requiredStoredRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalidRequest();
  return value as number;
}

function requiredMinorUnits(value: unknown): MinorUnits {
  const parsed = parseMinorUnits(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function requiredCurrency(value: unknown): CurrencyCode {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) invalidRequest();
  return value as CurrencyCode;
}

function contributionStorageKey(indicationId: string): StorageKey {
  return requiredStorageKey(AGGREGATE_CONTRIBUTIONS, indicationId);
}

function operationStorageKey(operationId: StorageOperationId): StorageKey {
  return requiredStorageKey(AGGREGATE_OPERATIONS, operationId);
}

function requiredStorageKey(
  collection: StorageCollection,
  id: unknown,
): StorageKey {
  const parsed = parseStorageKey(collection, id);
  if (!parsed.ok) throw new Error("Invalid aggregate repository storage key.");
  return parsed.value;
}

function storageCollection(value: string): StorageCollection {
  const parsed = parseStorageCollection(value);
  if (!parsed.ok) throw new Error("Invalid aggregate repository collection.");
  return parsed.value;
}

function hasExactKeys(
  source: Record<string, unknown>,
  expected: ReadonlySet<string>,
  omitted: readonly string[] = [],
): boolean {
  const keys = Object.keys(source);
  const omittedKeys = new Set(omitted);
  return (
    keys.length === expected.size - omittedKeys.size &&
    keys.every((key) => expected.has(key) && !omittedKeys.has(key))
  );
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function invalidRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
}

function preconditionFailed(): never {
  throw new StorageFailure("PRECONDITION_FAILED");
}

function unavailable(): never {
  throw new StorageFailure("UNAVAILABLE");
}
