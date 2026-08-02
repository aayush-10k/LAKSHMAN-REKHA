/**
 * Loads .env into process.env at core startup.
 *
 * FIX2.md BUG 1: nothing in this process ever read .env, so a plain
 * `pnpm dev:core` started with no CORE_SIGNER_PRIVATE_KEY. hasCoreKey() was then
 * false, store.issueLease() returned null for that reason, and POST
 * /v1/lease/renew answered a bare 503 CORE_UNAVAILABLE that named none of it.
 * The only way to run the server was to `set -a && source .env` by hand first.
 *
 * Import this FIRST, before any module that reads process.env at module scope —
 * api/chain.ts pins BASE_SEPOLIA_RPC in a top-level const, so loading later than
 * that would silently use the default RPC. ESM evaluates dependencies in import
 * order, so `import './env.js'` as the first import of the entry file is enough.
 *
 * No dotenv dependency: node:util.parseEnv (Node >= 20.12) does the parsing.
 *
 * Precedence, deliberately: a variable already in the environment ALWAYS wins.
 * Docker, CI and `set -a && source .env` must keep overriding the file, and a
 * file quietly clobbering an operator's explicit value is how a demo ends up
 * signing with the wrong key.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Searched in order; every file found is applied, earlier files winning.
 * apps/core/.env is the app-local override, the repo root .env is the shared one.
 */
const CANDIDATES = [
  resolve(here, '../.env'),        // apps/core/.env
  resolve(here, '../../../.env'),  // repo root .env
];

export type LoadedEnvFile = { path: string; keys: string[] };

function applyFile(path: string): LoadedEnvFile | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null; // absent is fine — the environment may already carry everything
  }

  const parsed = parseEnv(raw);
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] !== undefined && process.env[key] !== '') continue;
    process.env[key] = value as string;
    applied.push(key);
  }
  return { path, keys: applied };
}

/**
 * Applies every .env found. Returns what was loaded so startup can log it —
 * names only. Values are private keys; they are never logged.
 */
export function loadEnv(): LoadedEnvFile[] {
  const loaded: LoadedEnvFile[] = [];
  for (const path of CANDIDATES) {
    const result = applyFile(path);
    if (result !== null) loaded.push(result);
  }
  return loaded;
}

/** Runs on import — this module exists to have happened before anything else. */
export const LOADED_ENV_FILES = loadEnv();
