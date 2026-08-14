export const CAMPAIGN_PREVIEW_HEADER = "x-investor-app-campaign-preview";

export type RuntimeCampaignPreview = Readonly<{
  sourceRevision: number;
  sourcePublication: "published" | "unpublished";
}>;

export function withRuntimeCampaignPreview(
  request: Request,
  preview: RuntimeCampaignPreview | null,
): Request {
  const headers = new Headers(request.headers);
  if (preview === null) {
    headers.delete(CAMPAIGN_PREVIEW_HEADER);
  } else {
    headers.set(
      CAMPAIGN_PREVIEW_HEADER,
      `${preview.sourceRevision}:${preview.sourcePublication}`,
    );
  }
  return new Request(request, { headers });
}

export function campaignPreviewFromRuntimeHeader(
  value: string | null | undefined,
): RuntimeCampaignPreview | null {
  const match = /^(\d+):(published|unpublished)$/.exec(value ?? "");
  if (!match) return null;
  const sourceRevision = Number(match[1]);
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1) return null;
  return Object.freeze({
    sourceRevision,
    sourcePublication: match[2] as "published" | "unpublished",
  });
}
