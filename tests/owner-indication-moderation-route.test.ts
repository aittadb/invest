import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAmountAggregateConfiguration,
} from "../domain/amount-aggregate-configuration.ts";
import {
  createManualNotificationRecord,
  parseManualNotificationTemplate,
  type AuditEvent,
} from "../domain/audit-notification.ts";
import {
  parseActorSubject,
  parseStableId,
  parseTimestamp,
} from "../domain/foundation.ts";
import type { HypermediaAction } from "../domain/hypermedia-action.ts";
import {
  createInvestmentIndication,
  rejectInvestmentIndication,
  type ActiveInvestmentIndication,
  type OwnerIndicationActor,
  type ParticipantIndicationActor,
} from "../domain/investment-indication.ts";
import {
  projectInvestmentIndicationForAggregation,
  type StoredInvestmentAggregateSnapshot,
} from "../domain/investment-aggregate.ts";
import {
  createOwnerHomeDocument,
} from "../domain/owner-home-resource.ts";
import type {
  OwnerIndicationCollectionDocument,
  OwnerIndicationDetailDocument,
} from "../domain/owner-indication-moderation-resource.ts";
import {
  createPackageAcceptance,
  createPackageVersion,
} from "../domain/package-content.ts";
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
  AtomicOwnerIndicationModerationRepository,
  OwnerIndicationModerationItem,
  OwnerIndicationModerationListRequest,
  OwnerIndicationModerationPage,
  RejectIndicationWithEffectsRequest,
  RejectIndicationWithEffectsResult,
} from "../services/owner-indication-moderation.ts";
import {
  createOwnerIndicationModerationRouteHandler,
} from "../worker/routes/owner-indication-moderation.ts";
import type {
  ApplicationRouteContext,
  AuthenticatedActor,
} from "../worker/contracts.ts";

const APP_ORIGIN = "https://instance.example";
const INTERNAL_ORIGIN = "https://worker.internal";
const OWNER_SUBJECT = "oidc:configured-owner";
const OWNER_EMAIL = "owner@example.com";
const PARTICIPANT_SUBJECT = "oidc:private-participant";
const REVIEW_ID = "review_WQ4Y0K9J2T";
const CSRF_TOKEN = "owner_csrf_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

test("owner indication resources are finite, canonical, equivalent, and non-disclosing", async () => {
  const fixture = await routeFixture();

  const collectionResponse = await fixture.request(
    "/owner/investment-indications?page_size=1",
    { accept: "application/json", actor: "owner" },
  );
  assert.equal(collectionResponse.status, 200);
  const collection = await collectionResponse.json() as OwnerIndicationCollectionDocument;
  assert.equal(collection.data.items.length, 1);
  assert.equal(collection.data.items[0]?.review_id, REVIEW_ID);
  assert.match(
    collection.links.find((link) => link.rel.includes("item"))?.href ?? "",
    /^https:\/\/instance\.example\/owner\/investment-indications\//u,
  );
  assert.doesNotMatch(
    JSON.stringify(collection),
    /worker\.internal|indication:moderated|private-participant/iu,
  );

  const detailResponse = await fixture.request(
    `/owner/investment-indications/${REVIEW_ID}`,
    { accept: "application/json", actor: "owner" },
  );
  assert.equal(detailResponse.status, 200);
  assert.equal(detailResponse.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  const detail = await detailResponse.json() as OwnerIndicationDetailDocument;
  assert.equal(detail.data.participant_subject, PARTICIPANT_SUBJECT);
  assert.deepEqual(detail.actions.map((action) => action.name), [
    "reject-investment-indication",
  ]);
  assert.doesNotMatch(JSON.stringify(detail), new RegExp(CSRF_TOKEN, "u"));
  assert.match(detail.actions[0]?.href ?? "", /^https:\/\/instance\.example\//u);

  const htmlResponse = await fixture.request(
    `/owner/investment-indications/${REVIEW_ID}`,
    { accept: "text/html", actor: "owner" },
  );
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.equal(htmlResponse.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  assert.deepEqual(actionNamesFromHtml(html), actionNamesFromDocument(detail));
  assert.match(html, new RegExp(`name="${MUTATION_CSRF_FIELD}" value="${CSRF_TOKEN}"`, "u"));

  const anonymous = await fixture.request("/owner/investment-indications", {
    accept: "application/json",
    actor: "anonymous",
  });
  assert.equal(anonymous.status, 401);
  const foreign = await fixture.request(
    `/owner/investment-indications/${REVIEW_ID}`,
    { accept: "application/json", actor: "foreign" },
  );
  assert.equal(foreign.status, 404);
  assert.doesNotMatch(
    await foreign.text(),
    /private-participant|indication:moderated|1250/iu,
  );

  const invalidPage = await fixture.request(
    "/owner/investment-indications?page_size=101&unexpected=value",
    { accept: "application/json", actor: "owner" },
  );
  assert.equal(invalidPage.status, 400);

  const home = createOwnerHomeDocument(
    `${APP_ORIGIN}/owner`,
    { displayName: "Owner", email: OWNER_EMAIL },
    null,
    { indicationModeration: true },
  );
  assert.ok(home.links.some((link) => link.rel.includes("investment-indications")));
  assert.ok(home.actions.some((action) => action.name === "review-investment-indications"));
});

test("rejection atomically removes aggregate contribution and records evidence", async () => {
  const fixture = await routeFixture();
  const detail = await fixture.detail();
  const action = requiredAction(detail, "reject-investment-indication");

  const response = await fixture.submit(
    action,
    { reason: "  Outside the current review scope.\r\nPlease contact us with questions.  " },
    { mediaType: "application/json" },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get(MUTATION_CSRF_HEADER), null);
  const rejected = await response.json() as OwnerIndicationDetailDocument;
  assert.equal(rejected.data.status, "rejected");
  assert.equal(
    rejected.data.rejection?.reason,
    "Outside the current review scope.\nPlease contact us with questions.",
  );
  assert.deepEqual(rejected.actions, []);

  const checkpoint = fixture.repository.checkpoint();
  assert.equal(checkpoint.status, "rejected");
  assert.deepEqual(checkpoint.aggregate, {
    revision: 2,
    totalAmount: 0,
    currency: "XYZ",
    contributingIndicationCount: 0,
  });
  assert.equal(checkpoint.auditCount, 1);
  assert.equal(checkpoint.notificationCount, 1);
  assert.equal(checkpoint.auditTransition, "rejected");
  assert.equal(checkpoint.notificationRecipient, PARTICIPANT_SUBJECT);

  const replay = await fixture.submit(
    action,
    { reason: "  Outside the current review scope.\r\nPlease contact us with questions.  " },
    { mediaType: "application/json" },
  );
  assert.equal(replay.status, 200);
  assert.deepEqual(fixture.repository.checkpoint(), checkpoint);

  const staleAction = actionWithField(
    action,
    "operation-id",
    "moderation-action:stale",
  );
  const stale = await fixture.submit(staleAction, {
    reason: "A second decision must not be accepted.",
  });
  assert.equal(stale.status, 412);
  assert.deepEqual(fixture.repository.checkpoint(), checkpoint);
});

test("moderation rejects unsafe requests and rolls back every effect on failure", async () => {
  const fixture = await routeFixture();
  const action = requiredAction(await fixture.detail(), "reject-investment-indication");
  const initial = fixture.repository.checkpoint();

  const extraField = await fixture.submit(action, {
    reason: "Bounded reason.",
    unexpected: "not accepted",
  });
  assert.equal(extraField.status, 400);
  assert.deepEqual(fixture.repository.checkpoint(), initial);

  const crossOrigin = await fixture.submit(
    action,
    { reason: "Bounded reason." },
    { origin: "https://attacker.example" },
  );
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(fixture.repository.checkpoint(), initial);

  fixture.repository.failNextCommit = true;
  const failedCommit = await fixture.submit(action, {
    reason: "This transaction is forced to fail.",
  });
  assert.equal(failedCommit.status, 503);
  assert.deepEqual(fixture.repository.checkpoint(), initial);

  const unsafeReason = await fixture.submit(action, {
    reason: "Unsafe\u202ereason",
  });
  assert.equal(unsafeReason.status, 400);
  assert.deepEqual(fixture.repository.checkpoint(), initial);
});

test("reject action is absent unless the repository advertises the strong consistency contract", async () => {
  const fixture = await routeFixture();
  Object.defineProperty(fixture.repository, "moderationConsistency", {
    configurable: true,
    value: "eventual",
  });

  const response = await fixture.request(
    `/owner/investment-indications/${REVIEW_ID}`,
    { accept: "application/json", actor: "owner" },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get(MUTATION_CSRF_HEADER), null);
  const detail = await response.json() as OwnerIndicationDetailDocument;
  assert.deepEqual(detail.actions, []);
});

async function routeFixture() {
  const indication = await activeIndication();
  const repository = new FakeAtomicModerationRepository(indication);
  const csrfHash = await hashCsrfToken(CSRF_TOKEN);
  const guard = createBrowserMutationGuard({
    allowedOrigins: [APP_ORIGIN],
    now: () => new Date("2026-08-09T12:00:00.000Z"),
    resolveSession: async () => ({
      actor: { type: "owner", subject: actorSubject(OWNER_SUBJECT) },
      expiresAt: timestamp("2026-08-09T14:00:00.000Z"),
      csrf: {
        tokenHash: csrfHash,
        expiresAt: timestamp("2026-08-09T13:00:00.000Z"),
      },
    }),
  });
  let operation = 0;
  let second = 0;
  const handler = createOwnerIndicationModerationRouteHandler({
    repository,
    verifyMutation: guard,
    csrfToken: async () => CSRF_TOKEN,
    issueOperationId: () => operationId(`moderation-action:${++operation}`),
    now: () => new Date(`2026-08-09T12:10:${String(second++).padStart(2, "0")}.000Z`),
  });

  const request = async (
    path: string,
    options: Readonly<{
      accept: string;
      actor: "owner" | "foreign" | "anonymous";
    }>,
  ): Promise<Response> => {
    const url = new URL(path, INTERNAL_ORIGIN);
    const incoming = new Request(url, {
      headers: identityHeaders(options.accept, options.actor),
    });
    const response = await handler(routeContext(incoming, options.actor));
    assert.ok(response);
    return response;
  };

  const detail = async (): Promise<OwnerIndicationDetailDocument> => {
    const response = await request(
      `/owner/investment-indications/${REVIEW_ID}`,
      { accept: "application/json", actor: "owner" },
    );
    assert.equal(response.status, 200);
    return response.json() as Promise<OwnerIndicationDetailDocument>;
  };

  const submit = async (
    action: HypermediaAction,
    values: Readonly<Record<string, string>>,
    options: Readonly<{
      origin?: string;
      mediaType?: "application/json" | "application/x-www-form-urlencoded";
    }> = {},
  ): Promise<Response> => {
    const fields: Record<string, string | number | boolean> = {};
    for (const field of action.fields) {
      const value = field.value ?? field.default;
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        fields[field.name] = value;
      }
    }
    Object.assign(fields, values);
    const mediaType = options.mediaType ?? "application/x-www-form-urlencoded";
    const headers = new Headers(identityHeaders("application/json", "owner"));
    headers.set("content-type", mediaType);
    headers.set("origin", options.origin ?? APP_ORIGIN);
    let body: BodyInit;
    if (mediaType === "application/json") {
      headers.set(MUTATION_CSRF_HEADER, CSRF_TOKEN);
      body = JSON.stringify(fields);
    } else {
      const form = new URLSearchParams();
      for (const [name, value] of Object.entries(fields)) {
        form.set(name, String(value));
      }
      form.set(MUTATION_CSRF_FIELD, CSRF_TOKEN);
      body = form;
    }
    const incoming = new Request(action.href, {
      method: "POST",
      headers,
      body,
    });
    const response = await handler(routeContext(incoming, "owner"));
    assert.ok(response);
    return response;
  };

  return { repository, request, detail, submit };
}

class FakeAtomicModerationRepository
  implements AtomicOwnerIndicationModerationRepository {
  readonly moderationConsistency =
    "atomic-indication-aggregate-audit-notification" as const;
  readonly #operations = new Map<string, RejectIndicationWithEffectsResult>();
  readonly #auditEvents: AuditEvent[] = [];
  readonly #notifications = new Map<string, RejectIndicationWithEffectsResult["notification"]>();
  #item: OwnerIndicationModerationItem;
  #aggregate: StoredInvestmentAggregateSnapshot;
  failNextCommit = false;

  constructor(indication: ActiveInvestmentIndication) {
    this.#item = Object.freeze({
      reviewId: REVIEW_ID,
      indication,
      notification: null,
    });
    this.#aggregate = Object.freeze({
      revision: 1,
      totalAmount: indication.fields.amount,
      currency: indication.fields.currency,
      contributingIndicationCount: 1,
    });
  }

  async list(
    request: OwnerIndicationModerationListRequest,
  ): Promise<OwnerIndicationModerationPage> {
    const offset = cursorOffset(request.cursor);
    const items = [this.#item].slice(offset, offset + request.limit);
    const nextCursor = offset + items.length < 1
      ? cursor(offset + items.length)
      : null;
    return Object.freeze({ items: Object.freeze(items), nextCursor });
  }

  async get(reviewId: unknown): Promise<OwnerIndicationModerationItem | null> {
    return reviewId === REVIEW_ID ? this.#item : null;
  }

  async rejectWithEffects(
    request: RejectIndicationWithEffectsRequest,
  ): Promise<RejectIndicationWithEffectsResult> {
    const replay = this.#operations.get(String(request.operationId));
    if (replay) return Object.freeze({ ...replay, replayed: true });
    if (request.reviewId !== REVIEW_ID) throw new StorageFailure("NOT_FOUND");
    if (request.indicationId !== this.#item.indication.id) {
      throw new StorageFailure("NOT_FOUND");
    }
    if (request.expectedRevision !== this.#item.indication.revision) {
      throw new StorageFailure("PRECONDITION_FAILED");
    }
    if (this.#item.indication.lifecycle.status !== "active") {
      throw new StorageFailure("PRECONDITION_FAILED");
    }

    const owner: OwnerIndicationActor = Object.freeze({
      type: "owner",
      subject: actorSubject(request.ownerSubject),
    });
    const rejected = rejectInvestmentIndication(
      this.#item.indication,
      {
        occurredAt: request.occurredAt,
        historyEntryId: stableId<"investment-indication-history-entry">(
          `history:${request.operationId}`,
        ),
        reason: request.reason,
      },
      owner,
    );
    if (!rejected.ok) throw new StorageFailure("INVALID_REQUEST");
    const contribution = projectInvestmentIndicationForAggregation(rejected.value);
    const aggregate = Object.freeze({
      revision: this.#aggregate.revision + 1,
      totalAmount: this.#aggregate.totalAmount - this.#item.indication.fields.amount,
      currency: this.#aggregate.currency,
      contributingIndicationCount:
        this.#aggregate.contributingIndicationCount - 1,
    }) as StoredInvestmentAggregateSnapshot;
    const resourceId = stableId<"audit-resource">(rejected.value.id);
    const notificationTemplate = parseManualNotificationTemplate({
      id: `notification:${request.operationId}`,
      purposeId: `purpose:${request.operationId}`,
      recipientSubject: rejected.value.participantSubject,
      relatedResource: {
        type: "investment-indication",
        id: resourceId,
      },
      subjectLine: "Update about your investment indication",
      body: `Your investment indication was rejected.\n\nReason: ${request.reason}`,
      generatedAt: request.occurredAt,
      generatedBy: owner,
    });
    if (!notificationTemplate.ok) throw new StorageFailure("INVALID_REQUEST");
    const notification = Object.freeze({
      revision: 1,
      record: createManualNotificationRecord(notificationTemplate.value),
    });
    const auditEvent: AuditEvent = Object.freeze({
      id: stableId<"audit-event">(`audit:${request.operationId}`),
      operationId: stableId<"audit-operation">(request.operationId),
      occurredAt: timestamp(request.occurredAt),
      actor: owner,
      detail: Object.freeze({
        kind: "resource-transition",
        resource: Object.freeze({
          type: "investment-indication",
          id: resourceId,
        }),
        transition: "rejected",
      }),
    });
    const item = Object.freeze({
      reviewId: REVIEW_ID,
      indication: rejected.value,
      notification,
    });
    const result: RejectIndicationWithEffectsResult = Object.freeze({
      item,
      aggregate: Object.freeze({ contribution, stored: aggregate }),
      auditEvent,
      notification,
      replayed: false,
    });

    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new StorageFailure("UNAVAILABLE");
    }
    this.#item = item;
    this.#aggregate = aggregate;
    this.#auditEvents.push(auditEvent);
    this.#notifications.set(notification.record.template.id, notification);
    this.#operations.set(String(request.operationId), result);
    return result;
  }

  checkpoint() {
    const lastAudit = this.#auditEvents.at(-1);
    const lastNotification = [...this.#notifications.values()].at(-1);
    return {
      status: this.#item.indication.lifecycle.status,
      revision: this.#item.indication.revision,
      aggregate: { ...this.#aggregate },
      auditCount: this.#auditEvents.length,
      notificationCount: this.#notifications.size,
      auditTransition: lastAudit?.detail.kind === "resource-transition"
        ? lastAudit.detail.transition
        : null,
      notificationRecipient:
        lastNotification?.record.template.recipientSubject ?? null,
    };
  }
}

async function activeIndication(): Promise<ActiveInvestmentIndication> {
  const amount = parseAmountAggregateConfiguration({
    amount: {
      currency: "xyz",
      minimum: 1_000,
      increment: 250,
      maximum: 10_000,
    },
    publicAggregate: { visibility: "hidden" },
  });
  assert(amount.ok);
  const participant = participantActor(PARTICIPANT_SUBJECT);
  const version = await createPackageVersion({
    id: "package-version:moderation",
    createdAt: "2026-08-09T10:00:00.000Z",
    changeSummary: "Synthetic moderation package",
    materialChange: false,
    acknowledgmentText: "This indication is non-binding.",
    sections: [{
      id: "package-section:overview",
      order: 0,
      title: "Overview",
      markdown: "Synthetic package copy.",
      enabled: true,
    }],
  }, null);
  assert(version.ok);
  const acceptance = createPackageAcceptance({
    id: "acceptance:moderation",
    participantSubject: participant.subject,
    acceptedAt: "2026-08-09T10:30:00.000Z",
  }, version.value);
  assert(acceptance.ok);
  const indication = createInvestmentIndication({
    id: "indication:moderated",
    occurredAt: "2026-08-09T11:00:00.000Z",
    historyEntryId: "history:moderated:created",
    fields: {
      kind: "personal",
      residenceCountry: "fi",
      amount: 1_250,
      availabilityPeriod: "Within twelve months.",
      note: "Private participant note.",
    },
  }, participant, amount.value.amount, {
    currentVersion: version.value,
    latestAcceptance: acceptance.value,
  });
  assert(indication.ok);
  return indication.value;
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

function requiredAction(
  document: OwnerIndicationDetailDocument,
  name: string,
): HypermediaAction {
  const action = document.actions.find((candidate) => candidate.name === name);
  assert.ok(action, `Missing action ${name}`);
  return action;
}

function actionWithField(
  action: HypermediaAction,
  fieldName: string,
  value: string,
): HypermediaAction {
  return {
    ...action,
    fields: action.fields.map((field) =>
      field.name === fieldName ? { ...field, value } : field
    ),
  };
}

function actionNamesFromDocument(document: OwnerIndicationDetailDocument): string[] {
  return document.actions.map((action) => action.name).sort();
}

function actionNamesFromHtml(html: string): string[] {
  return [...html.matchAll(/data-action="([a-z0-9-]+)"/g)]
    .map((match) => match[1] ?? "")
    .filter(Boolean)
    .sort();
}

function authenticatedActor(userId: string, email: string): AuthenticatedActor {
  return { userId, email, displayName: email };
}

function participantActor(value: unknown): ParticipantIndicationActor {
  return Object.freeze({ type: "participant", subject: actorSubject(value) });
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
  const match = /^offset:(\d+)$/u.exec(value);
  if (!match) throw new StorageFailure("INVALID_REQUEST");
  return Number(match[1]);
}
