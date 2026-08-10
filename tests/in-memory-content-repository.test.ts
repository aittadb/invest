import assert from "node:assert/strict";
import test from "node:test";

import {
  parseActorSubject,
  parseStableId,
  parseTimestamp,
  type ActorSubject,
  type StableId,
  type Timestamp,
} from "../domain/foundation.ts";
import {
  StorageFailure,
  assertStorageListBoundary,
  assertStorageTransactionBoundary,
  parseStorageOperationId,
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
  InMemoryAcknowledgmentRepository,
  InMemoryPackageVersionRepository,
  type CurrentPackageAcceptanceBinding,
  type RecordPackageAcceptanceRequest,
} from "../repositories/in-memory-content-repository.ts";

test("both content repositories honor replay, revision, and stale-write contracts", async () => {
  const fixture = createFixture();
  const firstDraft = packageDraft(
    "package:v1",
    "2026-08-01T09:00:00.000Z",
    true,
    "Private first version",
  );
  const firstRequest = {
    operationId: operationId("operation:package-v1"),
    expectedRevision: null,
    draft: firstDraft,
  };

  const first = await fixture.ownerPackages.append(firstRequest);
  const firstReplay = await fixture.ownerPackages.append(firstRequest);
  assert.equal(first.revision, 1);
  assert.equal(first.replayed, false);
  assert.equal(firstReplay.replayed, true);
  assert.deepEqual(firstReplay.snapshot, first.snapshot);

  await rejectsStorage(
    () => fixture.ownerPackages.append({
      ...firstRequest,
      draft: packageDraft(
        "package:v1",
        "2026-08-01T09:00:00.000Z",
        true,
        "Changed retry",
      ),
    }),
    "CONFLICT",
  );

  const second = await fixture.ownerPackages.append({
    operationId: operationId("operation:package-v2"),
    expectedRevision: 1,
    draft: packageDraft(
      "package:v2",
      "2026-08-01T10:00:00.000Z",
      false,
      "Private second version",
    ),
  });
  assert.equal(second.revision, 2);

  await rejectsStorage(
    () => fixture.ownerPackages.append({
      operationId: operationId("operation:package-v3-stale"),
      expectedRevision: 1,
      draft: packageDraft(
        "package:v3",
        "2026-08-01T11:00:00.000Z",
        true,
        "Stale package version",
      ),
    }),
    "PRECONDITION_FAILED",
  );
  assert.equal(
    await fixture.ownerPackages.get(stableId("package:v3")),
    null,
  );

  const firstAcceptanceRequest = acceptanceRequest(
    "acceptance:one",
    "package:v2",
    "2026-08-01T10:05:00.000Z",
    "operation:acceptance-one",
    null,
  );
  const firstAcceptance = await fixture.aliceAcknowledgments.record(
    firstAcceptanceRequest,
  );
  const acceptanceReplay = await fixture.aliceAcknowledgments.record(
    firstAcceptanceRequest,
  );
  assert.equal(firstAcceptance.revision, 1);
  assert.equal(acceptanceReplay.replayed, true);
  assert.deepEqual(acceptanceReplay.snapshot, firstAcceptance.snapshot);

  await rejectsStorage(
    () => fixture.aliceAcknowledgments.record({
      ...firstAcceptanceRequest,
      acceptedAt: timestamp("2026-08-01T10:06:00.000Z"),
    }),
    "CONFLICT",
  );

  const third = await fixture.ownerPackages.append({
    operationId: operationId("operation:package-v3"),
    expectedRevision: 2,
    draft: packageDraft(
      "package:v3",
      "2026-08-01T11:00:00.000Z",
      true,
      "Current third version",
    ),
  });
  const secondAcceptance = await fixture.aliceAcknowledgments.record(
    acceptanceRequest(
      "acceptance:two",
      third.snapshot.id,
      "2026-08-01T11:05:00.000Z",
      "operation:acceptance-two",
      1,
    ),
  );
  assert.equal(secondAcceptance.revision, 2);

  const fourth = await fixture.ownerPackages.append({
    operationId: operationId("operation:package-v4"),
    expectedRevision: 3,
    draft: packageDraft(
      "package:v4",
      "2026-08-01T12:00:00.000Z",
      true,
      "Current fourth version",
    ),
  });
  const staleAcceptanceId = stableId<"package-acceptance">("acceptance:stale");
  await rejectsStorage(
    () => fixture.aliceAcknowledgments.record({
      operationId: operationId("operation:acceptance-stale"),
      expectedRevision: 1,
      id: staleAcceptanceId,
      acceptedAt: timestamp("2026-08-01T12:05:00.000Z"),
      acceptedVersionId: fourth.snapshot.id,
    }),
    "PRECONDITION_FAILED",
  );
  assert.equal(
    await fixture.aliceAcknowledgments.get(staleAcceptanceId),
    null,
  );
  assert.equal((await fixture.ownerPackages.current())?.revision, 4);
  assert.equal((await fixture.aliceAcknowledgments.latest())?.revision, 2);
});

test("snapshots stay immutable and material changes renew acceptance", async () => {
  const fixture = createFixture();
  const mutableDraft = packageDraft(
    "package:material-v1",
    "2026-08-02T09:00:00.000Z",
    true,
    "Original private title",
  );
  const first = await fixture.ownerPackages.append({
    operationId: operationId("operation:material-v1"),
    expectedRevision: null,
    draft: mutableDraft,
  });

  mutableDraft.changeSummary = "Mutated input";
  mutableDraft.sections[0].title = "Mutated private title";
  const historical = await fixture.ownerPackages.get(first.snapshot.id);
  assert.equal(historical?.changeSummary, "Version package:material-v1");
  assert.equal(historical?.sections[0].title, "Original private title");
  assert.equal(Object.isFrozen(historical), true);
  assert.equal(Object.isFrozen(historical?.sections), true);
  assert.equal(Object.isFrozen(historical?.sections[0]), true);
  assert.equal(
    Reflect.set(historical as object, "changeSummary", "Changed output"),
    false,
  );

  assert.equal(
    await fixture.aliceAcknowledgments.requiresCurrentAcceptance(),
    true,
  );
  const acceptedFirst = await fixture.aliceAcknowledgments.record(
    acceptanceRequest(
      "acceptance:material-v1",
      first.snapshot.id,
      "2026-08-02T09:05:00.000Z",
      "operation:material-accept-v1",
      null,
    ),
  );
  assert.equal(Object.isFrozen(acceptedFirst.snapshot), true);
  assert.equal(
    await fixture.aliceAcknowledgments.requiresCurrentAcceptance(),
    false,
  );

  const nonMaterial = await fixture.ownerPackages.append({
    operationId: operationId("operation:material-v2"),
    expectedRevision: 1,
    draft: packageDraft(
      "package:material-v2",
      "2026-08-02T10:00:00.000Z",
      false,
      "Editorial correction",
    ),
  });
  assert.notEqual(nonMaterial.snapshot.contentHash, first.snapshot.contentHash);
  assert.equal(
    nonMaterial.snapshot.requiredAcceptanceHash,
    first.snapshot.requiredAcceptanceHash,
  );
  assert.equal(
    await fixture.aliceAcknowledgments.requiresCurrentAcceptance(),
    false,
  );

  const materialDraft = packageDraft(
    "package:material-v3",
    "2026-08-02T11:00:00.000Z",
    true,
    "Material terms changed",
  ) as ReturnType<typeof packageDraft> & {
    requiredAcceptanceHash?: string;
  };
  materialDraft.requiredAcceptanceHash = first.snapshot.requiredAcceptanceHash;
  const material = await fixture.ownerPackages.append({
    operationId: operationId("operation:material-v3"),
    expectedRevision: 2,
    draft: materialDraft,
  });
  assert.equal(
    material.snapshot.requiredAcceptanceHash,
    material.snapshot.contentHash,
  );
  assert.notEqual(
    material.snapshot.requiredAcceptanceHash,
    first.snapshot.requiredAcceptanceHash,
  );
  assert.equal(
    await fixture.aliceAcknowledgments.requiresCurrentAcceptance(),
    true,
  );

  await rejectsStorage(
    () => fixture.aliceAcknowledgments.record(
      acceptanceRequest(
        "acceptance:historical",
        nonMaterial.snapshot.id,
        "2026-08-02T11:05:00.000Z",
        "operation:historical-acceptance",
        1,
      ),
    ),
    "PRECONDITION_FAILED",
  );

  const acceptedMaterial = await fixture.aliceAcknowledgments.record(
    acceptanceRequest(
      "acceptance:material-v3",
      material.snapshot.id,
      "2026-08-02T11:06:00.000Z",
      "operation:material-accept-v3",
      1,
    ),
  );
  assert.equal(
    acceptedMaterial.snapshot.satisfiedRequirementHash,
    material.snapshot.requiredAcceptanceHash,
  );
  assert.equal(
    await fixture.aliceAcknowledgments.requiresCurrentAcceptance(),
    false,
  );
});

test("acceptance gate rejects a package published after the acceptance read", async () => {
  const state = new MemoryStorageState();
  const ownerStorage = new DeterministicMemoryStorageAdapter(
    state,
    () => true,
    () => true,
  );
  const participantStorage = new DeterministicMemoryStorageAdapter(
    state,
    () => true,
    () => true,
  );
  const interleavedStorage = new InterleavingStorageAdapter(participantStorage);
  const ownerPackages = new InMemoryPackageVersionRepository(ownerStorage);
  const participantPackages = new InMemoryPackageVersionRepository(
    interleavedStorage,
  );
  const acknowledgments = new InMemoryAcknowledgmentRepository(
    interleavedStorage,
    participantPackages,
    actorSubject("oidc:acceptance-race"),
  );
  const first = await ownerPackages.append({
    operationId: operationId("operation:acceptance-race-v1"),
    expectedRevision: null,
    draft: packageDraft(
      "package:acceptance-race-v1",
      "2026-08-02T12:00:00.000Z",
      true,
      "Initial requirement",
    ),
  });

  interleavedStorage.beforeNextAcceptanceTransaction(async () => {
    await ownerPackages.append({
      operationId: operationId("operation:acceptance-race-v2"),
      expectedRevision: first.revision,
      draft: packageDraft(
        "package:acceptance-race-v2",
        "2026-08-02T12:01:00.000Z",
        true,
        "Replacement requirement",
      ),
    });
  });

  const staleAcceptanceId = stableId<"package-acceptance">(
    "acceptance:package-race",
  );
  await rejectsStorage(
    () => acknowledgments.record({
      operationId: operationId("operation:acceptance-package-race"),
      expectedRevision: null,
      id: staleAcceptanceId,
      acceptedAt: timestamp("2026-08-02T12:02:00.000Z"),
      acceptedVersionId: first.snapshot.id,
    }),
    "PRECONDITION_FAILED",
  );

  assert.equal(await acknowledgments.get(staleAcceptanceId), null);
  assert.equal(await acknowledgments.latest(), null);
  assert.equal(await acknowledgments.requiresCurrentAcceptance(), true);
  assert.equal((await ownerPackages.current())?.revision, 2);

  const current = await ownerPackages.current();
  assert(current);
  await acknowledgments.record(
    acceptanceRequest(
      "acceptance:package-race-current",
      current.snapshot.id,
      "2026-08-02T12:03:00.000Z",
      "operation:acceptance-package-race-current",
      null,
    ),
  );
  assert.equal((await ownerPackages.current())?.revision, 2);
  assert.equal(await acknowledgments.requiresCurrentAcceptance(), false);
});

test("acceptance status retries an interleaved gate and never satisfies an obsolete requirement", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(
    state,
    () => true,
    () => true,
  );
  const packages = new InMemoryPackageVersionRepository(storage);
  const subject = actorSubject("oidc:acceptance-status-race");
  const acknowledgments = new InMemoryAcknowledgmentRepository(
    storage,
    packages,
    subject,
  );
  const first = await packages.append({
    operationId: operationId("operation:acceptance-status-v1"),
    expectedRevision: null,
    draft: packageDraft(
      "package:acceptance-status-v1",
      "2026-08-02T13:00:00.000Z",
      true,
      "Accepted old requirement",
    ),
  });
  await acknowledgments.record(
    acceptanceRequest(
      "acceptance:status-v1",
      first.snapshot.id,
      "2026-08-02T13:01:00.000Z",
      "operation:acceptance-status-record-v1",
      null,
    ),
  );
  const second = await packages.append({
    operationId: operationId("operation:acceptance-status-v2"),
    expectedRevision: first.revision,
    draft: packageDraft(
      "package:acceptance-status-v2",
      "2026-08-02T13:02:00.000Z",
      true,
      "New current requirement",
    ),
  });
  const oldBinding = Object.freeze({
    bindingRevision: 2,
    snapshot: first.snapshot,
  });
  const currentBinding = Object.freeze({
    bindingRevision: 3,
    snapshot: second.snapshot,
  });
  const interleavedPackages = new SequencedAcceptanceBindingRepository(
    storage,
    [oldBinding, currentBinding, currentBinding, currentBinding],
  );
  const interleavedAcknowledgments = new InMemoryAcknowledgmentRepository(
    storage,
    interleavedPackages,
    subject,
  );
  assert.equal(
    await interleavedAcknowledgments.requiresCurrentAcceptance(),
    true,
  );
  assert.equal(interleavedPackages.bindingReads, 4);

  const churningPackages = new SequencedAcceptanceBindingRepository(
    storage,
    Array.from({ length: 6 }, (_, index) => Object.freeze({
      bindingRevision: 10 + index,
      snapshot: second.snapshot,
    })),
  );
  const churningAcknowledgments = new InMemoryAcknowledgmentRepository(
    storage,
    churningPackages,
    subject,
  );
  await rejectsStorage(
    () => churningAcknowledgments.requiresCurrentAcceptance(),
    "UNAVAILABLE",
  );
  assert.equal(churningPackages.bindingReads, 6);
});

test("subjects and adapter grants prevent private or foreign disclosure", async () => {
  const fixture = createFixture();
  const privateDraft = packageDraft(
    "package:private",
    "2026-08-03T09:00:00.000Z",
    true,
    "Confidential allocation discussion",
  );
  privateDraft.sections[0].markdown = "Private package value: never disclose";
  const stored = await fixture.ownerPackages.append({
    operationId: operationId("operation:private-package"),
    expectedRevision: null,
    draft: privateDraft,
  });

  assert.equal(
    (await fixture.participantPackages.current())?.snapshot.id,
    stored.snapshot.id,
  );
  assert.equal(await fixture.visitorPackages.current(), null);
  assert.equal(await fixture.visitorPackages.get(stored.snapshot.id), null);

  const deniedPackageError = await captureStorageFailure(
    () => fixture.visitorPackages.append({
      operationId: operationId("operation:visitor-private-write"),
      expectedRevision: null,
      draft: privateDraft,
    }),
  );
  assert.equal(deniedPackageError.code, "NOT_FOUND");
  const publicFailure = JSON.stringify(
    toPublicStorageFailure(deniedPackageError),
  );
  assert.equal(publicFailure.includes("never disclose"), false);
  assert.equal(publicFailure.includes("package:private"), false);

  const maliciousRequest = {
    ...acceptanceRequest(
      "acceptance:alice-private",
      stored.snapshot.id,
      "2026-08-03T09:05:00.000Z",
      "operation:alice-private-acceptance",
      null,
    ),
    participantSubject: fixture.bob,
    acceptedContentHash: "sha256:client-controlled",
    satisfiedRequirementHash: "sha256:client-controlled",
  } as unknown as RecordPackageAcceptanceRequest;
  const accepted = await fixture.aliceAcknowledgments.record(maliciousRequest);
  assert.equal(accepted.snapshot.participantSubject, fixture.alice);
  assert.equal(
    accepted.snapshot.acceptedContentHash,
    stored.snapshot.contentHash,
  );
  assert.equal(
    accepted.snapshot.satisfiedRequirementHash,
    stored.snapshot.requiredAcceptanceHash,
  );

  assert.equal(
    await fixture.bobAcknowledgments.get(accepted.snapshot.id),
    null,
  );
  assert.equal(await fixture.bobAcknowledgments.latest(), null);
  assert.equal(
    await fixture.visitorAcknowledgments.get(accepted.snapshot.id),
    null,
  );
  assert.equal(await fixture.visitorAcknowledgments.latest(), null);

  const visitorAcceptanceError = await captureStorageFailure(
    () => fixture.visitorAcknowledgments.record(
      acceptanceRequest(
        "acceptance:visitor",
        stored.snapshot.id,
        "2026-08-03T09:06:00.000Z",
        "operation:visitor-acceptance",
        null,
      ),
    ),
  );
  assert.equal(visitorAcceptanceError.code, "NOT_FOUND");
  assert.deepEqual(
    toPublicStorageFailure(visitorAcceptanceError),
    toPublicStorageFailure(deniedPackageError),
  );
  await rejectsStorage(
    () => fixture.visitorAcknowledgments.requiresCurrentAcceptance(),
    "NOT_FOUND",
  );
});

test("stored package records reject hostile envelopes and closed-document drift", async () => {
  const fixture = await createStrictRecordFixture();
  const collections = [
    "private-package-versions",
    "private-package-operation-intents",
    "private-package-version-sections",
    "private-package-section-chunks",
    "private-package-version-heads",
    "private-package-acceptance-bindings",
    "private-package-acceptances",
    "private-package-acceptance-heads",
  ] as const;
  const immutable = new Set<string>([
    "private-package-versions",
    "private-package-operation-intents",
    "private-package-version-sections",
    "private-package-section-chunks",
    "private-package-acceptances",
  ]);
  const mutations = [
    {
      name: "wrong requested key",
      mutate: (record: StorageRecord) => freezeRecord({
        key: {
          ...record.key,
          id: stableId<"storage-record">("hostile-record-key"),
        },
        revision: record.revision,
        value: record.value,
      }),
    },
    {
      name: "extra document field",
      mutate: (record: StorageRecord) => freezeRecord({
        key: record.key,
        revision: record.revision,
        value: { ...record.value, hostile: true },
      }),
    },
    {
      name: "wrong schema",
      mutate: (record: StorageRecord) => freezeRecord({
        key: record.key,
        revision: record.revision,
        value: { ...record.value, schemaVersion: 2 },
      }),
    },
    {
      name: "wrong kind",
      mutate: (record: StorageRecord) => freezeRecord({
        key: record.key,
        revision: record.revision,
        value: { ...record.value, kind: "hostile-record" },
      }),
    },
  ];

  for (const collection of collections) {
    for (const mutation of mutations) {
      const adapter = new ReadTamperingStorageAdapter(
        fixture.storage,
        collection,
        mutation.mutate,
      );
      await rejectsStorage(
        () => probeStoredCollection(adapter, fixture.subject, collection),
        "UNAVAILABLE",
      );
    }
    if (immutable.has(collection)) {
      const revisionTwo = new ReadTamperingStorageAdapter(
        fixture.storage,
        collection,
        (record) => freezeRecord({
          key: record.key,
          revision: 2,
          value: record.value,
        }),
      );
      await rejectsStorage(
        () => probeStoredCollection(revisionTwo, fixture.subject, collection),
        "UNAVAILABLE",
      );
    }
  }

  const semanticDrift = [
    {
      collection: "private-package-versions",
      mutate: (record: StorageRecord) => withRecordValue(record, {
        ...record.value,
        sectionRecordIds: [
          ...(record.value.sectionRecordIds as string[]),
          ...(record.value.sectionRecordIds as string[]),
        ],
      }),
    },
    {
      collection: "private-package-version-sections",
      mutate: (record: StorageRecord) => withRecordValue(record, {
        ...record.value,
        order: 1,
      }),
    },
    {
      collection: "private-package-section-chunks",
      mutate: (record: StorageRecord) => withRecordValue(record, {
        ...record.value,
        index: 1,
      }),
    },
    {
      collection: "private-package-acceptance-bindings",
      mutate: (record: StorageRecord) => withRecordValue(record, {
        ...record.value,
        requiredAcceptanceHash: `sha256:${"f".repeat(64)}`,
      }),
    },
    {
      collection: "private-package-operation-intents",
      mutate: (record: StorageRecord) => withRecordValue(record, {
        ...record.value,
        normalizedMutationHash: `sha256:${"e".repeat(64)}`,
      }),
    },
    {
      collection: "private-package-operation-intents",
      mutate: (record: StorageRecord) => withRecordValue(record, {
        ...record.value,
        createdAt: "2026-08-03T11:00:00.000Z",
      }),
    },
    {
      collection: "private-package-acceptances",
      mutate: (record: StorageRecord) => withRecordValue(record, {
        ...record.value,
        acceptedContentHash: `sha256:${"d".repeat(64)}`,
      }),
    },
  ] as const;
  for (const drift of semanticDrift) {
    const adapter = new ReadTamperingStorageAdapter(
      fixture.storage,
      drift.collection,
      drift.mutate,
    );
    await rejectsStorage(
      () => probeStoredCollection(adapter, fixture.subject, drift.collection),
      "UNAVAILABLE",
    );
  }

  const oversizedChunk = new ReadTamperingStorageAdapter(
    fixture.storage,
    "private-package-section-chunks",
    (record) => withRecordValue(record, {
      ...record.value,
      markdown: "x".repeat(60_000),
    }),
  );
  await rejectsStorage(
    () => probeStoredCollection(
      oversizedChunk,
      fixture.subject,
      "private-package-section-chunks",
    ),
    "UNAVAILABLE",
  );
});

test("64 section manifests with 64 chunks each fail before chunk allocation", async () => {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(
    state,
    () => true,
    () => true,
  );
  const packages = new InMemoryPackageVersionRepository(storage);
  await packages.append({
    operationId: operationId("operation:hostile-64x64-package"),
    expectedRevision: null,
    draft: {
      id: "package:hostile-64x64",
      createdAt: "2026-08-03T10:00:00.000Z",
      changeSummary: "Created a maximum section package",
      materialChange: true,
      acknowledgmentText: "I acknowledge the maximum section package.",
      sections: Array.from({ length: 64 }, (_, index) => ({
        id: `section:hostile-64x64-${index}`,
        order: index,
        title: `Section ${index + 1}`,
        markdown: "Bounded content",
        enabled: true,
      })),
    },
  });
  const chunkIds = Array.from({ length: 64 }, (_, index) =>
    stableId<"storage-record">(`hostile-chunk-${index}`)
  );
  const tampered = new ReadTamperingStorageAdapter(
    storage,
    "private-package-version-sections",
    (record) => withRecordValue(record, {
      ...record.value,
      chunkRecordIds: chunkIds,
    }),
  );
  await rejectsStorage(
    () => new InMemoryPackageVersionRepository(tampered).current(),
    "UNAVAILABLE",
  );
  assert.equal(
    tampered.readsByCollection.get("private-package-section-chunks") ?? 0,
    0,
  );
});

test("intent, stage, package, audit, and acknowledgment reject malformed transaction results", async () => {
  const variants: readonly Readonly<{
    name: string;
    tamper: (
      result: StorageTransactionResult,
    ) => unknown;
  }>[] = [
    {
      name: "non-boolean replay",
      tamper: (result) => ({ ...result, replayed: "false" }),
    },
    {
      name: "extra result field",
      tamper: (result) => ({ ...result, extra: true }),
    },
    {
      name: "missing result record",
      tamper: (result) => ({ ...result, records: result.records.slice(0, -1) }),
    },
    {
      name: "extra result record",
      tamper: (result) => ({
        ...result,
        records: [...result.records, result.records[0] ?? null],
      }),
    },
    {
      name: "null positional record",
      tamper: (result) => ({
        ...result,
        records: [null, ...result.records.slice(1)],
      }),
    },
    {
      name: "mismatched positional key",
      tamper: (result) => ({
        ...result,
        records: replaceTransactionRecord(result, 0, (record) => ({
          ...record,
          key: { ...record.key, id: "hostile-result-key" },
        })),
      }),
    },
    {
      name: "mismatched positional revision",
      tamper: (result) => ({
        ...result,
        records: replaceTransactionRecord(result, 0, (record) => ({
          ...record,
          revision: record.revision + 1,
        })),
      }),
    },
    {
      name: "mismatched positional value",
      tamper: (result) => ({
        ...result,
        records: replaceTransactionRecord(result, 0, (record) => ({
          ...record,
          value: { ...record.value, hostile: true },
        })),
      }),
    },
    {
      name: "extra record envelope field",
      tamper: (result) => ({
        ...result,
        records: replaceTransactionRecord(result, 0, (record) => ({
          ...record,
          hostile: true,
        })),
      }),
    },
    {
      name: "mismatched final audit value",
      tamper: (result) => ({
        ...result,
        records: replaceTransactionRecord(
          result,
          result.records.length - 1,
          (record) => ({
            ...record,
            value: { ...record.value, hostile: true },
          }),
        ),
      }),
    },
  ];
  const targets = [
    "private-package-operation-intents",
    "private-package-section-chunks",
    "private-package-versions",
    "private-package-acceptances",
  ] as const;

  for (const [targetIndex, target] of targets.entries()) {
    for (const [variantIndex, variant] of variants.entries()) {
      await rejectsStorage(
        () => runMalformedTransactionResult(
          target,
          variant.tamper,
          targetIndex * variants.length + variantIndex,
        ),
        "UNAVAILABLE",
      );
    }
  }
});

type Fixture = Readonly<{
  alice: ActorSubject;
  bob: ActorSubject;
  ownerPackages: InMemoryPackageVersionRepository;
  participantPackages: InMemoryPackageVersionRepository;
  visitorPackages: InMemoryPackageVersionRepository;
  aliceAcknowledgments: InMemoryAcknowledgmentRepository;
  bobAcknowledgments: InMemoryAcknowledgmentRepository;
  visitorAcknowledgments: InMemoryAcknowledgmentRepository;
}>;

async function createStrictRecordFixture(): Promise<Readonly<{
  storage: StorageAdapter;
  subject: ActorSubject;
}>> {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(
    state,
    () => true,
    () => true,
  );
  const packages = new InMemoryPackageVersionRepository(storage);
  const subject = actorSubject("oidc:strict-record-fixture");
  const acknowledgments = new InMemoryAcknowledgmentRepository(
    storage,
    packages,
    subject,
  );
  const version = await packages.append({
    operationId: operationId("operation:strict-record-package"),
    expectedRevision: null,
    draft: packageDraft(
      "package:strict-record",
      "2026-08-03T09:30:00.000Z",
      true,
      "Strict stored package",
    ),
  });
  await acknowledgments.record(
    acceptanceRequest(
      "acceptance:strict-record",
      version.snapshot.id,
      "2026-08-03T09:31:00.000Z",
      "operation:strict-record-acceptance",
      null,
    ),
  );
  return Object.freeze({ storage, subject });
}

async function probeStoredCollection(
  storage: StorageAdapter,
  subject: ActorSubject,
  collection: string,
): Promise<unknown> {
  const packages = new InMemoryPackageVersionRepository(storage);
  if (collection === "private-package-acceptance-bindings") {
    return packages.currentAcceptanceBinding();
  }
  if (
    collection === "private-package-acceptances" ||
    collection === "private-package-acceptance-heads"
  ) {
    return new InMemoryAcknowledgmentRepository(
      storage,
      packages,
      subject,
    ).latest();
  }
  return packages.current();
}

function withRecordValue(
  record: StorageRecord,
  value: StorageDocument,
): StorageRecord {
  return freezeRecord({ key: record.key, revision: record.revision, value });
}

function replaceTransactionRecord(
  result: StorageTransactionResult,
  index: number,
  replace: (record: StorageRecord) => unknown,
): readonly unknown[] {
  const record = result.records[index];
  assert(record);
  return result.records.map((candidate, candidateIndex) =>
    candidateIndex === index ? replace(record) : candidate
  );
}

async function runMalformedTransactionResult(
  targetCollection: string,
  tamper: (result: StorageTransactionResult) => unknown,
  suffix: number,
): Promise<unknown> {
  const state = new MemoryStorageState();
  const storage = new DeterministicMemoryStorageAdapter(
    state,
    () => true,
    () => true,
  );
  const owner = actorSubject(`oidc:malformed-result-owner-${suffix}`);
  if (targetCollection === "private-package-acceptances") {
    const packages = new InMemoryPackageVersionRepository(storage);
    const version = await packages.append({
      operationId: operationId(`operation:malformed-ack-package-${suffix}`),
      expectedRevision: null,
      draft: packageDraft(
        `package:malformed-ack-${suffix}`,
        "2026-08-03T11:00:00.000Z",
        true,
        "Malformed acknowledgment result",
      ),
    });
    const tampered = new TransactionResultTamperingAdapter(
      storage,
      targetCollection,
      tamper,
    );
    const participantPackages = new InMemoryPackageVersionRepository(tampered);
    return new InMemoryAcknowledgmentRepository(
      tampered,
      participantPackages,
      owner,
    ).record(
      acceptanceRequest(
        `acceptance:malformed-result-${suffix}`,
        version.snapshot.id,
        "2026-08-03T11:01:00.000Z",
        `operation:malformed-ack-result-${suffix}`,
        null,
      ),
    );
  }

  const tampered = new TransactionResultTamperingAdapter(
    storage,
    targetCollection,
    tamper,
  );
  return new InMemoryPackageVersionRepository(tampered).appendWithAudit({
    operationId: operationId(`operation:malformed-package-result-${suffix}`),
    expectedRevision: null,
    ownerSubject: owner,
    draft: packageDraft(
      `package:malformed-result-${suffix}`,
      "2026-08-03T11:00:00.000Z",
      true,
      "Malformed package transaction result",
    ),
  });
}

function createFixture(): Fixture {
  const state = new MemoryStorageState();
  const ownerStorage = new DeterministicMemoryStorageAdapter(
    state,
    () => true,
    () => true,
  );
  const participantStorage = new DeterministicMemoryStorageAdapter(
    state,
    () => true,
    (key) => key.collection.startsWith("private-package-acceptance"),
  );
  const visitorStorage = new DeterministicMemoryStorageAdapter(
    state,
    () => false,
    () => false,
  );
  const ownerPackages = new InMemoryPackageVersionRepository(ownerStorage);
  const participantPackages = new InMemoryPackageVersionRepository(
    participantStorage,
  );
  const visitorPackages = new InMemoryPackageVersionRepository(visitorStorage);
  const alice = actorSubject("oidc:alice");
  const bob = actorSubject("oidc:bob");

  return {
    alice,
    bob,
    ownerPackages,
    participantPackages,
    visitorPackages,
    aliceAcknowledgments: new InMemoryAcknowledgmentRepository(
      participantStorage,
      participantPackages,
      alice,
    ),
    bobAcknowledgments: new InMemoryAcknowledgmentRepository(
      participantStorage,
      participantPackages,
      bob,
    ),
    visitorAcknowledgments: new InMemoryAcknowledgmentRepository(
      visitorStorage,
      visitorPackages,
      null,
    ),
  };
}

function packageDraft(
  id: string,
  createdAt: string,
  materialChange: boolean,
  title: string,
) {
  return {
    id,
    createdAt,
    changeSummary: `Version ${id}`,
    materialChange,
    acknowledgmentText: "I acknowledge this information package.",
    sections: [
      {
        id: `section:${id}`,
        order: 0,
        title,
        markdown: `# ${title}`,
        enabled: true,
      },
    ],
  };
}

function acceptanceRequest(
  id: string,
  versionId: string,
  acceptedAt: string,
  operation: string,
  expectedRevision: number | null,
): RecordPackageAcceptanceRequest {
  return {
    operationId: operationId(operation),
    expectedRevision,
    id: stableId<"package-acceptance">(id),
    acceptedAt: timestamp(acceptedAt),
    acceptedVersionId: stableId<"package-version">(versionId),
  };
}

function actorSubject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  assert(parsed.ok);
  return parsed.value;
}

function stableId<Entity extends string>(value: string): StableId<Entity> {
  const parsed = parseStableId<Entity>(value);
  assert(parsed.ok);
  return parsed.value;
}

function timestamp(value: string): Timestamp {
  const parsed = parseTimestamp(value);
  assert(parsed.ok);
  return parsed.value;
}

function operationId(value: string) {
  const parsed = parseStorageOperationId(value);
  assert(parsed.ok);
  return parsed.value;
}

async function rejectsStorage(
  operation: () => Promise<unknown>,
  code: StorageFailure["code"],
): Promise<void> {
  const error = await captureStorageFailure(operation);
  assert.equal(error.code, code);
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

type StorageAccess = (key: StorageKey) => boolean;

class MemoryStorageState {
  readonly records = new Map<string, StorageRecord>();
  readonly operations = new Map<
    string,
    Readonly<{ fingerprint: string; result: StorageTransactionResult }>
  >();
}

class DeterministicMemoryStorageAdapter implements StorageAdapter {
  readonly #state: MemoryStorageState;
  readonly #canRead: StorageAccess;
  readonly #canWrite: StorageAccess;

  constructor(
    state: MemoryStorageState,
    canRead: StorageAccess,
    canWrite: StorageAccess,
  ) {
    this.#state = state;
    this.#canRead = canRead;
    this.#canWrite = canWrite;
  }

  async read(key: StorageKey): Promise<StorageRecord | null> {
    if (!this.#canRead(key)) return null;
    return cloneRecord(this.#state.records.get(storageKeyString(key)) ?? null);
  }

  async list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    assertStorageListBoundary(request);
    const start = request.cursor === undefined ? 0 : parseCursor(request.cursor);
    const all = [...this.#state.records.values()]
      .filter(
        (record) =>
          record.key.collection === request.collection &&
          this.#canRead(record.key),
      )
      .sort((left, right) => left.key.id.localeCompare(right.key.id));
    if (start < 0 || start > all.length) {
      throw new StorageFailure("INVALID_REQUEST");
    }
    const items = all
      .slice(start, start + request.limit)
      .map((record) => cloneRecord(record))
      .filter((record): record is StorageRecord => record !== null);
    const next = start + items.length;
    return {
      items: Object.freeze(items),
      nextCursor: next < all.length
        ? (`cursor:${next}` as StorageCursor)
        : null,
    };
  }

  async transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    assertStorageTransactionBoundary(request);
    if (request.mutations.some((mutation) => !this.#canWrite(mutation.key))) {
      throw new StorageFailure("NOT_FOUND");
    }

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
    const records: (StorageRecord | null)[] = [];
    for (const mutation of request.mutations) {
      const key = storageKeyString(mutation.key);
      const current = nextRecords.get(key);
      if (mutation.type === "delete") {
        nextRecords.delete(key);
        records.push(null);
        continue;
      }
      const record = freezeRecord({
        key: mutation.key,
        revision: (current?.revision ?? 0) + 1,
        value: mutation.value,
      });
      nextRecords.set(key, record);
      records.push(record);
    }

    this.#state.records.clear();
    for (const [key, record] of nextRecords) {
      this.#state.records.set(key, record);
    }
    const result: StorageTransactionResult = Object.freeze({
      replayed: false,
      records: Object.freeze(records.map((record) => cloneRecord(record))),
    });
    this.#state.operations.set(operationKey, { fingerprint, result });
    return cloneResult(result, false);
  }
}

class InterleavingStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  #beforeAcceptanceTransaction: (() => Promise<void>) | null = null;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  beforeNextAcceptanceTransaction(callback: () => Promise<void>): void {
    this.#beforeAcceptanceTransaction = callback;
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
    const callback = request.mutations.some(
        (mutation) =>
          mutation.key.collection === "private-package-acceptances",
      )
      ? this.#beforeAcceptanceTransaction
      : null;
    if (callback !== null) {
      this.#beforeAcceptanceTransaction = null;
      await callback();
    }
    return this.#delegate.transact(request);
  }
}

class ReadTamperingStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #collection: string;
  readonly #mutate: (record: StorageRecord) => StorageRecord;
  readonly readsByCollection = new Map<string, number>();

  constructor(
    delegate: StorageAdapter,
    collection: string,
    mutate: (record: StorageRecord) => StorageRecord,
  ) {
    this.#delegate = delegate;
    this.#collection = collection;
    this.#mutate = mutate;
  }

  async read(key: StorageKey): Promise<StorageRecord | null> {
    this.readsByCollection.set(
      key.collection,
      (this.readsByCollection.get(key.collection) ?? 0) + 1,
    );
    const record = await this.#delegate.read(key);
    return record !== null && key.collection === this.#collection
      ? this.#mutate(record)
      : record;
  }

  list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    return this.#delegate.list(request);
  }

  transact(
    request: StorageTransactionRequest,
  ): Promise<StorageTransactionResult> {
    return this.#delegate.transact(request);
  }
}

class TransactionResultTamperingAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #collection: string;
  readonly #tamper: (result: StorageTransactionResult) => unknown;
  #tampered = false;

  constructor(
    delegate: StorageAdapter,
    collection: string,
    tamper: (result: StorageTransactionResult) => unknown,
  ) {
    this.#delegate = delegate;
    this.#collection = collection;
    this.#tamper = tamper;
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
    const result = await this.#delegate.transact(request);
    if (
      !this.#tampered &&
      request.mutations.some(
        (mutation) => mutation.key.collection === this.#collection,
      )
    ) {
      this.#tampered = true;
      return this.#tamper(result) as StorageTransactionResult;
    }
    return result;
  }
}

class SequencedAcceptanceBindingRepository
  extends InMemoryPackageVersionRepository
{
  readonly #bindings: readonly CurrentPackageAcceptanceBinding[];
  bindingReads = 0;

  constructor(
    storage: StorageAdapter,
    bindings: readonly CurrentPackageAcceptanceBinding[],
  ) {
    super(storage);
    assert.ok(bindings.length > 0);
    this.#bindings = bindings;
  }

  override async currentAcceptanceBinding(): Promise<
    CurrentPackageAcceptanceBinding | null
  > {
    const binding = this.#bindings[
      Math.min(this.bindingReads, this.#bindings.length - 1)
    ];
    this.bindingReads += 1;
    assert(binding);
    return binding;
  }
}

function parseCursor(cursor: StorageCursor): number {
  const match = /^cursor:(\d+)$/.exec(cursor);
  if (!match) throw new StorageFailure("INVALID_REQUEST");
  return Number.parseInt(match[1], 10);
}

function cloneResult(
  result: StorageTransactionResult,
  replayed: boolean,
): StorageTransactionResult {
  return Object.freeze({
    replayed,
    records: Object.freeze(
      result.records.map((record) => cloneRecord(record)),
    ),
  });
}

function cloneRecord(record: StorageRecord | null): StorageRecord | null {
  return record === null
    ? null
    : freezeRecord({
        key: record.key,
        revision: record.revision,
        value: record.value,
      });
}

function freezeRecord(input: {
  key: StorageKey;
  revision: number;
  value: StorageDocument;
}): StorageRecord {
  return Object.freeze({
    key: Object.freeze({ ...input.key }),
    revision: input.revision,
    value: deepFreeze(cloneJson(input.value)),
  });
}

function cloneJson(value: StorageDocument): StorageDocument {
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
