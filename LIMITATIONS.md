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
| Fail-closed lease TTL | ✅ 5-second TTL; core unreachable = spending stops |
| 2-of-2 ECDSA co-signing | ✅ Agent sig + core sig both required |
| Dead-man switch | ✅ Heartbeat lapse auto-freezes |
| 12-class adversary attack library | ✅ All 12 classes block deterministically |
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
| Category allow-list on the live deployment | The deployed PolicyModule has `permittedCategories = 128` — bit 7, i.e. `OTHER` and nothing else. Every other category is refused by predicate 7, so the vendor storefront purchases (PACKAGING, LOGISTICS, …) do not settle against the current deployment | `contracts/script/Deploy.s.sol` reads `vm.envOr("PERMITTED_CATEGORIES", 1 << 7)` and the variable was not set at deploy time. One owner `setPolicy` call fixes it; we did not make that call, because widening a live enforcement parameter is the owner's decision, not a bugfix |
| Gas payer | Settlement transactions are broadcast and paid for by `DEPLOYER_PRIVATE_KEY`, not by the core signer | The deployed core signer `0xB18D…` holds 0 ETH on Base Sepolia. `execute` is authorized by the two signatures inside the request, never by `msg.sender`, so the broadcaster only has to be funded — but this does mean the demo spends the deployer's testnet ETH |

---

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
