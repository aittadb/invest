import assert from "node:assert/strict";
import test from "node:test";

import type { HypermediaAction } from "../domain/public-campaign-resource.ts";
import type {
  OwnerAuditCollectionDocument,
  OwnerNotificationCollectionDocument,
  OwnerNotificationDetailDocument,
} from "../domain/owner-audit-notification-resource.ts";
import {
  parseStorageKey,
  parseStorageOperationId,
} from "../domain/storage-adapter.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
} from "../http/mutation-security.ts";
import { AittaDBStorageAdapter } from "../repositories/aittadb-storage-adapter.ts";
import { StorageManualNotificationRepository } from "../repositories/in-memory-audit-notification-repositories.ts";
import { createApplicationWorker } from "../worker/application-worker.ts";
import type {
  InvestorAppEnv,
  WorkerExecutionContext,
} from "../worker/contracts.ts";
import { createHostedApplicationRuntimeResolver } from "../worker/hosted-application-composition.ts";
import {
  SyntheticAittaDBStorageService,
  type SyntheticAittaDBStorageServiceOptions,
} from "./support/synthetic-aittadb-storage-service.ts";

const APP_ORIGIN = "https://invest.example.test";
const ISSUER = "https://storage.example.test";
const TRANSPORT_ORIGIN = "https://storage-runtime.example.test";
const ENTRY_HREF = `${ISSUER}/bounded-storage`;
const CLIENT_ID = "investor-app-notification-history";
const CLIENT_SECRET = "notification-history-service-secret";
const ACCESS_TOKEN = "private-notification-history-access-token";
const SCOPES = "storage.read storage.write storage.delete";
const OWNER_SUBJECT = "oidc:configured-owner";
const REPLACEMENT_OWNER_SUBJECT = "oidc:replacement-owner";
const OWNER_EMAIL = "owner@example.test";
const PARTICIPANT_SUBJECT = "oidc:notification-recipient";
const NOTIFICATION_ID = "notification:hosted-history";
const PRIVATE_SUBJECT = "Private application status update";
const PRIVATE_BODY = "Sign in to review the private status details.";
const MUTATION_KEY = keyMaterial(57);
const NOW = new Date("2026-08-11T10:00:00.000Z");

const executionContext: WorkerExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

test("hosted owner notification activity survives response loss and Worker restart", async () => {
  let failedOperation: string | null = null;
  let failOnce = true;
  const service = storageService({
    failCommittedTransaction(operationId) {
      if (failOnce && operationId === failedOperation) {
        failOnce = false;
        return "unavailable";
      }
      return null;
    },
  });
  await seedNotification(service);
  const env = environment();
  const randomBytes = deterministicRandomBytes(71);
  const firstWorker = hostedWorker(service, NOW, randomBytes);

  const collectionResponse = await firstWorker.fetch(
    ownerRequest("/owner/manual-notifications?page_size=1"),
    env,
    executionContext,
  );
  assert.equal(collectionResponse.status, 200);
  assert.equal(collectionResponse.headers.get("cache-control"), "no-store");
  const collection = await collectionResponse.json() as
    OwnerNotificationCollectionDocument;
  assert.deepEqual(collection.data.items.map(({ subject_line }) => subject_line), [
    PRIVATE_SUBJECT,
  ]);
  const item = collection.links.find((link) => link.rel.includes("item"));
  assert.equal(
    item?.href,
    `${APP_ORIGIN}/owner/manual-notifications/notification%3Ahosted-history`,
  );

  const firstDetailResponse = await firstWorker.fetch(
    ownerRequest(new URL(requiredHref(item)).pathname),
    env,
    executionContext,
  );
  const firstProof = mutationProof(firstDetailResponse);
  const firstDetail = await firstDetailResponse.json() as
    OwnerNotificationDetailDocument;
  assert.equal(firstDetail.data.revision, 1);
  assert.equal(firstDetail.data.subject_line, PRIVATE_SUBJECT);
  assert.equal(firstDetail.data.body, PRIVATE_BODY);
  assert.deepEqual(actionNames(firstDetail), [
    "record-notification-template-copy",
    "mark-notification-sent",
  ]);

  const copy = requiredAction(
    firstDetail,
    "record-notification-template-copy",
  );
  const copyBody = actionBody(copy);
  failedOperation = String(copyBody["operation-id"]);
  const recoveredResponse = await submitJson(
    firstWorker,
    copy.href,
    copyBody,
    firstProof,
    env,
  );
  assert.equal(recoveredResponse.status, 200);
  assert.match(
    recoveredResponse.headers.get("set-cookie") ?? "",
    /Max-Age=0/u,
  );

  const committed = await notificationRepository(service).get(NOTIFICATION_ID);
  assert.equal(committed?.revision, 2);
  assert.equal(committed?.record.copyEvidence.length, 1);
  const originalCopyTime = committed?.record.copyEvidence[0]?.copiedAt;
  assert.ok(originalCopyTime);

  const retryTime = new Date(NOW.valueOf() + 60_000);
  const restartedWorker = hostedWorker(service, retryTime, randomBytes);
  const retryDetailResponse = await restartedWorker.fetch(
    ownerRequest(`/owner/manual-notifications/${encodeURIComponent(NOTIFICATION_ID)}`),
    env,
    executionContext,
  );
  const retryProof = mutationProof(retryDetailResponse);
  const retry = await submitJson(
    restartedWorker,
    copy.href,
    copyBody,
    retryProof,
    env,
  );
  assert.equal(retry.status, 200);
  const retryDetail = await retry.json() as OwnerNotificationDetailDocument;
  assert.equal(retryDetail.data.revision, 2);
  assert.equal(retryDetail.data.copy_history.length, 1);
  assert.equal(retryDetail.data.copy_history[0]?.copied_at, originalCopyTime);
  assert.equal(
    service.transactionOperationIds.filter((value) => value === failedOperation)
      .length,
    1,
  );

  const sentDiscovery = await restartedWorker.fetch(
    ownerRequest(`/owner/manual-notifications/${encodeURIComponent(NOTIFICATION_ID)}`),
    env,
    executionContext,
  );
  const sentProof = mutationProof(sentDiscovery);
  const sentDocument = await sentDiscovery.json() as
    OwnerNotificationDetailDocument;
  const sentAction = requiredAction(sentDocument, "mark-notification-sent");
  const sentResponse = await submitForm(
    restartedWorker,
    sentAction,
    sentProof,
    env,
  );
  assert.equal(sentResponse.status, 200);
  const sentDetail = await sentResponse.json() as
    OwnerNotificationDetailDocument;
  assert.equal(sentDetail.data.revision, 3);
  assert.equal(sentDetail.data.delivery_state, "marked-sent");
  assert.equal(sentDetail.data.copy_history.length, 1);
  assert.equal(
    sentDetail.actions.some(({ name }) => name === "mark-notification-sent"),
    false,
  );

  const readsBeforeFinalDetail = notificationReadCount(service);
  const boundedDetail = await restartedWorker.fetch(
    ownerRequest(`/owner/manual-notifications/${encodeURIComponent(NOTIFICATION_ID)}`),
    env,
    executionContext,
  );
  assert.equal(boundedDetail.status, 200);
  assert.equal(notificationReadCount(service) - readsBeforeFinalDetail, 4);

  const auditResponse = await restartedWorker.fetch(
    ownerRequest("/owner/audit-events?page_size=10"),
    env,
    executionContext,
  );
  const audits = await auditResponse.json() as OwnerAuditCollectionDocument;
  assert.deepEqual(
    audits.data.items.map(({ detail }) =>
      detail.kind === "manual-notification" ? detail.activity : null
    ).sort(),
    ["sent-marked", "template-copied"],
  );

  const finalWorker = hostedWorker(
    service,
    new Date(NOW.valueOf() + 120_000),
    randomBytes,
  );
  const htmlResponse = await finalWorker.fetch(
    ownerRequest(
      `/owner/manual-notifications/${encodeURIComponent(NOTIFICATION_ID)}`,
      "text/html",
    ),
    env,
    executionContext,
  );
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.match(html, new RegExp(PRIVATE_SUBJECT, "u"));
  assert.match(html, new RegExp(PRIVATE_BODY, "u"));
  assert.match(html, /Revision 3|Marked sent/u);
  assert.doesNotMatch(html, /service-secret|access-token|storage-runtime/iu);
});

test("hosted notification proofs reject unsafe requests before durable claim", async () => {
  const service = storageService();
  await seedNotification(service);
  const env = environment();
  const worker = hostedWorker(service, NOW, deterministicRandomBytes(91));
  const path = `/owner/manual-notifications/${encodeURIComponent(NOTIFICATION_ID)}`;

  const discovery = await worker.fetch(
    ownerRequest(path),
    env,
    executionContext,
  );
  const proof = mutationProof(discovery);
  const document = await discovery.json() as OwnerNotificationDetailDocument;
  const copy = requiredAction(document, "record-notification-template-copy");
  const body = actionBody(copy);

  const malformed = await submitJson(
    worker,
    copy.href,
    { ...body, private_extra: "must-not-be-accepted" },
    proof,
    env,
  );
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get("set-cookie"), null);

  const afterMalformed = await submitJson(
    worker,
    copy.href,
    body,
    proof,
    env,
  );
  assert.equal(afterMalformed.status, 200);
  const afterMalformedDocument = await afterMalformed.json() as
    OwnerNotificationDetailDocument;
  assert.equal(afterMalformedDocument.data.revision, 2);

  const replay = await submitJson(
    worker,
    copy.href,
    body,
    proof,
    env,
  );
  assert.equal(replay.status, 403);
  assert.equal((await notificationRepository(service).get(NOTIFICATION_ID))?.revision, 2);

  const oversizedDiscovery = await worker.fetch(
    ownerRequest(path),
    env,
    executionContext,
  );
  const oversizedProof = mutationProof(oversizedDiscovery);
  const oversizedDocument = await oversizedDiscovery.json() as
    OwnerNotificationDetailDocument;
  const secondCopy = requiredAction(
    oversizedDocument,
    "record-notification-template-copy",
  );
  const secondBody = actionBody(secondCopy);
  const oversized = await submitRawJson(
    worker,
    secondCopy.href,
    JSON.stringify({ ...secondBody, padding: "x".repeat(2_000) }),
    oversizedProof,
    env,
  );
  assert.equal(oversized.status, 413);
  const afterOversized = await submitJson(
    worker,
    secondCopy.href,
    secondBody,
    oversizedProof,
    env,
  );
  assert.equal(afterOversized.status, 200);
  assert.equal(
    (await afterOversized.json() as OwnerNotificationDetailDocument).data.revision,
    3,
  );

  const staleDiscovery = await worker.fetch(
    ownerRequest(path),
    env,
    executionContext,
  );
  const staleProof = mutationProof(staleDiscovery);
  const staleDocument = await staleDiscovery.json() as
    OwnerNotificationDetailDocument;
  const staleAction = requiredAction(
    staleDocument,
    "record-notification-template-copy",
  );
  const staleBody = { ...actionBody(staleAction), "expected-revision": 1 };
  const stale = await submitJson(
    worker,
    staleAction.href,
    staleBody,
    staleProof,
    env,
  );
  assert.equal(stale.status, 412);
  assert.match(stale.headers.get("set-cookie") ?? "", /Max-Age=0/u);
  const consumedStaleProof = await submitJson(
    worker,
    staleAction.href,
    staleBody,
    staleProof,
    env,
  );
  assert.equal(consumedStaleProof.status, 403);
});

test("hosted notification authorization, owner continuity, malformed IDs, and rollback fail closed", async () => {
  const rejectedOperations = new Set<string>();
  const service = storageService({
    rejectTransaction(operationId) {
      return rejectedOperations.has(operationId) ? "unavailable" : null;
    },
  });
  await seedNotification(service);
  const env = environment();
  const worker = hostedWorker(service, NOW, deterministicRandomBytes(111));
  const path = `/owner/manual-notifications/${encodeURIComponent(NOTIFICATION_ID)}`;

  const notificationReadsBefore = notificationReadCount(service);
  const anonymous = await worker.fetch(
    new Request(`${APP_ORIGIN}${path}`, { headers: { accept: "application/json" } }),
    env,
    executionContext,
  );
  assert.equal(anonymous.status, 401);
  const foreign = await worker.fetch(
    identityRequest(path, "oidc:foreign", "foreign@example.test"),
    env,
    executionContext,
  );
  assert.equal(foreign.status, 404);
  const invalid = await worker.fetch(
    ownerRequest("/owner/manual-notifications/private-owner-subject/extra"),
    env,
    executionContext,
  );
  const invalidBody = await invalid.text();
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(invalidBody, /private-owner-subject/u);
  assert.equal(notificationReadCount(service), notificationReadsBefore);
  const missing = await worker.fetch(
    ownerRequest("/owner/manual-notifications/notification%3Amissing"),
    env,
    executionContext,
  );
  assert.equal(missing.status, 404);
  const oversizedPage = await worker.fetch(
    ownerRequest("/owner/manual-notifications?page_size=26"),
    env,
    executionContext,
  );
  assert.equal(oversizedPage.status, 400);

  const replacement = await worker.fetch(
    identityRequest(path, REPLACEMENT_OWNER_SUBJECT, OWNER_EMAIL),
    env,
    executionContext,
  );
  assert.equal(replacement.status, 200);
  assert.equal(replacement.headers.get(MUTATION_CSRF_HEADER), null);
  const replacementDocument = await replacement.json() as
    OwnerNotificationDetailDocument;
  assert.deepEqual(replacementDocument.actions, []);

  const ownerDetail = await worker.fetch(
    ownerRequest(path),
    env,
    executionContext,
  );
  const proof = mutationProof(ownerDetail);
  const ownerDocument = await ownerDetail.json() as
    OwnerNotificationDetailDocument;
  const copy = requiredAction(ownerDocument, "record-notification-template-copy");
  const body = actionBody(copy);
  rejectedOperations.add(String(body["operation-id"]));
  const rejected = await submitJson(worker, copy.href, body, proof, env);
  const rejectedBody = await rejected.text();
  assert.equal(rejected.status, 503);
  assert.doesNotMatch(
    rejectedBody,
    /service-secret|access-token|private application status/iu,
  );
  const unchanged = await notificationRepository(service).get(NOTIFICATION_ID);
  assert.equal(unchanged?.revision, 1);
  assert.equal(unchanged?.record.copyEvidence.length, 0);

  const privateCorruption = "PRIVATE CORRUPT NOTIFICATION VALUE";
  const currentKeyString = service.recordKeys().find((key) =>
    key.startsWith("manual-notifications/")
  );
  assert.ok(currentKeyString);
  const separator = currentKeyString.indexOf("/");
  const key = parseStorageKey(
    currentKeyString.slice(0, separator),
    currentKeyString.slice(separator + 1),
  );
  const operation = parseStorageOperationId(
    "notification-operation:corrupt-current",
  );
  assert.ok(key.ok);
  assert.ok(operation.ok);
  const adapter = storageAdapter(service);
  const stored = await adapter.read(key.value);
  assert.ok(stored);
  await adapter.transact({
    operationId: operation.value,
    mutations: [{
      type: "put",
      key: key.value,
      expectedRevision: stored.revision,
      value: {
        kind: "manual-notification-record",
        schemaVersion: 1,
        revision: 2,
        record: { private: privateCorruption },
      },
    }],
  });
  const corrupt = await worker.fetch(ownerRequest(path), env, executionContext);
  const corruptBody = await corrupt.text();
  assert.equal(corrupt.status, 503);
  assert.doesNotMatch(corruptBody, new RegExp(privateCorruption, "u"));
});

function hostedWorker(
  service: SyntheticAittaDBStorageService,
  now: Date,
  randomBytes: (length: number) => Uint8Array,
) {
  return createApplicationWorker({
    fetchApplication: async () => new Response("rendered"),
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: createHostedApplicationRuntimeResolver({
      fetch: service.fetch,
      now: () => new Date(now),
      randomBytes,
    }),
  });
}

function storageService(
  overrides: Partial<Pick<
    SyntheticAittaDBStorageServiceOptions,
    "rejectTransaction" | "failCommittedTransaction"
  >> = {},
): SyntheticAittaDBStorageService {
  return new SyntheticAittaDBStorageService({
    issuer: ISSUER,
    transportOrigin: TRANSPORT_ORIGIN,
    entryHref: ENTRY_HREF,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    accessToken: ACCESS_TOKEN,
    scopes: SCOPES,
    ...overrides,
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

function notificationRepository(
  service: SyntheticAittaDBStorageService,
): StorageManualNotificationRepository {
  return new StorageManualNotificationRepository(storageAdapter(service));
}

async function seedNotification(
  service: SyntheticAittaDBStorageService,
): Promise<void> {
  await notificationRepository(service).create({
    operationId: "notification-operation:hosted-seed",
    template: {
      id: NOTIFICATION_ID,
      purposeId: "moderation-status-update",
      recipientSubject: PARTICIPANT_SUBJECT,
      relatedResource: {
        type: "investment-indication",
        id: "indication:hosted-private",
      },
      subjectLine: PRIVATE_SUBJECT,
      body: PRIVATE_BODY,
      generatedAt: "2026-08-11T09:00:00.000Z",
      generatedBy: { type: "owner", subject: OWNER_SUBJECT },
    },
  });
}

function ownerRequest(path: string, accept = "application/json"): Request {
  return identityRequest(path, OWNER_SUBJECT, OWNER_EMAIL, accept);
}

function identityRequest(
  path: string,
  subject: string,
  email: string,
  accept = "application/json",
): Request {
  return new Request(new URL(path, APP_ORIGIN), {
    headers: {
      accept,
      "oai-authenticated-user-id": subject,
      "oai-authenticated-user-email": email,
    },
  });
}

async function submitJson(
  worker: ReturnType<typeof hostedWorker>,
  href: string,
  body: Readonly<Record<string, unknown>>,
  proof: Readonly<{ token: string; cookie: string }>,
  env: InvestorAppEnv,
): Promise<Response> {
  return submitRawJson(worker, href, JSON.stringify(body), proof, env);
}

async function submitRawJson(
  worker: ReturnType<typeof hostedWorker>,
  href: string,
  body: string,
  proof: Readonly<{ token: string; cookie: string }>,
  env: InvestorAppEnv,
): Promise<Response> {
  return worker.fetch(new Request(href, {
    method: "POST",
    headers: mutationHeaders(proof, "application/json"),
    body,
  }), env, executionContext);
}

async function submitForm(
  worker: ReturnType<typeof hostedWorker>,
  action: HypermediaAction,
  proof: Readonly<{ token: string; cookie: string }>,
  env: InvestorAppEnv,
): Promise<Response> {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(actionBody(action))) {
    body.set(name, String(value));
  }
  body.set(MUTATION_CSRF_FIELD, proof.token);
  const headers = mutationHeaders(proof, "application/x-www-form-urlencoded");
  headers.delete(MUTATION_CSRF_HEADER);
  return worker.fetch(new Request(action.href, {
    method: "POST",
    headers,
    body,
  }), env, executionContext);
}

function mutationHeaders(
  proof: Readonly<{ token: string; cookie: string }>,
  contentType: string,
): Headers {
  return new Headers({
    accept: "application/json",
    "content-type": contentType,
    cookie: proof.cookie,
    origin: APP_ORIGIN,
    [MUTATION_CSRF_HEADER]: proof.token,
    "oai-authenticated-user-id": OWNER_SUBJECT,
    "oai-authenticated-user-email": OWNER_EMAIL,
  });
}

function mutationProof(
  response: Response,
): Readonly<{ token: string; cookie: string }> {
  const token = response.headers.get(MUTATION_CSRF_HEADER);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(token);
  assert.ok(setCookie);
  const capabilityId = token.slice(0, 22);
  const pattern = new RegExp(
    `(__Host-investor_app_mutation_${capabilityId}=[^;,\\s]+)`,
    "u",
  );
  const cookie = pattern.exec(setCookie)?.[1];
  assert.ok(cookie);
  return Object.freeze({ token, cookie });
}

function requiredAction(
  document: Readonly<{ actions: readonly HypermediaAction[] }>,
  name: string,
): HypermediaAction {
  const action = document.actions.find((candidate) => candidate.name === name);
  assert.ok(action, `Missing action ${name}.`);
  return action;
}

function actionBody(action: HypermediaAction): Record<string, unknown> {
  return Object.fromEntries(action.fields.map((field) => {
    const value = field.value ?? field.default;
    assert.notEqual(value, undefined);
    return [field.name, value];
  }));
}

function actionNames(
  document: Readonly<{ actions: readonly HypermediaAction[] }>,
): string[] {
  return document.actions.map(({ name }) => name);
}

function requiredHref(
  link: Readonly<{ href: string }> | undefined,
): string {
  assert.ok(link);
  return link.href;
}

function notificationReadCount(
  service: SyntheticAittaDBStorageService,
): number {
  return service.readKeys.filter((key) =>
    key.startsWith("manual-notifications/") ||
    key.startsWith("manual-notification-history/")
  ).length;
}

function deterministicRandomBytes(
  seed: number,
): (length: number) => Uint8Array {
  let invocation = 0;
  return (length) => {
    const value = Uint8Array.from(
      { length },
      (_, index) => (seed + invocation * 31 + index) % 256,
    );
    invocation += 1;
    return value;
  };
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
