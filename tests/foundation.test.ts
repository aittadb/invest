import assert from "node:assert/strict";
import test from "node:test";

import {
  DomainError,
  invalid,
  parseActorSubject,
  parseCountryCode,
  parseMinorUnits,
  parseStableId,
  parseTimestamp,
  toPublicDomainError,
  valid,
} from "../domain/foundation.ts";

test("minor-unit amounts accept only bounded safe integers", () => {
  assert.deepEqual(parseMinorUnits(2_500, { minimum: 1_000, maximum: 5_000 }), {
    ok: true,
    value: 2_500,
  });
  assert.deepEqual(parseMinorUnits(999, { minimum: 1_000 }), {
    ok: false,
    issues: [{ code: "out_of_range", path: "amount" }],
  });
  assert.deepEqual(parseMinorUnits(5_001, { maximum: 5_000 }), {
    ok: false,
    issues: [{ code: "out_of_range", path: "amount" }],
  });
  assert.equal(parseMinorUnits(12.5).ok, false);
  assert.equal(parseMinorUnits(-1).ok, false);
  assert.equal(parseMinorUnits("1250").ok, false);
  assert.equal(parseMinorUnits(Number.MAX_SAFE_INTEGER + 1).ok, false);
  assert.deepEqual(parseMinorUnits(10, { minimum: 20, maximum: 10 }), {
    ok: false,
    issues: [{ code: "invalid_rule", path: "amount" }],
  });
});

test("country codes normalize through an injectable hook before validation", () => {
  assert.deepEqual(parseCountryCode(" fi "), { ok: true, value: "FI" });
  assert.deepEqual(
    parseCountryCode("united kingdom", {
      normalize: (value) => (value === "united kingdom" ? "GB" : value),
    }),
    { ok: true, value: "GB" },
  );
  assert.equal(parseCountryCode("FIN").ok, false);
  assert.equal(
    parseCountryCode("GB", {
      normalize: () => "not-a-code",
    }).ok,
    false,
  );
  assert.equal(
    parseCountryCode("GB", {
      normalize: () => {
        throw new Error("private normalizer detail");
      },
    }).ok,
    false,
  );
});

test("timestamps, stable identifiers, and actor subjects preserve canonical values", () => {
  assert.deepEqual(parseTimestamp("2026-08-09T10:15:30.000Z"), {
    ok: true,
    value: "2026-08-09T10:15:30.000Z",
  });
  assert.equal(parseTimestamp("2026-02-31T10:15:30.000Z").ok, false);
  assert.equal(parseTimestamp("2026-08-09T10:15:30Z").ok, false);

  assert.deepEqual(parseStableId<"campaign">("campaign:example-01"), {
    ok: true,
    value: "campaign:example-01",
  });
  assert.equal(parseStableId(" id with spaces ").ok, false);

  assert.deepEqual(parseActorSubject("issuer.example/user:CaseSensitive"), {
    ok: true,
    value: "issuer.example/user:CaseSensitive",
  });
  assert.equal(parseActorSubject(" subject-with-padding ").ok, false);
});

test("validation-result helpers retain only structured issues", () => {
  assert.deepEqual(valid("ready"), { ok: true, value: "ready" });
  assert.deepEqual(invalid({ code: "required", path: "name" }), {
    ok: false,
    issues: [{ code: "required", path: "name" }],
  });
});

test("public error mapping hides causes and foreign-record authorization", () => {
  const secret = "private participant note";
  const denied = toPublicDomainError(
    new DomainError("ACCESS_DENIED", { cause: new Error(secret) }),
  );
  const missing = toPublicDomainError(new DomainError("RESOURCE_NOT_FOUND"));

  assert.deepEqual(denied, missing);
  assert.equal(denied.status, 404);
  assert.doesNotMatch(JSON.stringify(denied), new RegExp(secret));

  const unknown = toPublicDomainError(new Error(secret));
  assert.equal(unknown.status, 500);
  assert.equal(unknown.body.error.code, "INTERNAL_ERROR");
  assert.doesNotMatch(JSON.stringify(unknown), new RegExp(secret));
});
