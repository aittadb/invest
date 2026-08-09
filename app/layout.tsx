import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

import { APP_ORIGIN_HEADER } from "../http/app-origin";

const DEVELOPMENT_ORIGIN = "http://localhost:3000";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const appOrigin = requestHeaders.get(APP_ORIGIN_HEADER) ?? DEVELOPMENT_ORIGIN;
  const canonicalUrl = new URL("/", appOrigin);
  const socialImage = new URL("/og.png", appOrigin);

  return {
    metadataBase: new URL(appOrigin),
    title: "AittaDB investment pre-registration",
    description:
      "Learn about AittaDB and share non-binding interest as an investor or potential founder.",
    alternates: {
      canonical: canonicalUrl,
    },
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      type: "website",
      url: canonicalUrl,
      title: "AittaDB investment pre-registration",
      description: "Investor or founder. Non-binding.",
      images: [socialImage],
    },
    twitter: {
      card: "summary_large_image",
      title: "AittaDB investment pre-registration",
      description: "Investor or founder. Non-binding.",
      images: [socialImage],
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
