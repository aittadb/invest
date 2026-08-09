import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";

import type { ActorSubject } from "../domain/foundation.ts";
import {
  D1OAuthProofStore,
  OAuthProofPersistenceFailure,
  type D1OAuthProofDatabase,
  type D1OAuthProofStatement,
  type D1OAuthProofValue,
} from "../repositories/d1-oauth-proof-store.ts";
import type {
  AittaDBOAuthProofMetadata,
  OAuthTransactionClaim,
} from "../services/aittadb-oauth-proof.ts";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const OWNER_SUBJECT = "owner-subject@example.test";
const FINGERPRINT = "f".repeat(43);
const MIGRATION = readFileSync(
  new URL("../db/migrations/0001_oauth_proof_persistence.sql", import.meta.url),
  "utf8",
);

test("D1 transaction claims have one atomic winner and reject replay", async (t) => {
  const database = migratedDatabase(t);
  const store = new D1OAuthProofStore({ database, now: () => NOW });
  const claim = validClaim();

  const results = await Promise.all(
    Array.from({ length: 16 }, () => store.claim(claim)),
  );
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.filter((result) => !result).length, 15);

  const newProcessStore = new D1OAuthProofStore({
    database,
    now: () => new Date(NOW.valueOf() + 1_000),
  });
  assert.equal(await newProcessStore.claim(claim), false);

  const rows = database.sqlite.prepare(
    "SELECT * FROM investor_oauth_transaction_claims",
  ).all();
  assert.equal(rows.length, 1);
  const row = rows[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(row).sort(), [
    "claimed_at",
    "expires_at",
    "owner_subject_digest",
    "transaction_fingerprint",
  ]);
  assert.equal(row.transaction_fingerprint, FINGERPRINT);
  assert.match(String(row.owner_subject_digest), /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(row).includes(OWNER_SUBJECT), false);
});

test("expired claims are rejected without a D1 write", async (t) => {
  const database = migratedDatabase(t);
  const store = new D1OAuthProofStore({ database, now: () => NOW });

  assert.equal(
    await store.claim({ ...validClaim(), expiresAt: NOW.toISOString() }),
    false,
  );
  assert.equal(
    await store.claim({
      ...validClaim(),
      fingerprint: "e".repeat(43),
      expiresAt: new Date(NOW.valueOf() - 1).toISOString(),
    }),
    false,
  );

  const result = database.sqlite.prepare(
    "SELECT count(*) AS count FROM investor_oauth_transaction_claims",
  ).get() as { count: number };
  assert.equal(result.count, 0);
});

test("verified proofs persist only bounded closed metadata", async (t) => {
  const database = migratedDatabase(t);
  const store = new D1OAuthProofStore({ database, now: () => NOW });
  const proof = validProof();

  await store.recordVerifiedProof(proof);

  const rows = database.sqlite.prepare(
    "SELECT * FROM investor_oauth_verified_proofs",
  ).all();
  assert.equal(rows.length, 1);
  const row = rows[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(row).sort(), [
    "audience",
    "id",
    "issuer",
    "owner_subject_digest",
    "scopes_json",
    "token_expires_at",
    "verified_at",
  ]);
  assert.match(String(row.owner_subject_digest), /^[0-9a-f]{64}$/u);
  assert.notEqual(row.owner_subject_digest, OWNER_SUBJECT);
  assert.equal(row.issuer, proof.issuer);
  assert.equal(row.audience, proof.audience);
  assert.equal(row.scopes_json, '["storage.read","storage.write"]');
  assert.equal(row.verified_at, proof.verifiedAt);
  assert.equal(row.token_expires_at, proof.tokenExpiresAt);

  const schema = database.sqlite.prepare(
    "SELECT sql FROM sqlite_schema WHERE name IN (?, ?) ORDER BY name",
  ).all(
    "investor_oauth_transaction_claims",
    "investor_oauth_verified_proofs",
  );
  const serialized = JSON.stringify({ rows, schema }).toLowerCase();
  assert.equal(serialized.includes(OWNER_SUBJECT.toLowerCase()), false);
  for (const forbiddenColumn of [
    "authorization_code",
    "access_token",
    "client_secret",
    "pkce_verifier",
    "raw_state",
    "cookie_plaintext",
    "owner_subject text",
  ]) {
    assert.equal(serialized.includes(forbiddenColumn), false);
  }
});

test("malformed claims and proof metadata fail before persistence", async (t) => {
  const database = migratedDatabase(t);
  const store = new D1OAuthProofStore({ database, now: () => NOW });

  await assert.rejects(
    store.claim({ ...validClaim(), fingerprint: "raw-state" }),
    persistenceFailure,
  );
  await assert.rejects(
    store.recordVerifiedProof({
      ...validProof(),
      scopes: ["storage.read", "storage.read"],
    }),
    persistenceFailure,
  );
  await assert.rejects(
    store.recordVerifiedProof({
      ...validProof(),
      tokenExpiresAt: NOW.toISOString(),
    }),
    persistenceFailure,
  );
  await assert.rejects(
    store.recordVerifiedProof({
      ...validProof(),
      issuer: "http://database.example.test",
    }),
    persistenceFailure,
  );

  const claims = database.sqlite.prepare(
    "SELECT count(*) AS count FROM investor_oauth_transaction_claims",
  ).get() as { count: number };
  const proofs = database.sqlite.prepare(
    "SELECT count(*) AS count FROM investor_oauth_verified_proofs",
  ).get() as { count: number };
  assert.equal(claims.count, 0);
  assert.equal(proofs.count, 0);
});

test("D1 write failures surface only a generic persistence failure", async () => {
  const privateFailure = "authorization-code-that-must-not-escape";
  for (const database of [throwingDatabase(privateFailure), failedResultDatabase()]) {
    const store = new D1OAuthProofStore({ database, now: () => NOW });
    for (const operation of [
      () => store.claim(validClaim()),
      () => store.recordVerifiedProof(validProof()),
    ]) {
      await assert.rejects(operation(), (error: unknown) => {
        assert.ok(error instanceof OAuthProofPersistenceFailure);
        assert.equal(error.message, "OAuth proof persistence is unavailable.");
        assert.equal(error.message.includes(privateFailure), false);
        assert.equal("cause" in error, false);
        return true;
      });
    }
  }
});

function validClaim(): OAuthTransactionClaim {
  return {
    fingerprint: FINGERPRINT,
    ownerSubject: OWNER_SUBJECT as ActorSubject,
    expiresAt: new Date(NOW.valueOf() + 60_000).toISOString(),
  };
}

function validProof(): AittaDBOAuthProofMetadata {
  return {
    ownerSubject: OWNER_SUBJECT as ActorSubject,
    issuer: "https://database.example.test",
    audience: "confidential-client",
    scopes: ["storage.write", "storage.read"],
    verifiedAt: NOW.toISOString(),
    tokenExpiresAt: new Date(NOW.valueOf() + 3_600_000).toISOString(),
  };
}

function persistenceFailure(error: unknown): boolean {
  assert.ok(error instanceof OAuthProofPersistenceFailure);
  return true;
}

function throwingDatabase(privateFailure: string): D1OAuthProofDatabase {
  return {
    prepare() {
      throw new Error(privateFailure);
    },
  };
}

function failedResultDatabase(): D1OAuthProofDatabase {
  const statement: D1OAuthProofStatement = {
    bind() {
      return statement;
    },
    async run() {
      return { success: false, meta: { changes: 0 } };
    },
  };
  return { prepare: () => statement };
}

function migratedDatabase(t: test.TestContext): SqliteD1Database {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(MIGRATION);
  t.after(() => sqlite.close());
  return new SqliteD1Database(sqlite);
}

class SqliteD1Database implements D1OAuthProofDatabase {
  readonly sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.sqlite = sqlite;
  }

  prepare(sql: string): D1OAuthProofStatement {
    return new SqliteD1Statement(this.sqlite.prepare(sql));
  }
}

class SqliteD1Statement implements D1OAuthProofStatement {
  private values: D1OAuthProofValue[] = [];
  private readonly statement: StatementSync;

  constructor(statement: StatementSync) {
    this.statement = statement;
  }

  bind(...values: D1OAuthProofValue[]): D1OAuthProofStatement {
    this.values = values;
    return this;
  }

  async run() {
    const result = this.statement.run(...this.values);
    return {
      success: true,
      meta: { changes: Number(result.changes) },
    };
  }
}
