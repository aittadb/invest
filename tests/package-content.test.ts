import assert from "node:assert/strict";
import test from "node:test";

import {
  createPackageAcceptance,
  createPackageVersion,
  requiresRenewedAcceptance,
  visiblePackageSections,
  type PackageVersion,
} from "../domain/package-content.ts";

const acknowledgment =
  "This is a non-binding expression of interest that can be edited or withdrawn.";

test("empty and disabled package sections stay out of the reader projection", async () => {
  const version = await validVersion({
    sections: [
      section("details", 2, "Details", "## Details\n\nVisible."),
      section("empty", 0, "Empty", "   "),
      section("draft", 1, "Draft", "Private draft.", false),
    ],
  });

  assert.deepEqual(
    version.sections.map((item) => item.id),
    ["empty", "draft", "details"],
  );
  assert.deepEqual(
    visiblePackageSections(version).map((item) => item.id),
    ["details"],
  );
});

test("package version creation detaches and freezes a deterministic snapshot", async () => {
  const mutableSections = [section("overview", 0, "Overview", "Initial copy.")];
  const source = versionInput({ sections: mutableSections });
  const first = await mustCreate(source);

  mutableSections[0].title = "Changed outside";
  mutableSections.push(section("later", 1, "Later", "Later copy."));

  assert.equal(first.sections[0].title, "Overview");
  assert.equal(first.sections.length, 1);
  assert(Object.isFrozen(first));
  assert(Object.isFrozen(first.sections));
  assert(Object.isFrozen(first.sections[0]));
  assert.match(first.contentHash, /^sha256:[a-f0-9]{64}$/);

  const sameContent = await mustCreate({
    ...versionInput({ sections: [section("overview", 0, "Overview", "Initial copy.")] }),
    id: "package-version:second",
    createdAt: "2026-08-09T12:00:00.000Z",
    changeSummary: "A metadata-only save",
    materialChange: true,
  });
  assert.equal(first.contentHash, sameContent.contentHash);
});

test("material acceptance requirements survive later non-material versions", async () => {
  const first = await validVersion({ id: "package-version:first" });
  const firstAcceptance = mustAccept(first, "acceptance:first", "2026-08-09T11:00:00.000Z");
  assert.equal(requiresRenewedAcceptance(first, null), true);
  assert.equal(requiresRenewedAcceptance(first, firstAcceptance), false);

  const editorial = await validVersion(
    {
      id: "package-version:editorial",
      createdAt: "2026-08-10T10:00:00.000Z",
      materialChange: false,
      sections: [section("overview", 0, "Overview", "Editorial update.")],
    },
    first,
  );
  assert.equal(editorial.requiredAcceptanceHash, first.requiredAcceptanceHash);
  assert.equal(requiresRenewedAcceptance(editorial, firstAcceptance), false);

  const material = await validVersion(
    {
      id: "package-version:material",
      createdAt: "2026-08-11T10:00:00.000Z",
      materialChange: true,
      sections: [section("overview", 0, "Overview", "Material update.")],
    },
    editorial,
  );
  assert.equal(requiresRenewedAcceptance(material, firstAcceptance), true);

  const laterEditorial = await validVersion(
    {
      id: "package-version:later",
      createdAt: "2026-08-12T10:00:00.000Z",
      materialChange: false,
      sections: [section("overview", 0, "Overview", "Later editorial update.")],
    },
    material,
  );
  assert.equal(laterEditorial.requiredAcceptanceHash, material.contentHash);
  assert.equal(requiresRenewedAcceptance(laterEditorial, firstAcceptance), true);

  const renewed = mustAccept(
    laterEditorial,
    "acceptance:renewed",
    "2026-08-12T11:00:00.000Z",
  );
  assert.equal(requiresRenewedAcceptance(laterEditorial, renewed), false);
  assert.equal(renewed.acceptedContentHash, laterEditorial.contentHash);
  assert.equal(renewed.satisfiedRequirementHash, material.contentHash);
});

test("unsafe Markdown is rejected at the package contract boundary", async () => {
  const unsafe = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<iframe src=https://example.test></iframe>",
    "[Run](javascript:alert(1))",
    "![Track](data:image/svg+xml;base64,PHN2Zz4=)",
  ];

  for (const markdown of unsafe) {
    const result = await createPackageVersion(
      versionInput({ sections: [section("unsafe", 0, "Unsafe", markdown)] }),
    );
    assert.equal(result.ok, false, markdown);
    if (!result.ok) {
      assert.deepEqual(result.issues, [
        { code: "invalid_format", path: "version.sections.0.markdown" },
      ]);
    }
  }

  const safe = await createPackageVersion(
    versionInput({
      sections: [
        section(
          "safe",
          0,
          "Safe",
          "Read the [project documentation](https://example.test/docs).",
        ),
      ],
    }),
  );
  assert.equal(safe.ok, true);
});

function section(
  id: string,
  order: number,
  title: string,
  markdown: string,
  enabled = true,
) {
  return { id, order, title, markdown, enabled };
}

function versionInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "package-version:initial",
    createdAt: "2026-08-09T10:00:00.000Z",
    changeSummary: "Initial package",
    materialChange: false,
    acknowledgmentText: acknowledgment,
    sections: [section("overview", 0, "Overview", "Initial copy.")],
    ...overrides,
  };
}

async function validVersion(
  overrides: Record<string, unknown> = {},
  previous: PackageVersion | null = null,
): Promise<PackageVersion> {
  return mustCreate(versionInput(overrides), previous);
}

async function mustCreate(
  input: unknown,
  previous: PackageVersion | null = null,
): Promise<PackageVersion> {
  const result = await createPackageVersion(input, previous);
  if (!result.ok) assert.fail(JSON.stringify(result.issues));
  return result.value;
}

function mustAccept(
  version: PackageVersion,
  id: string,
  acceptedAt: string,
) {
  const result = createPackageAcceptance(
    {
      id,
      participantSubject: "issuer.example/participant:case-sensitive",
      acceptedAt,
    },
    version,
  );
  if (!result.ok) assert.fail(JSON.stringify(result.issues));
  return result.value;
}
