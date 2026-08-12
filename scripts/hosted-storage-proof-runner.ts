import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";

import {
  StorageFailure,
  normalizeStorageTransactionRequest,
  parseStorageCollection,
  parseStorageKey,
  parseStorageOperationId,
  type StorageAdapter,
  type StorageKey,
  type StorageListRequest,
  type StoragePage,
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import { AittaDBStorageAdapter } from "../repositories/aittadb-storage-adapter.ts";
import { createAittaDBServiceTokenProvider } from "../services/aittadb-service-token.ts";
import {
  StorageAdapterContractViolation,
  verifyStorageAdapterContract,
  type StorageAdapterContractFactory,
} from "../tests/support/storage-adapter-contract.ts";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAX_CONFIGURATION_BYTES = 16_384;
const REQUEST_TIMEOUT_MS = 30_000;
const EXPIRY_SKEW_SECONDS = 30;
const MAX_FIXTURES = 99;
const SAFE_INVARIANT = /^[a-z0-9.-]{1,96}$/u;

type HostedStorageProofClient = Readonly<{
  clientId: string;
  clientSecret: string;
}>;

export type HostedStorageProofConfiguration = Readonly<{
  issuer: string;
  transportOrigin: string | undefined;
  entryHref: string;
  ownerClient: HostedStorageProofClient;
  outsiderClient: HostedStorageProofClient;
}>;

type ProofRole = "owner" | "outsider";

export type HostedStorageProofReport =
  | Readonly<{
      status: "passed";
      proof_id: string;
      contract: "storage-adapter";
      fixture_count: number;
      cleanup_inventory: Readonly<{
        collection_prefix: string;
        operation_prefix: string;
      }>;
    }>
  | Readonly<{
      status: "failed";
      code: "configuration_invalid";
    }>
  | Readonly<{
      status: "failed";
      code: "contract_failed" | "proof_unavailable";
      proof_id: string;
      fixture_count: number;
      cleanup_inventory: Readonly<{
        collection_prefix: string;
        operation_prefix: string;
      }>;
      invariant?: string;
    }>;

export type HostedStorageProofDependencies = Readonly<{
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  randomUUID?: () => string;
  verifyContract?: (
    createFixture: StorageAdapterContractFactory,
  ) => Promise<void>;
  createAdapter?: (
    role: ProofRole,
    configuration: HostedStorageProofConfiguration,
  ) => StorageAdapter;
}>;

export class HostedStorageProofConfigurationFailure extends Error {
  constructor() {
    super("Hosted storage proof configuration is invalid.");
    this.name = "HostedStorageProofConfigurationFailure";
  }
}

export function loadHostedStorageProofConfiguration(
  path: string,
  projectRoot = PROJECT_ROOT,
): HostedStorageProofConfiguration {
  let descriptor: number | undefined;
  try {
    if (typeof path !== "string" || path === "") configurationInvalid();
    const requestedPath = resolve(path);
    const requestedStats = lstatSync(requestedPath);
    if (requestedStats.isSymbolicLink()) configurationInvalid();
    const realPath = realpathSync(requestedPath);
    if (isWithin(realPath, realpathSync(projectRoot))) configurationInvalid();
    descriptor = openSync(
      requestedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stats = fstatSync(descriptor);
    if (
      !stats.isFile() ||
      stats.dev !== requestedStats.dev ||
      stats.ino !== requestedStats.ino ||
      stats.size < 2 ||
      stats.size > MAX_CONFIGURATION_BYTES ||
      (stats.mode & 0o077) !== 0 ||
      typeof process.getuid === "function" && stats.uid !== process.getuid()
    ) {
      configurationInvalid();
    }
    const source = readFileSync(descriptor, "utf8");
    const value = JSON.parse(source) as unknown;
    assertUniqueJsonMembers(source);
    return parseConfiguration(value);
  } catch {
    throw new HostedStorageProofConfigurationFailure();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export async function runHostedStorageAdapterProof(
  configuration: HostedStorageProofConfiguration,
  dependencies: HostedStorageProofDependencies = {},
): Promise<HostedStorageProofReport> {
  const proof = createProofIdentity((dependencies.randomUUID ?? randomUUID)());
  const inventory = Object.freeze({
    collection_prefix: `proof-${proof.slug}-`,
    operation_prefix: `proof:${proof.slug}:`,
  });
  let fixtureCount = 0;
  try {
    const createAdapter = dependencies.createAdapter ?? defaultAdapterFactory(
      dependencies.fetch ?? globalThis.fetch,
      dependencies.now ?? (() => new Date()),
    );
    const verifyContract = dependencies.verifyContract ?? verifyStorageAdapterContract;
    await verifyContract(() => {
      fixtureCount += 1;
      if (fixtureCount > MAX_FIXTURES) unavailable();
      const fixture = String(fixtureCount).padStart(2, "0");
      const collectionPrefix = `${inventory.collection_prefix}${fixture}-`;
      const operationPrefix = `${inventory.operation_prefix}${fixture}:`;
      return Object.freeze({
        owner: new ProofNamespacedStorageAdapter(
          createAdapter("owner", configuration),
          collectionPrefix,
          operationPrefix,
        ),
        outsider: new ProofNamespacedStorageAdapter(
          createAdapter("outsider", configuration),
          collectionPrefix,
          operationPrefix,
        ),
      });
    });
    return Object.freeze({
      status: "passed",
      proof_id: proof.id,
      contract: "storage-adapter",
      fixture_count: fixtureCount,
      cleanup_inventory: inventory,
    });
  } catch (error) {
    const invariant = error instanceof StorageAdapterContractViolation &&
        SAFE_INVARIANT.test(error.invariant)
      ? error.invariant
      : undefined;
    return Object.freeze({
      status: "failed",
      code: invariant === undefined ? "proof_unavailable" : "contract_failed",
      proof_id: proof.id,
      fixture_count: fixtureCount,
      cleanup_inventory: inventory,
      ...(invariant === undefined ? {} : { invariant }),
    });
  }
}

export function configurationFailureReport(): HostedStorageProofReport {
  return Object.freeze({ status: "failed", code: "configuration_invalid" });
}

export function formatHostedStorageProofReport(
  report: HostedStorageProofReport,
): string {
  return `${JSON.stringify(report)}\n`;
}

export class ProofNamespacedStorageAdapter implements StorageAdapter {
  readonly #adapter: StorageAdapter;
  readonly #collectionPrefix: string;
  readonly #operationPrefix: string;

  constructor(
    adapter: StorageAdapter,
    collectionPrefix: string,
    operationPrefix: string,
  ) {
    this.#adapter = adapter;
    this.#collectionPrefix = collectionPrefix;
    this.#operationPrefix = operationPrefix;
  }

  async read(key: StorageKey): Promise<StorageRecord | null> {
    const logicalKey = exactKey(key);
    const physicalKey = this.#physicalKey(logicalKey);
    const record = await this.#adapter.read(physicalKey);
    return record === null ? null : this.#logicalRecord(record, logicalKey);
  }

  async list(request: StorageListRequest): Promise<StoragePage> {
    const collection = exactCollection(request?.collection);
    const physicalCollection = this.#physicalCollection(collection);
    const page = await this.#adapter.list(Object.freeze({
      collection: physicalCollection,
      limit: request.limit,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    }));
    const items = page.items.map((record) => {
      const logicalKey = exactKey(collection, record.key.id);
      return this.#logicalRecord(record, logicalKey);
    });
    return Object.freeze({
      items: Object.freeze(items),
      nextCursor: page.nextCursor,
    });
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    const logical = normalizeStorageTransactionRequest(request);
    const operationId = parseStorageOperationId(
      `${this.#operationPrefix}${logical.operationId}`,
    );
    if (!operationId.ok) invalidRequest();
    const mutations = logical.mutations.map((mutation) => Object.freeze({
      ...mutation,
      key: this.#physicalKey(mutation.key),
    }));
    const result = await this.#adapter.transact(Object.freeze({
      operationId: operationId.value,
      mutations: Object.freeze(mutations),
    }));
    if (result.records.length !== logical.mutations.length) unavailable();
    const records = result.records.map((record, index) => {
      const mutation = logical.mutations[index];
      if (mutation === undefined || record === null) return null;
      return this.#logicalRecord(record, mutation.key);
    });
    return Object.freeze({
      replayed: result.replayed,
      records: Object.freeze(records),
    });
  }

  #physicalKey(key: StorageKey): StorageKey {
    const parsed = parseStorageKey(
      this.#physicalCollection(key.collection),
      key.id,
    );
    if (!parsed.ok) invalidRequest();
    return parsed.value;
  }

  #physicalCollection(collection: string) {
    return exactCollection(`${this.#collectionPrefix}${collection}`);
  }

  #logicalRecord(record: StorageRecord, logicalKey: StorageKey): StorageRecord {
    const expectedPhysical = this.#physicalKey(logicalKey);
    if (
      record.key.collection !== expectedPhysical.collection ||
      record.key.id !== expectedPhysical.id ||
      !Number.isSafeInteger(record.revision) ||
      record.revision < 1
    ) unavailable();
    return Object.freeze({
      key: logicalKey,
      revision: record.revision,
      value: record.value,
    });
  }
}

function defaultAdapterFactory(
  fetch: typeof globalThis.fetch,
  now: () => Date,
) {
  return (
    role: ProofRole,
    configuration: HostedStorageProofConfiguration,
  ): StorageAdapter => {
    const client = role === "owner"
      ? configuration.ownerClient
      : configuration.outsiderClient;
    const token = createAittaDBServiceTokenProvider({
      issuer: configuration.issuer,
      ...(configuration.transportOrigin === undefined
        ? {}
        : { transportOrigin: configuration.transportOrigin }),
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      storageScopes: role === "owner"
        ? ["storage.read", "storage.write", "storage.delete"]
        : ["storage.read"],
      expirySkewSeconds: EXPIRY_SKEW_SECONDS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      fetch,
      now,
    });
    return new AittaDBStorageAdapter({
      issuer: configuration.issuer,
      entryHref: configuration.entryHref,
      ...(configuration.transportOrigin === undefined
        ? {}
        : { transportOrigin: configuration.transportOrigin }),
      accessToken: token.accessToken,
      fetch,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
  };
}

function parseConfiguration(value: unknown): HostedStorageProofConfiguration {
  const root = exactObject(value, [
    "entry_href",
    "issuer",
    "owner_client",
    "read_only_outsider_client",
    "transport_origin",
  ]);
  const issuer = exactHttpsOrigin(root.issuer);
  const transportOrigin = root.transport_origin === null
    ? undefined
    : exactHttpsOrigin(root.transport_origin);
  const entryHref = exactEntryHref(root.entry_href, issuer);
  const ownerClient = exactClient(root.owner_client);
  const outsiderClient = exactClient(root.read_only_outsider_client);
  if (new Set([
    ownerClient.clientId,
    ownerClient.clientSecret,
    outsiderClient.clientId,
    outsiderClient.clientSecret,
  ]).size !== 4) configurationInvalid();
  return Object.freeze({
    issuer,
    transportOrigin,
    entryHref,
    ownerClient,
    outsiderClient,
  });
}

function assertUniqueJsonMembers(source: string): void {
  let index = 0;

  const whitespace = () => {
    while (/\s/u.test(source[index] ?? "")) index += 1;
  };
  const stringEnd = () => {
    if (source[index] !== '"') configurationInvalid();
    const start = index;
    index += 1;
    while (index < source.length) {
      if (source[index] === "\\") index += 2;
      else if (source[index] === '"') {
        index += 1;
        return Object.freeze({ start, end: index });
      } else index += 1;
    }
    configurationInvalid();
  };
  const value = (): void => {
    whitespace();
    if (source[index] === "{") {
      object();
      return;
    }
    if (source[index] === "[") {
      array();
      return;
    }
    if (source[index] === '"') {
      stringEnd();
      return;
    }
    const start = index;
    while (
      index < source.length &&
      !/[\s,}\]]/u.test(source[index] ?? "")
    ) index += 1;
    if (index === start) configurationInvalid();
  };
  const object = (): void => {
    index += 1;
    whitespace();
    const names = new Set<string>();
    if (source[index] === "}") {
      index += 1;
      return;
    }
    while (index < source.length) {
      const token = stringEnd();
      const name = JSON.parse(source.slice(token.start, token.end)) as unknown;
      if (typeof name !== "string" || names.has(name)) configurationInvalid();
      names.add(name);
      whitespace();
      if (source[index] !== ":") configurationInvalid();
      index += 1;
      value();
      whitespace();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      if (source[index] !== ",") configurationInvalid();
      index += 1;
      whitespace();
    }
    configurationInvalid();
  };
  const array = (): void => {
    index += 1;
    whitespace();
    if (source[index] === "]") {
      index += 1;
      return;
    }
    while (index < source.length) {
      value();
      whitespace();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      if (source[index] !== ",") configurationInvalid();
      index += 1;
    }
    configurationInvalid();
  };

  value();
  whitespace();
  if (index !== source.length) configurationInvalid();
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  ) configurationInvalid();
  return value as Record<string, unknown>;
}

function exactClient(value: unknown): HostedStorageProofClient {
  const client = exactObject(value, ["client_id", "client_secret"]);
  return Object.freeze({
    clientId: exactCredential(client.client_id, 1, 255, false),
    clientSecret: exactCredential(client.client_secret, 16, 512, true),
  });
}

function exactCredential(
  value: unknown,
  minimum: number,
  maximum: number,
  allowColon: boolean,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    !/^[\x21-\x7e]+$/u.test(value) ||
    !allowColon && value.includes(":")
  ) configurationInvalid();
  return value;
}

function exactHttpsOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) configurationInvalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    configurationInvalid();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    value !== url.origin && value !== url.href
  ) configurationInvalid();
  return url.origin;
}

function exactEntryHref(value: unknown, issuer: string): string {
  if (typeof value !== "string" || value.length > 2_048) configurationInvalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    configurationInvalid();
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== issuer ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname === "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    value !== url.href
  ) configurationInvalid();
  return url.href;
}

function createProofIdentity(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    unavailable();
  }
  return Object.freeze({
    id: `storage-proof-${value}`,
    slug: value.replaceAll("-", "").slice(0, 24),
  });
}

function exactKey(value: StorageKey): StorageKey;
function exactKey(collection: unknown, id: unknown): StorageKey;
function exactKey(
  valueOrCollection: StorageKey | unknown,
  optionalId?: unknown,
): StorageKey {
  const parsed = optionalId === undefined &&
      typeof valueOrCollection === "object" &&
      valueOrCollection !== null
    ? parseStorageKey(
        (valueOrCollection as StorageKey).collection,
        (valueOrCollection as StorageKey).id,
      )
    : parseStorageKey(valueOrCollection, optionalId);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function exactCollection(value: unknown) {
  const parsed = parseStorageCollection(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function isWithin(path: string, root: string): boolean {
  const relation = relative(root, path);
  return relation === "" || !relation.startsWith("..") && !isAbsolute(relation);
}

function configurationInvalid(): never {
  throw new HostedStorageProofConfigurationFailure();
}

function invalidRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
}

function unavailable(): never {
  throw new StorageFailure("UNAVAILABLE");
}
