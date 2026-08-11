# AittaDB Storage Adapter

## Scope

`repositories/aittadb-storage-adapter.ts` is the production implementation of
the generic `StorageAdapter` boundary. It speaks the bounded atomic hypermedia
protocol documented in `AITTADB_STORAGE_TRANSACTION.md`; it does not know about
campaigns, owners, participants, packages, applications, indications, or
aggregates.

The adapter exists independently from hosted runtime composition. Creating the
class does not install it in the Worker, register a service client, choose a
deployment, or provide a credential. `worker/hosted-application-composition.ts`
now installs one adapter behind a backend repository factory only when all
runtime values are valid; it still advertises no feature route by itself.

## Injected capabilities

Construction requires five deployment-owned capabilities:

- an exact logical HTTPS issuer origin;
- an exact same-issuer discovery resource URL;
- an optional exact HTTPS backend transport origin;
- a closure that returns a scoped bearer token; and
- a Worker-compatible `fetch` capability.

An optional bounded request timeout is a software resource limit, not an
instance identity. Its validated default is 30 seconds.

No route path, hostname, namespace, owner, campaign value, client identifier,
secret, or token is supplied by reusable source defaults. The adapter retains
the token closure, not a token value. It calls the closure once for each backend
request, validates the returned token as bounded printable non-whitespace ASCII,
and places it only in the `Authorization` header.

The logical issuer remains the security identity for discovery and every
advertised action. When a separate transport origin is configured, only the
network request's origin is replaced; path and query remain unchanged, and all
hypermedia documents must continue to contain logical same-issuer URLs. Browser
input cannot select either origin. Discovery and action URLs containing user
information, fragments, foreign origins, or undeclared base query values fail
closed.

## Requests

Reads validate the complete storage key before discovery. Lists validate the
collection and finite page size before discovery, then validate any opaque
cursor against the server-advertised ceiling. Transactions validate the exact
request and mutation shapes, operation ID, `put`, `check`, or `delete` discriminator,
complete key grammar, unique keys, revisions, finite JSON values, and the
compile-time one-megabyte safety ceiling before transport. Untrusted
transaction objects are read once into an immutable data-only snapshot;
accessors, custom array properties or prototypes, sparse arrays, and non-JSON
members fail before serialization. The wire command and response comparison
use only that snapshot. After discovery,
each put value must fit the advertised record limit and the complete command
must fit the advertised transaction limit before the write request.

The adapter discovers all read, list, and transaction targets. It does not
construct an AittaDB route tree. Requests use the exact protocol `Accept` value,
manual redirect handling, `Cache-Control: no-store`, and `application/json`
only for transaction bodies. Redirect responses are rejected and never
followed. Token acquisition and fetch each share one finite wait bound; the
fetch receives an abort signal.

## Responses

Every response must use the exact versioned protocol media type. A numeric
`Content-Length`, when present, is checked before reading. The body is then read
under independent byte, chunk-count, and elapsed-time ceilings, cancelled
without waiting on a stuck source, decoded as fatal UTF-8, parsed as JSON, and
passed to the strict protocol decoder.
Responses rejected from media or length headers are also cancelled
nonblockingly before the fixed failure is returned.

Finite budgets are derived from the operation and advertised limits:

| Response | Client ceiling |
| --- | --- |
| Discovery success | 65,536 bytes |
| Error document | 16,384 bytes |
| Record success | advertised record bytes plus 65,536 envelope bytes |
| Transaction success | number of puts and positive checks times advertised record bytes, plus 65,536 envelope bytes |
| Page success | requested page size times advertised record bytes plus a bounded envelope |

The protocol decoder then validates the exact resource type, key, revision,
ordered transaction results, including unchanged positive-check records and
absence-check nulls, page collection and deterministic code-unit
ordering, opaque continuation, exact logical list target, same-origin links,
declared limits, and fixed error document. A valid
`404 not_found` read becomes `null`; malformed, dynamic, mismatched, oversized,
redirected, or unknown responses become a fresh fixed `UNAVAILABLE` failure.
No response body or caught exception is retained as an error cause.

## Discovery and retries

Concurrent first operations share one discovery attempt. A successful document
is cached because the parsed capability is immutable. Every waiter on a failed
attempt receives the same fixed `UNAVAILABLE` failure, and the attempt is
removed from the cache so a later application operation can retry discovery.
The adapter does not automatically repeat record or transaction requests. The
caller owns retries, and transaction operation IDs make accepted repeats safe
at the storage protocol boundary.

## Verification

`tests/aittadb-storage-protocol.test.ts` now runs the unchanged shared
`StorageAdapter` contract against this production adapter and a deterministic
protocol service. The same suite proves authorization equivalence, duplicate
protection, compare-and-set and non-mutating check behavior, atomic rollback,
ordered unchanged evidence, pagination, idempotency,
quota rollback, and non-disclosure. Adapter-specific tests cover logical and
transport origins, exact headers, redirects, media types, declared and streamed
sizes, fragmented and stalled streams, UTF-8 and JSON failures, discovery retry
and concurrent-failure coalescing, exact page identity, strict mutation and
per-record and mutation request ceilings, immutable request snapshots,
unsupported check discovery, malformed check results, early-rejection body
cancellation, deterministic ordering, and token, response, and transport-error
redaction.

Hosted acceptance remains separate: the configured backend must advertise and
implement the atomic transaction action before this adapter can be proven or
enabled against that deployment. See `docs/HOSTED_AITTADB_RUNTIME.md` for the
fail-closed Worker assembly and activation boundary.
