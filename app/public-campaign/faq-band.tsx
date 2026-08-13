import type { PublicCampaignConfiguration } from "@/domain/public-campaign-configuration";

export type FaqBandProps = Readonly<{
  faq: NonNullable<PublicCampaignConfiguration["faq"]>;
}>;

export function FaqBand({ faq }: FaqBandProps) {
  return (
    <section className="faq-band" id="faq" aria-labelledby="faq-title">
      <div className="content-width faq-layout">
        <div>
          <p className="section-kicker">{faq.eyebrow}</p>
          <h2 id="faq-title">{faq.title}</h2>
        </div>
        <div className="faq-list">
          {faq.items.map((item) => (
            <details key={item.question}>
              <summary>{item.question}</summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
