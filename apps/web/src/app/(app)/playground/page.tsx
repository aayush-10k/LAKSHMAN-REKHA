'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CategoryCode, DecisionTrace, RekhaEvent } from '@/types';
import { CORE_URL, ensurePaired, renewLease, type Pairing } from '@/lib/pairing';
import { POLICY_MODULE_ADDRESS, basescanAddress, basescanTx, isPlaceholderDigest, shortHex } from '@/lib/contracts';
import { Amount, formatInrMinor } from '@/components/Amount';
import { CoreOffline } from '@/components/CoreOffline';
import { Counter } from '@/components/Counter';
import { PredicateTable } from '@/components/PredicateTable';
import { Rekha, type RekhaPulse } from '@/components/Rekha';
import { SoundToggle } from '@/components/SoundToggle';
import { TTLRing } from '@/components/TTLRing';
// A module import, not a hook and not a context: `sound` must never appear in
// processEvent's dependency array, because that array drives the EventSource.
import { sound } from '@/lib/sound';

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

/**
 * Which of the three demonstrations owns the stage.
 *
 * M3 is deliberately not one of these. Breaking a signing ceremony requires a
 * ceremony to be running, and the only thing that starts one is a dispatch from
 * `shop` — so a tab that replaced the dispatch controls with the REVOKE button
 * would make the moment unperformable. It lives in the rail instead, where it is
 * on screen at the instant it has to be pressed.
 */
type Stage = 'shop' | 'm1' | 'm2';

const STAGES: ReadonlyArray<{ id: Stage; tag: string; label: string }> = [
  { id: 'shop', tag: '', label: 'Let it buy' },
  { id: 'm1', tag: 'M1', label: 'Agent alone' },
  { id: 'm2', tag: 'M2', label: 'Rogue Mode' },
];

/**
 * The five behaviours a judge can put the agent into from `shop`.
 *
 * `compromised` is absent on purpose: it does not change what the agent buys, it
 * replays the attack suite, which is M2. Leaving it in this row meant Dispatch
 * did something entirely different depending on a selection made elsewhere.
 */
const SHOP_MODES: readonly BehaviourMode[] = ['normal', 'hallucinating', 'injected', 'overreach', 'colluding'];

/**
 * Things a judge can buy without having to invent an errand.
 *
 * A blank box asking for a natural-language task is the single most common place
 * a cold visitor stalls: they cannot know what this shop sells, so they type
 * nothing and the demo never starts.
 *
 * ── The order is the demo, and it is not arbitrary ────────────────────────
 * BUILD.md's fifth non-negotiable is "happy path first, always" — a system that
 * only ever blocks is a nuisance rather than a product. So the first two settle,
 * and the two that get stopped come after, for two different reasons.
 *
 * Every phrase below was MEASURED against the planner rather than guessed
 * (scripts/probe-plans.sh), because the wording decides the vendor and the
 * planner breaks ties toward the cheapest price:
 *
 *   3 amber glass bottles    ven_meridian    tier 1   ₹282     settles
 *   12 national parcels      ven_northstar   tier 1   ₹624     settles
 *   100 bottles              ven_flashcart   tier 3   ₹2,800   refused, counterpartyTier
 *   creative suite           ven_pixelvault  SOFTWARE ₹8,990   refused, categoryPermitted
 *
 * "order 100 bottles" is the interesting one and it is deliberately kept. Say
 * "bottles" without saying which, and the agent does the correct, boring thing a
 * buying agent should do — it takes the cheapest match — and walks straight into
 * a twelve-day-old seller at 70% off. Nothing is corrupted and no attack is
 * mounted; that is just what shopping on price looks like, and the counterparty
 * predicate is what stops it.
 *
 * The labels describe the purchase and nothing else. Announcing "this one will
 * be refused" before the evaluator has answered would put a claim on screen
 * ahead of its evidence, which is the one thing this interface does not do.
 */
const SUGGESTED_TASKS: readonly { label: string; task: string }[] = [
  { label: '3 amber glass bottles', task: 'order 3 amber glass bottles' },
  { label: '12 national parcels', task: 'ship 12 national parcels' },
  { label: '100 bottles, any seller', task: 'order 100 bottles' },
  { label: 'Renew the creative suite', task: 'renew our creative suite subscription' },
];

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
 * All six do something now.
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
  const [stage, setStage] = useState<Stage>('shop');
  const [mode, setMode] = useState<BehaviourMode>('normal');
  const [taskInput, setTaskInput] = useState('');
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [selectedTrace, setSelectedTrace] = useState<DecisionTrace | null>(null);
  const [dispatching, setDispatching] = useState(false);

  const [agentThoughts, setAgentThoughts] = useState<string[]>([]);
  const [attackLog, setAttackLog] = useState<AttackLog[]>([]);
  const [rogueStats, setRogueStats] = useState({ attempts: 0, input: 0, policy: 0, chain: 0, errored: 0, approved: 0 });
  const [ceremony, setCeremony] = useState<CeremonyState | null>(null);

  /**
   * Money that actually LEFT the account while the attack suite was running.
   *
   * "Lost" can only honestly mean settlement, so this counts `payment.settled`
   * and nothing else — not approvals, not co-signatures. It is expected to stay
   * at zero, and the whole value of the figure is that it is measured rather
   * than asserted: if an attack ever does settle, the biggest number on the page
   * turns --breach by itself and stops claiming a win we did not have.
   *
   * A ref gates it instead of state because `processEvent` must not gain deps —
   * its identity drives the EventSource effect, and churning it reconnects the
   * stream mid-run and drops attempts.
   */
  const [lostMinor, setLostMinor] = useState(0);
  const rogueActiveRef = useRef(false);

  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [leaseTtl, setLeaseTtl] = useState(0);
  const [leaseTtlMax, setLeaseTtlMax] = useState(15000);
  /**
   * A mirror of leaseTtlMax that `processEvent` can read.
   *
   * It cannot read the state value: doing so would put leaseTtlMax in
   * processEvent's dependency array, and that array is what the EventSource
   * effect keys on — so the first lease renewal that changed the configured TTL
   * would silently reconnect the stream. Written during render rather than in an
   * effect because it is only ever read from an event handler.
   */
  const leaseTtlMaxRef = useRef(15000);
  leaseTtlMaxRef.current = leaseTtlMax;
  const [coreUp, setCoreUp] = useState(false);
  const [imageDigest, setImageDigest] = useState<string | null>(null);
  const [revocationEpoch, setRevocationEpoch] = useState<number | null>(null);
  const [frozen, setFrozen] = useState(false);

  /**
   * Tri-state, as the console does it. 'checking' is not 'down':
   * a boolean flashes the offline panel on every load before the health probe
   * returns, and a warning that cries wolf gets ignored when it is real.
   */
  const [coreReach, setCoreReach] = useState<'checking' | 'up' | 'down'>('checking');
  const [coreReachReason, setCoreReachReason] = useState<string | null>(null);

  // Judge controls: the target vendor, and the last real result
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
  const taskInputRef = useRef<HTMLInputElement>(null);

  /**
   * The agent's discovery step, drawn.
   *
   * The agent genuinely reads the vendor registry, chooses a supplier, opens its
   * page and reads the price off the HTML — but all of that happened behind a
   * static iframe in well under a second, so the most interesting thing it does
   * was invisible. This shows it: the task as a query, the real catalogue as
   * results, and the one it opens.
   *
   * Nothing here is invented. `chosenVendorId` comes from the plan the runner
   * actually returned, the rows are the live catalogue, and the panel names the
   * registry as simulated so it can never be read as a live web search.
   */
  const [discovery, setDiscovery] = useState<{ query: string; chosenVendorId: string | null } | null>(null);
  /**
   * When the current discovery began, so it can be held on screen long enough to
   * read.
   *
   * Measured in a browser: the registry read and the page fetch complete in
   * under a second, so clearing on `quote.received` alone made the panel flash
   * past unseen — which is the same as not having built it. The floor below
   * keeps it up for ~2.2s total. It is a legibility floor and not a fiction: the
   * caption tracks the real state throughout ("reading the registry" until the
   * plan names a supplier, "supplier chosen" after), so nothing on it claims to
   * still be happening once it is not.
   */
  const discoveryStartRef = useRef(0);

  /** Bumped per M1 run so the stamp replays when a judge asks to see it again. */
  const [railBypassRun, setRailBypassRun] = useState(0);

  /** Fires the breach flash across the stage when a ceremony is broken. */
  const [vignette, setVignette] = useState(0);


  /** The line does not celebrate. Only 'flare' and 'snap' ever reach it. */
  const firePulse = useCallback((kind: 'flare' | 'snap') => {
    pulseIdRef.current += 1;
    setPulse({ kind, id: pulseIdRef.current });
  }, []);

  /**
   * Take the discovery panel down, but never before it has been readable.
   *
   * Every path that ends a browse comes through here, because they do not all
   * take the same time and one of them is very fast: a REFUSED dispatch has no
   * ceremony and no settlement, so the runner replies almost immediately and
   * `dispatchTask`'s finally used to clear the panel within half a second.
   * Measured in a browser — it appeared and vanished at 447ms, having never
   * reached full opacity.
   *
   * Stable identity (no deps), so it can be called from processEvent without
   * joining the dependency array that drives the EventSource.
   */
  const DISCOVERY_MIN_MS = 2200;
  const endDiscovery = useCallback(() => {
    const elapsed = Date.now() - discoveryStartRef.current;
    setTimeout(() => setDiscovery(null), Math.max(0, DISCOVERY_MIN_MS - elapsed));
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
        // Open on a tier-3 seller rather than the first in the list.
        //
        // Two reasons. It is the more interesting page — the one with no GST
        // number and five stars from six ratings — so the storefront panel is
        // showing something worth reading before anything is dispatched. And it
        // keeps "Spawn counterfeit", whose target is whatever is selected, off
        // the real-brand tier-1 vendors by default: cloning one of those would
        // put "<Brand> — Clearance Outlet" on screen, which is a claim about a
        // real company we have no business making.
        const opening = list.find((v) => v.tier === 3) ?? list[0];
        if (opening) setTargetVendorId((prev) => prev || opening.id);
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
          // Audible only in the last fifth, where the ring is already --breach.
          // A lease ticking all day is a metronome nobody hears; one that starts
          // ticking is the fail-closed guarantee arriving.
          if (event.ttlMs > 0 && event.ttlMs < leaseTtlMaxRef.current * 0.2) sound.play('leaseTick');
          return;

        case 'revocation':
          setFrozen(true);
          setRevocationEpoch(event.epoch);
          // De-duplicated inside the engine: one REVOKE press emits both this
          // and ceremony.aborted, and that is one gesture, so one snap.
          sound.play('snap');
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
          // The plan names the supplier the agent settled on, so the discovery
          // panel can mark it. Functional update — no new dependency.
          setDiscovery((d) => {
            if (d === null) return d;
            const first = (event.plan as PlanItem[])[0];
            return first ? { ...d, chosenVendorId: first.vendorId } : d;
          });
          return;

        case 'quote.received':
          // A price has been read off the page, so the browse is over and the
          // storefront itself takes the stage — but not before the panel has
          // been up long enough to read.
          endDiscovery();
          return;

        case 'agent.thought':
          setAgentThoughts((prev) => [...prev.slice(-49), event.text]);
          // Scroll after paint, so the newest line is the one in view.
          requestAnimationFrame(() => {
            if (thoughtsRef.current) thoughtsRef.current.scrollTop = thoughtsRef.current.scrollHeight;
          });
          return;

        case 'decision.made':
          // Deliberately does NOT open the decision panel.
          //
          // This event is emitted before the signing ceremony runs, and the
          // panel covers the screen — so opening it here put a dialog over the
          // ceremony bar at exactly the moment M3 asks a judge to watch that bar
          // break. It also fired once per attempt during the attack suite,
          // reopening faster than it could be dismissed.
          //
          // dispatchTask opens the panel from the runner's reply instead, which
          // arrives after the ceremony and after settlement. A dispatch that was
          // revoked mid-ceremony returns an error and correctly opens nothing.
          //
          // It IS worth hearing, though — the outcome is decided here, a beat
          // before the ceremony and two before settlement. Suppressed during the
          // attack suite, where every attempt is a decision and the geiger is
          // already carrying the rate.
          if (!rogueActiveRef.current) {
            if (event.trace.outcome === 'REFUSED') sound.play('refused');
            else if (event.trace.outcome === 'HELD') sound.play('held');
          }
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
            // themselves is a judge we have lost.
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
          // Blocked attempts are a geiger crackle — rate-limited in the engine,
          // because ninety-nine chimes is a fire alarm and the interesting
          // quantity is how FAST they are arriving, not each one. Anything that
          // got through gets the only alarming sound in the product.
          sound.play(status === 'through' ? 'alarm' : 'geiger');
          return;
        }

        case 'ceremony.round':
          setCeremony({ decisionId: event.decisionId, round: event.round, of: event.of, aborted: false, abortedAt: null });
          // Rising whole tones, so the ceremony audibly climbs and REVOKE has
          // something to cut off mid-phrase.
          sound.play('ceremonyRound', { round: event.round });

          // The last round is the end of the ceremony whether or not anything
          // settles — and during the attack suite nothing does: those approvals
          // are void, so `payment.settled` never arrives to clear the bar and the
          // rail sat on "round 3 of 3" for the rest of the session. Observed
          // after a full M2 run. Held first so the completed bar is seen.
          if (event.round === event.of) {
            const finished = event.decisionId;
            setTimeout(() => {
              setCeremony((prev) =>
                prev && prev.decisionId === finished && !prev.aborted ? null : prev,
              );
            }, 4000);
          }
          return;

        case 'ceremony.aborted':
          setCeremony((prev) =>
            prev ? { ...prev, aborted: true, abortedAt: event.atRound } : null,
          );
          firePulse('snap');
          sound.play('snap');
          // The room reacts, not just the bar. This is the highest-value moment
          // in the demo and it gets the only screen-wide effect in the product.
          setVignette((v) => v + 1);
          setTimeout(() => setCeremony(null), 4000);
          return;

        case 'payment.settled':
          // Two jobs, both of them corrections.
          //
          // 1. A ceremony that COMPLETED had nothing to clear it. Only the abort
          //    path reset the bar, so after a successful dispatch it sat on
          //    "round 3 of 3" indefinitely and the idle caption never came back —
          //    which reads, on the next rehearsal, as a ceremony still running.
          //    Held for a beat first so the full bar is seen before it goes.
          // 2. Settlement during an attack run is the only thing that can make
          //    the "lost" figure non-zero. See lostMinor.
          setCeremony((prev) =>
            prev && prev.decisionId === event.decisionId && !prev.aborted ? { ...prev, round: prev.of } : prev,
          );
          setTimeout(() => {
            setCeremony((prev) => (prev && prev.decisionId === event.decisionId && !prev.aborted ? null : prev));
          }, 2500);
          if (rogueActiveRef.current) setLostMinor((v) => v + event.amountMinor);
          sound.play('settle');
          return;

        default:
          // quote.received, payment.requested, payment.held, hold.released —
          // the owner's money, which is the console's feed. A settled payment
          // deliberately produces no Rekha pulse: the line does not celebrate.
          return;
      }
    },
    // Both are useCallback(..., []) — their identity never changes, so this
    // array never changes, so the EventSource effect below never re-runs. That
    // is the property being protected here, not the list itself: anything added
    // to it that CAN change identity reconnects the stream mid-demo and drops
    // whatever arrives in the gap.
    [firePulse, endDiscovery],
  );

  // Escape closes the decision. It covers the stage, and during a demo the
  // presenter's hand is on the keyboard, not hunting for a close button.
  useEffect(() => {
    if (selectedTrace === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedTrace(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedTrace]);

  useEffect(() => {
    const evtSource = new EventSource(`${CORE_URL}/v1/events`);
    evtSource.onmessage = (e) => processEvent(JSON.parse(e.data) as RekhaEvent);
    evtSource.onerror = () => setCoreUp(false);
    return () => evtSource.close();
  }, [processEvent]);

  // ── Rogue Mode ─────────────────────────────────────────────────────────
  /**
   * `mode` used to be threaded all the way through and then
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
    setLostMinor(0);
    rogueActiveRef.current = true;

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

    // Close the attack window. The suite's HTTP reply lands well before its SSE
    // replay finishes, so the flag cannot be cleared when the call returns —
    // it is cleared here instead, by the next ordinary purchase, which is the
    // first settlement that must NOT be counted as money an attacker took.
    rogueActiveRef.current = false;

    // The agent is about to read the registry and open a storefront. Show that
    // happening; `task.started` marks which supplier it chose and
    // `quote.received` ends it.
    discoveryStartRef.current = Date.now();
    setDiscovery({ query: description, chosenVendorId: null });

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

      // The row normally already exists, created by the `task.started` event.
      // If that event was missed the dispatch still succeeded, so the results
      // get a row of their own rather than being dropped.
      //
      // Missing it is not hypothetical: an EventSource reconnecting across a
      // core restart loses whatever was emitted during the gap, and the failure
      // branch above has always handled that case while this one did not.
      // Observed in a browser — an APPROVED ₹282.00 payment settled at block
      // 45078382 and the page showed nothing at all.
      setTasks((prev) => {
        const done = {
          status: 'done' as const,
          plan: body.plan,
          results: body.results as LineItemResult[],
          error: null,
          note: (body.note as string | null) ?? null,
        };
        if (!prev.some((t) => t.id === body.taskId)) {
          return [{ id: body.taskId, description, mode, ...done }, ...prev];
        }
        return prev.map((t) => (t.id === body.taskId ? { ...t, ...done } : t));
      });

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
      // Whatever happened, the browse is over. A dispatch that failed before any
      // quote would otherwise leave the discovery panel covering the storefront.
      // Through the same floor as every other exit — a refusal comes back fast
      // enough that clearing it directly made the panel unreadable.
      endDiscovery();
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
      sound.play('kill');
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
      sound.play('revive');
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
   * It stops spending until it is explicitly cleared, and the note under the button says so before it is pressed rather
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
      // Bumped so the stamp animation replays. A judge who says "do that again"
      // has to see it happen again, not a panel that was already there.
      setRailBypassRun((n) => n + 1);
      // A refused attack is the line being tested, so it flares — the same
      // reaction any other blocked attempt gets, for the same reason.
      if (body.outcome === 'reverted') {
        firePulse('flare');
        sound.play('refused');
      } else {
        // The chain accepted a single-share signature. The product's central
        // claim would be false, and it gets the alarm.
        sound.play('alarm');
      }
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

  /**
   * The suppliers the discovery panel lists — always including the one the agent
   * actually chose, whatever its position in the catalogue.
   */
  const DISCOVERY_ROWS = 5;
  const discoveryRows = (() => {
    const head = vendors.slice(0, DISCOVERY_ROWS);
    const chosenId = discovery?.chosenVendorId;
    if (!chosenId || head.some((v) => v.id === chosenId)) return head;
    const chosen = vendors.find((v) => v.id === chosenId);
    return chosen ? [...head.slice(0, DISCOVERY_ROWS - 1), chosen] : head;
  })();

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

  const hasRun = tasks.length > 0;
  /** The adversary run's own row, so M2 can show its state without the task list. */
  const rogueRow = tasks.find((t) => t.id.startsWith('rogue-')) ?? null;
  const rogueRunning = rogueRow?.status === 'running';

  return (
    <div className="pg-layout">
      {/* One row carries the identity, the navigation and the only global state
          a judge has to notice. The agent id that used to sit here named a
          process nobody in the room can act on. */}
      <header className="pg-topbar">
        <a href="/console" className="pg-brand" title="Owner console">←</a>
        <span className="pg-wordmark">Lakshman Rekha</span>

        <nav className="pg-stages" aria-label="Demonstration">
          {STAGES.map((s) => (
            <button
              key={s.id}
              className={`pg-stage-tab ${stage === s.id ? 'is-active' : ''}`}
              onClick={() => {
                setStage(s.id);
                sound.play('select');
              }}
              aria-current={stage === s.id ? 'page' : undefined}
            >
              {/* M1 and M2 are FINALE.md's own names for these two moments, not
                  ornamental numbering. `shop` carries no tag because it is the
                  setup, not one of the three. */}
              {s.tag && <span className="pg-stage-tag">{s.tag}</span>}
              {s.label}
            </button>
          ))}
        </nav>

        {frozen && <span className="pg-frozen fx-stamp">REVOKED · epoch {revocationEpoch ?? '?'}</span>}
        {/* Pushed to the right edge when nothing is frozen; the chip takes the
            margin when it appears. */}
        <SoundToggle className={frozen ? '' : 'fx-sound-end'} />
      </header>

      {pairError && <div className="pg-banner">Agent not paired — {pairError}</div>}

      <div className="pg-body">
        {/* The line is drawn around the whole stage, not around one panel inside
            it. Whatever the agent is doing, it is doing it in here. */}
        <Rekha pulse={pulse} className="pg-stage-area">
        {/* The room reacting to a broken ceremony. Keyed so it replays on every
            abort, and deliberately an opacity-only overlay INSIDE the Rekha's
            content box: the boundary redraws itself from a ResizeObserver, so
            anything that changes the host's size or transform mid-animation
            makes the line fight the redraw. */}
        {vignette > 0 && <div key={vignette} className="fx-stage-vignette is-firing" aria-hidden="true" />}

        {/* ══ SHOP ═══════════════════════════════════════════════════════ */}
        {stage === 'shop' && (
          <section className="pg-shop">
            <div className="pg-command">
              <input
                ref={taskInputRef}
                className="pg-input pg-task-input"
                placeholder='Tell the agent what to buy — e.g. "order 100 bottles"'
                value={taskInput}
                onChange={(e) => setTaskInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void dispatchTask();
                }}
              />
              <button
                className="pg-btn-primary"
                onClick={() => void dispatchTask()}
                disabled={dispatching}
                data-tip="Hand the task to the agent and watch it spend"
              >
                {dispatching ? 'Working…' : 'Dispatch'}
              </button>
            </div>

            {/* A blank box asking for a natural-language task is where a cold
                visitor stalls: they cannot know what this shop sells. These fill
                it in. The last is SOFTWARE, the one category the deployed policy
                forbids, so it refuses on chain with no attack needed. */}
            <div className="fx-chips">
              <span className="fx-chips-label">try</span>
              {SUGGESTED_TASKS.map((s) => (
                <button
                  key={s.task}
                  className="fx-chip"
                  onClick={() => {
                    setTaskInput(s.task);
                    taskInputRef.current?.focus();
                    sound.play('select');
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {/* Until something has run. Three steps, in the order they happen,
                pointing at controls that are all on screen. */}
            {!hasRun && (
              <div className="fx-steps fx-reveal" style={{ ['--fx-i' as string]: 1 }}>
                <span className="fx-step"><span className="fx-step-n">1</span>pick how the agent behaves</span>
                <span className="fx-step-arrow">→</span>
                <span className="fx-step"><span className="fx-step-n">2</span>dispatch a task</span>
                <span className="fx-step-arrow">→</span>
                <span className="fx-step"><span className="fx-step-n">3</span>click the outcome to see which rule decided it</span>
              </div>
            )}

            {/* Five chips on one line, rather than six stacked cards. The
                description belongs to whichever is selected, so only one is on
                screen at a time. */}
            <div className="pg-modebar">
              {SHOP_MODES.map((m) => (
                <button
                  key={m}
                  className={`pg-modechip ${mode === m ? 'is-active' : ''}`}
                  onClick={() => {
                    setMode(m);
                    sound.play('select');
                  }}
                  aria-pressed={mode === m}
                  // Hoverable without selecting: the description below belongs
                  // to whichever mode is active, so comparing two of them
                  // otherwise means committing to one first.
                  data-tip={MODE_INFO[m].description}
                >
                  {MODE_INFO[m].label}
                </button>
              ))}
              <span className="pg-mode-current">
                {MODE_INFO[mode].description}
                {MODE_INFO[mode].catches && (
                  <span className="pg-mode-tag">→ {MODE_INFO[mode].catches}</span>
                )}
              </span>
            </div>

            {/* The storefront, at the size of the thing it represents. The agent
                reads this page; a judge has to be able to read it too. */}
            <div className="pg-web">
              <div className="pg-web-chrome">
                <span className="pg-web-label">the open web, as the agent finds it</span>
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
                <span className="pg-web-spacer" />
                <button
                  className="pg-btn-attack"
                  onClick={() => void spawnCounterfeit()}
                  data-tip="Clone this seller at 40% of its prices, two days old, tier 2"
                >
                  Spawn counterfeit
                </button>
                <input
                  className="pg-input pg-inject-input"
                  placeholder={targetVendorId ? 'Write something onto this page…' : 'No storefront selected'}
                  value={injectText}
                  onChange={(e) => setInjectText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void injectIntoVendor();
                  }}
                />
                <button
                  className="pg-btn-attack"
                  onClick={() => void injectIntoVendor()}
                  data-tip="Write your text onto this live storefront. The agent reads it on the next dispatch."
                >
                  Inject
                </button>
              </div>

              {/* The discovery step, drawn over the frame it is about to reveal.
                  It is a sibling of the iframe rather than a wrapper on purpose:
                  the frame's key is `${vendor}-${nonce}` and remounting it
                  reloads the storefront, so nothing may be allowed to change its
                  position in the tree. */}
              {discovery && (
                <div className="fx-discover">
                  <div className="fx-discover-bar">
                    <span className="fx-discover-glyph" aria-hidden="true">⌕</span>
                    <span className="fx-discover-query">
                      {discovery.query}
                      <span className="fx-discover-caret" aria-hidden="true" />
                    </span>
                  </div>
                  <span className="fx-discover-label">
                    {discovery.chosenVendorId ? 'supplier chosen — opening its page' : 'reading the supplier registry…'}
                  </span>
                  <div className="fx-discover-list">
                    {/* The chosen supplier is always one of the rows.
                        Measured: "order 100 bottles" plans against ven_flashcart,
                        which is sixth in the catalogue — so a plain slice(0,5)
                        showed the caption "supplier chosen" above five rows, none
                        of which was highlighted. */}
                    {discoveryRows.map((v, i) => (
                      <div
                        key={v.id}
                        className={`fx-discover-row ${discovery.chosenVendorId === v.id ? 'is-chosen' : ''}`}
                        style={{ ['--fx-i' as string]: i }}
                      >
                        <span className="fx-discover-name">{v.name}</span>
                        <span className="fx-discover-meta">{v.id}</span>
                        <span className="fx-discover-tier">tier {v.tier}</span>
                      </div>
                    ))}
                  </div>
                  {/* Says what it is. This is the simulated registry, not a web
                      search, and the panel must never imply otherwise. */}
                  <span className="fx-discover-foot">
                    Simulated supplier registry — the same catalogue the policy engine checks tiers against.
                  </span>
                </div>
              )}

              {storefrontUrl ? (
                <iframe
                  key={`${targetVendorId}-${storefrontNonce}`}
                  className="pg-web-frame"
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

              {counterfeitResult && (
                <div className={counterfeitResult.ok ? 'pg-msg-ok' : 'pg-msg-err'}>{counterfeitResult.text}</div>
              )}
              {injectResult && <div className={injectResult.ok ? 'pg-msg-ok' : 'pg-msg-err'}>{injectResult.text}</div>}
            </div>

            {/* Nothing to report until something has been dispatched, and an
                empty panel would cost the storefront a third of its height. */}
            {hasRun && (
              <div className="pg-drawer">
                <div className="pg-drawer-col pg-tasks">
                  {tasks.map((task) => (
                <div key={task.id} className={`pg-task pg-task-${task.status}`}>
                  <div className="pg-task-head">
                    <span className="pg-task-desc">{task.description}</span>
                    <span className="pg-task-mode">{task.mode}</span>
                  </div>

                  {task.error && <div className="pg-task-error">{task.error}</div>}
                  {task.note && !task.error && <div className="pg-task-note">{task.note}</div>}

                  {task.plan.map((item) => {
                    const result = task.results.find((r) => r.lineItemId === item.lineItemId);

                    /**
                     * The amount ASKED FOR, not the amount planned.
                     *
                     * This row used to render `item.estimatedAmountMinor` even
                     * after the result came back — the planner's
                     * `units × registry price`, computed before the agent ever
                     * opened the storefront. Caught in a browser: an `injected`
                     * dispatch where the page talked the agent into paying
                     * ₹9,99,800 to `0xdeadbeef…` displayed as **₹480**. The one
                     * number on screen was the one number the agent did not use.
                     *
                     * It is wrong in every mode, not just that one. Reading the
                     * price off a live page is the entire point of browsing —
                     * so estimate and actual are *expected* to differ, and the
                     * difference is the story rather than a detail.
                     *
                     * Estimate is still shown while the dispatch is in flight,
                     * because until a result exists it is the only figure there
                     * is, and it is labelled `est` so it cannot be misread as
                     * settled.
                     */
                    const asked = result?.amountMinor ?? item.estimatedAmountMinor;
                    const movedPrice = result != null && result.amountMinor !== item.estimatedAmountMinor;
                    // Likewise the payee. In `injected` and `colluding` the
                    // agent submits a counterparty that is not the vendor whose
                    // page it read, and naming only the vendor would hide it.
                    const movedPayee =
                      result != null && result.vendorId !== item.vendorId;

                    return (
                      <div key={item.lineItemId} className="pg-line">
                        <div className="pg-line-row">
                          <span className="pg-line-vendor">
                            {item.vendorId}
                            {movedPayee && <> → {result.vendorId}</>}
                          </span>
                          <Amount minor={asked} compact className="pg-line-amount" />
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
                          {!result && <span className="pg-line-est">est</span>}
                        </div>

                        {/* Only when the page moved it. Silent on an ordinary
                            purchase, loud on the demo that depends on it. */}
                        {movedPrice && (
                          <div className="pg-line-moved">
                            the storefront moved this off the registry&apos;s{' '}
                            <Amount minor={item.estimatedAmountMinor} compact />
                          </div>
                        )}
                        {result && result.counterparty !== undefined && (
                          <div className="pg-line-payee">
                            paid to <span className="pg-mono">{shortHex(result.counterparty, 10, 6)}</span>
                          </div>
                        )}

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
                  ))}
                </div>

                <div className="pg-drawer-col pg-thoughts" ref={thoughtsRef}>
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
                  {/* A cursor while it is still working. Without it a stalled
                      dispatch and a finished one look identical. */}
                  {dispatching && (
                    <div className="fx-thinking">
                      <span className="fx-thought-cursor" aria-hidden="true" />
                      <span>thinking</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {/* ══ M1 ═════════════════════════════════════════════════════════ */}
        {stage === 'm1' && (
          <section className="pg-moment">
            <h2 className="pg-moment-title">The agent already has everything it needs</h2>
            <p className="pg-moment-lede">
              It holds key share A. It has full network access. It does not need this service to reach
              Base Sepolia, and it is about to try calling <code>RekhaAccount.execute</code> itself.
            </p>

            <button className="pg-btn-attack-wide" onClick={() => void runRailBypass()} disabled={railBypassRunning}>
              {railBypassRunning ? 'Asking the chain…' : 'Pay itself, without the core'}
            </button>

            {railBypassError && <div className="pg-msg-err">{railBypassError}</div>}

            {railBypass && (
              // Keyed on the run counter so the stamp replays on every press.
              // Without it a second run swaps the text in silently and the
              // moment reads as a static panel that was always there.
              <div
                key={railBypassRun}
                className={`pg-m1-result fx-stamp ${railBypass.outcome === 'reverted' ? 'is-blocked' : 'is-critical'}`}
              >
                {railBypass.outcome === 'reverted' ? (
                  <>
                    {/* The contract's own revert string, at the size of the
                        claim it settles. Nothing on this page decides it. */}
                    <div className="pg-verdict-revert">{railBypass.revert}</div>
                    <p className="pg-verdict-line">It isn&apos;t blocked. It&apos;s incapable.</p>
                  </>
                ) : (
                  <div className="pg-verdict-revert is-critical">
                    The chain ACCEPTED a payment signed by one key share. The 2-of-2 claim is false.
                  </div>
                )}

                <dl className="pg-facts">
                  <div><dt>agent</dt><dd className="pg-mono" title={railBypass.agentAddress}>{shortHex(railBypass.agentAddress, 10, 6)}</dd></div>
                  <div><dt>tried to take</dt><dd className="pg-mono">{formatInrMinor(railBypass.amountMinor, true)}</dd></div>
                  {railBypass.predicate && (
                    <div><dt>bound on</dt><dd className="pg-mono">{railBypass.predicate}</dd></div>
                  )}
                  <div><dt>called</dt><dd className="pg-mono">{railBypass.method}</dd></div>
                </dl>

                <a href={railBypass.accountUrl} target="_blank" rel="noopener noreferrer" className="pg-link">
                  RekhaAccount {shortHex(railBypass.rekhaAccount, 8, 4)} on Basescan ↗
                </a>
              </div>
            )}
          </section>
        )}

        {/* ══ M2 ═════════════════════════════════════════════════════════ */}
        {stage === 'm2' && (
          <section className="pg-moment pg-m2">
            <div className="pg-m2-head">
              <div>
                <h2 className="pg-moment-title">Let it attack us</h2>
                <p className="pg-moment-lede">
                  The deterministic attack suite, run against this core, live. Each attempt is
                  labelled with the layer that stopped it.
                </p>
              </div>
              <button
                className="pg-btn-attack-wide pg-m2-run"
                onClick={() => {
                  setMode('compromised');
                  void runAdversary('Rogue Mode — deterministic attack suite');
                }}
                disabled={rogueRunning}
              >
                {rogueRunning ? 'Attacking…' : 'Run the attack suite'}
              </button>
            </div>

            {/* The route waits for the whole suite before replaying it, so the
                board stays at zero for minutes with nothing else to look at.
                Silence for that long reads as a broken button. */}
            {rogueRunning && (
              <div className="pg-msg-ok">
                Running all 12 classes against this core over HTTP. It takes two to four minutes,
                and the board fills as each verdict comes back. Do not click again.
                {/* Indeterminate on purpose — the remaining count is not known
                    until the run replies. It exists so two minutes of silence
                    does not read as a dead button. */}
                <div className="fx-shimmer" role="presentation" />
              </div>
            )}

            {rogueRow?.error && <div className="pg-msg-err">{rogueRow.error}</div>}

            <div className="pg-scores">
              <div className="pg-score">
                <Counter value={rogueStats.attempts} className="pg-score-value" />
                <span className="pg-score-label">attempts</span>
              </div>
              {/* One "blocked: 147" hid that 144 died at the typed-schema
                  boundary and 3 reached a predicate. Split, it reads as defence
                  in depth; conflated, as something we hoped nobody would check. */}
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

              {rogueStats.approved > 0 && (
                <div className="pg-score pg-score-approved">
                  <Counter value={rogueStats.approved} className="pg-score-value" />
                  <span className="pg-score-label">core-approved, unsettled</span>
                </div>
              )}
              {/* An attack we could not run is not a defence, so this appears
                  only when the run is incomplete. */}
              {rogueStats.errored > 0 && (
                <div className="pg-score pg-score-errored">
                  <Counter value={rogueStats.errored} className="pg-score-value" />
                  <span className="pg-score-label">not tested</span>
                </div>
              )}

              {/* The largest figure on the page, and the only --clear on it. It
                  measures SETTLEMENT — money that left the account — which is
                  the only thing "lost" can honestly mean.
                  The figure is derived, not typed. It read `formatInrMinor(0)`
                  as a literal, and `.pg-score-lost.is-breached` — the rule that
                  strips the green off the instant the claim stops being true —
                  had no way to ever apply. A hardcoded zero is exactly the
                  failure the rest of this file spends its comments avoiding. */}
              {/* `fx-alive` breathes a green halo, but only while attacks are
                  actually arriving and the claim still holds. It is switched off
                  the moment anything settles — the halo must never outlive the
                  sentence it is decorating. */}
              <div
                className={`pg-score pg-score-lost ${lostMinor > 0 ? 'is-breached' : ''} ${
                  rogueStats.attempts > 0 && lostMinor === 0 ? 'fx-alive' : ''
                }`}
              >
                <span className="pg-score-lost-value">{formatInrMinor(lostMinor, true)}</span>
                <span className="pg-score-label">
                  {lostMinor > 0 ? 'lost · money settled' : 'lost · nothing settled'}
                </span>
              </div>
            </div>

            <div className="pg-attacks">
              {attackLog.length === 0 ? (
                <div className="pg-empty">Nothing has attacked this core yet.</div>
              ) : (
                attackLog.map((a) => (
                  <div
                    key={a.id}
                    className={`pg-attack ${a.status === 'through' ? 'is-approved' : ''} ${a.status === 'errored' ? 'is-errored' : ''}`}
                  >
                    <span className="pg-attack-tech">{a.technique}</span>
                    {a.novel && <span className="pg-attack-novel">novel</span>}
                    {a.stage && <span className="pg-attack-stage">{a.stage}</span>}
                    <span className="pg-attack-verdict">
                      {a.status === 'blocked' ? 'blocked' : a.status === 'errored' ? 'not tested' : 'approved'}
                    </span>
                    <span className="pg-attack-reason">{a.revertReason}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        )}
        </Rekha>

        {/* The rail does not change between stages. That is the argument: the
            same lease, the same core, the same contract are doing the work in
            all three, and a judge can watch them while the stage changes. */}
        <aside className="pg-rail">
          <div
            className="pg-lease fx-tip-left"
            data-tip="Every payment needs an unexpired lease. No core, no lease, no spending."
          >
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
              <button
                className="pg-btn-danger fx-tip-left"
                onClick={() => void killCoreService()}
                data-tip={`Stops lease issuance for real. All spending halts within ${(leaseTtlMax / 1000).toFixed(0)}s.`}
              >
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

          {/* ── M3 ── the one gesture, on screen in every stage because the
              only thing that starts a ceremony is a dispatch from `shop`. */}
          <div className="pg-ceremony-block">
            <h3 className="pg-h3"><span className="pg-moment-tag">M3</span> Signing ceremony</h3>
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

              <button
                className="pg-btn-revoke fx-tip-left"
                onClick={() => void revokeMandate()}
                disabled={frozen}
                data-tip="Press this while the bar is filling. The signature is abandoned before it exists."
              >
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
        </aside>
      </div>

      {/* The decision takes the screen rather than a corner of it. A refusal
          nobody can read is indistinguishable from a crash, and the predicate
          that bound is the whole product. */}
      {selectedTrace && (
        <div
          className="pg-decision-scrim"
          role="dialog"
          aria-modal="true"
          aria-label="Decision"
          onClick={() => setSelectedTrace(null)}
        >
          <div className="pg-decision" onClick={(e) => e.stopPropagation()}>
            <div className="pg-decision-head">
              <h2 className="pg-h2">
                Decision
                {selectedTrace.bindingPredicate && (
                  <span className="pg-decision-bound">bound on {selectedTrace.bindingPredicate}</span>
                )}
              </h2>
              <button className="pg-btn-ghost" onClick={() => setSelectedTrace(null)}>
                close
              </button>
            </div>
            <PredicateTable trace={selectedTrace} />
          </div>
        </div>
      )}
    </div>
  );
}
