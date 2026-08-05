# Lakshman Rekha

**An AI agent holding money it cannot move alone.** It holds one of the two
signatures a payment needs. It can be lied to, prompt-injected, or fully taken
over, and it still cannot move a rupee — the second signature is not a rule it
is asked to follow, it is a key it does not have. Ask the chain yourself:

```
POST /rail-bypass  ->  reverted · InvalidCoreSignature · predicate coreSignature
```

The enforcement core, the agent and the vendor registry run locally; a deployed
URL serves the frontend, and it says so rather than pretending to be connected.
Run the commands under "Run locally" to watch a payment settle. **The contracts
and the settled transactions below are verifiable on Base Sepolia without
running anything at all**, which is the only part of this that does not require
trusting our server.

InnovaHack Chapter 1 · Round 2 · FinTech PS2

## Docs

- `BUILD.md` — the full build plan
- `THREAT_MODEL.md` — trust boundary, the 12 attack classes, and four claims
  marked NOT IMPLEMENTED rather than deleted
- `LIMITATIONS.md` — what is simulated, and what the numbers do not prove
- `docs/journal/HONESTY_PLAN.md` — every claim audited against what ships, with the
  retractions
- `docs/journal/FINALE_PROGRESS.md` — current state: what is done, what is next, what is
  blocked. **Start here if you are picking this up**
- `docs/API.md` — frozen interfaces
- `SETUP.md` — first-time setup

## Run locally

```bash
pnpm install
cp .env.example .env    # fill in the two signer keys
pnpm dev:vendorsim      # :4100  vendor registry
pnpm dev:core           # :4000  enforcement core + SSE
pnpm dev:agent          # :4200  agent runner — holds the OTHER key share
pnpm dev:web            # :3000  the three routes below
```

`pnpm dev:adversary` (:4300) additionally enables Rogue Mode.

If `pnpm` misbehaves — the wrapper is broken on at least one machine here —
`scripts/dev-up.sh start` launches all four services directly and prints which
ports came up. `scripts/dev-up.sh restart core` restarts one.

### The three routes

| Route | What it is |
|---|---|
| `/` | One screen. The thesis, the three contract links, the settled transactions, and what this is **not**. Server-rendered with no data fetching at all, so it works whether or not anything else is running |
| `/console` | The owner's side. Live balance, one row per payment with the predicate that bound it, and a REVOKE ALL that goes straight to the contract from your own wallet |
| `/playground` | The attacker's side. Corrupt the agent six ways, inject a storefront, spawn a counterfeit vendor, revoke a payment mid-signature |

There is no login: the credentials that used to be documented here belonged to a
browser-side prototype that has been deleted (see `LIMITATIONS.md`).

### Six ways to corrupt the agent

Every mode runs the **same binary** — `apps/core/src/agent/modes.ts` changes only
what the agent buys and what it declares about the counterparty, and it cannot
reach the evaluator, the lease or the chain. Measured, not asserted:

| Mode | What it does | What refuses it |
|---|---|---|
| Normal | Plans from the registry, reads the page price | — settles |
| Hallucinating | Quantities orders of magnitude too large, same item twice | `perTxCap` |
| Injected | Does whatever the storefront tells it to. Undefended on purpose | `counterpartyTier` |
| Overreach | Buys what you asked for, then adds something out of scope | `categoryPermitted` |
| Colluding | Pays an address it controls, calls it a 10-year-old tier 1 | `counterpartyTier` |
| Compromised | Runs the deterministic attack classes against this core, live | (the scoreboard) |

`scripts/verify-modes.sh` runs all of them against a live stack and prints the
outcome and binding predicate for each. `scripts/capture-thoughts.sh <mode>`
prints the agent's own narration off the SSE stream.

### Tests

```bash
bash scripts/dev-up.sh anvil        # two chains the suite needs — see below
cd apps/core   && npx vitest run    # 149 passed, 0 skipped
cd contracts   && forge test        # 57 passed, incl. all five invariants
cd apps/agents/task-engine && node --test          # 9 pass
cd apps/agents/adversary   && python3 test_library.py   # 7 pass
```

> **`forge` and `anvil` live in `~/.foundry/bin`, which is not on `PATH` in a
> non-interactive shell.** `command -v forge` finding nothing is not proof they
> are missing — believing that kept the five invariants and the 10,000-input
> differential test unrun on this machine for weeks. `bash scripts/dev-up.sh
> anvil` uses the absolute path and starts both chains: a plain one on 8545 for
> the differential test, and a Base Sepolia fork on 8546 for the fork tests.
> Without them 7 tests skip.

## Things a judge can verify without running anything

**Contracts — deployed and source-verified on Base Sepolia:**

- **INRx (Mock INR):** [`0x9df2d451d682971878d09ba13920ca418697272d`](https://sepolia.basescan.org/address/0x9df2d451d682971878d09ba13920ca418697272d)
- **PolicyModule:** [`0x933bb10252ec2b133f28b7d5edf1d303c3384d87`](https://sepolia.basescan.org/address/0x933bb10252ec2b133f28b7d5edf1d303c3384d87)
- **RekhaAccount:** [`0xd65122eafeb2e6f384d0095bac7de6f662276f6c`](https://sepolia.basescan.org/address/0xd65122eafeb2e6f384d0095bac7de6f662276f6c)

**Payments this system actually settled** (driven from the browser, re-read
afterwards through an independent client — see `docs/journal/FIXLOG2.md`):

- [`0x35025de9…f12c7e90`](https://sepolia.basescan.org/tx/0x35025de91d5f92d76165358ebab92bf94dc8b05ab7bfd9971eb3b061f12c7e90) — block 44959341, ₹5,760.00
- [`0x1ed0242a…f64a4df96`](https://sepolia.basescan.org/tx/0x1ed0242aee4b863ca20b09999d2d4cd2d6d3b24ac8cceea949c0cd3f64a4df96) — block 44959201, ₹9,520.00

`node apps/core/scripts/verify-tx.mjs <txHash>` re-reads any of them.

## Policy the demo runs under

Read live from PolicyModule at boot, not hardcoded. Four things worth knowing
before you hit them, because each is the policy working rather than a bug:

- **Per transaction:** ₹25,000 (₹5,000 for tier-2 counterparties)
- **Rolling 24h window:** ₹1,00,000 — a long demo session will eventually
  `REFUSE` on `windowCap`
- **Fail-closed window:** kill the core and spending stops within
  **`LEASE_TTL_MS`, currently 15s** — no new lease, no new payment
- **Revoking is one-way from the UI.** `PolicyModule.revoke()` from the owner's
  wallet has no undo anywhere, and the contract has no unfreeze function. The
  core's off-chain revoke can be cleared — `POST /v1/admin/unrevoke`, exposed on
  `/playground` only after a revoke has fired — and it **refuses when the freeze
  is on chain**, because that one is not ours to lift

## What we will not claim

`LIMITATIONS.md` and `THREAT_MODEL.md` are the long version and neither is
decorative — several claims in earlier drafts described software that does not
exist, and they are marked **NOT IMPLEMENTED** in place rather than deleted. The
short version:

- Signing is **2-of-2 ECDSA plus an owner key that can act alone**. Not a
  threshold scheme. There is no FROST implementation behind a flag
- The invariants are **fuzzed and differentially checked** — five Foundry
  stateful invariants at 64 runs × 4096 calls each, and 10,000/10,000 agreement
  between the TypeScript evaluator and Solidity `validate`. Both re-measured
  4 Aug 2026: `forge test` 57/57, core suite 149/149 with nothing skipped.
  **Fuzzed, not proven.** There are no Halmos proofs
- The core **will co-sign past its own window cap**, because its accounting
  advances on settlement. `PolicyModule` reverts `WindowCapExceeded` on chain
  against the authoritative counter, so money cannot move — but the chain is
  what stops it, not us
- The registered core image digest is a **placeholder that attests nothing**.
  `apps/core/scripts/core-image-digest.mjs` produces the real one; registering
  it takes the payment path down for the length of the change
- The ₹ ledger is a mock ERC-20 on a testnet and the vendors are simulated
