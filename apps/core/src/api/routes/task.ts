/**
 * B9 — POST /v1/task/create
 *
 * Wraps the task engine. Creates a task plan and emits task.started SSE.
 * The description field in LineItem is display-only — it NEVER enters a FactSheet.
 */

import type { FastifyInstance } from 'fastify';
// task-engine is a plain JS module without TypeScript types
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { createTask } from '../../../../agents/task-engine/src/index.js';
import { emit } from '../../events/bus.js';

type BehaviourMode = 'normal' | 'hallucinating' | 'injected' | 'compromised' | 'overreach' | 'colluding';
const BEHAVIOUR_MODES: BehaviourMode[] = ['normal', 'hallucinating', 'injected', 'compromised', 'overreach', 'colluding'];

const VENDORSIM_URL = process.env['VENDORSIM_URL'] ?? 'http://localhost:4100';

/**
 * The vendor registry's product list, which is where prices come from.
 *
 * The planner used to invent them (`qty * 9400 + 12000`), so any sentence
 * produced a purchase at a price that existed nowhere in the system. Returning
 * null here means the plan comes back empty and says so — the agent must not
 * buy at a guessed price because the registry was unreachable.
 */
async function readCatalog(): Promise<unknown[] | undefined> {
  try {
    const res = await fetch(`${VENDORSIM_URL}/catalog`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const catalog = await res.json();
    return Array.isArray(catalog) ? catalog : undefined;
  } catch (e) {
    console.warn(`[task] vendor registry at ${VENDORSIM_URL} is unreachable: ${(e as Error).message}`);
    return undefined;
  }
}

export async function registerTaskRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { description: string; mode: BehaviourMode } }>('/v1/task/create', async (request, reply) => {
    const { description, mode } = request.body ?? {};

    if (typeof description !== 'string' || !description.trim()) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'description is required.' } });
    }

    if (!BEHAVIOUR_MODES.includes(mode)) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: `mode must be one of: ${BEHAVIOUR_MODES.join(', ')}` } });
    }

    const catalog = await readCatalog();
    const task = createTask({ description, mode, catalog });

    emit({
      t: 'task.started',
      taskId: task.taskId,
      kind: task.kind,
      description,
      plan: task.plan,
      mode,
    });

    // An empty plan is a real outcome, not an error — the agent looked and found
    // nothing it could buy. Say so in the thought stream so the playground shows
    // a reason rather than a task that silently does nothing.
    if (task.plan.length === 0 && task.note) {
      emit({ t: 'agent.thought', taskId: task.taskId, text: task.note });
    } else {
      const item = task.plan[0];
      emit({
        t: 'agent.thought',
        taskId: task.taskId,
        text: `Found ${item.description} — ₹${(item.estimatedAmountMinor / 100).toLocaleString('en-IN')} at the registry's listed price.`,
      });
    }

    return reply.code(201).send({
      taskId: task.taskId,
      plan: task.plan,
      note: task.note,
    });
  });
}
