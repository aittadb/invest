import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
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
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  AITTADB_HYPERMEDIA_API_VERSION,
  AITTADB_HYPERMEDIA_MEDIA_TYPE,
} from "../domain/aittadb-storage-protocol.ts";
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
} from "../tests/support/storage-adapter-contract.ts";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAX_CONFIGURATION_BYTES = 16_384;
const REQUEST_TIMEOUT_MS = 30_000;
const EXPIRY_SKEW_SECONDS = 30;
const MAX_FIXTURES = 99;
const GIT_PROBE_TIMEOUT_MS = 5_000;
const SAFETY_ASSERTION_PATH = "/.well-known/aittadb-proof-safety";
const MAX_SAFETY_ASSERTION_BYTES = 8_192;
const MAX_SAFETY_ASSERTION_CHUNKS = 64;
const NON_PRODUCTION_HOST_LABELS = new Set([
  "acceptance",
  "dev",
  "development",
  "sandbox",
  "staging",
  "test",
  "testing",
]);

type HostedStorageProofClient = Readonly<{
  clientId: string;
  clientSecret: string;
}>;

export type HostedStorageProofConfiguration = Readonly<{
  targetEnvironment: "disposable-acceptance";
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
    assertOutsideGit(realPath);
    descriptor = openSync(
      requestedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stats = fstatSync(descriptor);
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
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
    const finalStats = fstatSync(descriptor);
    if (
      finalStats.nlink !== 1 ||
      finalStats.dev !== stats.dev ||
      finalStats.ino !== stats.ino ||
      finalStats.size !== stats.size ||
      finalStats.mtimeMs !== stats.mtimeMs ||
      finalStats.ctimeMs !== stats.ctimeMs
    ) configurationInvalid();
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
): Promise<HostedStorageProofReport> {
  let runnableConfiguration: HostedStorageProofConfiguration;
  try {
    runnableConfiguration = snapshotRunnableConfiguration(configuration);
  } catch {
    return configurationFailureReport();
  }
  const proof = createProofIdentity(randomUUID());
  const inventory = Object.freeze({
    collection_prefix: `proof-${proof.slug}-`,
    operation_prefix: `proof:${proof.slug}:`,
  });
  let fixtureCount = 0;
  try {
    const fetch = globalThis.fetch;
    await verifyDisposableAcceptanceTarget(
      runnableConfiguration,
      proof.id,
      fetch,
    );
    const createAdapter = defaultAdapterFactory(
      fetch,
      () => new Date(),
    );
    await verifyStorageAdapterContract(() => {
      fixtureCount += 1;
      if (fixtureCount > MAX_FIXTURES) unavailable();
      const fixture = String(fixtureCount).padStart(2, "0");
      const collectionPrefix = `${inventory.collection_prefix}${fixture}-`;
      const operationPrefix = `${inventory.operation_prefix}${fixture}:`;
      return Object.freeze({
        owner: new ProofNamespacedStorageAdapter(
          createAdapter("owner", runnableConfiguration),
          collectionPrefix,
          operationPrefix,
        ),
        outsider: new ProofNamespacedStorageAdapter(
          createAdapter("outsider", runnableConfiguration),
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
    return Object.freeze({
      status: "failed",
      code: error instanceof StorageAdapterContractViolation
        ? "contract_failed"
        : "proof_unavailable",
      proof_id: proof.id,
      fixture_count: fixtureCount,
      cleanup_inventory: inventory,
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
    "target_environment",
    "transport_origin",
  ]);
  if (root.target_environment !== "disposable-acceptance") {
    configurationInvalid();
  }
  const issuer = exactDisposableAcceptanceOrigin(root.issuer);
  const transportOrigin = root.transport_origin === null
    ? undefined
    : exactDisposableAcceptanceOrigin(root.transport_origin);
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
    targetEnvironment: "disposable-acceptance",
    issuer,
    transportOrigin,
    entryHref,
    ownerClient,
    outsiderClient,
  });
}

function snapshotRunnableConfiguration(
  value: unknown,
): HostedStorageProofConfiguration {
  const root = exactObject(value, [
    "entryHref",
    "issuer",
    "outsiderClient",
    "ownerClient",
    "targetEnvironment",
    "transportOrigin",
  ]);
  if (root.targetEnvironment !== "disposable-acceptance") {
    configurationInvalid();
  }
  const issuer = exactDisposableAcceptanceOrigin(root.issuer);
  const entryHref = exactEntryHref(root.entryHref, issuer);
  const transportOrigin = root.transportOrigin === undefined
    ? undefined
    : exactDisposableAcceptanceOrigin(root.transportOrigin);
  const owner = exactParsedClient(root.ownerClient);
  const outsider = exactParsedClient(root.outsiderClient);
  if (new Set([
    owner.clientId,
    owner.clientSecret,
    outsider.clientId,
    outsider.clientSecret,
  ]).size !== 4) configurationInvalid();
  return Object.freeze({
    targetEnvironment: "disposable-acceptance",
    issuer,
    transportOrigin,
    entryHref,
    ownerClient: owner,
    outsiderClient: outsider,
  });
}

async function verifyDisposableAcceptanceTarget(
  configuration: HostedStorageProofConfiguration,
  proofId: string,
  fetch: typeof globalThis.fetch,
): Promise<void> {
  const logicalTarget = new URL(SAFETY_ASSERTION_PATH, configuration.issuer);
  logicalTarget.searchParams.set("challenge", proofId);
  const transportTarget = new URL(logicalTarget);
  if (configuration.transportOrigin !== undefined) {
    const transportOrigin = new URL(configuration.transportOrigin);
    transportTarget.protocol = transportOrigin.protocol;
    transportTarget.host = transportOrigin.host;
  }

  const controller = new AbortController();
  let rejectDeadline: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = () => reject(new Error("deadline"));
  });
  const timeout = setTimeout(() => {
    controller.abort();
    rejectDeadline?.();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await Promise.race([
      fetch(transportTarget.href, {
        method: "GET",
        headers: {
          Accept: AITTADB_HYPERMEDIA_MEDIA_TYPE,
          "Cache-Control": "no-store",
        },
        redirect: "manual",
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (!(response instanceof Response)) unavailable();
    if (
      response.status !== 200 ||
      response.redirected ||
      response.url !== "" && response.url !== transportTarget.href ||
      response.headers.get("content-type") !== AITTADB_HYPERMEDIA_MEDIA_TYPE ||
      response.headers.get("cache-control") !== "no-store"
    ) rejectSafetyResponse(response);
    const length = response.headers.get("content-length");
    if (
      length !== null &&
      (!/^(?:0|[1-9][0-9]*)$/u.test(length) ||
        Number(length) > MAX_SAFETY_ASSERTION_BYTES)
    ) rejectSafetyResponse(response);
    const source = await readBoundedSafetyAssertion(response, deadline);
    assertUniqueJsonMembers(source);
    const document = exactObject(JSON.parse(source) as unknown, [
      "actions",
      "api_version",
      "data",
      "id",
      "links",
      "type",
    ]);
    const data = exactObject(document.data, [
      "challenge",
      "environment",
      "issuer",
      "storage_contract_proofs",
    ]);
    if (
      document.api_version !== AITTADB_HYPERMEDIA_API_VERSION ||
      document.type !== "acceptance-proof-safety" ||
      document.id !== logicalTarget.href ||
      data.challenge !== proofId ||
      data.environment !== "disposable-acceptance" ||
      data.issuer !== configuration.issuer ||
      data.storage_contract_proofs !== "allowed" ||
      !isExactEmptyArray(document.links) ||
      !isExactEmptyArray(document.actions)
    ) unavailable();
  } catch {
    unavailable();
  } finally {
    clearTimeout(timeout);
    rejectDeadline = undefined;
  }
}

function rejectSafetyResponse(response: Response): never {
  if (response.body !== null) {
    void response.body.cancel().catch(() => undefined);
  }
  unavailable();
}

async function readBoundedSafetyAssertion(
  response: Response,
  deadline: Promise<never>,
): Promise<string> {
  if (response.body === null) unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let reads = 0;
  try {
    while (true) {
      const result = await Promise.race([reader.read(), deadline]);
      reads += 1;
      if (reads > MAX_SAFETY_ASSERTION_CHUNKS) unavailable();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) unavailable();
      bytes += result.value.byteLength;
      if (bytes > MAX_SAFETY_ASSERTION_BYTES) unavailable();
      chunks.push(result.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    void reader.cancel().catch(() => undefined);
    unavailable();
  }
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
    Object.getOwnPropertySymbols(value).length !== 0
  ) configurationInvalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).sort().join(",") !== [...keys].sort().join(",") ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true;
    })
  ) configurationInvalid();
  return Object.freeze(Object.fromEntries(
    keys.map((key) => [key, descriptors[key]?.value]),
  ));
}

function isExactEmptyArray(value: unknown): value is readonly [] {
  return Array.isArray(value) &&
    Object.getPrototypeOf(value) === Array.prototype &&
    value.length === 0 &&
    Object.keys(value).length === 0 &&
    Object.getOwnPropertySymbols(value).length === 0;
}

function exactClient(value: unknown): HostedStorageProofClient {
  const client = exactObject(value, ["client_id", "client_secret"]);
  return Object.freeze({
    clientId: exactCredential(client.client_id, 1, 255, false),
    clientSecret: exactCredential(client.client_secret, 16, 512, true),
  });
}

function exactParsedClient(value: unknown): HostedStorageProofClient {
  const client = exactObject(value, ["clientId", "clientSecret"]);
  return Object.freeze({
    clientId: exactCredential(client.clientId, 1, 255, false),
    clientSecret: exactCredential(client.clientSecret, 16, 512, true),
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

function exactDisposableAcceptanceOrigin(value: unknown): string {
  const origin = exactHttpsOrigin(value);
  const labels = new URL(origin).hostname.toLowerCase().split(".");
  if (
    labels.at(-1) !== "test" &&
    !labels.some((label) => NON_PRODUCTION_HOST_LABELS.has(label))
  ) configurationInvalid();
  return origin;
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

function assertOutsideGit(path: string): void {
  const result = spawnSync(
    "git",
    ["-C", dirname(path), "rev-parse", "--is-inside-work-tree", "--is-inside-git-dir"],
    {
      encoding: "utf8",
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        LANG: "C",
        LC_ALL: "C",
        NODE_ENV: process.env.NODE_ENV,
        PATH: process.env.PATH ?? "",
      },
      maxBuffer: 4_096,
      timeout: GIT_PROBE_TIMEOUT_MS,
    },
  );
  if (result.status === 0) configurationInvalid();
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 128 ||
    !result.stderr.split("\n").some((line) =>
      line.startsWith("fatal: not a git repository")
    )
  ) configurationInvalid();
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
