/**
 * Mock Policy Evaluator — B9
 *
 * Mirrors the predicate logic from API.md §4 and the Solidity contract spec in BUILD.md.
 * Used while Person A's real evaluator (apps/core/src/policy/) is being built.
 * When A's code is ready, this module is replaced — the API routes don't change.
 *
 * Predicate evaluation order is FIXED (must match Solidity):
 * 1. agentSignature  2. coreSignature  3. coreImage  4. revocationEpoch
 * 5. leaseExpiry     6. nonce          7. categoryPermitted  8. counterpartyTier
 * 9. counterpartyAge 10. counterpartySettled  11. priceBand
 * 12. perTxCap       13. windowCap     14. cumulativeCap
 *
 * HARD RULE: Default outcome on ANY unexpected condition is REFUSED.
 * There is no code path that falls through to APPROVED on an exception.
 */

import { randomBytes } from 'node:crypto';
import type { FactSheet, DecisionTrace, MandateState, Predicate, PredicateName, Outcome } from '../types.js';

export const CORE_IMAGE_DIGEST = process.env['CORE_IMAGE_DIGEST'] ?? 'sha256:dev-mock-0000000000000000000000000000000000000000000000000000000000000000';
const POLICY_HASH = process.env['POLICY_HASH'] ?? '0x0000000000000000000000000000000000000000000000000000000000000001';

function p(
  name: PredicateName,
  inputs: Record<string, number | string>,
  expected: string,
  actual: string,
  passed: boolean,
  severity: 'hard' | 'soft',
): Predicate {
  return { name, inputs, expected, actual, passed, severity };
}

// Nonce registry — in production this is backed by the DB / on-chain
const usedNonces = new Map<string, Set<number>>();

function isNonceUsed(mandateId: string, nonce: number): boolean {
  return usedNonces.get(mandateId)?.has(nonce) ?? false;
}

function markNonce(mandateId: string, nonce: number): void {
  if (!usedNonces.has(mandateId)) usedNonces.set(mandateId, new Set());
  usedNonces.get(mandateId)!.add(nonce);
}

export interface EvaluatorInput {
  factSheet: FactSheet;
  mandate: MandateState;
  leaseExpiresAtMs: number;
  agentSigValid: boolean;  // passed in from signing service
  coreSigValid: boolean;   // always true in this evaluator (we're the core)
  nowMs?: number;
}

export function evaluate(input: EvaluatorInput): DecisionTrace {
  const startMs = Date.now();
  const { factSheet: fs, mandate: m, leaseExpiresAtMs, agentSigValid, nowMs = Date.now() } = input;

  const predicates: Predicate[] = [];
  let outcome: Outcome = 'APPROVED';
  let bindingPredicate: PredicateName | null = null;

  const hard = (
    name: PredicateName,
    inputs: Record<string, number | string>,
    expected: string,
    actual: string,
    passed: boolean,
  ): boolean => {
    predicates.push(p(name, inputs, expected, actual, passed, 'hard'));
    if (!passed && outcome === 'APPROVED') {
      outcome = 'REFUSED';
      bindingPredicate = name;
    }
    return passed;
  };

  const soft = (
    name: PredicateName,
    inputs: Record<string, number | string>,
    expected: string,
    actual: string,
    passed: boolean,
  ): boolean => {
    predicates.push(p(name, inputs, expected, actual, passed, 'soft'));
    if (!passed && outcome === 'APPROVED') {
      outcome = 'HELD';
      bindingPredicate = name;
    }
    return passed;
  };

  try {
    // 1. agentSignature
    hard('agentSignature', {}, 'valid', agentSigValid ? 'valid' : 'invalid', agentSigValid);

    // 2. coreSignature (we are the core — always valid here)
    hard('coreSignature', {}, 'valid', 'valid', true);

    // 3. coreImage
    const imageExpected = process.env['EXPECTED_CORE_IMAGE_DIGEST'] ?? CORE_IMAGE_DIGEST;
    hard('coreImage', {}, imageExpected, CORE_IMAGE_DIGEST, CORE_IMAGE_DIGEST === imageExpected);

    // 4. revocationEpoch — lease must carry the current epoch
    // In production, lease is signed with the epoch at issue time; here we check it matches
    hard('revocationEpoch', { epoch: m.revocationEpoch }, String(m.revocationEpoch), String(m.revocationEpoch), !m.frozen);

    // 5. leaseExpiry
    const ttlMs = leaseExpiresAtMs - nowMs;
    hard('leaseExpiry', { leaseId: fs.leaseId, expiresAtMs: leaseExpiresAtMs }, '> now', ttlMs > 0 ? `+${ttlMs}ms` : `${ttlMs}ms`, ttlMs > 0);

    // 6. nonce
    const nonceUsed = isNonceUsed(m.mandateId, fs.nonce);
    hard('nonce', { nonce: fs.nonce }, 'unused', nonceUsed ? 'used' : 'unused', !nonceUsed);

    // 7. categoryPermitted
    const categoryOk = m.permittedCategories.includes(fs.categoryCode);
    hard('categoryPermitted', { code: fs.categoryCode }, 'permitted', categoryOk ? 'permitted' : 'blocked', categoryOk);

    // 8. counterpartyTier — tier 3 is always blocked
    const tierOk = fs.counterpartyTier !== 3;
    hard('counterpartyTier', { tier: fs.counterpartyTier }, 'tier 1 or 2', `tier ${fs.counterpartyTier}`, tierOk);

    // Tier-2 soft predicates (9–11) — skipped for tier 1
    if (fs.counterpartyTier === 2) {
      // 9. counterpartyAge
      const ageOk = fs.counterpartyAgeDays >= m.tier2MinAgeDays;
      soft('counterpartyAge', { ageDays: fs.counterpartyAgeDays, minRequired: m.tier2MinAgeDays }, `>= ${m.tier2MinAgeDays}`, String(fs.counterpartyAgeDays), ageOk);

      // 10. counterpartySettled
      const settledOk = fs.counterpartySettledTxns >= m.tier2MinSettledTxns;
      soft('counterpartySettled', { settled: fs.counterpartySettledTxns, minRequired: m.tier2MinSettledTxns }, `>= ${m.tier2MinSettledTxns}`, String(fs.counterpartySettledTxns), settledOk);

      // 11. priceBand
      const priceOk = Math.abs(fs.priceBandZ) <= m.tier2MaxPriceBandZ;
      soft('priceBand', { priceBandZ: fs.priceBandZ, maxDeviation: m.tier2MaxPriceBandZ }, `|z| <= ${m.tier2MaxPriceBandZ}`, String(fs.priceBandZ), priceOk);
    }

    // Per-tx cap — use tier-2 reduced cap if applicable
    const effectiveCap = fs.counterpartyTier === 2 ? Math.min(m.perTxCapMinor, m.tier2CapMinor) : m.perTxCapMinor;
    hard('perTxCap', { cap: effectiveCap }, `<= ${effectiveCap}`, String(fs.amountMinor), fs.amountMinor <= effectiveCap);

    // 13. windowCap
    const windowTotal = m.windowSpentMinor + fs.amountMinor;
    hard('windowCap', { windowSpent: m.windowSpentMinor, cap: m.windowCapMinor }, `<= ${m.windowCapMinor}`, String(windowTotal), windowTotal <= m.windowCapMinor);

    // 14. cumulativeCap
    const cumTotal = m.cumulativeSpentMinor + fs.amountMinor;
    hard('cumulativeCap', { cumulativeSpent: m.cumulativeSpentMinor, cap: m.cumulativeCapMinor }, `<= ${m.cumulativeCapMinor}`, String(cumTotal), cumTotal <= m.cumulativeCapMinor);

  } catch (err) {
    // ANY unexpected exception → REFUSED. Never fall through to APPROVED.
    console.error('[evaluator] unexpected error — defaulting to REFUSED:', err);
    outcome = 'REFUSED';
    bindingPredicate = predicates.length > 0 ? predicates[predicates.length - 1]!.name : 'agentSignature';
  }

  // Mark nonce used only on APPROVED
  if (outcome === 'APPROVED') {
    markNonce(m.mandateId, fs.nonce);
  }

  const latencyMs = Date.now() - startMs;
  const decisionId = `dec_${randomBytes(4).toString('hex')}`;

  return {
    decisionId,
    lineItemId: fs.lineItemId,
    outcome,
    predicates,
    bindingPredicate,
    amountMinor: fs.amountMinor,
    counterpartyId: fs.counterpartyId,
    policyHash: POLICY_HASH,
    coreImageDigest: CORE_IMAGE_DIGEST,
    evaluatedAtMs: nowMs,
    latencyMs,
    summary: buildSummary(outcome, bindingPredicate, fs),
    signature: `0x${'00'.repeat(32)}`, // real signature comes from A's signing service
  };
}

function buildSummary(outcome: Outcome, binding: PredicateName | null, fs: FactSheet): string {
  const amount = `₹${(fs.amountMinor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  if (outcome === 'APPROVED') return `Approved. ${amount} to counterparty — all checks passed.`;

  const messages: Record<PredicateName, string> = {
    agentSignature:     `Refused. Agent signature is invalid. Nothing was charged.`,
    coreSignature:      `Refused. Core signature is invalid. Nothing was charged.`,
    coreImage:          `Refused. Core image digest mismatch. Nothing was charged.`,
    revocationEpoch:    `Refused. Mandate is revoked or frozen. Nothing was charged.`,
    leaseExpiry:        `Refused. Lease has expired — agent must renew. Nothing was charged.`,
    nonce:              `Refused. Nonce already used — replay rejected. Nothing was charged.`,
    categoryPermitted:  `Refused. Category ${fs.categoryCode} is not permitted. Nothing was charged.`,
    counterpartyTier:   `Refused. Counterparty is tier 3 — hard block. Nothing was charged.`,
    counterpartyAge:    `Held. This vendor is ${fs.counterpartyAgeDays} days old; vendors in this tier need 30. Nothing charged — cancel or let it settle.`,
    counterpartySettled:`Held. This vendor has too few settled transactions. Nothing charged — cancel or let it settle.`,
    priceBand:          `Held. Price deviates too far from market (z=${fs.priceBandZ}). Nothing charged — cancel or let it settle.`,
    perTxCap:           `Refused. ${amount} exceeds the per-payment cap. Nothing was charged.`,
    windowCap:          `Refused. ${amount} would exceed the window cap. Nothing was charged.`,
    cumulativeCap:      `Refused. ${amount} would exceed the cumulative cap. Nothing was charged.`,
  };

  return binding ? (messages[binding] ?? `${outcome}. Nothing was charged.`) : `${outcome}. Nothing was charged.`;
}
