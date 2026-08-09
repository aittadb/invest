import {
  parsePublicCampaignConfiguration,
  type PublicCampaignConfiguration,
} from "../domain/public-campaign-configuration.ts";

export const CAMPAIGN_CONFIGURATION_HEADER =
  "x-investor-app-campaign-configuration";

export function withRuntimeCampaign(
  request: Request,
  serializedConfiguration?: string,
): Request {
  const headers = new Headers(request.headers);
  const configuration = parsePublicCampaignConfiguration(serializedConfiguration);

  if (configuration) {
    headers.set(
      CAMPAIGN_CONFIGURATION_HEADER,
      encodeConfiguration(configuration),
    );
  } else {
    headers.delete(CAMPAIGN_CONFIGURATION_HEADER);
  }

  return new Request(request, { headers });
}

export function campaignFromRuntimeHeader(
  encodedConfiguration: string | null | undefined,
): PublicCampaignConfiguration | null {
  if (!encodedConfiguration) return null;

  try {
    return parsePublicCampaignConfiguration(decodeConfiguration(encodedConfiguration));
  } catch {
    return null;
  }
}

function encodeConfiguration(configuration: PublicCampaignConfiguration): string {
  const bytes = new TextEncoder().encode(JSON.stringify(configuration));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeConfiguration(encoded: string): string {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
