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
import type {
  InvestmentIndicationParsingOptions,
  InvestmentIndicationId,
  TrustedPackageAcknowledgmentContext,
} from "../domain/investment-indication.ts";
import { projectInvestmentIndicationForAggregation } from "../domain/investment-aggregate.ts";
import {
  createPackageAcceptance,
  createPackageVersion,
  type PackageAcceptanceRecord,
  type PackageVersion,
} from "../domain/package-content.ts";
import {
  StorageFailure,
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
} from "../repositories/in-memory-indication-repository.ts";
import { StorageParticipantInvestmentInterestRepository } from "../repositories/storage-participant-investment-repository.ts";
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
  reactivatePersonal: true,
  reactivateCompany: true,
}) satisfies InvestmentInterestPermissions;

test("storage participant investment repository commits one persistent atomic lifecycle", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
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
  assert.equal(state.operations.size, 1);
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
    [reactivated.snapshot],
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

test("atomic exact retries survive normalizer evolution without semantic substitution", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
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
  assert.equal(state.operations.size, 1);
  assert.equal(recordsIn(state, "audit-events").length, 1);
  assertAggregate(state, 1, 1_250, 1);
});

test("active capacity survives withdrawal, rejection, reactivation, and restart", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
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

test("pre-existing over-capacity and missing indexed state fail closed", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
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

test("atomic contribution work stays constant-read with unrelated indications", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  for (let index = 0; index < 24; index += 1) {
    const actor = subject(`issuer.invalid/participant:bounded-${index}`);
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
  assert.equal(counted.readCalls <= 20, true);
  assertAggregate(state, 25, 31_250, 25);
});

test("participant index has an observed 100-item read and write ceiling", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const context = await currentContext(ALICE, "storage-index-ceiling");
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
  for (let index = 0; index < 100; index += 1) {
    const created = await service.create({
      operationId: `investment-operation:index-ceiling-${index}`,
      fields: companyFields({
        companyName: `Synthetic company ${index}`,
        companyIdentifier: `SYNTHETIC-${index}`,
      }),
    });
    await service.withdraw({
      operationId: `investment-operation:index-ceiling-withdraw-${index}`,
      indicationId: created.snapshot.id,
      expectedRevision: created.snapshot.revision,
    });
  }

  const counted = new CountingStorageAdapter(
    new MemoryStorageAdapter(state),
  );
  const reopened = new StorageParticipantInvestmentInterestRepository(
    counted,
    ALICE,
    AMOUNT,
  );
  assert.equal((await reopened.listOwned()).length, 100);
  assert.equal(counted.listCalls, 0);
  assert.equal(counted.readCalls <= 501, true);

  const recordsBefore = state.records.size;
  const operationsBefore = state.operations.size;
  const failure = await captureStorageFailure(() => service.create({
    operationId: "investment-operation:index-ceiling-overflow",
    fields: companyFields({
      companyName: "Overflow company",
      companyIdentifier: "SYNTHETIC-OVERFLOW",
    }),
  }));
  assert.equal(failure.code, "CONFLICT");
  assert.equal(state.records.size, recordsBefore);
  assert.equal(state.operations.size, operationsBefore);
  assertAggregate(state, 200, 0, 0);
});

test("a failed outer transaction leaves no indication, aggregate, audit, index, or receipt", async () => {
  const state = new MemoryStorageState();
  const adapter = new FailOnceStorageAdapter(new MemoryStorageAdapter(state));
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
  assert.equal(state.records.size, 0);
  assert.equal(state.operations.size, 0);

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
  const repository = new StorageParticipantInvestmentInterestRepository(
    new ReorderedResultStorageAdapter(new MemoryStorageAdapter(state)),
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
      const repository = new StorageParticipantInvestmentInterestRepository(
        new ResultTransformStorageAdapter(
          new MemoryStorageAdapter(),
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

test("stored operation receipts and participant indexes require closed envelopes", async (context) => {
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
      assert.equal(state.operations.size, 1);
    });
  }
});

test("a valid-looking changed aggregate receipt fails closed without writes", async () => {
  const state = new MemoryStorageState();
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
  return [...state.records.values()].filter(
    (record) => record.key.collection === collection,
  );
}

function activeOwned(
  indications: Awaited<
    ReturnType<StorageParticipantInvestmentInterestRepository["listOwned"]>
  >,
): number {
  return indications.filter((indication) =>
    indication.lifecycle.status === "active"
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
