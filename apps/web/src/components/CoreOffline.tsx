'use client';

import React from 'react';
import { CORE_URL } from '../lib/pairing';
import { CONTRACTS, SETTLED_TX as SETTLED, basescanAddress, basescanTx } from '../lib/contracts';
import { Icon } from './Icon';

/**
 * Shown when the enforcement core cannot be reached.
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
    <div className="flex justify-center" role="alert">
      <div className="flex w-full max-w-3xl flex-col gap-5 rounded-sm border border-status-warning/40 bg-surface-container-low p-6 md:p-8">
        <h2 className="flex items-center gap-3 font-headline text-headline-md text-on-surface">
          <Icon name="warning" size={26} className="text-status-warning" />
          The enforcement core is not reachable
        </h2>

        <p className="max-w-prose font-body text-body-lg text-on-surface-variant">
          This page is the console only. The core, the agent and the vendor registry run
          locally — nothing on this screen is being enforced right now, so nothing on it is
          claiming to be.
        </p>

        <pre className="overflow-x-auto rounded-sm border border-muted bg-surface-container-lowest p-4 font-mono text-[12px] leading-relaxed text-on-surface">
{`pnpm dev:vendorsim   # :4100
pnpm dev:core        # :4000
pnpm dev:agent       # :4200
pnpm dev:web         # :3000`}
        </pre>

        <p className="font-mono text-[11px] leading-relaxed text-on-surface-variant">
          Tried <code className="text-data-hash">{CORE_URL}</code>
          {reason ? <> — {reason}</> : null}
          <br />
          Point the console elsewhere with{' '}
          <code className="text-on-surface">NEXT_PUBLIC_CORE_URL</code> and{' '}
          <code className="text-on-surface">NEXT_PUBLIC_AGENT_URL</code>.
        </p>

        <div className="flex flex-col gap-4 border-t border-muted pt-5">
          <h3 className="font-mono text-label-sm uppercase tracking-widest text-on-surface">
            What you can verify without running anything
          </h3>

          <div className="flex flex-col gap-2">
            <p className="font-body text-body-md text-on-surface-variant">
              Deployed and source-verified on Base Sepolia:
            </p>
            <ul className="flex flex-col gap-1.5">
              {CONTRACTS.map((c) => (
                <li key={c.address} className="flex flex-wrap items-baseline gap-x-3 font-mono text-[12px]">
                  <a
                    href={basescanAddress(c.address)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-data-hash hover:text-primary"
                  >
                    {c.name}
                    <Icon name="external" size={10} />
                  </a>
                  <span className="text-on-surface-variant">{c.note}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-col gap-2">
            <p className="font-body text-body-md text-on-surface-variant">
              Payments this system actually settled:
            </p>
            <ul className="flex flex-col gap-1.5">
              {SETTLED.map((t) => (
                <li key={t.hash} className="flex flex-wrap items-baseline gap-x-3 font-mono text-[12px]">
                  <a
                    href={basescanTx(t.hash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-data-hash hover:text-primary"
                  >
                    {short(t.hash)}
                    <Icon name="external" size={10} />
                  </a>
                  <span className="text-on-surface-variant">{t.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
