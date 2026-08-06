import type { Metadata } from 'next';
import Link from 'next/link';
import { Icon } from '@/components/Icon';
import { Rekha } from '@/components/Rekha';
import {
  CONTRACTS,
  RECORDED_PROBE,
  SETTLED_TX,
  basescanAddress,
  basescanTx,
  shortHex,
} from '@/lib/contracts';

/**
 * The landing page. The root URL is what a judge opens cold, days later, with
 * nobody narrating, so three things about it are deliberate:
 *
 * 1. A Server Component with no data fetching. No core call, no SSE, no wallet,
 *    no client state — nothing in it can fail. If the backends are asleep, this
 *    page and its Basescan links still work, and those links never required
 *    trusting our server in the first place. It sits outside the (app) route
 *    group for exactly this reason: the shell polls the core, this must not.
 *
 * 2. The hero is a revert reason rather than a headline. InvalidCoreSignature is
 *    the deployed bytecode's own answer when the agent signs alone. It is a
 *    RECORDED result and says so on screen, beside a link to run it live — a
 *    hardcoded revert string presented as a live one would be the exact failure
 *    this page exists to avoid.
 *
 * 3. No feature cards. The page is an evidence sheet: a claim on the left, the
 *    address where it can be checked on the right.
 *
 * ── On motion ──────────────────────────────────────────────────────────────
 * Nothing here starts from `opacity: 0`. A typing effect on the revert and a
 * staggered fade on the rest were built and then taken out, because they broke
 * the one property this page exists to have.
 *
 * Any entrance animation starts invisible and relies on the document timeline
 * to leave that state. Chrome freezes that timeline in a background tab:
 * measured here at `document.timeline.currentTime: 0` with every revealed
 * element stuck at `opacity: 0`. It heals the moment the tab is looked at — but
 * this is the page opened cold, and "the hero is blank until you click the tab"
 * is not a risk worth a fade.
 *
 * The rule, for anyone adding motion here later: nothing that is the only copy
 * of information on screen may depend on an animation to become visible. Hover
 * and ambient effects are fine — they start from the visible state.
 */

export const metadata: Metadata = {
  title: 'Lakshman Rekha — an AI agent that cannot move money alone',
  description:
    'Deterministic on-chain enforcement for agentic payments. Two signatures required, ' +
    'and the agent holds one. Verified contracts on Base Sepolia.',
};

/** The 2-of-2, told as three parties rather than a diagram. */
const ARCHITECTURE = [
  {
    name: 'Agent core',
    icon: 'bot' as const,
    tag: 'Signature 1',
    tagClass: 'text-status-warning',
    body: 'Plans the purchase, browses the storefront, asks to pay. Holds one key share and can be lied to, prompt-injected or wholly taken over without that changing.',
  },
  {
    name: 'Policy core',
    icon: 'gavel' as const,
    tag: null,
    tagClass: '',
    body: 'Fourteen predicates, evaluated against the request before anything is signed. Refuses without appeal, and the same rules are enforced again on chain.',
    lead: true,
  },
  {
    name: 'Owner',
    icon: 'user' as const,
    tag: 'Signature 2',
    tagClass: 'text-status-success',
    body: 'Holds the second key and the revoke. Not a reviewer in the loop for every payment — a bound the agent cannot reach past, whether or not anyone is watching.',
  },
];

export default function Home() {
  return (
    <div className="min-h-screen">
      {/* ── Top bar. Its own, not the app shell's: nothing here may poll. ── */}
      <header className="flex h-16 items-center justify-between border-b border-muted bg-surface px-margin-mobile md:px-margin-desktop">
        {/* The rule between the two words is the wordmark. "Rekha" is the line;
            drawing one in the name costs nothing and is the only ornament on
            the page. Deliberately NOT set in Devanagari — the display face has
            no Devanagari coverage, and a wordmark that renders as tofu boxes on
            an unfamiliar projector is not a risk worth taking on demo day. */}
        <span className="flex items-center gap-1.5 font-mono text-[14px] font-bold tracking-tighter text-on-surface sm:gap-3 sm:text-body-lg">
          Lakshman
          <span aria-hidden="true" className="h-px w-3 bg-primary opacity-40 sm:w-7" />
          Rekha
        </span>

        <nav className="flex items-center gap-0.5 sm:gap-1">
          <span className="mr-2 hidden rounded-sm border border-muted bg-surface-container px-2 py-1 font-mono text-label-sm tracking-widest text-on-surface-variant lg:inline-block">
            [ NETWORK: BASE SEPOLIA ]
          </span>
          <Link
            className="rounded-sm px-2 py-2 font-mono text-[11px] uppercase tracking-wider text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-primary sm:px-3 sm:text-label-sm"
            href="/console"
          >
            Console
          </Link>
          <Link
            className="rounded-sm px-2 py-2 font-mono text-[11px] uppercase tracking-wider text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-primary sm:px-3 sm:text-label-sm"
            href="/playground"
          >
            Playground
          </Link>
        </nav>
      </header>

      <main className="mx-auto flex w-full max-w-container-max flex-col gap-14 px-margin-mobile py-10 md:px-margin-desktop md:py-16">
        {/* ── The thesis, inside the line ──────────────────────────────── */}
        <Rekha pulse={null} className="rounded-sm bg-surface-container-low">
          <section className="flex flex-col gap-4 p-6 md:p-10">
            <p className="font-mono text-label-sm uppercase tracking-widest text-on-surface-variant">
              Base Sepolia · what the chain returns when the agent pays by itself
            </p>

            <p className="font-mono text-[clamp(28px,6vw,60px)] leading-none font-bold tracking-tight text-status-error">
              {RECORDED_PROBE.revert}
            </p>

            <h1 className="font-headline text-headline-lg text-on-surface">
              It isn&apos;t blocked. It&apos;s incapable.
            </h1>

            <p className="max-w-3xl font-body text-body-lg text-on-surface-variant">
              An AI shopping agent holds one of the two signatures a payment needs. It can be
              lied to, prompt-injected, or fully taken over — and it still cannot move a rupee,
              because the second signature is not a rule it is asked to follow. It is a key it
              does not have.
            </p>

            {/* Provenance, not a footnote. The claim above is a recorded run,
                and the page must say which run and how to repeat it. */}
            <p className="mt-2 border-t border-muted pt-4 font-mono text-label-mono text-on-surface-variant">
              Recorded {RECORDED_PROBE.recordedOn} · {RECORDED_PROBE.method} · predicate{' '}
              <code className="text-data-hash">{RECORDED_PROBE.predicate}</code> ·{' '}
              <Link
                className="text-primary underline underline-offset-4 transition-colors hover:text-on-surface"
                href="/playground"
              >
                run it live in the playground
              </Link>
            </p>
          </section>
        </Rekha>

        {/* ── Architecture: the 2-of-2, as three parties ───────────────── */}
        <section className="flex flex-col gap-gutter">
          <h2 className="eyebrow text-tertiary">Architecture</h2>

          <div className="grid grid-cols-1 gap-gutter md:grid-cols-3">
            {ARCHITECTURE.map((party) => (
              <article
                key={party.name}
                className={`group relative flex flex-col gap-4 overflow-hidden rounded-sm p-gutter transition-colors ${
                  party.lead
                    ? 'border border-tertiary bg-surface-container-high'
                    : 'border border-muted bg-surface-container-low hover:border-primary'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute -right-3 -top-3 opacity-[0.07] transition-opacity duration-300 group-hover:opacity-[0.14] ${
                    party.lead ? 'text-tertiary' : 'text-on-surface'
                  }`}
                >
                  <Icon name={party.icon} size={128} strokeWidth={1} />
                </span>

                <div className="relative flex items-start justify-between gap-3">
                  <h3
                    className={`font-headline text-[22px] font-semibold ${
                      party.lead ? 'text-tertiary' : 'text-on-surface'
                    }`}
                  >
                    {party.name}
                  </h3>
                  {party.tag ? (
                    <span
                      className={`rounded-sm border border-muted px-2 py-1 font-mono text-[10px] uppercase tracking-wider ${party.tagClass}`}
                    >
                      {party.tag}
                    </span>
                  ) : (
                    <span className="flex items-center gap-0.5 text-tertiary" title="Both signatures">
                      <Icon name="key" size={16} />
                      <Icon name="key" size={16} />
                    </span>
                  )}
                </div>

                <p
                  className={`relative flex-1 font-body text-body-md ${
                    party.lead ? 'text-on-surface' : 'text-on-surface-variant'
                  }`}
                >
                  {party.body}
                </p>
              </article>
            ))}
          </div>
        </section>

        {/* ── Evidence: the contracts ──────────────────────────────────── */}
        <section id="verification" className="flex flex-col gap-gutter scroll-mt-20">
          <h2 className="eyebrow text-on-surface-variant">Verification</h2>

          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h3 className="font-headline text-headline-md text-on-surface">
              You do not have to trust us
            </h3>
            <p className="font-body text-body-md text-on-surface-variant">
              Three verified contracts. Click any of them.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-gutter md:grid-cols-3">
            {CONTRACTS.map((contract) => (
              <a
                key={contract.address}
                href={basescanAddress(contract.address)}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex flex-col gap-3 rounded-sm border border-muted bg-surface-container p-gutter transition-colors hover:border-primary"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-label-mono text-on-surface">{contract.name}</span>
                  <span className="flex items-center gap-1 rounded-sm border border-status-success px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-status-success">
                    <Icon name="check" size={10} strokeWidth={2} />
                    Verified
                  </span>
                </div>

                <div className="relative overflow-hidden rounded-sm border border-muted bg-surface p-3 font-mono text-[12px] break-all text-data-hash shimmer">
                  {shortHex(contract.address, 14, 8)}
                </div>

                <p className="flex items-center gap-1.5 font-body text-body-md text-on-surface-variant">
                  {contract.note}
                  <Icon
                    name="external"
                    size={12}
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                  />
                </p>
              </a>
            ))}
          </div>
        </section>

        {/* ── Evidence: the money ──────────────────────────────────────── */}
        <section className="flex flex-col gap-gutter">
          <h2 className="eyebrow text-on-surface-variant">Ledger</h2>

          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h3 className="font-headline text-headline-md text-on-surface">
              Money that actually moved
            </h3>
            <p className="font-body text-body-md text-on-surface-variant">
              Mined transactions, not screenshots.
            </p>
          </div>

          <div className="overflow-x-auto rounded-sm border border-muted bg-surface-container-low">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-muted bg-surface-container-high">
                  <th className="px-4 py-3 font-mono text-label-sm font-normal uppercase tracking-wider text-on-surface-variant">
                    Transaction
                  </th>
                  <th className="px-4 py-3 font-mono text-label-sm font-normal uppercase tracking-wider text-on-surface-variant">
                    Settlement
                  </th>
                  <th className="w-10 px-4 py-3" />
                </tr>
              </thead>
              <tbody className="font-mono text-[13px]">
                {SETTLED_TX.map((tx) => (
                  <tr
                    key={tx.hash}
                    className="group border-b border-muted/50 transition-colors last:border-b-0 hover:bg-surface-variant/50"
                  >
                    <td className="px-4 py-3">
                      <a
                        href={basescanTx(tx.hash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-data-hash transition-colors group-hover:text-primary"
                      >
                        {shortHex(tx.hash, 12, 8)}
                      </a>
                    </td>
                    <td className="tnum px-4 py-3 text-on-surface-variant transition-colors group-hover:text-on-surface">
                      {tx.detail}
                    </td>
                    <td className="px-4 py-3 text-on-surface-variant">
                      <Icon
                        name="external"
                        size={12}
                        className="opacity-0 transition-opacity group-hover:opacity-100"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Two ways in ──────────────────────────────────────────────── */}
        <section className="grid grid-cols-1 gap-gutter md:grid-cols-2">
          <Link
            className="group flex flex-col gap-3 rounded-sm border border-muted bg-surface-container-low p-6 transition-colors hover:border-primary"
            href="/console"
          >
            <span className="flex items-center gap-2 font-headline text-[22px] font-semibold text-on-surface">
              <Icon name="terminal" size={18} className="text-primary" />
              Console
            </span>
            <span className="font-body text-body-md text-on-surface-variant">
              The owner&apos;s side. Live balance, every decision with the predicate that bound
              it, and a revoke that goes straight to the contract from your own wallet.
            </span>
            <span className="mt-1 flex items-center gap-2 font-mono text-label-sm uppercase tracking-wider text-primary">
              Open the console
              <Icon
                name="arrowRight"
                size={14}
                className="transition-transform group-hover:translate-x-1"
              />
            </span>
          </Link>

          <Link
            className="group flex flex-col gap-3 rounded-sm border border-muted bg-surface-container-low p-6 transition-colors hover:border-primary"
            href="/playground"
          >
            <span className="flex items-center gap-2 font-headline text-[22px] font-semibold text-on-surface">
              <Icon name="bug" size={18} className="text-status-warning" />
              Playground
            </span>
            <span className="font-body text-body-md text-on-surface-variant">
              The attacker&apos;s side. Corrupt the agent six ways, inject a storefront, spawn a
              counterfeit vendor, and revoke a payment mid-signature.
            </span>
            <span className="mt-1 flex items-center gap-2 font-mono text-label-sm uppercase tracking-wider text-primary">
              Open the playground
              <Icon
                name="arrowRight"
                size={14}
                className="transition-transform group-hover:translate-x-1"
              />
            </span>
          </Link>
        </section>

        {/* ── The disclosure, on the front page rather than buried ─────── */}
        <footer className="flex flex-col gap-3 border-t border-muted pt-8">
          <p className="max-w-[74ch] font-body text-[12.5px] leading-relaxed text-on-surface-variant">
            <strong className="font-semibold text-on-surface">What this is not.</strong> The ₹
            ledger is a mock ERC-20 on a testnet, the vendors are simulated, and the core image
            digest registered on chain is a placeholder that attests nothing. Signing is 2-of-2
            ECDSA plus an owner key — not a threshold scheme. The invariants are fuzzed and
            differentially checked against the Solidity, not formally proven.
          </p>
          <p className="max-w-[74ch] font-body text-[11.5px] leading-relaxed text-on-surface-variant/70">
            Every one of those is written down in full in{' '}
            <code className="font-mono text-on-surface">LIMITATIONS.md</code> and{' '}
            <code className="font-mono text-on-surface">THREAT_MODEL.md</code> in the repository.
            Nothing on this page is stronger than what is in those files.
          </p>
        </footer>
      </main>
    </div>
  );
}
