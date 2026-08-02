import type { Address, Hex } from 'viem';

// ---------------------------------------------------------------------------
//  Deployment pins (Base Sepolia). Source: CLAUDE.md.
// ---------------------------------------------------------------------------
//
// The digest both key shares sign mixes in the chain id and the PolicyModule
// address (PolicyModule._digest -> keccak256(abi.encode(block.chainid,
// address(this), req))). Those two values are the domain separation: a request
// signed for this deployment cannot be replayed on another chain or against a
// different PolicyModule. They are therefore pinned constants, not config —
// getting either wrong makes every signature revert with InvalidCoreSignature.

export const CHAIN_ID = 84532n;

export const INRX_ADDRESS = '0x9df2d451d682971878d09ba13920ca418697272d' as Address;
export const POLICY_MODULE_ADDRESS = '0x933bb10252ec2b133f28b7d5edf1d303c3384d87' as Address;
export const REKHA_ACCOUNT_ADDRESS = '0xd65122eafeb2e6f384d0095bac7de6f662276f6c' as Address;

/** Expected recoverable address of the core key share (predicate 2). */
export const CORE_SIGNER_ADDRESS = '0xB18D311dcfA7F1700bEf8245Aa3100b3E3dAdf6B' as Address;
/** Expected recoverable address of the agent key share (predicate 1). */
export const AGENT_SIGNER_ADDRESS = '0x6E19cA2B53986EAEeE638412A4051651a64a00d5' as Address;

/** The lease TTL, in milliseconds. Exact, not a floor or a default. */
export const LEASE_TTL_MS = 5_000;

export const ZERO_BYTES32 = ('0x' + '00'.repeat(32)) as Hex;

// ---------------------------------------------------------------------------
//  PaymentRequest ABI tuple
// ---------------------------------------------------------------------------
//
// Field order is copied from src/PaymentRequest.sol and MUST match it exactly:
// abi.encode of a struct is positional, so a single transposed field produces a
// different digest and every signature reverts. Read the Solidity source, not a
// doc, before changing anything here.
//
//   struct PaymentRequest {
//       uint256 amountMinor;
//       address counterparty;
//       uint8   counterpartyTier;
//       uint16  counterpartyAgeDays;
//       uint32  counterpartySettledTxns;
//       int8    priceBandZ;
//       uint8   categoryCode;
//       bytes32 leaseId;
//       uint64  nonce;
//       uint64  revocationEpoch;
//       uint64  leaseExpiry;
//       bytes32 coreImageDigest;
//   }

export const PAYMENT_REQUEST_COMPONENTS = [
  { name: 'amountMinor', type: 'uint256' },
  { name: 'counterparty', type: 'address' },
  { name: 'counterpartyTier', type: 'uint8' },
  { name: 'counterpartyAgeDays', type: 'uint16' },
  { name: 'counterpartySettledTxns', type: 'uint32' },
  { name: 'priceBandZ', type: 'int8' },
  { name: 'categoryCode', type: 'uint8' },
  { name: 'leaseId', type: 'bytes32' },
  { name: 'nonce', type: 'uint64' },
  { name: 'revocationEpoch', type: 'uint64' },
  { name: 'leaseExpiry', type: 'uint64' },
  { name: 'coreImageDigest', type: 'bytes32' },
] as const;

/** The on-chain PaymentRequest struct, as viem encodes it. */
export type PaymentRequestStruct = {
  amountMinor: bigint;
  counterparty: Address;
  counterpartyTier: number;
  counterpartyAgeDays: number;
  counterpartySettledTxns: number;
  priceBandZ: number;
  categoryCode: number;
  leaseId: Hex;
  nonce: bigint;
  revocationEpoch: bigint;
  leaseExpiry: bigint;
  coreImageDigest: Hex;
};
