export type CampaignLink = Readonly<{
  label: string;
  href: string;
  rel: readonly string[];
}>;

export type PublicCampaignConfiguration = Readonly<{
  id: string;
  published: boolean;
  status: "open" | "closed";
  name: string;
  pageTitle: string;
  pageDescription: string;
  phaseLabel: string;
  statusLabel: string;
  brandMarkUrl: string | null;
  heroImageUrl: string | null;
  socialImageUrl: string | null;
  navigation: readonly Readonly<{ label: string; href: string }>[];
  hero: Readonly<{
    summary: string;
    invitation: string;
    primaryActionLabel: string;
    secondaryAction: Readonly<{ label: string; href: string }> | null;
    note: string;
  }>;
  facts: readonly Readonly<{ label: string; value: string }>[];
  participation: Readonly<{
    eyebrow: string;
    title: string;
    paths: readonly Readonly<{
      kind: "investor" | "founder";
      title: string;
      description: string;
      actionLabel: string;
    }>[];
  }>;
  product: Readonly<{
    eyebrow: string;
    title: string;
    description: string;
    links: readonly CampaignLink[];
    capabilities: readonly Readonly<{ label: string; description: string }>[];
  }> | null;
  process: Readonly<{
    eyebrow: string;
    title: string;
    steps: readonly Readonly<{ title: string; description: string }>[];
  }> | null;
  risks: Readonly<{
    eyebrow: string;
    title: string;
    items: readonly string[];
  }>;
  faq: Readonly<{
    eyebrow: string;
    title: string;
    items: readonly Readonly<{ question: string; answer: string }>[];
  }> | null;
  closing: Readonly<{
    eyebrow: string;
    title: string;
    actionLabel: string;
  }>;
  footer: Readonly<{
    tagline: string;
    links: readonly CampaignLink[];
  }>;
}>;

const MAX_CONFIGURATION_LENGTH = 16_000;

export function parsePublicCampaignConfiguration(
  serialized: string | null | undefined,
): PublicCampaignConfiguration | null {
  if (!serialized || serialized.length > MAX_CONFIGURATION_LENGTH) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }

  const root = record(parsed);
  if (!root) return null;

  const id = text(root.id, 80, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  const published = boolean(root.published);
  const status = oneOf(root.status, ["open", "closed"] as const);
  const name = text(root.name, 120);
  const pageTitle = text(root.pageTitle, 160);
  const pageDescription = text(root.pageDescription, 320);
  const phaseLabel = text(root.phaseLabel, 120);
  const statusLabel = text(root.statusLabel, 120);
  const brandMarkUrl = optionalAssetUrl(root.brandMarkUrl);
  const heroImageUrl = optionalAssetUrl(root.heroImageUrl);
  const socialImageUrl = optionalAssetUrl(root.socialImageUrl);
  const navigation = list(root.navigation, 6, parseNavigationItem);
  const hero = parseHero(root.hero);
  const facts = list(root.facts, 4, parseFact);
  const participation = parseParticipation(root.participation);
  const product = optionalSection(root.product, parseProduct);
  const process = optionalSection(root.process, parseProcess);
  const risks = parseRisks(root.risks);
  const faq = optionalSection(root.faq, parseFaq);
  const closing = parseClosing(root.closing);
  const footer = parseFooter(root.footer);

  if (
    id === null ||
    published === null ||
    status === null ||
    name === null ||
    pageTitle === null ||
    pageDescription === null ||
    phaseLabel === null ||
    statusLabel === null ||
    brandMarkUrl === undefined ||
    heroImageUrl === undefined ||
    socialImageUrl === undefined ||
    navigation === null ||
    hero === null ||
    facts === null ||
    participation === null ||
    product === undefined ||
    process === undefined ||
    risks === null ||
    faq === undefined ||
    closing === null ||
    footer === null
  ) {
    return null;
  }

  return {
    id,
    published,
    status,
    name,
    pageTitle,
    pageDescription,
    phaseLabel,
    statusLabel,
    brandMarkUrl,
    heroImageUrl,
    socialImageUrl,
    navigation,
    hero,
    facts,
    participation,
    product,
    process,
    risks,
    faq,
    closing,
    footer,
  };
}

function parseHero(value: unknown): PublicCampaignConfiguration["hero"] | null {
  const source = record(value);
  if (!source) return null;

  const summary = text(source.summary, 500);
  const invitation = text(source.invitation, 800);
  const primaryActionLabel = text(source.primaryActionLabel, 80);
  const note = text(source.note, 500);
  const secondaryAction = optionalSection(source.secondaryAction, (candidate) => {
    const action = record(candidate);
    if (!action) return null;
    const label = text(action.label, 80);
    const href = safeHref(action.href);
    return label && href ? { label, href } : null;
  });

  return summary && invitation && primaryActionLabel && note && secondaryAction !== undefined
    ? { summary, invitation, primaryActionLabel, secondaryAction, note }
    : null;
}

function parseNavigationItem(
  value: unknown,
): Readonly<{ label: string; href: string }> | null {
  const source = record(value);
  if (!source) return null;
  const label = text(source.label, 60);
  const href = safeHref(source.href);
  return label && href ? { label, href } : null;
}

function parseFact(value: unknown): Readonly<{ label: string; value: string }> | null {
  const source = record(value);
  if (!source) return null;
  const label = text(source.label, 80);
  const factValue = text(source.value, 120);
  return label && factValue ? { label, value: factValue } : null;
}

function parseParticipation(
  value: unknown,
): PublicCampaignConfiguration["participation"] | null {
  const source = record(value);
  if (!source) return null;
  const eyebrow = text(source.eyebrow, 80);
  const title = text(source.title, 180);
  const paths = list(source.paths, 2, (candidate) => {
    const path = record(candidate);
    if (!path) return null;
    const kind = oneOf(path.kind, ["investor", "founder"] as const);
    const pathTitle = text(path.title, 120);
    const description = text(path.description, 500);
    const actionLabel = text(path.actionLabel, 100);
    return kind && pathTitle && description && actionLabel
      ? { kind, title: pathTitle, description, actionLabel }
      : null;
  });

  if (!eyebrow || !title || !paths || paths.length === 0) return null;
  if (new Set(paths.map((path) => path.kind)).size !== paths.length) return null;
  return { eyebrow, title, paths };
}

function parseProduct(value: unknown): NonNullable<PublicCampaignConfiguration["product"]> | null {
  const source = record(value);
  if (!source) return null;
  const eyebrow = text(source.eyebrow, 80);
  const title = text(source.title, 180);
  const description = text(source.description, 1_000);
  const links = list(source.links, 5, parseLink);
  const capabilities = list(source.capabilities, 8, (candidate) => {
    const capability = record(candidate);
    if (!capability) return null;
    const label = text(capability.label, 80);
    const capabilityDescription = text(capability.description, 400);
    return label && capabilityDescription
      ? { label, description: capabilityDescription }
      : null;
  });
  return eyebrow && title && description && links && capabilities
    ? { eyebrow, title, description, links, capabilities }
    : null;
}

function parseProcess(value: unknown): NonNullable<PublicCampaignConfiguration["process"]> | null {
  const source = record(value);
  if (!source) return null;
  const eyebrow = text(source.eyebrow, 80);
  const title = text(source.title, 180);
  const steps = list(source.steps, 8, (candidate) => {
    const step = record(candidate);
    if (!step) return null;
    const stepTitle = text(step.title, 100);
    const description = text(step.description, 400);
    return stepTitle && description ? { title: stepTitle, description } : null;
  });
  return eyebrow && title && steps && steps.length > 0
    ? { eyebrow, title, steps }
    : null;
}

function parseRisks(value: unknown): PublicCampaignConfiguration["risks"] | null {
  const source = record(value);
  if (!source) return null;
  const eyebrow = text(source.eyebrow, 80);
  const title = text(source.title, 180);
  const items = list(source.items, 12, (candidate) => text(candidate, 500));
  return eyebrow && title && items && items.length > 0 ? { eyebrow, title, items } : null;
}

function parseFaq(value: unknown): NonNullable<PublicCampaignConfiguration["faq"]> | null {
  const source = record(value);
  if (!source) return null;
  const eyebrow = text(source.eyebrow, 80);
  const title = text(source.title, 180);
  const items = list(source.items, 12, (candidate) => {
    const item = record(candidate);
    if (!item) return null;
    const question = text(item.question, 240);
    const answer = text(item.answer, 800);
    return question && answer ? { question, answer } : null;
  });
  return eyebrow && title && items ? { eyebrow, title, items } : null;
}

function parseClosing(value: unknown): PublicCampaignConfiguration["closing"] | null {
  const source = record(value);
  if (!source) return null;
  const eyebrow = text(source.eyebrow, 80);
  const title = text(source.title, 180);
  const actionLabel = text(source.actionLabel, 80);
  return eyebrow && title && actionLabel ? { eyebrow, title, actionLabel } : null;
}

function parseFooter(value: unknown): PublicCampaignConfiguration["footer"] | null {
  const source = record(value);
  if (!source) return null;
  const tagline = text(source.tagline, 240);
  const links = list(source.links, 6, parseLink);
  return tagline && links ? { tagline, links } : null;
}

function parseLink(value: unknown): CampaignLink | null {
  const source = record(value);
  if (!source) return null;
  const label = text(source.label, 80);
  const href = safeHref(source.href);
  const rel = list(source.rel, 4, (candidate) =>
    text(candidate, 40, /^[a-z][a-z0-9-]*$/),
  );
  return label && href && rel && rel.length > 0 ? { label, href, rel } : null;
}

function optionalSection<T>(
  value: unknown,
  parser: (candidate: unknown) => T | null,
): T | null | undefined {
  if (value === null || value === undefined) return null;
  return parser(value) ?? undefined;
}

function optionalAssetUrl(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 2_000) return undefined;
  if (isRootRelative(value)) return value;

  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function safeHref(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000) {
    return null;
  }
  if (value.startsWith("#") || isRootRelative(value)) return value;

  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function isRootRelative(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//");
}

function list<T>(
  value: unknown,
  maximum: number,
  parser: (candidate: unknown) => T | null,
): readonly T[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const parsed = value.map(parser);
  return parsed.some((item) => item === null) ? null : (parsed as T[]);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(
  value: unknown,
  maximum: number,
  pattern?: RegExp,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum && (!pattern || pattern.test(normalized))
    ? normalized
    : null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  choices: T,
): T[number] | null {
  return typeof value === "string" && (choices as readonly string[]).includes(value)
    ? (value as T[number])
    : null;
}
