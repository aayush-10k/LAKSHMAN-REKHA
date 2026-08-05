import { encodeAbiParameters, keccak256, recoverAddress, toBytes, type Hex } from 'viem';
import { sign } from 'viem/accounts';
import { corePrivateKey, coreSignerAddress } from '../keys.js';
import type { PolicyState } from '../types.js';
import { LEASE_TTL_MS } from '../signing/constants.js';
import { mandateIdFor, RevokedError, type Lease } from './types.js';

export { RevokedError, LeaseInvalidError, mandateIdFor, type Lease } from './types.js';
export { LEASE_TTL_MS } from '../signing/constants.js';

// ---------------------------------------------------------------------------
//  Lease digest
// ---------------------------------------------------------------------------
//
// CLAUDE.md: keccak256(abi.encode(leaseId, mandateId, revocationEpoch,
// policyHash, expiresAtMs)).
//
// Nothing on chain verifies this signature — the lease is an off-chain
// authorization envelope, and PolicyModule only ever sees the derived
// `bytes32 leaseId` and `uint64 leaseExpiry` carried inside a PaymentRequest.
// The ABI types are therefore ours to fix, and they are fixed here:
//
//   (string leaseId, string mandateId, uint64 revocationEpoch,
//    string policyHash, uint64 expiresAtMs)
//
// leaseId / mandateId / policyHash go in as ABI `string` because that is what
// they are in TypeScript. policyHash especially: PolicyState types it
// `z.string()` with no format constraint (it is part of the frozen evaluator, so
// it cannot be re-typed) and it is not guaranteed to be 32-byte hex — the
// existing differential test passes ''. A bytes32 cast would reject or truncate
// those; `string` preserves whatever the mandate actually holds.

const LEASE_DIGEST_PARAMS = [
  { name: 'leaseId', type: 'string' },
  { name: 'mandateId', type: 'string' },
  { name: 'revocationEpoch', type: 'uint64' },
  { name: 'policyHash', type: 'string' },
  { name: 'expiresAtMs', type: 'uint64' },
] as const;

type LeaseDigestInput = Pick<
  Lease,
  'leaseId' | 'agentId' | 'revocationEpoch' | 'policyHash' | 'expiresAtMs'
>;

/** The raw 32-byte digest the core key signs for a lease. */
export function leaseDigest(lease: LeaseDigestInput): Hex {
  return keccak256(
    encodeAbiParameters(LEASE_DIGEST_PARAMS, [
      lease.leaseId,
      mandateIdFor(lease.agentId),
      BigInt(lease.revocationEpoch),
      lease.policyHash,
      BigInt(lease.expiresAtMs),
    ]),
  );
}

// ---------------------------------------------------------------------------
//  Lease id
// ---------------------------------------------------------------------------

/**
 * Monotonic counter feeding the lease id. Not a security value — it exists only
 * so two leases issued to the same agent within the same millisecond still get
 * distinct ids. The authority of a lease comes from its signature, and its
 * freshness from the epoch and expiry inside the signed digest.
 */
let issueCounter = 0;

/** `lse_` + 16 lower-hex chars, satisfying /^lse_[0-9a-f]{6,}$/. */
function nextLeaseId(agentId: string, nowMs: number): string {
  issueCounter += 1;
  const entropy = keccak256(toBytes(`${agentId}|${nowMs}|${issueCounter}`));
  return `lse_${entropy.slice(2, 18)}`;
}

// ---------------------------------------------------------------------------
//  Store
// ---------------------------------------------------------------------------

/**
 * In-memory issued-lease store, keyed by lease id. Deliberately not a database:
 * a lease lives 5 seconds and carries its own authority in its signature. The
 * map exists so an operator can see what was issued.
 */
const issued = new Map<string, Lease>();

export function getLease(leaseId: string): Lease | undefined {
  return issued.get(leaseId);
}

/** Number of leases currently retained. */
export function leaseStoreSize(): number {
  return issued.size;
}

/** Drops every stored lease. Does not revoke anything — revocation is the epoch. */
export function clearLeaseStore(): void {
  issued.clear();
}

// ---------------------------------------------------------------------------
//  Issue
// ---------------------------------------------------------------------------

/**
 * Issues a 5-second lease, signed by the core key.
 *
 * Fail-closed: a frozen mandate throws {@link RevokedError} (409 REVOKED at the
 * HTTP layer) rather than returning anything. There is no catch anywhere in this
 * function — if signing fails, the exception propagates and no lease exists.
 *
 * `nowMs` is a parameter, never `Date.now()`, so the issuer is deterministic and
 * testable at exact millisecond boundaries.
 */
export async function issueLease(
  agentId: string,
  mandateState: PolicyState,
  nowMs: number,
): Promise<Lease> {
  if (mandateState.frozen) {
    throw new RevokedError();
  }
  if (!Number.isInteger(nowMs)) {
    throw new RangeError('nowMs must be an integer number of milliseconds');
  }

  const unsigned: LeaseDigestInput = {
    leaseId: nextLeaseId(agentId, nowMs),
    agentId,
    // NOT the lease the running core issues. Requests go through
    // store.issueLease, which reads LEASE_TTL_MS from the environment and is
    // 15000 in every shipped configuration. This one is fixed at the 5000ms
    // constant and is exercised only by test/lease.test.ts, which asserts that
    // exact figure. Do not read the TTL from here.
    expiresAtMs: nowMs + LEASE_TTL_MS,
    revocationEpoch: mandateState.revocationEpoch,
    policyHash: mandateState.policyHash,
  };

  // Raw digest signing. NEVER signMessage: the EIP-191 prefix variant recovers to
  // a different address and reverts on chain with InvalidCoreSignature.
  const signature = await sign({
    hash: leaseDigest(unsigned),
    privateKey: corePrivateKey(),
    to: 'hex',
  });

  const lease: Lease = { ...unsigned, signature };
  issued.set(lease.leaseId, lease);
  return lease;
}

// ---------------------------------------------------------------------------
//  Validate
// ---------------------------------------------------------------------------

/**
 * Is this lease still good against the current mandate state?
 *
 * Returns false — never throws, never "mostly valid" — if any of:
 *  - the lease has expired (nowMs past expiresAtMs);
 *  - its revocation epoch no longer matches the mandate's (a revoke() staleness-
 *    kills every in-flight lease);
 *  - its policyHash no longer matches the mandate's (the policy was re-tuned
 *    under it);
 *  - the mandate is frozen (an issued lease does not survive a freeze);
 *  - the core signature does not recover to the core signer (a lease that was
 *    tampered with, or never signed by us, is not a lease).
 *
 * The first three are the checks CLAUDE.md names. The last two are additional
 * and can only ever turn a "yes" into a "no", which is the safe direction.
 */
export async function validateLease(
  lease: Lease,
  mandateState: PolicyState,
  nowMs: number,
): Promise<boolean> {
  try {
    // Expiry. `>` not `>=`, mirroring PolicyModule's `block.timestamp >
    // req.leaseExpiry`: the lease is still live at the exact expiry instant.
    if (nowMs > lease.expiresAtMs) return false;
    if (lease.revocationEpoch !== mandateState.revocationEpoch) return false;
    if (lease.policyHash !== mandateState.policyHash) return false;
    if (mandateState.frozen) return false;

    const recovered = await recoverAddress({ hash: leaseDigest(lease), signature: lease.signature });
    return recovered.toLowerCase() === coreSignerAddress().toLowerCase();
  } catch {
    // A malformed signature, an unconfigured key, anything at all: not valid.
    // This catch returns a boolean `false` only — it can never yield a lease,
    // a signature or an approval.
    return false;
  }
}
