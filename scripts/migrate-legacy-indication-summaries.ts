import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { AittaDBStorageAdapter } from "../repositories/aittadb-storage-adapter.ts";
import {
  createAittaDBServiceTokenProvider,
  type AittaDBServiceTokenFetch,
  type AittaDBServiceTokenProvider,
} from "../services/aittadb-service-token.ts";
import {
  MAX_LEGACY_INDICATION_SUMMARY_MIGRATION_MANIFEST_BYTES,
  runLegacyIndicationSummaryMigration,
  type LegacyIndicationSummaryMigrationResult,
} from "../services/legacy-indication-summary-migration.ts";

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
  openManifest?: LegacyIndicationSummaryMigrationManifestOpener;
}>;

export type LegacyIndicationSummaryMigrationManifestFile = Readonly<{
  stat(): Promise<Readonly<{ size: number; isFile(): boolean }>>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<Readonly<{ bytesRead: number }>>;
  close(): Promise<void>;
}>;

export type LegacyIndicationSummaryMigrationManifestOpener = (
  path: string,
) => Promise<LegacyIndicationSummaryMigrationManifestFile>;

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
  const inventory = dependencies.readManifest === undefined
    ? await readManifest(
        configuration.manifestPath,
        dependencies.openManifest ?? openManifest,
      )
    : await dependencies.readManifest(configuration.manifestPath);
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
  const reservedCredentials = [
    environment.AITTADB_STORAGE_CLIENT_ID,
    environment.AITTADB_STORAGE_CLIENT_SECRET,
    environment.AITTADB_OAUTH_CLIENT_ID,
    environment.AITTADB_OAUTH_CLIENT_SECRET,
    environment.BROWSER_MUTATION_SESSION_KEY,
    environment.AITTADB_OAUTH_TRANSACTION_KEY,
    environment.AITTADB_OAUTH_CSRF_KEY,
  ];
  if (
    clientId === clientSecret ||
    reservedCredentials.some((value) =>
      value !== undefined && (clientId === value || clientSecret === value)
    )
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

async function openManifest(
  path: string,
): Promise<LegacyIndicationSummaryMigrationManifestFile> {
  return open(path, "r");
}

async function readManifest(
  path: string,
  opener: LegacyIndicationSummaryMigrationManifestOpener,
): Promise<unknown> {
  let file: LegacyIndicationSummaryMigrationManifestFile | null = null;
  try {
    file = await opener(path);
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 1 ||
      metadata.size > MAX_LEGACY_INDICATION_SUMMARY_MIGRATION_MANIFEST_BYTES
    ) {
      invalid();
    }
    const bytes = new Uint8Array(
      MAX_LEGACY_INDICATION_SUMMARY_MIGRATION_MANIFEST_BYTES + 1,
    );
    let offset = 0;
    while (offset < bytes.byteLength) {
      const requested = bytes.byteLength - offset;
      const result = await file.read(bytes, offset, requested, offset);
      if (
        !Number.isSafeInteger(result.bytesRead) ||
        result.bytesRead < 0 ||
        result.bytesRead > requested
      ) invalid();
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (
      offset < 1 ||
      offset > MAX_LEGACY_INDICATION_SUMMARY_MIGRATION_MANIFEST_BYTES ||
      offset !== metadata.size
    ) invalid();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, offset),
    );
    return JSON.parse(text) as unknown;
  } catch {
    invalid();
  } finally {
    if (file !== null) await file.close().catch(() => undefined);
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
