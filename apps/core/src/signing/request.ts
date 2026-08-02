import { encodeAbiParameters, getAddress, keccak256, toBytes, type Address, type Hex } from 'viem';
import { CATEGORY_INDEX, type PolicyFactSheet, type PolicyState } from '../types.js';
import type { Lease } from '../lease/types.js';
import {
  CHAIN_ID,
  PAYMENT_REQUEST_COMPONENTS,
  POLICY_MODULE_ADDRESS,
  type PaymentRequestStruct,
} from './constants.js';

/**
 * The `bytes32 leaseId` the on-chain struct carries, derived from the off-chain
 * `lse_...` string id.
 *
 * keccak256 of the UTF-8 bytes rather than a right-padded `bytes32` cast: the
 * lease id is `lse_` + at least 6 hex chars with no upper bound, so a cast would
 * silently truncate a long id and make two different leases collide on chain.
 */
export function leaseIdToBytes32(leaseId: string): Hex {
  return keccak256(toBytes(leaseId));
}

/**
 * Assembles the on-chain PaymentRequest.
 *
 * Field order comes from src/PaymentRequest.sol (see PAYMENT_REQUEST_COMPONENTS).
 * Unit conversions worth naming:
 *  - `leaseExpiry` is UNIX *seconds* (it is compared against `block.timestamp`),
 *    while the lease carries milliseconds. Floor, never round: rounding up would
 *    hand the chain an expiry later than the lease actually grants.
 *  - `categoryCode` is the integer bit index of the category string, which is
 *    what PolicyModule._categoryPermitted shifts by.
 *
 * This function only assembles. It does not decide anything — every fail-closed
 * check lives in coreSign, which is the only caller allowed to produce a
 * signature.
 */
export function buildPaymentRequest(
  factSheet: PolicyFactSheet,
  mandateState: PolicyState,
  lease: Lease,
  coreImageDigest: Hex,
): PaymentRequestStruct {
  const categoryCode = CATEGORY_INDEX[factSheet.categoryCode];
  if (categoryCode === undefined) {
    throw new Error(`unknown categoryCode ${factSheet.categoryCode}`);
  }

  return {
    amountMinor: BigInt(factSheet.amountMinor),
    counterparty: getAddress(factSheet.counterpartyId),
    counterpartyTier: factSheet.counterpartyTier,
    counterpartyAgeDays: factSheet.counterpartyAgeDays,
    counterpartySettledTxns: factSheet.counterpartySettledTxns,
    priceBandZ: factSheet.priceBandZ,
    categoryCode,
    leaseId: leaseIdToBytes32(lease.leaseId),
    nonce: BigInt(factSheet.nonce),
    revocationEpoch: BigInt(lease.revocationEpoch),
    leaseExpiry: BigInt(Math.floor(lease.expiresAtMs / 1000)),
    coreImageDigest,
  };
}

/** Where a request is being signed for: the two values the digest domain-separates on. */
export type PolicyTarget = { chainId: bigint; policyAddress: Address };

/** The pinned Base Sepolia deployment (CLAUDE.md). */
export const DEPLOYED_TARGET: PolicyTarget = {
  chainId: CHAIN_ID,
  policyAddress: POLICY_MODULE_ADDRESS,
};

/**
 * The digest both key shares sign: `keccak256(abi.encode(84532,
 * POLICY_MODULE_ADDRESS, req))`.
 *
 * Byte-for-byte identical to PolicyModule._digest. `test/hash-request.fork.test.ts`
 * proves that against the actually-deployed contract on a Base Sepolia fork —
 * if that test ever fails, every signature this service produces reverts with
 * InvalidCoreSignature, so treat it as the canary it is.
 *
 * `target` defaults to the pinned deployment. It exists so a test can point at a
 * freshly deployed PolicyModule (which lives at a different address and therefore
 * has a different digest); production callers pass nothing.
 */
export function hashRequest(req: PaymentRequestStruct, target: PolicyTarget = DEPLOYED_TARGET): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: 'chainId', type: 'uint256' },
        { name: 'policy', type: 'address' },
        { name: 'req', type: 'tuple', components: PAYMENT_REQUEST_COMPONENTS },
      ],
      [target.chainId, target.policyAddress, req],
    ),
  );
}
