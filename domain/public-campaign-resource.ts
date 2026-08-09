import type { PublicCampaignConfiguration } from "./public-campaign-configuration.ts";
import { chatGPTSignInPath } from "./auth-navigation.ts";

export const INVESTOR_APP_API_VERSION = "0.1";
export const INVESTOR_APP_MEDIA_TYPE = "application/vnd.aittadb-invest+json";

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
  id: string;
  data: Readonly<{
    published: boolean;
    name: string | null;
    phase_label: string | null;
    status: "open" | "closed" | "unavailable";
    status_label: string | null;
    product_summary: string | null;
    invitation: string | null;
    participation_paths: readonly ("investor" | "founder")[];
    interest_is_binding: false;
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export function participationPath(
  kind: "investor" | "founder",
): string {
  return chatGPTSignInPath(`/?intent=${kind}`);
}

export function createPublicCampaignDocument(
  requestUrl: string,
  configuration: PublicCampaignConfiguration | null,
  capabilities: Readonly<{ manageCampaign?: boolean }> = {},
): PublicCampaignDocument {
  const absolute = (href: string) => new URL(href, requestUrl).href;
  const manageAction = capabilities.manageCampaign
    ? [action("manage-campaign", "Manage campaign", absolute("/owner"))]
    : [];

  if (!configuration || !configuration.published) {
    return {
      api_version: INVESTOR_APP_API_VERSION,
      type: "investment-pre-registration",
      id: "unavailable",
      data: {
        published: false,
        name: null,
        phase_label: null,
        status: "unavailable",
        status_label: null,
        product_summary: null,
        invitation: null,
        participation_paths: [],
        interest_is_binding: false,
      },
      links: [{ rel: ["self"], href: absolute("/") }],
      actions: manageAction,
    };
  }

  const participantActions = configuration.status === "open"
    ? [
        action(
          "sign-in",
          configuration.hero.primaryActionLabel,
          absolute(chatGPTSignInPath("/")),
        ),
        ...configuration.participation.paths.map((path) =>
          action(
            `pre-register-${path.kind}`,
            path.actionLabel,
            absolute(participationPath(path.kind)),
          ),
        ),
      ]
    : [];

  return {
    api_version: INVESTOR_APP_API_VERSION,
    type: "investment-pre-registration",
    id: configuration.id,
    data: {
      published: true,
      name: configuration.name,
      phase_label: configuration.phaseLabel,
      status: configuration.status,
      status_label: configuration.statusLabel,
      product_summary: configuration.hero.summary,
      invitation: configuration.hero.invitation,
      participation_paths: configuration.participation.paths.map(
        (path) => path.kind,
      ),
      interest_is_binding: false,
    },
    links: [
      { rel: ["self"], href: absolute("/") },
      ...uniqueLinks(configuration).map((link) => ({
        rel: link.rel,
        href: absolute(link.href),
      })),
    ],
    actions: [...participantActions, ...manageAction],
  };
}

function action(name: string, title: string, href: string): HypermediaAction {
  return {
    name,
    title,
    method: "GET",
    href,
    type: "text/html",
    fields: [],
  };
}

function uniqueLinks(configuration: PublicCampaignConfiguration) {
  const links = [
    ...(configuration.product?.links ?? []),
    ...configuration.footer.links,
  ];
  return links.filter(
    (link, index) => links.findIndex((candidate) => candidate.href === link.href) === index,
  );
}
