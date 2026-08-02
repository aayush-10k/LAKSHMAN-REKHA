# FIXLOG — autonomous fix run against FIX.md

Branch: `a/core-evaluator-merge`. All five tasks attempted; four completed, one
completed by a different route than FIX.md proposed. Nothing was skipped.

---

## THE HEADLINE: settlement is real

Two payments were driven end to end through the running core — pair → lease →
`POST /v1/payment/request` → `POST /v1/payment/settle` — and both hashes were
then re-read from Base Sepolia through a *fresh* client that had never seen the
API response:

| # | txHash | Block | Lease TTL | Gas used |
|---|---|---|---|---|
| 1 | [`0x2f4a4b304e8fc2b2d2335805b3363ed061c213fa827fa256bd423a87ef665835`](https://sepolia.basescan.org/tx/0x2f4a4b304e8fc2b2d2335805b3363ed061c213fa827fa256bd423a87ef665835) | 44952095 | 180 s | 200,450 |
| 2 | [`0x9583efb7036f47ae3e7ed6c34c179c1223d556b4f59bec64ed2ba3aeb09e44cc`](https://sepolia.basescan.org/tx/0x9583efb7036f47ae3e7ed6c34c179c1223d556b4f59bec64ed2ba3aeb09e44cc) | 44952191 | **5 s (default)** | 131,628 |

Both `status: success`. The money actually moved — read back from INRx and
PolicyModule afterwards:

```
RekhaAccount INRx : 49990600     (was 50000000, -9400)
ven_meridian INRx : 9400         (was 0)
windowSpentMinor  : 9400
cumulativeSpentMinor : 9400
```

Run #2 used the **default 5-second lease TTL**. I had expected a 5s lease to be
too short to survive simulate + broadcast + mine and was ready to record that as
a limitation; it isn't one. LIMITATIONS.md's "5-second TTL" claim holds as
written, verified rather than assumed.

Reproduce with `apps/core/scripts/e2e-settle.ts <pairingCode>`.

---

## TASK 1 — compile

Already done before this run, commit `c2d1bd0`. Not redone. `keys.ts` accepting
either `CORE_SIGNER_PRIVATE_KEY` or `REKHA_CORE_PRIVATE_KEY` was kept.

## TASK 2 — real on-chain settlement ✅

Commits `251babe`, `8049d17`.

**The gap as found:** `store.ts:173` built its txHash with `randomBytes(32)` and
its block number with `Math.random()`. `payment.ts:227` called it. Every
"verifiable on Base Sepolia" claim in the product resolved to nothing.

**What changed:**

- `store.settleDecision(decisionId, txHash, blockNumber)` — takes both as
  parameters, generates neither. The `randomBytes` line is gone. It now records
  a settlement that already happened.
- `POST /v1/payment/settle` builds nothing itself: it looks up the exact struct
  the core signed at `/request`, broadcasts `RekhaAccount.execute` via
  `api/chain.ts`, waits for the receipt, and returns the mined hash.
- 503 `CORE_UNAVAILABLE` when there is no core key, no `REKHA_ACCOUNT_ADDRESS`,
  or no stored signed request. 422 with the decoded custom error name on revert
  — **observed working**, not just written: an early run returned
  `422 {"code":"InvalidAgentSignature"}`. Never a 500.
- The duplicated inline PaymentRequest tuple and the local `hashRequest` ABI are
  deleted from `payment.ts`. One construction path: `buildPaymentRequest()`,
  reached through `coreSign()`.

**Four things TASK 2 needed that FIX.md did not mention.** Each of these was
independently sufficient to make settlement impossible:

1. **The core signer has 0 ETH.** `0xB18D…` cannot pay for a transaction, so
   broadcasting from it fails every time. `execute` is authorized by the two
   signatures inside the request and not by `msg.sender` (`execute.fork.test.ts`
   broadcasts from an unrelated anvil account), so the broadcaster only has to be
   funded. Settlement now broadcasts from `DEPLOYER_PRIVATE_KEY`, overridable
   with `SETTLEMENT_BROADCASTER_PRIVATE_KEY`. Recorded in LIMITATIONS.md.
2. **The lease signature was a placeholder.** `store.issueLease` shipped
   `0x00…00` with a comment saying a real signature would come later. Settlement
   runs through `coreSign()`, whose first act is `validateLease()`, which
   recovers that signature — a placeholder recovers to an unrelated address, so
   *no* payment could ever have settled. It is now really signed with the core
   key over `leaseDigest()`, and the function became async.
3. **The counterparty registry was empty on chain.** `PolicyModule.validate`
   reads the tier from its own storage and reverts `CounterpartyBlocked` on tier
   0, deliberately ignoring the FactSheet's claim. With an empty registry nothing
   could settle regardless of policy. Registered the eight VendorSim vendors at
   their seeded tiers (`scripts/register-counterparties.mjs`, 8 owner txs, hashes
   in the commit output). This writes only data the registry already asserts — no
   cap, category or enforcement parameter was touched.
4. **The mandate was seeded with invented caps** (₹25,000 per tx, all 8
   categories) that did not match the deployed policy (₹10,000, `OTHER` only).
   The core would hand out an APPROVED trace for a payment the chain then
   reverts, which makes the decision panel a lie. `store.DEPLOYED_POLICY` now
   mirrors the values read off the deployment.

Also read predicates 6 (nonce) and 8 (counterparty tier) from PolicyModule at
request time — they live in chain storage and are the two the off-chain
evaluator cannot answer from memory. Both fail closed: an unreachable RPC
resolves to "nonce used" / "tier 0", each of which the evaluator refuses on.

**INRx balance check (FIX.md asked to mint if zero):** no mint was needed.
RekhaAccount already held 50,000,000 minor units (₹5,00,000). Verified before
touching anything, via `scripts/chain-state.mjs`.

## TASK 3 — real evaluator ✅ (by a different route)

FIX.md proposed switching one import from `./mock-evaluator.js` to
`../evaluator.js`. I did not do that, because TASK 2 had already made it
redundant and doing both would have double-evaluated every request.

`/v1/payment/request` now goes through `coreSign()`, and `coreSign()` *is* the
real evaluator plus the signature — it validates the lease, runs A's evaluator,
and signs only an APPROVED outcome. One decision, one signature, one construction
path, which is what TASK 2 required anyway.

The route's external contract is unchanged: same body, same status codes, same
SSE events, same response shape. `mock-evaluator.ts` is untouched on disk and
imported by nothing — the rollback FIX.md asked for is intact. To roll back,
restore the previous `payment.ts` from `251babe^`.

A's evaluator is verified against the deployed Solidity at **10,000/10,000**
(see below).

## TASK 4 — frontend routing ✅

Commit `264b8b1`. `apps/web/src/app/page.tsx` went from 463 lines of prototype
HTML injected through `dangerouslySetInnerHTML` (loading Supabase off a CDN,
wiring buttons via `document.getElementById`) to a Server Component
`redirect('/console')`. Nothing else deleted.

Per `apps/web/AGENTS.md` I read `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/redirect.md`
first rather than assuming the API — this is Next 16.2.12. `next build` passes;
`/` prerenders alongside `/console` and `/playground`.

## TASK 5 — honesty pass ✅

- README.md: deleted "(if any part still uses it)".
- LIMITATIONS.md: TASK 2 succeeded, so the "Real token, real transfers" row was
  left standing as FIX.md directed, and a Settlement row was added. Three things
  I found were added as disclosures: the `OTHER`-only category allow-list, the
  gas payer, and the agent-must-rebuild-the-request rough edge.

---

## Verification

Everything below was run, not assumed.

**`pnpm exec tsc --noEmit` in apps/core:** clean, no output.

**Full core suite, with `anvil --fork-url https://sepolia.base.org --port 8546`
and a plain `anvil --port 8545`:**

```
 ✓ test/explain.test.ts (11 tests)
 ✓ test/evaluator.test.ts (32 tests)
 ✓ test/lease.test.ts (19 tests)
 ✓ test/signing.test.ts (17 tests)
 ✓ test/hash-request.fork.test.ts (2 tests)
 ✓ test/execute.fork.test.ts (4 tests)
 ✓ test/differential.test.ts (1 test) 175220ms
      10000/10000 agree
 Test Files  7 passed (7)
      Tests  86 passed (86)
```

`differential.test.ts` had never actually run: it makes 10,000 × 3 RPC
round-trips under vitest's 5-second default timeout, so it could only ever time
out. Given a real timeout it passes 10,000/10,000 against the deployed Solidity.
That is the test that underwrites TASK 3, so it mattered that it run.

Without anvil, the three fork-dependent files fail on `ECONNREFUSED` and the
other 79 tests pass — the state TASK 1 described.

**`next build` in apps/web:** compiled, TypeScript clean, 4 routes generated.

## What I did NOT verify

- **The console UI against a real settlement.** I drove the API directly with
  `scripts/e2e-settle.ts`; I never clicked through `/console` and confirmed the
  panel renders a real hash. The SSE `payment.settled` event now carries a mined
  hash instead of a fabricated one, but whether the frontend displays it
  correctly is unchecked.
- **Any category other than `OTHER`, and any tier-2 counterparty, end to end.**
  Both runs used tier-1 `ven_meridian` with `OTHER`. The tier-2 soft-fail path
  (predicates 9–11) is covered by the differential test but not by a live
  broadcast.
- **Concurrent settlement.** Two requests approved against the same nonce would
  race; the second reverts `NonceAlreadyUsed`, which is fail-closed and correct,
  but I did not test it.
- **`apps/agents`** — not in scope for any task and not exercised.

## Things I inferred rather than verified

- `store.DEPLOYED_POLICY` is a **hardcoded snapshot** of the deployment read on
  2026-08-02, not a live read at boot. If someone calls `setPolicy` on the live
  contract, the mandate silently drifts from the chain again. Re-run
  `scripts/chain-state.mjs` and update the constant, or make it a startup read.
  I left it static to keep the core bootable without an RPC.
- The counterparty tiers written on chain come from `apps/vendorsim/seed/vendors.js`.
  I took that file as the registry of record because the demo already treats it
  that way; nobody confirmed it to me.

## Decisions I deliberately did not make

**The live `permittedCategories` is 128 — `OTHER` only.** This traces to
`vm.envOr("PERMITTED_CATEGORIES", 1 << 7)` in `Deploy.s.sol` with the variable
unset, so it is almost certainly an accident rather than a policy. Widening it is
one owner `setPolicy` call and I hold the owner key.

I did not make that call. Registering counterparties is writing registry data
that already exists elsewhere; changing the category allow-list is changing what
the product enforces, on a live deployment, on submission day. FIX.md rule 6 says
to skip decisions I cannot verify — this is one. It is disclosed in
LIMITATIONS.md and in `store.ts` next to the mirrored constant.

The consequence is honest but real: with the deployment as it stands, the
storefront purchases in the demo (PACKAGING, LOGISTICS, …) are REFUSED on
predicate 7 rather than settling. The enforcement is genuine and the refusal
trace is accurate — but if you want the vendor flow to settle on stage, that
`setPolicy` call is the one thing standing in the way, and it is your call.
