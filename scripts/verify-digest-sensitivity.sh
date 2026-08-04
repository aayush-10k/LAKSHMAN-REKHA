#!/usr/bin/env bash
# The digest has to be deterministic AND sensitive. A hash that never changes
# is worse than no hash — it looks like attestation and commits to nothing.
#
# Appends a comment to the evaluator, re-hashes, and restores. Uses git to
# restore, so run it on a clean tree.
set -u
cd "$(dirname "$0")/.."
DIGEST() { node apps/core/scripts/core-image-digest.mjs | awk '/^digest/ {print $2}'; }

if ! git diff --quiet -- apps/core/src/evaluator.ts; then
  echo "apps/core/src/evaluator.ts has uncommitted changes; refusing to restore over them."
  exit 2
fi

before=$(DIGEST)
printf '\n// sensitivity probe — removed by scripts/verify-digest-sensitivity.sh\n' >> apps/core/src/evaluator.ts
changed=$(DIGEST)
git checkout -- apps/core/src/evaluator.ts
restored=$(DIGEST)

echo "before    $before"
echo "changed   $changed"
echo "restored  $restored"
echo
[ "$before" != "$changed" ]  && echo "sensitive    OK — one added comment moved the digest" || { echo "sensitive    FAILED"; exit 1; }
[ "$before" = "$restored" ]  && echo "deterministic OK — same tree, same digest" || { echo "deterministic FAILED"; exit 1; }
