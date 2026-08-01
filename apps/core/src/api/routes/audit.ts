/**
 * B9 + B12 — GET /v1/audit/export
 *
 * Returns a signed JSON audit log of all decisions, settlements, and revocations.
 * Replayable — a judge can independently verify the policy hash and traces.
 */

import type { FastifyInstance } from 'fastify';
import * as store from '../store.js';

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { mandateId?: string } }>('/v1/audit/export', async (request, reply) => {
    // In production, mandateId comes from the authenticated session
    const mandateId = request.query.mandateId ?? 'demo';

    const audit = store.buildAuditExport(mandateId);

    reply.header('Content-Disposition', `attachment; filename="rekha-audit-${Date.now()}.json"`);
    return reply.code(200).send(audit);
  });
}
