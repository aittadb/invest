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
import type {
  InvestmentIndicationId,
  TrustedPackageAcknowledgmentContext,
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

test("current snapshots require every immutable history revision", async () => {
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
    record.value.indication !== undefined &&
    mutableRecord(record.value.indication).revision === 1
  );
  assert.notEqual(firstHistory, undefined);
  if (firstHistory === undefined) return;
  state.records.delete(firstHistory[0]);
  await rejectsStorage(() => alice.get(PERSONAL_ONE), "UNAVAILABLE");
});

function repository(
  storage: StorageAdapter,
  subject: ActorSubject | null,
): DevelopmentInMemoryIndicationRepository {
  return new DevelopmentInMemoryIndicationRepository(
    storage,
    subject,
    OWNER_SUBJECT,
    amountConfiguration,
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

function configuredAmount(): AmountConfiguration {
  const parsed = parseAmountAggregateConfiguration({
    amount: {
      currency: "eur",
      minimum: 1_000,
      increment: 250,
      maximum: 10_000,
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
    const result = Object.freeze({
      replayed: false,
      records: Object.freeze(resultRecords.map(cloneRecord)),
    });
    this.#state.operations.set(operationKey, { fingerprint, result });
    return cloneResult(result, false);
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
