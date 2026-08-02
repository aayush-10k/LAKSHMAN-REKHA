import type { Hex } from 'viem';
import { sign } from 'viem/accounts';
import { evaluate } from '../evaluator.js';
import { agentPrivateKey, corePrivateKey } from '../keys.js';
import { LeaseInvalidError, validateLease, type Lease } from '../lease/index.js';
import type { DecisionTrace, PolicyFactSheet, PolicyState } from '../types.js';
import type { PaymentRequestStruct } from './constants.js';
import { buildPaymentRequest, hashRequest, DEPLOYED_TARGET, type PolicyTarget } from './request.js';

/**
 * The result of asking the core to sign.
 *
 * `partialSig` is null for every outcome that is not APPROVED. It is the whole
 * point of this type: a HELD or REFUSED decision still returns its trace, so the
 * caller can explain itself, but there is no signature to attach and therefore
 * no way for money to move.
 *
 * `request` and `digest` are carried alongside the two fields CLAUDE.md names,
 * because a signature with no request to attach it to cannot be submitted. They
 * are null exactly when `partialSig` is null.
 */
export type CoreSignResult = {
  trace: DecisionTrace;
  partialSig: Hex | null;
  request: PaymentRequestStruct | null;
  digest: Hex | null;
};

/**
 * The core's half of the 2-of-2.
 *
 *   1. validate the lease — invalid means throw, never a signature;
 *   2. run the frozen evaluator — anything but APPROVED returns the trace with
 *      partialSig: null;
 *   3. APPROVED — build the request, hash it, sign the raw digest.
 *
 * There is no catch block in this function. An unexpected failure propagates as
 * an exception, which is the fail-closed outcome: no signature is produced. The
 * evaluator has its own internal catch, and that one resolves to REFUSED, which
 * lands on the partialSig-null path here.
 *
 * `target` defaults to the pinned Base Sepolia deployment and exists so a test
 * can sign for a PolicyModule at a different address; production passes nothing.
 */
export async function coreSign(
  factSheet: PolicyFactSheet,
  mandateState: PolicyState,
  lease: Lease,
  nowMs: number,
  target: PolicyTarget = DEPLOYED_TARGET,
): Promise<CoreSignResult> {
  // --- 1. Lease ----------------------------------------------------------
  if (!(await validateLease(lease, mandateState, nowMs))) {
    throw new LeaseInvalidError('lease is not valid for this mandate at this time; refusing to sign');
  }

  // The lease and the facts have to describe the same request, or the evaluator
  // would be judging one thing while the chain checks another. Each of these is
  // a desync that fails closed rather than being silently reconciled.
  if (factSheet.leaseId !== lease.leaseId) {
    throw new LeaseInvalidError(`factSheet.leaseId ${factSheet.leaseId} does not match lease ${lease.leaseId}`);
  }
  const leaseExpiryS = Math.floor(lease.expiresAtMs / 1000);
  if (mandateState.leaseExpiryS !== leaseExpiryS) {
    throw new LeaseInvalidError(
      `mandateState.leaseExpiryS ${mandateState.leaseExpiryS} does not match the lease's ${leaseExpiryS}`,
    );
  }
  if (mandateState.requestRevocationEpoch !== lease.revocationEpoch) {
    throw new LeaseInvalidError(
      `mandateState.requestRevocationEpoch ${mandateState.requestRevocationEpoch} does not match the lease's ${lease.revocationEpoch}`,
    );
  }

  // --- 2. Evaluate -------------------------------------------------------
  // Predicates 1 and 2 are signature validity, which cannot be re-derived
  // off-chain (see types.ts SignaturesValid). Asserting both here is safe in the
  // only direction that matters: PolicyModule re-recovers both signatures itself,
  // so an assertion that turns out false produces a request the chain rejects.
  // It can never move money that the chain would not have moved anyway.
  const trace = evaluate(factSheet, mandateState, { agent: true, core: true }, nowMs);

  if (trace.outcome !== 'APPROVED') {
    return { trace, partialSig: null, request: null, digest: null };
  }

  // --- 3. Sign -----------------------------------------------------------
  // The evaluator just proved factSheet.coreImageDigest equals the mandate's
  // approved image (predicate 3), so this is the image the decision was made
  // under — the chain must check that same value, not some other one.
  const request = buildPaymentRequest(factSheet, mandateState, lease, factSheet.coreImageDigest as Hex);
  const digest = hashRequest(request, target);

  // Raw digest signing. NEVER signMessage.
  const partialSig = await sign({ hash: digest, privateKey: corePrivateKey(), to: 'hex' });

  return { trace, partialSig, request, digest };
}

/**
 * The agent's half of the 2-of-2.
 *
 * TEST ONLY. In the real system this share lives with the agent, in a different
 * process holding a key the core has never seen; the whole security argument is
 * that one party cannot produce both signatures. It exists here so the on-chain
 * tests can assemble a complete pair.
 */
export async function agentSign(
  request: PaymentRequestStruct,
  target: PolicyTarget = DEPLOYED_TARGET,
): Promise<Hex> {
  return sign({ hash: hashRequest(request, target), privateKey: agentPrivateKey(), to: 'hex' });
}
