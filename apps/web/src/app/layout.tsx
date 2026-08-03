import type { Metadata } from "next";
import { Geist, Geist_Mono, Bricolage_Grotesque } from "next/font/google";
import { Providers } from "./providers";

/**
 * THE STYLESHEET IMPORT. Do not remove it.
 *
 * globals.css holds the entire design system — the six semantic tokens and every
 * .console-* / .pg-* class the two pages are built from — and until this line
 * existed it was never imported anywhere in apps/web/src. All 927 lines were
 * dead code: the production bundle shipped 3.7KB of CSS, all of it @font-face,
 * and both pages rendered as unstyled HTML.
 *
 * The prototype's <link href="/css/styles.css"> had been doing the visual work.
 * Commit c22f29f deleted it — correctly, it belonged to the fake client-side
 * product — on the stated grounds that "the real console owns its own tokens in
 * globals.css". That was true of the file and not of the build.
 */
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * Display face, per BUILD.md Part 11: section heads and the balance figure only.
 *
 * Loaded here rather than through the `@import url(fonts.googleapis.com)` that
 * used to sit at the top of globals.css. A CSS @import is a render-blocking
 * request to a third party on the critical path — on a projector, behind
 * conference wifi, that is a blank screen you cannot explain away. next/font
 * self-hosts the file and makes no runtime request.
 *
 * No `weight`: Bricolage Grotesque is variable, so the whole axis ships.
 */
const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
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
    // No Tailwind utility classes here. Tailwind v4 is wired into
    // postcss.config.mjs but globals.css never imports it, so no utilities are
    // generated — `bg-ink`, `text-chalk`, `flex`, `h-full` were all inert.
    // Leaving them would silently change the layout the day someone adds
    // `@import "tailwindcss"`. html/body sizing and colour come from globals.css.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${bricolage.variable}`}
    >
      <body id="app-body">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
