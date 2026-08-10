# Investor App Hypermedia Contract

Status: `0.1` preview

Investor App URLs identify application resources, not separate HTML pages and JSON endpoints. The request `Accept` header selects the representation for the current caller and resource state.

## Representations

Human interface:

```http
GET / HTTP/1.1
Accept: text/html
```

Versioned hypermedia JSON:

```http
GET / HTTP/1.1
Accept: application/vnd.aittadb-invest+json; version=0.1
```

`application/json` is accepted as a compatibility request. JSON responses report the selected contract in `Investor-App-API-Version` and `api_version`. An explicit unsupported vendor-media version returns `406 Not Acceptable` instead of silently selecting another contract.

Representation selection never uses `User-Agent`. Responses that can vary by representation include `Vary: Accept`.

## Equivalent Capabilities

| Resource concept | Hypermedia JSON | HTML |
| --- | --- | --- |
| Current state | `data` | Text, values, lists, and tables |
| Relationship | `links` entry | Link |
| Available transition | `actions` entry | Link, form, or button |
| Accepted input | Typed action `fields` | Labeled form controls and validation attributes |

Both representations must call the same identity, authorization, validation, domain, and repository services. HTML is not a demonstration client, and JSON is not a reduced export.

## Document Shape

The public campaign resource currently has this shape:

```json
{
  "api_version": "0.1",
  "type": "investment-pre-registration",
  "id": "northstar-robotics",
  "data": {
    "published": true,
    "name": "Northstar Robotics",
    "phase_label": "Investment pre-registration",
    "status": "open",
    "status_label": "Pre-registration open",
    "participation_paths": ["investor", "founder"],
    "interest_is_binding": false
  },
  "links": [
    {
      "rel": ["self"],
      "href": "https://example.com/"
    }
  ],
  "actions": [
    {
      "name": "sign-in",
      "title": "Register your interest",
      "method": "GET",
      "href": "https://example.com/signin-with-chatgpt?return_to=%2F",
      "type": "text/html",
      "fields": []
    }
  ]
}
```

`data` contains the state visible to the current caller. Links use stable semantic `rel` values and server-supplied targets. Actions use stable semantic names and describe only transitions available now.

## Participant Resources

A subject-authorized participant extends `GET /` with the `participant-home`
link relation and `open-participant-home` action. When a current package is
available to that subject, the root also includes the `private-package` link
relation and `read-private-package` action. These controls replace signed-out
registration actions for that caller. A separately authorized owner-participant
also retains `manage-campaign`.

`GET /participant` has resource type `participant-home`. Its `data` contains the
authorized account label, declared interest and participation context, account
status, public campaign name, and a bounded current-package status projection.
The resource links back to the public campaign and, when available, to
`/participant/package`. Its currently supported actions are
`read-private-package`, `manage-campaign` for a separately authorized owner, and
`sign-out`.

`GET /participant/package` has resource type `private-package` and exposes the
current version's bounded status metadata: creation time, change summary,
material-change flag, and whether renewed acknowledgment is required. It links
to the participant home and campaign. Package sections and acknowledgment
mutations remain governed by their own content and mutation contracts; this
resource does not infer package body content from public campaign input.

`GET /participant/package/acknowledgment` has resource type
`participant-package-acknowledgment`. It reports the trusted current version,
the configured acknowledgment text, whether the requirement is satisfied, and
the participant's latest immutable evidence when present. When renewed
acceptance is required, HTML and JSON expose the same
`acknowledge-current-package` `POST` action with only a server-issued operation
ID. Subject, package version, hashes, acceptance time, and repository revision
are server-derived and are never action fields. A satisfied resource exposes no
mutation action or CSRF proof. Production navigation and persistence are added
only when the hosted package capability is composed.

`GET /participant/profile` has resource type `participant-profile`. It reports
the provider-managed account label, four editable participation declarations,
required process-notice acknowledgment, independent marketing-consent and
deletion-request states, record timestamps, revision, and the trusted current
package acknowledgment status. Depending on current state, it exposes separate
`update-participant-profile` `PATCH`, `withdraw-marketing-consent` `DELETE`, and
`request-account-deletion` `POST` actions. Identity, process acknowledgment,
consent grant, deletion system state, and timestamps never become action fields.
Each mutation carries a server-issued operation ID and exact expected revision,
and completed one-way actions disappear from both HTML and JSON. Production
navigation and persistence are installed only by the hosted participant
composition.

These participant URIs negotiate HTML and version `0.1` hypermedia JSON. A
signed-out JSON request receives `401 authentication_required`; an authenticated
subject without matching participant state receives the same generic `404`
shape as a missing record. Unsupported explicit versions return `406` before a
representation is selected.

Mutation actions will also declare their request media type and typed fields. Fields can describe body, path, query, or header location; required state; sensitivity; current or default value; allowed choices; and length, numeric, or byte constraints.

Framework-independent action definitions are the common source for machine controls and browser forms. Version `0.1` supports `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`, plus `text/html`, `application/x-www-form-urlencoded`, and `application/json` action types. String, integer, boolean, and choice fields are bounded before publication, and sensitive fields never include advertised current or default values.

Fields may mark server-issued operation and revision values with `presentation: "hidden"`; this affects only the HTML control and does not make the value an authorization boundary. A configured choice can declare `multiple: true` and publish its selected `values`. Native forms submit that field repeatedly, and the mutation guard accepts repeated values only for names explicitly allowlisted by the owning route. Unlisted duplicate form fields remain invalid.

A native form projection is available when a `GET` action has query fields or a mutation uses form-encoded body fields. Because HTML forms submit only `GET` or `POST`, form models carry the effective `PUT`, `PATCH`, or `DELETE` method explicitly while retaining the same action name, target, fields, and constraints as JSON. Actions requiring JSON, path substitution, or caller-supplied headers are machine controls until an equivalent human interaction is implemented; they must not be presented as native-form parity.

Browser mutation forms also receive a server-generated hidden CSRF proof. The request guard removes CSRF and effective-method transport fields before feature input validation. JSON mutations carry the proof in the designated request header and use the advertised HTTP method directly. Both forms require the same trusted session, exact allowed origin, expiry, body bounds, feature authorization, and domain preconditions.

## Participant Founder Interest

`/participant/founder-interest` is the canonical resource for the authenticated participant's founder application. Its HTML and JSON representations expose the same current fields, received or withdrawn status, revision, and immutable history without publishing the participant subject or persistence identifier.

The resource type is `participant-founder-interest`. It links to itself with `self` and to the public campaign with `campaign`. Depending on current state and injected campaign policy, it exposes these actions:

- `create-founder-application` with `POST` when no application exists and creation is allowed;
- `edit-founder-application` with `PATCH` while the application is received; and
- `withdraw-founder-application` with `DELETE` while the application is received.

Create and edit accept bounded expertise, intended contribution, configured primary and secondary contribution areas, availability, start timing, compensation expectation, HTTPS professional-profile links, and an optional note. Every mutation carries a server-issued `operation-id`; edit and withdrawal also carry `expected-revision`, and withdrawal requires explicit confirmation. Form method overrides and CSRF fields are transport values removed before this feature input is parsed.

The route obtains a participant-bound application service from an injected factory. The trusted route or mutation actor selects that factory; body fields cannot select a subject. In the hosted runtime, the exact founder path is available only to an active non-owner profile declaring founder or combined interest. Configured contribution choices come from private campaign setup, while publication, phase, country, profile, and unchanged-choice policy are rechecked immediately before create. A closed phase removes create without preventing an existing application from being read, edited, or withdrawn.

HTML and JSON mutations use the same origin-bound, actor-bound, one-use browser proof. The founder route narrows the shared mutation envelope and is the only route that permits repeated `secondary-contribution-area-ids`. Founder mutations call only the subject-bound founder repository, so an account's investment indications and aggregates are neither prerequisites nor side effects.

## Owner Investment-Indication Moderation

`GET /owner/investment-indications` exposes a bounded owner-only collection with opaque review identifiers. It accepts only `page_size`, bounded from 1 through 100, and an optional opaque `cursor`. Summary data includes indication kind, lifecycle, amount, currency, revision, update time, and manual-notification state; internal indication identifiers and participant subjects do not enter collection links.

`GET /owner/investment-indications/{review-id}` exposes the permitted private detail and immutable transition history to the configured owner. An active indication backed by the required strong repository capability advertises `reject-investment-indication`. The `POST` action carries a hidden server-issued `operation-id`, hidden `expected-revision`, and one participant-visible multiline `reason` bounded to 500 characters. HTML forms and version `0.1` hypermedia actions derive from the same contract, and JSON clients receive CSRF discovery in the designated response header only while a mutation is available.

Rejection is terminal. One atomic repository operation must persist the rejected indication revision, remove its active aggregate contribution, update the aggregate snapshot, append closed owner audit evidence, and create a bounded manual-notification template for the participant. Stable retries return the original result; stale decisions fail their revision precondition; a failed transaction changes none of the four histories. If the repository cannot advertise `atomic-indication-aggregate-audit-notification`, the detail remains readable but has no reject action and direct mutation fails closed.

Anonymous requests receive the authentication transition, while every authenticated non-owner and missing review identifier uses the non-disclosing not-found surface. Collection and detail responses are private, non-cacheable, use the canonical deployment origin, and never infer authorization from an omitted or present control.

## Owner Activity Resources

`GET /owner/audit-events` exposes a finite owner-only collection of allowlisted
audit evidence. `page_size` is bounded to 1 through 100, and an opaque `cursor`
selects the next page. Event data includes occurrence time, trusted actor type,
and the closed resource-transition, export-class, or notification-activity
detail. It has no field for export contents, notification templates, arbitrary
notes, credentials, or internal causes.

`GET /owner/manual-notifications` pages bounded private notification summaries.
`GET /owner/manual-notifications/{notification-id}` exposes the selected
template, its copy history, and its independent sent marker to the configured
owner. The detail advertises `record-notification-template-copy` while the copy
history limit permits another entry, and advertises `mark-notification-sent`
only until a sent marker exists. Both are `POST` actions carrying hidden,
server-issued `operation-id` and `expected-revision` fields.

HTML and version `0.1` hypermedia JSON come from the same collection or detail
resource. When a detail has a mutation, both representations return a validated
CSRF proof: native forms receive a hidden field and JSON clients receive the
designated response header. Mutation bodies accept exactly the advertised
fields after transport values are removed. A copy action and sent action commit
their notification revision and distinct allowlisted audit event through the
same atomic repository capability; the route fails closed if that capability is
not present.

## Participant Investment Interest

`/participant/investment-interests` is the authenticated participant's collection. `/participant/investment-interests/{id}` is one participant-owned indication. Both URIs negotiate native HTML and versioned hypermedia JSON from the same capability models, authorization decision, validation, and repository services. Collection data includes bounded current summaries; item data includes the current personal or company fields and immutable revision history without participant subjects, owner identity, acknowledgment hashes, or storage keys.

The collection may expose:

- `create-personal-investment-interest` with `POST` when personal creation is permitted, no personal indication is currently active, and the current package acknowledgment is valid; and
- `create-company-investment-interest` with `POST` when company creation and current acknowledgment are permitted.

An active item may expose `edit-investment-interest` with `PATCH` when the current package acknowledgment is valid and `withdraw-investment-interest` with `DELETE`. A withdrawn item may expose `reactivate-investment-interest` with `POST` when renewed acknowledgment and deployment policy permit it. A rejected item exposes no participant mutation action.

Create and edit use exact kind-specific fields. Personal fields are residence country, configured integer-minor-unit amount, availability period, and optional note. Company fields additionally include company name, registration country, normalized local identifier, representative name, and an explicit authority declaration. Every mutation carries a server-issued `operation-id`; item mutations also carry `expected-revision`, and withdrawal or reactivation requires explicit confirmation. Kind, operation, revision, CSRF, and method-override controls are never authorization boundaries.

The trusted participant selects an injected request-scoped service. Browser input cannot select a subject, package version, acknowledgment, currency, indication ID, permission policy, or timestamp. Company uniqueness conflicts use one fixed response and do not reveal the occupied identifier, record, or participant. Canonical links and action targets derive from deployment `context.resourceUrl`, not the request hostname or a committed instance hostname.

When an investment-interest JSON representation advertises at least one mutation action, its response carries a validated participant-bound CSRF proof in the header named by `MUTATION_CSRF_HEADER`. This applies to initial discovery and to the current resource returned after create, edit, withdrawal, or reactivation. A JSON client echoes that value in the same named request header. The proof and header name are not fields in the hypermedia document; responses with no mutation action omit the proof header. HTML forms obtain the same validated proof and submit it only through their hidden CSRF transport field. If a valid proof cannot be issued, the route fails closed instead of advertising unusable actions.

Investment-interest reads and writes are separate injected capabilities. Reads require only participant-owned `get` and `listOwned` operations. Every write requires `AtomicParticipantInvestmentInterestMutationPort` with the explicit `atomic-indication-aggregate-audit` guarantee: the new indication revision, aggregate projection, allowlisted audit transition, and idempotent retry result are committed together or none are changed. The participant service rejects weaker mutation persistence during composition and validates the closed result before returning it.

## Owner AittaDB Connection Proof

`GET /owner/aittadb-connection` is an optionally injected owner-only resource. When exact issuer discovery satisfies the configured confidential Authorization Code, S256, introspection, and storage-scope contract, both HTML and version `0.1` JSON advertise `verify-aittadb-connection` as a `POST` action with no feature fields. HTML adds the shared hidden CSRF transport value; JSON returns that proof only in the designated response header.

The POST independently requires configured-owner identity, exact origin, trusted owner session, and CSRF before discovery. Its `303` enters the standards-defined AittaDB authorization endpoint. The protocol redirect transports OAuth state and a PKCE challenge as required, but application documents never serialize those values.

`GET /owner/aittadb-connection/callback` is the standards-required Authorization Code redirect handler. It consumes the exact encrypted transaction cookie and state, atomically claims a one-way replay fingerprint, performs confidential token exchange and introspection, and returns only `owner-aittadb-connection-result`. Success and failure resources omit all callback query parameters and credentials. The cookie is cleared on success, failure, denial, unsupported representation, and wrong method where possible. It is a protocol exception that consumes one-time artifacts and records closed proof; it is not advertised as an application mutation action. The ordinary connection-resource GET never initiates or mutates the flow.

The default Worker does not inject this route. Its presence proves only that hosted configuration deliberately supplied the capability; every request still enforces owner authorization. See `docs/AITTADB_OAUTH_PROOF.md` for the hosted boundary and remaining live proof.

## Owner Campaign Presentation

`GET /owner/campaign` is the configured owner's public-presentation workspace. Its `owner-campaign-editor` document contains the current campaign revision, saved publication state, explicit publication-readiness result, mutation-consistency capability, and complete validated public campaign draft. It links to the owner home, live campaign, and `/owner/campaign/preview` when a setup exists. An authenticated non-owner gets the same generic `404` surface before the privileged campaign repository is read.

When the injected repository guarantees `atomic-campaign-audit`, the resource exposes `save-campaign-presentation`. Hypermedia JSON describes a real `application/json` command with `operation-id`, `expected-revision`, and one `public-campaign` object. Native HTML renders bounded, labeled, repeatable controls for the same public campaign object; it does not expose raw JSON editing. Both transports pass through the same public-campaign parser and owner service.

The browser mutation session applies a 262,144-byte editor wire ceiling before form proof extraction or body parsing. The feature parser then bounds the decoded public campaign to 65,536 UTF-8 bytes. This separation keeps a valid percent-encoded UTF-8 form submittable without widening setup, package, profile, or participant routes.

An unpublished campaign exposes `publish-campaign` only when every phase setup is complete and the deployment's explicit readiness capability reports ready. A published campaign always exposes `unpublish-campaign`, including when readiness later becomes false. Direct publication requests repeat the same readiness decision. Presentation saves preserve the current publication flag, phase settings, and amount/aggregate policy.

Every mutation requires a trusted owner subject, exact configured origin, current CSRF proof, exact or allowlisted bounded fields, server-issued operation ID, and expected revision. Before chunk staging, a bounded immutable intent binds that operation ID to the normalized setup reference, revision pair, timestamp, mode, and audited actor/transition. Changed retries conflict before another chunk or final transaction; exact retries can resume after a restart or a lost response. Private normalized setup bytes are then staged as immutable content-addressed records no larger than 61,440 bytes. One final transaction commits current revision metadata, immutable history metadata, direct operation metadata, the public-only presentation projection, and the allowlisted audit event. Failed staging can leave only the intent and unreachable immutable chunks; it cannot make a revision visible. Intent, chunk-stage, and final transaction results require closed envelopes, a boolean replay flag, and the exact records in mutation order, including keys, revisions, and values. Repository code accepts `created` only for an absent campaign becoming an unpublished revision-one draft, then derives and verifies `updated`, `published`, and `unpublished` from the prior and next publication states; callers cannot mislabel an audit transition. Stable retries use direct operation lookup and the route re-reads current state before returning capabilities.

`GET /owner/campaign/preview` derives JSON and HTML from the same visitor capability projection. JSON reports the source revision and saved publication state with the visitor data and actions. HTML renders that campaign through the public application with owner and participant capabilities suppressed and a visible saved-revision/live-publication banner. Preview never changes repository state.

`createApplicationWorker` can accept a trusted campaign-workspace composition containing the owner repository, public projection reader, browser mutation session, readiness check, and operation capabilities. Tests may inject that workspace directly. In production, the hosted application resolver derives it centrally from named repository-factory capabilities over one credential-bound AittaDB adapter. Setup and campaign editor handlers are installed only in the owner route group; the runtime itself never enters route context or rendering. Missing, partial, or malformed hosted values leave those routes absent. Public requests use only the separately stored public presentation projection and never call privileged setup reads. A scalar development campaign is ignored whenever any hosted application-runtime value is present.

## Owner Review Exports

`GET /owner/exports` is the private export workspace. HTML and version `0.1`
hypermedia JSON come from one owner-authorized resource and expose the same two
CSRF-protected actions:

- `download-review-csv` posts a server-issued `operation-id` to
  `/owner/exports/review.csv`; and
- `download-json-backup` posts a server-issued `operation-id` to
  `/owner/exports/backup.json`.

The POST returns its attachment directly after the shared owner, exact-origin,
CSRF, and exact-body checks pass. A GET to either attachment URI is
side-effect-free and returns `405`; it does not read private repositories or
append audit evidence. HTML forms and JSON actions derive from the same action
contracts, while the CSRF proof stays in its transport header or hidden form
field rather than entering the hypermedia document.

The output-specific resources accept their declared media type, a matching type
wildcard, or `*/*`; unsupported media returns `406` before source data is read.
The CSV contains current participant, investment-indication, and founder review
rows. The JSON file is a versioned current-state projection of campaign setup,
information-package content, those review records, and private aggregate state.
Both formats bound page size, total records, history entries per record,
serialized bytes per record, total bytes, and encoding memory. A violated bound
returns `413` before attachment headers or partial content. Successful responses
use fixed non-campaign filenames and private no-store headers.

Every successful export generation has one verified immutable `export-created`
audit event committed before its byte stream is exposed. The event contains the
export class and trusted owner subject, never a content fingerprint, source URL,
filename, row, backup document, participant field, package content, or backend
identifier. The audit fact records generation, not browser delivery or receipt.

An operation with existing audit evidence is single-use. Its replay returns
`409` before source repositories are read or another audit append is attempted,
whether or not current data changed; the owner must discover a fresh
server-issued operation ID. Pagination-integrity or guaranteed-audit failures
return a fixed private error without partial content.

## Identity and Authorization

The signed-out campaign document contains only public state and sign-in transitions. A valid participant session can add links and actions for the private package and that participant's records. The participant decision starts with a parsed trusted account and a credential-bound state reader; query, form, JSON, and client-supplied participant headers cannot assert the subject or package grant. An owner session can add owner operations only after a separate owner authorization decision.

Omitting a control is not authorization. Every target independently enforces identity, actor role, resource ownership, workflow state, same-origin and CSRF rules for browser mutations, and input validation. Inaccessible foreign records use the same non-disclosing response as missing records.

## Owner Information Package

`GET /owner/package` is the configured owner's information-package workspace. Its `owner-information-package` document reports the current immutable version metadata, acknowledgment text, ordered section state, workspace links, and only the controls available at the current revision. Section content and controls are private and are never returned to anonymous or foreign callers.

The top-level `create-package-section`, `update-package-settings`, and `preview-information-package` actions correspond to the HTML create form, settings form, and preview link. Each embedded section supplies `update-package-section`, `set-package-section-availability`, and, when another position is available, `move-package-section`. HTML forms and JSON action descriptions are projections of those same framework-independent action contracts.

Every mutating action carries a server-issued `operation-id`, the current `expected-revision`, a required bounded `change-summary`, and an optional `material-change` flag. Section actions additionally carry only the fields needed for that transition. HTML keeps operation and revision values hidden, adds the session CSRF proof, and uses the shared `_method` transport field for `PATCH`; the advertised semantic method and accepted feature fields remain identical.

Successful writes create a new immutable package version and return or redirect to the current workspace. An exact delayed retry returns its original repository result without replacing newer state. A changed retry conflicts, a new stale operation fails its revision precondition, and invalid or unsafe Markdown is rejected without echoing submitted private content.

`GET /owner/package/preview` selects HTML or the `owner-information-package-preview` document at the same URI. Preview includes only enabled, non-empty sections from the trusted current snapshot. HTML is generated from the validated Markdown syntax tree, never from raw HTML, and shifts package headings below the page's single `h1`.

## Errors

Application errors use stable codes and generic public messages. They must not include private package content, participant identity, notes, credentials, backend identifiers, or internal causes. HTML presents the same recovery links or forms supplied as JSON `links` and `actions`.

## Protocol Exceptions

OAuth 2.0 and OpenID Connect endpoints keep their standards-defined media types and response structures where wrapping them would break interoperability. Application resources around those protocol operations still follow this hypermedia contract.

## Route Definition of Done

Every new human-facing resource must include:

1. One canonical URI.
2. HTML and versioned JSON projections from the same authorized domain state.
3. Equivalent links, forms, and actions for the same caller.
4. Content-negotiation, authorization, negative-path, and non-disclosure tests.
5. `406` behavior for unsupported explicit contract versions.
6. Documentation for stable resource type, link relations, action names, and fields.
