import type { PublicCampaignConfiguration } from "@/domain/public-campaign-configuration";

export type ClosingBandProps = Readonly<{
  campaign: PublicCampaignConfiguration;
  participant: boolean;
  participantPath: string;
  signInPath: string;
}>;

export function ClosingBand({
  campaign,
  participant,
  participantPath,
  signInPath,
}: ClosingBandProps) {
  return (
    <section className="closing-band" aria-labelledby="closing-title">
      <div className="content-width closing-inner">
        <div>
          <p>{campaign.closing.eyebrow}</p>
          <h2 id="closing-title">{campaign.closing.title}</h2>
        </div>
        {campaign.status === "open" ? (
          <a
            className="button button--primary"
            href={participant ? participantPath : signInPath}
          >
            {participant ? "View your participation" : campaign.closing.actionLabel}
          </a>
        ) : null}
      </div>
    </section>
  );
}
