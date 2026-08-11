# Access Registration

Access registration is an injectable participant resource at
`/participant/registration`. Hosted composition installs it for that exact path
and uses the same capability to resolve an unregistered signed-in non-owner at
`/participant`, using the credential-closed AittaDB repository factory and
browser mutation session. Notice text comes only from the persisted private
campaign policy. The public campaign's registration controls return from sign-in
to `/participant`; HTML receives a non-cacheable `303` to the registration form,
while hypermedia JSON receives a `participant-entry` document whose
`open-participant-registration` action has that same target.

## Representations

`GET` negotiates either human HTML or Investor App hypermedia JSON version
`0.1` from the same capability model. A signed-in non-owner who has not yet
registered receives one `register-participant-access` action. The action accepts:

- display name;
- two-letter self-declared country code;
- founder, investor, or both interest;
- individual or company context;
- a server-derived hidden notice-evidence version for the exact persisted
  campaign-policy revision being displayed;
- acknowledgment of the configured process-email notice; and
- independent optional marketing consent.

The authenticated provider email appears only as a display label. Subject and
account email are absent from mutation fields and always come from the trusted
request actor. Process and marketing notice text is deployment-supplied; the
resource defines no campaign-specific notice defaults. The version and both
displayed texts form one closed server-derived evidence value.

The hidden registration operation ID is also server-issued. Its only accepted
form is `participant-operation:<lowercase UUIDv4>` (58 ASCII bytes); arbitrary
stable IDs, labels, email addresses, or other private text are never advertised
or accepted as registration operation IDs.

After successful registration, both representations show the same current
profile projection, immutable notice-evidence version, exact acknowledged
process and marketing texts, process acknowledgment state, and current
marketing-consent state. Registered HTML and JSON advertise no registration
mutation or mutation proof. The next request to `/participant` reconstructs
authorization from persisted profile, package, and acknowledgment state; it can
then expose the current package and separately composed profile and workflow
controls without trusting the registration response.

## Mutation Boundary

`POST` accepts JSON or URL-encoded form input through either the injectable
hosted browser-mutation verifier or the compatibility mutation guard used by
isolated fixtures. Both paths enforce the exact resource origin, an actor-bound
session and CSRF proof, a 2 KiB body ceiling, at most nine transport fields,
no repeated form fields, an exact application-field allowlist, and participant
rather than owner authority. The exported route limits let hosted composition
narrow `BrowserMutationSession.verifyMutation()` without duplicating values.

When registration is available, HTML receives the validated CSRF proof in its
hidden transport field. Hypermedia JSON receives the same kind of proof only in
the `x-investor-app-csrf` response header; the token and header name are never
serialized into the JSON document. A hosted proof's opaque `Set-Cookie` value
is emitted only as a response header and never enters either response body. A
missing, malformed, or actor-mismatched proof fails closed. A registered
resource has no mutation action and emits no proof.

Once hosted verification succeeds, its one-time proof cookie is expired exactly
once on successful registration and on every later parser, repository, or
rendering failure. Failures before verification do not emit that expiration
cookie. A hosted verifier that omits or malforms the expiration instruction
fails before origin parsing or repository access. Body and field limits run
before the hosted replay capability is claimed and before the participant
repository is opened. Hosted verification also checks the closed operation-ID
shape at that point. A malformed or private-text ID therefore consumes neither
replay authority nor participant storage, and route parsing repeats the check
before repository access for every composition.

The request-scoped repository factory receives the trusted subject and provider
email as a `ParticipantAccount`. Registration delegates persistence to the
`ParticipantRegistrationRepository`. The registration request hash covers the
participant submission and complete notice evidence. An exact operation retry
returns its original snapshot, a changed retry conflicts, and a new duplicate
registration conflicts. Serial retries reuse the persisted registration
timestamp. If two exact requests both observe the missing profile, persistence
treats the timestamp as server-generated metadata, recovers the first immutable
revision after the losing transaction, and returns it as a replay. No
process-memory authority is retained. The operation ID is intentionally not
bound to one browser proof: after a lost response, a fresh one-time proof may
carry the originally advertised opaque ID and recover only that exact persisted
result.

## Notice Evidence And Retries

Hosted composition derives evidence from the exact persisted campaign-setup
revision and the process-email and optional-marketing notices in that revision.
The hidden version has the closed
`participant-registration-notice:v1:<16-digit-revision>` form. It contains no
participant identity and is not accepted as authority by itself.

`POST` compares that version with the current server-derived evidence before
opening any registration write. A malformed version is invalid input. A stale
or unrelated well-formed version takes a read-only recovery path: absent or
different immutable evidence fails the precondition without a participant
transaction. Recovery succeeds only when immutable registration revision 1 has
the same trusted subject, submitted evidence version, operation ID, normalized
registration result, and request hash. It returns that original snapshot and
its original notices even after a campaign-policy update or Worker restart.
Changed retries conflict and cannot associate old acknowledgment with new text.

Each profile and immutable profile revision stores the evidence version,
campaign revision, and exact process and marketing notice snapshots. The
evidence has no separate storage key, so subject identity cannot enter a notice
key. Profile self-service preserves it as a registration-only field. Reading a
later profile validates the current record against its matching latest history
record and then compares its notice evidence with immutable profile revision 1
through one exact bounded read. Coordinated valid-looking changes to current and
latest history therefore cannot replace the registration acknowledgment.

Each notice is bounded to 4,000 UTF-16 code units and 12,000 UTF-8 bytes. A
complete profile storage document is bounded to 30,000 UTF-8 bytes, 64 JSON
nodes, and eight nested levels. Registration still writes only the current and
immutable revision records in one transaction. Its repository request is
bounded to 64,512 UTF-8 bytes, reserving 1,024 bytes for protocol field-name and
envelope expansion; the complete protocol command is tested below 65,536 bytes.
The production adapter additionally enforces the backend's advertised record,
mutation-count, and transaction-byte limits.

Hosted composition reads the full campaign setup only on the registration path
or an unregistered signed-in `/participant` entry request, projects only its
revision and process and optional-marketing notices into the route evidence, and
binds every repository and proof operation to the trusted account subject and
provider email label. Anonymous users and configured owners do not open private
campaign or participant registration storage. A signed-in account sees only its
own missing or current profile.

HTML loads `/participant-registration.css` from the same origin. Registration
responses are non-cacheable, use a same-origin stylesheet and form CSP, set
`X-Content-Type-Options: nosniff`, and return fixed non-disclosing failures.
