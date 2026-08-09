import { parseActorSubject, type ActorSubject } from "../domain/foundation.ts";
import { OWNER_OAUTH_CALLBACK_PATH } from "../domain/owner-oauth-proof-resource.ts";

const DISCOVERY_MAX_BYTES = 16_384;
const TOKEN_MAX_BYTES = 16_384;
const INTROSPECTION_MAX_BYTES = 16_384;
const CALLBACK_MAX_LENGTH = 8_192;
const COOKIE_HEADER_MAX_LENGTH = 8_192;
const COOKIE_VALUE_MAX_LENGTH = 4_096;
const COOKIE_PLAINTEXT_MAX_BYTES = 2_048;
const MIN_TRANSACTION_TTL_SECONDS = 60;
const MAX_TRANSACTION_TTL_SECONDS = 600;
const MIN_RANDOM_BYTES = 32;
const MAX_TOKEN_LIFETIME_SECONDS = 86_400;
const STORAGE_SCOPES = new Set([
  "storage.read",
  "storage.write",
  "storage.delete",
]);

export const DEFAULT_OAUTH_TRANSACTION_COOKIE =
  "__Host-investor_app_aittadb_oauth";

export type AittaDBOAuthFetch = (request: Request) => Promise<Response>;
export type OAuthRandomBytes = (length: number) => Uint8Array;

export type OAuthTransactionClaim = Readonly<{
  fingerprint: string;
  ownerSubject: ActorSubject;
  expiresAt: string;
}>;

export interface OAuthTransactionClaimStore {
  claim(transaction: OAuthTransactionClaim): Promise<boolean>;
}

export type AittaDBOAuthProofMetadata = Readonly<{
  ownerSubject: ActorSubject;
  issuer: string;
  audience: string;
  scopes: readonly string[];
  verifiedAt: string;
  tokenExpiresAt: string;
}>;

export interface AittaDBOAuthProofResultSink {
  recordVerifiedProof(proof: AittaDBOAuthProofMetadata): Promise<void>;
}

export type AittaDBOAuthProofDependencies = Readonly<{
  issuer: string;
  clientId: string;
  clientSecret: string;
  callbackUri: string;
  allowedStorageScopes: readonly string[];
  requestedStorageScopes: readonly string[];
  transactionCookieKey: CryptoKey;
  transactionClaimStore: OAuthTransactionClaimStore;
  resultSink: AittaDBOAuthProofResultSink;
  fetch: AittaDBOAuthFetch;
  now: () => Date;
  randomBytes: OAuthRandomBytes;
  transactionTtlSeconds: number;
  transactionCookieName?: string;
}>;

export type OAuthAuthorizationStart = Readonly<{
  authorizationUrl: string;
  setCookie: string;
}>;

export type OAuthProofFailureCode =
  | "invalid_callback"
  | "service_unavailable";

export class OAuthProofFailure extends Error {
  readonly code: OAuthProofFailureCode;

  constructor(code: OAuthProofFailureCode) {
    super(
      code === "invalid_callback"
        ? "The connection could not be verified."
        : "The connection service is temporarily unavailable.",
    );
    this.name = "OAuthProofFailure";
    this.code = code;
  }
}

export interface AittaDBOAuthProofService {
  readonly callbackUri: string;
  readonly transactionCookieName: string;
  availability(): Promise<boolean>;
  begin(ownerSubject: string): Promise<OAuthAuthorizationStart>;
  complete(
    ownerSubject: string,
    callbackUrl: string,
    cookieHeader: string | null,
  ): Promise<AittaDBOAuthProofMetadata>;
  clearCookie(): string;
}

type ValidatedConfiguration = Readonly<{
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  introspectionEndpoint: string;
  clientId: string;
  clientSecret: string;
  callbackUri: string;
  allowedStorageScopes: readonly string[];
  requestedStorageScopes: readonly string[];
  scope: string;
  transactionCookieKey: CryptoKey;
  transactionClaimStore: OAuthTransactionClaimStore;
  resultSink: AittaDBOAuthProofResultSink;
  fetch: AittaDBOAuthFetch;
  now: () => Date;
  randomBytes: OAuthRandomBytes;
  transactionTtlSeconds: number;
  transactionCookieName: string;
}>;

type Discovery = Readonly<{
  authorizationEndpoint: string;
  tokenEndpoint: string;
  introspectionEndpoint: string;
}>;

type Transaction = Readonly<{
  state: string;
  verifier: string;
  ownerSubject: ActorSubject;
  issuedAt: number;
  expiresAt: number;
  issuer: string;
  clientId: string;
  callbackUri: string;
  scope: string;
}>;

export function createAittaDBOAuthProofService(
  dependencies: AittaDBOAuthProofDependencies,
): AittaDBOAuthProofService {
  const config = validateConfiguration(dependencies);

  return Object.freeze({
    callbackUri: config.callbackUri,
    transactionCookieName: config.transactionCookieName,
    async availability() {
      try {
        await discover(config);
        return true;
      } catch {
        return false;
      }
    },
    async begin(ownerSubjectValue: string) {
      const ownerSubject = requiredOwnerSubject(ownerSubjectValue);
      const discovery = await discover(config);
      const now = currentEpochSeconds(config.now);
      const state = randomBase64Url(config.randomBytes, MIN_RANDOM_BYTES);
      const verifier = randomBase64Url(config.randomBytes, MIN_RANDOM_BYTES);
      if (state === verifier) unavailable();
      const challenge = await sha256Base64Url(verifier);
      const transaction: Transaction = Object.freeze({
        state,
        verifier,
        ownerSubject,
        issuedAt: now,
        expiresAt: now + config.transactionTtlSeconds,
        issuer: config.issuer,
        clientId: config.clientId,
        callbackUri: config.callbackUri,
        scope: config.scope,
      });
      const encrypted = await encryptTransaction(config, transaction);
      const authorizationUrl = new URL(discovery.authorizationEndpoint);
      authorizationUrl.search = new URLSearchParams({
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: config.callbackUri,
        scope: config.scope,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();

      return Object.freeze({
        authorizationUrl: authorizationUrl.href,
        setCookie: transactionCookie(
          config.transactionCookieName,
          encrypted,
          config.transactionTtlSeconds,
        ),
      });
    },
    async complete(
      ownerSubjectValue: string,
      callbackUrlValue: string,
      cookieHeader: string | null,
    ) {
      const ownerSubject = requiredOwnerSubject(ownerSubjectValue);
      const callbackUrl = exactCallbackUrl(callbackUrlValue, config.callbackUri);
      const transaction = await decryptTransaction(
        config,
        requiredCookieValue(
          cookieHeader,
          config.transactionCookieName,
        ),
      );
      const now = currentEpochSeconds(config.now);
      assertCurrentTransaction(transaction, ownerSubject, config, now);

      const state = oneQueryValue(callbackUrl.searchParams, "state");
      if (state === null || !(await constantTimeTextEquals(state, transaction.state))) {
        invalidCallback();
      }

      const fingerprint = await sha256Base64Url(transaction.state);
      const claimed = await claimTransaction(config, {
        fingerprint,
        ownerSubject,
        expiresAt: new Date(transaction.expiresAt * 1_000).toISOString(),
      });
      if (!claimed) invalidCallback();

      if (oneQueryValue(callbackUrl.searchParams, "error") !== null) {
        invalidCallback();
      }
      const code = oneQueryValue(callbackUrl.searchParams, "code");
      if (code === null || code.length < 1 || code.length > 2_048) {
        invalidCallback();
      }
      if (callbackUrl.searchParams.has("error_description") ||
        callbackUrl.searchParams.has("error_uri")) {
        invalidCallback();
      }
      for (const key of callbackUrl.searchParams.keys()) {
        if (key !== "state" && key !== "code") invalidCallback();
      }

      const discovery = await discover(config);
      const token = await exchangeAuthorizationCode(
        config,
        discovery,
        code,
        transaction.verifier,
      );
      const proof = await introspectAccessToken(
        config,
        discovery,
        ownerSubject,
        token,
        now,
      );
      await recordProof(config, proof);
      return proof;
    },
    clearCookie() {
      return clearTransactionCookie(config.transactionCookieName);
    },
  });
}

function validateConfiguration(
  input: AittaDBOAuthProofDependencies,
): ValidatedConfiguration {
  const issuer = exactHttpsUrl(input.issuer, false);
  const callbackUri = exactHttpsUrl(input.callbackUri, true);
  const clientId = basicCredential(input.clientId, false);
  const clientSecret = basicCredential(input.clientSecret, true);
  const allowedStorageScopes = storageScopes(input.allowedStorageScopes, false);
  const requestedStorageScopes = storageScopes(input.requestedStorageScopes, true);
  if (requestedStorageScopes.some((scope) => !allowedStorageScopes.includes(scope))) {
    invalidConfiguration();
  }
  if (
    !Number.isInteger(input.transactionTtlSeconds) ||
    input.transactionTtlSeconds < MIN_TRANSACTION_TTL_SECONDS ||
    input.transactionTtlSeconds > MAX_TRANSACTION_TTL_SECONDS
  ) {
    invalidConfiguration();
  }
  const cookieName = input.transactionCookieName ??
    DEFAULT_OAUTH_TRANSACTION_COOKIE;
  if (!/^__Host-[A-Za-z0-9_]+$/.test(cookieName)) invalidConfiguration();
  if (
    !(input.transactionCookieKey instanceof CryptoKey) ||
    input.transactionCookieKey.algorithm.name !== "AES-GCM" ||
    !input.transactionCookieKey.usages.includes("encrypt") ||
    !input.transactionCookieKey.usages.includes("decrypt") ||
    typeof input.fetch !== "function" ||
    typeof input.now !== "function" ||
    typeof input.randomBytes !== "function" ||
    typeof input.transactionClaimStore?.claim !== "function" ||
    typeof input.resultSink?.recordVerifiedProof !== "function"
  ) {
    invalidConfiguration();
  }

  return Object.freeze({
    issuer,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/oauth/token`,
    introspectionEndpoint: `${issuer}/oauth/introspect`,
    clientId,
    clientSecret,
    callbackUri,
    allowedStorageScopes: Object.freeze([...allowedStorageScopes]),
    requestedStorageScopes: Object.freeze([...requestedStorageScopes]),
    scope: requestedStorageScopes.join(" "),
    transactionCookieKey: input.transactionCookieKey,
    transactionClaimStore: input.transactionClaimStore,
    resultSink: input.resultSink,
    fetch: input.fetch,
    now: input.now,
    randomBytes: input.randomBytes,
    transactionTtlSeconds: input.transactionTtlSeconds,
    transactionCookieName: cookieName,
  });
}

async function discover(config: ValidatedConfiguration): Promise<Discovery> {
  const document = await fetchJson(
    config,
    new Request(`${config.issuer}/.well-known/openid-configuration`, {
      method: "GET",
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      credentials: "omit",
      redirect: "error",
    }),
    DISCOVERY_MAX_BYTES,
  );
  if (
    document.issuer !== config.issuer ||
    document.authorization_endpoint !== config.authorizationEndpoint ||
    document.token_endpoint !== config.tokenEndpoint ||
    document.introspection_endpoint !== config.introspectionEndpoint ||
    !stringArray(document.response_types_supported).includes("code") ||
    !stringArray(document.grant_types_supported).includes("authorization_code") ||
    !stringArray(document.code_challenge_methods_supported).includes("S256") ||
    !stringArray(document.token_endpoint_auth_methods_supported).includes(
      "client_secret_basic",
    ) ||
    !config.requestedStorageScopes.every((scope) =>
      stringArray(document.scopes_supported).includes(scope)
    )
  ) {
    unavailable();
  }
  return Object.freeze({
    authorizationEndpoint: config.authorizationEndpoint,
    tokenEndpoint: config.tokenEndpoint,
    introspectionEndpoint: config.introspectionEndpoint,
  });
}

async function exchangeAuthorizationCode(
  config: ValidatedConfiguration,
  discovery: Discovery,
  code: string,
  verifier: string,
): Promise<Readonly<{
  accessToken: string;
  expiresIn: number;
}>> {
  const document = await fetchJson(
    config,
    confidentialRequest(
      discovery.tokenEndpoint,
      config,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.callbackUri,
        code_verifier: verifier,
      }),
    ),
    TOKEN_MAX_BYTES,
  );
  const keys = Object.keys(document);
  if (
    keys.some((key) =>
      !["access_token", "token_type", "expires_in", "scope"].includes(key)
    ) ||
    typeof document.access_token !== "string" ||
    document.access_token.length < 1 ||
    document.access_token.length > 8_192 ||
    typeof document.token_type !== "string" ||
    document.token_type.toLowerCase() !== "bearer" ||
    !Number.isInteger(document.expires_in) ||
    (document.expires_in as number) < 1 ||
    (document.expires_in as number) > MAX_TOKEN_LIFETIME_SECONDS ||
    typeof document.scope !== "string" ||
    !sameScopes(document.scope, config.requestedStorageScopes)
  ) {
    unavailable();
  }
  return Object.freeze({
    accessToken: document.access_token,
    expiresIn: document.expires_in as number,
  });
}

async function introspectAccessToken(
  config: ValidatedConfiguration,
  discovery: Discovery,
  ownerSubject: ActorSubject,
  token: Readonly<{ accessToken: string; expiresIn: number }>,
  now: number,
): Promise<AittaDBOAuthProofMetadata> {
  const document = await fetchJson(
    config,
    confidentialRequest(
      discovery.introspectionEndpoint,
      config,
      new URLSearchParams({
        token: token.accessToken,
        token_type_hint: "access_token",
      }),
    ),
    INTROSPECTION_MAX_BYTES,
  );
  const allowedKeys = new Set([
    "active",
    "iss",
    "sub",
    "aud",
    "exp",
    "iat",
    "nbf",
    "jti",
    "scope",
    "token_use",
  ]);
  const expiry = document.exp;
  const issuedAt = document.iat;
  const notBefore = document.nbf;
  if (
    Object.keys(document).length > allowedKeys.size ||
    Object.keys(document).some((key) => !allowedKeys.has(key)) ||
    document.active !== true ||
    document.iss !== config.issuer ||
    document.aud !== config.clientId ||
    document.token_use !== "access" ||
    !isCanonicalUuid(document.sub) ||
    !isCanonicalUuid(document.jti) ||
    !Number.isInteger(expiry) ||
    (expiry as number) <= now ||
    (expiry as number) > now + token.expiresIn + 60 ||
    (expiry as number) > now + MAX_TOKEN_LIFETIME_SECONDS ||
    !Number.isInteger(issuedAt) ||
    (issuedAt as number) > now + 60 ||
    (issuedAt as number) > (expiry as number) ||
    (issuedAt as number) < (expiry as number) - MAX_TOKEN_LIFETIME_SECONDS - 60 ||
    !Number.isInteger(notBefore) ||
    (notBefore as number) > now ||
    (notBefore as number) > (expiry as number) ||
    Math.abs((notBefore as number) - (issuedAt as number)) > 60 ||
    typeof document.scope !== "string" ||
    !sameScopes(document.scope, config.requestedStorageScopes)
  ) {
    unavailable();
  }
  const verifiedAt = new Date(now * 1_000).toISOString();
  const tokenExpiresAt = new Date((expiry as number) * 1_000).toISOString();
  return Object.freeze({
    ownerSubject,
    issuer: config.issuer,
    audience: config.clientId,
    scopes: Object.freeze([...config.requestedStorageScopes]),
    verifiedAt,
    tokenExpiresAt,
  });
}

function confidentialRequest(
  url: string,
  config: ValidatedConfiguration,
  body: URLSearchParams,
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
      "Cache-Control": "no-store",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    credentials: "omit",
    redirect: "error",
  });
}

async function fetchJson(
  config: ValidatedConfiguration,
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await config.fetch(request);
  } catch {
    unavailable();
  }
  if (
    !response.ok ||
    !response.headers.get("content-type")?.toLowerCase().startsWith(
      "application/json",
    )
  ) {
    unavailable();
  }
  const text = await readBoundedText(response, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    unavailable();
  }
  if (!isRecord(parsed) || Object.keys(parsed).length > 32) unavailable();
  return parsed;
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
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
      if (total > maxBytes) {
        await reader.cancel();
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
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    unavailable();
  }
}

async function encryptTransaction(
  config: ValidatedConfiguration,
  transaction: Transaction,
): Promise<string> {
  const iv = checkedRandomBytes(config.randomBytes, 12);
  const plaintext = new TextEncoder().encode(JSON.stringify({
    v: 1,
    s: transaction.state,
    p: transaction.verifier,
    o: transaction.ownerSubject,
    i: transaction.issuedAt,
    e: transaction.expiresAt,
    iss: transaction.issuer,
    c: transaction.clientId,
    r: transaction.callbackUri,
    sc: transaction.scope,
  }));
  if (plaintext.byteLength > COOKIE_PLAINTEXT_MAX_BYTES) unavailable();
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: exactArrayBuffer(iv),
        additionalData: exactArrayBuffer(cookieAdditionalData(config)),
        tagLength: 128,
      },
      config.transactionCookieKey,
      plaintext,
    );
  } catch {
    unavailable();
  }
  const value = `${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
  if (value.length > COOKIE_VALUE_MAX_LENGTH) unavailable();
  return value;
}

async function decryptTransaction(
  config: ValidatedConfiguration,
  value: string,
): Promise<Transaction> {
  const parts = value.split(".");
  if (parts.length !== 2) invalidCallback();
  const iv = fromBase64Url(parts[0] ?? "", 12, 12);
  const ciphertext = fromBase64Url(
    parts[1] ?? "",
    17,
    COOKIE_PLAINTEXT_MAX_BYTES + 16,
  );
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: exactArrayBuffer(iv),
        additionalData: exactArrayBuffer(cookieAdditionalData(config)),
        tagLength: 128,
      },
      config.transactionCookieKey,
      exactArrayBuffer(ciphertext),
    );
  } catch {
    invalidCallback();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    );
  } catch {
    invalidCallback();
  }
  return parseTransaction(parsed);
}

function parseTransaction(value: unknown): Transaction {
  if (!isRecord(value)) invalidCallback();
  const expected = ["v", "s", "p", "o", "i", "e", "iss", "c", "r", "sc"];
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !(key in value)) ||
    value.v !== 1 ||
    !isBase64UrlToken(value.s, 43) ||
    !isBase64UrlToken(value.p, 43) ||
    typeof value.o !== "string" ||
    !Number.isInteger(value.i) ||
    !Number.isInteger(value.e) ||
    typeof value.iss !== "string" ||
    typeof value.c !== "string" ||
    typeof value.r !== "string" ||
    typeof value.sc !== "string"
  ) {
    invalidCallback();
  }
  const ownerSubject = parseActorSubject(value.o);
  if (!ownerSubject.ok) invalidCallback();
  return Object.freeze({
    state: value.s,
    verifier: value.p,
    ownerSubject: ownerSubject.value,
    issuedAt: value.i as number,
    expiresAt: value.e as number,
    issuer: value.iss,
    clientId: value.c,
    callbackUri: value.r,
    scope: value.sc,
  });
}

function assertCurrentTransaction(
  transaction: Transaction,
  ownerSubject: ActorSubject,
  config: ValidatedConfiguration,
  now: number,
): void {
  if (
    transaction.ownerSubject !== ownerSubject ||
    transaction.issuer !== config.issuer ||
    transaction.clientId !== config.clientId ||
    transaction.callbackUri !== config.callbackUri ||
    transaction.scope !== config.scope ||
    transaction.expiresAt !== transaction.issuedAt + config.transactionTtlSeconds ||
    transaction.issuedAt > now ||
    transaction.expiresAt <= now
  ) {
    invalidCallback();
  }
}

async function claimTransaction(
  config: ValidatedConfiguration,
  claim: OAuthTransactionClaim,
): Promise<boolean> {
  try {
    return (await config.transactionClaimStore.claim(Object.freeze(claim))) === true;
  } catch {
    unavailable();
  }
}

async function recordProof(
  config: ValidatedConfiguration,
  proof: AittaDBOAuthProofMetadata,
): Promise<void> {
  try {
    await config.resultSink.recordVerifiedProof(proof);
  } catch {
    unavailable();
  }
}

function exactCallbackUrl(value: string, callbackUri: string): URL {
  if (typeof value !== "string" || value.length > CALLBACK_MAX_LENGTH) {
    invalidCallback();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidCallback();
  }
  const base = new URL(url);
  base.search = "";
  base.hash = "";
  if (base.href !== callbackUri || url.hash !== "") invalidCallback();
  return url;
}

function requiredCookieValue(
  header: string | null,
  cookieName: string,
): string {
  if (header === null || header.length > COOKIE_HEADER_MAX_LENGTH) {
    invalidCallback();
  }
  const values: string[] = [];
  for (const raw of header.split(";")) {
    const part = raw.trim();
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator) === cookieName) {
      values.push(part.slice(separator + 1));
    }
  }
  if (
    values.length !== 1 ||
    !values[0] ||
    values[0].length > COOKIE_VALUE_MAX_LENGTH ||
    !/^[A-Za-z0-9_.-]+$/.test(values[0])
  ) {
    invalidCallback();
  }
  return values[0];
}

function transactionCookie(
  name: string,
  value: string,
  ttlSeconds: number,
): string {
  return `${name}=${value}; Path=/; Max-Age=${ttlSeconds}; Secure; HttpOnly; SameSite=Lax`;
}

function clearTransactionCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`;
}

function cookieAdditionalData(config: ValidatedConfiguration): Uint8Array {
  return new TextEncoder().encode(
    `${config.transactionCookieName}\n${config.callbackUri}`,
  );
}

function exactHttpsUrl(value: unknown, callback: boolean): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    invalidConfiguration();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidConfiguration();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (callback && url.pathname !== OWNER_OAUTH_CALLBACK_PATH)
  ) {
    invalidConfiguration();
  }
  if (!callback) {
    if (url.pathname !== "/") invalidConfiguration();
    return url.origin;
  }
  return url.href;
}

function basicCredential(value: unknown, secret: boolean): string {
  const maxLength = secret ? 512 : 255;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    !/^[\x21-\x7e]+$/.test(value) ||
    (!secret && value.includes(":"))
  ) {
    invalidConfiguration();
  }
  return value;
}

function storageScopes(
  value: readonly string[],
  requireOne: boolean,
): string[] {
  if (!Array.isArray(value) || value.length > STORAGE_SCOPES.size) {
    invalidConfiguration();
  }
  const scopes = [...value];
  if (
    (requireOne && scopes.length < 1) ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !STORAGE_SCOPES.has(scope))
  ) {
    invalidConfiguration();
  }
  return scopes;
}

function currentEpochSeconds(now: () => Date): number {
  let date: Date;
  try {
    date = now();
  } catch {
    unavailable();
  }
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) unavailable();
  return Math.floor(date.valueOf() / 1_000);
}

function requiredOwnerSubject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  if (!parsed.ok) invalidCallback();
  return parsed.value;
}

function randomBase64Url(
  randomBytes: OAuthRandomBytes,
  length: number,
): string {
  return base64Url(checkedRandomBytes(randomBytes, length));
}

function checkedRandomBytes(
  randomBytes: OAuthRandomBytes,
  length: number,
): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = randomBytes(length);
  } catch {
    unavailable();
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
    unavailable();
  }
  return new Uint8Array(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
  } catch {
    unavailable();
  }
  return base64Url(new Uint8Array(digest));
}

async function constantTimeTextEquals(
  left: string,
  right: string,
): Promise<boolean> {
  const leftDigest = await sha256Base64Url(left);
  const rightDigest = await sha256Base64Url(right);
  let different = leftDigest.length ^ rightDigest.length;
  const length = Math.max(leftDigest.length, rightDigest.length);
  for (let index = 0; index < length; index += 1) {
    different |= (leftDigest.charCodeAt(index) || 0) ^
      (rightDigest.charCodeAt(index) || 0);
  }
  return different === 0;
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64Url(
  value: string,
  minBytes: number,
  maxBytes: number,
): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalidCallback();
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  } catch {
    invalidCallback();
  }
  if (binary.length < minBytes || binary.length > maxBytes) invalidCallback();
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isBase64UrlToken(value: unknown, length: number): value is string {
  return typeof value === "string" &&
    value.length === length &&
    /^[A-Za-z0-9_-]+$/.test(value);
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    );
}

function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

function oneQueryValue(
  parameters: URLSearchParams,
  name: string,
): string | null {
  const values = parameters.getAll(name);
  return values.length === 1 ? values[0] ?? null : null;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) &&
    value.length <= 32 &&
    value.every((entry) => typeof entry === "string" && entry.length <= 255)
    ? value
    : [];
}

function sameScopes(value: string, expected: readonly string[]): boolean {
  const scopes = value.split(/\s+/u).filter(Boolean);
  return scopes.length === expected.length &&
    new Set(scopes).size === scopes.length &&
    expected.every((scope) => scopes.includes(scope));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidConfiguration(): never {
  throw new OAuthProofFailure("service_unavailable");
}

function invalidCallback(): never {
  throw new OAuthProofFailure("invalid_callback");
}

function unavailable(): never {
  throw new OAuthProofFailure("service_unavailable");
}
