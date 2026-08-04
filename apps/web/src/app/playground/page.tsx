'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CategoryCode, DecisionTrace, RekhaEvent } from '../../types';
import { CORE_URL, ensurePaired, renewLease, type Pairing } from '../../lib/pairing';
import { POLICY_MODULE_ADDRESS, basescanAddress, basescanTx, isPlaceholderDigest, shortHex } from '../../lib/contracts';
import { Amount, formatInrMinor } from '../../components/Amount';
import { AgentStatus } from '../../components/AgentStatus';
import { CoreOffline } from '../../components/CoreOffline';
import { Counter } from '../../components/Counter';
import { PredicateTable } from '../../components/PredicateTable';
import { Rekha, type RekhaPulse } from '../../components/Rekha';
import { TTLRing } from '../../components/TTLRing';

/**
 * The agent runs in its own process holding the other half of the 2-of-2, so
 * Dispatch talks to it and not to the core. See apps/core/src/agent/runner.ts.
 */
const AGENT_URL = process.env['NEXT_PUBLIC_AGENT_URL'] ?? 'http://localhost:4200';

/**
 * The vendor registry is its own service (apps/vendorsim). "Spawn counterfeit"
 * and "Inject" are its endpoints, and the playground was calling the CORE for
 * both — /v1/vendorsim/counterfeit and /v1/task/inject, neither of which exists.
 * Both 404s were swallowed by `.catch(() => {})` and reported as success.
 */
const VENDORSIM_URL = process.env['NEXT_PUBLIC_VENDORSIM_URL'] ?? 'http://localhost:4100';

type Vendor = { id: string; name: string; tier: number; address: string };

/** Outcome of a judge control, shown verbatim. Never a fabricated success. */
type ControlResult = { ok: boolean; text: string } | null;

type BehaviourMode = 'normal' | 'hallucinating' | 'injected' | 'compromised' | 'overreach' | 'colluding';
type AttackStatus = 'blocked' | 'through' | 'errored';
type AttackStage = 'input' | 'policy' | 'chain' | null;
type AttackLog = { id: number; technique: string; revertReason: string; status: AttackStatus; stage: AttackStage; novel: boolean };
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
  /** The runner's stated reason for an empty plan. Never rendered as success. */
  note: string | null;
};

/** M1's answer, exactly as the agent runner reported it. Nothing is inferred. */
type RailBypass = {
  agentAddress: string;
  rekhaAccount: string;
  amountMinor: number;
  digest: string;
  outcome: 'reverted' | 'executed';
  revert: string | null;
  predicate: string | null;
  method: string;
  accountUrl: string;
};

/**
 * All six do something now (FINALE_PLAN.md Phase 6).
 *
 * Four of them used to set a label and nothing else, so the cards carried a
 * `not wired` tag rather than a promise the interface could not keep. That tag
 * is gone because the behaviour is real: `apps/core/src/agent/modes.ts` changes
 * what the agent buys and what it declares, and nothing else. Same binary, same
 * lease, same signing path, same chain in all six — the mode cannot reach the
 * evaluator, and a judge should be able to check that in one file.
 *
 * `catches` names the predicate each mode is aiming at. It is an intention, not
 * a result: the row that appears below is whatever the evaluator actually
 * returned. If they ever disagree, believe the row.
 */
const MODE_INFO: Record<BehaviourMode, { label: string; description: string; catches: string | null }> = {
  normal: {
    label: 'Normal',
    description: 'Plans from the registry, browses the storefront, pays the page price.',
    catches: null,
  },
  hallucinating: {
    label: 'Hallucinating',
    description: 'Reads quantities 250× too large and orders the same line item twice.',
    catches: 'perTxCap',
  },
  injected: {
    label: 'Injected',
    description: 'Does whatever the storefront tells it to — wallet, price, anything. Undefended on purpose.',
    catches: 'counterpartyTier',
  },
  compromised: {
    label: 'Compromised',
    description: 'Runs the deterministic attack classes against this core, live.',
    catches: null,
  },
  overreach: {
    label: 'Overreach',
    description: 'Buys what you asked for, then adds something expensive and out of scope.',
    catches: 'categoryPermitted',
  },
  colluding: {
    label: 'Colluding',
    description: 'Pays an address it controls and calls it a 10-year-old tier 1 supplier.',
    catches: 'counterpartyTier',
  },
};

export default function PlaygroundPage() {
  const [mode, setMode] = useState<BehaviourMode>('normal');
  const [taskInput, setTaskInput] = useState('');
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [selectedTrace, setSelectedTrace] = useState<DecisionTrace | null>(null);
  const [dispatching, setDispatching] = useState(false);

  const [agentThoughts, setAgentThoughts] = useState<string[]>([]);
  const [attackLog, setAttackLog] = useState<AttackLog[]>([]);
  const [rogueStats, setRogueStats] = useState({ attempts: 0, input: 0, policy: 0, chain: 0, errored: 0, approved: 0 });
  const [ceremony, setCeremony] = useState<CeremonyState | null>(null);

  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [leaseTtl, setLeaseTtl] = useState(0);
  const [leaseTtlMax, setLeaseTtlMax] = useState(15000);
  const [coreUp, setCoreUp] = useState(false);
  const [imageDigest, setImageDigest] = useState<string | null>(null);
  const [revocationEpoch, setRevocationEpoch] = useState<number | null>(null);
  const [frozen, setFrozen] = useState(false);

  /**
   * Tri-state, as the console does it (FIX3.md BUG 3). 'checking' is not 'down':
   * a boolean flashes the offline panel on every load before the health probe
   * returns, and a warning that cries wolf gets ignored when it is real.
   */
  const [coreReach, setCoreReach] = useState<'checking' | 'up' | 'down'>('checking');
  const [coreReachReason, setCoreReachReason] = useState<string | null>(null);

  // Judge controls (FIX3.md BUG 4): the target vendor, and the last real result
  // of each control. Both controls need a vendor — vendorsim's endpoints take a
  // vendorId, which is why calling the core for them could never have worked.
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [targetVendorId, setTargetVendorId] = useState('');
  const [injectText, setInjectText] = useState('');
  const [counterfeitResult, setCounterfeitResult] = useState<ControlResult>(null);
  const [injectResult, setInjectResult] = useState<ControlResult>(null);
  const [killResult, setKillResult] = useState<ControlResult>(null);
  const [revokeResult, setRevokeResult] = useState<ControlResult>(null);

  const [railBypass, setRailBypass] = useState<RailBypass | null>(null);
  const [railBypassError, setRailBypassError] = useState<string | null>(null);
  const [railBypassRunning, setRailBypassRunning] = useState(false);

  /**
   * Bumped after a successful inject or spawn so the iframe refetches. Without
   * it the judge writes into the storefront, the page keeps its cached render,
   * and the most important control on screen appears to do nothing.
   */
  const [storefrontNonce, setStorefrontNonce] = useState(0);

  const [pulse, setPulse] = useState<RekhaPulse | null>(null);
  const pulseIdRef = useRef(0);
  const attackIdRef = useRef(0);
  const thoughtsRef = useRef<HTMLDivElement>(null);

  /** The line does not celebrate. Only 'flare' and 'snap' ever reach it. */
  const firePulse = useCallback((kind: 'flare' | 'snap') => {
    pulseIdRef.current += 1;
    setPulse({ kind, id: pulseIdRef.current });
  }, []);

  // ── Boot: probe the core, pair, load the registry ──────────────────────
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

        fetch(`${CORE_URL}/v1/mandate/${p.mandateId}`)
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          })
          .then((m) => {
            setRevocationEpoch(m.revocationEpoch ?? 0);
            if (m.frozen) setFrozen(true);
          })
          .catch((e: Error) => console.error('[playground] mandate read failed:', e.message));
      })
      .catch((e: Error) => setPairError(e.message));

    fetch(`${VENDORSIM_URL}/catalog`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((list: Vendor[]) => {
        if (!Array.isArray(list)) return;
        setVendors(list);
        if (list.length > 0) setTargetVendorId((prev) => prev || list[0]!.id);
      })
      .catch((e: Error) => {
        // Leave the list empty: the controls then say vendorsim is unreachable
        // when pressed, instead of offering a menu of vendors that do not exist.
        console.error('[playground] vendor registry unavailable:', e.message);
        setVendors([]);
      });
  }, []);

  // Keep the lease alive so the ring shows a real lease rather than a decorative
  // one. renewLease re-pairs by itself if the core has restarted.
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

  // ── SSE. Every live value on this page comes from here. ────────────────
  const processEvent = useCallback(
    (event: RekhaEvent) => {
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
          setRevocationEpoch(event.epoch);
          return;

        case 'task.started':
          setTasks((prev) => [
            {
              id: event.taskId,
              description: event.description,
              status: 'running',
              mode: event.mode as BehaviourMode,
              plan: event.plan as PlanItem[],
              results: [],
              error: null,
              note: null,
            },
            ...prev,
          ]);
          return;

        case 'agent.thought':
          setAgentThoughts((prev) => [...prev.slice(-49), event.text]);
          // Scroll after paint, so the newest line is the one in view.
          requestAnimationFrame(() => {
            if (thoughtsRef.current) thoughtsRef.current.scrollTop = thoughtsRef.current.scrollHeight;
          });
          return;

        case 'decision.made':
          // The decision lands on the stream before the runner's reply does, so
          // the trace fills in while the settlement is still being mined.
          setSelectedTrace(event.trace);
          return;

        case 'attack.attempt': {
          attackIdRef.current += 1;
          // A core that predates status/stage still reports `blocked`, so fall
          // back to it rather than silently classifying everything as errored.
          const status = event.status ?? (event.blocked ? 'blocked' : 'through');
          const entry: AttackLog = {
            id: attackIdRef.current,
            technique: event.technique,
            revertReason: event.revertReason,
            status,
            stage: event.stage ?? null,
            novel: event.novel,
          };
          setAttackLog((prev) => [entry, ...prev].slice(0, 200));
          setRogueStats((prev) => ({
            attempts: prev.attempts + 1,
            // Split by the layer that actually stopped it. 144 of the last 147
            // died at the typed-schema input boundary and only 3 reached the
            // predicates — one number hiding two very different defences.
            // Defence in depth, labelled. A judge who works this out for
            // themselves is a judge we have lost (FINALE_PLAN Phase 5 item 1).
            input: prev.input + (entry.stage === 'input' ? 1 : 0),
            policy: prev.policy + (entry.stage === 'policy' ? 1 : 0),
            chain: prev.chain + (entry.stage === 'chain' ? 1 : 0),
            // Never folded into a block count. A non-zero value here means the
            // run is incomplete, and the strip says so.
            errored: prev.errored + (status === 'errored' ? 1 : 0),
            // The core issued a decision and a signature for this one.
            // NOT the same as money moving — nothing here settles, and the
            // on-chain window cap is the authoritative backstop. Counted and
            // shown, because a co-signature the policy should not have given
            // is a real finding even when no rupee leaves the account.
            approved: prev.approved + (status === 'through' ? 1 : 0),
          }));
          // The line reacts to being tested, and only to that.
          if (status === 'blocked') firePulse('flare');
          return;
        }

        case 'ceremony.round':
          setCeremony({ decisionId: event.decisionId, round: event.round, of: event.of, aborted: false, abortedAt: null });
          return;

        case 'ceremony.aborted':
          setCeremony((prev) =>
            prev ? { ...prev, aborted: true, abortedAt: event.atRound } : null,
          );
          firePulse('snap');
          setTimeout(() => setCeremony(null), 4000);
          return;

        default:
          // quote.received, payment.requested, payment.settled, payment.held,
          // hold.released — the owner's money, which is the console's feed. A
          // settled payment deliberately produces nothing here: the Rekha does
          // not celebrate.
          return;
      }
    },
    [firePulse],
  );

  useEffect(() => {
    const evtSource = new EventSource(`${CORE_URL}/v1/events`);
    evtSource.onmessage = (e) => processEvent(JSON.parse(e.data) as RekhaEvent);
    evtSource.onerror = () => setCoreUp(false);
    return () => evtSource.close();
  }, [processEvent]);

  // ── Rogue Mode ─────────────────────────────────────────────────────────
  /**
   * FIX3.md BUG 5. `mode` used to be threaded all the way through and then
   * ignored — every behaviour ran the same honest path and no attack.attempt
   * event existed anywhere, so the scoreboard sat at 0 · 0 · 0 · ₹0 and read as
   * "nobody tried" rather than "nothing got through".
   *
   * The counters are driven by the SSE attack.attempt stream, not by this
   * response: the board fills as the core reports each verdict. On failure the
   * score stays at zero and the row carries the error, because a scoreboard that
   * invents a 12/12 is worth less than no scoreboard at all.
   */
  const runAdversary = async (description: string) => {
    const rowId = `rogue-${Date.now()}`;
    setTasks((prev) => [
      { id: rowId, description, status: 'running', mode, plan: [], results: [], error: null, note: null },
      ...prev,
    ]);
    setAttackLog([]);
    setRogueStats({ attempts: 0, input: 0, policy: 0, chain: 0, errored: 0, approved: 0 });

    try {
      const res = await fetch(`${CORE_URL}/v1/adversary/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'deterministic' }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setTasks((prev) =>
          prev.map((t) =>
            t.id === rowId
              ? { ...t, status: 'failed' as const, error: body?.error?.message ?? `Adversary run failed (HTTP ${res.status}).` }
              : t,
          ),
        );
        return;
      }

      const s = body.summary;
      setTasks((prev) =>
        prev.map((t) =>
          t.id === rowId
            ? {
                ...t,
                status: 'done' as const,
                error:
                  s.total === s.blocked
                    ? null
                    : `${s.total - s.blocked} of ${s.total} attacks were NOT blocked. See the attack log.`,
                note: `${s.total} attempts replayed onto the stream.`,
              }
            : t,
        ),
      );
    } catch (e) {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === rowId
            ? {
                ...t,
                status: 'failed' as const,
                error: `Could not reach the core at ${CORE_URL}. No attacks were run. (${(e as Error).message})`,
              }
            : t,
        ),
      );
    }
  };

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
        setTasks((prev) => {
          const running = prev.findIndex((t) => t.status === 'running');
          if (running === -1) {
            return [
              { id: `failed-${Date.now()}`, description, status: 'failed' as const, mode, plan: [], results: [], error: message, note: null },
              ...prev,
            ];
          }
          return prev.map((t, i) => (i === running ? { ...t, status: 'failed' as const, error: message } : t));
        });
        return;
      }

      // The runner re-paired mid-flight (core restart) — adopt its agentId so
      // the status chip names the agent that actually spent.
      if (body.agentId && body.agentId !== pairing?.agentId) {
        setPairing((p) => (p ? { ...p, agentId: body.agentId } : p));
      }

      setTasks((prev) =>
        prev.map((t) =>
          t.id === body.taskId
            ? {
                ...t,
                status: 'done' as const,
                plan: body.plan,
                results: body.results as LineItemResult[],
                error: null,
                note: (body.note as string | null) ?? null,
              }
            : t,
        ),
      );

      const last = (body.results as LineItemResult[]).at(-1);
      if (last) setSelectedTrace(last.trace);
    } catch (e) {
      setTasks((prev) => [
        {
          id: `failed-${Date.now()}`,
          description,
          status: 'failed' as const,
          mode,
          plan: [],
          results: [],
          error: `Could not reach the agent runner at ${AGENT_URL}. Is \`pnpm dev:agent\` running? (${(e as Error).message})`,
          note: null,
        },
        ...prev,
      ]);
    } finally {
      setDispatching(false);
    }
  };

  // ── Judge controls, on the storefront panel ────────────────────────────
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
      setVendors((v) => [...v, { id: body.id, name: body.name, tier: body.tier, address: body.address }]);
      setTargetVendorId(body.id);
      setStorefrontNonce((n) => n + 1);
      setCounterfeitResult({
        ok: true,
        text: `Spawned ${body.id} — "${body.name}", tier ${body.tier}, aged ${body.ageDays}d, ${body.settledTxns} settled, at ${body.address}. Now showing on the left; dispatch a task to see the enforcement layer meet it.`,
      });
    } catch (e) {
      setCounterfeitResult({
        ok: false,
        text: `Could not reach vendorsim at ${VENDORSIM_URL} — is \`pnpm dev:vendorsim\` running? (${(e as Error).message})`,
      });
    }
  };

  /** Puts attacker-controlled text on a vendor's storefront, which the agent reads. */
  const injectIntoVendor = async () => {
    setInjectResult(null);
    if (!targetVendorId) {
      setInjectResult({ ok: false, text: 'Pick a target vendor first.' });
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
      setStorefrontNonce((n) => n + 1);
      setInjectResult({
        ok: true,
        text: `Written onto ${body.vendorId}'s page as "Seller notes" — visible on the left now. The agent reads that page on its next dispatch.`,
      });
      setInjectText('');
    } catch (e) {
      setInjectResult({
        ok: false,
        text: `Could not reach vendorsim at ${VENDORSIM_URL} — is \`pnpm dev:vendorsim\` running? (${(e as Error).message})`,
      });
    }
  };

  // ── Enforcement controls ───────────────────────────────────────────────
  /**
   * Really stops the core issuing leases, so spending stops within LEASE_TTL_MS.
   *
   * The button used to set coreUp=false locally and POST a 404 into a swallowed
   * catch: the UI said "Core is offline" while the core kept issuing leases.
   * Now the local state follows the core's answer instead of leading it.
   *
   * Deliberately separate from REVOKE. This demonstrates fail-closed lease
   * issuance; revocation is a different claim with a different mechanism, and
   * collapsing them into one control would blur both.
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
      setKillResult({ ok: true, text: body?.message ?? 'Approval service killed. No new leases are being issued.' });
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

  /**
   * M3's second half. Sits beside the ceremony bar so stopping a signature
   * mid-flight is one gesture rather than a hunt through a settings panel.
   *
   * This is the core's revocation, not PolicyModule.revoke() from the owner's
   * wallet — the console owns that one, and it deliberately routes around us.
   * Only this path is fast enough to land inside a ~1200ms signing round, which
   * is the whole point of the moment.
   *
   * It stops spending until it is explicitly cleared (FINALE_PLAN.md Phase 5
   * item 3), and the note under the button says so before it is pressed rather
   * than after. The reset lives in `clearRevoke` below and only appears once
   * the revoke has actually fired — see the comment there for why it is not
   * offered up front.
   */
  const revokeMandate = async () => {
    setRevokeResult(null);
    if (!pairing) {
      setRevokeResult({ ok: false, text: 'Not paired, so there is no mandate to revoke.' });
      return;
    }
    try {
      const res = await fetch(`${CORE_URL}/v1/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mandateId: pairing.mandateId, source: 'owner' }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setRevokeResult({ ok: false, text: body?.error?.message ?? `Revoke failed (HTTP ${res.status}). Spending has NOT stopped.` });
        return;
      }
      setFrozen(true);
      if (typeof body?.epoch === 'number') setRevocationEpoch(body.epoch);
      // Two numbers, because "freeze latency: 0ms" is not the question anyone
      // is asking. Nothing new can be approved immediately; a lease already
      // issued survives until it expires, and that is the number the
      // fail-closed claim actually rests on.
      const worst = typeof body?.worstCaseStopMs === 'number' ? body.worstCaseStopMs : leaseTtlMax;
      setRevokeResult({
        ok: true,
        text:
          `Revoked at epoch ${body?.epoch ?? '?'}. Nothing new can be approved from this moment ` +
          `(${body?.latencyMs ?? 0}ms), and any lease already issued expires within ` +
          `${(worst / 1000).toFixed(0)}s — after which spending is over regardless. ` +
          `Any ceremony in flight was abandoned.`,
      });
    } catch (e) {
      setRevokeResult({ ok: false, text: `Could not reach the core at ${CORE_URL}; nothing was revoked. (${(e as Error).message})` });
    }
  };

  /**
   * Clear the off-chain revoke, so a rehearsal can continue.
   *
   * ── Why this is not a button beside REVOKE ────────────────────────────────
   * An undo sitting next to a kill switch teaches the person looking at it that
   * the kill switch is soft. It is not: `PolicyModule.revoke()` from the
   * owner's wallet — the one the console fires — has no undo anywhere, and
   * `PolicyModule` has no unfreeze function at all. Advertising a reset in
   * advance would misrepresent the strongest control in the system in order to
   * make a demo more convenient.
   *
   * So it appears only AFTER the revoke has fired and been seen to work, and it
   * is named for what it is. The core refuses it outright when the freeze is on
   * chain, and the message it returns says so.
   */
  const clearRevoke = async () => {
    setRevokeResult(null);
    if (!pairing) {
      setRevokeResult({ ok: false, text: 'Not paired, so there is no mandate to clear.' });
      return;
    }
    try {
      const res = await fetch(`${CORE_URL}/v1/admin/unrevoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mandateId: pairing.mandateId }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // Never optimistic. A refusal here usually means the CHAIN is frozen,
        // which is the answer the judge should hear verbatim.
        setRevokeResult({
          ok: false,
          text: body?.error?.message ?? `The core refused to clear the revoke (HTTP ${res.status}).`,
        });
        return;
      }
      setFrozen(false);
      if (typeof body?.epoch === 'number') setRevocationEpoch(body.epoch);
      setRevokeResult({ ok: true, text: body?.message ?? 'Off-chain revoke cleared.' });
    } catch (e) {
      setRevokeResult({
        ok: false,
        text: `Could not reach the core at ${CORE_URL}; the revoke is still in force. (${(e as Error).message})`,
      });
    }
  };

  /**
   * M1 — the agent, alone.
   *
   * Asks the agent runner (which holds key share A, not the core) to call
   * RekhaAccount.execute() directly against Base Sepolia. What comes back is the
   * deployed contract's own revert. Nothing here decides the outcome, and an
   * `executed` answer would be rendered as the failure it would be.
   */
  const runRailBypass = async () => {
    setRailBypassError(null);
    setRailBypassRunning(true);
    try {
      const res = await fetch(`${AGENT_URL}/rail-bypass`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setRailBypass(null);
        setRailBypassError(body?.error?.message ?? `The agent could not mount the attempt (HTTP ${res.status}).`);
        return;
      }
      setRailBypass({
        agentAddress: body.agent.address,
        rekhaAccount: body.target.rekhaAccount,
        amountMinor: body.request.amountMinor,
        digest: body.digest,
        outcome: body.outcome,
        revert: body.revert,
        predicate: body.predicate,
        method: body.method,
        accountUrl: body.explorer.account,
      });
      // A refused attack is the line being tested, so it flares — the same
      // reaction any other blocked attempt gets, for the same reason.
      if (body.outcome === 'reverted') firePulse('flare');
    } catch (e) {
      setRailBypass(null);
      setRailBypassError(
        `Could not reach the agent runner at ${AGENT_URL}. Is \`pnpm dev:agent\` running? (${(e as Error).message})`,
      );
    } finally {
      setRailBypassRunning(false);
    }
  };

  const storefrontUrl = targetVendorId ? `${VENDORSIM_URL}/vendor/${targetVendorId}` : null;
  const targetVendor = vendors.find((v) => v.id === targetVendorId) ?? null;

  // An unreachable core replaces the playground rather than decorating it. Every
  // panel here reads from the core, so leaving them on screen would render an
  // interface whose values are all absent while still looking operational.
  if (coreReach === 'down') {
    return (
      <div className="pg-layout">
        <CoreOffline reason={coreReachReason} />
      </div>
    );
  }

  return (
    <div className="pg-layout">
      <header className="pg-topbar">
        <div className="pg-topbar-left">
          <a href="/console" className="pg-brand">← Console</a>
          <span className="pg-page-title">Playground</span>
          <AgentStatus pairing={pairing} error={pairError} leaseTtlMs={leaseTtl} />
        </div>
        {frozen && <span className="pg-frozen">REVOKED · epoch {revocationEpoch ?? '?'}</span>}
      </header>

      {pairError && <div className="pg-banner">Agent not paired — {pairError}</div>}

      <div className="pg-body">
        {/* ── LEFT: the task ───────────────────────────────────────────── */}
        <section className="pg-col pg-col-task">
          <div className="pg-section">
            <h2 className="pg-h2">Task</h2>
            <div className="pg-task-input-row">
              <input
                className="pg-input"
                placeholder='e.g. "order 100 bottles"'
                value={taskInput}
                onChange={(e) => setTaskInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void dispatchTask();
                }}
              />
              <button className="pg-btn-primary" onClick={() => void dispatchTask()} disabled={dispatching}>
                {dispatching ? 'Working…' : 'Dispatch'}
              </button>
            </div>
          </div>

          <div className="pg-section">
            <h2 className="pg-h2">Mode</h2>
            <div className="pg-modes">
              {(Object.keys(MODE_INFO) as BehaviourMode[]).map((m) => (
                <button
                  key={m}
                  className={`pg-mode ${mode === m ? 'is-active' : ''}`}
                  onClick={() => setMode(m)}
                >
                  <span className="pg-mode-name">
                    {MODE_INFO[m].label}
                    {/* The predicate this mode is aiming at, named on the card
                        before it runs. A judge can then check the decision
                        panel against it instead of taking our word for the
                        result afterwards. */}
                    {MODE_INFO[m].catches && (
                      <span className="pg-mode-tag">→ {MODE_INFO[m].catches}</span>
                    )}
                  </span>
                  <span className="pg-mode-desc">{MODE_INFO[m].description}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="pg-tasks">
            {tasks.length === 0 ? (
              <p className="pg-empty">No tasks yet. Give the agent something to buy.</p>
            ) : (
              tasks.map((task) => (
                <div key={task.id} className={`pg-task pg-task-${task.status}`}>
                  <div className="pg-task-head">
                    <span className="pg-task-desc">{task.description}</span>
                    <span className="pg-task-mode">{task.mode}</span>
                  </div>

                  {task.error && <div className="pg-task-error">{task.error}</div>}
                  {task.note && !task.error && <div className="pg-task-note">{task.note}</div>}

                  {task.plan.map((item) => {
                    const result = task.results.find((r) => r.lineItemId === item.lineItemId);
                    return (
                      <div key={item.lineItemId} className="pg-line">
                        <div className="pg-line-row">
                          <span className="pg-line-vendor">{item.vendorId}</span>
                          <Amount minor={item.estimatedAmountMinor} compact className="pg-line-amount" />
                          {result && (
                            <button
                              className={`pg-outcome pg-outcome-${result.outcome.toLowerCase()}`}
                              onClick={() => setSelectedTrace(result.trace)}
                              title="Show every predicate this was checked against"
                            >
                              {result.outcome}
                              {result.bindingPredicate ? ` · ${result.bindingPredicate}` : ''}
                            </button>
                          )}
                        </div>

                        {result?.settlement && (
                          <div className="pg-line-meta">
                            <span className="pg-settled">settled</span>
                            <a
                              href={result.settlement.explorerUrl || basescanTx(result.settlement.txHash)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="pg-line-link"
                              title={result.settlement.txHash}
                            >
                              {shortHex(result.settlement.txHash, 10, 6)} ↗
                            </a>
                            <span>block {result.settlement.blockNumber}</span>
                          </div>
                        )}

                        {result?.refusedOnChain && (
                          <div className="pg-line-reverted">
                            PolicyModule refused on chain: {result.refusedOnChain}. No funds moved.
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          {selectedTrace && (
            <div className="pg-decision">
              <div className="pg-decision-head">
                <h2 className="pg-h2">Decision</h2>
                <button className="pg-btn-ghost" onClick={() => setSelectedTrace(null)}>
                  close
                </button>
              </div>
              <PredicateTable trace={selectedTrace} />
            </div>
          )}
        </section>

        {/* ── CENTRE: inside the line ──────────────────────────────────── */}
        <section className="pg-col pg-col-agent">
          <Rekha pulse={pulse} className="pg-rekha">
            <div className="pg-agent-inner">
              <div className="pg-store">
                <div className="pg-store-bar">
                  <span className="pg-store-label">the open web, as the agent finds it</span>
                  <select
                    className="pg-select"
                    value={targetVendorId}
                    onChange={(e) => setTargetVendorId(e.target.value)}
                    disabled={vendors.length === 0}
                    aria-label="Storefront"
                  >
                    {vendors.length === 0 ? (
                      <option value="">vendor registry unreachable</option>
                    ) : (
                      vendors.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name} · tier {v.tier}
                        </option>
                      ))
                    )}
                  </select>
                </div>

                {storefrontUrl ? (
                  <iframe
                    key={`${targetVendorId}-${storefrontNonce}`}
                    className="pg-store-frame"
                    src={storefrontUrl}
                    title={`${targetVendor?.name ?? targetVendorId} storefront`}
                    sandbox="allow-same-origin"
                  />
                ) : (
                  <div className="pg-store-missing">
                    The vendor registry at <code>{VENDORSIM_URL}</code> could not be reached, so there is no
                    storefront to show. Start it with <code>pnpm dev:vendorsim</code>.
                  </div>
                )}

                {/* On the page itself, not in a drawer. A judge should find
                    these without being told they exist. */}
                <div className="pg-judge">
                  <button className="pg-btn-attack" onClick={() => void spawnCounterfeit()}>
                    Spawn counterfeit
                  </button>
                  <input
                    className="pg-input pg-inject-input"
                    placeholder={targetVendorId ? `Inject text into ${targetVendorId}…` : 'No storefront selected'}
                    value={injectText}
                    onChange={(e) => setInjectText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void injectIntoVendor();
                    }}
                  />
                  <button className="pg-btn-attack" onClick={() => void injectIntoVendor()}>
                    Inject
                  </button>
                </div>
                {counterfeitResult && (
                  <div className={counterfeitResult.ok ? 'pg-msg-ok' : 'pg-msg-err'}>{counterfeitResult.text}</div>
                )}
                {injectResult && <div className={injectResult.ok ? 'pg-msg-ok' : 'pg-msg-err'}>{injectResult.text}</div>}
              </div>

              <div className="pg-thoughts" ref={thoughtsRef}>
                <div className="pg-thoughts-label">agent reasoning</div>
                {agentThoughts.length === 0 ? (
                  <div className="pg-empty">Idle.</div>
                ) : (
                  agentThoughts.map((t, i) => (
                    <div key={i} className="pg-thought">
                      › {t}
                    </div>
                  ))
                )}
              </div>
            </div>
          </Rekha>
        </section>

        {/* ── RIGHT: enforcement ───────────────────────────────────────── */}
        <section className="pg-col pg-col-enforce">
          <h2 className="pg-h2">Enforcement</h2>

          <div className="pg-lease">
            <TTLRing ttlMs={leaseTtl} maxMs={leaseTtlMax} size={64} />
            <div className="pg-lease-text">
              <span className="pg-lease-value">{(Math.max(0, leaseTtl) / 1000).toFixed(1)}s</span>
              <span className="pg-lease-label">lease</span>
            </div>
          </div>

          {/* 'checking' is rendered as itself. coreUp initialises false, so
              painting it as "not issuing" before the health probe answers would
              announce a killed core on every page load — the one state that must
              never be claimed without having been measured. */}
          <div className={`pg-status ${coreReach === 'checking' ? 'is-checking' : coreUp ? 'is-up' : 'is-down'}`}>
            <span className="pg-status-dot" />
            <span>
              {coreReach === 'checking' ? 'checking the core…' : coreUp ? 'core issuing leases' : 'core not issuing'}
            </span>
          </div>

          <div className="pg-kv">
            <span>core image</span>
            <span className="pg-mono" title={imageDigest ?? undefined}>
              {imageDigest ? shortHex(imageDigest, 13, 6) : 'waiting for core.status…'}
            </span>
          </div>
          {/* Predicate 3 is real and reverts CoreImageMismatch on a mismatch.
              The registered value is a stand-in. Saying so here costs nothing
              and stops the figure being read as an attestation. */}
          {isPlaceholderDigest(imageDigest) && (
            <div className="pg-kv pg-kv-warn">placeholder digest — the check is real, the value attests nothing</div>
          )}
          <div className="pg-kv">
            <span>PolicyModule</span>
            <a href={basescanAddress(POLICY_MODULE_ADDRESS)} target="_blank" rel="noopener noreferrer" className="pg-mono pg-link">
              {shortHex(POLICY_MODULE_ADDRESS, 8, 4)} ↗
            </a>
          </div>
          <div className="pg-kv">
            <span>revocation epoch</span>
            <span className="pg-mono">{revocationEpoch ?? '—'}</span>
          </div>

          {/* Its own control, separately labelled: fail-closed lease issuance is
              a different claim from M1's on-chain incapability. */}
          <div className="pg-control">
            {coreReach === 'checking' ? (
              <button className="pg-btn-ghost-wide" disabled>
                checking…
              </button>
            ) : coreUp ? (
              <button className="pg-btn-danger" onClick={() => void killCoreService()}>
                Kill approval service
              </button>
            ) : (
              <button className="pg-btn-ghost-wide" onClick={() => void reviveCoreService()}>
                Resume approval service
              </button>
            )}
            {killResult && <div className={killResult.ok ? 'pg-msg-ok' : 'pg-msg-err'}>{killResult.text}</div>}
            {!coreUp && killResult?.ok && (
              <div className="pg-msg-err">
                Watch the ring drain. All spending stops within {(leaseTtlMax / 1000).toFixed(0)}s, with no further
                action from anyone.
              </div>
            )}
          </div>

          {/* ── M1 ── */}
          <div className="pg-m1">
            <h3 className="pg-h3">Agent alone</h3>
            <p className="pg-m1-lede">
              The agent holds key share A and full network access. It does not need us to reach Base Sepolia.
            </p>
            <button className="pg-btn-attack-wide" onClick={() => void runRailBypass()} disabled={railBypassRunning}>
              {railBypassRunning ? 'Asking the chain…' : 'Pay itself, without the core'}
            </button>

            {railBypassError && <div className="pg-msg-err">{railBypassError}</div>}

            {railBypass && (
              <div className={`pg-m1-result ${railBypass.outcome === 'reverted' ? 'is-blocked' : 'is-critical'}`}>
                <div className="pg-m1-row">
                  <span>agent</span>
                  <span className="pg-mono" title={railBypass.agentAddress}>{shortHex(railBypass.agentAddress, 8, 4)}</span>
                </div>
                <div className="pg-m1-row">
                  <span>tried to take</span>
                  <span className="pg-mono">{formatInrMinor(railBypass.amountMinor, true)}</span>
                </div>
                {railBypass.outcome === 'reverted' ? (
                  <>
                    <div className="pg-m1-revert">{railBypass.revert}</div>
                    {railBypass.predicate && (
                      <div className="pg-m1-row">
                        <span>bound on</span>
                        <span className="pg-mono">{railBypass.predicate}</span>
                      </div>
                    )}
                    <p className="pg-m1-line">It isn&apos;t blocked. It&apos;s incapable.</p>
                  </>
                ) : (
                  <div className="pg-m1-revert">
                    The chain ACCEPTED a payment signed by one key share. The 2-of-2 claim is false.
                  </div>
                )}
                <div className="pg-m1-foot">
                  <a href={railBypass.accountUrl} target="_blank" rel="noopener noreferrer" className="pg-link">
                    RekhaAccount {shortHex(railBypass.rekhaAccount, 8, 4)} ↗
                  </a>
                  <span className="pg-m1-method">{railBypass.method}</span>
                </div>
              </div>
            )}
          </div>

          {/* ── M3: one gesture ── */}
          <div className="pg-ceremony-block">
            <h3 className="pg-h3">Signing ceremony</h3>
            <div className="pg-ceremony-row">
              <div className={`pg-ceremony ${ceremony?.aborted ? 'is-aborted' : ''}`}>
                {ceremony ? (
                  <>
                    <div className="pg-ceremony-track">
                      {Array.from({ length: ceremony.of }).map((_, i) => (
                        <div
                          key={i}
                          className={`pg-seg ${
                            ceremony.aborted && ceremony.abortedAt !== null && i >= ceremony.abortedAt - 1
                              ? 'is-broken'
                              : i < ceremony.round
                                ? 'is-done'
                                : 'is-pending'
                          }`}
                        />
                      ))}
                    </div>
                    <span className="pg-ceremony-label">
                      {ceremony.aborted
                        ? `broken at round ${ceremony.abortedAt} of ${ceremony.of}`
                        : `round ${ceremony.round} of ${ceremony.of}`}
                    </span>
                  </>
                ) : (
                  <span className="pg-ceremony-idle">idle — dispatch a task to start one</span>
                )}
              </div>

              <button className="pg-btn-revoke" onClick={() => void revokeMandate()} disabled={frozen}>
                {frozen ? 'REVOKED' : 'REVOKE'}
              </button>
            </div>
            <p className="pg-ceremony-note">
              Stops all spending until it is cleared. The console&apos;s REVOKE ALL is the
              stronger one — it goes to the contract from the owner&apos;s wallet, and that
              one has no undo at all.
            </p>
            {revokeResult && <div className={revokeResult.ok ? 'pg-msg-ok' : 'pg-msg-err'}>{revokeResult.text}</div>}
            {/* Only after the revoke has fired and been seen to work. See
                clearRevoke() for why this is not offered up front. */}
            {frozen && (
              <button className="pg-btn-reset" onClick={() => void clearRevoke()}>
                Clear the core revoke (rehearsal reset)
              </button>
            )}
          </div>
        </section>
      </div>

      {/* ── BOTTOM: M2 ─────────────────────────────────────────────────── */}
      <footer className="pg-rogue">
        <div className="pg-rogue-scores">
          <span className="pg-rogue-title">Rogue Mode</span>

          <div className="pg-score">
            <Counter value={rogueStats.attempts} className="pg-score-value" />
            <span className="pg-score-label">attempts</span>
          </div>

          {/* Three layers, counted separately.
              A single "blocked: 147" hid the fact that 144 of them died at the
              typed-schema boundary and only 3 ever reached a policy predicate.
              Split, it reads as defence in depth; conflated, it reads as
              something we were hoping nobody would check. */}
          <div className="pg-score">
            <Counter value={rogueStats.input} className="pg-score-value" />
            <span className="pg-score-label">input boundary</span>
          </div>
          <div className="pg-score">
            <Counter value={rogueStats.policy} className="pg-score-value" />
            <span className="pg-score-label">policy predicates</span>
          </div>
          <div className="pg-score">
            <Counter value={rogueStats.chain} className="pg-score-value" />
            <span className="pg-score-label">on chain</span>
          </div>

          {/* The core issued a decision and a co-signature for these. It is not
              the same as money moving — nothing in a Rogue Mode run settles, and
              PolicyModule enforces the window cap on chain against its own
              spend counter. Shown because a signature the policy should not
              have granted is a finding even when no rupee leaves the account. */}
          {rogueStats.approved > 0 && (
            <div className="pg-score pg-score-approved">
              <Counter value={rogueStats.approved} className="pg-score-value" />
              <span className="pg-score-label">core-approved, unsettled</span>
            </div>
          )}

          {/* Only rendered when non-zero — an attack we could not run is not a
              defence, and the run is incomplete until this is empty. */}
          {rogueStats.errored > 0 && (
            <div className="pg-score pg-score-errored">
              <Counter value={rogueStats.errored} className="pg-score-value" />
              <span className="pg-score-label">not tested</span>
            </div>
          )}

          {/* The largest number on the page, and the only --clear on it.
              It measures SETTLEMENT — money that actually left the account —
              which is the only thing "lost" can honestly mean. A Rogue Mode run
              settles nothing, so this is a real ₹0 and not a hopeful one. The
              core-approved tile beside it carries the weaker, separate fact. */}
          <div className="pg-score pg-score-lost">
            <span className="pg-score-lost-value">{formatInrMinor(0, true)}</span>
            <span className="pg-score-label">lost · nothing settled</span>
          </div>
        </div>

        <div className="pg-attacks">
          {attackLog.length === 0 ? (
            <div className="pg-empty">
              Nothing has attacked this core yet. Pick Compromised and dispatch.
            </div>
          ) : (
            attackLog.map((a) => (
              <div
                key={a.id}
                className={`pg-attack ${a.status === 'through' ? 'is-approved' : ''} ${a.status === 'errored' ? 'is-errored' : ''}`}
              >
                <span className="pg-attack-tech">{a.technique}</span>
                {a.novel && <span className="pg-attack-novel">novel</span>}
                {/* The stage is on the row, not just in the totals, so a judge
                    reading the log can see which layer caught each one. */}
                {a.stage && <span className="pg-attack-stage">{a.stage}</span>}
                <span className="pg-attack-verdict">
                  {a.status === 'blocked' ? 'blocked' : a.status === 'errored' ? 'not tested' : 'approved'}
                </span>
                <span className="pg-attack-reason">{a.revertReason}</span>
              </div>
            ))
          )}
        </div>
      </footer>
    </div>
  );
}
