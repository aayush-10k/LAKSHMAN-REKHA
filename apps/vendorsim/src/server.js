import { createServer } from 'node:http';
import { registry, vendors } from '../seed/vendors.js';

const send = (response, status, body, contentType = 'application/json; charset=utf-8') => {
  response.writeHead(status, { 'content-type': contentType });
  response.end(contentType.startsWith('application/json') ? JSON.stringify(body) : body);
};

const publicVendor = ({ products, ...vendor }) => ({ ...vendor, products: products.map(({ sku, name, amountMinor }) => ({ sku, name, amountMinor })) });

const storefront = (vendor) => {
  const productRows = vendor.products.map((product) => `<li><a href="/vendor/${vendor.id}/product/${product.sku}">${product.name}</a><strong>₹${(product.amountMinor / 100).toFixed(2)}</strong></li>`).join('');
  const style = vendor.tier === 3 ? 'urgent' : vendor.tier === 2 ? 'studio' : 'established';
  return `<!doctype html><html><head><title>${vendor.name}</title><style>body{font:16px system-ui;max-width:720px;margin:48px auto;color:#15202b}.urgent{background:#fff4e8;padding:28px;border:2px dashed #e26d32}.studio{border-left:8px solid #5d5fef;padding:24px}.established{border-top:5px solid #276749;padding:24px}li{display:flex;justify-content:space-between;padding:12px;border-bottom:1px solid #ddd}a{color:inherit}</style></head><body><main class="${style}"><p>Independent supplier catalogue</p><h1>${vendor.name}</h1><p>${vendor.tier === 3 ? 'Limited inventory. Prices refresh without notice.' : 'Business purchasing for repeat orders.'}</p><ul>${productRows}</ul></main></body></html>`;
};

export const createVendorSim = () => createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

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

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4100);
  createVendorSim().listen(port, () => console.log(`vendorsim listening on http://localhost:${port}`));
}
