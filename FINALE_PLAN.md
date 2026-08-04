# FINALE PLAN — one deployed URL, nothing local, demo-grade

> **New session? Read this file first.** It is the whole plan. It supersedes
> `FINALE.md`'s Part 3 priority order (see *Where this departs from FINALE.md*).
> Companion reading: `BUILD.md` Part 11, `docs/API.md`, `FIXLOG3.md`,
> `LIMITATIONS.md`.
>
> Progress is tracked in `FINALE_PROGRESS.md` — check it before starting work.

Branch: `finale/frontend`. Demo: **8 Aug 2026**.

---

## Context

The engineering is done and it is strong: 86/86 tests, 10 000/10 000 differential
agreement between the TypeScript evaluator and Solidity `PolicyModule.validate`,
three verified contracts on Base Sepolia, a real settled transaction
(`0xfc2926d0…`), a working mid-ceremony revoke, a working kill switch.

Two things stop that from being visible:

1. **Nothing is hosted.** `FIXLOG3.md:303` — hosting was skipped for lack of
   accounts. So the deployed URL renders `CoreOffline.tsx`: honest, and not a
   demo. This is the "frontend that did NOT WORK".
2. **The UI is bare.** On a projector, in front of a panel, bare reads as
   *they didn't finish*.

Requirement: **one deployed site, nothing running on the presenter's laptop,
impressive, nothing compromised.**

### A documented "blocker" that turned out not to exist

`LIMITATIONS.md:38` claims the deployed PolicyModule has
`permittedCategories = 128` — bit 7, `OTHER` and nothing else — and that every
`PACKAGING` / `LOGISTICS` purchase is therefore refused by predicate 7.

**That is false against live state.** Measured 4 Aug 2026 with
`apps/core/scripts/chain-state.mjs`:

```
permittedCategories   223        = 0b11011111
```

Bits 0,1,2,3,4,6,7 are set. `PACKAGING` (bit 0) **is** permitted. The only
category blocked is bit 5, `SOFTWARE` — and that is deliberate: the pinned
fallback at `apps/core/src/api/store.ts:43` lists exactly
`PACKAGING, ADVERTISING, CONTENT, COMPUTE, LOGISTICS, UTILITIES, OTHER`, i.e.
every category except `SOFTWARE`. Contract and core agree.

Two consequences:

- **No owner transaction is needed. The contracts stay exactly as deployed and
  verified.** That is a better outcome than changing them.
- **`LIMITATIONS.md:38` must be corrected.** A judge who checks Basescan will
  find a self-disclosed limitation that is not true, which costs more credibility
  than the limitation would have. `SOFTWARE` is the real, live
  `CategoryNotPermitted` demo case — use it deliberately.

The lesson for anyone continuing this work: **read the chain, not the docs.**
`chain-state.mjs` is the source of truth and takes two seconds to run.

---

## Where this departs from FINALE.md

FINALE.md is a good document and its design doctrine is kept wholesale. Five
changes, all driven by "deployed, one site, nothing local":

| FINALE.md | This plan | Why |
|---|---|---|
| Hosting is **P3**, "a convenience" | Hosting is **Phase 1**, before any UI work | The requirement inverted it. Ordering matters independently: build the whole UI against localhost and you meet CORS, baked-in `NEXT_PUBLIC_*`, and SSE-through-proxy on demo eve. Deploy the UI you have *first*, then rebuild on a known-good deployment. |
| Silent on `permittedCategories` | **Phase 0**, verify against the chain | Measured: it is a stale doc claim, not a real blocker. See above. Verification stays in the plan; the fix does not. |
| Silent on window cap / gas | Phase 0 + demo-day runbook | Window cap is ₹1,00,000/24h with **on-chain** counters a core restart does not reset (`LIMITATIONS.md:135`). Settlement gas is paid by `DEPLOYER_PRIVATE_KEY`. Both measured clear — see Phase 0 — but both need re-checking on demo day. |
| M1 = build a new "Detach core" control | M1 = surface the **existing** rail-bypass attack class | The adversary library already produces exactly this: direct `RekhaAccount.execute()` → `InvalidCoreSignature` on chain (`FIXLOG3.md:197`). A new detach path is new surface area for a moment we can already produce. Note `/v1/admin/kill` stops *lease issuance*, which is a different claim. |
| "Six colours, no seventh" | Same rule, applied to what exists | `globals.css:10-19` currently declares **ten**: the six, plus `--card`, `--border`, `--muted`, and `--accent: #5B8DEF` — a blue. That blue is precisely the generic-dark-SaaS tell FINALE.md warns about. Deleting it is a cheap, real win. |

Everything else — the design doctrine, the Rekha, the three moments, the copy
rules, the honesty fixes, the rehearsal lines — is adopted as written.

---

## Hosting shape (decided: free / least costly)

Verified 3 Aug 2026, not recalled:

- **Railway** — one-time **$5 credit, no credit card, expires in 30 days**;
  services do **not** sleep. <https://docs.railway.com/pricing/free-trial>
- **Render free** — 750 instance-hours/workspace/month, but free web services
  **spin down after 15 min idle with a 30–60 s cold start**.
  <https://render.com/docs/free>

Render's spin-down is disqualifying: it severs the SSE connection the entire UI
is driven by, and a 50 s cold start mid-demo is unrecoverable. Railway's trial
credit comfortably covers three small Node services for the days to the demo.

**Decision — 3 Railway services + 1 Vercel deployment:**

| Service | Contains | Public? | Secrets it holds |
|---|---|---|---|
| Vercel `web` | Next.js | **the one URL judges open** | none |
| Railway `rekha-core` | core `:4000` **+ adversary `:4300`** in one container | yes (core only) | `CORE_SIGNER_PRIVATE_KEY`, `DEPLOYER_PRIVATE_KEY` |
| Railway `rekha-agent` | `apps/core/src/agent/runner.ts` `:4200` | yes | `AGENT_SIGNER_PRIVATE_KEY` **only** |
| Railway `rekha-vendorsim` | vendorsim `:4100` | yes | none |

Two things this shape buys beyond cost:

- **The agent key finally lives on a different host from the core key.**
  `LIMITATIONS.md:72` currently discloses "both key shares live in one `.env` on
  one laptop" as the weakest link in the 2-of-2 claim. Deploying the agent runner
  as its own service with its own secret store retires that disclosure. Update
  `LIMITATIONS.md` when it is true — a scored criterion moving in our favour at
  no extra cost.
- Adversary rides with core because **only the core calls it** (server-side proxy
  at `/v1/adversary/run`); it never needs a public hostname.

**Browser talks directly to the Railway HTTPS URLs.** No Next.js proxy. Reason:
Vercel functions have a max duration, and an SSE stream proxied through one gets
cut and silently loses events mid-demo. `CORS_ORIGIN` already defaults to `*` on
core and agent; vendorsim already sends CORS headers and handles `OPTIONS`
(`FIXLOG3.md:180`). Direct is both simpler and safer here.

### Traps already visible in the repo

- **`apps/web/Dockerfile` does not exist** although `docker-compose.yml:161`
  builds it. Not needed for Vercel — but delete the `web` service from compose or
  add the Dockerfile, so compose isn't a broken artifact a judge might run.
- **compose's `shopper` service is the wrong agent.** It runs the Python
  `apps/agents/shopper`, which serves `POST /agent/run`
  (`apps/agents/shopper/src/runner.py:27`). The web calls `POST /dispatch`
  (`playground/page.tsx:312`), served by the **TypeScript**
  `apps/core/src/agent/runner.ts:321`. Deploy the TypeScript one. Pick one agent
  and say so; two half-wired agents is a question you don't want on stage.
- **`NEXT_PUBLIC_*` are baked at build time.** Changing a Railway URL requires a
  Vercel **redeploy**, not just an env edit. Set them before the first build.
- **`setPolicy` calls `_bumpPolicyHash()`** (`PolicyModule.sol:389`). The core
  seeds policy from chain **at boot only** (`api/index.ts:134`). After any owner
  policy change, **restart the core service** or every lease carries a stale
  `policyHash` and settlements revert.

---

## Phase 0 — verify the chain supports the demo ✅ DONE 4 Aug 2026

**Result: the chain is ready as deployed. No owner transaction was needed and
none was made. `contracts/` is untouched.**

Measured with `set -a; . ./.env; set +a; node apps/core/scripts/chain-state.mjs`
(the `.env` load is what resolves the three `*KeyAddr` fields; without it they
read `(unset/invalid)`):

```
owner                0xA5142D53D56bCCC98C5cC38C6F7d3965f6DabFD2
deployerKeyAddr      0xA5142D53D56bCCC98C5cC38C6F7d3965f6DabFD2   <- we control the owner
coreKeyAddr          0xB18D311dcfA7F1700bEf8245Aa3100b3E3dAdf6B   == on-chain coreSigner
agentKeyAddr         0x6E19cA2B53986EAEeE638412A4051651a64a00d5   == on-chain agentSigner
permittedCategories  223          0b11011111 — everything except SOFTWARE (bit 5)
perTxCapMinor        2500000      ₹25,000
tier2CapMinor        500000       ₹5,000
windowCapMinor       10000000     ₹1,00,000
windowSpentMinor     2789800      ₹27,898
windowStart          1785672478   vs _blockTimestamp 1785782270 → 109,792s elapsed
windowSeconds        86400
cumulativeCapMinor   100000000    spent 2789800
frozen               false
revocationEpoch      0
_deployerEth         29969123515778778    0.0300 ETH
_inrxAccountBalance  47210200     ₹4,72,102 in the account
_coreEth             0            expected — the core signer never broadcasts
```

Readings that matter:

- **`PACKAGING` settles.** Bit 0 of 223 is set. The `LIMITATIONS.md:38` claim to
  the contrary is stale.
- **The window has already rolled.** 109,792 s elapsed against an 86,400 s
  window, and `PolicyModule.sol:306-308` zeroes `windowSpentMinor` on the next
  spend once `block.timestamp >= windowStart + windowSeconds`. **Full ₹1,00,000
  of headroom.**
- **Gas is fine.** 0.0300 ETH against ~131 k gas per settlement
  (`FIXLOG3.md:27`) on Base Sepolia.
- **Both key shares match their on-chain signer.** Whatever is put in the Railway
  secret stores must be these same two keys, or every settlement reverts
  `InvalidCoreSignature` / `InvalidAgentSignature`.

Remaining Phase 0 item, folded into Phase 1: **prove a `PACKAGING` payment
settles end to end against the *hosted* stack**, not locally — one proof, on the
thing that actually has to work.

**If you are re-running this later:** `chain-state.mjs` is read-only and safe.
Re-check `windowSpentMinor`, `_deployerEth` and `frozen` before any rehearsal.

---

## Phase 1 — host it *(one URL, nothing local)*

Deploy **the UI as it is today**. The point is to find hosting problems now, with
slack in hand, not after the rebuild.

1. **Railway `rekha-vendorsim`** — `apps/vendorsim/Dockerfile` exists and works.
2. **Railway `rekha-agent`** — needs a Dockerfile modelled on
   `apps/core/Dockerfile`, with `CMD` running `src/agent/runner.ts` instead of
   `src/api/index.ts`. Env: `AGENT_SIGNER_PRIVATE_KEY`, `CORE_URL`,
   `VENDORSIM_URL`, `CORE_IMAGE_DIGEST`. **No core key.**
3. **Railway `rekha-core`** — extend `apps/core/Dockerfile` to also run the Python
   adversary, with `ADVERSARY_URL=http://localhost:4300`. Fix the stale
   `ENV LEASE_TTL_MS=5000` at `apps/core/Dockerfile:22` — the shipped value is
   15000 and that line silently contradicts it.
4. **Vercel `web`** — set all four `NEXT_PUBLIC_*` to the Railway HTTPS URLs
   *before* the first build.
5. **Re-measure the settlement window from the hosted stack.** `FIXLOG3.md:334`
   records 10 s against a 15 s lease from a laptop. Hosted changes both directions
   (datacenter RPC is faster; extra browser→Railway hops are slower). Measure it,
   then set `LEASE_TTL_MS` from the measurement and **write the number down**. A
   lease expiring mid-demo is the worst failure mode available.
   FINALE.md's alternative — trimming `CEREMONY_ROUND_MS` to 900 — costs M3's
   interruptibility. Prefer raising the TTL and stating the real fail-closed
   window honestly, as `LIMITATIONS.md:43` already does.

**Exit criterion:** on a phone, on cellular, with nothing running locally: open
the Vercel URL, dispatch a task, watch it settle, click through to Basescan.

---

## Phase 2 — design system primitives

`apps/web/src/app/globals.css` (927 lines) already implements much of BUILD.md
Part 11. This is a **cleanup plus five components**, not a from-scratch rebuild.

- **Delete `--accent: #5B8DEF`** and every use of it. Audit `--card`, `--border`,
  `--muted`: keep them only as neutral surface/hairline/secondary-text values,
  never carrying meaning. Amber = held, green = settled, red = refused/revoked;
  nothing else uses those three.
- **Load Bricolage Grotesque via `next/font/google`** in `layout.tsx` alongside
  Geist. It is currently a render-blocking `@import` from Google Fonts at
  `globals.css:6` — a third-party request on the critical path of the demo.

New components in `apps/web/src/components/`:

| Component | Spec |
|---|---|
| `<Rekha>` | SVG closed path, `stroke-dasharray` animation. Three states: **idle** (static, 40% opacity), **flare** (`--breach` pulse travelling ~200 px along the path, settling over 600 ms), **snap** (visible break at the top edge, ends recoiling, held broken 2 s, then healing). Props-driven. Not a CSS border. |
| `<Amount>` | Integer paise → `₹` with Indian digit grouping (`₹1,00,000`), Geist Mono, `font-variant-numeric: tabular-nums`, right-aligned. **Replaces the duplicated `fmtInr` at `console/page.tsx:29` and `playground/page.tsx:66`.** |
| `<TTLRing>` | Drains over lease TTL, refills on renewal. Extracted from the ring already inline at `console/page.tsx:288` and `playground/page.tsx:775` — same maths, one component. |
| `<Counter>` | Animates on increment. No bounce. |
| `<PredicateTable>` | One component replacing the near-duplicate `DecisionPanel` (`console/page.tsx:465`) and `PredicateTrace` (`playground/page.tsx:812`). Binding predicate highlighted. |

Rules: `prefers-reduced-motion` gets non-animated fallbacks. No gradients, no
glass, no hover lift. Motion budget is three things total — Rekha, TTL ring,
ceremony bar.

**Ship a `/kitchen-sink` route showing every state side by side, and review it
before building any page on top.** It is the cheapest place to catch drift toward
generic dark-SaaS.

---

## Phase 3 — `/console`

Rebuild `apps/web/src/app/console/page.tsx` to FINALE.md Part 2. Full width, not
a phone frame.

Reuse, do not rewrite: `lib/pairing.ts` (`ensurePaired`, `renewLease` — they
already handle core-restart re-pairing correctly), `components/CoreOffline.tsx`,
`components/AgentStatus.tsx`, and the `RekhaEvent` union in `src/types.ts`, which
is the SSE contract.

- Top bar: balance in Bricolage ~72 px tabular (the hero), `<TTLRing>`, core
  status, **REVOKE ALL**.
- Left 60%: transaction feed. 4 px left border in the state colour. Held rows
  carry a countdown ring and an **inline** Cancel — no modal.
- Right 40%: decision panel. Plain-English summary comes from the core's
  `trace.summary` — **never generated client-side**. Full `<PredicateTable>`
  below it. `policyHash` and `coreImageDigest` with copy buttons.
- Bottom strip, always visible: `PolicyModule`, `RekhaAccount`, `INRx` with live
  Basescan links. Judges click these.
- Every settled row links to `https://sepolia.basescan.org/tx/{txHash}`.
- **REVOKE ALL calls `PolicyModule.revoke()` directly from the user's wallet via
  wagmi** — already correct at `console/page.tsx:243`. It must **not** route
  through the core API; that independence is a scored criterion. Do not
  "simplify" it.
- All state from SSE. No polling. Core unreachable → `CoreOffline` with the
  contract links still visible. No empty catch blocks — `FIXLOG3.md:164` records
  that every `.catch(() => {})` in `apps/web/src` was removed; keep it that way.

---

## Phase 4 — `/playground` and the three moments ✅ DONE 4 Aug 2026

> Built and verified against the live stack; **not yet seen in a browser**. See
> `FINALE_PROGRESS.md` for the evidence and what is still open.
>
> **One item below was wrong.** "Surface the existing rail-bypass attack result"
> pointed at `library.py:272`, which never touches the chain — its
> `InvalidCoreSignature` is a hardcoded Python string, so it could not carry the
> revert reason or the Basescan link this plan asks for. M1 is now a real
> `eth_call` from the agent runner against the deployed RekhaAccount, which
> returns the contract's own revert. `library.py` is untouched and still
> simulated; fixing it is Phase 5's business.

Rebuild `apps/web/src/app/playground/page.tsx`. Three columns plus a bottom
scoreboard strip, per FINALE.md's ASCII layout.

- `<Rekha>` wraps the centre panel — the containment boundary made literal.
  Wire to SSE: `attack.attempt` with `blocked:true` → **flare**;
  `ceremony.aborted` → **snap**; `payment.settled` → **nothing**. The line does
  not celebrate.
- **Centre panel embeds the live vendor storefront.** vendorsim already serves
  HTML at `GET /vendor/:id` (`apps/vendorsim/src/server.js:94`) — iframe the
  hosted URL. Judge controls (**Spawn counterfeit**, **Inject text**) sit *on
  that panel*, not in a drawer. Both already work and already surface the real
  HTTP response (`playground/page.tsx:369`, `:436`) — keep that behaviour
  verbatim; never a success state for something that did not happen.
- **M2 — Rogue Mode scoreboard.** Four counters, animated increment, attack log
  newest-at-top with the real revert reason from the core. **`₹0 lost` is the
  largest number on the page**, in `--clear`.
- **M3 — ceremony bar + REVOKE side by side**, one gesture. Three segments driven
  by `ceremony.round`, ~1200 ms each. On `ceremony.aborted` the bar must
  **visibly break** — segments shatter, Rekha snaps. Not just stop.
- **M1 — agent alone.** Surface the existing rail-bypass attack result: the agent
  holding its key share and full network access calls `RekhaAccount.execute()`
  directly and the chain reverts `InvalidCoreSignature`. Show the revert reason
  and a Basescan link. *"It isn't blocked. It's incapable."*
- Keep the kill switch as its own, separately-labelled control — it demonstrates
  fail-closed lease issuance, which is a different claim from M1.

---

## Phase 5 — honesty fixes

These earn more credibility than any feature. Do not skip them.

1. **Break down the 147.** `FIXLOG3.md:193` — 124 `FACTSHEET_INVALID` + 20
   `AGENT_NOT_FOUND` died at the input boundary; 3 reached the predicates. Render
   two rows:
   ```
   blocked at input boundary      144
   blocked by policy predicates     3
   ```
   Defence in depth, honestly labelled. A judge who discovers the conflation
   themselves is a judge you have lost.
2. **Fix `apps/agents/adversary/library.py`** so a class that *errors* reports as
   `errored`, never `blocked` (`FIXLOG3.md:317`). It did not fire in the 147 run,
   so the score is real — but the path would inflate it.
3. **Off-chain revoke needs a core restart to undo** (`FIXLOG3.md:327`). A judge
   who clicks "Revoke Mandate (Core)" will think the demo broke. Either add an
   admin un-revoke alongside `/v1/admin/revive`, or label the button so its
   one-way nature is obvious before it is pressed.
4. **Update `LIMITATIONS.md`** once hosting is done: the key shares are no longer
   co-located; the fail-closed window is whatever Phase 1 measured.

---

## Phase 6 — wire the four dead modes

`apps/core/src/agent/runner.ts`. Four of six mode buttons currently change only a
label (`FIXLOG3.md:308`).

Modes change **only the system prompt and thin tool wrappers** — the same agent
binary runs in all six, and a judge should be able to see that.

| Mode | Behaviour | What it proves |
|---|---|---|
| `injected` | vendor page carries hidden instructions; the agent **complies** | the FactSheet boundary |
| `hallucinating` | invented vendor IDs, wrong quantities, duplicate line items | caps + tier catch model error |
| `overreach` | tier upgrades, extras nobody asked for | category + scope |
| `colluding` | registers a vendor it controls, pays itself | attribute predicates |

Start with **`injected`** — it pairs with the counterfeit storefront and it is
the headline threat in the pitch. **Do not make the agent resist the injection.**
The point is that enforcement does not need it to.

Each mode must produce a legible narrative in the `agent.thought` stream.

---

## Phase 7 — landing page at `/`

`/` is currently a bare redirect to `/console` (`apps/web/src/app/page.tsx:23`).
For a URL judges may open cold, days later, with nobody narrating: one screen —
the thesis in a sentence, the three live contract links, the two settled
transaction hashes, and two routes in (Console / Playground). Same six colours,
same restraint. No wallet required to watch anything except REVOKE ALL.

---

## Verification — evidence, not assertion

Nothing below is "should work". Each line is a command whose real output goes in
the commit message or `FIXLOG4.md`.

**Phase 0**
- `node apps/core/scripts/chain-state.mjs` → `permittedCategories` is 255,
  `windowSpentMinor` known, `frozen: false`, deployer has ETH.
- `setPolicy` tx hash, confirmed on Basescan.
- `e2e-settle.ts` → a `PACKAGING` settlement with a real hash.

**Phase 1**
- `curl https://<core>/health` → `ok`, `coreKey: true`, real `leaseTtlMs`,
  `issuanceKilledAtMs: null`.
- `curl -N https://<core>/v1/events` → events stream, held open > 2 min
  without a cut.
- `curl https://<vendorsim>/catalog`, `curl https://<agent>/health` →
  `agentKey: true`, and the agent signer address is **not** the core signer.
- Vercel URL on a phone, cellular, laptop closed: dispatch → settle → Basescan.

**Phases 2–7** — Playwright MCP is already in this project (`.playwright-mcp/`).
Drive the deployed URL, not localhost:
- `/kitchen-sink`: every primitive state screenshotted.
- Console: click a feed row → predicate table with the binding predicate
  highlighted; the `trace.summary` text matches what the core returned.
- Playground: Rogue Mode → counters climb, `₹0 lost`, log shows real revert
  reasons, breakdown row reads 144 / 3.
- Ceremony: dispatch, hit REVOKE mid-ceremony → `ceremony.aborted` on the SSE
  stream, bar visibly breaks, Rekha snaps, nothing settles.
- Each of the four newly-wired modes → its `agent.thought` narrative, and the
  predicate that caught it.
- `pnpm --filter core test` with anvil on 8545 and a Base Sepolia fork on 8546
  (`LIMITATIONS.md:111`) → 86/86. Without anvil only 79 run; say which you ran.

**State explicitly, at the end, what was not verified.**

---

## Demo-day runbook

- **Warm everything 20 minutes before.** Hit the Vercel URL, the core `/health`,
  vendorsim `/catalog`, agent `/health`.
- **Check the spend headroom**: `chain-state.mjs` → `windowSpentMinor` against
  `windowCapMinor`. On-chain, and a restart does not reset it.
- **Check deployer ETH.** Every settlement is gas it pays.
- **Check the Railway credit balance.** $5, 30-day expiry.
- **If the core is unreachable on stage** the console shows `CoreOffline` with
  live contract links — that is the honest fallback, and the four rehearsal lines
  in FINALE.md Part 6 carry the moment without a screen.

## Risks, named

| Risk | Mitigation |
|---|---|
| Window cap hit mid-demo | Raised in Phase 0; checked in the runbook |
| Lease expires mid-settlement | `LEASE_TTL_MS` set from a hosted measurement, not a laptop one |
| Railway credit expires (30 days) | Check balance day-of |
| In-memory core state lost on restart | Already handled: `pairing.ts` re-pairs on 404. On-chain spend counters survive by design |
| Public agent URL = anyone can `POST /dispatch` | Acceptable for a testnet demo, and every payment still needs the core's half. Say so if asked rather than being caught by it |
| Visual drift toward generic dark SaaS | Six colours, semantic only. If a blue or a gradient appears, delete it |
