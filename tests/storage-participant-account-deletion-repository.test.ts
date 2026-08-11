import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAmountAggregateConfiguration,
  type AmountConfiguration,
} from "../domain/amount-aggregate-configuration.ts";
import {
  parseContributionAreaChoices,
  type ContributionAreaChoice,
} from "../domain/founder-application.ts";
import {
  parseActorSubject,
  parseStableId,
  type ActorSubject,
  type StableId,
} from "../domain/foundation.ts";
import { projectInvestmentIndicationForAggregation } from "../domain/investment-aggregate.ts";
import type {
  InvestmentIndication,
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
  parseParticipantAccount,
  type ParticipantAccount,
} from "../domain/participant-profile.ts";
import {
  StorageFailure,
  type StorageAdapter,
  type StorageListRequest,
  type StoragePage,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import {
  DevelopmentInMemoryAggregateRepository,
  prepareAtomicAggregateContribution,
} from "../repositories/in-memory-aggregate-repository.ts";
import {
  DevelopmentInMemoryIndicationRepository,
  MAX_OWNED_INVESTMENT_INDICATIONS,
  type ParticipantIndicationOwnershipEntry,
} from "../repositories/in-memory-indication-repository.ts";
import {
  StorageFounderApplicationRepository,
} from "../repositories/in-memory-founder-application-repository.ts";
import {
  StorageParticipantRepository,
} from "../repositories/in-memory-participant-repository.ts";
import {
  MAX_PARTICIPANT_ACCOUNT_DELETION_OPERATION_READS,
  StorageParticipantAccountDeletionRepository,
} from "../repositories/storage-participant-account-deletion-repository.ts";
import {
  StorageParticipantInvestmentInterestRepository,
  initializeParticipantInvestmentOwnership,
} from "../repositories/storage-participant-investment-repository.ts";
import { createParticipantInvestmentInterestService } from "../worker/investment-interest-service.ts";
import { MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS } from "../worker/participant-investment-mutation-port.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";
import { testParticipantRegistrationNoticeEvidence } from "./support/participant-registration-notice-evidence.ts";

const ALICE = account(
  "issuer.invalid/participant:account-deletion-alice",
  "alice@example.invalid",
);
const BOB = account(
  "issuer.invalid/participant:account-deletion-bob",
  "bob@example.invalid",
);
const OWNER = subject("issuer.invalid/owner:account-deletion");
const FOUNDER_APPLICATION_ID = stableId<"founder-application">(
  "founder-application:self",
);
const AMOUNT = amountConfiguration();
const CHOICES = contributionAreaChoices();
const REQUESTED_AT = "2026-08-12T12:00:00.000Z";
const ALLOW_ALL = Object.freeze({
  createPersonal: true,
  createCompany: true,
  reactivatePersonal: true,
  reactivateCompany: true,
});

test("account deletion commits the exact 25-mutation maximum and replays", async () => {
  const fixture = await seededFixture({ founder: true, activeInvestments: 4 });
  const request = deletionRequest("participant-operation:deletion-maximum", 1);
  const first = await fixture.coordinator.requestAccountDeletion(request);

  assert.equal(first.replayed, false);
  assert.equal(first.revision, 2);
  assert.equal(first.snapshot.accountDeletionRequest.state, "requested");
  assert.equal(first.founderApplication?.status, "withdrawn");
  assert.equal(first.investmentWithdrawals.length, 4);
  assert.equal(first.mutationCount, 25);
  assert.deepEqual(first.aggregate, {
    revision: 5,
    totalAmount: 0,
    currency: "EUR",
    contributingIndicationCount: 0,
  });
  assert.equal(first.auditEvent.detail.kind, "resource-transition");
  if (first.auditEvent.detail.kind === "resource-transition") {
    assert.equal(first.auditEvent.detail.transition, "deletion-requested");
  }
  assert.equal(
    recordsIn(fixture.state, "participant-account-deletion-operations").length,
    1,
  );
  assert.equal(
    recordsIn(fixture.state, "audit-events").filter((record) => {
      const event = record.value.event as
        | Readonly<Record<string, unknown>>
        | undefined;
      const detail = event?.detail as
        | Readonly<Record<string, unknown>>
        | undefined;
      return detail?.transition === "deletion-requested";
    }).length,
    1,
  );
  assert.equal(
    recordsIn(fixture.state, "investment-indication-active-keys").length,
    0,
  );

  const restarted = coordinator(fixture.storage, ALICE);
  const replay = await restarted.requestAccountDeletion(request);
  assert.equal(replay.replayed, true);
  assert.deepEqual({ ...replay, replayed: false }, first);

  const changed = await captureStorageFailure(() =>
    restarted.requestAccountDeletion({
      ...request,
      requestedAt: "2026-08-12T12:01:00.000Z",
    })
  );
  assert.equal(changed.code, "CONFLICT");
});

test("empty deletion remains replayable after independent consent withdrawal", async () => {
  const fixture = await seededFixture({ founder: false, activeInvestments: 0 });
  const request = deletionRequest("participant-operation:deletion-empty", 1);
  const first = await fixture.coordinator.requestAccountDeletion(request);
  assert.equal(first.mutationCount, 6);
  assert.equal(first.founderApplication, null);
  assert.deepEqual(first.investmentWithdrawals, []);
  assert.deepEqual(first.aggregate, {
    revision: 0,
    totalAmount: 0,
    currency: "EUR",
    contributingIndicationCount: 0,
  });
  assert.equal(
    recordsIn(fixture.state, "participant-investment-indexes")[0]?.revision,
    2,
  );
  assert.equal(
    recordsIn(
      fixture.state,
      "investment-indication-ownership-witnesses",
    )[0]?.revision,
    2,
  );

  const participant = new StorageParticipantRepository(fixture.storage, ALICE);
  const consent = await participant.withdrawMarketingConsent({
    operationId: "participant-operation:consent-after-deletion",
    expectedRevision: 2,
    withdrawnAt: "2026-08-12T12:30:00.000Z",
  });
  assert.equal(consent.revision, 3);
  assert.equal(consent.snapshot.marketingConsent.state, "withdrawn");

  const replay = await coordinator(fixture.storage, ALICE)
    .requestAccountDeletion(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, 2);
  assert.equal(replay.snapshot.marketingConsent.state, "granted");
  assert.equal(
    (await participant.current())?.snapshot.marketingConsent.state,
    "withdrawn",
  );
});

test("inactive and founder-only deletion preserve the bounded empty barrier", async (t) => {
  await t.test("inactive investment", async () => {
    const fixture = await seededFixture({
      founder: false,
      activeInvestments: 0,
      inactiveInvestments: 1,
    });
    const before = await new StorageParticipantInvestmentInterestRepository(
      fixture.storage,
      ALICE.subject,
      AMOUNT,
    ).listOwned();
    const result = await fixture.coordinator.requestAccountDeletion(
      deletionRequest("participant-operation:deletion-inactive", 1),
    );
    assert.equal(result.mutationCount, 6);
    assert.deepEqual(result.investmentWithdrawals, []);
    assert.deepEqual(
      await new StorageParticipantInvestmentInterestRepository(
        fixture.storage,
        ALICE.subject,
        AMOUNT,
      ).listOwned(),
      before,
    );
    assert.equal(
      recordsIn(fixture.state, "investment-aggregate-contributions")[0]
        ?.revision,
      2,
    );
  });

  await t.test("founder only", async () => {
    const fixture = await seededFixture({
      founder: true,
      activeInvestments: 0,
    });
    const result = await fixture.coordinator.requestAccountDeletion(
      deletionRequest("participant-operation:deletion-founder-only", 1),
    );
    assert.equal(result.mutationCount, 8);
    assert.equal(result.founderApplication?.status, "withdrawn");
    assert.deepEqual(result.investmentWithdrawals, []);
  });
});

test("concurrent exact deletion has one commit and two stable results", async () => {
  const fixture = await seededFixture({ founder: true, activeInvestments: 2 });
  const request = deletionRequest("participant-operation:deletion-concurrent", 1);
  const [left, right] = await Promise.all([
    coordinator(fixture.storage, ALICE).requestAccountDeletion(request),
    coordinator(fixture.storage, ALICE).requestAccountDeletion(request),
  ]);
  assert.deepEqual(
    [left.replayed, right.replayed].sort(),
    [false, true],
  );
  assert.deepEqual(
    { ...left, replayed: false },
    { ...right, replayed: false },
  );
  assert.equal(left.mutationCount, 17);
  assert.equal(
    recordsIn(fixture.state, "participant-account-deletion-operations").length,
    1,
  );
});

test("response loss and malformed commit evidence recover from the receipt", async (t) => {
  for (const mode of ["throw", "malformed"] as const) {
    for (const scenario of [
      Object.freeze({ name: "active", founder: true, active: 1, inactive: 0, mutations: 13 }),
      Object.freeze({ name: "empty", founder: false, active: 0, inactive: 0, mutations: 6 }),
      Object.freeze({ name: "inactive", founder: false, active: 0, inactive: 1, mutations: 6 }),
    ]) {
      await t.test(`${mode} ${scenario.name}`, async () => {
        const fixture = await seededFixture({
          founder: scenario.founder,
          activeInvestments: scenario.active,
          inactiveInvestments: scenario.inactive,
        });
        const unreliable = new CommitEvidenceAdapter(fixture.storage, mode);
        const result = await coordinator(unreliable, ALICE)
          .requestAccountDeletion(
            deletionRequest(
              `participant-operation:deletion-${mode}-${scenario.name}`,
              1,
            ),
          );
        assert.equal(result.replayed, true);
        assert.equal(result.mutationCount, scenario.mutations);
        assert.equal(result.investmentWithdrawals.length, scenario.active);
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_BODY/u);
      });
    }
  }
});

test("account deletion survives amount and currency evolution", async (t) => {
  const evolvedAmount = amountConfiguration({
    currency: "USD",
    minimum: 5_000,
    increment: 500,
  });

  await t.test("new terminal cleanup uses persisted aggregate currency", async () => {
    const fixture = await seededFixture({ founder: false, activeInvestments: 1 });
    const request = deletionRequest(
      "participant-operation:deletion-currency-evolution",
      1,
    );
    const result = await coordinator(
      fixture.storage,
      ALICE,
      evolvedAmount,
    ).requestAccountDeletion(request);
    assert.equal(result.replayed, false);
    assert.equal(result.aggregate.currency, "EUR");
    assert.equal(result.investmentWithdrawals[0]?.fields.currency, "EUR");

    const replay = await coordinator(
      new MemoryStorageAdapter(fixture.state),
      ALICE,
      evolvedAmount,
    ).requestAccountDeletion(request);
    assert.equal(replay.replayed, true);
    assert.deepEqual({ ...replay, replayed: false }, result);
  });

  await t.test("empty delayed replay derives immutable receipt currency", async () => {
    const fixture = await seededFixture({ founder: false, activeInvestments: 0 });
    const request = deletionRequest(
      "participant-operation:deletion-empty-currency-evolution",
      1,
    );
    const first = await fixture.coordinator.requestAccountDeletion(request);
    const replay = await coordinator(
      new MemoryStorageAdapter(fixture.state),
      ALICE,
      evolvedAmount,
    ).requestAccountDeletion(request);
    assert.equal(replay.replayed, true);
    assert.equal(replay.aggregate.currency, "EUR");
    assert.deepEqual({ ...replay, replayed: false }, first);

    const changed = await captureStorageFailure(() =>
      coordinator(fixture.storage, ALICE, evolvedAmount)
        .requestAccountDeletion({
          ...request,
          requestedAt: "2026-08-12T12:01:00.000Z",
        })
    );
    assert.equal(changed.code, "CONFLICT");
  });
});

test("exact replay rejects corrupted persisted deletion evidence", async (t) => {
  await t.test("profile operation evidence", async () => {
    const fixture = await seededFixture({ founder: false, activeInvestments: 0 });
    const request = deletionRequest("participant-operation:deletion-profile-evidence", 1);
    await fixture.coordinator.requestAccountDeletion(request);
    const [identity, record] = requiredStoredRecord(
      fixture.state,
      "private-participant-profile-revisions",
      (candidate) => candidate.value.profileRevision === 2,
    );
    const value = structuredClone(record.value) as typeof record.value & {
      lastMutation: { operationId: string };
    };
    value.lastMutation.operationId =
      "participant-operation:different-deletion-profile-evidence";
    fixture.state.records.set(identity, Object.freeze({ ...record, value }));

    const failure = await captureStorageFailure(() =>
      coordinator(fixture.storage, ALICE).requestAccountDeletion(request)
    );
    assert.equal(failure.code, "UNAVAILABLE");
  });

  await t.test("missing audit event", async () => {
    const fixture = await seededFixture({ founder: true, activeInvestments: 1 });
    const request = deletionRequest("participant-operation:deletion-audit-evidence", 1);
    await fixture.coordinator.requestAccountDeletion(request);
    const [identity] = requiredStoredRecord(
      fixture.state,
      "audit-events",
      (candidate) => {
        const event = candidate.value.event;
        return typeof event === "object" && event !== null &&
          "detail" in event &&
          typeof event.detail === "object" && event.detail !== null &&
          "transition" in event.detail &&
          event.detail.transition === "deletion-requested";
      },
    );
    fixture.state.records.delete(identity);

    const failure = await captureStorageFailure(() =>
      coordinator(fixture.storage, ALICE).requestAccountDeletion(request)
    );
    assert.equal(failure.code, "UNAVAILABLE");
  });

  await t.test("changed aggregate contribution", async () => {
    const fixture = await seededFixture({ founder: false, activeInvestments: 1 });
    const request = deletionRequest(
      "participant-operation:deletion-aggregate-evidence",
      1,
    );
    await fixture.coordinator.requestAccountDeletion(request);
    const [identity, record] = requiredStoredRecord(
      fixture.state,
      "investment-aggregate-contributions",
    );
    fixture.state.records.set(identity, Object.freeze({
      ...record,
      value: Object.freeze({ ...record.value, amount: 9_999 }),
    }));

    const failure = await captureStorageFailure(() =>
      coordinator(fixture.storage, ALICE).requestAccountDeletion(request)
    );
    assert.equal(failure.code, "UNAVAILABLE");
  });

  await t.test("malformed receipt", async () => {
    const fixture = await seededFixture({ founder: false, activeInvestments: 0 });
    const request = deletionRequest("participant-operation:deletion-receipt-evidence", 1);
    await fixture.coordinator.requestAccountDeletion(request);
    const [identity, record] = requiredStoredRecord(
      fixture.state,
      "participant-account-deletion-operations",
    );
    const value = structuredClone(record.value) as typeof record.value & {
      mutationCount: number;
    };
    value.mutationCount = 5;
    fixture.state.records.set(identity, Object.freeze({ ...record, value }));

    const failure = await captureStorageFailure(() =>
      coordinator(fixture.storage, ALICE).requestAccountDeletion(request)
    );
    assert.equal(failure.code, "UNAVAILABLE");
  });
});

test("transaction failure, stale input, and foreign access change nothing", async (t) => {
  await t.test("transaction failure", async () => {
    const fixture = await seededFixture({ founder: true, activeInvestments: 4 });
    const before = stateFingerprint(fixture.state);
    const operationsBefore = fixture.state.operations.size;
    const failure = await captureStorageFailure(() =>
      coordinator(new RejectingTransactionAdapter(fixture.storage), ALICE)
        .requestAccountDeletion(
          deletionRequest("participant-operation:deletion-failure", 1),
        )
    );
    assert.equal(failure.code, "UNAVAILABLE");
    assert.doesNotMatch(String(failure), /PRIVATE_PROVIDER_BODY/u);
    assert.equal(stateFingerprint(fixture.state), before);
    assert.equal(fixture.state.operations.size, operationsBefore);
  });

  await t.test("stale input", async () => {
    const fixture = await seededFixture({ founder: false, activeInvestments: 0 });
    await new StorageParticipantRepository(fixture.storage, ALICE).update({
      operationId: "participant-operation:deletion-stale-update",
      expectedRevision: 1,
      updatedAt: "2026-08-12T11:30:00.000Z",
      changes: { displayName: "Updated before deletion" },
    });
    const before = stateFingerprint(fixture.state);
    const failure = await captureStorageFailure(() =>
      fixture.coordinator.requestAccountDeletion(
        deletionRequest("participant-operation:deletion-stale", 1),
      )
    );
    assert.equal(failure.code, "PRECONDITION_FAILED");
    assert.equal(stateFingerprint(fixture.state), before);
  });

  await t.test("foreign and anonymous", async () => {
    const fixture = await seededFixture({ founder: true, activeInvestments: 1 });
    const before = stateFingerprint(fixture.state);
    for (const candidate of [BOB, null]) {
      const failure = await captureStorageFailure(() =>
        coordinator(fixture.storage, candidate).requestAccountDeletion(
          deletionRequest("participant-operation:deletion-foreign", 1),
        )
      );
      assert.equal(failure.code, "NOT_FOUND");
      assert.doesNotMatch(
        JSON.stringify({ code: failure.code, message: failure.message }),
        /account-deletion-alice|alice@example/iu,
      );
    }
    assert.equal(stateFingerprint(fixture.state), before);
  });
});

test("concurrent direct activation rolls back every deletion effect", async (t) => {
  await t.test("create", async () => {
    const fixture = await seededFixture({ founder: true, activeInvestments: 0 });
    const context = await currentContext(ALICE.subject, "deletion-race-create");
    const racing = new BeforeTransactionStorageAdapter(
      fixture.storage,
      async () => {
        await new DevelopmentInMemoryIndicationRepository(
          fixture.storage,
          ALICE.subject,
          OWNER,
          AMOUNT,
        ).create({
          operationId: "indication-operation:deletion-race-create",
          id: "investment-indication:deletion-race-create",
          expectedRevision: null,
          occurredAt: "2026-08-12T12:01:00.000Z",
          historyEntryId: "indication-history:deletion-race-create",
          fields: companyFields({
            companyIdentifier: "DELETION-RACE-CREATE",
          }),
        }, context);
      },
    );
    const failure = await captureStorageFailure(() =>
      coordinator(racing, ALICE).requestAccountDeletion(
        deletionRequest("participant-operation:deletion-race-create", 1),
      )
    );
    assert.equal(failure.code, "PRECONDITION_FAILED");
    assert.equal(racing.injected, true);
    assert.equal(
      (await new StorageParticipantRepository(fixture.storage, ALICE).current())
        ?.snapshot.accountDeletionRequest.state,
      "not-requested",
    );
    assert.equal(
      recordsIn(fixture.state, "participant-account-deletion-operations").length,
      0,
    );
    assert.equal(deletionAuditCount(fixture.state), 0);
  });

  await t.test("reactivation", async () => {
    const fixture = await seededFixture({
      founder: false,
      activeInvestments: 0,
      inactiveInvestments: 1,
    });
    const [withdrawn] = await new StorageParticipantInvestmentInterestRepository(
      fixture.storage,
      ALICE.subject,
      AMOUNT,
    ).listOwned();
    assert(withdrawn);
    const context = await currentContext(
      ALICE.subject,
      "deletion-race-reactivation",
    );
    const racing = new BeforeTransactionStorageAdapter(
      fixture.storage,
      async () => {
        await new DevelopmentInMemoryIndicationRepository(
          fixture.storage,
          ALICE.subject,
          OWNER,
          AMOUNT,
        ).reactivate({
          operationId: "indication-operation:deletion-race-reactivation",
          id: withdrawn.id,
          expectedRevision: withdrawn.revision,
          occurredAt: "2026-08-12T12:01:00.000Z",
          historyEntryId: "indication-history:deletion-race-reactivation",
        }, context);
      },
    );
    const failure = await captureStorageFailure(() =>
      coordinator(racing, ALICE).requestAccountDeletion(
        deletionRequest("participant-operation:deletion-race-reactivation", 1),
      )
    );
    assert.equal(failure.code, "PRECONDITION_FAILED");
    assert.equal(racing.injected, true);
    assert.equal(
      (await new StorageParticipantRepository(fixture.storage, ALICE).current())
        ?.snapshot.accountDeletionRequest.state,
      "not-requested",
    );
    assert.equal(
      recordsIn(fixture.state, "participant-account-deletion-operations").length,
      0,
    );
    assert.equal(deletionAuditCount(fixture.state), 0);
  });
});

test("maximum 100-record ownership inventory stays inside the atomic boundary", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await registerParticipant(storage, ALICE);
  const context = await currentContext(ALICE.subject, "deletion-100-records");
  const indications = new DevelopmentInMemoryIndicationRepository(
    storage,
    ALICE.subject,
    OWNER,
    AMOUNT,
  );
  const ownership: ParticipantIndicationOwnershipEntry[] = [];
  for (let index = 0; index < MAX_OWNED_INVESTMENT_INDICATIONS; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const created = await indications.create({
      operationId: `indication-operation:deletion-100-${suffix}-create`,
      id: `investment-indication:deletion-100-${suffix}`,
      expectedRevision: null,
      occurredAt: "2026-08-12T09:00:00.000Z",
      historyEntryId: `indication-history:deletion-100-${suffix}-create`,
      fields: companyFields({
        companyName: `Maximum deletion company ${suffix}`,
        companyIdentifier: `DELETION-100-${suffix}`,
      }),
    }, context);
    let current: InvestmentIndication = created.snapshot;
    if (index >= MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS) {
      current = (await indications.withdraw({
        operationId: `indication-operation:deletion-100-${suffix}-withdraw`,
        id: current.id,
        expectedRevision: current.revision,
        occurredAt: "2026-08-12T10:00:00.000Z",
        historyEntryId: `indication-history:deletion-100-${suffix}-withdraw`,
      })).snapshot;
    } else {
      await persistAggregateProjection(
        storage,
        current,
        `aggregate-operation:deletion-100-${suffix}`,
      );
    }
    ownership.push(Object.freeze({
      indicationId: current.id,
      indicationRevision: current.revision,
      lifecycleStatus: current.lifecycle.status,
    }));
  }
  await initializeParticipantInvestmentOwnership(storage, ALICE.subject, {
    operationId: "investment-ownership-initialization:deletion-100",
    indications: ownership,
  });

  const result = await coordinator(storage, ALICE).requestAccountDeletion(
    deletionRequest("participant-operation:deletion-100", 1),
  );
  assert.equal(result.investmentWithdrawals.length, 4);
  assert.equal(result.mutationCount, 23);
  assert.equal(result.aggregate.totalAmount, 0);
  assert.equal(result.aggregate.contributingIndicationCount, 0);
  const current = await new StorageParticipantInvestmentInterestRepository(
    storage,
    ALICE.subject,
    AMOUNT,
  ).listOwned();
  assert.equal(current.length, MAX_OWNED_INVESTMENT_INDICATIONS);
  assert.equal(
    current.every(({ lifecycle }) => lifecycle.status !== "active"),
    true,
  );

  const counted = new CountingStorageAdapter(storage);
  const replay = await coordinator(counted, ALICE).requestAccountDeletion(
    deletionRequest("participant-operation:deletion-100", 1),
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.investmentWithdrawals.length, 4);
  assert.equal(counted.listCalls, 0);
  assert.equal(counted.transactCalls, 0);
  assert.ok(
    counted.readCalls <= MAX_PARTICIPANT_ACCOUNT_DELETION_OPERATION_READS,
    `${counted.readCalls} account-deletion replay reads exceeded the operation ceiling`,
  );
});

type SeedOptions = Readonly<{
  founder: boolean;
  activeInvestments: number;
  inactiveInvestments?: number;
}>;

async function seededFixture(options: SeedOptions) {
  assert.equal(
    options.activeInvestments >= 0 &&
      options.activeInvestments <= MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS,
    true,
  );
  const inactiveInvestments = options.inactiveInvestments ?? 0;
  assert.equal(inactiveInvestments >= 0, true);
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await registerParticipant(storage, ALICE);
  await initializeParticipantInvestmentOwnership(storage, ALICE.subject, {
    operationId: "investment-ownership-initialization:account-deletion-fixture",
    indications: [],
  });
  if (options.founder) await createFounderApplication(storage, ALICE.subject);

  const context = await currentContext(ALICE.subject, "account-deletion-fixture");
  let minute = 0;
  const investmentService = createParticipantInvestmentInterestService({
    actorSubject: ALICE.subject,
    amountConfiguration: AMOUNT,
    reader: new StorageParticipantInvestmentInterestRepository(
      storage,
      ALICE.subject,
      AMOUNT,
    ),
    mutations: new StorageParticipantInvestmentInterestRepository(
      storage,
      ALICE.subject,
      AMOUNT,
    ),
    loadAcknowledgmentContext: () => context,
    loadPermissions: () => ALLOW_ALL,
    indicationIdForOperation,
    now: () => new Date(
      Date.parse("2026-08-12T10:00:00.000Z") + minute++ * 60_000,
    ),
  });
  for (
    let index = 0;
    index < options.activeInvestments + inactiveInvestments;
    index += 1
  ) {
    const created = await investmentService.create({
      operationId: `investment-operation:account-deletion-${index}`,
      fields: companyFields({
        companyName: `Deletion fixture company ${index}`,
        companyIdentifier: `ACCOUNT-DELETION-${index}`,
      }),
    });
    if (index >= options.activeInvestments) {
      await investmentService.withdraw({
        operationId: `investment-operation:account-deletion-${index}-withdraw`,
        indicationId: created.snapshot.id,
        expectedRevision: created.snapshot.revision,
      });
    }
  }
  return Object.freeze({
    state,
    storage,
    coordinator: coordinator(storage, ALICE),
  });
}

async function registerParticipant(
  storage: StorageAdapter,
  participant: ParticipantAccount,
): Promise<void> {
  const result = await new StorageParticipantRepository(storage, participant)
    .register({
      operationId: "participant-operation:account-deletion-register",
      expectedRevision: null,
      registeredAt: "2026-08-12T08:00:00.000Z",
      registration: {
        displayName: "Deletion Fixture",
        country: "FI",
        declaredInterest: "both",
        participationContext: "company",
        processEmailNoticeAcknowledged: true,
        marketingConsent: true,
      },
      noticeEvidence: testParticipantRegistrationNoticeEvidence(),
    });
  assert.equal(result.revision, 1);
}

async function createFounderApplication(
  storage: StorageAdapter,
  participantSubject: ActorSubject,
): Promise<void> {
  const result = await new StorageFounderApplicationRepository(
    storage,
    participantSubject,
    CHOICES,
  ).create({
    operationId: "founder-operation:account-deletion-create",
    id: FOUNDER_APPLICATION_ID,
    expectedRevision: null,
    occurredAt: "2026-08-12T09:00:00.000Z",
    historyEntryId: "founder-history:account-deletion-create",
    fields: founderFields(),
  });
  assert.equal(result.snapshot.status, "received");
}

function coordinator(
  storage: StorageAdapter,
  participant: ParticipantAccount | null,
  amount: AmountConfiguration = AMOUNT,
): StorageParticipantAccountDeletionRepository {
  return new StorageParticipantAccountDeletionRepository(
    storage,
    participant,
    FOUNDER_APPLICATION_ID,
    amount,
  );
}

function deletionRequest(operationId: string, expectedRevision: number) {
  return Object.freeze({ operationId, expectedRevision, requestedAt: REQUESTED_AT });
}

function founderFields() {
  return {
    expertiseSummary: "Product and systems engineering.",
    intendedContribution: "Build and operate the product.",
    primaryContributionAreaId: CHOICES[0]!.id,
    secondaryContributionAreaIds: [],
    approximateAvailability: "Full time after formation.",
    possibleStartTiming: "Within one month.",
    compensationExpectation: "Open discussion.",
    professionalProfileLinks: ["https://example.invalid/profile"],
    note: null,
  };
}

function companyFields(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    kind: "company",
    companyName: "Deletion fixture company",
    registrationCountry: "FI",
    companyIdentifier: "ACCOUNT-DELETION-FIXTURE",
    representativeName: "Fixture Representative",
    representativeAuthorityDeclared: true,
    amount: 2_000,
    availabilityPeriod: "Within twelve months.",
    note: null,
    ...overrides,
  };
}

async function persistAggregateProjection(
  storage: StorageAdapter,
  indication: Parameters<typeof projectInvestmentIndicationForAggregation>[0],
  operationId: string,
): Promise<void> {
  const aggregate = new DevelopmentInMemoryAggregateRepository(
    storage,
    AMOUNT.currency,
  );
  const current = await aggregate.readStored();
  const prepared = await prepareAtomicAggregateContribution(storage, {
    operationId,
    expectedStoredRevision: current.revision,
    contribution: projectInvestmentIndicationForAggregation(indication),
  }, AMOUNT.currency);
  await storage.transact({
    operationId: prepared.operationId,
    mutations: prepared.mutations,
  });
}

async function currentContext(
  participantSubject: ActorSubject,
  suffix: string,
): Promise<TrustedPackageAcknowledgmentContext> {
  const version = await packageVersion(`package-version:${suffix}`);
  return Object.freeze({
    currentVersion: version,
    latestAcceptance: acceptance(
      version,
      participantSubject,
      `package-acceptance:${suffix}`,
    ),
  });
}

async function packageVersion(id: string): Promise<PackageVersion> {
  const parsed = await createPackageVersion({
    id,
    createdAt: "2026-08-09T08:00:00.000Z",
    changeSummary: "Synthetic package",
    materialChange: false,
    acknowledgmentText: "This indication remains non-binding.",
    sections: [{
      id: `package-section:${id.slice("package-version:".length)}`,
      order: 0,
      title: "Overview",
      markdown: "Synthetic package.",
      enabled: true,
    }],
  }, null);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function acceptance(
  version: PackageVersion,
  participantSubject: ActorSubject,
  id: string,
): PackageAcceptanceRecord {
  const parsed = createPackageAcceptance({
    id,
    participantSubject,
    acceptedAt: "2026-08-09T09:00:00.000Z",
  }, version);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function recordsIn(state: MemoryStorageState, collection: string) {
  return [...state.records.values()].filter((record) =>
    record.key.collection === collection
  );
}

function deletionAuditCount(state: MemoryStorageState): number {
  return recordsIn(state, "audit-events").filter((record) => {
    const event = record.value.event as
      | Readonly<Record<string, unknown>>
      | undefined;
    const detail = event?.detail as
      | Readonly<Record<string, unknown>>
      | undefined;
    return detail?.transition === "deletion-requested";
  }).length;
}

function requiredStoredRecord(
  state: MemoryStorageState,
  collection: string,
  predicate: (record: ReturnType<typeof recordsIn>[number]) => boolean = () =>
    true,
): readonly [string, ReturnType<typeof recordsIn>[number]] {
  const entry = [...state.records.entries()].find(([, record]) =>
    record.key.collection === collection && predicate(record)
  );
  assert(entry !== undefined, `Missing ${collection} test record.`);
  return entry;
}

function stateFingerprint(state: MemoryStorageState): string {
  return JSON.stringify([...state.records.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  ));
}

function contributionAreaChoices(): readonly ContributionAreaChoice[] {
  const parsed = parseContributionAreaChoices([
    { id: "founder-area:engineering", label: "Engineering" },
  ]);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function amountConfiguration(
  overrides: Readonly<Record<string, unknown>> = {},
): AmountConfiguration {
  const parsed = parseAmountAggregateConfiguration({
    amount: {
      currency: "EUR",
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

function account(subjectValue: string, email: string): ParticipantAccount {
  const parsed = parseParticipantAccount({
    subject: subjectValue,
    accountEmailLabel: email,
  });
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function subject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function stableId<Entity extends string>(value: string): StableId<Entity> {
  const parsed = parseStableId<Entity>(value);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function indicationIdForOperation(value: unknown): InvestmentIndicationId {
  const parsed = parseStableId<"investment-indication">(value);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
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
  readonly #delegate: StorageAdapter;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  read(key: Parameters<StorageAdapter["read"]>[0]) {
    return this.#delegate.read(key);
  }

  list(request: StorageListRequest): Promise<StoragePage> {
    return this.#delegate.list(request);
  }

  async transact(): Promise<StorageTransactionResult> {
    throw new Error("PRIVATE_PROVIDER_BODY");
  }
}

class CommitEvidenceAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #mode: "throw" | "malformed";
  #first = true;

  constructor(delegate: StorageAdapter, mode: "throw" | "malformed") {
    this.#delegate = delegate;
    this.#mode = mode;
  }

  read(key: Parameters<StorageAdapter["read"]>[0]) {
    return this.#delegate.read(key);
  }

  list(request: StorageListRequest): Promise<StoragePage> {
    return this.#delegate.list(request);
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    const result = await this.#delegate.transact(request);
    if (!this.#first) return result;
    this.#first = false;
    if (this.#mode === "throw") throw new Error("PRIVATE_PROVIDER_BODY");
    return Object.freeze({ replayed: false, records: Object.freeze([]) });
  }
}

class BeforeTransactionStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #beforeTransaction: () => Promise<void>;
  injected = false;

  constructor(
    delegate: StorageAdapter,
    beforeTransaction: () => Promise<void>,
  ) {
    this.#delegate = delegate;
    this.#beforeTransaction = beforeTransaction;
  }

  read(key: Parameters<StorageAdapter["read"]>[0]) {
    return this.#delegate.read(key);
  }

  list(request: StorageListRequest): Promise<StoragePage> {
    return this.#delegate.list(request);
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    if (!this.injected) {
      this.injected = true;
      await this.#beforeTransaction();
    }
    return this.#delegate.transact(request);
  }
}

class CountingStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readCalls = 0;
  listCalls = 0;
  transactCalls = 0;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  read(key: Parameters<StorageAdapter["read"]>[0]) {
    this.readCalls += 1;
    return this.#delegate.read(key);
  }

  list(request: StorageListRequest): Promise<StoragePage> {
    this.listCalls += 1;
    return this.#delegate.list(request);
  }

  transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    this.transactCalls += 1;
    return this.#delegate.transact(request);
  }
}
