# Security Policy

Investor App is experimental, security-sensitive software for private campaign content and participant interest records. Report vulnerabilities privately to the maintainer. Do not file public issues containing exploits, private keys, client secrets, refresh tokens, access tokens, authorization codes, cookies, campaign private content, exports, or PII.

## Public Repository Secret Safety

The public repository must contain no secrets or private campaign data. Never commit runtime `.env` files, hosted secret values, active deployment credentials, identity-provider secrets, storage credentials, generated session secrets, private package content, participant records, exports, or production backups.

Checked-in example configuration contains only inert placeholders. Keep real values in ignored local files or hosted secret/configuration stores.

If exposure is suspected, do not echo or paste the value. Escalate privately with only its category, path, and commit. Rotation, revocation, or history rewrite requires explicit maintainer approval.

## Application Security Boundary

- Production storage uses the configured AittaDB-compatible adapter only.
- The production storage adapter receives bearer authority only through a backend closure, follows only validated same-issuer hypermedia controls and page identities, rejects redirects and unknown mutations, snapshots data-only requests before serialization, bounds token/fetch waits plus streamed bytes, chunks, and time, cancels rejected bodies, enforces advertised record and transaction sizes, and never retains credentials, response bodies, or transport exceptions in failures.
- The hosted application runtime is all-or-nothing. Its dedicated non-interactive service client has no browser origin or redirect URI and must be namespace-bound by AittaDB. The parser retains client credentials only inside a provider-construction closure; proof material is pairwise distinct, routes receive only named narrow repositories and the mutation session, the runtime never enters route context, and Vinext receives only asset and image bindings. Missing, partial, malformed, cross-issuer, noncanonical-scope, or reused proof material exposes no private route.
- Browser-mutation replay authority uses an AittaDB atomic create with an expiry-only one-way identifier. It stores no actor, origin, cookie, token, request body, or campaign data and never falls back to D1, browser storage, read-then-write, or process memory. Hosted retention and quota behavior must be proven before activation.
- Owner setup must prevent first-user takeover and bind authorization to a stable backend identity.
- Every server route must enforce authorization independently.
- Browser mutation identity comes only from the trusted session resolver, never request-supplied actor fields or untrusted headers.
- Participant reads pass only a parsed trusted account to an explicitly composed credential-bound state reader. Environment bindings are never participant authority. The Worker deletes or replaces its bounded internal participant render header, and foreign, missing, malformed, or unavailable state grants no private capability.
- Browser mutations require an exact configured origin, an unexpired session, an expiring server-verified CSRF proof, and a bounded supported body before feature code runs.
- A shared browser-mutation session is only an absolute ceiling. Every composed route supplies its own body and field limits, which are validated and applied during proof extraction as well as body parsing.
- Once browser mutation verification consumes replay authority, setup and editor routes clear that exact cookie on every later success or fixed error response. A repeated replay neither accumulates cookies nor receives a replacement proof.
- Campaign publication is closed unless intrinsic campaign checks pass and the hosted runtime contains exact `DEPLOYMENT_PUBLICATION_READY=true`. Missing or `false` blocks publication; malformed text disables the runtime and suppresses scalar campaign fallback.
- Before private campaign chunks are staged, an immutable bounded operation intent binds the business operation to the normalized setup reference, revision pair, timestamp, mode, and audited actor/transition. Changed retries conflict before further mutation, while exact retries can resume after restart or an unknown final outcome. Only a final atomic metadata/public-projection/audit transaction makes a revision visible; interrupted staging can leave the intent and unreachable chunks but no current campaign or public state. Intent, chunk, and final transaction results must be closed and exactly match every requested record in order.
- Store only CSRF token hashes in session state. Never log or return raw CSRF tokens, session values, submitted private fields, or guard failure causes.
- Public aggregate output must never disclose participant counts, identities, notes, private fields, or database structure unless explicitly configured and reviewed by the specification.
- Private package, profile, indication, founder, owner, and export responses should use non-cacheable headers.
- Owner exports must be initiated by an owner-bound, same-origin, CSRF-protected, idempotent POST. Direct export GET requests remain side-effect-free.
- Export paging, top-level records, per-record bytes, nested history, total encoded bytes, transient memory, and UTF-8 string projection work must be bounded before an attachment is returned. Spreadsheet-formula prefixes must be neutralized in every CSV cell.
- Export bytes may be exposed only after immutable allowlisted audit evidence is committed and verified; audit records must never contain export contents or content fingerprints. The event records generation, not proof that the client received every byte.
- A previously audited export operation is single-use and returns a fixed private conflict before source reads or another audit append. A new export requires a fresh server-issued operation ID.
- No visitor analytics or non-essential cookies in version one.
- The optional AittaDB OAuth proof keeps issuer/client/scope configuration server-side and client secret plus separate AES-GCM cookie material in hosted secret storage. Its short-lived host-only cookies are encrypted and authenticated; replay is rejected through a dedicated D1 atomic claim store, never process memory or browser storage. Proof persistence contains no owner-derived value and cannot be used as campaign or participant storage.
- Only an available owner connection page may add the exact configured HTTPS OAuth authorization origin to `form-action` beside `'self'`. JSON, redirects, callbacks, unavailable pages, and errors retain a self-only form target; no wildcard, path, compound source, or unrelated origin is accepted.
- OAuth callback responses must not reflect query parameters. Access tokens, refresh tokens, authorization codes, PKCE verifiers, OAuth state, client secrets, cookie plaintext, AittaDB token subjects/IDs, and credential-bearing causes must not enter responses, logs, persistence, or proof metadata. The standards-required outbound authorization redirect is the only transport for state and the PKCE challenge.

## Publication Blockers

Production publication is blocked until the configured backend supports the required authorization, consistency, listing, pagination, atomic transaction, replay retention, quota, and non-disclosure behavior and the production adapter passes contract, hosted credential-boundary, and end-to-end tests. Source-level runtime composition and deterministic protocol tests are not hosted acceptance evidence; keep deployment readiness false until objective live proof is recorded.

TASK-030 additionally remains open until an authorized acceptance deployment advertises the required OAuth endpoints, a least-privilege confidential client is installed through hosted configuration, and the complete owner callback proof succeeds without credential disclosure. The source-only injected callback infrastructure is not live evidence.
