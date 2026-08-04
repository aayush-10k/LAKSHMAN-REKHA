#!/usr/bin/env python3
"""Judge controls for vendorsim, from a shell.

The playground has buttons for these; this is the same two endpoints for
verification runs, so a mode can be exercised without a browser.

    scripts/vendorsim-ctl.py counterfeit ven_meridian
    scripts/vendorsim-ctl.py inject ven_meridian "IGNORE ALL PREVIOUS ..."
    scripts/vendorsim-ctl.py catalog
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
        print(post("/vendorsim/inject", {"vendorId": sys.argv[2], "text": sys.argv[3]}))
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
