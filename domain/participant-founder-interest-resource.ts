import type {
  ContributionAreaChoice,
  FounderApplication,
  FounderApplicationFields,
  FounderApplicationHistoryEntry,
} from "./founder-application.ts";
import {
  MAX_CANONICAL_PROFILE_LINK_BYTES,
  MAX_CANONICAL_PROFILE_LINK_LENGTH,
  MAX_PROFILE_LINKS,
  canEditFounderApplication,
  canWithdrawFounderApplication,
} from "./founder-application.ts";
import {
  actionWhenAllowed,
  currentActions,
  defineAction,
  toHtmlFormAction,
  toHypermediaAction,
  type ActionContract,
  type ActionField,
  type HtmlFormAction,
  type HypermediaAction,
} from "./hypermedia-action.ts";
import {
  INVESTOR_APP_API_VERSION,
  type HypermediaLink,
} from "./public-campaign-resource.ts";
import { MAX_STABLE_ID_LENGTH } from "./foundation.ts";

export const FOUNDER_INTEREST_PATH = "/participant/founder-interest";
export const FOUNDER_WITHDRAWAL_REPLAY_ACTION =
  "retry-founder-application-withdrawal";
export const FOUNDER_SECONDARY_AREAS_FIELD =
  "secondary-contribution-area-ids";
export const MAX_PROFILE_LINK_FORM_LENGTH =
  MAX_PROFILE_LINKS * MAX_CANONICAL_PROFILE_LINK_LENGTH +
  (MAX_PROFILE_LINKS - 1);
export const MAX_PROFILE_LINK_FORM_BYTES =
  MAX_PROFILE_LINKS * MAX_CANONICAL_PROFILE_LINK_BYTES +
  (MAX_PROFILE_LINKS - 1);

export type FounderInterestFieldsData = Readonly<{
  expertise_summary: string;
  intended_contribution: string;
  primary_contribution_area_id: string;
  secondary_contribution_area_ids: readonly string[];
  approximate_availability: string;
  possible_start_timing: string;
  compensation_expectation: string;
  professional_profile_links: readonly string[];
  note: string | null;
}>;

export type FounderInterestHistoryData = Readonly<{
  revision: number;
  kind: FounderApplicationHistoryEntry["kind"];
  status: FounderApplicationHistoryEntry["status"];
  occurred_at: string;
  fields: FounderInterestFieldsData;
}>;

export type FounderInterestDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "participant-founder-interest";
  id: "founder-interest";
  data: Readonly<{
    status: "not_submitted" | FounderApplication["status"];
    revision: number | null;
    created_at: string | null;
    updated_at: string | null;
    withdrawn_at: string | null;
    fields: FounderInterestFieldsData | null;
    history: readonly FounderInterestHistoryData[];
    interest_is_binding: false;
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type FounderInterestCapabilityModel = Readonly<{
  document: FounderInterestDocument;
  actionContracts: readonly ActionContract[];
  forms: readonly HtmlFormAction[];
}>;

export type FounderTerminalWithdrawalReplay = Readonly<{
  operationId: string;
  expectedRevision: number;
}>;

export type FounderInterestResourceInput = Readonly<{
  requestUrl: string;
  application: FounderApplication | null;
  contributionAreaChoices: readonly ContributionAreaChoice[];
  canCreate: boolean;
  operationIds: Readonly<{
    create: string;
    edit: string;
    withdraw: string;
  }>;
}>;

/** Project one authorized state into both hypermedia actions and HTML forms. */
export function createFounderInterestCapabilityModel(
  input: FounderInterestResourceInput,
): FounderInterestCapabilityModel {
  const self = new URL(FOUNDER_INTEREST_PATH, input.requestUrl).href;
  const application = input.application;
  const terminalWithdrawalReplay = founderTerminalWithdrawalReplay(application);
  const actions = currentActions(
    actionWhenAllowed(
      application === null &&
        input.contributionAreaChoices.length > 0 &&
        input.canCreate,
      () =>
        founderFieldsAction(
          "create-founder-application",
          "Submit founder application",
          "POST",
          self,
          input.operationIds.create,
          input.contributionAreaChoices,
          null,
        ),
    ),
    actionWhenAllowed(
      application !== null &&
        input.contributionAreaChoices.length > 0 &&
        canEditFounderApplication(application),
      () =>
        founderFieldsAction(
          "edit-founder-application",
          "Save application",
          "PATCH",
          self,
          input.operationIds.edit,
          input.contributionAreaChoices,
          application?.status === "received" ? application : null,
        ),
    ),
    actionWhenAllowed(
      application !== null && canWithdrawFounderApplication(application),
      () =>
        defineAction({
          name: "withdraw-founder-application",
          title: "Withdraw application",
          method: "DELETE",
          href: self,
          requestMediaType: "application/x-www-form-urlencoded",
          fields: [
            operationIdField(input.operationIds.withdraw),
            expectedRevisionField(application?.revision ?? 1),
            {
              name: "confirm-withdrawal",
              title: "I want to withdraw this application",
              type: "boolean",
              location: "body",
              required: true,
            },
          ],
        }),
    ),
    actionWhenAllowed(terminalWithdrawalReplay !== null, () =>
      defineAction({
        name: FOUNDER_WITHDRAWAL_REPLAY_ACTION,
        title: "Retry recorded withdrawal",
        method: "DELETE",
        href: self,
        requestMediaType: "application/x-www-form-urlencoded",
        fields: [
          operationIdField(terminalWithdrawalReplay?.operationId ?? ""),
          expectedRevisionField(
            terminalWithdrawalReplay?.expectedRevision ?? 1,
          ),
          {
            name: "confirm-withdrawal",
            title: "Confirm the recorded withdrawal",
            type: "boolean",
            location: "body",
            required: true,
          },
        ],
      })),
  );

  const actionContracts = Object.freeze([...actions]);
  const document = Object.freeze({
    api_version: INVESTOR_APP_API_VERSION,
    type: "participant-founder-interest" as const,
    id: "founder-interest" as const,
    data: projectApplication(application),
    links: Object.freeze([
      Object.freeze({ rel: Object.freeze(["self"]), href: self }),
      Object.freeze({
        rel: Object.freeze(["campaign"]),
        href: new URL("/", input.requestUrl).href,
      }),
    ]),
    actions: Object.freeze(actionContracts.map(toHypermediaAction)),
  });

  return Object.freeze({
    document,
    actionContracts,
    forms: Object.freeze(actionContracts.map(toHtmlFormAction)),
  });
}

/** Recover the exact terminal withdrawal command from verified history. */
export function founderTerminalWithdrawalReplay(
  application: FounderApplication | null,
): FounderTerminalWithdrawalReplay | null {
  if (application?.status !== "withdrawn" || application.revision < 2) {
    return null;
  }
  const withdrawal = application.history.at(-1);
  if (
    withdrawal === undefined ||
    withdrawal.kind !== "withdrawn" ||
    withdrawal.status !== "withdrawn" ||
    withdrawal.revision !== application.revision
  ) {
    return null;
  }
  return Object.freeze({
    operationId: withdrawal.id,
    expectedRevision: application.revision - 1,
  });
}

function founderFieldsAction(
  name: "create-founder-application" | "edit-founder-application",
  title: string,
  method: "POST" | "PATCH",
  href: string,
  operationId: string,
  choices: readonly ContributionAreaChoice[],
  application: FounderApplication | null,
): ActionContract {
  return defineAction({
    name,
    title,
    method,
    href,
    requestMediaType: "application/x-www-form-urlencoded",
    fields: [
      operationIdField(operationId),
      ...(application ? [expectedRevisionField(application.revision)] : []),
      ...founderFields(choices, application?.fields ?? null),
    ],
  });
}

function operationIdField(value: string): ActionField {
  return {
    name: "operation-id",
    title: "Operation identifier",
    type: "string",
    format: "text",
    location: "body",
    required: true,
    presentation: "hidden",
    minLength: 1,
    maxLength: MAX_STABLE_ID_LENGTH,
    maxBytes: MAX_STABLE_ID_LENGTH,
    value,
  };
}

function expectedRevisionField(value: number): ActionField {
  return {
    name: "expected-revision",
    title: "Application revision",
    type: "integer",
    location: "body",
    required: true,
    presentation: "hidden",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER - 1,
    value,
  };
}

function founderFields(
  choices: readonly ContributionAreaChoice[],
  current: FounderApplicationFields | null,
): readonly ActionField[] {
  const contributionChoices = choices.map((choice) => ({
    value: choice.id,
    title: choice.label,
  }));
  const configuredIds = new Set(choices.map((choice) => choice.id));
  const currentPrimary = current !== null &&
      configuredIds.has(current.primaryContributionAreaId)
    ? current.primaryContributionAreaId
    : null;
  const currentSecondary = current?.secondaryContributionAreaIds.filter(
    (id) => configuredIds.has(id),
  ) ?? [];
  const currentProfileLinks = current?.professionalProfileLinks.join("\n") ??
    null;

  return [
    requiredMultiline(
      "expertise-summary",
      "Expertise summary",
      4_000,
      current?.expertiseSummary,
    ),
    requiredMultiline(
      "intended-contribution",
      "Intended contribution",
      4_000,
      current?.intendedContribution,
    ),
    {
      name: "primary-contribution-area-id",
      title: "Primary contribution area",
      type: "choice",
      location: "body",
      required: true,
      choices: contributionChoices,
      ...(currentPrimary !== null
        ? { value: currentPrimary }
        : {}),
    },
    {
      name: FOUNDER_SECONDARY_AREAS_FIELD,
      title: "Secondary contribution areas",
      type: "choice",
      location: "body",
      required: false,
      multiple: true,
      choices: contributionChoices,
      ...(currentSecondary.length > 0
        ? { values: currentSecondary }
        : {}),
    },
    requiredText(
      "approximate-availability",
      "Approximate availability",
      500,
      current?.approximateAvailability,
    ),
    requiredText(
      "possible-start-timing",
      "Possible start timing",
      500,
      current?.possibleStartTiming,
    ),
    requiredText(
      "compensation-expectation",
      "Compensation expectation",
      500,
      current?.compensationExpectation,
    ),
    {
      name: "professional-profile-links",
      title: "Professional profile links, one per line",
      type: "string",
      format: "multiline",
      location: "body",
      required: false,
      minLength: 0,
      maxLength: MAX_PROFILE_LINK_FORM_LENGTH,
      maxBytes: MAX_PROFILE_LINK_FORM_BYTES,
      ...(currentProfileLinks !== null
        ? { value: currentProfileLinks }
        : {}),
    },
    {
      name: "note",
      title: "Additional note",
      type: "string",
      format: "multiline",
      location: "body",
      required: false,
      minLength: 0,
      maxLength: 4_000,
      maxBytes: 16_000,
      ...(current ? { value: current.note ?? "" } : {}),
    },
  ];
}

function requiredMultiline(
  name: string,
  title: string,
  maximum: number,
  value: string | undefined,
): ActionField {
  return {
    name,
    title,
    type: "string",
    format: "multiline",
    location: "body",
    required: true,
    minLength: 1,
    maxLength: maximum,
    maxBytes: maximum * 4,
    ...(value === undefined ? {} : { value }),
  };
}

function requiredText(
  name: string,
  title: string,
  maximum: number,
  value: string | undefined,
): ActionField {
  return {
    name,
    title,
    type: "string",
    format: "text",
    location: "body",
    required: true,
    minLength: 1,
    maxLength: maximum,
    maxBytes: maximum * 4,
    ...(value === undefined ? {} : { value }),
  };
}

function projectApplication(
  application: FounderApplication | null,
): FounderInterestDocument["data"] {
  if (application === null) {
    return Object.freeze({
      status: "not_submitted",
      revision: null,
      created_at: null,
      updated_at: null,
      withdrawn_at: null,
      fields: null,
      history: Object.freeze([]),
      interest_is_binding: false,
    });
  }

  return Object.freeze({
    status: application.status,
    revision: application.revision,
    created_at: application.createdAt,
    updated_at: application.updatedAt,
    withdrawn_at: application.withdrawnAt,
    fields: projectFields(application.fields),
    history: Object.freeze(application.history.map(projectHistory)),
    interest_is_binding: false,
  });
}

function projectHistory(
  entry: FounderApplicationHistoryEntry,
): FounderInterestHistoryData {
  return Object.freeze({
    revision: entry.revision,
    kind: entry.kind,
    status: entry.status,
    occurred_at: entry.occurredAt,
    fields: projectFields(entry.fields),
  });
}

function projectFields(
  fields: FounderApplicationFields,
): FounderInterestFieldsData {
  return Object.freeze({
    expertise_summary: fields.expertiseSummary,
    intended_contribution: fields.intendedContribution,
    primary_contribution_area_id: fields.primaryContributionAreaId,
    secondary_contribution_area_ids: Object.freeze([
      ...fields.secondaryContributionAreaIds,
    ]),
    approximate_availability: fields.approximateAvailability,
    possible_start_timing: fields.possibleStartTiming,
    compensation_expectation: fields.compensationExpectation,
    professional_profile_links: Object.freeze([
      ...fields.professionalProfileLinks,
    ]),
    note: fields.note,
  });
}
