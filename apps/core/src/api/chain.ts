/**
 * The only place in the core that broadcasts a transaction.
 *
 * FIX.md TASK 2: an approved payment must become a real, explorer-verifiable
 * transaction on Base Sepolia. Everything here therefore fails closed — there is
 * no code path that returns a transaction hash which did not come back from a
 * mined receipt. A missing key, an unreachable RPC or a revert all end in a
 * thrown error or a 503/422 at the route, never in a fabricated hash.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import {
  INRX_ADDRESS,
  POLICY_MODULE_ADDRESS,
  REKHA_ACCOUNT_ADDRESS,
  type PaymentRequestStruct,
} from '../signing/constants.js';

// ---------------------------------------------------------------------------
//  ABIs
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ABI_DIR = resolve(here, '../../../../packages/contracts-abi');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadAbi(name: string): any[] {
  return JSON.parse(readFileSync(resolve(ABI_DIR, `${name}.json`), 'utf8')).abi;
}

/**
 * RekhaAccount.execute's reverts come from inside PolicyModule.validate and
 * bubble up as raw data. Decoding them by name needs PolicyModule's error
 * fragments, which RekhaAccount's own ABI does not declare — hence this merged
 * ABI. Same reasoning as test/execute.fork.test.ts, which is the working
 * reference for this call.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withErrorsFrom(base: any[], extra: any[]): any[] {
  const known = new Set(base.filter((f) => f.type === 'error').map((f) => f.name));
  return [...base, ...extra.filter((f) => f.type === 'error' && !known.has(f.name))];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let executeAbiCache: any[] | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let inrxAbiCache: any[] | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function executeAbi(): any[] {
  executeAbiCache ??= withErrorsFrom(loadAbi('RekhaAccount'), loadAbi('PolicyModule'));
  return executeAbiCache;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function inrxAbi(): any[] {
  inrxAbiCache ??= loadAbi('INRx');
  return inrxAbiCache;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let policyAbiCache: any[] | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function policyAbi(): any[] {
  policyAbiCache ??= loadAbi('PolicyModule');
  return policyAbiCache;
}

// ---------------------------------------------------------------------------
//  Configuration
// ---------------------------------------------------------------------------

const RPC_URL = process.env['BASE_SEPOLIA_RPC'] || 'https://sepolia.base.org';

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

function envKey(name: string): Hex | null {
  const v = process.env[name];
  return v !== undefined && PRIVATE_KEY_RE.test(v) ? (v as Hex) : null;
}

function envAddress(name: string, fallback: Address | null): Address | null {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  try {
    return getAddress(v);
  } catch {
    return null;
  }
}

/**
 * The two things settlement cannot proceed without. FIX.md: if either is
 * missing the route returns 503 CORE_UNAVAILABLE — never a fake hash.
 *
 * The core signer also pays the gas. `execute` is authorized by the two
 * signatures inside the request, not by msg.sender (see execute.fork.test.ts,
 * which broadcasts from an unrelated anvil account), so the broadcaster only
 * needs a funded key.
 */
export type SettlementConfig = {
  coreSignerKey: Hex;
  /** Key that pays gas. See broadcasterKey() — NOT necessarily the core signer. */
  broadcasterKey: Hex;
  rekhaAccount: Address;
};

/**
 * The key that pays for the transaction.
 *
 * `execute` is authorized by the two signatures inside the request, not by
 * msg.sender (test/execute.fork.test.ts broadcasts from an unrelated anvil
 * account and it succeeds), so the broadcaster only has to be funded. It matters
 * because the deployed core signer 0xB18D… holds 0 ETH on Base Sepolia and
 * therefore cannot send anything: broadcasting from it fails every time.
 *
 * Precedence: an explicit broadcaster, else the deployer (funded, and the same
 * account that deployed these contracts), else the core signer.
 */
function broadcasterKey(coreSignerKey: Hex): Hex {
  return envKey('SETTLEMENT_BROADCASTER_PRIVATE_KEY') ?? envKey('DEPLOYER_PRIVATE_KEY') ?? coreSignerKey;
}

export function settlementConfig(): SettlementConfig | null {
  const coreSignerKey = envKey('CORE_SIGNER_PRIVATE_KEY') ?? envKey('REKHA_CORE_PRIVATE_KEY');
  const rekhaAccount = envAddress('REKHA_ACCOUNT_ADDRESS', REKHA_ACCOUNT_ADDRESS);
  if (coreSignerKey === null || rekhaAccount === null) return null;
  return { coreSignerKey, broadcasterKey: broadcasterKey(coreSignerKey), rekhaAccount };
}

export function publicClient() {
  return createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
}

// ---------------------------------------------------------------------------
//  Errors
// ---------------------------------------------------------------------------

/**
 * The contract refused the payment. This is a SUCCESSFUL demo outcome — it is
 * the enforcement the product claims — so the route renders it as a 422 naming
 * the custom error, not as a 500.
 */
export class SettlementRevertedError extends Error {
  readonly code = 'SETTLEMENT_REVERTED' as const;
  constructor(readonly errorName: string) {
    super(`RekhaAccount.execute reverted with ${errorName}`);
    this.name = 'SettlementRevertedError';
  }
}

/** The revert error name from a failed contract call, or 'Unknown'. */
export function revertName(err: unknown): string {
  const reverted = (err as BaseError).walk?.((e) => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? (reverted.data?.errorName ?? 'Unknown') : 'Unknown';
}

// ---------------------------------------------------------------------------
//  Settlement
// ---------------------------------------------------------------------------

export type SettlementReceipt = { txHash: Hex; blockNumber: number };

/**
 * Broadcasts RekhaAccount.execute and waits for the receipt.
 *
 * Simulates first so a policy revert is caught with its decoded custom error
 * name (a mined-and-reverted receipt does not carry one), then writes. Both the
 * hash and the block number come off the receipt, so a value can only be
 * returned for a transaction that actually landed.
 *
 * Throws SettlementRevertedError if the contract refuses, and lets anything else
 * (RPC down, key rejected) propagate. Neither returns a hash.
 */
export async function broadcastExecute(
  config: SettlementConfig,
  request: PaymentRequestStruct,
  agentSig: Hex,
  coreSig: Hex,
): Promise<SettlementReceipt> {
  const account = privateKeyToAccount(config.broadcasterKey);
  const pub = publicClient();
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC_URL) });

  try {
    await pub.simulateContract({
      address: config.rekhaAccount,
      abi: executeAbi(),
      functionName: 'execute',
      args: [request, agentSig, coreSig],
      account,
    } as never);
  } catch (err) {
    const name = revertName(err);
    if (name !== 'Unknown') throw new SettlementRevertedError(name);
    // An undecodable failure is still a failure. Surface it rather than
    // broadcasting a transaction we already know will not succeed.
    throw err;
  }

  const txHash = await wallet.writeContract({
    address: config.rekhaAccount,
    abi: executeAbi(),
    functionName: 'execute',
    args: [request, agentSig, coreSig],
  } as never);

  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });

  // Simulation passed but the transaction still reverted (state moved under us).
  // Fail closed: no hash is returned for a payment that did not happen.
  if (receipt.status !== 'success') {
    throw new SettlementRevertedError('Unknown');
  }

  return { txHash: receipt.transactionHash, blockNumber: Number(receipt.blockNumber) };
}

// ---------------------------------------------------------------------------
//  PolicyModule reads
// ---------------------------------------------------------------------------
//
// Predicates 6 (nonce) and 8 (counterparty tier) are the two the off-chain
// evaluator cannot answer from its own memory: both live in PolicyModule
// storage, which any other process may have moved. Reading them means an
// APPROVED trace and a successful execute() agree about the same facts, instead
// of the core approving something the chain then reverts.
//
// Both fail closed. An RPC failure resolves to "nonce already used" / "tier 0
// unknown", each of which the evaluator refuses on.

const policyRead = (functionName: string, args: unknown[] = []) =>
  publicClient().readContract({ address: POLICY_MODULE_ADDRESS, abi: policyAbi(), functionName, args });

/** Has PolicyModule already burned this nonce? Unreachable chain => treat as used. */
export async function nonceUsedOnChain(nonce: number): Promise<boolean> {
  try {
    return (await policyRead('usedNonces', [BigInt(nonce)])) as boolean;
  } catch {
    return true;
  }
}

/**
 * The counterparty's tier as PolicyModule holds it — the authoritative source
 * for predicate 8.
 *
 * Deliberately not the FactSheet and not the vendor catalogue: both are reachable
 * by the agent, and trusting either is precisely the counterfeit-storefront
 * attack. 0 means unknown, which the evaluator blocks.
 */
export async function counterpartyTierOnChain(address: string): Promise<number> {
  try {
    return Number((await policyRead('counterpartyTier', [getAddress(address)])) as number | bigint);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
//  INRx balance (FIX.md TASK 2: the account must actually hold tokens)
// ---------------------------------------------------------------------------

export async function inrxBalanceOf(who: Address): Promise<bigint> {
  return (await publicClient().readContract({
    address: INRX_ADDRESS,
    abi: inrxAbi(),
    functionName: 'balanceOf',
    args: [who],
  })) as bigint;
}

/**
 * Mints INRx to the RekhaAccount using DEPLOYER_PRIVATE_KEY.
 *
 * Only reachable from the operator script; the request path never mints. Returns
 * the real mint transaction hash.
 */
export async function mintInrx(to: Address, amountMinor: bigint): Promise<SettlementReceipt> {
  const deployerKey = envKey('DEPLOYER_PRIVATE_KEY');
  if (deployerKey === null) {
    throw new Error('DEPLOYER_PRIVATE_KEY is not set; refusing to mint.');
  }
  const account = privateKeyToAccount(deployerKey);
  const pub = publicClient();
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC_URL) });

  const txHash = await wallet.writeContract({
    address: INRX_ADDRESS,
    abi: inrxAbi(),
    functionName: 'mint',
    args: [to, amountMinor],
  } as never);

  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error(`mint reverted (tx ${txHash})`);
  return { txHash: receipt.transactionHash, blockNumber: Number(receipt.blockNumber) };
}
