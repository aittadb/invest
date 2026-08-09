import assert from "node:assert/strict";
import test from "node:test";

import {
  createSanitizedPublicAggregateDisplay,
  parseAmountAggregateConfiguration,
  parseConfiguredAmount,
  type AmountAggregateConfiguration,
} from "../domain/amount-aggregate-configuration.ts";

function configuration(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    amount: {
      currency: " xyz ",
      minimum: 1_000,
      increment: 250,
      maximum: 2_000,
    },
    publicAggregate: {
      visibility: "non_zero",
      label: "  Indicated   interest  ",
      qualifier: "Self-declared, unverified, and non-binding.",
    },
    ...overrides,
  };
}

function requireConfiguration(value: unknown): AmountAggregateConfiguration {
  const result = parseAmountAggregateConfiguration(value);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("Expected a valid synthetic configuration.");
  return result.value;
}

test("parses explicit amount and non-zero aggregate display configuration", () => {
  assert.deepEqual(parseAmountAggregateConfiguration(configuration()), {
    ok: true,
    value: {
      amount: {
        currency: "XYZ",
        minimum: 1_000,
        increment: 250,
        maximum: 2_000,
      },
      publicAggregate: {
        visibility: "non_zero",
        label: "Indicated interest",
        qualifier: "Self-declared, unverified, and non-binding.",
      },
    },
  });
});

test("supports an explicit hidden display and an omitted optional maximum", () => {
  const input = configuration({
    amount: { currency: "ABC", minimum: 0, increment: 1 },
    publicAggregate: { visibility: "hidden" },
  });

  assert.deepEqual(parseAmountAggregateConfiguration(input), {
    ok: true,
    value: {
      amount: {
        currency: "ABC",
        minimum: 0,
        increment: 1,
        maximum: null,
      },
      publicAggregate: { visibility: "hidden" },
    },
  });
});

test("requires every non-optional choice and rejects unknown fields", () => {
  assert.deepEqual(parseAmountAggregateConfiguration({}), {
    ok: false,
    issues: [
      { code: "required", path: "amount" },
      { code: "required", path: "publicAggregate" },
    ],
  });

  const result = parseAmountAggregateConfiguration({
    ...configuration(),
    privateTotal: 9_999,
    amount: {
      currency: "XYZ",
      minimum: 1_000,
      increment: 250,
      identities: ["private-subject"],
    },
    publicAggregate: {
      visibility: "non_zero",
      label: "Interest",
      qualifier: "Non-binding.",
      notes: ["private note"],
    },
  });

  assert.deepEqual(result, {
    ok: false,
    issues: [
      { code: "invalid_rule", path: "privateTotal" },
      { code: "invalid_rule", path: "amount.identities" },
      { code: "invalid_rule", path: "publicAggregate.notes" },
    ],
  });
});

test("rejects invalid records, currency codes, and minor-unit rules", () => {
  assert.deepEqual(parseAmountAggregateConfiguration(null), {
    ok: false,
    issues: [{ code: "invalid_type", path: "configuration" }],
  });
  assert.equal(parseAmountAggregateConfiguration([]).ok, false);

  for (const amount of [
    { currency: "EU", minimum: 1_000, increment: 250 },
    { currency: 123, minimum: 1_000, increment: 250 },
    { currency: "XYZ", minimum: -1, increment: 250 },
    { currency: "XYZ", minimum: 1.5, increment: 250 },
    { currency: "XYZ", minimum: 1_000, increment: 0 },
    { currency: "XYZ", minimum: 1_000, increment: 250.5 },
    {
      currency: "XYZ",
      minimum: 1_000,
      increment: 250,
      maximum: Number.MAX_SAFE_INTEGER + 1,
    },
    { currency: "XYZ", minimum: 1_000, increment: 250, maximum: 999 },
  ]) {
    assert.equal(
      parseAmountAggregateConfiguration(configuration({ amount })).ok,
      false,
      JSON.stringify(amount),
    );
  }
});

test("accepts only safe integer amounts on configured increment boundaries", () => {
  const amount = requireConfiguration(configuration()).amount;

  assert.deepEqual(parseConfiguredAmount(1_000, amount), {
    ok: true,
    value: 1_000,
  });
  assert.deepEqual(parseConfiguredAmount(1_750, amount), {
    ok: true,
    value: 1_750,
  });
  assert.equal(parseConfiguredAmount(999, amount).ok, false);
  assert.equal(parseConfiguredAmount(1_001, amount).ok, false);
  assert.equal(parseConfiguredAmount(2_001, amount).ok, false);
  assert.equal(parseConfiguredAmount(1_250.5, amount).ok, false);
  assert.equal(
    parseConfiguredAmount(Number.MAX_SAFE_INTEGER + 1, amount).ok,
    false,
  );
});

test("rejects unsafe or incomplete public display configuration", () => {
  for (const publicAggregate of [
    {},
    { visibility: "always", label: "Interest", qualifier: "Non-binding." },
    { visibility: "non_zero", label: "", qualifier: "Non-binding." },
    { visibility: "non_zero", label: 1, qualifier: "Non-binding." },
    {
      visibility: "non_zero",
      label: "Interest <script>",
      qualifier: "Non-binding.",
    },
    {
      visibility: "non_zero",
      label: "Interest",
      qualifier: "Private\u202e disclosure",
    },
    { visibility: "hidden", qualifier: "Should not be published." },
  ]) {
    assert.equal(
      parseAmountAggregateConfiguration(
        configuration({ publicAggregate }),
      ).ok,
      false,
      JSON.stringify(publicAggregate),
    );
  }
});

test("projects only safe public fields and hides zero or disabled totals", () => {
  const visible = requireConfiguration(configuration());
  assert.deepEqual(createSanitizedPublicAggregateDisplay(1_750, visible), {
    ok: true,
    value: {
      amount: 1_750,
      currency: "XYZ",
      label: "Indicated interest",
      qualifier: "Self-declared, unverified, and non-binding.",
    },
  });
  assert.deepEqual(createSanitizedPublicAggregateDisplay(0, visible), {
    ok: true,
    value: null,
  });
  assert.equal(createSanitizedPublicAggregateDisplay(-1, visible).ok, false);

  const hidden = requireConfiguration(
    configuration({ publicAggregate: { visibility: "hidden" } }),
  );
  assert.deepEqual(createSanitizedPublicAggregateDisplay(1_750, hidden), {
    ok: true,
    value: null,
  });
});
