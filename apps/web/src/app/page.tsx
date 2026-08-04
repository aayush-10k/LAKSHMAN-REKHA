import type { Metadata } from 'next';
import Link from 'next/link';
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
 * The landing page — FINALE_PLAN.md Phase 7.
 *
 * What used to be here was a redirect to /console, and before that ~44KB of
 * prototype HTML that evaluated "policy" as a client-side if/else chain in the
 * browser. Both are gone for the same reason: the root URL is what a judge
 * opens cold, days later, with nobody narrating.
 *
 * ── Three decisions worth defending ───────────────────────────────────────
 *
 * 1. **It is a Server Component with no data fetching at all.** No core call,
 *    no SSE, no wallet, no client state. Every other surface in this product
 *    degrades honestly when the core is down; this one cannot degrade, because
 *    there is nothing in it to fail. If Railway is asleep and the demo is dead,
 *    this page and its Basescan links still work — and those links are the only
 *    part of the system that never required trusting our server anyway.
 *
 * 2. **The hero is a revert reason, not a headline.** `InvalidCoreSignature` is
 *    the deployed bytecode's own answer when the agent signs alone. Setting a
 *    Solidity error at 64px in --breach is the one risk this page takes, and it
 *    is the right one: the strongest sentence we have is not ours, and a page
 *    that leads with the machine's word instead of a marketing claim is the
 *    whole thesis of LIMITATIONS.md rendered as a layout.
 *
 *    It is a RECORDED result, and it says so on screen, beside a link to run it
 *    live. A hardcoded revert string presented as a live one is precisely the
 *    mistake `library.py` made and FIXLOG3 exists to stop.
 *
 * 3. **No feature cards, no three-column benefits row.** The page is an
 *    evidence sheet: a claim on the left, the address where you can check it on
 *    the right. That structure is not decoration — it is the argument.
 *
 * The <Rekha> wraps the thesis at idle, doing nothing, at 40% opacity. It is
 * the same component the playground animates; here it is quiet, because on this
 * page nothing has been tested yet.
 */

export const metadata: Metadata = {
  title: 'Lakshman Rekha — an AI agent that cannot move money alone',
  description:
    'Deterministic on-chain enforcement for agentic payments. Two signatures required, ' +
    'and the agent holds one. Verified contracts on Base Sepolia.',
};

export default function Home() {
  return (
    <main className="lp">
      <header className="lp-bar">
        {/* The rule between the two words is the wordmark. "Rekha" is the line;
            drawing one in the name costs nothing and is the only ornament on
            the page. Deliberately NOT set in Devanagari — Bricolage has no
            Devanagari coverage, and a wordmark that renders as tofu boxes on an
            unfamiliar projector is not a risk worth taking on demo day. */}
        <span className="lp-wordmark">
          Lakshman<span className="lp-wordmark-rule" aria-hidden="true" />Rekha
        </span>
        <nav className="lp-bar-nav">
          <Link className="lp-bar-link" href="/console">
            Console
          </Link>
          <Link className="lp-bar-link" href="/playground">
            Playground
          </Link>
        </nav>
      </header>

      {/* ── The thesis, inside the line ──────────────────────────────── */}
      <Rekha pulse={null} className="lp-rekha">
        <section className="lp-hero">
          <p className="lp-eyebrow">
            Base Sepolia · what the chain returns when the agent pays by itself
          </p>

          <p className="lp-revert">{RECORDED_PROBE.revert}</p>

          <h1 className="lp-thesis">
            It isn&apos;t blocked. It&apos;s incapable.
          </h1>

          <p className="lp-lede">
            An AI shopping agent holds one of the two signatures a payment needs. It can be
            lied to, prompt-injected, or fully taken over — and it still cannot move a rupee,
            because the second signature is not a rule it is asked to follow. It is a key it
            does not have.
          </p>

          {/* Provenance, not a footnote. The claim above is a recorded run, and
              the page must say which run and how to repeat it. */}
          <p className="lp-provenance">
            Recorded {RECORDED_PROBE.recordedOn} · {RECORDED_PROBE.method} · predicate{' '}
            <code>{RECORDED_PROBE.predicate}</code> ·{' '}
            <Link className="lp-inline-link" href="/playground">
              run it live in the playground
            </Link>
          </p>
        </section>
      </Rekha>

      {/* ── Evidence sheet ───────────────────────────────────────────── */}
      <section className="lp-evidence">
        <h2 className="lp-h2">
          You do not have to trust us
          <span className="lp-h2-note">Three verified contracts. Click any of them.</span>
        </h2>

        <ul className="lp-rows">
          {CONTRACTS.map((contract) => (
            <li key={contract.address} className="lp-row">
              <a
                className="lp-row-key"
                href={basescanAddress(contract.address)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {contract.name}
              </a>
              <span className="lp-row-hex">{shortHex(contract.address, 10, 6)}</span>
              <span className="lp-row-note">{contract.note}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="lp-evidence">
        <h2 className="lp-h2">
          Money that actually moved
          <span className="lp-h2-note">Mined transactions, not screenshots.</span>
        </h2>

        <ul className="lp-rows">
          {SETTLED_TX.map((tx) => (
            <li key={tx.hash} className="lp-row">
              <a
                className="lp-row-key lp-row-key-settled"
                href={basescanTx(tx.hash)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {shortHex(tx.hash, 10, 6)}
              </a>
              <span className="lp-row-note lp-row-note-wide">{tx.detail}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* ── Two ways in ──────────────────────────────────────────────── */}
      <section className="lp-doors">
        <Link className="lp-door" href="/console">
          <span className="lp-door-name">Console</span>
          <span className="lp-door-desc">
            The owner&apos;s side. Live balance, every decision with the predicate that
            bound it, and a revoke that goes straight to the contract from your own wallet.
          </span>
          <span className="lp-door-go">Open the console →</span>
        </Link>

        <Link className="lp-door" href="/playground">
          <span className="lp-door-name">Playground</span>
          <span className="lp-door-desc">
            The attacker&apos;s side. Corrupt the agent six ways, inject a storefront, spawn
            a counterfeit vendor, and revoke a payment mid-signature.
          </span>
          <span className="lp-door-go">Open the playground →</span>
        </Link>
      </section>

      {/* ── The disclosure, on the front page rather than buried ─────── */}
      <footer className="lp-foot">
        <p className="lp-foot-line">
          <strong className="lp-foot-strong">What this is not.</strong> The ₹ ledger is a mock
          ERC-20 on a testnet, the vendors are simulated, and the core image digest registered
          on chain is a placeholder that attests nothing. Signing is 2-of-2 ECDSA plus an owner
          key — not a threshold scheme. The invariants are fuzzed and differentially checked
          against the Solidity, not formally proven.
        </p>
        <p className="lp-foot-line lp-foot-muted">
          Every one of those is written down in full in <code>LIMITATIONS.md</code> and{' '}
          <code>THREAT_MODEL.md</code> in the repository. Nothing on this page is stronger than
          what is in those files.
        </p>
      </footer>
    </main>
  );
}
