import type { AmountConfiguration } from "../domain/amount-aggregate-configuration.ts";
import type { ActorSubject } from "../domain/foundation.ts";
import type { InvestmentIndicationParsingOptions } from "../domain/investment-indication.ts";
import type { StorageAdapter } from "../domain/storage-adapter.ts";
import type {
  AtomicOwnerIndicationModerationRepository,
  OwnerIndicationModerationListRequest,
  RejectIndicationWithEffectsRequest,
} from "../services/owner-indication-moderation.ts";
import type { OwnerIndicationReviewTokenBoundary } from "../services/owner-indication-review-tokens.ts";
import { StorageOwnerIndicationReviewCollectionRepository } from "./storage-owner-indication-review-collection-repository.ts";
import { StorageOwnerIndicationRejectionRepository } from "./storage-owner-indication-rejection-repository.ts";
import { StorageOwnerIndicationReviewDetailRepository } from "./storage-owner-indication-review-detail-repository.ts";

/** Closed route capability assembled from the independently tested read/write lanes. */
export class StorageOwnerIndicationModerationRepository
  implements AtomicOwnerIndicationModerationRepository {
  readonly moderationConsistency =
    "atomic-indication-aggregate-audit-notification" as const;

  readonly #collection: StorageOwnerIndicationReviewCollectionRepository;
  readonly #detail: StorageOwnerIndicationReviewDetailRepository;
  readonly #rejection: StorageOwnerIndicationRejectionRepository;

  constructor(
    storage: StorageAdapter,
    authenticatedSubject: ActorSubject | null,
    configuredOwnerSubject: ActorSubject,
    amountConfiguration: AmountConfiguration,
    tokens: OwnerIndicationReviewTokenBoundary,
    parsingOptions: InvestmentIndicationParsingOptions = {},
  ) {
    this.#collection = new StorageOwnerIndicationReviewCollectionRepository(
      storage,
      authenticatedSubject,
      configuredOwnerSubject,
      tokens,
    );
    this.#detail = new StorageOwnerIndicationReviewDetailRepository(
      storage,
      authenticatedSubject,
      configuredOwnerSubject,
      amountConfiguration,
      tokens,
    );
    this.#rejection = new StorageOwnerIndicationRejectionRepository(
      storage,
      authenticatedSubject,
      configuredOwnerSubject,
      amountConfiguration,
      tokens,
      parsingOptions,
    );
    Object.freeze(this);
  }

  list(request: OwnerIndicationModerationListRequest) {
    return this.#collection.list(request);
  }

  get(reviewId: unknown) {
    return this.#detail.get(reviewId);
  }

  rejectWithEffects(request: RejectIndicationWithEffectsRequest) {
    return this.#rejection.rejectWithEffects(request);
  }
}
