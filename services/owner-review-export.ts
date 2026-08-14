import type {
  AuditEvent,
  ExportCreatedAuditDetail,
} from "../domain/audit-notification.ts";
import type { FounderApplication } from "../domain/founder-application.ts";
import {
  parseActorSubject,
  parseStableId,
  parseTimestamp,
  type ActorSubject,
  type Timestamp,
} from "../domain/foundation.ts";
import type { StoredInvestmentAggregateSnapshot } from "../domain/investment-aggregate.ts";
import type {
  InvestmentIndication,
  InvestmentIndicationFields,
} from "../domain/investment-indication.ts";
import type {
  PackageAcceptanceRecord,
  PackageVersion,
} from "../domain/package-content.ts";
import type { ParticipantProfile } from "../domain/participant-profile.ts";
import type {
  CampaignRepository,
  CampaignSetupRevision,
} from "../repositories/in-memory-campaign-repository.ts";
import type {
  PackageVersionRepository,
  RevisionedSnapshot,
} from "../repositories/in-memory-content-repository.ts";
import type { InvestmentAggregateRepository } from "../repositories/in-memory-aggregate-repository.ts";
import type {
  GuaranteedAuditAppendRepository,
} from "../repositories/in-memory-audit-notification-repositories.ts";
import type {
  ParticipantProfileSnapshot,
} from "../repositories/in-memory-participant-repository.ts";
import {
  parseStorageOperationId,
  type StorageCursor,
  type StorageOperationId,
} from "../domain/storage-adapter.ts";

export const OWNER_REVIEW_EXPORT_SCHEMA_VERSION = "1" as const;

export const DEFAULT_OWNER_REVIEW_EXPORT_LIMITS = Object.freeze({
  maxRows: 10_000,
  maxBytes: 8 * 1024 * 1024,
  maxRecordBytes: 4 * 1024 * 1024,
  maxHistoryEntries: 64,
  pageSize: 10,
});

export type OwnerReviewExportLimits = Readonly<{
  maxRows: number;
  maxBytes: number;
  maxRecordBytes: number;
  maxHistoryEntries: number;
  pageSize: number;
}>;

export type OwnerReviewExportPageRequest = Readonly<{
  limit: number;
  cursor?: StorageCursor;
  maxRecordBytes: number;
  maxHistoryEntries: number;
}>;

export type OwnerReviewExportPage<Item> = Readonly<{
  items: readonly Item[];
  nextCursor: StorageCursor | null;
}>;

/**
 * Configured-owner reader over current review records. Production supplies an
 * AittaDB-backed implementation whose credential is already owner-scoped.
 */
export interface OwnerReviewExportDataReader {
  listParticipantProfiles(
    request: OwnerReviewExportPageRequest,
  ): Promise<OwnerReviewExportPage<ParticipantProfileSnapshot>>;
  listInvestmentIndications(
    request: OwnerReviewExportPageRequest,
  ): Promise<OwnerReviewExportPage<InvestmentIndication>>;
  listFounderApplications(
    request: OwnerReviewExportPageRequest,
  ): Promise<OwnerReviewExportPage<FounderApplication>>;
}

export type OwnerReviewExportDependencies = Readonly<{
  campaign: Pick<CampaignRepository, "readSetup">;
  content: Pick<PackageVersionRepository, "current">;
  records: OwnerReviewExportDataReader;
  aggregate: Pick<InvestmentAggregateRepository, "readStored">;
  audit: GuaranteedAuditAppendRepository;
  now?: () => Date;
  limits?: Partial<OwnerReviewExportLimits>;
}>;

export type OwnerReviewExportRequest = Readonly<{
  ownerSubject: unknown;
  operationId: unknown;
  sourceUrl: string;
}>;

export type AuditedOwnerReviewExport = Readonly<{
  exportType: ExportCreatedAuditDetail["exportType"];
  filename: "investor-review.csv" | "investor-backup.json";
  contentType: "text/csv; charset=utf-8" | "application/json; charset=utf-8";
  chunks: readonly Uint8Array[];
  byteLength: number;
  auditEvent: AuditEvent;
}>;

export interface OwnerReviewExportService {
  readonly limits: OwnerReviewExportLimits;
  createReviewCsv(
    request: OwnerReviewExportRequest,
  ): Promise<AuditedOwnerReviewExport>;
  createJsonBackup(
    request: OwnerReviewExportRequest,
  ): Promise<AuditedOwnerReviewExport>;
}

export type OwnerReviewExportFailureCode =
  | "LIMIT_EXCEEDED"
  | "STALE_OPERATION"
  | "UNAVAILABLE";

const FAILURE_MESSAGES: Readonly<Record<OwnerReviewExportFailureCode, string>> =
  Object.freeze({
    LIMIT_EXCEEDED: "The export exceeds the configured limits.",
    STALE_OPERATION: "The export operation has already been used.",
    UNAVAILABLE: "The export is temporarily unavailable.",
  });

/** Fixed-message failure that never serializes source records or backend causes. */
export class OwnerReviewExportFailure extends Error {
  readonly code: OwnerReviewExportFailureCode;

  constructor(code: OwnerReviewExportFailureCode) {
    super(FAILURE_MESSAGES[code]);
    this.name = "OwnerReviewExportFailure";
    this.code = code;
  }
}

export const OWNER_REVIEW_CSV_COLUMNS = Object.freeze([
  "record_type",
  "record_id",
  "participant_subject",
  "revision",
  "status",
  "created_at",
  "updated_at",
  "display_name",
  "account_email",
  "country",
  "declared_interest",
  "participation_context",
  "marketing_consent",
  "deletion_requested_at",
  "indication_kind",
  "amount_minor_units",
  "currency",
  "availability_period",
  "company_name",
  "company_identifier",
  "representative_name",
  "representative_authority_declared",
  "expertise_summary",
  "intended_contribution",
  "primary_contribution_area_id",
  "secondary_contribution_area_ids",
  "approximate_availability",
  "possible_start_timing",
  "compensation_expectation",
  "professional_profile_links",
  "note",
  "rejection_reason",
  "accepted_package_version_id",
] as const);

type CsvValue = string | number | boolean | null;
type CsvRow = readonly CsvValue[];

type EncodedExport = Readonly<{
  chunks: readonly Uint8Array[];
  byteLength: number;
}>;

type ExportAuditIdentity = Readonly<{
  eventId: AuditEvent["id"];
  operationId: AuditEvent["operationId"];
}>;

export function createOwnerReviewExportService(
  dependencies: OwnerReviewExportDependencies,
): OwnerReviewExportService {
  const limits = parseLimits(dependencies.limits);
  const now = dependencies.now ?? (() => new Date());

  async function create(
    request: OwnerReviewExportRequest,
    exportType: ExportCreatedAuditDetail["exportType"],
  ): Promise<AuditedOwnerReviewExport> {
    requireGuaranteedAudit(dependencies.audit);
    const ownerSubject = requiredOwnerSubject(request.ownerSubject);
    const operationId = requiredOperationId(request.operationId);
    const sourceUrl = requiredSourceUrl(request.sourceUrl);
    const auditIdentity = await deriveAuditIdentity(
      ownerSubject,
      operationId,
      exportType,
      sourceUrl,
    );
    const priorAudit = await readPriorAudit(
      dependencies.audit,
      auditIdentity,
      ownerSubject,
      exportType,
    );
    if (priorAudit !== null) {
      throw new OwnerReviewExportFailure("STALE_OPERATION");
    }
    const occurredAt = currentTimestamp(now);
    const encoded = exportType === "review-csv"
      ? await encodeReviewCsv(dependencies.records, limits)
      : await encodeJsonBackup(
          dependencies,
          sourceUrl,
          occurredAt,
          limits,
        );
    const auditEvent = await appendVerifiedExportAudit(
      dependencies.audit,
      auditIdentity,
      exportType,
      ownerSubject,
      occurredAt,
    );

    return Object.freeze({
      exportType,
      filename: exportType === "review-csv"
        ? "investor-review.csv"
        : "investor-backup.json",
      contentType: exportType === "review-csv"
        ? "text/csv; charset=utf-8"
        : "application/json; charset=utf-8",
      chunks: encoded.chunks,
      byteLength: encoded.byteLength,
      auditEvent,
    });
  }

  return Object.freeze({
    limits,
    createReviewCsv: (request: OwnerReviewExportRequest) =>
      create(request, "review-csv"),
    createJsonBackup: (request: OwnerReviewExportRequest) =>
      create(request, "json-backup"),
  });
}

async function visitPages<Item>(
  list: (
    request: OwnerReviewExportPageRequest,
  ) => Promise<OwnerReviewExportPage<Item>>,
  limits: OwnerReviewExportLimits,
  counter: { value: number },
  visit: (item: Item) => void,
): Promise<void> {
  const seenCursors = new Set<string>();
  let cursor: StorageCursor | undefined;

  while (true) {
    const remaining = limits.maxRows - counter.value;
    const limit = Math.min(limits.pageSize, Math.max(1, remaining + 1));
    const request: OwnerReviewExportPageRequest = {
      limit,
      maxRecordBytes: limits.maxRecordBytes,
      maxHistoryEntries: limits.maxHistoryEntries,
      ...(cursor === undefined ? {} : { cursor }),
    };
    let page: OwnerReviewExportPage<Item>;
    try {
      page = await list(request);
    } catch {
      throw new OwnerReviewExportFailure("UNAVAILABLE");
    }
    if (
      !page ||
      !Array.isArray(page.items) ||
      page.items.length > limit ||
      (page.nextCursor !== null &&
        (typeof page.nextCursor !== "string" ||
          page.nextCursor.length === 0 ||
          page.nextCursor.length > 512))
    ) {
      throw new OwnerReviewExportFailure("UNAVAILABLE");
    }

    for (const item of page.items) {
      if (counter.value >= limits.maxRows) {
        throw new OwnerReviewExportFailure("LIMIT_EXCEEDED");
      }
      visit(item);
      counter.value += 1;
    }

    if (page.nextCursor === null) return;
    if (page.items.length === 0 || seenCursors.has(page.nextCursor)) {
      throw new OwnerReviewExportFailure("UNAVAILABLE");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

async function encodeReviewCsv(
  records: OwnerReviewExportDataReader,
  limits: OwnerReviewExportLimits,
): Promise<EncodedExport> {
  const output = new ExportChunkCollector(limits.maxBytes);
  appendCsvRow(output, OWNER_REVIEW_CSV_COLUMNS, limits.maxRecordBytes);
  const counter = { value: 0 };
  await visitPages(
    records.listParticipantProfiles.bind(records),
    limits,
    counter,
    (profile) => appendCsvRow(
      output,
      participantCsvRow(profile),
      limits.maxRecordBytes,
    ),
  );
  await visitPages(
    records.listInvestmentIndications.bind(records),
    limits,
    counter,
    (indication) => {
      assertHistoryBound(indication.history, limits.maxHistoryEntries);
      appendCsvRow(
        output,
        indicationCsvRow(indication),
        limits.maxRecordBytes,
      );
    },
  );
  await visitPages(
    records.listFounderApplications.bind(records),
    limits,
    counter,
    (application) => {
      assertHistoryBound(application.history, limits.maxHistoryEntries);
      appendCsvRow(
        output,
        founderCsvRow(application, limits.maxRecordBytes),
        limits.maxRecordBytes,
      );
    },
  );
  return output.finish();
}

async function encodeJsonBackup(
  dependencies: OwnerReviewExportDependencies,
  sourceUrl: string,
  exportedAt: Timestamp,
  limits: OwnerReviewExportLimits,
): Promise<EncodedExport> {
  const output = new ExportChunkCollector(limits.maxBytes);
  output.appendText("{\"schema_version\":");
  output.appendJsonValue(
    OWNER_REVIEW_EXPORT_SCHEMA_VERSION,
    limits.maxRecordBytes,
  );
  output.appendText(",\"type\":\"owner-review-backup\",\"exported_at\":");
  output.appendJsonValue(exportedAt, limits.maxRecordBytes);
  output.appendText(",\"source_url\":");
  output.appendJsonValue(sourceUrl, limits.maxRecordBytes);

  output.appendText(",\"campaign\":");
  output.appendJsonValue(
    projectCampaign(await safeRead(() => dependencies.campaign.readSetup())),
    limits.maxRecordBytes,
  );
  output.appendText(",\"current_package\":");
  output.appendJsonValue(
    projectPackage(await safeRead(() => dependencies.content.current())),
    limits.maxRecordBytes,
  );

  const counter = { value: 0 };
  output.appendText(",\"participant_profiles\":[");
  let first = true;
  await visitPages(
    dependencies.records.listParticipantProfiles.bind(dependencies.records),
    limits,
    counter,
    (profile) => {
      if (!first) output.appendText(",");
      output.appendJsonValue(projectParticipant(profile), limits.maxRecordBytes);
      first = false;
    },
  );
  output.appendText("],\"investment_indications\":[");
  first = true;
  await visitPages(
    dependencies.records.listInvestmentIndications.bind(dependencies.records),
    limits,
    counter,
    (indication) => {
      assertHistoryBound(indication.history, limits.maxHistoryEntries);
      if (!first) output.appendText(",");
      output.appendJsonValue(projectIndication(indication), limits.maxRecordBytes);
      first = false;
    },
  );
  output.appendText("],\"founder_applications\":[");
  first = true;
  await visitPages(
    dependencies.records.listFounderApplications.bind(dependencies.records),
    limits,
    counter,
    (application) => {
      assertHistoryBound(application.history, limits.maxHistoryEntries);
      if (!first) output.appendText(",");
      output.appendJsonValue(projectFounder(application), limits.maxRecordBytes);
      first = false;
    },
  );
  output.appendText("],\"aggregate\":");
  const aggregate = await safeRead(() => dependencies.aggregate.readStored());
  output.appendJsonValue(projectAggregate(aggregate), limits.maxRecordBytes);
  output.appendText("}\n");
  return output.finish();
}

function participantCsvRow(profile: ParticipantProfileSnapshot): CsvRow {
  const value = profile.snapshot;
  return [
    "participant",
    null,
    value.subject,
    profile.revision,
    value.accountDeletionRequest.state === "requested"
      ? "deletion-requested"
      : "registered",
    value.registeredAt,
    value.updatedAt,
    value.displayName,
    value.accountEmailLabel,
    value.country,
    value.declaredInterest,
    value.participationContext,
    value.marketingConsent.state,
    value.accountDeletionRequest.state === "requested"
      ? value.accountDeletionRequest.requestedAt
      : null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ];
}

function indicationCsvRow(indication: InvestmentIndication): CsvRow {
  const fields = indication.fields;
  return [
    "investment-indication",
    indication.id,
    indication.participantSubject,
    indication.revision,
    indication.lifecycle.status,
    indication.createdAt,
    indication.updatedAt,
    null,
    null,
    fields.kind === "personal"
      ? fields.residenceCountry
      : fields.registrationCountry,
    null,
    null,
    null,
    null,
    fields.kind,
    fields.amount,
    fields.currency,
    fields.availabilityPeriod,
    fields.kind === "company" ? fields.companyName : null,
    fields.kind === "company" ? fields.companyIdentifier : null,
    fields.kind === "company" ? fields.representativeName : null,
    fields.kind === "company" ? fields.representativeAuthorityDeclared : null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    fields.note,
    indication.lifecycle.status === "rejected"
      ? indication.lifecycle.rejection.reason
      : null,
    indication.acknowledgment.acceptedVersionId,
  ];
}

function founderCsvRow(
  application: FounderApplication,
  maximumRecordBytes: number,
): CsvRow {
  const fields = application.fields;
  return [
    "founder-application",
    application.id,
    application.applicantSubject,
    application.revision,
    application.status,
    application.createdAt,
    application.updatedAt,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    fields.expertiseSummary,
    fields.intendedContribution,
    fields.primaryContributionAreaId,
    boundedJsonText(fields.secondaryContributionAreaIds, maximumRecordBytes),
    fields.approximateAvailability,
    fields.possibleStartTiming,
    fields.compensationExpectation,
    boundedJsonText(fields.professionalProfileLinks, maximumRecordBytes),
    fields.note,
    null,
    null,
  ];
}

function boundedJsonText(value: unknown, maximumBytes: number): string {
  const writer = new BoundedTextWriter(maximumBytes);
  writeJsonValue(writer, value, new Set<object>(), 0);
  return new TextDecoder().decode(writer.finish());
}

/** Quote every CSV cell and neutralize spreadsheet formula prefixes. */
export function encodeCsvCell(value: CsvValue): string {
  const writer = new BoundedTextWriter(
    DEFAULT_OWNER_REVIEW_EXPORT_LIMITS.maxRecordBytes,
  );
  appendCsvCell(writer, value);
  return new TextDecoder().decode(writer.finish());
}

class ExportChunkCollector {
  readonly #maximum: number;
  readonly #chunks: Uint8Array[] = [];
  #byteLength = 0;

  constructor(maximum: number) {
    this.#maximum = maximum;
  }

  get remainingBytes(): number {
    return this.#maximum - this.#byteLength;
  }

  appendText(value: string): void {
    const writer = new BoundedTextWriter(this.#maximum - this.#byteLength);
    writer.append(value);
    this.appendChunk(writer.finish());
  }

  appendJsonValue(value: unknown, maximumRecordBytes: number): void {
    const writer = new BoundedTextWriter(
      Math.min(maximumRecordBytes, this.remainingBytes),
    );
    writeJsonValue(writer, value, new Set<object>(), 0);
    this.appendChunk(writer.finish());
  }

  appendChunk(chunk: Uint8Array): void {
    if (
      chunk.byteLength > this.#maximum - this.#byteLength ||
      !Number.isSafeInteger(this.#byteLength + chunk.byteLength)
    ) {
      throw new OwnerReviewExportFailure("LIMIT_EXCEEDED");
    }
    this.#chunks.push(chunk);
    this.#byteLength += chunk.byteLength;
  }

  finish(): EncodedExport {
    return Object.freeze({
      chunks: Object.freeze([...this.#chunks]),
      byteLength: this.#byteLength,
    });
  }
}

class BoundedTextWriter {
  static readonly #FLUSH_BYTES = 8 * 1024;
  static readonly #FLUSH_PARTS = 256;

  readonly #maximum: number;
  readonly #encoder = new TextEncoder();
  readonly #encoded: Uint8Array[] = [];
  readonly #pending: string[] = [];
  #byteLength = 0;
  #pendingBytes = 0;

  constructor(maximum: number) {
    this.#maximum = maximum;
  }

  get remainingBytes(): number {
    return this.#maximum - this.#byteLength;
  }

  append(value: string): void {
    const bytes = utf8ByteLength(value, this.remainingBytes);
    this.#pending.push(value);
    this.#pendingBytes += bytes;
    this.#byteLength += bytes;
    if (
      this.#pendingBytes >= BoundedTextWriter.#FLUSH_BYTES ||
      this.#pending.length >= BoundedTextWriter.#FLUSH_PARTS
    ) {
      this.#flush();
    }
  }

  finish(): Uint8Array {
    this.#flush();
    const merged = new Uint8Array(this.#byteLength);
    let offset = 0;
    for (const chunk of this.#encoded) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== this.#byteLength) unavailable();
    return merged;
  }

  #flush(): void {
    if (this.#pending.length === 0) return;
    const value = this.#pending.join("");
    const encoded = this.#encoder.encode(value);
    if (encoded.byteLength !== this.#pendingBytes) unavailable();
    this.#encoded.push(encoded);
    this.#pending.length = 0;
    this.#pendingBytes = 0;
  }
}

function appendCsvRow(
  output: ExportChunkCollector,
  row: CsvRow,
  maximumRecordBytes: number,
): void {
  if (row.length !== OWNER_REVIEW_CSV_COLUMNS.length) unavailable();
  const writer = new BoundedTextWriter(
    Math.min(maximumRecordBytes, output.remainingBytes),
  );
  for (const [index, value] of row.entries()) {
    if (index > 0) writer.append(",");
    appendCsvCell(writer, value);
  }
  writer.append("\r\n");
  output.appendChunk(writer.finish());
}

function appendCsvCell(writer: BoundedTextWriter, value: CsvValue): void {
  const serialized = csvValueText(value);
  writer.append('"');
  if (startsWithSpreadsheetFormula(
    serialized,
    Math.max(0, writer.remainingBytes - 1),
  )) {
    writer.append("'");
  }
  let start = 0;
  let index = 0;
  while (index < serialized.length) {
    const code = serialized.charCodeAt(index);
    if (code === 0x22) {
      if (index > start) writer.append(serialized.slice(start, index));
      writer.append('""');
      index += 1;
      start = index;
      continue;
    }
    index += utf16CodeUnitsAt(serialized, index, code);
    if (stringProjectionSegmentIsFull(writer, index - start)) {
      writer.append(serialized.slice(start, index));
      start = index;
    }
  }
  if (start < serialized.length) writer.append(serialized.slice(start));
  writer.append('"');
}

function csvValueText(value: CsvValue): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  unavailable();
}

function startsWithSpreadsheetFormula(
  value: string,
  maximumBytes: number,
): boolean {
  let bytes = 0;
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    const codeUnits = utf16CodeUnitsAt(value, index, code);
    const width = utf8Width(code, codeUnits);
    if (width > maximumBytes - bytes) {
      throw new OwnerReviewExportFailure("LIMIT_EXCEEDED");
    }
    bytes += width;
    const character = value.slice(index, index + codeUnits);
    if (!/\s/u.test(character)) {
      return character === "=" || character === "+" ||
        character === "-" || character === "@";
    }
    index += codeUnits;
  }
  return false;
}

const STRING_PROJECTION_CHUNK_CODE_UNITS = 256;

function stringProjectionSegmentIsFull(
  writer: BoundedTextWriter,
  codeUnits: number,
): boolean {
  return codeUnits >= Math.min(
    STRING_PROJECTION_CHUNK_CODE_UNITS,
    writer.remainingBytes + 1,
  );
}

function writeJsonValue(
  writer: BoundedTextWriter,
  value: unknown,
  ancestors: Set<object>,
  depth: number,
): void {
  if (depth > 32) unavailable();
  if (value === null) {
    writer.append("null");
    return;
  }
  if (typeof value === "string") {
    writeJsonString(writer, value);
    return;
  }
  if (typeof value === "boolean") {
    writer.append(value ? "true" : "false");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) unavailable();
    writer.append(String(value));
    return;
  }
  if (typeof value !== "object") unavailable();
  if (ancestors.has(value)) unavailable();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      writer.append("[");
      for (const [index, item] of value.entries()) {
        if (index > 0) writer.append(",");
        writeJsonValue(
          writer,
          item === undefined ? null : item,
          ancestors,
          depth + 1,
        );
      }
      writer.append("]");
      return;
    }

    writer.append("{");
    let first = true;
    for (const key of Object.keys(value)) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      if (!first) writer.append(",");
      writeJsonString(writer, key);
      writer.append(":");
      writeJsonValue(writer, item, ancestors, depth + 1);
      first = false;
    }
    writer.append("}");
  } finally {
    ancestors.delete(value);
  }
}

function writeJsonString(writer: BoundedTextWriter, value: string): void {
  writer.append('"');
  let start = 0;
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    let escaped: string | null = null;
    if (code === 0x22) escaped = '\\"';
    else if (code === 0x5c) escaped = "\\\\";
    else if (code === 0x08) escaped = "\\b";
    else if (code === 0x0c) escaped = "\\f";
    else if (code === 0x0a) escaped = "\\n";
    else if (code === 0x0d) escaped = "\\r";
    else if (code === 0x09) escaped = "\\t";
    else if (code < 0x20 || isUnpairedSurrogate(value, index, code)) {
      escaped = `\\u${code.toString(16).padStart(4, "0")}`;
    }
    if (escaped !== null) {
      if (index > start) writer.append(value.slice(start, index));
      writer.append(escaped);
      index += 1;
      start = index;
      continue;
    }
    index += utf16CodeUnitsAt(value, index, code);
    if (stringProjectionSegmentIsFull(writer, index - start)) {
      writer.append(value.slice(start, index));
      start = index;
    }
  }
  if (start < value.length) writer.append(value.slice(start));
  writer.append('"');
}

function isUnpairedSurrogate(
  value: string,
  index: number,
  code: number,
): boolean {
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = value.charCodeAt(index + 1);
    return !(next >= 0xdc00 && next <= 0xdfff);
  }
  if (code >= 0xdc00 && code <= 0xdfff) {
    const previous = value.charCodeAt(index - 1);
    return !(previous >= 0xd800 && previous <= 0xdbff);
  }
  return false;
}

function utf8ByteLength(value: string, maximumBytes: number): number {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new OwnerReviewExportFailure("LIMIT_EXCEEDED");
  }
  let bytes = 0;
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    const codeUnits = utf16CodeUnitsAt(value, index, code);
    const width = utf8Width(code, codeUnits);
    if (width > maximumBytes - bytes) {
      throw new OwnerReviewExportFailure("LIMIT_EXCEEDED");
    }
    bytes += width;
    index += codeUnits;
  }
  return bytes;
}

function utf16CodeUnitsAt(
  value: string,
  index: number,
  code: number,
): 1 | 2 {
  if (code < 0xd800 || code > 0xdbff) return 1;
  const next = value.charCodeAt(index + 1);
  return next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
}

function utf8Width(code: number, codeUnits: 1 | 2): 1 | 2 | 3 | 4 {
  if (code <= 0x7f) return 1;
  if (code <= 0x7ff) return 2;
  return codeUnits === 2 ? 4 : 3;
}

function assertHistoryBound(
  history: readonly unknown[],
  maximum: number,
): void {
  if (!Array.isArray(history)) unavailable();
  if (history.length > maximum) {
    throw new OwnerReviewExportFailure("LIMIT_EXCEEDED");
  }
}

async function safeRead<Value>(read: () => Promise<Value>): Promise<Value> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof OwnerReviewExportFailure) throw error;
    throw new OwnerReviewExportFailure("UNAVAILABLE");
  }
}

function projectCampaign(campaign: CampaignSetupRevision | null) {
  if (campaign === null) return null;
  return {
    revision: campaign.revision,
    recorded_at: campaign.recordedAt,
    public_campaign: campaign.setup.publicCampaign,
    phases: campaign.setup.phases.map((phase) => ({
      id: phase.id,
      state: phase.state,
      enabled_participation_paths: phase.enabledParticipationPaths,
      country_eligibility: {
        mode: phase.countryEligibility.mode,
        countries: phase.countryEligibility.countries,
      },
    })),
    amount_aggregate: {
      amount: {
        currency: campaign.setup.amountAggregate.amount.currency,
        minimum: campaign.setup.amountAggregate.amount.minimum,
        increment: campaign.setup.amountAggregate.amount.increment,
        maximum: campaign.setup.amountAggregate.amount.maximum,
      },
      public_aggregate: campaign.setup.amountAggregate.publicAggregate,
    },
  };
}

function projectPackage(
  currentPackage: RevisionedSnapshot<PackageVersion> | null,
) {
  if (currentPackage === null) return null;
  const version = currentPackage.snapshot;
  return {
    revision: currentPackage.revision,
    version: {
      id: version.id,
      created_at: version.createdAt,
      change_summary: version.changeSummary,
      material_change: version.materialChange,
      acknowledgment_text: version.acknowledgmentText,
      content_hash: version.contentHash,
      required_acceptance_hash: version.requiredAcceptanceHash,
      sections: version.sections.map((section) => ({
        id: section.id,
        order: section.order,
        title: section.title,
        markdown: section.markdown,
        enabled: section.enabled,
      })),
    },
  };
}

function projectAggregate(aggregate: StoredInvestmentAggregateSnapshot) {
  return {
    revision: aggregate.revision,
    total_amount_minor_units: aggregate.totalAmount,
    currency: aggregate.currency,
    contributing_indication_count: aggregate.contributingIndicationCount,
  };
}

function projectParticipant(profile: ParticipantProfileSnapshot) {
  const value = profile.snapshot;
  return {
    revision: profile.revision,
    profile: {
      subject: value.subject,
      account_email_label: value.accountEmailLabel,
      display_name: value.displayName,
      country: value.country,
      declared_interest: value.declaredInterest,
      participation_context: value.participationContext,
      process_email_notice_acknowledged_at:
        value.processEmailNoticeAcknowledgedAt,
      marketing_consent: projectMarketingConsent(value),
      account_deletion_request: value.accountDeletionRequest.state === "requested"
        ? {
            state: "requested",
            requested_at: value.accountDeletionRequest.requestedAt,
            active_interest_disposition:
              value.accountDeletionRequest.activeInterestDisposition,
          }
        : { state: "not-requested" },
      registered_at: value.registeredAt,
      updated_at: value.updatedAt,
    },
  };
}

function projectMarketingConsent(profile: ParticipantProfile) {
  if (profile.marketingConsent.state === "granted") {
    return {
      state: "granted",
      granted_at: profile.marketingConsent.grantedAt,
    };
  }
  if (profile.marketingConsent.state === "withdrawn") {
    return {
      state: "withdrawn",
      granted_at: profile.marketingConsent.grantedAt ?? null,
      withdrawn_at: profile.marketingConsent.withdrawnAt,
    };
  }
  return { state: "not-granted" };
}

function projectIndication(indication: InvestmentIndication) {
  return {
    id: indication.id,
    participant_subject: indication.participantSubject,
    kind: indication.kind,
    fields: projectIndicationFields(indication.fields),
    acknowledgment: projectAcceptance(indication.acknowledgment),
    lifecycle: indication.lifecycle.status === "rejected"
      ? {
          status: "rejected",
          activated_at: indication.lifecycle.activatedAt,
          withdrawn_at: null,
          rejected_at: indication.lifecycle.rejectedAt,
          rejection: {
            reason: indication.lifecycle.rejection.reason,
            rejected_at: indication.lifecycle.rejection.rejectedAt,
            rejected_by: {
              type: "owner",
              subject: indication.lifecycle.rejection.rejectedBy.subject,
            },
          },
        }
      : {
          status: indication.lifecycle.status,
          activated_at: indication.lifecycle.activatedAt,
          withdrawn_at: indication.lifecycle.withdrawnAt,
          rejected_at: null,
          rejection: null,
        },
    created_at: indication.createdAt,
    updated_at: indication.updatedAt,
    revision: indication.revision,
    history: indication.history.map((entry) => ({
      id: entry.id,
      indication_id: entry.indicationId,
      occurred_at: entry.occurredAt,
      revision: entry.revision,
      transition: entry.transition,
      status: entry.status,
      actor: { type: entry.actor.type, subject: entry.actor.subject },
      fields: projectIndicationFields(entry.fields),
      acknowledgment: projectAcceptance(entry.acknowledgment),
      rejection: entry.rejection === null
        ? null
        : {
            reason: entry.rejection.reason,
            rejected_at: entry.rejection.rejectedAt,
            rejected_by: {
              type: "owner",
              subject: entry.rejection.rejectedBy.subject,
            },
          },
    })),
  };
}

function projectIndicationFields(fields: InvestmentIndicationFields) {
  if (fields.kind === "personal") {
    return {
      kind: "personal",
      residence_country: fields.residenceCountry,
      amount_minor_units: fields.amount,
      currency: fields.currency,
      availability_period: fields.availabilityPeriod,
      note: fields.note,
    };
  }
  return {
    kind: "company",
    company_name: fields.companyName,
    registration_country: fields.registrationCountry,
    company_identifier: fields.companyIdentifier,
    representative_name: fields.representativeName,
    representative_authority_declared:
      fields.representativeAuthorityDeclared,
    amount_minor_units: fields.amount,
    currency: fields.currency,
    availability_period: fields.availabilityPeriod,
    note: fields.note,
  };
}

function projectAcceptance(acceptance: PackageAcceptanceRecord) {
  return {
    id: acceptance.id,
    participant_subject: acceptance.participantSubject,
    accepted_at: acceptance.acceptedAt,
    accepted_version_id: acceptance.acceptedVersionId,
    accepted_content_hash: acceptance.acceptedContentHash,
    satisfied_requirement_hash: acceptance.satisfiedRequirementHash,
  };
}

function projectFounder(application: FounderApplication) {
  return {
    id: application.id,
    applicant_subject: application.applicantSubject,
    status: application.status,
    fields: projectFounderFields(application.fields),
    created_at: application.createdAt,
    updated_at: application.updatedAt,
    withdrawn_at: application.withdrawnAt,
    revision: application.revision,
    history: application.history.map((entry) => ({
      id: entry.id,
      application_id: entry.applicationId,
      applicant_subject: entry.applicantSubject,
      occurred_at: entry.occurredAt,
      revision: entry.revision,
      kind: entry.kind,
      status: entry.status,
      fields: projectFounderFields(entry.fields),
    })),
  };
}

function projectFounderFields(fields: FounderApplication["fields"]) {
  return {
    expertise_summary: fields.expertiseSummary,
    intended_contribution: fields.intendedContribution,
    primary_contribution_area_id: fields.primaryContributionAreaId,
    secondary_contribution_area_ids: fields.secondaryContributionAreaIds,
    approximate_availability: fields.approximateAvailability,
    possible_start_timing: fields.possibleStartTiming,
    compensation_expectation: fields.compensationExpectation,
    professional_profile_links: fields.professionalProfileLinks,
    note: fields.note,
  };
}

async function appendVerifiedExportAudit(
  audit: GuaranteedAuditAppendRepository,
  identity: ExportAuditIdentity,
  exportType: ExportCreatedAuditDetail["exportType"],
  ownerSubject: ActorSubject,
  occurredAt: Timestamp,
): Promise<AuditEvent> {
  const event: AuditEvent = Object.freeze({
    id: identity.eventId,
    operationId: identity.operationId,
    occurredAt,
    actor: Object.freeze({ type: "owner", subject: ownerSubject }),
    detail: Object.freeze({ kind: "export-created", exportType }),
  });

  try {
    const result = await audit.append({
      type: "append-audit-event",
      event,
    });
    if (!sameAuditEvent(result.event, event)) {
      throw new OwnerReviewExportFailure("UNAVAILABLE");
    }
    if (result.replayed) {
      throw new OwnerReviewExportFailure("STALE_OPERATION");
    }
    return result.event;
  } catch (error) {
    if (error instanceof OwnerReviewExportFailure) throw error;
    throw new OwnerReviewExportFailure("UNAVAILABLE");
  }
}

async function readPriorAudit(
  audit: GuaranteedAuditAppendRepository,
  identity: ExportAuditIdentity,
  ownerSubject: ActorSubject,
  exportType: ExportCreatedAuditDetail["exportType"],
): Promise<AuditEvent | null> {
  let event: AuditEvent | null;
  try {
    event = await audit.get(identity.eventId);
  } catch {
    throw new OwnerReviewExportFailure("UNAVAILABLE");
  }
  if (event === null) return null;
  const expected: AuditEvent = Object.freeze({
    id: identity.eventId,
    operationId: identity.operationId,
    occurredAt: event.occurredAt,
    actor: Object.freeze({ type: "owner", subject: ownerSubject }),
    detail: Object.freeze({ kind: "export-created", exportType }),
  });
  if (!sameAuditEvent(event, expected)) unavailable();
  return event;
}

async function deriveAuditIdentity(
  ownerSubject: ActorSubject,
  operationId: StorageOperationId,
  exportType: ExportCreatedAuditDetail["exportType"],
  sourceUrl: string,
): Promise<ExportAuditIdentity> {
  const digest = await sha256Hex(
    `owner-review-export\u0000${ownerSubject}\u0000${operationId}\u0000${exportType}\u0000${sourceUrl}`,
  );
  const eventId = parseStableId<"audit-event">(
    `audit-event:owner-export:${digest}`,
  );
  const auditOperationId = parseStableId<"audit-operation">(
    `audit-operation:owner-export:${digest}`,
  );
  if (!eventId.ok || !auditOperationId.ok) unavailable();
  return Object.freeze({
    eventId: eventId.value,
    operationId: auditOperationId.value,
  });
}

async function sha256Hex(value: string): Promise<string> {
  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
  } catch {
    unavailable();
  }
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sameAuditEvent(left: AuditEvent, right: AuditEvent): boolean {
  return left.id === right.id &&
    left.operationId === right.operationId &&
    left.occurredAt === right.occurredAt &&
    left.actor.type === "owner" &&
    right.actor.type === "owner" &&
    left.actor.subject === right.actor.subject &&
    left.detail.kind === "export-created" &&
    right.detail.kind === "export-created" &&
    left.detail.exportType === right.detail.exportType;
}

function requireGuaranteedAudit(
  audit: GuaranteedAuditAppendRepository,
): void {
  if (audit.appendConsistency !== "atomic-immutable-audit") {
    throw new OwnerReviewExportFailure("UNAVAILABLE");
  }
}

function requiredOwnerSubject(value: unknown): ActorSubject {
  const parsed = parseActorSubject(value);
  if (!parsed.ok) throw new OwnerReviewExportFailure("UNAVAILABLE");
  return parsed.value;
}

function requiredOperationId(value: unknown): StorageOperationId {
  const parsed = parseStorageOperationId(value);
  if (!parsed.ok) throw new OwnerReviewExportFailure("UNAVAILABLE");
  return parsed.value;
}

function requiredSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      throw new Error("invalid source URL");
    }
    return url.href;
  } catch {
    throw new OwnerReviewExportFailure("UNAVAILABLE");
  }
}

function currentTimestamp(now: () => Date): Timestamp {
  try {
    const value = now();
    const parsed = parseTimestamp(value.toISOString());
    if (!parsed.ok) throw new Error("invalid clock");
    return parsed.value;
  } catch {
    throw new OwnerReviewExportFailure("UNAVAILABLE");
  }
}

function parseLimits(
  overrides: Partial<OwnerReviewExportLimits> | undefined,
): OwnerReviewExportLimits {
  const limits = {
    ...DEFAULT_OWNER_REVIEW_EXPORT_LIMITS,
    ...overrides,
  };
  if (
    !Number.isSafeInteger(limits.maxRows) ||
    limits.maxRows < 1 ||
    limits.maxRows > 100_000 ||
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 1 ||
    limits.maxBytes > 16 * 1024 * 1024 ||
    !Number.isSafeInteger(limits.maxRecordBytes) ||
    limits.maxRecordBytes < 1 ||
    limits.maxRecordBytes > 4 * 1024 * 1024 ||
    !Number.isSafeInteger(limits.maxHistoryEntries) ||
    limits.maxHistoryEntries < 1 ||
    limits.maxHistoryEntries > 256 ||
    !Number.isSafeInteger(limits.pageSize) ||
    limits.pageSize < 1 ||
    limits.pageSize > 10
  ) {
    throw new OwnerReviewExportFailure("UNAVAILABLE");
  }
  return Object.freeze(limits);
}

function unavailable(): never {
  throw new OwnerReviewExportFailure("UNAVAILABLE");
}
