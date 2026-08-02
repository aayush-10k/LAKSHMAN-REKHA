# FIXLOG3 — submission-integrity pass against FIX3.md

All seven bugs worked in the order given, one commit each. Everything below was
run, not described. Two problems FIX3.md did not list were found on the way and
are recorded in place. What is still broken is in the last section.

**Not pushed.** See *The deadline* at the end.

---

## THE HEADLINE: nothing on screen is fabricated any more

Three things a judge sees were lying before this pass, and are not now.

| | Before | After |
|---|---|---|
| The site at `/` | 44KB of prototype HTML evaluating "policy" in the browser | redirect to the real console; prototype deleted |
| Rogue Mode | `0 · 0 · 0 · ₹0` — reads as "nobody tried" | **147 · 147 · 0 · ₹0**, twelve classes against the live core |
| Judge controls | three 404s reported as success | all three real, with the core's own responses on screen |

And a real settlement still lands after the changes:

| | |
|---|---|
| txHash | [`0xfc2926d09a824bec0fb0d48a8ca13693aa5ed154e3e5ab57e7eef639c4414a7a`](https://sepolia.basescan.org/tx/0xfc2926d09a824bec0fb0d48a8ca13693aa5ed154e3e5ab57e7eef639c4414a7a) |
| Block | 44961513, `status: success`, gas 131,628 |
| Amount | ₹94 to `ven_meridian` |
| Balance after | 47210200 minor, `balanceSource: chain` |
| Wall clock | 10s, against a 15s lease |

---

## BUG 1 — the site served the dead prototype at `/` ✅

Commit `c22f29f`.

Confirmed exactly as described. `simulateSpend()` at `app.js:429` was the entire
"enforcement layer", evaluated client-side; `agent.js:363` carried
`amount = 350; // Triggers perTxCap predicate ($350 > $100)`.

`page.tsx` is now a Server Component redirect to `/console`. Deleted:
`public/js/{app,agent,auth,supabase,bundle}.js`, `public/console.html`,
`public/css/styles.css`, and the stylesheet link in `layout.tsx`.

Checked before deleting: `/console` and `/playground` use their own class names
(`btn-ghost-sm`, `console-body`, `decision-panel`…) all defined in
`globals.css`, and never referenced `public/css/styles.css`. Removing it changes
nothing about how the real pages render — the "visually bare" outcome FIX3.md
was willing to accept did not happen.

`next build` passes, 4 routes, `/` prerendered.

## BUG 2 — fabricated production endpoint ✅ (no separate commit — nothing left to change)

BUG 1's deletions removed every occurrence. Counted from `ee51a82`:

| String | Occurrences removed |
|---|---|
| `lakshman-rekha.dev` | 15 |
| `lr_live_sk` | 14 |
| `interceptor` | 11 |
| **Total** | **40** |

Across `agent.js` (12), `bundle.js` (16), `app.js` (4), `page.tsx` (7),
`auth.js` (1).

`git grep -iE 'lakshman-rekha\.dev|lr_live_sk|interceptor'` over all tracked
files now returns **nothing**. README, SETUP, BUILD, docs and compose are clean;
there are no deck assets in the repo (the only PDFs are vendored OpenZeppelin
audits). The one remaining hit anywhere was in `apps/web/tsconfig.tsbuildinfo`,
an untracked build artifact.

No commit of its own because there was nothing left to remove — recorded here
rather than manufacturing an empty one.

## BUG 3 — deployed pages pointed at localhost ✅ (took the fallback path)

Commit `166590f`.

**Hosting was not attempted.** Standing up core, agent and vendorsim on
Railway/Fly needs accounts and credentials I do not have, so this took FIX3.md's
option 2 — and the README says so in its opening paragraph rather than implying
a working deployment.

An unreachable core now **replaces** the console instead of decorating it. That
matters: every panel on that page reads from the core, so the previous behaviour
rendered a topbar reading "Core offline" directly above "Pairing…", a Decision
Panel, a live-looking Revoke card and "Mandate Active" — an interface that
looked operational with nothing behind it.

Reachability is tri-state (`checking` / `up` / `down`), not boolean, so the
panel does not flash on every load before the health probe returns.

The panel names what is not running, gives the four commands, reports the URL it
tried and why it failed, and puts on screen the things a judge can check without
running anything: three contract links and two settled transactions.

Verified by building against a deliberately dead core
(`NEXT_PUBLIC_CORE_URL=http://localhost:4999`) and loading it in Chrome:

```
The enforcement core is not reachable
Tried http://localhost:4999 — Failed to fetch
INRx ↗ / PolicyModule ↗ / RekhaAccount ↗
0x35025de9…f12c7e90 ↗   block 44959341 · ₹5,760.00 to ven_meridian
0x1ed0242a…64a4df96 ↗   block 44959201 · ₹9,520.00
```

`NEXT_PUBLIC_CORE_URL`, `_AGENT_URL`, `_VENDORSIM_URL` and
`_POLICY_MODULE_ADDRESS` added to `.env.example`, noting that `NEXT_PUBLIC_*` is
baked in at build time and so must be set wherever the web app is built.

README's `demo` / `123` credentials are gone — they belonged to the deleted
prototype and were already false.

## BUG 4 — three judge controls 404 and lied about it ✅

Commit `d8cc4f2`.

**Kill is now real.** `store.issueLease` refuses with `CORE_KILLED`, checked
before anything else, so the stop sits on the one path every caller uses. No new
lease means no new payment. `/health` reports `issuanceKilledAtMs`, because a
killed core still answers `/health` and the one state where spending has stopped
must not look identical to the healthy one. The 30s `core.status` heartbeat
reports issuance rather than hardcoding `up: true`, which would have flipped the
UI back to healthy within 30s of a kill still in force.

```
lease BEFORE kill     HTTP 200   lse_a00b9396
POST /v1/admin/kill   HTTP 200   spendingStopsByMs = killedAt + 15000
lease AFTER kill      HTTP 503   cause CORE_KILLED
health while killed   issuanceKilledAtMs 1785690569638
POST /v1/admin/revive HTTP 200
lease AFTER revive    HTTP 200   lse_52684047
```

**Counterfeit and inject** go to vendorsim, which had implemented both all along
on `:4100`. Both take a `vendorId` — which is why calling the core for them
could never have worked — so the panel has a target-vendor selector populated
from the live catalogue.

```
POST core      /v1/vendorsim/counterfeit      HTTP 404   (the old path)
POST vendorsim /vendorsim/spawn-counterfeit    HTTP 201
     ven_counterfeit1 "Meridian Packaging Outlet" tier 2, aged 2d, 0 settled
POST core      /v1/task/inject                 HTTP 404   (the old path)
POST vendorsim /vendorsim/inject               HTTP 200
     and the injected text is served in the storefront HTML
```

Confirmed by clicking in Chrome, not only by curl:

- "Spawn Counterfeit Storefront" → *"Spawned ven_counterfeit1 — "Meridian
  Packaging Outlet", tier 2, aged 2d, 0 settled, address 0x…dbba1"*, and the
  vendor appears in the selector.
- "Kill Approval Service" → *"Approval service killed. No further leases will be
  issued; all spending stops within 15000ms."*, button flips to "Resume", and
  `/health` independently showed `issuanceKilledAtMs: 1785692092800`.

A revive route is included so a judge who kills the core can carry on without
restarting four processes. It and the lack of auth on `/v1/admin/*` are
commented in the route as the demo affordances they are.

Every empty `.catch(() => {})` in `apps/web/src` is gone; balance and holds
failures now surface.

## BUG 5 — Rogue Mode permanently zero ✅

Commit `2c2672d`. **Final scoreboard: 147 attempts · 147 blocked · 0 novel · ₹0
lost**, watched filling in Chrome.

Two things were wrong, not one.

**The adversary runner had never started.** `runner.py` and `test_library.py`
import by plain name with the directory on `sys.path`, but `generator.py` used a
relative import — so `python3 runner.py` died on *"attempted relative import
with no known parent package"* before binding a socket. FIXLOG2 described the
twelve classes as "written but not wired in"; they also could not run.

**vendorsim had no CORS headers.** Once BUG 4 pointed the judge controls at it,
every call from the browser failed with *"blocked by CORS policy"* — the same
failure the SSE stream had. Headers added, plus `OPTIONS` preflight, which a
POST carrying `content-type: application/json` requires and which previously
fell through to a 405.

`POST /v1/adversary/run` proxies to the runner and replays the returned events
onto the SSE bus at 120ms intervals so the board fills rather than snaps. It
decides nothing: the blocked verdict comes from the core's own responses.
Unreachable runner → 503 and the score stays at zero.

**The revert reasons, exactly as the core returned them:**

| Count | Reason | Meaning |
|---|---|---|
| 124 | `FACTSHEET_INVALID` | typed-schema injection boundary |
| 20 | `AGENT_NOT_FOUND` | lease griefing with a fake agentId |
| 1 | `InvalidCoreSignature` | rail bypass, direct `RekhaAccount.execute()` |
| 1 | `InvalidCoreSignature (on-chain key mismatch)` | core impersonation |
| 1 | `DECISION_NOT_FOUND` | signature forgery |

All 12 classes covered. **0 not blocked. 0 errored-but-counted-as-blocked.**

**Read that table honestly**: most attacks die at the input boundary or on a
missing agent, not against the 14 predicates. That boundary is a real part of
the design (BUILD.md names it) and refusing malformed input *is* blocking — but
"147 blocked" is not "147 attacks reached the evaluator and were refused by
policy", and should not be presented as if it were.

`pnpm dev:adversary` added to `package.json` and `SETUP.md`; compose's core
service gains `ADVERSARY_URL`.

**Found on the way:** compose set the web service's `NEXT_PUBLIC_*` to compose
service names (`http://core:4000`). Those are resolved by the judge's *browser*,
not the container, so they were unreachable — the same bug as BUG 3, in the
Docker path. Now defaults to published ports, overridable.

## BUG 6 — 180ms ceremony ✅

Commit `8e0784f`.

`CEREMONY_ROUND_MS`, default 1200 → ~3.6s ceremony. Clamped to (0, 3000]: zero
makes the revocation window unobservable again, and beyond ~3s a round the
ceremony outlives its lease. Added a lease-expiry check after the ceremony so an
expired lease fails closed with 403 rather than producing a settlement context
that would revert `LeaseExpired` on chain.

**A real settlement still lands** — the risk in slowing this down:
`0xfc2926d0…c4414a7a`, block 44961513, success, ₹94, 10s wall clock against a
15s lease.

**Revoking during the ceremony aborts it.** `POST /v1/payment/request`, then
`POST /v1/revoke` 1.8s in. From the SSE stream:

```
ceremony.round    round 1   atMs 1785691350143
revocation        epoch 1   atMs 1785691350414   <- owner revokes
ceremony.round    round 2   atMs 1785691351343
ceremony.aborted  atRound 2 reason revoked  atMs 1785691351344
```

`/v1/payment/request` returned **403 REVOKED**. Nothing settled. Rounds 1200ms
apart, as configured. This is beat 5 of BUILD Part 10, and it was not
performable before.

## BUG 7 — documentation overstated the build ✅

Commit `75cca55`.

**The audit export is now really signed**, rather than disclosed as unsigned —
it was a small change and the honest version is better than the honest excuse.
`digest` is keccak256 over the serialised body, `signature` is that digest
signed with the core key. No key → `signature: null` and a `signatureStatus`
saying why, never a zero that reads like a signature.

Verified with `apps/core/scripts/verify-audit.mjs`, which trusts none of the
export's own claims:

```
signatureStatus                                signed
digest recomputed from body == reported        true
recovered signer  0xB18D311dcfA7F1700bEf8245Aa3100b3E3dAdf6B   (deployed core signer)
signer matches                                 true
tampering with the body changes the digest     true
tampered digest recovers to a DIFFERENT address true
```

**The differential claim is TRUE and was re-run, not removed.** With anvil on
8545 and a Base Sepolia fork on 8546:

```
 ✓ test/explain.test.ts            (11 tests)
 ✓ test/evaluator.test.ts          (32 tests)
 ✓ test/lease.test.ts              (19 tests)
 ✓ test/signing.test.ts            (17 tests)
 ✓ test/hash-request.fork.test.ts   (2 tests)
 ✓ test/execute.fork.test.ts        (4 tests)
 ✓ test/differential.test.ts        (1 test)   10000/10000 agree
 Test Files  7 passed (7)
      Tests  86 passed (86)
```

`hash-request.fork.test.ts` — the canary for the signing digest — passes, so
digest agreement no longer rests only on settlements that happened to land.
LIMITATIONS.md gives the exact anvil commands, because without them 3 files fail
and only 79 of 86 tests run.

**Corrected everywhere:** the fail-closed window is **15s, not 5** — in
LIMITATIONS.md, BUILD.md's lease section, demo beat 6, the ship checklist and
the lease-ring description. The claim was corrected rather than the value
quietly lowered, and the reason is stated. Rehearsal beat 4 said the scoreboard
reads `247 · 247 · 9 · ₹0`; measured is `147 · 147 · 0 · ₹0`, and the 9 novel
variants need an LLM key.

**Newly recorded in LIMITATIONS.md:** the prototype deletion and that nothing in
the shipped UI evaluates policy client-side; both key shares living in one
`.env` while the code paths are genuinely separate; the ₹1,00,000 rolling window
with on-chain counters a restart does not reset.

---

## Still broken

**Nothing is hosted.** BUG 3 took the fallback. `/console` on a deployed URL
shows the offline panel, which is honest but is not a working demo. Hosting core
+ agent + vendorsim and setting the four `NEXT_PUBLIC_*` vars in Vercel remains
the single highest-value thing left.

**Only `compromised` is wired to anything.** `hallucinating`, `injected`,
`overreach` and `colluding` still run the identical honest path — FIX3.md BUG 5
asked for `compromised`, and that is what was done. Four of the six mode buttons
still do nothing but change a label.

**"Blocked" is coarser than it looks.** 144 of 147 blocks are
`FACTSHEET_INVALID` or `AGENT_NOT_FOUND`. See the caveat under BUG 5.

**`library.py` reports an errored attack class as blocked.** `run_all_attacks`
catches an exception from a class and emits `blocked=True` with
`revertReason: "ERROR_IN_ATTACK"`. It did not fire in this run (0 such results),
so the 147/147 is real — but the code path would inflate the score if a class
broke, and an attack that errored is not an attack that was blocked. Left alone
because changing attack semantics on submission day is worse than naming it.

**The LLM variant generator is untested.** `mode: "full"` needs an API key and
was never exercised; only the deterministic path ran. The relative-import fix
means it at least loads now, which it did not before.

**An off-chain revoke still needs a core restart to undo.** Unchanged and
pre-existing. A judge who clicks "Revoke Mandate (Core)" will think the demo
broke. The new `/v1/admin/revive` covers the kill switch, not revocation.

**Both key shares are in one `.env`.** Unchanged, now stated plainly in
LIMITATIONS.md.

**Settlement headroom is thin.** 10s of a 15s lease. A slow Base Sepolia block
or a slower machine will revert with `LeaseExpired`. Raising `LEASE_TTL_MS`
weakens the fail-closed claim; the two are in direct tension and the current
split is a judgement call, not a solved problem.

**The console UI was not driven through a settlement in this pass.** I verified
Rogue Mode, the offline panel and two judge controls by clicking in Chrome, and
the settlement through `scripts/e2e-settle.ts`. The Dispatch → settle path in
the browser was verified in FIXLOG2, not re-verified here.

---

## The deadline

**I could not determine it, so I have not pushed.**

There is no deadline recorded anywhere in the repo — no date in `BUILD.md`,
`README.md`, `SETUP.md`, `.github/`, or any config. The seven commits are local
only. Local commits are reversible and invisible to the organisers; a push is
neither, which is why that is where I stopped.

At the time of writing it was **Sun 2 Aug 2026, 23:04 IST**.

If the deadline has not passed: `git push origin main` — the branch is `main`,
seven commits ahead of `ee51a82`. If it has passed, say so and the commits can
be dropped with `git reset --hard ee51a82` without any trace having left this
machine.
