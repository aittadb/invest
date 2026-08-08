# Investor App Implementation Plan

This file is the flat queue of accepted, unfinished implementation work. Stable `TASK-NNN` identifiers must not be renumbered or reused.

Each task should be the smallest coherent increment that can finish in one focused commit with an objective pass/fail definition of done. Do not combine independent routes, storage contracts, security controls, UI flows, migrations, or live proof matrices. Completed tasks move to `CHANGELOG.md` with evidence and are removed from this file.

- [ ] TASK-002: Define the framework-independent domain model and repository interfaces. DoD: campaign, phase, content version, participant, acknowledgment, indication, founder application, aggregate, audit, notification, and storage-adapter contracts are documented and typed; no framework or AittaDB HTTP details leak into domain types; focused unit tests cover money integer handling and initial validation boundaries.
- [ ] TASK-003: Implement the deterministic in-memory/test storage adapter. DoD: adapter supports the domain repositories needed for setup, package, participant, indication, founder, aggregate, acknowledgment, audit, and notification flows; contract tests prove idempotency, uniqueness, immutable history, non-disclosure failures, and aggregate consistency.
