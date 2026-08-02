import { describe, it, expect } from 'vitest';
import { evaluate } from '../src/evaluator.js';
import { summarize, explain, money, reasonFor } from '../src/explain.js';
import {
  PREDICATE_NAMES,
  type FactSheet,
  type MandateState,
  type Predicate,
  type PredicateName,
} from '../src/types.js';

const CP1 = '0x' + '11'.repeat(20);
const CP2 = '0x' + '22'.repeat(20);
const IMAGE = '0x' + 'ab'.repeat(32);
const NOW_S = 1_000_000;
const NOW_MS = NOW_S * 1000;

function baseFactSheet(): FactSheet {
  return {
    amountMinor: 400_000,
    currency: 'INR',
    categoryCode: 'OTHER',
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

function baseMandate(): MandateState {
  return {
    perTxCapMinor: 1_000_000,
    windowCapMinor: 1_500_000,
    windowSeconds: 86_400,
    cumulativeCapMinor: 1_500_000,
    permittedCategories: 1n << 7n,
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
    ]),
    requestRevocationEpoch: 0,
    leaseExpiryS: NOW_S + 86_400,
    policyHash: 'ph',
  };
}

describe('money()', () => {
  it('formats paise as rupees with Indian grouping', () => {
    expect(money(940_000)).toBe('₹9,400');
    expect(money(4_999_000)).toBe('₹49,990');
    expect(money(2_500_000)).toBe('₹25,000');
    expect(money(376_000)).toBe('₹3,760');
    expect(money(0)).toBe('₹0');
    expect(money(100)).toBe('₹1');
  });
  it('shows paise remainder only when non-zero', () => {
    expect(money(940_050)).toBe('₹9,400.50');
    expect(money(940_005)).toBe('₹9,400.05');
  });
  it('groups lakhs/crores the Indian way', () => {
    expect(money(1_234_567_89_00)).toBe('₹12,34,56,789');
  });
});

describe('summarize', () => {
  it('APPROVED states the money moved', () => {
    const t = evaluate(baseFactSheet(), baseMandate(), { agent: true, core: true }, NOW_MS);
    expect(t.outcome).toBe('APPROVED');
    expect(summarize(t)).toBe(`Approved. ₹4,000 was paid to 0x1111…1111.`);
  });

  it('REFUSED perTxCap matches the CLAUDE.md example verbatim', () => {
    const fs = { ...baseFactSheet(), amountMinor: 4_999_000 };
    const m = { ...baseMandate(), perTxCapMinor: 2_500_000 };
    const t = evaluate(fs, m, { agent: true, core: true }, NOW_MS);
    expect(t.bindingPredicate).toBe('perTxCap');
    expect(summarize(t)).toBe(
      'Refused. ₹49,990 is over the ₹25,000 per-payment cap. Nothing was charged.',
    );
  });

  it('HELD names every soft predicate that failed and says money is on hold', () => {
    const fs = {
      ...baseFactSheet(),
      counterpartyId: CP2,
      counterpartyTier: 2 as const,
      amountMinor: 376_000,
      counterpartyAgeDays: 1,
      counterpartySettledTxns: 0,
    };
    const t = evaluate(fs, baseMandate(), { agent: true, core: true }, NOW_MS);
    expect(t.outcome).toBe('HELD');
    const s = summarize(t);
    expect(s).toContain('on hold');
    expect(s).toContain('newer than allowed');
    expect(s).toContain('too few settled payments');
    expect(s).toContain('₹3,760');
    expect(s).toContain('cancel it or let it settle');
  });

  it('frozen account -> refused with no policy detail', () => {
    const m = { ...baseMandate(), frozen: true };
    const t = evaluate(baseFactSheet(), m, { agent: true, core: true }, NOW_MS);
    expect(summarize(t)).toBe('Refused. Spending is frozen right now. Nothing was charged.');
  });
});

describe('explain', () => {
  it('renders a full breakdown with a check line per predicate', () => {
    const t = evaluate(baseFactSheet(), baseMandate(), { agent: true, core: true }, NOW_MS);
    const out = explain(t);
    expect(out).toContain('Counterparty: 0x1111…1111');
    expect(out).toContain('Amount: ₹4,000');
    expect(out).toContain('✓ Agent signature');
    expect(out).toContain('₹4,000 was paid');
  });

  it('REFUSED breakdown marks the binding predicate with a reason', () => {
    const fs = { ...baseFactSheet(), coreImageDigest: '0x' + 'cd'.repeat(32) };
    const out = explain(evaluate(fs, baseMandate(), { agent: true, core: true }, NOW_MS));
    expect(out).toContain('✗ Core software image');
    expect(out).toContain('Nothing was charged.');
  });
});

describe('template coverage & hygiene', () => {
  const supersetInputs: Record<string, number | string> = {
    categoryCode: 'CONTENT',
    ageDays: 1,
    minAgeDays: 30,
    settledTxns: 1,
    minSettledTxns: 5,
    amountMinor: 4_999_000,
    perTxCapMinor: 2_500_000,
    windowCapMinor: 1_500_000,
    cumulativeCapMinor: 1_500_000,
  };

  it('every predicate has a non-empty reason template with no "undefined"', () => {
    for (const name of PREDICATE_NAMES as readonly PredicateName[]) {
      const p: Predicate = {
        name,
        inputs: supersetInputs,
        expected: '',
        actual: '',
        passed: false,
        severity: 'hard',
      };
      const r = reasonFor(p);
      expect(r, `reason for ${name}`).toBeTruthy();
      expect(r, `reason for ${name}`).not.toContain('undefined');
    }
  });

  it('no rendered output apologises, hedges, or says "error"', () => {
    // Sweep a few representative outcomes.
    const traces = [
      evaluate(baseFactSheet(), baseMandate(), { agent: true, core: true }, NOW_MS),
      evaluate(baseFactSheet(), baseMandate(), { agent: false, core: true }, NOW_MS),
      evaluate(
        { ...baseFactSheet(), counterpartyId: CP2, counterpartyTier: 2 as const, counterpartyAgeDays: 1 },
        baseMandate(),
        { agent: true, core: true },
        NOW_MS,
      ),
    ];
    for (const t of traces) {
      for (const text of [summarize(t), explain(t)]) {
        expect(text.toLowerCase()).not.toContain('error');
        expect(text.toLowerCase()).not.toContain('undefined');
        expect(text.toLowerCase()).not.toContain('sorry');
      }
    }
  });
});
