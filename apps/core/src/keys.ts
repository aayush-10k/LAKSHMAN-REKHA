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

/**
 * Accepted env names, in precedence order.
 *
 * `CORE_SIGNER_PRIVATE_KEY` is the name .env.example and the deployment docs
 * use; `REKHA_CORE_PRIVATE_KEY` is the name this module shipped with. Both are
 * read so neither the deployment config nor A's existing setup silently ends up
 * with no key — which, given resolve() throws, would take down signing entirely.
 */
const CORE_ENV = ['CORE_SIGNER_PRIVATE_KEY', 'REKHA_CORE_PRIVATE_KEY'];
const AGENT_ENV = ['AGENT_SIGNER_PRIVATE_KEY', 'REKHA_AGENT_PRIVATE_KEY'];

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

let corePk: Hex | null = null;
let agentPk: Hex | null = null;

function assertKeyShape(pk: string, label: string): Hex {
  if (!PRIVATE_KEY_RE.test(pk)) {
    throw new Error(`${label} is not a 32-byte 0x-prefixed hex private key`);
  }
  return pk as Hex;
}

function resolve(current: Hex | null, envNames: string[], label: string): Hex {
  if (current !== null) return current;
  for (const name of envNames) {
    const fromEnv = process.env[name];
    if (fromEnv !== undefined && fromEnv !== '') return assertKeyShape(fromEnv, label);
  }
  throw new Error(
    `${label} is not configured (set ${envNames.join(' or ')}, or call the setter). Refusing to sign.`,
  );
}

/** Whether a core key is available, without throwing. Callers use this to fail
 *  closed with a 503 rather than letting an exception escape as a 500. */
export function hasCoreKey(): boolean {
  try {
    corePrivateKey();
    return true;
  } catch {
    return false;
  }
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
