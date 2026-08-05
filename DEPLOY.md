# DEPLOY — one URL, nothing local

The judge opens **one** URL: the Vercel deployment. Everything behind it is
infrastructure. Nothing runs on the presenter's laptop.

Plan and rationale: `FINALE_PLAN.md`. This file is the mechanical procedure.

```
                    ┌────────────────────────────┐
   judge's browser  │  Vercel   web (Next.js)    │   the one URL
                    └────┬───────┬──────────┬────┘
                         │       │          │        direct HTTPS, no proxy
              ┌──────────▼──┐ ┌──▼───────┐ ┌▼──────────────┐
              │ rekha-core  │ │rekha-    │ │ rekha-        │
              │ :4000       │ │agent     │ │ vendorsim     │
              │ + adversary │ │ :4200    │ │ :4100         │
              │   (loopback)│ │          │ │               │
              └─────────────┘ └──────────┘ └───────────────┘
                 CORE_SIGNER     AGENT_SIGNER      no secrets
                 DEPLOYER        (and nothing else)
```

**The browser talks to the backends directly. There is deliberately no Next.js
proxy** — Vercel functions have a maximum duration, and the SSE stream that
drives the entire UI would be cut mid-demo and silently lose events. CORS is
already open on all three services.

> ### All three images have been built and run
>
> This section used to say Docker was not installed and that Railway's build
> would be the first real test of these Dockerfiles. **That was wrong on both
> counts.** Docker 29.1.3 was already installed in WSL; the probe that concluded
> otherwise read `apt-cache policy docker.io | grep Candidate`, which prints the
> *available* version whether or not the package is installed. The same mistake
> had earlier hidden a working Foundry install.
>
> Corrected 5 Aug 2026. All three images now build, and `docker compose up`
> brings the stack to healthy, on this machine:
>
> ```
> rekha-vendorsim   Up (healthy)   0.0.0.0:4100->4100/tcp
> rekha-core        Up (healthy)   0.0.0.0:4000->4000/tcp
> rekha-agent       Up (healthy)   0.0.0.0:4200->4200/tcp
> ```
>
> One dispatch driven end to end through the containers — not the host services —
> settled on Base Sepolia:
>
> ```
> outcome     APPROVED     11/11 predicates passed
> amount      28200 paise (Rs 282.00)
> txHash      0x03445f1a43c0d10663b20b94e7a804efaf22219247329ae3925cb3f45ba7eb24
> block       45055708     status 0x1     gasUsed 131616
> ```
>
> **Five defects were found by doing this, four of which would have reached
> Railway.** They are fixed; the point of listing them is that none was visible
> from reading the files:
>
> 1. `packages/contracts-abi/` was copied into neither image. `api/chain.ts`
>    loads those JSON files by relative path, so pnpm could not know they were
>    needed. It fails *quietly*: the core boots healthy and serves `/health`
>    with `ok:true`, then cannot settle anything.
> 2. The core was never given `VENDORSIM_URL`, so it planned against
>    `localhost:4100` and every dispatch returned an empty plan.
> 3. The core was never given a funded broadcaster key, so settlement reached
>    the chain and died on `gas required exceeds allowance (0)`.
> 4. `CORE_IMAGE_DIGEST` defaulted to `sha256:dev`, which `coreImageDigestHex()`
>    rejects outright — a default strictly worse than leaving it unset.
> 5. Compose-only: the service network was `internal: true`, which silently
>    suppresses port publishing, so two of the three services were unreachable.
>
> Items 1–3 are environment and image-content faults that apply to **any**
> deployment target, Railway included. Set them there too — see the env tables
> below. Item 5 does not apply to Railway, which does not use this compose file.

---

## 0. Push the branch

Railway and Vercel build from GitHub, so anything uncommitted is invisible to
them.

```bash
git status --short                  # expect clean
git push origin finale/frontend
```

**Deploy from `ranvir7123/LAKSHMAN-REKHA`, not `aayush-10k`.** As of 5 Aug 2026
this working copy points at the fork:

```
origin    https://github.com/ranvir7123/LAKSHMAN-REKHA   <- deploy from this
upstream  https://github.com/aayush-10k/LAKSHMAN-REKHA
```

All nine branches were pushed to the fork and verified SHA-for-SHA against
upstream. GitHub's fork UI copies only the default branch, which is why the fork
arrived with `main` alone.

Two things to know when picking the repo in Railway and Vercel:

- Select the **fork**, and branch **`finale/frontend`**. It is not the fork's
  default branch, so neither platform will pick it for you. Every service and
  the Vercel project must be set to it explicitly, or you will build `main`,
  which is 25 commits behind and does not contain any of this.
- `upstream/main` has moved on independently (`ccfa336`, "Update README.md") and
  has diverged from the local `main` — 25 ahead, 3 behind. Do not merge it in to
  tidy up before the demo.

---

## 1. `rekha-vendorsim` (Railway) — no secrets, deploy first

Nothing depends on it having URLs, and both other services need its URL.

| Setting | Value |
|---|---|
| Source | this repo, branch `finale/frontend` |
| Root directory | `/` (repo root — the Dockerfile `COPY`s from there) |
| Dockerfile path | `apps/vendorsim/Dockerfile` |
| Env | none required |
| Networking | **Generate a public domain** |

`apps/vendorsim/src/server.js:107` reads `process.env.PORT`, so Railway's
injected port is honoured. Record the URL as **`<VENDORSIM_URL>`**.

Verify:

```bash
curl -s <VENDORSIM_URL>/catalog | head -c 200      # a JSON array of vendors
curl -s -o /dev/null -w '%{http_code}\n' <VENDORSIM_URL>/vendor/ven_meridian   # 200, HTML storefront
```

---

## 2. `rekha-core` (Railway) — the core plus the adversary

| Setting | Value |
|---|---|
| Root directory | `/` |
| Dockerfile path | `apps/core/Dockerfile` |
| Networking | **Generate a public domain** |

Environment:

| Variable | Value | Notes |
|---|---|---|
| `CORE_SIGNER_PRIVATE_KEY` | from `.env` | **must** be the key for `0xB18D311dcfA7F1700bEf8245Aa3100b3E3dAdf6B` — the on-chain `coreSigner`. Any other key reverts every settlement with `InvalidCoreSignature` |
| `DEPLOYER_PRIVATE_KEY` | from `.env` | broadcasts and pays gas (`api/chain.ts:136`). Address `0xA5142D…DabFD2`, held 0.0300 ETH on 2026-08-04 |
| `BASE_SEPOLIA_RPC` | `https://sepolia.base.org` | |
| `INRX_ADDRESS` | `0x9df2d451d682971878d09ba13920ca418697272d` | |
| `POLICY_MODULE_ADDRESS` | `0x933bb10252ec2b133f28b7d5edf1d303c3384d87` | |
| `REKHA_ACCOUNT_ADDRESS` | `0xd65122eafeb2e6f384d0095bac7de6f662276f6c` | |
| `CORE_IMAGE_DIGEST` | `0x0100…00` (64 hex) | **must equal the agent service's value** — see §3. Must be 32-byte hex: `coreImageDigestHex()` (`policy-state.ts:35`) throws on anything else, so a placeholder like `sha256:dev` is worse than leaving it unset |
| `VENDORSIM_URL` | `<VENDORSIM_URL>` from §1 | **easy to miss — the core needs this too, not just the agent.** `task.ts:18` plans against `/catalog` and `payment.ts:46` verifies the counterparty's tier there before signing. Unset, it defaults to `http://localhost:4100` and every dispatch returns an empty plan with "the vendor registry could not be read". This was missing from the compose file and cost a full debugging round |
| `CORS_ORIGIN` | `*` | tighten to the Vercel origin after step 4 if you like |
| `LEASE_TTL_MS` | `15000` | Dockerfile default. Re-measure after step 5 |
| `CEREMONY_ROUND_MS` | `1200` | Dockerfile default |

`ADVERSARY_URL` is already `http://127.0.0.1:4300` in the image and needs no
override — the adversary runs beside the core in the same container.

**One more variable, and it has to wait for §3: `AGENT_URL`.**

| Variable | Value | Notes |
|---|---|---|
| `AGENT_URL` | `<AGENT_URL>` from §3 | Rogue Mode's attack classes 5 and 7 are mounted by the adversary — which runs *inside this container* — POSTing to the agent's `/rail-bypass`. Its default is `http://localhost:4200`, which in here is nothing |

This is a genuine circular dependency: the core needs the agent's URL and the
agent needs the core's. **Deploy the core without `AGENT_URL` first, do §3, then
come back and add it and redeploy the core.** Nothing else in the core depends
on it, so the first deploy is healthy and settles fine without it.

If you skip it, Rogue Mode reports **`2 errored`** and those two are the only
classes that reach the deployed contract — so `byStage.chain` reads `0` and the
on-chain half of the enforcement claim goes untested while the scoreboard still
looks broadly fine. Measured in the compose stack before this was set:

```
without AGENT_URL   blocked 83  through 14  errored 2   byStage.chain 0
with AGENT_URL      blocked 85  through 14  errored 0   byStage.chain 2
```

Record the URL as **`<CORE_URL>`**. Verify:

```bash
curl -s <CORE_URL>/health
# expect: {"ok":true,...,"coreKey":true,"leaseTtlMs":15000,"issuanceKilledAtMs":null,...}
#   coreKey:false            -> CORE_SIGNER_PRIVATE_KEY is unset or malformed
#   issuanceKilledAtMs: <n>  -> someone left the kill switch on; POST /v1/admin/revive

curl -N -s <CORE_URL>/v1/events    # must stream and STAY OPEN. Ctrl-C after 2 min.
```

Check the deploy logs for the policy seed line — it proves the RPC is reachable
and that the core agrees with the chain:

```
[policy] seeded from PolicyModule: perTxCap=2500000 windowCap=10000000 categories=223 epoch=0 ...
```

If instead you see `[policy] could not read PolicyModule`, decisions may
disagree with the chain. Fix before demoing. **That one line has two very
different causes, and the message names neither:**

1. **The RPC is genuinely unreachable.** Check by calling it from inside the
   running container, not from your laptop:
   ```bash
   wget -qO- --timeout=15 --header='Content-Type: application/json' \
     --post-data='{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
     https://sepolia.base.org
   # expect: {"jsonrpc":"2.0","result":"0x...","id":1}
   ```
2. **`packages/contracts-abi/` is missing from the image.** `api/chain.ts:38`
   reads those JSON files off disk by relative path, so `loadAbi` throws ENOENT,
   `seedPolicyFromChain` catches it, and you get the identical warning against a
   perfectly healthy RPC. Check with `ls /app/packages/contracts-abi/` in the
   container — expect `INRx.json PolicyModule.json RekhaAccount.json`.

Cause 2 is the one that bites, because everything else looks fine: the container
is healthy, `/health` returns `ok:true`, pairing works, and only settlement
fails. Both Dockerfiles now COPY that directory; if you have edited them, check
this first.

---

## 3. `rekha-agent` (Railway) — the other key share

| Setting | Value |
|---|---|
| Root directory | `/` |
| Dockerfile path | `apps/core/Dockerfile.agent` |
| Networking | **Generate a public domain** |

Environment:

| Variable | Value |
|---|---|
| `AGENT_SIGNER_PRIVATE_KEY` | from `.env` — key for `0x6E19cA2B53986EAEeE638412A4051651a64a00d5`, the on-chain `agentSigner` |
| `CORE_URL` | `<CORE_URL>` from §2 |
| `VENDORSIM_URL` | `<VENDORSIM_URL>` from §1 |
| `CORE_IMAGE_DIGEST` | **byte-identical to the core's** |
| `BASE_SEPOLIA_RPC` | `https://sepolia.base.org` — **easy to miss on this service.** The rail-bypass probe `eth_call`s the deployed RekhaAccount *from this process*, on purpose, so it needs its own RPC. Without it, attack classes 5 and 7 cannot reach the chain to lose to it |

> **The agent is meant to have internet, and that is not an oversight.** The
> probe runs here rather than in the core so the attack is mounted from exactly
> the position an attacker occupies (`agent/runner.ts:543` — "the claim is that
> the core is not what stops this"). If a network policy is what prevents the
> bypass, the demo proves the wrong thing: enforcement must not depend on the
> agent being contained. An agent that *can* reach the chain, holds a real key,
> and still cannot spend is the entire demonstration. It holds 0 ETH and the
> probe broadcasts nothing.

> **Do not put `CORE_SIGNER_PRIVATE_KEY` on this service.** Keeping the two
> shares on separate hosts with separate secret stores is the entire reason this
> is a second service, and it is what lets `LIMITATIONS.md` stop disclosing that
> both shares live in one file. Adding it here silently undoes that.

Why `CORE_IMAGE_DIGEST` must match: the runner rebuilds the `PaymentRequest`
itself to produce its half of the 2-of-2 (`apps/core/src/agent/runner.ts:248`).
If the two sides assemble different structs, the signatures recover to different
addresses and `PolicyModule` rejects with `InvalidAgentSignature`.

> **And it must also equal what the CONTRACT holds**, or predicate 3 reverts
> `CoreImageMismatch` on every payment. Right now that value is the `0x01…00`
> placeholder, so leaving both services on the placeholder is correct and the
> deployment works. Do **not** set them to the real source digest from
> `apps/core/scripts/core-image-digest.mjs` unless you are also sending the
> `attestCoreImage()` transaction — there are three places to keep in step, not
> two, and there is no ordering that avoids an outage. `LIMITATIONS.md` has the
> procedure. Not something to do on demo day.

Record as **`<AGENT_URL>`**. Verify:

```bash
curl -s <AGENT_URL>/health
# expect: {"ok":true,...,"agentKey":true,
#          "agentSigner":"0x6E19cA2B53986EAEeE638412A4051651a64a00d5"}
```

That address **must** match — verified locally 2026-08-04 against the on-chain
`agentSigner`. If it differs, you loaded the wrong key and nothing will settle.

---

## 4. `web` (Vercel) — the one URL

| Setting | Value |
|---|---|
| Framework | Next.js (auto-detected) |
| Root directory | `apps/web` |
| Branch | `finale/frontend` |

Environment — **all four**, for Production *and* Preview:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_CORE_URL` | `<CORE_URL>` |
| `NEXT_PUBLIC_AGENT_URL` | `<AGENT_URL>` |
| `NEXT_PUBLIC_VENDORSIM_URL` | `<VENDORSIM_URL>` |
| `NEXT_PUBLIC_POLICY_MODULE_ADDRESS` | `0x933bb10252ec2b133f28b7d5edf1d303c3384d87` |

> **`NEXT_PUBLIC_*` are baked into the browser bundle at build time.** Changing
> one later requires a **redeploy**, not just an env edit. Set all four before
> the first build.

This is precisely how the earlier deployment failed. `apps/web/.env.local` (git-
ignored, so Vercel never saw it) holds only three of the four, all pointing at
`localhost`. Built without them, every backend URL falls back to a localhost
default and the console correctly renders the "core unreachable" panel.
`NEXT_PUBLIC_VENDORSIM_URL` is absent from that file entirely — set it here.

The production build was verified locally on 2026-08-04: Next.js 16.2.12,
compiled in 2.6 s, 4 routes, all prerendered, TypeScript clean.

---

## 5. Prove it end to end

With **nothing running locally** — ideally on a phone, on cellular:

1. Open the Vercel URL. **It lands on `/`, which is a Server Component with no
   data fetching**, so it renders identically whether or not Railway is awake.
   That is deliberate and it means `/` proves nothing about the backend — go to
   `/console`, which should show a live balance rather than the offline panel.
2. Go to Playground, dispatch `order 100 amber glass bottles`. Use the specific
   phrase: with cheapest-wins routing, a vague "order 100 bottles" goes to
   FlashCart (tier 3) and is refused, which is a good demo of a different thing.
3. Watch the decision trace appear, then the settlement.
4. Click through to Basescan and confirm the transaction.
5. **Run one corrupted mode too.** `Overreach` is the best single check that the
   whole chain is wired: the requested item settles on chain and the extra one
   is refused on `categoryPermitted`, so one dispatch exercises both outcomes.
6. Re-check headroom afterwards:

```bash
cd <repo> && set -a && . ./.env && set +a && node apps/core/scripts/chain-state.mjs
```

**Then measure the settlement window** — the number Phase 1 of the plan asks for.
FIXLOG3 recorded 10 s against a 15 s lease from a laptop; hosted will differ.
Time a dispatch from click to `payment.settled`. If it exceeds ~11 s, raise
`LEASE_TTL_MS` on the core service and say so in `LIMITATIONS.md` — the
fail-closed window is a product claim, so it gets corrected, not hidden.

---

## Failure modes, and what they actually mean

| Symptom | Cause |
|---|---|
| Console shows "enforcement core is not reachable" | A `NEXT_PUBLIC_*` is missing or wrong. They are baked at build time — **redeploy** after fixing |
| `/health` shows `coreKey:false` | `CORE_SIGNER_PRIVATE_KEY` unset or malformed. Every payment 503s |
| `/health` shows `issuanceKilledAtMs` non-null | Kill switch still on from a rehearsal. `POST <CORE_URL>/v1/admin/revive` |
| Every lease 409s `REVOKED` | A revoke left over from a rehearsal. `POST <CORE_URL>/v1/admin/unrevoke {"mandateId":…}`, or the "rehearsal reset" button that appears on `/playground` after a revoke. It **refuses if the freeze is on chain** and says so — that one has no undo, and no restart clears it either |
| Settlement reverts `CoreImageMismatch` | `CORE_IMAGE_DIGEST` does not equal what `PolicyModule` holds. Three places must agree — core service, agent service, contract. Check with `node apps/core/scripts/core-image-digest.mjs` |
| Settlement reverts `InvalidCoreSignature` | Core key is not `0xB18D31…dAdf6B` |
| Settlement reverts `InvalidAgentSignature` | Agent key is not `0x6E19cA…a00d5`, **or** `CORE_IMAGE_DIGEST` differs between the two services |
| Settlement reverts `LeaseExpired` | Hosted round trip exceeds `LEASE_TTL_MS`. Raise it, then re-measure |
| Settlement reverts `CategoryNotPermitted` | The line item is `SOFTWARE` — the one category the live contract does not permit. Deliberate; it is the demo's refusal case |
| Settlement reverts `WindowCapExceeded` | ₹1,00,000 rolling 24 h cap. On-chain — restarting the core does **not** reset it. `chain-state.mjs` shows `windowSpentMinor` |
| Dispatch times out, nothing in logs | The agent listened on the wrong port. Fixed by the `PORT` fallback in `runner.ts:51`; confirm the service picked it up |
| Rogue Mode 503s | The adversary died inside the core container. Deliberately non-fatal — the core reports it rather than inventing a score. Redeploy the core service |
| Rogue Mode shows **`2 errored`**, `byStage.chain 0` | Classes 5 and 7 could not reach the chain. Either `AGENT_URL` is unset on the **core** (§2) or `BASE_SEPOLIA_RPC` is unset on the **agent** (§3). Both are needed; the scoreboard otherwise looks fine while the on-chain claim goes untested |
| Build fails `ERR_PNPM_NO_LOCKFILE` | A Dockerfile lost its `pnpm-lock.yaml` COPY line. It is required |

---

## Cost

Railway gives a one-time **$5 credit, no card, expiring 30 days** after signup,
and services do **not** sleep. Three small Node services comfortably fit inside
that for the run-up to the demo. Vercel Hobby is free.

Render's free tier was rejected deliberately: free web services spin down after
15 minutes idle with a 30–60 s cold start, which severs the SSE stream and is
unrecoverable mid-demo.

**Check the remaining Railway credit on demo day.**
