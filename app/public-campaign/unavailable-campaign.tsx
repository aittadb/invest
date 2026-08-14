import { chatGPTSignInPath } from "@/domain/auth-navigation";
import {
  PARTICIPANT_HOME_PATH,
  PRIVATE_PACKAGE_PATH,
} from "@/domain/participant-navigation";
import type { AuthorizedParticipantAccess } from "@/domain/participant-home-resource";

export type UnavailableCampaignProps = Readonly<{
  canManage: boolean;
  participant: AuthorizedParticipantAccess | null;
}>;

export function UnavailableCampaign({ canManage, participant }: UnavailableCampaignProps) {
  return (
    <div className="campaign-unavailable">
      <header>
        <span className="brand">Investor App</span>
        <div className="header-actions">
          {participant ? (
            <a className="button button--quiet" href={PARTICIPANT_HOME_PATH}>
              My participation
            </a>
          ) : null}
          {participant?.currentPackage ? (
            <a className="button button--quiet" href={PRIVATE_PACKAGE_PATH}>
              Information package
            </a>
          ) : null}
          {canManage ? (
            <a className="button button--quiet" href="/owner">
              Manage campaign
            </a>
          ) : null}
          {!participant && !canManage ? (
            <a className="button button--quiet" href={chatGPTSignInPath("/owner")}>
              Owner sign in
            </a>
          ) : null}
        </div>
      </header>
      <main>
        <p className="section-kicker">Investment pre-registration</p>
        <h1>Campaign unavailable</h1>
        <p>This campaign is not currently published.</p>
      </main>
    </div>
  );
}
