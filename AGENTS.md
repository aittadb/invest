# AittaDB Investor App Agent Guide

Authoritative for humans and AI agents; read before changing code. Keep this file below 32,000 bytes with `npm run agents:check`. Put rationale in `docs/` instead of expanding this file.

## Purpose and Boundary

Investor App is a configurable ChatGPT Sites app for publishing a private investor information package and collecting non-binding founder applications and investment-interest indications.

- The approved baseline is `docs/AittaDB-Investor-App-Specification.md`.
- The database/server reference is `https://github.com/aittadb/aittadb`.
- AittaDB provides identity, OAuth/OIDC, storage, authorization, and bounded persistence primitives. Investor workflow stays in this repository.
- Do not hard-code any reference campaign, person, country, currency, funding target, legal entity, phase rule, package content, notice, or founder detail into reusable app code.
- Treat the AittaDB campaign as the first production fixture, not as application defaults.
- This app collects non-binding interest only. It must not accept money, issue shares, calculate ownership, promise allocation, sign agreements, collect formal KYC/KYB material, or present a securities offer.

## Runtime Contract

Use strict TypeScript, Vinext, React, and Cloudflare Worker-compatible ESM. Deployed code cannot require Node runtime APIs, filesystem writes, server processes, or durable memory. Node APIs are only for builds, local scripts, and tests.

Required runtime settings are listed in `.env.example`. Secrets must never be returned to browsers, included in exports, committed, logged, or edited as ordinary campaign content.

Production persistence must use AittaDB. Browser storage, process memory, local files, direct Sites D1 tables, and temporary hosted storage are not production substitutes. Development may use a deterministic in-memory/test adapter, and the production AittaDB adapter must pass the same contract tests.

## Architecture Rules

- Keep domain logic framework-independent and behind narrow repository interfaces.
- Use a `StorageAdapter` boundary; production uses AittaDB and tests use explicit fakes.
- Parse unknown input with explicit guards and structured APIs. Avoid `any`.
- Parse money as integer minor units. Never use floating-point arithmetic for amounts.
- Normalize country and business identifiers deterministically before uniqueness checks.
- Sanitize Markdown and external links before rendering private package content.
- Every object access must be authorized by participant subject or owner subject.
- Every state-changing browser request needs same-origin and CSRF protection before mutation.
- Every mutation affecting indications or aggregates must be idempotent, audit-logged, and safe under retries.
- Private package content, PII, indication notes, credentials, private totals, audit detail, and exports must not appear in public errors or logs.

## Sites and UI Rules

- Build actual product screens, not marketing placeholders.
- The signed-out root is the current campaign's public pre-registration landing page. Authenticated participant and owner capabilities extend the resource only after server-side identity and role checks.
- Write visible copy for the current visitor, participant, or owner. Never render prompts, task IDs, repository plans, implementation status, stack names, architecture notes, or "features to build" as product copy; those belong in `PLAN.md`, `CHANGELOG.md`, and developer docs.
- Keep the first viewport about the campaign and the participant's decision, not Investor App as a software product.
- Use semantic HTML, one clear `h1`, labels for inputs, visible focus states, stable dimensions, and responsive layouts that do not overlap.
- Use restrained 6-8px radii, clear contrast, no third-party runtime fonts, no trackers, no external client scripts, and no decorative stock imagery.
- Keep letter spacing at `0`. Do not scale body text with viewport width.
- HTML and JSON/API behavior must use the same server-side authorization and validation. Hidden browser controls are never a security boundary.
- Use page-specific CSS classes; avoid broad global selectors that could break generated or embedded tool UIs.

Every application URI is a resource, not an HTML-only page. Use `Accept` for representation selection: human HTML and versioned hypermedia JSON must come from the same authorization, validation, domain, and repository services. JSON `data`, `links`, and currently available `actions` must match the state, links, forms, and buttons visible to the same caller in HTML. Never select by `User-Agent`. Explicit unsupported media-type versions return `406`; standards-defined OAuth/OIDC responses keep their protocol formats.

## Planning Workflow

Before repository-affecting implementation, add or amend an unchecked root `PLAN.md` task. Questions, review-only work, and tiny clarification answers do not need a plan item.

`PLAN.md` is a flat unfinished queue. Each item:

- uses a stable `TASK-NNN` identifier;
- owns exactly one domain primitive, route group, storage contract, security control, UI flow, or narrowly bounded proof;
- fits one focused commit;
- states an objective pass/fail definition of done;
- includes contract, implementation, tests, docs, failures, and validation together when it is an implementation task;
- is dependency ordered when possible.

Split broad work into the smallest coherent increments. Do not combine independent resources, methods, controls, migrations, or live proof matrices in one task. Broad requests first create a decomposition task; add dependency-ordered replacements, then retire the umbrella unchanged in `CHANGELOG.md` with its mapping.

If a proposed task names several independent repositories, routes, use cases, or security controls, split it. A good PLAN item can be reviewed by asking one yes/no question: did this one primitive or bounded proof meet its stated contract? Prefer ten small tasks with crisp DoDs over one umbrella that hides partial progress.

After a task's DoD passes, remove it from `PLAN.md` and append its unchanged description plus evidence to `CHANGELOG.md`. Do not keep completed PLAN checkboxes.

`ROADMAP.md` is a flat stable `ROADMAP-NNN` future-direction list. `BACKLOG.md` is a flat stable `BACKLOG-NNN` unscheduled-idea list. Neither implies availability or authority to implement. Move work into `PLAN.md` before implementation.

## Definition of Done

Every implementation task completes all relevant parts in the same task:

1. Public interface or contract.
2. Implementation.
3. Automated tests, including negative paths.
4. User and developer documentation.
5. Formatting, linting, relevant tests, and production build validation.
6. Necessary updates to `AGENTS.md`, architecture, configuration, security, and operational docs.

Scale coverage to security risk and blast radius. Before publication, the full specification's end-to-end, legal-boundary, privacy, security, accessibility, storage-adapter, and aggregate-concurrency gates must pass.

## Documentation Set

Maintain `README.md`, `AGENTS.md`, `PLAN.md`, `ROADMAP.md`, `BACKLOG.md`, `CHANGELOG.md`, `LICENSE.md`, `SECURITY.md`, `CONTRIBUTING.md`, `.env.example`, and relevant `docs/` files together with code changes.

README must state experimental status, FSL-1.1-MIT source availability with two-year MIT conversion, Sites/AittaDB runtime dependency, non-binding investment boundary, and production blockers.

## Commands

- Install: `npm ci`
- Develop: `npm run dev`
- Build: `npm run build`
- Test: `npm test`
- Lint: `npm run lint`
- Agent instruction budget: `npm run agents:check`
- Local validation: `npm run validate`

Keep commands synchronized with `package.json`, CI, README, and contributor docs.

## Git and Deployment

Use feature branches. Keep intended changes checkpointed with focused commits; do not leave completed work loose in the worktree. For parallel agent implementation, use isolated Git worktrees and integrate only reviewed, complete, validated commits. Preserve unrelated work. Do not push to `main`, merge, deploy, publish, rotate hosted secrets, or change Sites access without explicit approval.

Production publication is blocked until the configured backend supports the required authorization, consistency, listing, pagination, quota, and non-disclosure behavior and the production adapter passes contract and end-to-end tests.
