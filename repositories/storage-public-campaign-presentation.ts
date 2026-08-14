import {
  parseAmountAggregateConfiguration,
  type AmountAggregateConfiguration,
} from "../domain/amount-aggregate-configuration.ts";
import {
  parsePublicCampaignConfiguration,
  type PublicCampaignConfiguration,
} from "../domain/public-campaign-configuration.ts";
import {
  StorageFailure,
  parseStorageKey,
  type StorageAdapter,
  type StorageDocument,
  type StorageKey,
  type StoragePutMutation,
  type StorageRecord,
} from "../domain/storage-adapter.ts";

const LEGACY_PUBLIC_PRESENTATION_SCHEMA_VERSION = 4;
const PUBLIC_PRESENTATION_SCHEMA_VERSION = 5;
const LEGACY_PUBLIC_PRESENTATION_KEYS = new Set([
  "kind",
  "schemaVersion",
  "revision",
  "publicCampaign",
]);
const PUBLIC_PRESENTATION_KEYS = new Set([
  ...LEGACY_PUBLIC_PRESENTATION_KEYS,
  "amountAggregate",
]);

/** Exact storage location of the separately persisted public presentation. */
export const PUBLIC_CAMPAIGN_PRESENTATION_KEY = storageKey(
  "campaign-public-presentation",
  "configured-campaign",
);

/** Public-only projection contract; implementations must not return setup data. */
export interface PublicCampaignPresentationReader {
  readPublishedCampaign(): Promise<PublicCampaignConfiguration | null>;
}

/** Public campaign and aggregate policy captured by one published revision. */
export type PublishedCampaignProjection = Readonly<{
  revision: number;
  publicCampaign: PublicCampaignConfiguration;
  amountAggregate: AmountAggregateConfiguration | null;
}>;

/** Public-only projection contract used to bind totals to published policy. */
export interface PublishedCampaignProjectionReader {
  readPublishedProjection(): Promise<PublishedCampaignProjection | null>;
}

/** Schema 4 is retained only to verify exact retries committed before schema 5. */
export type PublicCampaignPresentationSchema = "legacy" | "current";

/** Validated public data atomically written with a campaign setup revision. */
export type PublicCampaignPresentation = Readonly<{
  revision: number;
  publicCampaign: PublicCampaignConfiguration;
  amountAggregate: AmountAggregateConfiguration;
}>;

/** Reader bound only to the separately stored public campaign projection. */
export class StoragePublicCampaignPresentationReader
  implements
    PublicCampaignPresentationReader,
    PublishedCampaignProjectionReader {
  readonly #read: Pick<StorageAdapter, "read">["read"];

  constructor(storage: Pick<StorageAdapter, "read">) {
    this.#read = storage.read.bind(storage);
  }

  async readPublishedCampaign(): Promise<PublicCampaignConfiguration | null> {
    return (await this.readPublishedProjection())?.publicCampaign ?? null;
  }

  async readPublishedProjection(): Promise<PublishedCampaignProjection | null> {
    const record = await this.#read(PUBLIC_CAMPAIGN_PRESENTATION_KEY);
    if (record === null) return null;
    const projection = decodePublicCampaignPresentation(record);
    return projection.publicCampaign.published ? projection : null;
  }
}

/** Builds the public presentation mutation committed with a campaign revision. */
export function publicCampaignPresentationMutation(
  presentation: PublicCampaignPresentation,
  expectedRevision: number | null,
  schema: PublicCampaignPresentationSchema,
): StoragePutMutation {
  return Object.freeze({
    type: "put" as const,
    key: PUBLIC_CAMPAIGN_PRESENTATION_KEY,
    expectedRevision,
    value: encodePublicCampaignPresentation(presentation, schema),
  });
}

/** Serializes the exact schema-4 or schema-5 public presentation record. */
export function encodePublicCampaignPresentation(
  presentation: PublicCampaignPresentation,
  schema: PublicCampaignPresentationSchema,
): StorageDocument {
  if (schema === "legacy") {
    return deepFreeze({
      kind: "campaign-public-presentation",
      schemaVersion: LEGACY_PUBLIC_PRESENTATION_SCHEMA_VERSION,
      revision: presentation.revision,
      publicCampaign: presentation.publicCampaign,
    });
  }
  return deepFreeze({
    kind: "campaign-public-presentation",
    schemaVersion: PUBLIC_PRESENTATION_SCHEMA_VERSION,
    revision: presentation.revision,
    publicCampaign: presentation.publicCampaign,
    amountAggregate: presentation.amountAggregate,
  });
}

/** Decodes only exact schema-4 or schema-5 public presentation records. */
export function decodePublicCampaignPresentation(
  record: StorageRecord,
): PublishedCampaignProjection {
  const source = recordValue(record.value);
  const schemaVersion = source?.schemaVersion;
  const expectedKeys = schemaVersion === LEGACY_PUBLIC_PRESENTATION_SCHEMA_VERSION
    ? LEGACY_PUBLIC_PRESENTATION_KEYS
    : schemaVersion === PUBLIC_PRESENTATION_SCHEMA_VERSION
    ? PUBLIC_PRESENTATION_KEYS
    : null;
  if (
    source === null ||
    expectedKeys === null ||
    !hasExactKeys(source, expectedKeys) ||
    source.kind !== "campaign-public-presentation" ||
    !Number.isSafeInteger(source.revision) ||
    (source.revision as number) < 1 ||
    record.key.collection !== PUBLIC_CAMPAIGN_PRESENTATION_KEY.collection ||
    record.key.id !== PUBLIC_CAMPAIGN_PRESENTATION_KEY.id ||
    record.revision !== source.revision
  ) {
    throw new StorageFailure("UNAVAILABLE");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(source.publicCampaign);
  } catch (error) {
    throw new StorageFailure("UNAVAILABLE", { cause: error });
  }
  const campaign = parsePublicCampaignConfiguration(serialized);
  if (campaign === null) throw new StorageFailure("UNAVAILABLE");
  let amountAggregate: AmountAggregateConfiguration | null = null;
  if (schemaVersion === PUBLIC_PRESENTATION_SCHEMA_VERSION) {
    const parsed = parseAmountAggregateConfiguration(source.amountAggregate);
    if (!parsed.ok) throw new StorageFailure("UNAVAILABLE");
    amountAggregate = parsed.value;
  }
  return deepFreeze({
    revision: source.revision as number,
    publicCampaign: campaign,
    amountAggregate,
  });
}

function storageKey(collection: unknown, id: unknown): StorageKey {
  const result = parseStorageKey(collection, id);
  if (!result.ok) throw new StorageFailure("INVALID_REQUEST");
  return result.value;
}

function hasExactKeys(
  source: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(source);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
