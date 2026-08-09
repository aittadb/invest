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

The reusable Investor App software is experimental. Its public AittaDB development instance is available at [invest.aittadb.com](https://invest.aittadb.com); that hostname and its campaign content are deployment configuration, not application defaults. The instance is not production-ready while authenticated workflows and production persistence remain unfinished.

The public source must not hard-code any reference campaign, person, country, currency, funding target, legal entity, country rule, private package content, or private campaign decision.

Version one collects non-binding interest only. It does not accept money, reserve shares, calculate ownership, promise allocation, sign agreements, collect formal KYC/KYB material, or create a securities offer.

## Stack

- ChatGPT Sites / Vinext
- React server components
- Cloudflare Worker-compatible ESM build
- AittaDB-compatible identity and storage adapters for production
- Deterministic in-memory/test storage adapter before production integration

The current scaffold intentionally does not declare local D1 or R2 bindings in `.openai/hosting.json`. Production publication remains blocked until the configured backend passes this app's authorization, consistency, listing, pagination, quota, and non-disclosure contract tests.

Each application URI supports equivalent human HTML and versioned hypermedia JSON selected through `Accept`. See [docs/HYPERMEDIA_API.md](docs/HYPERMEDIA_API.md) for the media type, document structure, authorization rules, and route definition of done.

### AittaDB OAuth proof status

The source includes an optionally injected, owner-only confidential Authorization Code with PKCE boundary for development verification. The default production Worker does not install it and contains no OAuth client, secret, cookie key, hostname, owner, or scope default. See [docs/AITTADB_OAUTH_PROOF.md](docs/AITTADB_OAUTH_PROOF.md) for its route and hosted-secret contract.

TASK-030 remains open. As observed on August 9, 2026, [aittadb.com](https://aittadb.com/) reports `features.oauthApps=false`, and its [discovery document](https://aittadb.com/.well-known/openid-configuration) does not advertise authorization, token, or introspection endpoints. This commit is injected callback infrastructure only, not hosted proof.

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
npm run lint
npm run typecheck
npm test
npm run build
npm run sites:package
npm run validate
```

`npm run build` works from a clean checkout with the inert hosting example. Before packaging or publishing, create an ignored `.openai/hosting.json` containing the exact Sites project identifier for that deployment; `npm run sites:package` refuses to proceed without it.

## Planning Workflow

Before repository-affecting implementation, add or amend one unchecked `PLAN.md` task. Keep tasks small: one primitive, route group, security control, UI flow, storage contract, or narrowly bounded proof per task. Record only direct dependencies. Ready tasks may proceed concurrently in isolated branches and Git worktrees, with one focused task per worktree. Completed tasks move to `CHANGELOG.md` with evidence and are removed from `PLAN.md`.

## License

Source-available under `FSL-1.1-MIT`. Each released version converts to MIT on the second anniversary of that version's publication date. See [LICENSE.md](LICENSE.md).
