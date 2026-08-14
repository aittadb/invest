import type { PublicCampaignConfiguration } from "@/domain/public-campaign-configuration";

export type ProcessBandProps = Readonly<{
  process: NonNullable<PublicCampaignConfiguration["process"]>;
}>;

export function ProcessBand({ process }: ProcessBandProps) {
  return (
    <section className="process-band" id="process" aria-labelledby="process-title">
      <div className="content-width">
        <div className="section-heading section-heading--wide">
          <p>{process.eyebrow}</p>
          <h2 id="process-title">{process.title}</h2>
        </div>
        <ol className="process-list">
          {process.steps.map((step, index) => (
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
  );
}
