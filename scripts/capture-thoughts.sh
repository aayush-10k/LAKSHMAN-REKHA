#!/usr/bin/env bash
# Print the agent.thought narrative for one dispatch, as a judge reads it on
# /playground. Attaches to the core's SSE stream first, then dispatches.
#
#   scripts/capture-thoughts.sh <mode> ["task description"]
set -u
MODE=${1:-normal}
DESC=${2:-"buy 200 black tamper caps"}
CORE=${CORE_URL:-http://localhost:4000}
AGENT=${AGENT_URL:-http://localhost:4200}

curl -sN "$CORE/v1/events" > /tmp/rekha-sse.txt 2>/dev/null &
SSE=$!
sleep 1

python3 - "$AGENT" "$MODE" "$DESC" <<'PY'
import json, sys, urllib.request, urllib.error
agent, mode, desc = sys.argv[1], sys.argv[2], sys.argv[3]
body = json.dumps({"description": desc, "mode": mode}).encode()
req = urllib.request.Request(f"{agent}/dispatch", data=body,
                             headers={"content-type": "application/json"})
try:
    urllib.request.urlopen(req, timeout=180).read()
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()[:200])
PY

sleep 1
kill $SSE 2>/dev/null

python3 - <<'PY'
import json
for line in open("/tmp/rekha-sse.txt"):
    if not line.startswith("data:"):
        continue
    try:
        ev = json.loads(line[5:])
    except Exception:
        continue
    if ev.get("t") == "agent.thought":
        print("·", ev["text"])
    elif ev.get("t") == "decision.made":
        tr = ev.get("trace") or {}
        print(f"  => {ev.get('outcome')}  binding={tr.get('bindingPredicate')}")
PY
