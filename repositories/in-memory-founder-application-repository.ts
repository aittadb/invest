import {
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
  StorageFailure,
  parseStorageCollection,
  parseStorageKey,
  parseStorageOperationId,
  storageKeyString,
  type StorageAdapter,
  type StorageCollection,
  type StorageDocument,
  type StorageKey,
  type StorageOperationId,
  type StorageRecord,
} from "../domain/storage-adapter.ts";

const FOUNDER_APPLICATION_SCHEMA_VERSION = 1;
const CURRENT_APPLICATIONS = storageCollection("founder-applications");
const APPLICATION_HISTORY = storageCollection("founder-application-history");
const STORED_DOCUMENT_KEYS = new Set([
  "kind",
  "schemaVersion",
  "operationId",
  "operationFingerprint",
  "application",
]);

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

type ParsedMutationRequest = Readonly<{
  operationId: StorageOperationId;
  id: FounderApplicationId;
  occurredAt: Timestamp;
  historyEntryId: FounderApplicationHistoryEntryId;
  expectedRevision: number | null;
  fields?: FounderApplicationFields;
}>;

type StoredFounderApplication = Readonly<{
  operationId: StorageOperationId;
  operationFingerprint: string;
  application: FounderApplication;
  document: StorageDocument;
}>;

type MutationKind = "create" | "edit" | "withdraw";

/**
 * Development repository composed entirely through a supplied StorageAdapter.
 * A new instance can reopen every record; no application state lives here.
 */
export class DevelopmentInMemoryFounderApplicationRepository
  implements FounderApplicationRepository
{
  readonly storageKind = "development-in-memory" as const;

  readonly #storage: StorageAdapter;
  readonly #applicantSubject: ActorSubject | null;
  readonly #contributionAreaChoices: readonly ContributionAreaChoice[];

  constructor(
    storage: StorageAdapter,
    authenticatedApplicantSubject: ActorSubject | null,
    contributionAreaChoices: readonly ContributionAreaChoice[],
  ) {
    this.#storage = storage;
    this.#applicantSubject = authenticatedApplicantSubject === null
      ? null
      : requiredActorSubject(authenticatedApplicantSubject);

    const parsedChoices = parseContributionAreaChoices(contributionAreaChoices);
    if (!parsedChoices.ok) invalidRequest();
    this.#contributionAreaChoices = parsedChoices.value;
  }

  async create(
    request: CreateFounderApplicationRequest,
  ): Promise<FounderApplicationMutationResult<ReceivedFounderApplication>> {
    const subject = this.#requiredSubject();
    const parsed = parseCreateRequest(request, this.#contributionAreaChoices);
    const fingerprint = await operationFingerprint("create", subject, parsed);
    const replay = await this.#replayIfKnown(
      parsed,
      subject,
      fingerprint,
    );
    if (replay !== null) return receivedResult(replay);

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
      await this.#writeSnapshot(created.value, parsed, subject, fingerprint),
    );
  }

  async get(id: FounderApplicationId): Promise<FounderApplication | null> {
    const subject = this.#applicantSubject;
    if (subject === null) return null;

    const applicationId = requiredApplicationId(id);
    const stored = await this.#readCurrent(applicationId, subject);
    return stored?.application ?? null;
  }

  async edit(
    request: EditFounderApplicationRequest,
  ): Promise<FounderApplicationMutationResult<ReceivedFounderApplication>> {
    const subject = this.#requiredSubject();
    const parsed = parseEditRequest(request, this.#contributionAreaChoices);
    const fingerprint = await operationFingerprint("edit", subject, parsed);
    const replay = await this.#replayIfKnown(
      parsed,
      subject,
      fingerprint,
    );
    if (replay !== null) return receivedResult(replay);

    const current = await this.#readCurrent(parsed.id, subject);
    if (current === null) notFound();
    requireCurrentRevision(current.application, parsed.expectedRevision);

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
      await this.#writeSnapshot(edited.value, parsed, subject, fingerprint),
    );
  }

  async withdraw(
    request: WithdrawFounderApplicationRequest,
  ): Promise<FounderApplicationMutationResult<WithdrawnFounderApplication>> {
    const subject = this.#requiredSubject();
    const parsed = parseWithdrawRequest(request);
    const fingerprint = await operationFingerprint("withdraw", subject, parsed);
    const replay = await this.#replayIfKnown(
      parsed,
      subject,
      fingerprint,
    );
    if (replay !== null) return withdrawnResult(replay);

    const current = await this.#readCurrent(parsed.id, subject);
    if (current === null) notFound();
    requireCurrentRevision(current.application, parsed.expectedRevision);

    const withdrawn = withdrawFounderApplication(current.application, {
      actorSubject: subject,
      occurredAt: parsed.occurredAt,
      historyEntryId: parsed.historyEntryId,
    });
    if (!withdrawn.ok) invalidRequest();

    return withdrawnResult(
      await this.#writeSnapshot(withdrawn.value, parsed, subject, fingerprint),
    );
  }

  #requiredSubject(): ActorSubject {
    if (this.#applicantSubject === null) notFound();
    return this.#applicantSubject;
  }

  async #readCurrent(
    id: FounderApplicationId,
    subject: ActorSubject,
  ): Promise<StoredFounderApplication | null> {
    const key = await currentApplicationKey(subject, id);
    const record = await this.#storage.read(key);
    if (record === null) return null;

    const stored = await decodeStoredApplication(
      record,
      key,
      "current",
      subject,
      id,
      null,
      this.#contributionAreaChoices,
    );
    if (stored.application.applicantSubject !== subject) return null;
    await this.#verifyImmutableHistory(stored.application, subject);
    return stored;
  }

  async #verifyImmutableHistory(
    application: FounderApplication,
    subject: ActorSubject,
  ): Promise<void> {
    for (let revision = 1; revision <= application.revision; revision += 1) {
      const key = await applicationHistoryKey(subject, application.id, revision);
      const record = await this.#storage.read(key);
      if (record === null) unavailable();
      const historical = await decodeStoredApplication(
        record,
        key,
        "history",
        subject,
        application.id,
        revision,
        this.#contributionAreaChoices,
      );
      if (
        canonicalJson(historyDocument(historical.application.history)) !==
        canonicalJson(historyDocument(application.history.slice(0, revision)))
      ) {
        unavailable();
      }
    }
  }

  async #replayIfKnown(
    request: ParsedMutationRequest,
    subject: ActorSubject,
    fingerprint: string,
  ): Promise<FounderApplicationMutationResult | null> {
    const revision = nextRevision(request.expectedRevision);
    const historyKey = await applicationHistoryKey(
      subject,
      request.id,
      revision,
    );
    const record = await this.#storage.read(historyKey);
    if (record === null) return null;

    const stored = await decodeStoredApplication(
      record,
      historyKey,
      "history",
      subject,
      request.id,
      revision,
      this.#contributionAreaChoices,
    );
    if (stored.operationId !== request.operationId) {
      throw new StorageFailure(
        request.expectedRevision === null ? "CONFLICT" : "PRECONDITION_FAILED",
      );
    }
    if (stored.operationFingerprint !== fingerprint) {
      throw new StorageFailure("CONFLICT");
    }

    return this.#transactSnapshot(
      stored.document,
      stored.application,
      request,
      subject,
    );
  }

  async #writeSnapshot(
    application: FounderApplication,
    request: ParsedMutationRequest,
    subject: ActorSubject,
    fingerprint: string,
  ): Promise<FounderApplicationMutationResult> {
    if (application.revision !== nextRevision(request.expectedRevision)) {
      unavailable();
    }
    const document = founderApplicationDocument(
      application,
      request.operationId,
      fingerprint,
    );
    return this.#transactSnapshot(document, application, request, subject);
  }

  async #transactSnapshot(
    document: StorageDocument,
    expectedApplication: FounderApplication,
    request: ParsedMutationRequest,
    subject: ActorSubject,
  ): Promise<FounderApplicationMutationResult> {
    const currentKey = await currentApplicationKey(subject, request.id);
    const historyKey = await applicationHistoryKey(
      subject,
      request.id,
      expectedApplication.revision,
    );
    const result = await this.#storage.transact({
      operationId: request.operationId,
      mutations: [
        {
          type: "put",
          key: currentKey,
          expectedRevision: request.expectedRevision,
          value: document,
        },
        {
          type: "put",
          key: historyKey,
          expectedRevision: null,
          value: document,
        },
      ],
    });

    const currentRecord = result.records[0];
    const historyRecord = result.records[1];
    if (!currentRecord || !historyRecord) unavailable();

    const current = await decodeStoredApplication(
      currentRecord,
      currentKey,
      "current",
      subject,
      request.id,
      expectedApplication.revision,
      this.#contributionAreaChoices,
    );
    const historical = await decodeStoredApplication(
      historyRecord,
      historyKey,
      "history",
      subject,
      request.id,
      expectedApplication.revision,
      this.#contributionAreaChoices,
    );
    if (
      canonicalJson(applicationSnapshotDocument(current.application)) !==
        canonicalJson(applicationSnapshotDocument(historical.application)) ||
      canonicalJson(applicationSnapshotDocument(current.application)) !==
        canonicalJson(applicationSnapshotDocument(expectedApplication))
    ) {
      unavailable();
    }
    await this.#verifyImmutableHistory(current.application, subject);

    return mutationResult(
      current.application,
      result.replayed,
    );
  }
}

function parseCreateRequest(
  request: CreateFounderApplicationRequest,
  choices: readonly ContributionAreaChoice[],
): ParsedMutationRequest & Readonly<{ fields: FounderApplicationFields }> {
  if (request.expectedRevision !== null) invalidRequest();
  return parseMutationRequest(request, null, choices, true) as
    ParsedMutationRequest & Readonly<{ fields: FounderApplicationFields }>;
}

function parseEditRequest(
  request: EditFounderApplicationRequest,
  choices: readonly ContributionAreaChoice[],
): ParsedMutationRequest & Readonly<{ fields: FounderApplicationFields }> {
  return parseMutationRequest(
    request,
    requiredExpectedRevision(request.expectedRevision),
    choices,
    true,
  ) as ParsedMutationRequest & Readonly<{ fields: FounderApplicationFields }>;
}

function parseWithdrawRequest(
  request: WithdrawFounderApplicationRequest,
): ParsedMutationRequest {
  return parseMutationRequest(
    request,
    requiredExpectedRevision(request.expectedRevision),
    Object.freeze([]),
    false,
  );
}

function parseMutationRequest(
  request: FounderApplicationMutationRequest &
    Readonly<{ expectedRevision: number | null; fields?: unknown }>,
  expectedRevision: number | null,
  choices: readonly ContributionAreaChoice[],
  requiresFields: boolean,
): ParsedMutationRequest {
  const operationId = parseStorageOperationId(request.operationId);
  const id = parseStableId<"founder-application">(request.id);
  const occurredAt = parseTimestamp(request.occurredAt);
  const historyEntryId = parseStableId<"founder-application-history-entry">(
    request.historyEntryId,
  );
  const fields = requiresFields
    ? parseFounderApplicationFields(request.fields, choices)
    : null;
  if (
    !operationId.ok ||
    !id.ok ||
    !occurredAt.ok ||
    !historyEntryId.ok ||
    (fields !== null && !fields.ok)
  ) {
    invalidRequest();
  }

  return Object.freeze({
    operationId: operationId.value,
    id: id.value,
    occurredAt: occurredAt.value,
    historyEntryId: historyEntryId.value,
    expectedRevision,
    ...(fields === null ? {} : { fields: fields.value }),
  });
}

function requiredExpectedRevision(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) >= Number.MAX_SAFE_INTEGER
  ) {
    invalidRequest();
  }
  return value as number;
}

function requireCurrentRevision(
  application: FounderApplication,
  expectedRevision: number | null,
): void {
  if (
    expectedRevision === null ||
    application.revision !== expectedRevision
  ) {
    throw new StorageFailure("PRECONDITION_FAILED");
  }
}

function nextRevision(expectedRevision: number | null): number {
  return expectedRevision === null ? 1 : expectedRevision + 1;
}

async function decodeStoredApplication(
  record: StorageRecord,
  expectedKey: StorageKey,
  recordKind: "current" | "history",
  expectedSubject: ActorSubject,
  expectedId: FounderApplicationId,
  expectedApplicationRevision: number | null,
  choices: readonly ContributionAreaChoice[],
): Promise<StoredFounderApplication> {
  if (storageKeyString(record.key) !== storageKeyString(expectedKey)) {
    unavailable();
  }

  const source = objectRecord(record.value);
  if (
    source === null ||
    !hasExactKeys(source, STORED_DOCUMENT_KEYS) ||
    source.kind !== "founder-application-snapshot" ||
    source.schemaVersion !== FOUNDER_APPLICATION_SCHEMA_VERSION ||
    typeof source.operationFingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(source.operationFingerprint)
  ) {
    unavailable();
  }

  const operationId = parseStorageOperationId(source.operationId);
  if (!operationId.ok) unavailable();
  const application = reconstructFounderApplication(source.application, choices);
  if (
    application.id !== expectedId ||
    application.applicantSubject !== expectedSubject ||
    (expectedApplicationRevision !== null &&
      application.revision !== expectedApplicationRevision) ||
    (recordKind === "current" && record.revision !== application.revision) ||
    (recordKind === "history" && record.revision !== 1)
  ) {
    unavailable();
  }

  const expectedFingerprint = await fingerprintForStoredApplication(
    application,
    operationId.value,
  );
  if (expectedFingerprint !== source.operationFingerprint) unavailable();

  return Object.freeze({
    operationId: operationId.value,
    operationFingerprint: source.operationFingerprint,
    application,
    document: record.value,
  });
}

function reconstructFounderApplication(
  value: unknown,
  choices: readonly ContributionAreaChoice[],
): FounderApplication {
  const source = objectRecord(value);
  if (source === null || !Array.isArray(source.history) || source.history.length < 1) {
    unavailable();
  }

  const first = objectRecord(source.history[0]);
  if (first === null || first.kind !== "created") unavailable();
  const created = createFounderApplication(
    {
      id: source.id,
      applicantSubject: source.applicantSubject,
      occurredAt: first.occurredAt,
      historyEntryId: first.id,
      fields: first.fields,
    },
    choices,
  );
  if (!created.ok) unavailable();

  let application: FounderApplication = created.value;
  for (const candidate of source.history.slice(1)) {
    const entry = objectRecord(candidate);
    if (entry === null) unavailable();

    if (entry.kind === "edited") {
      const edited = editFounderApplication(
        application,
        {
          actorSubject: application.applicantSubject,
          occurredAt: entry.occurredAt,
          historyEntryId: entry.id,
          fields: entry.fields,
        },
        choices,
      );
      if (!edited.ok) unavailable();
      application = edited.value;
      continue;
    }

    if (entry.kind === "withdrawn") {
      const withdrawn = withdrawFounderApplication(application, {
        actorSubject: application.applicantSubject,
        occurredAt: entry.occurredAt,
        historyEntryId: entry.id,
      });
      if (!withdrawn.ok) unavailable();
      application = withdrawn.value;
      continue;
    }

    unavailable();
  }

  if (
    canonicalJson(applicationSnapshotDocument(application)) !==
    canonicalJson(value)
  ) {
    unavailable();
  }
  return application;
}

function founderApplicationDocument(
  application: FounderApplication,
  operationId: StorageOperationId,
  operationFingerprint: string,
): StorageDocument {
  return Object.freeze({
    kind: "founder-application-snapshot",
    schemaVersion: FOUNDER_APPLICATION_SCHEMA_VERSION,
    operationId,
    operationFingerprint,
    application: applicationSnapshotDocument(application),
  });
}

function applicationSnapshotDocument(
  application: FounderApplication,
): StorageDocument {
  return {
    id: application.id,
    applicantSubject: application.applicantSubject,
    fields: fieldsDocument(application.fields),
    status: application.status,
    createdAt: application.createdAt,
    updatedAt: application.updatedAt,
    withdrawnAt: application.withdrawnAt,
    revision: application.revision,
    history: historyDocument(application.history),
  };
}

function historyDocument(
  history: FounderApplication["history"],
): readonly StorageDocument[] {
  return history.map((entry) => ({
      id: entry.id,
      applicationId: entry.applicationId,
      applicantSubject: entry.applicantSubject,
      occurredAt: entry.occurredAt,
      revision: entry.revision,
      kind: entry.kind,
      status: entry.status,
      fields: fieldsDocument(entry.fields),
    }));
}

function fieldsDocument(fields: FounderApplicationFields): StorageDocument {
  return {
    expertiseSummary: fields.expertiseSummary,
    intendedContribution: fields.intendedContribution,
    primaryContributionAreaId: fields.primaryContributionAreaId,
    secondaryContributionAreaIds: [...fields.secondaryContributionAreaIds],
    approximateAvailability: fields.approximateAvailability,
    possibleStartTiming: fields.possibleStartTiming,
    compensationExpectation: fields.compensationExpectation,
    professionalProfileLinks: [...fields.professionalProfileLinks],
    note: fields.note,
  };
}

async function fingerprintForStoredApplication(
  application: FounderApplication,
  operationId: StorageOperationId,
): Promise<string> {
  const entry = application.history[application.history.length - 1];
  if (entry === undefined) unavailable();
  const kind: MutationKind = entry.kind === "created"
    ? "create"
    : entry.kind === "edited"
      ? "edit"
      : "withdraw";
  return operationFingerprint(
    kind,
    application.applicantSubject,
    Object.freeze({
      operationId,
      id: application.id,
      occurredAt: entry.occurredAt,
      historyEntryId: entry.id,
      expectedRevision: application.revision === 1
        ? null
        : application.revision - 1,
      ...(kind === "withdraw" ? {} : { fields: entry.fields }),
    }),
  );
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
    occurredAt: request.occurredAt,
    historyEntryId: request.historyEntryId,
    ...(request.fields === undefined
      ? {}
      : { fields: fieldsDocument(request.fields) }),
  };

  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalJson(payload)),
    );
  } catch {
    unavailable();
  }
  const hexadecimal = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hexadecimal}`;
}

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

async function hashedStorageId(
  namespace: string,
  value: string,
): Promise<string> {
  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${namespace}\u0000${value}`),
    );
  } catch {
    unavailable();
  }
  const hexadecimal = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${namespace}:${hexadecimal}`;
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
