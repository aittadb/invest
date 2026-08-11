import {
  parseSanitizedPublicInvestmentAggregate,
  type SanitizedPublicInvestmentAggregate,
} from "../domain/investment-aggregate.ts";

export const PUBLIC_AGGREGATE_HEADER =
  "x-investor-app-public-aggregate";
const MAX_PUBLIC_AGGREGATE_HEADER_LENGTH = 2_048;

export function withRuntimePublicAggregate(
  request: Request,
  aggregate: SanitizedPublicInvestmentAggregate | null,
): Request {
  const headers = new Headers(request.headers);
  const parsed = aggregate === null
    ? null
    : parseSanitizedPublicInvestmentAggregate(aggregate);
  if (parsed === null || !parsed.ok) {
    headers.delete(PUBLIC_AGGREGATE_HEADER);
  } else {
    headers.set(PUBLIC_AGGREGATE_HEADER, encodeAggregate(parsed.value));
  }
  return new Request(request, { headers });
}

export function publicAggregateFromRuntimeHeader(
  encoded: string | null | undefined,
): SanitizedPublicInvestmentAggregate | null {
  if (!encoded || encoded.length > MAX_PUBLIC_AGGREGATE_HEADER_LENGTH) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(decode(encoded));
    const aggregate = parseSanitizedPublicInvestmentAggregate(parsed);
    return aggregate.ok ? aggregate.value : null;
  } catch {
    return null;
  }
}

function encodeAggregate(aggregate: SanitizedPublicInvestmentAggregate): string {
  return encode(JSON.stringify(aggregate));
}

function encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decode(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
