/**
 * B9 — POST /v1/hold/cancel
 * Releases a held payment before its expiry timer fires.
 */

import type { FastifyInstance } from 'fastify';
import * as store from '../store.js';
import { emit } from '../../events/bus.js';

export async function registerHoldRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { decisionId: string } }>('/v1/hold/cancel', async (request, reply) => {
    const { decisionId } = request.body ?? {};

    if (typeof decisionId !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'decisionId is required.' } });
    }

    let result: { released: true; amountMinor: number };
    try {
      result = store.releaseHold(decisionId);
    } catch {
      return reply.code(404).send({ error: { code: 'HOLD_NOT_FOUND', message: 'Hold not found or already released.' } });
    }

    emit({ t: 'hold.released', decisionId, amountMinor: result.amountMinor });

    return reply.code(200).send({ released: true, amountMinor: result.amountMinor });
  });
}
