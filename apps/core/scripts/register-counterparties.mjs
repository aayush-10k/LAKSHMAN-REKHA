/**
 * Registers the demo vendors in PolicyModule's counterparty registry.
 *
 * Operator script, run by hand with the owner key — the server never calls it.
 * It exists because PolicyModule.validate reads the tier from its OWN storage
 * (`if (tier != 1 && tier != 2) revert CounterpartyBlocked()`), deliberately
 * ignoring whatever tier the FactSheet claims. An address that was never
 * registered is tier 0, so with an empty registry NO payment can ever settle,
 * whatever the policy says.
 *
 * Tiers come from apps/vendorsim/seed/vendors.js, which is the registry of
 * record for the demo. This only writes data the registry already asserts; it
 * does not touch caps, categories or any other enforcement parameter.
 *
 *   node scripts/register-counterparties.mjs [--dry-run]
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { vendors } from '../../vendorsim/seed/vendors.js';

const here = dirname(fileURLToPath(import.meta.url));
const policyAbi = JSON.parse(
  readFileSync(resolve(here, '../../../packages/contracts-abi/PolicyModule.json'), 'utf8'),
).abi;

const POLICY = '0x933bb10252ec2b133f28b7d5edf1d303c3384d87';
const RPC = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const DRY = process.argv.includes('--dry-run');

const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  throw new Error('DEPLOYER_PRIVATE_KEY is not set; setCounterpartyTier is onlyOwner.');
}
const account = privateKeyToAccount(key);

const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });

const owner = await pub.readContract({ address: POLICY, abi: policyAbi, functionName: 'owner' });
if (getAddress(owner) !== account.address) {
  throw new Error(`DEPLOYER_PRIVATE_KEY is ${account.address} but PolicyModule owner is ${owner}.`);
}

for (const v of vendors) {
  const address = getAddress(v.address);
  const current = Number(
    await pub.readContract({ address: POLICY, abi: policyAbi, functionName: 'counterpartyTier', args: [address] }),
  );
  if (current === v.tier) {
    console.log(`skip  ${v.id.padEnd(16)} ${address} already tier ${current}`);
    continue;
  }
  if (DRY) {
    console.log(`would ${v.id.padEnd(16)} ${address} tier ${current} -> ${v.tier}`);
    continue;
  }
  const hash = await wallet.writeContract({
    address: POLICY,
    abi: policyAbi,
    functionName: 'setCounterpartyTier',
    args: [address, v.tier],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`${receipt.status === 'success' ? 'set  ' : 'FAIL '} ${v.id.padEnd(16)} ${address} tier ${v.tier}  ${hash}`);
}
