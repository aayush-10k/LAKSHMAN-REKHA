# Lakshman Rekha

**Spend enforcement for autonomous AI agents. The enforcement core, the agent and
the vendor registry run locally — a deployed URL serves the console only, and it
will tell you so instead of pretending to be connected. Run the four commands
under "Run locally" to see a payment settle; the contracts and the settled
transactions below are verifiable on Base Sepolia without running anything.**

InnovaHack Chapter 1 · Round 2 · FinTech PS2

## Docs

- `BUILD.md` — the full build plan
- `THREAT_MODEL.md` — trust boundary and 12 attack classes
- `LIMITATIONS.md` — honest disclosure of what is simulated
- `docs/API.md` — frozen interfaces
- `SETUP.md` — first-time setup

## Run locally

```bash
pnpm install
cp .env.example .env    # fill in the two signer keys
pnpm dev:vendorsim      # :4100  vendor registry
pnpm dev:core           # :4000  enforcement core + SSE
pnpm dev:agent          # :4200  agent runner — holds the OTHER key share
pnpm dev:web            # :3000  console + playground
```

Open `http://localhost:3000/console`, then `/playground` to dispatch a task.
There is no login: the credentials that used to be documented here belonged to a
browser-side prototype that has been deleted (see `LIMITATIONS.md`).

`pnpm dev:adversary` (:4300) additionally enables Rogue Mode.

## Things a judge can verify without running anything

**Contracts — deployed and source-verified on Base Sepolia:**

- **INRx (Mock INR):** [`0x9df2d451d682971878d09ba13920ca418697272d`](https://sepolia.basescan.org/address/0x9df2d451d682971878d09ba13920ca418697272d)
- **PolicyModule:** [`0x933bb10252ec2b133f28b7d5edf1d303c3384d87`](https://sepolia.basescan.org/address/0x933bb10252ec2b133f28b7d5edf1d303c3384d87)
- **RekhaAccount:** [`0xd65122eafeb2e6f384d0095bac7de6f662276f6c`](https://sepolia.basescan.org/address/0xd65122eafeb2e6f384d0095bac7de6f662276f6c)

**Payments this system actually settled** (driven from the browser, re-read
afterwards through an independent client — see `FIXLOG2.md`):

- [`0x35025de9…f12c7e90`](https://sepolia.basescan.org/tx/0x35025de91d5f92d76165358ebab92bf94dc8b05ab7bfd9971eb3b061f12c7e90) — block 44959341, ₹5,760.00
- [`0x1ed0242a…f64a4df96`](https://sepolia.basescan.org/tx/0x1ed0242aee4b863ca20b09999d2d4cd2d6d3b24ac8cceea949c0cd3f64a4df96) — block 44959201, ₹9,520.00

`node apps/core/scripts/verify-tx.mjs <txHash>` re-reads any of them.

## Policy the demo runs under

Read live from PolicyModule at boot, not hardcoded. Two limits worth knowing
before you hit them, because both are the policy working rather than a bug:

- **Per transaction:** ₹25,000 (₹5,000 for tier-2 counterparties)
- **Rolling 24h window:** ₹1,00,000 — a long demo session will eventually
  `REFUSE` on `windowCap`
- **Fail-closed window:** kill the core and spending stops within
  **`LEASE_TTL_MS`, currently 15s** — no new lease, no new payment
