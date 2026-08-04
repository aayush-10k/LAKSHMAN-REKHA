# HONESTY PLAN — every claim we make that we cannot currently back

Audited 4 Aug 2026 against `BUILD.md` (Parts 0, 1, 2, 12), `LIMITATIONS.md` and
the deck outline in `BUILD.md` Part 14. Demo is **8 Aug 2026**.

The rule this document serves is `BUILD.md:22` — *"The judge verifies, we don't
assert. Every claim needs an on-screen artifact. 'Trust us' is worth zero."*
Its corollary is the one that actually bites: **a claim with an artifact that
doesn't mean what it looks like is worse than no claim at all.** A judge who
finds one stops believing the rest of the board.

Each item below is *either* fix it *or* retract it. Both are honest. Nothing here
requires shipping a feature we don't have — but several things require deleting a
sentence we've already written.

---

---

# PART II — WHAT HAPPENED WHEN THE INSTRUMENTATION WAS FIXED

*Executed 4 Aug 2026. Read this before Part I: several items below supersede it.*

Fixing how the scoreboard **counts** turned out to be the whole story. The
adversary suite was not measuring what it reported, and once it did, the 147/147
board did not survive contact with its own data.

## The suite had never reached the policy evaluator. Not once.

`API.md` §3 requires hex ids:

```
taskId      ^tsk_[0-9a-f]{6,}$
lineItemId  ^li_[0-9a-f]{6,}_\d{2}$
leaseId     ^lse_[0-9a-f]{6,}$
```

Every FactSheet the library built used `tsk_attack01`, `li_attack01_01` and
`lse_attack00`. `attack01` contains `t` and `k`. **Every single one was rejected
by the schema validator before the policy evaluator ran.** Measured, before any
change:

```
by stage:  input 145   policy 0   chain 2
```

Zero. The twelve classes proved a regex worked. The 14 predicates — the product
— were never exercised by the adversary at all, and "147 blocked" was 147
rejections at the front door.

That is also why the old board looked perfect: nothing ever got far enough to
fail interestingly.

## Two of the twelve classes never touched anything

`RailBypassAttack` (class 5) and `CoreImpersonationAttack` (class 7) were
`blocked = True` with a hardcoded revert string and a comment reading *"We
simulate the attempt here"*. Two twelfths of a scoreboard headed **147 blocked**
were assertions.

Both now POST to the agent runner's `/rail-bypass`, which builds a real
PaymentRequest against the live policy, signs it, and `eth_call`s
`RekhaAccount.execute` on Base Sepolia:

```
self-signed  reverted | InvalidCoreSignature   (agent puts its own sig in the core's slot)
fake-core    reverted | InvalidCoreSignature   (agent generates a throwaway co-signer)
```

Real, free (no transaction is broadcast), and the revert name is the deployed
bytecode's own answer.

## Three ways the counter inflated itself

1. `run_all_attacks` caught any exception from an attack class and emitted
   `blocked=True` — comment: *"so the board stays full"*. Our own harness
   crashing counted as a defence.
2. `_is_blocked` returned `True` for `NETWORK_ERROR` and for any response shape
   it did not recognise. The core being unreachable counted as a defence.
3. `runner.py` reported `"fundsLostMinor": 0` as a literal, commented
   *"target is always ₹0"* — a hardcoded answer to the most important question
   on the board.

All three are gone. `status` is now `blocked` / `through` / `errored`, and
`errored` is never a defence.

## Then the real results arrived

With valid ids, a genuine lease, and a lease refresh between classes (without it
the late classes inherited an expired lease and 58 of 99 attempts were refused
`LEASE_EXPIRED` — the lease standing in front of every other defence and hiding
all of them):

```
total 99   blocked 42   approved-by-core 54   errored 3
by stage:  input 26   policy 14   chain 2

AGENT_NOT_FOUND        20  input     nonce             5  policy
FACTSHEET_INVALID       4  input     counterpartyTier  5  policy
DECISION_NOT_FOUND      1  input     perTxCap          1  policy
injection stripped      1  input     LEASE_EXPIRED     3  policy
InvalidCoreSignature    2  chain
```

Predicate names on the board at last — `nonce`, `counterpartyTier`, `perTxCap`.
And two findings that were invisible before:

### F1 — the core will co-sign past its own window cap

All 12 structuring payments are APPROVED. 12 × ₹8,579 = **₹1,02,948** against a
₹1,00,000 window cap.

The core's `windowSpentMinor` advances on **settlement**, and this attack never
settles, so each request looks fine in isolation. Money still cannot move —
`PolicyModule.validate` reverts `WindowCapExceeded` on chain against the
authoritative on-chain counter (`PolicyModule.sol:253`) — but the core hands out
signatures it should not.

### F2 — the core is not concurrency-safe on nonces

The 50-thread TOCTOU race gets **most threads approved on the same nonce**
(32 of 50 in one run, 45 in another — it is a race, so it varies). Only a
handful bind on `nonce`.

`BUILD.md:772` states invariant **INV5, "No nonce is consumed twice"**, and
`BUILD.md:793` promises *"50 parallel same-nonce payments → exactly one
settles"*. On chain that holds — `usedNonces` is enforced in the contract, so
exactly one could ever settle. At the core it does not: the check and the write
are not atomic.

**Both F1 and F2 have the same shape and the same honest answer.** The chain is
the enforcing layer and it holds; the off-chain core is an optimistic
pre-filter. That is a defensible architecture — it is *the* architecture, given
"the judge verifies, we don't assert" — but the scoreboard and the ship
checklist both currently describe a core that is stronger than it is.

### F3 — the injection test was checking the wrong property, and fired a false CRITICAL

Class 8 called any APPROVED response `"CRITICAL: injection reached evaluator"`.
Its fifth sheet adds an unknown `description` key, which `validateFactSheet`
**strips** before parsing, leaving an ordinary ₹940 PACKAGING payment to a
tier-1 vendor. Approving that is the typed-schema boundary working exactly as
designed.

The security property is not "the payment was refused" — it is "no
attacker-controlled prose survived into the decision". Class 8 now searches the
response for the injected markers. Measured: **zero leaked**, and the row reads
*"injected text stripped; decision made on facts only"*. The headline claim
holds, and now there is a test that would actually notice if it stopped holding.

## What the board says now

`attempts · input boundary · policy predicates · on chain · core-approved · ₹0 lost`

- `₹0 lost` is tied to **settlement**, which is the only thing "lost" can
  honestly mean, and a Rogue Mode run settles nothing.
- `core-approved` carries F1 and F2 in `--lien` — money committed, not moved,
  which is exactly what amber means. Not `--breach`: nothing was lost. Not
  hidden: the core should not have signed.
- `not tested` appears only when non-zero.

Runtime is **~70s**, down from 4m39s — each request costs two RPC round-trips,
and 60 structuring payments made the run unwatchable. 12 slices still cross the
cap.

## Also done in this pass

### 3.1 — a held payment exists now, and it is a better beat than expected

`tier2MaxPriceBandZ` is **2** on the live PolicyModule, and `ven_signalworks` is
tier 2 with `priceBandZ 5`, so soft predicate 11 fails. Measured end to end:

```
HELD  ven_signalworks  binding=priceBand  ₹2,100  dec_bb7fb22d
decision.made HELD → payment.held → hold.released
/v1/holds showed it with expiresAtMs; /v1/hold/cancel released it
```

The amount must stay under `tier2CapMinor` (₹5,000) or predicate 12 hard-fails
first and it is REFUSED instead. Reproduce with `.run/phase5-held.sh`.

This is BUILD.md's tier-2 pitch made literal — *"anything failing a predicate
doesn't get blocked into uselessness, it gets held for you"* — and the console's
countdown ring and inline Cancel finally have real data behind them.

### 2.5 — the audit log is downloadable, and says whether it is worth trusting

A link in the console's enforcement panel. The endpoint already sent
`Content-Disposition: attachment`, so it needs no JavaScript; what was missing
was any way to reach it. Beside it: signature status, signer, digest, and the
command to check it. Verified against the live export —

```
digest matches    true
recovered signer  0xB18D311dcfA7F1700bEf8245Aa3100b3E3dAdf6B   matches true
tampered digest differs true, and recovers to a DIFFERENT address
```

### 1.5 — freeze latency is now a pair, not a zero

`{ "latencyMs": 0, "worstCaseStopMs": 15000 }`. The first is when nothing new
can be approved; the second is when spending is definitely over, because a lease
already issued stays valid until it expires. The playground states both in
words. `0ms` alone was measuring two in-memory writes and overstating the
guarantee.

### 1.1 (partial) — the placeholder digest is now labelled everywhere it appears

Not fixed — **disclosed**. `isPlaceholderDigest()` in `lib/contracts.ts` is a
shape test (any digest that is one leading byte then zeros), and both surfaces
print *"placeholder digest — the check is real, this value attests nothing"*
beside it in `--lien`. `LIMITATIONS.md` now says the same. Delete the helper the
day a real digest is registered.

## Still outstanding from Part I

> **Updated 4 Aug 2026, after Phases 5–7.** Most of the repo-side items below
> are now done. What is left is the deck, one on-chain transaction, and a
> browser.

**1.1 — the digest now exists; it is not registered.**
`apps/core/scripts/core-image-digest.mjs` produces exactly the source-tree
digest this item asked for: sha256 over the file set `apps/core/Dockerfile`
copies, 54 files, recomputable in seconds without Docker.

```
digest 0xbc770793bf876b8a2238e0448f7af5c5c5fb24c53587946da49dfd228b61c462
```

Deterministic and sensitive, both measured (`scripts/verify-digest-sensitivity.sh`).
**It is labelled a source digest everywhere it appears, never an image digest**,
and `LIMITATIONS.md` states plainly what it does not cover: not the Node
version, not the resolved dependency tree, not the base image, not that the
deployed process is running this source.

What remains is the `attestCoreImage()` transaction, and it is deliberately not
done: predicate 3 compares what the request carries against what the contract
holds, so there is **no ordering that avoids an outage** — three places have to
move together (core env, agent env, contract). `LIMITATIONS.md` has the
procedure. Between rehearsals, never on demo day. Until then the on-chain value
is the `0x01` placeholder and `isPlaceholderDigest()` keeps labelling it on
screen.

**1.2 — `novel`.** Still undecided, and now the smaller half of a bigger
question: the LLM generator has never been invoked by the UI *and* the model
reader in `extract.ts` has never run against the real API. `test/extract.test.ts`
covers the code around that call with a stubbed SDK, so a refusal, a thrown
error, non-JSON and six kinds of out-of-range amount all fall back to the parser
rather than becoming a price. That is not the same as the call working. **Set
`ANTHROPIC_API_KEY` and watch one run before claiming the model path**, and
decide `novel` at the same time.

### Repo-side items now closed

| Item | Where it landed |
|---|---|
| **3.3 Halmos** | `THREAT_MODEL.md` marks it **NOT IMPLEMENTED**; `BUILD.md`'s deck slide 5 line is struck through with the replacement written out. *"Fuzzed and differentially checked"*, never *"proven"* |
| **4.1 "2-of-3"** | `BUILD.md`'s key-split section carries a CORRECTION block, and the rehearsal line *"threshold signing instead of a co-signer"* is struck with a true replacement that is not weaker. `THREAT_MODEL.md` rewritten |
| **4.2 the 247 / 147** | Both are wrong now. The suite is **99** — structuring went from 60 slices to 12 — measured 26 input / 24 policy / 2 chain / 0 errored. Recorded in `FINALE_PROGRESS.md` |
| **FROST behind a flag** | Withdrawn in `THREAT_MODEL.md`, `LIMITATIONS.md` and `BUILD.md`. The only "frost" in the codebase is a comment at `payment.ts:5` |
| **Rate limiting on `/v1/lease/renew`** | Withdrawn; `API.md` marks the `429` as unreachable |
| **"UI only renders signed traces"** | Withdrawn. The console shows the `signatureStatus` the **core reports** — useful, and a different claim |
| **3.1 exercise a HELD payment** | Done. `scripts/verify-hold.py` — HELD ₹48 on `priceBand`, the row `/v1/holds` gives the ring and Cancel, the same decision in the audit export, and cancel releases it |

**The deck itself is still the deck.** Every correction above is written into
the repo with the replacement wording spelled out; none of it has been carried
across to the slides. That is the highest-value hour left after a browser.

---

## How this was audited

- Every ✅ row in `LIMITATIONS.md` "What Is Real" checked against the code that
  implements it.
- `BUILD.md` Part 1's feature lists for `/console` and `/playground`, item by
  item, against `apps/web/src`.
- `BUILD.md` Part 12's ship checklist, line by line.
- The five non-negotiables in `BUILD.md` Part 0.

**The five non-negotiables all hold.** No LLM in the decision path, no defence
depending on agent behaviour, fail-closed throughout, happy path first. That is
worth saying plainly before the list of problems, because the list is long and
the foundation is not the problem.

---

## TIER 1 — things we currently state that are not true

### 1.1 The attestation digest is a placeholder, and `LIMITATIONS.md` calls it a real one

`LIMITATIONS.md:36` says:

> Nitro Enclave attestation | We use reproducible-build image digest registered
> on-chain

The registered value is:

```
.env:CORE_IMAGE_DIGEST=0x0100000000000000000000000000000000000000000000000000000000000000
on-chain PolicyModule.coreImageDigest = 0x0100…0000   (measured 4 Aug)
```

That is `0x01` followed by 31 zero bytes — a hand-written constant, not the hash
of anything. Predicate 3 compares it to itself and passes. **The mechanism is
real and correct; the input attests nothing.**

This is the worst item on the list, for three reasons: it is the one claim that
sounds like hardware-grade assurance, it is printed on both surfaces with a copy
button as though it were evidence (`console/page.tsx:721`,
`playground/page.tsx` enforcement panel, and every `DecisionTrace`), and the
false version of it is in the document we wrote to be honest.

**Fix (preferred, ~1 hour + one tx).** `apps/core/Dockerfile` already exists.
Build it, take the real digest, put it in `.env`, and call `setPolicy` to
register it on-chain. Then the predicate compares a real image hash to a real
registered hash and the claim becomes true as written. Add
`apps/core/scripts/image-digest.mjs` so a judge can recompute it.

**Retract (~10 min).** If the tx is not worth it: change `.env` to
`sha256:dev-placeholder-not-an-attestation`, label it in both UIs as
*"dev placeholder — the predicate is real, this value is not"*, and rewrite
`LIMITATIONS.md:36` to say the attestation mechanism ships and the digest is a
stand-in.

Do **not** leave it as-is.

### 1.2 `novel` can never be anything but zero, and the LLM path fabricates novelty

Two separate problems behind one counter.

**(a) It is never invoked.** `playground/page.tsx` posts
`{"mode":"deterministic"}` to `/v1/adversary/run`. `runner.py:60` only calls
`run_generator` when `mode == "full"`. So the LLM generator has never run from
the UI, and `novel` is structurally 0. `BUILD.md:795` requires *"LLM variant
generator logs novel techniques"*; `FINALE.md`'s mock shows `9 novel`.

**(b) If it did run, the novelty is a label.**
`apps/agents/adversary/generator.py:83-110` asks the LLM for a technique *name*,
then ignores it and fires one of four hardcoded boundary FactSheets — and
`return`s inside the loop after the first. So every "novel technique" is the same
probe wearing a different LLM-generated name, marked `novel=True`.

**Fix.** Either (i) add a "run with LLM variants" control that posts
`mode:"full"`, and make `_execute_novel_variant` actually derive its attempt from
the returned technique — or (ii) delete the `novel` counter from the strip and
the claim from the checklist. Given four days, **(ii) plus a note** is the honest
cheap option; (i) is a real feature and should not be half-done.

Right now the counter is honest-but-useless (always 0). The danger is only if
someone "fixes" it by running the generator as written.

### 1.3 The 147 conflates two different defences

Already measured, twice, in Phase 4's run:

```
FACTSHEET_INVALID    124  |
AGENT_NOT_FOUND       20  |  144 died at the input boundary
InvalidCoreSignature    1  |
DECISION_NOT_FOUND      1  |    3 reached the predicates
InvalidCoreSignature    1  |    (on-chain key mismatch)
```

The strip shows one `blocked` figure. `FINALE_PLAN.md` Phase 5 item 1 already
specifies the two-row fix. This is ~20 minutes and it makes the number *stronger*
— defence in depth, honestly labelled.

### 1.4 `library.py` can report an errored attack as blocked

`FIXLOG3.md:317`, unchanged. It did not fire in the 147 run so the current score
is real, but the path exists and inflates the board when it does fire.
`FINALE_PLAN.md` Phase 5 item 2.

### 1.5 "Freeze latency" is measured, but it measures the wrong thing

`routes/revoke.ts:30-40` computes `Date.now() - revokedAt` around two synchronous
in-memory writes. It is always `0`, and `BUILD.md:789` asks for *"freeze latency
measured and displayed"*. Reporting **0 ms** as freeze latency overstates the
guarantee.

The true answer is two numbers and we can state both: **instant** for anything
not yet co-signed (the epoch bump kills it at the next check, which is what M3
demonstrates), and **up to `LEASE_TTL_MS` (15 s)** for a lease already issued.
Measure and display that pair. It is a better claim than `0ms` because it is
survivable under questioning.

---

## TIER 2 — `BUILD.md` Part 1 features that do not exist and are not disclosed

None of these are in `LIMITATIONS.md`. That is the problem — individually they
are defensible scope cuts.

| # | `BUILD.md` claim | Reality | Proposal |
|---|---|---|---|
| 2.1 | `:45` *"Auth — email + password, session cookie. Simple, but real."* and `:806` *"Demo credentials work and are in the README"* | **No auth of any kind.** Anyone with the URL is the owner. | Disclose. Add a `LIMITATIONS.md` row. Note the mitigation that already exists: REVOKE ALL is wallet-gated, so the strongest control is not open. |
| 2.2 | `:52` *"Policy editor — caps, windows, tiers, categories. Owner-signed, bumps the policy hash."* | Not built. `setPolicy` is a contract function called by script only. | Disclose. Building an owner-signed editor in four days competes with the three moments and would lose. |
| 2.3 | `:51` *"Revoke controls — per-transaction, per-agent, and a global REVOKE ALL"* | Only global REVOKE ALL + per-hold Cancel. No per-agent revoke. | Disclose, and reword the deck. Per-hold Cancel covers the per-transaction case in spirit — say that, don't imply more. |
| 2.4 | `:46` *"Mock deposit, mock credit line"* | Neither. Console shows available / held / spent-of-window. | Disclose, or cut the sentence from the deck. Lowest value item here. |
| 2.5 | `:53` *"Audit — signed, replayable, downloadable log"* | Signed ✅ and replayable ✅ (`verify-audit.mjs`), but there is **no download button** — the console only reads `/v1/audit/export` to seed the feed. | **Fix.** This is a ~15-minute button on a real, already-signed endpoint, and it converts a "trust us" into an artifact a judge can take away. Highest value/effort ratio in Tier 2. |
| 2.6 | `:94` *"Simulation speed slider"* and `:68` *"a task that takes 4 hours completes in 6 seconds"* | Slider removed in Phase 4 (it was wired to nothing). The task-engine's `SimClock` is constructed with a hardcoded `40_000` and has no HTTP path. | Disclose the slider's removal and why. The fast clock itself is real inside the engine. |

---

## TIER 3 — claims that are true but have never been exercised

These are not lies. They are untested, and `BUILD.md` Part 12 asks for proof.

- **3.1 No held payment has ever existed.** The countdown ring, the inline Cancel
  and the "Holds inbox" are all unproven against real data, on both surfaces.
  `BUILD.md:800` asks for *"mid-settlement: lien released"*. **Fix: force one.**
  A tier-2 counterparty failing a soft predicate produces `HELD` — the
  counterfeit storefront already creates exactly that shape. One dispatch, then
  cancel it. Do this before the demo regardless of anything else on this page.
- **3.2 Guardian can revoke but cannot spend** (`BUILD.md:787`). Backend accepts
  `source:'guardian'`; nothing proves the negative half.
  **Investigated 4 Aug 2026 (`scripts/verify-guardian.py`), and it split in
  two.**
  - The **CAN** half is real and chain-enforced: `PolicyModule.sol:331` is
    owner-or-guardian for `revoke()` and every other state-changing function is
    `onlyOwner`. `contracts/test/PolicyModule.t.sol:160` exercises it.
  - The **CANNOT** half is true by construction and **still untested**. Foundry
    is not installed on this machine, so the assertion could not be written
    *and run*, and an unrun test is worse than none. Install `forge` and add it,
    or say only what `PolicyModule.sol:331` shows.
  - **A separate finding fell out of it**: the core does not authenticate the
    revoke source at all. `source` is free text on the request body, so anyone
    who can reach `/v1/revoke` can pass `"guardian"` and the SSE stream and the
    audit export will carry it. Measured: accepted with no credential. That does
    not weaken the guardian claim, which is about the chain — but **never
    present the `source` on a revocation event as evidence of who revoked**.
    Now disclosed in `LIMITATIONS.md`.
- **3.3 Halmos.** `BUILD.md:842` (deck slide 5) says *"the Halmos invariant
  output. Not tested. Proven."* There are no Halmos proofs —
  `contracts/test/Invariants.t.sol` is Foundry. `LIMITATIONS.md:188` already
  lists Halmos as a stretch goal, so the deck contradicts our own doc.
  **Fix the deck line**, and say what we actually have, which is strong: Foundry
  invariant fuzzing plus 10,000/10,000 differential agreement between the TS
  evaluator and the deployed contract.
- **3.4 `/playground` has never been rendered in a browser** (Phase 4). Stays at
  the top of the list until someone opens it.

---

## TIER 4 — wording that has drifted from what shipped

- **4.1 "2-of-3".** `BUILD.md:136` and deck slide 4 present a 2-of-3 threshold
  key split. What ships is **2-of-2 ECDSA co-signature, plus an independent owner
  EOA that can revoke on-chain**. `LIMITATIONS.md:35` discloses this correctly,
  but the deck and Part 2 do not. The shipped thing is still excellent and the
  headline sentence survives intact — *"the agent holds one share and is
  incapable of paying alone"* is true of 2-of-2. Say "two-of-two co-signature
  plus an owner key that answers to nobody", not "2-of-3 threshold".
- **4.2 `BUILD.md:32` says M2 is `247 attempts · 247 blocked`.** ~~Ours is 147.~~
  **Ours is 99**, and "blocked" is the wrong word for 47 of them. Measured
  4 Aug 2026 after the suite was fixed: 99 attempts, 52 blocked (26 at the input
  boundary, 24 by a policy predicate, 2 on chain), 47 core-approved-and-unsettled,
  0 errored. The 147 figure is itself stale — `StructuringAttack` went from 60
  slices to 12 when it was fixed, because 60 took 4m39s and ₹48,000 could never
  reach a ₹1,00,000 window cap anyway. Align the deck to **99, split by stage**;
  a single conflated total is the thing this document exists to stop.

  **And do not put a precise blocked count on a slide at all.** Run three times:
  52 / 52 / 69 blocked. Everything except class 4 is identical every run; class
  4 fires 50 concurrent same-nonce requests and the core's `usedNonces` check is
  not atomic, so how many win is a genuine race. `total` (99), `input boundary`
  (26) and `on chain` (2) are stable and can be printed. The rest cannot.
- **4.3 `BUILD.md:90`** says the counterfeit clones at **60% off**; vendorsim
  builds it at **40% of price** (`server.js:163`), i.e. 60% off. These agree —
  noted only so nobody "fixes" it.

---

## Recommended order

Four days. This is the order I'd take it in, with a cut line.

**Day 1 — the things that are actively false (Tier 1)**
1. 1.1 image digest — build the real one and register it (`~1h + 1 tx`). Retract
   if the tx is refused.
2. 1.3 the 147 breakdown (`~20m`).
3. 1.4 `library.py` errored ≠ blocked (`~20m`).
4. 1.5 freeze latency as a measured pair (`~40m`).
5. 1.2 decide: delete the `novel` counter, or build the LLM path properly.
   Default to deleting.

**Day 2 — proof and artifacts**
6. 3.1 force a held payment end to end and cancel it (`~40m`). Do not skip.
7. 2.5 audit download button (`~15m`).
8. Open `/playground` in a browser and fix what only a browser shows.

**Day 3 — disclosure**
9. One `LIMITATIONS.md` pass covering every Tier 2 row, 3.2 and 3.3.
10. Deck corrections: 4.1, 4.2, 3.3.

**Cut line.** Everything above ships. Below it, only if Phase 1 hosting, Phase 6
`injected` and Phase 7 are already done — which they are not:
- Building auth (2.1)
- Building the policy editor (2.2)
- Building per-agent revoke (2.3)
- Building the LLM adversary properly (1.2 option i)

**Sequencing note.** 2.x disclosure is cheap but must happen *after* Phase 1,
because hosting changes two of the rows (`LIMITATIONS.md` already flags this as
`FINALE_PLAN.md` Phase 5 item 4). Do the Tier 1 fixes now; batch the disclosure
pass once the deployment exists.

---

## What this plan deliberately does not do

It does not add features to make claims true. With four days and three moments
that must be undeniable, the correct move for auth, the policy editor and
per-agent revoke is to **say we didn't build them**. `BUILD.md:845` is right:
*"Judges trust teams that disclose and punish teams they catch."*

The one exception is 1.1. That claim is load-bearing for the Enforcement Layer
criterion, the fix is an hour, and the mechanism is already built — leaving a
placeholder in it is throwing away the strongest thing we have for no reason.
