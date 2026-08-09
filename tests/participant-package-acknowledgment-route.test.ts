import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseActorSubject,
  parseTimestamp,
  type ActorSubject,
  type Timestamp,
} from "../domain/foundation.ts";
import {
  createPackageAcceptance,
  createPackageVersion,
  type PackageAcceptanceRecord,
  type PackageVersion,
} from "../domain/package-content.ts";
import { PARTICIPANT_PACKAGE_ACKNOWLEDGMENT_PATH } from "../domain/participant-package-acknowledgment-resource.ts";
import type { AuthorizedParticipantAccess } from "../domain/participant-home-resource.ts";
import {
  INVESTOR_APP_API_VERSION,
  INVESTOR_APP_MEDIA_TYPE,
} from "../domain/public-campaign-resource.ts";
import { parseStorageOperationId } from "../domain/storage-adapter.ts";
import {
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
  hashCsrfToken,
  type TrustedMutationSession,
} from "../http/mutation-security.ts";
import {
  InMemoryAcknowledgmentRepository,
  InMemoryPackageVersionRepository,
  type AcknowledgmentRepository,
  type PackageVersionRepository,
  type RevisionedSnapshot,
} from "../repositories/in-memory-content-repository.ts";
import type {
  ApplicationRouteContext,
  ApplicationRouteHandler,
} from "../worker/contracts.ts";
import {
  createParticipantPackageAcknowledgmentRouteHandler,
  type ParticipantPackageAcknowledgmentRepositories,
} from "../worker/routes/participant-package-acknowledgment.ts";
import { syntheticPublicCampaign } from "./fixtures/public-campaign.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";

const APP_ORIGIN = "https://campaign.example";
const SECOND_ALLOWED_ORIGIN = "https://alternate.example";
const CSRF_TOKEN = "package_ack_csrf_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const WRONG_CSRF = "wrong_package_csrf_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PRIVATE_ACKNOWLEDGMENT =
  "I understand this package and any indication remain non-binding.";
const PRIVATE_FAILURE = "PRIVATE persistence detail must not escape";
const ALICE = subject("issuer.invalid/participant:alice");
const BOB = subject("issuer.invalid/participant:bob");
const OWNER = subject("issuer.invalid/owner:campaign");

test("required acknowledgment has equivalent bounded HTML and hypermedia actions", async () => {
  const harness = await createHarness();
  const access = await harness.access(ALICE);

  const jsonResponse = await harness.dispatch(
    getRequest(ALICE, mediaType()),
    identity(ALICE, access),
  );
  assert.equal(jsonResponse.status, 200);
  assert.equal(jsonResponse.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  assert.equal(jsonResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    jsonResponse.headers.get("cross-origin-resource-policy"),
    "same-origin",
  );
  const document = await jsonDocument(jsonResponse);
  const data = resourceData(document);
  assert.equal(document.type, "participant-package-acknowledgment");
  assert.equal(data.status, "acceptance_required");
  assert.equal(data.acknowledgment_text, PRIVATE_ACKNOWLEDGMENT);
  assert.equal(data.latest_acceptance, null);
  assert.deepEqual(actionNames(document), ["acknowledge-current-package"]);
  const action = actionsOf(document)[0];
  assert(action);
  assert.equal(action.method, "POST");
  assert.equal(
    action.href,
    `${APP_ORIGIN}${PARTICIPANT_PACKAGE_ACKNOWLEDGMENT_PATH}`,
  );
  assert.deepEqual(
    fieldsOf(action).map((field) => String(field.name)),
    ["operation-id"],
  );
  const operationId = String(fieldsOf(action)[0]?.value);
  assert.match(operationId, /^package-acknowledgment:test-\d+$/u);

  const serialized = JSON.stringify(document);
  assert.doesNotMatch(
    serialized,
    /participantSubject|subject|contentHash|content_hash|requiredAcceptanceHash|required_acceptance_hash|repository_revision|PRIVATE SECTION/u,
  );

  const htmlResponse = await harness.dispatch(
    getRequest(ALICE, "text/html"),
    identity(ALICE, access),
  );
  assert.equal(htmlResponse.status, 200);
  const csp = htmlResponse.headers.get("content-security-policy") ?? "";
  assert.match(csp, /^default-src 'none'/u);
  assert.match(csp, /style-src 'self'/u);
  assert.match(csp, /form-action 'self'/u);
  assert.doesNotMatch(csp, /unsafe-inline/u);
  const html = await htmlResponse.text();
  assert.match(html, /<h1>Package acknowledgment<\/h1>/u);
  assert.match(html, /Renewed acknowledgment required/u);
  assert.match(html, new RegExp(escapePattern(PRIVATE_ACKNOWLEDGMENT), "u"));
  assert.match(
    html,
    /<link rel="stylesheet" href="\/participant-package-acknowledgment\.css">/u,
  );
  const form = acknowledgmentForm(html);
  assert.equal(
    form.action,
    `${APP_ORIGIN}${PARTICIPANT_PACKAGE_ACKNOWLEDGMENT_PATH}`,
  );
  assert.equal(form.name, "acknowledge-current-package");
  assert.deepEqual(form.fields, ["operation-id", MUTATION_CSRF_FIELD]);
  assert.doesNotMatch(
    html,
    /participant:alice|contentHash|requiredAcceptanceHash|PRIVATE SECTION/u,
  );
  assert.equal(harness.operationIdCalls(), 2);
  assert.equal(harness.csrfCalls(), 2);
});

test("JSON and native form submissions create server-derived immutable evidence", async () => {
  const harness = await createHarness();
  const requiredAccess = await harness.access(ALICE);
  const discovery = await harness.dispatch(
    getRequest(ALICE, mediaType()),
    identity(ALICE, requiredAccess),
  );
  const operationId = operationIdFrom(await jsonDocument(discovery));

  const created = await harness.dispatch(
    jsonMutation(ALICE, operationId),
    identity(ALICE, requiredAccess),
  );
  assert.equal(created.status, 201);
  assert.equal(created.headers.get(MUTATION_CSRF_HEADER), null);
  const createdDocument = await jsonDocument(created);
  assert.equal(resourceData(createdDocument).status, "satisfied");
  assert.deepEqual(actionsOf(createdDocument), []);
  const evidence = dataOf(resourceData(createdDocument).latest_acceptance);
  assert.equal(evidence.evidence_id, operationId);
  assert.equal(evidence.accepted_at, "2026-08-10T12:00:00.000Z");

  const current = await harness.currentPackage();
  const stored = await harness.latest(ALICE);
  assert(current);
  assert(stored);
  assert.equal(stored.revision, 1);
  assert.equal(stored.snapshot.id, operationId);
  assert.equal(stored.snapshot.participantSubject, ALICE);
  assert.equal(stored.snapshot.acceptedAt, timestamp("2026-08-10T12:00:00.000Z"));
  assert.equal(stored.snapshot.acceptedVersionId, current.snapshot.id);
  assert.equal(stored.snapshot.acceptedContentHash, current.snapshot.contentHash);
  assert.equal(
    stored.snapshot.satisfiedRequirementHash,
    current.snapshot.requiredAcceptanceHash,
  );
  assert.equal(harness.nowCalls(), 1);

  const satisfiedAccess = await harness.access(ALICE);
  const replay = await harness.dispatch(
    jsonMutation(ALICE, operationId),
    identity(ALICE, satisfiedAccess),
  );
  assert.equal(replay.status, 200);
  assert.deepEqual(
    resourceData(await jsonDocument(replay)).latest_acceptance,
    evidence,
  );
  assert.equal(harness.nowCalls(), 1);
  assert.equal((await harness.latest(ALICE))?.revision, 1);

  const changedRetry = await harness.dispatch(
    jsonMutation(ALICE, operationId, {
      "accepted-at": "2026-08-09T13:00:00.000Z",
    }),
    identity(ALICE, satisfiedAccess),
  );
  assert.equal(changedRetry.status, 400);
  assert.equal((await harness.latest(ALICE))?.revision, 1);

  const formHarness = await createHarness();
  const formAccess = await formHarness.access(ALICE);
  const formDiscovery = await formHarness.dispatch(
    getRequest(ALICE, "text/html"),
    identity(ALICE, formAccess),
  );
  const form = acknowledgmentForm(await formDiscovery.text());
  const formOperationId = form.values.get("operation-id");
  const formCsrf = form.values.get(MUTATION_CSRF_FIELD);
  assert(formOperationId);
  assert.equal(formCsrf, CSRF_TOKEN);
  const formCreated = await formHarness.dispatch(
    formMutation(ALICE, [
      ["operation-id", formOperationId],
      [MUTATION_CSRF_FIELD, formCsrf],
    ]),
    identity(ALICE, formAccess),
  );
  assert.equal(formCreated.status, 201);
  assert.equal(formCreated.headers.get(MUTATION_CSRF_HEADER), null);
  const acceptedHtml = await formCreated.text();
  assert.match(acceptedHtml, /Current requirement satisfied/u);
  assert.doesNotMatch(acceptedHtml, /<form\b/u);
  assert.equal((await formHarness.latest(ALICE))?.snapshot.id, formOperationId);
});

test("editorial versions preserve satisfaction while material versions renew it", async () => {
  const harness = await createHarness();
  const firstAccess = await harness.access(ALICE);
  const firstDiscovery = await harness.dispatch(
    getRequest(ALICE, mediaType()),
    identity(ALICE, firstAccess),
  );
  const firstOperation = operationIdFrom(await jsonDocument(firstDiscovery));
  assert.equal(
    (await harness.dispatch(
      jsonMutation(ALICE, firstOperation),
      identity(ALICE, firstAccess),
    )).status,
    201,
  );
  const firstVersion = await harness.currentPackage();
  assert(firstVersion);

  const editorial = await harness.appendPackage({
    id: "package-version:editorial-v2",
    createdAt: "2026-08-09T13:00:00.000Z",
    materialChange: false,
    changeSummary: "Editorial clarification",
    acknowledgmentText: "Clarified non-binding acknowledgment text.",
  });
  assert.notEqual(editorial.snapshot.contentHash, firstVersion.snapshot.contentHash);
  assert.equal(
    editorial.snapshot.requiredAcceptanceHash,
    firstVersion.snapshot.requiredAcceptanceHash,
  );
  const operationsBeforeEditorialRead = harness.operationIdCalls();
  const csrfBeforeEditorialRead = harness.csrfCalls();
  const editorialAccess = await harness.access(ALICE);
  const editorialResponse = await harness.dispatch(
    getRequest(ALICE, mediaType()),
    identity(ALICE, editorialAccess),
  );
  const editorialDocument = await jsonDocument(editorialResponse);
  assert.equal(resourceData(editorialDocument).status, "satisfied");
  assert.deepEqual(actionsOf(editorialDocument), []);
  assert.equal(editorialResponse.headers.get(MUTATION_CSRF_HEADER), null);
  assert.equal(harness.operationIdCalls(), operationsBeforeEditorialRead);
  assert.equal(harness.csrfCalls(), csrfBeforeEditorialRead);

  const material = await harness.appendPackage({
    id: "package-version:material-v3",
    createdAt: "2026-08-09T14:00:00.000Z",
    materialChange: true,
    changeSummary: "Material terms changed",
    acknowledgmentText: "Updated material non-binding acknowledgment text.",
  });
  assert.equal(
    material.snapshot.requiredAcceptanceHash,
    material.snapshot.contentHash,
  );
  assert.notEqual(
    material.snapshot.requiredAcceptanceHash,
    firstVersion.snapshot.requiredAcceptanceHash,
  );
  const materialAccess = await harness.access(ALICE);
  const oldRetry = await harness.dispatch(
    jsonMutation(ALICE, firstOperation),
    identity(ALICE, materialAccess),
  );
  assert.equal(oldRetry.status, 200);
  const oldRetryDocument = await jsonDocument(oldRetry);
  assert.equal(resourceData(oldRetryDocument).status, "acceptance_required");
  assert.equal(
    dataOf(resourceData(oldRetryDocument).latest_acceptance).evidence_id,
    firstOperation,
  );
  assert.equal(harness.nowCalls(), 1);
  const materialOperation = operationIdFrom(oldRetryDocument);

  const materialAccepted = await harness.dispatch(
    jsonMutation(ALICE, materialOperation),
    identity(ALICE, materialAccess),
  );
  assert.equal(materialAccepted.status, 201);
  assert.equal(resourceData(await jsonDocument(materialAccepted)).status, "satisfied");
  const latest = await harness.latest(ALICE);
  assert(latest);
  assert.equal(latest.revision, 2);
  assert.equal(latest.snapshot.acceptedVersionId, material.snapshot.id);
  assert.equal(
    latest.snapshot.satisfiedRequirementHash,
    material.snapshot.requiredAcceptanceHash,
  );
});

test("anonymous, unregistered, owner, deleted, and foreign actors get no repository capability", async () => {
  const harness = await createHarness();
  const aliceAccess = await harness.access(ALICE);
  const ownerAccess = await harness.access(OWNER);
  const initialFactoryCalls = harness.factoryCalls();

  const anonymous = await harness.dispatch(
    getRequest(null, mediaType()),
    identity(null, null),
  );
  assert.equal(anonymous.status, 401);
  assert.deepEqual(actionNames(await jsonDocument(anonymous)), ["sign-in"]);

  const unregistered = await harness.dispatch(
    getRequest(ALICE, mediaType()),
    identity(ALICE, null),
  );
  assert.equal(unregistered.status, 404);

  const foreign = await harness.dispatch(
    getRequest(BOB, mediaType()),
    identity(BOB, aliceAccess),
  );
  assert.equal(foreign.status, 404);

  const owner = await harness.dispatch(
    getRequest(OWNER, mediaType()),
    identity(OWNER, ownerAccess, true),
  );
  assert.equal(owner.status, 404);

  const deletedAccess = Object.freeze({
    ...aliceAccess,
    accountStatus: "deletion-requested" as const,
  });
  const deleted = await harness.dispatch(
    getRequest(ALICE, mediaType()),
    identity(ALICE, deletedAccess),
  );
  assert.equal(deleted.status, 404);

  const substitutedMutation = await harness.dispatch(
    jsonMutation(BOB, "package-acknowledgment:foreign-actor"),
    identity(ALICE, aliceAccess),
  );
  assert.equal(substitutedMutation.status, 404);

  const ownerMutation = await harness.dispatch(
    jsonMutation(
      OWNER,
      "package-acknowledgment:owner-actor",
      {},
      { sessionType: "owner" },
    ),
    identity(OWNER, ownerAccess, true),
  );
  assert.equal(ownerMutation.status, 404);

  for (const response of [unregistered, foreign, owner, deleted, substitutedMutation]) {
    assert.doesNotMatch(
      await response.clone().text(),
      /participant:alice|participant:bob|owner:campaign|PRIVATE/u,
    );
  }
  assert.equal(harness.factoryCalls(), initialFactoryCalls);
  assert.equal(await harness.latest(ALICE), null);
  assert.equal(await harness.latest(BOB), null);
});

test("origin, CSRF, body, exact fields, method, and stale projections fail before mutation", async () => {
  const harness = await createHarness();
  const access = await harness.access(ALICE);
  const operationId = "package-acknowledgment:negative-path";

  const crossOrigin = await harness.dispatch(
    jsonMutation(ALICE, operationId, {}, { origin: SECOND_ALLOWED_ORIGIN }),
    identity(ALICE, access),
  );
  assert.equal(crossOrigin.status, 403);

  const badCsrf = await harness.dispatch(
    jsonMutation(ALICE, operationId, {}, { csrf: WRONG_CSRF }),
    identity(ALICE, access),
  );
  assert.equal(badCsrf.status, 403);

  for (const [name, value] of [
    ["subject", BOB],
    ["participant-subject", BOB],
    ["package-version-id", "package-version:forged"],
    ["accepted-version-id", "package-version:forged"],
    ["content-hash", `sha256:${"a".repeat(64)}`],
    ["requirement-hash", `sha256:${"b".repeat(64)}`],
    ["accepted-at", "2026-08-09T12:00:00.000Z"],
    ["repository-revision", 1],
  ] as const) {
    const response = await harness.dispatch(
      jsonMutation(ALICE, operationId, { [name]: value }),
      identity(ALICE, access),
    );
    assert.equal(response.status, 400, name);
    assert.doesNotMatch(await response.text(), /forged|sha256|participant:bob/u);
  }

  const malformed = await harness.dispatch(
    jsonMutation(ALICE, "bad operation id"),
    identity(ALICE, access),
  );
  assert.equal(malformed.status, 400);

  const oversized = await harness.dispatch(
    jsonMutation(ALICE, "x".repeat(700)),
    identity(ALICE, access),
  );
  assert.equal(oversized.status, 413);

  const unsupportedType = new Request(
    `${APP_ORIGIN}${PARTICIPANT_PACKAGE_ACKNOWLEDGMENT_PATH}`,
    {
      method: "POST",
      headers: {
        accept: mediaType(),
        "content-type": "text/plain",
        origin: APP_ORIGIN,
        "x-test-session-subject": ALICE,
        [MUTATION_CSRF_HEADER]: CSRF_TOKEN,
      },
      body: operationId,
    },
  );
  assert.equal(
    (await harness.dispatch(unsupportedType, identity(ALICE, access))).status,
    415,
  );

  const repeated = await harness.dispatch(
    formMutation(ALICE, [
      ["operation-id", operationId],
      ["operation-id", "package-acknowledgment:changed"],
      [MUTATION_CSRF_FIELD, CSRF_TOKEN],
    ]),
    identity(ALICE, access),
  );
  assert.equal(repeated.status, 400);

  const staleAccess = Object.freeze({
    ...access,
    currentPackage: Object.freeze({
      ...access.currentPackage!,
      changeSummary: "PRIVATE stale package projection",
    }),
  });
  const stale = await harness.dispatch(
    jsonMutation(ALICE, "package-acknowledgment:stale-projection"),
    identity(ALICE, staleAccess),
  );
  assert.equal(stale.status, 412);
  assert.doesNotMatch(await stale.text(), /PRIVATE stale/u);

  const staleStatus = Object.freeze({
    ...access,
    currentPackage: Object.freeze({
      ...access.currentPackage!,
      requiresCurrentAcceptance: false,
    }),
  });
  assert.equal(
    (await harness.dispatch(
      jsonMutation(ALICE, "package-acknowledgment:stale-status"),
      identity(ALICE, staleStatus),
    )).status,
    412,
  );

  const query = await harness.dispatch(
    getRequest(ALICE, mediaType(), "?version=forged"),
    identity(ALICE, access),
  );
  assert.equal(query.status, 400);
  assert.doesNotMatch(await query.text(), /forged/u);

  const unsupportedVersion = await harness.dispatch(
    getRequest(ALICE, `${INVESTOR_APP_MEDIA_TYPE}; version=99`),
    identity(ALICE, access),
  );
  assert.equal(unsupportedVersion.status, 406);

  const method = await harness.dispatch(
    new Request(`${APP_ORIGIN}${PARTICIPANT_PACKAGE_ACKNOWLEDGMENT_PATH}`, {
      method: "DELETE",
      headers: { accept: mediaType() },
    }),
    identity(ALICE, access),
  );
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET, POST");
  assert.equal(await harness.latest(ALICE), null);
  assert.equal(harness.nowCalls(), 0);
});

test("foreign evidence and persistence failures are fixed and non-disclosing", async () => {
  const version = await packageVersionFixture({
    id: "package-version:failure-fixture",
    createdAt: "2026-08-09T10:00:00.000Z",
    materialChange: true,
    changeSummary: "PRIVATE package change summary",
    acknowledgmentText: "PRIVATE acknowledgment text",
  });
  const access = participantAccess(ALICE, version, true);

  const readFailureRoute = await injectedRoute(() => ({
    packages: {
      async current() {
        throw new Error(PRIVATE_FAILURE);
      },
    },
    acknowledgments: inertAcknowledgments(),
  }));
  const readFailure = await dispatchRoute(
    readFailureRoute,
    getRequest(ALICE, mediaType()),
    identity(ALICE, access),
  );
  assert.equal(readFailure.status, 503);
  assertPrivateFailure(await readFailure.text());

  let recordCalls = 0;
  const recordFailureRoute = await injectedRoute(() => ({
    packages: fixedPackageRepository(version),
    acknowledgments: {
      ...inertAcknowledgments(),
      async record() {
        recordCalls += 1;
        throw new Error(PRIVATE_FAILURE);
      },
    },
  }));
  const recordFailure = await dispatchRoute(
    recordFailureRoute,
    jsonMutation(ALICE, "package-acknowledgment:persistence-failure"),
    identity(ALICE, access),
  );
  assert.equal(recordFailure.status, 503);
  assert.equal(recordCalls, 1);
  assertPrivateFailure(await recordFailure.text());

  const foreignAcceptance = createPackageAcceptance(
    {
      id: "package-acknowledgment:foreign-evidence",
      participantSubject: BOB,
      acceptedAt: "2026-08-09T11:00:00.000Z",
    },
    version,
  );
  assert(foreignAcceptance.ok);
  const foreignEvidenceRoute = await injectedRoute(() => ({
    packages: fixedPackageRepository(version),
    acknowledgments: {
      ...inertAcknowledgments(),
      async latest() {
        return { revision: 1, snapshot: foreignAcceptance.value };
      },
    },
  }));
  const foreignEvidence = await dispatchRoute(
    foreignEvidenceRoute,
    getRequest(ALICE, mediaType()),
    identity(ALICE, access),
  );
  assert.equal(foreignEvidence.status, 404);
  assertPrivateFailure(await foreignEvidence.text());

  const malformedVersion = {
    ...version,
    requiredAcceptanceHash: "sha256:PRIVATE",
  } as unknown as PackageVersion;
  const malformedRoute = await injectedRoute(() => ({
    packages: fixedPackageRepository(malformedVersion),
    acknowledgments: inertAcknowledgments(),
  }));
  const malformed = await dispatchRoute(
    malformedRoute,
    getRequest(ALICE, mediaType()),
    identity(ALICE, participantAccess(ALICE, malformedVersion, true)),
  );
  assert.equal(malformed.status, 503);
  assertPrivateFailure(await malformed.text());
});

test("action discovery fails closed and satisfied resources issue no operation or CSRF", async () => {
  for (const csrfToken of [null, "invalid"] as const) {
    const harness = await createHarness({ csrfToken });
    const access = await harness.access(ALICE);
    for (const accept of ["text/html", mediaType()] as const) {
      const response = await harness.dispatch(
        getRequest(ALICE, accept),
        identity(ALICE, access),
      );
      assert.equal(response.status, 503);
      assert.equal(response.headers.get(MUTATION_CSRF_HEADER), null);
      assert.doesNotMatch(
        await response.text(),
        /package_ack_csrf|PRIVATE acknowledgment/u,
      );
    }
    assert.equal(await harness.latest(ALICE), null);
  }

  const harness = await createHarness();
  const access = await harness.access(ALICE);
  const discovery = await harness.dispatch(
    getRequest(ALICE, mediaType()),
    identity(ALICE, access),
  );
  const operationId = operationIdFrom(await jsonDocument(discovery));
  assert.equal(
    (await harness.dispatch(
      jsonMutation(ALICE, operationId),
      identity(ALICE, access),
    )).status,
    201,
  );
  const operationCalls = harness.operationIdCalls();
  const csrfCalls = harness.csrfCalls();
  const satisfiedAccess = await harness.access(ALICE);
  const satisfied = await harness.dispatch(
    getRequest(ALICE, mediaType()),
    identity(ALICE, satisfiedAccess),
  );
  assert.equal(satisfied.status, 200);
  assert.deepEqual(actionsOf(await jsonDocument(satisfied)), []);
  assert.equal(satisfied.headers.get(MUTATION_CSRF_HEADER), null);
  assert.equal(harness.operationIdCalls(), operationCalls);
  assert.equal(harness.csrfCalls(), csrfCalls);
});

test("acknowledgment stylesheet preserves stable responsive geometry", async () => {
  const css = await readFile(
    new URL(
      "../public/participant-package-acknowledgment.css",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    css,
    /grid-template-columns: minmax\(180px, 0\.42fr\) minmax\(0, 1fr\)/u,
  );
  assert.match(css, /@media \(max-width: 720px\)/u);
  assert.match(css, /grid-template-columns: 1fr/u);
  assert.match(css, /min-height: 44px/u);
  assert.doesNotMatch(css, /letter-spacing:\s*-/u);
  assert.doesNotMatch(css, /font-size:\s*clamp\([^;]*(?:vw|dvw)/u);
  assert.doesNotMatch(css, /gradient\(/u);
});

type Identity = Readonly<{
  actor: ActorSubject | null;
  access: AuthorizedParticipantAccess | null;
  owner: boolean;
}>;

type Harness = Readonly<{
  dispatch(request: Request, identity: Identity): Promise<Response>;
  access(subject: ActorSubject): Promise<AuthorizedParticipantAccess>;
  appendPackage(input: PackageFixtureInput): Promise<RevisionedSnapshot<PackageVersion>>;
  currentPackage(): Promise<RevisionedSnapshot<PackageVersion> | null>;
  latest(subject: ActorSubject): Promise<RevisionedSnapshot<PackageAcceptanceRecord> | null>;
  csrfCalls(): number;
  factoryCalls(): number;
  nowCalls(): number;
  operationIdCalls(): number;
}>;

async function createHarness(
  options: Readonly<{ csrfToken?: string | null }> = {},
): Promise<Harness> {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const packages = new InMemoryPackageVersionRepository(storage);
  const acknowledgments = new Map<string, InMemoryAcknowledgmentRepository>();
  const csrfHash = await hashCsrfToken(CSRF_TOKEN);
  const issuedCsrf = Object.hasOwn(options, "csrfToken")
    ? options.csrfToken ?? null
    : CSRF_TOKEN;
  let csrfCalls = 0;
  let factoryCalls = 0;
  let nowCalls = 0;
  let operationCalls = 0;

  const acknowledgmentFor = (actorSubject: ActorSubject) => {
    const key = actorSubject as string;
    const existing = acknowledgments.get(key);
    if (existing) return existing;
    const repository = new InMemoryAcknowledgmentRepository(
      storage,
      packages,
      actorSubject,
    );
    acknowledgments.set(key, repository);
    return repository;
  };
  const repositoryFor = (actorSubject: ActorSubject) => {
    factoryCalls += 1;
    return Object.freeze({
      packages,
      acknowledgments: acknowledgmentFor(actorSubject),
    });
  };
  const route = createParticipantPackageAcknowledgmentRouteHandler({
    repositoryFor,
    mutationSecurity: {
      allowedOrigins: [APP_ORIGIN, SECOND_ALLOWED_ORIGIN],
      resolveSession: async (request) => {
        const rawSubject = request.headers.get("x-test-session-subject");
        if (rawSubject === null) return null;
        const parsed = parseActorSubject(rawSubject);
        if (!parsed.ok) return null;
        return mutationSession(
          parsed.value,
          csrfHash,
          request.headers.get("x-test-session-type") === "owner"
            ? "owner"
            : "participant",
        );
      },
      now: () => new Date("2026-08-09T09:00:00.000Z"),
    },
    csrfTokenFor: (request, actorSubject) => {
      csrfCalls += 1;
      return request.headers.get("x-test-session-subject") === actorSubject
        ? issuedCsrf
        : null;
    },
    now: () => {
      const value = new Date(
        Date.parse("2026-08-10T12:00:00.000Z") + nowCalls * 60_000,
      );
      nowCalls += 1;
      return value;
    },
    createOperationId: () => {
      operationCalls += 1;
      return `package-acknowledgment:test-${operationCalls}`;
    },
  });

  async function appendPackage(
    input: PackageFixtureInput,
  ): Promise<RevisionedSnapshot<PackageVersion>> {
    const current = await packages.current();
    const result = await packages.append({
      operationId: storageOperationId(`package-operation:${input.id}`),
      expectedRevision: current?.revision ?? null,
      draft: packageDraft(input),
    });
    return Object.freeze({ revision: result.revision, snapshot: result.snapshot });
  }

  await appendPackage({
    id: "package-version:acknowledgment-v1",
    createdAt: "2026-08-09T10:00:00.000Z",
    materialChange: true,
    changeSummary: "Initial private package",
    acknowledgmentText: PRIVATE_ACKNOWLEDGMENT,
  });

  return Object.freeze({
    async dispatch(request, requestIdentity) {
      return dispatchRoute(route, request, requestIdentity);
    },
    async access(actorSubject) {
      const current = await packages.current();
      assert(current);
      const required = await acknowledgmentFor(actorSubject)
        .requiresCurrentAcceptance();
      return participantAccess(actorSubject, current.snapshot, required);
    },
    appendPackage,
    currentPackage: () => packages.current(),
    latest: (actorSubject) => acknowledgmentFor(actorSubject).latest(),
    csrfCalls: () => csrfCalls,
    factoryCalls: () => factoryCalls,
    nowCalls: () => nowCalls,
    operationIdCalls: () => operationCalls,
  });
}

async function injectedRoute(
  repositoryFor: (
    subject: ActorSubject,
  ) => ParticipantPackageAcknowledgmentRepositories,
): Promise<ApplicationRouteHandler> {
  const csrfHash = await hashCsrfToken(CSRF_TOKEN);
  return createParticipantPackageAcknowledgmentRouteHandler({
    repositoryFor,
    mutationSecurity: {
      allowedOrigins: [APP_ORIGIN],
      resolveSession: async (request) => {
        const raw = request.headers.get("x-test-session-subject");
        if (raw === null) return null;
        const parsed = parseActorSubject(raw);
        return parsed.ok
          ? mutationSession(parsed.value, csrfHash, "participant")
          : null;
      },
      now: () => new Date("2026-08-09T09:00:00.000Z"),
    },
    csrfTokenFor: () => CSRF_TOKEN,
    now: () => new Date("2026-08-09T12:00:00.000Z"),
    createOperationId: () => "package-acknowledgment:injected",
  });
}

async function dispatchRoute(
  route: ApplicationRouteHandler,
  request: Request,
  requestIdentity: Identity,
): Promise<Response> {
  const response = await route(routeContext(request, requestIdentity));
  assert(response);
  return response;
}

function routeContext(
  request: Request,
  requestIdentity: Identity,
): ApplicationRouteContext {
  return {
    request,
    url: new URL(request.url),
    resourceUrl: request.url,
    actor: requestIdentity.actor === null
      ? null
      : {
          userId: requestIdentity.actor,
          email: "private-account@example.test",
          displayName: "Private participant",
        },
    isOwner: requestIdentity.owner,
    participantAccess: requestIdentity.access,
    campaign: syntheticPublicCampaign,
    renderApplication: async () => {
      throw new Error("The acknowledgment route owns this resource.");
    },
  };
}

function identity(
  actor: ActorSubject | null,
  access: AuthorizedParticipantAccess | null,
  owner = false,
): Identity {
  return Object.freeze({ actor, access, owner });
}

function participantAccess(
  actorSubject: ActorSubject,
  version: PackageVersion,
  acceptanceRequired: boolean,
): AuthorizedParticipantAccess {
  return Object.freeze({
    subject: actorSubject,
    email: "private-account@example.test",
    displayName: "Private participant",
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

function getRequest(
  actorSubject: ActorSubject | null,
  accept: string,
  query = "",
): Request {
  return new Request(
    `${APP_ORIGIN}${PARTICIPANT_PACKAGE_ACKNOWLEDGMENT_PATH}${query}`,
    {
      headers: {
        accept,
        ...(actorSubject
          ? { "x-test-session-subject": actorSubject as string }
          : {}),
      },
    },
  );
}

function jsonMutation(
  actorSubject: ActorSubject,
  operationId: string,
  extra: Readonly<Record<string, unknown>> = {},
  overrides: Readonly<{
    origin?: string;
    csrf?: string;
    sessionType?: "participant" | "owner";
  }> = {},
): Request {
  return new Request(`${APP_ORIGIN}${PARTICIPANT_PACKAGE_ACKNOWLEDGMENT_PATH}`, {
    method: "POST",
    headers: {
      accept: mediaType(),
      "content-type": "application/json",
      origin: overrides.origin ?? APP_ORIGIN,
      "x-test-session-subject": actorSubject,
      ...(overrides.sessionType
        ? { "x-test-session-type": overrides.sessionType }
        : {}),
      [MUTATION_CSRF_HEADER]: overrides.csrf ?? CSRF_TOKEN,
    },
    body: JSON.stringify({ "operation-id": operationId, ...extra }),
  });
}

function formMutation(
  actorSubject: ActorSubject,
  entries: readonly (readonly [string, string])[],
): Request {
  const body = new URLSearchParams();
  for (const [name, value] of entries) body.append(name, value);
  return new Request(`${APP_ORIGIN}${PARTICIPANT_PACKAGE_ACKNOWLEDGMENT_PATH}`, {
    method: "POST",
    headers: {
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
      origin: APP_ORIGIN,
      "x-test-session-subject": actorSubject,
    },
    body,
  });
}

type PackageFixtureInput = Readonly<{
  id: string;
  createdAt: string;
  materialChange: boolean;
  changeSummary: string;
  acknowledgmentText: string;
}>;

function packageDraft(input: PackageFixtureInput) {
  return {
    id: input.id,
    createdAt: input.createdAt,
    materialChange: input.materialChange,
    changeSummary: input.changeSummary,
    acknowledgmentText: input.acknowledgmentText,
    sections: [{
      id: `package-section:${input.id}`,
      order: 0,
      title: "Private package section",
      markdown: "PRIVATE SECTION body that must not enter acknowledgment output.",
      enabled: true,
    }],
  };
}

async function packageVersionFixture(
  input: PackageFixtureInput,
): Promise<PackageVersion> {
  const parsed = await createPackageVersion(packageDraft(input));
  assert(parsed.ok);
  return parsed.value;
}

function fixedPackageRepository(
  version: PackageVersion,
): Pick<PackageVersionRepository, "current"> {
  return {
    async current() {
      return { revision: 1, snapshot: version };
    },
  };
}

function inertAcknowledgments(): Pick<
  AcknowledgmentRepository,
  "get" | "latest" | "record"
> {
  return {
    async get() {
      return null;
    },
    async latest() {
      return null;
    },
    async record() {
      throw new Error("Unexpected acknowledgment mutation.");
    },
  };
}

function mutationSession(
  actorSubject: ActorSubject,
  csrfHash: Awaited<ReturnType<typeof hashCsrfToken>>,
  type: "participant" | "owner",
): TrustedMutationSession {
  return Object.freeze({
    actor: Object.freeze({ type, subject: actorSubject }),
    expiresAt: timestamp("2026-08-09T15:00:00.000Z"),
    csrf: Object.freeze({
      tokenHash: csrfHash,
      expiresAt: timestamp("2026-08-09T14:30:00.000Z"),
    }),
  });
}

function acknowledgmentForm(html: string): Readonly<{
  action: string;
  name: string;
  fields: readonly string[];
  values: ReadonlyMap<string, string>;
}> {
  const form = /<form action="([^"]+)" data-action-name="([^"]+)"[\s\S]*?<\/form>/u
    .exec(html);
  assert(form?.[0]);
  const inputs = [...form[0].matchAll(
    /<input name="([^"]+)" type="hidden" value="([^"]*)">/gu,
  )];
  return Object.freeze({
    action: form[1] ?? "",
    name: form[2] ?? "",
    fields: Object.freeze(inputs.map((input) => input[1] ?? "")),
    values: new Map(inputs.map((input) => [input[1] ?? "", input[2] ?? ""])),
  });
}

async function jsonDocument(response: Response): Promise<Record<string, unknown>> {
  return dataOf(await response.json());
}

function dataOf(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function resourceData(document: Record<string, unknown>): Record<string, unknown> {
  return dataOf(document.data);
}

function actionsOf(document: Record<string, unknown>): Record<string, unknown>[] {
  assert(Array.isArray(document.actions));
  return document.actions.map(dataOf);
}

function actionNames(document: Record<string, unknown>): string[] {
  return actionsOf(document).map((action) => String(action.name));
}

function fieldsOf(action: Record<string, unknown>): Record<string, unknown>[] {
  assert(Array.isArray(action.fields));
  return action.fields.map(dataOf);
}

function operationIdFrom(document: Record<string, unknown>): string {
  const action = actionsOf(document).find(
    (candidate) => candidate.name === "acknowledge-current-package",
  );
  assert(action);
  const operation = fieldsOf(action).find(
    (field) => field.name === "operation-id",
  );
  assert(operation);
  const value = operation.value;
  if (typeof value !== "string") assert.fail("Missing operation ID value.");
  return value;
}

function mediaType(): string {
  return `${INVESTOR_APP_MEDIA_TYPE}; version=${INVESTOR_APP_API_VERSION}`;
}

function subject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  assert(parsed.ok);
  return parsed.value;
}

function timestamp(value: string): Timestamp {
  const parsed = parseTimestamp(value);
  assert(parsed.ok);
  return parsed.value;
}

function storageOperationId(value: string) {
  const parsed = parseStorageOperationId(value);
  assert(parsed.ok);
  return parsed.value;
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function assertPrivateFailure(body: string): void {
  assert.doesNotMatch(
    body,
    /PRIVATE|persistence detail|participant:alice|participant:bob|sha256/u,
  );
}
