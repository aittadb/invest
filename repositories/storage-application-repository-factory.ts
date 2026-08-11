import {
  parseActorSubject,
  parseTimestamp,
  type ActorSubject,
} from "../domain/foundation.ts";
import type { ParticipantAccessStateReader } from "../domain/participant-home-resource.ts";
import type { ContributionAreaChoice } from "../domain/founder-application.ts";
import {
  parseParticipantAccount,
  type ParticipantAccount,
} from "../domain/participant-profile.ts";
import type { AmountConfiguration } from "../domain/amount-aggregate-configuration.ts";
import type { InvestmentIndicationParsingOptions } from "../domain/investment-indication.ts";
import {
  StorageFailure,
  parseStorageCollection,
  parseStorageKey,
  parseStorageOperationId,
  type StorageAdapter,
  type StorageCollection,
  type StorageDocument,
  type StorageKey,
  type StorageRecord,
} from "../domain/storage-adapter.ts";
import type {
  BrowserMutationReplayClaim,
  BrowserMutationReplayClaimer,
} from "../http/browser-mutation-session.ts";
import { RepositoryOwnerPackageWorkspaceService } from "../services/owner-package-workspace.ts";
import {
  MAX_PARTICIPANT_PROJECTION_ATTEMPTS,
  createRepositoryParticipantAccessStateReader,
} from "../services/participant-access.ts";
import type {
  OwnerIndicationReviewTokenBoundary,
} from "../services/owner-indication-review-tokens.ts";
import type {
  AtomicOwnerIndicationModerationRepository,
} from "../services/owner-indication-moderation.ts";
import {
  MAX_CAMPAIGN_SETUP_MATERIALIZATION_READS,
  StorageCampaignRepository,
  StoragePublicCampaignPresentationReader,
  campaignSetupRevisionCheck,
  verifyCampaignSetupRevisionCheckRecord,
  type AtomicCampaignAuditRepository,
  type CampaignRepository,
  type CampaignSetupRevision,
  type PublicCampaignPresentationReader,
} from "./in-memory-campaign-repository.ts";
import {
  MAX_ACCEPTANCE_GATE_READ_ATTEMPTS,
  PACKAGE_STORAGE_READ_LIMITS,
  StorageAcknowledgmentRepository,
  StoragePackageVersionRepository,
  type AcknowledgmentRepository,
  type PackageVersionRepository,
} from "./in-memory-content-repository.ts";
import {
  MAX_FOUNDER_APPLICATION_MATERIALIZATION_READS,
  MAX_FOUNDER_APPLICATION_STORAGE_READS,
  StorageFounderApplicationReviewCollectionRepository,
  StorageFounderApplicationRepository,
  type FounderApplicationReviewCollectionRepository,
  type FounderApplicationRepository,
} from "./in-memory-founder-application-repository.ts";
import { StorageOwnerIndicationReviewCollectionRepository } from "./in-memory-indication-repository.ts";
import {
  StorageParticipantRepository,
  participantProfileRevisionCheck,
  verifyParticipantProfileRevisionCheckRecord,
  type ParticipantRegistrationRepository,
  type ParticipantRepository,
} from "./in-memory-participant-repository.ts";
import { StorageParticipantInvestmentInterestRepository } from "./storage-participant-investment-repository.ts";
import {
  OwnerBoundInvestmentAggregateCorrectionRepository,
  type CampaignRevisionBoundAggregateCorrectionRepository,
} from "./in-memory-aggregate-repository.ts";
import {
  StorageAuditEventReader,
  StorageManualNotificationRepository,
  type AtomicManualNotificationActivityRepository,
  type AuditEventReader,
} from "./in-memory-audit-notification-repositories.ts";
import {
  StoragePublicCampaignStateReader,
  type PublicCampaignStateReader,
} from "./storage-public-campaign-state-reader.ts";
import { StorageOwnerIndicationModerationRepository } from "./storage-owner-indication-moderation-repository.ts";

const REPLAY_SCHEMA_VERSION = 1;
const REPLAY_COLLECTION = storageCollection("browser-mutation-replays");
const REPLAY_CAPABILITY_PATTERN =
  /^browser-mutation:v1:[A-Za-z0-9_-]{43}$/u;
const MAX_REPLAY_TTL_SECONDS = 600;
const MAX_PROFILE_READS_PER_PROJECTION_ATTEMPT = 6;
const MAX_PACKAGE_HEAD_READS_PER_PROJECTION_ATTEMPT = 2;
const MAX_ACCEPTANCE_READS_PER_GATE_ATTEMPT = 4;
const MAX_ACKNOWLEDGMENT_ROUTE_STATE_READS = 4;
const MAX_ACKNOWLEDGMENT_ROUTE_OPERATION_READS = 4;
const MAX_PROFILE_ROUTE_CURRENT_READS = 3;
const MAX_PROFILE_ROUTE_REVISION_READS = 2;
const MAX_PROFILE_ROUTE_MUTATION_READS = 3;
const MAX_PROFILE_ROUTE_STORAGE_READS =
  MAX_PROFILE_ROUTE_CURRENT_READS +
  2 * MAX_PROFILE_ROUTE_REVISION_READS +
  MAX_PROFILE_ROUTE_MUTATION_READS +
  MAX_PROFILE_ROUTE_CURRENT_READS +
  2 * MAX_PROFILE_ROUTE_REVISION_READS +
  MAX_PROFILE_ROUTE_MUTATION_READS +
  MAX_PROFILE_ROUTE_CURRENT_READS;
const MAX_PACKAGE_ROUTE_STORAGE_READS = 1;
const MAX_ACKNOWLEDGMENT_ROUTE_STORAGE_READS =
  MAX_ACKNOWLEDGMENT_ROUTE_STATE_READS +
  MAX_ACKNOWLEDGMENT_ROUTE_OPERATION_READS;
export const PARTICIPANT_FOUNDER_ROUTE_STORAGE_READ_LIMIT =
  2 * MAX_CAMPAIGN_SETUP_MATERIALIZATION_READS +
  3 * MAX_FOUNDER_APPLICATION_MATERIALIZATION_READS +
  MAX_FOUNDER_APPLICATION_STORAGE_READS;
export const PARTICIPANT_AUTHORIZATION_STORAGE_READ_LIMIT =
  PACKAGE_STORAGE_READ_LIMITS.maxReconstructionReads - 1 +
  MAX_PARTICIPANT_PROJECTION_ATTEMPTS *
    (MAX_PROFILE_READS_PER_PROJECTION_ATTEMPT +
      MAX_PACKAGE_HEAD_READS_PER_PROJECTION_ATTEMPT +
      MAX_ACCEPTANCE_GATE_READ_ATTEMPTS *
        MAX_ACCEPTANCE_READS_PER_GATE_ATTEMPT);
export const PARTICIPANT_REQUEST_ROUTE_STORAGE_READ_LIMIT =
  Math.max(
    MAX_PACKAGE_ROUTE_STORAGE_READS,
    MAX_ACKNOWLEDGMENT_ROUTE_STORAGE_READS,
    MAX_PROFILE_ROUTE_STORAGE_READS,
    PARTICIPANT_FOUNDER_ROUTE_STORAGE_READ_LIMIT,
  );
export const PARTICIPANT_REQUEST_STORAGE_READ_LIMIT =
  PARTICIPANT_AUTHORIZATION_STORAGE_READ_LIMIT +
  PARTICIPANT_REQUEST_ROUTE_STORAGE_READ_LIMIT;

export type ParticipantPackageAcknowledgmentRepositories = Readonly<{
  packages: Pick<PackageVersionRepository, "current">;
  acknowledgments: Pick<
    AcknowledgmentRepository,
    "get" | "latest" | "record"
  >;
}>;

export type ParticipantFounderApplicationRepositories = Readonly<{
  campaign: Pick<CampaignRepository, "readSetup">;
  participant: Pick<ParticipantRepository, "current">;
  applications(
    contributionAreaChoices: readonly ContributionAreaChoice[],
  ): FounderApplicationRepository;
  policyBoundApplications(
    contributionAreaChoices: readonly ContributionAreaChoice[],
    campaignSetupRevision: number,
    participantProfileRevision?: number,
  ): FounderApplicationRepository;
}>;

export type ParticipantRequestRepositoryScope = Readonly<{
  participantAccessReader(): ParticipantAccessStateReader;
  participantProfileRepository(): ParticipantRepository;
  participantPackageReader(
    participantSubject: ActorSubject,
  ): Pick<PackageVersionRepository, "current">;
  participantPackageAcknowledgments(
    participantSubject: ActorSubject,
  ): ParticipantPackageAcknowledgmentRepositories;
  participantFounderApplications(): ParticipantFounderApplicationRepositories;
}>;

/**
 * Factory for production repository capabilities backed by one credential-bound
 * StorageAdapter. Feature builders are supplied only by their own production
 * wiring task after that repository contract is proven.
 */
export class StorageApplicationRepositoryFactory {
  readonly #storage: StorageAdapter;
  readonly #claimBrowserMutationReplay: BrowserMutationReplayClaimer;
  readonly #campaignRepository: AtomicCampaignAuditRepository;
  readonly #publicCampaignReader: PublicCampaignPresentationReader;
  readonly #publicCampaignStateReader: PublicCampaignStateReader;
  readonly #ownerPackageWorkspace: RepositoryOwnerPackageWorkspaceService;
  readonly #ownerAuditEvents: AuditEventReader;
  readonly #ownerFounderApplicationReviews:
    FounderApplicationReviewCollectionRepository;
  readonly #ownerManualNotificationActivity:
    AtomicManualNotificationActivityRepository;
  readonly #participantRequest: (
    account: ParticipantAccount,
  ) => ParticipantRequestRepositoryScope;
  readonly #participantRepositoryFor: (
    account: ParticipantAccount,
  ) => ParticipantRegistrationRepository;

  constructor(storage: StorageAdapter, now: () => Date) {
    const adapter = requiredStorageAdapter(storage);
    this.#storage = adapter;
    const clock = requiredClock(now);
    const packageVersions = new StoragePackageVersionRepository(adapter);
    this.#ownerPackageWorkspace = new RepositoryOwnerPackageWorkspaceService(
      packageVersions,
      { now: clock },
    );
    this.#ownerAuditEvents = new StorageAuditEventReader(adapter);
    this.#ownerFounderApplicationReviews =
      new StorageFounderApplicationReviewCollectionRepository(adapter);
    this.#ownerManualNotificationActivity =
      new StorageManualNotificationRepository(adapter);
    this.#participantRequest = (account) =>
      createParticipantRequestRepositoryScope(adapter, account);
    this.#participantRepositoryFor = (account) =>
      new StorageParticipantRepository(adapter, account);
    this.#claimBrowserMutationReplay = Object.freeze(
      (claim: BrowserMutationReplayClaim) => claimReplay(adapter, clock, claim),
    );
    this.#campaignRepository = new StorageCampaignRepository(adapter);
    this.#publicCampaignReader = new StoragePublicCampaignPresentationReader(
      adapter,
    );
    this.#publicCampaignStateReader = new StoragePublicCampaignStateReader(
      adapter,
    );
    Object.freeze(this);
  }

  browserMutationReplayClaimer(): BrowserMutationReplayClaimer {
    return this.#claimBrowserMutationReplay;
  }

  campaignRepository(): AtomicCampaignAuditRepository {
    return this.#campaignRepository;
  }

  publicCampaignReader(): PublicCampaignPresentationReader {
    return this.#publicCampaignReader;
  }

  publicCampaignStateReader(): PublicCampaignStateReader {
    return this.#publicCampaignStateReader;
  }

  ownerPackageWorkspace(): RepositoryOwnerPackageWorkspaceService {
    return this.#ownerPackageWorkspace;
  }

  ownerAuditEvents(): AuditEventReader {
    return this.#ownerAuditEvents;
  }

  ownerIndicationReviews(
    authenticatedSubject: ActorSubject | null,
    configuredOwnerSubject: ActorSubject,
    tokens: OwnerIndicationReviewTokenBoundary,
  ): StorageOwnerIndicationReviewCollectionRepository {
    return new StorageOwnerIndicationReviewCollectionRepository(
      this.#storage,
      authenticatedSubject,
      configuredOwnerSubject,
      tokens,
    );
  }

  ownerIndicationModeration(
    authenticatedSubject: ActorSubject | null,
    configuredOwnerSubject: ActorSubject,
    amountConfiguration: AmountConfiguration,
    tokens: OwnerIndicationReviewTokenBoundary,
    parsingOptions: InvestmentIndicationParsingOptions = {},
  ): AtomicOwnerIndicationModerationRepository {
    return new StorageOwnerIndicationModerationRepository(
      this.#storage,
      authenticatedSubject,
      configuredOwnerSubject,
      amountConfiguration,
      tokens,
      parsingOptions,
    );
  }

  ownerFounderApplicationReviews(): FounderApplicationReviewCollectionRepository {
    return this.#ownerFounderApplicationReviews;
  }

  ownerManualNotificationActivity(): AtomicManualNotificationActivityRepository {
    return this.#ownerManualNotificationActivity;
  }

  ownerAggregateReconciliation(
    ownerSubject: ActorSubject,
    campaign: CampaignSetupRevision,
  ): CampaignRevisionBoundAggregateCorrectionRepository {
    return new OwnerBoundInvestmentAggregateCorrectionRepository(
      this.#storage,
      ownerSubject,
      campaign.setup.amountAggregate.amount.currency,
      campaignSetupRevisionCheck(campaign.revision),
    );
  }

  participantRequest(
    account: ParticipantAccount,
  ): ParticipantRequestRepositoryScope {
    return this.#participantRequest(account);
  }

  participantInvestmentRepository(
    participantSubject: ActorSubject,
    amountConfiguration: AmountConfiguration,
    parsingOptions: InvestmentIndicationParsingOptions = {},
  ): StorageParticipantInvestmentInterestRepository {
    return new StorageParticipantInvestmentInterestRepository(
      this.#storage,
      participantSubject,
      amountConfiguration,
      parsingOptions,
    );
  }

  participantRepository(
    account: ParticipantAccount,
  ): ParticipantRegistrationRepository {
    return this.#participantRepositoryFor(account);
  }
}

type ParticipantRequestReadBudget = {
  remainingReads: number;
  remainingRouteReads: number;
  routeReadLimit: number | null;
  routeReadsUsed: number;
};

function createParticipantRequestRepositoryScope(
  storage: StorageAdapter,
  input: ParticipantAccount,
): ParticipantRequestRepositoryScope {
  const account = requiredParticipantAccount(input);
  const budget: ParticipantRequestReadBudget = {
    remainingReads: PARTICIPANT_REQUEST_STORAGE_READ_LIMIT,
    remainingRouteReads: 0,
    routeReadLimit: null,
    routeReadsUsed: 0,
  };
  const readStorage = participantRequestStorage(storage, budget, false);
  const mutationStorage = participantRequestStorage(storage, budget, true);
  const participant = new StorageParticipantRepository(readStorage, account);
  const campaign = new StorageCampaignRepository(readStorage);
  const participantProfile = new StorageParticipantRepository(
    mutationStorage,
    account,
  );
  const packages = StoragePackageVersionRepository.requestScopedReader(
    readStorage,
  );
  const readAcknowledgments = new StorageAcknowledgmentRepository(
    readStorage,
    packages,
    account.subject,
  );
  const mutationAcknowledgments = new StorageAcknowledgmentRepository(
    mutationStorage,
    packages,
    account.subject,
  );
  const packageReader = Object.freeze({
    current: () => packages.current(),
  });
  const packageAcknowledgments = Object.freeze({
    packages: packageReader,
    acknowledgments: Object.freeze({
      get: (id: Parameters<AcknowledgmentRepository["get"]>[0]) =>
        readAcknowledgments.get(id),
      latest: () => readAcknowledgments.latest(),
      record: (request: Parameters<AcknowledgmentRepository["record"]>[0]) =>
        mutationAcknowledgments.record(request),
    }),
  });
  const accessReader = createRepositoryParticipantAccessStateReader(
    (candidate) => {
      const requestedAccount = requiredParticipantAccount(candidate);
      if (
        requestedAccount.subject !== account.subject ||
        requestedAccount.accountEmailLabel !== account.accountEmailLabel
      ) {
        unavailable();
      }
      return Object.freeze({
        participant: Object.freeze({
          current: () => participant.current(),
        }),
        packages: packageReader,
        acknowledgments: Object.freeze({
          currentAcceptanceStatus: () =>
            readAcknowledgments.currentAcceptanceStatus(),
        }),
      });
    },
  );
  const requireSubject = (value: ActorSubject): void => {
    if (requiredActorSubject(value) !== account.subject) unavailable();
  };
  const beginRouteReads = (limit: number): void => {
    if (budget.routeReadLimit === null || budget.routeReadsUsed === 0) {
      budget.routeReadLimit = limit;
      budget.remainingRouteReads = limit;
      return;
    }
    if (budget.routeReadLimit !== limit) unavailable();
  };
  return Object.freeze({
    participantAccessReader: () => accessReader,
    participantProfileRepository: () => {
      beginRouteReads(MAX_PROFILE_ROUTE_STORAGE_READS);
      return participantProfile;
    },
    participantPackageReader: (participantSubject: ActorSubject) => {
      requireSubject(participantSubject);
      beginRouteReads(MAX_PACKAGE_ROUTE_STORAGE_READS);
      return packageReader;
    },
    participantPackageAcknowledgments: (
      participantSubject: ActorSubject,
    ) => {
      requireSubject(participantSubject);
      beginRouteReads(MAX_ACKNOWLEDGMENT_ROUTE_STORAGE_READS);
      return packageAcknowledgments;
    },
    participantFounderApplications: () => {
      beginRouteReads(PARTICIPANT_FOUNDER_ROUTE_STORAGE_READ_LIMIT);
      const applications = (
        contributionAreaChoices: readonly ContributionAreaChoice[],
        campaignSetupRevision?: number,
        participantProfileRevision?: number,
      ): FounderApplicationRepository =>
        new StorageFounderApplicationRepository(
          mutationStorage,
          account.subject,
          contributionAreaChoices,
          {
            policyRevisionCheck: campaignSetupRevisionCheck,
            verifyPolicyRevisionCheck: verifyCampaignSetupRevisionCheckRecord,
            participantProfileRevisionCheck: (revision) =>
              participantProfileRevisionCheck(account.subject, revision),
            verifyParticipantProfileRevisionCheck: (record, revision) =>
              verifyParticipantProfileRevisionCheckRecord(
                record,
                account.subject,
                revision,
              ),
            ...(campaignSetupRevision === undefined
              ? {}
              : { writePolicyRevision: campaignSetupRevision }),
            ...(participantProfileRevision === undefined
              ? {}
              : { writeParticipantProfileRevision: participantProfileRevision }),
          },
        );
      return Object.freeze({
        campaign: Object.freeze({
          readSetup: () => campaign.readSetup(),
        }),
        participant: Object.freeze({
          current: () => participant.current(),
        }),
        applications: (
          contributionAreaChoices: readonly ContributionAreaChoice[],
        ) => applications(contributionAreaChoices),
        policyBoundApplications: (
          contributionAreaChoices: readonly ContributionAreaChoice[],
          campaignSetupRevision: number,
          participantProfileRevision?: number,
        ) =>
          applications(
            contributionAreaChoices,
            campaignSetupRevision,
            participantProfileRevision,
          ),
      });
    },
  });
}

function participantRequestStorage(
  storage: StorageAdapter,
  budget: ParticipantRequestReadBudget,
  mutationAuthority: boolean,
): StorageAdapter {
  return Object.freeze({
    async read(key: StorageKey) {
      if (
        budget.remainingReads <= 0 ||
        (budget.routeReadLimit !== null && budget.remainingRouteReads <= 0)
      ) unavailable();
      budget.remainingReads -= 1;
      if (budget.routeReadLimit !== null) {
        budget.remainingRouteReads -= 1;
        budget.routeReadsUsed += 1;
      }
      return await storage.read(key);
    },
    async list() {
      unavailable();
    },
    async transact(request: Parameters<StorageAdapter["transact"]>[0]) {
      if (!mutationAuthority) unavailable();
      return await storage.transact(request);
    },
  });
}

async function claimReplay(
  storage: StorageAdapter,
  now: () => Date,
  claim: BrowserMutationReplayClaim,
): Promise<boolean> {
  const prepared = replayRecord(claim, now);
  let result: Awaited<ReturnType<StorageAdapter["transact"]>>;
  try {
    result = await storage.transact({
      operationId: prepared.operationId,
      mutations: [{
        type: "put",
        key: prepared.key,
        expectedRevision: null,
        value: prepared.value,
      }],
    });
  } catch (error) {
    if (
      error instanceof StorageFailure &&
      (error.code === "CONFLICT" || error.code === "PRECONDITION_FAILED")
    ) {
      return false;
    }
    if (error instanceof StorageFailure) throw new StorageFailure(error.code);
    unavailable();
  }

  const claimed = replayClaimed(result, prepared.key, prepared.value);
  if (claimed === null) unavailable();
  return claimed;
}

function replayRecord(
  claim: BrowserMutationReplayClaim,
  now: () => Date,
): Readonly<{
  operationId: ReturnType<typeof requiredOperationId>;
  key: StorageKey;
  value: StorageDocument;
}> {
  const source = exactDataObject(claim, ["capabilityId", "expiresAt"]);
  if (
    source === null ||
    typeof source.capabilityId !== "string" ||
    !REPLAY_CAPABILITY_PATTERN.test(source.capabilityId)
  ) {
    invalidRequest();
  }
  const expiresAt = parseTimestamp(source.expiresAt);
  if (!expiresAt.ok) invalidRequest();
  const current = currentTime(now);
  const expiry = new Date(expiresAt.value).valueOf();
  if (
    !Number.isSafeInteger(expiry) ||
    expiry <= current ||
    expiry > current + MAX_REPLAY_TTL_SECONDS * 1_000
  ) {
    invalidRequest();
  }
  const operationId = requiredOperationId(source.capabilityId);
  const key = requiredStorageKey(REPLAY_COLLECTION, source.capabilityId);
  const value = Object.freeze({
    schemaVersion: REPLAY_SCHEMA_VERSION,
    expiresAt: expiresAt.value,
  });
  return Object.freeze({ operationId, key, value });
}

function replayClaimed(
  result: unknown,
  key: StorageKey,
  value: StorageDocument,
): boolean | null {
  try {
    const source = exactDataObject(result, ["replayed", "records"]);
    if (source === null) return null;
    const replayed = source.replayed;
    const records = exactSingleElementArray(source.records);
    if (
      typeof replayed !== "boolean" ||
      records === null
    ) {
      return null;
    }
    const record = records[0];
    return validReplayRecord(record, key, value) ? !replayed : null;
  } catch {
    return null;
  }
}

function validReplayRecord(
  value: unknown,
  key: StorageKey,
  expectedValue: StorageDocument,
): value is StorageRecord {
  const record = exactDataObject(value, ["key", "revision", "value"]);
  if (record === null || record.revision !== 1) return false;
  const recordKey = exactDataObject(record.key, ["collection", "id"]);
  const recordValue = exactDataObject(record.value, [
    "schemaVersion",
    "expiresAt",
  ]);
  if (recordKey === null || recordValue === null) return false;
  if (
    recordKey.collection !== key.collection ||
    recordKey.id !== key.id
  ) {
    return false;
  }
  return exactReplayValue(recordValue, expectedValue);
}

function exactReplayValue(
  value: Readonly<Record<string, unknown>>,
  expected: StorageDocument,
): boolean {
  return value.schemaVersion === expected.schemaVersion &&
    value.expiresAt === expected.expiresAt;
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
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) =>
        typeof key !== "string" || !expectedKeys.includes(key)
      )
    ) {
      return null;
    }
    const result: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
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

function exactSingleElementArray(
  value: unknown,
): readonly [unknown] | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("0") ||
    !keys.includes("length")
  ) {
    return null;
  }
  const element = Object.getOwnPropertyDescriptor(value, "0");
  if (
    element === undefined ||
    !element.enumerable ||
    !("value" in element)
  ) {
    return null;
  }
  return Object.freeze([element.value]);
}

function requiredStorageAdapter(value: StorageAdapter): StorageAdapter {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof value.read !== "function" ||
      typeof value.list !== "function" ||
      typeof value.transact !== "function"
    ) {
      invalidRequest();
    }
    return value;
  } catch {
    invalidRequest();
  }
}

function requiredClock(value: () => Date): () => Date {
  if (typeof value !== "function") invalidRequest();
  return value;
}

function requiredActorSubject(value: unknown): ActorSubject {
  const parsed = parseActorSubject(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function requiredParticipantAccount(value: unknown): ParticipantAccount {
  const parsed = parseParticipantAccount(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function currentTime(now: () => Date): number {
  let value: Date;
  try {
    value = now();
  } catch {
    unavailable();
  }
  const milliseconds = value instanceof Date ? value.valueOf() : Number.NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) unavailable();
  return milliseconds;
}

function requiredOperationId(value: string) {
  const parsed = parseStorageOperationId(value);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function requiredStorageKey(
  collection: StorageCollection,
  id: string,
): StorageKey {
  const parsed = parseStorageKey(collection, id);
  if (!parsed.ok) invalidRequest();
  return parsed.value;
}

function storageCollection(value: string): StorageCollection {
  const parsed = parseStorageCollection(value);
  if (!parsed.ok) throw new Error("Invalid application repository collection.");
  return parsed.value;
}

function invalidRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
}

function unavailable(): never {
  throw new StorageFailure("UNAVAILABLE");
}
