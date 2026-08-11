import type { PublicCampaignConfiguration } from "./public-campaign-configuration.ts";
import { chatGPTSignInPath } from "./auth-navigation.ts";
import {
  defineAction,
  toHypermediaAction,
  type HypermediaAction,
} from "./hypermedia-action.ts";
import {
  PARTICIPANT_HOME_PATH,
  PRIVATE_PACKAGE_PATH,
} from "./participant-navigation.ts";
import type { SanitizedPublicInvestmentAggregate } from "./investment-aggregate.ts";

export type { HypermediaAction } from "./hypermedia-action.ts";

export const INVESTOR_APP_API_VERSION = "0.1";
export const INVESTOR_APP_MEDIA_TYPE = "application/vnd.aittadb-invest+json";

export type HypermediaLink = Readonly<{
  rel: readonly string[];
  href: string;
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
    aggregate_interest: PublicAggregateInterestDocument | null;
    interest_is_binding: false;
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type PublicAggregateInterestDocument = Readonly<{
  amount_minor_units: number;
  currency: string;
  label: string;
  qualifier: string;
  verification: Readonly<{
    self_declared: true;
    verified: false;
    binding: false;
  }>;
  oversubscription: Readonly<{
    status: "below_target" | "target_reached" | "oversubscribed";
    target_amount_minor_units: number;
    remaining_amount_minor_units: number;
    amount_over_target_minor_units: number;
  }> | null;
}>;

export function createPublicCampaignDocument(
  requestUrl: string,
  configuration: PublicCampaignConfiguration | null,
  capabilities: Readonly<{
    manageCampaign?: boolean;
    participant?: Readonly<{ privatePackage: boolean }>;
    publicAggregate?: SanitizedPublicInvestmentAggregate | null;
  }> = {},
): PublicCampaignDocument {
  const absolute = (href: string) => new URL(href, requestUrl).href;
  const manageAction = capabilities.manageCampaign
    ? [action("manage-campaign", "Manage campaign", absolute("/owner"))]
    : [];
  const participantLinks: readonly HypermediaLink[] = capabilities.participant
    ? [
        {
          rel: ["participant-home"],
          href: absolute(PARTICIPANT_HOME_PATH),
        },
        ...(capabilities.participant.privatePackage
          ? [{ rel: ["private-package"], href: absolute(PRIVATE_PACKAGE_PATH) }]
          : []),
      ]
    : [];
  const authenticatedActions = capabilities.participant
    ? [
        action(
          "open-participant-home",
          "View your participation",
          absolute(PARTICIPANT_HOME_PATH),
        ),
        ...(capabilities.participant.privatePackage
          ? [action(
              "read-private-package",
              "Read information package",
              absolute(PRIVATE_PACKAGE_PATH),
            )]
          : []),
      ]
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
        aggregate_interest: null,
        interest_is_binding: false,
      },
      links: [
        { rel: ["self"], href: absolute("/") },
        ...participantLinks,
      ],
      actions: [...authenticatedActions, ...manageAction],
    };
  }

  const visitorActions = !capabilities.participant && configuration.status === "open"
    ? [
        action(
          "sign-in",
          configuration.hero.primaryActionLabel,
          absolute(chatGPTSignInPath(PARTICIPANT_HOME_PATH)),
        ),
        ...configuration.participation.paths.map((path) =>
          action(
            `pre-register-${path.kind}`,
            path.actionLabel,
            absolute(chatGPTSignInPath(PARTICIPANT_HOME_PATH)),
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
      aggregate_interest: publicAggregateDocument(
        capabilities.publicAggregate ?? null,
      ),
      interest_is_binding: false,
    },
    links: [
      { rel: ["self"], href: absolute("/") },
      ...uniqueLinks(configuration).map((link) => ({
        rel: link.rel,
        href: absolute(link.href),
      })),
      ...participantLinks,
    ],
    actions: [...visitorActions, ...authenticatedActions, ...manageAction],
  };
}

function publicAggregateDocument(
  aggregate: SanitizedPublicInvestmentAggregate | null,
): PublicAggregateInterestDocument | null {
  if (aggregate === null) return null;
  return Object.freeze({
    amount_minor_units: aggregate.amount,
    currency: aggregate.currency,
    label: aggregate.label,
    qualifier: aggregate.qualifier,
    verification: Object.freeze({
      self_declared: true as const,
      verified: false as const,
      binding: false as const,
    }),
    oversubscription: aggregate.oversubscription === null
      ? null
      : Object.freeze({
          status: aggregate.oversubscription.status,
          target_amount_minor_units: aggregate.oversubscription.targetAmount,
          remaining_amount_minor_units:
            aggregate.oversubscription.remainingAmount,
          amount_over_target_minor_units:
            aggregate.oversubscription.amountOverTarget,
        }),
  });
}

function action(name: string, title: string, href: string): HypermediaAction {
  return toHypermediaAction(defineAction({
    name,
    title,
    method: "GET",
    href,
    requestMediaType: "text/html",
    fields: [],
  }));
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
