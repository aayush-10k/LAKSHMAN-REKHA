import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createTestClient,
  http,
  publicActions,
  walletActions,
  getAddress,
  ContractFunctionRevertedError,
  BaseError,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { evaluate } from '../src/evaluator.js';
import {
  CATEGORY_CODES,
  SOFT_FAIL_AGE,
  SOFT_FAIL_PRICE,
  SOFT_FAIL_SETTLED,
  type PolicyFactSheet,
  type PolicyState,
  type Outcome,
  type PredicateName,
} from '../src/types.js';

// ---------------------------------------------------------------------------
//  Constants & keys (deterministic)
// ---------------------------------------------------------------------------

const RPC = 'http://127.0.0.1:8545';
const N = Number(process.env.DIFF_N ?? 10_000);
const SEED = 0x1234_abcd;

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex; // anvil #0
const AGENT_PK = ('0x' + '11'.repeat(32)) as Hex;
const CORE_PK = ('0x' + '22'.repeat(32)) as Hex;
const WRONG_PK = ('0x' + '33'.repeat(32)) as Hex;

const IMAGE = ('0x' + 'ab'.repeat(32)) as Hex;
const OTHER_IMAGE = ('0x' + 'cd'.repeat(32)) as Hex;
const ZERO32 = ('0x' + '00'.repeat(32)) as Hex;

let deployTs = 0; // set in beforeAll from the live chain (anvil starts at wall-clock)
const DEADMAN = 604_800; // 7 days, fixed at deploy

// Counterparty addresses with fixed registry tiers.
const ADDR: Record<'t1' | 't2' | 't3' | 'unk', Address> = {
  t1: getAddress('0x' + '11'.repeat(20)),
  t2: getAddress('0x' + '22'.repeat(20)),
  t3: getAddress('0x' + '33'.repeat(20)),
  unk: getAddress('0x' + '99'.repeat(20)),
};
const REGISTRY_TIER: Record<keyof typeof ADDR, number> = { t1: 1, t2: 2, t3: 3, unk: 0 };

const agentAccount = privateKeyToAccount(AGENT_PK);
const coreAccount = privateKeyToAccount(CORE_PK);

// ---------------------------------------------------------------------------
//  Seeded PRNG (mulberry32) — reproducible, no Math.random anywhere.
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T,>(r: Rng, xs: readonly T[]): T => xs[int(r, 0, xs.length - 1)]!;
const chance = (r: Rng, p: number) => r() < p;
// value biased to sit exactly at / just around a threshold
const around = (r: Rng, x: number, lo: number, hi: number) => {
  const d = pick(r, [-1, 0, 0, 1]);
  return Math.max(lo, Math.min(hi, x + d));
};

// ---------------------------------------------------------------------------
//  Case model — one struct, two derivations (on-chain + TS), so they can't drift.
// ---------------------------------------------------------------------------

type Case = {
  cfg: {
    perTxCap: number;
    windowCap: number;
    windowSeconds: number;
    cumulativeCap: number;
    permitted: bigint;
    t2MinAge: number;
    t2MinSettled: number;
    t2MaxZ: number;
    t2Cap: number;
  };
  approvedZero: boolean; // revokeCoreImage before validate
  cpKind: keyof typeof ADDR;
  declaredTier: number;
  amount: number;
  ageDays: number;
  settledTxns: number;
  priceBandZ: number;
  categoryIdx: number;
  nonce: number;
  reqEpoch: number;
  reqImageApproved: boolean;
  agentGood: boolean;
  coreGood: boolean;
  seed: { amount: number; nonce: number } | null;
  freeze: boolean;
  leaseKind: 'valid' | 'expired' | 'boundary';
};

function genCase(r: Rng): Case {
  const perTxCap = pick(r, [1, 500_000, 1_000_000, 2_500_000, 10_000_000]);
  const windowCap = pick(r, [1, 500_000, 1_500_000, 3_000_000]);
  const cumulativeCap = pick(r, [1, 500_000, 1_500_000, 3_000_000]);
  const windowSeconds = pick(r, [60, 3600, 86_400, 100_000_000]);
  const permitted = BigInt(int(r, 0, 255));
  const t2MinAge = pick(r, [0, 30, 100]);
  const t2MinSettled = pick(r, [0, 5, 50]);
  const t2MaxZ = pick(r, [-1, 0, 2, 5, 127]);
  const t2Cap = pick(r, [1, 250_000, 500_000, 1_000_000, 5_000_000]);

  const cpKind = pick(r, ['t1', 't1', 't2', 't2', 't3', 'unk'] as const);
  const regTier = REGISTRY_TIER[cpKind];
  const declaredTier = chance(r, 0.18) ? pick(r, [1, 2, 3]) : regTier === 0 ? pick(r, [1, 2, 3]) : regTier;

  // Amount biased around whichever cap is interesting.
  const capTarget = pick(r, [perTxCap, t2Cap, windowCap, cumulativeCap]);
  const amount = chance(r, 0.6)
    ? Math.max(0, Math.min(1_000_000_000, around(r, capTarget, 0, 1_000_000_000)))
    : int(r, 0, 1_000_000_000);

  const ageDays = chance(r, 0.7) ? around(r, t2MinAge, 0, 65_535) : int(r, 0, 65_535);
  const settledTxns = chance(r, 0.7) ? around(r, t2MinSettled, 0, 4_294_967_295) : int(r, 0, 4_294_967_295);
  const priceBandZ = chance(r, 0.5)
    ? around(r, t2MaxZ, -128, 127)
    : pick(r, [-128, -5, -2, -1, 0, 1, 2, 5, 127]);

  const categoryIdx = int(r, 0, 7);
  const nonce = int(r, 0, 5);
  const reqEpoch = chance(r, 0.15) ? 1 : 0;
  const reqImageApproved = !chance(r, 0.15);
  const approvedZero = chance(r, 0.05);
  const agentGood = !chance(r, 0.1);
  const coreGood = !chance(r, 0.1);
  const freeze = chance(r, 0.05);

  let seed: Case['seed'] = null;
  if (!freeze) {
    if (chance(r, 0.18)) {
      // seed window/cumulative spend (kept under caps so recordSpend can't revert)
      const cap = Math.min(windowCap, cumulativeCap);
      seed = { amount: int(r, 0, cap), nonce: 900 + int(r, 0, 50) };
    } else if (chance(r, 0.18)) {
      // burn the request's own nonce to trip predicate 6
      seed = { amount: 0, nonce };
    }
  }

  const leaseKind = pick(r, ['valid', 'valid', 'expired', 'boundary'] as const);

  return {
    cfg: { perTxCap, windowCap, windowSeconds, cumulativeCap, permitted, t2MinAge, t2MinSettled, t2MaxZ, t2Cap },
    approvedZero,
    cpKind,
    declaredTier,
    amount,
    ageDays,
    settledTxns,
    priceBandZ,
    categoryIdx,
    nonce,
    reqEpoch,
    reqImageApproved,
    agentGood,
    coreGood,
    seed,
    freeze,
    leaseKind,
  };
}

// Per-case timeline, all relative to a clean snapshot at T_snap.
function times(c: Case, tSnap: number) {
  const t0 = tSnap + 10;
  const tSeed = tSnap + 20;
  const tValidate = c.freeze ? deployTs + DEADMAN + 50 : tSnap + 100;
  const leaseExpiryS =
    c.leaseKind === 'valid' ? tValidate + 3600 : c.leaseKind === 'expired' ? tValidate - 10 : tValidate;
  return { t0, tSeed, tValidate, leaseExpiryS };
}

// ---------------------------------------------------------------------------
//  TS derivation
// ---------------------------------------------------------------------------

function buildTs(c: Case, tValidate: number, leaseExpiryS: number): { fs: PolicyFactSheet; m: PolicyState; nowMs: number } {
  const addr = ADDR[c.cpKind].toLowerCase();
  const registry = new Map<string, number>([
    [ADDR.t1.toLowerCase(), 1],
    [ADDR.t2.toLowerCase(), 2],
    [ADDR.t3.toLowerCase(), 3],
  ]);

  // Mirror the on-chain recordSpend(seed) at tSeed against a fresh contract.
  let windowStart = 0;
  let windowSpentMinor = 0;
  let cumulativeSpentMinor = 0;
  const usedNonces = new Set<number>();
  if (c.seed) {
    // fresh contract: windowStart == 0 -> roll to tSeed
    windowStart = timesCache.tSeed;
    windowSpentMinor = c.seed.amount;
    cumulativeSpentMinor = c.seed.amount;
    usedNonces.add(c.seed.nonce);
  }

  const fs: PolicyFactSheet = {
    amountMinor: c.amount,
    currency: 'INR',
    categoryCode: CATEGORY_CODES[c.categoryIdx]!,
    counterpartyId: addr,
    counterpartyTier: c.declaredTier as 1 | 2 | 3,
    counterpartyAgeDays: c.ageDays,
    counterpartySettledTxns: c.settledTxns,
    priceBandZ: c.priceBandZ,
    coreImageDigest: (c.reqImageApproved ? IMAGE : OTHER_IMAGE).toLowerCase(),
    taskId: 'tsk_abcdef',
    lineItemId: 'li_abcdef_01',
    leaseId: 'lse_abcdef',
    nonce: c.nonce,
  };

  const m: PolicyState = {
    perTxCapMinor: c.cfg.perTxCap,
    windowCapMinor: c.cfg.windowCap,
    windowSeconds: c.cfg.windowSeconds,
    cumulativeCapMinor: c.cfg.cumulativeCap,
    permittedCategories: c.cfg.permitted,
    tier2MinAgeDays: c.cfg.t2MinAge,
    tier2MinSettledTxns: c.cfg.t2MinSettled,
    tier2MaxPriceBandZ: c.cfg.t2MaxZ,
    tier2CapMinor: c.cfg.t2Cap,
    coreImageDigest: (c.approvedZero ? ZERO32 : IMAGE).toLowerCase(),
    revocationEpoch: 0,
    windowStart,
    windowSpentMinor,
    cumulativeSpentMinor,
    usedNonces,
    lastHeartbeat: deployTs,
    deadmanSeconds: DEADMAN,
    frozen: false,
    counterpartyRegistry: registry,
    requestRevocationEpoch: c.reqEpoch,
    leaseExpiryS,
    policyHash: '',
  };

  return { fs, m, nowMs: tValidate * 1000 };
}

// tSeed is needed inside buildTs; stash the current case's timeline here.
let timesCache = { t0: 0, tSeed: 0, tValidate: 0, leaseExpiryS: 0 };

// ---------------------------------------------------------------------------
//  On-chain client & per-case execution
// ---------------------------------------------------------------------------

const client = createTestClient({
  mode: 'anvil',
  chain: foundry,
  transport: http(RPC),
  account: privateKeyToAccount(DEPLOYER_PK),
})
  .extend(publicActions)
  .extend(walletActions);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let abi: any;
let bytecode: Hex;
let policyAddr: Address;
let baseSnapshot: Hex;
let tSnap: number;

const ERROR_TO_PREDICATE: Record<string, PredicateName> = {
  InvalidAgentSignature: 'agentSignature',
  InvalidCoreSignature: 'coreSignature',
  CoreImageMismatch: 'coreImage',
  StaleRevocationEpoch: 'revocationEpoch',
  LeaseExpired: 'leaseExpiry',
  NonceAlreadyUsed: 'nonce',
  CategoryNotPermitted: 'categoryPermitted',
  CounterpartyBlocked: 'counterpartyTier',
  PerTxCapExceeded: 'perTxCap',
  WindowCapExceeded: 'windowCap',
  CumulativeCapExceeded: 'cumulativeCap',
};

type SolResult =
  | { outcome: 'APPROVED' }
  | { outcome: 'HELD'; bitmask: number }
  | { outcome: 'REFUSED'; binding: PredicateName | null; errorName: string };

function paymentRequest(c: Case, leaseExpiryS: number) {
  return {
    amountMinor: BigInt(c.amount),
    counterparty: ADDR[c.cpKind],
    counterpartyTier: c.declaredTier,
    counterpartyAgeDays: c.ageDays,
    counterpartySettledTxns: c.settledTxns,
    priceBandZ: c.priceBandZ, // int8; viem accepts JS number incl. negatives
    categoryCode: c.categoryIdx,
    leaseId: ZERO32,
    nonce: BigInt(c.nonce),
    revocationEpoch: BigInt(c.reqEpoch),
    leaseExpiry: BigInt(leaseExpiryS),
    coreImageDigest: c.reqImageApproved ? IMAGE : OTHER_IMAGE,
  };
}

async function tx(functionName: string, args: unknown[]) {
  const hash = await client.writeContract({ address: policyAddr, abi, functionName, args } as never);
  await client.waitForTransactionReceipt({ hash });
}

async function runOnChain(c: Case): Promise<SolResult> {
  const { t0, tSeed, tValidate, leaseExpiryS } = timesCache;

  await client.setNextBlockTimestamp({ timestamp: BigInt(t0) });
  await tx('setPolicy', [
    BigInt(c.cfg.perTxCap),
    BigInt(c.cfg.windowCap),
    BigInt(c.cfg.windowSeconds),
    BigInt(c.cfg.cumulativeCap),
    c.cfg.permitted,
    c.cfg.t2MinAge,
    c.cfg.t2MinSettled,
    c.cfg.t2MaxZ,
    BigInt(c.cfg.t2Cap),
  ]);

  if (c.approvedZero) await tx('revokeCoreImage', []);

  if (c.seed) {
    await client.setNextBlockTimestamp({ timestamp: BigInt(tSeed) });
    await tx('recordSpend', [BigInt(c.seed.amount), BigInt(c.seed.nonce)]);
  }

  await client.setNextBlockTimestamp({ timestamp: BigInt(tValidate) });
  await client.mine({ blocks: 1 });

  const req = paymentRequest(c, leaseExpiryS);
  const digest = (await client.readContract({
    address: policyAddr,
    abi,
    functionName: 'hashRequest',
    args: [req],
  })) as Hex;

  const agentSig = await sign({ hash: digest, privateKey: c.agentGood ? AGENT_PK : WRONG_PK, to: 'hex' });
  const coreSig = await sign({ hash: digest, privateKey: c.coreGood ? CORE_PK : WRONG_PK, to: 'hex' });

  try {
    const status = (await client.readContract({
      address: policyAddr,
      abi,
      functionName: 'validate',
      args: [req, agentSig, coreSig],
    })) as number;
    if (status === 0) return { outcome: 'APPROVED' };
    const bitmask = (await client.readContract({
      address: policyAddr,
      abi,
      functionName: 'softFailBitmask',
      args: [req],
    })) as number;
    return { outcome: 'HELD', bitmask: Number(bitmask) };
  } catch (err) {
    const reverted = (err as BaseError).walk?.((e) => e instanceof ContractFunctionRevertedError);
    const errorName =
      reverted instanceof ContractFunctionRevertedError ? (reverted.data?.errorName ?? 'Unknown') : 'Unknown';
    if (errorName === 'AccountFrozen') return { outcome: 'REFUSED', binding: null, errorName };
    const binding = ERROR_TO_PREDICATE[errorName];
    if (!binding) {
      throw new Error(`Unmapped revert "${errorName}" for case ${JSON.stringify(c)}\n${String(err)}`);
    }
    return { outcome: 'REFUSED', binding, errorName };
  }
}

// Expected soft-fail binding derived from a bitmask (first failing soft, 9<10<11).
function bindingFromBitmask(mask: number): PredicateName | null {
  if (mask & SOFT_FAIL_AGE) return 'counterpartyAge';
  if (mask & SOFT_FAIL_SETTLED) return 'counterpartySettled';
  if (mask & SOFT_FAIL_PRICE) return 'priceBand';
  return null;
}

// ---------------------------------------------------------------------------
//  Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const artifactPath = resolve(process.cwd(), '../../contracts/out/PolicyModule.sol/PolicyModule.json');
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  abi = artifact.abi;
  bytecode = artifact.bytecode.object as Hex;

  const owner = privateKeyToAccount(DEPLOYER_PK).address;
  const init = {
    owner,
    guardian: owner,
    agentSigner: agentAccount.address,
    coreSigner: coreAccount.address,
    coreImageDigest: IMAGE,
    perTxCapMinor: 1_000_000n,
    windowCapMinor: 1_500_000n,
    windowSeconds: 86_400n,
    cumulativeCapMinor: 1_500_000n,
    permittedCategories: (1n << 8n) - 1n, // all 8 categories (overwritten per case)
    tier2MinAgeDays: 30,
    tier2MinSettledTxns: 5,
    tier2MaxPriceBandZ: 2,
    tier2CapMinor: 500_000n,
    deadmanSeconds: BigInt(DEADMAN),
  };

  const head = await client.getBlock({ blockTag: 'latest' });
  deployTs = Number(head.timestamp) + 100; // safely ahead of anvil's wall-clock start
  await client.setNextBlockTimestamp({ timestamp: BigInt(deployTs) });
  const deployHash = await client.deployContract({ abi, bytecode, args: [init] } as never);
  const receipt = await client.waitForTransactionReceipt({ hash: deployHash });
  policyAddr = receipt.contractAddress!;

  // Pre-register the counterparty tiers and link the account (persist in S0).
  await tx('setAccount', [owner]);
  await tx('setCounterpartyTier', [ADDR.t1, 1]);
  await tx('setCounterpartyTier', [ADDR.t2, 2]);
  await tx('setCounterpartyTier', [ADDR.t3, 3]);

  const block = await client.getBlock({ blockTag: 'latest' });
  tSnap = Number(block.timestamp);
  baseSnapshot = await client.snapshot();
}, 120_000);

afterAll(() => {
  // anvil is managed externally; nothing to tear down.
});

// ---------------------------------------------------------------------------
//  The differential
// ---------------------------------------------------------------------------

describe('differential: TypeScript evaluator vs Solidity PolicyModule.validate', () => {
  it(`${N} seeded FactSheets agree`, async () => {
    const rng = mulberry32(SEED);
    let agree = 0;
    const failures: string[] = [];
    const outcomeCov: Record<string, number> = {};
    const bindingCov: Record<string, number> = {};

    for (let i = 0; i < N; i++) {
      const c = genCase(rng);
      const t = times(c, tSnap);
      timesCache = t;

      // reset chain to the clean snapshot, then re-arm a snapshot for next case
      await client.revert({ id: baseSnapshot });
      baseSnapshot = await client.snapshot();

      const sol = await runOnChain(c);
      const { fs, m, nowMs } = buildTs(c, t.tValidate, t.leaseExpiryS);
      const ts = evaluate(fs, m, { agent: c.agentGood, core: c.coreGood }, nowMs);

      let ok = ts.outcome === (sol.outcome as Outcome);
      if (ok && sol.outcome === 'REFUSED') {
        ok = ts.bindingPredicate === sol.binding;
      }
      if (ok && sol.outcome === 'HELD') {
        ok =
          ts.softFailBitmask === sol.bitmask && ts.bindingPredicate === bindingFromBitmask(sol.bitmask);
      }

      outcomeCov[ts.outcome] = (outcomeCov[ts.outcome] ?? 0) + 1;
      const bkey = ts.bindingPredicate ?? (ts.outcome === 'REFUSED' ? 'operational/frozen' : 'none');
      bindingCov[bkey] = (bindingCov[bkey] ?? 0) + 1;

      if (ok) {
        agree++;
      } else if (failures.length < 10) {
        failures.push(
          `CASE #${i} MISMATCH\n` +
            `  sol: ${JSON.stringify(sol)}\n` +
            `  ts : outcome=${ts.outcome} binding=${ts.bindingPredicate} bitmask=${ts.softFailBitmask}\n` +
            `  case: ${JSON.stringify(c, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n` +
            `  times: ${JSON.stringify(t)}`,
        );
      }
    }

    // eslint-disable-next-line no-console
    console.log(`\n${agree}/${N} agree`);
    // eslint-disable-next-line no-console
    console.log('outcome coverage:', JSON.stringify(outcomeCov));
    // eslint-disable-next-line no-console
    console.log('binding coverage:', JSON.stringify(bindingCov));
    if (failures.length > 0) {
      throw new Error(`${N - agree}/${N} mismatches. First ${failures.length}:\n\n${failures.join('\n\n')}`);
    }
    expect(agree).toBe(N);
  });
});
