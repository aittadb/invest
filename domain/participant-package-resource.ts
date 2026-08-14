import {
  PACKAGE_CONTENT_LIMITS,
  parsePackageSection,
  type PackageSection,
  type PackageVersion,
} from "./package-content.ts";
import {
  parseStableId,
  parseTimestamp,
} from "./foundation.ts";
import {
  defineAction,
  toHypermediaAction,
  type HypermediaAction,
} from "./hypermedia-action.ts";
import { PRIVATE_PACKAGE_PATH, PARTICIPANT_HOME_PATH } from "./participant-navigation.ts";
import {
  INVESTOR_APP_API_VERSION,
  type HypermediaLink,
} from "./public-campaign-resource.ts";

export const PARTICIPANT_PACKAGE_PAGE_LIMITS = Object.freeze({
  defaultSections: 8,
  maximumSections: 16,
  maximumSourceBytes: 256_000,
});

export type ParticipantPackageSectionData = Readonly<{
  id: string;
  title: string;
  markdown: string;
}>;

export type ParticipantPackageDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "participant-package";
  id: string;
  data: Readonly<{
    created_at: string;
    change_summary: string;
    material_change: boolean;
    acknowledgment_text: string;
    acceptance_required: boolean;
    sections: readonly ParticipantPackageSectionData[];
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type ParticipantPackagePage = Readonly<{
  document: ParticipantPackageDocument;
  sections: readonly PackageSection[];
  nextAfter: string | null;
}>;

export type ParticipantPackagePageInput = Readonly<{
  requestUrl: string;
  version: PackageVersion;
  acceptanceRequired: boolean;
  limit: number;
  after: string | null;
}>;

/** Build one closed reader page from a repository-owned package snapshot. */
export function createParticipantPackagePage(
  input: ParticipantPackagePageInput,
): ParticipantPackagePage | null {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > PARTICIPANT_PACKAGE_PAGE_LIMITS.maximumSections ||
    typeof input.acceptanceRequired !== "boolean"
  ) {
    return null;
  }

  const metadata = packageMetadata(input.version);
  if (metadata === null) return null;
  const visible = validatedVisibleSections(input.version.sections);
  if (visible === null) return null;

  let start = 0;
  if (input.after !== null) {
    const parsedAfter = parseStableId<"package-section">(input.after);
    if (!parsedAfter.ok) return null;
    const index = visible.findIndex((section) => section.id === parsedAfter.value);
    if (index < 0 || index >= visible.length - 1) return null;
    start = index + 1;
  }

  const pageSections: PackageSection[] = [];
  for (const section of visible.slice(start, start + input.limit)) {
    if (
      sourceByteLength(metadata, [...pageSections, section]) >
        PARTICIPANT_PACKAGE_PAGE_LIMITS.maximumSourceBytes
    ) {
      if (pageSections.length === 0) return null;
      break;
    }
    pageSections.push(section);
  }
  const sections = Object.freeze(pageSections);
  const hasNext = start + sections.length < visible.length;
  const nextAfter = hasNext ? sections.at(-1)?.id ?? null : null;
  if (hasNext && nextAfter === null) return null;

  let self: URL;
  try {
    self = new URL(input.requestUrl);
  } catch {
    return null;
  }
  const canonicalSelf = packagePageUrl(self, input.limit, input.after);
  const nextUrl = nextAfter === null
    ? null
    : packagePageUrl(self, input.limit, nextAfter);
  const links: HypermediaLink[] = [
    { rel: ["self", "private-package"], href: canonicalSelf },
    {
      rel: ["participant-home"],
      href: new URL(PARTICIPANT_HOME_PATH, self).href,
    },
  ];
  const actions: HypermediaAction[] = [];
  if (nextUrl !== null) {
    links.push({ rel: ["next"], href: nextUrl });
    actions.push(safeGetAction(
      "read-next-package-page",
      "Continue reading",
      nextUrl,
    ));
  }

  const document: ParticipantPackageDocument = Object.freeze({
    api_version: INVESTOR_APP_API_VERSION,
    type: "participant-package",
    id: metadata.id,
    data: Object.freeze({
      created_at: metadata.createdAt,
      change_summary: metadata.changeSummary,
      material_change: metadata.materialChange,
      acknowledgment_text: metadata.acknowledgmentText,
      acceptance_required: input.acceptanceRequired,
      sections: Object.freeze(sections.map((section) => Object.freeze({
        id: section.id as string,
        title: section.title,
        markdown: section.markdown as string,
      }))),
    }),
    links: Object.freeze(links),
    actions: Object.freeze(actions),
  });

  return Object.freeze({ document, sections, nextAfter });
}

function packageMetadata(version: PackageVersion): Readonly<{
  id: string;
  createdAt: string;
  changeSummary: string;
  materialChange: boolean;
  acknowledgmentText: string;
}> | null {
  const id = parseStableId<"package-version">(version?.id);
  const createdAt = parseTimestamp(version?.createdAt);
  if (
    !id.ok ||
    !createdAt.ok ||
    !boundedText(
      version?.changeSummary,
      PACKAGE_CONTENT_LIMITS.changeSummaryLength,
    ) ||
    typeof version?.materialChange !== "boolean" ||
    !boundedText(
      version?.acknowledgmentText,
      PACKAGE_CONTENT_LIMITS.acknowledgmentLength,
    )
  ) {
    return null;
  }
  return Object.freeze({
    id: id.value,
    createdAt: createdAt.value,
    changeSummary: version.changeSummary,
    materialChange: version.materialChange,
    acknowledgmentText: version.acknowledgmentText,
  });
}

function validatedVisibleSections(
  value: unknown,
): readonly PackageSection[] | null {
  if (!Array.isArray(value) || value.length > PACKAGE_CONTENT_LIMITS.sections) {
    return null;
  }
  const sections: PackageSection[] = [];
  for (const [index, candidate] of value.entries()) {
    const parsed = parsePackageSection(candidate, `sections[${index}]`);
    if (!parsed.ok) return null;
    sections.push(parsed.value);
  }
  sections.sort((left, right) => left.order - right.order);
  if (
    sections.some((section, index) => section.order !== index) ||
    new Set(sections.map((section) => section.id)).size !== sections.length
  ) {
    return null;
  }
  return Object.freeze(
    sections.filter(
      (section) => section.enabled && section.markdown.trim().length > 0,
    ),
  );
}

function packagePageUrl(base: URL, limit: number, after: string | null): string {
  const url = new URL(PRIVATE_PACKAGE_PATH, base);
  url.searchParams.set("limit", String(limit));
  if (after !== null) url.searchParams.set("after", after);
  return url.href;
}

function safeGetAction(name: string, title: string, href: string): HypermediaAction {
  return toHypermediaAction(defineAction({
    name,
    title,
    method: "GET",
    href,
    requestMediaType: "text/html",
    fields: [],
  }));
}

function boundedText(value: unknown, maximum: number): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    return false;
  }
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point === 127 || point < 32 && point !== 9 && point !== 10)) {
      return false;
    }
  }
  return true;
}

function sourceByteLength(
  metadata: Readonly<{
    id: string;
    createdAt: string;
    changeSummary: string;
    acknowledgmentText: string;
  }>,
  sections: readonly PackageSection[],
): number {
  return new TextEncoder().encode(JSON.stringify({
    metadata,
    sections: sections.map(({ id, title, markdown }) => ({ id, title, markdown })),
  })).byteLength;
}
