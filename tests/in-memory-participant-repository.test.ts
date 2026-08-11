import assert from "node:assert/strict";
import test from "node:test";

import { toStorageProtocolTransactionCommand } from "../domain/aittadb-storage-protocol.ts";
import {
  isParticipantProfileDescendantProjection,
  parseParticipantAccount,
  type ParticipantAccount,
} from "../domain/participant-profile.ts";
import {
  StorageFailure,
  assertStorageListBoundary,
  assertStorageTransactionBoundary,
  storageKeyString,
  toPublicStorageFailure,
  type StorageAdapter,
  type StorageCursor,
  type StorageDocument,
  type StorageKey,
  type StoragePage,
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import {
  DevelopmentInMemoryParticipantRepository,
  StorageParticipantRepository,
  type ParticipantRegistrationRepository,
  type ParticipantRepository,
  type RegisterParticipantRequest,
  type RequestParticipantDeletionRequest,
  type UpdateParticipantRequest,
  type WithdrawMarketingConsentRequest,
} from "../repositories/in-memory-participant-repository.ts";
import { testParticipantRegistrationNoticeEvidence } from "./support/participant-registration-notice-evidence.ts";

const REGISTERED_AT = "2026-08-09T08:00:00.000Z";
const UPDATED_AT = "2026-08-09T09:00:00.000Z";
const CONSENT_WITHDRAWN_AT = "2026-08-09T10:00:00.000Z";
const DELETION_REQUESTED_AT = "2026-08-09T11:00:00.000Z";

export type ParticipantRepositoryContractFixture = Readonly<{
  participant: ParticipantRegistrationRepository;
  outsider: ParticipantRegistrationRepository;
  anonymous: ParticipantRegistrationRepository;
  reopenParticipant: () => ParticipantRegistrationRepository;
}>;

export type ParticipantRepositoryContractFactory =
  () => ParticipantRepositoryContractFixture;

/** Reusable behavior contract for development and production profile repositories. */
export async function verifyParticipantRepositoryContract(
  createFixture: ParticipantRepositoryContractFactory,
): Promise<void> {
  const fixture = createFixture();
  assert.equal(await fixture.participant.current(), null);
  assert.equal(await fixture.participant.pendingDeletionIntent(), null);

  const registration = registerRequest(
    "participant-operation:contract-register",
    profileRegistration(),
  );
  const first = await fixture.participant.register(registration);
  assert.equal(first.revision, 1);
  assert.equal(first.replayed, false);
  assert.deepEqual(first.intents, []);
  assert.equal(first.snapshot.subject, aliceAccount().subject);
  assert.equal(first.snapshot.accountEmailLabel, "alice@example.test");
  assert.deepEqual(first.snapshot.marketingConsent, {
    state: "granted",
    grantedAt: REGISTERED_AT,
  });

  const updated = await fixture.participant.update(updateRequest(
    "participant-operation:contract-update",
    1,
    { displayName: "Alice Updated", country: "se" },
  ));
  assert.equal(updated.revision, 2);
  assert.equal(updated.snapshot.displayName, "Alice Updated");
  assert.equal(updated.snapshot.country, "SE");

  const withdrawn = await fixture.participant.withdrawMarketingConsent(
    withdrawRequest("participant-operation:contract-consent", 2),
  );
  assert.equal(withdrawn.revision, 3);
  assert.deepEqual(withdrawn.snapshot.marketingConsent, {
    state: "withdrawn",
    grantedAt: REGISTERED_AT,
    withdrawnAt: CONSENT_WITHDRAWN_AT,
  });

  const deletion = await fixture.participant.requestAccountDeletion(
    deletionRequest("participant-operation:contract-deletion", 3),
  );
  assert.equal(deletion.revision, 4);
  assert.deepEqual(deletion.intents, [
    {
      type: "withdraw-active-interest",
      subject: aliceAccount().subject,
      reason: "account-deletion-request",
      requestedAt: DELETION_REQUESTED_AT,
    },
  ]);

  const reopened = fixture.reopenParticipant();
  assert.deepEqual(await reopened.current(), {
    revision: 4,
    snapshot: deletion.snapshot,
  });
  assert.deepEqual(
    await reopened.pendingDeletionIntent(),
    deletion.intents[0],
  );

  assert.equal(await fixture.outsider.current(), null);
  assert.equal(await fixture.outsider.pendingDeletionIntent(), null);
  assert.equal(await fixture.anonymous.current(), null);
  assert.equal(await fixture.anonymous.pendingDeletionIntent(), null);
}

test("storage participant repository passes the participant contract", async () => {
  await verifyParticipantRepositoryContract(() => {
    const state = new MemoryStorageState();
    const storage = new DeterministicMemoryStorageAdapter(state, true);
    return {
      participant: new StorageParticipantRepository(
        storage,
        aliceAccount(),
      ),
      outsider: new StorageParticipantRepository(
        storage,
        bobAccount(),
      ),
      anonymous: new StorageParticipantRepository(storage, null),
      reopenParticipant: () => new StorageParticipantRepository(
        storage,
        aliceAccount(),
      ),
    };
  });
});

test("snapshots are immutable and only policy-approved fields can change", async () => {
  const state = new MemoryStorageState();
  const repository = new DevelopmentInMemoryParticipantRepository(
    new DeterministicMemoryStorageAdapter(state, true),
    aliceAccount(),
  );
  const mutableRegistration = profileRegistration();
  const first = await repository.register(registerRequest(
    "participant-operation:immutable-register",
    mutableRegistration,
  ));
  mutableRegistration.displayName = "Mutated Input";
  assert.equal(first.snapshot.displayName, "Alice Example");
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.snapshot), true);
  assert.equal(Object.isFrozen(first.snapshot.marketingConsent), true);
  assert.equal(Reflect.set(first.snapshot, "displayName", "Changed Output"), false);

  const second = await repository.update(updateRequest(
    "participant-operation:permitted-update",
    1,
    {
      displayName: "  Alice Participant  ",
      country: "ee",
      declaredInterest: "founder",
      participationContext: "individual",
    },
  ));
  assert.equal(second.revision, 2);
  assert.deepEqual(
    {
      displayName: second.snapshot.displayName,
      country: second.snapshot.country,
      declaredInterest: second.snapshot.declaredInterest,
      participationContext: second.snapshot.participationContext,
    },
    {
      displayName: "Alice Participant",
      country: "EE",
      declaredInterest: "founder",
      participationContext: "individual",
    },
  );
  assert.equal(first.snapshot.displayName, "Alice Example");

  const protectedChanges: readonly Record<string, unknown>[] = [
    { subject: bobAccount().subject },
    { accountEmailLabel: "attacker@example.test" },
    { registrationNoticeEvidence: testParticipantRegistrationNoticeEvidence(2) },
    { processEmailNoticeAcknowledgedAt: UPDATED_AT },
    { marketingConsent: false },
    { accountDeletionRequest: { state: "requested" } },
    { registeredAt: UPDATED_AT },
    { updatedAt: UPDATED_AT },
  ];
  for (const [index, changes] of protectedChanges.entries()) {
    await rejectsStorage(
      () => repository.update(updateRequest(
        `participant-operation:protected-${index}`,
        2,
        changes,
      )),
      "INVALID_REQUEST",
    );
  }
  assert.equal((await repository.current())?.revision, 2);

  const withdrawn = await repository.withdrawMarketingConsent(
    withdrawRequest("participant-operation:policy-consent", 2),
  );
  assert.equal(withdrawn.snapshot.processEmailNoticeAcknowledgedAt, REGISTERED_AT);
  assert.equal(withdrawn.snapshot.marketingConsent.state, "withdrawn");

  const deletion = await repository.requestAccountDeletion(
    deletionRequest("participant-operation:policy-deletion", 3),
  );
  assert.deepEqual(deletion.snapshot.accountDeletionRequest, {
    state: "requested",
    requestedAt: DELETION_REQUESTED_AT,
    activeInterestDisposition: "withdraw",
  });
  assert.deepEqual(await repository.pendingDeletionIntent(), deletion.intents[0]);
});

test("operation IDs replay exactly and reject changed retries or stale writes", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const repository = new DevelopmentInMemoryParticipantRepository(
    storage,
    aliceAccount(),
  );
  const registration = registerRequest(
    "participant-operation:retry-register",
    profileRegistration(),
  );
  const first = await repository.register(registration);
  const firstReplay = await repository.register(registration);
  assert.equal(first.replayed, false);
  assert.equal(firstReplay.replayed, true);
  assert.equal(firstReplay.revision, 1);
  assert.deepEqual(firstReplay.snapshot, first.snapshot);
  const timestampReplay = await repository.register({
    ...registration,
    registeredAt: UPDATED_AT,
  });
  assert.equal(timestampReplay.replayed, true);
  assert.equal(timestampReplay.snapshot.registeredAt, REGISTERED_AT);

  await rejectsStorage(
    () => repository.register({
      ...registration,
      registration: profileRegistration({ displayName: "Changed Retry" }),
    }),
    "CONFLICT",
  );

  const update = updateRequest(
    "participant-operation:retry-update",
    1,
    { displayName: "Replay Stable" },
  );
  const second = await repository.update(update);
  const secondReplay = await repository.update(update);
  assert.equal(second.revision, 2);
  assert.equal(secondReplay.replayed, true);
  assert.deepEqual(secondReplay.snapshot, second.snapshot);

  await rejectsStorage(
    () => repository.update({
      ...update,
      changes: { displayName: "Changed Update Retry" },
    }),
    "CONFLICT",
  );
  await rejectsStorage(
    () => repository.update(updateRequest(
      "participant-operation:stale-update",
      1,
      { displayName: "Stale Write" },
    )),
    "PRECONDITION_FAILED",
  );
  assert.equal((await repository.current())?.snapshot.displayName, "Replay Stable");

  await rejectsStorage(
    () => repository.withdrawMarketingConsent(withdrawRequest(
      "participant-operation:stale-consent",
      1,
    )),
    "PRECONDITION_FAILED",
  );

  const consent = withdrawRequest(
    "participant-operation:retry-consent",
    2,
  );
  const third = await repository.withdrawMarketingConsent(consent);
  const thirdReplay = await repository.withdrawMarketingConsent(consent);
  assert.equal(third.revision, 3);
  assert.equal(thirdReplay.replayed, true);
  await rejectsStorage(
    () => repository.withdrawMarketingConsent({
      ...consent,
      withdrawnAt: "2026-08-09T10:30:00.000Z",
    }),
    "CONFLICT",
  );

  await rejectsStorage(
    () => repository.requestAccountDeletion(deletionRequest(
      "participant-operation:stale-deletion",
      2,
    )),
    "PRECONDITION_FAILED",
  );

  const deletion = deletionRequest(
    "participant-operation:retry-deletion",
    3,
  );
  const fourth = await repository.requestAccountDeletion(deletion);
  const fourthReplay = await repository.requestAccountDeletion(deletion);
  assert.equal(fourth.revision, 4);
  assert.equal(fourthReplay.replayed, true);
  assert.deepEqual(fourthReplay.intents, fourth.intents);
  await rejectsStorage(
    () => repository.requestAccountDeletion({
      ...deletion,
      requestedAt: "2026-08-09T11:30:00.000Z",
    }),
    "CONFLICT",
  );

  const reopened = new DevelopmentInMemoryParticipantRepository(
    storage,
    aliceAccount(),
  );
  const delayedUpdateReplay = await reopened.update(update);
  assert.equal(delayedUpdateReplay.replayed, true);
  assert.equal(delayedUpdateReplay.revision, 2);
  assert.deepEqual(delayedUpdateReplay.snapshot, second.snapshot);
  assert.equal((await reopened.current())?.revision, 4);
  assert.equal(state.records.size, 5);
});

test("stale-policy recovery is read-only and returns only the exact registration result", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const operationId = "participant-operation:recover-registration";
  const registration = profileRegistration();
  const first = await new StorageParticipantRepository(
    storage,
    aliceAccount(),
  ).register(registerRequest(operationId, registration));
  assert.equal(state.operations.size, 1);

  const reopened = new StorageParticipantRepository(storage, aliceAccount());
  const replay = await reopened.recoverRegistration({
    operationId,
    registration,
    noticeEvidenceVersion:
      first.snapshot.registrationNoticeEvidence.version,
  });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.snapshot, first.snapshot);
  assert.equal(state.operations.size, 1);

  await rejectsStorage(
    () => reopened.recoverRegistration({
      operationId,
      registration,
      noticeEvidenceVersion: "malformed-private-evidence",
    }),
    "INVALID_REQUEST",
  );
  await rejectsStorage(
    () => reopened.recoverRegistration({
      operationId,
      registration,
      noticeEvidenceVersion:
        testParticipantRegistrationNoticeEvidence(2).version,
    }),
    "PRECONDITION_FAILED",
  );
  await rejectsStorage(
    () => reopened.recoverRegistration({
      operationId,
      registration: profileRegistration({ displayName: "Changed Retry" }),
      noticeEvidenceVersion:
        first.snapshot.registrationNoticeEvidence.version,
    }),
    "CONFLICT",
  );
  assert.equal(state.operations.size, 1);

  const malformedStorage = new ReadTransformStorageAdapter(
    storage,
    (key, record) =>
      record !== null &&
        key.collection === "private-participant-profile-revisions"
        ? mutateStoredProfile(record, (profile) => {
            const evidence = mutableRecord(
              profile.registrationNoticeEvidence,
            );
            evidence.version = "private-malformed-version";
            profile.registrationNoticeEvidence = evidence;
          })
        : record,
  );
  const malformedFailure = await captureStorageFailure(() =>
    new StorageParticipantRepository(
      malformedStorage,
      aliceAccount(),
    ).recoverRegistration({
      operationId,
      registration,
      noticeEvidenceVersion:
        first.snapshot.registrationNoticeEvidence.version,
    })
  );
  assert.equal(malformedFailure.code, "UNAVAILABLE");
  assert.equal(malformedStorage.transactCalls, 0);

  const foreignStorage = new ReadTransformStorageAdapter(
    storage,
    (key, record) =>
      record !== null &&
        key.collection === "private-participant-profile-revisions"
        ? participantRecordWithSubjects(
            record,
            bobAccount().subject,
            bobAccount().subject,
          )
        : record,
  );
  const foreignFailure = await captureStorageFailure(() =>
    new StorageParticipantRepository(
      foreignStorage,
      aliceAccount(),
    ).recoverRegistration({
      operationId,
      registration,
      noticeEvidenceVersion:
        first.snapshot.registrationNoticeEvidence.version,
    })
  );
  const missingFailure = await captureStorageFailure(() =>
    new StorageParticipantRepository(
      new DeterministicMemoryStorageAdapter(
        new MemoryStorageState(),
        true,
      ),
      aliceAccount(),
    ).recoverRegistration({
      operationId,
      registration,
      noticeEvidenceVersion:
        first.snapshot.registrationNoticeEvidence.version,
    })
  );
  assert.equal(foreignFailure.code, "PRECONDITION_FAILED");
  assert.equal(missingFailure.code, "PRECONDITION_FAILED");
  assert.deepEqual(
    toPublicStorageFailure(foreignFailure),
    toPublicStorageFailure(missingFailure),
  );
  assert.equal(foreignStorage.transactCalls, 0);
  assert.doesNotMatch(
    JSON.stringify(toPublicStorageFailure(foreignFailure)),
    /alice|bob|notice/u,
  );
});

test("maximum notice evidence stays within profile record and transaction ceilings", async () => {
  const maximumNotice = "\u754c".repeat(4_000);
  assert.equal(new TextEncoder().encode(maximumNotice).byteLength, 12_000);
  assert.throws(() => testParticipantRegistrationNoticeEvidence(1, {
    processEmail: "x".repeat(4_001),
    marketing: "bounded",
  }));
  const evidence = testParticipantRegistrationNoticeEvidence(
    Number.MAX_SAFE_INTEGER,
    { processEmail: maximumNotice, marketing: maximumNotice },
  );
  const subject = "\u754c".repeat(255);
  const email = `${"\u754c".repeat(250)}@x.x`;
  assert.equal(email.length, 254);
  const account = participantAccount(subject, email);
  const state = new MemoryStorageState();
  const storage = new RecordingStorageAdapter(
    new DeterministicMemoryStorageAdapter(state, true),
  );
  const repository = new StorageParticipantRepository(storage, account);
  const result = await repository.register(registerRequest(
    "r".repeat(127),
    profileRegistration({ displayName: "\u754c".repeat(120) }),
    evidence,
  ));
  assert.deepEqual(result.snapshot.registrationNoticeEvidence, evidence);

  const recordBytes = [...state.records.values()].map(({ value }) =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength
  );
  assert.equal(recordBytes.length, 2);
  assert.equal(recordBytes.every((bytes) => bytes <= 30_000), true);
  assert.equal(recordBytes.every((bytes) => bytes > 24_000), true);
  const transaction = storage.lastTransaction;
  assert(transaction);
  const inputBytes = new TextEncoder().encode(JSON.stringify(transaction))
    .byteLength;
  const wireBytes = new TextEncoder().encode(JSON.stringify(
    toStorageProtocolTransactionCommand(transaction),
  )).byteLength;
  assert.equal(inputBytes <= 64_512, true);
  assert.equal(wireBytes <= 65_536, true);
  assert.deepEqual(
    await new StorageParticipantRepository(storage, account).current(),
    { revision: 1, snapshot: result.snapshot },
  );
});

test("stored consent withdrawal replays require a granted ancestor", async () => {
  const impossibleRepository = new DevelopmentInMemoryParticipantRepository(
    new DeterministicMemoryStorageAdapter(new MemoryStorageState(), true),
    aliceAccount(),
  );
  const notGranted = await impossibleRepository.register(registerRequest(
    "participant-operation:not-granted-register",
    profileRegistration({ marketingConsent: false }),
  ));
  const impossibleRequest = withdrawRequest(
    "participant-operation:not-granted-withdrawal",
    1,
  );
  const impossible = await impossibleRepository.withdrawMarketingConsent(
    impossibleRequest,
  );
  const impossibleReplay = await impossibleRepository.withdrawMarketingConsent(
    impossibleRequest,
  );
  assert.equal(impossibleReplay.replayed, true);
  assert.deepEqual(impossibleReplay.snapshot, impossible.snapshot);
  assert.deepEqual(impossible.snapshot.marketingConsent, {
    state: "withdrawn",
    withdrawnAt: CONSENT_WITHDRAWN_AT,
  });
  assert.equal(
    isParticipantProfileDescendantProjection(
      notGranted.snapshot,
      impossible.snapshot,
      1,
    ),
    false,
  );

  const validRepository = new DevelopmentInMemoryParticipantRepository(
    new DeterministicMemoryStorageAdapter(new MemoryStorageState(), true),
    aliceAccount(),
  );
  const granted = await validRepository.register(registerRequest(
    "participant-operation:granted-register",
    profileRegistration({ marketingConsent: true }),
  ));
  const validRequest = withdrawRequest(
    "participant-operation:granted-withdrawal",
    1,
  );
  const valid = await validRepository.withdrawMarketingConsent(validRequest);
  const validReplay = await validRepository.withdrawMarketingConsent(
    validRequest,
  );
  assert.equal(validReplay.replayed, true);
  assert.deepEqual(validReplay.snapshot, valid.snapshot);
  assert.equal(
    isParticipantProfileDescendantProjection(
      granted.snapshot,
      valid.snapshot,
      1,
    ),
    true,
  );
});

test("subject binding makes anonymous, foreign, and missing access non-disclosing", async () => {
  const existingState = new MemoryStorageState();
  const ownerStorage = new DeterministicMemoryStorageAdapter(existingState, true);
  const alice = new DevelopmentInMemoryParticipantRepository(
    ownerStorage,
    aliceAccount(),
  );
  await alice.register(registerRequest(
    "participant-operation:private-register",
    profileRegistration({ displayName: "Private Participant Name" }),
  ));

  const [stored] = [...existingState.records.values()];
  assert(stored);
  assert.equal(storageKeyString(stored.key).includes("oidc:alice"), false);
  assert.equal(storageKeyString(stored.key).includes("alice@example.test"), false);
  assert.equal(stored.value.subject, aliceAccount().subject);
  const storedProfile = stored.value.profile;
  const storedProfileSubject = typeof storedProfile === "object" &&
      storedProfile !== null &&
      !Array.isArray(storedProfile)
    ? (storedProfile as Readonly<{ subject?: unknown }>).subject
    : null;
  assert.equal(
    storedProfileSubject,
    aliceAccount().subject,
  );

  const bob = new DevelopmentInMemoryParticipantRepository(
    ownerStorage,
    bobAccount(),
  );
  const anonymous = new DevelopmentInMemoryParticipantRepository(
    ownerStorage,
    null,
  );
  const deniedExisting = new DevelopmentInMemoryParticipantRepository(
    new DeterministicMemoryStorageAdapter(existingState, false),
    aliceAccount(),
  );
  const deniedMissing = new DevelopmentInMemoryParticipantRepository(
    new DeterministicMemoryStorageAdapter(new MemoryStorageState(), false),
    aliceAccount(),
  );

  assert.equal(await bob.current(), null);
  assert.equal(await anonymous.current(), null);
  assert.equal(await deniedExisting.current(), null);
  assert.equal(await deniedMissing.current(), null);

  const bobFailure = await captureStorageFailure(() => bob.update(updateRequest(
    "participant-operation:bob-foreign",
    1,
    { displayName: "Never Visible" },
  )));
  const anonymousFailure = await captureStorageFailure(() =>
    anonymous.register(registerRequest(
      "participant-operation:anonymous",
      profileRegistration(),
    ))
  );
  const deniedExistingFailure = await captureStorageFailure(() =>
    deniedExisting.update(updateRequest(
      "participant-operation:denied-existing",
      1,
      { displayName: "Never Visible" },
    ))
  );
  const deniedMissingFailure = await captureStorageFailure(() =>
    deniedMissing.update(updateRequest(
      "participant-operation:denied-missing",
      1,
      { displayName: "Never Visible" },
    ))
  );
  for (const failure of [
    bobFailure,
    anonymousFailure,
    deniedExistingFailure,
    deniedMissingFailure,
  ]) {
    assert.equal(failure.code, "NOT_FOUND");
    assert.deepEqual(
      toPublicStorageFailure(failure),
      toPublicStorageFailure(deniedMissingFailure),
    );
    const serialized = JSON.stringify(toPublicStorageFailure(failure));
    assert.equal(serialized.includes("Private Participant Name"), false);
    assert.equal(serialized.includes("oidc:alice"), false);
    assert.equal(serialized.includes("alice@example.test"), false);
  }
  assert.equal((await alice.current())?.snapshot.displayName, "Private Participant Name");
});

test("concurrent profile writes preserve one current and one immutable revision", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const firstRepository = new StorageParticipantRepository(
    storage,
    aliceAccount(),
  );
  const secondRepository = new StorageParticipantRepository(
    storage,
    aliceAccount(),
  );
  await firstRepository.register(registerRequest(
    "participant-operation:concurrent-register",
    profileRegistration(),
  ));

  const writes = await Promise.allSettled([
    firstRepository.update(updateRequest(
      "participant-operation:concurrent-first",
      1,
      { displayName: "Concurrent First" },
    )),
    secondRepository.update(updateRequest(
      "participant-operation:concurrent-second",
      1,
      { displayName: "Concurrent Second" },
    )),
  ]);
  const fulfilled = writes.filter(
    (result): result is PromiseFulfilledResult<Awaited<ReturnType<
      ParticipantRepository["update"]
    >>> => result.status === "fulfilled",
  );
  const rejected = writes.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert(rejected[0]?.reason instanceof StorageFailure);
  assert.equal(rejected[0].reason.code, "PRECONDITION_FAILED");
  assert.equal(fulfilled[0]?.value.revision, 2);
  assert.equal(state.records.size, 3);

  const reopened = new StorageParticipantRepository(storage, aliceAccount());
  assert.deepEqual(await reopened.current(), {
    revision: 2,
    snapshot: fulfilled[0]?.value.snapshot,
  });
});

test("every existing-profile mutation verifies current history before transact", async (t) => {
  const mutations: readonly Readonly<{
    name: string;
    run: (repository: ParticipantRepository, operationId: string) => Promise<unknown>;
  }>[] = [
    {
      name: "update",
      run: (repository, operationId) => repository.update(updateRequest(
        operationId,
        1,
        { displayName: "Must Not Persist" },
      )),
    },
    {
      name: "marketing withdrawal",
      run: (repository, operationId) => repository.withdrawMarketingConsent(
        withdrawRequest(operationId, 1),
      ),
    },
    {
      name: "deletion request",
      run: (repository, operationId) => repository.requestAccountDeletion(
        deletionRequest(operationId, 1),
      ),
    },
  ];
  const corruptions: readonly Readonly<{
    name: string;
    code: StorageFailure["code"];
    transform: (record: StorageRecord) => unknown;
  }>[] = [
    {
      name: "malformed current",
      code: "UNAVAILABLE",
      transform: (record) => ({ ...mutableRecord(record), extra: true }),
    },
    {
      name: "foreign current",
      code: "NOT_FOUND",
      transform: (record) => participantRecordWithSubjects(
        record,
        bobAccount().subject,
        bobAccount().subject,
      ),
    },
    {
      name: "history-mismatched current",
      code: "UNAVAILABLE",
      transform: (record) => mutateStoredProfile(record, (profile) => {
        profile.displayName = "Valid But Not Immutable History";
      }),
    },
  ];

  for (const mutation of mutations) {
    for (const corruption of corruptions) {
      await t.test(`${mutation.name}: ${corruption.name}`, async () => {
        const seeded = await seededParticipantStorage();
        const storage = new ReadTransformStorageAdapter(
          seeded.storage,
          (key, record) =>
            record !== null &&
              key.collection === "private-participant-profiles"
              ? corruption.transform(record)
              : record,
        );
        const repository = new StorageParticipantRepository(
          storage,
          aliceAccount(),
        );
        const failure = await captureStorageFailure(() => mutation.run(
          repository,
          `participant-operation:guard-${mutation.name.replaceAll(" ", "-")}-${
            corruption.name.replaceAll(" ", "-")
          }`,
        ));
        assert.equal(failure.code, corruption.code);
        assert.equal(storage.transactCalls, 0);
        assert.equal(seeded.state.records.size, 2);
      });
    }
  }
});

test("commit-then-withheld response reconstructs one exact retry", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const initial = new StorageParticipantRepository(storage, aliceAccount());
  await initial.register(registerRequest(
    "participant-operation:withheld-register",
    profileRegistration(),
  ));

  const operationId = "participant-operation:withheld-update";
  const withholding = new CommitThenWithholdStorageAdapter(
    storage,
    operationId,
  );
  const firstAttempt = new StorageParticipantRepository(
    withholding,
    aliceAccount(),
  );
  const request = updateRequest(operationId, 1, {
    displayName: "Committed Before Response",
  });
  const firstFailure = await captureStorageFailure(() =>
    firstAttempt.update(request)
  );
  assert.equal(firstFailure.code, "UNAVAILABLE");
  assert.equal(withholding.targetTransactCalls, 1);
  assert.equal(state.records.size, 3);

  const recoveredStorage = new ReadTransformStorageAdapter(
    new DeterministicMemoryStorageAdapter(state, true),
    (key, record) => {
      void key;
      return record;
    },
  );
  const changedRetry = new StorageParticipantRepository(
    recoveredStorage,
    aliceAccount(),
  );
  await rejectsStorage(
    () => changedRetry.update({
      ...request,
      changes: { displayName: "Changed After Commit" },
    }),
    "CONFLICT",
  );
  assert.equal(recoveredStorage.transactCalls, 0);

  const reconstructed = new StorageParticipantRepository(
    recoveredStorage,
    aliceAccount(),
  );
  const replay = await reconstructed.update(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, 2);
  assert.equal(replay.snapshot.displayName, "Committed Before Response");
  assert.equal(recoveredStorage.transactCalls, 1);
  assert.equal(state.records.size, 3);
  assert.deepEqual(await reconstructed.current(), {
    revision: 2,
    snapshot: replay.snapshot,
  });
});

test("foreign stored subjects remain equivalent to missing participant state", async () => {
  const seeded = await seededParticipantStorage();
  const foreignStorage = new ReadTransformStorageAdapter(
    seeded.storage,
    (key, record) => {
      if (record === null) return null;
      if (key.collection === "private-participant-profiles") {
        return participantRecordWithSubjects(
          record,
          bobAccount().subject,
          bobAccount().subject,
        );
      }
      return participantRecordWithSubjects(
        record,
        bobAccount().subject,
        bobAccount().subject,
      );
    },
  );
  const foreign = new StorageParticipantRepository(
    foreignStorage,
    aliceAccount(),
  );
  const missing = new StorageParticipantRepository(
    new DeterministicMemoryStorageAdapter(new MemoryStorageState(), true),
    aliceAccount(),
  );
  const ownerWithoutProfile = new StorageParticipantRepository(
    seeded.storage,
    ownerAccount(),
  );

  assert.equal(await foreign.current(), null);
  assert.equal(await missing.current(), null);
  assert.equal(await ownerWithoutProfile.current(), null);

  const foreignFailure = await captureStorageFailure(() => foreign.update(
    updateRequest(
      "participant-operation:foreign-history",
      1,
      { displayName: "Never Returned" },
    ),
  ));
  const missingFailure = await captureStorageFailure(() => missing.update(
    updateRequest(
      "participant-operation:missing-history",
      1,
      { displayName: "Never Returned" },
    ),
  ));
  const ownerFailure = await captureStorageFailure(() =>
    ownerWithoutProfile.update(updateRequest(
      "participant-operation:owner-history",
      1,
      { displayName: "Never Returned" },
    ))
  );
  for (const failure of [foreignFailure, missingFailure, ownerFailure]) {
    assert.equal(failure.code, "NOT_FOUND");
    assert.deepEqual(
      toPublicStorageFailure(failure),
      toPublicStorageFailure(missingFailure),
    );
  }
});

test("stored profile records reject malformed data-only boundaries", async (t) => {
  const outerAccessorProbe = accessorProbe();
  const keyAccessorProbe = accessorProbe();
  const nestedAccessorProbe = accessorProbe();
  const cases: readonly Readonly<{
    name: string;
    transform: (record: StorageRecord) => unknown;
    accessorProbe?: AccessorProbe;
  }>[] = [
    {
      name: "outer extra property",
      transform: (record) => ({ ...mutableRecord(record), extra: true }),
    },
    {
      name: "outer accessor",
      transform: (record) => accessorRecord(
        record,
        "value",
        outerAccessorProbe,
      ),
      accessorProbe: outerAccessorProbe,
    },
    {
      name: "outer prototype",
      transform: (record) => inheritedRecord(record),
    },
    {
      name: "outer symbol",
      transform: (record) => symbolRecord(record),
    },
    {
      name: "zero storage revision",
      transform: (record) => ({ ...mutableRecord(record), revision: 0 }),
    },
    {
      name: "key extra property",
      transform: (record) => mutateRecordKey(record, (key) => {
        key.extra = true;
      }),
    },
    {
      name: "key accessor",
      transform: (record) => mutateRecordKey(record, (key) => {
        Object.defineProperty(
          key,
          "id",
          hostileAccessor(keyAccessorProbe),
        );
      }),
      accessorProbe: keyAccessorProbe,
    },
    {
      name: "value extra property",
      transform: (record) => mutateRecordValue(record, (value) => {
        value.extra = true;
      }),
    },
    {
      name: "value prototype",
      transform: (record) => mutateRecordValue(record, (value) => {
        Object.setPrototypeOf(value, { inherited: true });
      }),
    },
    {
      name: "nested profile accessor",
      transform: (record) => mutateStoredProfile(record, (profile) => {
        Object.defineProperty(
          profile,
          "displayName",
          hostileAccessor(nestedAccessorProbe),
        );
      }),
      accessorProbe: nestedAccessorProbe,
    },
    {
      name: "nested profile prototype",
      transform: (record) => mutateStoredProfile(record, (profile) => {
        Object.setPrototypeOf(profile, { inherited: true });
      }),
    },
    {
      name: "malformed registration notice evidence",
      transform: (record) => mutateStoredProfile(record, (profile) => {
        const evidence = mutableRecord(profile.registrationNoticeEvidence);
        evidence.campaignRevision = 2;
        profile.registrationNoticeEvidence = evidence;
      }),
    },
    {
      name: "oversized stored value",
      transform: (record) => mutateStoredProfile(record, (profile) => {
        profile.displayName = "x".repeat(30_001);
      }),
    },
    {
      name: "crossed profile revision",
      transform: (record) => mutateRecordValue(record, (value) => {
        value.profileRevision = 2;
      }),
    },
  ];

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const seeded = await seededParticipantStorage();
      const repository = new StorageParticipantRepository(
        new ReadTransformStorageAdapter(
          seeded.storage,
          (key, record) =>
            record !== null &&
              key.collection === "private-participant-profiles"
              ? candidate.transform(record)
              : record,
        ),
        aliceAccount(),
      );
      const failure = await captureStorageFailure(() => repository.current());
      assert.equal(failure.code, "UNAVAILABLE");
      assert.equal(Object.hasOwn(failure, "cause"), false);
      if (candidate.accessorProbe !== undefined) {
        assert.equal(candidate.accessorProbe.invocations, 0);
      }
    });
  }
});

test("stored profile records enforce node, depth, and UTF-8 byte bounds", async (t) => {
  const cases: readonly Readonly<{
    name: string;
    transform: (record: StorageRecord) => unknown;
  }>[] = [
    {
      name: "aggregate JSON node count",
      transform: (record) => mutateStoredProfile(record, (profile) => {
        profile.displayName = Array.from({ length: 40 }, () => null);
      }),
    },
    {
      name: "nested JSON depth",
      transform: (record) => mutateStoredProfile(record, (profile) => {
        profile.displayName = nestedDataValue(10);
      }),
    },
    {
      name: "multibyte UTF-8 bytes",
      transform: (record) => mutateStoredProfile(record, (profile) => {
        profile.displayName = "\u20ac".repeat(10_001);
      }),
    },
  ];

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const seeded = await seededParticipantStorage();
      const storage = new ReadTransformStorageAdapter(
        seeded.storage,
        (key, record) =>
          record !== null &&
            key.collection === "private-participant-profiles"
            ? candidate.transform(record)
            : record,
      );
      const repository = new StorageParticipantRepository(
        storage,
        aliceAccount(),
      );
      const failure = await captureStorageFailure(() => repository.current());
      assert.equal(failure.code, "UNAVAILABLE");
      assert.equal(storage.transactCalls, 0);
    });
  }
});

test("current profiles require the matching immutable history snapshot", async (t) => {
  const cases: readonly Readonly<{
    name: string;
    transform: (record: StorageRecord) => unknown;
  }>[] = [
    {
      name: "missing immutable revision",
      transform: () => null,
    },
    {
      name: "foreign immutable revision",
      transform: (record) => participantRecordWithSubjects(
        record,
        bobAccount().subject,
        bobAccount().subject,
      ),
    },
    {
      name: "crossed immutable revision number",
      transform: (record) => mutateRecordValue(record, (value) => {
        value.profileRevision = 2;
      }),
    },
    {
      name: "different immutable profile value",
      transform: (record) => mutateStoredProfile(record, (profile) => {
        profile.displayName = "Different Immutable Value";
      }),
    },
  ];

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const seeded = await seededParticipantStorage();
      const repository = new StorageParticipantRepository(
        new ReadTransformStorageAdapter(
          seeded.storage,
          (key, record) =>
            record !== null &&
              key.collection === "private-participant-profile-revisions"
              ? candidate.transform(record)
              : record,
        ),
        aliceAccount(),
      );
      const failure = await captureStorageFailure(() => repository.current());
      assert.equal(failure.code, "UNAVAILABLE");
      assert.equal(Object.hasOwn(failure, "cause"), false);
    });
  }
});

test("matching revision-one records require registration mutation evidence", async (t) => {
  const nonRegisterActions = [
    "update",
    "withdraw-marketing-consent",
    "request-account-deletion",
  ] as const;

  for (const action of nonRegisterActions) {
    await t.test(action, async () => {
      const seeded = await seededParticipantStorage();
      const storage = new ReadTransformStorageAdapter(
        seeded.storage,
        (key, record) =>
          record !== null &&
            (key.collection === "private-participant-profiles" ||
              key.collection === "private-participant-profile-revisions")
            ? mutateStoredLastMutation(record, (lastMutation) => {
                lastMutation.action = action;
              })
            : record,
      );
      const failure = await captureStorageFailure(() =>
        new StorageParticipantRepository(storage, aliceAccount()).current()
      );

      assert.equal(failure.code, "UNAVAILABLE");
      assert.equal(Object.hasOwn(failure, "cause"), false);
      assert.deepEqual(toPublicStorageFailure(failure), {
        error: {
          code: "UNAVAILABLE",
          message: "Storage is temporarily unavailable.",
        },
      });
      assert.equal(storage.transactCalls, 0);
    });
  }
});

test("later profiles use one bounded revision-one notice-evidence anchor read", async () => {
  const seeded = await seededParticipantStorage();
  await new StorageParticipantRepository(
    seeded.storage,
    aliceAccount(),
  ).update(updateRequest(
    "participant-operation:seed-notice-anchor-read",
    1,
    { displayName: "Later participant profile" },
  ));
  const storage = new ReadTransformStorageAdapter(
    seeded.storage,
    (_key, record) => record,
  );
  const current = await new StorageParticipantRepository(
    storage,
    aliceAccount(),
  ).current();

  assert.equal(current?.revision, 2);
  assert.equal(storage.readCalls, 3);
  assert.equal(storage.transactCalls, 0);
});

test("later profiles reject corrupted immutable registration notice anchors", async (t) => {
  const changedEvidence = testParticipantRegistrationNoticeEvidence(2, {
    processEmail: "Changed but structurally valid process notice.",
    marketing: "Changed but structurally valid marketing notice.",
  });
  const cases: readonly Readonly<{
    name: string;
    transform: (record: StorageRecord) => unknown;
  }>[] = [
    {
      name: "current and latest history share changed valid evidence",
      transform: (record) =>
        storedParticipantProfileRevision(record) === 2
          ? mutateStoredProfile(record, (profile) => {
              profile.registrationNoticeEvidence = changedEvidence;
            })
          : record,
    },
    {
      name: "revision one is missing",
      transform: (record) =>
        storedParticipantProfileRevision(record) === 1 ? null : record,
    },
    {
      name: "revision one belongs to a foreign subject",
      transform: (record) =>
        storedParticipantProfileRevision(record) === 1
          ? participantRecordWithSubjects(
              record,
              bobAccount().subject,
              bobAccount().subject,
            )
          : record,
    },
    {
      name: "revision one has malformed notice evidence",
      transform: (record) =>
        storedParticipantProfileRevision(record) === 1
          ? mutateStoredProfile(record, (profile) => {
              const evidence = mutableRecord(
                profile.registrationNoticeEvidence,
              );
              evidence.campaignRevision = 2;
              profile.registrationNoticeEvidence = evidence;
            })
          : record,
    },
    {
      name: "revision one contains a terminal marketing withdrawal",
      transform: (record) =>
        storedParticipantProfileRevision(record) === 1
          ? mutateStoredProfile(record, (profile) => {
              profile.marketingConsent = {
                state: "withdrawn",
                grantedAt: REGISTERED_AT,
                withdrawnAt: CONSENT_WITHDRAWN_AT,
              };
              profile.updatedAt = CONSENT_WITHDRAWN_AT;
            })
          : record,
    },
    {
      name: "revision one contains a terminal deletion request",
      transform: (record) =>
        storedParticipantProfileRevision(record) === 1
          ? mutateStoredProfile(record, (profile) => {
              profile.accountDeletionRequest = {
                state: "requested",
                requestedAt: DELETION_REQUESTED_AT,
                activeInterestDisposition: "withdraw",
              };
              profile.updatedAt = DELETION_REQUESTED_AT;
            })
          : record,
    },
  ];

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const seeded = await seededParticipantStorage();
      await new StorageParticipantRepository(
        seeded.storage,
        aliceAccount(),
      ).update(updateRequest(
        "participant-operation:seed-corrupted-notice-anchor",
        1,
        { displayName: "Later participant profile" },
      ));
      const storage = new ReadTransformStorageAdapter(
        seeded.storage,
        (key, record) =>
          record !== null &&
            (key.collection === "private-participant-profiles" ||
              key.collection === "private-participant-profile-revisions")
            ? candidate.transform(record)
            : record,
      );
      const failure = await captureStorageFailure(() =>
        new StorageParticipantRepository(storage, aliceAccount()).current()
      );

      assert.equal(failure.code, "UNAVAILABLE");
      assert.equal(Object.hasOwn(failure, "cause"), false);
      assert.equal(storage.readCalls, 3);
      assert.equal(storage.transactCalls, 0);
    });
  }
});

test("later profiles reject non-register revision-one ancestry", async (t) => {
  const nonRegisterActions = [
    "update",
    "withdraw-marketing-consent",
    "request-account-deletion",
  ] as const;

  for (const action of nonRegisterActions) {
    await t.test(action, async () => {
      const seeded = await seededParticipantStorage();
      await new StorageParticipantRepository(
        seeded.storage,
        aliceAccount(),
      ).update(updateRequest(
        `participant-operation:seed-${action}`,
        1,
        { displayName: "Later participant profile" },
      ));
      const storage = new ReadTransformStorageAdapter(
        seeded.storage,
        (key, record) =>
          record !== null &&
            key.collection === "private-participant-profile-revisions" &&
            storedParticipantProfileRevision(record) === 1
            ? mutateStoredLastMutation(record, (lastMutation) => {
                lastMutation.action = action;
              })
            : record,
      );
      const failure = await captureStorageFailure(() =>
        new StorageParticipantRepository(storage, aliceAccount()).current()
      );

      assert.equal(failure.code, "UNAVAILABLE");
      assert.equal(Object.hasOwn(failure, "cause"), false);
      assert.deepEqual(toPublicStorageFailure(failure), {
        error: {
          code: "UNAVAILABLE",
          message: "Storage is temporarily unavailable.",
        },
      });
      assert.equal(storage.readCalls, 3);
      assert.equal(storage.transactCalls, 0);
    });
  }
});

test("immutable history rejects crossed revisions without exposing subjects", async () => {
  const cases: readonly Readonly<{
    name: string;
    transform: (record: StorageRecord) => unknown;
    code: StorageFailure["code"];
  }>[] = [
    {
      name: "foreign history subject",
      transform: (record) => participantRecordWithSubjects(
        record,
        bobAccount().subject,
        bobAccount().subject,
      ),
      code: "NOT_FOUND",
    },
    {
      name: "foreign nested history subject",
      transform: (record) => participantRecordWithSubjects(
        record,
        aliceAccount().subject,
        bobAccount().subject,
      ),
      code: "NOT_FOUND",
    },
    {
      name: "wrong immutable storage revision",
      transform: (record) => ({ ...mutableRecord(record), revision: 2 }),
      code: "UNAVAILABLE",
    },
    {
      name: "wrong immutable profile revision",
      transform: (record) => mutateRecordValue(record, (value) => {
        value.profileRevision = 2;
      }),
      code: "UNAVAILABLE",
    },
  ];

  for (const candidate of cases) {
    const seeded = await seededParticipantStorage();
    const repository = new StorageParticipantRepository(
      new ReadTransformStorageAdapter(
        seeded.storage,
        (key, record) =>
          record !== null &&
            key.collection === "private-participant-profile-revisions"
            ? candidate.transform(record)
            : record,
      ),
      aliceAccount(),
    );
    const failure = await captureStorageFailure(() => repository.update(
      updateRequest(
        `participant-operation:history-${candidate.name.replaceAll(" ", "-")}`,
        1,
        { displayName: "Never Written" },
      ),
    ));
    assert.equal(failure.code, candidate.code);
    assert.equal(JSON.stringify(toPublicStorageFailure(failure)).includes("oidc:"), false);
  }
});

test("transaction results require the exact closed two-record result", async (t) => {
  const cases: readonly Readonly<{
    name: string;
    transform: (result: StorageTransactionResult) => unknown;
    accessorProbe?: AccessorProbe;
  }>[] = malformedTransactionResultCases();

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const storage = new TransactionTransformStorageAdapter(
        new DeterministicMemoryStorageAdapter(new MemoryStorageState(), true),
        candidate.transform,
      );
      const repository = new StorageParticipantRepository(
        storage,
        aliceAccount(),
      );
      const failure = await captureStorageFailure(() => repository.register(
        registerRequest(
          `participant-operation:malformed-result-${candidate.name.replaceAll(" ", "-")}`,
          profileRegistration(),
        ),
      ));
      assert.equal(failure.code, "UNAVAILABLE");
      assert.equal(Object.hasOwn(failure, "cause"), false);
      assert.equal(JSON.stringify(failure).includes("private adapter value"), false);
      if (candidate.accessorProbe !== undefined) {
        assert.equal(candidate.accessorProbe.invocations, 0);
      }
    });
  }
});

test("adapter failures preserve only fixed failure codes and discard causes", async () => {
  const privateCause = new Error("private adapter value");
  const readRepository = new StorageParticipantRepository(
    new FailingStorageAdapter(
      "read",
      new Error("private adapter value", { cause: privateCause }),
    ),
    aliceAccount(),
  );
  const readFailure = await captureStorageFailure(() => readRepository.current());
  assert.equal(readFailure.code, "UNAVAILABLE");
  assert.equal(Object.hasOwn(readFailure, "cause"), false);

  const writeRepository = new StorageParticipantRepository(
    new FailingStorageAdapter(
      "transact",
      new StorageFailure("CONFLICT", { cause: privateCause }),
    ),
    aliceAccount(),
  );
  const writeFailure = await captureStorageFailure(() =>
    writeRepository.register(registerRequest(
      "participant-operation:sanitized-failure",
      profileRegistration(),
    ))
  );
  assert.equal(writeFailure.code, "CONFLICT");
  assert.equal(Object.hasOwn(writeFailure, "cause"), false);
  assert.equal(JSON.stringify(writeFailure).includes("private adapter value"), false);
});

test("participant module exports only repositories and writes only participant records", async () => {
  const participantModule = await import(
    "../repositories/in-memory-participant-repository.ts"
  );
  assert.deepEqual(Object.keys(participantModule).sort(), [
    "DevelopmentInMemoryParticipantRepository",
    "StorageParticipantRepository",
  ]);

  const state = new MemoryStorageState();
  const repository = new StorageParticipantRepository(
    new DeterministicMemoryStorageAdapter(state, true),
    aliceAccount(),
  );
  await repository.register(registerRequest(
    "participant-operation:boundary-register",
    profileRegistration(),
  ));
  const deletion = await repository.requestAccountDeletion(deletionRequest(
    "participant-operation:boundary-deletion",
    1,
  ));
  assert.deepEqual(deletion.intents, [{
    type: "withdraw-active-interest",
    subject: aliceAccount().subject,
    reason: "account-deletion-request",
    requestedAt: DELETION_REQUESTED_AT,
  }]);
  assert.deepEqual(
    [...state.records.values()]
      .map((record) => record.key.collection)
      .sort(),
    [
      "private-participant-profile-revisions",
      "private-participant-profile-revisions",
      "private-participant-profiles",
    ],
  );
  assert.equal(state.operations.size, 2);
});

type RegistrationOverrides = Readonly<{
  displayName?: string;
  marketingConsent?: boolean;
}>;

function profileRegistration(
  overrides: RegistrationOverrides = {},
): Record<string, unknown> {
  return {
    displayName: overrides.displayName ?? "Alice Example",
    country: "fi",
    declaredInterest: "both",
    participationContext: "company",
    processEmailNoticeAcknowledged: true,
    marketingConsent: overrides.marketingConsent ?? true,
  };
}

function registerRequest(
  operationId: string,
  registration: unknown,
  noticeEvidence: ReturnType<
    typeof testParticipantRegistrationNoticeEvidence
  > = testParticipantRegistrationNoticeEvidence(),
): RegisterParticipantRequest {
  return {
    operationId,
    expectedRevision: null,
    registeredAt: REGISTERED_AT,
    registration,
    noticeEvidence,
  };
}

function updateRequest(
  operationId: string,
  expectedRevision: number,
  changes: unknown,
): UpdateParticipantRequest {
  return {
    operationId,
    expectedRevision,
    updatedAt: UPDATED_AT,
    changes,
  };
}

function withdrawRequest(
  operationId: string,
  expectedRevision: number,
): WithdrawMarketingConsentRequest {
  return {
    operationId,
    expectedRevision,
    withdrawnAt: CONSENT_WITHDRAWN_AT,
  };
}

function deletionRequest(
  operationId: string,
  expectedRevision: number,
): RequestParticipantDeletionRequest {
  return {
    operationId,
    expectedRevision,
    requestedAt: DELETION_REQUESTED_AT,
  };
}

function aliceAccount(): ParticipantAccount {
  return participantAccount("oidc:alice", "alice@example.test");
}

function bobAccount(): ParticipantAccount {
  return participantAccount("oidc:bob", "bob@example.test");
}

function ownerAccount(): ParticipantAccount {
  return participantAccount("oidc:owner", "owner@example.test");
}

function participantAccount(
  subject: string,
  accountEmailLabel: string,
): ParticipantAccount {
  const parsed = parseParticipantAccount({ subject, accountEmailLabel });
  assert(parsed.ok);
  return parsed.value;
}

async function rejectsStorage(
  operation: () => Promise<unknown>,
  code: StorageFailure["code"],
): Promise<void> {
  const error = await captureStorageFailure(operation);
  assert.equal(error.code, code);
}

async function captureStorageFailure(
  operation: () => Promise<unknown>,
): Promise<StorageFailure> {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof StorageFailure);
    return error;
  }
  assert.fail("Expected a StorageFailure.");
}

class MemoryStorageState {
  readonly records = new Map<string, StorageRecord>();
  readonly operations = new Map<
    string,
    Readonly<{ fingerprint: string; result: StorageTransactionResult }>
  >();
}

class DeterministicMemoryStorageAdapter implements StorageAdapter {
  readonly #state: MemoryStorageState;
  readonly #permitted: boolean;

  constructor(state: MemoryStorageState, permitted: boolean) {
    this.#state = state;
    this.#permitted = permitted;
  }

  async read(key: StorageKey): Promise<StorageRecord | null> {
    if (!this.#permitted) return null;
    return cloneRecord(this.#state.records.get(storageKeyString(key)) ?? null);
  }

  async list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    assertStorageListBoundary(request);
    if (!this.#permitted) return { items: [], nextCursor: null };

    const start = request.cursor === undefined ? 0 : parseCursor(request.cursor);
    const all = [...this.#state.records.values()]
      .filter((record) => record.key.collection === request.collection)
      .sort((left, right) => left.key.id.localeCompare(right.key.id));
    if (start < 0 || start > all.length) {
      throw new StorageFailure("INVALID_REQUEST");
    }
    const items = all
      .slice(start, start + request.limit)
      .map(cloneRecord)
      .filter((record): record is StorageRecord => record !== null);
    const next = start + items.length;
    return {
      items: Object.freeze(items),
      nextCursor: next < all.length
        ? (`participant-cursor:${next}` as StorageCursor)
        : null,
    };
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    assertStorageTransactionBoundary(request);
    if (!this.#permitted) throw new StorageFailure("NOT_FOUND");

    const operationKey = request.operationId as string;
    const fingerprint = JSON.stringify(request);
    const prior = this.#state.operations.get(operationKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new StorageFailure("CONFLICT");
      return cloneResult(prior.result, true);
    }

    for (const mutation of request.mutations) {
      const current = this.#state.records.get(storageKeyString(mutation.key));
      if (mutation.type === "check") {
        if (
          mutation.expectedRevision === null
            ? current !== undefined
            : current?.revision !== mutation.expectedRevision
        ) throw new StorageFailure("PRECONDITION_FAILED");
      } else if (mutation.expectedRevision === null) {
        if (current) throw new StorageFailure("CONFLICT");
      } else if (!current || current.revision !== mutation.expectedRevision) {
        throw new StorageFailure("PRECONDITION_FAILED");
      }
    }

    const nextRecords = new Map(this.#state.records);
    const resultRecords: (StorageRecord | null)[] = [];
    for (const mutation of request.mutations) {
      const key = storageKeyString(mutation.key);
      const current = nextRecords.get(key);
      if (mutation.type === "check") {
        resultRecords.push(cloneRecord(current ?? null));
        continue;
      }
      if (mutation.type === "delete") {
        nextRecords.delete(key);
        resultRecords.push(null);
        continue;
      }
      const record = freezeRecord({
        key: mutation.key,
        revision: (current?.revision ?? 0) + 1,
        value: mutation.value,
      });
      nextRecords.set(key, record);
      resultRecords.push(record);
    }

    this.#state.records.clear();
    for (const [key, record] of nextRecords) this.#state.records.set(key, record);
    const result: StorageTransactionResult = Object.freeze({
      replayed: false,
      records: Object.freeze(resultRecords.map(cloneRecord)),
    });
    this.#state.operations.set(operationKey, { fingerprint, result });
    return cloneResult(result, false);
  }
}

class ReadTransformStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #transform: (
    key: StorageKey,
    record: StorageRecord | null,
  ) => unknown;
  #transactCalls = 0;
  #readCalls = 0;

  constructor(
    delegate: StorageAdapter,
    transform: (key: StorageKey, record: StorageRecord | null) => unknown,
  ) {
    this.#delegate = delegate;
    this.#transform = transform;
  }

  async read(key: StorageKey): Promise<StorageRecord | null> {
    this.#readCalls += 1;
    return this.#transform(key, await this.#delegate.read(key)) as
      | StorageRecord
      | null;
  }

  async list(
    request: Parameters<StorageAdapter["list"]>[0],
  ): Promise<StoragePage> {
    return this.#delegate.list(request);
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    this.#transactCalls += 1;
    return this.#delegate.transact(request);
  }

  get transactCalls(): number {
    return this.#transactCalls;
  }

  get readCalls(): number {
    return this.#readCalls;
  }
}

class RecordingStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  lastTransaction: StorageTransactionRequest | null = null;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  read(key: StorageKey): Promise<StorageRecord | null> {
    return this.#delegate.read(key);
  }

  list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    return this.#delegate.list(request);
  }

  transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    this.lastTransaction = request;
    return this.#delegate.transact(request);
  }
}

class TransactionTransformStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #transform: (result: StorageTransactionResult) => unknown;

  constructor(
    delegate: StorageAdapter,
    transform: (result: StorageTransactionResult) => unknown,
  ) {
    this.#delegate = delegate;
    this.#transform = transform;
  }

  async read(key: StorageKey): Promise<StorageRecord | null> {
    return this.#delegate.read(key);
  }

  async list(
    request: Parameters<StorageAdapter["list"]>[0],
  ): Promise<StoragePage> {
    return this.#delegate.list(request);
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    return this.#transform(await this.#delegate.transact(request)) as
      StorageTransactionResult;
  }
}

class CommitThenWithholdStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #targetOperationId: string;
  #withheld = false;
  #targetTransactCalls = 0;

  constructor(delegate: StorageAdapter, targetOperationId: string) {
    this.#delegate = delegate;
    this.#targetOperationId = targetOperationId;
  }

  async read(key: StorageKey): Promise<StorageRecord | null> {
    return this.#delegate.read(key);
  }

  async list(
    request: Parameters<StorageAdapter["list"]>[0],
  ): Promise<StoragePage> {
    return this.#delegate.list(request);
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    const target = request.operationId === this.#targetOperationId;
    if (target) this.#targetTransactCalls += 1;
    const result = await this.#delegate.transact(request);
    if (target && !this.#withheld) {
      this.#withheld = true;
      throw new Error("private committed response");
    }
    return result;
  }

  get targetTransactCalls(): number {
    return this.#targetTransactCalls;
  }
}

class FailingStorageAdapter implements StorageAdapter {
  readonly #phase: "read" | "transact";
  readonly #failure: unknown;

  constructor(phase: "read" | "transact", failure: unknown) {
    this.#phase = phase;
    this.#failure = failure;
  }

  async read(): Promise<StorageRecord | null> {
    if (this.#phase === "read") throw this.#failure;
    return null;
  }

  async list(
    request: Parameters<StorageAdapter["list"]>[0],
  ): Promise<StoragePage> {
    assertStorageListBoundary(request);
    return { items: [], nextCursor: null };
  }

  async transact(): Promise<StorageTransactionResult> {
    if (this.#phase === "transact") throw this.#failure;
    throw new StorageFailure("UNAVAILABLE");
  }
}

async function seededParticipantStorage(): Promise<Readonly<{
  state: MemoryStorageState;
  storage: DeterministicMemoryStorageAdapter;
}>> {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const repository = new StorageParticipantRepository(storage, aliceAccount());
  await repository.register(registerRequest(
    "participant-operation:seed-hostile-boundary",
    profileRegistration(),
  ));
  return { state, storage };
}

function participantRecordWithSubjects(
  record: StorageRecord,
  outerSubject: string,
  profileSubject: string,
): unknown {
  return mutateRecordValue(record, (value) => {
    value.subject = outerSubject;
    const profile = mutableRecord(value.profile);
    profile.subject = profileSubject;
    value.profile = profile;
  });
}

type AccessorProbe = { invocations: number };

function accessorProbe(): AccessorProbe {
  return { invocations: 0 };
}

function accessorRecord(
  record: StorageRecord,
  key: string,
  probe?: AccessorProbe,
): unknown {
  const output = mutableRecord(record);
  Object.defineProperty(output, key, hostileAccessor(probe));
  return output;
}

function inheritedRecord(record: StorageRecord): unknown {
  const output = mutableRecord(record);
  Object.setPrototypeOf(output, { inherited: true });
  return output;
}

function symbolRecord(record: StorageRecord): unknown {
  const output = mutableRecord(record);
  Object.defineProperty(output, Symbol("private adapter value"), {
    enumerable: true,
    value: true,
  });
  return output;
}

function mutateRecordKey(
  record: StorageRecord,
  mutate: (key: Record<string, unknown>) => void,
): unknown {
  const output = mutableRecord(record);
  const key = mutableRecord(output.key);
  mutate(key);
  output.key = key;
  return output;
}

function mutateRecordValue(
  record: StorageRecord,
  mutate: (value: Record<string, unknown>) => void,
): unknown {
  const output = mutableRecord(record);
  const value = mutableRecord(output.value);
  mutate(value);
  output.value = value;
  return output;
}

function mutateStoredProfile(
  record: StorageRecord,
  mutate: (profile: Record<string, unknown>) => void,
): unknown {
  return mutateRecordValue(record, (value) => {
    const profile = mutableRecord(value.profile);
    mutate(profile);
    value.profile = profile;
  });
}

function mutateStoredLastMutation(
  record: StorageRecord,
  mutate: (lastMutation: Record<string, unknown>) => void,
): unknown {
  return mutateRecordValue(record, (value) => {
    const lastMutation = mutableRecord(value.lastMutation);
    mutate(lastMutation);
    value.lastMutation = lastMutation;
  });
}

function storedParticipantProfileRevision(record: StorageRecord): number | null {
  const value = mutableRecord(record.value);
  return Number.isSafeInteger(value.profileRevision)
    ? value.profileRevision as number
    : null;
}

function hostileAccessor(probe?: AccessorProbe): PropertyDescriptor {
  return {
    configurable: true,
    enumerable: true,
    get(): never {
      if (probe !== undefined) probe.invocations += 1;
      throw new Error("private adapter value");
    },
  };
}

function nestedDataValue(depth: number): unknown {
  let value: unknown = "leaf";
  for (let index = 0; index < depth; index += 1) {
    value = { nested: value };
  }
  return value;
}

function mutableRecord(value: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  assert.notEqual(serialized, undefined);
  const parsed = JSON.parse(serialized as string) as unknown;
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  assert.equal(Array.isArray(parsed), false);
  return parsed as Record<string, unknown>;
}

type MutableTransactionResult = Record<string, unknown> & {
  replayed: unknown;
  records: unknown[];
};

function mutableTransactionResult(
  result: StorageTransactionResult,
): MutableTransactionResult {
  const output = mutableRecord(result);
  assert(Array.isArray(output.records));
  return output as MutableTransactionResult;
}

function mutateTransactionRecord(
  result: StorageTransactionResult,
  index: number,
  mutate: (record: Record<string, unknown>) => void,
): unknown {
  const output = mutableTransactionResult(result);
  const record = mutableRecord(output.records[index]);
  mutate(record);
  output.records[index] = record;
  return output;
}

function mutateTransactionRecordKey(
  result: StorageTransactionResult,
  index: number,
  mutate: (key: Record<string, unknown>) => void,
): unknown {
  return mutateTransactionRecord(result, index, (record) => {
    const key = mutableRecord(record.key);
    mutate(key);
    record.key = key;
  });
}

function mutateTransactionRecordValue(
  result: StorageTransactionResult,
  index: number,
  mutate: (value: Record<string, unknown>) => void,
): unknown {
  return mutateTransactionRecord(result, index, (record) => {
    const value = mutableRecord(record.value);
    mutate(value);
    record.value = value;
  });
}

function malformedTransactionResultCases(): readonly Readonly<{
  name: string;
  transform: (result: StorageTransactionResult) => unknown;
  accessorProbe?: AccessorProbe;
}>[] {
  const replayAccessorProbe = accessorProbe();
  const recordsAccessorProbe = accessorProbe();
  const recordAccessorProbe = accessorProbe();
  const keyAccessorProbe = accessorProbe();
  const nestedAccessorProbe = accessorProbe();
  return [
    { name: "null envelope", transform: () => null },
    { name: "primitive envelope", transform: () => "private adapter value" },
    {
      name: "extra envelope field",
      transform: (result) => ({
        ...mutableTransactionResult(result),
        extra: true,
      }),
    },
    {
      name: "envelope prototype",
      transform: (result) => {
        const output = mutableTransactionResult(result);
        Object.setPrototypeOf(output, { inherited: true });
        return output;
      },
    },
    {
      name: "replay accessor",
      transform: (result) => {
        const output = mutableTransactionResult(result);
        Object.defineProperty(
          output,
          "replayed",
          hostileAccessor(replayAccessorProbe),
        );
        return output;
      },
      accessorProbe: replayAccessorProbe,
    },
    {
      name: "non boolean replay",
      transform: (result) => ({
        ...mutableTransactionResult(result),
        replayed: 0,
      }),
    },
    {
      name: "records accessor",
      transform: (result) => {
        const output = mutableTransactionResult(result);
        Object.defineProperty(
          output,
          "records",
          hostileAccessor(recordsAccessorProbe),
        );
        return output;
      },
      accessorProbe: recordsAccessorProbe,
    },
    {
      name: "sparse records array",
      transform: (result) => {
        const output = mutableTransactionResult(result);
        const records = new Array<unknown>(2);
        records[0] = output.records[0];
        output.records = records;
        return output;
      },
    },
    {
      name: "records array extra field",
      transform: (result) => {
        const output = mutableTransactionResult(result);
        Object.defineProperty(output.records, "extra", {
          enumerable: true,
          value: true,
        });
        return output;
      },
    },
    {
      name: "records array prototype",
      transform: (result) => {
        const output = mutableTransactionResult(result);
        Object.setPrototypeOf(output.records, null);
        return output;
      },
    },
    {
      name: "wrong record count",
      transform: (result) => {
        const output = mutableTransactionResult(result);
        output.records = output.records.slice(0, 1);
        return output;
      },
    },
    {
      name: "reversed record order",
      transform: (result) => {
        const output = mutableTransactionResult(result);
        output.records.reverse();
        return output;
      },
    },
    {
      name: "null current record",
      transform: (result) => {
        const output = mutableTransactionResult(result);
        output.records[0] = null;
        return output;
      },
    },
    {
      name: "record extra field",
      transform: (result) => mutateTransactionRecord(result, 0, (record) => {
        record.extra = true;
      }),
    },
    {
      name: "record accessor",
      transform: (result) => mutateTransactionRecord(result, 0, (record) => {
        Object.defineProperty(
          record,
          "value",
          hostileAccessor(recordAccessorProbe),
        );
      }),
      accessorProbe: recordAccessorProbe,
    },
    {
      name: "record prototype",
      transform: (result) => mutateTransactionRecord(result, 0, (record) => {
        Object.setPrototypeOf(record, { inherited: true });
      }),
    },
    {
      name: "key extra field",
      transform: (result) => mutateTransactionRecordKey(
        result,
        0,
        (key) => {
          key.extra = true;
        },
      ),
    },
    {
      name: "key accessor",
      transform: (result) => mutateTransactionRecordKey(
        result,
        0,
        (key) => {
          Object.defineProperty(
            key,
            "id",
            hostileAccessor(keyAccessorProbe),
          );
        },
      ),
      accessorProbe: keyAccessorProbe,
    },
    {
      name: "wrong key",
      transform: (result) => mutateTransactionRecordKey(
        result,
        0,
        (key) => {
          key.id = `subject:${"0".repeat(64)}`;
        },
      ),
    },
    {
      name: "wrong current revision",
      transform: (result) => mutateTransactionRecord(result, 0, (record) => {
        record.revision = 2;
      }),
    },
    {
      name: "wrong history revision",
      transform: (result) => mutateTransactionRecord(result, 1, (record) => {
        record.revision = 2;
      }),
    },
    {
      name: "value extra field",
      transform: (result) => mutateTransactionRecordValue(
        result,
        0,
        (value) => {
          value.extra = true;
        },
      ),
    },
    {
      name: "value prototype",
      transform: (result) => mutateTransactionRecordValue(
        result,
        0,
        (value) => {
          Object.setPrototypeOf(value, { inherited: true });
        },
      ),
    },
    {
      name: "nested value accessor",
      transform: (result) => mutateTransactionRecordValue(
        result,
        0,
        (value) => {
          const profile = mutableRecord(value.profile);
          Object.defineProperty(
            profile,
            "displayName",
            hostileAccessor(nestedAccessorProbe),
          );
          value.profile = profile;
        },
      ),
      accessorProbe: nestedAccessorProbe,
    },
    {
      name: "wrong exact value",
      transform: (result) => mutateTransactionRecordValue(
        result,
        0,
        (value) => {
          const profile = mutableRecord(value.profile);
          profile.displayName = "Changed By Adapter";
          value.profile = profile;
        },
      ),
    },
    {
      name: "wrong exact history value",
      transform: (result) => mutateTransactionRecordValue(
        result,
        1,
        (value) => {
          const profile = mutableRecord(value.profile);
          profile.displayName = "Changed History By Adapter";
          value.profile = profile;
        },
      ),
    },
  ];
}

function parseCursor(cursor: StorageCursor): number {
  const match = /^participant-cursor:(\d+)$/.exec(cursor);
  if (!match) throw new StorageFailure("INVALID_REQUEST");
  return Number.parseInt(match[1], 10);
}

function cloneResult(
  result: StorageTransactionResult,
  replayed: boolean,
): StorageTransactionResult {
  return Object.freeze({
    replayed,
    records: Object.freeze(result.records.map(cloneRecord)),
  });
}

function cloneRecord(record: StorageRecord | null): StorageRecord | null {
  return record === null
    ? null
    : freezeRecord({
        key: record.key,
        revision: record.revision,
        value: record.value,
      });
}

function freezeRecord(input: Readonly<{
  key: StorageKey;
  revision: number;
  value: StorageDocument;
}>): StorageRecord {
  return Object.freeze({
    key: Object.freeze({ ...input.key }),
    revision: input.revision,
    value: deepFreeze(cloneDocument(input.value)),
  });
}

function cloneDocument(value: StorageDocument): StorageDocument {
  return JSON.parse(JSON.stringify(value)) as StorageDocument;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
