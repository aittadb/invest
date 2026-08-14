import assert from "node:assert/strict";
import test from "node:test";

import {
  createPackageVersion,
  type PackageVersion,
} from "../domain/package-content.ts";
import {
  createParticipantPackagePage,
} from "../domain/participant-package-resource.ts";

const REQUEST_URL = "https://campaign.example/participant/package";

test("registered package pages expose only enabled non-empty safe sections", async () => {
  const version = await packageVersion([
    section("package-section:overview", 0, "Overview", "# Product\nPublic-safe private package copy."),
    section("package-section:hidden", 1, "Hidden", "PRIVATE DISABLED DRAFT", false),
    section("package-section:empty", 2, "Empty", ""),
    section("package-section:terms", 3, "Terms", "No commitment is created."),
    section("package-section:risks", 4, "Risks", "Review the stated risks."),
  ]);

  const first = createParticipantPackagePage({
    requestUrl: REQUEST_URL,
    version,
    acceptanceRequired: true,
    limit: 2,
    after: null,
  });
  assert(first);
  assert.deepEqual(
    first.document.data.sections.map(({ id, title }) => ({ id, title })),
    [
      { id: "package-section:overview", title: "Overview" },
      { id: "package-section:terms", title: "Terms" },
    ],
  );
  assert.equal(first.nextAfter, "package-section:terms");
  assert.deepEqual(first.document.data, {
    created_at: "2026-08-09T10:00:00.000Z",
    change_summary: "Initial synthetic package",
    material_change: true,
    acknowledgment_text: "I understand this expression of interest is non-binding.",
    acceptance_required: true,
    sections: [
      {
        id: "package-section:overview",
        title: "Overview",
        markdown: "# Product\nPublic-safe private package copy.",
      },
      {
        id: "package-section:terms",
        title: "Terms",
        markdown: "No commitment is created.",
      },
    ],
  });
  assert.equal(first.document.links.some((link) => link.rel.includes("next")), true);
  assert.equal(first.document.actions[0]?.name, "read-next-package-page");
  assert.equal(Object.isFrozen(first.document.data.sections), true);

  const serialized = JSON.stringify(first.document);
  for (const excluded of [
    "PRIVATE DISABLED DRAFT",
    "contentHash",
    "requiredAcceptanceHash",
    '"enabled"',
    '"order"',
  ]) {
    assert.equal(serialized.includes(excluded), false, excluded);
  }

  const second = createParticipantPackagePage({
    requestUrl: REQUEST_URL,
    version,
    acceptanceRequired: true,
    limit: 2,
    after: first.nextAfter,
  });
  assert(second);
  assert.deepEqual(
    second.document.data.sections.map(({ id }) => id),
    ["package-section:risks"],
  );
  assert.equal(second.nextAfter, null);
  assert.equal(second.document.links.some((link) => link.rel.includes("next")), false);
});

test("package pages reject malformed cursors, limits, metadata, and unsafe snapshots", async () => {
  const version = await packageVersion([
    section("package-section:one", 0, "One", "Safe copy."),
    section("package-section:two", 1, "Two", "More safe copy."),
  ]);
  const base = {
    requestUrl: REQUEST_URL,
    version,
    acceptanceRequired: false,
    limit: 1,
    after: null,
  };

  assert.equal(createParticipantPackagePage({ ...base, limit: 0 }), null);
  assert.equal(createParticipantPackagePage({ ...base, limit: 17 }), null);
  assert.equal(createParticipantPackagePage({ ...base, after: "not present" }), null);
  assert.equal(
    createParticipantPackagePage({
      ...base,
      after: "package-section:two",
    }),
    null,
  );
  assert.equal(
    createParticipantPackagePage({
      ...base,
      version: {
        ...version,
        sections: [{
          ...version.sections[0],
          markdown: "<script>private()</script>",
        }],
      } as unknown as PackageVersion,
    }),
    null,
  );
  assert.equal(
    createParticipantPackagePage({
      ...base,
      version: {
        ...version,
        sections: [version.sections[0], version.sections[0]],
      } as unknown as PackageVersion,
    }),
    null,
  );
  assert.equal(
    createParticipantPackagePage({
      ...base,
      version: {
        ...version,
        sections: version.sections.map((section, index) => ({
          ...section,
          order: index + 1,
        })),
      } as unknown as PackageVersion,
    }),
    null,
  );
});

test("package pages enforce a finite aggregate source-byte budget", async () => {
  const markdown = "x".repeat(50_000);
  const version = await packageVersion(
    Array.from({ length: 6 }, (_, index) =>
      section(
        `package-section:large-${index}`,
        index,
        `Large ${index}`,
        markdown,
      )
    ),
  );

  const bounded = createParticipantPackagePage({
    requestUrl: REQUEST_URL,
    version,
    acceptanceRequired: false,
    limit: 6,
    after: null,
  });
  assert(bounded);
  assert.equal(bounded.document.data.sections.length, 5);
  assert.equal(bounded.nextAfter, "package-section:large-4");
  assert.notEqual(createParticipantPackagePage({
    requestUrl: REQUEST_URL,
    version,
    acceptanceRequired: false,
    limit: 4,
    after: null,
  }), null);
});

async function packageVersion(sections: readonly unknown[]): Promise<PackageVersion> {
  const parsed = await createPackageVersion({
    id: "package-version:reader",
    createdAt: "2026-08-09T10:00:00.000Z",
    changeSummary: "Initial synthetic package",
    materialChange: true,
    acknowledgmentText: "I understand this expression of interest is non-binding.",
    sections,
  });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) throw new Error("Expected valid package fixture.");
  return parsed.value;
}

function section(
  id: string,
  order: number,
  title: string,
  markdown: string,
  enabled = true,
) {
  return { id, order, title, markdown, enabled };
}
