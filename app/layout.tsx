import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Investor App",
  description:
    "A configurable non-binding investor pre-registration app for ChatGPT Sites.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

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
