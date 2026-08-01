import assert from 'node:assert/strict';
import test from 'node:test';
import { SimulationClock, createTask, taskKindFor } from '../src/index.js';

test('recognises all six task kinds', () => {
  assert.deepEqual(['Order 100 bottles', 'Advertise to 4000 people', 'Generate 20 images', 'Buy 2 API credits', 'Ship to 12 cities', 'Renew tooling subscription'].map(taskKindFor), ['procure', 'ads', 'content', 'compute', 'logistics', 'subscription']);
});

test('creates API-compatible line items with integer paise', () => {
  const task = createTask({ description: 'Order 100 bottles', mode: 'normal' }, new SimulationClock());
  assert.match(task.taskId, /^tsk_[0-9a-f]{6}$/);
  assert.match(task.plan[0].lineItemId, /^li_[0-9a-f]{6}_01$/);
  assert.equal(Number.isInteger(task.plan[0].estimatedAmountMinor), true);
  assert.equal(task.plan[0].categoryCode, 'PACKAGING');
});
