import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";

import {
  SyntheticAittaDBStorageService,
} from "./support/synthetic-aittadb-storage-service.ts";

const APP_ORIGIN = "https://invest.example.test";
const ISSUER = "https://storage.example.test";
const TRANSPORT_ORIGIN = "https://task111-private-runtime.example.test";
const ENTRY_HREF = `${ISSUER}/bounded-storage`;
const STORAGE_SCOPES = "storage.read storage.write storage.delete";
const OWNER_ACTOR_EMAIL = "task111-private-owner@identity.example.test";
const SYNTHETIC_CANARIES = Object.freeze([
  "TASK111_SyntheticCredential_Canary_7w9L3vX2",
  "TASK111.SyntheticBearerToken.Canary.4nQ8xL2pV7sK9mR5",
  "TASK111_SyntheticClientSecret_8pL4rN7vK2xQ5mC9",
  "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s",
  "r7vsr7vsr7vsr7vsr7vsr7vsr7vsr7vsr7vsr7vsr7w",
  "Task111-Private-Owner@Identity.Example.Test",
  TRANSPORT_ORIGIN,
]);

test("built Worker representations, redirects, CSP, errors, and logs do not disclose runtime values", async () => {
  const logs = [];
  const originalConsole = captureConsole(logs);
  const originalFetch = globalThis.fetch;
  const storage = new SyntheticAittaDBStorageService({
    issuer: ISSUER,
    transportOrigin: TRANSPORT_ORIGIN,
    entryHref: ENTRY_HREF,
    clientId: SYNTHETIC_CANARIES[0],
    clientSecret: SYNTHETIC_CANARIES[2],
    accessToken: SYNTHETIC_CANARIES[1],
    scopes: STORAGE_SCOPES,
  });
  globalThis.fetch = storage.fetch;

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("secret-boundary", `${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const environment = {
      APP_BASE_URL: APP_ORIGIN,
      OWNER_EMAIL: SYNTHETIC_CANARIES[5],
      AITTADB_STORAGE_ISSUER: ISSUER,
      AITTADB_STORAGE_TRANSPORT_ORIGIN: TRANSPORT_ORIGIN,
      AITTADB_STORAGE_ENTRY_HREF: ENTRY_HREF,
      AITTADB_STORAGE_CLIENT_ID: SYNTHETIC_CANARIES[0],
      AITTADB_STORAGE_CLIENT_SECRET: SYNTHETIC_CANARIES[2],
      AITTADB_STORAGE_SCOPES: STORAGE_SCOPES,
      BROWSER_MUTATION_SESSION_KEY: SYNTHETIC_CANARIES[3],
      OWNER_INDICATION_REVIEW_KEY: SYNTHETIC_CANARIES[4],
      DEPLOYMENT_PUBLICATION_READY: "false",
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    };
    const actorHeaders = {
      "oai-authenticated-user-id": "task111-participant-subject",
      "oai-authenticated-user-email": "participant@example.test",
    };
    const ownerHeaders = {
      "oai-authenticated-user-id": "task111-owner-subject",
      "oai-authenticated-user-email": OWNER_ACTOR_EMAIL,
    };
    const requests = [
      request("public HTML", "/", { accept: "text/html" }),
      request("public JSON", "/", { accept: mediaType() }),
      request("participant authentication redirect", "/participant", {
        accept: "text/html",
      }),
      request("participant HTML failure", "/participant", {
        ...actorHeaders,
        accept: "text/html",
      }),
      request("participant JSON failure", "/participant", {
        ...actorHeaders,
        accept: mediaType(),
      }),
      request("owner authentication redirect", "/owner", {
        accept: "text/html",
      }),
      request("owner HTML", "/owner", {
        ...ownerHeaders,
        accept: "text/html",
      }),
      request("owner JSON fixed error", "/owner", {
        ...ownerHeaders,
        accept: mediaType(),
      }),
      request("download route fixed failure", "/owner/exports/review.csv", {
        ...ownerHeaders,
        accept: "text/csv",
      }),
      request("unsupported representation error", "/", {
        accept: "application/xml",
      }),
    ];

    for (const [label, current] of requests) {
      const response = await worker.fetch(current, environment, executionContext());
      const material = await responseMaterial(label, response);
      assertNoCanaries(material, label);
      assert.ok(response.status >= 200 && response.status <= 599, label);
    }
    assert.ok(storage.tokenRequests > 0);
    assert.ok(storage.discoveryRequests > 0);
    assertNoCanaries(logs.join("\n"), "console output");
  } finally {
    globalThis.fetch = originalFetch;
    restoreConsole(originalConsole);
  }
});

function request(label, pathname, headers) {
  return [label, new Request(new URL(pathname, APP_ORIGIN), {
    headers,
    redirect: "manual",
  })];
}

function mediaType() {
  return 'application/vnd.aittadb-invest+json; version="0.1"';
}

function executionContext() {
  return {
    waitUntil() {},
    passThroughOnException() {},
  };
}

async function responseMaterial(label, response) {
  return [
    label,
    `${response.status} ${response.statusText}`,
    ...[...response.headers].flat(),
    await response.text(),
  ].join("\n");
}

function captureConsole(output) {
  const methods = ["debug", "error", "info", "log", "warn"];
  const original = new Map();
  for (const method of methods) {
    original.set(method, console[method]);
    console[method] = (...values) => {
      output.push(values.map((value) => inspect(value, { depth: 8 })).join(" "));
    };
  }
  return original;
}

function restoreConsole(original) {
  for (const [method, implementation] of original) {
    console[method] = implementation;
  }
}

function assertNoCanaries(value, boundary) {
  for (const canary of SYNTHETIC_CANARIES) {
    assert.equal(
      value.includes(canary),
      false,
      `synthetic private value crossed the built Worker ${boundary}`,
    );
  }
}
