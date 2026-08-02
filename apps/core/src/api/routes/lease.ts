/**
 * B9 — POST /v1/lease/renew
 *
 * Agent calls this every ~4s. Returns a lease with 5s TTL.
 * If the mandate is frozen/revoked: 409 REVOKED.
 * Core unreachable → no new leases → spending stops. That IS the fail-closed path.
 *
 * Also emits lease.tick SSE events so the frontend ring animates.
 */

import type { FastifyInstance } from 'fastify';
import * as store from '../store.js';
import { emit } from '../../events/bus.js';

export async function registerLeaseRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { agentId: string } }>('/v1/lease/renew', async (request, reply) => {
    const { agentId } = request.body ?? {};

    if (typeof agentId !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'agentId is required.' } });
    }

    const agent = store.getAgent(agentId);
    if (!agent) {
      return reply.code(404).send({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not registered.' } });
    }

    const mandate = store.getMandate(agent.mandateId);
    if (!mandate) {
      return reply.code(503).send({ error: { code: 'CORE_UNAVAILABLE', message: 'Mandate state unavailable.' } });
    }

    if (mandate.frozen) {
      return reply.code(409).send({ error: { code: 'REVOKED', message: 'Mandate is revoked. No leases will be issued.' } });
    }

    // Null covers "no core key configured" as well as a frozen/absent mandate.
    // Every one of those must stop spending rather than yield an unsigned lease.
    const lease = await store.issueLease(agentId);
    if (!lease) {
      return reply.code(503).send({ error: { code: 'CORE_UNAVAILABLE', message: 'Could not issue lease.' } });
    }

    const ttlMs = lease.expiresAtMs - Date.now();

    // SSE: update the frontend TTL ring
    emit({ t: 'lease.tick', leaseId: lease.leaseId, ttlMs });

    return reply.code(200).send({
      leaseId: lease.leaseId,
      expiresAtMs: lease.expiresAtMs,
      revocationEpoch: lease.revocationEpoch,
      policyHash: lease.policyHash,
      signature: lease.signature,
    });
  });
}
