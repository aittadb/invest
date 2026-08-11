import type { SanitizedPublicInvestmentAggregate } from "../domain/investment-aggregate.ts";
import {
  StorageFailure,
  type StorageAdapter,
} from "../domain/storage-adapter.ts";
import type { PublicCampaignConfiguration } from "../domain/public-campaign-configuration.ts";
import { DevelopmentInMemoryAggregateRepository } from "./in-memory-aggregate-repository.ts";
import { StoragePublicCampaignPresentationReader } from "./in-memory-campaign-repository.ts";

const MAX_PUBLIC_STATE_ATTEMPTS = 2;

export type PublishedPublicCampaignState = Readonly<{
  campaign: PublicCampaignConfiguration;
  aggregate: SanitizedPublicInvestmentAggregate | null;
}>;

/** Public-only campaign state; private aggregate facts never cross this port. */
export interface PublicCampaignStateReader {
  readPublishedState(): Promise<PublishedPublicCampaignState | null>;
}

export class StoragePublicCampaignStateReader
  implements PublicCampaignStateReader {
  readonly #storage: StorageAdapter;
  readonly #presentation: StoragePublicCampaignPresentationReader;

  constructor(storage: StorageAdapter) {
    this.#storage = storage;
    this.#presentation = new StoragePublicCampaignPresentationReader(storage);
  }

  async readPublishedState(): Promise<PublishedPublicCampaignState | null> {
    for (let attempt = 0; attempt < MAX_PUBLIC_STATE_ATTEMPTS; attempt += 1) {
      const before = await this.#presentation.readPublishedProjection();
      if (before === null) return null;

      let aggregate: SanitizedPublicInvestmentAggregate | null = null;
      if (
        before.amountAggregate !== null &&
        before.amountAggregate.publicAggregate.visibility !== "hidden"
      ) {
        try {
          aggregate = await new DevelopmentInMemoryAggregateRepository(
            this.#storage,
            before.amountAggregate.amount.currency,
          ).readPublicAggregate(before.amountAggregate, null);
        } catch {
          aggregate = null;
        }
      }

      const after = await this.#presentation.readPublishedProjection();
      if (after?.revision !== before.revision) continue;

      return Object.freeze({
        campaign: before.publicCampaign,
        aggregate,
      });
    }
    throw new StorageFailure("UNAVAILABLE");
  }
}
