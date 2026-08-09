import {
  assessCampaignPublicationReadiness,
  type CampaignPublicationReadiness,
  type DeploymentPublicationReadinessCheck,
} from "../domain/campaign-publication-readiness.ts";
import {
  parsePublicCampaignConfiguration,
  type PublicCampaignConfiguration,
} from "../domain/public-campaign-configuration.ts";
import {
  StorageFailure,
  parseStorageOperationId,
} from "../domain/storage-adapter.ts";
import type {
  AtomicCampaignAuditRepository,
  AuditedCampaignSetupSaveResult,
  CampaignRepository,
  CampaignMutationConsistency,
  CampaignSetupRevision,
} from "../repositories/in-memory-campaign-repository.ts";

export type OwnerCampaignEditorRepository =
  | AtomicCampaignAuditRepository
  | CampaignRepository;

export type SaveCampaignPresentationInput = Readonly<{
  operationId: unknown;
  ownerSubject: unknown;
  recordedAt: unknown;
  expectedRevision: unknown;
  publicCampaign: unknown;
}>;

export type SetCampaignPublicationInput = Readonly<{
  operationId: unknown;
  ownerSubject: unknown;
  recordedAt: unknown;
  expectedRevision: unknown;
  published: boolean;
}>;

export type OwnerCampaignEditorService = Readonly<{
  mutationConsistency: CampaignMutationConsistency;
  read(): Promise<CampaignSetupRevision | null>;
  publicationReadiness(
    current: CampaignSetupRevision,
  ): Promise<CampaignPublicationReadiness>;
  savePresentation(
    input: SaveCampaignPresentationInput,
  ): Promise<AuditedCampaignSetupSaveResult>;
  setPublication(
    input: SetCampaignPublicationInput,
  ): Promise<AuditedCampaignSetupSaveResult>;
}>;

/**
 * Request-scoped owner orchestration over one injected campaign repository.
 * Unrelated phase and aggregate settings are always carried forward unchanged.
 */
export function createOwnerCampaignEditorService(
  repository: OwnerCampaignEditorRepository,
  checkDeploymentReadiness: DeploymentPublicationReadinessCheck,
): OwnerCampaignEditorService {
  const atomic = atomicCampaignRepository(repository);

  return Object.freeze({
    mutationConsistency: atomic ? "atomic-campaign-audit" : "unavailable",
    read: () => repository.readSetup(),
    publicationReadiness: (current) =>
      assessCampaignPublicationReadiness(
        current.setup,
        checkDeploymentReadiness,
      ),
    async savePresentation(input) {
      if (!atomic) unavailable();
      const operationId = requiredOperationId(input.operationId);
      const expectedRevision = requiredRevision(input.expectedRevision);
      const candidate = parseCampaign(input.publicCampaign);
      const replay = await repository.findSetupByOperationId(operationId);
      if (replay) {
        const publicCampaign = parseCampaign({
          ...candidate,
          published: replay.setup.publicCampaign.published,
        });
        assertReplayMatches(replay, expectedRevision, publicCampaign);
        return atomic.saveSetupWithAudit({
          operationId,
          ownerSubject: input.ownerSubject,
          recordedAt: replay.recordedAt,
          expectedRevision,
          setup: replay.setup,
          transition: "updated",
        });
      }

      const current = await requiredCurrentSetup(repository);
      const publicCampaign = parseCampaign({
        ...candidate,
        published: current.setup.publicCampaign.published,
      });

      return atomic.saveSetupWithAudit({
        operationId,
        ownerSubject: input.ownerSubject,
        recordedAt: input.recordedAt,
        expectedRevision,
        setup: {
          ...current.setup,
          publicCampaign,
        },
        transition: "updated",
      });
    },
    async setPublication(input) {
      if (!atomic) unavailable();
      const operationId = requiredOperationId(input.operationId);
      const expectedRevision = requiredRevision(input.expectedRevision);
      const replay = await repository.findSetupByOperationId(operationId);
      if (replay) {
        if (
          replay.revision - 1 !== expectedRevision ||
          replay.setup.publicCampaign.published !== input.published
        ) {
          throw new StorageFailure("CONFLICT");
        }
        return atomic.saveSetupWithAudit({
          operationId,
          ownerSubject: input.ownerSubject,
          recordedAt: replay.recordedAt,
          expectedRevision,
          setup: replay.setup,
          transition: input.published ? "published" : "unpublished",
        });
      }

      const current = await requiredCurrentSetup(repository);
      if (
        current.revision === expectedRevision &&
        current.setup.publicCampaign.published === input.published
      ) {
        throw new StorageFailure("INVALID_REQUEST");
      }
      if (input.published) {
        const readiness = await assessCampaignPublicationReadiness(
          current.setup,
          checkDeploymentReadiness,
        );
        if (!readiness.ready) {
          throw new CampaignPublicationNotReady(readiness);
        }
      }

      return atomic.saveSetupWithAudit({
        operationId,
        ownerSubject: input.ownerSubject,
        recordedAt: input.recordedAt,
        expectedRevision,
        setup: {
          ...current.setup,
          publicCampaign: {
            ...current.setup.publicCampaign,
            published: input.published,
          },
        },
        transition: input.published ? "published" : "unpublished",
      });
    },
  });
}

export class CampaignPublicationNotReady extends Error {
  readonly readiness: CampaignPublicationReadiness;

  constructor(readiness: CampaignPublicationReadiness) {
    super("The campaign is not ready to publish.");
    this.name = "CampaignPublicationNotReady";
    this.readiness = readiness;
  }
}

function assertReplayMatches(
  replay: CampaignSetupRevision,
  expectedRevision: number,
  publicCampaign: PublicCampaignConfiguration,
): void {
  if (
    replay.revision - 1 !== expectedRevision ||
    JSON.stringify(replay.setup.publicCampaign) !== JSON.stringify(publicCampaign)
  ) {
    throw new StorageFailure("CONFLICT");
  }
}

function atomicCampaignRepository(
  repository: OwnerCampaignEditorRepository,
): AtomicCampaignAuditRepository | null {
  const candidate = repository as Partial<AtomicCampaignAuditRepository>;
  return candidate.mutationConsistency === "atomic-campaign-audit" &&
      typeof candidate.saveSetupWithAudit === "function"
    ? candidate as AtomicCampaignAuditRepository
    : null;
}

async function requiredCurrentSetup(
  repository: CampaignRepository,
): Promise<CampaignSetupRevision> {
  const current = await repository.readSetup();
  if (current === null) throw new StorageFailure("NOT_FOUND");
  return current;
}

function requiredRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return value as number;
}

function requiredOperationId(value: unknown): string {
  const parsed = parseStorageOperationId(value);
  if (!parsed.ok) throw new StorageFailure("INVALID_REQUEST");
  return parsed.value;
}

function parseCampaign(value: unknown): PublicCampaignConfiguration {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new StorageFailure("INVALID_REQUEST", { cause: error });
  }
  const parsed = parsePublicCampaignConfiguration(serialized);
  if (parsed === null) throw new StorageFailure("INVALID_REQUEST");
  return parsed;
}

function unavailable(): never {
  throw new StorageFailure("UNAVAILABLE");
}
