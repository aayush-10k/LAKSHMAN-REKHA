'use client';

import { useSyncExternalStore } from 'react';

/**
 * The sound layer.
 *
 * Every sound in this product is synthesised at play time from oscillators and
 * one shared noise buffer. There are no audio files, no dependency, and no
 * network request — which matters on demo day for the same reason the fonts are
 * self-hosted: nothing audible may depend on conference wifi.
 *
 * ── What it is for ────────────────────────────────────────────────────────
 * This is a payments product being attacked live. Sound carries two things a
 * silent screen cannot: the RATE of the attack suite (99 attempts arriving as a
 * geiger crackle rather than a list scrolling), and the MOMENT a signature dies
 * mid-ceremony. Both are the argument, not decoration.
 *
 * Each sound maps to a state that already exists on screen, so nothing here is
 * new information — turn it off and no claim is lost. That is the test a sound
 * had to pass to be in this file.
 *
 * ── Why a module singleton, and not a React context ───────────────────────
 * The call sites are the two pages' `processEvent` switches. Those functions are
 * `useCallback`s whose identity is a dependency of the `useEffect` that opens
 * the `EventSource`. A context value read inside them would join that dependency
 * array, and every toggle of the mute button would tear down and reopen the SSE
 * stream — dropping whatever arrived in the gap. That failure has already been
 * observed in this codebase once (see the note in playground's dispatchTask
 * about a settled ₹282 payment that never appeared).
 *
 * So: `import { sound } from '@/lib/sound'` and call `sound.play(...)`. A module
 * import contributes nothing to any dependency array. Only the toggle BUTTON
 * subscribes, through useSound(), and it is a leaf.
 *
 * ── SSR ───────────────────────────────────────────────────────────────────
 * Nothing at module scope touches window, AudioContext or localStorage. The
 * store hands React a stable server snapshot so hydration cannot mismatch; the
 * real preference is adopted on the client immediately after.
 */

export type SoundEvent =
  | 'settle'
  | 'held'
  | 'refused'
  | 'geiger'
  | 'alarm'
  | 'ceremonyRound'
  | 'snap'
  | 'kill'
  | 'revive'
  | 'leaseTick'
  | 'select';

const STORAGE_KEY = 'rekha.sound';

// ── Store ──────────────────────────────────────────────────────────────────

let enabled = true;
let hydrated = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/**
 * The stored preference, or the default.
 *
 * Default ON, except when the visitor asks for reduced motion — that setting is
 * the closest signal a browser gives for "do not perform at me", and honouring
 * it for sound as well as movement costs nothing. An explicit choice always
 * wins over both.
 */
function readPreference(): boolean {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'on') return true;
    if (stored === 'off') return false;
  } catch {
    /* private mode: fall through to the default */
  }
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  } catch {
    /* no matchMedia: keep the default */
  }
  return true;
}

function hydrate(): void {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  enabled = readPreference();
}

// ── Audio graph ────────────────────────────────────────────────────────────

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let voices = 0;

/** Hard ceiling on simultaneous voices. Insurance, not a design parameter. */
const MAX_VOICES = 16;

/**
 * Build the graph. Called on the first real gesture, never before — browsers
 * refuse to start an AudioContext without one, and one created early sits
 * `suspended` and silently swallows everything played into it.
 */
function ensureContext(): AudioContext | null {
  if (ctx !== null) return ctx;
  if (typeof window === 'undefined') return null;

  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;

  ctx = new Ctor();

  /**
   * master → compressor → destination.
   *
   * The compressor is the insurance against Rogue Mode. The scheduler below
   * already paces the geiger ticks, but if scheduling ever slips, ninety-nine
   * overlapping transients clip — and clipping through a hall PA is the one
   * audio failure everyone in the room notices.
   */
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;

  master = ctx.createGain();
  master.gain.value = 0.55;
  master.connect(comp);
  comp.connect(ctx.destination);

  // One second of white noise, generated once and reused by every noise voice.
  const frames = Math.floor(ctx.sampleRate);
  noise = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

  return ctx;
}

/** True when audio can actually be heard right now. */
function live(): boolean {
  return enabled && ctx !== null && master !== null && ctx.state === 'running';
}

// ── Voice helpers ──────────────────────────────────────────────────────────

type ToneSpec = {
  type: OscillatorType;
  /** Start frequency, Hz. */
  freq: number;
  /** Optional glide target; linear over the note's length. */
  freqTo?: number;
  /** Peak gain. */
  gain: number;
  /** Seconds. */
  duration: number;
  /** Seconds from now. */
  delay?: number;
  attack?: number;
  detune?: number;
  filter?: { type: BiquadFilterType; freq: number; freqTo?: number; q?: number };
};

/**
 * Exponential ramps cannot reach zero, so every decay lands on this and the node
 * is stopped immediately after. Ramping to a true 0 throws in some engines and
 * produces a click in the rest.
 */
const SILENCE = 0.0001;

function tone(spec: ToneSpec): void {
  const c = ctx;
  const out = master;
  if (c === null || out === null || voices >= MAX_VOICES) return;

  const t0 = c.currentTime + (spec.delay ?? 0);
  const attack = spec.attack ?? 0.005;

  const osc = c.createOscillator();
  osc.type = spec.type;
  osc.frequency.setValueAtTime(spec.freq, t0);
  if (spec.freqTo !== undefined) osc.frequency.linearRampToValueAtTime(spec.freqTo, t0 + spec.duration);
  if (spec.detune !== undefined) osc.detune.setValueAtTime(spec.detune, t0);

  const gain = c.createGain();
  gain.gain.setValueAtTime(SILENCE, t0);
  gain.gain.exponentialRampToValueAtTime(spec.gain, t0 + attack);
  gain.gain.exponentialRampToValueAtTime(SILENCE, t0 + spec.duration);

  let node: AudioNode = osc;
  if (spec.filter) {
    const f = c.createBiquadFilter();
    f.type = spec.filter.type;
    f.frequency.setValueAtTime(spec.filter.freq, t0);
    if (spec.filter.freqTo !== undefined) f.frequency.linearRampToValueAtTime(spec.filter.freqTo, t0 + spec.duration);
    if (spec.filter.q !== undefined) f.Q.value = spec.filter.q;
    node.connect(f);
    node = f;
  }
  node.connect(gain);
  gain.connect(out);

  voices += 1;
  osc.onended = () => {
    voices -= 1;
    gain.disconnect();
  };
  osc.start(t0);
  osc.stop(t0 + spec.duration + 0.02);
}

type NoiseSpec = {
  gain: number;
  duration: number;
  delay?: number;
  filter?: { type: BiquadFilterType; freq: number; freqTo?: number; q?: number };
};

function noiseBurst(spec: NoiseSpec): void {
  const c = ctx;
  const out = master;
  if (c === null || out === null || noise === null || voices >= MAX_VOICES) return;

  const t0 = c.currentTime + (spec.delay ?? 0);

  const src = c.createBufferSource();
  src.buffer = noise;
  // Start at a random offset so repeated grains are not the same waveform —
  // identical noise bursts in a row read as a synthesiser, not as radiation.
  const offset = Math.random() * 0.8;

  const gain = c.createGain();
  gain.gain.setValueAtTime(spec.gain, t0);
  gain.gain.exponentialRampToValueAtTime(SILENCE, t0 + spec.duration);

  let node: AudioNode = src;
  if (spec.filter) {
    const f = c.createBiquadFilter();
    f.type = spec.filter.type;
    f.frequency.setValueAtTime(spec.filter.freq, t0);
    if (spec.filter.freqTo !== undefined) f.frequency.linearRampToValueAtTime(spec.filter.freqTo, t0 + spec.duration);
    if (spec.filter.q !== undefined) f.Q.value = spec.filter.q;
    node.connect(f);
    node = f;
  }
  node.connect(gain);
  gain.connect(out);

  voices += 1;
  src.onended = () => {
    voices -= 1;
    gain.disconnect();
  };
  src.start(t0, offset, spec.duration + 0.02);
  src.stop(t0 + spec.duration + 0.02);
}

// ── The geiger scheduler ───────────────────────────────────────────────────

/**
 * Rogue Mode replays roughly one attack every 120ms for two to four minutes. A
 * sound per event is not a scoreboard, it is a fire alarm — and the interesting
 * quantity is the RATE, not the individual attempt.
 *
 * So `geiger` never synthesises directly. It raises a flag; a drain running on
 * a fixed interval plays at most one tick per 70ms and COLLAPSES the backlog
 * rather than working through it. A burst therefore sounds like a burst and a
 * lull sounds like a lull, which is the information the sound exists to carry.
 */
const GEIGER_MIN_GAP_MS = 70;
let geigerPending = false;
let geigerTimer: ReturnType<typeof setInterval> | null = null;
let geigerIdleDrains = 0;

function geigerDrain(): void {
  if (geigerPending) {
    geigerPending = false;
    geigerIdleDrains = 0;
    // A grain of filtered noise plus a very short blip. The bandpass centre
    // jitters so no two ticks are identical.
    noiseBurst({
      gain: 0.075,
      duration: 0.012,
      filter: { type: 'bandpass', freq: 2500 + (Math.random() * 360 - 180), q: 8 },
    });
    tone({ type: 'square', freq: 1750 + Math.random() * 120, gain: 0.028, duration: 0.012, attack: 0.001 });
    return;
  }
  // Stop the interval once the stream has clearly ended, so nothing is left
  // ticking over between runs.
  geigerIdleDrains += 1;
  if (geigerIdleDrains > 40 && geigerTimer !== null) {
    clearInterval(geigerTimer);
    geigerTimer = null;
  }
}

function geiger(): void {
  geigerPending = true;
  if (geigerTimer === null) {
    geigerIdleDrains = 0;
    geigerDrain();
    geigerTimer = setInterval(geigerDrain, GEIGER_MIN_GAP_MS);
  }
}

// ── De-duplication ─────────────────────────────────────────────────────────

/**
 * A single REVOKE press produces both a `revocation` and a `ceremony.aborted`
 * event, and the console and playground may both be open. One gesture, one snap.
 */
const lastPlayed: Partial<Record<SoundEvent, number>> = {};
function throttled(event: SoundEvent, ms: number): boolean {
  const now = Date.now();
  const prev = lastPlayed[event] ?? 0;
  if (now - prev < ms) return true;
  lastPlayed[event] = now;
  return false;
}

// ── The voices ─────────────────────────────────────────────────────────────

function render(event: SoundEvent, opts?: { round?: number }): void {
  switch (event) {
    /**
     * Money moved, and the policy allowed it. A resolved major interval — the
     * only unambiguously pleasant sound in the product, because it is the only
     * event that means the normal case worked.
     */
    case 'settle':
      tone({ type: 'triangle', freq: 880, gain: 0.13, duration: 0.55, attack: 0.006 });
      tone({ type: 'triangle', freq: 1318.5, gain: 0.075, duration: 0.6, attack: 0.008, detune: 4, delay: 0.05 });
      return;

    /** Held: a falling whole tone that never resolves. Waiting, not failure. */
    case 'held':
      tone({ type: 'sine', freq: 440, freqTo: 392, gain: 0.1, duration: 0.5, attack: 0.012 });
      return;

    /** Refused: low, short, over. No shriek — the policy working is not an emergency. */
    case 'refused':
      tone({ type: 'sine', freq: 120, freqTo: 55, gain: 0.22, duration: 0.26, attack: 0.004 });
      noiseBurst({ gain: 0.09, duration: 0.07, filter: { type: 'lowpass', freq: 420 } });
      return;

    case 'geiger':
      geiger();
      return;

    /**
     * An attack got through. A falling minor second — the only deliberately
     * unpleasant sound here, and it should never be heard.
     */
    case 'alarm':
      if (throttled('alarm', 400)) return;
      tone({ type: 'sawtooth', freq: 660, gain: 0.14, duration: 0.12, filter: { type: 'lowpass', freq: 2800 } });
      tone({ type: 'sawtooth', freq: 622.25, gain: 0.14, duration: 0.16, delay: 0.13, filter: { type: 'lowpass', freq: 2800 } });
      return;

    /**
     * A signing round completed. Rising whole tones straight off the round
     * number, so the ceremony audibly climbs and the interruption has something
     * to interrupt.
     */
    case 'ceremonyRound': {
      const round = Math.max(1, opts?.round ?? 1);
      tone({
        type: 'triangle',
        freq: 523.25 * Math.pow(2, ((round - 1) * 2) / 12),
        gain: 0.085,
        duration: 0.22,
        attack: 0.004,
      });
      return;
    }

    /**
     * The break. Three voices at once: the crack, the drop, and the click of the
     * ends parting. This is the sound of the highest-value moment in the demo and
     * it is allowed to be the loudest thing in the product.
     */
    case 'snap':
      if (throttled('snap', 600)) return;
      noiseBurst({ gain: 0.3, duration: 0.09, filter: { type: 'highpass', freq: 1200 } });
      tone({ type: 'sine', freq: 300, freqTo: 80, gain: 0.24, duration: 0.22, attack: 0.002 });
      noiseBurst({ gain: 0.18, duration: 0.006 });
      return;

    /** The approval service stopping. A power-down, because that is what it is. */
    case 'kill':
      tone({
        type: 'sawtooth',
        freq: 220,
        freqTo: 40,
        gain: 0.12,
        duration: 0.7,
        attack: 0.01,
        filter: { type: 'lowpass', freq: 2000, freqTo: 200 },
      });
      return;

    case 'revive':
      tone({ type: 'sine', freq: 80, freqTo: 220, gain: 0.08, duration: 0.4, attack: 0.02 });
      return;

    /** The lease in its last fifth. Quiet, and at most one per second. */
    case 'leaseTick':
      if (throttled('leaseTick', 900)) return;
      tone({ type: 'square', freq: 880, gain: 0.035, duration: 0.012, attack: 0.001, filter: { type: 'lowpass', freq: 3000 } });
      return;

    /** A mode or stage chosen. Barely there — it is only confirming a click. */
    case 'select':
      if (throttled('select', 60)) return;
      tone({ type: 'sine', freq: 1200, gain: 0.03, duration: 0.04, attack: 0.002 });
      return;

    default:
      return;
  }
}

// ── Unlock ─────────────────────────────────────────────────────────────────

let unlockInstalled = false;

/**
 * Create and resume the context on the first real gesture anywhere on the page.
 *
 * Idempotent on purpose: React 19 runs effects twice in development, and this is
 * registered from an effect. Installing twice would leave a listener behind.
 */
function installUnlock(): void {
  if (unlockInstalled || typeof window === 'undefined') return;
  unlockInstalled = true;

  const unlock = () => {
    const c = ensureContext();
    if (c === null) return;
    if (c.state === 'suspended') void c.resume();
    if (c.state === 'running') {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    }
  };

  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
}

// ── Public surface ─────────────────────────────────────────────────────────

export const sound = {
  /**
   * Play, if sound is on and the context is live.
   *
   * A sound requested before the first gesture is DROPPED, never queued. A
   * backlog of chimes firing all at once on the judge's first click would be
   * considerably worse than the silence it was trying to avoid.
   */
  play(event: SoundEvent, opts?: { round?: number }): void {
    hydrate();
    if (!enabled) return;
    if (!live()) return;
    try {
      render(event, opts);
    } catch {
      // Audio is never load-bearing. A failure here must not touch the demo.
    }
  },

  isEnabled(): boolean {
    hydrate();
    return enabled;
  },

  set(next: boolean): void {
    hydrate();
    enabled = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
    } catch {
      /* preference simply will not persist */
    }
    if (next) {
      const c = ensureContext();
      if (c !== null && c.state === 'suspended') void c.resume();
      // Confirm the unmute audibly — otherwise the only feedback is an icon, and
      // the judge cannot tell "on" from "on but broken".
      setTimeout(() => sound.play('select'), 40);
    }
    notify();
  },

  toggle(): void {
    sound.set(!sound.isEnabled());
  },
};

// ── React binding ──────────────────────────────────────────────────────────

function subscribe(listener: () => void): () => void {
  installUnlock();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): boolean {
  hydrate();
  return enabled;
}

/**
 * The server never knows the visitor's stored preference, so it renders the
 * default and React re-renders with the real value straight after hydration.
 * This is the sanctioned way to read client-only state without a mismatch — the
 * alternative, reading localStorage during render, is a hydration error.
 */
function getServerSnapshot(): boolean {
  return true;
}

/** Only the toggle button needs this. Everything else imports `sound` directly. */
export function useSound(): { enabled: boolean; toggle: () => void } {
  const isEnabled = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { enabled: isEnabled, toggle: sound.toggle };
}
