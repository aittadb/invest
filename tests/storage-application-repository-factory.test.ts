import assert from "node:assert/strict";
import test from "node:test";

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
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";

const CLAIM = replayClaim();
const NOW = new Date("2026-08-10T12:00:00.000Z");

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

  assert.deepEqual(Object.getOwnPropertyNames(
    Object.getPrototypeOf(factory) as object,
  ), [
    "constructor",
    "browserMutationReplayClaimer",
    "campaignRepository",
    "publicCampaignReader",
    "ownerPackageWorkspace",
    "participantRequest",
  ]);
  assert.equal(
    factory.campaignRepository(),
    factory.campaignRepository(),
  );
  assert.equal(
    factory.publicCampaignReader(),
    factory.publicCampaignReader(),
  );
  assert.equal(
    campaignRepository.mutationConsistency,
    "atomic-campaign-audit",
  );
  assert.deepEqual(Reflect.ownKeys(campaignRepository), [
    "mutationConsistency",
  ]);
  assert.deepEqual(Reflect.ownKeys(publicCampaignReader), []);
  assert.deepEqual(Object.values(campaignRepository), [
    "atomic-campaign-audit",
  ]);
  assert.deepEqual(Object.values(publicCampaignReader), []);
  assertNoGenericStorageSurface(campaignRepository, storage);
  assertNoGenericStorageSurface(publicCampaignReader, storage);
  assert.equal("storage" in factory, false);
  assert.equal("create" in factory, false);
  const participantRequest = factory.participantRequest(account.value);
  assert.notEqual(
    factory.participantRequest(account.value),
    participantRequest,
  );
  assert.deepEqual(Object.keys(participantRequest), [
    "participantAccessReader",
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
  assert.throws(
    () => participantRequest.participantPackageReader(foreignSubject.value),
    (error) => storageFailure(error, "UNAVAILABLE"),
  );
  await assert.rejects(
    accessReader.read(foreignAccount.value),
    (error) => storageFailure(error, "UNAVAILABLE"),
  );
  assertNoGenericStorageSurface(participantRequest, storage);
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
