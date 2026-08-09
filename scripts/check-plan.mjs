import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [plan, changelog] = await Promise.all([
  readFile(new URL("PLAN.md", root), "utf8"),
  readFile(new URL("CHANGELOG.md", root), "utf8"),
]);

const openTasks = new Map();
const planTaskPattern = /^- \[ \] (TASK-\d{3}): (.+)$/gm;
const uncheckedTaskLines = plan.match(/^- \[ \] TASK-/gm) ?? [];

for (const match of plan.matchAll(planTaskPattern)) {
  const [, id, description] = match;
  assert(!openTasks.has(id), `${id} is duplicated in PLAN.md`);
  assert(description.includes(". DoD: "), `${id} must declare a DoD`);

  const dependencyClause = description.match(
    /\bDepends on: (none|`TASK-\d{3}`(?:, `TASK-\d{3}`)*)\./,
  );
  assert(dependencyClause, `${id} must declare direct dependencies`);

  const dependencies = [
    ...dependencyClause[1].matchAll(/TASK-\d{3}/g),
  ].map(([dependency]) => dependency);
  assert(!dependencies.includes(id), `${id} cannot depend on itself`);
  assert.equal(
    new Set(dependencies).size,
    dependencies.length,
    `${id} repeats a dependency`,
  );

  openTasks.set(id, dependencies);
}

assert(openTasks.size > 0, "PLAN.md must contain at least one open task");
assert.equal(
  openTasks.size,
  uncheckedTaskLines.length,
  "Every unchecked TASK line must use the stable PLAN task format",
);

const completedTaskIds = [
  ...changelog.matchAll(/^- \*\*(TASK-\d{3}):\*\*/gm),
].map((match) => match[1]);
const completedTasks = new Set(completedTaskIds);
assert.equal(
  completedTasks.size,
  completedTaskIds.length,
  "A TASK heading is duplicated in CHANGELOG.md",
);
const knownTasks = new Set([...openTasks.keys(), ...completedTasks]);

for (const [id, dependencies] of openTasks) {
  assert(!completedTasks.has(id), `${id} is both open and completed`);
  for (const dependency of dependencies) {
    assert(knownTasks.has(dependency), `${id} references unknown ${dependency}`);
  }
}

const visiting = new Set();
const visited = new Set();

function visit(id, path = []) {
  if (visited.has(id)) return;
  assert(!visiting.has(id), `PLAN.md dependency cycle: ${[...path, id].join(" -> ")}`);

  visiting.add(id);
  for (const dependency of openTasks.get(id) ?? []) {
    if (openTasks.has(dependency)) visit(dependency, [...path, id]);
  }
  visiting.delete(id);
  visited.add(id);
}

for (const id of openTasks.keys()) visit(id);

console.log(`PLAN.md dependency graph is valid (${openTasks.size} open tasks).`);
