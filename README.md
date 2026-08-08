# Investor App

Investor App is a configurable ChatGPT Sites application for publishing a private investor information package and collecting non-binding founder applications and investment-interest indications.

The approved baseline is [docs/AittaDB-Investor-App-Specification.md](docs/AittaDB-Investor-App-Specification.md). This repository is the app workflow layer. Persistent production data is expected to live in [AittaDB](https://github.com/aittadb/aittadb), not in campaign-specific source files or browser storage.

## Status

Experimental initial scaffold. This repository is not ready for production campaign publication.

The public source must not hard-code any reference campaign, person, country, currency, funding target, legal entity, country rule, private package content, or private campaign decision.

Version one collects non-binding interest only. It does not accept money, reserve shares, calculate ownership, promise allocation, sign agreements, collect formal KYC/KYB material, or create a securities offer.

## Stack

- ChatGPT Sites / Vinext
- React server components
- Cloudflare Worker-compatible ESM build
- AittaDB-compatible identity and storage adapters for production
- Deterministic in-memory/test storage adapter before production integration

The current scaffold intentionally does not declare local D1 or R2 bindings in `.openai/hosting.json`. Production publication remains blocked until the configured backend passes this app's authorization, consistency, listing, pagination, quota, and non-disclosure contract tests.

## Repository Files

- `AGENTS.md`: authoritative agent and contributor rules. Keep below 32,000 bytes.
- `PLAN.md`: small, accepted, unfinished implementation tasks.
- `ROADMAP.md`: future product direction, not current capability.
- `BACKLOG.md`: unscheduled ideas and deferred decisions.
- `CHANGELOG.md`: completed task history and retired task mappings.
- `docs/ARCHITECTURE.md`: app architecture and storage boundary.
- `docs/STYLE_GUIDE.md`: UI and HTML/CSS guidance.
- `.env.example`: runtime setting names with inert placeholder values.

## Local Development

```sh
npm ci
npm run dev
```

Useful checks:

```sh
npm run agents:check
npm run lint
npm test
npm run build
npm run validate
```

## Planning Workflow

Before repository-affecting implementation, add or amend one unchecked `PLAN.md` task. Keep tasks small: one primitive, route group, security control, UI flow, storage contract, or narrowly bounded proof per task. Completed tasks move to `CHANGELOG.md` with evidence and are removed from `PLAN.md`.

## License

Source-available under `FSL-1.1-MIT`. Each released version converts to MIT on the second anniversary of that version's publication date. See [LICENSE.md](LICENSE.md).
