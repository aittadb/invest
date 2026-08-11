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
  type InvestmentAggregateCorrectionConfirmation,
  type InvestmentAggregateCorrectionTerminalReplay,
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

export const OWNER_AGGREGATE_CORRECTION_REPLAY_ACTION =
  "retry-recorded-aggregate-correction" as const;

export function ownerAggregateCorrectionAvailable(
  preview: InvestmentAggregateReconciliationPreview,
  consistency: AggregateCorrectionConsistency,
  campaignRevision: number | null,
): boolean {
  return preview.correctionRequired &&
    preview.stored.revision < Number.MAX_SAFE_INTEGER &&
    campaignRevision !== null &&
    consistency === "atomic-aggregate-audit";
}

export function createOwnerAggregateReconciliationResource(
  requestUrl: string,
  preview: InvestmentAggregateReconciliationPreview,
  consistency: AggregateCorrectionConsistency,
  campaignRevision: number | null,
  operationId: string | null,
  terminalReplay: InvestmentAggregateCorrectionTerminalReplay | null = null,
): OwnerAggregateReconciliationResource {
  const correction = actionWhenAllowed(
    ownerAggregateCorrectionAvailable(preview, consistency, campaignRevision),
    () => defineAction({
      name: "apply-calculated-aggregate",
      title: "Apply calculated totals",
      method: "POST",
      href: new URL("/owner/aggregate-reconciliation", requestUrl).href,
      requestMediaType: "application/x-www-form-urlencoded",
      fields: correctionActionFields(
        requiredActionOperationId(operationId),
        requiredActionCampaignRevision(campaignRevision),
        confirmationFromPreview(preview),
      ),
    }),
  );
  const retry = actionWhenAllowed(
    terminalReplayMatchesPreview(terminalReplay, preview),
    () => defineAction({
      name: OWNER_AGGREGATE_CORRECTION_REPLAY_ACTION,
      title: "Retry recorded correction",
      method: "POST",
      href: new URL("/owner/aggregate-reconciliation", requestUrl).href,
      requestMediaType: "application/x-www-form-urlencoded",
      fields: correctionActionFields(
        requiredTerminalReplay(terminalReplay).operationId,
        requiredTerminalReplay(terminalReplay).expectedCampaignRevision,
        requiredTerminalReplay(terminalReplay).confirmation,
      ),
    }),
  );
  const actions = currentActions(correction, retry);
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
    correctionForm: correction === null
      ? retry === null ? null : toHtmlFormAction(retry)
      : toHtmlFormAction(correction),
  });
}

function correctionActionFields(
  operationId: string,
  campaignRevision: number,
  confirmation: InvestmentAggregateCorrectionConfirmation,
) {
  return [
    textField("operation-id", "Operation ID", operationId),
    integerField(
      "expected-campaign-revision",
      "Expected campaign revision",
      campaignRevision,
    ),
    {
      name: "confirmation",
      title: "Confirmation",
      type: "choice" as const,
      location: "body" as const,
      required: true,
      presentation: "control" as const,
      choices: [{
        value: APPLY_CALCULATED_AGGREGATE_CONFIRMATION,
        title: "Apply the calculated totals shown above",
      }],
      value: confirmation.confirmation,
    },
    integerField(
      "expected-stored-revision",
      "Expected stored revision",
      confirmation.expectedStoredRevision,
    ),
    integerField(
      "expected-stored-amount",
      "Expected stored amount",
      confirmation.expectedStoredAmount,
    ),
    integerField(
      "expected-stored-count",
      "Expected stored indication count",
      confirmation.expectedStoredContributingIndicationCount,
    ),
    integerField(
      "expected-calculated-amount",
      "Expected calculated amount",
      confirmation.expectedCalculatedAmount,
    ),
    integerField(
      "expected-calculated-count",
      "Expected calculated indication count",
      confirmation.expectedCalculatedContributingIndicationCount,
    ),
  ];
}

function confirmationFromPreview(
  preview: InvestmentAggregateReconciliationPreview,
): InvestmentAggregateCorrectionConfirmation {
  return {
    confirmation: APPLY_CALCULATED_AGGREGATE_CONFIRMATION,
    expectedStoredRevision: preview.stored.revision,
    expectedStoredAmount: preview.stored.totalAmount,
    expectedStoredContributingIndicationCount:
      preview.stored.contributingIndicationCount,
    expectedCalculatedAmount: preview.calculated.totalAmount,
    expectedCalculatedContributingIndicationCount:
      preview.calculated.contributingIndicationCount,
  };
}

function textField(name: string, title: string, value: string) {
  return {
    name,
    title,
    type: "string" as const,
    format: "text" as const,
    location: "body" as const,
    required: true,
    presentation: "hidden" as const,
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
    presentation: "hidden" as const,
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

function requiredActionOperationId(value: string | null): string {
  if (value === null) throw new TypeError("Operation ID unavailable.");
  return value;
}

function requiredTerminalReplay(
  value: InvestmentAggregateCorrectionTerminalReplay | null,
): InvestmentAggregateCorrectionTerminalReplay {
  if (value === null) throw new TypeError("Terminal replay unavailable.");
  return value;
}

function terminalReplayMatchesPreview(
  replay: InvestmentAggregateCorrectionTerminalReplay | null,
  preview: InvestmentAggregateReconciliationPreview,
): boolean {
  if (replay === null || preview.status !== "match" || preview.correctionRequired) {
    return false;
  }
  const confirmation = replay.confirmation;
  return typeof replay.operationId === "string" &&
    replay.operationId.length > 0 &&
    replay.operationId.length <= 128 &&
    Number.isSafeInteger(replay.expectedCampaignRevision) &&
    replay.expectedCampaignRevision >= 1 &&
    confirmation.confirmation === APPLY_CALCULATED_AGGREGATE_CONFIRMATION &&
    Number.isSafeInteger(confirmation.expectedStoredRevision) &&
    confirmation.expectedStoredRevision >= 0 &&
    confirmation.expectedStoredRevision < Number.MAX_SAFE_INTEGER &&
    confirmation.expectedStoredRevision + 1 === preview.stored.revision &&
    confirmation.expectedCalculatedAmount === preview.stored.totalAmount &&
    confirmation.expectedCalculatedContributingIndicationCount ===
      preview.stored.contributingIndicationCount;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
