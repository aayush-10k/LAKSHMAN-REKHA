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
  const [shown, setShown] = useState(value);
  const fromRef = useRef(value);
  const frameRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const from = fromRef.current;
    if (from === value) return;

    if (prefersReducedMotion()) {
      fromRef.current = value;
      setShown(value);
      return;
    }

    const start = performance.now();
    const delta = value - from;

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // easeOutCubic: fast arrival, no overshoot. Nothing springs.
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(Math.round(from + delta * eased));
      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = value;
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
      fromRef.current = value;
    };
  }, [value, durationMs]);

  return <span className={`counter ${className ?? ''}`}>{shown.toLocaleString('en-IN')}</span>;
}
