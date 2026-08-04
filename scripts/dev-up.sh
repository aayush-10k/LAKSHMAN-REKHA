#!/usr/bin/env bash
# Bring the four backend services up for local verification, and report ports.
#
# Why a script and not four tool calls: `pnpm` on this machine is a broken
# wrapper (see FINALE_PROGRESS.md), and `pkill -f "tsx watch"` matches nothing
# because tsx runs as `node .../tsx/dist/cli.mjs watch <entry>`. Both cost a
# session an hour. Stop targets the entry script instead.
#
#   scripts/dev-up.sh start|stop|status|restart <svc>|anvil|stop-anvil
#
# `anvil` starts the two chains the test suite needs. Run it before
# `npx vitest run` in apps/core or 7 tests skip or fail.
set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"
LOGS="$ROOT/.devlogs"
mkdir -p "$LOGS"

port_up() { ss -ltn 2>/dev/null | grep -q ":$1 "; }

status() {
  for p in 4000 4100 4200 4300 3000; do
    if port_up "$p"; then echo "$p UP"; else echo "$p down"; fi
  done
}

start() {
  set -a; [ -f .env ] && . ./.env; set +a

  # setsid, not bare nohup. These are launched from `wsl -- bash -lc "..."`,
  # which exits immediately; nohup protects the process it starts but NOT the
  # children npx forks, so `npx tsx` came back UP on the first status check and
  # was gone by the next call. setsid puts each service in its own session so
  # nothing downstream inherits the dying shell's terminal.
  port_up 4100 || (cd "$ROOT" && setsid nohup node apps/vendorsim/src/server.js > "$LOGS/vendorsim.log" 2>&1 < /dev/null &)
  port_up 4300 || (cd "$ROOT/apps/agents/adversary" && setsid nohup python3 -u runner.py > "$LOGS/adversary.log" 2>&1 < /dev/null &)
  port_up 4000 || (cd "$ROOT/apps/core" && setsid nohup npx tsx src/api/index.ts > "$LOGS/core.log" 2>&1 < /dev/null &)
  port_up 4200 || (cd "$ROOT/apps/core" && setsid nohup npx tsx src/agent/runner.ts > "$LOGS/agent.log" 2>&1 < /dev/null &)

  for _ in $(seq 1 40); do
    if port_up 4000 && port_up 4100 && port_up 4200 && port_up 4300; then break; fi
    sleep 1
  done
  status
}

stop() {
  # Match the entry script, never "tsx watch" — that pattern matches nothing.
  pkill -f 'src/api/index.ts'      2>/dev/null
  pkill -f 'src/agent/runner.ts'   2>/dev/null
  pkill -f 'apps/vendorsim/src/server.js' 2>/dev/null
  pkill -f 'adversary/runner.py'   2>/dev/null
  pkill -f 'runner.py'             2>/dev/null
  sleep 1
  status
}

stop_anvil() {
  fuser -k 8545/tcp 2>/dev/null
  fuser -k 8546/tcp 2>/dev/null
  sleep 1
  for p in 8545 8546; do
    if port_up "$p"; then echo "$p UP"; else echo "$p down"; fi
  done
}

# The two anvil chains the test suite needs. Without them, 7 of the 147 core
# tests skip or fail — including the 10,000-input differential test, which is
# one of the two headline claims. They were skipped on this machine for weeks
# purely because `forge` and `anvil` live in ~/.foundry and that is not on PATH
# in a non-interactive shell. `command -v forge` returning nothing is NOT proof
# Foundry is missing; check ~/.foundry/bin first.
#
#   8545  plain local chain — differential.test.ts deploys PolicyModule to it
#   8546  Base Sepolia fork — the *.fork.test.ts files run against the REAL
#         deployed contracts, so this one needs network
FOUNDRY_BIN="$HOME/.foundry/bin"

anvils() {
  if [ ! -x "$FOUNDRY_BIN/anvil" ]; then
    echo "anvil not found at $FOUNDRY_BIN/anvil — install Foundry (curl -L https://foundry.paradigm.xyz | bash; foundryup)"
    return 1
  fi
  port_up 8545 || (cd "$ROOT" && setsid nohup "$FOUNDRY_BIN/anvil" --port 8545 \
    > "$LOGS/anvil-8545.log" 2>&1 < /dev/null &)
  port_up 8546 || (cd "$ROOT" && setsid nohup "$FOUNDRY_BIN/anvil" \
    --fork-url https://sepolia.base.org --port 8546 \
    > "$LOGS/anvil-8546.log" 2>&1 < /dev/null &)
  # The fork needs to pull state before it answers; 8545 is instant.
  for _ in $(seq 1 40); do
    if port_up 8545 && port_up 8546; then break; fi
    sleep 1
  done
  for p in 8545 8546; do
    if port_up "$p"; then echo "$p UP"; else echo "$p down"; fi
  done
}

# Restart ONE service by port.
#
# Do not reach for `pkill -f 'src/api/index.ts'` from a `wsl -- bash -lc "..."`
# one-liner: the pattern matches the invoking shell's own command line and
# kills it (exit 15). Inside this file it would be safe, because this file's
# command line is `bash scripts/dev-up.sh`, but fuser is unambiguous and works
# either way.
restart() {
  case "${1:-}" in
    core)      fuser -k 4000/tcp 2>/dev/null ;;
    vendorsim) fuser -k 4100/tcp 2>/dev/null ;;
    agent)     fuser -k 4200/tcp 2>/dev/null ;;
    adversary) fuser -k 4300/tcp 2>/dev/null ;;
    *) echo "restart core|vendorsim|agent|adversary"; return 2 ;;
  esac
  sleep 2
  start
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) restart "${2:-}" ;;
  anvil) anvils ;;
  stop-anvil) stop_anvil ;;
  *) status ;;
esac
