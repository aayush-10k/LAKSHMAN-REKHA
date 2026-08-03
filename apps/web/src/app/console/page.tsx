'use client';

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useWriteContract, useAccount, useConnect, useDisconnect } from 'wagmi';
import { injected } from 'wagmi/connectors';
import type { DecisionTrace, RekhaEvent } from '../../types';
import { CORE_URL, ensurePaired, renewLease, type Pairing } from '../../lib/pairing';
import { CONTRACTS, POLICY_MODULE_ADDRESS, basescanAddress, basescanTx, shortHex } from '../../lib/contracts';
import { Amount, formatInrMinor } from '../../components/Amount';
import { TTLRing } from '../../components/TTLRing';
import { PredicateTable } from '../../components/PredicateTable';
import { CoreOffline } from '../../components/CoreOffline';

const VENDORSIM_URL = process.env['NEXT_PUBLIC_VENDORSIM_URL'] ?? 'http://localhost:4100';

const revokeAbi = [{ type: 'function', name: 'revoke', stateMutability: 'nonpayable', inputs: [], outputs: [] }] as const;

/**
 * One row per payment, not one row per event.
 *
 * The old feed pushed a separate row for payment.requested, decision.made,
 * payment.held and payment.settled, so a single ₹9,400 purchase produced three
 * lines saying different things about the same money. Rows are keyed by
 * decisionId and later events merge into the row they belong to — which is also
 * the only way "settled · 380ms · 0xfc29…" can appear on one line, since the
 * latency comes from decision.made and the hash from payment.settled.
 */
type RowState = 'settled' | 'approved' | 'held' | 'refused' | 'revocation';

type FeedRow = {
  /** decisionId for payments; a synthetic id for revocation notices. */
  id: string;
  state: RowState;
  ts: number;
  counterpartyId?: string;
  amountMinor?: number;
  latencyMs?: number;
  txHash?: string;
  trace?: DecisionTrace;
  /** Set on held rows. */
  expiresAtMs?: number;
  /** When this browser learned of the hold — the ring's denominator. */
  heldSinceMs?: number;
  /** Only for rows that are not payments (revocation). */
  note?: string;
};

type MandateSnapshot = {
  frozen: boolean;
  revocationEpoch: number;
  windowSpentMinor: number;
  windowCapMinor: number;
  perTxCapMinor: number;
};

const STATE_LABEL: Record<RowState, string> = {
  settled: 'settled',
  approved: 'approved',
  held: 'held',
  refused: 'refused',
  revocation: 'revoked',
};

function timeAgo(ts: number, now: number) {
  const d = now - ts;
  if (d < 5000) return 'just now';
  if (d < 60000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  return `${Math.floor(d / 3600000)}h ago`;
}

export default function ConsolePage() {
  const [rows, setRows] = useState<FeedRow[]>([]);
  const [selected, setSelected] = useState<DecisionTrace | null>(null);

  // RekhaAccount's on-chain INRx balance. null until read, and null again if a
  // read fails — never a placeholder that looks like real money.
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [mandate, setMandate] = useState<MandateSnapshot | null>(null);
  const [frozen, setFrozen] = useState(false);

  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);

  const [coreUp, setCoreUp] = useState(false);
  /**
   * Tri-state on purpose (FIX3.md BUG 3). 'checking' is not 'down': a boolean
   * would flash the offline panel on every load before the health probe returns,
   * and an offline warning that cries wolf gets ignored when it is real.
   */
  const [coreReach, setCoreReach] = useState<'checking' | 'up' | 'down'>('checking');
  const [coreReachReason, setCoreReachReason] = useState<string | null>(null);

  const [leaseTtl, setLeaseTtl] = useState(0);
  /** Configured lease TTL, read from the core. The ring denominator, not a guess. */
  const [leaseTtlMax, setLeaseTtlMax] = useState(15000);
  const [imageDigest, setImageDigest] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  /**
   * Vendor display names, fetched from the vendor registry — deliberately NOT a
   * string on FactSheet. FINALE.md Part 5: the FactSheet stays numeric, because a
   * field the policy engine cannot read is a field an injected page can write to.
   * Names are cosmetic, so they are fetched separately and degrade to the id.
   */
  const [vendorNames, setVendorNames] = useState<Record<string, string>>({});

  /** Drives the held countdowns and the "3m ago" column. One timer, not one per row. */
  const [now, setNow] = useState(() => Date.now());

  const { writeContract, isPending: revokePending, error: revokeError } = useWriteContract();
  const { address, isConnected } = useAccount();
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const loadBalance = useCallback(() => {
    fetch(`${CORE_URL}/v1/wallet/balance`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error?.message ?? `HTTP ${r.status}`);
        return body;
      })
      .then((d) => {
        if (typeof d.balanceMinor === 'number') {
          setBalance(d.balanceMinor);
          setBalanceError(null);
        }
      })
      .catch((e: Error) => {
        // Fail visible: the figure reads "unavailable" rather than showing a
        // plausible number, and the reason goes on screen, not just the console.
        setBalance(null);
        setBalanceError(e.message);
      });
  }, []);

  const loadMandate = useCallback((mandateId: string) => {
    fetch(`${CORE_URL}/v1/mandate/${mandateId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((m) => {
        setMandate({
          frozen: !!m.frozen,
          revocationEpoch: m.revocationEpoch ?? 0,
          windowSpentMinor: m.windowSpentMinor ?? 0,
          windowCapMinor: m.windowCapMinor ?? 0,
          perTxCapMinor: m.perTxCapMinor ?? 0,
        });
        if (m.frozen) setFrozen(true);
      })
      .catch((e: Error) => console.error('[console] mandate read failed:', e.message));
  }, []);

  // Boot: probe the core, pair, then load balance, holds and vendor names.
  useEffect(() => {
    fetch(`${CORE_URL}/health`)
      .then((r) => {
        if (!r.ok) throw new Error(`core answered HTTP ${r.status}`);
        return r.json();
      })
      .then((h) => {
        setCoreReach('up');
        setCoreReachReason(null);
        // `up` is about issuance, not process liveness: a killed core still
        // answers /health, and that is exactly the state that must not look fine.
        setCoreUp(h.issuanceKilledAtMs === null);
        if (h.leaseTtlMs) setLeaseTtlMax(h.leaseTtlMs);
      })
      .catch((e: Error) => {
        setCoreUp(false);
        setCoreReach('down');
        setCoreReachReason(e.message);
      });

    ensurePaired()
      .then((p) => {
        setPairing(p);
        setLeaseTtlMax(p.leaseTtlMs);
        setLeaseTtl(p.leaseTtlMs); // until the first lease.tick lands
        setPairError(null);
        loadMandate(p.mandateId);
      })
      .catch((e: Error) => setPairError(e.message));

    loadBalance();

    fetch(`${CORE_URL}/v1/holds`)
      .then((r) => r.json())
      .then((d) => {
        if (!Array.isArray(d.holds)) return;
        const learnedAt = Date.now();
        type Hold = { decisionId: string; expiresAtMs: number; amountMinor: number };
        const holds: Hold[] = d.holds;

        /**
         * MERGE, never skip. This and the audit-export read below race, and the
         * export creates the same row without any hold fields. Filtering out
         * ids already present meant that whenever the export landed first, the
         * countdown ring, the Cancel button and the "held" total all silently
         * vanished — the row was there, in amber, with nothing to act on.
         */
        setRows((prev) => {
          const seen = new Set<string>();
          const merged = prev.map((r) => {
            const h = holds.find((x) => x.decisionId === r.id);
            if (!h) return r;
            seen.add(h.decisionId);
            return {
              ...r,
              state: 'held' as const,
              amountMinor: r.amountMinor ?? h.amountMinor,
              expiresAtMs: h.expiresAtMs,
              heldSinceMs: r.heldSinceMs ?? learnedAt,
            };
          });
          const fresh: FeedRow[] = holds
            .filter((h) => !seen.has(h.decisionId))
            .map((h) => ({
              id: h.decisionId,
              state: 'held' as const,
              ts: learnedAt,
              amountMinor: h.amountMinor,
              expiresAtMs: h.expiresAtMs,
              heldSinceMs: learnedAt,
            }));
          return [...fresh, ...merged];
        });
      })
      .catch((e: Error) => console.error('[console] holds read failed:', e.message));

    /**
     * Payments that happened before this page was opened.
     *
     * The live feed is SSE-only by design, and the consequence is that a
     * refresh — or a judge opening the console after a rehearsal — shows an
     * empty screen even though real payments settled minutes ago. This is one
     * historical read at boot, the same shape as the balance and holds reads
     * above, not polling. Live events merge on top by decisionId.
     */
    fetch(`${CORE_URL}/v1/audit/export`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((doc) => {
        const body = doc?.body ?? doc;
        const decisions: DecisionTrace[] = Array.isArray(body?.decisions) ? body.decisions : [];
        const settlements: Array<{ decisionId: string; txHash: string }> = Array.isArray(body?.settlements)
          ? body.settlements
          : [];
        const txByDecision = new Map(settlements.map((s) => [s.decisionId, s.txHash]));

        const historical: FeedRow[] = decisions.map((trace) => {
          const txHash = txByDecision.get(trace.decisionId);
          const state: RowState = txHash
            ? 'settled'
            : trace.outcome === 'APPROVED'
              ? 'approved'
              : trace.outcome === 'HELD'
                ? 'held'
                : 'refused';
          return {
            id: trace.decisionId,
            state,
            ts: trace.evaluatedAtMs,
            counterpartyId: trace.counterpartyId,
            amountMinor: trace.amountMinor,
            latencyMs: trace.latencyMs,
            trace,
            ...(txHash ? { txHash } : {}),
          };
        });

        // Merge both directions, for the same reason the holds read above does:
        // a row created by the holds read has expiresAtMs but no trace, so
        // skipping it here would leave it permanently unclickable. Hold fields
        // win where both have them — they are the live ones.
        setRows((prev) => {
          const seen = new Set<string>();
          const merged = prev.map((r) => {
            const h = historical.find((x) => x.id === r.id);
            if (!h) return r;
            seen.add(h.id);
            return { ...h, ...r, state: r.expiresAtMs !== undefined ? r.state : h.state };
          });
          return [...merged, ...historical.filter((h) => !seen.has(h.id))]
            .sort((a, b) => b.ts - a.ts)
            .slice(0, 100);
        });
      })
      .catch((e: Error) => console.error('[console] payment history unavailable:', e.message));

    fetch(`${VENDORSIM_URL}/catalog`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((list: Array<{ id: string; name: string; address?: string }>) => {
        if (!Array.isArray(list)) return;
        // Keyed by BOTH id and lowercased address: DecisionTrace.counterpartyId
        // carries the vendor's on-chain address (measured — a refused SOFTWARE
        // trace returns 0x0708…192a, not "ven_pixelvault"), while the holds and
        // catalog use the ven_* id. Keying on one of them silently falls back to
        // raw hex for every row.
        const map: Record<string, string> = {};
        for (const v of list) {
          map[v.id] = v.name;
          if (v.address) map[v.address.toLowerCase()] = v.name;
        }
        setVendorNames(map);
      })
      .catch((e: Error) => {
        // Non-fatal by design: rows fall back to the vendor id, which is the
        // real identifier anyway. Logged rather than swallowed.
        console.error('[console] vendor names unavailable, showing ids:', e.message);
      });
  }, [loadBalance, loadMandate]);

  // Keep the lease alive so the TTL ring shows a real lease rather than a
  // decorative one. renewLease re-pairs by itself if the core has restarted and
  // forgotten this agentId.
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
          setPairing((p) => (p ? { ...p, agentId: lease.agentId } : p));
        }
        setLeaseTtlMax(lease.ttlMs);
        setPairError(null);
      } catch (e) {
        if (!stopped) setPairError((e as Error).message);
      }
    };

    void tick();
    const timer = setInterval(tick, Math.max(1000, pairing.leaseTtlMs * 0.6));
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pairing?.agentId, pairing?.leaseTtlMs]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Merge an event into the row it belongs to, creating it if needed. */
  const upsert = useCallback((id: string, patch: Partial<FeedRow> & { state: RowState; ts: number }) => {
    setRows((prev) => {
      const i = prev.findIndex((r) => r.id === id);
      if (i === -1) return [{ id, ...patch }, ...prev].slice(0, 100);
      const next = [...prev];
      next[i] = { ...next[i]!, ...patch };
      return next;
    });
  }, []);

  const processEvent = useCallback(
    (event: RekhaEvent) => {
      const ts = Date.now();

      switch (event.t) {
        case 'core.status':
          setCoreUp(event.up);
          setImageDigest(event.imageDigest);
          return;

        case 'lease.tick':
          setLeaseTtl(event.ttlMs);
          return;

        case 'revocation':
          setFrozen(true);
          setRows((prev) =>
            [
              {
                id: `rev-${event.epoch}-${ts}`,
                state: 'revocation' as const,
                ts,
                note: `Spending stopped by ${event.source}. Revocation epoch ${event.epoch}.`,
              },
              ...prev,
            ].slice(0, 100),
          );
          return;

        case 'decision.made': {
          const { trace } = event;
          const state: RowState =
            trace.outcome === 'APPROVED' ? 'approved' : trace.outcome === 'HELD' ? 'held' : 'refused';
          upsert(trace.decisionId, {
            state,
            ts,
            counterpartyId: trace.counterpartyId,
            amountMinor: trace.amountMinor,
            latencyMs: trace.latencyMs,
            trace,
          });
          return;
        }

        case 'payment.settled':
          // Only ever the chain-read balance. null means the post-settlement read
          // failed — the payment happened, the figure is unknown, and showing the
          // last known number would present a stale value as current.
          setBalance(event.balanceAfterMinor ?? null);
          setBalanceError(event.balanceAfterMinor === null ? 'the post-settlement balance read failed' : null);
          upsert(event.decisionId, {
            state: 'settled',
            ts,
            txHash: event.txHash,
            amountMinor: event.amountMinor,
            expiresAtMs: undefined,
          });
          if (pairing) loadMandate(pairing.mandateId);
          return;

        case 'payment.held':
          upsert(event.decisionId, {
            state: 'held',
            ts,
            amountMinor: event.amountMinor,
            expiresAtMs: event.expiresAtMs,
            heldSinceMs: ts,
          });
          return;

        case 'hold.released':
          // The hold is gone; the row keeps whatever the decision was. A release
          // is not itself an outcome, so it must not repaint the row green.
          setRows((prev) =>
            prev.map((r) =>
              r.id === event.decisionId ? { ...r, expiresAtMs: undefined, heldSinceMs: undefined } : r,
            ),
          );
          return;

        case 'ceremony.aborted':
          upsert(event.decisionId, {
            state: 'refused',
            ts,
            note:
              event.reason === 'revoked'
                ? `Signing stopped at round ${event.atRound}. The signature was never completed.`
                : `Signing timed out at round ${event.atRound}.`,
          });
          return;

        default:
          // task.started, agent.thought, quote.received, payment.requested,
          // attack.attempt — the agent's working detail and Rogue Mode belong to
          // the Playground. This feed is the owner's money, and nothing else.
          return;
      }
    },
    [upsert, loadMandate, pairing],
  );

  // SSE subscription. All console state comes from here — there is no polling.
  useEffect(() => {
    const evtSource = new EventSource(`${CORE_URL}/v1/events`);
    evtSource.onmessage = (e) => processEvent(JSON.parse(e.data) as RekhaEvent);
    evtSource.onerror = () => setCoreUp(false);
    return () => evtSource.close();
  }, [processEvent]);

  const handleCancelHold = async (decisionId: string) => {
    try {
      const res = await fetch(`${CORE_URL}/v1/hold/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisionId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      setRows((prev) =>
        prev.map((r) => (r.id === decisionId ? { ...r, expiresAtMs: undefined, heldSinceMs: undefined } : r)),
      );
    } catch (e) {
      // The row must not clear for a cancel that did not happen.
      setCancelError(`Could not cancel ${decisionId}: ${(e as Error).message}`);
    }
  };

  /**
   * REVOKE ALL goes straight from the owner's wallet to PolicyModule.revoke().
   * It deliberately does NOT go through the core API: the whole claim is that
   * the owner can stop spending with our servers switched off, and routing it
   * through our server would quietly make that false.
   */
  const handleRevokeAll = () => {
    if (!isConnected) return connect({ connector: injected() });
    writeContract({ address: POLICY_MODULE_ADDRESS, abi: revokeAbi, functionName: 'revoke' });
  };

  const heldTotal = useMemo(
    () =>
      rows
        .filter((r) => r.expiresAtMs !== undefined && r.expiresAtMs > now)
        .reduce((sum, r) => sum + (r.amountMinor ?? 0), 0),
    [rows, now],
  );

  /** Falls back to the identifier itself — which is real — never to a guess. */
  const displayName = (id?: string) => {
    if (!id) return 'unknown counterparty';
    return vendorNames[id] ?? vendorNames[id.toLowerCase()] ?? (id.startsWith('0x') ? shortHex(id, 8, 6) : id);
  };

  // FIX3.md BUG 3: an unreachable core replaces the console rather than
  // decorating it. Every panel below reads from the core, so leaving them on
  // screen would render an interface whose numbers are all absent or stale while
  // still looking operational.
  if (coreReach === 'down') {
    return (
      <div className="console-layout">
        <CoreOffline reason={coreReachReason} />
      </div>
    );
  }

  return (
    <div className="console-layout">
      {/* ── Top bar: the hero figure, the lease, the kill ── */}
      <header className="con-topbar">
        <div className="con-hero">
          <Amount minor={balance} className="con-balance" />
          <div className="con-hero-meta">
            <span className="con-hero-label">available</span>
            {balanceError && <span className="con-hero-err">balance unreadable — {balanceError}</span>}
            {!balanceError && (
              <>
                <span className="con-hero-stat">
                  held <span className="con-stat-lien">{formatInrMinor(heldTotal, true)}</span>
                </span>
                {mandate && (
                  <span className="con-hero-stat" title="On-chain rolling 24-hour window. A core restart does not reset it.">
                    spent{' '}
                    <span className="con-stat-mono">{formatInrMinor(mandate.windowSpentMinor, true)}</span> of{' '}
                    {formatInrMinor(mandate.windowCapMinor, true)} · 24h window
                  </span>
                )}
              </>
            )}
          </div>
        </div>

        <div className="con-topbar-right">
          <div className="con-lease" title={pairError ?? `Lease TTL ${leaseTtl}ms of ${leaseTtlMax}ms`}>
            <TTLRing ttlMs={leaseTtl} maxMs={leaseTtlMax} size={36} />
            <div className="con-lease-text">
              <span className="con-lease-value">{(Math.max(0, leaseTtl) / 1000).toFixed(1)}s</span>
              <span className="con-lease-label">lease</span>
            </div>
          </div>

          <div className={`con-status ${coreUp ? 'is-up' : 'is-down'}`}>
            <span className="con-status-dot" />
            <span>{coreUp ? 'core up' : 'core stopped'}</span>
          </div>

          {frozen && <span className="con-frozen">REVOKED</span>}

          <div className="con-wallet">
            {isConnected ? (
              <button className="con-btn-ghost" onClick={() => disconnect()} title={address}>
                {shortHex(address ?? '')} ✕
              </button>
            ) : null}
            <button className="con-btn-revoke" onClick={handleRevokeAll} disabled={revokePending}>
              {revokePending ? 'Revoking…' : isConnected ? 'REVOKE ALL' : 'Connect wallet to revoke'}
            </button>
          </div>
        </div>
      </header>

      {revokeError && (
        <div className="con-banner con-banner-err">Revoke was not sent — {revokeError.message}</div>
      )}
      {pairError && <div className="con-banner con-banner-err">Agent not paired — {pairError}</div>}
      {cancelError && <div className="con-banner con-banner-err">{cancelError}</div>}

      <div className="console-body">
        {/* ── Left: transactions ── */}
        <section className="feed-panel">
          <div className="panel-header">
            <h2>Transactions</h2>
            <a href="/playground" className="con-link-page">Playground →</a>
          </div>

          <div className="feed-list">
            {rows.length === 0 ? (
              <div className="feed-empty">No payments yet. Give your agent a task in the Playground.</div>
            ) : (
              rows.map((row) => {
                const holdLive = row.expiresAtMs !== undefined && row.expiresAtMs > now;
                const isSelected = !!row.trace && selected?.decisionId === row.trace.decisionId;
                return (
                  <div
                    key={row.id}
                    className={`con-row con-row-${row.state} ${isSelected ? 'is-selected' : ''} ${row.trace ? 'is-clickable' : ''}`}
                    onClick={() => row.trace && setSelected(row.trace)}
                    role={row.trace ? 'button' : undefined}
                    tabIndex={row.trace ? 0 : undefined}
                    onKeyDown={(e) => {
                      if (row.trace && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        setSelected(row.trace);
                      }
                    }}
                  >
                    <div className="con-row-main">
                      <Amount minor={row.amountMinor ?? null} compact className="con-row-amount" />
                      <span className="con-row-party">
                        {row.state === 'revocation' ? 'Mandate revoked' : displayName(row.counterpartyId)}
                      </span>
                      <span className="con-row-time">{timeAgo(row.ts, now)}</span>
                    </div>

                    <div className="con-row-meta">
                      <span className={`con-row-state con-state-${row.state}`}>{STATE_LABEL[row.state]}</span>
                      {row.note && <span className="con-row-note">{row.note}</span>}
                      {row.latencyMs !== undefined && !row.note && <span>{row.latencyMs}ms</span>}
                      {row.state === 'refused' && row.trace?.bindingPredicate && !row.note && (
                        <span className="con-row-binding">{row.trace.bindingPredicate}</span>
                      )}
                      {row.txHash && (
                        <a
                          href={basescanTx(row.txHash)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="con-row-link"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {shortHex(row.txHash, 8, 4)} ↗
                        </a>
                      )}
                    </div>

                    {holdLive && (
                      <div className="con-row-hold">
                        <TTLRing
                          ttlMs={row.expiresAtMs! - now}
                          maxMs={Math.max(1, row.expiresAtMs! - (row.heldSinceMs ?? row.ts))}
                          size={24}
                        />
                        <span className="con-hold-ttl">
                          {Math.ceil((row.expiresAtMs! - now) / 1000)}s left
                        </span>
                        <button
                          className="con-btn-cancel"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleCancelHold(row.id);
                          }}
                        >
                          Cancel payment
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* ── Right: the decision ── */}
        <aside className="side-panel">
          <div className="panel-header">
            <h2>Decision</h2>
          </div>

          <div className="con-decision">
            {!selected ? (
              <p className="decision-empty">
                Pick a payment on the left to see every rule it was checked against, and the one that decided it.
              </p>
            ) : (
              <PredicateTable trace={selected} />
            )}
          </div>

          <div className="con-enforcement">
            <h3>Enforcement</h3>
            <div className="con-kv">
              <span>approval service</span>
              <span className={coreUp ? 'con-ok' : 'con-bad'}>{coreUp ? 'issuing leases' : 'not issuing'}</span>
            </div>
            <div className="con-kv">
              <span>mandate</span>
              <span className={frozen ? 'con-bad' : 'con-ok'}>{frozen ? 'revoked' : 'active'}</span>
            </div>
            {mandate && (
              <>
                <div className="con-kv">
                  <span>revocation epoch</span>
                  <span className="con-mono">{mandate.revocationEpoch}</span>
                </div>
                <div className="con-kv">
                  <span>per-payment cap</span>
                  <span className="con-mono">{formatInrMinor(mandate.perTxCapMinor, true)}</span>
                </div>
              </>
            )}
            <div className="con-kv">
              <span>core image</span>
              <span className="con-mono" title={imageDigest ?? undefined}>
                {imageDigest ? shortHex(imageDigest, 14, 6) : 'waiting for core.status…'}
              </span>
            </div>
            {pairing && (
              <div className="con-kv">
                <span>agent</span>
                <span className="con-mono">{pairing.agentId}</span>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* ── Bottom strip: the part a judge can check without trusting us ── */}
      <footer className="con-strip">
        {CONTRACTS.map((c) => (
          <a
            key={c.address}
            href={basescanAddress(c.address)}
            target="_blank"
            rel="noopener noreferrer"
            className="con-strip-item"
            title={c.note}
          >
            <span className="con-strip-name">{c.name}</span>
            <span className="con-strip-addr">{shortHex(c.address, 8, 4)}</span>
          </a>
        ))}
        <span className="con-strip-tail">Base Sepolia · verified source ↗</span>
      </footer>
    </div>
  );
}
