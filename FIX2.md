# FIX2 — make the browser demo actually work

Backend settlement is PROVEN: two real Base Sepolia txs, money moved.
The browser flow does not work. That is the only remaining problem.

## Rules
- Never fabricate a txHash, signature, or approval. Fail closed.
- Do not touch contracts/ or src/evaluator.ts.
- Commit after every task. A crash must not cost work.
- Push to a/core-evaluator-merge only. Never main.

## Known-broken, verified by hand

BUG 1 — POST /v1/lease/renew returns 503 CORE_UNAVAILABLE because
store.issueLease() returns null. Probable cause: the core process has no
CORE_SIGNER_PRIVATE_KEY, because nothing loads .env — src/api/index.ts
never calls dotenv. FIND THE REAL CAUSE by logging the swallowed exception
inside issueLease before fixing. Then: load .env at core startup (dotenv or
node --env-file), and make the 503 body include the underlying reason so
this is never invisible again. A missing key must still fail closed.

BUG 2 — The browser POSTs /v1/agent/pair and gets 404. It is sending a
stale or hardcoded pairing code. The core prints a NEW code every restart
and pairing state is in-memory, so any hardcoded code is dead on arrival.
Fix so the demo cannot break this way: expose GET /v1/agent/pairing-code
returning the current code, and have the frontend auto-pair on load by
fetching it. If already paired and the agentId is unknown to the core,
re-pair automatically instead of failing silently.

BUG 3 — /console has no visible pairing UI. After BUG 2, add a small
"Agent connected · agt_xxxx · lease TTL" status element to /console so the
judge can see the pairing state. Do not redesign anything.

## TASK — end-to-end browser flow

Start core, vendorsim and web yourself. Drive a real browser flow if you
can; otherwise reproduce the exact sequence the frontend makes with curl:
pair -> lease -> task create -> payment request -> settle.

The Dispatch button in /playground must produce, visibly in the UI:
- a task with line items
- a decision with its predicate trace
- a settled payment showing a REAL txHash that resolves on Base Sepolia
- the wallet balance dropping to match on-chain state

Fix whatever breaks along that path. Frontend or backend, both are in scope.

Current on-chain policy (already set, do not change):
  perTxCapMinor 2500000 (Rs 25,000)  windowCapMinor 10000000
  permittedCategories 223 (all except SOFTWARE)
  PolicyModule 0x933bb10252ec2b133f28b7d5edf1d303c3384d87
  RekhaAccount 0xd65122eafeb2e6f384d0095bac7de6f662276f6c
  RekhaAccount holds Rs 5,00,000 INRx. 8 vendors registered on-chain.

## If you run out of time
Prioritise: BUG 1 > BUG 2 > one working end-to-end payment > everything else.
A single working happy path beats six half-working features.

## When done
Write FIXLOG2.md: what broke, what you fixed, the real txHash from the
browser flow, and anything still broken. Commit and push.

## UPDATE — verified by hand before this run

BUG 1 root cause CONFIRMED: the core process had no CORE_SIGNER_PRIVATE_KEY
because nothing loads .env. Running `set -a && source .env && set +a` before
`pnpm dev:core` makes /v1/lease/renew return a real signed lease.
Do NOT re-diagnose this. Just make it permanent: load .env at startup from
src/api/index.ts so a plain `pnpm dev:core` works, and surface the real
reason in the 503 body when a key is genuinely missing.

pair -> lease is now verified working end to end via curl.
Remaining work is BUG 2, BUG 3, and the end-to-end browser task.
