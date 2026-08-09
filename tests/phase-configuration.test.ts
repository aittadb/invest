import assert from "node:assert/strict";
import test from "node:test";

import {
  checkPhaseSetup,
  isCountryEligible,
  isPhaseAcceptingParticipation,
  parsePhaseConfiguration,
  type PhaseConfiguration,
} from "../domain/phase-configuration.ts";

function configuredPhase(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "phase:synthetic-01",
    state: "open",
    enabledParticipationPaths: ["investor", "founder"],
    countryEligibility: { mode: "allow", countries: [" zz ", "aa"] },
    ...overrides,
  };
}

function requirePhase(value: unknown): PhaseConfiguration {
  const result = parsePhaseConfiguration(value);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("Expected a valid synthetic phase.");
  return result.value;
}

test("parses an explicit phase and canonicalizes paths and countries", () => {
  const input = configuredPhase();
  const result = parsePhaseConfiguration(input);

  assert.deepEqual(result, {
    ok: true,
    value: {
      id: "phase:synthetic-01",
      state: "open",
      enabledParticipationPaths: ["founder", "investor"],
      countryEligibility: { mode: "allow", countries: ["AA", "ZZ"] },
    },
  });

  (input.enabledParticipationPaths as string[]).push("founder");
  assert.deepEqual(
    result.ok ? result.value.enabledParticipationPaths : null,
    ["founder", "investor"],
  );
});

test("requires every phase decision instead of supplying defaults", () => {
  assert.deepEqual(parsePhaseConfiguration({}), {
    ok: false,
    issues: [
      { code: "required", path: "id" },
      { code: "required", path: "state" },
      { code: "required", path: "enabledParticipationPaths" },
      { code: "required", path: "countryEligibility" },
    ],
  });
  assert.equal(parsePhaseConfiguration(null).ok, false);
  assert.equal(parsePhaseConfiguration([]).ok, false);
});

test("rejects malformed identity, state, paths, and unknown settings", () => {
  const result = parsePhaseConfiguration({
    ...configuredPhase(),
    id: "phase with spaces",
    state: "scheduled",
    enabledParticipationPaths: ["investor", "investor"],
    unexpectedSetting: true,
  });

  assert.deepEqual(result, {
    ok: false,
    issues: [
      { code: "invalid_rule", path: "unexpectedSetting" },
      { code: "invalid_format", path: "id" },
      { code: "invalid_format", path: "state" },
      { code: "invalid_rule", path: "enabledParticipationPaths[1]" },
    ],
  });

  assert.equal(
    parsePhaseConfiguration(
      configuredPhase({ enabledParticipationPaths: ["observer"] }),
    ).ok,
    false,
  );
  assert.equal(
    parsePhaseConfiguration(
      configuredPhase({ enabledParticipationPaths: "investor" }),
    ).ok,
    false,
  );
});

test("normalizes country rules and rejects ambiguity after normalization", () => {
  const duplicate = parsePhaseConfiguration(
    configuredPhase({
      countryEligibility: {
        mode: "allow",
        countries: [" aa ", "AA"],
      },
    }),
  );
  assert.deepEqual(duplicate, {
    ok: false,
    issues: [
      {
        code: "invalid_rule",
        path: "countryEligibility.countries[1]",
      },
    ],
  });

  assert.equal(
    parsePhaseConfiguration(
      configuredPhase({
        countryEligibility: { mode: "exclude", countries: [] },
      }),
    ).ok,
    false,
  );
  assert.equal(
    parsePhaseConfiguration(
      configuredPhase({
        countryEligibility: { mode: "deny", countries: ["AAA"] },
      }),
    ).ok,
    false,
  );
  assert.equal(
    parsePhaseConfiguration(
      configuredPhase({
        countryEligibility: {
          mode: "deny",
          countries: [],
          fallback: "allow",
        },
      }),
    ).ok,
    false,
  );
});

test("supports deployment-provided country normalization", () => {
  const result = parsePhaseConfiguration(configuredPhase(), {
    normalize: (value) => {
      const aliases: Readonly<Record<string, string>> = {
        alpha: "AA",
        omega: "ZZ",
      };
      return aliases[value.trim()] ?? value.trim().toUpperCase();
    },
  });
  assert.equal(result.ok, true);

  if (!result.ok) return;
  assert.deepEqual(
    isCountryEligible(result.value.countryEligibility, "omega", {
      normalize: (value) => (value === "omega" ? "ZZ" : value),
    }),
    { ok: true, value: true },
  );
});

test("evaluates allow and deny rules without a built-in country policy", () => {
  const allow = requirePhase(configuredPhase()).countryEligibility;
  assert.deepEqual(isCountryEligible(allow, "aa"), { ok: true, value: true });
  assert.deepEqual(isCountryEligible(allow, "BB"), { ok: true, value: false });
  assert.equal(isCountryEligible(allow, "not-a-code").ok, false);

  const deny = requirePhase(
    configuredPhase({
      countryEligibility: { mode: "deny", countries: ["aa"] },
    }),
  ).countryEligibility;
  assert.deepEqual(isCountryEligible(deny, "AA"), { ok: true, value: false });
  assert.deepEqual(isCountryEligible(deny, "BB"), { ok: true, value: true });
});

test("reports setup readiness independently from open or closed state", () => {
  const incomplete = requirePhase(
    configuredPhase({
      state: "closed",
      enabledParticipationPaths: [],
      countryEligibility: { mode: "allow", countries: [] },
    }),
  );
  assert.deepEqual(checkPhaseSetup(incomplete), {
    complete: false,
    missing: [
      "enabledParticipationPaths",
      "countryEligibility.countries",
    ],
  });

  const completeClosed = requirePhase(
    configuredPhase({
      state: "closed",
      enabledParticipationPaths: ["founder"],
      countryEligibility: { mode: "deny", countries: [] },
    }),
  );
  assert.deepEqual(checkPhaseSetup(completeClosed), {
    complete: true,
    missing: [],
  });
});

test("accepts participation only when phase, path, setup, and country allow it", () => {
  const open = requirePhase(configuredPhase());
  assert.deepEqual(isPhaseAcceptingParticipation(open, "investor", "AA"), {
    ok: true,
    value: true,
  });
  assert.deepEqual(isPhaseAcceptingParticipation(open, "investor", "BB"), {
    ok: true,
    value: false,
  });
  assert.equal(isPhaseAcceptingParticipation(open, "observer", "AA").ok, false);

  const founderOnly = requirePhase(
    configuredPhase({ enabledParticipationPaths: ["founder"] }),
  );
  assert.deepEqual(
    isPhaseAcceptingParticipation(founderOnly, "investor", "AA"),
    { ok: true, value: false },
  );

  const closed = requirePhase(configuredPhase({ state: "closed" }));
  assert.deepEqual(isPhaseAcceptingParticipation(closed, "investor", "AA"), {
    ok: true,
    value: false,
  });
});
