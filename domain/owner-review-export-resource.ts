import {
  currentActions,
  defineAction,
  toHtmlFormAction,
  toHypermediaAction,
  type HtmlFormAction,
} from "./hypermedia-action.ts";
import {
  INVESTOR_APP_API_VERSION,
  type HypermediaAction,
  type HypermediaLink,
} from "./public-campaign-resource.ts";

export const OWNER_REVIEW_EXPORTS_PATH = "/owner/exports";
export const OWNER_REVIEW_CSV_PATH = "/owner/exports/review.csv";
export const OWNER_REVIEW_JSON_BACKUP_PATH = "/owner/exports/backup.json";

export type OwnerReviewExportsDocument = Readonly<{
  api_version: typeof INVESTOR_APP_API_VERSION;
  type: "owner-review-exports";
  id: "owner-review-exports";
  data: Readonly<{
    sensitivity: "private";
    retention: "streamed-not-retained";
    receipt_semantics: "generated-not-delivered";
    maximum_rows: number;
    maximum_bytes: number;
    maximum_record_bytes: number;
    maximum_history_entries: number;
  }>;
  links: readonly HypermediaLink[];
  actions: readonly HypermediaAction[];
}>;

export type OwnerReviewExportsResource = Readonly<{
  document: OwnerReviewExportsDocument;
  reviewCsvForm: HtmlFormAction;
  jsonBackupForm: HtmlFormAction;
}>;

export function createOwnerReviewExportsResource(
  requestUrl: string,
  limits: Readonly<{
    maxRows: number;
    maxBytes: number;
    maxRecordBytes: number;
    maxHistoryEntries: number;
  }>,
  operationIds: Readonly<{
    reviewCsv: string;
    jsonBackup: string;
  }>,
): OwnerReviewExportsResource {
  const self = new URL(requestUrl);
  const reviewCsv = exportAction(
    "download-review-csv",
    "Download review CSV",
    new URL(OWNER_REVIEW_CSV_PATH, self).href,
    operationIds.reviewCsv,
  );
  const jsonBackup = exportAction(
    "download-json-backup",
    "Download JSON backup",
    new URL(OWNER_REVIEW_JSON_BACKUP_PATH, self).href,
    operationIds.jsonBackup,
  );
  const actions = currentActions(reviewCsv, jsonBackup);

  return deepFreeze({
    document: {
      api_version: INVESTOR_APP_API_VERSION,
      type: "owner-review-exports",
      id: "owner-review-exports",
      data: {
        sensitivity: "private",
        retention: "streamed-not-retained",
        receipt_semantics: "generated-not-delivered",
        maximum_rows: limits.maxRows,
        maximum_bytes: limits.maxBytes,
        maximum_record_bytes: limits.maxRecordBytes,
        maximum_history_entries: limits.maxHistoryEntries,
      },
      links: [
        { rel: ["self"], href: new URL(OWNER_REVIEW_EXPORTS_PATH, self).href },
        { rel: ["owner"], href: new URL("/owner", self).href },
      ],
      actions: actions.map(toHypermediaAction),
    },
    reviewCsvForm: toHtmlFormAction(reviewCsv),
    jsonBackupForm: toHtmlFormAction(jsonBackup),
  });
}

function exportAction(
  name: string,
  title: string,
  href: string,
  operationId: string,
) {
  return defineAction({
    name,
    title,
    method: "POST",
    href,
    requestMediaType: "application/x-www-form-urlencoded",
    fields: [{
      name: "operation-id",
      title: "Operation ID",
      type: "string",
      format: "text",
      location: "body",
      required: true,
      presentation: "hidden",
      minLength: 1,
      maxLength: 128,
      maxBytes: 128,
      value: operationId,
    }],
  });
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
