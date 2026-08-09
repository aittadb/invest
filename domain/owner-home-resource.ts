import { chatGPTSignInPath, chatGPTSignOutPath } from "./auth-navigation.ts";

import {
  INVESTOR_APP_API_VERSION,
  type HypermediaAction,
  type HypermediaLink,
} from "./public-campaign-resource.ts";

export type OwnerHomeDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "owner-home";
  id: "owner";
  data: Readonly<{
    display_name: string;
    email: string;
    setup_status: "required";
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export function createOwnerHomeDocument(
  requestUrl: string,
  owner: Readonly<{ displayName: string; email: string }>,
): OwnerHomeDocument {
  const absolute = (href: string) => new URL(href, requestUrl).href;

  return {
    api_version: INVESTOR_APP_API_VERSION,
    type: "owner-home",
    id: "owner",
    data: {
      display_name: owner.displayName,
      email: owner.email,
      setup_status: "required",
    },
    links: [
      { rel: ["self"], href: absolute("/owner") },
      { rel: ["campaign"], href: absolute("/") },
    ],
    actions: [
      {
        name: "sign-out",
        title: "Sign out",
        href: absolute(chatGPTSignOutPath("/")),
        method: "GET",
        type: "text/html",
        fields: [],
      },
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
