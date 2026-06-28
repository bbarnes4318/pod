import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Take Machine - AI Sports Debate Platform",
  description: "Sports-media command center for generating AI sports podcasts.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
