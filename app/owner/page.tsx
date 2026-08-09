import type { Metadata } from "next";
import Link from "next/link";

import { chatGPTSignOutPath } from "../chatgpt-auth";
import { requireOwnerUser } from "../owner-auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Campaign workspace",
  description: "Configure and manage this investment pre-registration campaign.",
};

export default async function OwnerHome() {
  const owner = await requireOwnerUser("/owner");

  return (
    <div className="owner-page">
      <header className="owner-header">
        <Link className="brand" href="/">
          Investor App
        </Link>
        <nav aria-label="Owner navigation">
          <Link href="/">View campaign</Link>
          <a href={chatGPTSignOutPath("/")}>Sign out</a>
        </nav>
      </header>
      <main className="owner-main">
        <p className="section-kicker">Owner workspace</p>
        <h1>Campaign setup</h1>
        <p className="owner-intro">
          Configure the campaign before opening registration to participants.
        </p>

        <section className="owner-status" aria-labelledby="setup-status-title">
          <div>
            <p>Current state</p>
            <h2 id="setup-status-title">Setup required</h2>
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
              <dt>Publication</dt>
              <dd>Not ready</dd>
            </div>
          </dl>
        </section>
      </main>
    </div>
  );
}
