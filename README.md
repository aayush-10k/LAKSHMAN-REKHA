# Lakshman Rekha

Spend enforcement for autonomous AI agents.
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
# Ensure .env is configured (see .env.example)
pnpm dev:web
```
Open `http://localhost:3000/console` to start.

## Demo credentials

For the mock UI:
**Username:** `demo`
**Password:** `123`

## Contracts (Base Sepolia)

- **INRx (Mock INR):** [`0x9df2d451d682971878d09ba13920ca418697272d`](https://sepolia.basescan.org/address/0x9df2d451d682971878d09ba13920ca418697272d)
- **PolicyModule:** [`0x933bb10252ec2b133f28b7d5edf1d303c3384d87`](https://sepolia.basescan.org/address/0x933bb10252ec2b133f28b7d5edf1d303c3384d87)
- **RekhaAccount:** [`0xd65122eafeb2e6f384d0095bac7de6f662276f6c`](https://sepolia.basescan.org/address/0xd65122eafeb2e6f384d0095bac7de6f662276f6c)
