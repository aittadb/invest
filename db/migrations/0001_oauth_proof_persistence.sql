CREATE TABLE IF NOT EXISTS investor_oauth_transaction_claims (
  transaction_fingerprint TEXT PRIMARY KEY NOT NULL
    CHECK (
      length(transaction_fingerprint) = 43
      AND transaction_fingerprint NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  owner_subject_digest TEXT NOT NULL
    CHECK (
      length(owner_subject_digest) = 64
      AND owner_subject_digest NOT GLOB '*[^0-9a-f]*'
    ),
  expires_at TEXT NOT NULL CHECK (length(expires_at) = 24),
  claimed_at TEXT NOT NULL CHECK (length(claimed_at) = 24),
  CHECK (expires_at > claimed_at)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS investor_oauth_verified_proofs (
  id INTEGER PRIMARY KEY,
  owner_subject_digest TEXT NOT NULL
    CHECK (
      length(owner_subject_digest) = 64
      AND owner_subject_digest NOT GLOB '*[^0-9a-f]*'
    ),
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
  audience TEXT NOT NULL CHECK (length(audience) BETWEEN 1 AND 255),
  scopes_json TEXT NOT NULL CHECK (length(scopes_json) BETWEEN 1 AND 128),
  verified_at TEXT NOT NULL CHECK (length(verified_at) = 24),
  token_expires_at TEXT NOT NULL CHECK (length(token_expires_at) = 24),
  CHECK (token_expires_at > verified_at)
);
