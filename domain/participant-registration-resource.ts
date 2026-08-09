import {
  currentActions,
  defineAction,
  toHtmlFormAction,
  toHypermediaAction,
  type ActionContract,
  type ActionField,
  type HtmlFormAction,
} from "./hypermedia-action.ts";
import type { CampaignSetupPolicy } from "./campaign-setup-policy.ts";
import {
  PARTICIPANT_HOME_PATH,
  PRIVATE_PACKAGE_PATH,
} from "./participant-navigation.ts";
import type {
  MarketingConsent,
  ParticipantAccount,
  ParticipantProfile,
} from "./participant-profile.ts";
import {
  INVESTOR_APP_API_VERSION,
  type HypermediaAction,
  type HypermediaLink,
} from "./public-campaign-resource.ts";
import { parseStorageOperationId } from "./storage-adapter.ts";

export const PARTICIPANT_REGISTRATION_PATH = "/participant/registration";

const MAX_NOTICE_LENGTH = 4_000;

export type ParticipantRegistrationNotices = Readonly<{
  processEmail: string;
  marketing: string;
}>;

export type ParticipantRegistrationDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "participant-access-registration";
  id: "access-registration";
  data: Readonly<{
    status: "registration_required" | "registered";
    account_email: string;
    account_email_editable: false;
    display_name: string | null;
    country: string | null;
    declared_interest: ParticipantProfile["declaredInterest"] | null;
    participation_context: ParticipantProfile["participationContext"] | null;
    process_email_notice: string;
    process_email_notice_acknowledged: boolean;
    marketing_notice: string;
    marketing_consent_state: MarketingConsent["state"];
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type ParticipantRegistrationCapabilityModel = Readonly<{
  document: ParticipantRegistrationDocument;
  actionContracts: readonly ActionContract[];
  forms: readonly HtmlFormAction[];
}>;

export type ParticipantRegistrationResourceInput = Readonly<{
  requestUrl: string;
  account: ParticipantAccount;
  profile: ParticipantProfile | null;
  notices: ParticipantRegistrationNotices;
  operationId: string | null;
}>;

/** Validate and freeze deployment-supplied notice text without adding defaults. */
export function defineParticipantRegistrationNotices(
  value: ParticipantRegistrationNotices,
): ParticipantRegistrationNotices {
  return Object.freeze({
    processEmail: requiredNotice(value?.processEmail),
    marketing: requiredNotice(value?.marketing),
  });
}

/** Map the validated private campaign policy into the registration view. */
export function participantRegistrationNoticesFromCampaignPolicy(
  policy: CampaignSetupPolicy,
): ParticipantRegistrationNotices {
  const notices = policy?.notices;
  if (notices === undefined) throw new ParticipantRegistrationResourceError();
  return defineParticipantRegistrationNotices({
    processEmail: notices.processEmail,
    marketing: notices.marketingConsent,
  });
}

/** Project one trusted account into equivalent hypermedia and HTML capabilities. */
export function createParticipantRegistrationCapabilityModel(
  input: ParticipantRegistrationResourceInput,
): ParticipantRegistrationCapabilityModel {
  const notices = defineParticipantRegistrationNotices(input.notices);
  const self = new URL(PARTICIPANT_REGISTRATION_PATH, input.requestUrl).href;
  const profile = input.profile;
  if (
    profile !== null &&
    (profile.subject !== input.account.subject ||
      profile.accountEmailLabel !== input.account.accountEmailLabel)
  ) {
    throw new ParticipantRegistrationResourceError();
  }
  const actions = currentActions(
    profile === null
      ? defineAction({
          name: "register-participant-access",
          title: "Complete registration",
          method: "POST",
          href: self,
          requestMediaType: "application/x-www-form-urlencoded",
          fields: registrationFields(requiredOperationId(input.operationId)),
        })
      : null,
  );
  const links: HypermediaLink[] = [
    Object.freeze({ rel: Object.freeze(["self"]), href: self }),
    Object.freeze({
      rel: Object.freeze(["campaign"]),
      href: new URL("/", input.requestUrl).href,
    }),
    ...(profile === null
      ? []
      : [
          Object.freeze({
            rel: Object.freeze(["participant"]),
            href: new URL(PARTICIPANT_HOME_PATH, input.requestUrl).href,
          }),
          Object.freeze({
            rel: Object.freeze(["private-package"]),
            href: new URL(PRIVATE_PACKAGE_PATH, input.requestUrl).href,
          }),
        ]),
  ];
  const actionContracts = Object.freeze([...actions]);
  const document = Object.freeze({
    api_version: INVESTOR_APP_API_VERSION,
    type: "participant-access-registration" as const,
    id: "access-registration" as const,
    data: Object.freeze({
      status: profile === null
        ? "registration_required" as const
        : "registered" as const,
      account_email: input.account.accountEmailLabel,
      account_email_editable: false as const,
      display_name: profile?.displayName ?? null,
      country: profile?.country ?? null,
      declared_interest: profile?.declaredInterest ?? null,
      participation_context: profile?.participationContext ?? null,
      process_email_notice: notices.processEmail,
      process_email_notice_acknowledged: profile !== null,
      marketing_notice: notices.marketing,
      marketing_consent_state: profile?.marketingConsent.state ?? "not-granted",
    }),
    links: Object.freeze(links),
    actions: Object.freeze(actionContracts.map(toHypermediaAction)),
  });

  return Object.freeze({
    document,
    actionContracts,
    forms: Object.freeze(actionContracts.map(toHtmlFormAction)),
  });
}

export class ParticipantRegistrationResourceError extends Error {
  constructor() {
    super("The participant registration resource is invalid.");
    this.name = "ParticipantRegistrationResourceError";
  }
}

function registrationFields(operationId: string): readonly ActionField[] {
  return [
    {
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
      value: operationId,
    },
    {
      name: "display-name",
      title: "Display name",
      type: "string",
      format: "text",
      location: "body",
      required: true,
      minLength: 1,
      maxLength: 120,
      maxBytes: 480,
    },
    {
      name: "country",
      title: "Country code",
      type: "string",
      format: "text",
      location: "body",
      required: true,
      minLength: 2,
      maxLength: 2,
      maxBytes: 2,
    },
    {
      name: "declared-interest",
      title: "I am interested as",
      type: "choice",
      location: "body",
      required: true,
      choices: [
        { value: "founder", title: "Founder" },
        { value: "investor", title: "Investor" },
        { value: "both", title: "Founder and investor" },
      ],
    },
    {
      name: "participation-context",
      title: "Participation context",
      type: "choice",
      location: "body",
      required: true,
      choices: [
        { value: "individual", title: "Individual" },
        { value: "company", title: "Company" },
      ],
    },
    {
      name: "process-email-notice-acknowledged",
      title: "I acknowledge the required process notice",
      type: "boolean",
      location: "body",
      required: true,
    },
    {
      name: "marketing-consent",
      title: "I independently consent to optional marketing messages",
      type: "boolean",
      location: "body",
      required: false,
      defaultValue: false,
    },
  ];
}

function requiredOperationId(value: unknown): string {
  const parsed = parseStorageOperationId(value);
  if (!parsed.ok) throw new ParticipantRegistrationResourceError();
  return parsed.value;
}

function requiredNotice(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_NOTICE_LENGTH ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    throw new ParticipantRegistrationResourceError();
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}
