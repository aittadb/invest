import {
  parseAmountAggregateConfiguration,
  type AmountConfiguration,
} from "../domain/amount-aggregate-configuration.ts";
import type { AuditEvent } from "../domain/audit-notification.ts";
import type {
  FounderApplication,
  FounderApplicationId,
} from "../domain/founder-application.ts";
import {
  parseMinorUnits,
  parseStableId,
  parseTimestamp,
  type ActorSubject,
  type StableId,
  type Timestamp,
} from "../domain/foundation.ts";
import type { StoredInvestmentAggregateSnapshot } from "../domain/investment-aggregate.ts";
import type {
  InvestmentIndication,
  InvestmentIndicationId,
  InvestmentIndicationParsingOptions,
  WithdrawnInvestmentIndication,
} from "../domain/investment-indication.ts";
import {
  isParticipantProfileDescendantProjection,
  parseParticipantAccount,
  type ParticipantAccount,
  type ParticipantProfile,
} from "../domain/participant-profile.ts";
import {
  MAX_STORAGE_TRANSACTION_MUTATIONS,
  StorageFailure,
  parseStorageCollection,
  parseStorageKey,
  parseStorageOperationId,
  type StorageAdapter,
  type StorageCollection,
  type StorageDocument,
  type StorageKey,
  type StorageMutation,
  type StorageOperationId,
} from "../domain/storage-adapter.ts";
import {
  StorageFounderApplicationRepository,
} from "./in-memory-founder-application-repository.ts";
import {
  prepareAuditAppend,
  verifyPreparedAuditAppend,
  type PreparedAuditAppend,
} from "./in-memory-audit-notification-repositories.ts";
import {
  StorageParticipantRepository,
  verifyParticipantAccountDeletionRevision,
  type ParticipantProfileMutationResult,
  type RequestParticipantDeletionRequest,
} from "./in-memory-participant-repository.ts";
import { StagedStorageTransaction } from "./staged-storage-transaction.ts";
import {
  StorageParticipantInvestmentInterestRepository,
  stageParticipantAccountDeletionInvestmentWithdrawalSet,
  type PreparedParticipantAccountDeletionInvestmentWithdrawalSet,
} from "./storage-participant-investment-repository.ts";

const RECEIPT_SCHEMA_VERSION = 1;
const RECEIPTS = collection("participant-account-deletion-operations");
const REQUEST_KEYS = new Set([
  "operationId",
  "expectedRevision",
  "requestedAt",
]);
const RECEIPT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "operationFingerprint",
  "profileRevision",
  "requestedAt",
  "founderApplication",
  "investmentWithdrawals",
  "aggregate",
  "auditEventId",
  "mutationCount",
]);
const FOUNDER_KEYS = new Set(["id", "revision", "changed"]);
const WITHDRAWAL_KEYS = new Set([
  "indicationId",
  "indicationRevision",
  "historyEntryId",
]);
const AGGREGATE_KEYS = new Set([
  "revision",
  "totalAmount",
  "currency",
  "contributingIndicationCount",
]);
const STORAGE_RECORD_KEYS = new Set(["key", "revision", "value"]);
const STORAGE_KEY_KEYS = new Set(["collection", "id"]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MAX_ACCOUNT_DELETION_INVESTMENT_WITHDRAWALS = 4;

type ParsedAccountDeletionRequest = Readonly<{
  operationId: StorageOperationId;
  expectedRevision: number;
  requestedAt: Timestamp;
  operationFingerprint: string;
}>;

type StoredFounderDisposition = Readonly<{
  id: FounderApplicationId;
  revision: number;
  changed: boolean;
}>;

type StoredInvestmentWithdrawal = Readonly<{
  indicationId: InvestmentIndicationId;
  indicationRevision: number;
  historyEntryId: StableId<"investment-indication-history-entry">;
}>;

type StoredAccountDeletionReceipt = Readonly<{
  operationFingerprint: string;
  profileRevision: number;
  requestedAt: Timestamp;
  founderApplication: StoredFounderDisposition | null;
  investmentWithdrawals: readonly StoredInvestmentWithdrawal[];
  aggregate: StoredInvestmentAggregateSnapshot;
  auditEventId: StableId<"audit-event">;
  mutationCount: number;
}>;

/** Every participant-owned effect committed by one deletion request. */
export type ParticipantAccountDeletionResult =
  ParticipantProfileMutationResult &
    Readonly<{
      founderApplication: FounderApplication | null;
      investmentWithdrawals: readonly WithdrawnInvestmentIndication[];
      aggregate: StoredInvestmentAggregateSnapshot;
      auditEvent: AuditEvent;
      mutationCount: number;
    }>;

/** Narrow atomic capability composed into participant profile self-service. */
export interface AtomicParticipantAccountDeletionRepository {
  readonly deletionConsistency:
    "atomic-profile-founder-investment-aggregate-audit";
  requestAccountDeletion(
    request: RequestParticipantDeletionRequest,
  ): Promise<ParticipantAccountDeletionResult>;
}

/**
 * Subject-bound coordinator for one retry-stable account-deletion transaction.
 * Construction supplies deployment configuration; callers supply no identity.
 */
export class StorageParticipantAccountDeletionRepository
  implements AtomicParticipantAccountDeletionRepository {
  readonly deletionConsistency =
    "atomic-profile-founder-investment-aggregate-audit" as const;

  readonly #storage: StorageAdapter;
  readonly #account: ParticipantAccount | null;
  readonly #founderApplicationId: FounderApplicationId;
  readonly #amount: AmountConfiguration;
  readonly #parsingOptions: InvestmentIndicationParsingOptions;

  constructor(
    storage: StorageAdapter,
    authenticatedAccount: ParticipantAccount | null,
    founderApplicationId: FounderApplicationId,
    amountConfiguration: AmountConfiguration,
    parsingOptions: InvestmentIndicationParsingOptions = {},
  ) {
    this.#storage = requiredStorageAdapter(storage);
    this.#account = authenticatedAccount === null
      ? null
      : requiredParticipantAccount(authenticatedAccount);
    this.#founderApplicationId = requiredFounderApplicationId(
      founderApplicationId,
    );
    this.#amount = requiredAmountConfiguration(amountConfiguration);
    this.#parsingOptions = Object.freeze({ ...parsingOptions });
    Object.freeze(this);
  }

  async requestAccountDeletion(
    request: RequestParticipantDeletionRequest,
  ): Promise<ParticipantAccountDeletionResult> {
    try {
      const account = this.#requiredAccount();
      const parsed = await parseRequest(request, account.subject);
      const replay = await this.#replay(parsed);
      if (replay !== null) return replay;

      try {
        return await this.#commitNew(parsed);
      } catch (error) {
        const recovered = await this.#replay(parsed);
        if (recovered !== null) return recovered;
        throw error;
      }
    } catch (error) {
      sanitizedFailure(error);
    }
  }

  #requiredAccount(): ParticipantAccount {
    if (this.#account === null) notFound();
    return this.#account;
  }

  async #commitNew(
    request: ParsedAccountDeletionRequest,
  ): Promise<ParticipantAccountDeletionResult> {
    const account = this.#requiredAccount();
    const staged = new StagedStorageTransaction(
      this.#storage,
      request.operationId,
    );
    const participant = new StorageParticipantRepository(staged, account);
    const profile = await participant.requestAccountDeletion({
      operationId: request.operationId,
      expectedRevision: request.expectedRevision,
      requestedAt: request.requestedAt,
    });
    requireNewProfileResult(profile, request, account.subject);

    const founderRepository = new StorageFounderApplicationRepository(
      staged,
      account.subject,
      Object.freeze([]),
    );
    const founderBefore = await founderRepository.get(this.#founderApplicationId);
    let founderApplication = founderBefore;
    let founderChanged = false;
    if (founderBefore?.status === "received") {
      const withdrawn = await founderRepository.withdraw({
        operationId: request.operationId,
        id: this.#founderApplicationId,
        expectedRevision: founderBefore.revision,
        occurredAt: request.requestedAt,
        historyEntryId: await founderWithdrawalHistoryId(
          account.subject,
          request.operationId,
        ),
      });
      if (withdrawn.replayed) unavailable();
      founderApplication = withdrawn.snapshot;
      founderChanged = true;
    }

    const investments =
      await stageParticipantAccountDeletionInvestmentWithdrawalSet(
        staged,
        account.subject,
        this.#amount,
        {
          operationId: request.operationId,
          requestedAt: request.requestedAt,
        },
        this.#parsingOptions,
      );
    const audit = await preparedAudit(account.subject, request);
    await stageMutations(staged, request.operationId, [audit.mutation]);

    const receiptKey = await operationReceiptKey(
      account.subject,
      request.operationId,
    );
    const mutationCount = 2 +
      (founderChanged ? 2 : 0) +
      investments.mutationCount +
      2;
    if (mutationCount > MAX_STORAGE_TRANSACTION_MUTATIONS) unavailable();
    const receipt = receiptMutation(
      request,
      profile.revision,
      founderApplication,
      founderChanged,
      investments,
      audit,
      mutationCount,
      receiptKey,
    );
    await stageMutations(staged, request.operationId, [receipt]);

    const committed = await staged.commit();
    if (committed.records.length !== mutationCount) unavailable();
    const storedReceipt = decodeReceipt(
      committed.records.at(-1),
      receiptKey,
      this.#amount,
    );
    requireMatchingReceipt(
      storedReceipt,
      request,
      this.#founderApplicationId,
      audit,
    );
    const auditEvent = verifyPreparedAuditAppend(
      audit,
      committed.records[mutationCount - 2],
    );
    return deletionResult(
      profile,
      founderApplication,
      investments,
      auditEvent,
      mutationCount,
      committed.replayed,
    );
  }

  async #replay(
    request: ParsedAccountDeletionRequest,
  ): Promise<ParticipantAccountDeletionResult | null> {
    const account = this.#requiredAccount();
    const receiptKey = await operationReceiptKey(
      account.subject,
      request.operationId,
    );
    const record = await this.#storage.read(receiptKey);
    if (record === null) return null;
    const receipt = decodeReceipt(record, receiptKey, this.#amount);
    if (receipt.operationFingerprint !== request.operationFingerprint) {
      conflict();
    }
    const audit = await preparedAudit(account.subject, request);
    requireMatchingReceipt(
      receipt,
      request,
      this.#founderApplicationId,
      audit,
    );

    try {
      const profile = await verifyProfileReplay(this.#storage, account, request);
      const founderApplication = await verifyFounderReplay(
        this.#storage,
        account.subject,
        this.#founderApplicationId,
        request,
        receipt.founderApplication,
      );
      const investments = await verifyInvestmentReplay(
        this.#storage,
        account.subject,
        this.#amount,
        this.#parsingOptions,
        request,
        receipt,
      );
      const auditEvent = verifyPreparedAuditAppend(
        audit,
        await this.#storage.read(audit.mutation.key),
      );
      return deletionResult(
        profile,
        founderApplication,
        investments,
        auditEvent,
        receipt.mutationCount,
        true,
      );
    } catch {
      unavailable();
    }
  }
}

async function parseRequest(
  value: unknown,
  subject: ActorSubject,
): Promise<ParsedAccountDeletionRequest> {
  const source = exactInputRecord(value, REQUEST_KEYS);
  const operationId = parseStorageOperationId(source.operationId);
  const requestedAt = parseTimestamp(source.requestedAt);
  if (
    !operationId.ok ||
    !requestedAt.ok ||
    !Number.isSafeInteger(source.expectedRevision) ||
    (source.expectedRevision as number) < 1 ||
    (source.expectedRevision as number) >= Number.MAX_SAFE_INTEGER
  ) invalidRequest();
  const identity = Object.freeze({
    kind: "participant-account-deletion",
    subject,
    operationId: operationId.value,
    expectedRevision: source.expectedRevision as number,
    requestedAt: requestedAt.value,
  });
  return Object.freeze({
    operationId: operationId.value,
    expectedRevision: source.expectedRevision as number,
    requestedAt: requestedAt.value,
    operationFingerprint: await fingerprint(identity),
  });
}

function requireNewProfileResult(
  result: ParticipantProfileMutationResult,
  request: ParsedAccountDeletionRequest,
  subject: ActorSubject,
): void {
  if (
    result.replayed ||
    result.revision !== request.expectedRevision + 1 ||
    result.snapshot.subject !== subject ||
    result.snapshot.accountDeletionRequest.state !== "requested" ||
    result.snapshot.accountDeletionRequest.requestedAt !== request.requestedAt ||
    result.snapshot.accountDeletionRequest.activeInterestDisposition !==
      "withdraw" ||
    result.intents.length !== 1 ||
    result.intents[0]?.type !== "withdraw-active-interest" ||
    result.intents[0].subject !== subject ||
    result.intents[0].requestedAt !== request.requestedAt
  ) unavailable();
}

async function verifyProfileReplay(
  storage: StorageAdapter,
  account: ParticipantAccount,
  request: ParsedAccountDeletionRequest,
): Promise<ParticipantProfileMutationResult> {
  const participant = new StorageParticipantRepository(storage, account);
  const [deletion, current] = await Promise.all([
    verifyParticipantAccountDeletionRevision(storage, account, request),
    participant.current(),
  ]);
  if (
    current === null ||
    deletion.revision !== request.expectedRevision + 1
  ) unavailable();
  if (current.revision < deletion.revision) unavailable();
  if (
    current.revision === deletion.revision
      ? !sameProfile(current.snapshot, deletion.snapshot)
      : current.revision !== deletion.revision + 1 ||
        !isParticipantProfileDescendantProjection(
          deletion.snapshot,
          current.snapshot,
          1,
        )
  ) unavailable();
  return Object.freeze({
    revision: deletion.revision,
    snapshot: deletion.snapshot,
    replayed: true,
    intents: deletion.intents,
  });
}

async function verifyFounderReplay(
  storage: StorageAdapter,
  subject: ActorSubject,
  founderApplicationId: FounderApplicationId,
  request: ParsedAccountDeletionRequest,
  expected: StoredFounderDisposition | null,
): Promise<FounderApplication | null> {
  const current = await new StorageFounderApplicationRepository(
    storage,
    subject,
    Object.freeze([]),
  ).get(founderApplicationId);
  if (expected === null) {
    if (current !== null) unavailable();
    return null;
  }
  if (
    current === null ||
    current.id !== expected.id ||
    current.revision !== expected.revision ||
    current.status !== "withdrawn"
  ) unavailable();
  if (expected.changed) {
    const terminal = current.history.at(-1);
    if (
      terminal?.kind !== "withdrawn" ||
      terminal.occurredAt !== request.requestedAt ||
      terminal.id !== await founderWithdrawalHistoryId(
        subject,
        request.operationId,
      )
    ) unavailable();
  }
  return current;
}

async function verifyInvestmentReplay(
  storage: StorageAdapter,
  subject: ActorSubject,
  amount: AmountConfiguration,
  parsingOptions: InvestmentIndicationParsingOptions,
  request: ParsedAccountDeletionRequest,
  receipt: StoredAccountDeletionReceipt,
): Promise<PreparedParticipantAccountDeletionInvestmentWithdrawalSet> {
  const current = await new StorageParticipantInvestmentInterestRepository(
    storage,
    subject,
    amount,
    parsingOptions,
  ).listOwned();
  if (current.some(({ lifecycle }) => lifecycle.status === "active")) {
    unavailable();
  }
  const withdrawals: Array<
    PreparedParticipantAccountDeletionInvestmentWithdrawalSet["withdrawals"][number]
  > = [];
  for (const expected of receipt.investmentWithdrawals) {
    const candidate = current.find(({ id }) => id === expected.indicationId);
    if (candidate === undefined) unavailable();
    const indication = requiredWithdrawnIndication(candidate);
    const terminal = indication.history.at(-1);
    if (
      indication.lifecycle.withdrawnAt !== request.requestedAt ||
      indication.revision !== expected.indicationRevision ||
      terminal?.transition !== "withdrawn" ||
      terminal.id !== expected.historyEntryId ||
      terminal.occurredAt !== request.requestedAt ||
      terminal.actor.type !== "participant" ||
      terminal.actor.subject !== subject
    ) unavailable();
    withdrawals.push(Object.freeze({
      operationId: request.operationId,
      historyEntryId: expected.historyEntryId,
      indication,
    }));
  }
  return Object.freeze({
    participantSubject: subject,
    operationId: request.operationId,
    requestedAt: request.requestedAt,
    withdrawals: Object.freeze(withdrawals),
    aggregate: receipt.aggregate,
    mutationCount: withdrawals.length === 0
      ? 0
      : 4 * withdrawals.length + 3,
  });
}

async function preparedAudit(
  subject: ActorSubject,
  request: ParsedAccountDeletionRequest,
): Promise<PreparedAuditAppend> {
  const event: AuditEvent = Object.freeze({
    id: await derivedId<"audit-event">(
      "participant-deletion-audit",
      subject,
      request.operationId,
    ),
    operationId: await derivedId<"audit-operation">(
      "participant-deletion-operation",
      subject,
      request.operationId,
    ),
    occurredAt: request.requestedAt,
    actor: Object.freeze({ type: "participant", subject }),
    detail: Object.freeze({
      kind: "resource-transition",
      resource: Object.freeze({
        type: "participant-profile",
        id: await derivedId<"audit-resource">(
          "participant-profile-resource",
          subject,
        ),
      }),
      transition: "deletion-requested",
    }),
  });
  return prepareAuditAppend({ type: "append-audit-event", event });
}

function receiptMutation(
  request: ParsedAccountDeletionRequest,
  profileRevision: number,
  founderApplication: FounderApplication | null,
  founderChanged: boolean,
  investments: PreparedParticipantAccountDeletionInvestmentWithdrawalSet,
  audit: PreparedAuditAppend,
  mutationCount: number,
  key: StorageKey,
): StorageMutation {
  return Object.freeze({
    type: "put" as const,
    key,
    expectedRevision: null,
    value: Object.freeze({
      kind: "participant-account-deletion-operation",
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      operationFingerprint: request.operationFingerprint,
      profileRevision,
      requestedAt: request.requestedAt,
      founderApplication: founderApplication === null
        ? null
        : Object.freeze({
            id: founderApplication.id,
            revision: founderApplication.revision,
            changed: founderChanged,
          }),
      investmentWithdrawals: Object.freeze(
        investments.withdrawals.map(({ indication, historyEntryId }) =>
          Object.freeze({
            indicationId: indication.id,
            indicationRevision: indication.revision,
            historyEntryId,
          })
        ),
      ),
      aggregate: aggregateDocument(investments.aggregate),
      auditEventId: audit.event.id,
      mutationCount,
    }),
  });
}

function decodeReceipt(
  value: unknown,
  expectedKey: StorageKey,
  amount: AmountConfiguration,
): StoredAccountDeletionReceipt {
  const record = exactRecord(value, STORAGE_RECORD_KEYS);
  const key = exactRecord(record.key, STORAGE_KEY_KEYS);
  const source = exactRecord(record.value, RECEIPT_KEYS);
  const requestedAt = parseTimestamp(source.requestedAt);
  const auditEventId = parseStableId<"audit-event">(source.auditEventId);
  if (
    key.collection !== expectedKey.collection ||
    key.id !== expectedKey.id ||
    record.revision !== 1 ||
    source.kind !== "participant-account-deletion-operation" ||
    source.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    typeof source.operationFingerprint !== "string" ||
    !SHA256_PATTERN.test(source.operationFingerprint) ||
    !positiveInteger(source.profileRevision) ||
    !requestedAt.ok ||
    !auditEventId.ok ||
    !positiveInteger(source.mutationCount) ||
    source.mutationCount > MAX_STORAGE_TRANSACTION_MUTATIONS
  ) unavailable();
  const founderApplication = decodeFounderDisposition(source.founderApplication);
  const investmentWithdrawals = decodeInvestmentWithdrawals(
    source.investmentWithdrawals,
  );
  return Object.freeze({
    operationFingerprint: source.operationFingerprint,
    profileRevision: source.profileRevision,
    requestedAt: requestedAt.value,
    founderApplication,
    investmentWithdrawals,
    aggregate: decodeAggregate(source.aggregate, amount),
    auditEventId: auditEventId.value,
    mutationCount: source.mutationCount,
  });
}

function decodeFounderDisposition(
  value: unknown,
): StoredFounderDisposition | null {
  if (value === null) return null;
  const source = exactRecord(value, FOUNDER_KEYS);
  const id = parseStableId<"founder-application">(source.id);
  if (!id.ok || !positiveInteger(source.revision) || typeof source.changed !== "boolean") {
    unavailable();
  }
  return Object.freeze({
    id: id.value,
    revision: source.revision,
    changed: source.changed,
  });
}

function decodeInvestmentWithdrawals(
  value: unknown,
): readonly StoredInvestmentWithdrawal[] {
  const values = exactArray(
    value,
    MAX_ACCOUNT_DELETION_INVESTMENT_WITHDRAWALS,
  );
  const withdrawals = values.map((candidate) => {
    const source = exactRecord(candidate, WITHDRAWAL_KEYS);
    const indicationId = parseStableId<"investment-indication">(
      source.indicationId,
    );
    const historyEntryId =
      parseStableId<"investment-indication-history-entry">(
        source.historyEntryId,
      );
    if (
      !indicationId.ok ||
      !historyEntryId.ok ||
      !positiveInteger(source.indicationRevision)
    ) unavailable();
    return Object.freeze({
      indicationId: indicationId.value,
      indicationRevision: source.indicationRevision,
      historyEntryId: historyEntryId.value,
    });
  });
  for (let index = 0; index < withdrawals.length; index += 1) {
    const previous = withdrawals[index - 1];
    const current = withdrawals[index];
    if (
      current === undefined ||
      (previous !== undefined && previous.indicationId >= current.indicationId)
    ) unavailable();
  }
  return Object.freeze(withdrawals);
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

function requireMatchingReceipt(
  receipt: StoredAccountDeletionReceipt,
  request: ParsedAccountDeletionRequest,
  founderApplicationId: FounderApplicationId,
  audit: PreparedAuditAppend,
): void {
  const expectedMutations = 2 +
    (receipt.founderApplication?.changed ? 2 : 0) +
    (receipt.investmentWithdrawals.length === 0
      ? 0
      : 4 * receipt.investmentWithdrawals.length + 3) +
    2;
  if (
    receipt.operationFingerprint !== request.operationFingerprint ||
    receipt.profileRevision !== request.expectedRevision + 1 ||
    receipt.requestedAt !== request.requestedAt ||
    (receipt.founderApplication !== null &&
      receipt.founderApplication.id !== founderApplicationId) ||
    receipt.auditEventId !== audit.event.id ||
    receipt.mutationCount !== expectedMutations ||
    receipt.mutationCount > MAX_STORAGE_TRANSACTION_MUTATIONS
  ) unavailable();
}

function deletionResult(
  profile: ParticipantProfileMutationResult,
  founderApplication: FounderApplication | null,
  investments: PreparedParticipantAccountDeletionInvestmentWithdrawalSet,
  auditEvent: AuditEvent,
  mutationCount: number,
  replayed: boolean,
): ParticipantAccountDeletionResult {
  return Object.freeze({
    revision: profile.revision,
    snapshot: profile.snapshot,
    intents: profile.intents,
    replayed,
    founderApplication,
    investmentWithdrawals: Object.freeze(
      investments.withdrawals.map(({ indication }) => indication),
    ),
    aggregate: investments.aggregate,
    auditEvent,
    mutationCount,
  });
}

async function stageMutations(
  staged: StagedStorageTransaction,
  operationId: StorageOperationId,
  mutations: readonly StorageMutation[],
): Promise<void> {
  const result = await staged.transact(Object.freeze({ operationId, mutations }));
  if (result.replayed || result.records.length !== mutations.length) unavailable();
}

async function founderWithdrawalHistoryId(
  subject: ActorSubject,
  operationId: StorageOperationId,
): Promise<StableId<"founder-application-history-entry">> {
  return derivedId<"founder-application-history-entry">(
    "founder-deletion-history",
    subject,
    operationId,
  );
}

async function operationReceiptKey(
  subject: ActorSubject,
  operationId: StorageOperationId,
): Promise<StorageKey> {
  return requiredStorageKey(
    RECEIPTS,
    `participant-deletion:${await digest({ subject, operationId })}`,
  );
}

async function derivedId<Entity extends string>(
  namespace: string,
  ...values: readonly string[]
): Promise<StableId<Entity>> {
  const parsed = parseStableId<Entity>(
    `${namespace}:${await digest({ namespace, values })}`,
  );
  if (!parsed.ok) unavailable();
  return parsed.value;
}

async function fingerprint(value: unknown): Promise<string> {
  return `sha256:${await digest(value)}`;
}

async function digest(value: unknown): Promise<string> {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") unavailable();
  const result = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serialized),
  );
  return [...new Uint8Array(result)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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

function sameProfile(left: ParticipantProfile, right: ParticipantProfile): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requiredWithdrawnIndication(
  value: InvestmentIndication,
): WithdrawnInvestmentIndication {
  if (value.lifecycle.status !== "withdrawn") unavailable();
  return value as WithdrawnInvestmentIndication;
}

function exactInputRecord(
  value: unknown,
  keys: ReadonlySet<string>,
): Record<string, unknown> {
  try {
    return exactRecord(value, keys);
  } catch {
    invalidRequest();
  }
}

function exactRecord(
  value: unknown,
  expectedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    unavailable();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) unavailable();
  const source = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(source);
  if (
    keys.length !== expectedKeys.size ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
  ) unavailable();
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) unavailable();
    result[key] = descriptor.value;
  }
  return result;
}

function exactArray(value: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) unavailable();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.at(-1) !== "length") {
    unavailable();
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      keys[index] !== String(index) ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) unavailable();
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function requiredStorageAdapter(value: unknown): StorageAdapter {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as StorageAdapter).read !== "function" ||
    typeof (value as StorageAdapter).list !== "function" ||
    typeof (value as StorageAdapter).transact !== "function"
  ) invalidRequest();
  return value as StorageAdapter;
}

function requiredParticipantAccount(value: unknown): ParticipantAccount {
  const parsed = parseParticipantAccount(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function requiredFounderApplicationId(value: unknown): FounderApplicationId {
  const parsed = parseStableId<"founder-application">(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function requiredAmountConfiguration(value: unknown): AmountConfiguration {
  const parsed = parseAmountAggregateConfiguration({
    amount: value,
    publicAggregate: { visibility: "hidden" },
  });
  if (!parsed.ok) invalidRequest();
  return parsed.value.amount;
}

function requiredStorageKey(
  storageCollection: StorageCollection,
  id: unknown,
): StorageKey {
  const parsed = parseStorageKey(storageCollection, id);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function collection(value: string): StorageCollection {
  const parsed = parseStorageCollection(value);
  if (!parsed.ok) throw new Error("Invalid account-deletion collection.");
  return parsed.value;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function sanitizedFailure(error: unknown): never {
  if (error instanceof StorageFailure) throw new StorageFailure(error.code);
  unavailable();
}

function invalidRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
}

function notFound(): never {
  throw new StorageFailure("NOT_FOUND");
}

function conflict(): never {
  throw new StorageFailure("CONFLICT");
}

function unavailable(): never {
  throw new StorageFailure("UNAVAILABLE");
}
