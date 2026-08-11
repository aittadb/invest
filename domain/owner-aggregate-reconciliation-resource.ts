import {
  actionWhenAllowed,
  currentActions,
  defineAction,
  toHtmlFormAction,
  toHypermediaAction,
  type HtmlFormAction,
} from "./hypermedia-action.ts";
import {
  APPLY_CALCULATED_AGGREGATE_CONFIRMATION,
  type InvestmentAggregateReconciliationPreview,
} from "./investment-aggregate.ts";
import {
  INVESTOR_APP_API_VERSION,
  type HypermediaAction,
  type HypermediaLink,
} from "./public-campaign-resource.ts";

export type AggregateCorrectionConsistency =
  | "atomic-aggregate-audit"
  | "unavailable";

export type OwnerAggregateReconciliationDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "owner-aggregate-reconciliation";
  id: "investment-interest-aggregate";
  data: Readonly<{
    campaign_revision: number | null;
    status: InvestmentAggregateReconciliationPreview["status"];
    correction_required: boolean;
    correction_consistency: AggregateCorrectionConsistency;
    correction_available: boolean;
    stored: Readonly<{
      revision: number;
      amount: number;
      currency: string;
      contributing_indication_count: number;
    }>;
    calculated: Readonly<{
      amount: number;
      currency: string;
      contributing_indication_count: number;
    }>;
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type OwnerAggregateReconciliationResource = Readonly<{
  document: OwnerAggregateReconciliationDocument;
  correctionForm: HtmlFormAction | null;
}>;

export function createOwnerAggregateReconciliationResource(
  requestUrl: string,
  preview: InvestmentAggregateReconciliationPreview,
  consistency: AggregateCorrectionConsistency,
  campaignRevision: number | null,
  operationId: string,
): OwnerAggregateReconciliationResource {
  const correction = actionWhenAllowed(
    preview.correctionRequired &&
      preview.stored.revision < Number.MAX_SAFE_INTEGER &&
      campaignRevision !== null &&
      consistency === "atomic-aggregate-audit",
    () => defineAction({
      name: "apply-calculated-aggregate",
      title: "Apply calculated totals",
      method: "POST",
      href: new URL("/owner/aggregate-reconciliation", requestUrl).href,
      requestMediaType: "application/x-www-form-urlencoded",
      fields: [
        textField("operation-id", "Operation ID", operationId),
        integerField(
          "expected-campaign-revision",
          "Expected campaign revision",
          requiredActionCampaignRevision(campaignRevision),
        ),
        {
          name: "confirmation",
          title: "Confirmation",
          type: "choice",
          location: "body",
          required: true,
          choices: [{
            value: APPLY_CALCULATED_AGGREGATE_CONFIRMATION,
            title: "Apply the calculated totals shown above",
          }],
          value: APPLY_CALCULATED_AGGREGATE_CONFIRMATION,
        },
        integerField(
          "expected-stored-revision",
          "Expected stored revision",
          preview.stored.revision,
        ),
        integerField(
          "expected-stored-amount",
          "Expected stored amount",
          preview.stored.totalAmount,
        ),
        integerField(
          "expected-stored-count",
          "Expected stored indication count",
          preview.stored.contributingIndicationCount,
        ),
        integerField(
          "expected-calculated-amount",
          "Expected calculated amount",
          preview.calculated.totalAmount,
        ),
        integerField(
          "expected-calculated-count",
          "Expected calculated indication count",
          preview.calculated.contributingIndicationCount,
        ),
      ],
    }),
  );
  const actions = currentActions(correction);
  const self = new URL(requestUrl);

  return deepFreeze({
    document: {
      api_version: INVESTOR_APP_API_VERSION,
      type: "owner-aggregate-reconciliation",
      id: "investment-interest-aggregate",
      data: {
        campaign_revision: campaignRevision,
        status: preview.status,
        correction_required: preview.correctionRequired,
        correction_consistency: consistency,
        correction_available: correction !== null,
        stored: {
          revision: preview.stored.revision,
          amount: preview.stored.totalAmount,
          currency: preview.stored.currency,
          contributing_indication_count:
            preview.stored.contributingIndicationCount,
        },
        calculated: {
          amount: preview.calculated.totalAmount,
          currency: preview.calculated.currency,
          contributing_indication_count:
            preview.calculated.contributingIndicationCount,
        },
      },
      links: [
        { rel: ["self"], href: self.href },
        { rel: ["owner"], href: new URL("/owner", self).href },
      ],
      actions: actions.map(toHypermediaAction),
    },
    correctionForm: correction === null ? null : toHtmlFormAction(correction),
  });
}

function textField(name: string, title: string, value: string) {
  return {
    name,
    title,
    type: "string" as const,
    format: "text" as const,
    location: "body" as const,
    required: true,
    minLength: 1,
    maxLength: 128,
    maxBytes: 128,
    value,
  };
}

function integerField(name: string, title: string, value: number) {
  return {
    name,
    title,
    type: "integer" as const,
    location: "body" as const,
    required: true,
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    step: 1,
    value,
  };
}

function requiredActionCampaignRevision(value: number | null): number {
  if (value === null) throw new TypeError("Campaign revision unavailable.");
  return value;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
