#!/usr/bin/env node
/**
 * Compute a reproducible digest over the exact source the core image runs.
 *
 * ── The gap this closes, and the one it does not ──────────────────────────
 * `PolicyModule` predicate 3 is real: `req.coreImageDigest != coreImageDigest`
 * reverts `CoreImageMismatch` (`PolicyModule.sol:213`). The *mechanism* works.
 * The registered *value* is `0x01` followed by 31 zero bytes — not the hash of
 * anything — so it currently attests nothing, and both the console and the
 * playground print it next to a copy button where it reads as evidence.
 * `LIMITATIONS.md` says so in as many words, and `lib/contracts.ts`
 * `isPlaceholderDigest()` labels it on screen.
 *
 * The blocker was never the maths. It was that Docker is not installed on the
 * build machine, so no *image* digest could be produced. But the claim the demo
 * actually makes is *"if we swapped in a permissive policy engine every payment
 * would revert"* — and that is a claim about the SOURCE, which is right here.
 * A source-tree digest is weaker than a reproducible image digest and stronger
 * than a constant. It is honest as long as it is described as what it is.
 *
 * **What this does NOT prove.** It does not attest the runtime: not the Node
 * version, not the installed dependency tree, not the base image, not that the
 * deployed process is running this source at all. Anyone who can set
 * `CORE_IMAGE_DIGEST` can send whatever value they like. It closes the gap
 * between "an arbitrary constant" and "a commitment to a specific policy
 * engine". Do not present it as enclave attestation.
 *
 * ── Determinism ──────────────────────────────────────────────────────────
 * Sorted paths, POSIX separators, CRLF normalised to LF, and the file's path
 * hashed alongside its bytes so a rename is a different digest. Same tree on
 * any machine, any checkout, any OS — which is the whole point, since the
 * person verifying is not the person who built it.
 *
 *   node apps/core/scripts/core-image-digest.mjs            # print the digest
 *   node apps/core/scripts/core-image-digest.mjs --list     # and every file in it
 *
 * To make it real, two steps, in this order, or every settlement reverts:
 *   1. set CORE_IMAGE_DIGEST to this value everywhere the core and the agent
 *      run (.env, Railway, docker-compose) and restart both
 *   2. owner calls PolicyModule.attestCoreImage(<digest>)
 *
 * Doing 2 before 1 breaks every payment in flight. Doing 1 before 2 breaks
 * every payment too — predicate 3 compares against what is registered. There is
 * no ordering that avoids a window; take the outage deliberately, between
 * rehearsals, and re-run scripts/chain-state.mjs after.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The file set, mirroring `apps/core/Dockerfile`'s COPY lines.
 *
 * Manifests and lockfile included: a dependency swap changes what the policy
 * engine does even when no line of our source moves. `pnpm-lock.yaml` is the
 * single biggest contributor and it is the reason this is worth anything.
 *
 * Keep in step with the Dockerfile. A COPY added there and not here means the
 * digest stops covering something the image runs.
 */
const INCLUDE = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'apps/core/package.json',
  'apps/core/tsconfig.json',
  'apps/core/src',
  'apps/agents/task-engine/package.json',
  'apps/agents/task-engine/src',
  'apps/agents/adversary',
  'apps/core/docker-entrypoint.sh',
  // Added 5 Aug 2026, in step with the COPY added to apps/core/Dockerfile.
  // These are the ABIs api/chain.ts loads off disk to talk to PolicyModule and
  // RekhaAccount. They were missing from the image entirely, and they belong in
  // the digest for the reason the note above gives: swap an ABI and the core
  // encodes a different call to the same contract, without one line of our
  // source changing.
  'packages/contracts-abi',
];

/** Never hashed: not copied into the image, or not deterministic. */
const SKIP_DIRS = new Set(['__pycache__', 'node_modules', '.venv', 'dist', '.pytest_cache']);
const SKIP_FILES = /\.(pyc|log)$/;

function walk(absolute, out) {
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    // A path in INCLUDE that does not exist is a real problem — the Dockerfile
    // would fail on the same COPY — so it is reported, not skipped silently.
    console.error(`[digest] MISSING: ${relative(REPO, absolute)} — the Dockerfile copies this`);
    process.exitCode = 1;
    return;
  }

  if (stat.isFile()) {
    if (!SKIP_FILES.test(absolute)) out.push(absolute);
    return;
  }
  for (const entry of readdirSync(absolute).sort()) {
    if (SKIP_DIRS.has(entry)) continue;
    walk(join(absolute, entry), out);
  }
}

const files = [];
for (const item of INCLUDE) walk(join(REPO, item), files);

// Sort on the POSIX-normalised path, so a Windows checkout and a Linux one
// hash the same tree in the same order.
const posix = (absolute) => relative(REPO, absolute).split(sep).join('/');
files.sort((a, b) => (posix(a) < posix(b) ? -1 : posix(a) > posix(b) ? 1 : 0));

const tree = createHash('sha256');
const perFile = [];

for (const absolute of files) {
  const path = posix(absolute);
  // CRLF -> LF. A Windows checkout of the same commit must not produce a
  // different digest; git's autocrlf makes that a real possibility here.
  const bytes = readFileSync(absolute).toString('utf8').replace(/\r\n/g, '\n');
  const fileHash = createHash('sha256').update(bytes, 'utf8').digest('hex');

  // Path AND contents, so moving a file changes the digest.
  tree.update(path, 'utf8').update('\0', 'utf8').update(fileHash, 'utf8').update('\n', 'utf8');
  perFile.push({ path, fileHash, bytes: bytes.length });
}

const digest = `0x${tree.digest('hex')}`;

if (process.argv.includes('--list')) {
  for (const f of perFile) {
    console.log(`${f.fileHash.slice(0, 16)}  ${String(f.bytes).padStart(8)}  ${f.path}`);
  }
  console.log('');
}

console.log(`files    ${perFile.length}`);
console.log(`digest   ${digest}`);

const registered = process.env['CORE_IMAGE_DIGEST'];
if (registered) {
  const match = registered.toLowerCase() === digest.toLowerCase();
  console.log(`env      ${registered}  ${match ? '== MATCHES' : '!= DOES NOT MATCH'}`);
  if (!match) {
    console.log('');
    console.log('The running core would send a digest that is not this source tree.');
    console.log('Either the source changed since it was registered, or CORE_IMAGE_DIGEST is stale.');
  }
} else {
  console.log('env      CORE_IMAGE_DIGEST is unset — the core falls back to the 0x01 placeholder,');
  console.log('         which is not the hash of anything and attests nothing.');
}
