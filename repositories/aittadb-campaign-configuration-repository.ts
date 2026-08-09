import { parseTimestamp } from "../domain/foundation.ts";
import {
  MAX_STORAGE_PAGE_SIZE,
  StorageFailure,
  parseStorageOperationId,
  type StorageCursor,
} from "../domain/storage-adapter.ts";
import {
  parseCampaignSetup,
  type CampaignRepository,
  type CampaignSetupHistoryPage,
  type CampaignSetupHistoryRequest,
  type CampaignSetupRevision,
  type SaveCampaignSetupRequest,
} from "./in-memory-campaign-repository.ts";

const CAMPAIGN_RECORD_KIND = "investor-app-campaign-configuration";
const CAMPAIGN_RECORD_SCHEMA_VERSION = 1;
const AITTADB_HYPERMEDIA_TYPE =
  "application/vnd.aittadb+json; version=0.1";
const DEFAULT_MAX_RECORD_BYTES = 65_536;
const MAX_OPENAPI_BYTES = 1_048_576;
const HISTORY_CURSOR_PREFIX = "aittadb-campaign-history:";

const ENVELOPE_KEYS = new Set([
  "kind",
  "schemaVersion",
  "current",
  "history",
]);
const REVISION_KEYS = new Set([
  "revision",
  "recordedAt",
  "operationId",
  "setup",
]);
const RECORD_DATA_KEYS = new Set([
  "key",
  "value",
  "created_at",
  "updated_at",
]);

export type AittaDBFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type AittaDBCampaignRepositoryOptions = Readonly<{
  /** Deployment-specific AittaDB issuer origin. */
  issuer: string;
  /** Deployment-specific logical record key; never inferred from campaign data. */
  recordKey: string;
  /** Supplies a backend-held OAuth access token for this repository instance. */
  accessToken: () => string | Promise<string>;
  fetch?: AittaDBFetch;
  maxRecordBytes?: number;
}>;

type CampaignConfigurationEnvelope = Readonly<{
  kind: typeof CAMPAIGN_RECORD_KIND;
  schemaVersion: typeof CAMPAIGN_RECORD_SCHEMA_VERSION;
  current: CampaignSetupRevision;
  history: readonly CampaignSetupRevision[];
}>;

type ReadCampaignRecord = Readonly<{
  envelope: CampaignConfigurationEnvelope;
  etag: string | null;
}>;

/**
 * One-record AittaDB campaign repository.
 *
 * Writes are attempted only when the backend's current OpenAPI document
 * advertises strong ETag responses plus If-Match/If-None-Match and 412
 * semantics. This keeps a deployment without atomic record preconditions
 * read-compatible while failing closed before any unsafe mutation.
 */
export class AittaDBCampaignConfigurationRepository
implements CampaignRepository {
  readonly storageKind = "aittadb" as const;

  private readonly issuer: string;
  private readonly recordKey: string;
  private readonly recordUrl: string;
  private readonly openApiUrl: string;
  private readonly accessToken: () => string | Promise<string>;
  private readonly fetchImplementation: AittaDBFetch;
  private readonly maxRecordBytes: number;
  private conditionalWritesVerified = false;

  constructor(options: AittaDBCampaignRepositoryOptions) {
    this.issuer = parseIssuer(options.issuer);
    this.recordKey = parseRecordKey(options.recordKey);
    this.recordUrl = `${this.issuer}/storage/records/${encodeURIComponent(this.recordKey)}`;
    this.openApiUrl = `${this.issuer}/openapi.json`;
    if (typeof options.accessToken !== "function") {
      throw new StorageFailure("INVALID_REQUEST");
    }
    this.accessToken = options.accessToken;
    const fetchImplementation = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchImplementation !== "function") {
      throw new StorageFailure("INVALID_REQUEST");
    }
    this.fetchImplementation = fetchImplementation;
    this.maxRecordBytes = parseMaxRecordBytes(options.maxRecordBytes);
  }

  async readSetup(): Promise<CampaignSetupRevision | null> {
    const record = await this.readRecord(false);
    return record?.envelope.current ?? null;
  }

  async saveSetup(
    request: SaveCampaignSetupRequest,
  ): Promise<CampaignSetupRevision> {
    const operationId = parseStorageOperationId(request.operationId);
    const recordedAt = parseTimestamp(request.recordedAt);
    const setup = parseCampaignSetup(request.setup);
    const expectedRevision = parseExpectedRevision(request.expectedRevision);
    if (
      !operationId.ok ||
      !recordedAt.ok ||
      !setup.ok ||
      expectedRevision === undefined
    ) {
      throw new StorageFailure("INVALID_REQUEST");
    }

    await this.verifyConditionalWriteCapability();
    const stored = await this.readRecord(true);
    const history = stored?.envelope.history ?? [];
    const replay = history.find(
      (revision) => revision.operationId === operationId.value,
    );
    if (replay) {
      if (
        expectedRevisionFor(replay.revision) === expectedRevision &&
        replay.recordedAt === recordedAt.value &&
        equalJson(replay.setup, setup.value)
      ) {
        return replay;
      }
      throw new StorageFailure("CONFLICT");
    }

    const currentRevision = stored?.envelope.current.revision ?? null;
    if (currentRevision !== expectedRevision) {
      throw new StorageFailure("PRECONDITION_FAILED");
    }

    const revision = deepFreeze({
      revision: expectedRevision === null ? 1 : expectedRevision + 1,
      recordedAt: recordedAt.value,
      operationId: operationId.value,
      setup: setup.value,
    });
    const envelope = deepFreeze({
      kind: CAMPAIGN_RECORD_KIND,
      schemaVersion: CAMPAIGN_RECORD_SCHEMA_VERSION,
      current: revision,
      history: [...history, revision],
    });
    const serialized = serializeBounded(envelope, this.maxRecordBytes);
    const response = await this.fetchWithToken(this.recordUrl, {
      method: "PUT",
      headers: {
        Accept: AITTADB_HYPERMEDIA_TYPE,
        "Content-Type": "application/json",
        ...(stored === null
          ? { "If-None-Match": "*" }
          : { "If-Match": requireStrongEtag(stored.etag) }),
      },
      body: serialized,
    });

    if (response.status === 409 || response.status === 412) {
      throw new StorageFailure("PRECONDITION_FAILED");
    }
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404
    ) {
      throw new StorageFailure("NOT_FOUND");
    }
    if (
      response.status === 400 ||
      response.status === 413 ||
      response.status === 415
    ) {
      throw new StorageFailure("INVALID_REQUEST");
    }
    if (response.status !== 200) {
      throw new StorageFailure("UNAVAILABLE");
    }

    requireStrongEtag(response.headers.get("etag"));
    const returned = await decodeAittaDBRecordResponse(
      response,
      this.recordKey,
      this.maxRecordResponseBytes(),
    );
    if (!equalJson(returned, envelope)) {
      throw new StorageFailure("UNAVAILABLE");
    }
    return returned.current;
  }

  async listSetupHistory(
    request: CampaignSetupHistoryRequest,
  ): Promise<CampaignSetupHistoryPage> {
    const start = parseHistoryRequest(request);
    const stored = await this.readRecord(false);
    if (stored === null) {
      return deepFreeze({ items: [], nextCursor: null });
    }
    if (start > stored.envelope.history.length) {
      throw new StorageFailure("INVALID_REQUEST");
    }

    const items = stored.envelope.history.slice(start, start + request.limit);
    const next = start + items.length;
    return deepFreeze({
      items,
      nextCursor: next < stored.envelope.history.length
        ? (`${HISTORY_CURSOR_PREFIX}${next}` as StorageCursor)
        : null,
    });
  }

  private async readRecord(requireEtag: boolean): Promise<ReadCampaignRecord | null> {
    const response = await this.fetchWithToken(this.recordUrl, {
      method: "GET",
      headers: { Accept: AITTADB_HYPERMEDIA_TYPE },
    });
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404
    ) {
      return null;
    }
    if (response.status !== 200) {
      throw new StorageFailure("UNAVAILABLE");
    }

    const etag = parseStrongEtag(response.headers.get("etag"));
    if (requireEtag && etag === null) {
      throw new StorageFailure("UNAVAILABLE");
    }
    return deepFreeze({
      envelope: await decodeAittaDBRecordResponse(
        response,
        this.recordKey,
        this.maxRecordResponseBytes(),
      ),
      etag,
    });
  }

  private async verifyConditionalWriteCapability(): Promise<void> {
    if (this.conditionalWritesVerified) return;

    let response: Response;
    try {
      response = await this.fetchImplementation(this.openApiUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
    } catch {
      throw new StorageFailure("UNAVAILABLE");
    }
    if (response.status !== 200) {
      throw new StorageFailure("UNAVAILABLE");
    }

    const specification = await readBoundedJson(response, MAX_OPENAPI_BYTES);
    if (!advertisesAtomicRecordPreconditions(specification)) {
      throw new StorageFailure("UNAVAILABLE");
    }
    this.conditionalWritesVerified = true;
  }

  private async fetchWithToken(
    input: string,
    init: RequestInit,
  ): Promise<Response> {
    let token: unknown;
    try {
      token = await this.accessToken();
    } catch {
      throw new StorageFailure("UNAVAILABLE");
    }
    if (
      typeof token !== "string" ||
      !/^[\x21-\x7e]{1,4096}$/.test(token)
    ) {
      throw new StorageFailure("UNAVAILABLE");
    }

    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    try {
      return await this.fetchImplementation(input, { ...init, headers });
    } catch {
      throw new StorageFailure("UNAVAILABLE");
    }
  }

  private maxRecordResponseBytes(): number {
    return this.maxRecordBytes * 2 + 65_536;
  }
}

function parseIssuer(value: unknown): string {
  if (typeof value !== "string") throw new StorageFailure("INVALID_REQUEST");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StorageFailure("INVALID_REQUEST");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return url.origin;
}

function parseRecordKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 240 ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    }) ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return value;
}

function parseMaxRecordBytes(value: number | undefined): number {
  const parsed = value ?? DEFAULT_MAX_RECORD_BYTES;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > DEFAULT_MAX_RECORD_BYTES
  ) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return parsed;
}

function parseExpectedRevision(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) >= Number.MAX_SAFE_INTEGER
  ) {
    return undefined;
  }
  return value as number;
}

function expectedRevisionFor(revision: number): number | null {
  return revision === 1 ? null : revision - 1;
}

function parseHistoryRequest(request: CampaignSetupHistoryRequest): number {
  if (
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > MAX_STORAGE_PAGE_SIZE
  ) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  if (request.cursor === undefined) return 0;
  if (
    typeof request.cursor !== "string" ||
    !request.cursor.startsWith(HISTORY_CURSOR_PREFIX)
  ) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  const serialized = request.cursor.slice(HISTORY_CURSOR_PREFIX.length);
  if (!/^(?:0|[1-9][0-9]*)$/.test(serialized)) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  const offset = Number(serialized);
  if (!Number.isSafeInteger(offset)) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return offset;
}

function serializeBounded(value: unknown, maxBytes: number): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new StorageFailure("INVALID_REQUEST");
  }
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return serialized;
}

async function decodeAittaDBRecordResponse(
  response: Response,
  expectedKey: string,
  maxBytes: number,
): Promise<CampaignConfigurationEnvelope> {
  const document = record(await readBoundedJson(response, maxBytes));
  const data = record(document?.data);
  if (
    document === null ||
    document.api_version !== "0.1" ||
    document.type !== "storage-record" ||
    data === null ||
    !hasExactKeys(data, RECORD_DATA_KEYS) ||
    data.key !== expectedKey ||
    !Number.isSafeInteger(data.created_at) ||
    (data.created_at as number) < 0 ||
    !Number.isSafeInteger(data.updated_at) ||
    (data.updated_at as number) < 0
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return decodeEnvelope(data.value);
}

function decodeEnvelope(value: unknown): CampaignConfigurationEnvelope {
  const source = record(value);
  if (
    source === null ||
    !hasExactKeys(source, ENVELOPE_KEYS) ||
    source.kind !== CAMPAIGN_RECORD_KIND ||
    source.schemaVersion !== CAMPAIGN_RECORD_SCHEMA_VERSION ||
    !Array.isArray(source.history) ||
    source.history.length === 0
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }

  const operationIds = new Set<string>();
  const history = source.history.map((candidate, index) => {
    const revision = decodeRevision(candidate);
    if (
      revision.revision !== index + 1 ||
      operationIds.has(revision.operationId)
    ) {
      throw new StorageFailure("UNAVAILABLE");
    }
    operationIds.add(revision.operationId);
    return revision;
  });
  const current = decodeRevision(source.current);
  const latest = history.at(-1);
  if (latest === undefined || !equalJson(current, latest)) {
    throw new StorageFailure("UNAVAILABLE");
  }

  return deepFreeze({
    kind: CAMPAIGN_RECORD_KIND,
    schemaVersion: CAMPAIGN_RECORD_SCHEMA_VERSION,
    current,
    history,
  });
}

function decodeRevision(value: unknown): CampaignSetupRevision {
  const source = record(value);
  if (
    source === null ||
    !hasExactKeys(source, REVISION_KEYS) ||
    !Number.isSafeInteger(source.revision) ||
    (source.revision as number) < 1
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  const recordedAt = parseTimestamp(source.recordedAt);
  const operationId = parseStorageOperationId(source.operationId);
  const setup = parseCampaignSetup(source.setup);
  if (!recordedAt.ok || !operationId.ok || !setup.ok) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return deepFreeze({
    revision: source.revision as number,
    recordedAt: recordedAt.value,
    operationId: operationId.value,
    setup: setup.value,
  });
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const contentType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    contentType !== "application/json" &&
    contentType !== "application/vnd.aittadb+json"
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)) {
      throw new StorageFailure("UNAVAILABLE");
    }
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > maxBytes) {
      throw new StorageFailure("UNAVAILABLE");
    }
  }

  const bytes = await readBoundedBytes(response, maxBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new StorageFailure("UNAVAILABLE");
  }
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The bounded failure is authoritative even if cancellation fails.
        }
        throw new StorageFailure("UNAVAILABLE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function advertisesAtomicRecordPreconditions(value: unknown): boolean {
  const specification = record(value);
  const paths = record(specification?.paths);
  const item = record(paths?.["/storage/records/{key}"]);
  const read = record(item?.get);
  const write = record(item?.put);
  if (read === null || write === null) return false;

  const parameters = [
    ...(Array.isArray(item?.parameters) ? item.parameters : []),
    ...(Array.isArray(write.parameters) ? write.parameters : []),
  ];
  const responses = record(write.responses);
  return (
    hasHeaderParameter(parameters, "if-match") &&
    hasHeaderParameter(parameters, "if-none-match") &&
    responses !== null &&
    Object.hasOwn(responses, "412") &&
    responseDeclaresHeader(read, "200", "etag") &&
    responseDeclaresHeader(write, "200", "etag")
  );
}

function hasHeaderParameter(
  parameters: readonly unknown[],
  expectedName: string,
): boolean {
  return parameters.some((candidate) => {
    const parameter = record(candidate);
    return parameter?.in === "header" &&
      typeof parameter.name === "string" &&
      parameter.name.toLowerCase() === expectedName;
  });
}

function responseDeclaresHeader(
  operation: Record<string, unknown>,
  status: string,
  expectedName: string,
): boolean {
  const responses = record(operation.responses);
  const response = record(responses?.[status]);
  const headers = record(response?.headers);
  return headers !== null && Object.keys(headers).some(
    (name) => name.toLowerCase() === expectedName,
  );
}

function requireStrongEtag(value: string | null): string {
  const parsed = parseStrongEtag(value);
  if (parsed === null) throw new StorageFailure("UNAVAILABLE");
  return parsed;
}

function parseStrongEtag(value: string | null): string | null {
  return value !== null && /^"[\x21\x23-\x7e]{0,200}"$/.test(value)
    ? value
    : null;
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasExactKeys(
  source: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(source);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
