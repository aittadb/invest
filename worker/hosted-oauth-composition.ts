import {
  createOwnerOAuthCsrfSession,
  type OwnerOAuthCsrfRandomBytes,
} from "../http/owner-oauth-csrf-session.ts";
import {
  D1OAuthProofStore,
  type D1OAuthProofDatabase,
} from "../repositories/d1-oauth-proof-store.ts";
import {
  createAittaDBOAuthProofService,
  type AittaDBOAuthFetch,
} from "../services/aittadb-oauth-proof.ts";
import type { InvestorAppEnv } from "./contracts.ts";
import {
  parseHostedAittaDBOAuthConfiguration,
} from "./hosted-oauth-configuration.ts";
import type { OwnerOAuthProofRouteDependencies } from "./routes/owner-oauth-proof.ts";

const OAUTH_TRANSACTION_TTL_SECONDS = 300;
const OWNER_CSRF_TTL_SECONDS = 300;

export type HostedOwnerOAuthProofCompositionDependencies = Readonly<{
  fetch?: AittaDBOAuthFetch;
  now?: () => Date;
  randomBytes?: OwnerOAuthCsrfRandomBytes;
}>;

export type HostedOwnerOAuthProofResolver = (
  env: InvestorAppEnv,
) => Promise<OwnerOAuthProofRouteDependencies | null>;

/** Creates one fail-closed, deployment-scoped resolver for the Worker isolate. */
export function createHostedOwnerOAuthProofResolver(
  dependencies: HostedOwnerOAuthProofCompositionDependencies = {},
): HostedOwnerOAuthProofResolver {
  const now = dependencies.now ?? (() => new Date());
  const randomBytes = dependencies.randomBytes ?? secureRandomBytes;
  const providerFetch = dependencies.fetch ?? ((request) => fetch(request));
  const cache = new WeakMap<InvestorAppEnv, Promise<OwnerOAuthProofRouteDependencies | null>>();

  return (env) => {
    const cached = cache.get(env);
    if (cached !== undefined) return cached;
    const composed = composeHostedOwnerOAuthProof(
      env,
      providerFetch,
      now,
      randomBytes,
    );
    cache.set(env, composed);
    return composed;
  };
}

async function composeHostedOwnerOAuthProof(
  env: InvestorAppEnv,
  providerFetch: AittaDBOAuthFetch,
  now: () => Date,
  randomBytes: OwnerOAuthCsrfRandomBytes,
): Promise<OwnerOAuthProofRouteDependencies | null> {
  const database = exactDatabase(env.OAUTH_PROOF_DB);
  if (database === null) return null;

  const configuration = await parseHostedAittaDBOAuthConfiguration(env);
  if (configuration === null) return null;

  try {
    const store = new D1OAuthProofStore({ database, now });
    const oauth = createAittaDBOAuthProofService({
      issuer: configuration.issuer,
      clientId: configuration.clientId,
      clientSecret: configuration.clientSecret,
      callbackUri: configuration.callbackUri,
      allowedStorageScopes: configuration.storageScopes,
      requestedStorageScopes: configuration.storageScopes,
      transactionCookieKey: configuration.transactionCookieKey,
      transactionClaimStore: store,
      resultSink: store,
      fetch: providerFetch,
      now,
      randomBytes,
      transactionTtlSeconds: OAUTH_TRANSACTION_TTL_SECONDS,
    });
    const csrfSession = createOwnerOAuthCsrfSession({
      appOrigin: configuration.appOrigin,
      cookieKey: configuration.csrfCookieKey,
      now,
      randomBytes,
      ttlSeconds: OWNER_CSRF_TTL_SECONDS,
    });
    return Object.freeze({ oauth, csrfSession });
  } catch {
    return null;
  }
}

function exactDatabase(value: unknown): D1OAuthProofDatabase | null {
  try {
    return typeof value === "object" &&
        value !== null &&
        typeof (value as D1OAuthProofDatabase).prepare === "function"
      ? value as D1OAuthProofDatabase
      : null;
  } catch {
    return null;
  }
}

function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}
