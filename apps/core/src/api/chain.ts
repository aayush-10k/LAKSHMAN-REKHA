/**
 * The only place in the core that broadcasts a transaction.
 *
 * an approved payment must become a real, explorer-verifiable
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

/**
 * Exported for the agent runner's rail-bypass probe (M1), which calls the same
 * `execute` entry point this module settles through and needs the same merged
 * error fragments to name what it gets back. Read-only ABI data, not authority:
 * nothing about exporting it lets the agent process sign or settle anything.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function executeAbi(): any[] {
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
 * The two things settlement cannot proceed without.: if either is
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

/**
 * Has PolicyModule already burned this nonce? Unreachable chain => treat as used.
 *
 * Failing closed is right. Failing closed SILENTLY is not: the refusal that
 * comes out the other end names predicate 6 and reads exactly like a replay
 * attack, so a dead RPC on stage looks like the demo catching an attack rather
 * than the demo being unable to see the chain. The log line is the only thing
 * that tells those two apart.
 */
export async function nonceUsedOnChain(nonce: number): Promise<boolean> {
  try {
    return (await policyRead('usedNonces', [BigInt(nonce)])) as boolean;
  } catch (e) {
    console.warn(
      `[chain] usedNonces(${nonce}) unreadable, failing closed as ALREADY USED — ` +
      `predicate 6 will refuse. This is an RPC failure, not a replay: ${(e as Error).message}`,
    );
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
 *
 * Same reason as `nonceUsedOnChain` for the log line: an unreadable tier and a
 * genuinely unregistered counterparty both surface as `counterpartyTier`
 * refusals with registry 0, and on stage that is the difference between "the
 * chain caught the counterfeit" and "we cannot reach the chain".
 */
export async function counterpartyTierOnChain(address: string): Promise<number> {
  try {
    return Number((await policyRead('counterpartyTier', [getAddress(address)])) as number | bigint);
  } catch (e) {
    console.warn(
      `[chain] counterpartyTier(${address}) unreadable, failing closed as tier 0 — ` +
      `predicate 8 will refuse. This is an RPC failure, not an unregistered ` +
      `vendor: ${(e as Error).message}`,
    );
    return 0;
  }
}

// ---------------------------------------------------------------------------
//  Policy snapshot
// ---------------------------------------------------------------------------

/**
 * Every enforcement parameter PolicyModule currently holds, plus the live
 * accounting counters.
 *
 * The core's in-memory mandate is seeded from this at boot instead of from
 * hardcoded constants. The constants had drifted: they said perTxCap ₹10,000 and
 * "OTHER only" while the chain said ₹25,000 and everything-but-SOFTWARE, so the
 * off-chain evaluator REFUSED payments the chain would have accepted, and the
 * decision panel explained a policy nobody was enforcing.
 *
 * windowSpentMinor/cumulativeSpentMinor matter as much as the caps: settling
 * moves them on chain, and an off-chain zero would make predicates 13 and 14
 * looser than PolicyModule's, which is the direction that produces an APPROVED
 * trace followed by a revert.
 */
export type DeployedPolicySnapshot = {
  perTxCapMinor: number;
  windowCapMinor: number;
  windowSeconds: number;
  cumulativeCapMinor: number;
  permittedCategories: bigint;
  tier2MinAgeDays: number;
  tier2MinSettledTxns: number;
  tier2MaxPriceBandZ: number;
  tier2CapMinor: number;
  windowStartS: number;
  windowSpentMinor: number;
  cumulativeSpentMinor: number;
  revocationEpoch: number;
  policyHash: string;
  coreImageDigest: string;
  deadmanSeconds: number;
  frozen: boolean;
};

const POLICY_FIELDS = [
  'perTxCapMinor', 'windowCapMinor', 'windowSeconds', 'cumulativeCapMinor',
  'permittedCategories', 'tier2MinAgeDays', 'tier2MinSettledTxns',
  'tier2MaxPriceBandZ', 'tier2CapMinor', 'windowStart', 'windowSpentMinor',
  'cumulativeSpentMinor', 'revocationEpoch', 'policyHash', 'coreImageDigest',
  'deadmanSeconds', 'frozen',
] as const;

/**
 * Reads the whole policy in one batch. Returns null if ANY field is unreadable —
 * a half-read policy is worse than no read, because the caller would mix live
 * caps with stale counters and have no way to tell.
 */
export async function readDeployedPolicy(): Promise<DeployedPolicySnapshot | null> {
  try {
    const values = await Promise.all(POLICY_FIELDS.map((f) => policyRead(f)));
    const raw = Object.fromEntries(POLICY_FIELDS.map((f, i) => [f, values[i]])) as Record<string, unknown>;
    const num = (k: string) => Number(raw[k] as number | bigint);
    return {
      perTxCapMinor: num('perTxCapMinor'),
      windowCapMinor: num('windowCapMinor'),
      windowSeconds: num('windowSeconds'),
      cumulativeCapMinor: num('cumulativeCapMinor'),
      permittedCategories: BigInt(raw['permittedCategories'] as bigint | number),
      tier2MinAgeDays: num('tier2MinAgeDays'),
      tier2MinSettledTxns: num('tier2MinSettledTxns'),
      tier2MaxPriceBandZ: num('tier2MaxPriceBandZ'),
      tier2CapMinor: num('tier2CapMinor'),
      windowStartS: num('windowStart'),
      windowSpentMinor: num('windowSpentMinor'),
      cumulativeSpentMinor: num('cumulativeSpentMinor'),
      revocationEpoch: num('revocationEpoch'),
      policyHash: raw['policyHash'] as string,
      coreImageDigest: raw['coreImageDigest'] as string,
      deadmanSeconds: num('deadmanSeconds'),
      frozen: raw['frozen'] as boolean,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
//  INRx balance
// ---------------------------------------------------------------------------

/** The account whose INRx balance is the wallet balance the console shows. */
export function rekhaAccountAddress(): Address | null {
  return envAddress('REKHA_ACCOUNT_ADDRESS', REKHA_ACCOUNT_ADDRESS);
}

/**
 * INRx balance, optionally pinned to a specific block.
 *
 * Pass `atBlock` when reading straight after a settlement. Without it the read
 * goes to 'latest', and https://sepolia.base.org is a load balancer: the node
 * that answers may not have the block the receipt just came from. That produced
 * a settlement whose txHash was real, whose on-chain balance had genuinely moved
 * by ₹9,520, and whose reported balanceAfterMinor was the PRE-payment figure —
 * a wrong number presented as fact. Pinned to the receipt's block, a node that
 * is behind raises instead of answering from stale state.
 */
export async function inrxBalanceOf(who: Address, atBlock?: number): Promise<bigint> {
  return (await publicClient().readContract({
    address: INRX_ADDRESS,
    abi: inrxAbi(),
    functionName: 'balanceOf',
    args: [who],
    ...(atBlock === undefined ? {} : { blockNumber: BigInt(atBlock) }),
  })) as bigint;
}

/**
 * inrxBalanceOf pinned to `atBlock`, retried while the RPC has not caught up.
 *
 * Only the "node is behind" case is worth retrying, and it resolves in a block
 * or two. After the last attempt the error propagates: the caller then reports
 * that the balance is unknown rather than substituting a plausible number.
 */
export async function inrxBalanceAtBlock(
  who: Address,
  atBlock: number,
  attempts = 4,
  delayMs = 700,
): Promise<bigint> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await inrxBalanceOf(who, atBlock);
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
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
