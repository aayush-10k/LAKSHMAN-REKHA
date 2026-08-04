#!/usr/bin/env python3
"""Structuring, fast: many payments inside ONE lease window, summing past the cap.

This is the version of attack class 1 that could actually take money. The
adversary library's version paces itself — two RPC round-trips per slice — so
leases lapse between slices, and a payment whose lease has lapsed can never
settle (leaseExpiry is predicate 5, enforced on chain). Those approvals are
void, and the core releasing their reservations is correct.

The dangerous version is the one that fits inside a single 15s lease, because
every one of those signatures is live at the same moment. That is what this
fires.

Expected after reserve-on-approve: approvals stop once the cumulative total
would cross windowCap, and the refusals bind on `windowCap` — the same predicate
PolicyModule would revert with.
"""
import collections
import json
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "agents", "adversary"))

CORE = os.environ.get("CORE_URL", "http://localhost:4000")

from library import _valid_fact_sheet, _open_session, _post, _next_nonce  # noqa: E402


def headroom(agent_id: str) -> tuple[int, int]:
    """
    The mandate's own window figures.

    `/v1/policy` does not exist — an earlier version of this script asked for it,
    got a 404, and silently fell back to `spent = 0`. That reported "headroom
    10,000,000" against a real 4,963,200 and made correct enforcement look like
    over-refusal. Read it from the mandate, and fail loudly rather than guess.
    """
    with urllib.request.urlopen(f"{CORE}/v1/agent/{agent_id}", timeout=10) as r:
        mandate_id = json.load(r)["mandateId"]
    with urllib.request.urlopen(f"{CORE}/v1/mandate/{mandate_id}", timeout=10) as r:
        m = json.load(r)
    return int(m["windowCapMinor"]), int(m["windowSpentMinor"])


def main() -> int:
    session = _open_session(CORE)
    agent_id = session.get("agentId") if isinstance(session, dict) else None
    if not agent_id:
        print("could not open a session; run scripts/dev-up.sh start first")
        return 2
    cap, spent = headroom(agent_id)
    left = max(0, cap - spent)

    # Eight slices, each an eighth of the remaining headroom plus a bit, so the
    # cumulative crosses the cap partway through rather than at the last one.
    n = 8
    slice_minor = max(1, (left // 6) + 1)
    print(f"windowCap {cap}  spent {spent}  headroom {left}")
    print(f"firing {n} x {slice_minor} = {n * slice_minor} in parallel, inside one lease\n")

    sheets = [_valid_fact_sheet(amount_minor=slice_minor, nonce=_next_nonce()) for _ in range(n)]

    with ThreadPoolExecutor(max_workers=n) as pool:
        responses = list(pool.map(lambda fs: _post(f"{CORE}/v1/payment/request", {"factSheet": fs}), sheets))

    outcomes, bindings = collections.Counter(), collections.Counter()
    for r in responses:
        if "error" in r:
            outcomes[f"ERROR {r['error'].get('code')}"] += 1
            continue
        outcomes[r.get("outcome", "?")] += 1
        b = (r.get("trace") or {}).get("bindingPredicate")
        if b:
            bindings[b] += 1

    for k, v in outcomes.most_common():
        print(f"  {v:>3}  {k}")
    if bindings:
        print("\nbinding predicates:")
        for k, v in bindings.most_common():
            print(f"  {v:>3}  {k}")

    approved = outcomes.get("APPROVED", 0)
    total_approved = approved * slice_minor
    print(f"\napproved {approved} x {slice_minor} = {total_approved}  (headroom was {left})")
    if total_approved <= left:
        print("OK — the core did not co-sign past its own window.")
        return 0
    print("STILL OVER — the core co-signed more than the window allows.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
