#!/usr/bin/env bash
# Phase 7 verification: what the landing page actually serves.
#
# Server-rendered with no data fetching, so everything below has to be present
# in the first response — if any of it needs hydration to appear, the page has
# picked up a client dependency it is not allowed to have.
set -u
WEB=${WEB_URL:-http://localhost:3000}

curl -sS -o /tmp/rekha-lp.html -w "GET /            HTTP=%{http_code}  bytes=%{size_download}\n" "$WEB/"

# Turbopack emits CSS under /_next/static/chunks/, not /_next/static/css/.
# Matching only the latter found nothing and reported every class MISSING,
# which looks exactly like an unstyled page and is not.
CSS=$(grep -o '/_next/static/[A-Za-z0-9_./-]*\.css' /tmp/rekha-lp.html | head -1)
if [ -n "$CSS" ]; then
  curl -sS -o /tmp/rekha-lp.css -w "GET $CSS  HTTP=%{http_code}  bytes=%{size_download}\n" "$WEB$CSS"
fi

echo
echo "in the SERVER HTML (no JS run):"
for needle in InvalidCoreSignature "It isn" PolicyModule RekhaAccount INRx \
              "Open the console" "Open the playground" "What this is not" \
              "4 Aug 2026" sepolia.basescan.org; do
  # React splits adjacent text nodes with <!-- --> markers, so needles that
  # span a JSX expression boundary never match the raw HTML. Match the values,
  # not the sentences they sit in.
  n=$(grep -c -F -- "$needle" /tmp/rekha-lp.html)
  printf "  %-28s %s\n" "$needle" "$([ "$n" -gt 0 ] && echo "present ($n)" || echo MISSING)"
done

echo
echo "in the BUILT CSS:"
for cls in .lp-revert .lp-thesis .lp-row .lp-door .lp-wordmark-rule .rekha-line; do
  n=$(grep -c -F -- "$cls" /tmp/rekha-lp.css 2>/dev/null || echo 0)
  printf "  %-28s %s\n" "$cls" "$([ "$n" -gt 0 ] && echo present || echo MISSING)"
done

echo
echo "banned by BUILD.md Part 11 (must all be 0):"
for bad in 5B8DEF linear-gradient radial-gradient backdrop-filter; do
  printf "  %-28s %s\n" "$bad" "$(grep -c -i -F -- "$bad" /tmp/rekha-lp.css 2>/dev/null | head -1)"
done

echo
echo "other routes:"
for path in /console /playground /kitchen-sink; do
  curl -sS -o /dev/null -w "  $path  HTTP=%{http_code}\n" "$WEB$path"
done
