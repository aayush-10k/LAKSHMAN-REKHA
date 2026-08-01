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

export async function registerTaskRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { description: string; mode: BehaviourMode } }>('/v1/task/create', async (request, reply) => {
    const { description, mode } = request.body ?? {};

    if (typeof description !== 'string' || !description.trim()) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'description is required.' } });
    }

    if (!BEHAVIOUR_MODES.includes(mode)) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: `mode must be one of: ${BEHAVIOUR_MODES.join(', ')}` } });
    }

    const task = createTask({ description, mode });

    emit({
      t: 'task.started',
      taskId: task.taskId,
      kind: task.kind,
      description,
      plan: task.plan,
      mode,
    });

    return reply.code(201).send({
      taskId: task.taskId,
      plan: task.plan,
    });
  });
}
