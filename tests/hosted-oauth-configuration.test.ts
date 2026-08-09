import assert from "node:assert/strict";
import test from "node:test";

import {
  parseHostedAittaDBOAuthConfiguration,
  type HostedAittaDBOAuthEnvironment,
} from "../worker/hosted-oauth-configuration.ts";

const APP_ORIGIN = "https://invest.example.test";
const CALLBACK = `${APP_ORIGIN}/owner/aittadb-connection/callback`;
const TRANSACTION_KEY = keyMaterial(1);
const CSRF_KEY = keyMaterial(65);

const configuredEnvironment = Object.freeze({
  APP_BASE_URL: APP_ORIGIN,
  AITTADB_OAUTH_ISSUER: "https://storage.example.test",
  AITTADB_OAUTH_CLIENT_ID: "investor-app-acceptance",
  AITTADB_OAUTH_CLIENT_SECRET: "hosted-secret-value",
  AITTADB_OAUTH_CALLBACK_URI: CALLBACK,
  AITTADB_OAUTH_STORAGE_SCOPES: "storage.read storage.write",
  AITTADB_OAUTH_TRANSACTION_KEY: TRANSACTION_KEY,
  AITTADB_OAUTH_CSRF_KEY: CSRF_KEY,
} satisfies HostedAittaDBOAuthEnvironment);

test("hosted OAuth stays disabled when no OAuth values are present", async () => {
  assert.equal(
    await parseHostedAittaDBOAuthConfiguration({ APP_BASE_URL: APP_ORIGIN }),
    null,
  );
});

test("complete hosted OAuth configuration is exact and imports separate keys", async () => {
  const configuration = await parseHostedAittaDBOAuthConfiguration(
    configuredEnvironment,
  );

  assert.ok(configuration);
  assert.equal(configuration.appOrigin, APP_ORIGIN);
  assert.equal(configuration.issuer, "https://storage.example.test");
  assert.equal(configuration.clientId, "investor-app-acceptance");
  assert.equal(configuration.clientSecret, "hosted-secret-value");
  assert.equal(configuration.callbackUri, CALLBACK);
  assert.deepEqual(configuration.storageScopes, [
    "storage.read",
    "storage.write",
  ]);
  assert.equal(configuration.transactionCookieKey.algorithm.name, "AES-GCM");
  assert.equal(configuration.transactionCookieKey.extractable, false);
  assert.deepEqual(configuration.transactionCookieKey.usages, [
    "encrypt",
    "decrypt",
  ]);
  assert.equal(configuration.csrfCookieKey.algorithm.name, "AES-GCM");
  assert.equal(configuration.csrfCookieKey.extractable, false);
  assert.notEqual(
    configuration.transactionCookieKey,
    configuration.csrfCookieKey,
  );
  assert.ok(Object.isFrozen(configuration));
  assert.ok(Object.isFrozen(configuration.storageScopes));
});

test("partial hosted OAuth configuration fails closed", async () => {
  for (const field of Object.keys(configuredEnvironment)) {
    if (field === "APP_BASE_URL") continue;
    const partial = { ...configuredEnvironment } as Record<string, unknown>;
    delete partial[field];
    assert.equal(
      await parseHostedAittaDBOAuthConfiguration(partial),
      null,
      `${field} must be required`,
    );
  }
});

test("malformed hosted OAuth values fail closed without reflecting secrets", async () => {
  const secret = "private-client-secret";
  const invalidValues: readonly [string, unknown][] = [
    ["APP_BASE_URL", "http://invest.example.test"],
    ["APP_BASE_URL", `${APP_ORIGIN}/owner`],
    ["AITTADB_OAUTH_ISSUER", "https://storage.example.test/api"],
    ["AITTADB_OAUTH_ISSUER", "https://user@storage.example.test"],
    ["AITTADB_OAUTH_CLIENT_ID", "client:with-colon"],
    ["AITTADB_OAUTH_CLIENT_SECRET", "too-short"],
    ["AITTADB_OAUTH_CLIENT_SECRET", `${secret}\n`],
    ["AITTADB_OAUTH_CALLBACK_URI", "https://other.example.test/owner/aittadb-connection/callback"],
    ["AITTADB_OAUTH_CALLBACK_URI", `${CALLBACK}?code=unexpected`],
    ["AITTADB_OAUTH_STORAGE_SCOPES", "storage.write storage.read"],
    ["AITTADB_OAUTH_STORAGE_SCOPES", "storage.read storage.read"],
    ["AITTADB_OAUTH_STORAGE_SCOPES", "openid"],
    ["AITTADB_OAUTH_TRANSACTION_KEY", "not-base64url"],
    ["AITTADB_OAUTH_CSRF_KEY", TRANSACTION_KEY],
  ];

  for (const [field, value] of invalidValues) {
    const parsed = await parseHostedAittaDBOAuthConfiguration({
      ...configuredEnvironment,
      AITTADB_OAUTH_CLIENT_SECRET: secret,
      [field]: value,
    });
    assert.equal(parsed, null, `${field} must fail closed`);
    assert.doesNotMatch(JSON.stringify(parsed), new RegExp(secret, "u"));
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
