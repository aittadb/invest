# Investor App Architecture

Investor App is a ChatGPT Sites application that uses an AittaDB-compatible backend as its authoritative storage and identity layer. The app owns investor workflow, legal-boundary enforcement, campaign configuration, private information-package behavior, owner operations, and participant-facing forms. The backend owns reusable identity, persistent storage, authorization, quotas, and bounded consistency primitives.

## Initial stack decision

The initial repository uses the Sites Vinext starter with React server components and a Cloudflare Worker-compatible build. Its tracked hosting example declares no D1 or R2 resource because production campaign data must stay behind the configured app storage adapter. A deployment can opt into a dedicated D1 binding solely for OAuth proof replay claims and closed verification evidence; that binding is not an alternative campaign-data store.

## Runtime boundary

Deployments provide trusted runtime configuration for the canonical app origin, configured identity provider, storage adapter, owner setup, sessions, and anti-forgery protection. Secrets are managed as runtime configuration, not as campaign content.

`APP_BASE_URL` is instance configuration, never a source default. The worker validates it as an HTTP(S) origin and replaces an internal request header before rendering metadata. When it is absent or invalid, the current request origin is used. This lets the same Investor App source serve unrelated deployments without inheriting another instance's hostname.

`OWNER_EMAIL` configures the single version-one owner for one deployment. The worker validates and overwrites the internal owner header, and every owner HTML or JSON request separately compares the trusted Sites identity email with that configured value. Anonymous requests enter Sites sign-in; authenticated non-owners receive a generic denial. A later persisted owner subject may replace the email bootstrap after the production identity adapter is available.

`CAMPAIGN_CONFIG_JSON` can supply the initial public campaign presentation when
no public presentation reader is injected. The worker validates its full
structure before exposing it to React or hypermedia rendering. Once a public
reader is injected, its published projection is authoritative for HTML,
metadata, and JSON; reader absence or failure does not fall back to a stale
bootstrap draft. The privileged owner setup repository is never used for public
reads. Absent, malformed, oversized, insecure, unpublished, or otherwise
unavailable configuration produces a generic public resource without leaking
draft copy.

The repository tracks only `.openai/hosting.example.json`. Each production, acceptance, or local deployment keeps its exact Sites project binding in ignored `.openai/hosting.json` state. Clean checkouts can build against the inert example, while Sites packaging explicitly requires an active binding.

### Injected AittaDB OAuth proof

`services/aittadb-oauth-proof.ts` is a Worker-compatible confidential Authorization Code and S256 PKCE boundary for a development connection proof. Issuer, client credentials, exact callback, allowed and requested storage scopes, AES-GCM cookie key, durable replay-claim store, closed result sink, fetch, clock, randomness, and lifetime are constructor inputs. The service discovers exact AittaDB endpoints before initiation and callback, bounds every protocol response, and validates introspection against AittaDB's active access-token claim contract. Credentials and transaction secrets never enter result metadata or exception causes.

`worker/routes/owner-oauth-proof.ts` owns `/owner/aittadb-connection` and its callback. The owner-only GET capability, CSRF-protected POST form, and hypermedia action share one domain resource; direct requests still enforce configured-owner identity, origin, session, and CSRF independently. Callback resources clear the host-only encrypted transaction cookie and never reflect query parameters. Anonymous and foreign callers are denied before discovery or credential exchange.

`http/owner-oauth-csrf-session.ts` is the injected anti-forgery primitive for OAuth initiation. It accepts a deployment-imported, non-extractable AES-GCM `CryptoKey`; it does not parse runtime configuration. HTML and JSON discovery each receive a random proof plus one encrypted cookie that is host-only, short-lived, and scoped to the owner connection path. Ciphertext and authenticated additional data bind the trusted owner subject, exact HTTPS application origin, cookie name, and path. The capability resolves that state into the generic browser mutation guard, which verifies the matching form field or JSON header before the route can call the OAuth service. Without the complete capability, the route omits initiation and direct mutation fails closed.

`worker/hosted-oauth-configuration.ts` parses the all-or-nothing deployment boundary and imports separate non-extractable cookie keys. `repositories/d1-oauth-proof-store.ts` owns the dedicated atomic replay claim and closed proof rows, and the build stages its migration only when the ignored active Sites binding declares D1. `worker/hosted-oauth-composition.ts` keeps the client secret inside the OAuth service closure and returns only the route service and CSRF capability. `worker/index.ts` installs that fail-closed resolver; `worker/application-worker.ts` advertises and dispatches the route only for a successfully resolved request-scoped deployment capability. Source and client-metadata validation are not hosted callback proof; the optional acceptance callback proof is deferred under `BACKLOG-019`. See `docs/AITTADB_OAUTH_PROOF.md`.

### Hosted AittaDB application runtime

`worker/hosted-application-configuration.ts` parses an independent,
all-or-nothing production storage configuration. It requires the exact app
origin, logical AittaDB issuer, same-issuer discovery resource, dedicated
service client, complete canonical storage scopes, and independent browser
mutation key. An optional backend transport origin changes only network routing.
The service-client credential remains inside a provider-construction closure;
the parsed object has no readable credential field.

`worker/hosted-application-composition.ts` caches one immutable runtime per
Sites environment, creates one service-token provider and bounded AittaDB
adapter, and closes that adapter inside `StorageApplicationRepositoryFactory`.
The factory has no generic builder or adapter accessor. It exposes only named,
narrow replay, atomic campaign/audit, and public campaign reader capabilities.
Both campaign capabilities keep their adapter authority in ECMAScript-private
state or a closed read function; reflection and serialization cannot recover a
generic `read`, `list`, `transact`, adapter, or storage surface. The returned
runtime contains only the repository factory, mutation session, and immutable
publication-readiness result, never a provider, adapter, configuration,
credential, key, or token. Token acquisition has an independent deadline and
clears failed renewal so a stalled request cannot poison the isolate.

`worker/index.ts` installs the resolver, and `worker/application-worker.ts`
resolves it without placing it in route context. Runtime availability has no
browser header or navigation control. It obtains the named campaign repository
and public reader centrally, injects setup and editor capabilities only into the
owner route group, and gives public composition only the separately persisted
published projection reader. The framework renderer receives only `ASSETS` and
`IMAGES`, never the secret-bearing Worker environment. Participant-state
readers remain explicit composition dependencies rather than runtime
environment fallbacks. Partial or malformed hosted configuration resolves to no
runtime and suppresses scalar campaign fallback when any hosted application
field was supplied. Publication stays closed unless exact deployment readiness
was configured. Local composition remains independent from live hosted proof.
See `docs/HOSTED_AITTADB_RUNTIME.md`.

## Resource representations

Application URLs identify resources rather than HTML-only pages. `Accept: text/html` selects the human interface. `Accept: application/vnd.aittadb-invest+json; version=0.1` selects the versioned hypermedia contract, and `application/json` is a compatibility representation. Representation selection never uses `User-Agent`.

Hypermedia documents contain `api_version`, resource `type`, `id`, `data`, semantic `links`, and currently available `actions`. An action declares its stable name, human title, method, target, request media type, and typed fields. An unavailable or unauthorized transition is omitted and remains independently rejected if submitted directly.

HTML links and forms and JSON links and actions must be projections of the same authorized domain resource. They share validation, mutation, error, and repository behavior. Explicit unsupported vendor-media versions return `406 Not Acceptable`, and negotiated responses include `Vary: Accept`. OAuth/OIDC endpoints retain their standards-defined response formats where a hypermedia envelope would break interoperability.

The public campaign resource is the signed-out base state. A valid participant session may extend it with private-package and self-service controls. Owner controls require a separate owner authorization decision; ordinary sign-in never implies ownership.

`domain/participant-home-resource.ts` binds a narrow profile and current-package
projection to the case-sensitive subject parsed from the trusted session.
`services/participant-access.ts` composes only the subject-bound participant,
package, and acknowledgment read contracts; it does not accept identity,
campaign, owner, hostname, or package state from browser input. Missing state,
foreign subjects, malformed projections, and reader failures fail closed before
private capabilities are constructed.

The Worker makes that authorization decision once for a request. JSON routes
consume the authorized projection directly. HTML rendering receives the same
bounded projection through an internal header that the Worker always deletes or
replaces, then React rechecks its subject against the trusted rendered session.
The header carries participant-home and package-status data only, never package
Markdown, credentials, notes, or unrelated participant records. `/participant`
and `/participant/package` independently negotiate and enforce access; an
advertised root control is not itself an authorization grant.

### Action capability contracts

`domain/hypermedia-action.ts` is the route-independent source for safe navigation and mutation capabilities. Definitions use bounded stable names, safe targets, explicit methods and request media types, and bounded string, integer, boolean, choice, or structured JSON fields. Sensitive fields cannot advertise a current or default value. An availability gate constructs an action only when the current caller and resource state permit its transition, but target routes must still enforce authorization and state independently.

Hypermedia and form models project from the same validated action. A form-compatible `GET` uses query fields; a mutation uses body fields and form encoding. Native forms submit `POST` with an explicit effective-method field when the semantic method is `PUT`, `PATCH`, or `DELETE`. JSON-only, path-driven, or header-driven actions remain valid hypermedia controls but cannot be projected as native forms. Route implementations must support the advertised encodings and normalize any form method before invoking the same security, validation, and domain operation.

### Browser mutation boundary

`http/mutation-security.ts` is a generic precondition guard for session-authenticated browser mutations. Identity enters only through an injected trusted session resolver; request headers and body fields cannot assert a participant or owner. The guard validates the trusted subject and session expiry, requires an exact deployment-configured `Origin`, checks an expiring random CSRF token against its server-held SHA-256 hash in constant time, and reads JSON or form bodies incrementally under configured byte and field limits.

The result contains only the verified actor, normalized mutation method, media type, and parsed body. A form-encoded `POST` may carry the shared effective-method field for `PUT`, `PATCH`, or `DELETE`; JSON uses the actual HTTP method. Hidden transport fields are removed before feature parsing. Fixed public errors never include identity, token, origin, submitted fields, or internal causes. The owning route must still enforce role, resource ownership, lifecycle, input schema, revision, idempotency, and audit rules.

### Modular route dispatch

The Worker normalizes trusted runtime configuration and identity once, then passes a narrow request context through independently composed public, participant, and owner route groups. `worker/request-capability-composition.ts` binds the already-resolved request-scoped dependencies to one typed route dispatcher and renderer capability projection. It never derives authority from browser headers: an unavailable dependency remains unavailable, and route-specific mutation limits and replay rules stay with their owning route dependency. Each handler either returns the complete response for a resource it owns or returns `null` without changing sibling state. Shared representation helpers own only response serialization and headers; feature authorization and projection remain inside the owning route group and its domain services.

Participant resources compose inside the participant group, and owner resources compose inside the owner group. Adding a resource therefore changes its owning group without requiring edits to a sibling handler. Image optimization remains outside application-resource dispatch, while unmatched requests continue to the framework renderer with the same normalized runtime headers.

## Domain modules

The specification expects these narrow boundaries:

- `IdentityProvider`
- `CampaignRepository`
- `ContentRepository`
- `ParticipantRepository`
- `FounderApplicationRepository`
- `IndicationRepository`
- `AggregateRepository`
- `AcknowledgmentRepository`
- `AuditRepository`
- `NotificationRepository`
- `StorageAdapter`

Domain logic should depend on these interfaces instead of framework request objects or AittaDB HTTP details.

### Parallel development boundaries

Each domain and repository lane owns a narrow contract, implementation, contract tests, and documentation. A sibling repository must not import another sibling's concrete implementation. Cross-lane behavior is coordinated through small domain projections or application services, so package, participant, founder, indication, aggregate, audit, and campaign work can be developed and tested independently until a use case intentionally composes them.

The generic `StorageAdapter` supplies bounded persistence primitives; it must not become a feature-level service locator. Repository contract suites run against deterministic fakes and production adapters alike. A PLAN dependency is therefore required only when a task consumes another task's public contract, implementation, or live proof, not merely because both tasks will eventually participate in the same workflow.

### Shared foundation

`domain/foundation.ts` is the framework-independent boundary for values shared by later contracts. It provides branded integer minor units, canonical UTC timestamps, bounded stable identifiers, case-sensitive identity subjects, normalized two-letter country codes, structured validation results, and fixed-message public error mapping.

Money constructors reject floating-point, unsafe-integer, negative, and configured out-of-range values. Country parsing uppercases and trims by default and accepts an injectable normalization hook; campaign eligibility remains a separate campaign rule. Authorization failures for inaccessible records map to the same public response as missing records, and unknown failures map to a generic response without serializing causes.

### Package versions and acknowledgment

`domain/package-content.ts` parses package Markdown into a syntax tree and rejects raw HTML and unsafe link or image protocols before content becomes renderable. Package versions clone and freeze ordered sections, hash only canonical reader content and acknowledgment text, and keep save metadata outside that content hash.

The first version requires acceptance. A material version replaces the required acceptance hash; a non-material version inherits the preceding requirement. This propagation prevents a later editorial save from bypassing an earlier material version that a participant has not accepted. Acceptance records derive version and hash evidence from the trusted snapshot rather than client input.

`RepositoryOwnerPackageWorkspaceService` is the narrow owner application service over `PackageVersionRepository`. It accepts a trusted owner subject, derives version and section identifiers from the retry-stable operation ID, supplies the server timestamp, applies create, edit, availability, reorder, and acknowledgment transitions to the current immutable snapshot, and delegates package validation and compare-and-set persistence to the repository. Browser input cannot choose package identifiers, timestamps, hashes, or actor attribution.

Before it stages package content, the repository creates an immutable operation intent keyed by the retry-stable owner operation ID. The intent binds audited owner or explicit unaudited mode, actor, expected owner revision, supplied-versus-computed mutation fingerprint, prior package and gate state, the first validated server timestamp, and a digest of the complete normalized mutation, including publication metadata and every section. A retry must match that intent before any further staging. Retry drafts pass a closed, exact-key, data-only object and array validation before the persisted timestamp replaces a later clock reading; unknown fields, accessors, custom prototypes, and decorated arrays fail without being evaluated or staged. All owner-controlled fields remain fingerprinted and hash-bound. An identical delayed retry reconstructs the original work after repository or Worker reconstruction, while changed actor, revision, fingerprint mode or value, metadata, or content conflicts. New operations still require the current head revision, and intent metadata never enters the public package model.

The owner route group receives the workspace service, browser mutation guard, session CSRF token provider, and operation-ID issuer as one injected capability. Production composition narrows owner package requests to 524,288 bytes, nine non-repeated fields, and the maximum domain-valid URL-encoded Unicode form even when another owner workflow configures a larger session ceiling. A route may only narrow the shared body, field-count, and repeated-field limits; an invalid or wider route policy fails before CSRF proof parsing or durable replay claim. Oversized or over-field requests likewise leave the proof available for a corrected request. No process-memory repository is installed by the production Worker entry point. When the capability is present, the Worker supplies a replaced internal availability header to React and advertises the owner-home navigation; the header affects presentation only and is never an authorization boundary.

`domain/owner-package-resource.ts` constructs one action-capability model for both owner forms and nested hypermedia controls at `/owner/package`. The preview resource at `/owner/package/preview` reads the same authorized snapshot and renders branded safe Markdown through an AST-to-HTML allowlist that cannot emit raw Markdown HTML. Both resources are private, non-cacheable, content-negotiated, and independently enforce configured-owner access.

### Package persistence repositories

`StoragePackageVersionRepository` and `StorageAcknowledgmentRepository` are the production-neutral package repositories over a credential-bound `StorageAdapter`; they retain no local state. The `InMemoryPackageVersionRepository` and `InMemoryAcknowledgmentRepository` names remain compatibility subclasses for deterministic fixtures, not separate persistence implementations.

After the immutable operation intent exists, package writes stage immutable per-version section manifests and bounded Markdown chunk records through retry-stable one-record transactions. The compact version record references those private records rather than inlining all section content. Only a final atomic transaction creates the version manifest, compare-and-set advances the owner-visible package head and a separate package-current gate, and appends the closed owner audit event. Failed staging or final publication leaves section records unreachable. Exact retries and fresh repository construction recover completed stages only when they match the intent, without exposing a partial version.

Every stored intent, manifest, head, gate, section, chunk, acceptance, and acceptance head is checked for its exact requested key, envelope, closed schema, kind, revision rules, identifier ordering, count bounds, and per-record byte limit. Section Markdown is cumulatively bounded before allocation or concatenation. Package reconstruction has a hard ceiling of 32 reachable versions and 512 package records, with one bounded visited set; publication refuses a version whose resulting current projection would exceed either ceiling. Over-limit, cyclic, malformed, or oversized backend state therefore fails closed without an unbounded ancestry walk. Every intent, staging, final publication, and acknowledgment transaction result is also checked positionally for an exact replay boolean, record count, key, revision, value, and prepared audit evidence.

The package-current gate binds the exact current version and required-acceptance hash and advances on editorial as well as material versions. The read-side `StorageAcknowledgmentRepository.currentAcceptanceStatus` method samples the exact gate before and after reading the latest acknowledgment and returns a bounded gate revision, version ID, content hash, required-acceptance hash, and boolean only for matching samples. The participant authorization service requires the returned version and hashes to match both of its stable current-package samples; an internally valid stale gate cannot authorize a newer head. A small bounded retry handles a concurrent publication, while continuing movement or mismatched evidence fails closed. The boolean `requiresCurrentAcceptance` method is a convenience projection of the same evidence-bearing read. The acknowledgment route instead performs one current-package/latest-acknowledgment/current-package attempt and fails its precondition if those package reads differ. Acceptance atomically creates immutable subject evidence, advances the subject acknowledgment head, and compare-and-set writes the unchanged gate value. A concurrent owner publish therefore invalidates a stale acceptance transaction, while an acknowledgment does not change the owner-visible package-head revision. Private persistence metadata retains each successful version or acceptance transaction's original expected gate revision so exact replay reconstructs the original adapter fingerprint after later gate changes.

`domain/participant-package-resource.ts` and `worker/routes/participant-package-reader.ts` project that current version into the registered-reader `/participant/package` resource. Trusted actor and participant subjects must match before an injected subject-scoped repository is read. The route revalidates metadata, unique contiguous section order, and Markdown, then exposes only enabled non-empty sections through equivalent private HTML and versioned hypermedia JSON. Section-count pagination takes the largest prefix inside a finite source-byte ceiling and continues with visible-section cursors. Disabled drafts, hashes, repository details, and participant identity never enter the projection. Hosted composition supplies both the persistent participant-access authority and the subject-bound AittaDB package reader inside the participant route group. Missing, owner, foreign, malformed, and unregistered identities remain unavailable without opening package content.

Acknowledgment records are keyed to the authenticated participant subject through a one-way storage identifier. The caller cannot provide the stored subject, content hash, or required-acceptance hash; those values derive from the trusted package snapshot. New evidence accepts only the current version, while idempotent retries may re-read their original immutable version. Missing identity, foreign records, denied grants, and absent records remain non-disclosing through the credential-bound adapter.

`domain/participant-package-acknowledgment-resource.ts` and `worker/routes/participant-package-acknowledgment.ts` expose that boundary as `/participant/package/acknowledgment`. One validated state model drives the private HTML form and versioned hypermedia action. The browser submits only a server-issued operation ID; the trusted participant, current immutable package, acceptance hashes, timestamp, and compare-and-set revision come from request-scoped services. Material package versions reopen the action, editorial versions retain the prior requirement, and a satisfied resource issues neither an operation ID nor a CSRF proof. Hosted composition installs the subject-bound AittaDB repositories and route handler only after the same persistent participant-access boundary authorizes the account.

### Participant profile and consent

`domain/participant-profile.ts` keeps the authenticated subject and account-email label identity-bound while exposing an explicit policy for participant-editable, registration-only, withdraw-only, request-only, and system-managed fields. Required process messages are independent from optional marketing consent. The exact notice version and text snapshots acknowledged at registration are one immutable registration-only profile field and cannot be replaced through self-service.

An account-deletion request records intent but does not call indication or founder repositories. It emits a retry-stable withdrawal intent for an application service to coordinate across those separate lanes.

### Participant access-registration resource

`domain/participant-registration-notice-evidence.ts` binds the exact persisted campaign-setup revision to its bounded process-email and optional-marketing notice snapshots. `domain/participant-registration-resource.ts` projects that evidence, the signed-in account, and the current participant profile into one HTML and versioned hypermedia capability model at `/participant/registration`. The provider email is display-only, subject and email never become action fields, and required process notice text remains independent from optional marketing consent. A registration action includes the server-derived evidence version and a closed 58-byte lowercase UUIDv4 operation ID as hidden fields. Registered HTML and JSON instead expose the profile's actually acknowledged evidence and process-acknowledgment state, with no mutation action or proof. `worker/routes/participant-registration.ts` accepts a request-scoped `ParticipantRegistrationRepository` factory, browser mutation guard, actor-bound CSRF provider, operation-ID issuer, clock, and server-derived evidence; it installs no global repository.

An available registration action requires a validated CSRF proof before either representation is returned. HTML carries the token only in its hidden transport field, while JSON carries it only in `MUTATION_CSRF_HEADER`; a hosted proof's cookie is emitted only through `Set-Cookie`, and actionless registered resources emit neither. The route accepts a narrow verifier compatible with a deployment wrapper around `BrowserMutationSession.verifyMutation()` while retaining its injected compatibility guard for isolated tests. Exported 2 KiB and nine-field limits include the form proof transport and disallow repeated fields. Hosted verification applies the route's operation-ID predicate before claiming replay authority, while route parsing repeats it before repository access. The ID remains independent of one proof so an exact committed retry can use a fresh proof. Once verification returns, its required valid expiration cookie is attached exactly once to success or any later fixed failure; pre-verification failures attach none. The route enforces participant rather than owner authority, trusted actor/account equality, exact resource origin, exact fields, and fixed non-disclosing errors. A stale evidence version can invoke only immutable-history recovery; it cannot reach a participant transaction. Public HTML loads its route-specific stylesheet from the same origin under a `style-src 'self'` policy.

Hosted Worker composition installs the mutation route only for its exact path and a signed-in non-owner; it resolves the same dependency for `/participant` only when the trusted reader explicitly reports no profile and the persisted campaign is published and open. Reader failures, malformed or identity-mismatched projections, and closed or unpublished campaigns remain generically unavailable. Existing registered resources and exact immutable operation recovery remain readable after closure, but no current-evidence request may create a new record. The route maps the persisted campaign revision and only `campaignPolicy.notices.processEmail` and `marketingConsent` into closed evidence, binds a fresh `StorageParticipantRepository` to the same trusted account, and wraps the shared hosted browser mutation session with the route's narrower limits. Anonymous and owner requests do not open private registration setup or profile storage. The runtime, factory, full campaign policy, adapter, and credential remain outside route context and renderer inputs.

The signed-out published open campaign's registration actions return from ChatGPT sign-in to `/participant`. When the trusted participant projection is explicitly absent, hosted composition resolves registration evidence for that entry without opening package or acknowledgment state. HTML returns a non-cacheable `303` to `/participant/registration`; versioned JSON returns a `participant-entry` document whose sole registration action has the same target. Once registration commits, a new `/participant` request reconstructs profile, current package, and acknowledgment state from persistence before exposing package, profile, founder, or investment controls. It carries no authority forward from the registration response. A deletion-requested entry retains only its currently permitted package, profile-view, and sign-out controls; founder and investment actions are absent.

### Participant profile self-service

`domain/participant-profile-resource.ts` and `worker/routes/participant-profile.ts` project `/participant/profile` from a subject-bound profile and the trusted current-package acknowledgment status. HTML and hypermedia expose separate actions for the four editable declaration fields, optional marketing-consent withdrawal, and an account-deletion request. Identity, provider email, process acknowledgment, consent grant, deletion state, registration time, and update time remain read-only. A deletion request closes profile edits without preventing an independent outstanding marketing withdrawal.

For an authorized `/participant` request, the Worker also derives one profile-self-service availability signal from the same request-scoped repository. Hypermedia emits `participant-profile` linkage and an `open-participant-profile` action; React receives only a server-replaced availability header and renders the equivalent link. Deletion-requested state labels that action as a profile view. Neither signal can authorize the profile route, which repeats its subject, email, owner, and persistent-state checks.

Every current stored profile is fully revalidated before clocks, operation IDs, CSRF issuance, or a repository mutation can run. Each action carries its own retry-stable operation ID and exact expected revision, and the route delegates compare-and-set history to the subject-bound participant repository. A concurrent exact loser performs one bounded recovery with the winner's persisted timestamp; changed retries and stale operations retain their fixed conflict and precondition results. Descendant checks preserve immutable transition timestamps, including the exact withdrawal timestamp for a one-revision withdrawal-only projection. Completed withdraw-only and request-only transitions disappear from both representations.

Hosted Worker composition installs the profile route only on its exact path for a signed-in non-owner whose already-resolved participant-access projection matches the trusted subject and provider email. It obtains that account's mutation-capable repository from the same finite participant request scope and wraps `BrowserMutationSession` with route-owned per-method body and field limits and no repeated form fields. Proof cookies are emitted only in headers, and a verified proof is expired exactly once on success or any later failure. The existing participant projection is reused for route composition rather than resolved a second time; runtime, adapter, factory, credentials, and private campaign policy remain outside route context and output.

### Participant storage repository

`StorageParticipantRepository` is the production-neutral, subject-bound profile repository over `StorageAdapter`. The compatibility export `DevelopmentInMemoryParticipantRepository` names the same implementation for existing local fixtures. Actor-subject parsing rejects unpaired UTF-16 surrogates while preserving valid supplementary-code-point pairs before any subject-derived identifier is computed. Every current and immutable-history key derives from the trusted authenticated subject through a one-way identifier. Registration takes identity-bound account fields only from that trusted account. Exact notice snapshots live inside those profile records rather than in identity-bearing notice keys. Later mutations call the participant field-policy domain operations, so profile edits cannot replace subject, account email label, registration notice evidence, process acknowledgment, consent state, deletion state, or system timestamps.

Each write atomically compare-and-sets the current profile and creates the exact immutable subject revision under one operation ID. The application factory attaches one narrow registration-only provisioning capability: first registration adds the immutable empty investment-ownership root, empty index, and empty completeness summary to that same transaction, producing five ordered records or none. Low-level profile repositories used after registration retain their independent two-record boundary and cannot initialize ownership. Before an edit, marketing withdrawal, or deletion request can transact, the repository validates the current record and its equality with the expected immutable revision. Every current profile later than revision 1 also performs one exact read of immutable revision 1 and requires its registration notice evidence to match that anchor. If a prior attempt committed but its response was lost, only the exact next immutable revision with the same operation, action, request hash, and value can reach the adapter replay; changed reuse and ordinary stale requests fail before another transaction. For first registration, the request hash covers the participant submission and complete notice evidence while the server-generated timestamp remains result metadata. A concurrent exact loser validates the immutable first revision and returns its original timestamp as a replay; a changed operation, submission, or evidence conflicts. Registration replay and stale-policy recovery also authenticate the initialization operation against the immutable ownership root and revalidate the complete bounded current ownership set, so valid later indication activity preserves the original registration result while missing or corrupt ownership fails closed. Replays return their original snapshot and notice texts across repository reconstruction.

Each notice snapshot is bounded to 4,000 UTF-16 code units and 12,000 UTF-8 bytes. Stored profile documents are bounded to 30,000 UTF-8 bytes, 64 JSON nodes, and eight nested levels, below the 65,536-byte production record ceiling. Both the low-level two-record profile request and the application five-record registration request are bounded to 64,512 bytes before a reserved 1,024-byte protocol-envelope allowance, and complete wire commands are tested below 65,536 bytes; the adapter still enforces advertised deployment limits. Reads and transaction results accept only closed, plain data records with exact keys, revisions, values, record order, result count, and boolean replay evidence; prototypes, accessors, sparse arrays, malformed records, and backend causes fail through fixed storage errors. Accessor descriptors are inspected without invoking their getters. Current and history records, including notice evidence, are revalidated against the repository's trusted subject and expected revision before use.

A deletion request persists only its existing request state and exposes a separate application-level withdrawal intent; the repository does not import or mutate indication or founder storage. Anonymous, owner-without-profile, foreign, denied, and missing records retain the same non-disclosing shapes. Hosted composition installs fresh subject-bound instances behind participant access, access registration, and profile self-service.

### Persistent participant access projection

`services/participant-access.ts` combines one subject-bound profile, current package, and evidence-bearing current-acceptance result into the narrow authorization state consumed by the Worker. Each profile, package, and acceptance sample is validated, bounded, and detached before another asynchronous read. The service requires the acceptance version and both hashes to match both stable package samples, permits one bounded retry for a concurrent profile or package change, and fails closed on stale gate evidence or continuing movement. A missing profile returns before package or acknowledgment storage is read.

`StorageApplicationRepositoryFactory.participantRequest(account)` creates one fresh account-bound repository scope for each signed-in non-owner HTTP request. The Worker creates that scope before authorization and captures the same scope in the selected participant profile, package, acknowledgment, or founder route. Configured owners, unrelated subjects, and a second HTTP request cannot reuse its repositories. The complete runtime and credential-bound factory stay outside route context and renderer inputs.

The scope owns one 2,855-record participant-private request ceiling. A maximum valid authorization consumes at most 551 reads: 511 unique immutable package records plus two outer attempts, each with six profile reads, two package-head reads, and three accepted gate attempts of four mutable reads. The six profile reads include current, matching latest history, and immutable registration revision 1 for each of the two profile samples. Route selection adds a separate capability-owned ceiling: package uses one read, acknowledgment eight, profile 23, investment 2,304, and founder 1,063. The founder allowance is conservatively derived from five maximum 209-read application materializations, four retry/recovery reads, and two maximum seven-read campaign setup materializations. It covers state discovery, mutation metadata, one post-policy immutable-history recovery, final campaign and profile policy sampling, a conflicted repository retry, and the returned projection at the full bounded history and chunk ancestry. The investment allowance covers the 2,240-read maximum current-summary collection plus current campaign, participant, package, and acknowledgment policy sampling. Collection summaries verify current and terminal evidence, current fields, active leases, and the complete revision-one creation operation and fields without reconstructing intermediate immutable revisions; individual item reads still verify full ancestry. Once a selected route performs its first read, the request cannot switch to another route allowance. The global ceiling is the authorization maximum plus the largest route maximum, so read 2,856 fails before reaching the credential-bound adapter even if an internal path violates its smaller route cap. Public campaign-presentation reads and adapter transactions are separate operations, but both private campaign samples and every profile, package, gate, acceptance-head, acceptance-record, notice-anchor, founder-application, investment-indication, and participant-route record read share these counters.

The scope also owns one package reader with at most 64 verified immutable reconstruction entries. Each entry retains its complete version-ID ancestry and logical reconstruction-read charge. A cache hit checks the combined ancestry, rejects lineage overlap, and recharges the fresh 32-version and 512-record reconstruction context exactly as an uncached subtree would, while avoiding repeated physical reads. Mutable profile, package-head, acceptance-head, and gate records are always resampled. The cached reader uses an adapter whose list and transaction methods fail closed. Acknowledgment mutation uses a separate transaction-capable adapter that shares the same read counter and trusted cached package binding, so the cache itself has no mutation authority. Neither adapter, budget, nor cache survives its HTTP request.

### Founder applications

`domain/founder-application.ts` validates founder fields against deployment-supplied contribution choices and records received or withdrawn state as immutable transitions. Create, edit, and withdrawal transitions are scoped to the applicant subject, while owner review remains a separate use case.

Founder applications do not import, create, mutate, or gate investment indications. An account may therefore hold either record type or both, and application services compose them only when a participant-facing resource needs both projections.

### Persistent founder repository

`StorageFounderApplicationRepository` binds current and history storage keys to the trusted applicant subject and composes through a supplied `StorageAdapter`. Hosted runtime composition supplies only the credential-closed AittaDB adapter; `DevelopmentInMemoryFounderApplicationRepository` remains a compatibility export for deterministic fixtures. Create, edit, and withdrawal call the founder domain transitions with deployment-supplied contribution choices. The subject is never accepted from mutation input, and foreign, anonymous, denied, and missing records remain observationally equivalent.

Each mutation atomically compare-and-sets a compact current record and creates one immutable transition record. A hosted create or edit also creates a revision-owned chunked fields payload and immutable policy-revision receipt, then checks the exact current campaign-setup revision sampled for that write in the same transaction. Create additionally checks the exact current participant-profile revision that supplied country, declared-interest, and deletion-state eligibility. A phase, publication, contribution-choice, or creation-eligibility profile update after the final sample therefore rolls back current, history, field, and policy writes together. Withdrawal has no policy check. After the original create transaction succeeds, the repository provisions one dedicated founder-review lookup through a separate deterministic one-record transaction before returning. This preserves the established create-operation fingerprint for callers and stored retry receipts that predate the lookup; a lost lookup-transaction response is recovered by reading and validating the committed record, and an exact retry replays the same lookup operation. No record contains a cumulative application or history snapshot. Raw chunks are at most 45,000 bytes and every encoded record is checked against the 65,536-byte hosted bound; a hosted create uses at most 17 ordered transaction entries, edit at most 16, and either at most 1,048,576 serialized bytes. History is capped at 16 transitions, with the final transition reserved for withdrawal, so ancestry reads and response size have an explicit finite ceiling while persisted growth remains linear.

Reads reconstruct the application by replaying the bounded transition ancestry. Every transition, field reference, chunk hash, operation fingerprint, key, and storage revision is checked before use. Each create or edit payload persists the contribution-choice IDs that validated that transition, and its policy receipt preserves the checked campaign revision needed to reconstruct the identical adapter command. New create receipts also preserve the checked participant-profile revision; legacy and campaign-only edit receipts remain closed and backward-readable. Historical reads and exact retries therefore retain their original semantics after campaign or profile evolution and across Worker restart, while a new create or edit is validated only against current state. The adapter resolves an exact operation replay before re-evaluating its now-stale checks; changed operation reuse still conflicts. The repository has no investment-indication import or side effect.

`StorageFounderApplicationReviewCollectionRepository` reads one persistent current-record page through the same credential-bound adapter. A page contains at most 25 applications and requires exactly one bounded list plus one immutable terminal-transition read, no more than 12 current-field chunk reads, and one dedicated review-lookup read per item, for a 350-record-read ceiling. It binds each current record's operation, lifecycle, timestamps, and field reference to that terminal transition, then verifies the hashed current key, revision, chunk envelope, payload hash, stored contribution choice, and lookup coordinates before projecting an allowlisted summary. The established one-way review ID is the SHA-256 identity of the trusted applicant subject and internal application ID in its own domain; it is stable across current-record storage-key changes and is not that current key. Its digest addresses only a dedicated private lookup record that retains the trusted coordinates. The summary contains only the review ID, lifecycle status, primary contribution area, update timestamp, and revision; it contains no applicant subject, application ID, private note, profile link, or history.

Collection paging preserves only the AittaDB bounded-storage continuation cursor. That protocol binds the cursor to the credential namespace, collection, and page parameters and guarantees that page state contains no principal, namespace, physical key, or authorization-policy detail. The application additionally rejects missing page-size bindings, duplicate or unknown query fields, control characters, values above 2,048 characters, repeated continuations, empty continuation pages, malformed records, and adapter causes. It never logs a cursor or application value. A cursor returned before a Worker restart remains usable by a new repository over the same persistent backend.

`StorageFounderApplicationReviewDetailRepository` is a separate direct-read port. It accepts only the established one-way review identifier, reads exactly its dedicated private lookup record, derives the current-record key server-side from the verified coordinates, and never lists applications or accepts an applicant subject. A valid detail reconstructs and verifies the complete bounded immutable transition and field ancestry using at most 210 record reads, including the lookup. Missing identifiers require one lookup read; malformed identifiers require none. Crossed lookups or keys, altered or missing current state, missing history, hostile revision counts, changed chunks, and adapter causes fail closed without returning a subject or private value.

`StorageFounderApplicationReviewLookupBackfillRepository` is the backend-only compatibility boundary for an application created before lookup indexing. Given trusted private coordinates, it first reconstructs and verifies the complete current and immutable ancestry, then creates or exactly replays the same deterministic lookup transaction within a 210-read ceiling and without listing. Collection reads require the matching lookup and fail closed when it is absent or corrupt, so existing records must be backfilled before enabling their owner detail transition. Browser GET routes never write or backfill lookup state.

The configured-owner route group projects the collection and detail resources into equivalent HTML or hypermedia JSON at `/owner/founder-applications` and `/owner/founder-applications/{review-id}`. The collection and detail ports remain independently composable; when both are present, collection items advertise their real detail links and detail resources link back to the collection. Either independently composed resource omits transitions to the unavailable sibling. Professional profile URL values have representation parity: JSON returns the validated URLs, while HTML escapes the same values for text and attributes, marks links `noreferrer`, and sends `Referrer-Policy: no-referrer`. Anonymous requests receive authentication-required without private data, every authenticated non-owner receives the same not-found surface before founder-application access, and the owner home advertises review only when the collection capability exists. Invalid request URLs are not reflected into errors.

`DevelopmentInMemoryFounderApplicationReviewRepository` retains a combined deterministic collection-and-detail fixture for tests. Hosted composition uses the two narrower persistent capabilities over the credential-closed adapter.

### Participant founder-interest resource

`/participant/founder-interest` projects one participant-bound founder application as HTML or versioned hypermedia JSON from a shared capability model. The model exposes create only when injected campaign policy permits it, edit while current choices can describe a new revision and the edit budget remains, and withdrawal while the reserved final transition remains. After withdrawal it exposes only an exact replay action reconstructed from the verified final history operation and prior revision. That action cannot create another transition. It publishes no subject or storage identifier. Both representations include the same current fields, immutable history, and actions.

`worker/founder-interest-service.ts` is a narrow, framework-independent orchestration boundary over `FounderApplicationRepository`. A request-scoped factory supplies the trusted actor, subject-bound base repository, policy-bound create and edit repository providers, opaque application identifier, contribution choices, campaign creation policy, and clock. Operation IDs become retry-stable history IDs; when a response is retried, the service recovers the original timestamp from immutable history and uses the base repository to reconstruct the stored policy receipt instead of resampling policy or relying on process memory. If a create or edit policy provider rejects its final sample, one bounded application-history materialization runs before the precondition failure so an overlapping exact operation that committed first can replay; changed reuse and a new or stale operation still fail. Existing applications remain readable and withdrawable even when creation policy is closed or temporarily irrelevant.

`worker/routes/founder-interest.ts` owns content negotiation, strict request-field allowlists, and response projection. After successful representation negotiation, it authenticates the context subject and obtains that subject's authorized service before disclosing supported methods. Anonymous `PUT` therefore receives authentication-required, inaccessible owner or foreign `PUT` receives the same not-found surface, and only an authorized participant receives `405` plus `Allow`; none consumes mutation proof. Supported mutations then pass through the shared same-origin, CSRF, body-bound, and trusted-session guard before feature parsing. A terminal withdrawal replay receives a separate one-use proof scoped to this route, `DELETE`, the immutable withdrawal operation, and its exact prior revision. The shared verifier rejects that proof on unrelated routes and rejects a changed scope before replay claim. Storage failures map to fixed public HTML and JSON errors, while inaccessible foreign and missing state remain non-disclosing.

Hosted composition derives the `/participant` founder capability from authorized active profile access and campaign configuration without reading a founder application. At the exact founder path it always installs an intentional negotiated surface when hosted runtime is available: anonymous requests receive authentication-required and unauthorized authenticated requests receive non-disclosing not-found. For a permitted founder or combined profile it creates a fresh subject-bound campaign/profile/application scope through `StorageApplicationRepositoryFactory`. Creation resamples publication, phase, country, profile, and unchanged choices immediately before selecting a repository bound to both the campaign and participant-profile revisions; edit resamples unchanged current choices before selecting a repository bound to the campaign revision. The transaction's current-record checks close races after either final sample. A null final policy sample receives one bounded application-history materialization before rejection, allowing an overlapping exact create or edit that already committed to use its stored receipt while a changed, new, or stale request still fails. Existing applications remain readable and withdrawable after phase closure or contribution-choice evolution, and remain editable when current choices and the bounded edit budget permit it. Exact retries use their immutable policy receipt and remain valid after campaign or profile evolution; withdrawal remains policy-independent. After a lost withdrawal response, a terminal GET issues a fresh actor-bound proof containing only the encrypted digest of the exact replay scope; it grants no create, edit, profile, or other route capability and remains one-use across Worker reconstruction. Founder transactions leave investment indications and aggregates independent. Hosted HTML and hypermedia are projected from the same reconstructed state and action model. Oversized requests fail before replay claim and can reuse their proof after correction; malformed bounded requests consume and expire the claimed one-use proof while changing no founder record.

### Investment indications

`domain/investment-indication.ts` defines personal and company indication records as framework-independent immutable revisions. Currency and amount boundaries come from deployment configuration, while package acceptance comes from the trusted current package and acknowledgment repository; neither can be supplied as an authoritative client field. Company uniqueness uses normalized registration country and an injectable country-aware identifier normalizer, and occupied keys return only a fixed conflict.

Participants can edit or withdraw active indications and reactivate withdrawn indications after satisfying the current package requirement. The configured owner can reject an active indication with a bounded participant-visible reason. History is capped at 16 revisions, and the final revision is reserved for withdrawal or owner rejection so the bound cannot strand an active indication. Participant capability projections include only transitions valid in the current lifecycle without exposing owner identity.

`DevelopmentInMemoryIndicationRepository` is the compatibility name for the subject-bound `StorageAdapter` repository used by both deterministic tests and production composition. One atomic transaction compare-and-sets bounded current metadata, creates one immutable transition plus versioned field chunks, acquires or releases a hashed active-uniqueness lease, and advances a subject-keyed ownership summary containing at most 100 sorted opaque indication ID, revision, and lifecycle-status entries. Current and transition records never embed a cumulative snapshot. Personal and normalized company uniqueness values never appear in storage keys or public errors.

`storage-indication-read-codec.ts` owns the schema-5, read-only indication persistence boundary. It accepts only `Pick<StorageAdapter, "read">` and verifies canonical current, transition, field-chunk, and active-lease records before returning typed values. Key derivation and exact structural validation live with that boundary so owner and participant read paths use the same fail-closed storage interpretation without receiving mutation or ownership authority.

The persistent participant coordinator allows at most four active owned indications across personal and company records. An immutable subject-keyed root distinguishes explicitly initialized ownership metadata from correlated absence. The trusted initialization/migration function atomically creates the root, index, and summary from a complete sorted inventory only after each entry matches its exact subject-bound current and terminal records; it rejects changed retries and inventories with more than four active records. An exact retry is recognized from immutable root evidence and returns its original initialization result after later valid lifecycle activity, while independently validating that the current root, index, summary, and ownership heads remain complete and stable. Ordinary participant access never initializes from absence. An absent root, index, or summary, an omitted or crossed ID, a revision or lifecycle mismatch, continuing concurrent movement, malformed storage, or pre-existing over-capacity fails closed. Legacy ID-only witness data can enter the new contract only through explicit migration.

First persistent registration now composes authoritative empty ownership initialization into the same transaction. Conditional `BACKLOG-011` retains the backend-only complete-inventory migration for participants created before that contract. Hosted investment composition must remain unavailable for a legacy population until that migration is rescheduled and complete; a fresh MVP namespace has no migration prerequisite.

For each accepted capacity snapshot, root, summary, and index reads precede two compact head reads per owned ID: current metadata and the immutable terminal transition. The terminal operation evidence independently authenticates every active and non-active lifecycle transition. Schema-5 create and edit fingerprints commit the normalized field reference, including its content hash. For each of at most four active heads, the proof loads only the one-to-eight current field chunks, verifies that commitment, derives the normalized personal or company uniqueness scope, and requires the exact active lease; non-active heads load neither fields nor leases. A final summary read proves stability. Capacity therefore uses at most 240 reads at the 100-record limit and never lists a collection or materializes 16-revision ancestry. First initialization uses at most 239 reads, initialized restart 241, and concurrent exact initialization recovery 479. After staging an indication mutation, the coordinator requires the staged summary to equal the exact next index and entry set before any aggregate or index commit. Create and reactivation conflict at the limit. Participant creation, withdrawal, and reactivation compare-and-set the participant index, while every indication lifecycle write compare-and-sets the summary, so concurrent activation and direct repository work cannot cross or hide from the bound. Withdrawn and rejected records remain in both 100-item historical sets without consuming an active slot. The summary still occupies one lifecycle mutation and the root is immutable, preserving the storage protocol's 25-mutation account-deletion boundary.

`stageParticipantAccountDeletionInvestmentWithdrawalSet` owns the bounded investment preparation used by `StorageParticipantAccountDeletionRepository`. It accepts the shared request-local staged transaction, verifies the complete subject ownership proof, reconstructs only the at-most-four active indications, and derives stable per-indication withdrawal operation and history identities from the outer operation. It collapses the simulated per-item summary changes into one compare-and-set summary replacement, advances the unchanged ID index once, replaces every affected aggregate contribution, and calculates one aggregate revision for the whole set. The maximum is 19 unique mutations and the observed read ceiling is exported. Empty, withdrawn-only, and rejected-only ownership still advances the index and completeness witness as a two-mutation revision barrier so a concurrent create or reactivation cannot cross account deletion. The aggregate update verifies the exact selected contribution delta and, when the selected set exhausts the stored contributor count, requires the selected amount to exhaust the stored total; consistency of unrelated contributions remains the bounded owner-reconciliation contract. The coordinator derives terminal cleanup from the aggregate's immutable persisted currency rather than current campaign increments or limits, then adds the exact profile transition, an active-founder withdrawal or founder-absence check, one closed deletion-requested audit event, and one immutable subject-bound receipt before the shared boundary's single commit. Its maximum is exactly 25 mutations, while empty and inactive accounts commit seven mutations including all three absence/ownership barriers. The audit identity commits the receipt's complete effect fingerprint, independently binding profile revision, founder disposition, every withdrawal, and the historical aggregate result without another mutation. Receipt replay verifies that binding, the original deletion profile, founder disposition, every operation-derived investment withdrawal, every affected aggregate contribution, absence of active investment state, and audit evidence across restart or response loss. Its compact replay authenticates all 100 ownership heads but fully materializes only the receipt's at-most-four withdrawals under one exported response-loss read ceiling proven over the combined maximum-history commit and recovery. `BACKLOG-024` retains the deferred hosted participant-profile composition work.

Full indication reads reconstruct bounded transition ancestry from exact data-only records, verify every field reference, chunk topology, byte count, content hash, normalized operation fingerprint, storage revision, required active lease, and ownership summary, then compare the reconstruction with current metadata. A separate immutable fingerprint binds the exact authoritative request fields before deployment policy or normalizers are applied, and every normalized transition fingerprint commits that raw-request fingerprint plus the compact normalized field commitment when fields change, so exact retries return their original revision after policy evolution while changed or corrupted request evidence cannot adopt the operation. Stored values with accessors, unexpected own keys, or non-data prototypes fail closed; canonical comparisons have explicit depth and node ceilings, and ownership-root, summary, participant-index, and operation-receipt reads validate their complete outer record and key envelopes before field access. Capacity uses the compact proof above rather than full reconstruction. Current owner configuration authorizes access, while immutable historical owner attribution survives an authorized owner rotation. Exported record, transaction, mutation, materialization-read, capacity-read, initialization-read, and delayed-replay-read ceilings are enforced and observed in the reusable repository contract.

`StorageOwnerIndicationReviewCollectionRepository` is the narrow persistent
collection projection over those current indication records. Construction binds
one authenticated subject to the configured owner and accepts one separately
injected `OwnerIndicationReviewTokenBoundary`; anonymous and different
authenticated subjects receive the same fixed not-found failure before any
storage request. The repository exposes only `list`, with no detail lookup,
mutation, adapter, key-read, transaction, credential, or token-codec surface.

Each page contains at most 25 allowlisted summaries. One adapter list and at
most 25 terminal-transition reads, active-lease checks, and bounded current-field
chunks produce the page, for a maximum of 250 record reads. Current metadata, terminal
transition, acknowledgment, actor, operation fingerprint, field reference,
chunk envelope, byte count, payload hash, and parsed fields must agree before a
summary is returned. The projection includes only an authenticated opaque review ID, kind,
lifecycle, minor-unit amount, currency, update timestamp, and revision. It
omits participant subject, indication ID, company identity, representative,
availability, note, rejection reason, and notification state.

`AeadOwnerIndicationReviewTokenBoundary` places an application-owned AES-GCM
boundary around navigation state. A public continuation token encrypts the
bounded backend cursor and authenticates its owner subject, page size, purpose,
and version. Raw, malformed, oversized, crossed, or tampered public values fail
before adapter access, while malformed or oversized backend continuations fail
as non-disclosing unavailability. Backend cursor text never enters a public URL
or response. The capability is stateless: a fresh Worker can continue a token
after importing the same non-extractable deployment key, without a cursor table
or process-memory map.

The same boundary deterministically encrypts the already-hashed current-record
key into the owner-bound review ID. Decoding that ID yields exactly one validated
`investment-indications` key, allowing a later detail repository to perform one
bounded current-record read without scanning existing records. The stable ID
does not contain participant subject, company identifier, note, raw indication
ID, or plaintext storage key. Cursor and review-ID IV domains are disjoint, and
cross-purpose, cross-owner, non-canonical, or tampered tokens fail closed. The
AES key is deployment secret configuration, not campaign content or reusable
source, and rotation intentionally invalidates outstanding navigation tokens.
Persistent detail reconstruction, rejection, notification composition, key
import, and hosted route wiring remain separate capabilities.

Owner moderation is a separate application capability over the strong `AtomicOwnerIndicationModerationRepository` port. The owner collection uses opaque review identifiers, while each authorized detail projects permitted private indication fields, immutable transition history, current notification state, and only the action valid for that lifecycle. The same resource model drives native HTML and versioned hypermedia JSON at `/owner/investment-indications` and `/owner/investment-indications/{review-id}`.

`StorageOwnerIndicationReviewDetailRepository` is the persistent read lane for one opaque detail. It checks the authenticated and configured owner before invoking the deployment-key token resolver, accepts only one canonical current-indication storage key, and performs no collection scan. The existing indication materializer verifies every immutable transition, field chunk, current head, and active uniqueness lease within its fixed ancestry ceiling. A rejected head derives stable notification and purpose identities from its verified terminal operation, then verifies the exact rejection template and its resource, participant, timestamp, and rejecting-owner bindings. Notification revisions are capped at the initial template, 64 copy facts, and one sent fact; an oversized revision fails before history traversal. The complete rejected-detail projection therefore performs at most 213 direct storage reads and zero list calls across Worker reconstruction.

Version one has no directly linked durable fact proving which configured owner was authorized when notification activity occurred. Its explicit `rejecting-owner-continuity-v1` policy permits a rotated current owner to read a notification only while it has no copy or sent activity. Once activity exists, the immutable rejecting owner, current configured owner, and every copy or sent attribution must be the same subject; an intervening-owner activity history fails closed even if its current and immutable notification records are internally consistent. This continuity rule does not prove cryptographic integrity, historical authorization, or the absence of a prior rotation. Supporting notification activity across owner rotations requires a later versioned persistence contract that directly links each activity to durable authorization evidence. Malformed, missing, crossed, corrupt, anonymous, and foreign reads disclose no storage coordinate or private value. Hosted collection, detail, and mutation assembly remains a separate composition step.

A rejection action is advertised only when the injected repository explicitly guarantees `atomic-indication-aggregate-audit-notification`. One retry-stable operation must reject the active indication, replace its aggregate contribution with the rejected revision, update the aggregate snapshot, append closed owner audit evidence, and create the bounded participant notification template in one transaction. The route cross-checks all returned effects against the rejected indication and trusted owner before responding. Missing guarantees, stale revisions, invalid results, or transaction failure fail closed; no weaker adapter may expose the action.

`StorageOwnerIndicationRejectionRepository` supplies that write guarantee over one credential-bound `StorageAdapter`. The trusted detail projection passes the internal indication ID beside the opaque review ID; the repository recomputes their direct current-key binding before storage access. It stages the rejected transition, aggregate contribution and snapshot, one closed audit event, one immutable notification template, and one operation receipt, then commits and verifies their ordered records in a single bounded transaction. The receipt excludes the server clock from retry identity while retaining the winning timestamp, so a concurrent or delayed exact retry reconstructs the original immutable result and changed work conflicts. Transaction failure changes none of the effects.

The Worker composes the moderation route and owner-home navigation only when the hosted runtime imports a separate non-extractable owner-review key and can assemble the collection, detail, and rejection capabilities together. `StorageOwnerIndicationModerationRepository` is a frozen closed facade over those independently tested lanes and exposes no adapter. Its replaced runtime header controls React presentation but grants no access; every collection, detail, and mutation independently enforces the configured owner, canonical deployment origin, trusted one-use session, CSRF proof, route-specific 8 KiB/four-field ceiling, exact business fields, and non-disclosing failures. Post-verification responses clear the consumed cookie, while JSON and HTML receive the same available actions from one resource model.

### Participant investment-interest resource

`/participant/investment-interests` is the participant-owned collection, `/participant/investment-interests/{id}` is an owned indication, and a terminal withdrawal links to its isolated `{id}/withdrawal-replay` recovery resource. `domain/participant-investment-interest-resource.ts` projects collection, item, and replay capability models into versioned hypermedia documents and native forms. The collection advertises only currently permitted personal or company creation. An active item advertises edit only with a current package acknowledgment and withdrawal regardless of renewed acknowledgment; a withdrawn item advertises reactivation only when both current acknowledgment and deployment policy permit it, while its replay resource advertises only the immutable terminal withdrawal command. Rejected items expose no participant mutation.

`worker/investment-interest-service.ts` binds the trusted participant subject to an independently injected participant-owned reader and the stronger `AtomicParticipantInvestmentInterestMutationPort`, plus amount configuration, permission and acknowledgment-context readers, a deterministic operation-to-indication ID function, and a clock. The service refuses construction unless the mutation port explicitly declares `atomic-indication-aggregate-audit`. Each create, edit, withdrawal, or reactivation command carries its allowlisted audit intent, and the port contract commits the indication revision, recalculated aggregate projection, audit event, and retry result together or leaves all of them unchanged. The service validates the returned indication, aggregate, and closed audit evidence before exposing the result. It supplies trusted current package state directly to mutations, never from browser fields. Operation IDs are also immutable history-entry and audit IDs, and known retries recover their original timestamp from owned history.

The deterministic test port implements the reader and atomic write capability over explicit fixture state and proves projection changes, one closed audit transition per successful mutation, retry stability, and complete rollback under a forced commit failure. `StorageApplicationRepositoryFactory` supplies the production AittaDB-backed participant reader and atomic mutation port; neither the service nor route constructs process-local persistence.

`worker/routes/investment-interest.ts` negotiates HTML or JSON at each collection, item, and replay URI. The route requires a matching active participant projection with investor interest, binds mutations to the trusted session actor, derives item identity only from the canonical path, and accepts exact method-specific fields after same-origin, CSRF, body, and session checks. Canonical-origin rejection runs before form method-override preflight, proof extraction, or replay claim. The route then narrows the shared hosted mutation session to finite POST, PATCH, or DELETE body and field limits; an HTML method override is preflighted against its effective limit without consuming a malformed or oversized proof. A successfully verified one-time proof is expired exactly once on success or any later fixed failure, and a returned resource issues a distinct replacement only when it still advertises a mutation. Before returning any HTML forms or JSON mutation actions, the route obtains and validates the same participant-bound CSRF proof. HTML receives a hidden transport field; JSON receives the proof only in `MUTATION_CSRF_HEADER`, including post-mutation resource responses. A document with no mutation actions receives no proof header, and no token is serialized into JSON. The replay URI accepts only `GET` and `DELETE`; its version-2 proof is mandatory and carries a fixed-length digest binding the actor, canonical replay path, method, indication, immutable terminal operation, revision pair, and confirmation, so a general item proof or changed command fails before replay claim while accepted maximum-sized values remain representable. Item and action URLs derive from `context.resourceUrl`. Missing and foreign items share fixed not-found data, while an occupied normalized company key returns a generic conflict without identifying the company or participant.

Hosted Worker composition installs that route group for eligible investor and combined participants from the current subject-bound request scope. The same scope owns the persistent indication reader and mutation port, so indication reads cannot bypass the participant request budget. It binds the trusted campaign amount configuration, participant profile, current package and latest stored acknowledgment, and hosted mutation session without exposing any of them to the browser. One request-shared policy loader brackets package and acknowledgment reads with matching campaign and participant revisions. The scope retains the exact campaign, participant-profile, package-version, and package-acceptance heads; create, edit, and reactivate check all four in the same transaction as their durable effects. Policy movement during reads or after the final sample therefore commits nothing. Withdrawal remains policy-independent and uses the verified indication and aggregate currency already persisted for that interest, so a later campaign-currency change cannot strand an active historical record. Exact retries decode and verify the immutable receipt currency before aggregate replay. A lost withdrawal response can be recovered from the terminal replay resource after Worker reconstruction without replacing the item's independent reactivation proof or opening any new transition. Missing legacy ownership metadata fails closed and is never initialized by an HTML or JSON request. The exact hosted URI remains an intentional negotiated 401 or non-disclosing 404 surface for anonymous, owner, ineligible, and foreign callers, while participant-home navigation is advertised only when the complete route capability is installed.

### Aggregate and reconciliation contracts

`domain/investment-aggregate.ts` accepts only a closed projection of indication ID, revision, lifecycle status, amount, and currency. Calculation keeps the highest revision for each indication, accepts an identical repeated revision as a retry, rejects conflicting same-revision facts, and sums only active indications with safe integer arithmetic. Withdrawn and rejected latest revisions therefore remove their indication from the calculated total.

Reconciliation compares a stored revision, amount, and private contributing count with a fresh calculation. A correction intent exists only for a mismatch and only after an explicit confirmation binds every stored and calculated preview value; persistence must still compare-and-set the stored revision. Public output is rebuilt from an allowlist containing configured amount, currency, label, qualifier, and optional integer target progress. It has no structural place for indication IDs, participant or company identity, notes, lifecycle detail, moderation, or private counts.

The separately persisted public campaign projection captures its aggregate-display policy in the same immutable published revision. Its schema version evolves independently from private campaign setup, history, intent, and chunk schemas, so adding a public field cannot invalidate private campaign records. The reader accepts the exact legacy schema-4 public-only shape so an existing published campaign remains visible after a code deployment, but treats its missing aggregate policy as `null` and performs no aggregate read. An unpublished schema-4 campaign remains unavailable. Every fresh owner save writes schema 5 with explicit aggregate policy; malformed hybrids, extra fields, missing schema-5 fields, and unknown versions fail closed without mutating hosted data. A delayed exact owner retry that committed before the upgrade may replay its original schema-4 final transaction only after the schema-5 request conflicts and immutable operation evidence matches. The closed legacy result must be marked replayed and match every original campaign and audit record, so recovery cannot migrate the projection or replace newer state.

`StoragePublicCampaignStateReader` reads that public policy and, only when totals are enabled, the atomic current aggregate through a narrow port. It verifies the public revision remains stable and retries at most once when publication changes concurrently. A legacy or hidden policy performs no aggregate read; hidden and zero totals return no aggregate. A corrupt aggregate hides only the total, while corrupt or repeatedly changing publication state fails the whole public projection closed without exposing backend detail.

The reader returns only the sanitized campaign and aggregate pair. HTML and hypermedia add fixed self-declared, unverified, and non-binding semantics to the configured label and qualifier; neither representation receives the stored revision or private contributing count. Their internal aggregate header limit is derived from the configured display-text maxima, worst-case JSON escaping, the largest safe integer fields, and Base64 expansion, so every valid Unicode projection round-trips while oversized untrusted input remains bounded. HTML derives the currency's fraction digits from `Intl`, then formats the safe-integer minor units with `BigInt` quotient and remainder operations. It never divides or rounds a floating-point amount.

`DevelopmentInMemoryAggregateRepository` persists one latest closed contribution projection per indication, the current aggregate snapshot, and immutable operation receipts through a development/test `StorageAdapter`. A newer indication revision atomically replaces its projection and compare-and-sets the aggregate; identical delivery deduplicates, older delivery is superseded, and conflicting same-revision facts fail. Recreating the repository over the adapter reopens the same state without process-local totals.

Every calculated view is rebuilt from persisted projections with safe integer arithmetic. A stored mismatch blocks ordinary projection updates until an exact preview-bound correction compare-and-sets the current snapshot. The owner-facing correction capability advertises the exact campaign revision that supplied its amount configuration and requires new work to return that revision. Its stronger repository operation commits the corrected aggregate with one closed terminal command, retry receipt, allowlisted owner audit event, and a non-mutating exact check of the same campaign revision in one adapter transaction. A stale advertised revision or concurrent campaign change therefore rolls back every correction effect. Its route issues an operation ID and advertises a correction action only when the injected repository explicitly guarantees `atomic-aggregate-audit` and the stored revision can advance; read-only, weaker, unrelated matching, or maximum-revision states expose the comparison without new operation or proof issuance.

The owner reconciliation URI negotiates the same campaign revision, preview, and preview-bound correction through hypermedia JSON or an HTML confirmation form. Every server-issued correction field is hidden by the shared action model in both representations; only explicit confirmation is a control, and the positive campaign-revision constraint is identical in the action schema and mutation parser. The shared browser mutation guard verifies trusted owner subject, exact origin, one-use expiring CSRF proof, method, eight exact JSON feature fields, or those eight fields plus the native-form CSRF transport field before durable proof claim. Contribution calculation accepts at most 1,000 records through at most 20 finite page reads; oversized collections, repeated or endlessly advancing cursors, malformed pages, and empty continuation pages fail closed. A newly committed POST derives its matching response from the committed correction result instead of repeating the full contribution scan. An exact replay performs one bounded current reconciliation refresh before projecting either representation or issuing another proof, so a later aggregate write cannot resurrect the old terminal action. The immutable client-work fingerprint includes the advertised campaign revision but not a freshly loaded server assertion or server timestamp. Receipt verification runs before comparing current campaign state. Exact replay decoding and terminal reconstruction derive and cross-check immutable currency, while every new correction still decodes against the current campaign amount configuration. A matching aggregate with verified terminal intent may expose only the original command under a fresh proof whose encrypted digest binds actor, route, method, operation, campaign revision, aggregate revision, and every preview value. The configured-owner wrapper first verifies that command against its immutable operation receipt and audit actor, so a replacement owner receives neither the prior command nor a replay proof. Altered requests fail before claim, exact use is one-time, and any later aggregate write removes the intent. Transaction output remains a closed envelope with a boolean replay marker and four dense records whose order, keys, revisions, and put values match the submitted aggregate, receipt, audit, and campaign-check mutations; positive campaign checks additionally validate the complete canonical campaign-revision evidence envelope and its value revision. Transaction ambiguity gets one bounded receipt-and-audit recovery attempt. Exact overlapping requests therefore converge on the winner's original audit, an exact delayed retry survives campaign and currency advance, changed reuse conflicts, and a new stale operation fails before calculation. No partial aggregate or audit write is possible through this capability. Public reads still pass through the closed aggregate sanitizer and cannot return indication identity or private contributing counts. Hosted composition passes the exact persisted campaign revision and its amount configuration into a configured-owner-bound correction capability over the credential-closed AittaDB adapter. Synthetic hosted tests prove advertised-revision rejection, campaign-race rollback, bounded calculation, correction and audit atomicity, closed transaction-result validation, field limits before proof claim, maximum-revision behavior, stale and storage failures, non-disclosure, exact overlap recovery, response-loss recovery with altered/foreign/reused-proof rejection, owner-rotation omission, HTML/hypermedia field parity, delayed retry across configuration evolution, and restart persistence; live acceptance remains a separate deployment proof.

### Phase and country eligibility

`domain/phase-configuration.ts` requires explicit phase identity, state, participation paths, and country policy. It supplies no built-in country, path, or campaign default. Country codes pass through the shared normalizer before duplicate and allow or deny evaluation.

Setup readiness is distinct from open or closed state: configuration may be complete while a phase is closed. Participation is accepted only when the phase is open, setup is complete, the requested path is enabled, and the normalized country satisfies the configured rule.

### Storage adapter contract

`domain/storage-adapter.ts` defines bounded JSON records, finite cursor pages, and atomic transactions with compare-and-set revisions, non-mutating revision-or-absence checks, and idempotent operation IDs. A check atomically returns the matching unchanged record or absence `null` alongside ordered write results; a mismatch rolls back adjacent writes and the receipt. Replaying identical work returns its original evidence; reusing an operation ID for different work fails. Transaction limits and duplicate keys are rejected before mutation.

An adapter instance is already bound to one backend credential and grant set. Foreign and missing records therefore have the same read and mutation shape, while fixed public failures contain no keys, values, or credentials. The reusable contract harness runs unchanged against deterministic fakes and production adapters and deliberately checks authorization, duplicate keys, stale and missing checks, maximum mutation count, atomic rollback, disclosure, idempotency, and pagination behavior.

`repositories/staged-storage-transaction.ts` is the bounded request-local
composition primitive for operations that span existing narrow repositories.
It implements `StorageAdapter` over an immutable overlay, accepts puts,
deletes, and non-mutating checks under one operation ID, and makes no durable
call until its explicit commit. Duplicate keys across staged calls, stale
revisions, same-collection list/write ambiguity, more than 25 entries, more
than 1,048,576 serialized bytes, and malformed or reordered results fail
closed. A final response loss can retry the identical transaction and retain
the backend's exact `replayed` evidence; fixed failures retain no adapter cause.

`repositories/aittadb-storage-adapter.ts` implements that interface over the versioned bounded AittaDB hypermedia protocol. It takes only an exact logical issuer, same-issuer discovery resource, optional backend transport origin, token-producing closure, fetch capability, and optional finite software timeout. The logical issuer remains authoritative when transport is mapped; all action targets and page identities are discovered and validated rather than hard-coded. Exact runtime mutation shapes are copied once into an immutable data-only snapshot, while operation and key grammar, finite JSON, per-record and transaction sizes, token/fetch waits, streamed bytes, chunk count, and stream time all have finite compile-time or advertised bounds. Redirects are manual and rejected, media and UTF-8 are strict, early header failures cancel their bodies, and failures retain no response or exception cause. Concurrent discovery is coalesced into one normalized result, failed discovery remains retryable, and bearer values are neither cached by the adapter nor exposed outside request headers. See `docs/AITTADB_STORAGE_ADAPTER.md`.

### Audit and manual notifications

`domain/audit-notification.ts` accepts only closed, allowlisted audit detail. Human actors are attributed by trusted identity subject, system activity is explicit, and operation IDs make append intent retry-addressable. Export evidence records an export class but never its content; notification evidence references a private notification record instead of copying its template.

Manual notification templates remain private and bounded. Copy evidence means only that an owner copied a template, while a separate owner-entered marker records reported delivery outside the app. Neither state implies automated email delivery, and public errors use fixed projections that omit credentials, notes, template content, and internal causes.

`DevelopmentInMemoryAuditRepository` appends one immutable allowlisted event per retry-stable operation. `StorageAuditEventReader` is the narrower production read capability: it pages the same immutable collection through a credential-bound `StorageAdapter`, validates the exact page envelope and every closed schema-v1 record, and returns no append, key-read, transaction, adapter, or credential surface. It rejects oversized, duplicate, looping, unknown, accessor-backed, noncanonical, and corrupt evidence through a fixed `UNAVAILABLE` failure. `StorageManualNotificationRepository` atomically compare-and-sets one private current notification with each immutable revision under one operation ID. Its historical `DevelopmentInMemoryManualNotificationRepository` export is a compatibility alias for deterministic fixtures; neither class retains process memory. Copy evidence appends independently from the single owner-entered sent marker, so neither action implies the other.

Notification keys are one-way derived, stored records are reconstructed through the bounded domain transitions, and every prior revision is verified before detail state is returned. One template, 64 copy facts, and one sent fact cap history at 66 revisions and a complete detail at 67 reads including current state. Collection pages contain at most 25 exact current records; each item adds one direct read of its exact immutable terminal revision and is projected only after strict key, revision, and canonical snapshot equality. The collection therefore has a 25-record-read ceiling after one bounded list call, or 26 adapter operations total, without multiplying the complete history traversal. Missing, malformed, crossed, duplicate, or current-divergent terminal evidence fails closed. Audit detail cannot retain export contents or arbitrary fields, while notification templates never enter public failure projections.

The application repository factory exposes the persistent audit reader and the
atomic notification activity repository as separate named backend-only
capabilities. The hosted Worker composes them into the owner-authorized
`/owner/audit-events` and `/owner/manual-notifications` resources. HTML and
hypermedia use the same projections and canonical deployment URLs.
Authentication and owner authorization run before either private repository,
while page, cursor, storage, and evidence failures use bounded fixed responses
with no backend cause or private detail. Worker reconstruction opens fresh
repositories over the same AittaDB records and opaque cursors.

The combined owner-activity route supports the manual-notification collection
and one notification detail containing finite copy evidence and an optional
sent marker. That detail remains the single
source for native forms and hypermedia actions. It advertises only transitions
currently available, supplies CSRF discovery for both representations, accepts
exact feature fields, and uses the canonical deployment origin for every link
and redirect. Notification, purpose, related-resource, copy-evidence, and
sent-evidence identifiers plus available audit and campaign navigation are
projected equivalently in HTML and JSON. Distinct server-replaced audit and
notification headers prevent an audit-only composition from advertising
notification UI.

Copy and sent mutations require the explicit
`atomic-notification-audit` capability. Each transition compare-and-sets the
notification revision and appends its corresponding closed audit event in one
storage transaction; failure leaves both histories unchanged. The route takes
trusted owner identity, mutation guard, operation IDs, clock, repositories, and
CSRF provider as injected dependencies, so reusable source contains no owner,
hostname, credential, or campaign-specific value. Exact delayed retries read the
requested immutable result and its predecessor and recover only when that
transition introduced the operation-derived activity evidence and matching
closed audit event. A changed expected revision therefore cannot pair an old
operation audit with a later notification revision. Recovery does not trust a
later clock or perform another transaction. Hosted composition explicitly uses
persistent proof-claim verification and requires a valid cleanup instruction
before mutation; the explicit legacy mode preserves only the historical
non-claiming verifier contract. Owner-subject continuity suppresses actions and
fails direct mutation after configured-owner replacement.
Audited activity operation IDs are capped at 97 characters so the versioned
operation-bearing evidence identifier remains within the shared 128-character
stable-ID boundary. This evidence lets a fully terminal record recover whether
its final transition was the last
copy or the sent marker and retain the exact operation and prior revision. The
resource exposes only that retry, and hosted composition issues a version-2
proof whose encrypted state contains only the hash of the notification,
activity, operation, and revision scope. Legacy evidence remains readable but
does not manufacture terminal replay authority.

### Owner review exports

`services/owner-review-export.ts` builds private owner downloads from injected
campaign, package, participant, indication, founder, and aggregate read
contracts. The owner-wide record reader receives explicit per-record and
nested-history bounds and is finite and cursor-paged. A single configured row
budget covers all review collections, every page request stays within the
storage page boundary, and repeated or empty continuation cursors fail closed.
The service visits one page and encodes one record at a time into a bounded
transient chunk set. Per-record bytes, nested histories, total encoded bytes,
and the supported deployment maxima are checked before any response becomes a
download; the complete source collections and one monolithic JSON string are
never materialized by the service. UTF-8 accounting accepts the remaining byte
budget and stops at the first over-budget code point; CSV quoting, formula
detection, and JSON escaping flush bounded string segments instead of scanning
or copying an entire hostile field first.

The review CSV contains one explicitly projected current row per participant
profile, investment indication, or founder application. Every cell is quoted;
leading spreadsheet formula characters are prefixed with a literal apostrophe,
including when preceded by whitespace. The JSON document is a versioned,
current-state backup. It allowlists current campaign setup, package content,
profiles, indication and founder histories, and private aggregate state while
excluding storage keys, repository operation identifiers, credentials, audit
history, and implementation details.

Export generation requires the explicit `atomic-immutable-audit` repository
capability. The owner, canonical resource URL, export class, and guarded request
operation ID deterministically address the audit event. The service fully
validates and bounds the transient encoded chunks, then atomically appends and
verifies one closed `export-created` event before it returns those chunks to the
route. Once that deterministic event exists, the operation is consumed: any
replay, including after an ambiguous append response, returns a fixed conflict
before source reads or another append. A fresh server-issued operation creates
distinct evidence. A missing capability, append failure, or mismatched append
result returns no download bytes. The audit detail records only `review-csv` or
`json-backup`; export content and content fingerprints are never persisted as
export or audit records.

`GET /owner/exports` provides equivalent private HTML forms and hypermedia POST
actions, plus CSRF discovery through an owner-private response header. Export
POSTs pass the shared trusted-session, exact-origin, CSRF, exact-field, and
operation-ID guard and return the attachment directly. GET requests to the file
paths are side-effect-free and advertise POST as the allowed method. Download
responses use fixed safe filenames, attachment disposition, exact media types,
`private, no-store` and legacy cache defenses, same-origin resource policy, and
content-type sniffing protection. Anonymous requests receive authentication
recovery, foreign authenticated callers receive a fixed not-found response, and
authorization runs before CSRF discovery, source reads, or audit identity work.

An `export-created` event means the server generated and authorized the bounded
attachment before making its response stream available. It does not claim that
the client received every byte: cancellation or connection loss leaves the
generation event intact, and the consumed operation then returns a fixed
conflict. The owner must obtain a fresh operation ID to generate another file.
The JSON artifact is a sequential current-state projection, not a
transactionally consistent cross-repository or complete historical recovery
snapshot.

### Amount and aggregate display configuration

`domain/amount-aggregate-configuration.ts` requires an explicit currency, integer minor-unit minimum, positive increment, optional maximum, and public visibility choice. No deployment inherits a currency, amount boundary, or aggregate policy from reusable source.

Public totals render only when configured for non-zero visibility and the sanitized total is positive. The public projection is closed to amount, currency, bounded display label, and qualifier, so participant identities, counts, notes, moderation state, and private totals cannot enter it.

### Storage campaign repository

`StorageCampaignRepository` persists one explicitly configured campaign setup
through a supplied `StorageAdapter` and retains no process-local durable state.
Hosted composition supplies only the credential-bound `AittaDBStorageAdapter`.
`DevelopmentInMemoryCampaignRepository` is a compatibility subclass for
development tests and is never instantiated by hosted composition. A setup
contains the validated public presentation, one or more explicit phases, amount
and aggregate-display policy, deployment-supplied founder contribution choices,
legal and non-binding notices, required-process-email and
optional-marketing-consent notices, a privacy contact, retention text, and
explicit owner review gates; the parser supplies no campaign, country, path,
currency, notice, contact, contribution, or publication default.

`domain/campaign-setup-policy.ts` keeps that private policy separate from the public presentation projection. Founder choices are required for publication only when a founder path is enabled. Public presentation, legal-notice, and privacy/retention review gates must all be affirmatively set before publication. `participantRegistrationNoticesFromCampaignPolicy` is the single mapping from owner-managed communication text into the registration resource. Setup comparison classifies a public-copy-only change as editorial and any phase, amount, founder-choice, notice, privacy, retention, or review-gate change as material. Immutable setup history retains every classification input, while public reads remain bound to the separately stored public presentation record.

Schema version 4 deterministically serializes the normalized private setup,
hashes its UTF-8 bytes, and prepares immutable content-addressed chunks with
derived retry-stable operation IDs. Each 45,000-byte raw chunk encodes to a
record no larger than 61,440 bytes. Current, history, and operation records
contain only the hash, byte count, and chunk count. Reads validate every chunk
key, index, size, hash, canonical serialization, and parsed domain value before
returning private setup.

Before the first chunk transaction, the repository immutably claims
`campaign-setup-intents/<business-operation-id>` under a distinct deterministic
`campaign-intent-claim:<sha256>` transaction operation ID. The closed intent
record is bounded to 2,048 bytes and binds the audited or unaudited mode,
business operation ID, expected and resulting revisions, original timestamp,
normalized setup hash/byte/chunk reference, and, for audited writes, the trusted
owner actor and derived transition. An exact existing intent resumes staging or
final replay after a restart. Any changed setup, actor, timestamp, transition,
expected revision, resulting revision, or mode conflicts before another chunk
or final transaction. A failed staging attempt can therefore leave only the
immutable intent and unreachable immutable chunks, never a current revision,
history entry, completed operation result, public projection, or audit event.

After chunk staging, one adapter transaction compare-and-sets current metadata
and creates immutable history, direct operation-index metadata, the public-only
presentation projection, and an allowlisted owner audit event under the
business operation ID. It accepts `created` only for an absent campaign becoming
an unpublished revision-one draft, then derives and verifies `updated`,
`published`, or `unpublished` against prior and next publication state. Exact
replay returns the original campaign and audit evidence; changed operation reuse
conflicts, and competing revisions preserve one winner. A final transaction is
all-or-none even when its response is lost: no partial visible records can
exist, and an exact retry validates and returns the stored transaction receipt.
Intent-claim, chunk-stage, and final transaction responses must be closed
objects with a real boolean replay flag and exactly the requested records in
mutation order. Every record envelope, key, revision, and JSON value must match;
null, missing, extra, reordered, or mismatched records fail closed. History is
bounded and cursor-paged. The public reader is closed over only the public
projection read and cannot expose adapter, list, transaction, or private setup
capabilities.

### Owner campaign editor

`services/owner-campaign-editor.ts` composes an injected atomic campaign
repository and deployment publication-readiness checker. Presentation saves
parse the complete public campaign contract, preserve publication plus unrelated
phase and aggregate settings, and compare-and-set the submitted revision.
Publish changes only the publication flag and is available only when intrinsic
phase checks and the injected deployment readiness checks pass. Unpublish
remains available independently so an owner can always remove a published
presentation. Direct operation lookup recovers the original immutable revision
and timestamp for a retry; changed reuse conflicts instead of creating a second
audit event. The route then re-reads current state so a delayed replay cannot
return stale capabilities.

`domain/owner-campaign-editor-resource.ts` is the common capability source for
the owner HTML forms, hypermedia actions, and saved-draft preview. It describes
the complete bounded public campaign value as a structured JSON action field and
exposes only transitions available in the current state. HTML projects that same
value into labeled, repeatable controls for sections, links, facts, risks,
funding uses, and optional media instead of exposing a raw JSON textarea. The
route independently checks trusted owner identity, exact origin, CSRF proof,
body and field bounds, exact feature fields, operation ID, and revision before
calling the service. Authenticated non-owners are denied before repository
access.

The saved-draft HTML and JSON previews derive from one visitor capability model
and expose visible draft, saved-publication, and source-revision status. HTML
rewrites an internal render request to the public root and supplies a transient
published projection of the stored draft, so it uses the same React campaign
rendering without publishing or modifying data. Subsequent public requests use
the separate public presentation reader, so a committed publish or unpublish
changes the public resource on the next request without granting public code
access to privileged setup data.

`createApplicationWorker` accepts a trusted campaign-workspace object or resolver
only as explicit server-side dependency injection. The object supplies the
privileged repository, public projection reader, browser mutation session,
operation issuer, clock, and readiness checker. It is deliberately absent from
`InvestorAppEnv`: Sites runtime values are parsed only by the hosted composition
boundary and cannot directly construct this function-bearing capability. The
production Worker now builds the workspace from the hosted runtime's named
factory methods and installs it only in the owner route group. A missing,
partial, or malformed runtime installs no workspace, and repositories that
cannot atomically persist campaign metadata, public projection, and audit
evidence expose no mutation capability. This source composition is not live
hosted acceptance evidence.

### AittaDB campaign repository

`AittaDBCampaignConfigurationRepository` is an older direct HTTP implementation
against one explicitly configured AittaDB JSON-record URL. The record contains
the current setup and its immutable retry-addressed history, so operation lookup
examines the complete bounded record rather than an arbitrary history prefix.
Both request and response bodies have finite byte limits. The issuer origin,
logical key, access-token provider, and HTTP implementation are deployment
inputs; reusable source contains no production hostname, owner identity,
credential, or campaign content.

Before any write, the repository reads the configured issuer's OpenAPI document and requires an advertised strong `ETag` on reads and writes, `If-Match` and `If-None-Match` request fields, and `412` conflict semantics. It then creates with `If-None-Match: *` or replaces with the exact previously read strong `ETag`. Missing capability, validators, malformed or oversized representations, and unexpected write results fail closed with fixed non-disclosing errors. This adapter does not yet provide the atomic campaign, projection, and audit transaction required by the editor, so it cannot be injected as the editor mutation capability. An AittaDB deployment that only advertises unconditional record replacement remains readable through this repository, but the repository performs no write against it.

## Storage plan

Development can use a deterministic in-memory/test adapter. Production campaign
composition uses `StorageCampaignRepository` over the bounded AittaDB adapter
and must pass the same contract plus hosted quota, retry, concurrency, restart,
authorization, and non-disclosure proofs. Other production repositories must
likewise remain behind narrow AittaDB-compatible capabilities and pass their
shared contracts.

Production remains blocked until the configured backend provides the consistency, listing, pagination, quota, authorization, and non-disclosure behavior described in the use cases.

## Publication rule

The public campaign must remain unpublished until owner setup, production storage, authorization, security, accessibility, export, reconciliation, and legal-boundary checks pass end to end.
