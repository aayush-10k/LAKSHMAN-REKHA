'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { RekhaEvent } from '../../types';
import { CORE_URL, ensurePaired, type Pairing } from '../../lib/pairing';


type BehaviourMode = 'normal' | 'hallucinating' | 'injected' | 'compromised' | 'overreach' | 'colluding';
type AttackLog = { id: number; technique: string; revertReason: string; blocked: boolean; novel: boolean; ts: number };
type CeremonyState = { decisionId: string; round: number; of: number; aborted: boolean; abortedAt: number | null };

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
  const [tasks, setTasks] = useState<Array<{ id: string; description: string; status: string; mode: BehaviourMode }>>([]);
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
      .then(p => { setPairing(p); setLeaseTtlMax(p.leaseTtlMs); setPairError(null); })
      .catch((e: Error) => setPairError(e.message));
  }, []);

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
      setTasks(prev => [{ id: event.taskId, description: event.description, status: 'running', mode: event.mode as BehaviourMode }, ...prev]);
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
      setTasks(prev => prev.map(t => t.status === 'running' ? { ...t, status: 'done' } : t));
    }
  }, []);

  const dispatchTask = async () => {
    if (!taskInput.trim()) return;
    try {
      await fetch(`${CORE_URL}/v1/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: taskInput, mode, speedMultiplier: speed }),
      });
      setTaskInput('');
    } catch {
      alert('Could not reach core API. Is it running?');
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
        </div>
        <div className="topbar-right">
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
            <button className="btn-dispatch" onClick={dispatchTask}>▶ Dispatch</button>
          </div>

          {/* Task list */}
          <div className="task-list">
            {tasks.length === 0 && <p className="task-empty">No tasks yet. Enter a task above to begin.</p>}
            {tasks.map(task => (
              <div key={task.id} className={`task-item task-${task.status}`}>
                <span className="task-dot">{task.status === 'running' ? '⟳' : '✓'}</span>
                <span className="task-desc">{task.description}</span>
                <span className="task-mode" style={{ color: MODE_INFO[task.mode].color }}>{task.mode}</span>
              </div>
            ))}
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
                ? 'Renews every 5s. Kill the service to watch it drain.'
                : '⚠ Core offline — lease draining. Spending stops at 0.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
