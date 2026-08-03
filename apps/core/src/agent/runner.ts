/**
 * The shopping agent, as a service.
 *
 * FIX2.md TASK: the Dispatch button in /playground had nothing behind it. It
 * POSTed /v1/task (a route that does not exist — the real one is
 * /v1/task/create) and even that only emitted task.started. Nothing ever asked
 * for a lease, built a FactSheet, requested a decision or settled, so no task
 * could produce a trace, a txHash or a balance change. This is the missing half.
 *
 *   POST /dispatch { description, mode, agentId? }
 *     1. pair, or adopt the agentId the browser already paired
 *     2. POST /v1/task/create                       -> taskId + line items
 *     3. GET  vendorsim /catalog                    -> the counterparty's facts
 *     4. POST /v1/lease/renew                       -> a freshly signed lease
 *     5. POST /v1/payment/request                   -> decision + core signature
 *     6. sign the SAME PaymentRequest with the agent key
 *     7. POST /v1/payment/settle                    -> the mined txHash
 *
 * ── Why this is a separate process ────────────────────────────────────────
 * The security claim is 2-of-2: the core holds one key share, the agent holds
 * the other, and neither can move money alone. If the core built both halves the
 * claim would be theatre. So the agent signature is computed HERE, from
 * AGENT_SIGNER_PRIVATE_KEY, by rebuilding the PaymentRequest from the lease and
 * the FactSheet — exactly as scripts/e2e-settle.ts does. The core never calls
 * agentSign() on a request path.
 *
 * HONEST LIMITATION: this process reads the same .env as the core, so on this
 * one machine both keys sit in one file. The code paths are separate and the
 * agent share never enters the core's request handling, but the deployment is
 * not. A real deployment gives this service its own secret store.
 *
 * ── What it will not do ───────────────────────────────────────────────────
 * Nothing here decides anything. It cannot approve a payment, and it fails
 * closed on every error: a REFUSED or HELD decision is returned as-is with its
 * trace, and a settlement that reverts is reported with the contract's error
 * name. No branch fabricates a hash, a signature or an approval.
 */

// First import: populates process.env from .env (see src/env.ts).
import '../env.js';

import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { agentPrivateKey } from '../keys.js';
import { buildPaymentRequest, hashRequest } from '../signing/request.js';
import type { Lease } from '../lease/types.js';
import type { CategoryCode, DecisionTrace, PolicyFactSheet, PolicyState } from '../types.js';

/**
 * AGENT_PORT stays authoritative so local dev and docker-compose are unchanged.
 * PORT is the fallback because that is the variable hosting platforms inject and
 * route to; without it this service would listen on 4200 while the platform sent
 * traffic somewhere else, and every Dispatch would time out with nothing in the
 * logs to explain why. The core (api/index.ts:33) and vendorsim already read PORT.
 */
const PORT = Number(process.env['AGENT_PORT'] ?? process.env['PORT'] ?? 4200);
const CORE_URL = process.env['CORE_URL'] ?? 'http://localhost:4000';
const VENDORSIM_URL = process.env['VENDORSIM_URL'] ?? 'http://localhost:4100';

type BehaviourMode = 'normal' | 'hallucinating' | 'injected' | 'compromised' | 'overreach' | 'colluding';

type Vendor = {
  id: string;
  tier: 1 | 2 | 3;
  ageDays: number;
  settledTxns: number;
  priceBandZ: number;
  address: string;
  categoryCode: CategoryCode;
};

type LineItem = {
  lineItemId: string;
  vendorId: string;
  categoryCode: CategoryCode;
  /** The planner's estimate. NOT what gets paid — the page price is. */
  estimatedAmountMinor: number;
  description: string;
  /** What to look for on the vendor's page. */
  sku: string;
  productName: string;
  quantity: number;
};

import { extractFromPage } from './extract.js';

/** A dispatch that ended before settlement, and the reason, in the caller's words. */
class DispatchError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly detail?: unknown) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
//  Core / vendorsim calls
// ---------------------------------------------------------------------------

async function postCore(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${CORE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function getCore(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${CORE_URL}${path}`);
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Display-only narration. Never load-bearing, so a failure is ignored. */
async function say(taskId: string, text: string): Promise<void> {
  await postCore('/v1/agent/event', { t: 'agent.thought', taskId, text }).catch(() => {});
}

/**
 * The agentId to spend under.
 *
 * Prefers the one the browser paired (so the console's chip names the agent that
 * actually pays), but verifies it against the core first: after a core restart a
 * remembered id is meaningless. FIX2.md BUG 2's "re-pair automatically instead of
 * failing silently", from the agent's side.
 */
async function resolveAgentId(preferred?: string): Promise<{ agentId: string; repaired: boolean }> {
  if (preferred) {
    const known = await getCore(`/v1/agent/${preferred}`);
    if (known.status === 200) return { agentId: preferred, repaired: false };
  }
  const code = await getCore('/v1/agent/pairing-code');
  if (code.status !== 200) {
    throw new DispatchError(503, 'CORE_UNAVAILABLE', `Core did not offer a pairing code (HTTP ${code.status}).`);
  }
  const paired = await postCore('/v1/agent/pair', { pairingCode: code.json.pairingCode });
  if (paired.status !== 201) {
    throw new DispatchError(503, 'PAIRING_FAILED', paired.json?.error?.message ?? `Pairing failed (HTTP ${paired.status}).`);
  }
  return { agentId: paired.json.agentId as string, repaired: true };
}

/**
 * The counterparty's facts, from the vendor registry.
 *
 * Never from the task description, and never from anything the agent made up:
 * the tier here has to match what PolicyModule holds or predicate 8 refuses. An
 * unreachable registry is fatal to the dispatch rather than a reason to guess.
 */
async function lookupVendor(vendorId: string): Promise<Vendor> {
  let catalog: Vendor[];
  try {
    const res = await fetch(`${VENDORSIM_URL}/catalog`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    catalog = (await res.json()) as Vendor[];
  } catch (e) {
    throw new DispatchError(503, 'REGISTRY_UNAVAILABLE',
      `Vendor registry at ${VENDORSIM_URL} is unreachable, so the counterparty cannot be verified: ${(e as Error).message}`);
  }
  const vendor = catalog.find((v) => v.id === vendorId);
  if (!vendor) {
    throw new DispatchError(422, 'VENDOR_NOT_FOUND', `The plan names vendor ${vendorId}, which is not in the registry.`);
  }
  return vendor;
}

// ---------------------------------------------------------------------------
//  One line item, end to end
// ---------------------------------------------------------------------------

export type LineItemResult = {
  lineItemId: string;
  vendorId: string;
  counterparty: string;
  amountMinor: number;
  outcome: 'APPROVED' | 'HELD' | 'REFUSED';
  bindingPredicate: string | null;
  decisionId: string;
  trace: DecisionTrace;
  /** Present only for a settlement that was mined. Never synthesised. */
  settlement: { txHash: string; blockNumber: number; balanceAfterMinor: number; explorerUrl: string } | null;
  /** Present when the chain refused, carrying PolicyModule's own error name. */
  refusedOnChain: string | null;
};

/**
 * Open the vendor's storefront and read the price off it.
 *
 * The agent browses the same HTML page a person would, which is what makes the
 * injected and counterfeit demos real: text added to that page reaches the
 * agent, and a lookalike store quotes its own (cheaper) price. What comes back
 * is one integer — see extract.ts for why that is the whole security claim.
 *
 * An unreadable page is fatal to the line item. There is no "use the estimate
 * instead" path, because a price nobody quoted is a price we invented.
 */
async function browseAndPrice(taskId: string, item: LineItem, vendor: Vendor) {
  const url = `${VENDORSIM_URL}/vendor/${vendor.id}`;
  await say(taskId, `Opening ${url} to read the current price.`);

  let html: string;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    throw new DispatchError(503, 'PAGE_UNREACHABLE',
      `Could not open ${vendor.id}'s storefront, so no price could be read: ${(e as Error).message}`);
  }

  const facts = await extractFromPage({ html, sku: item.sku, productName: item.productName });
  if (facts === null) {
    throw new DispatchError(422, 'PRICE_NOT_FOUND',
      `Read ${vendor.id}'s storefront but could not find a price for ${item.sku}. Nothing was requested.`);
  }

  if (facts.injectionSuspected !== null) {
    // Said out loud, and then ignored. The agent has no special defence and is
    // not meant to — the FactSheet is what makes the instruction unreachable.
    await say(taskId, `The page carries instruction-like text: "${facts.injectionSuspected.slice(0, 160)}…"`);
  }

  const unit = facts.amountMinor;
  const amountMinor = unit * Math.max(1, item.quantity ?? 1);
  await say(
    taskId,
    `Read ₹${(unit / 100).toLocaleString('en-IN')} per unit off the page (${facts.source === 'model' ? 'model' : 'page parser'}) ` +
    `× ${item.quantity ?? 1} = ₹${(amountMinor / 100).toLocaleString('en-IN')}.`,
  );

  return { amountMinor, facts };
}

async function runLineItem(taskId: string, item: LineItem, agentId: string): Promise<LineItemResult> {
  const vendor = await lookupVendor(item.vendorId);
  const { amountMinor, facts } = await browseAndPrice(taskId, item, vendor);

  await postCore('/v1/agent/event', {
    t: 'quote.received',
    lineItemId: item.lineItemId,
    vendorId: vendor.id,
    amountMinor,
  }).catch((e: Error) => console.warn(`[agent] quote.received not emitted: ${e.message}`));
  await say(taskId, `Quote from ${vendor.id}: ₹${(amountMinor / 100).toLocaleString('en-IN')} (tier ${vendor.tier}, ${vendor.ageDays}d old, ${vendor.settledTxns} settled).`);

  // --- lease -------------------------------------------------------------
  // Renewed immediately before the request, not reused: the TTL is short by
  // design and every millisecond spent here is one the settlement does not have.
  await say(taskId, 'Requesting a fresh lease from the core.');
  let leased = await postCore('/v1/lease/renew', { agentId });
  if (leased.status === 404) {
    // The core forgot this agent mid-run. Re-pair rather than fail.
    agentId = (await resolveAgentId()).agentId;
    leased = await postCore('/v1/lease/renew', { agentId });
  }
  if (leased.status !== 200) {
    throw new DispatchError(leased.status, leased.json?.error?.code ?? 'LEASE_FAILED',
      leased.json?.error?.message ?? `Lease renew failed (HTTP ${leased.status}).`);
  }

  // --- factSheet ---------------------------------------------------------
  // No free text. Every counterparty field comes from the registry lookup above;
  // item.description is display-only and deliberately not carried here.
  const factSheet = {
    amountMinor,
    currency: 'INR' as const,
    categoryCode: item.categoryCode,
    counterpartyId: vendor.address.toLowerCase(),
    counterpartyTier: vendor.tier,
    counterpartyAgeDays: vendor.ageDays,
    counterpartySettledTxns: vendor.settledTxns,
    priceBandZ: vendor.priceBandZ,
    taskId,
    lineItemId: item.lineItemId,
    leaseId: leased.json.leaseId as string,
    // uint64. Wall-clock microseconds, so it cannot collide with a nonce
    // PolicyModule has already burned (predicate 6 would refuse it if it did).
    nonce: Date.now() * 1000 + Math.floor(Math.random() * 1000),
  };

  await say(taskId, `Submitting the FactSheet for decision (${item.categoryCode}, ${factSheet.counterpartyId.slice(0, 10)}…).`);
  const requested = await postCore('/v1/payment/request', { factSheet });
  if (requested.status !== 200) {
    throw new DispatchError(requested.status, requested.json?.error?.code ?? 'REQUEST_FAILED',
      requested.json?.error?.message ?? `Payment request failed (HTTP ${requested.status}).`);
  }

  const trace = requested.json.trace as DecisionTrace;
  const base = {
    lineItemId: item.lineItemId,
    vendorId: vendor.id,
    counterparty: factSheet.counterpartyId,
    amountMinor,
    outcome: requested.json.outcome as LineItemResult['outcome'],
    bindingPredicate: trace.bindingPredicate,
    decisionId: requested.json.decisionId as string,
    trace,
  };

  if (base.outcome !== 'APPROVED') {
    await say(taskId, `Decision: ${base.outcome}${trace.bindingPredicate ? ` on ${trace.bindingPredicate}` : ''}. No signature was issued, so nothing can settle.`);
    return { ...base, settlement: null, refusedOnChain: null };
  }

  // --- the agent's half of the 2-of-2 ------------------------------------
  // Rebuilt here from the lease and the FactSheet rather than taken from the
  // core. If the two sides assemble different structs the signatures recover to
  // different addresses and PolicyModule rejects the payment — which is the
  // check working, not a bug to route around.
  const coreImageDigest = (process.env['CORE_IMAGE_DIGEST'] ?? ('0x01' + '00'.repeat(31))) as Hex;
  const lease: Lease = {
    leaseId: leased.json.leaseId,
    agentId,
    expiresAtMs: leased.json.expiresAtMs,
    revocationEpoch: leased.json.revocationEpoch,
    policyHash: leased.json.policyHash,
    signature: leased.json.signature,
  };
  const request = buildPaymentRequest(
    { ...factSheet, coreImageDigest } as PolicyFactSheet,
    {} as PolicyState, // buildPaymentRequest reads nothing from the state
    lease,
    coreImageDigest,
  );
  const agentSig = await sign({ hash: hashRequest(request), privateKey: agentPrivateKey(), to: 'hex' });
  await say(taskId, `Approved. Signing as ${privateKeyToAccount(agentPrivateKey()).address.slice(0, 10)}… and submitting to Base Sepolia.`);

  // --- settle ------------------------------------------------------------
  const settled = await postCore('/v1/payment/settle', { decisionId: base.decisionId, agentSig });

  if (settled.status === 422) {
    // The contract refused. That is enforcement working; report it as such.
    const name = settled.json?.error?.code ?? 'Unknown';
    await say(taskId, `PolicyModule refused the payment on chain: ${name}. No funds moved.`);
    return { ...base, settlement: null, refusedOnChain: name };
  }
  if (settled.status !== 200) {
    throw new DispatchError(settled.status, settled.json?.error?.code ?? 'SETTLE_FAILED',
      settled.json?.error?.message ?? `Settlement failed (HTTP ${settled.status}).`);
  }

  await say(taskId, `Settled on Base Sepolia: ${settled.json.txHash}`);
  return {
    ...base,
    settlement: {
      txHash: settled.json.txHash,
      blockNumber: settled.json.blockNumber,
      balanceAfterMinor: settled.json.balanceAfterMinor,
      explorerUrl: settled.json.explorerUrl ?? `https://sepolia.basescan.org/tx/${settled.json.txHash}`,
    },
    refusedOnChain: null,
  };
}

// ---------------------------------------------------------------------------
//  HTTP
// ---------------------------------------------------------------------------

const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });

await app.register(cors, { origin: process.env['CORS_ORIGIN'] ?? '*', methods: ['GET', 'POST', 'OPTIONS'] });

app.get('/health', () => ({
  ok: true,
  ts: Date.now(),
  core: CORE_URL,
  vendorsim: VENDORSIM_URL,
  // Whether this process can sign at all. False means every dispatch will stop
  // at the signing step, and it is better to know that from /health.
  agentKey: hasAgentKey(),
  agentSigner: hasAgentKey() ? privateKeyToAccount(agentPrivateKey()).address : null,
}));

function hasAgentKey(): boolean {
  try {
    agentPrivateKey();
    return true;
  } catch {
    return false;
  }
}

app.post<{ Body: { description: string; mode: BehaviourMode; agentId?: string } }>(
  '/dispatch',
  async (request, reply) => {
    const { description, mode = 'normal', agentId: preferred } = request.body ?? ({} as never);

    if (typeof description !== 'string' || !description.trim()) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'description is required.' } });
    }
    if (!hasAgentKey()) {
      return reply.code(503).send({
        error: {
          code: 'NO_AGENT_KEY',
          message: 'AGENT_SIGNER_PRIVATE_KEY is not configured, so this agent cannot produce its half of the 2-of-2. Nothing was dispatched.',
        },
      });
    }

    try {
      const { agentId, repaired } = await resolveAgentId(preferred);

      const created = await postCore('/v1/task/create', { description, mode });
      if (created.status !== 201) {
        throw new DispatchError(created.status, created.json?.error?.code ?? 'TASK_FAILED',
          created.json?.error?.message ?? `Task create failed (HTTP ${created.status}).`);
      }
      const taskId = created.json.taskId as string;
      const plan = created.json.plan as LineItem[];

      // Nothing in the registry matched, or the registry was unreachable. That
      // is a real answer and it must not come back looking like a completed
      // dispatch with an empty results array — the caller would render success.
      if (plan.length === 0) {
        const note = (created.json.note as string | null) ?? 'Nothing could be priced, so no payment was requested.';
        await say(taskId, note);
        return reply.code(200).send({ taskId, agentId, repaired, mode, plan: [], results: [], note });
      }

      await say(taskId, `Planning "${description}" — ${plan.length} line item(s), mode=${mode}.`);

      const results: LineItemResult[] = [];
      for (const item of plan) {
        results.push(await runLineItem(taskId, item, agentId));
      }

      return reply.code(200).send({ taskId, agentId, repaired, mode, plan, results });
    } catch (e) {
      if (e instanceof DispatchError) {
        request.log.warn({ code: e.code, detail: e.detail }, e.message);
        return reply.code(e.status).send({ error: { code: e.code, message: e.message } });
      }
      request.log.error(e);
      return reply.code(500).send({
        error: { code: 'DISPATCH_FAILED', message: (e as Error).message ?? 'The dispatch failed. Nothing was settled.' },
      });
    }
  },
);

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`agent runner listening on http://localhost:${PORT} (core ${CORE_URL}, registry ${VENDORSIM_URL})`);
if (!hasAgentKey()) {
  console.warn('[agent] WARNING: AGENT_SIGNER_PRIVATE_KEY is not set. Every dispatch will 503 at the signing step.');
} else {
  console.log(`[agent] signing as ${privateKeyToAccount(agentPrivateKey()).address}`);
}
