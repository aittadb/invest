import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";

import { getOwnerUser } from "@/app/owner-auth";
import { requireParticipantAccess } from "@/app/participant-auth";
import { chatGPTSignOutPath } from "@/domain/auth-navigation";
import { participantWorkflowAccess } from "@/domain/participant-home-resource";
import {
  PARTICIPANT_HOME_PATH,
  PRIVATE_PACKAGE_PATH,
} from "@/domain/participant-navigation";
import { FOUNDER_INTEREST_PATH } from "@/domain/participant-founder-interest-resource";
import { INVESTMENT_INTEREST_PATH } from "@/domain/participant-investment-interest-resource";
import {
  campaignFromRuntimeHeader,
  CAMPAIGN_CONFIGURATION_HEADER,
} from "@/http/runtime-campaign";
import {
  hasParticipantFounderInterest,
  hasParticipantInvestmentInterests,
  PARTICIPANT_FOUNDER_INTEREST_HEADER,
  PARTICIPANT_INVESTMENT_INTERESTS_HEADER,
} from "@/http/runtime-capabilities";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your participation",
  description: "Review your campaign access and current information package.",
};

export default async function ParticipantHome() {
  const participant = await requireParticipantAccess(PARTICIPANT_HOME_PATH);
  const owner = await getOwnerUser();
  const requestHeaders = await headers();
  const campaign = campaignFromRuntimeHeader(
    requestHeaders.get(CAMPAIGN_CONFIGURATION_HEADER),
  );
  const currentPackage = participant.currentPackage;
  const {
    founderInterest: founderInterestAvailable,
    investmentInterests: investmentInterestsAvailable,
  } = participantWorkflowAccess(participant, {
    founderInterest: hasParticipantFounderInterest(
      requestHeaders.get(PARTICIPANT_FOUNDER_INTEREST_HEADER),
    ),
    investmentInterests: hasParticipantInvestmentInterests(
      requestHeaders.get(PARTICIPANT_INVESTMENT_INTERESTS_HEADER),
    ),
  });

  return (
    <div className="participant-page">
      <header className="participant-header">
        <Link className="brand" href="/">
          {campaign?.name ?? "Investor App"}
        </Link>
        <nav aria-label="Participant navigation">
          <Link href="/">View campaign</Link>
          {currentPackage ? (
            <Link href={PRIVATE_PACKAGE_PATH}>Information package</Link>
          ) : null}
          {founderInterestAvailable ? (
            <Link href={FOUNDER_INTEREST_PATH}>Founder interest</Link>
          ) : null}
          {investmentInterestsAvailable ? (
            <Link href={INVESTMENT_INTEREST_PATH}>Investment interests</Link>
          ) : null}
          {owner ? <Link href="/owner">Manage campaign</Link> : null}
          <a href={chatGPTSignOutPath("/")}>Sign out</a>
        </nav>
      </header>

      <main className="participant-main">
        <p className="section-kicker">Your participation</p>
        <h1>Welcome, {participant.displayName}</h1>
        <p className="participant-intro">
          Review your access and continue with the information available to
          your account.
        </p>

        <section
          className="participant-summary"
          aria-labelledby="participant-access-title"
        >
          <div>
            <p>Access</p>
            <h2 id="participant-access-title">
              {participant.accountStatus === "active"
                ? "Registration active"
                : "Deletion requested"}
            </h2>
          </div>
          <dl>
            <div>
              <dt>Account</dt>
              <dd>{participant.email}</dd>
            </div>
            <div>
              <dt>Interest</dt>
              <dd>{interestLabel(participant.declaredInterest)}</dd>
            </div>
            <div>
              <dt>Participating as</dt>
              <dd>{contextLabel(participant.participationContext)}</dd>
            </div>
            <div>
              <dt>Campaign</dt>
              <dd>{campaign?.name ?? "Not currently published"}</dd>
            </div>
          </dl>
        </section>

        {founderInterestAvailable || investmentInterestsAvailable ? (
          <section
            className="participant-package"
            aria-labelledby="participant-interests-title"
          >
            <div>
              <p className="section-kicker">Your interests</p>
              <h2 id="participant-interests-title">
                Continue your pre-registration
              </h2>
            </div>
            <div className="participant-package-detail">
              <p>
                Review or update the non-binding interests associated with this
                account.
              </p>
              <div className="participant-workflow-actions">
                {founderInterestAvailable ? (
                  <Link className="button button--quiet" href={FOUNDER_INTEREST_PATH}>
                    Founder interest
                  </Link>
                ) : null}
                {investmentInterestsAvailable ? (
                  <Link
                    className="button button--primary"
                    href={INVESTMENT_INTEREST_PATH}
                  >
                    Investment interests
                  </Link>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}

        <section
          className="participant-package"
          id="information-package"
          aria-labelledby="information-package-title"
        >
          <div>
            <p className="section-kicker">Information package</p>
            <h2 id="information-package-title">
              {currentPackage ? "Current package available" : "No current package"}
            </h2>
          </div>
          {currentPackage ? (
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
                  <dt>Acknowledgment</dt>
                  <dd>
                    {currentPackage.requiresCurrentAcceptance
                      ? "Review required"
                      : "Current"}
                  </dd>
                </div>
              </dl>
              <Link className="button button--primary" href={PRIVATE_PACKAGE_PATH}>
                Read information package
              </Link>
            </div>
          ) : (
            <p className="participant-package-empty">
              There is no information package available to this account.
            </p>
          )}
        </section>
      </main>
    </div>
  );
}

function interestLabel(value: "founder" | "investor" | "both"): string {
  if (value === "both") return "Investor and founder";
  return value === "investor" ? "Investor" : "Founder";
}

function contextLabel(value: "individual" | "company"): string {
  return value === "individual" ? "An individual" : "A company";
}
