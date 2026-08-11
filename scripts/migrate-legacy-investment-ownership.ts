import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { AittaDBStorageAdapter } from "../repositories/aittadb-storage-adapter.ts";
import {
  createAittaDBServiceTokenProvider,
  type AittaDBServiceTokenFetch,
  type AittaDBServiceTokenProvider,
} from "../services/aittadb-service-token.ts";
import {
  MAX_LEGACY_INVESTMENT_OWNERSHIP_MIGRATION_MANIFEST_BYTES,
  runLegacyInvestmentOwnershipMigration,
  type LegacyInvestmentOwnershipMigrationResult,
} from "../services/legacy-investment-ownership-migration.ts";

const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
const STORAGE_REQUEST_TIMEOUT_MS = 30_000;
const MAX_JSON_NESTING_DEPTH = 16;

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

export type LegacyInvestmentOwnershipMigrationCommandDependencies = Readonly<{
  fetch?: AittaDBServiceTokenFetch;
  now?: () => Date;
  readManifest?: (path: string) => Promise<unknown>;
  openManifest?: LegacyInvestmentOwnershipMigrationManifestOpener;
}>;

export type LegacyInvestmentOwnershipMigrationManifestFile = Readonly<{
  stat(): Promise<LegacyInvestmentOwnershipMigrationManifestMetadata>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<Readonly<{ bytesRead: number }>>;
  close(): Promise<void>;
}>;

export type LegacyInvestmentOwnershipMigrationManifestMetadata = Readonly<{
  device: bigint;
  inode: bigint;
  mode: bigint;
  linkCount: bigint;
  size: bigint;
  modifiedNanoseconds: bigint;
  changedNanoseconds: bigint;
  isFile(): boolean;
}>;

export type LegacyInvestmentOwnershipMigrationManifestOpener = (
  path: string,
) => Promise<LegacyInvestmentOwnershipMigrationManifestFile>;

/** Execute the backend-only command and return only content-free counters. */
export async function executeLegacyInvestmentOwnershipMigrationCommand(
  argv: readonly string[],
  environment: MigrationEnvironment,
  dependencies: LegacyInvestmentOwnershipMigrationCommandDependencies = {},
): Promise<LegacyInvestmentOwnershipMigrationResult> {
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
  return runLegacyInvestmentOwnershipMigration(storage, inventory);
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
    environment.OWNER_INDICATION_REVIEW_KEY,
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
): Promise<LegacyInvestmentOwnershipMigrationManifestFile> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  return Object.freeze({
    async stat() {
      const metadata = await file.stat({ bigint: true });
      return Object.freeze({
        device: metadata.dev,
        inode: metadata.ino,
        mode: metadata.mode,
        linkCount: metadata.nlink,
        size: metadata.size,
        modifiedNanoseconds: metadata.mtimeNs,
        changedNanoseconds: metadata.ctimeNs,
        isFile: () => metadata.isFile(),
      });
    },
    async read(buffer, offset, length, position) {
      const result = await file.read(buffer, offset, length, position);
      return Object.freeze({ bytesRead: result.bytesRead });
    },
    async close() {
      await file.close();
    },
  });
}

async function readManifest(
  path: string,
  opener: LegacyInvestmentOwnershipMigrationManifestOpener,
): Promise<unknown> {
  let file: LegacyInvestmentOwnershipMigrationManifestFile | null = null;
  try {
    file = await opener(path);
    const initialMetadata = await file.stat();
    const expectedSize = manifestSize(initialMetadata);
    const firstSnapshot = await readManifestSnapshot(file, expectedSize);
    const middleMetadata = await file.stat();
    if (!sameManifestMetadata(initialMetadata, middleMetadata)) invalid();
    const secondSnapshot = await readManifestSnapshot(file, expectedSize);
    const finalMetadata = await file.stat();
    if (
      !sameManifestMetadata(initialMetadata, finalMetadata) ||
      !sameBytes(firstSnapshot, secondSnapshot)
    ) invalid();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      firstSnapshot,
    );
    rejectDuplicateJsonObjectMembers(text);
    return JSON.parse(text) as unknown;
  } catch {
    invalid();
  } finally {
    if (file !== null) await file.close().catch(() => undefined);
  }
}

function manifestSize(
  metadata: LegacyInvestmentOwnershipMigrationManifestMetadata,
): number {
  const maximum = BigInt(
    MAX_LEGACY_INVESTMENT_OWNERSHIP_MIGRATION_MANIFEST_BYTES,
  );
  if (
    !metadata.isFile() ||
    metadata.linkCount < BigInt(1) ||
    metadata.size < BigInt(1) ||
    metadata.size > maximum
  ) invalid();
  return Number(metadata.size);
}

async function readManifestSnapshot(
  file: LegacyInvestmentOwnershipMigrationManifestFile,
  expectedSize: number,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(expectedSize + 1);
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
  if (offset !== expectedSize) invalid();
  return bytes.slice(0, offset);
}

function sameManifestMetadata(
  left: LegacyInvestmentOwnershipMigrationManifestMetadata,
  right: LegacyInvestmentOwnershipMigrationManifestMetadata,
): boolean {
  return right.isFile() &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.linkCount === right.linkCount &&
    left.size === right.size &&
    left.modifiedNanoseconds === right.modifiedNanoseconds &&
    left.changedNanoseconds === right.changedNanoseconds;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function rejectDuplicateJsonObjectMembers(text: string): void {
  let index = 0;

  const skipWhitespace = (): void => {
    while (
      text[index] === " " ||
      text[index] === "\n" ||
      text[index] === "\r" ||
      text[index] === "\t"
    ) index += 1;
  };

  const scanString = (decode: boolean): string => {
    if (text[index] !== '"') invalid();
    const start = index;
    index += 1;
    while (index < text.length) {
      const codeUnit = text.charCodeAt(index);
      if (codeUnit === 0x22) {
        index += 1;
        return decode ? JSON.parse(text.slice(start, index)) as string : "";
      }
      if (codeUnit <= 0x1f) invalid();
      if (codeUnit !== 0x5c) {
        index += 1;
        continue;
      }
      index += 1;
      const escape = text[index];
      if (escape === "u") {
        if (!/^[0-9A-Fa-f]{4}$/u.test(text.slice(index + 1, index + 5))) {
          invalid();
        }
        index += 5;
      } else if (
        escape === '"' ||
        escape === "\\" ||
        escape === "/" ||
        escape === "b" ||
        escape === "f" ||
        escape === "n" ||
        escape === "r" ||
        escape === "t"
      ) {
        index += 1;
      } else {
        invalid();
      }
    }
    invalid();
  };

  const scanNumber = (): void => {
    if (text[index] === "-") index += 1;
    if (text[index] === "0") {
      index += 1;
    } else {
      if (!isDigitOneToNine(text[index])) invalid();
      while (isDigit(text[index])) index += 1;
    }
    if (text[index] === ".") {
      index += 1;
      if (!isDigit(text[index])) invalid();
      while (isDigit(text[index])) index += 1;
    }
    if (text[index] === "e" || text[index] === "E") {
      index += 1;
      if (text[index] === "+" || text[index] === "-") index += 1;
      if (!isDigit(text[index])) invalid();
      while (isDigit(text[index])) index += 1;
    }
  };

  const scanLiteral = (literal: string): void => {
    if (text.slice(index, index + literal.length) !== literal) invalid();
    index += literal.length;
  };

  const scanValue = (depth: number): void => {
    skipWhitespace();
    const token = text[index];
    if (token === '"') {
      scanString(false);
    } else if (token === "{") {
      scanObject(depth + 1);
    } else if (token === "[") {
      scanArray(depth + 1);
    } else if (token === "t") {
      scanLiteral("true");
    } else if (token === "f") {
      scanLiteral("false");
    } else if (token === "n") {
      scanLiteral("null");
    } else {
      scanNumber();
    }
  };

  const scanObject = (depth: number): void => {
    if (depth > MAX_JSON_NESTING_DEPTH || text[index] !== "{") invalid();
    index += 1;
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return;
    }
    const keys = new Set<string>();
    while (index < text.length) {
      const member = scanString(true);
      if (keys.has(member)) invalid();
      keys.add(member);
      skipWhitespace();
      if (text[index] !== ":") invalid();
      index += 1;
      scanValue(depth);
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      if (text[index] !== ",") invalid();
      index += 1;
      skipWhitespace();
    }
    invalid();
  };

  const scanArray = (depth: number): void => {
    if (depth > MAX_JSON_NESTING_DEPTH || text[index] !== "[") invalid();
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return;
    }
    while (index < text.length) {
      scanValue(depth);
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      if (text[index] !== ",") invalid();
      index += 1;
      skipWhitespace();
    }
    invalid();
  };

  skipWhitespace();
  scanValue(0);
  skipWhitespace();
  if (index !== text.length) invalid();
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function isDigitOneToNine(value: string | undefined): boolean {
  return value !== undefined && value >= "1" && value <= "9";
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
  throw new Error("Legacy investment ownership migration configuration is invalid.");
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    const result = await executeLegacyInvestmentOwnershipMigrationCommand(
      process.argv.slice(2),
      process.env,
    );
    process.stdout.write(`${JSON.stringify({ status: "completed", ...result })}\n`);
  } catch {
    process.stderr.write("Legacy investment ownership migration failed.\n");
    process.exitCode = 1;
  }
}
