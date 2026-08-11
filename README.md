# Investor App

Investor App is a configurable ChatGPT Sites application for publishing a private investor information package and collecting non-binding founder applications and investment-interest indications.

The approved baseline is [docs/AittaDB-Investor-App-Specification.md](docs/AittaDB-Investor-App-Specification.md). This repository is the app workflow layer. Persistent production data is expected to live in [AittaDB](https://github.com/aittadb/aittadb), not in campaign-specific source files or browser storage.

## Create Your Instance

Open [this repository](https://github.com/aittadb/invest) in ChatGPT, add the `@Sites` tag, and use this quick-start prompt:

```text
@Sites Create my own Investor App instance from https://github.com/aittadb/invest.

Interview me with one compact question at a time. Offer 2-4 clear options when useful, mark one as recommended, and accept free-text answers. Cover the non-binding legal boundary, audience and countries, public campaign, investor and founder paths, company and financial information, private information package, owner, privacy, branding, and launch readiness.

Keep campaign names, owner identity, hostnames, targets, countries, branding, content, and phase rules in instance configuration, never reusable source. Before building, show a short review of confirmed settings, assumptions, unresolved decisions, and legal questions. Ask me to approve it, then build the site privately and ask again before public publication.
```

## Status

The reusable Investor App software is experimental. Its public AittaDB development instance is available at [invest.aittadb.com](https://invest.aittadb.com); that hostname and its campaign content are deployment configuration, not application defaults. A completely configured hosted AittaDB runtime now supplies persistent owner setup and campaign-editor routes, while public requests receive only the separately stored published projection. This source implementation is not production-ready until the configured deployment passes the remaining hosted storage, authorization, and launch-readiness proofs.

The public source must not hard-code any reference campaign, person, country, currency, funding target, legal entity, country rule, private package content, or private campaign decision.

Version one collects non-binding interest only. It does not accept money, reserve shares, calculate ownership, promise allocation, sign agreements, collect formal KYC/KYB material, or create a securities offer.

## Stack

- ChatGPT Sites / Vinext
- React server components
- Cloudflare Worker-compatible ESM build
- AittaDB-compatible identity and storage adapters for production
- Deterministic in-memory/test storage adapter before production integration

The reusable source keeps D1 and R2 null in `.openai/hosting.example.json`. A deployment may opt into a D1 binding only for the OAuth connection proof's short-lived replay claims and closed verification evidence; campaign and participant data still belongs behind the configured AittaDB adapter. Production publication remains blocked until that backend passes this app's authorization, consistency, listing, pagination, quota, and non-disclosure contract tests.

The production entry point also includes an all-or-nothing AittaDB application-runtime resolver. It keeps the dedicated service client and bearer tokens behind backend closures; uses AittaDB for durable browser-mutation replay claims, campaign revisions, audit evidence, private manual-notification history, aggregate reconciliation, and public projection; and installs setup, editor, audit, notification, and reconciliation capabilities only in the owner route group. An independent optional `OWNER_INDICATION_REVIEW_KEY` enables the persistent owner indication collection, opaque detail, and atomic rejection resources without exposing storage keys in navigation. Publication remains unavailable unless the deployment supplies the exact non-secret readiness value `DEPLOYMENT_PUBLICATION_READY=true`. A development scalar campaign fixture is considered only when every hosted application-runtime field is absent. See [docs/HOSTED_AITTADB_RUNTIME.md](docs/HOSTED_AITTADB_RUNTIME.md) for the exact ordinary and secret hosted settings.

Each application URI supports equivalent human HTML and versioned hypermedia JSON selected through `Accept`. See [docs/HYPERMEDIA_API.md](docs/HYPERMEDIA_API.md) for the media type, document structure, authorization rules, and route definition of done.

### AittaDB OAuth proof status

The source includes an opt-in, owner-only confidential Authorization Code with PKCE boundary for development verification. The production Worker exposes it only when one deployment supplies a complete exact OAuth configuration, separate hosted cookie keys, and the dedicated D1 proof binding. Missing or malformed values leave the route absent. Reusable source contains no OAuth client, secret, cookie key, hostname, owner, or scope default. See [docs/AITTADB_OAUTH_PROOF.md](docs/AITTADB_OAUTH_PROOF.md) for its route and hosted-secret contract.

TASK-101 remains open until the configured acceptance client completes the hosted callback. The selected acceptance AittaDB build and client support Authorization Code, S256 PKCE, confidential client authentication, and the read-only proof scope, but issuer reachability and the complete callback must still be proven against the deployed Worker; source capability and client metadata alone are not hosted callback evidence.

## Repository Files

- `AGENTS.md`: authoritative agent and contributor rules. Keep below 32,000 bytes.
- `PLAN.md`: small, accepted, unfinished implementation tasks with explicit dependencies.
- `ROADMAP.md`: future product direction, not current capability.
- `BACKLOG.md`: unscheduled ideas and deferred decisions.
- `CHANGELOG.md`: completed task history and retired task mappings.
- `docs/ARCHITECTURE.md`: app architecture and storage boundary.
- `docs/STYLE_GUIDE.md`: UI and HTML/CSS guidance.
- `docs/HYPERMEDIA_API.md`: same-URI HTML and hypermedia JSON contract.
- `docs/AITTADB_OAUTH_PROOF.md`: injected OAuth development-proof boundary and remaining hosted acceptance.
- `docs/HOSTED_AITTADB_RUNTIME.md`: fail-closed production storage, service-client, repository-factory, and mutation-session composition.
- `.env.example`: runtime setting names with inert placeholder values.
- `.openai/hosting.example.json`: inert Sites binding shape for clean checkouts.

## Local Development

```sh
npm ci
npm run dev
```

Useful checks:

```sh
npm run agents:check
npm run runtime-secrets:check
npm run lint
npm run typecheck
npm test
npm run build
npm run sites:package
npm run validate
```

`npm run build` works from a clean checkout with the inert hosting example. Before packaging or publishing, create an ignored `.openai/hosting.json` containing the exact Sites project identifier for that deployment; `npm run sites:package` refuses to proceed without it.

### Legacy ownership migration

Pre-existing participant investment records require one explicit backend migration before hosted investment routes can use them. Prepare a private, complete, sorted manifest under ignored `migration-inventories/`, configure the five `AITTADB_MIGRATION_*` values only in the operator environment with a dedicated namespace-bound `storage.read storage.write` client, and run:

```sh
npm run migrate:legacy-investment-ownership -- --apply --manifest migration-inventories/ownership.json
```

The manifest contains `schemaVersion: 1` and at most 100 sorted `participants`. Each participant supplies its subject, one unique retry-stable operation ID, and the complete sorted set of at most 100 indication IDs with current revision and `active`, `withdrawn`, or `rejected` status. At most four may be active. The command never lists participants, has no browser route, does not use the Sites runtime credential, and prints only counters. Exact reruns resume safely; changed, incomplete, crossed, corrupt, oversized, or over-capacity input fails closed. See [docs/HOSTED_AITTADB_RUNTIME.md](docs/HOSTED_AITTADB_RUNTIME.md#legacy-investment-ownership-migration) for the operator contract. Do not run it against a live namespace without explicit approval and an independently reviewed authoritative inventory.

## Planning Workflow

Before repository-affecting implementation, add or amend one unchecked `PLAN.md` task. Keep tasks small: one primitive, route group, security control, UI flow, storage contract, or narrowly bounded proof per task. Record only direct dependencies. Ready tasks may proceed concurrently in isolated branches and Git worktrees, with one focused task per worktree. Completed tasks move to `CHANGELOG.md` with evidence and are removed from `PLAN.md`; zero open tasks is the valid completed state.

## License

Source-available under `FSL-1.1-MIT`. Each released version converts to MIT on the second anniversary of that version's publication date. See [LICENSE.md](LICENSE.md).
