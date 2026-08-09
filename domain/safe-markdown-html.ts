import type { Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

import type { SafeMarkdown } from "./package-content.ts";

type DefinitionTarget = Readonly<{
  url: string;
  title: string | null | undefined;
}>;

export type SafeMarkdownRenderOptions = Readonly<{
  headingOffset?: number;
}>;

/** Renders validated package Markdown without ever passing through raw HTML. */
export function renderSafeMarkdownHtml(
  markdown: SafeMarkdown,
  options: SafeMarkdownRenderOptions = {},
): string {
  const root = fromMarkdown(markdown);
  const definitions = collectDefinitions(root);
  const headingOffset = boundedHeadingOffset(options.headingOffset);
  return renderChildren(root, definitions, headingOffset);
}

function collectDefinitions(root: Root): ReadonlyMap<string, DefinitionTarget> {
  const definitions = new Map<string, DefinitionTarget>();
  const pending: Nodes[] = [...root.children];

  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    if (node.type === "definition" && safeUrl(node.url, false)) {
      definitions.set(node.identifier, {
        url: node.url,
        title: node.title,
      });
    }
    pending.push(...nodeChildren(node));
  }

  return definitions;
}

function renderNode(
  node: Nodes,
  definitions: ReadonlyMap<string, DefinitionTarget>,
  headingOffset: number,
): string {
  switch (node.type) {
    case "root":
      return renderChildren(node, definitions, headingOffset);
    case "text":
      return escapeHtml(node.value);
    case "paragraph":
      return `<p>${renderChildren(node, definitions, headingOffset)}</p>`;
    case "heading": {
      const level = Math.min(6, node.depth + headingOffset);
      return `<h${level}>${renderChildren(node, definitions, headingOffset)}</h${level}>`;
    }
    case "emphasis":
      return `<em>${renderChildren(node, definitions, headingOffset)}</em>`;
    case "strong":
      return `<strong>${renderChildren(node, definitions, headingOffset)}</strong>`;
    case "delete":
      return `<del>${renderChildren(node, definitions, headingOffset)}</del>`;
    case "inlineCode":
      return `<code>${escapeHtml(node.value)}</code>`;
    case "code": {
      const language = node.lang
        ? ` class="language-${escapeAttribute(node.lang)}"`
        : "";
      return `<pre><code${language}>${escapeHtml(node.value)}</code></pre>`;
    }
    case "blockquote":
      return `<blockquote>${renderChildren(node, definitions, headingOffset)}</blockquote>`;
    case "list": {
      const tag = node.ordered ? "ol" : "ul";
      const start = node.ordered && node.start && node.start !== 1
        ? ` start="${node.start}"`
        : "";
      return `<${tag}${start}>${renderChildren(node, definitions, headingOffset)}</${tag}>`;
    }
    case "listItem":
      return `<li>${renderChildren(node, definitions, headingOffset)}</li>`;
    case "break":
      return "<br>";
    case "thematicBreak":
      return "<hr>";
    case "link":
      return renderLink(
        node.url,
        node.title,
        renderChildren(node, definitions, headingOffset),
      );
    case "linkReference": {
      const target = definitions.get(node.identifier);
      const content = renderChildren(node, definitions, headingOffset);
      return target ? renderLink(target.url, target.title, content) : content;
    }
    case "image":
      return renderImage(node.url, node.alt ?? "", node.title);
    case "imageReference": {
      const target = definitions.get(node.identifier);
      return target
        ? renderImage(target.url, node.alt ?? "", target.title)
        : escapeHtml(node.alt ?? "");
    }
    case "definition":
    case "footnoteDefinition":
      return "";
    case "footnoteReference":
      return `<sup>${escapeHtml(node.label ?? node.identifier)}</sup>`;
    case "table":
      return `<table><tbody>${renderChildren(node, definitions, headingOffset)}</tbody></table>`;
    case "tableRow":
      return `<tr>${renderChildren(node, definitions, headingOffset)}</tr>`;
    case "tableCell":
      return `<td>${renderChildren(node, definitions, headingOffset)}</td>`;
    case "yaml":
      return `<pre><code>${escapeHtml(node.value)}</code></pre>`;
    case "html":
      return escapeHtml(node.value);
    default:
      return renderUnknownNode(node, definitions, headingOffset);
  }
}

function renderChildren(
  node: Nodes,
  definitions: ReadonlyMap<string, DefinitionTarget>,
  headingOffset: number,
): string {
  return nodeChildren(node)
    .map((child) => renderNode(child, definitions, headingOffset))
    .join("");
}

function renderUnknownNode(
  node: never,
  definitions: ReadonlyMap<string, DefinitionTarget>,
  headingOffset: number,
): string {
  const candidate = node as Nodes;
  const children = nodeChildren(candidate);
  if (children.length > 0) {
    return children
      .map((child) => renderNode(child, definitions, headingOffset))
      .join("");
  }
  return "value" in candidate && typeof candidate.value === "string"
    ? escapeHtml(candidate.value)
    : "";
}

function renderLink(
  url: string,
  title: string | null | undefined,
  content: string,
): string {
  if (!safeUrl(url, false)) return content;
  const titleAttribute = title
    ? ` title="${escapeAttribute(title)}"`
    : "";
  const rel = url.startsWith("https:")
    ? ' rel="noreferrer noopener"'
    : "";
  return `<a href="${escapeAttribute(url)}"${titleAttribute}${rel}>${content}</a>`;
}

function renderImage(
  url: string,
  alt: string,
  title: string | null | undefined,
): string {
  if (!safeUrl(url, true)) return escapeHtml(alt);
  const titleAttribute = title
    ? ` title="${escapeAttribute(title)}"`
    : "";
  return `<img src="${escapeAttribute(url)}" alt="${escapeAttribute(alt)}"${titleAttribute}>`;
}

function safeUrl(value: string, image: boolean): boolean {
  if (
    value.length === 0 ||
    value.startsWith("//") ||
    hasControlCharacter(value)
  ) {
    return false;
  }
  if (value.startsWith("#") || value.startsWith("/")) return true;

  let parsed: URL;
  try {
    parsed = new URL(value, "https://investor-app.invalid/");
  } catch {
    return false;
  }
  return parsed.protocol === "https:" || !image && parsed.protocol === "mailto:";
}

function nodeChildren(node: Nodes): readonly Nodes[] {
  return "children" in node && Array.isArray(node.children)
    ? node.children as readonly Nodes[]
    : [];
}

function boundedHeadingOffset(value: number | undefined): number {
  return Number.isInteger(value) && value !== undefined && value >= 0 && value <= 5
    ? value
    : 0;
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

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}
