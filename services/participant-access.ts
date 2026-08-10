import {
  createPackageVersion,
  PACKAGE_CONTENT_LIMITS,
  type PackageContentHash,
  type PackageVersion,
} from "../domain/package-content.ts";
import {
  parseStableId,
  parseTimestamp,
  type Timestamp,
} from "../domain/foundation.ts";
import type {
  ParticipantAccessStateReader,
  ParticipantAuthorizationState,
} from "../domain/participant-home-resource.ts";
import {
  parseParticipantAccount,
  registerParticipantProfile,
  type AccountDeletionRequestState,
  type MarketingConsent,
  type ParticipantAccount,
  type ParticipantProfile,
} from "../domain/participant-profile.ts";
import { StorageFailure } from "../domain/storage-adapter.ts";
import type {
  AcknowledgmentRepository,
  CurrentPackageAcceptanceStatus,
  PackageVersionRepository,
  RevisionedSnapshot,
} from "../repositories/in-memory-content-repository.ts";
import type {
  ParticipantProfileSnapshot,
  ParticipantRepository,
} from "../repositories/in-memory-participant-repository.ts";

export const MAX_PARTICIPANT_PROJECTION_ATTEMPTS = 2;
const PROFILE_SNAPSHOT_KEYS = new Set(["revision", "snapshot"]);
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
const PACKAGE_SNAPSHOT_KEYS = PROFILE_SNAPSHOT_KEYS;
const PACKAGE_KEYS = new Set([
  "id",
  "createdAt",
  "changeSummary",
  "materialChange",
  "acknowledgmentText",
  "sections",
  "contentHash",
  "requiredAcceptanceHash",
]);
const PACKAGE_SECTION_KEYS = new Set([
  "id",
  "order",
  "title",
  "markdown",
  "enabled",
]);
const ACCEPTANCE_STATUS_KEYS = new Set([
  "bindingRevision",
  "versionId",
  "contentHash",
  "requiredAcceptanceHash",
  "requiresCurrentAcceptance",
]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type ParticipantAccessRepositories = Readonly<{
  participant: Pick<ParticipantRepository, "current">;
  packages: Pick<PackageVersionRepository, "current">;
  acknowledgments: Pick<AcknowledgmentRepository, "currentAcceptanceStatus">;
}>;

export type ParticipantAccessRepositoriesResolver = (
  account: ParticipantAccount,
) => Promise<ParticipantAccessRepositories> | ParticipantAccessRepositories;

/** Maps subject-bound repository reads into one bounded stable projection. */
export async function readParticipantAuthorizationState(
  repositories: ParticipantAccessRepositories,
): Promise<ParticipantAuthorizationState | null> {
  try {
    for (
      let attempt = 0;
      attempt < MAX_PARTICIPANT_PROJECTION_ATTEMPTS;
      attempt += 1
    ) {
      const rawProfileBefore = await repositories.participant.current();
      const profileBefore = detachParticipantProfileSample(rawProfileBefore);
      if (profileBefore === null) return null;

      const rawPackageBefore = await repositories.packages.current();
      const packageBefore = await validatePackageSample(rawPackageBefore);
      const rawAcceptanceStatus = packageBefore === null
        ? null
        : await repositories.acknowledgments.currentAcceptanceStatus();
      const acceptanceStatus = rawAcceptanceStatus === null
        ? null
        : detachAcceptanceStatus(rawAcceptanceStatus);

      const rawPackageAfter = await repositories.packages.current();
      const packageAfter = await validatePackageSample(rawPackageAfter);
      const rawProfileAfter = await repositories.participant.current();
      const profileAfter = detachParticipantProfileSample(rawProfileAfter);

      if (
        profileAfter !== null &&
        sameParticipantProfileSnapshot(profileBefore, profileAfter) &&
        samePackageVersionSnapshot(packageBefore, packageAfter)
      ) {
        if (
          packageBefore !== null &&
          packageAfter !== null &&
          (acceptanceStatus === null ||
            !acceptanceStatusMatchesPackage(acceptanceStatus, packageBefore) ||
            !acceptanceStatusMatchesPackage(acceptanceStatus, packageAfter))
        ) {
          throw unavailable();
        }
        return authorizationState(
          profileAfter,
          packageAfter,
          acceptanceStatus?.requiresCurrentAcceptance ?? null,
        );
      }
    }
  } catch {
    throw unavailable();
  }

  throw unavailable();
}

export function createRepositoryParticipantAccessStateReader(
  resolveRepositories: ParticipantAccessRepositoriesResolver,
): ParticipantAccessStateReader {
  return Object.freeze({
    async read(account: ParticipantAccount) {
      try {
        const repositories = await resolveRepositories(account);
        return await readParticipantAuthorizationState(repositories);
      } catch {
        throw unavailable();
      }
    },
  });
}

function authorizationState(
  participant: ParticipantProfileSnapshot,
  currentPackage: RevisionedSnapshot<PackageVersion> | null,
  requiresCurrentAcceptance: boolean | null,
): ParticipantAuthorizationState {
  const packageState = currentPackage === null
    ? null
    : Object.freeze({
        id: currentPackage.snapshot.id,
        createdAt: currentPackage.snapshot.createdAt,
        changeSummary: currentPackage.snapshot.changeSummary,
        materialChange: currentPackage.snapshot.materialChange,
        requiresCurrentAcceptance: requiresCurrentAcceptance === true,
      });

  return Object.freeze({
    profile: Object.freeze({
      subject: participant.snapshot.subject,
      accountEmailLabel: participant.snapshot.accountEmailLabel,
      displayName: participant.snapshot.displayName,
      declaredInterest: participant.snapshot.declaredInterest,
      participationContext: participant.snapshot.participationContext,
      accountDeletionRequested:
        participant.snapshot.accountDeletionRequest.state === "requested",
    }),
    currentPackage: packageState,
  });
}

function detachAcceptanceStatus(
  value: unknown,
): CurrentPackageAcceptanceStatus {
  const source = exactDataRecord(value, ACCEPTANCE_STATUS_KEYS);
  const versionId = requiredPackageVersionId(source.versionId);
  const contentHash = requiredPackageHash(source.contentHash);
  const requiredAcceptanceHash = requiredPackageHash(
    source.requiredAcceptanceHash,
  );
  if (typeof source.requiresCurrentAcceptance !== "boolean") {
    throw unavailable();
  }
  return Object.freeze({
    bindingRevision: positiveSafeRevision(source.bindingRevision),
    versionId,
    contentHash,
    requiredAcceptanceHash,
    requiresCurrentAcceptance: source.requiresCurrentAcceptance,
  });
}

function acceptanceStatusMatchesPackage(
  status: CurrentPackageAcceptanceStatus,
  currentPackage: RevisionedSnapshot<PackageVersion>,
): boolean {
  return status.versionId === currentPackage.snapshot.id &&
    status.contentHash === currentPackage.snapshot.contentHash &&
    status.requiredAcceptanceHash ===
      currentPackage.snapshot.requiredAcceptanceHash;
}

function detachParticipantProfileSample(
  value: unknown,
): ParticipantProfileSnapshot | null {
  if (value === null) return null;
  const sample = exactDataRecord(value, PROFILE_SNAPSHOT_KEYS);
  const revision = positiveSafeRevision(sample.revision);
  const source = exactDataRecord(sample.snapshot, PROFILE_KEYS);

  requireBoundedString(source.subject, 255);
  requireBoundedString(source.accountEmailLabel, 254);
  requireBoundedString(source.displayName, 120);
  requireBoundedString(source.country, 2);
  const account = parseParticipantAccount({
    subject: source.subject,
    accountEmailLabel: source.accountEmailLabel,
  });
  if (
    !account.ok ||
    account.value.subject !== source.subject ||
    account.value.accountEmailLabel !== source.accountEmailLabel
  ) {
    throw unavailable();
  }

  const registeredAt = requiredTimestamp(source.registeredAt);
  const updatedAt = requiredTimestamp(source.updatedAt);
  const processEmailNoticeAcknowledgedAt = requiredTimestamp(
    source.processEmailNoticeAcknowledgedAt,
  );
  if (
    processEmailNoticeAcknowledgedAt !== registeredAt ||
    updatedAt < registeredAt
  ) {
    throw unavailable();
  }

  const marketingConsent = detachMarketingConsent(
    source.marketingConsent,
    registeredAt,
    updatedAt,
  );
  const accountDeletionRequest = detachDeletionRequest(
    source.accountDeletionRequest,
    registeredAt,
    updatedAt,
  );
  const registration = registerParticipantProfile(
    account.value,
    {
      displayName: source.displayName,
      country: source.country,
      declaredInterest: source.declaredInterest,
      participationContext: source.participationContext,
      processEmailNoticeAcknowledged: true,
      marketingConsent: marketingConsent.state === "granted",
    },
    registeredAt,
  );
  if (
    !registration.ok ||
    registration.value.displayName !== source.displayName ||
    registration.value.country !== source.country ||
    registration.value.declaredInterest !== source.declaredInterest ||
    registration.value.participationContext !== source.participationContext
  ) {
    throw unavailable();
  }

  const snapshot: ParticipantProfile = Object.freeze({
    subject: account.value.subject,
    accountEmailLabel: account.value.accountEmailLabel,
    displayName: registration.value.displayName,
    country: registration.value.country,
    declaredInterest: registration.value.declaredInterest,
    participationContext: registration.value.participationContext,
    processEmailNoticeAcknowledgedAt,
    marketingConsent,
    accountDeletionRequest,
    registeredAt,
    updatedAt,
  });
  return Object.freeze({ revision, snapshot });
}

function detachMarketingConsent(
  value: unknown,
  registeredAt: Timestamp,
  updatedAt: Timestamp,
): MarketingConsent {
  const state = exactVariantState(value);
  if (state === "not-granted") {
    exactDataRecord(value, new Set(["state"]));
    return Object.freeze({ state });
  }
  if (state === "granted") {
    const source = exactDataRecord(value, new Set(["state", "grantedAt"]));
    const grantedAt = requiredTimestamp(source.grantedAt);
    if (grantedAt !== registeredAt || grantedAt > updatedAt) {
      throw unavailable();
    }
    return Object.freeze({ state, grantedAt });
  }
  if (state !== "withdrawn") throw unavailable();

  const hasGrantedAt = hasOwnDataProperty(value, "grantedAt");
  const source = exactDataRecord(
    value,
    new Set([
      "state",
      ...(hasGrantedAt ? ["grantedAt"] : []),
      "withdrawnAt",
    ]),
  );
  const withdrawnAt = requiredTimestamp(source.withdrawnAt);
  const grantedAt = hasGrantedAt
    ? requiredTimestamp(source.grantedAt)
    : undefined;
  if (
    withdrawnAt < registeredAt ||
    withdrawnAt > updatedAt ||
    (grantedAt !== undefined &&
      (grantedAt !== registeredAt || grantedAt > withdrawnAt))
  ) {
    throw unavailable();
  }
  return Object.freeze({
    state,
    ...(grantedAt === undefined ? {} : { grantedAt }),
    withdrawnAt,
  });
}

function detachDeletionRequest(
  value: unknown,
  registeredAt: Timestamp,
  updatedAt: Timestamp,
): AccountDeletionRequestState {
  const state = exactVariantState(value);
  if (state === "not-requested") {
    exactDataRecord(value, new Set(["state"]));
    return Object.freeze({ state });
  }
  if (state !== "requested") throw unavailable();
  const source = exactDataRecord(
    value,
    new Set(["state", "requestedAt", "activeInterestDisposition"]),
  );
  const requestedAt = requiredTimestamp(source.requestedAt);
  if (
    source.activeInterestDisposition !== "withdraw" ||
    requestedAt < registeredAt ||
    requestedAt > updatedAt
  ) {
    throw unavailable();
  }
  return Object.freeze({
    state,
    requestedAt,
    activeInterestDisposition: "withdraw",
  });
}

type DetachedPackageCandidate = Readonly<{
  revision: number;
  draft: Readonly<{
    id: string;
    createdAt: string;
    changeSummary: string;
    materialChange: boolean;
    acknowledgmentText: string;
    sections: readonly Readonly<{
      id: string;
      order: number;
      title: string;
      markdown: string;
      enabled: boolean;
    }>[];
  }>;
  contentHash: string;
  requiredAcceptanceHash: string;
}>;

async function validatePackageSample(
  value: unknown,
): Promise<RevisionedSnapshot<PackageVersion> | null> {
  const candidate = detachPackageCandidate(value);
  if (candidate === null) return null;

  const initial = await createPackageVersion(candidate.draft);
  if (!initial.ok || initial.value.contentHash !== candidate.contentHash) {
    throw unavailable();
  }
  const validated = candidate.draft.materialChange
    ? initial
    : await createPackageVersion(
        candidate.draft,
        Object.freeze({
          ...initial.value,
          requiredAcceptanceHash:
            candidate.requiredAcceptanceHash as PackageContentHash,
        }),
      );
  if (
    !validated.ok ||
    validated.value.requiredAcceptanceHash !==
      candidate.requiredAcceptanceHash ||
    !sameDetachedPackageCandidate(candidate, validated.value)
  ) {
    throw unavailable();
  }
  return Object.freeze({
    revision: candidate.revision,
    snapshot: validated.value,
  });
}

function detachPackageCandidate(value: unknown): DetachedPackageCandidate | null {
  if (value === null) return null;
  const sample = exactDataRecord(value, PACKAGE_SNAPSHOT_KEYS);
  const revision = positiveSafeRevision(sample.revision);
  const source = exactDataRecord(sample.snapshot, PACKAGE_KEYS);

  const id = requiredStableId(source.id);
  const createdAt = requiredTimestamp(source.createdAt);
  const changeSummary = requireBoundedString(
    source.changeSummary,
    PACKAGE_CONTENT_LIMITS.changeSummaryLength,
  );
  const acknowledgmentText = requireBoundedString(
    source.acknowledgmentText,
    PACKAGE_CONTENT_LIMITS.acknowledgmentLength,
  );
  if (typeof source.materialChange !== "boolean") throw unavailable();
  const sections = exactDataArray(
    source.sections,
    PACKAGE_CONTENT_LIMITS.sections,
  ).map((value) => detachPackageSection(value));
  const contentHash = requiredPackageHash(source.contentHash);
  const requiredAcceptanceHash = requiredPackageHash(
    source.requiredAcceptanceHash,
  );

  return deepFreeze({
    revision,
    draft: {
      id,
      createdAt,
      changeSummary,
      materialChange: source.materialChange,
      acknowledgmentText,
      sections,
    },
    contentHash,
    requiredAcceptanceHash,
  });
}

function detachPackageSection(value: unknown): DetachedPackageCandidate["draft"]["sections"][number] {
  const source = exactDataRecord(value, PACKAGE_SECTION_KEYS);
  const id = requiredStableId(source.id);
  const title = requireBoundedString(
    source.title,
    PACKAGE_CONTENT_LIMITS.titleLength,
  );
  const markdown = requireBoundedString(
    source.markdown,
    PACKAGE_CONTENT_LIMITS.markdownLength,
  );
  if (
    typeof source.order !== "number" ||
    !Number.isSafeInteger(source.order) ||
    source.order < 0 ||
    typeof source.enabled !== "boolean"
  ) {
    throw unavailable();
  }
  return Object.freeze({
    id,
    order: source.order,
    title,
    markdown,
    enabled: source.enabled,
  });
}

function sameDetachedPackageCandidate(
  candidate: DetachedPackageCandidate,
  version: PackageVersion,
): boolean {
  const draft = candidate.draft;
  return version.id === draft.id &&
    version.createdAt === draft.createdAt &&
    version.changeSummary === draft.changeSummary &&
    version.materialChange === draft.materialChange &&
    version.acknowledgmentText === draft.acknowledgmentText &&
    version.contentHash === candidate.contentHash &&
    version.requiredAcceptanceHash === candidate.requiredAcceptanceHash &&
    samePackageSections(version.sections, draft.sections);
}

function sameParticipantProfileSnapshot(
  left: ParticipantProfileSnapshot,
  right: ParticipantProfileSnapshot,
): boolean {
  return left.revision === right.revision &&
    sameParticipantProfile(left.snapshot, right.snapshot);
}

function sameParticipantProfile(
  left: ParticipantProfile,
  right: ParticipantProfile,
): boolean {
  return left.subject === right.subject &&
    left.accountEmailLabel === right.accountEmailLabel &&
    left.displayName === right.displayName &&
    left.country === right.country &&
    left.declaredInterest === right.declaredInterest &&
    left.participationContext === right.participationContext &&
    left.processEmailNoticeAcknowledgedAt ===
      right.processEmailNoticeAcknowledgedAt &&
    sameMarketingConsent(left.marketingConsent, right.marketingConsent) &&
    sameDeletionRequest(
      left.accountDeletionRequest,
      right.accountDeletionRequest,
    ) &&
    left.registeredAt === right.registeredAt &&
    left.updatedAt === right.updatedAt;
}

function sameMarketingConsent(
  left: MarketingConsent,
  right: MarketingConsent,
): boolean {
  if (left.state !== right.state) return false;
  if (left.state === "not-granted" || right.state === "not-granted") {
    return true;
  }
  if (left.state === "granted" || right.state === "granted") {
    return left.state === "granted" &&
      right.state === "granted" &&
      left.grantedAt === right.grantedAt;
  }
  return left.withdrawnAt === right.withdrawnAt &&
    left.grantedAt === right.grantedAt;
}

function sameDeletionRequest(
  left: AccountDeletionRequestState,
  right: AccountDeletionRequestState,
): boolean {
  if (left.state !== right.state) return false;
  return left.state === "not-requested" ||
    (right.state === "requested" &&
      left.requestedAt === right.requestedAt &&
      left.activeInterestDisposition === right.activeInterestDisposition);
}

function samePackageVersionSnapshot(
  left: RevisionedSnapshot<PackageVersion> | null,
  right: RevisionedSnapshot<PackageVersion> | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.revision === right.revision &&
    samePackageVersion(left.snapshot, right.snapshot);
}

function samePackageVersion(left: PackageVersion, right: PackageVersion): boolean {
  return left.id === right.id &&
    left.createdAt === right.createdAt &&
    left.changeSummary === right.changeSummary &&
    left.materialChange === right.materialChange &&
    left.acknowledgmentText === right.acknowledgmentText &&
    left.contentHash === right.contentHash &&
    left.requiredAcceptanceHash === right.requiredAcceptanceHash &&
    samePackageSections(left.sections, right.sections);
}

function samePackageSections(
  left: PackageVersion["sections"],
  right: DetachedPackageCandidate["draft"]["sections"],
): boolean {
  return left.length === right.length && left.every((section, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      section.id === candidate.id &&
      section.order === candidate.order &&
      section.title === candidate.title &&
      section.markdown === candidate.markdown &&
      section.enabled === candidate.enabled;
  });
}

function exactDataRecord(
  value: unknown,
  expectedKeys: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw unavailable();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw unavailable();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.size ||
    !keys.every((key) => typeof key === "string" && expectedKeys.has(key))
  ) {
    throw unavailable();
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw unavailable();
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function exactDataArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw unavailable();
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximum
  ) {
    throw unavailable();
  }
  const length = lengthDescriptor.value;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes("length")) {
    throw unavailable();
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw unavailable();
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function exactVariantState(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw unavailable();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw unavailable();
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "state");
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.enumerable !== true ||
    typeof descriptor.value !== "string"
  ) {
    throw unavailable();
  }
  return descriptor.value;
}

function hasOwnDataProperty(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null) throw unavailable();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return false;
  if (!("value" in descriptor) || descriptor.enumerable !== true) {
    throw unavailable();
  }
  return true;
}

function positiveSafeRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw unavailable();
  }
  return value;
}

function requiredTimestamp(value: unknown): Timestamp {
  const parsed = parseTimestamp(value);
  if (!parsed.ok) throw unavailable();
  return parsed.value;
}

function requiredStableId(value: unknown): string {
  requireBoundedString(value, 128);
  const parsed = parseStableId(value);
  if (!parsed.ok || parsed.value !== value) throw unavailable();
  return parsed.value;
}

function requiredPackageVersionId(
  value: unknown,
): CurrentPackageAcceptanceStatus["versionId"] {
  requireBoundedString(value, 128);
  const parsed = parseStableId<"package-version">(value);
  if (!parsed.ok || parsed.value !== value) throw unavailable();
  return parsed.value;
}

function requiredPackageHash(value: unknown): PackageContentHash {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw unavailable();
  }
  return value as PackageContentHash;
}

function requireBoundedString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum) {
    throw unavailable();
  }
  return value;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function unavailable(): StorageFailure {
  return new StorageFailure("UNAVAILABLE");
}
