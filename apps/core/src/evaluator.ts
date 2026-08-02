import {
  CATEGORY_INDEX,
  SOFT_FAIL_AGE,
  SOFT_FAIL_PRICE,
  SOFT_FAIL_SETTLED,
  type DecisionTrace,
  type PolicyFactSheet,
  type PolicyState,
  type Outcome,
  type Predicate,
  type PredicateName,
  type SignaturesValid,
} from './types.js';
import { summarize } from './explain.js';

const ZERO_HASH = '0x' + '0'.repeat(64);

/**
 * The deterministic off-chain mirror of PolicyModule.validate.
 *
 * Pure: no I/O, no clock, no network, no LLM. Time enters only as `nowMs`.
 * Fail-closed: any thrown exception or unreachable state resolves to REFUSED —
 * an exception can never produce an approval (see the try/catch wrapper and the
 * `refused-on-throw` unit test).
 *
 * Predicate order is copied from PolicyModule.validate exactly; do not reorder.
 */
export function evaluate(
  factSheet: PolicyFactSheet,
  mandate: PolicyState,
  signaturesValid: SignaturesValid,
  nowMs: number,
): DecisionTrace {
  try {
    return evaluateInner(factSheet, mandate, signaturesValid, nowMs);
  } catch {
    // Any unexpected state fails closed. We do NOT surface the error text (no
    // "error" in the trace by design) — just a REFUSED decision with no
    // predicates, which the account treats as "move no money".
    const trace = baseTrace(factSheet, mandate, nowMs);
    trace.outcome = 'REFUSED';
    trace.bindingPredicate = null;
    trace.summary = summarize(trace);
    return trace;
  }
}

function evaluateInner(
  factSheet: PolicyFactSheet,
  mandate: PolicyState,
  signaturesValid: SignaturesValid,
  nowMs: number,
): DecisionTrace {
  const trace = baseTrace(factSheet, mandate, nowMs);
  const nowS = Math.floor(nowMs / 1000);

  // Operational guard: a frozen or heartbeat-lapsed account approves nothing.
  // PolicyModule.validate reverts AccountFrozen here, ahead of the 14 predicates,
  // so no predicate is recorded. Mirror that: empty predicate list, REFUSED.
  if (mandate.frozen || deadmanLapsed(mandate, nowS)) {
    trace.outcome = 'REFUSED';
    trace.bindingPredicate = null;
    trace.summary = summarize(trace);
    return trace;
  }

  const preds = trace.predicates;
  const registryTier = mandate.counterpartyRegistry.get(factSheet.counterpartyId) ?? 0;

  // Helper: record a hard predicate; on failure finalize as REFUSED and stop.
  // Returns true if evaluation should stop (a hard predicate failed).
  const finalizedRefuse = { done: false };
  const hard = (
    name: PredicateName,
    passed: boolean,
    inputs: Record<string, number | string>,
    expected: string,
    actual: string,
  ): boolean => {
    preds.push({ name, inputs, expected, actual, passed, severity: 'hard' });
    if (!passed) {
      trace.outcome = 'REFUSED';
      trace.bindingPredicate = name;
      finalizedRefuse.done = true;
    }
    return !passed;
  };

  // --- 1 agentSignature (hard) ---
  if (hard('agentSignature', signaturesValid.agent === true, {}, 'valid', signaturesValid.agent ? 'valid' : 'invalid'))
    return finalize(trace);

  // --- 2 coreSignature (hard) ---
  if (hard('coreSignature', signaturesValid.core === true, {}, 'valid', signaturesValid.core ? 'valid' : 'invalid'))
    return finalize(trace);

  // --- 3 coreImage (hard) --- request's claimed image must equal the approved
  // one. Approved == zero hash never matches a real digest -> fails closed.
  {
    const approved = mandate.coreImageDigest.toLowerCase();
    const claimed = factSheet.coreImageDigest.toLowerCase();
    if (
      hard(
        'coreImage',
        approved !== ZERO_HASH && claimed === approved,
        { claimed, approved },
        approved,
        claimed,
      )
    )
      return finalize(trace);
  }

  // --- 4 revocationEpoch (hard) ---
  if (
    hard(
      'revocationEpoch',
      mandate.requestRevocationEpoch === mandate.revocationEpoch,
      { request: mandate.requestRevocationEpoch, current: mandate.revocationEpoch },
      String(mandate.revocationEpoch),
      String(mandate.requestRevocationEpoch),
    )
  )
    return finalize(trace);

  // --- 5 leaseExpiry (hard) --- now > expiry => expired.
  if (
    hard(
      'leaseExpiry',
      nowS <= mandate.leaseExpiryS,
      { nowS, leaseExpiryS: mandate.leaseExpiryS },
      `now <= ${mandate.leaseExpiryS}`,
      String(nowS),
    )
  )
    return finalize(trace);

  // --- 6 nonce (hard) ---
  if (
    hard(
      'nonce',
      !mandate.usedNonces.has(factSheet.nonce),
      { nonce: factSheet.nonce },
      'unused',
      mandate.usedNonces.has(factSheet.nonce) ? 'used' : 'unused',
    )
  )
    return finalize(trace);

  // --- 7 categoryPermitted (hard) ---
  {
    const idx = CATEGORY_INDEX[factSheet.categoryCode];
    const permitted = ((mandate.permittedCategories >> BigInt(idx)) & 1n) === 1n;
    if (
      hard(
        'categoryPermitted',
        permitted,
        { categoryCode: factSheet.categoryCode, index: idx },
        'permitted',
        permitted ? 'permitted' : 'blocked',
      )
    )
      return finalize(trace);
  }

  // --- 8 counterpartyTier (hard) --- registry is authoritative. tier must be 1
  // or 2 (3 and unknown-0 are blocked), and the declared tier must match it.
  {
    const tierOk = registryTier === 1 || registryTier === 2;
    const declaredMatches = factSheet.counterpartyTier === registryTier;
    if (
      hard(
        'counterpartyTier',
        tierOk && declaredMatches,
        { registryTier, declaredTier: factSheet.counterpartyTier },
        'registry tier 1 or 2, matching declared',
        `registry=${registryTier}, declared=${factSheet.counterpartyTier}`,
      )
    )
      return finalize(trace);
  }

  // --- 9-11 soft predicates: tier 2 only. Tier 1 skips them entirely. ---
  let softBitmask = 0;
  let firstSoftFail: PredicateName | null = null;
  const soft = (
    name: PredicateName,
    passed: boolean,
    bit: number,
    inputs: Record<string, number | string>,
    expected: string,
    actual: string,
  ) => {
    preds.push({ name, inputs, expected, actual, passed, severity: 'soft' });
    if (!passed) {
      softBitmask |= bit;
      if (firstSoftFail === null) firstSoftFail = name;
    }
  };

  if (registryTier === 2) {
    // 9 counterpartyAge
    soft(
      'counterpartyAge',
      factSheet.counterpartyAgeDays >= mandate.tier2MinAgeDays,
      SOFT_FAIL_AGE,
      { ageDays: factSheet.counterpartyAgeDays, minAgeDays: mandate.tier2MinAgeDays },
      `age >= ${mandate.tier2MinAgeDays}`,
      String(factSheet.counterpartyAgeDays),
    );
    // 10 counterpartySettled
    soft(
      'counterpartySettled',
      factSheet.counterpartySettledTxns >= mandate.tier2MinSettledTxns,
      SOFT_FAIL_SETTLED,
      { settledTxns: factSheet.counterpartySettledTxns, minSettledTxns: mandate.tier2MinSettledTxns },
      `settled >= ${mandate.tier2MinSettledTxns}`,
      String(factSheet.counterpartySettledTxns),
    );
    // 11 priceBand: |z| within band
    const absZ = Math.abs(factSheet.priceBandZ);
    soft(
      'priceBand',
      absZ <= mandate.tier2MaxPriceBandZ,
      SOFT_FAIL_PRICE,
      { priceBandZ: factSheet.priceBandZ, maxAbsZ: mandate.tier2MaxPriceBandZ },
      `|z| <= ${mandate.tier2MaxPriceBandZ}`,
      `|${factSheet.priceBandZ}| = ${absZ}`,
    );
  }
  trace.softFailBitmask = softBitmask;

  // --- 12 perTxCap (hard) --- global cap, plus a tighter tier-2 ceiling. ---
  {
    const overGlobal = factSheet.amountMinor > mandate.perTxCapMinor;
    const overTier2 = registryTier === 2 && factSheet.amountMinor > mandate.tier2CapMinor;
    const inputs: Record<string, number | string> = {
      amountMinor: factSheet.amountMinor,
      perTxCapMinor: mandate.perTxCapMinor,
    };
    if (registryTier === 2) inputs.tier2CapMinor = mandate.tier2CapMinor;
    if (
      hard(
        'perTxCap',
        !overGlobal && !overTier2,
        inputs,
        registryTier === 2
          ? `amount <= min(${mandate.perTxCapMinor}, ${mandate.tier2CapMinor})`
          : `amount <= ${mandate.perTxCapMinor}`,
        String(factSheet.amountMinor),
      )
    )
      return finalize(trace);
  }

  // --- 13 windowCap (hard) --- uses the effective (possibly rolled) window spend.
  {
    const eff = effectiveWindowSpent(mandate, nowS);
    if (
      hard(
        'windowCap',
        eff + factSheet.amountMinor <= mandate.windowCapMinor,
        { amountMinor: factSheet.amountMinor, effectiveWindowSpent: eff, windowCapMinor: mandate.windowCapMinor },
        `spent + amount <= ${mandate.windowCapMinor}`,
        String(eff + factSheet.amountMinor),
      )
    )
      return finalize(trace);
  }

  // --- 14 cumulativeCap (hard) ---
  if (
    hard(
      'cumulativeCap',
      mandate.cumulativeSpentMinor + factSheet.amountMinor <= mandate.cumulativeCapMinor,
      {
        amountMinor: factSheet.amountMinor,
        cumulativeSpentMinor: mandate.cumulativeSpentMinor,
        cumulativeCapMinor: mandate.cumulativeCapMinor,
      },
      `spent + amount <= ${mandate.cumulativeCapMinor}`,
      String(mandate.cumulativeSpentMinor + factSheet.amountMinor),
    )
  )
    return finalize(trace);

  // All hard predicates passed. Soft failure(s) => HELD, else APPROVED.
  if (softBitmask !== 0) {
    trace.outcome = 'HELD';
    trace.bindingPredicate = firstSoftFail;
  } else {
    trace.outcome = 'APPROVED';
    trace.bindingPredicate = null;
  }
  return finalize(trace);
}

/** Fill the summary at the very end so it sees the finished trace. */
function finalize(trace: DecisionTrace): DecisionTrace {
  trace.summary = summarize(trace);
  return trace;
}

function deadmanLapsed(mandate: PolicyState, nowS: number): boolean {
  if (mandate.deadmanSeconds === 0) return false; // disabled
  return nowS > mandate.lastHeartbeat + mandate.deadmanSeconds;
}

function effectiveWindowSpent(mandate: PolicyState, nowS: number): number {
  if (mandate.windowStart === 0 || nowS >= mandate.windowStart + mandate.windowSeconds) return 0;
  return mandate.windowSpentMinor;
}

/** A trace pre-populated with everything known before predicates run. Outcome
 *  defaults to REFUSED so any early return / unhandled path fails closed. */
function baseTrace(factSheet: PolicyFactSheet, mandate: PolicyState, nowMs: number): DecisionTrace {
  const outcome: Outcome = 'REFUSED';
  const predicates: Predicate[] = [];
  return {
    decisionId: decisionId(factSheet, mandate),
    lineItemId: factSheet.lineItemId,
    outcome,
    predicates,
    bindingPredicate: null,
    softFailBitmask: 0,
    amountMinor: factSheet.amountMinor,
    counterpartyId: factSheet.counterpartyId,
    policyHash: mandate.policyHash,
    coreImageDigest: factSheet.coreImageDigest,
    evaluatedAtMs: nowMs,
    latencyMs: 0, // measured by a caller; the pure evaluator has no clock
    summary: '',
    signature: '',
  };
}

/**
 * A stable, deterministic id for this decision. NOTE: this is intentionally NOT
 * the on-chain digest (keccak256(abi.encode(chainId, policyAddr, req))) — that
 * needs values the injection-safe PolicyFactSheet does not carry. It is a pure FNV-1a
 * hash of the request-identifying fields, used only to key/trace decisions.
 */
function decisionId(factSheet: PolicyFactSheet, mandate: PolicyState): string {
  const canonical = [
    factSheet.lineItemId,
    factSheet.taskId,
    factSheet.leaseId,
    factSheet.counterpartyId,
    factSheet.amountMinor,
    factSheet.nonce,
    mandate.requestRevocationEpoch,
    mandate.leaseExpiryS,
    factSheet.coreImageDigest,
  ].join('|');
  return `dec_${fnv1a32(canonical)}`;
}

function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in integer range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
