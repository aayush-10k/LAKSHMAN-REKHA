// Read-only probe of the deployed Base Sepolia state. Operator tool, not part of
// the server. Prints addresses only, never private keys.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const here = dirname(fileURLToPath(import.meta.url));
const ABI = (n) => JSON.parse(readFileSync(resolve(here, `../../../packages/contracts-abi/${n}.json`), 'utf8')).abi;

const INRX = '0x9df2d451d682971878d09ba13920ca418697272d';
const POLICY = '0x933bb10252ec2b133f28b7d5edf1d303c3384d87';
const ACCOUNT = '0xd65122eafeb2e6f384d0095bac7de6f662276f6c';

const pub = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org'),
});

const policyAbi = ABI('PolicyModule');
const inrxAbi = ABI('INRx');

const read = (fn, args = []) => pub.readContract({ address: POLICY, abi: policyAbi, functionName: fn, args });

const fields = [
  'owner', 'account', 'agentSigner', 'coreSigner', 'coreImageDigest', 'policyHash',
  'revocationEpoch', 'perTxCapMinor', 'windowCapMinor', 'windowSeconds', 'cumulativeCapMinor',
  'permittedCategories', 'tier2MinAgeDays', 'tier2MinSettledTxns', 'tier2MaxPriceBandZ',
  'tier2CapMinor', 'windowStart', 'windowSpentMinor', 'cumulativeSpentMinor',
  'lastHeartbeat', 'deadmanSeconds', 'frozen',
];

const out = {};
for (const f of fields) {
  try { out[f] = await read(f); } catch (e) { out[f] = `ERR ${e.shortMessage || e.message}`; }
}

const block = await pub.getBlock({ blockTag: 'latest' });
out['_blockTimestamp'] = block.timestamp;
out['_blockNumber'] = block.number;
out['_inrxAccountBalance'] = await pub.readContract({ address: INRX, abi: inrxAbi, functionName: 'balanceOf', args: [ACCOUNT] });
out['_inrxTotalSupply'] = await pub.readContract({ address: INRX, abi: inrxAbi, functionName: 'totalSupply' });

// Derive addresses from the configured keys so we can tell whether the env
// actually holds the shares the deployed module expects.
for (const [label, name] of [['coreKeyAddr', 'CORE_SIGNER_PRIVATE_KEY'], ['agentKeyAddr', 'AGENT_SIGNER_PRIVATE_KEY'], ['deployerKeyAddr', 'DEPLOYER_PRIVATE_KEY']]) {
  const v = process.env[name];
  out[label] = v && /^0x[0-9a-fA-F]{64}$/.test(v) ? privateKeyToAccount(v).address : '(unset/invalid)';
}
if (out.deployerKeyAddr.startsWith('0x')) {
  out['_deployerEth'] = await pub.getBalance({ address: out.deployerKeyAddr });
  out['_deployerInrx'] = await pub.readContract({ address: INRX, abi: inrxAbi, functionName: 'balanceOf', args: [out.deployerKeyAddr] });
}
if (out.coreKeyAddr.startsWith('0x')) {
  out['_coreEth'] = await pub.getBalance({ address: out.coreKeyAddr });
}

console.log(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
