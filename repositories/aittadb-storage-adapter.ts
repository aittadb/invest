import {
  AITTADB_HYPERMEDIA_MEDIA_TYPE,
  MAX_STORAGE_PROTOCOL_TRANSACTION_BYTES,
  parseStorageProtocolDiscovery,
  parseStorageProtocolPage,
  parseStorageProtocolRecord,
  parseStorageProtocolTransaction,
  storageFailureFromProtocol,
  toStorageProtocolTransactionCommand,
  type StorageProtocolAction,
  type StorageProtocolDiscoveryDocument,
  type StorageProtocolLimits,
} from "../domain/aittadb-storage-protocol.ts";
import {
  StorageFailure,
  assertStorageListBoundary,
  normalizeStorageTransactionRequest,
  parseStorageCollection,
  parseStorageKey,
  type StorageAdapter,
  type StorageKey,
  type StorageListRequest,
  type StoragePage,
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";

const DISCOVERY_RESPONSE_MAX_BYTES = 65_536;
const ERROR_RESPONSE_MAX_BYTES = 16_384;
const RESPONSE_ENVELOPE_BYTES = 65_536;
const ACCESS_TOKEN_MAX_LENGTH = 4_096;
const URL_MAX_LENGTH = 2_048;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MIN_REQUEST_TIMEOUT_MS = 10;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_CHUNKS = 4_096;

export type AittaDBStorageFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type AittaDBStorageAdapterDependencies = Readonly<{
  /** Logical HTTPS identity used to validate every advertised control. */
  issuer: string;
  /** Configured logical discovery resource; no route is assumed by the adapter. */
  entryHref: string;
  /** Optional backend-only network origin for Worker-to-Worker transport. */
  transportOrigin?: string;
  /** Backend capability that returns a scoped token without exposing its source. */
  accessToken: () => string | Promise<string>;
  fetch: AittaDBStorageFetch;
  /** Total bound for token or fetch waits and, separately, response streaming. */
  requestTimeoutMs?: number;
}>;

type ValidatedConfiguration = Readonly<{
  issuer: string;
  entryHref: string;
  transportOrigin: string;
  accessToken: () => string | Promise<string>;
  fetch: AittaDBStorageFetch;
  requestTimeoutMs: number;
}>;

/**
 * Credential-bound production adapter for the bounded AittaDB hypermedia
 * storage protocol. It retains no token and exposes no transport details.
 */
export class AittaDBStorageAdapter implements StorageAdapter {
  readonly #configuration: ValidatedConfiguration;
  #discoveryAttempt: Promise<StorageProtocolDiscoveryDocument> | undefined;

  constructor(dependencies: AittaDBStorageAdapterDependencies) {
    this.#configuration = validateConfiguration(dependencies);
  }

  async read(key: StorageKey): Promise<StorageRecord | null> {
    const parsedKey = parseStorageKey(key?.collection, key?.id);
    if (!parsedKey.ok) invalidRequest();

    const discovery = await this.#discovery();
    const action = requiredAction(discovery, "read-record");
    const logicalHref = action.href
      .replace("{collection}", encodeURIComponent(parsedKey.value.collection))
      .replace("{id}", encodeURIComponent(parsedKey.value.id));
    const logicalTarget = exactLogicalActionUrl(
      logicalHref,
      this.#configuration.issuer,
    );
    if (logicalTarget.search !== "") unavailable();
    const response = await this.#request(logicalTarget.href, { method: "GET" });
    const maxBytes = response.status === 200
      ? boundedSum(
          discovery.data.limits.max_record_bytes,
          RESPONSE_ENVELOPE_BYTES,
        )
      : ERROR_RESPONSE_MAX_BYTES;
    const document = await readProtocolJson(
      response,
      maxBytes,
      this.#configuration.requestTimeoutMs,
    );

    if (response.status === 404) {
      const failure = storageFailureFromProtocol(response.status, document);
      if (failure.code === "NOT_FOUND") return null;
      throw failure;
    }
    if (response.status !== 200) {
      throw storageFailureFromProtocol(response.status, document);
    }
    return parseProtocolValue(() =>
      parseStorageProtocolRecord(
        document,
        parsedKey.value,
        discovery.data.limits.max_record_bytes,
      )
    );
  }

  async list(request: StorageListRequest): Promise<StoragePage> {
    try {
      assertStorageListBoundary(request);
    } catch {
      invalidRequest();
    }
    const parsedCollection = parseStorageCollection(request?.collection);
    if (!parsedCollection.ok) invalidRequest();

    const discovery = await this.#discovery();
    validateCursor(request.cursor, discovery.data.limits.max_cursor_length);
    const action = requiredAction(discovery, "list-records");
    const logicalTarget = exactLogicalActionUrl(action.href, this.#configuration.issuer);
    if (logicalTarget.search !== "") unavailable();
    logicalTarget.searchParams.set("collection", parsedCollection.value);
    logicalTarget.searchParams.set("limit", String(request.limit));
    if (request.cursor !== undefined) {
      logicalTarget.searchParams.set("cursor", request.cursor);
    }

    const response = await this.#request(logicalTarget.href, { method: "GET" });
    const maxBytes = response.status === 200
      ? pageResponseLimit(request.limit, discovery.data.limits)
      : ERROR_RESPONSE_MAX_BYTES;
    const document = await readProtocolJson(
      response,
      maxBytes,
      this.#configuration.requestTimeoutMs,
    );
    if (response.status !== 200) {
      throw storageFailureFromProtocol(response.status, document);
    }
    return parseProtocolValue(() =>
      parseStorageProtocolPage(
        document,
        request,
        discovery.data.limits,
        logicalTarget.href,
      )
    );
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    let snapshot: StorageTransactionRequest;
    try {
      snapshot = normalizeStorageTransactionRequest(request);
    } catch {
      invalidRequest();
    }
    const command = transactionCommand(snapshot);
    const body = serializeJson(command);
    if (byteLength(body) > MAX_STORAGE_PROTOCOL_TRANSACTION_BYTES) {
      invalidRequest();
    }
    const discovery = await this.#discovery();
    assertProtocolRecordRequestLimits(command, discovery.data.limits);
    if (byteLength(body) > discovery.data.limits.max_transaction_bytes) {
      invalidRequest();
    }

    const action = requiredAction(discovery, "transact-records");
    const logicalTarget = exactLogicalActionUrl(action.href, this.#configuration.issuer);
    if (logicalTarget.search !== "") unavailable();
    const response = await this.#request(logicalTarget.href, {
      method: "POST",
      body,
      contentType: "application/json",
    });
    const maxBytes = response.status === 200
      ? transactionResponseLimit(snapshot, discovery.data.limits)
      : ERROR_RESPONSE_MAX_BYTES;
    const document = await readProtocolJson(
      response,
      maxBytes,
      this.#configuration.requestTimeoutMs,
    );
    if (response.status !== 200) {
      throw storageFailureFromProtocol(response.status, document);
    }
    return parseProtocolValue(() =>
      parseStorageProtocolTransaction(
        document,
        snapshot,
        discovery.data.limits.max_record_bytes,
      )
    );
  }

  async #discovery(): Promise<StorageProtocolDiscoveryDocument> {
    const existing = this.#discoveryAttempt;
    if (existing !== undefined) return existing;

    const attempt = this.#loadDiscovery().catch(() => unavailable());
    this.#discoveryAttempt = attempt;
    void attempt.catch(() => {
      if (this.#discoveryAttempt === attempt) this.#discoveryAttempt = undefined;
    });
    return attempt;
  }

  async #loadDiscovery(): Promise<StorageProtocolDiscoveryDocument> {
    const response = await this.#request(this.#configuration.entryHref, {
      method: "GET",
    });
    const document = await readProtocolJson(
      response,
      response.status === 200
        ? DISCOVERY_RESPONSE_MAX_BYTES
        : ERROR_RESPONSE_MAX_BYTES,
      this.#configuration.requestTimeoutMs,
    );
    if (response.status !== 200) {
      throw storageFailureFromProtocol(response.status, document);
    }
    return parseProtocolValue(() =>
      parseStorageProtocolDiscovery(document, this.#configuration.issuer)
    );
  }

  async #request(
    logicalHref: string,
    request: Readonly<{
      method: "GET" | "POST";
      body?: string;
      contentType?: "application/json";
    }>,
  ): Promise<Response> {
    const logicalTarget = exactLogicalActionUrl(
      logicalHref,
      this.#configuration.issuer,
    );
    const transportTarget = new URL(logicalTarget.href);
    const transportOrigin = new URL(this.#configuration.transportOrigin);
    transportTarget.protocol = transportOrigin.protocol;
    transportTarget.host = transportOrigin.host;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.#configuration.requestTimeoutMs,
    );
    try {
      const token = await waitForAbort(
        Promise.resolve(this.#configuration.accessToken()),
        controller.signal,
      );
      const authorization = bearerAuthorization(token);
      const headers = new Headers({
        Accept: AITTADB_HYPERMEDIA_MEDIA_TYPE,
        Authorization: authorization,
        "Cache-Control": "no-store",
      });
      if (request.contentType !== undefined) {
        headers.set("Content-Type", request.contentType);
      }

      const response = await waitForAbort(
        this.#configuration.fetch(transportTarget.href, {
          method: request.method,
          headers,
          ...(request.body === undefined ? {} : { body: request.body }),
          redirect: "manual",
          signal: controller.signal,
        }),
        controller.signal,
      );
      if (!(response instanceof Response)) unavailable();
      if (
        response.redirected ||
        response.url !== "" && response.url !== transportTarget.href ||
        response.status >= 300 && response.status < 400
      ) {
        rejectProtocolResponse(response);
      }
      return response;
    } catch {
      unavailable();
    } finally {
      clearTimeout(timeout);
    }
  }
}

function validateConfiguration(
  dependencies: AittaDBStorageAdapterDependencies,
): ValidatedConfiguration {
  try {
    const issuer = exactHttpsOrigin(dependencies.issuer);
    const entry = exactHttpsUrl(dependencies.entryHref);
    if (entry.origin !== issuer || entry.search !== "") unavailable();
    const transportOrigin = dependencies.transportOrigin === undefined
      ? issuer
      : exactHttpsOrigin(dependencies.transportOrigin);
    const requestTimeoutMs = dependencies.requestTimeoutMs ??
      DEFAULT_REQUEST_TIMEOUT_MS;
    if (
      typeof dependencies.accessToken !== "function" ||
      typeof dependencies.fetch !== "function" ||
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < MIN_REQUEST_TIMEOUT_MS ||
      requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
    ) {
      unavailable();
    }
    return Object.freeze({
      issuer,
      entryHref: entry.href,
      transportOrigin,
      accessToken: dependencies.accessToken,
      fetch: dependencies.fetch,
      requestTimeoutMs,
    });
  } catch {
    unavailable();
  }
}

function exactLogicalActionUrl(value: string, issuer: string): URL {
  const url = exactHttpsUrl(value);
  if (url.origin !== issuer) unavailable();
  return url;
}

function exactHttpsOrigin(value: unknown): string {
  if (typeof value !== "string") unavailable();
  const url = exactHttpsUrl(value);
  if (
    url.pathname !== "/" ||
    url.search !== "" ||
    value !== url.origin && value !== url.href
  ) {
    unavailable();
  }
  return url.origin;
}

function exactHttpsUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length < 1 || value.length > URL_MAX_LENGTH) {
    unavailable();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    unavailable();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.href !== value && !(
      url.pathname === "/" &&
      url.search === "" &&
      value === url.origin
    )
  ) {
    unavailable();
  }
  return url;
}

function requiredAction(
  document: StorageProtocolDiscoveryDocument,
  name: StorageProtocolAction["name"],
): StorageProtocolAction {
  const action = document.actions.find((candidate) => candidate.name === name);
  if (action === undefined) unavailable();
  return action;
}

function validateCursor(value: unknown, maxLength: number): void {
  if (value === undefined) return;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    hasControlCharacter(value)
  ) {
    invalidRequest();
  }
}

function bearerAuthorization(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > ACCESS_TOKEN_MAX_LENGTH ||
    !/^[\x21-\x7e]+$/u.test(value)
  ) {
    unavailable();
  }
  return `Bearer ${value}`;
}

async function readProtocolJson(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
): Promise<unknown> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    response.headers.get("content-type") !== AITTADB_HYPERMEDIA_MEDIA_TYPE
  ) {
    rejectProtocolResponse(response);
  }
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)
  ) {
    rejectProtocolResponse(response);
  }
  if (response.body === null) unavailable();

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    unavailable();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let chunkCount = 0;
  let rejectTimeout: ((reason?: unknown) => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeout = setTimeout(
    () => rejectTimeout?.(new StorageFailure("UNAVAILABLE")),
    timeoutMs,
  );
  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      chunkCount += 1;
      total += next.value.byteLength;
      if (
        chunkCount > MAX_RESPONSE_CHUNKS ||
        !Number.isSafeInteger(total) ||
        total > maxBytes
      ) {
        cancelReader(reader);
        unavailable();
      }
      if (next.value.byteLength > 0) chunks.push(next.value);
    }
  } catch {
    cancelReader(reader);
    unavailable();
  } finally {
    clearTimeout(timeout);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    unavailable();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    unavailable();
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // The caller emits one fixed storage failure.
  }
}

function rejectProtocolResponse(response: Response): never {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // The caller emits one fixed storage failure.
  }
  unavailable();
}

function pageResponseLimit(limit: number, limits: StorageProtocolLimits): number {
  return boundedSum(
    limit * limits.max_record_bytes,
    RESPONSE_ENVELOPE_BYTES,
  );
}

function transactionResponseLimit(
  request: StorageTransactionRequest,
  limits: StorageProtocolLimits,
): number {
  const recordResults = request.mutations.filter((mutation) =>
    mutation.type === "put" ||
    mutation.type === "check" && mutation.expectedRevision !== null
  ).length;
  return boundedSum(
    recordResults * limits.max_record_bytes,
    RESPONSE_ENVELOPE_BYTES,
  );
}

function assertProtocolRecordRequestLimits(
  command: ReturnType<typeof toStorageProtocolTransactionCommand>,
  limits: StorageProtocolLimits,
): void {
  for (const mutation of command.transaction.mutations) {
    if (
      mutation.type === "put" &&
      byteLength(serializeJson(mutation.value)) > limits.max_record_bytes
    ) {
      invalidRequest();
    }
  }
}

function transactionCommand(
  request: StorageTransactionRequest,
): ReturnType<typeof toStorageProtocolTransactionCommand> {
  try {
    return toStorageProtocolTransactionCommand(request);
  } catch {
    invalidRequest();
  }
}

function parseProtocolValue<Value>(operation: () => Value): Value {
  try {
    return operation();
  } catch (error) {
    if (error instanceof StorageFailure) throw error;
    unavailable();
  }
}

function boundedSum(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 1) unavailable();
  return value;
}

function serializeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") invalidRequest();
    return serialized;
  } catch (error) {
    if (error instanceof StorageFailure) throw error;
    invalidRequest();
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function waitForAbort<Value>(
  operation: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  if (signal.aborted) unavailable();
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => rejectAbort?.(new StorageFailure("UNAVAILABLE"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

function invalidRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
}

function unavailable(): never {
  throw new StorageFailure("UNAVAILABLE");
}
