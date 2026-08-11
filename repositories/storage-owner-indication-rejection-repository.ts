import {
  parseAmountAggregateConfiguration,
  type AmountConfiguration,
} from "../domain/amount-aggregate-configuration.ts";
import {
  createManualNotificationRecord,
  parseManualNotificationTemplate,
  type AuditEvent,
} from "../domain/audit-notification.ts";
import {
  parseActorSubject,
  parseMinorUnits,
  parseStableId,
  parseTimestamp,
  type ActorSubject,
  type StableId,
  type Timestamp,
} from "../domain/foundation.ts";
import {
  projectInvestmentIndicationForAggregation,
  type StoredInvestmentAggregateSnapshot,
} from "../domain/investment-aggregate.ts";
import {
  INVESTMENT_INDICATION_LIMITS,
  type InvestmentIndicationId,
  type InvestmentIndicationParsingOptions,
  type RejectedInvestmentIndication,
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
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import type {
  AtomicOwnerIndicationRejectionRepository,
  OwnerIndicationNotificationSnapshot,
  RejectIndicationWithEffectsRequest,
  RejectIndicationWithEffectsResult,
} from "../services/owner-indication-moderation.ts";
import {
  DevelopmentInMemoryAggregateRepository,
  prepareAtomicAggregateContribution,
  readAtomicAggregateContributionReplay,
} from "./in-memory-aggregate-repository.ts";
import {
  DevelopmentInMemoryManualNotificationRepository,
  prepareAuditAppend,
  readManualNotificationRevision,
  verifyPreparedAuditAppend,
  type ManualNotificationSnapshot,
  type PreparedAuditAppend,
} from "./in-memory-audit-notification-repositories.ts";
import {
  DevelopmentInMemoryIndicationRepository,
  MAX_INDICATION_CANONICAL_DEPTH,
  MAX_INDICATION_CANONICAL_NODES,
  ownerIndicationCurrentStorageKey,
} from "./in-memory-indication-repository.ts";

const RECEIPT_SCHEMA_VERSION = 1;
const RECEIPTS = collection("owner-indication-moderation-operations");
const RECEIPT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "operationFingerprint",
  "indicationId",
  "indicationRevision",
  "occurredAt",
  "aggregate",
  "auditEventId",
  "notificationId",
  "notificationRevision",
]);
const AGGREGATE_KEYS = new Set([
  "revision",
  "totalAmount",
  "currency",
  "contributingIndicationCount",
]);
const STORAGE_RECORD_KEYS = new Set(["key", "revision", "value"]);
const STORAGE_KEY_KEYS = new Set(["collection", "id"]);
const TRANSACTION_RESULT_KEYS = new Set(["replayed", "records"]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MAX_REVIEW_ID_LENGTH = 192;

/** Narrow structural bridge to TASK-102's deployment-key token boundary. */
export interface OwnerIndicationReviewIdResolver {
  currentKeyForReviewId(
    reviewId: unknown,
    ownerSubject: ActorSubject,
  ): Promise<StorageKey>;
}

type ParsedRejection = Readonly<{
  reviewId: string;
  indicationId: InvestmentIndicationId;
  operationId: StorageOperationId;
  expectedRevision: number;
  reason: string;
  ownerSubject: ActorSubject;
  occurredAt: Timestamp;
  operationFingerprint: string;
}>;

type StoredReceipt = Readonly<{
  operationFingerprint: string;
  indicationId: InvestmentIndicationId;
  indicationRevision: number;
  occurredAt: Timestamp;
  aggregate: StoredInvestmentAggregateSnapshot;
  auditEventId: StableId<"audit-event">;
  notificationId: StableId<"manual-notification">;
  notificationRevision: number;
}>;

/**
 * Owner-bound production rejection primitive. All durable effects and its
 * immutable retry receipt share one credential-bound adapter transaction.
 */
export class StorageOwnerIndicationRejectionRepository
  implements AtomicOwnerIndicationRejectionRepository {
  readonly moderationConsistency =
    "atomic-indication-aggregate-audit-notification" as const;

  readonly #storage: StorageAdapter;
  readonly #authenticatedSubject: ActorSubject | null;
  readonly #configuredOwnerSubject: ActorSubject | null;
  readonly #amount: AmountConfiguration;
  readonly #parsingOptions: InvestmentIndicationParsingOptions;
  readonly #reviewIds: OwnerIndicationReviewIdResolver;
  readonly #indications: DevelopmentInMemoryIndicationRepository;

  constructor(
    storage: StorageAdapter,
    authenticatedSubject: ActorSubject | null,
    configuredOwnerSubject: ActorSubject | null,
    amountConfiguration: AmountConfiguration,
    reviewIds: OwnerIndicationReviewIdResolver,
    parsingOptions: InvestmentIndicationParsingOptions = {},
  ) {
    this.#storage = requiredStorageAdapter(storage);
    this.#authenticatedSubject = optionalSubject(authenticatedSubject);
    this.#configuredOwnerSubject = optionalSubject(configuredOwnerSubject);
    this.#amount = requiredAmountConfiguration(amountConfiguration);
    this.#reviewIds = requiredReviewIdResolver(reviewIds);
    this.#parsingOptions = Object.freeze({ ...parsingOptions });
    this.#indications = new DevelopmentInMemoryIndicationRepository(
      this.#storage,
      this.#authenticatedSubject,
      this.#configuredOwnerSubject,
      this.#amount,
      this.#parsingOptions,
    );
    Object.freeze(this);
  }

  async rejectWithEffects(
    request: RejectIndicationWithEffectsRequest,
  ): Promise<RejectIndicationWithEffectsResult> {
    try {
      this.#requireOwner();
      const parsed = await parseRequest(request);
      if (parsed.ownerSubject !== this.#configuredOwnerSubject) notFound();
      const expectedKey = await ownerIndicationCurrentStorageKey(
        parsed.indicationId,
      );
      let resolvedKey: StorageKey;
      try {
        resolvedKey = requiredReviewStorageKey(
          await this.#reviewIds.currentKeyForReviewId(
            parsed.reviewId,
            parsed.ownerSubject,
          ),
        );
      } catch {
        notFound();
      }
      if (storageKeyString(resolvedKey) !== storageKeyString(expectedKey)) {
        notFound();
      }

      const known = await this.#replay(parsed);
      if (known !== null) return known;

      try {
        return await this.#commitNew(parsed);
      } catch (error) {
        if (
          error instanceof StorageFailure &&
          (error.code === "CONFLICT" ||
            error.code === "PRECONDITION_FAILED")
        ) {
          const replay = await this.#replay(parsed);
          if (replay !== null) return replay;
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof StorageFailure) {
        throw new StorageFailure(error.code);
      }
      unavailable();
    }
  }

  #requireOwner(): void {
    if (
      this.#authenticatedSubject === null ||
      this.#configuredOwnerSubject === null ||
      this.#authenticatedSubject !== this.#configuredOwnerSubject
    ) {
      notFound();
    }
  }

  async #commitNew(
    request: ParsedRejection,
  ): Promise<RejectIndicationWithEffectsResult> {
    const staged = new StagedStorageTransaction(
      this.#storage,
      request.operationId,
    );
    const indications = new DevelopmentInMemoryIndicationRepository(
      staged,
      request.ownerSubject,
      request.ownerSubject,
      this.#amount,
      this.#parsingOptions,
    );
    const indication = await indications.reject(
      await indicationRequest(request),
    );
    if (indication.replayed) conflict();
    const rejected = requiredRejected(indication.snapshot, request);

    const aggregateBefore = await new DevelopmentInMemoryAggregateRepository(
      staged,
      this.#amount.currency,
    ).readStored();
    const contribution = projectInvestmentIndicationForAggregation(rejected);
    const aggregate = await prepareAtomicAggregateContribution(staged, {
      operationId: request.operationId,
      expectedStoredRevision: aggregateBefore.revision,
      contribution,
    }, this.#amount.currency);
    await staged.stage(aggregate.mutations);

    const notificationExpected = await notificationSnapshot(request, rejected);
    const notification = await new DevelopmentInMemoryManualNotificationRepository(
      staged,
    ).create({
      operationId: request.operationId,
      template: notificationExpected.record.template,
    });
    requireMatchingNotification(notification, notificationExpected);

    const audit = await preparedAudit(request, rejected);
    await staged.stage([audit.mutation]);

    const receiptKey = await operationReceiptKey(request.operationId);
    await staged.stage([
      receiptMutation(
        request,
        aggregate.result.stored,
        audit,
        notificationExpected,
        receiptKey,
      ),
    ]);
    const storageRequest = staged.request();
    const auditIndex = mutationIndex(storageRequest, audit.mutation.key);
    const transaction = await this.#storage.transact(storageRequest);
    staged.verify(transaction);

    const receipt = decodeReceipt(
      transaction.records.at(-1),
      receiptKey,
      this.#amount,
    );
    requireMatchingReceipt(receipt, request, audit, notificationExpected);
    const auditEvent = verifyPreparedAuditAppend(
      audit,
      transaction.records[auditIndex],
    );

    return result(
      request.reviewId,
      rejected,
      aggregate.result.stored,
      auditEvent,
      notificationExpected,
      transaction.replayed,
    );
  }

  async #replay(
    request: ParsedRejection,
  ): Promise<RejectIndicationWithEffectsResult | null> {
    const receiptKey = await operationReceiptKey(request.operationId);
    const stored = await this.#storage.read(receiptKey);
    if (stored === null) return null;
    const receipt = decodeReceipt(stored, receiptKey, this.#amount);
    if (
      receipt.operationFingerprint !== request.operationFingerprint ||
      receipt.indicationId !== request.indicationId ||
      receipt.indicationRevision !== request.expectedRevision + 1
    ) {
      conflict();
    }

    const effective = Object.freeze({
      ...request,
      occurredAt: receipt.occurredAt,
    });
    const indication = await this.#indications.reject(
      await indicationRequest(effective),
    );
    if (!indication.replayed) unavailable();
    const rejected = requiredRejected(indication.snapshot, effective);

    const aggregate = await readAtomicAggregateContributionReplay(
      this.#storage,
      {
        operationId: request.operationId,
        expectedStoredRevision: receipt.aggregate.revision - 1,
        contribution: projectInvestmentIndicationForAggregation(rejected),
      },
      this.#amount.currency,
    );
    if (
      aggregate === null ||
      aggregate.disposition !== "applied" ||
      !sameAggregate(aggregate.stored, receipt.aggregate)
    ) {
      unavailable();
    }

    const audit = await preparedAudit(effective, rejected);
    const auditRecord = await this.#storage.read(audit.mutation.key);
    const auditEvent = verifyPreparedAuditAppend(audit, auditRecord);
    const expectedNotification = await notificationSnapshot(effective, rejected);
    const notification = await readManualNotificationRevision(
      this.#storage,
      receipt.notificationId,
      receipt.notificationRevision,
    );
    if (notification === null) unavailable();
    requireMatchingNotification(notification, expectedNotification);
    requireMatchingReceipt(receipt, effective, audit, expectedNotification);

    return result(
      request.reviewId,
      rejected,
      receipt.aggregate,
      auditEvent,
      expectedNotification,
      true,
    );
  }
}

async function parseRequest(value: unknown): Promise<ParsedRejection> {
  const source = exactInputRecord(value, new Set([
    "reviewId",
    "indicationId",
    "operationId",
    "expectedRevision",
    "reason",
    "ownerSubject",
    "occurredAt",
  ]));
  if (
    typeof source.reviewId !== "string" ||
    source.reviewId.length < 1 ||
    source.reviewId.length > MAX_REVIEW_ID_LENGTH ||
    hasUnsafeTokenCharacter(source.reviewId)
  ) invalid();
  const indicationId = parseStableId<"investment-indication">(
    source.indicationId,
  );
  const operationId = parseStorageOperationId(source.operationId);
  const ownerSubject = parseActorSubject(source.ownerSubject);
  const occurredAt = parseTimestamp(source.occurredAt);
  if (
    !indicationId.ok ||
    !operationId.ok ||
    !ownerSubject.ok ||
    !occurredAt.ok ||
    !Number.isSafeInteger(source.expectedRevision) ||
    (source.expectedRevision as number) < 1 ||
    (source.expectedRevision as number) >= Number.MAX_SAFE_INTEGER
  ) invalid();
  const reason = normalizedReason(source.reason);
  const identity = Object.freeze({
    reviewId: source.reviewId,
    indicationId: indicationId.value,
    operationId: operationId.value,
    expectedRevision: source.expectedRevision as number,
    reason,
    ownerSubject: ownerSubject.value,
  });
  return Object.freeze({
    ...identity,
    occurredAt: occurredAt.value,
    operationFingerprint: await fingerprint(identity),
  });
}

async function indicationRequest(request: ParsedRejection) {
  return Object.freeze({
    operationId: request.operationId,
    id: request.indicationId,
    expectedRevision: request.expectedRevision,
    occurredAt: request.occurredAt,
    historyEntryId: await derivedId<"investment-indication-history-entry">(
      "indication-rejection-history",
      request.operationId,
    ),
    reason: request.reason,
  });
}

function requiredRejected(
  value: RejectedInvestmentIndication,
  request: ParsedRejection,
): RejectedInvestmentIndication {
  const rejection = value.lifecycle.rejection;
  const history = value.history.at(-1);
  if (
    value.id !== request.indicationId ||
    value.revision !== request.expectedRevision + 1 ||
    value.lifecycle.status !== "rejected" ||
    rejection.reason !== request.reason ||
    rejection.rejectedAt !== request.occurredAt ||
    rejection.rejectedBy.type !== "owner" ||
    rejection.rejectedBy.subject !== request.ownerSubject ||
    history?.transition !== "rejected" ||
    history.occurredAt !== request.occurredAt
  ) unavailable();
  return value;
}

async function preparedAudit(
  request: ParsedRejection,
  indication: RejectedInvestmentIndication,
): Promise<PreparedAuditAppend> {
  const event: AuditEvent = Object.freeze({
    id: await derivedId<"audit-event">(
      "indication-rejection-audit",
      request.operationId,
    ),
    operationId: requiredStableId<"audit-operation">(request.operationId),
    occurredAt: request.occurredAt,
    actor: Object.freeze({ type: "owner", subject: request.ownerSubject }),
    detail: Object.freeze({
      kind: "resource-transition",
      resource: Object.freeze({
        type: "investment-indication",
        id: requiredStableId<"audit-resource">(indication.id),
      }),
      transition: "rejected",
    }),
  });
  return prepareAuditAppend({ type: "append-audit-event", event });
}

async function notificationSnapshot(
  request: ParsedRejection,
  indication: RejectedInvestmentIndication,
): Promise<OwnerIndicationNotificationSnapshot> {
  const template = parseManualNotificationTemplate({
    id: await derivedId<"manual-notification">(
      "indication-rejection-notification",
      request.operationId,
    ),
    purposeId: await derivedId<"notification-purpose">(
      "indication-rejection-purpose",
      request.operationId,
    ),
    recipientSubject: indication.participantSubject,
    relatedResource: {
      type: "investment-indication",
      id: requiredStableId<"audit-resource">(indication.id),
    },
    subjectLine: "Update about your investment indication",
    body: `Your investment indication was rejected.\n\nReason: ${request.reason}`,
    generatedAt: request.occurredAt,
    generatedBy: { type: "owner", subject: request.ownerSubject },
  });
  if (!template.ok) invalid();
  return Object.freeze({
    revision: 1,
    record: createManualNotificationRecord(template.value),
  });
}

function receiptMutation(
  request: ParsedRejection,
  aggregate: StoredInvestmentAggregateSnapshot,
  audit: PreparedAuditAppend,
  notification: OwnerIndicationNotificationSnapshot,
  key: StorageKey,
): StorageMutation {
  return Object.freeze({
    type: "put" as const,
    key,
    expectedRevision: null,
    value: Object.freeze({
      kind: "owner-indication-rejection-operation",
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      operationFingerprint: request.operationFingerprint,
      indicationId: request.indicationId,
      indicationRevision: request.expectedRevision + 1,
      occurredAt: request.occurredAt,
      aggregate: aggregateDocument(aggregate),
      auditEventId: audit.event.id,
      notificationId: notification.record.template.id,
      notificationRevision: notification.revision,
    }),
  });
}

function decodeReceipt(
  value: StorageRecord | null | undefined,
  expectedKey: StorageKey,
  amount: AmountConfiguration,
): StoredReceipt {
  if (!value) unavailable();
  const envelope = exactRecord(value, STORAGE_RECORD_KEYS);
  const key = exactRecord(envelope.key, STORAGE_KEY_KEYS);
  const source = exactRecord(envelope.value, RECEIPT_KEYS);
  const indicationId = parseStableId<"investment-indication">(
    source.indicationId,
  );
  const occurredAt = parseTimestamp(source.occurredAt);
  const auditEventId = parseStableId<"audit-event">(source.auditEventId);
  const notificationId = parseStableId<"manual-notification">(
    source.notificationId,
  );
  if (
    key.collection !== expectedKey.collection ||
    key.id !== expectedKey.id ||
    envelope.revision !== 1 ||
    source.kind !== "owner-indication-rejection-operation" ||
    source.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    typeof source.operationFingerprint !== "string" ||
    !SHA256_PATTERN.test(source.operationFingerprint) ||
    !indicationId.ok ||
    !occurredAt.ok ||
    !auditEventId.ok ||
    !notificationId.ok ||
    !positiveInteger(source.indicationRevision) ||
    source.notificationRevision !== 1
  ) unavailable();
  return Object.freeze({
    operationFingerprint: source.operationFingerprint,
    indicationId: indicationId.value,
    indicationRevision: source.indicationRevision,
    occurredAt: occurredAt.value,
    aggregate: decodeAggregate(source.aggregate, amount),
    auditEventId: auditEventId.value,
    notificationId: notificationId.value,
    notificationRevision: 1,
  });
}

function requireMatchingReceipt(
  receipt: StoredReceipt,
  request: ParsedRejection,
  audit: PreparedAuditAppend,
  notification: OwnerIndicationNotificationSnapshot,
): void {
  if (
    receipt.operationFingerprint !== request.operationFingerprint ||
    receipt.indicationId !== request.indicationId ||
    receipt.indicationRevision !== request.expectedRevision + 1 ||
    receipt.occurredAt !== request.occurredAt ||
    receipt.auditEventId !== audit.event.id ||
    receipt.notificationId !== notification.record.template.id ||
    receipt.notificationRevision !== notification.revision
  ) unavailable();
}

function result(
  reviewId: string,
  indication: RejectedInvestmentIndication,
  aggregate: StoredInvestmentAggregateSnapshot,
  auditEvent: AuditEvent,
  notification: OwnerIndicationNotificationSnapshot,
  replayed: boolean,
): RejectIndicationWithEffectsResult {
  return Object.freeze({
    item: Object.freeze({ reviewId, indication, notification }),
    aggregate: Object.freeze({
      contribution: projectInvestmentIndicationForAggregation(indication),
      stored: aggregate,
    }),
    auditEvent,
    notification,
    replayed,
  });
}

function requireMatchingNotification(
  actual: ManualNotificationSnapshot,
  expected: OwnerIndicationNotificationSnapshot,
): void {
  const left = actual.record.template;
  const right = expected.record.template;
  if (
    actual.revision !== expected.revision ||
    left.id !== right.id ||
    left.purposeId !== right.purposeId ||
    left.recipientSubject !== right.recipientSubject ||
    left.relatedResource.type !== right.relatedResource.type ||
    left.relatedResource.id !== right.relatedResource.id ||
    left.subjectLine !== right.subjectLine ||
    left.body !== right.body ||
    left.generatedAt !== right.generatedAt ||
    left.generatedBy.type !== "owner" ||
    right.generatedBy.type !== "owner" ||
    left.generatedBy.subject !== right.generatedBy.subject ||
    actual.record.copyEvidence.length !== 0 ||
    actual.record.sentMarker !== null
  ) unavailable();
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

function sameAggregate(
  left: StoredInvestmentAggregateSnapshot,
  right: StoredInvestmentAggregateSnapshot,
): boolean {
  return left.revision === right.revision &&
    left.totalAmount === right.totalAmount &&
    left.currency === right.currency &&
    left.contributingIndicationCount === right.contributingIndicationCount;
}

async function operationReceiptKey(
  operationId: StorageOperationId,
): Promise<StorageKey> {
  return requiredStorageKey(
    RECEIPTS,
    `owner-rejection:${await sha256Hex(`owner-rejection\u0000${operationId}`)}`,
  );
}

async function derivedId<Entity extends string>(
  namespace: string,
  operationId: StorageOperationId,
): Promise<StableId<Entity>> {
  return requiredStableId<Entity>(
    `${namespace}:${await sha256Hex(`${namespace}\u0000${operationId}`)}`,
  );
}

async function fingerprint(value: unknown): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(value))}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizedReason(value: unknown): string {
  if (typeof value !== "string") invalid();
  const reason = value.replace(/\r\n?/gu, "\n").trim();
  if (
    reason.length < 1 ||
    reason.length > INVESTMENT_INDICATION_LIMITS.rejectionReasonLength ||
    hasUnsafeMultilineCharacter(reason)
  ) invalid();
  return reason;
}

function hasUnsafeMultilineCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined) return true;
    if (code <= 31 || code === 127) {
      if (character === "\n" || character === "\t") continue;
      return true;
    }
    if (
      code === 0x061c ||
      code >= 0x200e && code <= 0x200f ||
      code >= 0x202a && code <= 0x202e ||
      code >= 0x2066 && code <= 0x2069
    ) return true;
  }
  return false;
}

function hasUnsafeTokenCharacter(value: string): boolean {
  return !/^[A-Za-z0-9._-]+$/u.test(value);
}

function mutationIndex(
  request: StorageTransactionRequest,
  key: StorageKey,
): number {
  const identity = storageKeyString(key);
  const index = request.mutations.findIndex((mutation) =>
    storageKeyString(mutation.key) === identity
  );
  if (index < 0) unavailable();
  return index;
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

  list(request: StorageListRequest): Promise<StoragePage> {
    if (this.#collections.has(request.collection)) unavailable();
    return this.#storage.list(request);
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    const normalized = normalizeStorageTransactionRequest(request);
    if (normalized.operationId !== this.#operationId) invalid();
    return this.#stage(normalized.mutations);
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
    if (typeof source.replayed !== "boolean") unavailable();
    const records = exactDenseArray(source.records, this.#records.length);
    for (let index = 0; index < this.#records.length; index += 1) {
      if (!sameRecord(records[index], this.#records[index])) unavailable();
    }
  }

  async #stage(
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
      if (mutation.type === "put") {
        if (
          mutation.expectedRevision === null
            ? current !== null
            : current === null ||
              current.revision !== mutation.expectedRevision
        ) {
          if (mutation.expectedRevision === null) conflict();
          precondition();
        }
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
      record.revision === expected.revision &&
      canonicalJson(record.value) === canonicalJson(expected.value);
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
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      keys[index] !== String(index) ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) unavailable();
  }
  return value;
}

function exactRecord(
  value: unknown,
  expectedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) unavailable();
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

function exactInputRecord(
  value: unknown,
  expectedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  try {
    return exactRecord(value, expectedKeys);
  } catch {
    invalid();
  }
}

function canonicalJson(value: unknown): string {
  return canonicalJsonValue(value, 0, new Set<object>(), { nodes: 0 });
}

function canonicalJsonValue(
  value: unknown,
  depth: number,
  ancestors: ReadonlySet<object>,
  state: { nodes: number },
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
    const values = exactDenseArray(value, MAX_INDICATION_CANONICAL_NODES);
    return `[${values.map((entry) =>
      canonicalJsonValue(entry, depth + 1, nextAncestors, state)
    ).join(",")}]`;
  }
  const source = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(source);
  if (keys.some((key) => typeof key !== "string")) invalid();
  return `{${(keys as string[]).sort().map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) invalid();
    return `${JSON.stringify(key)}:${canonicalJsonValue(
      descriptor.value,
      depth + 1,
      nextAncestors,
      state,
    )}`;
  }).join(",")}}`;
}

function requiredStorageAdapter(value: unknown): StorageAdapter {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as StorageAdapter).read !== "function" ||
    typeof (value as StorageAdapter).list !== "function" ||
    typeof (value as StorageAdapter).transact !== "function"
  ) invalid();
  return value as StorageAdapter;
}

function requiredReviewIdResolver(
  value: unknown,
): OwnerIndicationReviewIdResolver {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as OwnerIndicationReviewIdResolver)
        .currentKeyForReviewId !== "function"
  ) invalid();
  return value as OwnerIndicationReviewIdResolver;
}

function requiredReviewStorageKey(value: unknown): StorageKey {
  const source = exactRecord(value, STORAGE_KEY_KEYS);
  const parsed = parseStorageKey(source.collection, source.id);
  if (
    !parsed.ok ||
    parsed.value.collection !== "investment-indications" ||
    !/^indication-current:[0-9a-f]{64}$/u.test(parsed.value.id)
  ) notFound();
  return parsed.value;
}

function requiredAmountConfiguration(value: unknown): AmountConfiguration {
  const source = value as AmountConfiguration;
  const parsed = parseAmountAggregateConfiguration({
    amount: source,
    publicAggregate: { visibility: "hidden" },
  });
  if (!parsed.ok) invalid();
  return parsed.value.amount;
}

function optionalSubject(value: unknown): ActorSubject | null {
  if (value === null) return null;
  const parsed = parseActorSubject(value);
  if (!parsed.ok) invalid();
  return parsed.value;
}

function requiredStableId<Entity extends string>(
  value: unknown,
): StableId<Entity> {
  const parsed = parseStableId<Entity>(value);
  if (!parsed.ok) invalid();
  return parsed.value;
}

function requiredStorageKey(
  collectionValue: StorageCollection,
  id: unknown,
): StorageKey {
  const parsed = parseStorageKey(collectionValue, id);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function collection(value: string): StorageCollection {
  const parsed = parseStorageCollection(value);
  if (!parsed.ok) throw new Error("Invalid owner rejection collection.");
  return parsed.value;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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
