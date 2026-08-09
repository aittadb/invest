import {
  createManualNotificationRecord,
  markManualNotificationSent,
  parseAuditAppendIntent,
  parseManualNotificationTemplate,
  recordManualNotificationCopy,
  type AuditEvent,
  type AuditEventDetail,
  type ManualNotificationCopyEvidence,
  type ManualNotificationId,
  type ManualNotificationRecord,
  type ManualNotificationSentMarker,
  type ManualNotificationTemplate,
} from "../domain/audit-notification.ts";
import {
  parseActorSubject,
  parseStableId,
  parseTimestamp,
  type ActorSubject,
  type StableId,
  type Timestamp,
} from "../domain/foundation.ts";
import {
  StorageFailure,
  assertStorageListBoundary,
  parseStorageCollection,
  parseStorageKey,
  parseStorageOperationId,
  storageKeyString,
  type StorageAdapter,
  type StorageCollection,
  type StorageCursor,
  type StorageDocument,
  type StorageKey,
  type StorageOperationId,
  type StoragePutMutation,
  type StorageRecord,
} from "../domain/storage-adapter.ts";

const AUDIT_SCHEMA_VERSION = 1;
const NOTIFICATION_SCHEMA_VERSION = 1;
const AUDIT_EVENTS = storageCollection("audit-events");
const CURRENT_NOTIFICATIONS = storageCollection("manual-notifications");
const NOTIFICATION_HISTORY = storageCollection("manual-notification-history");
const AUDIT_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "event",
]);
const NOTIFICATION_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "revision",
  "record",
]);
const NOTIFICATION_RECORD_KEYS = new Set([
  "template",
  "copyEvidence",
  "sentMarker",
]);

export type AuditAppendResult = Readonly<{
  event: AuditEvent;
  replayed: boolean;
}>;

/**
 * Validated audit mutation that can join another repository's transaction.
 * This is intentionally narrow: callers cannot select the audit collection or
 * serialized document shape, and must verify the returned storage record.
 */
export type PreparedAuditAppend = Readonly<{
  event: AuditEvent;
  operationId: StorageOperationId;
  mutation: StoragePutMutation;
}>;

export type AuditListRequest = Readonly<{
  limit: number;
  cursor?: StorageCursor;
}>;

export type AuditEventPage = Readonly<{
  items: readonly AuditEvent[];
  nextCursor: StorageCursor | null;
}>;

/** Append-only, owner-private audit persistence boundary. */
export interface AuditRepository {
  append(intent: unknown): Promise<AuditAppendResult>;
  get(id: unknown): Promise<AuditEvent | null>;
  list(request: AuditListRequest): Promise<AuditEventPage>;
}

export function prepareAuditAppend(intent: unknown): PreparedAuditAppend {
  const parsed = parseAuditAppendIntent(intent);
  if (!parsed.ok) invalidRequest();

  const event = parsed.value.event;
  return Object.freeze({
    event,
    operationId: requiredOperationId(event.operationId),
    mutation: Object.freeze({
      type: "put" as const,
      key: auditEventKey(event.id),
      expectedRevision: null,
      value: auditDocument(event),
    }),
  });
}

export function verifyPreparedAuditAppend(
  prepared: PreparedAuditAppend,
  stored: StorageRecord | null | undefined,
): AuditEvent {
  if (!stored) unavailable();
  const event = decodeAuditEvent(stored, prepared.mutation.key);
  if (canonicalJson(auditEventDocument(event)) !==
    canonicalJson(auditEventDocument(prepared.event))) {
    unavailable();
  }
  return event;
}

export type ManualNotificationSnapshot = Readonly<{
  revision: number;
  record: ManualNotificationRecord;
}>;

export type ManualNotificationMutationResult = ManualNotificationSnapshot &
  Readonly<{ replayed: boolean }>;

export type CreateManualNotificationRequest = Readonly<{
  operationId: unknown;
  template: unknown;
}>;

export type RecordManualNotificationCopyRequest = Readonly<{
  operationId: unknown;
  notificationId: unknown;
  expectedRevision: unknown;
  evidence: unknown;
}>;

export type MarkManualNotificationSentRequest = Readonly<{
  operationId: unknown;
  notificationId: unknown;
  expectedRevision: unknown;
  marker: unknown;
}>;

export type AuditedManualNotificationActivityRequest = Readonly<{
  operationId: unknown;
  notificationId: unknown;
  expectedRevision: unknown;
  ownerSubject: unknown;
  occurredAt: unknown;
}>;

export type AuditedManualNotificationMutationResult =
  ManualNotificationMutationResult & Readonly<{ auditEvent: AuditEvent }>;

export type ManualNotificationListRequest = Readonly<{
  limit: number;
  cursor?: StorageCursor;
}>;

export type ManualNotificationPage = Readonly<{
  items: readonly ManualNotificationSnapshot[];
  nextCursor: StorageCursor | null;
}>;

/** Private manual-notification persistence boundary. */
export interface ManualNotificationRepository {
  create(
    request: CreateManualNotificationRequest,
  ): Promise<ManualNotificationMutationResult>;
  get(id: unknown): Promise<ManualNotificationSnapshot | null>;
  list(
    request: ManualNotificationListRequest,
  ): Promise<ManualNotificationPage>;
  recordCopy(
    request: RecordManualNotificationCopyRequest,
  ): Promise<ManualNotificationMutationResult>;
  markSent(
    request: MarkManualNotificationSentRequest,
  ): Promise<ManualNotificationMutationResult>;
}

export interface AtomicManualNotificationActivityRepository {
  readonly activityConsistency: "atomic-notification-audit";
  get(id: unknown): Promise<ManualNotificationSnapshot | null>;
  list(
    request: ManualNotificationListRequest,
  ): Promise<ManualNotificationPage>;
  recordCopyWithAudit(
    request: AuditedManualNotificationActivityRequest,
  ): Promise<AuditedManualNotificationMutationResult>;
  markSentWithAudit(
    request: AuditedManualNotificationActivityRequest,
  ): Promise<AuditedManualNotificationMutationResult>;
}

/** Deterministic development repository with no state outside its adapter. */
export class DevelopmentInMemoryAuditRepository implements AuditRepository {
  readonly storageKind = "development-in-memory" as const;

  readonly #storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.#storage = storage;
  }

  async append(intent: unknown): Promise<AuditAppendResult> {
    const prepared = prepareAuditAppend(intent);
    const result = await this.#storage.transact({
      operationId: prepared.operationId,
      mutations: [prepared.mutation],
    });

    return Object.freeze({
      event: verifyPreparedAuditAppend(prepared, result.records[0]),
      replayed: result.replayed,
    });
  }

  async get(id: unknown): Promise<AuditEvent | null> {
    const eventId = requiredStableId<"audit-event">(id);
    const key = auditEventKey(eventId);
    const stored = await this.#storage.read(key);
    return stored === null ? null : decodeAuditEvent(stored, key);
  }

  async list(request: AuditListRequest): Promise<AuditEventPage> {
    const storageRequest = {
      collection: AUDIT_EVENTS,
      limit: request.limit,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    };
    assertStorageListBoundary(storageRequest);
    const page = await this.#storage.list(storageRequest);

    return Object.freeze({
      items: Object.freeze(page.items.map((stored) =>
        decodeAuditEvent(stored, stored.key)
      )),
      nextCursor: page.nextCursor,
    });
  }
}

/**
 * Deterministic private notification repository. Current records and immutable
 * revisions are both stored so delayed retries can rebuild the original write.
 */
export class DevelopmentInMemoryManualNotificationRepository
  implements
    ManualNotificationRepository,
    AtomicManualNotificationActivityRepository
{
  readonly storageKind = "development-in-memory" as const;
  readonly activityConsistency = "atomic-notification-audit" as const;

  readonly #storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.#storage = storage;
  }

  async create(
    request: CreateManualNotificationRequest,
  ): Promise<ManualNotificationMutationResult> {
    const operationId = requiredOperationId(request.operationId);
    const template = parseManualNotificationTemplate(request.template);
    if (!template.ok) invalidRequest();

    const snapshot = Object.freeze({
      revision: 1,
      record: createManualNotificationRecord(template.value),
    });
    return this.#write(snapshot, null, operationId);
  }

  async get(id: unknown): Promise<ManualNotificationSnapshot | null> {
    const notificationId = requiredNotificationId(id);
    const key = await currentNotificationKey(notificationId);
    const stored = await this.#storage.read(key);
    if (stored === null) return null;

    const snapshot = await decodeNotificationSnapshot(
      stored,
      key,
      "current",
      notificationId,
      null,
    );
    await this.#verifyHistory(snapshot);
    return snapshot;
  }

  async list(
    request: ManualNotificationListRequest,
  ): Promise<ManualNotificationPage> {
    const storageRequest = {
      collection: CURRENT_NOTIFICATIONS,
      limit: request.limit,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    };
    assertStorageListBoundary(storageRequest);
    const page = await this.#storage.list(storageRequest);
    const items = await Promise.all(page.items.map(async (stored) => {
      const snapshot = await decodeNotificationSnapshot(
        stored,
        stored.key,
        "current",
        null,
        null,
      );
      await this.#verifyHistory(snapshot);
      return snapshot;
    }));

    return Object.freeze({
      items: Object.freeze(items),
      nextCursor: page.nextCursor,
    });
  }

  async recordCopy(
    request: RecordManualNotificationCopyRequest,
  ): Promise<ManualNotificationMutationResult> {
    const operationId = requiredOperationId(request.operationId);
    const notificationId = requiredNotificationId(request.notificationId);
    const expectedRevision = requiredExpectedRevision(request.expectedRevision);
    const base = await this.#readMutationBase(notificationId, expectedRevision);
    const changed = recordManualNotificationCopy(base.record, request.evidence);
    if (!changed.ok) invalidRequest();
    if (changed.value === base.record) throw new StorageFailure("CONFLICT");

    return this.#write(
      Object.freeze({
        revision: expectedRevision + 1,
        record: changed.value,
      }),
      expectedRevision,
      operationId,
    );
  }

  async markSent(
    request: MarkManualNotificationSentRequest,
  ): Promise<ManualNotificationMutationResult> {
    const operationId = requiredOperationId(request.operationId);
    const notificationId = requiredNotificationId(request.notificationId);
    const expectedRevision = requiredExpectedRevision(request.expectedRevision);
    const base = await this.#readMutationBase(notificationId, expectedRevision);
    const changed = markManualNotificationSent(base.record, request.marker);
    if (!changed.ok) invalidRequest();
    if (changed.value === base.record) throw new StorageFailure("CONFLICT");

    return this.#write(
      Object.freeze({
        revision: expectedRevision + 1,
        record: changed.value,
      }),
      expectedRevision,
      operationId,
    );
  }

  async recordCopyWithAudit(
    request: AuditedManualNotificationActivityRequest,
  ): Promise<AuditedManualNotificationMutationResult> {
    return this.#applyAuditedActivity(request, "template-copied");
  }

  async markSentWithAudit(
    request: AuditedManualNotificationActivityRequest,
  ): Promise<AuditedManualNotificationMutationResult> {
    return this.#applyAuditedActivity(request, "sent-marked");
  }

  async #applyAuditedActivity(
    request: AuditedManualNotificationActivityRequest,
    activity: "template-copied" | "sent-marked",
  ): Promise<AuditedManualNotificationMutationResult> {
    const operationId = requiredOperationId(request.operationId);
    const notificationId = requiredNotificationId(request.notificationId);
    const expectedRevision = requiredExpectedRevision(request.expectedRevision);
    const ownerSubject = requiredOwnerSubject(request.ownerSubject);
    const occurredAt = requiredOccurredAt(request.occurredAt);
    const base = await this.#readMutationBase(notificationId, expectedRevision);
    const changed = activity === "template-copied"
      ? recordManualNotificationCopy(base.record, {
          id: await activityEvidenceId<"manual-notification-copy">(
            "notification-copy",
            operationId,
          ),
          copiedAt: occurredAt,
          copiedBy: { type: "owner", subject: ownerSubject },
        })
      : markManualNotificationSent(base.record, {
          id: await activityEvidenceId<"manual-notification-sent-marker">(
            "notification-sent",
            operationId,
          ),
          sentAt: occurredAt,
          sentBy: { type: "owner", subject: ownerSubject },
        });
    if (!changed.ok) invalidRequest();
    if (changed.value === base.record) throw new StorageFailure("CONFLICT");

    const auditEvent = await manualNotificationAuditEvent(
      operationId,
      notificationId,
      ownerSubject,
      occurredAt,
      activity,
    );
    const preparedAudit = prepareAuditAppend({
      type: "append-audit-event",
      event: auditEvent,
    });
    if (preparedAudit.operationId !== operationId) unavailable();
    const result = await this.#write(
      Object.freeze({
        revision: expectedRevision + 1,
        record: changed.value,
      }),
      expectedRevision,
      operationId,
      preparedAudit,
    );
    return Object.freeze({ ...result, auditEvent });
  }

  async #readMutationBase(
    id: ManualNotificationId,
    expectedRevision: number,
  ): Promise<ManualNotificationSnapshot> {
    const current = await this.get(id);
    if (current === null) notFound();
    if (expectedRevision > current.revision) {
      throw new StorageFailure("PRECONDITION_FAILED");
    }

    const key = await notificationHistoryKey(id, expectedRevision);
    const stored = await this.#storage.read(key);
    if (stored === null) unavailable();
    return decodeNotificationSnapshot(
      stored,
      key,
      "history",
      id,
      expectedRevision,
    );
  }

  async #write(
    snapshot: ManualNotificationSnapshot,
    expectedRevision: number | null,
    operationId: StorageOperationId,
    preparedAudit: PreparedAuditAppend | null = null,
  ): Promise<ManualNotificationMutationResult> {
    if (snapshot.revision !== (expectedRevision === null ? 1 : expectedRevision + 1)) {
      unavailable();
    }
    const id = snapshot.record.template.id;
    const currentKey = await currentNotificationKey(id);
    const historyKey = await notificationHistoryKey(id, snapshot.revision);
    const value = notificationDocument(snapshot);
    const result = await this.#storage.transact({
      operationId,
      mutations: [
        {
          type: "put",
          key: currentKey,
          expectedRevision,
          value,
        },
        {
          type: "put",
          key: historyKey,
          expectedRevision: null,
          value,
        },
        ...(preparedAudit === null ? [] : [preparedAudit.mutation]),
      ],
    });
    const currentRecord = result.records[0];
    const historyRecord = result.records[1];
    if (!currentRecord || !historyRecord) unavailable();
    if (preparedAudit !== null) {
      verifyPreparedAuditAppend(preparedAudit, result.records[2]);
    }

    const current = await decodeNotificationSnapshot(
      currentRecord,
      currentKey,
      "current",
      id,
      snapshot.revision,
    );
    const historical = await decodeNotificationSnapshot(
      historyRecord,
      historyKey,
      "history",
      id,
      snapshot.revision,
    );
    if (
      canonicalJson(notificationSnapshotDocument(current)) !==
        canonicalJson(notificationSnapshotDocument(historical)) ||
      canonicalJson(notificationSnapshotDocument(current)) !==
        canonicalJson(notificationSnapshotDocument(snapshot))
    ) {
      unavailable();
    }

    return Object.freeze({
      revision: current.revision,
      record: current.record,
      replayed: result.replayed,
    });
  }

  async #verifyHistory(snapshot: ManualNotificationSnapshot): Promise<void> {
    let previous: ManualNotificationSnapshot | null = null;
    for (let revision = 1; revision <= snapshot.revision; revision += 1) {
      const key = await notificationHistoryKey(snapshot.record.template.id, revision);
      const stored = await this.#storage.read(key);
      if (stored === null) unavailable();
      const historical = await decodeNotificationSnapshot(
        stored,
        key,
        "history",
        snapshot.record.template.id,
        revision,
      );
      if (previous === null) {
        if (
          historical.record.copyEvidence.length !== 0 ||
          historical.record.sentMarker !== null
        ) {
          unavailable();
        }
      } else if (!isValidNotificationTransition(previous.record, historical.record)) {
        unavailable();
      }
      previous = historical;
    }

    if (
      previous === null ||
      canonicalJson(notificationSnapshotDocument(previous)) !==
        canonicalJson(notificationSnapshotDocument(snapshot))
    ) {
      unavailable();
    }
  }
}

function auditDocument(event: AuditEvent): StorageDocument {
  return Object.freeze({
    kind: "audit-event",
    schemaVersion: AUDIT_SCHEMA_VERSION,
    event: auditEventDocument(event),
  });
}

function auditEventDocument(event: AuditEvent): StorageDocument {
  return {
    id: event.id,
    operationId: event.operationId,
    occurredAt: event.occurredAt,
    actor: event.actor.type === "system"
      ? { type: "system" }
      : { type: event.actor.type, subject: event.actor.subject },
    detail: auditDetailDocument(event.detail),
  };
}

function auditDetailDocument(detail: AuditEventDetail): StorageDocument {
  if (detail.kind === "export-created") {
    return { kind: detail.kind, exportType: detail.exportType };
  }
  if (detail.kind === "manual-notification") {
    return {
      kind: detail.kind,
      notificationId: detail.notificationId,
      activity: detail.activity,
    };
  }
  return {
    kind: detail.kind,
    resource: { type: detail.resource.type, id: detail.resource.id },
    transition: detail.transition,
  };
}

function decodeAuditEvent(record: StorageRecord, expectedKey: StorageKey): AuditEvent {
  if (
    storageKeyString(record.key) !== storageKeyString(expectedKey) ||
    record.revision !== 1
  ) {
    unavailable();
  }
  const source = objectRecord(record.value);
  if (
    source === null ||
    !hasExactKeys(source, AUDIT_DOCUMENT_KEYS) ||
    source.kind !== "audit-event" ||
    source.schemaVersion !== AUDIT_SCHEMA_VERSION
  ) {
    unavailable();
  }
  const parsed = parseAuditAppendIntent({
    type: "append-audit-event",
    event: source.event,
  });
  if (!parsed.ok) unavailable();
  if (storageKeyString(auditEventKey(parsed.value.event.id)) !== storageKeyString(expectedKey)) {
    unavailable();
  }
  return parsed.value.event;
}

function notificationDocument(snapshot: ManualNotificationSnapshot): StorageDocument {
  return Object.freeze({
    kind: "manual-notification-record",
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    revision: snapshot.revision,
    record: notificationRecordDocument(snapshot.record),
  });
}

function notificationSnapshotDocument(
  snapshot: ManualNotificationSnapshot,
): StorageDocument {
  return {
    revision: snapshot.revision,
    record: notificationRecordDocument(snapshot.record),
  };
}

function notificationRecordDocument(record: ManualNotificationRecord): StorageDocument {
  return {
    template: notificationTemplateDocument(record.template),
    copyEvidence: record.copyEvidence.map(copyEvidenceDocument),
    sentMarker: record.sentMarker === null
      ? null
      : sentMarkerDocument(record.sentMarker),
  };
}

function notificationTemplateDocument(
  template: ManualNotificationTemplate,
): StorageDocument {
  return {
    id: template.id,
    purposeId: template.purposeId,
    recipientSubject: template.recipientSubject,
    relatedResource: {
      type: template.relatedResource.type,
      id: template.relatedResource.id,
    },
    subjectLine: template.subjectLine,
    body: template.body,
    generatedAt: template.generatedAt,
    generatedBy: {
      type: "owner",
      subject: template.generatedBy.subject,
    },
  };
}

function copyEvidenceDocument(
  evidence: ManualNotificationCopyEvidence,
): StorageDocument {
  return {
    id: evidence.id,
    copiedAt: evidence.copiedAt,
    copiedBy: { type: "owner", subject: evidence.copiedBy.subject },
  };
}

function sentMarkerDocument(marker: ManualNotificationSentMarker): StorageDocument {
  return {
    id: marker.id,
    sentAt: marker.sentAt,
    sentBy: { type: "owner", subject: marker.sentBy.subject },
  };
}

async function decodeNotificationSnapshot(
  stored: StorageRecord,
  expectedKey: StorageKey,
  recordKind: "current" | "history",
  expectedId: ManualNotificationId | null,
  expectedRevision: number | null,
): Promise<ManualNotificationSnapshot> {
  if (storageKeyString(stored.key) !== storageKeyString(expectedKey)) unavailable();
  const source = objectRecord(stored.value);
  if (
    source === null ||
    !hasExactKeys(source, NOTIFICATION_DOCUMENT_KEYS) ||
    source.kind !== "manual-notification-record" ||
    source.schemaVersion !== NOTIFICATION_SCHEMA_VERSION ||
    !isPositiveSafeInteger(source.revision)
  ) {
    unavailable();
  }
  const revision = source.revision;
  if (
    (expectedRevision !== null && revision !== expectedRevision) ||
    (recordKind === "current" && stored.revision !== revision) ||
    (recordKind === "history" && stored.revision !== 1)
  ) {
    unavailable();
  }

  const record = reconstructNotificationRecord(source.record);
  if (expectedId !== null && record.template.id !== expectedId) unavailable();
  const actualKey = recordKind === "current"
    ? await currentNotificationKey(record.template.id)
    : await notificationHistoryKey(record.template.id, revision);
  if (storageKeyString(actualKey) !== storageKeyString(expectedKey)) unavailable();

  return Object.freeze({ revision, record });
}

function reconstructNotificationRecord(value: unknown): ManualNotificationRecord {
  const source = objectRecord(value);
  if (
    source === null ||
    !hasExactKeys(source, NOTIFICATION_RECORD_KEYS) ||
    !Array.isArray(source.copyEvidence)
  ) {
    unavailable();
  }
  const template = parseManualNotificationTemplate(source.template);
  if (!template.ok) unavailable();

  let record = createManualNotificationRecord(template.value);
  for (const evidence of source.copyEvidence) {
    const copied = recordManualNotificationCopy(record, evidence);
    if (!copied.ok) unavailable();
    record = copied.value;
  }
  if (source.sentMarker !== null) {
    const sent = markManualNotificationSent(record, source.sentMarker);
    if (!sent.ok) unavailable();
    record = sent.value;
  }
  if (
    canonicalJson(notificationRecordDocument(record)) !== canonicalJson(value)
  ) {
    unavailable();
  }
  return record;
}

function isValidNotificationTransition(
  previous: ManualNotificationRecord,
  next: ManualNotificationRecord,
): boolean {
  if (
    canonicalJson(notificationTemplateDocument(previous.template)) !==
      canonicalJson(notificationTemplateDocument(next.template))
  ) {
    return false;
  }

  const sameCopies = canonicalJson(previous.copyEvidence.map(copyEvidenceDocument)) ===
    canonicalJson(next.copyEvidence.map(copyEvidenceDocument));
  const appendedOneCopy = next.copyEvidence.length === previous.copyEvidence.length + 1 &&
    canonicalJson(previous.copyEvidence.map(copyEvidenceDocument)) ===
      canonicalJson(next.copyEvidence.slice(0, -1).map(copyEvidenceDocument)) &&
    canonicalJson(previous.sentMarker) === canonicalJson(next.sentMarker);
  const addedSentMarker = sameCopies &&
    previous.sentMarker === null &&
    next.sentMarker !== null;
  return appendedOneCopy || addedSentMarker;
}

function auditEventKey(id: StableId<"audit-event">): StorageKey {
  return requiredStorageKey(AUDIT_EVENTS, id);
}

async function currentNotificationKey(id: ManualNotificationId): Promise<StorageKey> {
  return requiredStorageKey(
    CURRENT_NOTIFICATIONS,
    await hashedStorageId("notification-current", id),
  );
}

async function notificationHistoryKey(
  id: ManualNotificationId,
  revision: number,
): Promise<StorageKey> {
  return requiredStorageKey(
    NOTIFICATION_HISTORY,
    await hashedStorageId("notification-history", `${id}\u0000${revision}`),
  );
}

async function hashedStorageId(namespace: string, value: string): Promise<string> {
  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${namespace}\u0000${value}`),
    );
  } catch {
    unavailable();
  }
  const hexadecimal = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${namespace}:${hexadecimal}`;
}

async function activityEvidenceId<Entity extends string>(
  namespace: string,
  operationId: StorageOperationId,
): Promise<StableId<Entity>> {
  return requiredStableId<Entity>(await hashedStorageId(namespace, operationId));
}

async function manualNotificationAuditEvent(
  operationId: StorageOperationId,
  notificationId: ManualNotificationId,
  ownerSubject: ActorSubject,
  occurredAt: Timestamp,
  activity: "template-copied" | "sent-marked",
): Promise<AuditEvent> {
  return Object.freeze({
    id: await activityEvidenceId<"audit-event">(
      "notification-audit",
      operationId,
    ),
    operationId: requiredStableId<"audit-operation">(operationId),
    occurredAt,
    actor: Object.freeze({ type: "owner", subject: ownerSubject }),
    detail: Object.freeze({
      kind: "manual-notification",
      notificationId,
      activity,
    }),
  });
}

function requiredStorageKey(collection: StorageCollection, id: unknown): StorageKey {
  const parsed = parseStorageKey(collection, id);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function storageCollection(value: string): StorageCollection {
  const parsed = parseStorageCollection(value);
  if (!parsed.ok) throw new Error("Invalid audit repository collection.");
  return parsed.value;
}

function requiredOperationId(value: unknown): StorageOperationId {
  const parsed = parseStorageOperationId(value);
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

function requiredNotificationId(value: unknown): ManualNotificationId {
  return requiredStableId<"manual-notification">(value);
}

function requiredStableId<Entity extends string>(value: unknown): StableId<Entity> {
  const parsed = parseStableId<Entity>(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
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

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
