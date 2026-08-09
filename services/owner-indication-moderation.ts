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
  cursor?: StorageCursor;
}>;

export type OwnerIndicationModerationPage = Readonly<{
  items: readonly OwnerIndicationModerationItem[];
  nextCursor: StorageCursor | null;
}>;

export type RejectIndicationWithEffectsRequest = Readonly<{
  reviewId: string;
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
 * Strong owner-moderation port. An implementation may advertise reject only
 * when all four effects share one atomic, idempotent commit boundary.
 */
export interface AtomicOwnerIndicationModerationRepository {
  readonly moderationConsistency:
    "atomic-indication-aggregate-audit-notification";
  list(
    request: OwnerIndicationModerationListRequest,
  ): Promise<OwnerIndicationModerationPage>;
  get(reviewId: unknown): Promise<OwnerIndicationModerationItem | null>;
  rejectWithEffects(
    request: RejectIndicationWithEffectsRequest,
  ): Promise<RejectIndicationWithEffectsResult>;
}
