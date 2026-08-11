import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseAmountAggregateConfiguration,
  type AmountConfiguration,
} from "../domain/amount-aggregate-configuration.ts";
import {
  parseActorSubject,
  parseStableId,
  type ActorSubject,
} from "../domain/foundation.ts";
import type {
  InvestmentIndication,
  InvestmentIndicationId,
  TrustedPackageAcknowledgmentContext,
} from "../domain/investment-indication.ts";
import {
  createPackageAcceptance,
  createPackageVersion,
} from "../domain/package-content.ts";
import {
  StorageFailure,
  type StorageAdapter,
  type StorageDocument,
  type StorageKey,
  type StorageListRequest,
  type StoragePage,
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import {
  DevelopmentInMemoryIndicationRepository,
  MAX_OWNED_INVESTMENT_INDICATIONS,
  type ParticipantIndicationOwnershipEntry,
} from "../repositories/in-memory-indication-repository.ts";
import {
  StorageParticipantInvestmentInterestRepository,
} from "../repositories/storage-participant-investment-repository.ts";
import { executeLegacyInvestmentOwnershipMigrationCommand } from "../scripts/migrate-legacy-investment-ownership.ts";
import {
  MAX_LEGACY_INVESTMENT_OWNERSHIP_MIGRATION_MANIFEST_BYTES,
  MAX_LEGACY_INVESTMENT_OWNERSHIP_MIGRATION_SUBJECTS,
  parseLegacyInvestmentOwnershipMigrationInventory,
  runLegacyInvestmentOwnershipMigration,
} from "../services/legacy-investment-ownership-migration.ts";
import { MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS } from "../worker/participant-investment-mutation-port.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";
import { SyntheticAittaDBStorageService } from "./support/synthetic-aittadb-storage-service.ts";

const ALICE = actorSubject("issuer.invalid/subject:alice-ownership-migration");
const BOB = actorSubject("issuer.invalid/subject:bob-ownership-migration");
const OWNER = actorSubject("issuer.invalid/subject:ownership-migration-owner");
const AMOUNT = amountConfiguration();

test("ownership inventory is closed, sorted, bounded, and permits empty work", async () => {
  assert.deepEqual(
    parseLegacyInvestmentOwnershipMigrationInventory(manifest([])),
    { entries: [] },
  );
  const empty = await runLegacyInvestmentOwnershipMigration(
    new ThrowingStorageAdapter(),
    manifest([]),
  );
  assert.deepEqual(empty, {
    scanned: 0,
    initialized: 0,
    alreadyInitialized: 0,
    indications: 0,
  });
  assert.equal(Object.isFrozen(empty), true);

  const alice = inventoryEntry(ALICE, "alice", []);
  const bob = inventoryEntry(BOB, "bob", []);
  const one = ownershipEntry("investment-indication:inventory-one", 1, "active");
  const two = ownershipEntry("investment-indication:inventory-two", 2, "withdrawn");
  const malformed: unknown[] = [
    null,
    {},
    { ...manifest([]), extra: true },
    { schemaVersion: 2, participants: [] },
    manifest([alice, alice]),
    manifest([bob, alice]),
    manifest([{ ...alice, extra: true }]),
    manifest([{ ...alice, participantSubject: "" }]),
    manifest([alice, { ...bob, operationId: alice.operationId }]),
    manifest([{ ...alice, indications: [two, one] }]),
    manifest([{ ...alice, indications: [one, one] }]),
    manifest([{ ...alice, indications: [{ ...one, extra: true }] }]),
    manifest([{ ...alice, indications: [{ ...one, indicationRevision: 0 }] }]),
    manifest([{ ...alice, indications: [{ ...one, lifecycleStatus: "unknown" }] }]),
    manifest([{ ...alice, indications: Array.from(
      { length: MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS + 1 },
      (_, index) => ownershipEntry(
        `investment-indication:over-active-${index}`,
        1,
        "active",
      ),
    ) }]),
    manifest([{ ...alice, indications: Array.from(
      { length: MAX_OWNED_INVESTMENT_INDICATIONS + 1 },
      (_, index) => ownershipEntry(
        `investment-indication:over-record-${String(index).padStart(3, "0")}`,
        1,
        "withdrawn",
      ),
    ) }]),
    manifest(Array.from(
      { length: MAX_LEGACY_INVESTMENT_OWNERSHIP_MIGRATION_SUBJECTS + 1 },
      (_, index) => inventoryEntry(
        actorSubject(
          `issuer.invalid/subject:over-${String(index).padStart(3, "0")}`,
        ),
        `over-${String(index).padStart(3, "0")}`,
        [],
      ),
    )),
  ];
  const sparseParticipants = [alice, bob];
  delete sparseParticipants[0];
  malformed.push(manifest(sparseParticipants));
  const accessor = { schemaVersion: 1 } as Record<string, unknown>;
  Object.defineProperty(accessor, "participants", {
    enumerable: true,
    get: () => [alice],
  });
  malformed.push(accessor);

  for (const candidate of malformed) {
    assert.equal(capture(() =>
      parseLegacyInvestmentOwnershipMigrationInventory(candidate)
    ).code, "INVALID_REQUEST");
  }

  const noStorage = new CountingStorageAdapter(new ThrowingStorageAdapter());
  const invalidLateEntry = manifest([
    alice,
    { ...bob, indications: [one, one] },
  ]);
  assert.equal((await captureAsync(() =>
    runLegacyInvestmentOwnershipMigration(noStorage, invalidLateEntry)
  )).code, "INVALID_REQUEST");
  assert.equal(noStorage.reads, 0);
  assert.equal(noStorage.transactions, 0);
});

test("migrates empty and mixed lifecycle ownership without listing", async () => {
  const emptyState = new MemoryStorageState();
  const emptyStorage = new CountingStorageAdapter(
    new MemoryStorageAdapter(emptyState),
  );
  assert.deepEqual(
    await runLegacyInvestmentOwnershipMigration(
      emptyStorage,
      manifest([inventoryEntry(ALICE, "empty", [])]),
    ),
    {
      scanned: 1,
      initialized: 1,
      alreadyInitialized: 0,
      indications: 0,
    },
  );
  assert.equal(emptyStorage.lists, 0);
  assertCompleteMetadata(emptyState, 1);

  const state = new MemoryStorageState();
  const fixture = await seedLegacyParticipant(
    state,
    ALICE,
    "mixed",
    ["active", "withdrawn", "rejected"],
  );
  const observed = new CountingStorageAdapter(new MemoryStorageAdapter(state));
  assert.deepEqual(
    await runLegacyInvestmentOwnershipMigration(
      observed,
      manifest([fixture.entry]),
    ),
    {
      scanned: 1,
      initialized: 1,
      alreadyInitialized: 0,
      indications: 3,
    },
  );
  assert.equal(observed.lists, 0);
  assert.equal(observed.transactions, 1);
  assertCompleteMetadata(state, 1);
  const reopened = new StorageParticipantInvestmentInterestRepository(
    new MemoryStorageAdapter(state),
    ALICE,
    AMOUNT,
  );
  assert.deepEqual(
    (await reopened.listOwned()).map(({ id, lifecycle }) => ({
      id,
      status: lifecycle.status,
    })),
    fixture.indications.map(({ indicationId, lifecycleStatus }) => ({
      id: indicationId,
      status: lifecycleStatus,
    })),
  );
});

test("maximum 100-record inventory initializes and exact restart replays", async () => {
  const statuses = Array.from(
    { length: MAX_OWNED_INVESTMENT_INDICATIONS },
    (_, index) => index < MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS
      ? "active" as const
      : index % 2 === 0 ? "withdrawn" as const : "rejected" as const,
  );
  const state = new MemoryStorageState();
  const fixture = await seedLegacyParticipant(
    state,
    ALICE,
    "maximum",
    statuses,
  );
  assert.equal(fixture.indications.length, MAX_OWNED_INVESTMENT_INDICATIONS);
  const first = await runLegacyInvestmentOwnershipMigration(
    new MemoryStorageAdapter(state),
    manifest([fixture.entry]),
  );
  assert.deepEqual(first, {
    scanned: 1,
    initialized: 1,
    alreadyInitialized: 0,
    indications: MAX_OWNED_INVESTMENT_INDICATIONS,
  });
  const before = stateFingerprint(state);
  const operationCount = state.operations.size;
  const restarted = await runLegacyInvestmentOwnershipMigration(
    new MemoryStorageAdapter(state),
    manifest([fixture.entry]),
  );
  assert.deepEqual(restarted, {
    scanned: 1,
    initialized: 0,
    alreadyInitialized: 1,
    indications: MAX_OWNED_INVESTMENT_INDICATIONS,
  });
  assert.equal(stateFingerprint(state), before);
  assert.equal(state.operations.size, operationCount);
});

test("incomplete, crossed, and corrupt inventories fail closed", async (t) => {
  await t.test("incomplete witness", async () => {
    const state = new MemoryStorageState();
    const fixture = await seedLegacyParticipant(
      state,
      ALICE,
      "incomplete",
      ["active", "withdrawn"],
    );
    const before = stateFingerprint(state);
    const failure = await captureAsync(() =>
      runLegacyInvestmentOwnershipMigration(
        new MemoryStorageAdapter(state),
        manifest([{ ...fixture.entry, indications: fixture.indications.slice(0, 1) }]),
      )
    );
    assertRedactedFailure(failure, ALICE, fixture.indications[1]!.indicationId);
    assert.equal(stateFingerprint(state), before);
    assertNoRoot(state);
  });

  await t.test("crossed subject", async () => {
    const state = new MemoryStorageState();
    const fixture = await seedLegacyParticipant(
      state,
      ALICE,
      "crossed",
      ["active"],
    );
    const crossed = inventoryEntry(
      BOB,
      "crossed-bob",
      fixture.indications,
    );
    const before = stateFingerprint(state);
    const failure = await captureAsync(() =>
      runLegacyInvestmentOwnershipMigration(
        new MemoryStorageAdapter(state),
        manifest([crossed]),
      )
    );
    assertRedactedFailure(failure, ALICE, fixture.indications[0]!.indicationId);
    assert.equal(stateFingerprint(state), before);
    assertNoRoot(state);
  });

  await t.test("corrupt current head", async () => {
    const state = new MemoryStorageState();
    const fixture = await seedLegacyParticipant(
      state,
      ALICE,
      "corrupt",
      ["active"],
    );
    mutateRecord(
      state,
      "investment-indications",
      (value) => {
        value.participantSubject = BOB;
      },
    );
    const before = stateFingerprint(state);
    const failure = await captureAsync(() =>
      runLegacyInvestmentOwnershipMigration(
        new MemoryStorageAdapter(state),
        manifest([fixture.entry]),
      )
    );
    assertRedactedFailure(failure, ALICE, fixture.indications[0]!.indicationId);
    assert.equal(stateFingerprint(state), before);
    assertNoRoot(state);
  });
});

test("response loss, resume, and restart use exact per-subject retries", async () => {
  const lostState = new MemoryStorageState();
  const lostFixture = await seedLegacyParticipant(
    lostState,
    ALICE,
    "response-loss",
    ["active"],
  );
  const responseLoss = new ResponseLossStorageAdapter(
    new MemoryStorageAdapter(lostState),
  );
  assert.equal((await captureAsync(() =>
    runLegacyInvestmentOwnershipMigration(
      responseLoss,
      manifest([lostFixture.entry]),
    )
  )).code, "UNAVAILABLE");
  assertCompleteMetadata(lostState, 1);
  assert.deepEqual(
    await runLegacyInvestmentOwnershipMigration(
      new MemoryStorageAdapter(lostState),
      manifest([lostFixture.entry]),
    ),
    { scanned: 1, initialized: 0, alreadyInitialized: 1, indications: 1 },
  );

  const state = new MemoryStorageState();
  const alice = await seedLegacyParticipant(
    state,
    ALICE,
    "resume-alice",
    ["withdrawn"],
  );
  const bob = await seedLegacyParticipant(
    state,
    BOB,
    "resume-bob",
    ["rejected"],
  );
  const inventory = manifest([alice.entry, bob.entry]);
  const interrupted = new FailBeforeTransactionStorageAdapter(
    new MemoryStorageAdapter(state),
    2,
  );
  assert.equal((await captureAsync(() =>
    runLegacyInvestmentOwnershipMigration(interrupted, inventory)
  )).code, "UNAVAILABLE");
  assert.equal(recordsIn(
    state,
    "participant-investment-ownership-roots",
  ).length, 1);
  assert.equal(recordsIn(state, "participant-investment-indexes").length, 1);
  assert.equal(recordsIn(
    state,
    "investment-indication-ownership-witnesses",
  ).length, 2);

  assert.deepEqual(
    await runLegacyInvestmentOwnershipMigration(
      new MemoryStorageAdapter(state),
      inventory,
    ),
    { scanned: 2, initialized: 1, alreadyInitialized: 1, indications: 2 },
  );
  assertCompleteMetadata(state, 2);
});

test("operator command closes credentials and migrates through bounded AittaDB", async () => {
  const environment = migrationEnvironment();
  let reads = 0;
  let fetches = 0;
  const empty = await executeLegacyInvestmentOwnershipMigrationCommand(
    ["--apply", "--manifest", "ignored-private-inventory.json"],
    environment,
    {
      readManifest: async () => {
        reads += 1;
        return manifest([]);
      },
      fetch: async () => {
        fetches += 1;
        throw new Error("Empty inventory must not request a token.");
      },
    },
  );
  assert.deepEqual(empty, {
    scanned: 0,
    initialized: 0,
    alreadyInitialized: 0,
    indications: 0,
  });
  assert.equal(reads, 1);
  assert.equal(fetches, 0);
  assert.deepEqual(Object.keys(empty).sort(), [
    "alreadyInitialized",
    "indications",
    "initialized",
    "scanned",
  ]);

  for (const [argv, commandEnvironment] of [
    [["--manifest", "private.json"], environment],
    [["--apply", "--manifest", "private.json"], {
      ...environment,
      AITTADB_MIGRATION_CLIENT_SECRET: undefined,
    }],
  ] as const) {
    let touched = false;
    await assert.rejects(() =>
      executeLegacyInvestmentOwnershipMigrationCommand(
        argv,
        commandEnvironment,
        {
          readManifest: async () => {
            touched = true;
            return manifest([]);
          },
          fetch: async () => {
            touched = true;
            throw new Error("Unexpected fetch.");
          },
        },
      )
    );
    assert.equal(touched, false);
  }

  const migrationKeys = [
    "AITTADB_MIGRATION_CLIENT_ID",
    "AITTADB_MIGRATION_CLIENT_SECRET",
  ] as const;
  const separationKeys = [
    ...migrationKeys,
    "AITTADB_STORAGE_CLIENT_ID",
    "AITTADB_STORAGE_CLIENT_SECRET",
    "AITTADB_OAUTH_CLIENT_ID",
    "AITTADB_OAUTH_CLIENT_SECRET",
    "BROWSER_MUTATION_SESSION_KEY",
    "OWNER_INDICATION_REVIEW_KEY",
    "AITTADB_OAUTH_TRANSACTION_KEY",
    "AITTADB_OAUTH_CSRF_KEY",
  ] as const;
  for (const migrationKey of migrationKeys) {
    for (const reusedKey of separationKeys) {
      if (migrationKey === reusedKey) continue;
      const reusedValue = environment[reusedKey];
      let touched = false;
      await assert.rejects(
        () => executeLegacyInvestmentOwnershipMigrationCommand(
          ["--apply", "--manifest", "private.json"],
          { ...environment, [migrationKey]: reusedValue },
          {
            readManifest: async () => {
              touched = true;
              return manifest([]);
            },
            fetch: async () => {
              touched = true;
              throw new Error("Unexpected fetch.");
            },
          },
        ),
        (error: unknown) =>
          error instanceof Error &&
          error.message ===
            "Legacy investment ownership migration configuration is invalid." &&
          !error.message.includes(reusedValue),
        `${migrationKey} must not reuse ${reusedKey}`,
      );
      assert.equal(touched, false);
    }
  }

  const state = new MemoryStorageState();
  const fixture = await seedLegacyParticipant(
    state,
    ALICE,
    "operator",
    ["active", "withdrawn"],
  );
  const service = new SyntheticAittaDBStorageService({
    issuer: environment.AITTADB_MIGRATION_ISSUER,
    transportOrigin: environment.AITTADB_MIGRATION_TRANSPORT_ORIGIN,
    entryHref: environment.AITTADB_MIGRATION_ENTRY_HREF,
    clientId: environment.AITTADB_MIGRATION_CLIENT_ID,
    clientSecret: environment.AITTADB_MIGRATION_CLIENT_SECRET,
    accessToken: "synthetic-ownership-migration-access-token",
    scopes: "storage.read storage.write",
  });
  for (const record of state.records.values()) {
    service.setRecord({
      collection: record.key.collection,
      id: record.key.id,
      revision: record.revision,
      value: record.value,
    });
  }
  assert.deepEqual(
    await executeLegacyInvestmentOwnershipMigrationCommand(
      ["--apply", "--manifest", "ignored-private-inventory.json"],
      environment,
      {
        readManifest: async () => manifest([fixture.entry]),
        fetch: service.fetch,
      },
    ),
    { scanned: 1, initialized: 1, alreadyInitialized: 0, indications: 2 },
  );
  assert.equal(service.tokenRequests, 1);
  assert.equal(service.discoveryRequests, 1);
  assert.equal(service.listRequests, 0);
  assert.equal(service.transactionRequests, 1);
  assert.equal(
    service.recordKeys().filter((key) =>
      key.startsWith("participant-investment-ownership-roots/")
    ).length,
    1,
  );

  const privateValue = "https://private-value.invalid/path?secret=hidden";
  await assert.rejects(
    () => executeLegacyInvestmentOwnershipMigrationCommand(
      ["--apply", "--manifest", "private.json"],
      { ...environment, AITTADB_MIGRATION_ISSUER: privateValue },
      { readManifest: async () => manifest([]) },
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        "Legacy investment ownership migration configuration is invalid." &&
      !error.message.includes(privateValue),
  );
});

test("operator command accepts the exact maximum canonical manifest", async () => {
  const participants = Array.from(
    { length: MAX_LEGACY_INVESTMENT_OWNERSHIP_MIGRATION_SUBJECTS },
    (_, participantIndex) => ({
      participantSubject: actorSubject(
        `${"\ud800".repeat(254)}${String.fromCharCode(0xd800 + participantIndex)}`,
      ),
      operationId: stableOperationId(participantIndex),
      indications: Array.from(
        { length: MAX_OWNED_INVESTMENT_INDICATIONS },
        (_, indicationIndex) => ownershipEntry(
          maximumIndicationId(participantIndex, indicationIndex),
          16,
          "withdrawn",
        ),
      ),
    }),
  );
  const serialized = JSON.stringify(manifest(participants));
  const size = new TextEncoder().encode(serialized).byteLength;
  assert.equal(
    size,
    MAX_LEGACY_INVESTMENT_OWNERSHIP_MIGRATION_MANIFEST_BYTES,
  );
  const directory = await mkdtemp(
    join(tmpdir(), "invest-ownership-migration-manifest-"),
  );
  const path = join(directory, "manifest.json");
  try {
    await writeFile(path, serialized, "utf8");
    let fetches = 0;
    await assert.rejects(() =>
      executeLegacyInvestmentOwnershipMigrationCommand(
        ["--apply", "--manifest", path],
        migrationEnvironment(),
        {
          fetch: async () => {
            fetches += 1;
            throw new Error("Stop after manifest acceptance.");
          },
        },
      )
    );
    assert.equal(fetches, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("operator command rejects manifest growth after one max-plus-one read", async () => {
  let reads = 0;
  let requestedBytes = 0;
  let closes = 0;
  let fetches = 0;
  await assert.rejects(
    () => executeLegacyInvestmentOwnershipMigrationCommand(
      ["--apply", "--manifest", "growing-private.json"],
      migrationEnvironment(),
      {
        openManifest: async () => ({
          stat: async () => ({
            size: MAX_LEGACY_INVESTMENT_OWNERSHIP_MIGRATION_MANIFEST_BYTES,
            isFile: () => true,
          }),
          read: async (buffer, offset, length) => {
            reads += 1;
            requestedBytes += length;
            buffer.fill(0x20, offset, offset + length);
            return { bytesRead: length };
          },
          close: async () => {
            closes += 1;
          },
        }),
        fetch: async () => {
          fetches += 1;
          throw new Error("Unexpected fetch.");
        },
      },
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        "Legacy investment ownership migration configuration is invalid.",
  );
  assert.equal(reads, 1);
  assert.equal(
    requestedBytes,
    MAX_LEGACY_INVESTMENT_OWNERSHIP_MIGRATION_MANIFEST_BYTES + 1,
  );
  assert.equal(closes, 1);
  assert.equal(fetches, 0);
});

test("migration has no browser route or ordinary-request absence fallback", async () => {
  const repository = new StorageParticipantInvestmentInterestRepository(
    new MemoryStorageAdapter(),
    ALICE,
    AMOUNT,
  );
  assert.equal((await captureAsync(() => repository.listOwned())).code, "UNAVAILABLE");

  const productionFiles = await sourceFilesBelow("worker", "http", "app");
  for (const path of productionFiles) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(
      source,
      /legacy-investment-ownership-migration/u,
      path,
    );
    assert.doesNotMatch(
      source,
      /runLegacyInvestmentOwnershipMigration/u,
      path,
    );
  }
});

async function seedLegacyParticipant(
  state: MemoryStorageState,
  participantSubject: ActorSubject,
  suffix: string,
  statuses: readonly ParticipantIndicationOwnershipEntry["lifecycleStatus"][],
): Promise<Readonly<{
  entry: Readonly<Record<string, unknown>>;
  indications: readonly ParticipantIndicationOwnershipEntry[];
}>> {
  const storage = new MemoryStorageAdapter(state);
  const participant = indicationRepository(storage, participantSubject);
  const owner = indicationRepository(storage, OWNER);
  const context = await packageContext(participantSubject, suffix);
  const indications: ParticipantIndicationOwnershipEntry[] = [];
  for (let index = 0; index < statuses.length; index += 1) {
    const status = statuses[index]!;
    const id = indicationId(
      `investment-indication:${suffix}-${String(index).padStart(3, "0")}`,
    );
    const label = `${suffix}-${String(index).padStart(3, "0")}`;
    const created = await participant.create({
      operationId: `indication-operation:${label}-create`,
      id,
      occurredAt: timestamp(index * 2),
      historyEntryId: `indication-history:${label}-create`,
      expectedRevision: null,
      fields: companyFields(index),
    }, context);
    let snapshot: InvestmentIndication = created.snapshot;
    if (status === "withdrawn") {
      const withdrawn = await participant.withdraw({
        operationId: `indication-operation:${label}-withdraw`,
        id,
        occurredAt: timestamp(index * 2 + 1),
        historyEntryId: `indication-history:${label}-withdraw`,
        expectedRevision: snapshot.revision,
      });
      snapshot = withdrawn.snapshot;
    } else if (status === "rejected") {
      const rejected = await owner.reject({
        operationId: `indication-operation:${label}-reject`,
        id,
        occurredAt: timestamp(index * 2 + 1),
        historyEntryId: `indication-history:${label}-reject`,
        expectedRevision: snapshot.revision,
        reason: "Synthetic migration rejection.",
      });
      snapshot = rejected.snapshot;
    }
    assert.equal(snapshot.lifecycle.status, status);
    indications.push(Object.freeze({
      indicationId: id,
      indicationRevision: snapshot.revision,
      lifecycleStatus: status,
    }));
  }
  const entry = inventoryEntry(
    participantSubject,
    suffix,
    Object.freeze(indications),
  );
  return Object.freeze({ entry, indications: Object.freeze(indications) });
}

function indicationRepository(
  storage: StorageAdapter,
  subject: ActorSubject,
): DevelopmentInMemoryIndicationRepository {
  return new DevelopmentInMemoryIndicationRepository(
    storage,
    subject,
    OWNER,
    AMOUNT,
  );
}

async function packageContext(
  subject: ActorSubject,
  suffix: string,
): Promise<TrustedPackageAcknowledgmentContext> {
  const version = await createPackageVersion({
    id: `package-version:ownership-${suffix}`,
    createdAt: "2026-08-10T00:00:00.000Z",
    changeSummary: "Synthetic ownership migration fixture.",
    materialChange: true,
    acknowledgmentText: "This indication is non-binding.",
    sections: [{
      id: `package-section:ownership-${suffix}`,
      order: 0,
      title: "Overview",
      markdown: "Synthetic migration fixture.",
      enabled: true,
    }],
  }, null);
  if (!version.ok) assert.fail(JSON.stringify(version.issues));
  const acceptance = createPackageAcceptance({
    id: `package-acceptance:ownership-${suffix}`,
    participantSubject: subject,
    acceptedAt: "2026-08-10T00:00:30.000Z",
  }, version.value);
  if (!acceptance.ok) assert.fail(JSON.stringify(acceptance.issues));
  return Object.freeze({
    currentVersion: version.value,
    latestAcceptance: acceptance.value,
  });
}

function companyFields(index: number): StorageDocument {
  const suffix = String(index).padStart(3, "0");
  return {
    kind: "company",
    companyName: `Synthetic migration company ${suffix}`,
    registrationCountry: "FI",
    companyIdentifier: `OWNERSHIP-MIGRATION-${suffix}`,
    representativeName: "Synthetic representative",
    representativeAuthorityDeclared: true,
    amount: 1_000,
    availabilityPeriod: "Within twelve months.",
    note: null,
  };
}

function manifest(
  participants: readonly unknown[],
): Readonly<Record<string, unknown>> {
  return { schemaVersion: 1, participants: [...participants] };
}

function inventoryEntry(
  participantSubject: ActorSubject,
  suffix: string,
  indications: readonly unknown[],
): Readonly<Record<string, unknown>> {
  return {
    participantSubject,
    operationId: `investment-ownership-migration:${suffix}`,
    indications: [...indications],
  };
}

function ownershipEntry(
  id: string,
  indicationRevision: number,
  lifecycleStatus: ParticipantIndicationOwnershipEntry["lifecycleStatus"],
): Readonly<Record<string, unknown>> {
  return {
    indicationId: id,
    indicationRevision,
    lifecycleStatus,
  };
}

function recordsIn(
  state: MemoryStorageState,
  collection: string,
): readonly (readonly [string, StorageRecord])[] {
  return [...state.records.entries()].filter(([, record]) =>
    record.key.collection === collection
  );
}

function assertCompleteMetadata(state: MemoryStorageState, count: number): void {
  assert.equal(recordsIn(state, "participant-investment-ownership-roots").length, count);
  assert.equal(recordsIn(state, "participant-investment-indexes").length, count);
  assert.equal(
    recordsIn(state, "investment-indication-ownership-witnesses").length,
    count,
  );
}

function assertNoRoot(state: MemoryStorageState): void {
  assert.equal(recordsIn(state, "participant-investment-ownership-roots").length, 0);
}

function mutateRecord(
  state: MemoryStorageState,
  collection: string,
  mutate: (value: Record<string, unknown>) => void,
): void {
  const entry = recordsIn(state, collection)[0];
  assert(entry);
  const [identity, record] = entry;
  const value = structuredClone(record.value) as Record<string, unknown>;
  mutate(value);
  state.records.set(identity, Object.freeze({
    key: record.key,
    revision: record.revision,
    value: Object.freeze(value) as StorageDocument,
  }));
}

function stateFingerprint(state: MemoryStorageState): string {
  return JSON.stringify([...state.records.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  ));
}

function assertRedactedFailure(
  failure: StorageFailure,
  subject: ActorSubject,
  id: InvestmentIndicationId,
): void {
  assert.equal(failure.code, "UNAVAILABLE");
  assert.equal(failure.cause, undefined);
  assert.equal(String(failure).includes(subject), false);
  assert.equal(String(failure).includes(id), false);
}

function migrationEnvironment(): Record<string, string> {
  return {
    AITTADB_MIGRATION_ISSUER: "https://storage.example.invalid",
    AITTADB_MIGRATION_TRANSPORT_ORIGIN: "https://runtime.example.invalid",
    AITTADB_MIGRATION_ENTRY_HREF:
      "https://storage.example.invalid/storage/discovery",
    AITTADB_MIGRATION_CLIENT_ID: "ownership-migration-client-id",
    AITTADB_MIGRATION_CLIENT_SECRET: "synthetic-ownership-migration-secret",
    AITTADB_STORAGE_CLIENT_ID: "application-client",
    AITTADB_STORAGE_CLIENT_SECRET: "different-application-secret",
    AITTADB_OAUTH_CLIENT_ID: "interactive-oauth-client",
    AITTADB_OAUTH_CLIENT_SECRET: "interactive-oauth-secret",
    BROWSER_MUTATION_SESSION_KEY: "browser-mutation-session-key",
    OWNER_INDICATION_REVIEW_KEY: "owner-indication-review-key",
    AITTADB_OAUTH_TRANSACTION_KEY: "oauth-transaction-proof-key",
    AITTADB_OAUTH_CSRF_KEY: "oauth-csrf-proof-key-material",
  };
}

function maximumIndicationId(
  participantIndex: number,
  indicationIndex: number,
): string {
  const prefix = `m${String(participantIndex).padStart(3, "0")}${String(
    indicationIndex,
  ).padStart(3, "0")}`;
  return `${prefix}${"x".repeat(128 - prefix.length)}`;
}

function stableOperationId(index: number): string {
  const prefix = `o${String(index).padStart(3, "0")}`;
  return `${prefix}${"x".repeat(128 - prefix.length)}`;
}

function timestamp(minute: number): string {
  return new Date(Date.UTC(2026, 7, 10, 0, minute + 1)).toISOString();
}

function actorSubject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function indicationId(value: string): InvestmentIndicationId {
  const parsed = parseStableId<"investment-indication">(value);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function amountConfiguration(): AmountConfiguration {
  const parsed = parseAmountAggregateConfiguration({
    amount: {
      currency: "EUR",
      minimum: 1_000,
      increment: 250,
      maximum: 10_000,
    },
    publicAggregate: { visibility: "hidden" },
  });
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value.amount;
}

function capture(operation: () => unknown): StorageFailure {
  try {
    operation();
  } catch (error) {
    assert(error instanceof StorageFailure);
    return error;
  }
  assert.fail("Expected StorageFailure.");
}

async function captureAsync(
  operation: () => Promise<unknown>,
): Promise<StorageFailure> {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof StorageFailure);
    return error;
  }
  assert.fail("Expected StorageFailure.");
}

async function sourceFilesBelow(...roots: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const root of roots) await visit(root);
  return files;

  async function visit(path: string): Promise<void> {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const child = join(path, item.name);
      if (item.isDirectory()) await visit(child);
      else if (item.isFile() && child.endsWith(".ts")) files.push(child);
    }
  }
}

class ThrowingStorageAdapter implements StorageAdapter {
  read(): Promise<StorageRecord | null> {
    throw new Error("Storage must not be read.");
  }
  list(): Promise<StoragePage> {
    throw new Error("Migration must not list storage.");
  }
  transact(): Promise<StorageTransactionResult> {
    throw new Error("Storage must not be mutated.");
  }
}

class CountingStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  reads = 0;
  lists = 0;
  transactions = 0;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }
  read(key: StorageKey): Promise<StorageRecord | null> {
    this.reads += 1;
    return this.#delegate.read(key);
  }
  list(request: StorageListRequest): Promise<StoragePage> {
    this.lists += 1;
    return this.#delegate.list(request);
  }
  transact(request: StorageTransactionRequest): Promise<StorageTransactionResult> {
    this.transactions += 1;
    return this.#delegate.transact(request);
  }
}

class ResponseLossStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }
  read(key: StorageKey): Promise<StorageRecord | null> {
    return this.#delegate.read(key);
  }
  list(request: StorageListRequest): Promise<StoragePage> {
    return this.#delegate.list(request);
  }
  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    await this.#delegate.transact(request);
    throw new StorageFailure("UNAVAILABLE");
  }
}

class FailBeforeTransactionStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #failAt: number;
  #transactions = 0;

  constructor(delegate: StorageAdapter, failAt: number) {
    this.#delegate = delegate;
    this.#failAt = failAt;
  }
  read(key: StorageKey): Promise<StorageRecord | null> {
    return this.#delegate.read(key);
  }
  list(request: StorageListRequest): Promise<StoragePage> {
    return this.#delegate.list(request);
  }
  transact(request: StorageTransactionRequest): Promise<StorageTransactionResult> {
    this.#transactions += 1;
    if (this.#transactions === this.#failAt) {
      throw new StorageFailure("UNAVAILABLE");
    }
    return this.#delegate.transact(request);
  }
}
