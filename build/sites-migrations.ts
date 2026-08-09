import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const D1_BINDING_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const JOURNAL_EPOCH = 1_700_000_000_000;

export interface SitesMigrationJournal {
  version: "7";
  dialect: "sqlite";
  entries: Array<{
    idx: number;
    version: "6";
    when: number;
    tag: string;
    breakpoints: true;
  }>;
}

export type StageSitesMigrationsOptions = Readonly<{
  activeHostingConfig: string;
  sourceDirectory: string;
  outputDirectory: string;
}>;

/** Stages D1 migrations only for a deployment with an active D1 binding. */
export async function stageSitesMigrations(
  options: StageSitesMigrationsOptions,
): Promise<boolean> {
  await rm(options.outputDirectory, { recursive: true, force: true });

  let source: string;
  try {
    source = await readFile(options.activeHostingConfig, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  let hosting: unknown;
  try {
    hosting = JSON.parse(source);
  } catch {
    throw new Error("The active Sites hosting configuration is invalid");
  }
  if (!isRecord(hosting) || !("d1" in hosting)) {
    throw new Error("The active Sites hosting configuration is missing d1");
  }
  if (hosting.d1 === null) return false;
  if (
    typeof hosting.d1 !== "string" ||
    !D1_BINDING_PATTERN.test(hosting.d1)
  ) {
    throw new Error("The active Sites D1 binding is invalid");
  }

  await emitSitesMigrations(
    options.sourceDirectory,
    options.outputDirectory,
  );
  return true;
}

export async function emitSitesMigrations(
  sourceDirectory: string,
  outputDirectory: string,
): Promise<void> {
  const fileNames = (await readdir(sourceDirectory))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();
  if (fileNames.length === 0) {
    throw new Error("At least one checked-in D1 migration is required");
  }

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(resolve(outputDirectory, "meta"), { recursive: true });
  for (const fileName of fileNames) {
    const source = await readFile(resolve(sourceDirectory, fileName), "utf8");
    if (containsUnquotedTriggerKeyword(source)) {
      throw new Error(`D1 migration ${fileName} contains unsupported compound SQL`);
    }
    const statements = splitSqlStatements(source);
    if (statements.length === 0) {
      throw new Error(`D1 migration ${fileName} contains no SQL statements`);
    }
    await writeFile(
      resolve(outputDirectory, fileName),
      `${statements.join("\n--> statement-breakpoint\n")}\n`,
    );
  }
  await writeFile(
    resolve(outputDirectory, "meta", "_journal.json"),
    `${JSON.stringify(sitesMigrationJournal(fileNames), null, 2)}\n`,
  );
}

export function sitesMigrationJournal(
  fileNames: readonly string[],
): SitesMigrationJournal {
  return {
    version: "7",
    dialect: "sqlite",
    entries: fileNames.map((fileName, idx) => ({
      idx,
      version: "6",
      when: JOURNAL_EPOCH + idx,
      tag: basename(fileName, ".sql"),
      breakpoints: true,
    })),
  };
}

export function splitSqlStatements(source: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    current += character;

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      if (character === quote) {
        if (next === quote) {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "-" && next === "-") {
      current += next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (character === "/" && next === "*") {
      current += next;
      index += 1;
      blockComment = true;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
    }
  }

  if (quote || blockComment) throw new Error("Unterminated SQL syntax");
  if (current.trim()) {
    throw new Error("Every D1 migration statement must end with a semicolon");
  }
  return statements;
}

function containsUnquotedTriggerKeyword(source: string): boolean {
  let token = "";
  let quote: "'" | '"' | "`" | "]" | null = null;
  let lineComment = false;
  let blockComment = false;

  const finishToken = (): boolean => {
    const isTrigger = token.toUpperCase() === "TRIGGER";
    token = "";
    return isTrigger;
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      if (character === quote) {
        if (quote !== "]" && next === quote) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (character === "-" && next === "-") {
      if (finishToken()) return true;
      index += 1;
      lineComment = true;
      continue;
    }
    if (character === "/" && next === "*") {
      if (finishToken()) return true;
      index += 1;
      blockComment = true;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      if (finishToken()) return true;
      quote = character;
      continue;
    }
    if (character === "[") {
      if (finishToken()) return true;
      quote = "]";
      continue;
    }
    if (isSqliteIdentifierCharacter(character)) {
      token += character;
      continue;
    }
    if (finishToken()) return true;
  }

  return finishToken();
}

function isSqliteIdentifierCharacter(character: string): boolean {
  if (!character) return false;
  const codePoint = character.codePointAt(0);
  return (
    (character >= "A" && character <= "Z") ||
    (character >= "a" && character <= "z") ||
    (character >= "0" && character <= "9") ||
    character === "_" ||
    character === "$" ||
    (codePoint !== undefined && codePoint >= 0x80)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
