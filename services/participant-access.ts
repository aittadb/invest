import type {
  ParticipantAccessStateReader,
  ParticipantAuthorizationState,
} from "../domain/participant-home-resource.ts";
import type { ParticipantAccount } from "../domain/participant-profile.ts";
import type {
  AcknowledgmentRepository,
  PackageVersionRepository,
} from "../repositories/in-memory-content-repository.ts";
import type { ParticipantRepository } from "../repositories/in-memory-participant-repository.ts";

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
  const participant = await repositories.participant.current();
  if (participant === null) return null;

  const currentPackage = await repositories.packages.current();
  const packageState = currentPackage === null
    ? null
    : {
        id: currentPackage.snapshot.id,
        createdAt: currentPackage.snapshot.createdAt,
        changeSummary: currentPackage.snapshot.changeSummary,
        materialChange: currentPackage.snapshot.materialChange,
        requiresCurrentAcceptance:
          await repositories.acknowledgments.requiresCurrentAcceptance(),
      };

  return Object.freeze({
    profile: Object.freeze({
      subject: participant.snapshot.subject,
      displayName: participant.snapshot.displayName,
      declaredInterest: participant.snapshot.declaredInterest,
      participationContext: participant.snapshot.participationContext,
      accountDeletionRequested:
        participant.snapshot.accountDeletionRequest.state === "requested",
    }),
    currentPackage: packageState === null ? null : Object.freeze(packageState),
  });
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
