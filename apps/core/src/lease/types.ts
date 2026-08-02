import type { Hex } from 'viem';

/**
 * A short-lived authorization envelope issued by the core.
 *
 * CLAUDE.md specifies the five returned fields `{ leaseId, expiresAtMs,
 * revocationEpoch, policyHash, signature }`. `agentId` is carried as well
 * because the signed digest binds the lease to a mandate and the mandate is
 * identified by its agent (see {@link mandateIdFor}) — without it,
 * `validateLease` could not recompute the digest it is supposed to check.
 */
export type Lease = {
  leaseId: string;
  /** The agent this lease was issued to; also the mandate binding. */
  agentId: string;
  expiresAtMs: number;
  revocationEpoch: number;
  policyHash: string;
  /** 65-byte core-key ECDSA signature over the raw lease digest. */
  signature: Hex;
};

/**
 * The mandate identity bound into the lease digest.
 *
 * INFERRED, not verified: CLAUDE.md's digest layout names a `mandateId`, but no
 * such field exists anywhere in the repo — not in MandateState, not in
 * PolicyModule.sol — and MandateState is part of the frozen evaluator, so a
 * field cannot be added to it. The mandate is one-per-agent in this system, so
 * the agent id is the only identifier available that actually identifies it.
 * Kept as its own function so a real mandate id can replace it in one place
 * without disturbing the digest layout.
 */
export function mandateIdFor(agentId: string): string {
  return agentId;
}

/** Thrown when a lease is refused because the mandate is revoked/frozen. The HTTP layer maps this to 409 REVOKED. */
export class RevokedError extends Error {
  readonly code = 'REVOKED' as const;
  constructor(message = 'mandate is frozen; refusing to issue a lease') {
    super(message);
    this.name = 'RevokedError';
  }
}

/** Thrown when a lease fails validation on a path that must not silently continue. */
export class LeaseInvalidError extends Error {
  readonly code = 'LEASE_INVALID' as const;
  constructor(message = 'lease failed validation') {
    super(message);
    this.name = 'LeaseInvalidError';
  }
}
