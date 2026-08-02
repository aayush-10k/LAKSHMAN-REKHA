import type { Hex } from 'viem';
import type { PolicyFactSheet, PolicyState } from '../src/types.js';

/**
 * Shared fixtures for the A6/A7 tests.
 *
 * The defaults mirror the deployed Base Sepolia PolicyModule (read off the fork
 * on 2 Aug 2026) so the unit tests and the on-chain tests are describing the
 * same world: perTxCap 1_000_000, windowCap 10_000_000, cumulativeCap
 * 100_000_000, permittedCategories 128 (bit 7 = OTHER only), coreImageDigest
 * 0x01 followed by 31 zero bytes.
 */

export const TEST_CORE_PK = ('0x' + '22'.repeat(32)) as Hex;
export const TEST_AGENT_PK = ('0x' + '11'.repeat(32)) as Hex;
export const WRONG_PK = ('0x' + '33'.repeat(32)) as Hex;

/** The approved core image on the deployed PolicyModule. */
export const DEPLOYED_IMAGE = ('0x01' + '00'.repeat(31)) as Hex;

export const TIER1_COUNTERPARTY = '0x' + 'a1'.repeat(20);
export const TIER2_COUNTERPARTY = '0x' + 'b2'.repeat(20);

export function factSheet(over: Partial<PolicyFactSheet> = {}): PolicyFactSheet {
  return {
    amountMinor: 940_000, // ₹9,400
    currency: 'INR',
    categoryCode: 'OTHER', // index 7 — the only bit set in permittedCategories
    counterpartyId: TIER1_COUNTERPARTY,
    counterpartyTier: 1,
    counterpartyAgeDays: 400,
    counterpartySettledTxns: 120,
    priceBandZ: 0,
    coreImageDigest: DEPLOYED_IMAGE.toLowerCase(),
    taskId: 'tsk_abcdef',
    lineItemId: 'li_abcdef_01',
    leaseId: 'lse_abcdef',
    nonce: 1,
    ...over,
  };
}

export function mandateState(over: Partial<PolicyState> = {}): PolicyState {
  return {
    perTxCapMinor: 1_000_000,
    windowCapMinor: 10_000_000,
    windowSeconds: 86_400,
    cumulativeCapMinor: 100_000_000,
    permittedCategories: 128n, // bit 7 only
    tier2MinAgeDays: 30,
    tier2MinSettledTxns: 5,
    tier2MaxPriceBandZ: 2,
    tier2CapMinor: 500_000,
    coreImageDigest: DEPLOYED_IMAGE.toLowerCase(),
    revocationEpoch: 0,
    windowStart: 0,
    windowSpentMinor: 0,
    cumulativeSpentMinor: 0,
    usedNonces: new Set<number>(),
    lastHeartbeat: 0,
    deadmanSeconds: 0, // disabled unless a test says otherwise
    frozen: false,
    counterpartyRegistry: new Map<string, number>([
      [TIER1_COUNTERPARTY, 1],
      [TIER2_COUNTERPARTY, 2],
    ]),
    requestRevocationEpoch: 0,
    leaseExpiryS: 0,
    policyHash: '0x7994236ca1cbe9890f5c118fd307afc36d0ea865d558c8112c030e702b3a7078',
    ...over,
  };
}
