import {
  MAX_FOUNDER_APPLICATION_REVISIONS,
  canEditFounderApplication,
  canWithdrawFounderApplication,
  createFounderApplication,
  editFounderApplication,
  parseContributionAreaChoices,
  parseFounderApplicationFields,
  withdrawFounderApplication,
  type ContributionAreaChoice,
  type FounderApplication,
  type FounderApplicationFields,
  type FounderApplicationHistoryEntryId,
  type FounderApplicationId,
  type ReceivedFounderApplication,
  type WithdrawnFounderApplication,
} from "../domain/founder-application.ts";
import {
  parseActorSubject,
  parseStableId,
  parseTimestamp,
  type ActorSubject,
  type Timestamp,
} from "../domain/foundation.ts";
import {
  MAX_STORAGE_TRANSACTION_MUTATIONS,
  StorageFailure,
  assertStorageListBoundary,
  parseStorageCollection,
  parseStorageKey,
  parseStorageOperationId,
  storageKeyString,
  type StorageAdapter,
  type StorageCheckMutation,
  type StorageCollection,
  type StorageCursor,
  type StorageDocument,
  type StorageKey,
  type StorageOperationId,
  type StorageRecord,
  type StorageTransactionRequest,
} from "../domain/storage-adapter.ts";

const FOUNDER_APPLICATION_SCHEMA_VERSION = 2;
const CURRENT_APPLICATIONS = storageCollection("founder-applications");
const APPLICATION_HISTORY = storageCollection("founder-application-history");
const APPLICATION_FIELDS = storageCollection("founder-application-fields");
const APPLICATION_POLICY_REVISIONS = storageCollection(
  "founder-application-policy-revisions",
);
const APPLICATION_REVIEW_LOOKUPS = storageCollection(
  "founder-review-lookups",
);
const LEGACY_FOUNDER_APPLICATION_POLICY_SCHEMA_VERSION = 1;
const FOUNDER_APPLICATION_POLICY_SCHEMA_VERSION = 2;
const FOUNDER_APPLICATION_REVIEW_LOOKUP_SCHEMA_VERSION = 1;

export const MAX_FOUNDER_APPLICATION_STORAGE_RECORD_BYTES = 65_536;
export const MAX_FOUNDER_APPLICATION_STORAGE_TRANSACTION_BYTES = 1_048_576;
export const MAX_SERIALIZED_FOUNDER_APPLICATION_FIELDS_BYTES = 524_288;
export const FOUNDER_APPLICATION_FIELDS_CHUNK_RAW_BYTES = 45_000;
export const MAX_FOUNDER_APPLICATION_FIELDS_CHUNKS = Math.ceil(
  MAX_SERIALIZED_FOUNDER_APPLICATION_FIELDS_BYTES /
    FOUNDER_APPLICATION_FIELDS_CHUNK_RAW_BYTES,
);
export const MAX_FOUNDER_APPLICATION_MATERIALIZATION_READS =
  1 + MAX_FOUNDER_APPLICATION_REVISIONS *
    (1 + MAX_FOUNDER_APPLICATION_FIELDS_CHUNKS);
export const MAX_FOUNDER_APPLICATION_STORAGE_READS =
  4 + 2 * MAX_FOUNDER_APPLICATION_MATERIALIZATION_READS;
export const MAX_FOUNDER_APPLICATION_REVIEW_PAGE_SIZE = 25;
export const MAX_FOUNDER_APPLICATION_REVIEW_CURSOR_CHARACTERS = 2_048;
export const MAX_FOUNDER_APPLICATION_REVIEW_PAGE_RECORD_READS =
  MAX_FOUNDER_APPLICATION_REVIEW_PAGE_SIZE *
  (2 + MAX_FOUNDER_APPLICATION_FIELDS_CHUNKS);
export const MAX_FOUNDER_APPLICATION_REVIEW_DETAIL_RECORD_READS =
  1 + MAX_FOUNDER_APPLICATION_MATERIALIZATION_READS;
export const MAX_FOUNDER_APPLICATION_REVIEW_LOOKUP_BACKFILL_READS =
  1 + MAX_FOUNDER_APPLICATION_MATERIALIZATION_READS;

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CURRENT_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "operationId",
  "operationFingerprint",
  "applicationId",
  "applicantSubject",
  "status",
  "createdAt",
  "updatedAt",
  "withdrawnAt",
  "revision",
  "fields",
]);
const TRANSITION_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "operationId",
  "operationFingerprint",
  "applicationId",
  "applicantSubject",
  "historyEntryId",
  "occurredAt",
  "revision",
  "transitionKind",
  "status",
  "createdAt",
  "updatedAt",
  "withdrawnAt",
  "fields",
]);
const FIELDS_REFERENCE_KEYS = new Set([
  "revision",
  "hash",
  "bytes",
  "chunks",
]);
const FIELDS_CHUNK_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "applicationId",
  "applicantSubject",
  "fieldsRevision",
  "fieldsHash",
  "fieldsBytes",
  "chunkIndex",
  "chunkCount",
  "data",
]);
const FIELDS_PAYLOAD_KEYS = new Set([
  "contributionAreaIds",
  "fields",
]);
const LEGACY_POLICY_REVISION_DOCUMENT_KEYS = [
  "kind",
  "schemaVersion",
  "applicationId",
  "applicantSubject",
  "applicationRevision",
  "campaignSetupRevision",
] as const;
const POLICY_REVISION_DOCUMENT_KEYS = [
  ...LEGACY_POLICY_REVISION_DOCUMENT_KEYS,
  "participantProfileRevision",
] as const;
const REVIEW_LOOKUP_DOCUMENT_KEYS = [
  "kind",
  "schemaVersion",
  "reviewId",
  "applicationId",
  "applicantSubject",
] as const;

export type FounderApplicationMutationResult<
  Application extends FounderApplication = FounderApplication,
> = Readonly<{
  revision: number;
  snapshot: Application;
  replayed: boolean;
}>;

type FounderApplicationMutationRequest = Readonly<{
  operationId: unknown;
  id: unknown;
  occurredAt: unknown;
  historyEntryId: unknown;
}>;

export type CreateFounderApplicationRequest =
  FounderApplicationMutationRequest &
  Readonly<{
    expectedRevision: null;
    fields: unknown;
  }>;

export type EditFounderApplicationRequest = FounderApplicationMutationRequest &
  Readonly<{
    expectedRevision: number;
    fields: unknown;
  }>;

export type WithdrawFounderApplicationRequest =
  FounderApplicationMutationRequest &
  Readonly<{
    expectedRevision: number;
  }>;

/** Subject-bound persistence contract for one participant's founder records. */
export interface FounderApplicationRepository {
  create(
    request: CreateFounderApplicationRequest,
  ): Promise<FounderApplicationMutationResult<ReceivedFounderApplication>>;
  get(id: FounderApplicationId): Promise<FounderApplication | null>;
  edit(
    request: EditFounderApplicationRequest,
  ): Promise<FounderApplicationMutationResult<ReceivedFounderApplication>>;
  withdraw(
    request: WithdrawFounderApplicationRequest,
  ): Promise<FounderApplicationMutationResult<WithdrawnFounderApplication>>;
}

export type FounderApplicationPolicyRevisionCheck = (
  revision: number,
) => StorageCheckMutation | Promise<StorageCheckMutation>;
export type FounderApplicationPolicyRevisionEvidenceVerifier = (
  record: unknown,
  revision: number,
) => void | Promise<void>;

export type StorageFounderApplicationRepositoryOptions = Readonly<{
  policyRevisionCheck?: FounderApplicationPolicyRevisionCheck;
  verifyPolicyRevisionCheck?: FounderApplicationPolicyRevisionEvidenceVerifier;
  writePolicyRevision?: number;
  participantProfileRevisionCheck?: FounderApplicationPolicyRevisionCheck;
  verifyParticipantProfileRevisionCheck?: FounderApplicationPolicyRevisionEvidenceVerifier;
  writeParticipantProfileRevision?: number;
}>;

export type FounderApplicationReviewItem = Readonly<{
  reviewId: string;
  application: FounderApplication;
}>;

export type FounderApplicationReviewCollectionItem = Readonly<{
  reviewId: string;
  status: FounderApplication["status"];
  primaryContributionAreaId: string;
  updatedAt: Timestamp;
  revision: number;
}>;

export type FounderApplicationReviewListRequest = Readonly<{
  limit: number;
  cursor?: StorageCursor;
}>;

export type FounderApplicationReviewPage = Readonly<{
  items: readonly FounderApplicationReviewCollectionItem[];
  nextCursor: StorageCursor | null;
}>;

/** Owner collection contract over all current founder applications. */
export interface FounderApplicationReviewCollectionRepository {
  list(
    request: FounderApplicationReviewListRequest,
  ): Promise<FounderApplicationReviewPage>;
}

/** Direct opaque lookup of one bounded, fully verified founder application. */
export interface FounderApplicationReviewDetailRepository {
  get(reviewId: unknown): Promise<FounderApplicationReviewItem | null>;
}

export type FounderApplicationReviewLookupBackfillRequest = Readonly<{
  applicantSubject: unknown;
  applicationId: unknown;
}>;

/** Backend-only compatibility backfill for one pre-index founder application. */
export interface FounderApplicationReviewLookupBackfillRepository {
  backfill(
    request: FounderApplicationReviewLookupBackfillRequest,
  ): Promise<string>;
}

/** Configured-owner development contract over collection and detail reads. */
export interface FounderApplicationReviewRepository
  extends FounderApplicationReviewCollectionRepository,
    FounderApplicationReviewDetailRepository {}

type MutationKind = "create" | "edit" | "withdraw";
type TransitionKind = "created" | "edited" | "withdrawn";

type ParsedMutationEnvelope = Readonly<{
  operationId: StorageOperationId;
  id: FounderApplicationId;
  occurredAt: Timestamp;
  historyEntryId: FounderApplicationHistoryEntryId;
  expectedRevision: number | null;
  fields?: unknown;
}>;

type ParsedMutationRequest = Omit<ParsedMutationEnvelope, "fields"> &
  Readonly<{ fields?: FounderApplicationFields }>;

type StoredFieldsReference = Readonly<{
  revision: number;
  hash: string;
  bytes: number;
  chunks: number;
}>;

type PreparedFieldsChunk = Readonly<{
  key: StorageKey;
  value: StorageDocument;
}>;

type StoredFields = Readonly<{
  reference: StoredFieldsReference;
  fields: FounderApplicationFields;
  choices: readonly ContributionAreaChoice[];
  chunks: readonly PreparedFieldsChunk[];
}>;

type StoredTransition = Readonly<{
  operationId: StorageOperationId;
  operationFingerprint: string;
  applicationId: FounderApplicationId;
  applicantSubject: ActorSubject;
  historyEntryId: FounderApplicationHistoryEntryId;
  occurredAt: Timestamp;
  revision: number;
  transitionKind: TransitionKind;
  status: FounderApplication["status"];
  createdAt: Timestamp;
  updatedAt: Timestamp;
  withdrawnAt: Timestamp | null;
  fields: StoredFieldsReference;
  document: StorageDocument;
}>;

type StoredCurrent = Readonly<{
  operationId: StorageOperationId;
  operationFingerprint: string;
  applicationId: FounderApplicationId;
  applicantSubject: ActorSubject;
  status: FounderApplication["status"];
  createdAt: Timestamp;
  updatedAt: Timestamp;
  withdrawnAt: Timestamp | null;
  revision: number;
  fields: StoredFieldsReference;
  document: StorageDocument;
}>;

type MaterializedApplication = Readonly<{
  application: FounderApplication;
  terminal: StoredTransition;
  fieldsByRevision: ReadonlyMap<number, StoredFields>;
}>;

type PreparedMutation = Readonly<{
  application: FounderApplication;
  currentDocument: StorageDocument;
  historyDocument: StorageDocument;
  fieldsChunks: readonly PreparedFieldsChunk[];
  policy: PreparedPolicyRevision | null;
}>;

type PreparedPolicyRevision = Readonly<{
  key: StorageKey;
  value: StorageDocument;
  checks: readonly PreparedPolicyRevisionCheck[];
}>;

type PreparedPolicyRevisionCheck = Readonly<{
  mutation: StorageCheckMutation;
  verifyEvidence: FounderApplicationPolicyRevisionEvidenceVerifier;
}>;

type PolicyRevisionEvidence = Readonly<{
  campaignSetupRevision: number;
  participantProfileRevision: number | null;
}>;

/** Exact absence assertion used when account deletion observes no application. */
export async function founderApplicationAbsenceCheck(
  participantSubject: unknown,
  applicationId: unknown,
): Promise<StorageCheckMutation> {
  const subject = requiredActorSubject(participantSubject);
  const id = requiredApplicationId(applicationId);
  return Object.freeze({
    type: "check",
    key: await currentApplicationKey(subject, id),
    expectedRevision: null,
  });
}

/**
 * Subject-bound repository composed entirely through a supplied StorageAdapter.
 * Current and transition records contain only bounded metadata; each create or
 * edit owns one bounded, chunked fields payload and history grows linearly.
 */
export class StorageFounderApplicationRepository
  implements FounderApplicationRepository
{
  readonly storageKind = "storage-adapter" as const;

  readonly #storage: StorageAdapter;
  readonly #applicantSubject: ActorSubject | null;
  readonly #contributionAreaChoices: readonly ContributionAreaChoice[];
  readonly #policyRevisionCheck: FounderApplicationPolicyRevisionCheck | null;
  readonly #verifyPolicyRevisionCheck:
    | FounderApplicationPolicyRevisionEvidenceVerifier
    | null;
  readonly #writePolicyRevision: number | null;
  readonly #participantProfileRevisionCheck:
    | FounderApplicationPolicyRevisionCheck
    | null;
  readonly #verifyParticipantProfileRevisionCheck:
    | FounderApplicationPolicyRevisionEvidenceVerifier
    | null;
  readonly #writeParticipantProfileRevision: number | null;

  constructor(
    storage: StorageAdapter,
    authenticatedApplicantSubject: ActorSubject | null,
    contributionAreaChoices: readonly ContributionAreaChoice[],
    options: StorageFounderApplicationRepositoryOptions = {},
  ) {
    this.#storage = storage;
    this.#applicantSubject = authenticatedApplicantSubject === null
      ? null
      : requiredActorSubject(authenticatedApplicantSubject);

    const parsedChoices = parseContributionAreaChoices(contributionAreaChoices);
    if (!parsedChoices.ok) invalidRequest();
    this.#contributionAreaChoices = parsedChoices.value;

    this.#policyRevisionCheck = options.policyRevisionCheck ?? null;
    this.#verifyPolicyRevisionCheck = options.verifyPolicyRevisionCheck ?? null;
    this.#writePolicyRevision = options.writePolicyRevision === undefined
      ? null
      : requiredPolicyRevision(options.writePolicyRevision);
    this.#participantProfileRevisionCheck =
      options.participantProfileRevisionCheck ?? null;
    this.#verifyParticipantProfileRevisionCheck =
      options.verifyParticipantProfileRevisionCheck ?? null;
    this.#writeParticipantProfileRevision =
      options.writeParticipantProfileRevision === undefined
        ? null
        : requiredPolicyRevision(options.writeParticipantProfileRevision);
    if (
      (this.#policyRevisionCheck !== null &&
        typeof this.#policyRevisionCheck !== "function") ||
      (this.#verifyPolicyRevisionCheck !== null &&
        typeof this.#verifyPolicyRevisionCheck !== "function") ||
      (this.#policyRevisionCheck === null) !==
        (this.#verifyPolicyRevisionCheck === null) ||
      (this.#participantProfileRevisionCheck !== null &&
        typeof this.#participantProfileRevisionCheck !== "function") ||
      (this.#verifyParticipantProfileRevisionCheck !== null &&
        typeof this.#verifyParticipantProfileRevisionCheck !== "function") ||
      (this.#participantProfileRevisionCheck === null) !==
        (this.#verifyParticipantProfileRevisionCheck === null) ||
      (this.#writePolicyRevision !== null && this.#policyRevisionCheck === null) ||
      (this.#participantProfileRevisionCheck !== null &&
        this.#policyRevisionCheck === null) ||
      (this.#writeParticipantProfileRevision !== null &&
        (this.#participantProfileRevisionCheck === null ||
          this.#writePolicyRevision === null))
    ) {
      invalidRequest();
    }
  }

  async create(
    request: CreateFounderApplicationRequest,
  ): Promise<FounderApplicationMutationResult<ReceivedFounderApplication>> {
    const subject = this.#requiredSubject();
    const envelope = parseCreateEnvelope(request);
    const replay = await this.#replayIfKnown("create", envelope, subject);
    if (replay !== null) return receivedResult(replay);

    const parsed = parseRequestFields(
      envelope,
      this.#contributionAreaChoices,
    );
    const fingerprint = await operationFingerprint("create", subject, parsed);
    const created = createFounderApplication(
      {
        id: parsed.id,
        applicantSubject: subject,
        occurredAt: parsed.occurredAt,
        historyEntryId: parsed.historyEntryId,
        fields: parsed.fields,
      },
      this.#contributionAreaChoices,
    );
    if (!created.ok) invalidRequest();

    return receivedResult(
      await this.#writeSnapshot(
        created.value,
        parsed,
        subject,
        fingerprint,
        null,
      ),
    );
  }

  async get(id: FounderApplicationId): Promise<FounderApplication | null> {
    const subject = this.#applicantSubject;
    if (subject === null) return null;

    const stored = await this.#readCurrent(requiredApplicationId(id), subject);
    return stored?.application ?? null;
  }

  async edit(
    request: EditFounderApplicationRequest,
  ): Promise<FounderApplicationMutationResult<ReceivedFounderApplication>> {
    const subject = this.#requiredSubject();
    const envelope = parseEditEnvelope(request);
    const replay = await this.#replayIfKnown("edit", envelope, subject);
    if (replay !== null) return receivedResult(replay);

    const parsed = parseRequestFields(
      envelope,
      this.#contributionAreaChoices,
    );
    const fingerprint = await operationFingerprint("edit", subject, parsed);
    const current = await this.#readCurrent(parsed.id, subject);
    if (current === null) notFound();
    requireCurrentRevision(current.application, parsed.expectedRevision);
    if (!canEditFounderApplication(current.application)) {
      throw new StorageFailure("PRECONDITION_FAILED");
    }

    const edited = editFounderApplication(
      current.application,
      {
        actorSubject: subject,
        occurredAt: parsed.occurredAt,
        historyEntryId: parsed.historyEntryId,
        fields: parsed.fields,
      },
      this.#contributionAreaChoices,
    );
    if (!edited.ok) invalidRequest();

    return receivedResult(
      await this.#writeSnapshot(
        edited.value,
        parsed,
        subject,
        fingerprint,
        current,
      ),
    );
  }

  async withdraw(
    request: WithdrawFounderApplicationRequest,
  ): Promise<FounderApplicationMutationResult<WithdrawnFounderApplication>> {
    const subject = this.#requiredSubject();
    const parsed = parseWithdrawEnvelope(request);
    const replay = await this.#replayIfKnown("withdraw", parsed, subject);
    if (replay !== null) return withdrawnResult(replay);

    const fingerprint = await operationFingerprint("withdraw", subject, parsed);
    const current = await this.#readCurrent(parsed.id, subject);
    if (current === null) notFound();
    requireCurrentRevision(current.application, parsed.expectedRevision);
    if (!canWithdrawFounderApplication(current.application)) {
      throw new StorageFailure("PRECONDITION_FAILED");
    }

    const withdrawn = withdrawFounderApplication(current.application, {
      actorSubject: subject,
      occurredAt: parsed.occurredAt,
      historyEntryId: parsed.historyEntryId,
    });
    if (!withdrawn.ok) invalidRequest();

    return withdrawnResult(
      await this.#writeSnapshot(
        withdrawn.value,
        parsed,
        subject,
        fingerprint,
        current,
      ),
    );
  }

  #requiredSubject(): ActorSubject {
    if (this.#applicantSubject === null) notFound();
    return this.#applicantSubject;
  }

  async #readCurrent(
    id: FounderApplicationId,
    subject: ActorSubject,
  ): Promise<MaterializedApplication | null> {
    const key = await currentApplicationKey(subject, id);
    const record = await this.#storage.read(key);
    if (record === null) return null;
    return loadCurrentApplication(this.#storage, record, subject, id);
  }

  async #replayIfKnown(
    kind: MutationKind,
    envelope: ParsedMutationEnvelope,
    subject: ActorSubject,
  ): Promise<FounderApplicationMutationResult | null> {
    const revision = nextRevision(envelope.expectedRevision);
    const historyKey = await applicationHistoryKey(subject, envelope.id, revision);
    const record = await this.#storage.read(historyKey);
    if (record === null) return null;

    const terminal = decodeStoredTransition(
      record,
      historyKey,
      subject,
      envelope.id,
      revision,
    );
    if (terminal.operationId !== envelope.operationId) {
      throw new StorageFailure(
        envelope.expectedRevision === null ? "CONFLICT" : "PRECONDITION_FAILED",
      );
    }

    const materialized = await materializeApplication(
      this.#storage,
      subject,
      envelope.id,
      revision,
      terminal,
    );
    const storedFields = materialized.fieldsByRevision.get(
      terminal.fields.revision,
    );
    if (storedFields === undefined) unavailable();
    const parsed = kind === "withdraw"
      ? requestWithoutFields(envelope)
      : parseKnownOperationFields(
          envelope,
          storedFields.choices,
          this.#contributionAreaChoices,
        );
    const fingerprint = await operationFingerprint(kind, subject, parsed);
    if (terminal.operationFingerprint !== fingerprint) {
      throw new StorageFailure("CONFLICT");
    }

    const transitionKind = mutationTransitionKind(kind);
    if (terminal.transitionKind !== transitionKind) {
      throw new StorageFailure("CONFLICT");
    }
    const fieldsChunks = kind === "withdraw"
      ? Object.freeze([])
      : storedFields.chunks;
    const policy = kind === "withdraw"
      ? null
      : await this.#readPolicyRevision(subject, envelope.id, revision);
    return this.#transactPrepared(
      prepareMutation(
        materialized.application,
        terminal.operationId,
        terminal.operationFingerprint,
        terminal.fields,
        fieldsChunks,
        policy,
      ),
      parsed,
      subject,
    );
  }

  async #writeSnapshot(
    application: FounderApplication,
    request: ParsedMutationRequest,
    subject: ActorSubject,
    fingerprint: string,
    current: MaterializedApplication | null,
  ): Promise<FounderApplicationMutationResult> {
    if (application.revision !== nextRevision(request.expectedRevision)) {
      unavailable();
    }

    let storedFields: StoredFields;
    let fieldsChunks: readonly PreparedFieldsChunk[];
    if (request.fields === undefined) {
      if (current === null) unavailable();
      const inherited = current.fieldsByRevision.get(
        current.terminal.fields.revision,
      );
      if (inherited === undefined) unavailable();
      storedFields = inherited;
      fieldsChunks = Object.freeze([]);
    } else {
      storedFields = await prepareStoredFields(
        subject,
        application.id,
        application.revision,
        request.fields,
        this.#contributionAreaChoices,
      );
      fieldsChunks = storedFields.chunks;
    }

    const prepared = prepareMutation(
      application,
      request.operationId,
      fingerprint,
      storedFields.reference,
      fieldsChunks,
      request.fields === undefined
        ? null
        : await this.#prepareWritePolicyRevision(
            subject,
            application.id,
            application.revision,
          ),
    );
    try {
      return await this.#transactPrepared(prepared, request, subject);
    } catch (error) {
      if (
        error instanceof StorageFailure &&
        (error.code === "CONFLICT" || error.code === "PRECONDITION_FAILED")
      ) {
        const kind = application.history.at(-1)?.kind === "created"
          ? "create"
          : application.history.at(-1)?.kind === "edited"
            ? "edit"
            : "withdraw";
        const replay = await this.#replayIfKnown(kind, request, subject);
        if (replay !== null) return replay;
      }
      throw error;
    }
  }

  async #transactPrepared(
    prepared: PreparedMutation,
    request: ParsedMutationRequest,
    subject: ActorSubject,
  ): Promise<FounderApplicationMutationResult> {
    const currentKey = await currentApplicationKey(subject, request.id);
    const historyKey = await applicationHistoryKey(
      subject,
      request.id,
      prepared.application.revision,
    );
    const mutations = [
      {
        type: "put" as const,
        key: currentKey,
        expectedRevision: request.expectedRevision,
        value: prepared.currentDocument,
      },
      {
        type: "put" as const,
        key: historyKey,
        expectedRevision: null,
        value: prepared.historyDocument,
      },
      ...prepared.fieldsChunks.map((chunk) => ({
        type: "put" as const,
        key: chunk.key,
        expectedRevision: null,
        value: chunk.value,
      })),
      ...(prepared.policy === null
        ? []
        : [
            {
              type: "put" as const,
              key: prepared.policy.key,
              expectedRevision: null,
              value: prepared.policy.value,
            },
            ...prepared.policy.checks.map((check) => check.mutation),
          ]),
    ];
    if (
      mutations.length > MAX_STORAGE_TRANSACTION_MUTATIONS ||
      mutations.length > 5 + MAX_FOUNDER_APPLICATION_FIELDS_CHUNKS
    ) {
      unavailable();
    }
    const transaction: StorageTransactionRequest = Object.freeze({
      operationId: request.operationId,
      mutations: Object.freeze(mutations),
    });
    if (
      jsonByteLength(transaction) >
        MAX_FOUNDER_APPLICATION_STORAGE_TRANSACTION_BYTES
    ) {
      unavailable();
    }

    const result = exactStorageTransactionResult(
      await this.#storage.transact(transaction),
      mutations.length,
    );
    verifyExactRecord(
      result.records[0],
      currentKey,
      prepared.application.revision,
      prepared.currentDocument,
    );
    verifyExactRecord(
      result.records[1],
      historyKey,
      1,
      prepared.historyDocument,
    );
    for (const [index, chunk] of prepared.fieldsChunks.entries()) {
      verifyExactRecord(result.records[index + 2], chunk.key, 1, chunk.value);
    }
    if (prepared.policy !== null) {
      const policyIndex = 2 + prepared.fieldsChunks.length;
      verifyExactRecord(
        result.records[policyIndex],
        prepared.policy.key,
        1,
        prepared.policy.value,
      );
      for (const [index, check] of prepared.policy.checks.entries()) {
        await verifyRevisionCheckRecord(
          result.records[policyIndex + 1 + index],
          check.mutation,
          check.verifyEvidence,
        );
      }
    }

    if (request.expectedRevision === null) {
      await ensureFounderReviewLookup(this.#storage, subject, request.id);
    }

    return mutationResult(prepared.application, result.replayed);
  }

  async #prepareWritePolicyRevision(
    subject: ActorSubject,
    id: FounderApplicationId,
    applicationRevision: number,
  ): Promise<PreparedPolicyRevision | null> {
    if (this.#policyRevisionCheck === null) return null;
    if (this.#writePolicyRevision === null) {
      throw new StorageFailure("PRECONDITION_FAILED");
    }
    if (this.#verifyPolicyRevisionCheck === null) unavailable();
    return preparePolicyRevision(
      subject,
      id,
      applicationRevision,
      Object.freeze({
        campaignSetupRevision: this.#writePolicyRevision,
        participantProfileRevision: this.#writeParticipantProfileRevision,
      }),
      this.#policyRevisionCheck,
      this.#verifyPolicyRevisionCheck,
      this.#participantProfileRevisionCheck,
      this.#verifyParticipantProfileRevisionCheck,
    );
  }

  async #readPolicyRevision(
    subject: ActorSubject,
    id: FounderApplicationId,
    applicationRevision: number,
  ): Promise<PreparedPolicyRevision | null> {
    if (this.#policyRevisionCheck === null) return null;
    const key = await applicationPolicyRevisionKey(
      subject,
      id,
      applicationRevision,
    );
    const record = await this.#storage.read(key);
    if (record === null) return null;
    const evidence = decodePolicyRevision(
      record,
      key,
      subject,
      id,
      applicationRevision,
    );
    if (this.#verifyPolicyRevisionCheck === null) unavailable();
    return preparePolicyRevision(
      subject,
      id,
      applicationRevision,
      evidence,
      this.#policyRevisionCheck,
      this.#verifyPolicyRevisionCheck,
      this.#participantProfileRevisionCheck,
      this.#verifyParticipantProfileRevisionCheck,
    );
  }
}

/** Persistent, bounded collection projection over current founder records. */
export class StorageFounderApplicationReviewCollectionRepository
implements FounderApplicationReviewCollectionRepository {
  readonly #storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.#storage = requiredStorageAdapter(storage);
    Object.freeze(this);
  }

  async list(
    request: FounderApplicationReviewListRequest,
  ): Promise<FounderApplicationReviewPage> {
    try {
      const parsed = parseFounderReviewListRequest(request);
      const storageRequest = Object.freeze({
        collection: CURRENT_APPLICATIONS,
        limit: parsed.limit,
        ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      });
      assertStorageListBoundary(storageRequest);
      const page = exactFounderReviewStoragePage(
        await this.#storage.list(storageRequest),
        parsed,
      );
      const items = await Promise.all(
        page.items.map((record) =>
          decodeFounderApplicationReviewCollectionItem(this.#storage, record)
        ),
      );
      return Object.freeze({
        items: Object.freeze(items),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      if (
        error instanceof StorageFailure &&
        error.code === "INVALID_REQUEST"
      ) {
        throw new StorageFailure("INVALID_REQUEST");
      }
      throw new StorageFailure("UNAVAILABLE");
    }
  }
}

/** Persistent direct detail projection through one opaque review lookup. */
export class StorageFounderApplicationReviewDetailRepository
implements FounderApplicationReviewDetailRepository {
  readonly #storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.#storage = requiredStorageAdapter(storage);
    Object.freeze(this);
  }

  async get(reviewId: unknown): Promise<FounderApplicationReviewItem | null> {
    try {
      return await loadFounderReviewDetail(this.#storage, reviewId);
    } catch (error) {
      if (
        error instanceof StorageFailure &&
        error.code === "INVALID_REQUEST"
      ) {
        throw new StorageFailure("INVALID_REQUEST");
      }
      throw new StorageFailure("UNAVAILABLE");
    }
  }
}

/** Backend-only one-record backfill for applications created before lookup indexing. */
export class StorageFounderApplicationReviewLookupBackfillRepository
implements FounderApplicationReviewLookupBackfillRepository {
  readonly #storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.#storage = requiredStorageAdapter(storage);
    Object.freeze(this);
  }

  async backfill(
    request: FounderApplicationReviewLookupBackfillRequest,
  ): Promise<string> {
    try {
      const source = exactDataObject(request, [
        "applicantSubject",
        "applicationId",
      ]);
      if (source === null) invalidRequest();
      const subject = requiredActorSubject(source.applicantSubject);
      const id = requiredApplicationId(source.applicationId);
      const key = await currentApplicationKey(subject, id);
      const record = await this.#storage.read(key);
      if (record === null) notFound();
      await loadCurrentApplication(this.#storage, record, subject, id);
      return await ensureFounderReviewLookup(this.#storage, subject, id);
    } catch (error) {
      if (
        error instanceof StorageFailure &&
        (error.code === "INVALID_REQUEST" || error.code === "NOT_FOUND")
      ) {
        throw new StorageFailure(error.code);
      }
      throw new StorageFailure("UNAVAILABLE");
    }
  }
}

/**
 * Development owner-review projection over the same adapter records.
 * Opaque review IDs keep applicant subjects out of owner navigation URLs.
 */
export class DevelopmentInMemoryFounderApplicationReviewRepository
implements FounderApplicationReviewRepository {
  readonly storageKind = "development-in-memory" as const;

  readonly #storage: StorageAdapter;
  readonly #permitted: boolean;

  constructor(
    storage: StorageAdapter,
    authenticatedSubject: ActorSubject | null,
    configuredOwnerSubject: ActorSubject,
    contributionAreaChoices: readonly ContributionAreaChoice[],
  ) {
    this.#storage = storage;
    const ownerSubject = requiredActorSubject(configuredOwnerSubject);
    const actorSubject = authenticatedSubject === null
      ? null
      : requiredActorSubject(authenticatedSubject);
    this.#permitted = actorSubject === ownerSubject;

    const parsedChoices = parseContributionAreaChoices(contributionAreaChoices);
    if (!parsedChoices.ok) invalidRequest();
  }

  async list(
    request: FounderApplicationReviewListRequest,
  ): Promise<FounderApplicationReviewPage> {
    if (!this.#permitted) {
      return Object.freeze({ items: Object.freeze([]), nextCursor: null });
    }
    const storageRequest = {
      collection: CURRENT_APPLICATIONS,
      limit: request.limit,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    };
    assertStorageListBoundary(storageRequest);
    const page = await this.#storage.list(storageRequest);
    const reviewItems = await Promise.all(
      page.items.map((record) => this.#decodeReviewItem(record)),
    );
    return Object.freeze({
      items: Object.freeze(reviewItems.map(projectFounderReviewCollectionItem)),
      nextCursor: page.nextCursor,
    });
  }

  async get(reviewId: unknown): Promise<FounderApplicationReviewItem | null> {
    if (!this.#permitted) return null;
    return loadFounderReviewDetail(this.#storage, reviewId);
  }

  async #decodeReviewItem(
    record: StorageRecord,
  ): Promise<FounderApplicationReviewItem> {
    const coordinates = storedApplicationCoordinates(record.value);
    const stored = await loadCurrentApplication(
      this.#storage,
      record,
      coordinates.subject,
      coordinates.id,
    );
    const reviewId = await founderReviewId(coordinates.subject, coordinates.id);
    await requireFounderReviewLookup(
      this.#storage,
      reviewId,
      coordinates.subject,
      coordinates.id,
    );
    return Object.freeze({
      reviewId,
      application: stored.application,
    });
  }
}

function parseFounderReviewListRequest(
  value: unknown,
): FounderApplicationReviewListRequest {
  const source = exactDataObject(value, ["limit"]) ??
    exactDataObject(value, ["limit", "cursor"]);
  if (
    source === null ||
    !Number.isSafeInteger(source.limit) ||
    (source.limit as number) < 1 ||
    (source.limit as number) > MAX_FOUNDER_APPLICATION_REVIEW_PAGE_SIZE
  ) {
    invalidRequest();
  }
  const cursor = Object.hasOwn(source, "cursor")
    ? requiredFounderReviewCursor(source.cursor)
    : undefined;
  return Object.freeze({
    limit: source.limit as number,
    ...(cursor === undefined ? {} : { cursor }),
  });
}

function exactFounderReviewStoragePage(
  value: unknown,
  request: FounderApplicationReviewListRequest,
): Readonly<{
  items: readonly StorageRecord[];
  nextCursor: StorageCursor | null;
}> {
  const source = exactDataObject(value, ["items", "nextCursor"]);
  const candidates = source === null
    ? null
    : exactBoundedArrayValues(source.items, request.limit);
  if (source === null || candidates === null) unavailable();

  const items = candidates.map(exactFounderReviewStorageRecord);
  let priorId: string | null = null;
  for (const item of items) {
    if (
      item.key.collection !== CURRENT_APPLICATIONS ||
      (priorId !== null && priorId >= item.key.id)
    ) {
      unavailable();
    }
    priorId = item.key.id;
  }

  const nextCursor = source.nextCursor === null
    ? null
    : storedFounderReviewCursor(source.nextCursor);
  if (
    nextCursor !== null &&
    (items.length === 0 || nextCursor === request.cursor)
  ) {
    unavailable();
  }
  return Object.freeze({ items: Object.freeze(items), nextCursor });
}

function exactFounderReviewStorageRecord(value: unknown): StorageRecord {
  const source = exactDataObject(value, ["key", "revision", "value"]);
  const keySource = source === null
    ? null
    : exactDataObject(source.key, ["collection", "id"]);
  const parsedKey = keySource === null
    ? null
    : parseStorageKey(keySource.collection, keySource.id);
  if (
    source === null ||
    parsedKey === null ||
    !parsedKey.ok ||
    !Number.isSafeInteger(source.revision) ||
    (source.revision as number) < 1 ||
    objectRecord(source.value) === null
  ) {
    unavailable();
  }
  return Object.freeze({
    key: Object.freeze({ ...parsedKey.value }),
    revision: source.revision as number,
    value: source.value as StorageDocument,
  });
}

async function decodeFounderApplicationReviewCollectionItem(
  storage: StorageAdapter,
  record: StorageRecord,
): Promise<FounderApplicationReviewCollectionItem> {
  const coordinates = storedApplicationCoordinates(record.value);
  const key = await currentApplicationKey(coordinates.subject, coordinates.id);
  const current = decodeStoredCurrent(
    record,
    key,
    coordinates.subject,
    coordinates.id,
  );
  const transitionKey = await applicationHistoryKey(
    coordinates.subject,
    coordinates.id,
    current.revision,
  );
  const transitionRecord = await storage.read(transitionKey);
  if (transitionRecord === null) unavailable();
  const terminal = decodeStoredTransition(
    transitionRecord,
    transitionKey,
    coordinates.subject,
    coordinates.id,
    current.revision,
  );
  verifyCurrentMatchesTerminal(current, terminal);
  const fields = await readStoredFields(
    storage,
    coordinates.subject,
    coordinates.id,
    current.fields,
  );
  const reviewId = await founderReviewId(coordinates.subject, coordinates.id);
  await requireFounderReviewLookup(
    storage,
    reviewId,
    coordinates.subject,
    coordinates.id,
  );
  return Object.freeze({
    reviewId,
    status: current.status,
    primaryContributionAreaId: fields.fields.primaryContributionAreaId,
    updatedAt: current.updatedAt,
    revision: current.revision,
  });
}

function verifyCurrentMatchesTerminal(
  current: StoredCurrent,
  terminal: StoredTransition,
): void {
  const expectedTransitionKind = current.status === "withdrawn"
    ? "withdrawn"
    : current.revision === 1
    ? "created"
    : "edited";
  if (
    terminal.operationId !== current.operationId ||
    terminal.operationFingerprint !== current.operationFingerprint ||
    terminal.transitionKind !== expectedTransitionKind ||
    terminal.status !== current.status ||
    terminal.createdAt !== current.createdAt ||
    terminal.updatedAt !== current.updatedAt ||
    terminal.withdrawnAt !== current.withdrawnAt ||
    terminal.occurredAt !== current.updatedAt ||
    canonicalJson(fieldsReferenceDocument(terminal.fields)) !==
      canonicalJson(fieldsReferenceDocument(current.fields))
  ) {
    unavailable();
  }
}

function projectFounderReviewCollectionItem(
  item: FounderApplicationReviewItem,
): FounderApplicationReviewCollectionItem {
  return Object.freeze({
    reviewId: item.reviewId,
    status: item.application.status,
    primaryContributionAreaId:
      item.application.fields.primaryContributionAreaId,
    updatedAt: item.application.updatedAt,
    revision: item.application.revision,
  });
}

type FounderReviewLookupCoordinates = Readonly<{
  subject: ActorSubject;
  id: FounderApplicationId;
}>;

async function ensureFounderReviewLookup(
  storage: StorageAdapter,
  subject: ActorSubject,
  id: FounderApplicationId,
): Promise<string> {
  const reviewId = await founderReviewId(subject, id);
  const key = founderReviewLookupKey(reviewId);
  const value = founderReviewLookupDocument(reviewId, subject, id);
  const operationId = storedOperationId(
    `founder-review-index:${reviewId.slice("founder-review:".length)}`,
  );
  const transaction: StorageTransactionRequest = Object.freeze({
    operationId,
    mutations: Object.freeze([{
      type: "put" as const,
      key,
      expectedRevision: null,
      value,
    }]),
  });
  if (
    jsonByteLength(transaction) >
      MAX_FOUNDER_APPLICATION_STORAGE_TRANSACTION_BYTES
  ) {
    unavailable();
  }

  try {
    const result = exactStorageTransactionResult(
      await storage.transact(transaction),
      1,
    );
    verifyExactRecord(result.records[0], key, 1, value);
  } catch {
    // A read below distinguishes a committed response loss from no index.
  }

  const record = await storage.read(key);
  if (record === null) unavailable();
  const coordinates = await decodeFounderReviewLookup(
    record,
    key,
    reviewId,
  );
  if (coordinates.subject !== subject || coordinates.id !== id) unavailable();
  return reviewId;
}

async function requireFounderReviewLookup(
  storage: StorageAdapter,
  reviewId: string,
  expectedSubject: ActorSubject,
  expectedId: FounderApplicationId,
): Promise<void> {
  const coordinates = await readFounderReviewLookup(storage, reviewId);
  if (
    coordinates === null ||
    coordinates.subject !== expectedSubject ||
    coordinates.id !== expectedId
  ) {
    unavailable();
  }
}

async function readFounderReviewLookup(
  storage: StorageAdapter,
  reviewId: string,
): Promise<FounderReviewLookupCoordinates | null> {
  const key = founderReviewLookupKey(reviewId);
  const record = await storage.read(key);
  return record === null
    ? null
    : decodeFounderReviewLookup(record, key, reviewId);
}

async function decodeFounderReviewLookup(
  record: unknown,
  expectedKey: StorageKey,
  expectedReviewId: string,
): Promise<FounderReviewLookupCoordinates> {
  const envelope = exactDataObject(record, ["key", "revision", "value"]);
  const key = envelope === null
    ? null
    : exactDataObject(envelope.key, ["collection", "id"]);
  const source = envelope === null
    ? null
    : exactDataObject(envelope.value, [...REVIEW_LOOKUP_DOCUMENT_KEYS]);
  if (
    envelope === null ||
    key === null ||
    source === null ||
    key.collection !== expectedKey.collection ||
    key.id !== expectedKey.id ||
    envelope.revision !== 1 ||
    source.kind !== "founder-review-lookup" ||
    source.schemaVersion !== FOUNDER_APPLICATION_REVIEW_LOOKUP_SCHEMA_VERSION ||
    source.reviewId !== expectedReviewId ||
    jsonByteLength(envelope.value) >
      MAX_FOUNDER_APPLICATION_STORAGE_RECORD_BYTES
  ) {
    unavailable();
  }
  const subject = storedActorSubject(source.applicantSubject);
  const id = storedApplicationId(source.applicationId);
  if (await founderReviewId(subject, id) !== expectedReviewId) unavailable();
  return Object.freeze({ subject, id });
}

function founderReviewLookupDocument(
  reviewId: string,
  subject: ActorSubject,
  id: FounderApplicationId,
): StorageDocument {
  const value = Object.freeze({
    kind: "founder-review-lookup",
    schemaVersion: FOUNDER_APPLICATION_REVIEW_LOOKUP_SCHEMA_VERSION,
    reviewId,
    applicationId: id,
    applicantSubject: subject,
  });
  requireBoundedRecord(value);
  return value;
}

async function loadFounderReviewDetail(
  storage: StorageAdapter,
  reviewId: unknown,
): Promise<FounderApplicationReviewItem | null> {
  const expectedReviewId = requiredReviewId(reviewId);
  const coordinates = await readFounderReviewLookup(storage, expectedReviewId);
  if (coordinates === null) return null;
  const key = await currentApplicationKey(coordinates.subject, coordinates.id);
  const record = await storage.read(key);
  if (record === null) unavailable();

  const stored = await loadCurrentApplication(
    storage,
    record,
    coordinates.subject,
    coordinates.id,
  );
  const actualReviewId = await founderReviewId(
    coordinates.subject,
    coordinates.id,
  );
  if (actualReviewId !== expectedReviewId) unavailable();
  return Object.freeze({
    reviewId: actualReviewId,
    application: stored.application,
  });
}

async function loadCurrentApplication(
  storage: StorageAdapter,
  record: StorageRecord,
  expectedSubject: ActorSubject,
  expectedId: FounderApplicationId,
): Promise<MaterializedApplication> {
  const key = await currentApplicationKey(expectedSubject, expectedId);
  const current = decodeStoredCurrent(
    record,
    key,
    expectedSubject,
    expectedId,
  );
  const materialized = await materializeApplication(
    storage,
    expectedSubject,
    expectedId,
    current.revision,
    null,
  );
  if (
    canonicalJson(
      currentApplicationDocument(
        materialized.application,
        materialized.terminal.operationId,
        materialized.terminal.operationFingerprint,
        materialized.terminal.fields,
      ),
    ) !== canonicalJson(current.document) ||
    canonicalJson(fieldsReferenceDocument(current.fields)) !==
      canonicalJson(fieldsReferenceDocument(materialized.terminal.fields))
  ) {
    unavailable();
  }
  return materialized;
}

async function materializeApplication(
  storage: StorageAdapter,
  subject: ActorSubject,
  id: FounderApplicationId,
  revision: number,
  knownTerminal: StoredTransition | null,
): Promise<MaterializedApplication> {
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    revision > MAX_FOUNDER_APPLICATION_REVISIONS
  ) {
    unavailable();
  }

  const transitions = await Promise.all(
    Array.from({ length: revision }, async (_, index) => {
      const transitionRevision = index + 1;
      if (
        knownTerminal !== null &&
        transitionRevision === knownTerminal.revision
      ) {
        return knownTerminal;
      }
      const key = await applicationHistoryKey(subject, id, transitionRevision);
      const record = await storage.read(key);
      if (record === null) unavailable();
      return decodeStoredTransition(
        record,
        key,
        subject,
        id,
        transitionRevision,
      );
    }),
  );

  const references = new Map<number, StoredFieldsReference>();
  let priorReference: StoredFieldsReference | null = null;
  for (const transition of transitions) {
    if (transition.transitionKind === "withdrawn") {
      if (
        priorReference === null ||
        canonicalJson(fieldsReferenceDocument(priorReference)) !==
          canonicalJson(fieldsReferenceDocument(transition.fields))
      ) {
        unavailable();
      }
    } else if (transition.fields.revision !== transition.revision) {
      unavailable();
    }
    const prior = references.get(transition.fields.revision);
    if (
      prior !== undefined &&
      canonicalJson(fieldsReferenceDocument(prior)) !==
        canonicalJson(fieldsReferenceDocument(transition.fields))
    ) {
      unavailable();
    }
    references.set(transition.fields.revision, transition.fields);
    priorReference = transition.fields;
  }
  const fieldsEntries = await Promise.all(
    [...references.entries()].map(async ([fieldsRevision, reference]) => {
      const stored = await readStoredFields(storage, subject, id, reference);
      return [fieldsRevision, stored] as const;
    }),
  );
  const fieldsByRevision = new Map<number, StoredFields>(fieldsEntries);

  let application: FounderApplication | null = null;
  for (const transition of transitions) {
    const storedFields = fieldsByRevision.get(transition.fields.revision);
    if (storedFields === undefined) unavailable();

    if (transition.revision === 1) {
      if (transition.transitionKind !== "created") unavailable();
      const created = createFounderApplication(
        {
          id,
          applicantSubject: subject,
          occurredAt: transition.occurredAt,
          historyEntryId: transition.historyEntryId,
          fields: storedFields.fields,
        },
        storedFields.choices,
      );
      if (!created.ok) unavailable();
      application = created.value;
    } else if (transition.transitionKind === "edited") {
      if (application === null) unavailable();
      const edited = editFounderApplication(
        application,
        {
          actorSubject: subject,
          occurredAt: transition.occurredAt,
          historyEntryId: transition.historyEntryId,
          fields: storedFields.fields,
        },
        storedFields.choices,
      );
      if (!edited.ok) unavailable();
      application = edited.value;
    } else if (transition.transitionKind === "withdrawn") {
      if (
        application === null ||
        canonicalJson(fieldsDocument(application.fields)) !==
          canonicalJson(fieldsDocument(storedFields.fields))
      ) {
        unavailable();
      }
      const withdrawn = withdrawFounderApplication(application, {
        actorSubject: subject,
        occurredAt: transition.occurredAt,
        historyEntryId: transition.historyEntryId,
      });
      if (!withdrawn.ok) unavailable();
      application = withdrawn.value;
    } else {
      unavailable();
    }

    const entry = application.history.at(-1);
    if (entry === undefined) unavailable();
    const kind = transitionMutationKind(transition.transitionKind);
    const expectedFingerprint = await operationFingerprint(
      kind,
      subject,
      Object.freeze({
        operationId: transition.operationId,
        id,
        occurredAt: transition.occurredAt,
        historyEntryId: transition.historyEntryId,
        expectedRevision: transition.revision === 1
          ? null
          : transition.revision - 1,
        ...(kind === "withdraw" ? {} : { fields: entry.fields }),
      }),
    );
    if (
      expectedFingerprint !== transition.operationFingerprint ||
      canonicalJson(
        applicationTransitionDocument(
          application,
          transition.operationId,
          transition.operationFingerprint,
          transition.fields,
        ),
      ) !== canonicalJson(transition.document)
    ) {
      unavailable();
    }
  }

  if (application === null) unavailable();
  const terminal = transitions.at(-1);
  if (terminal === undefined) unavailable();
  return Object.freeze({ application, terminal, fieldsByRevision });
}

function decodeStoredCurrent(
  record: StorageRecord,
  expectedKey: StorageKey,
  expectedSubject: ActorSubject,
  expectedId: FounderApplicationId,
): StoredCurrent {
  const source = exactStoredDocument(
    record,
    expectedKey,
    CURRENT_DOCUMENT_KEYS,
    "founder-application-current",
  );
  const operationId = storedOperationId(source.operationId);
  const operationFingerprint = storedFingerprint(source.operationFingerprint);
  const applicationId = storedApplicationId(source.applicationId);
  const applicantSubject = storedActorSubject(source.applicantSubject);
  const status = storedFounderApplicationStatus(source.status);
  const createdAt = storedTimestamp(source.createdAt);
  const updatedAt = storedTimestamp(source.updatedAt);
  const withdrawnAt = source.withdrawnAt === null
    ? null
    : storedTimestamp(source.withdrawnAt);
  const revision = storedRevision(source.revision);
  const fields = storedFieldsReference(source.fields);
  if (
    applicationId !== expectedId ||
    applicantSubject !== expectedSubject ||
    record.revision !== revision ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    (status === "received" && withdrawnAt !== null) ||
    (status === "withdrawn" && withdrawnAt !== updatedAt) ||
    (revision === 1 &&
      (status !== "received" || updatedAt !== createdAt)) ||
    (status === "received" && fields.revision !== revision) ||
    (status === "withdrawn" &&
      (revision < 2 || fields.revision !== revision - 1))
  ) {
    unavailable();
  }
  return Object.freeze({
    operationId,
    operationFingerprint,
    applicationId,
    applicantSubject,
    status,
    createdAt,
    updatedAt,
    withdrawnAt,
    revision,
    fields,
    document: record.value,
  });
}

function decodeStoredTransition(
  record: StorageRecord,
  expectedKey: StorageKey,
  expectedSubject: ActorSubject,
  expectedId: FounderApplicationId,
  expectedRevision: number,
): StoredTransition {
  const source = exactStoredDocument(
    record,
    expectedKey,
    TRANSITION_DOCUMENT_KEYS,
    "founder-application-transition",
  );
  const operationId = storedOperationId(source.operationId);
  const operationFingerprint = storedFingerprint(source.operationFingerprint);
  const applicationId = storedApplicationId(source.applicationId);
  const applicantSubject = storedActorSubject(source.applicantSubject);
  const historyEntryId = storedHistoryEntryId(source.historyEntryId);
  const occurredAt = storedTimestamp(source.occurredAt);
  const revision = storedRevision(source.revision);
  const transitionKind = storedTransitionKind(source.transitionKind);
  const status = storedFounderApplicationStatus(source.status);
  const createdAt = storedTimestamp(source.createdAt);
  const updatedAt = storedTimestamp(source.updatedAt);
  const withdrawnAt = source.withdrawnAt === null
    ? null
    : storedTimestamp(source.withdrawnAt);
  const fields = storedFieldsReference(source.fields);
  if (
    applicationId !== expectedId ||
    applicantSubject !== expectedSubject ||
    revision !== expectedRevision ||
    record.revision !== 1
  ) {
    unavailable();
  }
  return Object.freeze({
    operationId,
    operationFingerprint,
    applicationId,
    applicantSubject,
    historyEntryId,
    occurredAt,
    revision,
    transitionKind,
    status,
    createdAt,
    updatedAt,
    withdrawnAt,
    fields,
    document: record.value,
  });
}

function exactStoredDocument(
  record: StorageRecord,
  expectedKey: StorageKey,
  expectedKeys: ReadonlySet<string>,
  expectedKind: string,
): Record<string, unknown> {
  const source = objectRecord(record.value);
  if (
    storageKeyString(record.key) !== storageKeyString(expectedKey) ||
    source === null ||
    !hasExactKeys(source, expectedKeys) ||
    source.kind !== expectedKind ||
    source.schemaVersion !== FOUNDER_APPLICATION_SCHEMA_VERSION ||
    jsonByteLength(record.value) >
      MAX_FOUNDER_APPLICATION_STORAGE_RECORD_BYTES
  ) {
    unavailable();
  }
  return source;
}

async function prepareStoredFields(
  subject: ActorSubject,
  id: FounderApplicationId,
  revision: number,
  fields: FounderApplicationFields,
  choices: readonly ContributionAreaChoice[],
): Promise<StoredFields> {
  const payload = fieldsPayloadDocument(fields, choices);
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
  const bytes = new TextEncoder().encode(serialized);
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_SERIALIZED_FOUNDER_APPLICATION_FIELDS_BYTES
  ) {
    unavailable();
  }
  const reference = Object.freeze({
    revision,
    hash: await hashBytes(bytes),
    bytes: bytes.byteLength,
    chunks: Math.ceil(
      bytes.byteLength / FOUNDER_APPLICATION_FIELDS_CHUNK_RAW_BYTES,
    ),
  });
  if (
    reference.chunks < 1 ||
    reference.chunks > MAX_FOUNDER_APPLICATION_FIELDS_CHUNKS
  ) {
    unavailable();
  }

  const chunks: PreparedFieldsChunk[] = [];
  for (let chunkIndex = 0; chunkIndex < reference.chunks; chunkIndex += 1) {
    const start = chunkIndex * FOUNDER_APPLICATION_FIELDS_CHUNK_RAW_BYTES;
    const part = bytes.slice(
      start,
      Math.min(
        start + FOUNDER_APPLICATION_FIELDS_CHUNK_RAW_BYTES,
        bytes.byteLength,
      ),
    );
    const value = fieldsChunkDocument(
      subject,
      id,
      reference,
      chunkIndex,
      base64UrlEncode(part),
    );
    requireBoundedRecord(value);
    chunks.push(Object.freeze({
      key: await applicationFieldsChunkKey(subject, id, revision, chunkIndex),
      value,
    }));
  }
  return Object.freeze({
    reference,
    fields,
    choices,
    chunks: Object.freeze(chunks),
  });
}

async function readStoredFields(
  storage: StorageAdapter,
  subject: ActorSubject,
  id: FounderApplicationId,
  reference: StoredFieldsReference,
): Promise<StoredFields> {
  const records = await Promise.all(
    Array.from({ length: reference.chunks }, async (_, chunkIndex) => {
      const key = await applicationFieldsChunkKey(
        subject,
        id,
        reference.revision,
        chunkIndex,
      );
      const record = await storage.read(key);
      if (record === null) unavailable();
      const source = exactStoredDocument(
        record,
        key,
        FIELDS_CHUNK_DOCUMENT_KEYS,
        "founder-application-fields-chunk",
      );
      if (
        record.revision !== 1 ||
        source.applicationId !== id ||
        source.applicantSubject !== subject ||
        source.fieldsRevision !== reference.revision ||
        source.fieldsHash !== reference.hash ||
        source.fieldsBytes !== reference.bytes ||
        source.chunkIndex !== chunkIndex ||
        source.chunkCount !== reference.chunks ||
        typeof source.data !== "string"
      ) {
        unavailable();
      }
      const bytes = base64UrlDecode(source.data);
      const expectedBytes = chunkIndex === reference.chunks - 1
        ? reference.bytes -
          chunkIndex * FOUNDER_APPLICATION_FIELDS_CHUNK_RAW_BYTES
        : FOUNDER_APPLICATION_FIELDS_CHUNK_RAW_BYTES;
      if (bytes.byteLength !== expectedBytes) unavailable();
      return Object.freeze({
        bytes,
        chunk: Object.freeze({ key, value: record.value }),
      });
    }),
  );

  const bytes = new Uint8Array(reference.bytes);
  let offset = 0;
  for (const record of records) {
    bytes.set(record.bytes, offset);
    offset += record.bytes.byteLength;
  }
  if (offset !== bytes.byteLength || await hashBytes(bytes) !== reference.hash) {
    unavailable();
  }

  let serialized: string;
  let candidate: unknown;
  try {
    serialized = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    candidate = JSON.parse(serialized);
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
  const source = objectRecord(candidate);
  if (source === null || !hasExactKeys(source, FIELDS_PAYLOAD_KEYS)) {
    unavailable();
  }
  const choices = storedContributionAreaChoices(source.contributionAreaIds);
  const parsedFields = parseFounderApplicationFields(source.fields, choices);
  if (!parsedFields.ok) unavailable();
  if (
    JSON.stringify(fieldsPayloadDocument(parsedFields.value, choices)) !==
      serialized
  ) {
    unavailable();
  }

  return Object.freeze({
    reference,
    fields: parsedFields.value,
    choices,
    chunks: Object.freeze(records.map((record) => record.chunk)),
  });
}

function prepareMutation(
  application: FounderApplication,
  operationId: StorageOperationId,
  operationFingerprint: string,
  fields: StoredFieldsReference,
  fieldsChunks: readonly PreparedFieldsChunk[],
  policy: PreparedPolicyRevision | null,
): PreparedMutation {
  const currentDocument = currentApplicationDocument(
    application,
    operationId,
    operationFingerprint,
    fields,
  );
  const historyDocument = applicationTransitionDocument(
    application,
    operationId,
    operationFingerprint,
    fields,
  );
  requireBoundedRecord(currentDocument);
  requireBoundedRecord(historyDocument);
  return Object.freeze({
    application,
    currentDocument,
    historyDocument,
    fieldsChunks,
    policy,
  });
}

function currentApplicationDocument(
  application: FounderApplication,
  operationId: StorageOperationId,
  operationFingerprint: string,
  fields: StoredFieldsReference,
): StorageDocument {
  return Object.freeze({
    kind: "founder-application-current",
    schemaVersion: FOUNDER_APPLICATION_SCHEMA_VERSION,
    operationId,
    operationFingerprint,
    applicationId: application.id,
    applicantSubject: application.applicantSubject,
    status: application.status,
    createdAt: application.createdAt,
    updatedAt: application.updatedAt,
    withdrawnAt: application.withdrawnAt,
    revision: application.revision,
    fields: fieldsReferenceDocument(fields),
  });
}

function applicationTransitionDocument(
  application: FounderApplication,
  operationId: StorageOperationId,
  operationFingerprint: string,
  fields: StoredFieldsReference,
): StorageDocument {
  const entry = application.history.at(-1);
  if (entry === undefined || entry.revision !== application.revision) {
    unavailable();
  }
  return Object.freeze({
    kind: "founder-application-transition",
    schemaVersion: FOUNDER_APPLICATION_SCHEMA_VERSION,
    operationId,
    operationFingerprint,
    applicationId: application.id,
    applicantSubject: application.applicantSubject,
    historyEntryId: entry.id,
    occurredAt: entry.occurredAt,
    revision: application.revision,
    transitionKind: entry.kind,
    status: application.status,
    createdAt: application.createdAt,
    updatedAt: application.updatedAt,
    withdrawnAt: application.withdrawnAt,
    fields: fieldsReferenceDocument(fields),
  });
}

function fieldsReferenceDocument(
  reference: StoredFieldsReference,
): StorageDocument {
  return Object.freeze({
    revision: reference.revision,
    hash: reference.hash,
    bytes: reference.bytes,
    chunks: reference.chunks,
  });
}

function fieldsChunkDocument(
  subject: ActorSubject,
  id: FounderApplicationId,
  reference: StoredFieldsReference,
  chunkIndex: number,
  data: string,
): StorageDocument {
  return Object.freeze({
    kind: "founder-application-fields-chunk",
    schemaVersion: FOUNDER_APPLICATION_SCHEMA_VERSION,
    applicationId: id,
    applicantSubject: subject,
    fieldsRevision: reference.revision,
    fieldsHash: reference.hash,
    fieldsBytes: reference.bytes,
    chunkIndex,
    chunkCount: reference.chunks,
    data,
  });
}

function fieldsPayloadDocument(
  fields: FounderApplicationFields,
  choices: readonly ContributionAreaChoice[],
): StorageDocument {
  return Object.freeze({
    contributionAreaIds: choices.map((choice) => choice.id),
    fields: fieldsDocument(fields),
  });
}

function fieldsDocument(fields: FounderApplicationFields): StorageDocument {
  return Object.freeze({
    expertiseSummary: fields.expertiseSummary,
    intendedContribution: fields.intendedContribution,
    primaryContributionAreaId: fields.primaryContributionAreaId,
    secondaryContributionAreaIds: [...fields.secondaryContributionAreaIds],
    approximateAvailability: fields.approximateAvailability,
    possibleStartTiming: fields.possibleStartTiming,
    compensationExpectation: fields.compensationExpectation,
    professionalProfileLinks: [...fields.professionalProfileLinks],
    note: fields.note,
  });
}

async function preparePolicyRevision(
  subject: ActorSubject,
  id: FounderApplicationId,
  applicationRevision: number,
  evidence: PolicyRevisionEvidence,
  checkCampaignRevision: FounderApplicationPolicyRevisionCheck,
  verifyCampaignRevision: FounderApplicationPolicyRevisionEvidenceVerifier,
  checkParticipantProfileRevision:
    | FounderApplicationPolicyRevisionCheck
    | null,
  verifyParticipantProfileRevision:
    | FounderApplicationPolicyRevisionEvidenceVerifier
    | null,
): Promise<PreparedPolicyRevision> {
  const parsedApplicationRevision = requiredApplicationRevision(
    applicationRevision,
  );
  const parsedCampaignRevision = requiredPolicyRevision(
    evidence.campaignSetupRevision,
  );
  const parsedParticipantProfileRevision =
    evidence.participantProfileRevision === null
      ? null
      : requiredPolicyRevision(evidence.participantProfileRevision);
  const key = await applicationPolicyRevisionKey(
    subject,
    id,
    parsedApplicationRevision,
  );
  const campaignCheck = await requiredPolicyRevisionCheck(
    checkCampaignRevision,
    parsedCampaignRevision,
  );
  const checks: PreparedPolicyRevisionCheck[] = [{
    mutation: campaignCheck,
    verifyEvidence: verifyCampaignRevision,
  }];
  if (parsedParticipantProfileRevision !== null) {
    if (
      checkParticipantProfileRevision === null ||
      verifyParticipantProfileRevision === null
    ) {
      unavailable();
    }
    checks.push({
      mutation: await requiredPolicyRevisionCheck(
        checkParticipantProfileRevision,
        parsedParticipantProfileRevision,
      ),
      verifyEvidence: verifyParticipantProfileRevision,
    });
  }
  const checkKeys = checks.map((check) => storageKeyString(check.mutation.key));
  if (
    checkKeys.includes(storageKeyString(key)) ||
    new Set(checkKeys).size !== checkKeys.length
  ) {
    unavailable();
  }
  const value = Object.freeze({
    kind: "founder-application-policy-revision",
    schemaVersion: parsedParticipantProfileRevision === null
      ? LEGACY_FOUNDER_APPLICATION_POLICY_SCHEMA_VERSION
      : FOUNDER_APPLICATION_POLICY_SCHEMA_VERSION,
    applicationId: id,
    applicantSubject: subject,
    applicationRevision: parsedApplicationRevision,
    campaignSetupRevision: parsedCampaignRevision,
    ...(parsedParticipantProfileRevision === null
      ? {}
      : { participantProfileRevision: parsedParticipantProfileRevision }),
  });
  requireBoundedRecord(value);
  return Object.freeze({
    key,
    value,
    checks: Object.freeze(checks.map((check) => Object.freeze(check))),
  });
}

function decodePolicyRevision(
  record: unknown,
  expectedKey: StorageKey,
  expectedSubject: ActorSubject,
  expectedId: FounderApplicationId,
  expectedApplicationRevision: number,
): PolicyRevisionEvidence {
  const envelope = exactDataObject(record, ["key", "revision", "value"]);
  const key = envelope === null
    ? null
    : exactDataObject(envelope.key, ["collection", "id"]);
  const currentSource = envelope === null
    ? null
    : exactDataObject(envelope.value, [...POLICY_REVISION_DOCUMENT_KEYS]);
  const legacySource = envelope === null || currentSource !== null
    ? null
    : exactDataObject(envelope.value, [
        ...LEGACY_POLICY_REVISION_DOCUMENT_KEYS,
      ]);
  const source = currentSource ?? legacySource;
  const expectedSchemaVersion = currentSource === null
    ? LEGACY_FOUNDER_APPLICATION_POLICY_SCHEMA_VERSION
    : FOUNDER_APPLICATION_POLICY_SCHEMA_VERSION;
  if (
    envelope === null ||
    key === null ||
    source === null ||
    key.collection !== expectedKey.collection ||
    key.id !== expectedKey.id ||
    envelope.revision !== 1 ||
    source.kind !== "founder-application-policy-revision" ||
    source.schemaVersion !== expectedSchemaVersion ||
    source.applicationId !== expectedId ||
    source.applicantSubject !== expectedSubject ||
    source.applicationRevision !== expectedApplicationRevision ||
    !Number.isSafeInteger(source.campaignSetupRevision) ||
    (source.campaignSetupRevision as number) < 1 ||
    (currentSource !== null &&
      (!Number.isSafeInteger(currentSource.participantProfileRevision) ||
        (currentSource.participantProfileRevision as number) < 1)) ||
    jsonByteLength(envelope.value) >
      MAX_FOUNDER_APPLICATION_STORAGE_RECORD_BYTES
  ) {
    unavailable();
  }
  const participantProfileRevision = currentSource === null
    ? null
    : requiredPolicyRevision(currentSource.participantProfileRevision);
  return Object.freeze({
    campaignSetupRevision: requiredPolicyRevision(
      source.campaignSetupRevision,
    ),
    participantProfileRevision,
  });
}

function parseCreateEnvelope(
  request: CreateFounderApplicationRequest,
): ParsedMutationEnvelope {
  if (request.expectedRevision !== null) invalidRequest();
  return parseMutationEnvelope(request, null, true);
}

function parseEditEnvelope(
  request: EditFounderApplicationRequest,
): ParsedMutationEnvelope {
  return parseMutationEnvelope(
    request,
    requiredExpectedRevision(request.expectedRevision),
    true,
  );
}

function parseWithdrawEnvelope(
  request: WithdrawFounderApplicationRequest,
): ParsedMutationRequest {
  return requestWithoutFields(
    parseMutationEnvelope(
      request,
      requiredExpectedRevision(request.expectedRevision),
      false,
    ),
  );
}

function parseMutationEnvelope(
  request: FounderApplicationMutationRequest &
    Readonly<{ expectedRevision: number | null; fields?: unknown }>,
  expectedRevision: number | null,
  includeFields: boolean,
): ParsedMutationEnvelope {
  const operationId = parseStorageOperationId(request.operationId);
  const id = parseStableId<"founder-application">(request.id);
  const occurredAt = parseTimestamp(request.occurredAt);
  const historyEntryId = parseStableId<"founder-application-history-entry">(
    request.historyEntryId,
  );
  if (!operationId.ok || !id.ok || !occurredAt.ok || !historyEntryId.ok) {
    invalidRequest();
  }
  return Object.freeze({
    operationId: operationId.value,
    id: id.value,
    occurredAt: occurredAt.value,
    historyEntryId: historyEntryId.value,
    expectedRevision,
    ...(includeFields ? { fields: request.fields } : {}),
  });
}

function parseRequestFields(
  envelope: ParsedMutationEnvelope,
  choices: readonly ContributionAreaChoice[],
): ParsedMutationRequest & Readonly<{ fields: FounderApplicationFields }> {
  const fields = parseFounderApplicationFields(envelope.fields, choices);
  if (!fields.ok) invalidRequest();
  return Object.freeze({ ...envelope, fields: fields.value }) as
    ParsedMutationRequest & Readonly<{ fields: FounderApplicationFields }>;
}

function parseKnownOperationFields(
  envelope: ParsedMutationEnvelope,
  historicalChoices: readonly ContributionAreaChoice[],
  currentChoices: readonly ContributionAreaChoice[],
): ParsedMutationRequest & Readonly<{ fields: FounderApplicationFields }> {
  const historical = parseFounderApplicationFields(
    envelope.fields,
    historicalChoices,
  );
  if (!historical.ok) {
    const current = parseFounderApplicationFields(envelope.fields, currentChoices);
    if (current.ok) throw new StorageFailure("CONFLICT");
    invalidRequest();
  }
  return Object.freeze({ ...envelope, fields: historical.value }) as
    ParsedMutationRequest & Readonly<{ fields: FounderApplicationFields }>;
}

function requestWithoutFields(
  envelope: ParsedMutationEnvelope,
): ParsedMutationRequest {
  return Object.freeze({
    operationId: envelope.operationId,
    id: envelope.id,
    occurredAt: envelope.occurredAt,
    historyEntryId: envelope.historyEntryId,
    expectedRevision: envelope.expectedRevision,
  });
}

function requiredExpectedRevision(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) >= MAX_FOUNDER_APPLICATION_REVISIONS
  ) {
    invalidRequest();
  }
  return value as number;
}

function requireCurrentRevision(
  application: FounderApplication,
  expectedRevision: number | null,
): void {
  if (expectedRevision === null || application.revision !== expectedRevision) {
    throw new StorageFailure("PRECONDITION_FAILED");
  }
}

function nextRevision(expectedRevision: number | null): number {
  const revision = expectedRevision === null ? 1 : expectedRevision + 1;
  if (revision > MAX_FOUNDER_APPLICATION_REVISIONS) invalidRequest();
  return revision;
}

async function operationFingerprint(
  kind: MutationKind,
  subject: ActorSubject,
  request: ParsedMutationRequest,
): Promise<string> {
  const payload: StorageDocument = {
    kind,
    operationId: request.operationId,
    applicantSubject: subject,
    expectedRevision: request.expectedRevision,
    id: request.id,
    historyEntryId: request.historyEntryId,
    ...(request.fields === undefined
      ? {}
      : { fields: fieldsDocument(request.fields) }),
  };
  return hashBytes(new TextEncoder().encode(canonicalJson(payload)));
}

function mutationTransitionKind(kind: MutationKind): TransitionKind {
  return kind === "create" ? "created" : kind === "edit" ? "edited" : "withdrawn";
}

function transitionMutationKind(kind: TransitionKind): MutationKind {
  return kind === "created" ? "create" : kind === "edited" ? "edit" : "withdraw";
}

function storedApplicationCoordinates(
  value: StorageDocument,
): Readonly<{ subject: ActorSubject; id: FounderApplicationId }> {
  const source = objectRecord(value);
  if (
    source === null ||
    !hasExactKeys(source, CURRENT_DOCUMENT_KEYS) ||
    source.kind !== "founder-application-current" ||
    source.schemaVersion !== FOUNDER_APPLICATION_SCHEMA_VERSION
  ) {
    unavailable();
  }
  return Object.freeze({
    subject: storedActorSubject(source.applicantSubject),
    id: storedApplicationId(source.applicationId),
  });
}

function storedFieldsReference(value: unknown): StoredFieldsReference {
  const source = objectRecord(value);
  if (
    source === null ||
    !hasExactKeys(source, FIELDS_REFERENCE_KEYS) ||
    !Number.isSafeInteger(source.revision) ||
    (source.revision as number) < 1 ||
    (source.revision as number) > MAX_FOUNDER_APPLICATION_REVISIONS ||
    typeof source.hash !== "string" ||
    !HASH_PATTERN.test(source.hash) ||
    !Number.isSafeInteger(source.bytes) ||
    (source.bytes as number) < 1 ||
    (source.bytes as number) >
      MAX_SERIALIZED_FOUNDER_APPLICATION_FIELDS_BYTES ||
    !Number.isSafeInteger(source.chunks) ||
    (source.chunks as number) !== Math.ceil(
      (source.bytes as number) / FOUNDER_APPLICATION_FIELDS_CHUNK_RAW_BYTES,
    ) ||
    (source.chunks as number) < 1 ||
    (source.chunks as number) > MAX_FOUNDER_APPLICATION_FIELDS_CHUNKS
  ) {
    unavailable();
  }
  return Object.freeze({
    revision: source.revision as number,
    hash: source.hash,
    bytes: source.bytes as number,
    chunks: source.chunks as number,
  });
}

function storedContributionAreaChoices(
  value: unknown,
): readonly ContributionAreaChoice[] {
  if (!Array.isArray(value)) unavailable();
  const parsed = parseContributionAreaChoices(
    value.map((id) => ({ id, label: "Historical contribution area" })),
  );
  if (!parsed.ok || parsed.value.length < 1) unavailable();
  if (
    canonicalJson(value) !==
      canonicalJson(parsed.value.map((choice) => choice.id))
  ) {
    unavailable();
  }
  return parsed.value;
}

function storedOperationId(value: unknown): StorageOperationId {
  const parsed = parseStorageOperationId(value);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function storedApplicationId(value: unknown): FounderApplicationId {
  const parsed = parseStableId<"founder-application">(value);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function storedHistoryEntryId(value: unknown): FounderApplicationHistoryEntryId {
  const parsed = parseStableId<"founder-application-history-entry">(value);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function storedActorSubject(value: unknown): ActorSubject {
  const parsed = parseActorSubject(value);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function storedTimestamp(value: unknown): Timestamp {
  const parsed = parseTimestamp(value);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function storedRevision(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_FOUNDER_APPLICATION_REVISIONS
  ) {
    unavailable();
  }
  return value as number;
}

function storedFingerprint(value: unknown): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) unavailable();
  return value;
}

function storedTransitionKind(value: unknown): TransitionKind {
  if (value !== "created" && value !== "edited" && value !== "withdrawn") {
    unavailable();
  }
  return value;
}

function storedFounderApplicationStatus(
  value: unknown,
): FounderApplication["status"] {
  if (value !== "received" && value !== "withdrawn") unavailable();
  return value;
}

function verifyExactRecord(
  record: unknown,
  expectedKey: StorageKey,
  expectedRevision: number,
  expectedValue: StorageDocument,
): void {
  const envelope = exactDataObject(record, ["key", "revision", "value"]);
  const key = envelope === null
    ? null
    : exactDataObject(envelope.key, ["collection", "id"]);
  if (
    envelope === null ||
    key === null ||
    key.collection !== expectedKey.collection ||
    key.id !== expectedKey.id ||
    envelope.revision !== expectedRevision ||
    !exactJsonDataEqual(envelope.value, expectedValue) ||
    jsonByteLength(envelope.value) >
      MAX_FOUNDER_APPLICATION_STORAGE_RECORD_BYTES
  ) {
    unavailable();
  }
}

async function verifyRevisionCheckRecord(
  record: unknown,
  check: StorageCheckMutation,
  verifyEvidence: FounderApplicationPolicyRevisionEvidenceVerifier,
): Promise<void> {
  const envelope = exactDataObject(record, ["key", "revision", "value"]);
  const key = envelope === null
    ? null
    : exactDataObject(envelope.key, ["collection", "id"]);
  if (
    envelope === null ||
    key === null ||
    check.expectedRevision === null ||
    key.collection !== check.key.collection ||
    key.id !== check.key.id ||
    envelope.revision !== check.expectedRevision
  ) {
    unavailable();
  }
  try {
    await verifyEvidence(record, check.expectedRevision);
  } catch {
    unavailable();
  }
}

async function requiredPolicyRevisionCheck(
  factory: FounderApplicationPolicyRevisionCheck,
  revision: number,
): Promise<StorageCheckMutation> {
  let candidate: unknown;
  try {
    candidate = await factory(revision);
  } catch {
    invalidRequest();
  }
  const source = exactDataObject(candidate, [
    "type",
    "key",
    "expectedRevision",
  ]);
  const keySource = source === null
    ? null
    : exactDataObject(source.key, ["collection", "id"]);
  const key = keySource === null
    ? null
    : parseStorageKey(keySource.collection, keySource.id);
  if (
    source === null ||
    keySource === null ||
    key === null ||
    !key.ok ||
    source.type !== "check" ||
    source.expectedRevision !== revision
  ) {
    invalidRequest();
  }
  return Object.freeze({
    type: "check",
    key: Object.freeze({ ...key.value }),
    expectedRevision: revision,
  });
}

function requiredPolicyRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalidRequest();
  return value as number;
}

function requiredApplicationRevision(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_FOUNDER_APPLICATION_REVISIONS
  ) {
    invalidRequest();
  }
  return value as number;
}

function exactStorageTransactionResult(
  value: unknown,
  expectedRecords: number,
): Readonly<{ replayed: boolean; records: readonly unknown[] }> {
  const source = exactDataObject(value, ["replayed", "records"]);
  const records = source === null
    ? null
    : exactArrayValues(source.records, expectedRecords);
  if (
    source === null ||
    typeof source.replayed !== "boolean" ||
    records === null
  ) {
    unavailable();
  }
  return Object.freeze({ replayed: source.replayed, records });
}

function requireBoundedRecord(value: StorageDocument): void {
  if (
    jsonByteLength(value) > MAX_FOUNDER_APPLICATION_STORAGE_RECORD_BYTES
  ) {
    unavailable();
  }
}

async function founderReviewId(
  subject: ActorSubject,
  id: FounderApplicationId,
): Promise<string> {
  const digest = await hashBytes(
    new TextEncoder().encode(`founder-review\u0000${subject}\u0000${id}`),
  );
  return `founder-review:${digest.slice("sha256:".length)}`;
}

function requiredReviewId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^founder-review:[0-9a-f]{64}$/u.test(value)
  ) {
    invalidRequest();
  }
  return value;
}

function founderReviewLookupKey(reviewId: string): StorageKey {
  return requiredStorageKey(
    APPLICATION_REVIEW_LOOKUPS,
    `founder-review-lookup:${reviewId.slice("founder-review:".length)}`,
  );
}

/** Compatibility name retained for deterministic development fixtures. */
export {
  StorageFounderApplicationRepository as DevelopmentInMemoryFounderApplicationRepository,
};

async function currentApplicationKey(
  subject: ActorSubject,
  id: FounderApplicationId,
): Promise<StorageKey> {
  return requiredStorageKey(
    CURRENT_APPLICATIONS,
    await hashedStorageId("founder-current", `${subject}\u0000${id}`),
  );
}

async function applicationHistoryKey(
  subject: ActorSubject,
  id: FounderApplicationId,
  revision: number,
): Promise<StorageKey> {
  return requiredStorageKey(
    APPLICATION_HISTORY,
    await hashedStorageId(
      "founder-history",
      `${subject}\u0000${id}\u0000${revision}`,
    ),
  );
}

async function applicationPolicyRevisionKey(
  subject: ActorSubject,
  id: FounderApplicationId,
  revision: number,
): Promise<StorageKey> {
  return requiredStorageKey(
    APPLICATION_POLICY_REVISIONS,
    await hashedStorageId(
      "founder-policy",
      `${subject}\u0000${id}\u0000${revision}`,
    ),
  );
}

async function applicationFieldsChunkKey(
  subject: ActorSubject,
  id: FounderApplicationId,
  revision: number,
  chunkIndex: number,
): Promise<StorageKey> {
  return requiredStorageKey(
    APPLICATION_FIELDS,
    await hashedStorageId(
      "founder-fields",
      `${subject}\u0000${id}\u0000${revision}\u0000${chunkIndex}`,
    ),
  );
}

async function hashedStorageId(
  namespace: string,
  value: string,
): Promise<string> {
  const digest = await hashBytes(
    new TextEncoder().encode(`${namespace}\u0000${value}`),
  );
  return `${namespace}:${digest.slice("sha256:".length)}`;
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  let digest: ArrayBuffer;
  try {
    const input = new Uint8Array(bytes.byteLength);
    input.set(bytes);
    digest = await crypto.subtle.digest("SHA-256", input);
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) unavailable();
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/") +
    "=".repeat((4 - value.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64UrlEncode(bytes) !== value) unavailable();
  return bytes;
}

function requiredStorageKey(
  collection: StorageCollection,
  id: string,
): StorageKey {
  const parsed = parseStorageKey(collection, id);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function storageCollection(value: string): StorageCollection {
  const parsed = parseStorageCollection(value);
  if (!parsed.ok) throw new Error("Invalid founder repository collection.");
  return parsed.value;
}

function requiredActorSubject(value: unknown): ActorSubject {
  const parsed = parseActorSubject(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function requiredApplicationId(value: unknown): FounderApplicationId {
  const parsed = parseStableId<"founder-application">(value);
  if (!parsed.ok) invalidRequest();
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
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) =>
        typeof key !== "string" || !expectedKeys.includes(key)
      )
    ) {
      return null;
    }
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
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

function exactArrayValues(
  value: unknown,
  expectedLength: number,
): readonly unknown[] | null {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return null;
    }
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (
      length === undefined ||
      length.enumerable ||
      !("value" in length) ||
      length.value !== expectedLength
    ) {
      return null;
    }
    const expectedKeys = [
      ...Array.from({ length: expectedLength }, (_, index) => String(index)),
      "length",
    ];
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) =>
        typeof key !== "string" || !expectedKeys.includes(key)
      )
    ) {
      return null;
    }
    const values: unknown[] = [];
    for (let index = 0; index < expectedLength; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        return null;
      }
      values.push(descriptor.value);
    }
    return Object.freeze(values);
  } catch {
    return null;
  }
}

function exactBoundedArrayValues(
  value: unknown,
  maximumLength: number,
): readonly unknown[] | null {
  if (!Array.isArray(value) || value.length > maximumLength) return null;
  return exactArrayValues(value, value.length);
}

function requiredFounderReviewCursor(value: unknown): StorageCursor {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_FOUNDER_APPLICATION_REVIEW_CURSOR_CHARACTERS ||
    hasControlCharacter(value)
  ) {
    invalidRequest();
  }
  return value as StorageCursor;
}

function storedFounderReviewCursor(value: unknown): StorageCursor {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_FOUNDER_APPLICATION_REVIEW_CURSOR_CHARACTERS ||
    hasControlCharacter(value)
  ) {
    unavailable();
  }
  return value as StorageCursor;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point <= 31 || point === 127)) return true;
  }
  return false;
}

function requiredStorageAdapter(value: unknown): StorageAdapter {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as StorageAdapter).read !== "function" ||
      typeof (value as StorageAdapter).list !== "function" ||
      typeof (value as StorageAdapter).transact !== "function"
    ) {
      invalidRequest();
    }
    return value as StorageAdapter;
  } catch {
    invalidRequest();
  }
}

function exactJsonDataEqual(actual: unknown, expected: unknown): boolean {
  if (
    actual === null ||
    expected === null ||
    typeof actual !== "object" ||
    typeof expected !== "object"
  ) {
    return Object.is(actual, expected);
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
    const values = exactArrayValues(actual, expected.length);
    return values !== null && values.every((item, index) =>
      exactJsonDataEqual(item, expected[index])
    );
  }
  const expectedKeys = Object.keys(expected);
  const source = exactDataObject(actual, expectedKeys);
  return source !== null && expectedKeys.every((key) =>
    exactJsonDataEqual(
      source[key],
      (expected as Record<string, unknown>)[key],
    )
  );
}

function jsonByteLength(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
  return new TextEncoder().encode(serialized).byteLength;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
    .join(",")}}`;
}

function mutationResult<Application extends FounderApplication>(
  application: Application,
  replayed: boolean,
): FounderApplicationMutationResult<Application> {
  return Object.freeze({
    revision: application.revision,
    snapshot: application,
    replayed,
  });
}

function receivedResult(
  result: FounderApplicationMutationResult,
): FounderApplicationMutationResult<ReceivedFounderApplication> {
  if (result.snapshot.status !== "received") unavailable();
  return result as FounderApplicationMutationResult<ReceivedFounderApplication>;
}

function withdrawnResult(
  result: FounderApplicationMutationResult,
): FounderApplicationMutationResult<WithdrawnFounderApplication> {
  if (result.snapshot.status !== "withdrawn") unavailable();
  return result as FounderApplicationMutationResult<WithdrawnFounderApplication>;
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
