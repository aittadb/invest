import { chatGPTSignInPath } from "@/domain/auth-navigation";
import type { AuthorizedParticipantAccess } from "@/domain/participant-home-resource";
import type { PublicCampaignConfiguration } from "@/domain/public-campaign-configuration";
import {
  PARTICIPANT_HOME_PATH,
  PRIVATE_PACKAGE_PATH,
} from "@/domain/participant-navigation";
import { CampaignFooter } from "@/app/public-campaign/campaign-footer";
import { CampaignHeader } from "@/app/public-campaign/campaign-header";
import { CampaignHero } from "@/app/public-campaign/campaign-hero";
import { CampaignPreviewBanner } from "@/app/public-campaign/campaign-preview-banner";
import { ClosingBand } from "@/app/public-campaign/closing-band";
import { FaqBand } from "@/app/public-campaign/faq-band";
import { ParticipationBand } from "@/app/public-campaign/participation-band";
import { ProcessBand } from "@/app/public-campaign/process-band";
import { ProductBand } from "@/app/public-campaign/product-band";
import { PublicAggregateBand } from "@/app/public-campaign/public-aggregate-band";
import { RisksBand } from "@/app/public-campaign/risks-band";
import type {
  CampaignPreview,
  PublicAggregate,
} from "@/app/public-campaign/published-campaign-types";

export type PublishedCampaignProps = Readonly<{
  campaign: PublicCampaignConfiguration;
  preview: CampaignPreview | null;
  publicAggregate: PublicAggregate | null;
  owner: boolean;
  participant: AuthorizedParticipantAccess | null;
}>;

export function PublishedCampaign({
  campaign,
  preview,
  publicAggregate,
  owner,
  participant,
}: PublishedCampaignProps) {
  const signInPath = chatGPTSignInPath(PARTICIPANT_HOME_PATH);
  const participantPrimaryPath = participant?.currentPackage
    ? PRIVATE_PACKAGE_PATH
    : PARTICIPANT_HOME_PATH;

  return (
    <div className="campaign-page" id="top">
      {preview ? <CampaignPreviewBanner preview={preview} /> : null}
      <CampaignHeader
        campaign={campaign}
        owner={owner}
        participant={participant}
        signInPath={signInPath}
      />
      <main>
        <CampaignHero
          campaign={campaign}
          participant={participant}
          participantPrimaryPath={participantPrimaryPath}
          signInPath={signInPath}
        />
        {publicAggregate ? (
          <PublicAggregateBand publicAggregate={publicAggregate} />
        ) : null}
        <ParticipationBand
          campaign={campaign}
          participant={participant}
          signInPath={signInPath}
        />
        {campaign.product ? <ProductBand product={campaign.product} /> : null}
        {campaign.process ? <ProcessBand process={campaign.process} /> : null}
        <RisksBand risks={campaign.risks} />
        {campaign.faq && campaign.faq.items.length > 0 ? (
          <FaqBand faq={campaign.faq} />
        ) : null}
        <ClosingBand
          campaign={campaign}
          participant={participant !== null}
          participantPath={PARTICIPANT_HOME_PATH}
          signInPath={signInPath}
        />
      </main>
      <CampaignFooter campaign={campaign} />
    </div>
  );
}
