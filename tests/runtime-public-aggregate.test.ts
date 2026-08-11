import assert from "node:assert/strict";
import test from "node:test";

import { parseAmountAggregateConfiguration } from "../domain/amount-aggregate-configuration.ts";
import type { MinorUnits } from "../domain/foundation.ts";
import { createSanitizedPublicInvestmentAggregate } from "../domain/investment-aggregate.ts";
import {
  publicAggregateFromRuntimeHeader,
  PUBLIC_AGGREGATE_HEADER,
  withRuntimePublicAggregate,
} from "../http/runtime-public-aggregate.ts";

test("runtime aggregate headers round-trip only the closed public projection", () => {
  const aggregate = publicAggregate();
  const request = withRuntimePublicAggregate(
    new Request("https://invest.example.test/", {
      headers: {
        [PUBLIC_AGGREGATE_HEADER]: btoa(JSON.stringify({
          participantSubject: "private-subject",
        })),
      },
    }),
    aggregate,
  );
  const encoded = request.headers.get(PUBLIC_AGGREGATE_HEADER);
  assert.deepEqual(publicAggregateFromRuntimeHeader(encoded), aggregate);
  assert.doesNotMatch(
    atob(encoded ?? ""),
    /participant|subject|company|note|count|moderation|backend/iu,
  );

  const cleared = withRuntimePublicAggregate(request, null);
  assert.equal(cleared.headers.get(PUBLIC_AGGREGATE_HEADER), null);

  const rejectedPrivateShape = withRuntimePublicAggregate(
    request,
    {
      ...aggregate,
      participantSubject: "private-subject",
    } as unknown as typeof aggregate,
  );
  assert.equal(
    rejectedPrivateShape.headers.get(PUBLIC_AGGREGATE_HEADER),
    null,
  );

  for (const malformed of [
    "not-base64",
    "A".repeat(2_049),
    btoa("{"),
    btoa(JSON.stringify({ ...aggregate, participantSubject: "private" })),
    btoa(JSON.stringify({ ...aggregate, amount: 0 })),
    btoa(JSON.stringify({
      ...aggregate,
      oversubscription: {
        status: "target_reached",
        targetAmount: 10_000,
        remainingAmount: 9_999,
        amountOverTarget: 0,
      },
    })),
  ]) {
    assert.equal(publicAggregateFromRuntimeHeader(malformed), null);
  }
});

function publicAggregate() {
  const configuration = parseAmountAggregateConfiguration({
    amount: {
      currency: "EUR",
      minimum: 1_000,
      increment: 500,
      maximum: null,
    },
    publicAggregate: {
      visibility: "non_zero",
      label: "Indicated interest",
      qualifier: "Current self-declared interest.",
    },
  });
  assert(configuration.ok);
  const aggregate = createSanitizedPublicInvestmentAggregate({
    totalAmount: 12_500 as MinorUnits,
    currency: configuration.value.amount.currency,
    contributingIndicationCount: 2,
  }, configuration.value, 10_000);
  assert(aggregate.ok);
  assert(aggregate.value);
  return aggregate.value;
}
