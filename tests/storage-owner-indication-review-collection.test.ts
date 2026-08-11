import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseAmountAggregateConfiguration,
  type AmountConfiguration,
} from "../domain/amount-aggregate-configuration.ts";
import { parseActorSubject, type ActorSubject } from "../domain/foundation.ts";
import type {
  InvestmentIndicationFields,
  InvestmentIndicationId,
  TrustedPackageAcknowledgmentContext,
} from "../domain/investment-indication.ts";
import {
  createPackageAcceptance,
  createPackageVersion,
  type PackageVersion,
} from "../domain/package-content.ts";
import {
  StorageFailure,
  storageKeyString,
  type StorageAdapter,
  type StorageCursor,
  type StorageDocument,
  type StoragePage,
  type StorageRecord,
  type StorageTransactionRequest,
  type StorageTransactionResult,
} from "../domain/storage-adapter.ts";
import {
  AeadOwnerIndicationReviewTokenBoundary,
  OwnerIndicationReviewTokenFailure,
  type OwnerIndicationReviewTokenBoundary,
} from "../services/owner-indication-review-tokens.ts";
import {
  DevelopmentInMemoryIndicationRepository,
  MAX_INDICATION_FIELDS_CHUNKS,
  MAX_OWNER_INDICATION_REVIEW_CURSOR_LENGTH,
  MAX_OWNER_INDICATION_REVIEW_ITEM_READS,
  MAX_OWNER_INDICATION_REVIEW_PAGE_RECORD_READS,
  MAX_OWNER_INDICATION_REVIEW_PAGE_SIZE,
  StorageOwnerIndicationReviewCollectionRepository,
} from "../repositories/in-memory-indication-repository.ts";
import { AittaDBStorageAdapter } from "../repositories/aittadb-storage-adapter.ts";
import {
  MemoryStorageAdapter,
  MemoryStorageState,
} from "./support/memory-storage-adapter.ts";
import { SyntheticAittaDBStorageService } from "./support/synthetic-aittadb-storage-service.ts";

const OWNER = subject("issuer.invalid/subject:configured-review-owner");
const NON_OWNER = subject("issuer.invalid/subject:non-owner-reviewer");
const ALICE = subject("issuer.invalid/subject:review-alice");
const BOB = subject("issuer.invalid/subject:review-bob");
const PRIVATE_NOTE = "Private indication note must stay out of review summaries.";
const PRIVATE_COMPANY_IDENTIFIER = "PRIVATE-REGISTRATION-102";
const AMOUNT = amountConfiguration();
const STORAGE_ISSUER = "https://storage.review.example.test";
const STORAGE_TRANSPORT_ORIGIN = "https://storage-runtime.review.example.test";
const STORAGE_ENTRY_HREF = `${STORAGE_ISSUER}/bounded-storage`;
const STORAGE_ACCESS_TOKEN = "private-owner-review-storage-token";
const TOKEN_KEY_SEED = 102;
const DEFAULT_TOKENS = tokenBoundary(
  await tokenEncryptionKey(TOKEN_KEY_SEED),
);

test("owner indication reviews page opaque bounded summaries across restart", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const alice = await seedIndication(storage, ALICE, "alice", personalFields());
  const bob = await seedIndication(storage, BOB, "bob", companyFields());
  downgradeCurrentIndicationsToSchema4(state, [alice.id, bob.id]);
  const operationCount = state.operations.size;
  const observed = new ObservedStorageAdapter(storage);

  const firstRepository = ownerRepository(observed, OWNER);
  const first = await firstRepository.list({ limit: 1 });
  assert.equal(first.items.length, 1);
  assert.notEqual(first.nextCursor, null);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.items), true);
  assert.equal(Object.isFrozen(first.items[0]), true);
  assert.deepEqual(Object.keys(first.items[0] ?? {}), [
    "reviewId",
    "kind",
    "status",
    "amount",
    "currency",
    "updatedAt",
    "revision",
  ]);
  assert.match(
    first.items[0]?.reviewId ?? "",
    /^oiri\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u,
  );
  assertOpaque(first, first.nextCursor, [alice.id, bob.id]);
  assert.equal(observed.listCalls, 1);
  assert.ok(observed.readCalls <= MAX_OWNER_INDICATION_REVIEW_ITEM_READS);
  assert.equal(observed.transactCalls, 0);

  observed.reset();
  const restarted = ownerRepository(observed, OWNER);
  const second = await restarted.list({
    limit: 1,
    cursor: requiredCursor(first.nextCursor),
  });
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assertOpaque(second, second.nextCursor, [alice.id, bob.id]);
  assert.equal(observed.listCalls, 1);
  assert.ok(observed.readCalls <= MAX_OWNER_INDICATION_REVIEW_ITEM_READS);
  assert.equal(observed.transactCalls, 0);
  assert.equal(state.operations.size, operationCount);

  observed.reset();
  const all = await restarted.list({ limit: 2 });
  assert.deepEqual(
    new Set(all.items.map((item) => item.kind)),
    new Set(["personal", "company"]),
  );
  assert.deepEqual(
    new Set(all.items.map((item) => item.amount)),
    new Set([1_250, 2_000]),
  );
  assert.equal(
    new Set([...first.items, ...second.items].map((item) => item.reviewId)).size,
    2,
  );
  assert.ok(observed.readCalls <= MAX_OWNER_INDICATION_REVIEW_PAGE_RECORD_READS);
  assert.equal(observed.transactCalls, 0);
  for (const item of all.items) {
    const href = new URL(
      `/owner/investment-indications/${encodeURIComponent(item.reviewId)}`,
      "https://investor-app.invalid",
    ).href;
    assertPrivateValuesAbsent(href, [alice.id, bob.id]);
  }
});

test("owner indication review continues an AittaDB cursor through a fresh adapter", async () => {
  const service = syntheticStorageService();
  const firstAdapter = aittadbStorageAdapter(service);
  const alice = await seedIndication(
    firstAdapter,
    ALICE,
    "aittadb-alice",
    personalFields(),
  );
  const bob = await seedIndication(
    firstAdapter,
    BOB,
    "aittadb-bob",
    companyFields(),
  );
  const operationCount = service.operationCount();
  const transactionRequests = service.transactionRequests;

  const first = await ownerRepository(firstAdapter, OWNER).list({ limit: 1 });
  assert.equal(first.items.length, 1);
  assert.notEqual(first.nextCursor, null);
  assertOpaque(first, first.nextCursor, [alice.id, bob.id]);

  const restartedAdapter = aittadbStorageAdapter(service);
  const second = await ownerRepository(restartedAdapter, OWNER).list({
    limit: 1,
    cursor: requiredCursor(first.nextCursor),
  });
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assert.notEqual(second.items[0]?.reviewId, first.items[0]?.reviewId);
  assertOpaque(second, second.nextCursor, [alice.id, bob.id]);
  assert.equal(service.operationCount(), operationCount);
  assert.equal(service.transactionRequests, transactionRequests);
  for (const readKey of service.readKeys) {
    assertPrivateValuesAbsent(readKey, [alice.id, bob.id]);
  }
});

test("owner review cursors authenticate private backend continuation across restart", async () => {
  const state = new MemoryStorageState();
  const delegate = new MemoryStorageAdapter(state);
  const alice = await seedIndication(
    delegate,
    ALICE,
    "private-cursor-alice",
    personalFields(),
  );
  const bob = await seedIndication(
    delegate,
    BOB,
    "private-cursor-bob",
    companyFields(),
  );
  const current = [...state.records.values()]
    .filter((record) => record.key.collection === "investment-indications")
    .sort((left, right) => left.key.id.localeCompare(right.key.id));
  assert.equal(current.length, 2);
  const privateBackendCursor = [
    "backend-private",
    PRIVATE_COMPANY_IDENTIFIER,
    ALICE,
    PRIVATE_NOTE,
  ].join(":") as StorageCursor;
  const storageRequests: StorageCursor[] = [];
  const privateCursorStorage: Pick<StorageAdapter, "list" | "read"> = {
    read: (key) => delegate.read(key),
    async list(request): Promise<StoragePage> {
      if (request.cursor === undefined) {
        return Object.freeze({
          items: Object.freeze([current[0] as StorageRecord]),
          nextCursor: privateBackendCursor,
        });
      }
      storageRequests.push(request.cursor);
      assert.equal(request.cursor, privateBackendCursor);
      return Object.freeze({
        items: Object.freeze([current[1] as StorageRecord]),
        nextCursor: null,
      });
    },
  };

  const firstTokens = tokenBoundary(await tokenEncryptionKey(TOKEN_KEY_SEED));
  const first = await ownerRepository(
    privateCursorStorage,
    OWNER,
    firstTokens,
  ).list({ limit: 1 });
  const publicCursor = requiredCursor(first.nextCursor);
  assert.match(publicCursor, /^oirc\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assertPrivateValuesAbsent(publicCursor, [alice.id, bob.id]);
  assert.equal(publicCursor.includes(privateBackendCursor), false);
  assert.equal(
    decodeURIComponent(
      `/owner/investment-indications?cursor=${encodeURIComponent(publicCursor)}`,
    ).includes(privateBackendCursor),
    false,
  );

  const restartedTokens = tokenBoundary(
    await tokenEncryptionKey(TOKEN_KEY_SEED),
  );
  const second = await ownerRepository(
    privateCursorStorage,
    OWNER,
    restartedTokens,
  ).list({ limit: 1, cursor: publicCursor });
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(storageRequests, [privateBackendCursor]);

  const observed = new ObservedStorageAdapter(delegate);
  const tampered = tamperToken(publicCursor) as StorageCursor;
  for (const cursor of [
    privateBackendCursor,
    tampered,
  ]) {
    await rejectsStorage(
      () => ownerRepository(observed, OWNER, restartedTokens).list({
        limit: 1,
        cursor,
      }),
      "INVALID_REQUEST",
    );
  }
  await rejectsStorage(
    () => ownerRepository(observed, OWNER, restartedTokens).list({
      limit: 2,
      cursor: publicCursor,
    }),
    "INVALID_REQUEST",
  );
  await rejectsStorage(
    () => new StorageOwnerIndicationReviewCollectionRepository(
      observed,
      NON_OWNER,
      NON_OWNER,
      restartedTokens,
    ).list({ limit: 1, cursor: publicCursor }),
    "INVALID_REQUEST",
  );
  assert.equal(observed.listCalls, 0);
  assert.equal(observed.readCalls, 0);
});

test("review IDs resolve one current key across restart and reject crossing", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const alice = await seedIndication(
    storage,
    ALICE,
    "resolvable-alice",
    personalFields(),
  );
  const bob = await seedIndication(
    storage,
    BOB,
    "resolvable-bob",
    companyFields(),
  );
  const page = await ownerRepository(storage, OWNER).list({ limit: 2 });
  const currentKeys = new Set(
    [...state.records.values()]
      .filter((record) => record.key.collection === "investment-indications")
      .map((record) => storageKeyString(record.key)),
  );
  const restartedTokens = tokenBoundary(
    await tokenEncryptionKey(TOKEN_KEY_SEED),
  );
  const observed = new ObservedStorageAdapter(storage);

  for (const item of page.items) {
    const currentKey = await restartedTokens.currentKeyForReviewId(
      item.reviewId,
      OWNER,
    );
    assert.equal(currentKeys.has(storageKeyString(currentKey)), true);
    assert.equal(
      await restartedTokens.reviewIdForCurrentKey(currentKey, OWNER),
      item.reviewId,
    );
    assert.equal(item.reviewId.includes(currentKey.id), false);
    const readsBefore = observed.readCalls;
    assert.notEqual(await observed.read(currentKey), null);
    assert.equal(observed.readCalls - readsBefore, 1);
    assertPrivateValuesAbsent(item.reviewId, [alice.id, bob.id]);
  }

  const firstReviewId = page.items[0]?.reviewId ?? "";
  const foreignOwnerId = await restartedTokens.reviewIdForCurrentKey(
    await restartedTokens.currentKeyForReviewId(firstReviewId, OWNER),
    NON_OWNER,
  );
  assert.notEqual(foreignOwnerId, firstReviewId);
  for (const operation of [
    () => restartedTokens.currentKeyForReviewId(
      tamperToken(firstReviewId),
      OWNER,
    ),
    () => restartedTokens.currentKeyForReviewId(firstReviewId, NON_OWNER),
    () => restartedTokens.currentKeyForReviewId(foreignOwnerId, OWNER),
  ]) {
    await rejectsToken(operation, "INVALID_TOKEN");
  }

  const cursorPage = await ownerRepository(storage, OWNER).list({ limit: 1 });
  const cursor = requiredCursor(cursorPage.nextCursor);
  await rejectsToken(
    () => restartedTokens.currentKeyForReviewId(cursor, OWNER),
    "INVALID_TOKEN",
  );
  await rejectsToken(
    () => restartedTokens.openCursor(firstReviewId, OWNER, 1),
    "INVALID_TOKEN",
  );
  assert.equal(observed.listCalls, 0);
});

test("anonymous and non-owner indication review bindings stop before storage", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await seedIndication(storage, ALICE, "authorization", companyFields());
  const observed = new ObservedStorageAdapter(storage);

  for (const actor of [null, NON_OWNER]) {
    const repository = ownerRepository(observed, actor);
    const error = await captureStorageFailure(() =>
      repository.list({
        limit: 1,
        cursor: PRIVATE_COMPANY_IDENTIFIER as StorageCursor,
        participantSubject: ALICE,
      } as never)
    );
    assert.equal(error.code, "NOT_FOUND");
    assert.equal(error.cause, undefined);
    assertPrivateValuesAbsent(String(error), []);
    assert.equal(observed.listCalls, 0);
    assert.equal(observed.readCalls, 0);
    assert.equal(observed.transactCalls, 0);
  }
});

test("owner indication reviews reject malformed cursors and oversized pages", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  await seedIndication(storage, ALICE, "malformed", personalFields());
  const observed = new ObservedStorageAdapter(storage);
  const repository = ownerRepository(observed, OWNER);

  const invalidRequests: readonly unknown[] = [
    null,
    {},
    { limit: 0 },
    { limit: 1.5 },
    { limit: MAX_OWNER_INDICATION_REVIEW_PAGE_SIZE + 1 },
    { limit: 1, cursor: "" },
    { limit: 1, cursor: "line\nbreak" },
    {
      limit: 1,
      cursor: "x".repeat(MAX_OWNER_INDICATION_REVIEW_CURSOR_LENGTH + 1),
    },
    { limit: 1, participantSubject: ALICE },
    Object.defineProperty({ limit: 1 }, "cursor", {
      enumerable: true,
      get: () => "private-cursor",
    }),
  ];
  for (const request of invalidRequests) {
    await rejectsStorage(
      () => repository.list(request as never),
      "INVALID_REQUEST",
    );
  }
  assert.equal(observed.listCalls, 0);
  assert.equal(observed.readCalls, 0);

  const current = requiredRecordIn(state, "investment-indications");
  const malformedPages: readonly unknown[] = [
    null,
    {},
    { items: [current], nextCursor: null, private: PRIVATE_NOTE },
    { items: [current, current], nextCursor: null },
    { items: [], nextCursor: "cursor:1" },
    { items: [current], nextCursor: "" },
    { items: [current], nextCursor: "line\nbreak" },
    {
      items: [current],
      nextCursor: "x".repeat(MAX_OWNER_INDICATION_REVIEW_CURSOR_LENGTH + 1),
    },
    Object.defineProperty({ nextCursor: null }, "items", {
      enumerable: true,
      get: () => [current],
    }),
  ];
  for (const page of malformedPages) {
    await rejectsStorage(
      () => ownerRepository(pageStorage(storage, page), OWNER).list({ limit: 1 }),
      "UNAVAILABLE",
    );
  }

  const corruptPrivateBackendCursor = `${PRIVATE_COMPANY_IDENTIFIER}:${ALICE}:${
    "x".repeat(2_048)
  }`;
  const corruptCursorError = await captureStorageFailure(() =>
    ownerRepository(pageStorage(storage, {
      items: [current],
      nextCursor: corruptPrivateBackendCursor,
    }), OWNER).list({ limit: 1 })
  );
  assert.equal(corruptCursorError.code, "UNAVAILABLE");
  assert.equal(corruptCursorError.cause, undefined);
  assertPrivateValuesAbsent(String(corruptCursorError), []);

  await rejectsStorage(
    async () => {
      const cursor = await DEFAULT_TOKENS.sealCursor(
        "cursor:1" as StorageCursor,
        OWNER,
        1,
      );
      return ownerRepository(pageStorage(storage, {
        items: [current],
        nextCursor: "cursor:1",
      }), OWNER).list({ limit: 1, cursor });
    },
    "UNAVAILABLE",
  );

  const privateCause = [ALICE, PRIVATE_COMPANY_IDENTIFIER, PRIVATE_NOTE].join(" ");
  const failed = ownerRepository({
    read: (key) => storage.read(key),
    async list() {
      throw new StorageFailure("UNAVAILABLE", {
        cause: new Error(privateCause),
      });
    },
  }, OWNER);
  const error = await captureStorageFailure(() => failed.list({ limit: 1 }));
  assert.equal(error.code, "UNAVAILABLE");
  assert.equal(error.cause, undefined);
  assertPrivateValuesAbsent(String(error), []);
});

test("owner indication review corruption fails within the item read ceiling", async () => {
  const baseline = new MemoryStorageState();
  await seedIndication(
    new MemoryStorageAdapter(baseline),
    ALICE,
    "corruption",
    companyFields(),
  );

  const corruptions: readonly Readonly<{
    name: string;
    apply(state: MemoryStorageState): void;
  }>[] = [
    {
      name: "current subject drift",
      apply: (state) => mutateFirstRecord(
        state,
        "investment-indications",
        (value) => {
          value.participantSubject = BOB;
        },
      ),
    },
    {
      name: "current operation drift",
      apply: (state) => mutateFirstRecord(
        state,
        "investment-indications",
        (value) => {
          value.operationFingerprint = `sha256:${"0".repeat(64)}`;
        },
      ),
    },
    {
      name: "missing terminal transition",
      apply: (state) => deleteFirstRecord(state, "investment-indication-history"),
    },
    {
      name: "terminal timestamp drift",
      apply: (state) => mutateFirstRecord(
        state,
        "investment-indication-history",
        (value) => {
          value.occurredAt = "2026-08-10T10:30:00.000Z";
        },
      ),
    },
    {
      name: "terminal actor subject drift",
      apply: (state) => mutateFirstRecord(
        state,
        "investment-indication-history",
        (value) => {
          const actor = value.actor as Record<string, unknown>;
          actor.subject = BOB;
        },
      ),
    },
    {
      name: "missing current field chunk",
      apply: (state) => deleteFirstRecord(state, "investment-indication-fields"),
    },
    {
      name: "changed current field payload",
      apply: (state) => mutateFirstRecord(
        state,
        "investment-indication-fields",
        (value) => {
          const data = String(value.data);
          value.data = `${data.startsWith("A") ? "B" : "A"}${data.slice(1)}`;
        },
      ),
    },
    {
      name: "missing active uniqueness lease",
      apply: (state) => deleteFirstRecord(
        state,
        "investment-indication-active-keys",
      ),
    },
  ];

  for (const corruption of corruptions) {
    const state = cloneState(baseline);
    corruption.apply(state);
    const observed = new ObservedStorageAdapter(new MemoryStorageAdapter(state));
    const error = await captureStorageFailure(() =>
      ownerRepository(observed, OWNER).list({ limit: 1 })
    );
    assert.equal(error.code, "UNAVAILABLE", corruption.name);
    assert.equal(error.cause, undefined, corruption.name);
    assert.equal(observed.listCalls, 1, corruption.name);
    assert.ok(
      observed.readCalls <= MAX_OWNER_INDICATION_REVIEW_ITEM_READS,
      corruption.name,
    );
    assert.equal(observed.transactCalls, 0, corruption.name);
  }
});

test("owner indication review derives active withdrawn and rejected lifecycle", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  const alice = await seedIndication(storage, ALICE, "withdrawn", personalFields());
  const bob = await seedIndication(storage, BOB, "rejected", companyFields());
  const charlie = subject("issuer.invalid/subject:review-charlie");
  await seedIndication(storage, charlie, "active", personalFields({ amount: 1_500 }));

  await alice.repository.withdraw({
    operationId: "indication-operation:withdrawn-withdraw",
    id: alice.id,
    expectedRevision: 1,
    occurredAt: "2026-08-10T11:00:00.000Z",
    historyEntryId: "indication-history:withdrawn-withdraw",
  });
  await new DevelopmentInMemoryIndicationRepository(
    storage,
    OWNER,
    OWNER,
    AMOUNT,
  ).reject({
    operationId: "indication-operation:rejected-reject",
    id: bob.id,
    expectedRevision: 1,
    occurredAt: "2026-08-10T12:00:00.000Z",
    historyEntryId: "indication-history:rejected-reject",
    reason: "Private participant-visible rejection reason.",
  });

  const page = await ownerRepository(storage, OWNER).list({ limit: 3 });
  assert.deepEqual(
    new Set(page.items.map((item) => item.status)),
    new Set(["active", "withdrawn", "rejected"]),
  );
  assert.doesNotMatch(JSON.stringify(page), /rejection reason/u);
  const withdrawn = page.items.find((item) => item.status === "withdrawn");
  const rejected = page.items.find((item) => item.status === "rejected");
  assert.equal(withdrawn?.revision, 2);
  assert.equal(withdrawn?.updatedAt, "2026-08-10T11:00:00.000Z");
  assert.equal(rejected?.revision, 2);
  assert.equal(rejected?.updatedAt, "2026-08-10T12:00:00.000Z");
});

test("maximum owner indication review page has a finite observed read budget", async () => {
  const state = new MemoryStorageState();
  const storage = new MemoryStorageAdapter(state);
  for (let index = 0; index < MAX_OWNER_INDICATION_REVIEW_PAGE_SIZE; index += 1) {
    await seedIndication(
      storage,
      subject(`issuer.invalid/subject:bounded-review-${index}`),
      `bounded-${index}`,
      personalFields({ amount: 1_000 + index * 250 }),
    );
  }
  const operationCount = state.operations.size;
  const observed = new ObservedStorageAdapter(storage);
  const page = await ownerRepository(observed, OWNER).list({
    limit: MAX_OWNER_INDICATION_REVIEW_PAGE_SIZE,
  });
  assert.equal(page.items.length, MAX_OWNER_INDICATION_REVIEW_PAGE_SIZE);
  assert.equal(page.nextCursor, null);
  assert.equal(observed.listCalls, 1);
  assert.ok(observed.readCalls <= MAX_OWNER_INDICATION_REVIEW_PAGE_RECORD_READS);
  assert.ok(
    observed.readCalls <=
      MAX_OWNER_INDICATION_REVIEW_PAGE_SIZE *
        (2 + MAX_INDICATION_FIELDS_CHUNKS),
  );
  assert.equal(observed.transactCalls, 0);
  assert.equal(state.operations.size, operationCount);
});

test("owner indication review collection implementation has no logging surface", async () => {
  const sources = await Promise.all([
    "../repositories/in-memory-indication-repository.ts",
    "../services/owner-indication-review-tokens.ts",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  for (const source of sources) {
    assert.doesNotMatch(source, /console\s*\.|logger\s*\./u);
  }
});

function ownerRepository(
  storage: Pick<StorageAdapter, "list" | "read">,
  authenticatedSubject: ActorSubject | null,
  tokens: OwnerIndicationReviewTokenBoundary = DEFAULT_TOKENS,
): StorageOwnerIndicationReviewCollectionRepository {
  return new StorageOwnerIndicationReviewCollectionRepository(
    storage,
    authenticatedSubject,
    OWNER,
    tokens,
  );
}

function downgradeCurrentIndicationsToSchema4(
  state: MemoryStorageState,
  ids: readonly InvestmentIndicationId[],
): void {
  const selected = new Set(ids);
  let changed = 0;
  for (const [identity, record] of state.records) {
    if (
      record.key.collection !== "investment-indications" ||
      !selected.has(record.value.indicationId as InvestmentIndicationId)
    ) continue;
    assert.equal(record.value.schemaVersion, 5);
    const value = { ...record.value, schemaVersion: 4 };
    Reflect.deleteProperty(value, "participantSummary");
    state.records.set(identity, Object.freeze({
      key: record.key,
      revision: record.revision,
      value: Object.freeze(value),
    }));
    changed += 1;
  }
  assert.equal(changed, selected.size);
}

function tokenBoundary(
  encryptionKey: CryptoKey,
): AeadOwnerIndicationReviewTokenBoundary {
  return new AeadOwnerIndicationReviewTokenBoundary({
    encryptionKey,
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
  });
}

async function tokenEncryptionKey(seed: number): Promise<CryptoKey> {
  const bytes = Uint8Array.from(
    { length: 32 },
    (_, index) => (seed + index * 17) % 256,
  );
  return crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function tamperToken(value: string): string {
  assert.notEqual(value.length, 0);
  const replacement = value.endsWith("A") ? "B" : "A";
  return `${value.slice(0, -1)}${replacement}`;
}

function syntheticStorageService(): SyntheticAittaDBStorageService {
  return new SyntheticAittaDBStorageService({
    issuer: STORAGE_ISSUER,
    transportOrigin: STORAGE_TRANSPORT_ORIGIN,
    entryHref: STORAGE_ENTRY_HREF,
    clientId: "owner-review-client",
    clientSecret: "private-owner-review-client-secret",
    accessToken: STORAGE_ACCESS_TOKEN,
    scopes: "storage.read storage.write storage.delete",
  });
}

function aittadbStorageAdapter(
  service: SyntheticAittaDBStorageService,
): AittaDBStorageAdapter {
  return new AittaDBStorageAdapter({
    issuer: STORAGE_ISSUER,
    transportOrigin: STORAGE_TRANSPORT_ORIGIN,
    entryHref: STORAGE_ENTRY_HREF,
    accessToken: () => STORAGE_ACCESS_TOKEN,
    fetch: service.fetch,
  });
}

async function seedIndication(
  storage: StorageAdapter,
  participantSubject: ActorSubject,
  suffix: string,
  fields: InvestmentIndicationFields,
): Promise<Readonly<{
  id: InvestmentIndicationId;
  repository: DevelopmentInMemoryIndicationRepository;
  context: TrustedPackageAcknowledgmentContext;
}>> {
  const id = `indication:${suffix}` as InvestmentIndicationId;
  const repository = new DevelopmentInMemoryIndicationRepository(
    storage,
    participantSubject,
    OWNER,
    AMOUNT,
  );
  const context = await currentContext(participantSubject, suffix);
  const created = await repository.create({
    operationId: `indication-operation:${suffix}-create`,
    expectedRevision: null,
    id,
    occurredAt: "2026-08-10T10:00:00.000Z",
    historyEntryId: `indication-history:${suffix}-create`,
    fields,
  }, context);
  assert.equal(created.revision, 1);
  return Object.freeze({ id, repository, context });
}

async function currentContext(
  participantSubject: ActorSubject,
  suffix: string,
): Promise<TrustedPackageAcknowledgmentContext> {
  const version = await packageVersion(suffix);
  const accepted = createPackageAcceptance({
    id: `package-acceptance:${suffix}`,
    participantSubject,
    acceptedAt: "2026-08-10T09:00:00.000Z",
  }, version);
  if (!accepted.ok) assert.fail(JSON.stringify(accepted.issues));
  return Object.freeze({
    currentVersion: version,
    latestAcceptance: accepted.value,
  });
}

async function packageVersion(suffix: string): Promise<PackageVersion> {
  const parsed = await createPackageVersion({
    id: `package-version:${suffix}`,
    createdAt: "2026-08-10T08:00:00.000Z",
    changeSummary: "Synthetic indication review package",
    materialChange: false,
    acknowledgmentText: "This indication remains non-binding.",
    sections: [{
      id: `package-section:${suffix}`,
      order: 0,
      title: "Overview",
      markdown: "Synthetic package content.",
      enabled: true,
    }],
  }, null);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

function personalFields(
  overrides: Readonly<Record<string, unknown>> = {},
): InvestmentIndicationFields {
  return {
    kind: "personal",
    residenceCountry: "FI",
    amount: 1_250,
    availabilityPeriod: "Within twelve months.",
    note: PRIVATE_NOTE,
    ...overrides,
  } as InvestmentIndicationFields;
}

function companyFields(): InvestmentIndicationFields {
  return {
    kind: "company",
    companyName: "Private review company",
    registrationCountry: "FI",
    companyIdentifier: PRIVATE_COMPANY_IDENTIFIER,
    representativeName: "Private representative",
    representativeAuthorityDeclared: true,
    amount: 2_000,
    availabilityPeriod: "Within twelve months.",
    note: PRIVATE_NOTE,
  } as InvestmentIndicationFields;
}

function amountConfiguration(): AmountConfiguration {
  const parsed = parseAmountAggregateConfiguration({
    amount: {
      currency: "eur",
      minimum: 1_000,
      increment: 250,
      maximum: 10_000,
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

function requiredCursor(value: StorageCursor | null): StorageCursor {
  assert(value);
  return value;
}

function assertOpaque(
  value: unknown,
  cursor: StorageCursor | null,
  indicationIds: readonly InvestmentIndicationId[],
): void {
  const serialized = JSON.stringify(value);
  assertPrivateValuesAbsent(serialized, indicationIds);
  if (cursor !== null) assertPrivateValuesAbsent(cursor, indicationIds);
}

function assertPrivateValuesAbsent(
  value: string,
  indicationIds: readonly InvestmentIndicationId[],
): void {
  for (const privateValue of [
    OWNER,
    NON_OWNER,
    ALICE,
    BOB,
    PRIVATE_COMPANY_IDENTIFIER,
    PRIVATE_NOTE,
    ...indicationIds,
  ]) {
    assert.equal(value.includes(privateValue), false, privateValue);
  }
}

function pageStorage(
  delegate: StorageAdapter,
  page: unknown,
): Pick<StorageAdapter, "list" | "read"> {
  return {
    read: (key) => delegate.read(key),
    async list(): Promise<StoragePage> {
      return page as StoragePage;
    },
  };
}

class ObservedStorageAdapter implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  listCalls = 0;
  readCalls = 0;
  transactCalls = 0;

  constructor(delegate: StorageAdapter) {
    this.#delegate = delegate;
  }

  reset(): void {
    this.listCalls = 0;
    this.readCalls = 0;
    this.transactCalls = 0;
  }

  read(key: Parameters<StorageAdapter["read"]>[0]): Promise<StorageRecord | null> {
    this.readCalls += 1;
    return this.#delegate.read(key);
  }

  list(request: Parameters<StorageAdapter["list"]>[0]): Promise<StoragePage> {
    this.listCalls += 1;
    return this.#delegate.list(request);
  }

  transact(request: StorageTransactionRequest): Promise<StorageTransactionResult> {
    this.transactCalls += 1;
    return this.#delegate.transact(request);
  }
}

function requiredRecordIn(
  state: MemoryStorageState,
  collection: string,
): StorageRecord {
  const record = [...state.records.values()].find(
    (candidate) => candidate.key.collection === collection,
  );
  assert(record);
  return record;
}

function mutateFirstRecord(
  state: MemoryStorageState,
  collection: string,
  mutate: (value: Record<string, unknown>) => void,
): void {
  const record = requiredRecordIn(state, collection);
  const value = structuredClone(record.value) as Record<string, unknown>;
  mutate(value);
  state.records.set(storageKeyString(record.key), Object.freeze({
    key: record.key,
    revision: record.revision,
    value: value as StorageDocument,
  }));
}

function deleteFirstRecord(state: MemoryStorageState, collection: string): void {
  const record = requiredRecordIn(state, collection);
  state.records.delete(storageKeyString(record.key));
}

function cloneState(source: MemoryStorageState): MemoryStorageState {
  const state = new MemoryStorageState();
  for (const [key, record] of source.records) {
    state.records.set(key, structuredClone(record));
  }
  return state;
}

async function rejectsStorage(
  operation: () => Promise<unknown>,
  code: StorageFailure["code"],
): Promise<void> {
  const error = await captureStorageFailure(operation);
  assert.equal(error.code, code);
  assert.equal(error.cause, undefined);
}

async function rejectsToken(
  operation: () => Promise<unknown>,
  code: OwnerIndicationReviewTokenFailure["code"],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof OwnerIndicationReviewTokenFailure);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    return;
  }
  assert.fail("Expected OwnerIndicationReviewTokenFailure.");
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
