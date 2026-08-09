import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseAuditAppendIntent, type AuditEvent } from "../domain/audit-notification.ts";
import {
  CAMPAIGN_PRESENTATION_JSON_FIELD_NAMES,
  CAMPAIGN_PUBLICATION_FIELD_NAMES,
  createOwnerCampaignEditorResource,
  createOwnerCampaignPreviewDocument,
} from "../domain/owner-campaign-editor-resource.ts";
import { parseActorSubject, parseTimestamp } from "../domain/foundation.ts";
import type { ActionJsonValue } from "../domain/hypermedia-action.ts";
import { createPublicCampaignDocument } from "../domain/public-campaign-resource.ts";
import type { PublicCampaignConfiguration } from "../domain/public-campaign-configuration.ts";
import { StorageFailure, parseStorageOperationId } from "../domain/storage-adapter.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  createBrowserMutationGuard,
  hashCsrfToken,
} from "../http/mutation-security.ts";
import {
  parseCampaignSetup,
  type AtomicCampaignAuditRepository,
  type AuditedCampaignSetupSaveResult,
  type CampaignRepository,
  type CampaignSetupHistoryPage,
  type CampaignSetupRevision,
  type SaveCampaignSetupWithAuditRequest,
} from "../repositories/in-memory-campaign-repository.ts";
import type { ApplicationRouteContext } from "../worker/contracts.ts";
import { createOwnerCampaignEditorRouteHandler } from "../worker/routes/owner-campaign-editor.ts";
import { createOwnerRouteHandler } from "../worker/routes/owner.ts";
import { syntheticPublicCampaign } from "./fixtures/public-campaign.ts";
import { explicitCampaignSetup } from "./support/campaign-repository-contract.ts";

const CANONICAL_ORIGIN = "https://canonical.example";
const REQUEST_ORIGIN = "https://worker.internal";
const OWNER_SUBJECT = "owner-subject";
const CSRF_TOKEN = "campaign_editor_csrf_token_1234567890";
const NOW = new Date("2026-08-09T12:00:00.000Z");

test("one capability model exposes JSON mutation and readiness-gated publication", () => {
  const current = revision(1, false);
  const ready = createOwnerCampaignEditorResource(
    `${CANONICAL_ORIGIN}/owner/campaign`,
    current,
    { ready: true, blockers: [] },
    "atomic-campaign-audit",
    {
      save: "campaign-save:resource-test",
      publication: "campaign-publish:resource-test",
    },
  );
  const save = requiredAction(ready.document, "save-campaign-presentation");
  const publish = requiredAction(ready.document, "publish-campaign");
  assert.equal(save.type, "application/json");
  assert.deepEqual(save.fields.map(({ name }) => name), [
    ...CAMPAIGN_PRESENTATION_JSON_FIELD_NAMES,
  ]);
  assert.deepEqual(publish.fields.map(({ name }) => name), [
    ...CAMPAIGN_PUBLICATION_FIELD_NAMES,
  ]);
  assert.deepEqual(ready.presentationForm?.campaign, current.setup.publicCampaign);

  const blocked = createOwnerCampaignEditorResource(
    `${CANONICAL_ORIGIN}/owner/campaign`,
    current,
    { ready: false, blockers: ["deployment-not-ready"] },
    "atomic-campaign-audit",
    {
      save: "campaign-save:blocked",
      publication: "campaign-publish:blocked",
    },
  );
  assert.deepEqual(blocked.document.actions.map(({ name }) => name), [
    "save-campaign-presentation",
  ]);
  assert.equal(blocked.publicationForm, null);

  const published = createOwnerCampaignEditorResource(
    `${CANONICAL_ORIGIN}/owner/campaign`,
    revision(1, true),
    { ready: false, blockers: ["deployment-not-ready"] },
    "atomic-campaign-audit",
    {
      save: "campaign-save:published",
      publication: "campaign-unpublish:published",
    },
  );
  assert.ok(published.document.actions.some(({ name }) => name === "unpublish-campaign"));
});

test("configured owners receive structured HTML and JSON plus a visitor-equivalent preview", async () => {
  const repository = new TestCampaignRepository(revision(1, false));
  const handler = await routeHandler(repository);
  const json = requiredResponse(await handler(routeContext(
    "/owner/campaign",
    { accept: "application/json" },
  )));
  assert.equal(json.status, 200);
  assert.equal(json.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  const document = await json.json();
  assert.equal(document.data.publication, "unpublished");
  assert.deepEqual(document.data.publication_readiness, {
    ready: true,
    blockers: [],
  });
  assert.deepEqual(document.actions.map((action: { name: string }) => action.name), [
    "save-campaign-presentation",
    "publish-campaign",
  ]);

  const html = requiredResponse(await handler(routeContext(
    "/owner/campaign",
    { accept: "text/html" },
  )));
  const body = await html.text();
  assert.equal(html.status, 200);
  assert.match(body, /<h1>Campaign presentation<\/h1>/u);
  assert.match(body, /name="hero-summary"/u);
  assert.match(body, /data-repeatable="faq-item"/u);
  assert.match(body, /<label for="campaign-field-name">Campaign name<\/label>/u);
  assert.match(body, /Saved revision 1/u);
  assert.doesNotMatch(body, /\(JSON\)|TASK-032|features to build|implementation status/iu);

  let previewOptions: Parameters<ApplicationRouteContext["renderApplication"]>[0];
  const preview = requiredResponse(await handler(routeContext(
    "/owner/campaign/preview",
    { accept: "text/html" },
    {
      renderApplication: async (options) => {
        previewOptions = options;
        return new Response(`<h1>${options?.campaign?.name}</h1>`);
      },
    },
  )));
  assert.equal(await preview.text(), `<h1>${syntheticPublicCampaign.name}</h1>`);
  assert.equal(preview.headers.get("cache-control"), "no-store");
  assert.equal(new URL(previewOptions?.request?.url ?? "invalid:").pathname, "/");
  assert.deepEqual(previewOptions?.preview, {
    sourceRevision: 1,
    sourcePublication: "unpublished",
  });
  assert.equal(previewOptions?.campaign?.published, true);

  const previewJson = requiredResponse(await handler(routeContext(
    "/owner/campaign/preview",
    { accept: "application/json" },
  )));
  const previewDocument = await previewJson.json();
  const expected = createPublicCampaignDocument(
    `${CANONICAL_ORIGIN}/`,
    previewDocument.data.public_campaign,
  );
  assert.deepEqual(previewDocument.data.rendered, expected.data);
  assert.deepEqual(previewDocument.actions, expected.actions);
  assert.equal(previewDocument.data.source_publication, "unpublished");
});

test("owner route composition advertises the editor only when injected", async () => {
  const repository = new TestCampaignRepository(revision(1, false));
  const feature = await routeHandler(repository);
  const handler = createOwnerRouteHandler([feature], { campaignEditor: true });
  const response = requiredResponse(await handler(routeContext(
    "/owner",
    { accept: "application/json" },
  )));
  const document = await response.json();
  assert.equal(
    document.links.find((link: { rel: string[] }) =>
      link.rel.includes("campaign-editor")
    )?.href,
    `${CANONICAL_ORIGIN}/owner/campaign`,
  );
});

test("real JSON saves honor omitted optional assets and preserve unrelated setup", async () => {
  const repository = new TestCampaignRepository(revision(1, false));
  const handler = await routeHandler(repository);
  const editor = await editorDocument(handler);
  const action = requiredAction(editor, "save-campaign-presentation");
  const campaign = editedCampaign();
  const withoutOptionalAssets = {
    ...campaign,
    brandMarkUrl: undefined,
    heroImageUrl: undefined,
    socialImageUrl: undefined,
  };
  const command = jsonCommand(action, withoutOptionalAssets);

  const saved = requiredResponse(await handler(routeContext(
    "/owner/campaign",
    { accept: "application/json" },
    { request: jsonMutationRequest("/owner/campaign", command) },
  )));
  assert.equal(saved.status, 200);
  const savedDocument = await saved.json();
  assert.equal(savedDocument.data.revision, 2);
  assert.equal(savedDocument.data.public_campaign.name, campaign.name);
  assert.equal(savedDocument.data.public_campaign.brandMarkUrl, null);
  assert.equal(savedDocument.data.public_campaign.heroImageUrl, null);
  assert.equal(savedDocument.data.public_campaign.socialImageUrl, null);
  assert.equal(repository.current?.setup.phases[0]?.id, "phase:domestic");
  assert.equal(repository.current?.setup.amountAggregate.amount.currency, "SEK");
  assert.equal(resourceTransition(repository.auditEvents.at(-1)), "updated");
  assert.equal(repository.operationLookupCount > 0, true);
});

test("structured HTML form saves through the same normalized campaign command", async () => {
  const repository = new TestCampaignRepository(revision(1, false));
  const handler = await routeHandler(repository);
  const editor = await editorDocument(handler);
  const action = requiredAction(editor, "save-campaign-presentation");
  const campaign = editedCampaign();
  const parameters = structuredFormCommand(action, campaign);

  const response = requiredResponse(await handler(routeContext(
    "/owner/campaign",
    { accept: "text/html" },
    { request: formMutationRequest("/owner/campaign", parameters, "text/html") },
  )));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${CANONICAL_ORIGIN}/owner/campaign`);
  assert.equal(repository.current?.setup.publicCampaign.name, campaign.name);
  assert.deepEqual(repository.current?.setup.publicCampaign.product, campaign.product);
});

test("route security and revision failures leave campaign and audit state unchanged", async (context) => {
  const cases = [
    {
      name: "cross-origin presentation save",
      path: "/owner/campaign",
      action: "save-campaign-presentation",
      status: 403,
      request: { origin: "https://cross-origin.example" },
    },
    {
      name: "missing CSRF on publication",
      path: "/owner/campaign/publication",
      action: "publish-campaign",
      status: 403,
      request: { csrf: null },
    },
    {
      name: "incorrect CSRF on presentation save",
      path: "/owner/campaign",
      action: "save-campaign-presentation",
      status: 403,
      request: { csrf: "incorrect_campaign_csrf_token_1234567890" },
    },
    {
      name: "unexpected publication field",
      path: "/owner/campaign/publication",
      action: "publish-campaign",
      status: 400,
      command: (command: Record<string, unknown>) => ({
        ...command,
        "unexpected-field": "must be rejected",
      }),
    },
    {
      name: "stale expected revision",
      path: "/owner/campaign",
      action: "save-campaign-presentation",
      status: 412,
      command: (command: Record<string, unknown>) => ({
        ...command,
        "expected-revision": 99,
      }),
    },
  ] as const;

  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const repository = new TestCampaignRepository(revision(1, false));
      const handler = await routeHandler(repository);
      const editor = await editorDocument(handler);
      const action = requiredAction(editor, scenario.action);
      const baseCommand = scenario.action === "save-campaign-presentation"
        ? jsonCommand(action, editedCampaign())
        : actionCommand(action);
      const command = "command" in scenario
        ? scenario.command(baseCommand)
        : baseCommand;
      const initial = repository.current;
      const response = requiredResponse(await handler(routeContext(
        scenario.path,
        { accept: "application/json" },
        {
          request: jsonMutationRequest(
            scenario.path,
            command,
            "request" in scenario ? scenario.request : undefined,
          ),
        },
      )));

      assert.equal(response.status, scenario.status);
      assert.strictEqual(repository.current, initial);
      assert.equal(repository.history.length, 1);
      assert.equal(repository.auditEvents.length, 0);
      assert.equal(repository.operations.size, 0);
    });
  }
});

test("retry responses re-read current state and changed replays conflict", async () => {
  const repository = new TestCampaignRepository(revision(1, false));
  const handler = await routeHandler(repository);
  const firstEditor = await editorDocument(handler);
  const firstAction = requiredAction(firstEditor, "save-campaign-presentation");
  const firstCommand = jsonCommand(firstAction, editedCampaign("First edit"));
  const first = requiredResponse(await handler(routeContext(
    "/owner/campaign",
    { accept: "application/json" },
    { request: jsonMutationRequest("/owner/campaign", firstCommand) },
  )));
  assert.equal((await first.json()).data.revision, 2);

  const secondEditor = await editorDocument(handler);
  const secondAction = requiredAction(secondEditor, "save-campaign-presentation");
  const secondCommand = jsonCommand(secondAction, editedCampaign("Second edit"));
  const second = requiredResponse(await handler(routeContext(
    "/owner/campaign",
    { accept: "application/json" },
    { request: jsonMutationRequest("/owner/campaign", secondCommand) },
  )));
  assert.equal((await second.json()).data.revision, 3);

  const delayedReplay = requiredResponse(await handler(routeContext(
    "/owner/campaign",
    { accept: "application/json" },
    { request: jsonMutationRequest("/owner/campaign", firstCommand) },
  )));
  const replayDocument = await delayedReplay.json();
  assert.equal(replayDocument.data.revision, 3);
  assert.equal(replayDocument.data.public_campaign.name, "Second edit");
  assert.equal(repository.auditEvents.length, 2);

  const changed = structuredClone(firstCommand);
  const changedCampaign = changed["public-campaign"] as Record<string, unknown>;
  changedCampaign.name = "Changed replay";
  const conflict = requiredResponse(await handler(routeContext(
    "/owner/campaign",
    { accept: "application/json" },
    { request: jsonMutationRequest("/owner/campaign", changed) },
  )));
  assert.equal(conflict.status, 409);
  assert.equal(repository.current?.setup.publicCampaign.name, "Second edit");
});

test("publication requires intrinsic and deployment readiness while unpublish remains available", async () => {
  const blockedRepository = new TestCampaignRepository(revision(1, false));
  const blockedHandler = await routeHandler(blockedRepository, { deploymentReady: false });
  const blockedEditor = await editorDocument(blockedHandler);
  assert.deepEqual(blockedEditor.data.publication_readiness, {
    ready: false,
    blockers: ["deployment-not-ready"],
  });
  assert.equal(blockedEditor.actions.some((action: { name: string }) => action.name === "publish-campaign"), false);
  const forcedPublish = publicationCommand("publish", 1, "campaign-publish:forced");
  const blocked = requiredResponse(await blockedHandler(routeContext(
    "/owner/campaign/publication",
    { accept: "application/json" },
    { request: jsonMutationRequest("/owner/campaign/publication", forcedPublish) },
  )));
  assert.equal(blocked.status, 412);
  assert.equal((await blocked.json()).data.code, "publication_not_ready");
  assert.equal(blockedRepository.current?.setup.publicCampaign.published, false);

  const incompleteRepository = new TestCampaignRepository(revision(1, false, true));
  const incompleteHandler = await routeHandler(incompleteRepository);
  const incomplete = await editorDocument(incompleteHandler);
  assert.deepEqual(incomplete.data.publication_readiness, {
    ready: false,
    blockers: ["phase-setup-incomplete"],
  });

  const publishedRepository = new TestCampaignRepository(revision(1, true));
  const publishedHandler = await routeHandler(publishedRepository, { deploymentReady: false });
  const publishedEditor = await editorDocument(publishedHandler);
  const unpublish = requiredAction(publishedEditor, "unpublish-campaign");
  const response = requiredResponse(await publishedHandler(routeContext(
    "/owner/campaign/publication",
    { accept: "application/json" },
    { request: jsonMutationRequest(
      "/owner/campaign/publication",
      actionCommand(unpublish),
    ) },
  )));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.publication, "unpublished");
});

test("non-owners receive no campaign disclosure and non-atomic storage fails closed", async () => {
  const repository = new TestCampaignRepository(revision(1, false));
  const handler = await routeHandler(repository);
  const foreign = requiredResponse(await handler(routeContext(
    "/owner/campaign",
    { accept: "application/json" },
    {
      actor: {
        userId: "foreign-subject",
        email: "foreign@example.com",
        displayName: "foreign@example.com",
      },
      isOwner: false,
    },
  )));
  assert.equal(foreign.status, 404);
  assert.doesNotMatch(JSON.stringify(await foreign.json()), new RegExp(syntheticPublicCampaign.id, "u"));
  assert.equal(repository.readCount, 0);

  const anonymous = requiredResponse(await handler(routeContext(
    "/owner/campaign",
    { accept: "application/json" },
    { actor: null, isOwner: false },
  )));
  assert.equal(anonymous.status, 401);
  assert.equal(repository.readCount, 0);

  const readOnly = new ReadOnlyCampaignRepository(revision(1, false));
  let guardCalls = 0;
  const unavailableHandler = await routeHandler(readOnly, {
    onGuard: () => { guardCalls += 1; },
  });
  const unavailableDocument = await editorDocument(unavailableHandler);
  assert.equal(unavailableDocument.data.mutation_consistency, "unavailable");
  assert.deepEqual(unavailableDocument.actions, []);
  const attempted = requiredResponse(await unavailableHandler(routeContext(
    "/owner/campaign",
    { accept: "application/json" },
    { request: jsonMutationRequest("/owner/campaign", {}) },
  )));
  assert.equal(attempted.status, 503);
  assert.equal(guardCalls, 0);
});

test("owner editor CSS is page-scoped and the structured form remains responsive", async () => {
  const css = await readFile(new URL("../public/owner-campaign.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /(^|\})\s*(?::root|body|html|a|button|input|textarea|select|h[1-6])\b/mu);
  assert.doesNotMatch(css, /gradient\s*\(/iu);
  assert.match(css, /\.owner-campaign-page \*/u);
  assert.match(css, /@media \(max-width: 760px\)/u);

  const repository = new TestCampaignRepository(revision(1, false));
  const handler = await routeHandler(repository);
  const response = requiredResponse(await handler(routeContext(
    "/owner/campaign",
    { accept: "text/html" },
  )));
  const body = await response.text();
  assert.equal((body.match(/<h1\b/gu) ?? []).length, 1);
  assert.equal((body.match(/<label\b/gu) ?? []).length > 20, true);
  assert.match(body, /<meta name="viewport"/u);
  assert.match(body, /<script src="\/owner-campaign\.js" defer><\/script>/u);
});

async function routeHandler(
  repository: CampaignRepository,
  options: Readonly<{
    deploymentReady?: boolean;
    onGuard?: () => void;
  }> = {},
) {
  const tokenHash = await hashCsrfToken(CSRF_TOKEN);
  let operationSequence = 0;
  let clockSequence = 0;
  return createOwnerCampaignEditorRouteHandler({
    repository,
    checkPublicationReadiness: async () => options.deploymentReady ?? true,
    guardMutation: createBrowserMutationGuard({
      allowedOrigins: [CANONICAL_ORIGIN],
      maxBodyBytes: 1_048_576,
      maxFields: 256,
      now: () => NOW,
      resolveSession: async () => {
        options.onGuard?.();
        const subject = parseActorSubject(OWNER_SUBJECT);
        const expiresAt = parseTimestamp("2026-08-09T13:00:00.000Z");
        assert(subject.ok);
        assert(expiresAt.ok);
        return {
          actor: { type: "owner", subject: subject.value },
          expiresAt: expiresAt.value,
          csrf: { tokenHash, expiresAt: expiresAt.value },
        };
      },
    }),
    csrfToken: async () => CSRF_TOKEN,
    issueOperationId: (kind) =>
      `campaign-${kind}:route-${String(++operationSequence).padStart(3, "0")}`,
    now: () => new Date(NOW.valueOf() + clockSequence++ * 1_000),
  });
}

function routeContext(
  pathname: string,
  headers: HeadersInit,
  overrides: Readonly<{
    request?: Request;
    actor?: ApplicationRouteContext["actor"];
    isOwner?: boolean;
    renderApplication?: ApplicationRouteContext["renderApplication"];
  }> = {},
): ApplicationRouteContext {
  const request = overrides.request ?? new Request(`${REQUEST_ORIGIN}${pathname}`, { headers });
  return {
    request,
    url: new URL(request.url),
    resourceUrl: `${CANONICAL_ORIGIN}${pathname}`,
    actor: Object.hasOwn(overrides, "actor")
      ? overrides.actor ?? null
      : {
          userId: OWNER_SUBJECT,
          email: "owner@example.com",
          displayName: "owner@example.com",
        },
    isOwner: overrides.isOwner ?? true,
    participantAccess: null,
    campaign: syntheticPublicCampaign,
    renderApplication: overrides.renderApplication ?? (async () => new Response("preview")),
  };
}

function jsonMutationRequest(
  pathname: string,
  body: unknown,
  options: Readonly<{
    origin?: string | null;
    csrf?: string | null;
  }> = {},
): Request {
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  if (options.origin !== null) {
    headers.set("Origin", options.origin ?? CANONICAL_ORIGIN);
  }
  if (options.csrf !== null) {
    headers.set(MUTATION_CSRF_HEADER, options.csrf ?? CSRF_TOKEN);
  }
  return new Request(`${REQUEST_ORIGIN}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function formMutationRequest(
  pathname: string,
  body: URLSearchParams,
  accept = "application/json",
): Request {
  return new Request(`${REQUEST_ORIGIN}${pathname}`, {
    method: "POST",
    headers: {
      Accept: accept,
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: CANONICAL_ORIGIN,
    },
    body,
  });
}

async function editorDocument(
  handler: ReturnType<typeof createOwnerCampaignEditorRouteHandler>,
) {
  const response = requiredResponse(await handler(routeContext(
    "/owner/campaign",
    { accept: "application/json" },
  )));
  assert.equal(response.status, 200);
  return response.json();
}

function requiredAction(
  document: { actions: readonly Readonly<{ name: string; href: string; type: string; fields: readonly Readonly<{ name: string; value?: ActionJsonValue; default?: ActionJsonValue }>[] }>[] },
  name: string,
) {
  const action = document.actions.find((candidate) => candidate.name === name);
  assert.ok(action);
  return action;
}

function actionCommand(action: ReturnType<typeof requiredAction>): Record<string, unknown> {
  const command: Record<string, unknown> = {};
  for (const field of action.fields) {
    const value = field.value ?? field.default;
    assert.notEqual(value, undefined, `Missing action value for ${field.name}`);
    command[field.name] = value;
  }
  return command;
}

function jsonCommand(
  action: ReturnType<typeof requiredAction>,
  campaign: unknown,
): Record<string, unknown> {
  const command = actionCommand(action);
  command["public-campaign"] = campaign;
  return command;
}

function publicationCommand(
  command: "publish" | "unpublish",
  revisionNumber: number,
  operationId: string,
): Record<string, unknown> {
  return {
    "operation-id": operationId,
    "expected-revision": revisionNumber,
    "publication-command": command,
  };
}

function structuredFormCommand(
  action: ReturnType<typeof requiredAction>,
  campaign: PublicCampaignConfiguration,
): URLSearchParams {
  const actionValues = actionCommand(action);
  const parameters = new URLSearchParams({
    [MUTATION_CSRF_FIELD]: CSRF_TOKEN,
    "operation-id": String(actionValues["operation-id"]),
    "expected-revision": String(actionValues["expected-revision"]),
    "campaign-id": campaign.id,
    status: campaign.status,
    name: campaign.name,
    "page-title": campaign.pageTitle,
    "page-description": campaign.pageDescription,
    "phase-label": campaign.phaseLabel,
    "status-label": campaign.statusLabel,
    "brand-mark-url": campaign.brandMarkUrl ?? "",
    "hero-image-url": campaign.heroImageUrl ?? "",
    "social-image-url": campaign.socialImageUrl ?? "",
    "hero-summary": campaign.hero.summary,
    "hero-invitation": campaign.hero.invitation,
    "hero-primary-action-label": campaign.hero.primaryActionLabel,
    "hero-secondary-label": campaign.hero.secondaryAction?.label ?? "",
    "hero-secondary-href": campaign.hero.secondaryAction?.href ?? "",
    "hero-note": campaign.hero.note,
    "participation-eyebrow": campaign.participation.eyebrow,
    "participation-title": campaign.participation.title,
    "risks-eyebrow": campaign.risks.eyebrow,
    "risks-title": campaign.risks.title,
    "closing-eyebrow": campaign.closing.eyebrow,
    "closing-title": campaign.closing.title,
    "closing-action-label": campaign.closing.actionLabel,
    "footer-tagline": campaign.footer.tagline,
  });
  if (campaign.hero.secondaryAction) parameters.set("hero-secondary-enabled", "true");
  campaign.navigation.forEach((item, index) => setRow(parameters, "navigation", index, item));
  campaign.facts.forEach((item, index) => setRow(parameters, "fact", index, item));
  campaign.participation.paths.forEach((item, index) => setRow(parameters, "participation-path", index, {
    kind: item.kind,
    title: item.title,
    description: item.description,
    "action-label": item.actionLabel,
  }));
  if (campaign.product) {
    parameters.set("product-enabled", "true");
    parameters.set("product-eyebrow", campaign.product.eyebrow);
    parameters.set("product-title", campaign.product.title);
    parameters.set("product-description", campaign.product.description);
    campaign.product.links.forEach((item, index) => setLinkRow(parameters, "product-link", index, item));
    campaign.product.capabilities.forEach((item, index) => setRow(parameters, "product-capability", index, item));
  }
  if (campaign.process) {
    parameters.set("process-enabled", "true");
    parameters.set("process-eyebrow", campaign.process.eyebrow);
    parameters.set("process-title", campaign.process.title);
    campaign.process.steps.forEach((item, index) => setRow(parameters, "process-step", index, item));
  }
  campaign.risks.items.forEach((item, index) => setRow(parameters, "risk", index, { text: item }));
  if (campaign.faq) {
    parameters.set("faq-enabled", "true");
    parameters.set("faq-eyebrow", campaign.faq.eyebrow);
    parameters.set("faq-title", campaign.faq.title);
    campaign.faq.items.forEach((item, index) => setRow(parameters, "faq-item", index, item));
  }
  campaign.footer.links.forEach((item, index) => setLinkRow(parameters, "footer-link", index, item));
  return parameters;
}

function setRow(
  parameters: URLSearchParams,
  prefix: string,
  index: number,
  values: Readonly<Record<string, string>>,
): void {
  for (const [name, value] of Object.entries(values)) {
    parameters.set(`${prefix}-${index}-${name}`, value);
  }
}

function setLinkRow(
  parameters: URLSearchParams,
  prefix: string,
  index: number,
  link: Readonly<{ label: string; href: string; rel: readonly string[] }>,
): void {
  setRow(parameters, prefix, index, {
    label: link.label,
    href: link.href,
    rel: link.rel.join(" "),
  });
}

function requiredResponse(response: Response | null): Response {
  assert.ok(response);
  return response;
}

function resourceTransition(event: AuditEvent | undefined) {
  return event?.detail.kind === "resource-transition"
    ? event.detail.transition
    : null;
}

function editedCampaign(name = "Northstar Systems"): PublicCampaignConfiguration {
  return {
    ...syntheticPublicCampaign,
    published: false,
    status: "closed",
    name,
    pageTitle: `${name} interest registration`,
    pageDescription: "Review the updated campaign and its non-binding participation paths.",
    phaseLabel: "Updated registration phase",
    statusLabel: "Registration paused",
    brandMarkUrl: "/media/brand-mark.png",
    heroImageUrl: "https://media.example/hero.png",
    socialImageUrl: "/media/social-card.png",
    hero: {
      ...syntheticPublicCampaign.hero,
      summary: "Updated industrial inspection systems.",
    },
  };
}

function revision(
  number: number,
  published: boolean,
  incompletePhase = false,
): CampaignSetupRevision {
  const operationId = parseStorageOperationId(`campaign-operation:revision-${number}`);
  const recordedAt = parseTimestamp(`2026-08-09T0${number}:00:00.000Z`);
  const base = explicitCampaignSetup();
  const setup = parseCampaignSetup({
    ...base,
    publicCampaign: { ...syntheticPublicCampaign, published },
    phases: incompletePhase
      ? [{ ...base.phases[0], enabledParticipationPaths: [] }]
      : base.phases,
  });
  assert(operationId.ok);
  assert(recordedAt.ok);
  assert(setup.ok);
  return Object.freeze({
    revision: number,
    operationId: operationId.value,
    recordedAt: recordedAt.value,
    setup: setup.value,
  });
}

class TestCampaignRepository implements AtomicCampaignAuditRepository {
  readonly mutationConsistency = "atomic-campaign-audit" as const;
  current: CampaignSetupRevision | null;
  readonly history: CampaignSetupRevision[];
  readonly auditEvents: AuditEvent[] = [];
  readonly operations = new Map<string, Readonly<{
    fingerprint: string;
    result: AuditedCampaignSetupSaveResult;
  }>>();
  readCount = 0;
  operationLookupCount = 0;

  constructor(current: CampaignSetupRevision | null) {
    this.current = current;
    this.history = current ? [current] : [];
  }

  async readSetup(): Promise<CampaignSetupRevision | null> {
    this.readCount += 1;
    return this.current;
  }

  async findSetupByOperationId(operationId: unknown): Promise<CampaignSetupRevision | null> {
    this.operationLookupCount += 1;
    const parsed = parseStorageOperationId(operationId);
    if (!parsed.ok) throw new StorageFailure("INVALID_REQUEST");
    return this.operations.get(parsed.value)?.result.campaign ?? null;
  }

  async saveSetup(): Promise<CampaignSetupRevision> {
    throw new StorageFailure("UNAVAILABLE");
  }

  async listSetupHistory(): Promise<CampaignSetupHistoryPage> {
    return { items: Object.freeze([...this.history]), nextCursor: null };
  }

  async saveSetupWithAudit(
    request: SaveCampaignSetupWithAuditRequest,
  ): Promise<AuditedCampaignSetupSaveResult> {
    const operationId = parseStorageOperationId(request.operationId);
    const recordedAt = parseTimestamp(request.recordedAt);
    const ownerSubject = parseActorSubject(request.ownerSubject);
    const setup = parseCampaignSetup(request.setup);
    if (!operationId.ok || !recordedAt.ok || !ownerSubject.ok || !setup.ok) {
      throw new StorageFailure("INVALID_REQUEST");
    }
    const fingerprint = JSON.stringify(request);
    const prior = this.operations.get(operationId.value);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new StorageFailure("CONFLICT");
      return Object.freeze({ ...prior.result, replayed: true });
    }
    if (this.current === null || this.current.revision !== request.expectedRevision) {
      throw new StorageFailure("PRECONDITION_FAILED");
    }
    const before = this.current.setup.publicCampaign.published;
    const after = setup.value.publicCampaign.published;
    const validTransition = request.transition === "updated"
      ? before === after
      : request.transition === "published"
        ? !before && after
        : before && !after;
    if (!validTransition) throw new StorageFailure("INVALID_REQUEST");
    const campaign = Object.freeze({
      revision: this.current.revision + 1,
      operationId: operationId.value,
      recordedAt: recordedAt.value,
      setup: setup.value,
    });
    const intent = parseAuditAppendIntent({
      type: "append-audit-event",
      event: {
        id: `campaign-audit:route-${campaign.revision}`,
        operationId: operationId.value,
        occurredAt: recordedAt.value,
        actor: { type: "owner", subject: ownerSubject.value },
        detail: {
          kind: "resource-transition",
          resource: {
            type: "campaign",
            id: `campaign:${campaign.setup.publicCampaign.id}`,
          },
          transition: request.transition,
        },
      },
    });
    if (!intent.ok) throw new StorageFailure("INVALID_REQUEST");
    const result = Object.freeze({
      campaign,
      auditEvent: intent.value.event,
      replayed: false,
    });
    this.current = campaign;
    this.history.push(campaign);
    this.auditEvents.push(intent.value.event);
    this.operations.set(operationId.value, { fingerprint, result });
    return result;
  }
}

class ReadOnlyCampaignRepository implements CampaignRepository {
  current: CampaignSetupRevision | null;

  constructor(current: CampaignSetupRevision | null) {
    this.current = current;
  }

  async readSetup(): Promise<CampaignSetupRevision | null> {
    return this.current;
  }

  async findSetupByOperationId(): Promise<CampaignSetupRevision | null> {
    return null;
  }

  async saveSetup(): Promise<CampaignSetupRevision> {
    throw new StorageFailure("UNAVAILABLE");
  }

  async listSetupHistory(): Promise<CampaignSetupHistoryPage> {
    return { items: this.current ? [this.current] : [], nextCursor: null };
  }
}

test("preview resource directly shares visitor capabilities", () => {
  const current = revision(1, false);
  const preview = createOwnerCampaignPreviewDocument(
    `${CANONICAL_ORIGIN}/owner/campaign/preview`,
    current,
  );
  const visitor = createPublicCampaignDocument(
    `${CANONICAL_ORIGIN}/`,
    preview.data.public_campaign,
  );
  assert.deepEqual(preview.actions, visitor.actions);
  assert.deepEqual(preview.data.rendered, visitor.data);
});
