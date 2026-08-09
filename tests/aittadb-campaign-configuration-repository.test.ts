import assert from "node:assert/strict";
import test from "node:test";

import {
  StorageFailure,
  toPublicStorageFailure,
} from "../domain/storage-adapter.ts";
import {
  AittaDBCampaignConfigurationRepository,
  type AittaDBFetch,
} from "../repositories/aittadb-campaign-configuration-repository.ts";
import {
  FIRST_CAMPAIGN_SAVE,
  SECOND_CAMPAIGN_SAVE,
  campaignSaveRequest,
  captureStorageFailure,
  explicitCampaignSetup,
  verifyCampaignRepositoryContract,
} from "./support/campaign-repository-contract.ts";

const ISSUER = "https://db.runtime.example";
const RECORD_KEY = "investor-app/campaign-configuration";
const OWNER_TOKEN = "owner-access-token";
const OUTSIDER_TOKEN = "outsider-access-token";

test("AittaDB repository passes the shared campaign repository contract", async () => {
  await verifyCampaignRepositoryContract(() => {
    const service = new DeterministicAittaDBService();
    return {
      owner: repository(service, OWNER_TOKEN),
      outsider: repository(service, OUTSIDER_TOKEN),
      reopenOwner: () => repository(service, OWNER_TOKEN),
    };
  });
});

test("conditional HTTP writes use the configured issuer, key, and strong validators", async () => {
  const service = new DeterministicAittaDBService();
  const owner = repository(service, OWNER_TOKEN);

  await owner.saveSetup(campaignSaveRequest({
    operationId: "campaign-operation:http-create",
    recordedAt: FIRST_CAMPAIGN_SAVE,
    expectedRevision: null,
    setup: explicitCampaignSetup(),
  }));
  await owner.saveSetup(campaignSaveRequest({
    operationId: "campaign-operation:http-update",
    recordedAt: SECOND_CAMPAIGN_SAVE,
    expectedRevision: 1,
    setup: explicitCampaignSetup({ campaignName: "Configured Runtime" }),
  }));

  assert.equal(service.openApiCalls, 1);
  assert.equal(service.putCalls.length, 2);
  assert.deepEqual(service.putCalls.map((call) => ({
    url: call.url,
    authorization: call.headers.get("authorization"),
    ifMatch: call.headers.get("if-match"),
    ifNoneMatch: call.headers.get("if-none-match"),
  })), [
    {
      url: `${ISSUER}/storage/records/investor-app%2Fcampaign-configuration`,
      authorization: `Bearer ${OWNER_TOKEN}`,
      ifMatch: null,
      ifNoneMatch: "*",
    },
    {
      url: `${ISSUER}/storage/records/investor-app%2Fcampaign-configuration`,
      authorization: `Bearer ${OWNER_TOKEN}`,
      ifMatch: '"record-1"',
      ifNoneMatch: null,
    },
  ]);

  service.conflictNextPut = true;
  const conflict = await captureStorageFailure(() => owner.saveSetup(
    campaignSaveRequest({
      operationId: "campaign-operation:http-race",
      recordedAt: SECOND_CAMPAIGN_SAVE,
      expectedRevision: 2,
      setup: explicitCampaignSetup({ campaignName: "Concurrent Writer" }),
    }),
  ));
  assert.equal(conflict.code, "PRECONDITION_FAILED");
  assert.equal((await owner.readSetup())?.setup.publicCampaign.name, "Configured Runtime");
});

test("an AittaDB API without atomic preconditions fails before mutation", async () => {
  const service = new DeterministicAittaDBService({
    advertiseConditionalWrites: false,
  });
  let tokenCalls = 0;
  const owner = new AittaDBCampaignConfigurationRepository({
    issuer: ISSUER,
    recordKey: RECORD_KEY,
    accessToken: () => {
      tokenCalls += 1;
      return OWNER_TOKEN;
    },
    fetch: service.fetch,
  });

  const failure = await captureStorageFailure(() => owner.saveSetup(
    campaignSaveRequest({
      operationId: "campaign-operation:unsupported",
      recordedAt: FIRST_CAMPAIGN_SAVE,
      expectedRevision: null,
      setup: explicitCampaignSetup(),
    }),
  ));
  assert.equal(failure.code, "UNAVAILABLE");
  assert.equal(service.openApiCalls, 1);
  assert.equal(service.putCalls.length, 0);
  assert.equal(tokenCalls, 0);
});

test("payload and authorization failures are bounded and non-disclosing", async () => {
  const boundedService = new DeterministicAittaDBService();
  const bounded = repository(boundedService, OWNER_TOKEN, 512);
  const tooLarge = await captureStorageFailure(() => bounded.saveSetup(
    campaignSaveRequest({
      operationId: "campaign-operation:bounded",
      recordedAt: FIRST_CAMPAIGN_SAVE,
      expectedRevision: null,
      setup: explicitCampaignSetup(),
    }),
  ));
  assert.equal(tooLarge.code, "INVALID_REQUEST");
  assert.equal(boundedService.putCalls.length, 0);

  const existingService = new DeterministicAittaDBService();
  await repository(existingService, OWNER_TOKEN).saveSetup(campaignSaveRequest({
    operationId: "campaign-operation:private",
    recordedAt: FIRST_CAMPAIGN_SAVE,
    expectedRevision: null,
    setup: explicitCampaignSetup({ campaignName: "Private Campaign Name" }),
  }));
  const missingService = new DeterministicAittaDBService();
  const deniedExisting = await captureStorageFailure(() =>
    repository(existingService, OUTSIDER_TOKEN).saveSetup(campaignSaveRequest({
      operationId: "campaign-operation:denied-existing",
      recordedAt: SECOND_CAMPAIGN_SAVE,
      expectedRevision: 1,
      setup: explicitCampaignSetup({ campaignName: "Never Visible" }),
    })),
  );
  const deniedMissing = await captureStorageFailure(() =>
    repository(missingService, OUTSIDER_TOKEN).saveSetup(campaignSaveRequest({
      operationId: "campaign-operation:denied-missing",
      recordedAt: SECOND_CAMPAIGN_SAVE,
      expectedRevision: 1,
      setup: explicitCampaignSetup({ campaignName: "Never Visible" }),
    })),
  );
  assert.deepEqual(
    toPublicStorageFailure(deniedExisting),
    toPublicStorageFailure(deniedMissing),
  );
  const serializedFailure = JSON.stringify(toPublicStorageFailure(deniedExisting));
  assert.equal(serializedFailure.includes("Private Campaign Name"), false);
  assert.equal(serializedFailure.includes("Never Visible"), false);
  assert.equal(serializedFailure.includes(OUTSIDER_TOKEN), false);
});

function repository(
  service: DeterministicAittaDBService,
  token: string,
  maxRecordBytes?: number,
): AittaDBCampaignConfigurationRepository {
  return new AittaDBCampaignConfigurationRepository({
    issuer: ISSUER,
    recordKey: RECORD_KEY,
    accessToken: () => token,
    fetch: service.fetch,
    ...(maxRecordBytes === undefined ? {} : { maxRecordBytes }),
  });
}

type RecordedPut = Readonly<{
  url: string;
  headers: Headers;
}>;

class DeterministicAittaDBService {
  readonly fetch: AittaDBFetch;
  readonly putCalls: RecordedPut[] = [];
  openApiCalls = 0;
  conflictNextPut = false;

  private readonly advertiseConditionalWrites: boolean;
  private stored: unknown = null;
  private etag: string | null = null;
  private writeRevision = 0;

  constructor(
    options: Readonly<{ advertiseConditionalWrites?: boolean }> = {},
  ) {
    this.advertiseConditionalWrites =
      options.advertiseConditionalWrites ?? true;
    this.fetch = async (input, init = {}) => this.handle(input, init);
  }

  private async handle(
    input: string | URL | Request,
    init: RequestInit,
  ): Promise<Response> {
    const url = new URL(
      typeof input === "string" || input instanceof URL
        ? input.toString()
        : input.url,
    );
    const method = (init.method ?? "GET").toUpperCase();
    if (url.origin !== ISSUER) return response(404, { error: "not_found" });
    if (url.pathname === "/openapi.json" && method === "GET") {
      this.openApiCalls += 1;
      return response(200, openApiDocument(this.advertiseConditionalWrites));
    }
    if (
      url.pathname !==
        "/storage/records/investor-app%2Fcampaign-configuration" &&
      decodeURIComponent(url.pathname) !==
        "/storage/records/investor-app/campaign-configuration"
    ) {
      return response(404, { error: "not_found" });
    }

    const headers = new Headers(init.headers);
    const permitted = headers.get("authorization") === `Bearer ${OWNER_TOKEN}`;
    if (!permitted) return response(403, { error: "not_found" });

    if (method === "GET") {
      if (this.stored === null || this.etag === null) {
        return response(404, { error: "not_found" });
      }
      return recordResponse(this.stored, this.etag, this.writeRevision);
    }
    if (method !== "PUT") return response(405, { error: "method_not_allowed" });

    this.putCalls.push({ url: url.toString(), headers: new Headers(headers) });
    if (this.conflictNextPut) {
      this.conflictNextPut = false;
      this.writeRevision += 1;
      this.etag = `"record-${this.writeRevision}"`;
      return response(412, { error: "precondition_failed" });
    }
    const preconditionMatches = this.stored === null
      ? headers.get("if-none-match") === "*" &&
        headers.get("if-match") === null
      : headers.get("if-match") === this.etag &&
        headers.get("if-none-match") === null;
    if (!preconditionMatches) {
      return response(412, { error: "precondition_failed" });
    }
    if (typeof init.body !== "string") {
      return response(400, { error: "invalid_request" });
    }
    try {
      this.stored = JSON.parse(init.body) as unknown;
    } catch {
      return response(400, { error: "invalid_request" });
    }
    this.writeRevision += 1;
    this.etag = `"record-${this.writeRevision}"`;
    return recordResponse(this.stored, this.etag, this.writeRevision);
  }
}

function openApiDocument(advertiseConditionalWrites: boolean): unknown {
  const etagResponse = {
    description: "Stored record",
    headers: { ETag: { schema: { type: "string" } } },
  };
  return {
    openapi: "3.1.0",
    paths: {
      "/storage/records/{key}": {
        get: {
          responses: {
            "200": etagResponse,
            "404": { description: "Not found" },
          },
        },
        put: advertiseConditionalWrites
          ? {
            parameters: [
              { name: "If-Match", in: "header", schema: { type: "string" } },
              {
                name: "If-None-Match",
                in: "header",
                schema: { type: "string" },
              },
            ],
            responses: {
              "200": etagResponse,
              "412": { description: "Precondition failed" },
            },
          }
          : {
            parameters: [],
            responses: { "200": { description: "Stored record" } },
          },
      },
    },
  };
}

function recordResponse(
  value: unknown,
  etag: string,
  revision: number,
): Response {
  return response(200, {
    api_version: "0.1",
    type: "storage-record",
    id: RECORD_KEY,
    data: {
      key: RECORD_KEY,
      value,
      created_at: 1,
      updated_at: revision,
    },
    links: [],
    actions: [],
  }, { ETag: etag });
}

function response(
  status: number,
  value: unknown,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": AITTADB_RESPONSE_TYPE,
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

const AITTADB_RESPONSE_TYPE =
  "application/vnd.aittadb+json; version=0.1";

test("constructor rejects malformed deployment boundaries", () => {
  const invalid = [
    "https://db.runtime.example/path",
    "https://user@db.runtime.example/",
    "file:///tmp/database",
  ];
  for (const issuer of invalid) {
    assert.throws(
      () => new AittaDBCampaignConfigurationRepository({
        issuer,
        recordKey: RECORD_KEY,
        accessToken: () => OWNER_TOKEN,
        fetch: async () => response(500, {}),
      }),
      (error: unknown) =>
        error instanceof StorageFailure && error.code === "INVALID_REQUEST",
    );
  }
});
