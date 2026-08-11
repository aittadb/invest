import {
  manualNotificationDeliveryState,
} from "./audit-notification.ts";
import {
  defineAction,
  toHtmlFormAction,
  toHypermediaAction,
  type ActionContract,
  type HtmlFormAction,
  type HypermediaAction,
} from "./hypermedia-action.ts";
import {
  INVESTMENT_INDICATION_LIMITS,
  MAX_INVESTMENT_INDICATION_REVISIONS,
} from "./investment-indication.ts";
import {
  INVESTOR_APP_API_VERSION,
  type HypermediaLink,
} from "./public-campaign-resource.ts";
import type {
  StorageCursor,
  StorageOperationId,
} from "./storage-adapter.ts";
import type {
  OwnerIndicationModerationItem,
  OwnerIndicationReviewPage,
  OwnerIndicationReviewSummary,
} from "../services/owner-indication-moderation.ts";

export const OWNER_INDICATIONS_PATH = "/owner/investment-indications";

export type OwnerIndicationSummary = Readonly<{
  review_id: string;
  kind: "personal" | "company";
  status: "active" | "withdrawn" | "rejected";
  amount: number;
  currency: string;
  updated_at: string;
  revision: number;
}>;

export type OwnerIndicationCollectionDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "owner-investment-indication-collection";
  id: "owner-investment-indications";
  data: Readonly<{ items: readonly OwnerIndicationSummary[] }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type OwnerIndicationDetailData = Readonly<{
  indication_id: string;
  participant_subject: string;
  kind: "personal" | "company";
  status: "active" | "withdrawn" | "rejected";
  revision: number;
  created_at: string;
  updated_at: string;
  amount: number;
  currency: string;
  availability_period: string;
  note: string | null;
  personal: Readonly<{
    residence_country: string;
  }> | null;
  company: Readonly<{
    name: string;
    registration_country: string;
    identifier: string;
    representative_name: string;
    representative_authority_declared: boolean;
  }> | null;
  rejection: Readonly<{
    reason: string;
    rejected_at: string;
  }> | null;
  history: readonly Readonly<{
    revision: number;
    transition: "created" | "edited" | "withdrawn" | "reactivated" | "rejected";
    status: "active" | "withdrawn" | "rejected";
    occurred_at: string;
  }>[];
  notification: Readonly<{
    id: string;
    subject_line: string;
    body: string;
    generated_at: string;
    delivery_state: "not-marked-sent" | "marked-sent";
  }> | null;
}>;

export type OwnerIndicationDetailDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "owner-investment-indication";
  id: string;
  data: OwnerIndicationDetailData;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type OwnerIndicationRejectControl = Readonly<{
  contract: ActionContract;
  hypermedia: HypermediaAction;
  form: HtmlFormAction;
}>;

export type OwnerIndicationDetailResource = Readonly<{
  document: OwnerIndicationDetailDocument;
  reject: OwnerIndicationRejectControl | null;
}>;

export type OwnerIndicationOperationIdIssuer = () => StorageOperationId;

export function createOwnerIndicationCollectionDocument(
  requestUrl: string,
  page: OwnerIndicationReviewPage,
  pageSize: number,
): OwnerIndicationCollectionDocument {
  const self = new URL(requestUrl);
  const links: HypermediaLink[] = [
    { rel: ["self"], href: self.href },
    { rel: ["owner"], href: new URL("/owner", self).href },
    ...page.items.map((item) => ({
      rel: ["item"],
      href: itemHref(self, item.reviewId),
    })),
  ];
  if (page.nextCursor !== null) {
    const next = new URL(self);
    next.searchParams.set("page_size", String(pageSize));
    next.searchParams.set("cursor", page.nextCursor as StorageCursor);
    links.push({ rel: ["next"], href: next.href });
  }

  return deepFreeze({
    api_version: INVESTOR_APP_API_VERSION,
    type: "owner-investment-indication-collection",
    id: "owner-investment-indications",
    data: { items: page.items.map(projectSummary) },
    links,
    actions: [],
  });
}

export function createOwnerIndicationDetailResource(
  requestUrl: string,
  item: OwnerIndicationModerationItem,
  mutationAvailable: boolean,
  issueOperationId: OwnerIndicationOperationIdIssuer,
): OwnerIndicationDetailResource {
  const self = new URL(requestUrl);
  const reject = mutationAvailable &&
      item.indication.lifecycle.status === "active" &&
      item.indication.revision < MAX_INVESTMENT_INDICATION_REVISIONS
    ? rejectControl(
        self.href,
        item.indication.revision,
        issueOperationId(),
      )
    : null;
  const notification = item.notification?.record ?? null;
  const links: HypermediaLink[] = [
    { rel: ["self"], href: self.href },
    { rel: ["collection"], href: new URL(OWNER_INDICATIONS_PATH, self).href },
    { rel: ["owner"], href: new URL("/owner", self).href },
    ...(notification === null
      ? []
      : [{
          rel: ["manual-notification"],
          href: new URL(
            `/owner/manual-notifications/${encodeURIComponent(notification.template.id)}`,
            self,
          ).href,
        }]),
  ];

  return deepFreeze({
    document: {
      api_version: INVESTOR_APP_API_VERSION,
      type: "owner-investment-indication",
      id: item.reviewId,
      data: projectDetail(item),
      links,
      actions: reject === null ? [] : [reject.hypermedia],
    },
    reject,
  });
}

function rejectControl(
  href: string,
  revision: number,
  operationId: StorageOperationId,
): OwnerIndicationRejectControl {
  const contract = defineAction({
    name: "reject-investment-indication",
    title: "Reject indication",
    method: "POST",
    href,
    requestMediaType: "application/x-www-form-urlencoded",
    fields: [
      {
        name: "operation-id",
        title: "Operation ID",
        type: "string",
        location: "body",
        required: true,
        minLength: 1,
        maxLength: 128,
        value: operationId,
        presentation: "hidden",
      },
      {
        name: "expected-revision",
        title: "Expected revision",
        type: "integer",
        location: "body",
        required: true,
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER - 1,
        value: revision,
        presentation: "hidden",
      },
      {
        name: "reason",
        title: "Participant-visible reason",
        type: "string",
        format: "multiline",
        location: "body",
        required: true,
        minLength: 1,
        maxLength: INVESTMENT_INDICATION_LIMITS.rejectionReasonLength,
        maxBytes: INVESTMENT_INDICATION_LIMITS.rejectionReasonLength * 4,
      },
    ],
  });
  return Object.freeze({
    contract,
    hypermedia: toHypermediaAction(contract),
    form: toHtmlFormAction(contract),
  });
}

function projectSummary(
  item: OwnerIndicationReviewSummary,
): OwnerIndicationSummary {
  return {
    review_id: item.reviewId,
    kind: item.kind,
    status: item.status,
    amount: item.amount,
    currency: item.currency,
    updated_at: item.updatedAt,
    revision: item.revision,
  };
}

function projectDetail(
  item: OwnerIndicationModerationItem,
): OwnerIndicationDetailData {
  const { indication, notification } = item;
  const fields = indication.fields;
  const rejection = indication.lifecycle.status === "rejected"
    ? {
        reason: indication.lifecycle.rejection.reason,
        rejected_at: indication.lifecycle.rejection.rejectedAt,
      }
    : null;
  return {
    indication_id: indication.id,
    participant_subject: indication.participantSubject,
    kind: indication.kind,
    status: indication.lifecycle.status,
    revision: indication.revision,
    created_at: indication.createdAt,
    updated_at: indication.updatedAt,
    amount: fields.amount,
    currency: fields.currency,
    availability_period: fields.availabilityPeriod,
    note: fields.note,
    personal: fields.kind === "personal"
      ? { residence_country: fields.residenceCountry }
      : null,
    company: fields.kind === "company"
      ? {
          name: fields.companyName,
          registration_country: fields.registrationCountry,
          identifier: fields.companyIdentifier,
          representative_name: fields.representativeName,
          representative_authority_declared:
            fields.representativeAuthorityDeclared,
        }
      : null,
    rejection,
    history: indication.history.map((entry) => ({
      revision: entry.revision,
      transition: entry.transition,
      status: entry.status,
      occurred_at: entry.occurredAt,
    })),
    notification: notification === null
      ? null
      : {
          id: notification.record.template.id,
          subject_line: notification.record.template.subjectLine,
          body: notification.record.template.body,
          generated_at: notification.record.template.generatedAt,
          delivery_state: manualNotificationDeliveryState(notification.record),
        },
  };
}

function itemHref(base: URL, reviewId: string): string {
  return new URL(
    `${OWNER_INDICATIONS_PATH}/${encodeURIComponent(reviewId)}`,
    base,
  ).href;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
