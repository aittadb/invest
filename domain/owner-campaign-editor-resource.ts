import type { CampaignPublicationReadiness } from "./campaign-publication-readiness.ts";
import {
  currentActions,
  defineAction,
  toHtmlFormAction,
  toHypermediaAction,
  type ActionContract,
  type ActionField,
  type HtmlFormAction,
  type HypermediaAction,
} from "./hypermedia-action.ts";
import type { PublicCampaignConfiguration } from "./public-campaign-configuration.ts";
import {
  createPublicCampaignDocument,
  INVESTOR_APP_API_VERSION,
  type HypermediaLink,
  type PublicCampaignDocument,
} from "./public-campaign-resource.ts";
import type {
  CampaignMutationConsistency,
  CampaignSetupRevision,
} from "../repositories/in-memory-campaign-repository.ts";

export const OWNER_CAMPAIGN_EDITOR_PATH = "/owner/campaign";
export const OWNER_CAMPAIGN_PUBLICATION_PATH = "/owner/campaign/publication";
export const OWNER_CAMPAIGN_PREVIEW_PATH = "/owner/campaign/preview";

export const CAMPAIGN_PRESENTATION_JSON_FIELD_NAMES = Object.freeze([
  "operation-id",
  "expected-revision",
  "public-campaign",
] as const);

export const CAMPAIGN_PUBLICATION_FIELD_NAMES = Object.freeze([
  "operation-id",
  "expected-revision",
  "publication-command",
] as const);

export type OwnerCampaignEditorDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "owner-campaign-editor";
  id: "campaign-editor";
  data: Readonly<{
    configured: boolean;
    revision: number | null;
    recorded_at: string | null;
    publication: "published" | "unpublished" | "not-configured";
    publication_readiness: CampaignPublicationReadiness | null;
    mutation_consistency: CampaignMutationConsistency;
    public_campaign: PublicCampaignConfiguration | null;
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type CampaignPresentationForm = Readonly<{
  action: string;
  operationId: string;
  expectedRevision: number;
  campaign: PublicCampaignConfiguration;
}>;

export type OwnerCampaignEditorResource = Readonly<{
  document: OwnerCampaignEditorDocument;
  presentationForm: CampaignPresentationForm | null;
  publicationForm: HtmlFormAction | null;
}>;

export type CampaignEditorOperationIds = Readonly<{
  save: string;
  publication: string;
}>;

export function createOwnerCampaignEditorResource(
  requestUrl: string,
  current: CampaignSetupRevision | null,
  readiness: CampaignPublicationReadiness | null,
  consistency: CampaignMutationConsistency,
  operationIds: CampaignEditorOperationIds,
): OwnerCampaignEditorResource {
  const absolute = (href: string) => new URL(href, requestUrl).href;
  const canMutate = current !== null && consistency === "atomic-campaign-audit";
  const save = canMutate
    ? savePresentationAction(absolute(OWNER_CAMPAIGN_EDITOR_PATH), current, operationIds.save)
    : null;
  const canChangePublication = canMutate && (
    current.setup.publicCampaign.published || readiness?.ready === true
  );
  const publication = canChangePublication
    ? publicationAction(
        absolute(OWNER_CAMPAIGN_PUBLICATION_PATH),
        current,
        operationIds.publication,
      )
    : null;
  const actions = currentActions(save, publication);

  return Object.freeze({
    document: Object.freeze({
      api_version: INVESTOR_APP_API_VERSION,
      type: "owner-campaign-editor",
      id: "campaign-editor",
      data: Object.freeze({
        configured: current !== null,
        revision: current?.revision ?? null,
        recorded_at: current?.recordedAt ?? null,
        publication: current
          ? current.setup.publicCampaign.published
            ? "published"
            : "unpublished"
          : "not-configured",
        publication_readiness: readiness,
        mutation_consistency: consistency,
        public_campaign: current?.setup.publicCampaign ?? null,
      }),
      links: Object.freeze([
        { rel: Object.freeze(["self"]), href: absolute(OWNER_CAMPAIGN_EDITOR_PATH) },
        { rel: Object.freeze(["owner"]), href: absolute("/owner") },
        { rel: Object.freeze(["campaign"]), href: absolute("/") },
        ...(current
          ? [{ rel: Object.freeze(["preview"]), href: absolute(OWNER_CAMPAIGN_PREVIEW_PATH) }]
          : []),
      ]),
      actions: Object.freeze(actions.map(toHypermediaAction)),
    }),
    presentationForm: save && current
      ? Object.freeze({
          action: absolute(OWNER_CAMPAIGN_EDITOR_PATH),
          operationId: operationIds.save,
          expectedRevision: current.revision,
          campaign: current.setup.publicCampaign,
        })
      : null,
    publicationForm: publication ? toHtmlFormAction(publication) : null,
  });
}

export type OwnerCampaignPreviewDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "owner-campaign-preview";
  id: string;
  data: Readonly<{
    source_revision: number;
    source_publication: "published" | "unpublished";
    rendered_as_published: true;
    public_campaign: PublicCampaignConfiguration;
    rendered: PublicCampaignDocument["data"];
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

/** Builds the owner preview from the exact visitor capability projection. */
export function createOwnerCampaignPreviewDocument(
  requestUrl: string,
  current: CampaignSetupRevision,
): OwnerCampaignPreviewDocument {
  const previewCampaign = Object.freeze({
    ...current.setup.publicCampaign,
    published: true as const,
  });
  const publicDocument = createPublicCampaignDocument(
    new URL("/", requestUrl).href,
    previewCampaign,
  );
  return Object.freeze({
    api_version: INVESTOR_APP_API_VERSION,
    type: "owner-campaign-preview",
    id: previewCampaign.id,
    data: Object.freeze({
      source_revision: current.revision,
      source_publication: current.setup.publicCampaign.published
        ? "published"
        : "unpublished",
      rendered_as_published: true,
      public_campaign: previewCampaign,
      rendered: publicDocument.data,
    }),
    links: Object.freeze([
      { rel: Object.freeze(["self"]), href: new URL(OWNER_CAMPAIGN_PREVIEW_PATH, requestUrl).href },
      { rel: Object.freeze(["editor"]), href: new URL(OWNER_CAMPAIGN_EDITOR_PATH, requestUrl).href },
      { rel: Object.freeze(["campaign"]), href: new URL("/", requestUrl).href },
      ...publicDocument.links.filter((link) => !link.rel.includes("self")),
    ]),
    actions: publicDocument.actions,
  });
}

function savePresentationAction(
  href: string,
  current: CampaignSetupRevision,
  operationId: string,
): ActionContract {
  return defineAction({
    name: "save-campaign-presentation",
    title: "Save campaign presentation",
    method: "POST",
    href,
    requestMediaType: "application/json",
    fields: [
      hiddenText("operation-id", "Operation ID", operationId),
      hiddenRevision(current.revision),
      {
        name: "public-campaign",
        title: "Public campaign",
        type: "json",
        shape: "object",
        location: "body",
        required: true,
        maxBytes: 16_000,
        value: current.setup.publicCampaign,
      },
    ],
  });
}

function publicationAction(
  href: string,
  current: CampaignSetupRevision,
  operationId: string,
): ActionContract {
  const command = current.setup.publicCampaign.published ? "unpublish" : "publish";
  return defineAction({
    name: `${command}-campaign`,
    title: command === "publish" ? "Publish campaign" : "Unpublish campaign",
    method: "POST",
    href,
    requestMediaType: "application/x-www-form-urlencoded",
    fields: [
      hiddenText("operation-id", "Operation ID", operationId),
      hiddenRevision(current.revision),
      hiddenText("publication-command", "Publication command", command),
    ],
  });
}

function hiddenText(name: string, title: string, value: string): ActionField {
  return {
    name,
    title,
    type: "string",
    location: "body",
    required: true,
    presentation: "hidden",
    minLength: 1,
    maxLength: 128,
    value,
  };
}

function hiddenRevision(value: number): ActionField {
  return {
    name: "expected-revision",
    title: "Expected revision",
    type: "integer",
    location: "body",
    required: true,
    presentation: "hidden",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    value,
  };
}
