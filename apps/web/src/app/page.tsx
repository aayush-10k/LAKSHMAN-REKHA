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
 * The landing page. The root URL is what a judge opens cold, days later, with
 * nobody narrating, so three things about it are deliberate:
 *
 * 1. A Server Component with no data fetching. No core call, no SSE, no wallet,
 *    no client state — nothing in it can fail. If the backends are asleep, this
 *    page and its Basescan links still work, and those links never required
 *    trusting our server in the first place.
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
 * <Rekha> wraps the thesis at idle. Same component the playground animates,
 * quiet here because nothing on this page has been tested yet.
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
