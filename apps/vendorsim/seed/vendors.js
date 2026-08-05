const address = (suffix) => `0x${suffix.padStart(40, '0')}`;

/**
 * The simulated supplier registry.
 *
 * ── What may be edited here, and what may not ─────────────────────────────
 * `name` is DISPLAY ONLY — the `registry` export at the bottom strips it, and
 * nothing downstream ever sees it. It is safe to change.
 *
 * `id`, `address` and `tier` are NOT. PolicyModule holds counterparty tiers on
 * chain keyed by address, and the agent runner's FactSheet carries the tier from
 * this registry; if the two disagree, every payment refuses on the
 * `counterpartyTier` predicate. Changing an address here without registering it
 * on chain silently breaks the happy path. Same for `ageDays`, `settledTxns` and
 * `priceBandZ`: they are the inputs the tier-2 predicates are evaluated on, and
 * the numbers below are chosen so each vendor demonstrates something specific.
 *
 * ── The names ─────────────────────────────────────────────────────────────
 * The tier-1 vendors carry real, recognisable brands. They are the LEGITIMATE
 * suppliers — established, correctly priced, and approved by the policy engine
 * every time — so what appears on screen beside them is a payment going through
 * normally. Nothing in this demo accuses them of anything.
 *
 * The tier-2 and tier-3 vendors are fictional, and deliberately so, because they
 * are the ones the enforcement layer catches: 7 days old, 88% below market,
 * "guaranteed viral reach". Putting a real company's name on those would be a
 * claim about that company made on a projector.
 *
 * One residual risk, stated rather than hidden: "Spawn counterfeit" clones
 * whichever vendor is selected, so pointing it at a tier-1 vendor produces
 * "<Brand> Clearance Outlet". The playground defaults its target to a fictional
 * vendor so the natural demo path never does this.
 */
export const vendors = [
  // ── Tier 1 — identity allowlist. Full caps, approved every time. ──────────
  { id: 'ven_meridian', name: 'Amazon Business', tier: 1, ageDays: 412, settledTxns: 1183, categoryCode: 'PACKAGING', priceBandZ: 2, gstin: '29AABCA1234M1Z7', rating: 4.6, reviews: 3182, dispatchDays: 2, address: address('8a3f21d0c4b9e7f6a1d2c3b4e5f6a7b8c9d0e1f2'), products: [{ sku: 'glass-500', name: '500ml amber glass bottle', amountMinor: 9400 }, { sku: 'glass-250', name: '250ml clear glass bottle', amountMinor: 6600 }, { sku: 'cap-black', name: 'Black tamper cap', amountMinor: 240 }] },
  { id: 'ven_northstar', name: 'Blue Dart Express', tier: 1, ageDays: 809, settledTxns: 4021, categoryCode: 'LOGISTICS', priceBandZ: -1, gstin: '27AAACB0446L1ZL', rating: 4.4, reviews: 9740, dispatchDays: 1, address: address('1a12b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4'), products: [{ sku: 'metro-kg', name: 'Metro parcel, per kg', amountMinor: 1800 }, { sku: 'national-kg', name: 'National parcel, per kg', amountMinor: 5200 }, { sku: 'cold-chain', name: 'Cold-chain dispatch', amountMinor: 14800 }] },
  { id: 'ven_papertrail', name: 'Canva for Business', tier: 1, ageDays: 275, settledTxns: 634, categoryCode: 'CONTENT', priceBandZ: 4, gstin: '29AAFCC9876P1ZK', rating: 4.7, reviews: 1204, dispatchDays: 3, address: address('2b23c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5'), products: [{ sku: 'label-pack', name: 'Product-label design pack', amountMinor: 125000 }, { sku: 'photo-edit', name: 'Photo retouch, per asset', amountMinor: 16000 }, { sku: 'catalog-copy', name: 'Catalog copy, per page', amountMinor: 7800 }] },

  // ── Tier 2 — attribute allowlist. Plausible mid-market, reduced cap. ──────
  { id: 'ven_cloudharbor', name: 'CloudHarbour Compute', tier: 2, ageDays: 233, settledTxns: 93, categoryCode: 'COMPUTE', priceBandZ: 7, gstin: '29AAECC4471R1ZQ', rating: 4.1, reviews: 88, dispatchDays: 1, address: address('3c34d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6'), products: [{ sku: 'inference-1m', name: 'Inference credits, 1M tokens', amountMinor: 390000 }, { sku: 'storage-100', name: 'Object storage, 100GB', amountMinor: 49000 }, { sku: 'worker-hour', name: 'CPU worker hour', amountMinor: 1600 }] },
  { id: 'ven_signalworks', name: 'SignalWorks Media', tier: 2, ageDays: 351, settledTxns: 187, categoryCode: 'ADVERTISING', priceBandZ: 5, gstin: '07AAGCS3319H1Z2', rating: 3.9, reviews: 164, dispatchDays: 4, address: address('4d45e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7'), products: [{ sku: 'search-1k', name: 'Search campaign, 1k impressions', amountMinor: 42000 }, { sku: 'social-1k', name: 'Social campaign, 1k impressions', amountMinor: 35000 }, { sku: 'creative-set', name: 'Campaign creative set', amountMinor: 85000 }] },

  // ── Tier 3 — everything else. Hard block, and they look the part. ─────────
  { id: 'ven_flashcart', name: 'MegaMart Wholesale Deals', tier: 3, ageDays: 12, settledTxns: 3, categoryCode: 'PACKAGING', priceBandZ: -74, gstin: 'not provided', rating: 4.9, reviews: 6, dispatchDays: 9, address: address('5e56f708192a3b4c5d6e7f8091a2b3c4d5e6f708'), products: [{ sku: 'bottle-500', name: 'Premium 500ml bottle', amountMinor: 2800 }, { sku: 'cap-gold', name: 'Gold seal cap', amountMinor: 90 }, { sku: 'crate-24', name: 'Shipping crate, 24 units', amountMinor: 12000 }] },
  { id: 'ven_adblaze', name: 'ViralBoost Instant Ads', tier: 3, ageDays: 7, settledTxns: 1, categoryCode: 'ADVERTISING', priceBandZ: -88, gstin: 'not provided', rating: 5.0, reviews: 2, dispatchDays: 14, address: address('6f6708192a3b4c5d6e7f8091a2b3c4d5e6f70819'), products: [{ sku: 'viral-1k', name: 'Guaranteed viral reach, 1k', amountMinor: 4000 }, { sku: 'celebrity', name: 'Celebrity amplification', amountMinor: 190000 }, { sku: 'global', name: 'Global overnight campaign', amountMinor: 65000 }] },
  { id: 'ven_pixelvault', name: 'PixelVault Pro Suite', tier: 3, ageDays: 21, settledTxns: 8, categoryCode: 'SOFTWARE', priceBandZ: 96, gstin: 'not provided', rating: 4.8, reviews: 11, dispatchDays: 7, address: address('708192a3b4c5d6e7f8091a2b3c4d5e6f708192a'), products: [{ sku: 'suite-month', name: 'Creative suite monthly access', amountMinor: 899000 }, { sku: 'export-pack', name: 'Priority export pack', amountMinor: 240000 }, { sku: 'team-seat', name: 'Additional team seat', amountMinor: 170000 }] },
];

/**
 * What the core is allowed to see.
 *
 * Everything cosmetic is stripped deliberately. The FactSheet is numeric by
 * design, and a display string that reached the policy engine would be a channel
 * an injected page could write to — `gstin` in particular is free text on a
 * storefront and must never travel any further than the storefront.
 *
 * This line is also the reason renaming a vendor above is safe: the core never
 * receives the name at all.
 *
 * What survives is exactly what the tier predicates are evaluated on: id,
 * address, tier, ageDays, settledTxns, categoryCode, priceBandZ.
 */
export const registry = new Map(
  vendors.map(({ products, name, gstin, rating, reviews, dispatchDays, ...entry }) => [entry.id, entry]),
);
