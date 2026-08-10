import {
  parseActorSubject,
  parseTimestamp,
  type Timestamp,
} from "../domain/foundation.ts";
import {
  DEFAULT_MUTATION_BODY_BYTES,
  DEFAULT_MUTATION_FIELDS,
  MAX_MUTATION_BODY_BYTES,
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  MutationSecurityFailure,
  createBrowserMutationGuard,
  hashCsrfToken,
  type CsrfTokenHash,
  type MutationActor,
  type TrustedMutationSession,
  type VerifiedMutationRequest,
} from "./mutation-security.ts";

const COOKIE_HEADER_UNKNOWN_MAX_LENGTH = 8_192;
const COOKIE_HEADER_ABSOLUTE_MAX_LENGTH = 524_288;
const COOKIE_HEADER_PROOF_MAX_COUNT = 256;
const COOKIE_PAIR_MAX_COUNT = 128;
const COOKIE_PAIR_MAX_LENGTH = 4_096;
const COOKIE_VALUE_MAX_LENGTH = 2_048;
const COOKIE_PLAINTEXT_MAX_BYTES = 1_024;
const MIN_SESSION_TTL_SECONDS = 60;
const MAX_SESSION_TTL_SECONDS = 600;
const CAPABILITY_ID_BYTES = 16;
const CAPABILITY_ID_CHARACTERS = 22;
const CSRF_SECRET_BYTES = 32;
const CSRF_SECRET_CHARACTERS = 43;
const CSRF_TOKEN_CHARACTERS =
  CAPABILITY_ID_CHARACTERS + CSRF_SECRET_CHARACTERS;
const AES_GCM_IV_BYTES = 12;
const COOKIE_PATH = "/";

export const DEFAULT_BROWSER_MUTATION_COOKIE_PREFIX =
  "__Host-investor_app_mutation_";

export type TrustedSitesMutationIdentity = Readonly<{
  type: "participant" | "owner";
  subject: string;
}>;

export type BrowserMutationRandomBytes = (length: number) => Uint8Array;

export type BrowserMutationReplayClaim = Readonly<{
  capabilityId: string;
  expiresAt: Timestamp;
}>;

/** Must atomically return true only for the first claim of a capability ID. */
export type BrowserMutationReplayClaimer = (
  claim: BrowserMutationReplayClaim,
) => Promise<boolean>;

export type BrowserMutationProof = Readonly<{
  token: string;
  expiresAt: Timestamp;
  setCookie: string;
}>;

export type VerifiedBrowserMutationRequest = VerifiedMutationRequest &
  Readonly<{
    clearCookie: string;
  }>;

export type BrowserMutationPreReplayValidator = (
  request: VerifiedMutationRequest,
) => boolean;

export type BrowserMutationVerificationLimits = Readonly<{
  maxBodyBytes?: number;
  maxFields?: number;
  repeatedFormFields?: readonly string[];
  validateBeforeReplayClaim?: BrowserMutationPreReplayValidator;
}>;

export type BrowserMutationSessionDependencies = Readonly<{
  appOrigin: string;
  encryptionKey: CryptoKey | null | undefined;
  claimReplay: BrowserMutationReplayClaimer | null | undefined;
  now: () => Date;
  randomBytes: BrowserMutationRandomBytes;
  ttlSeconds: number;
  cookiePrefix?: string;
  maxBodyBytes?: number;
  maxFields?: number;
  repeatedFormFields?: readonly string[];
}>;

export interface BrowserMutationSession {
  issue(
    request: Request,
    identity: TrustedSitesMutationIdentity | null,
    appOrigin: string,
  ): Promise<BrowserMutationProof>;
  verifyMutation(
    request: Request,
    identity: TrustedSitesMutationIdentity | null,
    appOrigin: string,
    limits?: BrowserMutationVerificationLimits,
  ): Promise<VerifiedBrowserMutationRequest>;
}

type ValidatedConfiguration = Readonly<{
  appOrigin: string;
  encryptionKey: CryptoKey;
  claimReplay: BrowserMutationReplayClaimer;
  now: () => Date;
  randomBytes: BrowserMutationRandomBytes;
  ttlSeconds: number;
  cookiePrefix: string;
  maxBodyBytes: number;
  maxFields: number;
  repeatedFormFields: readonly string[];
}>;

type EncryptedSession = Readonly<{
  capabilityId: string;
  actor: MutationActor;
  appOrigin: string;
  issuedAt: number;
  expiresAt: number;
  tokenHash: CsrfTokenHash;
}>;

type ParsedCapabilityToken = Readonly<{
  capabilityId: string;
}>;

type CookieLookup =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "value"; value: string }>;

export function createBrowserMutationSession(
  dependencies: BrowserMutationSessionDependencies,
): BrowserMutationSession {
  const config = validateConfiguration(dependencies);

  return Object.freeze({
    async issue(
      request: Request,
      identity: TrustedSitesMutationIdentity | null,
      appOriginValue: string,
    ) {
      const actor = requiredContext(
        config,
        request,
        identity,
        appOriginValue,
      );
      const issuedAt = currentEpochSeconds(config.now);
      const expiresAt = issuedAt + config.ttlSeconds;
      if (!Number.isSafeInteger(expiresAt)) unavailable();

      const capabilityId = randomBase64Url(
        config.randomBytes,
        CAPABILITY_ID_BYTES,
      );
      const token = capabilityId + randomBase64Url(
        config.randomBytes,
        CSRF_SECRET_BYTES,
      );
      const tokenHash = await hashCsrfToken(token);
      const encrypted = await encryptSession(config, {
        capabilityId,
        actor,
        appOrigin: config.appOrigin,
        issuedAt,
        expiresAt,
        tokenHash,
      });
      const expiresAtTimestamp = timestampFromEpochSeconds(expiresAt);
      const cookieName = sessionCookieName(config, capabilityId);

      return Object.freeze({
        token,
        expiresAt: expiresAtTimestamp,
        setCookie: sessionCookie(
          cookieName,
          encrypted,
          config.ttlSeconds,
        ),
      });
    },

    async verifyMutation(
      request: Request,
      identity: TrustedSitesMutationIdentity | null,
      appOriginValue: string,
      limits: BrowserMutationVerificationLimits = {},
    ) {
      const actor = requiredContext(
        config,
        request,
        identity,
        appOriginValue,
      );
      const verification = verificationLimits(config, limits);
      const submitted = parseCapabilityToken(
        await submittedProofToken(request, verification.maxBodyBytes),
      );
      const cookieName = sessionCookieName(config, submitted.capabilityId);
      const cookie = findSessionCookie(
        request.headers.get("cookie"),
        cookieName,
        config.cookiePrefix,
      );
      if (cookie.kind !== "value") rejectRequest();

      const encryptedSession = await decryptSession(
        config,
        cookieName,
        cookie.value,
      );
      const now = currentDate(config.now);
      const nowSeconds = Math.floor(now.valueOf() / 1_000);
      if (
        encryptedSession.capabilityId !== submitted.capabilityId ||
        encryptedSession.actor.type !== actor.type ||
        encryptedSession.actor.subject !== actor.subject ||
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
        maxBodyBytes: verification.maxBodyBytes,
        maxFields: verification.maxFields,
        ...(verification.repeatedFormFields.length === 0
          ? {}
          : { repeatedFormFields: verification.repeatedFormFields }),
      });
      const verified = await guard(request);
      if (
        verified.actor.type !== actor.type ||
        verified.actor.subject !== actor.subject
      ) {
        rejectRequest();
      }
      if (verification.validateBeforeReplayClaim !== undefined) {
        let accepted = false;
        try {
          accepted = verification.validateBeforeReplayClaim(verified) === true;
        } catch {
          throw new MutationSecurityFailure("INVALID_REQUEST");
        }
        if (!accepted) throw new MutationSecurityFailure("INVALID_REQUEST");
      }

      const capabilityId = await replayCapabilityId(
        config,
        encryptedSession.capabilityId,
      );
      let claimed: unknown;
      try {
        claimed = await config.claimReplay(Object.freeze({
          capabilityId,
          expiresAt: session.expiresAt,
        }));
      } catch {
        unavailable();
      }
      if (typeof claimed !== "boolean") unavailable();
      if (!claimed) rejectRequest();

      return Object.freeze({
        actor: verified.actor,
        method: verified.method,
        mediaType: verified.mediaType,
        body: verified.body,
        clearCookie: expiredSessionCookie(cookieName),
      });
    },
  });
}

function verificationLimits(
  config: ValidatedConfiguration,
  input: BrowserMutationVerificationLimits,
): Readonly<{
  maxBodyBytes: number;
  maxFields: number;
  repeatedFormFields: readonly string[];
  validateBeforeReplayClaim: BrowserMutationPreReplayValidator | undefined;
}> {
  const maxBodyBytes = input.maxBodyBytes ?? config.maxBodyBytes;
  const maxFields = input.maxFields ?? config.maxFields;
  const repeatedFormFields = input.repeatedFormFields ??
    config.repeatedFormFields;
  const validateBeforeReplayClaim = input.validateBeforeReplayClaim;
  if (
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 1 ||
    maxBodyBytes > config.maxBodyBytes ||
    !Number.isSafeInteger(maxFields) ||
    maxFields < 1 ||
    maxFields > config.maxFields ||
    !Array.isArray(repeatedFormFields) ||
    repeatedFormFields.some((field) =>
      !config.repeatedFormFields.includes(field)
    ) ||
    (validateBeforeReplayClaim !== undefined &&
      typeof validateBeforeReplayClaim !== "function")
  ) {
    unavailable();
  }
  const candidate = {
    allowedOrigins: [config.appOrigin],
    resolveSession: async () => null,
    maxBodyBytes,
    maxFields,
    repeatedFormFields,
  };
  try {
    createBrowserMutationGuard(candidate);
  } catch {
    unavailable();
  }
  return Object.freeze({
    maxBodyBytes,
    maxFields,
    repeatedFormFields: Object.freeze([...repeatedFormFields]),
    validateBeforeReplayClaim,
  });
}

function validateConfiguration(
  input: BrowserMutationSessionDependencies,
): ValidatedConfiguration {
  const appOrigin = exactHttpsOrigin(input.appOrigin);
  const cookiePrefix = input.cookiePrefix ??
    DEFAULT_BROWSER_MUTATION_COOKIE_PREFIX;
  const maxBodyBytes = input.maxBodyBytes ?? DEFAULT_MUTATION_BODY_BYTES;
  const maxFields = input.maxFields ?? DEFAULT_MUTATION_FIELDS;
  const repeatedFormFields = Object.freeze([...(input.repeatedFormFields ?? [])]);
  if (
    typeof CryptoKey === "undefined" ||
    !(input.encryptionKey instanceof CryptoKey) ||
    input.encryptionKey.algorithm.name !== "AES-GCM" ||
    (input.encryptionKey.algorithm as AesKeyAlgorithm).length !== 256 ||
    input.encryptionKey.extractable ||
    input.encryptionKey.usages.length !== 2 ||
    !input.encryptionKey.usages.includes("encrypt") ||
    !input.encryptionKey.usages.includes("decrypt") ||
    typeof input.claimReplay !== "function" ||
    typeof input.now !== "function" ||
    typeof input.randomBytes !== "function" ||
    !Number.isInteger(input.ttlSeconds) ||
    input.ttlSeconds < MIN_SESSION_TTL_SECONDS ||
    input.ttlSeconds > MAX_SESSION_TTL_SECONDS ||
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 1 ||
    maxBodyBytes > MAX_MUTATION_BODY_BYTES ||
    typeof cookiePrefix !== "string" ||
    cookiePrefix.length < 9 ||
    cookiePrefix.length > 72 ||
    !/^__Host-[A-Za-z0-9_]+_$/.test(cookiePrefix)
  ) {
    invalidConfiguration();
  }

  // Constructing the generic guard validates optional field configuration now,
  // rather than deferring a bad hosted setting until the first mutation.
  createBrowserMutationGuard({
    allowedOrigins: [appOrigin],
    resolveSession: async () => null,
    maxBodyBytes,
    maxFields,
    ...(repeatedFormFields.length === 0
      ? {}
      : { repeatedFormFields }),
  });

  return Object.freeze({
    appOrigin,
    encryptionKey: input.encryptionKey,
    claimReplay: input.claimReplay,
    now: input.now,
    randomBytes: input.randomBytes,
    ttlSeconds: input.ttlSeconds,
    cookiePrefix,
    maxBodyBytes,
    maxFields,
    repeatedFormFields: Object.freeze([...repeatedFormFields]),
  });
}

function requiredContext(
  config: ValidatedConfiguration,
  request: Request,
  identity: TrustedSitesMutationIdentity | null,
  appOriginValue: string,
): MutationActor {
  if (
    identity === null ||
    typeof identity !== "object" ||
    (identity.type !== "participant" && identity.type !== "owner")
  ) {
    authenticationRequired();
  }
  const subject = parseActorSubject(identity.subject);
  if (!subject.ok) authenticationRequired();
  if (appOriginValue !== config.appOrigin) rejectRequest();

  let requestOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    rejectRequest();
  }
  if (requestOrigin !== config.appOrigin) rejectRequest();

  return Object.freeze({ type: identity.type, subject: subject.value });
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
  const cookieName = sessionCookieName(config, session.capabilityId);
  const iv = checkedRandomBytes(config.randomBytes, AES_GCM_IV_BYTES);
  const plaintext = new TextEncoder().encode(JSON.stringify({
    v: 1,
    c: session.capabilityId,
    t: session.actor.type,
    s: session.actor.subject,
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
        additionalData: exactArrayBuffer(
          cookieAdditionalData(config, cookieName),
        ),
        tagLength: 128,
      },
      config.encryptionKey,
      plaintext,
    );
  } catch {
    unavailable();
  }

  const value = `${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
  if (value.length > COOKIE_VALUE_MAX_LENGTH) unavailable();
  return value;
}

async function decryptSession(
  config: ValidatedConfiguration,
  cookieName: string,
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
        additionalData: exactArrayBuffer(
          cookieAdditionalData(config, cookieName),
        ),
        tagLength: 128,
      },
      config.encryptionKey,
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
  const expected = ["v", "c", "t", "s", "o", "i", "e", "h"];
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !(key in value)) ||
    value.v !== 1 ||
    typeof value.c !== "string" ||
    !isCapabilityId(value.c) ||
    (value.t !== "participant" && value.t !== "owner") ||
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
  const subject = parseActorSubject(value.s);
  if (!subject.ok) rejectRequest();

  return Object.freeze({
    capabilityId: value.c,
    actor: Object.freeze({ type: value.t, subject: subject.value }),
    appOrigin: value.o,
    issuedAt: value.i as number,
    expiresAt: value.e as number,
    tokenHash: value.h as CsrfTokenHash,
  });
}

function trustedMutationSession(
  session: EncryptedSession,
): TrustedMutationSession {
  const expiresAt = timestampFromEpochSeconds(session.expiresAt);
  return Object.freeze({
    actor: session.actor,
    expiresAt,
    csrf: Object.freeze({ tokenHash: session.tokenHash, expiresAt }),
  });
}

async function submittedProofToken(
  request: Request,
  maxBodyBytes: number,
): Promise<unknown> {
  const mediaType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType === "application/json") {
    return request.headers.get(MUTATION_CSRF_HEADER);
  }
  if (mediaType !== "application/x-www-form-urlencoded") {
    throw new MutationSecurityFailure("UNSUPPORTED_MEDIA_TYPE");
  }

  let copy: Request;
  try {
    copy = request.clone();
  } catch {
    throw new MutationSecurityFailure("INVALID_REQUEST");
  }
  const bytes = await readBoundedBody(copy, maxBodyBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MutationSecurityFailure("INVALID_REQUEST");
  }
  const values = new URLSearchParams(text).getAll(MUTATION_CSRF_FIELD);
  if (values.length !== 1) rejectRequest();
  return values[0];
}

function parseCapabilityToken(value: unknown): ParsedCapabilityToken {
  if (
    typeof value !== "string" ||
    value.length !== CSRF_TOKEN_CHARACTERS ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    rejectRequest();
  }
  const capabilityId = value.slice(0, CAPABILITY_ID_CHARACTERS);
  if (!isCapabilityId(capabilityId)) rejectRequest();
  return Object.freeze({ capabilityId });
}

function isCapabilityId(value: string): boolean {
  if (
    value.length !== CAPABILITY_ID_CHARACTERS ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return false;
  }
  try {
    return base64Url(
      fromBase64Url(value, CAPABILITY_ID_BYTES, CAPABILITY_ID_BYTES),
    ) === value;
  } catch {
    return false;
  }
}

function findSessionCookie(
  header: string | null,
  cookieName: string,
  cookiePrefix: string,
): CookieLookup {
  if (header === null) return Object.freeze({ kind: "missing" });
  if (header.length > COOKIE_HEADER_ABSOLUTE_MAX_LENGTH) {
    return Object.freeze({ kind: "invalid" });
  }

  let pairCount = 0;
  let targetCount = 0;
  let targetValue: string | undefined;
  let proofCount = 0;
  let unknownLength = 0;
  let start = 0;

  while (start <= header.length) {
    pairCount += 1;
    const foundSeparator = header.indexOf(";", start);
    const end = foundSeparator < 0 ? header.length : foundSeparator;
    if (
      pairCount > COOKIE_PAIR_MAX_COUNT ||
      end - start > COOKIE_PAIR_MAX_LENGTH
    ) {
      return Object.freeze({ kind: "invalid" });
    }
    const raw = header.slice(start, end);
    const part = raw.trim();
    const separator = part.indexOf("=");
    const name = separator < 1 ? "" : part.slice(0, separator);
    const value = separator < 1 ? "" : part.slice(separator + 1);

    if (name === cookieName) {
      targetCount += 1;
      targetValue = value;
    }

    const capabilityId = name.startsWith(cookiePrefix)
      ? name.slice(cookiePrefix.length)
      : "";
    const isProofCookie =
      separator > 0 &&
      isCapabilityId(capabilityId) &&
      isEncryptedCookieValue(value);
    if (isProofCookie) {
      proofCount += 1;
      if (proofCount > COOKIE_HEADER_PROOF_MAX_COUNT) {
        return Object.freeze({ kind: "invalid" });
      }
    } else {
      unknownLength += raw.length + (foundSeparator < 0 ? 0 : 1);
      if (unknownLength > COOKIE_HEADER_UNKNOWN_MAX_LENGTH) {
        return Object.freeze({ kind: "invalid" });
      }
    }

    if (foundSeparator < 0) break;
    start = end + 1;
  }

  if (targetCount === 0) return Object.freeze({ kind: "missing" });
  if (targetCount !== 1 || !isEncryptedCookieValue(targetValue ?? "")) {
    return Object.freeze({ kind: "invalid" });
  }
  return Object.freeze({ kind: "value", value: targetValue as string });
}

function isEncryptedCookieValue(value: string): boolean {
  return value.length > 0 &&
    value.length <= COOKIE_VALUE_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function sessionCookieName(
  config: ValidatedConfiguration,
  capabilityId: string,
): string {
  if (!isCapabilityId(capabilityId)) rejectRequest();
  return config.cookiePrefix + capabilityId;
}

function sessionCookie(
  name: string,
  value: string,
  ttlSeconds: number,
): string {
  return `${name}=${value}; Path=${COOKIE_PATH}; Max-Age=${ttlSeconds}; Secure; HttpOnly; SameSite=Strict`;
}

function expiredSessionCookie(name: string): string {
  return `${name}=; Path=${COOKIE_PATH}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Strict`;
}

function cookieAdditionalData(
  config: ValidatedConfiguration,
  cookieName: string,
): Uint8Array {
  return new TextEncoder().encode(
    `browser-mutation:v1\n${cookieName}\n${COOKIE_PATH}\n${config.appOrigin}`,
  );
}

async function replayCapabilityId(
  config: ValidatedConfiguration,
  capabilityId: string,
): Promise<string> {
  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `browser-mutation-replay:v1\n${config.appOrigin}\n${config.cookiePrefix}\n${capabilityId}`,
      ),
    );
  } catch {
    unavailable();
  }
  return `browser-mutation:v1:${base64Url(new Uint8Array(digest))}`;
}

async function readBoundedBody(
  request: Request,
  maximum: number,
): Promise<Uint8Array> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(declaredLength)) {
      throw new MutationSecurityFailure("INVALID_REQUEST");
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length)) {
      throw new MutationSecurityFailure("INVALID_REQUEST");
    }
    if (length > maximum) {
      throw new MutationSecurityFailure("PAYLOAD_TOO_LARGE");
    }
  }

  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximum) {
        // Awaiting cancellation of one branch of a cloned stream can wait for
        // the unread original branch. Verification is already terminating.
        void reader.cancel().catch(() => undefined);
        throw new MutationSecurityFailure("PAYLOAD_TOO_LARGE");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof MutationSecurityFailure) throw error;
    throw new MutationSecurityFailure("INVALID_REQUEST");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function timestampFromEpochSeconds(value: number): Timestamp {
  let serialized: string;
  try {
    serialized = new Date(value * 1_000).toISOString();
  } catch {
    unavailable();
  }
  const parsed = parseTimestamp(serialized);
  if (!parsed.ok) unavailable();
  return parsed.value;
}

function currentDate(now: () => Date): Date {
  let value: Date;
  try {
    value = now();
  } catch {
    unavailable();
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
  randomBytes: BrowserMutationRandomBytes,
  length: number,
): Uint8Array {
  let value: Uint8Array;
  try {
    value = randomBytes(length);
  } catch {
    unavailable();
  }
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    unavailable();
  }
  return new Uint8Array(value);
}

function randomBase64Url(
  randomBytes: BrowserMutationRandomBytes,
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

function authenticationRequired(): never {
  throw new MutationSecurityFailure("AUTHENTICATION_REQUIRED");
}

function rejectRequest(): never {
  throw new MutationSecurityFailure("REQUEST_REJECTED");
}

function unavailable(): never {
  throw new MutationSecurityFailure("SERVICE_UNAVAILABLE");
}

function invalidConfiguration(): never {
  throw new Error("Invalid browser mutation session configuration.");
}
