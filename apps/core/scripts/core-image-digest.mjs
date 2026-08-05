#!/usr/bin/env node
/**
 * A reproducible digest over the exact source the core image runs.
 *
 *   node apps/core/scripts/core-image-digest.mjs            # print the digest
 *   node apps/core/scripts/core-image-digest.mjs --list     # and every file in it
 *
 * Predicate 3 is real — PolicyModule.sol:213 reverts CoreImageMismatch — but the
 * registered value is 0x01 followed by 31 zero bytes, so today it attests
 * nothing. This produces a value that commits to a specific policy engine.
 *
 * What it does NOT attest: the Node version, the dependency tree, the base
 * image, or that the deployed process is running this source at all. Anyone who
 * can set CORE_IMAGE_DIGEST can send any value. It is a source-tree hash, not
 * enclave attestation, and must not be described as one.
 *
 * Determinism: sorted paths, POSIX separators, CRLF normalised to LF, and each
 * file's path hashed alongside its bytes so a rename changes the digest.
 *
 * Registering it takes two steps and there is no ordering that avoids an
 * outage — predicate 3 compares the request against what is registered, so
 * whichever side moves first, payments in flight revert until the other
 * follows. Do it between rehearsals:
 *   1. set CORE_IMAGE_DIGEST wherever the core and agent run (.env, Railway,
 *      docker-compose) and restart both
 *   2. owner calls PolicyModule.attestCoreImage(<digest>)
 * Then re-run scripts/chain-state.mjs.
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
