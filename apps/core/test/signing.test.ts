import { describe, it, expect, beforeEach } from 'vitest';
import { getAddress, keccak256, recoverAddress, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { issueLease, clearLeaseStore, LeaseInvalidError, type Lease } from '../src/lease/index.js';
import { setCoreKey, setAgentKey, resetKeys } from '../src/keys.js';
import { buildPaymentRequest, hashRequest, leaseIdToBytes32 } from '../src/signing/request.js';
import { agentSign, coreSign } from '../src/signing/sign.js';
import type { FactSheet, MandateState } from '../src/types.js';
import {
  factSheet,
  mandateState,
  TEST_AGENT_PK,
  TEST_CORE_PK,
  TIER1_COUNTERPARTY,
  TIER2_COUNTERPARTY,
} from './fixtures.js';

const T0 = 1_785_657_000_000;
const T0_S = T0 / 1000;

beforeEach(() => {
  resetKeys();
  clearLeaseStore();
  setCoreKey(TEST_CORE_PK);
  setAgentKey(TEST_AGENT_PK);
});

/**
 * Issues a real lease and wires the fact sheet and mandate to agree with it —
 * the same three-way consistency coreSign insists on.
 */
async function scenario(
  fsOver: Partial<FactSheet> = {},
  mOver: Partial<MandateState> = {},
): Promise<{ fs: FactSheet; m: MandateState; lease: Lease }> {
  const base = mandateState(mOver);
  const lease = await issueLease('agent-1', base, T0);
  const m = mandateState({
    ...mOver,
    leaseExpiryS: Math.floor(lease.expiresAtMs / 1000),
    requestRevocationEpoch: lease.revocationEpoch,
  });
  const fs = factSheet({ leaseId: lease.leaseId, ...fsOver });
  return { fs, m, lease };
}

describe('A7 buildPaymentRequest', () => {
  it('maps every field, in Solidity units', async () => {
    const { fs, m, lease } = await scenario();
    const req = buildPaymentRequest(fs, m, lease, fs.coreImageDigest as `0x${string}`);

    expect(req.amountMinor).toBe(940_000n);
    expect(req.counterparty).toBe(getAddress(TIER1_COUNTERPARTY));
    expect(req.counterpartyTier).toBe(1);
    expect(req.counterpartyAgeDays).toBe(400);
    expect(req.counterpartySettledTxns).toBe(120);
    expect(req.priceBandZ).toBe(0);
    // 'OTHER' is category index 7 — the integer PolicyModule shifts by.
    expect(req.categoryCode).toBe(7);
    expect(req.leaseId).toBe(keccak256(toBytes(lease.leaseId)));
    expect(req.nonce).toBe(1n);
    expect(req.revocationEpoch).toBe(BigInt(lease.revocationEpoch));
    // ms -> s, floored: the chain compares this to block.timestamp.
    expect(req.leaseExpiry).toBe(BigInt(Math.floor(lease.expiresAtMs / 1000)));
    expect(req.coreImageDigest).toBe(fs.coreImageDigest);
  });

  it('never truncates a long lease id into bytes32', () => {
    const long = 'lse_' + 'a'.repeat(120);
    expect(leaseIdToBytes32(long)).toBe(keccak256(toBytes(long)));
    expect(leaseIdToBytes32(long)).not.toBe(leaseIdToBytes32(long + 'b'));
  });

  it('hashRequest is deterministic and sensitive to every field', async () => {
    const { fs, m, lease } = await scenario();
    const req = buildPaymentRequest(fs, m, lease, fs.coreImageDigest as `0x${string}`);
    expect(hashRequest(req)).toBe(hashRequest(req));
    expect(hashRequest({ ...req, amountMinor: req.amountMinor + 1n })).not.toBe(hashRequest(req));
    expect(hashRequest({ ...req, priceBandZ: 1 })).not.toBe(hashRequest(req));
    expect(hashRequest({ ...req, nonce: req.nonce + 1n })).not.toBe(hashRequest(req));
  });
});

describe('A7 coreSign — only APPROVED produces a signature', () => {
  it('signs an APPROVED decision with the core key over the raw digest', async () => {
    const { fs, m, lease } = await scenario();
    const res = await coreSign(fs, m, lease, T0);

    expect(res.trace.outcome).toBe('APPROVED');
    expect(res.partialSig).not.toBeNull();
    expect(res.request).not.toBeNull();
    expect(res.digest).toBe(hashRequest(res.request!));

    const recovered = await recoverAddress({ hash: res.digest!, signature: res.partialSig! });
    expect(recovered).toBe(privateKeyToAccount(TEST_CORE_PK).address);
  });

  it('returns partialSig: null for a HELD decision', async () => {
    // tier-2 counterparty younger than tier2MinAgeDays -> soft fail -> HELD
    const { fs, m, lease } = await scenario({
      counterpartyId: TIER2_COUNTERPARTY,
      counterpartyTier: 2,
      counterpartyAgeDays: 5,
      amountMinor: 400_000,
    });
    const res = await coreSign(fs, m, lease, T0);

    expect(res.trace.outcome).toBe('HELD');
    expect(res.trace.bindingPredicate).toBe('counterpartyAge');
    expect(res.partialSig).toBeNull();
    expect(res.request).toBeNull();
    expect(res.digest).toBeNull();
  });

  it('returns partialSig: null for a REFUSED decision', async () => {
    // COMPUTE is index 3; permittedCategories is 128 (bit 7 only)
    const { fs, m, lease } = await scenario({ categoryCode: 'COMPUTE' });
    const res = await coreSign(fs, m, lease, T0);

    expect(res.trace.outcome).toBe('REFUSED');
    expect(res.trace.bindingPredicate).toBe('categoryPermitted');
    expect(res.partialSig).toBeNull();
    expect(res.request).toBeNull();
    expect(res.digest).toBeNull();
  });

  it('returns partialSig: null when a hard cap is exceeded', async () => {
    const { fs, m, lease } = await scenario({ amountMinor: 1_000_001 });
    const res = await coreSign(fs, m, lease, T0);
    expect(res.trace.outcome).toBe('REFUSED');
    expect(res.trace.bindingPredicate).toBe('perTxCap');
    expect(res.partialSig).toBeNull();
  });

  it('still returns the trace when it refuses, so the refusal can be explained', async () => {
    const { fs, m, lease } = await scenario({ categoryCode: 'COMPUTE' });
    const res = await coreSign(fs, m, lease, T0);
    expect(res.trace.summary).not.toBe('');
    expect(res.trace.predicates.length).toBeGreaterThan(0);
  });
});

describe('A7 coreSign — lease gate', () => {
  it('throws rather than signing when the lease has expired', async () => {
    const { fs, m, lease } = await scenario();
    await expect(coreSign(fs, m, lease, T0 + 5001)).rejects.toBeInstanceOf(LeaseInvalidError);
  });

  it('throws when the mandate was revoked under the lease', async () => {
    const { fs, m, lease } = await scenario();
    const revoked = { ...m, revocationEpoch: m.revocationEpoch + 1 };
    await expect(coreSign(fs, revoked, lease, T0)).rejects.toBeInstanceOf(LeaseInvalidError);
  });

  it('throws when the mandate froze under the lease', async () => {
    const { fs, m, lease } = await scenario();
    await expect(coreSign(fs, { ...m, frozen: true }, lease, T0)).rejects.toBeInstanceOf(
      LeaseInvalidError,
    );
  });

  it('throws when the fact sheet names a different lease', async () => {
    const { fs, m, lease } = await scenario();
    await expect(coreSign({ ...fs, leaseId: 'lse_deadbeef' }, m, lease, T0)).rejects.toBeInstanceOf(
      LeaseInvalidError,
    );
  });

  it('throws when the mandate expiry disagrees with the lease expiry', async () => {
    const { fs, m, lease } = await scenario();
    const desynced = { ...m, leaseExpiryS: m.leaseExpiryS + 3600 };
    await expect(coreSign(fs, desynced, lease, T0)).rejects.toBeInstanceOf(LeaseInvalidError);
  });

  it('refuses to sign with no core key configured', async () => {
    const { fs, m, lease } = await scenario();
    resetKeys();
    await expect(coreSign(fs, m, lease, T0)).rejects.toThrow();
  });
});

describe('A7 agentSign', () => {
  it('produces a signature recovering to the agent key, over the same digest', async () => {
    const { fs, m, lease } = await scenario();
    const req = buildPaymentRequest(fs, m, lease, fs.coreImageDigest as `0x${string}`);
    const sig = await agentSign(req);
    const recovered = await recoverAddress({ hash: hashRequest(req), signature: sig });
    expect(recovered).toBe(privateKeyToAccount(TEST_AGENT_PK).address);
  });

  it('is a different signature from the core share over the same digest', async () => {
    const { fs, m, lease } = await scenario();
    const res = await coreSign(fs, m, lease, T0);
    const agentSig = await agentSign(res.request!);
    expect(agentSig).not.toBe(res.partialSig);
  });
});

describe('timekeeping', () => {
  it('T0 is a whole number of seconds, so ms->s conversions are exact here', () => {
    expect(T0_S).toBe(Math.floor(T0 / 1000));
  });
});
