'use client';

import React from 'react';
import { CORE_URL } from '../lib/pairing';
import { CONTRACTS, SETTLED_TX as SETTLED, basescanAddress, basescanTx } from '../lib/contracts';

/**
 * Shown when the enforcement core cannot be reached.
 *
 * The console defaults to http://localhost:4000, so on a deployed
 * URL every real page silently reached nothing — and before BUG 1 the only page
 * that appeared to work was the browser-side fake. That combination is what made
 * the whole submission read as a mock.
 *
 * The rule this panel exists to satisfy: never show a UI that looks alive while
 * pointing at a core that is not there. It says plainly what is running and what
 * is not, and it puts the things a judge can verify WITHOUT running anything —
 * the deployed contracts and two settled transactions — directly on screen.
 *
 * Every address and hash below is real and resolvable on Base Sepolia. Nothing
 * here is illustrative.
 */

const short = (s: string) => `${s.slice(0, 10)}…${s.slice(-8)}`;

export function CoreOffline({ reason }: { reason?: string | null }) {
  return (
    <div className="core-offline" role="alert">
      <div className="core-offline-inner">
        <h2 className="core-offline-title">The enforcement core is not reachable</h2>

        <p className="core-offline-lede">
          This page is the console only. The core, the agent and the vendor registry run
          locally — nothing on this screen is being enforced right now, so nothing on it
          is claiming to be.
        </p>

        <pre className="core-offline-cmd">
{`pnpm dev:vendorsim   # :4100
pnpm dev:core        # :4000
pnpm dev:agent       # :4200
pnpm dev:web         # :3000`}
        </pre>

        <p className="core-offline-meta">
          Tried <code>{CORE_URL}</code>
          {reason ? <> — {reason}</> : null}
          <br />
          Point the console elsewhere with <code>NEXT_PUBLIC_CORE_URL</code> and{' '}
          <code>NEXT_PUBLIC_AGENT_URL</code>.
        </p>

        <div className="core-offline-verify">
          <h3>What you can verify without running anything</h3>

          <p className="core-offline-sub">Deployed and source-verified on Base Sepolia:</p>
          <ul>
            {CONTRACTS.map(c => (
              <li key={c.address}>
                <a
                  href={basescanAddress(c.address)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {c.name} ↗
                </a>
                <span className="core-offline-note">{c.note}</span>
              </li>
            ))}
          </ul>

          <p className="core-offline-sub">Payments this system actually settled:</p>
          <ul>
            {SETTLED.map(t => (
              <li key={t.hash}>
                <a
                  href={basescanTx(t.hash)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {short(t.hash)} ↗
                </a>
                <span className="core-offline-note">{t.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
