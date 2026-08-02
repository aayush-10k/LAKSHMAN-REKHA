# THREAT MODEL — Lakshman Rekha

*InnovaHack Chapter 1 · Round 2 · FinTech PS2*

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
│   Lease Issuer (5s TTL, fail-closed)                     │
│   2-of-2 Co-Signer (A's sig + B's sig required)         │
│   Explanation Renderer (templates, no LLM)               │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│  ON-CHAIN — Base Sepolia                                  │
│   PolicyModule   · caps, tiers, revocationEpoch, nonces  │
│   RekhaAccount   · holds INRx, dual-sig required         │
│   INRx (ERC-20)  · the ₹ ledger                         │
└──────────────────────────────────────────────────────────┘
               ┌──────────────────┐
               │  OWNER BROWSER   │  [KEY SHARE C]
               │  revoke → chain  │  (bypasses all our services)
               └──────────────────┘
```

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

---

## The 12 Attack Classes (B7)

| # | Technique | Defence | Predicate |
|---|---|---|---|
| 1 | **Structuring** — split ₹50k into 60 × ₹800 | Per-tx cap blocks each split; window cap blocks cumulative | `perTxCap`, `windowCap` |
| 2 | **Category Spoofing** — claim blocked purchase is permitted | `categoryCode` is a fixed enum from the Extractor's lookup table, never free text | `categoryPermitted` |
| 3 | **Lease Replay** — reuse a settled lease/nonce | Nonce registry on-chain; replay → `NonceAlreadyUsed` revert | `nonce` |
| 4 | **TOCTOU Race** — 50 concurrent payments same window | On-chain nonce registry serialises; only one settles | `nonce` (on-chain) |
| 5 | **Rail Bypass** — call `RekhaAccount.execute()` directly | Contract calls `validate()` first; no co-signer = `InvalidCoreSignature` | `agentSignature`, `coreSignature` |
| 6 | **Signature Forgery** — craft a signature without key B | ECDSA verification in `PolicyModule`; forge fails | `coreSignature` |
| 7 | **Core Impersonation** — stand up a fake core | Only the address holding key B can produce valid core sig | `coreSignature` |
| 8 | **Prompt Injection** — embed instructions in vendor pages | Extractor converts to typed schema; prose never reaches evaluator | `categoryPermitted` (+ schema boundary) |
| 9 | **Self-Dealing** — vendor the agent controls | Counterparty attributes come from registry, not the page; age/settled checks | `counterpartyAge`, `counterpartySettled` |
| 10 | **Owner Social Engineering** — spoofed approval prompts | Core signs every `DecisionTrace`; UI only renders signed traces | (signed trace) |
| 11 | **Clock Manipulation** — false timestamps | Core uses its own clock; `leaseExpiry` is set at issuance | `leaseExpiry` |
| 12 | **Lease Renewal Griefing** — flood renewal endpoint | Rate-limiting on `/v1/lease/renew`; DoS → no leases → spending stops (fail-closed) | fail-closed |

---

## Invariants (INV1–INV5)

| ID | Invariant |
|---|---|
| **INV1** | Cumulative outflow in any window ≤ `windowCap`, under every execution ordering |
| **INV2** | No transfer succeeds with a stale `revocationEpoch` |
| **INV3** | No transfer succeeds without both required signatures (A + B) |
| **INV4** | No transfer succeeds to a counterparty failing its tier predicates |
| **INV5** | No nonce is consumed twice |

Each is proved by Foundry invariant fuzzing (`forge test --invariant`) and targeted Halmos symbolic execution.

---

## Fail-Closed Analysis

| Failure Scenario | Outcome |
|---|---|
| Core API unreachable | No new leases issued → all outstanding leases expire in ≤5s → spending stops |
| Core DB gone | Same as above |
| DoS on core | Same as above |
| Core private key compromised | Owner revokes on-chain directly (key C only, zero API dependency) |
| Agent key share A compromised | Useless alone — needs B's co-signature |
| Heartbeat lapses | Dead-man switch fires → `revocationEpoch` incremented → all leases invalidated |
| Revocation epoch incremented mid-ceremony | Core re-checks epoch at every FROST round; signing aborts between rounds |

> *"Our infrastructure failing is indistinguishable from the kill switch firing. There is no failure mode where money keeps moving."*

---

## What We Don't Claim

- We do not claim NPCI/UPI compliance (the UAP spec is unpublished).
- The FROST Schnorr 2-of-3 upgrade is implemented behind a feature flag; the 2-of-2 ECDSA path ships as the default.
- Nitro Enclave attestation is on the roadmap; the deployed version uses reproducible-build image digest attestation.
- The ₹ ledger is a mock ERC-20 on Base Sepolia — real UPI semantics would require NPCI API access.
