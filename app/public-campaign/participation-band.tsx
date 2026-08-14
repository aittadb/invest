import type { AuthorizedParticipantAccess } from "@/domain/participant-home-resource";
import type { PublicCampaignConfiguration } from "@/domain/public-campaign-configuration";
import { PARTICIPANT_HOME_PATH } from "@/domain/participant-navigation";

export type ParticipationBandProps = Readonly<{
  campaign: PublicCampaignConfiguration;
  participant: AuthorizedParticipantAccess | null;
  signInPath: string;
}>;

export function ParticipationBand({
  campaign,
  participant,
  signInPath,
}: ParticipationBandProps) {
  return (
    <section
      className="participation-band"
      id="opportunity"
      aria-labelledby="opportunity-title"
    >
      <div className="content-width">
        <div className="section-heading">
          <p>{campaign.participation.eyebrow}</p>
          <h2 id="opportunity-title">{campaign.participation.title}</h2>
        </div>
        <div className="participation-grid">
          {campaign.participation.paths.map((path, index) => (
            <article id={`${path.kind}-interest`} key={path.kind}>
              <span className="path-number">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3>{path.title}</h3>
              <p>{path.description}</p>
              {campaign.status === "open" ? (
                <a
                  className="text-link"
                  href={participant ? PARTICIPANT_HOME_PATH : signInPath}
                >
                  {participant ? "View your participation" : path.actionLabel}
                </a>
              ) : null}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
