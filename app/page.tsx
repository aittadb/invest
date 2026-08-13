import { headers } from "next/headers";

import { getOwnerUser } from "@/app/owner-auth";
import { getParticipantAccess } from "@/app/participant-auth";
import { UnavailableCampaign } from "@/app/public-campaign/unavailable-campaign";
import { PublishedCampaign } from "@/app/public-campaign/published-campaign";
import {
  campaignFromRuntimeHeader,
  CAMPAIGN_CONFIGURATION_HEADER,
} from "@/http/runtime-campaign";
import {
  campaignPreviewFromRuntimeHeader,
  CAMPAIGN_PREVIEW_HEADER,
} from "@/http/runtime-preview";
import {
  publicAggregateFromRuntimeHeader,
  PUBLIC_AGGREGATE_HEADER,
} from "@/http/runtime-public-aggregate";

export const dynamic = "force-dynamic";

export default async function Home() {
  const requestHeaders = await headers();
  const campaign = campaignFromRuntimeHeader(
    requestHeaders.get(CAMPAIGN_CONFIGURATION_HEADER),
  );
  const preview = campaignPreviewFromRuntimeHeader(
    requestHeaders.get(CAMPAIGN_PREVIEW_HEADER),
  );
  const publicAggregate = publicAggregateFromRuntimeHeader(
    requestHeaders.get(PUBLIC_AGGREGATE_HEADER),
  );
  const owner = await getOwnerUser();
  const participant = await getParticipantAccess();

  if (!campaign || !campaign.published) {
    return <UnavailableCampaign canManage={owner !== null} participant={participant} />;
  }

  return (
    <PublishedCampaign
      campaign={campaign}
      owner={owner !== null}
      participant={participant}
      preview={preview}
      publicAggregate={publicAggregate}
    />
  );
}
