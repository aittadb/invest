import assert from "node:assert/strict";
import test from "node:test";

import { toStorageProtocolTransactionCommand } from "../domain/aittadb-storage-protocol.ts";
import { parseAmountAggregateConfiguration } from "../domain/amount-aggregate-configuration.ts";
import {
  parseStableId,
  type ActorSubject,
} from "../domain/foundation.ts";
import type { InvestmentIndicationId } from "../domain/investment-indication.ts";
import {
  createPackageAcceptance,
  createPackageVersion,
} from "../domain/package-content.ts";
import {
  parseParticipantAccount,
  type ParticipantAccount,
} from "../domain/participant-profile.ts";
import {
  StorageFailure,
  toPublicStorageFailure,
  type StorageAdapter,
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import { StorageParticipantRepository } from "../repositories/in-memory-participant-repository.ts";
import { StorageApplicationRepositoryFactory } from "../repositories/storage-application-repository-factory.ts";
import {
  StorageParticipantInvestmentInterestRepository,
  initializeParticipantInvestmentOwnership,
} from "../repositories/storage-participant-investment-repository.ts";
import { createParticipantInvestmentInterestService } from "../worker/investment-interest-service.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";
import { testParticipantRegistrationNoticeEvidence } from "./support/participant-registration-notice-evidence.ts";

const REGISTERED_AT = "2026-08-12T08:00:00.000Z";
const ACCOUNT = participantAccount(
  "oidc:registration-ownership-participant",
  "participant@example.test",
);
const OPERATION_ID = "participant-operation:registration-with-ownership";

test("first application registration atomically provisions empty ownership", async () => {
  const state = new MemoryStorageState();
  const factory = applicationFactory(new MemoryStorageAdapter(state));
  const request = registrationRequest();

  const [first, concurrentReplay] = await Promise.all([
    factory.participantRepository(ACCOUNT).register(request),
    factory.participantRepository(ACCOUNT).register(request),
  ]);

  assert.deepEqual(
    [first.replayed, concurrentReplay.replayed].sort(),
    [false, true],
  );
  assert.deepEqual(first.snapshot, concurrentReplay.snapshot);
  assert.equal(state.operations.size, 1);
  assert.deepEqual(collectionCounts(state), {
    "investment-indication-ownership-witnesses": 1,
    "participant-investment-indexes": 1,
    "participant-investment-ownership-roots": 1,
    "private-participant-profile-revisions": 1,
    "private-participant-profiles": 1,
  });
  const root = onlyRecord(
    state,
    "participant-investment-ownership-roots",
  );
  assert.equal(root.value.operationId, OPERATION_ID);
  assert.equal(root.revision, 1);
  assert.deepEqual(
    await initializeParticipantInvestmentOwnership(
      new MemoryStorageAdapter(state),
      ACCOUNT.subject,
      { operationId: OPERATION_ID, indications: [] },
    ),
    { replayed: true, indicationCount: 0, activeCount: 0 },
  );
});

test("maximum registration and ownership transaction fits storage ceilings", async () => {
  const maximumNotice = "\u754c".repeat(4_000);
  const account = participantAccount(
    "\u754c".repeat(255),
    `${"\u754c".repeat(250)}@x.x`,
  );
  const state = new MemoryStorageState();
  const storage = new RecordingTransactionAdapter(
    new MemoryStorageAdapter(state),
  );
  const evidence = testParticipantRegistrationNoticeEvidence(
    Number.MAX_SAFE_INTEGER,
    { processEmail: maximumNotice, marketing: maximumNotice },
  );

  await applicationFactory(storage).participantRepository(account).register({
    operationId: "r".repeat(127),
    expectedRevision: null,
    registeredAt: REGISTERED_AT,
    registration: Object.freeze({
      displayName: "\u754c".repeat(120),
      country: "fi",
      declaredInterest: "both",
      participationContext: "individual",
      processEmailNoticeAcknowledged: true,
      marketingConsent: true,
    }),
    noticeEvidence: evidence,
  });

  const transaction = storage.lastTransaction;
  assert(transaction);
  assert.equal(transaction.mutations.length, 5);
  assert.equal(state.records.size, 5);
  assert.equal(
    new TextEncoder().encode(JSON.stringify(transaction)).byteLength <= 64_512,
    true,
  );
  assert.equal(
    new TextEncoder().encode(JSON.stringify(
      toStorageProtocolTransactionCommand(transaction),
    )).byteLength <= 65_536,
    true,
  );
  assert.equal(
    [...state.records.values()].every(({ value }) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= 30_000
    ),
    true,
  );
});

test("delayed registration replay authenticates later ownership activity", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const factory = applicationFactory(storage);
  const request = registrationRequest();
  const first = await factory.participantRepository(ACCOUNT).register(request);
  assert.equal(first.replayed, false);

  const amount = amountConfiguration();
  const investment = new StorageParticipantInvestmentInterestRepository(
    storage,
    ACCOUNT.subject,
    amount,
  );
  const context = await acknowledgmentContext(ACCOUNT.subject);
  const service = createParticipantInvestmentInterestService({
    actorSubject: ACCOUNT.subject,
    amountConfiguration: amount,
    reader: investment,
    mutations: investment,
    loadAcknowledgmentContext: () => context,
    loadPermissions: () => ({
      createPersonal: true,
      createCompany: true,
      edit: true,
      reactivatePersonal: true,
      reactivateCompany: true,
    }),
    indicationIdForOperation: () => indicationId(
      "investment-indication:registration-ownership",
    ),
    now: () => new Date("2026-08-12T09:00:00.000Z"),
  });
  const created = await service.create({
    operationId: "investment-operation:registration-ownership",
    fields: {
      kind: "personal",
      residenceCountry: "FI",
      amount: 1_250,
      availabilityPeriod: "Within twelve months.",
      note: "Private registration ownership proof.",
    },
  });
  assert.equal(created.snapshot.lifecycle.status, "active");
  const operationCount = state.operations.size;
  const recordCount = state.records.size;

  const replay = await applicationFactory(
    new MemoryStorageAdapter(state),
  ).participantRepository(ACCOUNT).register(request);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.snapshot, first.snapshot);
  assert.equal(state.operations.size, operationCount);
  assert.equal(state.records.size, recordCount);
  assert.equal(
    onlyRecord(state, "investment-indication-ownership-witnesses")
      .value.revision,
    2,
  );
});

test("an existing legacy profile is never treated as empty ownership", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const request = registrationRequest();
  await new StorageParticipantRepository(storage, ACCOUNT).register(request);
  const before = stateFingerprint(state);
  const provisioned = applicationFactory(storage).participantRepository(ACCOUNT);

  const exactFailure = await captureStorageFailure(() =>
    provisioned.register(request)
  );
  const changedFailure = await captureStorageFailure(() =>
    provisioned.register({
      ...request,
      operationId: "participant-operation:changed-existing-profile",
    })
  );

  assert.equal(exactFailure.code, "UNAVAILABLE");
  assert.equal(changedFailure.code, "CONFLICT");
  assert.equal(stateFingerprint(state), before);
  assert.equal(
    recordsIn(state, "participant-investment-ownership-roots").length,
    0,
  );
});

test("ownership conflicts and transaction failures leave no profile", async () => {
  await test("pre-existing ownership root", async () => {
    const state = new MemoryStorageState();
    const storage = new MemoryStorageAdapter(state);
    await initializeParticipantInvestmentOwnership(
      storage,
      ACCOUNT.subject,
      {
        operationId: "investment-ownership-initialization:pre-existing",
        indications: [],
      },
    );
    const before = stateFingerprint(state);
    const failure = await captureStorageFailure(() =>
      applicationFactory(storage).participantRepository(ACCOUNT).register(
        registrationRequest(),
      )
    );
    assert.equal(failure.code, "CONFLICT");
    assert.equal(stateFingerprint(state), before);
    assert.equal(recordsIn(state, "private-participant-profiles").length, 0);
  });

  await test("adapter rejection", async () => {
    const state = new MemoryStorageState();
    const base = new MemoryStorageAdapter(state);
    const failure = await captureStorageFailure(() =>
      applicationFactory(new RejectingTransactionAdapter(base))
        .participantRepository(ACCOUNT)
        .register(registrationRequest())
    );
    assert.equal(failure.code, "UNAVAILABLE");
    assert.equal(state.records.size, 0);
    assert.equal(state.operations.size, 0);
  });
});

test("unknown and malformed commit results recover only through exact retry", async () => {
  for (const mode of ["throw", "malformed"] as const) {
    await test(mode, async () => {
      const state = new MemoryStorageState();
      const base = new MemoryStorageAdapter(state);
      const storage = new CommitResultTransformAdapter(base, mode);
      const request = registrationRequest();
      const failure = await captureStorageFailure(() =>
        applicationFactory(storage).participantRepository(ACCOUNT).register(
          request,
        )
      );
      assert.equal(failure.code, "UNAVAILABLE");
      assert.equal(state.records.size, 5);
      assert.equal(state.operations.size, 1);

      const replay = await applicationFactory(new MemoryStorageAdapter(state))
        .participantRepository(ACCOUNT)
        .register(request);
      assert.equal(replay.replayed, true);
      assert.equal(state.records.size, 5);
      assert.equal(state.operations.size, 1);
    });
  }
});

test("corrupt registration ownership replay is fixed and non-disclosing", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const repository = applicationFactory(storage).participantRepository(ACCOUNT);
  await repository.register(registrationRequest());
  const [identity, root] = recordEntry(
    state,
    "participant-investment-ownership-roots",
  );
  state.records.set(identity, Object.freeze({
    ...root,
    value: Object.freeze({
      ...root.value,
      operationId: "participant-operation:crossed-owner",
    }),
  }));

  const failure = await captureStorageFailure(() =>
    applicationFactory(new MemoryStorageAdapter(state))
      .participantRepository(ACCOUNT)
      .register(registrationRequest())
  );
  assert.equal(failure.code, "CONFLICT");
  assert.doesNotMatch(
    JSON.stringify(toPublicStorageFailure(failure)),
    /registration-ownership-participant|participant@example\.test|crossed/iu,
  );
});

test("ownership replay adapter failures are fresh and non-disclosing", async () => {
  const state = new MemoryStorageState();
  const request = registrationRequest();
  await applicationFactory(new MemoryStorageAdapter(state))
    .participantRepository(ACCOUNT)
    .register(request);
  const storage = new SecretOwnershipReadFailureAdapter(
    new MemoryStorageAdapter(state),
  );
  const before = stateFingerprint(state);

  const failure = await captureStorageFailure(() =>
    applicationFactory(storage)
      .participantRepository(ACCOUNT)
      .register(request)
  );

  assert.equal(failure.code, "UNAVAILABLE");
  assert.equal(failure.message, "Storage is temporarily unavailable.");
  assert.notEqual(failure, storage.failure);
  assert.equal(Object.hasOwn(failure, "cause"), false);
  assert.doesNotMatch(
    `${failure.name}:${failure.message}:${JSON.stringify(
      toPublicStorageFailure(failure),
    )}`,
    /PRIVATE_PROVIDER_BODY|registration-ownership-participant|participant@example\.test/iu,
  );
  assert.equal(stateFingerprint(state), before);
});

test("distinct malformed subjects cannot register or collide in ownership storage", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const malformedSubjects = [
    "oidc:registration:\uD800",
    "oidc:registration:\uDC00",
  ];

  assert.notEqual(malformedSubjects[0], malformedSubjects[1]);
  assert.deepEqual(
    [...new TextEncoder().encode(malformedSubjects[0] ?? "")],
    [...new TextEncoder().encode(malformedSubjects[1] ?? "")],
  );

  for (const [index, subject] of malformedSubjects.entries()) {
    const failure = await captureStorageFailure(() =>
      applicationFactory(storage)
        .participantRepository({
          subject,
          accountEmailLabel: `malformed-${index}@example.test`,
        } as unknown as ParticipantAccount)
        .register({
          ...registrationRequest(),
          operationId: `participant-operation:malformed-subject-${index}`,
        })
    );
    assert.equal(failure.code, "INVALID_REQUEST");
    assert.equal(state.records.size, 0);
    assert.equal(state.operations.size, 0);
  }
});

function applicationFactory(storage: StorageAdapter) {
  return new StorageApplicationRepositoryFactory(
    storage,
    () => new Date("2026-08-12T10:00:00.000Z"),
  );
}

function registrationRequest() {
  return Object.freeze({
    operationId: OPERATION_ID,
    expectedRevision: null,
    registeredAt: REGISTERED_AT,
    registration: Object.freeze({
      displayName: "Registration Owner",
      country: "fi",
      declaredInterest: "both",
      participationContext: "individual",
      processEmailNoticeAcknowledged: true,
      marketingConsent: false,
    }),
    noticeEvidence: testParticipantRegistrationNoticeEvidence(),
  });
}

function participantAccount(
  subject: string,
  accountEmailLabel: string,
): ParticipantAccount {
  const parsed = parseParticipantAccount({ subject, accountEmailLabel });
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function amountConfiguration() {
  const parsed = parseAmountAggregateConfiguration({
    amount: {
      currency: "EUR",
      minimum: 1_000,
      increment: 250,
      maximum: 10_000,
    },
    publicAggregate: { visibility: "hidden" },
  });
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value.amount;
}

async function acknowledgmentContext(subject: ActorSubject) {
  const version = await createPackageVersion({
    id: "package-version:registration-ownership",
    createdAt: "2026-08-12T07:00:00.000Z",
    changeSummary: "Registration ownership test package.",
    materialChange: false,
    acknowledgmentText: "This indication is non-binding.",
    sections: [{
      id: "package-section:registration-ownership",
      order: 0,
      title: "Overview",
      markdown: "Synthetic package content.",
      enabled: true,
    }],
  }, null);
  if (!version.ok) assert.fail(JSON.stringify(version.issues));
  const acceptance = createPackageAcceptance({
    id: "package-acceptance:registration-ownership",
    participantSubject: subject,
    acceptedAt: "2026-08-12T07:30:00.000Z",
  }, version.value);
  if (!acceptance.ok) assert.fail(JSON.stringify(acceptance.issues));
  return Object.freeze({
    currentVersion: version.value,
    latestAcceptance: acceptance.value,
  });
}

function indicationId(value: string): InvestmentIndicationId {
  const parsed = parseStableId<"investment-indication">(value);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function recordsIn(state: MemoryStorageState, collection: string) {
  return [...state.records.values()].filter((record) =>
    record.key.collection === collection
  );
}

function onlyRecord(state: MemoryStorageState, collection: string) {
  const records = recordsIn(state, collection);
  assert.equal(records.length, 1, collection);
  const record = records[0];
  assert(record);
  return record;
}

function recordEntry(
  state: MemoryStorageState,
  collection: string,
): readonly [string, StorageRecord] {
  const entry = [...state.records.entries()].find(([, record]) =>
    record.key.collection === collection
  );
  assert(entry);
  return entry;
}

function collectionCounts(state: MemoryStorageState) {
  return Object.fromEntries(
    [...state.records.values()]
      .map((record) => record.key.collection)
      .sort()
      .reduce((counts, collection) => {
        counts.set(collection, (counts.get(collection) ?? 0) + 1);
        return counts;
      }, new Map<string, number>()),
  );
}

function stateFingerprint(state: MemoryStorageState): string {
  return JSON.stringify({
    records: [...state.records.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    ),
    operations: [...state.operations.keys()].sort(),
  });
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
  assert.fail("Expected StorageFailure.");
}

class RejectingTransactionAdapter implements StorageAdapter {
  readonly delegate: StorageAdapter;

  constructor(delegate: StorageAdapter) {
    this.delegate = delegate;
  }
  read(key: Parameters<StorageAdapter["read"]>[0]) {
    return this.delegate.read(key);
  }
  list(request: Parameters<StorageAdapter["list"]>[0]) {
    return this.delegate.list(request);
  }
  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    void request;
    throw new StorageFailure("UNAVAILABLE");
  }
}

class RecordingTransactionAdapter implements StorageAdapter {
  readonly delegate: StorageAdapter;
  lastTransaction: StorageTransactionRequest | null = null;

  constructor(delegate: StorageAdapter) {
    this.delegate = delegate;
  }
  read(key: Parameters<StorageAdapter["read"]>[0]) {
    return this.delegate.read(key);
  }
  list(request: Parameters<StorageAdapter["list"]>[0]) {
    return this.delegate.list(request);
  }
  transact(request: StorageTransactionRequest) {
    this.lastTransaction = request;
    return this.delegate.transact(request);
  }
}

class SecretOwnershipReadFailureAdapter implements StorageAdapter {
  readonly delegate: StorageAdapter;
  readonly failure = new Error(
    "PRIVATE_PROVIDER_BODY oidc:registration-ownership-participant participant@example.test",
    { cause: new Error("PRIVATE_PROVIDER_CAUSE") },
  );

  constructor(delegate: StorageAdapter) {
    this.delegate = delegate;
  }
  read(key: Parameters<StorageAdapter["read"]>[0]) {
    if (key.collection === "participant-investment-ownership-roots") {
      throw this.failure;
    }
    return this.delegate.read(key);
  }
  list(request: Parameters<StorageAdapter["list"]>[0]) {
    return this.delegate.list(request);
  }
  transact(request: StorageTransactionRequest) {
    return this.delegate.transact(request);
  }
}

class CommitResultTransformAdapter implements StorageAdapter {
  readonly delegate: StorageAdapter;
  readonly mode: "throw" | "malformed";

  constructor(
    delegate: StorageAdapter,
    mode: "throw" | "malformed",
  ) {
    this.delegate = delegate;
    this.mode = mode;
  }
  read(key: Parameters<StorageAdapter["read"]>[0]) {
    return this.delegate.read(key);
  }
  list(request: Parameters<StorageAdapter["list"]>[0]) {
    return this.delegate.list(request);
  }
  async transact(request: StorageTransactionRequest) {
    const result = await this.delegate.transact(request);
    if (this.mode === "throw") throw new StorageFailure("UNAVAILABLE");
    return Object.freeze({
      replayed: result.replayed,
      records: Object.freeze([...result.records].reverse()),
    }) as StorageTransactionResult;
  }
}
