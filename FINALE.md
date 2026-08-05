# FINALE.md — Frontend Rebuild for the 8 Aug Grand Finale

**Read `BUILD.md` Part 11, `docs/API.md`, and `docs/journal/FIXLOG3.md` before starting.**

> **Status note added 2026-08-04.** This is the original brief. It is still the
> authority on *design* — Parts 1, 2, 5 and 6 are adopted verbatim. Its Part 3
> *priority order* has been superseded by `docs/journal/FINALE_PLAN.md`, which moves hosting
> from P3 to first (the demo must run from one deployed URL with nothing local)
> and drops the `permittedCategories` concern (measured on chain: it is 223, not
> 128 — `PACKAGING` settles fine). Where the two disagree, `docs/journal/FINALE_PLAN.md` wins.

---

## PART 0 — WHAT CHANGED, AND WHY IT MATTERS

Round 2 was judged **asynchronously** — a tired person opening a URL alone.
The Finale is a **live demo in front of a panel.** That flips three things:

| | Round 2 | Finale |
|---|---|---|
| Hosting | mandatory | **optional** — you run it on your own laptop |
| Setup friction | fatal | you're driving, so it's fine |
| Visual polish | nice to have | **decides the score** |
| Explaining | impossible | you get to narrate |

So the localhost problem largely evaporates. What's left is that the UI is bare,
and on a projector that reads as "they didn't finish."

**The engineering is done and it is strong.** 86/86 tests, 10000/10000
differential agreement, three verified contracts, a real settlement on-chain,
working mid-ceremony revoke, working kill switch. None of that is visible right
now. This document is entirely about making it visible.

### The three moments everything serves

Every hour goes to these. If a task doesn't strengthen one, it's P3.

- **M1** — agent alone, with its key share and full network, tries to pay → on-chain
  revert. *"It isn't blocked. It's incapable."*
- **M2** — Rogue Mode scoreboard running live, counters climbing, `₹0 lost`
- **M3** — signing ceremony bar at 60%, hit REVOKE, the bar **breaks**

---

## PART 1 — DESIGN SYSTEM

`BUILD.md` Part 11 already specifies this. Follow it exactly — don't redesign,
and don't let Claude Code drift toward a generic dark SaaS dashboard.

### Tokens

```css
--ink:    #0B0D14;   /* base — near-black with blue in it */
--slate:  #161A26;   /* raised surfaces */
--chalk:  #EDEAE3;   /* the line, primary text — warm, never pure white */
--lien:   #F0A202;   /* HELD state only */
--clear:  #3DD68C;   /* SETTLED state only */
--breach: #FF4D4D;   /* REFUSED / REVOKED only */
```

**Six values. No seventh.** No blues, no purples, no gradients, no glass-morphism.

**Colour is semantic, never decorative.** Amber means money is held. Green means
money moved. Red means something was stopped. If a colour appears where it
doesn't mean its state, delete it. This single rule is what separates this from
every other dark dashboard a judge will see that day.

### Type

- **Display** — Bricolage Grotesque, tight condensed weights. Section heads and
  the balance figure only. Used sparingly.
- **Body** — Geist.
- **Data** — Geist Mono. Every rupee amount, hash, address, predicate name,
  latency figure, block number.

Amounts always monospace, **tabular numerals on, right-aligned.** That one
detail is what makes an interface read as financial software rather than a
project.

```css
font-variant-numeric: tabular-nums;
```

### The signature element — the Rekha

A single 1px `--chalk` line drawn as a closed boundary around the agent's
activity zone in `/playground`. Always present, always quiet.

- **Idle** — static, 40% opacity
- **Payment approved** — nothing. The line doesn't celebrate.
- **Attack blocked** — the line **flares** at the point of contact: a short
  `--breach` pulse travelling ~200px along the path, then settling back to chalk
  over 600ms
- **Mid-ceremony revoke** — the line **snaps**: a visible break at the top edge,
  the two ends recoiling, holding broken for 2s before healing

This is the one animated idea in the product and it carries the name. Build it as
an SVG path with `stroke-dasharray` animation, not a CSS border.

### Motion budget — three things, total

1. The Rekha
2. The lease TTL ring (ambient, always draining and renewing — the UI has a pulse)
3. The ceremony progress bar

Counters increment without bouncing. No page transitions. No scroll reveals. No
hover lift on cards. **Restraint is what stops this reading as AI-generated** —
a judge who has seen twenty dark dashboards that day notices the one that isn't
trying.

### Copy rules

- Name things by what the person controls: **Cancel payment**, not *Void transaction*
- Errors state what happened and what to do, in plain language:
  *"Refused — vendor is 2 days old. Vendors in this tier need 30. Nothing was charged."*
- Never apologise in an error. Never use the word "error" in user-facing text.
- Empty feed: *"No payments yet. Give your agent a task in the Playground."*
  Not *"No data"*.
- Buttons keep their name through the flow: **Revoke** produces *"Revoked"*.

---

## PART 2 — SCREEN SPECS

### `/console` — the owner's control room

Full width. Not a phone frame — you're presenting on a projector and a phone
mockup wastes two-thirds of the screen.

```
┌──────────────────────────────────────────────────────────────────────┐
│  ₹40,600           ⊙ lease 11s      ● core up        [ REVOKE ALL ]  │
│  available          held ₹3,760      spent today ₹9,400              │
├────────────────────────────────────┬─────────────────────────────────┤
│  TRANSACTIONS                      │  DECISION                       │
│                                    │                                 │
│  ● ₹9,400   Meridian Packaging     │  Approved.                      │
│    settled · 380ms · 0xfc29…       │  ₹9,400 to Meridian Packaging   │
│                                    │  — known vendor, within all     │
│  ◐ ₹3,760   Novo Supplies          │  caps.                          │
│    held · 47s left    [Cancel]     │                                 │
│                                    │  ┌─ predicate chain ──────────┐ │
│  ○ ₹49,990  Vertex Media           │  │ agentSignature      ✓      │ │
│    refused · PerTxCapExceeded      │  │ coreSignature       ✓      │ │
│                                    │  │ coreImage           ✓      │ │
│                                    │  │ revocationEpoch  7=7 ✓     │ │
│                                    │  │ leaseExpiry     +3.2s ✓    │ │
│                                    │  │ …                          │ │
│                                    │  │ perTxCap   940000≤2500000 ✓│ │
│                                    │  └────────────────────────────┘ │
│                                    │  policy 0x4c1b… image sha256:9f│ │
├────────────────────────────────────┴─────────────────────────────────┤
│  PolicyModule 0x933b…  RekhaAccount 0xd651…  INRx 0x9df2…   ↗ Basescan│
└──────────────────────────────────────────────────────────────────────┘
```

**Details that matter:**

- Balance in Bricolage Grotesque, ~72px, tabular. It's the hero.
- Feed rows: 4px left border in the state colour. Settled green, held amber,
  refused red. Nothing else coloured.
- Held rows carry a countdown **ring**, not a bar, and the Cancel button sits in
  the row — no modal.
- Clicking a row loads it in the decision panel. **This panel is your Key-2
  feature** and it's what a judge will ask about — every predicate, its inputs,
  expected vs actual, and the binding one highlighted.
- Bottom strip is always visible. Contract addresses with live Basescan links.
  Judges click these.
- Every settled row links to its transaction hash on Basescan.

### `/playground` — where the agent works and the judge attacks

```
┌──────────────┬──────────────────────────────────┬───────────────────┐
│ TASK         │ ╭────── the rekha ─────────────╮ │ ENFORCEMENT       │
│              │ │                              │ │                   │
│ [Order 100   │ │  VENDOR PAGE (iframe)        │ │  ⊙  lease 11.4s   │
│  bottles   ] │ │                              │ │                   │
│  [Dispatch]  │ │  Meridian Packaging          │ │  ● core up        │
│              │ │  500ml glass · ₹94/unit      │ │  sha256:9f2c…     │
│ ─────────    │ │                              │ │                   │
│ MODE         │ │  [Spawn counterfeit]         │ │  ⛓ PolicyModule   │
│ ○ normal     │ │  [Inject text: ________ ]    │ │  0x933b… ↗        │
│ ○ halluc.    │ │                              │ │  epoch 7          │
│ ● injected   │ ├──────────────────────────────┤ │                   │
│ ○ compromised│ │  agent reasoning…            │ │  [ Kill core ]    │
│ ○ overreach  │ │  › checking Meridian stock   │ │                   │
│ ○ colluding  │ │  › quote ₹9,400              │ │  CEREMONY         │
│              │ │  › requesting payment        │ │  ▓▓▓▓▓▓░░░  2/3   │
│ ─────────    │ ╰──────────────────────────────╯ │  [ REVOKE ]       │
│ sim speed ▬▬ │                                  │                   │
├──────────────┴──────────────────────────────────┴───────────────────┤
│  ROGUE MODE      147 attempts   147 blocked   9 novel   ₹0 lost      │
│  ───────────────────────────────────────────────────────────────────│
│  structuring          blocked   WindowCapExceeded                    │
│  lease replay         blocked   NonceAlreadyUsed                     │
│  rail bypass          blocked   InvalidCoreSignature                 │
└──────────────────────────────────────────────────────────────────────┘
```

**Details that matter:**

- The Rekha is drawn around the centre panel. It's the containment boundary made
  literal — that's the whole product in one visual.
- `₹0 lost` is the **largest number on the page**, in `--clear`. Larger than the
  attempt count.
- Attack log scrolls newest-at-top, each row showing technique and the real
  revert reason from the core.
- The ceremony bar and REVOKE button sit **side by side** so M3 is one gesture.
- Judge controls (`Spawn counterfeit`, `Inject text`) sit *on the vendor page*,
  not in a settings drawer. The judge should find them without being told.

---

## PART 3 — PRIORITY ORDER

> **Superseded by `docs/journal/FINALE_PLAN.md`.** Hosting was P3 here; it is now first,
> because the demo must run from one deployed URL with nothing local. The
> `library.py` and 147-breakdown items below are unchanged and still required.

### P0 — the three moments must be undeniable

1. **Rogue Mode scoreboard** (M2). Four counters, animated increment, scrolling
   attack log with real revert reasons. `₹0 lost` dominant.
2. **Ceremony bar + REVOKE** (M3). Three segments, ~1200ms each. On
   `ceremony.aborted` the bar must **visibly break** — segments shatter, the
   Rekha snaps. Not just stop.
3. **Agent-alone panel** (M1). A "Detach core" control, then the agent's failed
   attempt shown with the on-chain revert reason and a Basescan link.
4. **Decision panel.** Predicate chain, binding one highlighted, plain-English
   summary from the core (never generated client-side).

### P1 — honesty fixes

5. **Break down the 147.** Your own report notes 144 died at
   `FACTSHEET_INVALID` / `AGENT_NOT_FOUND` — the input boundary, not the 14
   predicates. Show it as two rows:
   ```
   blocked at input boundary    144
   blocked by policy predicates   3
   ```
   That's a *stronger* slide, not a weaker one. Defence in depth, honestly
   labelled. A judge who discovers the conflation themselves is a judge you've
   lost.
6. **Fix `library.py`** so an errored attack class reports as `errored`, never
   `blocked`.
7. **Settlement headroom.** 10s against a 15s lease is thin. Either raise
   `LEASE_TTL_MS` for the demo profile or trim `CEREMONY_ROUND_MS` to 900. A
   lease expiring mid-demo is the worst possible failure.

### P2 — wire the remaining modes

Four of six mode buttons still change only a label. Each maps to a defence you
can already demonstrate:

| Mode | Behaviour | What it proves |
|---|---|---|
| `hallucinating` | invented vendor IDs, wrong quantities, duplicate line items | caps + tier catch model error |
| `injected` | vendor page carries hidden instructions, agent complies | the FactSheet boundary |
| `overreach` | tier upgrades, extras nobody asked for | category + scope |
| `colluding` | registers a vendor it controls, pays itself | attribute predicates |

`injected` is the highest value — it's the one that pairs with the counterfeit
storefront and it's your pitch's headline threat.

### P3 — hosting and polish

Host core/agent/vendorsim on Railway if it's easy. For a live demo it's a
convenience, not a requirement. Do this last.

---

## PART 4 — CLAUDE CODE PROMPTS

Work on a branch: `git checkout -b finale/frontend`. Commit freely — that's local
and reversible. Push only once you've confirmed the between-rounds commit rule
with the organisers.

### Prompt 1 — design system

```
Read BUILD.md Part 11 and FINALE.md Part 1. Build the design system for
apps/web before touching any page.

1. Tailwind config: the six tokens exactly as specified. No seventh colour.
   Bricolage Grotesque (display), Geist (body), Geist Mono (data) via next/font.
2. A <Rekha> component: SVG closed path with stroke-dasharray animation.
   Three states — idle (static, 40% opacity), flare (breach pulse travelling
   ~200px along the path then settling over 600ms), snap (visible break at the
   top edge, ends recoiling, held broken 2s then healing). Driven by props.
3. An <Amount> component: renders integer paise as ₹ with Indian digit grouping
   (₹1,00,000 not ₹100,000), Geist Mono, tabular-nums, right-aligned.
4. A <TTLRing> component: SVG ring that drains over lease TTL and refills on
   renewal. Ambient, subtle.
5. A <Counter> component that animates on increment without bouncing.

Rules: colour is semantic only — lien for held, clear for settled, breach for
refused/revoked, nothing else uses them. Respect prefers-reduced-motion with
non-animated fallbacks. No gradients, no glass effects, no hover lift.

Do not build any page yet. Just these primitives with a demo route showing all
states side by side, so I can review them before you build on top.
```

### Prompt 2 — console

```
Read FINALE.md Part 2. Rebuild apps/web/src/app/console/page.tsx to the console
spec, using only the design-system primitives from the previous step.

Layout: top bar (balance in Bricolage ~72px, lease ring, core status, REVOKE
ALL), left 60% transaction feed, right 40% decision panel, bottom strip with
the three contract addresses and Basescan links.

Feed rows: 4px left border in the state colour. Held rows carry a countdown ring
and an inline Cancel button — no modal. Clicking a row loads it into the
decision panel.

Decision panel: the plain-English summary comes from the core's trace.summary —
never generate text client-side. Below it, the full predicate table (name,
inputs, expected, actual, passed) with the binding predicate highlighted. Show
policyHash and coreImageDigest with copy buttons.

Every settled row links to https://sepolia.basescan.org/tx/{txHash}.

REVOKE ALL calls PolicyModule.revoke() directly from the user's wallet via
wagmi. It must NOT go through the core API — that independence is a scored
criterion, so do not "simplify" it.

All state comes from the SSE stream. No polling. When the core is unreachable,
render an honest panel saying so with the contract links still visible — never
a silent failure, never an empty catch block.
```

### Prompt 3 — playground and the three moments

```
Read FINALE.md Parts 2 and 3. Rebuild apps/web/src/app/playground/page.tsx.

Three columns plus a bottom scoreboard strip, per the ASCII layout in Part 2.

The <Rekha> wraps the centre panel. Wire it to the SSE stream:
- attack.attempt with blocked:true → flare
- ceremony.aborted → snap
- payment.settled → nothing. The line does not celebrate.

Rogue Mode scoreboard: four counters. Split "blocked" into two rows —
"blocked at input boundary" and "blocked by policy predicates" — because
conflating them overstates the claim. "₹0 lost" must be the largest number on
the page, in --clear.

Ceremony bar: three segments driven by ceremony.round events, ~1200ms each,
with the REVOKE button directly beside it. On ceremony.aborted the bar must
visibly BREAK, not just stop.

Judge controls sit on the vendor page itself: "Spawn counterfeit storefront"
and an "Inject text into this page" field. Point them at NEXT_PUBLIC_VENDORSIM_URL.
Surface the real HTTP response. On failure show the error — never a success state
for something that did not happen.

Add a "Detach core" control that stops the core co-signing, so the agent-alone
attempt can be demonstrated, and show the resulting on-chain revert reason with
a Basescan link.

No empty catch blocks anywhere. Every failure is a visible state.
```

### Prompt 4 — modes

```
Wire the four unwired behaviour modes in apps/core/src/agent/runner.ts.

Modes change ONLY the system prompt and thin tool wrappers — the same agent
binary runs in all six. A judge should be able to see we did not build six
different agents.

- hallucinating: invented vendor IDs, wrong quantities, occasional duplicate
  line items
- injected: browse() returns pages containing hidden instructions; the agent
  has no special defence and WILL follow them. Do not make it resist — the
  point is that enforcement does not need it to.
- overreach: adjacent unauthorised work — tier upgrades, extras nobody asked for
- colluding: registers a vendor it controls and routes payment to it

Each must produce a legible narrative in the agent.thought stream. A judge
watching should understand what the agent is doing without reading code.

Start with `injected` — it pairs with the counterfeit storefront and it is the
headline threat in our pitch.
```

---

## PART 5 — WHAT NOT TO DO

- **Don't restyle toward a generic dark SaaS dashboard.** Six colours, semantic
  only. If Claude Code adds a blue accent or a gradient, remove it.
- **Don't add features.** The build is feature-complete for the pitch. Every hour
  goes into making existing things visible.
- **Don't touch `contracts/`.** Deployed, verified, and the strongest part of the
  submission.
- **Don't add a string field to `FactSheet`.** Not for a tooltip, not for a
  vendor name in the UI — fetch display names separately.
- **Don't hide the 147 breakdown.** The honest version is a better slide.
- **Don't push to `main`** until you've confirmed the commit rule with the
  organisers. Branch and commit locally; the work is safe either way.

---

## PART 6 — REHEARSE THESE

Say them until they're natural. On a live panel, the words carry as much as the
screen.

> *"The agent isn't blocked from paying. It's incapable of paying. It holds one
> share of a key that never exists in one place."*

> *"The scam is written in English, aimed at an AI. The component that approves
> payments cannot read English. There's no channel for it to arrive through."*

> *"Our infrastructure failing is indistinguishable from the kill switch firing.
> There is no failure mode where money keeps moving."*

> *"We just revoked a transaction that hadn't finished being created. The
> signature doesn't exist and never will."*

> *"Ten thousand random inputs through both the TypeScript evaluator and the
> Solidity contract. Zero divergences."*

And the one that will win you more credibility than any feature:

> *"144 of those were stopped at the input boundary, before the policy engine
> ever saw them. Only 3 reached the predicates. Both layers are real, and we'd
> rather show you the breakdown than the headline."*
