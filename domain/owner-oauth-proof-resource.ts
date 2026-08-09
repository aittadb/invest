import {
  currentActions,
  defineAction,
  toHtmlFormAction,
  toHypermediaAction,
  type ActionContract,
  type HtmlFormAction,
} from "./hypermedia-action.ts";
import {
  INVESTOR_APP_API_VERSION,
  type HypermediaAction,
  type HypermediaLink,
} from "./public-campaign-resource.ts";

export const OWNER_OAUTH_PROOF_PATH = "/owner/aittadb-connection";
export const OWNER_OAUTH_CALLBACK_PATH =
  "/owner/aittadb-connection/callback";

export type OwnerOAuthProofAvailability = "available" | "unavailable";

export type OwnerOAuthProofDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "owner-aittadb-connection";
  id: "aittadb-connection";
  data: Readonly<{
    availability: OwnerOAuthProofAvailability;
    summary: string;
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type OwnerOAuthProofResource = Readonly<{
  document: OwnerOAuthProofDocument;
  start: Readonly<{
    action: ActionContract;
    form: HtmlFormAction;
  }> | null;
}>;

export type OwnerOAuthProofResultDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "owner-aittadb-connection-result";
  id: "aittadb-connection-result";
  data: Readonly<{
    outcome: "verified" | "failed";
    message: string;
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export function createOwnerOAuthProofResource(
  requestUrl: string,
  availability: OwnerOAuthProofAvailability,
): OwnerOAuthProofResource {
  const self = new URL(OWNER_OAUTH_PROOF_PATH, requestUrl).href;
  const startAction = availability === "available"
    ? defineAction({
        name: "verify-aittadb-connection",
        title: "Verify connection",
        method: "POST",
        href: self,
        requestMediaType: "application/x-www-form-urlencoded",
        fields: [],
      })
    : null;

  return Object.freeze({
    document: Object.freeze({
      api_version: INVESTOR_APP_API_VERSION,
      type: "owner-aittadb-connection",
      id: "aittadb-connection",
      data: Object.freeze({
        availability,
        summary: availability === "available"
          ? "A secure connection check is ready."
          : "The connection check is not available right now.",
      }),
      links: Object.freeze([
        Object.freeze({ rel: ["self"], href: self }),
        Object.freeze({ rel: ["owner"], href: new URL("/owner", requestUrl).href }),
      ]),
      actions: Object.freeze(
        currentActions(startAction).map(toHypermediaAction),
      ),
    }),
    start: startAction === null
      ? null
      : Object.freeze({
          action: startAction,
          form: toHtmlFormAction(startAction),
        }),
  });
}

export function createOwnerOAuthProofResultDocument(
  requestUrl: string,
  outcome: "verified" | "failed",
): OwnerOAuthProofResultDocument {
  const connection = new URL(OWNER_OAUTH_PROOF_PATH, requestUrl).href;
  const owner = new URL("/owner", requestUrl).href;
  const retry = outcome === "failed"
    ? defineAction({
        name: "return-to-connection-check",
        title: "Return to connection check",
        method: "GET",
        href: connection,
        requestMediaType: "text/html",
        fields: [],
      })
    : null;

  return Object.freeze({
    api_version: INVESTOR_APP_API_VERSION,
    type: "owner-aittadb-connection-result",
    id: "aittadb-connection-result",
    data: Object.freeze({
      outcome,
      message: outcome === "verified"
        ? "The AittaDB connection was verified."
        : "The connection could not be verified. Start a new check from the campaign workspace.",
    }),
    links: Object.freeze([
      Object.freeze({ rel: ["self"], href: new URL(requestUrl).href }),
      Object.freeze({ rel: ["owner"], href: owner }),
      Object.freeze({ rel: ["aittadb-connection"], href: connection }),
    ]),
    actions: Object.freeze(currentActions(retry).map(toHypermediaAction)),
  });
}
