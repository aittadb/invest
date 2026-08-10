import {
  parseStableId,
  parseTimestamp,
  type Timestamp,
} from "./foundation.ts";
import {
  actionWhenAllowed,
  currentActions,
  defineAction,
  toHtmlFormAction,
  toHypermediaAction,
  type ActionContract,
  type ActionField,
  type HtmlFormAction,
  type HypermediaAction,
} from "./hypermedia-action.ts";
import {
  PARTICIPANT_HOME_PATH,
  PRIVATE_PACKAGE_PATH,
} from "./participant-navigation.ts";
import {
  registerParticipantProfile,
  type ParticipantAccount,
  type ParticipantProfile,
} from "./participant-profile.ts";
import {
  INVESTOR_APP_API_VERSION,
  type HypermediaLink,
} from "./public-campaign-resource.ts";
import { parseStorageOperationId } from "./storage-adapter.ts";

export const PARTICIPANT_PROFILE_PATH = "/participant/profile";

const PROFILE_KEYS = new Set([
  "subject",
  "accountEmailLabel",
  "displayName",
  "country",
  "declaredInterest",
  "participationContext",
  "registrationNoticeEvidence",
  "processEmailNoticeAcknowledgedAt",
  "marketingConsent",
  "accountDeletionRequest",
  "registeredAt",
  "updatedAt",
]);

export type ParticipantProfileOperation =
  | "update"
  | "withdraw-marketing-consent"
  | "request-account-deletion";

export type ParticipantProfileOperationIds = Readonly<{
  update: string | null;
  withdrawMarketingConsent: string | null;
  requestAccountDeletion: string | null;
}>;

export type ParticipantProfileAcknowledgmentState = Readonly<{
  packageVersionId: string;
  requiresCurrentAcceptance: boolean;
}> | null;

export type ParticipantProfileDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "participant-profile";
  id: "current-participant-profile";
  data: Readonly<{
    revision: number;
    account_email: string;
    account_email_editable: false;
    display_name: string;
    country: string;
    declared_interest: ParticipantProfile["declaredInterest"];
    participation_context: ParticipantProfile["participationContext"];
    process_email_notice_acknowledged: true;
    process_email_notice_acknowledged_at: string;
    marketing_consent_state: ParticipantProfile["marketingConsent"]["state"];
    marketing_consent_granted_at: string | null;
    marketing_consent_withdrawn_at: string | null;
    account_deletion_state: ParticipantProfile["accountDeletionRequest"]["state"];
    account_deletion_requested_at: string | null;
    registered_at: string;
    updated_at: string;
    current_acknowledgment_status:
      | "package_unavailable"
      | "required"
      | "current";
    current_package_version_id: string | null;
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type ParticipantProfileCapabilityModel = Readonly<{
  document: ParticipantProfileDocument;
  actionContracts: readonly ActionContract[];
  forms: readonly HtmlFormAction[];
}>;

export type ParticipantProfileResourceInput = Readonly<{
  requestUrl: string;
  account: ParticipantAccount;
  revision: number;
  profile: ParticipantProfile;
  acknowledgment: ParticipantProfileAcknowledgmentState;
  operationIds: ParticipantProfileOperationIds;
}>;

/** Return only operations valid for the current profile lifecycle. */
export function participantProfileOperations(
  profile: ParticipantProfile,
): readonly ParticipantProfileOperation[] {
  const active = profile.accountDeletionRequest.state === "not-requested";
  return Object.freeze([
    ...(active ? ["update" as const] : []),
    ...(profile.marketingConsent.state === "granted"
      ? ["withdraw-marketing-consent" as const]
      : []),
    ...(active ? ["request-account-deletion" as const] : []),
  ]);
}

/** Project one trusted current profile into equivalent JSON actions and forms. */
export function createParticipantProfileCapabilityModel(
  input: ParticipantProfileResourceInput,
): ParticipantProfileCapabilityModel {
  const profile = validateParticipantProfileResourceState(
    input.account,
    input.profile,
  );
  const revision = requiredRevision(input.revision);
  const acknowledgment = requiredAcknowledgment(input.acknowledgment);
  const available = new Set(participantProfileOperations(profile));
  const self = new URL(PARTICIPANT_PROFILE_PATH, input.requestUrl).href;

  const actions = currentActions(
    actionWhenAllowed(available.has("update"), () =>
      defineAction({
        name: "update-participant-profile",
        title: "Save profile",
        method: "PATCH",
        href: self,
        requestMediaType: "application/x-www-form-urlencoded",
        fields: [
          operationIdField(requiredOperationId(input.operationIds.update)),
          expectedRevisionField(revision),
          ...editableProfileFields(profile),
        ],
      })),
    actionWhenAllowed(available.has("withdraw-marketing-consent"), () =>
      defineAction({
        name: "withdraw-marketing-consent",
        title: "Withdraw marketing consent",
        method: "DELETE",
        href: self,
        requestMediaType: "application/x-www-form-urlencoded",
        fields: [
          operationIdField(
            requiredOperationId(input.operationIds.withdrawMarketingConsent),
          ),
          expectedRevisionField(revision),
          {
            name: "confirm-marketing-consent-withdrawal",
            title: "I want to withdraw optional marketing consent",
            type: "boolean",
            location: "body",
            required: true,
          },
        ],
      })),
    actionWhenAllowed(available.has("request-account-deletion"), () =>
      defineAction({
        name: "request-account-deletion",
        title: "Request account deletion",
        method: "POST",
        href: self,
        requestMediaType: "application/x-www-form-urlencoded",
        fields: [
          operationIdField(
            requiredOperationId(input.operationIds.requestAccountDeletion),
          ),
          expectedRevisionField(revision),
          {
            name: "confirm-account-deletion-request",
            title: "I want to request account deletion",
            type: "boolean",
            location: "body",
            required: true,
          },
        ],
      })),
  );

  const actionContracts = Object.freeze([...actions]);
  const marketing = profile.marketingConsent;
  const deletion = profile.accountDeletionRequest;
  const document = Object.freeze({
    api_version: INVESTOR_APP_API_VERSION,
    type: "participant-profile" as const,
    id: "current-participant-profile" as const,
    data: Object.freeze({
      revision,
      account_email: input.account.accountEmailLabel,
      account_email_editable: false as const,
      display_name: profile.displayName,
      country: profile.country,
      declared_interest: profile.declaredInterest,
      participation_context: profile.participationContext,
      process_email_notice_acknowledged: true as const,
      process_email_notice_acknowledged_at:
        profile.processEmailNoticeAcknowledgedAt,
      marketing_consent_state: marketing.state,
      marketing_consent_granted_at: marketing.state === "granted"
        ? marketing.grantedAt
        : marketing.state === "withdrawn"
        ? marketing.grantedAt ?? null
        : null,
      marketing_consent_withdrawn_at:
        marketing.state === "withdrawn" ? marketing.withdrawnAt : null,
      account_deletion_state: deletion.state,
      account_deletion_requested_at:
        deletion.state === "requested" ? deletion.requestedAt : null,
      registered_at: profile.registeredAt,
      updated_at: profile.updatedAt,
      current_acknowledgment_status: acknowledgment === null
        ? "package_unavailable" as const
        : acknowledgment.requiresCurrentAcceptance
        ? "required" as const
        : "current" as const,
      current_package_version_id: acknowledgment?.packageVersionId ?? null,
    }),
    links: Object.freeze([
      Object.freeze({
        rel: Object.freeze(["self", "participant-profile"]),
        href: self,
      }),
      Object.freeze({
        rel: Object.freeze(["participant-home"]),
        href: new URL(PARTICIPANT_HOME_PATH, input.requestUrl).href,
      }),
      Object.freeze({
        rel: Object.freeze(["campaign"]),
        href: new URL("/", input.requestUrl).href,
      }),
      ...(acknowledgment === null
        ? []
        : [Object.freeze({
            rel: Object.freeze(["private-package"]),
            href: new URL(PRIVATE_PACKAGE_PATH, input.requestUrl).href,
          })]),
    ]),
    actions: Object.freeze(actionContracts.map(toHypermediaAction)),
  });

  return Object.freeze({
    document,
    actionContracts,
    forms: Object.freeze(actionContracts.map(toHtmlFormAction)),
  });
}

export class ParticipantProfileResourceError extends Error {
  constructor() {
    super("The participant profile resource is invalid.");
    this.name = "ParticipantProfileResourceError";
  }
}

function editableProfileFields(
  profile: ParticipantProfile,
): readonly ActionField[] {
  return [
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
      value: profile.displayName,
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
      value: profile.country,
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
      value: profile.declaredInterest,
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
      value: profile.participationContext,
    },
  ];
}

function operationIdField(value: string): ActionField {
  return {
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
    value,
  };
}

function expectedRevisionField(value: number): ActionField {
  return {
    name: "expected-revision",
    title: "Profile revision",
    type: "integer",
    location: "body",
    required: true,
    presentation: "hidden",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER - 1,
    value,
  };
}

/** Validate the complete persisted profile state before route mutation logic. */
export function validateParticipantProfileResourceState(
  account: ParticipantAccount,
  profile: ParticipantProfile,
): ParticipantProfile {
  const source = record(profile);
  if (source === null || !hasExactKeys(source, PROFILE_KEYS)) fail();
  if (
    profile.subject !== account.subject ||
    profile.accountEmailLabel !== account.accountEmailLabel
  ) {
    fail();
  }

  const registeredAt = requiredTimestamp(profile.registeredAt);
  const processAcknowledgedAt = requiredTimestamp(
    profile.processEmailNoticeAcknowledgedAt,
  );
  const updatedAt = requiredTimestamp(profile.updatedAt);
  if (processAcknowledgedAt !== registeredAt || updatedAt < registeredAt) fail();

  const marketingTimestamp = requiredMarketingState(
    profile.marketingConsent,
    registeredAt,
  );
  const deletionTimestamp = requiredDeletionState(
    profile.accountDeletionRequest,
    registeredAt,
  );
  if (updatedAt < marketingTimestamp || updatedAt < deletionTimestamp) fail();

  const registration = registerParticipantProfile(
    account,
    {
      displayName: profile.displayName,
      country: profile.country,
      declaredInterest: profile.declaredInterest,
      participationContext: profile.participationContext,
      processEmailNoticeAcknowledged: true,
      marketingConsent:
        profile.marketingConsent.state === "granted" ||
        profile.marketingConsent.state === "withdrawn" &&
          profile.marketingConsent.grantedAt !== undefined,
    },
    registeredAt,
    profile.registrationNoticeEvidence,
  );
  if (
    !registration.ok ||
    registration.value.displayName !== profile.displayName ||
    registration.value.country !== profile.country ||
    registration.value.declaredInterest !== profile.declaredInterest ||
    registration.value.participationContext !== profile.participationContext
  ) {
    fail();
  }

  return profile;
}

function requiredMarketingState(
  value: unknown,
  registeredAt: Timestamp,
): Timestamp {
  const source = record(value);
  if (source === null || typeof source.state !== "string") fail();
  if (source.state === "not-granted") {
    if (!hasExactKeys(source, new Set(["state"]))) fail();
    return registeredAt;
  }
  if (source.state === "granted") {
    if (!hasExactKeys(source, new Set(["state", "grantedAt"]))) fail();
    const grantedAt = requiredTimestamp(source.grantedAt);
    if (grantedAt !== registeredAt) fail();
    return grantedAt;
  }
  if (source.state !== "withdrawn") fail();
  const expected = source.grantedAt === undefined
    ? new Set(["state", "withdrawnAt"])
    : new Set(["state", "grantedAt", "withdrawnAt"]);
  if (!hasExactKeys(source, expected)) fail();
  const grantedAt = source.grantedAt === undefined
    ? registeredAt
    : requiredTimestamp(source.grantedAt);
  const withdrawnAt = requiredTimestamp(source.withdrawnAt);
  if (grantedAt !== registeredAt || withdrawnAt < grantedAt) fail();
  return withdrawnAt;
}

function requiredDeletionState(
  value: unknown,
  registeredAt: Timestamp,
): Timestamp {
  const source = record(value);
  if (source === null || typeof source.state !== "string") fail();
  if (source.state === "not-requested") {
    if (!hasExactKeys(source, new Set(["state"]))) fail();
    return registeredAt;
  }
  if (
    source.state !== "requested" ||
    !hasExactKeys(
      source,
      new Set(["state", "requestedAt", "activeInterestDisposition"]),
    ) ||
    source.activeInterestDisposition !== "withdraw"
  ) {
    fail();
  }
  const requestedAt = requiredTimestamp(source.requestedAt);
  if (requestedAt < registeredAt) fail();
  return requestedAt;
}

function requiredAcknowledgment(
  value: ParticipantProfileAcknowledgmentState,
): ParticipantProfileAcknowledgmentState {
  if (value === null) return null;
  const source = record(value);
  if (
    source === null ||
    !hasExactKeys(
      source,
      new Set(["packageVersionId", "requiresCurrentAcceptance"]),
    ) ||
    typeof source.requiresCurrentAcceptance !== "boolean"
  ) {
    fail();
  }
  const id = parseStableId<"package-version">(source.packageVersionId);
  if (!id.ok || id.value !== value.packageVersionId) fail();
  return Object.freeze({
    packageVersionId: id.value,
    requiresCurrentAcceptance: source.requiresCurrentAcceptance,
  });
}

function requiredOperationId(value: unknown): string {
  const parsed = parseStorageOperationId(value);
  if (!parsed.ok) fail();
  return parsed.value;
}

function requiredRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail();
  return value as number;
}

function requiredTimestamp(value: unknown): Timestamp {
  const parsed = parseTimestamp(value);
  if (!parsed.ok) fail();
  return parsed.value;
}

function hasExactKeys(
  source: Readonly<Record<string, unknown>>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(source);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function fail(): never {
  throw new ParticipantProfileResourceError();
}
