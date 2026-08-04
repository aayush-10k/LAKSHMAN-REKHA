/**
 * B9 — POST /v1/payment/request  +  POST /v1/payment/settle
 *
 * /request: validates the FactSheet, runs the evaluator and produces the core's
 *           half of the 2-of-2. Emits decision events; simulates the FROST
 *           ceremony rounds for M3.
 * /settle:  broadcasts RekhaAccount.execute and returns the MINED transaction.
 *
 * FIX.md TASK 2 + TASK 3. Two things changed in here and both are load-bearing:
 *
 *  1. There is now exactly one place a PaymentRequest is built — coreSign() in
 *     src/signing/, via buildPaymentRequest(). The inline tuple and the local
 *     hashRequest ABI that used to live in this file are gone. A second
 *     construction path is a second chance to disagree with the Solidity struct,
 *     and a struct that disagrees by one field reverts with InvalidCoreSignature.
 *
 *  2. Settlement is real. No branch of this file can produce a transaction hash
 *     that did not come off a mined receipt. A missing key is 503, a contract
 *     refusal is 422 naming the custom error, and neither returns a hash.
 */

import type { FastifyInstance } from 'fastify';
import type { Hex } from 'viem';
import { validateFactSheet } from '../validate-factsheet.js';
import * as store from '../store.js';
import { emit } from '../../events/bus.js';
import { hasCoreKey } from '../../keys.js';
import { LeaseInvalidError, type Lease } from '../../lease/index.js';
import { coreSign } from '../../signing/sign.js';
import { toPolicyFactSheet, toPolicyState, type RegistryTier } from '../policy-state.js';
import {
  broadcastExecute,
  counterpartyTierOnChain,
  inrxBalanceAtBlock,
  nonceUsedOnChain,
  readDeployedPolicy,
  rekhaAccountAddress,
  settlementConfig,
  SettlementRevertedError,
} from '../chain.js';

/** 65-byte ECDSA signature, as the agent must supply it. */
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

/** Same default and same env var as task.ts and the agent runner. */
const VENDORSIM_URL = process.env['VENDORSIM_URL'] ?? 'http://localhost:4100';

/**
 * B's stored lease record -> A's Lease.
 *
 * Same five fields plus agentId; the record is now really signed by the core key
 * (see store.issueLease), so validateLease inside coreSign can recover it.
 */
function toLease(record: store.LeaseRecord): Lease {
  return {
    leaseId: record.leaseId,
    agentId: record.agentId,
    expiresAtMs: record.expiresAtMs,
    revocationEpoch: record.revocationEpoch,
    policyHash: record.policyHash,
    signature: record.signature,
  };
}

/**
 * Drop the window reservation a decision is holding.
 *
 * Called on BOTH settlement outcomes. On success the rupees are now counted on
 * chain and `refreshFromChain` reads them back, so keeping the reservation
 * would count them twice and refuse the next legitimate payment. On a revert
 * they can never be spent at all.
 *
 * The key is the nonce, which is where the reservation was staked — before a
 * decisionId existed. It is read off the signed request rather than kept in a
 * second map, so there is nothing to drift.
 */
function releaseReservation(decisionId: string, ctx: { request: { nonce: bigint | number } }): void {
  const mandateId = store.getMandateIdForDecision(decisionId);
  if (mandateId === undefined) return;
  store.releaseSpend(mandateId, `nonce:${Number(ctx.request.nonce)}`);
}

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

    if (!hasCoreKey()) {
      return reply.code(503).send({
        error: { code: 'CORE_UNAVAILABLE', message: 'No core signing key configured.' },
      });
    }

    // Enforce Registry Rule: age and settled-count come from the vendor
    // registry, never from the caller. An unreachable registry means zeroes,
    // which the soft predicates treat as unproven.
    try {
      // VENDORSIM_URL, not a hardcoded localhost. This was the only service URL
      // in the repo that was not env-overridable, and it is the one that
      // enforces the Registry Rule. On the hosted shape the core and vendorsim
      // are separate services, so this fetch would always fail, the catch below
      // would zero the two fields, and the rule that stops the agent lying
      // about counterparty age would silently do nothing on the deployed stack.
      const catalogRes = await fetch(`${VENDORSIM_URL}/catalog`);
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

    // Predicates 6 and 8 are answered by PolicyModule storage, not by anything
    // in this process — read them so an APPROVED trace means the chain will
    // actually accept the payment. Both fail closed if the RPC is unreachable.
    const [onChainTier, nonceBurned] = await Promise.all([
      counterpartyTierOnChain(fs.counterpartyId),
      nonceUsedOnChain(fs.nonce),
    ]);
    const registry = new Map<string, RegistryTier>([
      [fs.counterpartyId.toLowerCase(), onChainTier as RegistryTier],
    ]);
    // Claim the nonce for this process, synchronously.
    //
    // The chain read above answers "has anyone burned this?" — it cannot answer
    // "is another request in THIS process already holding it?", because none of
    // them have settled yet. 50 concurrent requests with one nonce all saw
    // `false` here and most were APPROVED and co-signed. PolicyModule meant
    // only one could ever settle, but the core was still handing out N
    // signatures for one nonce.
    //
    // No `await` between the claim and building the state below — that is what
    // makes it atomic on a single-threaded event loop. Moving either line
    // across an await reopens the race.
    // Expires with the lease, for the same reason spend reservations do: a
    // payment whose lease has lapsed can never settle, so its nonce is free on
    // chain and this process must stop refusing it.
    const claimedHere = store.claimNonce(lease.mandateId, fs.nonce, lease.expiresAtMs);
    const usedNonces = new Set<number>(nonceBurned || !claimedHere ? [fs.nonce] : []);

    // Rupees this core has already co-signed for but which have not settled.
    //
    // `mandate.windowSpentMinor` only moves on settlement, so without this a
    // run of approvals that never settle each looks fine on its own — which is
    // exactly how twelve ₹8,000 slices cleared a ₹1,00,000 window.
    //
    // Note where this is added: to the STATE handed to the evaluator, not to
    // the evaluator. `evaluator.ts` stays byte-identical to Solidity
    // `PolicyModule.validate` — that agreement is checked over 10,000
    // differential inputs and is worth more than this fix. What changes is the
    // core's own bookkeeping about what it has already promised.
    // Read the outstanding total and stake this request's claim in the SAME
    // tick — no await between them, exactly like the nonce claim above.
    //
    // Reserving after coreSign is not enough and the first version did that:
    // eight concurrent requests all read `reserved` before any of them had
    // written, and three were approved where one should have been. Measured.
    // The reservation is keyed by nonce because that is the one identifier
    // available before a decisionId exists, and it is already unique per
    // payment — the claim above guarantees it.
    const reserved = store.reservedSpendMinor(lease.mandateId);
    const spendKey = `nonce:${fs.nonce}`;
    store.reserveSpend(lease.mandateId, spendKey, fs.amountMinor, lease.expiresAtMs);

    // `reserved` deliberately excludes this request — the evaluator adds
    // `fs.amountMinor` itself when it checks the window.
    const mandateWithReservations = reserved === 0
      ? mandate
      : { ...mandate, windowSpentMinor: mandate.windowSpentMinor + reserved };

    const policyState = toPolicyState(mandateWithReservations, lease, registry, usedNonces);

    // One call does the deciding AND the signing: coreSign validates the lease,
    // runs the frozen evaluator, and signs only an APPROVED outcome. There is no
    // path through it that returns a signature for a refused payment.
    let signed;
    try {
      signed = await coreSign(toPolicyFactSheet(fs), policyState, toLease(lease), Date.now());
    } catch (e) {
      // The claim must not outlive the request that made it. A lease error here
      // means no decision and no signature, so holding the nonce would refuse a
      // legitimate retry for a reason that is not true.
      if (claimedHere) store.releaseNonce(lease.mandateId, fs.nonce);
      store.releaseSpend(lease.mandateId, spendKey);
      if (e instanceof LeaseInvalidError) {
        return reply.code(403).send({ error: { code: 'LEASE_EXPIRED', message: e.message } });
      }
      throw e;
    }

    const trace = signed.trace;
    if (signed.partialSig !== null) trace.signature = signed.partialSig;

    // Only an APPROVED decision produces a signature, and only a signature can
    // ever consume the nonce on chain. Anything else gives it back — a REFUSED
    // or HELD payment burns nothing, so the same request may legitimately be
    // retried with the same nonce once whatever refused it is fixed.
    // Nothing was promised unless it was approved, so give both claims back.
    if (trace.outcome !== 'APPROVED') {
      if (claimedHere) store.releaseNonce(lease.mandateId, fs.nonce);
      store.releaseSpend(lease.mandateId, spendKey);
    }

    store.storeDecision(trace, lease.mandateId);
    store.linkDecisionToMandate(trace.decisionId, lease.mandateId);

    // Emit: decision made
    emit({ t: 'decision.made', trace });

    if (trace.outcome === 'APPROVED') {
      // Signing ceremony (3 rounds) for M3.
      //
      // The revocation re-check between rounds is the substance of the claim
      // that an owner can kill a payment mid-signature. At the old hardcoded
      // 60ms per round the whole ceremony was 180ms, so nobody could ever hit
      // REVOKE during it and the highest-value demo moment could not be
      // performed live — the check was real but unobservable.
      //
      // CEREMONY_ROUND_MS makes it demonstrable. The default 1200ms gives a
      // ~3.6s ceremony: long enough to interrupt by hand, short enough that a
      // normal approval still reads as frictionless.
      const of = 3;
      for (let round = 1; round <= of; round++) {
        await delay(ceremonyRoundMs());
        emit({ t: 'ceremony.round', decisionId: trace.decisionId, round, of });

        // Check if revoked mid-ceremony
        const freshMandate = store.getMandate(lease.mandateId);
        if (freshMandate?.frozen) {
          emit({ t: 'ceremony.aborted', decisionId: trace.decisionId, atRound: round, reason: 'revoked' });
          return reply.code(403).send({ error: { code: 'REVOKED', message: 'Revoked mid-ceremony.' } });
        }
      }

      // The ceremony takes real time now, and the lease was issued before it.
      // If it has expired underneath us the chain would revert LeaseExpired, so
      // refuse here rather than hand out a settlement context that cannot settle.
      if (lease.expiresAtMs < Date.now()) {
        return reply.code(403).send({
          error: {
            code: 'LEASE_EXPIRED',
            message: 'The lease expired during the signing ceremony; nothing was signed for settlement.',
          },
        });
      }

      // Only now is the request settle-able. Storing the exact struct that was
      // signed is what lets /settle broadcast without rebuilding (and therefore
      // without risking a different digest).
      if (signed.request !== null && signed.partialSig !== null) {
        store.putSettlementContext(trace.decisionId, {
          request: signed.request,
          coreSig: signed.partialSig,
        });
      }
    }

    if (trace.outcome === 'HELD') {
      const hold = { expiresAtMs: Date.now() + 90_000 };
      emit({ t: 'payment.held', decisionId: trace.decisionId, expiresAtMs: hold.expiresAtMs, amountMinor: trace.amountMinor });
    }

    // A REFUSED decision still returns 200 with its trace: the decision panel is
    // the product, and the caller needs the predicate that bound to render it.
    // There is no signature attached, so nothing can be settled from it.
    return reply.code(200).send({
      decisionId: trace.decisionId,
      outcome: trace.outcome,
      trace,
      partialSig: signed.partialSig,
      holdExpiresAtMs: trace.outcome === 'HELD' ? Date.now() + 90_000 : null,
    });
  });

  // ── POST /v1/payment/settle ────────────────────────────────────────
  app.post<{ Body: { decisionId: string; agentSig: string } }>('/v1/payment/settle', async (request, reply) => {
    const { decisionId, agentSig } = request.body ?? {};

    if (!decisionId || !agentSig) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'decisionId and agentSig are required.' } });
    }

    if (!SIGNATURE_RE.test(agentSig)) {
      return reply.code(400).send({
        error: { code: 'INVALID_REQUEST', message: 'agentSig must be a 65-byte 0x-prefixed hex signature.' },
      });
    }

    const trace = store.getDecision(decisionId);
    if (!trace) {
      return reply.code(404).send({ error: { code: 'DECISION_NOT_FOUND', message: 'Decision not found.' } });
    }

    if (trace.outcome !== 'APPROVED') {
      return reply.code(409).send({ error: { code: 'DECISION_NOT_APPROVED', message: `Cannot settle a ${trace.outcome} decision.` } });
    }

    // FIX.md: no core key or no account address means we cannot broadcast, and
    // there is no fallback that invents a hash instead.
    const config = settlementConfig();
    if (config === null) {
      return reply.code(503).send({
        error: {
          code: 'CORE_UNAVAILABLE',
          message: 'Settlement is unavailable: CORE_SIGNER_PRIVATE_KEY or REKHA_ACCOUNT_ADDRESS is not configured.',
        },
      });
    }

    const ctx = store.getSettlementContext(decisionId);
    if (!ctx) {
      return reply.code(503).send({
        error: { code: 'CORE_UNAVAILABLE', message: 'No signed request is held for this decision.' },
      });
    }

    // The chain is the judge from here. A revert is the enforcement working, so
    // it is reported as 422 with the contract's own error name — never a 500 and
    // never swallowed.
    let receipt;
    try {
      receipt = await broadcastExecute(config, ctx.request, agentSig as Hex, ctx.coreSig);
    } catch (e) {
      if (e instanceof SettlementRevertedError) {
        // The chain refused it, so it will never consume window. Give the
        // reservation back rather than letting a rejected payment keep holding
        // rupees that can no longer be spent.
        releaseReservation(decisionId, ctx);
        return reply.code(422).send({
          error: { code: e.errorName, message: `Settlement refused on chain: ${e.errorName}.`, decisionId },
        });
      }
      // RPC unreachable, key rejected, out of gas money: nothing settled, so say
      // so with a 503 rather than letting the generic 500 handler imply a
      // maybe-it-happened.
      request.log.error(e);
      return reply.code(503).send({
        error: { code: 'CORE_UNAVAILABLE', message: 'Could not broadcast the settlement transaction.' },
      });
    }

    // Reached only for a receipt with status 'success'.
    const result = store.settleDecision(decisionId, receipt.txHash, receipt.blockNumber);

    // The spend is now counted on chain, and refreshFromChain reads it back
    // into windowSpentMinor. Keeping the reservation would count the same
    // rupees twice and refuse the NEXT legitimate payment.
    releaseReservation(decisionId, ctx);

    // The money moved on chain, so the chain is what the console must show. The
    // local counter in settleDecision is bookkeeping for the audit export; the
    // balance the judge reads has to be RekhaAccount's actual INRx balance, or
    // "the wallet balance matches on-chain state" is not a claim we can make.
    // Pinned to the receipt's block, not 'latest': the public RPC is a load
    // balancer and the node that answers may be a block or two behind, which
    // once produced a real settlement reported with the PRE-payment balance.
    const account = rekhaAccountAddress();
    let balanceAfterMinor: number | null = null;
    if (account !== null) {
      try {
        balanceAfterMinor = Number(await inrxBalanceAtBlock(account, receipt.blockNumber));
      } catch (e) {
        // The payment DID happen; only the follow-up read failed. Report the
        // balance as unknown rather than passing a local figure off as on-chain.
        request.log.warn(e, 'settled, but the post-settlement balance read failed');
      }
    }
    const balanceSource = balanceAfterMinor === null ? ('unavailable' as const) : ('chain' as const);

    // Settling advanced windowSpentMinor and cumulativeSpentMinor in PolicyModule.
    // Pull them back so the next decision is evaluated against the counters the
    // chain now holds instead of a copy that stopped tracking at boot.
    store.seedPolicy(await readDeployedPolicy());

    emit({
      t: 'payment.settled',
      decisionId,
      txHash: result.txHash,
      // null when the post-settlement read failed. The UI shows "unavailable"
      // for that; it must not fall back to a number that was never verified.
      balanceAfterMinor,
      balanceSource,
      blockNumber: result.blockNumber,
      amountMinor: trace.amountMinor,
    });

    return reply.code(200).send({
      txHash: result.txHash,
      balanceAfterMinor,
      balanceSource,
      blockNumber: result.blockNumber,
      amountMinor: trace.amountMinor,
      explorerUrl: `https://sepolia.basescan.org/tx/${result.txHash}`,
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Per-round pause in the signing ceremony, in milliseconds.
 *
 * Read per call rather than pinned at module load so it can be changed between
 * demo runs without a restart. Clamped: 0 makes the revocation window
 * unobservable again, and anything beyond a couple of seconds a round pushes the
 * ceremony past the lease it is running under.
 */
function ceremonyRoundMs(): number {
  const configured = Number(process.env['CEREMONY_ROUND_MS']);
  if (!Number.isFinite(configured) || configured <= 0) return 1200;
  return Math.min(configured, 3000);
}
