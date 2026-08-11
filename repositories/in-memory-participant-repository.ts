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
  defineParticipantRegistrationNoticeEvidence,
  parseParticipantRegistrationNoticeEvidenceVersion,
  type ParticipantRegistrationNoticeEvidence,
} from "../domain/participant-registration-notice-evidence.ts";
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
const PARTICIPANT_PROFILE_STORAGE_LIMITS = Object.freeze({
  maxRecordBytes: 30_000,
  maxTransactionBytes: 65_536,
  maxTransactionEnvelopeBytes: 1_024,
  maxNodes: 64,
  maxDepth: 8,
});
const MAX_PARTICIPANT_PROFILE_TRANSACTION_INPUT_BYTES =
  PARTICIPANT_PROFILE_STORAGE_LIMITS.maxTransactionBytes -
  PARTICIPANT_PROFILE_STORAGE_LIMITS.maxTransactionEnvelopeBytes;
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
  "registrationNoticeEvidence",
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
const STORAGE_RECORD_KEYS = ["key", "revision", "value"] as const;
const STORAGE_KEY_KEYS = ["collection", "id"] as const;
const TRANSACTION_RESULT_KEYS = ["replayed", "records"] as const;
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

type ParticipantMutationEvidence = Readonly<{
  action: ParticipantMutationAction;
  operationId: StorageOperationId;
  requestHash: string;
}>;

type VerifiedParticipantMutationBase = Readonly<{
  expected: ParticipantProfileSnapshot;
  currentRevision: number;
}>;

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
  noticeEvidence: unknown;
}>;

export type RecoverParticipantRegistrationRequest = Readonly<{
  operationId: unknown;
  registration: unknown;
  noticeEvidenceVersion: unknown;
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

/** Registration-only extension for stale-policy exact-retry recovery. */
export interface ParticipantRegistrationRepository
  extends ParticipantRepository {
  recoverRegistration(
    request: RecoverParticipantRegistrationRequest,
  ): Promise<ParticipantProfileMutationResult>;
}

/** Subject-bound participant persistence over a credential-bound StorageAdapter. */
export class StorageParticipantRepository
  implements ParticipantRegistrationRepository {
  readonly storageKind = "storage-adapter" as const;

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
    const record = await storageRead(this.#storage, key);
    if (record === null) return null;
    const current = decodeCurrentParticipantRecord(
      record,
      key,
      account.subject,
    );
    if (current === null) return null;

    const historyKey = await participantProfileRevisionKey(
      account.subject,
      current.revision,
    );
    const historyRecord = await storageRead(this.#storage, historyKey);
    if (historyRecord === null) unavailable();
    const history = decodeHistoricalParticipantRecord(
      historyRecord,
      historyKey,
      account.subject,
      current.revision,
    );
    if (history === null || !equalData(current, history)) unavailable();

    if (current.revision > 1) {
      const registrationKey = await participantProfileRevisionKey(
        account.subject,
        1,
      );
      const registrationRecord = await storageRead(
        this.#storage,
        registrationKey,
      );
      if (registrationRecord === null) unavailable();
      const registration = decodeHistoricalParticipantRecord(
        registrationRecord,
        registrationKey,
        account.subject,
        1,
      );
      if (
        registration === null ||
        !equalData(
          current.snapshot.registrationNoticeEvidence,
          registration.snapshot.registrationNoticeEvidence,
        )
      ) {
        unavailable();
      }
    }
    return current;
  }

  async register(
    request: RegisterParticipantRequest,
  ): Promise<ParticipantProfileMutationResult> {
    const account = this.#requireAccount();
    if (request.expectedRevision !== null) invalidRequest();
    const operationId = requiredOperationId(request.operationId);
    const registeredAt = requiredTimestamp(request.registeredAt);
    const noticeEvidence = requiredNoticeEvidence(request.noticeEvidence);

    let parsed;
    try {
      parsed = registerParticipantProfile(
        account,
        request.registration,
        registeredAt,
        noticeEvidence,
      );
    } catch {
      invalidRequest();
    }
    if (!parsed.ok) invalidRequest();

    const requestHash = await hashMutationRequest({
      action: "register",
      registration: request.registration,
      noticeEvidence,
    });
    return this.#persist(
      parsed.value,
      operationId,
      null,
      "register",
      requestHash,
      null,
    );
  }

  async recoverRegistration(
    request: RecoverParticipantRegistrationRequest,
  ): Promise<ParticipantProfileMutationResult> {
    const account = this.#requireAccount();
    const operationId = requiredOperationId(request.operationId);
    const submittedEvidence = parseParticipantRegistrationNoticeEvidenceVersion(
      request.noticeEvidenceVersion,
    );
    if (submittedEvidence === null) invalidRequest();

    const historyKey = await participantProfileRevisionKey(account.subject, 1);
    const record = await storageRead(this.#storage, historyKey);
    if (record === null) preconditionFailed();
    const replay = decodeHistoricalParticipantRecord(
      record,
      historyKey,
      account.subject,
      1,
    );
    if (replay === null) preconditionFailed();

    const noticeEvidence = replay.snapshot.registrationNoticeEvidence;
    if (noticeEvidence.version !== submittedEvidence.version) {
      preconditionFailed();
    }
    let parsed;
    try {
      parsed = registerParticipantProfile(
        account,
        request.registration,
        replay.snapshot.registeredAt,
        noticeEvidence,
      );
    } catch {
      invalidRequest();
    }
    if (!parsed.ok) invalidRequest();

    const requestHash = await hashMutationRequest({
      action: "register",
      registration: request.registration,
      noticeEvidence,
    });
    const stored = snapshotStorageRecord(record);
    const mutationEvidence = participantMutationEvidence(stored.value);
    const expectedValue = boundedParticipantProfileDocument(
      parsed.value,
      1,
      "register",
      operationId,
      requestHash,
    );
    if (
      mutationEvidence.operationId !== operationId ||
      mutationEvidence.action !== "register" ||
      mutationEvidence.requestHash !== requestHash ||
      !equalData(stored.value, expectedValue)
    ) {
      throw new StorageFailure("CONFLICT");
    }
    return mutationResult(replay.revision, replay.snapshot, true, []);
  }

  async update(
    request: UpdateParticipantRequest,
  ): Promise<ParticipantProfileMutationResult> {
    this.#requireAccount();
    const operationId = requiredOperationId(request.operationId);
    const expectedRevision = requiredRevision(request.expectedRevision);
    const updatedAt = requiredTimestamp(request.updatedAt);
    const base = await this.#requireMutationBase(expectedRevision);
    requireNondecreasingTime(base.expected.snapshot.updatedAt, updatedAt);

    let parsed;
    try {
      parsed = updateParticipantProfile(
        base.expected.snapshot,
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
      base.currentRevision,
    );
  }

  async withdrawMarketingConsent(
    request: WithdrawMarketingConsentRequest,
  ): Promise<ParticipantProfileMutationResult> {
    this.#requireAccount();
    const operationId = requiredOperationId(request.operationId);
    const expectedRevision = requiredRevision(request.expectedRevision);
    const withdrawnAt = requiredTimestamp(request.withdrawnAt);
    const base = await this.#requireMutationBase(expectedRevision);
    requireNondecreasingTime(base.expected.snapshot.updatedAt, withdrawnAt);

    const profile = withdrawProfileMarketingConsent(
      base.expected.snapshot,
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
      base.currentRevision,
    );
  }

  async requestAccountDeletion(
    request: RequestParticipantDeletionRequest,
  ): Promise<ParticipantProfileMutationResult> {
    this.#requireAccount();
    const operationId = requiredOperationId(request.operationId);
    const expectedRevision = requiredRevision(request.expectedRevision);
    const requestedAt = requiredTimestamp(request.requestedAt);
    const base = await this.#requireMutationBase(expectedRevision);
    requireNondecreasingTime(base.expected.snapshot.updatedAt, requestedAt);

    const transition = requestParticipantAccountDeletion(
      base.expected.snapshot,
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
      base.currentRevision,
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

  async #requireMutationBase(
    revision: number,
  ): Promise<VerifiedParticipantMutationBase> {
    const account = this.#requireAccount();
    const key = await participantProfileRevisionKey(account.subject, revision);
    const record = await storageRead(this.#storage, key);
    if (record === null) notFound();
    const decoded = decodeHistoricalParticipantRecord(
      record,
      key,
      account.subject,
      revision,
    );
    if (decoded === null) notFound();

    const current = await this.current();
    if (current === null) notFound();
    if (current.revision < revision) unavailable();
    if (current.revision === revision && !equalData(current, decoded)) {
      unavailable();
    }
    return deepFreeze({
      expected: decoded,
      currentRevision: current.revision,
    });
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
    verifiedCurrentRevision: number | null,
  ): Promise<ParticipantProfileMutationResult> {
    const account = this.#requireAccount();
    if (profile.subject !== account.subject) notFound();
    const key = await participantProfileKey(account.subject);
    const nextRevision = nextProfileRevision(expectedRevision);
    const historyKey = await participantProfileRevisionKey(
      account.subject,
      nextRevision,
    );
    const value = boundedParticipantProfileDocument(
      profile,
      nextRevision,
      action,
      operationId,
      requestHash,
    );
    if (expectedRevision !== null) {
      if (verifiedCurrentRevision === null) unavailable();
      if (verifiedCurrentRevision < expectedRevision) unavailable();
      if (verifiedCurrentRevision > expectedRevision) {
        await this.#requireExactReplay(
          historyKey,
          account.subject,
          nextRevision,
          operationId,
          action,
          requestHash,
          value,
        );
      }
    }
    let result: unknown;
    try {
      const transaction = boundedParticipantTransaction({
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
      result = await storageTransact(this.#storage, transaction);
    } catch (error) {
      if (
        expectedRevision === null &&
        action === "register" &&
        isReplayConflict(error)
      ) {
        return this.#recoverRegistrationReplay(
          historyKey,
          account.subject,
          operationId,
          requestHash,
          error.code,
        );
      }
      throw error;
    }
    const verified = verifyParticipantTransactionResult(result, [
      { key, revision: nextRevision, value },
      { key: historyKey, revision: 1, value },
    ]);
    const [currentRecord, historyRecord] = verified.records;
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
      !equalData(decoded, history)
    ) {
      unavailable();
    }
    return mutationResult(
      decoded.revision,
      decoded.snapshot,
      verified.replayed,
      [],
    );
  }

  async #requireExactReplay(
    historyKey: StorageKey,
    subject: ActorSubject,
    revision: number,
    operationId: StorageOperationId,
    action: ParticipantMutationAction,
    requestHash: string,
    expectedValue: StorageDocument,
  ): Promise<void> {
    const record = await storageRead(this.#storage, historyKey);
    if (record === null) unavailable();
    const replay = decodeHistoricalParticipantRecord(
      record,
      historyKey,
      subject,
      revision,
    );
    if (replay === null) unavailable();

    const stored = snapshotStorageRecord(record);
    const evidence = participantMutationEvidence(stored.value);
    if (evidence.operationId !== operationId) preconditionFailed();
    if (
      evidence.action !== action ||
      evidence.requestHash !== requestHash ||
      !equalData(stored.value, expectedValue)
    ) {
      throw new StorageFailure("CONFLICT");
    }
  }

  async #recoverRegistrationReplay(
    historyKey: StorageKey,
    subject: ActorSubject,
    operationId: StorageOperationId,
    requestHash: string,
    fallbackCode: "CONFLICT" | "PRECONDITION_FAILED",
  ): Promise<ParticipantProfileMutationResult> {
    const record = await storageRead(this.#storage, historyKey);
    if (record === null) throw new StorageFailure(fallbackCode);
    const replay = decodeHistoricalParticipantRecord(
      record,
      historyKey,
      subject,
      1,
    );
    if (replay === null) unavailable();

    const evidence = participantMutationEvidence(
      snapshotStorageRecord(record).value,
    );
    if (evidence.operationId !== operationId) {
      throw new StorageFailure("CONFLICT");
    }
    if (evidence.action !== "register" || evidence.requestHash !== requestHash) {
      throw new StorageFailure("CONFLICT");
    }
    return mutationResult(replay.revision, replay.snapshot, true, []);
  }
}

/** Compatibility name retained for existing local development composition. */
export {
  StorageParticipantRepository as DevelopmentInMemoryParticipantRepository,
};

type ExpectedParticipantStorageRecord = Readonly<{
  key: StorageKey;
  revision: number;
  value: StorageDocument;
}>;

type VerifiedParticipantTransactionResult = Readonly<{
  replayed: boolean;
  records: readonly [StorageRecord, StorageRecord];
}>;

async function storageRead(
  storage: StorageAdapter,
  key: StorageKey,
): Promise<unknown> {
  try {
    return await storage.read(key);
  } catch (error) {
    sanitizedAdapterFailure(error);
  }
}

async function storageTransact(
  storage: StorageAdapter,
  request: Parameters<StorageAdapter["transact"]>[0],
): Promise<unknown> {
  try {
    return await storage.transact(request);
  } catch (error) {
    sanitizedAdapterFailure(error);
  }
}

function verifyParticipantTransactionResult(
  value: unknown,
  expected: readonly [
    ExpectedParticipantStorageRecord,
    ExpectedParticipantStorageRecord,
  ],
): VerifiedParticipantTransactionResult {
  try {
    const source = exactDataRecord(value, TRANSACTION_RESULT_KEYS);
    if (typeof source.replayed !== "boolean") unavailable();
    const candidates = exactDataArray(source.records, expected.length);
    const records: StorageRecord[] = [];

    for (const [index, expectation] of expected.entries()) {
      const record = snapshotStorageRecord(candidates[index]);
      if (
        record.key.collection !== expectation.key.collection ||
        record.key.id !== expectation.key.id ||
        record.revision !== expectation.revision ||
        !equalData(record.value, expectation.value)
      ) {
        unavailable();
      }
      records.push(record);
    }

    return deepFreeze({
      replayed: source.replayed,
      records: records as unknown as readonly [StorageRecord, StorageRecord],
    });
  } catch {
    unavailable();
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
      registrationNoticeEvidence: {
        version: profile.registrationNoticeEvidence.version,
        campaignRevision: profile.registrationNoticeEvidence.campaignRevision,
        processEmail: profile.registrationNoticeEvidence.processEmail,
        marketing: profile.registrationNoticeEvidence.marketing,
      },
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

function boundedParticipantProfileDocument(
  profile: ParticipantProfile,
  profileRevision: number,
  action: ParticipantMutationAction,
  operationId: StorageOperationId,
  requestHash: string,
): StorageDocument {
  return snapshotBoundedStorageDocument(participantProfileDocument(
    profile,
    profileRevision,
    action,
    operationId,
    requestHash,
  ));
}

function boundedParticipantTransaction(
  request: Parameters<StorageAdapter["transact"]>[0],
): Parameters<StorageAdapter["transact"]>[0] {
  const serialized = JSON.stringify(request);
  if (
    typeof serialized !== "string" ||
    new TextEncoder().encode(serialized).byteLength >
      MAX_PARTICIPANT_PROFILE_TRANSACTION_INPUT_BYTES
  ) {
    unavailable();
  }
  return request;
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
  record: unknown,
  expectedKey: StorageKey,
  trustedSubject: ActorSubject,
): ParticipantProfileSnapshot | null {
  return decodeParticipantRecord(
    record,
    expectedKey,
    trustedSubject,
    null,
    null,
  );
}

function decodeHistoricalParticipantRecord(
  record: unknown,
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
  record: unknown,
  expectedKey: StorageKey,
  trustedSubject: ActorSubject,
  expectedProfileRevision: number | null,
  expectedStorageRevision: number | null,
): ParticipantProfileSnapshot | null {
  try {
    const stored = snapshotStorageRecord(record);
    if (
      stored.key.collection !== expectedKey.collection ||
      stored.key.id !== expectedKey.id ||
      (expectedStorageRevision !== null &&
        stored.revision !== expectedStorageRevision)
    ) {
      unavailable();
    }

    const profileRevision = expectedProfileRevision ?? stored.revision;
    const source = objectRecord(stored.value);
    if (
      source === null ||
      !hasExactKeys(source, PROFILE_DOCUMENT_KEYS) ||
      source.kind !== "participant-profile" ||
      source.schemaVersion !== PARTICIPANT_PROFILE_SCHEMA_VERSION ||
      !Number.isSafeInteger(source.profileRevision) ||
      source.profileRevision !== profileRevision
    ) {
      unavailable();
    }

    const outerSubject = parseActorSubject(source.subject);
    if (!outerSubject.ok) unavailable();
    if (outerSubject.value !== trustedSubject) return null;
    const lastMutation = validateLastMutation(source.lastMutation);

    const profile = decodeParticipantProfile(source.profile, trustedSubject);
    if (profile === null) return null;
    validateParticipantProfileRevision(profileRevision, profile, lastMutation);
    return profileSnapshot(profileRevision, profile);
  } catch {
    unavailable();
  }
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
    requiredStoredNoticeEvidence(source.registrationNoticeEvidence),
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

function validateParticipantProfileRevision(
  revision: number,
  profile: ParticipantProfile,
  lastMutation: ParticipantMutationEvidence,
): void {
  if (revision !== 1) return;
  if (
    lastMutation.action !== "register" ||
    profile.updatedAt !== profile.registeredAt ||
    profile.marketingConsent.state === "withdrawn" ||
    profile.accountDeletionRequest.state !== "not-requested"
  ) {
    unavailable();
  }
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

function participantMutationEvidence(
  value: StorageDocument,
): ParticipantMutationEvidence {
  const source = objectRecord(value);
  if (
    source === null ||
    !hasExactKeys(source, PROFILE_DOCUMENT_KEYS) ||
    source.kind !== "participant-profile" ||
    source.schemaVersion !== PARTICIPANT_PROFILE_SCHEMA_VERSION
  ) {
    unavailable();
  }
  return validateLastMutation(source.lastMutation);
}

function validateLastMutation(value: unknown): ParticipantMutationEvidence {
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
  return deepFreeze({
    action: source.action as ParticipantMutationAction,
    operationId: operationId.value,
    requestHash: source.requestHash,
  });
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

function requiredNoticeEvidence(
  value: unknown,
): ParticipantRegistrationNoticeEvidence {
  try {
    return defineParticipantRegistrationNoticeEvidence(value);
  } catch {
    invalidRequest();
  }
}

function requiredStoredNoticeEvidence(
  value: unknown,
): ParticipantRegistrationNoticeEvidence {
  try {
    return defineParticipantRegistrationNoticeEvidence(value);
  } catch {
    unavailable();
  }
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

function snapshotStorageRecord(value: unknown): StorageRecord {
  const source = exactDataRecord(value, STORAGE_RECORD_KEYS);
  const keySource = exactDataRecord(source.key, STORAGE_KEY_KEYS);
  const key = parseStorageKey(keySource.collection, keySource.id);
  if (
    !key.ok ||
    !Number.isSafeInteger(source.revision) ||
    (source.revision as number) < 1
  ) {
    unavailable();
  }

  return deepFreeze({
    key: key.value,
    revision: source.revision as number,
    value: snapshotBoundedStorageDocument(source.value),
  });
}

function snapshotBoundedStorageDocument(value: unknown): StorageDocument {
  const state = { nodes: 0, stringCodeUnits: 0 };
  const snapshot = snapshotBoundedData(value, state, 0);
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot)
  ) {
    unavailable();
  }

  const serialized = JSON.stringify(snapshot);
  if (
    typeof serialized !== "string" ||
    serialized.length > PARTICIPANT_PROFILE_STORAGE_LIMITS.maxRecordBytes ||
    new TextEncoder().encode(serialized).byteLength >
      PARTICIPANT_PROFILE_STORAGE_LIMITS.maxRecordBytes
  ) {
    unavailable();
  }
  return deepFreeze(snapshot as StorageDocument);
}

function snapshotBoundedData(
  value: unknown,
  state: { nodes: number; stringCodeUnits: number },
  depth: number,
): unknown {
  state.nodes += 1;
  if (
    state.nodes > PARTICIPANT_PROFILE_STORAGE_LIMITS.maxNodes ||
    depth > PARTICIPANT_PROFILE_STORAGE_LIMITS.maxDepth
  ) {
    unavailable();
  }

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    accountStoredString(value, state);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) unavailable();
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(
      exactDataArray(value).map((candidate) =>
        snapshotBoundedData(candidate, state, depth + 1)
      ),
    );
  }

  const entries = dataRecordEntries(value);
  const snapshot: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, candidate] of entries) {
    accountStoredString(key, state);
    snapshot[key] = snapshotBoundedData(candidate, state, depth + 1);
  }
  return Object.freeze(snapshot);
}

function accountStoredString(
  value: string,
  state: { stringCodeUnits: number },
): void {
  if (value.length > PARTICIPANT_PROFILE_STORAGE_LIMITS.maxRecordBytes) {
    unavailable();
  }
  state.stringCodeUnits += value.length;
  if (
    state.stringCodeUnits > PARTICIPANT_PROFILE_STORAGE_LIMITS.maxRecordBytes
  ) {
    unavailable();
  }
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  const entries = dataRecordEntries(value);
  if (
    entries.length !== expectedKeys.length ||
    entries.some(([key]) => !expectedKeys.includes(key))
  ) {
    unavailable();
  }

  const snapshot: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, candidate] of entries) snapshot[key] = candidate;
  return snapshot;
}

function dataRecordEntries(
  value: unknown,
): readonly (readonly [string, unknown])[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    unavailable();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) unavailable();

  const source = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(source);
  if (
    keys.length > PARTICIPANT_PROFILE_STORAGE_LIMITS.maxNodes ||
    keys.some((key) => typeof key !== "string")
  ) {
    unavailable();
  }

  const entries: (readonly [string, unknown])[] = [];
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      unavailable();
    }
    entries.push([key, descriptor.value] as const);
  }
  return entries;
}

function exactDataArray(
  value: unknown,
  expectedLength?: number,
): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    unavailable();
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.enumerable ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > PARTICIPANT_PROFILE_STORAGE_LIMITS.maxNodes ||
    (expectedLength !== undefined &&
      lengthDescriptor.value !== expectedLength)
  ) {
    unavailable();
  }

  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== length + 1 ||
    !keys.includes("length") ||
    keys.some((key) =>
      typeof key !== "string" ||
      key !== "length" &&
        (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length)
    )
  ) {
    unavailable();
  }

  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      unavailable();
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function equalData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equalData(value, right[index]));
  }
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      equalData(leftRecord[key], rightRecord[key])
    );
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

function preconditionFailed(): never {
  throw new StorageFailure("PRECONDITION_FAILED");
}

function unavailable(): never {
  throw new StorageFailure("UNAVAILABLE");
}

function sanitizedAdapterFailure(error: unknown): never {
  let code: StorageFailure["code"] = "UNAVAILABLE";
  try {
    if (error instanceof StorageFailure) {
      const descriptor = Object.getOwnPropertyDescriptor(error, "code");
      if (
        descriptor !== undefined &&
        "value" in descriptor &&
        (descriptor.value === "INVALID_REQUEST" ||
          descriptor.value === "NOT_FOUND" ||
          descriptor.value === "CONFLICT" ||
          descriptor.value === "PRECONDITION_FAILED" ||
          descriptor.value === "UNAVAILABLE")
      ) {
        code = descriptor.value;
      }
    }
  } catch {
    code = "UNAVAILABLE";
  }
  throw new StorageFailure(code);
}

function isReplayConflict(error: unknown): error is StorageFailure & Readonly<{
  code: "CONFLICT" | "PRECONDITION_FAILED";
}> {
  return error instanceof StorageFailure &&
    (error.code === "CONFLICT" || error.code === "PRECONDITION_FAILED");
}
