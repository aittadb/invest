import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";

import { chatGPTSignOutPath } from "../chatgpt-auth";
import { requireOwnerUser } from "../owner-auth";
import {
  campaignFromRuntimeHeader,
  CAMPAIGN_CONFIGURATION_HEADER,
} from "../../http/runtime-campaign";
import {
  hasOwnerAittaDBConnection,
  hasOwnerCampaignEditorCapability,
  hasOwnerCampaignSetupCapability,
  hasOwnerIndicationModeration,
  hasOwnerPackageWorkspace,
  hasOwnerReviewExports,
  OWNER_AITTADB_CONNECTION_HEADER,
  OWNER_CAMPAIGN_EDITOR_CAPABILITY_HEADER,
  OWNER_CAMPAIGN_SETUP_CAPABILITY_HEADER,
  OWNER_INDICATION_MODERATION_HEADER,
  OWNER_PACKAGE_WORKSPACE_HEADER,
  OWNER_REVIEW_EXPORTS_HEADER,
} from "../../http/runtime-capabilities";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Campaign workspace",
  description: "Configure and manage this investment pre-registration campaign.",
};

export default async function OwnerHome() {
  const owner = await requireOwnerUser("/owner");
  const requestHeaders = await headers();
  const campaign = campaignFromRuntimeHeader(
    requestHeaders.get(CAMPAIGN_CONFIGURATION_HEADER),
  );
  const packageWorkspaceAvailable = hasOwnerPackageWorkspace(
    requestHeaders.get(OWNER_PACKAGE_WORKSPACE_HEADER),
  );
  const indicationModerationAvailable = hasOwnerIndicationModeration(
    requestHeaders.get(OWNER_INDICATION_MODERATION_HEADER),
  );
  const aittadbConnectionAvailable = hasOwnerAittaDBConnection(
    requestHeaders.get(OWNER_AITTADB_CONNECTION_HEADER),
  );
  const canEditCampaign = hasOwnerCampaignEditorCapability(
    requestHeaders.get(OWNER_CAMPAIGN_EDITOR_CAPABILITY_HEADER),
  );
  const canConfigureCampaign = hasOwnerCampaignSetupCapability(
    requestHeaders.get(OWNER_CAMPAIGN_SETUP_CAPABILITY_HEADER),
  );
  const reviewExportsAvailable = hasOwnerReviewExports(
    requestHeaders.get(OWNER_REVIEW_EXPORTS_HEADER),
  );
  const setupState = campaign ? "Configured" : "Setup required";
  const publicationState = campaign
    ? campaign.published
      ? "Published"
      : "Unpublished"
    : "Not configured";

  return (
    <div className="owner-page">
      <header className="owner-header">
        <Link className="brand" href="/">
          Investor App
        </Link>
        <nav aria-label="Owner navigation">
          <Link href="/">View campaign</Link>
          {canConfigureCampaign ? <Link href="/owner/setup">Campaign setup</Link> : null}
          {canEditCampaign && campaign ? (
            <Link href="/owner/campaign">Edit presentation</Link>
          ) : null}
          {packageWorkspaceAvailable ? (
            <Link href="/owner/package">Information package</Link>
          ) : null}
          {indicationModerationAvailable ? (
            <Link href="/owner/investment-indications">Investment indications</Link>
          ) : null}
          {aittadbConnectionAvailable ? (
            <Link href="/owner/aittadb-connection">AittaDB connection</Link>
          ) : null}
          {reviewExportsAvailable ? (
            <Link href="/owner/exports">Review exports</Link>
          ) : null}
          <a href={chatGPTSignOutPath("/")}>Sign out</a>
        </nav>
      </header>
      <main className="owner-main">
        <p className="section-kicker">Owner workspace</p>
        <h1>Campaign workspace</h1>
        <p className="owner-intro">
          Review the public campaign configured for this instance.
        </p>

        <section className="owner-status" aria-labelledby="setup-status-title">
          <div>
            <p>Current state</p>
            <h2 id="setup-status-title">{setupState}</h2>
          </div>
          <dl>
            <div>
              <dt>Owner</dt>
              <dd>{owner.displayName}</dd>
            </div>
            <div>
              <dt>Account</dt>
              <dd>{owner.email}</dd>
            </div>
            <div>
              <dt>Campaign</dt>
              <dd>{campaign?.name ?? "Not configured"}</dd>
            </div>
            <div>
              <dt>Publication</dt>
              <dd>{publicationState}</dd>
            </div>
          </dl>
        </section>
        {canConfigureCampaign ? (
          <p className="owner-workspace-action">
            <Link
              className="button button--primary"
              href={campaign ? "/owner/campaign" : "/owner/setup"}
            >
              {campaign ? "Edit campaign presentation" : "Configure campaign"}
            </Link>
          </p>
        ) : null}
      </main>
    </div>
  );
}
