import assert from "node:assert/strict";
import test from "node:test";

import {
  parseHostedAittaDBApplicationConfiguration,
  type HostedAittaDBApplicationEnvironment,
} from "../worker/hosted-application-configuration.ts";

const APP_ORIGIN = "https://invest.example.test";
const ISSUER = "https://storage.example.test";
const ENTRY_HREF = `${ISSUER}/bounded-storage`;
const MUTATION_KEY = keyMaterial(1);
const SERVICE_SECRET = "application-service-client-secret";

const configuredEnvironment = Object.freeze({
  APP_BASE_URL: APP_ORIGIN,
  AITTADB_STORAGE_ISSUER: ISSUER,
  AITTADB_STORAGE_ENTRY_HREF: ENTRY_HREF,
  AITTADB_STORAGE_CLIENT_ID: "investor-app-service",
  AITTADB_STORAGE_CLIENT_SECRET: SERVICE_SECRET,
  AITTADB_STORAGE_SCOPES:
    "storage.read storage.write storage.delete",
  BROWSER_MUTATION_SESSION_KEY: MUTATION_KEY,
} satisfies HostedAittaDBApplicationEnvironment);

test("application runtime stays disabled without application storage values", async () => {
  assert.equal(
    await parseHostedAittaDBApplicationConfiguration({
      APP_BASE_URL: APP_ORIGIN,
      OWNER_EMAIL: "ignored@example.test",
    } as HostedAittaDBApplicationEnvironment),
    null,
  );
  assert.equal(
    await parseHostedAittaDBApplicationConfiguration(
      new Proxy({} as HostedAittaDBApplicationEnvironment, {
        get() {
          throw new Error("private environment detail");
        },
      }),
    ),
    null,
  );
});

test("complete application configuration is exact and imports a closed key", async () => {
  const configuration = await parseHostedAittaDBApplicationConfiguration(
    configuredEnvironment,
  );

  assert.ok(configuration);
  assert.equal(configuration.appOrigin, APP_ORIGIN);
  assert.equal(configuration.issuer, ISSUER);
  assert.equal(configuration.transportOrigin, ISSUER);
  assert.equal(configuration.storageEntryHref, ENTRY_HREF);
  assert.deepEqual(configuration.storageScopes, [
    "storage.read",
    "storage.write",
    "storage.delete",
  ]);
  assert.equal(configuration.mutationKey.algorithm.name, "AES-GCM");
  assert.equal(configuration.mutationKey.extractable, false);
  assert.deepEqual(configuration.mutationKey.usages, ["encrypt", "decrypt"]);
  assert.equal(Object.isFrozen(configuration), true);
  assert.equal(Object.isFrozen(configuration.storageScopes), true);
  assert.equal(typeof configuration.createServiceTokenProvider, "function");
  assert.equal("serviceClientId" in configuration, false);
  assert.equal("serviceClientSecret" in configuration, false);
  const serialized = JSON.stringify(configuration);
  assert.equal(serialized.includes("investor-app-service"), false);
  assert.equal(serialized.includes(SERVICE_SECRET), false);
});

test("optional transport origin stays independent from logical storage URLs", async () => {
  const configuration = await parseHostedAittaDBApplicationConfiguration({
    ...configuredEnvironment,
    AITTADB_STORAGE_TRANSPORT_ORIGIN:
      "https://storage-runtime.example.test",
  });

  assert.ok(configuration);
  assert.equal(configuration.issuer, ISSUER);
  assert.equal(configuration.storageEntryHref, ENTRY_HREF);
  assert.equal(
    configuration.transportOrigin,
    "https://storage-runtime.example.test",
  );
});

test("every application storage value is required once the runtime is enabled", async () => {
  for (const field of Object.keys(configuredEnvironment)) {
    if (field === "APP_BASE_URL") continue;
    const partial = { ...configuredEnvironment } as Record<string, unknown>;
    delete partial[field];
    assert.equal(
      await parseHostedAittaDBApplicationConfiguration(partial),
      null,
      `${field} must be required`,
    );
  }

  assert.equal(
    await parseHostedAittaDBApplicationConfiguration({
      AITTADB_STORAGE_ISSUER: ISSUER,
    }),
    null,
  );
});

test("malformed origins, discovery, credentials, scopes, and keys fail closed", async () => {
  const invalidValues: readonly [string, unknown][] = [
    ["APP_BASE_URL", "http://invest.example.test"],
    ["APP_BASE_URL", `${APP_ORIGIN}/owner`],
    ["AITTADB_STORAGE_ISSUER", `${ISSUER}/api`],
    ["AITTADB_STORAGE_ISSUER", "https://user@storage.example.test"],
    ["AITTADB_STORAGE_TRANSPORT_ORIGIN", "http://storage-runtime.example.test"],
    ["AITTADB_STORAGE_ENTRY_HREF", "https://other.example.test/storage"],
    ["AITTADB_STORAGE_ENTRY_HREF", `${ENTRY_HREF}?namespace=private`],
    ["AITTADB_STORAGE_CLIENT_ID", "client:with-colon"],
    ["AITTADB_STORAGE_CLIENT_SECRET", "too-short"],
    ["AITTADB_STORAGE_CLIENT_SECRET", `${SERVICE_SECRET}\n`],
    ["AITTADB_STORAGE_SCOPES", "storage.read storage.write"],
    ["AITTADB_STORAGE_SCOPES", "storage.write storage.read storage.delete"],
    ["AITTADB_STORAGE_SCOPES", "storage.read storage.write openid"],
    ["BROWSER_MUTATION_SESSION_KEY", "not-base64url"],
  ];

  for (const [field, value] of invalidValues) {
    const parsed = await parseHostedAittaDBApplicationConfiguration({
      ...configuredEnvironment,
      [field]: value,
    });
    assert.equal(parsed, null, `${field} must fail closed`);
    assert.doesNotMatch(JSON.stringify(parsed), new RegExp(SERVICE_SECRET, "u"));
  }
});

test("application and interactive proof material is pairwise distinct", async () => {
  const fields = [
    "AITTADB_STORAGE_CLIENT_ID",
    "AITTADB_STORAGE_CLIENT_SECRET",
    "BROWSER_MUTATION_SESSION_KEY",
    "AITTADB_OAUTH_CLIENT_ID",
    "AITTADB_OAUTH_CLIENT_SECRET",
    "AITTADB_OAUTH_TRANSACTION_KEY",
    "AITTADB_OAUTH_CSRF_KEY",
  ] as const;
  const pairwiseEnvironment = {
    ...configuredEnvironment,
    AITTADB_STORAGE_CLIENT_ID: keyMaterial(21),
    AITTADB_STORAGE_CLIENT_SECRET: keyMaterial(22),
    BROWSER_MUTATION_SESSION_KEY: keyMaterial(23),
    AITTADB_OAUTH_CLIENT_ID: keyMaterial(24),
    AITTADB_OAUTH_CLIENT_SECRET: keyMaterial(25),
    AITTADB_OAUTH_TRANSACTION_KEY: keyMaterial(26),
    AITTADB_OAUTH_CSRF_KEY: keyMaterial(27),
  } satisfies HostedAittaDBApplicationEnvironment;
  assert.ok(
    await parseHostedAittaDBApplicationConfiguration(pairwiseEnvironment),
  );

  for (let first = 0; first < fields.length; first += 1) {
    for (let second = first + 1; second < fields.length; second += 1) {
      const firstField = fields[first];
      const secondField = fields[second];
      assert.ok(firstField);
      assert.ok(secondField);
      const reused = {
        ...pairwiseEnvironment,
        [secondField]: pairwiseEnvironment[firstField],
      };
      assert.equal(
        await parseHostedAittaDBApplicationConfiguration(reused),
        null,
        `${firstField} and ${secondField} must not match`,
      );
    }
  }
});

function keyMaterial(seed: number): string {
  const bytes = Uint8Array.from(
    { length: 32 },
    (_, index) => (seed + index) % 256,
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
