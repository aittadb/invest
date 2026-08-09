import {
  parseActorSubject,
  parseTimestamp,
  type ActorSubject,
} from "../domain/foundation.ts";
import { OWNER_OAUTH_PROOF_PATH } from "../domain/owner-oauth-proof-resource.ts";
import {
  createBrowserMutationGuard,
  hashCsrfToken,
  MutationSecurityFailure,
  type CsrfTokenHash,
  type TrustedMutationSession,
  type VerifiedMutationRequest,
} from "./mutation-security.ts";

const COOKIE_HEADER_MAX_LENGTH = 8_192;
const COOKIE_VALUE_MAX_LENGTH = 2_048;
const COOKIE_PLAINTEXT_MAX_BYTES = 1_024;
const MIN_SESSION_TTL_SECONDS = 60;
const MAX_SESSION_TTL_SECONDS = 600;
const CSRF_TOKEN_BYTES = 32;
const AES_GCM_IV_BYTES = 12;

export const DEFAULT_OWNER_OAUTH_CSRF_COOKIE =
  "investor_app_owner_oauth_csrf";

export type OwnerOAuthCsrfRandomBytes = (length: number) => Uint8Array;

export type OwnerOAuthCsrfProof = Readonly<{
  token: string;
  setCookie: string;
}>;

export type OwnerOAuthCsrfSessionDependencies = Readonly<{
  appOrigin: string;
  cookieKey: CryptoKey | null | undefined;
  now: () => Date;
  randomBytes: OwnerOAuthCsrfRandomBytes;
  ttlSeconds: number;
  cookieName?: string;
}>;

export interface OwnerOAuthCsrfSession {
  issue(
    request: Request,
    ownerSubject: string,
    appOrigin: string,
  ): Promise<OwnerOAuthCsrfProof>;
  verifyMutation(
    request: Request,
    ownerSubject: string,
    appOrigin: string,
  ): Promise<VerifiedMutationRequest>;
}

type ValidatedConfiguration = Readonly<{
  appOrigin: string;
  cookieKey: CryptoKey;
  now: () => Date;
  randomBytes: OwnerOAuthCsrfRandomBytes;
  ttlSeconds: number;
  cookieName: string;
}>;

type EncryptedSession = Readonly<{
  ownerSubject: ActorSubject;
  appOrigin: string;
  issuedAt: number;
  expiresAt: number;
  tokenHash: CsrfTokenHash;
}>;

type CookieLookup =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "value"; value: string }>;

export function createOwnerOAuthCsrfSession(
  dependencies: OwnerOAuthCsrfSessionDependencies,
): OwnerOAuthCsrfSession {
  const config = validateConfiguration(dependencies);

  return Object.freeze({
    async issue(
      request: Request,
      ownerSubjectValue: string,
      appOriginValue: string,
    ) {
      const ownerSubject = requiredContext(
        config,
        request,
        ownerSubjectValue,
        appOriginValue,
      );
      const issuedAt = currentEpochSeconds(config.now);
      const expiresAt = issuedAt + config.ttlSeconds;
      const token = randomBase64Url(config.randomBytes, CSRF_TOKEN_BYTES);
      const tokenHash = await hashCsrfToken(token);
      const encrypted = await encryptSession(config, {
        ownerSubject,
        appOrigin: config.appOrigin,
        issuedAt,
        expiresAt,
        tokenHash,
      });

      return Object.freeze({
        token,
        setCookie: sessionCookie(
          config.cookieName,
          encrypted,
          config.ttlSeconds,
        ),
      });
    },
    async verifyMutation(
      request: Request,
      ownerSubjectValue: string,
      appOriginValue: string,
    ) {
      const ownerSubject = requiredContext(
        config,
        request,
        ownerSubjectValue,
        appOriginValue,
      );
      const cookie = findSessionCookie(
        request.headers.get("cookie"),
        config.cookieName,
      );
      if (cookie.kind === "missing") {
        throw new MutationSecurityFailure("AUTHENTICATION_REQUIRED");
      }
      if (cookie.kind === "invalid") rejectRequest();

      const encryptedSession = await decryptSession(config, cookie.value);
      const now = currentDate(config.now);
      const nowSeconds = Math.floor(now.valueOf() / 1_000);
      if (
        encryptedSession.ownerSubject !== ownerSubject ||
        encryptedSession.appOrigin !== config.appOrigin ||
        encryptedSession.expiresAt !==
          encryptedSession.issuedAt + config.ttlSeconds ||
        encryptedSession.issuedAt > nowSeconds
      ) {
        rejectRequest();
      }
      const session = trustedMutationSession(encryptedSession);
      const guard = createBrowserMutationGuard({
        allowedOrigins: [config.appOrigin],
        resolveSession: async () => session,
        now: () => now,
      });
      const verified = await guard(request);
      if (
        verified.actor.type !== "owner" ||
        verified.actor.subject !== ownerSubject
      ) {
        rejectRequest();
      }
      return verified;
    },
  });
}

function validateConfiguration(
  input: OwnerOAuthCsrfSessionDependencies,
): ValidatedConfiguration {
  const appOrigin = exactHttpsOrigin(input.appOrigin);
  const cookieName = input.cookieName ?? DEFAULT_OWNER_OAUTH_CSRF_COOKIE;
  if (
    typeof CryptoKey === "undefined" ||
    !(input.cookieKey instanceof CryptoKey) ||
    input.cookieKey.algorithm.name !== "AES-GCM" ||
    (input.cookieKey.algorithm as AesKeyAlgorithm).length !== 256 ||
    input.cookieKey.extractable ||
    input.cookieKey.usages.length !== 2 ||
    !input.cookieKey.usages.includes("encrypt") ||
    !input.cookieKey.usages.includes("decrypt") ||
    typeof input.now !== "function" ||
    typeof input.randomBytes !== "function" ||
    !Number.isInteger(input.ttlSeconds) ||
    input.ttlSeconds < MIN_SESSION_TTL_SECONDS ||
    input.ttlSeconds > MAX_SESSION_TTL_SECONDS ||
    !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(cookieName)
  ) {
    invalidConfiguration();
  }

  return Object.freeze({
    appOrigin,
    cookieKey: input.cookieKey,
    now: input.now,
    randomBytes: input.randomBytes,
    ttlSeconds: input.ttlSeconds,
    cookieName,
  });
}

function requiredContext(
  config: ValidatedConfiguration,
  request: Request,
  ownerSubjectValue: string,
  appOriginValue: string,
): ActorSubject {
  const ownerSubject = parseActorSubject(ownerSubjectValue);
  if (!ownerSubject.ok || appOriginValue !== config.appOrigin) rejectRequest();
  let requestOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    rejectRequest();
  }
  if (requestOrigin !== config.appOrigin) rejectRequest();
  return ownerSubject.value;
}

function exactHttpsOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
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
    value !== url.origin ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    invalidConfiguration();
  }
  return url.origin;
}

async function encryptSession(
  config: ValidatedConfiguration,
  session: EncryptedSession,
): Promise<string> {
  const iv = checkedRandomBytes(config.randomBytes, AES_GCM_IV_BYTES);
  const plaintext = new TextEncoder().encode(JSON.stringify({
    v: 1,
    s: session.ownerSubject,
    o: session.appOrigin,
    i: session.issuedAt,
    e: session.expiresAt,
    h: session.tokenHash,
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
      config.cookieKey,
      plaintext,
    );
  } catch (error) {
    throw new MutationSecurityFailure("SERVICE_UNAVAILABLE", { cause: error });
  }
  const value = `${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
  if (value.length > COOKIE_VALUE_MAX_LENGTH) unavailable();
  return value;
}

async function decryptSession(
  config: ValidatedConfiguration,
  value: string,
): Promise<EncryptedSession> {
  const parts = value.split(".");
  if (parts.length !== 2) rejectRequest();
  const iv = fromBase64Url(parts[0] ?? "", AES_GCM_IV_BYTES, AES_GCM_IV_BYTES);
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
      config.cookieKey,
      exactArrayBuffer(ciphertext),
    );
  } catch {
    rejectRequest();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    );
  } catch {
    rejectRequest();
  }
  return parseEncryptedSession(parsed);
}

function parseEncryptedSession(value: unknown): EncryptedSession {
  if (!isRecord(value)) rejectRequest();
  const expected = ["v", "s", "o", "i", "e", "h"];
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !(key in value)) ||
    value.v !== 1 ||
    typeof value.o !== "string" ||
    !Number.isSafeInteger(value.i) ||
    !Number.isSafeInteger(value.e) ||
    (value.i as number) < 0 ||
    (value.e as number) < 0 ||
    typeof value.h !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value.h)
  ) {
    rejectRequest();
  }
  const ownerSubject = parseActorSubject(value.s);
  if (!ownerSubject.ok) rejectRequest();
  return Object.freeze({
    ownerSubject: ownerSubject.value,
    appOrigin: value.o,
    issuedAt: value.i as number,
    expiresAt: value.e as number,
    tokenHash: value.h as CsrfTokenHash,
  });
}

function trustedMutationSession(
  session: EncryptedSession,
): TrustedMutationSession {
  let expiresAtValue: string;
  try {
    expiresAtValue = new Date(session.expiresAt * 1_000).toISOString();
  } catch {
    rejectRequest();
  }
  const expiresAt = parseTimestamp(expiresAtValue);
  if (!expiresAt.ok) rejectRequest();
  return Object.freeze({
    actor: Object.freeze({ type: "owner", subject: session.ownerSubject }),
    expiresAt: expiresAt.value,
    csrf: Object.freeze({
      tokenHash: session.tokenHash,
      expiresAt: expiresAt.value,
    }),
  });
}

function findSessionCookie(
  header: string | null,
  cookieName: string,
): CookieLookup {
  if (header === null) return Object.freeze({ kind: "missing" });
  if (header.length > COOKIE_HEADER_MAX_LENGTH) {
    return Object.freeze({ kind: "invalid" });
  }
  const values: string[] = [];
  for (const raw of header.split(";")) {
    const part = raw.trim();
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator) !== cookieName) continue;
    values.push(part.slice(separator + 1));
  }
  if (values.length === 0) return Object.freeze({ kind: "missing" });
  const value = values[0];
  if (
    values.length !== 1 ||
    !value ||
    value.length > COOKIE_VALUE_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  ) {
    return Object.freeze({ kind: "invalid" });
  }
  return Object.freeze({ kind: "value", value });
}

function sessionCookie(
  name: string,
  value: string,
  ttlSeconds: number,
): string {
  return `${name}=${value}; Path=${OWNER_OAUTH_PROOF_PATH}; Max-Age=${ttlSeconds}; Secure; HttpOnly; SameSite=Lax`;
}

function cookieAdditionalData(config: ValidatedConfiguration): Uint8Array {
  return new TextEncoder().encode(
    `owner-oauth-csrf:v1\n${config.cookieName}\n${OWNER_OAUTH_PROOF_PATH}\n${config.appOrigin}`,
  );
}

function currentDate(now: () => Date): Date {
  let value: Date;
  try {
    value = now();
  } catch (error) {
    throw new MutationSecurityFailure("SERVICE_UNAVAILABLE", { cause: error });
  }
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) unavailable();
  return new Date(value.valueOf());
}

function currentEpochSeconds(now: () => Date): number {
  const seconds = Math.floor(currentDate(now).valueOf() / 1_000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) unavailable();
  return seconds;
}

function checkedRandomBytes(
  randomBytes: OwnerOAuthCsrfRandomBytes,
  length: number,
): Uint8Array {
  let value: Uint8Array;
  try {
    value = randomBytes(length);
  } catch (error) {
    throw new MutationSecurityFailure("SERVICE_UNAVAILABLE", { cause: error });
  }
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    unavailable();
  }
  return new Uint8Array(value);
}

function randomBase64Url(
  randomBytes: OwnerOAuthCsrfRandomBytes,
  length: number,
): string {
  return base64Url(checkedRandomBytes(randomBytes, length));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64Url(
  value: string,
  minimumBytes: number,
  maximumBytes: number,
): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) rejectRequest();
  let binary: string;
  try {
    const standard = value.replaceAll("-", "+").replaceAll("_", "/");
    binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
  } catch {
    rejectRequest();
  }
  if (binary.length < minimumBytes || binary.length > maximumBytes) {
    rejectRequest();
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64Url(bytes) !== value) rejectRequest();
  return bytes;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectRequest(): never {
  throw new MutationSecurityFailure("REQUEST_REJECTED");
}

function unavailable(): never {
  throw new MutationSecurityFailure("SERVICE_UNAVAILABLE");
}

function invalidConfiguration(): never {
  throw new Error("Invalid owner OAuth CSRF session configuration.");
}
