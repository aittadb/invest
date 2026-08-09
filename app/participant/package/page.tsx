import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";

import { getOwnerUser } from "@/app/owner-auth";
import { requireParticipantAccess } from "@/app/participant-auth";
import { chatGPTSignOutPath } from "@/domain/auth-navigation";
import {
  PARTICIPANT_HOME_PATH,
  PRIVATE_PACKAGE_PATH,
} from "@/domain/participant-navigation";
import {
  campaignFromRuntimeHeader,
  CAMPAIGN_CONFIGURATION_HEADER,
} from "@/http/runtime-campaign";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Information package",
  description: "Review the current private information-package status.",
};

export default async function PrivatePackage() {
  const participant = await requireParticipantAccess(PRIVATE_PACKAGE_PATH);
  const currentPackage = participant.currentPackage;
  if (currentPackage === null) notFound();

  const owner = await getOwnerUser();
  const requestHeaders = await headers();
  const campaign = campaignFromRuntimeHeader(
    requestHeaders.get(CAMPAIGN_CONFIGURATION_HEADER),
  );

  return (
    <div className="participant-page">
      <header className="participant-header">
        <Link className="brand" href="/">
          {campaign?.name ?? "Investor App"}
        </Link>
        <nav aria-label="Participant navigation">
          <Link href="/">View campaign</Link>
          <Link href={PARTICIPANT_HOME_PATH}>Your participation</Link>
          {owner ? <Link href="/owner">Manage campaign</Link> : null}
          <a href={chatGPTSignOutPath("/")}>Sign out</a>
        </nav>
      </header>

      <main className="participant-main">
        <p className="section-kicker">Private information package</p>
        <h1>Information package</h1>
        <p className="participant-intro">
          Review the current package status and acknowledgment requirement for
          your account.
        </p>

        <section
          className="participant-package participant-package--resource"
          aria-labelledby="package-status-title"
        >
          <div>
            <p className="section-kicker">Current version</p>
            <h2 id="package-status-title">
              {currentPackage.requiresCurrentAcceptance
                ? "Review required"
                : "Acknowledgment current"}
            </h2>
          </div>
          <div className="participant-package-detail">
            <p>{currentPackage.changeSummary}</p>
            <dl>
              <div>
                <dt>Published</dt>
                <dd>
                  <time dateTime={currentPackage.createdAt}>
                    {currentPackage.createdAt.slice(0, 10)}
                  </time>
                </dd>
              </div>
              <div>
                <dt>Change</dt>
                <dd>
                  {currentPackage.materialChange ? "Material" : "Editorial"}
                </dd>
              </div>
            </dl>
            <Link className="text-link" href={PARTICIPANT_HOME_PATH}>
              Return to your participation
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
