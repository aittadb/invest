# Participant Profile Self-Service

Participant profile self-service is an injectable registered-reader resource at
`/participant/profile`. Hosted composition serves it only for that exact path
and advertises it from `/participant` when a signed-in non-owner has a subject-
and email-bound participant-access projection. Every read and mutation uses the
same finite request-scoped participant repository bound again to the trusted
account.

## Representations

`GET` negotiates native HTML or Investor App hypermedia JSON version `0.1` from
one capability model. The route requires all of the following before reading a
profile repository:

- a signed-in non-owner account parsed from trusted request identity;
- an authorized participant projection for that exact subject and provider
  email label; and
- a request-scoped `ParticipantRepository` whose current snapshot belongs to
  the same account and matches the authorization projection.

The resource reports the current profile revision, provider-managed account
email label, four self-declared profile values, required process-notice
acknowledgment status, marketing-consent state, deletion-request state, record
timestamps, and the current package-acknowledgment status. The acknowledgment
status is `required`, `current`, or `package_unavailable`; it comes from the
trusted participant/package authorization projection rather than browser input.
The participant subject is not serialized.

The persisted profile also contains the bounded notice-evidence version,
campaign revision, and exact process and marketing notice snapshots accepted at
registration. That evidence is validated when profile state is reconstructed
but remains registration-only: profile self-service neither advertises nor
accepts it as an editable field.

## Actions

The resource may advertise three independent actions:

- `update-participant-profile` uses `PATCH` and accepts exactly display name,
  country, declared interest, and participation context;
- `withdraw-marketing-consent` uses `DELETE` and is available only while
  optional marketing consent is granted; and
- `request-account-deletion` uses `POST` and is available only before a
  deletion request exists.

Every action includes a separate server-issued `operation-id` and the exact
current `expected-revision`. Consent withdrawal and deletion request each
require their own explicit confirmation. Subject, account email, required
process acknowledgment, registration and update timestamps, consent grant,
notice evidence, and deletion system state never appear as editable action
fields. Marketing consent cannot be granted or restored through this resource,
and a deletion request cannot be cancelled through it.

After deletion is requested, profile editing and another deletion request are
not available. A still-granted marketing consent remains independently
withdrawable. Recording deletion intent does not itself erase retained records.
The subject-bound persistent coordinator stages that profile transition with
any active founder application, every active bounded investment indication,
their aggregate contributions, one closed audit event, and one immutable retry
receipt, then commits all effects or none. Marketing consent remains an
independent later withdrawal. Hosted composition selects this atomic
coordinator only for the deletion action; profile edits and marketing withdrawal
continue through the narrow profile repository. The resulting participant
representation retains only profile viewing, sign-out, and any still-available
marketing withdrawal. Private package, acknowledgment, founder, and investment
resources return the same non-disclosing unavailable surface as other inactive
participant capabilities.

## Mutation Boundary

HTML forms and JSON clients use the same semantic methods and exact fields.
HTML submits `PATCH` and `DELETE` through the shared `_method` transport field.
All writes pass through the generic browser mutation guard before feature input
is parsed. The route additionally requires the request `Origin` to equal the
canonical resource origin and binds the verified participant session subject to
the exact trusted account.

The guard enforces bounded JSON or URL-encoded bodies, a supported content
type, an unexpired actor-bound session, and an expiring CSRF proof. Direct
`PATCH` requests are limited to 2 KiB and six fields, direct `DELETE` requests
to 512 bytes and three fields, and the native-form `POST` transport to 2 KiB and
eight fields including its proof and method override. Repeated form fields are
never allowed. Exact action-field validation runs after transport verification.

HTML carries the proof only in `_csrf`; hypermedia JSON carries it only in the
`x-investor-app-csrf` response header. A hosted proof's encrypted cookie is sent
only in `Set-Cookie`, never in either representation. Hosted verification must
return one valid expiration cookie. That cookie is attached exactly once to a
successful response or any later parser, repository, or rendering failure;
failures before verification attach none. A resource with no mutation actions
issues neither operation IDs nor a CSRF proof or cookie.

Profile edits and marketing withdrawal delegate compare-and-set, idempotency,
and immutable revision history to the existing `ParticipantRepository`.
Account deletion delegates the same action contract to the atomic application
coordinator. Exact immediate retries reuse the persisted resulting timestamp
and return repository or coordinator replay evidence without adding a revision.
If concurrent exact requests sample different server timestamps, the loser
performs one bounded current-snapshot recovery and retries with the winner's
persisted timestamp. Changed retries still conflict and stale operations still
fail their precondition. A response lost after commit can be reconstructed only
from exact immutable operation evidence, and repeating a completed one-way
transition does not create a no-op revision.

Anonymous requests receive only the fixed sign-in resource. Owners,
unregistered accounts, foreign subjects, missing records, and inaccessible
records receive fixed non-disclosing failures. Malformed or stale trusted
projections fail closed. HTML loads `/participant-profile.css` from the same
origin under a restrictive CSP; all profile responses are non-cacheable and use
same-origin resource isolation.

The Worker resolves the trusted participant projection once for the profile
request, reuses that binding when composing the route, and lets the route read
its full validated profile through the subject-bound repository. It does not
place the runtime, adapter, credential, repository factory, or private campaign
policy in route context or output.
