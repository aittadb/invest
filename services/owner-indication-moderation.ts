import type {
  AuditEvent,
  ManualNotificationRecord,
} from "../domain/audit-notification.ts";
import type { ActorSubject, Timestamp } from "../domain/foundation.ts";
import type {
  InvestmentAggregateContribution,
  StoredInvestmentAggregateSnapshot,
} from "../domain/investment-aggregate.ts";
import type {
  InvestmentIndication,
  InvestmentIndicationId,
  RejectedInvestmentIndication,
} from "../domain/investment-indication.ts";
import type {
  StorageCursor,
  StorageOperationId,
} from "../domain/storage-adapter.ts";

export type OwnerIndicationNotificationSnapshot = Readonly<{
  revision: number;
  record: ManualNotificationRecord;
}>;

export type OwnerIndicationModerationItem = Readonly<{
  reviewId: string;
  indication: InvestmentIndication;
  notification: OwnerIndicationNotificationSnapshot | null;
}>;

export type OwnerIndicationModerationListRequest = Readonly<{
  limit: number;
  /** Untrusted application cursor; storage continuation values stay private. */
  cursor?: StorageCursor;
}>;

export type OwnerIndicationReviewSummary = Readonly<{
  /** Owner-bound opaque identifier that resolves one current record key. */
  reviewId: string;
  kind: InvestmentIndication["kind"];
  status: InvestmentIndication["lifecycle"]["status"];
  amount: number;
  currency: string;
  updatedAt: Timestamp;
  revision: number;
}>;

export type OwnerIndicationReviewPage = Readonly<{
  items: readonly OwnerIndicationReviewSummary[];
  nextCursor: StorageCursor | null;
}>;

/**
 * Owner-bound, read-only collection contract over current indications.
 * Implementations issue application-owned cursors and never return backend
 * continuation values unchanged.
 */
export interface OwnerIndicationReviewCollectionRepository {
  list(
    request: OwnerIndicationModerationListRequest,
  ): Promise<OwnerIndicationReviewPage>;
}

export type OwnerIndicationModerationPage = Readonly<{
  items: readonly OwnerIndicationModerationItem[];
  nextCursor: StorageCursor | null;
}>;

/** Owner-bound read contract for one opaque indication review resource. */
export interface OwnerIndicationReviewDetailRepository {
  get(reviewId: unknown): Promise<OwnerIndicationModerationItem | null>;
}

export type RejectIndicationWithEffectsRequest = Readonly<{
  reviewId: string;
  indicationId: InvestmentIndicationId;
  operationId: StorageOperationId;
  expectedRevision: number;
  reason: string;
  ownerSubject: ActorSubject;
  occurredAt: Timestamp;
}>;

export type RejectIndicationWithEffectsResult = Readonly<{
  item: OwnerIndicationModerationItem &
    Readonly<{ indication: RejectedInvestmentIndication }>;
  aggregate: Readonly<{
    contribution: InvestmentAggregateContribution;
    stored: StoredInvestmentAggregateSnapshot;
  }>;
  auditEvent: AuditEvent;
  notification: OwnerIndicationNotificationSnapshot;
  replayed: boolean;
}>;

/**
 * Strong owner rejection port. An implementation may advertise reject only
 * when all four effects share one atomic, idempotent commit boundary.
 */
export interface AtomicOwnerIndicationRejectionRepository {
  readonly moderationConsistency:
    "atomic-indication-aggregate-audit-notification";
  rejectWithEffects(
    request: RejectIndicationWithEffectsRequest,
  ): Promise<RejectIndicationWithEffectsResult>;
}

/** Combined route contract assembled from independent read and write lanes. */
export interface AtomicOwnerIndicationModerationRepository
  extends AtomicOwnerIndicationRejectionRepository {
  list(
    request: OwnerIndicationModerationListRequest,
  ): Promise<OwnerIndicationModerationPage>;
  get(reviewId: unknown): Promise<OwnerIndicationModerationItem | null>;
}
