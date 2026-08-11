# AittaDB Atomic Record Storage Protocol

## Status and scope

This document defines the backend capability required by the generic
`StorageAdapter`. It is a server-facing protocol dependency, not an Investor App
workflow. The server stores bounded JSON records and knows nothing about
campaigns, participants, founders, investments, aggregates, audits, or package
content.

The protocol is vendor-neutral at the behavior boundary: any credential-bound
record service can implement it. The AittaDB deployment carries the contract in
its existing versioned hypermedia envelope. Clients discover every target from
the configured entry resource and do not construct an AittaDB route tree.

The current versions are:

- AittaDB hypermedia envelope: `0.1`
- response media type: `application/vnd.aittadb+json; version=0.1`
- bounded record storage protocol: `1.1`
- transaction request media type: `application/json`

An unsupported envelope or protocol version fails closed. A future breaking
change requires a new protocol version.

## Discovery resource

The configured HTTPS entry resource has type `bounded-record-storage`. It
advertises these required controls:

| Action | Method | Purpose | Required scope |
| --- | --- | --- | --- |
| `read-record` | `GET` | Read one bounded record by collection and stable ID | `storage.read` |
| `list-records` | `GET` | Read one finite cursor page | `storage.read` |
| `transact-records` | `POST` | Apply one atomic ordered transaction | `storage.read`, `storage.write`, `storage.delete` |

`read-record` supplies a templated HTTPS target with `collection` and `id` path
fields. `list-records` supplies an HTTPS target with `collection`, `limit`, and
optional `cursor` query fields. `transact-records` supplies an HTTPS target and
one required `transaction` body object. All advertised targets must share the
trusted entry origin; redirects are not part of the contract.

The discovery `data` contains this exact capability set:

```json
[
  "bounded-record-read",
  "opaque-cursor-page",
  "atomic-multi-record-compare-and-set",
  "atomic-read-revision-check",
  "idempotent-operation-id",
  "atomic-rollback",
  "quota-preflight",
  "non-disclosing-authorization"
]
```

It also advertises finite limits. Protocol `1.1` requires page size `100` and
transaction size `25` so an implementation can satisfy the existing adapter
boundary. The server additionally declares positive bounds for record bytes,
transaction bytes, and cursor length. A client rejects declarations above its
own safety ceilings of 262,144 record bytes, 1,048,576 transaction bytes, and
2,048 cursor characters.

Application workflows must budget their own worst-case atomic operation within
the 25-mutation limit. Investor App therefore limits one participant to four
active investment indications while retaining up to 100 owned historical
records. Withdrawn and rejected records do not consume an active slot. The
participant index is compare-and-set on participant creation, withdrawal, and
reactivation, so the bound remains valid under concurrent requests and leaves
room for a later account-deletion transaction to withdraw the complete active
set atomically.

The machine-readable `transaction_shape` declares:

- a stable operation ID between 1 and 128 characters;
- 1 through 25 ordered mutations with unique keys;
- `put` with `null` for create or a positive expected revision for replace;
- `delete` with a positive expected revision;
- non-mutating `check` with `null` for absence or a positive exact revision;
- one ordered record-or-null result for every mutation.

The canonical TypeScript definition and strict decoder are in
`domain/aittadb-storage-protocol.ts`.

## Records

A key is a pair of a bounded collection name and stable record ID. Collection
names match `^[a-z][a-z0-9-]{0,63}$`; record IDs use the existing stable-ID
grammar. The pair remains separate on the wire so neither client nor server has
to infer a delimiter convention.

A successful read returns:

```json
{
  "api_version": "0.1",
  "type": "bounded-storage-record",
  "id": "settings/display",
  "data": {
    "key": { "collection": "settings", "id": "display" },
    "revision": 3,
    "value": { "theme": "dark" }
  },
  "links": [],
  "actions": []
}
```

`revision` is a positive integer. A create starts at revision 1, and every
successful put increments the current revision by exactly one. Values are JSON
objects and must fit the advertised record-byte limit. The client bounds the
complete response before parsing and rejects a mismatched key, revision, value,
or document type.

A missing or inaccessible record returns the same fixed `404 not_found`
document. A read adapter converts that response to `null`.

## Cursor pages

A list request contains exactly one collection, a limit from 1 through 100, and
an optional opaque cursor returned by the preceding page. The response contains
only records from that collection, sorted by stable record ID using ascending
code-unit order, with no duplicate keys and no more items than requested.
Stable record IDs are ASCII, so this order is independent of locale and
database collation:

```json
{
  "api_version": "0.1",
  "type": "bounded-storage-records-page",
  "id": "https://storage.example.test/pages?collection=settings&limit=2",
  "data": {
    "collection": "settings",
    "page_size": 2,
    "items": [],
    "next_cursor": null
  },
  "links": [
    {
      "rel": ["self"],
      "href": "https://storage.example.test/pages?collection=settings&limit=2",
      "type": "application/vnd.aittadb+json; version=0.1"
    }
  ],
  "actions": []
}
```

The page `id` and `self` link use the exact logical origin and path of the
discovered list action, with only the declared collection, limit, and optional
cursor query values. When more records exist, `next_cursor` is non-null and
exactly one `next` link contains that cursor, collection, and page size on the
same logical origin and path. Clients preserve the opaque cursor and follow
only the advertised transition.
The server binds a cursor to the credential namespace, collection, and page
parameters. A malformed, expired, substituted, or cross-namespace cursor is an
`invalid_request`. For a collection that is not mutated during traversal,
following returned cursors visits each authorized record exactly once.

An authorized credential with no visible records and a credential denied access
to all records have the same empty-page representation. Page state never
contains principal, namespace, physical key, or authorization-policy detail.

## Atomic transaction

The transaction request wraps one operation ID and an ordered mutation array:

```json
{
  "transaction": {
    "operation_id": "operation:profile-and-history",
    "mutations": [
      {
        "type": "check",
        "key": { "collection": "settings", "id": "policy" },
        "expected_revision": 7
      },
      {
        "type": "put",
        "key": { "collection": "profiles", "id": "current" },
        "expected_revision": 4,
        "value": { "display_name": "Example" }
      },
      {
        "type": "delete",
        "key": { "collection": "leases", "id": "active" },
        "expected_revision": 2
      }
    ]
  }
}
```

The server validates the whole request and all authorization, existence,
revision, uniqueness, byte, item, and quota preconditions against one consistent
pre-transaction state. It then commits every record mutation and the operation
receipt in one durable transaction. Any failure commits none of them. This
rollback rule includes malformed input, missing grants, duplicate creation,
stale revisions, quota rejection, and an internal commit failure.

The client independently rejects any unknown mutation discriminator or extra
mutation member before discovery. It validates the operation ID and complete
key grammar, finite JSON tree, unique keys, and global transaction ceiling,
copies those values once into an immutable data-only snapshot, then enforces
the discovered per-record and transaction byte ceilings before transport.
Serialization and response verification use that snapshot, so accessors or
custom array behavior cannot change a validated mutation.

Compare-and-set rules are closed:

- `put` with `expected_revision: null` succeeds only when the key is absent;
- `put` with a positive revision succeeds only when the key exists at that exact
  revision;
- `delete` succeeds only when the key exists at its exact positive revision;
- `check` with `expected_revision: null` succeeds only when the key is absent
  and returns `null` without creating or changing a record;
- `check` with a positive revision succeeds only when the key exists at that
  exact revision and returns that unchanged record;
- the same key may occur only once in a transaction;
- mutation order is preserved in the response;
- each successful put returns the new record, each delete returns `null`, and
  each check returns its matching unchanged record or absence `null` at the
  corresponding result index.

A failed check returns `412 precondition_failed` and rolls back every adjacent
write and the operation receipt. A successful check consumes one of the 25
mutation slots but does not consume record quota. Because a positive check can
return a full record even though its request entry contains no value, clients
bound transaction responses by the number of puts and positive checks times
the advertised record limit, plus a finite envelope allowance.

Investor App composes multi-repository operations through
`StagedStorageTransaction`. Repository calls see a request-local overlay of
validated puts and deletes plus unchanged check evidence, while the underlying
adapter receives no mutation until `commit()`. The staging boundary keeps one
operation ID, rejects duplicate keys across separate repository calls, permits
at most 25 total entries and 1,048,576 serialized bytes, and refuses a list and
write combination on the same collection because it cannot project a cursor
page safely. List and staging transitions execute serially, and callers must let
them settle before commit. `commit()` synchronously seals one immutable request,
rejects later list or staging work, and coalesces callers onto one in-flight
adapter call. The final response must contain the exact record or `null` at every
ordered position. A lost or malformed response leaves that sealed request
available for an idempotent retry; only a verified response is cached.

A successful response has type `bounded-storage-transaction`:

```json
{
  "api_version": "0.1",
  "type": "bounded-storage-transaction",
  "id": "operation:profile-and-history",
  "data": {
    "operation_id": "operation:profile-and-history",
    "replayed": false,
    "records": [
      {
        "key": { "collection": "settings", "id": "policy" },
        "revision": 7,
        "value": { "state": "current" }
      },
      {
        "key": { "collection": "profiles", "id": "current" },
        "revision": 5,
        "value": { "display_name": "Example" }
      },
      null
    ]
  },
  "links": [],
  "actions": []
}
```

## Idempotency

Operation IDs are scoped to the credential-bound storage namespace. Before
commit, the server canonicalizes the validated operation ID and ordered
mutations. JSON object member order is insignificant; mutation and array order
is significant.

- First successful application returns `replayed: false`.
- Repeating the same canonical request returns the original ordered result with
  `replayed: true`, even after a server restart.
- Reusing the operation ID for different work returns `409 conflict`.
- A failed transaction stores no receipt. The identical operation may be tried
  again after the failing external condition changes.

Receipts and records must share the same atomic durability boundary. Process
memory is not an acceptable production idempotency store.

## Quotas

Quota evaluation uses the complete candidate post-transaction state. Deletes in
the transaction may free capacity for puts in the same transaction. Exceeding an
item or byte quota returns `507 quota_exceeded` before records or the operation
receipt are committed. The error does not disclose configured limits, current
usage, which mutation crossed a limit, or another namespace's state.

The existing `StorageAdapter` has no public quota-specific failure code. Its
protocol adapter therefore maps a valid `quota_exceeded` response to the fixed
`UNAVAILABLE` storage failure while preserving rollback. A later domain contract
may add a first-class quota code only as a separately reviewed change.

## Fixed failures

Every protocol failure uses the versioned envelope with empty `links` and
`actions`, and exactly `code` and fixed `message` inside `data`:

| HTTP | Protocol code | `StorageFailure` mapping |
| --- | --- | --- |
| 400 | `invalid_request` | `INVALID_REQUEST` |
| 404 | `not_found` | `NOT_FOUND` |
| 409 | `conflict` | `CONFLICT` |
| 412 | `precondition_failed` | `PRECONDITION_FAILED` |
| 507 | `quota_exceeded` | `UNAVAILABLE` |
| 503 | `unavailable` | `UNAVAILABLE` |

An unknown status, code, version, media type, dynamic message, oversized body,
or malformed document maps to a new fixed `UNAVAILABLE` failure without using
the response as an exception cause.

Resource authorization is deliberately non-disclosing. For otherwise valid
requests, denied and absent record reads and transactions have byte-equivalent
`404 not_found` bodies. Authorization checks happen before existence,
precondition, operation-receipt, or quota detail can escape. Error documents
must never contain record keys, values, operation IDs, cursors, quota state,
principal identifiers, access tokens, credentials, internal paths, or exception
text. Bearer-token authentication itself remains an OAuth boundary and is not a
record-existence signal.

## AittaDB implementation dependency

The AittaDB project must implement this capability as a generic, namespace- and
scope-bound storage primitive. It must not add Investor App resource names,
workflow rules, owner identities, campaign defaults, or deployment hostnames.

Before the production adapter can be enabled, a disposable AittaDB acceptance
deployment must prove:

1. The configured entry advertises the exact required version, capabilities,
   limits, links, actions, scopes, and same-origin HTTPS targets.
2. Reads and pages are bounded, deterministic, cursor-driven, and isolated to
   the authenticated credential namespace.
3. Multi-record put/check/delete operations, unchanged check evidence, durable operation
   receipts, and quota evaluation commit atomically under concurrency.
4. Every failure class rolls back both records and receipts.
5. Missing and denied operations are observationally equivalent and all errors
   are fixed and non-disclosing.
6. A clean-client hosted acceptance run passes the unchanged adapter contract
   suite without exposing credentials or stored values in source, responses,
   logs, or exceptions.

`tests/aittadb-storage-protocol.test.ts` supplies the deterministic protocol
service and runs the production `AittaDBStorageAdapter` against it. The adapter
follows discovered targets and runs the complete existing `StorageAdapter`
contract unchanged, then adds mixed put/check/delete, quota, pre-commit rollback,
strict decoding, transport mapping, response bounds, retry, redaction, and raw
authorization-equivalence proof. The service proves the protocol mapping; it is
not production persistence.
