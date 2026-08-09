import { aittaDbPublicCampaign } from "../campaigns/aittadb-public.ts";
import { chatGPTSignInPath } from "./auth-navigation.ts";

export const INVESTOR_APP_API_VERSION = "0.1";
export const INVESTOR_APP_MEDIA_TYPE = "application/vnd.aittadb-invest+json";

export const publicCampaignActions = {
  signIn: {
    name: "sign-in",
    title: "Register your interest",
    href: chatGPTSignInPath("/"),
  },
  investor: {
    name: "pre-register-investor",
    title: "Continue as an investor",
    href: chatGPTSignInPath("/?intent=investor"),
  },
  founder: {
    name: "pre-register-founder",
    title: "Continue as a potential founder",
    href: chatGPTSignInPath("/?intent=founder"),
  },
} as const;

export type HypermediaLink = Readonly<{
  rel: readonly string[];
  href: string;
}>;

export type HypermediaAction = Readonly<{
  name: string;
  title: string;
  method: "GET";
  href: string;
  type: "text/html";
  fields: readonly [];
}>;

export type PublicCampaignDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "investment-pre-registration";
  id: "aittadb";
  data: Readonly<{
    name: string;
    phase: "pre-registration";
    phase_label: string;
    status: "open";
    status_label: string;
    product_summary: string;
    invitation: string;
    participation_paths: readonly ["investor", "founder"];
    interest_is_binding: false;
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export function createPublicCampaignDocument(
  requestUrl: string,
  capabilities: Readonly<{ manageCampaign?: boolean }> = {},
): PublicCampaignDocument {
  const absolute = (href: string) => new URL(href, requestUrl).href;

  return {
    api_version: INVESTOR_APP_API_VERSION,
    type: "investment-pre-registration",
    id: "aittadb",
    data: {
      name: aittaDbPublicCampaign.name,
      phase: "pre-registration",
      phase_label: aittaDbPublicCampaign.phaseLabel,
      status: "open",
      status_label: aittaDbPublicCampaign.statusLabel,
      product_summary: aittaDbPublicCampaign.productSummary,
      invitation: aittaDbPublicCampaign.invitation,
      participation_paths: ["investor", "founder"],
      interest_is_binding: false,
    },
    links: [
      { rel: ["self"], href: absolute("/") },
      { rel: ["about", "product"], href: "https://aittadb.com/" },
      {
        rel: ["source"],
        href: "https://github.com/aittadb/aittadb",
      },
    ],
    actions: [
      ...Object.values(publicCampaignActions).map((action) => ({
        ...action,
        method: "GET" as const,
        href: absolute(action.href),
        type: "text/html" as const,
        fields: [] as const,
      })),
      ...(capabilities.manageCampaign
        ? [
            {
              name: "manage-campaign",
              title: "Manage campaign",
              method: "GET" as const,
              href: absolute("/owner"),
              type: "text/html" as const,
              fields: [] as const,
            },
          ]
        : []),
    ],
  };
}
