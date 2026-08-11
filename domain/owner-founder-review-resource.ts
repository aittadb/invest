import type { FounderApplication } from "./founder-application.ts";
import {
  INVESTOR_APP_API_VERSION,
  type HypermediaAction,
  type HypermediaLink,
} from "./public-campaign-resource.ts";

export type OwnerFounderReviewCollectionItem = Readonly<{
  reviewId: string;
  status: FounderApplication["status"];
  primaryContributionAreaId: string;
  updatedAt: string;
  revision: number;
}>;

export type OwnerFounderReviewPage = Readonly<{
  items: readonly OwnerFounderReviewCollectionItem[];
  nextCursor: string | null;
}>;

export type OwnerFounderReviewItem = Readonly<{
  reviewId: string;
  application: FounderApplication;
}>;

export type OwnerFounderReviewSummary = Readonly<{
  review_id: string;
  status: FounderApplication["status"];
  primary_contribution_area_id: string;
  updated_at: string;
  revision: number;
}>;

export type OwnerFounderReviewCollectionDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "owner-founder-application-collection";
  id: "owner-founder-applications";
  data: Readonly<{
    items: readonly OwnerFounderReviewSummary[];
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type OwnerFounderReviewDetailDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "owner-founder-application";
  id: string;
  data: Readonly<{
    application_id: string;
    status: FounderApplication["status"];
    revision: number;
    created_at: string;
    updated_at: string;
    withdrawn_at: string | null;
    expertise_summary: string;
    intended_contribution: string;
    primary_contribution_area_id: string;
    secondary_contribution_area_ids: readonly string[];
    approximate_availability: string;
    possible_start_timing: string;
    compensation_expectation: string;
    professional_profile_links: readonly string[];
    note: string | null;
    history: readonly Readonly<{
      revision: number;
      transition: "created" | "edited" | "withdrawn";
      status: FounderApplication["status"];
      occurred_at: string;
    }>[];
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export function createOwnerFounderReviewCollectionDocument(
  requestUrl: string,
  page: OwnerFounderReviewPage,
  pageSize: number,
  detailAvailable: boolean,
): OwnerFounderReviewCollectionDocument {
  const self = new URL(requestUrl);
  const links: HypermediaLink[] = [
    { rel: ["self"], href: self.href },
    { rel: ["owner"], href: new URL("/owner", self).href },
    ...(detailAvailable
      ? page.items.map((item) => ({
          rel: ["item"],
          href: reviewHref(self, item.reviewId),
        }))
      : []),
  ];
  if (page.nextCursor !== null) {
    const next = new URL(self);
    next.searchParams.set("page_size", String(pageSize));
    next.searchParams.set("cursor", page.nextCursor);
    links.push({ rel: ["next"], href: next.href });
  }

  return deepFreeze({
    api_version: INVESTOR_APP_API_VERSION,
    type: "owner-founder-application-collection",
    id: "owner-founder-applications",
    data: {
      items: page.items.map(projectSummary),
    },
    links,
    actions: [],
  });
}

export function createOwnerFounderReviewDetailDocument(
  requestUrl: string,
  item: OwnerFounderReviewItem,
): OwnerFounderReviewDetailDocument {
  const self = new URL(requestUrl);
  const application = item.application;
  return deepFreeze({
    api_version: INVESTOR_APP_API_VERSION,
    type: "owner-founder-application",
    id: item.reviewId,
    data: {
      application_id: application.id,
      status: application.status,
      revision: application.revision,
      created_at: application.createdAt,
      updated_at: application.updatedAt,
      withdrawn_at: application.withdrawnAt,
      expertise_summary: application.fields.expertiseSummary,
      intended_contribution: application.fields.intendedContribution,
      primary_contribution_area_id:
        application.fields.primaryContributionAreaId,
      secondary_contribution_area_ids: [
        ...application.fields.secondaryContributionAreaIds,
      ],
      approximate_availability: application.fields.approximateAvailability,
      possible_start_timing: application.fields.possibleStartTiming,
      compensation_expectation: application.fields.compensationExpectation,
      professional_profile_links: [
        ...application.fields.professionalProfileLinks,
      ],
      note: application.fields.note,
      history: application.history.map((entry) => ({
        revision: entry.revision,
        transition: entry.kind,
        status: entry.status,
        occurred_at: entry.occurredAt,
      })),
    },
    links: [
      { rel: ["self"], href: self.href },
      {
        rel: ["collection"],
        href: new URL("/owner/founder-applications", self).href,
      },
      { rel: ["owner"], href: new URL("/owner", self).href },
    ],
    actions: [],
  });
}

function projectSummary(
  item: OwnerFounderReviewCollectionItem,
): OwnerFounderReviewSummary {
  return {
    review_id: item.reviewId,
    status: item.status,
    primary_contribution_area_id: item.primaryContributionAreaId,
    updated_at: item.updatedAt,
    revision: item.revision,
  };
}

function reviewHref(base: URL, reviewId: string): string {
  return new URL(
    `/owner/founder-applications/${encodeURIComponent(reviewId)}`,
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
