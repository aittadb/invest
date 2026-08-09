import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

import {
  invalid,
  parseActorSubject,
  parseStableId,
  parseTimestamp,
  valid,
  type ActorSubject,
  type StableId,
  type Timestamp,
  type ValidationIssue,
  type ValidationResult,
} from "./foundation.ts";

declare const packageContentBrand: unique symbol;

export type SafeMarkdown = string & {
  readonly [packageContentBrand]: "SafeMarkdown";
};
export type AcknowledgmentText = string & {
  readonly [packageContentBrand]: "AcknowledgmentText";
};
export type PackageContentHash = string & {
  readonly [packageContentBrand]: "PackageContentHash";
};

/** An owner-managed package section. Empty and disabled sections remain drafts. */
export type PackageSection = Readonly<{
  id: StableId<"package-section">;
  order: number;
  title: string;
  markdown: SafeMarkdown;
  enabled: boolean;
}>;

/**
 * An immutable package snapshot. `requiredAcceptanceHash` propagates the most
 * recent material version across later non-material edits.
 */
export type PackageVersion = Readonly<{
  id: StableId<"package-version">;
  createdAt: Timestamp;
  changeSummary: string;
  materialChange: boolean;
  acknowledgmentText: AcknowledgmentText;
  sections: readonly PackageSection[];
  contentHash: PackageContentHash;
  requiredAcceptanceHash: PackageContentHash;
}>;

/** Immutable evidence that one participant accepted an acknowledgment state. */
export type PackageAcceptanceRecord = Readonly<{
  id: StableId<"package-acceptance">;
  participantSubject: ActorSubject;
  acceptedAt: Timestamp;
  acceptedVersionId: StableId<"package-version">;
  acceptedContentHash: PackageContentHash;
  satisfiedRequirementHash: PackageContentHash;
}>;

export const PACKAGE_CONTENT_LIMITS = Object.freeze({
  sections: 64,
  titleLength: 160,
  markdownLength: 50_000,
  acknowledgmentLength: 4_000,
  changeSummaryLength: 500,
});

export function parsePackageSection(
  value: unknown,
  path = "section",
): ValidationResult<PackageSection> {
  const source = record(value);
  if (!source) return invalid({ code: "invalid_type", path });

  const id = parseStableId<"package-section">(source.id);
  if (!id.ok) return invalid(remapIssue(id.issues[0], `${path}.id`));

  const order = nonNegativeInteger(source.order);
  if (order === null) {
    return invalid({ code: "invalid_format", path: `${path}.order` });
  }

  const title = boundedText(
    source.title,
    1,
    PACKAGE_CONTENT_LIMITS.titleLength,
    false,
  );
  if (title === null) {
    return invalid({ code: textIssue(source.title), path: `${path}.title` });
  }

  if (typeof source.enabled !== "boolean") {
    return invalid({ code: "invalid_type", path: `${path}.enabled` });
  }

  const markdown = parseSafeMarkdown(source.markdown);
  if (!markdown.ok) {
    return invalid(remapIssue(markdown.issues[0], `${path}.markdown`));
  }

  return valid(
    Object.freeze({
      id: id.value,
      order,
      title,
      markdown: markdown.value,
      enabled: source.enabled,
    }),
  );
}

/** Creates a detached, deeply frozen package snapshot and hashes its content. */
export async function createPackageVersion(
  value: unknown,
  previousVersion: PackageVersion | null = null,
): Promise<ValidationResult<PackageVersion>> {
  const source = record(value);
  if (!source) return invalid({ code: "invalid_type", path: "version" });

  const id = parseStableId<"package-version">(source.id);
  if (!id.ok) return invalid(remapIssue(id.issues[0], "version.id"));

  const createdAt = parseTimestamp(source.createdAt);
  if (!createdAt.ok) {
    return invalid(remapIssue(createdAt.issues[0], "version.createdAt"));
  }

  const changeSummary = boundedText(
    source.changeSummary,
    1,
    PACKAGE_CONTENT_LIMITS.changeSummaryLength,
    true,
  );
  if (changeSummary === null) {
    return invalid({
      code: textIssue(source.changeSummary),
      path: "version.changeSummary",
    });
  }

  if (typeof source.materialChange !== "boolean") {
    return invalid({ code: "invalid_type", path: "version.materialChange" });
  }

  const acknowledgmentText = parseAcknowledgmentText(source.acknowledgmentText);
  if (!acknowledgmentText.ok) {
    return invalid(
      remapIssue(acknowledgmentText.issues[0], "version.acknowledgmentText"),
    );
  }

  if (
    !Array.isArray(source.sections) ||
    source.sections.length > PACKAGE_CONTENT_LIMITS.sections
  ) {
    return invalid({
      code: Array.isArray(source.sections) ? "out_of_range" : "invalid_type",
      path: "version.sections",
    });
  }

  const sections: PackageSection[] = [];
  for (const [index, candidate] of source.sections.entries()) {
    const section = parsePackageSection(candidate, `version.sections.${index}`);
    if (!section.ok) return section;
    sections.push(section.value);
  }

  const orderedSections = [...sections].sort((left, right) => left.order - right.order);
  if (!hasUniqueContiguousOrder(orderedSections)) {
    return invalid({ code: "invalid_rule", path: "version.sections.order" });
  }
  if (new Set(orderedSections.map((section) => section.id)).size !== orderedSections.length) {
    return invalid({ code: "invalid_rule", path: "version.sections.id" });
  }

  const frozenSections = Object.freeze(
    orderedSections.map((section) => Object.freeze({ ...section })),
  );
  const contentHash = await hashPackageContent(
    frozenSections,
    acknowledgmentText.value,
  );
  const requiredAcceptanceHash =
    previousVersion === null || source.materialChange
      ? contentHash
      : previousVersion.requiredAcceptanceHash;

  return valid(
    Object.freeze({
      id: id.value,
      createdAt: createdAt.value,
      changeSummary,
      materialChange: source.materialChange,
      acknowledgmentText: acknowledgmentText.value,
      sections: frozenSections,
      contentHash,
      requiredAcceptanceHash,
    }),
  );
}

/** Returns only enabled, non-empty sections from the immutable display order. */
export function visiblePackageSections(
  version: PackageVersion,
): readonly PackageSection[] {
  return version.sections.filter(
    (section) => section.enabled && section.markdown.trim().length > 0,
  );
}

/** Creates acceptance evidence from the trusted current version, never client hashes. */
export function createPackageAcceptance(
  value: unknown,
  version: PackageVersion,
): ValidationResult<PackageAcceptanceRecord> {
  const source = record(value);
  if (!source) return invalid({ code: "invalid_type", path: "acceptance" });

  const id = parseStableId<"package-acceptance">(source.id);
  if (!id.ok) return invalid(remapIssue(id.issues[0], "acceptance.id"));

  const participantSubject = parseActorSubject(source.participantSubject);
  if (!participantSubject.ok) {
    return invalid(
      remapIssue(participantSubject.issues[0], "acceptance.participantSubject"),
    );
  }

  const acceptedAt = parseTimestamp(source.acceptedAt);
  if (!acceptedAt.ok) {
    return invalid(remapIssue(acceptedAt.issues[0], "acceptance.acceptedAt"));
  }
  if (acceptedAt.value < version.createdAt) {
    return invalid({ code: "invalid_rule", path: "acceptance.acceptedAt" });
  }

  return valid(
    Object.freeze({
      id: id.value,
      participantSubject: participantSubject.value,
      acceptedAt: acceptedAt.value,
      acceptedVersionId: version.id,
      acceptedContentHash: version.contentHash,
      satisfiedRequirementHash: version.requiredAcceptanceHash,
    }),
  );
}

export function requiresRenewedAcceptance(
  version: PackageVersion,
  latestAcceptance: PackageAcceptanceRecord | null,
): boolean {
  return (
    latestAcceptance === null ||
    latestAcceptance.satisfiedRequirementHash !== version.requiredAcceptanceHash
  );
}

function parseSafeMarkdown(value: unknown): ValidationResult<SafeMarkdown> {
  if (typeof value !== "string") {
    return invalid({ code: "invalid_type", path: "markdown" });
  }
  if (
    value.length > PACKAGE_CONTENT_LIMITS.markdownLength ||
    hasForbiddenControl(value, true)
  ) {
    return invalid({ code: "invalid_format", path: "markdown" });
  }

  let nodes: Nodes[];
  try {
    nodes = [fromMarkdown(value)];
  } catch {
    return invalid({ code: "invalid_format", path: "markdown" });
  }

  while (nodes.length > 0) {
    const node = nodes.pop();
    if (!node) continue;
    if (node.type === "html") {
      return invalid({ code: "invalid_format", path: "markdown" });
    }
    if (
      (node.type === "link" ||
        node.type === "image" ||
        node.type === "definition") &&
      !isSafeMarkdownUrl(node.url, node.type === "image")
    ) {
      return invalid({ code: "invalid_format", path: "markdown" });
    }
    if ("children" in node && Array.isArray(node.children)) {
      nodes.push(...node.children);
    }
  }

  return valid(value as SafeMarkdown);
}

function parseAcknowledgmentText(
  value: unknown,
): ValidationResult<AcknowledgmentText> {
  const text = boundedText(
    value,
    1,
    PACKAGE_CONTENT_LIMITS.acknowledgmentLength,
    true,
  );
  return text === null
    ? invalid({ code: textIssue(value), path: "acknowledgmentText" })
    : valid(text as AcknowledgmentText);
}

async function hashPackageContent(
  sections: readonly PackageSection[],
  acknowledgmentText: AcknowledgmentText,
): Promise<PackageContentHash> {
  const canonical = JSON.stringify({
    sections: sections.map(({ id, order, title, markdown, enabled }) => ({
      id,
      order,
      title,
      markdown,
      enabled,
    })),
    acknowledgmentText,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  const hexadecimal = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hexadecimal}` as PackageContentHash;
}

function isSafeMarkdownUrl(value: string, image: boolean): boolean {
  if (value.length === 0 || hasForbiddenControl(value) || value.startsWith("//")) {
    return false;
  }
  if (value.startsWith("#") || value.startsWith("/")) return true;

  let parsed: URL;
  try {
    parsed = new URL(value, "https://investor-app.invalid/");
  } catch {
    return false;
  }

  if (parsed.protocol === "https:") return true;
  return !image && parsed.protocol === "mailto:";
}

function hasUniqueContiguousOrder(sections: readonly PackageSection[]): boolean {
  return sections.every((section, index) => section.order === index);
}

function boundedText(
  value: unknown,
  minimum: number,
  maximum: number,
  multiline: boolean,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = multiline ? value.replaceAll("\r\n", "\n") : value;
  if (
    normalized.length < minimum ||
    normalized.length > maximum ||
    normalized.trim() !== normalized ||
    hasForbiddenControl(normalized, multiline)
  ) {
    return null;
  }
  return normalized;
}

function hasForbiddenControl(value: string, allowLayout = false): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint > 31 && codePoint !== 127) continue;
    if (allowLayout && (character === "\n" || character === "\t")) continue;
    return true;
  }
  return false;
}

function textIssue(value: unknown): ValidationIssue["code"] {
  if (typeof value !== "string") return "invalid_type";
  return value.length === 0 ? "required" : "invalid_format";
}

function remapIssue(issue: ValidationIssue, path: string): ValidationIssue {
  return { code: issue.code, path };
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0
    ? value
    : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
