#!/usr/bin/env python3
"""Phase 5 item 3: prove the off-chain revoke can be cleared WITHOUT a restart,
and that leases work again afterwards.

Sequence:
  1. pair, take a lease                       -> should succeed
  2. POST /v1/revoke                          -> frozen, epoch bumped
  3. take a lease                             -> should now FAIL
  4. POST /v1/admin/unrevoke                  -> cleared, epoch restored to chain
  5. take a lease                             -> should succeed again, at the
                                                 chain's epoch (not the bumped one)

Step 5's epoch is the one that matters. Un-freezing while leaving the local
epoch ahead of the chain would issue leases that pass every core predicate and
then revert StaleRevocationEpoch at settlement.
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
        f"{CORE}{path}", data=data, method=method,
        headers={"content-type": "application/json"},
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


def pair():
    _, code = call("GET", "/v1/agent/pairing-code")
    _, paired = call("POST", "/v1/agent/pair", {"pairingCode": code["pairingCode"]})
    return paired["agentId"], paired.get("mandateId")


def lease(agent_id):
    status, body = call("POST", "/v1/lease/renew", {"agentId": agent_id})
    if status == 200:
        return f"OK   epoch={body['revocationEpoch']} leaseId={body['leaseId']}"
    return f"FAIL HTTP {status} {body.get('error', {}).get('code')} — {body.get('error', {}).get('message', '')[:70]}"


def main() -> int:
    agent_id, mandate_id = pair()
    if not mandate_id:
        _, m = call("GET", f"/v1/agent/{agent_id}")
        mandate_id = m.get("mandateId")
    print(f"agent   {agent_id}\nmandate {mandate_id}\n")

    print(f"1 lease before revoke   {lease(agent_id)}")

    status, body = call("POST", "/v1/revoke", {"mandateId": mandate_id})
    print(f"2 revoke                HTTP {status} epoch={body.get('epoch')} "
          f"worstCaseStopMs={body.get('worstCaseStopMs')}")

    print(f"3 lease after revoke    {lease(agent_id)}")

    status, body = call("POST", "/v1/admin/unrevoke", {"mandateId": mandate_id})
    if status == 200:
        print(f"4 unrevoke              HTTP {status} epoch={body.get('epoch')} — {body.get('message')}")
    else:
        print(f"4 unrevoke              HTTP {status} {body.get('error', {}).get('code')} — "
              f"{body.get('error', {}).get('message')}")

    print(f"5 lease after unrevoke   {lease(agent_id)}")

    _, mandate = call("GET", f"/v1/mandate/{mandate_id}")
    print(f"\nfinal  frozen={mandate.get('frozen')} revocationEpoch={mandate.get('revocationEpoch')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
