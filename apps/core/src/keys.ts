import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';

/**
 * The two key shares, held in one place.
 *
 * Fail-closed by construction: there is no default key and no fallback. If a key
 * was never configured, every accessor throws, so the paths that would have
 * produced a signature stop instead. A missing key must never degrade into an
 * unsigned-but-accepted request.
 *
 * Keys come from the environment or from the setters. The setters exist so tests
 * can install deterministic keys; this module never reads or writes .env itself.
 */

const CORE_ENV = 'REKHA_CORE_PRIVATE_KEY';
const AGENT_ENV = 'REKHA_AGENT_PRIVATE_KEY';

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

let corePk: Hex | null = null;
let agentPk: Hex | null = null;

function assertKeyShape(pk: string, label: string): Hex {
  if (!PRIVATE_KEY_RE.test(pk)) {
    throw new Error(`${label} is not a 32-byte 0x-prefixed hex private key`);
  }
  return pk as Hex;
}

function resolve(current: Hex | null, envName: string, label: string): Hex {
  if (current !== null) return current;
  const fromEnv = process.env[envName];
  if (fromEnv === undefined || fromEnv === '') {
    throw new Error(`${label} is not configured (set ${envName} or call the setter). Refusing to sign.`);
  }
  return assertKeyShape(fromEnv, label);
}

/** Installs the core key share. */
export function setCoreKey(pk: Hex): void {
  corePk = assertKeyShape(pk, 'core private key');
}

/** Installs the agent key share. Test-only: the core never holds this share. */
export function setAgentKey(pk: Hex): void {
  agentPk = assertKeyShape(pk, 'agent private key');
}

/** Forgets both keys. */
export function resetKeys(): void {
  corePk = null;
  agentPk = null;
}

/** The core key share. Throws if unconfigured — never returns a placeholder. */
export function corePrivateKey(): Hex {
  return resolve(corePk, CORE_ENV, 'core private key');
}

/** The agent key share. Throws if unconfigured. Test-only. */
export function agentPrivateKey(): Hex {
  return resolve(agentPk, AGENT_ENV, 'agent private key');
}

/** Address predicate 2 must recover to. */
export function coreSignerAddress(): Address {
  return privateKeyToAccount(corePrivateKey()).address;
}

/** Address predicate 1 must recover to. */
export function agentSignerAddress(): Address {
  return privateKeyToAccount(agentPrivateKey()).address;
}
