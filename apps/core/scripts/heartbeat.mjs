/**
 * Pings PolicyModule's dead-man switch.
 *
 * ── Why this script exists ────────────────────────────────────────────────
 * PolicyModule freezes itself if the owner stops checking in:
 *
 *   validate()      -> if (frozen || _deadmanLapsed()) revert AccountFrozen();
 *   checkDeadman()  -> external, NO access control. Anyone may call it, and
 *                      once the heartbeat has lapsed it sets frozen = true.
 *
 * `frozen` is assigned in exactly one place in the contract and there is no
 * unfreeze function. So a lapsed deadman is not a temporary outage — it is a
 * permanently bricked deployment that can only be replaced by redeploying, and
 * any passer-by who reads the verified source on Basescan can trigger it.
 *
 * That is correct fail-closed design and it is why the switch exists. It is
 * also a live grenade under a demo: measured on 2026-08-04 the heartbeat lapsed
 * roughly one day AFTER the 8 Aug slot, with no margin for the event moving.
 *
 * Run it before any rehearsal or demo. It extends the deadline by
 * deadmanSeconds (7 days) from now and changes nothing else — no caps, no
 * categories, no epoch, no registry.
 *
 *   node apps/core/scripts/heartbeat.mjs [--dry-run]
 *
 * Load the env first, or DEPLOYER_PRIVATE_KEY will be unset:
 *   set -a; . ./.env; set +a
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const here = dirname(fileURLToPath(import.meta.url));
const policyAbi = JSON.parse(
  readFileSync(resolve(here, '../../../packages/contracts-abi/PolicyModule.json'), 'utf8'),
).abi;

const POLICY = '0x933bb10252ec2b133f28b7d5edf1d303c3384d87';
const RPC = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const DRY = process.argv.includes('--dry-run');

const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

const read = (functionName) => pub.readContract({ address: POLICY, abi: policyAbi, functionName });

const [lastHeartbeat, deadmanSeconds, frozen, block] = await Promise.all([
  read('lastHeartbeat'),
  read('deadmanSeconds'),
  read('frozen'),
  pub.getBlock(),
]);

const now = Number(block.timestamp);
const lapsesAt = Number(lastHeartbeat) + Number(deadmanSeconds);
const remaining = lapsesAt - now;
const iso = (s) => new Date(s * 1000).toISOString();

console.log(`policyModule    ${POLICY}`);
console.log(`frozen          ${frozen}`);
console.log(`lastHeartbeat   ${lastHeartbeat}  ${iso(Number(lastHeartbeat))}`);
console.log(`deadmanSeconds  ${deadmanSeconds}  (${(Number(deadmanSeconds) / 86400).toFixed(1)} days)`);
console.log(`lapses at       ${lapsesAt}  ${iso(lapsesAt)}`);
console.log(`remaining       ${(remaining / 86400).toFixed(2)} days`);

if (frozen) {
  // Say it plainly rather than sending a transaction that cannot help.
  console.error(
    '\nFROZEN. The deadman already fired and PolicyModule has no unfreeze function.\n' +
    'heartbeat() will NOT recover this — the contract must be redeployed.',
  );
  process.exit(1);
}

if (DRY) {
  console.log('\n--dry-run: no transaction sent.');
  process.exit(0);
}

const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  throw new Error('DEPLOYER_PRIVATE_KEY is not set or malformed; heartbeat() is onlyOwner.');
}
const account = privateKeyToAccount(key);

const owner = await read('owner');
if (getAddress(owner) !== account.address) {
  throw new Error(`DEPLOYER_PRIVATE_KEY is ${account.address} but PolicyModule owner is ${owner}.`);
}

const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });
const hash = await wallet.writeContract({ address: POLICY, abi: policyAbi, functionName: 'heartbeat' });
console.log(`\nheartbeat() sent: ${hash}`);

const receipt = await pub.waitForTransactionReceipt({ hash });
console.log(`status          ${receipt.status}  block ${receipt.blockNumber}`);

/**
 * Re-read with retries.
 *
 * The public Base Sepolia RPC is load-balanced, so a read issued immediately
 * after a confirmed write can land on a node that has not caught up and return
 * the OLD value. That happened on the first real run of this script: the
 * receipt said success and the very next read showed an unchanged heartbeat,
 * which looks exactly like a silently failed transaction. Poll until it moves.
 */
let after = Number(lastHeartbeat);
for (let i = 0; i < 10 && after === Number(lastHeartbeat); i++) {
  await new Promise((r) => setTimeout(r, 1500));
  after = Number(await read('lastHeartbeat'));
}

if (after === Number(lastHeartbeat)) {
  console.warn(
    '\nThe transaction succeeded but lastHeartbeat still reads the old value after 15s.\n' +
    'This is usually RPC lag, not a failed write. Re-run with --dry-run to confirm before assuming the worst.',
  );
} else {
  console.log(`lastHeartbeat   ${after}  ${iso(after)}`);
  console.log(`now lapses at   ${iso(after + Number(deadmanSeconds))}`);
}
console.log(`explorer        https://sepolia.basescan.org/tx/${hash}`);
