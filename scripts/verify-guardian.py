#!/usr/bin/env python3
"""HONESTY_PLAN 3.2 — "guardian can revoke but cannot spend".

The claim has two halves and only one of them was ever demonstrated.

  CAN revoke     proven on chain: contracts/test/PolicyModule.t.sol:160 pranks
                 the guardian and calls revoke(). PolicyModule.sol:331 is
                 `msg.sender != owner() && msg.sender != guardian -> revert`,
                 and every state-changing function other than revoke() is
                 onlyOwner. That half is real and it is enforced by the chain.
  CANNOT spend   nothing proved the negative.

This checks the negative half where it can actually be checked — against the
running core. It does NOT run the Solidity tests: forge is not installed on this
machine, so a Foundry assertion added here could not be executed, and an
unverified test is worse than none.

What it establishes, and what it exposes:
  1. a guardian-sourced revoke is accepted        (the CAN half, off-chain)
  2. nothing about that request is authenticated  (see the note it prints)
  3. spending still requires a lease + both signatures, and the guardian has
     neither — an unpaired caller cannot obtain a lease at all
"""
import json
import os
import sys
import urllib.error
import urllib.request

CORE = os.environ.get("CORE_URL", "http://localhost:4000")


def call(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        f"{CORE}{path}", data=data, method=method, headers={"content-type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"raw": body[:200]}


def main() -> int:
    _, code = call("GET", "/v1/agent/pairing-code")
    _, paired = call("POST", "/v1/agent/pair", {"pairingCode": code["pairingCode"]})
    agent_id = paired["agentId"]
    _, agent = call("GET", f"/v1/agent/{agent_id}")
    mandate_id = paired.get("mandateId") or agent.get("mandateId")

    print(f"mandate {mandate_id}\n")

    # 1. Can a caller claiming to be the guardian revoke?
    status, body = call("POST", "/v1/revoke", {"mandateId": mandate_id, "source": "guardian"})
    print(f"1 revoke as guardian     HTTP {status} epoch={body.get('epoch')} source={body.get('source')}")

    # 2. Can that same caller obtain a lease — i.e. spend?
    status, body = call("POST", "/v1/lease/renew", {"agentId": agent_id})
    err = (body.get("error") or {}).get("code")
    print(f"2 lease after revoke     HTTP {status} {err}")

    # 3. And with no pairing at all?
    status, body = call("POST", "/v1/lease/renew", {"agentId": "agt_00000000"})
    err = (body.get("error") or {}).get("code")
    print(f"3 lease, unpaired caller HTTP {status} {err}")

    # Restore, so this script does not leave the demo revoked.
    status, body = call("POST", "/v1/admin/unrevoke", {"mandateId": mandate_id})
    print(f"4 restore                HTTP {status} {body.get('message') or body.get('error')}")

    print("""
FINDING — the core does not authenticate the revoke source.
`source` is a free-text field on the request body (api/routes/revoke.ts:19).
Anyone who can reach /v1/revoke can pass "guardian", or "owner", and the event
stream and the audit trail will say so. There is no guardian key, no signature
check, no allow-list.

This is not a hole in the CLAIM — the guardian is a chain-level role and
PolicyModule enforces it properly (revoke() is owner-or-guardian; everything
else is onlyOwner). It is a hole in the core's ATTRIBUTION: the `source` on a
revocation event is unverified, and nothing should be presented as proof of who
revoked. The same is already disclosed for /console having no authentication at
all.

The on-chain negative half — a guardian cannot call setPolicy, setSigners,
setAccount, attestCoreImage or heartbeat, and cannot produce either required
signature — is NOT asserted by any test in this repo, and forge is not installed
here to add one. Either install Foundry and write it, or drop "cannot spend"
from the claim and say only what PolicyModule.sol:331 shows.
""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
