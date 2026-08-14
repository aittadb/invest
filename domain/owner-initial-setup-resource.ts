import {
  checkCampaignSetupPolicy,
  type CampaignSetupPolicyRequirement,
} from "./campaign-setup-policy.ts";
import type { CampaignPublicationReadiness } from "./campaign-publication-readiness.ts";
import {
  defineAction,
  toHypermediaAction,
  type ActionContract,
  type ActionJsonValue,
  type HypermediaAction,
} from "./hypermedia-action.ts";
import {
  checkPhaseSetup,
  type PhaseSetupRequirement,
} from "./phase-configuration.ts";
import {
  createPublicCampaignDocument,
  INVESTOR_APP_API_VERSION,
  type HypermediaLink,
  type PublicCampaignDocument,
} from "./public-campaign-resource.ts";
import type {
  CampaignMutationConsistency,
  CampaignSetup,
  CampaignSetupRevision,
} from "../repositories/in-memory-campaign-repository.ts";

export const OWNER_INITIAL_SETUP_PATH = "/owner/setup";
export const OWNER_INITIAL_SETUP_PREVIEW_PATH = "/owner/setup/preview";
export const OWNER_INITIAL_SETUP_MAX_BYTES = 262_144;

export const OWNER_INITIAL_SETUP_JSON_FIELD_NAMES = Object.freeze([
  "operation-id",
  "expected-revision",
  "public-campaign",
  "phases",
  "amount-aggregate",
  "campaign-policy",
] as const);

export type OwnerInitialSetupReadinessBlocker =
  | "setup-not-configured"
  | CampaignPublicationReadiness["blockers"][number];

export type OwnerInitialSetupReadiness = Readonly<{
  ready: boolean;
  blockers: readonly OwnerInitialSetupReadinessBlocker[];
  phase_requirements: readonly Readonly<{
    phase_id: string;
    missing: readonly PhaseSetupRequirement[];
  }>[];
  campaign_policy_requirements: readonly CampaignSetupPolicyRequirement[];
  deployment_ready: boolean | null;
}>;

export type OwnerInitialSetupDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "owner-initial-setup";
  id: "campaign-setup";
  data: Readonly<{
    configured: boolean;
    revision: number | null;
    recorded_at: string | null;
    publication: "published" | "unpublished" | "not-configured";
    mutation_consistency: CampaignMutationConsistency;
    readiness: OwnerInitialSetupReadiness;
    setup: CampaignSetup | null;
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type OwnerInitialSetupForm = Readonly<{
  action: string;
  operationId: string;
  expectedRevision: number | null;
  setup: CampaignSetup | null;
}>;

export type OwnerInitialSetupResource = Readonly<{
  document: OwnerInitialSetupDocument;
  form: OwnerInitialSetupForm | null;
}>;

/** Builds the common owner capability projected as HTML or hypermedia JSON. */
export function createOwnerInitialSetupResource(
  requestUrl: string,
  current: CampaignSetupRevision | null,
  publicationReadiness: CampaignPublicationReadiness | null,
  consistency: CampaignMutationConsistency,
  operationId: string,
): OwnerInitialSetupResource {
  const absolute = (href: string) => new URL(href, requestUrl).href;
  const readiness = createOwnerInitialSetupReadiness(
    current,
    publicationReadiness,
  );
  const save = consistency === "atomic-campaign-audit"
    ? saveSetupAction(
        absolute(OWNER_INITIAL_SETUP_PATH),
        current,
        operationId,
      )
    : null;

  return deepFreeze({
    document: {
      api_version: INVESTOR_APP_API_VERSION,
      type: "owner-initial-setup",
      id: "campaign-setup",
      data: {
        configured: current !== null,
        revision: current?.revision ?? null,
        recorded_at: current?.recordedAt ?? null,
        publication: current === null
          ? "not-configured"
          : current.setup.publicCampaign.published
            ? "published"
            : "unpublished",
        mutation_consistency: consistency,
        readiness,
        setup: current?.setup ?? null,
      },
      links: [
        { rel: ["self"], href: absolute(OWNER_INITIAL_SETUP_PATH) },
        { rel: ["owner"], href: absolute("/owner") },
        { rel: ["campaign"], href: absolute("/") },
        ...(current === null
          ? []
          : [{
              rel: ["preview"],
              href: absolute(OWNER_INITIAL_SETUP_PREVIEW_PATH),
            }]),
      ],
      actions: save === null ? [] : [toHypermediaAction(save)],
    },
    form: save === null
      ? null
      : {
          action: absolute(OWNER_INITIAL_SETUP_PATH),
          operationId,
          expectedRevision: current?.revision ?? null,
          setup: current?.setup ?? null,
        },
  });
}

export function createOwnerInitialSetupReadiness(
  current: CampaignSetupRevision | null,
  readiness: CampaignPublicationReadiness | null,
): OwnerInitialSetupReadiness {
  if (current === null) {
    return deepFreeze({
      ready: false,
      blockers: ["setup-not-configured"],
      phase_requirements: [],
      campaign_policy_requirements: [],
      deployment_ready: null,
    });
  }
  if (readiness === null) {
    throw new TypeError("Configured setup requires a readiness result.");
  }

  const phaseRequirements = current.setup.phases.flatMap((phase) => {
    const status = checkPhaseSetup(phase);
    return status.complete
      ? []
      : [{ phase_id: phase.id, missing: status.missing }];
  });
  const policy = checkCampaignSetupPolicy(
    current.setup.campaignPolicy,
    current.setup.phases,
  );

  return deepFreeze({
    ready: readiness.ready,
    blockers: readiness.blockers,
    phase_requirements: phaseRequirements,
    campaign_policy_requirements: policy.missing,
    deployment_ready: !readiness.blockers.includes("deployment-not-ready"),
  });
}

export type OwnerInitialSetupPreviewDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "owner-initial-setup-preview";
  id: string;
  data: Readonly<{
    source_revision: number;
    source_publication: "published" | "unpublished";
    rendered_as_published: true;
    readiness: OwnerInitialSetupReadiness;
    public_campaign: CampaignSetup["publicCampaign"];
    rendered: PublicCampaignDocument["data"];
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

/** Derives preview output from the same visitor document without saving it. */
export function createOwnerInitialSetupPreviewDocument(
  requestUrl: string,
  current: CampaignSetupRevision,
  publicationReadiness: CampaignPublicationReadiness,
): OwnerInitialSetupPreviewDocument {
  const publicCampaign = Object.freeze({
    ...current.setup.publicCampaign,
    published: true as const,
  });
  const visitor = createPublicCampaignDocument(
    new URL("/", requestUrl).href,
    publicCampaign,
  );

  return deepFreeze({
    api_version: INVESTOR_APP_API_VERSION,
    type: "owner-initial-setup-preview",
    id: publicCampaign.id,
    data: {
      source_revision: current.revision,
      source_publication: current.setup.publicCampaign.published
        ? "published"
        : "unpublished",
      rendered_as_published: true,
      readiness: createOwnerInitialSetupReadiness(
        current,
        publicationReadiness,
      ),
      public_campaign: publicCampaign,
      rendered: visitor.data,
    },
    links: [
      {
        rel: ["self"],
        href: new URL(OWNER_INITIAL_SETUP_PREVIEW_PATH, requestUrl).href,
      },
      {
        rel: ["setup"],
        href: new URL(OWNER_INITIAL_SETUP_PATH, requestUrl).href,
      },
      { rel: ["campaign"], href: new URL("/", requestUrl).href },
      ...visitor.links.filter((link) => !link.rel.includes("self")),
    ],
    actions: visitor.actions,
  });
}

function saveSetupAction(
  href: string,
  current: CampaignSetupRevision | null,
  operationId: string,
): ActionContract {
  const setup = current?.setup;
  return defineAction({
    name: current === null ? "create-campaign-setup" : "revise-campaign-setup",
    title: current === null ? "Create campaign setup" : "Save campaign setup",
    method: "POST",
    href,
    requestMediaType: "application/json",
    fields: [
      {
        name: "operation-id",
        title: "Operation ID",
        type: "string",
        location: "body",
        required: true,
        presentation: "hidden",
        minLength: 1,
        maxLength: 128,
        maxBytes: 128,
        value: operationId,
      },
      current === null
        ? {
            name: "expected-revision",
            title: "Expected revision",
            type: "json",
            shape: "any",
            location: "body",
            required: true,
            maxBytes: 4,
            value: null,
          }
        : {
            name: "expected-revision",
            title: "Expected revision",
            type: "integer",
            location: "body",
            required: true,
            minimum: 1,
            maximum: Number.MAX_SAFE_INTEGER,
            value: current.revision,
          },
      jsonField("public-campaign", "Public campaign", "object", OWNER_INITIAL_SETUP_MAX_BYTES,
        setup?.publicCampaign),
      jsonField("phases", "Campaign phases", "array", OWNER_INITIAL_SETUP_MAX_BYTES,
        setup?.phases),
      jsonField("amount-aggregate", "Amount and aggregate rules", "object", OWNER_INITIAL_SETUP_MAX_BYTES,
        setup?.amountAggregate),
      jsonField("campaign-policy", "Campaign policy", "object", OWNER_INITIAL_SETUP_MAX_BYTES,
        setup?.campaignPolicy),
    ],
  });
}

function jsonField(
  name: string,
  title: string,
  shape: "object" | "array",
  maxBytes: number,
  value: unknown,
) {
  return {
    name,
    title,
    type: "json" as const,
    shape,
    location: "body" as const,
    required: true,
    maxBytes,
    ...(value === undefined
      ? {}
      : { value: value as ActionJsonValue }),
  };
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
