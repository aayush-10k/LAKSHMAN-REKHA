/**
 * B10 — SSE endpoint
 * GET /v1/events
 *
 * Every connected client receives all RekhaEvents in real time.
 * C builds the entire live UI from this stream — no polling.
 */

import type { FastifyInstance } from 'fastify';
import { bus } from './bus.js';

export async function registerSseRoute(app: FastifyInstance): Promise<void> {
  app.get('/v1/events', (request, reply) => {
    const raw = reply.raw;

    // CORS has to be set here, by hand.
    //
    // @fastify/cors adds its headers in an onSend hook, but this route never
    // goes through onSend — it writes to reply.raw and calls flushHeaders()
    // itself. So the stream went out with no Access-Control-Allow-Origin and
    // every browser on :3000 got "blocked by CORS policy", which took the whole
    // live UI down: no feed, no decision panel, no lease ring, no settlement.
    // Same origin value the plugin is configured with.
    raw.setHeader('Access-Control-Allow-Origin', process.env['CORS_ORIGIN'] ?? '*');
    raw.setHeader('Vary', 'Origin');

    raw.setHeader('Content-Type', 'text/event-stream');
    raw.setHeader('Cache-Control', 'no-cache, no-transform');
    raw.setHeader('Connection', 'keep-alive');
    raw.setHeader('X-Accel-Buffering', 'no'); // nginx: disable buffering
    raw.flushHeaders();

    // Send a comment heartbeat every 15s so the connection doesn't time out
    const heartbeat = setInterval(() => {
      try {
        raw.write(': heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);

    // Fan out all bus events to this client
    const unsubscribe = bus.subscribe((event) => {
      try {
        raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Client disconnected mid-write — clean up below
      }
    });

    // Initial ping so the client knows the stream is live
    raw.write(`data: ${JSON.stringify({ t: 'core.status', atMs: Date.now(), up: true, imageDigest: process.env['CORE_IMAGE_DIGEST'] ?? 'dev' })}\n\n`);

    request.socket.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    // fastify: do not auto-send a reply — we're streaming
    return reply;
  });
}
