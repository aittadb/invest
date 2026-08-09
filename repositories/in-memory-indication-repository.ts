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
  StorageFailure,
  parseStorageCollection,
  parseStorageKey,
  parseStorageOperationId,
  storageKeyString,
  type StorageAdapter,
  type StorageCollection,
  type StorageDocument,
  type StorageKey,
  type StorageMutation,
  type StorageOperationId,
  type StorageRecord,
} from "../domain/storage-adapter.ts";

const INDICATION_SCHEMA_VERSION = 1;
const CURRENT_INDICATIONS = storageCollection("investment-indications");
const INDICATION_HISTORY = storageCollection("investment-indication-history");
const ACTIVE_UNIQUENESS_KEYS = storageCollection(
  "investment-indication-active-keys",
);
const STORED_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "operationId",
  "operationFingerprint",
  "snapshotHash",
  "indication",
]);
const LEASE_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "indicationId",
  "uniquenessFingerprint",
]);

export type IndicationMutationResult<
  Indication extends InvestmentIndication = InvestmentIndication,
> = Readonly<{
  revision: number;
  snapshot: Indication;
  replayed: boolean;
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

type StoredIndication = Readonly<{
  operationId: StorageOperationId;
  operationFingerprint: string;
  indication: InvestmentIndication;
  document: StorageDocument;
}>;

type ActiveLease = Readonly<{
  uniquenessKey: ActiveIndicationUniquenessKey;
  key: StorageKey;
  fingerprint: string;
  document: StorageDocument;
}>;

/**
 * Deterministic development repository composed entirely over StorageAdapter.
 * It retains no process-local records and is not a production persistence path.
 */
export class DevelopmentInMemoryIndicationRepository
  implements IndicationRepository
{
  readonly storageKind = "development-in-memory" as const;

  readonly #storage: StorageAdapter;
  readonly #authenticatedSubject: ActorSubject | null;
  readonly #configuredOwnerSubject: ActorSubject;
  readonly #amountConfiguration: AmountConfiguration;
  readonly #parsingOptions: InvestmentIndicationParsingOptions;

  constructor(
    storage: StorageAdapter,
    authenticatedSubject: ActorSubject | null,
    configuredOwnerSubject: ActorSubject,
    amountConfiguration: AmountConfiguration,
    parsingOptions: InvestmentIndicationParsingOptions = {},
  ) {
    this.#storage = storage;
    this.#authenticatedSubject = authenticatedSubject === null
      ? null
      : requiredActorSubject(authenticatedSubject);
    this.#configuredOwnerSubject = requiredActorSubject(configuredOwnerSubject);
    this.#amountConfiguration = requiredAmountConfiguration(amountConfiguration);
    this.#parsingOptions = Object.freeze({ ...parsingOptions });
  }

  async create(
    request: CreateIndicationRequest,
    acknowledgmentContext: TrustedPackageAcknowledgmentContext,
  ): Promise<IndicationMutationResult<ActiveInvestmentIndication>> {
    const actor = this.#requiredParticipantActor();
    const parsed = parseCreateRequest(
      request,
      this.#amountConfiguration,
      this.#parsingOptions,
    );
    const fingerprint = await operationFingerprint(
      "create",
      actor,
      parsed,
    );
    const replay = await this.#replayIfKnown(parsed, fingerprint);
    if (replay !== null) return activeResult(replay);

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
      await this.#writeSnapshot(created, null, parsed, fingerprint),
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

  async edit(
    request: EditIndicationRequest,
    acknowledgmentContext: TrustedPackageAcknowledgmentContext,
  ): Promise<IndicationMutationResult<ActiveInvestmentIndication>> {
    const actor = this.#requiredParticipantActor();
    const parsed = parseEditRequest(
      request,
      this.#amountConfiguration,
      this.#parsingOptions,
    );
    const fingerprint = await operationFingerprint("edit", actor, parsed);
    const replay = await this.#replayIfKnown(parsed, fingerprint);
    if (replay !== null) return activeResult(replay);

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
        current.indication,
        parsed,
        fingerprint,
      ),
    );
  }

  async withdraw(
    request: WithdrawIndicationRequest,
  ): Promise<IndicationMutationResult<WithdrawnInvestmentIndication>> {
    const actor = this.#requiredParticipantActor();
    const parsed = parseTransitionRequest(request);
    const fingerprint = await operationFingerprint("withdraw", actor, parsed);
    const replay = await this.#replayIfKnown(parsed, fingerprint);
    if (replay !== null) return withdrawnResult(replay);

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
        current.indication,
        parsed,
        fingerprint,
      ),
    );
  }

  async reactivate(
    request: ReactivateIndicationRequest,
    acknowledgmentContext: TrustedPackageAcknowledgmentContext,
  ): Promise<IndicationMutationResult<ActiveInvestmentIndication>> {
    const actor = this.#requiredParticipantActor();
    const parsed = parseTransitionRequest(request);
    const fingerprint = await operationFingerprint("reactivate", actor, parsed);
    const replay = await this.#replayIfKnown(parsed, fingerprint);
    if (replay !== null) return activeResult(replay);

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
        current.indication,
        parsed,
        fingerprint,
      ),
    );
  }

  async reject(
    request: RejectIndicationRequest,
  ): Promise<IndicationMutationResult<RejectedInvestmentIndication>> {
    const actor = this.#requiredOwnerActor();
    const parsed = parseRejectRequest(request);
    const fingerprint = await operationFingerprint("reject", actor, parsed);
    const replay = await this.#replayIfKnown(parsed, fingerprint);
    if (replay !== null) return rejectedResult(replay);

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
        current.indication,
        parsed,
        fingerprint,
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
  ): Promise<StoredIndication | null> {
    const key = await currentIndicationKey(id);
    const record = await this.#storage.read(key);
    if (record === null) return null;

    if (access === "participant") {
      const storedSubject = peekParticipantSubject(record.value);
      if (storedSubject === null || storedSubject !== subject) return null;
    } else if (subject !== this.#configuredOwnerSubject) {
      return null;
    }

    const stored = await decodeStoredIndication(
      record,
      key,
      "current",
      id,
      null,
      this.#configuredOwnerSubject,
      this.#amountConfiguration,
      this.#parsingOptions,
    );
    if (
      access === "participant" &&
      stored.indication.participantSubject !== subject
    ) {
      return null;
    }
    await this.#verifyImmutableHistory(stored.indication);
    await this.#verifyActiveLease(stored.indication);
    return stored;
  }

  async #verifyImmutableHistory(
    indication: InvestmentIndication,
  ): Promise<void> {
    for (let revision = 1; revision <= indication.revision; revision += 1) {
      const key = await indicationHistoryKey(indication.id, revision);
      const record = await this.#storage.read(key);
      if (record === null) unavailable();
      const historical = await decodeStoredIndication(
        record,
        key,
        "history",
        indication.id,
        revision,
        this.#configuredOwnerSubject,
        this.#amountConfiguration,
        this.#parsingOptions,
      );
      if (
        canonicalJson(historyDocument(historical.indication.history)) !==
        canonicalJson(historyDocument(indication.history.slice(0, revision)))
      ) {
        unavailable();
      }
    }
  }

  async #verifyActiveLease(indication: InvestmentIndication): Promise<void> {
    const lease = await activeLease(indication);
    if (lease === null) return;
    const record = await this.#storage.read(lease.key);
    if (record === null) unavailable();
    verifyLeaseRecord(record, lease, indication.id);
  }

  async #replayIfKnown(
    request: ParsedMutationRequest,
    fingerprint: string,
  ): Promise<IndicationMutationResult | null> {
    const revision = nextRevision(request.expectedRevision);
    const historyKey = await indicationHistoryKey(request.id, revision);
    const record = await this.#storage.read(historyKey);
    if (record === null) return null;

    const stored = await decodeStoredIndication(
      record,
      historyKey,
      "history",
      request.id,
      revision,
      this.#configuredOwnerSubject,
      this.#amountConfiguration,
      this.#parsingOptions,
    );
    if (stored.operationId !== request.operationId) {
      throw new StorageFailure(
        request.expectedRevision === null ? "CONFLICT" : "PRECONDITION_FAILED",
      );
    }
    if (stored.operationFingerprint !== fingerprint) {
      throw new StorageFailure("CONFLICT");
    }

    const previous = previousIndication(
      stored.indication,
      this.#configuredOwnerSubject,
      this.#amountConfiguration,
      this.#parsingOptions,
    );
    return this.#transactSnapshot(
      stored.document,
      stored.indication,
      previous,
      request,
    );
  }

  async #writeSnapshot(
    indication: InvestmentIndication,
    previous: InvestmentIndication | null,
    request: ParsedMutationRequest,
    fingerprint: string,
  ): Promise<IndicationMutationResult> {
    if (indication.revision !== nextRevision(request.expectedRevision)) {
      unavailable();
    }
    const document = await indicationDocument(
      indication,
      request.operationId,
      fingerprint,
    );
    return this.#transactSnapshot(document, indication, previous, request);
  }

  async #transactSnapshot(
    document: StorageDocument,
    expectedIndication: InvestmentIndication,
    previous: InvestmentIndication | null,
    request: ParsedMutationRequest,
  ): Promise<IndicationMutationResult> {
    const currentKey = await currentIndicationKey(request.id);
    const historyKey = await indicationHistoryKey(
      request.id,
      expectedIndication.revision,
    );
    const uniquenessMutations = await activeLeaseMutations(
      previous,
      expectedIndication,
    );
    const result = await this.#storage.transact({
      operationId: request.operationId,
      mutations: [
        {
          type: "put",
          key: currentKey,
          expectedRevision: request.expectedRevision,
          value: document,
        },
        {
          type: "put",
          key: historyKey,
          expectedRevision: null,
          value: document,
        },
        ...uniquenessMutations,
      ],
    });

    const currentRecord = result.records[0];
    const historyRecord = result.records[1];
    if (!currentRecord || !historyRecord) unavailable();

    const current = await decodeStoredIndication(
      currentRecord,
      currentKey,
      "current",
      request.id,
      expectedIndication.revision,
      this.#configuredOwnerSubject,
      this.#amountConfiguration,
      this.#parsingOptions,
    );
    const historical = await decodeStoredIndication(
      historyRecord,
      historyKey,
      "history",
      request.id,
      expectedIndication.revision,
      this.#configuredOwnerSubject,
      this.#amountConfiguration,
      this.#parsingOptions,
    );
    const expectedDocument = indicationSnapshotDocument(expectedIndication);
    if (
      canonicalJson(indicationSnapshotDocument(current.indication)) !==
        canonicalJson(indicationSnapshotDocument(historical.indication)) ||
      canonicalJson(indicationSnapshotDocument(current.indication)) !==
        canonicalJson(expectedDocument)
    ) {
      unavailable();
    }
    await this.#verifyImmutableHistory(current.indication);
    if (!result.replayed) await this.#verifyActiveLease(current.indication);

    return mutationResult(current.indication, result.replayed);
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

async function decodeStoredIndication(
  record: StorageRecord,
  expectedKey: StorageKey,
  recordKind: "current" | "history",
  expectedId: InvestmentIndicationId,
  expectedIndicationRevision: number | null,
  configuredOwnerSubject: ActorSubject,
  amountConfiguration: AmountConfiguration,
  parsingOptions: InvestmentIndicationParsingOptions,
): Promise<StoredIndication> {
  if (storageKeyString(record.key) !== storageKeyString(expectedKey)) {
    unavailable();
  }
  const source = objectRecord(record.value);
  if (
    source === null ||
    !hasExactKeys(source, STORED_DOCUMENT_KEYS) ||
    source.kind !== "investment-indication-snapshot" ||
    source.schemaVersion !== INDICATION_SCHEMA_VERSION ||
    typeof source.operationFingerprint !== "string" ||
    !isSha256(source.operationFingerprint) ||
    typeof source.snapshotHash !== "string" ||
    !isSha256(source.snapshotHash)
  ) {
    unavailable();
  }

  const operationId = parseStorageOperationId(source.operationId);
  if (!operationId.ok) unavailable();
  const indication = reconstructIndication(
    source.indication,
    configuredOwnerSubject,
    amountConfiguration,
    parsingOptions,
  );
  if (
    indication.id !== expectedId ||
    (expectedIndicationRevision !== null &&
      indication.revision !== expectedIndicationRevision) ||
    (recordKind === "current" && record.revision !== indication.revision) ||
    (recordKind === "history" && record.revision !== 1)
  ) {
    unavailable();
  }

  const snapshot = indicationSnapshotDocument(indication);
  if (
    canonicalJson(snapshot) !== canonicalJson(source.indication) ||
    await hashDocument(snapshot) !== source.snapshotHash ||
    await fingerprintForStoredIndication(indication, operationId.value) !==
      source.operationFingerprint
  ) {
    unavailable();
  }

  return Object.freeze({
    operationId: operationId.value,
    operationFingerprint: source.operationFingerprint,
    indication,
    document: record.value,
  });
}

function reconstructIndication(
  value: unknown,
  configuredOwnerSubject: ActorSubject,
  amountConfiguration: AmountConfiguration,
  parsingOptions: InvestmentIndicationParsingOptions,
): InvestmentIndication {
  const source = objectRecord(value);
  if (source === null || !Array.isArray(source.history)) unavailable();
  const indication = reconstructHistory(
    source.history,
    configuredOwnerSubject,
    amountConfiguration,
    parsingOptions,
  );
  if (
    canonicalJson(indicationSnapshotDocument(indication)) !==
    canonicalJson(value)
  ) {
    unavailable();
  }
  return indication;
}

function reconstructHistory(
  history: readonly unknown[],
  configuredOwnerSubject: ActorSubject,
  amountConfiguration: AmountConfiguration,
  parsingOptions: InvestmentIndicationParsingOptions,
): InvestmentIndication {
  if (history.length < 1) unavailable();
  try {
    const first = requiredHistoryEntry(history[0]);
    if (first.transition !== "created") unavailable();
    const actor = storedParticipantActor(first.actor);
    const acknowledgment = storedAcknowledgment(first.acknowledgment);
    const created = createInvestmentIndication(
      {
        id: first.indicationId,
        occurredAt: first.occurredAt,
        historyEntryId: first.id,
        fields: storedDomainFieldsInput(first.fields),
      },
      actor,
      amountConfiguration,
      storedAcknowledgmentContext(acknowledgment),
      parsingOptions,
    );
    if (!created.ok) unavailable();

    let indication: InvestmentIndication = created.value;
    for (const candidate of history.slice(1)) {
      const entry = requiredHistoryEntry(candidate);
      if (entry.transition === "edited") {
        const acknowledgment = storedAcknowledgment(entry.acknowledgment);
        const edited = editInvestmentIndication(
          indication,
          {
            occurredAt: entry.occurredAt,
            historyEntryId: entry.id,
            fields: storedDomainFieldsInput(entry.fields),
          },
          storedParticipantActor(entry.actor),
          amountConfiguration,
          storedAcknowledgmentContext(acknowledgment),
          parsingOptions,
        );
        if (!edited.ok) unavailable();
        indication = edited.value;
        continue;
      }
      if (entry.transition === "withdrawn") {
        const withdrawn = withdrawInvestmentIndication(
          indication,
          {
            occurredAt: entry.occurredAt,
            historyEntryId: entry.id,
          },
          storedParticipantActor(entry.actor),
        );
        if (!withdrawn.ok) unavailable();
        indication = withdrawn.value;
        continue;
      }
      if (entry.transition === "reactivated") {
        const acknowledgment = storedAcknowledgment(entry.acknowledgment);
        const reactivated = reactivateInvestmentIndication(
          indication,
          {
            occurredAt: entry.occurredAt,
            historyEntryId: entry.id,
          },
          storedParticipantActor(entry.actor),
          storedAcknowledgmentContext(acknowledgment),
        );
        if (!reactivated.ok) unavailable();
        indication = reactivated.value;
        continue;
      }
      if (entry.transition === "rejected") {
        const actor = storedOwnerActor(entry.actor, configuredOwnerSubject);
        const rejection = objectRecord(entry.rejection);
        if (rejection === null) unavailable();
        const rejected = rejectInvestmentIndication(
          indication,
          {
            occurredAt: entry.occurredAt,
            historyEntryId: entry.id,
            reason: rejection.reason,
          },
          actor,
        );
        if (!rejected.ok) unavailable();
        indication = rejected.value;
        continue;
      }
      unavailable();
    }
    return indication;
  } catch (error) {
    if (error instanceof StorageFailure && error.code === "UNAVAILABLE") {
      throw error;
    }
    unavailable();
  }
}

function previousIndication(
  indication: InvestmentIndication,
  configuredOwnerSubject: ActorSubject,
  amountConfiguration: AmountConfiguration,
  parsingOptions: InvestmentIndicationParsingOptions,
): InvestmentIndication | null {
  if (indication.revision === 1) return null;
  return reconstructHistory(
    indication.history.slice(0, -1),
    configuredOwnerSubject,
    amountConfiguration,
    parsingOptions,
  );
}

function requiredHistoryEntry(value: unknown): Record<string, unknown> {
  const entry = objectRecord(value);
  if (entry === null) unavailable();
  return entry;
}

function storedParticipantActor(value: unknown): ParticipantIndicationActor {
  const source = objectRecord(value);
  if (source === null || source.type !== "participant") unavailable();
  const subject = parseActorSubject(source.subject);
  if (!subject.ok) unavailable();
  return Object.freeze({ type: "participant", subject: subject.value });
}

function storedOwnerActor(
  value: unknown,
  configuredOwnerSubject: ActorSubject,
): OwnerIndicationActor {
  const source = objectRecord(value);
  if (source === null || source.type !== "owner") unavailable();
  const subject = parseActorSubject(source.subject);
  if (!subject.ok || subject.value !== configuredOwnerSubject) unavailable();
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

async function indicationDocument(
  indication: InvestmentIndication,
  operationId: StorageOperationId,
  operationFingerprintValue: string,
): Promise<StorageDocument> {
  const snapshot = indicationSnapshotDocument(indication);
  return Object.freeze({
    kind: "investment-indication-snapshot",
    schemaVersion: INDICATION_SCHEMA_VERSION,
    operationId,
    operationFingerprint: operationFingerprintValue,
    snapshotHash: await hashDocument(snapshot),
    indication: snapshot,
  });
}

function indicationSnapshotDocument(
  indication: InvestmentIndication,
): StorageDocument {
  return {
    id: indication.id,
    participantSubject: indication.participantSubject,
    kind: indication.kind,
    fields: fieldsDocument(indication.fields),
    acknowledgment: acknowledgmentDocument(indication.acknowledgment),
    lifecycle: lifecycleDocument(indication),
    createdAt: indication.createdAt,
    updatedAt: indication.updatedAt,
    revision: indication.revision,
    history: historyDocument(indication.history),
  };
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

function lifecycleDocument(indication: InvestmentIndication): StorageDocument {
  const lifecycle = indication.lifecycle;
  return {
    status: lifecycle.status,
    activatedAt: lifecycle.activatedAt,
    withdrawnAt: lifecycle.withdrawnAt,
    rejectedAt: lifecycle.rejectedAt,
    rejection: lifecycle.rejection === null
      ? null
      : rejectionDocument(lifecycle.rejection),
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

function historyDocument(
  history: readonly InvestmentIndicationHistoryEntry[],
): readonly StorageDocument[] {
  return history.map((entry) => ({
    id: entry.id,
    indicationId: entry.indicationId,
    occurredAt: entry.occurredAt,
    revision: entry.revision,
    fields: fieldsDocument(entry.fields),
    acknowledgment: acknowledgmentDocument(entry.acknowledgment),
    transition: entry.transition,
    status: entry.status,
    actor: actorDocument(entry.actor),
    rejection: entry.rejection === null
      ? null
      : rejectionDocument(entry.rejection),
  }));
}

function actorDocument(
  actor: ParticipantIndicationActor | OwnerIndicationActor,
): StorageDocument {
  return { type: actor.type, subject: actor.subject };
}

async function fingerprintForStoredIndication(
  indication: InvestmentIndication,
  operationId: StorageOperationId,
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
): Promise<string> {
  const payload: StorageDocument = {
    kind,
    operationId: request.operationId,
    actor: actorDocument(actor),
    expectedRevision: request.expectedRevision,
    id: request.id,
    occurredAt: request.occurredAt,
    historyEntryId: request.historyEntryId,
    ...(request.fields === undefined
      ? {}
      : { fields: fieldsDocument(request.fields) }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
  };
  return hashDocument(payload);
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
  const source = objectRecord(record.value);
  if (
    storageKeyString(record.key) !== storageKeyString(expected.key) ||
    record.revision !== 1 ||
    source === null ||
    !hasExactKeys(source, LEASE_DOCUMENT_KEYS) ||
    source.kind !== "active-indication-lease" ||
    source.schemaVersion !== INDICATION_SCHEMA_VERSION ||
    source.indicationId !== indicationId ||
    source.uniquenessFingerprint !== expected.fingerprint ||
    canonicalJson(source) !== canonicalJson(expected.document)
  ) {
    unavailable();
  }
}

async function currentIndicationKey(
  id: InvestmentIndicationId,
): Promise<StorageKey> {
  return requiredStorageKey(
    CURRENT_INDICATIONS,
    await hashedStorageId("indication-current", id),
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

async function hashedStorageId(
  namespace: string,
  value: string,
): Promise<string> {
  return `${namespace}:${await sha256Hex(`${namespace}\u0000${value}`)}`;
}

async function sha256Hex(value: string): Promise<string> {
  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
  } catch {
    unavailable();
  }
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function peekParticipantSubject(value: StorageDocument): ActorSubject | null {
  const source = objectRecord(value);
  const indication = objectRecord(source?.indication);
  const parsed = parseActorSubject(indication?.participantSubject);
  return parsed.ok ? parsed.value : null;
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
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isSha256(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
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
