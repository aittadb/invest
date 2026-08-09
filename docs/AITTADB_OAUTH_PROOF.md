# AittaDB OAuth Development Proof

## Scope

This repository contains opt-in hosted composition for a confidential AittaDB Authorization Code flow with PKCE. It does not register an OAuth client, install a real client secret, enable OAuth Apps on an AittaDB deployment, change a Sites access policy, or by itself prove a hosted callback.

`worker/index.ts` installs only a fail-closed resolver. `/owner/aittadb-connection` exists when one deployment supplies every exact configuration and secret value plus the dedicated D1 binding; absent, partial, malformed, or unbound deployments keep the route and owner navigation absent. TASK-030 remains open until the live proof in this document succeeds.

## Application Resources

- `GET /owner/aittadb-connection` returns an owner-only HTML workspace or version `0.1` hypermedia resource. It probes discovery and advertises `verify-aittadb-connection` only when the configured issuer exposes the required protocol and an owner OAuth CSRF session is injected. Both representations receive a fresh CSRF token header and the same encrypted, path-scoped session cookie; HTML also places that token in its form.
- `POST /owner/aittadb-connection` is the only initiation operation. It requires the configured owner, exact deployment origin, trusted owner session, and CSRF proof. It discovers the issuer again before redirecting.
- `GET /owner/aittadb-connection/callback` is the standards-required Authorization Code redirect handler at the exact callback path. It consumes one-time protocol artifacts and records closed proof, accepts no application mutation method, clears the transaction cookie on every response where the route can do so, and returns only a generic success or failure resource. The ordinary connection-resource GET never initiates or mutates the flow.

HTML forms and hypermedia actions come from `domain/owner-oauth-proof-resource.ts`. The route still enforces every identity and request precondition independently.

## Injected Boundary

The deployment composition requires all of the following. Reusable source supplies no instance value:

- exact HTTPS issuer;
- confidential client ID and hosted-only client secret;
- exact HTTPS callback URI;
- allowed storage scopes and the requested least-privilege subset;
- a non-extractable AES-GCM transaction-cookie key;
- a separate non-extractable AES-GCM owner-CSRF-cookie key and the session capability created from it;
- a durable atomic transaction-claim store for replay rejection;
- a result sink that accepts only closed proof metadata;
- `fetch`, clock, cryptographic randomness, and the short transaction lifetime;
- the exact canonical application origin used by the owner CSRF session.

`APP_BASE_URL`, `AITTADB_OAUTH_ISSUER`, `AITTADB_OAUTH_CLIENT_ID`, `AITTADB_OAUTH_CALLBACK_URI`, and `AITTADB_OAUTH_STORAGE_SCOPES` are ordinary per-instance runtime values. `AITTADB_OAUTH_CLIENT_SECRET`, `AITTADB_OAUTH_TRANSACTION_KEY`, and `AITTADB_OAUTH_CSRF_KEY` are hosted secrets. The ignored active Sites binding names the dedicated D1 capability as `OAUTH_PROOF_DB`; the inert tracked hosting example remains null. Every OAuth value must be configured together.

The client requests only configured `storage.read`, `storage.write`, or `storage.delete` scopes. It never requests `offline_access`, `openid`, profile, or email. A concrete later requirement must justify any scope expansion.

The result sink receives the owner subject only as service-owned authorization context, validates it, and persists no owner-derived value. Stored proof rows contain only issuer, client audience, exact validated storage scopes, verification time, and access-token expiry. The sink never receives an access token, refresh token, authorization code, PKCE verifier, OAuth state, client secret, cookie plaintext, AittaDB token subject, token ID, or credential-bearing exception cause.

## Protocol Checks

Before initiation and again at callback, discovery must advertise the exact configured issuer and AittaDB `/authorize`, `/oauth/token`, and `/oauth/introspect` endpoints. It must include the `code` response type, `authorization_code` grant, S256 PKCE, `client_secret_basic`, and every requested storage scope.

The transaction uses independent 256-bit state and verifier values. Its host-only `Secure`, `HttpOnly`, `SameSite=Lax` cookie is AES-GCM encrypted, expires within ten minutes, and is bound to the cookie name and exact callback URI. Encrypted contents bind the owner subject and complete protocol configuration. A durable store atomically claims a one-way transaction fingerprint before credential exchange, so replay does not depend on process memory or browser storage.

OAuth initiation uses a separate short-lived CSRF session from `http/owner-oauth-csrf-session.ts`. Its AES-GCM ciphertext binds the trusted owner subject, exact HTTPS application origin, issuance and expiry, and only a SHA-256 hash of the random browser proof. The host-only cookie omits `Domain`, uses `Secure`, `HttpOnly`, `SameSite=Lax`, and is scoped to `/owner/aittadb-connection`. The form body and JSON request header are checked against that encrypted session before OAuth discovery or redirect. A missing capability, missing or unsuitable key, altered cookie, expiry, owner mismatch, request-host mismatch, or browser-origin mismatch cannot initiate OAuth.

Token and introspection requests use HTTP Basic client authentication and bounded form bodies. JSON responses are content-type checked, byte bounded, field allowlisted, and strictly parsed. The token must contain exactly the requested scopes and no refresh or ID token. Introspection must report an active access token with the exact issuer and client audience, an unexpired bounded lifetime, bounded integer `iat` and `nbf`, canonical UUIDv4 AittaDB subject and token ID, and exactly the requested storage scopes.

Callback representations never reflect their query string. Private responses use `no-store`, a no-referrer policy, MIME sniffing and framing defenses, and a restrictive content security policy. The authorization redirect necessarily transports OAuth state and the PKCE challenge to the configured authorization endpoint; they are not included in application documents, result metadata, logs, or persistence.

The available owner connection HTML permits form navigation only to self and the exact HTTPS authorization origin derived from the validated issuer, allowing the same-origin initiation POST to follow its provider redirect. Hypermedia JSON, POST redirects, callbacks, unavailable pages, and errors keep `form-action 'self'`; the route rejects malformed or compound origin values instead of interpolating them into the policy.

## Current Hosted Evidence

The selected [acceptance AittaDB service](https://test.aittadb.com/) runs a build that supports the required Authorization Code, S256 PKCE, confidential client authentication, introspection, and storage scopes. Its live OAuth Apps feature flag and [OpenID configuration](https://test.aittadb.com/.well-known/openid-configuration) must be checked again as part of TASK-030; a provider-side `503 feature_unavailable` during the browser CSP proof showed that point-in-time deployment configuration cannot be treated as permanent evidence. The public production [AittaDB service](https://aittadb.com/) remains separate and does not need to change for acceptance testing.

No confidential Investor App acceptance client or successful hosted callback is claimed yet.

## Remaining Live Proof

An authorized acceptance operator must complete all of these steps:

1. Register one confidential acceptance client with only the required storage scopes and the exact acceptance callback URI.
2. Install the client secret and separate AES-GCM transaction and CSRF cookie keys in hosted secret storage, bind the dedicated proof D1, and deploy the exact validated source to the acceptance Investor App.
3. Sign in as the configured acceptance owner and run the owner-only connection check end to end.
4. Confirm discovery, consent, callback, token exchange, introspection, exact scope/audience/expiry validation, replay rejection, cookie clearing, and closed proof persistence without credentials in responses or private logs.
5. Record the hosted evidence on the integrating branch, then and only then archive TASK-030.

Use a development or acceptance deployment for this proof. Do not change production access or production data as part of source validation.
