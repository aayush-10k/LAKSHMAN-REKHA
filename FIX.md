# FIX SPEC — autonomous run, InnovaHack submission day

You are fixing the Lakshman Rekha monorepo. Work autonomously to completion.
Branch: a/core-evaluator-merge (already checked out).

## Absolute rules

1. NEVER fabricate a transaction hash, block number, or signature. If a real
   one cannot be produced, return an error. Fail closed.
2. NEVER let an error path produce an APPROVED outcome or a settlement.
3. Do not commit .env or any private key. .env.example only.
4. Do not push to main. Push only to a/core-evaluator-merge.
5. Do not delete apps/core/src/api/mock-evaluator.ts. It is the rollback.
6. If a task would take more than ~25 minutes or requires a decision you
   cannot verify, SKIP it, keep going, and record it in FIXLOG.md.
   Partial delivery beats a broken repo.

## Reference material

- BUILD.md, docs/API.md — the spec. Do not change frozen interfaces.
- apps/core/test/execute.fork.test.ts — WORKING code that calls
  RekhaAccount.execute() with agent+core signatures. Reuse it. Do not
  re-derive request construction or signing.
- apps/core/src/signing/ — buildPaymentRequest, hashRequest, coreSign.

## Deployed contracts (Base Sepolia, chainId 84532)

INRx          0x9df2d451d682971878d09ba13920ca418697272d
PolicyModule  0x933bb10252ec2b133f28b7d5edf1d303c3384d87
RekhaAccount  0xd65122eafeb2e6f384d0095bac7de6f662276f6c
Core signer   0xB18D311dcfA7F1700bEf8245Aa3100b3E3dAdf6B
Agent signer  0x6E19cA2B53986EAEeE638412A4051651a64a00d5

---

## TASK 1 — make the repo compile (do first, blocks everything)

- `pnpm install` at the root.
- apps/core/src/types.ts (B's) is missing CATEGORY_INDEX, which
  src/signing/request.ts imports. Copy the CATEGORY_INDEX const from
  ~/projects/rekha-contracts/ts-evaluator/src/types.ts into
  apps/core/src/types.ts. Do NOT overwrite the file — B's version has
  RekhaEvent and ApiError that the other does not.
- evaluator.ts, explain.ts, keys.ts, index.ts were just copied into
  apps/core/src/. Reconcile any type conflicts between A's and B's
  definitions of MandateState / DecisionTrace / FactSheet. Where they
  differ, docs/API.md is authoritative.
- Fix apps/core/package.json: the test script is wrong. Tests are vitest
  in test/, not node:test in src/. Add vitest as a devDependency and set
  "test": "vitest run".
- Exit condition: `pnpm exec tsc --noEmit` clean in apps/core, and
  `pnpm test` runs the suite (fork tests may fail without RPC — note it,
  don't delete them).

## TASK 2 — real on-chain settlement (HIGHEST VALUE)

Currently apps/core/src/api/store.ts settleDecision() fabricates a txHash
with randomBytes(32) and a random block number. Nothing ever calls
RekhaAccount.execute(). The product's central claim — that every approved
payment is a real, explorer-verifiable transaction — is therefore false.

Fix POST /v1/payment/settle in apps/core/src/api/routes/payment.ts:

- Build the PaymentRequest with buildPaymentRequest() from
  src/signing/request.ts. DELETE the duplicated inline tuple currently in
  payment.ts — one construction path only.
- Core signature via coreSign(). Agent signature from the request body.
- Broadcast with a viem walletClient to RekhaAccount.execute(). Wait for
  the receipt. Return the REAL txHash and blockNumber.
- On revert: decode the custom error name and return 422 with that name in
  the ApiError body. A revert is a SUCCESSFUL demo outcome — it is what
  the judge is meant to see. Never a 500, never a swallowed exception.
- settleDecision() keeps updating balance and window state but must take
  the real txHash as a parameter and no longer generate one.
- If CORE_SIGNER_PRIVATE_KEY or REKHA_ACCOUNT_ADDRESS is unset, return
  503 CORE_UNAVAILABLE. No fallback to a fake hash under any condition.
- Check RekhaAccount's INRx balance. If zero, mint to it using
  DEPLOYER_PRIVATE_KEY and note the tx in FIXLOG.md.

Verify end to end: start the core, POST a payment through request then
settle, and confirm the returned hash resolves on Base Sepolia. Record the
hash in FIXLOG.md. If you cannot get a real hash, revert this task
entirely and say so — a fake hash is worse than no settlement.

## TASK 3 — use the real evaluator (only if TASK 2 succeeded)

payment.ts imports evaluate() from './mock-evaluator.js'. Switch it to
'../evaluator.js' (A's, verified 10,000/10,000 against the Solidity).
Write a thin adapter if the signatures differ — do NOT refactor B's routes.
If the demo breaks, revert this one line and record it. Keep the mock file.

## TASK 4 — frontend routing

apps/web/src/app/page.tsx is a 463-line inlined HTML prototype injected
via dangerouslySetInnerHTML. Replace the entire file with a redirect to
/console using next/navigation. Delete nothing else.

## TASK 5 — honesty pass

- README.md: delete the phrase "(if any part still uses it)".
- LIMITATIONS.md currently claims "Real token, real transfers on Base
  Sepolia". If TASK 2 succeeded, leave it. If TASK 2 failed or was
  skipped, rewrite that row to: "Settlement is simulated; contract
  enforcement is verified by test against the deployed contract, not by
  live broadcast." This must be accurate. It is the file judges use to
  decide whether to trust the rest.

---

## When done

Write FIXLOG.md: every task attempted, its outcome, the real txHash if you
got one, everything skipped and why, and anything you inferred rather than
verified. Then commit in small conventional commits and push to
a/core-evaluator-merge. Do not open a PR. Do not touch main.
