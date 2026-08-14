import assert from "node:assert/strict";
import test from "node:test";

import {
  createFounderApplication,
  editFounderApplication,
  parseContributionAreaChoices,
  withdrawFounderApplication,
  type ContributionAreaChoice,
  type IndependentParticipationRecords,
} from "../domain/founder-application.ts";
import type { ValidationResult } from "../domain/foundation.ts";

function valueOf<Value>(result: ValidationResult<Value>): Value {
  if (!result.ok) {
    throw new Error(`Expected valid result: ${JSON.stringify(result.issues)}`);
  }

  return result.value;
}

const contributionAreaChoices: readonly ContributionAreaChoice[] = valueOf(
  parseContributionAreaChoices([
    { id: "area:product", label: "Product" },
    { id: "area:engineering", label: "Engineering" },
    { id: "area:operations", label: "Operations" },
  ]),
);

const applicantSubject = "issuer.invalid/subject:candidate";

function fields(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    expertiseSummary: "Experience developing data systems.",
    intendedContribution: "Contribute to product development and validation.",
    primaryContributionAreaId: "area:engineering",
    secondaryContributionAreaIds: ["area:product"],
    approximateAvailability: "Part-time during the initial phase.",
    possibleStartTiming: "After mutual confirmation.",
    compensationExpectation: "Open to discussion.",
    professionalProfileLinks: ["https://profiles.invalid/candidate"],
    note: "Synthetic application fixture.",
    ...overrides,
  };
}

function createInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "founder-application:sample",
    applicantSubject,
    occurredAt: "2026-08-09T10:00:00.000Z",
    historyEntryId: "founder-history:create",
    fields: fields(),
    ...overrides,
  };
}

test("contribution choices are deployment-supplied, unique, and immutable", () => {
  assert.equal(Object.isFrozen(contributionAreaChoices), true);
  assert.equal(Object.isFrozen(contributionAreaChoices[0]), true);

  assert.deepEqual(
    parseContributionAreaChoices([
      { id: "area:duplicate", label: "First label" },
      { id: "area:duplicate", label: "Second label" },
    ]),
    {
      ok: false,
      issues: [
        {
          code: "invalid_rule",
          path: "contributionAreaChoices[1].id",
        },
      ],
    },
  );
});

test("create validates fields and records an immutable received snapshot", () => {
  const application = valueOf(
    createFounderApplication(createInput(), contributionAreaChoices),
  );

  assert.equal(application.status, "received");
  assert.equal(application.revision, 1);
  assert.equal(application.applicantSubject, applicantSubject);
  assert.equal(application.withdrawnAt, null);
  assert.equal(application.history.length, 1);
  assert.deepEqual(
    {
      kind: application.history[0]?.kind,
      status: application.history[0]?.status,
      revision: application.history[0]?.revision,
    },
    { kind: "created", status: "received", revision: 1 },
  );
  assert.equal(application.history[0]?.fields, application.fields);
  assert.equal(Object.isFrozen(application), true);
  assert.equal(Object.isFrozen(application.fields), true);
  assert.equal(Object.isFrozen(application.fields.secondaryContributionAreaIds), true);
  assert.equal(Object.isFrozen(application.history), true);

  assert.deepEqual(
    createFounderApplication(
      createInput({
        fields: fields({ primaryContributionAreaId: "area:not-configured" }),
      }),
      contributionAreaChoices,
    ),
    {
      ok: false,
      issues: [
        { code: "invalid_rule", path: "fields.primaryContributionAreaId" },
      ],
    },
  );

  assert.deepEqual(
    createFounderApplication(
      createInput({
        fields: fields({
          professionalProfileLinks: ["javascript:unsafe"],
        }),
      }),
      contributionAreaChoices,
    ),
    {
      ok: false,
      issues: [
        {
          code: "invalid_format",
          path: "fields.professionalProfileLinks[0]",
        },
      ],
    },
  );
});

test("edit replaces fields, appends history, and leaves prior snapshots unchanged", () => {
  const created = valueOf(
    createFounderApplication(createInput(), contributionAreaChoices),
  );
  const edited = valueOf(
    editFounderApplication(
      created,
      {
        actorSubject: applicantSubject,
        occurredAt: "2026-08-09T11:00:00.000Z",
        historyEntryId: "founder-history:edit",
        fields: fields({
          intendedContribution: "Lead a bounded product validation project.",
          secondaryContributionAreaIds: ["area:operations"],
          note: null,
        }),
      },
      contributionAreaChoices,
    ),
  );

  assert.equal(edited.status, "received");
  assert.equal(edited.revision, 2);
  assert.equal(edited.history.length, 2);
  assert.equal(edited.history[1]?.kind, "edited");
  assert.equal(
    edited.fields.intendedContribution,
    "Lead a bounded product validation project.",
  );
  assert.equal(edited.fields.note, null);
  assert.equal(created.revision, 1);
  assert.equal(
    created.fields.intendedContribution,
    "Contribute to product development and validation.",
  );
  assert.equal(edited.history[0], created.history[0]);

  assert.deepEqual(
    editFounderApplication(
      created,
      {
        actorSubject: "issuer.invalid/subject:another-candidate",
        occurredAt: "2026-08-09T11:00:00.000Z",
        historyEntryId: "founder-history:foreign-edit",
        fields: fields(),
      },
      contributionAreaChoices,
    ),
    {
      ok: false,
      issues: [{ code: "invalid_rule", path: "actorSubject" }],
    },
  );

  assert.deepEqual(
    editFounderApplication(
      created,
      {
        actorSubject: applicantSubject,
        occurredAt: "2026-08-09T09:59:59.999Z",
        historyEntryId: "founder-history:stale-edit",
        fields: fields(),
      },
      contributionAreaChoices,
    ),
    {
      ok: false,
      issues: [{ code: "out_of_range", path: "occurredAt" }],
    },
  );
});

test("withdraw preserves fields, appends history, and closes further transitions", () => {
  const created = valueOf(
    createFounderApplication(createInput(), contributionAreaChoices),
  );
  const withdrawn = valueOf(
    withdrawFounderApplication(created, {
      actorSubject: applicantSubject,
      occurredAt: "2026-08-09T12:00:00.000Z",
      historyEntryId: "founder-history:withdraw",
    }),
  );

  assert.equal(withdrawn.status, "withdrawn");
  assert.equal(withdrawn.withdrawnAt, "2026-08-09T12:00:00.000Z");
  assert.equal(withdrawn.fields, created.fields);
  assert.equal(withdrawn.revision, 2);
  assert.equal(withdrawn.history[1]?.kind, "withdrawn");
  assert.equal(withdrawn.history[1]?.status, "withdrawn");

  assert.deepEqual(
    withdrawFounderApplication(withdrawn, {
      actorSubject: applicantSubject,
      occurredAt: "2026-08-09T13:00:00.000Z",
      historyEntryId: "founder-history:withdraw-again",
    }),
    {
      ok: false,
      issues: [{ code: "invalid_rule", path: "status" }],
    },
  );

  assert.deepEqual(
    editFounderApplication(
      withdrawn,
      {
        actorSubject: applicantSubject,
        occurredAt: "2026-08-09T13:00:00.000Z",
        historyEntryId: "founder-history:edit-withdrawn",
        fields: fields(),
      },
      contributionAreaChoices,
    ),
    {
      ok: false,
      issues: [{ code: "invalid_rule", path: "status" }],
    },
  );
});

test("founder and investment records can exist and change independently", () => {
  type InvestmentRecord = Readonly<{
    id: string;
    status: "active";
  }>;

  const investmentRecords: readonly InvestmentRecord[] = Object.freeze([
    Object.freeze({ id: "investment-indication:synthetic", status: "active" }),
  ]);
  const founderApplication = valueOf(
    createFounderApplication(createInput(), contributionAreaChoices),
  );
  const both: IndependentParticipationRecords<InvestmentRecord> = Object.freeze({
    founderApplication,
    investmentRecords,
  });

  const withdrawnFounder = valueOf(
    withdrawFounderApplication(founderApplication, {
      actorSubject: applicantSubject,
      occurredAt: "2026-08-09T12:00:00.000Z",
      historyEntryId: "founder-history:independent-withdraw",
    }),
  );
  const afterFounderChange: IndependentParticipationRecords<InvestmentRecord> = {
    ...both,
    founderApplication: withdrawnFounder,
  };

  assert.equal(afterFounderChange.investmentRecords, investmentRecords);
  assert.deepEqual(afterFounderChange.investmentRecords, [
    { id: "investment-indication:synthetic", status: "active" },
  ]);

  const investorOnly: IndependentParticipationRecords<InvestmentRecord> = {
    founderApplication: null,
    investmentRecords,
  };
  const founderOnly: IndependentParticipationRecords<InvestmentRecord> = {
    founderApplication,
    investmentRecords: [],
  };

  assert.equal(investorOnly.founderApplication, null);
  assert.equal(founderOnly.investmentRecords.length, 0);
});
