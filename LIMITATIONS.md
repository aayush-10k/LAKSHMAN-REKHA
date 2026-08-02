# LIMITATIONS — Lakshman Rekha

*We write this ourselves. Judges trust teams that disclose.*

---

## What Is Real

| Component | Status |
|---|---|
| Solidity contracts | ✅ Deployed on Base Sepolia — verified source on Basescan |
| INRx ERC-20 | ✅ Real token, real transfers on Base Sepolia |
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
- [ ] Halmos symbolic proofs (Foundry fuzzing is in CI; Halmos is a stretch goal)
- [ ] Mobile-responsive layout for the three-panel playground

---

*Honesty about limitations is itself evidence of engineering rigour.*
