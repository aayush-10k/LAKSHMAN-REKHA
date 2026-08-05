#!/usr/bin/env python3
"""Does the LLM adversary generator actually work?

It has never run: it needs an API key and both were empty. The `novel` counter
was pulled off the scoreboard for exactly that reason, and the open question is
whether to build this properly or delete the counter for good.

Runs the adversary in `full` mode (deterministic library, then the generator)
and reports whether any novel result came back.
"""
import json
import os
import sys
import urllib.error
import urllib.request

ADVERSARY = os.environ.get("ADVERSARY_URL", "http://localhost:4300")
CORE = os.environ.get("CORE_URL", "http://localhost:4000")


def main() -> int:
    body = json.dumps({"mode": "full", "coreUrl": CORE, "maxAttempts": 3}).encode()
    req = urllib.request.Request(
        f"{ADVERSARY}/adversary/run", data=body,
        headers={"content-type": "application/json"},
    )
    try:
        r = json.load(urllib.request.urlopen(req, timeout=900))
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode()[:300])
        return 1

    s = r["summary"]
    novel = [x for x in r["results"] if x.get("novel")]
    print(f"total {s['total']}  blocked {s['blocked']}  through {s['through']}  errored {s['errored']}")
    print(f"novelTechniques reported by summary: {s.get('novelTechniques')}")
    print(f"results flagged novel:               {len(novel)}")
    for x in novel[:10]:
        print(f"  {x['technique']!r}  status={x['status']} stage={x['stage']} reason={x['revertReason']}")
    if not novel:
        print("\nNo novel variants. Either no usable key, or the generator failed.")
        print("Check the adversary log for '[adversary/generator]'.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
