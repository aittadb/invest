import assert from "node:assert/strict";
import test from "node:test";

import {
  parseActorSubject,
  type ActorSubject,
} from "../domain/foundation.ts";
import {
  StorageFailure,
  type StorageAdapter,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import {
  type AppendPackageVersionRequest,
  type AppendPackageVersionWithAuditRequest,
  type AtomicPackageVersionAuditRepository,
  InMemoryPackageVersionRepository,
  StoragePackageVersionRepository,
} from "../repositories/in-memory-content-repository.ts";
import {
  RepositoryOwnerPackageWorkspaceService,
  type TrustedOwnerActor,
} from "../services/owner-package-workspace.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";

test("the owner workspace lists, creates, reorders, enables, previews, and versions sections", async () => {
  const fixture = workspaceFixture();
  const first = await fixture.workspace.createSection(
    fixture.owner,
    createInput("package-operation:create-overview", 0, {
      title: "Overview",
      markdown: "# Overview\n\nRead the [details](https://example.test/details).",
      enabled: true,
      acknowledgmentText: "I acknowledge this private information package.",
      changeSummary: "Created the overview",
    }),
  );
  const initialVersionId = first.snapshot.id;
  const initialContentHash = first.snapshot.contentHash;
  assert.equal(first.revision, 1);
  assert.equal(first.snapshot.materialChange, false);
  assert.equal(first.snapshot.sections[0]?.order, 0);

  const second = await fixture.workspace.createSection(
    fixture.owner,
    createInput("package-operation:create-terms", 1, {
      title: "Terms",
      markdown: "## Terms\n\nDraft terms.",
      enabled: false,
      changeSummary: "Added a draft terms section",
    }),
  );
  const termsId = second.snapshot.sections[1]?.id;
  assert.ok(termsId);
  assert.equal(second.revision, 2);
  assert.equal(second.snapshot.requiredAcceptanceHash, initialContentHash);
  assert.deepEqual(
    second.snapshot.sections.map((section) => [section.title, section.enabled]),
    [["Overview", true], ["Terms", false]],
  );
  assert.deepEqual(
    (await fixture.workspace.preview(fixture.owner))?.sections.map(
      (section) => section.title,
    ),
    ["Overview"],
  );

  const reordered = await fixture.workspace.moveSection(fixture.owner, {
    ...metadata("package-operation:move-terms", 2, "Moved terms first"),
    sectionId: termsId,
    direction: "up",
  });
  assert.equal(reordered.revision, 3);
  assert.deepEqual(
    reordered.snapshot.sections.map((section) => [section.title, section.order]),
    [["Terms", 0], ["Overview", 1]],
  );

  const enabled = await fixture.workspace.setSectionEnabled(fixture.owner, {
    ...metadata("package-operation:enable-terms", 3, "Enabled terms"),
    sectionId: termsId,
    enabled: true,
  });
  assert.equal(enabled.revision, 4);
  assert.equal(enabled.snapshot.sections[0]?.enabled, true);

  const material = await fixture.workspace.updateSection(fixture.owner, {
    ...metadata(
      "package-operation:update-terms",
      4,
      "Changed the terms materially",
      true,
    ),
    sectionId: termsId,
    title: "Terms",
    markdown: "## Terms\n\nMaterially revised terms.",
  });
  assert.equal(material.revision, 5);
  assert.equal(material.snapshot.materialChange, true);
  assert.equal(material.snapshot.changeSummary, "Changed the terms materially");
  assert.equal(
    material.snapshot.requiredAcceptanceHash,
    material.snapshot.contentHash,
  );

  const settings = await fixture.workspace.updateSettings(fixture.owner, {
    ...metadata(
      "package-operation:update-acknowledgment",
      5,
      "Clarified acknowledgment wording",
    ),
    acknowledgmentText: "I acknowledge the current private package.",
  });
  assert.equal(settings.revision, 6);
  assert.equal(settings.snapshot.materialChange, false);
  assert.equal(
    settings.snapshot.requiredAcceptanceHash,
    material.snapshot.requiredAcceptanceHash,
  );

  const state = await fixture.workspace.read(fixture.owner);
  assert.equal(state?.revision, 6);
  assert.deepEqual(
    state?.version.sections.map((section) => section.title),
    ["Terms", "Overview"],
  );
  assert.deepEqual(
    (await fixture.workspace.preview(fixture.owner))?.sections.map(
      (section) => section.title,
    ),
    ["Terms", "Overview"],
  );

  const historical = await fixture.repository.get(initialVersionId);
  assert.equal(historical?.changeSummary, "Created the overview");
  assert.equal(historical?.sections.length, 1);
  assert.equal(historical?.sections[0]?.title, "Overview");
  assert.equal(Object.isFrozen(historical), true);
  assert.equal(Object.isFrozen(historical?.sections), true);
  assert.notEqual(settings.snapshot.id, material.snapshot.id);
});

test("package workspace retries are stable and stale or changed writes do not advance state", async () => {
  const fixture = workspaceFixture();
  const firstRequest = createInput("package-operation:retry", 0, {
    title: "Overview",
    markdown: "Safe package copy.",
    enabled: true,
    acknowledgmentText: "I acknowledge this package.",
    changeSummary: "Initial version",
  });
  const first = await fixture.workspace.createSection(fixture.owner, firstRequest);
  const immediateReplay = await fixture.workspace.createSection(
    fixture.owner,
    firstRequest,
  );
  assert.equal(immediateReplay.replayed, true);
  assert.deepEqual(immediateReplay.snapshot, first.snapshot);

  await fixture.workspace.createSection(
    fixture.owner,
    createInput("package-operation:second", 1, {
      title: "Details",
      markdown: "More safe copy.",
      enabled: true,
      changeSummary: "Added details",
    }),
  );
  const delayedReplay = await fixture.workspace.createSection(
    fixture.owner,
    firstRequest,
  );
  assert.equal(delayedReplay.replayed, true);
  assert.equal(delayedReplay.revision, 1);
  assert.equal((await fixture.workspace.read(fixture.owner))?.revision, 2);

  await rejectsStorage(
    () => fixture.workspace.createSection(fixture.owner, {
      ...firstRequest,
      title: "Changed retry",
    }),
    "CONFLICT",
  );
  await rejectsStorage(
    () => fixture.workspace.createSection(
      fixture.owner,
      createInput("package-operation:stale", 1, {
        title: "Stale",
        markdown: "Stale copy.",
        enabled: true,
        changeSummary: "Stale write",
      }),
    ),
    "PRECONDITION_FAILED",
  );
  assert.equal((await fixture.workspace.read(fixture.owner))?.revision, 2);
});

test("owner workspace retry reuses the persisted intent timestamp after restart", async () => {
  const state = new MemoryStorageState();
  const durable = new MemoryStorageAdapter(state);
  const failing = new FailAfterIntentCommitStorageAdapter(durable);
  const owner = Object.freeze({
    type: "owner" as const,
    subject: actorSubject("oidc:configured-owner"),
  });
  const timestamps = [
    "2026-08-09T12:00:00.000Z",
    "2026-08-09T12:05:00.000Z",
    "2026-08-09T12:10:00.000Z",
    "2026-08-09T12:15:00.000Z",
  ] as const;
  let clockCalls = 0;
  const now = () => {
    const timestamp = timestamps[Math.min(clockCalls, timestamps.length - 1)];
    clockCalls += 1;
    return new Date(timestamp);
  };
  const request = createInput("package-operation:intent-clock-retry", 0, {
    title: "Restart-safe overview",
    markdown: "Private package content persisted in bounded records.",
    enabled: true,
    acknowledgmentText: "I acknowledge this private package.",
    changeSummary: "Created restart-safe package content",
  });

  const firstWorkspace = new RepositoryOwnerPackageWorkspaceService(
    new StoragePackageVersionRepository(failing),
    { now },
  );
  await rejectsStorage(
    () => firstWorkspace.createSection(owner, request),
    "UNAVAILABLE",
  );
  assert.equal(clockCalls, 1);
  assert.equal(state.records.size, 1);
  const intent = requiredStoredRecord(
    state,
    "private-package-operation-intents",
  );
  assert.equal(intent.value.createdAt, timestamps[0]);
  assert.equal(storedRecords(state, "private-package-versions").length, 0);
  assert.equal(storedRecords(state, "audit-events").length, 0);

  const restartedRepository = new StoragePackageVersionRepository(
    new MemoryStorageAdapter(state),
  );
  const intentRecordCount = state.records.size;
  const extraDraftWorkspace = new RepositoryOwnerPackageWorkspaceService(
    new DecoratingOwnerPackageRepository(restartedRepository, (draft) => ({
      ...(draft as Record<string, unknown>),
      unexpected: "must remain rejected",
    })),
    { now },
  );
  await rejectsStorage(
    () => extraDraftWorkspace.createSection(owner, request),
    "INVALID_REQUEST",
  );
  assert.equal(clockCalls, 2);
  assert.equal(state.records.size, intentRecordCount);

  let accessorReads = 0;
  const accessorDraftWorkspace = new RepositoryOwnerPackageWorkspaceService(
    new DecoratingOwnerPackageRepository(restartedRepository, (draft) => {
      const decorated = { ...(draft as Record<string, unknown>) };
      Object.defineProperty(decorated, "changeSummary", {
        enumerable: true,
        get: () => {
          accessorReads += 1;
          return request.changeSummary;
        },
      });
      return decorated;
    }),
    { now },
  );
  await rejectsStorage(
    () => accessorDraftWorkspace.createSection(owner, request),
    "INVALID_REQUEST",
  );
  assert.equal(accessorReads, 0);
  assert.equal(clockCalls, 3);
  assert.equal(state.records.size, intentRecordCount);

  const restartedWorkspace = new RepositoryOwnerPackageWorkspaceService(
    restartedRepository,
    { now },
  );
  const completed = await restartedWorkspace.createSection(owner, request);
  assert.equal(clockCalls, 4);
  assert.equal(completed.replayed, false);
  assert.equal(completed.snapshot.createdAt, timestamps[0]);
  assert.equal(
    (await restartedWorkspace.read(owner))?.version.createdAt,
    timestamps[0],
  );
  assert.equal(
    requiredStoredRecord(state, "private-package-versions").value.createdAt,
    timestamps[0],
  );
  const auditEvent = requiredStoredRecord(state, "audit-events").value.event;
  assert.equal(typeof auditEvent, "object");
  assert(auditEvent !== null && !Array.isArray(auditEvent));
  assert.equal(
    (auditEvent as Record<string, unknown>).occurredAt,
    timestamps[0],
  );

  const completedRecords = serializeStoredRecords(state);
  const replayWorkspace = new RepositoryOwnerPackageWorkspaceService(
    new StoragePackageVersionRepository(new MemoryStorageAdapter(state)),
    { now },
  );
  const replay = await replayWorkspace.createSection(owner, request);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.snapshot, completed.snapshot);
  assert.equal(clockCalls, 4);
  assert.equal(serializeStoredRecords(state), completedRecords);

  const recordCount = state.records.size;
  await rejectsStorage(
    () => replayWorkspace.createSection(owner, {
      ...request,
      changeSummary: "Changed owner-controlled retry metadata",
    }),
    "CONFLICT",
  );
  await rejectsStorage(
    () => replayWorkspace.createSection(owner, {
      ...request,
      markdown: "Changed owner-controlled retry content.",
    }),
    "CONFLICT",
  );
  assert.equal(state.records.size, recordCount);
});

test("unsafe Markdown and untrusted actors are rejected without creating a package", async () => {
  const fixture = workspaceFixture();
  const unsafe = createInput("package-operation:unsafe", 0, {
    title: "Unsafe",
    markdown: "<script>privateValue()</script>",
    enabled: true,
    acknowledgmentText: "I acknowledge this package.",
    changeSummary: "Unsafe version",
  });
  await rejectsStorage(
    () => fixture.workspace.createSection(fixture.owner, unsafe),
    "INVALID_REQUEST",
  );
  assert.equal(await fixture.workspace.read(fixture.owner), null);

  const participant = {
    type: "participant",
    subject: actorSubject("oidc:participant"),
  } as unknown as TrustedOwnerActor;
  await rejectsStorage(
    () => fixture.workspace.read(participant),
    "NOT_FOUND",
  );
});

function workspaceFixture() {
  const repository = new InMemoryPackageVersionRepository(
    new MemoryStorageAdapter(),
  );
  let minute = 0;
  const workspace = new RepositoryOwnerPackageWorkspaceService(repository, {
    now: () => new Date(`2026-08-09T10:${String(minute++).padStart(2, "0")}:00.000Z`),
  });
  return {
    owner: Object.freeze({
      type: "owner" as const,
      subject: actorSubject("oidc:configured-owner"),
    }),
    repository,
    workspace,
  };
}

function createInput(
  operationId: string,
  expectedRevision: number,
  values: Readonly<{
    title: string;
    markdown: string;
    enabled: boolean;
    acknowledgmentText?: string;
    changeSummary: string;
  }>,
) {
  return {
    ...metadata(operationId, expectedRevision, values.changeSummary),
    title: values.title,
    markdown: values.markdown,
    enabled: values.enabled,
    ...(values.acknowledgmentText === undefined
      ? {}
      : { acknowledgmentText: values.acknowledgmentText }),
  };
}

function metadata(
  operationId: string,
  expectedRevision: number,
  changeSummary: string,
  materialChange = false,
) {
  return { operationId, expectedRevision, changeSummary, materialChange };
}

function actorSubject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  assert(parsed.ok);
  return parsed.value;
}

async function rejectsStorage(
  operation: () => Promise<unknown>,
  code: StorageFailure["code"],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof StorageFailure);
    assert.equal(error.code, code);
    return;
  }
  assert.fail("Expected a StorageFailure.");
}

class FailAfterIntentCommitStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  #failed = false;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  read(key: Parameters<StorageAdapter["read"]>[0]) {
    return this.#delegate.read(key);
  }

  list(request: Parameters<StorageAdapter["list"]>[0]) {
    return this.#delegate.list(request);
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    const result = await this.#delegate.transact(request);
    if (
      !this.#failed &&
      request.mutations.some((mutation) =>
        mutation.key.collection === "private-package-operation-intents"
      )
    ) {
      this.#failed = true;
      throw new StorageFailure("UNAVAILABLE");
    }
    return result;
  }
}

class DecoratingOwnerPackageRepository
  implements AtomicPackageVersionAuditRepository
{
  readonly mutationConsistency = "atomic-package-version-audit" as const;
  readonly #delegate: AtomicPackageVersionAuditRepository;
  readonly #decorate: (draft: unknown) => unknown;

  constructor(
    delegate: AtomicPackageVersionAuditRepository,
    decorate: (draft: unknown) => unknown,
  ) {
    this.#delegate = delegate;
    this.#decorate = decorate;
  }

  append(request: AppendPackageVersionRequest) {
    return this.#delegate.append({
      ...request,
      draft: this.#decorate(request.draft),
    });
  }

  appendWithAudit(request: AppendPackageVersionWithAuditRequest) {
    return this.#delegate.appendWithAudit({
      ...request,
      draft: this.#decorate(request.draft),
    });
  }

  current() {
    return this.#delegate.current();
  }

  get(id: Parameters<AtomicPackageVersionAuditRepository["get"]>[0]) {
    return this.#delegate.get(id);
  }
}

function storedRecords(state: MemoryStorageState, collection: string) {
  return [...state.records.values()].filter(
    (record) => record.key.collection === collection,
  );
}

function requiredStoredRecord(
  state: MemoryStorageState,
  collection: string,
) {
  const records = storedRecords(state, collection);
  assert.equal(records.length, 1);
  const record = records[0];
  assert(record);
  return record;
}

function serializeStoredRecords(state: MemoryStorageState): string {
  return JSON.stringify(
    [...state.records.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    ),
  );
}
