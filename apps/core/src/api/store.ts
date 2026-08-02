/**
 * In-memory store — used when DATABASE_URL is not set.
 * Stores mandates, decisions, leases, settlements, revocations, holds.
 * Everything needed for the audit export and API routes.
 *
 * Production: swap with Prisma + Postgres. The interface is the same.
 */

import { randomBytes } from 'node:crypto';
import type { MandateState, DecisionTrace, CategoryCode } from '../types.js';

// ──────────────────────────────────────────────
// Mandate
// ──────────────────────────────────────────────

const mandates = new Map<string, MandateState>();
const pairingCodes = new Map<string, string>(); // code → mandateId

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
    revocationEpoch: 0,
    policyHash: '0x' + '0'.repeat(64),
    perTxCapMinor: 2_500_000,    // ₹25,000
    windowCapMinor: 5_000_000,   // ₹50,000
    windowSeconds: 3600,
    cumulativeCapMinor: 50_000_000, // ₹5,00,000
    windowStartMs: now,
    windowSpentMinor: 0,
    cumulativeSpentMinor: 0,
    permittedCategories: ['PACKAGING', 'ADVERTISING', 'CONTENT', 'COMPUTE', 'LOGISTICS', 'SOFTWARE', 'UTILITIES', 'OTHER'] as CategoryCode[],
    tier2MinAgeDays: 30,
    tier2MinSettledTxns: 10,
    tier2MaxPriceBandZ: 20,
    tier2CapMinor: 1_000_000,    // ₹10,000 for tier-2
    lastHeartbeatMs: now,
    deadmanSeconds: 3600,
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
  signature: string;
}

const leases = new Map<string, LeaseRecord>();

export function issueLease(agentId: string): LeaseRecord | null {
  const agent = agents.get(agentId);
  if (!agent) return null;
  const mandate = mandates.get(agent.mandateId);
  if (!mandate || mandate.frozen) return null;

  const leaseId = `lse_${randomBytes(4).toString('hex')}`;
  const record: LeaseRecord = {
    leaseId,
    agentId,
    mandateId: agent.mandateId,
    expiresAtMs: Date.now() + (Number(process.env['LEASE_TTL_MS']) || 5_000),
    revocationEpoch: mandate.revocationEpoch,
    policyHash: mandate.policyHash,
    signature: `0x${'00'.repeat(32)}`, // real sig from A's signing service
  };
  leases.set(leaseId, record);
  return record;
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

export function settleDecision(decisionId: string): { txHash: string; blockNumber: number; balanceAfterMinor: number } {
  const trace = decisions.get(decisionId);
  if (!trace || trace.outcome !== 'APPROVED') throw new Error('DECISION_NOT_APPROVED');

  const txHash = `0x${randomBytes(32).toString('hex')}`;
  const blockNumber = Math.floor(Math.random() * 1_000_000) + 15_000_000;
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
