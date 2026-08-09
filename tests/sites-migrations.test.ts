import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  splitSqlStatements,
  stageSitesMigrations,
} from "../build/sites-migrations.ts";

const SOURCE_DIRECTORY = resolve("db", "migrations");
const MIGRATION_FILE = "0001_oauth_proof_persistence.sql";

test("active D1 configuration emits the deterministic Sites artifact", async (t) => {
  const directory = await temporaryDirectory(t);
  const activeHostingConfig = join(directory, "hosting.json");
  const outputDirectory = join(directory, "dist", ".openai", "drizzle");
  await writeFile(
    activeHostingConfig,
    `${JSON.stringify({ project_id: "test", d1: "OAUTH_PROOF_DB", r2: null })}\n`,
  );

  assert.equal(
    await stageSitesMigrations({
      activeHostingConfig,
      sourceDirectory: SOURCE_DIRECTORY,
      outputDirectory,
    }),
    true,
  );

  const source = await readFile(join(SOURCE_DIRECTORY, MIGRATION_FILE), "utf8");
  const emitted = await readFile(join(outputDirectory, MIGRATION_FILE), "utf8");
  assert.equal(
    emitted,
    `${splitSqlStatements(source).join("\n--> statement-breakpoint\n")}\n`,
  );
  assert.equal((emitted.match(/--> statement-breakpoint/gu) ?? []).length, 1);

  const journal = JSON.parse(
    await readFile(join(outputDirectory, "meta", "_journal.json"), "utf8"),
  ) as unknown;
  assert.deepEqual(journal, {
    version: "7",
    dialect: "sqlite",
    entries: [{
      idx: 0,
      version: "6",
      when: 1_700_000_000_000,
      tag: "0001_oauth_proof_persistence",
      breakpoints: true,
    }],
  });

  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(emitted);
  const tables = sqlite.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
  ).all().map((row) => (row as { name: string }).name);
  assert.deepEqual(tables, [
    "investor_oauth_transaction_claims",
    "investor_oauth_verified_proofs",
  ]);
});

test("migrations are not staged without an active D1 binding", async (t) => {
  for (const configuration of ["missing", "null"] as const) {
    await t.test(configuration, async (t) => {
      const directory = await temporaryDirectory(t);
      const activeHostingConfig = join(directory, "hosting.json");
      const outputDirectory = join(directory, "dist", ".openai", "drizzle");
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(join(outputDirectory, "stale.sql"), "SELECT 1;\n");
      if (configuration === "null") {
        await writeFile(
          activeHostingConfig,
          `${JSON.stringify({ project_id: "test", d1: null, r2: null })}\n`,
        );
      }

      assert.equal(
        await stageSitesMigrations({
          activeHostingConfig,
          sourceDirectory: SOURCE_DIRECTORY,
          outputDirectory,
        }),
        false,
      );
      await assert.rejects(access(outputDirectory), { code: "ENOENT" });
    });
  }

  const example = JSON.parse(
    await readFile(resolve(".openai", "hosting.example.json"), "utf8"),
  ) as { d1?: unknown; r2?: unknown };
  assert.equal(example.d1, null);
  assert.equal(example.r2, null);
});

test("compound trigger migrations are rejected instead of split", async (t) => {
  const directory = await temporaryDirectory(t);
  const activeHostingConfig = join(directory, "hosting.json");
  const sourceDirectory = join(directory, "migrations");
  const outputDirectory = join(directory, "drizzle");
  await mkdir(sourceDirectory);
  await writeFile(
    activeHostingConfig,
    `${JSON.stringify({ project_id: "test", d1: "DB", r2: null })}\n`,
  );
  await writeFile(
    join(sourceDirectory, "0001_trigger.sql"),
    "CREATE TRIGGER example AFTER INSERT ON records BEGIN SELECT 1; END;\n",
  );

  await assert.rejects(
    stageSitesMigrations({
      activeHostingConfig,
      sourceDirectory,
      outputDirectory,
    }),
    /unsupported compound SQL/u,
  );
});

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "investor-sites-migrations-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
