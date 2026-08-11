# Investor App Public Use Cases

Status: public implementation baseline
Reference source repository: `https://github.com/aittadb/invest`
Database/server reference: `https://github.com/aittadb/aittadb`

## Purpose

Investor App is a configurable ChatGPT Sites application for publishing a private investor information package and collecting non-binding founder applications and investment-interest indications.

One deployment represents one isolated campaign. Campaign-specific people, brands, text, phases, countries, fields, notices, totals, rules, and information-package content are runtime configuration. Public source fixtures must use synthetic data only.

The app describes and implements product behavior. It must not contain reference-campaign strategy, personal plans, private funding material, participant records, production credentials, or private legal analysis.

## Product Boundary

Version one supports:

- public campaign overview;
- configured sign-in;
- access registration;
- registered-only information package;
- non-binding personal and company investment-interest indications;
- separate founder-candidate applications;
- participant editing, withdrawal, and reactivation;
- public aggregate-interest display when enabled;
- owner setup, content editing, moderation, reconciliation, and export; and
- manual-email templates and notification tracking.

Version one does not:

- accept or hold money;
- reserve shares or guarantee allocation;
- issue securities or create binding rights;
- calculate final investment terms;
- sign investment, employment, founder, shareholder, or asset-transfer agreements;
- collect identity documents, formal due-diligence evidence, or payment details;
- schedule meetings or manage investor negotiations;
- send email automatically;
- provide a general-purpose form builder; or
- implement investor-specific behavior inside AittaDB.

## Actors

| Actor | Public use cases |
| --- | --- |
| Visitor | Read the public campaign overview, visible phase summary, key risk summary, public aggregate-interest summary, and public links. |
| Registered reader | Read the private package and change log; manage account and access profile. |
| Investor participant | Create, edit, withdraw, and reactivate permitted personal or company indications. |
| Founder candidate | Create, edit, and withdraw a separate founder application. |
| Owner | Configure, publish, edit, moderate, reconcile, export, and audit the campaign. |

Every server route independently enforces authorization. Browser-hidden controls are never the security boundary. Failed lookups for records owned by others must be non-disclosing.

## Visitor Use Cases

### UC-VIS-001: View Public Campaign Overview

The visitor can open the public campaign page and see only information marked public by the owner.

The page may show:

- campaign identity and concise summary;
- visible phase status;
- aggregate-interest summary when enabled and non-zero;
- short key-risk summary;
- statement that displayed amounts are self-declared, unverified, and non-binding;
- sign-in or register-to-read action; and
- public privacy, terms, accessibility, and project links.

The page must not expose private package content, participant records, owner data, private totals, exports, or hidden configuration.

### UC-VIS-002: Start Registration

The visitor can start the configured sign-in flow from the public overview. Return paths must stay same-origin and safe. Failed or cancelled sign-in returns a non-disclosing error and a recovery path.

## Registered Reader Use Cases

### UC-REG-001: Complete Access Registration

After first sign-in, the user completes access registration with:

- display name;
- account email supplied by the identity provider;
- self-declared country;
- interest type: founder, investor, or both;
- individual or company context;
- required process-email notice; and
- optional marketing consent.

Access to the private package is immediate after successful registration. Version one has no owner approval, NDA, or reading test.

### UC-REG-002: Read Information Package

The registered reader can browse enabled package sections, change log, and current acknowledgment text. Empty or disabled sections do not render.

Package Markdown must be sanitized. Unsafe URLs, scripts, inline event handlers, arbitrary embeds, and untrusted HTML are rejected.

### UC-REG-003: Review Material Changes

When the owner marks a package version as material, the reader sees that renewed acceptance is required before creating, editing, or reactivating indications. Existing historical records remain visible according to account permissions.

### UC-REG-004: Manage Account

The registered reader can update editable profile details, change declared interest, withdraw marketing consent, review accepted acknowledgment versions, and request account deletion according to the published retention policy.

## Investor Participant Use Cases

### UC-INV-001: Accept Current Acknowledgment

Before creating or editing an indication, the participant accepts the current acknowledgment. The acknowledgment must make clear that the submission is only an expression of interest, is not a payment or commitment, can be edited or withdrawn, and may later require separate review and documentation.

### UC-INV-002: Create Personal Indication

A participant can create one active personal indication when allowed by campaign rules.

The form collects:

- self-declared residence country;
- amount in configured currency;
- availability period;
- optional note; and
- current acknowledgment acceptance.

Amounts use integer minor units internally and must satisfy configured minimum and increment rules.

### UC-INV-003: Create Company Indication

A participant can create company indications when allowed by campaign rules.

The form collects:

- company name;
- registration country;
- local business or registration identifier;
- representative name;
- self-declaration of authority;
- amount in configured currency;
- availability period;
- optional note; and
- current acknowledgment acceptance.

The app enforces one active company indication per normalized country and identifier pair. Duplicate rejection must not reveal who controls the existing record.

One participant can have at most four active indications across personal and company records. Withdrawn and rejected historical indications do not consume this active limit. Persistent ownership materialization requires matching bounded subject root, index, summary, current-head, and terminal-transition evidence; missing, incomplete, corrupt, or continuously changing evidence fails closed without scanning another participant's records.

Persistent ownership must be explicitly initialized or migrated from a complete subject-bound inventory. An immutable subject root, the sorted index, and an at-most-100-entry revision/status summary must all exist and agree with each indication's current record and immutable terminal transition. Every terminal lifecycle is authenticated from its compact operation evidence; create and edit evidence commits the normalized field reference. Every active head additionally verifies that referenced content and the exact derived personal or company uniqueness lease. Missing, crossed, or corrupt leases and correlated metadata or lifecycle damage never become an empty or inactive account. Exact initialization retries remain stable after later valid indication activity, while current ownership evidence is independently revalidated. Production use additionally requires authoritative initialization during first registration and the backend-only credential-closed migration command for every pre-existing participant. That command consumes only an explicitly authoritative bounded inventory, reveals only counters, resumes through exact per-subject retries, and is never exposed through browser or ordinary absence handling. This low-level capacity boundary alone does not make preregistration ready. Capacity evaluation performs no collection scan or ancestry replay and is bounded to 240 storage reads at 100 owned records; first initialization is bounded to 239 reads, initialized restart to 241, and concurrent exact initialization recovery to 479. A production Worker must reserve at least 479 remaining AittaDB read subrequests for this boundary and must use a larger whole-request limit for authentication, token, protocol, and route work.

### UC-INV-004: Edit Indication

The participant can edit permitted fields on their own indication. Every change creates immutable history and updates aggregate totals consistently.

### UC-INV-005: Withdraw Indication

The participant can withdraw an active indication. Withdrawal removes it from public aggregate totals while preserving appropriate history.

### UC-INV-006: Reactivate Indication

The participant can reactivate a withdrawn indication when campaign rules still allow it and the current acknowledgment has been accepted.

## Founder Candidate Use Cases

### UC-FND-001: Create Founder Application

A founder candidate can create a founder application separate from investment indications.

The form collects:

- expertise summary;
- intended contribution;
- primary contribution area;
- optional secondary contribution areas;
- approximate availability;
- possible start timing;
- compensation expectation;
- optional professional profile links; and
- optional note.

### UC-FND-002: Edit or Withdraw Founder Application

The founder candidate can edit or withdraw their own application. Version one shows receipt and withdrawal state only; selection discussions and decisions happen outside the app.

## Owner Use Cases

### UC-OWN-001: Complete Campaign Setup

Before publication, the owner configures campaign identity, public copy, phases, country rules, amount rules, access-registration fields, package sections, acknowledgment text, notices, retention policy, and public display settings.

The public campaign remains unavailable until setup is complete and the owner explicitly publishes.

### UC-OWN-002: Edit Campaign Settings

The owner can revise campaign settings after setup. Changes that alter the meaning of accepted acknowledgments or indications can be marked material.

### UC-OWN-003: Edit Package Content

The owner edits package sections in Markdown with live preview. Every save creates an immutable version with change summary and timestamp.

### UC-OWN-004: Moderate Indications

The owner can inspect submitted indications, reject an active indication with a brief reason, and generate a manual-notification template. Rejection removes the indication from public totals but preserves history.

### UC-OWN-005: Track Manual Notifications

The owner can copy a recipient-specific manual-email template and mark when a notice was sent. The app never sends email automatically and must not mark delivery merely because a template was copied.

### UC-OWN-006: Reconcile Aggregate Totals

The owner can preview aggregate reconciliation by comparing calculated current totals with stored public totals. Applying a correction requires explicit confirmation and is audit-logged.

### UC-OWN-007: Export Review Data

The owner can download sensitive CSV review exports and JSON backups. Export creation is owner-only, audit-logged, and streamed to the owner rather than intentionally retained as an application record.

## Aggregate Use Cases

### UC-AGG-001: Display Sanitized Public Aggregate

The public page can show configured aggregate-interest information when non-zero and enabled.

The public aggregate must not reveal participant identity, notes, hidden fields, owner-only moderation data, or private package content.

### UC-AGG-002: Update Aggregate After Mutations

Create, edit, country change, withdrawal, reactivation, and rejection operations update the current indication and aggregate consistently. If the configured storage backend cannot provide the required consistency behavior, publication remains blocked.

## Security and Privacy Use Cases

### UC-SEC-001: Keep Private Material Out of Source

The repository must contain only public product requirements, synthetic fixtures, source code, and inert example configuration. Private campaign content, participant data, production credentials, exports, and private strategy stay outside Git.

### UC-SEC-002: Enforce Per-Route Authorization

Each route checks authorization server-side for the exact actor and resource. UI visibility is only a convenience.

### UC-SEC-003: Protect Browser Mutations

State-changing browser requests require authenticated sessions, same-origin checks, CSRF protection, bounded request bodies, validation, and non-disclosing failures.

### UC-SEC-004: Avoid Visitor Tracking

Version one uses no visitor analytics or non-essential cookies. Only strictly necessary sign-in, session, anti-forgery, and preference state is permitted.

### UC-SEC-005: Prevent Export Injection

CSV exports must escape values that could be interpreted as spreadsheet formulas. Export filenames and content must not leak secrets or private backend identifiers.

## Technical Use Cases

### UC-TECH-001: Keep Domain Logic Framework-Independent

Domain code depends on narrow interfaces rather than framework request objects, browser storage, or backend transport details.

Expected boundaries include:

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

### UC-TECH-002: Support Test and Production Storage Adapters

Development uses a deterministic in-memory/test adapter. Production uses an AittaDB-compatible adapter. Both must pass the same contract tests for authorization, consistency, uniqueness, histories, aggregates, and non-disclosure behavior.

### UC-TECH-003: Keep Public and Private Surfaces Separate

Public routes return only public campaign state and sanitized aggregate data. Registered routes return package and participant data only to authorized users. Owner routes return campaign administration data only to the owner.

## Release Gate

Version one is ready only when:

1. core flows, permissions, totals, concurrency, and recovery paths pass end to end;
2. configured production identity and storage adapters are working;
3. owner setup succeeds on the production deployment;
4. runtime configuration, origin, redirect URIs, storage permissions, quotas, and privacy contact are verified;
5. campaign content and non-binding acknowledgment are reviewed by the owner;
6. no unfinished or empty optional content leaks into public navigation;
7. security, accessibility, lint, type, test, dependency, secret, and production-build checks pass; and
8. the owner explicitly publishes the campaign.
