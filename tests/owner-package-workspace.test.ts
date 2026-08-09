import assert from "node:assert/strict";
import test from "node:test";

import {
  parseActorSubject,
  type ActorSubject,
} from "../domain/foundation.ts";
import { StorageFailure } from "../domain/storage-adapter.ts";
import { InMemoryPackageVersionRepository } from "../repositories/in-memory-content-repository.ts";
import {
  RepositoryOwnerPackageWorkspaceService,
  type TrustedOwnerActor,
} from "../services/owner-package-workspace.ts";
import { MemoryStorageAdapter } from "./support/memory-storage-adapter.ts";

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
