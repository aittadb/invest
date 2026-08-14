/* Runtime-configured campaign images cannot use a build-time Next image allowlist. */
/* eslint-disable @next/next/no-img-element */
import type { PublicCampaignConfiguration } from "@/domain/public-campaign-configuration";

export type CampaignFooterProps = Readonly<{
  campaign: PublicCampaignConfiguration;
}>;

export function CampaignFooter({ campaign }: CampaignFooterProps) {
  return (
    <footer>
      <div className="content-width footer-inner">
        <div className="brand brand--footer">
          {campaign.brandMarkUrl ? (
            <img
              alt=""
              aria-hidden="true"
              height="28"
              src={campaign.brandMarkUrl}
              width="28"
            />
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
  );
}
