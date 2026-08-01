/**
 * B9 — POST /v1/payment/request  +  POST /v1/payment/settle
 *
 * /request: validates FactSheet, runs evaluator, emits decision events.
 *           FROST ceremony simulation: emits ceremony.round SSE events for M3.
 * /settle:  completes an APPROVED decision; produces a txHash.
 */

import type { FastifyInstance } from 'fastify';
import { validateFactSheet } from '../validate-factsheet.js';
import { evaluate, CORE_IMAGE_DIGEST } from '../mock-evaluator.js';
import * as store from '../store.js';
import { emit } from '../../events/bus.js';

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

    // Run the deterministic evaluator (no LLM, no I/O)
    const trace = evaluate({
      factSheet: fs,
      mandate,
      leaseExpiresAtMs: lease.expiresAtMs,
      agentSigValid: true, // agent already authenticated via agentId; real sig check is in A's signing service
      coreSigValid: true,  // we are the core — always valid here
    });

    store.storeDecision(trace);

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
    }

    if (trace.outcome === 'HELD') {
      const hold = { expiresAtMs: Date.now() + 90_000 };
      emit({ t: 'payment.held', decisionId: trace.decisionId, expiresAtMs: hold.expiresAtMs, amountMinor: trace.amountMinor });
    }

    if (trace.outcome === 'REFUSED') {
      const error422 = {
        error: {
          code: 'POLICY_REFUSED',
          message: trace.summary,
          predicate: trace.bindingPredicate ?? undefined,
          decisionId: trace.decisionId,
        },
      };
      // Still return 200 with the trace so the frontend can render the decision panel
      return reply.code(200).send({
        decisionId: trace.decisionId,
        outcome: trace.outcome,
        trace,
        partialSig: null,
        holdExpiresAtMs: null,
      });
    }

    return reply.code(200).send({
      decisionId: trace.decisionId,
      outcome: trace.outcome,
      trace,
      partialSig: trace.outcome === 'APPROVED' ? `0x${'ab'.repeat(32)}` : null,
      holdExpiresAtMs: trace.outcome === 'HELD' ? Date.now() + 90_000 : null,
    });
  });

  // ── POST /v1/payment/settle ────────────────────────────────────────
  app.post<{ Body: { decisionId: string; agentSig: string } }>('/v1/payment/settle', async (request, reply) => {
    const { decisionId, agentSig } = request.body ?? {};

    if (!decisionId || !agentSig) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'decisionId and agentSig are required.' } });
    }

    const trace = store.getDecision(decisionId);
    if (!trace) {
      return reply.code(404).send({ error: { code: 'DECISION_NOT_FOUND', message: 'Decision not found.' } });
    }

    if (trace.outcome !== 'APPROVED') {
      return reply.code(409).send({ error: { code: 'DECISION_NOT_APPROVED', message: `Cannot settle a ${trace.outcome} decision.` } });
    }

    let result: { txHash: string; blockNumber: number; balanceAfterMinor: number };
    try {
      result = store.settleDecision(decisionId);
    } catch {
      return reply.code(409).send({ error: { code: 'DECISION_NOT_APPROVED', message: 'Settlement failed.' } });
    }

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
