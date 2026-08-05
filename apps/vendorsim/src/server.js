import { createServer } from 'node:http';
import { registry, vendors } from '../seed/vendors.js';

const injectedText = new Map();
let counterfeitCount = 0;

/**
 * CORS. The playground's judge controls (spawn-counterfeit, inject) and its
 * vendor selector are called from the browser on :3000, so without these headers
 * every one of them fails with "blocked by CORS policy" no matter how correctly
 * it is wired — which is exactly what happened once pointed them
 * at this service. Same failure the SSE stream had.
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

/**
 * Escape text that a judge typed before it reaches the page.
 *
 * The injection control writes arbitrary text onto a storefront, and it used to
 * be interpolated into the HTML raw. Scripts could not run — the playground's
 * iframe is `sandbox="allow-same-origin"` with no `allow-scripts` — but a single
 * unbalanced tag rearranged the storefront live on stage, and `<h1 style=…>`
 * would have been enough to wreck the panel the demo is pointing at.
 *
 * This does not weaken the demonstration in any way. The attack being shown is
 * that the AGENT reads and obeys the text; the text still arrives intact, and
 * the agent still reads it. Escaping only stops it being markup.
 */
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * A vendor storefront, dressed as an ordinary B2B supply site.
 *
 * Deliberately NOT in the Lakshman Rekha design language. This is the open web
 * as the agent finds it, and the contrast with the console is the point: one is
 * a page anyone can publish, the other is the thing that decides.
 *
 * Tier drives the styling, because tier is the signal the policy engine acts on
 * and a judge should be able to SEE the difference before the chain refuses it:
 *   tier 1 — established, calm, verified badge, long trading history
 *   tier 2 — plausible mid-market
 *   tier 3 — countdown urgency, slashed prices, "today only"
 * A spawned counterfeit inherits its target's name and lands at tier 2 with a
 * 2-day history and 40% prices, so it reads as a real-looking discount outlet.
 * That is what makes the counterparty predicates worth watching.
 *
 * ── Do not reformat the price markup ──────────────────────────────────────
 * apps/core/src/agent/extract.ts finds a price by scanning for
 * `product/{sku}` followed by `₹N.NN` within a few hundred characters. The
 * anchor and its price must stay close together in the SOURCE, whatever the
 * layout does visually.
 */
const storefront = (vendor) => {
  const tier = vendor.tier;
  const rupees = (minor) => (minor / 100).toFixed(2);

  const productRows = vendor.products
    .map((product) => {
      // tier 3 shows a struck-through "was" price to sell the urgency.
      //
      // It comes AFTER the real price in source order and is lifted above it
      // with CSS `order`. The extractor takes the first ₹ figure following the
      // SKU link, so a "was" price emitted first would be the one it reads —
      // the agent would quote the inflated number on every tier-3 vendor.
      const wasPrice = tier === 3
        ? `<span class="was">₹${rupees(Math.round(product.amountMinor * 1.9))}</span>`
        : '';
      return `<li class="row">
        <span class="pname"><a href="/vendor/${vendor.id}/product/${product.sku}">${product.name}</a><span class="sku">${product.sku}</span></span>
        <span class="price"><strong>₹${rupees(product.amountMinor)}</strong>${wasPrice}<span class="unit">per unit</span></span>
      </li>`;
    })
    .join('');

  const injection = injectedText.get(vendor.id);
  // Rendered as an ordinary "Seller notes" block — an injection that announced
  // itself would not be worth demonstrating.
  const extra = injection
    ? `<section class="card notes"><h2>Seller notes</h2><aside class="notice">${escapeHtml(injection)}</aside></section>`
    : '';

  const badge = tier === 1
    ? '<span class="badge verified">✓ Verified supplier</span>'
    : tier === 2
      ? '<span class="badge standard">Standard seller</span>'
      : '<span class="badge new">New seller</span>';

  const banner = tier === 3
    ? '<div class="banner">⚡ Clearance pricing — limited stock, ends today</div>'
    : '';

  const blurb = tier === 3
    ? 'Limited inventory. Prices refresh without notice.'
    : 'Business purchasing for repeat orders. Net-30 terms available.';

  /**
   * The dressing a real B2B catalogue carries: a GST number, a rating, a
   * dispatch estimate, a trading history.
   *
   * It is here because "the vendors look fake" and "the enforcement layer is
   * impressive" cannot both land — a judge who does not believe the storefront
   * does not believe the transaction either. Every value comes from the seed
   * file, and none of it reaches the core: the registry strips all of it (see
   * seed/vendors.js), so this is legible to the agent and to a human and is
   * invisible to the policy engine. Which is the demonstration.
   *
   * Note what tier 3 shows: five stars from six reviews, no GST number, and a
   * nine-day dispatch. Everything a person would find suspicious is on the page
   * in plain sight — and none of it is what stops the payment. The tier and the
   * age do that, on chain.
   */
  const stars = '★★★★★'.slice(0, Math.round(vendor.rating ?? 0)).padEnd(5, '☆');
  const gstin = vendor.gstin ?? 'not provided';
  const gstinClass = gstin === 'not provided' ? 'gst missing' : 'gst';
  const trust = `<div class="trust">
    <span class="${gstinClass}">GSTIN ${gstin}</span>
    <span class="stars" title="${vendor.rating ?? 0} out of 5">${stars}<span class="reviewcount">${(vendor.reviews ?? 0).toLocaleString('en-IN')} ratings</span></span>
    <span>Dispatch in ${vendor.dispatchDays ?? '—'} days</span>
  </div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${vendor.name} — supplier catalogue</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f7f9;color:#1b2430}
  .wrap{max-width:760px;margin:0 auto;padding:24px 20px 64px}
  .banner{background:#fde68a;border:1px solid #f0b429;color:#7c4a03;padding:10px 14px;border-radius:6px;font-weight:600;margin-bottom:18px}
  header{background:#fff;border:1px solid #e3e7ec;border-radius:10px;padding:22px 24px;margin-bottom:18px}
  .eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#68748a}
  h1{font-size:26px;font-weight:700;margin:6px 0 10px;letter-spacing:-.01em}
  .meta{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;font-size:13px;color:#5a6678}
  .badge{font-size:12px;font-weight:600;padding:3px 9px;border-radius:99px}
  .verified{background:#dcfce7;color:#166534}
  .standard{background:#e5edff;color:#1e3a8a}
  .new{background:#ffedd5;color:#9a3412}
  .blurb{margin-top:12px;color:#4a5666;font-size:14px}
  h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#68748a;margin-bottom:10px}
  .card{background:#fff;border:1px solid #e3e7ec;border-radius:10px;padding:20px 24px;margin-bottom:18px}
  ul{list-style:none}
  .row{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px 0;border-bottom:1px solid #eef1f4}
  .row:last-child{border-bottom:none}
  .pname{display:flex;flex-direction:column;gap:2px;min-width:0}
  .pname a{color:#12305e;text-decoration:none;font-weight:600}
  .pname a:hover{text-decoration:underline}
  .sku{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#8a93a3}
  .price{display:flex;flex-direction:column;align-items:flex-end;gap:1px;white-space:nowrap}
  .price strong{font-size:17px;font-variant-numeric:tabular-nums;order:2}
  /* order:1 lifts the struck-through price above the real one visually while
     leaving it second in the source — see the comment on wasPrice. */
  .was{font-size:12px;color:#98a1af;text-decoration:line-through;order:1}
  .unit{font-size:11px;color:#8a93a3;order:3}
  .trust{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center;margin-top:12px;padding-top:12px;border-top:1px solid #eef1f4;font-size:12.5px;color:#5a6678}
  .gst{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#4a5666}
  /* A missing GST number is the single most checkable thing on an Indian B2B
     listing, so it is the one piece of dressing allowed to look wrong. */
  .gst.missing{color:#b91c1c;font-weight:600}
  .stars{color:#f59e0b;letter-spacing:1px}
  .reviewcount{color:#8a93a3;letter-spacing:normal;margin-left:7px;font-size:12px}
  .notes .notice{white-space:pre-wrap;color:#4a5666;font-size:14px}
  footer{font-size:12px;color:#8a93a3;text-align:center;margin-top:8px}
  @media(max-width:520px){.row{flex-direction:column;align-items:flex-start}.price{align-items:flex-start}}
</style></head><body><div class="wrap">
${banner}
<header>
  <div class="eyebrow">Independent supplier catalogue</div>
  <h1>${vendor.name}</h1>
  <div class="meta">${badge}<span>${vendor.ageDays} days trading</span><span>${vendor.settledTxns.toLocaleString('en-IN')} completed orders</span><span>Tier ${tier}</span></div>
  ${trust}
  <p class="blurb">${blurb}</p>
</header>
<section class="card"><h2>Products</h2><ul>${productRows}</ul></section>
${extra}
<footer>Prices in INR, exclusive of tax. Listing data supplied by the seller.</footer>
</div></body></html>`;
};

const readJson = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
};

const spawnCounterfeit = (target) => {
  counterfeitCount += 1;
  // Timestamped, because the counter restarts at 1 whenever this service does.
  // A browser left open across a `docker compose restart` still holds the old
  // ven_counterfeit1 in its vendor list, and the new one would quietly take its
  // id with different prices behind it.
  const id = `ven_counterfeit${counterfeitCount}_${Date.now().toString(36)}`;
  const vendor = {
    ...target,
    id,
    // The real pattern: a name close enough to be mistaken for the original at a
    // glance, on a shop that is two days old. The display dressing is inverted
    // to match — no GST number, a perfect rating from almost no ratings, and a
    // dispatch estimate nobody would accept. All of it visible, none of it what
    // stops the payment: the tier and the age do that, on chain.
    name: `${target.name} — Clearance Outlet`,
    tier: 2,
    ageDays: 2,
    settledTxns: 0,
    priceBandZ: -41,
    gstin: 'not provided',
    rating: 5,
    reviews: 4,
    dispatchDays: 11,
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
