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
  MAX_INDICATION_CANONICAL_DEPTH,
  MAX_INDICATION_CANONICAL_NODES,
} from "../repositories/in-memory-indication-repository.ts";
import { StorageParticipantInvestmentInterestRepository } from "../repositories/storage-participant-investment-repository.ts";
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

test("historical currency preserves withdrawal and exact retries after policy evolution", async () => {
  const state = new MemoryStorageState();
  const context = await currentContext(ALICE, "storage-currency-evolution");
  const input = Object.freeze({
    operationId: "investment-operation:storage-currency-evolution-create",
    fields: personalFields({ amount: 1_250 }),
  });
  const originalRepository = new StorageParticipantInvestmentInterestRepository(
    new MemoryStorageAdapter(state),
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
    currency: "usd",
    minimum: 5_000,
    increment: 1_000,
    maximum: 20_000,
  });
  const evolvedService = serviceFor(
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
  const createReplay = await evolvedService.create(input);
  assert.equal(createReplay.replayed, true);
  assert.deepEqual(createReplay.snapshot, original.snapshot);

  const withdrawalInput = Object.freeze({
    operationId: "investment-operation:storage-currency-evolution-withdraw",
    indicationId: original.snapshot.id,
    expectedRevision: 1,
  });
  const withdrawn = await evolvedService.withdraw(withdrawalInput);
  assert.equal(withdrawn.replayed, false);
  assert.equal(withdrawn.snapshot.lifecycle.status, "withdrawn");
  assert.equal(withdrawn.snapshot.fields.currency, AMOUNT.currency);
  assertAggregate(state, 2, 0, 0);

  const rolloverInput = Object.freeze({
    operationId: "investment-operation:storage-currency-rollover-create",
    fields: companyFields({
      companyIdentifier: "CURRENT-CURRENCY-COMPANY",
      amount: 5_000,
    }),
  });
  const createCurrent = () => serviceFor(
    new StorageParticipantInvestmentInterestRepository(
      new MemoryStorageAdapter(state),
      ALICE,
      evolvedAmount,
    ),
    ALICE,
    context,
    () => new Date("2026-08-12T12:00:00.000Z"),
    evolvedAmount,
  ).create(rolloverInput);
  const rollovers = await Promise.all([createCurrent(), createCurrent()]);
  assert.deepEqual(
    rollovers.map(({ replayed }) => replayed).sort(),
    [false, true],
  );
  assert.equal(rollovers[0]?.snapshot.fields.currency, evolvedAmount.currency);
  assertAggregate(state, 3, 5_000, 1, evolvedAmount.currency);

  const restarted = serviceFor(
    new StorageParticipantInvestmentInterestRepository(
      new MemoryStorageAdapter(state),
      ALICE,
      evolvedAmount,
    ),
    ALICE,
    context,
    () => new Date("2026-08-12T13:00:00.000Z"),
    evolvedAmount,
  );
  const currentCreateReplay = await restarted.create(rolloverInput);
  assert.equal(currentCreateReplay.replayed, true);
  assert.deepEqual(currentCreateReplay.snapshot, rollovers[0]?.snapshot);
  const withdrawalReplay = await restarted.withdraw(withdrawalInput);
  assert.equal(withdrawalReplay.replayed, true);
  assert.deepEqual(withdrawalReplay.snapshot, withdrawn.snapshot);
  assertAggregate(state, 3, 5_000, 1, evolvedAmount.currency);

  const blockedReactivation = await captureStorageFailure(() =>
    restarted.reactivate({
      operationId:
        "investment-operation:storage-currency-evolution-reactivate",
      indicationId: original.snapshot.id,
      expectedRevision: 2,
    })
  );
  assert.equal(blockedReactivation.code, "PRECONDITION_FAILED");
  assert.equal(recordsIn(state, "audit-events").length, 3);
  assert.equal(recordsIn(state, "participant-investment-operations").length, 3);
  assert.equal(state.operations.size, 3);
});

test("currency rollover rejects every non-empty aggregate shape without writes", async () => {
  const cases = [
    { name: "nonzero amount and count", totalAmount: 1_250, count: 1 },
    { name: "zero amount with nonzero count", totalAmount: 0, count: 1 },
    { name: "nonzero amount with zero count", totalAmount: 1_250, count: 0 },
  ] as const;

  for (const candidate of cases) {
    const state = new MemoryStorageState();
    const context = await currentContext(
      ALICE,
      `storage-currency-rollover-${candidate.name.replaceAll(" ", "-")}`,
    );
    await serviceFor(
      new StorageParticipantInvestmentInterestRepository(
        new MemoryStorageAdapter(state),
        ALICE,
        AMOUNT,
      ),
      ALICE,
      context,
      () => new Date("2026-08-12T10:00:00.000Z"),
    ).create({
      operationId:
        `investment-operation:storage-currency-rollover-seed-${candidate.count}`,
      fields: personalFields(),
    });
    replaceAggregateSnapshot(state, {
      totalAmount: candidate.totalAmount,
      contributingIndicationCount: candidate.count,
    });
    const recordsBefore = [...state.records.entries()];
    const operationsBefore = [...state.operations.entries()];
    const evolvedAmount = amountConfiguration({ currency: "usd" });
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

    const failure = await captureStorageFailure(() => evolved.create({
      operationId:
        `investment-operation:storage-currency-rollover-blocked-${candidate.count}`,
      fields: companyFields({
        companyIdentifier: `BLOCKED-${candidate.count}`,
      }),
    }));
    assert.equal(failure.code, "UNAVAILABLE", candidate.name);
    assert.deepEqual([...state.records.entries()], recordsBefore, candidate.name);
    assert.deepEqual(
      [...state.operations.entries()],
      operationsBefore,
      candidate.name,
    );
  }
});

test("malformed rollover transaction evidence fails closed and exact restart retry recovers", async () => {
  const state = new MemoryStorageState();
  const context = await currentContext(ALICE, "storage-currency-rollover-result");
  const original = serviceFor(
    new StorageParticipantInvestmentInterestRepository(
      new MemoryStorageAdapter(state),
      ALICE,
      AMOUNT,
    ),
    ALICE,
    context,
    () => new Date("2026-08-12T10:00:00.000Z"),
  );
  const created = await original.create({
    operationId: "investment-operation:storage-rollover-result-seed",
    fields: personalFields(),
  });
  await original.withdraw({
    operationId: "investment-operation:storage-rollover-result-withdraw",
    indicationId: created.snapshot.id,
    expectedRevision: 1,
  });

  const evolvedAmount = amountConfiguration({ currency: "usd" });
  const input = Object.freeze({
    operationId: "investment-operation:storage-rollover-result-create",
    fields: companyFields({
      companyIdentifier: "ROLLOVER-RESULT",
    }),
  });
  const malformed = serviceFor(
    new StorageParticipantInvestmentInterestRepository(
      new ResultTransformStorageAdapter(
        new MemoryStorageAdapter(state),
        replaceReturnedAggregateCurrency,
      ),
      ALICE,
      evolvedAmount,
    ),
    ALICE,
    context,
    () => new Date("2026-08-12T11:00:00.000Z"),
    evolvedAmount,
  );
  const failure = await captureStorageFailure(() => malformed.create(input));
  assert.equal(failure.code, "UNAVAILABLE");
  assertAggregate(state, 3, 2_000, 1, evolvedAmount.currency);
  assert.equal(recordsIn(state, "audit-events").length, 3);

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
  const replay = await restarted.create(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.snapshot.fields.currency, evolvedAmount.currency);
  assertAggregate(state, 3, 2_000, 1, evolvedAmount.currency);
  assert.equal(recordsIn(state, "audit-events").length, 3);
  assert.equal(recordsIn(state, "participant-investment-operations").length, 3);
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
    await service.create({
      operationId: `investment-operation:index-ceiling-${index}`,
      fields: companyFields({
        companyName: `Synthetic company ${index}`,
        companyIdentifier: `SYNTHETIC-${index}`,
      }),
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
  assert.equal(counted.readCalls, 401);

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
  assertAggregate(state, 100, 200_000, 100);
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

function assertAggregate(
  state: MemoryStorageState,
  revision: number,
  totalAmount: number,
  count: number,
  expectedCurrency: string = AMOUNT.currency,
): void {
  const records = recordsIn(state, "investment-aggregate-states");
  assert.equal(records.length, 1);
  const snapshot = records[0]?.value.snapshot as
    | Readonly<Record<string, unknown>>
    | undefined;
  assert.equal(snapshot?.revision, revision);
  assert.equal(snapshot?.totalAmount, totalAmount);
  assert.equal(snapshot?.currency, expectedCurrency);
  assert.equal(snapshot?.contributingIndicationCount, count);
}

function replaceAggregateSnapshot(
  state: MemoryStorageState,
  overrides: Readonly<Record<string, unknown>>,
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
  value.snapshot = {
    ...(value.snapshot as Record<string, unknown>),
    ...overrides,
  };
  state.records.set(identity, Object.freeze({
    key: record.key,
    revision: record.revision,
    value: value as StorageDocument,
  }));
}

function replaceReturnedAggregateCurrency(
  result: StorageTransactionResult,
): unknown {
  return {
    ...result,
    records: result.records.map((record) => {
      if (
        record === null ||
        record.key.collection !== "investment-aggregate-states"
      ) return record;
      const snapshot = record.value.snapshot as Record<string, unknown>;
      return {
        ...record,
        value: {
          ...record.value,
          snapshot: { ...snapshot, currency: AMOUNT.currency },
        },
      };
    }),
  };
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
