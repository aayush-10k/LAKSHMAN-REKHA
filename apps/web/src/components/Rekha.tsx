'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The Rekha — the line.
 *
 * A single 1px chalk boundary drawn around the agent's activity zone. It is the
 * containment claim made literal: the agent works inside the line, and the line
 * is what the enforcement layer does. It is the one animated idea in the product
 * and it carries the product's name, so it is deliberately quiet — present at
 * 40% opacity and doing nothing at all most of the time.
 *
 * ── What it reacts to, and what it pointedly does not ─────────────────────
 *   attack blocked     -> flare: a --breach pulse runs a short way along the
 *                         path and settles back to chalk over 600ms
 *   ceremony aborted   -> snap:  the line breaks at the top edge, the ends
 *                         recoil, it holds broken for 2s, then heals
 *   payment settled    -> NOTHING. The line does not celebrate. A boundary that
 *                         congratulates you every time money moves is decoration;
 *                         one that only reacts to being tested is a claim.
 *
 * ── Why this measures the container instead of using a normalised viewBox ──
 * The obvious implementation — viewBox="0 0 100 100" with
 * preserveAspectRatio="none" and vector-effect="non-scaling-stroke" — renders
 * BROKEN. Stretching a square viewBox to a wide panel is a large non-uniform
 * scale, and stroke-dasharray is not resolved in the same space as the
 * non-scaling stroke, so the closed rectangle came out as three disconnected
 * fragments. Verified in Chrome on the kitchen-sink route before this rewrite.
 *
 * So the path is built in real pixels from a measured box: scale is 1:1, there
 * is no distortion, and dash maths behaves. `pathLength={1000}` still normalises
 * every dash figure in globals.css to thousandths of the perimeter, so the CSS
 * remains independent of the panel's size.
 *
 * The path starts at top-centre rather than at a corner, so a gap at the START
 * of the dash pattern is a break at the top edge — where the spec asks the snap
 * to appear, and where the eye already is during a ceremony.
 */

export type RekhaPulse = {
  kind: 'flare' | 'snap';
  /**
   * Changes on every event, including repeats of the same kind. Rendering with a
   * new id is what restarts the animation — CSS will not replay an animation
   * whose class never went away.
   */
  id: number;
};

type Props = {
  pulse: RekhaPulse | null;
  children: ReactNode;
  className?: string;
};

/** Keep in step with the animation durations in globals.css. */
const FLARE_MS = 600;
const SNAP_MS = 2600;

/** Inset so the 1px stroke is not clipped by the container's own edge. */
const INSET = 1;

/** Top-centre, clockwise, closing back to top-centre. */
function rekhaPath(w: number, h: number): string {
  const l = INSET;
  const t = INSET;
  const r = w - INSET;
  const b = h - INSET;
  const midX = w / 2;
  return `M ${midX} ${t} L ${r} ${t} L ${r} ${b} L ${l} ${b} L ${l} ${t} Z`;
}

export function Rekha({ pulse, children, className }: Props) {
  const [state, setState] = useState<'idle' | 'flare' | 'snap'>('idle');
  const [runId, setRunId] = useState(0);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const hostRef = useRef<HTMLDivElement>(null);

  // Measure, and keep measuring. The playground panel changes height as the
  // agent's reasoning stream fills, and a boundary drawn at the old size would
  // sit inside or outside the content it is supposed to contain.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const measure = () => setBox({ w: host.clientWidth, h: host.clientHeight });
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (pulse === null) return;

    setState(pulse.kind);
    setRunId(pulse.id);

    const timer = setTimeout(
      () => setState('idle'),
      pulse.kind === 'snap' ? SNAP_MS : FLARE_MS,
    );
    return () => clearTimeout(timer);
  }, [pulse?.id, pulse?.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const drawable = box.w > 2 * INSET && box.h > 2 * INSET;
  const d = drawable ? rekhaPath(box.w, box.h) : '';

  return (
    <div ref={hostRef} className={`rekha rekha-${state} ${className ?? ''}`}>
      {drawable && (
        <svg
          className="rekha-svg"
          width={box.w}
          height={box.h}
          viewBox={`0 0 ${box.w} ${box.h}`}
          aria-hidden="true"
          focusable="false"
        >
          {/* The line itself. Always present. */}
          <path
            key={`line-${state === 'snap' ? runId : 'idle'}`}
            className="rekha-line"
            d={d}
            pathLength={1000}
          />

          {/* The travelling pulse. Only exists while flaring, and is keyed on the
              event id so two blocked attacks in a row produce two visible pulses
              rather than one animation that never restarts. */}
          {state === 'flare' && (
            <path
              key={`flare-${runId}`}
              className="rekha-flare-path"
              d={d}
              pathLength={1000}
            />
          )}
        </svg>
      )}

      <div className="rekha-content">{children}</div>
    </div>
  );
}
