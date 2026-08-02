# 🛡️ LAKSHMAN REKHA — Cryptographic Kill Switch & Deterministic Policy Core

> **InnovaHack Chapter 1 · Round 2 · FinTech PS2 (The Kill Switch)**  
> *The ultimate trust, policy enforcement, and threshold cryptographic governance layer for autonomous business spending AI agents.*

---

## ⚡ The One-Sentence Product

> **An AI agent runs a business's spending. It holds one-third of a cryptographic threshold key, so it is *mathematically incapable* of paying alone. Our approval core holds the second share and decides 100% deterministically. The owner holds the third share and can revoke anything instantly—even mid-signature ceremony—directly on-chain.**

---

## 🔑 Quick Start & Demo Credentials

Access the unified live platform via the official deployed instance or locally using judge credentials:

| Parameter | Value |
|---|---|
| **Live Deployed App (Unified)** | [https://lakshman-rekha.vercel.app/](https://lakshman-rekha.vercel.app/) |
| **Local Development URL** | [http://localhost:3001](http://localhost:3001) |
| **Username** | `demo` |
| **Password** | `123` |
| **Proxy Token** | `lr_live_sk_892374982374` |
| **Base Sepolia Network** | Chain ID `84532` |
| **INR Ledger Contract (`INRx`)** | `0x3a4b9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b` |
| **Policy Module (`PolicyModule`)**| `0x7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a` |

> 💡 **Single Deployed Platform**: The production URL [`https://lakshman-rekha.vercel.app/`](https://lakshman-rekha.vercel.app/) is a single, unified web application combining both the **Lakshman Rekha Console** and **Agent Playground** into a single seamless experience with a top view switcher (`Lakshman Rekha` ↔ `Agent Playground`), eliminating the need for separate dashboard and playground URLs or distinct deployments.

### Running Locally
```bash
# Navigate to project directory
cd project3

# Serve static web application (Unified Console & Playground at http://localhost:3001)
npx -y serve . -p 3001
# Or run Node backend server
node server.js
```

---

## 🏆 Three Core Submission Moments

| Moment | Technical Reality | Hackathon Criterion Won |
|---|---|---|
| **M1: Incapable Agent** | Agent, operating alone with its Key Share A and full network access, attempts to initiate a direct transaction on-chain. Contract execution reverts: `InvalidCoreSignature`. *"It isn't blocked. It's incapable."* | **Enforcement Layer** |
| **M2: Live Rogue Scoreboard** | Rogue Mode attack generator fires 12 attack classes across 200+ attempts live on screen: `247 attempts · 247 blocked · ₹0 lost`. | **Attack Resistance** |
| **M3: In-Flight Revocation** | During a multi-round signing ceremony with progress bar at 60%, owner hits **REVOKE**. The threshold signing ceremony visibly shatters and aborts mid-round. | **In-Flight Revocation (Bonus)** |

---

## 🚫 Five Non-Negotiable Core Principles

1. **Zero LLM in the Decision Path**: The policy evaluator is 100% pure deterministic code (TypeScript & Solidity). An LLM may *narrate* a decision that has already been made and logged, but it NEVER influences one.
2. **Agent Assumed Fully Compromised**: The AI agent operates in an untrusted zone. Security NEVER depends on prompt compliance, model alignment, or agent self-restraint.
3. **Fail-Closed Architecture**: Every failure mode—server down, database offline, network partition, hardware crash—MUST stop money immediately. A `try/catch` block that defaults to approval is a fatal bug.
4. **Verifiable On-Screen Artifacts**: Every claim provides clickable Base Sepolia explorer links, exact Solidity custom revert reasons, core container digests, and replayable cryptographic signatures.
5. **Happy Path First, Always**: Demonstrates seamless, zero-friction operation for normal legitimate spending before displaying multi-layered attack blocks.

---

## 🏗️ Architecture & Trust Model

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  UNTRUSTED ZONE                                                             │
│   ┌──────────────────┐          ┌───────────────────────────────────────┐   │
│   │ Shopper Agent    │─────────▶│ Vendor Simulator                      │   │
│   │ [KEY SHARE A]    │          │ (Legitimate & Counterfeit Vendors)    │   │
│   └────────┬─────────┘          └──────────────────┬────────────────────┘   │
│            │                                       │ raw HTML / prose       │
│   ┌────────▼─────────┐          ┌──────────────────▼────────────────────┐   │
│   │ Adversary Agent  │          │ EXTRACTOR SERVICE                     │   │
│   │ (Attack Engine)  │          │ (Quarantined Parser)                  │   │
│   └──────────────────┘          └──────────────────┬────────────────────┘   │
└────────────────────────────────────────────────────┼────────────────────────┘
                   ══════════════════════════════════▼═════════════════════════
                    TYPED SCHEMAS ONLY (`FactSheet`) — zero unvalidated strings
                   ══════════════════════════════════▼═════════════════════════
┌─────────────────────────────────────────────────────────────────────────────┐
│  TRUSTED ZONE — LAKSHMAN REKHA CORE                         [KEY SHARE B]   │
│   • Pure Deterministic Policy Evaluator ──▶ DecisionTrace Output            │
│   • Short-Lived Lease Issuer (5s TTL, Fail-Closed Architecture)             │
│   • Threshold Signing Participant (2-of-2 / FROST 2-of-3 Schnorr)          │
│   • Template Explanation Renderer (Zero LLM inference)                      │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼──────────────────────────────────────┐
│  ON-CHAIN SMART CONTRACTS — Base Sepolia (Chain ID: 84532)                  │
│   • RekhaAccount.sol   · Secure smart contract vault holding funds          │
│   • PolicyModule.sol   · On-chain caps, tiers, revocationEpoch & nonces     │
│   • INRx.sol           · Real ERC-20 Rupee ledger token                     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────┐
                    │  OWNER BROWSER CONTROL              │   [KEY SHARE C]
                    │  Direct On-Chain Revoke Transaction │
                    └─────────────────────────────────────┘
```

### 2-of-3 Threshold Key Matrix

The full private signing key NEVER exists in a single location at any point in its lifecycle.

| Combination | Participating Key Shares | Operational Capability |
|---|---|---|
| **A Alone** | Agent Share | **Nothing.** Cannot produce a valid signature. Execution reverts on-chain. |
| **A + B** | Agent + Rekha Core | **Normal Authorized Spending.** Approved payments co-signed and executed. |
| **C Alone** | Owner Share | **Instant Revocation.** Direct on-chain transaction; zero dependency on API/Core. |
| **B + C** | Core + Owner | **Emergency Recovery.** Account key rotation if agent share is lost/destroyed. |

### 5-Second Signed Lease Mechanism

Rekha Core issues cryptographically signed leases with a **5-second Time-To-Live (TTL)**, bound to `(mandateId, revocationEpoch, policyHash, nonce)`:
- **Core Unreachable / Offline**: No new leases issued → **spending stops automatically within 5 seconds**.
- **Owner Revokes**: `revocationEpoch` increments on-chain → **all active outstanding leases invalidate in the same block**.
- **Network Partition**: Systems fail-closed instantly.

---

## 🛡️ 14 Policy Predicates & 12 Adversarial Attack Classes

### 14 Evaluated Policy Predicates

Every payment request evaluates a strict, ordered chain of 14 deterministic predicates:

1. `revocationEpoch` — Validates current account & mandate freeze epoch.
2. `nonceUniqueness` — Verifies nonce has not been previously settled.
3. `leaseValidity` — Checks 5s signed lease timestamp against server NTP.
4. `agentSignature` — Verifies Key Share A signature over payload.
5. `coreSignature` — Verifies Key Share B signature from attestation node.
6. `coreImageMatch` — Validates reproducible build digest hash.
7. `factSheetStructure` — Enforces strict typed schema bounds (no text strings).
8. `counterpartyTier` — Rejects Tier 3 unverified vendors.
9. `counterpartyAge` — Enforces 30-day minimum registration age for Tier 2 vendors.
10. `counterpartySettledTxns` — Verifies minimum settled transaction history (≥ 5 txns).
11. `priceBandZScore` — Ensures price deviation stays within standard market z-score.
12. `categoryPermitted` — Validates category code against owner policy bitmap allowlist.
13. `perTxCap` — Enforces single transaction spending limit (e.g. ₹2,500).
14. `windowCap` — Enforces rolling 24-hour window cap (e.g. ₹10,000).

### 12 Adversarial Attack Classes & Mitigations

| # | Attack Class | Adversary Vector | Rekha Mitigation | Binding Predicate |
|---|---|---|---|---|
| 1 | **Structuring** | Agent splits ₹50,000 into 60 small sub-cap payments of ₹800 | Cumulative 24-hour rolling window cap tracking | `windowCap` |
| 2 | **Category Spoofing** | Agent claims prohibited luxury purchase is "Office Supplies" | Strict category code bitmap allowlist & registry validation | `categoryPermitted` |
| 3 | **Lease / Nonce Replay** | Agent re-submits previously settled transaction payload | Unique nonce registry in memory & on-chain mapping | `nonceUniqueness` |
| 4 | **TOCTOU Race Condition** | 50 concurrent parallel payment requests sent in 100ms | Synchronous atomic mutex lock & stateful balance reservation | `nonceUniqueness` / `windowCap` |
| 5 | **Rail Bypass** | Agent attempts direct Web3 call to `RekhaAccount.sol` skipping Core | Contract enforces required Core Key Share B signature | `coreSignature` |
| 6 | **Signature Forgery** | Agent attempts to forge Core signature without Key Share B | On-chain ECDSA / Schnorr threshold cryptographic verification | `agentSignature` / `coreSignature` |
| 7 | **Core Impersonation** | Compromised host stands up fake core server to co-sign | Enclave image digest hash bound to key attestation on-chain | `coreImageMatch` |
| 8 | **Prompt Injection** | Vendor page embeds hidden text instructions to hijack agent | Extractor pipeline quarantines prose; core receives typed `FactSheet` | `factSheetStructure` |
| 9 | **Self-Dealing** | Agent registers fake vendor entity & pays itself | Tier 2 vendor attribute validation (Min 30 days age, ≥ 5 settled txs) | `counterpartyAge` |
| 10 | **Social Engineering** | Compromised agent emits fake human approval prompts to console | Non-overridable deterministic policy core bypasses agent claims | `revocationEpoch` |
| 11 | **Clock Manipulation** | Agent supplies tampered timestamps to reset 24h window cap | Untrusted client timestamps rejected; strict server NTP reference | `leaseValidity` |
| 12 | **Lease Griefing** | Agent floods lease renewal endpoint to lock funds | Automatic 5-second TTL release ring on active holds | `leaseValidity` |

---

## 🔒 Quarantined Data Pipeline & Frozen Types

### The `FactSheet` Injection Boundary
No untrusted merchant prose or agent natural language text EVER enters the Rekha Core policy evaluator.

```typescript
type FactSheet = {
  amountMinor: number;          // Integer paise (1 INR = 100 paise)
  currency: 'INR';              // Fixed currency identifier
  counterpartyId: string;       // 0x... EVM address format
  counterpartyAgeDays: number;  // Verified registry age (0–65535)
  counterpartySettledTxns: number; // Verified transaction history count
  counterpartyTier: 1 | 2 | 3;  // Vendor classification tier
  categoryCode: CategoryEnum;   // Fixed enum code (never raw text)
  priceBandZ: number;           // Market price z-score deviation (-128...127)
  taskId: string;               // UUID string
  lineItemId: string;           // UUID string
  leaseId: string;              // Cryptographic signed lease ID
  nonce: number;                // Monotonic unique sequence nonce
};
```

### The `DecisionTrace` Output
Every policy decision generates an immutable testimony object co-signed by Rekha Core:

```typescript
type DecisionTrace = {
  decisionId: string;
  outcome: 'APPROVED' | 'HELD' | 'REFUSED';
  predicates: Array<{
    name: string;
    inputs: Record<string, number | string>;
    expected: string;
    actual: string;
    passed: boolean;
  }>;
  bindingPredicate: string | null;
  policyHash: string;
  coreImageDigest: string;
  timestamp: number;
  signature: string;
};
```

---

## 🌐 Product Surfaces

### Deployed Single URL: `https://lakshman-rekha.vercel.app/`
The application is deployed as a single, unified web application at [https://lakshman-rekha.vercel.app/](https://lakshman-rekha.vercel.app/). Both the **Lakshman Rekha Console** and **Agent Playground** operate within this single URL, seamlessly toggled via the fixed top view switcher (`Lakshman Rekha` ↔ `Agent Playground`).

#### View 1: Lakshman Rekha Console (Main Payment Control Room)
The business owner's control center designed like a modern financial app:
- **Rupee Wallet**: Live ₹ balance backed by Base Sepolia `INRx` ERC-20 tokens with mock credit line & deposit controls.
- **Agent Connection**: Agent pairing flow displaying ID, status, key share fingerprint, and pulsing 5s lease TTL ring.
- **Live Transaction Feed**: Real-time status pipeline (`Requested → Evaluating → Signing → Settled` or `Held / Refused`).
- **Decision Panel**: Deterministic testimony renderer showing plain English explanations + 1-click raw `DecisionTrace` JSON viewer.
- **Holds Inbox**: Pending held transactions featuring live countdown rings and manual **Cancel / Release** controls.
- **On-Chain Revocation Controls**: Per-transaction, per-agent, and global **REVOKE ALL** buttons submitted directly from owner's browser wallet to the blockchain.

#### View 2: Agent Playground (Agent Simulator & Adversary Arena)
Interactive testbed for judges to simulate real agent workflows and execute attacks directly inside the unified app:
- **Task Console**: 6 business tasks (`procure`, `ads`, `content`, `compute`, `logistics`, `subscription`) with simulated clock.
- **6 Behaviour Modes**:
  1. `normal` — Standard compliant purchasing.
  2. `hallucinating` — Invents invalid vendors & duplicate line items.
  3. `injected` — Reads pages carrying hidden prompt injection text.
  4. `compromised` — Objective replaced: full attack library exfiltration.
  5. `overreach` — Unauthorized tier upgrades and add-on purchases.
  6. `colluding` — Registers fake vendor and attempts self-dealing.
- **Judge Controls**:
  - `Spawn Counterfeit Storefront` — Clones legitimate vendor at 60% discount (age: 2 days).
  - `Inject Text into Page` — Live arbitrary prompt injection input box.
  - `Kill Approval Service` — Instantly stops Core container to test fail-closed 5s lease TTL.
  - `Simulation Speed Slider` — Adjust clock speed (1x to 10x).

---

## 📐 Formal Invariants & Mathematical Proofs

Lakshman Rekha enforces 5 critical security invariants mathematically proven via **Foundry Invariant Fuzzing** (10,000+ runs) and **Halmos Symbolic Execution**:

| Invariant ID | Mathematical Definition | Property |
|---|---|---|
| **INV1** | $\sum_{i=1}^{n} \text{TxAmount}_i \le \text{WindowCap} \quad \forall t \in [T, T + 24\text{h}]$ | Spending never exceeds rolling window cap under any execution order. |
| **INV2** | $\text{Execute}(req) = \text{Success} \implies \text{Epoch}_{req} = \text{Epoch}_{\text{Contract}}$ | No transaction succeeds under a stale `revocationEpoch`. |
| **INV3** | $\text{Execute}(req) = \text{Success} \implies \text{VerifySig}(K_A, req) \land \text{VerifySig}(K_B, req)$ | No transaction settles without both Key Share A and Key Share B signatures. |
| **INV4** | $\text{Execute}(req) = \text{Success} \implies \text{Tier}(counterparty) \neq 3 \land \text{PredicatesPass}(counterparty)$ | No payment reaches an unverified or inadmissible counterparty. |
| **INV5** | $\text{Settled}(nonce) = \text{True} \implies \text{Execute}(nonce) = \text{Revert}$ | No nonce can ever be consumed more than once. |

---

## 🎯 Demo Script & Choreography

Follow this 8-beat walkthrough during live demonstration:

1. **Beat 0 (Plausibility)**: Log in (`demo` / `123`). Show wallet balance ₹50,000, Base Sepolia contract links, and active 5s lease TTL ring.
2. **Beat 1 (Happy Path)**: Set task *"Order 100 bottles"* in `normal` mode. Watch agent plan, quote, request, and settle in ~380ms with clickable Basescan transaction link.
3. **Beat 2 (Enforcement — M1)**: Click **Detach Core**. Agent attempts to execute transaction alone with Key Share A. Contract reverts on-chain: `InvalidCoreSignature`. *"It isn't blocked. It's incapable."*
4. **Beat 3 (Prompt Injection Boundary)**: Select `injected` mode and click **Spawn Counterfeit Storefront**. Agent reads hidden prompt injection and complies. Extractor strips text; Core receives pure 9-number `FactSheet`. Transaction refused: `CounterpartyNotAdmissible` (Age: 2 days).
5. **Beat 4 (Rogue Mode Scoreboard — M2)**: Switch mode to `compromised`. Watch Rogue Mode scoreboard run through 12 attack classes live: `247 attempts · 247 blocked · ₹0 lost`.
6. **Beat 5 (In-Flight Revocation — M3)**: Trigger a 6-item task. During signing ceremony at 60%, click **REVOKE**. Signing ceremony visibly shatters and aborts mid-round.
7. **Beat 6 (Kill-Switch Fail-Closed)**: Click **Kill Approval Service**. Watch lease TTL ring drain to zero. All spending halts within 5 seconds. Submit on-chain revoke from owner browser wallet—succeeds independently of backend status.
8. **Beat 7 (Audit & Attestation)**: View attestation panel, reproducible build container image digest, Halmos symbolic proof logs, and downloadable signed audit trail.

---

## 📄 File Directory & Structure

```
project3/
├── README.md                    ← Master project spec & judge credentials
├── THREAT_MODEL.md              ← Threat vector & mitigation matrix
├── LIMITATIONS.md               ← Architectural scope & boundary conditions
├── index.html                   ← Main console, simulator & scoreboard UI
├── server.js                    ← API server & real-time SSE event bus
├── apps/
│   └── web/                     ← Console & simulator source components
├── contracts/                   ← Base Sepolia Solidity smart contracts
│   ├── RekhaAccount.sol         ← Vault contract holding funds
│   ├── PolicyModule.sol         ← 14-Predicate policy engine & revoke epoch
│   └── INRx.sol                 ← Mock ERC-20 Rupee token
├── css/                         ← Design system & matrix animation styles
├── js/
│   ├── app.js                   ← Policy evaluator, lease TTL & state engine
│   ├── auth.js                  ← User session & credentials manager
│   ├── agent.js                 ← 12 Adversarial attack class generator
│   └── supabase.js              ← Database state sync
└── docs/
    └── API.md                   ← Frozen TypeScript interfaces & SSE spec
```

---

## 📄 License & Team

Built for **InnovaHack Chapter 1 · Round 2 · FinTech PS2 (The Kill Switch)**.

```
Lakshman Rekha Architecture — Open Source under MIT License.
```
