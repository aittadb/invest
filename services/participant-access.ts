import type {
  ParticipantAccessStateReader,
  ParticipantAuthorizationState,
} from "../domain/participant-home-resource.ts";
import type { ParticipantAccount } from "../domain/participant-profile.ts";
import type {
  AcknowledgmentRepository,
  PackageVersionRepository,
  RevisionedSnapshot,
} from "../repositories/in-memory-content-repository.ts";
import type { PackageVersion } from "../domain/package-content.ts";
import type { ParticipantProfile } from "../domain/participant-profile.ts";
import { StorageFailure } from "../domain/storage-adapter.ts";
import type {
  ParticipantProfileSnapshot,
  ParticipantRepository,
} from "../repositories/in-memory-participant-repository.ts";

const MAX_PARTICIPANT_PROJECTION_ATTEMPTS = 2;

export type ParticipantAccessRepositories = Readonly<{
  participant: Pick<ParticipantRepository, "current">;
  packages: Pick<PackageVersionRepository, "current">;
  acknowledgments: Pick<AcknowledgmentRepository, "requiresCurrentAcceptance">;
}>;

export type ParticipantAccessRepositoriesResolver = (
  account: ParticipantAccount,
) => Promise<ParticipantAccessRepositories> | ParticipantAccessRepositories;

/** Maps subject-bound repository reads into the narrow home authorization state. */
export async function readParticipantAuthorizationState(
  repositories: ParticipantAccessRepositories,
): Promise<ParticipantAuthorizationState | null> {
  try {
    for (
      let attempt = 0;
      attempt < MAX_PARTICIPANT_PROJECTION_ATTEMPTS;
      attempt += 1
    ) {
      const profileBefore = await repositories.participant.current();
      if (profileBefore === null) return null;

      const packageBefore = await repositories.packages.current();
      const requiresCurrentAcceptance = packageBefore === null
        ? null
        : await repositories.acknowledgments.requiresCurrentAcceptance();
      if (
        requiresCurrentAcceptance !== null &&
        typeof requiresCurrentAcceptance !== "boolean"
      ) {
        throw unavailable();
      }
      const packageAfter = await repositories.packages.current();
      const profileAfter = await repositories.participant.current();

      if (
        profileAfter !== null &&
        sameParticipantProfileSnapshot(profileBefore, profileAfter) &&
        samePackageVersionSnapshot(packageBefore, packageAfter)
      ) {
        return authorizationState(
          profileAfter,
          packageAfter,
          requiresCurrentAcceptance,
        );
      }
    }
  } catch (error) {
    throw unavailable(error);
  }

  throw unavailable();
}

export function createRepositoryParticipantAccessStateReader(
  resolveRepositories: ParticipantAccessRepositoriesResolver,
): ParticipantAccessStateReader {
  return Object.freeze({
    async read(account: ParticipantAccount) {
      return readParticipantAuthorizationState(
        await resolveRepositories(account),
      );
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
      displayName: participant.snapshot.displayName,
      declaredInterest: participant.snapshot.declaredInterest,
      participationContext: participant.snapshot.participationContext,
      accountDeletionRequested:
        participant.snapshot.accountDeletionRequest.state === "requested",
    }),
    currentPackage: packageState,
  });
}

function sameParticipantProfileSnapshot(
  left: ParticipantProfileSnapshot,
  right: ParticipantProfileSnapshot | null,
): boolean {
  if (right === null || left.revision !== right.revision) return false;
  return sameParticipantProfile(left.snapshot, right.snapshot);
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
  left: ParticipantProfile["marketingConsent"],
  right: ParticipantProfile["marketingConsent"],
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
  left: ParticipantProfile["accountDeletionRequest"],
  right: ParticipantProfile["accountDeletionRequest"],
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
  if (left.revision !== right.revision) return false;
  return samePackageVersion(left.snapshot, right.snapshot);
}

function samePackageVersion(left: PackageVersion, right: PackageVersion): boolean {
  if (
    left.id !== right.id ||
    left.createdAt !== right.createdAt ||
    left.changeSummary !== right.changeSummary ||
    left.materialChange !== right.materialChange ||
    left.acknowledgmentText !== right.acknowledgmentText ||
    left.contentHash !== right.contentHash ||
    left.requiredAcceptanceHash !== right.requiredAcceptanceHash ||
    left.sections.length !== right.sections.length
  ) {
    return false;
  }
  return left.sections.every((section, index) => {
    const candidate = right.sections[index];
    return candidate !== undefined &&
      section.id === candidate.id &&
      section.order === candidate.order &&
      section.title === candidate.title &&
      section.markdown === candidate.markdown &&
      section.enabled === candidate.enabled;
  });
}

function unavailable(cause?: unknown): StorageFailure {
  return new StorageFailure(
    "UNAVAILABLE",
    cause === undefined ? {} : { cause },
  );
}
