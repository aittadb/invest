# Browser mutation session

`http/browser-mutation-session.ts` turns a trusted ChatGPT Sites identity into
a short-lived, one-time browser mutation capability. It is independent of the
AittaDB OAuth connection proof. Owner and participant routes can therefore use
one anti-forgery boundary without sharing OAuth transaction state, keys, or
cookies.

## Trust boundary

The Worker must derive the `TrustedSitesMutationIdentity` from the Sites
identity context after removing any caller-supplied internal identity headers.
The module never reads an identity from request headers, form fields, JSON, or
cookies. `null`, malformed, or mismatched trusted identities fail closed.

Each deployment supplies:

- its exact HTTPS application origin;
- a dedicated 256-bit, non-extractable AES-GCM key with only `encrypt` and
  `decrypt` usage;
- a cryptographically secure random-byte provider and bounded clock;
- a 60-600 second lifetime; and
- an atomic replay claimer.

The AES key is hosted secret material for this capability only. It must not be
reused as an OAuth CSRF key, OAuth transaction key, AittaDB client secret,
campaign setting, or source default. The constructor accepts a `CryptoKey`, not
encoded key text, and missing or unsuitable key material prevents capability
construction.

## Issuance and refresh

`issue()` requires a trusted participant or owner and a request whose URL origin
equals the configured application origin. It returns:

- a random CSRF token for a hidden HTML `_csrf` field or the
  `x-investor-app-csrf` JSON request header;
- an expiry timestamp; and
- one `Set-Cookie` value.

The cookie has a random `__Host-` name and is `Secure`, `HttpOnly`,
`SameSite=Strict`, host-only, and scoped to `/`. Its AES-GCM ciphertext contains
only the capability ID, actor type and subject, exact origin, issue and expiry
times, and the token hash. Authenticated additional data binds the exact cookie
name, path, origin, and protocol version. Neither the hosted key nor plaintext
state is serialized.

Issuing again is the refresh operation. Every issuance uses a different cookie
name, so concurrent resource renders do not overwrite each other's proof.
Earlier proofs remain valid for at most their short lifetime and for one
successful mutation only. Key rotation invalidates every outstanding cookie.

## Verification and replay

`verifyMutation()` selects the exact random cookie named by the submitted proof,
decrypts and validates its bindings, and delegates request verification to
`http/mutation-security.ts`. HTML forms and JSON requests consequently share
the same actor, exact-origin check, body limits, method normalization, and
constant-time SHA-256 proof comparison.

The session configuration is an absolute ceiling shared by composed routes.
Each route passes its own body, field, and repeated-field limits to
`verifyMutation()`. Requested limits must be no greater than that ceiling and
are validated before proof extraction; form proof extraction itself uses the
route's byte limit. A larger setup form therefore cannot widen campaign,
package, profile, or participant mutation boundaries.

Only after identity, origin, ciphertext, expiry, request body, and CSRF proof
validation succeed does the module call `claimReplay()`. The claim contains an
opaque hash-derived capability ID and expiry only. It contains no identity,
origin, CSRF token, body, credential, or campaign data. The claimer must
atomically return `true` for the first claim and `false` thereafter, including
under concurrent requests. A false, malformed, or failed result rejects the
mutation. Successful verification also returns a matching expired cookie value
for the route to attach to its response; replay remains blocked even if the
client ignores that deletion.

Once `verifyMutation()` returns, replay authority has already been consumed.
The owning route therefore attaches that expired cookie to every subsequent
success or error response, including feature parsing, readiness, revision, and
storage failures. It appends only that one clearing value and does not mint a
replacement proof on an error. A replay rejected inside verification has no
returned clear-cookie capability and receives no additional cookie header.

Production composition implements the claim as a durable, expiry-bounded
AittaDB atomic create through `StorageApplicationRepositoryFactory`. It stores
only the one-way capability identifier, schema version, and expiry and returns
true only for the first committed transaction. A Worker-global map, process
memory, browser storage, D1, or best-effort read-then-write is not authority.
Tests may use a deterministic in-memory claimer solely as an adapter fixture.
See `docs/HOSTED_AITTADB_RUNTIME.md`.

Because a proof is one-time, a response retry needs a newly rendered proof.
Business mutations still require their own operation ID, compare-and-set rules,
and idempotent repository behavior; the CSRF capability does not replace those
domain controls.

## Failure behavior

Anonymous identity is reported through the fixed authentication-required
failure. Foreign actors, expired or replayed capabilities, substituted proofs,
renamed or duplicate cookies, cross-origin requests, and malformed state use a
fixed non-disclosing rejection. Unsupported media types, malformed bodies, and
oversized bodies retain the generic browser-mutation failure classes. Missing
key material or replay storage, invalid hosted configuration, cryptographic
failure, and replay-store failure create no usable capability and expose only a
fixed service failure.

Routes must map these failures with `toPublicMutationSecurityFailure()` and must
not log request cookies, proof tokens, encrypted state, trusted identity values,
or internal causes.
