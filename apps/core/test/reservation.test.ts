/**
 * Window reservations under duplicate nonces.
 *
 * The reservation that keeps the core from co-signing past windowCap is keyed by
 * nonce (`nonce:${fs.nonce}`, payment.ts). Two requests carrying the same nonce
 * therefore share a key, and the second one — which is refused precisely because
 * the first holds the nonce — releases it on its way out.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The route reads the chain for predicates 6 and 8. Neither is what this file is
// about, so both answer the same way every time: tier 1, nonce unburned.
vi.mock('../src/api/chain.js', () => {
  class SettlementRevertedError extends Error {
    errorName: string;
    constructor(errorName: string) {
      super(errorName);
      this.errorName = errorName;
    }
  }
  return {
    counterpartyTierOnChain: vi.fn(async () => 1),
    nonceUsedOnChain: vi.fn(async () => false),
    readDeployedPolicy: vi.fn(async () => null),
    settlementConfig: vi.fn(() => null),
    rekhaAccountAddress: vi.fn(() => null),
    inrxBalanceAtBlock: vi.fn(async () => 0n),
    broadcastExecute: vi.fn(async () => {
      throw new Error('settlement is not exercised here');
    }),
    SettlementRevertedError,
  };
});

import { registerPaymentRoutes } from '../src/api/routes/payment.js';
import * as store from '../src/api/store.js';
import { resetKeys, setCoreKey } from '../src/keys.js';
import { TEST_CORE_PK, TIER1_COUNTERPARTY } from './fixtures.js';

const PER_TX_CAP = store.DEPLOYED_POLICY.perTxCapMinor; // ₹25,000
const WINDOW_CAP = store.DEPLOYED_POLICY.windowCapMinor; // ₹1,00,000

let app: FastifyInstance;
let mandateId: string;
let leaseId: string;

function factSheet(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    amountMinor: 800_000,
    currency: 'INR',
    categoryCode: 'OTHER',
    counterpartyId: TIER1_COUNTERPARTY,
    counterpartyTier: 1,
    counterpartyAgeDays: 400,
    counterpartySettledTxns: 120,
    priceBandZ: 0,
    taskId: 'tsk_abcdef',
    lineItemId: 'li_abcdef_01',
    leaseId,
    nonce: 7,
    ...over,
  };
}

async function request(over: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/payment/request',
    payload: { factSheet: factSheet(over) },
  });
  return res.json();
}

beforeAll(async () => {
  // A 3-round ceremony at the 1200ms default would add 3.6s to every approval.
  process.env['CEREMONY_ROUND_MS'] = '1';
  process.env['LEASE_TTL_MS'] = '60000';
  delete process.env['CORE_IMAGE_DIGEST'];
  setCoreKey(TEST_CORE_PK);

  // The registry lives in another service. Unreachable here, which zeroes the two
  // soft-predicate inputs — irrelevant for a tier-1 counterparty, which skips them.
  // The route logs that miss on every request; it is expected, so keep it out of
  // the suite output.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('vendor registry is not running in this test');
    }),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  app = Fastify({ logger: false });
  await registerPaymentRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  vi.unstubAllGlobals();
  resetKeys();
});

beforeEach(async () => {
  const { mandateId: id } = store.createMandate();
  mandateId = id;
  const agent = store.registerAgent(mandateId);
  const issued = await store.issueLease(agent.agentId);
  if (!issued.ok) throw new Error(`lease: ${issued.reason}`);
  leaseId = issued.lease.leaseId;
});

describe('spend reservations survive a duplicate nonce', () => {
  it('holds the approved amount once the request returns', async () => {
    const first = await request({ nonce: 7, amountMinor: 800_000 });
    expect(first.outcome).toBe('APPROVED');
    expect(store.reservedSpendMinor(mandateId)).toBe(800_000);
  });

  /**
   * The trace used to carry latencyMs: 0 on every decision, because the
   * evaluator leaves it for a caller to fill in and no caller did. Both UIs
   * showed that zero — one as a literal `0ms`, one as an inferred `<1ms`.
   */
  it('reports a measured evaluation latency, not a zero', async () => {
    const res = await request({ nonce: 11, amountMinor: 800_000 });
    expect(res.trace.latencyMs).toBeGreaterThan(0);
    expect(res.trace.latencyMs).toBeLessThan(50);
  });

  it('does not drop the first request’s reservation when a replay is refused', async () => {
    const first = await request({ nonce: 7, amountMinor: 800_000 });
    expect(first.outcome).toBe('APPROVED');
    expect(store.reservedSpendMinor(mandateId)).toBe(800_000);

    // Same nonce. The first request still holds it, so this one is refused on
    // predicate 6 and nothing about it can ever settle.
    const replay = await request({ nonce: 7, amountMinor: 100, lineItemId: 'li_abcdef_02' });
    expect(replay.outcome).toBe('REFUSED');
    expect(replay.trace.bindingPredicate).toBe('nonce');

    // The first payment is still approved, still co-signed, still unsettled.
    // Its rupees are still spoken for.
    expect(store.reservedSpendMinor(mandateId)).toBe(800_000);
  });

  it('does not let a replay open room past windowCap', async () => {
    const slice = PER_TX_CAP; // ₹25,000 — four of these exactly fill the window
    const slices = WINDOW_CAP / slice;

    for (let i = 0; i < slices; i++) {
      const res = await request({
        nonce: 100 + i,
        amountMinor: slice,
        lineItemId: `li_abcdef_${String(i).padStart(2, '0')}`,
      });
      expect(res.outcome).toBe('APPROVED');
    }
    expect(store.reservedSpendMinor(mandateId)).toBe(WINDOW_CAP);

    // A replay of the first nonce. Refused, and must leave the window full.
    const replay = await request({ nonce: 100, amountMinor: 1, lineItemId: 'li_abcdef_90' });
    expect(replay.outcome).toBe('REFUSED');
    expect(store.reservedSpendMinor(mandateId)).toBe(WINDOW_CAP);

    // The window is full, so one more rupee is more than the mandate allows.
    const overflow = await request({ nonce: 200, amountMinor: slice, lineItemId: 'li_abcdef_91' });
    expect(overflow.outcome).toBe('REFUSED');
    expect(overflow.trace.bindingPredicate).toBe('windowCap');
  });
});
