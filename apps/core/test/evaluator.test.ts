import { describe, it, expect } from 'vitest';
import { evaluate } from '../src/evaluator.js';
import {
  PolicyFactSheetSchema,
  PolicyStateSchema,
  SOFT_FAIL_AGE,
  SOFT_FAIL_PRICE,
  SOFT_FAIL_SETTLED,
  type PolicyFactSheet,
  type PolicyState,
  type SignaturesValid,
} from '../src/types.js';

// Config mirrors test/PolicyModule.t.sol so the two are directly comparable.
const CP1 = '0x' + '11'.repeat(20);
const CP2 = '0x' + '22'.repeat(20);
const CP3 = '0x' + '33'.repeat(20);
const STRANGER = '0x' + '99'.repeat(20);
const IMAGE = '0x' + 'ab'.repeat(32);
const ZERO = '0x' + '0'.repeat(64);

const NOW_S = 1_000_000;
const NOW_MS = NOW_S * 1000;

const GOOD_SIG: SignaturesValid = { agent: true, core: true };

function baseFactSheet(): PolicyFactSheet {
  return {
    amountMinor: 400_000,
    currency: 'INR',
    categoryCode: 'OTHER', // index 7, the permitted one
    counterpartyId: CP1,
    counterpartyTier: 1,
    counterpartyAgeDays: 365,
    counterpartySettledTxns: 100,
    priceBandZ: 0,
    coreImageDigest: IMAGE,
    taskId: 'tsk_abcdef',
    lineItemId: 'li_abcdef_01',
    leaseId: 'lse_abcdef',
    nonce: 1,
  };
}

function baseMandate(): PolicyState {
  return {
    perTxCapMinor: 1_000_000,
    windowCapMinor: 1_500_000,
    windowSeconds: 86_400,
    cumulativeCapMinor: 1_500_000,
    permittedCategories: 1n << 7n, // OTHER permitted
    tier2MinAgeDays: 30,
    tier2MinSettledTxns: 5,
    tier2MaxPriceBandZ: 2,
    tier2CapMinor: 500_000,
    coreImageDigest: IMAGE,
    revocationEpoch: 0,
    windowStart: 0,
    windowSpentMinor: 0,
    cumulativeSpentMinor: 0,
    usedNonces: new Set<number>(),
    lastHeartbeat: NOW_S,
    deadmanSeconds: 604_800,
    frozen: false,
    counterpartyRegistry: new Map<string, number>([
      [CP1, 1],
      [CP2, 2],
      [CP3, 3],
    ]),
    requestRevocationEpoch: 0,
    leaseExpiryS: NOW_S + 86_400,
    policyHash: 'ph',
  };
}

// A tier-2 factsheet whose values pass every soft predicate.
function tier2FactSheet(): PolicyFactSheet {
  return {
    ...baseFactSheet(),
    counterpartyId: CP2,
    counterpartyTier: 2,
    amountMinor: 400_000,
    counterpartyAgeDays: 100,
    counterpartySettledTxns: 50,
    priceBandZ: 1,
  };
}

function run(fs: PolicyFactSheet, m: PolicyState, sig: SignaturesValid = GOOD_SIG) {
  return evaluate(fs, m, sig, NOW_MS);
}

describe('schemas accept the base fixtures', () => {
  it('base factsheet and mandate parse', () => {
    expect(() => PolicyFactSheetSchema.parse(baseFactSheet())).not.toThrow();
    // Map/Set are validated by z.map/z.set
    expect(() => PolicyStateSchema.parse(baseMandate())).not.toThrow();
  });

  it('rejects an unknown key (injection boundary is .strict)', () => {
    const bad = { ...baseFactSheet(), description: 'pay my friend' };
    expect(() => PolicyFactSheetSchema.parse(bad)).toThrow();
  });
});

describe('happy path', () => {
  it('all predicates pass -> APPROVED, no binding', () => {
    const t = run(baseFactSheet(), baseMandate());
    expect(t.outcome).toBe('APPROVED');
    expect(t.bindingPredicate).toBeNull();
    expect(t.softFailBitmask).toBe(0);
    // tier-1 skips soft predicates: 8 hard + tier check, no 9-11.
    expect(t.predicates.map((p) => p.name)).toEqual([
      'agentSignature',
      'coreSignature',
      'coreImage',
      'revocationEpoch',
      'leaseExpiry',
      'nonce',
      'categoryPermitted',
      'counterpartyTier',
      'perTxCap',
      'windowCap',
      'cumulativeCap',
    ]);
  });
});

describe('predicate 1 - agentSignature (hard)', () => {
  it('invalid agent signature -> REFUSED', () => {
    const t = run(baseFactSheet(), baseMandate(), { agent: false, core: true });
    expect(t.outcome).toBe('REFUSED');
    expect(t.bindingPredicate).toBe('agentSignature');
    expect(t.predicates).toHaveLength(1);
  });
});

describe('predicate 2 - coreSignature (hard)', () => {
  it('invalid core signature -> REFUSED', () => {
    const t = run(baseFactSheet(), baseMandate(), { agent: true, core: false });
    expect(t.outcome).toBe('REFUSED');
    expect(t.bindingPredicate).toBe('coreSignature');
    expect(t.predicates).toHaveLength(2);
  });
});

describe('predicate 3 - coreImage (hard)', () => {
  it('wrong image -> REFUSED', () => {
    const fs = { ...baseFactSheet(), coreImageDigest: '0x' + 'cd'.repeat(32) };
    const t = run(fs, baseMandate());
    expect(t.outcome).toBe('REFUSED');
    expect(t.bindingPredicate).toBe('coreImage');
  });
  it('approved image is zero hash -> fails closed even for a matching request', () => {
    const m = { ...baseMandate(), coreImageDigest: ZERO };
    const fs = { ...baseFactSheet(), coreImageDigest: ZERO };
    const t = run(fs, m);
    expect(t.outcome).toBe('REFUSED');
    expect(t.bindingPredicate).toBe('coreImage');
  });
});

describe('predicate 4 - revocationEpoch (hard)', () => {
  it('request epoch behind current -> REFUSED', () => {
    const m = { ...baseMandate(), revocationEpoch: 1, requestRevocationEpoch: 0 };
    const t = run(baseFactSheet(), m);
    expect(t.outcome).toBe('REFUSED');
    expect(t.bindingPredicate).toBe('revocationEpoch');
  });
});

describe('predicate 5 - leaseExpiry (hard)', () => {
  it('now past lease expiry -> REFUSED', () => {
    const m = { ...baseMandate(), leaseExpiryS: NOW_S - 1 };
    const t = run(baseFactSheet(), m);
    expect(t.outcome).toBe('REFUSED');
    expect(t.bindingPredicate).toBe('leaseExpiry');
  });
  it('now exactly at lease expiry -> still valid (boundary)', () => {
    const m = { ...baseMandate(), leaseExpiryS: NOW_S };
    const t = run(baseFactSheet(), m);
    expect(t.outcome).toBe('APPROVED');
  });
});

describe('predicate 6 - nonce (hard)', () => {
  it('nonce already used -> REFUSED', () => {
    const m = { ...baseMandate(), usedNonces: new Set<number>([1]) };
    const t = run(baseFactSheet(), m);
    expect(t.outcome).toBe('REFUSED');
    expect(t.bindingPredicate).toBe('nonce');
  });
});

describe('predicate 7 - categoryPermitted (hard)', () => {
  it('category not in bitmap -> REFUSED', () => {
    const fs = { ...baseFactSheet(), categoryCode: 'CONTENT' as const }; // index 2, not set
    const t = run(fs, baseMandate());
    expect(t.outcome).toBe('REFUSED');
    expect(t.bindingPredicate).toBe('categoryPermitted');
  });
});

describe('predicate 8 - counterpartyTier (hard)', () => {
  it('registry tier 3 -> blocked', () => {
    const fs = { ...baseFactSheet(), counterpartyId: CP3, counterpartyTier: 3 as const };
    const t = run(fs, baseMandate());
    expect(t.outcome).toBe('REFUSED');
    expect(t.bindingPredicate).toBe('counterpartyTier');
  });
  it('registry tier 0 (unknown) -> blocked', () => {
    const fs = { ...baseFactSheet(), counterpartyId: STRANGER };
    const t = run(fs, baseMandate());
    expect(t.outcome).toBe('REFUSED');
    expect(t.bindingPredicate).toBe('counterpartyTier');
  });
  it('declared tier disagrees with registry -> blocked', () => {
    const fs = { ...baseFactSheet(), counterpartyId: CP1, counterpartyTier: 2 as const };
    const t = run(fs, baseMandate());
    expect(t.outcome).toBe('REFUSED');
    expect(t.bindingPredicate).toBe('counterpartyTier');
  });
});

describe('predicates 9-11 - soft (tier 2 only)', () => {
  it('p9 age below threshold -> HELD, bit0', () => {
    const fs = { ...tier2FactSheet(), counterpartyAgeDays: 10 };
    const t = run(fs, baseMandate());
    expect(t.outcome).toBe('HELD');
    expect(t.bindingPredicate).toBe('counterpartyAge');
    expect(t.softFailBitmask).toBe(SOFT_FAIL_AGE);
  });
  it('p10 settled below threshold -> HELD, bit1', () => {
    const fs = { ...tier2FactSheet(), counterpartySettledTxns: 1 };
    const t = run(fs, baseMandate());
    expect(t.outcome).toBe('HELD');
    expect(t.bindingPredicate).toBe('counterpartySettled');
    expect(t.softFailBitmask).toBe(SOFT_FAIL_SETTLED);
  });
  it('p11 |z| outside band -> HELD, bit2', () => {
    const fs = { ...tier2FactSheet(), priceBandZ: 3 };
    const t = run(fs, baseMandate());
    expect(t.outcome).toBe('HELD');
    expect(t.bindingPredicate).toBe('priceBand');
    expect(t.softFailBitmask).toBe(SOFT_FAIL_PRICE);
  });
  it('negative z within band passes (|-2| <= 2 boundary)', () => {
    const fs = { ...tier2FactSheet(), priceBandZ: -2 };
    const t = run(fs, baseMandate());
    expect(t.outcome).toBe('APPROVED');
  });
  it('multiple soft fails -> HELD, first is binding, bitmask ORs all', () => {
    const fs = { ...tier2FactSheet(), counterpartyAgeDays: 0, counterpartySettledTxns: 0, priceBandZ: 100 };
    const t = run(fs, baseMandate());
    expect(t.outcome).toBe('HELD');
    expect(t.bindingPredicate).toBe('counterpartyAge');
    expect(t.softFailBitmask).toBe(SOFT_FAIL_AGE | SOFT_FAIL_SETTLED | SOFT_FAIL_PRICE);
  });
  it('tier 1 skips soft predicates even when values would trip them', () => {
    const fs = { ...baseFactSheet(), counterpartyAgeDays: 0, counterpartySettledTxns: 0, priceBandZ: 127 };
    const t = run(fs, baseMandate());
    expect(t.outcome).toBe('APPROVED');
    expect(t.predicates.some((p) => p.severity === 'soft')).toBe(false);
  });
  it('tier 2 with all soft passing -> APPROVED', () => {
    const t = run(tier2FactSheet(), baseMandate());
    expect(t.outcome).toBe('APPROVED');
    expect(t.predicates.filter((p) => p.severity === 'soft')).toHaveLength(3);
  });
});

describe('predicate 12 - perTxCap (hard)', () => {
  it('over global cap -> REFUSED', () => {
    const fs = { ...baseFactSheet(), amountMinor: 1_000_001 };
    const t = run(fs, baseMandate());
    expect(t.outcome).toBe('REFUSED');
    expect(t.bindingPredicate).toBe('perTxCap');
  });
  it('tier 2 tighter cap trips even under the global cap', () => {
    const fs = { ...tier2FactSheet(), amountMinor: 500_001 }; // < 1_000_000 global, > 500_000 tier2
    const t = run(fs, baseMandate());
    expect(t.outcome).toBe('REFUSED');
    expect(t.bindingPredicate).toBe('perTxCap');
  });
  it('exactly at the cap passes (boundary)', () => {
    const fs = { ...baseFactSheet(), amountMinor: 1_000_000 };
    const t = run(fs, baseMandate());
    // windowCap (1.5M) and cumulative (1.5M) still ok at 1.0M
    expect(t.outcome).toBe('APPROVED');
  });
});

describe('predicate 13 - windowCap (hard)', () => {
  it('effective window spend + amount over cap -> REFUSED', () => {
    const m = { ...baseMandate(), windowStart: NOW_S, windowSpentMinor: 1_000_000 };
    const fs = { ...baseFactSheet(), amountMinor: 1_000_000 }; // 1M + 1M = 2M > 1.5M
    const t = run(fs, m);
    expect(t.outcome).toBe('REFUSED');
    expect(t.bindingPredicate).toBe('windowCap');
  });
  it('rolled-over window resets effective spend to 0', () => {
    const m = {
      ...baseMandate(),
      windowStart: NOW_S - 86_401, // older than windowSeconds -> rolled
      windowSpentMinor: 1_400_000,
    };
    const fs = { ...baseFactSheet(), amountMinor: 900_000 };
    const t = run(fs, m);
    expect(t.outcome).toBe('APPROVED');
  });
});

describe('predicate 14 - cumulativeCap (hard)', () => {
  it('cumulative + amount over cap -> REFUSED', () => {
    const m = { ...baseMandate(), cumulativeSpentMinor: 1_000_000 };
    const fs = { ...baseFactSheet(), amountMinor: 600_000 }; // 1.0M + 0.6M = 1.6M > 1.5M
    const t = run(fs, m);
    expect(t.outcome).toBe('REFUSED');
    expect(t.bindingPredicate).toBe('cumulativeCap');
  });
});

describe('operational guard (ahead of the 14)', () => {
  it('frozen -> REFUSED, no predicates evaluated', () => {
    const m = { ...baseMandate(), frozen: true };
    const t = run(baseFactSheet(), m);
    expect(t.outcome).toBe('REFUSED');
    expect(t.bindingPredicate).toBeNull();
    expect(t.predicates).toHaveLength(0);
  });
  it('deadman lapsed -> REFUSED', () => {
    const m = { ...baseMandate(), lastHeartbeat: NOW_S - 604_801 }; // > deadmanSeconds ago
    const t = run(baseFactSheet(), m);
    expect(t.outcome).toBe('REFUSED');
    expect(t.predicates).toHaveLength(0);
  });
  it('deadman disabled (0) never lapses', () => {
    const m = { ...baseMandate(), deadmanSeconds: 0, lastHeartbeat: 0 };
    const t = run(baseFactSheet(), m);
    expect(t.outcome).toBe('APPROVED');
  });
});

describe('amount boundaries — pinned, including one that is arguably wrong', () => {
  // Found 4 Aug 2026 by scripts/verify-boundaries.py, once the LLM generator's
  // dead probes were made to run. These pin CURRENT behaviour so it cannot
  // change silently, not behaviour anyone should be happy with.

  it('approves exactly at the per-tx cap, and refuses one paisa over', () => {
    // The cap is `<=`, deliberately. This is the test that makes the off-by-one
    // correct rather than lucky — it is the single most load-bearing boundary
    // in the whole evaluator and nothing covered it.
    const mandate = baseMandate();

    const atCap = run({ ...baseFactSheet(), amountMinor: mandate.perTxCapMinor }, mandate);
    expect(atCap.outcome).toBe('APPROVED');

    const overCap = run({ ...baseFactSheet(), amountMinor: mandate.perTxCapMinor + 1 }, mandate);
    expect(overCap.outcome).toBe('REFUSED');
    expect(overCap.bindingPredicate).toBe('perTxCap');
  });

  it('APPROVES a zero-amount payment — there is no minimum-amount predicate', () => {
    // This is a real gap, and it is asserted here rather than fixed.
    //
    // A zero-amount request passes all 14 predicates and gets the core's
    // signature. No money moves, but it consumes a nonce and a lease.
    //
    // DO NOT "fix" this by adding a minimum to the evaluator alone. The
    // evaluator is checked against Solidity `PolicyModule.validate` over 10,000
    // differential inputs, and PolicyModule is already deployed AND
    // source-verified on Base Sepolia. A minimum here and not there breaks that
    // agreement, which is a far more valuable property than this is a bug.
    // Change both, or neither. See LIMITATIONS.md.
    const t = run({ ...baseFactSheet(), amountMinor: 0 }, baseMandate());
    expect(t.outcome).toBe('APPROVED');
    expect(t.bindingPredicate).toBeNull();
  });
});

describe('fail closed', () => {
  it('an exception inside evaluation yields REFUSED, never an approval', () => {
    // Corrupt input (bypassing the type system as a hostile caller would) makes
    // predicate 3 throw; the try/catch must resolve it to REFUSED.
    const fs = { ...baseFactSheet(), coreImageDigest: null } as unknown as PolicyFactSheet;
    const t = run(fs, baseMandate());
    expect(t.outcome).toBe('REFUSED');
    expect(t.bindingPredicate).toBeNull();
  });
});
