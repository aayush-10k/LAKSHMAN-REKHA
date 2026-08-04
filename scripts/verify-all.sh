#!/usr/bin/env bash
# Everything that can be checked without a browser and without an owner
# transaction, in one run. Prints real output; asserts nothing it did not
# measure.
#
# Needs the stack up: scripts/dev-up.sh start
#
# What this does NOT cover, and no amount of running it will:
#   - how any page LOOKS. Nothing here renders anything
#   - the Claude reader in extract.ts against the real API (no key set)
#   - the Docker images (Docker is not installed)
#   - the 7 fork tests (need anvil on 8546)
set -u
cd "$(dirname "$0")/.."

rule() { printf '\n══ %s %s\n' "$1" "$(printf '─%.0s' $(seq 1 $((60 - ${#1}))))"; }

rule "typecheck"
(cd apps/core && npx tsc --noEmit) && echo "core  exit 0" || echo "core  FAILED"
(cd apps/web  && npx tsc --noEmit) && echo "web   exit 0" || echo "web   FAILED"

rule "unit tests"
(cd apps/core && npx vitest run --reporter=dot 2>&1 | tail -4)
echo "-- task-engine --"
(cd apps/agents/task-engine && node --test 2>&1 | grep -E '^# (tests|pass|fail)')
echo "-- adversary --"
(cd apps/agents/adversary && python3 test_library.py 2>&1 | tail -3 | head -2)

rule "core image digest"
node apps/core/scripts/core-image-digest.mjs

rule "chain state"
set -a; [ -f .env ] && . ./.env; set +a
node apps/core/scripts/chain-state.mjs 2>/dev/null \
  | grep -E '"(frozen|revocationEpoch|permittedCategories|windowSpentMinor|windowCapMinor|_deployerEth|coreImageDigest)"' \
  || echo "chain unreadable — check .env and the RPC"

rule "services"
bash scripts/dev-up.sh status

rule "behaviour modes (settles real money)"
bash scripts/verify-modes.sh normal hallucinating overreach colluding injected

rule "held payment"
python3 scripts/verify-hold.py

rule "revoke / unrevoke"
python3 scripts/verify-unrevoke.py

rule "hallucination sizing"
python3 scripts/verify-hallucination-sizing.py

rule "landing page"
bash scripts/verify-landing.sh

rule "adversary suite"
python3 scripts/verify-adversary.py

printf '\n══ done %s\n' "$(printf '─%.0s' $(seq 1 55))"
echo "NOT covered: how anything looks, the model reader, the Docker images,"
echo "the 7 fork tests. See FINALE_PROGRESS.md 'Still open'."
