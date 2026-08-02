/**
 * B9 — agent pairing.
 *
 *   GET  /v1/agent/pairing-code  — the code this core is currently offering
 *   GET  /v1/agent/:agentId      — is this agentId still known here?
 *   POST /v1/agent/pair          — redeem a code, get agentId + shareA
 *
 * FIX2.md BUG 2. The browser POSTed a hardcoded pairing code and got 404 every
 * time. It could not have worked: the code is minted fresh on each boot
 * (see the createMandate call below) and pairing state is in memory, so any
 * value baked into the frontend is dead the moment the core restarts.
 *
 * The two GETs are what make the demo unbreakable in that way. A client fetches
 * the live code instead of guessing one, and can ask whether the agentId it
 * cached from a previous boot still exists — a 404 there is the signal to
 * re-pair rather than to fail silently.
 *
 * Exposing the code over an unauthenticated GET is a demo affordance, not a
 * security claim: pairing hands out a share of a mandate, so a real deployment
 * shows the code to an authenticated owner in the console and never over an
 * open endpoint. Written down here so it is a decision and not an oversight.
 */

import type { FastifyInstance } from 'fastify';
import * as store from '../store.js';
import { emit } from '../../events/bus.js';

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  // Initialise a mandate for demo (normally done by owner flow)
  const { mandateId, pairingCode } = store.createMandate();
  console.log(`[agent] Demo pairing code: ${pairingCode}  mandateId: ${mandateId}`);

  app.get('/v1/agent/pairing-code', async (_request, reply) => {
    return reply.code(200).send({ pairingCode, mandateId, leaseTtlMs: store.leaseTtlMs() });
  });

  app.get<{ Params: { agentId: string } }>('/v1/agent/:agentId', async (request, reply) => {
    const agent = store.getAgent(request.params.agentId);
    if (!agent) {
      return reply.code(404).send({
        error: {
          code: 'AGENT_NOT_FOUND',
          message: 'This core does not know that agentId. Pairing state is in memory and is lost on restart — pair again.',
        },
      });
    }
    return reply.code(200).send({
      agentId: agent.agentId,
      mandateId: agent.mandateId,
      leaseTtlMs: store.leaseTtlMs(),
    });
  });

  /**
   * The agent's narration: what it is doing, and what a vendor quoted.
   *
   * The agent runs in its own process, so it cannot emit onto this core's SSE bus
   * directly. Only two event types are accepted, both of them display-only. That
   * restriction is the whole design: nothing posted here can produce a decision,
   * a signature or a settlement, so an agent that lies to this endpoint can only
   * lie about its own narration — never about what the enforcement layer did.
   */
  app.post<{ Body: { t: string; [k: string]: unknown } }>('/v1/agent/event', async (request, reply) => {
    const body = request.body ?? ({} as Record<string, unknown>);

    if (body.t === 'agent.thought' && typeof body['text'] === 'string' && typeof body['taskId'] === 'string') {
      emit({ t: 'agent.thought', taskId: body['taskId'], text: String(body['text']).slice(0, 400) });
      return reply.code(202).send({ accepted: true });
    }

    if (
      body.t === 'quote.received' &&
      typeof body['lineItemId'] === 'string' &&
      typeof body['vendorId'] === 'string' &&
      typeof body['amountMinor'] === 'number'
    ) {
      emit({
        t: 'quote.received',
        lineItemId: body['lineItemId'],
        vendorId: body['vendorId'],
        amountMinor: body['amountMinor'],
        simElapsedMs: typeof body['simElapsedMs'] === 'number' ? body['simElapsedMs'] : 0,
      });
      return reply.code(202).send({ accepted: true });
    }

    return reply.code(400).send({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Only agent.thought {taskId,text} and quote.received {lineItemId,vendorId,amountMinor} are accepted.',
      },
    });
  });

  app.post<{ Body: { pairingCode: string } }>('/v1/agent/pair', async (request, reply) => {
    const { pairingCode: code } = request.body ?? {};

    if (typeof code !== 'string' || code.length !== 6) {
      return reply.code(400).send({ error: { code: 'INVALID_PAIRING_CODE', message: 'Pairing code must be 6 characters.' } });
    }

    const mandate = store.getMandateByCode(code);
    if (!mandate) {
      return reply.code(404).send({
        error: {
          code: 'PAIRING_CODE_NOT_FOUND',
          message: 'Pairing code not found. This core mints a new code on every restart — GET /v1/agent/pairing-code for the current one.',
        },
      });
    }

    const agent = store.registerAgent(mandate.mandateId);

    emit({ t: 'core.status', up: true, imageDigest: process.env['CORE_IMAGE_DIGEST'] ?? 'dev' });

    return reply.code(201).send({
      agentId: agent.agentId,
      shareA: agent.shareA,
      mandateId: mandate.mandateId,
      leaseTtlMs: store.leaseTtlMs(),
    });
  });
}
