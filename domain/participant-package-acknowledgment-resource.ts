import {
  PACKAGE_CONTENT_LIMITS,
  requiresRenewedAcceptance,
  type PackageAcceptanceRecord,
  type PackageVersion,
} from "./package-content.ts";
import {
  parseActorSubject,
  parseStableId,
  parseTimestamp,
  type ActorSubject,
} from "./foundation.ts";
import {
  currentActions,
  defineAction,
  toHtmlFormAction,
  toHypermediaAction,
  type ActionContract,
  type HtmlFormAction,
  type HypermediaAction,
} from "./hypermedia-action.ts";
import {
  PARTICIPANT_HOME_PATH,
  PRIVATE_PACKAGE_PATH,
} from "./participant-navigation.ts";
import {
  INVESTOR_APP_API_VERSION,
  type HypermediaLink,
} from "./public-campaign-resource.ts";
import { parseStorageOperationId } from "./storage-adapter.ts";

export const PARTICIPANT_PACKAGE_ACKNOWLEDGMENT_PATH =
  `${PRIVATE_PACKAGE_PATH}/acknowledgment`;

export type ParticipantPackageAcknowledgmentState = Readonly<{
  participantSubject: ActorSubject;
  currentVersion: PackageVersion;
  latestAcceptance: PackageAcceptanceRecord | null;
  acceptanceRequired: boolean;
}>;

export type ParticipantPackageAcknowledgmentDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "participant-package-acknowledgment";
  id: "current-package-acknowledgment";
  data: Readonly<{
    status: "acceptance_required" | "satisfied";
    acknowledgment_text: string;
    current_package: Readonly<{
      version_id: string;
      created_at: string;
      change_summary: string;
      material_change: boolean;
    }>;
    latest_acceptance: Readonly<{
      evidence_id: string;
      accepted_at: string;
      accepted_version_id: string;
      satisfies_current_requirement: boolean;
    }> | null;
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type ParticipantPackageAcknowledgmentCapabilityModel = Readonly<{
  document: ParticipantPackageAcknowledgmentDocument;
  actionContracts: readonly ActionContract[];
  forms: readonly HtmlFormAction[];
}>;

export type ParticipantPackageAcknowledgmentResourceInput = Readonly<{
  requestUrl: string;
  state: ParticipantPackageAcknowledgmentState;
  operationId: string | null;
}>;

/** Validate repository evidence before it can influence a participant resource. */
export function defineParticipantPackageAcknowledgmentState(
  participantSubject: ActorSubject,
  currentVersion: PackageVersion,
  latestAcceptance: PackageAcceptanceRecord | null,
): ParticipantPackageAcknowledgmentState {
  const subject = parseActorSubject(participantSubject);
  if (!subject.ok) fail();
  requirePackageVersion(currentVersion);
  if (latestAcceptance !== null) {
    requireAcceptance(latestAcceptance, subject.value);
  }

  return Object.freeze({
    participantSubject: subject.value,
    currentVersion,
    latestAcceptance,
    acceptanceRequired: requiresRenewedAcceptance(
      currentVersion,
      latestAcceptance,
    ),
  });
}

/** Project one trusted current requirement into equivalent HTML and JSON actions. */
export function createParticipantPackageAcknowledgmentCapabilityModel(
  input: ParticipantPackageAcknowledgmentResourceInput,
): ParticipantPackageAcknowledgmentCapabilityModel {
  const state = defineParticipantPackageAcknowledgmentState(
    input.state.participantSubject,
    input.state.currentVersion,
    input.state.latestAcceptance,
  );
  if (state.acceptanceRequired !== input.state.acceptanceRequired) fail();

  const self = canonicalUrl(
    PARTICIPANT_PACKAGE_ACKNOWLEDGMENT_PATH,
    input.requestUrl,
  );
  const operationId = state.acceptanceRequired
    ? requiredOperationId(input.operationId)
    : null;
  if (!state.acceptanceRequired && input.operationId !== null) fail();

  const actionContracts = currentActions(
    operationId === null
      ? null
      : defineAction({
          name: "acknowledge-current-package",
          title: "Acknowledge current package",
          method: "POST",
          href: self,
          requestMediaType: "application/x-www-form-urlencoded",
          fields: [{
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
          }],
        }),
  );
  const latestAcceptance = state.latestAcceptance;
  const document: ParticipantPackageAcknowledgmentDocument = Object.freeze({
    api_version: INVESTOR_APP_API_VERSION,
    type: "participant-package-acknowledgment",
    id: "current-package-acknowledgment",
    data: Object.freeze({
      status: state.acceptanceRequired
        ? "acceptance_required"
        : "satisfied",
      acknowledgment_text: state.currentVersion.acknowledgmentText,
      current_package: Object.freeze({
        version_id: state.currentVersion.id,
        created_at: state.currentVersion.createdAt,
        change_summary: state.currentVersion.changeSummary,
        material_change: state.currentVersion.materialChange,
      }),
      latest_acceptance: latestAcceptance === null
        ? null
        : Object.freeze({
            evidence_id: latestAcceptance.id,
            accepted_at: latestAcceptance.acceptedAt,
            accepted_version_id: latestAcceptance.acceptedVersionId,
            satisfies_current_requirement: !state.acceptanceRequired,
          }),
    }),
    links: Object.freeze([
      Object.freeze({
        rel: Object.freeze(["self", "current-package-acknowledgment"]),
        href: self,
      }),
      Object.freeze({
        rel: Object.freeze(["private-package"]),
        href: canonicalUrl(PRIVATE_PACKAGE_PATH, input.requestUrl),
      }),
      Object.freeze({
        rel: Object.freeze(["participant-home"]),
        href: canonicalUrl(PARTICIPANT_HOME_PATH, input.requestUrl),
      }),
    ]),
    actions: Object.freeze(actionContracts.map(toHypermediaAction)),
  });

  return Object.freeze({
    document,
    actionContracts,
    forms: Object.freeze(actionContracts.map(toHtmlFormAction)),
  });
}

export class ParticipantPackageAcknowledgmentResourceError extends Error {
  constructor() {
    super("The participant package acknowledgment resource is invalid.");
    this.name = "ParticipantPackageAcknowledgmentResourceError";
  }
}

function requirePackageVersion(value: unknown): asserts value is PackageVersion {
  const source = record(value);
  const id = parseStableId<"package-version">(source?.id);
  const createdAt = parseTimestamp(source?.createdAt);
  if (
    source === null ||
    !id.ok ||
    !createdAt.ok ||
    !boundedText(
      source.changeSummary,
      PACKAGE_CONTENT_LIMITS.changeSummaryLength,
      true,
    ) ||
    typeof source.materialChange !== "boolean" ||
    !boundedText(
      source.acknowledgmentText,
      PACKAGE_CONTENT_LIMITS.acknowledgmentLength,
      true,
    ) ||
    !packageHash(source.contentHash) ||
    !packageHash(source.requiredAcceptanceHash) ||
    !Array.isArray(source.sections) ||
    source.sections.length > PACKAGE_CONTENT_LIMITS.sections
  ) {
    fail();
  }
}

function requireAcceptance(
  value: unknown,
  participantSubject: ActorSubject,
): asserts value is PackageAcceptanceRecord {
  const source = record(value);
  const id = parseStableId<"package-acceptance">(source?.id);
  const subject = parseActorSubject(source?.participantSubject);
  const acceptedAt = parseTimestamp(source?.acceptedAt);
  const acceptedVersionId = parseStableId<"package-version">(
    source?.acceptedVersionId,
  );
  if (
    source === null ||
    !id.ok ||
    !subject.ok ||
    subject.value !== participantSubject ||
    !acceptedAt.ok ||
    !acceptedVersionId.ok ||
    !packageHash(source.acceptedContentHash) ||
    !packageHash(source.satisfiedRequirementHash)
  ) {
    fail();
  }
}

function requiredOperationId(value: unknown): string {
  const parsed = parseStorageOperationId(value);
  if (!parsed.ok) fail();
  return parsed.value;
}

function canonicalUrl(path: string, requestUrl: string): string {
  try {
    return new URL(path, requestUrl).href;
  } catch {
    fail();
  }
}

function boundedText(
  value: unknown,
  maximum: number,
  allowLayout: boolean,
): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    return false;
  }
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point === undefined || point > 31 && point !== 127) continue;
    if (allowLayout && (character === "\n" || character === "\t")) continue;
    return false;
  }
  return true;
}

function packageHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function fail(): never {
  throw new ParticipantPackageAcknowledgmentResourceError();
}
