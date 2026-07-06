import type { Metadata, Viewport } from "next";
import { Barlow_Condensed, Inter } from "next/font/google";
import "./globals.css";

const display = Barlow_Condensed({
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-display-next",
});

const body = Inter({
  subsets: ["latin"],
  variable: "--font-body-next",
});

// viewport-fit=cover so env(safe-area-inset-*) is non-zero on notched phones
// (the /app player bar and its reserved space depend on it).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "Take Machine — Turn hot takes into episodes",
  description:
    "The AI sports-debate studio: pick tonight's hottest take, and Take Machine researches it, writes the argument, voices the hosts, and hands you a finished episode.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
