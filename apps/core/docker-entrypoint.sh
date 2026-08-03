#!/bin/sh
# Starts the adversary runner beside the core.
#
# runner.py imports `library` and `generator` by plain name with its own
# directory on sys.path, so it has to be started from that directory — running
# it as `python3 apps/agents/adversary/runner.py` from /app fails on the import,
# which is the same class of failure FIXLOG3 BUG 5 records.
set -e

cd /app/apps/agents/adversary
python3 -u runner.py &

# The core is the container's main process: if it exits, the container exits.
#
# If the ADVERSARY dies the core keeps serving and `POST /v1/adversary/run`
# returns 503 naming the failure — Rogue Mode reports a dead runner rather than
# inventing a score (FIXLOG3.md:189). That is the honest degradation, so it is
# deliberately not fatal here.
cd /app/apps/core
exec node --import tsx/esm src/api/index.ts
