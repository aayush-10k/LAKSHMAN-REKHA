'use client';

/**
 * Browser-side pairing against the core.
 *
 * The core mints a new pairing code on every boot and keeps pairing state in
 * memory, so any code the frontend remembers is wrong after a restart. Only the
 * agentId is safe to cache, and it still has to be re-checked — that is what
 * GET /v1/agent/:agentId is for. A 404 there means the core restarted, and the
 * response is to pair again rather than show a connected-looking UI that cannot
 * spend.
 */

export const CORE_URL = process.env['NEXT_PUBLIC_CORE_URL'] ?? 'http://localhost:4000';

const AGENT_ID_KEY = 'rekha.agentId';

export type Pairing = {
  agentId: string;
  mandateId: string;
  /** Lease TTL the core is configured with, in ms. Never assume 5000. */
  leaseTtlMs: number;
  /** true when this call had to mint a new pairing (first load, or core restart). */
  fresh: boolean;
};

function readCached(): string | null {
  try {
    return window.localStorage.getItem(AGENT_ID_KEY);
  } catch {
    return null; // private mode / storage disabled — pair fresh every load
  }
}

function writeCached(agentId: string): void {
  try {
    window.localStorage.setItem(AGENT_ID_KEY, agentId);
  } catch {
    /* non-fatal: we just re-pair next load */
  }
}

function clearCached(): void {
  try {
    window.localStorage.removeItem(AGENT_ID_KEY);
  } catch {
    /* ignore */
  }
}

/** Redeems the core's CURRENT code. Never sends a remembered or literal code. */
async function pairFresh(): Promise<Pairing> {
  const codeRes = await fetch(`${CORE_URL}/v1/agent/pairing-code`);
  if (!codeRes.ok) throw new Error(`core did not offer a pairing code (HTTP ${codeRes.status})`);
  const { pairingCode } = (await codeRes.json()) as { pairingCode: string };

  const pairRes = await fetch(`${CORE_URL}/v1/agent/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairingCode }),
  });
  if (!pairRes.ok) {
    const body = await pairRes.json().catch(() => null);
    throw new Error(body?.error?.message ?? `pairing failed (HTTP ${pairRes.status})`);
  }

  const paired = (await pairRes.json()) as { agentId: string; mandateId: string; leaseTtlMs?: number };
  writeCached(paired.agentId);
  return {
    agentId: paired.agentId,
    mandateId: paired.mandateId,
    leaseTtlMs: paired.leaseTtlMs ?? 5000,
    fresh: true,
  };
}

/**
 * The paired agent for this browser, pairing or re-pairing as needed.
 *
 * Throws when the core is unreachable or refuses — the caller shows that, rather
 * than pretending to be connected.
 */
export async function ensurePaired(): Promise<Pairing> {
  const cached = readCached();
  if (cached !== null) {
    const res = await fetch(`${CORE_URL}/v1/agent/${cached}`);
    if (res.ok) {
      const known = (await res.json()) as { agentId: string; mandateId: string; leaseTtlMs?: number };
      return { ...known, leaseTtlMs: known.leaseTtlMs ?? 5000, fresh: false };
    }
    // Unknown to this core (restart), so the cached id can never lease again.
    clearCached();
  }
  return pairFresh();
}

/**
 * Renews the lease, re-pairing once if the core has forgotten this agent.
 *
 * Returns the agentId actually used, which the caller must adopt: after a core
 * restart it is a new one.
 */
export async function renewLease(
  agentId: string,
): Promise<{ agentId: string; leaseId: string; expiresAtMs: number; ttlMs: number }> {
  const attempt = async (id: string) =>
    fetch(`${CORE_URL}/v1/lease/renew`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: id }),
    });

  let id = agentId;
  let res = await attempt(id);

  if (res.status === 404) {
    clearCached();
    id = (await pairFresh()).agentId;
    res = await attempt(id);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    // The 503 body now names the underlying reason — surface it.
    throw new Error(body?.error?.message ?? `lease renew failed (HTTP ${res.status})`);
  }

  const lease = (await res.json()) as { leaseId: string; expiresAtMs: number; ttlMs?: number };
  return { agentId: id, leaseId: lease.leaseId, expiresAtMs: lease.expiresAtMs, ttlMs: lease.ttlMs ?? 5000 };
}
