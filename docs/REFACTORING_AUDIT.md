# Source Refactoring Audit

## Scope

This audit evaluates the current TypeScript and React source against the
semantic-unit, typed-boundary, React, testability, and shared-hot-spot rules in
`AGENTS.md`. It is a source-only planning artifact: it neither changes
application behavior nor authorizes a broad rewrite.

The audit covered `app/`, `domain/`, `http/`, `repositories/`, `services/`,
`worker/`, their direct consumers, and paired tests. Large security and
persistence modules were assessed by responsibility and protocol boundary, not
by line count alone.

## Accepted Follow-ups

### TASK-167: Public campaign presentation persistence

`StoragePublicCampaignPresentationReader` and its public-presentation codec
currently live in `repositories/in-memory-campaign-repository.ts`, a module
that also owns campaign mutation and development compatibility implementations.
The production reader is consumed by
`repositories/storage-public-campaign-state-reader.ts` and
`repositories/storage-application-repository-factory.ts`.

The follow-up moves this public-only storage reader and its complete v4/v5
codec to a storage-owned module. It must preserve public publication gating,
atomic write verification, malformed-record failure behavior, and
non-disclosure. Its owned file group is the legacy campaign repository, the
new storage reader module, the public-state reader, the storage factory,
architecture documentation, and focused campaign/public-state tests.

### TASK-168: Owner indication review collection persistence

`StorageOwnerIndicationReviewCollectionRepository` is a distinct
owner-authenticated collection boundary inside the 3,615-line
`repositories/in-memory-indication-repository.ts`. It owns sealed cursor
binding, bounded storage-page validation, and review-summary materialization,
but production moderation composition imports it through that development-named
module.

The follow-up moves the collection and only the cohesive helpers it needs to a
storage-owned module while preserving the existing service contract. Its owned
file group is the legacy indication repository, the new collection module,
owner moderation composition, the storage factory, architecture documentation,
and focused collection and moderation tests. It must preserve exact owner
authorization, cursor binding, terminal/current/lease verification, bounded
reads, corruption handling, and non-disclosing failures.

Implementation mapping found that this extraction consumes a shared verified
indication-read codec used by collection, detail, rejection, and participant
paths. TASK-171 establishes that neutral storage-owned codec first. TASK-168
then consumes it and remains a narrow collection-only move; this is a direct
contract dependency, not a preferred ordering rule.

### TASK-169: Public campaign rendering components

`app/page.tsx` currently combines request-header and identity resolution with
the published campaign header, hero, aggregate, information sections, footer,
and unavailable state. Those rendering regions have stable typed input and can
be tested without request APIs.

The follow-up keeps data resolution in `app/page.tsx` and moves pure rendering
to feature-owned public-campaign server components. Its owned file group is
`app/page.tsx`, `app/public-campaign/`, and rendered-HTML tests. It must
preserve one `h1`, all current navigation and action behavior, published and
unavailable states, aggregate display, accessibility, and responsive HTML.

### TASK-170: Worker request-capability composition

`createApplicationWorker` currently resolves runtime, role, path, package,
campaign, participant, owner, and OAuth capabilities in its request `fetch`
method before dispatch and rendering. This couples routing, authorization-aware
dependency assembly, and runtime header projection in one central hot spot.

The follow-up introduces one typed request-capability result in a dedicated
Worker composition module. `createApplicationWorker` retains request
normalization, dispatch, image handling, and framework fallback. Its owned
file group is `worker/application-worker.ts`, the new composition module,
focused composition tests, and narrowly required dispatch tests. It must
preserve injected-route precedence, actor and owner isolation, fail-closed
unavailable capabilities, advertised-action parity, and all existing route
behavior.

## Rejected Candidates

### Deterministic storage test-adapter consolidation

The apparent duplication does not support a shared adapter task. Seven
test-local classes with the same broad name and the existing shared adapter
have intentionally different authorization predicates, cursor formats,
counters, audit-rejection behavior, and transaction instrumentation. Combining
them would create a shared test hot spot across unrelated repository suites.
The local fixtures remain the clearer boundary.

### Generic Worker mutation-session adapter

`BrowserMutationSession` already provides the typed session boundary. Its
callers intentionally supply distinct body limits, repeated fields, replay
validation, and exact-replay scopes. A generic wrapper would hide
security-sensitive policy behind indirection without a second protocol or a
demonstrated common implementation. Re-audit only if a genuinely distinct
mutation-session protocol is introduced.

### Other large security and persistence modules

No other candidate met the small, independently owned threshold. Their current
size is justified by coupled validation, replay, authorization, and bounded
transaction behavior; splitting them now would not establish a safe, testable
contract.

## Execution Boundaries

TASK-169 and TASK-170 can run concurrently and each can run alongside the
indication persistence lane. TASK-171 precedes TASK-168 because the collection
must consume its neutral codec contract. The audit and the hosted AittaDB proof
tasks are not implementation prerequisites for these local refactors.
