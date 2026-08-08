import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Investor App Initial Version",
  description:
    "Initial scaffold for a configurable, non-binding investor information and pre-registration app.",
};

export default function Home() {
  const readinessItems = [
    "Owner setup before public access",
    "AittaDB OIDC sign-in and subject binding",
    "Private AittaDB campaign database",
    "Immutable package versions and acknowledgments",
    "Idempotent totals with reconciliation",
  ];

  const productAreas = [
    {
      title: "Public overview",
      body: "Campaign summary, phase display, candid risks, and self-declared aggregate interest.",
    },
    {
      title: "Registered package",
      body: "Private Markdown sections with sanitized rendering, versions, and material-change acknowledgments.",
    },
    {
      title: "Pre-registration",
      body: "Separate founder applications and non-binding personal or company investment indications.",
    },
    {
      title: "Owner operations",
      body: "Setup, content editing, moderation, reconciliation, exports, audit history, and manual-notification tracking.",
    },
  ];

  return (
    <main>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero__content">
          <p className="eyebrow">Initial implementation scaffold</p>
          <h1 id="hero-title">Investor App</h1>
          <p className="hero__lede">
            A configurable ChatGPT Sites application for publishing a private
            investor information package and collecting non-binding founder and
            investment interest.
          </p>
          <div className="hero__actions" aria-label="Project links">
            <a
              className="button button--primary"
              href="/docs/AittaDB-Investor-App-Specification.md"
            >
              Specification
            </a>
            <a className="button" href="https://github.com/aittadb/aittadb">
              AittaDB server
            </a>
          </div>
        </div>
        <aside className="status-panel" aria-label="Readiness gate">
          <p className="status-panel__label">Publish gate</p>
          <h2>Campaign access stays closed until setup and storage are real.</h2>
          <ul>
            {readinessItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </aside>
      </section>

      <section className="section" aria-labelledby="areas-title">
        <div className="section__heading">
          <p className="eyebrow">Version-one boundary</p>
          <h2 id="areas-title">Product areas to build next</h2>
        </div>
        <div className="area-grid">
          {productAreas.map((area) => (
            <article className="area-card" key={area.title}>
              <h3>{area.title}</h3>
              <p>{area.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section
        className="section section--split"
        aria-labelledby="principles-title"
      >
        <div>
          <p className="eyebrow">Repository contract</p>
          <h2 id="principles-title">Campaign decisions are runtime data.</h2>
        </div>
        <p>
          The public source must not bake in a founder, country, funding target,
          final terms, legal entity, customer claim, or campaign-specific package.
          The AittaDB campaign is the first production fixture, not the app
          default.
        </p>
      </section>
    </main>
  );
}
