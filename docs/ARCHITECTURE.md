# Investor App Architecture

Investor App is a ChatGPT Sites application that uses an AittaDB-compatible backend as its authoritative storage and identity layer. The app owns investor workflow, legal-boundary enforcement, campaign configuration, private information-package behavior, owner operations, and participant-facing forms. The backend owns reusable identity, persistent storage, authorization, quotas, and bounded consistency primitives.

## Initial stack decision

The initial repository uses the Sites Vinext starter with React server components and a Cloudflare Worker-compatible build. It does not declare local D1 or R2 resources in `.openai/hosting.json` because production campaign data must stay behind the configured app storage adapter.

## Runtime boundary

Deployments provide trusted runtime configuration for the canonical app origin, configured identity provider, storage adapter, owner setup, sessions, and anti-forgery protection. Secrets are managed as runtime configuration, not as campaign content.

## Domain modules

The specification expects these narrow boundaries:

- `IdentityProvider`
- `CampaignRepository`
- `ContentRepository`
- `ParticipantRepository`
- `FounderApplicationRepository`
- `IndicationRepository`
- `AggregateRepository`
- `AcknowledgmentRepository`
- `AuditRepository`
- `NotificationRepository`
- `StorageAdapter`

Domain logic should depend on these interfaces instead of framework request objects or AittaDB HTTP details.

## Storage plan

Development can use a deterministic in-memory/test adapter. Production must use an AittaDB-compatible adapter and pass the same contract tests.

Production remains blocked until the configured backend provides the consistency, listing, pagination, quota, authorization, and non-disclosure behavior described in the use cases.

## Publication rule

The public campaign must remain unpublished until owner setup, production storage, authorization, security, accessibility, export, reconciliation, and legal-boundary checks pass end to end.
