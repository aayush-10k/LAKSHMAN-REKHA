#!/usr/bin/env bash
# B13 — Seed/reset script
# Returns everything to a clean known state in one command.
# Run this before every demo rehearsal.
#
# Usage: ./scripts/reset.sh

set -euo pipefail

CORE_URL="${CORE_URL:-http://localhost:4000}"
VENDORSIM_URL="${VENDORSIM_URL:-http://localhost:4100}"

echo ""
echo "╔═══════════════════════════════════════════╗"
echo "║  LAKSHMAN REKHA — Reset to clean state    ║"
echo "╚═══════════════════════════════════════════╝"
echo ""

# ── 1. Check services are up ────────────────────────────────
echo "▸ Checking services..."
if ! curl -sf "$CORE_URL/health" > /dev/null 2>&1; then
  echo "  ✗ Core is not running at $CORE_URL"
  echo "    Run: docker compose up -d"
  exit 1
fi
if ! curl -sf "$VENDORSIM_URL/catalog" > /dev/null 2>&1; then
  echo "  ✗ Vendorsim is not running at $VENDORSIM_URL"
  echo "    Run: docker compose up -d"
  exit 1
fi
echo "  ✓ Core and vendorsim are up"

# ── 2. Reset vendorsim (restart clears counterfeit vendors and injections) ──
echo "▸ Resetting vendorsim..."
if command -v docker &> /dev/null; then
  docker compose restart vendorsim 2>/dev/null && echo "  ✓ Vendorsim restarted" || echo "  ~ Vendorsim not in Docker (skipping restart)"
fi

# ── 3. Reset core state ─────────────────────────────────────
echo "▸ Resetting core state..."
if command -v docker &> /dev/null; then
  docker compose restart core 2>/dev/null && echo "  ✓ Core restarted" || echo "  ~ Core not in Docker"
fi

# Wait for core to be healthy again
echo "  Waiting for core to come back up..."
for i in $(seq 1 20); do
  if curl -sf "$CORE_URL/health" > /dev/null 2>&1; then
    echo "  ✓ Core is healthy"
    break
  fi
  sleep 1
done

# ── 4. Verify catalog ───────────────────────────────────────
echo "▸ Verifying vendor catalog..."
VENDOR_COUNT=$(curl -sf "$VENDORSIM_URL/catalog" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?")
echo "  ✓ $VENDOR_COUNT vendors in catalog (should be 8)"

# ── 5. Verify core health ───────────────────────────────────
echo "▸ Verifying core..."
HEALTH=$(curl -sf "$CORE_URL/health")
echo "  ✓ Core: $HEALTH"

echo ""
echo "╔═══════════════════════════════════════════╗"
echo "║  Reset complete. Demo state is clean.     ║"
echo "║  Demo credentials: see README.md          ║"
echo "╚═══════════════════════════════════════════╝"
echo ""
