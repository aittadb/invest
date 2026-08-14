import assert from "node:assert/strict";
import test from "node:test";

import {
  parseActorSubject,
  parseTimestamp,
  type ActorSubject,
} from "../domain/foundation.ts";
import type {
  HypermediaAction,
} from "../domain/hypermedia-action.ts";
import type { OwnerPackageDocument } from "../domain/owner-package-resource.ts";
import {
  parseStorageOperationId,
} from "../domain/storage-adapter.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  MUTATION_METHOD_FIELD,
  createBrowserMutationGuard,
  hashCsrfToken,
  type TrustedMutationSession,
} from "../http/mutation-security.ts";
import { InMemoryPackageVersionRepository } from "../repositories/in-memory-content-repository.ts";
import { RepositoryOwnerPackageWorkspaceService } from "../services/owner-package-workspace.ts";
import { createApplicationWorker } from "../worker/application-worker.ts";
import type {
  InvestorAppEnv,
  WorkerExecutionContext,
} from "../worker/contracts.ts";
import { MemoryStorageAdapter } from "./support/memory-storage-adapter.ts";

const ORIGIN = "https://campaign.example";
const REQUEST_ORIGIN = "https://worker.internal";
const CSRF_TOKEN = "owner_csrf_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const OWNER_EMAIL = "owner@example.com";
const OWNER_SUBJECT = "oidc:configured-owner";

const executionContext: WorkerExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

test("owner package resources authorize callers and expose owner JSON CSRF discovery", async () => {
  const fixture = await routeFixture();
  await fixture.workspace.createSection(fixture.owner, {
    operationId: "package-operation:private-seed",
    expectedRevision: 0,
    title: "Private strategy",
    markdown: "Private package value that must not be disclosed.",
    enabled: true,
    acknowledgmentText: "I acknowledge the private package.",
    changeSummary: "Initial private package",
    materialChange: false,
  });

  const anonymousJson = await fixture.fetch("/owner/package", {
    accept: "application/json",
  });
  assert.equal(anonymousJson.status, 401);
  assert.equal(anonymousJson.headers.get(MUTATION_CSRF_HEADER), null);
  assert.equal((await anonymousJson.json()).data.code, "authentication_required");

  const anonymousHtml = await fixture.fetch("/owner/package", {
    accept: "text/html",
  });
  assert.equal(anonymousHtml.status, 302);
  assert.match(
    anonymousHtml.headers.get("location") ?? "",
    /\/signin-with-chatgpt\?return_to=%2Fowner%2Fpackage$/,
  );

  const foreign = await fixture.fetch(
    "/owner/package",
    ownerRequestHeaders("application/json", {
      subject: "oidc:foreign",
      email: "foreign@example.com",
    }),
  );
  const foreignBody = await foreign.text();
  assert.equal(foreign.status, 404);
  assert.equal(foreign.headers.get(MUTATION_CSRF_HEADER), null);
  assert.doesNotMatch(foreignBody, /Private strategy|Private package value/u);

  const owner = await fixture.fetch(
    "/owner/package",
    ownerRequestHeaders("application/json"),
  );
  assert.equal(owner.status, 200);
  assert.equal(owner.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  const document = await owner.json() as OwnerPackageDocument;
  assert.equal(document.type, "owner-information-package");
  assert.equal(document.data.sections[0]?.title, "Private strategy");
  assert.equal(document.links.every((link) => link.href.startsWith(ORIGIN)), true);
  assert.equal(document.actions.every((action) => action.href.startsWith(ORIGIN)), true);
  assert.doesNotMatch(JSON.stringify(document), /worker\.internal/u);

  fixture.setCsrfToken("invalid");
  const invalidCsrf = await fixture.fetch(
    "/owner/package",
    ownerRequestHeaders("application/json"),
  );
  assert.equal(invalidCsrf.status, 503);
  assert.equal(invalidCsrf.headers.get(MUTATION_CSRF_HEADER), null);
  fixture.setCsrfToken(CSRF_TOKEN);

  const ownerHome = await fixture.fetch(
    "/owner",
    ownerRequestHeaders("application/json"),
  );
  assert.equal(ownerHome.status, 200);
  assert.ok(
    (await ownerHome.json()).actions.some(
      (action: { name: string }) => action.name === "manage-information-package",
    ),
  );

  const unsupported = await fixture.fetch(
    "/owner/package",
    ownerRequestHeaders(
      "application/vnd.aittadb-invest+json; version=9.0",
    ),
  );
  assert.equal(unsupported.status, 406);
});

test("owner package mutations reject unknown fields and enforce guarded retry rules", async () => {
  const fixture = await routeFixture();
  const empty = await fixture.ownerDocument();
  const create = requiredAction(empty, "create-package-section");
  const values = {
    title: "Overview",
    markdown: "Safe private copy.",
    enabled: true,
    "acknowledgment-text": "I acknowledge this package.",
    "change-summary": "Created overview",
  };

  const crossOrigin = await fixture.submit(create, values, {
    origin: "https://attacker.example",
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).data.code, "REQUEST_REJECTED");
  assert.equal(await fixture.workspace.read(fixture.owner), null);

  const missingCsrf = await fixture.submit(create, values, { csrf: false });
  assert.equal(missingCsrf.status, 403);
  assert.equal(await fixture.workspace.read(fixture.owner), null);

  fixture.setSessionSubject("oidc:different-owner-session");
  const mismatchedSubject = await fixture.submit(create, values);
  assert.equal(mismatchedSubject.status, 404);
  fixture.setSessionSubject(OWNER_SUBJECT);

  const unknownField = await fixture.submit(create, values, {
    extraFields: { "owner-subject": "spoofed-owner" },
  });
  assert.equal(unknownField.status, 400);
  assert.equal((await unknownField.json()).data.code, "INVALID_REQUEST");
  assert.equal(await fixture.workspace.read(fixture.owner), null);

  const created = await fixture.submit(create, values);
  assert.equal(created.status, 200);
  assert.equal((await created.json()).data.revision, 1);

  const retry = await fixture.submit(create, values);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).data.revision, 1);

  const htmlRetry = await fixture.submit(create, values, {
    accept: "text/html",
  });
  assert.equal(htmlRetry.status, 303);
  assert.equal(htmlRetry.headers.get("location"), `${ORIGIN}/owner/package`);

  const changedRetry = await fixture.submit(create, {
    ...values,
    title: "Changed retry",
  });
  assert.equal(changedRetry.status, 409);
  assert.doesNotMatch(await changedRetry.text(), /Changed retry/u);

  const firstRevisionA = await fixture.ownerDocument();
  const firstRevisionB = await fixture.ownerDocument();
  const createA = requiredAction(firstRevisionA, "create-package-section");
  const createB = requiredAction(firstRevisionB, "create-package-section");
  const second = await fixture.submit(createA, {
    title: "Details",
    markdown: "More safe copy.",
    enabled: true,
    "change-summary": "Added details",
  });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).data.revision, 2);

  const stale = await fixture.submit(createB, {
    title: "Stale section",
    markdown: "Stale copy.",
    enabled: true,
    "change-summary": "Stale version",
  });
  assert.equal(stale.status, 412);

  const current = await fixture.ownerDocument();
  const unsafe = await fixture.submit(
    requiredAction(current, "create-package-section"),
    {
      title: "Unsafe",
      markdown: "<script>privateValue()</script>",
      enabled: true,
      "change-summary": "Unsafe version",
    },
  );
  const unsafeBody = await unsafe.text();
  assert.equal(unsafe.status, 400);
  assert.doesNotMatch(unsafeBody, /script|privateValue/u);
  assert.equal((await fixture.workspace.read(fixture.owner))?.revision, 2);
});

test("HTML and JSON expose the same package controls and sanitized preview behavior", async () => {
  const fixture = await routeFixture();
  let document = await fixture.ownerDocument();
  let response = await fixture.submit(
    requiredAction(document, "create-package-section"),
    {
      title: "Overview",
      markdown: "## Overview\n\n**Private** [details](https://example.test/details).",
      enabled: true,
      "acknowledgment-text": "I acknowledge this information package.",
      "change-summary": "Created overview",
    },
  );
  document = await response.json() as OwnerPackageDocument;

  response = await fixture.submit(
    requiredAction(document, "create-package-section"),
    {
      title: "Terms",
      markdown: "## Terms\n\nDraft terms.",
      enabled: false,
      "change-summary": "Added draft terms",
    },
  );
  document = await response.json() as OwnerPackageDocument;
  const terms = requiredSection(document, "Terms");

  response = await fixture.submit(
    requiredNestedAction(terms, "move-package-section"),
    {
      direction: "up",
      "change-summary": "Moved terms first",
    },
  );
  document = await response.json() as OwnerPackageDocument;
  assert.deepEqual(
    document.data.sections.map((section) => section.title),
    ["Terms", "Overview"],
  );

  response = await fixture.submit(
    requiredNestedAction(
      requiredSection(document, "Terms"),
      "set-package-section-availability",
    ),
    {
      enabled: true,
      "change-summary": "Enabled terms",
    },
  );
  document = await response.json() as OwnerPackageDocument;
  assert.equal(requiredSection(document, "Terms").enabled, true);

  response = await fixture.submit(
    requiredNestedAction(
      requiredSection(document, "Terms"),
      "update-package-section",
    ),
    {
      title: "Terms",
      markdown: "## Terms\n\nMaterially revised **terms**.",
      "change-summary": "Changed terms materially",
      "material-change": true,
    },
  );
  document = await response.json() as OwnerPackageDocument;
  assert.equal(document.data.current_version?.material_change, true);
  assert.equal(
    document.data.current_version?.change_summary,
    "Changed terms materially",
  );

  response = await fixture.submit(
    requiredAction(document, "update-package-settings"),
    {
      "acknowledgment-text": "I acknowledge the current package.",
      "change-summary": "Clarified acknowledgment",
    },
  );
  document = await response.json() as OwnerPackageDocument;
  assert.equal(
    document.data.current_version?.acknowledgment_text,
    "I acknowledge the current package.",
  );

  const previewJson = await fixture.fetch(
    "/owner/package/preview",
    ownerRequestHeaders("application/json"),
  );
  assert.equal(previewJson.status, 200);
  const previewDocument = await previewJson.json();
  assert.deepEqual(
    previewDocument.data.sections.map((section: { title: string }) => section.title),
    ["Terms", "Overview"],
  );

  const previewHtmlResponse = await fixture.fetch(
    "/owner/package/preview",
    ownerRequestHeaders("text/html"),
  );
  const previewHtml = await previewHtmlResponse.text();
  assert.equal(previewHtmlResponse.status, 200);
  assert.match(previewHtml, /<strong>terms<\/strong>/u);
  assert.match(previewHtml, /href="https:\/\/example\.test\/details"/u);
  assert.doesNotMatch(previewHtml, /<script|javascript:/iu);
  assert.equal((previewHtml.match(/<h1[ >]/g) ?? []).length, 1);

  const workspaceJsonResponse = await fixture.fetch(
    "/owner/package",
    ownerRequestHeaders("application/json"),
  );
  assert.equal(workspaceJsonResponse.status, 200);
  const discoveredCsrfToken = workspaceJsonResponse.headers.get(
    MUTATION_CSRF_HEADER,
  );
  assert.equal(discoveredCsrfToken, CSRF_TOKEN);
  document = await workspaceJsonResponse.json() as OwnerPackageDocument;

  const htmlResponse = await fixture.fetch(
    "/owner/package",
    ownerRequestHeaders("text/html"),
  );
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.match(
    html,
    new RegExp(
      `name="${MUTATION_CSRF_FIELD}" value="${discoveredCsrfToken}"`,
    ),
  );
  assert.doesNotMatch(JSON.stringify(document), new RegExp(CSRF_TOKEN));
  assert.deepEqual(actionNamesFromHtml(html), actionNamesFromDocument(document));
  assertHtmlActionParity(html, document);
  assert.match(html, /name="_method" value="PATCH"/u);
});

async function routeFixture() {
  const repository = new InMemoryPackageVersionRepository(
    new MemoryStorageAdapter(),
  );
  let minute = 0;
  const workspace = new RepositoryOwnerPackageWorkspaceService(repository, {
    now: () => new Date(`2026-08-09T11:${String(minute++).padStart(2, "0")}:00.000Z`),
  });
  const owner = Object.freeze({
    type: "owner" as const,
    subject: actorSubject(OWNER_SUBJECT),
  });
  let sessionSubject = OWNER_SUBJECT;
  const csrfHash = await hashCsrfToken(CSRF_TOKEN);
  const verifyMutation = createBrowserMutationGuard({
    allowedOrigins: [ORIGIN],
    now: () => new Date("2026-08-09T12:00:00.000Z"),
    resolveSession: async () => trustedSession(sessionSubject, csrfHash),
    maxBodyBytes: 262_144,
  });
  let operation = 0;
  let issuedCsrfToken: string | null = CSRF_TOKEN;
  const worker = createApplicationWorker({
    fetchApplication: async () => new Response("application fallback", { status: 404 }),
    fetchOptimizedImage: async () => new Response("image"),
    ownerPackage: {
      workspace,
      verifyMutation,
      csrfToken: async () => issuedCsrfToken,
      issueOperationId: () => operationId(`package-action:${++operation}`),
    },
  });
  const env = environment();

  const fetch = (path: string, headers: HeadersInit) =>
    worker.fetch(
      new Request(new URL(path, REQUEST_ORIGIN), { headers }),
      env,
      executionContext,
    );
  const ownerDocument = async (): Promise<OwnerPackageDocument> => {
    const response = await fetch(
      "/owner/package",
      ownerRequestHeaders("application/json"),
    );
    assert.equal(response.status, 200);
    return response.json() as Promise<OwnerPackageDocument>;
  };
  const submit = async (
    action: HypermediaAction,
    values: Readonly<Record<string, unknown>>,
    options: Readonly<{
      origin?: string;
      csrf?: boolean;
      accept?: string;
      extraFields?: Readonly<Record<string, string>>;
    }> = {},
  ): Promise<Response> => {
    const body = new URLSearchParams();
    for (const field of action.fields) {
      const value = Object.hasOwn(values, field.name)
        ? values[field.name]
        : field.value ?? field.default;
      if (field.type === "boolean") {
        if (value === true) body.set(field.name, "true");
      } else if (value !== undefined && value !== null) {
        body.set(field.name, String(value));
      }
    }
    for (const [name, value] of Object.entries(options.extraFields ?? {})) {
      body.set(name, value);
    }
    if (action.method !== "POST") body.set(MUTATION_METHOD_FIELD, action.method);
    if (options.csrf !== false) body.set(MUTATION_CSRF_FIELD, CSRF_TOKEN);

    return worker.fetch(
      new Request(action.href, {
        method: "POST",
        headers: {
          ...ownerRequestHeaders(options.accept ?? "application/json"),
          "content-type": "application/x-www-form-urlencoded",
          origin: options.origin ?? ORIGIN,
        },
        body,
      }),
      env,
      executionContext,
    );
  };

  return {
    owner,
    repository,
    workspace,
    fetch,
    ownerDocument,
    submit,
    setSessionSubject(value: string) {
      sessionSubject = value;
    },
    setCsrfToken(value: string | null) {
      issuedCsrfToken = value;
    },
  };
}

function ownerRequestHeaders(
  accept: string,
  identity: Readonly<{ subject?: string; email?: string }> = {},
): HeadersInit {
  return {
    accept,
    "oai-authenticated-user-id": identity.subject ?? OWNER_SUBJECT,
    "oai-authenticated-user-email": identity.email ?? OWNER_EMAIL,
  };
}

function trustedSession(
  subject: string,
  tokenHash: TrustedMutationSession["csrf"]["tokenHash"],
): TrustedMutationSession {
  return Object.freeze({
    actor: Object.freeze({ type: "owner", subject: actorSubject(subject) }),
    expiresAt: timestamp("2026-08-09T13:00:00.000Z"),
    csrf: Object.freeze({
      tokenHash,
      expiresAt: timestamp("2026-08-09T12:30:00.000Z"),
    }),
  });
}

function requiredAction(
  document: OwnerPackageDocument,
  name: string,
): HypermediaAction {
  const action = document.actions.find((candidate) => candidate.name === name);
  assert.ok(action, `Missing action ${name}`);
  return action;
}

function requiredNestedAction(
  section: OwnerPackageDocument["data"]["sections"][number],
  name: string,
): HypermediaAction {
  const action = section.actions.find((candidate) => candidate.name === name);
  assert.ok(action, `Missing section action ${name}`);
  return action;
}

function requiredSection(
  document: OwnerPackageDocument,
  title: string,
): OwnerPackageDocument["data"]["sections"][number] {
  const section = document.data.sections.find((candidate) => candidate.title === title);
  assert.ok(section, `Missing section ${title}`);
  return section;
}

function actionNamesFromDocument(document: OwnerPackageDocument): string[] {
  return [
    ...document.actions.map((action) => action.name),
    ...document.data.sections.flatMap((section) =>
      section.actions.map((action) => action.name)
    ),
  ].sort();
}

function actionNamesFromHtml(html: string): string[] {
  return [...html.matchAll(/data-action="([a-z0-9-]+)"/g)]
    .map((match) => match[1] ?? "")
    .filter(Boolean)
    .sort();
}

function assertHtmlActionParity(
  html: string,
  document: OwnerPackageDocument,
): void {
  const actions = [
    ...document.actions,
    ...document.data.sections.flatMap((section) => section.actions),
  ];
  for (const action of actions) {
    if (action.method === "GET") {
      assert.match(
        html,
        new RegExp(
          `<a[^>]*data-action="${escapeRegExp(action.name)}"[^>]*href="${escapeRegExp(action.href)}"`,
          "u",
        ),
      );
      continue;
    }

    const form = new RegExp(
      `<form[^>]*data-action="${escapeRegExp(action.name)}"[^>]*action="${escapeRegExp(action.href)}"[\\s\\S]*?<\\/form>`,
      "u",
    ).exec(html)?.[0];
    assert.ok(form, `Missing HTML form for ${action.name} at ${action.href}`);
    assert.match(form, /method="post"/u);
    if (action.method !== "POST") {
      assert.match(
        form,
        new RegExp(`name="_method" value="${action.method}"`, "u"),
      );
    }
    for (const field of action.fields) {
      assert.match(
        form,
        new RegExp(`name="${escapeRegExp(field.name)}"`, "u"),
      );
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function environment(): InvestorAppEnv {
  return {
    APP_BASE_URL: ORIGIN,
    OWNER_EMAIL,
    ASSETS: { fetch: async () => new Response("asset") },
    IMAGES: {
      input() {
        throw new Error("Image optimization is outside this route test.");
      },
    },
  };
}

function actorSubject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  assert(parsed.ok);
  return parsed.value;
}

function timestamp(value: string) {
  const parsed = parseTimestamp(value);
  assert(parsed.ok);
  return parsed.value;
}

function operationId(value: string) {
  const parsed = parseStorageOperationId(value);
  assert(parsed.ok);
  return parsed.value;
}
