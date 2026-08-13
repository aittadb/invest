import Link from "next/link";

import type { CampaignPreview } from "@/app/public-campaign/published-campaign-types";

export type CampaignPreviewBannerProps = Readonly<{
  preview: CampaignPreview;
}>;

export function CampaignPreviewBanner({ preview }: CampaignPreviewBannerProps) {
  return (
    <aside className="campaign-preview-banner" aria-label="Campaign preview status">
      <p>
        <strong>Saved draft preview</strong>
        <span>
          Revision {preview.sourceRevision}. The live campaign is currently {preview.sourcePublication}.
        </span>
      </p>
      <nav aria-label="Preview navigation">
        <Link href="/owner/campaign">Return to editor</Link>
        <Link href="/">View live campaign</Link>
      </nav>
    </aside>
  );
}
