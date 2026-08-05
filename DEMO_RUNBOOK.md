# Demo runbook — 8 Aug 2026

Everything below was executed against the **containerised stack** on 5 Aug 2026
and the output pasted is real. Where something is untested, it says so.

The three moments are `FINALE.md:34`: **M1** agent alone, **M2** Rogue Mode
scoreboard, **M3** ceremony bar broken by REVOKE.

---

## T-30 — bring it up

```bash
cd ~/projects/lakshman-rekha
docker compose up -d
docker compose ps
```

Wait for all three `(healthy)`. Expect exactly this:

```
NAME              STATUS                    PORTS
rekha-agent       Up (healthy)              0.0.0.0:4200->4200/tcp
rekha-core        Up (healthy)              0.0.0.0:4000->4000/tcp
rekha-vendorsim   Up (healthy)              0.0.0.0:4100->4100/tcp
```

Then the frontend, which is **not** in the stack:

```bash
pnpm dev:web        # or: cd apps/web && npx next dev
```

### The one line that tells you the chain is live

```bash
docker logs rekha-core 2>&1 | grep '^\[policy\]'
```

```
[policy] seeded from PolicyModule: perTxCap=2500000 windowCap=10000000 categories=223 epoch=0 ...
```

**If it says `could not read PolicyModule` instead, stop and fix it.** Decisions
will disagree with the chain. Two causes, and the message names neither —
see DEPLOY.md §2.

### Check the WSL MTU first — it resets itself

```bash
ip link show eth0 | grep -o 'mtu [0-9]*'      # want: mtu 1300
```

**If it says 1500, fix it before anything else:**

```bash
sudo ip link set dev eth0 mtu 1300            # or: wsl -d Ubuntu -u root -- ip link set dev eth0 mtu 1300
```

This happened mid-session on 5 Aug. WSL re-initialised its adapter and put eth0
back to 1500, and everything from the WSL host stopped reaching the internet —
`git push`, `curl https://github.com`, all of it hanging to timeout with
`Connection reset by peer` or a `000` status. **DNS keeps working**, which sends
you looking in the wrong place.

The containers were unaffected, because compose pins them to 1300 — which is the
clearest evidence that 1300 is the correct value for this machine and 1500 is
not. It also means the demo itself would probably survive: the browser talks to
the containers directly. What breaks is anything you run on the host.

### Sixty-second pre-flight

```bash
curl -s localhost:4000/health                       # {"ok":true,...,"coreKey":true,...}
curl -s localhost:4100/catalog | head -c 60         # [{"id":"ven_meridian",...
curl -s localhost:4200/health                       # {"ok":true,...,"core":"http://core:4000",...
```

`coreKey:true` matters — `false` means the core cannot sign and every payment
dies at the ceremony. `issuanceKilledAtMs` must be `null`; if it is a number
someone left the kill switch on, so `POST /v1/admin/revive`.

**Check the spend window before you start.** The demo spends real testnet money
and the window is ₹1,00,000 per 24h:

```bash
curl -s localhost:4000/v1/agent/pairing-code
curl -s localhost:4000/v1/mandate/<mandateId> | python3 -m json.tool | grep -i window
```

A normal-mode dispatch costs ₹282. M1 and M2 cost nothing on-chain.

---

## M1 — agent alone

**Where:** `/playground`, right column, **AGENT ALONE**.
**Click:** `Pay itself, without the core`.
**Costs nothing** — it is an `eth_call`, nothing is broadcast.

Verified output:

```
agent 0x6E19cA…00d5   tried to take   ₹25,000
InvalidCoreSignature      bound on coreSignature
"It isn't blocked. It's incapable."
eth_call against the deployed contract — no transaction was broadcast
```

**What to say:** the agent holds a real key share and full network access. It
does not need the core to reach Base Sepolia. It signs a genuine secp256k1
signature over the correct digest — it just isn't `coreSigner`, so the deployed
bytecode refuses. That revert name came back from Base Sepolia, not from us.

**If asked "is the agent just sandboxed?"** — no, and deliberately not. The agent
container has full internet egress precisely so this cannot be explained by
network policy. See the note at the top of `docker-compose.yml`.

---

## M2 — Rogue Mode

**Where:** `/playground`. Pick **Compromised**, then Dispatch.
**Takes ~2-4 minutes.** Do not click twice.

Verified, containerised:

```
total 99   blocked 85   through 14   errored 0
byStage: input 26, policy 57, chain 2, unattributed 0
```

**`errored` must be 0.** If it is 2 and they are classes 5 and 7, the agent
cannot reach the chain — check `AGENT_URL` on the core and that the agent is on
`rekha-external`.

**The 14 `through` are not a failure, and do not hide them.** Twelve are one
structuring run — ₹12,430 × 12, paced two RPC round-trips apart, so the leases
lapse between slices. Those approvals are **void**: settlement requires a live
lease (predicate 5, enforced on chain), so none of them can settle. The
scoreboard still reads `₹0 lost`. The version that fits inside a single lease is
refused — `scripts/verify-window-race.py` fires 8 in parallel and gets 5 approved
/ 3 refused on `windowCap`, exact to the paisa.

The other two are a lease replay and one TOCTOU thread out of 50; the other 49
are refused on `nonce`.

**Say this before they ask.** A scoreboard reading 99/99 blocked would be the
suspicious one.

---

## M3 — ceremony broken by REVOKE

**Where:** `/playground`. The ceremony bar and REVOKE sit side by side so this is
one gesture (`FINALE.md:209`).

1. Dispatch anything in **Normal** mode (₹282).
2. The signing ceremony bar starts — three segments, ~1200ms each.
3. Hit **REVOKE** at roughly 60%.
4. The bar **breaks** and the Rekha line snaps.

Measured animation, for reference if it looks wrong:

```
snap   +1173ms  stroke rgb(255,77,77)  dash 0, 20.6, 1000   anim rekha-snap
       +1425ms  dash 0, 90.0, 1000 (fully open)
flare  stroke rgb(255,77,77)  dash 120px, 880px            anim rekha-flare
```

**Reset between rehearsals:** the playground has a reset control
(`pg-btn-reset`). The console's **REVOKE ALL** is the stronger one — it goes to
the contract from the owner's wallet and **has no undo**. Do not press it while
rehearsing.

---

## If something breaks on stage

| Symptom | Cause | Fix |
|---|---|---|
| Dispatch returns empty plan, "vendor registry could not be read" | `VENDORSIM_URL` unset **on the core** | it is in compose; if you edited it, restore |
| Dispatch 503 `CORE_UNAVAILABLE`, "could not broadcast" | broadcaster key missing or out of gas | `DEPLOYER_PRIVATE_KEY` must be set. `0xA5142D…DabFD2` held 0.0300 ETH on 4 Aug |
| `gas required exceeds allowance (0)` | fell back to the core signer, which holds 0 ETH | same as above |
| Payment refused on `windowCap` | the ₹1,00,000 / 24h window is spent | genuine. Say so — it is the policy working. Do not raise the cap live |
| Refused on `categoryPermitted` for software | `SOFTWARE` is the one category the deployed policy forbids | deliberate, it is the live `CategoryNotPermitted` case |
| SSE stops, UI freezes mid-demo | the stream was proxied through a serverless function | never proxy `/v1/events`; the browser must hit the core directly |
| Everything 000 from the browser | containers on an internal-only network publish no ports | `docker compose ps` — if PORTS shows a bare `4000/tcp`, recreate |
| Chain reads time out but TCP connects | MTU mismatch (WSL NIC 1300, bridge 1500) | already set per-network; override `DOCKER_MTU` |

**Full restart, ~40s:**

```bash
docker compose down && docker compose up -d --force-recreate
```

Use `--force-recreate`. A container left over from a failed `up` can be attached
to only some of its networks, with no default route, and starting it again does
not fix that.

---

## Disclose these before you are asked

Being first to say them is worth more than being right about them.

- **2-of-2 ECDSA, not a 2-of-3 threshold.** No FROST. The multi-round ceremony is
  a presentation of one signature, not a threshold protocol — its rounds exist so
  revocation has something to interrupt.
- **The core image digest is a placeholder.** `0x01` + 31 zero bytes. The
  *mechanism* is real and a mismatch reverts `CoreImageMismatch`; the *value*
  attests nothing. A real digest now exists but is not registered, because
  registering it takes the payment path down either way round.
- **The agent is not fooled by prompt injection, and we do not claim it is.**
  Measured with a real key: four runs, three confirmed injections, it read the
  correct ₹2.40 every time. The `injected` mode makes compliance deterministic so
  the demo works — that compliance is ours, not the model's.
- **A zero-amount payment is approved and co-signed.** Known, disclosed, not
  fixed: fixing the TS evaluator alone would break its byte-identical agreement
  with the deployed Solidity, which is checked over 10,000 differential inputs and
  is worth more.
- **The vendors are simulated.** No GST/MCA registry. No UPI rails — the ₹
  amounts are real ERC-20 transfers on Base Sepolia.

---

## Numbers you should be able to quote

```
core tests            149 passed, 0 skipped
contract tests        57 passed
invariants            INV1-INV5, 64 runs x 4096 calls
differential          10000/10000 agree (TS evaluator vs Solidity)
policy predicates     14, short-circuiting at the first hard failure
lease TTL             15000ms
```

A settlement driven through the containerised stack, verified on-chain:

```
txHash   0x03445f1a43c0d10663b20b94e7a804efaf22219247329ae3925cb3f45ba7eb24
block    45055708   status 0x1   gasUsed 131616
amount   ₹282.00    11/11 predicates passed
```

---

## Not verified

- **Nothing has been deployed.** Railway and Vercel are untested; every command
  above is local. The hosted end-to-end settlement is still the open item.
- `/console` has **no authentication**, contrary to `BUILD.md:45`.
- The frontend has **no component tests**. Every UI claim here comes from driving
  a real browser, not from a test suite.
