import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

import { APP_ORIGIN_HEADER } from "../http/app-origin";
import {
  campaignFromRuntimeHeader,
  CAMPAIGN_CONFIGURATION_HEADER,
} from "../http/runtime-campaign";

const DEVELOPMENT_ORIGIN = "http://localhost:3000";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const appOrigin = requestHeaders.get(APP_ORIGIN_HEADER) ?? DEVELOPMENT_ORIGIN;
  const canonicalUrl = new URL("/", appOrigin);
  const configuredCampaign = campaignFromRuntimeHeader(
    requestHeaders.get(CAMPAIGN_CONFIGURATION_HEADER),
  );
  const campaign = configuredCampaign?.published ? configuredCampaign : null;
  const title = campaign?.pageTitle ?? "Investor App";
  const description =
    campaign?.pageDescription ?? "This campaign is not currently published.";
  const socialImage = campaign?.socialImageUrl
    ? new URL(campaign.socialImageUrl, appOrigin)
    : null;
  const icon = campaign?.brandMarkUrl
    ? new URL(campaign.brandMarkUrl, appOrigin)
    : new URL("/favicon.svg", appOrigin);

  return {
    metadataBase: new URL(appOrigin),
    title,
    description,
    alternates: {
      canonical: canonicalUrl,
    },
    icons: {
      icon,
      shortcut: icon,
    },
    openGraph: {
      type: "website",
      url: canonicalUrl,
      title,
      description,
      images: socialImage ? [socialImage] : undefined,
    },
    twitter: {
      card: socialImage ? "summary_large_image" : "summary",
      title,
      description,
      images: socialImage ? [socialImage] : undefined,
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
