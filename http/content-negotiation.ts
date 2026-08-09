import {
  INVESTOR_APP_API_VERSION,
  INVESTOR_APP_MEDIA_TYPE,
} from "../domain/public-campaign-resource.ts";

export type NegotiatedRepresentation =
  | Readonly<{ kind: "html" }>
  | Readonly<{ kind: "hypermedia-json" }>
  | Readonly<{ kind: "not-acceptable" }>;

type MediaRange = Readonly<{
  mediaType: string;
  parameters: ReadonlyMap<string, string>;
  quality: number;
  order: number;
}>;

export function negotiateRepresentation(
  acceptHeader: string | null,
): NegotiatedRepresentation {
  if (!acceptHeader?.trim()) return { kind: "html" };

  const ranges = parseAcceptHeader(acceptHeader);
  const requestedVendorRanges = ranges.filter(
    (range) =>
      range.quality > 0 && range.mediaType === INVESTOR_APP_MEDIA_TYPE,
  );

  if (
    requestedVendorRanges.some(
      (range) => range.parameters.get("version") !== INVESTOR_APP_API_VERSION,
    )
  ) {
    return { kind: "not-acceptable" };
  }

  const candidates = ranges
    .filter((range) => range.quality > 0)
    .map((range) => {
      if (
        range.mediaType === INVESTOR_APP_MEDIA_TYPE &&
        range.parameters.get("version") === INVESTOR_APP_API_VERSION
      ) {
        return { ...range, kind: "hypermedia-json" as const, specificity: 2 };
      }
      if (range.mediaType === "application/json") {
        return { ...range, kind: "hypermedia-json" as const, specificity: 2 };
      }
      if (
        range.mediaType === "text/html" ||
        range.mediaType === "text/x-component"
      ) {
        return { ...range, kind: "html" as const, specificity: 2 };
      }
      if (range.mediaType === "*/*") {
        return { ...range, kind: "html" as const, specificity: 0 };
      }
      return null;
    })
    .filter((candidate) => candidate !== null)
    .sort(
      (left, right) =>
        right.quality - left.quality ||
        right.specificity - left.specificity ||
        left.order - right.order,
    );

  return candidates[0]
    ? { kind: candidates[0].kind }
    : { kind: "not-acceptable" };
}

function parseAcceptHeader(header: string): readonly MediaRange[] {
  return splitHeaderValue(header, ",").map((rawRange, order) => {
    const [rawMediaType = "", ...rawParameters] = splitHeaderValue(
      rawRange,
      ";",
    );
    const parameters = new Map<string, string>();

    for (const rawParameter of rawParameters) {
      const separator = rawParameter.indexOf("=");
      if (separator < 1) continue;

      const name = rawParameter.slice(0, separator).trim().toLowerCase();
      const value = unquote(rawParameter.slice(separator + 1).trim());
      parameters.set(name, value);
    }

    return {
      mediaType: rawMediaType.trim().toLowerCase(),
      parameters,
      quality: parseQuality(parameters.get("q")),
      order,
    };
  });
}

function parseQuality(value: string | undefined): number {
  if (value === undefined) return 1;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('\\"', '"');
  }
  return value;
}

function splitHeaderValue(value: string, separator: "," | ";"): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quoted) {
      current += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      current += character;
      continue;
    }
    if (character === separator && !quoted) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }

  parts.push(current.trim());
  return parts.filter(Boolean);
}
