import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAmountAggregateConfiguration,
  type AmountConfiguration,
} from "../domain/amount-aggregate-configuration.ts";
import {
  createManualNotificationRecord,
  parseManualNotificationTemplate,
} from "../domain/audit-notification.ts";
import {
  parseActorSubject,
  parseStableId,
  type ActorSubject,
} from "../domain/foundation.ts";
import type {
  InvestmentIndication,
  InvestmentIndicationId,
  RejectedInvestmentIndication,
  TrustedPackageAcknowledgmentContext,
} from "../domain/investment-indication.ts";
import { MAX_INVESTMENT_INDICATION_REVISIONS } from "../domain/investment-indication.ts";
import {
  createPackageAcceptance,
  createPackageVersion,
} from "../domain/package-content.ts";
import {
  StorageFailure,
  parseStorageKey,
  storageKeyString,
  type StorageAdapter,
  type StorageDocument,
  type StorageKey,
} from "../domain/storage-adapter.ts";
import { DevelopmentInMemoryManualNotificationRepository } from "../repositories/in-memory-audit-notification-repositories.ts";
import {
  DevelopmentInMemoryIndicationRepository,
  MAX_INDICATION_STORAGE_READS,
  ownerIndicationCurrentStorageKey,
} from "../repositories/in-memory-indication-repository.ts";
import {
  StorageOwnerIndicationReviewDetailRepository,
  type OwnerIndicationReviewIdResolver,
} from "../repositories/storage-owner-indication-review-detail-repository.ts";
import { StorageParticipantInvestmentInterestRepository } from "../repositories/storage-participant-investment-repository.ts";
import {
  OWNER_INDICATION_REJECTION_NOTIFICATION_SUBJECT,
  ownerIndicationRejectionNotificationBody,
  ownerIndicationRejectionNotificationId,
  ownerIndicationRejectionNotificationPurposeId,
} from "../services/owner-indication-notification-identity.ts";
import { createParticipantInvestmentInterestService } from "../worker/investment-interest-service.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";

const OWNER = subject("issuer.invalid/owner:indication-detail");
const ROTATED_OWNER = subject("issuer.invalid/owner:rotated-detail");
const FOREIGN_OWNER = subject("issuer.invalid/owner:foreign-detail");
const PARTICIPANT = subject("issuer.invalid/participant:indication-detail");
const AMOUNT = amountConfiguration();

test("owner resolves one opaque indication detail across restart without listing", async () => {
  const state = new MemoryStorageState();
  const indication = await seedEditedIndication(state);
  const key = await ownerIndicationCurrentStorageKey(indication.id);
  const reviewId = await REVIEW_IDS.reviewIdForCurrentKey(key, OWNER);
  assert.equal(reviewId.includes(PARTICIPANT), false);
  assert.equal(reviewId.includes("Private participant note"), false);

  const counted = new CountingStorageAdapter(new MemoryStorageAdapter(state));
  const item = await detailRepository(counted).get(reviewId);
  assert(item);
  assert.equal(item.reviewId, reviewId);
  assert.deepEqual(item.indication, indication);
  assert.equal(item.indication.history.length, 2);
  assert.equal(item.notification, null);
  assert.equal(counted.lists, 0);
  assert.ok(counted.reads <= MAX_INDICATION_STORAGE_READS);

  const reopened = await detailRepository(
    new MemoryStorageAdapter(state),
  ).get(reviewId);
  assert.deepEqual(reopened, item);
});

test("rejected detail resolves its bounded current notification across restart", async () => {
  const state = new MemoryStorageState();
  const active = await seedEditedIndication(state);
  const rejected = await rejectIndication(state, active);
  const notification = await seedRejectionNotification(state, rejected);
  const reviewId = await REVIEW_IDS.reviewIdForCurrentKey(
    await ownerIndicationCurrentStorageKey(rejected.id),
    OWNER,
  );

  const item = await detailRepository(
    new MemoryStorageAdapter(state),
  ).get(reviewId);
  assert(item);
  assert.deepEqual(item.indication, rejected);
  assert.deepEqual(item.notification, notification);
  assert.equal(item.notification?.record.copyEvidence.length, 0);
  assert.equal(item.notification?.record.sentMarker, null);

  const reopened = await detailRepository(
    new MemoryStorageAdapter(state),
  ).get(reviewId);
  assert.deepEqual(reopened, item);
});

test("maximum indication ancestry stays inside the finite detail read ceiling", async () => {
  const state = new MemoryStorageState();
  const indication = await seedEditedIndication(
    state,
    MAX_INVESTMENT_INDICATION_REVISIONS - 2,
  );
  assert.equal(
    indication.revision,
    MAX_INVESTMENT_INDICATION_REVISIONS - 1,
  );
  const reviewId = await REVIEW_IDS.reviewIdForCurrentKey(
    await ownerIndicationCurrentStorageKey(indication.id),
    OWNER,
  );
  const counted = new CountingStorageAdapter(new MemoryStorageAdapter(state));
  const item = await detailRepository(counted).get(reviewId);
  assert(item);
  assert.equal(item.indication.history.length, indication.revision);
  assert.ok(counted.reads <= MAX_INDICATION_STORAGE_READS);
  assert.equal(counted.lists, 0);
});

test("malformed, tampered, missing, crossed, and foreign detail reads disclose nothing", async () => {
  const state = new MemoryStorageState();
  const indication = await seedEditedIndication(state);
  const key = await ownerIndicationCurrentStorageKey(indication.id);
  const reviewId = await REVIEW_IDS.reviewIdForCurrentKey(key, OWNER);
  const tampered = `${reviewId.slice(0, -1)}${
    reviewId.endsWith("0") ? "1" : "0"
  }`;
  const missing = await REVIEW_IDS.reviewIdForCurrentKey(
    await ownerIndicationCurrentStorageKey(
      indicationId("investment-indication:missing-owner-detail"),
    ),
    OWNER,
  );
  const repository = detailRepository(new MemoryStorageAdapter(state));

  for (const candidate of [
    "",
    "x".repeat(193),
    "private subject in a URL",
    tampered,
    missing,
  ]) {
    assert.equal(await repository.get(candidate), null);
  }

  const crossedState = new MemoryStorageState();
  const crossedIndication = await seedEditedIndication(crossedState);
  const crossedKey = await ownerIndicationCurrentStorageKey(
    crossedIndication.id,
  );
  const stored = crossedState.records.get(storageKeyString(crossedKey));
  assert(stored);
  crossedState.records.set(storageKeyString(crossedKey), Object.freeze({
    ...stored,
    value: Object.freeze({
      ...stored.value,
      indicationId: "investment-indication:crossed-owner-detail",
    }),
  }));
  const crossedReviewId = await REVIEW_IDS.reviewIdForCurrentKey(
    crossedKey,
    OWNER,
  );
  const crossed = await captureFailure(() =>
    detailRepository(new MemoryStorageAdapter(crossedState)).get(crossedReviewId)
  );
  assert.equal(crossed.code, "UNAVAILABLE");
  assert.doesNotMatch(String(crossed), /participant|crossed|private/iu);

  for (const actor of [null, FOREIGN_OWNER] as const) {
    const counted = new CountingStorageAdapter(new MemoryStorageAdapter(state));
    const denied = new StorageOwnerIndicationReviewDetailRepository(
      counted,
      actor,
      OWNER,
      AMOUNT,
      REVIEW_IDS,
    );
    assert.equal(await denied.get(reviewId), null);
    assert.equal(counted.reads, 0);
    assert.equal(counted.lists, 0);
  }
});

test("coherently rewritten notification templates fail closed without scanning", async () => {
  const rewrites = [
    { purposeId: "notification-purpose:coherently-rewritten" },
    { subjectLine: "Coherently rewritten private subject" },
    { body: "Coherently rewritten private body." },
  ] as const;

  for (const rewrite of rewrites) {
    const state = new MemoryStorageState();
    const rejected = await rejectIndication(
      state,
      await seedEditedIndication(state),
    );
    const notification = await seedRejectionNotification(state, rejected);
    rewriteEveryNotificationTemplate(state, rewrite);

    const notifications = new DevelopmentInMemoryManualNotificationRepository(
      new MemoryStorageAdapter(state),
    );
    assert(await notifications.get(notification.record.template.id));
    const reviewId = await REVIEW_IDS.reviewIdForCurrentKey(
      await ownerIndicationCurrentStorageKey(rejected.id),
      OWNER,
    );
    const counted = new CountingStorageAdapter(new MemoryStorageAdapter(state));
    const failure = await captureFailure(() =>
      detailRepository(counted).get(reviewId)
    );
    assert.equal(failure.code, "UNAVAILABLE");
    assert.doesNotMatch(String(failure), /Coherently|private|rewritten/iu);
    assert.equal(counted.lists, 0);
  }
});

test("foreign notification copy and sent actors fail closed", async () => {
  for (const activity of ["copy", "sent"] as const) {
    const state = new MemoryStorageState();
    const rejected = await rejectIndication(
      state,
      await seedEditedIndication(state),
    );
    const notification = await seedRejectionNotification(state, rejected);
    const notifications = new DevelopmentInMemoryManualNotificationRepository(
      new MemoryStorageAdapter(state),
    );
    if (activity === "copy") {
      await notifications.recordCopy({
        operationId: "notification-operation:foreign-copy",
        notificationId: notification.record.template.id,
        expectedRevision: notification.revision,
        evidence: {
          id: "notification-copy:foreign-owner",
          copiedAt: "2026-08-12T12:10:00.000Z",
          copiedBy: { type: "owner", subject: FOREIGN_OWNER },
        },
      });
    } else {
      await notifications.markSent({
        operationId: "notification-operation:foreign-sent",
        notificationId: notification.record.template.id,
        expectedRevision: notification.revision,
        marker: {
          id: "notification-sent-marker:foreign-owner",
          sentAt: "2026-08-12T12:10:00.000Z",
          sentBy: { type: "owner", subject: FOREIGN_OWNER },
        },
      });
    }

    const reviewId = await REVIEW_IDS.reviewIdForCurrentKey(
      await ownerIndicationCurrentStorageKey(rejected.id),
      OWNER,
    );
    const failure = await captureFailure(() =>
      detailRepository(new MemoryStorageAdapter(state)).get(reviewId)
    );
    assert.equal(failure.code, "UNAVAILABLE");
    assert.doesNotMatch(String(failure), /foreign|owner|participant/iu);
  }
});

test("rejecting and current owners remain valid notification activity actors after rotation", async () => {
  const state = new MemoryStorageState();
  const rejected = await rejectIndication(
    state,
    await seedEditedIndication(state),
  );
  const notification = await seedRejectionNotification(state, rejected);
  const notifications = new DevelopmentInMemoryManualNotificationRepository(
    new MemoryStorageAdapter(state),
  );
  const copied = await notifications.recordCopy({
    operationId: "notification-operation:rejecting-owner-copy",
    notificationId: notification.record.template.id,
    expectedRevision: notification.revision,
    evidence: {
      id: "notification-copy:rejecting-owner",
      copiedAt: "2026-08-12T12:10:00.000Z",
      copiedBy: { type: "owner", subject: OWNER },
    },
  });
  const sent = await notifications.markSent({
    operationId: "notification-operation:rotated-owner-sent",
    notificationId: notification.record.template.id,
    expectedRevision: copied.revision,
    marker: {
      id: "notification-sent-marker:rotated-owner",
      sentAt: "2026-08-12T12:20:00.000Z",
      sentBy: { type: "owner", subject: ROTATED_OWNER },
    },
  });
  const reviewId = await REVIEW_IDS.reviewIdForCurrentKey(
    await ownerIndicationCurrentStorageKey(rejected.id),
    ROTATED_OWNER,
  );

  const item = await detailRepository(
    new MemoryStorageAdapter(state),
    ROTATED_OWNER,
  ).get(reviewId);
  assert(item);
  assert.deepEqual(item.notification, {
    revision: sent.revision,
    record: sent.record,
  });
});

test("token dependency failures are unavailable and touch no storage", async () => {
  const state = new MemoryStorageState();
  const indication = await seedEditedIndication(state);
  const reviewId = await REVIEW_IDS.reviewIdForCurrentKey(
    await ownerIndicationCurrentStorageKey(indication.id),
    OWNER,
  );
  for (const resolver of [
    {
      async currentKeyForReviewId(): Promise<StorageKey> {
        throw tokenFailure("UNAVAILABLE");
      },
    },
    {
      async currentKeyForReviewId(): Promise<StorageKey> {
        return Object.freeze({
          collection: "investment-indications",
          id: "malformed-private-key",
        }) as StorageKey;
      },
    },
  ] as const) {
    const counted = new CountingStorageAdapter(new MemoryStorageAdapter(state));
    const repository = new StorageOwnerIndicationReviewDetailRepository(
      counted,
      OWNER,
      OWNER,
      AMOUNT,
      resolver,
    );
    const failure = await captureFailure(() => repository.get(reviewId));
    assert.equal(failure.code, "UNAVAILABLE");
    assert.equal(counted.reads, 0);
    assert.equal(counted.lists, 0);
  }
});

async function seedEditedIndication(
  state: MemoryStorageState,
  editCount = 1,
): Promise<InvestmentIndication> {
  const repository = new StorageParticipantInvestmentInterestRepository(
    new MemoryStorageAdapter(state),
    PARTICIPANT,
    AMOUNT,
  );
  let timeOffset = 0;
  const service = createParticipantInvestmentInterestService({
    actorSubject: PARTICIPANT,
    amountConfiguration: AMOUNT,
    reader: repository,
    mutations: repository,
    loadAcknowledgmentContext: () => currentContext(PARTICIPANT),
    loadPermissions: () => ({
      createPersonal: true,
      createCompany: true,
      reactivatePersonal: true,
      reactivateCompany: true,
    }),
    indicationIdForOperation: () =>
      indicationId("investment-indication:owner-detail-target"),
    now: () =>
      new Date(Date.UTC(2026, 7, 12, 10, timeOffset++, 0, 0)),
  });
  const created = await service.create({
    operationId: "investment-operation:owner-detail-create",
    fields: personalFields("Private participant note."),
  });
  let current = created.snapshot;
  for (let index = 1; index <= editCount; index += 1) {
    const edited = await service.edit({
      operationId: `investment-operation:owner-detail-edit-${index}`,
      indicationId: current.id,
      expectedRevision: current.revision,
      fields: personalFields(`Private edited participant note ${index}.`),
    });
    current = edited.snapshot;
  }
  return current;
}

async function rejectIndication(
  state: MemoryStorageState,
  indication: InvestmentIndication,
): Promise<RejectedInvestmentIndication> {
  const result = await new DevelopmentInMemoryIndicationRepository(
    new MemoryStorageAdapter(state),
    OWNER,
    OWNER,
    AMOUNT,
  ).reject({
    operationId: "investment-operation:owner-detail-reject",
    id: indication.id,
    expectedRevision: indication.revision,
    occurredAt: "2026-08-12T12:00:00.000Z",
    historyEntryId: "investment-indication-history-entry:owner-detail-reject",
    reason: "Outside the current review scope.",
  });
  return result.snapshot;
}

async function seedRejectionNotification(
  state: MemoryStorageState,
  indication: RejectedInvestmentIndication,
) {
  const history = indication.history.at(-1);
  assert(history);
  const id = await ownerIndicationRejectionNotificationId(
    "investment-operation:owner-detail-reject",
  );
  const purposeId = await ownerIndicationRejectionNotificationPurposeId(
    "investment-operation:owner-detail-reject",
  );
  const resourceId = parseStableId<"audit-resource">(indication.id);
  assert(resourceId.ok);
  const template = parseManualNotificationTemplate({
    id,
    purposeId,
    recipientSubject: indication.participantSubject,
    relatedResource: {
      type: "investment-indication",
      id: resourceId.value,
    },
    subjectLine: OWNER_INDICATION_REJECTION_NOTIFICATION_SUBJECT,
    body: ownerIndicationRejectionNotificationBody(
      indication.lifecycle.rejection.reason,
    ),
    generatedAt: indication.lifecycle.rejectedAt,
    generatedBy: indication.lifecycle.rejection.rejectedBy,
  });
  assert(template.ok);
  const created = await new DevelopmentInMemoryManualNotificationRepository(
    new MemoryStorageAdapter(state),
  ).create({
    operationId: "notification-operation:owner-detail-rejection",
    template: template.value,
  });
  assert.deepEqual(
    created.record,
    createManualNotificationRecord(template.value),
  );
  return Object.freeze({
    revision: created.revision,
    record: created.record,
  });
}

function detailRepository(
  storage: StorageAdapter,
  ownerSubject: ActorSubject = OWNER,
): StorageOwnerIndicationReviewDetailRepository {
  return new StorageOwnerIndicationReviewDetailRepository(
    storage,
    ownerSubject,
    ownerSubject,
    AMOUNT,
    REVIEW_IDS,
  );
}

function rewriteEveryNotificationTemplate(
  state: MemoryStorageState,
  rewrite: StorageDocument,
): void {
  for (const [identity, stored] of state.records) {
    if (
      stored.key.collection !== "manual-notifications" &&
      stored.key.collection !== "manual-notification-history"
    ) continue;
    const record = stored.value.record;
    assert(record && typeof record === "object" && !Array.isArray(record));
    const recordDocument = record as StorageDocument;
    const template = recordDocument.template;
    assert(
      template && typeof template === "object" && !Array.isArray(template),
    );
    const templateDocument = template as StorageDocument;
    const rewrittenRecord: StorageDocument = Object.freeze({
      ...recordDocument,
      template: Object.freeze({ ...templateDocument, ...rewrite }),
    });
    state.records.set(identity, Object.freeze({
      ...stored,
      value: Object.freeze({
        ...stored.value,
        record: rewrittenRecord,
      }),
    }));
  }
}

function personalFields(note: string) {
  return Object.freeze({
    kind: "personal" as const,
    residenceCountry: "FI",
    amount: 1_250,
    availabilityPeriod: "Within twelve months.",
    note,
  });
}

async function currentContext(
  actor: ActorSubject,
): Promise<TrustedPackageAcknowledgmentContext> {
  const version = await createPackageVersion({
    id: "package-version:owner-indication-detail",
    createdAt: "2026-08-12T08:00:00.000Z",
    changeSummary: "Synthetic package",
    materialChange: false,
    acknowledgmentText: "This indication is non-binding.",
    sections: [{
      id: "package-section:owner-indication-detail",
      order: 0,
      title: "Overview",
      markdown: "Synthetic package.",
      enabled: true,
    }],
  }, null);
  assert(version.ok);
  const accepted = createPackageAcceptance({
    id: "package-acceptance:owner-indication-detail",
    participantSubject: actor,
    acceptedAt: "2026-08-12T09:00:00.000Z",
  }, version.value);
  assert(accepted.ok);
  return Object.freeze({
    currentVersion: version.value,
    latestAcceptance: accepted.value,
  });
}

function amountConfiguration(): AmountConfiguration {
  const parsed = parseAmountAggregateConfiguration({
    amount: {
      currency: "EUR",
      minimum: 1_000,
      increment: 250,
      maximum: 10_000,
    },
    publicAggregate: { visibility: "hidden" },
  });
  assert(parsed.ok);
  return parsed.value.amount;
}

function subject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  assert(parsed.ok);
  return parsed.value;
}

function indicationId(value: string): InvestmentIndicationId {
  const parsed = parseStableId<"investment-indication">(value);
  assert(parsed.ok);
  return parsed.value;
}

async function captureFailure(
  operation: () => Promise<unknown>,
): Promise<StorageFailure> {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof StorageFailure);
    return error;
  }
  assert.fail("Expected StorageFailure.");
}

class CountingStorageAdapter implements StorageAdapter {
  reads = 0;
  lists = 0;
  readonly #delegate: StorageAdapter;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  read: StorageAdapter["read"] = (key) => {
    this.reads += 1;
    return this.#delegate.read(key);
  };

  list: StorageAdapter["list"] = (request) => {
    this.lists += 1;
    return this.#delegate.list(request);
  };

  transact: StorageAdapter["transact"] = (request) =>
    this.#delegate.transact(request);
}

class TestReviewIdResolver implements OwnerIndicationReviewIdResolver {
  async reviewIdForCurrentKey(
    key: StorageKey,
    ownerSubject: ActorSubject,
  ): Promise<string> {
    const payload = btoa(String(key.id))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    return `detail.v1.${payload}.${await tokenTag(key.id, ownerSubject)}`;
  }

  async currentKeyForReviewId(
    value: unknown,
    ownerSubject: ActorSubject,
  ): Promise<StorageKey> {
    if (typeof value !== "string") throw tokenFailure("INVALID_TOKEN");
    const parts = value.split(".");
    if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== "detail.v1") {
      throw tokenFailure("INVALID_TOKEN");
    }
    const encoded = parts[2] ?? "";
    const padding = "=".repeat((4 - encoded.length % 4) % 4);
    const id = atob(
      `${encoded.replaceAll("-", "+").replaceAll("_", "/")}${padding}`,
    );
    if (parts[3] !== await tokenTag(id, ownerSubject)) {
      throw tokenFailure("INVALID_TOKEN");
    }
    const parsed = parseStorageKey("investment-indications", id);
    if (!parsed.ok) throw tokenFailure("INVALID_TOKEN");
    return parsed.value;
  }
}

function tokenFailure(code: "INVALID_TOKEN" | "UNAVAILABLE"): Error {
  return Object.assign(new Error("Owner review token failure."), { code });
}

const REVIEW_IDS = new TestReviewIdResolver();

async function tokenTag(
  keyId: string,
  ownerSubject: ActorSubject,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`owner-detail\u0000${ownerSubject}\u0000${keyId}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
