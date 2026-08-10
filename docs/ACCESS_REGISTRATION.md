# Access Registration

Access registration is an injectable participant resource at
`/participant/registration`. `StorageParticipantRepository` now supplies the
production-neutral persistence contract, but the resource is not wired into the
hosted Worker. The trusted persistent participant projection is available;
registration composition remains `TASK-091`, and profile self-service
composition remains `TASK-092`.

## Representations

`GET` negotiates either human HTML or Investor App hypermedia JSON version
`0.1` from the same capability model. A signed-in non-owner who has not yet
registered receives one `register-participant-access` action. The action accepts:

- display name;
- two-letter self-declared country code;
- founder, investor, or both interest;
- individual or company context;
- acknowledgment of the configured process-email notice; and
- independent optional marketing consent.

The authenticated provider email appears only as a display label. Subject and
account email are absent from mutation fields and always come from the trusted
request actor. Process and marketing notice text is deployment-supplied; the
resource defines no campaign-specific notice defaults.

After successful registration, both representations show the same current
profile projection and advertise no registration mutation. Package and
participant links become available for later runtime composition.

## Mutation Boundary

`POST` accepts JSON or URL-encoded form input through either the injectable
hosted browser-mutation verifier or the compatibility mutation guard used by
isolated fixtures. Both paths enforce the exact resource origin, an actor-bound
session and CSRF proof, a 2 KiB body ceiling, at most eight transport fields,
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
cookie. Body and field limits run before the hosted replay capability is claimed
and before the participant repository is opened.

The request-scoped repository factory receives the trusted subject and provider
email as a `ParticipantAccount`. Registration delegates persistence to the
existing `ParticipantRepository`: an exact operation retry returns its original
snapshot, a changed retry conflicts, and a new duplicate registration conflicts.
The route reuses the persisted registration timestamp for retry evaluation and
does not retain process-memory authority.

HTML loads `/participant-registration.css` from the same origin. Registration
responses are non-cacheable, use a same-origin stylesheet and form CSP, set
`X-Content-Type-Options: nosniff`, and return fixed non-disclosing failures.
