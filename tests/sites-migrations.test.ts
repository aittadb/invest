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
  const segments = emitted.split("\n--> statement-breakpoint\n");
  assert.equal(segments.length, 2);
  for (const segment of segments) {
    assert.equal(splitSqlStatements(segment).length, 1);
    sqlite.exec(segment);
  }
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

test("unquoted trigger keywords are rejected before splitting", async (t) => {
  const migrations = [
    "CREATE TRIGGER example AFTER INSERT ON records BEGIN SELECT 1; END;\n",
    "CREATE TEMP TRIGGER example AFTER INSERT ON records BEGIN SELECT 1; END;\n",
    "CREATE TEMPORARY\nTRIGGER example AFTER INSERT ON records BEGIN SELECT 1; END;\n",
    "CREATE /* comment */ TRIGGER example AFTER INSERT ON records BEGIN SELECT 1; END;\n",
    "CREATE -- comment\nTRIGGER example AFTER INSERT ON records BEGIN SELECT 1; END;\n",
    "CREATE/**/TEMPORARY/**/trigger example AFTER INSERT ON records BEGIN SELECT 1; END;\n",
  ];

  for (const [index, migration] of migrations.entries()) {
    await t.test(`bypass form ${index + 1}`, async (t) => {
      const paths = await migrationPaths(t);
      await writeFile(join(paths.sourceDirectory, "0001_trigger.sql"), migration);

      await assert.rejects(
        stageSitesMigrations(paths),
        /unsupported compound SQL/u,
      );
      await assert.rejects(
        access(join(paths.outputDirectory, "0001_trigger.sql")),
        { code: "ENOENT" },
      );
    });
  }
});

test("quoted and commented trigger text remains valid", async (t) => {
  const migrations = [
    "CREATE TABLE records (\"TRIGGER\" TEXT);\n",
    "CREATE TABLE records (`TRIGGER` TEXT);\n",
    "CREATE TABLE records ([TRIGGER] TEXT);\n",
    "CREATE TABLE records (value TEXT DEFAULT 'TRIGGER');\n",
    "-- TRIGGER\n/* TRIGGER */\nCREATE TABLE records (value TEXT);\n",
  ];

  for (const [index, migration] of migrations.entries()) {
    await t.test(`quoted form ${index + 1}`, async (t) => {
      const paths = await migrationPaths(t);
      await writeFile(join(paths.sourceDirectory, "0001_table.sql"), migration);

      assert.equal(await stageSitesMigrations(paths), true);
      const emitted = await readFile(
        join(paths.outputDirectory, "0001_table.sql"),
        "utf8",
      );
      const sqlite = new DatabaseSync(":memory:");
      t.after(() => sqlite.close());
      for (const segment of emitted.split("\n--> statement-breakpoint\n")) {
        sqlite.exec(segment);
      }
    });
  }
});

async function migrationPaths(t: test.TestContext): Promise<{
  activeHostingConfig: string;
  sourceDirectory: string;
  outputDirectory: string;
}> {
  const directory = await temporaryDirectory(t);
  const activeHostingConfig = join(directory, "hosting.json");
  const sourceDirectory = join(directory, "migrations");
  const outputDirectory = join(directory, "drizzle");
  await mkdir(sourceDirectory);
  await writeFile(
    activeHostingConfig,
    `${JSON.stringify({ project_id: "test", d1: "DB", r2: null })}\n`,
  );
  return { activeHostingConfig, sourceDirectory, outputDirectory };
}

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "investor-sites-migrations-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
