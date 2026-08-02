/**
 * B9 — Core API server entry
 *
 * Fastify server exposing all /v1/* routes plus the SSE stream.
 * Person B owns apps/core/src/api/ and apps/core/src/events/.
 * A's policy/lease/signing modules are now wired in: /v1/payment/request goes
 * through coreSign(), which runs the real evaluator. mock-evaluator.ts is kept
 * on disk, unimported, as the rollback.
 */

// MUST be the first import: it populates process.env from .env, and api/chain.ts
// reads BASE_SEPOLIA_RPC at module scope. See src/env.ts (FIX2.md BUG 1).
import { LOADED_ENV_FILES } from '../env.js';

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

import { hasCoreKey } from '../keys.js';

const PORT = Number(process.env['PORT'] ?? 4000);

/**
 * Names only — these files hold private keys. The point is that a core with no
 * key says so at boot instead of at the first 503.
 */
function reportEnv(): void {
  for (const file of LOADED_ENV_FILES) {
    console.log(`[env] ${file.path}: applied ${file.keys.length} variable(s)${file.keys.length ? ` (${file.keys.join(', ')})` : ''}`);
  }
  if (LOADED_ENV_FILES.length === 0) console.warn('[env] no .env file found');
  if (!hasCoreKey()) {
    console.warn(
      '[env] WARNING: no core signing key. CORE_SIGNER_PRIVATE_KEY is unset or malformed, so ' +
      'no lease can be signed and no payment can settle. Every affected route will 503 and say so.',
    );
  }
}

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

  // Health check. `coreKey` and `leaseTtlMs` are here so the UI can show the
  // real configuration rather than assuming a 5s lease and a working signer.
  app.get('/health', () => ({
    ok: true,
    ts: Date.now(),
    coreKey: hasCoreKey(),
    leaseTtlMs: store.leaseTtlMs(),
    envFilesLoaded: LOADED_ENV_FILES.map((f) => f.path),
  }));

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
reportEnv();
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
