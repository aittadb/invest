import assert from "node:assert/strict";
import test from "node:test";

import { parsePublicCampaignConfiguration } from "../domain/public-campaign-configuration.ts";
import {
  campaignFromRuntimeHeader,
  CAMPAIGN_CONFIGURATION_HEADER,
  withRuntimeCampaign,
} from "../http/runtime-campaign.ts";
import { syntheticPublicCampaign } from "./fixtures/public-campaign.ts";

test("parses a complete synthetic public campaign", () => {
  assert.deepEqual(
    parsePublicCampaignConfiguration(JSON.stringify(syntheticPublicCampaign)),
    syntheticPublicCampaign,
  );
});

test("rejects malformed, oversized, insecure, and ambiguous URLs", () => {
  assert.equal(parsePublicCampaignConfiguration("not-json"), null);
  assert.equal(parsePublicCampaignConfiguration("x".repeat(16_001)), null);

  for (const href of ["http://public.example/", "//public.example/", "javascript:alert(1)"]) {
    const candidate = {
      ...syntheticPublicCampaign,
      footer: {
        ...syntheticPublicCampaign.footer,
        links: [{ label: "Unsafe", href, rel: ["about"] }],
      },
    };
    assert.equal(parsePublicCampaignConfiguration(JSON.stringify(candidate)), null);
  }

  const credentialedAsset = {
    ...syntheticPublicCampaign,
    heroImageUrl: "https://user:password@assets.example/hero.jpg",
  };
  assert.equal(
    parsePublicCampaignConfiguration(JSON.stringify(credentialedAsset)),
    null,
  );
});

test("runtime campaign injection replaces spoofed internal headers", () => {
  const spoofed = new Request("https://campaign.example/", {
    headers: { [CAMPAIGN_CONFIGURATION_HEADER]: "spoofed" },
  });
  const configured = withRuntimeCampaign(
    spoofed,
    JSON.stringify({ ...syntheticPublicCampaign, name: "Northstar R\u00f6vers Oy" }),
  );
  const campaign = campaignFromRuntimeHeader(
    configured.headers.get(CAMPAIGN_CONFIGURATION_HEADER),
  );
  assert.equal(campaign?.id, syntheticPublicCampaign.id);
  assert.equal(campaign?.name, "Northstar R\u00f6vers Oy");

  const invalid = withRuntimeCampaign(spoofed, "invalid");
  assert.equal(invalid.headers.get(CAMPAIGN_CONFIGURATION_HEADER), null);
});
