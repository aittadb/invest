import { chatGPTSignInPath, chatGPTSignOutPath } from "./auth-navigation.ts";

import {
  INVESTOR_APP_API_VERSION,
  type HypermediaAction,
  type HypermediaLink,
} from "./public-campaign-resource.ts";
import { defineAction, toHypermediaAction } from "./hypermedia-action.ts";
import type { PublicCampaignConfiguration } from "./public-campaign-configuration.ts";
import { OWNER_OAUTH_PROOF_PATH } from "./owner-oauth-proof-resource.ts";

export type OwnerHomeDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "owner-home";
  id: "owner";
  data: Readonly<{
    display_name: string;
    email: string;
    setup_status: "configured" | "required";
    campaign_name: string | null;
    publication: "published" | "unpublished" | "not-configured";
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type OwnerHomeCapabilities = Readonly<{
  campaignSetup?: boolean;
  campaignEditor?: boolean;
  founderApplicationReview?: boolean;
  aggregateReconciliation?: boolean;
  auditHistory?: boolean;
  /** Compatibility capability until notification persistence is composed. */
  auditNotificationHistory?: boolean;
  managePackage?: boolean;
  indicationModeration?: boolean;
  aittadbConnection?: boolean;
  reviewExports?: boolean;
}>;

export function createOwnerHomeDocument(
  requestUrl: string,
  owner: Readonly<{ displayName: string; email: string }>,
  campaign: PublicCampaignConfiguration | null,
  capabilities: OwnerHomeCapabilities = {},
): OwnerHomeDocument {
  const absolute = (href: string) => new URL(href, requestUrl).href;
  const auditHistoryAvailable = capabilities.auditHistory === true ||
    capabilities.auditNotificationHistory === true;
  const notificationHistoryAvailable =
    capabilities.auditNotificationHistory === true;
  const packageLinks = capabilities.managePackage
    ? [{ rel: ["information-package"], href: absolute("/owner/package") }]
    : [];
  const packageActions = capabilities.managePackage
    ? [toHypermediaAction(defineAction({
        name: "manage-information-package",
        title: "Manage information package",
        href: absolute("/owner/package"),
        method: "GET",
        requestMediaType: "text/html",
        fields: [],
      }))]
    : [];

  return {
    api_version: INVESTOR_APP_API_VERSION,
    type: "owner-home",
    id: "owner",
    data: {
      display_name: owner.displayName,
      email: owner.email,
      setup_status: campaign ? "configured" : "required",
      campaign_name: campaign?.name ?? null,
      publication: campaign
        ? campaign.published
          ? "published"
          : "unpublished"
        : "not-configured",
    },
    links: [
      { rel: ["self"], href: absolute("/owner") },
      { rel: ["campaign"], href: absolute("/") },
      ...(capabilities.campaignSetup
        ? [{
          rel: ["campaign-setup"],
          href: absolute("/owner/setup"),
        }]
        : []),
      ...(capabilities.campaignEditor && campaign !== null
        ? [{
          rel: ["campaign-editor"],
          href: absolute("/owner/campaign"),
        }]
        : []),
      ...(capabilities.founderApplicationReview
        ? [{
          rel: ["founder-applications"],
          href: absolute("/owner/founder-applications"),
        }]
        : []),
      ...(capabilities.aggregateReconciliation
        ? [{
          rel: ["aggregate-reconciliation"],
          href: absolute("/owner/aggregate-reconciliation"),
        }]
        : []),
      ...(auditHistoryAvailable
        ? [{
            rel: ["audit-events"],
            href: absolute("/owner/audit-events"),
          }]
        : []),
      ...(notificationHistoryAvailable
        ? [{
            rel: ["manual-notifications"],
            href: absolute("/owner/manual-notifications"),
          }]
        : []),
      ...(capabilities.indicationModeration
        ? [{
          rel: ["investment-indications"],
          href: absolute("/owner/investment-indications"),
        }]
        : []),
      ...(capabilities.aittadbConnection
        ? [{
          rel: ["aittadb-connection"],
          href: absolute(OWNER_OAUTH_PROOF_PATH),
        }]
        : []),
      ...(capabilities.reviewExports
        ? [{ rel: ["review-exports"], href: absolute("/owner/exports") }]
        : []),
      ...packageLinks,
    ],
    actions: [
      ...(capabilities.campaignSetup
        ? [{
          name: "manage-campaign-setup",
          title: campaign === null ? "Configure campaign" : "Review campaign setup",
          href: absolute("/owner/setup"),
          method: "GET" as const,
          type: "text/html" as const,
          fields: [],
        }]
        : []),
      ...packageActions,
      {
        name: "sign-out",
        title: "Sign out",
        href: absolute(chatGPTSignOutPath("/")),
        method: "GET",
        type: "text/html",
        fields: [],
      },
      ...(auditHistoryAvailable
        ? [{
            name: "review-audit-events",
            title: "Review audit events",
            href: absolute("/owner/audit-events"),
            method: "GET" as const,
            type: "text/html" as const,
            fields: [],
          }]
        : []),
      ...(notificationHistoryAvailable
        ? [{
            name: "review-manual-notifications",
            title: "Review manual notifications",
            href: absolute("/owner/manual-notifications"),
            method: "GET" as const,
            type: "text/html" as const,
            fields: [],
          }]
        : []),
      ...(capabilities.indicationModeration
        ? [{
          name: "review-investment-indications",
          title: "Review investment indications",
          href: absolute("/owner/investment-indications"),
          method: "GET" as const,
          type: "text/html" as const,
          fields: [],
        }]
        : []),
      ...(capabilities.aittadbConnection
        ? [{
          name: "review-aittadb-connection",
          title: "Review AittaDB connection",
          href: absolute(OWNER_OAUTH_PROOF_PATH),
          method: "GET" as const,
          type: "text/html" as const,
          fields: [],
        }]
        : []),
      ...(capabilities.reviewExports
        ? [
          {
            name: "open-review-exports",
            title: "Review exports",
            href: absolute("/owner/exports"),
            method: "GET" as const,
            type: "text/html" as const,
            fields: [],
          },
        ]
        : []),
    ],
  };
}

export function createOwnerAuthenticationRequiredDocument(
  requestUrl: string,
): Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "error";
  id: "authentication-required";
  data: Readonly<{ code: "authentication_required"; message: string }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}> {
  const absolute = (href: string) => new URL(href, requestUrl).href;

  return {
    api_version: INVESTOR_APP_API_VERSION,
    type: "error",
    id: "authentication-required",
    data: {
      code: "authentication_required",
      message: "Sign in is required to continue.",
    },
    links: [{ rel: ["self"], href: absolute("/owner") }],
    actions: [
      {
        name: "sign-in",
        title: "Sign in",
        href: absolute(chatGPTSignInPath("/owner")),
        method: "GET",
        type: "text/html",
        fields: [],
      },
    ],
  };
}
