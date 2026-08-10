import {
  createPackageAcceptance,
  createPackageVersion,
  PACKAGE_CONTENT_LIMITS,
  requiresRenewedAcceptance,
  type PackageAcceptanceRecord,
  type PackageContentHash,
  type PackageSection,
  type PackageVersion,
} from "../domain/package-content.ts";
import {
  prepareAuditAppend,
  verifyPreparedAuditAppend,
} from "./in-memory-audit-notification-repositories.ts";
import {
  parseActorSubject,
  parseStableId,
  parseTimestamp,
  type ActorSubject,
  type StableId,
  type Timestamp,
} from "../domain/foundation.ts";
import {
  StorageFailure,
  parseStorageCollection,
  parseStorageKey,
  type StorageAdapter,
  type StorageCollection,
  type StorageDocument,
  type StorageKey,
  type StorageOperationId,
  type StorageRecord,
  type StorageTransactionRequest,
} from "../domain/storage-adapter.ts";

export type RevisionedSnapshot<Value> = Readonly<{
  revision: number;
  snapshot: Value;
}>;

export type RepositoryMutationResult<Value> = RevisionedSnapshot<Value> &
  Readonly<{ replayed: boolean }>;

export type AppendPackageVersionRequest = Readonly<{
  operationId: StorageOperationId;
  expectedRevision: number | null;
  draft: unknown;
  mutationFingerprint?: string;
}>;

export type AppendPackageVersionWithAuditRequest =
  AppendPackageVersionRequest & Readonly<{
    ownerSubject: ActorSubject;
  }>;

export interface PackageVersionRepository {
  append(
    request: AppendPackageVersionRequest,
  ): Promise<RepositoryMutationResult<PackageVersion>>;
  current(): Promise<RevisionedSnapshot<PackageVersion> | null>;
  get(id: StableId<"package-version">): Promise<PackageVersion | null>;
}

export type CurrentPackageAcceptanceBinding = Readonly<{
  bindingRevision: number;
  snapshot: PackageVersion;
}>;

export type CurrentPackageAcceptanceStatus = Readonly<{
  bindingRevision: number;
  versionId: StableId<"package-version">;
  contentHash: PackageContentHash;
  requiredAcceptanceHash: PackageContentHash;
  requiresCurrentAcceptance: boolean;
}>;

/** Package reads that can atomically fence acceptance against the current head. */
export interface AcceptanceBoundPackageVersionRepository
  extends PackageVersionRepository
{
  currentAcceptanceBinding(): Promise<CurrentPackageAcceptanceBinding | null>;
}

/** Owner mutations commit the immutable version and closed audit evidence together. */
export interface AtomicPackageVersionAuditRepository
  extends PackageVersionRepository
{
  readonly mutationConsistency: "atomic-package-version-audit";
  appendWithAudit(
    request: AppendPackageVersionWithAuditRequest,
  ): Promise<RepositoryMutationResult<PackageVersion>>;
}

export type RecordPackageAcceptanceRequest = Readonly<{
  operationId: StorageOperationId;
  expectedRevision: number | null;
  id: StableId<"package-acceptance">;
  acceptedAt: Timestamp;
  acceptedVersionId: StableId<"package-version">;
}>;

export interface AcknowledgmentRepository {
  record(
    request: RecordPackageAcceptanceRequest,
  ): Promise<RepositoryMutationResult<PackageAcceptanceRecord>>;
  latest(): Promise<RevisionedSnapshot<PackageAcceptanceRecord> | null>;
  get(
    id: StableId<"package-acceptance">,
  ): Promise<PackageAcceptanceRecord | null>;
  currentAcceptanceStatus(): Promise<CurrentPackageAcceptanceStatus>;
  requiresCurrentAcceptance(): Promise<boolean>;
}

type StoredPackageVersion = Readonly<{
  snapshot: PackageVersion;
  operationId: StorageOperationId;
  previousVersionId: StableId<"package-version"> | null;
  mutationFingerprint: string;
  acceptanceBindingExpectedRevision: number | null;
  ancestryLength: number;
  reconstructionReadCount: number;
}>;

type PackageReconstructionContext = {
  remainingReads: number;
  readonly versionIds: Set<string>;
};

type PackageMutationFingerprint = Readonly<{
  source: "computed" | "supplied";
  value: string;
}>;

type StoredPackageOperationIntent = Readonly<{
  operationId: StorageOperationId;
  mode: "owner" | "unaudited";
  ownerSubject: ActorSubject | null;
  expectedOwnerRevision: number | null;
  mutationFingerprint: PackageMutationFingerprint;
  previousVersionId: StableId<"package-version"> | null;
  acceptanceBindingExpectedRevision: number | null;
  packageVersionId: StableId<"package-version">;
  createdAt: Timestamp;
  normalizedMutationHash: string;
}>;

type StoredPackageAcceptance = Readonly<{
  snapshot: PackageAcceptanceRecord;
  packageBindingExpectedRevision: number;
}>;

const PACKAGE_VERSIONS = storageCollection("private-package-versions");
const PACKAGE_OPERATION_INTENTS = storageCollection(
  "private-package-operation-intents",
);
const PACKAGE_VERSION_SECTIONS = storageCollection(
  "private-package-version-sections",
);
const PACKAGE_SECTION_CHUNKS = storageCollection(
  "private-package-section-chunks",
);
const PACKAGE_VERSION_HEADS = storageCollection("private-package-version-heads");
const PACKAGE_ACCEPTANCE_BINDINGS = storageCollection(
  "private-package-acceptance-bindings",
);
const PACKAGE_ACCEPTANCES = storageCollection("private-package-acceptances");
const PACKAGE_ACCEPTANCE_HEADS = storageCollection(
  "private-package-acceptance-heads",
);
const CURRENT_PACKAGE_ID = stableId<"storage-record">("current-package");
const MAX_PACKAGE_SECTION_RECORD_BYTES = 60_000;
const MAX_PACKAGE_SECTION_CHUNKS = 16;
const MAX_ACCEPTANCE_GATE_READ_ATTEMPTS = 3;
export const PACKAGE_STORAGE_READ_LIMITS = Object.freeze({
  maxVersionAncestry: 32,
  maxReconstructionReads: 512,
});

function createPackageReconstructionContext(): PackageReconstructionContext {
  return {
    remainingReads: PACKAGE_STORAGE_READ_LIMITS.maxReconstructionReads,
    versionIds: new Set<string>(),
  };
}

/**
 * Immutable package repository over a credential-bound StorageAdapter.
 * It keeps no process-local state and is suitable for hosted or test adapters.
 */
export class StoragePackageVersionRepository
  implements
    AtomicPackageVersionAuditRepository,
    AcceptanceBoundPackageVersionRepository
{
  readonly mutationConsistency = "atomic-package-version-audit" as const;
  readonly #storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.#storage = storage;
  }

  async append(
    request: AppendPackageVersionRequest,
  ): Promise<RepositoryMutationResult<PackageVersion>> {
    return this.#append(request, null);
  }

  async appendWithAudit(
    request: AppendPackageVersionWithAuditRequest,
  ): Promise<RepositoryMutationResult<PackageVersion>> {
    return this.#append(request, requiredActorSubject(request.ownerSubject));
  }

  async #append(
    request: AppendPackageVersionRequest,
    ownerSubject: ActorSubject | null,
  ): Promise<RepositoryMutationResult<PackageVersion>> {
    const existingIntent = await this.#readOperationIntent(request.operationId);
    let incomingDraft = request.draft;
    let draftForParsing = request.draft;
    if (existingIntent !== null) {
      const exactDraft = exactIncomingPackageVersionDraft(request.draft);
      incomingDraft = exactDraft;
      draftForParsing = { ...exactDraft, createdAt: existingIntent.createdAt };
    }
    const mutationFingerprint = await packageMutationFingerprint(
      request,
      incomingDraft,
    );
    const versionId = packageVersionIdFromDraft(incomingDraft);
    const key = packageVersionKey(versionId);

    let previousVersionId: StableId<"package-version"> | null;
    let previousVersion: PackageVersion | null;
    let previousVersionAncestry: number;
    let previousReconstructionReadCount: number;
    let acceptanceBindingExpectedRevision: number | null;
    if (existingIntent !== null) {
      requireIntentRequestMatch(
        existingIntent,
        request,
        versionId,
        mutationFingerprint,
        ownerSubject,
      );
      previousVersionId = existingIntent.previousVersionId;
      const previous = previousVersionId === null
        ? null
        : await this.#readStoredVersion(packageVersionKey(previousVersionId));
      if (previousVersionId !== null && previous === null) unavailable();
      previousVersion = previous?.snapshot ?? null;
      previousVersionAncestry = previous?.ancestryLength ?? 0;
      previousReconstructionReadCount = previous?.reconstructionReadCount ?? 0;
      acceptanceBindingExpectedRevision =
        existingIntent.acceptanceBindingExpectedRevision;
    } else {
      const current = await this.#readCurrentStored();
      previousVersionId = current?.stored.snapshot.id ?? null;
      previousVersion = current?.stored.snapshot ?? null;
      previousVersionAncestry = current?.stored.ancestryLength ?? 0;
      previousReconstructionReadCount =
        current?.stored.reconstructionReadCount ?? 0;
      if (current === null) {
        acceptanceBindingExpectedRevision = null;
      } else {
        const binding = await this.#readAcceptanceBinding(
          current.stored.snapshot,
        );
        if (binding === null) unavailable();
        acceptanceBindingExpectedRevision = binding.revision;
      }
    }
    if (
      previousVersionAncestry >=
        PACKAGE_STORAGE_READ_LIMITS.maxVersionAncestry
    ) unavailable();

    let parsed: PackageVersion;
    try {
      parsed = await parseIncomingPackageVersion(draftForParsing, previousVersion);
    } catch (error) {
      if (existingIntent !== null) conflict();
      throw error;
    }
    const resultingReconstructionReadCount =
      1 + previousReconstructionReadCount +
      packageVersionReconstructionRecordCount(parsed);
    if (
      resultingReconstructionReadCount >
        PACKAGE_STORAGE_READ_LIMITS.maxReconstructionReads
    ) unavailable();
    const normalizedMutationHash = await packageNormalizedMutationHash(parsed);
    const intent = packageOperationIntent(
      request,
      parsed,
      previousVersionId,
      acceptanceBindingExpectedRevision,
      mutationFingerprint,
      normalizedMutationHash,
      ownerSubject,
    );
    if (
      existingIntent !== null &&
      existingIntent.normalizedMutationHash !== normalizedMutationHash
    ) conflict();
    await this.#persistOperationIntent(intent);

    const sectionRecordIds = await this.#stagePackageSections(
      request.operationId,
      parsed,
    );
    const versionDocument = packageVersionDocument(
      parsed,
      request.operationId,
      previousVersionId,
      mutationFingerprint.value,
      acceptanceBindingExpectedRevision,
      sectionRecordIds,
    );
    if (storageDocumentBytes(versionDocument) > MAX_PACKAGE_SECTION_RECORD_BYTES) {
      unavailable();
    }
    const preparedAudit = ownerSubject === null
      ? null
      : await packageVersionAudit(
          request.operationId,
          parsed,
          previousVersionId,
          ownerSubject,
        );
    const headKey = packageVersionHeadKey();
    const mutations: StorageTransactionRequest["mutations"] = [
      {
        type: "put",
        key,
        expectedRevision: null,
        value: versionDocument,
      },
      {
        type: "put",
        key: headKey,
        expectedRevision: intent.expectedOwnerRevision,
        value: packageHeadDocument(parsed.id),
      },
      {
        type: "put",
        key: packageAcceptanceBindingKey(),
        expectedRevision: acceptanceBindingExpectedRevision,
        value: packageAcceptanceBindingDocument(parsed),
      },
      ...(preparedAudit === null ? [] : [preparedAudit.mutation]),
    ];
    const transaction: StorageTransactionRequest = Object.freeze({
      operationId: request.operationId,
      mutations: Object.freeze(mutations),
    });
    const result = verifyPutTransactionResult(
      transaction,
      await this.#storage.transact(transaction),
    );
    const head = result.records[1];
    if (head === undefined) unavailable();
    if (preparedAudit !== null) {
      verifyPreparedAuditAppend(preparedAudit, result.records[3]);
    }
    return mutationResult(head.revision, parsed, result.replayed);
  }

  async current(): Promise<RevisionedSnapshot<PackageVersion> | null> {
    const current = await this.#readCurrentStored();
    return current === null
      ? null
      : revisioned(current.headRevision, current.stored.snapshot);
  }

  async get(
    id: StableId<"package-version">,
  ): Promise<PackageVersion | null> {
    const stored = await this.#readStoredVersion(packageVersionKey(id));
    return stored?.snapshot ?? null;
  }

  async currentAcceptanceBinding(): Promise<
    CurrentPackageAcceptanceBinding | null
  > {
    const context = createPackageReconstructionContext();
    const binding = await this.#readAcceptanceGate(context);
    if (binding === null) return null;
    const stored = await this.#readStoredVersion(
      packageVersionKey(binding.versionId),
      context,
    );
    if (
      stored === null ||
      stored.snapshot.requiredAcceptanceHash !== binding.requiredAcceptanceHash
    ) unavailable();
    return Object.freeze({
      bindingRevision: binding.revision,
      snapshot: stored.snapshot,
    });
  }

  async #readOperationIntent(
    operationId: StorageOperationId,
    context?: PackageReconstructionContext,
  ): Promise<StoredPackageOperationIntent | null> {
    const key = packageOperationIntentKey(operationId);
    const value = context === undefined
      ? await this.#storage.read(key)
      : await this.#readPackageRecord(key, context);
    if (value === null) return null;
    const { source } = exactStoredDocument(value, key, true, [
      "schemaVersion",
      "kind",
      "operationId",
      "mode",
      "ownerSubject",
      "expectedOwnerRevision",
      "mutationFingerprintSource",
      "mutationFingerprint",
      "previousVersionId",
      "acceptanceBindingExpectedRevision",
      "packageVersionId",
      "createdAt",
      "normalizedMutationHash",
    ]);
    if (
      source.schemaVersion !== 1 ||
      source.kind !== "package-operation-intent" ||
      parseRequiredStableId<"storage-operation">(source.operationId) !==
        operationId ||
      (source.mode !== "owner" && source.mode !== "unaudited") ||
      (source.mode === "owner" && source.ownerSubject === null) ||
      (source.mode === "unaudited" && source.ownerSubject !== null) ||
      (source.mutationFingerprintSource !== "computed" &&
        source.mutationFingerprintSource !== "supplied")
    ) unavailable();
    const ownerSubject = source.ownerSubject === null
      ? null
      : storedActorSubject(source.ownerSubject);
    return Object.freeze({
      operationId,
      mode: source.mode,
      ownerSubject,
      expectedOwnerRevision: storedExpectedRevision(
        source.expectedOwnerRevision,
      ),
      mutationFingerprint: Object.freeze({
        source: source.mutationFingerprintSource,
        value: storedMutationFingerprint(source.mutationFingerprint),
      }),
      previousVersionId: parseNullableStableId<"package-version">(
        source.previousVersionId,
      ),
      acceptanceBindingExpectedRevision: storedExpectedRevision(
        source.acceptanceBindingExpectedRevision,
      ),
      packageVersionId: parseRequiredStableId<"package-version">(
        source.packageVersionId,
      ),
      createdAt: storedTimestamp(source.createdAt),
      normalizedMutationHash: storedMutationFingerprint(
        source.normalizedMutationHash,
      ),
    });
  }

  async #persistOperationIntent(
    intent: StoredPackageOperationIntent,
  ): Promise<void> {
    const key = packageOperationIntentKey(intent.operationId);
    const value = packageOperationIntentDocument(intent);
    const operationId = await hashedStableId<"storage-operation">(
      "package-intent",
      intent.operationId,
    );
    const transaction: StorageTransactionRequest = Object.freeze({
      operationId,
      mutations: Object.freeze([Object.freeze({
        type: "put" as const,
        key,
        expectedRevision: null,
        value,
      })]),
    });
    verifyPutTransactionResult(
      transaction,
      await this.#storage.transact(transaction),
    );
  }

  async #stagePackageSections(
    operationId: StorageOperationId,
    version: PackageVersion,
  ): Promise<readonly StableId<"storage-record">[]> {
    const sectionRecordIds: StableId<"storage-record">[] = [];
    for (const section of version.sections) {
      const sectionRecordId = await packageSectionRecordId(
        operationId,
        version.id,
        section.id,
      );
      const chunks = splitPackageSectionMarkdown(version.id, section);
      if (chunks.length > MAX_PACKAGE_SECTION_CHUNKS) unavailable();
      const chunkRecordIds: StableId<"storage-record">[] = [];
      for (const [index, markdown] of chunks.entries()) {
        const chunkRecordId = await packageSectionChunkRecordId(
          operationId,
          version.id,
          section.id,
          index,
        );
        await this.#stageRecord(
          operationId,
          packageSectionChunkKey(chunkRecordId),
          packageSectionChunkDocument(version.id, section.id, index, markdown),
        );
        chunkRecordIds.push(chunkRecordId);
      }
      await this.#stageRecord(
        operationId,
        packageSectionKey(sectionRecordId),
        packageSectionDocument(version.id, section, chunkRecordIds),
      );
      sectionRecordIds.push(sectionRecordId);
    }
    return Object.freeze(sectionRecordIds);
  }

  async #stageRecord(
    operationId: StorageOperationId,
    key: StorageKey,
    value: StorageDocument,
  ): Promise<void> {
    if (storageDocumentBytes(value) > MAX_PACKAGE_SECTION_RECORD_BYTES) {
      unavailable();
    }
    const stageOperationId = await hashedStableId<"storage-operation">(
      "package-stage",
      `${operationId}\u0000${key.collection}\u0000${key.id}`,
    );
    const transaction: StorageTransactionRequest = Object.freeze({
      operationId: stageOperationId,
      mutations: Object.freeze([Object.freeze({
        type: "put" as const,
        key,
        expectedRevision: null,
        value,
      })]),
    });
    verifyPutTransactionResult(
      transaction,
      await this.#storage.transact(transaction),
    );
  }

  async #readCurrentStored(): Promise<Readonly<{
    headRevision: number;
    stored: StoredPackageVersion;
  }> | null> {
    const context = createPackageReconstructionContext();
    const headKey = packageVersionHeadKey();
    const value = await this.#readPackageRecord(headKey, context);
    if (value === null) return null;
    const { record: head, source } = exactStoredDocument(
      value,
      headKey,
      false,
      ["schemaVersion", "kind", "versionId"],
    );
    const versionId = packageVersionIdFromHead(source);
    const stored = await this.#readStoredVersion(
      packageVersionKey(versionId),
      context,
    );
    if (stored === null) unavailable();
    return Object.freeze({ headRevision: head.revision, stored });
  }

  async #readStoredVersion(
    key: StorageKey,
    context = createPackageReconstructionContext(),
    depth = 0,
  ): Promise<StoredPackageVersion | null> {
    if (depth >= PACKAGE_STORAGE_READ_LIMITS.maxVersionAncestry) unavailable();
    if (context.versionIds.has(key.id)) unavailable();
    const remainingReadsBefore = context.remainingReads;
    const value = await this.#readPackageRecord(key, context);
    if (value === null) return null;
    const { record, source } = exactStoredDocument(value, key, true, [
      "schemaVersion",
      "kind",
      "operationId",
      "previousVersionId",
      "mutationFingerprint",
      "acceptanceBindingExpectedRevision",
      "id",
      "createdAt",
      "changeSummary",
      "materialChange",
      "acknowledgmentText",
      "sectionRecordIds",
      "contentHash",
      "requiredAcceptanceHash",
    ]);
    if (source.schemaVersion !== 1 || source.kind !== "package-version") {
      unavailable();
    }
    const operationId = parseRequiredStableId<"storage-operation">(
      source.operationId,
    );
    const versionId = parseRequiredStableId<"package-version">(source.id);
    if ((versionId as string) !== (record.key.id as string)) unavailable();
    const previousVersionId = parseNullableStableId<"package-version">(
      source.previousVersionId,
    );
    const mutationFingerprint = storedMutationFingerprint(
      source.mutationFingerprint,
    );
    const acceptanceBindingExpectedRevision = storedExpectedRevision(
      source.acceptanceBindingExpectedRevision,
    );
    const sectionRecordIds = storedRecordIds(
      source.sectionRecordIds,
      "package-version-sections",
    );

    context.versionIds.add(record.key.id);
    const previous = previousVersionId === null
      ? null
      : await this.#readStoredVersion(
          packageVersionKey(previousVersionId),
          context,
          depth + 1,
        );
    if (previousVersionId !== null && previous === null) unavailable();

    const sections = await this.#readStoredSections(
      versionId,
      sectionRecordIds,
      context,
    );
    const parsed = await parseStoredPackageVersion(
      { ...source, sections },
      previous?.snapshot ?? null,
    );
    const intent = await this.#readOperationIntent(operationId, context);
    if (
      intent === null ||
      intent.packageVersionId !== versionId ||
      intent.previousVersionId !== previousVersionId ||
      intent.acceptanceBindingExpectedRevision !==
        acceptanceBindingExpectedRevision ||
      intent.createdAt !== parsed.createdAt ||
      intent.mutationFingerprint.value !== mutationFingerprint ||
      intent.normalizedMutationHash !==
        await packageNormalizedMutationHash(parsed)
    ) unavailable();
    return Object.freeze({
      snapshot: parsed,
      operationId,
      previousVersionId,
      mutationFingerprint,
      acceptanceBindingExpectedRevision,
      ancestryLength: (previous?.ancestryLength ?? 0) + 1,
      reconstructionReadCount: remainingReadsBefore - context.remainingReads,
    });
  }

  async #readStoredSections(
    versionId: StableId<"package-version">,
    sectionRecordIds: readonly StableId<"storage-record">[],
    context: PackageReconstructionContext,
  ): Promise<readonly PackageSection[]> {
    const sections: PackageSection[] = [];
    for (const [index, sectionRecordId] of sectionRecordIds.entries()) {
      const key = packageSectionKey(sectionRecordId);
      const value = await this.#readPackageRecord(key, context);
      if (value === null) unavailable();
      const { source } = exactStoredDocument(value, key, true, [
        "schemaVersion",
        "kind",
        "versionId",
        "id",
        "order",
        "title",
        "enabled",
        "chunkRecordIds",
      ]);
      if (
        source.schemaVersion !== 1 ||
        source.kind !== "package-version-section"
      ) unavailable();
      const storedVersionId = parseRequiredStableId<"package-version">(
        source.versionId,
      );
      const sectionId = parseRequiredStableId<"package-section">(source.id);
      if (
        storedVersionId !== versionId ||
        source.order !== index ||
        typeof source.title !== "string" ||
        typeof source.enabled !== "boolean"
      ) unavailable();
      const chunkRecordIds = storedRecordIds(
        source.chunkRecordIds,
        "package-section-chunks",
      );
      const markdownChunks: string[] = [];
      let markdownLength = 0;
      for (const [chunkIndex, chunkRecordId] of chunkRecordIds.entries()) {
        const chunkKey = packageSectionChunkKey(chunkRecordId);
        const chunkValue = await this.#readPackageRecord(chunkKey, context);
        if (chunkValue === null) unavailable();
        const { source: chunk } = exactStoredDocument(
          chunkValue,
          chunkKey,
          true,
          [
            "schemaVersion",
            "kind",
            "versionId",
            "sectionId",
            "index",
            "markdown",
          ],
        );
        if (
          chunk.schemaVersion !== 1 ||
          chunk.kind !== "package-section-chunk" ||
          parseRequiredStableId<"package-version">(chunk.versionId) !==
            versionId ||
          parseRequiredStableId<"package-section">(chunk.sectionId) !==
            sectionId ||
          chunk.index !== chunkIndex ||
          typeof chunk.markdown !== "string"
        ) unavailable();
        if (
          chunk.markdown.length >
            PACKAGE_CONTENT_LIMITS.markdownLength - markdownLength
        ) unavailable();
        markdownLength += chunk.markdown.length;
        markdownChunks.push(chunk.markdown);
      }
      const markdown = markdownChunks.join("");
      sections.push(Object.freeze({
        id: sectionId,
        order: index,
        title: source.title,
        markdown: markdown as PackageSection["markdown"],
        enabled: source.enabled,
      }));
    }
    return Object.freeze(sections);
  }

  async #readAcceptanceBinding(
    expectedVersion: PackageVersion,
  ): Promise<Readonly<{ revision: number }> | null> {
    const gate = await this.#readAcceptanceGate();
    if (gate === null) return null;
    if (
      gate.versionId !== expectedVersion.id ||
      gate.requiredAcceptanceHash !== expectedVersion.requiredAcceptanceHash
    ) unavailable();
    return Object.freeze({ revision: gate.revision });
  }

  async #readAcceptanceGate(
    context?: PackageReconstructionContext,
  ): Promise<Readonly<{
    revision: number;
    versionId: StableId<"package-version">;
    requiredAcceptanceHash: string;
  }> | null> {
    const key = packageAcceptanceBindingKey();
    const value = context === undefined
      ? await this.#storage.read(key)
      : await this.#readPackageRecord(key, context);
    if (value === null) return null;
    const { record, source } = exactStoredDocument(value, key, false, [
      "schemaVersion",
      "kind",
      "versionId",
      "requiredAcceptanceHash",
    ]);
    if (
      source.schemaVersion !== 1 ||
      source.kind !== "package-current-gate" ||
      typeof source.requiredAcceptanceHash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(source.requiredAcceptanceHash)
    ) unavailable();
    return Object.freeze({
      revision: record.revision,
      versionId: parseRequiredStableId<"package-version">(source.versionId),
      requiredAcceptanceHash: source.requiredAcceptanceHash,
    });
  }

  async #readPackageRecord(
    key: StorageKey,
    context: PackageReconstructionContext,
  ): Promise<StorageRecord | null> {
    if (context.remainingReads <= 0) unavailable();
    context.remainingReads -= 1;
    return await this.#storage.read(key);
  }
}

/** Compatibility name for deterministic development fixtures. */
export class InMemoryPackageVersionRepository
  extends StoragePackageVersionRepository
{}

/**
 * Subject-bound acknowledgment repository. The caller cannot supply a subject
 * or acceptance hash; both are derived from authenticated context and a trusted
 * immutable package snapshot.
 */
export class StorageAcknowledgmentRepository
  implements AcknowledgmentRepository
{
  readonly #storage: StorageAdapter;
  readonly #packages: AcceptanceBoundPackageVersionRepository;
  readonly #participantSubject: ActorSubject | null;

  constructor(
    storage: StorageAdapter,
    packages: AcceptanceBoundPackageVersionRepository,
    authenticatedParticipantSubject: ActorSubject | null,
  ) {
    this.#storage = storage;
    this.#packages = packages;
    this.#participantSubject = authenticatedParticipantSubject === null
      ? null
      : requiredActorSubject(authenticatedParticipantSubject);
  }

  async record(
    request: RecordPackageAcceptanceRequest,
  ): Promise<RepositoryMutationResult<PackageAcceptanceRecord>> {
    const subject = this.#participantSubject;
    if (subject === null) notFound();

    const key = await packageAcceptanceKey(subject, request.id);
    const existing = await this.#readOwnStoredAcceptance(key, request.id);
    let version: PackageVersion | null;
    let packageBindingExpectedRevision: number;
    if (existing === null) {
      const current = await this.#packages.currentAcceptanceBinding();
      if (current === null) notFound();
      if (current.snapshot.id !== request.acceptedVersionId) {
        throw new StorageFailure("PRECONDITION_FAILED");
      }
      version = current.snapshot;
      packageBindingExpectedRevision = current.bindingRevision;
    } else {
      version = await this.#packages.get(request.acceptedVersionId);
      if (version === null) notFound();
      packageBindingExpectedRevision =
        existing.packageBindingExpectedRevision;
    }

    const parsed = createPackageAcceptance(
      {
        id: request.id,
        participantSubject: subject,
        acceptedAt: request.acceptedAt,
      },
      version,
    );
    if (!parsed.ok) throw new StorageFailure("INVALID_REQUEST");

    const headKey = await packageAcceptanceHeadKey(subject);
    const transaction: StorageTransactionRequest = Object.freeze({
      operationId: request.operationId,
      mutations: Object.freeze([
        Object.freeze({
          type: "put",
          key,
          expectedRevision: null,
          value: packageAcceptanceDocument(
            parsed.value,
            packageBindingExpectedRevision,
          ),
        }),
        Object.freeze({
          type: "put",
          key: headKey,
          expectedRevision: request.expectedRevision,
          value: packageAcceptanceHeadDocument(parsed.value.id),
        }),
        Object.freeze({
          type: "put",
          key: packageAcceptanceBindingKey(),
          expectedRevision: packageBindingExpectedRevision,
          value: packageAcceptanceBindingDocument(version),
        }),
      ]),
    });
    const result = verifyPutTransactionResult(
      transaction,
      await this.#storage.transact(transaction),
    );
    const head = result.records[1];
    if (head === undefined) unavailable();
    return mutationResult(head.revision, parsed.value, result.replayed);
  }

  async latest(): Promise<RevisionedSnapshot<PackageAcceptanceRecord> | null> {
    const subject = this.#participantSubject;
    if (subject === null) return null;

    const headKey = await packageAcceptanceHeadKey(subject);
    const value = await this.#storage.read(headKey);
    if (value === null) return null;
    const { record: head, source } = exactStoredDocument(
      value,
      headKey,
      false,
      ["schemaVersion", "kind", "acceptanceId"],
    );
    const acceptanceId = packageAcceptanceIdFromHead(source);
    const acceptance = await this.#readOwnStoredAcceptance(
      await packageAcceptanceKey(subject, acceptanceId),
      acceptanceId,
    );
    if (acceptance === null) unavailable();
    return revisioned(head.revision, acceptance.snapshot);
  }

  async get(
    id: StableId<"package-acceptance">,
  ): Promise<PackageAcceptanceRecord | null> {
    const subject = this.#participantSubject;
    if (subject === null) return null;
    return (await this.#readOwnStoredAcceptance(
      await packageAcceptanceKey(subject, id),
      id,
    ))?.snapshot ?? null;
  }

  async currentAcceptanceStatus(): Promise<CurrentPackageAcceptanceStatus> {
    if (this.#participantSubject === null) notFound();
    for (let attempt = 0; attempt < MAX_ACCEPTANCE_GATE_READ_ATTEMPTS; attempt += 1) {
      const before = await this.#packages.currentAcceptanceBinding();
      if (before === null) notFound();
      const latest = await this.latest();
      const after = await this.#packages.currentAcceptanceBinding();
      if (after === null) unavailable();
      if (sameAcceptanceBinding(before, after)) {
        return Object.freeze({
          bindingRevision: after.bindingRevision,
          versionId: after.snapshot.id,
          contentHash: after.snapshot.contentHash,
          requiredAcceptanceHash: after.snapshot.requiredAcceptanceHash,
          requiresCurrentAcceptance: requiresRenewedAcceptance(
            after.snapshot,
            latest?.snapshot ?? null,
          ),
        });
      }
    }
    unavailable();
  }

  async requiresCurrentAcceptance(): Promise<boolean> {
    return (await this.currentAcceptanceStatus()).requiresCurrentAcceptance;
  }

  async #readOwnStoredAcceptance(
    key: StorageKey,
    expectedId: StableId<"package-acceptance">,
  ): Promise<StoredPackageAcceptance | null> {
    const subject = this.#participantSubject;
    if (subject === null) return null;
    const value = await this.#storage.read(key);
    if (value === null) return null;
    const { source } = exactStoredDocument(value, key, true, [
      "schemaVersion",
      "kind",
      "id",
      "participantSubject",
      "acceptedAt",
      "acceptedVersionId",
      "acceptedContentHash",
      "satisfiedRequirementHash",
      "packageBindingExpectedRevision",
    ]);
    if (
      source.schemaVersion !== 1 ||
      source.kind !== "package-acceptance"
    ) unavailable();
    const participantSubject = parseOptionalActorSubject(
      source.participantSubject,
    );
    if (participantSubject === null || participantSubject !== subject) return null;
    const acceptanceId = parseRequiredStableId<"package-acceptance">(source.id);
    if (acceptanceId !== expectedId) unavailable();
    const versionId = parseRequiredStableId<"package-version">(
      source.acceptedVersionId,
    );
    const version = await this.#packages.get(versionId);
    if (version === null) unavailable();
    const packageBindingExpectedRevision = storedPositiveRevision(
      source.packageBindingExpectedRevision,
    );

    const parsed = createPackageAcceptance(source, version);
    if (
      !parsed.ok ||
      parsed.value.acceptedContentHash !== source.acceptedContentHash ||
      parsed.value.satisfiedRequirementHash !== source.satisfiedRequirementHash
    ) {
      unavailable();
    }
    return Object.freeze({
      snapshot: parsed.value,
      packageBindingExpectedRevision,
    });
  }
}

/** Compatibility name for deterministic development fixtures. */
export class InMemoryAcknowledgmentRepository
  extends StorageAcknowledgmentRepository
{}

async function packageVersionAudit(
  operationId: StorageOperationId,
  version: PackageVersion,
  previousVersionId: StableId<"package-version"> | null,
  ownerSubject: ActorSubject,
) {
  const eventId = await hashedStableId<"audit-event">(
    "audit-event",
    `package-version\u0000${operationId}`,
  );
  const auditOperationId = requiredStableId<"audit-operation">(operationId);
  const resourceId = requiredStableId<"audit-resource">(version.id);
  const prepared = prepareAuditAppend({
    type: "append-audit-event",
    event: {
      id: eventId,
      operationId: auditOperationId,
      occurredAt: version.createdAt,
      actor: { type: "owner", subject: ownerSubject },
      detail: {
        kind: "resource-transition",
        resource: { type: "package-version", id: resourceId },
        transition: previousVersionId === null ? "created" : "updated",
      },
    },
  });
  if (prepared.operationId !== operationId) unavailable();
  return prepared;
}

async function parseIncomingPackageVersion(
  draft: unknown,
  previousVersion: PackageVersion | null,
): Promise<PackageVersion> {
  let parsed;
  try {
    parsed = await createPackageVersion(draft, previousVersion);
  } catch {
    unavailable();
  }
  if (!parsed.ok) throw new StorageFailure("INVALID_REQUEST");
  return parsed.value;
}

function exactIncomingPackageVersionDraft(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const source = exactInputDataRecord(value, [
    "id",
    "createdAt",
    "changeSummary",
    "materialChange",
    "acknowledgmentText",
    "sections",
  ]);
  const sections = exactInputArray(
    source.sections,
    PACKAGE_CONTENT_LIMITS.sections,
  ).map((candidate) => {
    const section = exactInputDataRecord(candidate, [
      "id",
      "order",
      "title",
      "markdown",
      "enabled",
    ]);
    return Object.freeze({
      id: section.id,
      order: section.order,
      title: section.title,
      markdown: section.markdown,
      enabled: section.enabled,
    });
  });
  return Object.freeze({
    id: source.id,
    createdAt: source.createdAt,
    changeSummary: source.changeSummary,
    materialChange: source.materialChange,
    acknowledgmentText: source.acknowledgmentText,
    sections: Object.freeze(sections),
  });
}

function exactInputDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  const source = objectRecord(value);
  if (source === null) invalidIncomingPackageDraft();
  const prototype = Object.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== null) {
    invalidIncomingPackageDraft();
  }
  const ownKeys = Reflect.ownKeys(source);
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== "string") ||
    expectedKeys.some((key) => !ownKeys.includes(key))
  ) invalidIncomingPackageDraft();
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) invalidIncomingPackageDraft();
  }
  return source;
}

function exactInputArray(
  value: unknown,
  maximumLength: number,
): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalidIncomingPackageDraft();
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximumLength
  ) invalidIncomingPackageDraft();
  const length = lengthDescriptor.value as number;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== length + 1 ||
    !ownKeys.includes("length") ||
    ownKeys.some((key) =>
      typeof key !== "string" ||
      (key !== "length" && !/^(?:0|[1-9]\d*)$/.test(key))
    )
  ) invalidIncomingPackageDraft();
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) invalidIncomingPackageDraft();
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function invalidIncomingPackageDraft(): never {
  throw new StorageFailure("INVALID_REQUEST");
}

async function parseStoredPackageVersion(
  source: Record<string, unknown>,
  previousVersion: PackageVersion | null,
): Promise<PackageVersion> {
  let parsed;
  try {
    parsed = await createPackageVersion(source, previousVersion);
  } catch {
    unavailable();
  }
  if (
    !parsed.ok ||
    parsed.value.contentHash !== source.contentHash ||
    parsed.value.requiredAcceptanceHash !== source.requiredAcceptanceHash
  ) {
    unavailable();
  }
  return parsed.value;
}

function packageOperationIntent(
  request: AppendPackageVersionRequest,
  version: PackageVersion,
  previousVersionId: StableId<"package-version"> | null,
  acceptanceBindingExpectedRevision: number | null,
  mutationFingerprint: PackageMutationFingerprint,
  normalizedMutationHash: string,
  ownerSubject: ActorSubject | null,
): StoredPackageOperationIntent {
  return Object.freeze({
    operationId: request.operationId,
    mode: ownerSubject === null ? "unaudited" : "owner",
    ownerSubject,
    expectedOwnerRevision: request.expectedRevision,
    mutationFingerprint,
    previousVersionId,
    acceptanceBindingExpectedRevision,
    packageVersionId: version.id,
    createdAt: version.createdAt,
    normalizedMutationHash,
  });
}

function packageOperationIntentDocument(
  intent: StoredPackageOperationIntent,
): StorageDocument {
  return {
    schemaVersion: 1,
    kind: "package-operation-intent",
    operationId: intent.operationId,
    mode: intent.mode,
    ownerSubject: intent.ownerSubject,
    expectedOwnerRevision: intent.expectedOwnerRevision,
    mutationFingerprintSource: intent.mutationFingerprint.source,
    mutationFingerprint: intent.mutationFingerprint.value,
    previousVersionId: intent.previousVersionId,
    acceptanceBindingExpectedRevision:
      intent.acceptanceBindingExpectedRevision,
    packageVersionId: intent.packageVersionId,
    createdAt: intent.createdAt,
    normalizedMutationHash: intent.normalizedMutationHash,
  };
}

function requireIntentRequestMatch(
  intent: StoredPackageOperationIntent,
  request: AppendPackageVersionRequest,
  versionId: StableId<"package-version">,
  mutationFingerprint: PackageMutationFingerprint,
  ownerSubject: ActorSubject | null,
): void {
  if (
    intent.packageVersionId !== versionId ||
    intent.expectedOwnerRevision !== request.expectedRevision ||
    intent.mutationFingerprint.source !== mutationFingerprint.source ||
    intent.mutationFingerprint.value !== mutationFingerprint.value ||
    intent.mode !== (ownerSubject === null ? "unaudited" : "owner") ||
    intent.ownerSubject !== ownerSubject
  ) conflict();
}

async function packageNormalizedMutationHash(
  version: PackageVersion,
): Promise<string> {
  return sha256Fingerprint(JSON.stringify({
    id: version.id,
    createdAt: version.createdAt,
    changeSummary: version.changeSummary,
    materialChange: version.materialChange,
    acknowledgmentText: version.acknowledgmentText,
    sections: version.sections.map((section) => ({
      id: section.id,
      order: section.order,
      title: section.title,
      markdown: section.markdown,
      enabled: section.enabled,
    })),
    contentHash: version.contentHash,
    requiredAcceptanceHash: version.requiredAcceptanceHash,
  }));
}

function packageVersionDocument(
  version: PackageVersion,
  operationId: StorageOperationId,
  previousVersionId: StableId<"package-version"> | null,
  mutationFingerprint: string,
  acceptanceBindingExpectedRevision: number | null,
  sectionRecordIds: readonly StableId<"storage-record">[],
): StorageDocument {
  return {
    schemaVersion: 1,
    kind: "package-version",
    operationId,
    previousVersionId,
    mutationFingerprint,
    acceptanceBindingExpectedRevision,
    id: version.id,
    createdAt: version.createdAt,
    changeSummary: version.changeSummary,
    materialChange: version.materialChange,
    acknowledgmentText: version.acknowledgmentText,
    sectionRecordIds,
    contentHash: version.contentHash,
    requiredAcceptanceHash: version.requiredAcceptanceHash,
  };
}

function packageSectionDocument(
  versionId: StableId<"package-version">,
  section: PackageSection,
  chunkRecordIds: readonly StableId<"storage-record">[],
): StorageDocument {
  return {
    schemaVersion: 1,
    kind: "package-version-section",
    versionId,
    id: section.id,
    order: section.order,
    title: section.title,
    enabled: section.enabled,
    chunkRecordIds,
  };
}

function packageSectionChunkDocument(
  versionId: StableId<"package-version">,
  sectionId: StableId<"package-section">,
  index: number,
  markdown: string,
): StorageDocument {
  return {
    schemaVersion: 1,
    kind: "package-section-chunk",
    versionId,
    sectionId,
    index,
    markdown,
  };
}

function splitPackageSectionMarkdown(
  versionId: StableId<"package-version">,
  section: PackageSection,
): readonly string[] {
  if (section.markdown.length === 0) return Object.freeze([]);

  const chunks: string[] = [];
  let start = 0;
  while (start < section.markdown.length) {
    let low = start + 1;
    let high = section.markdown.length;
    let acceptedEnd = start;
    while (low <= high) {
      let middle = Math.floor((low + high) / 2);
      if (
        middle < section.markdown.length &&
        isHighSurrogate(section.markdown.charCodeAt(middle - 1)) &&
        isLowSurrogate(section.markdown.charCodeAt(middle))
      ) middle -= 1;
      if (middle <= start) {
        low = Math.max(low + 1, start + 2);
        continue;
      }
      const candidate = section.markdown.slice(start, middle);
      const document = packageSectionChunkDocument(
        versionId,
        section.id,
        chunks.length,
        candidate,
      );
      if (storageDocumentBytes(document) <= MAX_PACKAGE_SECTION_RECORD_BYTES) {
        acceptedEnd = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (acceptedEnd <= start) unavailable();
    chunks.push(section.markdown.slice(start, acceptedEnd));
    start = acceptedEnd;
  }
  return Object.freeze(chunks);
}

function packageVersionReconstructionRecordCount(
  version: PackageVersion,
): number {
  return 2 + version.sections.reduce(
    (count, section) =>
      count + 1 + splitPackageSectionMarkdown(version.id, section).length,
    0,
  );
}

function storageDocumentBytes(document: StorageDocument): number {
  try {
    return new TextEncoder().encode(JSON.stringify(document)).byteLength;
  } catch {
    unavailable();
  }
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

async function packageMutationFingerprint(
  request: AppendPackageVersionRequest,
  draft: unknown,
): Promise<PackageMutationFingerprint> {
  if (request.mutationFingerprint !== undefined) {
    return Object.freeze({
      source: "supplied",
      value: parseMutationFingerprint(request.mutationFingerprint),
    });
  }

  let canonical: string;
  try {
    canonical = JSON.stringify({
      expectedRevision: request.expectedRevision,
      draft,
    });
  } catch {
    throw new StorageFailure("INVALID_REQUEST");
  }

  return Object.freeze({
    source: "computed",
    value: await sha256Fingerprint(canonical),
  });
}

async function sha256Fingerprint(value: string): Promise<string> {
  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
  } catch {
    unavailable();
  }
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function parseMutationFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return value;
}

function storedMutationFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    unavailable();
  }
  return value;
}

function storedTimestamp(value: unknown): Timestamp {
  const parsed = parseTimestamp(value);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function storedExpectedRevision(value: unknown): number | null {
  if (value === null) return null;
  return storedPositiveRevision(value);
}

function storedPositiveRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) unavailable();
  return value as number;
}

function storedRecordIds(
  value: unknown,
  context: "package-version-sections" | "package-section-chunks",
): readonly StableId<"storage-record">[] {
  const maximum = context === "package-version-sections"
    ? PACKAGE_CONTENT_LIMITS.sections
    : MAX_PACKAGE_SECTION_CHUNKS;
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    !isExactArray(value, value.length)
  ) unavailable();
  const ids = value.map((candidate) =>
    parseRequiredStableId<"storage-record">(candidate)
  );
  if (new Set(ids).size !== ids.length) unavailable();
  return Object.freeze(ids);
}

function packageAcceptanceDocument(
  acceptance: PackageAcceptanceRecord,
  packageBindingExpectedRevision: number,
): StorageDocument {
  return {
    schemaVersion: 1,
    kind: "package-acceptance",
    id: acceptance.id,
    participantSubject: acceptance.participantSubject,
    acceptedAt: acceptance.acceptedAt,
    acceptedVersionId: acceptance.acceptedVersionId,
    acceptedContentHash: acceptance.acceptedContentHash,
    satisfiedRequirementHash: acceptance.satisfiedRequirementHash,
    packageBindingExpectedRevision,
  };
}

function packageAcceptanceBindingDocument(
  version: PackageVersion,
): StorageDocument {
  return {
    schemaVersion: 1,
    kind: "package-current-gate",
    versionId: version.id,
    requiredAcceptanceHash: version.requiredAcceptanceHash,
  };
}

function packageHeadDocument(
  versionId: StableId<"package-version">,
): StorageDocument {
  return { schemaVersion: 1, kind: "package-version-head", versionId };
}

function packageAcceptanceHeadDocument(
  acceptanceId: StableId<"package-acceptance">,
): StorageDocument {
  return { schemaVersion: 1, kind: "package-acceptance-head", acceptanceId };
}

function packageVersionIdFromHead(
  document: unknown,
): StableId<"package-version"> {
  const source = objectRecord(document);
  if (
    source?.schemaVersion !== 1 ||
    source.kind !== "package-version-head"
  ) unavailable();
  return parseRequiredStableId<"package-version">(source.versionId);
}

function packageAcceptanceIdFromHead(
  document: unknown,
): StableId<"package-acceptance"> {
  const source = objectRecord(document);
  if (
    source?.schemaVersion !== 1 ||
    source.kind !== "package-acceptance-head"
  ) unavailable();
  return parseRequiredStableId<"package-acceptance">(source.acceptanceId);
}

function packageVersionIdFromDraft(
  draft: unknown,
): StableId<"package-version"> {
  const source = objectRecord(draft);
  if (source === null) throw new StorageFailure("INVALID_REQUEST");
  const parsed = parseStableId<"package-version">(source.id);
  if (!parsed.ok) throw new StorageFailure("INVALID_REQUEST");
  return parsed.value;
}

function packageVersionKey(id: StableId<"package-version">): StorageKey {
  return requiredStorageKey(PACKAGE_VERSIONS, id);
}

function packageOperationIntentKey(
  operationId: StorageOperationId,
): StorageKey {
  return requiredStorageKey(PACKAGE_OPERATION_INTENTS, operationId);
}

function packageSectionKey(id: StableId<"storage-record">): StorageKey {
  return requiredStorageKey(PACKAGE_VERSION_SECTIONS, id);
}

function packageSectionChunkKey(id: StableId<"storage-record">): StorageKey {
  return requiredStorageKey(PACKAGE_SECTION_CHUNKS, id);
}

async function packageSectionRecordId(
  operationId: StorageOperationId,
  versionId: StableId<"package-version">,
  sectionId: StableId<"package-section">,
): Promise<StableId<"storage-record">> {
  return hashedStorageId(
    "package-section",
    `${operationId}\u0000${versionId}\u0000${sectionId}`,
  );
}

async function packageSectionChunkRecordId(
  operationId: StorageOperationId,
  versionId: StableId<"package-version">,
  sectionId: StableId<"package-section">,
  index: number,
): Promise<StableId<"storage-record">> {
  return hashedStorageId(
    "package-chunk",
    `${operationId}\u0000${versionId}\u0000${sectionId}\u0000${index}`,
  );
}

function packageVersionHeadKey(): StorageKey {
  return requiredStorageKey(PACKAGE_VERSION_HEADS, CURRENT_PACKAGE_ID);
}

function packageAcceptanceBindingKey(): StorageKey {
  return requiredStorageKey(PACKAGE_ACCEPTANCE_BINDINGS, CURRENT_PACKAGE_ID);
}

async function packageAcceptanceKey(
  subject: ActorSubject,
  id: StableId<"package-acceptance">,
): Promise<StorageKey> {
  return requiredStorageKey(
    PACKAGE_ACCEPTANCES,
    await hashedStorageId("acceptance", `${subject}\u0000${id}`),
  );
}

async function packageAcceptanceHeadKey(
  subject: ActorSubject,
): Promise<StorageKey> {
  return requiredStorageKey(
    PACKAGE_ACCEPTANCE_HEADS,
    await hashedStorageId("subject", subject),
  );
}

async function hashedStorageId(
  namespace: string,
  value: string,
): Promise<StableId<"storage-record">> {
  return hashedStableId<"storage-record">(namespace, value);
}

async function hashedStableId<Entity extends string>(
  namespace: string,
  value: string,
): Promise<StableId<Entity>> {
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
  return requiredStableId<Entity>(`${namespace}:${hexadecimal}`);
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
  if (!parsed.ok) throw new Error("Invalid content repository collection.");
  return parsed.value;
}

function stableId<Entity extends string>(value: string): StableId<Entity> {
  const parsed = parseStableId<Entity>(value);
  if (!parsed.ok) throw new Error("Invalid content repository identifier.");
  return parsed.value;
}

function requiredStableId<Entity extends string>(
  value: unknown,
): StableId<Entity> {
  const parsed = parseStableId<Entity>(value);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function parseRequiredStableId<Entity extends string>(
  value: unknown,
): StableId<Entity> {
  return requiredStableId<Entity>(value);
}

function parseNullableStableId<Entity extends string>(
  value: unknown,
): StableId<Entity> | null {
  return value === null ? null : parseRequiredStableId<Entity>(value);
}

function requiredActorSubject(value: unknown): ActorSubject {
  const parsed = parseActorSubject(value);
  if (!parsed.ok) throw new StorageFailure("INVALID_REQUEST");
  return parsed.value;
}

function parseOptionalActorSubject(value: unknown): ActorSubject | null {
  const parsed = parseActorSubject(value);
  return parsed.ok ? parsed.value : null;
}

function storedActorSubject(value: unknown): ActorSubject {
  const parsed = parseActorSubject(value);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  const source = objectRecord(value);
  if (source === null) unavailable();
  const prototype = Object.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== null) unavailable();
  const ownKeys = Reflect.ownKeys(source);
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== "string") ||
    expectedKeys.some((key) => !ownKeys.includes(key))
  ) unavailable();
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) unavailable();
  }
  return source;
}

function exactStoredRecord(
  value: unknown,
  expectedKey: StorageKey,
  immutable: boolean,
): StorageRecord {
  const source = exactDataRecord(value, ["key", "revision", "value"]);
  const key = exactDataRecord(source.key, ["collection", "id"]);
  if (
    key.collection !== expectedKey.collection ||
    key.id !== expectedKey.id ||
    !Number.isSafeInteger(source.revision) ||
    (source.revision as number) < 1 ||
    (immutable && source.revision !== 1)
  ) unavailable();
  const document = objectRecord(source.value);
  if (
    document === null ||
    storageDocumentBytes(document as StorageDocument) >
      MAX_PACKAGE_SECTION_RECORD_BYTES
  ) unavailable();
  return value as StorageRecord;
}

function exactStoredDocument(
  value: unknown,
  expectedKey: StorageKey,
  immutable: boolean,
  expectedFields: readonly string[],
): Readonly<{ record: StorageRecord; source: Record<string, unknown> }> {
  const record = exactStoredRecord(value, expectedKey, immutable);
  const source = exactDataRecord(record.value, expectedFields);
  return Object.freeze({ record, source });
}

function verifyPutTransactionResult(
  request: StorageTransactionRequest,
  value: unknown,
): Readonly<{
  replayed: boolean;
  records: readonly StorageRecord[];
}> {
  const result = exactDataRecord(value, ["replayed", "records"]);
  if (typeof result.replayed !== "boolean" || !Array.isArray(result.records)) {
    unavailable();
  }
  if (
    !isExactArray(result.records, request.mutations.length) ||
    request.mutations.some((mutation) => mutation.type !== "put")
  ) unavailable();

  const records: StorageRecord[] = [];
  for (const [index, mutation] of request.mutations.entries()) {
    if (!(index in result.records) || mutation.type !== "put") unavailable();
    const record = exactStoredRecord(
      result.records[index],
      mutation.key,
      mutation.expectedRevision === null,
    );
    const expectedRevision = mutation.expectedRevision === null
      ? 1
      : mutation.expectedRevision + 1;
    if (
      !Number.isSafeInteger(expectedRevision) ||
      record.revision !== expectedRevision ||
      canonicalStorageDocument(record.value) !==
        canonicalStorageDocument(mutation.value)
    ) unavailable();
    records.push(record);
  }
  return Object.freeze({
    replayed: result.replayed,
    records: Object.freeze(records),
  });
}

function canonicalStorageDocument(value: StorageDocument): string {
  return canonicalJsonValue(value);
}

function canonicalJsonValue(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) unavailable();
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!isDenseArray(value)) unavailable();
    return `[${value.map((entry) => canonicalJsonValue(entry)).join(",")}]`;
  }
  const source = objectRecord(value);
  if (source === null) unavailable();
  const keys = Object.keys(source).sort();
  return `{${keys.map((key) =>
    `${JSON.stringify(key)}:${canonicalJsonValue(source[key])}`
  ).join(",")}}`;
}

function isDenseArray(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function isExactArray(
  value: readonly unknown[],
  expectedLength: number,
): boolean {
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== expectedLength ||
    !isDenseArray(value)
  ) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedLength + 1 || !keys.includes("length")) {
    return false;
  }
  return Array.from({ length: expectedLength }, (_, index) => `${index}`)
    .every((key) => keys.includes(key));
}

function revisioned<Value>(
  revision: number,
  snapshot: Value,
): RevisionedSnapshot<Value> {
  return Object.freeze({ revision, snapshot });
}

function sameAcceptanceBinding(
  left: CurrentPackageAcceptanceBinding,
  right: CurrentPackageAcceptanceBinding,
): boolean {
  return left.bindingRevision === right.bindingRevision &&
    left.snapshot.id === right.snapshot.id &&
    left.snapshot.contentHash === right.snapshot.contentHash &&
    left.snapshot.requiredAcceptanceHash === right.snapshot.requiredAcceptanceHash;
}

function mutationResult<Value>(
  revision: number,
  snapshot: Value,
  replayed: boolean,
): RepositoryMutationResult<Value> {
  return Object.freeze({ revision, snapshot, replayed });
}

function notFound(): never {
  throw new StorageFailure("NOT_FOUND");
}

function conflict(): never {
  throw new StorageFailure("CONFLICT");
}

function unavailable(): never {
  throw new StorageFailure("UNAVAILABLE");
}
