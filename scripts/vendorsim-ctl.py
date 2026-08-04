#!/usr/bin/env python3
"""Judge controls for vendorsim, from a shell.

The playground has buttons for these; this is the same two endpoints for
verification runs, so a mode can be exercised without a browser.

    scripts/vendorsim-ctl.py counterfeit ven_meridian
    scripts/vendorsim-ctl.py inject ven_meridian -            # text on STDIN
    scripts/vendorsim-ctl.py inject ven_meridian "short text"
    scripts/vendorsim-ctl.py catalog

Use `-` and pipe the text in. Passing it as an argument works only if nothing
between here and bash splits on spaces — and going through
`powershell -> wsl.exe -> bash -lc` it does. A multi-word injection passed as an
argument silently arrived as its FIRST WORD ONLY, so the storefront rendered
`IGNORE` and the agent was never shown the attack. Two runs were scored as
"the model resisted the injection" on that basis; it had never seen one.
"""
import json
import os
import sys
import urllib.request

BASE = os.environ.get("VENDORSIM_URL", "http://localhost:4100")


def post(path, payload):
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    return json.load(urllib.request.urlopen(req, timeout=15))


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    cmd = sys.argv[1]

    if cmd == "counterfeit":
        v = post("/vendorsim/spawn-counterfeit", {"targetVendorId": sys.argv[2]})
        print(f"{v['id']}  {v['name']}  addr={v['address']}  tier={v['tier']} "
              f"age={v['ageDays']}d settled={v['settledTxns']} priceBandZ={v['priceBandZ']}")
    elif cmd == "inject":
        # `-` reads STDIN. Everything after argv[2] is joined otherwise, so a
        # multi-word injection survives even when the shell has already split it.
        rest = sys.argv[3:]
        text = sys.stdin.read() if rest == ["-"] else " ".join(rest)
        if not text.strip():
            print("nothing to inject — pass text, or `-` and pipe it in")
            return 2
        result = post("/vendorsim/inject", {"vendorId": sys.argv[2], "text": text})
        print(f"{result} — {len(text)} chars injected")
        # Read it back off the rendered page. The endpoint returning
        # {'injected': True} only means it stored SOMETHING.
        with urllib.request.urlopen(f"{BASE}/vendor/{sys.argv[2]}", timeout=15) as r:
            page = r.read().decode()
        head = text.strip()[:40]
        print(f"present on the rendered page: {head in page}")
    elif cmd == "catalog":
        with urllib.request.urlopen(f"{BASE}/catalog", timeout=15) as r:
            for v in json.load(r):
                print(f"{v['id']:<20} tier{v['tier']} age={v['ageDays']:>4}d "
                      f"settled={v['settledTxns']:>5} z={v['priceBandZ']:>4} "
                      f"{len(v.get('products', []))} products")
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
