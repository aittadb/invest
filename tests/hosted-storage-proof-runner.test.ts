import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AITTADB_HYPERMEDIA_API_VERSION,
  AITTADB_HYPERMEDIA_MEDIA_TYPE,
  storageProtocolErrorDocument,
} from "../domain/aittadb-storage-protocol.ts";
import {
  StorageFailure,
  type StorageAdapter,
  type StoragePage,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import {
  HostedStorageProofConfigurationFailure,
  ProofNamespacedStorageAdapter,
  formatHostedStorageProofReport,
  loadHostedStorageProofConfiguration,
  runHostedStorageAdapterProof,
} from "../scripts/hosted-storage-proof-runner.ts";
import { verifyStorageAdapterContract } from "./support/storage-adapter-contract.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";
import { SyntheticAittaDBStorageService } from "./support/synthetic-aittadb-storage-service.ts";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname;
const CLI = join(PROJECT_ROOT, "scripts/prove-hosted-storage-adapter.ts");

test("proof configuration is external, same-owner, mode-restricted, and exact", () => {
  const directory = mkdtempSync(join(tmpdir(), "invest-hosted-proof-config-"));
  const project = join(directory, "project");
  const path = join(directory, "proof.json");
  mkdirSync(project);
  writeFileSync(path, JSON.stringify(validConfiguration()), "utf8");
  chmodSync(path, 0o600);

  const configuration = loadHostedStorageProofConfiguration(path, project);
  assert.equal(configuration.targetEnvironment, "disposable-acceptance");
  assert.equal(configuration.issuer, "https://storage.example.test");
  assert.equal(configuration.transportOrigin, "https://transport.example.test");
  assert.equal(
    configuration.entryHref,
    "https://storage.example.test/bounded-storage",
  );

  chmodSync(path, 0o644);
  assert.throws(
    () => loadHostedStorageProofConfiguration(path, project),
    HostedStorageProofConfigurationFailure,
  );

  const productionTransport = validConfiguration();
  productionTransport.transport_origin = "https://aittadb.com";
  writeFileSync(path, JSON.stringify(productionTransport), "utf8");
  chmodSync(path, 0o600);
  assert.throws(
    () => loadHostedStorageProofConfiguration(path, project),
    HostedStorageProofConfigurationFailure,
  );
  chmodSync(path, 0o600);

  const inProject = join(project, "proof.json");
  writeFileSync(inProject, JSON.stringify(validConfiguration()), "utf8");
  chmodSync(inProject, 0o600);
  assert.throws(
    () => loadHostedStorageProofConfiguration(inProject, project),
    HostedStorageProofConfigurationFailure,
  );

  const link = join(directory, "proof-link.json");
  symlinkSync(path, link);
  assert.throws(
    () => loadHostedStorageProofConfiguration(link, project),
    HostedStorageProofConfigurationFailure,
  );

  const hardLinkSource = join(directory, "proof-hardlink-source.json");
  const hardLink = join(directory, "proof-hardlink.json");
  writeFileSync(hardLinkSource, JSON.stringify(validConfiguration()), "utf8");
  chmodSync(hardLinkSource, 0o600);
  linkSync(hardLinkSource, hardLink);
  assert.throws(
    () => loadHostedStorageProofConfiguration(hardLink, project),
    HostedStorageProofConfigurationFailure,
  );
  unlinkSync(hardLink);

  const otherRepository = join(directory, "other-repository");
  const initialized = spawnSync("git", ["init", "-q", otherRepository], {
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0);
  const inOtherRepository = join(otherRepository, "proof.json");
  writeFileSync(
    inOtherRepository,
    JSON.stringify(validConfiguration()),
    "utf8",
  );
  chmodSync(inOtherRepository, 0o600);
  assert.throws(
    () => loadHostedStorageProofConfiguration(inOtherRepository, project),
    HostedStorageProofConfigurationFailure,
  );

  const production = validConfiguration();
  production.issuer = "https://aittadb.com";
  production.entry_href = "https://aittadb.com/bounded-storage";
  writeFileSync(path, JSON.stringify(production), "utf8");
  chmodSync(path, 0o600);
  assert.throws(
    () => loadHostedStorageProofConfiguration(path, project),
    HostedStorageProofConfigurationFailure,
  );

  const wrongEnvironment = validConfiguration();
  wrongEnvironment.target_environment = "production";
  writeFileSync(path, JSON.stringify(wrongEnvironment), "utf8");
  chmodSync(path, 0o600);
  assert.throws(
    () => loadHostedStorageProofConfiguration(path, project),
    HostedStorageProofConfigurationFailure,
  );

  const reused = validConfiguration();
  reused.read_only_outsider_client.client_secret = reused.owner_client.client_id;
  writeFileSync(path, JSON.stringify(reused), "utf8");
  chmodSync(path, 0o600);
  assert.throws(
    () => loadHostedStorageProofConfiguration(path, project),
    HostedStorageProofConfigurationFailure,
  );
});

test("proof configuration failures never repeat credential-bearing input", () => {
  const directory = mkdtempSync(join(tmpdir(), "invest-hosted-proof-invalid-"));
  const project = join(directory, "project");
  const path = join(directory, "proof.json");
  const secret = syntheticSecret("malformed");
  mkdirSync(project);
  writeFileSync(path, `{"owner_client":{"client_secret":"${secret}"}`, "utf8");
  chmodSync(path, 0o600);

  let failure: unknown;
  try {
    loadHostedStorageProofConfiguration(path, project);
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof HostedStorageProofConfigurationFailure);
  assert.equal(String(failure).includes(secret), false);

  const environment = { ...process.env };
  delete environment.INVEST_HOSTED_STORAGE_PROOF_CONFIG_FILE;
  const cli = spawnSync(process.execPath, ["--experimental-strip-types", CLI], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: environment,
  });
  assert.equal(cli.status, 1);
  assert.deepEqual(JSON.parse(cli.stdout), {
    status: "failed",
    code: "configuration_invalid",
  });

  writeFileSync(
    path,
    JSON.stringify(validConfiguration()).replace(
      '"client_id":"synthetic-owner-client"',
      '"client_id":"hidden-duplicate","client_id":"synthetic-owner-client"',
    ),
    "utf8",
  );
  chmodSync(path, 0o600);
  assert.throws(
    () => loadHostedStorageProofConfiguration(path, project),
    HostedStorageProofConfigurationFailure,
  );
});

test("namespace adapter executes the unchanged contract through isolated names", async () => {
  const states: MemoryStorageState[] = [];
  let fixtureCount = 0;
  await verifyStorageAdapterContract(() => {
    fixtureCount += 1;
    const fixture = String(fixtureCount).padStart(2, "0");
    const state = new MemoryStorageState();
    states.push(state);
    return {
      owner: new ProofNamespacedStorageAdapter(
        new MemoryStorageAdapter(state),
        `proof-fixed-${fixture}-`,
        `proof:fixed:${fixture}:`,
      ),
      outsider: new ProofNamespacedStorageAdapter(
        new DeniedStorageAdapter(),
        `proof-fixed-${fixture}-`,
        `proof:fixed:${fixture}:`,
      ),
    };
  });

  assert.equal(states.length, fixtureCount);
  assert.ok(fixtureCount > 1);
  const fixturePrefixes = states.map((state) => {
    const operations = [...state.operations.keys()];
    assert.ok(operations.length > 0);
    const prefix = operations[0]?.split(":").slice(0, 3).join(":");
    assert.notEqual(prefix, undefined);
    assert.ok(`${prefix}:`.startsWith("proof:fixed:"));
    assert.ok(operations.every((operation) => operation.startsWith(`${prefix}:`)));
    const collections = new Set(
      [...state.records.values()].map((record) => record.key.collection),
    );
    assert.ok(collections.size <= 1);
    for (const collection of collections) {
      assert.ok(collection.startsWith("proof-fixed-"));
    }
    return prefix;
  });
  assert.equal(new Set(fixturePrefixes).size, fixturePrefixes.length);
  for (const state of states) {
    for (const operation of state.operations.keys()) {
      assert.ok(operation.startsWith("proof:fixed:"));
    }
  }
});

test("runner rejects a programmatic production target before network access", async () => {
  const configuration = parsedConfiguration();
  let fetchCalls = 0;
  const report = await withGlobalFetch(async () => {
    fetchCalls += 1;
    return new Response(null, { status: 500 });
  }, () => runHostedStorageAdapterProof({
    ...configuration,
    issuer: "https://aittadb.com",
    entryHref: "https://aittadb.com/bounded-storage",
  }));

  assert.deepEqual(report, { status: "failed", code: "configuration_invalid" });
  assert.equal(fetchCalls, 0);
});

test("runner closes one immutable configuration snapshot before async work", async () => {
  const configuration = { ...parsedConfiguration() };
  const transport = proofTransport(configuration, {
    onSafetyRequest() {
      assert.equal(Reflect.set(configuration, "issuer", "https://aittadb.com"), true);
      assert.equal(
        Reflect.set(
          configuration,
          "entryHref",
          "https://aittadb.com/bounded-storage",
        ),
        true,
      );
    },
  });
  const report = await withGlobalFetch(
    transport.fetch,
    () => runHostedStorageAdapterProof(configuration),
  );

  assert.equal(report.status, "passed");
  assert.ok(transport.ownerService.tokenRequests > 1);

  const accessorConfiguration = { ...parsedConfiguration() };
  let fetchCalls = 0;
  Object.defineProperty(accessorConfiguration, "issuer", {
    enumerable: true,
    get: () => "https://storage.example.test",
  });
  const accessorReport = await withGlobalFetch(async () => {
    fetchCalls += 1;
    return new Response(null, { status: 500 });
  }, () => runHostedStorageAdapterProof(accessorConfiguration));
  assert.deepEqual(accessorReport, {
    status: "failed",
    code: "configuration_invalid",
  });
  assert.equal(fetchCalls, 0);
});

test("runner requires a fresh server assertion before token acquisition", async () => {
  let requestCalls = 0;
  const report = await withGlobalFetch(async (input, init) => {
    requestCalls += 1;
    const request = new Request(input, init);
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(request.headers.get("cookie"), null);
    return new Response(null, { status: 404 });
  }, () => runHostedStorageAdapterProof(parsedConfiguration()));

  assert.equal(report.status, "failed");
  assert.equal(report.code, "proof_unavailable");
  assert.equal(report.fixture_count, 0);
  assert.equal(requestCalls, 1);
});

test("runner rejects and cancels crossed, cached, and non-exact assertions", async () => {
  const configuration = parsedConfiguration();
  let rejectedBodyCancelled = false;
  const variants = [
    {
      name: "crossed challenge",
      response(id: string, challenge: string) {
        return safetyAssertionResponse(
          configuration.issuer,
          id,
          `${challenge}-crossed`,
        );
      },
    },
    {
      name: "crossed issuer",
      response(id: string, challenge: string) {
        return safetyAssertionResponse(
          "https://other.example.test",
          id,
          challenge,
        );
      },
    },
    {
      name: "cacheable response",
      response(id: string, challenge: string) {
        const response = safetyAssertionResponse(
          configuration.issuer,
          id,
          challenge,
        );
        response.headers.set("cache-control", "max-age=60");
        return response;
      },
    },
    {
      name: "extra document field",
      response(id: string, challenge: string) {
        const document = safetyAssertionDocument(
          configuration.issuer,
          id,
          challenge,
        );
        return safetyResponse({ ...document, unexpected: true });
      },
    },
    {
      name: "rejected streaming response",
      response() {
        return new Response(new ReadableStream({
          cancel() {
            rejectedBodyCancelled = true;
          },
        }), { status: 503 });
      },
    },
  ];

  for (const variant of variants) {
    const report = await withGlobalFetch(async (input, init) => {
      const request = new Request(input, init);
      const logical = logicalProofUrl(configuration, request.url);
      const challenge = logical.searchParams.get("challenge") ?? "";
      return variant.response(logical.href, challenge);
    }, () => runHostedStorageAdapterProof(configuration));
    assert.equal(report.status, "failed", variant.name);
    assert.equal(report.code, "proof_unavailable", variant.name);
    assert.equal(report.fixture_count, 0, variant.name);
  }
  assert.equal(rejectedBodyCancelled, true);
});

test("default runner sends a canonical UUIDv4 safety challenge and uses exact role scopes", async () => {
  const configuration = parsedConfiguration();
  const transport = proofTransport(configuration);
  const report = await withGlobalFetch(
    transport.fetch,
    () => runHostedStorageAdapterProof(configuration),
  );

  assert.equal(report.status, "passed");
  if (report.status !== "passed") return;
  assert.match(report.proof_id, /^storage-proof-[0-9a-f-]{36}$/u);
  const challenge = transport.challenge;
  assert.match(
    challenge ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  assert.equal(report.proof_id, `storage-proof-${challenge}`);
  assert.equal(transport.ownerService.tokenRequests, report.fixture_count);
  assert.equal(
    transport.ownerService.discoveryRequests,
    report.fixture_count + 1,
  );
  assert.equal(transport.outsiderTokenRequests, 1);
  assert.equal(transport.outsiderDiscoveryRequests, 1);
  assert.ok(transport.outsiderDeniedRequests > 1);
  assert.equal(transport.safetyAssertionRequests, 1);
});

test("runner reports static failure codes and cleanup fields only", async () => {
  const configuration = parsedConfiguration();
  const secret = syntheticSecret("contract-cause");
  const transport = proofTransport(configuration, {
    accessToken: secret,
    allowOutsiderOwnerAccess: true,
  });
  const report = await withGlobalFetch(
    transport.fetch,
    () => runHostedStorageAdapterProof(configuration),
  );
  const output = formatHostedStorageProofReport(report);
  assert.equal(report.status, "failed");
  assert.equal(report.code, "contract_failed");
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes("authorization"), false);
  assert.match(output, /cleanup_inventory/u);

  const unavailable = await withGlobalFetch(
    async () => {
      throw new Error(secret);
    },
    () => runHostedStorageAdapterProof(parsedConfiguration()),
  );
  const unavailableOutput = formatHostedStorageProofReport(unavailable);
  assert.equal(unavailable.status, "failed");
  assert.equal(unavailable.code, "proof_unavailable");
  assert.equal(unavailableOutput.includes(secret), false);
  assert.equal(unavailableOutput.includes("Error"), false);
});

class DeniedStorageAdapter implements StorageAdapter {
  async read(): Promise<null> {
    return null;
  }

  async list(): Promise<StoragePage> {
    return Object.freeze({ items: Object.freeze([]), nextCursor: null });
  }

  async transact(): Promise<StorageTransactionResult> {
    throw new StorageFailure("NOT_FOUND");
  }
}

function validConfiguration() {
  return {
    target_environment: "disposable-acceptance",
    issuer: "https://storage.example.test",
    transport_origin: "https://transport.example.test",
    entry_href: "https://storage.example.test/bounded-storage",
    owner_client: {
      client_id: "synthetic-owner-client",
      client_secret: syntheticSecret("owner"),
    },
    read_only_outsider_client: {
      client_id: "synthetic-outsider-client",
      client_secret: syntheticSecret("outsider"),
    },
  };
}

function protocolErrorResponse(): Response {
  return new Response(JSON.stringify(storageProtocolErrorDocument("not_found")), {
    status: 404,
    headers: { "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE },
  });
}

function safetyAssertionResponse(
  issuer: string,
  id: string,
  challenge: string,
): Response {
  return safetyResponse(safetyAssertionDocument(issuer, id, challenge));
}

function safetyAssertionDocument(
  issuer: string,
  id: string,
  challenge: string,
) {
  return {
    api_version: AITTADB_HYPERMEDIA_API_VERSION,
    type: "acceptance-proof-safety",
    id,
    data: {
      issuer,
      environment: "disposable-acceptance",
      storage_contract_proofs: "allowed",
      challenge,
    },
    links: [],
    actions: [],
  };
}

function safetyResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      "cache-control": "no-store",
      "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE,
    },
  });
}

function proofTransport(
  configuration: ReturnType<typeof parsedConfiguration>,
  options: Readonly<{
    accessToken?: string;
    allowOutsiderOwnerAccess?: boolean;
    onSafetyRequest?: () => void;
  }> = {},
) {
  const issuer = configuration.issuer;
  const transportOrigin = configuration.transportOrigin ?? issuer;
  const routeConfiguration = {
    issuer,
    transportOrigin: configuration.transportOrigin,
  };
  const entryHref = configuration.entryHref;
  const ownerAccessToken = options.accessToken ??
    "synthetic-owner-proof-access-token";
  const outsiderAccessToken = options.allowOutsiderOwnerAccess === true
    ? ownerAccessToken
    : "synthetic-outsider-proof-access-token";
  const ownerScopes = "storage.read storage.write storage.delete";
  const outsiderScopes = "storage.read";
  const ownerService = new SyntheticAittaDBStorageService({
    issuer,
    transportOrigin,
    entryHref,
    clientId: configuration.ownerClient.clientId,
    clientSecret: configuration.ownerClient.clientSecret,
    accessToken: ownerAccessToken,
    scopes: ownerScopes,
  });
  let challenge: string | undefined;
  let outsiderTokenRequests = 0;
  let outsiderDiscoveryRequests = 0;
  let outsiderDeniedRequests = 0;
  let safetyAssertionRequests = 0;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const logical = logicalProofUrl(routeConfiguration, request.url);
    const authorization = request.headers.get("authorization");
    if (logical.pathname === "/.well-known/aittadb-proof-safety") {
      safetyAssertionRequests += 1;
      assert.equal(request.method, "GET");
      assert.equal(authorization, null);
      assert.equal(request.headers.get("cookie"), null);
      assert.equal(request.headers.get("accept"), AITTADB_HYPERMEDIA_MEDIA_TYPE);
      assert.equal(request.headers.get("cache-control"), "no-store");
      challenge = logical.searchParams.get("challenge") ?? undefined;
      assert.notEqual(challenge, undefined);
      options.onSafetyRequest?.();
      return safetyAssertionResponse(issuer, logical.href, challenge ?? "");
    }
    if (logical.pathname === "/oauth/token") {
      const outsiderAuthorization =
        `Basic ${btoa(`${configuration.outsiderClient.clientId}:${configuration.outsiderClient.clientSecret}`)}`;
      if (authorization !== outsiderAuthorization) {
        return ownerService.fetch(request);
      }
      outsiderTokenRequests += 1;
      assert.equal(request.method, "POST");
      assert.deepEqual(
        Object.fromEntries(new URLSearchParams(await request.text())),
        { grant_type: "client_credentials", scope: outsiderScopes },
      );
      return jsonResponse({
        access_token: outsiderAccessToken,
        token_type: "Bearer",
        expires_in: 3_600,
        scope: outsiderScopes,
      });
    }
    if (authorization === `Bearer ${ownerAccessToken}`) {
      return ownerService.fetch(request);
    }
    assert.equal(authorization, `Bearer ${outsiderAccessToken}`);
    if (logical.href === entryHref) {
      outsiderDiscoveryRequests += 1;
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${ownerAccessToken}`);
      return ownerService.fetch(new Request(request, { headers }));
    }
    outsiderDeniedRequests += 1;
    return protocolErrorResponse();
  };

  return {
    fetch,
    ownerService,
    get challenge() {
      return challenge;
    },
    get outsiderTokenRequests() {
      return outsiderTokenRequests;
    },
    get outsiderDiscoveryRequests() {
      return outsiderDiscoveryRequests;
    },
    get outsiderDeniedRequests() {
      return outsiderDeniedRequests;
    },
    get safetyAssertionRequests() {
      return safetyAssertionRequests;
    },
  };
}

async function withGlobalFetch<T>(
  fetch: typeof globalThis.fetch,
  operation: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    return await operation();
  } finally {
    globalThis.fetch = original;
  }
}

function logicalProofUrl(
  configuration: Readonly<{
    issuer: string;
    transportOrigin: string | undefined;
  }>,
  value: string,
): URL {
  const issuer = configuration.issuer;
  const transportOrigin = configuration.transportOrigin ?? issuer;
  const logical = new URL(value);
  if (logical.origin === transportOrigin) {
    logical.protocol = new URL(issuer).protocol;
    logical.host = new URL(issuer).host;
  }
  return logical;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function parsedConfiguration() {
  const directory = mkdtempSync(join(tmpdir(), "invest-hosted-proof-parsed-"));
  const project = join(directory, "project");
  const path = join(directory, "proof.json");
  mkdirSync(project);
  writeFileSync(path, JSON.stringify(validConfiguration()), "utf8");
  chmodSync(path, 0o600);
  return loadHostedStorageProofConfiguration(path, project);
}

function syntheticSecret(role: string): string {
  return ["synthetic", role, "credential", "value", "0123456789"].join("-");
}
