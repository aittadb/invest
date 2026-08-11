import assert from "node:assert/strict";
import test from "node:test";

import {
  createManualNotificationRecord,
  markManualNotificationSent,
  parseManualNotificationTemplate,
  recordManualNotificationCopy,
  type AuditEvent,
  type ManualNotificationRecord,
} from "../domain/audit-notification.ts";
import {
  parseActorSubject,
  parseStableId,
  parseTimestamp,
} from "../domain/foundation.ts";
import type { HypermediaAction } from "../domain/hypermedia-action.ts";
import { createOwnerHomeDocument } from "../domain/owner-home-resource.ts";
import type {
  OwnerAuditCollectionDocument,
  OwnerNotificationCollectionDocument,
  OwnerNotificationDetailDocument,
} from "../domain/owner-audit-notification-resource.ts";
import {
  StorageFailure,
  parseStorageOperationId,
  type StorageCursor,
  type StorageOperationId,
} from "../domain/storage-adapter.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  createBrowserMutationGuard,
  hashCsrfToken,
} from "../http/mutation-security.ts";
import type {
  AuditAppendResult,
  AuditEventPage,
  AuditEventReader,
  AuditListRequest,
  AuditedManualNotificationActivityRequest,
  AuditedManualNotificationMutationResult,
  ManualNotificationPage,
  ManualNotificationSnapshot,
} from "../repositories/in-memory-audit-notification-repositories.ts";
import {
  createOwnerAuditHistoryRouteHandler,
  createOwnerAuditNotificationHistoryRouteHandler,
} from "../worker/routes/owner-audit-notification-history.ts";
import type {
  ApplicationRouteContext,
  AuthenticatedActor,
} from "../worker/contracts.ts";

const APP_ORIGIN = "https://instance.example";
const INTERNAL_ORIGIN = "https://worker.internal";
const OWNER_SUBJECT = "oidc:configured-owner";
const OWNER_EMAIL = "owner@example.com";
const CSRF_TOKEN = "owner_csrf_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PRIVATE_FAILURE = "private backend audit detail";

test("persistent audit-only route keeps HTML and hypermedia equivalent", async () => {
  const audit = new FakeAuditRepository();
  audit.events.push(
    auditEvent(
      "audit:event-persistent",
      "audit:operation-persistent",
      "resource-transition",
    ),
  );
  const handler = createOwnerAuditHistoryRouteHandler({ audit });
  const request = async (path: string, accept: string) => {
    const raw = new Request(new URL(path, INTERNAL_ORIGIN), {
      headers: identityHeaders(accept, "owner"),
    });
    const response = await handler(routeContext(raw, "owner"));
    assert.ok(response);
    return response;
  };

  const jsonResponse = await request(
    "/owner/audit-events?page_size=1",
    "application/json",
  );
  assert.equal(jsonResponse.status, 200);
  const document = await jsonResponse.json() as OwnerAuditCollectionDocument;
  assert.equal(document.data.items[0]?.id, "audit:event-persistent");
  assert.equal(
    document.data.items[0]?.actor.subject,
    OWNER_SUBJECT,
  );
  assert.equal(
    document.links.some((link) => link.rel.includes("manual-notifications")),
    false,
  );
  assert.equal(
    document.links.find((link) => link.rel.includes("owner"))?.href,
    `${APP_ORIGIN}/owner`,
  );
  assert.equal(
    document.links.find((link) => link.rel.includes("campaign"))?.href,
    `${APP_ORIGIN}/`,
  );
  assert.equal(document.actions.length, 0);

  const htmlResponse = await request(
    "/owner/audit-events?page_size=1",
    "text/html",
  );
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.match(html, /audit:event-persistent/u);
  assert.match(html, new RegExp(OWNER_SUBJECT, "u"));
  assert.match(html, /resource:campaign/u);
  assert.match(html, /href="\/owner">Campaign workspace<\/a>/u);
  assert.match(html, /href="\/">View campaign<\/a>/u);
  assert.doesNotMatch(html, /Manual notifications/u);
  assert.equal(htmlResponse.headers.get("cache-control"), "no-store");

  const home = createOwnerHomeDocument(
    `${APP_ORIGIN}/owner`,
    { displayName: "Owner", email: OWNER_EMAIL },
    null,
    { auditHistory: true },
  );
  assert.ok(home.links.some((link) => link.rel.includes("audit-events")));
  assert.equal(
    home.links.some((link) => link.rel.includes("manual-notifications")),
    false,
  );
});

test("persistent audit route bounds input, authorization, and private failures", async () => {
  const audit = new FakeAuditRepository();
  const handler = createOwnerAuditHistoryRouteHandler({ audit });
  const invoke = async (
    path: string,
    actor: "owner" | "foreign" | "anonymous",
    accept = "application/json",
    method = "GET",
  ) => {
    const raw = new Request(new URL(path, INTERNAL_ORIGIN), {
      method,
      headers: identityHeaders(accept, actor),
    });
    const response = await handler(routeContext(raw, actor));
    assert.ok(response);
    return response;
  };

  for (const path of [
    "/owner/audit-events?page_size=101",
    "/owner/audit-events?page_size=01",
    "/owner/audit-events?cursor=",
    "/owner/audit-events?cursor=line%0Abreak",
    `/owner/audit-events?cursor=${"x".repeat(513)}`,
    "/owner/audit-events?page_size=1&page_size=2",
    "/owner/audit-events?private=value",
  ]) {
    const response = await invoke(path, "owner");
    assert.equal(response.status, 400, path);
  }
  assert.equal(audit.lastListLimits.length, 0);

  assert.equal((await invoke("/owner/audit-events", "anonymous")).status, 401);
  assert.equal((await invoke("/owner/audit-events", "foreign")).status, 404);
  assert.equal(
    (await invoke("/owner/audit-events", "owner", "application/json", "POST"))
      .status,
    405,
  );
  assert.equal(audit.lastListLimits.length, 0);

  const failing: AuditEventReader = {
    async list() {
      throw new StorageFailure("UNAVAILABLE", {
        cause: new Error(PRIVATE_FAILURE),
      });
    },
  };
  const failureHandler = createOwnerAuditHistoryRouteHandler({ audit: failing });
  for (const accept of ["application/json", "text/html"]) {
    const raw = new Request(`${INTERNAL_ORIGIN}/owner/audit-events`, {
      headers: identityHeaders(accept, "owner"),
    });
    const response = await failureHandler(routeContext(raw, "owner"));
    assert.ok(response);
    const body = await response.text();
    assert.equal(response.status, 503);
    assert.doesNotMatch(body, new RegExp(PRIVATE_FAILURE, "u"));
  }
});

test("owner audit and notification collections are finite, canonical, and non-disclosing", async () => {
  const fixture = await routeFixture();
  fixture.audit.events.push(
    auditEvent("audit:event-1", "audit:operation-1", "export-created"),
    auditEvent("audit:event-2", "audit:operation-2", "resource-transition"),
  );
  fixture.notifications.seed(notificationRecord("notification:first", "First notice"));
  fixture.notifications.seed(notificationRecord("notification:second", "Second notice"));

  const auditResponse = await fixture.request(
    "/owner/audit-events?page_size=1",
    { accept: "application/json", actor: "owner" },
  );
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as OwnerAuditCollectionDocument;
  assert.equal(audit.data.items.length, 1);
  assert.equal(audit.data.items[0]?.detail.kind, "export-created");
  const auditNext = audit.links.find((link) => link.rel.includes("next"));
  assert.match(auditNext?.href ?? "", /^https:\/\/instance\.example\//u);
  assert.doesNotMatch(JSON.stringify(audit), /worker\.internal|credential|private note/iu);

  const notificationResponse = await fixture.request(
    "/owner/manual-notifications?page_size=1",
    { accept: "application/json", actor: "owner" },
  );
  assert.equal(notificationResponse.status, 200);
  const notifications = await notificationResponse.json() as OwnerNotificationCollectionDocument;
  assert.equal(notifications.data.items.length, 1);
  assert.equal(notifications.data.items[0]?.subject_line, "First notice");
  assert.match(
    notifications.links.find((link) => link.rel.includes("item"))?.href ?? "",
    /^https:\/\/instance\.example\/owner\/manual-notifications\//u,
  );

  const html = await fixture.request(
    "/owner/manual-notifications?page_size=1",
    { accept: "text/html", actor: "owner" },
  );
  const htmlBody = await html.text();
  assert.equal(html.status, 200);
  assert.match(htmlBody, /First notice/u);
  assert.doesNotMatch(htmlBody, /Second notice/u);

  const badPage = await fixture.request(
    "/owner/audit-events?page_size=101&unexpected=value",
    { accept: "application/json", actor: "owner" },
  );
  assert.equal(badPage.status, 400);
  assert.deepEqual(fixture.audit.lastListLimits, [1]);

  const anonymous = await fixture.request("/owner/manual-notifications", {
    accept: "application/json",
    actor: "anonymous",
  });
  assert.equal(anonymous.status, 401);
  const foreign = await fixture.request("/owner/manual-notifications", {
    accept: "application/json",
    actor: "foreign",
  });
  assert.equal(foreign.status, 404);
  assert.doesNotMatch(await foreign.text(), /First notice|notification:first/u);

  const home = createOwnerHomeDocument(
    `${APP_ORIGIN}/owner`,
    { displayName: "Owner", email: OWNER_EMAIL },
    null,
    { auditNotificationHistory: true },
  );
  assert.ok(home.links.some((link) => link.rel.includes("audit-events")));
  assert.ok(home.links.some((link) => link.rel.includes("manual-notifications")));
});

test("notification copy and sent markers use separate guarded atomic actions", async () => {
  const fixture = await routeFixture();
  fixture.notifications.seed(
    notificationRecord("notification:activity", "Private notice", "Private template body."),
  );

  const jsonResponse = await fixture.request(
    "/owner/manual-notifications/notification%3Aactivity",
    { accept: "application/json", actor: "owner" },
  );
  assert.equal(jsonResponse.status, 200);
  assert.equal(jsonResponse.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  let document = await jsonResponse.json() as OwnerNotificationDetailDocument;
  assert.deepEqual(
    document.actions.map((action) => action.name).sort(),
    ["mark-notification-sent", "record-notification-template-copy"],
  );
  assert.equal(document.data.purpose_id, "purpose:notification:activity");
  assert.equal(
    document.data.related_resource.id,
    "resource:notification:activity",
  );
  assert.ok(document.links.some((link) => link.rel.includes("audit-events")));
  assert.ok(document.links.some((link) => link.rel.includes("campaign")));

  const htmlResponse = await fixture.request(
    "/owner/manual-notifications/notification%3Aactivity",
    { accept: "text/html", actor: "owner" },
  );
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.equal(htmlResponse.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  assert.deepEqual(actionNamesFromHtml(html), actionNamesFromDocument(document));
  assert.match(html, new RegExp(`name="${MUTATION_CSRF_FIELD}" value="${CSRF_TOKEN}"`));
  assert.match(html, /purpose:notification:activity/u);
  assert.match(html, /resource:notification:activity/u);
  assert.match(html, /href="https:\/\/instance\.example\/owner\/audit-events"/u);
  assert.match(html, /href="\/">View campaign<\/a>/u);

  const copyAction = requiredAction(document, "record-notification-template-copy");
  const rejected = await fixture.submit(copyAction, {
    extra: "must-not-be-accepted",
  });
  assert.equal(rejected.status, 400);
  assert.equal(fixture.notifications.current("notification:activity")?.revision, 1);

  const crossOrigin = await fixture.submit(copyAction, {}, {
    origin: "https://attacker.example",
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(fixture.notifications.current("notification:activity")?.revision, 1);

  const copied = await fixture.submit(copyAction);
  assert.equal(copied.status, 200);
  document = await copied.json() as OwnerNotificationDetailDocument;
  assert.equal(document.data.revision, 2);
  assert.equal(document.data.copy_history.length, 1);
  assert.equal(document.data.sent_marker, null);
  const copiedAudit = fixture.audit.events.at(-1);
  assert.equal(copiedAudit?.detail.kind, "manual-notification");
  assert.equal(
    copiedAudit?.detail.kind === "manual-notification"
      ? copiedAudit.detail.activity
      : null,
    "template-copied",
  );

  const sentAction = requiredAction(document, "mark-notification-sent");
  const sent = await fixture.submit(sentAction);
  assert.equal(sent.status, 200);
  document = await sent.json() as OwnerNotificationDetailDocument;
  assert.equal(document.data.revision, 3);
  assert.equal(document.data.copy_history.length, 1);
  assert.equal(document.data.delivery_state, "marked-sent");
  assert.ok(document.data.sent_marker);
  assert.equal(
    document.actions.some((action) => action.name === "mark-notification-sent"),
    false,
  );
  assert.equal(
    document.actions.some(
      (action) => action.name === "record-notification-template-copy",
    ),
    true,
  );
  assert.deepEqual(
    fixture.audit.events.slice(-2).map((event) =>
      event.detail.kind === "manual-notification" ? event.detail.activity : null
    ),
    ["template-copied", "sent-marked"],
  );

  const finalHtmlResponse = await fixture.request(
    "/owner/manual-notifications/notification%3Aactivity",
    { accept: "text/html", actor: "owner" },
  );
  const finalHtml = await finalHtmlResponse.text();
  const copyEvidence = document.data.copy_history[0];
  assert.ok(copyEvidence);
  assert.match(finalHtml, new RegExp(copyEvidence.id, "u"));
  assert.ok(document.data.sent_marker);
  assert.match(finalHtml, new RegExp(document.data.sent_marker.id, "u"));

  const staleSent = await fixture.submit(sentAction);
  assert.equal(staleSent.status, 412);
  assert.equal(fixture.notifications.current("notification:activity")?.revision, 3);

  const denied = await fixture.request(
    "/owner/manual-notifications/notification%3Aactivity",
    { accept: "application/json", actor: "foreign" },
  );
  assert.equal(denied.status, 404);
  assert.doesNotMatch(await denied.text(), /Private notice|Private template body/u);
});

test("persistent verification requires one valid proof cleanup instruction", async () => {
  for (const [name, clearCookie] of [
    ["missing", undefined],
    ["malformed", "invalid\nclear-cookie"],
  ] as const) {
    const audit = new FakeAuditRepository();
    const notifications = new FakeNotificationRepository(audit);
    notifications.seed(
      notificationRecord(`notification:cleanup-${name}`, "Private cleanup notice"),
    );
    const csrfHash = await hashCsrfToken(CSRF_TOKEN);
    const guard = createBrowserMutationGuard({
      allowedOrigins: [APP_ORIGIN],
      now: () => new Date("2026-08-09T12:00:00.000Z"),
      resolveSession: async () => ({
        actor: { type: "owner", subject: actorSubject(OWNER_SUBJECT) },
        expiresAt: timestamp("2026-08-09T13:00:00.000Z"),
        csrf: {
          tokenHash: csrfHash,
          expiresAt: timestamp("2026-08-09T12:30:00.000Z"),
        },
      }),
    });
    let proofIssues = 0;
    const handler = createOwnerAuditNotificationHistoryRouteHandler({
      audit,
      notifications,
      mutationVerificationMode: "persistent-claim",
      verifyMutation: async (request, validateBeforeReplayClaim) => {
        const verified = await guard(request);
        assert.equal(validateBeforeReplayClaim?.(verified), true);
        return clearCookie === undefined
          ? verified
          : Object.freeze({ ...verified, clearCookie });
      },
      csrfToken: async () => {
        proofIssues += 1;
        return Object.freeze({
          token: CSRF_TOKEN,
          expiresAt: timestamp("2026-08-09T12:30:00.000Z"),
          setCookie:
            "__Host-owner-notification-proof=proof; Path=/; Secure; HttpOnly; SameSite=Lax",
        });
      },
      issueOperationId: () => operationId(`notification-action:cleanup-${name}`),
      now: () => new Date("2026-08-09T12:01:00.000Z"),
    });
    const path = `/owner/manual-notifications/${encodeURIComponent(
      `notification:cleanup-${name}`,
    )}`;
    const discoveryRequest = new Request(new URL(path, INTERNAL_ORIGIN), {
      headers: identityHeaders("application/json", "owner"),
    });
    const discoveryResponse = await handler(
      routeContext(discoveryRequest, "owner"),
    );
    assert.ok(discoveryResponse);
    const document = await discoveryResponse.json() as
      OwnerNotificationDetailDocument;
    const action = requiredAction(
      document,
      "record-notification-template-copy",
    );
    const body = new URLSearchParams();
    for (const field of action.fields) {
      const value = field.value ?? field.default;
      assert.notEqual(value, undefined);
      body.set(field.name, String(value));
    }
    body.set(MUTATION_CSRF_FIELD, CSRF_TOKEN);
    const mutationRequest = new Request(action.href, {
      method: "POST",
      headers: {
        ...identityHeaders("application/json", "owner"),
        "content-type": "application/x-www-form-urlencoded",
        origin: APP_ORIGIN,
      },
      body,
    });
    const response = await handler(routeContext(mutationRequest, "owner"));
    assert.ok(response);
    assert.equal(response.status, 503, name);
    assert.equal(response.headers.get("set-cookie"), null, name);
    assert.equal(proofIssues, 1, name);
    assert.equal(
      notifications.current(`notification:cleanup-${name}`)?.revision,
      1,
      name,
    );
    assert.equal(audit.events.length, 0, name);
  }
});

async function routeFixture() {
  const audit = new FakeAuditRepository();
  const notifications = new FakeNotificationRepository(audit);
  const csrfHash = await hashCsrfToken(CSRF_TOKEN);
  const guard = createBrowserMutationGuard({
    allowedOrigins: [APP_ORIGIN],
    now: () => new Date("2026-08-09T12:00:00.000Z"),
    resolveSession: async () => ({
      actor: { type: "owner", subject: actorSubject(OWNER_SUBJECT) },
      expiresAt: timestamp("2026-08-09T13:00:00.000Z"),
      csrf: {
        tokenHash: csrfHash,
        expiresAt: timestamp("2026-08-09T12:30:00.000Z"),
      },
    }),
  });
  let operation = 0;
  let second = 0;
  const handler = createOwnerAuditNotificationHistoryRouteHandler({
    audit,
    notifications,
    mutationVerificationMode: "legacy-non-claiming",
    verifyMutation: guard,
    csrfToken: async () => CSRF_TOKEN,
    issueOperationId: () => operationId(`notification-action:${++operation}`),
    now: () => new Date(`2026-08-09T12:00:${String(second++).padStart(2, "0")}.000Z`),
  });

  const request = async (
    path: string,
    options: Readonly<{
      accept: string;
      actor: "owner" | "foreign" | "anonymous";
    }>,
  ): Promise<Response> => {
    const url = new URL(path, INTERNAL_ORIGIN);
    const request = new Request(url, {
      headers: identityHeaders(options.accept, options.actor),
    });
    const response = await handler(routeContext(request, options.actor));
    assert.ok(response);
    return response;
  };

  const submit = async (
    action: HypermediaAction,
    extras: Readonly<Record<string, string>> = {},
    options: Readonly<{ origin?: string }> = {},
  ): Promise<Response> => {
    const body = new URLSearchParams();
    for (const field of action.fields) {
      const value = field.value ?? field.default;
      if (value !== undefined) body.set(field.name, String(value));
    }
    for (const [key, value] of Object.entries(extras)) body.set(key, value);
    body.set(MUTATION_CSRF_FIELD, CSRF_TOKEN);
    const request = new Request(action.href, {
      method: "POST",
      headers: {
        ...identityHeaders("application/json", "owner"),
        "content-type": "application/x-www-form-urlencoded",
        origin: options.origin ?? APP_ORIGIN,
      },
      body,
    });
    const response = await handler(routeContext(request, "owner"));
    assert.ok(response);
    return response;
  };

  return { audit, notifications, request, submit };
}

class FakeAuditRepository {
  readonly events: AuditEvent[] = [];
  readonly lastListLimits: number[] = [];

  async append(): Promise<AuditAppendResult> {
    throw new StorageFailure("UNAVAILABLE");
  }

  async get(id: unknown): Promise<AuditEvent | null> {
    return this.events.find((event) => event.id === id) ?? null;
  }

  async list(request: AuditListRequest): Promise<AuditEventPage> {
    this.lastListLimits.push(request.limit);
    const offset = cursorOffset(request.cursor);
    const items = this.events.slice(offset, offset + request.limit);
    const next = offset + items.length < this.events.length
      ? cursor(offset + items.length)
      : null;
    return Object.freeze({ items: Object.freeze(items), nextCursor: next });
  }
}

class FakeNotificationRepository {
  readonly activityConsistency = "atomic-notification-audit" as const;
  readonly #audit: FakeAuditRepository;
  readonly #records = new Map<string, ManualNotificationSnapshot>();

  constructor(audit: FakeAuditRepository) {
    this.#audit = audit;
  }

  seed(record: ManualNotificationRecord): void {
    this.#records.set(record.template.id, Object.freeze({ revision: 1, record }));
  }

  current(id: string): ManualNotificationSnapshot | null {
    return this.#records.get(id) ?? null;
  }

  async get(id: unknown): Promise<ManualNotificationSnapshot | null> {
    return typeof id === "string" ? this.current(id) : null;
  }

  async getActivityState(id: unknown) {
    const snapshot = await this.get(id);
    return snapshot === null
      ? null
      : Object.freeze({ snapshot, terminalReplay: null });
  }

  async list(request: Readonly<{ limit: number; cursor?: StorageCursor }>): Promise<ManualNotificationPage> {
    const values = [...this.#records.values()];
    const offset = cursorOffset(request.cursor);
    const items = values.slice(offset, offset + request.limit);
    const next = offset + items.length < values.length
      ? cursor(offset + items.length)
      : null;
    return Object.freeze({ items: Object.freeze(items), nextCursor: next });
  }

  async recordCopyWithAudit(
    request: AuditedManualNotificationActivityRequest,
  ): Promise<AuditedManualNotificationMutationResult> {
    return this.#activity(request, "template-copied");
  }

  async markSentWithAudit(
    request: AuditedManualNotificationActivityRequest,
  ): Promise<AuditedManualNotificationMutationResult> {
    return this.#activity(request, "sent-marked");
  }

  async #activity(
    request: AuditedManualNotificationActivityRequest,
    activity: "template-copied" | "sent-marked",
  ): Promise<AuditedManualNotificationMutationResult> {
    const id = String(request.notificationId);
    const current = this.#records.get(id);
    if (current === undefined) throw new StorageFailure("NOT_FOUND");
    if (request.expectedRevision !== current.revision) {
      throw new StorageFailure("PRECONDITION_FAILED");
    }
    const operation = operationId(request.operationId);
    const occurredAt = timestamp(request.occurredAt);
    const owner = actorSubject(request.ownerSubject);
    const changed = activity === "template-copied"
      ? recordManualNotificationCopy(current.record, {
          id: stableId<"manual-notification-copy">(`copy:${operation}`),
          copiedAt: occurredAt,
          copiedBy: { type: "owner", subject: owner },
        })
      : markManualNotificationSent(current.record, {
          id: stableId<"manual-notification-sent-marker">(`sent:${operation}`),
          sentAt: occurredAt,
          sentBy: { type: "owner", subject: owner },
        });
    if (!changed.ok) throw new StorageFailure("INVALID_REQUEST");
    const snapshot = Object.freeze({
      revision: current.revision + 1,
      record: changed.value,
    });
    this.#records.set(id, snapshot);
    const event: AuditEvent = Object.freeze({
      id: stableId<"audit-event">(`audit:${operation}`),
      operationId: stableId<"audit-operation">(operation),
      occurredAt,
      actor: Object.freeze({ type: "owner", subject: owner }),
      detail: Object.freeze({
        kind: "manual-notification",
        notificationId: stableId<"manual-notification">(id),
        activity,
      }),
    });
    this.#audit.events.push(event);
    return Object.freeze({ ...snapshot, replayed: false, auditEvent: event });
  }
}

function routeContext(
  request: Request,
  actorKind: "owner" | "foreign" | "anonymous",
): ApplicationRouteContext {
  const url = new URL(request.url);
  const actor = actorKind === "anonymous"
    ? null
    : authenticatedActor(
        actorKind === "owner" ? OWNER_SUBJECT : "oidc:foreign",
        actorKind === "owner" ? OWNER_EMAIL : "foreign@example.com",
      );
  return {
    request,
    url,
    resourceUrl: new URL(`${url.pathname}${url.search}`, `${APP_ORIGIN}/`).href,
    actor,
    isOwner: actorKind === "owner",
    participantAccess: null,
    campaign: null,
    renderApplication: async () => new Response("fallback"),
  };
}

function identityHeaders(
  accept: string,
  actor: "owner" | "foreign" | "anonymous",
): HeadersInit {
  if (actor === "anonymous") return { accept };
  return {
    accept,
    "oai-authenticated-user-id": actor === "owner" ? OWNER_SUBJECT : "oidc:foreign",
    "oai-authenticated-user-email": actor === "owner" ? OWNER_EMAIL : "foreign@example.com",
  };
}

function authenticatedActor(userId: string, email: string): AuthenticatedActor {
  return { userId, email, displayName: email };
}

function notificationRecord(
  id: string,
  subjectLine: string,
  body = "Bounded notification body.",
): ManualNotificationRecord {
  const parsed = parseManualNotificationTemplate({
    id,
    purposeId: `purpose:${id}`,
    recipientSubject: "oidc:participant",
    relatedResource: {
      type: "investment-indication",
      id: `resource:${id}`,
    },
    subjectLine,
    body,
    generatedAt: "2026-08-09T10:00:00.000Z",
    generatedBy: { type: "owner", subject: OWNER_SUBJECT },
  });
  assert(parsed.ok);
  return createManualNotificationRecord(parsed.value);
}

function auditEvent(
  id: string,
  operation: string,
  kind: "export-created" | "resource-transition",
): AuditEvent {
  return Object.freeze({
    id: stableId<"audit-event">(id),
    operationId: stableId<"audit-operation">(operation),
    occurredAt: timestamp("2026-08-09T10:00:00.000Z"),
    actor: Object.freeze({ type: "owner", subject: actorSubject(OWNER_SUBJECT) }),
    detail: kind === "export-created"
      ? Object.freeze({ kind, exportType: "review-csv" })
      : Object.freeze({
          kind,
          resource: Object.freeze({
            type: "campaign" as const,
            id: stableId<"audit-resource">("resource:campaign"),
          }),
          transition: "updated",
        }),
  });
}

function requiredAction(
  document: OwnerNotificationDetailDocument,
  name: string,
): HypermediaAction {
  const action = document.actions.find((candidate) => candidate.name === name);
  assert.ok(action, `Missing action ${name}`);
  return action;
}

function actionNamesFromDocument(
  document: OwnerNotificationDetailDocument,
): string[] {
  return document.actions.map((action) => action.name).sort();
}

function actionNamesFromHtml(html: string): string[] {
  return [...html.matchAll(/data-action="([a-z0-9-]+)"/g)]
    .map((match) => match[1] ?? "")
    .filter(Boolean)
    .sort();
}

function actorSubject(value: unknown) {
  const parsed = parseActorSubject(value);
  assert(parsed.ok);
  return parsed.value;
}

function timestamp(value: unknown) {
  const parsed = parseTimestamp(value);
  assert(parsed.ok);
  return parsed.value;
}

function stableId<Entity extends string>(value: unknown) {
  const parsed = parseStableId<Entity>(value);
  assert(parsed.ok);
  return parsed.value;
}

function operationId(value: unknown): StorageOperationId {
  const parsed = parseStorageOperationId(value);
  assert(parsed.ok);
  return parsed.value;
}

function cursor(offset: number): StorageCursor {
  return `offset:${offset}` as StorageCursor;
}

function cursorOffset(value: StorageCursor | undefined): number {
  if (value === undefined) return 0;
  const match = /^offset:(\d+)$/.exec(value);
  if (!match) throw new StorageFailure("INVALID_REQUEST");
  return Number(match[1]);
}
