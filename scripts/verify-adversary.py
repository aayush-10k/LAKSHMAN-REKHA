#!/usr/bin/env python3
"""Phase 5.1 / 5.2 verification: run the full deterministic suite and print the
breakdown the scoreboard is supposed to render.

The number that matters is not `blocked`. It is the split — how many died at
the typed-schema boundary, how many a policy predicate refused, how many the
chain reverted, and how many we simply failed to run. A single conflated
"147 blocked" is the claim that has since been withdrawn.
"""
import collections
import json
import os
import sys
import urllib.request

CORE = os.environ.get("CORE_URL", "http://localhost:4000")
ADVERSARY = os.environ.get("ADVERSARY_URL", "http://localhost:4300")


def main() -> int:
    body = json.dumps({"mode": "deterministic", "coreUrl": CORE}).encode()
    req = urllib.request.Request(
        f"{ADVERSARY}/adversary/run", data=body,
        headers={"content-type": "application/json"},
    )
    r = json.load(urllib.request.urlopen(req, timeout=900))

    s = r["summary"]
    by = s["byStage"]
    print("summary")
    print(f"  total                 {s['total']}")
    print(f"  blocked               {s['blocked']}")
    print(f"  through               {s['through']}")
    print(f"  errored (not tested)  {s['errored']}")
    print("byStage")
    print(f"  input boundary        {by['input']}")
    print(f"  policy predicates     {by['policy']}")
    print(f"  on chain              {by['chain']}")
    print(f"  unattributed          {by['unattributed']}")

    assert s["total"] == s["blocked"] + s["through"] + s["errored"], "statuses do not sum to total"

    print("\nby revert reason")
    reasons = collections.Counter(x["revertReason"] for x in r["results"])
    for reason, n in reasons.most_common():
        print(f"  {n:>4}  {reason}")

    print("\nby class (status)")
    per = collections.defaultdict(collections.Counter)
    for x in r["results"]:
        per[x["classNumber"]][x["status"]] += 1
    for cls in sorted(per):
        print(f"  class {cls:>2}  {dict(per[cls])}")

    through = [x for x in r["results"] if x["status"] == "through"]
    if through:
        print(f"\n{len(through)} attack(s) got a core approval. Not settlement — "
              "but it is the thing the board must not hide:")
        for x in through[:5]:
            print(f"  {x['technique']}  {x['revertReason']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
