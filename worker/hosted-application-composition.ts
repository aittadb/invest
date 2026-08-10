import {
  createBrowserMutationSession,
  type BrowserMutationRandomBytes,
} from "../http/browser-mutation-session.ts";
import {
  MAX_MUTATION_BODY_BYTES,
  MAX_MUTATION_FIELDS,
} from "../http/mutation-security.ts";
import { AittaDBStorageAdapter } from "../repositories/aittadb-storage-adapter.ts";
import { StorageApplicationRepositoryFactory } from "../repositories/storage-application-repository-factory.ts";
import type { AittaDBServiceTokenFetch } from "../services/aittadb-service-token.ts";
import type { InvestorAppEnv } from "./contracts.ts";
import type { ApplicationRuntimeDeploymentCapability } from "./deployment-capabilities.ts";
import { parseHostedAittaDBApplicationConfiguration } from "./hosted-application-configuration.ts";

const SERVICE_TOKEN_EXPIRY_SKEW_SECONDS = 60;
const SERVICE_TOKEN_REQUEST_TIMEOUT_MS = 10_000;
const STORAGE_REQUEST_TIMEOUT_MS = 30_000;
const BROWSER_MUTATION_TTL_SECONDS = 300;

export type HostedApplicationRuntimeCompositionDependencies = Readonly<{
  fetch?: AittaDBServiceTokenFetch;
  now?: () => Date;
  randomBytes?: BrowserMutationRandomBytes;
}>;

export type HostedApplicationRuntimeResolver = (
  env: InvestorAppEnv,
) => Promise<ApplicationRuntimeDeploymentCapability | null>;

/** Creates one fail-closed application runtime per immutable Sites environment. */
export function createHostedApplicationRuntimeResolver(
  dependencies: HostedApplicationRuntimeCompositionDependencies = {},
): HostedApplicationRuntimeResolver {
  const providerFetch = dependencies.fetch ??
    ((input, init) => fetch(input, init));
  const now = dependencies.now ?? (() => new Date());
  const randomBytes = dependencies.randomBytes ?? secureRandomBytes;
  const cache = new WeakMap<
    InvestorAppEnv,
    Promise<ApplicationRuntimeDeploymentCapability | null>
  >();

  return (env) => {
    const existing = cache.get(env);
    if (existing !== undefined) return existing;
    const composed = composeHostedApplicationRuntime(
      env,
      providerFetch,
      now,
      randomBytes,
    );
    cache.set(env, composed);
    return composed;
  };
}

async function composeHostedApplicationRuntime(
  env: InvestorAppEnv,
  providerFetch: AittaDBServiceTokenFetch,
  now: () => Date,
  randomBytes: BrowserMutationRandomBytes,
): Promise<ApplicationRuntimeDeploymentCapability | null> {
  const configuration = await parseHostedAittaDBApplicationConfiguration(env);
  if (configuration === null) return null;

  try {
    const serviceToken = configuration.createServiceTokenProvider({
      expirySkewSeconds: SERVICE_TOKEN_EXPIRY_SKEW_SECONDS,
      requestTimeoutMs: SERVICE_TOKEN_REQUEST_TIMEOUT_MS,
      fetch: providerFetch,
      now,
    });
    const storage = new AittaDBStorageAdapter({
      issuer: configuration.issuer,
      transportOrigin: configuration.transportOrigin,
      entryHref: configuration.storageEntryHref,
      accessToken: serviceToken.accessToken,
      fetch: providerFetch,
      requestTimeoutMs: STORAGE_REQUEST_TIMEOUT_MS,
    });
    const repositoryFactory = new StorageApplicationRepositoryFactory(
      storage,
      now,
    );
    const mutationSession = createBrowserMutationSession({
      appOrigin: configuration.appOrigin,
      encryptionKey: configuration.mutationKey,
      claimReplay: repositoryFactory.browserMutationReplayClaimer(),
      now,
      randomBytes,
      ttlSeconds: BROWSER_MUTATION_TTL_SECONDS,
      maxBodyBytes: MAX_MUTATION_BODY_BYTES,
      maxFields: MAX_MUTATION_FIELDS,
    });
    return Object.freeze({
      repositoryFactory,
      mutationSession,
      publicationReady: configuration.publicationReady,
      now,
    });
  } catch {
    return null;
  }
}

function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}
