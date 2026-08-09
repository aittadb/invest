import {
  parseParticipantAccount,
  registerParticipantProfile,
  requestParticipantAccountDeletion,
  updateParticipantProfile,
  withdrawMarketingConsent as withdrawProfileMarketingConsent,
  type AccountDeletionRequestState,
  type MarketingConsent,
  type ParticipantAccount,
  type ParticipantProfile,
  type ParticipantProfileIntent,
} from "../domain/participant-profile.ts";
import {
  parseActorSubject,
  parseTimestamp,
  type ActorSubject,
  type Timestamp,
} from "../domain/foundation.ts";
import {
  StorageFailure,
  parseStorageCollection,
  parseStorageKey,
  parseStorageOperationId,
  type StorageAdapter,
  type StorageCollection,
  type StorageDocument,
  type StorageKey,
  type StorageOperationId,
  type StorageRecord,
} from "../domain/storage-adapter.ts";

const PARTICIPANT_PROFILE_SCHEMA_VERSION = 1;
const PARTICIPANT_PROFILES = storageCollection("private-participant-profiles");
const PARTICIPANT_PROFILE_REVISIONS = storageCollection(
  "private-participant-profile-revisions",
);
const PROFILE_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "subject",
  "profileRevision",
  "profile",
  "lastMutation",
]);
const PROFILE_KEYS = new Set([
  "subject",
  "accountEmailLabel",
  "displayName",
  "country",
  "declaredInterest",
  "participationContext",
  "processEmailNoticeAcknowledgedAt",
  "marketingConsent",
  "accountDeletionRequest",
  "registeredAt",
  "updatedAt",
]);
const LAST_MUTATION_KEYS = new Set([
  "action",
  "operationId",
  "requestHash",
]);
const MUTATION_ACTIONS = new Set<ParticipantMutationAction>([
  "register",
  "update",
  "withdraw-marketing-consent",
  "request-account-deletion",
]);

type ParticipantMutationAction =
  | "register"
  | "update"
  | "withdraw-marketing-consent"
  | "request-account-deletion";

/** The current compare-and-set revision and its immutable profile snapshot. */
export type ParticipantProfileSnapshot = Readonly<{
  revision: number;
  snapshot: ParticipantProfile;
}>;

/** A replay-aware mutation result and any application-level follow-up intents. */
export type ParticipantProfileMutationResult = ParticipantProfileSnapshot &
  Readonly<{
    replayed: boolean;
    intents: readonly ParticipantProfileIntent[];
  }>;

export type RegisterParticipantRequest = Readonly<{
  operationId: unknown;
  expectedRevision: null;
  registeredAt: unknown;
  registration: unknown;
}>;

export type UpdateParticipantRequest = Readonly<{
  operationId: unknown;
  expectedRevision: number;
  updatedAt: unknown;
  changes: unknown;
}>;

export type WithdrawMarketingConsentRequest = Readonly<{
  operationId: unknown;
  expectedRevision: number;
  withdrawnAt: unknown;
}>;

export type RequestParticipantDeletionRequest = Readonly<{
  operationId: unknown;
  expectedRevision: number;
  requestedAt: unknown;
}>;

/** Narrow subject-owned profile, consent, and deletion-intent persistence API. */
export interface ParticipantRepository {
  current(): Promise<ParticipantProfileSnapshot | null>;
  register(
    request: RegisterParticipantRequest,
  ): Promise<ParticipantProfileMutationResult>;
  update(
    request: UpdateParticipantRequest,
  ): Promise<ParticipantProfileMutationResult>;
  withdrawMarketingConsent(
    request: WithdrawMarketingConsentRequest,
  ): Promise<ParticipantProfileMutationResult>;
  requestAccountDeletion(
    request: RequestParticipantDeletionRequest,
  ): Promise<ParticipantProfileMutationResult>;
  pendingDeletionIntent(): Promise<ParticipantProfileIntent | null>;
}

/**
 * Deterministic development repository composed entirely through StorageAdapter.
 * It owns no process-local state and is not a production persistence substitute.
 */
export class DevelopmentInMemoryParticipantRepository
  implements ParticipantRepository
{
  readonly storageKind = "development-in-memory" as const;

  readonly #storage: StorageAdapter;
  readonly #account: ParticipantAccount | null;

  constructor(
    storage: StorageAdapter,
    authenticatedAccount: ParticipantAccount | null,
  ) {
    this.#storage = storage;
    this.#account = authenticatedAccount === null
      ? null
      : requiredParticipantAccount(authenticatedAccount);
  }

  async current(): Promise<ParticipantProfileSnapshot | null> {
    const account = this.#account;
    if (account === null) return null;

    const key = await participantProfileKey(account.subject);
    const record = await this.#storage.read(key);
    if (record === null) return null;
    return decodeCurrentParticipantRecord(record, key, account.subject);
  }

  async register(
    request: RegisterParticipantRequest,
  ): Promise<ParticipantProfileMutationResult> {
    const account = this.#requireAccount();
    if (request.expectedRevision !== null) invalidRequest();
    const operationId = requiredOperationId(request.operationId);
    const registeredAt = requiredTimestamp(request.registeredAt);

    let parsed;
    try {
      parsed = registerParticipantProfile(
        account,
        request.registration,
        registeredAt,
      );
    } catch {
      invalidRequest();
    }
    if (!parsed.ok) invalidRequest();

    const requestHash = await hashMutationRequest({
      action: "register",
      registeredAt,
      registration: request.registration,
    });
    return this.#persist(
      parsed.value,
      operationId,
      null,
      "register",
      requestHash,
    );
  }

  async update(
    request: UpdateParticipantRequest,
  ): Promise<ParticipantProfileMutationResult> {
    this.#requireAccount();
    const operationId = requiredOperationId(request.operationId);
    const expectedRevision = requiredRevision(request.expectedRevision);
    const updatedAt = requiredTimestamp(request.updatedAt);
    const base = await this.#requireRevision(expectedRevision);
    requireNondecreasingTime(base.snapshot.updatedAt, updatedAt);

    let parsed;
    try {
      parsed = updateParticipantProfile(
        base.snapshot,
        request.changes,
        updatedAt,
      );
    } catch {
      invalidRequest();
    }
    if (!parsed.ok) invalidRequest();

    const requestHash = await hashMutationRequest({
      action: "update",
      updatedAt,
      changes: request.changes,
    });
    return this.#persist(
      parsed.value,
      operationId,
      expectedRevision,
      "update",
      requestHash,
    );
  }

  async withdrawMarketingConsent(
    request: WithdrawMarketingConsentRequest,
  ): Promise<ParticipantProfileMutationResult> {
    this.#requireAccount();
    const operationId = requiredOperationId(request.operationId);
    const expectedRevision = requiredRevision(request.expectedRevision);
    const withdrawnAt = requiredTimestamp(request.withdrawnAt);
    const base = await this.#requireRevision(expectedRevision);
    requireNondecreasingTime(base.snapshot.updatedAt, withdrawnAt);

    const profile = withdrawProfileMarketingConsent(
      base.snapshot,
      withdrawnAt,
    );
    const requestHash = await hashMutationRequest({
      action: "withdraw-marketing-consent",
      withdrawnAt,
    });
    return this.#persist(
      profile,
      operationId,
      expectedRevision,
      "withdraw-marketing-consent",
      requestHash,
    );
  }

  async requestAccountDeletion(
    request: RequestParticipantDeletionRequest,
  ): Promise<ParticipantProfileMutationResult> {
    this.#requireAccount();
    const operationId = requiredOperationId(request.operationId);
    const expectedRevision = requiredRevision(request.expectedRevision);
    const requestedAt = requiredTimestamp(request.requestedAt);
    const base = await this.#requireRevision(expectedRevision);
    requireNondecreasingTime(base.snapshot.updatedAt, requestedAt);

    const transition = requestParticipantAccountDeletion(
      base.snapshot,
      requestedAt,
    );
    const requestHash = await hashMutationRequest({
      action: "request-account-deletion",
      requestedAt,
    });
    const persisted = await this.#persist(
      transition.profile,
      operationId,
      expectedRevision,
      "request-account-deletion",
      requestHash,
    );
    const intent = deletionIntentFromProfile(persisted.snapshot);
    if (intent === null) unavailable();
    return mutationResult(
      persisted.revision,
      persisted.snapshot,
      persisted.replayed,
      [intent],
    );
  }

  async pendingDeletionIntent(): Promise<ParticipantProfileIntent | null> {
    const current = await this.current();
    return current === null ? null : deletionIntentFromProfile(current.snapshot);
  }

  async #requireRevision(revision: number): Promise<ParticipantProfileSnapshot> {
    const account = this.#requireAccount();
    const key = await participantProfileRevisionKey(account.subject, revision);
    const record = await this.#storage.read(key);
    if (record === null) notFound();
    const decoded = decodeHistoricalParticipantRecord(
      record,
      key,
      account.subject,
      revision,
    );
    if (decoded === null) notFound();
    return decoded;
  }

  #requireAccount(): ParticipantAccount {
    if (this.#account === null) notFound();
    return this.#account;
  }

  async #persist(
    profile: ParticipantProfile,
    operationId: StorageOperationId,
    expectedRevision: number | null,
    action: ParticipantMutationAction,
    requestHash: string,
  ): Promise<ParticipantProfileMutationResult> {
    const account = this.#requireAccount();
    if (profile.subject !== account.subject) notFound();
    const key = await participantProfileKey(account.subject);
    const nextRevision = nextProfileRevision(expectedRevision);
    const historyKey = await participantProfileRevisionKey(
      account.subject,
      nextRevision,
    );
    const value = participantProfileDocument(
      profile,
      nextRevision,
      action,
      operationId,
      requestHash,
    );
    const result = await this.#storage.transact({
      operationId,
      mutations: [
        {
          type: "put",
          key,
          expectedRevision,
          value,
        },
        {
          type: "put",
          key: historyKey,
          expectedRevision: null,
          value,
        },
      ],
    });

    const currentRecord = result.records[0];
    const historyRecord = result.records[1];
    if (
      currentRecord === null ||
      currentRecord === undefined ||
      historyRecord === null ||
      historyRecord === undefined
    ) {
      unavailable();
    }
    const decoded = decodeCurrentParticipantRecord(
      currentRecord,
      key,
      account.subject,
    );
    const history = decodeHistoricalParticipantRecord(
      historyRecord,
      historyKey,
      account.subject,
      nextRevision,
    );
    if (
      decoded === null ||
      history === null ||
      JSON.stringify(decoded) !== JSON.stringify(history)
    ) {
      unavailable();
    }
    return mutationResult(
      decoded.revision,
      decoded.snapshot,
      result.replayed,
      [],
    );
  }
}

function participantProfileDocument(
  profile: ParticipantProfile,
  profileRevision: number,
  action: ParticipantMutationAction,
  operationId: StorageOperationId,
  requestHash: string,
): StorageDocument {
  return deepFreeze({
    kind: "participant-profile",
    schemaVersion: PARTICIPANT_PROFILE_SCHEMA_VERSION,
    subject: profile.subject,
    profileRevision,
    profile: {
      subject: profile.subject,
      accountEmailLabel: profile.accountEmailLabel,
      displayName: profile.displayName,
      country: profile.country,
      declaredInterest: profile.declaredInterest,
      participationContext: profile.participationContext,
      processEmailNoticeAcknowledgedAt:
        profile.processEmailNoticeAcknowledgedAt,
      marketingConsent: marketingConsentDocument(profile.marketingConsent),
      accountDeletionRequest: deletionRequestDocument(
        profile.accountDeletionRequest,
      ),
      registeredAt: profile.registeredAt,
      updatedAt: profile.updatedAt,
    },
    lastMutation: { action, operationId, requestHash },
  });
}

function marketingConsentDocument(consent: MarketingConsent): StorageDocument {
  if (consent.state === "not-granted") return { state: consent.state };
  if (consent.state === "granted") {
    return { state: consent.state, grantedAt: consent.grantedAt };
  }
  return {
    state: consent.state,
    ...(consent.grantedAt === undefined ? {} : { grantedAt: consent.grantedAt }),
    withdrawnAt: consent.withdrawnAt,
  };
}

function deletionRequestDocument(
  request: AccountDeletionRequestState,
): StorageDocument {
  return request.state === "not-requested"
    ? { state: request.state }
    : {
        state: request.state,
        requestedAt: request.requestedAt,
        activeInterestDisposition: request.activeInterestDisposition,
      };
}

function decodeCurrentParticipantRecord(
  record: StorageRecord,
  expectedKey: StorageKey,
  trustedSubject: ActorSubject,
): ParticipantProfileSnapshot | null {
  return decodeParticipantRecord(
    record,
    expectedKey,
    trustedSubject,
    record.revision,
    record.revision,
  );
}

function decodeHistoricalParticipantRecord(
  record: StorageRecord,
  expectedKey: StorageKey,
  trustedSubject: ActorSubject,
  expectedProfileRevision: number,
): ParticipantProfileSnapshot | null {
  return decodeParticipantRecord(
    record,
    expectedKey,
    trustedSubject,
    expectedProfileRevision,
    1,
  );
}

function decodeParticipantRecord(
  record: StorageRecord,
  expectedKey: StorageKey,
  trustedSubject: ActorSubject,
  expectedProfileRevision: number,
  expectedStorageRevision: number,
): ParticipantProfileSnapshot | null {
  if (
    record.key.collection !== expectedKey.collection ||
    record.key.id !== expectedKey.id ||
    !Number.isSafeInteger(record.revision) ||
    record.revision !== expectedStorageRevision
  ) {
    unavailable();
  }

  const source = objectRecord(record.value);
  if (
    source === null ||
    !hasExactKeys(source, PROFILE_DOCUMENT_KEYS) ||
    source.kind !== "participant-profile" ||
    source.schemaVersion !== PARTICIPANT_PROFILE_SCHEMA_VERSION ||
    !Number.isSafeInteger(source.profileRevision) ||
    source.profileRevision !== expectedProfileRevision
  ) {
    unavailable();
  }

  const outerSubject = parseActorSubject(source.subject);
  if (!outerSubject.ok) unavailable();
  if (outerSubject.value !== trustedSubject) return null;
  validateLastMutation(source.lastMutation);

  const profile = decodeParticipantProfile(source.profile, trustedSubject);
  return profile === null
    ? null
    : profileSnapshot(expectedProfileRevision, profile);
}

function decodeParticipantProfile(
  value: unknown,
  trustedSubject: ActorSubject,
): ParticipantProfile | null {
  const source = objectRecord(value);
  if (source === null || !hasExactKeys(source, PROFILE_KEYS)) unavailable();

  const account = parseParticipantAccount({
    subject: source.subject,
    accountEmailLabel: source.accountEmailLabel,
  });
  if (!account.ok) unavailable();
  if (account.value.subject !== trustedSubject) return null;

  const registeredAt = requiredStoredTimestamp(source.registeredAt);
  const processAcknowledgedAt = requiredStoredTimestamp(
    source.processEmailNoticeAcknowledgedAt,
  );
  const updatedAt = requiredStoredTimestamp(source.updatedAt);
  if (processAcknowledgedAt !== registeredAt || updatedAt < registeredAt) {
    unavailable();
  }

  const marketingConsent = decodeMarketingConsent(
    source.marketingConsent,
    registeredAt,
  );
  const accountDeletionRequest = decodeDeletionRequest(
    source.accountDeletionRequest,
    registeredAt,
  );
  const latestStateTimestamp = latestTimestamp(
    registeredAt,
    marketingConsent.state === "withdrawn"
      ? marketingConsent.withdrawnAt
      : marketingConsent.state === "granted"
        ? marketingConsent.grantedAt
        : registeredAt,
    accountDeletionRequest.state === "requested"
      ? accountDeletionRequest.requestedAt
      : registeredAt,
  );
  if (updatedAt < latestStateTimestamp) unavailable();

  const registration = registerParticipantProfile(
    account.value,
    {
      displayName: source.displayName,
      country: source.country,
      declaredInterest: source.declaredInterest,
      participationContext: source.participationContext,
      processEmailNoticeAcknowledged: true,
      marketingConsent:
        marketingConsent.state === "granted" ||
        (marketingConsent.state === "withdrawn" &&
          marketingConsent.grantedAt !== undefined),
    },
    registeredAt,
  );
  if (!registration.ok) unavailable();
  if (
    registration.value.displayName !== source.displayName ||
    registration.value.country !== source.country ||
    registration.value.declaredInterest !== source.declaredInterest ||
    registration.value.participationContext !== source.participationContext
  ) {
    unavailable();
  }

  return deepFreeze({
    ...registration.value,
    marketingConsent,
    accountDeletionRequest,
    updatedAt,
  });
}

function decodeMarketingConsent(
  value: unknown,
  registeredAt: Timestamp,
): MarketingConsent {
  const source = objectRecord(value);
  if (source === null || typeof source.state !== "string") unavailable();

  if (source.state === "not-granted") {
    if (!hasExactKeys(source, new Set(["state"]))) unavailable();
    return deepFreeze({ state: "not-granted" });
  }
  if (source.state === "granted") {
    if (!hasExactKeys(source, new Set(["state", "grantedAt"]))) unavailable();
    const grantedAt = requiredStoredTimestamp(source.grantedAt);
    if (grantedAt !== registeredAt) unavailable();
    return deepFreeze({ state: "granted", grantedAt });
  }
  if (source.state === "withdrawn") {
    const expectedKeys = source.grantedAt === undefined
      ? new Set(["state", "withdrawnAt"])
      : new Set(["state", "grantedAt", "withdrawnAt"]);
    if (!hasExactKeys(source, expectedKeys)) unavailable();
    const withdrawnAt = requiredStoredTimestamp(source.withdrawnAt);
    const grantedAt = source.grantedAt === undefined
      ? undefined
      : requiredStoredTimestamp(source.grantedAt);
    if (
      (grantedAt !== undefined && grantedAt !== registeredAt) ||
      withdrawnAt < (grantedAt ?? registeredAt)
    ) {
      unavailable();
    }
    return deepFreeze({
      state: "withdrawn",
      ...(grantedAt === undefined ? {} : { grantedAt }),
      withdrawnAt,
    });
  }
  unavailable();
}

function decodeDeletionRequest(
  value: unknown,
  registeredAt: Timestamp,
): AccountDeletionRequestState {
  const source = objectRecord(value);
  if (source === null || typeof source.state !== "string") unavailable();
  if (source.state === "not-requested") {
    if (!hasExactKeys(source, new Set(["state"]))) unavailable();
    return deepFreeze({ state: "not-requested" });
  }
  if (source.state !== "requested") unavailable();
  if (
    !hasExactKeys(
      source,
      new Set(["state", "requestedAt", "activeInterestDisposition"]),
    ) ||
    source.activeInterestDisposition !== "withdraw"
  ) {
    unavailable();
  }
  const requestedAt = requiredStoredTimestamp(source.requestedAt);
  if (requestedAt < registeredAt) unavailable();
  return deepFreeze({
    state: "requested",
    requestedAt,
    activeInterestDisposition: "withdraw",
  });
}

function validateLastMutation(value: unknown): void {
  const source = objectRecord(value);
  if (
    source === null ||
    !hasExactKeys(source, LAST_MUTATION_KEYS) ||
    typeof source.action !== "string" ||
    !MUTATION_ACTIONS.has(source.action as ParticipantMutationAction) ||
    typeof source.requestHash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(source.requestHash)
  ) {
    unavailable();
  }
  const operationId = parseStorageOperationId(source.operationId);
  if (!operationId.ok) unavailable();
}

function deletionIntentFromProfile(
  profile: ParticipantProfile,
): ParticipantProfileIntent | null {
  const request = profile.accountDeletionRequest;
  return request.state === "not-requested"
    ? null
    : deepFreeze({
        type: "withdraw-active-interest",
        subject: profile.subject,
        reason: "account-deletion-request",
        requestedAt: request.requestedAt,
      });
}

async function participantProfileKey(subject: ActorSubject): Promise<StorageKey> {
  return hashedParticipantStorageKey(
    PARTICIPANT_PROFILES,
    "participant-profile",
    subject,
  );
}

async function participantProfileRevisionKey(
  subject: ActorSubject,
  revision: number,
): Promise<StorageKey> {
  return hashedParticipantStorageKey(
    PARTICIPANT_PROFILE_REVISIONS,
    "participant-profile-revision",
    `${subject}\u0000${String(revision).padStart(16, "0")}`,
  );
}

async function hashedParticipantStorageKey(
  collection: StorageCollection,
  namespace: string,
  value: string,
): Promise<StorageKey> {
  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${namespace}\u0000${value}`),
    );
  } catch {
    unavailable();
  }
  const id = `subject:${hexadecimal(digest)}`;
  const parsed = parseStorageKey(collection, id);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

async function hashMutationRequest(value: unknown): Promise<string> {
  let serialized: string;
  try {
    serialized = canonicalJson(value);
  } catch {
    invalidRequest();
  }

  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(serialized),
    );
  } catch {
    unavailable();
  }
  return `sha256:${hexadecimal(digest)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const source = objectRecord(value);
  if (source === null) throw new TypeError("Unsupported request value.");
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
    .join(",")}}`;
}

function hexadecimal(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function requiredParticipantAccount(value: unknown): ParticipantAccount {
  const parsed = parseParticipantAccount(value);
  if (!parsed.ok) invalidRequest();
  return deepFreeze(parsed.value);
}

function requiredOperationId(value: unknown): StorageOperationId {
  const parsed = parseStorageOperationId(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function requiredTimestamp(value: unknown): Timestamp {
  const parsed = parseTimestamp(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function requiredStoredTimestamp(value: unknown): Timestamp {
  const parsed = parseTimestamp(value);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function requiredRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalidRequest();
  return value as number;
}

function nextProfileRevision(expectedRevision: number | null): number {
  if (expectedRevision === null) return 1;
  if (expectedRevision >= Number.MAX_SAFE_INTEGER) invalidRequest();
  return expectedRevision + 1;
}

function requireNondecreasingTime(previous: Timestamp, next: Timestamp): void {
  if (next < previous) invalidRequest();
}

function latestTimestamp(...values: readonly Timestamp[]): Timestamp {
  return values.reduce((latest, value) => value > latest ? value : latest);
}

function storageCollection(value: string): StorageCollection {
  const parsed = parseStorageCollection(value);
  if (!parsed.ok) throw new Error("Invalid participant repository collection.");
  return parsed.value;
}

function hasExactKeys(
  source: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(source);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function profileSnapshot(
  revision: number,
  snapshot: ParticipantProfile,
): ParticipantProfileSnapshot {
  return deepFreeze({ revision, snapshot });
}

function mutationResult(
  revision: number,
  snapshot: ParticipantProfile,
  replayed: boolean,
  intents: readonly ParticipantProfileIntent[],
): ParticipantProfileMutationResult {
  return deepFreeze({ revision, snapshot, replayed, intents: [...intents] });
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function invalidRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
}

function notFound(): never {
  throw new StorageFailure("NOT_FOUND");
}

function unavailable(): never {
  throw new StorageFailure("UNAVAILABLE");
}
