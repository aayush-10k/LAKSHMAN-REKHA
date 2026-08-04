"""
B8 — LLM Adversary Variant Generator

Reads the attack log and generates NOVEL variants at runtime.
Cap: 200 attempts total. Cache identical prompts.
The deterministic library ALWAYS runs first — this is a bonus layer only.

Requires OPENAI_API_KEY or ANTHROPIC_API_KEY. Falls back gracefully if not set.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.request
import urllib.error
from typing import Any, Callable

# runner.py and test_library.py both import this module by plain name, with the
# directory on sys.path — so a relative import here made `python3 runner.py` die
# on "attempted relative import with no known parent package" before it could
# bind a socket. The adversary runner had therefore never started at all.
# Absolute first, matching the rest of the package; relative kept as the fallback
# for `from apps.agents.adversary import generator`.
try:
    from library import AttackResult, _valid_fact_sheet, _post, _classify, _emit_attempt, _now, _next_nonce
except ImportError:  # pragma: no cover - package-style import
    from .library import AttackResult, _valid_fact_sheet, _post, _classify, _emit_attempt, _now, _next_nonce

EventSink = Callable[[dict[str, Any]], None]

MAX_ATTEMPTS = int(os.environ.get("ADVERSARY_MAX_ATTEMPTS", "200"))
_prompt_cache: dict[str, str] = {}


def _provider() -> tuple[str, str] | None:
    """
    Which API we can actually reach, as (provider, key).

    This used to be `OPENAI_API_KEY or ANTHROPIC_API_KEY`, and then it sent
    whichever it found to `api.openai.com` as a Bearer token with model
    `gpt-4o-mini`. An Anthropic key down that path is a **401 Unauthorized**,
    every time — measured, once a real key was finally available. So the
    fallback was never a fallback: it made the generator *look* configured while
    guaranteeing it produced nothing.
    """
    anthropic = os.environ.get("ANTHROPIC_API_KEY")
    if anthropic and anthropic.strip():
        return ("anthropic", anthropic.strip())
    openai = os.environ.get("OPENAI_API_KEY")
    if openai and openai.strip():
        return ("openai", openai.strip())
    return None


def _post_json(url: str, payload: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers={"content-type": "application/json", **headers}
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())


def _llm_generate_variant(attack_log: list[AttackResult], provider: str, api_key: str) -> str | None:
    """
    Ask the LLM to name a novel attack technique, given what has already been
    blocked. Returns the technique name, or None if the call did not produce one.

    Only the NAME comes from the model. The attempt itself is the fixed set of
    boundary FactSheets in `_execute_novel_variant` — the model chooses a label
    for a probe the code decides. That is a real limitation and it is why the
    `novel` counter was pulled from the scoreboard; do not present a
    model-authored string as a model-authored attack.
    """
    blocked_techniques = [r.technique for r in attack_log if r.blocked]

    prompt = (
        "You are a security researcher testing a payment enforcement system. "
        f"The following techniques have been blocked: {blocked_techniques[:10]}. "
        "Generate ONE novel attack technique name and a brief description (1 sentence). "
        "Focus on timing, encoding, state manipulation, or threshold boundary attacks. "
        'Respond with JSON only: {"technique": "name", "description": "one sentence"}'
    )

    # Cache on provider too, so switching keys does not serve a stale answer.
    cache_key = hashlib.sha256(f"{provider}:{prompt}".encode()).hexdigest()[:16]
    if cache_key in _prompt_cache:
        return _prompt_cache[cache_key]

    try:
        if provider == "anthropic":
            # Haiku deliberately: BUILD.md asks for the cheapest fast model on
            # the adversary loop, which fires hundreds of calls.
            result = _post_json(
                "https://api.anthropic.com/v1/messages",
                {
                    "model": "claude-haiku-4-5-20251001",
                    "max_tokens": 200,
                    "messages": [{"role": "user", "content": prompt}],
                },
                {"x-api-key": api_key, "anthropic-version": "2023-06-01"},
            )
            blocks = [b for b in result.get("content", []) if b.get("type") == "text"]
            content = blocks[0]["text"] if blocks else ""
        else:
            result = _post_json(
                "https://api.openai.com/v1/chat/completions",
                {
                    "model": "gpt-4o-mini",
                    "messages": [{"role": "user", "content": prompt}],
                    "response_format": {"type": "json_object"},
                    "max_tokens": 150,
                },
                {"Authorization": f"Bearer {api_key}"},
            )
            content = result["choices"][0]["message"]["content"]

        # Models wrap JSON in prose or fences often enough that finding the
        # object is worth doing rather than failing the whole variant on it.
        start, end = content.find("{"), content.rfind("}")
        if start == -1 or end <= start:
            print(f"[adversary/generator] no JSON object in the reply: {content[:120]!r}")
            return None
        data = json.loads(content[start : end + 1])

        technique = str(data.get("technique") or "").strip()
        if not technique:
            return None
        _prompt_cache[cache_key] = technique
        return technique
    except urllib.error.HTTPError as exc:
        # Loud, and it names the provider. The 401 that hid this bug for weeks
        # was printed as a bare "LLM call failed".
        body = exc.read().decode()[:200] if hasattr(exc, "read") else ""
        print(f"[adversary/generator] {provider} HTTP {exc.code}: {body}")
        return None
    except Exception as exc:
        print(f"[adversary/generator] {provider} call failed: {exc}")
        return None


def _execute_novel_variant(core_url: str, technique_name: str, emit: EventSink) -> AttackResult:
    """
    Attempt a novel variant attack. The actual attempt is a creative combination
    of boundary conditions — the core should block it regardless.
    """
    # Novel variants try boundary-edge FactSheets
    variant_sheets = [
        # Boundary: amount at exactly the cap
        _valid_fact_sheet(amount_minor=2_500_000),  # exactly perTxCap
        # Boundary: priceBandZ at edge
        _valid_fact_sheet(price_band_z=127, counterparty_tier=2, counterparty_age_days=25),
        # Boundary: nonce near overflow
        _valid_fact_sheet(nonce=2**32 - 1),
        # Boundary: zero amount
        _valid_fact_sheet(amount_minor=0),
    ]

    # ALL of them, not just the first.
    #
    # This loop used to `return result` at the end of its first iteration, so
    # three of the four boundary probes were dead code: the priceBandZ edge, the
    # nonce near uint32 overflow and the zero amount were never once sent. Only
    # "amount exactly at perTxCap" ever ran, and the scoreboard counted that one
    # attempt as the whole novel variant.
    #
    # The interesting one is the LAST result, not the first: if any boundary
    # gets through, that is the finding, and returning early hid three quarters
    # of the surface this function exists to poke at.
    results: list[AttackResult] = []
    for fs in variant_sheets:
        resp = _post(f"{core_url}/v1/payment/request", {"factSheet": fs})
        status, stage, reason = _classify(resp)
        result = AttackResult(
            technique=technique_name,
            class_number=None,  # type: ignore[arg-type]
            blocked=status == "blocked",
            revert_reason=reason,
            novel=True,
            status=status,
            stage=stage,
        )
        _emit_attempt(emit, result)
        results.append(result)

    if not results:
        # Nothing ran, so nothing was defended. This used to say blocked=True.
        return AttackResult(
            technique=technique_name,
            class_number=None,  # type: ignore[arg-type]
            blocked=False,
            revert_reason="NOT TESTED — no variant executed",
            novel=True,
            status="errored",
            stage=None,
        )

    # Report the worst outcome across the boundaries, so one probe getting
    # through is never averaged away by three that did not.
    for wanted in ("through", "errored"):
        for r in results:
            if r.status == wanted:
                return r
    return results[-1]


def run_generator(
    core_url: str,
    attack_log: list[AttackResult],
    emit: EventSink,
    max_attempts: int = MAX_ATTEMPTS,
) -> list[AttackResult]:
    """
    Generate LLM-driven novel attack variants.
    Cap: max_attempts total across the whole run.
    Deterministic library must run first (enforced by caller in runner.py).

    If no API key is available, logs a warning and returns empty list.
    """
    chosen = _provider()
    if chosen is None:
        print("[adversary/generator] No API key — skipping LLM variants. Deterministic library covers the scoreboard.")
        return []
    provider, api_key = chosen
    print(f"[adversary/generator] using {provider}")

    results: list[AttackResult] = []
    attempt_count = 0

    while attempt_count < max_attempts:
        technique = _llm_generate_variant(attack_log + results, provider, api_key)
        if not technique:
            break

        result = _execute_novel_variant(core_url, technique, emit)
        results.append(result)
        attack_log.append(result)  # update log so next generation is different
        attempt_count += 1
        time.sleep(0.5)  # avoid rate-limiting

    return results
