import { chatGPTSignInPath } from "../../domain/auth-navigation.ts";
import {
  assessCampaignPublicationReadiness,
  type DeploymentPublicationReadinessCheck,
} from "../../domain/campaign-publication-readiness.ts";
import {
  OWNER_INITIAL_SETUP_JSON_FIELD_NAMES,
  OWNER_INITIAL_SETUP_MAX_BYTES,
  OWNER_INITIAL_SETUP_PATH,
  OWNER_INITIAL_SETUP_PREVIEW_PATH,
  createOwnerInitialSetupPreviewDocument,
  createOwnerInitialSetupResource,
  type OwnerInitialSetupForm,
  type OwnerInitialSetupReadiness,
  type OwnerInitialSetupResource,
} from "../../domain/owner-initial-setup-resource.ts";
import { INVESTOR_APP_API_VERSION } from "../../domain/public-campaign-resource.ts";
import type {
  CampaignLink,
  PublicCampaignConfiguration,
} from "../../domain/public-campaign-configuration.ts";
import {
  StorageFailure,
  parseStorageOperationId,
} from "../../domain/storage-adapter.ts";
import { negotiateRepresentation } from "../../http/content-negotiation.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  MAX_MUTATION_BODY_BYTES,
  MutationSecurityFailure,
  toPublicMutationSecurityFailure,
  type MutationMediaType,
} from "../../http/mutation-security.ts";
import type {
  BrowserMutationProof,
  BrowserMutationSession,
} from "../../http/browser-mutation-session.ts";
import {
  parseCampaignSetup,
  type AtomicCampaignAuditRepository,
  type CampaignMutationConsistency,
  type CampaignRepository,
  type CampaignSetup,
  type CampaignSetupRevision,
} from "../../repositories/in-memory-campaign-repository.ts";
import type { ApplicationRouteHandler } from "../contracts.ts";
import {
  hypermediaResponse,
  notAcceptableResponse,
} from "./responses.ts";

type Representation = "html" | "hypermedia-json";

const JSON_KEYS = new Set<string>(OWNER_INITIAL_SETUP_JSON_FIELD_NAMES);
const MAX_NAVIGATION = 6;
const MAX_FACTS = 4;
const MAX_PARTICIPATION_PATHS = 2;
const MAX_PRODUCT_LINKS = 5;
const MAX_PRODUCT_CAPABILITIES = 8;
const MAX_PROCESS_STEPS = 8;
const MAX_RISKS = 12;
const MAX_FAQ_ITEMS = 12;
const MAX_FOOTER_LINKS = 6;
const MAX_PHASES = 32;
const MAX_COUNTRIES_PER_PHASE = 26 * 26;
const MAX_CONTRIBUTION_CHOICES = 64;
export const OWNER_INITIAL_SETUP_MAX_FIELDS = 768;
export const OWNER_INITIAL_SETUP_WIRE_MAX_BYTES = MAX_MUTATION_BODY_BYTES;

const FORM_SCALAR_KEYS = Object.freeze([
  "operation-id",
  "expected-revision",
  "published",
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
  "amount-currency",
  "amount-minimum",
  "amount-increment",
  "amount-maximum",
  "aggregate-visibility",
  "aggregate-label",
  "aggregate-qualifier",
  "notice-legal-boundary",
  "notice-non-binding-interest",
  "notice-process-email",
  "notice-marketing-consent",
  "privacy-contact-label",
  "privacy-contact-href",
  "notice-retention",
  "review-public-presentation",
  "review-legal-notices",
  "review-privacy-retention",
] as const);

export type OwnerInitialSetupRouteOptions = Readonly<{
  repository: CampaignRepository;
  checkPublicationReadiness: DeploymentPublicationReadinessCheck;
  mutationSession: BrowserMutationSession;
  appOrigin: string;
  issueOperationId?: () => string;
  now?: () => Date;
}>;

export function createOwnerInitialSetupRouteHandler(
  options: OwnerInitialSetupRouteOptions,
): ApplicationRouteHandler {
  const atomic = atomicCampaignRepository(options.repository);
  const consistency: CampaignMutationConsistency = atomic === null
    ? "unavailable"
    : "atomic-campaign-audit";
  const issueOperationId = options.issueOperationId ?? defaultOperationId;
  const now = options.now ?? (() => new Date());

  return async (context) => {
    if (!isSetupPath(context.url.pathname)) return null;
    const negotiated = negotiateRepresentation(
      context.request.headers.get("accept"),
    );
    if (negotiated.kind === "not-acceptable") {
      return notAcceptableResponse(context.resourceUrl);
    }
    const representation = negotiated.kind;

    if (context.actor === null) {
      return authenticationRequiredResponse(
        representation,
        context.resourceUrl,
        context.url.pathname,
      );
    }
    if (!context.isOwner) {
      return errorResponse(
        representation,
        context.resourceUrl,
        404,
        "not_found",
        "The requested resource was not found.",
      );
    }

    let clearCookie: string | null = null;
    try {
      if (context.url.pathname === OWNER_INITIAL_SETUP_PREVIEW_PATH) {
        if (context.request.method !== "GET") {
          return methodNotAllowed(representation, context.resourceUrl, "GET");
        }
        const current = await requiredCurrent(options.repository);
        const readiness = await assessCampaignPublicationReadiness(
          current.setup,
          options.checkPublicationReadiness,
        );
        const preview = createOwnerInitialSetupPreviewDocument(
          context.resourceUrl,
          current,
          readiness,
        );
        if (representation === "hypermedia-json") {
          return hypermediaResponse(preview);
        }
        const previewRequest = new Request(
          new URL("/", context.request.url),
          context.request,
        );
        return previewResponse(await context.renderApplication({
          request: previewRequest,
          campaign: preview.data.public_campaign,
          preview: {
            sourceRevision: preview.data.source_revision,
            sourcePublication: preview.data.source_publication,
          },
        }));
      }

      if (context.request.method !== "GET" && context.request.method !== "POST") {
        return methodNotAllowed(representation, context.resourceUrl, "GET, POST");
      }
      if (context.request.method === "POST") {
        if (atomic === null) throw new StorageFailure("UNAVAILABLE");
        const verified = await verifiedOwnerMutation(
          options.mutationSession,
          context.request,
          context.actor.userId,
          options.appOrigin,
        );
        clearCookie = requiredClearMutationCookie(verified.clearCookie);
        const mutation = parseInitialSetupMutation(
          verified.body,
          verified.mediaType,
        );
        await saveSetupMutation(
          atomic,
          mutation,
          verified.actor.subject,
          currentTimestamp(now),
        );
        if (representation === "html") {
          return withClearedMutationCookie(new Response(null, {
            status: 303,
            headers: {
              "Cache-Control": "no-store",
              Location: new URL(OWNER_INITIAL_SETUP_PATH, context.resourceUrl).href,
              Vary: "Accept",
            },
          }), clearCookie);
        }
        const response = await setupResponse(
          representation,
          context.resourceUrl,
          context.request,
          options,
          consistency,
          issueOperationId,
          context.actor.userId,
        );
        return withClearedMutationCookie(response, clearCookie);
      }

      return await setupResponse(
        representation,
        context.resourceUrl,
        context.request,
        options,
        consistency,
        issueOperationId,
        context.actor.userId,
      );
    } catch (error) {
      if (error instanceof MutationSecurityFailure) {
        const failure = toPublicMutationSecurityFailure(error);
        return withOptionalClearedMutationCookie(errorResponse(
          representation,
          context.resourceUrl,
          failure.status,
          failure.body.error.code.toLowerCase(),
          failure.body.error.message,
        ), clearCookie);
      }
      const failure = storageError(error);
      return withOptionalClearedMutationCookie(errorResponse(
        representation,
        context.resourceUrl,
        failure.status,
        failure.code,
        failure.message,
      ), clearCookie);
    }
  };
}

function isSetupPath(pathname: string): boolean {
  return pathname === OWNER_INITIAL_SETUP_PATH ||
    pathname === OWNER_INITIAL_SETUP_PREVIEW_PATH;
}

async function setupResponse(
  representation: Representation,
  requestUrl: string,
  request: Request,
  options: OwnerInitialSetupRouteOptions,
  consistency: CampaignMutationConsistency,
  issueOperationId: () => string,
  ownerSubject: string,
): Promise<Response> {
  const current = await options.repository.readSetup();
  const readiness = current === null
    ? null
    : await assessCampaignPublicationReadiness(
        current.setup,
        options.checkPublicationReadiness,
      );
  const operationId = consistency === "atomic-campaign-audit"
    ? requiredOperationId(issueOperationId())
    : "owner-setup:unavailable";
  const resource = createOwnerInitialSetupResource(
    requestUrl,
    current,
    readiness,
    consistency,
    operationId,
  );
  const proof = resource.form === null
    ? null
    : requiredMutationProof(await options.mutationSession.issue(
        request,
        { type: "owner", subject: ownerSubject },
        options.appOrigin,
      ));
  const response = representation === "hypermedia-json"
    ? hypermediaResponse(resource.document)
    : htmlResponse(renderWorkspace(resource, proof?.token ?? null));
  return proof === null ? response : withMutationProof(response, proof);
}

type ParsedInitialSetupMutation = Readonly<{
  operationId: string;
  expectedRevision: number | null;
  setup: CampaignSetup;
}>;

function parseInitialSetupMutation(
  body: Readonly<Record<string, unknown>>,
  mediaType: MutationMediaType,
): ParsedInitialSetupMutation {
  let candidate: unknown;
  if (mediaType === "application/json") {
    assertExactKeys(body, JSON_KEYS);
    candidate = {
      publicCampaign: body["public-campaign"],
      phases: body.phases,
      amountAggregate: body["amount-aggregate"],
      campaignPolicy: body["campaign-policy"],
    };
  } else {
    assertFormKeys(body);
    candidate = setupFromForm(body);
  }

  assertSerializedSetupBound(candidate);
  if (mediaType === "application/json") assertExactSetupShape(candidate);
  const parsed = parseCampaignSetup(candidate);
  if (!parsed.ok) throw new StorageFailure("INVALID_REQUEST");
  return Object.freeze({
    operationId: requiredOperationId(body["operation-id"]),
    expectedRevision: expectedRevision(
      body["expected-revision"],
      mediaType,
    ),
    setup: parsed.value,
  });
}

async function saveSetupMutation(
  repository: AtomicCampaignAuditRepository,
  mutation: ParsedInitialSetupMutation,
  ownerSubject: string,
  recordedAt: string,
): Promise<void> {
  if (await replaySetupMutation(repository, mutation, ownerSubject)) return;

  const current = await repository.readSetup();
  if (current === null) {
    if (
      mutation.expectedRevision !== null ||
      mutation.setup.publicCampaign.published
    ) {
      throw new StorageFailure("INVALID_REQUEST");
    }
  } else {
    if (mutation.expectedRevision !== current.revision) {
      if (await replaySetupMutation(repository, mutation, ownerSubject)) return;
      throw new StorageFailure("PRECONDITION_FAILED");
    }
    if (
      mutation.setup.publicCampaign.published !==
        current.setup.publicCampaign.published
    ) {
      throw new StorageFailure("INVALID_REQUEST");
    }
  }

  try {
    await repository.saveSetupWithAudit({
      operationId: mutation.operationId,
      ownerSubject,
      recordedAt,
      expectedRevision: mutation.expectedRevision,
      setup: mutation.setup,
      transition: current === null ? "created" : "updated",
    });
  } catch (error) {
    if (
      error instanceof StorageFailure &&
      (error.code === "CONFLICT" || error.code === "PRECONDITION_FAILED") &&
      await replaySetupMutation(repository, mutation, ownerSubject)
    ) {
      return;
    }
    throw error;
  }
}

async function replaySetupMutation(
  repository: AtomicCampaignAuditRepository,
  mutation: ParsedInitialSetupMutation,
  ownerSubject: string,
): Promise<boolean> {
  const replay = await repository.findSetupByOperationId(mutation.operationId);
  if (replay === null) return false;

  const replayExpected = replay.revision === 1 ? null : replay.revision - 1;
  if (
    mutation.expectedRevision !== replayExpected ||
    !equalJson(mutation.setup, replay.setup)
  ) {
    throw new StorageFailure("CONFLICT");
  }
  await repository.saveSetupWithAudit({
    operationId: mutation.operationId,
    ownerSubject,
    recordedAt: replay.recordedAt,
    expectedRevision: replayExpected,
    setup: replay.setup,
    transition: replay.revision === 1 ? "created" : "updated",
  });
  return true;
}

function setupFromForm(body: Readonly<Record<string, unknown>>): unknown {
  return {
    publicCampaign: publicCampaignFromForm(body),
    phases: phasesFromForm(body),
    amountAggregate: amountAggregateFromForm(body),
    campaignPolicy: campaignPolicyFromForm(body),
  };
}

function publicCampaignFromForm(
  body: Readonly<Record<string, unknown>>,
): unknown {
  return {
    id: requiredText(body, "campaign-id"),
    published: requiredBoolean(body, "published"),
    status: requiredText(body, "status"),
    name: requiredText(body, "name"),
    pageTitle: requiredText(body, "page-title"),
    pageDescription: requiredText(body, "page-description"),
    phaseLabel: requiredText(body, "phase-label"),
    statusLabel: requiredText(body, "status-label"),
    brandMarkUrl: optionalText(body, "brand-mark-url"),
    heroImageUrl: optionalText(body, "hero-image-url"),
    socialImageUrl: optionalText(body, "social-image-url"),
    navigation: parseRows(
      body,
      "navigation",
      MAX_NAVIGATION,
      ["label", "href"],
      ([label, href]) => ({ label, href }),
    ),
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
    facts: parseRows(
      body,
      "fact",
      MAX_FACTS,
      ["label", "value"],
      ([label, value]) => ({ label, value }),
    ),
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
      items: parseRows(
        body,
        "risk",
        MAX_RISKS,
        ["text"],
        ([text]) => text,
      ),
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
}

function phasesFromForm(
  body: Readonly<Record<string, unknown>>,
): readonly unknown[] {
  const phases: unknown[] = [];
  for (let index = 0; index < MAX_PHASES; index += 1) {
    const prefix = `phase-${index}`;
    const id = optionalText(body, `${prefix}-id`);
    const state = optionalText(body, `${prefix}-state`);
    const mode = optionalText(body, `${prefix}-country-mode`);
    const countries = optionalText(body, `${prefix}-countries`);
    const founder = checked(body, `${prefix}-founder-enabled`);
    const investor = checked(body, `${prefix}-investor-enabled`);
    if (
      id === null && state === null && mode === null && countries === null &&
      !founder && !investor
    ) {
      continue;
    }
    phases.push({
      id: requiredText(body, `${prefix}-id`),
      state: requiredText(body, `${prefix}-state`),
      enabledParticipationPaths: [
        ...(founder ? ["founder"] : []),
        ...(investor ? ["investor"] : []),
      ],
      countryEligibility: {
        mode: requiredText(body, `${prefix}-country-mode`),
        countries: parseCountryCodes(countries ?? ""),
      },
    });
  }
  return Object.freeze(phases);
}

function amountAggregateFromForm(
  body: Readonly<Record<string, unknown>>,
): unknown {
  const visibility = requiredText(body, "aggregate-visibility");
  return {
    amount: {
      currency: requiredText(body, "amount-currency"),
      minimum: requiredInteger(body, "amount-minimum"),
      increment: requiredInteger(body, "amount-increment"),
      maximum: optionalInteger(body, "amount-maximum"),
    },
    publicAggregate: visibility === "hidden"
      ? { visibility }
      : {
          visibility,
          label: requiredText(body, "aggregate-label"),
          qualifier: requiredText(body, "aggregate-qualifier"),
        },
  };
}

function campaignPolicyFromForm(
  body: Readonly<Record<string, unknown>>,
): unknown {
  return {
    founderContributionChoices: parseRows(
      body,
      "contribution-choice",
      MAX_CONTRIBUTION_CHOICES,
      ["id", "label"],
      ([id, label]) => ({ id, label }),
    ),
    notices: {
      legalBoundary: requiredText(body, "notice-legal-boundary"),
      nonBindingInterest: requiredText(body, "notice-non-binding-interest"),
      processEmail: requiredText(body, "notice-process-email"),
      marketingConsent: requiredText(body, "notice-marketing-consent"),
      privacyContact: {
        label: requiredText(body, "privacy-contact-label"),
        href: requiredText(body, "privacy-contact-href"),
      },
      retention: requiredText(body, "notice-retention"),
    },
    publicationReadiness: {
      publicPresentationReviewed: checked(body, "review-public-presentation"),
      legalNoticesReviewed: checked(body, "review-legal-notices"),
      privacyAndRetentionReviewed: checked(body, "review-privacy-retention"),
    },
  };
}

function parseLinkRows(
  body: Readonly<Record<string, unknown>>,
  prefix: string,
  maximum: number,
): readonly unknown[] {
  return parseRows(
    body,
    prefix,
    maximum,
    ["label", "href", "rel"],
    ([label, href, rel]) => ({
      label,
      href,
      rel: rel.split(/[\s,]+/u).filter(Boolean),
    }),
  );
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
    const values = fields.map((fieldName) =>
      optionalText(body, `${prefix}-${index}-${fieldName}`) ?? ""
    );
    if (values.every((value) => value === "")) continue;
    if (values.some((value) => value === "")) {
      throw new StorageFailure("INVALID_REQUEST");
    }
    rows.push(create(values));
  }
  return Object.freeze(rows);
}

function parseCountryCodes(value: string): readonly string[] {
  const values = value.split(/[\s,]+/u).filter(Boolean);
  if (values.length > MAX_COUNTRIES_PER_PHASE) {
    throw new StorageFailure("INVALID_REQUEST");
  }
  return Object.freeze(values);
}

function assertFormKeys(body: Readonly<Record<string, unknown>>): void {
  const allowed = new Set<string>(FORM_SCALAR_KEYS);
  addRowKeys(allowed, "navigation", MAX_NAVIGATION, ["label", "href"]);
  addRowKeys(allowed, "fact", MAX_FACTS, ["label", "value"]);
  addRowKeys(allowed, "participation-path", MAX_PARTICIPATION_PATHS, [
    "kind",
    "title",
    "description",
    "action-label",
  ]);
  addRowKeys(allowed, "product-link", MAX_PRODUCT_LINKS, [
    "label",
    "href",
    "rel",
  ]);
  addRowKeys(allowed, "product-capability", MAX_PRODUCT_CAPABILITIES, [
    "label",
    "description",
  ]);
  addRowKeys(allowed, "process-step", MAX_PROCESS_STEPS, [
    "title",
    "description",
  ]);
  addRowKeys(allowed, "risk", MAX_RISKS, ["text"]);
  addRowKeys(allowed, "faq-item", MAX_FAQ_ITEMS, ["question", "answer"]);
  addRowKeys(allowed, "footer-link", MAX_FOOTER_LINKS, [
    "label",
    "href",
    "rel",
  ]);
  addRowKeys(allowed, "phase", MAX_PHASES, [
    "id",
    "state",
    "founder-enabled",
    "investor-enabled",
    "country-mode",
    "countries",
  ]);
  addRowKeys(allowed, "contribution-choice", MAX_CONTRIBUTION_CHOICES, [
    "id",
    "label",
  ]);
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

function assertExactSetupShape(value: unknown): void {
  const setup = exactRecord(value, [
    "publicCampaign",
    "phases",
    "amountAggregate",
    "campaignPolicy",
  ]);
  assertPublicCampaignShape(setup.publicCampaign);
  assertObjectArray(setup.phases, MAX_PHASES, (phase) => {
    const source = exactRecord(phase, [
      "id",
      "state",
      "enabledParticipationPaths",
      "countryEligibility",
    ]);
    const countryEligibility = exactRecord(
      source.countryEligibility,
      ["mode", "countries"],
    );
    assertArray(countryEligibility.countries, MAX_COUNTRIES_PER_PHASE);
    assertArray(source.enabledParticipationPaths, 2);
  });
  const amount = exactRecord(setup.amountAggregate, [
    "amount",
    "publicAggregate",
  ]);
  exactRecord(amount.amount, ["currency", "minimum", "increment", "maximum"]);
  const aggregate = record(amount.publicAggregate);
  if (aggregate === null || aggregate.visibility === "hidden") {
    exactRecord(amount.publicAggregate, ["visibility"]);
  } else {
    exactRecord(amount.publicAggregate, ["visibility", "label", "qualifier"]);
  }
  const policy = exactRecord(setup.campaignPolicy, [
    "founderContributionChoices",
    "notices",
    "publicationReadiness",
  ]);
  assertObjectArray(
    policy.founderContributionChoices,
    MAX_CONTRIBUTION_CHOICES,
    (choice) => {
    exactRecord(choice, ["id", "label"]);
    },
  );
  const notices = exactRecord(policy.notices, [
    "legalBoundary",
    "nonBindingInterest",
    "processEmail",
    "marketingConsent",
    "privacyContact",
    "retention",
  ]);
  exactRecord(notices.privacyContact, ["label", "href"]);
  exactRecord(policy.publicationReadiness, [
    "publicPresentationReviewed",
    "legalNoticesReviewed",
    "privacyAndRetentionReviewed",
  ]);
}

function assertPublicCampaignShape(value: unknown): void {
  const campaign = exactRecord(value, [
    "id",
    "published",
    "status",
    "name",
    "pageTitle",
    "pageDescription",
    "phaseLabel",
    "statusLabel",
    "brandMarkUrl",
    "heroImageUrl",
    "socialImageUrl",
    "navigation",
    "hero",
    "facts",
    "participation",
    "product",
    "process",
    "risks",
    "faq",
    "closing",
    "footer",
  ]);
  assertObjectArray(campaign.navigation, MAX_NAVIGATION, (item) => {
    exactRecord(item, ["label", "href"]);
  });
  exactRecord(campaign.hero, [
    "summary",
    "invitation",
    "primaryActionLabel",
    "secondaryAction",
    "note",
  ]);
  const hero = record(campaign.hero);
  if (hero?.secondaryAction !== null) {
    exactRecord(hero?.secondaryAction, ["label", "href"]);
  }
  assertObjectArray(campaign.facts, MAX_FACTS, (item) => {
    exactRecord(item, ["label", "value"]);
  });
  const participation = exactRecord(campaign.participation, [
    "eyebrow",
    "title",
    "paths",
  ]);
  assertObjectArray(
    participation.paths,
    MAX_PARTICIPATION_PATHS,
    (item) => {
    exactRecord(item, ["kind", "title", "description", "actionLabel"]);
    },
  );
  if (campaign.product !== null) {
    const product = exactRecord(campaign.product, [
      "eyebrow",
      "title",
      "description",
      "links",
      "capabilities",
    ]);
    assertObjectArray(product.links, MAX_PRODUCT_LINKS, assertCampaignLinkShape);
    assertObjectArray(product.capabilities, MAX_PRODUCT_CAPABILITIES, (item) => {
      exactRecord(item, ["label", "description"]);
    });
  }
  if (campaign.process !== null) {
    const process = exactRecord(campaign.process, ["eyebrow", "title", "steps"]);
    assertObjectArray(process.steps, MAX_PROCESS_STEPS, (item) => {
      exactRecord(item, ["title", "description"]);
    });
  }
  const risks = exactRecord(campaign.risks, ["eyebrow", "title", "items"]);
  assertArray(risks.items, MAX_RISKS);
  if (campaign.faq !== null) {
    const faq = exactRecord(campaign.faq, ["eyebrow", "title", "items"]);
    assertObjectArray(faq.items, MAX_FAQ_ITEMS, (item) => {
      exactRecord(item, ["question", "answer"]);
    });
  }
  exactRecord(campaign.closing, ["eyebrow", "title", "actionLabel"]);
  const footer = exactRecord(campaign.footer, ["tagline", "links"]);
  assertObjectArray(footer.links, MAX_FOOTER_LINKS, assertCampaignLinkShape);
}

function assertCampaignLinkShape(value: unknown): void {
  const link = exactRecord(value, ["label", "href", "rel"]);
  assertArray(link.rel, 4);
}

function assertObjectArray(
  value: unknown,
  maximum: number,
  check: (item: unknown) => void,
): void {
  assertArray(value, maximum);
  for (const item of value) check(item);
}

function assertArray(
  value: unknown,
  maximum: number,
): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalidRequest();
}

function exactRecord(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> {
  const source = record(value);
  if (source === null) invalidRequest();
  assertExactKeys(source, new Set(expected));
  return source;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assertExactKeys(
  body: Readonly<Record<string, unknown>>,
  expected: ReadonlySet<string>,
): void {
  const keys = Object.keys(body);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    invalidRequest();
  }
}

function assertSerializedSetupBound(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new StorageFailure("INVALID_REQUEST", { cause: error });
  }
  if (new TextEncoder().encode(serialized).byteLength > OWNER_INITIAL_SETUP_MAX_BYTES) {
    throw new MutationSecurityFailure("PAYLOAD_TOO_LARGE");
  }
}

function expectedRevision(
  value: unknown,
  mediaType: MutationMediaType,
): number | null {
  if (mediaType === "application/x-www-form-urlencoded") {
    if (value === "") return null;
    if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
      invalidRequest();
    }
    value = Number(value);
  }
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalidRequest();
  return value as number;
}

function requiredText(
  body: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = body[name];
  if (typeof value !== "string" || value.length === 0) invalidRequest();
  return value;
}

function optionalText(
  body: Readonly<Record<string, unknown>>,
  name: string,
): string | null {
  const value = body[name];
  if (value === undefined || value === "") return null;
  if (typeof value !== "string") invalidRequest();
  return value;
}

function requiredBoolean(
  body: Readonly<Record<string, unknown>>,
  name: string,
): boolean {
  const value = requiredText(body, name);
  if (value !== "true" && value !== "false") invalidRequest();
  return value === "true";
}

function checked(body: Readonly<Record<string, unknown>>, name: string): boolean {
  const value = body[name];
  if (value === undefined) return false;
  if (value !== "true") invalidRequest();
  return true;
}

function requiredInteger(
  body: Readonly<Record<string, unknown>>,
  name: string,
): number {
  const value = requiredText(body, name);
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) invalidRequest();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) invalidRequest();
  return parsed;
}

function optionalInteger(
  body: Readonly<Record<string, unknown>>,
  name: string,
): number | null {
  const value = optionalText(body, name);
  if (value === null) return null;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) invalidRequest();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) invalidRequest();
  return parsed;
}

async function verifiedOwnerMutation(
  session: BrowserMutationSession,
  request: Request,
  expectedSubject: string,
  appOrigin: string,
) {
  const verified = await session.verifyMutation(
    request,
    { type: "owner", subject: expectedSubject },
    appOrigin,
    {
      maxBodyBytes: OWNER_INITIAL_SETUP_WIRE_MAX_BYTES,
      maxFields: OWNER_INITIAL_SETUP_MAX_FIELDS,
    },
  );
  if (
    verified.method !== "POST" ||
    verified.actor.type !== "owner" ||
    verified.actor.subject !== expectedSubject
  ) {
    throw new MutationSecurityFailure("REQUEST_REJECTED");
  }
  return verified;
}

function atomicCampaignRepository(
  repository: CampaignRepository,
): AtomicCampaignAuditRepository | null {
  const candidate = repository as Partial<AtomicCampaignAuditRepository>;
  return candidate.mutationConsistency === "atomic-campaign-audit" &&
      typeof candidate.saveSetupWithAudit === "function"
    ? candidate as AtomicCampaignAuditRepository
    : null;
}

async function requiredCurrent(
  repository: CampaignRepository,
): Promise<CampaignSetupRevision> {
  const current = await repository.readSetup();
  if (current === null) throw new StorageFailure("NOT_FOUND");
  return current;
}

function currentTimestamp(now: () => Date): string {
  let value: Date;
  try {
    value = now();
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return value.toISOString();
}

function defaultOperationId(): string {
  try {
    return `owner-setup:${crypto.randomUUID()}`;
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
}

function requiredOperationId(value: unknown): string {
  const parsed = parseStorageOperationId(value);
  if (!parsed.ok) throw new StorageFailure("INVALID_REQUEST");
  return parsed.value;
}

function requiredCsrfToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 256 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return value;
}

function requiredMutationProof(value: BrowserMutationProof): BrowserMutationProof {
  requiredCsrfToken(value.token);
  if (
    typeof value.setCookie !== "string" ||
    value.setCookie.length < 1 ||
    value.setCookie.length > 4_096 ||
    /[\r\n]/u.test(value.setCookie)
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return value;
}

function requiredClearMutationCookie(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    /[\r\n]/u.test(value)
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  return value;
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function invalidRequest(): never {
  throw new StorageFailure("INVALID_REQUEST");
}

function renderWorkspace(
  resource: OwnerInitialSetupResource,
  csrf: string | null,
): string {
  const data = resource.document.data;
  const status = data.publication === "not-configured"
    ? "Not configured"
    : data.publication === "published"
      ? "Published"
      : "Unpublished draft";
  const form = resource.form !== null && csrf !== null
    ? renderSetupForm(resource.form, csrf)
    : `<section class="owner-setup-unavailable"><h2>Setup editing unavailable</h2><p>The campaign setup cannot be saved from this deployment.</p></section>`;
  const preview = resource.document.links.find((link) =>
    link.rel.includes("preview")
  );
  return page(
    "Campaign setup",
    `<header class="owner-setup-header"><a class="owner-setup-brand" href="/owner">Owner workspace</a><nav aria-label="Campaign setup navigation"><a href="/">Public campaign</a>${preview ? `<a href="${escapeAttribute(preview.href)}">Preview saved draft</a>` : ""}</nav></header><main class="owner-setup-main"><div class="owner-setup-title"><div><p class="owner-setup-kicker">Campaign configuration</p><h1>Initial setup</h1><p>Prepare the campaign, participation rules, notices, and publication checks.</p></div><div class="owner-setup-state"><strong>${escapeHtml(status)}</strong>${data.revision === null ? "" : `<span>Revision ${data.revision}</span>`}</div></div>${renderReadiness(data.readiness)}${form}</main>`,
  );
}

function renderReadiness(readiness: OwnerInitialSetupReadiness): string {
  if (readiness.ready) {
    return `<section class="owner-setup-readiness owner-setup-readiness-ready" aria-labelledby="setup-readiness-title"><h2 id="setup-readiness-title">Ready for publication review</h2><p>The saved setup and deployment checks are complete.</p></section>`;
  }
  const labels: Readonly<Record<string, string>> = {
    "setup-not-configured": "Save the complete campaign setup.",
    "phase-setup-incomplete": "Complete each enabled campaign phase.",
    "campaign-policy-incomplete": "Complete the campaign review requirements.",
    "deployment-not-ready": "Complete the deployment publication checks.",
  };
  const blockers = readiness.blockers.map((blocker) =>
    `<li>${escapeHtml(labels[blocker] ?? blocker)}</li>`
  ).join("");
  const phaseDetails = readiness.phase_requirements.flatMap((phase) =>
    phase.missing.map((missing) =>
      `<li><strong>${escapeHtml(phase.phase_id)}</strong>: ${escapeHtml(readinessRequirementLabel(missing))}</li>`
    )
  ).join("");
  const policyDetails = readiness.campaign_policy_requirements.map((missing) =>
    `<li>${escapeHtml(readinessRequirementLabel(missing))}</li>`
  ).join("");
  const details = phaseDetails || policyDetails
    ? `<details><summary>Setup requirements</summary><ul>${phaseDetails}${policyDetails}</ul></details>`
    : "";
  return `<section class="owner-setup-readiness" aria-labelledby="setup-readiness-title"><h2 id="setup-readiness-title">Publication blockers</h2><ul>${blockers}</ul>${details}</section>`;
}

function readinessRequirementLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    "enabledParticipationPaths": "Choose at least one participation path.",
    "countryEligibility.countries": "Add at least one eligible country.",
    "founderContributionChoices": "Add founder contribution choices.",
    "publicationReadiness.publicPresentationReviewed": "Review the public presentation.",
    "publicationReadiness.legalNoticesReviewed": "Review the legal notices.",
    "publicationReadiness.privacyAndRetentionReviewed": "Review privacy and retention.",
  };
  return labels[value] ?? value;
}

function renderSetupForm(form: OwnerInitialSetupForm, csrf: string): string {
  const setup = form.setup;
  const campaign = setup?.publicCampaign ?? null;
  const policy = setup?.campaignPolicy ?? null;
  const amount = setup?.amountAggregate ?? null;
  const published = campaign?.published ?? false;
  return `<form class="owner-setup-form" action="${escapeAttribute(form.action)}" method="post" accept-charset="utf-8"><input type="hidden" name="${MUTATION_CSRF_FIELD}" value="${escapeAttribute(csrf)}"><input type="hidden" name="operation-id" value="${escapeAttribute(form.operationId)}"><input type="hidden" name="expected-revision" value="${form.expectedRevision ?? ""}"><input type="hidden" name="published" value="${published}">${renderCampaignFields(campaign)}${renderPhaseFields(setup?.phases ?? [])}${renderAmountFields(amount)}${renderPolicyFields(policy)}<div class="owner-setup-actions"><button type="submit">${setup === null ? "Create campaign setup" : "Save campaign setup"}</button>${setup === null ? "" : `<a href="${OWNER_INITIAL_SETUP_PREVIEW_PATH}">Preview saved draft</a>`}</div></form>`;
}

function renderCampaignFields(campaign: PublicCampaignConfiguration | null): string {
  const hero = campaign?.hero;
  const participation = campaign?.participation;
  return `${section("campaign-identity", "Campaign identity", "The public campaign identity and registration state.", `${field("campaign-id", "Campaign ID", campaign?.id ?? "", 80)}${select("status", "Registration status", campaign?.status ?? null, [["open", "Open"], ["closed", "Closed"]])}${field("name", "Campaign name", campaign?.name ?? "", 120)}${field("page-title", "Browser page title", campaign?.pageTitle ?? "", 160)}${textarea("page-description", "Page description", campaign?.pageDescription ?? "", 320)}${field("phase-label", "Phase label", campaign?.phaseLabel ?? "", 120)}${field("status-label", "Status label", campaign?.statusLabel ?? "", 120)}`)}${section("campaign-media", "Campaign media", "Reviewed public images for this campaign.", `${field("brand-mark-url", "Brand mark URL", campaign?.brandMarkUrl ?? "", 2000, { required: false })}${field("hero-image-url", "Hero image URL", campaign?.heroImageUrl ?? "", 2000, { required: false })}${field("social-image-url", "Social image URL", campaign?.socialImageUrl ?? "", 2000, { required: false })}`)}${section("campaign-navigation", "Navigation", "Public navigation links.", repeatable("navigation", campaign?.navigation ?? [], MAX_NAVIGATION, renderNavigationRow, navigationTemplate()))}${section("campaign-opening", "Opening", "The first campaign context shown to visitors.", `${textarea("hero-summary", "Summary", hero?.summary ?? "", 500)}${textarea("hero-invitation", "Invitation", hero?.invitation ?? "", 800)}${field("hero-primary-action-label", "Primary action label", hero?.primaryActionLabel ?? "", 80)}${toggle("hero-secondary-enabled", "Show secondary action", hero?.secondaryAction !== null && hero?.secondaryAction !== undefined)}${field("hero-secondary-label", "Secondary action label", hero?.secondaryAction?.label ?? "", 80, { required: false })}${field("hero-secondary-href", "Secondary action destination", hero?.secondaryAction?.href ?? "", 2000, { required: false })}${textarea("hero-note", "Participation notice", hero?.note ?? "", 500)}`)}${section("campaign-facts", "Campaign facts", "Short facts shown with the opening.", repeatable("fact", campaign?.facts ?? [], MAX_FACTS, (item, index) => `${field(`fact-${index}-label`, "Label", item.label, 80)}${field(`fact-${index}-value`, "Value", item.value, 120)}`, rowTemplate("fact", [["label", "Label", 80], ["value", "Value", 120]])))}${section("campaign-participation", "Participation", "The founder and investor paths offered to visitors.", `${field("participation-eyebrow", "Section label", participation?.eyebrow ?? "", 80)}${field("participation-title", "Section title", participation?.title ?? "", 180)}${repeatable("participation-path", participation?.paths ?? [], MAX_PARTICIPATION_PATHS, renderParticipationPath, participationPathTemplate(), campaign === null)}`)}${renderProductSection(campaign)}${renderProcessSection(campaign)}${section("campaign-risks", "Risks and boundaries", "Public notices visitors review before continuing.", `${field("risks-eyebrow", "Section label", campaign?.risks.eyebrow ?? "", 80)}${field("risks-title", "Section title", campaign?.risks.title ?? "", 180)}${repeatable("risk", campaign?.risks.items ?? [], MAX_RISKS, (item, index) => textarea(`risk-${index}-text`, "Notice", item, 500), `<div class="owner-campaign-row"><div class="owner-campaign-fields">${textarea("risk-__INDEX__-text", "Notice", "", 500)}</div>${removeButton()}</div>`, campaign === null)}`)}${renderFaqSection(campaign)}${section("campaign-closing", "Closing invitation", "The final public invitation.", `${field("closing-eyebrow", "Section label", campaign?.closing.eyebrow ?? "", 80)}${field("closing-title", "Section title", campaign?.closing.title ?? "", 180)}${field("closing-action-label", "Action label", campaign?.closing.actionLabel ?? "", 80)}`)}${section("campaign-footer", "Footer", "The public closing note and supporting links.", `${textarea("footer-tagline", "Footer note", campaign?.footer.tagline ?? "", 240)}${repeatable("footer-link", campaign?.footer.links ?? [], MAX_FOOTER_LINKS, renderCampaignLinkRow("footer-link"), campaignLinkTemplate("footer-link"))}`)}`;
}

function renderProductSection(campaign: PublicCampaignConfiguration | null): string {
  const product = campaign?.product ?? null;
  const disabled = product === null;
  return section("campaign-product", "Product", "Optional public product context.", `${toggle("product-enabled", "Show product section", product !== null)}<div class="owner-campaign-optional" data-optional-section="product-enabled"${disabled ? " hidden" : ""}>${field("product-eyebrow", "Section label", product?.eyebrow ?? "", 80, { required: false, disabled })}${field("product-title", "Section title", product?.title ?? "", 180, { required: false, disabled })}${textarea("product-description", "Description", product?.description ?? "", 1000, false, disabled)}${repeatable("product-link", product?.links ?? [], MAX_PRODUCT_LINKS, renderCampaignLinkRow("product-link"), campaignLinkTemplate("product-link"), false, disabled)}${repeatable("product-capability", product?.capabilities ?? [], MAX_PRODUCT_CAPABILITIES, (item, index) => `${field(`product-capability-${index}-label`, "Capability", item.label, 80, { disabled })}${textarea(`product-capability-${index}-description`, "Description", item.description, 400, true, disabled)}`, `<div class="owner-campaign-row"><div class="owner-campaign-fields">${field("product-capability-__INDEX__-label", "Capability", "", 80)}${textarea("product-capability-__INDEX__-description", "Description", "", 400)}</div>${removeButton()}</div>`, false, disabled)}</div>`);
}

function renderProcessSection(campaign: PublicCampaignConfiguration | null): string {
  const process = campaign?.process ?? null;
  const disabled = process === null;
  return section("campaign-process", "Process", "Optional public participation steps.", `${toggle("process-enabled", "Show process section", process !== null)}<div class="owner-campaign-optional" data-optional-section="process-enabled"${disabled ? " hidden" : ""}>${field("process-eyebrow", "Section label", process?.eyebrow ?? "", 80, { required: false, disabled })}${field("process-title", "Section title", process?.title ?? "", 180, { required: false, disabled })}${repeatable("process-step", process?.steps ?? [], MAX_PROCESS_STEPS, (item, index) => `${field(`process-step-${index}-title`, "Step title", item.title, 100, { disabled })}${textarea(`process-step-${index}-description`, "Description", item.description, 400, true, disabled)}`, `<div class="owner-campaign-row"><div class="owner-campaign-fields">${field("process-step-__INDEX__-title", "Step title", "", 100)}${textarea("process-step-__INDEX__-description", "Description", "", 400)}</div>${removeButton()}</div>`, false, disabled)}</div>`);
}

function renderFaqSection(campaign: PublicCampaignConfiguration | null): string {
  const faq = campaign?.faq ?? null;
  const disabled = faq === null;
  return section("campaign-faq", "Questions", "Optional public questions and answers.", `${toggle("faq-enabled", "Show questions section", faq !== null)}<div class="owner-campaign-optional" data-optional-section="faq-enabled"${disabled ? " hidden" : ""}>${field("faq-eyebrow", "Section label", faq?.eyebrow ?? "", 80, { required: false, disabled })}${field("faq-title", "Section title", faq?.title ?? "", 180, { required: false, disabled })}${repeatable("faq-item", faq?.items ?? [], MAX_FAQ_ITEMS, (item, index) => `${field(`faq-item-${index}-question`, "Question", item.question, 240, { disabled })}${textarea(`faq-item-${index}-answer`, "Answer", item.answer, 800, true, disabled)}`, `<div class="owner-campaign-row"><div class="owner-campaign-fields">${field("faq-item-__INDEX__-question", "Question", "", 240)}${textarea("faq-item-__INDEX__-answer", "Answer", "", 800)}</div>${removeButton()}</div>`, false, disabled)}</div>`);
}

function renderPhaseFields(phases: CampaignSetup["phases"]): string {
  return section("campaign-phases", "Campaign phases", "Participation state, paths, and country eligibility.", repeatable("phase", phases, MAX_PHASES, (phase, index) => `${field(`phase-${index}-id`, "Phase ID", phase.id, 128)}${select(`phase-${index}-state`, "State", phase.state, [["closed", "Closed"], ["open", "Open"]])}<div class="owner-setup-paths"><span>Participation paths</span>${toggle(`phase-${index}-founder-enabled`, "Founder", phase.enabledParticipationPaths.includes("founder"))}${toggle(`phase-${index}-investor-enabled`, "Investor", phase.enabledParticipationPaths.includes("investor"))}</div>${select(`phase-${index}-country-mode`, "Country rule", phase.countryEligibility.mode, [["allow", "Allow listed countries"], ["deny", "Deny listed countries"]])}${field(`phase-${index}-countries`, "Country codes", phase.countryEligibility.countries.join(" "), 4096)}`, phaseTemplate(), phases.length === 0));
}

function renderAmountFields(amount: CampaignSetup["amountAggregate"] | null): string {
  const aggregate = amount?.publicAggregate;
  return section("campaign-amount", "Amount and aggregate", "Integer minor-unit limits and the public total display.", `${field("amount-currency", "Currency code", amount?.amount.currency ?? "", 3)}${numberField("amount-minimum", "Minimum amount", amount?.amount.minimum ?? null, 0)}${numberField("amount-increment", "Amount increment", amount?.amount.increment ?? null, 1)}${numberField("amount-maximum", "Maximum amount", amount?.amount.maximum ?? null, 0, false)}${select("aggregate-visibility", "Public aggregate", aggregate?.visibility ?? null, [["hidden", "Hidden"], ["non_zero", "Show when non-zero"]])}${field("aggregate-label", "Aggregate label", aggregate?.visibility === "non_zero" ? aggregate.label : "", 120, { required: false })}${textarea("aggregate-qualifier", "Aggregate qualifier", aggregate?.visibility === "non_zero" ? aggregate.qualifier : "", 500, false)}`);
}

function renderPolicyFields(policy: CampaignSetup["campaignPolicy"] | null): string {
  const notices = policy?.notices;
  const review = policy?.publicationReadiness;
  return `${section("founder-choices", "Founder contribution choices", "Configured contribution areas for founder applications.", repeatable("contribution-choice", policy?.founderContributionChoices ?? [], MAX_CONTRIBUTION_CHOICES, (choice, index) => `${field(`contribution-choice-${index}-id`, "Choice ID", choice.id, 128)}${field(`contribution-choice-${index}-label`, "Label", choice.label, 120)}`, rowTemplate("contribution-choice", [["id", "Choice ID", 128], ["label", "Label", 120]])))}${section("campaign-notices", "Participant notices", "Campaign-specific legal, communication, privacy, and retention text.", `${textarea("notice-legal-boundary", "Legal boundary", notices?.legalBoundary ?? "", 4000)}${textarea("notice-non-binding-interest", "Non-binding interest", notices?.nonBindingInterest ?? "", 4000)}${field("notice-process-email", "Required process email notice", notices?.processEmail ?? "", 4000)}${field("notice-marketing-consent", "Optional marketing consent notice", notices?.marketingConsent ?? "", 4000)}${field("privacy-contact-label", "Privacy contact label", notices?.privacyContact.label ?? "", 160)}${field("privacy-contact-href", "Privacy contact destination", notices?.privacyContact.href ?? "", 2048)}${textarea("notice-retention", "Retention notice", notices?.retention ?? "", 4000)}`)}${section("publication-review", "Publication review", "Owner confirmations required before publication.", `<div class="owner-setup-review">${toggle("review-public-presentation", "Public presentation reviewed", review?.publicPresentationReviewed ?? false)}${toggle("review-legal-notices", "Legal notices reviewed", review?.legalNoticesReviewed ?? false)}${toggle("review-privacy-retention", "Privacy and retention reviewed", review?.privacyAndRetentionReviewed ?? false)}</div>`)}`;
}

function renderNavigationRow(
  item: Readonly<{ label: string; href: string }>,
  index: number,
): string {
  return `${field(`navigation-${index}-label`, "Label", item.label, 60)}${field(`navigation-${index}-href`, "Destination", item.href, 2000)}`;
}

function renderParticipationPath(
  item: PublicCampaignConfiguration["participation"]["paths"][number],
  index: number,
): string {
  return `${select(`participation-path-${index}-kind`, "Path", item.kind, [["investor", "Investor"], ["founder", "Founder"]])}${field(`participation-path-${index}-title`, "Title", item.title, 120)}${textarea(`participation-path-${index}-description`, "Description", item.description, 500)}${field(`participation-path-${index}-action-label`, "Action label", item.actionLabel, 100)}`;
}

function renderCampaignLinkRow(prefix: string) {
  return (link: CampaignLink, index: number) =>
    `${field(`${prefix}-${index}-label`, "Label", link.label, 80)}${field(`${prefix}-${index}-href`, "Destination", link.href, 2000)}${field(`${prefix}-${index}-rel`, "Relationship tags", link.rel.join(" "), 200)}`;
}

function navigationTemplate(): string {
  return rowTemplate("navigation", [["label", "Label", 60], ["href", "Destination", 2000]]);
}

function participationPathTemplate(): string {
  return `<div class="owner-campaign-row"><div class="owner-campaign-fields">${select("participation-path-__INDEX__-kind", "Path", null, [["investor", "Investor"], ["founder", "Founder"]])}${field("participation-path-__INDEX__-title", "Title", "", 120)}${textarea("participation-path-__INDEX__-description", "Description", "", 500)}${field("participation-path-__INDEX__-action-label", "Action label", "", 100)}</div>${removeButton()}</div>`;
}

function campaignLinkTemplate(prefix: string): string {
  return rowTemplate(prefix, [["label", "Label", 80], ["href", "Destination", 2000], ["rel", "Relationship tags", 200]]);
}

function phaseTemplate(): string {
  return `<div class="owner-campaign-row"><div class="owner-campaign-fields">${field("phase-__INDEX__-id", "Phase ID", "", 128)}${select("phase-__INDEX__-state", "State", null, [["closed", "Closed"], ["open", "Open"]])}<div class="owner-setup-paths"><span>Participation paths</span>${toggle("phase-__INDEX__-founder-enabled", "Founder", false)}${toggle("phase-__INDEX__-investor-enabled", "Investor", false)}</div>${select("phase-__INDEX__-country-mode", "Country rule", null, [["allow", "Allow listed countries"], ["deny", "Deny listed countries"]])}${field("phase-__INDEX__-countries", "Country codes", "", 4096)}</div>${removeButton()}</div>`;
}

function rowTemplate(
  prefix: string,
  fields: readonly (readonly [string, string, number])[],
): string {
  return `<div class="owner-campaign-row"><div class="owner-campaign-fields">${fields.map(([name, label, maximum]) => field(`${prefix}-__INDEX__-${name}`, label, "", maximum)).join("")}</div>${removeButton()}</div>`;
}

function repeatable<Item>(
  prefix: string,
  items: readonly Item[],
  maximum: number,
  render: (item: Item, index: number) => string,
  template: string,
  includeBlank = false,
  disabled = false,
): string {
  const rows = items.map((item, index) =>
    `<div class="owner-campaign-row"><div class="owner-campaign-fields">${render(item, index)}</div>${removeButton(disabled)}</div>`
  ).join("");
  const blank = items.length === 0 && includeBlank
    ? template.replaceAll("__INDEX__", "0")
    : "";
  return `<div class="owner-campaign-repeatable" data-repeatable="${escapeAttribute(prefix)}" data-maximum="${maximum}"><div data-repeatable-rows>${rows}${blank}</div><template>${template}</template><button class="owner-campaign-add" type="button" data-add-row${disabled ? " disabled" : ""}>Add row</button></div>`;
}

function section(id: string, title: string, description: string, content: string): string {
  return `<section class="owner-setup-section" aria-labelledby="${escapeAttribute(id)}"><div class="owner-setup-section-heading"><h2 id="${escapeAttribute(id)}">${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div><div class="owner-setup-section-content">${content}</div></section>`;
}

type FieldOptions = Readonly<{
  required?: boolean;
  disabled?: boolean;
}>;

function field(
  name: string,
  label: string,
  value: string,
  maxLength: number,
  options: FieldOptions = {},
): string {
  const id = `setup-field-${name}`;
  const required = options.required ?? true;
  return `<div class="owner-setup-field"><label for="${escapeAttribute(id)}">${escapeHtml(label)}</label><input id="${escapeAttribute(id)}" name="${escapeAttribute(name)}" type="text" value="${escapeAttribute(value)}" maxlength="${maxLength}"${required ? " required" : ""}${options.disabled ? " disabled" : ""}></div>`;
}

function numberField(
  name: string,
  label: string,
  value: number | null,
  minimum: number,
  required = true,
): string {
  const id = `setup-field-${name}`;
  return `<div class="owner-setup-field"><label for="${escapeAttribute(id)}">${escapeHtml(label)}</label><input id="${escapeAttribute(id)}" name="${escapeAttribute(name)}" type="number" inputmode="numeric" min="${minimum}" max="${Number.MAX_SAFE_INTEGER}" step="1" value="${value ?? ""}"${required ? " required" : ""}></div>`;
}

function textarea(
  name: string,
  label: string,
  value: string,
  maxLength: number,
  required = true,
  disabled = false,
): string {
  const id = `setup-field-${name}`;
  return `<div class="owner-setup-field owner-setup-field-wide"><label for="${escapeAttribute(id)}">${escapeHtml(label)}</label><textarea id="${escapeAttribute(id)}" name="${escapeAttribute(name)}" maxlength="${maxLength}"${required ? " required" : ""}${disabled ? " disabled" : ""}>${escapeHtml(value)}</textarea></div>`;
}

function select(
  name: string,
  label: string,
  value: string | null,
  choices: readonly (readonly [string, string])[],
): string {
  const id = `setup-field-${name}`;
  return `<div class="owner-setup-field"><label for="${escapeAttribute(id)}">${escapeHtml(label)}</label><select id="${escapeAttribute(id)}" name="${escapeAttribute(name)}" required><option value=""${value === null ? " selected" : ""} disabled>Select</option>${choices.map(([choice, title]) => `<option value="${escapeAttribute(choice)}"${choice === value ? " selected" : ""}>${escapeHtml(title)}</option>`).join("")}</select></div>`;
}

function toggle(name: string, label: string, selected: boolean): string {
  const id = `setup-field-${name}`;
  return `<div class="owner-campaign-toggle"><input id="${escapeAttribute(id)}" name="${escapeAttribute(name)}" type="checkbox" value="true"${selected ? " checked" : ""}><label for="${escapeAttribute(id)}">${escapeHtml(label)}</label></div>`;
}

function removeButton(disabled = false): string {
  return `<button class="owner-campaign-remove" type="button" data-remove-row aria-label="Remove row"${disabled ? " disabled" : ""}>Remove</button>`;
}

function authenticationRequiredResponse(
  representation: Representation,
  requestUrl: string,
  returnTo: string,
): Response {
  const signIn = new URL(chatGPTSignInPath(returnTo), requestUrl).href;
  if (representation === "html") {
    return htmlResponse(page(
      "Sign in",
      `<main class="owner-setup-message"><h1>Sign in to continue</h1><p><a href="${escapeAttribute(signIn)}">Sign in</a></p></main>`,
    ), 401);
  }
  return hypermediaResponse({
    api_version: INVESTOR_APP_API_VERSION,
    type: "error",
    id: "authentication-required",
    data: {
      code: "authentication_required",
      message: "Sign in is required to continue.",
    },
    links: [{ rel: ["self"], href: new URL(requestUrl).href }],
    actions: [{
      name: "sign-in",
      title: "Sign in",
      method: "GET",
      href: signIn,
      type: "text/html",
      fields: [],
    }],
  }, 401);
}

function methodNotAllowed(
  representation: Representation,
  requestUrl: string,
  allow: string,
): Response {
  const response = errorResponse(
    representation,
    requestUrl,
    405,
    "method_not_allowed",
    "This request method is not supported.",
  );
  const headers = new Headers(response.headers);
  headers.set("Allow", allow);
  return new Response(response.body, { status: response.status, headers });
}

function storageError(error: unknown): Readonly<{
  status: number;
  code: string;
  message: string;
}> {
  const code = error instanceof StorageFailure ? error.code : "UNAVAILABLE";
  switch (code) {
    case "INVALID_REQUEST":
      return { status: 400, code: "invalid_request", message: "The request is invalid." };
    case "CONFLICT":
      return { status: 409, code: "conflict", message: "The operation conflicts with its original request." };
    case "PRECONDITION_FAILED":
      return { status: 412, code: "precondition_failed", message: "The campaign setup has changed. Review the current revision before saving." };
    case "NOT_FOUND":
      return { status: 404, code: "not_found", message: "The requested resource was not found." };
    default:
      return { status: 503, code: "temporarily_unavailable", message: "This resource is temporarily unavailable." };
  }
}

function errorResponse(
  representation: Representation,
  requestUrl: string,
  status: number,
  code: string,
  message: string,
): Response {
  if (representation === "html") {
    return htmlResponse(page(
      "Campaign setup",
      `<main class="owner-setup-message"><h1>${escapeHtml(message)}</h1><p><a href="${OWNER_INITIAL_SETUP_PATH}">Return to campaign setup</a></p></main>`,
    ), status);
  }
  return hypermediaResponse({
    api_version: INVESTOR_APP_API_VERSION,
    type: "error",
    id: code,
    data: { code, message },
    links: [{ rel: ["self"], href: new URL(requestUrl).href }],
    actions: [],
  }, status);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/owner-initial-setup.css"><script src="/owner-campaign.js" defer></script></head><body class="owner-setup-page owner-campaign-page">${body}</body></html>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      Vary: "Accept",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function previewResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Location", OWNER_INITIAL_SETUP_PREVIEW_PATH);
  headers.set("Vary", mergeVary(headers.get("Vary"), "Accept"));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withMutationProof(
  response: Response,
  proof: BrowserMutationProof,
): Response {
  const headers = new Headers(response.headers);
  headers.set(MUTATION_CSRF_HEADER, proof.token);
  headers.append("Set-Cookie", proof.setCookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withClearedMutationCookie(response: Response, value: string): Response {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", requiredClearMutationCookie(value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withOptionalClearedMutationCookie(
  response: Response,
  value: string | null,
): Response {
  return value === null ? response : withClearedMutationCookie(response, value);
}

function mergeVary(current: string | null, value: string): string {
  const values = (current ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) {
    values.push(value);
  }
  return values.join(", ");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
