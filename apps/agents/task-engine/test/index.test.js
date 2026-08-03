import assert from 'node:assert/strict';
import test from 'node:test';
import { SimulationClock, createTask, taskKindFor } from '../src/index.js';

test('recognises all six task kinds', () => {
  assert.deepEqual(['Order 100 bottles', 'Advertise to 4000 people', 'Generate 20 images', 'Buy 2 API credits', 'Ship to 12 cities', 'Renew tooling subscription'].map(taskKindFor), ['procure', 'ads', 'content', 'compute', 'logistics', 'subscription']);
});

/** A trimmed copy of the vendor registry's /catalog response. */
const CATALOG = [
  {
    id: 'ven_meridian', name: 'Meridian Packaging', tier: 1, categoryCode: 'PACKAGING',
    products: [
      { sku: 'glass-500', name: '500ml amber glass bottle', amountMinor: 9400 },
      { sku: 'cap-black', name: 'Black tamper cap', amountMinor: 240 },
    ],
  },
  {
    id: 'ven_flashcart', name: 'FlashCart Wholesale', tier: 3, categoryCode: 'PACKAGING',
    products: [{ sku: 'bottle-500', name: 'Premium 500ml bottle', amountMinor: 2800 }],
  },
  {
    id: 'ven_pixelvault', name: 'PixelVault Pro', tier: 3, categoryCode: 'SOFTWARE',
    products: [{ sku: 'suite-month', name: 'Creative suite monthly access', amountMinor: 899000 }],
  },
];

test('creates API-compatible line items with integer paise', () => {
  const task = createTask({ description: 'Order 100 bottles', mode: 'normal', catalog: CATALOG }, new SimulationClock());
  assert.match(task.taskId, /^tsk_[0-9a-f]{6}$/);
  assert.match(task.plan[0].lineItemId, /^li_[0-9a-f]{6}_01$/);
  assert.equal(Number.isInteger(task.plan[0].estimatedAmountMinor), true);
  assert.equal(task.plan[0].categoryCode, 'PACKAGING');
});

test('prices from the registry, not from an invented formula', () => {
  const task = createTask(
    { description: 'Order 100 amber glass bottles', mode: 'normal', catalog: CATALOG },
    new SimulationClock(),
  );
  // 100 x the listed 9400, and nothing added on top. "amber glass" is specific
  // enough to name one product, so no tie-break is involved.
  assert.equal(task.plan[0].estimatedAmountMinor, 940000);
  assert.equal(task.plan[0].vendorId, 'ven_meridian');
});

test('a tie goes to the cheaper vendor, which is what a buying agent does', () => {
  // "bottles" alone matches Meridian's glass-500 and FlashCart's bottle-500
  // equally. The agent takes the cheaper one — it is not the shopper's job to
  // judge whether a counterparty is admissible.
  const task = createTask({ description: 'Order 100 bottles', mode: 'normal', catalog: CATALOG }, new SimulationClock());
  assert.equal(task.plan[0].vendorId, 'ven_flashcart');
  assert.equal(task.plan[0].estimatedAmountMinor, 280000); // 100 x 2800
});

test('a counterfeit storefront actually lures the agent', () => {
  // This is the demo the tie-break exists for. A spawned counterfeit clones its
  // target's product names at 40% of the price. Preferring the lower tier — as
  // this used to — made the fake unreachable: identical names always tied, and
  // the tier-1 original always won, so pressing "Spawn counterfeit" changed
  // nothing on screen.
  const counterfeit = {
    id: 'ven_counterfeit1', name: 'Meridian Packaging Outlet', tier: 2, categoryCode: 'PACKAGING',
    products: [{ sku: 'glass-500', name: '500ml amber glass bottle', amountMinor: 3760 }],
  };
  const task = createTask(
    { description: 'Order 100 amber glass bottles', mode: 'normal', catalog: [...CATALOG, counterfeit] },
    new SimulationClock(),
  );
  assert.equal(task.plan[0].vendorId, 'ven_counterfeit1');
  assert.equal(task.plan[0].estimatedAmountMinor, 376000);
});

test('a stated price is not mistaken for a quantity', () => {
  // The bug this replaces: "2 chips for 5 rs" read the 2, ignored "chips"
  // entirely, and produced 2 * 9400 + 12000 = 30800 against a packaging vendor.
  const task = createTask({ description: 'buy 2 caps for 5 rs', mode: 'normal', catalog: CATALOG }, new SimulationClock());
  assert.equal(task.plan[0].estimatedAmountMinor, 480); // 2 x 240, not 5, not 30800
});

test('respects pack sizes so impressions are not bought as campaigns', () => {
  const catalog = [{
    id: 'ven_signalworks', name: 'Signal Works Media', tier: 2, categoryCode: 'ADVERTISING',
    products: [{ sku: 'search-1k', name: 'Search campaign, 1k impressions', amountMinor: 42000 }],
  }];
  const task = createTask(
    { description: 'run a search campaign for 5000 impressions', mode: 'normal', catalog },
    new SimulationClock(),
  );
  // 5 packs of 1k at 42000, not 5000 packs.
  assert.equal(task.plan[0].estimatedAmountMinor, 210000);
});

test('refuses to plan when nothing in the registry matches', () => {
  const task = createTask({ description: 'buy 2 chips for 5 rs', mode: 'normal', catalog: CATALOG }, new SimulationClock());
  assert.deepEqual(task.plan, []);
  assert.match(task.note, /Nothing in the vendor registry matches/);
});

test('no catalog means no plan, never a guessed price', () => {
  const task = createTask({ description: 'Order 100 bottles', mode: 'normal' }, new SimulationClock());
  assert.deepEqual(task.plan, []);
  assert.match(task.note, /vendor registry could not be read/);
});
