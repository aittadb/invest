import assert from "node:assert/strict";
import test from "node:test";

import { parseAmountAggregateConfiguration } from "../domain/amount-aggregate-configuration.ts";
import { parseCampaignSetupPolicy } from "../domain/campaign-setup-policy.ts";
import {
  parseAuditAppendIntent,
  type AuditAppendIntent,
  type AuditEvent,
} from "../domain/audit-notification.ts";
import {
  createFounderApplication,
  parseContributionAreaChoices,
  type FounderApplication,
} from "../domain/founder-application.ts";
import {
  parseActorSubject,
  parseMinorUnits,
  parseTimestamp,
  type ValidationResult,
} from "../domain/foundation.ts";
import {
  createInvestmentIndication,
  type InvestmentIndication,
  type ParticipantIndicationActor,
} from "../domain/investment-indication.ts";
import {
  createPackageAcceptance,
  createPackageVersion,
  type PackageVersion,
} from "../domain/package-content.ts";
import {
  parseParticipantAccount,
  registerParticipantProfile,
} from "../domain/participant-profile.ts";
import { testParticipantRegistrationNoticeEvidence } from "./support/participant-registration-notice-evidence.ts";
import { parsePhaseConfiguration } from "../domain/phase-configuration.ts";
import { INVESTOR_APP_MEDIA_TYPE } from "../domain/public-campaign-resource.ts";
import {
  parseStorageOperationId,
  type StorageCursor,
} from "../domain/storage-adapter.ts";
import {
  createBrowserMutationGuard,
  hashCsrfToken,
  MUTATION_CSRF_FIELD,
  MUTATION_CSRF_HEADER,
} from "../http/mutation-security.ts";
import type { CampaignSetupRevision } from "../repositories/in-memory-campaign-repository.ts";
import type { RevisionedSnapshot } from "../repositories/in-memory-content-repository.ts";
import type {
  AuditAppendResult,
  AuditEventPage,
  AuditListRequest,
  GuaranteedAuditAppendRepository,
} from "../repositories/in-memory-audit-notification-repositories.ts";
import type { ParticipantProfileSnapshot } from "../repositories/in-memory-participant-repository.ts";
import {
  createOwnerReviewExportService,
  encodeCsvCell,
  type OwnerReviewExportDataReader,
  type OwnerReviewExportLimits,
  type OwnerReviewExportPage,
  type OwnerReviewExportPageRequest,
} from "../services/owner-review-export.ts";
import { syntheticPublicCampaign } from "./fixtures/public-campaign.ts";
import { explicitCampaignSetup } from "./support/campaign-repository-contract.ts";
import type { ApplicationRouteContext } from "../worker/contracts.ts";
import { createOwnerReviewExportRouteHandler } from "../worker/routes/owner-review-exports.ts";
import { createOwnerRouteHandler } from "../worker/routes/owner.ts";

const INTERNAL_ORIGIN = "https://worker.internal.invalid";
const CANONICAL_ORIGIN = "https://invest-test.example";
const OWNER_SUBJECT = "issuer.invalid/subject:configured-owner";
const PRIVATE_COMPANY = "+Private, Incorporated";
const PRIVATE_NOTE = "-private review note";
const PRIVATE_EXPERTISE = "@SUM(A1:A2)\n\"Quoted expertise\"";
const EXPORTED_AT = "2026-08-09T15:00:00.000Z";
const CSRF_TOKEN = "owner_export_csrf_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const REVIEW_OPERATION = "owner-export-request:review-01";
const BACKUP_OPERATION = "owner-export-request:backup-01";

test("owner export workspace exposes canonical CSRF-protected POST actions", async () => {
  const harness = await createHarness();
  const handler = createOwnerRouteHandler([harness.route], {
    reviewExports: true,
  });

  const json = await requiredResponse(await handler(context(request(
    "/owner/exports",
    { accept: `${INVESTOR_APP_MEDIA_TYPE}; version=0.1` },
  ))));
  assert.equal(json.status, 200);
  assertPrivateHeaders(json);
  assert.equal(json.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  const document = await json.json() as {
    type: string;
    data: {
      maximum_rows: number;
      maximum_bytes: number;
      maximum_record_bytes: number;
      maximum_history_entries: number;
      receipt_semantics: string;
    };
    links: Array<{ rel: string[]; href: string }>;
    actions: Array<{
      name: string;
      method: string;
      href: string;
      type: string;
      fields: Array<{ name: string; value?: string; presentation?: string }>;
    }>;
  };
  assert.equal(document.type, "owner-review-exports");
  assert.deepEqual(document.data, {
    sensitivity: "private",
    retention: "streamed-not-retained",
    receipt_semantics: "generated-not-delivered",
    maximum_rows: 10,
    maximum_bytes: 1_000_000,
    maximum_record_bytes: 100_000,
    maximum_history_entries: 4,
  });
  assert.deepEqual(document.links, [
    { rel: ["self"], href: `${CANONICAL_ORIGIN}/owner/exports` },
    { rel: ["owner"], href: `${CANONICAL_ORIGIN}/owner` },
  ]);
  assert.deepEqual(
    document.actions.map((action) => [
      action.name,
      action.method,
      action.href,
      action.type,
      action.fields[0]?.name,
      action.fields[0]?.presentation,
    ]),
    [
      ["download-review-csv", "POST", `${CANONICAL_ORIGIN}/owner/exports/review.csv`, "application/x-www-form-urlencoded", "operation-id", "hidden"],
      ["download-json-backup", "POST", `${CANONICAL_ORIGIN}/owner/exports/backup.json`, "application/x-www-form-urlencoded", "operation-id", "hidden"],
    ],
  );
  assert.doesNotMatch(JSON.stringify(document), new RegExp(CSRF_TOKEN, "u"));

  const html = await requiredResponse(await handler(context(request(
    "/owner/exports",
    { accept: "text/html" },
  ))));
  assert.equal(html.headers.get(MUTATION_CSRF_HEADER), CSRF_TOKEN);
  const body = await html.text();
  assert.match(body, /<h1>Review exports<\/h1>/u);
  assert.match(body, /private participant information/u);
  assert.match(body, new RegExp(
    `action="${CANONICAL_ORIGIN}/owner/exports/review\\.csv" method="post"`,
    "u",
  ));
  assert.match(body, new RegExp(
    `action="${CANONICAL_ORIGIN}/owner/exports/backup\\.json" method="post"`,
    "u",
  ));
  assert.match(body, new RegExp(`name="${MUTATION_CSRF_FIELD}" value="${CSRF_TOKEN}"`, "u"));
  assert.doesNotMatch(body, /TASK-|implementation|repository plan/iu);

  const home = await requiredResponse(await handler(context(request(
    "/owner",
    { accept: "application/json" },
  ))));
  const homeDocument = await home.json() as {
    links: Array<{ rel: string[]; href: string }>;
    actions: Array<{ name: string; href: string }>;
  };
  assert.equal(homeDocument.links.some((link) =>
    link.rel.includes("review-exports") &&
    link.href === `${CANONICAL_ORIGIN}/owner/exports`
  ), true);
  assert.equal(homeDocument.actions.some((action) =>
    action.name === "open-review-exports" &&
    action.href === `${CANONICAL_ORIGIN}/owner/exports`
  ), true);
  assert.equal(harness.records.calls.length, 0);
  assert.equal(harness.audit.intents.length, 0);
});

test("CSV POST streams bounded rows with private headers and formula neutralization", async () => {
  const harness = await createHarness();
  const response = await requiredResponse(await harness.route(context(exportPost(
    "/owner/exports/review.csv",
    REVIEW_OPERATION,
    { accept: "text/csv", format: "form" },
  ))));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="investor-review.csv"',
  );
  assert.equal(response.headers.get(MUTATION_CSRF_HEADER), null);
  assertPrivateHeaders(response);
  assert.ok(response.body instanceof ReadableStream);
  assert.equal(harness.audit.intents.length, 1,
    "audit evidence must be committed before the stream is consumed");

  const body = await response.text();
  assert.equal(
    Number(response.headers.get("content-length")),
    new TextEncoder().encode(body).byteLength,
  );
  assert.match(body, /^"record_type","record_id","participant_subject"/u);
  assert.match(body, /"'=2\+2, ""Participant"""/u);
  assert.match(body, /"'\+Private, Incorporated"/u);
  assert.match(body, /"'-private review note"/u);
  assert.match(body, /"'@SUM\(A1:A2\)\n""Quoted expertise"""/u);
  assert.equal(harness.records.calls.length >= 3, true);
  assert.equal(harness.records.calls.every((call) =>
    call.limit <= 2 &&
    call.maxRecordBytes === 100_000 &&
    call.maxHistoryEntries === 4
  ), true);

  const intent = harness.audit.intents[0];
  assert.equal(intent?.event.actor.type, "owner");
  assert.deepEqual(intent?.event.detail, {
    kind: "export-created",
    exportType: "review-csv",
  });
  const evidence = JSON.stringify(harness.audit.intents);
  assert.doesNotMatch(evidence, /Private, Incorporated|private review note|Quoted expertise/u);
});

test("CSV cell encoding neutralizes formulas after whitespace and quotes delimiters", () => {
  assert.equal(encodeCsvCell("plain"), '"plain"');
  assert.equal(encodeCsvCell('comma, quote " and\nline'),
    '"comma, quote "" and\nline"');
  assert.equal(encodeCsvCell("=2+2"), '"\'=2+2"');
  assert.equal(encodeCsvCell("+cmd"), '"\'+cmd"');
  assert.equal(encodeCsvCell("-10"), '"\'-10"');
  assert.equal(encodeCsvCell("  @SUM(A1:A2)"), '"\'  @SUM(A1:A2)"');
  assert.equal(encodeCsvCell("\t=HYPERLINK(\"x\")"),
    '"\'\t=HYPERLINK(""x"")"');
  assert.equal(encodeCsvCell("\n+cmd"), '"\'\n+cmd"');
});

test("JSON POST returns a bounded current-state projection with canonical source", async () => {
  const harness = await createHarness();
  const response = await requiredResponse(await harness.route(context(exportPost(
    "/owner/exports/backup.json",
    BACKUP_OPERATION,
    { accept: "application/json" },
  ))));

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="investor-backup.json"',
  );
  assert.equal(response.headers.get("content-type"),
    "application/json; charset=utf-8");
  assertPrivateHeaders(response);
  assert.equal(harness.audit.intents.length, 1);
  const backup = await response.json() as {
    schema_version: string;
    type: string;
    exported_at: string;
    source_url: string;
    campaign: { revision: number; public_campaign: { id: string } };
    current_package: { revision: number; version: { sections: Array<{ markdown: string }> } };
    participant_profiles: Array<{ profile: { display_name: string } }>;
    investment_indications: Array<{ fields: { company_name: string }; history: unknown[] }>;
    founder_applications: Array<{ fields: { expertise_summary: string }; history: unknown[] }>;
    aggregate: { total_amount_minor_units: number; contributing_indication_count: number };
  };
  assert.equal(backup.schema_version, "1");
  assert.equal(backup.type, "owner-review-backup");
  assert.equal(backup.exported_at, EXPORTED_AT);
  assert.equal(backup.source_url,
    `${CANONICAL_ORIGIN}/owner/exports/backup.json`);
  assert.equal(backup.campaign.revision, 3);
  assert.equal(backup.campaign.public_campaign.id, syntheticPublicCampaign.id);
  assert.equal(backup.current_package.version.sections[0]?.markdown,
    "Private synthetic package content.");
  assert.equal(backup.participant_profiles[0]?.profile.display_name,
    '=2+2, "Participant"');
  assert.equal(backup.investment_indications[0]?.fields.company_name,
    PRIVATE_COMPANY);
  assert.equal(backup.investment_indications[0]?.history.length, 1);
  assert.equal(backup.founder_applications[0]?.fields.expertise_summary,
    PRIVATE_EXPERTISE);
  assert.equal(backup.founder_applications[0]?.history.length, 1);
  assert.equal(backup.aggregate.total_amount_minor_units, 2_000);
  assert.equal(backup.aggregate.contributing_indication_count, 1);

  const serialized = JSON.stringify(backup);
  assert.doesNotMatch(serialized, /campaign-operation:save/u,
    "repository operation identifiers are not part of the backup shape");
  const evidence = JSON.stringify(harness.audit.intents);
  assert.doesNotMatch(evidence, /Private synthetic package|Private, Incorporated/u);
  assert.deepEqual(harness.audit.intents[0]?.event.detail, {
    kind: "export-created",
    exportType: "json-backup",
  });
});

test("anonymous and foreign callers fail without CSRF discovery, reads, or disclosure", async () => {
  const harness = await createHarness();
  const anonymous = await requiredResponse(await harness.route(context(exportPost(
    "/owner/exports/review.csv",
    REVIEW_OPERATION,
    { accept: "text/csv" },
  ), { actor: null, isOwner: false })));
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get(MUTATION_CSRF_HEADER), null);

  const foreign = await requiredResponse(await harness.route(context(exportPost(
    "/owner/exports/backup.json",
    BACKUP_OPERATION,
    { accept: "application/json" },
  ), { actor: participantActor(), isOwner: false })));
  assert.equal(foreign.status, 404);
  assert.equal(foreign.headers.get(MUTATION_CSRF_HEADER), null);
  const deniedBodies = `${await anonymous.text()}${await foreign.text()}`;
  assert.doesNotMatch(deniedBodies,
    /Private, Incorporated|private review note|Quoted expertise|configured-owner/u);
  assert.equal(harness.records.calls.length, 0);
  assert.equal(harness.staticReadCalls, 0);
  assert.equal(harness.audit.intents.length, 0);
  assert.equal(harness.sessionCalls, 0);
});

test("download GET is side-effect-free and invalid method, query, and media fail before reads", async () => {
  const harness = await createHarness();
  const get = await requiredResponse(await harness.route(context(request(
    "/owner/exports/review.csv",
    { accept: "text/csv" },
  ))));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");

  const workspacePost = await requiredResponse(await harness.route(context(
    exportPost("/owner/exports", REVIEW_OPERATION, { accept: "text/html" }),
  )));
  assert.equal(workspacePost.status, 405);
  assert.equal(workspacePost.headers.get("allow"), "GET");

  const query = await requiredResponse(await harness.route(context(exportPost(
    "/owner/exports/review.csv?unbounded=true",
    REVIEW_OPERATION,
    { accept: "text/csv" },
  ))));
  assert.equal(query.status, 400);

  const unacceptable = await requiredResponse(await harness.route(context(
    exportPost("/owner/exports/backup.json", BACKUP_OPERATION, {
      accept: "image/png",
    }),
  )));
  assert.equal(unacceptable.status, 406);
  assert.equal(harness.records.calls.length, 0);
  assert.equal(harness.staticReadCalls, 0);
  assert.equal(harness.audit.intents.length, 0);
  assert.equal(harness.sessionCalls, 0);
});

test("cross-origin, missing-CSRF, and extra-field POSTs fail before private reads", async () => {
  const harness = await createHarness();
  const crossOrigin = await requiredResponse(await harness.route(context(exportPost(
    "/owner/exports/review.csv",
    REVIEW_OPERATION,
    { accept: "text/csv", origin: "https://attacker.example" },
  ))));
  assert.equal(crossOrigin.status, 403);
  assertPrivateHeaders(crossOrigin);

  const missingCsrf = await requiredResponse(await harness.route(context(exportPost(
    "/owner/exports/review.csv",
    REVIEW_OPERATION,
    { accept: "text/csv", csrf: false },
  ))));
  assert.equal(missingCsrf.status, 403);

  const extra = await requiredResponse(await harness.route(context(exportPost(
    "/owner/exports/backup.json",
    BACKUP_OPERATION,
    { accept: "application/json", extra: { unexpected: "value" } },
  ))));
  assert.equal(extra.status, 400);
  assert.equal(harness.records.calls.length, 0);
  assert.equal(harness.staticReadCalls, 0);
  assert.equal(harness.audit.intents.length, 0);
});

test("row, record, history, and serialized-byte limits fail before audit or attachment", async () => {
  const rowBound = await createHarness({ maxRows: 2 });
  const rows = await requiredResponse(await rowBound.route(context(exportPost(
    "/owner/exports/review.csv",
    REVIEW_OPERATION,
    { accept: "text/csv" },
  ))));
  await assertBoundedFailure(rows, rowBound);

  const recordBound = await createHarness(
    { maxRecordBytes: 1_024 },
    { oversizedProfileLength: 2_048 },
  );
  const record = await requiredResponse(await recordBound.route(context(exportPost(
    "/owner/exports/review.csv",
    REVIEW_OPERATION,
    { accept: "text/csv" },
  ))));
  await assertBoundedFailure(record, recordBound);

  const historyBound = await createHarness(
    { maxHistoryEntries: 1 },
    { historyEntries: 2, poisonOversizedHistory: true },
  );
  const history = await requiredResponse(await historyBound.route(context(exportPost(
    "/owner/exports/backup.json",
    BACKUP_OPERATION,
    { accept: "application/json" },
  ))));
  await assertBoundedFailure(history, historyBound);

  const byteBound = await createHarness({ maxBytes: 64 });
  const bytes = await requiredResponse(await byteBound.route(context(exportPost(
    "/owner/exports/backup.json",
    BACKUP_OPERATION,
    { accept: "application/json" },
  ))));
  await assertBoundedFailure(bytes, byteBound);
});

test("huge CSV and JSON fields stop scanning at the per-record budget", async () => {
  const csvHarness = await createHarness(
    { maxRecordBytes: 1_024 },
    { oversizedProfileValue: " ".repeat(2_000_000) },
  );
  const csv = await withCharCodeAtCeiling(10_000, () =>
    csvHarness.route(context(exportPost(
      "/owner/exports/review.csv",
      REVIEW_OPERATION,
      { accept: "text/csv" },
    )))
  );
  await assertBoundedFailure(await requiredResponse(csv.value), csvHarness);
  assert.ok(csv.calls < 10_000,
    `CSV projection read ${csv.calls} UTF-16 code units`);

  const jsonHarness = await createHarness(
    { maxRecordBytes: 4_096 },
    { oversizedProfileValue: "x".repeat(2_000_000) },
  );
  const json = await withCharCodeAtCeiling(25_000, () =>
    jsonHarness.route(context(exportPost(
      "/owner/exports/backup.json",
      BACKUP_OPERATION,
      { accept: "application/json" },
    )))
  );
  await assertBoundedFailure(await requiredResponse(json.value), jsonHarness);
  assert.ok(json.calls < 25_000,
    `JSON projection read ${json.calls} UTF-16 code units`);
});

test("audit append is verified and a commit-then-timeout retry is consumed", async () => {
  const unavailable = await createHarness({}, { auditMode: "throw" });
  const failed = await requiredResponse(await unavailable.route(context(exportPost(
    "/owner/exports/review.csv",
    REVIEW_OPERATION,
    { accept: "text/csv" },
  ))));
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("content-disposition"), null);
  assert.equal(unavailable.audit.intents.length, 0);
  assert.equal(unavailable.audit.attempts.length, 1);

  const mismatched = await createHarness({}, { auditMode: "mismatch" });
  const mismatch = await requiredResponse(await mismatched.route(context(exportPost(
    "/owner/exports/backup.json",
    BACKUP_OPERATION,
    { accept: "application/json" },
  ))));
  assert.equal(mismatch.status, 503);
  assert.equal(mismatched.audit.intents.length, 0);

  const inconsistent = await createHarness();
  Object.defineProperty(inconsistent.audit, "appendConsistency", {
    value: "best-effort",
  });
  const consistencyFailure = await requiredResponse(await inconsistent.route(
    context(exportPost("/owner/exports/review.csv", REVIEW_OPERATION, {
      accept: "text/csv",
    })),
  ));
  assert.equal(consistencyFailure.status, 503);
  assert.equal(inconsistent.staticReadCalls, 0);
  assert.equal(inconsistent.records.calls.length, 0);

  const ambiguous = await createHarness({}, { auditMode: "commit-then-throw-once" });
  const first = await requiredResponse(await ambiguous.route(context(exportPost(
    "/owner/exports/backup.json",
    BACKUP_OPERATION,
    { accept: "application/json" },
  ))));
  assert.equal(first.status, 503);
  assert.equal(first.headers.get("content-disposition"), null);
  assert.equal(ambiguous.audit.intents.length, 1);
  const readsAfterCommit = ambiguous.records.calls.length;
  const staticReadsAfterCommit = ambiguous.staticReadCalls;

  const retry = await requiredResponse(await ambiguous.route(context(exportPost(
    "/owner/exports/backup.json",
    BACKUP_OPERATION,
    { accept: "application/json" },
  ))));
  assert.equal(retry.status, 409);
  assert.equal(retry.headers.get("content-disposition"), null);
  assertPrivateHeaders(retry);
  assert.equal(ambiguous.audit.intents.length, 1);
  assert.equal(ambiguous.audit.attempts.length, 1);
  assert.equal(ambiguous.records.calls.length, readsAfterCommit);
  assert.equal(ambiguous.staticReadCalls, staticReadsAfterCommit);
});

test("a completed operation is single-use while a fresh operation creates evidence", async () => {
  const harness = await createHarness();
  const first = await requiredResponse(await harness.route(context(exportPost(
    "/owner/exports/backup.json",
    BACKUP_OPERATION,
    { accept: "application/json" },
  ))));
  assert.equal(first.status, 200);
  await first.body?.cancel();
  const readsAfterFirst = harness.records.calls.length;
  const staticReadsAfterFirst = harness.staticReadCalls;
  const replay = await requiredResponse(await harness.route(context(exportPost(
    "/owner/exports/backup.json",
    BACKUP_OPERATION,
    { accept: "application/json" },
  ))));
  assert.equal(replay.status, 409);
  assert.equal(replay.headers.get("content-disposition"), null);
  const replayDocument = await replay.json() as {
    data: { code: string };
    links: Array<{ rel: string[]; href: string }>;
  };
  assert.equal(
    replayDocument.data.code,
    "export_operation_stale",
  );
  assert.equal(replayDocument.links.some((link) =>
    link.rel.includes("review-exports") &&
    link.href === `${CANONICAL_ORIGIN}/owner/exports`
  ), true);
  assert.equal(harness.audit.intents.length, 1);
  assert.equal(harness.audit.attempts.length, 1);
  assert.equal(harness.records.calls.length, readsAfterFirst);
  assert.equal(harness.staticReadCalls, staticReadsAfterFirst);
  assert.equal(harness.nowCalls, 1,
    "a replay does not issue a new export timestamp");

  const distinct = await requiredResponse(await harness.route(context(exportPost(
    "/owner/exports/backup.json",
    "owner-export-request:backup-02",
    { accept: "application/json" },
  ))));
  assert.equal(distinct.status, 200);
  assert.equal(
    (await distinct.json() as { exported_at: string }).exported_at,
    "2026-08-09T15:00:01.000Z",
  );
  assert.equal(harness.audit.intents.length, 2);
});

test("intervening mutation cannot reuse old audit evidence for changed bytes", async () => {
  const harness = await createHarness();
  const first = await requiredResponse(await harness.route(context(exportPost(
    "/owner/exports/backup.json",
    BACKUP_OPERATION,
    { accept: "application/json" },
  ))));
  assert.equal(first.status, 200);
  assert.equal(
    (await first.json() as {
      participant_profiles: Array<{ profile: { display_name: string } }>;
    }).participant_profiles[0]?.profile.display_name,
    '=2+2, "Participant"',
  );

  harness.records.changeParticipantDisplayName("Changed participant");
  const readsBeforeReplay = harness.records.calls.length;
  const staticReadsBeforeReplay = harness.staticReadCalls;
  const replay = await requiredResponse(await harness.route(context(exportPost(
    "/owner/exports/backup.json",
    BACKUP_OPERATION,
    { accept: "application/json" },
  ))));
  assert.equal(replay.status, 409);
  assert.equal(replay.headers.get("content-disposition"), null);
  assert.doesNotMatch(await replay.text(), /Changed participant/u);
  assert.equal(harness.records.calls.length, readsBeforeReplay);
  assert.equal(harness.staticReadCalls, staticReadsBeforeReplay);
  assert.equal(harness.audit.intents.length, 1);
  assert.equal(harness.audit.attempts.length, 1);

  const fresh = await requiredResponse(await harness.route(context(exportPost(
    "/owner/exports/backup.json",
    "owner-export-request:backup-after-mutation",
    { accept: "application/json" },
  ))));
  assert.equal(fresh.status, 200);
  const changed = await fresh.json() as {
    exported_at: string;
    participant_profiles: Array<{ profile: { display_name: string } }>;
  };
  assert.equal(changed.exported_at, "2026-08-09T15:00:01.000Z");
  assert.equal(
    changed.participant_profiles[0]?.profile.display_name,
    "Changed participant",
  );
  assert.equal(harness.audit.intents.length, 2);
});

test("malformed or looping pagination fails closed within finite page bounds", async () => {
  const harness = await createHarness({}, { loopingReader: true });
  const response = await requiredResponse(await harness.route(context(exportPost(
    "/owner/exports/review.csv",
    REVIEW_OPERATION,
    { accept: "text/csv" },
  ))));
  assert.equal(response.status, 503);
  assert.equal(harness.records.calls.length, 2);
  assert.equal(harness.audit.intents.length, 0);
});

test("client cancellation records generation but never claims delivery", async () => {
  const harness = await createHarness();
  const response = await requiredResponse(await harness.route(context(exportPost(
    "/owner/exports/review.csv",
    REVIEW_OPERATION,
    { accept: "text/csv" },
  ))));
  assert.equal(response.status, 200);
  const reader = response.body?.getReader();
  assert.ok(reader);
  const first = await reader.read();
  assert.equal(first.done, false);
  await reader.cancel("synthetic disconnect");
  assert.equal(harness.audit.intents.length, 1);
  assert.deepEqual(harness.audit.intents[0]?.event.detail, {
    kind: "export-created",
    exportType: "review-csv",
  });
  assert.doesNotMatch(JSON.stringify(harness.audit.intents), /delivered|received/u);
  const readsAfterCancel = harness.records.calls.length;

  const retry = await requiredResponse(await harness.route(context(exportPost(
    "/owner/exports/review.csv",
    REVIEW_OPERATION,
    { accept: "text/csv" },
  ))));
  assert.equal(retry.status, 409);
  assert.equal(retry.headers.get("content-disposition"), null);
  assert.equal(harness.audit.intents.length, 1);
  assert.equal(harness.audit.attempts.length, 1);
  assert.equal(harness.records.calls.length, readsAfterCancel);
});

type HarnessOptions = Readonly<{
  auditMode?: "ok" | "throw" | "mismatch" | "commit-then-throw-once";
  loopingReader?: boolean;
  historyEntries?: number;
  poisonOversizedHistory?: boolean;
  oversizedProfileLength?: number;
  oversizedProfileValue?: string;
}>;

async function createHarness(
  limitOverrides: Partial<OwnerReviewExportLimits> = {},
  options: HarnessOptions = {},
) {
  const fixtures = await exportFixtures(options);
  const records = new FakeReviewReader(fixtures, options.loopingReader ?? false);
  const audit = new FakeGuaranteedAuditRepository(options.auditMode ?? "ok");
  let staticReadCalls = 0;
  let sessionCalls = 0;
  let nowCalls = 0;
  let sequence = 0;
  const service = createOwnerReviewExportService({
    campaign: {
      readSetup: async () => {
        staticReadCalls += 1;
        return fixtures.campaign;
      },
    },
    content: {
      current: async () => {
        staticReadCalls += 1;
        return fixtures.currentPackage;
      },
    },
    aggregate: {
      readStored: async () => {
        staticReadCalls += 1;
        return fixtures.aggregate;
      },
    },
    records,
    audit,
    now: () => {
      nowCalls += 1;
      return new Date(Date.parse(EXPORTED_AT) + (nowCalls - 1) * 1_000);
    },
    limits: {
      maxRows: 10,
      maxBytes: 1_000_000,
      maxRecordBytes: 100_000,
      maxHistoryEntries: 4,
      pageSize: 2,
      ...limitOverrides,
    },
  });
  const ownerSubject = valueOf(parseActorSubject(OWNER_SUBJECT));
  const expiresAt = valueOf(parseTimestamp("2027-08-09T15:00:00.000Z"));
  const csrfHash = await hashCsrfToken(CSRF_TOKEN);
  const guardMutation = createBrowserMutationGuard({
    allowedOrigins: [CANONICAL_ORIGIN],
    resolveSession: async () => {
      sessionCalls += 1;
      return {
        actor: { type: "owner", subject: ownerSubject },
        expiresAt,
        csrf: { tokenHash: csrfHash, expiresAt },
      };
    },
    now: () => new Date(EXPORTED_AT),
  });
  const route = createOwnerReviewExportRouteHandler({
    service,
    guardMutation,
    csrfToken: async () => CSRF_TOKEN,
    issueOperationId: (exportType) => {
      sequence += 1;
      return `owner-export-form:${exportType}:${sequence}`;
    },
  });
  return {
    route,
    records,
    audit,
    get staticReadCalls() {
      return staticReadCalls;
    },
    get sessionCalls() {
      return sessionCalls;
    },
    get nowCalls() {
      return nowCalls;
    },
  };
}

class FakeReviewReader implements OwnerReviewExportDataReader {
  readonly calls: Array<{
    collection: string;
    limit: number;
    maxRecordBytes: number;
    maxHistoryEntries: number;
    cursor?: string;
  }> = [];
  readonly #fixtures: Awaited<ReturnType<typeof exportFixtures>>;
  readonly #looping: boolean;
  #participant: ParticipantProfileSnapshot;

  constructor(
    fixtures: Awaited<ReturnType<typeof exportFixtures>>,
    looping: boolean,
  ) {
    this.#fixtures = fixtures;
    this.#looping = looping;
    this.#participant = fixtures.participant;
  }

  changeParticipantDisplayName(displayName: string): void {
    this.#participant = Object.freeze({
      ...this.#participant,
      snapshot: Object.freeze({
        ...this.#participant.snapshot,
        displayName,
      }),
    });
  }

  listParticipantProfiles(request: ReadRequest) {
    if (this.#looping) {
      this.calls.push({
        collection: "participants",
        limit: request.limit,
        maxRecordBytes: request.maxRecordBytes,
        maxHistoryEntries: request.maxHistoryEntries,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      });
      return Promise.resolve({
        items: request.cursor === undefined
          ? [this.#participant]
          : [this.#participant],
        nextCursor: "participants:repeat" as StorageCursor,
      });
    }
    return Promise.resolve(this.#page(
      "participants",
      [this.#participant],
      request,
    ));
  }

  listInvestmentIndications(request: ReadRequest) {
    return Promise.resolve(this.#page(
      "indications",
      [this.#fixtures.indication],
      request,
    ));
  }

  listFounderApplications(request: ReadRequest) {
    return Promise.resolve(this.#page(
      "founders",
      [this.#fixtures.founder],
      request,
    ));
  }

  #page<Item>(
    collection: string,
    values: readonly Item[],
    request: ReadRequest,
  ): OwnerReviewExportPage<Item> {
    this.calls.push({
      collection,
      limit: request.limit,
      maxRecordBytes: request.maxRecordBytes,
      maxHistoryEntries: request.maxHistoryEntries,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    });
    const start = request.cursor === undefined
      ? 0
      : Number(String(request.cursor).split(":").at(-1));
    const end = Math.min(start + 1, start + request.limit, values.length);
    return {
      items: values.slice(start, end),
      nextCursor: end < values.length
        ? `${collection}:${end}` as StorageCursor
        : null,
    };
  }
}

type ReadRequest = OwnerReviewExportPageRequest;

class FakeGuaranteedAuditRepository
  implements GuaranteedAuditAppendRepository
{
  readonly appendConsistency = "atomic-immutable-audit" as const;
  readonly intents: AuditAppendIntent[] = [];
  readonly attempts: AuditAppendIntent[] = [];
  readonly #events = new Map<string, AuditEvent>();
  readonly #operations = new Map<string, AuditEvent>();
  readonly #mode: HarnessOptions["auditMode"];
  #threwAfterCommit = false;

  constructor(mode: NonNullable<HarnessOptions["auditMode"]>) {
    this.#mode = mode;
  }

  async append(intent: unknown): Promise<AuditAppendResult> {
    const parsed = parseAuditAppendIntent(intent);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error("Invalid audit fixture.");
    this.attempts.push(parsed.value);
    const priorEvent = this.#events.get(parsed.value.event.id);
    const priorOperation = this.#operations.get(parsed.value.event.operationId);
    if (priorEvent || priorOperation) {
      const prior = priorEvent ?? priorOperation;
      if (JSON.stringify(prior) !== JSON.stringify(parsed.value.event)) {
        throw new Error("Synthetic audit conflict.");
      }
      return { event: prior as AuditEvent, replayed: true };
    }
    if (this.#mode === "throw") throw new Error("Synthetic audit failure.");
    if (this.#mode === "mismatch") {
      return {
        event: {
          ...parsed.value.event,
          detail: {
            kind: "export-created",
            exportType: parsed.value.event.detail.kind === "export-created" &&
                parsed.value.event.detail.exportType === "json-backup"
              ? "review-csv"
              : "json-backup",
          },
        },
        replayed: false,
      };
    }
    this.#events.set(parsed.value.event.id, parsed.value.event);
    this.#operations.set(parsed.value.event.operationId, parsed.value.event);
    this.intents.push(parsed.value);
    if (this.#mode === "commit-then-throw-once" && !this.#threwAfterCommit) {
      this.#threwAfterCommit = true;
      throw new Error("Synthetic response loss after audit commit.");
    }
    return { event: parsed.value.event, replayed: false };
  }

  async get(id: unknown): Promise<AuditEvent | null> {
    return typeof id === "string" ? this.#events.get(id) ?? null : null;
  }

  async list(request: AuditListRequest): Promise<AuditEventPage> {
    return {
      items: this.intents.slice(0, request.limit).map((intent) => intent.event),
      nextCursor: null,
    };
  }
}

async function exportFixtures(options: HarnessOptions = {}) {
  const packageVersion = await createPrivatePackage();
  const baseParticipant = createParticipant();
  const oversizedProfileValue = options.oversizedProfileValue ??
    (options.oversizedProfileLength === undefined
      ? undefined
      : "x".repeat(options.oversizedProfileLength));
  const participant = oversizedProfileValue === undefined
    ? baseParticipant
    : Object.freeze({
        ...baseParticipant,
        snapshot: Object.freeze({
          ...baseParticipant.snapshot,
          displayName: oversizedProfileValue,
        }),
      }) as ParticipantProfileSnapshot;
  const baseIndication = createIndication(packageVersion);
  const indication = options.historyEntries === undefined
    ? baseIndication
    : indicationWithHistory(
        baseIndication,
        options.historyEntries,
        options.poisonOversizedHistory ?? false,
      );
  const founder = createFounder();
  const campaign = createCampaign();
  const amount = parseMinorUnits(2_000);
  assert.equal(amount.ok, true);
  if (!amount.ok) throw new Error("Invalid aggregate fixture.");
  const amountConfiguration = configuredAmounts();
  return Object.freeze({
    campaign,
    currentPackage: Object.freeze({
      revision: 4,
      snapshot: packageVersion,
    }) as RevisionedSnapshot<PackageVersion>,
    participant,
    indication,
    founder,
    aggregate: Object.freeze({
      revision: 7,
      totalAmount: amount.value,
      currency: amountConfiguration.amount.currency,
      contributingIndicationCount: 1,
    }),
  });
}

function indicationWithHistory(
  indication: InvestmentIndication,
  count: number,
  poison: boolean,
): InvestmentIndication {
  const entry = indication.history[0];
  assert.ok(entry);
  const candidate = poison
    ? new Proxy(entry, {
        get() {
          throw new Error("Oversized history entries must not be projected.");
        },
      })
    : entry;
  return Object.freeze({
    ...indication,
    history: Object.freeze(Array.from({ length: count }, () => candidate)),
  }) as InvestmentIndication;
}

function createCampaign(): CampaignSetupRevision {
  const phase = parsePhaseConfiguration({
    id: "phase:pre-registration",
    state: "open",
    enabledParticipationPaths: ["founder", "investor"],
    countryEligibility: { mode: "deny", countries: [] },
  });
  const recordedAt = parseTimestamp("2026-08-09T07:00:00.000Z");
  const operationId = parseStorageOperationId("campaign-operation:save");
  assert.equal(phase.ok, true);
  assert.equal(recordedAt.ok, true);
  assert.equal(operationId.ok, true);
  if (!phase.ok || !recordedAt.ok || !operationId.ok) {
    throw new Error("Invalid campaign fixture.");
  }
  return Object.freeze({
    revision: 3,
    recordedAt: recordedAt.value,
    operationId: operationId.value,
    setup: Object.freeze({
      publicCampaign: syntheticPublicCampaign,
      phases: Object.freeze([phase.value]),
      amountAggregate: configuredAmounts(),
      campaignPolicy: configuredCampaignPolicy(),
    }),
  });
}

function configuredAmounts() {
  const parsed = parseAmountAggregateConfiguration({
    amount: {
      currency: "eur",
      minimum: 1_000,
      increment: 500,
      maximum: 100_000,
    },
    publicAggregate: {
      visibility: "non_zero",
      label: "Non-binding interest",
      qualifier: "Self-declared and unverified.",
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("Invalid amount fixture.");
  return parsed.value;
}

function configuredCampaignPolicy() {
  const parsed = parseCampaignSetupPolicy(
    explicitCampaignSetup().campaignPolicy,
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("Invalid campaign policy fixture.");
  return parsed.value;
}

async function createPrivatePackage(): Promise<PackageVersion> {
  return valueOf(await createPackageVersion({
    id: "package-version:export",
    createdAt: "2026-08-09T08:00:00.000Z",
    changeSummary: "Synthetic private package",
    materialChange: true,
    acknowledgmentText: "I understand this indication is non-binding.",
    sections: [{
      id: "package-section:overview",
      order: 0,
      title: "Overview",
      markdown: "Private synthetic package content.",
      enabled: true,
    }],
  }));
}

function createParticipant(): ParticipantProfileSnapshot {
  const account = parseParticipantAccount({
    subject: "issuer.invalid/subject:participant",
    accountEmailLabel: "participant@example.invalid",
  });
  const registeredAt = parseTimestamp("2026-08-09T08:30:00.000Z");
  assert.equal(account.ok, true);
  assert.equal(registeredAt.ok, true);
  if (!account.ok || !registeredAt.ok) {
    throw new Error("Invalid participant fixture.");
  }
  const profile = registerParticipantProfile(account.value, {
    displayName: '=2+2, "Participant"',
    country: "fi",
    declaredInterest: "both",
    participationContext: "company",
    processEmailNoticeAcknowledged: true,
    marketingConsent: false,
  }, registeredAt.value, testParticipantRegistrationNoticeEvidence());
  assert.equal(profile.ok, true);
  if (!profile.ok) throw new Error("Invalid participant profile fixture.");
  return Object.freeze({ revision: 2, snapshot: profile.value });
}

function createIndication(packageVersion: PackageVersion): InvestmentIndication {
  const actor = participantIndicationActor();
  const accepted = createPackageAcceptance({
    id: "package-acceptance:export",
    participantSubject: actor.subject,
    acceptedAt: "2026-08-09T09:00:00.000Z",
  }, packageVersion);
  assert.equal(accepted.ok, true);
  if (!accepted.ok) throw new Error("Invalid acceptance fixture.");
  return valueOf(createInvestmentIndication({
    id: "investment-indication:export",
    occurredAt: "2026-08-09T10:00:00.000Z",
    historyEntryId: "investment-history:export-created",
    fields: {
      kind: "company",
      companyName: PRIVATE_COMPANY,
      registrationCountry: "fi",
      companyIdentifier: "SYNTHETIC-123",
      representativeName: "@Representative",
      representativeAuthorityDeclared: true,
      amount: 2_000,
      availabilityPeriod: "Within twelve months.",
      note: PRIVATE_NOTE,
    },
  }, actor, configuredAmounts().amount, {
    currentVersion: packageVersion,
    latestAcceptance: accepted.value,
  }));
}

function participantIndicationActor(): ParticipantIndicationActor {
  const subject = parseActorSubject("issuer.invalid/subject:participant");
  assert.equal(subject.ok, true);
  if (!subject.ok) throw new Error("Invalid participant actor fixture.");
  return Object.freeze({ type: "participant", subject: subject.value });
}

function createFounder(): FounderApplication {
  const choices = parseContributionAreaChoices([
    { id: "area:engineering", label: "Engineering" },
    { id: "area:product", label: "Product" },
  ]);
  const subject = parseActorSubject("issuer.invalid/subject:participant");
  assert.equal(choices.ok, true);
  assert.equal(subject.ok, true);
  if (!choices.ok || !subject.ok) {
    throw new Error("Invalid founder fixture.");
  }
  return valueOf(createFounderApplication({
    id: "founder-application:export",
    applicantSubject: subject.value,
    occurredAt: "2026-08-09T10:30:00.000Z",
    historyEntryId: "founder-history:export-created",
    fields: {
      expertiseSummary: PRIVATE_EXPERTISE,
      intendedContribution: "Build and review the product.",
      primaryContributionAreaId: "area:engineering",
      secondaryContributionAreaIds: ["area:product"],
      approximateAvailability: "Two days each week.",
      possibleStartTiming: "After mutual confirmation.",
      compensationExpectation: "Open to discussion.",
      professionalProfileLinks: ["https://profiles.example.invalid/person"],
      note: "A founder note.",
    },
  }, choices.value));
}

function valueOf<Value>(result: ValidationResult<Value>): Value {
  if (!result.ok) assert.fail(JSON.stringify(result.issues));
  return result.value;
}

function request(
  path: string,
  options: Readonly<{ accept?: string }> = {},
): Request {
  return new Request(`${INTERNAL_ORIGIN}${path}`, {
    headers: { Accept: options.accept ?? "text/html" },
  });
}

type ExportPostOptions = Readonly<{
  accept?: string;
  origin?: string;
  csrf?: boolean;
  format?: "json" | "form";
  extra?: Readonly<Record<string, string>>;
}>;

function exportPost(
  path: string,
  operationId: string,
  options: ExportPostOptions = {},
): Request {
  const format = options.format ?? "json";
  const headers = new Headers({
    Accept: options.accept ?? "application/json",
    Origin: options.origin ?? CANONICAL_ORIGIN,
  });
  if (format === "form") {
    const body = new URLSearchParams({
      "operation-id": operationId,
      ...(options.extra ?? {}),
    });
    if (options.csrf !== false) body.set(MUTATION_CSRF_FIELD, CSRF_TOKEN);
    return new Request(`${INTERNAL_ORIGIN}${path}`, {
      method: "POST",
      headers,
      body,
    });
  }
  headers.set("Content-Type", "application/json");
  if (options.csrf !== false) headers.set(MUTATION_CSRF_HEADER, CSRF_TOKEN);
  return new Request(`${INTERNAL_ORIGIN}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      "operation-id": operationId,
      ...(options.extra ?? {}),
    }),
  });
}

async function assertBoundedFailure(
  response: Response,
  harness: Readonly<{
    audit: Readonly<{ intents: readonly AuditAppendIntent[] }>;
  }>,
): Promise<void> {
  assert.equal(response.status, 413);
  assert.equal(response.headers.get("content-disposition"), null);
  assertPrivateHeaders(response);
  assert.doesNotMatch(
    await response.text(),
    /Private synthetic package|Private, Incorporated|private review note|Quoted expertise/u,
  );
  assert.equal(harness.audit.intents.length, 0);
}

async function withCharCodeAtCeiling<Value>(
  ceiling: number,
  action: () => Promise<Value>,
): Promise<Readonly<{ value: Value; calls: number }>> {
  const descriptor = Object.getOwnPropertyDescriptor(
    String.prototype,
    "charCodeAt",
  );
  if (descriptor === undefined) throw new Error("Missing charCodeAt descriptor.");
  const original = String.prototype.charCodeAt;
  let calls = 0;
  Object.defineProperty(String.prototype, "charCodeAt", {
    ...descriptor,
    value: function instrumentedCharCodeAt(
      this: string,
      position: number,
    ): number {
      calls += 1;
      if (calls > ceiling) {
        throw new Error("String projection exceeded its scan ceiling.");
      }
      return original.call(this, position);
    },
  });
  try {
    return Object.freeze({ value: await action(), calls });
  } finally {
    Object.defineProperty(String.prototype, "charCodeAt", descriptor);
  }
}

type ContextOverrides = Readonly<{
  actor?: ApplicationRouteContext["actor"];
  isOwner?: boolean;
}>;

function context(
  incoming: Request,
  overrides: ContextOverrides = {},
): ApplicationRouteContext {
  const actor = overrides.actor === undefined ? ownerActor() : overrides.actor;
  const incomingUrl = new URL(incoming.url);
  return {
    request: incoming,
    url: incomingUrl,
    resourceUrl: new URL(
      `${incomingUrl.pathname}${incomingUrl.search}`,
      CANONICAL_ORIGIN,
    ).href,
    actor,
    isOwner: overrides.isOwner ?? actor?.userId === OWNER_SUBJECT,
    participantAccess: null,
    campaign: null,
    renderApplication: async () => new Response("application fallback"),
  };
}

function ownerActor() {
  return {
    userId: OWNER_SUBJECT,
    email: "configured-owner@example.invalid",
    displayName: "Configured Owner",
  };
}

function participantActor() {
  return {
    userId: "issuer.invalid/subject:foreign-participant",
    email: "participant@example.invalid",
    displayName: "Participant",
  };
}

function assertPrivateHeaders(response: Response): void {
  assert.equal(response.headers.get("cache-control"),
    "private, no-store, max-age=0");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("expires"), "0");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cross-origin-resource-policy"),
    "same-origin");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-robots-tag"),
    "noindex, nofollow, noarchive");
  assert.match(response.headers.get("vary") ?? "",
    /oai-authenticated-user-id/u);
}

async function requiredResponse(
  response: Response | null,
): Promise<Response> {
  assert.notEqual(response, null);
  return response as Response;
}
