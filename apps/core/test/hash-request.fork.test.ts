import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, http, getAddress, type Address, type Hex } from 'viem';
import { hashRequest } from '../src/signing/request.js';
import { CHAIN_ID, POLICY_MODULE_ADDRESS, type PaymentRequestStruct } from '../src/signing/constants.js';

/**
 * THE canary test.
 *
 * `hashRequest` is the one thing in this package that has to be byte-for-byte
 * identical to Solidity. If the local digest and PolicyModule._digest disagree by
 * a single bit, every signature the core produces recovers to the wrong address
 * and reverts with InvalidCoreSignature — the whole signing service is worthless
 * and no other test in this repo would notice.
 *
 * So this compares against the *actually deployed* PolicyModule at
 * 0x933bb10252ec2b133f28b7d5edf1d303c3384d87, reached through an anvil fork of
 * Base Sepolia, rather than against a locally compiled copy. A locally compiled
 * copy could have drifted from what is on chain; the deployed bytecode cannot.
 *
 * Requires: anvil --fork-url https://sepolia.base.org --port 8546
 */

const FORK_RPC = 'http://127.0.0.1:8546';
const N = 20;
const SEED = 0x5eed_a7b1;

// --- seeded PRNG (mulberry32), same approach as differential.test.ts ---------
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

const u32 = (r: Rng) => Math.floor(r() * 4294967296) >>> 0;
const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
/** A random unsigned integer of `bits` bits, assembled 32 bits at a time. */
function bigUint(r: Rng, bits: number): bigint {
  let v = 0n;
  for (let got = 0; got < bits; got += 32) v = (v << 32n) | BigInt(u32(r));
  return v & ((1n << BigInt(bits)) - 1n);
}
function randomHexBytes(r: Rng, n: number): Hex {
  let s = '0x';
  for (let i = 0; i < n; i++) s += u32(r).toString(16).padStart(8, '0').slice(0, 2);
  return s as Hex;
}

/**
 * Deliberately spans the full width of every field, including the ones that are
 * easiest to get wrong: a negative int8 (sign extension), uint64s at the top of
 * their range (truncation), and a uint256 amount larger than Number can hold.
 */
function randomRequest(r: Rng): PaymentRequestStruct {
  return {
    amountMinor: bigUint(r, 256),
    counterparty: getAddress(randomHexBytes(r, 20)),
    counterpartyTier: int(r, 0, 255),
    counterpartyAgeDays: int(r, 0, 65_535),
    counterpartySettledTxns: u32(r),
    priceBandZ: int(r, -128, 127),
    categoryCode: int(r, 0, 255),
    leaseId: randomHexBytes(r, 32),
    nonce: bigUint(r, 64),
    revocationEpoch: bigUint(r, 64),
    leaseExpiry: bigUint(r, 64),
    coreImageDigest: randomHexBytes(r, 32),
  };
}

const client = createPublicClient({ transport: http(FORK_RPC) });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let abi: any;

beforeAll(async () => {
  const artifactPath = resolve(process.cwd(), '../out/PolicyModule.sol/PolicyModule.json');
  abi = JSON.parse(readFileSync(artifactPath, 'utf8')).abi;

  // Guard rails: a fork pointing at the wrong chain, or an address with no code,
  // would make this test pass vacuously or fail for the wrong reason.
  const chainId = await client.getChainId();
  expect(BigInt(chainId), 'fork must be Base Sepolia (84532)').toBe(CHAIN_ID);

  const code = await client.getCode({ address: POLICY_MODULE_ADDRESS as Address });
  expect(code, 'no bytecode at the deployed PolicyModule address').toBeDefined();
  expect((code ?? '0x').length, 'deployed PolicyModule has empty bytecode').toBeGreaterThan(2);
}, 120_000);

describe('hashRequest parity with the deployed PolicyModule', () => {
  it(`matches the deployed contract for ${N} random requests`, async () => {
    const rng = mulberry32(SEED);
    const mismatches: string[] = [];

    for (let i = 0; i < N; i++) {
      const req = randomRequest(rng);

      const onChain = (await client.readContract({
        address: POLICY_MODULE_ADDRESS as Address,
        abi,
        functionName: 'hashRequest',
        args: [req],
      })) as Hex;

      const local = hashRequest(req);

      if (local !== onChain) {
        mismatches.push(
          `#${i}\n  on-chain: ${onChain}\n  local   : ${local}\n  req: ` +
            JSON.stringify(req, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
        );
      }
    }

    if (mismatches.length > 0) {
      throw new Error(`${mismatches.length}/${N} digest mismatches:\n\n${mismatches.join('\n\n')}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('is domain-separated: a different policy address gives a different digest', async () => {
    const req = randomRequest(mulberry32(1));
    const other = getAddress('0x' + '11'.repeat(20));
    expect(hashRequest(req)).not.toBe(hashRequest(req, { chainId: CHAIN_ID, policyAddress: other }));
    expect(hashRequest(req)).not.toBe(
      hashRequest(req, { chainId: 1n, policyAddress: POLICY_MODULE_ADDRESS as Address }),
    );
  });
});
