# Registered Information Package Reader

`/participant/package` is a private registered-reader resource. The same `GET`
endpoint negotiates native HTML or Investor App hypermedia JSON. It is not a
public campaign page and does not accept package content from a request.

## Authorization Boundary

The route requires both a trusted signed-in actor and a participant projection
bound to the same canonical subject. An injected, subject-scoped repository
factory supplies the current immutable package version. Anonymous,
unregistered, foreign, missing, malformed, and failed reads return fixed
non-disclosing responses before package content is rendered.

Hosted composition injects a subject-bound AittaDB package reader only into the
participant route group. The standalone route contains no global repository,
process-memory fallback, hostname, campaign content, owner identity,
credential, or token. Package persistence does not establish registration or
profile authority: until TASK-090 injects the persistent `participantAccess`
reader, the hosted route returns the same non-disclosing unavailable response
without opening the package repository.

## Closed Projection

The reader revalidates repository-owned metadata and every section before it
builds a response. It includes only:

- version creation time, change summary, and material-change classification;
- the current acknowledgment text and whether renewed acceptance is required;
- enabled, non-empty section identifiers and titles; and
- validated Markdown for those visible sections.

Disabled and empty drafts, enabled flags, order values, content hashes,
acceptance hashes, storage keys, repository details, and participant identity
are absent. Native HTML renders the validated Markdown through the shared AST
renderer and never passes raw HTML through to the browser. Hypermedia JSON
returns the validated Markdown source so an API client can render the same
content safely.

## Bounds and Navigation

Pages default to eight sections and accept an explicit limit from 1 through 16.
The optional `after` cursor must identify a visible section emitted by the
current package. Unknown, duplicate, repeated, oversized, terminal, and extra
query values fail closed. One page may contain at most 256,000 UTF-8 source
bytes, in addition to the package domain's per-section and total-section
limits. When the requested section count would exceed that byte ceiling, the
reader emits the largest non-empty safe prefix and continues through the next
link. A next link and equivalent safe action appear only when another page
exists.

Private responses use `no-store`, MIME-sniffing and framing defenses, a
same-origin stylesheet, no-referrer policy, and a restrictive content security
policy. Current acknowledgment mutation is a separate capability implemented
by TASK-066; this reader reports status but does not invent an acceptance
action.
