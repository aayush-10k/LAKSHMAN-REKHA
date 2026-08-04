#!/usr/bin/env python3
"""Exercise a HELD payment and check every field the console's hold UI reads.

HELD is the one outcome of the three that had never been produced by a real
dispatch, so amber — and the entire inline Cancel affordance on /console — was
untested against real data. It is reachable because the soft predicates only run
for registryTier 2, and ven_cloudharbor sits at priceBandZ 7 against a
tier2MaxPriceBandZ of 2.

Checks, in order:
  1. dispatch something that lands on a tier-2 vendor  -> HELD
  2. GET /v1/holds                                     -> the row the ring reads
  3. GET /v1/audit/export                              -> the same decision, so a
                                                          refresh does not blank it
  4. POST /v1/hold/cancel                              -> gone from /v1/holds

Step 3 is the one that has bitten before: the two boot reads each created the
same row and the loser's data was dropped, so a held row rendered with no ring,
no Cancel button and Rs 0 in the held total.
"""
import json
import os
import sys
import urllib.error
import urllib.request

CORE = os.environ.get("CORE_URL", "http://localhost:4000")
AGENT = os.environ.get("AGENT_URL", "http://localhost:4200")
TASK = os.environ.get("HOLD_TASK", "buy 3 CPU worker hours")


def call(method, url, payload=None, timeout=180):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method=method, headers={"content-type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"raw": body[:300]}


def main() -> int:
    status, body = call("POST", f"{AGENT}/dispatch", {"description": TASK, "mode": "normal"})
    if status != 200:
        print(f"dispatch failed HTTP {status}: {body}")
        return 1
    if body.get("note"):
        print(f"no plan: {body['note']}")
        return 1

    held = [r for r in body.get("results", []) if r["outcome"] == "HELD"]
    for r in body.get("results", []):
        print(f"1 dispatch          {r['outcome']:<9} Rs {r['amountMinor']/100:>10,.2f}  "
              f"{r['vendorId']:<16} binding={r.get('bindingPredicate')}")
        tr = r.get("trace") or {}
        if tr.get("summary"):
            print(f"                    {tr['summary']}")
        if tr.get("softFailBitmask") is not None:
            print(f"                    softFailBitmask={tr['softFailBitmask']}")

    if not held:
        print("\nNothing was HELD. Soft predicates only run for registryTier 2 — "
              "pick a task that routes to ven_cloudharbor or ven_signalworks.")
        return 1

    decision_id = held[0]["decisionId"]

    _, holds = call("GET", f"{CORE}/v1/holds")
    rows = holds.get("holds", [])
    print(f"\n2 GET /v1/holds     {len(rows)} row(s)")
    mine = [h for h in rows if h.get("decisionId") == decision_id]
    for h in mine:
        # These three are exactly what the console needs: the amount for the
        # hero total, expiresAtMs for the countdown ring, decisionId for Cancel.
        print(f"                    decisionId={h['decisionId']} "
              f"amountMinor={h.get('amountMinor')} expiresAtMs={h.get('expiresAtMs')}")
    if not mine:
        print("                    MISSING — the ring and Cancel have nothing to read")
        return 1

    _, doc = call("GET", f"{CORE}/v1/audit/export")
    export = doc.get("body", doc)
    decisions = [d for d in export.get("decisions", []) if d.get("decisionId") == decision_id]
    print(f"\n3 audit export      signatureStatus={doc.get('signatureStatus')} "
          f"decisions={len(export.get('decisions', []))}")
    if decisions:
        d = decisions[0]
        print(f"                    same decision present, outcome={d.get('outcome')} "
              f"binding={d.get('bindingPredicate')} predicates={len(d.get('predicates', []))}")
    else:
        print("                    MISSING — a refresh would blank this row")
        return 1

    status, cancelled = call("POST", f"{CORE}/v1/hold/cancel", {"decisionId": decision_id})
    print(f"\n4 cancel            HTTP {status} {json.dumps(cancelled)[:120]}")

    _, after = call("GET", f"{CORE}/v1/holds")
    still = [h for h in after.get("holds", []) if h.get("decisionId") == decision_id]
    print(f"                    still held after cancel: {len(still)} "
          f"({'OK' if not still else 'STILL THERE — cancel did nothing'})")
    return 0 if not still else 1


if __name__ == "__main__":
    sys.exit(main())
