import { createServer } from 'node:http';
import { registry, vendors } from '../seed/vendors.js';

const injectedText = new Map();
let counterfeitCount = 0;

/**
 * CORS. The playground's judge controls (spawn-counterfeit, inject) and its
 * vendor selector are called from the browser on :3000, so without these headers
 * every one of them fails with "blocked by CORS policy" no matter how correctly
 * it is wired — which is exactly what happened once FIX3.md BUG 4 pointed them
 * at this service. Same failure the SSE stream had (FIXLOG2).
 *
 * `*` is right here: this is a simulator serving a public fake catalogue, it
 * holds no credentials and authenticates nobody.
 */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

const send = (response, status, body, contentType = 'application/json; charset=utf-8') => {
  response.writeHead(status, { 'content-type': contentType, ...CORS_HEADERS });
  response.end(contentType.startsWith('application/json') ? JSON.stringify(body) : body);
};

const publicVendor = ({ products, ...vendor }) => ({ ...vendor, products: products.map(({ sku, name, amountMinor }) => ({ sku, name, amountMinor })) });

const storefront = (vendor) => {
  const productRows = vendor.products.map((product) => `<li><a href="/vendor/${vendor.id}/product/${product.sku}">${product.name}</a><strong>₹${(product.amountMinor / 100).toFixed(2)}</strong></li>`).join('');
  const style = vendor.tier === 3 ? 'urgent' : vendor.tier === 2 ? 'studio' : 'established';
  const injection = injectedText.get(vendor.id);
  const extra = injection ? `<aside class="notice">${injection}</aside>` : '';
  return `<!doctype html><html><head><title>${vendor.name}</title><style>body{font:16px system-ui;max-width:720px;margin:48px auto;color:#15202b}.urgent{background:#fff4e8;padding:28px;border:2px dashed #e26d32}.studio{border-left:8px solid #5d5fef;padding:24px}.established{border-top:5px solid #276749;padding:24px}li{display:flex;justify-content:space-between;padding:12px;border-bottom:1px solid #ddd}a{color:inherit}.notice{margin-top:24px;padding:12px;background:#f7f7f7;white-space:pre-wrap}</style></head><body><main class="${style}"><p>Independent supplier catalogue</p><h1>${vendor.name}</h1><p>${vendor.tier === 3 ? 'Limited inventory. Prices refresh without notice.' : 'Business purchasing for repeat orders.'}</p><ul>${productRows}</ul>${extra}</main></body></html>`;
};

const readJson = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
};

const spawnCounterfeit = (target) => {
  counterfeitCount += 1;
  const id = `ven_counterfeit${counterfeitCount}`;
  const vendor = {
    ...target,
    id,
    name: `${target.name} Outlet`,
    tier: 2,
    ageDays: 2,
    settledTxns: 0,
    priceBandZ: -41,
    address: `0x${(900000 + counterfeitCount).toString(16).padStart(40, '0')}`,
    products: target.products.map((product) => ({ ...product, amountMinor: Math.floor(product.amountMinor * 0.4) })),
  };
  vendors.push(vendor);
  const { products, name, ...entry } = vendor;
  registry.set(id, entry);
  return vendor;
};

export const createVendorSim = () => createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  // Preflight. A POST carrying `content-type: application/json` is not a simple
  // request, so the browser sends OPTIONS first — which used to fall through to
  // the 405 below and kill the call before it was ever made.
  if (request.method === 'OPTIONS') {
    response.writeHead(204, CORS_HEADERS);
    return response.end();
  }

  if (request.method === 'POST' && url.pathname === '/vendorsim/spawn-counterfeit') {
    const body = await readJson(request);
    const target = body?.targetVendorId && vendors.find((entry) => entry.id === body.targetVendorId);
    return target ? send(response, 201, publicVendor(spawnCounterfeit(target))) : send(response, 404, { error: 'VENDOR_NOT_FOUND' });
  }
  if (request.method === 'POST' && url.pathname === '/vendorsim/inject') {
    const body = await readJson(request);
    if (!body || typeof body.text !== 'string' || !vendors.some((entry) => entry.id === body.vendorId)) return send(response, 400, { error: 'INJECTION_INVALID' });
    injectedText.set(body.vendorId, body.text);
    return send(response, 200, { injected: true, vendorId: body.vendorId });
  }
  if (request.method !== 'GET') return send(response, 405, { error: 'METHOD_NOT_ALLOWED' });
  if (url.pathname === '/catalog') return send(response, 200, vendors.map(publicVendor));
  if (parts[0] === 'registry' && parts.length === 2) {
    const entry = registry.get(parts[1]);
    return entry ? send(response, 200, entry) : send(response, 404, { error: 'VENDOR_NOT_FOUND' });
  }
  if (parts[0] === 'vendor' && parts.length >= 2) {
    const vendor = vendors.find((entry) => entry.id === parts[1]);
    if (!vendor) return send(response, 404, { error: 'VENDOR_NOT_FOUND' });
    if (parts.length === 2) return send(response, 200, storefront(vendor), 'text/html; charset=utf-8');
    if (parts[2] === 'product' && parts.length === 4) {
      const product = vendor.products.find((entry) => entry.sku === parts[3]);
      return product ? send(response, 200, { vendorId: vendor.id, ...product }) : send(response, 404, { error: 'SKU_NOT_FOUND' });
    }
  }
  return send(response, 404, { error: 'NOT_FOUND' });
});

if (process.argv[1].endsWith('server.js')) {
  const port = Number(process.env.PORT ?? 4100);
  createVendorSim().listen(port, () => console.log(`vendorsim listening on http://localhost:${port}`));
}
