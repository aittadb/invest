import {
  parseActorSubject,
  type ActorSubject,
} from "../domain/foundation.ts";
import {
  MAX_STORAGE_PAGE_SIZE,
  parseStorageKey,
  type StorageCursor,
  type StorageKey,
} from "../domain/storage-adapter.ts";

const CURRENT_INDICATIONS = "investment-indications";
const CURRENT_INDICATION_ID_PATTERN =
  /^indication-current:[0-9a-f]{64}$/u;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const CURSOR_TOKEN_PREFIX = "oirc.v1";
const REVIEW_ID_PREFIX = "oiri.v1";
const CURSOR_AAD_PREFIX = "owner-indication-review-cursor:v1";
const REVIEW_ID_AAD_PREFIX = "owner-indication-review-id:v1";
const REVIEW_ID_IV_PREFIX = "owner-indication-review-id-iv:v1";
const MAX_BACKEND_CURSOR_BYTES = 2_048;
const CURRENT_KEY_ID_BYTES = "indication-current:".length + 64;

export const MAX_OWNER_INDICATION_REVIEW_CURSOR_LENGTH = 3_072;
export const MAX_OWNER_INDICATION_REVIEW_ID_LENGTH = 192;

export type OwnerIndicationReviewRandomBytes = (
  length: number,
) => Uint8Array;

export type OwnerIndicationReviewTokenFailureCode =
  | "INVALID_TOKEN"
  | "UNAVAILABLE";

const TOKEN_FAILURE_MESSAGES: Readonly<
  Record<OwnerIndicationReviewTokenFailureCode, string>
> = Object.freeze({
  INVALID_TOKEN: "The owner review token is invalid.",
  UNAVAILABLE: "Owner review navigation is unavailable.",
});

/** Fixed, input-independent failure for the owner review token boundary. */
export class OwnerIndicationReviewTokenFailure extends Error {
  readonly code: OwnerIndicationReviewTokenFailureCode;

  constructor(code: OwnerIndicationReviewTokenFailureCode) {
    super(TOKEN_FAILURE_MESSAGES[code]);
    this.name = "OwnerIndicationReviewTokenFailure";
    this.code = code;
  }
}

/** Stateless authenticated navigation boundary shared by collection and detail repositories. */
export interface OwnerIndicationReviewTokenBoundary {
  sealCursor(
    backendCursor: StorageCursor,
    ownerSubject: ActorSubject,
    limit: number,
  ): Promise<StorageCursor>;
  openCursor(
    publicCursor: unknown,
    ownerSubject: ActorSubject,
    limit: number,
  ): Promise<StorageCursor>;
  reviewIdForCurrentKey(
    currentKey: StorageKey,
    ownerSubject: ActorSubject,
  ): Promise<string>;
  currentKeyForReviewId(
    reviewId: unknown,
    ownerSubject: ActorSubject,
  ): Promise<StorageKey>;
}

export type AeadOwnerIndicationReviewTokenDependencies = Readonly<{
  encryptionKey: CryptoKey;
  randomBytes: OwnerIndicationReviewRandomBytes;
}>;

/**
 * AES-GCM keeps private backend cursors and current-record keys out of URLs.
 * The key is injected deployment state; this capability stores no cursor map.
 */
export class AeadOwnerIndicationReviewTokenBoundary
  implements OwnerIndicationReviewTokenBoundary
{
  readonly #encryptionKey: CryptoKey;
  readonly #randomBytes: OwnerIndicationReviewRandomBytes;

  constructor(input: AeadOwnerIndicationReviewTokenDependencies) {
    if (
      typeof input !== "object" ||
      input === null ||
      typeof CryptoKey === "undefined" ||
      !(input.encryptionKey instanceof CryptoKey) ||
      input.encryptionKey.algorithm.name !== "AES-GCM" ||
      (input.encryptionKey.algorithm as AesKeyAlgorithm).length !== 256 ||
      input.encryptionKey.extractable ||
      input.encryptionKey.usages.length !== 2 ||
      !input.encryptionKey.usages.includes("encrypt") ||
      !input.encryptionKey.usages.includes("decrypt") ||
      typeof input.randomBytes !== "function"
    ) {
      unavailable();
    }
    this.#encryptionKey = input.encryptionKey;
    this.#randomBytes = input.randomBytes;
    Object.freeze(this);
  }

  async sealCursor(
    backendCursor: StorageCursor,
    ownerSubject: ActorSubject,
    limit: number,
  ): Promise<StorageCursor> {
    const owner = requiredOwnerSubject(ownerSubject, unavailable);
    const pageSize = requiredPageSize(limit, unavailable);
    const plaintext = requiredBackendCursorBytes(backendCursor, unavailable);
    const iv = checkedRandomBytes(
      this.#randomBytes,
      AES_GCM_IV_BYTES,
    );
    // Cursor and deterministic review-ID nonces occupy disjoint IV domains.
    iv[0] = (iv[0] ?? 0) & 0x7f;
    const ciphertext = await encrypt(
      this.#encryptionKey,
      iv,
      cursorAdditionalData(owner, pageSize),
      plaintext,
      unavailable,
    );
    const token = `${CURSOR_TOKEN_PREFIX}.${base64Url(iv)}.${
      base64Url(ciphertext)
    }`;
    if (token.length > MAX_OWNER_INDICATION_REVIEW_CURSOR_LENGTH) {
      unavailable();
    }
    return token as StorageCursor;
  }

  async openCursor(
    publicCursor: unknown,
    ownerSubject: ActorSubject,
    limit: number,
  ): Promise<StorageCursor> {
    const owner = requiredOwnerSubject(ownerSubject, invalidToken);
    const pageSize = requiredPageSize(limit, invalidToken);
    const token = requiredToken(
      publicCursor,
      CURSOR_TOKEN_PREFIX,
      MAX_OWNER_INDICATION_REVIEW_CURSOR_LENGTH,
      invalidToken,
    );
    const iv = fromBase64Url(
      token.iv,
      AES_GCM_IV_BYTES,
      AES_GCM_IV_BYTES,
      invalidToken,
    );
    if (((iv[0] ?? 0) & 0x80) !== 0) invalidToken();
    const ciphertext = fromBase64Url(
      token.ciphertext,
      AES_GCM_TAG_BYTES + 1,
      MAX_BACKEND_CURSOR_BYTES + AES_GCM_TAG_BYTES,
      invalidToken,
    );
    const plaintext = await decrypt(
      this.#encryptionKey,
      iv,
      cursorAdditionalData(owner, pageSize),
      ciphertext,
      invalidToken,
    );
    return requiredBackendCursor(plaintext, invalidToken);
  }

  async reviewIdForCurrentKey(
    currentKey: StorageKey,
    ownerSubject: ActorSubject,
  ): Promise<string> {
    const owner = requiredOwnerSubject(ownerSubject, unavailable);
    const key = requiredCurrentKey(currentKey, unavailable);
    const plaintext = new TextEncoder().encode(key.id);
    const iv = await deterministicReviewIv(key.id, owner, unavailable);
    const ciphertext = await encrypt(
      this.#encryptionKey,
      iv,
      reviewIdAdditionalData(owner),
      plaintext,
      unavailable,
    );
    const token = `${REVIEW_ID_PREFIX}.${base64Url(iv)}.${
      base64Url(ciphertext)
    }`;
    if (token.length > MAX_OWNER_INDICATION_REVIEW_ID_LENGTH) unavailable();
    return token;
  }

  async currentKeyForReviewId(
    reviewId: unknown,
    ownerSubject: ActorSubject,
  ): Promise<StorageKey> {
    const owner = requiredOwnerSubject(ownerSubject, invalidToken);
    const token = requiredToken(
      reviewId,
      REVIEW_ID_PREFIX,
      MAX_OWNER_INDICATION_REVIEW_ID_LENGTH,
      invalidToken,
    );
    const iv = fromBase64Url(
      token.iv,
      AES_GCM_IV_BYTES,
      AES_GCM_IV_BYTES,
      invalidToken,
    );
    if (((iv[0] ?? 0) & 0x80) === 0) invalidToken();
    const ciphertext = fromBase64Url(
      token.ciphertext,
      CURRENT_KEY_ID_BYTES + AES_GCM_TAG_BYTES,
      CURRENT_KEY_ID_BYTES + AES_GCM_TAG_BYTES,
      invalidToken,
    );
    const plaintext = await decrypt(
      this.#encryptionKey,
      iv,
      reviewIdAdditionalData(owner),
      ciphertext,
      invalidToken,
    );
    const id = decodeUtf8(plaintext, invalidToken);
    const key = requiredCurrentKey(
      Object.freeze({ collection: CURRENT_INDICATIONS, id }),
      invalidToken,
    );
    const expectedIv = await deterministicReviewIv(
      key.id,
      owner,
      invalidToken,
    );
    if (!equalBytes(iv, expectedIv)) invalidToken();
    return key;
  }
}

function requiredToken(
  value: unknown,
  prefix: string,
  maximumLength: number,
  fail: () => never,
): Readonly<{ iv: string; ciphertext: string }> {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength
  ) {
    return fail();
  }
  const parts = value.split(".");
  if (
    parts.length !== 4 ||
    `${parts[0]}.${parts[1]}` !== prefix ||
    parts[2]?.length === 0 ||
    parts[3]?.length === 0
  ) {
    return fail();
  }
  return Object.freeze({
    iv: parts[2] ?? "",
    ciphertext: parts[3] ?? "",
  });
}

function requiredOwnerSubject(
  value: unknown,
  fail: () => never,
): ActorSubject {
  const parsed = parseActorSubject(value);
  return parsed.ok ? parsed.value : fail();
}

function requiredPageSize(value: unknown, fail: () => never): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_STORAGE_PAGE_SIZE
  ) {
    return fail();
  }
  return value as number;
}

function requiredCurrentKey(
  value: unknown,
  fail: () => never,
): StorageKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail();
  }
  const source = value as Record<string, unknown>;
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  let collectionDescriptor: PropertyDescriptor | undefined;
  let idDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Reflect.getPrototypeOf(source);
    keys = Reflect.ownKeys(source);
    collectionDescriptor = Reflect.getOwnPropertyDescriptor(
      source,
      "collection",
    );
    idDescriptor = Reflect.getOwnPropertyDescriptor(source, "id");
  } catch {
    return fail();
  }
  if (
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return fail();
  }
  if (
    keys.length !== 2 ||
    !keys.includes("collection") ||
    !keys.includes("id") ||
    collectionDescriptor === undefined ||
    !("value" in collectionDescriptor) ||
    idDescriptor === undefined ||
    !("value" in idDescriptor) ||
    collectionDescriptor.value !== CURRENT_INDICATIONS ||
    typeof idDescriptor.value !== "string" ||
    !CURRENT_INDICATION_ID_PATTERN.test(idDescriptor.value)
  ) {
    return fail();
  }
  const parsed = parseStorageKey(
    collectionDescriptor.value,
    idDescriptor.value,
  );
  return parsed.ok ? parsed.value : fail();
}

function requiredBackendCursorBytes(
  value: unknown,
  fail: () => never,
): Uint8Array {
  if (typeof value !== "string" || value.length < 1) return fail();
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return fail();
    }
  }
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > MAX_BACKEND_CURSOR_BYTES) return fail();
  return bytes;
}

function requiredBackendCursor(
  value: Uint8Array,
  fail: () => never,
): StorageCursor {
  const decoded = decodeUtf8(value, fail);
  requiredBackendCursorBytes(decoded, fail);
  return decoded as StorageCursor;
}

async function deterministicReviewIv(
  currentKeyId: string,
  ownerSubject: ActorSubject,
  fail: () => never,
): Promise<Uint8Array> {
  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `${REVIEW_ID_IV_PREFIX}\u0000${ownerSubject}\u0000${currentKeyId}`,
      ),
    );
  } catch {
    return fail();
  }
  const iv = new Uint8Array(digest).slice(0, AES_GCM_IV_BYTES);
  // The owner/current-key tuple is unique, making its stable nonce reusable
  // only for the exact same AES-GCM plaintext and additional data.
  iv[0] = (iv[0] ?? 0) | 0x80;
  return iv;
}

function cursorAdditionalData(
  ownerSubject: ActorSubject,
  limit: number,
): Uint8Array {
  return new TextEncoder().encode(
    `${CURSOR_AAD_PREFIX}\u0000${ownerSubject}\u0000${limit}`,
  );
}

function reviewIdAdditionalData(ownerSubject: ActorSubject): Uint8Array {
  return new TextEncoder().encode(
    `${REVIEW_ID_AAD_PREFIX}\u0000${ownerSubject}\u0000${CURRENT_INDICATIONS}`,
  );
}

async function encrypt(
  key: CryptoKey,
  iv: Uint8Array,
  additionalData: Uint8Array,
  plaintext: Uint8Array,
  fail: () => never,
): Promise<Uint8Array> {
  try {
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: exactArrayBuffer(iv),
        additionalData: exactArrayBuffer(additionalData),
        tagLength: 128,
      },
      key,
      exactArrayBuffer(plaintext),
    );
    return new Uint8Array(ciphertext);
  } catch {
    return fail();
  }
}

async function decrypt(
  key: CryptoKey,
  iv: Uint8Array,
  additionalData: Uint8Array,
  ciphertext: Uint8Array,
  fail: () => never,
): Promise<Uint8Array> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: exactArrayBuffer(iv),
        additionalData: exactArrayBuffer(additionalData),
        tagLength: 128,
      },
      key,
      exactArrayBuffer(ciphertext),
    );
    return new Uint8Array(plaintext);
  } catch {
    return fail();
  }
}

function checkedRandomBytes(
  randomBytes: OwnerIndicationReviewRandomBytes,
  length: number,
): Uint8Array {
  let value: Uint8Array;
  try {
    value = randomBytes(length);
  } catch {
    return unavailable();
  }
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    unavailable();
  }
  return new Uint8Array(value);
}

function decodeUtf8(value: Uint8Array, fail: () => never): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return fail();
  }
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
  fail: () => never,
): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return fail();
  let binary: string;
  try {
    const standard = value.replaceAll("-", "+").replaceAll("_", "/");
    binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
  } catch {
    return fail();
  }
  if (binary.length < minimumBytes || binary.length > maximumBytes) {
    return fail();
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64Url(bytes) !== value) return fail();
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function invalidToken(): never {
  throw new OwnerIndicationReviewTokenFailure("INVALID_TOKEN");
}

function unavailable(): never {
  throw new OwnerIndicationReviewTokenFailure("UNAVAILABLE");
}
