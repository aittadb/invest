import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
import type { ResourceTransition } from "../domain/audit-notification.ts";
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
import { StorageFailure } from "../domain/storage-adapter.ts";
import {
  createParticipantInvestmentInterestService,
  type CreateInvestmentInterestInput,
  type InvestmentInterestPermissions,
} from "../worker/investment-interest-service.ts";
import type {
  AtomicParticipantInvestmentInterestMutationPort,
} from "../worker/participant-investment-mutation-port.ts";
import {
  InvestmentInterestRepositoryFixture,
  InvestmentInterestRepositoryFixtureState,
} from "./support/investment-interest-repository-fixture.ts";

const ALICE = subject("issuer.invalid/participant:alice-investment");
const BOB = subject("issuer.invalid/participant:bob-investment");
const AMOUNT = configuredAmount();
const ALLOW_ALL = Object.freeze({
  createPersonal: true,
  createCompany: true,
  reactivatePersonal: true,
  reactivateCompany: true,
}) satisfies InvestmentInterestPermissions;

test("investment service binds identity and preserves lifecycle history on retries", async () => {
  const state = new InvestmentInterestRepositoryFixtureState();
  const context = await currentContext(ALICE, "alice-lifecycle");
  const persistence = new InvestmentInterestRepositoryFixture(
    state,
    ALICE,
    AMOUNT,
  );
  let clockCalls = 0;
  const service = createParticipantInvestmentInterestService({
    actorSubject: ALICE,
    amountConfiguration: AMOUNT,
    reader: persistence,
    mutations: persistence,
    loadAcknowledgmentContext: () => context,
    loadPermissions: () => ALLOW_ALL,
    indicationIdForOperation,
    now: () => {
      clockCalls += 1;
      return new Date(`2026-08-10T1${clockCalls - 1}:00:00.000Z`);
    },
  });
  const createInput = {
    operationId: "investment-operation:alice-personal-create",
    fields: personalFields(),
    participantSubject: BOB,
    actorSubject: BOB,
  } satisfies CreateInvestmentInterestInput & Readonly<{
    participantSubject: ActorSubject;
    actorSubject: ActorSubject;
  }>;

  const created = await service.create(createInput);
  assertAtomicEvidence(state, created.snapshot.id, {
    aggregateRevision: 1,
    totalAmount: 1_250,
    count: 1,
    transitions: ["created"],
  });
  const replay = await service.create(createInput);
  assert.equal(created.snapshot.participantSubject, ALICE);
  assert.equal(created.snapshot.id, createInput.operationId);
  assert.equal(replay.replayed, true);
  assert.equal(clockCalls, 1);
  assert.equal(state.requests.length, 2);
  assert.equal(
    state.requests[0]?.request.occurredAt,
    state.requests[1]?.request.occurredAt,
  );
  assert.equal(
    Object.hasOwn(state.requests[0]?.request ?? {}, "participantSubject"),
    false,
  );
  // An identical retry returns the original triple without advancing evidence.
  assertAtomicEvidence(state, created.snapshot.id, {
    aggregateRevision: 1,
    totalAmount: 1_250,
    count: 1,
    transitions: ["created"],
  });

  const initialState = await service.getCollectionState();
  assert.equal(initialState.canCreatePersonal, false);
  assert.equal(initialState.canCreateCompany, true);
  assert.equal(initialState.indications.length, 1);

  const edited = await service.edit({
    operationId: "investment-operation:alice-personal-edit",
    indicationId: created.snapshot.id,
    expectedRevision: 1,
    fields: personalFields({
      amount: 1_500,
      note: "Updated private note.",
    }),
  });
  assert.equal(edited.snapshot.revision, 2);
  assert.equal(edited.snapshot.history[0]?.fields.note, "Initial private note.");
  assert.equal(edited.snapshot.history[1]?.fields.note, "Updated private note.");
  assertAtomicEvidence(state, created.snapshot.id, {
    aggregateRevision: 2,
    totalAmount: 1_500,
    count: 1,
    transitions: ["created", "updated"],
  });

  const withdrawn = await service.withdraw({
    operationId: "investment-operation:alice-personal-withdraw",
    indicationId: created.snapshot.id,
    expectedRevision: 2,
  });
  assert.equal(withdrawn.snapshot.lifecycle.status, "withdrawn");
  assertAtomicEvidence(state, created.snapshot.id, {
    aggregateRevision: 3,
    totalAmount: 0,
    count: 0,
    transitions: ["created", "updated", "withdrawn"],
  });
  const withdrawReplay = await service.withdraw({
    operationId: "investment-operation:alice-personal-withdraw",
    indicationId: created.snapshot.id,
    expectedRevision: 2,
  });
  assert.equal(withdrawReplay.replayed, true);
  assert.equal(clockCalls, 3);
  assertAtomicEvidence(state, created.snapshot.id, {
    aggregateRevision: 3,
    totalAmount: 0,
    count: 0,
    transitions: ["created", "updated", "withdrawn"],
  });

  const withdrawnState = await service.getItemState(created.snapshot.id);
  assert.equal(withdrawnState?.canEdit, false);
  assert.equal(withdrawnState?.canWithdraw, false);
  assert.equal(withdrawnState?.canReactivate, true);

  const reactivated = await service.reactivate({
    operationId: "investment-operation:alice-personal-reactivate",
    indicationId: created.snapshot.id,
    expectedRevision: 3,
  });
  assert.deepEqual(
    reactivated.snapshot.history.map((entry) => entry.transition),
    ["created", "edited", "withdrawn", "reactivated"],
  );
  assert.equal(Object.isFrozen(reactivated.snapshot.history[0]), true);
  assertAtomicEvidence(state, created.snapshot.id, {
    aggregateRevision: 4,
    totalAmount: 1_500,
    count: 1,
    transitions: ["created", "updated", "withdrawn", "reactivated"],
  });

  const stale = await captureStorageFailure(() =>
    service.edit({
      operationId: "investment-operation:alice-stale",
      indicationId: created.snapshot.id,
      expectedRevision: 2,
      fields: personalFields(),
    })
  );
  assert.equal(stale.code, "PRECONDITION_FAILED");
});

test("forced atomic mutation failure leaves indication, aggregate, audit, and retry evidence unchanged", async () => {
  const state = new InvestmentInterestRepositoryFixtureState();
  const persistence = new InvestmentInterestRepositoryFixture(
    state,
    ALICE,
    AMOUNT,
  );
  let hour = 9;
  const service = createParticipantInvestmentInterestService({
    actorSubject: ALICE,
    amountConfiguration: AMOUNT,
    reader: persistence,
    mutations: persistence,
    loadAcknowledgmentContext: () => currentContext(ALICE, "atomic-failure"),
    loadPermissions: () => ALLOW_ALL,
    indicationIdForOperation,
    now: () => new Date(`2026-08-13T${String(hour++).padStart(2, "0")}:00:00.000Z`),
  });
  const created = await service.create({
    operationId: "investment-operation:atomic-failure-create",
    fields: personalFields(),
  });
  const before = state.evidence();
  const operationCount = state.operations.size;

  state.forceNextAtomicFailure();
  const failure = await captureStorageFailure(() =>
    service.edit({
      operationId: "investment-operation:atomic-failure-edit",
      indicationId: created.snapshot.id,
      expectedRevision: 1,
      fields: personalFields({
        amount: 1_750,
        note: "Must not survive the failed transaction.",
      }),
    })
  );

  assert.equal(failure.code, "UNAVAILABLE");
  assert.deepEqual(state.evidence(), before);
  assert.equal(state.operations.size, operationCount);

  await service.edit({
    operationId: "investment-operation:atomic-failure-edit",
    indicationId: created.snapshot.id,
    expectedRevision: 1,
    fields: personalFields({
      amount: 1_750,
      note: "Committed only after a successful retry.",
    }),
  });
  assertAtomicEvidence(state, created.snapshot.id, {
    aggregateRevision: 2,
    totalAmount: 1_750,
    count: 1,
    transitions: ["created", "updated"],
  });
});

test("service rejects mutation persistence without the explicit atomic capability", async () => {
  const state = new InvestmentInterestRepositoryFixtureState();
  const persistence = new InvestmentInterestRepositoryFixture(
    state,
    ALICE,
    AMOUNT,
  );
  const weakMutations = Object.freeze({
    mutationConsistency: "best-effort",
    commit: persistence.commit.bind(persistence),
  }) as unknown as AtomicParticipantInvestmentInterestMutationPort;

  assert.throws(
    () => createParticipantInvestmentInterestService({
      actorSubject: ALICE,
      amountConfiguration: AMOUNT,
      reader: persistence,
      mutations: weakMutations,
      loadAcknowledgmentContext: () => currentContext(ALICE, "weak-port"),
      loadPermissions: () => ALLOW_ALL,
      indicationIdForOperation,
    }),
    /Invalid investment-interest service configuration\./u,
  );
});

test("current acknowledgment and deployment permissions gate advertised and persisted actions", async () => {
  const state = new InvestmentInterestRepositoryFixtureState();
  const current = await currentContext(ALICE, "alice-gates");
  const stale = await staleContext(ALICE, "alice-gates-stale");
  let context: TrustedPackageAcknowledgmentContext = current;
  let permissions: InvestmentInterestPermissions = ALLOW_ALL;
  let hour = 9;
  const persistence = new InvestmentInterestRepositoryFixture(
    state,
    ALICE,
    AMOUNT,
  );
  const service = createParticipantInvestmentInterestService({
    actorSubject: ALICE,
    amountConfiguration: AMOUNT,
    reader: persistence,
    mutations: persistence,
    loadAcknowledgmentContext: () => context,
    loadPermissions: () => permissions,
    indicationIdForOperation,
    now: () => new Date(`2026-08-12T${String(hour++).padStart(2, "0")}:00:00.000Z`),
  });

  const personal = await service.create({
    operationId: "investment-operation:gated-personal",
    fields: personalFields(),
  });
  context = stale;

  const staleCollection = await service.getCollectionState();
  assert.equal(staleCollection.acknowledgmentCurrent, false);
  assert.equal(staleCollection.canCreatePersonal, false);
  assert.equal(staleCollection.canCreateCompany, false);
  const staleItem = await service.getItemState(personal.snapshot.id);
  assert.equal(staleItem?.canEdit, false);
  assert.equal(staleItem?.canWithdraw, true);

  assert.equal(
    (await captureStorageFailure(() =>
      service.edit({
        operationId: "investment-operation:gated-stale-edit",
        indicationId: personal.snapshot.id,
        expectedRevision: 1,
        fields: personalFields({ amount: 1_500 }),
      })
    )).code,
    "PRECONDITION_FAILED",
  );
  const withdrawn = await service.withdraw({
    operationId: "investment-operation:gated-withdraw",
    indicationId: personal.snapshot.id,
    expectedRevision: 1,
  });
  assert.equal(withdrawn.snapshot.lifecycle.status, "withdrawn");
  assert.equal(
    (await captureStorageFailure(() =>
      service.reactivate({
        operationId: "investment-operation:gated-stale-reactivate",
        indicationId: personal.snapshot.id,
        expectedRevision: 2,
      })
    )).code,
    "PRECONDITION_FAILED",
  );

  context = current;
  permissions = Object.freeze({
    ...ALLOW_ALL,
    createCompany: false,
    reactivatePersonal: false,
  });
  const permittedState = await service.getCollectionState();
  assert.equal(permittedState.canCreatePersonal, true);
  assert.equal(permittedState.canCreateCompany, false);
  assert.equal(
    (await captureStorageFailure(() =>
      service.create({
        operationId: "investment-operation:gated-company",
        fields: companyFields(),
      })
    )).code,
    "PRECONDITION_FAILED",
  );
  assert.equal(
    (await captureStorageFailure(() =>
      service.reactivate({
        operationId: "investment-operation:gated-policy-reactivate",
        indicationId: personal.snapshot.id,
        expectedRevision: 2,
      })
    )).code,
    "PRECONDITION_FAILED",
  );
});

test("investment route and service contain no production in-process persistence", async () => {
  const sources = await Promise.all([
    readFile(
      new URL("../worker/investment-interest-service.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../worker/routes/investment-interest.ts", import.meta.url),
      "utf8",
    ),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(
      source,
      /DevelopmentInMemory|localStorage|sessionStorage|new\s+Map\s*</u,
    );
  }
});

function personalFields(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    kind: "personal",
    residenceCountry: "FI",
    amount: 1_250,
    availabilityPeriod: "Within twelve months.",
    note: "Initial private note.",
    ...overrides,
  };
}

function companyFields(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    kind: "company",
    companyName: "Synthetic company",
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

async function staleContext(
  participantSubject: ActorSubject,
  suffix: string,
): Promise<TrustedPackageAcknowledgmentContext> {
  const initial = await packageVersion(`package-version:${suffix}:initial`);
  const current = await packageVersion(
    `package-version:${suffix}:material`,
    initial,
    true,
  );
  return Object.freeze({
    currentVersion: current,
    latestAcceptance: acceptance(
      initial,
      participantSubject,
      `package-acceptance:${suffix}:initial`,
    ),
  });
}

async function packageVersion(
  id: string,
  previous: PackageVersion | null = null,
  materialChange = false,
): Promise<PackageVersion> {
  const parsed = await createPackageVersion(
    {
      id,
      createdAt: previous === null
        ? "2026-08-09T08:00:00.000Z"
        : "2026-08-11T08:00:00.000Z",
      changeSummary: materialChange
        ? "Material synthetic update"
        : "Initial synthetic package",
      materialChange,
      acknowledgmentText:
        "This non-binding indication can be edited or withdrawn.",
      sections: [{
        id: "package-section:investment-overview",
        order: 0,
        title: "Overview",
        markdown: materialChange
          ? "Updated synthetic package."
          : "Synthetic package.",
        enabled: true,
      }],
    },
    previous,
  );
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function acceptance(
  version: PackageVersion,
  participantSubject: ActorSubject,
  id: string,
): PackageAcceptanceRecord {
  const parsed = createPackageAcceptance(
    {
      id,
      participantSubject,
      acceptedAt: "2026-08-09T09:00:00.000Z",
    },
    version,
  );
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function subject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
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
  assert.fail("Expected a StorageFailure.");
}

function assertAtomicEvidence(
  state: InvestmentInterestRepositoryFixtureState,
  indicationId: InvestmentIndicationId,
  expected: Readonly<{
    aggregateRevision: number;
    totalAmount: number;
    count: number;
    transitions: readonly Extract<
      ResourceTransition,
      "created" | "updated" | "withdrawn" | "reactivated"
    >[];
  }>,
): void {
  const evidence = state.evidence();
  assert.equal(evidence.indications.length, 1);
  assert.equal(evidence.indications[0]?.id, indicationId);
  assert.equal(evidence.indications[0]?.revision, expected.aggregateRevision);
  assert.equal(evidence.aggregate.revision, expected.aggregateRevision);
  assert.equal(evidence.aggregate.totalAmount, expected.totalAmount);
  assert.equal(evidence.aggregate.contributingIndicationCount, expected.count);
  assert.equal(evidence.aggregate.currency, AMOUNT.currency);
  assert.equal(evidence.auditEvents.length, expected.transitions.length);
  assert.deepEqual(
    evidence.auditEvents.map((event) => {
      assert.deepEqual(Object.keys(event).sort(), [
        "actor",
        "detail",
        "id",
        "occurredAt",
        "operationId",
      ]);
      assert.equal(event.actor.type, "participant");
      if (event.actor.type !== "participant") assert.fail("Unexpected actor.");
      assert.equal(event.actor.subject, ALICE);
      assert.deepEqual(Object.keys(event.actor).sort(), ["subject", "type"]);
      assert.equal(event.detail.kind, "resource-transition");
      if (event.detail.kind !== "resource-transition") {
        assert.fail("Unexpected audit detail.");
      }
      assert.deepEqual(Object.keys(event.detail).sort(), [
        "kind",
        "resource",
        "transition",
      ]);
      assert.deepEqual(Object.keys(event.detail.resource).sort(), ["id", "type"]);
      assert.equal(event.detail.resource.type, "investment-indication");
      assert.equal(event.detail.resource.id, indicationId);
      return event.detail.transition;
    }),
    expected.transitions,
  );
  assert.equal(Object.isFrozen(evidence.aggregate), true);
  assert.equal(evidence.auditEvents.every(Object.isFrozen), true);
}
