# AittaDB Investor App Agent Guide

Authoritative for humans and AI agents; read before changing code. Keep this file below 32,000 bytes with `npm run agents:check`. Put rationale in `docs/` instead of expanding this file.

## Purpose and Boundary

Investor App is a configurable ChatGPT Sites app for publishing a private investor information package and collecting non-binding founder applications and investment-interest indications.

- The approved baseline is `docs/AittaDB-Investor-App-Specification.md`.
- The database/server reference is `https://github.com/aittadb/aittadb`.
- AittaDB provides identity, OAuth/OIDC, storage, authorization, and bounded persistence primitives. Investor workflow stays in this repository.
- Do not hard-code any reference campaign, person, country, currency, funding target, legal entity, phase rule, package content, notice, or founder detail into reusable app code.
- Treat the AittaDB campaign as the first production fixture, not as application defaults.
- Treat public hostnames as deployment configuration. Never hard-code one runtime instance's hostname as an Investor App software default.
- Treat the initial owner identity as deployment configuration. Never commit a production owner email or infer owner authority from ordinary sign-in alone.
- This app collects non-binding interest only. It must not accept money, issue shares, calculate ownership, promise allocation, sign agreements, collect formal KYC/KYB material, or present a securities offer.

## Runtime Contract

Use strict TypeScript, Vinext, React, and Cloudflare Worker-compatible ESM. Deployed code cannot require Node runtime APIs, filesystem writes, server processes, or durable memory. Node APIs are only for builds, local scripts, and tests.

Required runtime settings are listed in `.env.example`. Secrets must never be returned to browsers, included in exports, committed, logged, or edited as ordinary campaign content.

Keep real Sites project identifiers in ignored `.openai/hosting.json` files, one per deployment worktree. Track only `.openai/hosting.example.json`. A clean checkout may build with the inert example, but Sites packaging and publication require the exact active binding.

Production persistence must use AittaDB. Browser storage, process memory, local files, direct Sites D1 tables, and temporary hosted storage are not production substitutes. Development may use a deterministic in-memory/test adapter, and the production AittaDB adapter must pass the same contract tests.

## Architecture Rules

Write simple, strongly typed TypeScript and React suitable for ChatGPT Sites. Optimize for clarity, maintainability, testability, and independently owned feature work rather than cleverness or short-term convenience.

### Semantic Units and Feature Ownership

- Keep files as small as reasonably possible while preserving semantic cohesion: one clearly named responsibility, not an arbitrary line-count target. Do not create oversized components, services, hooks, configuration, or catch-all modules, and do not fragment trivial logic into meaningless one-line files.
- Organize by feature or domain where practical. Keep a feature's components, types, hooks, services, and tests near one another, and use precise names instead of dumping grounds such as `utils.ts`, `helpers.ts`, `types.ts`, or `components.ts`.
- Prefer adding or changing feature-owned files over expanding unrelated central files. Do not combine unrelated work merely because it is convenient, and keep refactors narrow unless a broader boundary is genuinely required.
- Minimize shared hot spots. Features should normally depend on stable, narrow extension points; when extension registration or composition is needed, make it simple and declarative rather than growing a conflict-prone manual registry.

### Typed Contracts and Extensible Behavior

- Keep domain logic framework-independent and behind narrow repository interfaces. Use the `StorageAdapter` boundary; production uses AittaDB and tests use explicit fakes.
- Define explicit interfaces or named type aliases for meaningful service, repository, adapter, handler, external-data, and component contracts. Program against focused contracts rather than concrete implementations; feature and infrastructure code may depend on core contracts, but core domain logic must not depend on feature implementations.
- Pass dependencies explicitly through parameters, constructors, props, or small factories. Avoid hidden dependencies, mutable globals, implicit singleton state, circular imports, initialization-order behavior, and exports that other units do not need.
- Parse unknown external input with explicit guards and structured APIs, then keep validated internal types simple. Avoid `any`; use `unknown`, narrowing, generics, or domain types. Prefer discriminated unions with exhaustive handling for fixed state sets.
- Do not grow extensible behavior by repeatedly adding feature-specific `if`, `else if`, or `switch` branches to central files. When independently meaningful variants exist, use a proportionate typed strategy, handler, adapter, factory registration, injected service, or small feature module: core owns a stable contract, each feature owns its implementation, and one narrow composition point connects them.
- Do not introduce a plugin framework, DI container, generic registry, or extra abstraction for one simple implementation with no realistic extension need.

### React Components and Testability

- Keep React components focused on one visible responsibility. Prefer composition and explicit typed props over large configurable components with unrelated modes; use subcomponents or registered renderers when variants are independently extensible.
- Separate substantial domain logic, parsing, data access, and state transitions from rendering. Put reusable stateful behavior in focused hooks or services only when that creates a useful boundary; do not add wrapper components or hooks that merely rename one operation.
- Keep state local until several units genuinely share ownership. Make loading, empty, error, unavailable, and success states explicit. Follow the existing Sites and UI rules for semantic HTML, accessibility, focus, layout, styling, and dependency limits.
- Design meaningful units for independent tests. Keep pure logic apart from browser APIs, storage, network calls, timers, and other side effects; put side effects behind narrow replaceable contracts and prefer explicit dependency injection to global mocks.
- Test logic, validation, state transitions, handlers, hooks, and services at their meaningful boundary. Test components through observable user behavior, add regression coverage for defects, and keep fixtures local and small rather than requiring full application initialization or one shared fixture for unrelated suites.

### Domain and Trust Boundaries

- Parse money as integer minor units; never use floating-point arithmetic for amounts. Normalize country and business identifiers deterministically before uniqueness checks.
- Sanitize Markdown and external links before rendering private package content. Every object access must be authorized by participant or owner subject, and every state-changing browser request needs same-origin and CSRF protection before mutation.
- Every mutation affecting indications or aggregates must be idempotent, audit-logged, and retry-safe. Private package content, PII, indication notes, credentials, private totals, audit detail, and exports must not appear in public errors or logs.

### Naming, Simplicity, and Review

- Use precise domain names for files, exports, interfaces, functions, props, and variables. Document exported contracts, extension points, invariants, edge cases, and non-obvious intent with concise TSDoc or comments; keep extension-registration requirements next to their contract or composition point, remove stale comments, and keep examples aligned with actual types and APIs.
- Prefer direct readable code and abstractions around real semantic boundaries or repeated behavior. Do not add a library when the existing platform and dependencies solve the problem clearly, or perform a large rewrite when a bounded change is enough.
- Before coding, identify the feature boundary, the files that truly need change, an existing interface or composition point, and how an independent feature can avoid the same files. Prefer feature-owned additions when that makes ownership clearer.
- During review, treat mixed rendering/networking/persistence/domain components, growing central conditionals, broad shared utilities, concrete implementations imported everywhere, feature logic leaking into core, globally coupled tests, shared hot spots, and indirection without a testability or extension benefit as warning signs. Refactor proportionately toward smaller semantic units, narrow typed contracts, explicit dependencies, and independently owned modules.

## Sites and UI Rules

- Build actual product screens, not marketing placeholders.
- The signed-out root is the current campaign's public pre-registration landing page. Authenticated participant and owner capabilities extend the resource only after server-side identity and role checks.
- Write visible copy for the current visitor, participant, or owner. Never render prompts, task IDs, repository plans, implementation status, stack names, architecture notes, or "features to build" as product copy; those belong in `PLAN.md`, `CHANGELOG.md`, and developer docs.
- Keep the first viewport about the campaign and the participant's decision, not Investor App as a software product.
- Use semantic HTML, one clear `h1`, labels for inputs, visible focus states, stable dimensions, and responsive layouts that do not overlap.
- Use restrained 6-8px radii, clear contrast, no third-party runtime fonts, no trackers, no external client scripts, and no decorative stock imagery.
- Treat configured campaign media as owner-controlled public data. Accept only reviewed HTTPS or root-relative image URLs and account for remote-host privacy before publication.
- Keep letter spacing at `0`. Do not scale body text with viewport width.
- HTML and JSON/API behavior must use the same server-side authorization and validation. Hidden browser controls are never a security boundary.
- Use page-specific CSS classes; avoid broad global selectors that could break generated or embedded tool UIs.
- Do not add a UI framework or dependency unless the task explicitly requires it or the repository already standardizes on it.

Every application URI is a resource, not an HTML-only page. Use `Accept` for representation selection: human HTML and versioned hypermedia JSON must come from the same authorization, validation, domain, and repository services. JSON `data`, `links`, and currently available `actions` must match the state, links, forms, and buttons visible to the same caller in HTML. Never select by `User-Agent`. Explicit unsupported media-type versions return `406`; standards-defined OAuth/OIDC responses keep their protocol formats.

## Planning Workflow

Before repository-affecting implementation, add or amend an unchecked root `PLAN.md` task. Questions, review-only work, and tiny clarification answers do not need a plan item.

`PLAN.md` is a flat unfinished task graph, not a single-worker queue. Each item:

- uses a stable `TASK-NNN` identifier;
- owns exactly one domain primitive, route group, storage contract, security control, UI flow, or narrowly bounded proof;
- fits one focused commit;
- states an objective pass/fail definition of done;
- includes contract, implementation, tests, docs, failures, and validation together when it is an implementation task;
- records direct prerequisites as `Depends on: TASK-NNN` or `Depends on: none`;
- records a concrete external blocker separately when one exists;
- is topologically ordered when that improves readability without implying serial execution.

An empty `PLAN.md` task graph is the valid completed state; keep its heading and workflow guidance even when no unchecked tasks remain.

A task dependency is justified only when the dependent task cannot meet its DoD without consuming the prerequisite's contract, implementation, or validated proof. Similar subject matter, preferred merge order, shared infrastructure, or possible future integration do not by themselves create a dependency. Keep sibling domain modules and repositories behind narrow interfaces so independent lanes remain independently testable.

Every task whose dependencies are complete and which has no external blocker may proceed concurrently. Keep one task in focus per agent worktree, not one task globally. Use isolated branches and Git worktrees, prefer disjoint file ownership, validate each task independently, and integrate complete commits in dependency order. The integrating branch owns the authoritative `PLAN.md` removal and `CHANGELOG.md` evidence update when parallel workers would otherwise race on those shared ledgers.

Split broad work into the smallest coherent increments. Do not combine independent resources, methods, controls, migrations, or live proof matrices in one task. Broad requests first create a decomposition task; add dependency-mapped replacements, then retire the umbrella unchanged in `CHANGELOG.md` with its mapping.

If a proposed task names several independent repositories, routes, use cases, or security controls, split it. A good PLAN item can be reviewed by asking one yes/no question: did this one primitive or bounded proof meet its stated contract? Prefer ten small tasks with crisp DoDs over one umbrella that hides partial progress.

Apply these task-size rules on every PLAN edit and again before implementation:

- one item produces one independently observable state transition, artifact, route/resource contract, security control, migration, or bounded proof;
- a route group is one item only when its methods share one authorization and domain contract and cannot be completed or validated usefully in isolation;
- local implementation, hosted acceptance proof, production configuration, production deployment, and post-deployment verification are separate items whenever they can fail or require approval independently;
- the DoD names the exact behavior and evidence that close the item, including bounded failure cases and the validation command, without relying on an undefined phrase such as "complete the workflow";
- an item may be an incremental internal contract behind a narrow interface; it need not make the whole product user-ready, but its own DoD must be complete and independently testable;
- dependencies name only contracts or proof consumed by the item, never every earlier task in the same feature area; remove redundant transitive dependencies;
- when an item grows beyond one focused commit, crosses independent file ownership, or gains a second separately testable outcome, stop and split it before continuing;
- after every split, identify all newly ready siblings and run them in parallel worktrees when write ownership is disjoint.

Task count is not a reason to merge independent work. Small tasks expose progress, reduce review risk, and increase safe parallelism; avoid both artificial serial chains and meaningless fragments that have no standalone contract or proof.

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
- Plan dependency graph: `npm run plan:check`
- Runtime and release secret boundary: `npm run runtime-secrets:check`
- Hosted adapter proof: `npm run --silent hosted-storage:prove`
- Local validation: `npm run validate`
- Sites package build: `npm run sites:package`

Keep commands synchronized with `package.json`, CI, README, and contributor docs.

## Git and Deployment

Use feature branches. Keep intended changes checkpointed with focused commits; do not leave completed work loose in the worktree. For parallel agent implementation, reserve independent PLAN tasks first, use one isolated Git worktree per task, and integrate only reviewed, complete, validated commits after their declared dependencies. Preserve unrelated work. Do not push to `main`, merge, deploy, publish, rotate hosted secrets, or change Sites access without explicit approval.

Production publication is blocked until the configured backend supports the required authorization, consistency, listing, pagination, quota, and non-disclosure behavior and the production adapter passes contract and end-to-end tests.

## Cost-Effective Subagent Execution

This section is authoritative for delegation, subagents, model routing, and reasoning effort. When explicit selection is available, use the exact model IDs `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` with supported `reasoning.effort` values `none`, `low`, `medium`, `high`, `xhigh`, and `max`. When it is unavailable, preserve this hierarchy with the closest available equivalent.

### Main Agent and Delegation

The main agent is primarily the orchestrator, integrator, and final decision-maker, not the default implementation worker. It owns requirements analysis, architecture, task decomposition, dependency ordering, conflict resolution, final review, and validation. For every nontrivial task, it splits coherent workstreams, delegates as much investigation, planning, implementation, testing, documentation, debugging, and review as practical, runs independent work in parallel, waits for needed results, resolves conflicts, and verifies the combined outcome. Subagents should perform most substantive repository work.

The main agent may directly coordinate and decompose work, make small integration changes, resolve returned conflicts, perform final validation, handle inseparable work, or complete a genuinely trivial mechanically verifiable change when delegation would cost more. Do not create agents merely to meet a numeric target. Give one coherent responsibility to each agent; avoid overlapping write scopes unless independent verification is intentional.

Every assignment must state its bounded scope, relevant context, file ownership, constraints, deliverables, acceptance criteria, and required tests. A delegated implementation unit includes its implementation, relevant tests, and documentation. Each subagent returns concise findings or decisions, files inspected or changed, completed work, commands and outcomes, assumptions or unresolved risks, and a recommended next action. It must report uncertainty rather than inventing a conclusion.

### Model Routing

Always choose the least expensive model and lowest reasoning effort likely to complete the assigned work reliably. Route by actual difficulty and risk, not by the main agent's model.

- Use `gpt-5.6-luna` at `low` for file and reference searches, inventories, extraction or classification, log summaries, mechanical formatting or cleanup, straightforward documentation corrections, predefined commands or tests, and tiny verifiable edits.
- Use `gpt-5.6-luna` at `medium` for routine implementation from a precise plan, repetitive multi-file changes, straightforward refactors, conventional tests, documentation synchronized to known behavior, simple transformations, and bugs with a known cause. Use `high` only for a narrow fully specified task with non-obvious edge cases; escalate ambiguous or architectural work instead of repeatedly increasing Luna effort.
- Use `gpt-5.6-terra` at `medium` for ordinary multi-file features, unfamiliar-code exploration requiring interpretation, moderate refactors, routine test diagnosis, approved-architecture implementation, straightforward integration, and review of Luna work when Sol review is unnecessary. Use `high` or `xhigh` for well-scoped cross-module behavior, data flow, state or lifecycle work, concurrency, difficult integration, or multi-component debugging. Do not default to `max`; route judgment-heavy, risky, or ambiguous work to Sol.
- Use `gpt-5.6-sol` at `high` for nontrivial planning, architecture, invariants, independent change or plan review, hard root-cause analysis, security, privacy, authentication, authorization, trust boundaries, public APIs, protocols, schemas, persistence, and intent validation. Use `xhigh` for high-risk architecture or migrations, subtle security or correctness review, multi-system failures, major tradeoffs, or release-critical validation. Use `max` only for exceptional unresolved, repeatedly failing, critical security or data-integrity, or release-blocking problems where a wrong conclusion is especially costly.

Do not delegate ambiguous product, protocol, authorization, data-integrity, concurrency, or cross-cutting architectural decisions to Luna. Do not spend Sol on mechanical implementation that Luna or Terra can reliably perform.

### Default Lifecycle, Escalation, and Concurrency

Unless a change is genuinely trivial, use this lifecycle:

1. A `gpt-5.6-sol` `high` planner defines the workstreams, boundaries, risks, and acceptance criteria.
2. `gpt-5.6-luna` or `gpt-5.6-terra` workers complete independent investigation, implementation, tests, and documentation tasks.
3. A different `gpt-5.6-sol` reviewer independently checks the returned diff and evidence for correctness, missed requirements, regressions, security concerns, and unnecessary complexity.
4. The cheapest capable Luna or Terra worker addresses clear review findings; Sol re-reviews substantial, risky, or architecture-affecting corrections.
5. The main agent integrates, resolves conflicts, runs the full relevant validation suite, and reviews the final combined diff before declaring completion.

Escalate Luna to Terra for broader context or engineering judgment, and Terra to Sol for ambiguity, high risk, architecture, security, or resistant debugging. Route known hard problems directly to Sol; increase reasoning only when it is likely to improve the result. Reuse existing findings rather than repeating exploration. Parallelize only independent scopes, respecting the Planning Workflow's isolated-worktree and disjoint-file-ownership rules; never allow concurrent writers to change overlapping files, shared behavior, or tightly coupled components. Do not create custom-agent configuration solely to restate this policy.
