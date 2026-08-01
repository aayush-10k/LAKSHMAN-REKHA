/**
 * B9 — POST /v1/agent/pair
 *
 * Owner shows a 6-char pairing code in the console.
 * Agent submits it, gets agentId + shareA.
 */

import type { FastifyInstance } from 'fastify';
import * as store from '../store.js';
import { emit } from '../../events/bus.js';

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  // Initialise a mandate for demo (normally done by owner flow)
  const { mandateId, pairingCode } = store.createMandate();
  console.log(`[agent] Demo pairing code: ${pairingCode}  mandateId: ${mandateId}`);

  app.post<{ Body: { pairingCode: string } }>('/v1/agent/pair', async (request, reply) => {
    const { pairingCode: code } = request.body ?? {};

    if (typeof code !== 'string' || code.length !== 6) {
      return reply.code(400).send({ error: { code: 'INVALID_PAIRING_CODE', message: 'Pairing code must be 6 characters.' } });
    }

    const mandate = store.getMandateByCode(code);
    if (!mandate) {
      return reply.code(404).send({ error: { code: 'PAIRING_CODE_NOT_FOUND', message: 'Pairing code not found or already used.' } });
    }

    const agent = store.registerAgent(mandate.mandateId);

    emit({ t: 'core.status', up: true, imageDigest: process.env['CORE_IMAGE_DIGEST'] ?? 'dev' });

    return reply.code(201).send({
      agentId: agent.agentId,
      shareA: agent.shareA,
      mandateId: mandate.mandateId,
    });
  });
}
