# FIXLOG2 — autonomous fix run against FIX2.md

Branch: `a/core-evaluator-merge`. BUG 1, BUG 2, BUG 3 and the end-to-end browser
task are all done. Two bugs FIX2.md did not list were found on the way and are
recorded below. Nothing was skipped; what is still broken is in the last section.

---

## THE HEADLINE: the Dispatch button now settles on Base Sepolia

Driven from Chrome, against a core and an agent started with a plain
`pnpm dev:core` / `pnpm dev:agent` — no `source .env` anywhere — and a browser
whose `localStorage` had been cleared first, so pairing started from zero.

Task: **"Order 60 amber bottles for the winter run"**

| | |
|---|---|
| Line item | `ven_meridian` · PACKAGING · ₹5,760.00 |
| Decision | **APPROVED**, 11 predicates, binding predicate none |
| txHash | [`0x35025de91d5f92d76165358ebab92bf94dc8b05ab7bfd9971eb3b061f12c7e90`](https://sepolia.basescan.org/tx/0x35025de91d5f92d76165358ebab92bf94dc8b05ab7bfd9971eb3b061f12c7e90) |
| Block | 44959341, `status: success`, gas 131,616 |
| Event | `PaymentExecuted(counterparty 0x8A3F…e1f2, amountMinor 576000)` |
| Balance in the UI | **₹4,72,196.00** |

Re-read afterwards through a client that had never seen the API response
(`node apps/core/scripts/verify-tx.mjs <txHash>`):

```
INRx before 47795600
INRx after  47219600
moved       576000 minor
```

47,219,600 minor is ₹4,72,196.00 — the number the topbar shows, to the paisa.

An earlier browser run in the same session settled
[`0x1ed0242aee4b863ca20b09999d2d4cd2d6d3b24ac8cceea949c0cd3f64a4df96`](https://sepolia.basescan.org/tx/0x1ed0242aee4b863ca20b09999d2d4cd2d6d3b24ac8cceea949c0cd3f64a4df96)
(block 44959201, ₹9,520, INRx 49029200 → 48077200).

Refusals were checked too, because a demo that only ever approves proves nothing:

| Task | Vendor | Outcome | Binding predicate | Settlement |
|---|---|---|---|---|
| Buy 2 million inference tokens | `ven_cloudharbor` (tier 2) | REFUSED | `perTxCap` (780,000 > tier2Cap 500,000) | none |
| Advertising campaign, 5000 impressions | `ven_signalworks` (tier 2) | HELD | `priceBand` (\|z\|=5 > 2) | none |

---

## BUG 1 — .env was never loaded

Confirmed as FIX2.md described, not re-investigated.

**Fixed.** `apps/core/src/env.ts` loads `apps/core/.env` then the repo-root
`.env` using `node:util.parseEnv` — no dotenv dependency. It is the *first*
import in `src/api/index.ts`, which matters: `api/chain.ts` pins
`BASE_SEPOLIA_RPC` in a module-scope const, so loading any later would silently
use the default RPC.

A variable already in the environment always wins over the file. Docker, CI and
`set -a && source .env` must keep overriding it, and a file quietly clobbering an
operator's explicit key is how a demo ends up signing with the wrong one.

**And made visible.** `store.issueLease()` now returns a reason instead of
`null`, and logs the signing exception it used to swallow:

```
$ curl -s -XPOST localhost:4001/v1/lease/renew -d '{"agentId":"agt_a97cd32c"}'
{"error":{"code":"CORE_UNAVAILABLE","message":"Could not issue lease: No core
signing key is configured (set CORE_SIGNER_PRIVATE_KEY, e.g. in .env).",
"cause":"NO_CORE_KEY"}}
503
```

That is a real core booted with a deliberately malformed key. It still fails
closed — no lease, no signature — it just says why now. Startup warns as well,
and `/health` reports `coreKey`, `leaseTtlMs` and which `.env` files were applied.

Plain `pnpm dev:core`:

```
[env] .../apps/core/.env: applied 9 variable(s) (AGENT_SIGNER_PRIVATE_KEY, ...)
{"ok":true,"coreKey":true,"leaseTtlMs":15000,"envFilesLoaded":[...]}
```

---

## BUG 2 — the browser sent a dead pairing code

`/console` POSTed `{"pairingCode":"------"}` and dropped the 404 with the comment
`// will fail, we need init endpoint`. No page was ever paired. It could not have
worked: the core mints a new code on every boot and holds pairing state in
memory, so any remembered code — hardcoded or cached — dies at the next restart.

**Core.** `GET /v1/agent/pairing-code` returns the code this process is currently
offering; `GET /v1/agent/:agentId` answers whether an agentId is still known, so
a 404 there is an unambiguous "core restarted, pair again" signal.

**Frontend.** `apps/web/src/lib/pairing.ts` caches only the agentId, re-checks it
on every load, and pairs afresh with the *current* code when the core does not
recognise it. `renewLease()` re-pairs once and retries on a 404 rather than
failing silently. The agent runner does the same from its side.

Verified in Chrome against a core that had restarted since the page last loaded:
`GET pairing-code 200 → POST pair 201 → POST lease/renew 200`, repeating.

One decision worth naming: serving the pairing code over an unauthenticated GET
is a demo affordance, not a security position. Pairing hands out a share of a
mandate. A real deployment shows the code to an authenticated owner in the
console and never over an open endpoint. It is commented as such in the route.

---

## BUG 3 — no visible pairing state

A chip in the existing topbar language, on `/console` and `/playground`:

```
Agent connected · agt_4f1559c4 · lease 15.0s
Pairing…
Not paired — <the core's own reason>
```

The failure state is as legible as the success state, which is the point: with
nothing on screen, BUG 2 looked exactly like a working demo. The lease figure
comes from the live `lease.tick` stream. Nothing else was redesigned.

---

## Found on the way — not in FIX2.md

### The SSE stream had no CORS headers

Every page on `:3000` logged `Access to resource at
'http://localhost:4000/v1/events' … blocked by CORS policy`. `@fastify/cors`
adds its headers in an `onSend` hook, but the SSE route never reaches `onSend` —
it writes to `reply.raw` and calls `flushHeaders()` itself. So the one endpoint
the entire live UI is built on was the one endpoint with no CORS headers: no
feed, no decision panel, no lease ring, no settlement notification, anywhere.
Fixed by setting the headers on the raw response.

### The reported balance could be a real settlement's *pre-payment* figure

The first successful dispatch returned a genuine txHash whose money had genuinely
moved — and a `balanceAfterMinor` identical to the balance before it.
`https://sepolia.base.org` is a load balancer: reading `balanceOf` at `latest`
straight after `waitForTransactionReceipt` can hit a node that does not have the
block yet. A wrong number presented as fact. Balance reads after settlement are
now pinned to the receipt's block number and retried while the node catches up;
if they still fail, the API and both pages say **unavailable** rather than
substituting a plausible figure.

---

## The end-to-end task

The Dispatch button POSTed `/v1/task` — a route that does not exist; the real one
is `/v1/task/create` — and even that only emitted `task.started`. Nothing asked
for a lease, built a FactSheet, requested a decision or settled. There was no
code path by which a task could produce a trace, a txHash or a balance change.

**The agent is now a real process.** `apps/core/src/agent/runner.ts`, started
with `pnpm dev:agent`, listening on `:4200`:

```
pair → /v1/task/create → registry lookup → /v1/lease/renew
     → /v1/payment/request → agent signature → /v1/payment/settle
```

It is a separate process on purpose. The security claim is 2-of-2: the core holds
one key share, the agent the other, and neither can move money alone. If the core
built both halves that claim would be theatre. The agent signature is computed in
the runner from `AGENT_SIGNER_PRIVATE_KEY`, by rebuilding the `PaymentRequest`
from the lease and the FactSheet — the core never calls `agentSign()` on a
request path. See the limitation about the shared `.env` below.

**The policy now mirrors the chain.** `readDeployedPolicy()` reads all of
PolicyModule and `store.seedPolicy()` applies it at boot and after every
settlement. The hardcoded constants had drifted badly — they said perTxCap
₹10,000 and "OTHER only" while the chain says ₹25,000 and everything-but-SOFTWARE
— so the evaluator was refusing payments the chain would have accepted, on a
policy nobody was enforcing. The spend counters are seeded too: settling advances
`windowSpentMinor` on chain, and an off-chain zero makes predicates 13 and 14
*looser* than the contract's, which is the one direction that produces an
APPROVED trace followed by a revert.

**The balance is the chain's.** `/v1/wallet/balance` and `payment.settled` report
RekhaAccount's INRx balance on Base Sepolia. It used to be an in-memory ₹50,000
that the core decremented itself: the console's headline figure moved when a
payment settled but had never had any relationship to the money on chain.

---

## Deliberate changes to existing behaviour

**`LEASE_TTL_MS` 5000 → 15000.** PolicyModule reverts `LeaseExpired` when
`block.timestamp > req.leaseExpiry`, and the lease is issued *before* the
request, the ceremony and the Base Sepolia broadcast. A full browser dispatch
measures ~5–6s, so 5000 left roughly zero headroom and one slow block reverts the
payment. FIXLOG.md records a 5s lease surviving a settlement, and that was true
for `e2e-settle.ts`, which does less work between issuing the lease and
broadcasting than the browser flow does.

This weakens a product claim and should be read as such: the fail-closed
guarantee is now "kill the core and spending stops within **15s**", not 5. It is
one env variable, the reasoning is written into `.env.example`, and the UI reads
the value from the core rather than assuming — the ring and the "renews every Ns"
caption are both driven by `leaseTtlMs`.

**A chain read can no longer clear a local freeze.** `seedPolicy()` runs after
every settlement; assigning `frozen` straight from the chain would silently
un-revoke a mandate revoked off-chain. It now only ever *adds* a freeze. Found
because a stray `POST /v1/revoke` froze the demo mandate mid-run — the fail-closed
behaviour was correct, but it exposed the hazard.

---

## Still broken

**Three judge controls point at routes that do not exist.** Verified by probing
the running core:

```
404  POST /v1/admin/kill          ← "☠ Kill Approval Service"
404  POST /v1/task/inject         ← "Inject" (agent's world)
404  POST /v1/vendorsim/counterfeit ← "🏪 Spawn Counterfeit Storefront"
```

All three are wrapped in `.catch(() => {})`, so they fail silently and the UI
pretends they worked — "Kill Approval Service" greys itself out and shows "Core
is offline" while the core is fine, and "Spawn Counterfeit Storefront" pops an
alert describing something that did not happen. The vendorsim *does* implement
`POST /vendorsim/spawn-counterfeit` and `POST /vendorsim/inject` on `:4100`; the
frontend is calling the core for them. Out of FIX2.md's scope, but they are worse
than missing features because they misreport.

**The behaviour modes do nothing.** `mode` is passed all the way through to
`createTask` and validated, but the runner ignores it: hallucinating, injected,
compromised, overreach and colluding all execute the same honest path. No
`attack.attempt` event is emitted anywhere in the codebase, so the Rogue Mode
Scoreboard is permanently 0/0/0/₹0. It reads as "zero attacks got through" when
it means "no attack was attempted".

**Both key shares live in one `.env` on this machine.** The runner is a separate
process and the code paths are genuinely separate — the core's request handling
never touches the agent share — but the deployment is not. A real one gives the
agent service its own secret store. Named here because the 2-of-2 argument is
only as good as the weakest of the two, and on this laptop that is the file.

**An off-chain revoke needs a core restart to undo.** In-memory mandate state is
lost anyway on restart, and the button says "Irreversible", so this is by design
— but the UI offers no path back and a judge who clicks it will think the demo
broke.

**`buildAuditExport()` still returns `signature: '0x' + '00'.repeat(32)`** with
the comment "real sig from A's signing service". The audit export is unsigned.

**The three fork test files need an anvil node on `127.0.0.1:8546`.**
`differential`, `execute.fork` and `hash-request.fork` fail with ECONNREFUSED
without one. The other 79 tests pass:

```
Test Files  3 failed | 4 passed (7)
     Tests  79 passed | 7 skipped (86)
```

`hash-request.fork.test.ts` is the canary for the signing digest — it was not run
in this session, so the digest agreement with the deployed contract rests on the
five settlements that actually landed rather than on that test.

**The window cap will stop a demo that runs long enough.** ₹1,00,000 per rolling
day, of which the current window has already spent ₹27,804 (`windowSpentMinor`
2780400, window opened at 1785672478). Repeated dispatches will eventually REFUSE
on `windowCap`. That is the policy working, but a judge should know before it
happens rather than after.

---

## Running it

```
pnpm dev:vendorsim   # :4100  vendor registry
pnpm dev:core        # :4000  core API + SSE
pnpm dev:agent       # :4200  agent runner (the other key share)
pnpm dev:web         # :3000  console + playground
```

No `source .env` step. Open `/playground`, type a task, press Dispatch.
`node apps/core/scripts/verify-tx.mjs <txHash>` re-reads any settlement from
Base Sepolia through an independent client.
