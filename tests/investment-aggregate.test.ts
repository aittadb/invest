import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAmountAggregateConfiguration,
  type AmountAggregateConfiguration,
  type CurrencyCode,
} from "../domain/amount-aggregate-configuration.ts";
import {
  DomainError,
  parseMinorUnits,
  parseStableId,
  type MinorUnits,
} from "../domain/foundation.ts";
import {
  APPLY_CALCULATED_AGGREGATE_CONFIRMATION,
  calculateInvestmentAggregateSummary,
  confirmInvestmentAggregateCorrection,
  createPublicOversubscriptionDisplayData,
  createSanitizedPublicInvestmentAggregate,
  previewInvestmentAggregateReconciliation,
  projectInvestmentIndicationForAggregation,
  type InvestmentAggregateContribution,
  type InvestmentAggregateSummary,
  type StoredInvestmentAggregateSnapshot,
} from "../domain/investment-aggregate.ts";

const configuration = aggregateConfiguration();
const currency = configuration.amount.currency;

test("only active latest indication revisions contribute", () => {
  const summary = calculateInvestmentAggregateSummary(
    [
      contribution("indication:active", 1, "active", 4_000),
      contribution("indication:withdrawn", 1, "active", 3_000),
      contribution("indication:withdrawn", 2, "withdrawn", 3_000),
      contribution("indication:rejected", 1, "active", 2_000),
      contribution("indication:rejected", 2, "rejected", 2_000),
    ],
    currency,
  );

  assert.deepEqual(summary, {
    totalAmount: 4_000,
    currency: "XYZ",
    contributingIndicationCount: 1,
  });
  assert.equal(Object.isFrozen(summary), true);
});

test("duplicate deliveries and retries collapse deterministically", () => {
  const active = contribution("indication:first", 3, "active", 2_500);
  const activeRetry = { ...active };
  const superseded = contribution("indication:second", 4, "active", 9_000);
  const withdrawn = contribution("indication:second", 5, "withdrawn", 9_000);
  const inputs = [active, activeRetry, superseded, withdrawn, { ...withdrawn }];

  const first = calculateInvestmentAggregateSummary(inputs, currency);
  const reversed = calculateInvestmentAggregateSummary(
    [...inputs].reverse(),
    currency,
  );
  assert.deepEqual(first, reversed);
  assert.deepEqual(first, {
    totalAmount: 2_500,
    currency: "XYZ",
    contributingIndicationCount: 1,
  });

  assert.throws(
    () =>
      calculateInvestmentAggregateSummary(
        [active, contribution("indication:first", 3, "active", 2_750)],
        currency,
      ),
    (error) => error instanceof DomainError && error.code === "RESOURCE_CONFLICT",
  );
});

test("reconciliation previews stored and calculated matches and mismatches", () => {
  const calculated = summary(7_500, 2);
  const matching = previewInvestmentAggregateReconciliation(
    stored(8, 7_500, 2),
    calculated,
  );
  assert.deepEqual(matching, {
    status: "match",
    stored: {
      revision: 8,
      totalAmount: 7_500,
      currency: "XYZ",
      contributingIndicationCount: 2,
    },
    calculated,
    correctionRequired: false,
  });

  const mismatch = previewInvestmentAggregateReconciliation(
    stored(8, 6_000, 3),
    calculated,
  );
  assert.deepEqual(mismatch, {
    status: "mismatch",
    stored: {
      revision: 8,
      totalAmount: 6_000,
      currency: "XYZ",
      contributingIndicationCount: 3,
    },
    calculated,
    correctionRequired: true,
  });
  assert.equal(Object.isFrozen(mismatch), true);
  assert.equal(Object.isFrozen(mismatch.stored), true);
  assert.equal(Object.isFrozen(mismatch.calculated), true);
});

test("a correction requires exact explicit confirmation of the mismatch preview", () => {
  const mismatch = previewInvestmentAggregateReconciliation(
    stored(8, 6_000, 3),
    summary(7_500, 2),
  );
  const confirmation = {
    confirmation: APPLY_CALCULATED_AGGREGATE_CONFIRMATION,
    expectedStoredRevision: 8,
    expectedStoredAmount: 6_000,
    expectedStoredContributingIndicationCount: 3,
    expectedCalculatedAmount: 7_500,
    expectedCalculatedContributingIndicationCount: 2,
  };

  assert.deepEqual(confirmInvestmentAggregateCorrection(mismatch, {}), {
    ok: false,
    issues: [{ code: "required", path: "confirmation" }],
  });
  assert.equal(
    confirmInvestmentAggregateCorrection(mismatch, {
      ...confirmation,
      confirmation: "yes",
    }).ok,
    false,
  );

  const confirmed = confirmInvestmentAggregateCorrection(
    mismatch,
    confirmation,
  );
  assert.deepEqual(confirmed, {
    ok: true,
    value: {
      confirmed: true,
      expectedStoredRevision: 8,
      replacement: {
        revision: 9,
        totalAmount: 7_500,
        currency: "XYZ",
        contributingIndicationCount: 2,
      },
    },
  });

  assert.throws(
    () =>
      confirmInvestmentAggregateCorrection(mismatch, {
        ...confirmation,
        expectedCalculatedAmount: 7_750,
      }),
    (error) =>
      error instanceof DomainError && error.code === "PRECONDITION_FAILED",
  );

  const matching = previewInvestmentAggregateReconciliation(
    stored(8, 7_500, 2),
    summary(7_500, 2),
  );
  assert.throws(
    () => confirmInvestmentAggregateCorrection(matching, confirmation),
    (error) =>
      error instanceof DomainError && error.code === "PRECONDITION_FAILED",
  );
});

test("oversubscription display uses integer target, remaining, and excess amounts", () => {
  assert.deepEqual(createPublicOversubscriptionDisplayData(8_000, 10_000), {
    ok: true,
    value: {
      status: "below_target",
      targetAmount: 10_000,
      remainingAmount: 2_000,
      amountOverTarget: 0,
    },
  });
  assert.deepEqual(createPublicOversubscriptionDisplayData(10_000, 10_000), {
    ok: true,
    value: {
      status: "target_reached",
      targetAmount: 10_000,
      remainingAmount: 0,
      amountOverTarget: 0,
    },
  });
  assert.deepEqual(createPublicOversubscriptionDisplayData(12_500, 10_000), {
    ok: true,
    value: {
      status: "oversubscribed",
      targetAmount: 10_000,
      remainingAmount: 0,
      amountOverTarget: 2_500,
    },
  });
  assert.equal(createPublicOversubscriptionDisplayData(1.5, 10_000).ok, false);
  assert.equal(createPublicOversubscriptionDisplayData(10_000, 0).ok, false);
});

test("public aggregate projection is closed to safe display fields", () => {
  const privateIndication = {
    id: indicationId("indication:projection"),
    revision: 4,
    participantSubject: "issuer.invalid/subject:private",
    lifecycle: { status: "active" as const, moderation: "private rejection note" },
    fields: {
      amount: minorUnits(12_500),
      currency,
      companyName: "Private company",
      note: "Private strategic note",
    },
  };
  const contributionProjection =
    projectInvestmentIndicationForAggregation(privateIndication);
  assert.deepEqual(contributionProjection, {
    indicationId: indicationId("indication:projection"),
    indicationRevision: 4,
    status: "active",
    amount: 12_500,
    currency: "XYZ",
  });
  assert.doesNotMatch(
    JSON.stringify(contributionProjection),
    /private|company|note|subject|moderation/iu,
  );

  const privateSummary = {
    ...summary(12_500, 2),
    participantSubject: "issuer.invalid/subject:private",
    companyName: "Private company",
    note: "Private strategic note",
    indicationStates: ["active", "rejected"],
    moderation: { rejected: 1 },
  };

  const result = createSanitizedPublicInvestmentAggregate(
    privateSummary,
    configuration,
    10_000,
  );
  assert.deepEqual(result, {
    ok: true,
    value: {
      amount: 12_500,
      currency: "XYZ",
      label: "Indicated interest",
      qualifier: "Self-declared, unverified, and non-binding.",
      oversubscription: {
        status: "oversubscribed",
        targetAmount: 10_000,
        remainingAmount: 0,
        amountOverTarget: 2_500,
      },
    },
  });
  if (!result.ok || result.value === null) assert.fail("Expected public data.");
  assert.deepEqual(Object.keys(result.value), [
    "amount",
    "currency",
    "label",
    "qualifier",
    "oversubscription",
  ]);
  assert.doesNotMatch(
    JSON.stringify(result.value),
    /private|company|note|subject|active|rejected|moderation|contributing/iu,
  );

  assert.deepEqual(
    createSanitizedPublicInvestmentAggregate(summary(0, 0), configuration, 10_000),
    { ok: true, value: null },
  );
});

function aggregateConfiguration(): AmountAggregateConfiguration {
  const parsed = parseAmountAggregateConfiguration({
    amount: {
      currency: "XYZ",
      minimum: 0,
      increment: 250,
      maximum: 100_000,
    },
    publicAggregate: {
      visibility: "non_zero",
      label: "Indicated interest",
      qualifier: "Self-declared, unverified, and non-binding.",
    },
  });
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function contribution(
  id: string,
  indicationRevision: number,
  status: InvestmentAggregateContribution["status"],
  value: number,
): InvestmentAggregateContribution {
  return {
    indicationId: indicationId(id),
    indicationRevision,
    status,
    amount: minorUnits(value),
    currency,
  };
}

function indicationId(value: string) {
  const parsed = parseStableId<"investment-indication">(value);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function summary(
  totalAmount: number,
  contributingIndicationCount: number,
): InvestmentAggregateSummary {
  return Object.freeze({
    totalAmount: minorUnits(totalAmount),
    currency,
    contributingIndicationCount,
  });
}

function stored(
  revision: number,
  totalAmount: number,
  contributingIndicationCount: number,
): StoredInvestmentAggregateSnapshot {
  return Object.freeze({
    revision,
    totalAmount: minorUnits(totalAmount),
    currency,
    contributingIndicationCount,
  });
}

function minorUnits(value: number): MinorUnits {
  const parsed = parseMinorUnits(value);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

void (currency satisfies CurrencyCode);
