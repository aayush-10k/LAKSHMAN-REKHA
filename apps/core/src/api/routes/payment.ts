/**
 * B9 — POST /v1/payment/request  +  POST /v1/payment/settle
 *
 * /request: validates FactSheet, runs evaluator, emits decision events.
 *           FROST ceremony simulation: emits ceremony.round SSE events for M3.
 * /settle:  completes an APPROVED decision; produces a txHash.
 */

import { createPublicClient, http, bytesToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import type { FastifyInstance } from 'fastify';
import { validateFactSheet } from '../validate-factsheet.js';
import { evaluate } from '../mock-evaluator.js';
import * as store from '../store.js';
import { emit } from '../../events/bus.js';

const rpcUrl = process.env['BASE_SEPOLIA_RPC'] || 'https://sepolia.base.org';
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
const coreSignerKey = process.env['CORE_SIGNER_PRIVATE_KEY'];
const account = coreSignerKey ? privateKeyToAccount(coreSignerKey as `0x${string}`) : null;
const policyModuleAddress = (process.env['POLICY_MODULE_ADDRESS'] || '0x0000000000000000000000000000000000000000') as `0x${string}`;
const imageDigestStr = process.env['CORE_IMAGE_DIGEST'] || '0x0100000000000000000000000000000000000000000000000000000000000000';
const coreImageDigest = (imageDigestStr.startsWith('0x') ? imageDigestStr : `0x${Buffer.from(imageDigestStr).toString('hex').padEnd(64, '0')}`) as `0x${string}`;

const CATEGORY_MAP: Record<string, number> = {
  'PACKAGING': 0, 'ADVERTISING': 1, 'CONTENT': 2, 'COMPUTE': 3, 'LOGISTICS': 4, 'SOFTWARE': 5, 'UTILITIES': 6, 'OTHER': 7
};

const hashRequestAbi = [{
  type: 'function',
  name: 'hashRequest',
  stateMutability: 'view',
  inputs: [{
    type: 'tuple',
    name: 'req',
    components: [
      { name: 'amountMinor', type: 'uint256' },
      { name: 'counterparty', type: 'address' },
      { name: 'counterpartyTier', type: 'uint8' },
      { name: 'counterpartyAgeDays', type: 'uint16' },
      { name: 'counterpartySettledTxns', type: 'uint32' },
      { name: 'priceBandZ', type: 'int8' },
      { name: 'categoryCode', type: 'uint8' },
      { name: 'leaseId', type: 'bytes32' },
      { name: 'nonce', type: 'uint64' },
      { name: 'revocationEpoch', type: 'uint64' },
      { name: 'leaseExpiry', type: 'uint64' },
      { name: 'coreImageDigest', type: 'bytes32' }
    ]
  }],
  outputs: [{ type: 'bytes32', name: '' }]
}] as const;

export async function registerPaymentRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /v1/payment/request ───────────────────────────────────────
  app.post<{ Body: { factSheet: unknown } }>('/v1/payment/request', async (request, reply) => {
    const validation = validateFactSheet(request.body?.factSheet);

    if (!validation.ok) {
      return reply.code(400).send({
        error: { code: 'FACTSHEET_INVALID', message: validation.reason },
      });
    }

    const { factSheet: fs } = validation;

    // Enforce Registry Rule
    try {
      const catalogRes = await fetch('http://localhost:4100/catalog');
      if (catalogRes.ok) {
        const vendors = (await catalogRes.json()) as any[];
        const vendor = vendors.find((v: any) => v.address.toLowerCase() === fs.counterpartyId.toLowerCase());
        if (vendor) {
          fs.counterpartyAgeDays = vendor.ageDays;
          fs.counterpartySettledTxns = vendor.settledTxns;
        } else {
          fs.counterpartyAgeDays = 0;
          fs.counterpartySettledTxns = 0;
        }
      }
    } catch (e) {
      console.warn('Failed to contact vendor registry', e);
      fs.counterpartyAgeDays = 0;
      fs.counterpartySettledTxns = 0;
    }

    // Look up lease to get mandate context
    const lease = store.getLease(fs.leaseId);
    if (!lease) {
      return reply.code(403).send({ error: { code: 'LEASE_EXPIRED', message: 'Lease not found or expired.' } });
    }

    const mandate = store.getMandate(lease.mandateId);
    if (!mandate) {
      return reply.code(503).send({ error: { code: 'CORE_UNAVAILABLE', message: 'Mandate unavailable.' } });
    }

    if (mandate.frozen) {
      return reply.code(403).send({ error: { code: 'REVOKED', message: 'Mandate is revoked.' } });
    }

    if (lease.expiresAtMs < Date.now()) {
      return reply.code(403).send({ error: { code: 'LEASE_EXPIRED', message: 'Lease TTL has passed.' } });
    }

    // Emit: payment requested
    emit({ t: 'payment.requested', lineItemId: fs.lineItemId, factSheet: fs });

    // Run the deterministic evaluator (no LLM, no I/O)
    const trace = evaluate({
      factSheet: fs,
      mandate,
      leaseExpiresAtMs: lease.expiresAtMs,
      agentSigValid: true, // agent already authenticated via agentId; real sig check is in A's signing service
      coreSigValid: true,  // we are the core — always valid here
    });

    store.storeDecision(trace);

    // Emit: decision made
    emit({ t: 'decision.made', trace });

    if (trace.outcome === 'APPROVED') {
      // Simulate FROST signing ceremony (3 rounds) for M3
      const of = 3;
      for (let round = 1; round <= of; round++) {
        await delay(60);
        emit({ t: 'ceremony.round', decisionId: trace.decisionId, round, of });

        // Check if revoked mid-ceremony
        const freshMandate = store.getMandate(lease.mandateId);
        if (freshMandate?.frozen) {
          emit({ t: 'ceremony.aborted', decisionId: trace.decisionId, atRound: round, reason: 'revoked' });
          return reply.code(403).send({ error: { code: 'REVOKED', message: 'Revoked mid-ceremony.' } });
        }
      }
    }

    if (trace.outcome === 'HELD') {
      const hold = { expiresAtMs: Date.now() + 90_000 };
      emit({ t: 'payment.held', decisionId: trace.decisionId, expiresAtMs: hold.expiresAtMs, amountMinor: trace.amountMinor });
    }

    if (trace.outcome === 'REFUSED') {
      const error422 = {
        error: {
          code: 'POLICY_REFUSED',
          message: trace.summary,
          predicate: trace.bindingPredicate ?? undefined,
          decisionId: trace.decisionId,
        },
      };
      // Still return 200 with the trace so the frontend can render the decision panel
      return reply.code(200).send({
        decisionId: trace.decisionId,
        outcome: trace.outcome,
        trace,
        partialSig: null,
        holdExpiresAtMs: null,
      });
    }

    let partialSig: string | null = null;
    if (trace.outcome === 'APPROVED' && account && policyModuleAddress !== '0x0000000000000000000000000000000000000000') {
      try {
        const reqTuple = {
          amountMinor: BigInt(fs.amountMinor),
          counterparty: fs.counterpartyId as `0x${string}`,
          counterpartyTier: fs.counterpartyTier,
          counterpartyAgeDays: fs.counterpartyAgeDays,
          counterpartySettledTxns: fs.counterpartySettledTxns,
          priceBandZ: fs.priceBandZ,
          categoryCode: CATEGORY_MAP[fs.categoryCode] ?? 7,
          leaseId: bytesToHex(Buffer.from(fs.leaseId).subarray(0, 32), { size: 32 }) as `0x${string}`,
          nonce: BigInt(fs.nonce),
          revocationEpoch: BigInt(mandate.revocationEpoch),
          leaseExpiry: BigInt(Math.floor(lease.expiresAtMs / 1000)),
          coreImageDigest
        };
        
        const digest = await publicClient.readContract({
          address: policyModuleAddress,
          abi: hashRequestAbi,
          functionName: 'hashRequest',
          args: [reqTuple]
        });
        
        const sig = await account.sign({ hash: digest });
        partialSig = sig;
        trace.signature = sig;
      } catch (e) {
        console.error('Failed to generate core signature', e);
      }
    } else if (trace.outcome === 'APPROVED') {
      partialSig = `0x${'ab'.repeat(32)}`;
    }

    return reply.code(200).send({
      decisionId: trace.decisionId,
      outcome: trace.outcome,
      trace,
      partialSig,
      holdExpiresAtMs: trace.outcome === 'HELD' ? Date.now() + 90_000 : null,
    });
  });

  // ── POST /v1/payment/settle ────────────────────────────────────────
  app.post<{ Body: { decisionId: string; agentSig: string } }>('/v1/payment/settle', async (request, reply) => {
    const { decisionId, agentSig } = request.body ?? {};

    if (!decisionId || !agentSig) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'decisionId and agentSig are required.' } });
    }

    const trace = store.getDecision(decisionId);
    if (!trace) {
      return reply.code(404).send({ error: { code: 'DECISION_NOT_FOUND', message: 'Decision not found.' } });
    }

    if (trace.outcome !== 'APPROVED') {
      return reply.code(409).send({ error: { code: 'DECISION_NOT_APPROVED', message: `Cannot settle a ${trace.outcome} decision.` } });
    }

    let result: { txHash: string; blockNumber: number; balanceAfterMinor: number };
    try {
      result = store.settleDecision(decisionId);
    } catch {
      return reply.code(409).send({ error: { code: 'DECISION_NOT_APPROVED', message: 'Settlement failed.' } });
    }

    emit({
      t: 'payment.settled',
      decisionId,
      txHash: result.txHash,
      balanceAfterMinor: result.balanceAfterMinor,
    });

    return reply.code(200).send({
      txHash: result.txHash,
      balanceAfterMinor: result.balanceAfterMinor,
      blockNumber: result.blockNumber,
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
