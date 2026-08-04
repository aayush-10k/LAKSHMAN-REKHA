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


def _llm_generate_variant(attack_log: list[AttackResult], api_key: str) -> str | None:
    """
    Ask the LLM to generate a novel attack technique based on the attack log.
    Returns a description of the technique, or None if unavailable.
    """
    blocked_techniques = [r.technique for r in attack_log if r.blocked]
    allowed_techniques = [r.technique for r in attack_log if not r.blocked]

    prompt = (
        f"You are a security researcher testing a payment enforcement system. "
        f"The following techniques have been blocked: {blocked_techniques[:10]}. "
        f"Generate ONE novel attack technique name and a brief description (1 sentence). "
        f"Focus on timing, encoding, state manipulation, or threshold boundary attacks. "
        f"Respond with JSON: {{\"technique\": \"name\", \"description\": \"one sentence\"}}"
    )

    cache_key = hashlib.sha256(prompt.encode()).hexdigest()[:16]
    if cache_key in _prompt_cache:
        return _prompt_cache[cache_key]

    try:
        payload = json.dumps({
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": prompt}],
            "response_format": {"type": "json_object"},
            "max_tokens": 150,
        }).encode()

        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=payload,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode())
            content = result["choices"][0]["message"]["content"]
            data = json.loads(content)
            technique = data.get("technique", "novel variant")
            _prompt_cache[cache_key] = technique
            return technique
    except Exception as exc:
        print(f"[adversary/generator] LLM call failed: {exc}")
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
        return result  # Return after first attempt

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
    api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("[adversary/generator] No API key — skipping LLM variants. Deterministic library covers the scoreboard.")
        return []

    results: list[AttackResult] = []
    attempt_count = 0

    while attempt_count < max_attempts:
        technique = _llm_generate_variant(attack_log + results, api_key)
        if not technique:
            break

        result = _execute_novel_variant(core_url, technique, emit)
        results.append(result)
        attack_log.append(result)  # update log so next generation is different
        attempt_count += 1
        time.sleep(0.5)  # avoid rate-limiting

    return results
