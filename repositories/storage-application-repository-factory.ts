import { parseTimestamp } from "../domain/foundation.ts";
import {
  StorageFailure,
  parseStorageCollection,
  parseStorageKey,
  parseStorageOperationId,
  type StorageAdapter,
  type StorageCollection,
  type StorageDocument,
  type StorageKey,
  type StorageRecord,
} from "../domain/storage-adapter.ts";
import type {
  BrowserMutationReplayClaim,
  BrowserMutationReplayClaimer,
} from "../http/browser-mutation-session.ts";
import {
  StorageCampaignRepository,
  StoragePublicCampaignPresentationReader,
  type AtomicCampaignAuditRepository,
  type PublicCampaignPresentationReader,
} from "./in-memory-campaign-repository.ts";

const REPLAY_SCHEMA_VERSION = 1;
const REPLAY_COLLECTION = storageCollection("browser-mutation-replays");
const REPLAY_CAPABILITY_PATTERN =
  /^browser-mutation:v1:[A-Za-z0-9_-]{43}$/u;
const MAX_REPLAY_TTL_SECONDS = 600;

/**
 * Factory for production repository capabilities backed by one credential-bound
 * StorageAdapter. Feature builders are supplied only by their own production
 * wiring task after that repository contract is proven.
 */
export class StorageApplicationRepositoryFactory {
  readonly #claimBrowserMutationReplay: BrowserMutationReplayClaimer;
  readonly #campaignRepository: AtomicCampaignAuditRepository;
  readonly #publicCampaignReader: PublicCampaignPresentationReader;

  constructor(storage: StorageAdapter, now: () => Date) {
    const adapter = requiredStorageAdapter(storage);
    const clock = requiredClock(now);
    this.#claimBrowserMutationReplay = Object.freeze(
      (claim: BrowserMutationReplayClaim) => claimReplay(adapter, clock, claim),
    );
    this.#campaignRepository = new StorageCampaignRepository(adapter);
    this.#publicCampaignReader = new StoragePublicCampaignPresentationReader(
      adapter,
    );
    Object.freeze(this);
  }

  browserMutationReplayClaimer(): BrowserMutationReplayClaimer {
    return this.#claimBrowserMutationReplay;
  }

  campaignRepository(): AtomicCampaignAuditRepository {
    return this.#campaignRepository;
  }

  publicCampaignReader(): PublicCampaignPresentationReader {
    return this.#publicCampaignReader;
  }
}

async function claimReplay(
  storage: StorageAdapter,
  now: () => Date,
  claim: BrowserMutationReplayClaim,
): Promise<boolean> {
  const prepared = replayRecord(claim, now);
  let result: Awaited<ReturnType<StorageAdapter["transact"]>>;
  try {
    result = await storage.transact({
      operationId: prepared.operationId,
      mutations: [{
        type: "put",
        key: prepared.key,
        expectedRevision: null,
        value: prepared.value,
      }],
    });
  } catch (error) {
    if (
      error instanceof StorageFailure &&
      (error.code === "CONFLICT" || error.code === "PRECONDITION_FAILED")
    ) {
      return false;
    }
    if (error instanceof StorageFailure) throw new StorageFailure(error.code);
    unavailable();
  }

  const claimed = replayClaimed(result, prepared.key, prepared.value);
  if (claimed === null) unavailable();
  return claimed;
}

function replayRecord(
  claim: BrowserMutationReplayClaim,
  now: () => Date,
): Readonly<{
  operationId: ReturnType<typeof requiredOperationId>;
  key: StorageKey;
  value: StorageDocument;
}> {
  const source = exactDataObject(claim, ["capabilityId", "expiresAt"]);
  if (
    source === null ||
    typeof source.capabilityId !== "string" ||
    !REPLAY_CAPABILITY_PATTERN.test(source.capabilityId)
  ) {
    invalidRequest();
  }
  const expiresAt = parseTimestamp(source.expiresAt);
  if (!expiresAt.ok) invalidRequest();
  const current = currentTime(now);
  const expiry = new Date(expiresAt.value).valueOf();
  if (
    !Number.isSafeInteger(expiry) ||
    expiry <= current ||
    expiry > current + MAX_REPLAY_TTL_SECONDS * 1_000
  ) {
    invalidRequest();
  }
  const operationId = requiredOperationId(source.capabilityId);
  const key = requiredStorageKey(REPLAY_COLLECTION, source.capabilityId);
  const value = Object.freeze({
    schemaVersion: REPLAY_SCHEMA_VERSION,
    expiresAt: expiresAt.value,
  });
  return Object.freeze({ operationId, key, value });
}

function replayClaimed(
  result: unknown,
  key: StorageKey,
  value: StorageDocument,
): boolean | null {
  try {
    const source = exactDataObject(result, ["replayed", "records"]);
    if (source === null) return null;
    const replayed = source.replayed;
    const records = exactSingleElementArray(source.records);
    if (
      typeof replayed !== "boolean" ||
      records === null
    ) {
      return null;
    }
    const record = records[0];
    return validReplayRecord(record, key, value) ? !replayed : null;
  } catch {
    return null;
  }
}

function validReplayRecord(
  value: unknown,
  key: StorageKey,
  expectedValue: StorageDocument,
): value is StorageRecord {
  const record = exactDataObject(value, ["key", "revision", "value"]);
  if (record === null || record.revision !== 1) return false;
  const recordKey = exactDataObject(record.key, ["collection", "id"]);
  const recordValue = exactDataObject(record.value, [
    "schemaVersion",
    "expiresAt",
  ]);
  if (recordKey === null || recordValue === null) return false;
  if (
    recordKey.collection !== key.collection ||
    recordKey.id !== key.id
  ) {
    return false;
  }
  return exactReplayValue(recordValue, expectedValue);
}

function exactReplayValue(
  value: Readonly<Record<string, unknown>>,
  expected: StorageDocument,
): boolean {
  return value.schemaVersion === expected.schemaVersion &&
    value.expiresAt === expected.expiresAt;
}

function exactDataObject(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      return null;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) =>
        typeof key !== "string" || !expectedKeys.includes(key)
      )
    ) {
      return null;
    }
    const result: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        return null;
      }
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch {
    return null;
  }
}

function exactSingleElementArray(
  value: unknown,
): readonly [unknown] | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("0") ||
    !keys.includes("length")
  ) {
    return null;
  }
  const element = Object.getOwnPropertyDescriptor(value, "0");
  if (
    element === undefined ||
    !element.enumerable ||
    !("value" in element)
  ) {
    return null;
  }
  return Object.freeze([element.value]);
}

function requiredStorageAdapter(value: StorageAdapter): StorageAdapter {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof value.read !== "function" ||
      typeof value.list !== "function" ||
      typeof value.transact !== "function"
    ) {
      invalidRequest();
    }
    return value;
  } catch {
    invalidRequest();
  }
}

function requiredClock(value: () => Date): () => Date {
  if (typeof value !== "function") invalidRequest();
  return value;
}

function currentTime(now: () => Date): number {
  let value: Date;
  try {
    value = now();
  } catch {
    unavailable();
  }
  const milliseconds = value instanceof Date ? value.valueOf() : Number.NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) unavailable();
  return milliseconds;
}

function requiredOperationId(value: string) {
  const parsed = parseStorageOperationId(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function requiredStorageKey(
  collection: StorageCollection,
  id: string,
): StorageKey {
  const parsed = parseStorageKey(collection, id);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function storageCollection(value: string): StorageCollection {
  const parsed = parseStorageCollection(value);
  if (!parsed.ok) throw new Error("Invalid application repository collection.");
  return parsed.value;
}

function invalidRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
}

function unavailable(): never {
  throw new StorageFailure("UNAVAILABLE");
}
