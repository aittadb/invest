# Changelog

Completed `PLAN.md` tasks and retired planning umbrellas are preserved here. Entries should include the unchanged task description, decisive validation evidence, and any residual uncertainty.

## Unreleased

- **TASK-001:** Establish the initial Sites-compatible repository scaffold. DoD: app package metadata, neutral first screen, runtime environment template, FSL-1.1-MIT license, README, AGENTS, PLAN, ROADMAP, BACKLOG, CHANGELOG, CONTRIBUTING, SECURITY, architecture, style guidance, AGENTS size guard, rendered-output test, lint, test, and production build all exist and pass local validation.

  Acceptance evidence: `npm run validate` passed locally. The run included `npm run agents:check` with `AGENTS.md` at 7,073 bytes out of the 32,000 byte limit, `npm run lint`, `npm run build`, and `node --test tests/*.test.mjs` with one passing rendered-output test. A private-content scan over public repository files found no matches for the sensitive reference-campaign terms identified during review. Residual uncertainty: this is a local scaffold only; no production deployment, AittaDB adapter, owner setup flow, or campaign publication was attempted.

### Retired Planning Umbrellas

These entries were removed because their scopes could not finish independently. Their preservation here does not claim that the underlying product work is complete; each retirement mapping identifies the focused current-plan replacements.

- **TASK-002:** Define the framework-independent domain model and repository interfaces. DoD: campaign, phase, content version, participant, acknowledgment, indication, founder application, aggregate, audit, notification, and storage-adapter contracts are documented and typed; no framework or AittaDB HTTP details leak into domain types; focused unit tests cover money integer handling and initial validation boundaries.

  Retirement mapping: Replaced by `TASK-004` through `TASK-012`.

- **TASK-003:** Implement the deterministic in-memory/test storage adapter. DoD: adapter supports the domain repositories needed for setup, package, participant, indication, founder, aggregate, acknowledgment, audit, and notification flows; contract tests prove idempotency, uniqueness, immutable history, non-disclosure failures, and aggregate consistency.

  Retirement mapping: Replaced by `TASK-013` through `TASK-019`.
