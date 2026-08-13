import {
  parseAmountAggregateConfiguration,
  type AmountConfiguration,
} from "../domain/amount-aggregate-configuration.ts";
import {
  parseActorSubject,
  parseStableId,
  parseTimestamp,
  type ActorSubject,
  type Timestamp,
} from "../domain/foundation.ts";
import {
  createInvestmentIndication,
  editInvestmentIndication,
  MAX_INVESTMENT_INDICATION_REVISIONS,
  parseInvestmentIndicationFields,
  reactivateInvestmentIndication,
  rejectInvestmentIndication,
  withdrawInvestmentIndication,
  type InvestmentIndication,
  type InvestmentIndicationFields,
  type InvestmentIndicationHistoryEntry,
  type InvestmentIndicationHistoryEntryId,
  type InvestmentIndicationId,
  type InvestmentIndicationParsingOptions,
  type OwnerIndicationActor,
  type ParticipantIndicationActor,
  type TrustedPackageAcknowledgmentContext,
} from "../domain/investment-indication.ts";
import type {
  PackageAcceptanceRecord,
  PackageContentHash,
  PackageVersion,
} from "../domain/package-content.ts";
import type { ValidationResult } from "../domain/foundation.ts";
import {
  StorageFailure,
  parseStorageCollection,
  parseStorageKey,
  parseStorageOperationId,
  type StorageAdapter,
  type StorageCollection,
  type StorageDocument,
  type StorageKey,
  type StorageOperationId,
  type StorageRecord,
} from "../domain/storage-adapter.ts";

/** Schema-5 read ceilings shared by every verified indication projection. */
export const MAX_INDICATION_STORAGE_RECORD_BYTES = 65_536;
export const MAX_SERIALIZED_INDICATION_FIELDS_BYTES = 65_536;
export const MAX_INDICATION_CANONICAL_DEPTH = 32;
export const MAX_INDICATION_CANONICAL_NODES = 4_096;
export const INDICATION_FIELDS_CHUNK_RAW_BYTES = 8_192;
export const MAX_INDICATION_FIELDS_CHUNKS = Math.ceil(
  MAX_SERIALIZED_INDICATION_FIELDS_BYTES / INDICATION_FIELDS_CHUNK_RAW_BYTES,
);
export const MAX_INDICATION_MATERIALIZATION_READS =
  2 + MAX_INVESTMENT_INDICATION_REVISIONS *
    (1 + MAX_INDICATION_FIELDS_CHUNKS);

const INDICATION_SCHEMA_VERSION = 5;
const CURRENT_INDICATIONS = collection("investment-indications");
const INDICATION_HISTORY = collection("investment-indication-history");
const INDICATION_FIELDS = collection("investment-indication-fields");
const ACTIVE_UNIQUENESS_KEYS = collection("investment-indication-active-keys");

const CURRENT_DOCUMENT_KEYS = new Set([
  "kind", "schemaVersion", "operationId", "operationFingerprint",
  "requestFingerprint", "indicationId", "participantSubject", "revision",
  "fields",
]);
const TRANSITION_DOCUMENT_KEYS = new Set([
  "kind", "schemaVersion", "operationId", "operationFingerprint",
  "requestFingerprint", "indicationId", "participantSubject", "historyEntryId",
  "occurredAt", "revision", "transitionKind", "fields", "acknowledgment",
  "actor", "rejection",
]);
const FIELDS_REFERENCE_KEYS = new Set(["revision", "hash", "bytes", "chunks"]);
const FIELDS_CHUNK_DOCUMENT_KEYS = new Set([
  "kind", "schemaVersion", "indicationId", "participantSubject",
  "fieldsRevision", "fieldsHash", "fieldsBytes", "chunkIndex", "chunkCount",
  "data",
]);
const LEASE_DOCUMENT_KEYS = new Set([
  "kind", "schemaVersion", "indicationId", "uniquenessFingerprint",
]);
const PERSONAL_FIELDS_DOCUMENT_KEYS = new Set([
  "kind", "residenceCountry", "amount", "currency", "availabilityPeriod", "note",
]);
const COMPANY_FIELDS_DOCUMENT_KEYS = new Set([
  "kind", "companyName", "registrationCountry", "companyIdentifier",
  "representativeName", "representativeAuthorityDeclared", "amount", "currency",
  "availabilityPeriod", "note",
]);
const STORAGE_RECORD_KEYS = new Set(["key", "revision", "value"]);
const STORAGE_KEY_KEYS = new Set(["collection", "id"]);

export type StoredIndicationFieldsReference = Readonly<{
  revision: number;
  hash: string;
  bytes: number;
  chunks: number;
}>;

export type StoredIndicationFields = Readonly<{
  reference: StoredIndicationFieldsReference;
  fields: InvestmentIndicationFields;
}>;

export type StoredIndicationTransition = Readonly<{
  operationId: StorageOperationId;
  operationFingerprint: string;
  requestFingerprint: string;
  indicationId: InvestmentIndicationId;
  participantSubject: ActorSubject;
  historyEntryId: InvestmentIndicationHistoryEntryId;
  occurredAt: Timestamp;
  revision: number;
  transitionKind: InvestmentIndicationHistoryEntry["transition"];
  fields: StoredIndicationFieldsReference;
  document: StorageDocument;
}>;

export type StoredIndicationCurrent = Readonly<{
  operationId: StorageOperationId;
  operationFingerprint: string;
  requestFingerprint: string;
  indicationId: InvestmentIndicationId;
  participantSubject: ActorSubject;
  revision: number;
  fields: StoredIndicationFieldsReference;
  document: StorageDocument;
  record: StorageRecord;
}>;

export type IndicationReadStorage = Pick<StorageAdapter, "read">;

export type MaterializedStoredIndication = Readonly<{
  indication: InvestmentIndication;
  terminal: StoredIndicationTransition;
  fieldsByRevision: ReadonlyMap<number, StoredIndicationFields>;
}>;

export type MaterializedStoredIndicationCurrent = Readonly<{
  current: StoredIndicationCurrent;
  materialized: MaterializedStoredIndication;
}>;

export async function indicationCurrentStorageKey(
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
  const parsed = parseStableId<"investment-indication">(id);
  if (!parsed.ok) invalidRequest();
  return indicationCurrentStorageKey(parsed.value);
}

export async function indicationHistoryStorageKey(
  id: InvestmentIndicationId,
  revision: number,
): Promise<StorageKey> {
  return requiredStorageKey(
    INDICATION_HISTORY,
    await hashedStorageId("indication-history", `${id}\u0000${revision}`),
  );
}

async function indicationFieldsChunkStorageKey(
  id: InvestmentIndicationId,
  revision: number,
  index: number,
): Promise<StorageKey> {
  return requiredStorageKey(
    INDICATION_FIELDS,
    await hashedStorageId("indication-fields", `${id}\u0000${revision}\u0000${index}`),
  );
}

export function decodeStoredIndicationCurrent(
  record: StorageRecord,
  expectedKey: StorageKey,
  expectedId: InvestmentIndicationId,
  expectedSubject: ActorSubject | null,
): StoredIndicationCurrent {
  const source = exactStoredDocument(
    record, expectedKey, CURRENT_DOCUMENT_KEYS, "investment-indication-current",
  );
  const current = Object.freeze({
    operationId: storedOperationId(source.operationId),
    operationFingerprint: storedFingerprint(source.operationFingerprint),
    requestFingerprint: storedFingerprint(source.requestFingerprint),
    indicationId: storedIndicationId(source.indicationId),
    participantSubject: storedActorSubject(source.participantSubject),
    revision: storedRevision(source.revision),
    fields: storedFieldsReference(source.fields),
    document: record.value,
    record,
  });
  if (
    current.indicationId !== expectedId ||
    (expectedSubject !== null && current.participantSubject !== expectedSubject) ||
    record.revision !== current.revision
  ) unavailable();
  return current;
}

export function decodeStoredIndicationTransition(
  record: StorageRecord,
  expectedKey: StorageKey,
  expectedSubject: ActorSubject | null,
  expectedId: InvestmentIndicationId,
  expectedRevision: number,
): StoredIndicationTransition {
  const source = exactStoredDocument(
    record, expectedKey, TRANSITION_DOCUMENT_KEYS, "investment-indication-transition",
  );
  const transition = Object.freeze({
    operationId: storedOperationId(source.operationId),
    operationFingerprint: storedFingerprint(source.operationFingerprint),
    requestFingerprint: storedFingerprint(source.requestFingerprint),
    indicationId: storedIndicationId(source.indicationId),
    participantSubject: storedActorSubject(source.participantSubject),
    historyEntryId: storedHistoryEntryId(source.historyEntryId),
    occurredAt: storedTimestamp(source.occurredAt),
    revision: storedRevision(source.revision),
    transitionKind: storedTransitionKind(source.transitionKind),
    fields: storedFieldsReference(source.fields),
    document: record.value,
  });
  if (
    transition.indicationId !== expectedId ||
    (expectedSubject !== null && transition.participantSubject !== expectedSubject) ||
    transition.revision !== expectedRevision || record.revision !== 1
  ) unavailable();
  return transition;
}

export function indicationCoordinatesFromCurrentDocument(value: unknown): Readonly<{
  subject: ActorSubject;
  id: InvestmentIndicationId;
}> {
  const source = exactRecord(value, CURRENT_DOCUMENT_KEYS);
  return Object.freeze({
    subject: storedActorSubject(source.participantSubject),
    id: storedIndicationId(source.indicationId),
  });
}

export function requireMatchingCurrentAndTerminal(
  current: StoredIndicationCurrent,
  terminal: StoredIndicationTransition,
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
  ) unavailable();
}

export async function readStoredIndicationFields(
  storage: IndicationReadStorage,
  subject: ActorSubject,
  id: InvestmentIndicationId,
  reference: StoredIndicationFieldsReference,
): Promise<StoredIndicationFields> {
  const parts = await Promise.all(
    Array.from({ length: reference.chunks }, async (_, index) => {
      const key = await indicationFieldsChunkStorageKey(id, reference.revision, index);
      const record = await storage.read(key);
      if (record === null) unavailable();
      const source = exactStoredDocument(
        record, key, FIELDS_CHUNK_DOCUMENT_KEYS, "investment-indication-fields-chunk",
      );
      if (
        record.revision !== 1 || source.indicationId !== id ||
        source.participantSubject !== subject ||
        source.fieldsRevision !== reference.revision || source.fieldsHash !== reference.hash ||
        source.fieldsBytes !== reference.bytes || source.chunkIndex !== index ||
        source.chunkCount !== reference.chunks || typeof source.data !== "string"
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
  if (offset !== reference.bytes || `sha256:${await sha256BytesHex(bytes)}` !== reference.hash) unavailable();
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    return unavailable();
  }
  const source = storedFieldsDocument(parsed);
  const fields = parseInvestmentIndicationFields(
    storedDomainFieldsInput(source), storedAmountConfigurationFromDocument(source), storedParsingOptions(),
  );
  if (!fields.ok || canonicalJson(fieldsDocument(fields.value)) !== text) unavailable();
  return Object.freeze({ reference, fields: fields.value });
}

/**
 * Reconstruct an indication from its immutable, subject-bound transition
 * ancestry. This is deliberately read-only: it validates persisted facts but
 * does not choose a mutation, replay outcome, or ownership policy.
 */
export async function materializeStoredIndication(
  storage: IndicationReadStorage,
  subject: ActorSubject,
  id: InvestmentIndicationId,
  revision: number,
  knownTerminal: StoredIndicationTransition | null,
): Promise<MaterializedStoredIndication> {
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    revision > MAX_INVESTMENT_INDICATION_REVISIONS
  ) {
    unavailable();
  }

  const transitions = await Promise.all(
    Array.from({ length: revision }, async (_, index) => {
      const currentRevision = index + 1;
      if (
        knownTerminal !== null &&
        currentRevision === knownTerminal.revision
      ) {
        return knownTerminal;
      }
      const key = await indicationHistoryStorageKey(id, currentRevision);
      const record = await storage.read(key);
      if (record === null) unavailable();
      return decodeStoredIndicationTransition(
        record,
        key,
        subject,
        id,
        currentRevision,
      );
    }),
  );

  const references = new Map<number, StoredIndicationFieldsReference>();
  let prior: StoredIndicationFieldsReference | null = null;
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
    ) {
      unavailable();
    }
    const known = references.get(transition.fields.revision);
    if (
      known !== undefined &&
      canonicalJson(fieldsReferenceDocument(known)) !==
        canonicalJson(fieldsReferenceDocument(transition.fields))
    ) {
      unavailable();
    }
    references.set(transition.fields.revision, transition.fields);
    prior = transition.fields;
  }

  const fieldsByRevision = new Map<number, StoredIndicationFields>(
    await Promise.all(
      [...references.entries()].map(async ([fieldsRevision, reference]) => [
        fieldsRevision,
        await readStoredIndicationFields(storage, subject, id, reference),
      ] as const),
    ),
  );

  let indication: InvestmentIndication | null = null;
  for (const transition of transitions) {
    const storedFields = fieldsByRevision.get(transition.fields.revision);
    if (storedFields === undefined) unavailable();
    const source = exactRecord(transition.document, TRANSITION_DOCUMENT_KEYS);
    const acknowledgment = storedAcknowledgment(source.acknowledgment);
    const amount = storedAmountConfiguration(storedFields.fields);
    const parsingOptions = storedParsingOptions();

    switch (transition.transitionKind) {
      case "created":
        if (indication !== null) unavailable();
        indication = reconstructStoredTransition(() =>
          createInvestmentIndication(
            {
              id,
              occurredAt: transition.occurredAt,
              historyEntryId: transition.historyEntryId,
              fields: domainFieldsInput(storedFields.fields),
            },
            storedParticipantActor(source.actor),
            amount,
            storedAcknowledgmentContext(acknowledgment),
            parsingOptions,
          )
        );
        break;
      case "edited": {
        if (indication === null) unavailable();
        const edited: InvestmentIndication = indication;
        indication = reconstructStoredTransition(() =>
          editInvestmentIndication(
            edited,
            {
              occurredAt: transition.occurredAt,
              historyEntryId: transition.historyEntryId,
              fields: domainFieldsInput(storedFields.fields),
            },
            storedParticipantActor(source.actor),
            amount,
            storedAcknowledgmentContext(acknowledgment),
            parsingOptions,
          )
        );
        break;
      }
      case "withdrawn": {
        if (indication === null) unavailable();
        const withdrawn: InvestmentIndication = indication;
        indication = reconstructStoredTransition(() =>
          withdrawInvestmentIndication(
            withdrawn,
            {
              occurredAt: transition.occurredAt,
              historyEntryId: transition.historyEntryId,
            },
            storedParticipantActor(source.actor),
          )
        );
        break;
      }
      case "reactivated": {
        if (indication === null) unavailable();
        const reactivated: InvestmentIndication = indication;
        indication = reconstructStoredTransition(() =>
          reactivateInvestmentIndication(
            reactivated,
            {
              occurredAt: transition.occurredAt,
              historyEntryId: transition.historyEntryId,
            },
            storedParticipantActor(source.actor),
            storedAcknowledgmentContext(acknowledgment),
          )
        );
        break;
      }
      case "rejected": {
        if (indication === null) unavailable();
        const rejected: InvestmentIndication = indication;
        const rejection = exactRecord(
          source.rejection,
          new Set(["reason", "rejectedAt", "rejectedBy"]),
        );
        indication = reconstructStoredTransition(() =>
          rejectInvestmentIndication(
            rejected,
            {
              occurredAt: transition.occurredAt,
              historyEntryId: transition.historyEntryId,
              reason: rejection.reason,
            },
            storedOwnerActor(source.actor),
          )
        );
        break;
      }
    }

    if (indication === null) unavailable();
    const reconstructed: InvestmentIndication = indication;
    const fingerprint = await fingerprintForStoredIndication(
      reconstructed,
      transition.operationId,
      transition.requestFingerprint,
      transition.fields,
    );
    if (
      fingerprint !== transition.operationFingerprint ||
      canonicalJson(
        transitionIndicationDocument(
          reconstructed,
          transition.operationId,
          transition.operationFingerprint,
          transition.requestFingerprint,
          transition.fields,
        ),
      ) !== canonicalJson(transition.document)
    ) {
      unavailable();
    }
  }

  if (indication === null) unavailable();
  const terminal = transitions.at(-1);
  if (terminal === undefined) unavailable();
  return Object.freeze({ indication, terminal, fieldsByRevision });
}

/**
 * Verify one current record against its complete immutable ancestry and any
 * required active uniqueness lease. Authorization remains with the caller.
 */
export async function materializeStoredIndicationCurrent(
  storage: IndicationReadStorage,
  record: StorageRecord,
  key: StorageKey,
  id: InvestmentIndicationId,
  expectedParticipantSubject: ActorSubject | null,
): Promise<MaterializedStoredIndicationCurrent> {
  const current = decodeStoredIndicationCurrent(
    record,
    key,
    id,
    expectedParticipantSubject,
  );
  const materialized = await materializeStoredIndication(
    storage,
    current.participantSubject,
    id,
    current.revision,
    null,
  );
  if (
    canonicalJson(
      currentIndicationDocument(
        materialized.indication,
        materialized.terminal.operationId,
        materialized.terminal.operationFingerprint,
        materialized.terminal.requestFingerprint,
        materialized.terminal.fields,
      ),
    ) !== canonicalJson(current.document)
  ) {
    unavailable();
  }
  await verifyStoredActiveIndicationLease(
    storage,
    current,
    materialized.fieldsByRevision.get(current.fields.revision)?.fields ??
      unavailable(),
    materialized.indication.lifecycle.status,
  );
  return Object.freeze({ current, materialized });
}

/** Read one participant-owned current indication without consulting any index. */
export async function readParticipantStoredIndication(
  storage: IndicationReadStorage,
  participantSubject: ActorSubject,
  id: InvestmentIndicationId,
): Promise<InvestmentIndication | null> {
  const key = await indicationCurrentStorageKey(id);
  const record = await storage.read(key);
  if (record === null) return null;
  if (peekStoredIndicationParticipantSubject(record) !== participantSubject) {
    return null;
  }
  const verified = await materializeStoredIndicationCurrent(
    storage,
    record,
    key,
    id,
    participantSubject,
  );
  return verified.materialized.indication;
}

/**
 * Resolve an owner-authorized opaque current key without listing or exposing
 * the participant subject outside the returned verified indication.
 */
export async function readStoredIndicationByCurrentKey(
  storage: IndicationReadStorage,
  key: StorageKey,
): Promise<MaterializedStoredIndication | null> {
  const record = await storage.read(key);
  if (record === null) return null;
  const coordinates = indicationCoordinatesFromCurrentDocument(record.value);
  const expectedKey = await indicationCurrentStorageKey(coordinates.id);
  if (
    key.collection !== expectedKey.collection ||
    key.id !== expectedKey.id
  ) {
    unavailable();
  }
  return (await materializeStoredIndicationCurrent(
    storage,
    record,
    key,
    coordinates.id,
    null,
  )).materialized;
}

export async function verifyStoredActiveIndicationLease(
  storage: IndicationReadStorage,
  current: StoredIndicationCurrent,
  fields: InvestmentIndicationFields,
  status: InvestmentIndication["lifecycle"]["status"],
): Promise<void> {
  if (status !== "active") return;
  const uniquenessKey = fields.kind === "personal"
    ? JSON.stringify(["personal", current.participantSubject])
    : JSON.stringify(["company", fields.registrationCountry, fields.companyIdentifier]);
  const hexadecimal = await sha256Hex(`active-indication-uniqueness\u0000${uniquenessKey}`);
  const fingerprint = `sha256:${hexadecimal}`;
  const key = requiredStorageKey(ACTIVE_UNIQUENESS_KEYS, `active-key:${hexadecimal}`);
  const record = await storage.read(key);
  if (record === null) unavailable();
  const source = exactStoredDocument(record, key, LEASE_DOCUMENT_KEYS, "active-indication-lease");
  if (
    record.revision !== 1 || source.indicationId !== current.indicationId ||
    source.uniquenessFingerprint !== fingerprint ||
    canonicalJson(source) !== canonicalJson({
      kind: "active-indication-lease", schemaVersion: INDICATION_SCHEMA_VERSION,
      indicationId: current.indicationId, uniquenessFingerprint: fingerprint,
    })
  ) unavailable();
}

export function fieldsReferenceDocument(
  reference: StoredIndicationFieldsReference,
): StorageDocument {
  return Object.freeze({
    revision: reference.revision, hash: reference.hash,
    bytes: reference.bytes, chunks: reference.chunks,
  });
}

export function canonicalIndicationJson(value: unknown): string {
  return canonicalJson(value);
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
  return Object.freeze({
    currentVersion: version,
    latestAcceptance: acknowledgment,
  });
}

function storedAmountConfiguration(
  fields: InvestmentIndicationFields,
): AmountConfiguration {
  return storedAmountConfigurationFromDocument(fieldsDocument(fields));
}

function domainFieldsInput(
  fields: InvestmentIndicationFields,
): StorageDocument {
  const input = { ...fieldsDocument(fields) } as Record<string, unknown>;
  delete input.currency;
  return input as StorageDocument;
}

function transitionIndicationDocument(
  indication: InvestmentIndication,
  operationId: StorageOperationId,
  fingerprint: string,
  requestFingerprint: string,
  fields: StoredIndicationFieldsReference,
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
    rejection: entry.rejection === null
      ? null
      : rejectionDocument(entry.rejection),
  });
}

function currentIndicationDocument(
  indication: InvestmentIndication,
  operationId: StorageOperationId,
  fingerprint: string,
  requestFingerprint: string,
  fields: StoredIndicationFieldsReference,
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
  fieldsReference: StoredIndicationFieldsReference,
): Promise<string> {
  const entry = indication.history.at(-1);
  if (entry === undefined) unavailable();
  return compactOperationFingerprint(
    mutationKindForTransition(entry.transition),
    entry.actor,
    {
      operationId,
      id: indication.id,
      occurredAt: entry.occurredAt,
      historyEntryId: entry.id,
      expectedRevision: indication.revision === 1
        ? null
        : indication.revision - 1,
      ...(entry.transition === "created" || entry.transition === "edited"
        ? { fields: fieldsReference }
        : {}),
      ...(entry.transition === "rejected" && entry.rejection !== null
        ? { reason: entry.rejection.reason }
        : {}),
    },
    requestFingerprint,
  );
}

function mutationKindForTransition(
  transition: InvestmentIndicationHistoryEntry["transition"],
): "create" | "edit" | "withdraw" | "reactivate" | "reject" {
  switch (transition) {
    case "created": return "create";
    case "edited": return "edit";
    case "withdrawn": return "withdraw";
    case "reactivated": return "reactivate";
    case "rejected": return "reject";
  }
}

async function compactOperationFingerprint(
  kind: "create" | "edit" | "withdraw" | "reactivate" | "reject",
  actor: ParticipantIndicationActor | OwnerIndicationActor,
  request: Readonly<{
    operationId: StorageOperationId;
    id: InvestmentIndicationId;
    occurredAt: Timestamp;
    historyEntryId: InvestmentIndicationHistoryEntryId;
    expectedRevision: number | null;
    fields?: StoredIndicationFieldsReference;
    reason?: string;
  }>,
  requestFingerprint: string,
): Promise<string> {
  return hashDocument({
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
      : { fields: fieldsReferenceDocument(request.fields) }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
  });
}

async function hashDocument(value: StorageDocument): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(value))}`;
}

function exactStoredDocument(
  record: StorageRecord, expectedKey: StorageKey, expectedKeys: ReadonlySet<string>, expectedKind: string,
): Record<string, unknown> {
  const envelope = exactRecord(record, STORAGE_RECORD_KEYS);
  const key = exactRecord(envelope.key, STORAGE_KEY_KEYS);
  const source = exactRecord(envelope.value, expectedKeys);
  if (
    key.collection !== expectedKey.collection || key.id !== expectedKey.id ||
    !Number.isSafeInteger(envelope.revision) || envelope.revision !== record.revision ||
    source.kind !== expectedKind || source.schemaVersion !== INDICATION_SCHEMA_VERSION ||
    jsonByteLength(source) > MAX_INDICATION_STORAGE_RECORD_BYTES
  ) unavailable();
  return source;
}

export function peekStoredIndicationParticipantSubject(
  record: StorageRecord,
): ActorSubject {
  const envelope = exactRecord(record, STORAGE_RECORD_KEYS);
  const source = objectRecord(envelope.value);
  if (source === null) unavailable();
  return storedActorSubject(source.participantSubject);
}

function storedOperationId(value: unknown): StorageOperationId {
  const parsed = parseStorageOperationId(value); if (!parsed.ok) unavailable(); return parsed.value;
}
function storedFingerprint(value: unknown): string {
  if (typeof value !== "string" || !isSha256(value)) unavailable(); return value;
}
function storedIndicationId(value: unknown): InvestmentIndicationId {
  const parsed = parseStableId<"investment-indication">(value); if (!parsed.ok) unavailable(); return parsed.value;
}
function storedActorSubject(value: unknown): ActorSubject {
  const parsed = parseActorSubject(value); if (!parsed.ok) unavailable(); return parsed.value;
}
function storedHistoryEntryId(value: unknown): InvestmentIndicationHistoryEntryId {
  const parsed = parseStableId<"investment-indication-history-entry">(value); if (!parsed.ok) unavailable(); return parsed.value;
}
function storedTimestamp(value: unknown): Timestamp {
  const parsed = parseTimestamp(value); if (!parsed.ok) unavailable(); return parsed.value;
}
function storedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_INVESTMENT_INDICATION_REVISIONS) unavailable();
  return value as number;
}
function storedTransitionKind(value: unknown): InvestmentIndicationHistoryEntry["transition"] {
  if (value !== "created" && value !== "edited" && value !== "withdrawn" && value !== "reactivated" && value !== "rejected") unavailable();
  return value;
}
function storedFieldsReference(value: unknown): StoredIndicationFieldsReference {
  const source = exactRecord(value, FIELDS_REFERENCE_KEYS);
  const revision = storedRevision(source.revision);
  if (
    typeof source.hash !== "string" || !isSha256(source.hash) ||
    !Number.isSafeInteger(source.bytes) || (source.bytes as number) < 1 ||
    (source.bytes as number) > MAX_SERIALIZED_INDICATION_FIELDS_BYTES ||
    !Number.isSafeInteger(source.chunks) || (source.chunks as number) < 1 ||
    (source.chunks as number) > MAX_INDICATION_FIELDS_CHUNKS ||
    Math.ceil((source.bytes as number) / INDICATION_FIELDS_CHUNK_RAW_BYTES) !== source.chunks
  ) unavailable();
  return Object.freeze({ revision, hash: source.hash, bytes: source.bytes as number, chunks: source.chunks as number });
}
function storedFieldsDocument(value: unknown): Record<string, unknown> {
  const source = objectRecord(value);
  if (source === null) unavailable();
  return source.kind === "personal" ? exactRecord(source, PERSONAL_FIELDS_DOCUMENT_KEYS)
    : source.kind === "company" ? exactRecord(source, COMPANY_FIELDS_DOCUMENT_KEYS) : unavailable();
}
function storedAmountConfigurationFromDocument(value: unknown): AmountConfiguration {
  const source = objectRecord(value);
  const parsed = parseAmountAggregateConfiguration({ amount: { currency: source?.currency, minimum: 0, increment: 1, maximum: null }, publicAggregate: { visibility: "hidden" } });
  if (!parsed.ok) unavailable(); return parsed.value.amount;
}
function storedParsingOptions(): InvestmentIndicationParsingOptions {
  return Object.freeze({ country: Object.freeze({ normalize: (value: string) => value }), companyIdentifier: Object.freeze({ normalize: (value: string) => value }) });
}
function storedDomainFieldsInput(value: unknown): StorageDocument {
  const source = objectRecord(value); if (source === null || !("currency" in source)) unavailable();
  const input = { ...source }; delete input.currency; return input as StorageDocument;
}
function fieldsDocument(fields: InvestmentIndicationFields): StorageDocument {
  return fields.kind === "personal" ? {
    kind: fields.kind, residenceCountry: fields.residenceCountry, amount: fields.amount,
    currency: fields.currency, availabilityPeriod: fields.availabilityPeriod, note: fields.note,
  } : {
    kind: fields.kind, companyName: fields.companyName, registrationCountry: fields.registrationCountry,
    companyIdentifier: fields.companyIdentifier, representativeName: fields.representativeName,
    representativeAuthorityDeclared: fields.representativeAuthorityDeclared, amount: fields.amount,
    currency: fields.currency, availabilityPeriod: fields.availabilityPeriod, note: fields.note,
  };
}
async function hashedStorageId(namespace: string, value: string): Promise<string> {
  return `${namespace}:${await sha256Hex(`${namespace}\u0000${value}`)}`;
}
async function sha256Hex(value: string): Promise<string> { return sha256BytesHex(new TextEncoder().encode(value)); }
async function sha256BytesHex(value: Uint8Array): Promise<string> {
  let digest: ArrayBuffer;
  try { const input = new Uint8Array(value.byteLength); input.set(value); digest = await crypto.subtle.digest("SHA-256", input); }
  catch { unavailable(); }
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) unavailable();
  const padding = (4 - value.length % 4) % 4;
  let binary: string;
  try { binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat(padding)); } catch { return unavailable(); }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64UrlEncode(bytes) !== value) unavailable(); return bytes;
}
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""; for (let offset = 0; offset < bytes.length; offset += 8_192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function collection(value: string): StorageCollection {
  const parsed = parseStorageCollection(value); if (!parsed.ok) throw new Error("Invalid indication storage collection."); return parsed.value;
}
function requiredStorageKey(collectionValue: StorageCollection, id: string): StorageKey {
  const parsed = parseStorageKey(collectionValue, id); if (!parsed.ok) unavailable(); return parsed.value;
}
function objectRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
  }
  return result;
}
function exactRecord(value: unknown, expected: ReadonlySet<string>): Record<string, unknown> {
  const source = objectRecord(value); if (source === null || !hasExactKeys(source, expected)) unavailable(); return source;
}
function hasExactKeys(source: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(source); return keys.length === expected.size && keys.every((key) => expected.has(key));
}
function exactDenseArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum || Object.keys(value).length !== value.length) unavailable(); return value;
}
function canonicalJson(value: unknown): string { return canonicalJsonValue(value, 0, new Set<object>(), { nodes: 0 }); }
function canonicalJsonValue(value: unknown, depth: number, ancestors: ReadonlySet<object>, state: { nodes: number }): string {
  state.nodes += 1;
  if (depth > MAX_INDICATION_CANONICAL_DEPTH || state.nodes > MAX_INDICATION_CANONICAL_NODES) unavailable();
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) unavailable(); return JSON.stringify(value); }
  if (typeof value !== "object" || ancestors.has(value)) unavailable();
  const nextAncestors = new Set(ancestors); nextAncestors.add(value);
  if (Array.isArray(value)) return `[${exactDenseArray(value, value.length).map((entry) => canonicalJsonValue(entry, depth + 1, nextAncestors, state)).join(",")}]`;
  const source = objectRecord(value); if (source === null) unavailable();
  return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(source[key], depth + 1, nextAncestors, state)}`).join(",")}}`;
}
function jsonByteLength(value: unknown): number { return new TextEncoder().encode(canonicalJson(value)).byteLength; }
function isSha256(value: string): boolean { return /^sha256:[0-9a-f]{64}$/.test(value); }
function invalidRequest(): never { throw new StorageFailure("INVALID_REQUEST"); }
function unavailable(): never { throw new StorageFailure("UNAVAILABLE"); }
