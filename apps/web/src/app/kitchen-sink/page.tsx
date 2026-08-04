'use client';

import { useState } from 'react';
import { Amount } from '../../components/Amount';
import { Counter } from '../../components/Counter';
import { TTLRing } from '../../components/TTLRing';
import { Rekha, type RekhaPulse } from '../../components/Rekha';
import { PredicateTable } from '../../components/PredicateTable';
import type { DecisionTrace } from '../../types';

/**
 * Design-system review route. Not part of the product.
 *
 * Every primitive in every state, side by side, so the look can be signed off
 * before any page is rebuilt on top of it. This is the cheapest place to catch
 * the failure mode BUILD.md Part 11 warns about — drift toward a generic dark
 * SaaS dashboard — because on this page the six colours are the only thing to
 * look at.
 *
 * The DecisionTrace below is a FIXTURE. It is the only fabricated data anywhere
 * in apps/web, it exists purely to render the table, and it is labelled as such
 * on screen so nobody mistakes this route for a live view.
 */

const FIXTURE_APPROVED: DecisionTrace = {
  decisionId: 'dec_kitchen_sink_ok',
  lineItemId: 'li_1',
  outcome: 'APPROVED',
  amountMinor: 940000,
  counterpartyId: '0x1f9c…dbba1',
  policyHash: '0x8960a494209993e857a6573ef8ee53e56371acd8e67309a06bccf0fed65204c6',
  coreImageDigest: '0x0100000000000000000000000000000000000000000000000000000000000000',
  evaluatedAtMs: 0,
  latencyMs: 380,
  signature: '0x00',
  bindingPredicate: null,
  summary: 'Approved. ₹9,400.00 to a known counterparty, within all caps.',
  // The `inputs` are what the predicate was evaluated ON, and they are the first
  // thing anyone asks about after "which rule failed". The values here mirror the
  // real deployment measured on 2026-08-04 (permittedCategories 223, perTxCap
  // ₹25,000, windowCap ₹1,00,000) so the review route shows realistic density
  // rather than a table of empty cells.
  predicates: [
    { name: 'agentSignature',   inputs: { recovered: '0x6E19cA2B…a00d5' },                    expected: 'agent signer',      actual: 'match',     passed: true, severity: 'hard' },
    { name: 'coreSignature',    inputs: { recovered: '0xB18D311d…dAdf6B' },                   expected: 'core signer',       actual: 'match',     passed: true, severity: 'hard' },
    { name: 'coreImage',        inputs: { digest: '0x010000…0000' },                          expected: 'attested digest',   actual: 'match',     passed: true, severity: 'hard' },
    { name: 'revocationEpoch',  inputs: { request: 0, onChain: 0 },                           expected: 'equal',             actual: '0 = 0',     passed: true, severity: 'hard' },
    { name: 'leaseExpiry',      inputs: { ttlMs: 15000, remainingMs: 3200 },                  expected: '> now',             actual: '+3.2s',     passed: true, severity: 'hard' },
    { name: 'categoryPermitted',inputs: { code: 'PACKAGING', bit: 0, bitmap: 223 },           expected: 'bit set',           actual: 'permitted', passed: true, severity: 'hard' },
    { name: 'counterpartyTier', inputs: { tier: 1, ageDays: 412, settledTxns: 37 },           expected: 'tier 1',            actual: 'tier 1',    passed: true, severity: 'hard' },
    { name: 'perTxCap',         inputs: { amountMinor: 940000, capMinor: 2500000 },           expected: '≤ 2500000',         actual: '940000',    passed: true, severity: 'hard' },
    { name: 'windowCap',        inputs: { spentMinor: 2789800, amountMinor: 940000, capMinor: 10000000 }, expected: '≤ 10000000', actual: '3729800', passed: true, severity: 'hard' },
  ],
};

const FIXTURE_REFUSED: DecisionTrace = {
  ...FIXTURE_APPROVED,
  decisionId: 'dec_kitchen_sink_no',
  outcome: 'REFUSED',
  amountMinor: 4999000,
  bindingPredicate: 'perTxCap',
  summary: 'Refused — ₹49,990.00 is over the ₹25,000.00 per-transaction cap. Nothing was charged.',
  predicates: FIXTURE_APPROVED.predicates.map((p) =>
    p.name === 'perTxCap'
      ? {
          ...p,
          inputs: { amountMinor: 4999000, capMinor: 2500000 },
          expected: '≤ 2500000',
          actual: '4999000',
          passed: false,
        }
      : p,
  ),
};

const SWATCHES: Array<{ token: string; meaning: string }> = [
  { token: '--ink',    meaning: 'base' },
  { token: '--slate',  meaning: 'raised surfaces' },
  { token: '--chalk',  meaning: 'the line, primary text' },
  { token: '--lien',   meaning: 'HELD — money is held' },
  { token: '--clear',  meaning: 'SETTLED — money moved' },
  { token: '--breach', meaning: 'REFUSED / REVOKED — something was stopped' },
];

const box: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 20,
  background: 'var(--slate)',
};

export default function KitchenSinkPage() {
  const [pulse, setPulse] = useState<RekhaPulse | null>(null);
  const [pulseId, setPulseId] = useState(0);
  const [count, setCount] = useState(147);
  const [ttl, setTtl] = useState(11400);

  const fire = (kind: RekhaPulse['kind']) => {
    const id = pulseId + 1;
    setPulseId(id);
    setPulse({ kind, id });
  };

  return (
    <div style={{ padding: '32px 40px', maxWidth: 1200, margin: '0 auto' }}>
      <header style={{ marginBottom: 32 }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 34, letterSpacing: '-0.5px' }}>
          Design system
        </h1>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 6 }}>
          Review route — not part of the product. The decision traces below are the only
          fabricated data in <code className="mono-sm">apps/web</code>; everything on the real
          pages comes from the core.
        </p>
      </header>

      {/* ── Colour ── */}
      <section style={{ ...box, marginBottom: 24 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 17, marginBottom: 4 }}>Six colours</h2>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 16 }}>
          There is no seventh. The last three carry meaning and nothing else may use them.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 12 }}>
          {SWATCHES.map((s) => (
            <div key={s.token}>
              <div
                style={{
                  height: 48,
                  borderRadius: 6,
                  background: `var(${s.token})`,
                  border: '1px solid var(--border)',
                }}
              />
              <div className="mono-sm" style={{ marginTop: 6, fontSize: 11 }}>{s.token}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>{s.meaning}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Type ── */}
      <section style={{ ...box, marginBottom: 24 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 17, marginBottom: 16 }}>Type</h2>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 64, letterSpacing: '-1.5px', lineHeight: 1.05 }}>
          ₹4,72,102.00
        </div>
        <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>
          Bricolage Grotesque — display. Section heads and the balance figure only.
        </div>
        <p style={{ marginTop: 16, fontSize: 14 }}>
          Geist — body. Refused — vendor is 2 days old. Vendors in this tier need 30.
          Nothing was charged.
        </p>
        <p className="mono-sm" style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
          Geist Mono — data. 0xfc2926d09a824bec…c4414a7a · block 44961513 · 131,628 gas
        </p>
      </section>

      {/* ── Amount ── */}
      <section style={{ ...box, marginBottom: 24 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 17, marginBottom: 4 }}>&lt;Amount&gt;</h2>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 14 }}>
          Integer paise in, Indian grouping out. Tabular numerals, right-aligned. Never float maths.
        </p>
        <table className="predicate-table">
          <thead><tr><th>minor (paise)</th><th>rendered</th></tr></thead>
          <tbody>
            {[94, 940000, 4999000, 10000000, 47210200, -376000].map((m) => (
              <tr key={m}>
                <td className="mono-sm">{m}</td>
                <td style={{ textAlign: 'right' }}><Amount minor={m} /></td>
              </tr>
            ))}
            <tr>
              <td className="mono-sm">null</td>
              <td style={{ textAlign: 'right' }}><Amount minor={null} /></td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* ── Counter + TTLRing ── */}
      <section style={{ ...box, marginBottom: 24, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28 }}>
        <div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 17, marginBottom: 4 }}>&lt;Counter&gt;</h2>
          <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 14 }}>
            Eases to the value. No bounce — a springing number reads as a game score.
          </p>
          <div style={{ fontSize: 44, fontFamily: 'var(--font-display)' }}>
            <Counter value={count} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn-ghost-sm" onClick={() => setCount((c) => c + 7)}>+7</button>
            <button className="btn-ghost-sm" onClick={() => setCount((c) => c + 113)}>+113</button>
            <button className="btn-ghost-sm" onClick={() => setCount(0)}>reset</button>
          </div>
        </div>

        <div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 17, marginBottom: 4 }}>&lt;TTLRing&gt;</h2>
          <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 14 }}>
            Chalk while alive, breach when critical. Never green — that would borrow the
            colour that means money moved.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
            <TTLRing ttlMs={ttl} maxMs={15000} size={80} showLabel />
            <TTLRing ttlMs={ttl} maxMs={15000} size={36} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[15000, 11400, 6000, 2400, 0].map((v) => (
                <button key={v} className="btn-ghost-sm" onClick={() => setTtl(v)}>
                  {(v / 1000).toFixed(1)}s
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Rekha ── */}
      <section style={{ ...box, marginBottom: 24 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 17, marginBottom: 4 }}>&lt;Rekha&gt;</h2>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 16 }}>
          Flare on a blocked attack. Snap on an aborted ceremony. <strong>Nothing</strong> on a
          settled payment — the line does not celebrate.
        </p>

        <Rekha pulse={pulse} className="rekha-demo">
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: 13,
              minHeight: 190,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}
          >
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, color: 'var(--chalk)' }}>
              the agent works in here
            </div>
            <div>the line is what the enforcement layer does</div>
          </div>
        </Rekha>

        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          <button className="btn-ghost-sm" onClick={() => fire('flare')}>
            attack.attempt blocked → flare
          </button>
          <button className="btn-ghost-sm" onClick={() => fire('snap')}>
            ceremony.aborted → snap
          </button>
          <button className="btn-ghost-sm" onClick={() => setPulse(null)} title="Nothing should happen">
            payment.settled → nothing
          </button>
        </div>
      </section>

      {/* ── Ceremony bar ── */}
      <section style={{ ...box, marginBottom: 24 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 17, marginBottom: 4 }}>Ceremony bar</h2>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>
          Completed rounds are chalk, not green: a signed round is progress, not money that moved.
        </p>
        {/* The playground's own classes, not a second copy of them. This page
            exists to show the real primitives; a showcase that had drifted from
            the shipped bar would be worse than no showcase. */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="pg-ceremony">
            <div className="pg-ceremony-track">
              <div className="pg-seg is-done" />
              <div className="pg-seg is-done" />
              <div className="pg-seg is-pending" />
            </div>
            <span className="pg-ceremony-label">round 2 of 3</span>
          </div>
          <div className="pg-ceremony is-aborted">
            <div className="pg-ceremony-track">
              <div className="pg-seg is-done" />
              <div className="pg-seg is-broken" />
              <div className="pg-seg is-broken" />
            </div>
            <span className="pg-ceremony-label">broken at round 2 of 3</span>
          </div>
        </div>
      </section>

      {/* ── PredicateTable ── */}
      <section style={{ ...box, marginBottom: 40 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 17, marginBottom: 4 }}>
          &lt;PredicateTable&gt;
        </h2>
        <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 16 }}>
          The summary sentence comes from the core&apos;s <code className="mono-sm">trace.summary</code>,
          never assembled here. Fixture data on this page only.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <PredicateTable trace={FIXTURE_APPROVED} />
          <PredicateTable trace={FIXTURE_REFUSED} />
        </div>
      </section>
    </div>
  );
}
