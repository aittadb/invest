import {
  PACKAGE_CONTENT_LIMITS,
  visiblePackageSections,
  type PackageSection,
  type PackageVersion,
} from "../domain/package-content.ts";
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
  parseStorageOperationId,
  type StorageOperationId,
} from "../domain/storage-adapter.ts";
import type {
  AppendPackageVersionRequest,
  RepositoryMutationResult,
  RevisionedSnapshot,
} from "../repositories/in-memory-content-repository.ts";

export type TrustedOwnerActor = Readonly<{
  type: "owner";
  subject: ActorSubject;
}>;

export type OwnerPackageWorkspaceState = Readonly<{
  revision: number;
  version: PackageVersion;
}> | null;

export type OwnerPackagePreview = Readonly<{
  revision: number;
  version: PackageVersion;
  sections: readonly PackageSection[];
}> | null;

export type PackageVersionMetadataInput = Readonly<{
  operationId: unknown;
  expectedRevision: unknown;
  changeSummary: unknown;
  materialChange: unknown;
}>;

export type CreatePackageSectionInput = PackageVersionMetadataInput &
  Readonly<{
    title: unknown;
    markdown: unknown;
    enabled: unknown;
    acknowledgmentText?: unknown;
  }>;

export type UpdatePackageSectionInput = PackageVersionMetadataInput &
  Readonly<{
    sectionId: unknown;
    title: unknown;
    markdown: unknown;
  }>;

export type SetPackageSectionEnabledInput = PackageVersionMetadataInput &
  Readonly<{
    sectionId: unknown;
    enabled: unknown;
  }>;

export type MovePackageSectionInput = PackageVersionMetadataInput &
  Readonly<{
    sectionId: unknown;
    direction: unknown;
  }>;

export type UpdatePackageSettingsInput = PackageVersionMetadataInput &
  Readonly<{
    acknowledgmentText: unknown;
  }>;

export interface OwnerPackageWorkspaceService {
  read(actor: TrustedOwnerActor): Promise<OwnerPackageWorkspaceState>;
  preview(actor: TrustedOwnerActor): Promise<OwnerPackagePreview>;
  createSection(
    actor: TrustedOwnerActor,
    input: CreatePackageSectionInput,
  ): Promise<RepositoryMutationResult<PackageVersion>>;
  updateSection(
    actor: TrustedOwnerActor,
    input: UpdatePackageSectionInput,
  ): Promise<RepositoryMutationResult<PackageVersion>>;
  setSectionEnabled(
    actor: TrustedOwnerActor,
    input: SetPackageSectionEnabledInput,
  ): Promise<RepositoryMutationResult<PackageVersion>>;
  moveSection(
    actor: TrustedOwnerActor,
    input: MovePackageSectionInput,
  ): Promise<RepositoryMutationResult<PackageVersion>>;
  updateSettings(
    actor: TrustedOwnerActor,
    input: UpdatePackageSettingsInput,
  ): Promise<RepositoryMutationResult<PackageVersion>>;
}

export interface OwnerPackageWorkspaceRepository {
  append(
    request: AppendPackageVersionRequest & Readonly<{
      mutationFingerprint: string;
    }>,
  ): Promise<RepositoryMutationResult<PackageVersion>>;
  current(): Promise<RevisionedSnapshot<PackageVersion> | null>;
  get(id: StableId<"package-version">): Promise<PackageVersion | null>;
}

type VersionContent = Readonly<{
  sections: readonly PackageSectionDraft[];
  acknowledgmentText: string;
}>;

type PackageSectionDraft = Readonly<{
  id: StableId<"package-section">;
  order: number;
  title: string;
  markdown: string;
  enabled: boolean;
}>;

type ParsedMetadata = Readonly<{
  operationId: StorageOperationId;
  expectedRevision: number | null;
  changeSummary: string;
  materialChange: boolean;
}>;

type WorkspaceMutation = Readonly<{
  transition: string;
  metadata: ParsedMetadata;
  fingerprintData: Readonly<Record<string, string | number | boolean | null>>;
  change(
    current: PackageVersion | null,
    operationId: StorageOperationId,
  ): Promise<VersionContent> | VersionContent;
}>;

/**
 * Owner-only application service over the immutable package repository.
 * Request IDs, actor identity, version IDs, section IDs, and timestamps are
 * never accepted as authoritative package content from the browser.
 */
export class RepositoryOwnerPackageWorkspaceService
  implements OwnerPackageWorkspaceService
{
  readonly #repository: OwnerPackageWorkspaceRepository;
  readonly #now: () => Date;

  constructor(
    repository: OwnerPackageWorkspaceRepository,
    options: Readonly<{ now?: () => Date }> = {},
  ) {
    this.#repository = repository;
    this.#now = options.now ?? (() => new Date());
  }

  async read(actor: TrustedOwnerActor): Promise<OwnerPackageWorkspaceState> {
    requireOwnerActor(actor);
    const current = await this.#repository.current();
    return current === null
      ? null
      : Object.freeze({
          revision: current.revision,
          version: current.snapshot,
        });
  }

  async preview(actor: TrustedOwnerActor): Promise<OwnerPackagePreview> {
    const current = await this.read(actor);
    return current === null
      ? null
      : Object.freeze({
          revision: current.revision,
          version: current.version,
          sections: Object.freeze([
            ...visiblePackageSections(current.version),
          ]),
        });
  }

  async createSection(
    actor: TrustedOwnerActor,
    input: CreatePackageSectionInput,
  ): Promise<RepositoryMutationResult<PackageVersion>> {
    const title = requiredText(
      input.title,
      PACKAGE_CONTENT_LIMITS.titleLength,
      false,
    );
    const markdown = boundedMarkdown(input.markdown);
    const enabled = booleanValue(input.enabled);
    const acknowledgmentText = optionalText(
      input.acknowledgmentText,
      PACKAGE_CONTENT_LIMITS.acknowledgmentLength,
      true,
    );
    const metadata = parseMetadata(input);

    return this.#mutate(actor, {
      transition: "create-section",
      metadata,
      fingerprintData: {
        title,
        markdown,
        enabled,
        acknowledgmentText: acknowledgmentText ?? null,
      },
      change: async (current, operationId) => {
        const sectionId = await derivedId<"package-section">(
          "package-section",
          operationId,
        );
        const sections = current === null
          ? []
          : sectionDrafts(current.sections);
        sections.push({
          id: sectionId,
          order: sections.length,
          title,
          markdown,
          enabled,
        });
        return {
          sections,
          acknowledgmentText: current?.acknowledgmentText ??
            requiredInitialAcknowledgment(acknowledgmentText),
        };
      },
    });
  }

  async updateSection(
    actor: TrustedOwnerActor,
    input: UpdatePackageSectionInput,
  ): Promise<RepositoryMutationResult<PackageVersion>> {
    const sectionId = requiredSectionId(input.sectionId);
    const title = requiredText(
      input.title,
      PACKAGE_CONTENT_LIMITS.titleLength,
      false,
    );
    const markdown = boundedMarkdown(input.markdown);
    const metadata = parseMetadata(input);

    return this.#mutate(actor, {
      transition: "update-section",
      metadata,
      fingerprintData: { sectionId, title, markdown },
      change: (current) => {
        const version = requiredCurrentVersion(current);
        const sections = sectionDrafts(version.sections);
        const index = sectionIndex(sections, sectionId);
        sections[index] = { ...sections[index], title, markdown };
        return contentFrom(version, sections);
      },
    });
  }

  async setSectionEnabled(
    actor: TrustedOwnerActor,
    input: SetPackageSectionEnabledInput,
  ): Promise<RepositoryMutationResult<PackageVersion>> {
    const sectionId = requiredSectionId(input.sectionId);
    const enabled = booleanValue(input.enabled);
    const metadata = parseMetadata(input);

    return this.#mutate(actor, {
      transition: "set-section-enabled",
      metadata,
      fingerprintData: { sectionId, enabled },
      change: (current) => {
        const version = requiredCurrentVersion(current);
        const sections = sectionDrafts(version.sections);
        const index = sectionIndex(sections, sectionId);
        sections[index] = { ...sections[index], enabled };
        return contentFrom(version, sections);
      },
    });
  }

  async moveSection(
    actor: TrustedOwnerActor,
    input: MovePackageSectionInput,
  ): Promise<RepositoryMutationResult<PackageVersion>> {
    const sectionId = requiredSectionId(input.sectionId);
    const direction = moveDirection(input.direction);
    const metadata = parseMetadata(input);

    return this.#mutate(actor, {
      transition: "move-section",
      metadata,
      fingerprintData: { sectionId, direction },
      change: (current) => {
        const version = requiredCurrentVersion(current);
        const sections = sectionDrafts(version.sections);
        const index = sectionIndex(sections, sectionId);
        const destination = direction === "up" ? index - 1 : index + 1;
        if (destination < 0 || destination >= sections.length) conflict();

        const selected = sections[index];
        const adjacent = sections[destination];
        sections[index] = { ...adjacent, order: index };
        sections[destination] = { ...selected, order: destination };
        return contentFrom(version, sections);
      },
    });
  }

  async updateSettings(
    actor: TrustedOwnerActor,
    input: UpdatePackageSettingsInput,
  ): Promise<RepositoryMutationResult<PackageVersion>> {
    const acknowledgmentText = requiredText(
      input.acknowledgmentText,
      PACKAGE_CONTENT_LIMITS.acknowledgmentLength,
      true,
    );
    const metadata = parseMetadata(input);

    return this.#mutate(actor, {
      transition: "update-settings",
      metadata,
      fingerprintData: { acknowledgmentText },
      change: (current) => {
        const version = requiredCurrentVersion(current);
        return {
          sections: sectionDrafts(version.sections),
          acknowledgmentText,
        };
      },
    });
  }

  async #mutate(
    actor: TrustedOwnerActor,
    mutation: WorkspaceMutation,
  ): Promise<RepositoryMutationResult<PackageVersion>> {
    const subject = requireOwnerActor(actor);
    const { metadata } = mutation;
    const versionId = await derivedId<"package-version">(
      "package-version",
      metadata.operationId,
    );
    const mutationFingerprint = await fingerprint({
      transition: mutation.transition,
      actorSubject: subject,
      expectedRevision: metadata.expectedRevision,
      changeSummary: metadata.changeSummary,
      materialChange: metadata.materialChange,
      ...mutation.fingerprintData,
    });

    const existing = await this.#repository.get(versionId);
    if (existing !== null) {
      return this.#repository.append({
        operationId: metadata.operationId,
        expectedRevision: metadata.expectedRevision,
        mutationFingerprint,
        draft: versionDraft(existing),
      });
    }

    const current = await this.#repository.current();
    assertExpectedRevision(current?.revision ?? null, metadata.expectedRevision);
    const content = await mutation.change(
      current?.snapshot ?? null,
      metadata.operationId,
    );
    const createdAt = currentTimestamp(this.#now);

    return this.#repository.append({
      operationId: metadata.operationId,
      expectedRevision: metadata.expectedRevision,
      mutationFingerprint,
      draft: {
        id: versionId,
        createdAt,
        changeSummary: metadata.changeSummary,
        materialChange: metadata.materialChange,
        acknowledgmentText: content.acknowledgmentText,
        sections: content.sections,
      },
    });
  }
}

function parseMetadata(input: PackageVersionMetadataInput): ParsedMetadata {
  const operationId = parseStorageOperationId(input.operationId);
  if (!operationId.ok) invalidRequest();

  return Object.freeze({
    operationId: operationId.value,
    expectedRevision: expectedRevision(input.expectedRevision),
    changeSummary: requiredText(
      input.changeSummary,
      PACKAGE_CONTENT_LIMITS.changeSummaryLength,
      true,
    ),
    materialChange: booleanValue(input.materialChange),
  });
}

function requireOwnerActor(actor: TrustedOwnerActor): ActorSubject {
  if (actor?.type !== "owner") notFound();
  const subject = parseActorSubject(actor.subject);
  if (!subject.ok) notFound();
  return subject.value;
}

function expectedRevision(value: unknown): number | null {
  let parsed = value;
  if (typeof parsed === "string" && /^(?:0|[1-9]\d*)$/.test(parsed)) {
    parsed = Number(parsed);
  }
  if (parsed === null || parsed === 0) return null;
  if (
    typeof parsed !== "number" ||
    !Number.isSafeInteger(parsed) ||
    parsed < 1
  ) {
    invalidRequest();
  }
  return parsed;
}

function requiredText(
  value: unknown,
  maximum: number,
  multiline: boolean,
): string {
  if (typeof value !== "string") invalidRequest();
  const normalized = multiline ? value.replaceAll("\r\n", "\n") : value;
  if (
    normalized.length < 1 ||
    normalized.length > maximum ||
    normalized.trim().length === 0 ||
    normalized.trim() !== normalized ||
    hasForbiddenControl(normalized, multiline)
  ) {
    invalidRequest();
  }
  return normalized;
}

function optionalText(
  value: unknown,
  maximum: number,
  multiline: boolean,
): string | undefined {
  return value === undefined || value === null || value === ""
    ? undefined
    : requiredText(value, maximum, multiline);
}

function boundedMarkdown(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > PACKAGE_CONTENT_LIMITS.markdownLength ||
    hasForbiddenControl(value, true)
  ) {
    invalidRequest();
  }
  return value;
}

function booleanValue(value: unknown): boolean {
  if (value === true || value === "true" || value === "on") return true;
  if (
    value === false ||
    value === "false" ||
    value === "off" ||
    value === undefined ||
    value === null
  ) {
    return false;
  }
  invalidRequest();
}

function moveDirection(value: unknown): "up" | "down" {
  if (value === "up" || value === "down") return value;
  invalidRequest();
}

function requiredSectionId(value: unknown): StableId<"package-section"> {
  const parsed = parseStableId<"package-section">(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function requiredCurrentVersion(
  current: PackageVersion | null,
): PackageVersion {
  if (current === null) notFound();
  return current;
}

function requiredInitialAcknowledgment(value: string | undefined): string {
  if (value === undefined) invalidRequest();
  return value;
}

function sectionDrafts(
  sections: readonly PackageSection[],
): PackageSectionDraft[] {
  return sections.map((section) => ({
    id: section.id,
    order: section.order,
    title: section.title,
    markdown: section.markdown,
    enabled: section.enabled,
  }));
}

function sectionIndex(
  sections: readonly PackageSectionDraft[],
  id: StableId<"package-section">,
): number {
  const index = sections.findIndex((section) => section.id === id);
  if (index < 0) notFound();
  return index;
}

function contentFrom(
  version: PackageVersion,
  sections: readonly PackageSectionDraft[],
): VersionContent {
  return { sections, acknowledgmentText: version.acknowledgmentText };
}

function versionDraft(version: PackageVersion): Readonly<Record<string, unknown>> {
  return {
    id: version.id,
    createdAt: version.createdAt,
    changeSummary: version.changeSummary,
    materialChange: version.materialChange,
    acknowledgmentText: version.acknowledgmentText,
    sections: sectionDrafts(version.sections),
  };
}

function assertExpectedRevision(
  actual: number | null,
  expected: number | null,
): void {
  if (actual !== expected) {
    throw new StorageFailure("PRECONDITION_FAILED");
  }
}

function currentTimestamp(now: () => Date): Timestamp {
  let value: Date;
  try {
    value = now();
  } catch {
    unavailable();
  }
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) unavailable();
  const parsed = parseTimestamp(value.toISOString());
  if (!parsed.ok) unavailable();
  return parsed.value;
}

async function derivedId<Entity extends string>(
  namespace: string,
  operationId: StorageOperationId,
): Promise<StableId<Entity>> {
  const digest = await sha256(`${namespace}\u0000${operationId}`);
  const parsed = parseStableId<Entity>(`${namespace}:${digest}`);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

async function fingerprint(
  value: Readonly<Record<string, string | number | boolean | null>>,
): Promise<string> {
  return `sha256:${await sha256(JSON.stringify(value))}`;
}

async function sha256(value: string): Promise<string> {
  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
  } catch {
    unavailable();
  }
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hasForbiddenControl(value: string, allowLayout: boolean): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint > 31 && codePoint !== 127) continue;
    if (allowLayout && (character === "\n" || character === "\t")) continue;
    return true;
  }
  return false;
}

function invalidRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
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
