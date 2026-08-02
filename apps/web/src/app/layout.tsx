import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Lakshman Rekha — Agent Enforcement Console",
  description:
    "Trust and enforcement boundary for your autonomous agents. Wallet, transaction history, policy, freeze control, and agent playground.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <link rel="stylesheet" href="/css/styles.css" />
      </head>
      <body id="app-body" className="min-h-full flex flex-col bg-ink text-chalk">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
