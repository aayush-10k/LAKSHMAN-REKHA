/**
 * End-to-end proof for FIX.md TASK 2: pair -> lease -> request -> settle, then
 * re-read the returned hash from Base Sepolia through a fresh client.
 *
 * Run against a core started with the real .env:
 *   pnpm exec tsx scripts/e2e-settle.ts <pairingCode>
 *
 * The agent signature is derived HERE, from the agent key, by rebuilding the
 * PaymentRequest from the lease and the FactSheet. That is deliberate and is how
 * the real agent must work: it has everything needed to compute the digest
 * itself, so it never has to sign a struct the core merely asserts. If the two
 * sides build different structs the signatures recover to different addresses
 * and the chain rejects the payment — which is the check working.
 */
import { createPublicClient, http, type Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { buildPaymentRequest, hashRequest } from '../src/signing/request.js';
import type { PolicyFactSheet, PolicyState } from '../src/types.js';
import type { Lease } from '../src/lease/index.js';

const BASE = process.env['CORE_URL'] ?? 'http://localhost:4000';
const RPC = process.env['BASE_SEPOLIA_RPC'] || 'https://sepolia.base.org';
const pairingCode = process.argv[2];
if (!pairingCode) throw new Error('usage: tsx scripts/e2e-settle.ts <pairingCode>');

const agentKey = process.env['AGENT_SIGNER_PRIVATE_KEY'] as Hex | undefined;
if (!agentKey) throw new Error('AGENT_SIGNER_PRIVATE_KEY is not set');

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json: json as any };
};

const hex = (n: number) => Math.floor(Math.random() * 16 ** n).toString(16).padStart(n, '0');

// --- 1. pair ---------------------------------------------------------------
const paired = await post('/v1/agent/pair', { pairingCode });
console.log('pair    ', paired.status, JSON.stringify(paired.json));
if (paired.status !== 201) process.exit(1);
const agentId = paired.json.agentId as string;

// --- 2. lease --------------------------------------------------------------
const leased = await post('/v1/lease/renew', { agentId });
console.log('lease   ', leased.status, JSON.stringify(leased.json));
if (leased.status !== 200) process.exit(1);

// --- 3. factSheet ----------------------------------------------------------
// OTHER because the deployed policy's permittedCategories is 128 (bit 7 only).
// Tier 1 because PolicyModule requires req.counterpartyTier to equal the tier in
// its own registry, and ven_meridian is registered as 1.
const factSheet = {
  amountMinor: 9_400, // ₹94, well under the deployed ₹10,000 per-tx cap
  currency: 'INR' as const,
  categoryCode: 'OTHER' as const,
  counterpartyId: '0x8a3f21d0c4b9e7f6a1d2c3b4e5f6a7b8c9d0e1f2', // ven_meridian
  counterpartyTier: 1 as const,
  counterpartyAgeDays: 412,
  counterpartySettledTxns: 1183,
  priceBandZ: 2,
  taskId: `tsk_${hex(8)}`,
  lineItemId: `li_${hex(8)}_01`,
  leaseId: leased.json.leaseId as string,
  // uint64, effectively never colliding with a nonce PolicyModule already burned.
  nonce: Date.now() * 1000 + Math.floor(Math.random() * 1000),
};

const requested = await post('/v1/payment/request', { factSheet });
console.log('request ', requested.status, 'outcome=', requested.json?.outcome,
  'binding=', requested.json?.trace?.bindingPredicate,
  'summary=', requested.json?.trace?.summary);
if (requested.status !== 200) process.exit(1);
if (requested.json.outcome !== 'APPROVED') {
  console.log('not approved; nothing to settle. Full trace:');
  console.log(JSON.stringify(requested.json.trace, null, 2));
  process.exit(2);
}

// --- 4. agent signature ----------------------------------------------------
const coreImageDigest = (process.env['CORE_IMAGE_DIGEST'] ?? ('0x01' + '00'.repeat(31))) as Hex;
const lease = {
  leaseId: leased.json.leaseId,
  agentId,
  expiresAtMs: leased.json.expiresAtMs,
  revocationEpoch: leased.json.revocationEpoch,
  policyHash: leased.json.policyHash,
  signature: leased.json.signature,
} as Lease;

const request = buildPaymentRequest(
  { ...factSheet, coreImageDigest } as PolicyFactSheet,
  {} as PolicyState, // buildPaymentRequest reads nothing from the state
  lease,
  coreImageDigest,
);
const agentSig = await sign({ hash: hashRequest(request), privateKey: agentKey, to: 'hex' });
console.log('agent   ', privateKeyToAccount(agentKey).address, 'signed', hashRequest(request));

// --- 5. settle -------------------------------------------------------------
const settled = await post('/v1/payment/settle', {
  decisionId: requested.json.decisionId,
  agentSig,
});
console.log('settle  ', settled.status, JSON.stringify(settled.json));
if (settled.status !== 200) process.exit(3);

// --- 6. independent confirmation -------------------------------------------
// A fresh client, straight to Base Sepolia. If the hash the API returned were
// invented, this is where it would fail to resolve.
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const receipt = await pub.getTransactionReceipt({ hash: settled.json.txHash as Hex });
console.log('\nCONFIRMED ON BASE SEPOLIA');
console.log('  txHash     ', receipt.transactionHash);
console.log('  status     ', receipt.status);
console.log('  blockNumber', receipt.blockNumber.toString());
console.log('  gasUsed    ', receipt.gasUsed.toString());
console.log('  explorer    https://sepolia.basescan.org/tx/' + receipt.transactionHash);
