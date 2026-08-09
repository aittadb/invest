/**
 * Framework-independent contracts for append-only audit evidence and manually
 * delivered notification tracking.
 *
 * @packageDocumentation
 */

import {
  invalid,
  parseActorSubject,
  parseStableId,
  parseTimestamp,
  toPublicDomainError,
  valid,
  type ActorSubject,
  type PublicDomainError,
  type StableId,
  type Timestamp,
  type ValidationIssue,
  type ValidationResult,
} from "./foundation.ts";

/** Human audit actors are attributed only by their trusted identity subject. */
export type AuditActor =
  | Readonly<{ type: "participant"; subject: ActorSubject }>
  | Readonly<{ type: "owner"; subject: ActorSubject }>
  | Readonly<{ type: "system" }>;

export type OwnerAuditActor = Extract<AuditActor, Readonly<{ type: "owner" }>>;

/**
 * Audit attribution never accepts a visitor or caller-supplied contact label.
 * System activity must be explicit rather than impersonating a human subject.
 */
export const AUDIT_ACTOR_ATTRIBUTION_POLICY = Object.freeze({
  visitor: "forbidden",
  human: "trusted-subject-only",
  system: "explicit-system-actor",
} as const);

export type AuditedResourceType =
  | "campaign"
  | "package-version"
  | "participant-profile"
  | "investment-indication"
  | "founder-application"
  | "aggregate"
  | "manual-notification";

export type AuditResourceReference = Readonly<{
  type: AuditedResourceType;
  id: StableId<"audit-resource">;
}>;

export type ResourceTransition =
  | "created"
  | "updated"
  | "published"
  | "unpublished"
  | "withdrawn"
  | "reactivated"
  | "rejected"
  | "reconciled"
  | "deleted";

export type ResourceTransitionAuditDetail = Readonly<{
  kind: "resource-transition";
  resource: AuditResourceReference;
  transition: ResourceTransition;
}>;

/** Export audit evidence records the operation class, never export contents. */
export type ExportCreatedAuditDetail = Readonly<{
  kind: "export-created";
  exportType: "review-csv" | "json-backup";
}>;

/** Notification audit evidence refers to the private record without copying it. */
export type ManualNotificationAuditDetail = Readonly<{
  kind: "manual-notification";
  notificationId: StableId<"manual-notification">;
  activity: "template-copied" | "sent-marked";
}>;

/** Closed details prevent arbitrary notes or credentials from entering evidence. */
export type AuditEventDetail =
  | ResourceTransitionAuditDetail
  | ExportCreatedAuditDetail
  | ManualNotificationAuditDetail;

/** Immutable, retry-addressable evidence accepted by an audit repository. */
export type AuditEvent = Readonly<{
  id: StableId<"audit-event">;
  operationId: StableId<"audit-operation">;
  occurredAt: Timestamp;
  actor: AuditActor;
  detail: AuditEventDetail;
}>;

/** An application-service request to append exactly one immutable audit event. */
export type AuditAppendIntent = Readonly<{
  type: "append-audit-event";
  event: AuditEvent;
}>;

export type AuditRedactionPolicy = Readonly<{
  credentials: "exclude";
  privateNotes: "exclude";
  notificationContent: "reference-only";
  exportContent: "reference-only";
  actorContact: "subject-only";
  publicErrors: "fixed-message-only";
}>;

/**
 * Serializable audit evidence is allowlisted by `AuditEventDetail`. Sensitive
 * content stays in its owning private record and public errors serialize no cause.
 */
export const AUDIT_REDACTION_POLICY: AuditRedactionPolicy = Object.freeze({
  credentials: "exclude",
  privateNotes: "exclude",
  notificationContent: "reference-only",
  exportContent: "reference-only",
  actorContact: "subject-only",
  publicErrors: "fixed-message-only",
});

export type NotificationPurposeId = StableId<"notification-purpose">;
export type ManualNotificationId = StableId<"manual-notification">;

/** Private, bounded text prepared for an owner to send outside the app. */
export type ManualNotificationTemplate = Readonly<{
  id: ManualNotificationId;
  purposeId: NotificationPurposeId;
  recipientSubject: ActorSubject;
  relatedResource: AuditResourceReference;
  subjectLine: string;
  body: string;
  generatedAt: Timestamp;
  generatedBy: OwnerAuditActor;
}>;

/** Evidence that the owner copied a template; it is not delivery evidence. */
export type ManualNotificationCopyEvidence = Readonly<{
  id: StableId<"manual-notification-copy">;
  copiedAt: Timestamp;
  copiedBy: OwnerAuditActor;
}>;

/** Owner-entered evidence that a notice was sent outside the application. */
export type ManualNotificationSentMarker = Readonly<{
  id: StableId<"manual-notification-sent-marker">;
  sentAt: Timestamp;
  sentBy: OwnerAuditActor;
}>;

/** Copy history and the optional sent marker remain distinct immutable facts. */
export type ManualNotificationRecord = Readonly<{
  template: ManualNotificationTemplate;
  copyEvidence: readonly ManualNotificationCopyEvidence[];
  sentMarker: ManualNotificationSentMarker | null;
}>;

export type ManualNotificationDeliveryState = "not-marked-sent" | "marked-sent";

const AUDITED_RESOURCE_TYPES = [
  "campaign",
  "package-version",
  "participant-profile",
  "investment-indication",
  "founder-application",
  "aggregate",
  "manual-notification",
] as const;
const RESOURCE_TRANSITIONS = [
  "created",
  "updated",
  "published",
  "unpublished",
  "withdrawn",
  "reactivated",
  "rejected",
  "reconciled",
  "deleted",
] as const;
const EXPORT_TYPES = ["review-csv", "json-backup"] as const;
const NOTIFICATION_ACTIVITIES = ["template-copied", "sent-marked"] as const;
const MAX_NOTIFICATION_SUBJECT_LENGTH = 200;
const MAX_NOTIFICATION_BODY_LENGTH = 20_000;
const MAX_COPY_EVIDENCE = 64;

type UnknownRecord = Readonly<Record<string, unknown>>;

/** Parse an unknown append request into bounded, deeply frozen audit evidence. */
export function parseAuditAppendIntent(
  value: unknown,
): ValidationResult<AuditAppendIntent> {
  const source = asRecord(value);
  if (!source) {
    return invalid({ code: "invalid_type", path: "auditIntent" });
  }
  const keys = validateKeys(source, ["type", "event"], "auditIntent");
  if (!keys.ok) return keys;
  if (source.type !== "append-audit-event") {
    return invalid({ code: "invalid_rule", path: "auditIntent.type" });
  }

  const event = parseAuditEvent(source.event);
  if (!event.ok) return event;

  return valid(Object.freeze({ type: "append-audit-event", event: event.value }));
}

/** Parse bounded private template content without deployment-specific defaults. */
export function parseManualNotificationTemplate(
  value: unknown,
): ValidationResult<ManualNotificationTemplate> {
  const source = asRecord(value);
  if (!source) {
    return invalid({ code: "invalid_type", path: "notificationTemplate" });
  }
  const keys = validateKeys(
    source,
    [
      "id",
      "purposeId",
      "recipientSubject",
      "relatedResource",
      "subjectLine",
      "body",
      "generatedAt",
      "generatedBy",
    ],
    "notificationTemplate",
  );
  if (!keys.ok) return keys;

  const id = parseNamedStableId<"manual-notification">(
    source.id,
    "notificationTemplate.id",
  );
  if (!id.ok) return id;
  const purposeId = parseNamedStableId<"notification-purpose">(
    source.purposeId,
    "notificationTemplate.purposeId",
  );
  if (!purposeId.ok) return purposeId;
  const recipientSubject = parseNamedSubject(
    source.recipientSubject,
    "notificationTemplate.recipientSubject",
  );
  if (!recipientSubject.ok) return recipientSubject;
  const relatedResource = parseResourceReference(
    source.relatedResource,
    "notificationTemplate.relatedResource",
  );
  if (!relatedResource.ok) return relatedResource;
  const subjectLine = parseBoundedText(
    source.subjectLine,
    "notificationTemplate.subjectLine",
    MAX_NOTIFICATION_SUBJECT_LENGTH,
    false,
  );
  if (!subjectLine.ok) return subjectLine;
  const body = parseBoundedText(
    source.body,
    "notificationTemplate.body",
    MAX_NOTIFICATION_BODY_LENGTH,
    true,
  );
  if (!body.ok) return body;
  const generatedAt = parseNamedTimestamp(
    source.generatedAt,
    "notificationTemplate.generatedAt",
  );
  if (!generatedAt.ok) return generatedAt;
  const generatedBy = parseOwnerActor(
    source.generatedBy,
    "notificationTemplate.generatedBy",
  );
  if (!generatedBy.ok) return generatedBy;

  return valid(
    Object.freeze({
      id: id.value,
      purposeId: purposeId.value,
      recipientSubject: recipientSubject.value,
      relatedResource: relatedResource.value,
      subjectLine: subjectLine.value,
      body: body.value,
      generatedAt: generatedAt.value,
      generatedBy: generatedBy.value,
    }),
  );
}

/** Start tracking from a detached template snapshot with no implied delivery. */
export function createManualNotificationRecord(
  template: ManualNotificationTemplate,
): ManualNotificationRecord {
  const detachedTemplate = Object.freeze({
    ...template,
    relatedResource: Object.freeze({ ...template.relatedResource }),
    generatedBy: Object.freeze({ ...template.generatedBy }),
  });
  return Object.freeze({
    template: detachedTemplate,
    copyEvidence: Object.freeze([]),
    sentMarker: null,
  });
}

/** Append copy evidence without changing whether delivery has been marked. */
export function recordManualNotificationCopy(
  record: ManualNotificationRecord,
  value: unknown,
): ValidationResult<ManualNotificationRecord> {
  const marker = parseCopyEvidence(value);
  if (!marker.ok) return marker;
  if (marker.value.copiedAt < record.template.generatedAt) {
    return invalid({ code: "invalid_rule", path: "copyEvidence.copiedAt" });
  }

  const existing = record.copyEvidence.find(({ id }) => id === marker.value.id);
  if (existing) {
    return sameCopyEvidence(existing, marker.value)
      ? valid(record)
      : invalid({ code: "invalid_rule", path: "copyEvidence.id" });
  }
  if (record.copyEvidence.length >= MAX_COPY_EVIDENCE) {
    return invalid({ code: "out_of_range", path: "copyEvidence" });
  }

  return valid(
    Object.freeze({
      template: record.template,
      copyEvidence: Object.freeze([...record.copyEvidence, marker.value]),
      sentMarker: record.sentMarker,
    }),
  );
}

/** Record an explicit owner sent marker; copying alone never calls this transition. */
export function markManualNotificationSent(
  record: ManualNotificationRecord,
  value: unknown,
): ValidationResult<ManualNotificationRecord> {
  const marker = parseSentMarker(value);
  if (!marker.ok) return marker;
  if (marker.value.sentAt < record.template.generatedAt) {
    return invalid({ code: "invalid_rule", path: "sentMarker.sentAt" });
  }

  if (record.sentMarker) {
    return sameSentMarker(record.sentMarker, marker.value)
      ? valid(record)
      : invalid({ code: "invalid_rule", path: "sentMarker.id" });
  }

  return valid(
    Object.freeze({
      template: record.template,
      copyEvidence: record.copyEvidence,
      sentMarker: marker.value,
    }),
  );
}

export function manualNotificationDeliveryState(
  record: ManualNotificationRecord,
): ManualNotificationDeliveryState {
  return record.sentMarker === null ? "not-marked-sent" : "marked-sent";
}

/** Serialize only the shared fixed public error projection, never private causes. */
export function toAuditNotificationPublicError(error: unknown): PublicDomainError {
  return toPublicDomainError(error);
}

function parseAuditEvent(value: unknown): ValidationResult<AuditEvent> {
  const source = asRecord(value);
  if (!source) return invalid({ code: "invalid_type", path: "auditIntent.event" });
  const keys = validateKeys(
    source,
    ["id", "operationId", "occurredAt", "actor", "detail"],
    "auditIntent.event",
  );
  if (!keys.ok) return keys;

  const id = parseNamedStableId<"audit-event">(
    source.id,
    "auditIntent.event.id",
  );
  if (!id.ok) return id;
  const operationId = parseNamedStableId<"audit-operation">(
    source.operationId,
    "auditIntent.event.operationId",
  );
  if (!operationId.ok) return operationId;
  const occurredAt = parseNamedTimestamp(
    source.occurredAt,
    "auditIntent.event.occurredAt",
  );
  if (!occurredAt.ok) return occurredAt;
  const actor = parseAuditActor(source.actor, "auditIntent.event.actor");
  if (!actor.ok) return actor;
  const detail = parseAuditEventDetail(source.detail);
  if (!detail.ok) return detail;

  return valid(
    Object.freeze({
      id: id.value,
      operationId: operationId.value,
      occurredAt: occurredAt.value,
      actor: actor.value,
      detail: detail.value,
    }),
  );
}

function parseAuditActor(
  value: unknown,
  path: string,
): ValidationResult<AuditActor> {
  const source = asRecord(value);
  if (!source) return invalid({ code: "invalid_type", path });
  if (source.type === "system") {
    const keys = validateKeys(source, ["type"], path);
    return keys.ok
      ? valid(Object.freeze({ type: "system" }))
      : keys;
  }
  if (source.type !== "owner" && source.type !== "participant") {
    return invalid({ code: "invalid_rule", path: `${path}.type` });
  }
  const keys = validateKeys(source, ["type", "subject"], path);
  if (!keys.ok) return keys;
  const subject = parseNamedSubject(source.subject, `${path}.subject`);
  if (!subject.ok) return subject;

  return valid(Object.freeze({ type: source.type, subject: subject.value }));
}

function parseOwnerActor(
  value: unknown,
  path: string,
): ValidationResult<OwnerAuditActor> {
  const actor = parseAuditActor(value, path);
  if (!actor.ok) return actor;
  return actor.value.type === "owner"
    ? valid(actor.value)
    : invalid({ code: "invalid_rule", path: `${path}.type` });
}

function parseAuditEventDetail(
  value: unknown,
): ValidationResult<AuditEventDetail> {
  const path = "auditIntent.event.detail";
  const source = asRecord(value);
  if (!source) return invalid({ code: "invalid_type", path });

  if (source.kind === "resource-transition") {
    const keys = validateKeys(source, ["kind", "resource", "transition"], path);
    if (!keys.ok) return keys;
    const resource = parseResourceReference(source.resource, `${path}.resource`);
    if (!resource.ok) return resource;
    const transition = parseEnum(
      source.transition,
      RESOURCE_TRANSITIONS,
      `${path}.transition`,
    );
    if (!transition.ok) return transition;
    return valid(
      Object.freeze({
        kind: "resource-transition",
        resource: resource.value,
        transition: transition.value,
      }),
    );
  }

  if (source.kind === "export-created") {
    const keys = validateKeys(source, ["kind", "exportType"], path);
    if (!keys.ok) return keys;
    const exportType = parseEnum(source.exportType, EXPORT_TYPES, `${path}.exportType`);
    return exportType.ok
      ? valid(Object.freeze({ kind: "export-created", exportType: exportType.value }))
      : exportType;
  }

  if (source.kind === "manual-notification") {
    const keys = validateKeys(
      source,
      ["kind", "notificationId", "activity"],
      path,
    );
    if (!keys.ok) return keys;
    const notificationId = parseNamedStableId<"manual-notification">(
      source.notificationId,
      `${path}.notificationId`,
    );
    if (!notificationId.ok) return notificationId;
    const activity = parseEnum(
      source.activity,
      NOTIFICATION_ACTIVITIES,
      `${path}.activity`,
    );
    return activity.ok
      ? valid(
          Object.freeze({
            kind: "manual-notification",
            notificationId: notificationId.value,
            activity: activity.value,
          }),
        )
      : activity;
  }

  return invalid({ code: "invalid_rule", path: `${path}.kind` });
}

function parseResourceReference(
  value: unknown,
  path: string,
): ValidationResult<AuditResourceReference> {
  const source = asRecord(value);
  if (!source) return invalid({ code: "invalid_type", path });
  const keys = validateKeys(source, ["type", "id"], path);
  if (!keys.ok) return keys;
  const type = parseEnum(source.type, AUDITED_RESOURCE_TYPES, `${path}.type`);
  if (!type.ok) return type;
  const id = parseNamedStableId<"audit-resource">(source.id, `${path}.id`);
  if (!id.ok) return id;
  return valid(Object.freeze({ type: type.value, id: id.value }));
}

function parseCopyEvidence(
  value: unknown,
): ValidationResult<ManualNotificationCopyEvidence> {
  const source = asRecord(value);
  if (!source) return invalid({ code: "invalid_type", path: "copyEvidence" });
  const keys = validateKeys(source, ["id", "copiedAt", "copiedBy"], "copyEvidence");
  if (!keys.ok) return keys;
  const id = parseNamedStableId<"manual-notification-copy">(
    source.id,
    "copyEvidence.id",
  );
  if (!id.ok) return id;
  const copiedAt = parseNamedTimestamp(source.copiedAt, "copyEvidence.copiedAt");
  if (!copiedAt.ok) return copiedAt;
  const copiedBy = parseOwnerActor(source.copiedBy, "copyEvidence.copiedBy");
  if (!copiedBy.ok) return copiedBy;
  return valid(
    Object.freeze({ id: id.value, copiedAt: copiedAt.value, copiedBy: copiedBy.value }),
  );
}

function parseSentMarker(
  value: unknown,
): ValidationResult<ManualNotificationSentMarker> {
  const source = asRecord(value);
  if (!source) return invalid({ code: "invalid_type", path: "sentMarker" });
  const keys = validateKeys(source, ["id", "sentAt", "sentBy"], "sentMarker");
  if (!keys.ok) return keys;
  const id = parseNamedStableId<"manual-notification-sent-marker">(
    source.id,
    "sentMarker.id",
  );
  if (!id.ok) return id;
  const sentAt = parseNamedTimestamp(source.sentAt, "sentMarker.sentAt");
  if (!sentAt.ok) return sentAt;
  const sentBy = parseOwnerActor(source.sentBy, "sentMarker.sentBy");
  if (!sentBy.ok) return sentBy;
  return valid(
    Object.freeze({ id: id.value, sentAt: sentAt.value, sentBy: sentBy.value }),
  );
}

function sameCopyEvidence(
  left: ManualNotificationCopyEvidence,
  right: ManualNotificationCopyEvidence,
): boolean {
  return left.copiedAt === right.copiedAt && left.copiedBy.subject === right.copiedBy.subject;
}

function sameSentMarker(
  left: ManualNotificationSentMarker,
  right: ManualNotificationSentMarker,
): boolean {
  return left.sentAt === right.sentAt && left.sentBy.subject === right.sentBy.subject;
}

function parseBoundedText(
  value: unknown,
  path: string,
  maximumLength: number,
  multiline: boolean,
): ValidationResult<string> {
  if (typeof value !== "string") return invalid({ code: "invalid_type", path });
  const normalized = multiline ? value.replace(/\r\n?/gu, "\n") : value;
  if (normalized.length === 0) return invalid({ code: "required", path });
  if (
    normalized.length > maximumLength ||
    normalized.trim() !== normalized ||
    hasDisallowedControlCharacter(normalized, multiline)
  ) {
    return invalid({ code: "invalid_format", path });
  }
  return valid(normalized);
}

function hasDisallowedControlCharacter(value: string, multiline: boolean): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint > 31 && codePoint !== 127) continue;
    if (multiline && (character === "\n" || character === "\t")) continue;
    return true;
  }
  return false;
}

function parseNamedStableId<Entity extends string>(
  value: unknown,
  path: string,
): ValidationResult<StableId<Entity>> {
  const result = parseStableId<Entity>(value);
  return result.ok ? result : invalid(remapIssue(result.issues[0], path));
}

function parseNamedSubject(
  value: unknown,
  path: string,
): ValidationResult<ActorSubject> {
  const result = parseActorSubject(value);
  return result.ok ? result : invalid(remapIssue(result.issues[0], path));
}

function parseNamedTimestamp(
  value: unknown,
  path: string,
): ValidationResult<Timestamp> {
  const result = parseTimestamp(value);
  return result.ok ? result : invalid(remapIssue(result.issues[0], path));
}

function parseEnum<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  path: string,
): ValidationResult<Values[number]> {
  if (typeof value !== "string") return invalid({ code: "invalid_type", path });
  const matched = allowed.find((candidate) => candidate === value);
  return matched === undefined
    ? invalid({ code: "invalid_rule", path })
    : valid(matched);
}

function validateKeys(
  source: UnknownRecord,
  allowed: readonly string[],
  path: string,
): ValidationResult<true> {
  const allowedKeys = new Set(allowed);
  return Object.keys(source).some((key) => !allowedKeys.has(key))
    ? invalid({ code: "invalid_rule", path })
    : valid(true);
}

function remapIssue(issue: ValidationIssue, path: string): ValidationIssue {
  return { code: issue.code, path };
}

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}
