import {
  parseActorSubject,
  parseTimestamp,
  type ActorSubject,
} from "../domain/foundation.ts";
import type {
  AittaDBOAuthProofMetadata,
  AittaDBOAuthProofResultSink,
  OAuthTransactionClaim,
  OAuthTransactionClaimStore,
} from "../services/aittadb-oauth-proof.ts";

const TRANSACTION_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STORAGE_SCOPES = new Set([
  "storage.read",
  "storage.write",
  "storage.delete",
]);
const OWNER_DIGEST_DOMAIN = "investor-app/oauth-owner-subject/v1\0";
const MAX_ISSUER_LENGTH = 2_048;
const MAX_AUDIENCE_LENGTH = 255;

const CLAIM_TRANSACTION_SQL = `
INSERT INTO investor_oauth_transaction_claims (
  transaction_fingerprint,
  owner_subject_digest,
  expires_at,
  claimed_at
)
SELECT ?, ?, ?, ?
WHERE ? > ?
ON CONFLICT(transaction_fingerprint) DO NOTHING
`;

const RECORD_PROOF_SQL = `
INSERT INTO investor_oauth_verified_proofs (
  owner_subject_digest,
  issuer,
  audience,
  scopes_json,
  verified_at,
  token_expires_at
)
VALUES (?, ?, ?, ?, ?, ?)
`;

export type D1OAuthProofValue = string | number | null;

export type D1OAuthProofRunResult = Readonly<{
  success: boolean;
  meta: Readonly<{ changes: number }>;
}>;

export interface D1OAuthProofStatement {
  bind(...values: D1OAuthProofValue[]): D1OAuthProofStatement;
  run(): Promise<D1OAuthProofRunResult>;
}

export interface D1OAuthProofDatabase {
  prepare(sql: string): D1OAuthProofStatement;
}

export type D1OAuthProofStoreOptions = Readonly<{
  database: D1OAuthProofDatabase;
  now?: () => Date;
}>;

export class OAuthProofPersistenceFailure extends Error {
  constructor() {
    super("OAuth proof persistence is unavailable.");
    this.name = "OAuthProofPersistenceFailure";
  }
}

/**
 * D1 persistence for the short-lived OAuth proof handshake only.
 *
 * The adapter stores one-way owner digests and closed verification metadata. It
 * never receives authorization codes, tokens, client secrets, PKCE verifiers,
 * raw state, or cookie plaintext.
 */
export class D1OAuthProofStore
implements OAuthTransactionClaimStore, AittaDBOAuthProofResultSink {
  private readonly database: D1OAuthProofDatabase;
  private readonly now: () => Date;

  constructor(options: D1OAuthProofStoreOptions) {
    if (
      typeof options !== "object" ||
      options === null ||
      typeof options.database?.prepare !== "function" ||
      (options.now !== undefined && typeof options.now !== "function")
    ) {
      persistenceFailure();
    }
    this.database = options.database;
    this.now = options.now ?? (() => new Date());
  }

  async claim(transaction: OAuthTransactionClaim): Promise<boolean> {
    const claim = parseTransactionClaim(transaction);
    const claimedAt = currentTimestamp(this.now);
    if (claim.expiresAt <= claimedAt) return false;

    const ownerSubjectDigest = await digestOwnerSubject(claim.ownerSubject);
    const changes = await this.run(CLAIM_TRANSACTION_SQL, [
      claim.fingerprint,
      ownerSubjectDigest,
      claim.expiresAt,
      claimedAt,
      claim.expiresAt,
      claimedAt,
    ]);
    if (changes === 0) return false;
    if (changes === 1) return true;
    persistenceFailure();
  }

  async recordVerifiedProof(
    proof: AittaDBOAuthProofMetadata,
  ): Promise<void> {
    const metadata = parseProofMetadata(proof);
    const ownerSubjectDigest = await digestOwnerSubject(metadata.ownerSubject);
    const changes = await this.run(RECORD_PROOF_SQL, [
      ownerSubjectDigest,
      metadata.issuer,
      metadata.audience,
      JSON.stringify(metadata.scopes),
      metadata.verifiedAt,
      metadata.tokenExpiresAt,
    ]);
    if (changes !== 1) persistenceFailure();
  }

  private async run(
    sql: string,
    values: readonly D1OAuthProofValue[],
  ): Promise<number> {
    let result: D1OAuthProofRunResult;
    try {
      result = await this.database.prepare(sql).bind(...values).run();
    } catch {
      persistenceFailure();
    }
    const changes = result.meta?.changes;
    if (
      result.success !== true ||
      !Number.isSafeInteger(changes) ||
      changes < 0
    ) {
      persistenceFailure();
    }
    return changes;
  }
}

function parseTransactionClaim(
  value: OAuthTransactionClaim,
): OAuthTransactionClaim {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).length !== 3 ||
    !TRANSACTION_FINGERPRINT_PATTERN.test(value.fingerprint)
  ) {
    persistenceFailure();
  }
  const ownerSubject = parseActorSubject(value.ownerSubject);
  const expiresAt = parseTimestamp(value.expiresAt);
  if (!ownerSubject.ok || !expiresAt.ok) persistenceFailure();
  return Object.freeze({
    fingerprint: value.fingerprint,
    ownerSubject: ownerSubject.value,
    expiresAt: expiresAt.value,
  });
}

function parseProofMetadata(
  value: AittaDBOAuthProofMetadata,
): AittaDBOAuthProofMetadata {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).length !== 6
  ) {
    persistenceFailure();
  }
  const ownerSubject = parseActorSubject(value.ownerSubject);
  const issuer = exactHttpsOrigin(value.issuer);
  const audience = exactAudience(value.audience);
  const scopes = exactStorageScopes(value.scopes);
  const verifiedAt = parseTimestamp(value.verifiedAt);
  const tokenExpiresAt = parseTimestamp(value.tokenExpiresAt);
  if (
    !ownerSubject.ok ||
    !verifiedAt.ok ||
    !tokenExpiresAt.ok ||
    tokenExpiresAt.value <= verifiedAt.value
  ) {
    persistenceFailure();
  }
  return Object.freeze({
    ownerSubject: ownerSubject.value,
    issuer,
    audience,
    scopes,
    verifiedAt: verifiedAt.value,
    tokenExpiresAt: tokenExpiresAt.value,
  });
}

function exactHttpsOrigin(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_ISSUER_LENGTH
  ) {
    persistenceFailure();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    persistenceFailure();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.origin !== value
  ) {
    persistenceFailure();
  }
  return value;
}

function exactAudience(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_AUDIENCE_LENGTH ||
    !/^[\x21-\x7e]+$/.test(value) ||
    value.includes(":")
  ) {
    persistenceFailure();
  }
  return value;
}

function exactStorageScopes(value: readonly string[]): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > STORAGE_SCOPES.size ||
    new Set(value).size !== value.length ||
    value.some((scope) => !STORAGE_SCOPES.has(scope))
  ) {
    persistenceFailure();
  }
  return Object.freeze([...value].sort());
}

function currentTimestamp(now: () => Date): string {
  let value: Date;
  try {
    value = now();
  } catch {
    persistenceFailure();
  }
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    persistenceFailure();
  }
  return value.toISOString();
}

async function digestOwnerSubject(ownerSubject: ActorSubject): Promise<string> {
  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${OWNER_DIGEST_DOMAIN}${ownerSubject}`),
    );
  } catch {
    persistenceFailure();
  }
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function persistenceFailure(): never {
  throw new OAuthProofPersistenceFailure();
}
