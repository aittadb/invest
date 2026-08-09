import {
  CAMPAIGN_PRESENTATION_JSON_FIELD_NAMES,
  type CampaignPresentationForm,
} from "../../domain/owner-campaign-editor-resource.ts";
import {
  parsePublicCampaignConfiguration,
  type CampaignLink,
  type PublicCampaignConfiguration,
} from "../../domain/public-campaign-configuration.ts";
import {
  StorageFailure,
  parseStorageOperationId,
} from "../../domain/storage-adapter.ts";
import { MUTATION_CSRF_FIELD, type MutationMediaType } from "../../http/mutation-security.ts";

const JSON_KEYS = new Set<string>(CAMPAIGN_PRESENTATION_JSON_FIELD_NAMES);
const MAX_NAVIGATION = 6;
const MAX_FACTS = 4;
const MAX_PARTICIPATION_PATHS = 2;
const MAX_PRODUCT_LINKS = 5;
const MAX_PRODUCT_CAPABILITIES = 8;
const MAX_PROCESS_STEPS = 8;
const MAX_RISKS = 12;
const MAX_FAQ_ITEMS = 12;
const MAX_FOOTER_LINKS = 6;

const SCALAR_FORM_KEYS = Object.freeze([
  "operation-id",
  "expected-revision",
  "campaign-id",
  "status",
  "name",
  "page-title",
  "page-description",
  "phase-label",
  "status-label",
  "brand-mark-url",
  "hero-image-url",
  "social-image-url",
  "hero-summary",
  "hero-invitation",
  "hero-primary-action-label",
  "hero-secondary-enabled",
  "hero-secondary-label",
  "hero-secondary-href",
  "hero-note",
  "participation-eyebrow",
  "participation-title",
  "product-enabled",
  "product-eyebrow",
  "product-title",
  "product-description",
  "process-enabled",
  "process-eyebrow",
  "process-title",
  "risks-eyebrow",
  "risks-title",
  "faq-enabled",
  "faq-eyebrow",
  "faq-title",
  "closing-eyebrow",
  "closing-title",
  "closing-action-label",
  "footer-tagline",
] as const);

export type ParsedCampaignPresentationMutation = Readonly<{
  operationId: string;
  expectedRevision: number;
  publicCampaign: PublicCampaignConfiguration;
}>;

export function parseCampaignPresentationMutation(
  body: Readonly<Record<string, unknown>>,
  mediaType: MutationMediaType,
): ParsedCampaignPresentationMutation {
  if (mediaType === "application/json") {
    assertExactKeys(body, JSON_KEYS);
    return Object.freeze({
      operationId: requiredOperationId(body["operation-id"]),
      expectedRevision: requiredRevision(body["expected-revision"], mediaType),
      publicCampaign: parseCampaign(body["public-campaign"]),
    });
  }

  assertFormKeys(body);
  const candidate = {
    id: requiredText(body, "campaign-id"),
    published: false,
    status: requiredText(body, "status"),
    name: requiredText(body, "name"),
    pageTitle: requiredText(body, "page-title"),
    pageDescription: requiredText(body, "page-description"),
    phaseLabel: requiredText(body, "phase-label"),
    statusLabel: requiredText(body, "status-label"),
    brandMarkUrl: optionalText(body, "brand-mark-url"),
    heroImageUrl: optionalText(body, "hero-image-url"),
    socialImageUrl: optionalText(body, "social-image-url"),
    navigation: parseRows(body, "navigation", MAX_NAVIGATION, ["label", "href"],
      ([label, href]) => ({ label, href })),
    hero: {
      summary: requiredText(body, "hero-summary"),
      invitation: requiredText(body, "hero-invitation"),
      primaryActionLabel: requiredText(body, "hero-primary-action-label"),
      secondaryAction: checked(body, "hero-secondary-enabled")
        ? {
            label: requiredText(body, "hero-secondary-label"),
            href: requiredText(body, "hero-secondary-href"),
          }
        : null,
      note: requiredText(body, "hero-note"),
    },
    facts: parseRows(body, "fact", MAX_FACTS, ["label", "value"],
      ([label, value]) => ({ label, value })),
    participation: {
      eyebrow: requiredText(body, "participation-eyebrow"),
      title: requiredText(body, "participation-title"),
      paths: parseRows(
        body,
        "participation-path",
        MAX_PARTICIPATION_PATHS,
        ["kind", "title", "description", "action-label"],
        ([kind, title, description, actionLabel]) => ({
          kind,
          title,
          description,
          actionLabel,
        }),
      ),
    },
    product: checked(body, "product-enabled")
      ? {
          eyebrow: requiredText(body, "product-eyebrow"),
          title: requiredText(body, "product-title"),
          description: requiredText(body, "product-description"),
          links: parseLinkRows(body, "product-link", MAX_PRODUCT_LINKS),
          capabilities: parseRows(
            body,
            "product-capability",
            MAX_PRODUCT_CAPABILITIES,
            ["label", "description"],
            ([label, description]) => ({ label, description }),
          ),
        }
      : null,
    process: checked(body, "process-enabled")
      ? {
          eyebrow: requiredText(body, "process-eyebrow"),
          title: requiredText(body, "process-title"),
          steps: parseRows(
            body,
            "process-step",
            MAX_PROCESS_STEPS,
            ["title", "description"],
            ([title, description]) => ({ title, description }),
          ),
        }
      : null,
    risks: {
      eyebrow: requiredText(body, "risks-eyebrow"),
      title: requiredText(body, "risks-title"),
      items: parseRows(body, "risk", MAX_RISKS, ["text"], ([text]) => text),
    },
    faq: checked(body, "faq-enabled")
      ? {
          eyebrow: requiredText(body, "faq-eyebrow"),
          title: requiredText(body, "faq-title"),
          items: parseRows(
            body,
            "faq-item",
            MAX_FAQ_ITEMS,
            ["question", "answer"],
            ([question, answer]) => ({ question, answer }),
          ),
        }
      : null,
    closing: {
      eyebrow: requiredText(body, "closing-eyebrow"),
      title: requiredText(body, "closing-title"),
      actionLabel: requiredText(body, "closing-action-label"),
    },
    footer: {
      tagline: requiredText(body, "footer-tagline"),
      links: parseLinkRows(body, "footer-link", MAX_FOOTER_LINKS),
    },
  };

  return Object.freeze({
    operationId: requiredOperationId(body["operation-id"]),
    expectedRevision: requiredRevision(body["expected-revision"], mediaType),
    publicCampaign: parseCampaign(candidate),
  });
}

export function renderCampaignPresentationForm(
  form: CampaignPresentationForm,
  csrf: string,
): string {
  const campaign = form.campaign;
  return `<form class="owner-campaign-form" action="${attribute(form.action)}" method="post"><input type="hidden" name="${MUTATION_CSRF_FIELD}" value="${attribute(csrf)}"><input type="hidden" name="operation-id" value="${attribute(form.operationId)}"><input type="hidden" name="expected-revision" value="${form.expectedRevision}">${section("Campaign", "The name, browser details, and current registration state.", `${field("campaign-id", "Campaign ID", campaign.id, 80)}${select("status", "Registration status", campaign.status, [["open", "Open"], ["closed", "Closed"]])}${field("name", "Campaign name", campaign.name, 120)}${field("page-title", "Browser page title", campaign.pageTitle, 160)}${textarea("page-description", "Page and link description", campaign.pageDescription, 320)}${field("phase-label", "Phase label", campaign.phaseLabel, 120)}${field("status-label", "Status label", campaign.statusLabel, 120)}`)}${section("Campaign media", "Optional reviewed images shown in this campaign.", `${field("brand-mark-url", "Brand mark URL", campaign.brandMarkUrl ?? "", 2000, "text", false)}${field("hero-image-url", "Hero image URL", campaign.heroImageUrl ?? "", 2000, "text", false)}${field("social-image-url", "Social image URL", campaign.socialImageUrl ?? "", 2000, "text", false)}`)}${repeatableSection("Navigation", "Links at the top of the public page.", "navigation", campaign.navigation, MAX_NAVIGATION, (item, index) => `${field(`navigation-${index}-label`, "Label", item.label, 60)}${field(`navigation-${index}-href`, "Destination", item.href, 2000)}`, blankLinkRow("navigation", ["label", "href"], ["Label", "Destination"]))}${section("Opening", "The first decision-making context visitors see.", `${textarea("hero-summary", "Summary", campaign.hero.summary, 500)}${textarea("hero-invitation", "Invitation", campaign.hero.invitation, 800)}${field("hero-primary-action-label", "Primary action label", campaign.hero.primaryActionLabel, 80)}${toggle("hero-secondary-enabled", "Show secondary action", campaign.hero.secondaryAction !== null)}${field("hero-secondary-label", "Secondary action label", campaign.hero.secondaryAction?.label ?? "", 80, "text", false)}${field("hero-secondary-href", "Secondary action destination", campaign.hero.secondaryAction?.href ?? "", 2000, "text", false)}${textarea("hero-note", "Participation notice", campaign.hero.note, 500)}`)}${repeatableSection("Campaign facts", "Short facts displayed with the opening.", "fact", campaign.facts, MAX_FACTS, (item, index) => `${field(`fact-${index}-label`, "Label", item.label, 80)}${field(`fact-${index}-value`, "Value", item.value, 120)}`, blankLinkRow("fact", ["label", "value"], ["Label", "Value"]))}${section("Participation", "The founder and investor paths presented to visitors.", `${field("participation-eyebrow", "Section label", campaign.participation.eyebrow, 80)}${field("participation-title", "Section title", campaign.participation.title, 180)}${repeatable("participation-path", campaign.participation.paths, MAX_PARTICIPATION_PATHS, (item, index) => `${select(`participation-path-${index}-kind`, "Path", item.kind, [["investor", "Investor"], ["founder", "Founder"]])}${field(`participation-path-${index}-title`, "Title", item.title, 120)}${textarea(`participation-path-${index}-description`, "Description", item.description, 500)}${field(`participation-path-${index}-action-label`, "Action label", item.actionLabel, 100)}`, `<div class="owner-campaign-row"><div class="owner-campaign-fields">${select("participation-path-__INDEX__-kind", "Path", "investor", [["investor", "Investor"], ["founder", "Founder"]])}${field("participation-path-__INDEX__-title", "Title", "", 120)}${textarea("participation-path-__INDEX__-description", "Description", "", 500)}${field("participation-path-__INDEX__-action-label", "Action label", "", 100)}</div>${removeButton()}</div>`)}`)}${optionalProduct(campaign)}${optionalProcess(campaign)}${section("Risks and boundaries", "Notices visitors should understand before registering interest.", `${field("risks-eyebrow", "Section label", campaign.risks.eyebrow, 80)}${field("risks-title", "Section title", campaign.risks.title, 180)}${repeatable("risk", campaign.risks.items, MAX_RISKS, (item, index) => textarea(`risk-${index}-text`, "Notice", item, 500), `<div class="owner-campaign-row"><div class="owner-campaign-fields">${textarea("risk-__INDEX__-text", "Notice", "", 500)}</div>${removeButton()}</div>`)}`)}${optionalFaq(campaign)}${section("Closing invitation", "The final invitation on the public page.", `${field("closing-eyebrow", "Section label", campaign.closing.eyebrow, 80)}${field("closing-title", "Section title", campaign.closing.title, 180)}${field("closing-action-label", "Action label", campaign.closing.actionLabel, 80)}`)}${section("Footer", "The closing note and supporting links.", `${textarea("footer-tagline", "Footer note", campaign.footer.tagline, 240)}${repeatable("footer-link", campaign.footer.links, MAX_FOOTER_LINKS, renderLinkRow("footer-link"), blankLinkTemplate("footer-link"))}`)}<div class="owner-campaign-form-actions"><button type="submit">Save presentation</button><a href="/owner/campaign/preview">Preview saved draft</a></div></form>`;
}

function optionalProduct(campaign: PublicCampaignConfiguration): string {
  const product = campaign.product;
  return section("Product", "Optional public product context and supporting links.", `${toggle("product-enabled", "Show product section", product !== null)}<div class="owner-campaign-optional" data-optional-section="product-enabled">${field("product-eyebrow", "Section label", product?.eyebrow ?? "", 80, "text", false)}${field("product-title", "Section title", product?.title ?? "", 180, "text", false)}${textarea("product-description", "Description", product?.description ?? "", 1000, false)}${repeatable("product-link", product?.links ?? [], MAX_PRODUCT_LINKS, renderLinkRow("product-link"), blankLinkTemplate("product-link"))}${repeatable("product-capability", product?.capabilities ?? [], MAX_PRODUCT_CAPABILITIES, (item, index) => `${field(`product-capability-${index}-label`, "Capability", item.label, 80)}${textarea(`product-capability-${index}-description`, "Description", item.description, 400)}`, `<div class="owner-campaign-row"><div class="owner-campaign-fields">${field("product-capability-__INDEX__-label", "Capability", "", 80)}${textarea("product-capability-__INDEX__-description", "Description", "", 400)}</div>${removeButton()}</div>`)}</div>`);
}

function optionalProcess(campaign: PublicCampaignConfiguration): string {
  const process = campaign.process;
  return section("Process", "Optional steps explaining what happens after registration.", `${toggle("process-enabled", "Show process section", process !== null)}<div class="owner-campaign-optional" data-optional-section="process-enabled">${field("process-eyebrow", "Section label", process?.eyebrow ?? "", 80, "text", false)}${field("process-title", "Section title", process?.title ?? "", 180, "text", false)}${repeatable("process-step", process?.steps ?? [], MAX_PROCESS_STEPS, (item, index) => `${field(`process-step-${index}-title`, "Step title", item.title, 100)}${textarea(`process-step-${index}-description`, "Description", item.description, 400)}`, `<div class="owner-campaign-row"><div class="owner-campaign-fields">${field("process-step-__INDEX__-title", "Step title", "", 100)}${textarea("process-step-__INDEX__-description", "Description", "", 400)}</div>${removeButton()}</div>`)}</div>`);
}

function optionalFaq(campaign: PublicCampaignConfiguration): string {
  const faq = campaign.faq;
  return section("Questions", "Optional answers to common campaign questions.", `${toggle("faq-enabled", "Show questions section", faq !== null)}<div class="owner-campaign-optional" data-optional-section="faq-enabled">${field("faq-eyebrow", "Section label", faq?.eyebrow ?? "", 80, "text", false)}${field("faq-title", "Section title", faq?.title ?? "", 180, "text", false)}${repeatable("faq-item", faq?.items ?? [], MAX_FAQ_ITEMS, (item, index) => `${field(`faq-item-${index}-question`, "Question", item.question, 240)}${textarea(`faq-item-${index}-answer`, "Answer", item.answer, 800)}`, `<div class="owner-campaign-row"><div class="owner-campaign-fields">${field("faq-item-__INDEX__-question", "Question", "", 240)}${textarea("faq-item-__INDEX__-answer", "Answer", "", 800)}</div>${removeButton()}</div>`)}</div>`);
}

function renderLinkRow(prefix: string) {
  return (link: CampaignLink, index: number) => `${field(`${prefix}-${index}-label`, "Label", link.label, 80)}${field(`${prefix}-${index}-href`, "Destination", link.href, 2000)}${field(`${prefix}-${index}-rel`, "Relationship tags", link.rel.join(" "), 200)}`;
}

function blankLinkTemplate(prefix: string): string {
  return `<div class="owner-campaign-row"><div class="owner-campaign-fields">${field(`${prefix}-__INDEX__-label`, "Label", "", 80)}${field(`${prefix}-__INDEX__-href`, "Destination", "", 2000)}${field(`${prefix}-__INDEX__-rel`, "Relationship tags", "alternate", 200)}</div>${removeButton()}</div>`;
}

function blankLinkRow(prefix: string, names: readonly string[], labels: readonly string[]): string {
  return `<div class="owner-campaign-row"><div class="owner-campaign-fields">${names.map((name, index) => field(`${prefix}-__INDEX__-${name}`, labels[index] ?? name, "", 2000)).join("")}</div>${removeButton()}</div>`;
}

function repeatableSection<Item>(
  title: string,
  description: string,
  prefix: string,
  items: readonly Item[],
  maximum: number,
  render: (item: Item, index: number) => string,
  template: string,
): string {
  return section(title, description, repeatable(prefix, items, maximum, render, template));
}

function repeatable<Item>(
  prefix: string,
  items: readonly Item[],
  maximum: number,
  render: (item: Item, index: number) => string,
  template: string,
): string {
  const rows = items.map((item, index) => `<div class="owner-campaign-row"><div class="owner-campaign-fields">${render(item, index)}</div>${removeButton()}</div>`).join("");
  return `<div class="owner-campaign-repeatable" data-repeatable="${attribute(prefix)}" data-maximum="${maximum}"><div data-repeatable-rows>${rows}</div><template>${template}</template><button class="owner-campaign-add" type="button" data-add-row>Add row</button></div>`;
}

function section(title: string, description: string, content: string): string {
  const id = `campaign-section-${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
  return `<section class="owner-campaign-section" aria-labelledby="${id}"><div class="owner-campaign-section-heading"><h2 id="${id}">${html(title)}</h2><p>${html(description)}</p></div><div class="owner-campaign-section-content">${content}</div></section>`;
}

function field(name: string, label: string, value: string, maxLength: number, type = "text", required = true): string {
  const id = `campaign-field-${name}`;
  return `<div class="owner-campaign-field"><label for="${attribute(id)}">${html(label)}</label><input id="${attribute(id)}" name="${attribute(name)}" type="${attribute(type)}" value="${attribute(value)}" maxlength="${maxLength}"${required ? " required" : ""}></div>`;
}

function textarea(name: string, label: string, value: string, maxLength: number, required = true): string {
  const id = `campaign-field-${name}`;
  return `<div class="owner-campaign-field owner-campaign-field-wide"><label for="${attribute(id)}">${html(label)}</label><textarea id="${attribute(id)}" name="${attribute(name)}" maxlength="${maxLength}"${required ? " required" : ""}>${html(value)}</textarea></div>`;
}

function select(name: string, label: string, value: string, choices: readonly (readonly [string, string])[]): string {
  const id = `campaign-field-${name}`;
  return `<div class="owner-campaign-field"><label for="${attribute(id)}">${html(label)}</label><select id="${attribute(id)}" name="${attribute(name)}" required>${choices.map(([choice, title]) => `<option value="${attribute(choice)}"${choice === value ? " selected" : ""}>${html(title)}</option>`).join("")}</select></div>`;
}

function toggle(name: string, label: string, checkedValue: boolean): string {
  const id = `campaign-field-${name}`;
  return `<div class="owner-campaign-toggle"><input id="${attribute(id)}" name="${attribute(name)}" type="checkbox" value="true"${checkedValue ? " checked" : ""}><label for="${attribute(id)}">${html(label)}</label></div>`;
}

function removeButton(): string {
  return `<button class="owner-campaign-remove" type="button" data-remove-row aria-label="Remove row">Remove</button>`;
}

function parseLinkRows(
  body: Readonly<Record<string, unknown>>,
  prefix: string,
  maximum: number,
): readonly CampaignLink[] {
  return parseRows(body, prefix, maximum, ["label", "href", "rel"],
    ([label, href, rel]) => ({
      label,
      href,
      rel: rel.split(/[\s,]+/u).filter(Boolean),
    }));
}

function parseRows<Value>(
  body: Readonly<Record<string, unknown>>,
  prefix: string,
  maximum: number,
  fields: readonly string[],
  create: (values: readonly string[]) => Value,
): readonly Value[] {
  const rows: Value[] = [];
  for (let index = 0; index < maximum; index += 1) {
    const values = fields.map((fieldName) => optionalText(body, `${prefix}-${index}-${fieldName}`) ?? "");
    if (values.every((value) => value === "")) continue;
    if (values.some((value) => value === "")) throw new StorageFailure("INVALID_REQUEST");
    rows.push(create(values));
  }
  return Object.freeze(rows);
}

function assertFormKeys(body: Readonly<Record<string, unknown>>): void {
  const allowed = new Set<string>(SCALAR_FORM_KEYS);
  addRowKeys(allowed, "navigation", MAX_NAVIGATION, ["label", "href"]);
  addRowKeys(allowed, "fact", MAX_FACTS, ["label", "value"]);
  addRowKeys(allowed, "participation-path", MAX_PARTICIPATION_PATHS, ["kind", "title", "description", "action-label"]);
  addRowKeys(allowed, "product-link", MAX_PRODUCT_LINKS, ["label", "href", "rel"]);
  addRowKeys(allowed, "product-capability", MAX_PRODUCT_CAPABILITIES, ["label", "description"]);
  addRowKeys(allowed, "process-step", MAX_PROCESS_STEPS, ["title", "description"]);
  addRowKeys(allowed, "risk", MAX_RISKS, ["text"]);
  addRowKeys(allowed, "faq-item", MAX_FAQ_ITEMS, ["question", "answer"]);
  addRowKeys(allowed, "footer-link", MAX_FOOTER_LINKS, ["label", "href", "rel"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new StorageFailure("INVALID_REQUEST");
  }
}

function addRowKeys(
  keys: Set<string>,
  prefix: string,
  maximum: number,
  fields: readonly string[],
): void {
  for (let index = 0; index < maximum; index += 1) {
    for (const fieldName of fields) keys.add(`${prefix}-${index}-${fieldName}`);
  }
}

function assertExactKeys(body: Readonly<Record<string, unknown>>, expected: ReadonlySet<string>): void {
  const keys = Object.keys(body);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new StorageFailure("INVALID_REQUEST");
  }
}

function requiredText(body: Readonly<Record<string, unknown>>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return value;
}

function optionalText(body: Readonly<Record<string, unknown>>, name: string): string | null {
  const value = body[name];
  if (value === undefined || value === "") return null;
  if (typeof value !== "string") throw new StorageFailure("INVALID_REQUEST");
  return value;
}

function checked(body: Readonly<Record<string, unknown>>, name: string): boolean {
  const value = body[name];
  if (value === undefined) return false;
  if (value !== "true") throw new StorageFailure("INVALID_REQUEST");
  return true;
}

function requiredRevision(value: unknown, mediaType: MutationMediaType): number {
  const parsed = mediaType === "application/x-www-form-urlencoded"
    ? typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN
    : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 1) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return parsed as number;
}

function requiredOperationId(value: unknown): string {
  const parsed = parseStorageOperationId(value);
  if (!parsed.ok) throw new StorageFailure("INVALID_REQUEST");
  return parsed.value;
}

function parseCampaign(value: unknown): PublicCampaignConfiguration {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new StorageFailure("INVALID_REQUEST", { cause: error });
  }
  const campaign = parsePublicCampaignConfiguration(serialized);
  if (campaign === null) throw new StorageFailure("INVALID_REQUEST");
  return campaign;
}

function attribute(value: string): string {
  return html(value).replaceAll("`", "&#96;");
}

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
