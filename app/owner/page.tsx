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
  hasOwnerPackageWorkspace,
  OWNER_PACKAGE_WORKSPACE_HEADER,
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
          {packageWorkspaceAvailable ? (
            <Link href="/owner/package">Information package</Link>
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
      </main>
    </div>
  );
}
