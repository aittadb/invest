# AittaDB Service Token Provider

## Purpose

`services/aittadb-service-token.ts` creates the backend capability that a
production AittaDB storage adapter can use to obtain an OAuth access token. It
uses the confidential `client_credentials` grant and is intended only for the
Cloudflare Worker composition. It is not an interactive sign-in flow and has no
browser origin, redirect URI, cookie, user identity, or consent step.

The provider does not make Investor App persistence production-ready by itself.
The production storage adapter and hosted runtime composition must inject this
capability without exposing it to route or rendering code that can serialize a
token.

## Injected Contract

The Worker must supply every dependency explicitly:

- an exact HTTPS AittaDB logical issuer with no user information, path, query,
  or fragment;
- an optional exact HTTPS backend transport origin, defaulting to the logical
  issuer and subject to the same URL restrictions;
- a confidential service-client ID and hosted-only client secret;
- a non-empty canonical subset of `storage.read`, `storage.write`, and
  `storage.delete`, in that order;
- an expiry skew from 1 through 300 seconds;
- Worker-native `fetch`; and
- a trusted clock.

There is no deployment hostname, client ID, client secret, or selected scope set
in reusable source. A deployment should grant only the scopes consumed by its
storage adapter. Adding interactive identity scopes, `openid`,
`offline_access`, or an unrecognized storage scope fails configuration.

The AittaDB deployment must separately bind this confidential client to the
Investor App's isolated storage namespace and deny that namespace to browser
clients and unrelated service clients. OAuth scopes and possession of a hosted
secret complement that server-side ACL; they do not replace it. Register no
browser origin or redirect URI for this non-interactive service client.

The returned provider has one method:

```ts
const provider = createAittaDBServiceTokenProvider({
  issuer,
  transportOrigin,
  clientId,
  clientSecret,
  storageScopes,
  expirySkewSeconds,
  fetch,
  now: () => new Date(),
});

const repository = new AittaDBCampaignConfigurationRepository({
  issuer,
  recordKey,
  accessToken: provider.accessToken,
  fetch,
});
```

The identifiers and origins in this example are injected server-side variables,
not literal instance values. `issuer` remains the logical OAuth security
identity used by the application and storage contract. `transportOrigin` only
selects the network origin for the fixed token path; it does not replace or
redefine that issuer. Runtime composition must read the secret from hosted
secret storage and must never place either origin, the dependency object, or
the provider in React props, hypermedia data, browser code, logs, exports,
campaign content, or error responses.

## Token Request

The provider sends `POST {transportOrigin ?? issuer}/oauth/token` with
`redirect: "manual"`. The transport value comes only from the injected runtime
configuration; `accessToken()` accepts no request, hostname, origin, or route
argument. HTTP Basic carries the client credentials. The bounded form body
contains only the exact `client_credentials` grant and canonical requested
scope string. It contains no client secret, logical issuer, transport origin,
browser origin, redirect URI, cookie, refresh-token request, or participant
data.

Only an HTTP 200 JSON response is accepted. Redirects are not followed.
The JSON body is byte-bounded, decoded as strict UTF-8, parsed as one object,
and must contain exactly:

- a printable bearer `access_token` of at most 4,096 characters;
- `token_type` equal to `Bearer`, case-insensitively;
- an integer `expires_in` from 1 through 3,600 seconds and longer than the
  configured expiry skew; and
- `scope` exactly equal to the requested canonical scope string.

Extra fields, including refresh tokens, are rejected. Missing, added,
duplicated, reordered, or otherwise changed scopes are rejected.

## Worker-Local Lifetime

One successful token is retained only in the provider closure for the current
Worker isolate. It is never persisted. Calls reuse it only before the expiry
skew begins. At the skew boundary the cached value is discarded before renewal,
so a failed renewal cannot fall back to an old token. A backward or invalid
clock also prevents reuse.

Concurrent callers share one in-flight acquisition. A failed acquisition is
cleared after all callers receive the same fixed failure class, and a later call
may attempt a fresh request. Worker restarts naturally discard both cached and
in-flight state; persistence must never be added to preserve this cache.

## Failure and Disclosure Boundary

Configuration, clock, fetch, status, redirect, media type, declared size,
stream, UTF-8, JSON, token-field, lifetime, and scope failures all become
`AittaDBServiceTokenFailure` with the fixed `service_unavailable` code and fixed
message. Provider response bodies and exception causes are neither retained nor
attached. The provider has no logging callback and emits no logs.

`accessToken()` necessarily returns the bearer value to its backend storage
caller. That caller must keep the value in a backend closure, use it only in an
Authorization header to the exact configured AittaDB service, and replace its
own failures with non-disclosing domain errors. Neither the provider nor its
caller may return a raw provider response, exception, credential, or token to a
browser.
