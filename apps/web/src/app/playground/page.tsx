'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { CategoryCode, DecisionTrace, RekhaEvent } from '../../types';
import { CORE_URL, ensurePaired, type Pairing } from '../../lib/pairing';
import { AgentStatus } from '../../components/AgentStatus';

/**
 * The agent runs in its own process holding the other half of the 2-of-2, so
 * Dispatch talks to it and not to the core. See apps/core/src/agent/runner.ts.
 */
const AGENT_URL = process.env['NEXT_PUBLIC_AGENT_URL'] ?? 'http://localhost:4200';

/**
 * The vendor registry is its own service (apps/vendorsim). "Spawn Counterfeit"
 * and "Inject" are its endpoints, and the playground was calling the CORE for
 * both — /v1/vendorsim/counterfeit and /v1/task/inject, neither of which exists.
 * Both 404s were swallowed by `.catch(() => {})` and reported as success.
 */
const VENDORSIM_URL = process.env['NEXT_PUBLIC_VENDORSIM_URL'] ?? 'http://localhost:4100';

type Vendor = { id: string; name: string; tier: number; address: string };

/** Outcome of a judge control, shown verbatim. Never a fabricated success. */
type ControlResult = { ok: boolean; text: string } | null;

type BehaviourMode = 'normal' | 'hallucinating' | 'injected' | 'compromised' | 'overreach' | 'colluding';
type AttackLog = { id: number; technique: string; revertReason: string; blocked: boolean; novel: boolean; ts: number };
type CeremonyState = { decisionId: string; round: number; of: number; aborted: boolean; abortedAt: number | null };

type PlanItem = { lineItemId: string; vendorId: string; categoryCode: CategoryCode; estimatedAmountMinor: number; description: string };

/** One line item's whole journey, as the agent runner reports it. */
type LineItemResult = {
  lineItemId: string;
  vendorId: string;
  counterparty: string;
  amountMinor: number;
  outcome: 'APPROVED' | 'HELD' | 'REFUSED';
  bindingPredicate: string | null;
  decisionId: string;
  trace: DecisionTrace;
  settlement: { txHash: string; blockNumber: number; balanceAfterMinor: number | null; explorerUrl: string } | null;
  refusedOnChain: string | null;
};

type TaskRow = {
  id: string;
  description: string;
  status: 'running' | 'done' | 'failed';
  mode: BehaviourMode;
  plan: PlanItem[];
  results: LineItemResult[];
  error: string | null;
};

const MODE_INFO: Record<BehaviourMode, { label: string; description: string; color: string }> = {
  normal:       { label: 'Normal',        description: 'Executes tasks correctly. Zero friction.',                              color: 'var(--clear)' },
  hallucinating:{ label: 'Hallucinating', description: 'Invents vendors, wrong quantities, duplicate orders.',                  color: 'var(--lien)' },
  injected:     { label: 'Injected',      description: 'Reads pages with hidden instructions. Enforcement stops it anyway.',    color: 'var(--lien)' },
  compromised:  { label: 'Compromised',   description: 'Full attack mode — 12 adversarial classes running live.',              color: 'var(--breach)' },
  overreach:    { label: 'Overreach',     description: 'Buys extras, upgrades shipping, unauthorised scope expansion.',         color: 'var(--lien)' },
  colluding:    { label: 'Colluding',     description: 'Registers a vendor it controls, routes payments to itself.',            color: 'var(--breach)' },
};

function fmtInr(minor: number) {
  return '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

export default function PlaygroundPage() {
  const [mode, setMode] = useState<BehaviourMode>('normal');
  const [taskInput, setTaskInput] = useState('');
  const [injectText, setInjectText] = useState('');
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [selectedTrace, setSelectedTrace] = useState<DecisionTrace | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [balanceMinor, setBalanceMinor] = useState<number | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [agentThoughts, setAgentThoughts] = useState<string[]>([]);
  const [attackLog, setAttackLog] = useState<AttackLog[]>([]);
  const [rogueStats, setRogueStats] = useState({ attempts: 0, blocked: 0, novel: 0, fundsLost: 0 });
  const [ceremony, setCeremony] = useState<CeremonyState | null>(null);
  const [leaseTtl, setLeaseTtl] = useState(5000);
  const [leaseTtlMax, setLeaseTtlMax] = useState(5000);
  const [coreUp, setCoreUp] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  // Judge controls (FIX3.md BUG 4): the target vendor, and the last real result
  // of each control. Both controls need a vendor — vendorsim's endpoints take a
  // vendorId, which is why calling the core for them could never have worked.
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [targetVendorId, setTargetVendorId] = useState('');
  const [counterfeitResult, setCounterfeitResult] = useState<ControlResult>(null);
  const [injectResult, setInjectResult] = useState<ControlResult>(null);
  const [killResult, setKillResult] = useState<ControlResult>(null);
  const attackIdRef = useRef(0);
  const thoughtsRef = useRef<HTMLDivElement>(null);

  // Pair on load against the core's CURRENT code (FIX2.md BUG 2). The agentId is
  // what Dispatch hands the agent runner, so this has to succeed before a task
  // can spend anything.
  useEffect(() => {
    ensurePaired()
      .then(p => {
        setPairing(p);
        setLeaseTtlMax(p.leaseTtlMs);
        // Show the configured TTL until the first lease.tick arrives, rather
        // than the 5000 the component initialises with.
        setLeaseTtl(p.leaseTtlMs);
        setPairError(null);
      })
      .catch((e: Error) => setPairError(e.message));
  }, []);

  // The vendor catalogue, for the judge controls. Both of them target a specific
  // vendor, so the selector has to be populated from the registry that actually
  // holds them rather than from a list hardcoded here.
  useEffect(() => {
    fetch(`${VENDORSIM_URL}/catalog`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((list: Vendor[]) => {
        setVendors(list);
        if (list.length > 0) setTargetVendorId(prev => prev || list[0].id);
      })
      .catch(() => {
        // Leave the list empty: the controls then say vendorsim is unreachable
        // when pressed, instead of offering a menu of vendors that do not exist.
        setVendors([]);
      });
  }, []);

  // RekhaAccount's INRx balance on Base Sepolia. Not a number this page keeps —
  // a failed read shows as unavailable rather than as a stale figure.
  const refreshBalance = useCallback(async () => {
    try {
      const res = await fetch(`${CORE_URL}/v1/wallet/balance`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setBalanceMinor(body.balanceMinor);
      setBalanceError(null);
    } catch (e) {
      setBalanceMinor(null);
      setBalanceError((e as Error).message);
    }
  }, []);

  useEffect(() => { void refreshBalance(); }, [refreshBalance]);

  // SSE
  useEffect(() => {
    const evtSource = new EventSource(`${CORE_URL}/v1/events`);

    evtSource.onmessage = (e) => {
      const event: RekhaEvent = JSON.parse(e.data);
      handleEvent(event);
    };

    evtSource.onerror = () => setCoreUp(false);
    evtSource.onopen = () => setCoreUp(true);

    return () => evtSource.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEvent = useCallback((event: RekhaEvent) => {
    if (event.t === 'core.status') { setCoreUp(event.up); return; }
    if (event.t === 'lease.tick') { setLeaseTtl(event.ttlMs); return; }

    if (event.t === 'task.started') {
      setTasks(prev => [{
        id: event.taskId,
        description: event.description,
        status: 'running',
        mode: event.mode as BehaviourMode,
        plan: event.plan as PlanItem[],
        results: [],
        error: null,
      }, ...prev]);
    }

    // The decision arrives on the stream before the runner's reply does, so the
    // trace panel fills in while the settlement is still being mined.
    if (event.t === 'decision.made') {
      setSelectedTrace(event.trace);
    }

    if (event.t === 'agent.thought') {
      setAgentThoughts(prev => [...prev.slice(-49), event.text]);
      setTimeout(() => {
        if (thoughtsRef.current) thoughtsRef.current.scrollTop = thoughtsRef.current.scrollHeight;
      }, 30);
    }

    if (event.t === 'attack.attempt') {
      const id = ++attackIdRef.current;
      const entry: AttackLog = {
        id,
        technique: event.technique,
        revertReason: event.revertReason,
        blocked: event.blocked,
        novel: event.novel,
        ts: Date.now(),
      };
      setAttackLog(prev => [entry, ...prev].slice(0, 200));
      setRogueStats(prev => ({
        attempts: prev.attempts + 1,
        blocked: event.blocked ? prev.blocked + 1 : prev.blocked,
        novel: event.novel ? prev.novel + 1 : prev.novel,
        fundsLost: event.blocked ? prev.fundsLost : prev.fundsLost + 1,
      }));
    }

    if (event.t === 'ceremony.round') {
      setCeremony({ decisionId: event.decisionId, round: event.round, of: event.of, aborted: false, abortedAt: null });
    }

    if (event.t === 'ceremony.aborted') {
      setCeremony(prev => prev ? { ...prev, aborted: true, abortedAt: event.atRound } : null);
      setTimeout(() => setCeremony(null), 3000);
    }

    if (event.t === 'payment.settled') {
      // Only the chain-read balance is shown. null means the post-settlement
      // read failed; the payment still happened, we just cannot state a figure.
      if (event.balanceAfterMinor !== null && event.balanceAfterMinor !== undefined) {
        setBalanceMinor(event.balanceAfterMinor);
        setBalanceError(null);
      } else {
        setBalanceMinor(null);
        setBalanceError('post-settlement balance read failed');
      }
    }
  }, []);

  /**
   * Dispatch.
   *
   * It used to POST /v1/task — a route that does not exist; the real one is
   * /v1/task/create — and even that only announced a task. Nothing asked for a
   * lease, built a FactSheet, requested a decision or settled, so the button
   * could never produce a trace or a txHash.
   *
   * It now calls the agent runner, which holds the other half of the 2-of-2 and
   * runs the whole path. The reply carries each line item's decision and, for an
   * approved one, the mined transaction.
   */
  /**
   * Rogue Mode: run the twelve deterministic attack classes against the core.
   *
   * FIX3.md BUG 5. `mode` used to be threaded all the way through and then
   * ignored — every behaviour ran the same honest path and no attack.attempt
   * event existed anywhere, so the scoreboard sat at 0 · 0 · 0 · ₹0 and read as
   * "nobody tried" rather than "nothing got through".
   *
   * The counters are driven by the SSE attack.attempt stream, not by this
   * response: the board fills as the core reports each verdict. On failure the
   * score stays at zero and the row carries the error, because a scoreboard
   * that invents a 12/12 is worth less than no scoreboard at all.
   */
  const runAdversary = async (description: string) => {
    const rowId = `rogue-${Date.now()}`;
    setTasks(prev => [{ id: rowId, description, status: 'running', mode, plan: [], results: [], error: null }, ...prev]);
    setAttackLog([]);
    setRogueStats({ attempts: 0, blocked: 0, novel: 0, fundsLost: 0 });

    try {
      const res = await fetch(`${CORE_URL}/v1/adversary/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'deterministic' }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setTasks(prev => prev.map(t => (t.id === rowId
          ? { ...t, status: 'failed', error: body?.error?.message ?? `Adversary run failed (HTTP ${res.status}).` }
          : t)));
        return;
      }

      const s = body.summary;
      setTasks(prev => prev.map(t => (t.id === rowId
        ? {
            ...t,
            status: 'done',
            error: s.total === s.blocked
              ? null
              : `${s.total - s.blocked} of ${s.total} attacks were NOT blocked. See the attack log.`,
          }
        : t)));
    } catch (e) {
      setTasks(prev => prev.map(t => (t.id === rowId
        ? { ...t, status: 'failed', error: `Could not reach the core at ${CORE_URL}. No attacks were run. (${(e as Error).message})` }
        : t)));
    }
  };

  const dispatchTask = async () => {
    if (!taskInput.trim() || dispatching) return;
    const description = taskInput.trim();
    setDispatching(true);
    setTaskInput('');

    if (mode === 'compromised') {
      await runAdversary(description);
      setDispatching(false);
      return;
    }

    try {
      const res = await fetch(`${AGENT_URL}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, mode, agentId: pairing?.agentId }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        const message = body?.error?.message ?? `Dispatch failed (HTTP ${res.status}).`;
        // The task row may already exist from task.started; if the failure came
        // earlier there is no row, so add one carrying the reason.
        setTasks(prev => {
          const running = prev.findIndex(t => t.status === 'running');
          if (running === -1) {
            return [{ id: `failed-${Date.now()}`, description, status: 'failed', mode, plan: [], results: [], error: message }, ...prev];
          }
          return prev.map((t, i) => (i === running ? { ...t, status: 'failed', error: message } : t));
        });
        return;
      }

      // The runner re-paired mid-flight (core restart) — adopt its agentId so
      // the status chip names the agent that actually spent.
      if (body.agentId && body.agentId !== pairing?.agentId) {
        setPairing(p => (p ? { ...p, agentId: body.agentId } : p));
      }

      setTasks(prev => prev.map(t => (t.id === body.taskId
        ? { ...t, status: 'done', plan: body.plan, results: body.results as LineItemResult[], error: null }
        : t)));

      const last = (body.results as LineItemResult[]).at(-1);
      if (last) setSelectedTrace(last.trace);
      void refreshBalance();
    } catch (e) {
      setTasks(prev => [{
        id: `failed-${Date.now()}`,
        description,
        status: 'failed',
        mode,
        plan: [],
        results: [],
        error: `Could not reach the agent runner at ${AGENT_URL}. Is \`pnpm dev:agent\` running? (${(e as Error).message})`,
      }, ...prev]);
    } finally {
      setDispatching(false);
    }
  };

  /**
   * Clones a real vendor at 40% of its prices, aged 2 days, tier 2.
   *
   * Reports what vendorsim actually returned. The old version alerted that a
   * storefront had been spawned regardless of outcome, while POSTing a core
   * route that does not exist — so the alert described something that had never
   * happened, every time.
   */
  const spawnCounterfeit = async () => {
    setCounterfeitResult(null);
    if (!targetVendorId) {
      setCounterfeitResult({ ok: false, text: 'Pick a vendor to clone first.' });
      return;
    }
    try {
      const res = await fetch(`${VENDORSIM_URL}/vendorsim/spawn-counterfeit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetVendorId }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setCounterfeitResult({ ok: false, text: `vendorsim returned HTTP ${res.status}${body?.error ? ` — ${body.error}` : ''}` });
        return;
      }
      setVendors(v => [...v, { id: body.id, name: body.name, tier: body.tier, address: body.address }]);
      setCounterfeitResult({
        ok: true,
        text: `Spawned ${body.id} — "${body.name}", tier ${body.tier}, aged ${body.ageDays}d, ${body.settledTxns} settled, address ${body.address}. It is now in the catalogue; dispatch a task to see the enforcement layer meet it.`,
      });
    } catch (e) {
      setCounterfeitResult({ ok: false, text: `Could not reach vendorsim at ${VENDORSIM_URL} — is \`pnpm dev:vendorsim\` running? (${(e as Error).message})` });
    }
  };

  /**
   * Really stops the core issuing leases, so spending stops within LEASE_TTL_MS.
   *
   * The button used to set coreUp=false locally and POST a 404 into a swallowed
   * catch: the UI said "Core is offline" while the core kept issuing leases.
   * Now the local state follows the core's answer instead of leading it.
   */
  const killCoreService = async () => {
    setKillResult(null);
    try {
      const res = await fetch(`${CORE_URL}/v1/admin/kill`, { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setKillResult({ ok: false, text: `Core refused the kill: HTTP ${res.status}. It is still issuing leases.` });
        return;
      }
      setCoreUp(false);
      setKillResult({ ok: true, text: body?.message ?? 'Approval service killed.' });
    } catch (e) {
      // Nothing was killed, so the UI must not claim it was.
      setKillResult({ ok: false, text: `Could not reach the core at ${CORE_URL}; nothing was killed. (${(e as Error).message})` });
    }
  };

  const reviveCoreService = async () => {
    setKillResult(null);
    try {
      const res = await fetch(`${CORE_URL}/v1/admin/revive`, { method: 'POST' });
      if (!res.ok) {
        setKillResult({ ok: false, text: `Core refused to resume: HTTP ${res.status}.` });
        return;
      }
      setCoreUp(true);
      setKillResult({ ok: true, text: 'Approval service resumed. Leases are being issued again.' });
    } catch (e) {
      setKillResult({ ok: false, text: `Could not reach the core at ${CORE_URL}. (${(e as Error).message})` });
    }
  };

  /** Puts attacker-controlled text on a vendor's storefront, which the agent reads. */
  const injectIntoVendor = async () => {
    setInjectResult(null);
    if (!targetVendorId) {
      setInjectResult({ ok: false, text: 'Pick a vendor to inject into first.' });
      return;
    }
    if (!injectText.trim()) {
      setInjectResult({ ok: false, text: 'Nothing to inject.' });
      return;
    }
    try {
      const res = await fetch(`${VENDORSIM_URL}/vendorsim/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendorId: targetVendorId, text: injectText }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setInjectResult({ ok: false, text: `vendorsim returned HTTP ${res.status}${body?.error ? ` — ${body.error}` : ''}` });
        return;
      }
      setInjectResult({ ok: true, text: `Injected into ${body.vendorId}'s storefront. The agent will read it the next time it visits that page.` });
      setInjectText('');
    } catch (e) {
      setInjectResult({ ok: false, text: `Could not reach vendorsim at ${VENDORSIM_URL} — is \`pnpm dev:vendorsim\` running? (${(e as Error).message})` });
    }
  };

  const leasePercent = Math.max(0, Math.min(100, (leaseTtl / leaseTtlMax) * 100));

  return (
    <div className="playground-layout">
      {/* Top Nav */}
      <header className="topbar">
        <div className="topbar-left">
          <div className={`core-dot ${coreUp ? 'up' : 'down'}`} />
          <a href="/console" className="topbar-brand">← Console</a>
          <span className="topbar-page">Agent Playground</span>
          <AgentStatus pairing={pairing} error={pairError} leaseTtlMs={leaseTtl} />
        </div>
        <div className="topbar-right">
          {/* RekhaAccount's INRx balance on Base Sepolia — not a local counter. */}
          <div className="balance-block" title={balanceError ?? 'RekhaAccount INRx balance on Base Sepolia'}>
            <span className="balance-label">On-chain</span>
            <span className="balance-amount">
              {balanceMinor === null ? 'unavailable' : fmtInr(balanceMinor)}
            </span>
          </div>
          <span className="mode-badge" style={{ color: MODE_INFO[mode].color }}>
            {MODE_INFO[mode].label} Mode
          </span>
        </div>
      </header>

      {/* Three-panel layout */}
      <div className="playground-body">
        {/* ── LEFT: Task Console ── */}
        <div className="pg-panel-left">
          <div className="panel-header"><h2>Task Console</h2></div>

          {/* Speed slider */}
          <div className="speed-row">
            <label>Sim Speed: {speed}×</label>
            <input type="range" min={1} max={10} value={speed}
              onChange={e => setSpeed(Number(e.target.value))} className="speed-slider" />
          </div>

          {/* Task input */}
          <div className="task-input-group">
            <input
              className="task-input"
              placeholder='e.g. "Order 100 bottles of Himalayan water"'
              value={taskInput}
              onChange={e => setTaskInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && dispatchTask()}
            />
            <button className="btn-dispatch" onClick={dispatchTask} disabled={dispatching}>
              {dispatching ? '⋯ Settling on Base Sepolia' : '▶ Dispatch'}
            </button>
          </div>

          {/* Task list — each task expands into its line items, and each line
              item into its decision and, if it settled, its transaction. */}
          <div className="task-list">
            {tasks.length === 0 && <p className="task-empty">No tasks yet. Enter a task above to begin.</p>}
            {tasks.map(task => (
              <div key={task.id} className={`task-item task-${task.status}`}>
                <div className="task-head">
                  <span className="task-dot">
                    {task.status === 'running' ? '⟳' : task.status === 'failed' ? '✗' : '✓'}
                  </span>
                  <span className="task-desc">{task.description}</span>
                  <span className="task-mode" style={{ color: MODE_INFO[task.mode].color }}>{task.mode}</span>
                </div>

                {task.error && <div className="task-error">{task.error}</div>}

                {task.plan.map(item => {
                  const result = task.results.find(r => r.lineItemId === item.lineItemId);
                  return (
                    <div key={item.lineItemId} className="line-item">
                      <div className="li-row">
                        <span className="li-vendor">{item.vendorId}</span>
                        <span className="li-cat">{item.categoryCode}</span>
                        <span className="li-amount">{fmtInr(item.estimatedAmountMinor)}</span>
                        {result && (
                          <button
                            className={`li-outcome li-${result.outcome.toLowerCase()}`}
                            onClick={() => setSelectedTrace(result.trace)}
                            title="Show the predicate trace"
                          >
                            {result.outcome}
                            {result.bindingPredicate ? ` · ${result.bindingPredicate}` : ''}
                          </button>
                        )}
                      </div>

                      {result?.settlement && (
                        <div className="li-settled">
                          <span className="li-settled-label">settled</span>
                          <a
                            className="li-tx"
                            href={result.settlement.explorerUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={result.settlement.txHash}
                          >
                            {result.settlement.txHash.slice(0, 18)}… ↗
                          </a>
                          <span className="li-block">block {result.settlement.blockNumber}</span>
                          <span className="li-bal">
                            balance {result.settlement.balanceAfterMinor === null
                              ? 'unavailable'
                              : fmtInr(result.settlement.balanceAfterMinor)}
                          </span>
                        </div>
                      )}

                      {result?.refusedOnChain && (
                        <div className="li-reverted">
                          PolicyModule refused on chain: {result.refusedOnChain}. No funds moved.
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Decision Panel — the predicate trace for whatever was last decided
              or clicked. FIX2 asks for this to be visible here, not only in the
              console. */}
          <div className="pg-decision">
            <div className="panel-header"><h2>Decision</h2></div>
            {selectedTrace === null ? (
              <p className="task-empty">Dispatch a task, or click an outcome above, to see the predicate trace.</p>
            ) : (
              <PredicateTrace trace={selectedTrace} />
            )}
          </div>

          {/* Ceremony Bar (M3) */}
          {ceremony && (
            <div className={`ceremony-bar ${ceremony.aborted ? 'aborted' : ''}`}>
              <div className="ceremony-label">
                {ceremony.aborted ? '⛔ Ceremony Aborted' : `Signing Ceremony — Round ${ceremony.round} of ${ceremony.of}`}
              </div>
              <div className="ceremony-track">
                {Array.from({ length: ceremony.of }).map((_, i) => (
                  <div
                    key={i}
                    className={`ceremony-seg ${
                      ceremony.aborted && ceremony.abortedAt !== null && i >= ceremony.abortedAt - 1
                        ? 'seg-broken'
                        : i < ceremony.round
                        ? 'seg-done'
                        : 'seg-pending'
                    }`}
                  />
                ))}
              </div>
              {ceremony.aborted && (
                <div className="ceremony-snap-msg">Signature revoked mid-ceremony — it never existed.</div>
              )}
            </div>
          )}
        </div>

        {/* ── CENTRE: Agent View ── */}
        <div className="pg-panel-centre">
          <div className="panel-header"><h2>Agent&apos;s World</h2></div>

          {/* Inject text into the selected vendor's storefront, which the agent reads. */}
          <div className="inject-row">
            <input
              className="inject-input"
              placeholder={
                targetVendorId
                  ? `Inject hidden text into ${targetVendorId}'s storefront...`
                  : 'Pick a target vendor in Judge Controls first...'
              }
              value={injectText}
              onChange={e => setInjectText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void injectIntoVendor(); }}
            />
            <button className="btn-inject" onClick={injectIntoVendor}>Inject</button>
          </div>
          {injectResult && (
            <div className={injectResult.ok ? 'control-msg-ok' : 'control-msg-err'}>
              {injectResult.text}
            </div>
          )}

          {/* Agent reasoning stream */}
          <div className="thoughts-box" ref={thoughtsRef}>
            <div className="thoughts-label">Agent reasoning (live)</div>
            {agentThoughts.length === 0 && (
              <div className="thoughts-empty">Agent is idle. Dispatch a task to see reasoning.</div>
            )}
            {agentThoughts.map((t, i) => (
              <div key={i} className="thought-line">{t}</div>
            ))}
          </div>

          {/* Rogue Mode Scoreboard (M2) */}
          <div className="scoreboard">
            <h3 className="scoreboard-title">Rogue Mode Scoreboard</h3>
            <div className="scoreboard-grid">
              <div className="score-cell">
                <div className="score-number">{rogueStats.attempts}</div>
                <div className="score-label">Attempts</div>
              </div>
              <div className="score-cell">
                <div className="score-number" style={{ color: 'var(--clear)' }}>{rogueStats.blocked}</div>
                <div className="score-label">Blocked</div>
              </div>
              <div className="score-cell">
                <div className="score-number" style={{ color: 'var(--lien)' }}>{rogueStats.novel}</div>
                <div className="score-label">Novel</div>
              </div>
              <div className="score-cell">
                <div className="score-number score-funds-lost" style={{ color: rogueStats.fundsLost === 0 ? 'var(--clear)' : 'var(--breach)' }}>
                  {rogueStats.fundsLost === 0 ? '₹0' : fmtInr(rogueStats.fundsLost)}
                </div>
                <div className="score-label funds-lost-label">Funds Lost</div>
              </div>
            </div>
            {/* Attack log */}
            <div className="attack-log">
              {attackLog.length === 0 && <div className="attack-log-empty">No attack attempts yet. Switch to Compromised mode.</div>}
              {attackLog.map(entry => (
                <div key={entry.id} className={`attack-row ${entry.blocked ? 'atk-blocked' : 'atk-passed'}`}>
                  <span className="atk-icon">{entry.blocked ? '🛡' : '⚠'}</span>
                  <span className="atk-tech">{entry.technique}</span>
                  {entry.novel && <span className="atk-novel">novel</span>}
                  <span className="atk-reason">{entry.revertReason}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── RIGHT: Controls ── */}
        <div className="pg-panel-right">
          <div className="panel-header"><h2>Controls</h2></div>

          {/* Behaviour mode selector */}
          <div className="mode-selector">
            {(Object.keys(MODE_INFO) as BehaviourMode[]).map(m => (
              <button
                key={m}
                className={`mode-card ${mode === m ? 'mode-active' : ''}`}
                style={{ borderColor: mode === m ? MODE_INFO[m].color : undefined }}
                onClick={() => setMode(m)}
              >
                <span className="mode-name" style={{ color: mode === m ? MODE_INFO[m].color : undefined }}>
                  {MODE_INFO[m].label}
                </span>
                <span className="mode-desc">{MODE_INFO[m].description}</span>
              </button>
            ))}
          </div>

          <div className="judge-controls">
            <h3>Judge Controls</h3>

            <label className="control-label" htmlFor="target-vendor">Target vendor</label>
            <select
              id="target-vendor"
              className="control-select"
              value={targetVendorId}
              onChange={e => setTargetVendorId(e.target.value)}
              disabled={vendors.length === 0}
            >
              {vendors.length === 0 ? (
                <option value="">vendorsim unreachable</option>
              ) : (
                vendors.map(v => (
                  <option key={v.id} value={v.id}>{v.name} (tier {v.tier})</option>
                ))
              )}
            </select>

            <button className="btn-judge" onClick={spawnCounterfeit}>
              🏪 Spawn Counterfeit Storefront
            </button>
            {counterfeitResult && (
              <div className={counterfeitResult.ok ? 'control-msg-ok' : 'control-msg-err'}>
                {counterfeitResult.text}
              </div>
            )}

            {coreUp ? (
              <button className="btn-judge-danger" onClick={killCoreService}>
                ☠ Kill Approval Service
              </button>
            ) : (
              <button className="btn-judge" onClick={reviveCoreService}>
                ⏻ Resume Approval Service
              </button>
            )}
            {killResult && (
              <div className={killResult.ok ? 'control-msg-ok' : 'control-msg-err'}>
                {killResult.text}
              </div>
            )}
            {!coreUp && killResult?.ok && (
              <div className="core-killed-msg">
                No new leases are being issued. Watch the ring drain — all spending
                stops within {(leaseTtlMax / 1000).toFixed(0)}s.
              </div>
            )}
          </div>

          {/* Lease TTL Ring */}
          <div className="lease-panel">
            <h3>Lease TTL</h3>
            <div className="lease-ring-large">
              <svg width="80" height="80" viewBox="0 0 80 80">
                <circle cx="40" cy="40" r="32" fill="none" stroke="var(--slate)" strokeWidth="6" />
                <circle
                  cx="40" cy="40" r="32" fill="none"
                  stroke={leaseTtl < 1500 ? 'var(--breach)' : leaseTtl < 3000 ? 'var(--lien)' : 'var(--clear)'}
                  strokeWidth="6"
                  strokeDasharray={`${2 * Math.PI * 32}`}
                  strokeDashoffset={`${2 * Math.PI * 32 * (1 - leasePercent / 100)}`}
                  strokeLinecap="round"
                  transform="rotate(-90 40 40)"
                  style={{ transition: 'stroke-dashoffset 0.4s linear, stroke 0.3s' }}
                />
              </svg>
              <div className="lease-center-label">
                <span className="lease-ttl-big">{(leaseTtl / 1000).toFixed(1)}</span>
                <span className="lease-ttl-unit">sec</span>
              </div>
            </div>
            <p className="lease-note">
              {coreUp
                ? `Renews every ${(leaseTtlMax / 1000).toFixed(0)}s. Kill the service to watch it drain.`
                : '⚠ Core offline — lease draining. Spending stops at 0.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The 14 predicates, in the order PolicyModule.validate runs them.
 *
 * The binding one is highlighted, because "why" is the product: a REFUSED
 * decision that does not name the predicate it failed on is just a rejection.
 * Same table as the console's Decision Panel, rendered where the task is.
 */
function PredicateTrace({ trace }: { trace: DecisionTrace }) {
  const colour = trace.outcome === 'APPROVED' ? 'var(--clear)'
    : trace.outcome === 'HELD' ? 'var(--lien)'
    : 'var(--breach)';

  return (
    <div className="decision-inner">
      <div className="decision-outcome" style={{ color: colour }}>{trace.outcome}</div>
      <p className="decision-summary">{trace.summary}</p>
      <div className="decision-meta">
        <span>{trace.decisionId}</span>
        <span>{fmtInr(trace.amountMinor)}</span>
      </div>
      <table className="predicate-table">
        <thead>
          <tr><th>Predicate</th><th>Expected</th><th>Actual</th><th>Pass</th></tr>
        </thead>
        <tbody>
          {trace.predicates.map(pred => (
            <tr key={pred.name} className={pred.name === trace.bindingPredicate ? 'binding-row' : ''}>
              <td className="pred-name">{pred.name}</td>
              <td className="pred-expected">{pred.expected}</td>
              <td className={`pred-actual ${pred.passed ? 'pass' : 'fail'}`}>{pred.actual}</td>
              <td>{pred.passed ? '✓' : '✗'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="decision-hash">
        <span>Policy: </span><code className="mono-sm">{trace.policyHash.slice(0, 18)}…</code>
      </div>
    </div>
  );
}
