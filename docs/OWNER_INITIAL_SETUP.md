# Owner Initial Setup

`GET /owner/setup` is the configured owner's private campaign-setup resource.
It negotiates native HTML or Investor App hypermedia JSON version `0.1` from
one capability model. Anonymous callers receive an authentication resource and
authenticated non-owners receive the generic not-found surface before the
campaign repository is read.

The resource contains the current setup revision, publication state, mutation
consistency, objective publication readiness, and all schema-version-4 setup
fields. Those fields are the public campaign presentation, phases and country
rules, amount and aggregate rules, founder contribution choices, legal and
non-binding notices, required process-email and optional-marketing-consent
notices, privacy contact, retention text, and owner review confirmations.

An absent setup contains no campaign content values or reusable defaults.
Hypermedia advertises `create-campaign-setup` with separate bounded
`public-campaign`, `phases`, `amount-aggregate`, and `campaign-policy` objects.
Each structured field advertises the route's 262,144-byte aggregate ceiling;
the route then enforces that ceiling across the complete serialized setup. This
keeps every persisted UTF-8 value representable by the next hypermedia action.
After creation the same fields are advertised by `revise-campaign-setup` with
the current values and revision. Native HTML renders labeled controls and
bounded repeatable rows for the same fields; it never renders a raw JSON input.
The decoded setup remains bounded to 262,144 UTF-8 bytes. Its JSON or
URL-encoded request envelope has a separate 1,048,576-byte wire ceiling because
percent-encoding a valid UTF-8 form can be substantially larger. The session
also applies `OWNER_INITIAL_SETUP_MAX_FIELDS`, so the domain maximum of 32
phases and 64 founder contribution choices remains submittable. Root-relative
campaign media paths and complete 128-character stable IDs use controls that
preserve the domain contract.

## Mutation Contract

Every POST passes through the injected browser mutation session before parsing
or persistence. The session binds its encrypted one-time proof to the trusted
owner subject and exact application origin, then enforces the current
actor-bound CSRF proof, supported media type, route-specific wire size, and
field count. The route then enforces:

- the exact action field set and exact nested JSON object keys;
- a bounded setup serialization and all existing campaign domain parsers;
- a server-issued stable operation ID;
- `expected-revision: null` only for creation and the exact positive revision
  for later saves;
- an unpublished public presentation on creation and an unchanged publication
  flag on revision; and
- a matching trusted owner-session subject.

The injected repository must advertise `atomic-campaign-audit`. Creation uses
the repository's `created` transition; later saves use `updated`. Campaign
current state, immutable history, operation replay evidence, public projection,
and one closed owner audit event therefore commit in one transaction. An exact
retry reuses the original timestamp and result, including when another request
commits that operation between the route's operation, current-state, and save
checks. Changed operation reuse,
published creation, stale revisions, and unavailable atomic persistence fail
without a route-level fallback.

Before setup chunks are staged, a bounded immutable operation intent binds the
normalized setup reference, revision pair, timestamp, audited owner actor, and
transition to the server-issued business operation ID. A changed retry therefore
conflicts before further staging; an exact retry can resume after a restart or a
lost final response. Private setup bytes are stored as deterministic
content-addressed chunks before the final visible transaction. Current, history,
and operation records contain only a validated chunk reference. Failed staging
may leave the intent and unreachable immutable chunks for bounded cleanup, but
it cannot expose a current revision, public projection, or audit event. Intent,
chunk, and final transaction responses must contain only the exact expected
records in mutation order. Every response produced after successful mutation
verification, including parsing, readiness, or storage errors, clears the
consumed proof cookie exactly once.

## Readiness And Preview

Readiness reuses the campaign phase, campaign policy, and deployment checks. In
addition to the fixed blocker classes, the owner resource lists the exact phase
IDs and missing phase or policy requirements. An absent setup reports only
`setup-not-configured`; deployment readiness is not guessed before setup
exists.

`GET /owner/setup/preview` requires the same owner authorization. It derives a
visitor-equivalent representation from the saved public campaign with
publication enabled only in the transient preview projection. HTML uses the
normal public renderer, and JSON includes the same visitor data and actions.
Preview does not write the repository or change the separately stored public
projection.

HTML responses use private no-store headers, external same-origin CSS, a
default-deny Content Security Policy, same-origin form actions, no inline
styles, and the existing same-origin owner repeatable-control script.

## Composition Boundary

The production Worker registers this route only inside its owner route group
after a complete hosted AittaDB application runtime has produced the named
atomic campaign repository and browser mutation session capabilities. The same
credential-bound adapter stores setup history, operation evidence, audit, and
the public projection. A missing or malformed runtime advertises no setup
capability; anonymous and non-owner requests never receive private setup data.
