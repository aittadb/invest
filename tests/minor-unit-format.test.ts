import assert from "node:assert/strict";
import test from "node:test";

import { formatMinorUnits } from "../app/minor-unit-format.ts";

test("minor-unit formatting stays exact without floating-point division", () => {
  assert.equal(formatMinorUnits(12_500, "EUR"), "EUR 125.00");
  assert.equal(formatMinorUnits(12_500, "JPY"), "JPY 12,500");
  assert.equal(formatMinorUnits(12_345, "BHD"), "BHD 12.345");
  assert.equal(
    formatMinorUnits(Number.MAX_SAFE_INTEGER, "EUR"),
    "EUR 90,071,992,547,409.91",
  );
});

test("minor-unit formatting rejects values outside the integer domain", () => {
  for (const amount of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => formatMinorUnits(amount, "EUR"),
      /non-negative safe integer/u,
    );
  }
});
