import { randomBytes } from 'node:crypto';

/**
 * Turns what the owner typed into a plan of real, purchasable line items.
 *
 * ── What was wrong before ─────────────────────────────────────────────────
 * This module invented prices. `procure` was hardcoded to
 * `firstNumberInTheString * 9400 + 12000`, always against `ven_meridian`,
 * regardless of what was asked for. So "buy 2 chips for 5 rs" produced a ₹308
 * payment to a packaging supplier: the "5 rs" was never read, "chips" was never
 * looked up, and the 2 was multiplied by a constant that exists nowhere in the
 * system. Every other kind had its own invented formula.
 *
 * That is worse than a limitation, it is a credibility problem. The enforcement
 * underneath is real and on chain, but a demo where any sentence yields an
 * unrelated purchase at a made-up price reads as though the whole thing is
 * staged.
 *
 * ── What it does now ──────────────────────────────────────────────────────
 * Prices come from the vendor registry's own product list and nowhere else.
 * The description is matched against real SKUs; the amount is
 * `quantity * product.amountMinor` in integer paise. If nothing in the registry
 * matches, the plan is EMPTY and the reason is stated — the agent does not buy
 * something adjacent because it could not find what was asked for.
 *
 * The registry is passed in rather than fetched here so this module stays pure
 * and testable. No catalog means no plan: fail closed, never a guess.
 *
 * A LineItem's `description` remains display-only and MUST NEVER be copied into
 * a FactSheet — the policy engine reads numbers and codes, never prose.
 */

const hex = () => randomBytes(3).toString('hex');

export class SimulationClock {
  constructor(speed = 40_000) { this.speed = speed; this.startedAt = Date.now(); }
  elapsed() { return Math.floor((Date.now() - this.startedAt) * this.speed); }
}

/**
 * The kind of work being asked for.
 *
 * Still keyword-based, but it no longer decides the price or the vendor. It is
 * now only a tie-breaker: when a description matches products in more than one
 * category, the one matching the stated intent wins.
 */
export const taskKindFor = (description) => {
  const text = description.toLowerCase();
  if (/advert|campaign|impression|audience/.test(text)) return 'ads';
  if (/image|copy|content|photo|design/.test(text)) return 'content';
  if (/api|token|compute|cloud|inference/.test(text)) return 'compute';
  if (/ship|deliver|freight|cities/.test(text)) return 'logistics';
  if (/renew|subscription|monthly|tooling/.test(text)) return 'subscription';
  return 'procure';
};

const CATEGORY_FOR_KIND = {
  procure: 'PACKAGING',
  ads: 'ADVERTISING',
  content: 'CONTENT',
  compute: 'COMPUTE',
  logistics: 'LOGISTICS',
  subscription: 'SOFTWARE',
};

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'to', 'and', 'or', 'with', 'from', 'at', 'in', 'on',
  'buy', 'order', 'get', 'purchase', 'need', 'want', 'please', 'some', 'me', 'my', 'our', 'us',
  'rs', 'rupees', 'rupee', 'inr', 'each', 'per', 'unit', 'units', 'worth',
]);

/** Lowercase word tokens, punctuation dropped, naive singularisation. */
const tokenise = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));

/**
 * Remove money mentions before reading a quantity.
 *
 * "buy 2 chips for 5 rs" must yield 2, not 5. The old planner took the first
 * integer in the string with no notion that some integers are prices.
 */
const stripMoney = (s) =>
  String(s)
    .replace(/(?:₹|rs\.?|inr)\s*\d[\d,]*(?:\.\d+)?/gi, ' ')
    .replace(/\b\d[\d,]*(?:\.\d+)?\s*(?:₹|rs\.?|rupees?|inr)\b/gi, ' ');

const quantityFor = (description) => {
  const m = stripMoney(description).match(/\b(\d[\d,]*)\b/);
  if (!m) return 1;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isInteger(n) && n > 0 ? n : 1;
};

/**
 * How many of the underlying thing one unit of this SKU covers.
 *
 * "Search campaign, 1k impressions" is sold per thousand and "Inference
 * credits, 1M tokens" per million. Without this, asking for 5000 impressions
 * bought 5000 *campaigns* — ₹21,00,000 instead of ₹2,100 — because the quantity
 * was read in impressions and spent in units.
 *
 * Only applied when the request is at least one whole pack, so "buy 2 API
 * credits" still means 2 units rather than being rounded to nothing.
 */
const packSizeOf = (product) => {
  const m = String(product.name).match(/\b(\d+)\s*([kKmM])\b/);
  if (!m) return 1;
  return Number(m[1]) * (m[2].toLowerCase() === 'k' ? 1_000 : 1_000_000);
};

const unitsFor = (rawQuantity, product) => {
  const pack = packSizeOf(product);
  if (pack <= 1 || rawQuantity < pack) return rawQuantity;
  return Math.ceil(rawQuantity / pack);
};

/**
 * How well a product answers the description.
 *
 * Product name and SKU are the strong signal; the vendor's own name and its
 * category are weaker ones, so "something from Meridian" still finds a product
 * without outranking an exact item match.
 */
const scoreProduct = (descTokens, vendor, product) => {
  const strong = new Set([...tokenise(product.name), ...tokenise(String(product.sku).replace(/-/g, ' '))]);
  const weak = new Set([...tokenise(vendor.name), ...tokenise(vendor.categoryCode)]);

  let score = 0;
  for (const t of descTokens) {
    if (strong.has(t)) score += 3;
    else if (weak.has(t)) score += 1;
  }
  return score;
};

/**
 * The best line item for this description, or null when nothing matches.
 *
 * ── Ties break toward the CHEAPEST vendor, and that is deliberate ─────────
 * This is a buying agent: among products that equally answer the request, it
 * takes the lowest price. That is the correct, boring thing for it to do, and
 * it is also what walks it straight into a counterfeit storefront — a lookalike
 * cloned from a real vendor at 40% of its prices, aged 2 days.
 *
 * It used to break ties toward the LOWER tier, which quietly made the whole
 * counterfeit demo unreachable: a spawned fake carries its target's product
 * names, so it always tied on score and always lost to the tier-1 original.
 * The judge could press "Spawn counterfeit storefront" and watch the agent buy
 * from the real vendor anyway.
 *
 * Nothing here checks whether a vendor is trustworthy, on purpose. BUILD.md:174
 * — "an identity allowlist is a subscription control, not a commerce control;
 * an agent whose job is finding vendors cannot run on one." The agent is
 * supposed to find the cheap deal. Whether that deal is admissible is decided
 * by the counterparty predicates on chain, not by the shopper.
 */
const bestMatch = (description, catalog, preferredCategory) => {
  const descTokens = tokenise(description);
  if (descTokens.length === 0) return null;

  let best = null;
  for (const vendor of catalog) {
    for (const product of vendor.products ?? []) {
      const score = scoreProduct(descTokens, vendor, product);
      if (score === 0) continue;

      const candidate = { vendor, product, score };
      if (best === null) { best = candidate; continue; }

      if (score !== best.score) {
        if (score > best.score) best = candidate;
        continue;
      }
      // Same relevance: prefer the category actually asked for, then the
      // cheaper unit price. Price is the lure.
      const categoryEdge =
        Number(vendor.categoryCode === preferredCategory) -
        Number(best.vendor.categoryCode === preferredCategory);
      if (categoryEdge > 0) { best = candidate; continue; }
      if (categoryEdge === 0 && product.amountMinor < best.product.amountMinor) best = candidate;
    }
  }
  return best;
};

/**
 * @param {object}   input
 * @param {string}   input.description  what the owner typed. Display only.
 * @param {string}   input.mode         behaviour mode
 * @param {Array}    [input.catalog]    the vendor registry's /catalog response
 * @returns {{taskId: string, plan: Array, kind: string, simElapsedMs: number, note: string|null}}
 *   `plan` is empty when nothing could be matched, and `note` says why in the
 *   owner's language. An empty plan must never be treated as a silent success.
 */
export const createTask = ({ description, mode, catalog }, clock = new SimulationClock()) => {
  if (typeof description !== 'string' || !description.trim()) throw new Error('description is required');
  if (!['normal', 'hallucinating', 'injected', 'compromised', 'overreach', 'colluding'].includes(mode)) {
    throw new Error('mode is invalid');
  }

  const kind = taskKindFor(description);
  const taskId = `tsk_${hex()}`;
  const base = { taskId, kind, simElapsedMs: clock.elapsed() };

  if (!Array.isArray(catalog) || catalog.length === 0) {
    return {
      ...base,
      plan: [],
      note: 'The vendor registry could not be read, so nothing was priced and no payment was requested.',
    };
  }

  const match = bestMatch(description, catalog, CATEGORY_FOR_KIND[kind]);
  if (match === null) {
    return {
      ...base,
      plan: [],
      note: `Nothing in the vendor registry matches "${description.trim()}". No payment was requested.`,
    };
  }

  const { vendor, product } = match;
  const qty = unitsFor(quantityFor(description), product);

  return {
    ...base,
    plan: [
      {
        lineItemId: `li_${taskId.slice(4)}_01`,
        vendorId: vendor.id,
        categoryCode: vendor.categoryCode,
        // What the agent will look for when it opens the vendor's page. The
        // price is NOT taken from here — the agent reads it off the live
        // storefront, so an injected or counterfeit page changes the quote.
        sku: product.sku,
        productName: product.name,
        quantity: qty,
        // Integer paise throughout: a real unit price from the registry times a
        // whole quantity. No float maths, and no constant invented here.
        estimatedAmountMinor: qty * product.amountMinor,
        description: `${qty} × ${product.name} (${product.sku}) from ${vendor.name}`,
      },
    ],
    note: null,
  };
};
