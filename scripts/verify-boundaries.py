#!/usr/bin/env python3
"""What the generator's four boundary FactSheets actually do.

The LLM generator probes four edges. Three of them had never been sent — the
loop returned after the first — so when the fix let all four run and two came
back APPROVED, it was not obvious which. An APPROVED here is not automatically
a vulnerability (a cap is inclusive, so exactly-at-cap SHOULD pass) but it is
not automatically fine either, and the difference matters.

Sends each one on its own, with a fresh lease, and prints the outcome.
"""
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "agents", "adversary"))

CORE = os.environ.get("CORE_URL", "http://localhost:4000")

from library import _valid_fact_sheet, _open_session, _post  # noqa: E402

BOUNDARIES = [
    ("amount exactly at perTxCap", dict(amount_minor=2_500_000)),
    ("amount one paisa over perTxCap", dict(amount_minor=2_500_001)),
    ("amount zero", dict(amount_minor=0)),
    ("priceBandZ 127, tier 2, age 25", dict(price_band_z=127, counterparty_tier=2, counterparty_age_days=25)),
    ("nonce at uint32 max", dict(nonce=2**32 - 1)),
]


def main() -> int:
    _open_session(CORE)
    print(f"{'boundary':<34} {'outcome':<10} binding / error")
    print("-" * 78)
    for label, kwargs in BOUNDARIES:
        fs = _valid_fact_sheet(**kwargs)
        resp = _post(f"{CORE}/v1/payment/request", {"factSheet": fs})
        if "error" in resp:
            print(f"{label:<34} {'ERROR':<10} {resp['error'].get('code')}")
            continue
        outcome = resp.get("outcome", "?")
        trace = resp.get("trace") or {}
        binding = trace.get("bindingPredicate")
        soft = trace.get("softFailBitmask")
        extra = f"binding={binding}" + (f" softFail={soft}" if soft else "")
        print(f"{label:<34} {outcome:<10} {extra}")
        if outcome == "APPROVED" and kwargs.get("amount_minor") == 0:
            print("      ^ a zero-amount payment was APPROVED and co-signed. "
                  "Harmless to the balance, but it consumes a nonce and a lease.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
