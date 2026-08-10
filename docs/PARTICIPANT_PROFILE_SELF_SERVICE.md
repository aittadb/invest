# Participant Profile Self-Service

Participant profile self-service is an injectable registered-reader resource at
`/participant/profile`. `StorageParticipantRepository` now supplies the
production-neutral persistence contract, and the trusted participant-access
projection and access registration are available. Hosted profile composition
remains `TASK-092`, so this resource is not yet installed in the hosted Worker.

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
withdrawable. Recording deletion intent does not itself erase records or
coordinate founder applications, investment indications, or aggregates; that
atomic application operation belongs to the later account-deletion coordination
work.

## Mutation Boundary

HTML forms and JSON clients use the same semantic methods and exact fields.
HTML submits `PATCH` and `DELETE` through the shared `_method` transport field.
All writes pass through the generic browser mutation guard before feature input
is parsed. The route additionally requires the request `Origin` to equal the
canonical resource origin and binds the verified participant session subject to
the exact trusted account.

The guard enforces bounded JSON or URL-encoded bodies, a supported content
type, an unexpired actor-bound session, and an expiring CSRF proof. HTML carries
the proof only in `_csrf`; hypermedia JSON carries it only in the
`x-investor-app-csrf` response header. The proof and header name are absent from
the JSON document. A resource with no mutation actions issues neither operation
IDs nor a CSRF proof.

Mutations delegate compare-and-set, idempotency, and immutable revision history
to the existing `ParticipantRepository`. Exact immediate retries reuse the
persisted resulting timestamp and return the repository replay without adding a
revision. Before any existing-profile write, the storage repository verifies the
current record against the expected immutable revision. A response lost after
commit can be reconstructed only from the exact stored operation revision;
changed retries conflict, stale revisions fail their precondition, and new
attempts to repeat a completed withdraw-only or request-only transition do not
create no-op revisions.

Anonymous requests receive only the fixed sign-in resource. Owners,
unregistered accounts, foreign subjects, missing records, and inaccessible
records receive fixed non-disclosing failures. Malformed or stale trusted
projections fail closed. HTML loads `/participant-profile.css` from the same
origin under a restrictive CSP; all profile responses are non-cacheable and use
same-origin resource isolation.
