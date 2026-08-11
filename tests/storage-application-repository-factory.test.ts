import assert from "node:assert/strict";
import test from "node:test";

import { parseAmountAggregateConfiguration } from "../domain/amount-aggregate-configuration.ts";
import { parseActorSubject, parseTimestamp } from "../domain/foundation.ts";
import { parseParticipantAccount } from "../domain/participant-profile.ts";
import {
  StorageFailure,
  type StorageAdapter,
  type StoragePage,
  type StorageRecord,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import { StorageApplicationRepositoryFactory } from "../repositories/storage-application-repository-factory.ts";
import { AeadOwnerIndicationReviewTokenBoundary } from "../services/owner-indication-review-tokens.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";

const CLAIM = replayClaim();
const NOW = new Date("2026-08-10T12:00:00.000Z");
const OWNER_REVIEW_TOKENS = new AeadOwnerIndicationReviewTokenBoundary({
  encryptionKey: await ownerReviewEncryptionKey(),
  randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
});

test("first replay claim wins atomically and exact retries return false", async () => {
  const state = new MemoryStorageState();
  const factory = new StorageApplicationRepositoryFactory(
    new MemoryStorageAdapter(state),
    () => NOW,
  );
  const claim = factory.browserMutationReplayClaimer();

  assert.equal(factory.browserMutationReplayClaimer(), claim);
  assert.equal(await claim(CLAIM), true);
  assert.equal(await claim(CLAIM), false);

  const stored = [...state.records.values()];
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0]?.value, {
    schemaVersion: 1,
    expiresAt: CLAIM.expiresAt,
  });
  assert.doesNotMatch(
    JSON.stringify({ records: stored, operations: [...state.operations.values()] }),
    /owner|participant|csrf|cookie|email|credential|token/iu,
  );
});

test("concurrent claims have exactly one winner and survive reconstruction", async () => {
  const state = new MemoryStorageState();
  const firstFactory = new StorageApplicationRepositoryFactory(
    new MemoryStorageAdapter(state),
    () => NOW,
  );
  const results = await Promise.all(
    Array.from(
      { length: 20 },
      () => firstFactory.browserMutationReplayClaimer()(CLAIM),
    ),
  );
  assert.equal(results.filter(Boolean).length, 1);

  const reopened = new StorageApplicationRepositoryFactory(
    new MemoryStorageAdapter(state),
    () => NOW,
  );
  assert.equal(await reopened.browserMutationReplayClaimer()(CLAIM), false);
});

test("malformed claims and malformed adapter results fail closed", async () => {
  const claim = new StorageApplicationRepositoryFactory(
    new MemoryStorageAdapter(),
    () => NOW,
  ).browserMutationReplayClaimer();
  const invalidClaims = [
    null,
    {},
    { ...CLAIM, extra: true },
    { ...CLAIM, capabilityId: "browser-mutation:v1:short" },
    { ...CLAIM, capabilityId: `browser-mutation:v1:${"_".repeat(42)}!` },
    { ...CLAIM, expiresAt: "not-a-timestamp" },
    { ...CLAIM, expiresAt: "2026-08-10T12:00:00.000Z" },
    { ...CLAIM, expiresAt: "2026-08-10T12:10:01.000Z" },
    Object.defineProperty({ expiresAt: CLAIM.expiresAt }, "capabilityId", {
      enumerable: true,
      get() {
        throw new Error("private getter detail");
      },
    }),
  ];
  for (const candidate of invalidClaims) {
    await assert.rejects(
      claim(candidate as typeof CLAIM),
      (error) => storageFailure(error, "INVALID_REQUEST"),
    );
  }

  for (const malformedResult of malformedResults()) {
    const malformed = new StorageApplicationRepositoryFactory(
      resultAdapter(malformedResult),
      () => NOW,
    ).browserMutationReplayClaimer();
    await assert.rejects(
      malformed(CLAIM),
      (error) => storageFailure(error, "UNAVAILABLE"),
    );
  }

  const failedClock = new StorageApplicationRepositoryFactory(
    new MemoryStorageAdapter(),
    () => {
      throw new Error("private clock detail");
    },
  ).browserMutationReplayClaimer();
  await assert.rejects(
    failedClock(CLAIM),
    (error) => storageFailure(error, "UNAVAILABLE"),
  );
});

test("storage conflict is a replay while unavailable storage stays unavailable", async () => {
  const conflicting = new StorageApplicationRepositoryFactory(
    failingAdapter(new StorageFailure("CONFLICT")),
    () => NOW,
  ).browserMutationReplayClaimer();
  assert.equal(await conflicting(CLAIM), false);

  const unavailable = new StorageApplicationRepositoryFactory(
    failingAdapter(new Error("private backend detail")),
    () => NOW,
  ).browserMutationReplayClaimer();
  await assert.rejects(
    unavailable(CLAIM),
    (error) => {
      assert.equal(storageFailure(error, "UNAVAILABLE"), true);
      assert.doesNotMatch(String(error), /private backend detail/u);
      return true;
    },
  );

  const caused = new StorageApplicationRepositoryFactory(
    failingAdapter(new StorageFailure("UNAVAILABLE", {
      cause: new Error("private storage cause"),
    })),
    () => NOW,
  ).browserMutationReplayClaimer();
  await assert.rejects(
    caused(CLAIM),
    (error) => storageFailure(error, "UNAVAILABLE"),
  );
});

test("factory rejects anything other than a complete adapter", () => {
  for (const candidate of [null, {}, { transact() {} }]) {
    assert.throws(
      () => new StorageApplicationRepositoryFactory(
        candidate as unknown as StorageAdapter,
        () => NOW,
      ),
      (error) => storageFailure(error, "INVALID_REQUEST"),
    );
  }
  assert.throws(
    () => new StorageApplicationRepositoryFactory(
      new MemoryStorageAdapter(),
      null as unknown as () => Date,
    ),
    (error) => storageFailure(error, "INVALID_REQUEST"),
  );
});

test("factory exposes only named application repository capabilities", async () => {
  const storage = new MemoryStorageAdapter();
  const factory = new StorageApplicationRepositoryFactory(storage, () => NOW);
  const campaignRepository = factory.campaignRepository();
  const publicCampaignReader = factory.publicCampaignReader();
  const ownerAuditEvents = factory.ownerAuditEvents();
  const publicCampaignStateReader = factory.publicCampaignStateReader();
  const founderReviews = factory.ownerFounderApplicationReviews();
  const ownerManualNotificationActivity =
    factory.ownerManualNotificationActivity();
  const subject = parseActorSubject("issuer.invalid/participant:factory");
  const account = parseParticipantAccount({
    subject: "issuer.invalid/participant:factory",
    accountEmailLabel: "factory@example.test",
  });
  const foreignSubject = parseActorSubject("issuer.invalid/participant:foreign");
  const foreignAccount = parseParticipantAccount({
    subject: "issuer.invalid/participant:foreign",
    accountEmailLabel: "foreign@example.test",
  });
  assert(subject.ok);
  assert(account.ok);
  assert(foreignSubject.ok);
  assert(foreignAccount.ok);
  const ownerIndicationReviews = factory.ownerIndicationReviews(
    subject.value,
    subject.value,
    OWNER_REVIEW_TOKENS,
  );

  assert.deepEqual(Object.getOwnPropertyNames(
    Object.getPrototypeOf(factory) as object,
  ), [
    "constructor",
    "browserMutationReplayClaimer",
    "campaignRepository",
    "publicCampaignReader",
    "publicCampaignStateReader",
    "ownerPackageWorkspace",
    "ownerAuditEvents",
    "ownerIndicationReviews",
    "ownerFounderApplicationReviews",
    "ownerManualNotificationActivity",
    "participantRequest",
    "participantInvestmentRepository",
    "participantRepository",
  ]);
  assert.equal(
    factory.campaignRepository(),
    factory.campaignRepository(),
  );
  assert.equal(
    factory.publicCampaignReader(),
    factory.publicCampaignReader(),
  );
  assert.equal(factory.ownerAuditEvents(), ownerAuditEvents);
  assert.equal(factory.ownerFounderApplicationReviews(), founderReviews);
  assert.equal(
    factory.publicCampaignStateReader(),
    publicCampaignStateReader,
  );
  assert.equal(
    factory.ownerManualNotificationActivity(),
    ownerManualNotificationActivity,
  );
  assert.equal(
    campaignRepository.mutationConsistency,
    "atomic-campaign-audit",
  );
  assert.deepEqual(Reflect.ownKeys(campaignRepository), [
    "mutationConsistency",
  ]);
  assert.deepEqual(Reflect.ownKeys(publicCampaignReader), []);
  assert.deepEqual(Reflect.ownKeys(ownerAuditEvents), []);
  assert.deepEqual(Reflect.ownKeys(publicCampaignStateReader), []);
  assert.deepEqual(Reflect.ownKeys(ownerIndicationReviews), []);
  assert.deepEqual(Reflect.ownKeys(founderReviews), []);
  assert.deepEqual(Reflect.ownKeys(ownerManualNotificationActivity), [
    "storageKind",
    "activityConsistency",
  ]);
  assert.deepEqual(Object.values(campaignRepository), [
    "atomic-campaign-audit",
  ]);
  assert.deepEqual(Object.values(publicCampaignReader), []);
  assert.deepEqual(Object.values(publicCampaignStateReader), []);
  assertNoGenericStorageSurface(campaignRepository, storage);
  assertNoGenericStorageSurface(publicCampaignReader, storage);
  assert.equal(typeof ownerAuditEvents.list, "function");
  assert.equal(Object.isFrozen(ownerAuditEvents), true);
  for (const property of ["adapter", "storage", "read", "transact"]) {
    assert.equal(property in ownerAuditEvents, false, property);
  }
  assert.equal(Object.values(ownerAuditEvents).includes(storage), false);
  assertNoGenericStorageSurface(publicCampaignStateReader, storage);
  assert.equal(typeof ownerIndicationReviews.list, "function");
  assert.equal(Object.isFrozen(ownerIndicationReviews), true);
  for (const property of ["adapter", "storage", "read", "transact", "get"]) {
    assert.equal(property in ownerIndicationReviews, false, property);
  }
  assert.equal(Object.values(ownerIndicationReviews).includes(storage), false);
  assert.equal(typeof founderReviews.list, "function");
  for (const property of ["adapter", "storage", "read", "transact"]) {
    assert.equal(property in founderReviews, false, property);
  }
  assert.equal(Object.values(founderReviews).includes(storage), false);
  assert.deepEqual(Object.values(ownerManualNotificationActivity), [
    "storage-adapter",
    "atomic-notification-audit",
  ]);
  assert.equal(Object.isFrozen(ownerManualNotificationActivity), true);
  for (const property of ["adapter", "storage", "read", "transact"]) {
    assert.equal(property in ownerManualNotificationActivity, false, property);
  }
  assert.equal("storage" in factory, false);
  assert.equal("create" in factory, false);
  const participantRequest = factory.participantRequest(account.value);
  assert.notEqual(
    factory.participantRequest(account.value),
    participantRequest,
  );
  assert.deepEqual(Object.keys(participantRequest), [
    "participantAccessReader",
    "participantProfileRepository",
    "participantPackageReader",
    "participantPackageAcknowledgments",
    "participantFounderApplications",
  ]);
  assert.deepEqual(
    Object.keys(participantRequest.participantPackageReader(subject.value)),
    ["current"],
  );
  const acknowledgment = participantRequest.participantPackageAcknowledgments(
    subject.value,
  );
  assert.deepEqual(Object.keys(acknowledgment), ["packages", "acknowledgments"]);
  assert.deepEqual(Object.keys(acknowledgment.packages), ["current"]);
  assert.deepEqual(
    Object.keys(acknowledgment.acknowledgments),
    ["get", "latest", "record"],
  );
  const accessReader = participantRequest.participantAccessReader();
  assert.equal(participantRequest.participantAccessReader(), accessReader);
  assert.deepEqual(Object.keys(accessReader), ["read"]);
  assert.equal(Object.isFrozen(accessReader), true);
  const profileRepository = participantRequest.participantProfileRepository();
  assert.equal(
    participantRequest.participantProfileRepository(),
    profileRepository,
  );
  assert.deepEqual(Object.keys(profileRepository), ["storageKind"]);
  assert.equal(Object.values(profileRepository).includes(storage), false);
  assert.throws(
    () => participantRequest.participantPackageReader(foreignSubject.value),
    (error) => storageFailure(error, "UNAVAILABLE"),
  );
  await assert.rejects(
    accessReader.read(foreignAccount.value),
    (error) => storageFailure(error, "UNAVAILABLE"),
  );
  assertNoGenericStorageSurface(participantRequest, storage);
  const amount = parseAmountAggregateConfiguration({
    amount: {
      currency: "EUR",
      minimum: 1_000,
      increment: 250,
      maximum: 10_000,
    },
    publicAggregate: { visibility: "hidden" },
  });
  assert(amount.ok);
  const investment = factory.participantInvestmentRepository(
    subject.value,
    amount.value.amount,
  );
  assert.notEqual(
    factory.participantInvestmentRepository(subject.value, amount.value.amount),
    investment,
  );
  assert.deepEqual(Object.keys(investment), ["mutationConsistency"]);
  assert.equal(
    investment.mutationConsistency,
    "atomic-indication-aggregate-audit",
  );
  assertNoGenericStorageSurface(investment, storage);
  const participant = factory.participantRepository(account.value);
  assert.notEqual(
    factory.participantRepository(account.value),
    participant,
  );
  assert.deepEqual(Object.keys(participant), ["storageKind"]);
  assert.equal(
    (participant as typeof participant & { storageKind?: unknown }).storageKind,
    "storage-adapter",
  );
  assert.doesNotMatch(
    Object.getOwnPropertyNames(Object.getPrototypeOf(factory)).join(" "),
    /adapter|storage|create/iu,
  );
  assert.equal(Object.isFrozen(factory), true);
  assert.deepEqual(JSON.parse(JSON.stringify(factory)), {});
});

function assertNoGenericStorageSurface(
  capability: object,
  storage: StorageAdapter,
): void {
  for (const property of ["adapter", "storage", "read", "list", "transact"]) {
    assert.equal(property in capability, false, property);
    assert.equal(Reflect.ownKeys(capability).includes(property), false, property);
  }
  assert.equal(Object.values(capability).includes(storage), false);
  assert.doesNotMatch(JSON.stringify(capability), /adapter|storage|transact/iu);
}

async function ownerReviewEncryptionKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from({ length: 32 }, (_, index) => (102 + index * 17) % 256),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function replayClaim() {
  const expiresAt = parseTimestamp("2026-08-10T12:05:00.000Z");
  if (!expiresAt.ok) throw new Error("Invalid replay fixture timestamp.");
  return Object.freeze({
    capabilityId: `browser-mutation:v1:${"A".repeat(43)}`,
    expiresAt: expiresAt.value,
  });
}

function resultAdapter(result: unknown): StorageAdapter {
  return Object.freeze({
    async read(): Promise<StorageRecord | null> {
      return null;
    },
    async list(): Promise<StoragePage> {
      return { items: [], nextCursor: null };
    },
    async transact(): Promise<StorageTransactionResult> {
      return result as StorageTransactionResult;
    },
  });
}

function malformedResults(): readonly unknown[] {
  const validRecord = {
    key: {
      collection: "browser-mutation-replays",
      id: CLAIM.capabilityId,
    },
    revision: 1,
    value: { schemaVersion: 1, expiresAt: CLAIM.expiresAt },
  };
  return [
    null,
    {},
    { replayed: false, records: [] },
    { replayed: false, records: [validRecord], extra: true },
    { replayed: false, records: [{ ...validRecord, extra: true }] },
    {
      replayed: false,
      records: [{ ...validRecord, key: { ...validRecord.key, extra: true } }],
    },
    {
      replayed: false,
      records: [{
        ...validRecord,
        value: { ...validRecord.value, extra: true },
      }],
    },
    { replayed: "false", records: [validRecord] },
  ];
}

function failingAdapter(failure: unknown): StorageAdapter {
  return Object.freeze({
    async read(): Promise<StorageRecord | null> {
      return null;
    },
    async list(): Promise<StoragePage> {
      return { items: [], nextCursor: null };
    },
    async transact(): Promise<StorageTransactionResult> {
      throw failure;
    },
  });
}

function storageFailure(error: unknown, code: StorageFailure["code"]): boolean {
  return error instanceof StorageFailure &&
    error.code === code &&
    error.cause === undefined;
}
