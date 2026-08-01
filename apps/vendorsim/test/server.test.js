import assert from 'node:assert/strict';
import test from 'node:test';
import { createVendorSim } from '../src/server.js';

const withServer = async (run) => {
  const server = createVendorSim();
  await new Promise((resolve) => server.listen(0, resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
};

test('catalog exposes eight vendors without registry-only attributes in storefront HTML', async () => withServer(async (base) => {
  const catalog = await fetch(`${base}/catalog`).then((response) => response.json());
  assert.equal(catalog.length, 8);
  const html = await fetch(`${base}/vendor/ven_meridian`).then((response) => response.text());
  assert.equal(html.includes('412'), false);
  assert.equal(html.includes('1183'), false);
}));

test('registry stays server-side and resolves vendor facts', async () => withServer(async (base) => {
  const registry = await fetch(`${base}/registry/ven_flashcart`).then((response) => response.json());
  assert.deepEqual({ tier: registry.tier, ageDays: registry.ageDays, settledTxns: registry.settledTxns }, { tier: 3, ageDays: 12, settledTxns: 3 });
  const product = await fetch(`${base}/vendor/ven_meridian/product/glass-500`).then((response) => response.json());
  assert.equal(product.amountMinor, 9400);
}));
