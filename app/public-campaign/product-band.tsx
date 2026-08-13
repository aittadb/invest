import type { PublicCampaignConfiguration } from "@/domain/public-campaign-configuration";

export type ProductBandProps = Readonly<{
  product: NonNullable<PublicCampaignConfiguration["product"]>;
}>;

export function ProductBand({ product }: ProductBandProps) {
  return (
    <section className="product-band" id="product" aria-labelledby="product-title">
      <div className="content-width product-layout">
        <div className="product-intro">
          <p className="section-kicker">{product.eyebrow}</p>
          <h2 id="product-title">{product.title}</h2>
          <p>{product.description}</p>
          <div className="product-links">
            {product.links.map((link, index) => (
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
          {product.capabilities.map((capability) => (
            <div key={capability.label}>
              <dt>{capability.label}</dt>
              <dd>{capability.description}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
