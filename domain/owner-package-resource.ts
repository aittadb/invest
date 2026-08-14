import {
  PACKAGE_CONTENT_LIMITS,
  type PackageSection,
  type SafeMarkdown,
} from "./package-content.ts";
import {
  defineAction,
  toHtmlFormAction,
  toHypermediaAction,
  type ActionContract,
  type ActionField,
  type HtmlFormAction,
  type HypermediaAction,
  type TextActionField,
} from "./hypermedia-action.ts";
import {
  INVESTOR_APP_API_VERSION,
  type HypermediaLink,
} from "./public-campaign-resource.ts";
import type { StorageOperationId } from "./storage-adapter.ts";
import type {
  OwnerPackagePreview,
  OwnerPackageWorkspaceState,
} from "../services/owner-package-workspace.ts";

export type OwnerPackageControl = Readonly<{
  contract: ActionContract;
  hypermedia: HypermediaAction;
  form: HtmlFormAction;
}>;

export type OwnerPackageSectionDocument = Readonly<{
  id: string;
  order: number;
  title: string;
  markdown: SafeMarkdown;
  enabled: boolean;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type OwnerPackageDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "owner-information-package";
  id: "information-package";
  data: Readonly<{
    configured: boolean;
    revision: number;
    current_version: Readonly<{
      id: string;
      created_at: string;
      change_summary: string;
      material_change: boolean;
      acknowledgment_text: string;
    }> | null;
    sections: readonly OwnerPackageSectionDocument[];
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type OwnerPackageSectionControls = Readonly<{
  section: PackageSection;
  update: OwnerPackageControl;
  availability: OwnerPackageControl;
  reorder: OwnerPackageControl | null;
}>;

export type OwnerPackageResourceModel = Readonly<{
  document: OwnerPackageDocument;
  createSection: OwnerPackageControl | null;
  updateSettings: OwnerPackageControl | null;
  preview: OwnerPackageControl | null;
  sections: readonly OwnerPackageSectionControls[];
}>;

export type OperationIdIssuer = () => StorageOperationId;

export type OwnerPackagePreviewDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "owner-information-package-preview";
  id: string;
  data: Readonly<{
    revision: number;
    created_at: string;
    change_summary: string;
    material_change: boolean;
    acknowledgment_text: string;
    sections: readonly Readonly<{
      id: string;
      order: number;
      title: string;
      markdown: SafeMarkdown;
    }>[];
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

/** Builds the single capability model used by owner HTML and hypermedia. */
export function createOwnerPackageResourceModel(
  requestUrl: string,
  state: OwnerPackageWorkspaceState,
  issueOperationId: OperationIdIssuer,
): OwnerPackageResourceModel {
  const absolute = (href: string) => new URL(href, requestUrl).href;
  const revision = state?.revision ?? 0;
  const version = state?.version ?? null;
  const preview = version === null
    ? null
    : control({
        name: "preview-information-package",
        title: "Preview information package",
        method: "GET",
        href: absolute("/owner/package/preview"),
        requestMediaType: "text/html",
        fields: [],
      });
  const createSection = (version?.sections.length ?? 0) < PACKAGE_CONTENT_LIMITS.sections
    ? createSectionControl(
        absolute("/owner/package/sections"),
        revision,
        version?.acknowledgmentText ?? null,
        issueOperationId(),
      )
    : null;
  const updateSettings = version === null
    ? null
    : updateSettingsControl(
        absolute("/owner/package/settings"),
        revision,
        version.acknowledgmentText,
        issueOperationId(),
      );
  const sectionControls = version?.sections.map((section) => {
    const sectionPath = `/owner/package/sections/${encodeURIComponent(section.id)}`;
    const update = updateSectionControl(
      absolute(sectionPath),
      revision,
      section,
      issueOperationId(),
    );
    const availability = availabilityControl(
      absolute(`${sectionPath}/availability`),
      revision,
      section,
      issueOperationId(),
    );
    const reorder = version.sections.length < 2
      ? null
      : reorderControl(
          absolute(`${sectionPath}/order`),
          revision,
          section,
          version.sections.length,
          issueOperationId(),
        );
    return Object.freeze({ section, update, availability, reorder });
  }) ?? [];

  const sectionDocuments = sectionControls.map((item) => Object.freeze({
    id: item.section.id,
    order: item.section.order,
    title: item.section.title,
    markdown: item.section.markdown,
    enabled: item.section.enabled,
    links: Object.freeze([
      { rel: ["workspace"], href: absolute("/owner/package") },
    ]),
    actions: Object.freeze([
      item.update.hypermedia,
      item.availability.hypermedia,
      ...(item.reorder === null ? [] : [item.reorder.hypermedia]),
    ]),
  }));
  const topLevelControls = [preview, createSection, updateSettings]
    .filter((item): item is OwnerPackageControl => item !== null);

  const document: OwnerPackageDocument = Object.freeze({
    api_version: INVESTOR_APP_API_VERSION,
    type: "owner-information-package",
    id: "information-package",
    data: Object.freeze({
      configured: version !== null,
      revision,
      current_version: version === null
        ? null
        : Object.freeze({
            id: version.id,
            created_at: version.createdAt,
            change_summary: version.changeSummary,
            material_change: version.materialChange,
            acknowledgment_text: version.acknowledgmentText,
          }),
      sections: Object.freeze(sectionDocuments),
    }),
    links: Object.freeze([
      { rel: ["self"], href: absolute("/owner/package") },
      { rel: ["owner"], href: absolute("/owner") },
      ...(preview === null
        ? []
        : [{ rel: ["preview"], href: preview.contract.href }]),
    ]),
    actions: Object.freeze(
      topLevelControls.map((item) => item.hypermedia),
    ),
  });

  return Object.freeze({
    document,
    createSection,
    updateSettings,
    preview,
    sections: Object.freeze(sectionControls),
  });
}

export function createOwnerPackagePreviewDocument(
  requestUrl: string,
  preview: Exclude<OwnerPackagePreview, null>,
): OwnerPackagePreviewDocument {
  const absolute = (href: string) => new URL(href, requestUrl).href;
  const manage = control({
    name: "manage-information-package",
    title: "Manage information package",
    method: "GET",
    href: absolute("/owner/package"),
    requestMediaType: "text/html",
    fields: [],
  });

  return Object.freeze({
    api_version: INVESTOR_APP_API_VERSION,
    type: "owner-information-package-preview",
    id: preview.version.id,
    data: Object.freeze({
      revision: preview.revision,
      created_at: preview.version.createdAt,
      change_summary: preview.version.changeSummary,
      material_change: preview.version.materialChange,
      acknowledgment_text: preview.version.acknowledgmentText,
      sections: Object.freeze(preview.sections.map((section) => Object.freeze({
        id: section.id,
        order: section.order,
        title: section.title,
        markdown: section.markdown,
      }))),
    }),
    links: Object.freeze([
      { rel: ["self"], href: absolute("/owner/package/preview") },
      { rel: ["workspace"], href: absolute("/owner/package") },
      { rel: ["owner"], href: absolute("/owner") },
    ]),
    actions: Object.freeze([manage.hypermedia]),
  });
}

function createSectionControl(
  href: string,
  revision: number,
  acknowledgmentText: string | null,
  operationId: StorageOperationId,
): OwnerPackageControl {
  const acknowledgmentField: ActionField[] = acknowledgmentText === null
    ? [{
        name: "acknowledgment-text",
        title: "Acknowledgment text",
        type: "string",
        format: "multiline",
        location: "body",
        required: true,
        minLength: 1,
        maxLength: PACKAGE_CONTENT_LIMITS.acknowledgmentLength,
        maxBytes: PACKAGE_CONTENT_LIMITS.acknowledgmentLength * 4,
      }]
    : [];

  return control({
    name: "create-package-section",
    title: "Create section",
    method: "POST",
    href,
    requestMediaType: "application/x-www-form-urlencoded",
    fields: [
      textField("title", "Section title", PACKAGE_CONTENT_LIMITS.titleLength),
      {
        name: "markdown",
        title: "Markdown",
        type: "string",
        format: "multiline",
        location: "body",
        required: false,
        minLength: 0,
        maxLength: PACKAGE_CONTENT_LIMITS.markdownLength,
        maxBytes: PACKAGE_CONTENT_LIMITS.markdownLength * 4,
      },
      {
        name: "enabled",
        title: "Enabled",
        type: "boolean",
        location: "body",
        required: false,
        defaultValue: false,
      },
      ...acknowledgmentField,
      ...versionFields(operationId, revision),
    ],
  });
}

function updateSettingsControl(
  href: string,
  revision: number,
  acknowledgmentText: string,
  operationId: StorageOperationId,
): OwnerPackageControl {
  return control({
    name: "update-package-settings",
    title: "Create settings version",
    method: "PATCH",
    href,
    requestMediaType: "application/x-www-form-urlencoded",
    fields: [
      {
        name: "acknowledgment-text",
        title: "Acknowledgment text",
        type: "string",
        format: "multiline",
        location: "body",
        required: true,
        minLength: 1,
        maxLength: PACKAGE_CONTENT_LIMITS.acknowledgmentLength,
        maxBytes: PACKAGE_CONTENT_LIMITS.acknowledgmentLength * 4,
        value: acknowledgmentText,
      },
      ...versionFields(operationId, revision),
    ],
  });
}

function updateSectionControl(
  href: string,
  revision: number,
  section: PackageSection,
  operationId: StorageOperationId,
): OwnerPackageControl {
  return control({
    name: "update-package-section",
    title: "Create section version",
    method: "PATCH",
    href,
    requestMediaType: "application/x-www-form-urlencoded",
    fields: [
      {
        ...textField("title", "Section title", PACKAGE_CONTENT_LIMITS.titleLength),
        value: section.title,
      },
      {
        name: "markdown",
        title: "Markdown",
        type: "string",
        format: "multiline",
        location: "body",
        required: false,
        minLength: 0,
        maxLength: PACKAGE_CONTENT_LIMITS.markdownLength,
        maxBytes: PACKAGE_CONTENT_LIMITS.markdownLength * 4,
        value: section.markdown,
      },
      ...versionFields(operationId, revision),
    ],
  });
}

function availabilityControl(
  href: string,
  revision: number,
  section: PackageSection,
  operationId: StorageOperationId,
): OwnerPackageControl {
  return control({
    name: "set-package-section-availability",
    title: "Create availability version",
    method: "PATCH",
    href,
    requestMediaType: "application/x-www-form-urlencoded",
    fields: [
      {
        name: "enabled",
        title: "Enabled",
        type: "boolean",
        location: "body",
        required: false,
        value: section.enabled,
      },
      ...versionFields(operationId, revision),
    ],
  });
}

function reorderControl(
  href: string,
  revision: number,
  section: PackageSection,
  sectionCount: number,
  operationId: StorageOperationId,
): OwnerPackageControl {
  const choices = [
    ...(section.order > 0 ? [{ value: "up", title: "Move up" }] : []),
    ...(section.order < sectionCount - 1
      ? [{ value: "down", title: "Move down" }]
      : []),
  ];

  return control({
    name: "move-package-section",
    title: "Create order version",
    method: "PATCH",
    href,
    requestMediaType: "application/x-www-form-urlencoded",
    fields: [
      {
        name: "direction",
        title: "Direction",
        type: "choice",
        location: "body",
        required: true,
        choices,
        defaultValue: choices[0]?.value,
      },
      ...versionFields(operationId, revision),
    ],
  });
}

function versionFields(
  operationId: StorageOperationId,
  revision: number,
): readonly ActionField[] {
  return [
    {
      name: "operation-id",
      title: "Operation ID",
      type: "string",
      location: "body",
      required: true,
      minLength: 1,
      maxLength: 128,
      value: operationId,
      presentation: "hidden",
    },
    {
      name: "expected-revision",
      title: "Expected revision",
      type: "integer",
      location: "body",
      required: true,
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      value: revision,
      presentation: "hidden",
    },
    {
      name: "change-summary",
      title: "Change summary",
      type: "string",
      format: "multiline",
      location: "body",
      required: true,
      minLength: 1,
      maxLength: PACKAGE_CONTENT_LIMITS.changeSummaryLength,
      maxBytes: PACKAGE_CONTENT_LIMITS.changeSummaryLength * 4,
    },
    {
      name: "material-change",
      title: "This materially changes the package",
      type: "boolean",
      location: "body",
      required: false,
      defaultValue: false,
    },
  ];
}

function textField(
  name: string,
  title: string,
  maximum: number,
): TextActionField {
  return {
    name,
    title,
    type: "string",
    format: "text",
    location: "body",
    required: true,
    minLength: 1,
    maxLength: maximum,
    maxBytes: maximum * 4,
  };
}

function control(
  definition: Parameters<typeof defineAction>[0],
): OwnerPackageControl {
  const contract = defineAction(definition);
  return Object.freeze({
    contract,
    hypermedia: toHypermediaAction(contract),
    form: toHtmlFormAction(contract),
  });
}
