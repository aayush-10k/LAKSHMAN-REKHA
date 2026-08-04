#!/usr/bin/env python3
"""Attack class 4, directly: N concurrent payment requests carrying ONE nonce.

LIMITATIONS.md has disclosed that the core is not concurrency-safe here — all N
read `usedNonces(nonce) == false` off the chain, evaluate independently, and
most get APPROVED and co-signed. PolicyModule enforces the nonce on chain so
exactly one could ever SETTLE, which is what INV5 guarantees. But INV5 is a
property of settlement, and the core issuing N signatures for one nonce is a
different and uglier fact.

Expected after the fix: exactly ONE approval, the rest refused on predicate 6
(`nonce`) — the same predicate, and the same reason, the chain would give.
"""
import collections
import json
import os
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "agents", "adversary"))

CORE = os.environ.get("CORE_URL", "http://localhost:4000")
N = int(os.environ.get("RACE_N", "50"))

from library import _valid_fact_sheet, _open_session, _post, _next_nonce  # noqa: E402


def fire(fs):
    return _post(f"{CORE}/v1/payment/request", {"factSheet": fs})


def main() -> int:
    _open_session(CORE)

    nonce = _next_nonce()
    # Same nonce on every one. Distinct lineItemIds so nothing else dedupes them.
    sheets = [_valid_fact_sheet(nonce=nonce, amount_minor=10_000) for _ in range(N)]

    with ThreadPoolExecutor(max_workers=N) as pool:
        responses = list(pool.map(fire, sheets))

    outcomes = collections.Counter()
    bindings = collections.Counter()
    for r in responses:
        if "error" in r:
            outcomes[f"ERROR {r['error'].get('code')}"] += 1
            continue
        outcomes[r.get("outcome", "?")] += 1
        b = (r.get("trace") or {}).get("bindingPredicate")
        if b:
            bindings[b] += 1

    print(f"{N} concurrent requests, one nonce ({nonce})\n")
    for k, v in outcomes.most_common():
        print(f"  {v:>4}  {k}")
    if bindings:
        print("\nbinding predicates on the refusals:")
        for k, v in bindings.most_common():
            print(f"  {v:>4}  {k}")

    approved = outcomes.get("APPROVED", 0)
    print(f"\napproved: {approved}")
    if approved <= 1:
        print("OK — at most one signature for one nonce.")
        return 0
    print(f"STILL RACY — the core co-signed {approved} payments for a single nonce.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
