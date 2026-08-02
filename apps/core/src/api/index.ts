/**
 * B9 — Core API server entry
 *
 * Fastify server exposing all /v1/* routes plus the SSE stream.
 * Person B owns apps/core/src/api/ and apps/core/src/events/.
 * A's policy/lease/signing modules are now wired in: /v1/payment/request goes
 * through coreSign(), which runs the real evaluator. mock-evaluator.ts is kept
 * on disk, unimported, as the rollback.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerAgentRoutes } from './routes/agent.js';
import { registerLeaseRoutes } from './routes/lease.js';
import { registerPaymentRoutes } from './routes/payment.js';
import { registerHoldRoutes } from './routes/hold.js';
import { registerTaskRoutes } from './routes/task.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerRevokeRoutes } from './routes/revoke.js';
import { registerSseRoute } from '../events/sse.js';
import { emit } from '../events/bus.js';
import * as store from './store.js';

const PORT = Number(process.env['PORT'] ?? 4000);

async function buildApp() {
  const app = Fastify({
    logger: process.env['NODE_ENV'] !== 'production'
      ? { level: 'info' }  // plain logs in dev — no pino-pretty dependency needed
      : { level: process.env['LOG_LEVEL'] ?? 'info' },
  });

  await app.register(cors, {
    origin: process.env['CORS_ORIGIN'] ?? '*',
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  // Health check
  app.get('/health', () => ({ ok: true, ts: Date.now() }));

  // SSE — must be registered before other routes to avoid route conflicts
  await registerSseRoute(app);

  // API routes
  await registerAgentRoutes(app);
  await registerLeaseRoutes(app);
  await registerPaymentRoutes(app);
  await registerHoldRoutes(app);
  await registerTaskRoutes(app);
  await registerAuditRoutes(app);
  await registerRevokeRoutes(app);

  // Global error handler — fail closed: unknown errors never return 200
  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    if (reply.statusCode === 200) reply.statusCode = 500;
    return reply.send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred. No payment was processed.',
      },
    });
  });

  return app;
}

// Start if run directly
const app = await buildApp();
await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`core API listening on http://localhost:${PORT}`);

// Emit periodic core.status so C's enforcement panel stays current
setInterval(() => {
  emit({
    t: 'core.status',
    up: true,
    imageDigest: process.env['CORE_IMAGE_DIGEST'] ?? 'sha256:dev',
  });
}, 30_000);

// Dead-man switch: check all mandates every 10s
setInterval(() => {
  // Access mandates indirectly via store — freeze if heartbeat lapsed
  // We expose a checkDeadman helper from store
  store.checkDeadman((mandateId, epoch) => {
    emit({ t: 'revocation', epoch, source: 'deadman', latencyMs: 0 });
    console.warn(`[deadman] mandate ${mandateId} frozen — heartbeat lapsed`);
  });
}, 10_000);

export { buildApp };
