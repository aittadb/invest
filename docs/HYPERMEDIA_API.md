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

Both participant URIs negotiate HTML and version `0.1` hypermedia JSON. A
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

The route obtains a participant-bound application service from an injected factory. The trusted route or mutation actor selects that factory; body fields cannot select a subject. Founder mutations call only the founder repository, so an account's investment indications are neither prerequisites nor side effects.

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
