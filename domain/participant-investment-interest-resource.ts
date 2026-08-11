import type { AmountConfiguration } from "./amount-aggregate-configuration.ts";
import {
  participantVisibleIndicationLifecycle,
  type InvestmentIndication,
  type InvestmentIndicationFields,
  type InvestmentIndicationHistoryEntry,
} from "./investment-indication.ts";
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

export const INVESTMENT_INTEREST_PATH = "/participant/investment-interests";
export const MAX_PARTICIPANT_INVESTMENT_INTERESTS = 100;

export type PersonalInvestmentInterestFieldsData = Readonly<{
  kind: "personal";
  residence_country: string;
  amount: number;
  currency: string;
  availability_period: string;
  note: string | null;
}>;

export type CompanyInvestmentInterestFieldsData = Readonly<{
  kind: "company";
  company_name: string;
  registration_country: string;
  company_identifier: string;
  representative_name: string;
  representative_authority_declared: true;
  amount: number;
  currency: string;
  availability_period: string;
  note: string | null;
}>;

export type InvestmentInterestFieldsData =
  | PersonalInvestmentInterestFieldsData
  | CompanyInvestmentInterestFieldsData;

export type InvestmentInterestHistoryData = Readonly<{
  revision: number;
  transition: InvestmentIndicationHistoryEntry["transition"];
  status: InvestmentIndicationHistoryEntry["status"];
  occurred_at: string;
  fields: InvestmentInterestFieldsData;
  rejection_reason: string | null;
}>;

export type InvestmentInterestSummaryData = Readonly<{
  id: string;
  href: string;
  kind: InvestmentIndication["kind"];
  status: InvestmentIndication["lifecycle"]["status"];
  revision: number;
  created_at: string;
  updated_at: string;
  fields: InvestmentInterestFieldsData;
  rejection_reason: string | null;
}>;

export type InvestmentInterestCollectionDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "participant-investment-interest-collection";
  id: "investment-interests";
  data: Readonly<{
    acknowledgment_current: boolean;
    interest_is_binding: false;
    amount: Readonly<{
      currency: string;
      minimum: number;
      increment: number;
      maximum: number | null;
    }>;
    indications: readonly InvestmentInterestSummaryData[];
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type InvestmentInterestItemDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "participant-investment-interest";
  id: string;
  data: Readonly<{
    kind: InvestmentIndication["kind"];
    status: InvestmentIndication["lifecycle"]["status"];
    revision: number;
    created_at: string;
    updated_at: string;
    activated_at: string;
    withdrawn_at: string | null;
    rejected_at: string | null;
    rejection_reason: string | null;
    fields: InvestmentInterestFieldsData;
    history: readonly InvestmentInterestHistoryData[];
    acknowledgment_current: boolean;
    interest_is_binding: false;
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type InvestmentInterestCollectionCapabilityModel = Readonly<{
  document: InvestmentInterestCollectionDocument;
  actionContracts: readonly ActionContract[];
  forms: readonly HtmlFormAction[];
}>;

export type InvestmentInterestItemCapabilityModel = Readonly<{
  document: InvestmentInterestItemDocument;
  actionContracts: readonly ActionContract[];
  forms: readonly HtmlFormAction[];
}>;

export type InvestmentInterestCollectionResourceInput = Readonly<{
  requestUrl: string;
  indications: readonly InvestmentIndication[];
  amountConfiguration: AmountConfiguration;
  acknowledgmentCurrent: boolean;
  canCreatePersonal: boolean;
  canCreateCompany: boolean;
  operationIds: Readonly<{
    createPersonal: string | null;
    createCompany: string | null;
  }>;
}>;

export type InvestmentInterestItemResourceInput = Readonly<{
  requestUrl: string;
  indication: InvestmentIndication;
  amountConfiguration: AmountConfiguration;
  acknowledgmentCurrent: boolean;
  canEdit: boolean;
  canWithdraw: boolean;
  canReactivate: boolean;
  operationIds: Readonly<{
    edit: string | null;
    withdraw: string | null;
    reactivate: string | null;
  }>;
}>;

/** Project the authorized collection into equivalent JSON actions and forms. */
export function createInvestmentInterestCollectionCapabilityModel(
  input: InvestmentInterestCollectionResourceInput,
): InvestmentInterestCollectionCapabilityModel {
  const self = absolute(input.requestUrl, INVESTMENT_INTEREST_PATH);
  const actions = currentActions(
    actionWhenAllowed(input.canCreatePersonal, () =>
      createFieldsAction(
        "personal",
        "Add personal interest",
        self,
        requiredOperationId(input.operationIds.createPersonal),
        input.amountConfiguration,
      )),
    actionWhenAllowed(input.canCreateCompany, () =>
      createFieldsAction(
        "company",
        "Add company interest",
        self,
        requiredOperationId(input.operationIds.createCompany),
        input.amountConfiguration,
      )),
  );
  const actionContracts = Object.freeze([...actions]);
  const summaries = Object.freeze(
    input.indications.map((indication) =>
      projectSummary(indication, itemUrl(input.requestUrl, indication.id))
    ),
  );
  const itemLinks = input.indications.map((indication) =>
    Object.freeze({
      rel: Object.freeze(["item", "investment-interest"]),
      href: itemUrl(input.requestUrl, indication.id),
    })
  );

  const document: InvestmentInterestCollectionDocument = Object.freeze({
    api_version: INVESTOR_APP_API_VERSION,
    type: "participant-investment-interest-collection",
    id: "investment-interests",
    data: Object.freeze({
      acknowledgment_current: input.acknowledgmentCurrent,
      interest_is_binding: false,
      amount: projectAmountConfiguration(input.amountConfiguration),
      indications: summaries,
    }),
    links: Object.freeze([
      Object.freeze({ rel: Object.freeze(["self"]), href: self }),
      Object.freeze({
        rel: Object.freeze(["participant-home"]),
        href: absolute(input.requestUrl, "/participant"),
      }),
      Object.freeze({
        rel: Object.freeze(["private-package"]),
        href: absolute(input.requestUrl, "/participant/package"),
      }),
      Object.freeze({
        rel: Object.freeze(["campaign"]),
        href: absolute(input.requestUrl, "/"),
      }),
      ...itemLinks,
    ]),
    actions: Object.freeze(actionContracts.map(toHypermediaAction)),
  });

  return Object.freeze({
    document,
    actionContracts,
    forms: Object.freeze(actionContracts.map(toHtmlFormAction)),
  });
}

/** Project one authorized indication into equivalent JSON actions and forms. */
export function createInvestmentInterestItemCapabilityModel(
  input: InvestmentInterestItemResourceInput,
): InvestmentInterestItemCapabilityModel {
  const self = itemUrl(input.requestUrl, input.indication.id);
  const actions = currentActions(
    actionWhenAllowed(input.canEdit, () =>
      editFieldsAction(
        input.indication,
        self,
        requiredOperationId(input.operationIds.edit),
        input.amountConfiguration,
      )),
    actionWhenAllowed(input.canWithdraw, () =>
      transitionAction(
        "withdraw-investment-interest",
        "Withdraw interest",
        "DELETE",
        self,
        requiredOperationId(input.operationIds.withdraw),
        input.indication.revision,
        "confirm-withdrawal",
        "I want to withdraw this indication",
      )),
    actionWhenAllowed(input.canReactivate, () =>
      transitionAction(
        "reactivate-investment-interest",
        "Reactivate interest",
        "POST",
        self,
        requiredOperationId(input.operationIds.reactivate),
        input.indication.revision,
        "confirm-reactivation",
        "I want to reactivate this indication",
      )),
  );
  const actionContracts = Object.freeze([...actions]);
  const lifecycle = participantVisibleIndicationLifecycle(input.indication);

  const document: InvestmentInterestItemDocument = Object.freeze({
    api_version: INVESTOR_APP_API_VERSION,
    type: "participant-investment-interest",
    id: input.indication.id,
    data: Object.freeze({
      kind: input.indication.kind,
      status: input.indication.lifecycle.status,
      revision: input.indication.revision,
      created_at: input.indication.createdAt,
      updated_at: input.indication.updatedAt,
      activated_at: input.indication.lifecycle.activatedAt,
      withdrawn_at: input.indication.lifecycle.withdrawnAt,
      rejected_at: input.indication.lifecycle.rejectedAt,
      rejection_reason: lifecycle.rejectionReason,
      fields: projectFields(input.indication.fields),
      history: Object.freeze(input.indication.history.map(projectHistory)),
      acknowledgment_current: input.acknowledgmentCurrent,
      interest_is_binding: false,
    }),
    links: Object.freeze([
      Object.freeze({ rel: Object.freeze(["self"]), href: self }),
      Object.freeze({
        rel: Object.freeze(["collection", "investment-interests"]),
        href: absolute(input.requestUrl, INVESTMENT_INTEREST_PATH),
      }),
      Object.freeze({
        rel: Object.freeze(["private-package"]),
        href: absolute(input.requestUrl, "/participant/package"),
      }),
      Object.freeze({
        rel: Object.freeze(["campaign"]),
        href: absolute(input.requestUrl, "/"),
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

function createFieldsAction(
  kind: InvestmentIndication["kind"],
  title: string,
  href: string,
  operationId: string,
  amount: AmountConfiguration,
): ActionContract {
  return defineAction({
    name: kind === "personal"
      ? "create-personal-investment-interest"
      : "create-company-investment-interest",
    title,
    method: "POST",
    href,
    requestMediaType: "application/x-www-form-urlencoded",
    fields: [
      operationIdField(operationId),
      kindField(kind),
      ...indicationFields(kind, amount, null),
    ],
  });
}

function editFieldsAction(
  indication: InvestmentIndication,
  href: string,
  operationId: string,
  amount: AmountConfiguration,
): ActionContract {
  return defineAction({
    name: "edit-investment-interest",
    title: "Save changes",
    method: "PATCH",
    href,
    requestMediaType: "application/x-www-form-urlencoded",
    fields: [
      operationIdField(operationId),
      expectedRevisionField(indication.revision),
      kindField(indication.kind),
      ...indicationFields(indication.kind, amount, indication.fields),
    ],
  });
}

function transitionAction(
  name: "withdraw-investment-interest" | "reactivate-investment-interest",
  title: string,
  method: "POST" | "DELETE",
  href: string,
  operationId: string,
  revision: number,
  confirmationName: "confirm-withdrawal" | "confirm-reactivation",
  confirmationTitle: string,
): ActionContract {
  return defineAction({
    name,
    title,
    method,
    href,
    requestMediaType: "application/x-www-form-urlencoded",
    fields: [
      operationIdField(operationId),
      expectedRevisionField(revision),
      {
        name: confirmationName,
        title: confirmationTitle,
        type: "boolean",
        location: "body",
        required: true,
      },
    ],
  });
}

function indicationFields(
  kind: InvestmentIndication["kind"],
  amount: AmountConfiguration,
  current: InvestmentIndicationFields | null,
): readonly ActionField[] {
  const common = [
    amountField(amount, current?.amount),
    textField(
      "availability-period",
      "When the investment could be available",
      500,
      true,
      current?.availabilityPeriod,
    ),
    textField(
      "note",
      "Additional note",
      4_000,
      false,
      current?.note ?? "",
    ),
  ];

  if (kind === "personal") {
    const fields = current?.kind === "personal" ? current : null;
    return [
      textField(
        "residence-country",
        "Residence country code",
        2,
        true,
        fields?.residenceCountry,
        2,
      ),
      ...common,
    ];
  }

  const fields = current?.kind === "company" ? current : null;
  return [
    textField("company-name", "Company name", 200, true, fields?.companyName),
    textField(
      "registration-country",
      "Registration country code",
      2,
      true,
      fields?.registrationCountry,
      2,
    ),
    textField(
      "company-identifier",
      "Business or registration identifier",
      256,
      true,
      fields?.companyIdentifier,
    ),
    textField(
      "representative-name",
      "Representative name",
      200,
      true,
      fields?.representativeName,
    ),
    {
      name: "representative-authority-declared",
      title: "I am authorized to represent this company",
      type: "boolean",
      location: "body",
      required: true,
      ...(fields ? { value: true } : {}),
    },
    ...common,
  ];
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
    maxLength: 127,
    maxBytes: 127,
    value,
  };
}

function expectedRevisionField(value: number): ActionField {
  return {
    name: "expected-revision",
    title: "Indication revision",
    type: "integer",
    location: "body",
    required: true,
    presentation: "hidden",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER - 1,
    value,
  };
}

function kindField(value: InvestmentIndication["kind"]): ActionField {
  return {
    name: "kind",
    title: "Indication kind",
    type: "string",
    format: "text",
    location: "body",
    required: true,
    presentation: "hidden",
    minLength: 1,
    maxLength: 16,
    maxBytes: 16,
    value,
  };
}

function amountField(
  amount: AmountConfiguration,
  value: number | undefined,
): ActionField {
  return {
    name: "amount",
    title: `Amount (${amount.currency}, minor units)`,
    type: "integer",
    location: "body",
    required: true,
    minimum: amount.minimum,
    maximum: amount.maximum ?? Number.MAX_SAFE_INTEGER,
    step: amount.increment,
    ...(value === undefined ? {} : { value }),
  };
}

function textField(
  name: string,
  title: string,
  maximum: number,
  required: boolean,
  value: string | undefined,
  minimum = required ? 1 : 0,
): ActionField {
  return {
    name,
    title,
    type: "string",
    format: maximum > 256 ? "multiline" : "text",
    location: "body",
    required,
    minLength: minimum,
    maxLength: maximum,
    maxBytes: maximum * 4,
    ...(value === undefined ? {} : { value }),
  };
}

function projectSummary(
  indication: InvestmentIndication,
  href: string,
): InvestmentInterestSummaryData {
  return Object.freeze({
    id: indication.id,
    href,
    kind: indication.kind,
    status: indication.lifecycle.status,
    revision: indication.revision,
    created_at: indication.createdAt,
    updated_at: indication.updatedAt,
    fields: projectFields(indication.fields),
    rejection_reason:
      participantVisibleIndicationLifecycle(indication).rejectionReason,
  });
}

function projectHistory(
  entry: InvestmentIndicationHistoryEntry,
): InvestmentInterestHistoryData {
  return Object.freeze({
    revision: entry.revision,
    transition: entry.transition,
    status: entry.status,
    occurred_at: entry.occurredAt,
    fields: projectFields(entry.fields),
    rejection_reason: entry.rejection?.reason ?? null,
  });
}

function projectFields(
  fields: InvestmentIndicationFields,
): InvestmentInterestFieldsData {
  if (fields.kind === "personal") {
    return Object.freeze({
      kind: "personal",
      residence_country: fields.residenceCountry,
      amount: fields.amount,
      currency: fields.currency,
      availability_period: fields.availabilityPeriod,
      note: fields.note,
    });
  }
  return Object.freeze({
    kind: "company",
    company_name: fields.companyName,
    registration_country: fields.registrationCountry,
    company_identifier: fields.companyIdentifier,
    representative_name: fields.representativeName,
    representative_authority_declared: true,
    amount: fields.amount,
    currency: fields.currency,
    availability_period: fields.availabilityPeriod,
    note: fields.note,
  });
}

function projectAmountConfiguration(
  amount: AmountConfiguration,
): InvestmentInterestCollectionDocument["data"]["amount"] {
  return Object.freeze({
    currency: amount.currency,
    minimum: amount.minimum,
    increment: amount.increment,
    maximum: amount.maximum,
  });
}

export function investmentInterestItemPath(id: string): string {
  return `${INVESTMENT_INTEREST_PATH}/${encodeURIComponent(id)}`;
}

function itemUrl(requestUrl: string, id: string): string {
  return absolute(requestUrl, investmentInterestItemPath(id));
}

function absolute(requestUrl: string, path: string): string {
  return new URL(path, requestUrl).href;
}

function requiredOperationId(value: string | null): string {
  if (value === null) {
    throw new Error("Missing operation ID for an available action.");
  }
  return value;
}
