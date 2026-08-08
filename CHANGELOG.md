# Changelog

Completed `PLAN.md` tasks and retired planning umbrellas are preserved here. Entries should include the unchanged task description, decisive validation evidence, and any residual uncertainty.

## Unreleased

- **TASK-001:** Establish the initial Sites-compatible repository scaffold. DoD: app package metadata, neutral first screen, runtime environment template, FSL-1.1-MIT license, README, AGENTS, PLAN, ROADMAP, BACKLOG, CHANGELOG, CONTRIBUTING, SECURITY, architecture, style guidance, AGENTS size guard, rendered-output test, lint, test, and production build all exist and pass local validation.

  Acceptance evidence: `npm run validate` passed locally. The run included `npm run agents:check` with `AGENTS.md` at 7,073 bytes out of the 32,000 byte limit, `npm run lint`, `npm run build`, and `node --test tests/*.test.mjs` with one passing rendered-output test. A private-content scan over public repository files found no matches for the sensitive reference-campaign terms identified during review. Residual uncertainty: this is a local scaffold only; no production deployment, AittaDB adapter, owner setup flow, or campaign publication was attempted.
