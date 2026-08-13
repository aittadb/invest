/* Runtime-configured campaign images cannot use a build-time Next image allowlist. */
/* eslint-disable @next/next/no-img-element */
import type { AuthorizedParticipantAccess } from "@/domain/participant-home-resource";
import type { PublicCampaignConfiguration } from "@/domain/public-campaign-configuration";
import {
  PARTICIPANT_HOME_PATH,
} from "@/domain/participant-navigation";

export type CampaignHeaderProps = Readonly<{
  campaign: PublicCampaignConfiguration;
  owner: boolean;
  participant: AuthorizedParticipantAccess | null;
  signInPath: string;
}>;

export function CampaignHeader({
  campaign,
  owner,
  participant,
  signInPath,
}: CampaignHeaderProps) {
  return (
    <header className="site-header">
      <div className="header-inner">
        <a className="brand" href="#top" aria-label={`${campaign.name} home`}>
          {campaign.brandMarkUrl ? (
            <img
              alt=""
              aria-hidden="true"
              height="34"
              src={campaign.brandMarkUrl}
              width="34"
            />
          ) : (
            <span className="brand-monogram" aria-hidden="true">
              {campaign.name.slice(0, 1)}
            </span>
          )}
          <span>{campaign.name}</span>
        </a>
        <nav aria-label="Primary navigation">
          {campaign.navigation.map((item) => (
            <a href={item.href} key={`${item.label}-${item.href}`}>
              {item.label}
            </a>
          ))}
        </nav>
        <div className="header-actions">
          {participant ? (
            <a className="button button--quiet" href={PARTICIPANT_HOME_PATH}>
              My participation
            </a>
          ) : null}
          {owner ? (
            <a className="button button--quiet" href="/owner">
              Manage campaign
            </a>
          ) : null}
          {!participant && !owner ? (
            <a className="button button--quiet" href={signInPath}>
              Sign in
            </a>
          ) : null}
        </div>
      </div>
    </header>
  );
}
