import type { Metadata } from "next";
import { Hanken_Grotesk, Inter, JetBrains_Mono } from "next/font/google";
import { Providers } from "./providers";

/**
 * THE STYLESHEET IMPORT. Do not remove it, and do not add a second one.
 *
 * theme.css is the only stylesheet in this app: it pulls in Tailwind and
 * carries every design token. Anything that needs a rule Tailwind cannot
 * express — the Rekha's dash geometry, the row washes, the scanline — belongs
 * in its @layer components block rather than in a new file.
 */
import "./theme.css";

/**
 * Three faces, three jobs.
 *
 * Hanken Grotesk — headlines and the balance figure. Grotesk with slightly
 * squared terminals: engineering drawing rather than magazine.
 * Inter — body copy, the only face here optimised for reading at 15px.
 * JetBrains Mono — every rupee amount, hash, address, predicate name, block
 * number and latency figure. If a machine produced it, it is monospace.
 *
 * All three via next/font, never `@import url(fonts.googleapis.com)`. A CSS
 * @import is a render-blocking request to a third party on the critical path;
 * on a projector behind conference wifi that is a blank screen you cannot
 * explain away. next/font self-hosts and makes no runtime request.
 *
 * Icons are inline SVG (src/components/Icon.tsx), not an icon font, for the
 * same reason plus one more: a webfont that has not loaded renders as tofu
 * boxes, and half this interface's meaning is carried by its glyphs.
 */
const hanken = Hanken_Grotesk({
  variable: "--font-hanken",
  subsets: ["latin"],
  display: "swap",
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  display: "swap",
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
      className={`${hanken.variable} ${inter.variable} ${jetbrains.variable}`}
    >
      <body id="app-body" className="bg-background text-on-background font-body antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
