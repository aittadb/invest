/* Runtime-configured campaign images cannot use a build-time Next image allowlist. */
/* eslint-disable @next/next/no-img-element */
import type { AuthorizedParticipantAccess } from "@/domain/participant-home-resource";
import type { PublicCampaignConfiguration } from "@/domain/public-campaign-configuration";

export type CampaignHeroProps = Readonly<{
  campaign: PublicCampaignConfiguration;
  participant: AuthorizedParticipantAccess | null;
  participantPrimaryPath: string;
  signInPath: string;
}>;

export function CampaignHero({
  campaign,
  participant,
  participantPrimaryPath,
  signInPath,
}: CampaignHeroProps) {
  return (
    <section className="campaign-hero" aria-labelledby="campaign-title">
      {campaign.heroImageUrl ? (
        <img
          alt=""
          aria-hidden="true"
          className="hero-media"
          src={campaign.heroImageUrl}
        />
      ) : null}
      <div className="hero-shade" aria-hidden="true" />
      <div className="hero-inner">
        <div className="hero-copy">
          <p className="campaign-status">
            <span aria-hidden="true" />
            {campaign.statusLabel}
          </p>
          <p className="hero-eyebrow">{campaign.phaseLabel}</p>
          <h1 id="campaign-title">{campaign.name}</h1>
          <p className="hero-promise">{campaign.hero.summary}</p>
          <p className="hero-intro">{campaign.hero.invitation}</p>
          {campaign.status === "open" ? (
            <div className="hero-actions">
              <a
                className="button button--primary"
                href={participant ? participantPrimaryPath : signInPath}
              >
                {participant
                  ? participant.currentPackage
                    ? "Read information package"
                    : "View your participation"
                  : campaign.hero.primaryActionLabel}
              </a>
              {campaign.hero.secondaryAction ? (
                <a
                  className="button button--inverse"
                  href={campaign.hero.secondaryAction.href}
                >
                  {campaign.hero.secondaryAction.label}
                </a>
              ) : null}
            </div>
          ) : null}
          <p className="hero-note">{campaign.hero.note}</p>
        </div>
      </div>
      {campaign.facts.length > 0 ? (
        <div className="hero-facts" aria-label="Campaign summary">
          {campaign.facts.map((fact) => (
            <div key={`${fact.label}-${fact.value}`}>
              <span>{fact.label}</span>
              <strong>{fact.value}</strong>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
