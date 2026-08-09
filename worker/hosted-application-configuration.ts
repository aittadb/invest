import {
  createAittaDBServiceTokenProvider,
  type AittaDBServiceTokenFetch,
  type AittaDBServiceTokenProvider,
  type AittaDBStorageScope,
} from "../services/aittadb-service-token.ts";

const REQUIRED_STORAGE_SCOPES = [
  "storage.read",
  "storage.write",
  "storage.delete",
] as const satisfies readonly AittaDBStorageScope[];
const REQUIRED_CONFIGURATION_FIELDS = [
  "AITTADB_STORAGE_ISSUER",
  "AITTADB_STORAGE_ENTRY_HREF",
  "AITTADB_STORAGE_CLIENT_ID",
  "AITTADB_STORAGE_CLIENT_SECRET",
  "AITTADB_STORAGE_SCOPES",
  "BROWSER_MUTATION_SESSION_KEY",
] as const;
const OPTIONAL_CONFIGURATION_FIELDS = [
  "AITTADB_STORAGE_TRANSPORT_ORIGIN",
] as const;

export type HostedAittaDBApplicationEnvironment = Readonly<{
  APP_BASE_URL?: unknown;
  AITTADB_STORAGE_ISSUER?: unknown;
  AITTADB_STORAGE_TRANSPORT_ORIGIN?: unknown;
  AITTADB_STORAGE_ENTRY_HREF?: unknown;
  AITTADB_STORAGE_CLIENT_ID?: unknown;
  AITTADB_STORAGE_CLIENT_SECRET?: unknown;
  AITTADB_STORAGE_SCOPES?: unknown;
  BROWSER_MUTATION_SESSION_KEY?: unknown;
  AITTADB_OAUTH_CLIENT_ID?: unknown;
  AITTADB_OAUTH_CLIENT_SECRET?: unknown;
  AITTADB_OAUTH_TRANSACTION_KEY?: unknown;
  AITTADB_OAUTH_CSRF_KEY?: unknown;
}>;

export type HostedAittaDBApplicationConfiguration = Readonly<{
  appOrigin: string;
  issuer: string;
  transportOrigin: string;
  storageEntryHref: string;
  storageScopes: readonly AittaDBStorageScope[];
  mutationKey: CryptoKey;
  createServiceTokenProvider(
    dependencies: Readonly<{
      expirySkewSeconds: number;
      requestTimeoutMs: number;
      fetch: AittaDBServiceTokenFetch;
      now: () => Date;
    }>,
  ): AittaDBServiceTokenProvider;
}>;

/** Returns null for both disabled and invalid application persistence. */
export async function parseHostedAittaDBApplicationConfiguration(
  environment: HostedAittaDBApplicationEnvironment,
): Promise<HostedAittaDBApplicationConfiguration | null> {
  try {
    const configured = [
      ...REQUIRED_CONFIGURATION_FIELDS,
      ...OPTIONAL_CONFIGURATION_FIELDS,
    ].some((field) => environment[field] !== undefined);
    if (!configured) return null;

    const appOrigin = exactHttpsOrigin(environment.APP_BASE_URL);
    const issuer = exactHttpsOrigin(environment.AITTADB_STORAGE_ISSUER);
    const transportOrigin = environment.AITTADB_STORAGE_TRANSPORT_ORIGIN ===
        undefined
      ? issuer
      : exactHttpsOrigin(environment.AITTADB_STORAGE_TRANSPORT_ORIGIN);
    const storageEntryHref = exactStorageEntryHref(
      environment.AITTADB_STORAGE_ENTRY_HREF,
      issuer,
    );
    const serviceClientId = exactCredential(
      environment.AITTADB_STORAGE_CLIENT_ID,
      1,
      255,
      false,
    );
    const serviceClientSecret = exactCredential(
      environment.AITTADB_STORAGE_CLIENT_SECRET,
      16,
      512,
      true,
    );
    const storageScopes = exactStorageScopes(
      environment.AITTADB_STORAGE_SCOPES,
    );
    const mutationKeyMaterial = exactKeyMaterial(
      environment.BROWSER_MUTATION_SESSION_KEY,
    );
    rejectReusedProofMaterial(
      environment,
      serviceClientId,
      serviceClientSecret,
      mutationKeyMaterial,
    );
    const mutationKey = await importAesKey(mutationKeyMaterial);
    const createServiceTokenProvider = Object.freeze((
      dependencies: Readonly<{
        expirySkewSeconds: number;
        requestTimeoutMs: number;
        fetch: AittaDBServiceTokenFetch;
        now: () => Date;
      }>,
    ) => createAittaDBServiceTokenProvider({
      issuer,
      transportOrigin,
      clientId: serviceClientId,
      clientSecret: serviceClientSecret,
      storageScopes,
      expirySkewSeconds: dependencies.expirySkewSeconds,
      requestTimeoutMs: dependencies.requestTimeoutMs,
      fetch: dependencies.fetch,
      now: dependencies.now,
    }));

    return Object.freeze({
      appOrigin,
      issuer,
      transportOrigin,
      storageEntryHref,
      storageScopes: Object.freeze([...storageScopes]),
      mutationKey,
      createServiceTokenProvider,
    });
  } catch {
    return null;
  }
}

function exactHttpsOrigin(value: unknown): string {
  const url = exactHttpsUrl(value);
  if (
    url.pathname !== "/" ||
    url.search !== "" ||
    value !== url.origin && value !== url.href
  ) {
    invalid();
  }
  return url.origin;
}

function exactStorageEntryHref(value: unknown, issuer: string): string {
  const url = exactHttpsUrl(value);
  if (url.origin !== issuer || url.search !== "") invalid();
  return url.href;
}

function exactHttpsUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    invalid();
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    value !== url.href && !(
      url.pathname === "/" &&
      url.search === "" &&
      value === url.origin
    )
  ) {
    invalid();
  }
  return url;
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

function exactStorageScopes(value: unknown): readonly AittaDBStorageScope[] {
  const expected = REQUIRED_STORAGE_SCOPES.join(" ");
  if (value !== expected) invalid();
  return REQUIRED_STORAGE_SCOPES;
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

function rejectReusedProofMaterial(
  environment: HostedAittaDBApplicationEnvironment,
  serviceClientId: string,
  serviceClientSecret: string,
  mutationKey: string,
): void {
  const material = [
    serviceClientId,
    serviceClientSecret,
    mutationKey,
    environment.AITTADB_OAUTH_CLIENT_ID,
    environment.AITTADB_OAUTH_CLIENT_SECRET,
    environment.AITTADB_OAUTH_TRANSACTION_KEY,
    environment.AITTADB_OAUTH_CSRF_KEY,
  ].filter((value): value is string => typeof value === "string");
  if (new Set(material).size !== material.length) invalid();
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
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
  const binary = atob(padded);
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
  throw new Error("Invalid hosted AittaDB application configuration.");
}
