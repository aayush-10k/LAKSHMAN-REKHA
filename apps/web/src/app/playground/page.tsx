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
  const dispatchTask = async () => {
    if (!taskInput.trim() || dispatching) return;
    const description = taskInput.trim();
    setDispatching(true);
    setTaskInput('');

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

  const spawnCounterfeit = async () => {
    await fetch(`${CORE_URL}/v1/vendorsim/counterfeit`, { method: 'POST' }).catch(() => {});
    alert('Counterfeit storefront spawned! It clones a real vendor at 60% off, aged 2 days. The enforcement layer will refuse it on counterpartyAge predicate.');
  };

  const killCoreService = async () => {
    setCoreUp(false);
    // Calling /v1/admin/kill will stop new leases — spending stops within 5s
    await fetch(`${CORE_URL}/v1/admin/kill`, { method: 'POST' }).catch(() => {});
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

          {/* Inject text */}
          <div className="inject-row">
            <input
              className="inject-input"
              placeholder="Inject text into agent's context..."
              value={injectText}
              onChange={e => setInjectText(e.target.value)}
            />
            <button className="btn-inject" onClick={async () => {
              await fetch(`${CORE_URL}/v1/task/inject`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: injectText }),
              }).catch(() => {});
              setInjectText('');
            }}>Inject</button>
          </div>

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
            <button className="btn-judge" onClick={spawnCounterfeit}>
              🏪 Spawn Counterfeit Storefront
            </button>
            <button className="btn-judge-danger" onClick={killCoreService} disabled={!coreUp}>
              ☠ Kill Approval Service
            </button>
            {!coreUp && (
              <div className="core-killed-msg">
                Core is offline. Watch the lease ring drain. All spending stops within 5s.
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
