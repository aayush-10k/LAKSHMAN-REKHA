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
import type { MandateState, DecisionTrace, CategoryCode } from '../types.js';
import type { PaymentRequestStruct } from '../signing/constants.js';
import { hasCoreKey, corePrivateKey } from '../keys.js';
import { leaseDigest } from '../lease/index.js';

// ──────────────────────────────────────────────
// Mandate
// ──────────────────────────────────────────────

const mandates = new Map<string, MandateState>();
const pairingCodes = new Map<string, string>(); // code → mandateId

/**
 * The policy as PolicyModule 0x933b… actually holds it on Base Sepolia, read on
 * 2026-08-02 (apps/core/scripts/chain-state.mjs prints it).
 *
 * The demo mandate is seeded from these rather than from invented numbers
 * because settlement now really broadcasts: if the mandate says ₹25,000 per
 * transaction and the contract says ₹10,000, the core hands out an APPROVED
 * trace for a payment the chain then reverts, and the decision panel is a lie.
 * The chain is the authority, so these are its values.
 *
 * KNOWN GAP, deliberately not papered over: `permittedCategories` is 128 —
 * bit 7 only, i.e. OTHER and nothing else. That is the untouched fallback in
 * contracts/script/Deploy.s.sol (`vm.envOr("PERMITTED_CATEGORIES", 1 << 7)`),
 * so the deployment was made without that variable set. Mirroring it means the
 * vendor demo's PACKAGING/LOGISTICS/... purchases now REFUSE on predicate 7
 * off-chain instead of reverting on-chain after the ceremony. Widening it is an
 * owner `setPolicy` call against the live deployment — a policy decision for the
 * team, not this fix. See FIXLOG.md and apps/core/scripts/set-policy.mjs.
 */
export const DEPLOYED_POLICY = {
  perTxCapMinor: 1_000_000,        // ₹10,000
  windowCapMinor: 10_000_000,      // ₹1,00,000
  windowSeconds: 86_400,
  cumulativeCapMinor: 100_000_000, // ₹10,00,000
  permittedCategories: ['OTHER'] as CategoryCode[],
  tier2MinAgeDays: 30,
  tier2MinSettledTxns: 5,
  tier2MaxPriceBandZ: 2,
  tier2CapMinor: 500_000,          // ₹5,000
  deadmanSeconds: 604_800,
  policyHash: '0x7994236ca1cbe9890f5c118fd307afc36d0ea865d558c8112c030e702b3a7078',
  revocationEpoch: 0,
} as const;

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
  | 'SIGNING_FAILED';

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
