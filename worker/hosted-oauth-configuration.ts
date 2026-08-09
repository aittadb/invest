import { OWNER_OAUTH_CALLBACK_PATH } from "../domain/owner-oauth-proof-resource.ts";

const STORAGE_SCOPES = [
  "storage.read",
  "storage.write",
  "storage.delete",
] as const;
const CONFIGURATION_FIELDS = [
  "AITTADB_OAUTH_ISSUER",
  "AITTADB_OAUTH_CLIENT_ID",
  "AITTADB_OAUTH_CLIENT_SECRET",
  "AITTADB_OAUTH_CALLBACK_URI",
  "AITTADB_OAUTH_STORAGE_SCOPES",
  "AITTADB_OAUTH_TRANSACTION_KEY",
  "AITTADB_OAUTH_CSRF_KEY",
] as const;

export type HostedOAuthStorageScope = typeof STORAGE_SCOPES[number];

export type HostedAittaDBOAuthEnvironment = Readonly<{
  APP_BASE_URL?: unknown;
  AITTADB_OAUTH_ISSUER?: unknown;
  AITTADB_OAUTH_CLIENT_ID?: unknown;
  AITTADB_OAUTH_CLIENT_SECRET?: unknown;
  AITTADB_OAUTH_CALLBACK_URI?: unknown;
  AITTADB_OAUTH_STORAGE_SCOPES?: unknown;
  AITTADB_OAUTH_TRANSACTION_KEY?: unknown;
  AITTADB_OAUTH_CSRF_KEY?: unknown;
}>;

export type HostedAittaDBOAuthConfiguration = Readonly<{
  appOrigin: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  callbackUri: string;
  storageScopes: readonly HostedOAuthStorageScope[];
  transactionCookieKey: CryptoKey;
  csrfCookieKey: CryptoKey;
}>;

/** Returns null for both disabled and invalid hosted configuration. */
export async function parseHostedAittaDBOAuthConfiguration(
  environment: HostedAittaDBOAuthEnvironment,
): Promise<HostedAittaDBOAuthConfiguration | null> {
  if (CONFIGURATION_FIELDS.every((field) => environment[field] === undefined)) {
    return null;
  }

  try {
    const appOrigin = exactHttpsOrigin(environment.APP_BASE_URL);
    const issuer = exactHttpsOrigin(environment.AITTADB_OAUTH_ISSUER);
    const clientId = exactCredential(
      environment.AITTADB_OAUTH_CLIENT_ID,
      1,
      255,
      false,
    );
    const clientSecret = exactCredential(
      environment.AITTADB_OAUTH_CLIENT_SECRET,
      16,
      512,
      true,
    );
    const callbackUri = exactCallbackUri(
      environment.AITTADB_OAUTH_CALLBACK_URI,
      appOrigin,
    );
    const storageScopes = exactStorageScopes(
      environment.AITTADB_OAUTH_STORAGE_SCOPES,
    );
    const transactionKeyMaterial = exactKeyMaterial(
      environment.AITTADB_OAUTH_TRANSACTION_KEY,
    );
    const csrfKeyMaterial = exactKeyMaterial(
      environment.AITTADB_OAUTH_CSRF_KEY,
    );
    if (transactionKeyMaterial === csrfKeyMaterial) invalid();

    const [transactionCookieKey, csrfCookieKey] = await Promise.all([
      importAesKey(transactionKeyMaterial),
      importAesKey(csrfKeyMaterial),
    ]);

    return Object.freeze({
      appOrigin,
      issuer,
      clientId,
      clientSecret,
      callbackUri,
      storageScopes: Object.freeze([...storageScopes]),
      transactionCookieKey,
      csrfCookieKey,
    });
  } catch {
    return null;
  }
}

function exactHttpsOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    invalid();
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    value !== url.href && value !== url.origin
  ) {
    invalid();
  }
  return url.origin;
}

function exactCallbackUri(value: unknown, appOrigin: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    invalid();
  }
  const expected = new URL(OWNER_OAUTH_CALLBACK_PATH, appOrigin).href;
  const callback = new URL(value);
  if (
    callback.protocol !== "https:" ||
    callback.username !== "" ||
    callback.password !== "" ||
    callback.search !== "" ||
    callback.hash !== "" ||
    callback.href !== expected ||
    value !== expected
  ) {
    invalid();
  }
  return expected;
}

function exactCredential(
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
    invalid();
  }
  return value;
}

function exactStorageScopes(value: unknown): readonly HostedOAuthStorageScope[] {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    invalid();
  }
  const scopes = value.split(" ");
  if (
    scopes.length < 1 ||
    scopes.length > STORAGE_SCOPES.length ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !isStorageScope(scope)) ||
    scopes.join(" ") !== value
  ) {
    invalid();
  }
  const canonical = STORAGE_SCOPES.filter((scope) => scopes.includes(scope));
  if (canonical.join(" ") !== value) invalid();
  return canonical;
}

function isStorageScope(value: string): value is HostedOAuthStorageScope {
  return (STORAGE_SCOPES as readonly string[]).includes(value);
}

function exactKeyMaterial(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 43 ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value)
  ) {
    invalid();
  }
  const bytes = decodeBase64Url(value);
  if (bytes.byteLength !== 32 || encodeBase64Url(bytes) !== value) invalid();
  bytes.fill(0);
  return value;
}

async function importAesKey(value: string): Promise<CryptoKey> {
  const bytes = decodeBase64Url(value);
  try {
    return await crypto.subtle.importKey(
      "raw",
      exactArrayBuffer(bytes),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    bytes.fill(0);
  }
}

function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

function decodeBase64Url(value: string): Uint8Array {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") + padding,
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function invalid(): never {
  throw new Error("Invalid hosted OAuth configuration.");
}
