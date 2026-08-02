/**
 * POST /v1/revoke
 * POST /v1/agent/heartbeat
 *
 * Revoke — owner or guardian increments revocationEpoch, freezes mandate.
 * Heartbeat — owner keeps the dead-man switch alive.
 */

import type { FastifyInstance } from 'fastify';
import * as store from '../store.js';
import { emit } from '../../events/bus.js';
import { inrxBalanceOf, rekhaAccountAddress } from '../chain.js';

export async function registerRevokeRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/revoke
  app.post<{ Body: { mandateId: string; source?: 'owner' | 'guardian' | 'deadman' } }>(
    '/v1/revoke',
    async (request, reply) => {
      const { mandateId, source = 'owner' } = request.body ?? {};

      if (!mandateId) {
        return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'mandateId is required.' } });
      }

      const mandate = store.getMandate(mandateId);
      if (!mandate) {
        return reply.code(404).send({ error: { code: 'MANDATE_NOT_FOUND', message: 'Mandate not found.' } });
      }

      const revokedAt = Date.now();
      store.revokeMandate(mandateId);
      store.logRevocation(mandate.revocationEpoch + 1, source);

      emit({
        t: 'revocation',
        epoch: mandate.revocationEpoch + 1,
        source,
        latencyMs: Date.now() - revokedAt,
      });

      return reply.code(200).send({
        revoked: true,
        epoch: mandate.revocationEpoch + 1,
        source,
        latencyMs: Date.now() - revokedAt,
      });
    },
  );

  // POST /v1/agent/heartbeat — keeps dead-man switch alive
  app.post<{ Body: { mandateId: string } }>('/v1/agent/heartbeat', async (request, reply) => {
    const { mandateId } = request.body ?? {};
    if (!mandateId) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'mandateId is required.' } });
    }
    store.heartbeat(mandateId);
    return reply.code(200).send({ ok: true, ts: Date.now() });
  });

  // GET /v1/mandate/:mandateId — frontend polls for current state
  app.get<{ Params: { mandateId: string } }>('/v1/mandate/:mandateId', async (request, reply) => {
    const mandate = store.getMandate(request.params.mandateId);
    if (!mandate) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Mandate not found.' } });
    return reply.code(200).send({
      mandateId: mandate.mandateId,
      revocationEpoch: mandate.revocationEpoch,
      frozen: mandate.frozen,
      perTxCapMinor: mandate.perTxCapMinor,
      windowCapMinor: mandate.windowCapMinor,
      windowSpentMinor: mandate.windowSpentMinor,
      cumulativeSpentMinor: mandate.cumulativeSpentMinor,
      permittedCategories: mandate.permittedCategories,
      lastHeartbeatMs: mandate.lastHeartbeatMs,
    });
  });

  // GET /v1/wallet/balance — frontend shows balance
  //
  // This is RekhaAccount's INRx balance on Base Sepolia, not a number this
  // process keeps. It used to be an in-memory ₹50,000 that the core decremented
  // itself, so the console's headline figure was decorative: it moved when a
  // payment settled but had never had any relationship to the money on chain.
  //
  // An unreachable RPC returns 503 rather than the old local number. A balance
  // that might be wrong is worse than a balance that says it is unavailable.
  app.get('/v1/wallet/balance', async (_request, reply) => {
    const account = rekhaAccountAddress();
    if (account === null) {
      return reply.code(503).send({
        error: { code: 'CORE_UNAVAILABLE', message: 'REKHA_ACCOUNT_ADDRESS is not configured.' },
      });
    }
    try {
      const balance = await inrxBalanceOf(account);
      return reply.code(200).send({
        balanceMinor: Number(balance),
        account,
        source: 'chain' as const,
        asOfMs: Date.now(),
      });
    } catch (e) {
      app.log.error(e);
      return reply.code(503).send({
        error: { code: 'CORE_UNAVAILABLE', message: 'Could not read the on-chain INRx balance.' },
      });
    }
  });

  // GET /v1/holds — active holds list
  app.get('/v1/holds', async (_request, reply) => {
    return reply.code(200).send({ holds: store.getActiveHolds() });
  });
}
