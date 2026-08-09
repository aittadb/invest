import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const origin = await requestOrigin();
  const socialImage = new URL("/og.png", origin).href;

  return {
    title: "AittaDB investment pre-registration",
    description:
      "Learn about AittaDB and share non-binding interest as an investor or potential founder.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      type: "website",
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

async function requestOrigin(): Promise<string> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0].trim();
  const requestHost = forwardedHost ?? requestHeaders.get("host");

  if (!requestHost || !/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(requestHost)) {
    return "http://localhost:3000";
  }

  const forwardedProtocol = requestHeaders
    .get("x-forwarded-proto")
    ?.split(",")[0]
    .trim();
  const protocol = forwardedProtocol === "http" ? "http" : "https";
  return `${protocol}://${requestHost}`;
}
