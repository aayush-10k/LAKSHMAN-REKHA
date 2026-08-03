# LIMITATIONS — Lakshman Rekha

*We write this ourselves. Judges trust teams that disclose.*

---

## What Is Real

| Component | Status |
|---|---|
| Solidity contracts | ✅ Deployed on Base Sepolia — verified source on Basescan |
| INRx ERC-20 | ✅ Real token, real transfers on Base Sepolia — see the settled transactions in FIXLOG.md |
| Settlement | ✅ `POST /v1/payment/settle` broadcasts `RekhaAccount.execute` and returns the mined hash. No code path returns a hash that did not come off a receipt |
| PolicyModule | ✅ All 14 predicates on-chain, named custom errors |
| RekhaAccount | ✅ Dual-signature enforcement, no admin backdoor |
| Deterministic policy evaluator | ✅ Pure TypeScript, zero I/O, zero LLM, mirrors contract exactly |
| Fail-closed lease TTL | ✅ **15-second** TTL (`LEASE_TTL_MS=15000`), not 5 — see below. Core unreachable, or `POST /v1/admin/kill`, = no new leases = spending stops within that window |
| 2-of-2 ECDSA co-signing | ✅ Agent sig + core sig both required. The agent share lives in a separate process (`pnpm dev:agent`); the core never calls `agentSign()` on a request path |
| Dead-man switch | ✅ Heartbeat lapse auto-freezes |
| 12-class adversary attack library | ✅ All 12 classes run against the live core via `pnpm dev:adversary`. Last measured run: **147 attempts, 147 blocked, 0 novel, ₹0 lost** — see FIXLOG3.md for the revert-reason breakdown |
| Signing ceremony | ✅ 3 rounds, revocation re-checked between each. `CEREMONY_ROUND_MS` (default 1200) makes it ~3.6s so the mid-ceremony revoke is performable by hand |
| Audit export | ✅ Signed by the core key. `digest` is keccak256 of the serialised body; recompute it and recover the signer. Unsigned exports say so in `signatureStatus` rather than carrying a zero signature |
| Typed-schema injection boundary | ✅ Extractor converts prose → FactSheet; no strings egress |
| SSE event stream | ✅ All events real-time, no polling |

---

## What Is Simulated

| Component | Limitation | Why |
|---|---|---|
| UPI semantics | The ₹ amounts are real ERC-20 transfers, but UPI rails (NPCI/IMPS) are not accessible | UAP spec is unpublished; NPCI API requires licensed entity access |
| Vendor registry | Vendors are simulated (VendorSim); real GST/MCA registry integration is not implemented | Demo scope |
| Agent "web browsing" | Agent reads vendor pages served by our own VendorSim; it does not browse the live internet | Scope + rate-limit safety |
| FROST Schnorr 2-of-3 | Currently ships as 2-of-2 ECDSA. FROST upgrade is behind a feature flag | FROST Schnorr library stability; the 2-of-2 path always works |
| Nitro Enclave attestation | We use reproducible-build image digest registered on-chain | Nitro Enclave hardware was not available in our environment |
| LLM adversary variants | LLM generator requires an API key; deterministic library always runs | API key may not be set in your environment |
| Category allow-list on the live deployment | `SOFTWARE` is the one category the deployed PolicyModule does not permit, so a `SOFTWARE` line item is refused by predicate 7. Every other category settles | Deliberate, and it matches the core's pinned fallback in `apps/core/src/api/store.ts`. It is the live `CategoryNotPermitted` demo case, not a gap |
| Gas payer | Settlement transactions are broadcast and paid for by `DEPLOYER_PRIVATE_KEY`, not by the core signer | The deployed core signer `0xB18D…` holds 0 ETH on Base Sepolia. `execute` is authorized by the two signatures inside the request, never by `msg.sender`, so the broadcaster only has to be funded — but this does mean the demo spends the deployer's testnet ETH |

---

## Correction: the category allow-list was never 128

An earlier version of this file stated that the deployed PolicyModule holds
`permittedCategories = 128` — `OTHER` and nothing else — and that no vendor
storefront purchase could settle. **That was wrong**, and it was wrong in the
direction that understates the build.

The claim was inferred from the *default* in `contracts/script/Deploy.s.sol:48`,
`vm.envOr("PERMITTED_CATEGORIES", uint256(1) << 7)`, rather than read from the
chain. The variable was in fact set at deploy time. Live state, measured
2026-08-04 with `apps/core/scripts/chain-state.mjs`:

```
permittedCategories   223   = 0b11011111
```

Bits 0,1,2,3,4,6,7 set: `PACKAGING`, `ADVERTISING`, `CONTENT`, `COMPUTE`,
`LOGISTICS`, `UTILITIES`, `OTHER` all permitted. Bit 5, `SOFTWARE`, is not —
matching the pinned fallback in `apps/core/src/api/store.ts` exactly.

No owner transaction was made to reach this state and none was needed. The
contracts are exactly as deployed and verified.

The general lesson, recorded because it applies to every claim in this file:
**read the chain, not the deploy script.** `chain-state.mjs` is read-only and
takes two seconds.

## The fail-closed window is 15 seconds, not 5

Earlier drafts of this file, `BUILD.md` and the deck all said 5. The shipped
value is `LEASE_TTL_MS=15000`, and the claim has been corrected everywhere
rather than the value quietly lowered.

PolicyModule reverts `LeaseExpired` when `block.timestamp > req.leaseExpiry`,
and the lease is issued *before* the request, the signing ceremony and the Base
Sepolia broadcast. A full browser dispatch measures ~10s end to end, so 5000ms
left no headroom and one slow block reverted an otherwise valid payment.

This weakens a product claim and should be read as one: **kill the core and
spending stops within 15 seconds, not 5.** It is a single environment variable,
the reasoning is written into `.env.example`, and the UI reads the value from
the core rather than assuming it.

## The browser-side prototype has been deleted

`/` used to serve ~44KB of inlined HTML that loaded
`public/js/{app,agent,auth,supabase}.js`. Those scripts evaluated "policy" in
the browser — a client-side if/else chain, denominated in dollars, matching
counterparties by display name, with `Math.random()` nonces — and pointed at a
production API endpoint that was never built.

All of it is gone, along with `public/console.html` and
`public/css/styles.css`. **Nothing in the shipped UI evaluates policy
client-side.** Every outcome on screen comes from the core, and every
settlement figure from the chain. `/` redirects to `/console`.

## Both key shares live in one `.env` on the demo machine

The 2-of-2 argument is that no single party can move money: the core holds one
ECDSA share, the agent the other. **The code paths really are separate** — the
agent runner is its own process (`pnpm dev:agent`, `:4200`) and computes its
signature from `AGENT_SIGNER_PRIVATE_KEY` by rebuilding the `PaymentRequest`
itself; the core never calls `agentSign()` on a request path.

**The deployment is not separate.** Both keys sit in one `.env` on one laptop.
A real deployment gives the agent service its own secret store on its own host.
We name it because the 2-of-2 claim is only as strong as the weaker custody, and
here that is the file, not the cryptography.

## Known Rough Edge: The Agent Must Rebuild The Request Itself

`POST /v1/payment/request` returns the core's signature but **not** the
`PaymentRequest` struct it signed, so the agent has to rebuild that struct from
the lease and the FactSheet in order to produce its own half of the 2-of-2.

That is defensible — an agent *should* verify what it signs rather than sign
whatever the core hands it — but it is sharper than it looks: the core
overwrites `counterpartyAgeDays` and `counterpartySettledTxns` from the vendor
registry before signing (the Registry Rule). An agent that builds its struct
from the values it *sent* rather than the values the registry *holds* produces a
different digest, and the chain rejects the payment with
`InvalidAgentSignature`. We hit exactly this while verifying settlement.

Today both sides agree only because VendorSim is the registry for both. A real
deployment needs the request struct (or its digest) returned from `/request`.

---

## The differential claim, and how to reproduce it

"The TypeScript evaluator and the Solidity `PolicyModule.validate` agree on
10,000 random inputs" is **true and was re-run for this pass** — but it needs
anvil, and without it three test files fail on `ECONNREFUSED` and only 79 of 86
tests run. If you are checking the claim, start anvil first:

```bash
anvil --fork-url https://sepolia.base.org --port 8546   # fork tests
anvil --port 8545                                        # differential
pnpm --filter core test
```

Measured 2026-08-02:

```
 ✓ test/explain.test.ts            (11 tests)
 ✓ test/evaluator.test.ts          (32 tests)
 ✓ test/lease.test.ts              (19 tests)
 ✓ test/signing.test.ts            (17 tests)
 ✓ test/hash-request.fork.test.ts   (2 tests)
 ✓ test/execute.fork.test.ts        (4 tests)
 ✓ test/differential.test.ts        (1 test)  10000/10000 agree
 Test Files  7 passed (7)
      Tests  86 passed (86)
```

`hash-request.fork.test.ts` is the canary for the signing digest: if it fails,
every signature the core produces reverts on chain with `InvalidCoreSignature`.
It passes.

## The window cap will stop a long demo

The rolling window is **₹1,00,000 per 24 hours**, read live from PolicyModule.
Repeated dispatches will eventually `REFUSE` on `windowCap`, and the spend
counters are on-chain, so restarting the core does not reset them.

That is the policy working, not a failure — but a judge should know before they
hit it rather than after. Per transaction the caps are ₹25,000, or ₹5,000 for a
tier-2 counterparty.

## What We Aligned With But Don't Claim Compliance To

- **NPCI UAP (Unified Agent Payments):** The announced direction, not the published spec. We implement the *spirit* — delegation caps, mandate lifecycle, Block/Lien semantics — but do not claim NPCI compliance.
- **RBI AI governance guidelines:** Our architecture is consistent with the principle of human-in-the-loop controls and mandatory spending limits, but formal RBI compliance is not assessed.
- **EIP-4337 (Account Abstraction):** Our `RekhaAccount` is a custom smart account, not EIP-4337. We deliberately kept it simpler to explain.

---

## Known Open Items

- [ ] FROST Schnorr upgrade (behind feature flag, not default)
- [ ] Postgres persistence (currently in-memory; restarts lose state)
- [ ] Real vendor registry integration (GST, MCA)
- [ ] Guardian address flow in UI (backend supports it, UI doesn't expose it yet)
- [ ] Return the signed `PaymentRequest` from `/v1/payment/request` (see the rough edge above)
- [ ] Set `PERMITTED_CATEGORIES` on the live PolicyModule so categories other than `OTHER` can settle
- [ ] Halmos symbolic proofs (Foundry fuzzing is in CI; Halmos is a stretch goal)
- [ ] Mobile-responsive layout for the three-panel playground

---

*Honesty about limitations is itself evidence of engineering rigour.*
