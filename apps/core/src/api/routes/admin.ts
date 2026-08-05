/**
 * POST /v1/admin/kill  +  POST /v1/admin/revive
 *
 * The playground's "☠ Kill Approval Service" button POSTed
 * /v1/admin/kill, a route that did not exist, wrapped in `.catch(() => {})`. It
 * then greyed itself out and announced "Core is offline" while the core was
 * fine. A fabricated demo beat — worse than a missing feature, because a judge
 * who checks finds the core still issuing leases.
 *
 * This makes it real. Killing issuance stops new leases at the one place every
 * caller goes through (store.issueLease), so spending stops within LEASE_TTL_MS
 * with nothing else involved: no new lease, no new PaymentRequest, no signature,
 * no settlement. That is the fail-closed claim, executed rather than asserted.
 *
 * NOT authenticated, deliberately and only because this is a demo control that
 * has to be reachable from a judge's browser. A real deployment does not expose
 * an unauthenticated endpoint that halts the payment service; it is commented
 * here rather than quietly shipped.
 */

import type { FastifyInstance } from 'fastify';
import * as store from '../store.js';
import { emit } from '../../events/bus.js';

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/admin/kill', async (_request, reply) => {
    const { killedAtMs, leaseTtlMs } = store.killIssuance();

    // Tell every connected page, so the console and the playground both show the
    // core going down rather than only the tab that pressed the button.
    emit({ t: 'core.status', up: false, imageDigest: process.env['CORE_IMAGE_DIGEST'] ?? 'sha256:dev' });

    return reply.code(200).send({
      killed: true,
      killedAtMs,
      leaseTtlMs,
      /** When every lease outstanding at the moment of the kill has expired. */
      spendingStopsByMs: killedAtMs + leaseTtlMs,
      message: `Approval service killed. No further leases will be issued; all spending stops within ${leaseTtlMs}ms.`,
    });
  });

  app.post('/v1/admin/revive', async (_request, reply) => {
    store.reviveIssuance();
    emit({ t: 'core.status', up: true, imageDigest: process.env['CORE_IMAGE_DIGEST'] ?? 'sha256:dev' });
    return reply.code(200).send({
      killed: false,
      message: 'Approval service resumed. Leases are being issued again.',
    });
  });
}
