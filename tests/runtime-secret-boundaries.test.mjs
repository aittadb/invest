import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";

const SYNTHETIC_CANARIES = Object.freeze([
  "TASK067_SyntheticCredential_Canary_7w9L3vX2",
  "TASK067.SyntheticToken.Canary.4nQ8xL2pV7sK9mR5",
  "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6s",
]);

test("built Worker responses and logs do not disclose hosted secrets", async () => {
  const logs = [];
  const originalConsole = captureConsole(logs);

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("secret-boundary", `${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      new Request("https://invest.example.com/", {
        headers: {
          accept: "text/html",
          authorization: `Bearer ${SYNTHETIC_CANARIES[1]}`,
        },
      }),
      {
        APP_BASE_URL: "https://invest.example.com",
        AITTADB_STORAGE_ISSUER: "https://storage.example.com",
        AITTADB_STORAGE_ENTRY_HREF: "https://storage.example.com/storage",
        AITTADB_STORAGE_CLIENT_ID: "task-067-runtime-boundary-client",
        AITTADB_STORAGE_CLIENT_SECRET: SYNTHETIC_CANARIES[0],
        AITTADB_STORAGE_SCOPES: "storage.read storage.write storage.delete",
        BROWSER_MUTATION_SESSION_KEY: SYNTHETIC_CANARIES[2],
        ASSETS: {
          fetch: async () => new Response("Not found", { status: 404 }),
        },
      },
      {
        waitUntil() {},
        passThroughOnException() {},
      },
    );

    const responseMaterial = [
      `${response.status} ${response.statusText}`,
      ...[...response.headers].flat(),
      await response.text(),
    ].join("\n");
    assert.equal(response.status, 200);
    assertNoCanaries(responseMaterial, "response material");
    assertNoCanaries(logs.join("\n"), "console output");
  } finally {
    restoreConsole(originalConsole);
  }
});

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
      `synthetic secret crossed the built Worker ${boundary}`,
    );
  }
}
