import {
  createPackageAcceptance,
  createPackageVersion,
  requiresRenewedAcceptance,
  type PackageAcceptanceRecord,
  type PackageVersion,
} from "../domain/package-content.ts";
import {
  parseActorSubject,
  parseStableId,
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

export interface PackageVersionRepository {
  append(
    request: AppendPackageVersionRequest,
  ): Promise<RepositoryMutationResult<PackageVersion>>;
  current(): Promise<RevisionedSnapshot<PackageVersion> | null>;
  get(id: StableId<"package-version">): Promise<PackageVersion | null>;
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
  requiresCurrentAcceptance(): Promise<boolean>;
}

type StoredPackageVersion = Readonly<{
  snapshot: PackageVersion;
  previousVersionId: StableId<"package-version"> | null;
  mutationFingerprint: string;
}>;

const PACKAGE_VERSIONS = storageCollection("private-package-versions");
const PACKAGE_VERSION_HEADS = storageCollection("private-package-version-heads");
const PACKAGE_ACCEPTANCES = storageCollection("private-package-acceptances");
const PACKAGE_ACCEPTANCE_HEADS = storageCollection(
  "private-package-acceptance-heads",
);
const CURRENT_PACKAGE_ID = stableId<"storage-record">("current-package");

/**
 * Deterministic package repository for a StorageAdapter-backed memory fixture.
 * It keeps no process-local state and therefore exercises the same revision and
 * idempotency boundary that a production adapter must implement.
 */
export class InMemoryPackageVersionRepository
  implements PackageVersionRepository
{
  readonly #storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.#storage = storage;
  }

  async append(
    request: AppendPackageVersionRequest,
  ): Promise<RepositoryMutationResult<PackageVersion>> {
    const mutationFingerprint = await packageMutationFingerprint(request);
    const versionId = packageVersionIdFromDraft(request.draft);
    const key = packageVersionKey(versionId);
    const existing = await this.#readStoredVersion(key);

    let previousVersionId: StableId<"package-version"> | null;
    let previousVersion: PackageVersion | null;
    if (existing) {
      previousVersionId = existing.previousVersionId;
      previousVersion = existing.snapshot;
    } else {
      const current = await this.#readCurrentStored();
      previousVersionId = current?.stored.snapshot.id ?? null;
      previousVersion = current?.stored.snapshot ?? null;
    }

    const parsed = await parseIncomingPackageVersion(
      request.draft,
      previousVersion,
    );
    const versionDocument = packageVersionDocument(
      parsed,
      previousVersionId,
      mutationFingerprint,
    );
    const headKey = packageVersionHeadKey();
    const result = await this.#storage.transact({
      operationId: request.operationId,
      mutations: [
        {
          type: "put",
          key,
          expectedRevision: null,
          value: versionDocument,
        },
        {
          type: "put",
          key: headKey,
          expectedRevision: request.expectedRevision,
          value: packageHeadDocument(parsed.id),
        },
      ],
    });

    const head = result.records[1];
    if (head === null || head === undefined) unavailable();
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

  async #readCurrentStored(): Promise<Readonly<{
    headRevision: number;
    stored: StoredPackageVersion;
  }> | null> {
    const head = await this.#storage.read(packageVersionHeadKey());
    if (head === null) return null;

    const versionId = packageVersionIdFromHead(head.value);
    const stored = await this.#readStoredVersion(packageVersionKey(versionId));
    if (stored === null) unavailable();
    return Object.freeze({ headRevision: head.revision, stored });
  }

  async #readStoredVersion(
    key: StorageKey,
    seen: ReadonlySet<string> = new Set<string>(),
  ): Promise<StoredPackageVersion | null> {
    const record = await this.#storage.read(key);
    if (record === null) return null;
    if (seen.has(record.key.id)) unavailable();

    const source = objectRecord(record.value);
    if (source?.kind !== "package-version") unavailable();
    const versionId = parseRequiredStableId<"package-version">(source.id);
    if ((versionId as string) !== (record.key.id as string)) unavailable();
    const previousVersionId = parseNullableStableId<"package-version">(
      source.previousVersionId,
    );
    const mutationFingerprint = storedMutationFingerprint(
      source.mutationFingerprint,
    );

    const nextSeen = new Set(seen);
    nextSeen.add(record.key.id);
    const previous = previousVersionId === null
      ? null
      : await this.#readStoredVersion(
          packageVersionKey(previousVersionId),
          nextSeen,
        );
    if (previousVersionId !== null && previous === null) unavailable();

    const parsed = await parseStoredPackageVersion(
      source,
      previous?.snapshot ?? null,
    );
    return Object.freeze({
      snapshot: parsed,
      previousVersionId,
      mutationFingerprint,
    });
  }
}

/**
 * Subject-bound acknowledgment repository. The caller cannot supply a subject
 * or acceptance hash; both are derived from authenticated context and a trusted
 * immutable package snapshot.
 */
export class InMemoryAcknowledgmentRepository
  implements AcknowledgmentRepository
{
  readonly #storage: StorageAdapter;
  readonly #packages: PackageVersionRepository;
  readonly #participantSubject: ActorSubject | null;

  constructor(
    storage: StorageAdapter,
    packages: PackageVersionRepository,
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
    const existing = await this.#readOwnAcceptance(key, request.id);
    let version: PackageVersion | null;
    if (existing === null) {
      const current = await this.#packages.current();
      if (current === null) notFound();
      if (current.snapshot.id !== request.acceptedVersionId) {
        throw new StorageFailure("PRECONDITION_FAILED");
      }
      version = current.snapshot;
    } else {
      version = await this.#packages.get(request.acceptedVersionId);
      if (version === null) notFound();
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
    const result = await this.#storage.transact({
      operationId: request.operationId,
      mutations: [
        {
          type: "put",
          key,
          expectedRevision: null,
          value: packageAcceptanceDocument(parsed.value),
        },
        {
          type: "put",
          key: headKey,
          expectedRevision: request.expectedRevision,
          value: packageAcceptanceHeadDocument(parsed.value.id),
        },
      ],
    });

    const head = result.records[1];
    if (head === null || head === undefined) unavailable();
    return mutationResult(head.revision, parsed.value, result.replayed);
  }

  async latest(): Promise<RevisionedSnapshot<PackageAcceptanceRecord> | null> {
    const subject = this.#participantSubject;
    if (subject === null) return null;

    const head = await this.#storage.read(await packageAcceptanceHeadKey(subject));
    if (head === null) return null;
    const acceptanceId = packageAcceptanceIdFromHead(head.value);
    const acceptance = await this.#readOwnAcceptance(
      await packageAcceptanceKey(subject, acceptanceId),
      acceptanceId,
    );
    if (acceptance === null) unavailable();
    return revisioned(head.revision, acceptance);
  }

  async get(
    id: StableId<"package-acceptance">,
  ): Promise<PackageAcceptanceRecord | null> {
    const subject = this.#participantSubject;
    if (subject === null) return null;
    return this.#readOwnAcceptance(
      await packageAcceptanceKey(subject, id),
      id,
    );
  }

  async requiresCurrentAcceptance(): Promise<boolean> {
    if (this.#participantSubject === null) notFound();
    const current = await this.#packages.current();
    if (current === null) notFound();
    const latest = await this.latest();
    return requiresRenewedAcceptance(current.snapshot, latest?.snapshot ?? null);
  }

  async #readOwnAcceptance(
    key: StorageKey,
    expectedId: StableId<"package-acceptance">,
  ): Promise<PackageAcceptanceRecord | null> {
    const subject = this.#participantSubject;
    if (subject === null) return null;
    const record = await this.#storage.read(key);
    if (record === null) return null;

    const source = objectRecord(record.value);
    if (source?.kind !== "package-acceptance") unavailable();
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

    const parsed = createPackageAcceptance(source, version);
    if (
      !parsed.ok ||
      parsed.value.acceptedContentHash !== source.acceptedContentHash ||
      parsed.value.satisfiedRequirementHash !== source.satisfiedRequirementHash
    ) {
      unavailable();
    }
    return parsed.value;
  }
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

function packageVersionDocument(
  version: PackageVersion,
  previousVersionId: StableId<"package-version"> | null,
  mutationFingerprint: string,
): StorageDocument {
  return {
    kind: "package-version",
    previousVersionId,
    mutationFingerprint,
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
  };
}

async function packageMutationFingerprint(
  request: AppendPackageVersionRequest,
): Promise<string> {
  if (request.mutationFingerprint !== undefined) {
    return parseMutationFingerprint(request.mutationFingerprint);
  }

  let canonical: string;
  try {
    canonical = JSON.stringify({
      expectedRevision: request.expectedRevision,
      draft: request.draft,
    });
  } catch {
    throw new StorageFailure("INVALID_REQUEST");
  }

  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical),
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

function packageAcceptanceDocument(
  acceptance: PackageAcceptanceRecord,
): StorageDocument {
  return {
    kind: "package-acceptance",
    id: acceptance.id,
    participantSubject: acceptance.participantSubject,
    acceptedAt: acceptance.acceptedAt,
    acceptedVersionId: acceptance.acceptedVersionId,
    acceptedContentHash: acceptance.acceptedContentHash,
    satisfiedRequirementHash: acceptance.satisfiedRequirementHash,
  };
}

function packageHeadDocument(
  versionId: StableId<"package-version">,
): StorageDocument {
  return { kind: "package-version-head", versionId };
}

function packageAcceptanceHeadDocument(
  acceptanceId: StableId<"package-acceptance">,
): StorageDocument {
  return { kind: "package-acceptance-head", acceptanceId };
}

function packageVersionIdFromHead(
  document: StorageDocument,
): StableId<"package-version"> {
  const source = objectRecord(document);
  if (source?.kind !== "package-version-head") unavailable();
  return parseRequiredStableId<"package-version">(source.versionId);
}

function packageAcceptanceIdFromHead(
  document: StorageDocument,
): StableId<"package-acceptance"> {
  const source = objectRecord(document);
  if (source?.kind !== "package-acceptance-head") unavailable();
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

function packageVersionHeadKey(): StorageKey {
  return requiredStorageKey(PACKAGE_VERSION_HEADS, CURRENT_PACKAGE_ID);
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
  return stableId<"storage-record">(`${namespace}:${hexadecimal}`);
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

function parseRequiredStableId<Entity extends string>(
  value: unknown,
): StableId<Entity> {
  const parsed = parseStableId<Entity>(value);
  if (!parsed.ok) unavailable();
  return parsed.value;
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

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function revisioned<Value>(
  revision: number,
  snapshot: Value,
): RevisionedSnapshot<Value> {
  return Object.freeze({ revision, snapshot });
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

function unavailable(): never {
  throw new StorageFailure("UNAVAILABLE");
}
