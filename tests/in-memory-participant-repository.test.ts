import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
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
  type ParticipantRepository,
  type RegisterParticipantRequest,
  type RequestParticipantDeletionRequest,
  type UpdateParticipantRequest,
  type WithdrawMarketingConsentRequest,
} from "../repositories/in-memory-participant-repository.ts";

const REGISTERED_AT = "2026-08-09T08:00:00.000Z";
const UPDATED_AT = "2026-08-09T09:00:00.000Z";
const CONSENT_WITHDRAWN_AT = "2026-08-09T10:00:00.000Z";
const DELETION_REQUESTED_AT = "2026-08-09T11:00:00.000Z";

export type ParticipantRepositoryContractFixture = Readonly<{
  participant: ParticipantRepository;
  outsider: ParticipantRepository;
  anonymous: ParticipantRepository;
  reopenParticipant: () => ParticipantRepository;
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

test("adapter-backed development repository passes the participant contract", async () => {
  await verifyParticipantRepositoryContract(() => {
    const state = new MemoryStorageState();
    const storage = new DeterministicMemoryStorageAdapter(state, true);
    return {
      participant: new DevelopmentInMemoryParticipantRepository(
        storage,
        aliceAccount(),
      ),
      outsider: new DevelopmentInMemoryParticipantRepository(
        storage,
        bobAccount(),
      ),
      anonymous: new DevelopmentInMemoryParticipantRepository(storage, null),
      reopenParticipant: () => new DevelopmentInMemoryParticipantRepository(
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

test("participant persistence has no indication or founder repository imports", async () => {
  const source = await readFile(
    new URL(
      "../repositories/in-memory-participant-repository.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /(?:investment-indication|founder-application|in-memory-(?:indication|founder))/,
  );
});

type RegistrationOverrides = Readonly<{
  displayName?: string;
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
    marketingConsent: true,
  };
}

function registerRequest(
  operationId: string,
  registration: unknown,
): RegisterParticipantRequest {
  return {
    operationId,
    expectedRevision: null,
    registeredAt: REGISTERED_AT,
    registration,
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
      if (mutation.expectedRevision === null) {
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
