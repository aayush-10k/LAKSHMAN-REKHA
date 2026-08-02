'use client';

import React from 'react';
import type { Pairing } from '../lib/pairing';

/**
 * FIX2.md BUG 3 — the pairing state, visible.
 *
 * Before this there was nothing on screen that said whether the console was
 * paired, so BUG 2 (never paired at all) looked identical to a working demo.
 * Three states, and "not paired" has to be as legible as "paired" or the
 * element is decoration:
 *
 *   Agent connected · agt_3ff3a68e · lease 4.8s
 *   Pairing…
 *   Not paired — <the core's own reason>
 *
 * Deliberately a chip in the existing topbar language. Nothing is redesigned.
 */
export function AgentStatus({
  pairing,
  error,
  leaseTtlMs,
}: {
  pairing: Pairing | null;
  error: string | null;
  /** Live TTL from the lease.tick stream, in ms. */
  leaseTtlMs: number;
}) {
  if (error !== null) {
    return (
      <span className="agent-chip agent-chip-err" title={error}>
        <span className="agent-chip-dot" />
        Not paired — {error}
      </span>
    );
  }

  if (pairing === null) {
    return (
      <span className="agent-chip agent-chip-wait">
        <span className="agent-chip-dot" />
        Pairing…
      </span>
    );
  }

  return (
    <span className="agent-chip agent-chip-ok" title={`mandate ${pairing.mandateId}`}>
      <span className="agent-chip-dot" />
      Agent connected
      <code className="agent-chip-id">{pairing.agentId}</code>
      <span className="agent-chip-sep">·</span>
      lease {(Math.max(0, leaseTtlMs) / 1000).toFixed(1)}s
    </span>
  );
}
