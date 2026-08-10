import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAX_FOUNDER_APPLICATION_REVISIONS,
  parseContributionAreaChoices,
  type ContributionAreaChoice,
  type FounderApplicationId,
} from "../domain/founder-application.ts";
import {
  parseActorSubject,
  parseStableId,
  type ActorSubject,
} from "../domain/foundation.ts";
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
  DevelopmentInMemoryFounderApplicationReviewRepository,
  DevelopmentInMemoryFounderApplicationRepository,
  MAX_FOUNDER_APPLICATION_MATERIALIZATION_READS,
  MAX_FOUNDER_APPLICATION_STORAGE_READS,
  MAX_FOUNDER_APPLICATION_STORAGE_RECORD_BYTES,
  MAX_FOUNDER_APPLICATION_STORAGE_TRANSACTION_BYTES,
  MAX_FOUNDER_APPLICATION_FIELDS_CHUNKS,
  type CreateFounderApplicationRequest,
  type EditFounderApplicationRequest,
  type FounderApplicationRepository,
  type WithdrawFounderApplicationRequest,
} from "../repositories/in-memory-founder-application-repository.ts";

const ALICE_SUBJECT = actorSubject("issuer.invalid/subject:alice");
const BOB_SUBJECT = actorSubject("issuer.invalid/subject:bob");
const OWNER_SUBJECT = actorSubject("issuer.invalid/subject:owner");
const APPLICATION_ID = applicationId("founder-application:alice");

const contributionAreaChoices = choices([
  { id: "area:engineering", label: "Engineering" },
  { id: "area:product", label: "Product" },
  { id: "area:operations", label: "Operations" },
]);

export type FounderApplicationRepositoryContractFixture = Readonly<{
  owner: FounderApplicationRepository;
  reopenOwner: () => FounderApplicationRepository;
  foreign: FounderApplicationRepository;
  anonymous: FounderApplicationRepository;
  denied: FounderApplicationRepository;
  missing: FounderApplicationRepository;
}>;

export type FounderApplicationRepositoryContractFactory =
  () => FounderApplicationRepositoryContractFixture;

/** Reusable behavior contract for development and production founder repositories. */
export async function verifyFounderApplicationRepositoryContract(
  createFixture: FounderApplicationRepositoryContractFactory,
): Promise<void> {
  const fixture = createFixture();
  assert.equal(await fixture.owner.get(APPLICATION_ID), null);

  const mutableCreateFields = fields();
  const create = {
    operationId: "founder-operation:create",
    expectedRevision: null,
    id: APPLICATION_ID,
    occurredAt: "2026-08-09T10:00:00.000Z",
    historyEntryId: "founder-history:create",
    fields: mutableCreateFields,
    applicantSubject: BOB_SUBJECT,
  } satisfies CreateFounderApplicationRequest &
    Readonly<{ applicantSubject: ActorSubject }>;

  const created = await fixture.owner.create(create);
  const createReplay = await fixture.owner.create(create);
  assert.equal(created.replayed, false);
  assert.equal(createReplay.replayed, true);
  assert.equal(created.revision, 1);
  assert.equal(created.snapshot.applicantSubject, ALICE_SUBJECT);
  assert.equal(created.snapshot.status, "received");
  assert.deepEqual(createReplay.snapshot, created.snapshot);
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(created.snapshot), true);
  assert.equal(Object.isFrozen(created.snapshot.history), true);

  const reopenedAfterCreate = fixture.reopenOwner();
  assert.deepEqual(
    await reopenedAfterCreate.get(APPLICATION_ID),
    created.snapshot,
  );

  mutableCreateFields.note = "Changed retry must not replace private history.";
  mutableCreateFields.secondaryContributionAreaIds.push("area:operations");
  await rejectsStorage(
    () => fixture.owner.create(create),
    "CONFLICT",
  );
  const unchangedAfterChangedCreate = await fixture.owner.get(APPLICATION_ID);
  assert.equal(unchangedAfterChangedCreate?.history[0]?.fields.note, "Initial note.");
  assert.deepEqual(
    unchangedAfterChangedCreate?.history[0]?.fields.secondaryContributionAreaIds,
    ["area:product"],
  );

  const edit = editRequest({
    operationId: "founder-operation:edit",
    expectedRevision: 1,
    occurredAt: "2026-08-09T11:00:00.000Z",
    historyEntryId: "founder-history:edit",
    fields: fields({
      intendedContribution: "Lead a bounded product validation project.",
      secondaryContributionAreaIds: ["area:operations"],
      note: "Edited note.",
    }),
  });
  const edited = await fixture.owner.edit(edit);
  const editReplay = await fixture.reopenOwner().edit(edit);
  assert.equal(edited.replayed, false);
  assert.equal(editReplay.replayed, true);
  assert.equal(edited.revision, 2);
  assert.equal(edited.snapshot.history.length, 2);
  assert.equal(edited.snapshot.history[1]?.kind, "edited");
  assert.equal(
    edited.snapshot.fields.intendedContribution,
    "Lead a bounded product validation project.",
  );
  assert.deepEqual(edited.snapshot.history[0], created.snapshot.history[0]);
  assert.equal(created.snapshot.fields.note, "Initial note.");

  await rejectsStorage(
    () => fixture.owner.edit({
      ...edit,
      fields: fields({ note: "Changed edit retry." }),
    }),
    "CONFLICT",
  );
  await rejectsStorage(
    () => fixture.owner.edit(editRequest({
      operationId: "founder-operation:stale-edit",
      expectedRevision: 1,
      occurredAt: "2026-08-09T11:30:00.000Z",
      historyEntryId: "founder-history:stale-edit",
      fields: fields({ note: "Stale private edit." }),
    })),
    "PRECONDITION_FAILED",
  );

  const reopenedAfterEdit = fixture.reopenOwner();
  const persistedEdit = await reopenedAfterEdit.get(APPLICATION_ID);
  assert.deepEqual(persistedEdit, edited.snapshot);
  assert.equal(Object.isFrozen(persistedEdit?.history[0]), true);
  assert.equal(
    Reflect.set(persistedEdit?.history[0] ?? {}, "revision", 99),
    false,
  );

  const withdraw = withdrawRequest({
    operationId: "founder-operation:withdraw",
    expectedRevision: 2,
    occurredAt: "2026-08-09T12:00:00.000Z",
    historyEntryId: "founder-history:withdraw",
  });
  const withdrawn = await fixture.owner.withdraw(withdraw);
  const withdrawReplay = await fixture.reopenOwner().withdraw(withdraw);
  assert.equal(withdrawn.replayed, false);
  assert.equal(withdrawReplay.replayed, true);
  assert.equal(withdrawn.revision, 3);
  assert.equal(withdrawn.snapshot.status, "withdrawn");
  assert.equal(withdrawn.snapshot.history[2]?.kind, "withdrawn");
  assert.deepEqual(withdrawn.snapshot.history[0], created.snapshot.history[0]);
  assert.deepEqual(withdrawn.snapshot.history[1], edited.snapshot.history[1]);

  const resampledWithdrawReplay = await fixture.owner.withdraw({
    ...withdraw,
    occurredAt: "2026-08-09T12:01:00.000Z",
  });
  assert.equal(resampledWithdrawReplay.replayed, true);
  assert.deepEqual(resampledWithdrawReplay.snapshot, withdrawn.snapshot);

  assert.equal(await fixture.foreign.get(APPLICATION_ID), null);
  assert.equal(await fixture.anonymous.get(APPLICATION_ID), null);
  assert.equal(await fixture.denied.get(APPLICATION_ID), null);
  assert.equal(await fixture.missing.get(APPLICATION_ID), null);

  const foreignWrite = await captureStorageFailure(() =>
    fixture.foreign.edit(editRequest({
      operationId: "founder-operation:foreign-edit",
      expectedRevision: 3,
      occurredAt: "2026-08-09T13:00:00.000Z",
      historyEntryId: "founder-history:foreign-edit",
      fields: fields({ note: "Foreign private edit." }),
    })),
  );
  const missingWrite = await captureStorageFailure(() =>
    fixture.missing.edit(editRequest({
      operationId: "founder-operation:missing-edit",
      expectedRevision: 3,
      occurredAt: "2026-08-09T13:00:00.000Z",
      historyEntryId: "founder-history:missing-edit",
      fields: fields({ note: "Missing private edit." }),
    })),
  );
  const anonymousWrite = await captureStorageFailure(() =>
    fixture.anonymous.withdraw(withdrawRequest({
      operationId: "founder-operation:anonymous-withdraw",
      expectedRevision: 3,
      occurredAt: "2026-08-09T13:00:00.000Z",
      historyEntryId: "founder-history:anonymous-withdraw",
    })),
  );
  const deniedWrite = await captureStorageFailure(() =>
    fixture.denied.withdraw(withdrawRequest({
      operationId: "founder-operation:denied-withdraw",
      expectedRevision: 3,
      occurredAt: "2026-08-09T13:00:00.000Z",
      historyEntryId: "founder-history:denied-withdraw",
    })),
  );
  const anonymousCreate = await captureStorageFailure(() =>
    fixture.anonymous.create({
      operationId: "founder-operation:anonymous-create",
      expectedRevision: null,
      id: "founder-application:anonymous",
      occurredAt: "2026-08-09T13:00:00.000Z",
      historyEntryId: "founder-history:anonymous-create",
      fields: fields(),
    }),
  );

  for (const failure of [
    foreignWrite,
    missingWrite,
    anonymousWrite,
    deniedWrite,
    anonymousCreate,
  ]) {
    assert.equal(failure.code, "NOT_FOUND");
    assert.deepEqual(
      toPublicStorageFailure(failure),
      toPublicStorageFailure(missingWrite),
    );
  }
  const publicFailure = JSON.stringify(toPublicStorageFailure(foreignWrite));
  assert.equal(publicFailure.includes("Foreign private edit"), false);
  assert.equal(publicFailure.includes(APPLICATION_ID), false);
  assert.deepEqual(await fixture.owner.get(APPLICATION_ID), withdrawn.snapshot);
}

test("adapter-backed development repository passes the founder contract", async () => {
  await verifyFounderApplicationRepositoryContract(() => {
    const state = new MemoryStorageState();
    const ownerStorage = new DeterministicMemoryStorageAdapter(state, true);
    return {
      owner: repository(ownerStorage, ALICE_SUBJECT),
      reopenOwner: () => repository(ownerStorage, ALICE_SUBJECT),
      foreign: repository(ownerStorage, BOB_SUBJECT),
      anonymous: repository(ownerStorage, null),
      denied: repository(
        new DeterministicMemoryStorageAdapter(state, false),
        ALICE_SUBJECT,
      ),
      missing: repository(
        new DeterministicMemoryStorageAdapter(
          new MemoryStorageState(),
          true,
        ),
        ALICE_SUBJECT,
      ),
    };
  });
});

test("current records are checked against immutable adapter history", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state, true);
  const owner = repository(adapter, ALICE_SUBJECT);
  await owner.create(createRequest());
  await owner.edit(editRequest({
    operationId: "founder-operation:integrity-edit",
    expectedRevision: 1,
    occurredAt: "2026-08-10T11:00:00.000Z",
    historyEntryId: "founder-history:integrity-edit",
    fields: fields({ note: "Current note." }),
  }));

  const historyEntry = [...state.records.entries()].find(([, record]) =>
    record.key.collection === "founder-application-history" &&
    record.value.revision === 1
  );
  assert.notEqual(historyEntry, undefined);
  if (historyEntry === undefined) return;
  const [key, history] = historyEntry;
  const corrupted = cloneDocument(history.value) as MutableRecord;
  corrupted.operationFingerprint = `sha256:${"0".repeat(64)}`;
  state.records.set(key, freezeRecord({
    key: history.key,
    revision: history.revision,
    value: corrupted as StorageDocument,
  }));

  await rejectsStorage(
    () => repository(adapter, ALICE_SUBJECT).get(APPLICATION_ID),
    "UNAVAILABLE",
  );
});

test("compact founder records reject current, transition, reference, and chunk corruption", async (t) => {
  const baseline = new MemoryStorageState();
  const configuredChoices = maximumContributionAreaChoices();
  const baselineAdapter = new DeterministicMemoryStorageAdapter(baseline, true);
  await repository(
    baselineAdapter,
    ALICE_SUBJECT,
    configuredChoices,
  ).create({
    ...createRequest(),
    fields: maximumFields("\u0800", configuredChoices),
  });
  assert.ok(recordsIn(baseline, "founder-application-fields").length > 1);

  const corruptions: readonly Readonly<{
    name: string;
    apply(state: MemoryStorageState): void;
  }>[] = [
    {
      name: "current record",
      apply: (state) => mutateStoredDocument(
        state,
        requiredRecordIn(state, "founder-applications"),
        (document) => {
          document.unexpected = true;
        },
      ),
    },
    {
      name: "operation transition record",
      apply: (state) => mutateStoredDocument(
        state,
        requiredRecordIn(state, "founder-application-history"),
        (document) => {
          document.status = "withdrawn";
        },
      ),
    },
    {
      name: "field reference shape",
      apply: (state) => mutateStoredDocument(
        state,
        requiredRecordIn(state, "founder-applications"),
        (document) => {
          const reference = document.fields as MutableRecord;
          delete reference.hash;
        },
      ),
    },
    {
      name: "field reference revision",
      apply: (state) => mutateStoredDocument(
        state,
        requiredRecordIn(state, "founder-application-history"),
        (document) => {
          const reference = document.fields as MutableRecord;
          reference.revision = 2;
        },
      ),
    },
    {
      name: "missing chunk",
      apply: (state) => {
        const chunk = requiredRecordIn(state, "founder-application-fields");
        state.records.delete(storageKeyString(chunk.key));
      },
    },
    {
      name: "reordered chunks",
      apply: (state) => {
        const chunks = sortedFieldChunks(state);
        const first = chunks[0];
        const second = chunks[1];
        assert(first && second);
        replaceStoredDocument(state, first, second.value);
        replaceStoredDocument(state, second, first.value);
      },
    },
    {
      name: "cross-subject chunk",
      apply: (state) => mutateStoredDocument(
        state,
        requiredRecordIn(state, "founder-application-fields"),
        (document) => {
          document.applicantSubject = BOB_SUBJECT;
        },
      ),
    },
    {
      name: "chunk hash mismatch",
      apply: (state) => mutateStoredDocument(
        state,
        requiredRecordIn(state, "founder-application-fields"),
        (document) => {
          document.fieldsHash = `sha256:${"0".repeat(64)}`;
        },
      ),
    },
    {
      name: "chunk byte mismatch",
      apply: (state) => mutateStoredDocument(
        state,
        requiredRecordIn(state, "founder-application-fields"),
        (document) => {
          document.fieldsBytes = Number(document.fieldsBytes) + 1;
        },
      ),
    },
    {
      name: "chunk count mismatch",
      apply: (state) => mutateStoredDocument(
        state,
        requiredRecordIn(state, "founder-application-fields"),
        (document) => {
          document.chunkCount = Number(document.chunkCount) + 1;
        },
      ),
    },
    {
      name: "payload hash mismatch",
      apply: (state) => mutateStoredDocument(
        state,
        requiredRecordIn(state, "founder-application-fields"),
        (document) => {
          const data = String(document.data);
          document.data = `${data.startsWith("A") ? "B" : "A"}${data.slice(1)}`;
        },
      ),
    },
  ];

  for (const corruption of corruptions) {
    await t.test(corruption.name, async () => {
      const state = cloneMemoryStorageState(baseline);
      corruption.apply(state);
      await rejectsStorage(
        () => repository(
          new DeterministicMemoryStorageAdapter(state, true),
          ALICE_SUBJECT,
          configuredChoices,
        ).get(APPLICATION_ID),
        "UNAVAILABLE",
      );
    });
  }
});

test("concurrent exact creates recover one immutable server-timed result", async () => {
  const state = new MemoryStorageState();
  const adapter = new ConcurrentTransactionStorageAdapter(
    new DeterministicMemoryStorageAdapter(state, true),
  );
  const first = repository(adapter, ALICE_SUBJECT);
  const second = repository(adapter, ALICE_SUBJECT);
  const request = createRequest();

  const results = await Promise.all([
    first.create(request),
    second.create({
      ...request,
      occurredAt: "2026-08-10T10:01:00.000Z",
    }),
  ]);

  assert.deepEqual(results[0]?.snapshot, results[1]?.snapshot);
  assert.deepEqual(
    results.map((result) => result.replayed).sort(),
    [false, true],
  );
  assert.equal(state.operations.size, 1);
  assert.equal(
    state.records.size,
    2 + recordsIn(state, "founder-application-fields").length,
  );
});

test("founder writes reject a malformed transaction result matrix", async (t) => {
  const corruptions: readonly Readonly<{
    name: string;
    apply(result: StorageTransactionResult): unknown;
  }>[] = [
    {
      name: "primitive envelope",
      apply: () => null,
    },
    {
      name: "non-boolean replay marker",
      apply: (result) => ({ ...result, replayed: "false" }),
    },
    {
      name: "missing result record",
      apply: (result) => ({
        ...result,
        records: result.records.slice(0, -1),
      }),
    },
    {
      name: "sparse records array",
      apply: (result) => {
        const records = new Array(result.records.length);
        for (let index = 1; index < result.records.length; index += 1) {
          records[index] = result.records[index];
        }
        return { ...result, records };
      },
    },
    {
      name: "null current record",
      apply: (result) => ({
        ...result,
        records: [null, ...result.records.slice(1)],
      }),
    },
    {
      name: "wrong current revision",
      apply: (result) => corruptTransactionRecord(
        result,
        0,
        (record) => {
          record.revision = Number(record.revision) + 1;
        },
      ),
    },
    {
      name: "wrong operation value",
      apply: (result) => corruptTransactionRecord(
        result,
        1,
        (record) => {
          const value = record.value as MutableRecord;
          value.operationFingerprint = `sha256:${"0".repeat(64)}`;
        },
      ),
    },
    {
      name: "wrong chunk key",
      apply: (result) => corruptTransactionRecord(
        result,
        2,
        (record) => {
          const key = record.key as MutableRecord;
          key.id = "founder-fields:wrong";
        },
      ),
    },
  ];

  for (const corruption of corruptions) {
    await t.test(corruption.name, async () => {
      const state = new MemoryStorageState();
      const adapter = new MalformedTransactionResultStorageAdapter(
        new DeterministicMemoryStorageAdapter(state, true),
        corruption.apply,
      );
      await rejectsStorage(
        () => repository(adapter, ALICE_SUBJECT).create(createRequest()),
        "UNAVAILABLE",
      );
    });
  }
});

test("maximum founder payloads stay within hosted record, transaction, restart, and retry budgets", async () => {
  const state = new MemoryStorageState();
  const observed = new ObservedStorageAdapter(
    new DeterministicMemoryStorageAdapter(state, true),
  );
  const configuredChoices = maximumContributionAreaChoices();
  const owner = repository(observed, ALICE_SUBJECT, configuredChoices);
  const create = {
    operationId: "founder-operation:maximum-create",
    expectedRevision: null,
    id: APPLICATION_ID,
    occurredAt: "2026-08-10T10:00:00.000Z",
    historyEntryId: "founder-history:maximum-create",
    fields: maximumFields("\u0800", configuredChoices),
  } satisfies CreateFounderApplicationRequest;

  const created = await owner.create(create);
  assert.equal(created.revision, 1);
  assert.ok(recordsIn(state, "founder-application-fields").length > 1);
  assert.ok(
    observed.maximumRecordBytes <=
      MAX_FOUNDER_APPLICATION_STORAGE_RECORD_BYTES,
  );
  assert.ok(
    observed.maximumTransactionBytes <=
      MAX_FOUNDER_APPLICATION_STORAGE_TRANSACTION_BYTES,
  );
  assert.ok(
    observed.maximumTransactionMutations <=
      2 + MAX_FOUNDER_APPLICATION_FIELDS_CHUNKS,
  );

  observed.resetReads();
  assert.deepEqual(
    await repository(observed, ALICE_SUBJECT, configuredChoices).get(
      APPLICATION_ID,
    ),
    created.snapshot,
  );
  assert.ok(observed.reads <= MAX_FOUNDER_APPLICATION_MATERIALIZATION_READS);

  const replay = await repository(
    observed,
    ALICE_SUBJECT,
    configuredChoices,
  ).create({ ...create, occurredAt: "2026-08-10T10:01:00.000Z" });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.snapshot, created.snapshot);

  const edit = editRequest({
    operationId: "founder-operation:maximum-edit",
    expectedRevision: 1,
    occurredAt: "2026-08-10T11:00:00.000Z",
    historyEntryId: "founder-history:maximum-edit",
    fields: maximumFields("\u0801", configuredChoices),
  });
  const edited = await repository(
    observed,
    ALICE_SUBJECT,
    configuredChoices,
  ).edit(edit);
  const editReplay = await repository(
    observed,
    ALICE_SUBJECT,
    configuredChoices,
  ).edit({ ...edit, occurredAt: "2026-08-10T11:01:00.000Z" });
  assert.equal(editReplay.replayed, true);
  assert.deepEqual(editReplay.snapshot, edited.snapshot);

  const fieldsBeforeWithdrawal = recordsIn(
    state,
    "founder-application-fields",
  ).length;
  const withdrawn = await repository(
    observed,
    ALICE_SUBJECT,
    configuredChoices,
  ).withdraw(withdrawRequest({
    operationId: "founder-operation:maximum-withdraw",
    expectedRevision: 2,
    occurredAt: "2026-08-10T12:00:00.000Z",
    historyEntryId: "founder-history:maximum-withdraw",
  }));
  assert.equal(withdrawn.revision, 3);
  assert.equal(
    recordsIn(state, "founder-application-fields").length,
    fieldsBeforeWithdrawal,
  );
  assert.deepEqual(
    await repository(observed, ALICE_SUBJECT, configuredChoices).get(
      APPLICATION_ID,
    ),
    withdrawn.snapshot,
  );

  for (const record of [
    ...recordsIn(state, "founder-applications"),
    ...recordsIn(state, "founder-application-history"),
  ]) {
    assert.equal(Object.hasOwn(record.value, "application"), false);
    assert.equal(Object.hasOwn(record.value, "history"), false);
    assert.ok(jsonBytes(record.value) < 4_096);
  }
});

test("founder ancestry is finite and always reserves the final transition for withdrawal", async () => {
  const state = new MemoryStorageState();
  const observed = new ObservedStorageAdapter(
    new DeterministicMemoryStorageAdapter(state, true),
  );
  const configuredChoices = maximumContributionAreaChoices();
  const owner = repository(observed, ALICE_SUBJECT, configuredChoices);
  await owner.create({
    ...createRequest(),
    fields: maximumFields("\u0800", configuredChoices),
  });

  for (let revision = 1; revision < MAX_FOUNDER_APPLICATION_REVISIONS - 1; revision += 1) {
    await repository(observed, ALICE_SUBJECT, configuredChoices).edit(editRequest({
      operationId: `founder-operation:bounded-edit-${revision}`,
      expectedRevision: revision,
      occurredAt: new Date(
        Date.parse("2026-08-10T10:00:00.000Z") + revision * 60_000,
      ).toISOString(),
      historyEntryId: `founder-history:bounded-edit-${revision}`,
      fields: maximumFields("\u0800", configuredChoices),
    }));
  }

  await rejectsStorage(
    () => repository(observed, ALICE_SUBJECT, configuredChoices).edit(editRequest({
      operationId: "founder-operation:over-budget-edit",
      expectedRevision: MAX_FOUNDER_APPLICATION_REVISIONS - 1,
      occurredAt: "2026-08-10T11:00:00.000Z",
      historyEntryId: "founder-history:over-budget-edit",
      fields: maximumFields("\u0800", configuredChoices),
    })),
    "PRECONDITION_FAILED",
  );

  observed.resetReads();
  const received = await repository(
    observed,
    ALICE_SUBJECT,
    configuredChoices,
  ).get(APPLICATION_ID);
  assert.equal(received?.revision, MAX_FOUNDER_APPLICATION_REVISIONS - 1);
  assert.ok(observed.reads <= MAX_FOUNDER_APPLICATION_MATERIALIZATION_READS);

  const fieldRecordsBeforeWithdrawal = recordsIn(
    state,
    "founder-application-fields",
  ).length;
  const barrier = new ConcurrentTransactionStorageAdapter(
    new DeterministicMemoryStorageAdapter(state, true),
  );
  const firstObserved = new ObservedStorageAdapter(barrier);
  const secondObserved = new ObservedStorageAdapter(barrier);
  const withdrawal = withdrawRequest({
    operationId: "founder-operation:bounded-withdraw",
    expectedRevision: MAX_FOUNDER_APPLICATION_REVISIONS - 1,
    occurredAt: "2026-08-10T12:00:00.000Z",
    historyEntryId: "founder-history:bounded-withdraw",
  });
  const withdrawals = await Promise.all([
    repository(
      firstObserved,
      ALICE_SUBJECT,
      configuredChoices,
    ).withdraw(withdrawal),
    repository(
      secondObserved,
      ALICE_SUBJECT,
      configuredChoices,
    ).withdraw({
      ...withdrawal,
      occurredAt: "2026-08-10T12:01:00.000Z",
    }),
  ]);
  assert.deepEqual(withdrawals[0]?.snapshot, withdrawals[1]?.snapshot);
  assert.deepEqual(
    withdrawals.map((result) => result.replayed).sort(),
    [false, true],
  );
  const withdrawn = withdrawals[0];
  assert(withdrawn);
  assert.equal(withdrawn.revision, MAX_FOUNDER_APPLICATION_REVISIONS);
  assert.equal(
    recordsIn(state, "founder-application-history").length,
    MAX_FOUNDER_APPLICATION_REVISIONS,
  );
  assert.equal(
    recordsIn(state, "founder-application-fields").length,
    fieldRecordsBeforeWithdrawal,
  );
  assert.equal(
    state.records.size,
    1 + MAX_FOUNDER_APPLICATION_REVISIONS + fieldRecordsBeforeWithdrawal,
  );
  const observedContentionReads = Math.max(
    firstObserved.reads,
    secondObserved.reads,
  );
  assert.equal(
    observedContentionReads,
    33 + 2 * fieldRecordsBeforeWithdrawal,
  );
  assert.ok(observedContentionReads <= MAX_FOUNDER_APPLICATION_STORAGE_READS);
});

test("persisted founder history survives configured contribution choice evolution", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state, true);
  const original = repository(adapter, ALICE_SUBJECT);
  await original.create(createRequest());
  const historicalEdit = editRequest({
    operationId: "founder-operation:historical-choice-edit",
    expectedRevision: 1,
    occurredAt: "2026-08-10T11:00:00.000Z",
    historyEntryId: "founder-history:historical-choice-edit",
    fields: fields({
      primaryContributionAreaId: "area:product",
      secondaryContributionAreaIds: ["area:engineering"],
    }),
  });
  const historical = await original.edit(historicalEdit);

  const evolvedChoices = choices([
    { id: "area:commercial", label: "Commercial" },
    { id: "area:delivery", label: "Delivery" },
  ]);
  const evolved = repository(adapter, ALICE_SUBJECT, evolvedChoices);
  assert.deepEqual(await evolved.get(APPLICATION_ID), historical.snapshot);

  const replay = await evolved.edit({
    ...historicalEdit,
    occurredAt: "2026-08-10T11:01:00.000Z",
  });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.snapshot, historical.snapshot);

  await rejectsStorage(
    () => evolved.edit({
      ...historicalEdit,
      occurredAt: "2026-08-10T11:02:00.000Z",
      fields: fields({
        primaryContributionAreaId: "area:commercial",
        secondaryContributionAreaIds: ["area:delivery"],
      }),
    }),
    "CONFLICT",
  );
  await rejectsStorage(
    () => evolved.edit({
      ...historicalEdit,
      occurredAt: "2026-08-10T11:03:00.000Z",
      fields: fields({ expertiseSummary: 7 }),
    }),
    "INVALID_REQUEST",
  );

  await rejectsStorage(
    () => evolved.edit(editRequest({
      operationId: "founder-operation:removed-choice-edit",
      expectedRevision: 2,
      occurredAt: "2026-08-10T12:00:00.000Z",
      historyEntryId: "founder-history:removed-choice-edit",
      fields: fields(),
    })),
    "INVALID_REQUEST",
  );

  const current = await evolved.edit(editRequest({
    operationId: "founder-operation:evolved-choice-edit",
    expectedRevision: 2,
    occurredAt: "2026-08-10T12:00:00.000Z",
    historyEntryId: "founder-history:evolved-choice-edit",
    fields: fields({
      primaryContributionAreaId: "area:commercial",
      secondaryContributionAreaIds: ["area:delivery"],
    }),
  }));
  assert.equal(current.revision, 3);
  assert.equal(
    current.snapshot.history[1]?.fields.primaryContributionAreaId,
    "area:product",
  );
  assert.equal(
    current.snapshot.history[2]?.fields.primaryContributionAreaId,
    "area:commercial",
  );
});

test("concurrent evolved-choice work with one operation id commits once and conflicts once", async () => {
  const state = new MemoryStorageState();
  const delegate = new DeterministicMemoryStorageAdapter(state, true);
  await repository(delegate, ALICE_SUBJECT).create(createRequest());

  const barrier = new ConcurrentTransactionStorageAdapter(delegate);
  const oldChoices = repository(barrier, ALICE_SUBJECT);
  const evolvedChoices = choices([
    { id: "area:commercial", label: "Commercial" },
    { id: "area:delivery", label: "Delivery" },
  ]);
  const evolved = repository(barrier, ALICE_SUBJECT, evolvedChoices);
  const envelope = {
    operationId: "founder-operation:choice-race",
    expectedRevision: 1,
    occurredAt: "2026-08-10T11:00:00.000Z",
    historyEntryId: "founder-history:choice-race",
  } as const;

  const results = await Promise.allSettled([
    oldChoices.edit(editRequest({
      ...envelope,
      fields: fields({
        primaryContributionAreaId: "area:product",
        secondaryContributionAreaIds: ["area:engineering"],
      }),
    })),
    evolved.edit(editRequest({
      ...envelope,
      fields: fields({
        primaryContributionAreaId: "area:commercial",
        secondaryContributionAreaIds: ["area:delivery"],
      }),
    })),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert(rejected?.status === "rejected");
  assert(rejected.reason instanceof StorageFailure);
  assert.equal(rejected.reason.code, "CONFLICT");
  const current = await repository(delegate, ALICE_SUBJECT).get(APPLICATION_ID);
  assert.equal(current?.revision, 2);
  assert.equal(current?.history.length, 2);
  assert.equal(state.operations.size, 2);
});

test("configured owner can page and inspect opaque founder review records", async () => {
  const state = new MemoryStorageState();
  const adapter = new DeterministicMemoryStorageAdapter(state, true);
  const alice = repository(adapter, ALICE_SUBJECT);
  const bob = repository(adapter, BOB_SUBJECT);
  const aliceApplication = await alice.create(createRequest());
  await bob.create({
    ...createRequest(),
    operationId: "founder-operation:bob-create",
    id: "founder-application:bob",
    historyEntryId: "founder-history:bob-create",
    fields: fields({ note: "Bob private note." }),
  });

  const owner = new DevelopmentInMemoryFounderApplicationReviewRepository(
    adapter,
    OWNER_SUBJECT,
    OWNER_SUBJECT,
    contributionAreaChoices,
  );
  const firstPage = await owner.list({ limit: 1 });
  assert.equal(firstPage.items.length, 1);
  assert.notEqual(firstPage.nextCursor, null);
  const secondPage = await owner.list({
    limit: 1,
    ...(firstPage.nextCursor ? { cursor: firstPage.nextCursor } : {}),
  });
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.nextCursor, null);

  const allItems = [...firstPage.items, ...secondPage.items];
  assert.equal(new Set(allItems.map((item) => item.reviewId)).size, 2);
  for (const item of allItems) {
    assert.match(item.reviewId, /^founder-review:[0-9a-f]{64}$/);
    assert.equal(item.reviewId.includes(item.application.applicantSubject), false);
    assert.equal(Object.isFrozen(item), true);
  }
  const aliceReview = allItems.find(
    (item) => item.application.id === APPLICATION_ID,
  );
  assert.notEqual(aliceReview, undefined);
  if (aliceReview === undefined) return;
  assert.deepEqual(await owner.get(aliceReview.reviewId), aliceReview);
  assert.deepEqual(aliceReview.application, aliceApplication.snapshot);

  for (const actor of [BOB_SUBJECT, null]) {
    const foreign = new DevelopmentInMemoryFounderApplicationReviewRepository(
      adapter,
      actor,
      OWNER_SUBJECT,
      contributionAreaChoices,
    );
    assert.deepEqual(await foreign.list({ limit: 10 }), {
      items: [],
      nextCursor: null,
    });
    assert.equal(await foreign.get(aliceReview.reviewId), null);
    assert.equal(await foreign.get("malformed-review-id"), null);
  }
});

test("founder repository has no investment-indication dependency", async () => {
  const source = await readFile(
    new URL(
      "../repositories/in-memory-founder-application-repository.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(source, /investment-indication|indication-repository/);
});

function repository(
  storage: StorageAdapter,
  subject: ActorSubject | null,
  configuredChoices = contributionAreaChoices,
): DevelopmentInMemoryFounderApplicationRepository {
  return new DevelopmentInMemoryFounderApplicationRepository(
    storage,
    subject,
    configuredChoices,
  );
}

function maximumContributionAreaChoices(): readonly ContributionAreaChoice[] {
  return choices(Array.from({ length: 64 }, (_, index) => {
    const prefix = `area:${index}:`;
    return {
      id: `${prefix}${"x".repeat(128 - prefix.length)}`,
      label: `Area ${index}`,
    };
  }));
}

function maximumFields(
  character: string,
  configuredChoices: readonly ContributionAreaChoice[],
) {
  const profileLinks = Array.from({ length: 8 }, (_, index) => {
    const prefix = `https://profiles.invalid/${index}/`;
    return `${prefix}${character.repeat(2_048 - prefix.length)}`;
  });
  return fields({
    expertiseSummary: character.repeat(4_000),
    intendedContribution: character.repeat(4_000),
    primaryContributionAreaId: configuredChoices[0]?.id,
    secondaryContributionAreaIds: configuredChoices
      .slice(1, 17)
      .map((choice) => choice.id),
    approximateAvailability: character.repeat(500),
    possibleStartTiming: character.repeat(500),
    compensationExpectation: character.repeat(500),
    professionalProfileLinks: profileLinks,
    note: character.repeat(4_000),
  });
}

function recordsIn(
  state: MemoryStorageState,
  collection: string,
): readonly StorageRecord[] {
  return [...state.records.values()].filter(
    (record) => record.key.collection === collection,
  );
}

function requiredRecordIn(
  state: MemoryStorageState,
  collection: string,
): StorageRecord {
  const record = recordsIn(state, collection)[0];
  assert(record);
  return record;
}

function sortedFieldChunks(state: MemoryStorageState): readonly StorageRecord[] {
  return [...recordsIn(state, "founder-application-fields")].sort(
    (left, right) =>
      Number(left.value.chunkIndex) - Number(right.value.chunkIndex),
  );
}

function mutateStoredDocument(
  state: MemoryStorageState,
  record: StorageRecord,
  mutate: (document: MutableRecord) => void,
): void {
  const value = cloneDocument(record.value) as MutableRecord;
  mutate(value);
  replaceStoredDocument(state, record, value as StorageDocument);
}

function replaceStoredDocument(
  state: MemoryStorageState,
  record: StorageRecord,
  value: StorageDocument,
): void {
  state.records.set(storageKeyString(record.key), freezeRecord({
    key: record.key,
    revision: record.revision,
    value,
  }));
}

function cloneMemoryStorageState(source: MemoryStorageState): MemoryStorageState {
  const clone = new MemoryStorageState();
  for (const [key, record] of source.records) {
    const copied = cloneRecord(record);
    assert(copied);
    clone.records.set(key, copied);
  }
  for (const [key, operation] of source.operations) {
    clone.operations.set(key, {
      fingerprint: operation.fingerprint,
      result: cloneResult(operation.result, operation.result.replayed),
    });
  }
  return clone;
}

function corruptTransactionRecord(
  result: StorageTransactionResult,
  index: number,
  mutate: (record: MutableRecord) => void,
): unknown {
  const records = result.records.map((record) =>
    record === null ? null : cloneDocument(record as unknown as StorageDocument)
  );
  const candidate = records[index];
  assert(candidate && typeof candidate === "object" && !Array.isArray(candidate));
  mutate(candidate as MutableRecord);
  return { replayed: result.replayed, records };
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function createRequest(): CreateFounderApplicationRequest {
  return {
    operationId: "founder-operation:integrity-create",
    expectedRevision: null,
    id: APPLICATION_ID,
    occurredAt: "2026-08-10T10:00:00.000Z",
    historyEntryId: "founder-history:integrity-create",
    fields: fields(),
  };
}

function editRequest(
  input: Omit<EditFounderApplicationRequest, "id">,
): EditFounderApplicationRequest {
  return { id: APPLICATION_ID, ...input };
}

function withdrawRequest(
  input: Omit<WithdrawFounderApplicationRequest, "id">,
): WithdrawFounderApplicationRequest {
  return { id: APPLICATION_ID, ...input };
}

function fields(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    expertiseSummary: "Experience developing data systems.",
    intendedContribution: "Contribute to product development and validation.",
    primaryContributionAreaId: "area:engineering",
    secondaryContributionAreaIds: ["area:product"],
    approximateAvailability: "Part-time during the initial phase.",
    possibleStartTiming: "After mutual confirmation.",
    compensationExpectation: "Open to discussion.",
    professionalProfileLinks: ["https://profiles.invalid/alice"],
    note: "Initial note.",
    ...overrides,
  } as {
    expertiseSummary: string;
    intendedContribution: string;
    primaryContributionAreaId: string;
    secondaryContributionAreaIds: string[];
    approximateAvailability: string;
    possibleStartTiming: string;
    compensationExpectation: string;
    professionalProfileLinks: string[];
    note: string | null;
  };
}

function choices(value: unknown): readonly ContributionAreaChoice[] {
  const parsed = parseContributionAreaChoices(value);
  assert(parsed.ok);
  return parsed.value;
}

function actorSubject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  assert(parsed.ok);
  return parsed.value;
}

function applicationId(value: string): FounderApplicationId {
  const parsed = parseStableId<"founder-application">(value);
  assert(parsed.ok);
  return parsed.value;
}

async function rejectsStorage(
  operation: () => Promise<unknown>,
  code: StorageFailure["code"],
): Promise<void> {
  const failure = await captureStorageFailure(operation);
  assert.equal(failure.code, code);
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
}

class DeterministicMemoryStorageAdapter implements StorageAdapter {
  readonly #state: MemoryStorageState;
  readonly #permitted: boolean;

  constructor(state: MemoryStorageState, permitted: boolean) {
    this.#state = state;
    this.#permitted = permitted;
  }

  async read(key: StorageKey): Promise<StorageRecord | null> {
    if (!this.#permitted) return null;
    return cloneRecord(this.#state.records.get(storageKeyString(key)) ?? null);
  }

  async list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    assertStorageListBoundary(request);
    if (!this.#permitted) return { items: [], nextCursor: null };

    const start = request.cursor === undefined ? 0 : parseCursor(request.cursor);
    const all = [...this.#state.records.values()]
      .filter((record) => record.key.collection === request.collection)
      .sort((left, right) => left.key.id.localeCompare(right.key.id));
    if (start < 0 || start > all.length) {
      throw new StorageFailure("INVALID_REQUEST");
    }
    const items = all.slice(start, start + request.limit).map(cloneRecord);
    const next = start + items.length;
    return {
      items: items.filter((item): item is StorageRecord => item !== null),
      nextCursor: next < all.length
        ? (`memory-cursor:${next}` as StorageCursor)
        : null,
    };
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    assertStorageTransactionBoundary(request);
    if (!this.#permitted) throw new StorageFailure("NOT_FOUND");

    const operationKey = request.operationId as string;
    const fingerprint = JSON.stringify(request);
    const prior = this.#state.operations.get(operationKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new StorageFailure("CONFLICT");
      }
      return cloneResult(prior.result, true);
    }

    for (const mutation of request.mutations) {
      const current = this.#state.records.get(storageKeyString(mutation.key));
      if (mutation.expectedRevision === null) {
        if (current) throw new StorageFailure("CONFLICT");
      } else if (!current || current.revision !== mutation.expectedRevision) {
        throw new StorageFailure("PRECONDITION_FAILED");
      }
    }

    const nextRecords = new Map(this.#state.records);
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

    this.#state.records.clear();
    for (const [key, record] of nextRecords) {
      this.#state.records.set(key, record);
    }
    const result = Object.freeze({
      replayed: false,
      records: Object.freeze(resultRecords.map(cloneRecord)),
    });
    this.#state.operations.set(operationKey, { fingerprint, result });
    return cloneResult(result, false);
  }
}

class ObservedStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  reads = 0;
  maximumRecordBytes = 0;
  maximumTransactionBytes = 0;
  maximumTransactionMutations = 0;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  resetReads(): void {
    this.reads = 0;
  }

  read(key: StorageKey): Promise<StorageRecord | null> {
    this.reads += 1;
    return this.#delegate.read(key);
  }

  list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    return this.#delegate.list(request);
  }

  transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    this.maximumTransactionBytes = Math.max(
      this.maximumTransactionBytes,
      jsonBytes(request),
    );
    this.maximumTransactionMutations = Math.max(
      this.maximumTransactionMutations,
      request.mutations.length,
    );
    for (const mutation of request.mutations) {
      if (mutation.type !== "put") continue;
      const bytes = jsonBytes(mutation.value);
      this.maximumRecordBytes = Math.max(this.maximumRecordBytes, bytes);
      assert.ok(bytes <= MAX_FOUNDER_APPLICATION_STORAGE_RECORD_BYTES);
    }
    assert.ok(
      jsonBytes(request) <=
        MAX_FOUNDER_APPLICATION_STORAGE_TRANSACTION_BYTES,
    );
    return this.#delegate.transact(request);
  }
}

class MalformedTransactionResultStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #corrupt: (result: StorageTransactionResult) => unknown;

  constructor(
    delegate: StorageAdapter,
    corrupt: (result: StorageTransactionResult) => unknown,
  ) {
    this.#delegate = delegate;
    this.#corrupt = corrupt;
  }

  read(key: StorageKey): Promise<StorageRecord | null> {
    return this.#delegate.read(key);
  }

  list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    return this.#delegate.list(request);
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    return this.#corrupt(
      await this.#delegate.transact(request),
    ) as StorageTransactionResult;
  }
}

class ConcurrentTransactionStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #ready: Promise<void>;
  #release: (() => void) | null = null;
  #arrivals = 0;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
    this.#ready = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  read(key: StorageKey): Promise<StorageRecord | null> {
    return this.#delegate.read(key);
  }

  list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    return this.#delegate.list(request);
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    this.#arrivals += 1;
    if (this.#arrivals === 2) this.#release?.();
    await this.#ready;
    return await this.#delegate.transact(request);
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

type MutableRecord = Record<string, unknown>;

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
