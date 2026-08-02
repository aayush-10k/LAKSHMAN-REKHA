import { describe, it, expect, beforeEach } from 'vitest';
import { recoverAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  issueLease,
  validateLease,
  leaseDigest,
  getLease,
  clearLeaseStore,
  RevokedError,
  LEASE_TTL_MS,
} from '../src/lease/index.js';
import { setCoreKey, resetKeys } from '../src/keys.js';
import { mandateState, TEST_CORE_PK, WRONG_PK } from './fixtures.js';

const T0 = 1_785_657_000_000; // arbitrary fixed instant, in ms

beforeEach(() => {
  resetKeys();
  clearLeaseStore();
  setCoreKey(TEST_CORE_PK);
});

describe('A6 issueLease', () => {
  it('mints an id matching /^lse_[0-9a-f]{6,}$/', async () => {
    const lease = await issueLease('agent-1', mandateState(), T0);
    expect(lease.leaseId).toMatch(/^lse_[0-9a-f]{6,}$/);
  });

  it('sets the TTL to exactly 5000ms', async () => {
    const lease = await issueLease('agent-1', mandateState(), T0);
    expect(LEASE_TTL_MS).toBe(5000);
    expect(lease.expiresAtMs).toBe(T0 + 5000);
    expect(lease.expiresAtMs - T0).toBe(5000);
  });

  it('copies the mandate revocation epoch and policy hash', async () => {
    const m = mandateState({ revocationEpoch: 7, policyHash: '0xdeadbeef' });
    const lease = await issueLease('agent-1', m, T0);
    expect(lease.revocationEpoch).toBe(7);
    expect(lease.policyHash).toBe('0xdeadbeef');
  });

  it('signs with the core key over the raw lease digest', async () => {
    const lease = await issueLease('agent-1', mandateState(), T0);
    const recovered = await recoverAddress({
      hash: leaseDigest(lease),
      signature: lease.signature,
    });
    expect(recovered).toBe(privateKeyToAccount(TEST_CORE_PK).address);
    // 65-byte r||s||v
    expect(lease.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('issues distinct ids for the same agent at the same instant', async () => {
    const a = await issueLease('agent-1', mandateState(), T0);
    const b = await issueLease('agent-1', mandateState(), T0);
    expect(a.leaseId).not.toBe(b.leaseId);
  });

  it('stores what it issued', async () => {
    const lease = await issueLease('agent-1', mandateState(), T0);
    expect(getLease(lease.leaseId)).toEqual(lease);
    expect(getLease('lse_000000')).toBeUndefined();
  });

  it('does not read the clock: the same nowMs gives the same expiry', async () => {
    const a = await issueLease('agent-1', mandateState(), T0);
    const b = await issueLease('agent-2', mandateState(), T0);
    expect(a.expiresAtMs).toBe(b.expiresAtMs);
  });

  // --- fail closed --------------------------------------------------------

  it('throws RevokedError for a frozen mandate and issues nothing', async () => {
    const before = getLease('anything');
    await expect(issueLease('agent-1', mandateState({ frozen: true }), T0)).rejects.toBeInstanceOf(
      RevokedError,
    );
    expect(before).toBeUndefined();
  });

  it('RevokedError carries the code the HTTP layer maps to 409', async () => {
    const err = await issueLease('agent-1', mandateState({ frozen: true }), T0).catch((e) => e);
    expect(err).toBeInstanceOf(RevokedError);
    expect(err.code).toBe('REVOKED');
  });

  it('refuses to sign when no core key is configured', async () => {
    resetKeys();
    await expect(issueLease('agent-1', mandateState(), T0)).rejects.toThrow(/not configured/);
  });
});

describe('A6 validateLease', () => {
  it('accepts a fresh lease', async () => {
    const m = mandateState();
    const lease = await issueLease('agent-1', m, T0);
    expect(await validateLease(lease, m, T0)).toBe(true);
  });

  it('still accepts at the exact expiry instant', async () => {
    const m = mandateState();
    const lease = await issueLease('agent-1', m, T0);
    expect(await validateLease(lease, m, T0 + 5000)).toBe(true);
  });

  it('rejects a lease older than 5s', async () => {
    const m = mandateState();
    const lease = await issueLease('agent-1', m, T0);
    expect(await validateLease(lease, m, T0 + 5001)).toBe(false);
    expect(await validateLease(lease, m, T0 + 6000)).toBe(false);
    expect(await validateLease(lease, m, T0 + 60_000)).toBe(false);
  });

  it('rejects a lease with a stale revocation epoch', async () => {
    const atIssue = mandateState({ revocationEpoch: 3 });
    const lease = await issueLease('agent-1', atIssue, T0);
    expect(await validateLease(lease, atIssue, T0)).toBe(true);

    // owner or guardian called revoke() in the meantime
    const afterRevoke = mandateState({ revocationEpoch: 4 });
    expect(await validateLease(lease, afterRevoke, T0)).toBe(false);
  });

  it('rejects a lease whose policy hash no longer matches', async () => {
    const atIssue = mandateState();
    const lease = await issueLease('agent-1', atIssue, T0);
    const afterSetPolicy = mandateState({ policyHash: '0x' + 'ff'.repeat(32) });
    expect(await validateLease(lease, afterSetPolicy, T0)).toBe(false);
  });

  it('rejects once the mandate is frozen', async () => {
    const m = mandateState();
    const lease = await issueLease('agent-1', m, T0);
    expect(await validateLease(lease, mandateState({ frozen: true }), T0)).toBe(false);
  });

  it('rejects a lease signed by the wrong key', async () => {
    const m = mandateState();
    const lease = await issueLease('agent-1', m, T0);
    setCoreKey(WRONG_PK); // core key rotated; the old lease no longer recovers
    expect(await validateLease(lease, m, T0)).toBe(false);
  });

  it('rejects a lease whose fields were edited after signing', async () => {
    const m = mandateState();
    const lease = await issueLease('agent-1', m, T0);
    const stretched = { ...lease, expiresAtMs: lease.expiresAtMs + 3_600_000 };
    expect(await validateLease(stretched, m, T0)).toBe(false);
  });

  it('returns false rather than throwing on a malformed signature', async () => {
    const m = mandateState();
    const lease = await issueLease('agent-1', m, T0);
    const junk = { ...lease, signature: '0xnotasignature' as Hex };
    await expect(validateLease(junk, m, T0)).resolves.toBe(false);
  });
});
