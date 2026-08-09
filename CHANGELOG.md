# Changelog

Completed `PLAN.md` tasks and retired planning umbrellas are preserved here. Entries should include the unchanged task description, decisive validation evidence, and any residual uncertainty.

## Unreleased

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

- **TASK-002:** Define the framework-independent domain model and repository interfaces. DoD: campaign, phase, content version, participant, acknowledgment, indication, founder application, aggregate, audit, notification, and storage-adapter contracts are documented and typed; no framework or AittaDB HTTP details leak into domain types; focused unit tests cover money integer handling and initial validation boundaries.

  Retirement mapping: Replaced by `TASK-004` through `TASK-012`.

- **TASK-003:** Implement the deterministic in-memory/test storage adapter. DoD: adapter supports the domain repositories needed for setup, package, participant, indication, founder, aggregate, acknowledgment, audit, and notification flows; contract tests prove idempotency, uniqueness, immutable history, non-disclosure failures, and aggregate consistency.

  Retirement mapping: Replaced by `TASK-013` through `TASK-019`.
