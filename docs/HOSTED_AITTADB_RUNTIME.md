# Hosted AittaDB Application Runtime

## Purpose and Status

`worker/hosted-application-composition.ts` is the production Worker assembly
boundary for Investor App persistence. It composes one confidential service
token provider, one bounded AittaDB `StorageAdapter`, one backend repository
factory, and one browser-mutation session per immutable Sites environment.

The runtime now composes named persistent campaign, package, participant-access,
participant founder-application, owner founder-review collection and detail,
owner audit, owner manual-notification, and owner aggregate-reconciliation
capabilities over that adapter. `createApplicationWorker` installs
`/owner/setup`, campaign editing, draft preview, publish/unpublish, owner package
management, the founder-review collection and detail resources, notification
history, and aggregate reconciliation only in the
configured-owner route group. For a signed-in
non-owner, it derives the trusted `participantAccess` projection from that
subject's persistent profile, current package, and current acknowledgment gate.
An unregistered subject stops after the profile read without opening package or
acknowledgment storage. Only an explicit missing-profile result is eligible for
entry; read failures and malformed or identity-mismatched projections stay
generically unavailable. Public registration controls on a published open
campaign return from ChatGPT sign-in to `/participant`. An eligible
unregistered HTML request then receives a non-cacheable redirect to
`/participant/registration`; JSON receives the equivalent single versioned
entry action. Closed and unpublished campaigns advertise and accept no new
registration. Existing records and exact committed retries remain available
after closure. For either eligible entry or the exact registration path, the
runtime combines a subject-bound participant repository, the hosted mutation
session, and versioned evidence derived from the persisted campaign revision
and only its two registration notices. The participant repository can recover
an exact committed retry after a policy update or Worker restart without
accepting stale evidence for a new registration. The next request after
registration reconstructs the current package and permitted profile and
workflow controls from persistent state. A deletion-requested entry retains
only profile viewing and sign-out while withholding package, acknowledgment,
founder, and investment actions. The profile deletion action selects the
subject-bound atomic coordinator from the same finite request scope, so the
profile transition, active founder and investment withdrawals, aggregate
changes, and closed audit evidence commit together or not at all. Independently
granted marketing consent remains separately withdrawable.
Export persistence still requires its own named capabilities.

Founder composition opens private campaign policy and a fresh subject-bound
campaign/profile/application scope only for the exact founder resource after
participant authorization. Its create and edit repositories add the exact
sampled campaign revision as an atomic transaction check, so a concurrent
policy change cannot authorize a stale write.

The configured owner reconciliation resource loads and advertises the persisted
campaign revision and amount configuration, binds correction authority to the
trusted owner subject, and requires new correction work to return that exact
revision. It atomically persists the corrected aggregate, retry receipt, audit
evidence, and an exact non-mutating assertion that the advertised campaign
revision is still current. Existing exact receipts are verified before current
campaign state and decoded from their own self-consistent committed currency, so
delayed retries survive later campaign configuration and currency revisions
without letting current configuration reinterpret new work. The returned
transaction must contain a closed boolean replay envelope and four dense ordered
records matching the submitted aggregate, receipt, audit, and campaign-check
mutations. One bounded recovery verification converges an overlapping exact
retry on the immutable winner. Its contribution scan stops at 1,000 records or
20 page reads and rejects malformed or non-progressing pagination.

The persistent owner indication-detail primitive can resolve one deployment-key
opaque review ID to a bounded verified current record and notification without a
list scan.

The persistent owner-rejection primitive can commit an indication transition,
aggregate update, audit event, notification template, and retry receipt
atomically.

When `OWNER_INDICATION_REVIEW_KEY` is configured, the runtime imports one
non-extractable owner-review key and assembles the persistent summary
collection, one opaque detail reader, atomic rejection, and hosted mutation
session into the owner route group. Detail resolution performs no list scan;
rejection commits the indication transition, aggregate update, audit event,
notification template, and retry receipt atomically. Missing review-key
configuration omits only this capability and does not expose a partial route.

The already-created private notification records are available through the
hosted owner collection/detail route, whose copy and owner-entered sent
transitions append audit evidence atomically. Export, deletion coordination,
and profile-route composition retain their own named capability boundaries.

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
  256-bit AES-GCM key; and
- `OWNER_INDICATION_REVIEW_KEY`: optional canonical base64url encoding of a
  different 256-bit AES-GCM key. Configure it to enable owner indication
  collection, detail, and rejection routes.

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
  ownerIndicationReviewTokens?,
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
reader, the owner package workspace, the owner-bound indication-review
collection, the bounded owner founder-review collection and direct detail
lookup, the immutable audit reader, the atomic manual-notification activity
repository, a participant package reader, subject-bound package acknowledgment,
one participant-access state reader, and one participant-bound founder
campaign/profile/application scope. Its owner aggregate method
accepts the complete immutable campaign revision rather than a detached currency
value and returns a fresh configured-owner-bound capability with only preview
and atomic audited correction operations. It exposes no adapter, generic
collection, campaign key, or participant subject selector.
That reader creates fresh profile and acknowledgment repositories for each
trusted account and combines them only through the bounded projection service.
The named `participantRepository(account)` capability returns a fresh repository
bound to that validated account; registration composition additionally closes it
over the request's trusted subject and provider email label. Its
registration-only recovery capability can read immutable profile revision 1 but
cannot write a stale-policy submission. Notice snapshots remain inside the
subject-bound profile records; no notice key contains participant identity.
Profile self-service uses the request scope's named participant-profile
repository only after the trusted participant-access projection has resolved
the same account. The exact profile path may read or mutate it; `/participant`
uses only the resulting availability signal for HTML and hypermedia navigation.
It intentionally has no generic builder or adapter accessor. The Worker calls
these methods centrally and passes routes only their declared interfaces and
mutation session; it never passes the adapter or factory into route context.
The factory does not infer persistence
from a hostname, owner, campaign, D1, R2, browser store, file, or process-memory
map. `StoragePackageVersionRepository` and
`StorageAcknowledgmentRepository` retain no local authority; their historical
`InMemory*` names remain compatibility exports for deterministic fixtures.

`ownerIndicationReviews(authenticatedSubject, configuredOwnerSubject, tokens)`
remains the narrow read-only summary capability. Hosted route composition uses
`ownerIndicationModeration(...)`, a fresh frozen facade over that collection,
the one-record detail reader, and atomic rejection. Both are bound to the exact
owner authorization decision and one application-owned navigation-token
boundary. The runtime imports one stable, non-extractable, deployment-only
AES-GCM key and exposes only the resulting token capability; no key material,
backend cursor, decrypted current-record key, or adapter enters runtime
configuration output, campaign content, rendering, logs, or browser-visible
failures.

Owner founder review uses two independent singleton read ports. The collection
port exposes only `list`; each request lists at most 25 current founder records,
binds each to its immutable terminal transition, and validates each current
field payload and dedicated review lookup within a fixed 350-record-read
ceiling. It returns only established one-way review identifiers and the
collection summary allowlist. A new factory can
continue an existing AittaDB cursor after a Worker restart. AittaDB's validated
cursor contract keeps principal, namespace, and physical-key data out of that
continuation; the Worker does not log or decode it.

The detail port exposes only `get`. It maps one valid one-way review identifier
to one dedicated private lookup record without listing, verifies the stored
subject and internal application coordinates, derives the distinct current key
server-side, then reconstructs and verifies the complete bounded immutable
application ancestry within a fixed 210-record-read ceiling. Malformed
identifiers read nothing and missing identifiers read only the lookup key.
Hosted routing composes the two ports so a collection item links to its
available detail and that detail links back to the collection.
Independently composed ports omit links to the unavailable sibling resource.
Anonymous and non-owner callers are rejected before either founder-review port
is invoked.

New founder creates provision the lookup through a deterministic transaction
after the original retry-compatible application transaction and before success
is returned. Pre-index applications require an explicit backend-only bounded
backfill that verifies their complete current and immutable ancestry first;
owner collection and detail GET requests never create lookup state. The public
review ID remains the established subject-and-application identity and is not
the current application storage key, although its digest intentionally
addresses the dedicated lookup record.

`StorageCampaignRepository` is production-neutral and retains no state outside
its supplied adapter. `StorageFounderApplicationRepository` follows the same
production-neutral rule. Hosted composition supplies both only through
`AittaDBStorageAdapter`.
The development-labeled compatibility subclass remains available to tests and
cannot enter hosted composition. The older direct HTTP campaign repository is
not used because it cannot atomically commit campaign revision, history,
operation index, public projection, and audit evidence.

## Participant Investment Ownership Runtime

Hosted participant investment persistence is unavailable until the exact
subject has passed `initializeParticipantInvestmentOwnership`. New-account
provisioning may supply an empty inventory only when it authoritatively knows
that no indication record exists for that subject. Migration must instead
supply the complete sorted inventory of at most 100 indication IDs, current
revisions, and lifecycle statuses. The function verifies each current and
terminal record, rejects more than four active entries, and atomically creates
the immutable subject root, index, and summary. Ordinary request composition
must never call this function as an absence fallback. Existing-root corruption
is unavailable and requires operator investigation rather than automatic
reinitialization.

This primitive does not yet make hosted participant investment persistence
ready. `TASK-158` must atomically provision empty ownership metadata with first
registration, and `TASK-159` must provide the credential-closed complete
inventory migration for legacy participants. Ordinary hosted investment routes
must remain unavailable for a subject until the applicable prerequisite has
completed. Exact initialization retries use immutable root evidence and return
their original counts after later valid lifecycle activity, but every retry
still validates the current root, index, summary, and compact ownership heads.
Each head recomputes the terminal operation fingerprint, including the
normalized field-reference commitment for create and edit, before its lifecycle
status can affect capacity. Each active head then verifies its one-to-eight
current field chunks, derives its normalized uniqueness scope, and validates the
exact active lease. Non-active heads read neither fields nor leases.

The malformed-input-safe adapter-read ceilings are 240 for capacity, 239 for
first initialization, 241 for an initialized restart, and 479 for a maximum-size
initialization that loses a concurrent exact race and verifies the winner. A
fresh create rejected at capacity uses at most 243 reads after including its target
lookup and two operation-receipt checks. These paths issue no collection list,
or ancestry reconstruction; field-chunk and lease reads are limited to the four
active heads. Because an AittaDB HTTP read is a Worker Fetch subrequest, at least
479 subrequests must remain when this boundary starts; authentication, token
acquisition, protocol discovery, route reads, and writes require additional
whole-request headroom. Cloudflare's
[Worker subrequest limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests)
give external requests only 50 subrequests on Workers Free, which is unsupported
for this feature. Production must use Workers Paid or a higher equivalent limit;
the paid default of 10,000 leaves ample capacity-proof headroom unless deployment
configuration lowers it.

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

That scope admits at most 7,699 participant-private storage-record reads. The
maximum valid authorization envelope is 551: 511 unique immutable package
records plus two outer attempts, each containing six profile reads, two package
head reads, and three four-read accepted gate attempts. The profile reads cover
current, matching latest history, and immutable registration revision 1 for
each sample. The selected capability then owns its own finite route budget:
package one, acknowledgment eight, ordinary profile actions 23, founder 1,063,
or account deletion 7,148 reads. The account-deletion budget covers the initial
profile sample, one bounded campaign materialization, and both an initial
coordinator attempt and exact replay recovery at its exported maximum. A route
budget may expand monotonically from the ordinary profile sample to account
deletion only before the larger work begins; unrelated or smaller budgets
cannot replace it after reads start. The 7,699 global ceiling is the
authorization maximum plus the largest route budget; either that ceiling or
the selected route's smaller ceiling rejects the next read before adapter
access. Public campaign-presentation reads and storage transactions are outside
these participant read counters, while private founder/deletion campaign
samples and all profile, package, gate, acceptance, ownership, aggregate, and
participant-route record reads are inside them.

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
the factory's named campaign, package, founder, audit, and notification methods
centrally. It installs setup, campaign editor, owner package, audit history, and
manual-notification handlers only inside
`createOwnerRouteHandler`, and projects only subject-bound package and founder
capabilities into the participant route group after trusted participant
authorization. Registration and profile entry capabilities are likewise
composed only after trusted identity and participant-state checks. Their
server-replaced rendering headers are presentation signals, never authorization
boundaries; generic runtime availability adds no browser header or navigation
item.

Public root composition receives only `publicCampaignStateReader()`. That
reader is bound to `campaign-public-presentation/configured-campaign` and the
sanitized aggregate projection; it cannot read the private current setup,
immutable history, operation receipts, or audit records. Exact schema-4 public
presentation records remain readable without an aggregate lookup or write, and
only a fresh owner save emits the schema-5 aggregate policy. An exact delayed
retry of a pre-upgrade owner operation may replay its original closed schema-4
transaction only after matching immutable operation evidence; it cannot migrate
the projection or replace a newer campaign revision.
Owner reads use the separate atomic repository only after trusted owner
authorization. On the founder resource, authentication and subject/role
authorization also run before unsupported-method disclosure: anonymous callers
receive `401`, authenticated owner or foreign callers receive the generic `404`,
and only the authorized participant receives `405` with `Allow`. These rejected
methods do not enter browser-proof verification or replay storage.

Anonymous callers receive `401`; authenticated non-owners receive the generic
`404` surface before a private notification repository read. Audit
and notification availability use separate server-replaced renderer headers, so
browser-supplied headers cannot advertise either feature.

The manual-notification collection performs one bounded current-record list and
then reads the exact immutable terminal revision for every returned item. Strict
key, revision, and canonical snapshot equality must hold before projection. A
maximum 25-item page therefore performs exactly 25 direct record reads after one
list call; a shorter page performs one read per item. Missing, malformed,
crossed, duplicate, or current-only divergent terminal evidence returns the fixed
unavailable surface. Opaque continuation remains valid after Worker
reconstruction because neither integrity evidence nor cursor state is retained
in process memory.

The one shared mutation session is configured to the largest currently composed
form as an absolute ceiling and explicitly permits only the founder route's
repeated secondary-contribution field. Setup, editor, package, acknowledgment,
founder, and owner-notification adapters pass their own byte, field, and repeated-field limits to
every verification. Those limits are validated before form proof extraction, so
the larger setup allowance cannot widen another route. General one-use proofs
retain their version-1 encrypted cookie. A withdrawn founder resource instead
issues a version-2 one-use proof containing only a SHA-256 digest of its exact
route, withdrawal operation, and prior revision scope. A verifier without the
founder scope resolver rejects that cookie, and a changed scope cannot claim it.
The editor accepts at most 262,144 wire bytes and then enforces a 65,536-byte
decoded campaign presentation. Initial setup accepts at most 1,048,576 wire
bytes and then enforces a 262,144-byte decoded setup. Successful HTML and JSON
mutations clear the consumed cookie; every parser, readiness, or storage error
after successful verification clears the same cookie once. JSON responses that
advertise another action also issue a fresh encrypted proof. Owner notification
activity accepts at most 1,024 bytes and exactly two JSON feature fields or
those fields plus one form CSRF value. Invalid shape and body size fail before
replay claim. Hosted owner-notification composition uses persistent proof-claim
verification. A successful claim must return one valid cleanup instruction;
missing or malformed cleanup fails before activity persistence and cannot issue
a replacement proof. Exact repository retries after a lost response recover the
original immutable copy or sent fact and audit event only when the requested
result revision's transition introduced that operation evidence. A changed
expected revision cannot adopt a later activity revision; owner rotation,
changed work, stale revisions, and missing or corrupt history fail closed.
When the final allowed copy or sent transition makes a notification fully
terminal, the 97-character activity-operation ceiling keeps its versioned
operation-bearing evidence within the 128-character stable-ID boundary and
reconstructs one exact retry
action. The Worker uses `issueExactReplay` and the route's exact scope resolver,
binding the one-use proof to notification, activity, operation, and prior
revision; a changed or foreign request cannot consume it. Older evidence
formats remain readable without gaining this replay capability.

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
totals, the complete nested-plus-outer 551-read authorization envelope,
route-specific read cutoffs, cached ancestry and reconstruction recharge, exact
material gating, and narrowing-only route mutation limits.
Founder coverage adds configured-choice projection, create/retry/edit/stale/
independence, malformed and oversized hosted bodies, authentication-before-
method disclosure, equivalent HTML and hypermedia state/actions, and
reconstruction through a fresh Worker. One-shot hosted transaction races close
the phase or change country, declared interest, and deletion state after
create's final sample, and replace contribution choices after edit's final
sample; each check failure leaves every founder current, history, field,
policy-revision, audit, and founder-operation effect unchanged. Recovery with
the same overlapping operation after a null policy sample, exact replay after
campaign/profile evolution and Worker restart, and changed or stale rejection
are also covered. Hosted response-loss coverage additionally discards a
committed withdrawal response, obtains the replay-only action and scoped proof
from terminal HTML and JSON, and proves exact replay across Worker restart while
changed, stale, foreign, unrelated-method, and reused proofs remain rejected. The
synthetic hosted services implement and enforce the discovered AittaDB
read/list/transaction controls rather than bypassing the adapter. Source
and built-artifact scans complement `npm run instances:check`, which rejects
tracked runtime env files and active Sites bindings.
