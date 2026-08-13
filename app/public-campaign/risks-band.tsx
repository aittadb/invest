import type { PublicCampaignConfiguration } from "@/domain/public-campaign-configuration";

export type RisksBandProps = Readonly<{
  risks: PublicCampaignConfiguration["risks"];
}>;

export function RisksBand({ risks }: RisksBandProps) {
  return (
    <section className="risk-band" id="risks" aria-labelledby="risks-title">
      <div className="content-width risk-layout">
        <div>
          <p className="section-kicker">{risks.eyebrow}</p>
          <h2 id="risks-title">{risks.title}</h2>
        </div>
        <ul>
          {risks.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
