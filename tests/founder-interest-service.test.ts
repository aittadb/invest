import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseContributionAreaChoices,
  type ContributionAreaChoice,
  type FounderApplicationId,
} from "../domain/founder-application.ts";
import {
  parseActorSubject,
  parseStableId,
  type ActorSubject,
} from "../domain/foundation.ts";
import { StorageFailure } from "../domain/storage-adapter.ts";
import {
  createParticipantFounderInterestService,
  type CreateFounderInterestInput,
} from "../worker/founder-interest-service.ts";
import {
  FounderApplicationRepositoryFixture,
  FounderApplicationRepositoryFixtureState,
} from "./support/founder-application-repository-fixture.ts";

const ALICE = subject("issuer.invalid/participant:alice");
const BOB = subject("issuer.invalid/participant:bob");
const APPLICATION_ID = applicationId("founder-application:self");
const CHOICES = contributionChoices([
  { id: "area:engineering", label: "Engineering" },
  { id: "area:product", label: "Product" },
]);

test("founder-interest service binds identity and recovers retry metadata from history", async () => {
  const state = new FounderApplicationRepositoryFixtureState();
  let clockCalls = 0;
  const service = createParticipantFounderInterestService({
    actorSubject: ALICE,
    applicationId: APPLICATION_ID,
    contributionAreaChoices: CHOICES,
    repository: new FounderApplicationRepositoryFixture(state, ALICE, CHOICES),
    canCreate: () => true,
    now: () => {
      clockCalls += 1;
      return new Date(
        clockCalls === 1
          ? "2026-08-09T10:00:00.000Z"
          : "2026-08-09T11:00:00.000Z",
      );
    },
  });
  const input = {
    operationId: "founder-operation:create-alice",
    fields: fields(),
    actorSubject: BOB,
    applicantSubject: BOB,
  } satisfies CreateFounderInterestInput &
    Readonly<{ actorSubject: ActorSubject; applicantSubject: ActorSubject }>;

  const created = await service.create(input);
  const replay = await service.create(input);
  assert.equal(created.snapshot.applicantSubject, ALICE);
  assert.equal(created.snapshot.revision, 1);
  assert.equal(replay.replayed, true);
  assert.equal(clockCalls, 1);
  assert.equal(state.requests.length, 2);
  assert.equal(state.requests[0]?.request.occurredAt, state.requests[1]?.request.occurredAt);
  assert.equal(
    Object.hasOwn(state.requests[0]?.request ?? {}, "applicantSubject"),
    false,
  );

  const edited = await service.edit({
    operationId: "founder-operation:edit-alice",
    expectedRevision: 1,
    fields: fields({ note: "Updated application note." }),
  });
  assert.equal(edited.snapshot.revision, 2);
  assert.equal(edited.snapshot.history.length, 2);
  assert.equal(edited.snapshot.history[0]?.fields.note, "Initial application note.");
  assert.equal(edited.snapshot.history[1]?.fields.note, "Updated application note.");
  assert.equal(Object.isFrozen(edited.snapshot.history[0]), true);
});

test("founder-interest service enforces injected creation policy before persistence", async () => {
  const state = new FounderApplicationRepositoryFixtureState();
  const service = createParticipantFounderInterestService({
    actorSubject: ALICE,
    applicationId: APPLICATION_ID,
    contributionAreaChoices: CHOICES,
    repository: new FounderApplicationRepositoryFixture(state, ALICE, CHOICES),
    canCreate: () => false,
    now: () => new Date("2026-08-09T10:00:00.000Z"),
  });

  const failure = await captureStorageFailure(() =>
    service.create({
      operationId: "founder-operation:closed",
      fields: fields(),
    })
  );
  assert.equal(failure.code, "PRECONDITION_FAILED");
  assert.equal(state.requests.length, 0);
  assert.deepEqual(await service.getState(), {
    application: null,
    contributionAreaChoices: CHOICES,
    canCreate: false,
  });
});

test("founder-interest application and route layers have no investment dependency", async () => {
  const sources = await Promise.all([
    readFile(
      new URL("../worker/founder-interest-service.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../worker/routes/founder-interest.ts", import.meta.url),
      "utf8",
    ),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(source, /investment-indication|indication-repository/u);
  }
});

function fields(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    expertiseSummary: "Experience developing data systems.",
    intendedContribution: "Contribute to product development and validation.",
    primaryContributionAreaId: "area:engineering",
    secondaryContributionAreaIds: ["area:product"],
    approximateAvailability: "Part-time during the initial phase.",
    possibleStartTiming: "After mutual confirmation.",
    compensationExpectation: "Open to discussion.",
    professionalProfileLinks: ["https://profiles.invalid/alice"],
    note: "Initial application note.",
    ...overrides,
  };
}

function subject(value: string): ActorSubject {
  const parsed = parseActorSubject(value);
  assert(parsed.ok);
  return parsed.value;
}

function applicationId(value: string): FounderApplicationId {
  const parsed = parseStableId<"founder-application">(value);
  assert(parsed.ok);
  return parsed.value;
}

function contributionChoices(value: unknown): readonly ContributionAreaChoice[] {
  const parsed = parseContributionAreaChoices(value);
  assert(parsed.ok);
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
  assert.fail("Expected a StorageFailure.");
}
