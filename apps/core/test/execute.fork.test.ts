import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createTestClient,
  http,
  publicActions,
  walletActions,
  getAddress,
  BaseError,
  ContractFunctionRevertedError,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { issueLease, clearLeaseStore, type Lease } from '../src/lease/index.js';
import { resetKeys, setAgentKey, setCoreKey } from '../src/keys.js';
import { agentSign, coreSign } from '../src/signing/sign.js';
import {
  INRX_ADDRESS,
  POLICY_MODULE_ADDRESS,
  REKHA_ACCOUNT_ADDRESS,
  type PaymentRequestStruct,
} from '../src/signing/constants.js';
import type { FactSheet, MandateState } from '../src/types.js';
import { factSheet, mandateState, TEST_AGENT_PK, TEST_CORE_PK, TIER1_COUNTERPARTY } from './fixtures.js';

/**
 * 2-of-2 against the real deployed contracts.
 *
 * Runs on an anvil fork of Base Sepolia and talks to the actual deployed INRx,
 * PolicyModule and RekhaAccount at their real addresses — so the digest the core
 * signs is the production digest, address and chain id included, not one
 * manufactured for the test.
 *
 * The one thing the fork has to fake is key custody: the deployed module points
 * at core signer 0xB18D... and agent signer 0x6E19..., whose private keys are not
 * in this repo (and .env is off limits). So the test impersonates the module
 * owner and rotates both signers to deterministic test keys via the contract's
 * own setSigners. Everything else — the policy, the caps, the wiring, the
 * validate/execute path — is exactly what is deployed.
 *
 * Requires: anvil --fork-url https://sepolia.base.org --port 8546
 */

const FORK_RPC = 'http://127.0.0.1:8546';
const OWNER = getAddress('0xA5142D53D56bCCC98C5cC38C6F7d3965f6DabFD2');
const EXECUTOR_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex; // anvil #0
const COUNTERPARTY = getAddress(TIER1_COUNTERPARTY);
const AMOUNT = 940_000n; // ₹9,400, under the deployed perTxCap of 1_000_000

const client = createTestClient({
  mode: 'anvil',
  chain: baseSepolia,
  transport: http(FORK_RPC),
  account: privateKeyToAccount(EXECUTOR_PK),
})
  .extend(publicActions)
  .extend(walletActions);

function loadAbi(name: string): unknown[] {
  const p = resolve(process.cwd(), `../out/${name}.sol/${name}.json`);
  return JSON.parse(readFileSync(p, 'utf8')).abi;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let policyAbi: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let accountAbi: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tokenAbi: any;
/**
 * RekhaAccount.execute's reverts come from inside PolicyModule.validate and bubble
 * up as raw data. Decoding them by name needs PolicyModule's error fragments, which
 * RekhaAccount's own ABI does not declare — hence this merged ABI for calls.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let executeAbi: any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withErrorsFrom(base: any[], extra: any[]): any[] {
  const known = new Set(base.filter((f) => f.type === 'error').map((f) => f.name));
  return [...base, ...extra.filter((f) => f.type === 'error' && !known.has(f.name))];
}

/** On-chain policy values, read rather than assumed, so the mandate mirrors reality. */
let onChainPolicyHash: Hex;
let onChainEpoch: number;
let onChainImage: Hex;

/**
 * anvil keeps state for the life of the process, so without snapshots the first
 * successful execute() burns its nonce and every later run of this file reverts
 * with NonceAlreadyUsed. `pristine` is taken before any setup and restored at the
 * end so the node is left as the suite found it; `clean` is re-armed per test.
 */
let pristine: Hex;
let clean: Hex;

async function asOwner(address: Address, abi: unknown, functionName: string, args: unknown[]) {
  const hash = await client.writeContract({
    address,
    abi,
    functionName,
    args,
    account: OWNER,
  } as never);
  await client.waitForTransactionReceipt({ hash });
}

/** The revert error name from a failed contract call, or 'Unknown'. */
function revertName(err: unknown): string {
  const reverted = (err as BaseError).walk?.((e) => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? (reverted.data?.errorName ?? 'Unknown') : 'Unknown';
}

beforeAll(async () => {
  policyAbi = loadAbi('PolicyModule');
  accountAbi = loadAbi('RekhaAccount');
  tokenAbi = loadAbi('INRx');
  executeAbi = withErrorsFrom(accountAbi, policyAbi);

  expect(BigInt(await client.getChainId()), 'fork must be Base Sepolia').toBe(84532n);
  pristine = await client.snapshot();

  // Impersonate the deployment owner and rotate the signers to test keys. This is
  // the only thing the test fakes; see the header comment.
  await client.setBalance({ address: OWNER, value: 10n ** 20n });
  await client.impersonateAccount({ address: OWNER });

  await asOwner(POLICY_MODULE_ADDRESS, policyAbi, 'setSigners', [
    privateKeyToAccount(TEST_AGENT_PK).address,
    privateKeyToAccount(TEST_CORE_PK).address,
  ]);
  await asOwner(POLICY_MODULE_ADDRESS, policyAbi, 'setCounterpartyTier', [COUNTERPARTY, 1]);
  // Keep the deadman from lapsing while the test walks the clock forward.
  await asOwner(POLICY_MODULE_ADDRESS, policyAbi, 'heartbeat', []);
  // The deployed account holds no INRx (total supply is 0 on Base Sepolia).
  await asOwner(INRX_ADDRESS, tokenAbi, 'mint', [REKHA_ACCOUNT_ADDRESS, 5_000_000n]);

  const read = (fn: string) =>
    client.readContract({ address: POLICY_MODULE_ADDRESS, abi: policyAbi, functionName: fn });
  onChainPolicyHash = (await read('policyHash')) as Hex;
  onChainEpoch = Number((await read('revocationEpoch')) as bigint);
  onChainImage = (await read('coreImageDigest')) as Hex;

  clean = await client.snapshot();
}, 180_000);

afterAll(async () => {
  // Leave the node as we found it, so a re-run starts from the same place.
  await client.revert({ id: pristine });
});

beforeEach(async () => {
  // evm_revert consumes the snapshot, so re-arm one for the next test.
  await client.revert({ id: clean });
  clean = await client.snapshot();

  resetKeys();
  clearLeaseStore();
  setCoreKey(TEST_CORE_PK);
  setAgentKey(TEST_AGENT_PK);
});

/** Advances the chain to a known timestamp and builds a matching signed request. */
async function armRequest(nonce: number): Promise<{
  req: PaymentRequestStruct;
  coreSig: Hex;
  agentSig: Hex;
  blockTs: number;
}> {
  const head = await client.getBlock({ blockTag: 'latest' });
  const blockTs = Number(head.timestamp) + 2;
  await client.setNextBlockTimestamp({ timestamp: BigInt(blockTs) });
  await client.mine({ blocks: 1 });

  const nowMs = blockTs * 1000;

  const base: MandateState = mandateState({
    revocationEpoch: onChainEpoch,
    policyHash: onChainPolicyHash,
    coreImageDigest: onChainImage.toLowerCase(),
  });
  const lease: Lease = await issueLease('agent-1', base, nowMs);

  const m: MandateState = {
    ...base,
    requestRevocationEpoch: lease.revocationEpoch,
    leaseExpiryS: Math.floor(lease.expiresAtMs / 1000),
  };
  const fs: FactSheet = factSheet({
    leaseId: lease.leaseId,
    nonce,
    amountMinor: Number(AMOUNT),
    coreImageDigest: onChainImage.toLowerCase(),
  });

  const res = await coreSign(fs, m, lease, nowMs);
  expect(res.trace.outcome, 'fixture must be APPROVED for this test to mean anything').toBe('APPROVED');
  expect(res.partialSig).not.toBeNull();

  const agentSig = await agentSign(res.request!);
  return { req: res.request!, coreSig: res.partialSig!, agentSig, blockTs };
}

describe('2-of-2 against the deployed RekhaAccount.execute', () => {
  it('rejects the agent signature alone', async () => {
    const { req, agentSig } = await armRequest(101);

    // "Alone" means the agent has nothing but its own share: supplying it in both
    // slots is the strongest thing a lone agent could try.
    const err = await client
      .simulateContract({
        address: REKHA_ACCOUNT_ADDRESS,
        abi: executeAbi,
        functionName: 'execute',
        args: [req, agentSig, agentSig],
      } as never)
      .then(() => null)
      .catch((e) => e);

    expect(err, 'agent-only execution must revert').not.toBeNull();
    expect(revertName(err)).toBe('InvalidCoreSignature');
  });

  it('rejects the core signature alone', async () => {
    const { req, coreSig } = await armRequest(102);

    const err = await client
      .simulateContract({
        address: REKHA_ACCOUNT_ADDRESS,
        abi: executeAbi,
        functionName: 'execute',
        args: [req, coreSig, coreSig],
      } as never)
      .then(() => null)
      .catch((e) => e);

    expect(err, 'core-only execution must revert').not.toBeNull();
    expect(revertName(err)).toBe('InvalidAgentSignature');
  });

  it('accepts agent + core and actually moves the money', async () => {
    const { req, coreSig, agentSig, blockTs } = await armRequest(103);

    const balanceOf = (who: Address) =>
      client.readContract({
        address: INRX_ADDRESS,
        abi: tokenAbi,
        functionName: 'balanceOf',
        args: [who],
      }) as Promise<bigint>;

    const cpBefore = await balanceOf(COUNTERPARTY);
    const acctBefore = await balanceOf(REKHA_ACCOUNT_ADDRESS);

    await client.setNextBlockTimestamp({ timestamp: BigInt(blockTs + 1) });
    const hash = await client.writeContract({
      address: REKHA_ACCOUNT_ADDRESS,
      abi: executeAbi,
      functionName: 'execute',
      args: [req, agentSig, coreSig],
    } as never);
    const receipt = await client.waitForTransactionReceipt({ hash });

    expect(receipt.status).toBe('success');
    expect(await balanceOf(COUNTERPARTY)).toBe(cpBefore + AMOUNT);
    expect(await balanceOf(REKHA_ACCOUNT_ADDRESS)).toBe(acctBefore - AMOUNT);

    // The nonce is burned on chain, which is what makes the request single-use.
    const used = (await client.readContract({
      address: POLICY_MODULE_ADDRESS,
      abi: policyAbi,
      functionName: 'usedNonces',
      args: [req.nonce],
    })) as boolean;
    expect(used).toBe(true);
  });

  it('rejects a request whose core signature covers different facts', async () => {
    const { req, coreSig, agentSig } = await armRequest(104);
    // Same signatures, one paise more. The digest changes, so both recoveries miss.
    const tampered = { ...req, amountMinor: req.amountMinor + 1n };

    const err = await client
      .simulateContract({
        address: REKHA_ACCOUNT_ADDRESS,
        abi: executeAbi,
        functionName: 'execute',
        args: [tampered, agentSig, coreSig],
      } as never)
      .then(() => null)
      .catch((e) => e);

    expect(err, 'tampered request must revert').not.toBeNull();
    expect(revertName(err)).toBe('InvalidAgentSignature');
  });
});
