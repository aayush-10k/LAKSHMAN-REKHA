'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A number that counts up to its new value instead of jumping.
 *
 * Deliberately has no bounce, no overshoot and no scale change. The Rogue Mode
 * scoreboard is the one place on screen where numbers move on their own, and a
 * counter that springs reads as a game score rather than a tally of blocked
 * attacks. Ease-out to the value and stop.
 *
 * Respects prefers-reduced-motion by snapping straight to the value.
 */

type Props = {
  value: number;
  /** ms. Kept short — this runs while a judge is watching attacks land. */
  durationMs?: number;
  className?: string;
};

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Counter({ value, durationMs = 400, className }: Props) {
  // Held as a float, rounded only for display.
  //
  // Rogue Mode replays an attack every 120ms against this 400ms ease, so each
  // animation is cancelled about a quarter of the way through. Rounding the
  // running total meant every burst advanced it by ~0.23 and rounded straight
  // back down: the scoreboard sat at 0 through all 99 attacks while the log
  // beside it filled. Keeping the fraction lets the display make progress and
  // catch up once the stream stops.
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  const frameRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    // Resume from what is on screen, not from the last target. An interrupted
    // animation has already moved the display, and starting again from the
    // previous target discards that.
    const from = shownRef.current;
    if (from === value) return;

    // Snap, don't animate, when the frame clock is not running.
    //
    // requestAnimationFrame does not fire in a background tab, and this effect
    // only re-runs when `value` changes — so a scoreboard that updates while the
    // tab is hidden freezes at whatever it last displayed and never catches up
    // once the run is over. Measured on a hidden tab: 0 rAF callbacks in one
    // second, 99 attacks replayed, every counter still reading 0.
    if (prefersReducedMotion() || document.hidden) {
      shownRef.current = value;
      setShown(value);
      return;
    }

    const start = performance.now();
    const delta = value - from;

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // easeOutCubic: fast arrival, no overshoot. Nothing springs.
      const eased = 1 - Math.pow(1 - t, 3);
      const next = t < 1 ? from + delta * eased : value;
      shownRef.current = next;
      setShown(next);
      if (t < 1) frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
  }, [value, durationMs]);

  return <span className={`counter ${className ?? ''}`}>{Math.round(shown).toLocaleString('en-IN')}</span>;
}
