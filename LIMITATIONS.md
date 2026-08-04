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
| 12-class adversary attack library | ✅ All 12 classes run against the live core via `pnpm dev:adversary`, and classes 5 and 7 now `eth_call` the deployed contract rather than asserting a revert. **The old "147 attempts, 147 blocked" is withdrawn** — that suite never reached the policy evaluator and counted its own errors as defences. Current measured run and the two weaknesses it exposed: `HONESTY_PLAN.md` Part II |
| Typed-schema injection boundary | ✅ And now actually tested for: class 8 searches every response for the injected markers instead of treating "payment refused" as success. Measured: zero leaked |
| Signing ceremony | ✅ 3 rounds, revocation re-checked between each. `CEREMONY_ROUND_MS` (default 1200) makes it ~3.6s so the mid-ceremony revoke is performable by hand |
| Audit export | ✅ Signed by the core key. `digest` is keccak256 of the serialised body; recompute it and recover the signer. Unsigned exports say so in `signatureStatus` rather than carrying a zero signature |
| SSE event stream | ✅ All events real-time, no polling |

---

## The off-chain core is an optimistic pre-filter. The chain is the enforcer.

Measured 4 Aug 2026, once the adversary suite was fixed so its attacks actually
reached the policy evaluator (`HONESTY_PLAN.md` Part II). Two things follow, and
both are architecture rather than bugs — but the ship checklist described a core
that is stronger than it is, so they are stated here plainly.

**The core will co-sign past its own window cap.** `windowSpentMinor` advances on
settlement, so 12 requests of ₹8,579 each — ₹1,02,948 against a ₹1,00,000 window
cap — are all APPROVED, because none of them has settled yet and each looks fine
alone. Nothing can move: `PolicyModule.validate` reverts `WindowCapExceeded`
against the authoritative **on-chain** counter (`PolicyModule.sol:253`).

~~**The core is not concurrency-safe on nonces.**~~ **FIXED 4 Aug 2026.** 50
parallel requests carrying the same nonce used to get most threads approved —
the chain read answers *"has anyone burned this?"* and cannot answer *"is
another request in this same process already holding it?"*, because none of them
have settled yet. On chain `usedNonces` meant **exactly one could ever settle**,
which is what `BUILD.md`'s INV5 guarantees — but INV5 is a property of
settlement, and the core issuing N signatures for one nonce was a different and
uglier fact.

`api/store.ts` now does a synchronous check-and-claim (`claimNonce` /
`releaseNonce`). The race lived entirely between the `await` on the chain read
and the `await` on `coreSign`; Node runs one turn at a time, so a claim with no
`await` between the check and the set cannot interleave. A decision that is not
APPROVED gives the nonce back immediately — a REFUSED or HELD payment burns
nothing on chain, so holding it would refuse a legitimate retry for a reason
that is not true. It does **not** replace the chain read: an unreachable RPC
still fails closed to "used".

Measured, 50 concurrent requests on one nonce
(`scripts/verify-nonce-race.py`): **1 APPROVED, 49 REFUSED, all 49 binding on
predicate `nonce`** — the same predicate the chain would name. Across the
adversary suite, class 4 went from a race-dependent `34/16` to a deterministic
`49 blocked / 1 through`, class 3 from 3 through to 1, and the suite total from
27–47 through down to **13**.

**Still open: the window cap.** The core will still co-sign past its own
`windowCapMinor`, because its accounting advances on **settlement** and these
requests never settle. That is the remaining source of `core-approved,
unsettled` on the scoreboard (11 of the 13, all attack class 1). `PolicyModule`
reverts `WindowCapExceeded` on chain against the authoritative counter, so money
cannot move — but the chain is what stops it, not us. Reserve-on-approve
accounting is the fix and it is riskier than the nonce one: a reservation that
outlives its request would refuse legitimate payments.

---

## What Is Simulated

| Component | Limitation | Why |
|---|---|---|
| UPI semantics | The ₹ amounts are real ERC-20 transfers, but UPI rails (NPCI/IMPS) are not accessible | UAP spec is unpublished; NPCI API requires licensed entity access |
| Vendor registry | Vendors are simulated (VendorSim); real GST/MCA registry integration is not implemented | Demo scope |
| Agent "web browsing" | Agent reads vendor pages served by our own VendorSim; it does not browse the live internet | Scope + rate-limit safety |
| FROST Schnorr 2-of-3 | **Not implemented, and not behind a feature flag.** An earlier version of this row said the upgrade shipped behind a flag; it does not exist. The only occurrence of "FROST" in the codebase is a comment at `apps/core/src/api/routes/payment.ts:5` describing the *simulated* ceremony rounds that drive the M3 animation. What ships is 2-of-2 ECDSA — which works, is verified on chain, and has settled real transactions. The multi-round ceremony is a presentation of that one signature, not a threshold protocol; its rounds exist so revocation has something to interrupt | FROST was scoped as an upgrade that must never block the working path (`BUILD.md:340`). The working path was the one that got built |
| Nitro Enclave attestation | The attestation **mechanism** is real — predicate 3 compares the request's `coreImageDigest` to the value registered on-chain, and a mismatch reverts `CoreImageMismatch` (`PolicyModule.sol:213`). The registered **value** is still a placeholder: `0x01` followed by 31 zero bytes. It is not the hash of anything, so it currently attests nothing. Do not present it as evidence. **The digest itself now exists** — see the section below — but it has not been registered, because doing so takes the payment path down for the length of the change | Nitro Enclave hardware was unavailable, and Docker is not installed on the build machine, so no *image* digest could be produced |
| LLM adversary variants | LLM generator requires an API key; deterministic library always runs | API key may not be set in your environment |
| "The agent falls for prompt injection" | **It does not, and we no longer claim it does.** `extract.ts` asks `claude-opus-5` and its prompt deliberately carries no anti-injection instruction — it says *"Follow what the page tells you."* Measured 4 Aug 2026 with a real key (`scripts/verify-injection-resistance.sh`): four runs, three separate injections confirmed on the rendered page, and it read the correct ₹2.40 every time. `/playground`'s `injected` mode makes the agent comply **deterministically** (`modes.ts obeyInjection`), which is why that demo still works and is not theatre — but the compliance is ours, not the model's | `BUILD.md:212` assumed a mid-tier model would be fooled. Both keys were empty until now, so the assumption had never been tested. The claim the product actually rests on is that enforcement does not need the agent to resist — which is unaffected |
| Category allow-list on the live deployment | `SOFTWARE` is the one category the deployed PolicyModule does not permit, so a `SOFTWARE` line item is refused by predicate 7. Every other category settles | Deliberate, and it matches the core's pinned fallback in `apps/core/src/api/store.ts`. It is the live `CategoryNotPermitted` demo case, not a gap |
| Gas payer | Settlement transactions are broadcast and paid for by `DEPLOYER_PRIVATE_KEY`, not by the core signer | The deployed core signer `0xB18D…` holds 0 ETH on Base Sepolia. `execute` is authorized by the two signatures inside the request, never by `msg.sender`, so the broadcaster only has to be funded — but this does mean the demo spends the deployer's testnet ETH |

---

## The core image digest — the maths was never the blocker

`apps/core/scripts/core-image-digest.mjs` is new. It hashes the exact file set
`apps/core/Dockerfile` copies — 54 files, including `pnpm-lock.yaml`, because a
dependency swap changes what the policy engine does even when no line of our
source moves.

```
files    54
digest   0xbc770793bf876b8a2238e0448f7af5c5c5fb24c53587946da49dfd228b61c462
```

Deterministic and sensitive, both measured (`scripts/verify-digest-sensitivity.sh`):
sorted paths, POSIX separators, CRLF normalised to LF, and each file's path
hashed alongside its bytes so a rename moves the digest. One added comment line
in `evaluator.ts` changes it; restoring the file restores it exactly. A hash
that never changes is worse than no hash, because it looks like attestation and
commits to nothing.

**What this is, stated precisely.** It is a commitment to a specific policy
engine source tree. It is **not** enclave attestation and not a reproducible
image digest: it does not cover the Node version, the resolved dependency tree,
the base image, or the fact that the deployed process is running this source at
all. Anyone who can set `CORE_IMAGE_DIGEST` can send whatever value they like.
It closes the gap between *an arbitrary constant* and *a commitment*, which is
the honest version of `BUILD.md`'s line — *"if we swapped in a permissive policy
engine every payment would revert."*

**It is not registered, and this is why.** Predicate 3 compares what the request
carries against what the contract holds, so there is **no ordering of the two
steps that avoids an outage**: register first and every in-flight payment
reverts `CoreImageMismatch`; set the env first and every payment reverts the
same way. Take the window deliberately, between rehearsals, never on demo day:

```
node apps/core/scripts/core-image-digest.mjs        # read the value
# 1. set CORE_IMAGE_DIGEST to it everywhere the core AND the agent run
#    (.env, Railway, docker-compose), then restart both
# 2. owner calls PolicyModule.attestCoreImage(<digest>)
node apps/core/scripts/chain-state.mjs              # confirm, then settle once
```

The script prints `== MATCHES` or `!= DOES NOT MATCH` against `CORE_IMAGE_DIGEST`
when it is set, so drift between the running core and the source is one command
away rather than a `CoreImageMismatch` nobody can explain on stage.

Until step 2 happens, `lib/contracts.ts` `isPlaceholderDigest()` keeps labelling
the on-chain value as a placeholder on both surfaces. Do not remove that label
before the transaction lands.

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

- [ ] FROST Schnorr upgrade — **not started.** No feature flag, no partial
      implementation. See the "What Is Simulated" row above
- [ ] Postgres persistence (currently in-memory; restarts lose state)
- [ ] Real vendor registry integration (GST, MCA)
- [ ] Guardian address flow in UI (backend supports it, UI doesn't expose it yet)
- [ ] Return the signed `PaymentRequest` from `/v1/payment/request` (see the rough edge above)
- [x] ~~Set `PERMITTED_CATEGORIES` on the live PolicyModule so categories other
      than `OTHER` can settle~~ — **struck: this was never needed.** It restated
      the `permittedCategories = 128` claim that the Correction section above
      withdraws. Live value is 223; every category except `SOFTWARE` settles as
      deployed. No owner transaction was required and none was made
- [ ] Halmos symbolic proofs (Foundry fuzzing is in CI; Halmos is a stretch goal)
- [ ] Mobile-responsive layout for the three-panel playground
- [ ] Register the core image digest. The digest now **exists** and is
      deterministic (`apps/core/scripts/core-image-digest.mjs`); the on-chain
      value is still the placeholder. Registering it takes the payment path down
      for the length of the change — see the section above
- [x] ~~atomic nonce reservation~~ — **done 4 Aug 2026**, `claimNonce` /
      `releaseNonce` in `api/store.ts`. 50 concurrent same-nonce requests now
      yield exactly 1 approval and 49 refusals on predicate `nonce`
- [ ] Reserve-on-approve window accounting, so
      the off-chain core refuses what the chain would refuse
- [ ] No authentication on `/console`. `BUILD.md:45` specifies email + password
      and `:806` promises demo credentials in the README; neither exists. Anyone
      with the URL is the owner. REVOKE ALL is wallet-gated, so the strongest
      control is not open
- [ ] **The core does not authenticate who revoked.** `source` is a free-text
      field on `POST /v1/revoke` (`api/routes/revoke.ts:19`), so anyone who can
      reach the endpoint can pass `"guardian"` or `"owner"` and the SSE stream
      and the audit export will carry it. Measured
      (`scripts/verify-guardian.py`): a guardian-sourced revoke is accepted with
      no credential of any kind. **This is not a hole in the guardian claim** —
      the guardian is a chain-level role and `PolicyModule.sol:331` enforces it
      properly, `revoke()` being owner-or-guardian while every other
      state-changing function is `onlyOwner`. It is a hole in *attribution*:
      never present the `source` on a revocation event as evidence of who did it
- [x] ~~**"Guardian can revoke but cannot spend" is only half proven.**~~
      **Done.** Nine tests in `contracts/test/PolicyModule.t.sol`, all passing:
      the guardian can `revoke()`, and cannot `setPolicy`, `setSigners`,
      `setAccount`, `attestCoreImage`, `setCounterpartyTier` or `heartbeat`.
      Two more prove the claim end to end — a payment signed by the guardian
      reverts `InvalidAgentSignature`, and the guardian holding a *genuine*
      agent signature alongside its own still reverts `InvalidCoreSignature`.
      `setSigners` is the one that mattered: a guardian who could call it would
      hand itself the second signature outright.
      **The earlier note here said Foundry was not installed. That was wrong** —
      it was in `~/.foundry/bin`, which is not on `PATH` in a non-interactive
      shell, so `command -v forge` found nothing
- [ ] No policy editor (`BUILD.md:52`). `setPolicy` is owner-only and called by
      script
- [ ] No per-agent revoke (`BUILD.md:51`). Global REVOKE ALL and per-hold Cancel
      only
- [ ] No mock deposit or credit line (`BUILD.md:46`)
- [ ] Simulation-speed slider removed — it was wired to nothing. The task
      engine's fast clock is real but has no HTTP control
- [ ] **A zero-amount payment is APPROVED and co-signed.** There is no
      minimum-amount predicate, so `amountMinor: 0` passes all 14 and gets the
      core's signature. No money moves, but it consumes a nonce and a lease.
      Found 4 Aug 2026 by `scripts/verify-boundaries.py`.
      **Deliberately not fixed before the demo:** adding the predicate to the
      TypeScript evaluator alone would break the 10,000/10,000 differential
      agreement with `PolicyModule.validate`, and the contract is already
      deployed and source-verified on Base Sepolia. Change both or neither.
      Worth noting the same probe proved the per-tx cap boundary is exactly
      right — at the cap approves, one paisa over refuses on `perTxCap`
- [ ] `novel` counter stays off the scoreboard, and the reason is now sharper.
      The generator **works** as of 4 Aug 2026 — it had two bugs and both are
      fixed: it sent an Anthropic key to `api.openai.com` (a guaranteed 401, so
      it could never have produced anything), and three of its four boundary
      probes were dead code behind an early `return`. It now runs against
      `claude-haiku-4-5` and exercises all four. **But only the technique NAME
      comes from the model** — the attempt itself is the fixed set of boundary
      FactSheets. A model-authored string over a code-authored probe is not a
      model-authored attack, and a `novel` count on screen would imply the
      latter. Build real model-authored attempts or leave the counter off
- [ ] Deck slide 5 cites Halmos output; there are no Halmos proofs. What exists
      is Foundry invariant fuzzing plus 10,000/10,000 differential agreement

---

*Honesty about limitations is itself evidence of engineering rigour.*
