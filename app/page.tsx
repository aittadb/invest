/* Runtime-configured campaign images cannot use a build-time Next image allowlist. */
/* eslint-disable @next/next/no-img-element */
import { headers } from "next/headers";

import { getOwnerUser } from "@/app/owner-auth";
import { chatGPTSignInPath } from "@/domain/auth-navigation";
import { participationPath } from "@/domain/public-campaign-resource";
import {
  campaignFromRuntimeHeader,
  CAMPAIGN_CONFIGURATION_HEADER,
} from "@/http/runtime-campaign";

export const dynamic = "force-dynamic";

export default async function Home() {
  const requestHeaders = await headers();
  const campaign = campaignFromRuntimeHeader(
    requestHeaders.get(CAMPAIGN_CONFIGURATION_HEADER),
  );
  const owner = await getOwnerUser();

  if (!campaign || !campaign.published) {
    return <UnavailableCampaign canManage={owner !== null} />;
  }

  const signInPath = chatGPTSignInPath("/");

  return (
    <div className="campaign-page" id="top">
      <header className="site-header">
        <div className="header-inner">
          <a className="brand" href="#top" aria-label={`${campaign.name} home`}>
            {campaign.brandMarkUrl ? (
              <img alt="" aria-hidden="true" height="34" src={campaign.brandMarkUrl} width="34" />
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
          <a className="button button--quiet" href={owner ? "/owner" : signInPath}>
            {owner ? "Manage campaign" : "Sign in"}
          </a>
        </div>
      </header>

      <main>
        <section className="campaign-hero" aria-labelledby="campaign-title">
          {campaign.heroImageUrl ? (
            <img
              alt=""
              aria-hidden="true"
              className="hero-media"
              src={campaign.heroImageUrl}
            />
          ) : null}
          <div className="hero-shade" aria-hidden="true" />
          <div className="hero-inner">
            <div className="hero-copy">
              <p className="campaign-status">
                <span aria-hidden="true" />
                {campaign.statusLabel}
              </p>
              <p className="hero-eyebrow">{campaign.phaseLabel}</p>
              <h1 id="campaign-title">{campaign.name}</h1>
              <p className="hero-promise">{campaign.hero.summary}</p>
              <p className="hero-intro">{campaign.hero.invitation}</p>
              {campaign.status === "open" ? (
                <div className="hero-actions">
                  <a className="button button--primary" href={signInPath}>
                    {campaign.hero.primaryActionLabel}
                  </a>
                  {campaign.hero.secondaryAction ? (
                    <a
                      className="button button--inverse"
                      href={campaign.hero.secondaryAction.href}
                    >
                      {campaign.hero.secondaryAction.label}
                    </a>
                  ) : null}
                </div>
              ) : null}
              <p className="hero-note">{campaign.hero.note}</p>
            </div>
          </div>
          {campaign.facts.length > 0 ? (
            <div className="hero-facts" aria-label="Campaign summary">
              {campaign.facts.map((fact) => (
                <div key={`${fact.label}-${fact.value}`}>
                  <span>{fact.label}</span>
                  <strong>{fact.value}</strong>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section
          className="participation-band"
          id="opportunity"
          aria-labelledby="opportunity-title"
        >
          <div className="content-width">
            <div className="section-heading">
              <p>{campaign.participation.eyebrow}</p>
              <h2 id="opportunity-title">{campaign.participation.title}</h2>
            </div>
            <div className="participation-grid">
              {campaign.participation.paths.map((path, index) => (
                <article id={`${path.kind}-interest`} key={path.kind}>
                  <span className="path-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3>{path.title}</h3>
                  <p>{path.description}</p>
                  {campaign.status === "open" ? (
                    <a className="text-link" href={participationPath(path.kind)}>
                      {path.actionLabel}
                    </a>
                  ) : null}
                </article>
              ))}
            </div>
          </div>
        </section>

        {campaign.product ? (
          <section className="product-band" id="product" aria-labelledby="product-title">
            <div className="content-width product-layout">
              <div className="product-intro">
                <p className="section-kicker">{campaign.product.eyebrow}</p>
                <h2 id="product-title">{campaign.product.title}</h2>
                <p>{campaign.product.description}</p>
                <div className="product-links">
                  {campaign.product.links.map((link, index) => (
                    <a
                      className={index === 0 ? "button button--dark" : "text-link"}
                      href={link.href}
                      key={`${link.label}-${link.href}`}
                      rel={link.rel.join(" ")}
                    >
                      {link.label}
                    </a>
                  ))}
                </div>
              </div>
              <dl className="capability-list">
                {campaign.product.capabilities.map((capability) => (
                  <div key={capability.label}>
                    <dt>{capability.label}</dt>
                    <dd>{capability.description}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>
        ) : null}

        {campaign.process ? (
          <section className="process-band" id="process" aria-labelledby="process-title">
            <div className="content-width">
              <div className="section-heading section-heading--wide">
                <p>{campaign.process.eyebrow}</p>
                <h2 id="process-title">{campaign.process.title}</h2>
              </div>
              <ol className="process-list">
                {campaign.process.steps.map((step, index) => (
                  <li key={`${step.title}-${index}`}>
                    <span>{index + 1}</span>
                    <div>
                      <h3>{step.title}</h3>
                      <p>{step.description}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        ) : null}

        <section className="risk-band" id="risks" aria-labelledby="risks-title">
          <div className="content-width risk-layout">
            <div>
              <p className="section-kicker">{campaign.risks.eyebrow}</p>
              <h2 id="risks-title">{campaign.risks.title}</h2>
            </div>
            <ul>
              {campaign.risks.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </section>

        {campaign.faq && campaign.faq.items.length > 0 ? (
          <section className="faq-band" id="faq" aria-labelledby="faq-title">
            <div className="content-width faq-layout">
              <div>
                <p className="section-kicker">{campaign.faq.eyebrow}</p>
                <h2 id="faq-title">{campaign.faq.title}</h2>
              </div>
              <div className="faq-list">
                {campaign.faq.items.map((item) => (
                  <details key={item.question}>
                    <summary>{item.question}</summary>
                    <p>{item.answer}</p>
                  </details>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        <section className="closing-band" aria-labelledby="closing-title">
          <div className="content-width closing-inner">
            <div>
              <p>{campaign.closing.eyebrow}</p>
              <h2 id="closing-title">{campaign.closing.title}</h2>
            </div>
            {campaign.status === "open" ? (
              <a className="button button--primary" href={signInPath}>
                {campaign.closing.actionLabel}
              </a>
            ) : null}
          </div>
        </section>
      </main>

      <footer>
        <div className="content-width footer-inner">
          <div className="brand brand--footer">
            {campaign.brandMarkUrl ? (
              <img alt="" aria-hidden="true" height="28" src={campaign.brandMarkUrl} width="28" />
            ) : null}
            <span>{campaign.name}</span>
          </div>
          <p>{campaign.footer.tagline}</p>
          <div>
            {campaign.footer.links.map((link) => (
              <a
                href={link.href}
                key={`${link.label}-${link.href}`}
                rel={link.rel.join(" ")}
              >
                {link.label}
              </a>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}

function UnavailableCampaign({ canManage }: Readonly<{ canManage: boolean }>) {
  return (
    <div className="campaign-unavailable">
      <header>
        <span className="brand">Investor App</span>
        <a className="button button--quiet" href={canManage ? "/owner" : chatGPTSignInPath("/owner")}>
          {canManage ? "Manage campaign" : "Owner sign in"}
        </a>
      </header>
      <main>
        <p className="section-kicker">Investment pre-registration</p>
        <h1>Campaign unavailable</h1>
        <p>This campaign is not currently published.</p>
      </main>
    </div>
  );
}
