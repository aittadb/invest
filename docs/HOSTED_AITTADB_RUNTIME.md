# Hosted AittaDB Application Runtime

## Purpose and Status

`worker/hosted-application-composition.ts` is the production Worker assembly
boundary for Investor App persistence. It composes one confidential service
token provider, one bounded AittaDB `StorageAdapter`, one backend repository
factory, and one browser-mutation session per immutable Sites environment.

The runtime now composes named persistent campaign, package, participant-access,
and participant founder-application capabilities over that adapter.
`createApplicationWorker` installs
`/owner/setup`, campaign editing, draft preview, publish/unpublish, and owner
package management only in the configured-owner route group. For a signed-in
non-owner, it derives the trusted `participantAccess` projection from that
subject's persistent profile, current package, and current acknowledgment gate.
An unregistered subject stops after the profile read without opening package or
acknowledgment storage. On `/participant/registration`, the runtime instead
combines a fresh subject-bound participant repository, the hosted mutation
session, and versioned evidence derived from the persisted campaign revision
and only its two registration notices. The participant repository stores the
exact acknowledged snapshots and can recover an old exact committed retry after
a policy update or Worker restart without accepting stale evidence for a new
registration. Founder composition opens private campaign policy and a fresh
subject-bound profile/application pair only for the exact founder resource after
participant authorization. Indication, aggregate, moderation, export, deletion
coordination, and profile-route composition still require their own named
persistent capabilities.

This source composition and its deterministic protocol services are not hosted
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
  now,
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
adapter and exposes only named, narrow capability methods for browser-mutation
replay, the atomic campaign/audit repository, the public campaign projection
reader, the owner package workspace, a participant package reader,
subject-bound package acknowledgment, one participant-access state reader, and
one participant-bound founder-application pair.
That reader creates fresh profile and acknowledgment repositories for each
trusted account and combines them only through the bounded projection service.
The named `participantRepository(account)` capability returns a fresh repository
bound to that validated account; registration composition additionally closes it
over the request's trusted subject and provider email label. Its
registration-only recovery capability can read immutable profile revision 1 but
cannot write a stale-policy submission. Notice snapshots remain inside the
subject-bound profile records; no notice key contains participant identity.
Profile self-service uses the same named capability only after the trusted
participant-access projection has been resolved for the exact profile path,
then binds every route callback to that account again.
It intentionally has no generic builder or adapter accessor. The Worker calls
these methods centrally and passes routes only their declared interfaces and
mutation session; it never passes the adapter or factory into route context.
The factory does not infer persistence
from a hostname, owner, campaign, D1, R2, browser store, file, or process-memory
map. `StoragePackageVersionRepository` and
`StorageAcknowledgmentRepository` retain no local authority; their historical
`InMemory*` names remain compatibility exports for deterministic fixtures.

`StorageCampaignRepository` is production-neutral and retains no state outside
its supplied adapter. `StorageFounderApplicationRepository` follows the same
production-neutral rule. Hosted composition supplies both only through
`AittaDBStorageAdapter`.
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

## Package Storage and Publication

Before any section or chunk is staged, the repository creates an immutable
operation intent keyed by the owner operation ID. It binds the audited actor or
explicit unaudited mode, expected owner revision, supplied-versus-computed
fingerprint, prior package and gate state, the first validated server timestamp,
and a digest of every normalized metadata and content field. Every retry must
match that intent before further staging, including after a partial-stage or
failed-final-publication response. A later clock reading is replaced by the
persisted timestamp only for that exact operation; owner-controlled fields stay
fingerprinted and hash-bound. A retry draft first passes closed exact-key,
data-only validation at every object and array level, so unknown properties,
accessors, custom prototypes, and decorated arrays fail before staging.

Every immutable package section is then staged under a per-version private
record. Large Markdown values are divided on Unicode boundaries into
deterministic immutable chunk records capped below the advertised 65,536-byte
record limit. Each staged record uses a derived retry-stable operation and a
one-record transaction, so a 64-section package stays below both record and
transaction mutation limits. A compact immutable version manifest references
the section records; it does not inline private section content.

Only the final transaction makes a staged version reachable. That transaction
atomically creates the version manifest, advances the owner-visible package
head, advances the package-current gate, and appends closed owner audit
evidence. A failed prewrite or final transaction leaves no reachable version,
head, gate, or audit event. Exact retry after failure or Worker reconstruction
replays completed stages and safely finishes publication only when it matches
the intent; changed actor, revision, metadata, material flag, fingerprint mode
or value, staged content, or unstaged content remains conflicting.

All package and acknowledgment records use closed versioned schemas. Reads
verify the exact requested key and record envelope, immutable or mutable
revision rule, kind, identifiers, order, count, byte bound, and cross-record
hashes. Chunk lengths are accumulated against the Markdown limit before
concatenation or allocation. One reconstruction may follow at most 32 package
versions and read at most 512 package records, including its head or gate,
manifests, sections, chunks, and operation intents. Publication refuses a new
version when the resulting reachable head would cross either limit. Existing
over-limit or cyclic storage fails closed before another record is read; the
reader retains one bounded visited set instead of copying it at each ancestor.
Request-local immutable cache entries retain the complete ancestry ID list and
logical reconstruction-record charge. Reusing an entry checks and adds that
lineage and debits the fresh reconstruction context, so cached and uncached
topologies enforce the same 32-version and 512-record limits.
Every intent, stage, final publication, and
acknowledgment transaction response must contain an exact boolean replay flag
and the exact positional key, revision, and value for every requested record;
prepared audit output is verified separately. Extra, missing, null, reordered,
or mutated backend results fail closed.

The package-current gate is separate from the owner-visible head and binds the
exact current version plus required-acceptance hash. Every editorial and
material publish updates it. An acknowledgment transaction atomically creates
immutable evidence, advances only that participant's acknowledgment head, and
compare-and-set writes the unchanged gate value. Owner publication and stale
acceptance therefore cannot both commit. Private version and acceptance
metadata retain the original expected gate revision solely to reconstruct an
exact transaction on replay. Acknowledgment never advances the owner-visible
package revision, and gate metadata never enters HTML, hypermedia, logs, or
exports.

The read-side `currentAcceptanceStatus` repository method samples the exact gate
before and after reading the latest participant acknowledgment. It returns the
boolean status together with the stable gate revision, package version,
content hash, and required-acceptance hash only when both samples match. The
participant authorization projection accepts that status only when its version
and hashes also match both independently sampled current package snapshots. A
small bounded retry handles one concurrent publication; a stale but internally
valid gate, a continuing gate change, or any evidence mismatch fails closed.
The boolean `requiresCurrentAcceptance` convenience method delegates to that
evidence-bearing read. The acknowledgment route uses a separate single
current/latest/current attempt and fails its precondition on change rather than
running that bounded loop.

Hosted composition calls `participantRequest(account)` once for each eligible
participant HTTP request. Authorization and the subsequently selected profile,
package, acknowledgment, or founder route receive the same subject-bound scope;
route repository factories cannot reopen the underlying uncapped adapter. A
second HTTP request receives a new scope.

That scope admits at most 574 participant-private storage-record reads. The
maximum valid authorization envelope is 551: 511 unique immutable package
records plus two outer attempts, each containing six profile reads, two package
head reads, and three four-read accepted gate attempts. The profile reads cover
current, matching latest history, and immutable registration revision 1 for
each sample. The selected route owns the remaining 23 reads. This covers a
profile mutation's current state, two historical samples, failed first attempt,
recovery state and history, retry, and final projection. Package GET uses one
cached-head read and acknowledgment GET uses at most four. The next read fails
before adapter access. Public campaign reads and storage transactions are
outside this participant read counter, while all profile, package, gate,
acceptance-head, acceptance-record, and participant-route reads are inside it.

Within the scope, one read-only package reader reuses up to 64 verified immutable
version reconstructions. Cache hits recharge complete ancestry and logical read
metadata before reuse. Profile records, package and acceptance heads, and the
acceptance gate remain mutable samples and are always read again. The cached
reader cannot list or transact. A separate acknowledgment mutation adapter can
transact and shares the same read counter and cached immutable binding, but it
does not grant mutation authority to the cache. No adapter, counter, cache, or
subject-bound repository survives the HTTP request.

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
the factory's named campaign, package, and founder methods centrally. It installs setup,
campaign editor, and owner package handlers only inside
`createOwnerRouteHandler`, and projects only subject-bound package and founder
capabilities into the participant route group after trusted participant
authorization. Owner
capability headers are server-replaced and are never authorization by
themselves; generic runtime availability adds no browser header or navigation
item.

Public route composition receives only `publicCampaignReader()`. That reader is
bound to `campaign-public-presentation/configured-campaign`; it cannot read the
private current setup, immutable history, operation receipts, or audit records.
Owner reads use the separate atomic repository only after trusted owner
authorization. Anonymous callers receive `401`; authenticated non-owners receive
the generic `404` surface before a private repository read.

The one shared mutation session is configured to the largest currently composed
form as an absolute ceiling and explicitly permits only the founder route's
repeated secondary-contribution field. Setup, editor, package, acknowledgment,
and founder adapters pass their own byte, field, and repeated-field limits to
every verification. Those limits are validated before form proof extraction, so
the larger setup allowance cannot widen another route.
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

The hosted browser-mutation session supports the larger setup envelope, while
each feature route narrows it again. A route's body limit and field-count limit
cannot exceed the shared policy, and its repeated fields must be a subset of
the shared repeated-field allowlist. Invalid or wider limits fail before proof
parsing or replay claim. Owner package mutations accept at most 524,288 bytes,
nine non-repeated fields, and enough room for the maximum valid URL-encoded
Unicode package form. Participant acknowledgment remains limited to 512 bytes
and two non-repeated fields. Founder mutations accept at most 262,144 bytes and
13 distinct fields, with repeated values allowed only for configured secondary
contribution areas. Body and field failures also occur before the
replay capability is claimed, so the same proof remains usable for a corrected
bounded request.

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
intent/chunk/final storage-result rejection. Package coverage includes
owner/participant route scoping, restart reconstruction, immutable intent
conflicts, advancing-clock retry recovery, 64-section and maximum-size Unicode
records, failed-stage and failed-final-publication recovery, hostile record and
transaction-result matrices, package/acceptance concurrency, stable gate
sampling, accepted and unaccepted maximum-history aggregate read counts, nested
publication retry counts, exact maximum-package GET and acknowledgment GET
totals, the complete nested-plus-outer 551-read envelope, the read-560 cutoff,
cached ancestry and reconstruction recharge, exact material gating, and
narrowing-only route mutation limits.
Founder coverage adds configured-choice projection, create/retry/edit/stale/
withdraw history, policy closure between action discovery and mutation, foreign
and owner non-disclosure, origin and proof rejection, investment-state
independence, and reconstruction through a fresh Worker. The
synthetic hosted services implement and enforce the discovered AittaDB
read/list/transaction controls rather than bypassing the adapter. Source
and built-artifact scans complement `npm run instances:check`, which rejects
tracked runtime env files and active Sites bindings.
