import assert from "node:assert/strict";
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
import {
  investmentIndicationSummary,
  type InvestmentIndicationParsingOptions,
  type InvestmentIndicationId,
  type TrustedPackageAcknowledgmentContext,
} from "../domain/investment-indication.ts";
import { MAX_INVESTMENT_INDICATION_REVISIONS } from "../domain/investment-indication.ts";
import { projectInvestmentIndicationForAggregation } from "../domain/investment-aggregate.ts";
import {
  createPackageAcceptance,
  createPackageVersion,
  type PackageAcceptanceRecord,
  type PackageVersion,
} from "../domain/package-content.ts";
import {
  StorageFailure,
  parseStorageCollection,
  parseStorageKey,
  storageKeyString,
  toPublicStorageFailure,
  type StorageAdapter,
  type StorageDocument,
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import {
  DevelopmentInMemoryAggregateRepository,
  prepareAtomicAggregateContribution,
} from "../repositories/in-memory-aggregate-repository.ts";
import {
  DevelopmentInMemoryIndicationRepository,
  MAX_INDICATION_CANONICAL_DEPTH,
  MAX_INDICATION_CANONICAL_NODES,
  MAX_INDICATION_FIELDS_CHUNKS,
  MAX_OWNED_INVESTMENT_INDICATIONS,
  readParticipantIndicationOwnershipHead,
  type ParticipantIndicationOwnershipEntry,
} from "../repositories/in-memory-indication-repository.ts";
import {
  MAX_PARTICIPANT_ACTIVE_LEASE_PROOF_READS,
  MAX_PARTICIPANT_ACCOUNT_DELETION_WITHDRAWAL_SET_READS,
  MAX_PARTICIPANT_CAPACITY_READS,
  MAX_PARTICIPANT_INDEX_SNAPSHOT_READS,
  MAX_PARTICIPANT_INVESTMENT_SUMMARY_COLLECTION_READS,
  MAX_PARTICIPANT_OWNERSHIP_CONCURRENT_REPLAY_READS,
  MAX_PARTICIPANT_OWNERSHIP_FIRST_INITIALIZATION_READS,
  MAX_PARTICIPANT_OWNERSHIP_RESTART_READS,
  StorageParticipantInvestmentInterestRepository,
  initializeParticipantInvestmentOwnership,
  stageParticipantAccountDeletionInvestmentWithdrawalSet,
} from "../repositories/storage-participant-investment-repository.ts";
import { StagedStorageTransaction } from "../repositories/staged-storage-transaction.ts";
import { MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS } from "../worker/participant-investment-mutation-port.ts";
import {
  createParticipantInvestmentInterestService,
  type InvestmentInterestPermissions,
} from "../worker/investment-interest-service.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";

const ALICE = subject("issuer.invalid/participant:alice-storage-investment");
const BOB = subject("issuer.invalid/participant:bob-storage-investment");
const OWNER = subject("issuer.invalid/owner:capacity-review");
const AMOUNT = amountConfiguration();
const ALLOW_ALL = Object.freeze({
  createPersonal: true,
  createCompany: true,
  edit: true,
  reactivatePersonal: true,
  reactivateCompany: true,
}) satisfies InvestmentInterestPermissions;

test("ordinary participant access requires explicit ownership initialization", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const acknowledgment = await currentContext(ALICE, "ownership-uninitialized");
  const repository = new StorageParticipantInvestmentInterestRepository(
    storage,
    ALICE,
    AMOUNT,
  );
  const recordsBefore = storedStateFingerprint(state);

  const readFailure = await captureStorageFailure(() => repository.listOwned());
  const writeFailure = await captureStorageFailure(() => serviceFor(
    repository,
    ALICE,
    acknowledgment,
    () => new Date("2026-08-12T10:00:00.000Z"),
  ).create({
    operationId: "investment-operation:ownership-uninitialized",
    fields: personalFields(),
  }));
  for (const failure of [readFailure, writeFailure]) {
    assert.equal(failure.code, "UNAVAILABLE");
    assert.doesNotMatch(
      JSON.stringify(toPublicStorageFailure(failure)),
      /alice-storage-investment|ownership|participant-investment/iu,
    );
  }
  assert.equal(storedStateFingerprint(state), recordsBefore);
  assert.equal(state.operations.size, 0);

  const request = Object.freeze({
    operationId: "investment-ownership-initialization:explicit-empty",
    indications: Object.freeze([]),
  });
  assert.deepEqual(
    await initializeParticipantInvestmentOwnership(storage, ALICE, request),
    { replayed: false, indicationCount: 0, activeCount: 0 },
  );
  assert.deepEqual(
    await initializeParticipantInvestmentOwnership(
      new MemoryStorageAdapter(state),
      ALICE,
      request,
    ),
    { replayed: true, indicationCount: 0, activeCount: 0 },
  );
  assert.equal(recordsIn(state, "participant-investment-ownership-roots").length, 1);
  assert.equal(recordsIn(state, "participant-investment-indexes").length, 1);
  assert.equal(
    recordsIn(state, "investment-indication-ownership-witnesses").length,
    1,
  );
  assert.deepEqual(await repository.listOwned(), []);

  const changedOperation = await captureStorageFailure(() =>
    initializeParticipantInvestmentOwnership(storage, ALICE, {
      operationId: "investment-ownership-initialization:changed",
      indications: [],
    })
  );
  const changedInventory = await captureStorageFailure(() =>
    initializeParticipantInvestmentOwnership(storage, ALICE, {
      ...request,
      indications: [{
        indicationId: "investment-indication:not-present",
        indicationRevision: 1,
        lifecycleStatus: "active",
      }],
    })
  );
  assert.equal(changedOperation.code, "CONFLICT");
  assert.equal(changedInventory.code, "CONFLICT");
});

test("exact initialization replay survives later lifecycle activity and restart", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const request = Object.freeze({
    operationId: "investment-ownership-initialization:lifecycle-replay",
    indications: Object.freeze([]),
  });
  const original = Object.freeze({
    replayed: false,
    indicationCount: 0,
    activeCount: 0,
  });
  const replay = Object.freeze({ ...original, replayed: true });
  assert.deepEqual(
    await initializeParticipantInvestmentOwnership(storage, ALICE, request),
    original,
  );

  const acknowledgment = await currentContext(ALICE, "initialization-lifecycle");
  let minute = 0;
  const repository = new StorageParticipantInvestmentInterestRepository(
    storage,
    ALICE,
    AMOUNT,
  );
  const service = serviceFor(repository, ALICE, acknowledgment, () =>
    new Date(
      Date.parse("2026-08-12T10:00:00.000Z") + minute++ * 60_000,
    )
  );
  const created = await service.create({
    operationId: "investment-operation:initialization-lifecycle-create",
    fields: personalFields(),
  });
  assert.deepEqual(
    await initializeParticipantInvestmentOwnership(
      new MemoryStorageAdapter(state),
      ALICE,
      request,
    ),
    replay,
  );

  const edited = await service.edit({
    operationId: "investment-operation:initialization-lifecycle-edit",
    indicationId: created.snapshot.id,
    expectedRevision: created.snapshot.revision,
    fields: personalFields({ note: "Edited after ownership initialization." }),
  });
  assert.deepEqual(
    await initializeParticipantInvestmentOwnership(
      new MemoryStorageAdapter(state),
      ALICE,
      request,
    ),
    replay,
  );

  const withdrawn = await service.withdraw({
    operationId: "investment-operation:initialization-lifecycle-withdraw",
    indicationId: edited.snapshot.id,
    expectedRevision: edited.snapshot.revision,
  });
  assert.deepEqual(
    await initializeParticipantInvestmentOwnership(
      new MemoryStorageAdapter(state),
      ALICE,
      request,
    ),
    replay,
  );

  const reactivated = await service.reactivate({
    operationId: "investment-operation:initialization-lifecycle-reactivate",
    indicationId: withdrawn.snapshot.id,
    expectedRevision: withdrawn.snapshot.revision,
  });
  await new DevelopmentInMemoryIndicationRepository(
    new MemoryStorageAdapter(state),
    OWNER,
    OWNER,
    AMOUNT,
  ).reject({
    operationId: "indication-operation:initialization-lifecycle-reject",
    id: reactivated.snapshot.id,
    expectedRevision: reactivated.snapshot.revision,
    occurredAt: "2026-08-12T11:00:00.000Z",
    historyEntryId: "indication-history:initialization-lifecycle-reject",
    reason: "Synthetic post-initialization rejection.",
  });
  assert.deepEqual(
    await initializeParticipantInvestmentOwnership(
      new MemoryStorageAdapter(state),
      ALICE,
      request,
    ),
    replay,
  );

  const recordsBeforeChangedReuse = storedStateFingerprint(state);
  const operationsBeforeChangedReuse = state.operations.size;
  const changedReuse = await captureStorageFailure(() =>
    initializeParticipantInvestmentOwnership(storage, ALICE, {
      ...request,
      indications: [{
        indicationId: reactivated.snapshot.id,
        indicationRevision: reactivated.snapshot.revision + 1,
        lifecycleStatus: "rejected",
      }],
    })
  );
  assert.equal(changedReuse.code, "CONFLICT");
  assert.equal(storedStateFingerprint(state), recordsBeforeChangedReuse);
  assert.equal(state.operations.size, operationsBeforeChangedReuse);
});

test("initialization replay fails closed during lifecycle movement and later recovers", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const request = Object.freeze({
    operationId: "investment-ownership-initialization:concurrent-lifecycle",
    indications: Object.freeze([]),
  });
  await initializeParticipantInvestmentOwnership(storage, ALICE, request);
  const acknowledgment = await currentContext(ALICE, "initialization-concurrent");
  const repository = new StorageParticipantInvestmentInterestRepository(
    storage,
    ALICE,
    AMOUNT,
  );
  let hour = 10;
  const service = serviceFor(repository, ALICE, acknowledgment, () =>
    new Date(`2026-08-12T${String(hour++).padStart(2, "0")}:00:00.000Z`)
  );
  const created = await service.create({
    operationId: "investment-operation:initialization-concurrent-create",
    fields: personalFields(),
  });
  const operationsBeforeMovement = state.operations.size;
  const moving = new WitnessReadHookStorageAdapter(storage, async () => {
    await service.withdraw({
      operationId: "investment-operation:initialization-concurrent-withdraw",
      indicationId: created.snapshot.id,
      expectedRevision: created.snapshot.revision,
    });
  }, 2);

  const movingReplay = await captureStorageFailure(() =>
    initializeParticipantInvestmentOwnership(moving, ALICE, request)
  );
  assert.equal(moving.injected, true);
  assert.equal(movingReplay.code, "UNAVAILABLE");
  assert.equal(state.operations.size, operationsBeforeMovement + 1);
  assert.deepEqual(
    await initializeParticipantInvestmentOwnership(
      new MemoryStorageAdapter(state),
      ALICE,
      request,
    ),
    { replayed: true, indicationCount: 0, activeCount: 0 },
  );
  assert.equal(
    (await repository.get(created.snapshot.id))?.lifecycle.status,
    "withdrawn",
  );
});

test("correlated metadata absence fails closed and trusted migration restores four active heads", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, "dual-absence-seed");
  const acknowledgment = await currentContext(ALICE, "dual-absence");
  const repository = new StorageParticipantInvestmentInterestRepository(
    storage,
    ALICE,
    AMOUNT,
  );
  const service = serviceFor(
    repository,
    ALICE,
    acknowledgment,
    () => new Date("2026-08-12T10:00:00.000Z"),
  );
  const active: Awaited<ReturnType<typeof service.create>>[] = [];
  for (let index = 0; index < MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS; index += 1) {
    active.push(await service.create({
      operationId: `investment-operation:dual-absence-${index}`,
      fields: companyFields({
        companyName: `Dual absence company ${index}`,
        companyIdentifier: `DUAL-ABSENCE-${index}`,
      }),
    }));
  }
  const migrationInventory = Object.freeze(active.map(({ snapshot }) =>
    Object.freeze({
      indicationId: snapshot.id,
      indicationRevision: snapshot.revision,
      lifecycleStatus: snapshot.lifecycle.status,
    })
  ));

  deleteOnlyRecordIn(state, "participant-investment-indexes");
  deleteOnlyRecordIn(state, "investment-indication-ownership-witnesses");
  const corruptState = storedStateFingerprint(state);
  const operationsBefore = state.operations.size;
  const reopened = new StorageParticipantInvestmentInterestRepository(
    new MemoryStorageAdapter(state),
    ALICE,
    AMOUNT,
  );
  const readFailure = await captureStorageFailure(() => reopened.listOwned());
  const fifthFailure = await captureStorageFailure(() => serviceFor(
    reopened,
    ALICE,
    acknowledgment,
    () => new Date("2026-08-12T11:00:00.000Z"),
  ).create({
    operationId: "investment-operation:dual-absence-fifth",
    fields: companyFields({
      companyName: "Private dual-absence fifth",
      companyIdentifier: "PRIVATE-DUAL-ABSENCE-FIFTH",
    }),
  }));
  for (const failure of [readFailure, fifthFailure]) {
    assert.equal(failure.code, "UNAVAILABLE");
    assert.doesNotMatch(
      JSON.stringify(toPublicStorageFailure(failure)),
      /PRIVATE-DUAL-ABSENCE|alice-storage-investment|ownership/iu,
    );
  }
  assert.equal(storedStateFingerprint(state), corruptState);
  assert.equal(state.operations.size, operationsBefore);

  deleteOnlyRecordIn(state, "participant-investment-ownership-roots");
  const migrationRequest = Object.freeze({
    operationId: "investment-ownership-initialization:dual-absence-migration",
    indications: migrationInventory,
  });
  assert.deepEqual(
    await initializeParticipantInvestmentOwnership(
      new MemoryStorageAdapter(state),
      ALICE,
      migrationRequest,
    ),
    { replayed: false, indicationCount: 4, activeCount: 4 },
  );
  assert.deepEqual(
    await initializeParticipantInvestmentOwnership(
      new MemoryStorageAdapter(state),
      ALICE,
      migrationRequest,
    ),
    { replayed: true, indicationCount: 4, activeCount: 4 },
  );
  assert.equal(activeOwned(await reopened.listOwned()), 4);
  const restoredState = storedStateFingerprint(state);
  const restoredOperations = state.operations.size;
  const restoredFifth = await captureStorageFailure(() => serviceFor(
    reopened,
    ALICE,
    acknowledgment,
    () => new Date("2026-08-12T12:00:00.000Z"),
  ).create({
    operationId: "investment-operation:dual-absence-restored-fifth",
    fields: companyFields({
      companyName: "Restored fifth remains blocked",
      companyIdentifier: "RESTORED-FIFTH-BLOCKED",
    }),
  }));
  assert.equal(restoredFifth.code, "CONFLICT");
  assert.equal(storedStateFingerprint(state), restoredState);
  assert.equal(state.operations.size, restoredOperations);
});

test("legacy ID-only ownership metadata migrates once to the status summary", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, "legacy-witness-seed");
  const acknowledgment = await currentContext(ALICE, "legacy-witness");
  const repository = new StorageParticipantInvestmentInterestRepository(
    storage,
    ALICE,
    AMOUNT,
  );
  const created = await serviceFor(
    repository,
    ALICE,
    acknowledgment,
    () => new Date("2026-08-12T10:00:00.000Z"),
  ).create({
    operationId: "investment-operation:legacy-witness",
    fields: personalFields(),
  });
  deleteOnlyRecordIn(state, "participant-investment-ownership-roots");
  replaceOwnershipWitnessWithLegacyIds(state);

  const readFailure = await captureStorageFailure(() => repository.listOwned());
  assert.equal(readFailure.code, "UNAVAILABLE");
  const recordsBeforeForeignMigration = storedStateFingerprint(state);
  const operationsBeforeForeignMigration = state.operations.size;
  const foreignMigration = await captureStorageFailure(() =>
    initializeParticipantInvestmentOwnership(storage, BOB, {
      operationId: "investment-ownership-initialization:foreign-legacy",
      indications: [{
        indicationId: created.snapshot.id,
        indicationRevision: created.snapshot.revision,
        lifecycleStatus: created.snapshot.lifecycle.status,
      }],
    })
  );
  assert.equal(foreignMigration.code, "UNAVAILABLE");
  assert.equal(storedStateFingerprint(state), recordsBeforeForeignMigration);
  assert.equal(state.operations.size, operationsBeforeForeignMigration);
  const request = Object.freeze({
    operationId: "investment-ownership-initialization:legacy-witness",
    indications: Object.freeze([Object.freeze({
      indicationId: created.snapshot.id,
      indicationRevision: created.snapshot.revision,
      lifecycleStatus: created.snapshot.lifecycle.status,
    })]),
  });
  assert.deepEqual(
    await initializeParticipantInvestmentOwnership(storage, ALICE, request),
    { replayed: false, indicationCount: 1, activeCount: 1 },
  );
  assert.deepEqual(
    await initializeParticipantInvestmentOwnership(
      new MemoryStorageAdapter(state),
      ALICE,
      request,
    ),
    { replayed: true, indicationCount: 1, activeCount: 1 },
  );
  const witness = recordsIn(
    state,
    "investment-indication-ownership-witnesses",
  )[0];
  assert.equal(witness?.value.schemaVersion, 2);
  assert.deepEqual(await repository.listOwned(), [
    investmentIndicationSummary(created.snapshot),
  ]);
});

test("storage participant investment repository commits one persistent atomic lifecycle", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, "storage-lifecycle-alice");
  const context = await currentContext(ALICE, "storage-lifecycle");
  let hour = 10;
  const repository = new StorageParticipantInvestmentInterestRepository(
    storage,
    ALICE,
    AMOUNT,
  );
  const service = serviceFor(repository, ALICE, context, () =>
    new Date(`2026-08-12T${String(hour++).padStart(2, "0")}:00:00.000Z`)
  );

  const createInput = Object.freeze({
    operationId: "investment-operation:storage-personal-create",
    fields: personalFields(),
  });
  const created = await service.create(createInput);
  assert.equal(created.replayed, false);
  assert.equal(created.snapshot.participantSubject, ALICE);
  assertAggregate(state, 1, 1_250, 1);
  assert.equal(recordsIn(state, "audit-events").length, 1);

  const replay = await service.create(createInput);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.snapshot, created.snapshot);
  assert.equal(state.operations.size, 2);
  const changedRetry = await captureStorageFailure(() => service.create({
    operationId: "investment-operation:storage-personal-create",
    fields: personalFields({ amount: 1_500 }),
  }));
  assert.equal(changedRetry.code, "CONFLICT");
  assertAggregate(state, 1, 1_250, 1);

  const foreignRepository = new StorageParticipantInvestmentInterestRepository(
    new MemoryStorageAdapter(state),
    BOB,
    AMOUNT,
  );
  await initializeEmptyOwnership(storage, BOB, "storage-lifecycle-bob");
  const foreignService = serviceFor(
    foreignRepository,
    BOB,
    await currentContext(BOB, "storage-foreign-operation"),
    () => new Date("2026-08-12T10:00:00.000Z"),
  );
  const foreignMutation = await captureStorageFailure(() =>
    foreignService.create(createInput)
  );
  assert.equal(foreignMutation.code, "CONFLICT");
  assert.deepEqual(await foreignRepository.listOwned(), []);
  assertAggregate(state, 1, 1_250, 1);

  const edited = await service.edit({
    operationId: "investment-operation:storage-personal-edit",
    indicationId: created.snapshot.id,
    expectedRevision: 1,
    fields: personalFields({ amount: 1_750, note: "Edited once." }),
  });
  assert.equal(edited.snapshot.revision, 2);
  assertAggregate(state, 2, 1_750, 1);

  const withdrawn = await service.withdraw({
    operationId: "investment-operation:storage-personal-withdraw",
    indicationId: created.snapshot.id,
    expectedRevision: 2,
  });
  assert.equal(withdrawn.snapshot.lifecycle.status, "withdrawn");
  assertAggregate(state, 3, 0, 0);

  const reactivated = await service.reactivate({
    operationId: "investment-operation:storage-personal-reactivate",
    indicationId: created.snapshot.id,
    expectedRevision: 3,
  });
  assert.equal(reactivated.snapshot.lifecycle.status, "active");
  assertAggregate(state, 4, 1_750, 1);
  assert.equal(recordsIn(state, "audit-events").length, 4);

  const delayedReplay = await service.create(createInput);
  assert.equal(delayedReplay.replayed, true);
  assert.deepEqual(delayedReplay.snapshot, created.snapshot);
  assertAggregate(state, 4, 1_750, 1);
  assert.equal(recordsIn(state, "audit-events").length, 4);

  const restartedRepository =
    new StorageParticipantInvestmentInterestRepository(
      new MemoryStorageAdapter(state),
      ALICE,
      AMOUNT,
    );
  const reopened = await restartedRepository.get(created.snapshot.id);
  assert.deepEqual(reopened, reactivated.snapshot);
  assert.deepEqual(
    await restartedRepository.listOwned(),
    [investmentIndicationSummary(reactivated.snapshot)],
  );
  const foreign = new StorageParticipantInvestmentInterestRepository(
    new MemoryStorageAdapter(state),
    BOB,
    AMOUNT,
  );
  assert.equal(await foreign.get(created.snapshot.id), null);
  assert.deepEqual(await foreign.listOwned(), []);
});

test("atomic exact retries survive amount-policy evolution before current validation", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, "storage-policy-evolution");
  const context = await currentContext(ALICE, "storage-policy-evolution");
  const input = Object.freeze({
    operationId: "investment-operation:storage-policy-evolution",
    fields: personalFields({ amount: 1_250 }),
  });
  const originalRepository = new StorageParticipantInvestmentInterestRepository(
    storage,
    ALICE,
    AMOUNT,
  );
  const original = await serviceFor(
    originalRepository,
    ALICE,
    context,
    () => new Date("2026-08-12T10:00:00.000Z"),
  ).create(input);

  const evolvedAmount = amountConfiguration({
    minimum: 2_000,
    increment: 250,
  });
  const evolvedRepository = new StorageParticipantInvestmentInterestRepository(
    new MemoryStorageAdapter(state),
    ALICE,
    evolvedAmount,
  );
  const evolved = serviceFor(
    evolvedRepository,
    ALICE,
    context,
    () => new Date("2026-08-12T11:00:00.000Z"),
    evolvedAmount,
  );
  const replay = await evolved.create(input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.snapshot, original.snapshot);

  const changed = await captureStorageFailure(() => evolved.create({
    ...input,
    fields: personalFields({ amount: 2_000 }),
  }));
  assert.equal(changed.code, "CONFLICT");
  assertAggregate(state, 1, 1_250, 1);
  assert.equal(recordsIn(state, "audit-events").length, 1);
});

test("withdrawal and exact retry retain the persisted aggregate currency", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, "storage-currency-withdrawal");
  const context = await currentContext(ALICE, "storage-currency-withdrawal");
  const original = serviceFor(
    new StorageParticipantInvestmentInterestRepository(
      storage,
      ALICE,
      AMOUNT,
    ),
    ALICE,
    context,
    () => new Date("2026-08-12T10:00:00.000Z"),
  );
  const created = await original.create({
    operationId: "investment-operation:storage-currency-create",
    fields: personalFields(),
  });

  const evolvedAmount = amountConfiguration({ currency: "usd" });
  const withdrawalInput = Object.freeze({
    operationId: "investment-operation:storage-currency-withdraw",
    indicationId: created.snapshot.id,
    expectedRevision: 1,
  });
  const evolved = serviceFor(
    new StorageParticipantInvestmentInterestRepository(
      new MemoryStorageAdapter(state),
      ALICE,
      evolvedAmount,
    ),
    ALICE,
    context,
    () => new Date("2026-08-12T11:00:00.000Z"),
    evolvedAmount,
  );
  const withdrawn = await evolved.withdraw(withdrawalInput);
  assert.equal(withdrawn.snapshot.lifecycle.status, "withdrawn");
  assert.equal(withdrawn.snapshot.fields.currency, AMOUNT.currency);
  assertAggregate(state, 2, 0, 0);

  const restarted = serviceFor(
    new StorageParticipantInvestmentInterestRepository(
      new MemoryStorageAdapter(state),
      ALICE,
      evolvedAmount,
    ),
    ALICE,
    context,
    () => new Date("2026-08-12T12:00:00.000Z"),
    evolvedAmount,
  );
  const replay = await restarted.withdraw(withdrawalInput);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.snapshot, withdrawn.snapshot);
  assertAggregate(state, 2, 0, 0);
});

test("atomic exact retries survive normalizer evolution without semantic substitution", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, "storage-normalizer-evolution");
  const context = await currentContext(ALICE, "storage-normalizer-evolution");
  const originalOptions: InvestmentIndicationParsingOptions = Object.freeze({
    companyIdentifier: Object.freeze({
      normalize: () => "ORIGINAL-CANONICAL-ID",
    }),
  });
  const evolvedOptions: InvestmentIndicationParsingOptions = Object.freeze({
    companyIdentifier: Object.freeze({
      normalize: (value: string) =>
        value === "Changed raw spelling"
          ? "ORIGINAL-CANONICAL-ID"
          : "EVOLVED-CANONICAL-ID",
    }),
  });
  const input = Object.freeze({
    operationId: "investment-operation:storage-normalizer-evolution",
    fields: companyFields({ companyIdentifier: "Original raw spelling" }),
  });
  const originalRepository = new StorageParticipantInvestmentInterestRepository(
    storage,
    ALICE,
    AMOUNT,
    originalOptions,
  );
  const original = await serviceFor(
    originalRepository,
    ALICE,
    context,
    () => new Date("2026-08-12T10:00:00.000Z"),
  ).create(input);

  const evolvedRepository = new StorageParticipantInvestmentInterestRepository(
    new MemoryStorageAdapter(state),
    ALICE,
    AMOUNT,
    evolvedOptions,
  );
  const evolved = serviceFor(
    evolvedRepository,
    ALICE,
    context,
    () => new Date("2026-08-12T11:00:00.000Z"),
  );
  const replay = await evolved.create(input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.snapshot, original.snapshot);

  const changed = await captureStorageFailure(() => evolved.create({
    ...input,
    fields: companyFields({ companyIdentifier: "Changed raw spelling" }),
  }));
  assert.equal(changed.code, "CONFLICT");
  assertAggregate(state, 1, 2_000, 1);
  assert.equal(recordsIn(state, "audit-events").length, 1);
});

test("storage participant investment repository enforces global company uniqueness", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, "company-alice");
  await initializeEmptyOwnership(storage, BOB, "company-bob");
  const aliceContext = await currentContext(ALICE, "company-alice");
  const bobContext = await currentContext(BOB, "company-bob");
  const aliceRepository = new StorageParticipantInvestmentInterestRepository(
    storage,
    ALICE,
    AMOUNT,
  );
  const bobRepository = new StorageParticipantInvestmentInterestRepository(
    storage,
    BOB,
    AMOUNT,
  );
  const alice = serviceFor(
    aliceRepository,
    ALICE,
    aliceContext,
    () => new Date("2026-08-12T10:00:00.000Z"),
  );
  const bob = serviceFor(
    bobRepository,
    BOB,
    bobContext,
    () => new Date("2026-08-12T10:01:00.000Z"),
  );
  const company = await alice.create({
    operationId: "investment-operation:storage-company-alice",
    fields: companyFields(),
  });
  assert.equal(company.snapshot.kind, "company");
  const failure = await captureStorageFailure(() => bob.create({
    operationId: "investment-operation:storage-company-bob",
    fields: companyFields({ companyName: "Different private label" }),
  }));
  assert.equal(failure.code, "CONFLICT");
  assert.deepEqual(await bobRepository.listOwned(), []);
  assertAggregate(state, 1, 2_000, 1);
  assert.equal(recordsIn(state, "audit-events").length, 1);
});

test("concurrent exact storage commits have one transaction and two successful results", async () => {
  const state = new MemoryStorageState();
  await initializeEmptyOwnership(
    new MemoryStorageAdapter(state),
    ALICE,
    "storage-concurrent",
  );
  const context = await currentContext(ALICE, "storage-concurrent");
  const create = () => {
    const repository = new StorageParticipantInvestmentInterestRepository(
      new MemoryStorageAdapter(state),
      ALICE,
      AMOUNT,
    );
    return serviceFor(
      repository,
      ALICE,
      context,
      () => new Date("2026-08-12T10:00:00.000Z"),
    ).create({
      operationId: "investment-operation:storage-concurrent-create",
      fields: personalFields(),
    });
  };
  const results = await Promise.all([create(), create()]);
  assert.deepEqual(results.map(({ replayed }) => replayed).sort(), [false, true]);
  assert.equal(state.operations.size, 2);
  assert.equal(recordsIn(state, "audit-events").length, 1);
  assertAggregate(state, 1, 1_250, 1);
});

test("active capacity survives withdrawal, rejection, reactivation, and restart", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, "active-capacity-lifecycle");
  const context = await currentContext(ALICE, "active-capacity-lifecycle");
  let minute = 0;
  const repository = new StorageParticipantInvestmentInterestRepository(
    storage,
    ALICE,
    AMOUNT,
  );
  const service = serviceFor(repository, ALICE, context, () =>
    new Date(
      Date.parse("2026-08-12T10:00:00.000Z") + minute++ * 60_000,
    )
  );
  const active: Awaited<ReturnType<typeof service.create>>[] = [];
  for (let index = 0; index < MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS; index += 1) {
    active.push(await service.create({
      operationId: `investment-operation:active-capacity-${index}`,
      fields: companyFields({
        companyName: `Capacity company ${index}`,
        companyIdentifier: `CAPACITY-${index}`,
      }),
    }));
  }
  assert.equal(activeOwned(await repository.listOwned()), 4);

  const recordsAtCapacity = state.records.size;
  const operationsAtCapacity = state.operations.size;
  const fifth = await captureStorageFailure(() => service.create({
    operationId: "investment-operation:active-capacity-fifth",
    fields: companyFields({
      companyName: "Capacity company fifth",
      companyIdentifier: "CAPACITY-FIFTH",
    }),
  }));
  assert.equal(fifth.code, "CONFLICT");
  assert.equal(state.records.size, recordsAtCapacity);
  assert.equal(state.operations.size, operationsAtCapacity);

  const first = active[0];
  assert(first);
  await service.withdraw({
    operationId: "investment-operation:active-capacity-withdraw-first",
    indicationId: first.snapshot.id,
    expectedRevision: first.snapshot.revision,
  });
  const replacement = await service.create({
    operationId: "investment-operation:active-capacity-replacement",
    fields: companyFields({
      companyName: "Capacity replacement company",
      companyIdentifier: "CAPACITY-REPLACEMENT",
    }),
  });
  const blockedReactivation = await captureStorageFailure(() => service.reactivate({
    operationId: "investment-operation:active-capacity-reactivate-blocked",
    indicationId: first.snapshot.id,
    expectedRevision: first.snapshot.revision + 1,
  }));
  assert.equal(blockedReactivation.code, "CONFLICT");

  await service.withdraw({
    operationId: "investment-operation:active-capacity-withdraw-replacement",
    indicationId: replacement.snapshot.id,
    expectedRevision: replacement.snapshot.revision,
  });
  await service.reactivate({
    operationId: "investment-operation:active-capacity-reactivate-first",
    indicationId: first.snapshot.id,
    expectedRevision: first.snapshot.revision + 1,
  });
  const reopened = new StorageParticipantInvestmentInterestRepository(
    new MemoryStorageAdapter(state),
    ALICE,
    AMOUNT,
  );
  assert.equal(activeOwned(await reopened.listOwned()), 4);

  const rejectedTarget = active[1];
  assert(rejectedTarget);
  const rejected = await new DevelopmentInMemoryIndicationRepository(
    storage,
    OWNER,
    OWNER,
    AMOUNT,
  ).reject({
    operationId: "indication-operation:active-capacity-reject",
    id: rejectedTarget.snapshot.id,
    expectedRevision: rejectedTarget.snapshot.revision,
    occurredAt: "2026-08-12T12:00:00.000Z",
    historyEntryId: "indication-history:active-capacity-reject",
    reason: "Synthetic capacity test rejection.",
  });
  await persistAggregateProjection(
    storage,
    rejected.snapshot,
    "aggregate-operation:active-capacity-reject",
  );
  const afterRejection = await service.create({
    operationId: "investment-operation:active-capacity-after-rejection",
    fields: companyFields({
      companyName: "Capacity post-rejection company",
      companyIdentifier: "CAPACITY-POST-REJECTION",
    }),
  });
  assert.equal(afterRejection.snapshot.lifecycle.status, "active");
  assert.equal(activeOwned(await reopened.listOwned()), 4);
  assertAggregate(state, 10, 8_000, 4);
});

test("competing fourth activations cannot admit a fifth and exact retry stays stable", async () => {
  const state = new MemoryStorageState();
  await initializeEmptyOwnership(
    new MemoryStorageAdapter(state),
    ALICE,
    "active-capacity-concurrency",
  );
  const context = await currentContext(ALICE, "active-capacity-concurrency");
  const repository = new StorageParticipantInvestmentInterestRepository(
    new MemoryStorageAdapter(state),
    ALICE,
    AMOUNT,
  );
  const service = serviceFor(
    repository,
    ALICE,
    context,
    () => new Date("2026-08-12T10:00:00.000Z"),
  );
  for (let index = 0; index < 3; index += 1) {
    await service.create({
      operationId: `investment-operation:capacity-concurrent-seed-${index}`,
      fields: companyFields({
        companyName: `Concurrent seed ${index}`,
        companyIdentifier: `CONCURRENT-SEED-${index}`,
      }),
    });
  }
  const inputs = [0, 1].map((index) => Object.freeze({
    operationId: `investment-operation:capacity-concurrent-candidate-${index}`,
    fields: companyFields({
      companyName: `Concurrent candidate ${index}`,
      companyIdentifier: `CONCURRENT-CANDIDATE-${index}`,
    }),
  }));
  const attempts = await Promise.allSettled(inputs.map((input) =>
    service.create(input)
  ));
  const winner = attempts.findIndex((attempt) => attempt.status === "fulfilled");
  const loser = attempts.findIndex((attempt) => attempt.status === "rejected");
  assert.notEqual(winner, -1);
  assert.notEqual(loser, -1);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);

  const exactRetry = await service.create(inputs[winner]!);
  assert.equal(exactRetry.replayed, true);
  const loserRetry = await captureStorageFailure(() => service.create(inputs[loser]!));
  assert.equal(loserRetry.code, "CONFLICT");
  const reopened = new StorageParticipantInvestmentInterestRepository(
    new MemoryStorageAdapter(state),
    ALICE,
    AMOUNT,
  );
  assert.equal(activeOwned(await reopened.listOwned()), 4);
  assertAggregate(state, 4, 8_000, 4);
});

test("missing index or ownership witness fails closed after restart", async (context) => {
  const cases = [
    {
      name: "absent index with an existing active indication",
      collection: "participant-investment-indexes",
    },
    {
      name: "legacy index without its ownership witness",
      collection: "investment-indication-ownership-witnesses",
    },
  ] as const;

  for (const [caseIndex, candidate] of cases.entries()) {
    await context.test(candidate.name, async () => {
      const state = new MemoryStorageState();
      const storage = new MemoryStorageAdapter(state);
      await initializeEmptyOwnership(
        storage,
        ALICE,
        `capacity-missing-pair-${caseIndex}`,
      );
      const acknowledgment = await currentContext(
        ALICE,
        `capacity-missing-pair-${caseIndex}`,
      );
      const repository = new StorageParticipantInvestmentInterestRepository(
        storage,
        ALICE,
        AMOUNT,
      );
      await serviceFor(
        repository,
        ALICE,
        acknowledgment,
        () => new Date("2026-08-12T10:00:00.000Z"),
      ).create({
        operationId: `investment-operation:capacity-missing-pair-${caseIndex}`,
        fields: companyFields({
          companyName: `Private missing-pair company ${caseIndex}`,
          companyIdentifier: `PRIVATE-MISSING-PAIR-${caseIndex}`,
        }),
      });
      deleteOnlyRecordIn(state, candidate.collection);

      const reopened = new StorageParticipantInvestmentInterestRepository(
        new MemoryStorageAdapter(state),
        ALICE,
        AMOUNT,
      );
      const readFailure = await captureStorageFailure(() => reopened.listOwned());
      assert.equal(readFailure.code, "UNAVAILABLE");
      const recordsBefore = storedStateFingerprint(state);
      const operationsBefore = state.operations.size;
      const failure = await captureStorageFailure(() =>
        serviceFor(
          reopened,
          ALICE,
          acknowledgment,
          () => new Date("2026-08-12T11:00:00.000Z"),
        ).create({
          operationId:
            `investment-operation:capacity-missing-pair-retry-${caseIndex}`,
          fields: companyFields({
            companyName: "Must remain private and uncommitted",
            companyIdentifier: `PRIVATE-MISSING-PAIR-RETRY-${caseIndex}`,
          }),
        })
      );
      assert.equal(failure.code, "UNAVAILABLE");
      assert.doesNotMatch(
        JSON.stringify(toPublicStorageFailure(failure)),
        /PRIVATE-MISSING-PAIR|alice-storage-investment|ownership-witness/iu,
      );
      assert.equal(storedStateFingerprint(state), recordsBefore);
      assert.equal(state.operations.size, operationsBefore);
    });
  }
});

test("a hidden fifth current record and contribution block create and reactivation", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, "capacity-hidden-fifth");
  const acknowledgment = await currentContext(ALICE, "capacity-hidden-fifth");
  const repository = new StorageParticipantInvestmentInterestRepository(
    storage,
    ALICE,
    AMOUNT,
  );
  const service = serviceFor(
    repository,
    ALICE,
    acknowledgment,
    () => new Date("2026-08-12T10:00:00.000Z"),
  );
  const initial: Awaited<ReturnType<typeof service.create>>[] = [];
  for (let index = 0; index < MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS; index += 1) {
    initial.push(await service.create({
      operationId: `investment-operation:hidden-fifth-seed-${index}`,
      fields: companyFields({
        companyName: `Hidden fifth seed ${index}`,
        companyIdentifier: `HIDDEN-FIFTH-SEED-${index}`,
      }),
    }));
  }
  const withdrawnTarget = initial[0];
  assert(withdrawnTarget);
  await service.withdraw({
    operationId: "investment-operation:hidden-fifth-withdraw",
    indicationId: withdrawnTarget.snapshot.id,
    expectedRevision: withdrawnTarget.snapshot.revision,
  });
  await service.create({
    operationId: "investment-operation:hidden-fifth-replacement",
    fields: companyFields({
      companyName: "Visible fourth active company",
      companyIdentifier: "VISIBLE-FOURTH-ACTIVE",
    }),
  });
  assert.equal(activeOwned(await repository.listOwned()), 4);

  const hidden = await new DevelopmentInMemoryIndicationRepository(
    storage,
    ALICE,
    OWNER,
    AMOUNT,
  ).create({
    operationId: "indication-operation:hidden-fifth-direct",
    id: "investment-indication:hidden-fifth-direct",
    expectedRevision: null,
    occurredAt: "2026-08-12T11:00:00.000Z",
    historyEntryId: "indication-history:hidden-fifth-direct",
    fields: companyFields({
      companyName: "Private hidden fifth company",
      companyIdentifier: "PRIVATE-HIDDEN-FIFTH",
    }),
  }, acknowledgment);
  await persistAggregateProjection(
    storage,
    hidden.snapshot,
    "aggregate-operation:hidden-fifth-direct",
  );
  assert.equal(
    participantIdsIn(state, "participant-investment-indexes").length,
    5,
  );
  assert.equal(
    participantIdsIn(
      state,
      "investment-indication-ownership-witnesses",
    ).length,
    6,
  );
  assertAggregate(state, 7, 10_000, 5);

  const reopened = new StorageParticipantInvestmentInterestRepository(
    new MemoryStorageAdapter(state),
    ALICE,
    AMOUNT,
  );
  const reopenedService = serviceFor(
    reopened,
    ALICE,
    acknowledgment,
    () => new Date("2026-08-12T12:00:00.000Z"),
  );
  const recordsBefore = storedStateFingerprint(state);
  const operationsBefore = state.operations.size;
  const createFailure = await captureStorageFailure(() => reopenedService.create({
    operationId: "investment-operation:hidden-fifth-blocked-create",
    fields: companyFields({
      companyName: "Private blocked sixth company",
      companyIdentifier: "PRIVATE-BLOCKED-SIXTH",
    }),
  }));
  const reactivateFailure = await captureStorageFailure(() =>
    reopenedService.reactivate({
      operationId: "investment-operation:hidden-fifth-blocked-reactivation",
      indicationId: withdrawnTarget.snapshot.id,
      expectedRevision: withdrawnTarget.snapshot.revision + 1,
    })
  );
  for (const failure of [createFailure, reactivateFailure]) {
    assert.equal(failure.code, "UNAVAILABLE");
    assert.doesNotMatch(
      JSON.stringify(toPublicStorageFailure(failure)),
      /PRIVATE-HIDDEN-FIFTH|PRIVATE-BLOCKED-SIXTH|alice-storage-investment/iu,
    );
  }
  assert.equal(storedStateFingerprint(state), recordsBefore);
  assert.equal(state.operations.size, operationsBefore);
});

test("a mixed create and reactivation race admits exactly one fourth active indication", async () => {
  const state = new MemoryStorageState();
  await initializeEmptyOwnership(
    new MemoryStorageAdapter(state),
    ALICE,
    "capacity-mixed-race",
  );
  const acknowledgment = await currentContext(ALICE, "capacity-mixed-race");
  const repository = new StorageParticipantInvestmentInterestRepository(
    new MemoryStorageAdapter(state),
    ALICE,
    AMOUNT,
  );
  const service = serviceFor(
    repository,
    ALICE,
    acknowledgment,
    () => new Date("2026-08-12T10:00:00.000Z"),
  );
  for (let index = 0; index < 3; index += 1) {
    await service.create({
      operationId: `investment-operation:mixed-race-seed-${index}`,
      fields: companyFields({
        companyName: `Mixed race seed ${index}`,
        companyIdentifier: `MIXED-RACE-SEED-${index}`,
      }),
    });
  }
  const withdrawn = await service.create({
    operationId: "investment-operation:mixed-race-withdrawn-candidate",
    fields: companyFields({
      companyName: "Mixed race withdrawn candidate",
      companyIdentifier: "MIXED-RACE-WITHDRAWN",
    }),
  });
  await service.withdraw({
    operationId: "investment-operation:mixed-race-withdraw",
    indicationId: withdrawn.snapshot.id,
    expectedRevision: withdrawn.snapshot.revision,
  });
  const createInput = Object.freeze({
    operationId: "investment-operation:mixed-race-create",
    fields: companyFields({
      companyName: "Mixed race create candidate",
      companyIdentifier: "MIXED-RACE-CREATE",
    }),
  });
  const reactivateInput = Object.freeze({
    operationId: "investment-operation:mixed-race-reactivate",
    indicationId: withdrawn.snapshot.id,
    expectedRevision: withdrawn.snapshot.revision + 1,
  });
  const attempts = await Promise.allSettled([
    service.create(createInput),
    service.reactivate(reactivateInput),
  ]);
  assert.equal(
    attempts.filter((attempt) => attempt.status === "fulfilled").length,
    1,
  );
  assert.equal(
    attempts.filter((attempt) => attempt.status === "rejected").length,
    1,
  );
  const createWon = attempts[0]?.status === "fulfilled";
  const winnerRetry = createWon
    ? await service.create(createInput)
    : await service.reactivate(reactivateInput);
  assert.equal(winnerRetry.replayed, true);
  const loserFailure = await captureStorageFailure(() =>
    createWon
      ? service.reactivate(reactivateInput)
      : service.create(createInput)
  );
  assert.equal(loserFailure.code, "CONFLICT");
  const reopened = new StorageParticipantInvestmentInterestRepository(
    new MemoryStorageAdapter(state),
    ALICE,
    AMOUNT,
  );
  assert.equal(activeOwned(await reopened.listOwned()), 4);
  assertAggregate(state, 6, 8_000, 4);
});

test("a direct reactivation between capacity sampling and create staging blocks the create", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, "capacity-direct-race");
  const acknowledgment = await currentContext(ALICE, "capacity-direct-race");
  const seedRepository = new StorageParticipantInvestmentInterestRepository(
    storage,
    ALICE,
    AMOUNT,
  );
  const seedService = serviceFor(
    seedRepository,
    ALICE,
    acknowledgment,
    () => new Date("2026-08-12T10:00:00.000Z"),
  );
  const active: Awaited<ReturnType<typeof seedService.create>>[] = [];
  for (let index = 0; index < 4; index += 1) {
    active.push(await seedService.create({
      operationId: `investment-operation:direct-race-seed-${index}`,
      fields: companyFields({
        companyName: `Direct race seed ${index}`,
        companyIdentifier: `DIRECT-RACE-SEED-${index}`,
      }),
    }));
  }
  const withdrawnTarget = active[0];
  assert(withdrawnTarget);
  await seedService.withdraw({
    operationId: "investment-operation:direct-race-withdraw",
    indicationId: withdrawnTarget.snapshot.id,
    expectedRevision: withdrawnTarget.snapshot.revision,
  });

  let injectedState: string | null = null;
  let injectedOperations = 0;
  const racingStorage = new WitnessReadHookStorageAdapter(storage, async () => {
    const reactivated = await new DevelopmentInMemoryIndicationRepository(
      storage,
      ALICE,
      OWNER,
      AMOUNT,
    ).reactivate({
      operationId: "indication-operation:direct-race-reactivate",
      id: withdrawnTarget.snapshot.id,
      expectedRevision: withdrawnTarget.snapshot.revision + 1,
      occurredAt: "2026-08-12T11:00:00.000Z",
      historyEntryId: "indication-history:direct-race-reactivate",
    }, acknowledgment);
    await persistAggregateProjection(
      storage,
      reactivated.snapshot,
      "aggregate-operation:direct-race-reactivate",
    );
    injectedState = storedStateFingerprint(state);
    injectedOperations = state.operations.size;
  });
  const racingRepository = new StorageParticipantInvestmentInterestRepository(
    racingStorage,
    ALICE,
    AMOUNT,
  );
  const failure = await captureStorageFailure(() =>
    serviceFor(
      racingRepository,
      ALICE,
      acknowledgment,
      () => new Date("2026-08-12T12:00:00.000Z"),
    ).create({
      operationId: "investment-operation:direct-race-blocked-create",
      fields: companyFields({
        companyName: "Private blocked direct-race company",
        companyIdentifier: "PRIVATE-DIRECT-RACE-BLOCKED",
      }),
    })
  );
  assert.equal(failure.code, "UNAVAILABLE");
  assert.equal(racingStorage.injected, true);
  assert(injectedState);
  assert.equal(storedStateFingerprint(state), injectedState);
  assert.equal(state.operations.size, injectedOperations);
  assert.doesNotMatch(
    JSON.stringify(toPublicStorageFailure(failure)),
    /PRIVATE-DIRECT-RACE-BLOCKED|alice-storage-investment/iu,
  );
  const reopened = new StorageParticipantInvestmentInterestRepository(
    new MemoryStorageAdapter(state),
    ALICE,
    AMOUNT,
  );
  assert.equal(activeOwned(await reopened.listOwned()), 4);
  assertAggregate(state, 6, 8_000, 4);
});

test("pre-existing over-capacity and missing indexed state fail closed", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, "active-capacity-corruption");
  const context = await currentContext(ALICE, "active-capacity-corruption");
  const repository = new StorageParticipantInvestmentInterestRepository(
    storage,
    ALICE,
    AMOUNT,
  );
  const service = serviceFor(
    repository,
    ALICE,
    context,
    () => new Date("2026-08-12T10:00:00.000Z"),
  );
  const active: Awaited<ReturnType<typeof service.create>>[] = [];
  for (let index = 0; index < MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS; index += 1) {
    active.push(await service.create({
      operationId: `investment-operation:capacity-corrupt-seed-${index}`,
      fields: companyFields({
        companyName: `Corrupt seed ${index}`,
        companyIdentifier: `CORRUPT-SEED-${index}`,
      }),
    }));
  }
  const legacyFifth = await new DevelopmentInMemoryIndicationRepository(
    storage,
    ALICE,
    OWNER,
    AMOUNT,
  ).create({
    operationId: "indication-operation:capacity-legacy-fifth",
    id: "investment-indication:capacity-legacy-fifth",
    expectedRevision: null,
    occurredAt: "2026-08-12T11:00:00.000Z",
    historyEntryId: "indication-history:capacity-legacy-fifth",
    fields: companyFields({
      companyName: "Legacy fifth company",
      companyIdentifier: "LEGACY-FIFTH",
    }),
  }, context);
  appendParticipantIndexId(state, legacyFifth.snapshot.id);
  const overCapacityRecords = storedStateFingerprint(state);
  const overCapacityOperations = state.operations.size;
  const overCapacity = await captureStorageFailure(() => service.edit({
    operationId: "investment-operation:capacity-overflow-edit",
    indicationId: active[0]!.snapshot.id,
    expectedRevision: active[0]!.snapshot.revision,
    fields: companyFields({
      companyName: "Changed only if unsafe",
      companyIdentifier: "CORRUPT-SEED-0",
    }),
  }));
  assert.equal(overCapacity.code, "UNAVAILABLE");
  assert.equal(storedStateFingerprint(state), overCapacityRecords);
  assert.equal(state.operations.size, overCapacityOperations);

  removeParticipantIndexId(state, legacyFifth.snapshot.id);
  appendParticipantIndexId(
    state,
    indicationIdForOperation("investment-indication:capacity-missing"),
  );
  const corruptRecords = storedStateFingerprint(state);
  const corruptOperations = state.operations.size;
  const corrupt = await captureStorageFailure(() => service.create({
    operationId: "investment-operation:capacity-corrupt-create",
    fields: companyFields({
      companyName: "Corrupt state candidate",
      companyIdentifier: "CORRUPT-CANDIDATE",
    }),
  }));
  assert.equal(corrupt.code, "UNAVAILABLE");
  assert.equal(storedStateFingerprint(state), corruptRecords);
  assert.equal(state.operations.size, corruptOperations);
});

test("a forged non-active summary cannot hide an active terminal transition", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, "capacity-status-corruption");
  const acknowledgment = await currentContext(ALICE, "capacity-status-corruption");
  const repository = new StorageParticipantInvestmentInterestRepository(
    storage,
    ALICE,
    AMOUNT,
  );
  const service = serviceFor(
    repository,
    ALICE,
    acknowledgment,
    () => new Date("2026-08-12T10:00:00.000Z"),
  );
  const created = await service.create({
    operationId: "investment-operation:capacity-status-corruption",
    fields: personalFields(),
  });
  replaceOwnershipWitnessStatus(state, created.snapshot.id, "withdrawn");
  const recordsBefore = storedStateFingerprint(state);
  const operationsBefore = state.operations.size;

  const failure = await captureStorageFailure(() => service.create({
    operationId: "investment-operation:capacity-status-corruption-second",
    fields: personalFields({ note: "Must not be committed." }),
  }));
  assert.equal(failure.code, "UNAVAILABLE");
  assert.doesNotMatch(
    JSON.stringify(toPublicStorageFailure(failure)),
    /alice-storage-investment|Must not be committed|withdrawn/iu,
  );
  assert.equal(storedStateFingerprint(state), recordsBefore);
  assert.equal(state.operations.size, operationsBefore);
});

test("compact ownership heads authenticate active create and edit with exact leases", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, "capacity-active-proof");
  const acknowledgment = await currentContext(ALICE, "capacity-active-proof");
  let minute = 0;
  const service = serviceFor(
    new StorageParticipantInvestmentInterestRepository(
      storage,
      ALICE,
      AMOUNT,
    ),
    ALICE,
    acknowledgment,
    () => new Date(
      Date.parse("2026-08-12T10:00:00.000Z") + minute++ * 60_000,
    ),
  );
  const created = await service.create({
    operationId: "investment-operation:capacity-active-proof-create",
    fields: personalFields(),
  });
  const createdReads = new CountingStorageAdapter(storage);
  assert.deepEqual(
    await readParticipantIndicationOwnershipHead(
      createdReads,
      ALICE,
      created.snapshot.id,
    ),
    {
      indicationId: created.snapshot.id,
      indicationRevision: created.snapshot.revision,
      lifecycleStatus: "active",
    },
  );
  assert.equal(createdReads.readCalls, 4);

  const edited = await service.edit({
    operationId: "investment-operation:capacity-active-proof-edit",
    indicationId: created.snapshot.id,
    expectedRevision: created.snapshot.revision,
    fields: personalFields({ note: "The active edit remains compactly provable." }),
  });
  const editedReads = new CountingStorageAdapter(storage);
  assert.deepEqual(
    await readParticipantIndicationOwnershipHead(
      editedReads,
      ALICE,
      edited.snapshot.id,
    ),
    {
      indicationId: edited.snapshot.id,
      indicationRevision: edited.snapshot.revision,
      lifecycleStatus: "active",
    },
  );
  assert.equal(editedReads.readCalls, 4);
});

test("compact collection summaries authenticate revision-one creation evidence", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, "summary-creation-proof");
  const acknowledgment = await currentContext(ALICE, "summary-creation-proof");
  let minute = 0;
  const service = serviceFor(
    new StorageParticipantInvestmentInterestRepository(
      storage,
      ALICE,
      AMOUNT,
    ),
    ALICE,
    acknowledgment,
    () => new Date(
      Date.parse("2026-08-12T10:00:00.000Z") + minute++ * 60_000,
    ),
  );
  const created = await service.create({
    operationId: "investment-operation:summary-creation-proof-create",
    fields: personalFields(),
  });
  await service.edit({
    operationId: "investment-operation:summary-creation-proof-edit",
    indicationId: created.snapshot.id,
    expectedRevision: 1,
    fields: personalFields({ note: "Current fields remain valid." }),
  });
  replaceHistoryOperationFingerprint(
    state,
    created.snapshot.id,
    1,
    `sha256:${"0".repeat(64)}`,
  );

  const failure = await captureStorageFailure(() =>
    new StorageParticipantInvestmentInterestRepository(
      new MemoryStorageAdapter(state),
      ALICE,
      AMOUNT,
    ).listOwned()
  );
  assert.equal(failure.code, "UNAVAILABLE");
});

test("correlated summary and terminal-kind damage cannot hide an active edit", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, "capacity-terminal-corruption");
  const acknowledgment = await currentContext(ALICE, "capacity-terminal-corruption");
  const repository = new StorageParticipantInvestmentInterestRepository(
    storage,
    ALICE,
    AMOUNT,
  );
  const service = serviceFor(
    repository,
    ALICE,
    acknowledgment,
    () => new Date("2026-08-12T10:00:00.000Z"),
  );
  const created = await service.create({
    operationId: "investment-operation:capacity-terminal-create",
    fields: personalFields(),
  });
  const edited = await service.edit({
    operationId: "investment-operation:capacity-terminal-edit",
    indicationId: created.snapshot.id,
    expectedRevision: created.snapshot.revision,
    fields: personalFields({ note: "Still active before corruption." }),
  });
  replaceOwnershipWitnessStatus(state, edited.snapshot.id, "withdrawn");
  replaceTerminalTransitionKind(
    state,
    edited.snapshot.id,
    edited.snapshot.revision,
    "withdrawn",
  );
  const recordsBefore = storedStateFingerprint(state);
  const operationsBefore = state.operations.size;

  const failure = await captureStorageFailure(() => service.create({
    operationId: "investment-operation:capacity-terminal-second",
    fields: personalFields({ note: "Must remain absent." }),
  }));
  assert.equal(failure.code, "UNAVAILABLE");
  assert.equal(storedStateFingerprint(state), recordsBefore);
  assert.equal(state.operations.size, operationsBefore);
});

test("withdrawn terminal rewritten as edited cannot create after correlated active damage", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, "capacity-withdrawn-active-damage");
  const acknowledgment = await currentContext(
    ALICE,
    "capacity-withdrawn-active-damage",
  );
  let minute = 0;
  const service = serviceFor(
    new StorageParticipantInvestmentInterestRepository(
      storage,
      ALICE,
      AMOUNT,
    ),
    ALICE,
    acknowledgment,
    () => new Date(
      Date.parse("2026-08-12T10:00:00.000Z") + minute++ * 60_000,
    ),
  );
  const created = await service.create({
    operationId: "investment-operation:capacity-withdrawn-damage-create",
    fields: personalFields(),
  });
  const withdrawn = await service.withdraw({
    operationId: "investment-operation:capacity-withdrawn-damage-withdraw",
    indicationId: created.snapshot.id,
    expectedRevision: created.snapshot.revision,
  });
  replaceOwnershipWitnessStatus(state, withdrawn.snapshot.id, "active");
  replaceTerminalTransitionKind(
    state,
    withdrawn.snapshot.id,
    withdrawn.snapshot.revision,
    "edited",
  );
  const recordsBefore = storedStateFingerprint(state);
  const operationsBefore = state.operations.size;

  const failure = await captureStorageFailure(() => service.create({
    operationId: "investment-operation:capacity-withdrawn-damage-second",
    fields: personalFields({ note: "Must not commit after forged activation." }),
  }));
  assert.equal(failure.code, "UNAVAILABLE");
  assert.equal(storedStateFingerprint(state), recordsBefore);
  assert.equal(state.operations.size, operationsBefore);
});

test("ownership initialization and capacity reject damaged active leases", async (t) => {
  const cases = Object.freeze([
    Object.freeze({
      name: "missing lease",
      damage: (state: MemoryStorageState) => {
        const [entry] = recordsWithIdentitiesIn(
          state,
          "investment-indication-active-keys",
        );
        assert(entry);
        state.records.delete(entry[0]);
      },
    }),
    Object.freeze({
      name: "crossed indication",
      damage: (state: MemoryStorageState) => {
        replaceOnlyActiveLease(state, {
          indicationId: indicationIdForOperation(
            "investment-operation:crossed-active-lease",
          ),
        });
      },
    }),
    Object.freeze({
      name: "corrupt fingerprint",
      damage: (state: MemoryStorageState) => {
        replaceOnlyActiveLease(state, {
          uniquenessFingerprint: `sha256:${"0".repeat(64)}`,
        });
      },
    }),
  ]);

  for (const [index, candidate] of cases.entries()) {
    await t.test(candidate.name, async () => {
      const state = new MemoryStorageState();
      const storage = new MemoryStorageAdapter(state);
      const suffix = `active-lease-proof-${index}`;
      const acknowledgment = await currentContext(ALICE, suffix);
      const indicationId = indicationIdForOperation(
        `investment-operation:${suffix}-seed`,
      );
      const created = await new DevelopmentInMemoryIndicationRepository(
        storage,
        ALICE,
        OWNER,
        AMOUNT,
      ).create({
        operationId: `indication-operation:${suffix}-seed`,
        id: indicationId,
        expectedRevision: null,
        occurredAt: "2026-08-12T10:00:00.000Z",
        historyEntryId: `indication-history:${suffix}-seed`,
        fields: personalFields(),
      }, acknowledgment);
      candidate.damage(state);
      const recordsBefore = storedStateFingerprint(state);
      const operationsBefore = state.operations.size;

      const initializationFailure = await captureStorageFailure(() =>
        initializeParticipantInvestmentOwnership(storage, ALICE, {
          operationId: `investment-ownership-initialization:${suffix}`,
          indications: [{
            indicationId,
            indicationRevision: created.snapshot.revision,
            lifecycleStatus: "active",
          }],
        })
      );
      assert.equal(initializationFailure.code, "UNAVAILABLE");
      assert.equal(
        recordsIn(state, "participant-investment-ownership-roots").length,
        0,
      );
      assert.equal(recordsIn(state, "participant-investment-indexes").length, 0);

      const laterCreateFailure = await captureStorageFailure(() => serviceFor(
        new StorageParticipantInvestmentInterestRepository(
          new MemoryStorageAdapter(state),
          ALICE,
          AMOUNT,
        ),
        ALICE,
        acknowledgment,
        () => new Date("2026-08-12T11:00:00.000Z"),
      ).create({
        operationId: `investment-operation:${suffix}-later-create`,
        fields: personalFields({ note: "Must not create a duplicate active scope." }),
      }));
      assert.equal(laterCreateFailure.code, "UNAVAILABLE");
      assert.equal(storedStateFingerprint(state), recordsBefore);
      assert.equal(state.operations.size, operationsBefore);

      const capacityState = new MemoryStorageState();
      const capacityStorage = new MemoryStorageAdapter(capacityState);
      await initializeEmptyOwnership(
        capacityStorage,
        ALICE,
        `${suffix}-capacity`,
      );
      const capacityService = serviceFor(
        new StorageParticipantInvestmentInterestRepository(
          capacityStorage,
          ALICE,
          AMOUNT,
        ),
        ALICE,
        acknowledgment,
        () => new Date("2026-08-12T12:00:00.000Z"),
      );
      await capacityService.create({
        operationId: `investment-operation:${suffix}-capacity-seed`,
        fields: personalFields(),
      });
      candidate.damage(capacityState);
      const capacityRecordsBefore = storedStateFingerprint(capacityState);
      const capacityOperationsBefore = capacityState.operations.size;
      const capacityFailure = await captureStorageFailure(() =>
        capacityService.create({
          operationId: `investment-operation:${suffix}-capacity-later`,
          fields: personalFields({ note: "Capacity must reject the damaged lease." }),
        })
      );
      assert.equal(capacityFailure.code, "UNAVAILABLE");
      assert.equal(storedStateFingerprint(capacityState), capacityRecordsBefore);
      assert.equal(capacityState.operations.size, capacityOperationsBefore);
    });
  }
});

test("ownership movement between bounded witness samples fails without outer mutation", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, "capacity-moving-sample");
  const acknowledgment = await currentContext(ALICE, "capacity-moving-sample");
  const seedRepository = new StorageParticipantInvestmentInterestRepository(
    storage,
    ALICE,
    AMOUNT,
  );
  const created = await serviceFor(
    seedRepository,
    ALICE,
    acknowledgment,
    () => new Date("2026-08-12T10:00:00.000Z"),
  ).create({
    operationId: "investment-operation:capacity-moving-sample",
    fields: personalFields(),
  });

  let injectedState: string | null = null;
  let injectedOperations = 0;
  const movingStorage = new WitnessReadHookStorageAdapter(storage, async () => {
    const withdrawn = await new DevelopmentInMemoryIndicationRepository(
      storage,
      ALICE,
      OWNER,
      AMOUNT,
    ).withdraw({
      operationId: "indication-operation:capacity-moving-withdraw",
      id: created.snapshot.id,
      expectedRevision: created.snapshot.revision,
      occurredAt: "2026-08-12T11:00:00.000Z",
      historyEntryId: "indication-history:capacity-moving-withdraw",
    });
    await persistAggregateProjection(
      storage,
      withdrawn.snapshot,
      "aggregate-operation:capacity-moving-withdraw",
    );
    injectedState = storedStateFingerprint(state);
    injectedOperations = state.operations.size;
  }, 2);
  const movingRepository = new StorageParticipantInvestmentInterestRepository(
    movingStorage,
    ALICE,
    AMOUNT,
  );
  const failure = await captureStorageFailure(() => serviceFor(
    movingRepository,
    ALICE,
    acknowledgment,
    () => new Date("2026-08-12T12:00:00.000Z"),
  ).create({
    operationId: "investment-operation:capacity-moving-blocked-create",
    fields: personalFields({ note: "Private moving-state candidate." }),
  }));
  assert.equal(failure.code, "UNAVAILABLE");
  assert.equal(movingStorage.injected, true);
  assert(injectedState);
  assert.equal(storedStateFingerprint(state), injectedState);
  assert.equal(state.operations.size, injectedOperations);
  assert.doesNotMatch(
    JSON.stringify(toPublicStorageFailure(failure)),
    /Private moving-state|alice-storage-investment/iu,
  );
});

test("atomic contribution work stays constant-read with unrelated indications", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  for (let index = 0; index < 24; index += 1) {
    const actor = subject(`issuer.invalid/participant:bounded-${index}`);
    await initializeEmptyOwnership(storage, actor, `bounded-${index}`);
    const repository = new StorageParticipantInvestmentInterestRepository(
      storage,
      actor,
      AMOUNT,
    );
    await serviceFor(
      repository,
      actor,
      await currentContext(actor, `bounded-${index}`),
      () => new Date("2026-08-12T10:00:00.000Z"),
    ).create({
      operationId: `investment-operation:bounded-${index}`,
      fields: personalFields(),
    });
  }

  const actor = subject("issuer.invalid/participant:bounded-target");
  await initializeEmptyOwnership(storage, actor, "bounded-target");
  const counted = new CountingStorageAdapter(
    new MemoryStorageAdapter(state),
  );
  const repository = new StorageParticipantInvestmentInterestRepository(
    counted,
    actor,
    AMOUNT,
  );
  await serviceFor(
    repository,
    actor,
    await currentContext(actor, "bounded-target"),
    () => new Date("2026-08-12T10:00:00.000Z"),
  ).create({
    operationId: "investment-operation:bounded-target",
    fields: personalFields(),
  });

  assert.equal(counted.listCalls, 0);
  assert.equal(counted.readCalls, 23);
  assertAggregate(state, 25, 31_250, 25);
});

test("capacity checks 100 fully materialized maximum histories within its read ceiling", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const indications = await seedMaximumOwnershipHeads(state, ALICE);
  const activeLeaseProofReads = observedActiveLeaseProofReads(state, indications);
  const observedHeadReads =
    2 * MAX_OWNED_INVESTMENT_INDICATIONS + activeLeaseProofReads;
  const observedCapacityReads =
    MAX_PARTICIPANT_INDEX_SNAPSHOT_READS + observedHeadReads;
  const operationsBeforeInitialization = state.operations.size;
  const overCapacityInventory = Object.freeze(indications.map((entry, index) =>
    index === MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS
      ? Object.freeze({ ...entry, lifecycleStatus: "active" as const })
      : entry
  ));
  const headsBefore = storedStateFingerprint(state);
  const overCapacityInitialization = await captureStorageFailure(() =>
    initializeParticipantInvestmentOwnership(storage, ALICE, {
      operationId: "investment-ownership-initialization:over-capacity",
      indications: overCapacityInventory,
    })
  );
  assert.equal(overCapacityInitialization.code, "UNAVAILABLE");
  assert.equal(storedStateFingerprint(state), headsBefore);
  assert.equal(state.operations.size, operationsBeforeInitialization);

  const initializationStorage = new CountingStorageAdapter(storage);
  const initialization = await initializeParticipantInvestmentOwnership(
    initializationStorage,
    ALICE,
    {
      operationId: "investment-ownership-initialization:maximum-shape",
      indications,
    },
  );
  assert.deepEqual(initialization, {
    replayed: false,
    indicationCount: MAX_OWNED_INVESTMENT_INDICATIONS,
    activeCount: MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS,
  });
  assert.equal(initializationStorage.listCalls, 0);
  assert.equal(
    initializationStorage.readCalls,
    3 + observedHeadReads,
  );
  assert.ok(
    initializationStorage.readCalls <=
      MAX_PARTICIPANT_OWNERSHIP_FIRST_INITIALIZATION_READS,
  );
  assert.equal(indications.length, MAX_OWNED_INVESTMENT_INDICATIONS);
  assert.equal(indications.every(({ indicationId }) => indicationId.length === 128), true);
  assert.equal(recordsIn(state, "investment-indications").length, 100);
  assert.equal(
    recordsIn(state, "investment-indication-history").length,
    MAX_OWNED_INVESTMENT_INDICATIONS * MAX_INVESTMENT_INDICATION_REVISIONS -
      MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS,
  );
  assert.equal(
    recordsIn(state, "investment-indication-fields").length,
    MAX_OWNED_INVESTMENT_INDICATIONS *
      (MAX_INVESTMENT_INDICATION_REVISIONS - 1),
  );
  assert.equal(
    indications.every(({ indicationRevision, lifecycleStatus }) =>
      indicationRevision ===
        (lifecycleStatus === "active"
          ? MAX_INVESTMENT_INDICATION_REVISIONS - 1
          : MAX_INVESTMENT_INDICATION_REVISIONS)
    ),
    true,
  );
  const witness = recordsIn(
    state,
    "investment-indication-ownership-witnesses",
  )[0];
  assert(witness);
  assert.equal(
    new TextEncoder().encode(JSON.stringify(witness.value)).byteLength <= 65_536,
    true,
  );

  const collectionStorage = new CountingStorageAdapter(
    new MemoryStorageAdapter(state),
  );
  const summaries = await new StorageParticipantInvestmentInterestRepository(
    collectionStorage,
    ALICE,
    AMOUNT,
  ).listOwned();
  assert.equal(summaries.length, MAX_OWNED_INVESTMENT_INDICATIONS);
  assert.equal(collectionStorage.listCalls, 0);
  assert.ok(
    collectionStorage.readCalls <=
      MAX_PARTICIPANT_INVESTMENT_SUMMARY_COLLECTION_READS,
    `${collectionStorage.readCalls} summary reads exceeded the collection ceiling`,
  );

  const restartStorage = new CountingStorageAdapter(
    new MemoryStorageAdapter(state),
  );
  assert.deepEqual(
    await initializeParticipantInvestmentOwnership(
      restartStorage,
      ALICE,
      {
        operationId: "investment-ownership-initialization:maximum-shape",
        indications,
      },
    ),
    {
      replayed: true,
      indicationCount: MAX_OWNED_INVESTMENT_INDICATIONS,
      activeCount: MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS,
    },
  );
  assert.equal(
    restartStorage.readCalls,
    1 + observedCapacityReads,
  );
  assert.ok(restartStorage.readCalls <= MAX_PARTICIPANT_OWNERSHIP_RESTART_READS);

  const context = await currentContext(ALICE, "storage-index-ceiling");
  const counted = new CountingStorageAdapter(
    new MemoryStorageAdapter(state),
  );
  const reopened = new StorageParticipantInvestmentInterestRepository(
    counted,
    ALICE,
    AMOUNT,
  );
  const recordsBefore = storedStateFingerprint(state);
  const operationsBefore = state.operations.size;
  const failure = await captureStorageFailure(() => serviceFor(
    reopened,
    ALICE,
    context,
    () => new Date("2026-08-12T11:00:00.000Z"),
  ).create({
    operationId: "investment-operation:index-ceiling-overflow",
    fields: companyFields({
      companyName: "Overflow company",
      companyIdentifier: "SYNTHETIC-OVERFLOW",
    }),
  }));
  assert.equal(failure.code, "CONFLICT");
  assert.equal(counted.listCalls, 0);
  assert.equal(counted.readCalls, 3 + observedCapacityReads);
  assert.ok(counted.readCalls <= 3 + MAX_PARTICIPANT_CAPACITY_READS);
  assert.equal(MAX_PARTICIPANT_INDEX_SNAPSHOT_READS, 4);
  assert.equal(
    MAX_PARTICIPANT_ACTIVE_LEASE_PROOF_READS,
    MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS *
      (MAX_INDICATION_FIELDS_CHUNKS + 1),
  );
  assert.equal(
    MAX_PARTICIPANT_CAPACITY_READS,
    MAX_PARTICIPANT_INDEX_SNAPSHOT_READS +
      2 * MAX_OWNED_INVESTMENT_INDICATIONS +
      MAX_PARTICIPANT_ACTIVE_LEASE_PROOF_READS,
  );
  assert.equal(MAX_PARTICIPANT_ACTIVE_LEASE_PROOF_READS, 36);
  assert.equal(MAX_PARTICIPANT_CAPACITY_READS, 240);
  assert.equal(MAX_PARTICIPANT_OWNERSHIP_FIRST_INITIALIZATION_READS, 239);
  assert.equal(MAX_PARTICIPANT_OWNERSHIP_RESTART_READS, 241);
  assert.equal(MAX_PARTICIPANT_OWNERSHIP_CONCURRENT_REPLAY_READS, 479);
  assert.equal(storedStateFingerprint(state), recordsBefore);
  assert.equal(state.operations.size, operationsBefore);
});

test("concurrent maximum-shape initialization replay stays inside its exact budget", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const indications = await seedMaximumOwnershipHeads(state, ALICE);
  const activeLeaseProofReads = observedActiveLeaseProofReads(state, indications);
  const observedHeadReads =
    2 * MAX_OWNED_INVESTMENT_INDICATIONS + activeLeaseProofReads;
  const observedFirstInitializationReads = 3 + observedHeadReads;
  const observedCapacityReads =
    MAX_PARTICIPANT_INDEX_SNAPSHOT_READS + observedHeadReads;
  const request = Object.freeze({
    operationId: "investment-ownership-initialization:maximum-concurrent",
    indications,
  });
  const racing = new BeforeTransactionStorageAdapter(storage, async () => {
    const winner = await initializeParticipantInvestmentOwnership(
      storage,
      ALICE,
      request,
    );
    assert.equal(winner.replayed, false);
  });
  const counted = new CountingStorageAdapter(racing);
  assert.deepEqual(
    await initializeParticipantInvestmentOwnership(counted, ALICE, request),
    {
      replayed: true,
      indicationCount: MAX_OWNED_INVESTMENT_INDICATIONS,
      activeCount: MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS,
    },
  );
  assert.equal(racing.injected, true);
  assert.equal(counted.listCalls, 0);
  assert.equal(
    counted.readCalls,
    observedFirstInitializationReads + observedCapacityReads,
  );
  assert.ok(
    counted.readCalls <= MAX_PARTICIPANT_OWNERSHIP_CONCURRENT_REPLAY_READS,
  );
});

test("a failed outer transaction leaves no indication, aggregate, audit, index, or receipt", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, "storage-rollback");
  const recordsBefore = storedStateFingerprint(state);
  const operationsBefore = state.operations.size;
  const adapter = new FailOnceStorageAdapter(storage);
  const context = await currentContext(ALICE, "storage-rollback");
  const repository = new StorageParticipantInvestmentInterestRepository(
    adapter,
    ALICE,
    AMOUNT,
  );
  const service = serviceFor(
    repository,
    ALICE,
    context,
    () => new Date("2026-08-12T10:00:00.000Z"),
  );
  const input = {
    operationId: "investment-operation:storage-rollback-create",
    fields: personalFields(),
  } as const;

  const failed = await captureStorageFailure(() => service.create(input));
  assert.equal(failed.code, "UNAVAILABLE");
  assert.equal(storedStateFingerprint(state), recordsBefore);
  assert.equal(state.operations.size, operationsBefore);

  const committed = await service.create(input);
  assert.equal(committed.replayed, false);
  assert.equal((await repository.listOwned()).length, 1);
  assertAggregate(state, 1, 1_250, 1);
  assert.equal(recordsIn(state, "audit-events").length, 1);
  assert.equal(recordsIn(state, "participant-investment-indexes").length, 1);
  assert.equal(recordsIn(state, "participant-investment-operations").length, 1);
});

test("transaction result object-key order does not change semantic verification", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, "storage-reordered-result");
  const repository = new StorageParticipantInvestmentInterestRepository(
    new ReorderedResultStorageAdapter(storage),
    ALICE,
    AMOUNT,
  );
  const service = serviceFor(
    repository,
    ALICE,
    await currentContext(ALICE, "storage-reordered-result"),
    () => new Date("2026-08-12T10:00:00.000Z"),
  );
  const created = await service.create({
    operationId: "investment-operation:storage-reordered-result",
    fields: personalFields(),
  });
  assert.equal(created.replayed, false);
  assertAggregate(state, 1, 1_250, 1);
});

test("atomic transaction results reject a closed malformed envelope matrix", async (context) => {
  const cases: readonly Readonly<{
    name: string;
    transform: (result: StorageTransactionResult) => unknown;
  }>[] = [
    {
      name: "extra envelope member",
      transform: (result) => ({ ...result, extra: true }),
    },
    {
      name: "custom envelope prototype",
      transform: (result) => Object.assign(Object.create({}), result),
    },
    {
      name: "records accessor",
      transform: (result) => Object.defineProperty(
        { replayed: result.replayed },
        "records",
        { enumerable: true, get: () => result.records },
      ),
    },
    {
      name: "custom records prototype",
      transform: (result) => ({
        ...result,
        records: Object.setPrototypeOf([...result.records], null),
      }),
    },
    {
      name: "sparse records",
      transform: (result) => {
        const records = new Array(result.records.length);
        records[0] = result.records[0];
        return { ...result, records };
      },
    },
    {
      name: "reversed record order",
      transform: (result) => ({
        ...result,
        records: [...result.records].reverse(),
      }),
    },
    {
      name: "extra record member",
      transform: (result) => replaceFirstResultRecord(
        result,
        (record) => ({ ...record, extra: true }),
      ),
    },
    {
      name: "extra key member",
      transform: (result) => replaceFirstResultRecord(
        result,
        (record) => ({ ...record, key: { ...record.key, extra: true } }),
      ),
    },
    {
      name: "changed record value",
      transform: (result) => replaceFirstResultRecord(
        result,
        (record) => ({ ...record, value: { changed: true } }),
      ),
    },
    {
      name: "over-depth record value",
      transform: (result) => replaceFirstResultRecord(
        result,
        (record) => ({
          ...record,
          value: nestedCanonicalValue(MAX_INDICATION_CANONICAL_DEPTH + 1),
        }),
      ),
    },
    {
      name: "over-node record value",
      transform: (result) => replaceFirstResultRecord(
        result,
        (record) => ({
          ...record,
          value: {
            values: Array.from(
              { length: MAX_INDICATION_CANONICAL_NODES },
              () => null,
            ),
          },
        }),
      ),
    },
  ];

  for (const candidate of cases) {
    await context.test(candidate.name, async () => {
      const slug = candidate.name.replaceAll(" ", "-");
      const storage = new MemoryStorageAdapter();
      await initializeEmptyOwnership(storage, ALICE, `malformed-${slug}`);
      const repository = new StorageParticipantInvestmentInterestRepository(
        new ResultTransformStorageAdapter(
          storage,
          candidate.transform,
        ),
        ALICE,
        AMOUNT,
      );
      const service = serviceFor(
        repository,
        ALICE,
        await currentContext(ALICE, `malformed-${slug}`),
        () => new Date("2026-08-12T10:00:00.000Z"),
      );
      const failure = await captureStorageFailure(() => service.create({
        operationId: `investment-operation:malformed-${slug}`,
        fields: personalFields(),
      }));
      assert.equal(failure.code, "UNAVAILABLE");
      assert.doesNotMatch(String(failure), /malformed|private|extra|changed/iu);
    });
  }
});

test("stored operation receipts and ownership metadata require closed envelopes", async (context) => {
  const cases: readonly Readonly<{
    name: string;
    collection: string;
    transform(record: StorageRecord): unknown;
    replay: boolean;
  }>[] = [
    {
      name: "receipt extra member",
      collection: "participant-investment-operations",
      transform: (record) => ({ ...record, privateDetail: "not disclosed" }),
      replay: true,
    },
    {
      name: "receipt key accessor",
      collection: "participant-investment-operations",
      transform: (record) => Object.defineProperty(
        { revision: record.revision, value: record.value },
        "key",
        {
          enumerable: true,
          get: () => {
            throw new Error("private receipt getter");
          },
        },
      ),
      replay: true,
    },
    {
      name: "index custom prototype",
      collection: "participant-investment-indexes",
      transform: (record) => Object.assign(Object.create({}), record),
      replay: false,
    },
    {
      name: "index extra key member",
      collection: "participant-investment-indexes",
      transform: (record) => ({
        ...record,
        key: { ...record.key, privateDetail: "not disclosed" },
      }),
      replay: false,
    },
    {
      name: "ownership root extra value member",
      collection: "participant-investment-ownership-roots",
      transform: (record) => ({
        ...record,
        value: { ...record.value, privateDetail: "not disclosed" },
      }),
      replay: false,
    },
    {
      name: "ownership root operation accessor",
      collection: "participant-investment-ownership-roots",
      transform: (record) => ({
        ...record,
        value: Object.defineProperty(
          { ...record.value },
          "operationId",
          {
            enumerable: true,
            get: () => {
              throw new Error("private root getter");
            },
          },
        ),
      }),
      replay: false,
    },
    {
      name: "ownership witness extra member",
      collection: "investment-indication-ownership-witnesses",
      transform: (record) => ({ ...record, privateDetail: "not disclosed" }),
      replay: false,
    },
    {
      name: "ownership witness entries accessor",
      collection: "investment-indication-ownership-witnesses",
      transform: (record) => ({
        ...record,
        value: Object.defineProperty(
          { ...record.value },
          "indications",
          {
            enumerable: true,
            get: () => {
              throw new Error("private ownership getter");
            },
          },
        ),
      }),
      replay: false,
    },
  ];

  for (const [index, candidate] of cases.entries()) {
    await context.test(candidate.name, async () => {
      const state = new MemoryStorageState();
      const input = Object.freeze({
        operationId: `investment-operation:closed-envelope-${index}`,
        fields: personalFields(),
      });
      const initialRepository =
        new StorageParticipantInvestmentInterestRepository(
          new MemoryStorageAdapter(state),
          ALICE,
          AMOUNT,
        );
      await initializeEmptyOwnership(
        new MemoryStorageAdapter(state),
        ALICE,
        `closed-envelope-${index}`,
      );
      const acknowledgment = await currentContext(
        ALICE,
        `closed-envelope-${index}`,
      );
      await serviceFor(
        initialRepository,
        ALICE,
        acknowledgment,
        () => new Date("2026-08-12T10:00:00.000Z"),
      ).create(input);

      const repository = new StorageParticipantInvestmentInterestRepository(
        new ReadTransformStorageAdapter(
          new MemoryStorageAdapter(state),
          candidate.collection,
          candidate.transform,
        ),
        ALICE,
        AMOUNT,
      );
      const failure = await captureStorageFailure(() =>
        candidate.replay
          ? serviceFor(
            repository,
            ALICE,
            acknowledgment,
            () => new Date("2026-08-12T11:00:00.000Z"),
          ).create(input)
          : repository.listOwned()
      );
      assert.equal(failure.code, "UNAVAILABLE");
      assert.doesNotMatch(
        String(failure),
        /private|receipt getter|not disclosed/iu,
      );
      assert.equal(state.operations.size, 2);
    });
  }
});

test("account deletion stages four active withdrawals once without durable work", async () => {
  const seeded = await seedAccountDeletionActiveSet(4, "deletion-maximum");
  const before = storedStateFingerprint(seeded.state);
  const operationsBefore = seeded.state.operations.size;
  const operationId = "participant-operation:deletion-maximum";
  const counted = new CountingStorageAdapter(
    new MemoryStorageAdapter(seeded.state),
  );
  const firstStaged = new StagedStorageTransaction(counted, operationId);
  const first = await stageParticipantAccountDeletionInvestmentWithdrawalSet(
    firstStaged,
    ALICE,
    AMOUNT,
    {
      operationId,
      requestedAt: "2026-08-12T12:00:00.000Z",
    },
  );
  assert.equal(first.withdrawals.length, 4);
  assert.equal(first.mutationCount, 19);
  assert.deepEqual(first.aggregate, {
    revision: 5,
    totalAmount: 0,
    currency: "EUR",
    contributingIndicationCount: 0,
  });
  assert.equal(
    first.withdrawals.every(({ indication }) =>
      indication.lifecycle.status === "withdrawn" && indication.revision === 2
    ),
    true,
  );
  assert.equal(
    counted.readCalls <= MAX_PARTICIPANT_ACCOUNT_DELETION_WITHDRAWAL_SET_READS,
    true,
  );
  assert.equal(counted.listCalls, 0);
  assert.equal(storedStateFingerprint(seeded.state), before);
  assert.equal(seeded.state.operations.size, operationsBefore);

  const restartedStaged = new StagedStorageTransaction(
    new MemoryStorageAdapter(seeded.state),
    operationId,
  );
  const restarted = await stageParticipantAccountDeletionInvestmentWithdrawalSet(
    restartedStaged,
    ALICE,
    AMOUNT,
    {
      operationId,
      requestedAt: "2026-08-12T12:00:00.000Z",
    },
  );
  assert.deepEqual(restarted, first);
  assert.equal(storedStateFingerprint(seeded.state), before);

  const [firstCommit, restartedCommit] = await Promise.all([
    firstStaged.commit(),
    restartedStaged.commit(),
  ]);
  assert.deepEqual(
    [firstCommit.replayed, restartedCommit.replayed].sort(),
    [false, true],
  );
  assert.equal(firstCommit.records.length, 19);
  assert.equal(restartedCommit.records.length, 19);
  assertAggregate(seeded.state, 5, 0, 0);
  assert.equal(
    recordsIn(seeded.state, "investment-indication-active-keys").length,
    0,
  );
  assert.equal(
    recordsIn(seeded.state, "investment-aggregate-contributions").every(
      ({ value }) => value.status === "withdrawn",
    ),
    true,
  );
  const reopened = new StorageParticipantInvestmentInterestRepository(
    new MemoryStorageAdapter(seeded.state),
    ALICE,
    AMOUNT,
  );
  assert.equal(activeOwned(await reopened.listOwned()), 0);
  assert.equal(
    (await reopened.listOwned()).every(({ status }) => status === "withdrawn"),
    true,
  );
});

test("maximum ownership history remains inside the deletion read ceiling", async () => {
  const state = new MemoryStorageState();
  const indications = await seedMaximumOwnershipHeads(state, ALICE);
  const storage = new MemoryStorageAdapter(state);
  await initializeParticipantInvestmentOwnership(storage, ALICE, {
    operationId: "investment-ownership-initialization:deletion-maximum-history",
    indications,
  });
  seedMaximumActiveAggregate(state, indications);
  const before = storedStateFingerprint(state);
  const counted = new CountingStorageAdapter(new MemoryStorageAdapter(state));
  const operationId = "participant-operation:deletion-maximum-history";
  const result = await stageParticipantAccountDeletionInvestmentWithdrawalSet(
    new StagedStorageTransaction(counted, operationId),
    ALICE,
    AMOUNT,
    { operationId, requestedAt: "2026-08-12T12:00:00.000Z" },
  );
  assert.equal(result.withdrawals.length, 4);
  assert.equal(result.mutationCount, 19);
  assert.equal(
    result.withdrawals.every(({ indication }) =>
      indication.revision === MAX_INVESTMENT_INDICATION_REVISIONS &&
      indication.lifecycle.status === "withdrawn"
    ),
    true,
  );
  assert.deepEqual(result.aggregate, {
    revision: 2,
    totalAmount: 0,
    currency: "EUR",
    contributingIndicationCount: 0,
  });
  assert.equal(
    counted.readCalls <= MAX_PARTICIPANT_ACCOUNT_DELETION_WITHDRAWAL_SET_READS,
    true,
  );
  assert.equal(counted.listCalls, 0);
  assert.equal(storedStateFingerprint(state), before);
});

test("account deletion barriers complete withdrawn and rejected ownership", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const context = await currentContext(ALICE, "deletion-inactive");
  const participant = new DevelopmentInMemoryIndicationRepository(
    storage,
    ALICE,
    OWNER,
    AMOUNT,
  );
  const first = await participant.create({
    operationId: "indication-operation:deletion-inactive-withdrawn-create",
    id: "investment-indication:deletion-inactive-withdrawn",
    expectedRevision: null,
    occurredAt: "2026-08-12T09:00:00.000Z",
    historyEntryId: "indication-history:deletion-inactive-withdrawn-create",
    fields: personalFields(),
  }, context);
  const withdrawn = await participant.withdraw({
    operationId: "indication-operation:deletion-inactive-withdrawn",
    id: first.snapshot.id,
    expectedRevision: first.snapshot.revision,
    occurredAt: "2026-08-12T10:00:00.000Z",
    historyEntryId: "indication-history:deletion-inactive-withdrawn",
  });
  const second = await participant.create({
    operationId: "indication-operation:deletion-inactive-rejected-create",
    id: "investment-indication:deletion-inactive-rejected",
    expectedRevision: null,
    occurredAt: "2026-08-12T09:30:00.000Z",
    historyEntryId: "indication-history:deletion-inactive-rejected-create",
    fields: companyFields({ companyIdentifier: "DELETION-INACTIVE-REJECTED" }),
  }, context);
  const rejected = await new DevelopmentInMemoryIndicationRepository(
    storage,
    OWNER,
    OWNER,
    AMOUNT,
  ).reject({
    operationId: "indication-operation:deletion-inactive-rejected",
    id: second.snapshot.id,
    expectedRevision: second.snapshot.revision,
    occurredAt: "2026-08-12T10:30:00.000Z",
    historyEntryId: "indication-history:deletion-inactive-rejected",
    reason: "Synthetic inactive account-deletion fixture.",
  });
  const inventory = [withdrawn.snapshot, rejected.snapshot]
    .map((indication) => ({
      indicationId: indication.id,
      indicationRevision: indication.revision,
      lifecycleStatus: indication.lifecycle.status,
    }))
    .sort((left, right) => left.indicationId < right.indicationId ? -1 : 1);
  await initializeParticipantInvestmentOwnership(storage, ALICE, {
    operationId: "investment-ownership-initialization:deletion-inactive",
    indications: inventory,
  });
  const before = storedStateFingerprint(state);
  const operationsBefore = state.operations.size;
  const operationId = "participant-operation:deletion-inactive";
  const staged = new StagedStorageTransaction(storage, operationId);
  const result = await stageParticipantAccountDeletionInvestmentWithdrawalSet(
    staged,
    ALICE,
    AMOUNT,
    { operationId, requestedAt: "2026-08-12T12:00:00.000Z" },
  );
  assert.deepEqual(result.withdrawals, []);
  assert.equal(result.mutationCount, 2);
  assert.deepEqual(result.aggregate, {
    revision: 0,
    totalAmount: 0,
    currency: "EUR",
    contributingIndicationCount: 0,
  });
  assert.equal(storedStateFingerprint(state), before);
  assert.equal(state.operations.size, operationsBefore);

  await staged.commit();
  assert.equal(state.operations.size, operationsBefore + 1);
  assert.deepEqual(await new StorageParticipantInvestmentInterestRepository(
    storage,
    ALICE,
    AMOUNT,
  ).listOwned(), [
    investmentIndicationSummary(rejected.snapshot),
    investmentIndicationSummary(withdrawn.snapshot),
  ]);
});

test("empty account deletion conflicts with a concurrent indication create", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, "deletion-empty-race");
  const operationId = "participant-operation:deletion-empty-race";
  const staged = new StagedStorageTransaction(storage, operationId);
  const deletion = await stageParticipantAccountDeletionInvestmentWithdrawalSet(
    staged,
    ALICE,
    AMOUNT,
    { operationId, requestedAt: "2026-08-12T12:00:00.000Z" },
  );
  assert.equal(deletion.mutationCount, 2);

  const repository = new StorageParticipantInvestmentInterestRepository(
    storage,
    ALICE,
    AMOUNT,
  );
  await serviceFor(
    repository,
    ALICE,
    await currentContext(ALICE, "deletion-empty-race"),
    () => new Date("2026-08-12T12:01:00.000Z"),
  ).create({
    operationId: "investment-operation:deletion-empty-race-create",
    fields: personalFields(),
  });
  const before = storedStateFingerprint(state);
  const failure = await captureStorageFailure(() => staged.commit());
  assert.equal(failure.code, "PRECONDITION_FAILED");
  assert.equal(storedStateFingerprint(state), before);
  assert.equal(activeOwned(await repository.listOwned()), 1);
});

test("account deletion witness barriers conflict with direct activation", async (t) => {
  await t.test("create", async () => {
    const state = new MemoryStorageState();
    const storage = new MemoryStorageAdapter(state);
    await initializeEmptyOwnership(storage, ALICE, "deletion-direct-create-race");
    const operationId = "participant-operation:deletion-direct-create-race";
    const staged = new StagedStorageTransaction(storage, operationId);
    await stageParticipantAccountDeletionInvestmentWithdrawalSet(
      staged,
      ALICE,
      AMOUNT,
      { operationId, requestedAt: "2026-08-12T12:00:00.000Z" },
    );

    await new DevelopmentInMemoryIndicationRepository(
      storage,
      ALICE,
      OWNER,
      AMOUNT,
    ).create({
      operationId: "indication-operation:deletion-direct-create-race",
      id: "investment-indication:deletion-direct-create-race",
      expectedRevision: null,
      occurredAt: "2026-08-12T12:01:00.000Z",
      historyEntryId: "indication-history:deletion-direct-create-race",
      fields: personalFields(),
    }, await currentContext(ALICE, "deletion-direct-create-race"));
    const before = storedStateFingerprint(state);
    const failure = await captureStorageFailure(() => staged.commit());
    assert.equal(failure.code, "PRECONDITION_FAILED");
    assert.equal(storedStateFingerprint(state), before);
  });

  await t.test("reactivation", async () => {
    const seeded = await seedAccountDeletionActiveSet(
      1,
      "deletion-direct-reactivation-race",
    );
    const created = seeded.created[0];
    assert(created);
    const withdrawn = await seeded.service.withdraw({
      operationId: "investment-operation:deletion-direct-reactivation-withdraw",
      indicationId: created.snapshot.id,
      expectedRevision: created.snapshot.revision,
    });
    const operationId = "participant-operation:deletion-direct-reactivation-race";
    const staged = new StagedStorageTransaction(seeded.storage, operationId);
    await stageParticipantAccountDeletionInvestmentWithdrawalSet(
      staged,
      ALICE,
      AMOUNT,
      { operationId, requestedAt: "2026-08-12T12:02:00.000Z" },
    );

    await new DevelopmentInMemoryIndicationRepository(
      seeded.storage,
      ALICE,
      OWNER,
      AMOUNT,
    ).reactivate({
      operationId: "indication-operation:deletion-direct-reactivation-race",
      id: withdrawn.snapshot.id,
      expectedRevision: withdrawn.snapshot.revision,
      occurredAt: "2026-08-12T12:03:00.000Z",
      historyEntryId: "indication-history:deletion-direct-reactivation-race",
    }, seeded.context);
    const before = storedStateFingerprint(seeded.state);
    const failure = await captureStorageFailure(() => staged.commit());
    assert.equal(failure.code, "PRECONDITION_FAILED");
    assert.equal(storedStateFingerprint(seeded.state), before);
  });
});

test("account-deletion withdrawal staging fails closed on stale durable state", async () => {
  const seeded = await seedAccountDeletionActiveSet(1, "deletion-stale");
  const created = seeded.created[0];
  assert(created);
  const operationId = "participant-operation:deletion-stale";
  const staged = new StagedStorageTransaction(seeded.storage, operationId);
  await stageParticipantAccountDeletionInvestmentWithdrawalSet(
    staged,
    ALICE,
    AMOUNT,
    { operationId, requestedAt: "2026-08-12T12:00:00.000Z" },
  );
  await seeded.service.withdraw({
    operationId: "investment-operation:deletion-stale-overlap",
    indicationId: created.snapshot.id,
    expectedRevision: created.snapshot.revision,
  });
  const before = storedStateFingerprint(seeded.state);
  const operationsBefore = seeded.state.operations.size;
  const failure = await captureStorageFailure(() => staged.commit());
  assert.equal(failure.code, "PRECONDITION_FAILED");
  assert.equal(storedStateFingerprint(seeded.state), before);
  assert.equal(seeded.state.operations.size, operationsBefore);
});

test("account-deletion withdrawal staging rejects over-capacity ownership", async () => {
  const seeded = await seedAccountDeletionActiveSet(4, "deletion-over-capacity");
  const fifth = await new DevelopmentInMemoryIndicationRepository(
    seeded.storage,
    ALICE,
    OWNER,
    AMOUNT,
  ).create({
    operationId: "indication-operation:deletion-over-capacity-fifth",
    id: "investment-indication:deletion-over-capacity-fifth",
    expectedRevision: null,
    occurredAt: "2026-08-12T11:00:00.000Z",
    historyEntryId: "indication-history:deletion-over-capacity-fifth",
    fields: companyFields({
      companyName: "Over-capacity deletion fixture",
      companyIdentifier: "DELETION-OVER-CAPACITY-FIFTH",
    }),
  }, seeded.context);
  appendParticipantIndexId(seeded.state, fifth.snapshot.id);
  const before = storedStateFingerprint(seeded.state);
  const operationsBefore = seeded.state.operations.size;
  const operationId = "participant-operation:deletion-over-capacity";
  const failure = await captureStorageFailure(() =>
    stageParticipantAccountDeletionInvestmentWithdrawalSet(
      new StagedStorageTransaction(seeded.storage, operationId),
      ALICE,
      AMOUNT,
      { operationId, requestedAt: "2026-08-12T12:00:00.000Z" },
    )
  );
  assert.equal(failure.code, "UNAVAILABLE");
  assert.equal(storedStateFingerprint(seeded.state), before);
  assert.equal(seeded.state.operations.size, operationsBefore);
});

test("account-deletion withdrawal staging rejects missing and overflow evidence", async (t) => {
  await t.test("missing active lease", async () => {
    const seeded = await seedAccountDeletionActiveSet(1, "deletion-missing-lease");
    const [lease] = recordsWithIdentitiesIn(
      seeded.state,
      "investment-indication-active-keys",
    );
    assert(lease);
    seeded.state.records.delete(lease[0]);
    const before = storedStateFingerprint(seeded.state);
    const operationId = "participant-operation:deletion-missing-lease";
    const failure = await captureStorageFailure(() =>
      stageParticipantAccountDeletionInvestmentWithdrawalSet(
        new StagedStorageTransaction(seeded.storage, operationId),
        ALICE,
        AMOUNT,
        { operationId, requestedAt: "2026-08-12T12:00:00.000Z" },
      )
    );
    assert.equal(failure.code, "UNAVAILABLE");
    assert.equal(storedStateFingerprint(seeded.state), before);
  });

  await t.test("maximum aggregate revision", async () => {
    const seeded = await seedAccountDeletionActiveSet(1, "deletion-overflow");
    replaceAggregateRevision(seeded.state, Number.MAX_SAFE_INTEGER);
    const before = storedStateFingerprint(seeded.state);
    const operationId = "participant-operation:deletion-overflow";
    const failure = await captureStorageFailure(() =>
      stageParticipantAccountDeletionInvestmentWithdrawalSet(
        new StagedStorageTransaction(seeded.storage, operationId),
        ALICE,
        AMOUNT,
        { operationId, requestedAt: "2026-08-12T12:00:00.000Z" },
      )
    );
    assert.equal(failure.code, "PRECONDITION_FAILED");
    assert.equal(storedStateFingerprint(seeded.state), before);
  });

  await t.test("corrupt aggregate contribution", async () => {
    const seeded = await seedAccountDeletionActiveSet(
      1,
      "deletion-corrupt-contribution",
    );
    replaceFirstAggregateContributionAmount(seeded.state, 9_999);
    const before = storedStateFingerprint(seeded.state);
    const operationId = "participant-operation:deletion-corrupt-contribution";
    const failure = await captureStorageFailure(() =>
      stageParticipantAccountDeletionInvestmentWithdrawalSet(
        new StagedStorageTransaction(seeded.storage, operationId),
        ALICE,
        AMOUNT,
        { operationId, requestedAt: "2026-08-12T12:00:00.000Z" },
      )
    );
    assert.equal(failure.code, "UNAVAILABLE");
    assert.equal(storedStateFingerprint(seeded.state), before);
  });

  await t.test("inflated complete aggregate snapshot", async () => {
    const seeded = await seedAccountDeletionActiveSet(
      1,
      "deletion-corrupt-aggregate",
    );
    replaceAggregateTotal(seeded.state, 9_999);
    const before = storedStateFingerprint(seeded.state);
    const operationId = "participant-operation:deletion-corrupt-aggregate";
    const failure = await captureStorageFailure(() =>
      stageParticipantAccountDeletionInvestmentWithdrawalSet(
        new StagedStorageTransaction(seeded.storage, operationId),
        ALICE,
        AMOUNT,
        { operationId, requestedAt: "2026-08-12T12:00:00.000Z" },
      )
    );
    assert.equal(failure.code, "UNAVAILABLE");
    assert.equal(storedStateFingerprint(seeded.state), before);
  });
});

test("a valid-looking changed aggregate receipt fails closed without writes", async () => {
  const state = new MemoryStorageState();
  await initializeEmptyOwnership(
    new MemoryStorageAdapter(state),
    ALICE,
    "storage-corrupt-receipt",
  );
  const context = await currentContext(ALICE, "storage-corrupt-receipt");
  const repository = new StorageParticipantInvestmentInterestRepository(
    new MemoryStorageAdapter(state),
    ALICE,
    AMOUNT,
  );
  const service = serviceFor(
    repository,
    ALICE,
    context,
    () => new Date("2026-08-12T10:00:00.000Z"),
  );
  const input = Object.freeze({
    operationId: "investment-operation:storage-corrupt-receipt",
    fields: personalFields(),
  });
  await service.create(input);
  replaceAggregateOperationTotal(state, 1_500);
  const recordsBefore = state.records.size;
  const operationsBefore = state.operations.size;

  const failure = await captureStorageFailure(() => service.create(input));
  assert.equal(failure.code, "UNAVAILABLE");
  assert.equal(state.records.size, recordsBefore);
  assert.equal(state.operations.size, operationsBefore);
  assertAggregate(state, 1, 1_250, 1);
});

async function initializeEmptyOwnership(
  storage: StorageAdapter,
  participantSubject: ActorSubject,
  suffix: string,
): Promise<void> {
  const initialized = await initializeParticipantInvestmentOwnership(
    storage,
    participantSubject,
    {
      operationId: `investment-ownership-initialization:${suffix}`,
      indications: [],
    },
  );
  assert.equal(initialized.indicationCount, 0);
  assert.equal(initialized.activeCount, 0);
}

async function seedAccountDeletionActiveSet(
  count: number,
  suffix: string,
) {
  assert.equal(Number.isSafeInteger(count), true);
  assert.equal(count >= 1 && count <= MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS, true);
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await initializeEmptyOwnership(storage, ALICE, suffix);
  const context = await currentContext(ALICE, suffix);
  let minute = 0;
  const service = serviceFor(
    new StorageParticipantInvestmentInterestRepository(
      storage,
      ALICE,
      AMOUNT,
    ),
    ALICE,
    context,
    () => new Date(
      Date.parse("2026-08-12T10:00:00.000Z") + minute++ * 60_000,
    ),
  );
  const created: Awaited<ReturnType<typeof service.create>>[] = [];
  for (let index = 0; index < count; index += 1) {
    created.push(await service.create({
      operationId: `investment-operation:${suffix}-${index}`,
      fields: companyFields({
        companyName: `Account deletion company ${index}`,
        companyIdentifier: `ACCOUNT-DELETION-${suffix}-${index}`,
      }),
    }));
  }
  return Object.freeze({ state, storage, context, service, created });
}

async function seedMaximumOwnershipHeads(
  state: MemoryStorageState,
  participantSubject: ActorSubject,
) {
  const fixture = await maximumOwnershipFixture(participantSubject);
  assert.equal(state.records.size, 0);
  assert.equal(state.operations.size, 0);
  for (const [identity, record] of fixture.state.records) {
    state.records.set(identity, record);
  }
  for (const [operationId, operation] of fixture.state.operations) {
    state.operations.set(operationId, operation);
  }
  return fixture.indications;
}

function seedMaximumActiveAggregate(
  state: MemoryStorageState,
  indications: readonly ParticipantIndicationOwnershipEntry[],
): void {
  const contributionCollection = parseStorageCollection(
    "investment-aggregate-contributions",
  );
  const aggregateCollection = parseStorageCollection(
    "investment-aggregate-states",
  );
  assert(contributionCollection.ok);
  assert(aggregateCollection.ok);
  const active = indications.filter(({ lifecycleStatus }) =>
    lifecycleStatus === "active"
  );
  assert.equal(active.length, MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS);
  for (const entry of active) {
    const key = parseStorageKey(
      contributionCollection.value,
      entry.indicationId,
    );
    assert(key.ok);
    state.records.set(storageKeyString(key.value), Object.freeze({
      key: key.value,
      revision: entry.indicationRevision,
      value: Object.freeze({
        kind: "investment-aggregate-contribution",
        schemaVersion: 1,
        indicationId: entry.indicationId,
        indicationRevision: entry.indicationRevision,
        status: "active",
        amount: 2_000,
        currency: "EUR",
      }),
    }));
  }
  const aggregateKey = parseStorageKey(
    aggregateCollection.value,
    "current-investment-aggregate",
  );
  assert(aggregateKey.ok);
  state.records.set(storageKeyString(aggregateKey.value), Object.freeze({
    key: aggregateKey.value,
    revision: 1,
    value: Object.freeze({
      kind: "investment-aggregate-state",
      schemaVersion: 1,
      snapshot: Object.freeze({
        revision: 1,
        totalAmount: 8_000,
        currency: "EUR",
        contributingIndicationCount: active.length,
      }),
    }),
  }));
}

const maximumOwnershipFixtures = new Map<
  string,
  Promise<Readonly<{
    state: MemoryStorageState;
    indications: readonly ParticipantIndicationOwnershipEntry[];
  }>>
>();

function maximumOwnershipFixture(participantSubject: ActorSubject) {
  const identity = String(participantSubject);
  let fixture = maximumOwnershipFixtures.get(identity);
  if (fixture === undefined) {
    fixture = buildMaximumOwnershipFixture(participantSubject);
    maximumOwnershipFixtures.set(identity, fixture);
  }
  return fixture;
}

async function buildMaximumOwnershipFixture(
  participantSubject: ActorSubject,
) {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const acknowledgment = await currentContext(
    participantSubject,
    "maximum-ownership-history",
  );
  const participant = new DevelopmentInMemoryIndicationRepository(
    storage,
    participantSubject,
    OWNER,
    AMOUNT,
  );
  const owner = new DevelopmentInMemoryIndicationRepository(
    storage,
    OWNER,
    OWNER,
    AMOUNT,
  );
  const indications: ParticipantIndicationOwnershipEntry[] = [];
  for (let index = 0; index < MAX_OWNED_INVESTMENT_INDICATIONS; index += 1) {
    const idPrefix = `investment-indication:maximum-${String(index).padStart(3, "0")}-`;
    const indicationId = indicationIdForOperation(
      `${idPrefix}${"x".repeat(128 - idPrefix.length)}`,
    );
    const suffix = String(index).padStart(3, "0");
    let current = await participant.create({
      operationId: `indication-operation:maximum-${suffix}-01`,
      id: indicationId,
      expectedRevision: null,
      occurredAt: maximumHistoryTimestamp(1),
      historyEntryId: `indication-history:maximum-${suffix}-01`,
      fields: maximumHistoryFields(index, 1),
    }, acknowledgment);
    while (
      current.snapshot.revision < MAX_INVESTMENT_INDICATION_REVISIONS - 1
    ) {
      const revision = current.snapshot.revision + 1;
      const revisionLabel = String(revision).padStart(2, "0");
      current = await participant.edit({
        operationId: `indication-operation:maximum-${suffix}-${revisionLabel}`,
        id: indicationId,
        expectedRevision: current.snapshot.revision,
        occurredAt: maximumHistoryTimestamp(revision),
        historyEntryId:
          `indication-history:maximum-${suffix}-${revisionLabel}`,
        fields: maximumHistoryFields(index, revision),
      }, acknowledgment);
    }

    let lifecycleStatus: ParticipantIndicationOwnershipEntry["lifecycleStatus"] =
      "active";
    let indicationRevision = current.snapshot.revision;
    if (index >= MAX_ACTIVE_OWNED_INVESTMENT_INDICATIONS) {
      const revisionLabel = String(MAX_INVESTMENT_INDICATION_REVISIONS).padStart(
        2,
        "0",
      );
      if (index % 2 === 0) {
        const withdrawn = await participant.withdraw({
          operationId: `indication-operation:maximum-${suffix}-${revisionLabel}`,
          id: indicationId,
          expectedRevision: current.snapshot.revision,
          occurredAt: maximumHistoryTimestamp(MAX_INVESTMENT_INDICATION_REVISIONS),
          historyEntryId:
            `indication-history:maximum-${suffix}-${revisionLabel}`,
        });
        lifecycleStatus = "withdrawn";
        indicationRevision = withdrawn.snapshot.revision;
      } else {
        const rejected = await owner.reject({
          operationId: `indication-operation:maximum-${suffix}-${revisionLabel}`,
          id: indicationId,
          expectedRevision: current.snapshot.revision,
          occurredAt: maximumHistoryTimestamp(MAX_INVESTMENT_INDICATION_REVISIONS),
          historyEntryId:
            `indication-history:maximum-${suffix}-${revisionLabel}`,
          reason: `Synthetic maximum-history rejection ${suffix}.`,
        });
        lifecycleStatus = "rejected";
        indicationRevision = rejected.snapshot.revision;
      }
    }
    indications.push(Object.freeze({
      indicationId,
      indicationRevision,
      lifecycleStatus,
    }));
  }
  const stored = await Promise.all(indications.map(({ indicationId }) =>
    participant.get(indicationId)
  ));
  assert.equal(stored.every((indication, index) =>
    indication !== null &&
    indication.revision === indications[index]?.indicationRevision &&
    indication.lifecycle.status === indications[index]?.lifecycleStatus
  ), true);
  return Object.freeze({
    state,
    indications: Object.freeze(indications),
  });
}

function maximumHistoryTimestamp(revision: number): string {
  return new Date(
    Date.parse("2026-08-12T10:00:00.000Z") + (revision - 1) * 60_000,
  ).toISOString();
}

function maximumHistoryFields(index: number, revision: number) {
  const suffix = String(index).padStart(3, "0");
  return companyFields({
    companyName: `Maximum history company ${suffix}`,
    companyIdentifier: `MAXIMUM-HISTORY-${suffix}`,
    note: `Fully materialized revision ${revision}.`,
  });
}

function observedActiveLeaseProofReads(
  state: MemoryStorageState,
  indications: readonly ParticipantIndicationOwnershipEntry[],
): number {
  const currentRecords = recordsIn(state, "investment-indications");
  return indications.reduce((total, entry) => {
    if (entry.lifecycleStatus !== "active") return total;
    const current = currentRecords.find((record) =>
      record.value.indicationId === entry.indicationId
    );
    assert(current);
    const fields = current.value.fields as Readonly<Record<string, unknown>>;
    assert.equal(Number.isSafeInteger(fields.chunks), true);
    return total + (fields.chunks as number) + 1;
  }, 0);
}

function serviceFor(
  repository: StorageParticipantInvestmentInterestRepository,
  actorSubject: ActorSubject,
  context: TrustedPackageAcknowledgmentContext,
  now: () => Date,
  configuredAmount: AmountConfiguration = AMOUNT,
) {
  return createParticipantInvestmentInterestService({
    actorSubject,
    amountConfiguration: configuredAmount,
    reader: repository,
    mutations: repository,
    loadAcknowledgmentContext: () => context,
    loadPermissions: () => ALLOW_ALL,
    indicationIdForOperation,
    now,
  });
}

function personalFields(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    kind: "personal",
    residenceCountry: "FI",
    amount: 1_250,
    availabilityPeriod: "Within twelve months.",
    note: "Initial private note.",
    ...overrides,
  };
}

function companyFields(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    kind: "company",
    companyName: "Synthetic company",
    registrationCountry: "FI",
    companyIdentifier: "SYNTHETIC-123",
    representativeName: "Synthetic representative",
    representativeAuthorityDeclared: true,
    amount: 2_000,
    availabilityPeriod: "Within twelve months.",
    note: null,
    ...overrides,
  };
}

function recordsIn(state: MemoryStorageState, collection: string) {
  return recordsWithIdentitiesIn(state, collection).map(([, record]) => record);
}

function recordsWithIdentitiesIn(
  state: MemoryStorageState,
  collection: string,
) {
  return [...state.records.entries()].filter(([, record]) =>
    record.key.collection === collection
  );
}

function replaceOnlyActiveLease(
  state: MemoryStorageState,
  overrides: Readonly<Record<string, unknown>>,
): void {
  const entries = recordsWithIdentitiesIn(
    state,
    "investment-indication-active-keys",
  );
  assert.equal(entries.length, 1);
  const [identity, record] = entries[0]!;
  state.records.set(identity, Object.freeze({
    key: record.key,
    revision: record.revision,
    value: Object.freeze({
      ...record.value,
      ...overrides,
    }) as StorageDocument,
  }));
}

function participantIdsIn(
  state: MemoryStorageState,
  collection: string,
): readonly InvestmentIndicationId[] {
  const record = recordsIn(state, collection)[0];
  assert(record);
  const source = record.value as Readonly<Record<string, unknown>>;
  if (Array.isArray(source.indicationIds)) {
    return source.indicationIds as readonly InvestmentIndicationId[];
  }
  assert(Array.isArray(source.indications));
  return source.indications.map((entry) => {
    assert(typeof entry === "object" && entry !== null);
    return (entry as Readonly<Record<string, unknown>>)
      .indicationId as InvestmentIndicationId;
  });
}

function deleteOnlyRecordIn(
  state: MemoryStorageState,
  collection: string,
): void {
  const entries = [...state.records.entries()].filter(([, record]) =>
    record.key.collection === collection
  );
  assert.equal(entries.length, 1);
  state.records.delete(entries[0]![0]);
}

function replaceOwnershipWitnessWithLegacyIds(
  state: MemoryStorageState,
): void {
  const entry = [...state.records.entries()].find(([, record]) =>
    record.key.collection === "investment-indication-ownership-witnesses"
  );
  assert(entry);
  const [identity, record] = entry;
  const source = record.value as Readonly<Record<string, unknown>>;
  assert(Array.isArray(source.indications));
  const indicationIds = source.indications.map((value) => {
    assert(typeof value === "object" && value !== null);
    return (value as Readonly<Record<string, unknown>>).indicationId as string;
  });
  state.records.set(identity, Object.freeze({
    key: record.key,
    revision: record.revision,
    value: Object.freeze({
      kind: "investment-indication-ownership-witness",
      schemaVersion: 4,
      revision: record.revision,
      indicationIds: Object.freeze(indicationIds),
    }),
  }));
}

function replaceOwnershipWitnessStatus(
  state: MemoryStorageState,
  indicationId: InvestmentIndicationId,
  lifecycleStatus: ParticipantIndicationOwnershipEntry["lifecycleStatus"],
): void {
  const entry = [...state.records.entries()].find(([, record]) =>
    record.key.collection === "investment-indication-ownership-witnesses"
  );
  assert(entry);
  const [identity, record] = entry;
  const source = record.value as Readonly<Record<string, unknown>>;
  assert(Array.isArray(source.indications));
  const indications = source.indications.map((value) => {
    assert(typeof value === "object" && value !== null);
    const ownership = value as Readonly<Record<string, unknown>>;
    return ownership.indicationId === indicationId
      ? Object.freeze({ ...ownership, lifecycleStatus })
      : ownership;
  });
  const revision = record.revision + 1;
  state.records.set(identity, Object.freeze({
    key: record.key,
    revision,
    value: Object.freeze({
      ...source,
      revision,
      indications: Object.freeze(indications),
    }) as StorageDocument,
  }));
}

function replaceTerminalTransitionKind(
  state: MemoryStorageState,
  indicationId: InvestmentIndicationId,
  revision: number,
  transitionKind: string,
): void {
  const entry = [...state.records.entries()].find(([, record]) =>
    record.key.collection === "investment-indication-history" &&
    record.value.indicationId === indicationId &&
    record.value.revision === revision
  );
  assert(entry);
  const [identity, record] = entry;
  state.records.set(identity, Object.freeze({
    key: record.key,
    revision: record.revision,
    value: Object.freeze({
      ...record.value,
      transitionKind,
    }) as StorageDocument,
  }));
}

function replaceHistoryOperationFingerprint(
  state: MemoryStorageState,
  indicationId: InvestmentIndicationId,
  revision: number,
  operationFingerprint: string,
): void {
  const entry = [...state.records.entries()].find(([, record]) =>
    record.key.collection === "investment-indication-history" &&
    record.value.indicationId === indicationId &&
    record.value.revision === revision
  );
  assert(entry);
  const [identity, record] = entry;
  state.records.set(identity, Object.freeze({
    key: record.key,
    revision: record.revision,
    value: Object.freeze({
      ...record.value,
      operationFingerprint,
    }) as StorageDocument,
  }));
}

function activeOwned(
  indications: Awaited<
    ReturnType<StorageParticipantInvestmentInterestRepository["listOwned"]>
  >,
): number {
  return indications.filter((indication) =>
    indication.status === "active"
  ).length;
}

async function persistAggregateProjection(
  storage: StorageAdapter,
  indication: Parameters<typeof projectInvestmentIndicationForAggregation>[0],
  operationId: string,
): Promise<void> {
  const aggregate = new DevelopmentInMemoryAggregateRepository(
    storage,
    AMOUNT.currency,
  );
  const current = await aggregate.readStored();
  const prepared = await prepareAtomicAggregateContribution(storage, {
    operationId,
    expectedStoredRevision: current.revision,
    contribution: projectInvestmentIndicationForAggregation(indication),
  }, AMOUNT.currency);
  await storage.transact({
    operationId: prepared.operationId,
    mutations: prepared.mutations,
  });
}

function appendParticipantIndexId(
  state: MemoryStorageState,
  id: InvestmentIndicationId,
): void {
  mutateParticipantIndexIds(state, (ids) => [...ids, id]);
}

function removeParticipantIndexId(
  state: MemoryStorageState,
  id: InvestmentIndicationId,
): void {
  mutateParticipantIndexIds(state, (ids) =>
    ids.filter((candidate) => candidate !== id)
  );
}

function mutateParticipantIndexIds(
  state: MemoryStorageState,
  mutate: (ids: readonly InvestmentIndicationId[]) => readonly InvestmentIndicationId[],
): void {
  const entry = [...state.records.entries()].find(([, record]) =>
    record.key.collection === "participant-investment-indexes"
  );
  assert(entry);
  const [identity, record] = entry;
  const source = record.value as Readonly<Record<string, unknown>>;
  const ids = [...mutate(
    source.indicationIds as readonly InvestmentIndicationId[],
  )].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const revision = record.revision + 1;
  state.records.set(identity, Object.freeze({
    key: record.key,
    revision,
    value: Object.freeze({
      ...source,
      revision,
      indicationIds: Object.freeze(ids),
    }) as StorageDocument,
  }));
}

function storedStateFingerprint(state: MemoryStorageState): string {
  return JSON.stringify([...state.records.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  ));
}

function assertAggregate(
  state: MemoryStorageState,
  revision: number,
  totalAmount: number,
  count: number,
): void {
  const records = recordsIn(state, "investment-aggregate-states");
  assert.equal(records.length, 1);
  const snapshot = records[0]?.value.snapshot as
    | Readonly<Record<string, unknown>>
    | undefined;
  assert.equal(snapshot?.revision, revision);
  assert.equal(snapshot?.totalAmount, totalAmount);
  assert.equal(snapshot?.contributingIndicationCount, count);
}

function replaceAggregateOperationTotal(
  state: MemoryStorageState,
  totalAmount: number,
): void {
  const entry = [...state.records.entries()].find(([, record]) =>
    record.key.collection === "investment-aggregate-operations"
  );
  assert(entry);
  const [identity, record] = entry;
  const value = JSON.parse(JSON.stringify(record.value)) as Record<
    string,
    unknown
  >;
  const result = value.result as Record<string, unknown>;
  const stored = result.stored as Record<string, unknown>;
  const calculated = result.calculated as Record<string, unknown>;
  stored.totalAmount = totalAmount;
  calculated.totalAmount = totalAmount;
  state.records.set(identity, Object.freeze({
    key: record.key,
    revision: record.revision,
    value: value as StorageDocument,
  }));
}

function replaceAggregateRevision(
  state: MemoryStorageState,
  revision: number,
): void {
  const entry = [...state.records.entries()].find(([, record]) =>
    record.key.collection === "investment-aggregate-states"
  );
  assert(entry);
  const [identity, record] = entry;
  const value = JSON.parse(JSON.stringify(record.value)) as Record<
    string,
    unknown
  >;
  const snapshot = value.snapshot as Record<string, unknown>;
  snapshot.revision = revision;
  state.records.set(identity, Object.freeze({
    key: record.key,
    revision,
    value: value as StorageDocument,
  }));
}

function replaceAggregateTotal(
  state: MemoryStorageState,
  totalAmount: number,
): void {
  const entry = [...state.records.entries()].find(([, record]) =>
    record.key.collection === "investment-aggregate-states"
  );
  assert(entry);
  const [identity, record] = entry;
  const value = JSON.parse(JSON.stringify(record.value)) as Record<
    string,
    unknown
  >;
  const snapshot = value.snapshot as Record<string, unknown>;
  snapshot.totalAmount = totalAmount;
  state.records.set(identity, Object.freeze({
    key: record.key,
    revision: record.revision,
    value: value as StorageDocument,
  }));
}

function replaceFirstAggregateContributionAmount(
  state: MemoryStorageState,
  amount: number,
): void {
  const entry = [...state.records.entries()].find(([, record]) =>
    record.key.collection === "investment-aggregate-contributions"
  );
  assert(entry);
  const [identity, record] = entry;
  state.records.set(identity, Object.freeze({
    key: record.key,
    revision: record.revision,
    value: Object.freeze({ ...record.value, amount }) as StorageDocument,
  }));
}

function replaceFirstResultRecord(
  result: StorageTransactionResult,
  transform: (record: NonNullable<StorageTransactionResult["records"][number]>) =>
    unknown,
): unknown {
  const first = result.records[0];
  assert(first);
  return {
    ...result,
    records: [transform(first), ...result.records.slice(1)],
  };
}

function nestedCanonicalValue(depth: number): StorageDocument {
  let value: StorageDocument = { end: true };
  for (let index = 0; index < depth; index += 1) {
    value = { child: value };
  }
  return value;
}

async function currentContext(
  participantSubject: ActorSubject,
  suffix: string,
): Promise<TrustedPackageAcknowledgmentContext> {
  const version = await packageVersion(`package-version:${suffix}`);
  return Object.freeze({
    currentVersion: version,
    latestAcceptance: acceptance(
      version,
      participantSubject,
      `package-acceptance:${suffix}`,
    ),
  });
}

async function packageVersion(id: string): Promise<PackageVersion> {
  const parsed = await createPackageVersion({
    id,
    createdAt: "2026-08-09T08:00:00.000Z",
    changeSummary: "Synthetic package",
    materialChange: false,
    acknowledgmentText: "This indication remains non-binding.",
    sections: [{
      id: `package-section:${id.slice("package-version:".length)}`,
      order: 0,
      title: "Overview",
      markdown: "Synthetic package.",
      enabled: true,
    }],
  }, null);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function acceptance(
  version: PackageVersion,
  participantSubject: ActorSubject,
  id: string,
): PackageAcceptanceRecord {
  const parsed = createPackageAcceptance({
    id,
    participantSubject,
    acceptedAt: "2026-08-09T09:00:00.000Z",
  }, version);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function amountConfiguration(
  overrides: Readonly<Record<string, unknown>> = {},
): AmountConfiguration {
  const parsed = parseAmountAggregateConfiguration({
    amount: {
      currency: "eur",
      minimum: 1_000,
      increment: 250,
      maximum: 10_000,
      ...overrides,
    },
    publicAggregate: { visibility: "hidden" },
  });
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value.amount;
}

function subject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function indicationIdForOperation(value: unknown): InvestmentIndicationId {
  const parsed = parseStableId<"investment-indication">(value);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
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
  assert.fail("Expected StorageFailure.");
}

class FailOnceStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  #fail = true;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  read: StorageAdapter["read"] = (key) => this.#delegate.read(key);
  list: StorageAdapter["list"] = (request) => this.#delegate.list(request);

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    if (this.#fail) {
      this.#fail = false;
      throw new StorageFailure("UNAVAILABLE");
    }
    return this.#delegate.transact(request);
  }
}

class CountingStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readCalls = 0;
  listCalls = 0;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  resetReads(): void {
    this.readCalls = 0;
  }

  read: StorageAdapter["read"] = (key) => {
    this.readCalls += 1;
    return this.#delegate.read(key);
  };

  list: StorageAdapter["list"] = (request) => {
    this.listCalls += 1;
    return this.#delegate.list(request);
  };

  transact: StorageAdapter["transact"] = (request) =>
    this.#delegate.transact(request);
}

class BeforeTransactionStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #inject: () => Promise<void>;
  injected = false;

  constructor(delegate: StorageAdapter, inject: () => Promise<void>) {
    this.#delegate = delegate;
    this.#inject = inject;
  }

  read: StorageAdapter["read"] = (key) => this.#delegate.read(key);
  list: StorageAdapter["list"] = (request) => this.#delegate.list(request);

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    if (!this.injected) {
      this.injected = true;
      await this.#inject();
    }
    return this.#delegate.transact(request);
  }
}

class WitnessReadHookStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #inject: () => Promise<void>;
  readonly #triggerAt: number;
  #witnessReads = 0;
  injected = false;

  constructor(
    delegate: StorageAdapter,
    inject: () => Promise<void>,
    triggerAt = 3,
  ) {
    this.#delegate = delegate;
    this.#inject = inject;
    this.#triggerAt = triggerAt;
  }

  async read(
    key: Parameters<StorageAdapter["read"]>[0],
  ): Promise<StorageRecord | null> {
    if (key.collection === "investment-indication-ownership-witnesses") {
      this.#witnessReads += 1;
      if (this.#witnessReads === this.#triggerAt) {
        this.injected = true;
        await this.#inject();
      }
    }
    return this.#delegate.read(key);
  }

  list: StorageAdapter["list"] = (request) => this.#delegate.list(request);
  transact: StorageAdapter["transact"] = (request) =>
    this.#delegate.transact(request);
}

class ReorderedResultStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  read: StorageAdapter["read"] = (key) => this.#delegate.read(key);
  list: StorageAdapter["list"] = (request) => this.#delegate.list(request);

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    const result = await this.#delegate.transact(request);
    return Object.freeze({
      replayed: result.replayed,
      records: Object.freeze(result.records.map((record) =>
        record === null
          ? null
          : Object.freeze({
              key: record.key,
              revision: record.revision,
              value: Object.fromEntries(
                Object.entries(record.value).reverse(),
              ) as StorageDocument,
            })
      )),
    });
  }
}

class ResultTransformStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #transform: (result: StorageTransactionResult) => unknown;

  constructor(
    delegate: StorageAdapter,
    transform: (result: StorageTransactionResult) => unknown,
  ) {
    this.#delegate = delegate;
    this.#transform = transform;
  }

  read: StorageAdapter["read"] = (key) => this.#delegate.read(key);
  list: StorageAdapter["list"] = (request) => this.#delegate.list(request);

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    const result = await this.#delegate.transact(request);
    return this.#transform(result) as StorageTransactionResult;
  }
}

class ReadTransformStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #collection: string;
  readonly #transform: (record: StorageRecord) => unknown;

  constructor(
    delegate: StorageAdapter,
    collection: string,
    transform: (record: StorageRecord) => unknown,
  ) {
    this.#delegate = delegate;
    this.#collection = collection;
    this.#transform = transform;
  }

  async read(
    key: Parameters<StorageAdapter["read"]>[0],
  ): Promise<StorageRecord | null> {
    const record = await this.#delegate.read(key);
    if (record === null || key.collection !== this.#collection) return record;
    return this.#transform(record) as StorageRecord;
  }

  list: StorageAdapter["list"] = (request) => this.#delegate.list(request);
  transact: StorageAdapter["transact"] = (request) =>
    this.#delegate.transact(request);
}
