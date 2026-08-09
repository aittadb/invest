import assert from "node:assert/strict";
import test from "node:test";

import {
  StorageFailure,
  assertStorageListBoundary,
  assertStorageTransactionBoundary,
  storageKeyString,
  toPublicStorageFailure,
  type StorageAdapter,
  type StorageCursor,
  type StorageDocument,
  type StorageKey,
  type StoragePage,
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import {
  DevelopmentInMemoryCampaignRepository,
  parseCampaignSetup,
  type CampaignRepository,
} from "../repositories/in-memory-campaign-repository.ts";
import { syntheticPublicCampaign } from "./fixtures/public-campaign.ts";

const FIRST_SAVE = "2026-08-09T08:00:00.000Z";
const SECOND_SAVE = "2026-08-09T09:00:00.000Z";

export type CampaignRepositoryContractFixture = Readonly<{
  owner: CampaignRepository;
  outsider: CampaignRepository;
  reopenOwner: () => CampaignRepository;
}>;

export type CampaignRepositoryContractFactory =
  () => CampaignRepositoryContractFixture;

/** Reusable behavior contract for development and production campaign repositories. */
export async function verifyCampaignRepositoryContract(
  createFixture: CampaignRepositoryContractFactory,
): Promise<void> {
  const fixture = createFixture();
  assert.equal(await fixture.owner.readSetup(), null);
  assert.deepEqual(await fixture.owner.listSetupHistory({ limit: 10 }), {
    items: [],
    nextCursor: null,
  });

  const create = saveRequest({
    operationId: "campaign-operation:create",
    recordedAt: FIRST_SAVE,
    expectedRevision: null,
    setup: explicitSetup(),
  });
  const first = await fixture.owner.saveSetup(create);
  assert.equal(first.revision, 1);
  assert.equal(first.setup.publicCampaign.name, syntheticPublicCampaign.name);

  const replay = await fixture.owner.saveSetup(create);
  assert.deepEqual(replay, first);

  const reopened = fixture.reopenOwner();
  assert.deepEqual(await reopened.readSetup(), first);

  const second = await fixture.owner.saveSetup(saveRequest({
    operationId: "campaign-operation:update",
    recordedAt: SECOND_SAVE,
    expectedRevision: 1,
    setup: explicitSetup({ campaignName: "Northstar Systems" }),
  }));
  assert.equal(second.revision, 2);

  const stale = await captureStorageFailure(() => fixture.owner.saveSetup(
    saveRequest({
      operationId: "campaign-operation:stale",
      recordedAt: SECOND_SAVE,
      expectedRevision: 1,
      setup: explicitSetup({ campaignName: "Stale Campaign Name" }),
    }),
  ));
  assert.equal(stale.code, "PRECONDITION_FAILED");

  const firstPage = await reopened.listSetupHistory({ limit: 1 });
  assert.deepEqual(firstPage.items.map(({ revision }) => revision), [1]);
  assert.notEqual(firstPage.nextCursor, null);
  const secondPage = await reopened.listSetupHistory({
    limit: 1,
    ...(firstPage.nextCursor ? { cursor: firstPage.nextCursor } : {}),
  });
  assert.deepEqual(secondPage.items.map(({ revision }) => revision), [2]);
  assert.equal(secondPage.nextCursor, null);

  assert.equal(await fixture.outsider.readSetup(), null);
  assert.deepEqual(await fixture.outsider.listSetupHistory({ limit: 10 }), {
    items: [],
    nextCursor: null,
  });
}

test("adapter-backed development repository passes the campaign contract", async () => {
  await verifyCampaignRepositoryContract(() => {
    const state = new MemoryStorageState();
    const ownerStorage = new DeterministicMemoryStorageAdapter(state, true);
    return {
      owner: new DevelopmentInMemoryCampaignRepository(ownerStorage),
      outsider: new DevelopmentInMemoryCampaignRepository(
        new DeterministicMemoryStorageAdapter(state, false),
      ),
      reopenOwner: () => new DevelopmentInMemoryCampaignRepository(ownerStorage),
    };
  });
});

test("setup parsing requires every deployment choice and supplies no defaults", async () => {
  const missing = parseCampaignSetup({});
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.deepEqual(missing.issues, [
    { code: "required", path: "setup.publicCampaign" },
    { code: "required", path: "setup.phases" },
    { code: "required", path: "setup.amountAggregate" },
  ]);

  const noPhase = parseCampaignSetup({
    ...explicitSetup(),
    phases: [],
  });
  assert.deepEqual(noPhase, {
    ok: false,
    issues: [{ code: "out_of_range", path: "setup.phases" }],
  });

  const parsed = parseCampaignSetup(explicitSetup());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.publicCampaign.id, syntheticPublicCampaign.id);
  assert.deepEqual(parsed.value.phases[0]?.enabledParticipationPaths, [
    "founder",
    "investor",
  ]);
  assert.deepEqual(parsed.value.phases[0]?.countryEligibility, {
    mode: "allow",
    countries: ["FI", "SE"],
  });
  assert.equal(parsed.value.amountAggregate.amount.currency, "SEK");
  assert.equal(parsed.value.amountAggregate.publicAggregate.visibility, "non_zero");

  const state = new MemoryStorageState();
  const repository = new DevelopmentInMemoryCampaignRepository(
    new DeterministicMemoryStorageAdapter(state, true),
  );
  assert.equal(repository.storageKind, "development-in-memory");
  const error = await captureStorageFailure(() => repository.saveSetup(
    saveRequest({
      operationId: "campaign-operation:invalid",
      recordedAt: FIRST_SAVE,
      expectedRevision: null,
      setup: {},
    }),
  ));
  assert.equal(error.code, "INVALID_REQUEST");
  assert.equal(state.transactionCalls, 0);
  assert.equal(await repository.readSetup(), null);
});

test("setup revisions and their adapter records remain immutable", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state, true);
  const repository = new DevelopmentInMemoryCampaignRepository(adapter);

  const first = await repository.saveSetup(saveRequest({
    operationId: "campaign-operation:immutable-create",
    recordedAt: FIRST_SAVE,
    expectedRevision: null,
    setup: explicitSetup(),
  }));
  const second = await repository.saveSetup(saveRequest({
    operationId: "campaign-operation:immutable-update",
    recordedAt: SECOND_SAVE,
    expectedRevision: 1,
    setup: explicitSetup({
      campaignName: "Northstar Systems",
      phaseState: "closed",
    }),
  }));

  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.setup), true);
  assert.equal(Object.isFrozen(first.setup.phases), true);
  assert.equal(Object.isFrozen(first.setup.phases[0]?.countryEligibility), true);
  assert.equal(first.setup.publicCampaign.name, syntheticPublicCampaign.name);
  assert.equal(second.setup.publicCampaign.name, "Northstar Systems");

  const history = await repository.listSetupHistory({ limit: 10 });
  assert.deepEqual(history.items.map((item) => ({
    revision: item.revision,
    name: item.setup.publicCampaign.name,
    state: item.setup.phases[0]?.state,
  })), [
    { revision: 1, name: syntheticPublicCampaign.name, state: "open" },
    { revision: 2, name: "Northstar Systems", state: "closed" },
  ]);
  assert.equal(Object.isFrozen(history), true);
  assert.equal(Object.isFrozen(history.items), true);
  assert.equal(state.records.size, 3);

  const reopened = new DevelopmentInMemoryCampaignRepository(adapter);
  assert.deepEqual(await reopened.readSetup(), second);
  assert.equal(state.readCalls > 0, true);
  assert.equal(state.listCalls > 0, true);
});

test("operation IDs are retry-stable and cannot be reused for changed setup", async () => {
  const state = new MemoryStorageState();
  const repository = new DevelopmentInMemoryCampaignRepository(
    new DeterministicMemoryStorageAdapter(state, true),
  );
  const request = saveRequest({
    operationId: "campaign-operation:retry",
    recordedAt: FIRST_SAVE,
    expectedRevision: null,
    setup: explicitSetup(),
  });

  const first = await repository.saveSetup(request);
  assert.deepEqual(await repository.saveSetup(request), first);
  const conflict = await captureStorageFailure(() => repository.saveSetup(
    saveRequest({
      ...request,
      setup: explicitSetup({ campaignName: "Changed Retry" }),
    }),
  ));
  assert.equal(conflict.code, "CONFLICT");
  assert.equal((await repository.listSetupHistory({ limit: 10 })).items.length, 1);
});

test("stale and inaccessible records fail without disclosing campaign data", async () => {
  const existingState = new MemoryStorageState();
  const owner = new DevelopmentInMemoryCampaignRepository(
    new DeterministicMemoryStorageAdapter(existingState, true),
  );
  await owner.saveSetup(saveRequest({
    operationId: "campaign-operation:private-create",
    recordedAt: FIRST_SAVE,
    expectedRevision: null,
    setup: explicitSetup(),
  }));
  await owner.saveSetup(saveRequest({
    operationId: "campaign-operation:private-update",
    recordedAt: SECOND_SAVE,
    expectedRevision: 1,
    setup: explicitSetup({ campaignName: "Private Current Name" }),
  }));

  const stale = await captureStorageFailure(() => owner.saveSetup(saveRequest({
    operationId: "campaign-operation:private-stale",
    recordedAt: SECOND_SAVE,
    expectedRevision: 1,
    setup: explicitSetup({ campaignName: "Private Stale Name" }),
  })));
  assert.equal(stale.code, "PRECONDITION_FAILED");
  assert.equal(stale.message.includes("Private"), false);

  const outsiderExisting = new DevelopmentInMemoryCampaignRepository(
    new DeterministicMemoryStorageAdapter(existingState, false),
  );
  const outsiderMissing = new DevelopmentInMemoryCampaignRepository(
    new DeterministicMemoryStorageAdapter(new MemoryStorageState(), false),
  );
  assert.equal(await outsiderExisting.readSetup(), null);
  assert.equal(await outsiderMissing.readSetup(), null);
  assert.deepEqual(await outsiderExisting.listSetupHistory({ limit: 10 }), {
    items: [],
    nextCursor: null,
  });

  const deniedExisting = await captureStorageFailure(() =>
    outsiderExisting.saveSetup(saveRequest({
      operationId: "campaign-operation:denied-existing",
      recordedAt: SECOND_SAVE,
      expectedRevision: 2,
      setup: explicitSetup({ campaignName: "Never Visible" }),
    })),
  );
  const deniedMissing = await captureStorageFailure(() =>
    outsiderMissing.saveSetup(saveRequest({
      operationId: "campaign-operation:denied-missing",
      recordedAt: SECOND_SAVE,
      expectedRevision: 2,
      setup: explicitSetup({ campaignName: "Never Visible" }),
    })),
  );
  assert.deepEqual(
    toPublicStorageFailure(deniedExisting),
    toPublicStorageFailure(deniedMissing),
  );
  const publicFailure = JSON.stringify(toPublicStorageFailure(deniedExisting));
  assert.equal(publicFailure.includes("Never Visible"), false);
  assert.equal(publicFailure.includes(syntheticPublicCampaign.id), false);
  assert.equal((await owner.readSetup())?.setup.publicCampaign.name, "Private Current Name");
  assert.equal((await owner.listSetupHistory({ limit: 10 })).items.length, 2);
});

type ExplicitSetupOptions = Readonly<{
  campaignName?: string;
  phaseState?: "closed" | "open";
}>;

function explicitSetup(options: ExplicitSetupOptions = {}) {
  return {
    publicCampaign: {
      ...syntheticPublicCampaign,
      name: options.campaignName ?? syntheticPublicCampaign.name,
    },
    phases: [
      {
        id: "phase:domestic",
        state: options.phaseState ?? "open",
        enabledParticipationPaths: ["investor", "founder"],
        countryEligibility: {
          mode: "allow",
          countries: ["se", "FI"],
        },
      },
    ],
    amountAggregate: {
      amount: {
        currency: "sek",
        minimum: 25_000,
        increment: 5_000,
        maximum: 500_000,
      },
      publicAggregate: {
        visibility: "non_zero",
        label: "Recorded non-binding interest",
        qualifier: "Self-declared, unverified, and non-binding.",
      },
    },
  };
}

function saveRequest(input: Readonly<{
  operationId: unknown;
  recordedAt: unknown;
  expectedRevision: number | null;
  setup: unknown;
}>) {
  return input;
}

async function captureStorageFailure(
  operation: () => Promise<unknown>,
): Promise<StorageFailure> {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof StorageFailure);
    return error;
  }
  assert.fail("Expected a StorageFailure.");
}

class MemoryStorageState {
  readonly records = new Map<string, StorageRecord>();
  readonly operations = new Map<
    string,
    Readonly<{ fingerprint: string; result: StorageTransactionResult }>
  >();
  readCalls = 0;
  listCalls = 0;
  transactionCalls = 0;
}

class DeterministicMemoryStorageAdapter implements StorageAdapter {
  private readonly state: MemoryStorageState;
  private readonly permitted: boolean;

  constructor(state: MemoryStorageState, permitted: boolean) {
    this.state = state;
    this.permitted = permitted;
  }

  async read(key: StorageKey): Promise<StorageRecord | null> {
    this.state.readCalls += 1;
    if (!this.permitted) return null;
    return cloneRecord(this.state.records.get(storageKeyString(key)) ?? null);
  }

  async list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    this.state.listCalls += 1;
    assertStorageListBoundary(request);
    if (!this.permitted) return { items: [], nextCursor: null };

    const start = request.cursor === undefined ? 0 : parseCursor(request.cursor);
    const all = [...this.state.records.values()]
      .filter((record) => record.key.collection === request.collection)
      .sort((left, right) => left.key.id.localeCompare(right.key.id));
    if (start < 0 || start > all.length) {
      throw new StorageFailure("INVALID_REQUEST");
    }

    const items = all.slice(start, start + request.limit).map(cloneRecord);
    const next = start + items.length;
    return {
      items: items.filter((item): item is StorageRecord => item !== null),
      nextCursor: next < all.length ? (`memory-cursor:${next}` as StorageCursor) : null,
    };
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    this.state.transactionCalls += 1;
    assertStorageTransactionBoundary(request);
    if (!this.permitted) throw new StorageFailure("NOT_FOUND");

    const operationKey = request.operationId as string;
    const fingerprint = JSON.stringify(request);
    const prior = this.state.operations.get(operationKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new StorageFailure("CONFLICT");
      return cloneResult(prior.result, true);
    }

    for (const mutation of request.mutations) {
      const current = this.state.records.get(storageKeyString(mutation.key));
      if (mutation.expectedRevision === null) {
        if (current) throw new StorageFailure("CONFLICT");
      } else if (!current || current.revision !== mutation.expectedRevision) {
        throw new StorageFailure("PRECONDITION_FAILED");
      }
    }

    const nextRecords = new Map(this.state.records);
    const resultRecords: (StorageRecord | null)[] = [];
    for (const mutation of request.mutations) {
      const key = storageKeyString(mutation.key);
      const current = nextRecords.get(key);
      if (mutation.type === "delete") {
        nextRecords.delete(key);
        resultRecords.push(null);
        continue;
      }

      const record = freezeRecord({
        key: mutation.key,
        revision: (current?.revision ?? 0) + 1,
        value: mutation.value,
      });
      nextRecords.set(key, record);
      resultRecords.push(record);
    }

    this.state.records.clear();
    for (const [key, record] of nextRecords) this.state.records.set(key, record);
    const result = Object.freeze({
      replayed: false,
      records: Object.freeze(resultRecords.map(cloneRecord)),
    });
    this.state.operations.set(operationKey, { fingerprint, result });
    return cloneResult(result, false);
  }
}

function parseCursor(cursor: StorageCursor): number {
  const match = /^memory-cursor:(\d+)$/.exec(cursor);
  if (!match) throw new StorageFailure("INVALID_REQUEST");
  return Number.parseInt(match[1], 10);
}

function cloneResult(
  result: StorageTransactionResult,
  replayed: boolean,
): StorageTransactionResult {
  return Object.freeze({
    replayed,
    records: Object.freeze(result.records.map(cloneRecord)),
  });
}

function cloneRecord(record: StorageRecord | null): StorageRecord | null {
  if (record === null) return null;
  return freezeRecord({
    key: record.key,
    revision: record.revision,
    value: record.value,
  });
}

function freezeRecord(input: Readonly<{
  key: StorageKey;
  revision: number;
  value: StorageDocument;
}>): StorageRecord {
  return Object.freeze({
    key: Object.freeze({ ...input.key }),
    revision: input.revision,
    value: deepFreeze(cloneDocument(input.value)),
  });
}

function cloneDocument(value: StorageDocument): StorageDocument {
  return JSON.parse(JSON.stringify(value)) as StorageDocument;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
