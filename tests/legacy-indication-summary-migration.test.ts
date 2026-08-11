import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  parseAmountAggregateConfiguration,
  type AmountConfiguration,
} from "../domain/amount-aggregate-configuration.ts";
import {
  parseActorSubject,
  parseStableId,
  type ActorSubject,
} from "../domain/foundation.ts";
import {
  MAX_INVESTMENT_INDICATION_REVISIONS,
  type InvestmentIndication,
  type InvestmentIndicationId,
  type TrustedPackageAcknowledgmentContext,
} from "../domain/investment-indication.ts";
import {
  createPackageAcceptance,
  createPackageVersion,
} from "../domain/package-content.ts";
import {
  StorageFailure,
  storageKeyString,
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
  MAX_LEGACY_INDICATION_SUMMARY_MIGRATION_READS,
  readParticipantIndicationOwnershipHead,
  type CreateIndicationRequest,
  type EditIndicationRequest,
  type WithdrawIndicationRequest,
} from "../repositories/in-memory-indication-repository.ts";
import {
  executeLegacyIndicationSummaryMigrationCommand,
  MAX_LEGACY_INDICATION_SUMMARY_MANIFEST_READ_CALLS,
} from "../scripts/migrate-legacy-indication-summaries.ts";
import {
  MAX_LEGACY_INDICATION_SUMMARY_MIGRATION_MANIFEST_BYTES,
  MAX_LEGACY_INDICATION_SUMMARY_MIGRATION_ENTRIES,
  parseLegacyIndicationSummaryMigrationInventory,
  runLegacyIndicationSummaryMigration,
} from "../services/legacy-indication-summary-migration.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";
import { SyntheticAittaDBStorageService } from "./support/synthetic-aittadb-storage-service.ts";

const execFile = promisify(execFileCallback);

const ALICE = actorSubject("issuer.invalid/subject:alice-migration");
const BOB = actorSubject("issuer.invalid/subject:bob-migration");
const OWNER = actorSubject("issuer.invalid/subject:migration-owner");
const ALICE_ID = indicationId("indication:migration:alice");
const BOB_ID = indicationId("indication:migration:bob");
const amount = amountConfiguration();

test("migration inventory is closed, sorted, bounded, and permits empty work", async () => {
  assert.deepEqual(
    parseLegacyIndicationSummaryMigrationInventory(manifest([])),
    { entries: [] },
  );
  const empty = await runLegacyIndicationSummaryMigration(
    new ThrowingStorageAdapter(),
    manifest([]),
  );
  assert.deepEqual(empty, { scanned: 0, migrated: 0, alreadyCurrent: 0 });
  assert.equal(Object.isFrozen(empty), true);

  const valid = entry(ALICE, ALICE_ID);
  const malformed: unknown[] = [
    null,
    {},
    { ...manifest([]), extra: true },
    { schemaVersion: 2, indications: [] },
    { schemaVersion: 1, indications: [valid, valid] },
    {
      schemaVersion: 1,
      indications: [entry(ALICE, ALICE_ID), entry(BOB, ALICE_ID)],
    },
    { schemaVersion: 1, indications: [entry(BOB, BOB_ID), valid] },
    { schemaVersion: 1, indications: [{ ...valid, extra: true }] },
    { schemaVersion: 1, indications: [{ ...valid, indicationId: "" }] },
    { schemaVersion: 1, indications: Array.from(
      { length: MAX_LEGACY_INDICATION_SUMMARY_MIGRATION_ENTRIES + 1 },
      (_, index) => entry(
        ALICE,
        indicationId(`indication:migration:${String(index).padStart(3, "0")}`),
      ),
    ) },
  ];
  const sparse = [valid, valid];
  delete sparse[0];
  malformed.push({ schemaVersion: 1, indications: sparse });
  const accessor = { schemaVersion: 1 } as Record<string, unknown>;
  Object.defineProperty(accessor, "indications", {
    enumerable: true,
    get: () => [valid],
  });
  malformed.push(accessor);

  for (const candidate of malformed) {
    assert.equal(capture(() =>
      parseLegacyIndicationSummaryMigrationInventory(candidate)
    ).code, "INVALID_REQUEST");
  }
});

test("inventory rejects one global indication ID under different subjects before storage", async () => {
  const observed = new CountingStorageAdapter(new ThrowingStorageAdapter());
  const failure = await captureAsync(() =>
    runLegacyIndicationSummaryMigration(
      observed,
      manifest([
        entry(ALICE, ALICE_ID),
        entry(BOB, ALICE_ID),
      ]),
    )
  );
  assert.equal(failure.code, "INVALID_REQUEST");
  assert.equal(observed.reads, 0);
  assert.equal(observed.transactions, 0);
});

test("migrates one fully verified compact schema-5 head without changing domain state", async () => {
  const fixture = await seededLegacy(ALICE, ALICE_ID);
  const beforeCollections = immutableCollectionEvidence(fixture.state);
  const beforeCurrent = currentRecord(fixture.state, ALICE_ID);
  assert.equal(beforeCurrent.value.schemaVersion, 5);
  assert.equal(beforeCurrent.revision, fixture.snapshot.revision);
  assert.deepEqual(
    await repository(fixture.storage, ALICE).get(ALICE_ID),
    fixture.snapshot,
  );

  const first = await runLegacyIndicationSummaryMigration(
    fixture.storage,
    manifest([entry(ALICE, ALICE_ID)]),
  );
  assert.deepEqual(first, { scanned: 1, migrated: 1, alreadyCurrent: 0 });
  const migrated = currentRecord(fixture.state, ALICE_ID);
  assert.equal(migrated.value.schemaVersion, 6);
  assert.equal(migrated.value.revision, fixture.snapshot.revision);
  assert.equal(migrated.revision, fixture.snapshot.revision + 1);
  assert.equal(Object.hasOwn(migrated.value, "participantSummary"), true);
  assert.deepEqual(immutableCollectionEvidence(fixture.state), beforeCollections);
  assert.deepEqual(
    await repository(fixture.storage, ALICE).get(ALICE_ID),
    fixture.snapshot,
  );

  const restarted = await runLegacyIndicationSummaryMigration(
    new MemoryStorageAdapter(fixture.state),
    manifest([entry(ALICE, ALICE_ID)]),
  );
  assert.deepEqual(restarted, {
    scanned: 1,
    migrated: 0,
    alreadyCurrent: 1,
  });
});

test("a migrated head remains mutable with its storage revision offset", async () => {
  const fixture = await seededLegacy(ALICE, ALICE_ID);
  await runLegacyIndicationSummaryMigration(
    fixture.storage,
    manifest([entry(ALICE, ALICE_ID)]),
  );
  const edited = await repository(fixture.storage, ALICE).edit(
    editRequest(ALICE_ID, 2),
    await packageContext(ALICE),
  );
  const current = currentRecord(fixture.state, ALICE_ID);
  assert.equal(current.value.schemaVersion, 6);
  assert.equal(current.value.revision, 2);
  assert.equal(current.revision, 3);
  assert.equal(
    mutableRecord(current.value.participantSummary).updatedAt,
    edited.snapshot.updatedAt,
  );
  assert.deepEqual(
    await repository(fixture.storage, ALICE).get(ALICE_ID),
    edited.snapshot,
  );
});

test("migrates a valid schema-4 fingerprint chain without misreading schema 5", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const participant = repository(storage, ALICE);
  const created = await participant.create(
    createRequest(ALICE_ID, "true-legacy-create", 1),
    await packageContext(ALICE),
  );
  await downgradeIndicationToLegacy(state, ALICE_ID, created.snapshot);
  assert.equal(currentRecord(state, ALICE_ID).value.schemaVersion, 4);
  assert.deepEqual(await repository(storage, ALICE).get(ALICE_ID), created.snapshot);

  assert.deepEqual(
    await runLegacyIndicationSummaryMigration(
      storage,
      manifest([entry(ALICE, ALICE_ID)]),
    ),
    { scanned: 1, migrated: 1, alreadyCurrent: 0 },
  );
  const migrated = currentRecord(state, ALICE_ID);
  assert.equal(migrated.value.schemaVersion, 6);
  assert.equal(migrated.value.revision, 1);
  assert.equal(migrated.revision, 2);
  assert.deepEqual(await repository(storage, ALICE).get(ALICE_ID), created.snapshot);

  const edited = await participant.edit(
    editRequest(ALICE_ID, 2),
    await packageContext(ALICE),
  );
  const current = currentRecord(state, ALICE_ID);
  assert.equal(current.value.schemaVersion, 6);
  assert.equal(current.value.revision, 2);
  assert.equal(current.revision, 3);
  assert.equal(
    [...state.records.values()].find((record) =>
      record.key.collection === "investment-indication-history" &&
      record.value.indicationId === ALICE_ID &&
      record.value.revision === 1
    )?.value.schemaVersion,
    4,
  );
  assert.equal(
    [...state.records.values()].find((record) =>
      record.key.collection === "investment-indication-history" &&
      record.value.indicationId === ALICE_ID &&
      record.value.revision === 2
    )?.value.schemaVersion,
    5,
  );
  assert.deepEqual(await repository(storage, ALICE).get(ALICE_ID), edited.snapshot);
});

test("schema-5 compact heads are accepted and schema-5 summary hybrids are rejected", async () => {
  const compact = await seededLegacy(ALICE, ALICE_ID);
  assert.equal(currentRecord(compact.state, ALICE_ID).value.schemaVersion, 5);
  assert.deepEqual(
    await repository(compact.storage, ALICE).get(ALICE_ID),
    compact.snapshot,
  );
  assert.deepEqual(
    await readParticipantIndicationOwnershipHead(
      compact.storage,
      ALICE,
      ALICE_ID,
    ),
    {
      indicationId: ALICE_ID,
      indicationRevision: 1,
      lifecycleStatus: "active",
    },
  );

  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await repository(storage, ALICE).create(
    createRequest(ALICE_ID, "schema-collision", 1),
    await packageContext(ALICE),
  );
  mutateRecordWhere(
    state,
    "investment-indications",
    () => true,
    (value) => {
      value.schemaVersion = 5;
    },
  );
  const failure = await captureAsync(() =>
    repository(storage, ALICE).get(ALICE_ID)
  );
  assert.equal(failure.code, "UNAVAILABLE");
  assert.equal(failure.cause, undefined);

  const observed = new CountingStorageAdapter(storage);
  const migrationFailure = await captureAsync(() =>
    runLegacyIndicationSummaryMigration(
      observed,
      manifest([entry(ALICE, ALICE_ID)]),
    )
  );
  assert.equal(migrationFailure.code, "UNAVAILABLE");
  assert.equal(migrationFailure.cause, undefined);
  assert.equal(observed.transactions, 0);
});

test("an already-migrated head is fully authenticated before exact retry", async () => {
  const fixture = await seededLegacy(ALICE, ALICE_ID);
  await runLegacyIndicationSummaryMigration(
    fixture.storage,
    manifest([entry(ALICE, ALICE_ID)]),
  );
  mutateRecordWhere(
    fixture.state,
    "investment-indications",
    () => true,
    (value) => {
      const summary = {
        ...mutableRecord(value.participantSummary),
        updatedAt: "2026-08-11T00:00:00.000Z",
      };
      value.participantSummary = summary;
    },
  );
  assert.equal((await captureAsync(() =>
    runLegacyIndicationSummaryMigration(
      fixture.storage,
      manifest([entry(ALICE, ALICE_ID)]),
    )
  )).code, "UNAVAILABLE");
});

test("browser-readable indication GET never performs a legacy migration write", async () => {
  const fixture = await seededLegacy(ALICE, ALICE_ID);
  const observed = new CountingStorageAdapter(fixture.storage);
  const snapshot = await repository(observed, ALICE).get(ALICE_ID);
  assert.deepEqual(snapshot, fixture.snapshot);
  assert.equal(observed.transactions, 0);
  assert.equal(currentRecord(fixture.state, ALICE_ID).value.schemaVersion, 5);

  const productionFiles = await sourceFilesBelow("worker", "http", "app");
  for (const path of productionFiles) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /legacy-indication-summary-migration/u, path);
    assert.doesNotMatch(source, /migrateLegacyIndicationCurrentSummary/u, path);
  }
});

test("migration verifies missing, crossed, corrupt, and active-lease evidence", async (t) => {
  const cases: readonly Readonly<{
    name: string;
    apply(state: MemoryStorageState): void;
  }>[] = [
    {
      name: "missing transition",
      apply: (state) => deleteRecordWhere(
        state,
        "investment-indication-history",
        (record) => record.value.revision === 1,
      ),
    },
    {
      name: "crossed transition subject",
      apply: (state) => mutateRecordWhere(
        state,
        "investment-indication-history",
        (record) => record.value.revision === 1,
        (value) => {
          value.participantSubject = BOB;
        },
      ),
    },
    {
      name: "corrupt intermediate transition",
      apply: (state) => mutateRecordWhere(
        state,
        "investment-indication-history",
        (record) => record.value.revision === 2,
        (value) => {
          value.occurredAt = "2026-08-11T00:00:00.000Z";
        },
      ),
    },
    {
      name: "missing field chunk",
      apply: (state) => deleteRecordWhere(
        state,
        "investment-indication-fields",
        () => true,
      ),
    },
    {
      name: "missing active lease",
      apply: (state) => deleteRecordWhere(
        state,
        "investment-indication-active-keys",
        () => true,
      ),
    },
  ];

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const fixture = await seededLegacy(ALICE, ALICE_ID, { edited: true });
      candidate.apply(fixture.state);
      const failure = await captureAsync(() =>
        runLegacyIndicationSummaryMigration(
          fixture.storage,
          manifest([entry(ALICE, ALICE_ID)]),
        )
      );
      assert.equal(failure.code, "UNAVAILABLE");
      assert.equal(failure.message.includes(ALICE), false);
      assert.equal(failure.message.includes(ALICE_ID), false);
      assert.equal(currentRecord(fixture.state, ALICE_ID).value.schemaVersion, 5);
    });
  }

  const crossed = await seededLegacy(ALICE, ALICE_ID);
  assert.equal((await captureAsync(() =>
    runLegacyIndicationSummaryMigration(
      crossed.storage,
      manifest([entry(BOB, ALICE_ID)]),
    )
  )).code, "UNAVAILABLE");
});

test("inactive migration rejects its exact stale uniqueness lease", async (t) => {
  for (const lifecycle of ["withdrawn", "rejected"] as const) {
    await t.test(lifecycle, async () => {
      const state = new MemoryStorageState();
      const storage = new MemoryStorageAdapter(state);
      const participant = repository(storage, ALICE);
      await participant.create(
        createRequest(ALICE_ID, `${lifecycle}-create`, 1),
        await packageContext(ALICE),
      );
      const lease = [...state.records.values()].find((record) =>
        record.key.collection === "investment-indication-active-keys"
      );
      assert(lease);
      if (lifecycle === "withdrawn") {
        await participant.withdraw(withdrawRequest(ALICE_ID, 2));
      } else {
        await repository(storage, OWNER).reject({
          operationId: "indication-operation:migration-reject-2",
          id: ALICE_ID,
          occurredAt: timestamp(2),
          historyEntryId: "indication-history:migration-reject-2",
          expectedRevision: 1,
          reason: "Private rejection evidence.",
        });
      }
      state.records.set(storageKeyString(lease.key), lease);
      downgradeCurrent(state, ALICE_ID);

      const failure = await captureAsync(() =>
        runLegacyIndicationSummaryMigration(
          storage,
          manifest([entry(ALICE, ALICE_ID)]),
        )
      );
      assert.equal(failure.code, "UNAVAILABLE");
      assert.equal(failure.cause, undefined);
      assert.equal(String(failure).includes(ALICE), false);
      assert.equal(String(failure).includes(ALICE_ID), false);
      assert.equal(currentRecord(state, ALICE_ID).value.schemaVersion, 5);
    });
  }
});

test("migration verifies every historical company uniqueness coordinate", async (t) => {
  for (const lifecycle of ["withdrawn", "rejected"] as const) {
    await t.test(`${lifecycle} without stale leases`, async () => {
      const fixture = await editedInactiveCompany(lifecycle);
      const observed = new CountingStorageAdapter(fixture.storage);
      assert.deepEqual(
        await runLegacyIndicationSummaryMigration(
          observed,
          manifest([entry(ALICE, ALICE_ID)]),
        ),
        { scanned: 1, migrated: 1, alreadyCurrent: 0 },
      );
      assert.ok(
        observed.reads <= MAX_LEGACY_INDICATION_SUMMARY_MIGRATION_READS,
      );
    });

    for (const coordinate of ["original", "edited"] as const) {
      await t.test(`${lifecycle} stale ${coordinate} lease`, async () => {
        const fixture = await editedInactiveCompany(lifecycle);
        const stale = coordinate === "original"
          ? fixture.originalLease
          : fixture.editedLease;
        fixture.state.records.set(storageKeyString(stale.key), stale);
        const failure = await captureAsync(() =>
          runLegacyIndicationSummaryMigration(
            fixture.storage,
            manifest([entry(ALICE, ALICE_ID)]),
          )
        );
        assert.equal(failure.code, "UNAVAILABLE");
        assert.equal(failure.cause, undefined);
        assert.equal(String(failure).includes(ALICE), false);
        assert.equal(String(failure).includes(ALICE_ID), false);
        assert.equal(currentRecord(fixture.state, ALICE_ID).value.schemaVersion, 5);
      });
    }
  }
});

test("maximum immutable ancestry migrates after every revision is verified", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const context = await packageContext(ALICE);
  const alice = repository(storage, ALICE);
  await alice.create(createRequest(ALICE_ID, "maximum-create", 1), context);
  for (let revision = 2; revision < MAX_INVESTMENT_INDICATION_REVISIONS; revision += 1) {
    await alice.edit(editRequest(ALICE_ID, revision), context);
  }
  const withdrawn = await alice.withdraw(withdrawRequest(
    ALICE_ID,
    MAX_INVESTMENT_INDICATION_REVISIONS,
  ));
  downgradeCurrent(state, ALICE_ID);

  const result = await runLegacyIndicationSummaryMigration(
    storage,
    manifest([entry(ALICE, ALICE_ID)]),
  );
  assert.deepEqual(result, { scanned: 1, migrated: 1, alreadyCurrent: 0 });
  const current = currentRecord(state, ALICE_ID);
  assert.equal(current.value.revision, MAX_INVESTMENT_INDICATION_REVISIONS);
  assert.equal(current.revision, MAX_INVESTMENT_INDICATION_REVISIONS + 1);
  assert.equal(
    mutableRecord(current.value.participantSummary).status,
    "withdrawn",
  );
  assert.deepEqual(await repository(storage, ALICE).get(ALICE_ID), withdrawn.snapshot);
});

test("maximum distinct historical uniqueness inventory stays read-bounded", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const participant = repository(storage, ALICE);
  const context = await packageContext(ALICE);
  await participant.create({
    operationId: "indication-operation:maximum-coordinate-create",
    id: ALICE_ID,
    occurredAt: timestamp(1),
    historyEntryId: "indication-history:maximum-coordinate-create",
    expectedRevision: null,
    fields: companyFields("REG-001"),
  }, context);
  for (let revision = 2; revision < MAX_INVESTMENT_INDICATION_REVISIONS; revision += 1) {
    await participant.edit({
      operationId: `indication-operation:maximum-coordinate-${revision}`,
      id: ALICE_ID,
      occurredAt: timestamp(revision),
      historyEntryId: `indication-history:maximum-coordinate-${revision}`,
      expectedRevision: revision - 1,
      fields: companyFields(`REG-${String(revision).padStart(3, "0")}`),
    }, context);
  }
  await participant.withdraw(withdrawRequest(
    ALICE_ID,
    MAX_INVESTMENT_INDICATION_REVISIONS,
  ));
  downgradeCurrent(state, ALICE_ID);

  const observed = new CountingStorageAdapter(storage);
  assert.deepEqual(
    await runLegacyIndicationSummaryMigration(
      observed,
      manifest([entry(ALICE, ALICE_ID)]),
    ),
    { scanned: 1, migrated: 1, alreadyCurrent: 0 },
  );
  assert.ok(observed.reads <= MAX_LEGACY_INDICATION_SUMMARY_MIGRATION_READS);
});

test("exact concurrent migration and response loss recover without a second write", async () => {
  const exact = await seededLegacy(ALICE, ALICE_ID);
  const raced = new InterleavingStorageAdapter(
    exact.storage,
    async (request) => {
      await exact.storage.transact({
        operationId: storageOperationId("indication-summary-race:exact"),
        mutations: request.mutations,
      });
    },
  );
  assert.deepEqual(
    await runLegacyIndicationSummaryMigration(
      raced,
      manifest([entry(ALICE, ALICE_ID)]),
    ),
    { scanned: 1, migrated: 0, alreadyCurrent: 1 },
  );

  const loss = await seededLegacy(ALICE, ALICE_ID);
  const lostResponse = new ResponseLossStorageAdapter(loss.storage);
  assert.deepEqual(
    await runLegacyIndicationSummaryMigration(
      lostResponse,
      manifest([entry(ALICE, ALICE_ID)]),
    ),
    { scanned: 1, migrated: 0, alreadyCurrent: 1 },
  );
  assert.equal(lostResponse.transactions, 1);
});

test("a concurrent domain mutation is preserved and the stale migration fails closed", async () => {
  const fixture = await seededLegacy(ALICE, ALICE_ID);
  const context = await packageContext(ALICE);
  const interleaved = new InterleavingStorageAdapter(
    fixture.storage,
    async () => {
      await repository(fixture.storage, ALICE).edit(
        editRequest(ALICE_ID, 2),
        context,
      );
    },
  );
  assert.equal((await captureAsync(() =>
    runLegacyIndicationSummaryMigration(
      interleaved,
      manifest([entry(ALICE, ALICE_ID)]),
    )
  )).code, "UNAVAILABLE");
  const current = await repository(fixture.storage, ALICE).get(ALICE_ID);
  assert.equal(current?.revision, 2);
  assert.equal(current?.fields.note, "Edited revision 2.");
});

test("restart resumes a partially completed inventory through exact retries", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await seedLegacyInto(storage, state, ALICE, ALICE_ID);
  await seedLegacyInto(storage, state, BOB, BOB_ID);
  const inventory = manifest([entry(ALICE, ALICE_ID), entry(BOB, BOB_ID)]);
  const interrupted = new FailBeforeTransactionStorageAdapter(storage, 2);
  assert.equal((await captureAsync(() =>
    runLegacyIndicationSummaryMigration(interrupted, inventory)
  )).code, "UNAVAILABLE");
  assert.equal(currentRecord(state, ALICE_ID).value.schemaVersion, 6);
  assert.equal(currentRecord(state, BOB_ID).value.schemaVersion, 5);

  assert.deepEqual(
    await runLegacyIndicationSummaryMigration(
      new MemoryStorageAdapter(state),
      inventory,
    ),
    { scanned: 2, migrated: 1, alreadyCurrent: 1 },
  );
});

test("operator command requires separate credentials before touching a manifest", async () => {
  const environment = migrationEnvironment();
  let reads = 0;
  let fetches = 0;
  const result = await executeLegacyIndicationSummaryMigrationCommand(
    ["--apply", "--manifest", "ignored-private-inventory.json"],
    environment,
    {
      readManifest: async () => {
        reads += 1;
        return manifest([]);
      },
      fetch: async () => {
        fetches += 1;
        throw new Error("No request is expected for an empty inventory.");
      },
    },
  );
  assert.deepEqual(result, { scanned: 0, migrated: 0, alreadyCurrent: 0 });
  assert.equal(reads, 1);
  assert.equal(fetches, 0);
  assert.deepEqual(Object.keys(result).sort(), [
    "alreadyCurrent",
    "migrated",
    "scanned",
  ]);

  for (const [argv, env] of [
    [["--manifest", "private.json"], environment],
    [["--apply", "--manifest", "private.json"], {
      ...environment,
      AITTADB_MIGRATION_CLIENT_SECRET: undefined,
    }],
  ] as const) {
    let touched = false;
    await assert.rejects(() =>
      executeLegacyIndicationSummaryMigrationCommand(argv, env, {
        readManifest: async () => {
          touched = true;
          return manifest([]);
        },
        fetch: async () => {
          touched = true;
          throw new Error("Unexpected fetch.");
        },
      })
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
    "AITTADB_OAUTH_TRANSACTION_KEY",
    "AITTADB_OAUTH_CSRF_KEY",
    "OWNER_INDICATION_REVIEW_KEY",
  ] as const;
  for (const migrationKey of migrationKeys) {
    for (const reusedKey of separationKeys) {
      if (migrationKey === reusedKey) continue;
      const reusedValue = environment[reusedKey];
      let touched = false;
      await assert.rejects(
        () => executeLegacyIndicationSummaryMigrationCommand(
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
            "Legacy indication summary migration configuration is invalid." &&
          !error.message.includes(reusedValue),
        `${migrationKey} must not reuse ${reusedKey}`,
      );
      assert.equal(touched, false);
    }
  }

  for (const migrationKey of [
    "AITTADB_MIGRATION_CLIENT_SECRET",
    "AITTADB_MIGRATION_OPERATOR_KEY",
  ] as const) {
    let touched = false;
    await assert.rejects(
      () => executeLegacyIndicationSummaryMigrationCommand(
        ["--apply", "--manifest", "private.json"],
        {
          ...environment,
          [migrationKey]: environment.OWNER_INDICATION_REVIEW_KEY,
        },
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
          "Legacy indication summary migration configuration is invalid." &&
        !error.message.includes(environment.OWNER_INDICATION_REVIEW_KEY),
      `${migrationKey} must not reuse OWNER_INDICATION_REVIEW_KEY`,
    );
    assert.equal(touched, false);
  }

  const service = new SyntheticAittaDBStorageService({
    issuer: environment.AITTADB_MIGRATION_ISSUER,
    transportOrigin: environment.AITTADB_MIGRATION_TRANSPORT_ORIGIN,
    entryHref: environment.AITTADB_MIGRATION_ENTRY_HREF,
    clientId: environment.AITTADB_MIGRATION_CLIENT_ID,
    clientSecret: environment.AITTADB_MIGRATION_CLIENT_SECRET,
    accessToken: "synthetic-migration-access-token",
    scopes: "storage.read storage.write",
  });
  const missing = await captureAsync(() =>
    executeLegacyIndicationSummaryMigrationCommand(
      ["--apply", "--manifest", "ignored-private-inventory.json"],
      environment,
      {
        readManifest: async () => manifest([entry(ALICE, ALICE_ID)]),
        fetch: service.fetch,
      },
    )
  );
  assert.equal(missing.code, "UNAVAILABLE");
  assert.equal(service.tokenRequests, 1);
  assert.equal(service.discoveryRequests, 1);
  assert.equal(service.transactionRequests, 0);

  const privateUrl = "https://private-value.invalid/path?secret=hidden";
  await assert.rejects(
    () => executeLegacyIndicationSummaryMigrationCommand(
      ["--apply", "--manifest", "private.json"],
      { ...environment, AITTADB_MIGRATION_ISSUER: privateUrl },
      { readManifest: async () => manifest([]) },
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        "Legacy indication summary migration configuration is invalid." &&
      !error.message.includes(privateUrl),
  );
});

test("operator command accepts a maximum canonical manifest", async () => {
  const indications = Array.from(
    { length: MAX_LEGACY_INDICATION_SUMMARY_MIGRATION_ENTRIES },
    (_, index) => entry(
      actorSubject(
        `${"\ud800".repeat(254)}${String.fromCharCode(0xd800 + index)}`,
      ),
      indicationId(
        `m${String(index).padStart(3, "0")}${"x".repeat(124)}`,
      ),
    ),
  );
  const serialized = JSON.stringify(manifest(indications));
  const size = new TextEncoder().encode(serialized).byteLength;
  assert.ok(size > 65_536);
  assert.equal(
    size,
    MAX_LEGACY_INDICATION_SUMMARY_MIGRATION_MANIFEST_BYTES,
  );
  const directory = await mkdtemp(join(tmpdir(), "invest-migration-manifest-"));
  const path = join(directory, "manifest.json");
  try {
    await writeFile(path, serialized, "utf8");
    let fetches = 0;
    await assert.rejects(() =>
      executeLegacyIndicationSummaryMigrationCommand(
        ["--apply", "--manifest", path],
        migrationEnvironment(),
        {
          fetch: async () => {
            fetches += 1;
            throw new Error("Stop after proving the manifest was accepted.");
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
    () => executeLegacyIndicationSummaryMigrationCommand(
      ["--apply", "--manifest", "growing-private.json"],
      migrationEnvironment(),
      {
        openManifest: async () => ({
          stat: async () => ({
            size: MAX_LEGACY_INDICATION_SUMMARY_MIGRATION_MANIFEST_BYTES,
            device: "1",
            inode: "2",
            modifiedAtNanoseconds: "3",
            changedAtNanoseconds: "4",
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
        "Legacy indication summary migration configuration is invalid.",
  );
  assert.equal(reads, 1);
  assert.equal(
    requestedBytes,
    MAX_LEGACY_INDICATION_SUMMARY_MIGRATION_MANIFEST_BYTES + 1,
  );
  assert.equal(closes, 1);
  assert.equal(fetches, 0);
});

test("operator command bounds pathological short manifest reads", async () => {
  let reads = 0;
  let closes = 0;
  let fetches = 0;
  await assert.rejects(
    () => executeLegacyIndicationSummaryMigrationCommand(
      ["--apply", "--manifest", "short-read-private.json"],
      migrationEnvironment(),
      {
        openManifest: async () => ({
          stat: async () => ({
            size: MAX_LEGACY_INDICATION_SUMMARY_MANIFEST_READ_CALLS + 1,
            device: "1",
            inode: "2",
            modifiedAtNanoseconds: "3",
            changedAtNanoseconds: "4",
            isFile: () => true,
          }),
          read: async (buffer, offset) => {
            reads += 1;
            buffer[offset] = 0x20;
            return { bytesRead: 1 };
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
        "Legacy indication summary migration configuration is invalid.",
  );
  assert.equal(reads, MAX_LEGACY_INDICATION_SUMMARY_MANIFEST_READ_CALLS);
  assert.equal(closes, 1);
  assert.equal(fetches, 0);
});

test("operator command rejects same-size in-place manifest replacement", async () => {
  const reviewed = JSON.stringify(manifest([
    entry(ALICE, ALICE_ID),
  ]));
  const replacement = JSON.stringify(manifest([
    entry(
      actorSubject("issuer.invalid/subject:carol-migration"),
      indicationId("indication:migration:carol"),
    ),
  ]));
  assert.notEqual(replacement, reviewed);
  assert.equal(replacement.length, reviewed.length);
  const replacementBytes = new TextEncoder().encode(replacement);
  let stats = 0;
  let reads = 0;
  let closes = 0;
  let fetches = 0;
  await assert.rejects(
    () => executeLegacyIndicationSummaryMigrationCommand(
      ["--apply", "--manifest", "replaced-private.json"],
      migrationEnvironment(),
      {
        openManifest: async () => ({
          stat: async () => {
            stats += 1;
            return {
              size: replacementBytes.byteLength,
              device: "1",
              inode: "2",
              modifiedAtNanoseconds: stats === 1 ? "3" : "5",
              changedAtNanoseconds: stats === 1 ? "4" : "6",
              isFile: () => true,
            };
          },
          read: async (buffer, offset) => {
            reads += 1;
            if (offset !== 0) return { bytesRead: 0 };
            buffer.set(replacementBytes, offset);
            return { bytesRead: replacementBytes.byteLength };
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
        "Legacy indication summary migration configuration is invalid.",
  );
  assert.equal(stats, 2);
  assert.equal(reads, 2);
  assert.equal(closes, 1);
  assert.equal(fetches, 0);
});

test("operator command rejects symlink and directory manifests before reading", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invest-migration-paths-"));
  const target = join(directory, "target.json");
  const link = join(directory, "link.json");
  const nestedDirectory = join(directory, "nested");
  try {
    await writeFile(target, JSON.stringify(manifest([])), "utf8");
    await symlink(target, link);
    await mkdir(nestedDirectory);

    for (const path of [link, nestedDirectory]) {
      await assert.rejects(
        () => executeLegacyIndicationSummaryMigrationCommand(
          ["--apply", "--manifest", path],
          migrationEnvironment(),
          {
            fetch: async () => {
              throw new Error("Unexpected fetch.");
            },
          },
        ),
        (error: unknown) =>
          error instanceof Error &&
          error.message ===
            "Legacy indication summary migration configuration is invalid.",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("operator command rejects a FIFO without waiting for a writer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invest-migration-fifo-"));
  const fifo = join(directory, "manifest.fifo");
  try {
    await execFile("mkfifo", [fifo]);
    const outcome = await Promise.race([
      executeLegacyIndicationSummaryMigrationCommand(
        ["--apply", "--manifest", fifo],
        migrationEnvironment(),
        {
          fetch: async () => {
            throw new Error("Unexpected fetch.");
          },
        },
      ).then(() => "completed", () => "rejected"),
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 1_000);
      }),
    ]);
    assert.equal(outcome, "rejected");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function editedInactiveCompany(
  lifecycle: "withdrawn" | "rejected",
): Promise<Readonly<{
  state: MemoryStorageState;
  storage: MemoryStorageAdapter;
  originalLease: StorageRecord;
  editedLease: StorageRecord;
}>> {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const participant = repository(storage, ALICE);
  await participant.create({
    operationId: `indication-operation:historical-${lifecycle}-create`,
    id: ALICE_ID,
    occurredAt: timestamp(1),
    historyEntryId: `indication-history:historical-${lifecycle}-create`,
    expectedRevision: null,
    fields: companyFields("REG-ORIGINAL"),
  }, await packageContext(ALICE));
  const originalLease = activeLeaseRecord(state);
  await participant.edit({
    operationId: `indication-operation:historical-${lifecycle}-edit`,
    id: ALICE_ID,
    occurredAt: timestamp(2),
    historyEntryId: `indication-history:historical-${lifecycle}-edit`,
    expectedRevision: 1,
    fields: companyFields("REG-EDITED"),
  }, await packageContext(ALICE));
  const editedLease = activeLeaseRecord(state);
  if (lifecycle === "withdrawn") {
    await participant.withdraw(withdrawRequest(ALICE_ID, 3));
  } else {
    await repository(storage, OWNER).reject({
      operationId: "indication-operation:historical-reject",
      id: ALICE_ID,
      occurredAt: timestamp(3),
      historyEntryId: "indication-history:historical-reject",
      expectedRevision: 2,
      reason: "Private historical-coordinate rejection.",
    });
  }
  downgradeCurrent(state, ALICE_ID);
  return Object.freeze({
    state,
    storage,
    originalLease,
    editedLease,
  });
}

function activeLeaseRecord(state: MemoryStorageState): StorageRecord {
  const record = [...state.records.values()].find((candidate) =>
    candidate.key.collection === "investment-indication-active-keys"
  );
  assert(record);
  return structuredClone(record);
}

async function seededLegacy(
  subject: ActorSubject,
  id: InvestmentIndicationId,
  options: Readonly<{ edited?: boolean }> = {},
): Promise<Readonly<{
  state: MemoryStorageState;
  storage: MemoryStorageAdapter;
  snapshot: InvestmentIndication;
}>> {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const snapshot = await seedLegacyInto(storage, state, subject, id, options);
  return Object.freeze({ state, storage, snapshot });
}

async function seedLegacyInto(
  storage: StorageAdapter,
  state: MemoryStorageState,
  subject: ActorSubject,
  id: InvestmentIndicationId,
  options: Readonly<{ edited?: boolean }> = {},
): Promise<InvestmentIndication> {
  const context = await packageContext(subject);
  const bound = repository(storage, subject);
  let snapshot = (await bound.create(
    createRequest(id, `${id}:create`, 1),
    context,
  )).snapshot;
  if (options.edited) {
    snapshot = (await bound.edit(editRequest(id, 2), context)).snapshot;
  }
  downgradeCurrent(state, id);
  return snapshot;
}

function repository(
  storage: StorageAdapter,
  subject: ActorSubject,
): DevelopmentInMemoryIndicationRepository {
  return new DevelopmentInMemoryIndicationRepository(
    storage,
    subject,
    OWNER,
    amount,
  );
}

function createRequest(
  id: InvestmentIndicationId,
  suffix: string,
  revision: number,
): CreateIndicationRequest {
  return {
    operationId: `indication-operation:${suffix}`,
    id,
    occurredAt: timestamp(revision),
    historyEntryId: `indication-history:${suffix}`,
    expectedRevision: null,
    fields: personalFields(`Created revision ${revision}.`),
  };
}

function editRequest(
  id: InvestmentIndicationId,
  revision: number,
): EditIndicationRequest {
  return {
    operationId: `indication-operation:migration-edit-${revision}`,
    id,
    occurredAt: timestamp(revision),
    historyEntryId: `indication-history:migration-edit-${revision}`,
    expectedRevision: revision - 1,
    fields: personalFields(`Edited revision ${revision}.`),
  };
}

function withdrawRequest(
  id: InvestmentIndicationId,
  revision: number,
): WithdrawIndicationRequest {
  return {
    operationId: `indication-operation:migration-withdraw-${revision}`,
    id,
    occurredAt: timestamp(revision),
    historyEntryId: `indication-history:migration-withdraw-${revision}`,
    expectedRevision: revision - 1,
  };
}

function personalFields(note: string): StorageDocument {
  return {
    kind: "personal",
    residenceCountry: "FI",
    amount: 1_000,
    availabilityPeriod: "Within twelve months.",
    note,
  };
}

function companyFields(companyIdentifier: string): StorageDocument {
  return {
    kind: "company",
    companyName: "Historical coordinate company",
    registrationCountry: "FI",
    companyIdentifier,
    representativeName: "Authorized representative",
    representativeAuthorityDeclared: true,
    amount: 2_000,
    availabilityPeriod: "Within twelve months.",
    note: "Historical uniqueness proof.",
  };
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

async function packageContext(
  subject: ActorSubject,
): Promise<TrustedPackageAcknowledgmentContext> {
  const version = await createPackageVersion({
    id: "package-version:migration",
    createdAt: "2026-08-10T00:00:00.000Z",
    changeSummary: "Migration fixture",
    materialChange: true,
    acknowledgmentText: "This indication is non-binding.",
    sections: [{
      id: "package-section:migration",
      order: 0,
      title: "Overview",
      markdown: "Synthetic migration fixture.",
      enabled: true,
    }],
  }, null);
  if (!version.ok) assert.fail(JSON.stringify(version.issues));
  const acceptance = createPackageAcceptance({
    id: `package-acceptance:${subject.endsWith("alice-migration") ? "alice" : "bob"}`,
    participantSubject: subject,
    acceptedAt: "2026-08-10T00:00:30.000Z",
  }, version.value);
  if (!acceptance.ok) assert.fail(JSON.stringify(acceptance.issues));
  return Object.freeze({
    currentVersion: version.value,
    latestAcceptance: acceptance.value,
  });
}

function downgradeCurrent(
  state: MemoryStorageState,
  id: InvestmentIndicationId,
): void {
  const record = currentRecord(state, id);
  const value = { ...record.value } as Record<string, unknown>;
  value.schemaVersion = 5;
  delete value.participantSummary;
  state.records.set(storageKeyString(record.key), Object.freeze({
    key: record.key,
    revision: record.value.revision as number,
    value: Object.freeze(value) as StorageDocument,
  }));
}

async function downgradeIndicationToLegacy(
  state: MemoryStorageState,
  id: InvestmentIndicationId,
  snapshot: InvestmentIndication,
): Promise<void> {
  const fingerprints = new Map<number, string>();
  for (const record of [...state.records.values()]) {
    if (
      record.key.collection !== "investment-indication-history" ||
      record.value.indicationId !== id
    ) continue;
    const value = structuredClone(record.value) as Record<string, unknown>;
    const revision = value.revision as number;
    const history = snapshot.history.find((entry) => entry.revision === revision);
    assert(history);
    const transition = String(value.transitionKind);
    const payload: Record<string, unknown> = {
      kind: transition === "created"
        ? "create"
        : transition === "edited"
        ? "edit"
        : transition === "withdrawn"
        ? "withdraw"
        : transition === "reactivated"
        ? "reactivate"
        : "reject",
      operationId: value.operationId,
      actor: value.actor,
      expectedRevision: revision === 1 ? null : revision - 1,
      id,
      occurredAt: value.occurredAt,
      historyEntryId: value.historyEntryId,
      requestFingerprint: value.requestFingerprint,
      ...(transition === "created" || transition === "edited"
        ? { fields: history.fields }
        : {}),
      ...(transition === "rejected"
        ? {
            reason: (value.rejection as Record<string, unknown>).reason,
          }
        : {}),
    };
    const fingerprint = `sha256:${await testSha256Hex(
      canonicalTestJson(payload),
    )}`;
    value.schemaVersion = 4;
    value.operationFingerprint = fingerprint;
    fingerprints.set(revision, fingerprint);
    state.records.set(storageKeyString(record.key), Object.freeze({
      key: record.key,
      revision: record.revision,
      value: Object.freeze(value) as StorageDocument,
    }));
  }
  assert.equal(fingerprints.size, snapshot.revision);

  for (const record of [...state.records.values()]) {
    if (
      record.value.indicationId !== id ||
      (record.key.collection !== "investment-indication-fields" &&
        record.key.collection !== "investment-indication-active-keys")
    ) continue;
    const value = structuredClone(record.value) as Record<string, unknown>;
    value.schemaVersion = 4;
    state.records.set(storageKeyString(record.key), Object.freeze({
      key: record.key,
      revision: record.revision,
      value: Object.freeze(value) as StorageDocument,
    }));
  }

  const current = currentRecord(state, id);
  const value = structuredClone(current.value) as Record<string, unknown>;
  value.schemaVersion = 4;
  value.operationFingerprint = fingerprints.get(snapshot.revision);
  delete value.participantSummary;
  state.records.set(storageKeyString(current.key), Object.freeze({
    key: current.key,
    revision: snapshot.revision,
    value: Object.freeze(value) as StorageDocument,
  }));
}

function canonicalTestJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalTestJson).join(",")}]`;
  }
  assert.equal(typeof value, "object");
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalTestJson(source[key])}`
  ).join(",")}}`;
}

async function testSha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function currentRecord(
  state: MemoryStorageState,
  id: InvestmentIndicationId,
): StorageRecord {
  const record = [...state.records.values()].find((candidate) =>
    candidate.key.collection === "investment-indications" &&
    candidate.value.indicationId === id
  );
  assert(record);
  return record;
}

function immutableCollectionEvidence(state: MemoryStorageState): string {
  return JSON.stringify([...state.records.values()]
    .filter((record) => record.key.collection !== "investment-indications")
    .sort((left, right) => storageKeyString(left.key).localeCompare(
      storageKeyString(right.key),
    )));
}

function mutateRecordWhere(
  state: MemoryStorageState,
  collection: string,
  predicate: (record: StorageRecord) => boolean,
  mutation: (value: Record<string, unknown>) => void,
): void {
  const record = [...state.records.values()].find((candidate) =>
    candidate.key.collection === collection && predicate(candidate)
  );
  assert(record);
  const value = { ...record.value } as Record<string, unknown>;
  mutation(value);
  state.records.set(storageKeyString(record.key), Object.freeze({
    key: record.key,
    revision: record.revision,
    value: Object.freeze(value) as StorageDocument,
  }));
}

function deleteRecordWhere(
  state: MemoryStorageState,
  collection: string,
  predicate: (record: StorageRecord) => boolean,
): void {
  const record = [...state.records.values()].find((candidate) =>
    candidate.key.collection === collection && predicate(candidate)
  );
  assert(record);
  state.records.delete(storageKeyString(record.key));
}

function manifest(entries: readonly unknown[]): Readonly<{
  schemaVersion: number;
  indications: readonly unknown[];
}> {
  return { schemaVersion: 1, indications: [...entries] };
}

function entry(
  participantSubject: ActorSubject,
  indicationId: InvestmentIndicationId,
): StorageDocument {
  return { participantSubject, indicationId };
}

function timestamp(revision: number): string {
  return new Date(Date.UTC(2026, 7, 10, 0, revision)).toISOString();
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

function storageOperationId(value: string) {
  const parsed = parseStableId<"storage-operation">(value);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function mutableRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
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

function migrationEnvironment(): Record<string, string> {
  return {
    AITTADB_MIGRATION_ISSUER: "https://storage.example.invalid",
    AITTADB_MIGRATION_TRANSPORT_ORIGIN: "https://runtime.example.invalid",
    AITTADB_MIGRATION_ENTRY_HREF:
      "https://storage.example.invalid/storage/discovery",
    AITTADB_MIGRATION_CLIENT_ID: "migration-client-id",
    AITTADB_MIGRATION_CLIENT_SECRET: "synthetic-migration-secret",
    AITTADB_STORAGE_CLIENT_ID: "application-client",
    AITTADB_STORAGE_CLIENT_SECRET: "different-application-secret",
    AITTADB_OAUTH_CLIENT_ID: "interactive-oauth-client",
    AITTADB_OAUTH_CLIENT_SECRET: "interactive-oauth-secret",
    BROWSER_MUTATION_SESSION_KEY: "browser-mutation-session-key",
    AITTADB_OAUTH_TRANSACTION_KEY: "oauth-transaction-proof-key",
    AITTADB_OAUTH_CSRF_KEY: "oauth-csrf-proof-key-material",
    OWNER_INDICATION_REVIEW_KEY: "owner-review-key-material",
  };
}

class ThrowingStorageAdapter implements StorageAdapter {
  read(): Promise<StorageRecord | null> {
    throw new Error("Empty inventory must not read storage.");
  }
  list(): Promise<StoragePage> {
    throw new Error("Migration must not list storage.");
  }
  transact(): Promise<StorageTransactionResult> {
    throw new Error("Empty inventory must not mutate storage.");
  }
}

class CountingStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  reads = 0;
  transactions = 0;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }
  read(key: StorageKey): Promise<StorageRecord | null> {
    this.reads += 1;
    return this.#delegate.read(key);
  }
  list(request: StorageListRequest): Promise<StoragePage> {
    return this.#delegate.list(request);
  }
  transact(request: StorageTransactionRequest): Promise<StorageTransactionResult> {
    this.transactions += 1;
    return this.#delegate.transact(request);
  }
}

class InterleavingStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #interleave: (request: StorageTransactionRequest) => Promise<void>;
  #pending = true;

  constructor(
    delegate: StorageAdapter,
    interleave: (request: StorageTransactionRequest) => Promise<void>,
  ) {
    this.#delegate = delegate;
    this.#interleave = interleave;
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
    if (this.#pending) {
      this.#pending = false;
      await this.#interleave(request);
    }
    return this.#delegate.transact(request);
  }
}

class ResponseLossStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  transactions = 0;

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
    this.transactions += 1;
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
