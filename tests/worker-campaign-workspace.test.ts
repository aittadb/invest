import assert from "node:assert/strict";
import test from "node:test";

import { parseActorSubject, parseTimestamp } from "../domain/foundation.ts";
import type { ActionJsonValue } from "../domain/hypermedia-action.ts";
import {
  MUTATION_CSRF_HEADER,
  createBrowserMutationGuard,
  hashCsrfToken,
  type BrowserMutationGuardOptions,
} from "../http/mutation-security.ts";
import type { BrowserMutationVerificationLimits } from "../http/browser-mutation-session.ts";
import { OWNER_CAMPAIGN_EDITOR_CAPABILITY_HEADER } from "../http/runtime-capabilities.ts";
import {
  DevelopmentInMemoryCampaignRepository,
  DevelopmentInMemoryPublicCampaignPresentationReader,
  type AtomicCampaignAuditRepository,
} from "../repositories/in-memory-campaign-repository.ts";
import { createApplicationWorker } from "../worker/application-worker.ts";
import type { InvestorAppEnv, WorkerExecutionContext } from "../worker/contracts.ts";
import type { CampaignWorkspaceDeploymentCapability } from "../worker/deployment-capabilities.ts";
import { syntheticPublicCampaign } from "./fixtures/public-campaign.ts";
import { explicitCampaignSetup } from "./support/campaign-repository-contract.ts";
import { MemoryStorageAdapter } from "./support/memory-storage-adapter.ts";

const ORIGIN = "https://campaign.example";
const OWNER_EMAIL = "owner@example.com";
const OWNER_SUBJECT = "owner-subject";
const CSRF_TOKEN = "worker_campaign_csrf_token_1234567890";
const executionContext: WorkerExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

test("normal worker composition reaches publish and unpublish only through explicit dependency injection", async () => {
  const storage = new MemoryStorageAdapter();
  const repository = new DevelopmentInMemoryCampaignRepository(storage);
  await repository.saveSetup({
    operationId: "campaign-operation:worker-seed",
    recordedAt: "2026-08-09T08:00:00.000Z",
    expectedRevision: null,
    setup: {
      ...explicitCampaignSetup(),
      publicCampaign: { ...syntheticPublicCampaign, published: false },
    },
  });
  const privileged = new CountingCampaignRepository(repository);
  const workspace = await campaignWorkspace(
    privileged,
    new DevelopmentInMemoryPublicCampaignPresentationReader(storage),
  );
  const renderedRequests: Request[] = [];
  const baseDependencies = {
    fetchApplication: async (request: Request) => {
      renderedRequests.push(request);
      return new Response("rendered");
    },
    fetchOptimizedImage: async () => new Response("image"),
  } as const;
  const productionShapeWorker = createApplicationWorker(baseDependencies);

  const scalarEnvironment = environment();
  const forgedFunctionEnvironment = {
    ...scalarEnvironment,
    CAMPAIGN_WORKSPACE: workspace,
  } as InvestorAppEnv;
  const absentOwner = await productionShapeWorker.fetch(
    request("/owner", { accept: "application/json", owner: true }),
    forgedFunctionEnvironment,
    executionContext,
  );
  assert.equal(
    (await absentOwner.json()).links.some((link: { rel: string[] }) =>
      link.rel.includes("campaign-editor")
    ),
    false,
  );
  await productionShapeWorker.fetch(
    request("/fallback", { owner: true }),
    forgedFunctionEnvironment,
    executionContext,
  );
  assert.equal(
    renderedRequests.at(-1)?.headers.get(OWNER_CAMPAIGN_EDITOR_CAPABILITY_HEADER),
    null,
  );

  const worker = createApplicationWorker({
    ...baseDependencies,
    resolveCampaignWorkspace: () => workspace,
  });
  const ownerHome = await worker.fetch(
    request("/owner", { accept: "application/json", owner: true }),
    scalarEnvironment,
    executionContext,
  );
  assert.equal(
    (await ownerHome.json()).links.some((link: { rel: string[] }) =>
      link.rel.includes("campaign-editor")
    ),
    true,
  );
  await worker.fetch(
    request("/fallback", { owner: true }),
    scalarEnvironment,
    executionContext,
  );
  assert.equal(
    renderedRequests.at(-1)?.headers.get(OWNER_CAMPAIGN_EDITOR_CAPABILITY_HEADER),
    "available",
  );

  const beforePublicReads = privileged.readCount;
  const draft = await worker.fetch(
    request("/", { accept: "application/json" }),
    scalarEnvironment,
    executionContext,
  );
  assert.equal((await draft.json()).data.published, false);
  assert.equal(privileged.readCount, beforePublicReads);

  const editor = await worker.fetch(
    request("/owner/campaign", { accept: "application/json", owner: true }),
    scalarEnvironment,
    executionContext,
  );
  const publish = requiredAction(await editor.json(), "publish-campaign");
  const published = await worker.fetch(
    mutationRequest("/owner/campaign/publication", actionCommand(publish)),
    scalarEnvironment,
    executionContext,
  );
  assert.equal(published.status, 200);
  assert.equal((await published.json()).data.publication, "published");

  const afterPublishOwnerReads = privileged.readCount;
  const publicCampaign = await worker.fetch(
    request("/", { accept: "application/json" }),
    scalarEnvironment,
    executionContext,
  );
  const publicDocument = await publicCampaign.json();
  assert.equal(publicDocument.data.published, true);
  assert.equal(publicDocument.data.name, syntheticPublicCampaign.name);
  assert.equal(privileged.readCount, afterPublishOwnerReads);

  const publishedEditor = await worker.fetch(
    request("/owner/campaign", { accept: "application/json", owner: true }),
    scalarEnvironment,
    executionContext,
  );
  const unpublish = requiredAction(await publishedEditor.json(), "unpublish-campaign");
  const unpublished = await worker.fetch(
    mutationRequest("/owner/campaign/publication", actionCommand(unpublish)),
    scalarEnvironment,
    executionContext,
  );
  assert.equal(unpublished.status, 200);
  assert.equal((await unpublished.json()).data.publication, "unpublished");

  const afterUnpublishOwnerReads = privileged.readCount;
  const hiddenAgain = await worker.fetch(
    request("/", { accept: "application/json" }),
    scalarEnvironment,
    executionContext,
  );
  assert.equal((await hiddenAgain.json()).data.published, false);
  assert.equal(privileged.readCount, afterUnpublishOwnerReads);
});

async function campaignWorkspace(
  repository: AtomicCampaignAuditRepository,
  publicReader: DevelopmentInMemoryPublicCampaignPresentationReader,
): Promise<CampaignWorkspaceDeploymentCapability> {
  const tokenHash = await hashCsrfToken(CSRF_TOKEN);
  const subject = parseActorSubject(OWNER_SUBJECT);
  const expiresAt = parseTimestamp("2026-08-09T14:00:00.000Z");
  assert(subject.ok);
  assert(expiresAt.ok);
  let sequence = 0;
  return {
    repository,
    publicReader,
    checkPublicationReadiness: async () => true,
    mutationSession: mutationSession({
      allowedOrigins: [ORIGIN],
      maxBodyBytes: 1_048_576,
      maxFields: 256,
      now: () => new Date("2026-08-09T12:00:00.000Z"),
      resolveSession: async () => ({
        actor: { type: "owner", subject: subject.value },
        expiresAt: expiresAt.value,
        csrf: { tokenHash, expiresAt: expiresAt.value },
      }),
    }),
    appOrigin: ORIGIN,
    issueOperationId: (kind) => `campaign-${kind}:worker-${++sequence}`,
    now: () => new Date(`2026-08-09T12:00:${String(sequence).padStart(2, "0")}.000Z`),
  };
}

function mutationSession(
  options: BrowserMutationGuardOptions,
) {
  const expiresAt = parseTimestamp("2026-08-09T14:00:00.000Z");
  assert(expiresAt.ok);
  return Object.freeze({
    async issue() {
      return Object.freeze({
        token: CSRF_TOKEN,
        expiresAt: expiresAt.value,
        setCookie: "__Host-test_worker=proof; Path=/; Secure; HttpOnly; SameSite=Lax",
      });
    },
    async issueExactReplay() {
      return Object.freeze({
        token: CSRF_TOKEN,
        expiresAt: expiresAt.value,
        setCookie: "__Host-test_worker=proof; Path=/; Secure; HttpOnly; SameSite=Lax",
      });
    },
    async verifyMutation(
      request: Request,
      _identity: unknown,
      _appOrigin: string,
      limits?: BrowserMutationVerificationLimits,
    ) {
      const guard = createBrowserMutationGuard({
        ...options,
        ...(limits === undefined
          ? {}
          : {
              maxBodyBytes: limits.maxBodyBytes,
              maxFields: limits.maxFields,
              ...(limits.repeatedFormFields === undefined
                ? {}
                : { repeatedFormFields: limits.repeatedFormFields }),
            }),
      });
      return Object.freeze({
        ...await guard(request),
        clearCookie: "__Host-test_worker=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax",
      });
    },
  });
}

function request(
  pathname: string,
  options: Readonly<{ accept?: string; owner?: boolean }> = {},
): Request {
  return new Request(`${ORIGIN}${pathname}`, {
    headers: {
      ...(options.accept ? { Accept: options.accept } : {}),
      ...(options.owner
        ? {
            "oai-authenticated-user-id": OWNER_SUBJECT,
            "oai-authenticated-user-email": OWNER_EMAIL,
          }
        : {}),
    },
  });
}

function mutationRequest(pathname: string, body: unknown): Request {
  return new Request(`${ORIGIN}${pathname}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: ORIGIN,
      [MUTATION_CSRF_HEADER]: CSRF_TOKEN,
      "oai-authenticated-user-id": OWNER_SUBJECT,
      "oai-authenticated-user-email": OWNER_EMAIL,
    },
    body: JSON.stringify(body),
  });
}

function requiredAction(
  document: { actions: readonly Readonly<{ name: string; fields: readonly Readonly<{ name: string; value?: ActionJsonValue; default?: ActionJsonValue }>[] }>[] },
  name: string,
) {
  const action = document.actions.find((candidate) => candidate.name === name);
  assert.ok(action);
  return action;
}

function actionCommand(action: ReturnType<typeof requiredAction>): Record<string, unknown> {
  return Object.fromEntries(action.fields.map((field) => {
    const value = field.value ?? field.default;
    assert.notEqual(value, undefined);
    return [field.name, value];
  }));
}

function environment(): InvestorAppEnv {
  return {
    APP_BASE_URL: ORIGIN,
    OWNER_EMAIL,
    ASSETS: { fetch: async () => new Response("asset") },
    IMAGES: {
      input() {
        throw new Error("Image optimization is outside this test.");
      },
    },
  };
}

class CountingCampaignRepository implements AtomicCampaignAuditRepository {
  readonly mutationConsistency = "atomic-campaign-audit" as const;
  private readonly repository: AtomicCampaignAuditRepository;
  readCount = 0;

  constructor(repository: AtomicCampaignAuditRepository) {
    this.repository = repository;
  }

  async readSetup() {
    this.readCount += 1;
    return this.repository.readSetup();
  }

  findSetupByOperationId(operationId: unknown) {
    return this.repository.findSetupByOperationId(operationId);
  }

  saveSetup(request: Parameters<AtomicCampaignAuditRepository["saveSetup"]>[0]) {
    return this.repository.saveSetup(request);
  }

  listSetupHistory(
    request: Parameters<AtomicCampaignAuditRepository["listSetupHistory"]>[0],
  ) {
    return this.repository.listSetupHistory(request);
  }

  saveSetupWithAudit(
    request: Parameters<AtomicCampaignAuditRepository["saveSetupWithAudit"]>[0],
  ) {
    return this.repository.saveSetupWithAudit(request);
  }
}
