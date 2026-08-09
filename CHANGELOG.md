# Changelog

Completed `PLAN.md` tasks and retired planning umbrellas are preserved here. Entries should include the unchanged task description, decisive validation evidence, and any residual uncertainty.

## Unreleased

- **TASK-028:** Configure one runtime owner identity and owner home. DoD: `OWNER_EMAIL` is validated as instance configuration, signed-out owner requests enter Sites sign-in, foreign signed-in users receive a non-disclosing denial, the matching owner can open `/owner`, root HTML and hypermedia expose owner navigation only to that actor, and focused tests cover all three identities.

  Acceptance evidence: the worker validates `OWNER_EMAIL`, replaces any client-supplied internal owner header, and independently authorizes owner HTML and JSON requests. `/owner` redirects anonymous browser requests through Sites sign-in, returns a generic denial to foreign identities, and presents an owner workspace only to the matching actor. The root resource adds `Manage campaign` in HTML and hypermedia only for that owner. Focused normalization, spoofing, anonymous, foreign-user, matching-owner, and representation-parity tests pass; `npm run validate` passes with 21 tests.

- **TASK-027:** Bind canonical metadata to the runtime app origin. DoD: `APP_BASE_URL` is validated as instance configuration with a request-origin fallback, no deployment hostname becomes a software default, HTML metadata receives the resolved origin through a worker-owned request header, focused tests prove distinct deployments produce distinct canonical and social URLs, and the AittaDB Sites instance is configured and verified separately.

  Acceptance evidence: `http/app-origin.ts` validates and normalizes optional per-instance origins, falls back to the current request origin, and replaces client-supplied internal origin headers. The metadata renderer consumes only the worker-owned value. Generic tests prove configured and fallback behavior across distinct example hosts; `npm run validate` passes with 16 tests and `AGENTS.md` remains below 32,000 bytes. Separately, the AittaDB Sites instance has `APP_BASE_URL=https://invest.aittadb.com`, and Sites reports its custom-domain routing and TLS active.

- **TASK-022:** Add same-URI hypermedia JSON for the public campaign resource. DoD: `GET /` negotiates HTML, `application/json`, and `application/vnd.aittadb-invest+json; version=0.1` without inspecting `User-Agent`; JSON exposes public campaign `data`, semantic `links`, and only currently available `actions`; unsupported explicit versions return `406`, responses vary on `Accept`, HTML and JSON share public campaign state, and focused tests prove representation parity.

  Acceptance evidence: the root worker now negotiates the human page or the `0.1` hypermedia document from `Accept`, returns `406` for unsupported explicit versions, adds `Vary: Accept`, and reports `Investor-App-API-Version`. HTML and JSON import the same public campaign fixture and sign-in action definitions. Direct negotiation tests cover browser, RSC, wildcard, weighted, compatibility JSON, vendor JSON, unsupported-version, and unsupported-media requests; worker tests prove state/action parity and identical JSON across different `User-Agent` values. `docs/HYPERMEDIA_API.md` records the route contract and `npm run validate` passes with 11 tests.

- **TASK-021:** Build the signed-out public landing for the active AittaDB investment pre-registration. DoD: the root route addresses prospective investors and founders, presents public AittaDB facts, investor and founder paths, the non-binding process and risks, and a real sign-in action; it uses checked-in AittaDB brand artwork, is responsive and accessible, contains no developer-facing prompts or roadmap copy, and has focused rendered-output tests.

  Acceptance evidence: the root route now presents the active public pre-registration with audience-facing investor and founder paths, an actual Sites sign-in transition, public product facts, process, risk disclosures, and no repository or implementation-summary copy. The responsive layout uses AittaDB's checked-in public mark and boundary artwork plus a campaign-specific social card. The rendered-output test asserts the campaign experience and rejects the former scaffold language. The private-content scan and `npm run validate` pass; `AGENTS.md` remains below its 32,000-byte limit.

- **TASK-020:** Bind the initial scaffold to one ChatGPT Sites project. DoD: the Sites project is created exactly once, its returned project identifier is persisted unchanged alongside null logical storage bindings, site metadata identifies Investor App, and no runtime secret, access-policy, or custom-domain change is bundled into the binding.

  Acceptance evidence: one owner-only Sites project was created with the Investor App title and description, and the returned opaque identifier is stored unchanged in `.openai/hosting.json` with `d1` and `r2` still null. Runtime environment, access policy, and custom domains were left unchanged. `npm run validate` passes for the bound source.

- **TASK-004:** Define shared domain foundation types. DoD: money minor-unit, timestamps, stable identifiers, actor subjects, country codes, validation-result, and non-disclosing domain-error types are documented and typed in framework-independent modules; tests cover integer money handling, amount bounds, country normalization hooks, and generic error mapping.

  Acceptance evidence: `domain/foundation.ts` defines the framework-independent branded values, constructors, validation result, actor shape, and fixed-message error mapping. Focused tests reject fractional, unsafe, negative, misconfigured, and out-of-range minor-unit amounts; exercise default and injected country normalization; validate timestamp, identifier, and subject boundaries; and prove authorization, missing-record, unknown-error, and private-cause responses do not disclose internal details. `npm run validate` passes with strict type checking included.

- **TASK-001:** Establish the initial Sites-compatible repository scaffold. DoD: app package metadata, neutral first screen, runtime environment template, FSL-1.1-MIT license, README, AGENTS, PLAN, ROADMAP, BACKLOG, CHANGELOG, CONTRIBUTING, SECURITY, architecture, style guidance, AGENTS size guard, rendered-output test, lint, test, and production build all exist and pass local validation.

  Acceptance evidence: `npm run validate` passed locally. The run included `npm run agents:check` with `AGENTS.md` at 7,073 bytes out of the 32,000 byte limit, `npm run lint`, `npm run build`, and `node --test tests/*.test.mjs` with one passing rendered-output test. A private-content scan over public repository files found no matches for the sensitive reference-campaign terms identified during review. Residual uncertainty: this is a local scaffold only; no production deployment, AittaDB adapter, owner setup flow, or campaign publication was attempted.

### Retired Planning Umbrellas

These entries were removed because their scopes could not finish independently. Their preservation here does not claim that the underlying product work is complete; each retirement mapping identifies the focused current-plan replacements.

- **TASK-005:** Define campaign and phase configuration contracts. DoD: campaign identity, publication state, phase status, country eligibility, amount-rule, aggregate-display, and setup-completion contracts are typed and documented; tests cover unpublished/public visibility, restricted-country eligibility, amount minimum/increment validation, and no campaign-specific defaults.

  Retirement mapping: Replaced by `TASK-029`, `TASK-039`, and `TASK-040`.

- **TASK-026:** Add the owner campaign workspace. DoD: authorized owners receive setup, package, participant, indication, founder-application, reconciliation, export, audit, and manual-notification navigation based only on currently allowed actions; non-owners receive no owner links or state; every owner HTML control has an equivalent hypermedia action and focused authorization tests.

  Retirement mapping: Replaced by `TASK-028` and `TASK-032` through `TASK-038`.

- **TASK-002:** Define the framework-independent domain model and repository interfaces. DoD: campaign, phase, content version, participant, acknowledgment, indication, founder application, aggregate, audit, notification, and storage-adapter contracts are documented and typed; no framework or AittaDB HTTP details leak into domain types; focused unit tests cover money integer handling and initial validation boundaries.

  Retirement mapping: Replaced by `TASK-004` through `TASK-012`.

- **TASK-003:** Implement the deterministic in-memory/test storage adapter. DoD: adapter supports the domain repositories needed for setup, package, participant, indication, founder, aggregate, acknowledgment, audit, and notification flows; contract tests prove idempotency, uniqueness, immutable history, non-disclosure failures, and aggregate consistency.

  Retirement mapping: Replaced by `TASK-013` through `TASK-019`.
