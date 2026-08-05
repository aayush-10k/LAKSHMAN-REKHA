#!/usr/bin/env bash
# Which vendor does the planner choose for a given phrase?
#
# /v1/task/create builds the plan and emits task.started. It does NOT request a
# lease, a decision or a settlement, so this costs nothing on chain and can be
# run as often as needed.
set -u
CORE=http://localhost:4000

probe() {
  local desc="$1"
  curl -s -X POST "$CORE/v1/task/create" \
    -H 'content-type: application/json' \
    -d "{\"mode\":\"normal\",\"description\":$(printf '%s' "$desc" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
plan = d.get('plan') or []
if not plan:
    print(f'  {\"$desc\"[:40]:42} EMPTY  {d.get(\"note\",\"\")[:60]}')
else:
    for i in plan:
        print(f'  {\"$desc\"[:40]:42} {i[\"vendorId\"]:18} {i[\"categoryCode\"]:12} qty={i.get(\"quantity\",\"?\"):<7} est=Rs{i[\"estimatedAmountMinor\"]/100:,.2f}')
" 2>/dev/null || echo "  $desc -> parse failed"
}

echo "TIER 1 = ven_meridian(PACKAGING) ven_northstar(LOGISTICS) ven_papertrail(CONTENT)"
echo "TIER 3 = ven_flashcart ven_adblaze ven_pixelvault"
echo
probe "order 100 bottles"
probe "order 3 amber glass bottles"
probe "order 100 amber glass bottles"
probe "order 200 black tamper caps"
probe "ship 40 crates to Pune"
probe "ship 12 national parcels"
probe "send 40 kg by cold chain dispatch"
probe "book 5000 ad impressions for launch week"
probe "buy a search campaign for launch week"
probe "renew our creative suite subscription"
probe "buy 2 product label design packs"
probe "buy inference credits for the month"
