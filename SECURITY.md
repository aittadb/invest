# Security Policy

Investor App is experimental, security-sensitive software for private campaign content and participant interest records. Report vulnerabilities privately to the maintainer. Do not file public issues containing exploits, private keys, client secrets, refresh tokens, access tokens, authorization codes, cookies, campaign private content, exports, or PII.

## Public Repository Secret Safety

The public repository must contain no secrets or private campaign data. Never commit runtime `.env` files, hosted secret values, active deployment credentials, identity-provider secrets, storage credentials, generated session secrets, private package content, participant records, exports, or production backups.

Checked-in example configuration contains only inert placeholders. Keep real values in ignored local files or hosted secret/configuration stores.

If exposure is suspected, do not echo or paste the value. Escalate privately with only its category, path, and commit. Rotation, revocation, or history rewrite requires explicit maintainer approval.

## Application Security Boundary

- Production storage uses the configured AittaDB-compatible adapter only.
- Owner setup must prevent first-user takeover and bind authorization to a stable backend identity.
- Every server route must enforce authorization independently.
- Browser mutation identity comes only from the trusted session resolver, never request-supplied actor fields or untrusted headers.
- Participant reads pass only a parsed trusted account to the credential-bound state reader. The Worker deletes or replaces its bounded internal participant render header, and foreign, missing, malformed, or unavailable state grants no private capability.
- Browser mutations require an exact configured origin, an unexpired session, an expiring server-verified CSRF proof, and a bounded supported body before feature code runs.
- Store only CSRF token hashes in session state. Never log or return raw CSRF tokens, session values, submitted private fields, or guard failure causes.
- Public aggregate output must never disclose participant counts, identities, notes, private fields, or database structure unless explicitly configured and reviewed by the specification.
- Private package, profile, indication, founder, owner, and export responses should use non-cacheable headers.
- Owner exports must be initiated by an owner-bound, same-origin, CSRF-protected, idempotent POST. Direct export GET requests remain side-effect-free.
- Export paging, top-level records, per-record bytes, nested history, total encoded bytes, transient memory, and UTF-8 string projection work must be bounded before an attachment is returned. Spreadsheet-formula prefixes must be neutralized in every CSV cell.
- Export bytes may be exposed only after immutable allowlisted audit evidence is committed and verified; audit records must never contain export contents or content fingerprints. The event records generation, not proof that the client received every byte.
- A previously audited export operation is single-use and returns a fixed private conflict before source reads or another audit append. A new export requires a fresh server-issued operation ID.
- No visitor analytics or non-essential cookies in version one.
- The optional AittaDB OAuth proof keeps issuer/client/scope configuration server-side and client secret plus AES-GCM cookie material in hosted secret storage. Its short-lived host-only transaction cookie is encrypted and authenticated; replay is rejected through an injected durable atomic claim store, never process memory or browser storage.
- OAuth callback responses must not reflect query parameters. Access tokens, refresh tokens, authorization codes, PKCE verifiers, OAuth state, client secrets, cookie plaintext, AittaDB token subjects/IDs, and credential-bearing causes must not enter responses, logs, persistence, or proof metadata. The standards-required outbound authorization redirect is the only transport for state and the PKCE challenge.

## Publication Blockers

Production publication is blocked until the configured backend supports the required authorization, consistency, listing, pagination, quota, and non-disclosure behavior and the production adapter passes contract and end-to-end tests.

TASK-030 additionally remains open until an authorized acceptance deployment advertises the required OAuth endpoints, a least-privilege confidential client is installed through hosted configuration, and the complete owner callback proof succeeds without credential disclosure. The source-only injected callback infrastructure is not live evidence.
