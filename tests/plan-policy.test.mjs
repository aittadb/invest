import assert from "node:assert/strict";
import test from "node:test";

import { validatePlanPolicy } from "../scripts/check-plan.mjs";

const guidance = `# Investor App Implementation Plan

This file records accepted, unfinished implementation work.

Completed tasks move to \`CHANGELOG.md\` with evidence.
`;

const validTask =
  "- [ ] TASK-001: Keep one bounded task. Depends on: none. DoD: focused proof passes.";

test("accepts a completed plan with zero open tasks", () => {
  assert.equal(validatePlanPolicy(guidance, "# Changelog\n"), 0);
});

test("accepts a well-formed open task", () => {
  assert.equal(
    validatePlanPolicy(`${guidance}\n${validTask}\n`, "# Changelog\n"),
    1,
  );
});

test("rejects missing plan workflow structure", () => {
  assert.throws(
    () => validatePlanPolicy("# Plan\n", "# Changelog\n"),
    /implementation-plan heading/,
  );
  assert.throws(
    () =>
      validatePlanPolicy(
        "# Investor App Implementation Plan\n",
        "# Changelog\n",
      ),
    /workflow guidance/,
  );
});

test("rejects malformed and checked task entries", () => {
  assert.throws(
    () =>
      validatePlanPolicy(
        `${guidance}\n- [ ] TASK-001 missing stable punctuation\n`,
        "# Changelog\n",
      ),
    /stable PLAN task format/,
  );
  assert.throws(
    () =>
      validatePlanPolicy(
        `${guidance}\n- [x] TASK-001: Already done.\n`,
        "# Changelog\n",
      ),
    /must move from PLAN.md/,
  );
});

test("rejects duplicate completed task identifiers", () => {
  const duplicateChangelog = `# Changelog

- **TASK-001:** First completion.
- **TASK-001:** Duplicate completion.
`;

  assert.throws(
    () => validatePlanPolicy(guidance, duplicateChangelog),
    /duplicated in CHANGELOG.md/,
  );
});
