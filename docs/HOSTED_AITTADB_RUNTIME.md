# Hosted AittaDB Application Runtime

## Purpose and Status

`worker/hosted-application-composition.ts` is the production Worker assembly
boundary for Investor App persistence. It composes one confidential service
token provider, one bounded AittaDB `StorageAdapter`, one backend repository
factory, and one browser-mutation session per immutable Sites environment.

The runtime now composes persistent campaign setup and presentation capabilities
over that adapter. `createApplicationWorker` installs `/owner/setup`, its
preview, and the campaign editor/preview/publish/unpublish resources only in the
owner route group. Package, participant, founder, indication, aggregate,
moderation, export, and deletion workflows still require their own named
persistent capabilities.

This source composition and its deterministic protocol service are not hosted
acceptance evidence. Activation remains blocked until the configured AittaDB
deployment passes the required storage, authorization, quota, retention, and
credential-boundary proof.

## Hosted Configuration

Every application-persistence value is deployment configuration. Reusable
source contains no hostname, discovery path, client identity, credential,
namespace, owner, campaign, or key default.

Ordinary hosted values:

- `APP_BASE_URL`: exact HTTPS Investor App origin;
- `AITTADB_STORAGE_ISSUER`: exact logical HTTPS AittaDB issuer;
- `AITTADB_STORAGE_TRANSPORT_ORIGIN`: optional exact backend-only HTTPS network
  origin;
- `AITTADB_STORAGE_ENTRY_HREF`: exact same-issuer logical storage discovery
  resource with no query or fragment;
- `AITTADB_STORAGE_CLIENT_ID`: dedicated confidential service-client ID; and
- `AITTADB_STORAGE_SCOPES`: exactly `storage.read storage.write
  storage.delete`; and
- `DEPLOYMENT_PUBLICATION_READY`: optional exact `true` or `false`. Missing and
  `false` keep publication blocked. `true` is valid only after objective
  deployment checks pass; any other value invalidates the complete runtime.

Hosted secrets:

- `AITTADB_STORAGE_CLIENT_SECRET`: dedicated service-client secret; and
- `BROWSER_MUTATION_SESSION_KEY`: canonical base64url encoding of an independent
  256-bit AES-GCM key.

The service client is non-interactive. Register no browser origin or redirect
URI for it. AittaDB must bind it to only this deployment's isolated storage
namespace. Storage scopes complement that namespace ACL and do not replace it.

The optional interactive `AITTADB_OAUTH_*` proof uses a different client and
different cookie keys. When both configurations are present, the parser rejects
reuse of the proof client ID, proof client secret, transaction key, or CSRF key
as application-runtime material.

Missing all application-runtime values disables the runtime and leaves the
development-only `CAMPAIGN_CONFIG_JSON` fixture available. Supplying any
runtime value, including readiness alone, requires the complete storage set plus
`APP_BASE_URL`. Partial, malformed, non-HTTPS, cross-issuer,
noncanonical-scope, key-reuse, or weak-key configuration resolves to `null`; it
creates no token request, storage request, owner campaign route, or private
availability marker. Once any runtime value is present, scalar campaign fallback
is suppressed even when parsing fails.

## Credential Closure

The configuration parser captures the service-client ID and secret only in a
provider-construction closure. The returned configuration has no readable
credential field. Runtime composition invokes that closure once, gives only
the provider's `accessToken()` closure to `AittaDBStorageAdapter`, and returns
only:

```ts
{
  repositoryFactory,
  mutationSession,
  publicationReady,
}
```

The service-token provider, adapter, configuration, key material, credentials,
and tokens are not route data, render bindings, render headers, React props,
hypermedia values, errors, or log inputs. Vinext receives a new environment
projection containing only `ASSETS` and `IMAGES`; the secret-bearing Worker
environment never reaches framework rendering. The provider may coalesce and
cache a short-lived token in one Worker isolate; each acquisition has its own
abort deadline, and failed or timed-out renewal is cleared for a later retry.
That transient cache is neither persistence nor authorization state.

The logical issuer validates every discovered hypermedia control. The optional
transport origin changes only backend network routing. Requests follow no
redirect and carry the bearer value only to the validated transport target.

## Repository Factory

`StorageApplicationRepositoryFactory` closes over the single credential-bound
adapter and exposes only named, narrow capability methods. It intentionally has
no generic builder or adapter accessor. Its methods return the browser-mutation
replay claimer, the atomic campaign/audit repository, and the public campaign
projection reader. The Worker calls these methods centrally and passes routes
only their declared interfaces and mutation session; it never passes the
adapter or factory into route context. The factory does not infer persistence
from a hostname, owner, campaign, D1, R2, browser store, file, or process-memory
map.

`StorageCampaignRepository` is production-neutral and retains no state outside
its supplied adapter. Hosted composition supplies only `AittaDBStorageAdapter`.
The development-labeled compatibility subclass remains available to tests and
cannot enter hosted composition. The older direct HTTP campaign repository is
not used because it cannot atomically commit campaign revision, history,
operation index, public projection, and audit evidence.

Private schema-version-4 setup values are normalized and deterministically
serialized, then SHA-256 addressed and staged as immutable 45,000-byte raw
chunks. Their encoded storage records are explicitly bounded to 61,440 bytes,
with one derived retry-stable operation ID per chunk. Current, history, and
business-operation records store only the setup hash, byte count, and chunk
count. Reads reconstruct only after exact key, revision, schema, index, size,
hash, canonical serialization, and domain validation all pass.

Before staging, a closed immutable intent record is created at
`campaign-setup-intents/<business-operation-id>` with a separate hash-derived
transaction operation ID. Its 2,048-byte maximum binds mode, normalized setup
reference, expected and resulting revisions, original timestamp, and audited
owner actor and transition when present. Exact retries after a stage or response
failure may resume from this record after a Worker restart. Reusing the business
operation ID with any changed bound field conflicts before another chunk or
final transaction.

Only the final business transaction makes a revision visible. It atomically
commits current/history/operation metadata, the separately readable public
projection, and owner audit evidence. Interrupted staging may leave unreachable
intent and chunk records, but never current setup, history, completed operation
evidence, public campaign state, or audit evidence. A lost final response may
hide an all-or-none committed transaction from its caller; the same intent lets
an exact retry validate and return that receipt. Intent, chunk, and final
transaction results are accepted only as closed envelopes with a boolean replay
flag and the exact record count, mutation order, keys, revisions, and values.
Extra, null, missing, reordered, or mismatched records fail closed. Hosted quota
and retention policy must account for bounded cleanup of unreachable content.

## Browser-Mutation Replay

The factory supplies the first production repository capability: an atomic
browser-mutation replay claimer. `BrowserMutationSession` has already replaced
the random browser capability with a one-way, origin-bound replay identifier
before calling it.

The claimer:

- accepts only the exact `browser-mutation:v1:` one-way identifier grammar;
- requires an expiry strictly in the future and no more than 600 seconds away;
- atomically creates one `browser-mutation-replays` record with expected
  revision `null`;
- uses the same stable identifier as the transaction operation ID;
- stores only schema version and expiry;
- returns `true` only for a non-replayed successful transaction; and
- returns `false` for exact, concurrent, restarted, conflict, or already-stored
  replay attempts.

It never stores actor, email, origin, cookie name, ciphertext, CSRF token, body,
campaign data, credential, or access token. There is no read-then-write window,
D1 claim, browser authority, or Worker-global replay map.

Replay records carry their security expiry even though operation receipts may
remain longer for durable idempotency. The hosted adapter proof must verify the
deployment's retention and quota policy before activation so expired replay
records and receipts cannot exhaust the isolated namespace.

## Worker and Route Boundary

`worker/index.ts` installs one resolver. `createApplicationWorker` resolves it
fail-closed but does not place the runtime in `ApplicationRouteContext` or pass
it to public, participant, image, or framework-rendering code. The Worker calls
the factory's named campaign methods centrally, then installs setup and editor
handlers only inside `createOwnerRouteHandler`. Owner capability headers are
server-replaced and are never authorization by themselves.

Public route composition receives only `publicCampaignReader()`. That reader is
bound to `campaign-public-presentation/configured-campaign`; it cannot read the
private current setup, immutable history, operation receipts, or audit records.
Owner reads use the separate atomic repository only after trusted owner
authorization. Anonymous callers receive `401`; authenticated non-owners receive
the generic `404` surface before a private repository read.

The one shared mutation session is configured to the largest currently composed
owner form as an absolute ceiling. Setup and editor adapters pass their own byte
and field limits to every verification. Those limits are validated before form
proof extraction, so the larger setup allowance cannot widen another route.
The editor accepts at most 262,144 wire bytes and then enforces a 65,536-byte
decoded campaign presentation. Initial setup accepts at most 1,048,576 wire
bytes and then enforces a 262,144-byte decoded setup. Successful HTML and JSON
mutations clear the consumed cookie; every parser, readiness, or storage error
after successful verification clears the same cookie once. JSON responses that
advertise another action also issue a fresh encrypted proof.

Publication checks combine intrinsic campaign readiness with the immutable
runtime boolean. The runtime defaults to false and accepts only exact configured
text. There is no hard-coded success path. Unpublish remains available even
when deployment readiness later becomes false.

Future wiring must preserve these rules:

1. Construct subject-bound repositories from trusted Sites identity where the
   resource contract requires subject scoping.
2. Pass routes only named narrow repositories, policies, and mutation sessions.
3. Preserve mutation `Set-Cookie` and clear-cookie headers in both HTML and JSON
   representations.
4. Never use `CAMPAIGN_CONFIG_JSON`, owner email, request host, Worker bindings,
   D1, R2, or process memory as production persistence. Participant state
   readers are explicit composition dependencies, never environment authority.

## Verification

Focused tests cover all-or-nothing configuration, exact readiness parsing,
scalar-fixture suppression, cross-origin discovery, canonical scopes,
pairwise proof-material separation, resolver concurrency, exact transport
mapping, bounded token acquisition, credential-free serialization and render
bindings, atomic replay claims, owner-only route disclosure, setup and editor
HTML/JSON parity, publication gating, separately persisted public reads,
campaign/audit atomicity, exact retries, competing revisions, restart behavior,
unpublish, near-limit UTF-8 forms, the 61,440-byte chunk-record boundary,
65,536-byte chunk-transaction ceiling, interrupted staging, changed retry
identity before further writes, lost final responses, and exact hostile
intent/chunk/final storage-result rejection. The synthetic hosted service implements and enforces
the discovered AittaDB read/list/transaction controls rather than bypassing the
adapter. Source and built-artifact scans complement `npm run instances:check`,
which rejects tracked runtime env files and active Sites bindings.
