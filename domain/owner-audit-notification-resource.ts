import {
  MANUAL_NOTIFICATION_LIMITS,
  manualNotificationDeliveryState,
  type AuditEvent,
  type AuditEventDetail,
  type ManualNotificationRecord,
} from "./audit-notification.ts";
import {
  defineAction,
  toHtmlFormAction,
  toHypermediaAction,
  type ActionContract,
  type HtmlFormAction,
  type HypermediaAction,
} from "./hypermedia-action.ts";
import {
  INVESTOR_APP_API_VERSION,
  type HypermediaLink,
} from "./public-campaign-resource.ts";
import type {
  StorageCursor,
  StorageOperationId,
} from "./storage-adapter.ts";

export type OwnerAuditEventPage = Readonly<{
  items: readonly AuditEvent[];
  nextCursor: StorageCursor | null;
}>;

export type OwnerNotificationSnapshot = Readonly<{
  revision: number;
  record: ManualNotificationRecord;
}>;

export type OwnerNotificationPage = Readonly<{
  items: readonly OwnerNotificationSnapshot[];
  nextCursor: StorageCursor | null;
}>;

export type OwnerAuditEventItem = Readonly<{
  id: string;
  occurred_at: string;
  actor: Readonly<{
    type: "participant" | "owner" | "system";
    subject?: string;
  }>;
  detail: AuditEventDetailProjection;
}>;

export type AuditEventDetailProjection =
  | Readonly<{
    kind: "resource-transition";
    resource_type: string;
    resource_id: string;
    transition: string;
  }>
  | Readonly<{
    kind: "export-created";
    export_type: string;
  }>
  | Readonly<{
    kind: "manual-notification";
    notification_id: string;
    activity: "template-copied" | "sent-marked";
  }>;

export type OwnerAuditCollectionDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "owner-audit-event-collection";
  id: "owner-audit-events";
  data: Readonly<{ items: readonly OwnerAuditEventItem[] }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type OwnerNotificationSummary = Readonly<{
  id: string;
  revision: number;
  subject_line: string;
  generated_at: string;
  related_resource_type: string;
  delivery_state: "not-marked-sent" | "marked-sent";
  copy_count: number;
}>;

export type OwnerNotificationCollectionDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "owner-manual-notification-collection";
  id: "owner-manual-notifications";
  data: Readonly<{ items: readonly OwnerNotificationSummary[] }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type OwnerNotificationDetailDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "owner-manual-notification";
  id: string;
  data: Readonly<{
    revision: number;
    purpose_id: string;
    recipient_subject: string;
    related_resource: Readonly<{ type: string; id: string }>;
    subject_line: string;
    body: string;
    generated_at: string;
    delivery_state: "not-marked-sent" | "marked-sent";
    copy_history: readonly Readonly<{
      id: string;
      copied_at: string;
    }>[];
    sent_marker: Readonly<{
      id: string;
      sent_at: string;
    }> | null;
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type OwnerNotificationControl = Readonly<{
  contract: ActionContract;
  hypermedia: HypermediaAction;
  form: HtmlFormAction;
}>;

export type OwnerNotificationDetailResource = Readonly<{
  document: OwnerNotificationDetailDocument;
  recordCopy: OwnerNotificationControl | null;
  markSent: OwnerNotificationControl | null;
  terminalRetry: OwnerNotificationControl | null;
}>;

export type OwnerNotificationOperationIdIssuer = () => StorageOperationId;

export type OwnerNotificationTerminalReplay = Readonly<{
  activity: "template-copied" | "sent-marked";
  operationId: StorageOperationId;
  expectedRevision: number;
}>;

export function createOwnerAuditCollectionDocument(
  requestUrl: string,
  page: OwnerAuditEventPage,
  pageSize: number,
  options: Readonly<{ manualNotificationsAvailable?: boolean }> = {
    manualNotificationsAvailable: true,
  },
): OwnerAuditCollectionDocument {
  const self = new URL(requestUrl);
  return deepFreeze({
    api_version: INVESTOR_APP_API_VERSION,
    type: "owner-audit-event-collection",
    id: "owner-audit-events",
    data: { items: page.items.map(projectAuditEvent) },
    links: collectionLinks(
      self,
      page.nextCursor,
      pageSize,
      options.manualNotificationsAvailable === false
        ? []
        : [{
            rel: ["manual-notifications"],
            href: new URL("/owner/manual-notifications", self).href,
          }],
    ),
    actions: [],
  });
}

export function createOwnerNotificationCollectionDocument(
  requestUrl: string,
  page: OwnerNotificationPage,
  pageSize: number,
): OwnerNotificationCollectionDocument {
  const self = new URL(requestUrl);
  return deepFreeze({
    api_version: INVESTOR_APP_API_VERSION,
    type: "owner-manual-notification-collection",
    id: "owner-manual-notifications",
    data: { items: page.items.map(projectNotificationSummary) },
    links: collectionLinks(
      self,
      page.nextCursor,
      pageSize,
      [
        { rel: ["audit-events"], href: new URL("/owner/audit-events", self).href },
        ...page.items.map((item) => ({
          rel: ["item"],
          href: notificationHref(self, item.record.template.id),
        })),
      ],
    ),
    actions: [],
  });
}

export function createOwnerNotificationDetailResource(
  requestUrl: string,
  snapshot: OwnerNotificationSnapshot,
  issueOperationId: OwnerNotificationOperationIdIssuer,
  options: Readonly<{
    activityAllowed?: boolean;
    terminalReplay?: OwnerNotificationTerminalReplay | null;
  }> = { activityAllowed: true },
): OwnerNotificationDetailResource {
  const self = new URL(requestUrl);
  const { record } = snapshot;
  const activityAllowed = options.activityAllowed !== false;
  const recordCopy = activityAllowed &&
      record.copyEvidence.length < MANUAL_NOTIFICATION_LIMITS.copyEvidence
    ? activityControl(
        "record-notification-template-copy",
        "Record template copied",
        new URL(`${self.pathname}/copies`, self).href,
        snapshot.revision,
        issueOperationId(),
      )
    : null;
  const markSent = activityAllowed && record.sentMarker === null
    ? activityControl(
        "mark-notification-sent",
        "Mark as sent",
        new URL(`${self.pathname}/sent-marker`, self).href,
        snapshot.revision,
        issueOperationId(),
      )
    : null;
  const terminalRetry = activityAllowed &&
      recordCopy === null &&
      markSent === null &&
      options.terminalReplay
    ? activityControl(
        options.terminalReplay.activity === "template-copied"
          ? "retry-notification-template-copy"
          : "retry-notification-sent-marker",
        options.terminalReplay.activity === "template-copied"
          ? "Retry recorded template copy"
          : "Retry recorded sent marker",
        new URL(
          `${self.pathname}/${
            options.terminalReplay.activity === "template-copied"
              ? "copies"
              : "sent-marker"
          }`,
          self,
        ).href,
        options.terminalReplay.expectedRevision,
        options.terminalReplay.operationId,
      )
    : null;
  const actions = [recordCopy, markSent, terminalRetry]
    .filter((value): value is OwnerNotificationControl => value !== null);

  return deepFreeze({
    document: {
      api_version: INVESTOR_APP_API_VERSION,
      type: "owner-manual-notification",
      id: record.template.id,
      data: {
        revision: snapshot.revision,
        purpose_id: record.template.purposeId,
        recipient_subject: record.template.recipientSubject,
        related_resource: {
          type: record.template.relatedResource.type,
          id: record.template.relatedResource.id,
        },
        subject_line: record.template.subjectLine,
        body: record.template.body,
        generated_at: record.template.generatedAt,
        delivery_state: manualNotificationDeliveryState(record),
        copy_history: record.copyEvidence.map((item) => ({
          id: item.id,
          copied_at: item.copiedAt,
        })),
        sent_marker: record.sentMarker === null
          ? null
          : {
              id: record.sentMarker.id,
              sent_at: record.sentMarker.sentAt,
            },
      },
      links: [
        { rel: ["self"], href: self.href },
        { rel: ["collection"], href: new URL("/owner/manual-notifications", self).href },
        { rel: ["audit-events"], href: new URL("/owner/audit-events", self).href },
        { rel: ["owner"], href: new URL("/owner", self).href },
        { rel: ["campaign"], href: new URL("/", self).href },
      ],
      actions: actions.map((item) => item.hypermedia),
    },
    recordCopy,
    markSent,
    terminalRetry,
  });
}

function activityControl(
  name: string,
  title: string,
  href: string,
  revision: number,
  operationId: StorageOperationId,
): OwnerNotificationControl {
  const contract = defineAction({
    name,
    title,
    method: "POST",
    href,
    requestMediaType: "application/x-www-form-urlencoded",
    fields: [
      {
        name: "operation-id",
        title: "Operation ID",
        type: "string",
        location: "body",
        required: true,
        minLength: 1,
        maxLength: MANUAL_NOTIFICATION_LIMITS.activityOperationIdLength,
        value: operationId,
        presentation: "hidden",
      },
      {
        name: "expected-revision",
        title: "Expected revision",
        type: "integer",
        location: "body",
        required: true,
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER - 1,
        value: revision,
        presentation: "hidden",
      },
    ],
  });
  return Object.freeze({
    contract,
    hypermedia: toHypermediaAction(contract),
    form: toHtmlFormAction(contract),
  });
}

function projectAuditEvent(event: AuditEvent): OwnerAuditEventItem {
  return {
    id: event.id,
    occurred_at: event.occurredAt,
    actor: event.actor.type === "system"
      ? { type: "system" }
      : { type: event.actor.type, subject: event.actor.subject },
    detail: projectAuditDetail(event.detail),
  };
}

function projectAuditDetail(detail: AuditEventDetail): AuditEventDetailProjection {
  if (detail.kind === "export-created") {
    return { kind: detail.kind, export_type: detail.exportType };
  }
  if (detail.kind === "manual-notification") {
    return {
      kind: detail.kind,
      notification_id: detail.notificationId,
      activity: detail.activity,
    };
  }
  return {
    kind: detail.kind,
    resource_type: detail.resource.type,
    resource_id: detail.resource.id,
    transition: detail.transition,
  };
}

function projectNotificationSummary(
  snapshot: OwnerNotificationSnapshot,
): OwnerNotificationSummary {
  const { record } = snapshot;
  return {
    id: record.template.id,
    revision: snapshot.revision,
    subject_line: record.template.subjectLine,
    generated_at: record.template.generatedAt,
    related_resource_type: record.template.relatedResource.type,
    delivery_state: manualNotificationDeliveryState(record),
    copy_count: record.copyEvidence.length,
  };
}

function collectionLinks(
  self: URL,
  nextCursor: StorageCursor | null,
  pageSize: number,
  additional: readonly HypermediaLink[],
): HypermediaLink[] {
  const links: HypermediaLink[] = [
    { rel: ["self"], href: self.href },
    { rel: ["owner"], href: new URL("/owner", self).href },
    { rel: ["campaign"], href: new URL("/", self).href },
    ...additional,
  ];
  if (nextCursor !== null) {
    const next = new URL(self);
    next.searchParams.set("page_size", String(pageSize));
    next.searchParams.set("cursor", nextCursor);
    links.push({ rel: ["next"], href: next.href });
  }
  return links;
}

function notificationHref(base: URL, id: string): string {
  return new URL(
    `/owner/manual-notifications/${encodeURIComponent(id)}`,
    base,
  ).href;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
