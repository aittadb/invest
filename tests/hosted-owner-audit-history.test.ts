import assert from "node:assert/strict";
import test from "node:test";

import type { OwnerAuditCollectionDocument } from "../domain/owner-audit-notification-resource.ts";
import type { OwnerHomeDocument } from "../domain/owner-home-resource.ts";
import {
  parseStorageKey,
  parseStorageOperationId,
} from "../domain/storage-adapter.ts";
import {
  OWNER_AUDIT_HISTORY_HEADER,
  OWNER_NOTIFICATION_HISTORY_HEADER,
} from "../http/runtime-capabilities.ts";
import { AittaDBStorageAdapter } from "../repositories/aittadb-storage-adapter.ts";
import { DevelopmentInMemoryAuditRepository } from "../repositories/in-memory-audit-notification-repositories.ts";
import { createApplicationWorker } from "../worker/application-worker.ts";
import type {
  InvestorAppEnv,
  WorkerExecutionContext,
} from "../worker/contracts.ts";
import { createHostedApplicationRuntimeResolver } from "../worker/hosted-application-composition.ts";
import { SyntheticAittaDBStorageService } from "./support/synthetic-aittadb-storage-service.ts";

const APP_ORIGIN = "https://invest.example.test";
const ISSUER = "https://storage.example.test";
const TRANSPORT_ORIGIN = "https://storage-runtime.example.test";
const ENTRY_HREF = `${ISSUER}/bounded-storage`;
const CLIENT_ID = "investor-app-audit-reader";
const CLIENT_SECRET = "audit-reader-service-secret";
const ACCESS_TOKEN = "private-audit-reader-access-token";
const SCOPES = "storage.read storage.write storage.delete";
const OWNER_SUBJECT = "oidc:configured-owner";
const OWNER_EMAIL = "owner@example.test";
const PRIVATE_SENTINEL = "PRIVATE FUTURE AUDIT EVIDENCE";
const MUTATION_KEY = keyMaterial(41);
const NOW = new Date("2026-08-11T09:00:00.000Z");

const executionContext: WorkerExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

test("hosted owner pages persistent AittaDB audit history across Workers", async () => {
  const service = storageService();
  await seedAudit(service, "audit-event:01", "audit-operation:01");
  await seedAudit(service, "audit-event:02", "audit-operation:02");
  const env = environment();

  const firstWorker = hostedWorker(service);
  const firstResponse = await firstWorker.fetch(
    ownerRequest("/owner/audit-events?page_size=1"),
    env,
    executionContext,
  );
  assert.equal(firstResponse.status, 200);
  assert.equal(firstResponse.headers.get("cache-control"), "no-store");
  const first = await firstResponse.json() as OwnerAuditCollectionDocument;
  assert.deepEqual(first.data.items.map(({ id }) => id), ["audit-event:01"]);
  assert.equal(first.data.items[0]?.actor.subject, OWNER_SUBJECT);
  assert.equal(first.actions.length, 0);
  assert.equal(
    first.links.some((link) => link.rel.includes("manual-notifications")),
    true,
  );
  assert.equal(
    first.links.find((link) => link.rel.includes("owner"))?.href,
    `${APP_ORIGIN}/owner`,
  );
  assert.equal(
    first.links.find((link) => link.rel.includes("campaign"))?.href,
    `${APP_ORIGIN}/`,
  );
  const next = first.links.find((link) => link.rel.includes("next"));
  assert.ok(next);
  assert.match(next.href, /^https:\/\/invest\.example\.test\//u);

  const restartedWorker = hostedWorker(service);
  const secondResponse = await restartedWorker.fetch(
    ownerRequest(new URL(next.href).pathname + new URL(next.href).search),
    env,
    executionContext,
  );
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json() as OwnerAuditCollectionDocument;
  assert.deepEqual(second.data.items.map(({ id }) => id), ["audit-event:02"]);
  assert.equal(second.links.some((link) => link.rel.includes("next")), false);

  const htmlResponse = await restartedWorker.fetch(
    ownerRequest("/owner/audit-events?page_size=1", "text/html"),
    env,
    executionContext,
  );
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.match(html, /audit-event:01/u);
  assert.match(html, new RegExp(OWNER_SUBJECT, "u"));
  assert.match(html, /campaign:public/u);
  assert.match(html, /Manual notifications/u);
  assert.doesNotMatch(html, /storage-runtime|service-secret|access-token/iu);

  const homeResponse = await restartedWorker.fetch(
    ownerRequest("/owner"),
    env,
    executionContext,
  );
  assert.equal(homeResponse.status, 200);
  const home = await homeResponse.json() as OwnerHomeDocument;
  assert.ok(home.links.some((link) => link.rel.includes("audit-events")));
  assert.equal(
    home.links.some((link) => link.rel.includes("manual-notifications")),
    true,
  );

  const renderedHome = await restartedWorker.fetch(
    ownerRequest("/owner", "text/html"),
    env,
    executionContext,
  );
  assert.equal(await renderedHome.text(), "available:available");
});

test("hosted audit route rejects malformed and unauthorized requests without disclosure", async () => {
  const service = storageService();
  await seedAudit(service, "audit-event:private", "audit-operation:private");
  const worker = hostedWorker(service);
  const env = environment();

  for (const path of [
    "/owner/audit-events?page_size=101",
    "/owner/audit-events?cursor=",
    "/owner/audit-events?cursor=line%0Abreak",
    `/owner/audit-events?cursor=${"x".repeat(513)}`,
  ]) {
    const response = await worker.fetch(ownerRequest(path), env, executionContext);
    assert.equal(response.status, 400, path);
  }

  const anonymous = await worker.fetch(
    new Request(`${APP_ORIGIN}/owner/audit-events`, {
      headers: { accept: "application/json" },
    }),
    env,
    executionContext,
  );
  assert.equal(anonymous.status, 401);
  const foreign = await worker.fetch(
    new Request(`${APP_ORIGIN}/owner/audit-events`, {
      headers: {
        accept: "application/json",
        "oai-authenticated-user-id": "oidc:foreign",
        "oai-authenticated-user-email": "foreign@example.test",
      },
    }),
    env,
    executionContext,
  );
  const foreignBody = await foreign.text();
  assert.equal(foreign.status, 404);
  assert.doesNotMatch(
    foreignBody,
    /audit-event:private|configured-owner|service-secret|access-token/iu,
  );
});

test("hosted audit reader treats unknown stored evidence as unavailable", async () => {
  const service = storageService();
  const adapter = storageAdapter(service);
  const key = parseStorageKey("audit-events", "audit-event:future");
  const operation = parseStorageOperationId("audit-operation:seed-future");
  assert(key.ok);
  assert(operation.ok);
  await adapter.transact({
    operationId: operation.value,
    mutations: [{
      type: "put",
      key: key.value,
      expectedRevision: null,
      value: {
        kind: "audit-event",
        schemaVersion: 1,
        event: {
          id: "audit-event:future",
          operationId: "audit-operation:future",
          occurredAt: "2026-08-11T08:00:00.000Z",
          actor: { type: "owner", subject: OWNER_SUBJECT },
          detail: {
            kind: "future-private-evidence",
            private: PRIVATE_SENTINEL,
          },
        },
      },
    }],
  });

  const response = await hostedWorker(service).fetch(
    ownerRequest("/owner/audit-events"),
    environment(),
    executionContext,
  );
  const body = await response.text();
  assert.equal(response.status, 503);
  assert.doesNotMatch(
    body,
    new RegExp(
      `${PRIVATE_SENTINEL}|${CLIENT_SECRET}|${ACCESS_TOKEN}|future-private-evidence`,
      "u",
    ),
  );
});

function hostedWorker(service: SyntheticAittaDBStorageService) {
  return createApplicationWorker({
    fetchApplication: async (request) =>
      new Response([
        request.headers.get(OWNER_AUDIT_HISTORY_HEADER) ?? "missing",
        request.headers.get(OWNER_NOTIFICATION_HISTORY_HEADER) ?? "missing",
      ].join(":")),
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: createHostedApplicationRuntimeResolver({
      fetch: service.fetch,
      now: () => NOW,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    }),
  });
}

function storageService(): SyntheticAittaDBStorageService {
  return new SyntheticAittaDBStorageService({
    issuer: ISSUER,
    transportOrigin: TRANSPORT_ORIGIN,
    entryHref: ENTRY_HREF,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    accessToken: ACCESS_TOKEN,
    scopes: SCOPES,
  });
}

function storageAdapter(
  service: SyntheticAittaDBStorageService,
): AittaDBStorageAdapter {
  return new AittaDBStorageAdapter({
    issuer: ISSUER,
    transportOrigin: TRANSPORT_ORIGIN,
    entryHref: ENTRY_HREF,
    accessToken: () => ACCESS_TOKEN,
    fetch: service.fetch,
  });
}

async function seedAudit(
  service: SyntheticAittaDBStorageService,
  id: string,
  operationId: string,
): Promise<void> {
  await new DevelopmentInMemoryAuditRepository(storageAdapter(service)).append({
    type: "append-audit-event",
    event: {
      id,
      operationId,
      occurredAt: "2026-08-11T08:00:00.000Z",
      actor: { type: "owner", subject: OWNER_SUBJECT },
      detail: {
        kind: "resource-transition",
        resource: { type: "campaign", id: "campaign:public" },
        transition: "updated",
      },
    },
  });
}

function ownerRequest(path: string, accept = "application/json"): Request {
  return new Request(new URL(path, APP_ORIGIN), {
    headers: {
      accept,
      "oai-authenticated-user-id": OWNER_SUBJECT,
      "oai-authenticated-user-email": OWNER_EMAIL,
    },
  });
}

function environment(): InvestorAppEnv {
  return {
    APP_BASE_URL: APP_ORIGIN,
    AITTADB_STORAGE_ISSUER: ISSUER,
    AITTADB_STORAGE_TRANSPORT_ORIGIN: TRANSPORT_ORIGIN,
    AITTADB_STORAGE_ENTRY_HREF: ENTRY_HREF,
    AITTADB_STORAGE_CLIENT_ID: CLIENT_ID,
    AITTADB_STORAGE_CLIENT_SECRET: CLIENT_SECRET,
    AITTADB_STORAGE_SCOPES: SCOPES,
    BROWSER_MUTATION_SESSION_KEY: MUTATION_KEY,
    OWNER_EMAIL,
    ASSETS: { fetch: async () => new Response("asset") },
    IMAGES: {
      input: () => ({
        transform: () => ({
          output: async () => ({ response: () => new Response("image") }),
        }),
      }),
    },
  };
}

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
