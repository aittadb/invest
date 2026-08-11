import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { AittaDBStorageAdapter } from "../repositories/aittadb-storage-adapter.ts";
import {
  createAittaDBServiceTokenProvider,
  type AittaDBServiceTokenFetch,
  type AittaDBServiceTokenProvider,
} from "../services/aittadb-service-token.ts";
import {
  runLegacyIndicationSummaryMigration,
  type LegacyIndicationSummaryMigrationResult,
} from "../services/legacy-indication-summary-migration.ts";

const MANIFEST_MAX_BYTES = 65_536;
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
const STORAGE_REQUEST_TIMEOUT_MS = 30_000;

type MigrationEnvironment = Readonly<Record<string, string | undefined>>;

type MigrationCommandConfiguration = Readonly<{
  issuer: string;
  transportOrigin: string;
  entryHref: string;
  manifestPath: string;
  createServiceTokenProvider(
    fetch: AittaDBServiceTokenFetch,
    now: () => Date,
  ): AittaDBServiceTokenProvider;
}>;

export type LegacyIndicationSummaryMigrationCommandDependencies = Readonly<{
  fetch?: AittaDBServiceTokenFetch;
  now?: () => Date;
  readManifest?: (path: string) => Promise<unknown>;
}>;

/** Execute the backend-only command and return only content-free counters. */
export async function executeLegacyIndicationSummaryMigrationCommand(
  argv: readonly string[],
  environment: MigrationEnvironment,
  dependencies: LegacyIndicationSummaryMigrationCommandDependencies = {},
): Promise<LegacyIndicationSummaryMigrationResult> {
  const configuration = parseCommandConfiguration(argv, environment);
  const providerFetch = dependencies.fetch ??
    ((input, init) => fetch(input, init));
  const now = dependencies.now ?? (() => new Date());
  const serviceToken = configuration.createServiceTokenProvider(
    providerFetch,
    now,
  );
  const storage = new AittaDBStorageAdapter({
    issuer: configuration.issuer,
    transportOrigin: configuration.transportOrigin,
    entryHref: configuration.entryHref,
    accessToken: serviceToken.accessToken,
    fetch: providerFetch,
    requestTimeoutMs: STORAGE_REQUEST_TIMEOUT_MS,
  });
  const inventory = await (dependencies.readManifest ?? readManifest)(
    configuration.manifestPath,
  );
  return runLegacyIndicationSummaryMigration(storage, inventory);
}

function parseCommandConfiguration(
  argv: readonly string[],
  environment: MigrationEnvironment,
): MigrationCommandConfiguration {
  try {
    return parseCommandConfigurationUnchecked(argv, environment);
  } catch {
    invalid();
  }
}

function parseCommandConfigurationUnchecked(
  argv: readonly string[],
  environment: MigrationEnvironment,
): MigrationCommandConfiguration {
  if (
    !Array.isArray(argv) ||
    argv.length !== 3 ||
    argv[0] !== "--apply" ||
    argv[1] !== "--manifest"
  ) invalid();
  const manifestPath = exactPath(argv[2]);
  const issuer = exactHttpsOrigin(environment.AITTADB_MIGRATION_ISSUER);
  const transportOrigin = environment.AITTADB_MIGRATION_TRANSPORT_ORIGIN ===
      undefined
    ? issuer
    : exactHttpsOrigin(environment.AITTADB_MIGRATION_TRANSPORT_ORIGIN);
  const entryHref = exactEntryHref(
    environment.AITTADB_MIGRATION_ENTRY_HREF,
    issuer,
  );
  const clientId = exactCredential(
    environment.AITTADB_MIGRATION_CLIENT_ID,
    1,
    255,
    false,
  );
  const clientSecret = exactCredential(
    environment.AITTADB_MIGRATION_CLIENT_SECRET,
    16,
    512,
    true,
  );
  if (
    clientId === environment.AITTADB_STORAGE_CLIENT_ID ||
    clientSecret === environment.AITTADB_STORAGE_CLIENT_SECRET
  ) invalid();

  return Object.freeze({
    issuer,
    transportOrigin,
    entryHref,
    manifestPath,
    createServiceTokenProvider: Object.freeze((
      providerFetch: AittaDBServiceTokenFetch,
      now: () => Date,
    ) => createAittaDBServiceTokenProvider({
      issuer,
      transportOrigin,
      clientId,
      clientSecret,
      storageScopes: Object.freeze(["storage.read", "storage.write"]),
      expirySkewSeconds: 60,
      requestTimeoutMs: TOKEN_REQUEST_TIMEOUT_MS,
      fetch: providerFetch,
      now,
    })),
  });
}

async function readManifest(path: string): Promise<unknown> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MANIFEST_MAX_BYTES) {
      invalid();
    }
    const bytes = await readFile(path);
    if (bytes.byteLength < 1 || bytes.byteLength > MANIFEST_MAX_BYTES) invalid();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    invalid();
  }
}

function exactPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    value.includes("\u0000")
  ) invalid();
  return value;
}

function exactHttpsOrigin(value: unknown): string {
  const url = exactHttpsUrl(value);
  if (
    url.pathname !== "/" ||
    url.search !== "" ||
    (value !== url.origin && value !== url.href)
  ) invalid();
  return url.origin;
}

function exactEntryHref(value: unknown, issuer: string): string {
  const url = exactHttpsUrl(value);
  if (url.origin !== issuer || url.search !== "") invalid();
  return url.href;
}

function exactHttpsUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    invalid();
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (value !== url.href && !(
      url.pathname === "/" && url.search === "" && value === url.origin
    ))
  ) invalid();
  return url;
}

function exactCredential(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
  allowColon: boolean,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    !/^[\x21-\x7e]+$/u.test(value) ||
    (!allowColon && value.includes(":"))
  ) invalid();
  return value;
}

function invalid(): never {
  throw new Error("Legacy indication summary migration configuration is invalid.");
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    const result = await executeLegacyIndicationSummaryMigrationCommand(
      process.argv.slice(2),
      process.env,
    );
    process.stdout.write(`${JSON.stringify({ status: "completed", ...result })}\n`);
  } catch {
    process.stderr.write("Legacy indication summary migration failed.\n");
    process.exitCode = 1;
  }
}
