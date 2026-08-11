import assert from "node:assert/strict";
import test from "node:test";

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
import type {
  InvestmentIndication,
  InvestmentIndicationId,
  TrustedPackageAcknowledgmentContext,
} from "../domain/investment-indication.ts";
import { INVESTMENT_INDICATION_LIMITS } from "../domain/investment-indication.ts";
import {
  createPackageAcceptance,
  createPackageVersion,
} from "../domain/package-content.ts";
import {
  StorageFailure,
  parseStorageKey,
  parseStorageOperationId,
  type StorageAdapter,
  type StorageDocument,
  type StorageKey,
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import { DevelopmentInMemoryAggregateRepository } from "../repositories/in-memory-aggregate-repository.ts";
import {
  DevelopmentInMemoryAuditRepository,
  DevelopmentInMemoryManualNotificationRepository,
} from "../repositories/in-memory-audit-notification-repositories.ts";
import { ownerIndicationCurrentStorageKey } from "../repositories/in-memory-indication-repository.ts";
import {
  StorageOwnerIndicationRejectionRepository,
  type OwnerIndicationReviewIdResolver,
} from "../repositories/storage-owner-indication-rejection-repository.ts";
import {
  StorageParticipantInvestmentInterestRepository,
  initializeParticipantInvestmentOwnership,
} from "../repositories/storage-participant-investment-repository.ts";
import type { RejectIndicationWithEffectsRequest } from "../services/owner-indication-moderation.ts";
import { createParticipantInvestmentInterestService } from "../worker/investment-interest-service.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";

const OWNER = subject("issuer.invalid/owner:rejection");
const FOREIGN_OWNER = subject("issuer.invalid/owner:foreign-rejection");
const PARTICIPANT = subject("issuer.invalid/participant:rejection");
const AMOUNT = amountConfiguration();
const FIRST_TIME = timestamp("2026-08-12T12:00:00.000Z");
const RETRY_TIME = timestamp("2026-08-12T13:00:00.000Z");

test("owner rejection persists every effect once and replays across restart", async () => {
  const state = new MemoryStorageState();
  const seeded = await seedActiveIndication(state);
  const repository = rejectionRepository(new MemoryStorageAdapter(state));
  const request = await rejectionRequest(seeded.indication);

  const rejected = await repository.rejectWithEffects(request);
  assert.equal(rejected.replayed, false);
  assert.equal(rejected.item.indication.lifecycle.status, "rejected");
  assert.equal(
    rejected.item.indication.lifecycle.rejection.reason,
    "Outside the current review scope.",
  );
  assert.deepEqual(rejected.aggregate.stored, {
    revision: 2,
    totalAmount: 0,
    currency: "EUR",
    contributingIndicationCount: 0,
  });
  assert.equal(rejected.notification.revision, 1);
  assert.equal(
    rejected.notification.record.template.recipientSubject,
    PARTICIPANT,
  );
  assert.equal(rejected.auditEvent.detail.kind, "resource-transition");

  const reopenedParticipant = new StorageParticipantInvestmentInterestRepository(
    new MemoryStorageAdapter(state),
    PARTICIPANT,
    AMOUNT,
  );
  const persisted = await reopenedParticipant.get(seeded.indication.id);
  assert.equal(persisted?.lifecycle.status, "rejected");
  assert.equal(
    (await new DevelopmentInMemoryAggregateRepository(
      new MemoryStorageAdapter(state),
      AMOUNT.currency,
    ).readStored()).totalAmount,
    0,
  );
  assert.deepEqual(
    await new DevelopmentInMemoryAuditRepository(
      new MemoryStorageAdapter(state),
    ).get(rejected.auditEvent.id),
    rejected.auditEvent,
  );
  assert.deepEqual(
    await new DevelopmentInMemoryManualNotificationRepository(
      new MemoryStorageAdapter(state),
    ).get(rejected.notification.record.template.id),
    rejected.notification,
  );

  const replay = await rejectionRepository(
    new MemoryStorageAdapter(state),
  ).rejectWithEffects(Object.freeze({ ...request, occurredAt: RETRY_TIME }));
  assert.equal(replay.replayed, true);
  assert.equal(
    replay.item.indication.lifecycle.rejection.rejectedAt,
    FIRST_TIME,
  );
  assert.deepEqual(replay.aggregate, rejected.aggregate);
  assert.deepEqual(replay.auditEvent, rejected.auditEvent);
  assert.deepEqual(replay.notification, rejected.notification);
  assert.equal(recordsIn(state, "manual-notifications"), 1);
  assert.equal(recordsIn(state, "manual-notification-history"), 1);
  assert.equal(recordsIn(state, "owner-indication-moderation-operations"), 1);

  const changed = await captureFailure(() =>
    rejectionRepository(new MemoryStorageAdapter(state)).rejectWithEffects(
      Object.freeze({
        ...request,
        occurredAt: RETRY_TIME,
        reason: "A changed retry must not adopt prior work.",
      }),
    )
  );
  assert.equal(changed.code, "CONFLICT");
  assert.equal(recordsIn(state, "investment-indication-history"), 2);
  assert.equal(recordsIn(state, "audit-events"), 2);
});

test("concurrent exact rejection has one commit and two stable results", async () => {
  const state = new MemoryStorageState();
  const seeded = await seedActiveIndication(state);
  const request = await rejectionRequest(seeded.indication);
  const [first, second] = await Promise.all([
    rejectionRepository(new MemoryStorageAdapter(state)).rejectWithEffects(
      request,
    ),
    rejectionRepository(new MemoryStorageAdapter(state)).rejectWithEffects(
      Object.freeze({ ...request, occurredAt: RETRY_TIME }),
    ),
  ]);

  assert.deepEqual(
    [first.replayed, second.replayed].sort(),
    [false, true],
  );
  assert.equal(
    first.item.indication.lifecycle.rejection.rejectedAt,
    second.item.indication.lifecycle.rejection.rejectedAt,
  );
  assert.deepEqual(first.aggregate, second.aggregate);
  assert.deepEqual(first.auditEvent, second.auditEvent);
  assert.deepEqual(first.notification, second.notification);
  assert.equal(recordsIn(state, "investment-indication-history"), 2);
  assert.equal(recordsIn(state, "manual-notifications"), 1);
  assert.equal(recordsIn(state, "audit-events"), 2);
});

test("stale, crossed, malformed, and foreign rejection requests change nothing", async () => {
  const state = new MemoryStorageState();
  const seeded = await seedActiveIndication(state);
  const baseline = checkpoint(state);
  const request = await rejectionRequest(seeded.indication);

  const stale = await captureFailure(() =>
    rejectionRepository(new MemoryStorageAdapter(state)).rejectWithEffects(
      Object.freeze({
        ...request,
        operationId: operationId("owner-rejection:stale"),
        expectedRevision: 2,
      }),
    )
  );
  assert.equal(stale.code, "PRECONDITION_FAILED");

  const otherId = indicationId("investment-indication:crossed-review");
  const crossedReviewId = await reviewIdForIndication(otherId);
  const crossed = await captureFailure(() =>
    rejectionRepository(new MemoryStorageAdapter(state)).rejectWithEffects(
      Object.freeze({
        ...request,
        operationId: operationId("owner-rejection:crossed"),
        reviewId: crossedReviewId,
      }),
    )
  );
  assert.equal(crossed.code, "NOT_FOUND");

  const tamperedReviewId = `${request.reviewId.slice(0, -1)}${
    request.reviewId.endsWith("0") ? "1" : "0"
  }`;
  const tampered = await captureFailure(() =>
    rejectionRepository(new MemoryStorageAdapter(state)).rejectWithEffects(
      Object.freeze({
        ...request,
        operationId: operationId("owner-rejection:tampered-review"),
        reviewId: tamperedReviewId,
      }),
    )
  );
  assert.equal(tampered.code, "NOT_FOUND");

  const oversizedReview = await captureFailure(() =>
    rejectionRepository(new MemoryStorageAdapter(state)).rejectWithEffects(
      Object.freeze({
        ...request,
        operationId: operationId("owner-rejection:oversized-review"),
        reviewId: "x".repeat(193),
      }),
    )
  );
  assert.equal(oversizedReview.code, "INVALID_REQUEST");

  const wrongOwner = await captureFailure(() =>
    rejectionRepository(new MemoryStorageAdapter(state)).rejectWithEffects(
      Object.freeze({
        ...request,
        operationId: operationId("owner-rejection:wrong-owner"),
        ownerSubject: FOREIGN_OWNER,
      }),
    )
  );
  assert.equal(wrongOwner.code, "NOT_FOUND");

  for (const [suffix, reason] of [
    ["empty", ""],
    ["unsafe", "private\u202ereason"],
    [
      "oversized",
      "x".repeat(INVESTMENT_INDICATION_LIMITS.rejectionReasonLength + 1),
    ],
  ] as const) {
    const malformed = await captureFailure(() =>
      rejectionRepository(new MemoryStorageAdapter(state)).rejectWithEffects(
        Object.freeze({
          ...request,
          operationId: operationId(`owner-rejection:${suffix}`),
          reason,
        }),
      )
    );
    assert.equal(malformed.code, "INVALID_REQUEST");
    assert.doesNotMatch(String(malformed), /private|reason|participant/iu);
  }

  const extraField = await captureFailure(() =>
    rejectionRepository(new MemoryStorageAdapter(state)).rejectWithEffects({
      ...request,
      operationId: operationId("owner-rejection:extra-field"),
      privateValue: "must not be retained",
    } as unknown as RejectIndicationWithEffectsRequest)
  );
  assert.equal(extraField.code, "INVALID_REQUEST");
  assert.doesNotMatch(String(extraField), /private|retained/iu);

  const counted = new CountingStorageAdapter(new MemoryStorageAdapter(state));
  const foreignRepository = new StorageOwnerIndicationRejectionRepository(
    counted,
    FOREIGN_OWNER,
    OWNER,
    AMOUNT,
    REVIEW_IDS,
  );
  const foreign = await captureFailure(() =>
    foreignRepository.rejectWithEffects(request)
  );
  assert.equal(foreign.code, "NOT_FOUND");
  assert.equal(counted.reads, 0);
  assert.equal(counted.transactions, 0);
  assert.deepEqual(checkpoint(state), baseline);
});

test("transaction failure rolls back indication, aggregate, audit, notification, and receipt", async () => {
  const state = new MemoryStorageState();
  const seeded = await seedActiveIndication(state);
  const baseline = checkpoint(state);
  const failing = new FailTransactionStorageAdapter(
    new MemoryStorageAdapter(state),
  );
  const request = await rejectionRequest(seeded.indication);

  const failed = await captureFailure(() =>
    rejectionRepository(failing).rejectWithEffects(request)
  );
  assert.equal(failed.code, "UNAVAILABLE");
  assert.deepEqual(checkpoint(state), baseline);

  const recovered = await rejectionRepository(
    new MemoryStorageAdapter(state),
  ).rejectWithEffects(request);
  assert.equal(recovered.replayed, false);
  assert.equal(recovered.item.indication.lifecycle.status, "rejected");
});

test("commit-response loss and malformed final evidence recover from the immutable receipt", async (context) => {
  for (const candidate of [
    {
      name: "commit response loss",
      adapter(delegate: StorageAdapter): StorageAdapter {
        return new CommitThenThrowStorageAdapter(delegate);
      },
    },
    {
      name: "reversed transaction evidence",
      adapter(delegate: StorageAdapter): StorageAdapter {
        return new ReverseResultStorageAdapter(delegate);
      },
    },
  ] as const) {
    await context.test(candidate.name, async () => {
      const state = new MemoryStorageState();
      const seeded = await seedActiveIndication(state);
      const request = await rejectionRequest(
        seeded.indication,
        candidate.name.replaceAll(" ", "-"),
      );
      const first = await captureFailure(() =>
        rejectionRepository(
          candidate.adapter(new MemoryStorageAdapter(state)),
        ).rejectWithEffects(request)
      );
      assert.equal(first.code, "UNAVAILABLE");

      const replay = await rejectionRepository(
        new MemoryStorageAdapter(state),
      ).rejectWithEffects(Object.freeze({
        ...request,
        occurredAt: RETRY_TIME,
      }));
      assert.equal(replay.replayed, true);
      assert.equal(replay.item.indication.lifecycle.status, "rejected");
      assert.equal(recordsIn(state, "owner-indication-moderation-operations"), 1);
      assert.equal(recordsIn(state, "manual-notifications"), 1);
    });
  }
});

test("persisted-effect corruption after a matching receipt is fixed unavailable without writes", async (context) => {
  const corruptions = [
    {
      name: "zero aggregate revision in receipt",
      apply(state: MemoryStorageState): void {
        replaceStoredValue(
          state,
          "owner-indication-moderation-operations",
          () => true,
          (value) => ({
            ...value,
            aggregate: {
              ...requiredDocument(value.aggregate),
              revision: 0,
            },
          }),
        );
      },
    },
    {
      name: "crossed indication operation evidence",
      apply(state: MemoryStorageState): void {
        replaceStoredValue(
          state,
          "investment-indication-history",
          (value) => value.transitionKind === "rejected",
          (value) => ({
            ...value,
            operationId: "owner-rejection:crossed-indication",
          }),
        );
      },
    },
    {
      name: "crossed aggregate operation evidence",
      apply(state: MemoryStorageState): void {
        replaceStoredValue(
          state,
          "investment-aggregate-operations",
          isRejectionAggregateOperation,
          (value) => ({ ...value, operationKind: "correction" }),
        );
      },
    },
    {
      name: "changed aggregate operation evidence",
      apply(state: MemoryStorageState): void {
        replaceStoredValue(
          state,
          "investment-aggregate-operations",
          isRejectionAggregateOperation,
          (value) => ({
            ...value,
            operationFingerprint: `sha256:${"0".repeat(64)}`,
          }),
        );
      },
    },
    {
      name: "missing audit evidence",
      apply(state: MemoryStorageState): void {
        deleteStoredRecord(
          state,
          "audit-events",
          (value) => auditTransition(value) === "rejected",
        );
      },
    },
    {
      name: "corrupt audit evidence",
      apply(state: MemoryStorageState): void {
        replaceStoredValue(
          state,
          "audit-events",
          (value) => auditTransition(value) === "rejected",
          (value) => {
            const event = requiredDocument(value.event);
            return {
              ...value,
              event: {
                ...event,
                detail: {
                  ...requiredDocument(event.detail),
                  transition: "withdrawn",
                },
              },
            };
          },
        );
      },
    },
    {
      name: "missing notification evidence",
      apply(state: MemoryStorageState): void {
        deleteStoredRecord(
          state,
          "manual-notification-history",
          () => true,
        );
      },
    },
    {
      name: "corrupt notification evidence",
      apply(state: MemoryStorageState): void {
        replaceStoredValue(
          state,
          "manual-notification-history",
          () => true,
          (value) => {
            const record = requiredDocument(value.record);
            return {
              ...value,
              record: {
                ...record,
                template: {
                  ...requiredDocument(record.template),
                  body: "Private corrupt notification evidence.",
                },
              },
            };
          },
        );
      },
    },
  ] as const;

  for (const corruption of corruptions) {
    await context.test(corruption.name, async () => {
      const state = new MemoryStorageState();
      const seeded = await seedActiveIndication(state);
      const request = await rejectionRequest(
        seeded.indication,
        corruption.name.replaceAll(" ", "-"),
      );
      await rejectionRepository(new MemoryStorageAdapter(state))
        .rejectWithEffects(request);
      corruption.apply(state);
      const unchanged = serializedState(state);
      const counted = new CountingStorageAdapter(new MemoryStorageAdapter(state));

      const failure = await captureFailure(() =>
        rejectionRepository(counted).rejectWithEffects(Object.freeze({
          ...request,
          occurredAt: RETRY_TIME,
        }))
      );

      assert.equal(failure.code, "UNAVAILABLE");
      assert.equal(
        String(failure),
        "StorageFailure: Storage is temporarily unavailable.",
      );
      assert.equal(failure.cause, undefined);
      assert.doesNotMatch(
        JSON.stringify({ name: failure.name, message: failure.message }),
        /participant|private|receipt|aggregate|audit|notification/iu,
      );
      assert.equal(counted.transactions, 0);
      assert.equal(serializedState(state), unchanged);
    });
  }
});

test("changed retry identity remains conflict when persisted effects are corrupt", async () => {
  const state = new MemoryStorageState();
  const seeded = await seedActiveIndication(state);
  const request = await rejectionRequest(seeded.indication, "changed-corrupt");
  await rejectionRepository(new MemoryStorageAdapter(state)).rejectWithEffects(
    request,
  );
  deleteStoredRecord(
    state,
    "manual-notification-history",
    () => true,
  );
  const unchanged = serializedState(state);
  const counted = new CountingStorageAdapter(new MemoryStorageAdapter(state));

  const failure = await captureFailure(() =>
    rejectionRepository(counted).rejectWithEffects(Object.freeze({
      ...request,
      occurredAt: RETRY_TIME,
      reason: "A genuinely changed retry.",
    }))
  );

  assert.equal(failure.code, "CONFLICT");
  assert.equal(counted.transactions, 0);
  assert.equal(serializedState(state), unchanged);
});

test("outer rejection transaction stays bounded and contains every effect", async () => {
  const state = new MemoryStorageState();
  const seeded = await seedActiveIndication(state);
  const recording = new RecordingStorageAdapter(new MemoryStorageAdapter(state));
  await rejectionRepository(recording).rejectWithEffects(
    await rejectionRequest(seeded.indication, "bounded"),
  );
  const transaction = recording.lastTransaction;
  assert(transaction);
  assert.ok(transaction.mutations.length <= 25);
  const collections = new Set<string>(
    transaction.mutations.map((mutation) => String(mutation.key.collection)),
  );
  for (const expected of [
    "investment-indications",
    "investment-indication-history",
    "investment-aggregate-states",
    "investment-aggregate-contributions",
    "investment-aggregate-operations",
    "audit-events",
    "manual-notifications",
    "manual-notification-history",
    "owner-indication-moderation-operations",
  ]) {
    assert.equal(collections.has(expected), true, expected);
  }
});

async function seedActiveIndication(
  state: MemoryStorageState,
): Promise<Readonly<{ indication: InvestmentIndication }>> {
  const storage = new MemoryStorageAdapter(state);
  await initializeParticipantInvestmentOwnership(storage, PARTICIPANT, {
    operationId: "investment-ownership-initialization:owner-rejection-fixture",
    indications: [],
  });
  const repository = new StorageParticipantInvestmentInterestRepository(
    storage,
    PARTICIPANT,
    AMOUNT,
  );
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
      indicationId("investment-indication:owner-rejection-target"),
    now: () => new Date("2026-08-12T10:00:00.000Z"),
  });
  const created = await service.create({
    operationId: "investment-operation:owner-rejection-seed",
    fields: {
      kind: "personal",
      residenceCountry: "FI",
      amount: 1_250,
      availabilityPeriod: "Within twelve months.",
      note: "Private participant note.",
    },
  });
  return Object.freeze({ indication: created.snapshot });
}

function rejectionRepository(
  storage: StorageAdapter,
): StorageOwnerIndicationRejectionRepository {
  return new StorageOwnerIndicationRejectionRepository(
    storage,
    OWNER,
    OWNER,
    AMOUNT,
    REVIEW_IDS,
  );
}

async function rejectionRequest(
  indication: InvestmentIndication,
  suffix = "primary",
): Promise<RejectIndicationWithEffectsRequest> {
  return Object.freeze({
    reviewId: await reviewIdForIndication(indication.id),
    indicationId: indication.id,
    operationId: operationId(`owner-rejection:${suffix}`),
    expectedRevision: indication.revision,
    reason: "Outside the current review scope.",
    ownerSubject: OWNER,
    occurredAt: FIRST_TIME,
  });
}

async function reviewIdForIndication(
  id: InvestmentIndicationId,
): Promise<string> {
  return REVIEW_IDS.reviewIdForCurrentKey(
    await ownerIndicationCurrentStorageKey(id),
    OWNER,
  );
}

async function currentContext(
  actor: ActorSubject,
): Promise<TrustedPackageAcknowledgmentContext> {
  const version = await createPackageVersion({
    id: "package-version:owner-rejection",
    createdAt: "2026-08-12T08:00:00.000Z",
    changeSummary: "Synthetic package",
    materialChange: false,
    acknowledgmentText: "This indication is non-binding.",
    sections: [{
      id: "package-section:owner-rejection",
      order: 0,
      title: "Overview",
      markdown: "Synthetic package.",
      enabled: true,
    }],
  }, null);
  assert(version.ok);
  const accepted = createPackageAcceptance({
    id: "package-acceptance:owner-rejection",
    participantSubject: actor,
    acceptedAt: "2026-08-12T09:00:00.000Z",
  }, version.value);
  assert(accepted.ok);
  return Object.freeze({
    currentVersion: version.value,
    latestAcceptance: accepted.value,
  });
}

function checkpoint(state: MemoryStorageState) {
  return Object.freeze({
    records: state.records.size,
    operations: state.operations.size,
    indicationHistory: recordsIn(state, "investment-indication-history"),
    aggregate: recordsIn(state, "investment-aggregate-states"),
    audit: recordsIn(state, "audit-events"),
    notifications: recordsIn(state, "manual-notifications"),
    notificationHistory: recordsIn(state, "manual-notification-history"),
    receipts: recordsIn(state, "owner-indication-moderation-operations"),
  });
}

function recordsIn(state: MemoryStorageState, collection: string): number {
  return [...state.records.values()].filter(
    (record) => record.key.collection === collection,
  ).length;
}

function replaceStoredValue(
  state: MemoryStorageState,
  collection: string,
  matches: (value: StorageDocument) => boolean,
  replace: (value: StorageDocument) => StorageDocument,
): void {
  const [stateKey, record] = matchingStoredRecord(state, collection, matches);
  state.records.set(stateKey, Object.freeze({
    ...record,
    value: Object.freeze(replace(record.value)),
  }));
}

function deleteStoredRecord(
  state: MemoryStorageState,
  collection: string,
  matches: (value: StorageDocument) => boolean,
): void {
  const [stateKey] = matchingStoredRecord(state, collection, matches);
  state.records.delete(stateKey);
}

function matchingStoredRecord(
  state: MemoryStorageState,
  collection: string,
  matches: (value: StorageDocument) => boolean,
): readonly [string, StorageRecord] {
  const candidates = [...state.records.entries()].filter(([, record]) =>
    record.key.collection === collection && matches(record.value)
  );
  assert.equal(candidates.length, 1, collection);
  return candidates[0];
}

function requiredDocument(value: unknown): StorageDocument {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as StorageDocument;
}

function auditTransition(value: StorageDocument): unknown {
  return requiredDocument(requiredDocument(value.event).detail).transition;
}

function isRejectionAggregateOperation(value: StorageDocument): boolean {
  return requiredDocument(requiredDocument(value.result).stored).revision === 2;
}

function serializedState(state: MemoryStorageState): string {
  return JSON.stringify({
    records: [...state.records.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    ),
    operations: [...state.operations.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    ),
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

function operationId(value: string) {
  const parsed = parseStorageOperationId(value);
  assert(parsed.ok);
  return parsed.value;
}

function timestamp(value: string): Timestamp {
  const parsed = parseTimestamp(value);
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
  transactions = 0;
  readonly #delegate: StorageAdapter;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  read: StorageAdapter["read"] = (key) => {
    this.reads += 1;
    return this.#delegate.read(key);
  };
  list: StorageAdapter["list"] = (request) => this.#delegate.list(request);
  transact: StorageAdapter["transact"] = (request) => {
    this.transactions += 1;
    return this.#delegate.transact(request);
  };
}

class FailTransactionStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  read: StorageAdapter["read"] = (key) => this.#delegate.read(key);
  list: StorageAdapter["list"] = (request) => this.#delegate.list(request);
  async transact(): Promise<StorageTransactionResult> {
    throw new StorageFailure("UNAVAILABLE");
  }
}

class CommitThenThrowStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  #failed = false;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  read: StorageAdapter["read"] = (key) => this.#delegate.read(key);
  list: StorageAdapter["list"] = (request) => this.#delegate.list(request);
  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    const result = await this.#delegate.transact(request);
    if (!this.#failed) {
      this.#failed = true;
      throw new StorageFailure("UNAVAILABLE");
    }
    return result;
  }
}

class ReverseResultStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  #changed = false;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  read: StorageAdapter["read"] = (key) => this.#delegate.read(key);
  list: StorageAdapter["list"] = (request) => this.#delegate.list(request);
  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    const result = await this.#delegate.transact(request);
    if (this.#changed) return result;
    this.#changed = true;
    return Object.freeze({
      replayed: result.replayed,
      records: Object.freeze([...result.records].reverse()),
    });
  }
}

class RecordingStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  lastTransaction: StorageTransactionRequest | null = null;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  read: StorageAdapter["read"] = (key) => this.#delegate.read(key);
  list: StorageAdapter["list"] = (request) => this.#delegate.list(request);
  transact: StorageAdapter["transact"] = (request) => {
    this.lastTransaction = request;
    return this.#delegate.transact(request);
  };
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
    return `test.v1.${payload}.${await testReviewTag(key.id, ownerSubject)}`;
  }

  async currentKeyForReviewId(
    value: unknown,
    ownerSubject: ActorSubject,
  ): Promise<StorageKey> {
    if (typeof value !== "string") throw new Error("invalid token");
    const parts = value.split(".");
    if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== "test.v1") {
      throw new Error("invalid token");
    }
    const encoded = parts[2] ?? "";
    const padding = "=".repeat((4 - encoded.length % 4) % 4);
    const id = atob(
      `${encoded.replaceAll("-", "+").replaceAll("_", "/")}${padding}`,
    );
    if (parts[3] !== await testReviewTag(id, ownerSubject)) {
      throw new Error("invalid token");
    }
    const parsed = parseStorageKey("investment-indications", id);
    if (!parsed.ok) throw new Error("invalid token");
    return parsed.value;
  }
}

const REVIEW_IDS = new TestReviewIdResolver();

async function testReviewTag(
  keyId: string,
  ownerSubject: ActorSubject,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`test-review\u0000${ownerSubject}\u0000${keyId}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
