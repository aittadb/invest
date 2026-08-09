import {
  parseContributionAreaChoices,
  type ContributionAreaChoice,
  type FounderApplication,
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
  parseStorageOperationId,
  type StorageOperationId,
} from "../domain/storage-adapter.ts";
import type {
  FounderApplicationMutationResult,
  FounderApplicationRepository,
} from "../repositories/in-memory-founder-application-repository.ts";

export type FounderInterestState = Readonly<{
  application: FounderApplication | null;
  contributionAreaChoices: readonly ContributionAreaChoice[];
  canCreate: boolean;
}>;

export type CreateFounderInterestInput = Readonly<{
  operationId: unknown;
  fields: unknown;
}>;

export type EditFounderInterestInput = Readonly<{
  operationId: unknown;
  expectedRevision: number;
  fields: unknown;
}>;

export type WithdrawFounderInterestInput = Readonly<{
  operationId: unknown;
  expectedRevision: number;
}>;

/** Participant-bound application boundary used by the founder-interest route. */
export interface ParticipantFounderInterestService {
  getState(): Promise<FounderInterestState>;
  create(
    input: CreateFounderInterestInput,
  ): Promise<FounderApplicationMutationResult<ReceivedFounderApplication>>;
  edit(
    input: EditFounderInterestInput,
  ): Promise<FounderApplicationMutationResult<ReceivedFounderApplication>>;
  withdraw(
    input: WithdrawFounderInterestInput,
  ): Promise<FounderApplicationMutationResult<WithdrawnFounderApplication>>;
}

export type ParticipantFounderInterestServiceFactory = (
  actorSubject: ActorSubject,
) => ParticipantFounderInterestService;

export type FounderInterestServiceOptions = Readonly<{
  actorSubject: ActorSubject;
  applicationId: FounderApplicationId;
  contributionAreaChoices: readonly ContributionAreaChoice[];
  repository: FounderApplicationRepository;
  canCreate: () => boolean | Promise<boolean>;
  now?: () => Date;
}>;

/**
 * Compose one participant's use case without retaining process-local state.
 * Repository identity, campaign policy, contribution choices, and time are all
 * supplied by the caller's trusted request-scoped factory.
 */
export function createParticipantFounderInterestService(
  options: FounderInterestServiceOptions,
): ParticipantFounderInterestService {
  const actorSubject = requiredActorSubject(options.actorSubject);
  const applicationId = requiredApplicationId(options.applicationId);
  const contributionAreaChoices = requiredContributionAreaChoices(
    options.contributionAreaChoices,
  );
  const now = options.now ?? (() => new Date());

  if (
    typeof options.repository !== "object" ||
    options.repository === null ||
    typeof options.canCreate !== "function" ||
    typeof now !== "function"
  ) {
    invalidConfiguration();
  }

  const loadOwned = async (): Promise<FounderApplication | null> => {
    const application = await options.repository.get(applicationId);
    if (
      application === null ||
      application.id !== applicationId ||
      application.applicantSubject !== actorSubject
    ) {
      return null;
    }
    return application;
  };

  const creationAllowed = async (): Promise<boolean> => {
    let allowed: unknown;
    try {
      allowed = await options.canCreate();
    } catch (error) {
      throw new StorageFailure("UNAVAILABLE", { cause: error });
    }
    if (typeof allowed !== "boolean") unavailable();
    return allowed;
  };

  const mutationMetadata = async (
    operation: unknown,
  ): Promise<Readonly<{
    operationId: StorageOperationId;
    historyEntryId: FounderApplicationHistoryEntryId;
    occurredAt: Timestamp;
    replayKnown: boolean;
  }>> => {
    const operationId = parseStorageOperationId(operation);
    const historyEntryId = parseStableId<"founder-application-history-entry">(
      operation,
    );
    if (!operationId.ok || !historyEntryId.ok) invalidRequest();

    const current = await loadOwned();
    const priorEntry = current?.history.find(
      (entry) => entry.id === historyEntryId.value,
    );
    if (priorEntry) {
      return Object.freeze({
        operationId: operationId.value,
        historyEntryId: historyEntryId.value,
        occurredAt: priorEntry.occurredAt,
        replayKnown: true,
      });
    }

    let currentDate: Date;
    try {
      currentDate = now();
    } catch (error) {
      throw new StorageFailure("UNAVAILABLE", { cause: error });
    }
    if (!(currentDate instanceof Date) || Number.isNaN(currentDate.valueOf())) {
      unavailable();
    }
    const occurredAt = parseTimestamp(currentDate.toISOString());
    if (!occurredAt.ok || (current && occurredAt.value < current.updatedAt)) {
      unavailable();
    }

    return Object.freeze({
      operationId: operationId.value,
      historyEntryId: historyEntryId.value,
      occurredAt: occurredAt.value,
      replayKnown: false,
    });
  };

  return Object.freeze({
    async getState() {
      const application = await loadOwned();
      return Object.freeze({
        application,
        contributionAreaChoices,
        canCreate: application === null ? await creationAllowed() : false,
      });
    },

    async create(input: CreateFounderInterestInput) {
      const metadata = await mutationMetadata(input.operationId);
      if (!metadata.replayKnown && !(await creationAllowed())) {
        throw new StorageFailure("PRECONDITION_FAILED");
      }
      return requireOwnedResult(
        await options.repository.create({
          operationId: metadata.operationId,
          expectedRevision: null,
          id: applicationId,
          occurredAt: metadata.occurredAt,
          historyEntryId: metadata.historyEntryId,
          fields: input.fields,
        }),
        actorSubject,
        applicationId,
        "received",
      );
    },

    async edit(input: EditFounderInterestInput) {
      const metadata = await mutationMetadata(input.operationId);
      return requireOwnedResult(
        await options.repository.edit({
          operationId: metadata.operationId,
          expectedRevision: input.expectedRevision,
          id: applicationId,
          occurredAt: metadata.occurredAt,
          historyEntryId: metadata.historyEntryId,
          fields: input.fields,
        }),
        actorSubject,
        applicationId,
        "received",
      );
    },

    async withdraw(input: WithdrawFounderInterestInput) {
      const metadata = await mutationMetadata(input.operationId);
      return requireOwnedResult(
        await options.repository.withdraw({
          operationId: metadata.operationId,
          expectedRevision: input.expectedRevision,
          id: applicationId,
          occurredAt: metadata.occurredAt,
          historyEntryId: metadata.historyEntryId,
        }),
        actorSubject,
        applicationId,
        "withdrawn",
      );
    },
  });
}

function requireOwnedResult<Status extends "received" | "withdrawn">(
  result: FounderApplicationMutationResult,
  actorSubject: ActorSubject,
  applicationId: FounderApplicationId,
  status: Status,
): FounderApplicationMutationResult<
  Status extends "received"
    ? ReceivedFounderApplication
    : WithdrawnFounderApplication
> {
  if (
    result.snapshot.id !== applicationId ||
    result.snapshot.applicantSubject !== actorSubject ||
    result.snapshot.status !== status
  ) {
    notFound();
  }
  return result as FounderApplicationMutationResult<
    Status extends "received"
      ? ReceivedFounderApplication
      : WithdrawnFounderApplication
  >;
}

function requiredContributionAreaChoices(
  value: unknown,
): readonly ContributionAreaChoice[] {
  const parsed = parseContributionAreaChoices(value);
  if (!parsed.ok || parsed.value.length < 1) invalidConfiguration();
  return parsed.value;
}

function requiredActorSubject(value: unknown): ActorSubject {
  const parsed = parseActorSubject(value);
  if (!parsed.ok) invalidConfiguration();
  return parsed.value;
}

function requiredApplicationId(value: unknown): FounderApplicationId {
  const parsed = parseStableId<"founder-application">(value);
  if (!parsed.ok) invalidConfiguration();
  return parsed.value;
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

function invalidConfiguration(): never {
  throw new Error("Invalid founder-interest service configuration.");
}
