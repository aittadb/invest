import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIT_ACTOR_ATTRIBUTION_POLICY,
  AUDIT_REDACTION_POLICY,
  createManualNotificationRecord,
  manualNotificationDeliveryState,
  markManualNotificationSent,
  parseAuditAppendIntent,
  parseManualNotificationTemplate,
  recordManualNotificationCopy,
  toAuditNotificationPublicError,
  type ManualNotificationTemplate,
} from "../domain/audit-notification.ts";
import { DomainError } from "../domain/foundation.ts";

const GENERATED_AT = "2026-01-01T00:00:00.000Z";
const COPIED_AT = "2026-01-01T00:01:00.000Z";
const SENT_AT = "2026-01-01T00:02:00.000Z";
const OWNER = Object.freeze({
  type: "owner" as const,
  subject: "issuer.invalid/owner-subject",
});

test("audit append intents attribute actors and freeze allowlisted evidence", () => {
  const result = parseAuditAppendIntent({
    type: "append-audit-event",
    event: {
      id: "audit-event-1",
      operationId: "operation-1",
      occurredAt: GENERATED_AT,
      actor: OWNER,
      detail: {
        kind: "resource-transition",
        resource: {
          type: "investment-indication",
          id: "indication-1",
        },
        transition: "rejected",
      },
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.event.actor, OWNER);
  assert.deepEqual(result.value.event.detail, {
    kind: "resource-transition",
    resource: { type: "investment-indication", id: "indication-1" },
    transition: "rejected",
  });
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.event), true);
  assert.equal(Object.isFrozen(result.value.event.actor), true);
  assert.equal(Object.isFrozen(result.value.event.detail), true);
  if (result.value.event.detail.kind === "resource-transition") {
    assert.equal(Object.isFrozen(result.value.event.detail.resource), true);
  }

  assert.deepEqual(
    parseAuditAppendIntent({
      type: "append-audit-event",
      event: {
        id: "audit-event-2",
        operationId: "operation-2",
        occurredAt: GENERATED_AT,
        actor: { type: "visitor" },
        detail: { kind: "export-created", exportType: "review-csv" },
      },
    }),
    {
      ok: false,
      issues: [{ code: "invalid_rule", path: "auditIntent.event.actor.type" }],
    },
  );
  assert.deepEqual(AUDIT_ACTOR_ATTRIBUTION_POLICY, {
    visitor: "forbidden",
    human: "trusted-subject-only",
    system: "explicit-system-actor",
  });
});

test("export events identify the export class without retaining its contents", () => {
  const result = parseAuditAppendIntent({
    type: "append-audit-event",
    event: {
      id: "audit-event-export-1",
      operationId: "operation-export-1",
      occurredAt: GENERATED_AT,
      actor: { type: "system" },
      detail: { kind: "export-created", exportType: "json-backup" },
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.event.detail, {
    kind: "export-created",
    exportType: "json-backup",
  });

  const withUnexpectedContent = parseAuditAppendIntent({
    type: "append-audit-event",
    event: {
      id: "audit-event-export-2",
      operationId: "operation-export-2",
      occurredAt: GENERATED_AT,
      actor: OWNER,
      detail: {
        kind: "export-created",
        exportType: "review-csv",
        exportContent: "synthetic-content-must-not-be-retained",
      },
    },
  });
  assert.deepEqual(withUnexpectedContent, {
    ok: false,
    issues: [{ code: "invalid_rule", path: "auditIntent.event.detail" }],
  });
});

test("manual notification copying and sent markers are independent retry-stable facts", () => {
  const initial = createManualNotificationRecord(validTemplate());
  assert.equal(manualNotificationDeliveryState(initial), "not-marked-sent");
  assert.deepEqual(initial.copyEvidence, []);
  assert.equal(initial.sentMarker, null);

  const copied = recordManualNotificationCopy(initial, {
    id: "notification-copy-1",
    copiedAt: COPIED_AT,
    copiedBy: OWNER,
  });
  assert.equal(copied.ok, true);
  if (!copied.ok) return;
  assert.equal(manualNotificationDeliveryState(copied.value), "not-marked-sent");
  assert.equal(copied.value.sentMarker, null);
  assert.deepEqual(copied.value.copyEvidence, [
    {
      id: "notification-copy-1",
      copiedAt: COPIED_AT,
      copiedBy: OWNER,
    },
  ]);
  assert.equal(Object.isFrozen(copied.value.copyEvidence), true);

  const copyRetry = recordManualNotificationCopy(copied.value, {
    id: "notification-copy-1",
    copiedAt: COPIED_AT,
    copiedBy: OWNER,
  });
  assert.equal(copyRetry.ok, true);
  if (!copyRetry.ok) return;
  assert.equal(copyRetry.value, copied.value);

  const markedSent = markManualNotificationSent(copied.value, {
    id: "sent-marker-1",
    sentAt: SENT_AT,
    sentBy: OWNER,
  });
  assert.equal(markedSent.ok, true);
  if (!markedSent.ok) return;
  assert.equal(manualNotificationDeliveryState(markedSent.value), "marked-sent");
  assert.equal(markedSent.value.copyEvidence, copied.value.copyEvidence);
  assert.deepEqual(markedSent.value.sentMarker, {
    id: "sent-marker-1",
    sentAt: SENT_AT,
    sentBy: OWNER,
  });

  const sentRetry = markManualNotificationSent(markedSent.value, {
    id: "sent-marker-1",
    sentAt: SENT_AT,
    sentBy: OWNER,
  });
  assert.equal(sentRetry.ok, true);
  if (!sentRetry.ok) return;
  assert.equal(sentRetry.value, markedSent.value);

  assert.deepEqual(
    markManualNotificationSent(markedSent.value, {
      id: "sent-marker-2",
      sentAt: "2026-01-01T00:03:00.000Z",
      sentBy: OWNER,
    }),
    {
      ok: false,
      issues: [{ code: "invalid_rule", path: "sentMarker.id" }],
    },
  );
});

test("template guards bound private content and public errors disclose no causes", () => {
  const template = parseManualNotificationTemplate(templateInput());
  assert.equal(template.ok, true);
  if (!template.ok) return;
  assert.equal(Object.isFrozen(template.value), true);
  assert.equal(Object.isFrozen(template.value.relatedResource), true);
  assert.equal(Object.isFrozen(template.value.generatedBy), true);

  assert.deepEqual(
    parseManualNotificationTemplate({
      ...templateInput(),
      privateNote: "synthetic-note-must-not-be-retained",
    }),
    {
      ok: false,
      issues: [{ code: "invalid_rule", path: "notificationTemplate" }],
    },
  );
  assert.deepEqual(
    parseManualNotificationTemplate({
      ...templateInput(),
      body: "x".repeat(20_001),
    }),
    {
      ok: false,
      issues: [{ code: "invalid_format", path: "notificationTemplate.body" }],
    },
  );
  assert.deepEqual(
    markManualNotificationSent(createManualNotificationRecord(template.value), {
      id: "sent-marker-participant",
      sentAt: SENT_AT,
      sentBy: {
        type: "participant",
        subject: "issuer.invalid/participant-subject",
      },
    }),
    {
      ok: false,
      issues: [{ code: "invalid_rule", path: "sentMarker.sentBy.type" }],
    },
  );

  const internalError = new DomainError("INVALID_INPUT", {
    cause: {
      credential: "synthetic-credential-must-not-be-disclosed",
      privateNote: "synthetic-note-must-not-be-disclosed",
    },
  });
  const publicError = toAuditNotificationPublicError(internalError);
  assert.deepEqual(publicError, {
    status: 400,
    body: {
      error: { code: "INVALID_REQUEST", message: "The request is invalid." },
    },
  });
  assert.doesNotMatch(
    JSON.stringify(publicError),
    /credential|privateNote|synthetic-/u,
  );
  assert.deepEqual(AUDIT_REDACTION_POLICY, {
    credentials: "exclude",
    privateNotes: "exclude",
    notificationContent: "reference-only",
    exportContent: "reference-only",
    actorContact: "subject-only",
    publicErrors: "fixed-message-only",
  });
});

function validTemplate(): ManualNotificationTemplate {
  const result = parseManualNotificationTemplate(templateInput());
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Test notification template must be valid.");
  return result.value;
}

function templateInput(): Readonly<Record<string, unknown>> {
  return {
    id: "notification-1",
    purposeId: "moderation-status-update",
    recipientSubject: "issuer.invalid/participant-subject",
    relatedResource: {
      type: "investment-indication",
      id: "indication-1",
    },
    subjectLine: "A status update is available",
    body: "Please sign in to review the current status.",
    generatedAt: GENERATED_AT,
    generatedBy: OWNER,
  };
}
