/**
 * B9 — POST /v1/payment/request  +  POST /v1/payment/settle
 *
 * /request: validates the FactSheet, runs the evaluator and produces the core's
 *           half of the 2-of-2. Emits decision events; simulates the FROST
 *           ceremony rounds for M3.
 * /settle:  broadcasts RekhaAccount.execute and returns the MINED transaction.
 *
 * FIX.md TASK 2 + TASK 3. Two things changed in here and both are load-bearing:
 *
 *  1. There is now exactly one place a PaymentRequest is built — coreSign() in
 *     src/signing/, via buildPaymentRequest(). The inline tuple and the local
 *     hashRequest ABI that used to live in this file are gone. A second
 *     construction path is a second chance to disagree with the Solidity struct,
 *     and a struct that disagrees by one field reverts with InvalidCoreSignature.
 *
 *  2. Settlement is real. No branch of this file can produce a transaction hash
 *     that did not come off a mined receipt. A missing key is 503, a contract
 *     refusal is 422 naming the custom error, and neither returns a hash.
 */

import type { FastifyInstance } from 'fastify';
import type { Hex } from 'viem';
import { validateFactSheet } from '../validate-factsheet.js';
import * as store from '../store.js';
import { emit } from '../../events/bus.js';
import { hasCoreKey } from '../../keys.js';
import { LeaseInvalidError, type Lease } from '../../lease/index.js';
import { coreSign } from '../../signing/sign.js';
import { toPolicyFactSheet, toPolicyState, type RegistryTier } from '../policy-state.js';
import {
  broadcastExecute,
  counterpartyTierOnChain,
  nonceUsedOnChain,
  settlementConfig,
  SettlementRevertedError,
} from '../chain.js';

/** 65-byte ECDSA signature, as the agent must supply it. */
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

/**
 * B's stored lease record -> A's Lease.
 *
 * Same five fields plus agentId; the record is now really signed by the core key
 * (see store.issueLease), so validateLease inside coreSign can recover it.
 */
function toLease(record: store.LeaseRecord): Lease {
  return {
    leaseId: record.leaseId,
    agentId: record.agentId,
    expiresAtMs: record.expiresAtMs,
    revocationEpoch: record.revocationEpoch,
    policyHash: record.policyHash,
    signature: record.signature,
  };
}

export async function registerPaymentRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /v1/payment/request ───────────────────────────────────────
  app.post<{ Body: { factSheet: unknown } }>('/v1/payment/request', async (request, reply) => {
    const validation = validateFactSheet(request.body?.factSheet);

    if (!validation.ok) {
      return reply.code(400).send({
        error: { code: 'FACTSHEET_INVALID', message: validation.reason },
      });
    }

    const { factSheet: fs } = validation;

    if (!hasCoreKey()) {
      return reply.code(503).send({
        error: { code: 'CORE_UNAVAILABLE', message: 'No core signing key configured.' },
      });
    }

    // Enforce Registry Rule: age and settled-count come from the vendor
    // registry, never from the caller. An unreachable registry means zeroes,
    // which the soft predicates treat as unproven.
    try {
      const catalogRes = await fetch('http://localhost:4100/catalog');
      if (catalogRes.ok) {
        const vendors = (await catalogRes.json()) as any[];
        const vendor = vendors.find((v: any) => v.address.toLowerCase() === fs.counterpartyId.toLowerCase());
        if (vendor) {
          fs.counterpartyAgeDays = vendor.ageDays;
          fs.counterpartySettledTxns = vendor.settledTxns;
        } else {
          fs.counterpartyAgeDays = 0;
          fs.counterpartySettledTxns = 0;
        }
      }
    } catch (e) {
      console.warn('Failed to contact vendor registry', e);
      fs.counterpartyAgeDays = 0;
      fs.counterpartySettledTxns = 0;
    }

    // Look up lease to get mandate context
    const lease = store.getLease(fs.leaseId);
    if (!lease) {
      return reply.code(403).send({ error: { code: 'LEASE_EXPIRED', message: 'Lease not found or expired.' } });
    }

    const mandate = store.getMandate(lease.mandateId);
    if (!mandate) {
      return reply.code(503).send({ error: { code: 'CORE_UNAVAILABLE', message: 'Mandate unavailable.' } });
    }

    if (mandate.frozen) {
      return reply.code(403).send({ error: { code: 'REVOKED', message: 'Mandate is revoked.' } });
    }

    if (lease.expiresAtMs < Date.now()) {
      return reply.code(403).send({ error: { code: 'LEASE_EXPIRED', message: 'Lease TTL has passed.' } });
    }

    // Emit: payment requested
    emit({ t: 'payment.requested', lineItemId: fs.lineItemId, factSheet: fs });

    // Predicates 6 and 8 are answered by PolicyModule storage, not by anything
    // in this process — read them so an APPROVED trace means the chain will
    // actually accept the payment. Both fail closed if the RPC is unreachable.
    const [onChainTier, nonceBurned] = await Promise.all([
      counterpartyTierOnChain(fs.counterpartyId),
      nonceUsedOnChain(fs.nonce),
    ]);
    const registry = new Map<string, RegistryTier>([
      [fs.counterpartyId.toLowerCase(), onChainTier as RegistryTier],
    ]);
    const usedNonces = new Set<number>(nonceBurned ? [fs.nonce] : []);

    const policyState = toPolicyState(mandate, lease, registry, usedNonces);

    // One call does the deciding AND the signing: coreSign validates the lease,
    // runs the frozen evaluator, and signs only an APPROVED outcome. There is no
    // path through it that returns a signature for a refused payment.
    let signed;
    try {
      signed = await coreSign(toPolicyFactSheet(fs), policyState, toLease(lease), Date.now());
    } catch (e) {
      if (e instanceof LeaseInvalidError) {
        return reply.code(403).send({ error: { code: 'LEASE_EXPIRED', message: e.message } });
      }
      throw e;
    }

    const trace = signed.trace;
    if (signed.partialSig !== null) trace.signature = signed.partialSig;

    store.storeDecision(trace, lease.mandateId);
    store.linkDecisionToMandate(trace.decisionId, lease.mandateId);

    // Emit: decision made
    emit({ t: 'decision.made', trace });

    if (trace.outcome === 'APPROVED') {
      // Simulate FROST signing ceremony (3 rounds) for M3
      const of = 3;
      for (let round = 1; round <= of; round++) {
        await delay(60);
        emit({ t: 'ceremony.round', decisionId: trace.decisionId, round, of });

        // Check if revoked mid-ceremony
        const freshMandate = store.getMandate(lease.mandateId);
        if (freshMandate?.frozen) {
          emit({ t: 'ceremony.aborted', decisionId: trace.decisionId, atRound: round, reason: 'revoked' });
          return reply.code(403).send({ error: { code: 'REVOKED', message: 'Revoked mid-ceremony.' } });
        }
      }

      // Only now is the request settle-able. Storing the exact struct that was
      // signed is what lets /settle broadcast without rebuilding (and therefore
      // without risking a different digest).
      if (signed.request !== null && signed.partialSig !== null) {
        store.putSettlementContext(trace.decisionId, {
          request: signed.request,
          coreSig: signed.partialSig,
        });
      }
    }

    if (trace.outcome === 'HELD') {
      const hold = { expiresAtMs: Date.now() + 90_000 };
      emit({ t: 'payment.held', decisionId: trace.decisionId, expiresAtMs: hold.expiresAtMs, amountMinor: trace.amountMinor });
    }

    // A REFUSED decision still returns 200 with its trace: the decision panel is
    // the product, and the caller needs the predicate that bound to render it.
    // There is no signature attached, so nothing can be settled from it.
    return reply.code(200).send({
      decisionId: trace.decisionId,
      outcome: trace.outcome,
      trace,
      partialSig: signed.partialSig,
      holdExpiresAtMs: trace.outcome === 'HELD' ? Date.now() + 90_000 : null,
    });
  });

  // ── POST /v1/payment/settle ────────────────────────────────────────
  app.post<{ Body: { decisionId: string; agentSig: string } }>('/v1/payment/settle', async (request, reply) => {
    const { decisionId, agentSig } = request.body ?? {};

    if (!decisionId || !agentSig) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'decisionId and agentSig are required.' } });
    }

    if (!SIGNATURE_RE.test(agentSig)) {
      return reply.code(400).send({
        error: { code: 'INVALID_REQUEST', message: 'agentSig must be a 65-byte 0x-prefixed hex signature.' },
      });
    }

    const trace = store.getDecision(decisionId);
    if (!trace) {
      return reply.code(404).send({ error: { code: 'DECISION_NOT_FOUND', message: 'Decision not found.' } });
    }

    if (trace.outcome !== 'APPROVED') {
      return reply.code(409).send({ error: { code: 'DECISION_NOT_APPROVED', message: `Cannot settle a ${trace.outcome} decision.` } });
    }

    // FIX.md: no core key or no account address means we cannot broadcast, and
    // there is no fallback that invents a hash instead.
    const config = settlementConfig();
    if (config === null) {
      return reply.code(503).send({
        error: {
          code: 'CORE_UNAVAILABLE',
          message: 'Settlement is unavailable: CORE_SIGNER_PRIVATE_KEY or REKHA_ACCOUNT_ADDRESS is not configured.',
        },
      });
    }

    const ctx = store.getSettlementContext(decisionId);
    if (!ctx) {
      return reply.code(503).send({
        error: { code: 'CORE_UNAVAILABLE', message: 'No signed request is held for this decision.' },
      });
    }

    // The chain is the judge from here. A revert is the enforcement working, so
    // it is reported as 422 with the contract's own error name — never a 500 and
    // never swallowed.
    let receipt;
    try {
      receipt = await broadcastExecute(config, ctx.request, agentSig as Hex, ctx.coreSig);
    } catch (e) {
      if (e instanceof SettlementRevertedError) {
        return reply.code(422).send({
          error: { code: e.errorName, message: `Settlement refused on chain: ${e.errorName}.`, decisionId },
        });
      }
      // RPC unreachable, key rejected, out of gas money: nothing settled, so say
      // so with a 503 rather than letting the generic 500 handler imply a
      // maybe-it-happened.
      request.log.error(e);
      return reply.code(503).send({
        error: { code: 'CORE_UNAVAILABLE', message: 'Could not broadcast the settlement transaction.' },
      });
    }

    // Reached only for a receipt with status 'success'.
    const result = store.settleDecision(decisionId, receipt.txHash, receipt.blockNumber);

    emit({
      t: 'payment.settled',
      decisionId,
      txHash: result.txHash,
      balanceAfterMinor: result.balanceAfterMinor,
    });

    return reply.code(200).send({
      txHash: result.txHash,
      balanceAfterMinor: result.balanceAfterMinor,
      blockNumber: result.blockNumber,
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
