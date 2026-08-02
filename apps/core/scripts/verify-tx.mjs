/**
 * Independent confirmation that a settlement txHash is real.
 *
 * Operator tool. Takes a hash the API returned and re-reads it from Base Sepolia
 * through a client that shares nothing with the server: if the hash had been
 * invented, this is where it fails to resolve. Also prints the PaymentExecuted
 * log and RekhaAccount's INRx balance either side of the block, so "the wallet
 * balance matches on-chain state" is a checkable claim rather than an assertion.
 *
 *   node apps/core/scripts/verify-tx.mjs 0x<txHash>
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, decodeEventLog } from 'viem';
import { baseSepolia } from 'viem/chains';

const here = dirname(fileURLToPath(import.meta.url));
const ABI = (n) => JSON.parse(readFileSync(resolve(here, `../../../packages/contracts-abi/${n}.json`), 'utf8')).abi;

const INRX = '0x9df2d451d682971878d09ba13920ca418697272d';
const ACCOUNT = '0xd65122eafeb2e6f384d0095bac7de6f662276f6c';

const txHash = process.argv[2];
if (!txHash) throw new Error('usage: node scripts/verify-tx.mjs <txHash>');

const pub = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org'),
});

const receipt = await pub.getTransactionReceipt({ hash: txHash });
console.log('txHash     ', receipt.transactionHash);
console.log('status     ', receipt.status);
console.log('blockNumber', receipt.blockNumber.toString());
console.log('to         ', receipt.to);
console.log('gasUsed    ', receipt.gasUsed.toString());

const accountAbi = ABI('RekhaAccount');
for (const log of receipt.logs) {
  try {
    const decoded = decodeEventLog({ abi: accountAbi, data: log.data, topics: log.topics });
    console.log('event      ', decoded.eventName, JSON.stringify(decoded.args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch {
    /* not a RekhaAccount event (the INRx Transfer, for instance) */
  }
}

const inrxAbi = ABI('INRx');
const balanceAt = (block) =>
  pub.readContract({ address: INRX, abi: inrxAbi, functionName: 'balanceOf', args: [ACCOUNT], blockNumber: block });

const before = await balanceAt(receipt.blockNumber - 1n);
const after = await balanceAt(receipt.blockNumber);
console.log('INRx before', before.toString());
console.log('INRx after ', after.toString());
console.log('moved      ', (before - after).toString(), 'minor');
console.log('explorer    https://sepolia.basescan.org/tx/' + receipt.transactionHash);
