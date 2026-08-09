# Investor App Architecture

Investor App is a ChatGPT Sites application that uses an AittaDB-compatible backend as its authoritative storage and identity layer. The app owns investor workflow, legal-boundary enforcement, campaign configuration, private information-package behavior, owner operations, and participant-facing forms. The backend owns reusable identity, persistent storage, authorization, quotas, and bounded consistency primitives.

## Initial stack decision

The initial repository uses the Sites Vinext starter with React server components and a Cloudflare Worker-compatible build. It does not declare local D1 or R2 resources in `.openai/hosting.json` because production campaign data must stay behind the configured app storage adapter.

## Runtime boundary

Deployments provide trusted runtime configuration for the canonical app origin, configured identity provider, storage adapter, owner setup, sessions, and anti-forgery protection. Secrets are managed as runtime configuration, not as campaign content.

`APP_BASE_URL` is instance configuration, never a source default. The worker validates it as an HTTP(S) origin and replaces an internal request header before rendering metadata. When it is absent or invalid, the current request origin is used. This lets the same Investor App source serve unrelated deployments without inheriting another instance's hostname.

`OWNER_EMAIL` configures the single version-one owner for one deployment. The worker validates and overwrites the internal owner header, and every owner HTML or JSON request separately compares the trusted Sites identity email with that configured value. Anonymous requests enter Sites sign-in; authenticated non-owners receive a generic denial. A later persisted owner subject may replace the email bootstrap after the production identity adapter is available.

`CAMPAIGN_CONFIG_JSON` supplies the public campaign presentation for one deployment. The worker validates its full structure before exposing it to React or hypermedia rendering. HTML, metadata, and JSON consume that same validated value; absent, malformed, oversized, insecure, unpublished, or otherwise invalid configuration produces a generic unavailable resource without leaking draft copy. It is an initial bootstrap input, not the eventual persistence mechanism; owner editing and publication will move behind the campaign repository.

The repository tracks only `.openai/hosting.example.json`. Each production, acceptance, or local deployment keeps its exact Sites project binding in ignored `.openai/hosting.json` state. Clean checkouts can build against the inert example, while Sites packaging explicitly requires an active binding.

## Resource representations

Application URLs identify resources rather than HTML-only pages. `Accept: text/html` selects the human interface. `Accept: application/vnd.aittadb-invest+json; version=0.1` selects the versioned hypermedia contract, and `application/json` is a compatibility representation. Representation selection never uses `User-Agent`.

Hypermedia documents contain `api_version`, resource `type`, `id`, `data`, semantic `links`, and currently available `actions`. An action declares its stable name, human title, method, target, request media type, and typed fields. An unavailable or unauthorized transition is omitted and remains independently rejected if submitted directly.

HTML links and forms and JSON links and actions must be projections of the same authorized domain resource. They share validation, mutation, error, and repository behavior. Explicit unsupported vendor-media versions return `406 Not Acceptable`, and negotiated responses include `Vary: Accept`. OAuth/OIDC endpoints retain their standards-defined response formats where a hypermedia envelope would break interoperability.

The public campaign resource is the signed-out base state. A valid participant session may extend it with private-package and self-service controls. Owner controls require a separate owner authorization decision; ordinary sign-in never implies ownership.

### Action capability contracts

`domain/hypermedia-action.ts` is the route-independent source for safe navigation and mutation capabilities. Definitions use bounded stable names, safe targets, explicit methods and request media types, and bounded string, integer, boolean, or choice fields. Sensitive fields cannot advertise a current or default value. An availability gate constructs an action only when the current caller and resource state permit its transition, but target routes must still enforce authorization and state independently.

Hypermedia and form models project from the same validated action. A form-compatible `GET` uses query fields; a mutation uses body fields and form encoding. Native forms submit `POST` with an explicit effective-method field when the semantic method is `PUT`, `PATCH`, or `DELETE`. JSON-only, path-driven, or header-driven actions remain valid hypermedia controls but cannot be projected as native forms. Route implementations must support the advertised encodings and normalize any form method before invoking the same security, validation, and domain operation.

### Modular route dispatch

The Worker normalizes trusted runtime configuration and identity once, then passes a narrow request context through independently composed public, participant, and owner route groups. Each handler either returns the complete response for a resource it owns or returns `null` without changing sibling state. Shared representation helpers own only response serialization and headers; feature authorization and projection remain inside the owning route group and its domain services.

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

### Participant profile and consent

`domain/participant-profile.ts` keeps the authenticated subject and account-email label identity-bound while exposing an explicit policy for participant-editable, registration-only, withdraw-only, request-only, and system-managed fields. Required process messages are independent from optional marketing consent.

An account-deletion request records intent but does not call indication or founder repositories. It emits a retry-stable withdrawal intent for an application service to coordinate across those separate lanes.

### Founder applications

`domain/founder-application.ts` validates founder fields against deployment-supplied contribution choices and records received or withdrawn state as immutable revision snapshots. Create, edit, and withdrawal transitions are scoped to the applicant subject, while owner review remains a separate use case.

Founder applications do not import, create, mutate, or gate investment indications. An account may therefore hold either record type or both, and application services compose them only when a participant-facing resource needs both projections.

### Phase and country eligibility

`domain/phase-configuration.ts` requires explicit phase identity, state, participation paths, and country policy. It supplies no built-in country, path, or campaign default. Country codes pass through the shared normalizer before duplicate and allow or deny evaluation.

Setup readiness is distinct from open or closed state: configuration may be complete while a phase is closed. Participation is accepted only when the phase is open, setup is complete, the requested path is enabled, and the normalized country satisfies the configured rule.

### Storage adapter contract

`domain/storage-adapter.ts` defines bounded JSON records, finite cursor pages, and atomic transactions with compare-and-set revisions and idempotent operation IDs. Replaying identical work returns its original result; reusing an operation ID for different work fails. Transaction limits and duplicate keys are rejected before mutation.

An adapter instance is already bound to one backend credential and grant set. Foreign and missing records therefore have the same read and mutation shape, while fixed public failures contain no keys, values, or credentials. The reusable contract harness runs unchanged against deterministic fakes and production adapters and deliberately checks authorization, duplicate creation, stale revision, atomic rollback, disclosure, idempotency, and pagination behavior.

### Audit and manual notifications

`domain/audit-notification.ts` accepts only closed, allowlisted audit detail. Human actors are attributed by trusted identity subject, system activity is explicit, and operation IDs make append intent retry-addressable. Export evidence records an export class but never its content; notification evidence references a private notification record instead of copying its template.

Manual notification templates remain private and bounded. Copy evidence means only that an owner copied a template, while a separate owner-entered marker records reported delivery outside the app. Neither state implies automated email delivery, and public errors use fixed projections that omit credentials, notes, template content, and internal causes.

### Amount and aggregate display configuration

`domain/amount-aggregate-configuration.ts` requires an explicit currency, integer minor-unit minimum, positive increment, optional maximum, and public visibility choice. No deployment inherits a currency, amount boundary, or aggregate policy from reusable source.

Public totals render only when configured for non-zero visibility and the sanitized total is positive. The public projection is closed to amount, currency, bounded display label, and qualifier, so participant identities, counts, notes, moderation state, and private totals cannot enter it.

### Development campaign repository

`DevelopmentInMemoryCampaignRepository` persists one explicitly configured campaign setup through a supplied development/test `StorageAdapter`. It does not retain separate process-local state, so recreating the repository over the same adapter proves the persistence boundary. A setup contains the validated public presentation, one or more explicit phases, and explicit amount and aggregate-display policy; the parser supplies no campaign, country, path, currency, or visibility default.

Each save atomically compare-and-sets the current setup and creates an immutable revision record under one retry-stable operation ID. History is bounded and cursor-paged. The adapter remains credential-bound, so unauthorized reads and lists have the same shape as missing state. This repository and deterministic adapter fixtures are development proof only; production still requires the AittaDB implementation and the same behavioral contract.

## Storage plan

Development can use a deterministic in-memory/test adapter. Production must use an AittaDB-compatible adapter and pass the same contract tests.

Production remains blocked until the configured backend provides the consistency, listing, pagination, quota, authorization, and non-disclosure behavior described in the use cases.

## Publication rule

The public campaign must remain unpublished until owner setup, production storage, authorization, security, accessibility, export, reconciliation, and legal-boundary checks pass end to end.
