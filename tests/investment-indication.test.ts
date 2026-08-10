import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAmountAggregateConfiguration,
  type AmountConfiguration,
} from "../domain/amount-aggregate-configuration.ts";
import {
  DomainError,
  parseActorSubject,
  toPublicDomainError,
  type ValidationResult,
} from "../domain/foundation.ts";
import {
  activeIndicationUniquenessKey,
  assertNoActiveIndicationConflict,
  createInvestmentIndication,
  editInvestmentIndication,
  MAX_INVESTMENT_INDICATION_REVISIONS,
  participantVisibleIndicationLifecycle,
  reactivateInvestmentIndication,
  rejectInvestmentIndication,
  withdrawInvestmentIndication,
  type ActiveInvestmentIndication,
  type InvestmentIndication,
  type OwnerIndicationActor,
  type ParticipantIndicationActor,
  type TrustedPackageAcknowledgmentContext,
} from "../domain/investment-indication.ts";
import {
  createPackageAcceptance,
  createPackageVersion,
  type PackageAcceptanceRecord,
  type PackageVersion,
} from "../domain/package-content.ts";

const amountConfiguration = configuredAmount();
const firstParticipant = participant("issuer.invalid/subject:first-investor");
const secondParticipant = participant("issuer.invalid/subject:second-investor");
const owner = ownerActor("issuer.invalid/subject:campaign-owner");

test("one personal indication can be active for a participant", async () => {
  const version = await packageVersion();
  const firstContext = acknowledgmentContext(
    version,
    acceptance(version, firstParticipant, "acceptance:personal:first"),
  );
  const first = createIndication(
    createInput("indication:personal:first", personalFields()),
    firstParticipant,
    firstContext,
  );

  assert.equal(first.kind, "personal");
  assert.equal(first.lifecycle.status, "active");
  assert.equal(first.fields.amount, 1_250);
  assert.equal(first.fields.currency, "XYZ");
  assert.equal(first.history[0]?.transition, "created");
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.fields), true);
  assert.equal(Object.isFrozen(first.history), true);
  assert.deepEqual(participantVisibleIndicationLifecycle(first), {
    status: "active",
    rejectionReason: null,
    transitions: [
      { type: "edit", acknowledgment: "current-required" },
      { type: "withdraw", acknowledgment: "not-required" },
    ],
  });

  const duplicate = createIndication(
    createInput("indication:personal:duplicate", personalFields({ amount: 1_500 })),
    firstParticipant,
    firstContext,
  );
  const failure = capturePublicFailure(() =>
    assertNoActiveIndicationConflict(duplicate, [first]),
  );
  assert.deepEqual(failure, {
    status: 409,
    body: {
      error: {
        code: "CONFLICT",
        message: "The request conflicts with current state.",
      },
    },
  });

  const secondContext = acknowledgmentContext(
    version,
    acceptance(version, secondParticipant, "acceptance:personal:second"),
  );
  const anotherParticipant = createIndication(
    createInput("indication:personal:other", personalFields()),
    secondParticipant,
    secondContext,
  );
  assert.doesNotThrow(() =>
    assertNoActiveIndicationConflict(anotherParticipant, [first]),
  );
});

test("the bounded lifecycle stops advertising or accepting revision seventeen", async () => {
  const version = await packageVersion();
  const context = acknowledgmentContext(
    version,
    acceptance(version, firstParticipant, "acceptance:revision-ceiling"),
  );
  let indication: InvestmentIndication = createIndication(
    createInput("indication:revision-ceiling", personalFields()),
    firstParticipant,
    context,
  );
  for (
    let revision = 2;
    revision < MAX_INVESTMENT_INDICATION_REVISIONS;
    revision += 1
  ) {
    const transition = transitionInput(
      `indication-history:revision-ceiling-${revision}`,
      `2026-08-${String(9 + revision).padStart(2, "0")}T11:00:00.000Z`,
    );
    const result: ValidationResult<InvestmentIndication> =
      indication.lifecycle.status === "active"
      ? withdrawInvestmentIndication(indication, transition, firstParticipant)
      : reactivateInvestmentIndication(
          indication,
          transition,
          firstParticipant,
          context,
        );
    indication = valueOf(result);
  }

  assert.equal(indication.revision, MAX_INVESTMENT_INDICATION_REVISIONS - 1);
  assert.deepEqual(participantVisibleIndicationLifecycle(indication), {
    status: "active",
    rejectionReason: null,
    transitions: [{ type: "withdraw", acknowledgment: "not-required" }],
  });
  const finalEdit = editInvestmentIndication(
    indication,
    {
      occurredAt: "2026-08-25T10:00:00.000Z",
      historyEntryId: "indication-history:revision-ceiling-final-edit",
      fields: personalFields({ note: "Must leave room to withdraw." }),
    },
    firstParticipant,
    amountConfiguration,
    context,
  );
  assert.equal(finalEdit.ok, false);

  indication = valueOf(withdrawInvestmentIndication(
    indication,
    transitionInput(
      "indication-history:revision-ceiling-16",
      "2026-08-25T11:00:00.000Z",
    ),
    firstParticipant,
  ));
  assert.equal(indication.revision, MAX_INVESTMENT_INDICATION_REVISIONS);
  assert.deepEqual(participantVisibleIndicationLifecycle(indication), {
    status: "withdrawn",
    rejectionReason: null,
    transitions: [],
  });
  const overflow = reactivateInvestmentIndication(
    indication,
    transitionInput(
      "indication-history:revision-ceiling-overflow",
      "2026-08-26T11:00:00.000Z",
    ),
    firstParticipant,
    context,
  );
  assert.equal(overflow.ok, false);
  if (!overflow.ok) {
    assert.deepEqual(overflow.issues, [{
      code: "out_of_range",
      path: "revision",
    }]);
  }
});

test("normalized company duplicates fail without disclosing the existing record", async () => {
  const version = await packageVersion();
  const first = createIndication(
    createInput(
      "indication:company:first",
      companyFields({
        companyName: "First synthetic company",
        companyIdentifier: "  acme １２３-ab  ",
      }),
    ),
    firstParticipant,
    acknowledgmentContext(
      version,
      acceptance(version, firstParticipant, "acceptance:company:first"),
    ),
  );
  const duplicate = createIndication(
    createInput(
      "indication:company:duplicate",
      companyFields({
        companyName: "Unrelated display name",
        companyIdentifier: "ACME123-AB",
      }),
    ),
    secondParticipant,
    acknowledgmentContext(
      version,
      acceptance(version, secondParticipant, "acceptance:company:second"),
    ),
  );

  assert.equal(first.kind, "company");
  assert.equal(duplicate.kind, "company");
  if (first.kind !== "company" || duplicate.kind !== "company") {
    assert.fail("Synthetic company indications must retain their kind.");
  }
  assert.equal(first.fields.registrationCountry, "AQ");
  assert.equal(first.fields.companyIdentifier, "ACME123-AB");
  assert.equal(
    activeIndicationUniquenessKey(first),
    activeIndicationUniquenessKey(duplicate),
  );

  const failure = capturePublicFailure(() =>
    assertNoActiveIndicationConflict(duplicate, [first]),
  );
  const serialized = JSON.stringify(failure);
  assert.deepEqual(failure, {
    status: 409,
    body: {
      error: {
        code: "CONFLICT",
        message: "The request conflicts with current state.",
      },
    },
  });
  assert.doesNotMatch(serialized, /ACME123-AB|First synthetic|first-investor/u);

  const otherCountry = createIndication(
    createInput(
      "indication:company:other-country",
      companyFields({
        registrationCountry: "BV",
        companyIdentifier: "ACME123-AB",
      }),
    ),
    secondParticipant,
    acknowledgmentContext(
      version,
      acceptance(version, secondParticipant, "acceptance:company:other-country"),
    ),
  );
  assert.doesNotThrow(() =>
    assertNoActiveIndicationConflict(otherCountry, [first]),
  );
});

test("withdrawal and reactivation append immutable participant-visible history", async () => {
  const version = await packageVersion();
  const context = acknowledgmentContext(
    version,
    acceptance(version, firstParticipant, "acceptance:lifecycle"),
  );
  const created = createIndication(
    createInput("indication:lifecycle", personalFields()),
    firstParticipant,
    context,
  );
  const withdrawn = valueOf(
    withdrawInvestmentIndication(
      created,
      transitionInput("history:lifecycle:withdraw", "2026-08-09T12:00:00.000Z"),
      firstParticipant,
    ),
  );

  assert.equal(withdrawn.lifecycle.status, "withdrawn");
  assert.equal(withdrawn.revision, 2);
  assert.equal(activeIndicationUniquenessKey(withdrawn), null);
  assert.equal(withdrawn.history[1]?.transition, "withdrawn");
  assert.equal(withdrawn.history[0], created.history[0]);
  assert.equal(created.lifecycle.status, "active");
  assert.deepEqual(participantVisibleIndicationLifecycle(withdrawn), {
    status: "withdrawn",
    rejectionReason: null,
    transitions: [
      { type: "reactivate", acknowledgment: "current-required" },
    ],
  });

  const reactivated = valueOf(
    reactivateInvestmentIndication(
      withdrawn,
      transitionInput("history:lifecycle:reactivate", "2026-08-09T13:00:00.000Z"),
      firstParticipant,
      context,
    ),
  );
  assert.equal(reactivated.lifecycle.status, "active");
  assert.equal(reactivated.lifecycle.activatedAt, "2026-08-09T13:00:00.000Z");
  assert.equal(reactivated.revision, 3);
  assert.deepEqual(
    reactivated.history.map((entry) => entry.transition),
    ["created", "withdrawn", "reactivated"],
  );
  assert.equal(reactivated.history[1], withdrawn.history[1]);
  assert.equal(Object.isFrozen(reactivated.history[2]), true);
  assert.equal(
    activeIndicationUniquenessKey(reactivated),
    activeIndicationUniquenessKey(created),
  );
});

test("a material package change blocks create, edit, and reactivation until renewed acceptance", async () => {
  const initialVersion = await packageVersion();
  const staleAcceptance = acceptance(
    initialVersion,
    firstParticipant,
    "acceptance:material:initial",
  );
  const initialContext = acknowledgmentContext(initialVersion, staleAcceptance);
  const created = createIndication(
    createInput("indication:material", personalFields()),
    firstParticipant,
    initialContext,
  );
  const withdrawn = valueOf(
    withdrawInvestmentIndication(
      created,
      transitionInput("history:material:withdraw", "2026-08-09T12:00:00.000Z"),
      firstParticipant,
    ),
  );
  const materialVersion = await packageVersion(
    {
      id: "package-version:material",
      createdAt: "2026-08-10T10:00:00.000Z",
      changeSummary: "Material synthetic update",
      materialChange: true,
      sections: [packageSection("Materially updated package copy.")],
    },
    initialVersion,
  );
  const staleContext = acknowledgmentContext(materialVersion, staleAcceptance);

  const editFailure = capturePublicFailure(() =>
    editInvestmentIndication(
      created,
      {
        occurredAt: "2026-08-10T11:00:00.000Z",
        historyEntryId: "history:material:edit",
        fields: personalFields({ amount: 1_500 }),
      },
      firstParticipant,
      amountConfiguration,
      staleContext,
    ),
  );
  const reactivationFailure = capturePublicFailure(() =>
    reactivateInvestmentIndication(
      withdrawn,
      transitionInput(
        "history:material:reactivate-stale",
        "2026-08-10T11:00:00.000Z",
      ),
      firstParticipant,
      staleContext,
    ),
  );
  const createFailure = capturePublicFailure(() =>
    createInvestmentIndication(
      createInput(
        "indication:material:second",
        personalFields({ amount: 1_500 }),
        "2026-08-10T11:00:00.000Z",
      ),
      firstParticipant,
      amountConfiguration,
      staleContext,
    ),
  );

  for (const failure of [editFailure, reactivationFailure, createFailure]) {
    assert.deepEqual(failure, {
      status: 412,
      body: {
        error: {
          code: "PRECONDITION_FAILED",
          message: "A required condition has changed.",
        },
      },
    });
    assert.doesNotMatch(JSON.stringify(failure), /sha256|first-investor/u);
  }

  const renewedAcceptance = acceptance(
    materialVersion,
    firstParticipant,
    "acceptance:material:renewed",
    "2026-08-10T10:30:00.000Z",
  );
  const reactivated = valueOf(
    reactivateInvestmentIndication(
      withdrawn,
      transitionInput(
        "history:material:reactivate-renewed",
        "2026-08-10T11:00:00.000Z",
      ),
      firstParticipant,
      acknowledgmentContext(materialVersion, renewedAcceptance),
    ),
  );
  assert.equal(reactivated.lifecycle.status, "active");
  assert.equal(
    reactivated.acknowledgment.satisfiedRequirementHash,
    materialVersion.requiredAcceptanceHash,
  );
});

test("an owner rejection is terminal and exposes only its reason to the participant", async () => {
  const version = await packageVersion();
  const created = createIndication(
    createInput("indication:rejection", companyFields()),
    firstParticipant,
    acknowledgmentContext(
      version,
      acceptance(version, firstParticipant, "acceptance:rejection"),
    ),
  );
  const rejected = valueOf(
    rejectInvestmentIndication(
      created,
      {
        occurredAt: "2026-08-09T12:00:00.000Z",
        historyEntryId: "history:rejection",
        reason: "The indication is outside the current review scope.",
      },
      owner,
    ),
  );

  assert.equal(rejected.lifecycle.status, "rejected");
  assert.equal(rejected.history[1]?.transition, "rejected");
  assert.equal(rejected.history[1]?.actor.type, "owner");
  assert.equal(Object.isFrozen(rejected.lifecycle.rejection), true);
  const participantLifecycle = participantVisibleIndicationLifecycle(rejected);
  assert.deepEqual(participantLifecycle, {
    status: "rejected",
    rejectionReason: "The indication is outside the current review scope.",
    transitions: [],
  });
  assert.doesNotMatch(JSON.stringify(participantLifecycle), /campaign-owner/u);

  const terminalFailure = capturePublicFailure(() =>
    reactivateInvestmentIndication(
      rejected,
      transitionInput("history:rejection:reactivate", "2026-08-09T13:00:00.000Z"),
      firstParticipant,
      acknowledgmentContext(
        version,
        acceptance(version, firstParticipant, "acceptance:rejection:retry"),
      ),
    ),
  );
  assert.equal(terminalFailure.status, 409);
});

function configuredAmount(): AmountConfiguration {
  const result = parseAmountAggregateConfiguration({
    amount: {
      currency: "xyz",
      minimum: 1_000,
      increment: 250,
      maximum: 10_000,
    },
    publicAggregate: { visibility: "hidden" },
  });
  if (!result.ok) assert.fail(JSON.stringify(result.issues));
  return result.value.amount;
}

function personalFields(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    kind: "personal",
    residenceCountry: "aq",
    amount: 1_250,
    availabilityPeriod: "Within twelve months.",
    note: "Synthetic personal indication.",
    ...overrides,
  };
}

function companyFields(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    kind: "company",
    companyName: "Synthetic company",
    registrationCountry: "aq",
    companyIdentifier: "SYNTHETIC-123",
    representativeName: "Synthetic representative",
    representativeAuthorityDeclared: true,
    amount: 2_000,
    availabilityPeriod: "Within twelve months.",
    note: null,
    ...overrides,
  };
}

function createInput(
  id: string,
  fields: Readonly<Record<string, unknown>>,
  occurredAt = "2026-08-09T11:00:00.000Z",
) {
  return {
    id,
    occurredAt,
    historyEntryId: `${id}:created`,
    fields,
  };
}

function transitionInput(historyEntryId: string, occurredAt: string) {
  return { occurredAt, historyEntryId };
}

function createIndication(
  input: unknown,
  actor: ParticipantIndicationActor,
  context: TrustedPackageAcknowledgmentContext,
): ActiveInvestmentIndication {
  return valueOf(
    createInvestmentIndication(
      input,
      actor,
      amountConfiguration,
      context,
    ),
  );
}

function participant(subject: string): ParticipantIndicationActor {
  const result = parseActorSubject(subject);
  if (!result.ok) assert.fail(JSON.stringify(result.issues));
  return Object.freeze({ type: "participant", subject: result.value });
}

function ownerActor(subject: string): OwnerIndicationActor {
  const result = parseActorSubject(subject);
  if (!result.ok) assert.fail(JSON.stringify(result.issues));
  return Object.freeze({ type: "owner", subject: result.value });
}

async function packageVersion(
  overrides: Readonly<Record<string, unknown>> = {},
  previous: PackageVersion | null = null,
): Promise<PackageVersion> {
  const result = await createPackageVersion(
    {
      id: "package-version:initial",
      createdAt: "2026-08-09T10:00:00.000Z",
      changeSummary: "Initial synthetic package",
      materialChange: false,
      acknowledgmentText:
        "This non-binding indication can be edited or withdrawn.",
      sections: [packageSection("Synthetic package copy.")],
      ...overrides,
    },
    previous,
  );
  if (!result.ok) assert.fail(JSON.stringify(result.issues));
  return result.value;
}

function packageSection(markdown: string) {
  return {
    id: "package-section:overview",
    order: 0,
    title: "Overview",
    markdown,
    enabled: true,
  };
}

function acceptance(
  version: PackageVersion,
  actor: ParticipantIndicationActor,
  id: string,
  acceptedAt = "2026-08-09T10:30:00.000Z",
): PackageAcceptanceRecord {
  const result = createPackageAcceptance(
    { id, participantSubject: actor.subject, acceptedAt },
    version,
  );
  if (!result.ok) assert.fail(JSON.stringify(result.issues));
  return result.value;
}

function acknowledgmentContext(
  currentVersion: PackageVersion,
  latestAcceptance: PackageAcceptanceRecord | null,
): TrustedPackageAcknowledgmentContext {
  return Object.freeze({ currentVersion, latestAcceptance });
}

function valueOf<Value>(result: ValidationResult<Value>): Value {
  if (!result.ok) assert.fail(JSON.stringify(result.issues));
  return result.value;
}

function capturePublicFailure(operation: () => unknown) {
  let captured: unknown;
  try {
    operation();
  } catch (error) {
    captured = error;
  }
  assert(captured instanceof DomainError, "Expected a fixed domain failure.");
  return toPublicDomainError(captured);
}
