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
protocol service. The same suite proves positive and absence-check authorization
equivalence, duplicate protection, compare-and-set and non-mutating check
behavior, concurrent cyclic check/write linearizability, atomic rollback,
ordered unchanged evidence, pagination, and check-field-bound idempotency,
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

## Hosted contract proof command

`npm run --silent hosted-storage:prove` is the operator-only bridge between the unchanged
shared contract and one disposable hosted AittaDB acceptance deployment. It is
not part of the Worker, the Sites package, normal CI, or production startup. The
command creates a new production `AittaDBStorageAdapter` and service-token
provider for every contract fixture. This proves per-scenario production
composition, discovery, token acquisition, and credential closure. Same-state
replay after client reconstruction and hosted restart durability remain part of
the live `TASK-131` proof.

The command requires two distinct acceptance service clients:

- an owner client authorized only for the isolated proof namespace and
  `storage.read storage.write storage.delete`; and
- an outsider client authorized for a separate namespace and only
  `storage.read`.

The runner itself fixes those requested scope sets. Neither client may have an
origin or redirect URI. Put this exact JSON shape in a temporary file outside
the repository, replace every example value through the deployment's private
credential channel, and restrict the file before running:

```json
{
  "target_environment": "disposable-acceptance",
  "issuer": "https://database.acceptance.example",
  "transport_origin": "https://transport.acceptance.example",
  "entry_href": "https://database.acceptance.example/bounded-storage",
  "owner_client": {
    "client_id": "acceptance-owner-client",
    "client_secret": "replace-with-private-owner-secret"
  },
  "read_only_outsider_client": {
    "client_id": "acceptance-outsider-client",
    "client_secret": "replace-with-private-outsider-secret"
  }
}
```

Use `null` for `transport_origin` when transport and logical issuer are the same.
The target marker must be exactly `disposable-acceptance`, and the logical
issuer and any separate transport origin must contain an exact non-production
DNS label such as `test`, `acceptance`, `staging`, or `sandbox` (or use the
reserved `.test` suffix). The file must resolve outside every Git worktree or
repository, be a single-link regular non-symlink file owned by the current user,
and have no group or other permission bits:

```sh
chmod 600 /private/path/invest-hosted-storage-proof.json
INVEST_HOSTED_STORAGE_PROOF_CONFIG_FILE=/private/path/invest-hosted-storage-proof.json \
  npm run --silent hosted-storage:prove
```

Hostname labels and the local target marker are defense in depth, not proof of
deployment class. Before constructing an adapter or requesting a token, the
runner sends a fresh canonical UUIDv4 challenge to the actual configured transport at
`/.well-known/aittadb-proof-safety`. The server must return an exact no-store
versioned hypermedia assertion bound to that challenge, the logical request URL,
the logical issuer, `disposable-acceptance`, and
`storage_contract_proofs: allowed`, with no links or actions. A missing,
redirected, cached, malformed, stale, crossed, or denying assertion stops the
run before any fixture is created. Production deployments must not expose an
allowing assertion.

The command emits exactly one bounded JSON line. Success contains only a random
synthetic proof ID, contract name, fixture count, collection prefix, and
operation prefix. Failures contain only a fixed status code and, after fixture
creation begins, the same bounded inventory. Configuration, credentials,
tokens, URLs, contract invariant text, record keys and values, provider
responses, exceptions, and causes are never emitted. A failed run still prints
its cleanup prefixes because it may have committed a partial synthetic fixture
set.

### Private cleanup diagnostic

When an authorized retry of the hosted proof fails and AittaDB needs only
enough information to identify proof-scoped cleanup, run the same operator
command with its exact one argument:

```sh
INVEST_HOSTED_STORAGE_PROOF_CONFIG_FILE=/private/path/invest-hosted-storage-proof.json \
  npm run --silent hosted-storage:prove -- --cleanup-diagnostic
```

This mode is for a private support handoff only. It runs the normal proof,
including its synthetic fixture creation and mutation, and does not change the
default no-argument report. Use it only after the operator confirms prior
proof-state cleanup and explicitly authorizes this retry. It accepts no other
argument or argument combination; invalid arguments fail before configuration
loading or network activity.

After a fixture inventory exists, its one JSON line contains exactly
`cleanup_inventory.collection_prefix`, `cleanup_inventory.operation_prefix`,
and, only if the exact error escaping the normal proof causally matches a
response captured for its own transaction POST,
`storage_post.http_status`, `storage_post.content_type`,
`storage_post.document_type`, and `storage_post.error_code`. Status is a
bounded 100–599 integer or the fixed `unknown` sentinel; the remaining
diagnostic values are fixed or allowlisted classifications. Handled contract
failures and unrelated response traffic cannot qualify. If no exact causal
match exists, the line contains only the cleanup inventory. A pre-inventory
configuration failure produces no stdout and exits nonzero.

The diagnostic never includes raw Content-Type values, URLs or query values,
headers, credentials, identifiers, operation IDs, request or response bodies,
stored values, exceptions, logs, or arbitrary server strings. Its observer is
attached only to the production storage adapter's active transaction boundary:
OAuth POSTs, the proof-safety GET, discovery requests, and handled expected
transaction failures are not candidates.

Each shared-contract fixture receives a distinct physical collection and
operation prefix while retaining the contract's logical keys and requests.
This prevents retries or prior runs from colliding without modifying the shared
contract. Preserve the output in the private acceptance evidence channel until
all prefixed records, durable operation receipts, and both proof credentials
are removed or intentionally retained with a bounded purpose and expiry. Delete
the temporary configuration file after the proof. The runner rejects production
issuer hostnames and requires the independent server assertion; the command is
never authorized for a production deployment.
