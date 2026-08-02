/**
 * In-memory store — used when DATABASE_URL is not set.
 * Stores mandates, decisions, leases, settlements, revocations, holds.
 * Everything needed for the audit export and API routes.
 *
 * Production: swap with Prisma + Postgres. The interface is the same.
 */

import { randomBytes } from 'node:crypto';
import { sign } from 'viem/accounts';
import type { Hex } from 'viem';
import { CATEGORY_CODES, type MandateState, type DecisionTrace, type CategoryCode } from '../types.js';
import type { PaymentRequestStruct } from '../signing/constants.js';
import { hasCoreKey, corePrivateKey } from '../keys.js';
import { leaseDigest } from '../lease/index.js';

// ──────────────────────────────────────────────
// Mandate
// ──────────────────────────────────────────────

const mandates = new Map<string, MandateState>();
const pairingCodes = new Map<string, string>(); // code → mandateId

/**
 * Fallback policy, used only when PolicyModule cannot be read at boot.
 *
 * The chain is the authority — seedPolicyFromChain() below replaces every one of
 * these with the live value, because a mandate that disagrees with PolicyModule
 * produces APPROVED traces for payments the chain then reverts, and the decision
 * panel becomes a lie.
 *
 * These numbers are the values read from 0x933b… on 2026-08-02
 * (apps/core/scripts/chain-state.mjs prints them), so an RPC outage degrades to
 * "slightly stale" rather than to "invented". They will drift; the seed is what
 * keeps the running core correct.
 */
export const DEPLOYED_POLICY = {
  perTxCapMinor: 2_500_000,        // ₹25,000
  windowCapMinor: 10_000_000,      // ₹1,00,000
  windowSeconds: 86_400,
  cumulativeCapMinor: 100_000_000, // ₹10,00,000
  // permittedCategories 223 = 0b11011111: everything except SOFTWARE (bit 5).
  permittedCategories: ['PACKAGING', 'ADVERTISING', 'CONTENT', 'COMPUTE', 'LOGISTICS', 'UTILITIES', 'OTHER'] as CategoryCode[],
  tier2MinAgeDays: 30,
  tier2MinSettledTxns: 5,
  tier2MaxPriceBandZ: 2,
  tier2CapMinor: 500_000,          // ₹5,000
  deadmanSeconds: 604_800,
  policyHash: '0x8960a494209993e857a6573ef8ee53e56371acd8e67309a06bccf0fed65204c6',
  revocationEpoch: 0,
} as const;

/** Bitmap -> category list, the inverse of policy-state.ts categoryBitmap(). */
function categoriesFromBitmap(bits: bigint): CategoryCode[] {
  return CATEGORY_CODES.filter((_, i) => ((bits >> BigInt(i)) & 1n) === 1n) as CategoryCode[];
}

/**
 * Overwrites every mandate with the live PolicyModule state.
 *
 * Called at boot and after each settlement. The counters matter as much as the
 * caps: settling advances windowSpentMinor and cumulativeSpentMinor on chain, so
 * an off-chain copy that stays at zero makes predicates 13 and 14 LOOSER than
 * the contract's — the one direction that yields an approval the chain refuses.
 *
 * Returns false and changes nothing if the read failed. Refusing a partial
 * update is the point: mixing live caps with stale counters would be undetectable.
 */
export function seedPolicy(snapshot: {
  perTxCapMinor: number;
  windowCapMinor: number;
  windowSeconds: number;
  cumulativeCapMinor: number;
  permittedCategories: bigint;
  tier2MinAgeDays: number;
  tier2MinSettledTxns: number;
  tier2MaxPriceBandZ: number;
  tier2CapMinor: number;
  windowStartS: number;
  windowSpentMinor: number;
  cumulativeSpentMinor: number;
  revocationEpoch: number;
  policyHash: string;
  deadmanSeconds: number;
  frozen: boolean;
} | null): boolean {
  if (snapshot === null) return false;
  for (const [id, mandate] of mandates.entries()) {
    mandates.set(id, {
      ...mandate,
      perTxCapMinor: snapshot.perTxCapMinor,
      windowCapMinor: snapshot.windowCapMinor,
      windowSeconds: snapshot.windowSeconds,
      cumulativeCapMinor: snapshot.cumulativeCapMinor,
      permittedCategories: categoriesFromBitmap(snapshot.permittedCategories),
      tier2MinAgeDays: snapshot.tier2MinAgeDays,
      tier2MinSettledTxns: snapshot.tier2MinSettledTxns,
      tier2MaxPriceBandZ: snapshot.tier2MaxPriceBandZ,
      tier2CapMinor: snapshot.tier2CapMinor,
      // windowStart 0 on chain means "no window open"; keep it 0 so
      // effectiveWindowSpent() rolls, rather than inventing a start time.
      windowStartMs: snapshot.windowStartS === 0 ? 0 : snapshot.windowStartS * 1000,
      windowSpentMinor: snapshot.windowSpentMinor,
      cumulativeSpentMinor: snapshot.cumulativeSpentMinor,
      revocationEpoch: snapshot.revocationEpoch,
      policyHash: snapshot.policyHash,
      deadmanSeconds: snapshot.deadmanSeconds,
      // A chain freeze can only ADD. An off-chain revoke (POST /v1/revoke, or
      // the dead-man switch) must never be cleared by a later chain read that
      // happens to say frozen: false — this runs after every settlement, so a
      // plain assignment would quietly un-revoke a revoked mandate.
      frozen: mandate.frozen || snapshot.frozen,
    });
  }
  return true;
}

export function createMandate(ownerAddress = '0x' + '0'.repeat(40)): { mandateId: string; pairingCode: string } {
  const mandateId = `mnd_${randomBytes(4).toString('hex')}`;
  const pairingCode = randomBytes(3).toString('hex').toUpperCase(); // 6 chars
  const now = Date.now();

  const state: MandateState = {
    mandateId,
    ownerAddress,
    guardianAddress: null,
    agentSignerAddress: '0x' + '0'.repeat(40),
    coreSignerAddress: '0x' + '0'.repeat(40),
    revocationEpoch: DEPLOYED_POLICY.revocationEpoch,
    policyHash: DEPLOYED_POLICY.policyHash,
    perTxCapMinor: DEPLOYED_POLICY.perTxCapMinor,
    windowCapMinor: DEPLOYED_POLICY.windowCapMinor,
    windowSeconds: DEPLOYED_POLICY.windowSeconds,
    cumulativeCapMinor: DEPLOYED_POLICY.cumulativeCapMinor,
    windowStartMs: now,
    windowSpentMinor: 0,
    cumulativeSpentMinor: 0,
    permittedCategories: [...DEPLOYED_POLICY.permittedCategories],
    tier2MinAgeDays: DEPLOYED_POLICY.tier2MinAgeDays,
    tier2MinSettledTxns: DEPLOYED_POLICY.tier2MinSettledTxns,
    tier2MaxPriceBandZ: DEPLOYED_POLICY.tier2MaxPriceBandZ,
    tier2CapMinor: DEPLOYED_POLICY.tier2CapMinor,
    lastHeartbeatMs: now,
    deadmanSeconds: DEPLOYED_POLICY.deadmanSeconds,
    frozen: false,
  };

  mandates.set(mandateId, state);
  pairingCodes.set(pairingCode, mandateId);
  return { mandateId, pairingCode };
}

export function getMandateByCode(code: string): MandateState | undefined {
  const id = pairingCodes.get(code.toUpperCase());
  return id ? mandates.get(id) : undefined;
}

export function getMandate(mandateId: string): MandateState | undefined {
  return mandates.get(mandateId);
}

export function updateMandate(mandateId: string, patch: Partial<MandateState>): void {
  const m = mandates.get(mandateId);
  if (m) mandates.set(mandateId, { ...m, ...patch });
}

export function revokeMandate(mandateId: string): void {
  const m = mandates.get(mandateId);
  if (!m) return;
  mandates.set(mandateId, { ...m, revocationEpoch: m.revocationEpoch + 1, frozen: true });
}

export function heartbeat(mandateId: string): void {
  updateMandate(mandateId, { lastHeartbeatMs: Date.now() });
}

// ──────────────────────────────────────────────
// Agents
// ──────────────────────────────────────────────

interface AgentRecord {
  agentId: string;
  mandateId: string;
  shareA: string;
}

const agents = new Map<string, AgentRecord>();

export function registerAgent(mandateId: string): AgentRecord {
  const agentId = `agt_${randomBytes(4).toString('hex')}`;
  const shareA = `share_a_${randomBytes(16).toString('hex')}`;
  const record: AgentRecord = { agentId, mandateId, shareA };
  agents.set(agentId, record);
  return record;
}

export function getAgent(agentId: string): AgentRecord | undefined {
  return agents.get(agentId);
}

// ──────────────────────────────────────────────
// Leases
// ──────────────────────────────────────────────

export interface LeaseRecord {
  leaseId: string;
  agentId: string;
  mandateId: string;
  expiresAtMs: number;
  revocationEpoch: number;
  policyHash: string;
  /** 65-byte core-key ECDSA signature over leaseDigest(). Never a placeholder. */
  signature: Hex;
}

const leases = new Map<string, LeaseRecord>();

/**
 * Why a lease could not be issued. The route turns this into the 503/409 body so
 * the failure is never invisible again (FIX2.md BUG 1: a bare "Could not issue
 * lease" cost an afternoon of guessing that the core simply had no key).
 */
export type LeaseFailureCode =
  | 'AGENT_NOT_FOUND'
  | 'MANDATE_NOT_FOUND'
  | 'MANDATE_FROZEN'
  | 'NO_CORE_KEY'
  | 'SIGNING_FAILED'
  | 'CORE_KILLED';

// ──────────────────────────────────────────────
// Kill switch (FIX3.md BUG 4)
// ──────────────────────────────────────────────

/**
 * Whether this core is refusing to issue leases.
 *
 * The "Kill Approval Service" button used to POST a route that did not exist and
 * swallow the 404, then grey itself out and announce that the core was offline
 * while the core carried on issuing leases perfectly happily. It demonstrated
 * nothing except that the UI would say whatever it was told to.
 *
 * The real beat is worth having, and it is this: no new lease means no new
 * payment, so spending stops within LEASE_TTL_MS of the kill with no other
 * moving parts. Killing issuance here — rather than at the route — puts the stop
 * on the same code path every caller uses, so nothing can route around it.
 *
 * In-memory and process-local, like the rest of this store. A restart clears it.
 */
let issuanceKilledAtMs: number | null = null;

export function killIssuance(): { killedAtMs: number; leaseTtlMs: number } {
  issuanceKilledAtMs ??= Date.now();
  return { killedAtMs: issuanceKilledAtMs, leaseTtlMs: leaseTtlMs() };
}

/**
 * Resumes issuance. A demo affordance, not a product feature: a judge who kills
 * the core mid-demo should be able to carry on without restarting four
 * processes. It cannot resurrect leases that already expired, so the stop it
 * undoes has already been demonstrated.
 */
export function reviveIssuance(): void {
  issuanceKilledAtMs = null;
}

export function issuanceKilledAt(): number | null {
  return issuanceKilledAtMs;
}

export type IssueLeaseResult =
  | { ok: true; lease: LeaseRecord }
  | { ok: false; code: LeaseFailureCode; reason: string };

/** The current lease TTL, so clients can size their own timers off the truth. */
export function leaseTtlMs(): number {
  return Number(process.env['LEASE_TTL_MS']) || 5_000;
}

/**
 * Issues a lease carrying a real core signature.
 *
 * It used to ship `0x00…00` with a "real sig from A's signing service" note.
 * That is no longer viable: settlement runs through coreSign(), whose first act
 * is validateLease(), which recovers this signature and compares it to the core
 * signer. A placeholder recovers to some unrelated address, so every payment
 * would fail lease validation and nothing could ever settle.
 *
 * Async because signing is. Every failure path returns `ok: false` with the
 * reason — never an unsigned lease. A missing key still fails closed; it just
 * says so now.
 */
export async function issueLease(agentId: string): Promise<IssueLeaseResult> {
  // Checked first: a killed core refuses everyone, for reasons that have nothing
  // to do with the agent or the mandate.
  if (issuanceKilledAtMs !== null) {
    return {
      ok: false,
      code: 'CORE_KILLED',
      reason: `Approval service was killed at ${new Date(issuanceKilledAtMs).toISOString()}; no leases are being issued.`,
    };
  }

  const agent = agents.get(agentId);
  if (!agent) {
    return { ok: false, code: 'AGENT_NOT_FOUND', reason: `No agent ${agentId} is registered with this core.` };
  }
  const mandate = mandates.get(agent.mandateId);
  if (!mandate) {
    return { ok: false, code: 'MANDATE_NOT_FOUND', reason: `Mandate ${agent.mandateId} is not in this core's store.` };
  }
  if (mandate.frozen) {
    return { ok: false, code: 'MANDATE_FROZEN', reason: `Mandate ${agent.mandateId} is frozen; no leases will be issued.` };
  }
  // Checked rather than caught: corePrivateKey() throws when unconfigured, and a
  // lease with no signature is not a lease.
  if (!hasCoreKey()) {
    return {
      ok: false,
      code: 'NO_CORE_KEY',
      reason: 'No core signing key is configured (set CORE_SIGNER_PRIVATE_KEY, e.g. in .env).',
    };
  }

  const unsigned = {
    leaseId: `lse_${randomBytes(4).toString('hex')}`,
    agentId,
    mandateId: agent.mandateId,
    expiresAtMs: Date.now() + leaseTtlMs(),
    revocationEpoch: mandate.revocationEpoch,
    policyHash: mandate.policyHash,
  };

  let signature: Hex;
  try {
    // Raw digest signing, matching src/lease/index.ts. NEVER signMessage.
    signature = await sign({
      hash: leaseDigest(unsigned),
      privateKey: corePrivateKey(),
      to: 'hex',
    });
  } catch (e) {
    // The exception this swallowed is exactly what BUG 1 needed to see. Log it
    // and hand the message up; still no lease, so it is as fail-closed as before.
    const reason = e instanceof Error ? e.message : String(e);
    console.error('[lease] signing failed:', reason);
    return { ok: false, code: 'SIGNING_FAILED', reason };
  }

  const record: LeaseRecord = { ...unsigned, signature };
  leases.set(record.leaseId, record);
  return { ok: true, lease: record };
}

export function getLease(leaseId: string): LeaseRecord | undefined {
  return leases.get(leaseId);
}

// ──────────────────────────────────────────────
// Decisions / Holds / Settlements
// ──────────────────────────────────────────────

const decisions = new Map<string, DecisionTrace>();
const holds = new Map<string, { expiresAtMs: number; released: boolean; amountMinor: number; mandateId: string }>();
const settlements = new Map<string, { txHash: string; blockNumber: number; atMs: number }>();
const revocationLog: Array<{ epoch: number; source: string; atMs: number }> = [];
let walletBalanceMinor = 5_000_000; // ₹50,000 demo balance

export function storeDecision(trace: DecisionTrace, mandateId?: string): void {
  decisions.set(trace.decisionId, trace);
  if (trace.outcome === 'HELD') {
    holds.set(trace.decisionId, { expiresAtMs: Date.now() + 90_000, released: false, amountMinor: trace.amountMinor, mandateId: mandateId ?? '' });
  }
}

export function getDecision(decisionId: string): DecisionTrace | undefined {
  return decisions.get(decisionId);
}

const decisionToMandate = new Map<string, string>(); // decisionId → mandateId

export function linkDecisionToMandate(decisionId: string, mandateId: string): void {
  decisionToMandate.set(decisionId, mandateId);
}

// ──────────────────────────────────────────────
// Settlement context
// ──────────────────────────────────────────────

/**
 * The exact request the core signed, held between /request and /settle.
 *
 * Settlement must broadcast *this* struct and not rebuild one: the core
 * signature commits to keccak256(abi.encode(chainId, policy, req)), so a
 * request reassembled at settle time from a lease that has since ticked over
 * produces a different digest and reverts with InvalidCoreSignature. Storing it
 * also means there is exactly one construction path, which is the point of
 * FIX.md TASK 2.
 */
export type SettlementContext = {
  request: PaymentRequestStruct;
  coreSig: Hex;
};

const settlementContexts = new Map<string, SettlementContext>();

export function putSettlementContext(decisionId: string, ctx: SettlementContext): void {
  settlementContexts.set(decisionId, ctx);
}

export function getSettlementContext(decisionId: string): SettlementContext | undefined {
  return settlementContexts.get(decisionId);
}

/**
 * Records a settlement that has ALREADY happened on chain.
 *
 * `txHash` and `blockNumber` are parameters, not products. This function used to
 * mint them with randomBytes(32) and Math.random(), which made every "verifiable
 * on Base Sepolia" claim in the product false — the hashes resolved to nothing.
 * The only caller is POST /v1/payment/settle, which passes values it took off a
 * mined receipt, so a hash can no longer exist for a payment that did not happen.
 *
 * Balance and window accounting are unchanged; this is bookkeeping after the
 * fact, and it must not be reached unless the transaction succeeded.
 */
export function settleDecision(
  decisionId: string,
  txHash: string,
  blockNumber: number,
): { txHash: string; blockNumber: number; balanceAfterMinor: number } {
  const trace = decisions.get(decisionId);
  if (!trace || trace.outcome !== 'APPROVED') throw new Error('DECISION_NOT_APPROVED');

  walletBalanceMinor -= trace.amountMinor;
  if (walletBalanceMinor < 0) walletBalanceMinor = 0;

  settlements.set(decisionId, { txHash, blockNumber, atMs: Date.now() });

  // Update window spending on mandate (using the linked mandateId)
  const mandateId = decisionToMandate.get(decisionId);
  if (mandateId) {
    const mandate = mandates.get(mandateId);
    if (mandate) {
      updateMandate(mandateId, {
        windowSpentMinor: mandate.windowSpentMinor + trace.amountMinor,
        cumulativeSpentMinor: mandate.cumulativeSpentMinor + trace.amountMinor,
      });
    }
  }

  return { txHash, blockNumber, balanceAfterMinor: walletBalanceMinor };
}

export function releaseHold(decisionId: string): { released: true; amountMinor: number } {
  const hold = holds.get(decisionId);
  if (!hold || hold.released) throw new Error('HOLD_NOT_FOUND');
  hold.released = true;
  return { released: true, amountMinor: hold.amountMinor };
}

export function getActiveHolds(): Array<{ decisionId: string; expiresAtMs: number; amountMinor: number }> {
  const active: Array<{ decisionId: string; expiresAtMs: number; amountMinor: number }> = [];
  for (const [decisionId, hold] of holds.entries()) {
    if (!hold.released && hold.expiresAtMs > Date.now()) {
      active.push({ decisionId, expiresAtMs: hold.expiresAtMs, amountMinor: hold.amountMinor });
    }
  }
  return active;
}

export function logRevocation(epoch: number, source: string): void {
  revocationLog.push({ epoch, source, atMs: Date.now() });
}

// ──────────────────────────────────────────────
// Audit export
// ──────────────────────────────────────────────

export function buildAuditExport(mandateId: string) {
  return {
    version: '1.0.0' as const,
    mandateId,
    exportedAtMs: Date.now(),
    decisions: [...decisions.values()],
    settlements: [...settlements.entries()].map(([decisionId, s]) => ({
      decisionId,
      txHash: s.txHash,
      blockNumber: s.blockNumber,
    })),
    revocations: revocationLog.map(r => ({ epoch: r.epoch, source: r.source, atMs: r.atMs })),
    signature: `0x${'00'.repeat(32)}`, // real sig from A's signing service
  };
}

export function getBalance(): number {
  return walletBalanceMinor;
}

// ──────────────────────────────────────────────
// Dead-man switch
// ──────────────────────────────────────────────

export function checkDeadman(onFreeze: (mandateId: string, epoch: number) => void): void {
  const now = Date.now();
  for (const [id, mandate] of mandates.entries()) {
    if (mandate.frozen) continue;
    const elapsed = now - mandate.lastHeartbeatMs;
    if (elapsed > mandate.deadmanSeconds * 1000) {
      mandates.set(id, { ...mandate, frozen: true, revocationEpoch: mandate.revocationEpoch + 1 });
      onFreeze(id, mandate.revocationEpoch + 1);
    }
  }
}
