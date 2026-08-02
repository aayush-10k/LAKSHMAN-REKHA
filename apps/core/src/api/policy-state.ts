/**
 * Adapter: B's API-side records -> A's evaluator input.
 *
 * The two type families are deliberately separate (see the reconciliation note
 * in src/types.ts). This is the one place that converts between them, so the
 * unit mismatches — milliseconds on the API side, UNIX seconds on the evaluator
 * side — are handled once instead of at every call site.
 */

import {
  CATEGORY_INDEX,
  type CategoryCode,
  type FactSheet,
  type MandateState,
  type PolicyFactSheet,
  type PolicyState,
} from '../types.js';
import type { LeaseRecord } from './store.js';

/** Tier as the vendor registry reports it; 0 means unknown, which is blocked. */
export type RegistryTier = 0 | 1 | 2 | 3;

/**
 * The core's attested image, as the 32-byte value the chain compares.
 *
 * Defaults to the digest the deployed PolicyModule actually holds (0x01 followed
 * by 31 zero bytes — see test/fixtures.ts DEPLOYED_IMAGE). A non-hex
 * CORE_IMAGE_DIGEST is rejected rather than coerced: predicate 3 compares this
 * for equality, so a silently mangled value would fail every payment with a
 * confusing CoreImageMismatch.
 */
export function coreImageDigestHex(): string {
  const raw = process.env['CORE_IMAGE_DIGEST'];
  if (raw === undefined || raw === '') return '0x01' + '00'.repeat(31);
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error('CORE_IMAGE_DIGEST must be a 32-byte 0x-prefixed hex string');
  }
  return raw.toLowerCase();
}

/** API.md's `CategoryCode[]` -> the on-chain allow-list bitmap. */
export function categoryBitmap(permitted: readonly CategoryCode[]): bigint {
  let bits = 0n;
  for (const code of permitted) {
    const index = CATEGORY_INDEX[code];
    if (index !== undefined) bits |= 1n << BigInt(index);
  }
  return bits;
}

/** Attaches the core's own attested image to a validated FactSheet. */
export function toPolicyFactSheet(factSheet: FactSheet): PolicyFactSheet {
  return { ...factSheet, coreImageDigest: coreImageDigestHex() };
}

/**
 * Builds the evaluator's view of the world for one request.
 *
 * `registry` is authoritative for counterparty tier (predicate 8) — it must come
 * from the vendor registry, never from the FactSheet, or the counterfeit-
 * storefront attack works. An address absent from the map evaluates as tier 0,
 * which the evaluator blocks.
 */
export function toPolicyState(
  mandate: MandateState,
  lease: LeaseRecord,
  registry: Map<string, RegistryTier>,
  usedNonces: Set<number>,
): PolicyState {
  return {
    perTxCapMinor: mandate.perTxCapMinor,
    windowCapMinor: mandate.windowCapMinor,
    windowSeconds: mandate.windowSeconds,
    cumulativeCapMinor: mandate.cumulativeCapMinor,
    permittedCategories: categoryBitmap(mandate.permittedCategories),
    tier2MinAgeDays: mandate.tier2MinAgeDays,
    tier2MinSettledTxns: mandate.tier2MinSettledTxns,
    tier2MaxPriceBandZ: mandate.tier2MaxPriceBandZ,
    tier2CapMinor: mandate.tier2CapMinor,

    coreImageDigest: coreImageDigestHex(),

    revocationEpoch: mandate.revocationEpoch,
    // ms -> s. Floor, never round: rounding up would place the window start in
    // the future and make effectiveWindowSpent() drop real spend.
    windowStart: Math.floor(mandate.windowStartMs / 1000),
    windowSpentMinor: mandate.windowSpentMinor,
    cumulativeSpentMinor: mandate.cumulativeSpentMinor,
    usedNonces,

    lastHeartbeat: Math.floor(mandate.lastHeartbeatMs / 1000),
    deadmanSeconds: mandate.deadmanSeconds,
    frozen: mandate.frozen,

    counterpartyRegistry: new Map(registry),

    // The per-request envelope. These come from the lease, not the mandate:
    // coreSign cross-checks both against the lease and refuses on any mismatch.
    requestRevocationEpoch: lease.revocationEpoch,
    leaseExpiryS: Math.floor(lease.expiresAtMs / 1000),

    policyHash: mandate.policyHash,
  };
}
