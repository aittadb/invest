import type { PublicOversubscriptionDisplayData } from "@/domain/investment-aggregate";

export type CampaignPreview = Readonly<{
  sourceRevision: number;
  sourcePublication: string;
}>;

export type PublicAggregate = Readonly<{
  amount: number;
  currency: string;
  label: string;
  qualifier: string;
  oversubscription: PublicOversubscriptionDisplayData | null;
}>;
