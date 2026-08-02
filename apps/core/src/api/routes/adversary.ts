/**
 * POST /v1/adversary/run — Rogue Mode.
 *
 * FIX3.md BUG 5. `mode` was validated in routes/task.ts and threaded through the
 * agent runner, then ignored: hallucinating, injected, compromised, overreach
 * and colluding all ran the identical honest path, and no `attack.attempt` event
 * was emitted by any running process. The scoreboard therefore read
 * `0 · 0 · 0 · ₹0` — which a judge reads as "no attack was attempted", not as
 * "nothing got through". An entire scoring criterion, showing zero.
 *
 * The twelve deterministic classes already existed in
 * apps/agents/adversary/library.py and already hit the real core over HTTP. This
 * route is the wire between them and the UI: it proxies to the adversary runner,
 * then replays the returned events onto the SSE bus so the board fills in front
 * of the judge rather than snapping to a final number.
 *
 * Two things it deliberately does NOT do:
 *
 *  - It does not fabricate a score. If the runner is unreachable the route
 *    returns 503 and the scoreboard stays at zero, which is the truth.
 *  - It does not decide whether an attack was blocked. That verdict comes from
 *    the core's own responses to the attacks, recorded by the library. This
 *    route only transports it.
 */

import type { FastifyInstance } from 'fastify';
import { emit } from '../../events/bus.js';
import type { RekhaEvent } from '../../types.js';

const ADVERSARY_URL = process.env['ADVERSARY_URL'] ?? 'http://localhost:4300';

/**
 * Gap between replayed events. The run itself completes in well under a second
 * against a local core, so without spacing the scoreboard jumps from 0 to 147
 * in one frame and the judge sees no attack happen.
 */
const REPLAY_GAP_MS = Number(process.env['ADVERSARY_REPLAY_GAP_MS']) || 120;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type AdversaryRun = {
  summary: { total: number; blocked: number; fundsLostMinor: number; novelTechniques: number };
  results: Array<{ technique: string; classNumber: number | null; blocked: boolean; revertReason: string; novel: boolean }>;
  events: Array<Record<string, unknown>>;
};

export async function registerAdversaryRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { mode?: string; maxAttempts?: number } }>('/v1/adversary/run', async (request, reply) => {
    const { mode = 'deterministic', maxAttempts } = request.body ?? {};

    // The core's own URL as the adversary should reach it. The attacks are real
    // HTTP calls to the running core, which is the whole point: the scoreboard
    // reports what this core actually did, not what a fixture says it would do.
    const coreUrl = `http://localhost:${process.env['PORT'] ?? 4000}`;

    let run: AdversaryRun;
    try {
      const res = await fetch(`${ADVERSARY_URL}/adversary/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, coreUrl, ...(maxAttempts ? { maxAttempts } : {}) }),
      });
      if (!res.ok) {
        return reply.code(502).send({
          error: {
            code: 'ADVERSARY_FAILED',
            message: `Adversary runner returned HTTP ${res.status}. No attacks were run.`,
          },
        });
      }
      run = (await res.json()) as AdversaryRun;
    } catch (e) {
      // Nothing ran, so nothing is reported. A zero scoreboard with an error
      // beside it is honest; a fabricated 12/12 is not.
      request.log.error(e);
      return reply.code(503).send({
        error: {
          code: 'ADVERSARY_UNAVAILABLE',
          message:
            `Could not reach the adversary runner at ${ADVERSARY_URL}. ` +
            'Start it with `pnpm dev:adversary`. No attacks were run.',
        },
      });
    }

    // Replay onto the SSE bus. The events already carry the shape types.ts
    // declares for attack.attempt, so they are forwarded rather than rebuilt.
    void (async () => {
      for (const event of run.events) {
        emit(event as unknown as RekhaEvent);
        await delay(REPLAY_GAP_MS);
      }
    })();

    return reply.code(200).send({
      summary: run.summary,
      results: run.results,
      replay: { events: run.events.length, gapMs: REPLAY_GAP_MS },
    });
  });
}
