'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useWriteContract, useAccount, useConnect, useDisconnect } from 'wagmi';
import { injected } from 'wagmi/connectors';
import type { DecisionTrace, RekhaEvent } from '../../types';
import { CORE_URL, ensurePaired, renewLease, type Pairing } from '../../lib/pairing';
import { AgentStatus } from '../../components/AgentStatus';

const POLICY_MODULE_ADDRESS = (process.env['NEXT_PUBLIC_POLICY_MODULE_ADDRESS'] ?? '0x933bb10252ec2b133f28b7d5edf1d303c3384d87') as `0x${string}`;

const revokeAbi = [{ type: 'function', name: 'revoke', stateMutability: 'nonpayable', inputs: [], outputs: [] }] as const;

type FeedItem = {
  id: string;
  type: string;
  text: string;
  outcome?: string;
  trace?: DecisionTrace;
  ts: number;
  txHash?: string;
  amountMinor?: number;
  expiresAtMs?: number;
};

type HoldItem = { decisionId: string; expiresAtMs: number; amountMinor: number };

function fmtInr(minor: number) {
  return '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

function timeAgo(ts: number) {
  const d = Date.now() - ts;
  if (d < 5000) return 'just now';
  if (d < 60000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  return `${Math.floor(d / 3600000)}h ago`;
}

export default function ConsolePage() {
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [selected, setSelected] = useState<DecisionTrace | null>(null);
  const [balance, setBalance] = useState(5_000_000);
  const [frozen, setFrozen] = useState(false);
  const [mandateId, setMandateId] = useState<string | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [holds, setHolds] = useState<HoldItem[]>([]);
  const [coreUp, setCoreUp] = useState(false);
  const [leaseTtl, setLeaseTtl] = useState(5000);
  /** Configured lease TTL, read from the core. The ring denominator, not a guess. */
  const [leaseTtlMax, setLeaseTtlMax] = useState(5000);
  const [imageDigest, setImageDigest] = useState('loading…');
  const feedRef = useRef<HTMLDivElement>(null);
  const { writeContract, isPending: revokePending } = useWriteContract();
  const { address, isConnected } = useAccount();
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();

  // Boot: pair with the core, then load balance and holds.
  // FIX2.md BUG 2 — this used to POST a literal '------' pairing code and drop
  // the 404 on the floor, so the console was never actually paired.
  useEffect(() => {
    fetch(`${CORE_URL}/health`)
      .then(r => r.json())
      .then(h => { setCoreUp(true); if (h.leaseTtlMs) setLeaseTtlMax(h.leaseTtlMs); })
      .catch(() => setCoreUp(false));

    ensurePaired()
      .then(p => {
        setPairing(p);
        setMandateId(p.mandateId);
        setLeaseTtlMax(p.leaseTtlMs);
        setPairError(null);
      })
      .catch((e: Error) => setPairError(e.message));

    fetch(`${CORE_URL}/v1/wallet/balance`)
      .then(r => r.json())
      .then(d => { if (d.balanceMinor !== undefined) setBalance(d.balanceMinor); })
      .catch(() => {});

    fetch(`${CORE_URL}/v1/holds`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.holds)) setHolds(d.holds); })
      .catch(() => {});
  }, []);

  // Keep the lease alive so the TTL ring shows a real lease rather than a
  // decorative one. renewLease re-pairs by itself if the core has restarted and
  // forgotten this agentId — the failure mode BUG 2 is about.
  useEffect(() => {
    if (!pairing) return;
    let current = pairing.agentId;
    let stopped = false;

    const tick = async () => {
      try {
        const lease = await renewLease(current);
        if (stopped) return;
        if (lease.agentId !== current) {
          current = lease.agentId;
          setPairing(p => (p ? { ...p, agentId: lease.agentId } : p));
        }
        setLeaseTtlMax(lease.ttlMs);
        setPairError(null);
      } catch (e) {
        if (!stopped) setPairError((e as Error).message);
      }
    };

    void tick();
    const timer = setInterval(tick, Math.max(1000, pairing.leaseTtlMs * 0.6));
    return () => { stopped = true; clearInterval(timer); };
  }, [pairing?.agentId, pairing?.leaseTtlMs]); // eslint-disable-line react-hooks/exhaustive-deps

  // SSE subscription
  useEffect(() => {
    const evtSource = new EventSource(`${CORE_URL}/v1/events`);

    evtSource.onmessage = (e) => {
      const event: RekhaEvent = JSON.parse(e.data);
      processEvent(event);
    };

    evtSource.onerror = () => {
      setCoreUp(false);
    };

    return () => evtSource.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const processEvent = useCallback((event: RekhaEvent) => {
    const ts = Date.now();

    if (event.t === 'core.status') {
      setCoreUp(event.up);
      setImageDigest(event.imageDigest);
      return;
    }

    if (event.t === 'lease.tick') {
      setLeaseTtl(event.ttlMs);
      return;
    }

    if (event.t === 'revocation') {
      setFrozen(true);
      addFeedItem({ id: `rev-${ts}`, type: 'revocation', text: `⛔ Mandate revoked by ${event.source}. All spending stopped. Epoch: ${event.epoch}`, ts, outcome: 'REFUSED' });
      return;
    }

    if (event.t === 'payment.requested') {
      addFeedItem({ id: `req-${event.lineItemId}`, type: 'requested', text: `→ Payment requested: ${event.lineItemId}`, ts, amountMinor: event.factSheet.amountMinor });
    }

    if (event.t === 'decision.made') {
      const { trace } = event;
      const outcomeIcon = trace.outcome === 'APPROVED' ? '✓' : trace.outcome === 'HELD' ? '⏸' : '✗';
      addFeedItem({
        id: `dec-${trace.decisionId}`,
        type: 'decision',
        text: `${outcomeIcon} ${trace.outcome}: ${trace.summary}`,
        ts,
        outcome: trace.outcome,
        trace,
        amountMinor: trace.amountMinor,
      });
    }

    if (event.t === 'payment.settled') {
      setBalance(event.balanceAfterMinor);
      addFeedItem({ id: `set-${event.decisionId}`, type: 'settled', text: `✓ Settled — tx: ${event.txHash.slice(0, 10)}…`, ts, outcome: 'APPROVED', txHash: event.txHash });
    }

    if (event.t === 'payment.held') {
      setHolds(h => [...h, { decisionId: event.decisionId, expiresAtMs: event.expiresAtMs, amountMinor: event.amountMinor }]);
      addFeedItem({ id: `held-${event.decisionId}`, type: 'held', text: `⏸ Payment held — expires ${new Date(event.expiresAtMs).toLocaleTimeString()}`, ts, outcome: 'HELD', expiresAtMs: event.expiresAtMs });
    }

    if (event.t === 'hold.released') {
      setHolds(h => h.filter(x => x.decisionId !== event.decisionId));
    }

    if (event.t === 'attack.attempt') {
      addFeedItem({ id: `atk-${ts}`, type: 'attack', text: `${event.blocked ? '🛡 Blocked' : '⚠ Passed'}: ${event.technique} — ${event.revertReason}`, ts, outcome: event.blocked ? 'REFUSED' : 'APPROVED' });
    }
  }, []);

  const addFeedItem = useCallback((item: FeedItem) => {
    setFeed(prev => [item, ...prev].slice(0, 100));
    setTimeout(() => {
      feedRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }, 50);
  }, []);

  const handleSoftRevoke = async () => {
    if (!mandateId) return alert('No mandate connected. Start the core server first.');
    await fetch(`${CORE_URL}/v1/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mandateId, source: 'owner' }),
    });
  };

  const handleOnChainRevoke = () => {
    writeContract({ address: POLICY_MODULE_ADDRESS, abi: revokeAbi, functionName: 'revoke' });
  };

  const handleCancelHold = async (decisionId: string) => {
    await fetch(`${CORE_URL}/v1/hold/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisionId }),
    });
    setHolds(h => h.filter(x => x.decisionId !== decisionId));
  };

  const leasePercent = Math.max(0, Math.min(100, (leaseTtl / leaseTtlMax) * 100));

  return (
    <div className="console-layout">
      {/* ── Top Bar ── */}
      <header className="topbar">
        <div className="topbar-left">
          <div className={`core-dot ${coreUp ? 'up' : 'down'}`} title={coreUp ? 'Core online' : 'Core offline'} />
          <span className="topbar-brand">Lakshman Rekha</span>
          <AgentStatus pairing={pairing} error={pairError} leaseTtlMs={leaseTtl} />
          {frozen && <span className="frozen-chip">FROZEN</span>}
        </div>
        <div className="topbar-center">
          <div className="balance-block">
            <span className="balance-label">Available</span>
            <span className="balance-amount">{fmtInr(balance)}</span>
          </div>
        </div>
        <div className="topbar-right">
          <div className="lease-ring-wrap" title={`Lease TTL: ${leaseTtl}ms`}>
            <svg width="36" height="36" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="14" fill="none" stroke="var(--slate)" strokeWidth="3" />
              <circle
                cx="18" cy="18" r="14" fill="none"
                stroke={leaseTtl < 1500 ? 'var(--breach)' : 'var(--clear)'}
                strokeWidth="3"
                strokeDasharray={`${2 * Math.PI * 14}`}
                strokeDashoffset={`${2 * Math.PI * 14 * (1 - leasePercent / 100)}`}
                strokeLinecap="round"
                transform="rotate(-90 18 18)"
                style={{ transition: 'stroke-dashoffset 0.5s linear, stroke 0.3s' }}
              />
            </svg>
            <span className="lease-ttl-label">{(leaseTtl / 1000).toFixed(1)}s</span>
          </div>
          {isConnected ? (
            <button className="btn-ghost-sm" onClick={() => disconnect()}>
              {address?.slice(0, 6)}…{address?.slice(-4)} ✕
            </button>
          ) : (
            <button className="btn-ghost-sm" onClick={() => connect({ connector: injected() })}>
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      {/* ── Main Layout ── */}
      <div className="console-body">
        {/* Left: Feed */}
        <div className="feed-panel">
          <div className="panel-header">
            <h2>Live Transaction Feed</h2>
            <a href="/playground" className="btn-primary-sm">Playground →</a>
          </div>

          {/* Holds Inbox */}
          {holds.length > 0 && (
            <div className="holds-section">
              <h3 className="holds-title">Holds Inbox ({holds.length})</h3>
              {holds.map(hold => (
                <HoldCard key={hold.decisionId} hold={hold} onCancel={handleCancelHold} />
              ))}
            </div>
          )}

          <div className="feed-list" ref={feedRef}>
            {feed.length === 0 ? (
              <div className="feed-empty">No payments yet. Give your agent a task in the Playground.</div>
            ) : (
              feed.map(item => (
                <div
                  key={item.id}
                  className={`feed-item feed-${item.outcome?.toLowerCase() ?? 'info'} ${item.trace && selected?.decisionId === item.trace.decisionId ? 'selected' : ''}`}
                  onClick={() => item.trace && setSelected(item.trace)}
                  style={{ cursor: item.trace ? 'pointer' : 'default' }}
                >
                  <span className="feed-text">{item.text}</span>
                  <div className="feed-meta">
                    {item.amountMinor !== undefined && <span className="feed-amount">{fmtInr(item.amountMinor)}</span>}
                    {item.txHash && (
                      <a
                        href={`https://sepolia.basescan.org/tx/${item.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="feed-link"
                        onClick={e => e.stopPropagation()}
                      >
                        Basescan ↗
                      </a>
                    )}
                    <span className="feed-time">{timeAgo(item.ts)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right: Decision Panel + Controls */}
        <aside className="side-panel">
          {/* Revoke Controls */}
          <div className="revoke-card">
            <h3>Revoke Controls</h3>
            <p className="revoke-desc">Instantly stop all agent spending. Irreversible.</p>
            <button
              className="btn-revoke"
              onClick={handleSoftRevoke}
              disabled={frozen}
            >
              {frozen ? 'Already Revoked' : '⛔ Revoke Mandate (Core)'}
            </button>
            <button
              className="btn-revoke-onchain"
              onClick={handleOnChainRevoke}
              disabled={!isConnected || revokePending}
            >
              {revokePending ? 'Revoking on chain…' : '⛓ Revoke On-Chain (Wallet)'}
            </button>
            {!isConnected && (
              <p className="revoke-note">Connect wallet to revoke on-chain (works even if core is down)</p>
            )}
          </div>

          {/* Decision Panel */}
          <div className="decision-panel">
            <h3>Decision Panel</h3>
            {!selected ? (
              <p className="decision-empty">Click any decision in the feed to inspect the predicate trace.</p>
            ) : (
              <DecisionPanel trace={selected} />
            )}
          </div>

          {/* Enforcement Stack */}
          <div className="enforcement-card">
            <h3>Enforcement Stack</h3>
            <div className="enforcement-row">
              <span className="enforcement-label">Core</span>
              <span className={`enforcement-val ${coreUp ? 'ok' : 'err'}`}>{coreUp ? 'Online' : 'Offline'}</span>
            </div>
            <div className="enforcement-row">
              <span className="enforcement-label">Image Digest</span>
              <span className="enforcement-mono" title={imageDigest}>{imageDigest.slice(0, 20)}…</span>
            </div>
            <div className="enforcement-row">
              <span className="enforcement-label">PolicyModule</span>
              <a
                href={`https://sepolia.basescan.org/address/${POLICY_MODULE_ADDRESS}`}
                target="_blank"
                rel="noopener noreferrer"
                className="enforcement-link"
              >
                {POLICY_MODULE_ADDRESS.slice(0, 8)}… ↗
              </a>
            </div>
            <div className="enforcement-row">
              <span className="enforcement-label">Mandate</span>
              <span className={`enforcement-val ${frozen ? 'err' : 'ok'}`}>{frozen ? 'FROZEN' : 'Active'}</span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ── Hold Card ──────────────────────────────────
function HoldCard({ hold, onCancel }: { hold: HoldItem; onCancel: (id: string) => void }) {
  const [remaining, setRemaining] = useState(hold.expiresAtMs - Date.now());

  useEffect(() => {
    const t = setInterval(() => setRemaining(hold.expiresAtMs - Date.now()), 500);
    return () => clearInterval(t);
  }, [hold.expiresAtMs]);

  const pct = Math.max(0, Math.min(100, (remaining / 90_000) * 100));

  return (
    <div className="hold-card">
      <div className="hold-row">
        <span className="hold-amount">{fmtInr(hold.amountMinor)}</span>
        <span className="hold-id">{hold.decisionId}</span>
        <button className="btn-cancel" onClick={() => onCancel(hold.decisionId)}>Cancel</button>
      </div>
      <div className="hold-ring-track">
        <div className="hold-ring-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="hold-ttl">{remaining > 0 ? `Expires in ${Math.ceil(remaining / 1000)}s` : 'Expired'}</span>
    </div>
  );
}

// ── Decision Panel ─────────────────────────────
function DecisionPanel({ trace }: { trace: DecisionTrace }) {
  const outcomeColor = trace.outcome === 'APPROVED' ? 'var(--clear)' : trace.outcome === 'HELD' ? 'var(--lien)' : 'var(--breach)';

  return (
    <div className="decision-inner">
      <div className="decision-outcome" style={{ color: outcomeColor }}>
        {trace.outcome}
      </div>
      <p className="decision-summary">{trace.summary}</p>
      <div className="decision-meta">
        <span>Latency: {trace.latencyMs}ms</span>
        <span>{fmtInr(trace.amountMinor)}</span>
      </div>
      <table className="predicate-table">
        <thead>
          <tr>
            <th>Predicate</th>
            <th>Expected</th>
            <th>Actual</th>
            <th>Pass</th>
          </tr>
        </thead>
        <tbody>
          {trace.predicates.map(pred => (
            <tr
              key={pred.name}
              className={pred.name === trace.bindingPredicate ? 'binding-row' : ''}
            >
              <td className="pred-name">{pred.name}</td>
              <td className="pred-expected">{pred.expected}</td>
              <td className={`pred-actual ${pred.passed ? 'pass' : 'fail'}`}>{pred.actual}</td>
              <td>{pred.passed ? '✓' : '✗'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="decision-hash">
        <span>Policy: </span>
        <code className="mono-sm">{trace.policyHash.slice(0, 18)}…</code>
      </div>
      <div className="decision-hash">
        <span>Image: </span>
        <code className="mono-sm">{trace.coreImageDigest.slice(0, 18)}…</code>
      </div>
    </div>
  );
}
