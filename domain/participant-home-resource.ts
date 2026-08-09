import { chatGPTSignInPath, chatGPTSignOutPath } from "./auth-navigation.ts";
import {
  parseActorSubject,
  parseStableId,
  parseTimestamp,
  type ActorSubject,
  type StableId,
  type Timestamp,
} from "./foundation.ts";
import {
  defineAction,
  toHypermediaAction,
  type HypermediaAction,
} from "./hypermedia-action.ts";
import type {
  DeclaredInterest,
  ParticipationContext,
} from "./participant-profile.ts";
import {
  parseParticipantAccount,
  type ParticipantAccount,
} from "./participant-profile.ts";
import {
  PARTICIPANT_HOME_PATH,
  PRIVATE_PACKAGE_PATH,
} from "./participant-navigation.ts";
import { FOUNDER_INTEREST_PATH } from "./participant-founder-interest-resource.ts";
import { INVESTMENT_INTEREST_PATH } from "./participant-investment-interest-resource.ts";
import {
  INVESTOR_APP_API_VERSION,
  type HypermediaLink,
} from "./public-campaign-resource.ts";

const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_CHANGE_SUMMARY_LENGTH = 500;

export type ParticipantAuthorizationState = Readonly<{
  profile: Readonly<{
    subject: ActorSubject;
    displayName: string;
    declaredInterest: DeclaredInterest;
    participationContext: ParticipationContext;
    accountDeletionRequested: boolean;
  }>;
  currentPackage: Readonly<{
    id: StableId<"package-version">;
    createdAt: Timestamp;
    changeSummary: string;
    materialChange: boolean;
    requiresCurrentAcceptance: boolean;
  }> | null;
}>;

/** A credential-bound state reader. Its account is parsed from trusted session data. */
export interface ParticipantAccessStateReader {
  read(
    account: ParticipantAccount,
  ): Promise<ParticipantAuthorizationState | null>;
}

export type AuthorizedParticipantAccess = Readonly<{
  subject: ActorSubject;
  email: string;
  displayName: string;
  declaredInterest: DeclaredInterest;
  participationContext: ParticipationContext;
  accountStatus: "active" | "deletion-requested";
  currentPackage: ParticipantAuthorizationState["currentPackage"];
}>;

export type ParticipantHomeDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "participant-home";
  id: "participant";
  data: Readonly<{
    display_name: string;
    account_email: string;
    declared_interest: DeclaredInterest;
    participation_context: ParticipationContext;
    account_status: AuthorizedParticipantAccess["accountStatus"];
    campaign_name: string | null;
    current_package: Readonly<{
      version_id: string;
      created_at: string;
      change_summary: string;
      material_change: boolean;
      acceptance_required: boolean;
    }> | null;
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type PrivatePackageDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "private-package";
  id: string;
  data: Readonly<{
    created_at: string;
    change_summary: string;
    material_change: boolean;
    acceptance_required: boolean;
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type ParticipantHomeCapabilities = Readonly<{
  manageCampaign?: boolean;
  founderInterest?: boolean;
  investmentInterests?: boolean;
}>;

/**
 * Binds repository-derived participant and package state to one trusted account.
 * A foreign or malformed projection is indistinguishable from missing state.
 */
export function authorizeParticipantAccess(
  account: ParticipantAccount,
  state: ParticipantAuthorizationState | null,
): AuthorizedParticipantAccess | null {
  if (state === null) return null;
  const profile = record(state.profile);
  if (profile === null) return null;
  const subject = parseActorSubject(profile.subject);
  if (!subject.ok || subject.value !== account.subject) return null;
  if (!validDisplayName(profile.displayName)) return null;
  if (!isDeclaredInterest(profile.declaredInterest)) return null;
  if (!isParticipationContext(profile.participationContext)) return null;
  if (typeof profile.accountDeletionRequested !== "boolean") return null;

  const currentPackage = parseCurrentPackage(state.currentPackage);
  if (state.currentPackage !== null && currentPackage === null) return null;

  return Object.freeze({
    subject: account.subject,
    email: account.accountEmailLabel,
    displayName: profile.displayName,
    declaredInterest: profile.declaredInterest,
    participationContext: profile.participationContext,
    accountStatus: profile.accountDeletionRequested
      ? "deletion-requested"
      : "active",
    currentPackage,
  });
}

/** Parses only the bounded projection transferred to the server renderer. */
export function parseAuthorizedParticipantAccess(
  value: unknown,
): AuthorizedParticipantAccess | null {
  const source = record(value);
  if (source === null) return null;

  const account = parseParticipantAccount({
    subject: source.subject,
    accountEmailLabel: source.email,
  });
  if (!account.ok) return null;
  if (!validDisplayName(source.displayName)) return null;
  if (!isDeclaredInterest(source.declaredInterest)) return null;
  if (!isParticipationContext(source.participationContext)) return null;
  if (
    source.accountStatus !== "active" &&
    source.accountStatus !== "deletion-requested"
  ) {
    return null;
  }

  const currentPackage = parseCurrentPackage(source.currentPackage);
  if (source.currentPackage !== null && currentPackage === null) return null;

  return Object.freeze({
    subject: account.value.subject,
    email: account.value.accountEmailLabel,
    displayName: source.displayName,
    declaredInterest: source.declaredInterest,
    participationContext: source.participationContext,
    accountStatus: source.accountStatus,
    currentPackage,
  });
}

export function createParticipantHomeDocument(
  requestUrl: string,
  participant: AuthorizedParticipantAccess,
  campaignName: string | null,
  capabilities: ParticipantHomeCapabilities = {},
): ParticipantHomeDocument {
  const absolute = (href: string) => new URL(href, requestUrl).href;
  const currentPackage = participant.currentPackage;
  const { founderInterest, investmentInterests } = participantWorkflowAccess(
    participant,
    capabilities,
  );

  return {
    api_version: INVESTOR_APP_API_VERSION,
    type: "participant-home",
    id: "participant",
    data: {
      display_name: participant.displayName,
      account_email: participant.email,
      declared_interest: participant.declaredInterest,
      participation_context: participant.participationContext,
      account_status: participant.accountStatus,
      campaign_name: campaignName,
      current_package: currentPackage === null
        ? null
        : {
            version_id: currentPackage.id,
            created_at: currentPackage.createdAt,
            change_summary: currentPackage.changeSummary,
            material_change: currentPackage.materialChange,
            acceptance_required: currentPackage.requiresCurrentAcceptance,
          },
    },
    links: [
      { rel: ["self", "participant-home"], href: absolute(PARTICIPANT_HOME_PATH) },
      { rel: ["campaign"], href: absolute("/") },
      ...(currentPackage === null
        ? []
        : [{ rel: ["private-package"], href: absolute(PRIVATE_PACKAGE_PATH) }]),
      ...(founderInterest
        ? [{ rel: ["founder-interest"], href: absolute(FOUNDER_INTEREST_PATH) }]
        : []),
      ...(investmentInterests
        ? [{
          rel: ["investment-interests"],
          href: absolute(INVESTMENT_INTEREST_PATH),
        }]
        : []),
    ],
    actions: [
      ...(currentPackage === null
        ? []
        : [safeAction(
            "read-private-package",
            "Read information package",
            absolute(PRIVATE_PACKAGE_PATH),
          )]),
      ...(capabilities.manageCampaign
        ? [safeAction(
            "manage-campaign",
            "Manage campaign",
            absolute("/owner"),
          )]
        : []),
      ...(founderInterest
        ? [safeAction(
            "open-founder-interest",
            "Founder interest",
            absolute(FOUNDER_INTEREST_PATH),
          )]
        : []),
      ...(investmentInterests
        ? [safeAction(
            "open-investment-interests",
            "Investment interests",
            absolute(INVESTMENT_INTEREST_PATH),
          )]
        : []),
      safeAction(
        "sign-out",
        "Sign out",
        absolute(chatGPTSignOutPath("/")),
      ),
    ],
  };
}

export function createPrivatePackageDocument(
  requestUrl: string,
  participant: AuthorizedParticipantAccess,
  capabilities: ParticipantHomeCapabilities = {},
): PrivatePackageDocument | null {
  const currentPackage = participant.currentPackage;
  if (currentPackage === null) return null;
  const absolute = (href: string) => new URL(href, requestUrl).href;
  const { founderInterest, investmentInterests } = participantWorkflowAccess(
    participant,
    capabilities,
  );

  return {
    api_version: INVESTOR_APP_API_VERSION,
    type: "private-package",
    id: currentPackage.id,
    data: {
      created_at: currentPackage.createdAt,
      change_summary: currentPackage.changeSummary,
      material_change: currentPackage.materialChange,
      acceptance_required: currentPackage.requiresCurrentAcceptance,
    },
    links: [
      { rel: ["self", "private-package"], href: absolute(PRIVATE_PACKAGE_PATH) },
      { rel: ["participant-home"], href: absolute(PARTICIPANT_HOME_PATH) },
      { rel: ["campaign"], href: absolute("/") },
      ...(founderInterest
        ? [{ rel: ["founder-interest"], href: absolute(FOUNDER_INTEREST_PATH) }]
        : []),
      ...(investmentInterests
        ? [{
          rel: ["investment-interests"],
          href: absolute(INVESTMENT_INTEREST_PATH),
        }]
        : []),
    ],
    actions: [
      safeAction(
        "open-participant-home",
        "View your participation",
        absolute(PARTICIPANT_HOME_PATH),
      ),
      ...(capabilities.manageCampaign
        ? [safeAction(
            "manage-campaign",
            "Manage campaign",
            absolute("/owner"),
          )]
        : []),
      ...(founderInterest
        ? [safeAction(
            "open-founder-interest",
            "Founder interest",
            absolute(FOUNDER_INTEREST_PATH),
          )]
        : []),
      ...(investmentInterests
        ? [safeAction(
            "open-investment-interests",
            "Investment interests",
            absolute(INVESTMENT_INTEREST_PATH),
          )]
        : []),
      safeAction(
        "sign-out",
        "Sign out",
        absolute(chatGPTSignOutPath("/")),
      ),
    ],
  };
}

export function createParticipantAuthenticationRequiredDocument(
  requestUrl: string,
  returnPath = PARTICIPANT_HOME_PATH,
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
    links: [
      { rel: ["self"], href: absolute(returnPath) },
      { rel: ["campaign"], href: absolute("/") },
    ],
    actions: [
      safeAction(
        "sign-in",
        "Sign in",
        absolute(chatGPTSignInPath(returnPath)),
      ),
    ],
  };
}

function parseCurrentPackage(
  value: unknown,
): ParticipantAuthorizationState["currentPackage"] {
  if (value === null) return null;
  const source = record(value);
  if (source === null) return null;

  const id = parseStableId<"package-version">(source.id);
  const createdAt = parseTimestamp(source.createdAt);
  if (!id.ok || !createdAt.ok) return null;
  if (!validChangeSummary(source.changeSummary)) return null;
  if (
    typeof source.materialChange !== "boolean" ||
    typeof source.requiresCurrentAcceptance !== "boolean"
  ) {
    return null;
  }

  return Object.freeze({
    id: id.value,
    createdAt: createdAt.value,
    changeSummary: source.changeSummary,
    materialChange: source.materialChange,
    requiresCurrentAcceptance: source.requiresCurrentAcceptance,
  });
}

function safeAction(name: string, title: string, href: string): HypermediaAction {
  return toHypermediaAction(defineAction({
    name,
    title,
    method: "GET",
    href,
    requestMediaType: "text/html",
    fields: [],
  }));
}

export function participantWorkflowAccess(
  participant: AuthorizedParticipantAccess,
  capabilities: ParticipantHomeCapabilities,
): Readonly<{ founderInterest: boolean; investmentInterests: boolean }> {
  const active = participant.accountStatus === "active";
  return {
    founderInterest: active && capabilities.founderInterest === true &&
      (participant.declaredInterest === "founder" ||
        participant.declaredInterest === "both"),
    investmentInterests:
      active && capabilities.investmentInterests === true &&
      (participant.declaredInterest === "investor" ||
        participant.declaredInterest === "both"),
  };
}

function validDisplayName(value: unknown): value is string {
  return boundedPlainText(value, MAX_DISPLAY_NAME_LENGTH);
}

function validChangeSummary(value: unknown): value is string {
  return boundedPlainText(value, MAX_CHANGE_SUMMARY_LENGTH);
}

function boundedPlainText(value: unknown, maximum: number): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    return false;
  }

  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point <= 31 || point === 127)) return false;
  }
  return true;
}

function isDeclaredInterest(value: unknown): value is DeclaredInterest {
  return value === "founder" || value === "investor" || value === "both";
}

function isParticipationContext(
  value: unknown,
): value is ParticipationContext {
  return value === "individual" || value === "company";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
