import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAmountAggregateConfiguration,
  type AmountConfiguration,
} from "../domain/amount-aggregate-configuration.ts";
import {
  parseActorSubject,
  parseStableId,
  type ActorSubject,
} from "../domain/foundation.ts";
import {
  MAX_INVESTMENT_INDICATION_REVISIONS,
  type InvestmentIndicationParsingOptions,
  type InvestmentIndicationId,
  type TrustedPackageAcknowledgmentContext,
} from "../domain/investment-indication.ts";
import {
  createPackageAcceptance,
  createPackageVersion,
  type PackageAcceptanceRecord,
  type PackageVersion,
} from "../domain/package-content.ts";
import {
  StorageFailure,
  assertStorageListBoundary,
  assertStorageTransactionBoundary,
  parseStorageKey,
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
  DevelopmentInMemoryIndicationRepository,
  MAX_INDICATION_CANONICAL_DEPTH,
  MAX_INDICATION_CANONICAL_NODES,
  MAX_INDICATION_FIELDS_CHUNKS,
  MAX_INDICATION_MATERIALIZATION_READS,
  MAX_INDICATION_STORAGE_MUTATIONS,
  MAX_INDICATION_STORAGE_READS,
  MAX_INDICATION_STORAGE_RECORD_BYTES,
  MAX_INDICATION_STORAGE_TRANSACTION_BYTES,
  type CreateIndicationRequest,
  type EditIndicationRequest,
  type IndicationRepository,
  type ReactivateIndicationRequest,
  type RejectIndicationRequest,
  type WithdrawIndicationRequest,
} from "../repositories/in-memory-indication-repository.ts";

const ALICE_SUBJECT = actorSubject("issuer.invalid/subject:alice-indicator");
const BOB_SUBJECT = actorSubject("issuer.invalid/subject:bob-indicator");
const OWNER_SUBJECT = actorSubject("issuer.invalid/subject:configured-owner");
const NEXT_OWNER_SUBJECT = actorSubject(
  "issuer.invalid/subject:next-configured-owner",
);
const PERSONAL_ONE = indicationId("indication:personal:alice-one");
const PERSONAL_TWO = indicationId("indication:personal:alice-two");
const COMPANY_ONE = indicationId("indication:company:alice-one");
const COMPANY_TWO = indicationId("indication:company:bob-two");
const amountConfiguration = configuredAmount();

export type IndicationRepositoryContractFixture = Readonly<{
  alice: IndicationRepository;
  reopenAlice: () => IndicationRepository;
  bob: IndicationRepository;
  reopenBob: () => IndicationRepository;
  owner: IndicationRepository;
  anonymous: IndicationRepository;
  deniedAlice: IndicationRepository;
  missingAlice: IndicationRepository;
  unrelatedEvidence: () => string;
}>;

export type IndicationRepositoryContractFactory =
  () => IndicationRepositoryContractFixture;

/** Reusable behavior contract for development and production indication stores. */
export async function verifyIndicationRepositoryContract(
  createFixture: IndicationRepositoryContractFactory,
): Promise<void> {
  const fixture = createFixture();
  const unrelatedBefore = fixture.unrelatedEvidence();
  const contexts = await packageContexts();

  await rejectsStorage(
    () => fixture.alice.create(
      createRequest({
        operationId: "indication-operation:blocked-create",
        id: "indication:personal:blocked",
        occurredAt: "2026-08-10T10:00:00.000Z",
        historyEntryId: "indication-history:blocked-create",
        fields: personalFields(),
      }),
      contexts.aliceStale,
    ),
    "PRECONDITION_FAILED",
  );

  const mutableCreateFields = personalFields();
  const createPersonal = createRequest({
    operationId: "indication-operation:personal-create",
    id: PERSONAL_ONE,
    occurredAt: "2026-08-09T09:00:00.000Z",
    historyEntryId: "indication-history:personal-create",
    fields: mutableCreateFields,
  }) as CreateIndicationRequest & Readonly<{ participantSubject: ActorSubject }>;
  Object.assign(createPersonal, { participantSubject: BOB_SUBJECT });

  const created = await fixture.alice.create(
    createPersonal,
    contexts.aliceInitial,
  );
  const createReplay = await fixture.alice.create(
    createPersonal,
    contexts.aliceInitial,
  );
  assert.equal(created.replayed, false);
  assert.equal(createReplay.replayed, true);
  assert.equal(created.revision, 1);
  assert.equal(created.snapshot.participantSubject, ALICE_SUBJECT);
  assert.equal(created.snapshot.lifecycle.status, "active");
  assert.equal(created.snapshot.history[0]?.transition, "created");
  assert.deepEqual(createReplay.snapshot, created.snapshot);
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(created.snapshot), true);
  assert.equal(Object.isFrozen(created.snapshot.history), true);
  assert.deepEqual(await fixture.reopenAlice().get(PERSONAL_ONE), created.snapshot);

  mutableCreateFields.note = "Changed retry content.";
  await rejectsStorage(
    () => fixture.alice.create(createPersonal, contexts.aliceInitial),
    "CONFLICT",
  );
  assert.equal(
    (await fixture.alice.get(PERSONAL_ONE))?.history[0]?.fields.note,
    "Initial personal note.",
  );

  await rejectsStorage(
    () => fixture.alice.create(
      createRequest({
        operationId: "indication-operation:personal-duplicate-active",
        id: PERSONAL_TWO,
        occurredAt: "2026-08-10T09:45:00.000Z",
        historyEntryId: "indication-history:personal-duplicate-active",
        fields: personalFields({ amount: 1_500 }),
      }),
      contexts.aliceCurrent,
    ),
    "CONFLICT",
  );
  assert.equal(await fixture.alice.get(PERSONAL_TWO), null);

  const blockedEdit = editRequest({
    operationId: "indication-operation:blocked-edit",
    id: PERSONAL_ONE,
    expectedRevision: 1,
    occurredAt: "2026-08-10T10:00:00.000Z",
    historyEntryId: "indication-history:blocked-edit",
    fields: personalFields({ note: "Must not persist." }),
  });
  await rejectsStorage(
    () => fixture.alice.edit(blockedEdit, contexts.aliceStale),
    "PRECONDITION_FAILED",
  );

  const editPersonal = editRequest({
    operationId: "indication-operation:personal-edit",
    id: PERSONAL_ONE,
    expectedRevision: 1,
    occurredAt: "2026-08-10T10:15:00.000Z",
    historyEntryId: "indication-history:personal-edit",
    fields: personalFields({
      amount: 1_500,
      note: "Edited personal note.",
    }),
  });
  const edited = await fixture.alice.edit(editPersonal, contexts.aliceCurrent);
  const editReplay = await fixture.reopenAlice().edit(
    editPersonal,
    contexts.aliceCurrent,
  );
  assert.equal(edited.revision, 2);
  assert.equal(edited.replayed, false);
  assert.equal(editReplay.replayed, true);
  assert.equal(edited.snapshot.history[1]?.transition, "edited");
  assert.deepEqual(edited.snapshot.history[0], created.snapshot.history[0]);
  assert.equal(created.snapshot.fields.note, "Initial personal note.");

  await rejectsStorage(
    () => fixture.alice.edit(
      { ...editPersonal, fields: personalFields({ note: "Changed edit retry." }) },
      contexts.aliceCurrent,
    ),
    "CONFLICT",
  );
  await rejectsStorage(
    () => fixture.alice.edit(
      editRequest({
        operationId: "indication-operation:personal-stale-edit",
        id: PERSONAL_ONE,
        expectedRevision: 1,
        occurredAt: "2026-08-10T10:30:00.000Z",
        historyEntryId: "indication-history:personal-stale-edit",
        fields: personalFields({ note: "Stale edit." }),
      }),
      contexts.aliceCurrent,
    ),
    "PRECONDITION_FAILED",
  );

  const withdrawPersonal = withdrawRequest({
    operationId: "indication-operation:personal-withdraw",
    id: PERSONAL_ONE,
    expectedRevision: 2,
    occurredAt: "2026-08-10T11:00:00.000Z",
    historyEntryId: "indication-history:personal-withdraw",
  });
  const withdrawn = await fixture.alice.withdraw(withdrawPersonal);
  const withdrawReplay = await fixture.reopenAlice().withdraw(withdrawPersonal);
  assert.equal(withdrawn.revision, 3);
  assert.equal(withdrawn.snapshot.lifecycle.status, "withdrawn");
  assert.equal(withdrawReplay.replayed, true);
  assert.deepEqual(
    withdrawn.snapshot.history.map((entry) => entry.transition),
    ["created", "edited", "withdrawn"],
  );

  const delayedCreateReplay = await fixture.alice.create(
    { ...createPersonal, fields: personalFields() },
    contexts.aliceStale,
  );
  assert.equal(delayedCreateReplay.replayed, true);
  assert.equal(delayedCreateReplay.revision, 1);
  assert.equal(delayedCreateReplay.snapshot.lifecycle.status, "active");

  const createSecondPersonal = createRequest({
    operationId: "indication-operation:personal-second-create",
    id: PERSONAL_TWO,
    occurredAt: "2026-08-10T11:15:00.000Z",
    historyEntryId: "indication-history:personal-second-create",
    fields: personalFields({ amount: 1_750, note: "Second personal record." }),
  });
  const secondPersonal = await fixture.alice.create(
    createSecondPersonal,
    contexts.aliceCurrent,
  );
  assert.equal(secondPersonal.snapshot.lifecycle.status, "active");

  const reactivatePersonal = reactivateRequest({
    operationId: "indication-operation:personal-reactivate",
    id: PERSONAL_ONE,
    expectedRevision: 3,
    occurredAt: "2026-08-10T11:45:00.000Z",
    historyEntryId: "indication-history:personal-reactivate",
  });
  await rejectsStorage(
    () => fixture.alice.reactivate(reactivatePersonal, contexts.aliceStale),
    "PRECONDITION_FAILED",
  );
  await rejectsStorage(
    () => fixture.alice.reactivate(reactivatePersonal, contexts.aliceCurrent),
    "CONFLICT",
  );

  await fixture.alice.withdraw(withdrawRequest({
    operationId: "indication-operation:personal-second-withdraw",
    id: PERSONAL_TWO,
    expectedRevision: 1,
    occurredAt: "2026-08-10T12:00:00.000Z",
    historyEntryId: "indication-history:personal-second-withdraw",
  }));
  const reactivated = await fixture.alice.reactivate(
    reactivatePersonal,
    contexts.aliceCurrent,
  );
  const reactivationReplay = await fixture.reopenAlice().reactivate(
    reactivatePersonal,
    contexts.aliceStale,
  );
  assert.equal(reactivated.revision, 4);
  assert.equal(reactivated.snapshot.lifecycle.status, "active");
  assert.equal(reactivationReplay.replayed, true);
  assert.equal(reactivationReplay.revision, 4);
  await rejectsStorage(
    () => fixture.alice.reactivate(
      {
        ...reactivatePersonal,
        occurredAt: "2026-08-10T12:01:00.000Z",
      },
      contexts.aliceCurrent,
    ),
    "CONFLICT",
  );

  const createCompanyOne = createRequest({
    operationId: "indication-operation:company-alice-create",
    id: COMPANY_ONE,
    occurredAt: "2026-08-11T09:00:00.000Z",
    historyEntryId: "indication-history:company-alice-create",
    fields: companyFields({
      companyName: "First private company",
      registrationCountry: "fi",
      companyIdentifier: " fi 123 456 ",
    }),
  });
  const companyOne = await fixture.alice.create(
    createCompanyOne,
    contexts.aliceCurrent,
  );
  assert.equal(companyOne.snapshot.kind, "company");
  if (companyOne.snapshot.kind !== "company") assert.fail("Expected company.");
  assert.equal(companyOne.snapshot.fields.registrationCountry, "FI");
  assert.equal(companyOne.snapshot.fields.companyIdentifier, "FI123456");

  const createCompanyTwo = createRequest({
    operationId: "indication-operation:company-bob-create",
    id: COMPANY_TWO,
    occurredAt: "2026-08-11T09:15:00.000Z",
    historyEntryId: "indication-history:company-bob-create",
    fields: companyFields({
      companyName: "Different display name",
      registrationCountry: "FI",
      companyIdentifier: "FI123456",
    }),
  });
  const duplicateFailure = await captureStorageFailure(() =>
    fixture.bob.create(createCompanyTwo, contexts.bobCurrent)
  );
  assert.equal(duplicateFailure.code, "CONFLICT");
  const duplicatePublic = JSON.stringify(toPublicStorageFailure(duplicateFailure));
  assert.doesNotMatch(
    duplicatePublic,
    /FI123456|First private company|alice-indicator|company:alice-one/u,
  );
  assert.equal(await fixture.bob.get(COMPANY_TWO), null);

  await fixture.alice.withdraw(withdrawRequest({
    operationId: "indication-operation:company-alice-withdraw",
    id: COMPANY_ONE,
    expectedRevision: 1,
    occurredAt: "2026-08-11T09:30:00.000Z",
    historyEntryId: "indication-history:company-alice-withdraw",
  }));
  const companyTwo = await fixture.bob.create(
    createCompanyTwo,
    contexts.bobCurrent,
  );
  assert.equal(companyTwo.snapshot.participantSubject, BOB_SUBJECT);

  const reactivateCompanyOne = reactivateRequest({
    operationId: "indication-operation:company-alice-reactivate",
    id: COMPANY_ONE,
    expectedRevision: 2,
    occurredAt: "2026-08-11T10:00:00.000Z",
    historyEntryId: "indication-history:company-alice-reactivate",
  });
  await rejectsStorage(
    () => fixture.alice.reactivate(
      reactivateCompanyOne,
      contexts.aliceCurrent,
    ),
    "CONFLICT",
  );

  const rejection = rejectRequest({
    operationId: "indication-operation:company-owner-reject",
    id: COMPANY_TWO,
    expectedRevision: 1,
    occurredAt: "2026-08-11T10:15:00.000Z",
    historyEntryId: "indication-history:company-owner-reject",
    reason: "The indication is outside the configured review scope.",
  });
  const nonOwnerFailure = await captureStorageFailure(() =>
    fixture.alice.reject(rejection)
  );
  assert.equal(nonOwnerFailure.code, "NOT_FOUND");

  const rejected = await fixture.owner.reject(rejection);
  const rejectionReplay = await fixture.owner.reject(rejection);
  assert.equal(rejected.revision, 2);
  assert.equal(rejected.snapshot.lifecycle.status, "rejected");
  assert.equal(rejected.snapshot.history[1]?.transition, "rejected");
  assert.equal(rejected.snapshot.history[1]?.actor.type, "owner");
  assert.equal(rejectionReplay.replayed, true);
  assert.deepEqual(await fixture.reopenBob().get(COMPANY_TWO), rejected.snapshot);
  assert.deepEqual(await fixture.owner.get(COMPANY_TWO), rejected.snapshot);
  await rejectsStorage(
    () => fixture.owner.reject({ ...rejection, reason: "Changed retry reason." }),
    "CONFLICT",
  );
  await rejectsStorage(
    () => fixture.owner.reject(rejectRequest({
      operationId: "indication-operation:company-owner-stale-reject",
      id: COMPANY_TWO,
      expectedRevision: 1,
      occurredAt: "2026-08-11T10:30:00.000Z",
      historyEntryId: "indication-history:company-owner-stale-reject",
      reason: "Stale owner action.",
    })),
    "PRECONDITION_FAILED",
  );

  const companyOneReactivated = await fixture.alice.reactivate(
    reactivateCompanyOne,
    contexts.aliceCurrent,
  );
  assert.equal(companyOneReactivated.revision, 3);
  const editCompanyOne = editRequest({
    operationId: "indication-operation:company-alice-edit",
    id: COMPANY_ONE,
    expectedRevision: 3,
    occurredAt: "2026-08-11T10:45:00.000Z",
    historyEntryId: "indication-history:company-alice-edit",
    fields: companyFields({
      companyName: "First private company",
      registrationCountry: "FI",
      companyIdentifier: "FI-987",
    }),
  });
  const editedCompany = await fixture.alice.edit(
    editCompanyOne,
    contexts.aliceCurrent,
  );
  assert.equal(editedCompany.revision, 4);

  const oldKeyReacquired = await fixture.bob.create(
    createRequest({
      operationId: "indication-operation:company-old-key-reacquire",
      id: "indication:company:bob-old-key",
      occurredAt: "2026-08-11T11:00:00.000Z",
      historyEntryId: "indication-history:company-old-key-reacquire",
      fields: companyFields({ companyIdentifier: "FI 123 456" }),
    }),
    contexts.bobCurrent,
  );
  assert.equal(oldKeyReacquired.snapshot.lifecycle.status, "active");
  await rejectsStorage(
    () => fixture.bob.create(
      createRequest({
        operationId: "indication-operation:company-new-key-duplicate",
        id: "indication:company:bob-new-key-duplicate",
        occurredAt: "2026-08-11T11:15:00.000Z",
        historyEntryId: "indication-history:company-new-key-duplicate",
        fields: companyFields({ companyIdentifier: " fi-987 " }),
      }),
      contexts.bobCurrent,
    ),
    "CONFLICT",
  );

  assert.equal(await fixture.bob.get(PERSONAL_ONE), null);
  assert.equal(await fixture.anonymous.get(PERSONAL_ONE), null);
  assert.equal(await fixture.deniedAlice.get(PERSONAL_ONE), null);
  assert.equal(await fixture.missingAlice.get(PERSONAL_ONE), null);
  assert.deepEqual(await fixture.owner.get(PERSONAL_ONE), reactivated.snapshot);

  const foreignWrite = await captureStorageFailure(() =>
    fixture.bob.edit(
      editRequest({
        operationId: "indication-operation:foreign-edit",
        id: PERSONAL_ONE,
        expectedRevision: 4,
        occurredAt: "2026-08-11T12:00:00.000Z",
        historyEntryId: "indication-history:foreign-edit",
        fields: personalFields({ note: "Foreign private edit." }),
      }),
      contexts.bobCurrent,
    )
  );
  const missingWrite = await captureStorageFailure(() =>
    fixture.missingAlice.edit(
      editRequest({
        operationId: "indication-operation:missing-edit",
        id: PERSONAL_ONE,
        expectedRevision: 4,
        occurredAt: "2026-08-11T12:00:00.000Z",
        historyEntryId: "indication-history:missing-edit",
        fields: personalFields({ note: "Missing private edit." }),
      }),
      contexts.aliceCurrent,
    )
  );
  const deniedWrite = await captureStorageFailure(() =>
    fixture.deniedAlice.withdraw(withdrawRequest({
      operationId: "indication-operation:denied-withdraw",
      id: PERSONAL_ONE,
      expectedRevision: 4,
      occurredAt: "2026-08-11T12:00:00.000Z",
      historyEntryId: "indication-history:denied-withdraw",
    }))
  );
  const anonymousWrite = await captureStorageFailure(() =>
    fixture.anonymous.create(
      createRequest({
        operationId: "indication-operation:anonymous-create",
        id: "indication:personal:anonymous",
        occurredAt: "2026-08-11T12:00:00.000Z",
        historyEntryId: "indication-history:anonymous-create",
        fields: personalFields(),
      }),
      contexts.aliceCurrent,
    )
  );
  for (const failure of [
    foreignWrite,
    missingWrite,
    deniedWrite,
    anonymousWrite,
    nonOwnerFailure,
  ]) {
    assert.equal(failure.code, "NOT_FOUND");
    assert.deepEqual(
      toPublicStorageFailure(failure),
      toPublicStorageFailure(missingWrite),
    );
  }
  const foreignPublic = JSON.stringify(toPublicStorageFailure(foreignWrite));
  assert.doesNotMatch(
    foreignPublic,
    /Foreign private edit|personal:alice-one|alice-indicator/u,
  );
  assert.deepEqual(await fixture.alice.get(PERSONAL_ONE), reactivated.snapshot);
  assert.equal(fixture.unrelatedEvidence(), unrelatedBefore);
}

test("adapter-backed development repository passes the indication contract", async () => {
  await verifyIndicationRepositoryContract(() => {
    const state = new MemoryStorageState();
    seedUnrelatedRecords(state);
    const storage = new DeterministicMemoryStorageAdapter(state, true);
    return {
      alice: repository(storage, ALICE_SUBJECT),
      reopenAlice: () => repository(storage, ALICE_SUBJECT),
      bob: repository(storage, BOB_SUBJECT),
      reopenBob: () => repository(storage, BOB_SUBJECT),
      owner: repository(storage, OWNER_SUBJECT),
      anonymous: repository(storage, null),
      deniedAlice: repository(
        new DeterministicMemoryStorageAdapter(state, false),
        ALICE_SUBJECT,
      ),
      missingAlice: repository(
        new DeterministicMemoryStorageAdapter(new MemoryStorageState(), true),
        ALICE_SUBJECT,
      ),
      unrelatedEvidence: () => unrelatedEvidence(state),
    };
  });
});

test("foreign occupied history slots are indistinguishable from missing indications", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const contexts = await packageContexts();
  const alice = repository(storage, ALICE_SUBJECT);
  await alice.create(createRequest({
    operationId: "indication-operation:foreign-slot-create",
    id: PERSONAL_ONE,
    occurredAt: "2026-08-10T09:00:00.000Z",
    historyEntryId: "indication-history:foreign-slot-create",
    fields: personalFields(),
  }), contexts.aliceCurrent);
  await alice.edit(editRequest({
    operationId: "indication-operation:foreign-slot-edit",
    id: PERSONAL_ONE,
    expectedRevision: 1,
    occurredAt: "2026-08-10T10:00:00.000Z",
    historyEntryId: "indication-history:foreign-slot-edit",
    fields: personalFields({ note: "Occupied foreign revision." }),
  }), contexts.aliceCurrent);

  const request = editRequest({
    operationId: "indication-operation:foreign-slot-probe",
    id: PERSONAL_ONE,
    expectedRevision: 1,
    occurredAt: "2026-08-10T10:30:00.000Z",
    historyEntryId: "indication-history:foreign-slot-probe",
    fields: personalFields({ note: "Private probe." }),
  });
  const foreign = await captureStorageFailure(() =>
    repository(storage, BOB_SUBJECT).edit(request, contexts.bobCurrent)
  );
  const missing = await captureStorageFailure(() =>
    repository(
      new DeterministicMemoryStorageAdapter(new MemoryStorageState(), true),
      BOB_SUBJECT,
    ).edit(request, contexts.bobCurrent)
  );

  assert.equal(foreign.code, "NOT_FOUND");
  assert.equal(missing.code, "NOT_FOUND");
  assert.deepEqual(
    toPublicStorageFailure(foreign),
    toPublicStorageFailure(missing),
  );
});

test("current records require every immutable transition revision", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const alice = repository(storage, ALICE_SUBJECT);
  const contexts = await packageContexts();
  await alice.create(
    createRequest({
      operationId: "indication-operation:integrity-create",
      id: PERSONAL_ONE,
      occurredAt: "2026-08-10T09:00:00.000Z",
      historyEntryId: "indication-history:integrity-create",
      fields: personalFields(),
    }),
    contexts.aliceCurrent,
  );
  await alice.edit(
    editRequest({
      operationId: "indication-operation:integrity-edit",
      id: PERSONAL_ONE,
      expectedRevision: 1,
      occurredAt: "2026-08-10T10:00:00.000Z",
      historyEntryId: "indication-history:integrity-edit",
      fields: personalFields({ note: "Integrity edit." }),
    }),
    contexts.aliceCurrent,
  );

  const firstHistory = [...state.records.entries()].find(([, record]) =>
    record.key.collection === "investment-indication-history" &&
    record.value.kind === "investment-indication-transition" &&
    record.value.revision === 1
  );
  assert.notEqual(firstHistory, undefined);
  if (firstHistory === undefined) return;
  state.records.delete(firstHistory[0]);
  await rejectsStorage(() => alice.get(PERSONAL_ONE), "UNAVAILABLE");
});

test("persisted indication history survives amount configuration evolution", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const contexts = await packageContexts();
  const original = repository(storage, ALICE_SUBJECT);
  const create = createRequest({
    operationId: "indication-operation:historical-config-create",
    id: PERSONAL_ONE,
    occurredAt: "2026-08-10T09:00:00.000Z",
    historyEntryId: "indication-history:historical-config-create",
    fields: personalFields({ amount: 1_250 }),
  });
  await original.create(create, contexts.aliceCurrent);
  const edit = editRequest({
    operationId: "indication-operation:historical-config-edit",
    id: PERSONAL_ONE,
    expectedRevision: 1,
    occurredAt: "2026-08-10T10:00:00.000Z",
    historyEntryId: "indication-history:historical-config-edit",
    fields: personalFields({ amount: 1_500, note: "Historical EUR edit." }),
  });
  const historical = await original.edit(edit, contexts.aliceCurrent);

  const evolvedAmount = configuredAmount({
    currency: "usd",
    minimum: 5_000,
    increment: 1_000,
    maximum: 20_000,
  });
  const evolved = repository(storage, ALICE_SUBJECT, evolvedAmount);
  assert.deepEqual(await evolved.get(PERSONAL_ONE), historical.snapshot);

  const createReplay = await evolved.create(create, contexts.aliceCurrent);
  const editReplay = await evolved.edit(edit, contexts.aliceCurrent);
  assert.equal(createReplay.replayed, true);
  assert.equal(editReplay.replayed, true);
  assert.deepEqual(editReplay.snapshot, historical.snapshot);
  await rejectsStorage(
    () => evolved.edit({
      ...edit,
      fields: personalFields({
        amount: 1_750,
        note: "Changed historical retry.",
      }),
    }, contexts.aliceCurrent),
    "CONFLICT",
  );

  const current = await evolved.edit(editRequest({
    operationId: "indication-operation:evolved-config-edit",
    id: PERSONAL_ONE,
    expectedRevision: 2,
    occurredAt: "2026-08-10T11:00:00.000Z",
    historyEntryId: "indication-history:evolved-config-edit",
    fields: personalFields({ amount: 5_000, note: "Current USD edit." }),
  }), contexts.aliceCurrent);
  assert.equal(current.snapshot.history[1]?.fields.currency, "EUR");
  assert.equal(current.snapshot.history[2]?.fields.currency, "USD");
});

test("exact retries survive normalizer evolution without accepting changed raw input", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const contexts = await packageContexts();
  const originalOptions: InvestmentIndicationParsingOptions = Object.freeze({
    companyIdentifier: Object.freeze({
      normalize: () => "ORIGINAL-CANONICAL-ID",
    }),
  });
  const evolvedOptions: InvestmentIndicationParsingOptions = Object.freeze({
    companyIdentifier: Object.freeze({
      normalize: (value: string) =>
        value === "Changed raw spelling"
          ? "ORIGINAL-CANONICAL-ID"
          : "EVOLVED-CANONICAL-ID",
    }),
  });
  const request = createRequest({
    operationId: "indication-operation:normalizer-evolution",
    id: COMPANY_ONE,
    occurredAt: "2026-08-10T09:00:00.000Z",
    historyEntryId: "indication-history:normalizer-evolution",
    fields: companyFields({ companyIdentifier: "Original raw spelling" }),
  });
  const original = await repository(
    storage,
    ALICE_SUBJECT,
    amountConfiguration,
    originalOptions,
  ).create(request, contexts.aliceCurrent);
  assert.equal(original.snapshot.kind, "company");
  if (original.snapshot.kind !== "company") assert.fail("Expected company.");
  assert.equal(
    original.snapshot.fields.companyIdentifier,
    "ORIGINAL-CANONICAL-ID",
  );

  const evolved = repository(
    storage,
    ALICE_SUBJECT,
    amountConfiguration,
    evolvedOptions,
  );
  const replay = await evolved.create(request, contexts.aliceCurrent);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.snapshot, original.snapshot);
  await rejectsStorage(
    () => evolved.create({
      ...request,
      fields: companyFields({ companyIdentifier: "Changed raw spelling" }),
    }, contexts.aliceCurrent),
    "CONFLICT",
  );
});

test("historical request fingerprints are chained into immutable transition integrity", async () => {
  const contexts = await packageContexts();
  const parsingOptions: InvestmentIndicationParsingOptions = Object.freeze({
    companyIdentifier: Object.freeze({
      normalize: () => "SHARED-CANONICAL-ID",
    }),
  });
  const originalRequest = createRequest({
    operationId: "indication-operation:request-fingerprint-chain",
    id: COMPANY_ONE,
    occurredAt: "2026-08-10T09:00:00.000Z",
    historyEntryId: "indication-history:request-fingerprint-chain",
    fields: companyFields({ companyIdentifier: "Original raw identifier" }),
  });
  const changedRequest = {
    ...originalRequest,
    fields: companyFields({ companyIdentifier: "Altered raw identifier" }),
  };

  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const original = repository(
    storage,
    ALICE_SUBJECT,
    amountConfiguration,
    parsingOptions,
  );
  await original.create(originalRequest, contexts.aliceCurrent);
  await original.edit(editRequest({
    operationId: "indication-operation:request-fingerprint-chain-edit",
    id: COMPANY_ONE,
    expectedRevision: 1,
    occurredAt: "2026-08-10T10:00:00.000Z",
    historyEntryId: "indication-history:request-fingerprint-chain-edit",
    fields: companyFields({
      companyIdentifier: "Original raw identifier",
      note: "Keep revision one historical.",
    }),
  }), contexts.aliceCurrent);

  const changedState = new MemoryStorageState();
  await repository(
    new DeterministicMemoryStorageAdapter(changedState, true),
    ALICE_SUBJECT,
    amountConfiguration,
    parsingOptions,
  ).create(changedRequest, contexts.aliceCurrent);
  const changedFingerprint = requiredRecordWhere(
    changedState,
    "investment-indication-history",
    (record) => record.value.revision === 1,
  ).value.requestFingerprint;
  assert.match(String(changedFingerprint), /^sha256:[0-9a-f]{64}$/u);

  mutateStoredDocument(
    state,
    requiredRecordWhere(
      state,
      "investment-indication-history",
      (record) => record.value.revision === 1,
    ),
    (document) => {
      document.requestFingerprint = changedFingerprint;
    },
  );

  const reopened = repository(
    storage,
    ALICE_SUBJECT,
    amountConfiguration,
    parsingOptions,
  );
  await rejectsStorage(() => reopened.get(COMPANY_ONE), "UNAVAILABLE");
  await rejectsStorage(
    () => reopened.create(changedRequest, contexts.aliceCurrent),
    "UNAVAILABLE",
  );
});

test("owner rotation preserves historical rejection attribution and current authorization", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const contexts = await packageContexts();
  await repository(storage, ALICE_SUBJECT).create(createRequest({
    operationId: "indication-operation:owner-rotation-create",
    id: PERSONAL_ONE,
    occurredAt: "2026-08-10T09:00:00.000Z",
    historyEntryId: "indication-history:owner-rotation-create",
    fields: personalFields(),
  }), contexts.aliceCurrent);
  const rejection = rejectRequest({
    operationId: "indication-operation:owner-rotation-reject",
    id: PERSONAL_ONE,
    expectedRevision: 1,
    occurredAt: "2026-08-10T10:00:00.000Z",
    historyEntryId: "indication-history:owner-rotation-reject",
    reason: "Rejected before the configured owner changed.",
  });
  const rejected = await repository(storage, OWNER_SUBJECT).reject(rejection);

  const currentOwner = repository(
    storage,
    NEXT_OWNER_SUBJECT,
    amountConfiguration,
    {},
    NEXT_OWNER_SUBJECT,
  );
  const reopened = await currentOwner.get(PERSONAL_ONE);
  assert.deepEqual(reopened, rejected.snapshot);
  assert.equal(reopened?.history[1]?.actor.subject, OWNER_SUBJECT);
  assert.equal(
    reopened?.lifecycle.rejection?.rejectedBy.subject,
    OWNER_SUBJECT,
  );
  await rejectsStorage(() => currentOwner.reject(rejection), "CONFLICT");

  const formerOwner = repository(
    storage,
    OWNER_SUBJECT,
    amountConfiguration,
    {},
    NEXT_OWNER_SUBJECT,
  );
  assert.equal(await formerOwner.get(PERSONAL_ONE), null);
  await rejectsStorage(() => formerOwner.reject(rejection), "NOT_FOUND");
});

test("compact indication records reject current, transition, reference, and chunk corruption", async (t) => {
  const baseline = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(baseline, true);
  const contexts = await packageContexts();
  const alice = repository(storage, ALICE_SUBJECT);
  await alice.create(createRequest({
    operationId: "indication-operation:corruption-create",
    id: PERSONAL_ONE,
    occurredAt: "2026-08-10T09:00:00.000Z",
    historyEntryId: "indication-history:corruption-create",
    fields: maximumPersonalFields("\u0800"),
  }), contexts.aliceCurrent);
  await alice.edit(editRequest({
    operationId: "indication-operation:corruption-edit",
    id: PERSONAL_ONE,
    expectedRevision: 1,
    occurredAt: "2026-08-10T10:00:00.000Z",
    historyEntryId: "indication-history:corruption-edit",
    fields: maximumPersonalFields("\u0801"),
  }), contexts.aliceCurrent);

  const corruptions: readonly Readonly<{
    name: string;
    apply(state: MemoryStorageState): void;
  }>[] = [
    {
      name: "current record shape",
      apply: (state) => mutateStoredDocument(
        state,
        requiredRecordIn(state, "investment-indications"),
        (document) => {
          document.unexpected = true;
        },
      ),
    },
    {
      name: "current schema version",
      apply: (state) => mutateStoredDocument(
        state,
        requiredRecordIn(state, "investment-indications"),
        (document) => {
          document.schemaVersion = 1;
        },
      ),
    },
    {
      name: "transition kind",
      apply: (state) => mutateStoredDocument(
        state,
        requiredRecordWhere(
          state,
          "investment-indication-history",
          (record) => record.value.revision === 2,
        ),
        (document) => {
          document.transitionKind = "withdrawn";
        },
      ),
    },
    {
      name: "transition actor ownership",
      apply: (state) => mutateStoredDocument(
        state,
        requiredRecordWhere(
          state,
          "investment-indication-history",
          (record) => record.value.revision === 2,
        ),
        (document) => {
          mutableRecord(document.actor).subject = BOB_SUBJECT;
        },
      ),
    },
    {
      name: "missing transition",
      apply: (state) => {
        const transition = requiredRecordWhere(
          state,
          "investment-indication-history",
          (record) => record.value.revision === 1,
        );
        state.records.delete(storageKeyString(transition.key));
      },
    },
    {
      name: "field reference shape",
      apply: (state) => mutateStoredDocument(
        state,
        requiredRecordIn(state, "investment-indications"),
        (document) => {
          delete mutableRecord(document.fields).hash;
        },
      ),
    },
    {
      name: "field reference revision",
      apply: (state) => mutateStoredDocument(
        state,
        requiredRecordWhere(
          state,
          "investment-indication-history",
          (record) => record.value.revision === 1,
        ),
        (document) => {
          mutableRecord(document.fields).revision = 2;
        },
      ),
    },
    {
      name: "missing field chunk",
      apply: (state) => {
        const chunk = requiredRecordIn(state, "investment-indication-fields");
        state.records.delete(storageKeyString(chunk.key));
      },
    },
    {
      name: "reordered field chunks",
      apply: (state) => {
        const chunks = sortedFieldChunks(state, 1);
        const first = chunks[0];
        const second = chunks[1];
        assert(first && second);
        replaceStoredDocument(state, first, second.value);
        replaceStoredDocument(state, second, first.value);
      },
    },
    {
      name: "cross-subject field chunk",
      apply: (state) => mutateStoredDocument(
        state,
        requiredRecordIn(state, "investment-indication-fields"),
        (document) => {
          document.participantSubject = BOB_SUBJECT;
        },
      ),
    },
    {
      name: "field chunk hash",
      apply: (state) => mutateStoredDocument(
        state,
        requiredRecordIn(state, "investment-indication-fields"),
        (document) => {
          document.fieldsHash = `sha256:${"0".repeat(64)}`;
        },
      ),
    },
    {
      name: "field chunk byte count",
      apply: (state) => mutateStoredDocument(
        state,
        requiredRecordIn(state, "investment-indication-fields"),
        (document) => {
          document.fieldsBytes = Number(document.fieldsBytes) + 1;
        },
      ),
    },
    {
      name: "field chunk count",
      apply: (state) => mutateStoredDocument(
        state,
        requiredRecordIn(state, "investment-indication-fields"),
        (document) => {
          document.chunkCount = Number(document.chunkCount) + 1;
        },
      ),
    },
    {
      name: "field chunk payload",
      apply: (state) => mutateStoredDocument(
        state,
        requiredRecordIn(state, "investment-indication-fields"),
        (document) => {
          const data = String(document.data);
          document.data = `${data.startsWith("A") ? "B" : "A"}${data.slice(1)}`;
        },
      ),
    },
  ];

  for (const corruption of corruptions) {
    await t.test(corruption.name, async () => {
      const state = cloneMemoryStorageState(baseline);
      corruption.apply(state);
      await rejectsStorage(
        () => repository(
          new DeterministicMemoryStorageAdapter(state, true),
          ALICE_SUBJECT,
        ).get(PERSONAL_ONE),
        "UNAVAILABLE",
      );
    });
  }
});

test("stored envelopes reject prototype mutation, custom prototypes, and accessors", async (t) => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(state, true);
  const contexts = await packageContexts();
  await repository(storage, ALICE_SUBJECT).create(createRequest({
    operationId: "indication-operation:hostile-envelope-create",
    id: PERSONAL_ONE,
    occurredAt: "2026-08-10T09:00:00.000Z",
    historyEntryId: "indication-history:hostile-envelope-create",
    fields: personalFields(),
  }), contexts.aliceCurrent);

  const cases: readonly Readonly<{
    name: string;
    collection: string;
    transform(record: StorageRecord): StorageRecord;
  }>[] = [
    {
      name: "own __proto__ in current document",
      collection: "investment-indications",
      transform: (record) => {
        const value = { ...record.value };
        Object.defineProperty(value, "__proto__", {
          value: Object.freeze({ polluted: true }),
          enumerable: true,
          configurable: true,
        });
        return { ...record, value } as StorageRecord;
      },
    },
    {
      name: "custom current record prototype",
      collection: "investment-indications",
      transform: (record) =>
        Object.assign(Object.create({ inherited: true }), record) as StorageRecord,
    },
    {
      name: "transition value accessor",
      collection: "investment-indication-history",
      transform: (record) =>
        Object.defineProperty(
          { key: record.key, revision: record.revision },
          "value",
          { enumerable: true, get: () => record.value },
        ) as StorageRecord,
    },
    {
      name: "custom field-chunk key prototype",
      collection: "investment-indication-fields",
      transform: (record) => ({
        ...record,
        key: Object.assign(Object.create({ inherited: true }), record.key),
      }) as StorageRecord,
    },
    {
      name: "field-chunk data accessor",
      collection: "investment-indication-fields",
      transform: (record) => {
        const value = { ...record.value };
        Object.defineProperty(value, "data", {
          enumerable: true,
          get: () => record.value.data,
        });
        return { ...record, value } as StorageRecord;
      },
    },
    {
      name: "own __proto__ in active lease",
      collection: "investment-indication-active-keys",
      transform: (record) => {
        const value = { ...record.value };
        Object.defineProperty(value, "__proto__", {
          value: Object.freeze({ polluted: true }),
          enumerable: true,
          configurable: true,
        });
        return { ...record, value } as StorageRecord;
      },
    },
    {
      name: "custom active-lease record prototype",
      collection: "investment-indication-active-keys",
      transform: (record) =>
        Object.assign(Object.create({ inherited: true }), record) as StorageRecord,
    },
    {
      name: "active-lease value accessor",
      collection: "investment-indication-active-keys",
      transform: (record) =>
        Object.defineProperty(
          { key: record.key, revision: record.revision },
          "value",
          { enumerable: true, get: () => record.value },
        ) as StorageRecord,
    },
  ];

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const hostile = new ReadTransformStorageAdapter(
        storage,
        candidate.collection,
        candidate.transform,
      );
      await rejectsStorage(
        () => repository(hostile, ALICE_SUBJECT).get(PERSONAL_ONE),
        "UNAVAILABLE",
      );
    });
  }
});

test("indication writes reject a malformed transaction result matrix", async (t) => {
  const corruptions: readonly Readonly<{
    name: string;
    apply(result: StorageTransactionResult): unknown;
  }>[] = [
    { name: "primitive envelope", apply: () => null },
    {
      name: "non-boolean replay marker",
      apply: (result) => ({ ...result, replayed: "false" }),
    },
    {
      name: "missing result record",
      apply: (result) => ({
        ...result,
        records: result.records.slice(0, -1),
      }),
    },
    {
      name: "sparse records array",
      apply: (result) => {
        const records = new Array(result.records.length);
        for (let index = 1; index < result.records.length; index += 1) {
          records[index] = result.records[index];
        }
        return { ...result, records };
      },
    },
    {
      name: "wrong current revision",
      apply: (result) => corruptTransactionRecord(result, 0, (record) => {
        record.revision = Number(record.revision) + 1;
      }),
    },
    {
      name: "wrong transition value",
      apply: (result) => corruptTransactionRecord(result, 1, (record) => {
        mutableRecord(record.value).operationFingerprint =
          `sha256:${"0".repeat(64)}`;
      }),
    },
    {
      name: "wrong field chunk key",
      apply: (result) => corruptTransactionRecord(result, 2, (record) => {
        mutableRecord(record.key).id = "indication-fields:wrong";
      }),
    },
    {
      name: "over-depth record value",
      apply: (result) => corruptTransactionRecord(result, 0, (record) => {
        record.value = nestedCanonicalValue(
          MAX_INDICATION_CANONICAL_DEPTH + 1,
        );
      }),
    },
    {
      name: "over-node record value",
      apply: (result) => corruptTransactionRecord(result, 0, (record) => {
        record.value = {
          values: Array.from(
            { length: MAX_INDICATION_CANONICAL_NODES },
            () => null,
          ),
        };
      }),
    },
  ];

  for (const [index, corruption] of corruptions.entries()) {
    await t.test(corruption.name, async () => {
      const state = new MemoryStorageState();
      const adapter = new MalformedTransactionResultStorageAdapter(
        new DeterministicMemoryStorageAdapter(state, true),
        corruption.apply,
      );
      const contexts = await packageContexts();
      await rejectsStorage(
        () => repository(adapter, ALICE_SUBJECT).create(createRequest({
          operationId: `indication-operation:malformed-result-${index}`,
          id: PERSONAL_ONE,
          occurredAt: "2026-08-10T09:00:00.000Z",
          historyEntryId: `indication-history:malformed-result-${index}`,
          fields: personalFields(),
        }), contexts.aliceCurrent),
        "UNAVAILABLE",
      );
    });
  }
});

test("maximum indication payloads stay within record, transaction, restart, and retry budgets", async () => {
  const state = new MemoryStorageState();
  const observed = new ObservedStorageAdapter(
    new DeterministicMemoryStorageAdapter(state, true),
  );
  const contexts = await packageContexts();
  const alice = repository(observed, ALICE_SUBJECT);
  const create = createRequest({
    operationId: "indication-operation:maximum-create",
    id: PERSONAL_ONE,
    occurredAt: "2026-08-10T09:00:00.000Z",
    historyEntryId: "indication-history:maximum-create",
    fields: maximumPersonalFields("\u0800"),
  });

  const created = await alice.create(create, contexts.aliceCurrent);
  const fieldRecords = recordsIn(state, "investment-indication-fields");
  assert.ok(fieldRecords.length > 1);
  assert.ok(fieldRecords.length <= MAX_INDICATION_FIELDS_CHUNKS);
  assert.ok(observed.maximumRecordBytes <= MAX_INDICATION_STORAGE_RECORD_BYTES);
  assert.ok(
    observed.maximumTransactionBytes <=
      MAX_INDICATION_STORAGE_TRANSACTION_BYTES,
  );
  assert.ok(
    observed.maximumTransactionMutations <= MAX_INDICATION_STORAGE_MUTATIONS,
  );

  observed.resetReads();
  assert.deepEqual(
    await repository(observed, ALICE_SUBJECT).get(PERSONAL_ONE),
    created.snapshot,
  );
  assert.ok(observed.reads <= MAX_INDICATION_MATERIALIZATION_READS);

  observed.resetReads();
  const createReplay = await repository(observed, ALICE_SUBJECT).create(
    create,
    contexts.aliceCurrent,
  );
  assert.equal(createReplay.replayed, true);
  assert.deepEqual(createReplay.snapshot, created.snapshot);
  assert.ok(observed.reads <= MAX_INDICATION_STORAGE_READS);

  const edit = editRequest({
    operationId: "indication-operation:maximum-edit",
    id: PERSONAL_ONE,
    expectedRevision: 1,
    occurredAt: "2026-08-10T10:00:00.000Z",
    historyEntryId: "indication-history:maximum-edit",
    fields: maximumPersonalFields("\u0801"),
  });
  const edited = await repository(observed, ALICE_SUBJECT).edit(
    edit,
    contexts.aliceCurrent,
  );
  const editReplay = await repository(observed, ALICE_SUBJECT).edit(
    edit,
    contexts.aliceCurrent,
  );
  assert.equal(editReplay.replayed, true);
  assert.deepEqual(editReplay.snapshot, edited.snapshot);

  const fieldsBeforeWithdrawal = recordsIn(
    state,
    "investment-indication-fields",
  ).length;
  const withdrawn = await repository(observed, ALICE_SUBJECT).withdraw(
    withdrawRequest({
      operationId: "indication-operation:maximum-withdraw",
      id: PERSONAL_ONE,
      expectedRevision: 2,
      occurredAt: "2026-08-10T11:00:00.000Z",
      historyEntryId: "indication-history:maximum-withdraw",
    }),
  );
  assert.equal(withdrawn.revision, 3);
  assert.equal(
    recordsIn(state, "investment-indication-fields").length,
    fieldsBeforeWithdrawal,
  );
  assert.deepEqual(
    await repository(observed, ALICE_SUBJECT).get(PERSONAL_ONE),
    withdrawn.snapshot,
  );

  for (const record of recordsIn(state, "investment-indications")) {
    assert.equal(Object.hasOwn(record.value, "history"), false);
    assert.equal(Object.hasOwn(record.value, "snapshot"), false);
    assert.equal(Object.hasOwn(record.value, "participantSummary"), true);
    assert.ok(jsonBytes(record.value) <= MAX_INDICATION_STORAGE_RECORD_BYTES);
  }
  for (const record of recordsIn(state, "investment-indication-history")) {
    assert.equal(Object.hasOwn(record.value, "history"), false);
    assert.equal(Object.hasOwn(record.value, "snapshot"), false);
    assert.equal(Object.hasOwn(record.value, "participantSummary"), false);
    assert.ok(jsonBytes(record.value) < 4_096);
  }
});

test("indication ancestry reserves its final revision for withdrawal", async () => {
  const state = new MemoryStorageState();
  const observed = new ObservedStorageAdapter(
    new DeterministicMemoryStorageAdapter(state, true),
  );
  const contexts = await packageContexts();
  await repository(observed, ALICE_SUBJECT).create(createRequest({
    operationId: "indication-operation:bounded-create",
    id: PERSONAL_ONE,
    occurredAt: "2026-08-10T09:00:00.000Z",
    historyEntryId: "indication-history:bounded-create",
    fields: maximumPersonalFields("\u0800"),
  }), contexts.aliceCurrent);

  for (
    let expectedRevision = 1;
    expectedRevision < MAX_INVESTMENT_INDICATION_REVISIONS - 1;
    expectedRevision += 1
  ) {
    await repository(observed, ALICE_SUBJECT).edit(editRequest({
      operationId: `indication-operation:bounded-edit-${expectedRevision}`,
      id: PERSONAL_ONE,
      expectedRevision,
      occurredAt: new Date(
        Date.parse("2026-08-10T10:00:00.000Z") + expectedRevision * 60_000,
      ).toISOString(),
      historyEntryId: `indication-history:bounded-edit-${expectedRevision}`,
      fields: maximumPersonalFields(expectedRevision % 2 === 0 ? "\u0800" : "\u0801"),
    }), contexts.aliceCurrent);
  }

  await rejectsStorage(
    () => repository(observed, ALICE_SUBJECT).edit(editRequest({
      operationId: "indication-operation:over-budget-edit",
      id: PERSONAL_ONE,
      expectedRevision: MAX_INVESTMENT_INDICATION_REVISIONS - 1,
      occurredAt: "2026-08-10T11:30:00.000Z",
      historyEntryId: "indication-history:over-budget-edit",
      fields: maximumPersonalFields("\u0800"),
    }), contexts.aliceCurrent),
    "INVALID_REQUEST",
  );

  observed.resetReads();
  const active = await repository(observed, ALICE_SUBJECT).get(PERSONAL_ONE);
  assert.equal(active?.revision, MAX_INVESTMENT_INDICATION_REVISIONS - 1);
  assert.equal(active?.lifecycle.status, "active");
  assert.ok(observed.reads <= MAX_INDICATION_MATERIALIZATION_READS);

  const fieldsBeforeWithdrawal = recordsIn(
    state,
    "investment-indication-fields",
  ).length;
  const withdrawal = withdrawRequest({
    operationId: "indication-operation:bounded-withdraw",
    id: PERSONAL_ONE,
    expectedRevision: MAX_INVESTMENT_INDICATION_REVISIONS - 1,
    occurredAt: "2026-08-10T12:00:00.000Z",
    historyEntryId: "indication-history:bounded-withdraw",
  });
  observed.resetReads();
  const withdrawn = await repository(observed, ALICE_SUBJECT).withdraw(withdrawal);
  assert.equal(withdrawn.revision, MAX_INVESTMENT_INDICATION_REVISIONS);
  assert.ok(observed.reads <= MAX_INDICATION_STORAGE_READS);
  assert.equal(
    recordsIn(state, "investment-indication-history").length,
    MAX_INVESTMENT_INDICATION_REVISIONS,
  );
  assert.equal(
    recordsIn(state, "investment-indication-fields").length,
    fieldsBeforeWithdrawal,
  );

  observed.resetReads();
  const replay = await repository(observed, ALICE_SUBJECT).withdraw(withdrawal);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.snapshot, withdrawn.snapshot);
  assert.ok(observed.reads <= MAX_INDICATION_STORAGE_READS);
  await rejectsStorage(
    () => repository(observed, ALICE_SUBJECT).reactivate(
      reactivateRequest({
        operationId: "indication-operation:bounded-overflow",
        id: PERSONAL_ONE,
        expectedRevision: MAX_INVESTMENT_INDICATION_REVISIONS,
        occurredAt: "2026-08-10T13:00:00.000Z",
        historyEntryId: "indication-history:bounded-overflow",
      }),
      contexts.aliceCurrent,
    ),
    "INVALID_REQUEST",
  );
});

function repository(
  storage: StorageAdapter,
  subject: ActorSubject | null,
  configuredAmount: AmountConfiguration = amountConfiguration,
  parsingOptions: InvestmentIndicationParsingOptions = {},
  configuredOwnerSubject: ActorSubject = OWNER_SUBJECT,
): DevelopmentInMemoryIndicationRepository {
  return new DevelopmentInMemoryIndicationRepository(
    storage,
    subject,
    configuredOwnerSubject,
    configuredAmount,
    parsingOptions,
  );
}

function createRequest(input: Readonly<{
  operationId: string;
  id: string;
  occurredAt: string;
  historyEntryId: string;
  fields: unknown;
}>): CreateIndicationRequest {
  return { ...input, expectedRevision: null };
}

function editRequest(input: Readonly<{
  operationId: string;
  id: string;
  expectedRevision: number;
  occurredAt: string;
  historyEntryId: string;
  fields: unknown;
}>): EditIndicationRequest {
  return input;
}

function withdrawRequest(input: Readonly<{
  operationId: string;
  id: string;
  expectedRevision: number;
  occurredAt: string;
  historyEntryId: string;
}>): WithdrawIndicationRequest {
  return input;
}

function reactivateRequest(input: Readonly<{
  operationId: string;
  id: string;
  expectedRevision: number;
  occurredAt: string;
  historyEntryId: string;
}>): ReactivateIndicationRequest {
  return input;
}

function rejectRequest(input: Readonly<{
  operationId: string;
  id: string;
  expectedRevision: number;
  occurredAt: string;
  historyEntryId: string;
  reason: string;
}>): RejectIndicationRequest {
  return input;
}

function personalFields(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    kind: "personal",
    residenceCountry: "fi",
    amount: 1_250,
    availabilityPeriod: "Within twelve months.",
    note: "Initial personal note.",
    ...overrides,
  } as {
    kind: string;
    residenceCountry: string;
    amount: number;
    availabilityPeriod: string;
    note: string | null;
  };
}

function maximumPersonalFields(character: string) {
  return personalFields({
    availabilityPeriod: character.repeat(500),
    note: character.repeat(4_000),
  });
}

function companyFields(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    kind: "company",
    companyName: "Synthetic private company",
    registrationCountry: "FI",
    companyIdentifier: "SYNTHETIC-123",
    representativeName: "Synthetic representative",
    representativeAuthorityDeclared: true,
    amount: 2_000,
    availabilityPeriod: "Within twelve months.",
    note: null,
    ...overrides,
  };
}

function configuredAmount(
  overrides: Readonly<Record<string, unknown>> = {},
): AmountConfiguration {
  const parsed = parseAmountAggregateConfiguration({
    amount: {
      currency: "eur",
      minimum: 1_000,
      increment: 250,
      maximum: 10_000,
      ...overrides,
    },
    publicAggregate: { visibility: "hidden" },
  });
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value.amount;
}

async function packageContexts(): Promise<Readonly<{
  aliceInitial: TrustedPackageAcknowledgmentContext;
  aliceCurrent: TrustedPackageAcknowledgmentContext;
  aliceStale: TrustedPackageAcknowledgmentContext;
  bobCurrent: TrustedPackageAcknowledgmentContext;
}>> {
  const initial = await packageVersion({
    id: "package-version:indication-initial",
    createdAt: "2026-08-09T08:00:00.000Z",
    materialChange: true,
  });
  const material = await packageVersion(
    {
      id: "package-version:indication-material",
      createdAt: "2026-08-10T08:00:00.000Z",
      changeSummary: "Material contract update",
      materialChange: true,
      sections: [packageSection("Materially revised synthetic content.")],
    },
    initial,
  );
  const aliceInitialAcceptance = acceptance(
    initial,
    ALICE_SUBJECT,
    "acceptance:indication:alice-initial",
    "2026-08-09T08:30:00.000Z",
  );
  const aliceCurrentAcceptance = acceptance(
    material,
    ALICE_SUBJECT,
    "acceptance:indication:alice-current",
    "2026-08-10T08:30:00.000Z",
  );
  const bobCurrentAcceptance = acceptance(
    material,
    BOB_SUBJECT,
    "acceptance:indication:bob-current",
    "2026-08-10T08:30:00.000Z",
  );
  return Object.freeze({
    aliceInitial: acknowledgmentContext(initial, aliceInitialAcceptance),
    aliceCurrent: acknowledgmentContext(material, aliceCurrentAcceptance),
    aliceStale: acknowledgmentContext(material, aliceInitialAcceptance),
    bobCurrent: acknowledgmentContext(material, bobCurrentAcceptance),
  });
}

async function packageVersion(
  overrides: Readonly<Record<string, unknown>>,
  previous: PackageVersion | null = null,
): Promise<PackageVersion> {
  const parsed = await createPackageVersion(
    {
      id: "package-version:indication-default",
      createdAt: "2026-08-09T08:00:00.000Z",
      changeSummary: "Synthetic indication package",
      materialChange: false,
      acknowledgmentText:
        "This is a non-binding indication that can be withdrawn.",
      sections: [packageSection("Synthetic package content.")],
      ...overrides,
    },
    previous,
  );
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function packageSection(markdown: string) {
  return {
    id: "package-section:indication-overview",
    order: 0,
    title: "Overview",
    markdown,
    enabled: true,
  };
}

function acceptance(
  version: PackageVersion,
  subject: ActorSubject,
  id: string,
  acceptedAt: string,
): PackageAcceptanceRecord {
  const parsed = createPackageAcceptance(
    { id, participantSubject: subject, acceptedAt },
    version,
  );
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function acknowledgmentContext(
  currentVersion: PackageVersion,
  latestAcceptance: PackageAcceptanceRecord,
): TrustedPackageAcknowledgmentContext {
  return Object.freeze({ currentVersion, latestAcceptance });
}

function actorSubject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function indicationId(value: string): InvestmentIndicationId {
  const parsed = parseStableId<"investment-indication">(value);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

async function rejectsStorage(
  operation: () => Promise<unknown>,
  code: StorageFailure["code"],
): Promise<void> {
  assert.equal((await captureStorageFailure(operation)).code, code);
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
    const items = all.slice(start, start + request.limit).map(cloneRecord);
    const next = start + items.length;
    return {
      items: items.filter((item): item is StorageRecord => item !== null),
      nextCursor: next < all.length
        ? (`indication-cursor:${next}` as StorageCursor)
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
    const result = Object.freeze({
      replayed: false,
      records: Object.freeze(resultRecords.map(cloneRecord)),
    });
    this.#state.operations.set(operationKey, { fingerprint, result });
    return cloneResult(result, false);
  }
}

class ObservedStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  reads = 0;
  maximumRecordBytes = 0;
  maximumTransactionBytes = 0;
  maximumTransactionMutations = 0;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  resetReads(): void {
    this.reads = 0;
  }

  read(key: StorageKey): Promise<StorageRecord | null> {
    this.reads += 1;
    return this.#delegate.read(key);
  }

  list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    return this.#delegate.list(request);
  }

  transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    this.maximumTransactionBytes = Math.max(
      this.maximumTransactionBytes,
      jsonBytes(request),
    );
    this.maximumTransactionMutations = Math.max(
      this.maximumTransactionMutations,
      request.mutations.length,
    );
    for (const mutation of request.mutations) {
      if (mutation.type !== "put") continue;
      const bytes = jsonBytes(mutation.value);
      this.maximumRecordBytes = Math.max(this.maximumRecordBytes, bytes);
      assert.ok(bytes <= MAX_INDICATION_STORAGE_RECORD_BYTES);
    }
    assert.ok(
      jsonBytes(request) <= MAX_INDICATION_STORAGE_TRANSACTION_BYTES,
    );
    return this.#delegate.transact(request);
  }
}

class ReadTransformStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #collection: string;
  readonly #transform: (record: StorageRecord) => StorageRecord;

  constructor(
    delegate: StorageAdapter,
    collection: string,
    transform: (record: StorageRecord) => StorageRecord,
  ) {
    this.#delegate = delegate;
    this.#collection = collection;
    this.#transform = transform;
  }

  async read(key: StorageKey): Promise<StorageRecord | null> {
    const record = await this.#delegate.read(key);
    return record !== null && record.key.collection === this.#collection
      ? this.#transform(record)
      : record;
  }

  list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    return this.#delegate.list(request);
  }

  transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    return this.#delegate.transact(request);
  }
}

class MalformedTransactionResultStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #corrupt: (result: StorageTransactionResult) => unknown;

  constructor(
    delegate: StorageAdapter,
    corrupt: (result: StorageTransactionResult) => unknown,
  ) {
    this.#delegate = delegate;
    this.#corrupt = corrupt;
  }

  read(key: StorageKey): Promise<StorageRecord | null> {
    return this.#delegate.read(key);
  }

  list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    return this.#delegate.list(request);
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    return this.#corrupt(
      await this.#delegate.transact(request),
    ) as StorageTransactionResult;
  }
}

function seedUnrelatedRecords(state: MemoryStorageState): void {
  for (const [collection, id, value] of [
    ["investment-aggregates", "aggregate:current", { total: 7_000 }],
    ["founder-applications", "founder:existing", { status: "received" }],
  ] as const) {
    const parsed = parseStorageKey(collection, id);
    assert(parsed.ok);
    const record = freezeRecord({ key: parsed.value, revision: 1, value });
    state.records.set(storageKeyString(parsed.value), record);
  }
}

function unrelatedEvidence(state: MemoryStorageState): string {
  return JSON.stringify(
    [...state.records.values()]
      .filter((record) =>
        record.key.collection === "investment-aggregates" ||
        record.key.collection === "founder-applications"
      )
      .sort((left, right) => storageKeyString(left.key).localeCompare(
        storageKeyString(right.key),
      )),
  );
}

function recordsIn(
  state: MemoryStorageState,
  collection: string,
): readonly StorageRecord[] {
  return [...state.records.values()].filter(
    (record) => record.key.collection === collection,
  );
}

function requiredRecordIn(
  state: MemoryStorageState,
  collection: string,
): StorageRecord {
  const record = recordsIn(state, collection)[0];
  assert(record);
  return record;
}

function requiredRecordWhere(
  state: MemoryStorageState,
  collection: string,
  predicate: (record: StorageRecord) => boolean,
): StorageRecord {
  const record = recordsIn(state, collection).find(predicate);
  assert(record);
  return record;
}

function sortedFieldChunks(
  state: MemoryStorageState,
  fieldsRevision: number,
): readonly StorageRecord[] {
  return recordsIn(state, "investment-indication-fields")
    .filter((record) => record.value.fieldsRevision === fieldsRevision)
    .sort((left, right) =>
      Number(left.value.chunkIndex) - Number(right.value.chunkIndex)
    );
}

function mutateStoredDocument(
  state: MemoryStorageState,
  record: StorageRecord,
  mutate: (document: Record<string, unknown>) => void,
): void {
  const value = cloneDocument(record.value);
  const document = mutableRecord(value);
  mutate(document);
  replaceStoredDocument(state, record, document as StorageDocument);
}

function replaceStoredDocument(
  state: MemoryStorageState,
  record: StorageRecord,
  value: StorageDocument,
): void {
  state.records.set(storageKeyString(record.key), freezeRecord({
    key: record.key,
    revision: record.revision,
    value,
  }));
}

function cloneMemoryStorageState(source: MemoryStorageState): MemoryStorageState {
  const clone = new MemoryStorageState();
  for (const [key, record] of source.records) {
    const copied = cloneRecord(record);
    assert(copied);
    clone.records.set(key, copied);
  }
  for (const [key, operation] of source.operations) {
    clone.operations.set(key, {
      fingerprint: operation.fingerprint,
      result: cloneResult(operation.result, operation.result.replayed),
    });
  }
  return clone;
}

function corruptTransactionRecord(
  result: StorageTransactionResult,
  index: number,
  mutate: (record: Record<string, unknown>) => void,
): unknown {
  const records = result.records.map((record) =>
    record === null
      ? null
      : cloneDocument(record as unknown as StorageDocument)
  );
  const candidate = records[index];
  assert(candidate && typeof candidate === "object" && !Array.isArray(candidate));
  mutate(candidate as Record<string, unknown>);
  return { replayed: result.replayed, records };
}

function nestedCanonicalValue(depth: number): StorageDocument {
  let value: StorageDocument = { end: true };
  for (let index = 0; index < depth; index += 1) {
    value = { child: value };
  }
  return value;
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function parseCursor(cursor: StorageCursor): number {
  const match = /^indication-cursor:(\d+)$/.exec(cursor);
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
  if (record === null) return null;
  return freezeRecord({
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

function mutableRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
