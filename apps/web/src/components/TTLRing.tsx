'use client';

/**
 * The lease TTL ring.
 *
 * One of the three things BUILD.md Part 11's motion budget originally allowed to
 * move (this, the Rekha, and the ceremony bar). That budget has since been
 * widened — see theatre.css — but the principle it was protecting has not: every
 * animation in the product is a load reveal, a state change, or one of the three
 * moments. This ring is the second kind. It drains continuously and refills on
 * renewal, which is what gives the UI a pulse without anything decorative
 * happening.
 *
 * It is also the fail-closed guarantee made visible: no new lease means no new
 * payment, so killing the core empties this ring and spending stops when it hits
 * zero. That is the whole point of the "Kill approval service" demo beat, and it
 * only lands if the ring is obviously counting down rather than spinning.
 *
 * ── On the colours ────────────────────────────────────────────────────────
 * Primary while alive, status-error when critical. NOT green when healthy,
 * which is what the two inline copies of this ring used to do: status-success
 * means "money moved" and nothing else may borrow it, or the one colour that
 * should make a judge look up stops meaning anything. Red at the end is honest —
 * a lease at zero is spending stopped, which is exactly what red means here.
 *
 * Replaces the duplicated inline rings in console/page.tsx and playground/page.tsx.
 */

type Props = {
  /** Remaining lease time in ms. */
  ttlMs: number;
  /** Configured TTL, read from the core — never assume 5000. The denominator. */
  maxMs: number;
  /** Outer pixel size. 36 in the topbar, 80 in the playground panel. */
  size?: number;
  /** Render the seconds figure in the middle. */
  showLabel?: boolean;
  className?: string;
};

/** Below this fraction the ring turns --breach. */
const CRITICAL = 0.2;

export function TTLRing({ ttlMs, maxMs, size = 36, showLabel = false, className }: Props) {
  const safeMax = maxMs > 0 ? maxMs : 1;
  const fraction = Math.max(0, Math.min(1, ttlMs / safeMax));

  const stroke = size >= 64 ? 6 : 3;
  const radius = size / 2 - stroke;
  const circumference = 2 * Math.PI * radius;
  const critical = fraction <= CRITICAL;

  return (
    <div
      // The pulse is deliberately only in the last fifth: a ring that always
      // pulses is a nervous tic nobody reads, one that STARTS pulsing is the
      // fail-closed guarantee becoming visible — which is the entire point of
      // the kill-switch beat.
      className={`relative grid shrink-0 place-items-center ${critical ? 'animate-ambient-pulse' : ''} ${className ?? ''}`}
      style={{ width: size, height: size }}
      title={`Lease TTL: ${ttlMs}ms of ${maxMs}ms`}
      role="img"
      aria-label={`Lease expires in ${(ttlMs / 1000).toFixed(1)} seconds`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-muted)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={critical ? 'var(--color-status-error)' : 'var(--color-primary)'}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset 240ms linear, stroke 240ms linear' }}
        />
      </svg>
      {showLabel && (
        <div className="absolute inset-0 grid place-items-center leading-none">
          <span
            className={`tnum font-mono font-semibold ${critical ? 'text-status-error' : 'text-on-surface'}`}
            style={{ fontSize: Math.round(size * 0.26) }}
          >
            {(ttlMs / 1000).toFixed(1)}
          </span>
          <span
            className="font-mono uppercase tracking-widest text-on-surface-variant"
            style={{ fontSize: Math.round(size * 0.12), marginTop: Math.round(size * 0.3) }}
          >
            sec
          </span>
        </div>
      )}
    </div>
  );
}
