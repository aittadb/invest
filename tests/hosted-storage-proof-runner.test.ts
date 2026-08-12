import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  StorageFailure,
  type StorageAdapter,
  type StoragePage,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import {
  HostedStorageProofConfigurationFailure,
  formatHostedStorageProofReport,
  loadHostedStorageProofConfiguration,
  runHostedStorageAdapterProof,
} from "../scripts/hosted-storage-proof-runner.ts";
import { StorageAdapterContractViolation } from "./support/storage-adapter-contract.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname;
const CLI = join(PROJECT_ROOT, "scripts/prove-hosted-storage-adapter.ts");
const FIXED_UUID = "123e4567-e89b-42d3-a456-426614174000";

test("proof configuration is external, same-owner, mode-restricted, and exact", () => {
  const directory = mkdtempSync(join(tmpdir(), "invest-hosted-proof-config-"));
  const project = join(directory, "project");
  const path = join(directory, "proof.json");
  mkdirSync(project);
  writeFileSync(path, JSON.stringify(validConfiguration()), "utf8");
  chmodSync(path, 0o600);

  const configuration = loadHostedStorageProofConfiguration(path, project);
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

test("runner executes the unchanged contract through isolated synthetic names", async () => {
  const states: MemoryStorageState[] = [];
  const report = await runHostedStorageAdapterProof(parsedConfiguration(), {
    randomUUID: () => FIXED_UUID,
    createAdapter: (role) => {
      if (role === "outsider") return new DeniedStorageAdapter();
      const state = new MemoryStorageState();
      states.push(state);
      return new MemoryStorageAdapter(state);
    },
  });

  assert.equal(report.status, "passed");
  if (report.status !== "passed") return;
  assert.equal(report.contract, "storage-adapter");
  assert.equal(report.fixture_count, states.length);
  assert.ok(report.fixture_count > 1);
  assert.equal(
    report.cleanup_inventory.collection_prefix,
    "proof-123e4567e89b42d3a4564266-",
  );
  assert.equal(
    report.cleanup_inventory.operation_prefix,
    "proof:123e4567e89b42d3a4564266:",
  );

  const fixturePrefixes = states.map((state) => {
    const operations = [...state.operations.keys()];
    assert.ok(operations.length > 0);
    const prefix = operations[0]?.split(":").slice(0, 3).join(":");
    assert.notEqual(prefix, undefined);
    assert.ok(`${prefix}:`.startsWith(report.cleanup_inventory.operation_prefix));
    assert.ok(operations.every((operation) => operation.startsWith(`${prefix}:`)));
    const collections = new Set(
      [...state.records.values()].map((record) => record.key.collection),
    );
    assert.ok(collections.size <= 1);
    for (const collection of collections) {
      assert.ok(collection.startsWith(report.cleanup_inventory.collection_prefix));
    }
    return prefix;
  });
  assert.equal(new Set(fixturePrefixes).size, fixturePrefixes.length);
  for (const state of states) {
    for (const operation of state.operations.keys()) {
      assert.ok(operation.startsWith(report.cleanup_inventory.operation_prefix));
    }
  }
});

test("runner reports only allowlisted contract failures and cleanup fields", async () => {
  const secret = syntheticSecret("contract-cause");
  const report = await runHostedStorageAdapterProof(parsedConfiguration(), {
    randomUUID: () => FIXED_UUID,
    createAdapter: () => new DeniedStorageAdapter(),
    verifyContract: async (createFixture) => {
      createFixture();
      throw new StorageAdapterContractViolation("authorization.foreign-read", {
        cause: new Error(secret),
      });
    },
  });
  const output = formatHostedStorageProofReport(report);
  assert.equal(report.status, "failed");
  assert.equal(report.code, "contract_failed");
  assert.equal(output.includes(secret), false);
  assert.match(output, /authorization\.foreign-read/u);
  assert.match(output, /cleanup_inventory/u);

  const unavailable = await runHostedStorageAdapterProof(parsedConfiguration(), {
    randomUUID: () => FIXED_UUID,
    createAdapter: () => new DeniedStorageAdapter(),
    verifyContract: async () => {
      throw new Error(secret);
    },
  });
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
