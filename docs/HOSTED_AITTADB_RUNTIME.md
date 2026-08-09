# Hosted AittaDB Application Runtime

## Purpose and Status

`worker/hosted-application-composition.ts` is the production Worker assembly
boundary for Investor App persistence. It composes one confidential service
token provider, one bounded AittaDB `StorageAdapter`, one backend repository
factory, and one browser-mutation session per immutable Sites environment.

This source composition is not hosted acceptance evidence. It advertises no
campaign, package, participant, founder, indication, aggregate, moderation,
audit, export, or deletion route by itself. Those private workflows remain
absent until their own persistent wiring tasks supply narrow route
capabilities. Hosted activation also remains blocked until the configured
AittaDB deployment passes the unchanged storage and credential-boundary proof.

## Hosted Configuration

Every application-persistence value is deployment configuration. Reusable
source contains no hostname, discovery path, client identity, credential,
namespace, owner, campaign, or key default.

Ordinary hosted values:

- `APP_BASE_URL`: exact HTTPS Investor App origin;
- `AITTADB_STORAGE_ISSUER`: exact logical HTTPS AittaDB issuer;
- `AITTADB_STORAGE_TRANSPORT_ORIGIN`: optional exact backend-only HTTPS network
  origin;
- `AITTADB_STORAGE_ENTRY_HREF`: exact same-issuer logical storage discovery
  resource with no query or fragment;
- `AITTADB_STORAGE_CLIENT_ID`: dedicated confidential service-client ID; and
- `AITTADB_STORAGE_SCOPES`: exactly `storage.read storage.write
  storage.delete`.

Hosted secrets:

- `AITTADB_STORAGE_CLIENT_SECRET`: dedicated service-client secret; and
- `BROWSER_MUTATION_SESSION_KEY`: canonical base64url encoding of an independent
  256-bit AES-GCM key.

The service client is non-interactive. Register no browser origin or redirect
URI for it. AittaDB must bind it to only this deployment's isolated storage
namespace. Storage scopes complement that namespace ACL and do not replace it.

The optional interactive `AITTADB_OAUTH_*` proof uses a different client and
different cookie keys. When both configurations are present, the parser rejects
reuse of the proof client ID, proof client secret, transaction key, or CSRF key
as application-runtime material.

Missing all storage values disables the runtime. Supplying any storage value
requires the complete set plus `APP_BASE_URL`. Partial, malformed, non-HTTPS,
cross-issuer, noncanonical-scope, key-reuse, or weak-key configuration resolves
to `null`; it creates no token request, storage request, route, or private
availability marker.

## Credential Closure

The configuration parser captures the service-client ID and secret only in a
provider-construction closure. The returned configuration has no readable
credential field. Runtime composition invokes that closure once, gives only
the provider's `accessToken()` closure to `AittaDBStorageAdapter`, and returns
only:

```ts
{
  repositoryFactory,
  mutationSession,
}
```

The service-token provider, adapter, configuration, key material, credentials,
and tokens are not route data, render bindings, render headers, React props,
hypermedia values, errors, or log inputs. Vinext receives a new environment
projection containing only `ASSETS` and `IMAGES`; the secret-bearing Worker
environment never reaches framework rendering. The provider may coalesce and
cache a short-lived token in one Worker isolate; each acquisition has its own
abort deadline, and failed or timed-out renewal is cleared for a later retry.
That transient cache is neither persistence nor authorization state.

The logical issuer validates every discovered hypermedia control. The optional
transport origin changes only backend network routing. Requests follow no
redirect and carry the bearer value only to the validated transport target.

## Repository Factory

`StorageApplicationRepositoryFactory` closes over the single credential-bound
adapter and exposes only named, narrow capability methods. It intentionally has
no generic builder or adapter accessor. Its first and currently only method
returns the browser-mutation replay claimer. Later wiring tasks must add
concrete factory methods that return feature-specific repository interfaces;
they may not pass the adapter or the factory into a route. The factory does not
install any current development repository as production storage and does not
infer a repository from a hostname, owner, campaign, D1, R2, browser store,
file, or process-memory map.

## Browser-Mutation Replay

The factory supplies the first production repository capability: an atomic
browser-mutation replay claimer. `BrowserMutationSession` has already replaced
the random browser capability with a one-way, origin-bound replay identifier
before calling it.

The claimer:

- accepts only the exact `browser-mutation:v1:` one-way identifier grammar;
- requires an expiry strictly in the future and no more than 600 seconds away;
- atomically creates one `browser-mutation-replays` record with expected
  revision `null`;
- uses the same stable identifier as the transaction operation ID;
- stores only schema version and expiry;
- returns `true` only for a non-replayed successful transaction; and
- returns `false` for exact, concurrent, restarted, conflict, or already-stored
  replay attempts.

It never stores actor, email, origin, cookie name, ciphertext, CSRF token, body,
campaign data, credential, or access token. There is no read-then-write window,
D1 claim, browser authority, or Worker-global replay map.

Replay records carry their security expiry even though operation receipts may
remain longer for durable idempotency. The hosted adapter proof must verify the
deployment's retention and quota policy before activation so expired replay
records and receipts cannot exhaust the isolated namespace.

## Worker and Route Boundary

`worker/index.ts` installs one resolver. `createApplicationWorker` resolves it
fail-closed but does not place the runtime in `ApplicationRouteContext` or pass
it to public, participant, owner, image, or framework-rendering code. It adds no
browser header or navigation item for generic runtime availability. Complete
runtime configuration therefore still exposes no unfinished private workflow.

Later wiring must preserve these rules:

1. Construct subject-bound repositories fresh from trusted Sites identity.
2. Pass routes only their narrow repositories, policies, and mutation-session
   adapters.
3. Preserve mutation `Set-Cookie` and clear-cookie headers in both HTML and JSON
   representations.
4. Never use `CAMPAIGN_CONFIG_JSON`, owner email, request host, Worker bindings,
   D1, R2, or process memory as persistent fallback. Participant state readers
   are explicit composition dependencies, never environment-supplied authority.
5. Keep hosted proof and production activation gated by `TASK-059` and
   `TASK-080`, even though local composition can be developed independently.

## Verification

Focused tests cover all-or-nothing configuration, cross-origin discovery,
canonical scopes, exhaustive pairwise proof-material separation, resolver
concurrency, exact transport mapping, bounded and retryable token acquisition,
credential-free serialization and render bindings, atomic
first/concurrent/restarted replay behavior, exact hostile adapter-result
validation, bounded expiry, storage failures, and route non-advertising. Source
and built-artifact scans complement `npm run instances:check`, which rejects
tracked runtime env files and active Sites bindings.
