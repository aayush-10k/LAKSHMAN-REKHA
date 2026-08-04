# THREAT MODEL — Lakshman Rekha

*InnovaHack Chapter 1 · Round 2 · FinTech PS2*

> **Audited against the code on 4 Aug 2026.** Every defence below now names the
> file that implements it, or says plainly that it is not implemented. Four
> claims in the previous version described software that does not exist in this
> repository — they are marked **NOT IMPLEMENTED** rather than deleted, so the
> diff shows what was withdrawn and why. See `HONESTY_PLAN.md` for the same
> exercise applied to `BUILD.md`.

---

## Trust Boundary

```
┌──────────────────────────────────────────────────────────┐
│  UNTRUSTED ZONE (everything outside the dashed line)     │
│   Shopper Agent   [KEY SHARE A — alone: powerless]       │
│   Adversary Agent                                        │
│   Vendor Simulator (legit + counterfeit storefronts)     │
│   Extractor (quarantined, typed-schema egress only)      │
│   Raw HTML, prose, LLM outputs, injected pages           │
└──────────────────────────────────────────────────────────┘
                ═══ TYPED SCHEMA ONLY — no strings pass ═══
┌──────────────────────────────────────────────────────────┐
│  TRUSTED ZONE — REKHA CORE           [KEY SHARE B]       │
│   Deterministic Policy Evaluator → DecisionTrace         │
│   Lease Issuer (15s TTL as deployed, fail-closed)        │
│   2-of-2 Co-Signer (A's sig + B's sig required)          │
│   Explanation Renderer (templates, no LLM)               │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│  ON-CHAIN — Base Sepolia                                 │
│   PolicyModule   · caps, tiers, revocationEpoch, nonces  │
│   RekhaAccount   · holds INRx, dual-sig required         │
│   INRx (ERC-20)  · the ₹ ledger                          │
└──────────────────────────────────────────────────────────┘
               ┌──────────────────┐
               │  OWNER BROWSER   │  OWNER EOA — not a key share
               │  revoke → chain  │  (bypasses all our services)
               └──────────────────┘
```

**Two corrections to the box above, both material.**

1. **The owner key is not "key share C".** The signing scheme is **2-of-2 ECDSA**
   — `agentSignature` and `coreSignature`, both verified in
   `PolicyModule.validate` — plus a **separate `onlyOwner` EOA** that owns the
   contract and can call `revoke()`, `setPolicy()` and `heartbeat()` on its own
   authority. Calling it a third share of a 2-of-3 threshold implies a scheme in
   which no single party can act alone. The owner *can* act alone: `revoke()` is
   `onlyOwner` and needs neither A nor B. That is a deliberate and good property
   — the kill switch must not depend on our infrastructure — but it is a
   **co-signer architecture with an owner override**, not a threshold signature.

2. **Lease TTL is 15 000 ms as deployed**, not 5 s. `LEASE_TTL_MS` defaults to
   `5_000` in `apps/core/src/signing/constants.ts:26`, and every shipped
   configuration overrides it to `15000` (`.env:9`, `apps/core/Dockerfile:54`,
   `docker-compose.yml:68`). Fail-closed window is therefore **up to 15 s**, and
   the honest sentence on stage is *"spending stops within fifteen seconds"* —
   `LIMITATIONS.md` already states it that way.

---

## Attacker Model

**The agent is assumed fully compromised at all times.**

The agent:
- Holds key share A (produces a partial signature — alone, useless)
- Can call any API it has been pointed at
- Can read arbitrary web pages
- May have its system prompt replaced by an attacker
- May collude with an attacker-controlled vendor

The agent **cannot**:
- Produce a valid co-signature without the core's key share B
- See or modify the PolicyModule on-chain
- Bypass the typed-schema FactSheet boundary
- Issue its own leases
- Un-revoke itself

**Measured, not asserted.** `POST /rail-bypass` on the agent runner
(`apps/core/src/agent/runner.ts`) mounts the first of these from the agent's real
position: it reads live policy, builds a `PaymentRequest`, signs it with
`AGENT_SIGNER_PRIVATE_KEY`, and puts *its own* signature in the core's slot —
not zero bytes, which would die inside OpenZeppelin's ECDSA on a malformed
signature and prove far less. `ECDSA.recover` succeeds and returns a real
address; it simply is not `coreSigner`.

```
outcome   reverted
revert    InvalidCoreSignature
predicate coreSignature
agent     0x6E19cA2B53986EAEeE638412A4051651a64a00d5   keyShare A of 2
```

It passes predicate 1, `agentSignature`, and dies on predicate 2 — the one thing
it cannot forge. **This is an `eth_call`, not a broadcast transaction**, because
the agent address holds 0 ETH; there is no tx hash and the UI never offers one.

---

## The 12 Attack Classes (B7)

Each row states the defence **that actually fires**, which for three of the
twelve is not the defence the class was named for.

| # | Technique | What actually stops it | Predicate | Where |
|---|---|---|---|---|
| 1 | **Structuring** — many payments under the per-tx cap | **On-chain only.** See the correction below — the core co-signs past its own window cap | `windowCap` (on-chain) | `PolicyModule.sol:253` |
| 2 | **Category Spoofing** — claim a blocked purchase is permitted | `categoryCode` is a fixed enum from a SKU lookup, never free text | `categoryPermitted` | `agent/extract.ts` |
| 3 | **Lease Replay** — reuse a settled lease/nonce | Nonce registry on-chain; replay → `NonceAlreadyUsed` revert | `nonce` | `PolicyModule.sol` |
| 4 | **TOCTOU Race** — concurrent payments, same nonce | On-chain nonce registry serialises; exactly one can settle. **The core is not concurrency-safe here** — see the correction below | `nonce` (on-chain) | `PolicyModule.sol` |
| 5 | **Rail Bypass** — call `RekhaAccount.execute()` directly | Contract calls `validate()` first; no core sig → `InvalidCoreSignature`. **Measured against the deployed bytecode**, not simulated | `agentSignature`, `coreSignature` | `agent/runner.ts` `/rail-bypass` |
| 6 | **Signature Forgery** — craft a signature without key B | ECDSA verification in `PolicyModule`; forge fails | `coreSignature` | `PolicyModule.sol` |
| 7 | **Core Impersonation** — stand up a fake core | Only the address holding key B produces a valid core sig. Also measured via `/rail-bypass` (`fake-core` variant) | `coreSignature` | `agent/runner.ts` |
| 8 | **Prompt Injection** — embed instructions in vendor pages | FactSheet is typed; prose never reaches the evaluator. Injected text cannot move the counterparty | schema boundary | `validate-factsheet.ts` |
| 9 | **Self-Dealing** — vendor the agent controls | Counterparty attributes come from the registry, not the page | `counterpartyAge`, `counterpartySettled`, `counterpartyTier` | `evaluator.ts` |
| 10 | **Owner Social Engineering** — spoofed approval prompts | The core signs the audit export and attaches a signature to APPROVED traces. **The UI does not verify signatures** — see the correction below | (signed trace) | `payment.ts:162` |
| 11 | **Clock Manipulation** — false timestamps | Core uses its own clock; `leaseExpiry` is set at issuance and never read from the request | `leaseExpiry` | `lease/index.ts:133` |
| 12 | **Lease Renewal Griefing** — flood renewal endpoint | **NOT IMPLEMENTED.** No rate limiting exists in the core. The fail-closed property still holds: no leases → spending stops | fail-closed only | — |

### Class 1 — the core will co-sign past its own window cap

The previous version of this table said *"per-tx cap blocks each split; window
cap blocks cumulative"*. Measured 4 Aug 2026, once valid hex ids let the attack
reach the evaluator at all, **every slice was APPROVED, including the ones past
the cap.**

The reason is straightforward and worth saying out loud: the core's
`windowSpentMinor` advances on **settlement**, and this attack never settles, so
each request looks fine on its own. The chain is the authoritative counter —
`PolicyModule.validate` reverts `WindowCapExceeded` against on-chain spend. Money
cannot move. But the core is not the thing that stopped it, and the scoreboard on
`/playground` now reports these as `core-approved, unsettled` rather than
`blocked`.

The old figure — *60 × ₹800 = ₹48,000* — could never have tested this predicate
either way: ₹48,000 is under a ₹1,00,000 window cap, so **neither the per-tx cap
nor the window cap could fire**. The attack now sizes its slices from live
headroom.

### Class 4 — the core is not concurrency-safe on nonces

50 parallel requests carrying the same nonce get most threads approved. The
`usedNonces` check in the core is not atomic. `PolicyModule` enforces it on
chain, so **exactly one could ever settle**, which is what INV5 actually
guarantees — but INV5 is a property of *settlement*, not of core approvals, and
the two were being conflated.

### Class 10 — the UI does not verify signatures

`trace.signature` is set only for APPROVED decisions (`payment.ts:162`), and
there is **zero signature verification in `apps/web/src`**. What the console
does — `console/page.tsx:262-271` — is display the `signatureStatus`, `digest`
and `coreSignerAddress` that the **core itself reports** for the audit export,
so a judge sees the signature status before downloading the file. That is a
useful thing and it is not the same claim. Verifying the core's signature in the
browser, against the on-chain `coreSigner` address, is unbuilt.

---

## Invariants (INV1–INV5)

| ID | Invariant |
|---|---|
| **INV1** | Cumulative outflow in any window ≤ `windowCap`, under every execution ordering |
| **INV2** | No transfer succeeds with a stale `revocationEpoch` |
| **INV3** | No transfer succeeds without both required signatures (A + B) |
| **INV4** | No transfer succeeds to a counterparty failing its tier predicates |
| **INV5** | No nonce is consumed twice |

**How they are actually proved, and when it was last run.** Foundry stateful
invariant fuzzing — `contracts/test/Invariants.t.sol`, one `invariant_` function
per ID plus `invariant_valueConservation`. Measured 4 Aug 2026:

```
INV1 windowNeverExceedsCap          runs 64, calls 4096, reverts 10   PASS
INV2 noStaleEpochTransfer           runs 64, calls 4096, reverts 10   PASS
INV3 noBadSigTransfer               runs 64, calls 4096, reverts 10   PASS
INV4 noBlockedCounterpartyTransfer  runs 64, calls 4096, reverts 10   PASS
INV5 noNonceConsumedTwice           runs 64, calls 4096, reverts 10   PASS
     valueConservation              runs 64, calls 4096, reverts 10   PASS

forge test   48 passed, 0 failed, 0 skipped
```

Separately, the TypeScript evaluator is checked against Solidity
`PolicyModule.validate` over 10 000 differential inputs
(`apps/core/test/differential.test.ts`) — `10000/10000 agree`, same date, with
the core suite at **147/147 and nothing skipped**.

> Reproduce with `bash scripts/dev-up.sh anvil` (two chains: a plain one on
> 8545 for the differential test, a Base Sepolia fork on 8546 for the fork
> tests) then `npx vitest run` in `apps/core` and `forge test` in `contracts/`.
> Without the chains, 7 tests skip and the differential claim is not exercised
> at all.

> **NOT IMPLEMENTED: Halmos symbolic execution.** The previous version claimed
> *"targeted Halmos symbolic execution"*. Halmos is not in this repository —
> not in `foundry.toml`, not in CI, not as a dependency. `LIMITATIONS.md:221`
> has always listed it as a stretch goal, so the two documents contradicted each
> other and this one was the wrong one. Every INV claim above rests on fuzzing
> and differential testing, both of which are real and both of which are
> weaker than a proof. Say "fuzzed", not "proven".

---

## Fail-Closed Analysis

| Failure Scenario | Outcome |
|---|---|
| Core API unreachable | No new leases issued → outstanding leases expire in ≤15 s → spending stops |
| Core DB gone | Same as above |
| DoS on core | Same as above |
| Core private key compromised | Owner revokes on-chain directly from the owner EOA, zero API dependency |
| Agent key share A compromised | Useless alone — needs B's co-signature. Measured: `InvalidCoreSignature` |
| Heartbeat lapses | Dead-man switch fires → `frozen = true` → nothing settles |
| Revocation epoch incremented mid-ceremony | The core re-checks the epoch between signing rounds and aborts (`ceremony.aborted`) |

> *"Our infrastructure failing is indistinguishable from the kill switch firing.
> There is no failure mode where money keeps moving."*

**A caveat on the dead-man switch that belongs in a threat model.**
`checkDeadman()` (`PolicyModule.sol:347`) is `external` with **no access
control** — by design, so the switch does not depend on us. But `frozen = true`
is assigned in exactly one place and **there is no unfreeze function**. Once the
heartbeat lapses, anyone reading the verified source on Basescan can permanently
brick the deployment. Fail-closed here means *closed*.

---

## What We Don't Claim

- We do not claim NPCI/UPI compliance (the UAP spec is unpublished).
- **FROST Schnorr 2-of-3 is NOT implemented, and not behind a feature flag.**
  The previous version of this file, `LIMITATIONS.md:68` and `BUILD.md:185` all
  described it as shipped-behind-a-flag. The only occurrence of "FROST" in the
  entire codebase is a comment at `apps/core/src/api/routes/payment.ts:5`
  describing the *simulated* ceremony rounds that drive the M3 animation. What
  ships is 2-of-2 ECDSA, which works, is verified on chain, and has settled real
  transactions. FROST is a roadmap item.
- The multi-round "ceremony" is a **presentation of the 2-of-2 signature**, not
  a threshold protocol. Its rounds exist so that revocation has something to
  interrupt — which is a real property, since the epoch is re-checked between
  rounds and the abort is observable on the SSE stream.
- Nitro Enclave attestation is on the roadmap; the deployed version uses
  reproducible-build image digest attestation.
- The ₹ ledger is a mock ERC-20 on Base Sepolia — real UPI semantics would
  require NPCI API access.
- **No rate limiting exists anywhere in the core.** `API.md:380` documents a
  `429 RATE_LIMITED` response that nothing can currently return.
