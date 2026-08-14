import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseActorSubject, type ActorSubject } from "../domain/foundation.ts";
import {
  createPackageVersion,
  type PackageVersion,
} from "../domain/package-content.ts";
import {
  INVESTOR_APP_API_VERSION,
  INVESTOR_APP_MEDIA_TYPE,
} from "../domain/public-campaign-resource.ts";
import type { AuthorizedParticipantAccess } from "../domain/participant-home-resource.ts";
import { PRIVATE_PACKAGE_PATH } from "../domain/participant-navigation.ts";
import type { RevisionedSnapshot } from "../repositories/in-memory-content-repository.ts";
import type { ApplicationRouteContext } from "../worker/contracts.ts";
import { createParticipantPackageReaderRouteHandler } from "../worker/routes/participant-package-reader.ts";
import { syntheticPublicCampaign } from "./fixtures/public-campaign.ts";

const ORIGIN = "https://campaign.example";
const ALICE = subject("issuer.invalid/participant:alice");
const BOB = subject("issuer.invalid/participant:bob");
const PRIVATE_FAILURE = "private backend detail";

test("registered readers receive equivalent safe HTML and hypermedia package pages", async () => {
  const version = await packageFixture();
  const harness = createHarness({ current: { revision: 4, snapshot: version } });

  const jsonResponse = await harness.dispatch(request("?limit=2", mediaType()), {
    actor: ALICE,
    access: participantAccess(version, true),
  });
  assert.equal(jsonResponse.status, 200);
  assert.equal(
    jsonResponse.headers.get("content-type"),
    `${INVESTOR_APP_MEDIA_TYPE}; version=${INVESTOR_APP_API_VERSION}; charset=utf-8`,
  );
  const document = await jsonResponse.json() as Record<string, unknown>;
  const data = document.data as Record<string, unknown>;
  const sections = data.sections as readonly Record<string, unknown>[];
  assert.equal(document.type, "participant-package");
  assert.equal(data.acceptance_required, true);
  assert.equal(data.acknowledgment_text, "I understand this is non-binding.");
  assert.deepEqual(sections.map(({ id }) => id), [
    "package-section:overview",
    "package-section:details",
  ]);
  assert.equal(
    (document.links as readonly { rel: readonly string[] }[]).some((link) =>
      link.rel.includes("next")
    ),
    true,
  );

  const jsonText = JSON.stringify(document);
  for (const privateValue of [
    "PRIVATE DISABLED DRAFT",
    "contentHash",
    "requiredAcceptanceHash",
    "repository_revision",
    '"enabled"',
    '"order"',
  ]) {
    assert.equal(jsonText.includes(privateValue), false, privateValue);
  }

  const htmlResponse = await harness.dispatch(request("?limit=2", "text/html"), {
    actor: ALICE,
    access: participantAccess(version, true),
  });
  assert.equal(htmlResponse.status, 200);
  assert.equal(
    htmlResponse.headers.get("content-security-policy")?.includes("style-src 'self'"),
    true,
  );
  assert.equal(
    htmlResponse.headers.get("content-security-policy")?.startsWith("default-src 'none'"),
    true,
  );
  assert.equal(
    htmlResponse.headers.get("content-security-policy")?.includes("unsafe-inline"),
    false,
  );
  assert.equal(htmlResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    htmlResponse.headers.get("cross-origin-resource-policy"),
    "same-origin",
  );
  const html = await htmlResponse.text();
  assert.match(html, /<h1>Northstar Robotics<\/h1>/u);
  assert.match(html, /<strong>Safe formatted copy\.<\/strong>/u);
  assert.match(html, /Acknowledgment required/u);
  assert.match(html, /Continue reading/u);
  assert.doesNotMatch(html, /PRIVATE DISABLED DRAFT|contentHash/u);
  assert.equal(harness.reads(), 2);
});

test("package pagination and query bounds are deterministic", async () => {
  const version = await packageFixture();
  const harness = createHarness({ current: { revision: 4, snapshot: version } });
  const context = { actor: ALICE, access: participantAccess(version, false) };

  const first = await harness.dispatch(request("?limit=1", mediaType()), context);
  const firstDocument = await first.json() as {
    data: { sections: readonly { id: string }[] };
    links: readonly { rel: readonly string[]; href: string }[];
  };
  assert.deepEqual(firstDocument.data.sections.map(({ id }) => id), [
    "package-section:overview",
  ]);
  const next = firstDocument.links.find((link) => link.rel.includes("next"));
  assert(next);
  const second = await harness.dispatch(
    new Request(next.href, { headers: { accept: mediaType() } }),
    context,
  );
  assert.equal(second.status, 200);
  assert.deepEqual(
    ((await second.json()) as { data: { sections: readonly { id: string }[] } })
      .data.sections.map(({ id }) => id),
    ["package-section:details"],
  );

  for (const query of [
    "?limit=0",
    "?limit=17",
    "?limit=1&limit=2",
    "?after=not-present",
    "?private=true",
  ]) {
    const response = await harness.dispatch(request(query, mediaType()), context);
    assert.equal(response.status, 400, query);
    assert.doesNotMatch(await response.text(), /not-present|private=true/u);
  }

  const unsupported = await harness.dispatch(
    request("", `${INVESTOR_APP_MEDIA_TYPE}; version=99`),
    context,
  );
  assert.equal(unsupported.status, 406);
  const method = await harness.dispatch(
    new Request(`${ORIGIN}${PRIVATE_PACKAGE_PATH}`, {
      method: "POST",
      headers: { accept: mediaType() },
    }),
    context,
  );
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET");
});

test("anonymous, unregistered, foreign, missing, and failed reads disclose nothing", async () => {
  const version = await packageFixture();
  const harness = createHarness({ current: { revision: 1, snapshot: version } });

  const anonymous = await harness.dispatch(request("", mediaType()), {
    actor: null,
    access: null,
  });
  assert.equal(anonymous.status, 401);
  assert.equal(harness.reads(), 0);

  const unregistered = await harness.dispatch(request("", mediaType()), {
    actor: ALICE,
    access: null,
  });
  assert.equal(unregistered.status, 404);
  assert.equal(harness.reads(), 0);

  const foreign = await harness.dispatch(request("", mediaType()), {
    actor: BOB,
    access: participantAccess(version, false),
  });
  assert.equal(foreign.status, 404);
  assert.equal(harness.reads(), 0);
  assert.doesNotMatch(await foreign.text(), /participant:alice|participant:bob/u);

  const missing = createHarness({ current: null });
  const missingResponse = await missing.dispatch(request("", mediaType()), {
    actor: ALICE,
    access: participantAccess(version, false),
  });
  assert.equal(missingResponse.status, 404);

  const failed = createHarness({ failure: new Error(PRIVATE_FAILURE) });
  const failedResponse = await failed.dispatch(request("", mediaType()), {
    actor: ALICE,
    access: participantAccess(version, false),
  });
  assert.equal(failedResponse.status, 503);
  assert.doesNotMatch(await failedResponse.text(), /private backend detail/u);
});

test("reader rejects stale projections and unsafe repository snapshots", async () => {
  const version = await packageFixture();
  const stale = createHarness({ current: { revision: 2, snapshot: version } });
  const staleResponse = await stale.dispatch(request("", mediaType()), {
    actor: ALICE,
    access: {
      ...participantAccess(version, false),
      currentPackage: {
        ...participantAccess(version, false).currentPackage!,
        changeSummary: "Private stale summary",
      },
    },
  });
  assert.equal(staleResponse.status, 503);
  assert.doesNotMatch(await staleResponse.text(), /Private stale summary/u);

  const unsafeVersion = {
    ...version,
    sections: [{
      ...version.sections[0],
      markdown: "<script>PRIVATE UNSAFE DRAFT</script>",
    }],
  } as unknown as PackageVersion;
  const unsafe = createHarness({ current: { revision: 1, snapshot: unsafeVersion } });
  const unsafeResponse = await unsafe.dispatch(request("", mediaType()), {
    actor: ALICE,
    access: participantAccess(unsafeVersion, false),
  });
  assert.equal(unsafeResponse.status, 400);
  assert.doesNotMatch(await unsafeResponse.text(), /PRIVATE UNSAFE DRAFT|script/u);
});

test("participant package stylesheet keeps stable responsive reader geometry", async () => {
  const css = await readFile(
    new URL("../public/participant-package.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /grid-template-columns: minmax\(180px, 0\.42fr\) minmax\(0, 1fr\)/u);
  assert.match(css, /@media \(max-width: 720px\)/u);
  assert.match(css, /grid-template-columns: 1fr/u);
  assert.doesNotMatch(css, /letter-spacing:\s*-/u);
  assert.doesNotMatch(css, /font-size:\s*clamp\([^;]*(?:vw|dvw)/u);
});

type HarnessOptions = Readonly<{
  current?: RevisionedSnapshot<PackageVersion> | null;
  failure?: Error;
}>;

function createHarness(options: HarnessOptions) {
  let reads = 0;
  const route = createParticipantPackageReaderRouteHandler({
    repositoryFor: () => ({
      async current() {
        reads += 1;
        if (options.failure) throw options.failure;
        return options.current ?? null;
      },
    }),
  });
  return {
    reads: () => reads,
    async dispatch(
      incoming: Request,
      identity: Readonly<{
        actor: ActorSubject | null;
        access: AuthorizedParticipantAccess | null;
      }>,
    ) {
      const response = await route(routeContext(incoming, identity));
      assert(response);
      return response;
    },
  };
}

function routeContext(
  incoming: Request,
  identity: Readonly<{
    actor: ActorSubject | null;
    access: AuthorizedParticipantAccess | null;
  }>,
): ApplicationRouteContext {
  return {
    request: incoming,
    url: new URL(incoming.url),
    resourceUrl: incoming.url,
    actor: identity.actor === null
      ? null
      : {
          userId: identity.actor,
          email: "reader@example.test",
          displayName: "Synthetic reader",
        },
    isOwner: false,
    participantAccess: identity.access,
    campaign: syntheticPublicCampaign,
    renderApplication: async () => {
      throw new Error("The participant package route owns this response.");
    },
  };
}

function participantAccess(
  version: PackageVersion,
  acceptanceRequired: boolean,
): AuthorizedParticipantAccess {
  return Object.freeze({
    subject: ALICE,
    email: "reader@example.test",
    displayName: "Synthetic reader",
    declaredInterest: "both",
    participationContext: "individual",
    accountStatus: "active",
    currentPackage: Object.freeze({
      id: version.id,
      createdAt: version.createdAt,
      changeSummary: version.changeSummary,
      materialChange: version.materialChange,
      requiresCurrentAcceptance: acceptanceRequired,
    }),
  });
}

function request(query: string, accept: string): Request {
  return new Request(`${ORIGIN}${PRIVATE_PACKAGE_PATH}${query}`, {
    headers: { accept },
  });
}

function mediaType(): string {
  return `${INVESTOR_APP_MEDIA_TYPE}; version=${INVESTOR_APP_API_VERSION}`;
}

async function packageFixture(): Promise<PackageVersion> {
  const parsed = await createPackageVersion({
    id: "package-version:reader-route",
    createdAt: "2026-08-09T11:00:00.000Z",
    changeSummary: "Current package update",
    materialChange: true,
    acknowledgmentText: "I understand this is non-binding.",
    sections: [
      {
        id: "package-section:overview",
        order: 0,
        title: "Overview",
        markdown: "**Safe formatted copy.**",
        enabled: true,
      },
      {
        id: "package-section:hidden",
        order: 1,
        title: "Hidden draft",
        markdown: "PRIVATE DISABLED DRAFT",
        enabled: false,
      },
      {
        id: "package-section:details",
        order: 2,
        title: "Details",
        markdown: "More package detail.",
        enabled: true,
      },
      {
        id: "package-section:risks",
        order: 3,
        title: "Risks",
        markdown: "Review each stated risk.",
        enabled: true,
      },
    ],
  });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) throw new Error("Expected package fixture.");
  return parsed.value;
}

function subject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("Expected actor subject.");
  return parsed.value;
}
