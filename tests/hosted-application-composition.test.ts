import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AITTADB_HYPERMEDIA_API_VERSION,
  AITTADB_HYPERMEDIA_MEDIA_TYPE,
  defineStorageProtocolDiscovery,
  storageProtocolErrorDocument,
  storageProtocolErrorStatus,
  type StorageProtocolErrorCode,
} from "../domain/aittadb-storage-protocol.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  MutationSecurityFailure,
} from "../http/mutation-security.ts";
import { OWNER_PACKAGE_WORKSPACE_HEADER } from "../http/runtime-capabilities.ts";
import type { OwnerPackageDocument } from "../domain/owner-package-resource.ts";
import { parseParticipantAccount } from "../domain/participant-profile.ts";
import {
  parseActorSubject,
} from "../domain/foundation.ts";
import {
  StorageFailure,
  parseStorageOperationId,
} from "../domain/storage-adapter.ts";
import { AittaDBStorageAdapter } from "../repositories/aittadb-storage-adapter.ts";
import { StoragePackageVersionRepository } from "../repositories/in-memory-content-repository.ts";
import { StorageParticipantRepository } from "../repositories/in-memory-participant-repository.ts";
import { createApplicationWorker } from "../worker/application-worker.ts";
import type {
  InvestorAppEnv,
  WorkerExecutionContext,
} from "../worker/contracts.ts";
import { createHostedApplicationRuntimeResolver } from "../worker/hosted-application-composition.ts";
import {
  MAX_OWNER_PACKAGE_MUTATION_BYTES,
  MAX_OWNER_PACKAGE_MUTATION_FIELDS,
} from "../worker/routes/owner-package.ts";

const APP_ORIGIN = "https://invest.example.test";
const ISSUER = "https://storage.example.test";
const TRANSPORT_ORIGIN = "https://storage-runtime.example.test";
const ENTRY_HREF = `${ISSUER}/bounded-storage`;
const TRANSACTION_HREF = `${ISSUER}/records/transactions`;
const SERVICE_CLIENT_ID = "investor-app-service";
const SERVICE_CLIENT_SECRET = "application-service-client-secret";
const ACCESS_TOKEN = "synthetic-access-token-that-must-stay-private";
const STORAGE_SCOPES = "storage.read storage.write storage.delete";
const NOW = new Date("2026-08-10T12:00:00.000Z");
const MUTATION_KEY = keyMaterial(17);
const OWNER = Object.freeze({
  type: "owner",
  subject: "sites-owner-subject",
} as const);
const OWNER_EMAIL = "owner@example.test";
const PARTICIPANT_SUBJECT = "sites-participant-subject";
const PARTICIPANT_EMAIL = "participant@example.test";
const PRIVATE_DRAFT_SENTINEL = "PRIVATE DRAFT SENTINEL MUST STAY HIDDEN";
const MAX_HOSTED_RECORD_BYTES = 65_536;
const MAX_HOSTED_TRANSACTION_MUTATIONS = 25;
const MAX_HOSTED_TRANSACTION_BYTES = 1_048_576;

const executionContext: WorkerExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

test("hosted runtime composes once and closes credentials behind repositories", async () => {
  const service = new SyntheticAittaDBService();
  let randomSeed = 0;
  const resolver = createHostedApplicationRuntimeResolver({
    fetch: service.fetch,
    now: () => NOW,
    randomBytes(length) {
      randomSeed += 1;
      return Uint8Array.from(
        { length },
        (_, index) => (randomSeed * 29 + index) % 256,
      );
    },
  });
  const env = configuredEnvironment();
  const [runtime, concurrent] = await Promise.all([
    resolver(env),
    resolver(env),
  ]);

  assert.ok(runtime);
  assert.equal(concurrent, runtime);
  assert.equal(Object.isFrozen(runtime), true);
  assert.deepEqual(Object.keys(runtime).sort(), [
    "mutationSession",
    "now",
    "publicationReady",
    "repositoryFactory",
  ]);
  assert.equal(runtime.publicationReady, false);
  const serialized = JSON.stringify(runtime);
  for (const secret of [
    SERVICE_CLIENT_SECRET,
    ACCESS_TOKEN,
    MUTATION_KEY,
    SERVICE_CLIENT_ID,
    ISSUER,
    TRANSPORT_ORIGIN,
  ]) {
    assert.equal(serialized.includes(secret), false);
  }

  await assert.rejects(
    runtime.mutationSession.issue(
      new Request("https://forged-request-host.example.test/owner/setup"),
      OWNER,
      "https://forged-request-host.example.test",
    ),
    (error) => error instanceof MutationSecurityFailure &&
      error.code === "REQUEST_REJECTED",
  );

  const proof = await runtime.mutationSession.issue(
    new Request(`${APP_ORIGIN}/owner/setup`),
    OWNER,
    APP_ORIGIN,
  );
  const verified = await runtime.mutationSession.verifyMutation(
    mutationRequest(proof),
    OWNER,
    APP_ORIGIN,
  );
  assert.equal(verified.actor.subject, OWNER.subject);
  assert.equal(verified.method, "POST");
  assert.match(verified.clearCookie, /Max-Age=0/u);

  await assert.rejects(
    runtime.mutationSession.verifyMutation(
      mutationRequest(proof),
      OWNER,
      APP_ORIGIN,
    ),
    (error) => error instanceof MutationSecurityFailure &&
      error.code === "REQUEST_REJECTED" &&
      error.cause === undefined,
  );

  assert.equal(service.tokenRequests, 1);
  assert.equal(service.discoveryRequests, 1);
  assert.equal(service.transactionRequests, 2);
  assert.equal(service.records.size, 1);
  const persisted = JSON.stringify([...service.records.values()]);
  assert.match(persisted, /"schemaVersion":1/u);
  assert.match(persisted, /"expiresAt":"2026-08-10T12:05:00.000Z"/u);
  assert.doesNotMatch(
    persisted,
    /sites-owner|csrf|cookie|credential|synthetic-access|invest\.example/iu,
  );
});

test("runtime resolution is fail-closed and never advertises feature routes", async () => {
  let providerCalls = 0;
  const resolver = createHostedApplicationRuntimeResolver({
    async fetch() {
      providerCalls += 1;
      throw new Error("Provider must remain unreachable.");
    },
  });
  const complete = configuredEnvironment();
  const partial = { ...complete };
  delete partial.AITTADB_STORAGE_CLIENT_SECRET;
  const variants: InvestorAppEnv[] = [
    baseEnvironment(),
    partial,
    configuredEnvironment({
      AITTADB_STORAGE_ENTRY_HREF: "https://foreign.example.test/storage",
    }),
  ];

  for (const env of variants) {
    const routed: boolean[] = [];
    const rendered: Request[] = [];
    const worker = createApplicationWorker({
      fetchApplication: async (request) => {
        rendered.push(request);
        return new Response("application");
      },
      fetchOptimizedImage: async () => new Response("image"),
      resolveApplicationRuntime: resolver,
      dispatchRoute: async (context) => {
        routed.push("applicationRuntime" in context);
        return null;
      },
    });
    const response = await worker.fetch(
      new Request("https://forged-request-host.example.test/owner", {
        headers: {
          "oai-authenticated-user-id": OWNER.subject,
          "oai-authenticated-user-email": "owner@example.test",
        },
      }),
      env,
      executionContext,
    );
    assert.equal(await response.text(), "application");
    assert.deepEqual(routed, [false]);
    assert.equal(rendered.length, 1);
    assert.deepEqual(
      [...rendered[0]!.headers].filter(([, value]) =>
        value === "available"
      ),
      [],
    );
  }
  assert.equal(providerCalls, 0);
});

test("complete runtime stays outside route and rendering capabilities", async () => {
  const resolver = createHostedApplicationRuntimeResolver({
    fetch: new SyntheticAittaDBService().fetch,
  });
  const env = configuredEnvironment();
  let routeHasRuntime = true;
  let renderedEnvironment: unknown;
  const rendered: Request[] = [];
  const worker = createApplicationWorker({
    fetchApplication: async (request, renderEnvironment) => {
      rendered.push(request);
      renderedEnvironment = renderEnvironment;
      return new Response("application");
    },
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: resolver,
    dispatchRoute: async (context) => {
      routeHasRuntime = "applicationRuntime" in context;
      return null;
    },
  });

  await worker.fetch(
    new Request("https://forged-request-host.example.test/"),
    env,
    executionContext,
  );
  const expected = await resolver(env);
  assert.ok(expected);
  assert.equal(routeHasRuntime, false);
  assert.equal(rendered.length, 1);
  assert.deepEqual(Object.keys(renderedEnvironment as object).sort(), [
    "ASSETS",
    "IMAGES",
  ]);
  const renderedHeaders = JSON.stringify([...rendered[0]!.headers]);
  assert.equal(
    [...rendered[0]!.headers].some(([, value]) => value === "available"),
    false,
  );
  for (const secret of [
    SERVICE_CLIENT_SECRET,
    ACCESS_TOKEN,
    MUTATION_KEY,
    SERVICE_CLIENT_ID,
    ISSUER,
    TRANSPORT_ORIGIN,
  ]) {
    assert.equal(renderedHeaders.includes(secret), false);
    assert.equal(JSON.stringify(renderedEnvironment).includes(secret), false);
  }
});

test("complete runtime centrally installs the owner setup route", async () => {
  const resolver = createHostedApplicationRuntimeResolver({
    fetch: new SyntheticAittaDBService().fetch,
  });
  const rendered: Request[] = [];
  const worker = createApplicationWorker({
    fetchApplication: async (request) => {
      rendered.push(request);
      return new Response("application fallback", { status: 418 });
    },
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: resolver,
  });

  const response = await worker.fetch(
    new Request(`${APP_ORIGIN}/owner/setup`, {
      headers: {
        "oai-authenticated-user-id": OWNER.subject,
        "oai-authenticated-user-email": "owner@example.test",
      },
    }),
    configuredEnvironment({ OWNER_EMAIL: "owner@example.test" }),
    executionContext,
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /campaign setup/iu);
  assert.equal(rendered.length, 0);
});

test("complete runtime advertises package capability on owner rendering", async () => {
  const resolver = createHostedApplicationRuntimeResolver({
    fetch: new SyntheticAittaDBService().fetch,
  });
  const rendered: Request[] = [];
  const worker = createApplicationWorker({
    fetchApplication: async (request) => {
      rendered.push(request);
      return new Response("application fallback", { status: 418 });
    },
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: resolver,
  });

  const response = await worker.fetch(
    new Request(`${APP_ORIGIN}/owner`, {
      headers: {
        "oai-authenticated-user-id": OWNER.subject,
        "oai-authenticated-user-email": "owner@example.test",
      },
    }),
    configuredEnvironment({ OWNER_EMAIL: "owner@example.test" }),
    executionContext,
  );
  assert.equal(response.status, 418);
  assert.equal(await response.text(), "application fallback");
  assert.equal(rendered.length, 1);
  assert.equal(
    rendered[0]!.headers.get(OWNER_PACKAGE_WORKSPACE_HEADER),
    "available",
  );
});

test("hosted participant access is subject-bound and excludes the configured owner", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  await registerHostedParticipant(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
    "Private participant profile",
    "participant-operation:subject-bound-participant",
  );
  await registerHostedParticipant(
    service,
    OWNER.subject,
    OWNER_EMAIL,
    "Private owner profile",
    "participant-operation:subject-bound-owner",
  );
  const worker = hostedPackageWorker(service);

  const owner = await worker.fetch(
    new Request(`${APP_ORIGIN}/participant`, {
      headers: {
        accept: "application/json",
        "oai-authenticated-user-id": OWNER.subject,
        "oai-authenticated-user-email": OWNER_EMAIL,
      },
    }),
    env,
    executionContext,
  );
  assert.equal(owner.status, 404);
  assert.doesNotMatch(await owner.text(), /Private owner profile/u);

  const foreign = await worker.fetch(
    new Request(`${APP_ORIGIN}/participant`, {
      headers: {
        accept: "application/json",
        "oai-authenticated-user-id": "sites-foreign-participant",
        "oai-authenticated-user-email": "foreign@example.test",
      },
    }),
    env,
    executionContext,
  );
  assert.equal(foreign.status, 404);
  assert.doesNotMatch(
    await foreign.text(),
    /Private participant profile|Private owner profile/u,
  );
});

test("hosted package routes persist atomic private versions and current acknowledgments", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  const firstWorker = hostedPackageWorker(service);

  const initial = await ownerWorkspace(firstWorker, env);
  assert.equal(initial.document.data.revision, 0);
  assert.equal((await submitOwnerSection(firstWorker, env, initial, {
    title: "Participant overview",
    markdown: "Visible package content for registered participants.",
    enabled: true,
    acknowledgmentText: "I understand this indication remains non-binding.",
    changeSummary: "Created participant overview",
    materialChange: true,
  })).status, 200);

  const afterFirst = await ownerWorkspace(firstWorker, env);
  assert.equal((await submitOwnerSection(firstWorker, env, afterFirst, {
    title: "Internal draft",
    markdown: PRIVATE_DRAFT_SENTINEL,
    enabled: false,
    changeSummary: "Saved a private draft",
    materialChange: false,
  })).status, 200);

  const firstVersion = recordsIn(service, "private-package-versions")[0];
  assert(firstVersion);
  const immutableFirstVersion = JSON.stringify(firstVersion);

  const publicReadsBefore = service.readRequests;
  const publicResponse = await firstWorker.fetch(
    new Request(`${APP_ORIGIN}/`, { headers: { accept: "application/json" } }),
    env,
    executionContext,
  );
  const publicBody = await publicResponse.text();
  assert.equal(service.readRequests, publicReadsBefore + 1);
  assert.doesNotMatch(
    publicBody,
    /Participant overview|Visible package content|PRIVATE DRAFT SENTINEL/u,
  );

  const gatedWorker = hostedPackageWorker(service);
  const gatedReadsBefore = service.readRequests;
  const gated = await gatedWorker.fetch(
    participantRequest("/participant/package"),
    env,
    executionContext,
  );
  assert.equal(gated.status, 404);
  assert.equal(service.readRequests, gatedReadsBefore + 2);
  assert.doesNotMatch(await gated.text(), /package content|PRIVATE DRAFT/u);

  const concurrencyWorker = hostedPackageWorker(service);
  const [leftWorkspace, rightWorkspace] = await Promise.all([
    ownerWorkspace(concurrencyWorker, env),
    ownerWorkspace(concurrencyWorker, env),
  ]);
  assert.equal(leftWorkspace.document.data.revision, 2);
  assert.equal(rightWorkspace.document.data.revision, 2);
  const concurrent = await Promise.all([
    submitOwnerSection(concurrencyWorker, env, leftWorkspace, {
      title: "Concurrent winner A",
      markdown: "First bounded concurrent draft.",
      enabled: true,
      changeSummary: "Concurrent package update A",
      materialChange: false,
    }),
    submitOwnerSection(concurrencyWorker, env, rightWorkspace, {
      title: "Concurrent winner B",
      markdown: "Second bounded concurrent draft.",
      enabled: true,
      changeSummary: "Concurrent package update B",
      materialChange: false,
    }),
  ]);
  assert.deepEqual(
    concurrent.map(({ status }) => status).sort((left, right) => left - right),
    [200, 412],
  );

  const reopenedOwner = hostedPackageWorker(service);
  const currentOwner = await ownerWorkspace(reopenedOwner, env);
  assert.equal(currentOwner.document.data.revision, 3);
  assert.equal(recordsIn(service, "private-package-versions").length, 3);
  assert.equal(recordsIn(service, "audit-events").length, 3);
  assert.equal(JSON.stringify(recordsIn(service, "private-package-versions")[0]),
    immutableFirstVersion);
  assert.doesNotMatch(
    JSON.stringify(recordsIn(service, "audit-events")),
    /Visible package content|PRIVATE DRAFT SENTINEL|Concurrent package update/u,
  );

  const participantRepository = hostedParticipantRepository(service);
  const registration = await participantRepository.register({
    operationId: "participant-operation:hosted-access-registration",
    expectedRevision: null,
    registeredAt: "2026-08-10T10:00:00.000Z",
    registration: {
      displayName: "Synthetic participant",
      country: "FI",
      declaredInterest: "investor",
      participationContext: "individual",
      processEmailNoticeAcknowledged: true,
      marketingConsent: false,
    },
  });
  assert.equal(registration.revision, 1);
  const participantWorker = hostedPackageWorker(service);
  const reader = await participantWorker.fetch(
    participantRequest("/participant/package"),
    env,
    executionContext,
  );
  assert.equal(reader.status, 200);
  const readerBody = await reader.text();
  assert.match(readerBody, /Participant overview|Visible package content/u);
  assert.doesNotMatch(readerBody, /PRIVATE DRAFT SENTINEL|Internal draft/u);

  const [firstAcknowledgment, secondAcknowledgment] = await Promise.all([
    participantAcknowledgment(participantWorker, env),
    participantAcknowledgment(participantWorker, env),
  ]);
  assert.equal(firstAcknowledgment.document.data.status, "acceptance_required");
  const replayClaimsBeforeAcknowledgment = recordsIn(
    service,
    "browser-mutation-replays",
  ).length;
  const acknowledgmentAction = requiredAction(
    firstAcknowledgment.document,
    "acknowledge-current-package",
  );
  const oversizedAcknowledgment = await submitAcknowledgment(
    participantWorker,
    env,
    firstAcknowledgment,
    {
      ...actionBody(acknowledgmentAction, {}),
      extra: "x".repeat(600),
    },
  );
  assert.equal(oversizedAcknowledgment.status, 413);
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    replayClaimsBeforeAcknowledgment,
  );
  const acknowledgmentResponses = await Promise.all([
    submitAcknowledgment(
      participantWorker,
      env,
      firstAcknowledgment,
    ),
    submitAcknowledgment(
      participantWorker,
      env,
      secondAcknowledgment,
    ),
  ]);
  const acknowledgmentFailureBodies = await Promise.all(
    acknowledgmentResponses.map((response) => response.clone().text()),
  );
  assert.deepEqual(
    acknowledgmentResponses
      .map(({ status }) => status)
      .sort((left, right) => left - right),
    [201, 409],
    JSON.stringify({
      bodies: acknowledgmentFailureBodies,
      replayClaimsBeforeAcknowledgment,
      replayClaimsAfterAcknowledgment: recordsIn(
        service,
        "browser-mutation-replays",
      ).length,
      acceptanceRecords: recordsIn(
        service,
        "private-package-acceptances",
      ).length,
    }),
  );
  assert.equal(recordsIn(service, "private-package-acceptances").length, 1);
  assert.equal(recordsIn(service, "private-package-acceptance-heads").length, 1);

  const restartedParticipant = hostedPackageWorker(service);
  const satisfied = await participantAcknowledgment(restartedParticipant, env);
  assert.equal(satisfied.document.data.status, "satisfied");
  assert.deepEqual(actionNames(satisfied.document), []);

  const editorialOwner = hostedPackageWorker(service);
  const editorialWorkspace = await ownerWorkspace(editorialOwner, env);
  const editorialResponse = await submitOwnerSection(
    editorialOwner,
    env,
    editorialWorkspace,
    {
      title: "Editorial note",
      markdown: "An editorial clarification.",
      enabled: true,
      changeSummary: "Clarified package wording",
      materialChange: false,
    },
  );
  assert.equal(editorialResponse.status, 200);
  const editorialState = await participantAcknowledgment(
    hostedPackageWorker(service),
    env,
  );
  assert.equal(editorialState.document.data.status, "satisfied");

  const materialOwner = hostedPackageWorker(service);
  const materialWorkspace = await ownerWorkspace(materialOwner, env);
  const materialResponse = await submitOwnerSection(
    materialOwner,
    env,
    materialWorkspace,
    {
      title: "Material update",
      markdown: "A material package change.",
      enabled: true,
      changeSummary: "Changed material package information",
      materialChange: true,
    },
  );
  assert.equal(materialResponse.status, 200);
  const renewed = await participantAcknowledgment(
    hostedPackageWorker(service),
    env,
  );
  assert.equal(renewed.document.data.status, "acceptance_required");
  assert.deepEqual(actionNames(renewed.document), [
    "acknowledge-current-package",
  ]);

  const disclosureProbe = JSON.stringify({
    publicBody,
    readerBody,
    satisfied: satisfied.document,
    renewed: renewed.document,
  });
  for (const secret of [
    SERVICE_CLIENT_SECRET,
    ACCESS_TOKEN,
    MUTATION_KEY,
    SERVICE_CLIENT_ID,
    TRANSPORT_ORIGIN,
  ]) {
    assert.equal(disclosureProbe.includes(secret), false);
  }
  assert.doesNotMatch(
    JSON.stringify(satisfied.document),
    /participant-subject|contentHash|requiredAcceptanceHash|storage-runtime/iu,
  );
});

test("hosted package staging respects advertised limits and resumes after final publication failure", async () => {
  const service = new SyntheticAittaDBService();
  const repository = hostedPackageRepository(service);
  const operationId = parseStorageOperationId(
    "operation:hosted-package-record-limits",
  );
  const ownerSubject = parseActorSubject(OWNER.subject);
  assert(operationId.ok);
  assert(ownerSubject.ok);
  const maximumUnicodeMarkdown = "\u0800".repeat(50_000);
  const draft = {
    id: "package:hosted-record-limits-v1",
    createdAt: "2026-08-10T11:00:00.000Z",
    changeSummary: "Stored a bounded maximum package",
    materialChange: true,
    acknowledgmentText: "I acknowledge this bounded package.",
    sections: Array.from({ length: 64 }, (_, index) => ({
      id: `section:hosted-limit-${index}`,
      order: index,
      title: `Bounded section ${index + 1}`,
      markdown: index < 2
        ? maximumUnicodeMarkdown
        : `# Bounded section ${index + 1}`,
      enabled: true,
    })),
  };
  const request = Object.freeze({
    operationId: operationId.value,
    expectedRevision: null,
    draft,
    ownerSubject: ownerSubject.value,
  });

  service.failNextTransactionContaining("private-package-versions");
  await assert.rejects(
    repository.appendWithAudit(request),
    (error) => error instanceof StorageFailure && error.code === "UNAVAILABLE",
  );
  assert.equal(recordsIn(service, "private-package-versions").length, 0);
  assert.equal(recordsIn(service, "private-package-version-heads").length, 0);
  assert.equal(
    recordsIn(service, "private-package-acceptance-bindings").length,
    0,
  );
  assert.equal(recordsIn(service, "audit-events").length, 0);
  assert.equal(
    recordsIn(service, "private-package-operation-intents").length,
    1,
  );
  assert.equal(recordsIn(service, "private-package-version-sections").length, 64);
  assert.ok(recordsIn(service, "private-package-section-chunks").length > 64);
  const stagedRecordCount = service.records.size;
  const changedDrafts = [
    { ...draft, changeSummary: "Changed metadata after failure" },
    { ...draft, materialChange: false },
    { ...draft, acknowledgmentText: "Changed unstaged acknowledgment." },
    {
      ...draft,
      sections: draft.sections.map((section, index) =>
        index === 0 ? { ...section, markdown: "Changed staged content" } : section
      ),
    },
  ];
  for (const changedDraft of changedDrafts) {
    await assert.rejects(
      repository.appendWithAudit({ ...request, draft: changedDraft }),
      (error) => error instanceof StorageFailure && error.code === "CONFLICT",
    );
    assert.equal(service.records.size, stagedRecordCount);
  }
  await assert.rejects(
    repository.appendWithAudit({ ...request, expectedRevision: 1 }),
    (error) => error instanceof StorageFailure && error.code === "CONFLICT",
  );
  assert.equal(service.records.size, stagedRecordCount);
  const otherOwner = parseActorSubject("sites-other-owner-subject");
  assert(otherOwner.ok);
  await assert.rejects(
    repository.appendWithAudit({
      ...request,
      ownerSubject: otherOwner.value,
    }),
    (error) => error instanceof StorageFailure && error.code === "CONFLICT",
  );
  assert.equal(service.records.size, stagedRecordCount);
  await assert.rejects(
    repository.append({
      operationId: request.operationId,
      expectedRevision: request.expectedRevision,
      draft: request.draft,
    }),
    (error) => error instanceof StorageFailure && error.code === "CONFLICT",
  );
  assert.equal(service.records.size, stagedRecordCount);
  await assert.rejects(
    repository.appendWithAudit({
      ...request,
      mutationFingerprint: `sha256:${"0".repeat(64)}`,
    }),
    (error) => error instanceof StorageFailure && error.code === "CONFLICT",
  );
  assert.equal(service.records.size, stagedRecordCount);

  const restarted = hostedPackageRepository(service);
  const stored = await restarted.appendWithAudit(request);
  assert.equal(stored.revision, 1);
  assert.equal(stored.replayed, false);
  assert.equal(stored.snapshot.sections.length, 64);
  assert.equal(stored.snapshot.sections[0]?.markdown, maximumUnicodeMarkdown);
  assert.equal(stored.snapshot.sections[1]?.markdown, maximumUnicodeMarkdown);
  const replay = await hostedPackageRepository(service).appendWithAudit(request);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.snapshot, stored.snapshot);

  const reopened = await hostedPackageRepository(service).current();
  assert.deepEqual(reopened, {
    revision: 1,
    snapshot: stored.snapshot,
  });
  assert.equal(recordsIn(service, "private-package-versions").length, 1);
  assert.equal(recordsIn(service, "private-package-version-heads").length, 1);
  assert.equal(
    recordsIn(service, "private-package-acceptance-bindings").length,
    1,
  );
  assert.equal(recordsIn(service, "audit-events").length, 1);
  const manifest = recordsIn(service, "private-package-versions")[0];
  assert(manifest);
  assert.equal("sections" in manifest.value, false);
  assert.equal(Array.isArray(manifest.value.sectionRecordIds), true);
  assert.equal(service.maximumRecordBytesSeen <= MAX_HOSTED_RECORD_BYTES, true);
  assert.equal(
    service.maximumTransactionMutationsSeen <=
      MAX_HOSTED_TRANSACTION_MUTATIONS,
    true,
  );
  assert.equal(
    service.maximumTransactionBytesSeen <= MAX_HOSTED_TRANSACTION_BYTES,
    true,
  );
});

test("package intent survives a mid-stage failure and rejects changed retry work", async () => {
  const service = new SyntheticAittaDBService();
  const repository = hostedPackageRepository(service);
  const parsedOperation = parseStorageOperationId(
    "operation:hosted-package-mid-stage-intent",
  );
  const parsedOwner = parseActorSubject(OWNER.subject);
  assert(parsedOperation.ok);
  assert(parsedOwner.ok);
  const request = Object.freeze({
    operationId: parsedOperation.value,
    expectedRevision: null,
    ownerSubject: parsedOwner.value,
    draft: {
      id: "package:hosted-mid-stage-intent",
      createdAt: "2026-08-10T11:30:00.000Z",
      changeSummary: "Started a bounded staged package",
      materialChange: true,
      acknowledgmentText: "I acknowledge this staged package.",
      sections: [{
        id: "section:hosted-mid-stage-intent",
        order: 0,
        title: "Large staged section",
        markdown: "\u0800".repeat(50_000),
        enabled: true,
      }],
    },
  });
  service.failTransactionContainingAfter("private-package-section-chunks", 1);
  await assert.rejects(
    repository.appendWithAudit(request),
    (error) => error instanceof StorageFailure && error.code === "UNAVAILABLE",
  );
  assert.equal(
    recordsIn(service, "private-package-operation-intents").length,
    1,
  );
  assert.equal(recordsIn(service, "private-package-section-chunks").length, 1);
  assert.equal(recordsIn(service, "private-package-version-sections").length, 0);
  assert.equal(recordsIn(service, "private-package-versions").length, 0);
  assert.equal(recordsIn(service, "private-package-version-heads").length, 0);
  const recordCount = service.records.size;
  await assert.rejects(
    repository.appendWithAudit({
      ...request,
      draft: {
        ...request.draft,
        sections: [{
          ...request.draft.sections[0],
          markdown: "Changed after a partial stage",
        }],
      },
    }),
    (error) => error instanceof StorageFailure && error.code === "CONFLICT",
  );
  assert.equal(service.records.size, recordCount);

  const completed = await hostedPackageRepository(service).appendWithAudit(
    request,
  );
  assert.equal(completed.replayed, false);
  assert.equal(completed.revision, 1);
  assert.equal(
    completed.snapshot.sections[0]?.markdown,
    request.draft.sections[0]?.markdown,
  );
  assert.deepEqual(
    await hostedPackageRepository(service).current(),
    { revision: 1, snapshot: completed.snapshot },
  );
});

test("owner package body and field bounds reject before consuming mutation proof", async () => {
  const service = new SyntheticAittaDBService();
  const env = configuredEnvironment({ OWNER_EMAIL });
  const worker = hostedPackageWorker(service);
  const workspace = await ownerWorkspace(worker, env);
  const action = requiredAction(workspace.document, "create-package-section");
  const validBody = actionBody(action, {
    title: "Maximum Unicode section",
    markdown: "\u0800".repeat(50_000),
    enabled: true,
    "acknowledgment-text": "I acknowledge this package.",
    "change-summary": "Added maximum Unicode package content",
    "material-change": true,
  });
  assert.equal(Object.keys(validBody).length <= MAX_OWNER_PACKAGE_MUTATION_FIELDS, true);
  assert.equal(
    new TextEncoder().encode(JSON.stringify(validBody)).byteLength <
      MAX_OWNER_PACKAGE_MUTATION_BYTES,
    true,
  );
  const maximumFormBody = new URLSearchParams({
    "operation-id": "o".repeat(128),
    "expected-revision": Number.MAX_SAFE_INTEGER.toString(),
    "change-summary": "\u0800".repeat(500),
    "material-change": "true",
    title: "\u0800".repeat(160),
    markdown: "\u0800".repeat(50_000),
    enabled: "true",
    "acknowledgment-text": "\u0800".repeat(4_000),
    [MUTATION_CSRF_FIELD]: "c".repeat(65),
  }).toString();
  assert.equal(
    new TextEncoder().encode(maximumFormBody).byteLength <=
      MAX_OWNER_PACKAGE_MUTATION_BYTES,
    true,
  );
  const claimsBefore = recordsIn(service, "browser-mutation-replays").length;
  const overLimit = await submitOwnerBody(
    worker,
    env,
    workspace,
    action,
    {
      ...validBody,
      markdown: "x".repeat(MAX_OWNER_PACKAGE_MUTATION_BYTES),
    },
  );
  assert.equal(overLimit.status, 413);
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    claimsBefore,
  );

  const accepted = await submitOwnerBody(
    worker,
    env,
    workspace,
    action,
    validBody,
  );
  assert.equal(accepted.status, 200);
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    claimsBefore + 1,
  );
  const current = await ownerWorkspace(hostedPackageWorker(service), env);
  assert.equal(
    current.document.data.sections[0]?.markdown,
    "\u0800".repeat(50_000),
  );

  const fieldWorkspace = await ownerWorkspace(hostedPackageWorker(service), env);
  const fieldAction = requiredAction(
    fieldWorkspace.document,
    "create-package-section",
  );
  const nextValidBody = actionBody(fieldAction, {
    title: "Bounded field proof",
    markdown: "A bounded follow-up section.",
    enabled: true,
    "change-summary": "Proved the field envelope",
    "material-change": false,
  });
  const claimsBeforeFieldLimit = recordsIn(
    service,
    "browser-mutation-replays",
  ).length;
  const excessFields = await submitOwnerBody(
    hostedPackageWorker(service),
    env,
    fieldWorkspace,
    fieldAction,
    { ...nextValidBody, extra1: "x", extra2: "x", extra3: "x" },
  );
  assert.equal(excessFields.status, 400);
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    claimsBeforeFieldLimit,
  );
  const acceptedAfterFieldLimit = await submitOwnerBody(
    hostedPackageWorker(service),
    env,
    fieldWorkspace,
    fieldAction,
    nextValidBody,
  );
  assert.equal(acceptedAfterFieldLimit.status, 200);
  assert.equal(
    recordsIn(service, "browser-mutation-replays").length,
    claimsBeforeFieldLimit + 1,
  );
});

test("the production entry point installs the fail-closed application resolver", () => {
  const entrypoint = readFileSync(
    new URL("../worker/index.ts", import.meta.url),
    "utf8",
  );
  const composition = readFileSync(
    new URL("../worker/hosted-application-composition.ts", import.meta.url),
    "utf8",
  );
  assert.match(entrypoint, /createHostedApplicationRuntimeResolver\(\)/u);
  assert.match(entrypoint, /resolveApplicationRuntime:/u);
  assert.doesNotMatch(`${entrypoint}\n${composition}`, /console\s*\./u);
  assert.doesNotMatch(
    `${entrypoint}\n${composition}`,
    /aittadb\.com|chatgpt\.site|jheusala@/iu,
  );
});

class SyntheticAittaDBService {
  readonly records = new Map<string, SyntheticRecord>();
  readonly operations = new Map<
    string,
    Readonly<{
      fingerprint: string;
      records: readonly (SyntheticRecord | null)[];
    }>
  >();
  tokenRequests = 0;
  discoveryRequests = 0;
  readRequests = 0;
  transactionRequests = 0;
  maximumRecordBytesSeen = 0;
  maximumTransactionMutationsSeen = 0;
  maximumTransactionBytesSeen = 0;
  #transactionFailure: Readonly<{
    collection: string;
    successfulMatchesRemaining: number;
  }> | null = null;

  failNextTransactionContaining(collection: string): void {
    this.failTransactionContainingAfter(collection, 0);
  }

  failTransactionContainingAfter(
    collection: string,
    successfulMatches: number,
  ): void {
    assert.ok(Number.isSafeInteger(successfulMatches));
    assert.ok(successfulMatches >= 0);
    this.#transactionFailure = Object.freeze({
      collection,
      successfulMatchesRemaining: successfulMatches,
    });
  }

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.url === `${TRANSPORT_ORIGIN}/oauth/token`) {
      this.tokenRequests += 1;
      assert.equal(request.method, "POST");
      assert.equal(
        request.headers.get("authorization"),
        `Basic ${btoa(`${SERVICE_CLIENT_ID}:${SERVICE_CLIENT_SECRET}`)}`,
      );
      assert.deepEqual(
        Object.fromEntries(new URLSearchParams(await request.text())),
        { grant_type: "client_credentials", scope: STORAGE_SCOPES },
      );
      return jsonResponse({
        access_token: ACCESS_TOKEN,
        token_type: "Bearer",
        expires_in: 3_600,
        scope: STORAGE_SCOPES,
      });
    }

    assert.equal(request.headers.get("authorization"), `Bearer ${ACCESS_TOKEN}`);
    assert.equal(request.headers.get("cookie"), null);
    if (request.url === `${TRANSPORT_ORIGIN}/bounded-storage`) {
      this.discoveryRequests += 1;
      return protocolResponse(defineStorageProtocolDiscovery({
        entryHref: ENTRY_HREF,
        readRecordHref: `${ISSUER}/records/{collection}/{id}`,
        listRecordsHref: `${ISSUER}/records`,
        transactRecordsHref: TRANSACTION_HREF,
        limits: {
          max_record_bytes: MAX_HOSTED_RECORD_BYTES,
          max_page_size: 100,
          max_transaction_mutations: MAX_HOSTED_TRANSACTION_MUTATIONS,
          max_transaction_bytes: MAX_HOSTED_TRANSACTION_BYTES,
          max_cursor_length: 2_048,
        },
      }));
    }
    const url = new URL(request.url);
    const read = /^\/records\/([^/]+)\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "GET" && read !== null) {
      this.readRequests += 1;
      const collection = decodeURIComponent(read[1] ?? "");
      const id = decodeURIComponent(read[2] ?? "");
      const record = this.records.get(`${collection}/${id}`);
      return record === undefined
        ? protocolFailure("not_found")
        : protocolResponse(recordDocument(record));
    }
    assert.equal(request.url, `${TRANSPORT_ORIGIN}/records/transactions`);
    assert.equal(request.method, "POST");
    this.transactionRequests += 1;
    const transactionBody = await request.text();
    const transactionBytes = new TextEncoder().encode(transactionBody).byteLength;
    this.maximumTransactionBytesSeen = Math.max(
      this.maximumTransactionBytesSeen,
      transactionBytes,
    );
    if (transactionBytes > MAX_HOSTED_TRANSACTION_BYTES) {
      return protocolFailure("invalid_request");
    }
    return this.transact(JSON.parse(transactionBody) as unknown);
  };

  private transact(value: unknown): Response {
    const transaction = requiredObject(requiredObject(value).transaction);
    const operationId = requiredString(transaction.operation_id);
    const mutations = transaction.mutations;
    if (!Array.isArray(mutations) || mutations.length < 1) {
      throw new Error("Unexpected synthetic transaction shape.");
    }
    this.maximumTransactionMutationsSeen = Math.max(
      this.maximumTransactionMutationsSeen,
      mutations.length,
    );
    if (mutations.length > MAX_HOSTED_TRANSACTION_MUTATIONS) {
      return protocolFailure("invalid_request");
    }
    const fingerprint = JSON.stringify(transaction);
    const prior = this.operations.get(operationId);
    if (prior !== undefined) {
      return prior.fingerprint === fingerprint
        ? protocolResponse(transactionDocument(
            operationId,
            prior.records,
            true,
          ))
        : protocolFailure("conflict");
    }

    const mutationCollections = mutations.map((candidate) =>
      requiredString(requiredObject(requiredObject(candidate).key).collection)
    );
    const failure = this.#transactionFailure;
    if (failure !== null && mutationCollections.includes(failure.collection)) {
      if (failure.successfulMatchesRemaining === 0) {
        this.#transactionFailure = null;
        return protocolFailure("unavailable");
      }
      this.#transactionFailure = Object.freeze({
        ...failure,
        successfulMatchesRemaining: failure.successfulMatchesRemaining - 1,
      });
    }

    const prepared: SyntheticPreparedPut[] = [];
    for (const candidate of mutations) {
      const mutation = requiredObject(candidate);
      const key = requiredObject(mutation.key);
      const collection = requiredString(key.collection);
      const id = requiredString(key.id);
      const storageKey = `${collection}/${id}`;
      const current = this.records.get(storageKey);
      const expectedRevision = mutation.expected_revision;
      if (expectedRevision === null) {
        if (current !== undefined) return protocolFailure("conflict");
      } else if (
        typeof expectedRevision !== "number" ||
        current === undefined ||
        current.revision !== expectedRevision
      ) {
        return protocolFailure("precondition_failed");
      }
      assert.equal(mutation.type, "put");
      const recordBytes = new TextEncoder().encode(
        JSON.stringify(requiredObject(mutation.value)),
      ).byteLength;
      this.maximumRecordBytesSeen = Math.max(
        this.maximumRecordBytesSeen,
        recordBytes,
      );
      if (recordBytes > MAX_HOSTED_RECORD_BYTES) {
        return protocolFailure("invalid_request");
      }
      prepared.push(Object.freeze({
        storageKey,
        collection,
        id,
        revision: (current?.revision ?? 0) + 1,
        value: structuredClone(requiredObject(mutation.value)),
      }));
    }

    const changed = prepared.map((candidate) => Object.freeze({
      key: Object.freeze({
        collection: candidate.collection,
        id: candidate.id,
      }),
      revision: candidate.revision,
      value: candidate.value,
    }));
    for (const [index, candidate] of prepared.entries()) {
      this.records.set(candidate.storageKey, changed[index]!);
    }
    this.operations.set(operationId, Object.freeze({
      fingerprint,
      records: Object.freeze([...changed]),
    }));
    return protocolResponse(transactionDocument(operationId, changed, false));
  }
}

type SyntheticRecord = Readonly<{
  key: Readonly<{ collection: string; id: string }>;
  revision: number;
  value: Record<string, unknown>;
}>;

type SyntheticPreparedPut = Readonly<{
  storageKey: string;
  collection: string;
  id: string;
  revision: number;
  value: Record<string, unknown>;
}>;

function recordDocument(record: SyntheticRecord) {
  return {
    api_version: AITTADB_HYPERMEDIA_API_VERSION,
    type: "bounded-storage-record",
    id: `${record.key.collection}/${record.key.id}`,
    data: record,
    links: [],
    actions: [],
  };
}

function transactionDocument(
  operationId: string,
  records: readonly (SyntheticRecord | null)[],
  replayed: boolean,
) {
  return {
    api_version: AITTADB_HYPERMEDIA_API_VERSION,
    type: "bounded-storage-transaction",
    id: operationId,
    data: {
      operation_id: operationId,
      replayed,
      records,
    },
    links: [],
    actions: [],
  };
}

function protocolFailure(code: StorageProtocolErrorCode): Response {
  return protocolResponse(
    storageProtocolErrorDocument(code),
    storageProtocolErrorStatus(code),
  );
}

function mutationRequest(proof: Readonly<{ token: string; setCookie: string }>) {
  return new Request(`${APP_ORIGIN}/owner/setup`, {
    method: "POST",
    headers: {
      cookie: proof.setCookie.split(";", 1)[0] ?? "",
      origin: APP_ORIGIN,
      "content-type": "application/json",
      [MUTATION_CSRF_HEADER]: proof.token,
    },
    body: JSON.stringify({ operation: "save" }),
  });
}

function hostedPackageWorker(service: SyntheticAittaDBService) {
  return createApplicationWorker({
    fetchApplication: async () =>
      new Response("application fallback", { status: 404 }),
    fetchOptimizedImage: async () => new Response("image"),
    resolveApplicationRuntime: createHostedApplicationRuntimeResolver({
      fetch: service.fetch,
      now: () => NOW,
    }),
  });
}

function hostedPackageRepository(
  service: SyntheticAittaDBService,
): StoragePackageVersionRepository {
  return new StoragePackageVersionRepository(hostedStorageAdapter(service));
}

function hostedParticipantRepository(
  service: SyntheticAittaDBService,
): StorageParticipantRepository {
  return hostedParticipantRepositoryFor(
    service,
    PARTICIPANT_SUBJECT,
    PARTICIPANT_EMAIL,
  );
}

function hostedParticipantRepositoryFor(
  service: SyntheticAittaDBService,
  subject: string,
  email: string,
): StorageParticipantRepository {
  const account = parseParticipantAccount({
    subject,
    accountEmailLabel: email,
  });
  assert(account.ok);
  return new StorageParticipantRepository(
    hostedStorageAdapter(service),
    account.value,
  );
}

async function registerHostedParticipant(
  service: SyntheticAittaDBService,
  subject: string,
  email: string,
  displayName: string,
  operationId: string,
): Promise<void> {
  const result = await hostedParticipantRepositoryFor(
    service,
    subject,
    email,
  ).register({
    operationId,
    expectedRevision: null,
    registeredAt: "2026-08-10T10:00:00.000Z",
    registration: {
      displayName,
      country: "FI",
      declaredInterest: "investor",
      participationContext: "individual",
      processEmailNoticeAcknowledged: true,
      marketingConsent: false,
    },
  });
  assert.equal(result.revision, 1);
}

function hostedStorageAdapter(
  service: SyntheticAittaDBService,
): AittaDBStorageAdapter {
  return new AittaDBStorageAdapter({
    issuer: ISSUER,
    transportOrigin: TRANSPORT_ORIGIN,
    entryHref: ENTRY_HREF,
    accessToken: () => ACCESS_TOKEN,
    fetch: service.fetch,
  });
}

type TestWorker = ReturnType<typeof hostedPackageWorker>;
type TestAction = Readonly<{
  name: string;
  href: string;
  method: string;
  fields: readonly Readonly<{
    name: string;
    value?: unknown;
    default?: unknown;
  }>[];
}>;

type OwnerWorkspaceResponse = Readonly<{
  document: OwnerPackageDocument;
  csrfToken: string;
  cookie: string;
}>;

async function ownerWorkspace(
  worker: TestWorker,
  env: InvestorAppEnv,
): Promise<OwnerWorkspaceResponse> {
  const response = await worker.fetch(
    ownerRequest("/owner/package"),
    env,
    executionContext,
  );
  assert.equal(response.status, 200);
  const csrfToken = response.headers.get(MUTATION_CSRF_HEADER);
  const setCookie = response.headers.get("set-cookie");
  assert(csrfToken);
  assert(setCookie);
  return Object.freeze({
    document: await response.json() as OwnerPackageDocument,
    csrfToken,
    cookie: cookieHeader(setCookie),
  });
}

async function submitOwnerSection(
  worker: TestWorker,
  env: InvestorAppEnv,
  workspace: OwnerWorkspaceResponse,
  values: Readonly<{
    title: string;
    markdown: string;
    enabled: boolean;
    acknowledgmentText?: string;
    changeSummary: string;
    materialChange: boolean;
  }>,
): Promise<Response> {
  const action = requiredAction(
    workspace.document,
    "create-package-section",
  );
  const body = actionBody(action, {
    title: values.title,
    markdown: values.markdown,
    enabled: values.enabled,
    ...(values.acknowledgmentText === undefined
      ? {}
      : { "acknowledgment-text": values.acknowledgmentText }),
    "change-summary": values.changeSummary,
    "material-change": values.materialChange,
  });
  return worker.fetch(
    new Request(action.href, {
      method: action.method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie: workspace.cookie,
        origin: APP_ORIGIN,
        [MUTATION_CSRF_HEADER]: workspace.csrfToken,
        "oai-authenticated-user-id": OWNER.subject,
        "oai-authenticated-user-email": OWNER_EMAIL,
      },
      body: JSON.stringify(body),
    }),
    env,
    executionContext,
  );
}

async function submitOwnerBody(
  worker: TestWorker,
  env: InvestorAppEnv,
  workspace: OwnerWorkspaceResponse,
  action: TestAction,
  body: Readonly<Record<string, unknown>>,
): Promise<Response> {
  return worker.fetch(
    new Request(action.href, {
      method: action.method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie: workspace.cookie,
        origin: APP_ORIGIN,
        [MUTATION_CSRF_HEADER]: workspace.csrfToken,
        "oai-authenticated-user-id": OWNER.subject,
        "oai-authenticated-user-email": OWNER_EMAIL,
      },
      body: JSON.stringify(body),
    }),
    env,
    executionContext,
  );
}

type TestAcknowledgmentDocument = Readonly<{
  data: Readonly<{ status: "acceptance_required" | "satisfied" }>;
  actions: readonly TestAction[];
}>;

type ParticipantAcknowledgmentResponse = Readonly<{
  document: TestAcknowledgmentDocument;
  csrfToken: string | null;
  cookie: string | null;
}>;

async function participantAcknowledgment(
  worker: TestWorker,
  env: InvestorAppEnv,
): Promise<ParticipantAcknowledgmentResponse> {
  const response = await worker.fetch(
    participantRequest("/participant/package/acknowledgment"),
    env,
    executionContext,
  );
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  return Object.freeze({
    document: await response.json() as TestAcknowledgmentDocument,
    csrfToken: response.headers.get(MUTATION_CSRF_HEADER),
    cookie: setCookie === null ? null : cookieHeader(setCookie),
  });
}

async function submitAcknowledgment(
  worker: TestWorker,
  env: InvestorAppEnv,
  resource: ParticipantAcknowledgmentResponse,
  bodyOverride?: Readonly<Record<string, unknown>>,
): Promise<Response> {
  const action = requiredAction(
    resource.document,
    "acknowledge-current-package",
  );
  assert(resource.csrfToken);
  assert(resource.cookie);
  return worker.fetch(
    new Request(action.href, {
      method: action.method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie: resource.cookie,
        origin: APP_ORIGIN,
        [MUTATION_CSRF_HEADER]: resource.csrfToken,
        "oai-authenticated-user-id": PARTICIPANT_SUBJECT,
        "oai-authenticated-user-email": PARTICIPANT_EMAIL,
      },
      body: JSON.stringify(bodyOverride ?? actionBody(action, {})),
    }),
    env,
    executionContext,
  );
}

function requiredAction(
  document: Readonly<{ actions: readonly TestAction[] }>,
  name: string,
): TestAction {
  const action = document.actions.find((candidate) => candidate.name === name);
  assert(action, `Missing action ${name}.`);
  return action;
}

function actionBody(
  action: TestAction,
  overrides: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of action.fields) {
    const value = Object.hasOwn(overrides, field.name)
      ? overrides[field.name]
      : field.value ?? field.default;
    if (value !== undefined) body[field.name] = value;
  }
  return body;
}

function actionNames(
  document: Readonly<{ actions: readonly TestAction[] }>,
): string[] {
  return document.actions.map(({ name }) => name);
}

function ownerRequest(pathname: string): Request {
  return new Request(`${APP_ORIGIN}${pathname}`, {
    headers: {
      accept: "application/json",
      "oai-authenticated-user-id": OWNER.subject,
      "oai-authenticated-user-email": OWNER_EMAIL,
    },
  });
}

function participantRequest(pathname: string): Request {
  return new Request(`${APP_ORIGIN}${pathname}`, {
    headers: {
      accept: "application/json",
      "oai-authenticated-user-id": PARTICIPANT_SUBJECT,
      "oai-authenticated-user-email": PARTICIPANT_EMAIL,
    },
  });
}

function cookieHeader(setCookie: string): string {
  const value = setCookie.split(";", 1)[0];
  assert(value);
  return value;
}

function recordsIn(
  service: SyntheticAittaDBService,
  collection: string,
): SyntheticRecord[] {
  return [...service.records.values()].filter(
    (record) => record.key.collection === collection,
  );
}

function configuredEnvironment(
  overrides: Partial<InvestorAppEnv> = {},
): InvestorAppEnv {
  return baseEnvironment({
    APP_BASE_URL: APP_ORIGIN,
    AITTADB_STORAGE_ISSUER: ISSUER,
    AITTADB_STORAGE_TRANSPORT_ORIGIN: TRANSPORT_ORIGIN,
    AITTADB_STORAGE_ENTRY_HREF: ENTRY_HREF,
    AITTADB_STORAGE_CLIENT_ID: SERVICE_CLIENT_ID,
    AITTADB_STORAGE_CLIENT_SECRET: SERVICE_CLIENT_SECRET,
    AITTADB_STORAGE_SCOPES: STORAGE_SCOPES,
    BROWSER_MUTATION_SESSION_KEY: MUTATION_KEY,
    ...overrides,
  });
}

function baseEnvironment(
  overrides: Partial<InvestorAppEnv> = {},
): InvestorAppEnv {
  return {
    ASSETS: { fetch: async () => new Response("asset") },
    IMAGES: {
      input: () => ({
        transform: () => ({
          output: async () => ({ response: new Response("image") }),
        }),
      }),
    },
    ...overrides,
  } as InvestorAppEnv;
}

function protocolResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": AITTADB_HYPERMEDIA_MEDIA_TYPE },
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function requiredObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected synthetic object.");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected synthetic string.");
  return value;
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
