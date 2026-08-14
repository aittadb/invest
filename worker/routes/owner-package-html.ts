import type {
  HtmlFormAction,
  HtmlFormField,
} from "../../domain/hypermedia-action.ts";
import type {
  OwnerPackagePreviewDocument,
  OwnerPackageResourceModel,
} from "../../domain/owner-package-resource.ts";
import { renderSafeMarkdownHtml } from "../../domain/safe-markdown-html.ts";

const INTERNAL_FIELDS = new Set(["operation-id", "expected-revision"]);

export function ownerPackageWorkspaceHtmlResponse(
  model: OwnerPackageResourceModel,
  csrfToken: string,
): Response {
  const { document } = model;
  const version = document.data.current_version;
  const previewLink = model.preview === null
    ? ""
    : `<a class="package-button package-button--quiet" data-action="${escapeAttribute(model.preview.contract.name)}" href="${escapeAttribute(model.preview.contract.href)}">Preview</a>`;
  const versionSummary = version === null
    ? `<p class="package-empty">No package version has been created.</p>`
    : `<dl class="package-version-meta">
        <div><dt>Version</dt><dd>${document.data.revision}</dd></div>
        <div><dt>Created</dt><dd><time datetime="${escapeAttribute(version.created_at)}">${escapeHtml(version.created_at)}</time></dd></div>
        <div><dt>Change</dt><dd>${escapeHtml(version.change_summary)}</dd></div>
        <div><dt>Classification</dt><dd>${version.material_change ? "Material" : "Non-material"}</dd></div>
      </dl>`;
  const sections = model.sections.length === 0
    ? `<p class="package-empty">No sections yet.</p>`
    : `<ol class="package-section-list">${model.sections.map((item) => `
        <li>
          <article class="package-section-row">
            <header>
              <div>
                <span class="package-order">${item.section.order + 1}</span>
                <h2>${escapeHtml(item.section.title)}</h2>
              </div>
              <span class="package-state">${item.section.enabled ? "Enabled" : "Disabled"}</span>
            </header>
            <pre class="package-markdown">${escapeHtml(item.section.markdown)}</pre>
            <div class="package-section-controls">
              <details>
                <summary>Edit</summary>
                ${renderForm(item.update.form, csrfToken)}
              </details>
              <details>
                <summary>Availability</summary>
                ${renderForm(item.availability.form, csrfToken)}
              </details>
              ${item.reorder === null
                ? ""
                : `<details><summary>Order</summary>${renderForm(item.reorder.form, csrfToken)}</details>`}
            </div>
          </article>
        </li>`).join("")}</ol>`;
  const createSection = model.createSection === null
    ? `<p class="package-empty">The section limit has been reached.</p>`
    : renderForm(model.createSection.form, csrfToken);
  const settings = model.updateSettings === null
    ? ""
    : `<section class="package-settings" aria-labelledby="package-settings-title">
        <h2 id="package-settings-title">Acknowledgment</h2>
        ${renderForm(model.updateSettings.form, csrfToken)}
      </section>`;

  return htmlResponse(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Information package</title>
    <link rel="stylesheet" href="/owner-package.css">
  </head>
  <body class="package-owner-page">
    ${ownerHeader("Information package")}
    <main class="package-owner-main">
      <div class="package-title-row">
        <div>
          <p class="package-kicker">Owner workspace</p>
          <h1>Information package</h1>
        </div>
        ${previewLink}
      </div>
      <section class="package-version" aria-labelledby="package-version-title">
        <h2 id="package-version-title">Current version</h2>
        ${versionSummary}
      </section>
      <div class="package-workspace-grid">
        <section aria-labelledby="package-sections-title">
          <h2 id="package-sections-title">Sections</h2>
          ${sections}
        </section>
        <aside class="package-create" aria-labelledby="package-create-title">
          <h2 id="package-create-title">New section</h2>
          ${createSection}
        </aside>
      </div>
      ${settings}
    </main>
  </body>
</html>`);
}

export function ownerPackagePreviewHtmlResponse(
  document: OwnerPackagePreviewDocument,
): Response {
  const sections = document.data.sections.length === 0
    ? `<p class="package-empty">No enabled sections.</p>`
    : document.data.sections.map((section) => `
      <section class="package-preview-section" aria-labelledby="preview-${escapeAttribute(section.id)}">
        <h2 id="preview-${escapeAttribute(section.id)}">${escapeHtml(section.title)}</h2>
        <div class="package-rendered-markdown">
          ${renderSafeMarkdownHtml(section.markdown, { headingOffset: 2 })}
        </div>
      </section>`).join("");

  return htmlResponse(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Information package preview</title>
    <link rel="stylesheet" href="/owner-package.css">
  </head>
  <body class="package-owner-page">
    ${ownerHeader("Preview")}
    <main class="package-preview-main">
      <div class="package-title-row">
        <div>
          <p class="package-kicker">Version ${document.data.revision}</p>
          <h1>Information package preview</h1>
        </div>
        <a class="package-button package-button--quiet" href="/owner/package">Back to workspace</a>
      </div>
      <p class="package-preview-change">${escapeHtml(document.data.change_summary)} · ${document.data.material_change ? "Material" : "Non-material"}</p>
      ${sections}
      <section class="package-acknowledgment" aria-labelledby="preview-acknowledgment">
        <h2 id="preview-acknowledgment">Acknowledgment</h2>
        <p>${escapeHtml(document.data.acknowledgment_text)}</p>
      </section>
    </main>
  </body>
</html>`);
}

export function ownerPackageFailureHtmlResponse(
  status: number,
  title: string,
  message: string,
): Response {
  return htmlResponse(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/owner-package.css">
  </head>
  <body class="package-owner-page">
    ${ownerHeader(title)}
    <main class="package-error-main">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <a href="/owner/package">Return to information package</a>
    </main>
  </body>
</html>`, status);
}

function renderForm(form: HtmlFormAction, csrfToken: string): string {
  const fieldPrefix = formFieldPrefix(form);
  const transportFields = form.hiddenFields.map((field) =>
    hiddenField(field.name, field.value)
  ).join("");
  const internalFields = form.fields
    .filter((field) => INTERNAL_FIELDS.has(field.name))
    .map((field) => hiddenField(field.name, fieldValue(field)))
    .join("");
  const controls = form.fields
    .filter((field) => !INTERNAL_FIELDS.has(field.name))
    .map((field) => renderField(field, fieldPrefix))
    .join("");

  return `<form class="package-form" data-action="${escapeAttribute(form.name)}" action="${escapeAttribute(form.action)}" method="${form.method.toLowerCase()}"${form.encoding ? ` enctype="${form.encoding}"` : ""}>
    ${hiddenField("_csrf", csrfToken)}
    ${transportFields}
    ${internalFields}
    ${controls}
    <button class="package-button package-button--primary" type="submit">${escapeHtml(form.title)}</button>
  </form>`;
}

function renderField(field: HtmlFormField, prefix: string): string {
  const value = fieldValue(field);
  const required = field.required ? " required" : "";
  const identifier = `${prefix}-${field.name}`;

  if (field.control === "textarea") {
    return `<label for="${identifier}">${escapeHtml(field.label)}</label>
      <textarea id="${identifier}" name="${escapeAttribute(field.name)}" maxlength="${field.maxLength ?? ""}"${required}>${escapeHtml(String(value ?? ""))}</textarea>`;
  }
  if (field.control === "select") {
    return `<label for="${identifier}">${escapeHtml(field.label)}</label>
      <select id="${identifier}" name="${escapeAttribute(field.name)}"${required}>${(field.choices ?? []).map((choice) =>
        `<option value="${escapeAttribute(choice.value)}"${choice.value === value ? " selected" : ""}>${escapeHtml(choice.label)}</option>`
      ).join("")}</select>`;
  }
  if (field.inputType === "checkbox") {
    return `<label class="package-checkbox" for="${identifier}">
      <input id="${identifier}" name="${escapeAttribute(field.name)}" type="checkbox" value="true"${value === true ? " checked" : ""}${required}>
      <span>${escapeHtml(field.label)}</span>
    </label>`;
  }

  const numeric = field.inputType === "number";
  return `<label for="${identifier}">${escapeHtml(field.label)}</label>
    <input id="${identifier}" name="${escapeAttribute(field.name)}" type="${field.inputType ?? "text"}"${value === undefined ? "" : ` value="${escapeAttribute(String(value))}"`}${field.minLength === undefined ? "" : ` minlength="${field.minLength}"`}${field.maxLength === undefined ? "" : ` maxlength="${field.maxLength}"`}${!numeric || field.minimum === undefined ? "" : ` min="${field.minimum}"`}${!numeric || field.maximum === undefined ? "" : ` max="${field.maximum}"`}${!numeric || field.step === undefined ? "" : ` step="${field.step}"`}${required}>`;
}

function formFieldPrefix(form: HtmlFormAction): string {
  const target = new URL(form.action);
  return `field-${form.name}-${target.pathname}`
    .replaceAll(/[^A-Za-z0-9_-]/g, "-");
}

function fieldValue(field: HtmlFormField): string | number | boolean | undefined {
  return field.value ?? field.defaultValue;
}

function hiddenField(name: string, value: unknown): string {
  return `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(String(value ?? ""))}">`;
}

function ownerHeader(label: string): string {
  return `<header class="package-owner-header">
    <a class="package-brand" href="/owner">Campaign workspace</a>
    <nav aria-label="Owner navigation">
      <span>${escapeHtml(label)}</span>
      <a href="/">View campaign</a>
    </nav>
  </header>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' https:; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      Vary: "Accept",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
