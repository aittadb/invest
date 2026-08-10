# Participant Package Acknowledgment

`/participant/package/acknowledgment` is the canonical current-package
acknowledgment resource. It is available only to an active registered
participant whose trusted actor subject exactly matches the participant access
projection. An owner, another subject, an unregistered account, or an account
with deletion requested receives no participant package capability.

## Representations

The resource negotiates native HTML and Investor App hypermedia JSON version
`0.1` from one capability model. Both representations expose:

- the current package version metadata and configured acknowledgment text;
- whether the current acceptance requirement is satisfied;
- the participant's latest immutable acceptance evidence, when present;
- links to the information package and participant home; and
- `acknowledge-current-package` only while renewed acceptance is required.

Participant output omits the subject, content and requirement hashes, storage
keys, repository revisions, credentials, and backend detail. HTML loads only
`/participant-package-acknowledgment.css`, uses no inline script or style, and
is served with a default-deny CSP, same-origin form action, no-store caching,
no-referrer policy, and same-origin resource policy.

## Trusted State

The route obtains one injected repository pair after authorization. The package
repository supplies the immutable current `PackageVersion`; the acknowledgment
repository is already bound to the authenticated participant subject. The
route performs one current-package/latest-acknowledgment/current-package read.
Both package reads must match exactly; an interleaved publication fails that
single attempt with a precondition error. The route does not retry this state
read before a mutation.

Separately, the read-side `requiresCurrentAcceptance` repository method used by
participant authorization samples the private package-current gate before and
after its latest-acknowledgment read. It retries that read sequence a small
bounded number of times and returns a result only when both gate samples bind
the same revision, version, content hash, and required-acceptance hash.
Continuing gate movement fails closed.

The repository state must also match the request's trusted participant access
projection, including package identity, creation time, change summary,
material classification, and current-requirement status. A stale or malformed
projection fails before mutation. Browser fields never select a participant,
package, version, timestamp, hash, acceptance identifier, or expected
repository revision.

## Mutation

`acknowledge-current-package` is a `POST` with exactly one feature field:
`operation-id`. Native HTML additionally sends the ordinary `_csrf` transport
field; JSON clients echo the CSRF response header. The generic browser mutation
guard enforces a participant session, exact allowed origin, CSRF proof,
supported media type, at most two transport fields, and a 512-byte body. The
route then requires the request `Origin` to equal the canonical resource
origin and binds the mutation actor to the same trusted participant access.

The route derives the acceptance identifier from the validated operation ID.
It derives the participant subject, accepted package version, content hash,
requirement hash, expected acknowledgment revision, and acceptance time from
trusted repositories and the server clock. The subject-scoped repository
atomically appends immutable evidence and advances that participant's
acceptance head.

An exact retry first retrieves the immutable evidence under the same derived
identifier and returns it without changing state or reading the clock again.
Concurrent exact attempts that meet at repository idempotency similarly return
the stored evidence. Added fields, changed retry material, malformed operation
IDs, stale state, and direct attempts while no action is available fail without
mutation.

## Version Semantics

Satisfaction uses `PackageVersion.requiredAcceptanceHash` and
`requiresRenewedAcceptance` from the package-content domain:

- a material package version establishes a new requirement and advertises the
  acknowledgment action until accepted; and
- an editorial package version carries the prior requirement hash, so an
  existing acceptance remains current and the resource is actionless.

An actionless resource does not create an operation ID, request a CSRF proof,
or return the CSRF response header. Successful acknowledgment responses are
also actionless for the accepted requirement.

## Composition Boundary

The route factory accepts request-safe package and subject-scoped
acknowledgment repositories plus mutation security, CSRF issuance, clock, and
operation-ID capabilities. Hosted composition supplies those repositories from
the credential-bound AittaDB adapter and projects them only into the participant
route group. It does not treat package or acceptance records as participant
authority. Until TASK-090 supplies the persistent `participantAccess` reader,
the route remains non-disclosing and unavailable without opening package
persistence.

The package-current gate is a private synchronization record separate from the
owner-visible package head. Every package publish updates its exact version and
required-acceptance hash. Acknowledgment compare-and-set writes the unchanged
gate in the same transaction as immutable evidence and the participant head,
so a material or editorial publish between the route's read and transaction
causes the stale attempt to fail. The acceptance record retains the original
expected gate revision only for exact adapter replay; that metadata is never
part of participant representations. Successful acknowledgment does not change
the owner-visible package revision.
