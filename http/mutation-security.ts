import {
  parseActorSubject,
  parseTimestamp,
  type ActorSubject,
  type Timestamp,
} from "../domain/foundation.ts";

declare const mutationSecurityBrand: unique symbol;

export const MUTATION_CSRF_HEADER = "x-investor-app-csrf";
export const MUTATION_CSRF_FIELD = "_csrf";
export const MUTATION_METHOD_FIELD = "_method";
export const DEFAULT_MUTATION_BODY_BYTES = 65_536;
export const MAX_MUTATION_BODY_BYTES = 1_048_576;
export const DEFAULT_MUTATION_FIELDS = 64;
export const MAX_MUTATION_FIELDS = 768;

export type CsrfTokenHash = string & {
  readonly [mutationSecurityBrand]: "CsrfTokenHash";
};

export type MutationActor = Readonly<{
  type: "participant" | "owner";
  subject: ActorSubject;
}>;

export type TrustedMutationSession = Readonly<{
  actor: MutationActor;
  expiresAt: Timestamp;
  csrf: Readonly<{
    tokenHash: CsrfTokenHash;
    expiresAt: Timestamp;
  }>;
}>;

export type MutationMethod = "POST" | "PUT" | "PATCH" | "DELETE";
export type MutationMediaType =
  | "application/json"
  | "application/x-www-form-urlencoded";

export type VerifiedMutationRequest = Readonly<{
  actor: MutationActor;
  method: MutationMethod;
  mediaType: MutationMediaType;
  body: Readonly<Record<string, unknown>>;
}>;

export type MutationSessionResolver = (
  request: Request,
) => Promise<TrustedMutationSession | null>;

export type BrowserMutationGuardOptions = Readonly<{
  allowedOrigins: readonly string[];
  resolveSession: MutationSessionResolver;
  now?: () => Date;
  maxBodyBytes?: number;
  maxFields?: number;
  repeatedFormFields?: readonly string[];
}>;

export type BrowserMutationGuard = (
  request: Request,
) => Promise<VerifiedMutationRequest>;

export type MutationSecurityFailureCode =
  | "AUTHENTICATION_REQUIRED"
  | "REQUEST_REJECTED"
  | "INVALID_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "SERVICE_UNAVAILABLE";

const FAILURE_RESPONSES = Object.freeze({
  AUTHENTICATION_REQUIRED: Object.freeze({
    status: 401,
    message: "Sign in is required.",
  }),
  REQUEST_REJECTED: Object.freeze({
    status: 403,
    message: "The request could not be verified.",
  }),
  INVALID_REQUEST: Object.freeze({
    status: 400,
    message: "The request is invalid.",
  }),
  PAYLOAD_TOO_LARGE: Object.freeze({
    status: 413,
    message: "The request is too large.",
  }),
  UNSUPPORTED_MEDIA_TYPE: Object.freeze({
    status: 415,
    message: "The request format is not supported.",
  }),
  SERVICE_UNAVAILABLE: Object.freeze({
    status: 503,
    message: "The service is temporarily unavailable.",
  }),
} satisfies Readonly<
  Record<MutationSecurityFailureCode, Readonly<{ status: number; message: string }>>
>);

export class MutationSecurityFailure extends Error {
  readonly code: MutationSecurityFailureCode;

  constructor(code: MutationSecurityFailureCode, options: ErrorOptions = {}) {
    super(FAILURE_RESPONSES[code].message, options);
    this.name = "MutationSecurityFailure";
    this.code = code;
  }
}

export type PublicMutationSecurityFailure = Readonly<{
  status: number;
  body: Readonly<{
    error: Readonly<{
      code: MutationSecurityFailureCode;
      message: string;
    }>;
  }>;
}>;

export function toPublicMutationSecurityFailure(
  error: unknown,
): PublicMutationSecurityFailure {
  const code = error instanceof MutationSecurityFailure
    ? error.code
    : "SERVICE_UNAVAILABLE";
  const response = FAILURE_RESPONSES[code];
  return Object.freeze({
    status: response.status,
    body: Object.freeze({
      error: Object.freeze({ code, message: response.message }),
    }),
  });
}

export function createBrowserMutationGuard(
  options: BrowserMutationGuardOptions,
): BrowserMutationGuard {
  const allowedOrigins = parseAllowedOrigins(options.allowedOrigins);
  const maxBodyBytes = boundedOption(
    options.maxBodyBytes,
    DEFAULT_MUTATION_BODY_BYTES,
    MAX_MUTATION_BODY_BYTES,
  );
  const maxFields = boundedOption(
    options.maxFields,
    DEFAULT_MUTATION_FIELDS,
    MAX_MUTATION_FIELDS,
  );
  const repeatedFormFields = parseRepeatedFormFields(
    options.repeatedFormFields ?? [],
    maxFields,
  );
  const now = options.now ?? (() => new Date());

  if (typeof options.resolveSession !== "function") invalidConfiguration();

  return async (request) => {
    const requestMethod = parseRequestMethod(request.method);
    const session = await resolveTrustedSession(options.resolveSession, request);
    const currentTime = currentTimestamp(now);

    assertSessionCurrent(session, currentTime);
    assertAllowedOrigin(request.headers.get("origin"), allowedOrigins);

    const mediaType = parseMutationMediaType(
      request.headers.get("content-type"),
    );
    const bytes = await readBoundedBody(request, maxBodyBytes);
    const parsed = parseBody(
      bytes,
      mediaType,
      maxFields,
      repeatedFormFields,
    );
    const csrfToken = csrfProof(request, mediaType, parsed.fields);

    if (
      session.csrf.expiresAt <= currentTime ||
      !(await matchesCsrfToken(csrfToken, session.csrf.tokenHash))
    ) {
      rejectRequest();
    }

    const method = effectiveMutationMethod(
      requestMethod,
      mediaType,
      parsed.fields,
    );

    return Object.freeze({
      actor: session.actor,
      method,
      mediaType,
      body: Object.freeze({ ...parsed.fields }),
    });
  };
}

export async function hashCsrfToken(value: unknown): Promise<CsrfTokenHash> {
  const token = parseCsrfToken(value);
  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(token),
    );
  } catch (error) {
    throw new MutationSecurityFailure("SERVICE_UNAVAILABLE", { cause: error });
  }
  return `sha256:${bytesToHexadecimal(new Uint8Array(digest))}` as CsrfTokenHash;
}

async function resolveTrustedSession(
  resolveSession: MutationSessionResolver,
  request: Request,
): Promise<TrustedMutationSession> {
  let candidate: TrustedMutationSession | null;
  try {
    candidate = await resolveSession(request);
  } catch (error) {
    throw new MutationSecurityFailure("SERVICE_UNAVAILABLE", { cause: error });
  }

  if (candidate === null) authenticationRequired();
  const actor = parseTrustedActor(candidate.actor);
  const expiresAt = parseTimestamp(candidate.expiresAt);
  const csrfExpiresAt = parseTimestamp(candidate.csrf?.expiresAt);
  if (!expiresAt.ok || !csrfExpiresAt.ok) authenticationRequired();
  if (!isCsrfTokenHash(candidate.csrf?.tokenHash)) authenticationRequired();

  return Object.freeze({
    actor,
    expiresAt: expiresAt.value,
    csrf: Object.freeze({
      tokenHash: candidate.csrf.tokenHash,
      expiresAt: csrfExpiresAt.value,
    }),
  });
}

function parseTrustedActor(value: unknown): MutationActor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    authenticationRequired();
  }
  const source = value as Record<string, unknown>;
  if (source.type !== "participant" && source.type !== "owner") {
    authenticationRequired();
  }
  const subject = parseActorSubject(source.subject);
  if (!subject.ok) authenticationRequired();
  return Object.freeze({ type: source.type, subject: subject.value });
}

function assertSessionCurrent(
  session: TrustedMutationSession,
  currentTime: Timestamp,
): void {
  if (session.expiresAt <= currentTime) rejectRequest();
}

function currentTimestamp(now: () => Date): Timestamp {
  let value: Date;
  try {
    value = now();
  } catch (error) {
    throw new MutationSecurityFailure("SERVICE_UNAVAILABLE", { cause: error });
  }
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new MutationSecurityFailure("SERVICE_UNAVAILABLE");
  }
  const parsed = parseTimestamp(value.toISOString());
  if (!parsed.ok) throw new MutationSecurityFailure("SERVICE_UNAVAILABLE");
  return parsed.value;
}

function parseAllowedOrigins(values: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(values) || values.length < 1 || values.length > 8) {
    invalidConfiguration();
  }

  const origins = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") invalidConfiguration();
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      invalidConfiguration();
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      invalidConfiguration();
    }
    origins.add(url.origin);
  }
  return Object.freeze(origins);
}

function assertAllowedOrigin(
  value: string | null,
  allowedOrigins: ReadonlySet<string>,
): void {
  if (value === null || value === "null") rejectRequest();
  let origin: string;
  try {
    const url = new URL(value);
    if (
      value !== url.origin ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      rejectRequest();
    }
    origin = url.origin;
  } catch {
    rejectRequest();
  }
  if (!allowedOrigins.has(origin)) rejectRequest();
}

function parseRequestMethod(value: string): MutationMethod {
  const method = value.toUpperCase();
  if (
    method !== "POST" &&
    method !== "PUT" &&
    method !== "PATCH" &&
    method !== "DELETE"
  ) {
    throw new MutationSecurityFailure("INVALID_REQUEST");
  }
  return method;
}

function parseMutationMediaType(value: string | null): MutationMediaType {
  if (value === null) throw new MutationSecurityFailure("UNSUPPORTED_MEDIA_TYPE");
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  if (
    mediaType !== "application/json" &&
    mediaType !== "application/x-www-form-urlencoded"
  ) {
    throw new MutationSecurityFailure("UNSUPPORTED_MEDIA_TYPE");
  }
  return mediaType;
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
    if (length > maximum) throw new MutationSecurityFailure("PAYLOAD_TOO_LARGE");
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
        await reader.cancel();
        throw new MutationSecurityFailure("PAYLOAD_TOO_LARGE");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof MutationSecurityFailure) throw error;
    throw new MutationSecurityFailure("INVALID_REQUEST", { cause: error });
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

function parseBody(
  bytes: Uint8Array,
  mediaType: MutationMediaType,
  maxFields: number,
  repeatedFormFields: ReadonlySet<string>,
): Readonly<{ fields: Record<string, unknown> }> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new MutationSecurityFailure("INVALID_REQUEST", { cause: error });
  }

  if (mediaType === "application/json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new MutationSecurityFailure("INVALID_REQUEST", { cause: error });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new MutationSecurityFailure("INVALID_REQUEST");
    }
    const entries = Object.entries(parsed);
    assertFieldEntries(entries, maxFields);
    return { fields: entriesToNullPrototypeRecord(entries) };
  }

  const parameters = new URLSearchParams(text);
  const entries = [...parameters.entries()];
  assertFieldEntries(entries, maxFields);
  const fields = entriesToNullPrototypeRecord([]);
  for (const [name, value] of entries) {
    if (Object.hasOwn(fields, name)) {
      if (!repeatedFormFields.has(name)) {
        throw new MutationSecurityFailure("INVALID_REQUEST");
      }

      const prior = fields[name];
      fields[name] = Array.isArray(prior)
        ? [...prior, value]
        : [prior, value];
      continue;
    }
    fields[name] = value;
  }
  for (const [name, value] of Object.entries(fields)) {
    if (Array.isArray(value)) fields[name] = Object.freeze([...value]);
  }
  return { fields };
}

function parseRepeatedFormFields(
  values: readonly string[],
  maximum: number,
): ReadonlySet<string> {
  if (!Array.isArray(values) || values.length > maximum) {
    invalidConfiguration();
  }

  const parsed = new Set<string>();
  for (const value of values) {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 128 ||
      value.trim() !== value ||
      hasControlCharacter(value) ||
      value === MUTATION_CSRF_FIELD ||
      value === MUTATION_METHOD_FIELD ||
      parsed.has(value)
    ) {
      invalidConfiguration();
    }
    parsed.add(value);
  }
  return parsed;
}

function assertFieldEntries(
  entries: readonly (readonly [string, unknown])[],
  maximum: number,
): void {
  if (entries.length > maximum) {
    throw new MutationSecurityFailure("INVALID_REQUEST");
  }
  for (const [name] of entries) {
    if (
      name.length < 1 ||
      name.length > 128 ||
      name.trim() !== name ||
      hasControlCharacter(name)
    ) {
      throw new MutationSecurityFailure("INVALID_REQUEST");
    }
  }
}

function entriesToNullPrototypeRecord(
  entries: readonly (readonly [string, unknown])[],
): Record<string, unknown> {
  const record = Object.create(null) as Record<string, unknown>;
  for (const [name, value] of entries) record[name] = value;
  return record;
}

function csrfProof(
  request: Request,
  mediaType: MutationMediaType,
  fields: Record<string, unknown>,
): string {
  let value: unknown;
  if (mediaType === "application/x-www-form-urlencoded") {
    value = fields[MUTATION_CSRF_FIELD];
    delete fields[MUTATION_CSRF_FIELD];
  } else {
    value = request.headers.get(MUTATION_CSRF_HEADER);
  }
  try {
    return parseCsrfToken(value);
  } catch {
    rejectRequest();
  }
}

function effectiveMutationMethod(
  requestMethod: MutationMethod,
  mediaType: MutationMediaType,
  fields: Record<string, unknown>,
): MutationMethod {
  const override = fields[MUTATION_METHOD_FIELD];
  delete fields[MUTATION_METHOD_FIELD];
  if (override === undefined) return requestMethod;
  if (
    requestMethod !== "POST" ||
    mediaType !== "application/x-www-form-urlencoded" ||
    (override !== "PUT" && override !== "PATCH" && override !== "DELETE")
  ) {
    throw new MutationSecurityFailure("INVALID_REQUEST");
  }
  return override;
}

function parseCsrfToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    rejectRequest();
  }
  return value;
}

async function matchesCsrfToken(
  token: string,
  expectedHash: CsrfTokenHash,
): Promise<boolean> {
  let actual: string;
  try {
    actual = await hashCsrfToken(token);
  } catch {
    throw new MutationSecurityFailure("SERVICE_UNAVAILABLE");
  }
  const expectedBytes = hexadecimalToBytes(expectedHash.slice("sha256:".length));
  const actualBytes = hexadecimalToBytes(actual.slice("sha256:".length));
  let difference = expectedBytes.length ^ actualBytes.length;
  const length = Math.max(expectedBytes.length, actualBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (expectedBytes[index] ?? 0) ^ (actualBytes[index] ?? 0);
  }
  return difference === 0;
}

function isCsrfTokenHash(value: unknown): value is CsrfTokenHash {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function bytesToHexadecimal(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexadecimalToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    invalidConfiguration();
  }
  return resolved;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

function authenticationRequired(): never {
  throw new MutationSecurityFailure("AUTHENTICATION_REQUIRED");
}

function rejectRequest(): never {
  throw new MutationSecurityFailure("REQUEST_REJECTED");
}

function invalidConfiguration(): never {
  throw new Error("Invalid browser mutation guard configuration.");
}
