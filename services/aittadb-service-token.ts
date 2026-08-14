const TOKEN_RESPONSE_MAX_BYTES = 16_384;
const ACCESS_TOKEN_MAX_LENGTH = 4_096;
const MAX_TOKEN_LIFETIME_SECONDS = 3_600;
const MIN_EXPIRY_SKEW_SECONDS = 1;
const MAX_EXPIRY_SKEW_SECONDS = 300;
const MIN_REQUEST_TIMEOUT_MS = 1;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const STORAGE_SCOPES = [
  "storage.read",
  "storage.write",
  "storage.delete",
] as const;

export type AittaDBStorageScope = typeof STORAGE_SCOPES[number];

export type AittaDBServiceTokenFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type AittaDBServiceTokenDependencies = Readonly<{
  /** Logical OAuth issuer and security identity. */
  issuer: string;
  /** Optional backend-only network origin; defaults to the logical issuer. */
  transportOrigin?: string;
  clientId: string;
  clientSecret: string;
  storageScopes: readonly AittaDBStorageScope[];
  expirySkewSeconds: number;
  requestTimeoutMs: number;
  fetch: AittaDBServiceTokenFetch;
  now: () => Date;
}>;

export interface AittaDBServiceTokenProvider {
  /** Returns a bearer token only to the backend caller. */
  accessToken(): Promise<string>;
}

export class AittaDBServiceTokenFailure extends Error {
  readonly code = "service_unavailable" as const;

  constructor() {
    super("AittaDB service authentication is unavailable.");
    this.name = "AittaDBServiceTokenFailure";
  }
}

type ValidatedConfiguration = Readonly<{
  tokenEndpoint: string;
  authorization: string;
  scope: string;
  expirySkewSeconds: number;
  requestTimeoutMs: number;
  fetch: AittaDBServiceTokenFetch;
  now: () => Date;
}>;

type CachedToken = Readonly<{
  value: string;
  issuedAt: number;
  expiresAt: number;
}>;

/**
 * Creates a Worker-local client-credentials capability.
 *
 * The returned object deliberately exposes no configuration, token metadata,
 * logging hook, browser response, or persistence hook.
 */
export function createAittaDBServiceTokenProvider(
  dependencies: AittaDBServiceTokenDependencies,
): AittaDBServiceTokenProvider {
  const config = validatedConfiguration(dependencies);
  let cachedToken: CachedToken | undefined;
  let renewal: Promise<CachedToken> | undefined;

  const accessToken = async (): Promise<string> => {
    const now = currentEpochSeconds(config.now);
    if (cachedToken !== undefined) {
      if (
        now >= cachedToken.issuedAt &&
        now < cachedToken.expiresAt - config.expirySkewSeconds
      ) {
        return cachedToken.value;
      }
      cachedToken = undefined;
    }

    const attempt = renewal ?? acquireToken(config);
    renewal = attempt;
    try {
      const acquired = await attempt;
      cachedToken = acquired;
      return acquired.value;
    } catch {
      cachedToken = undefined;
      unavailable();
    } finally {
      if (renewal === attempt) renewal = undefined;
    }
  };

  return Object.freeze({ accessToken });
}

function validatedConfiguration(
  dependencies: AittaDBServiceTokenDependencies,
): ValidatedConfiguration {
  try {
    const issuer = exactHttpsOrigin(dependencies.issuer);
    const transportOrigin = dependencies.transportOrigin === undefined
      ? issuer
      : exactHttpsOrigin(dependencies.transportOrigin);
    const clientId = exactBasicCredential(
      dependencies.clientId,
      1,
      255,
      false,
    );
    const clientSecret = exactBasicCredential(
      dependencies.clientSecret,
      16,
      512,
      true,
    );
    const storageScopes = exactStorageScopes(dependencies.storageScopes);
    const expirySkewSeconds = dependencies.expirySkewSeconds;
    const requestTimeoutMs = dependencies.requestTimeoutMs;
    if (
      !Number.isInteger(expirySkewSeconds) ||
      expirySkewSeconds < MIN_EXPIRY_SKEW_SECONDS ||
      expirySkewSeconds > MAX_EXPIRY_SKEW_SECONDS ||
      !Number.isInteger(requestTimeoutMs) ||
      requestTimeoutMs < MIN_REQUEST_TIMEOUT_MS ||
      requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS ||
      typeof dependencies.fetch !== "function" ||
      typeof dependencies.now !== "function"
    ) {
      unavailable();
    }

    return Object.freeze({
      tokenEndpoint: `${transportOrigin}/oauth/token`,
      authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      scope: storageScopes.join(" "),
      expirySkewSeconds,
      requestTimeoutMs,
      fetch: dependencies.fetch,
      now: dependencies.now,
    });
  } catch {
    unavailable();
  }
}

function exactHttpsOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    unavailable();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    unavailable();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    value !== url.origin && value !== url.href
  ) {
    unavailable();
  }
  return url.origin;
}

function exactBasicCredential(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
  allowColon: boolean,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    !/^[\x21-\x7e]+$/u.test(value) ||
    (!allowColon && value.includes(":"))
  ) {
    unavailable();
  }
  return value;
}

function exactStorageScopes(
  value: readonly AittaDBStorageScope[],
): readonly AittaDBStorageScope[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > STORAGE_SCOPES.length) {
    unavailable();
  }
  const scopes = [...value] as unknown[];
  if (
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) =>
      typeof scope !== "string" ||
      !(STORAGE_SCOPES as readonly string[]).includes(scope)
    )
  ) {
    unavailable();
  }
  const canonical = STORAGE_SCOPES.filter((scope) => scopes.includes(scope));
  if (canonical.some((scope, index) => scope !== scopes[index])) unavailable();
  return Object.freeze([...canonical]);
}

async function acquireToken(
  config: ValidatedConfiguration,
): Promise<CachedToken> {
  const abortController = new AbortController();
  let rejectDeadline: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = () => reject(new AittaDBServiceTokenFailure());
  });
  const timeout = setTimeout(() => {
    abortController.abort();
    rejectDeadline?.();
  }, config.requestTimeoutMs);
  try {
    return await Promise.race([
      acquireTokenBeforeDeadline(config, abortController.signal),
      deadline,
    ]);
  } catch {
    unavailable();
  } finally {
    clearTimeout(timeout);
    rejectDeadline = undefined;
  }
}

async function acquireTokenBeforeDeadline(
  config: ValidatedConfiguration,
  signal: AbortSignal,
): Promise<CachedToken> {
  try {
    const response = await config.fetch(config.tokenEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: config.authorization,
        "Cache-Control": "no-store",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: config.scope,
      }),
      redirect: "manual",
      signal,
    });
    if (!(response instanceof Response) || response.status !== 200) {
      unavailable();
    }
    if (!isJsonContentType(response.headers.get("content-type"))) {
      unavailable();
    }
    const document = await readBoundedJson(response);
    const token = exactTokenResponse(document, config);
    const issuedAt = currentEpochSeconds(config.now);
    if (token.expiresIn <= config.expirySkewSeconds) unavailable();
    return Object.freeze({
      value: token.accessToken,
      issuedAt,
      expiresAt: issuedAt + token.expiresIn,
    });
  } catch {
    unavailable();
  }
}

function isJsonContentType(value: string | null): boolean {
  return value !== null &&
    /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/iu.test(
      value.trim(),
    );
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > TOKEN_RESPONSE_MAX_BYTES)
  ) {
    unavailable();
  }
  if (response.body === null) unavailable();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > TOKEN_RESPONSE_MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The fixed failure below owns this boundary.
        }
        unavailable();
      }
      chunks.push(next.value);
    }
  } catch {
    unavailable();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    unavailable();
  }
  try {
    return JSON.parse(text);
  } catch {
    unavailable();
  }
}

function exactTokenResponse(
  value: unknown,
  config: ValidatedConfiguration,
): Readonly<{ accessToken: string; expiresIn: number }> {
  if (!isRecord(value)) unavailable();
  const expectedKeys = ["access_token", "token_type", "expires_in", "scope"];
  const keys = Object.keys(value);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in value)) ||
    keys.some((key) => !expectedKeys.includes(key)) ||
    typeof value.access_token !== "string" ||
    value.access_token.length < 1 ||
    value.access_token.length > ACCESS_TOKEN_MAX_LENGTH ||
    !/^[\x21-\x7e]+$/u.test(value.access_token) ||
    typeof value.token_type !== "string" ||
    value.token_type.toLowerCase() !== "bearer" ||
    !Number.isInteger(value.expires_in) ||
    (value.expires_in as number) < 1 ||
    (value.expires_in as number) > MAX_TOKEN_LIFETIME_SECONDS ||
    typeof value.scope !== "string" ||
    value.scope !== config.scope
  ) {
    unavailable();
  }
  return Object.freeze({
    accessToken: value.access_token,
    expiresIn: value.expires_in as number,
  });
}

function currentEpochSeconds(now: () => Date): number {
  let value: Date;
  try {
    value = now();
  } catch {
    unavailable();
  }
  const milliseconds = value instanceof Date ? value.valueOf() : Number.NaN;
  const seconds = Math.floor(milliseconds / 1_000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) unavailable();
  return seconds;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(): never {
  throw new AittaDBServiceTokenFailure();
}
