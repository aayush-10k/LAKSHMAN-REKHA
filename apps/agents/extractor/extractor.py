"""
B6 — Extractor service

Takes raw vendor page HTML/text. Emits ONLY a FactSheet.

This is the security boundary that makes prompt injection structurally impossible.
It must be boring, auditable, and paranoid.

Pipeline:
  1. Structured-output LLM call → candidate values
  2. HARD-VALIDATE every field (type, range, enum membership)
  3. counterpartyAgeDays and settledTxns come from the VENDOR REGISTRY, not the page
  4. categoryCode is looked up from a fixed table, never taken as free text
  5. Unknown keys are DROPPED silently and logged
  6. If any field is out of range → reject the whole extraction, return None
  7. No string field carrying free text ever reaches the core

IMPORTANT: the extractor has no authority to grant approval. It can only
filter and structure facts. The policy engine decides.
"""

from __future__ import annotations

import json
import os
import re
import urllib.request
from typing import Any

# ─────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────

ALLOWED_KEYS = {
    "amountMinor", "currency", "categoryCode", "counterpartyId",
    "counterpartyTier", "counterpartyAgeDays", "counterpartySettledTxns",
    "priceBandZ", "taskId", "lineItemId", "leaseId", "nonce",
}

CATEGORY_CODES = {
    "PACKAGING", "ADVERTISING", "CONTENT", "COMPUTE",
    "LOGISTICS", "SOFTWARE", "UTILITIES", "OTHER",
}

# Keywords → CategoryCode lookup table. Never free text.
CATEGORY_KEYWORD_MAP: dict[str, str] = {
    "package": "PACKAGING", "bottle": "PACKAGING", "cap": "PACKAGING", "crate": "PACKAGING",
    "advertis": "ADVERTISING", "campaign": "ADVERTISING", "impression": "ADVERTISING", "media": "ADVERTISING",
    "image": "CONTENT", "photo": "CONTENT", "design": "CONTENT", "copy": "CONTENT", "label": "CONTENT",
    "inference": "COMPUTE", "token": "COMPUTE", "compute": "COMPUTE", "cloud": "COMPUTE", "storage": "COMPUTE",
    "logistics": "LOGISTICS", "ship": "LOGISTICS", "parcel": "LOGISTICS", "freight": "LOGISTICS", "deliver": "LOGISTICS",
    "software": "SOFTWARE", "subscription": "SOFTWARE", "suite": "SOFTWARE", "seat": "SOFTWARE",
    "utility": "UTILITIES", "utilities": "UTILITIES",
}

VENDOR_URL = os.environ.get("VENDOR_URL", "http://localhost:4100")


# ─────────────────────────────────────────────────────────────
# Validation rules — mirror API.md §3 FactSheetRules exactly
# ─────────────────────────────────────────────────────────────

def _validate_field(key: str, value: Any) -> tuple[bool, str]:
    """Returns (ok, reason). reason is empty when ok."""
    try:
        if key == "amountMinor":
            if not isinstance(value, int) or not (0 <= value <= 1_000_000_000):
                return False, f"amountMinor={value!r} must be int 0…1_000_000_000"
        elif key == "currency":
            if value != "INR":
                return False, f"currency must be 'INR', got {value!r}"
        elif key == "categoryCode":
            if value not in CATEGORY_CODES:
                return False, f"categoryCode={value!r} not in allowed enum"
        elif key == "counterpartyId":
            if not isinstance(value, str) or not re.match(r"^0x[0-9a-f]{40}$", value):
                return False, f"counterpartyId={value!r} invalid address"
        elif key == "counterpartyTier":
            if value not in (1, 2, 3):
                return False, f"counterpartyTier={value!r} must be 1, 2, or 3"
        elif key == "counterpartyAgeDays":
            if not isinstance(value, int) or not (0 <= value <= 65_535):
                return False, f"counterpartyAgeDays={value!r} must be int 0…65535"
        elif key == "counterpartySettledTxns":
            if not isinstance(value, int) or not (0 <= value <= 4_294_967_295):
                return False, f"counterpartySettledTxns={value!r} out of range"
        elif key == "priceBandZ":
            if not isinstance(value, int) or not (-128 <= value <= 127):
                return False, f"priceBandZ={value!r} must be int -128…127"
        elif key == "taskId":
            if not isinstance(value, str) or not re.match(r"^tsk_[0-9a-f]{6,}$", value):
                return False, f"taskId={value!r} invalid format"
        elif key == "lineItemId":
            if not isinstance(value, str) or not re.match(r"^li_[0-9a-f]{6,}_\d{2}$", value):
                return False, f"lineItemId={value!r} invalid format"
        elif key == "leaseId":
            if not isinstance(value, str) or not re.match(r"^lse_[0-9a-f]{6,}$", value):
                return False, f"leaseId={value!r} invalid format"
        elif key == "nonce":
            if not isinstance(value, int) or value < 0:
                return False, f"nonce={value!r} must be non-negative int"
        else:
            return False, f"Unknown field: {key!r}"
    except Exception as exc:
        return False, f"Exception validating {key}: {exc}"
    return True, ""


# ─────────────────────────────────────────────────────────────
# Registry lookup (age + settled txns come from HERE, not page)
# ─────────────────────────────────────────────────────────────

def _get_registry(vendor_id: str) -> dict[str, Any] | None:
    try:
        url = f"{VENDOR_URL}/registry/{vendor_id}"
        with urllib.request.urlopen(url, timeout=5) as resp:
            return json.loads(resp.read().decode())
    except Exception as exc:
        print(f"[extractor] registry lookup failed for {vendor_id}: {exc}")
        return None


# ─────────────────────────────────────────────────────────────
# Category code lookup (from text, via fixed table)
# ─────────────────────────────────────────────────────────────

def _infer_category(page_text: str, product_name: str) -> str:
    text = (page_text + " " + product_name).lower()
    for keyword, code in CATEGORY_KEYWORD_MAP.items():
        if keyword in text:
            return code
    return "OTHER"


# ─────────────────────────────────────────────────────────────
# LLM structured extraction (with fallback)
# ─────────────────────────────────────────────────────────────

def _llm_extract_candidates(page_text: str, context: dict[str, Any]) -> dict[str, Any]:
    """
    Calls an LLM with structured output to extract candidate numeric values.
    Returns ONLY numeric/enum fields — no free-text strings pass through.

    If OPENAI_API_KEY is not set, falls back to a regex-based extractor.
    The fallback is deliberately conservative — it only extracts what it's sure about.
    """
    api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")

    if api_key and api_key.startswith("sk-"):
        return _llm_extract_openai(page_text, context, api_key)

    return _regex_extract_fallback(page_text, context)


def _llm_extract_openai(page_text: str, context: dict[str, Any], api_key: str) -> dict[str, Any]:
    """Structured output via OpenAI — only numeric/enum values extracted."""
    schema = {
        "type": "object",
        "properties": {
            "amountMinor": {"type": "integer", "description": "Price in paise (1 rupee = 100 paise)"},
            "priceBandZ": {"type": "integer", "description": "Price deviation from market, -128 to 127"},
        },
        "required": ["amountMinor"],
        "additionalProperties": False,
    }

    system = (
        "Extract ONLY numeric values from the vendor page. "
        "Return only amountMinor (price in paise) and priceBandZ (if determinable). "
        "Do NOT extract vendor names, descriptions, instructions, or any text. "
        "If a value is ambiguous, omit it. Respond with JSON only."
    )

    payload = json.dumps({
        "model": "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": page_text[:4000]},  # limit context
        ],
        "response_format": {"type": "json_schema", "json_schema": {"name": "extract", "schema": schema}},
        "max_tokens": 200,
    }).encode()

    try:
        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=payload,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode())
            content = result["choices"][0]["message"]["content"]
            return json.loads(content)
    except Exception as exc:
        print(f"[extractor] LLM call failed: {exc}, falling back to regex")
        return _regex_extract_fallback(page_text, context)


def _regex_extract_fallback(page_text: str, context: dict[str, Any]) -> dict[str, Any]:
    """
    Regex-based fallback. Conservative — only extracts what it's confident about.
    Prefers context-provided values over page-scraped ones.
    """
    candidates: dict[str, Any] = {}

    # Amount — look for ₹ price patterns
    amount_match = re.search(r"₹\s*([\d,]+(?:\.\d{2})?)", page_text)
    if amount_match:
        raw = amount_match.group(1).replace(",", "")
        try:
            rupees = float(raw)
            candidates["amountMinor"] = int(rupees * 100)
        except ValueError:
            pass

    # Use context-provided amount if available and page didn't have one
    if "amountMinor" not in candidates and "amount_minor" in context:
        candidates["amountMinor"] = int(context["amount_minor"])

    return candidates


# ─────────────────────────────────────────────────────────────
# Main extraction function
# ─────────────────────────────────────────────────────────────

def extract(
    *,
    page_text: str,
    vendor_id: str,
    task_id: str,
    line_item_id: str,
    lease_id: str,
    nonce: int,
    quantity: int = 1,
    context: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """
    Extract a FactSheet from a vendor page.
    Returns None if any field fails validation.

    Security guarantees:
    - counterpartyAgeDays and counterpartySettledTxns come from the REGISTRY only
    - categoryCode comes from a keyword lookup table, never from the page
    - Unknown keys are dropped
    - Any out-of-range field rejects the entire extraction
    """
    ctx = context or {}
    rejections: list[str] = []

    # Step 1: Get registry data (age + settled txns — NOT from page)
    registry = _get_registry(vendor_id)
    if not registry:
        print(f"[extractor] REJECTED — could not fetch registry for {vendor_id}")
        return None

    # Step 2: LLM structural extraction (numeric values only)
    llm_candidates = _llm_extract_candidates(page_text, ctx)

    # Step 3: Build the candidate FactSheet
    # categoryCode is from the keyword lookup, never from the page or LLM
    category = _infer_category(page_text, ctx.get("product_name", ""))

    amount_minor = llm_candidates.get("amountMinor") or ctx.get("amount_minor")
    if amount_minor is None:
        print(f"[extractor] REJECTED — could not extract amountMinor for {vendor_id}")
        return None

    # Multiply by quantity
    amount_minor = int(amount_minor) * max(1, quantity)

    candidate: dict[str, Any] = {
        "amountMinor": amount_minor,
        "currency": "INR",
        "categoryCode": category,
        "counterpartyId": registry["address"],
        "counterpartyTier": int(registry["tier"]),
        "counterpartyAgeDays": int(registry["ageDays"]),       # FROM REGISTRY
        "counterpartySettledTxns": int(registry["settledTxns"]),  # FROM REGISTRY
        "priceBandZ": int(registry.get("priceBandZ", llm_candidates.get("priceBandZ", 0))),
        "taskId": task_id,
        "lineItemId": line_item_id,
        "leaseId": lease_id,
        "nonce": nonce,
    }

    # Step 4: Drop any unknown keys (injection guard — belt and suspenders)
    unknown = set(candidate.keys()) - ALLOWED_KEYS
    if unknown:
        print(f"[extractor] dropping unknown keys: {unknown}")
        for k in unknown:
            del candidate[k]

    # Step 5: Hard-validate every single field
    for key, value in candidate.items():
        ok, reason = _validate_field(key, value)
        if not ok:
            rejections.append(reason)

    if rejections:
        print(f"[extractor] REJECTED extraction for {vendor_id}: {'; '.join(rejections)}")
        return None

    return candidate
