import type { Metadata } from "next";
import Image from "next/image";

import { chatGPTSignInPath } from "./chatgpt-auth";
import { aittaDbPublicCampaign } from "@/campaigns/aittadb-public";

export const metadata: Metadata = {
  title: "AittaDB investment pre-registration",
  description:
    "Learn about AittaDB and share non-binding interest as an investor or potential founder.",
};

export default function Home() {
  const signInPath = chatGPTSignInPath("/");
  const investorPath = chatGPTSignInPath("/?intent=investor");
  const founderPath = chatGPTSignInPath("/?intent=founder");

  return (
    <div className="campaign-page" id="top">
      <header className="site-header">
        <div className="header-inner">
          <a className="brand" href="#top" aria-label="AittaDB home">
            <Image
              alt=""
              aria-hidden="true"
              height={34}
              priority
              src="/aittadb-mark.svg"
              width={34}
            />
            <span>AittaDB</span>
          </a>
          <nav aria-label="Primary navigation">
            <a href="#opportunity">Opportunity</a>
            <a href="#product">Product</a>
            <a href="#process">Process</a>
            <a href="#risks">Before you continue</a>
          </nav>
          <a className="button button--quiet" href={signInPath}>
            Sign in
          </a>
        </div>
      </header>

      <main>
        <section className="campaign-hero" aria-labelledby="campaign-title">
          <div className="hero-shade" aria-hidden="true" />
          <div className="hero-inner">
            <div className="hero-copy">
              <p className="campaign-status">
                <span aria-hidden="true" />
                {aittaDbPublicCampaign.statusLabel}
              </p>
              <p className="hero-eyebrow">{aittaDbPublicCampaign.phaseLabel}</p>
              <h1 id="campaign-title">{aittaDbPublicCampaign.name}</h1>
              <p className="hero-promise">
                {aittaDbPublicCampaign.productSummary}
              </p>
              <p className="hero-intro">{aittaDbPublicCampaign.invitation}</p>
              <div className="hero-actions">
                <a className="button button--primary" href={signInPath}>
                  Register your interest
                </a>
                <a className="button button--inverse" href="#product">
                  Explore AittaDB
                </a>
              </div>
              <p className="hero-note">
                Pre-registration is non-binding and does not reserve shares or
                create an investment commitment.
              </p>
            </div>
          </div>
          <div className="hero-facts" aria-label="Pre-registration summary">
            <div>
              <span>Current phase</span>
              <strong>Pre-registration</strong>
            </div>
            <div>
              <span>Ways to participate</span>
              <strong>Investor or founder</strong>
            </div>
            <div>
              <span>Expression of interest</span>
              <strong>Non-binding</strong>
            </div>
          </div>
        </section>

        <section className="participation-band" id="opportunity" aria-labelledby="opportunity-title">
          <div className="content-width">
            <div className="section-heading">
              <p>Take part</p>
              <h2 id="opportunity-title">Choose the path that fits you</h2>
            </div>
            <div className="participation-grid">
              <article id="investor-interest">
                <span className="path-number">01</span>
                <h3>Investor interest</h3>
                <p>
                  Request access to the private information package and share
                  an amount you may consider investing.
                </p>
                <a className="text-link" href={investorPath}>
                  Continue as an investor
                </a>
              </article>
              <article id="founder-interest">
                <span className="path-number">02</span>
                <h3>Founder interest</h3>
                <p>
                  Tell us about your expertise, the contribution you could
                  make, and when you may be available.
                </p>
                <a className="text-link" href={founderPath}>
                  Continue as a potential founder
                </a>
              </article>
            </div>
          </div>
        </section>

        <section className="product-band" id="product" aria-labelledby="product-title">
          <div className="content-width product-layout">
            <div className="product-intro">
              <p className="section-kicker">The product</p>
              <h2 id="product-title">A dependable place for application identity and data</h2>
              <p>
                AittaDB is an independent backend that applications can deploy
                entirely on ChatGPT Sites. It brings identity, authentication,
                persistent JSON data, and object storage together without a
                separate application server.
              </p>
              <div className="product-links">
                <a className="button button--dark" href="https://aittadb.com">
                  Visit AittaDB
                </a>
                <a className="text-link" href="https://github.com/aittadb/aittadb">
                  View the source
                </a>
              </div>
            </div>
            <dl className="capability-list">
              <div>
                <dt>Identity</dt>
                <dd>Independent users and standards-based OAuth/OIDC sessions.</dd>
              </div>
              <div>
                <dt>Data</dt>
                <dd>Durable, isolated JSON records for applications and agents.</dd>
              </div>
              <div>
                <dt>Files</dt>
                <dd>Application-owned object storage with bounded access.</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>Publicly reviewable under the FSL-1.1-MIT license.</dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="process-band" id="process" aria-labelledby="process-title">
          <div className="content-width">
            <div className="section-heading section-heading--wide">
              <p>Pre-registration process</p>
              <h2 id="process-title">Learn first. Decide at your own pace.</h2>
            </div>
            <ol className="process-list">
              <li>
                <span>1</span>
                <div>
                  <h3>Sign in</h3>
                  <p>Create your access profile and choose investor, founder, or both.</p>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <h3>Review the package</h3>
                  <p>Read the private information and acknowledge the current version.</p>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <h3>Share your interest</h3>
                  <p>Submit, edit, or withdraw a non-binding indication.</p>
                </div>
              </li>
            </ol>
          </div>
        </section>

        <section className="risk-band" id="risks" aria-labelledby="risks-title">
          <div className="content-width risk-layout">
            <div>
              <p className="section-kicker">Before you continue</p>
              <h2 id="risks-title">Interest now. Decisions later.</h2>
            </div>
            <ul>
              <li>This is an invitation to pre-register interest, not a securities offer.</li>
              <li>No payment, share reservation, allocation, or binding commitment happens here.</li>
              <li>Any indication is self-declared, unverified, editable, and withdrawable.</li>
              <li>AittaDB is experimental early-stage software and its future is uncertain.</li>
              <li>Any later arrangement requires a separate review and formal documentation.</li>
            </ul>
          </div>
        </section>

        <section className="faq-band" aria-labelledby="faq-title">
          <div className="content-width faq-layout">
            <div>
              <p className="section-kicker">Common questions</p>
              <h2 id="faq-title">A clear first conversation</h2>
            </div>
            <div className="faq-list">
              <details>
                <summary>Does pre-registering commit me to invest or join?</summary>
                <p>No. It records interest only and can be changed or withdrawn.</p>
              </details>
              <details>
                <summary>Can I be interested as both an investor and a founder?</summary>
                <p>Yes. The two interests are recorded and reviewed separately.</p>
              </details>
              <details>
                <summary>What happens after I sign in?</summary>
                <p>You can register for access, review the private package, and choose which interest to share.</p>
              </details>
            </div>
          </div>
        </section>

        <section className="closing-band" aria-labelledby="closing-title">
          <div className="content-width closing-inner">
            <div>
              <p>Investment pre-registration</p>
              <h2 id="closing-title">Interested in where AittaDB could go next?</h2>
            </div>
            <a className="button button--primary" href={signInPath}>
              Register your interest
            </a>
          </div>
        </section>
      </main>

      <footer>
        <div className="content-width footer-inner">
          <div className="brand brand--footer">
            <Image alt="" aria-hidden="true" height={28} src="/aittadb-mark.svg" width={28} />
            <span>AittaDB</span>
          </div>
          <p>Non-binding investment and founder pre-registration.</p>
          <div>
            <a href="https://aittadb.com">AittaDB.com</a>
            <a href="https://github.com/aittadb/aittadb">GitHub</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
