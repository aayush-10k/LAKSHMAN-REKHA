/**
 * Shared frontend types — re-exported from apps/core/src/types.ts
 * Keep in sync with core types manually (or import from packages/contracts-abi when ready).
 */

export type Currency = 'INR';

export type CategoryCode =
  | 'PACKAGING'
  | 'ADVERTISING'
  | 'CONTENT'
  | 'COMPUTE'
  | 'LOGISTICS'
  | 'SOFTWARE'
  | 'UTILITIES'
  | 'OTHER';

export type TaskKind = 'procure' | 'ads' | 'content' | 'compute' | 'logistics' | 'subscription';

export type BehaviourMode =
  | 'normal'
  | 'hallucinating'
  | 'injected'
  | 'compromised'
  | 'overreach'
  | 'colluding';

export type Outcome = 'APPROVED' | 'HELD' | 'REFUSED';
export type CounterpartyTier = 1 | 2 | 3;

export type PredicateName =
  | 'agentSignature'
  | 'coreSignature'
  | 'coreImage'
  | 'revocationEpoch'
  | 'leaseExpiry'
  | 'nonce'
  | 'categoryPermitted'
  | 'counterpartyTier'
  | 'counterpartyAge'
  | 'counterpartySettled'
  | 'priceBand'
  | 'perTxCap'
  | 'windowCap'
  | 'cumulativeCap';

export type Predicate = {
  name: PredicateName;
  inputs: Record<string, number | string>;
  expected: string;
  actual: string;
  passed: boolean;
  severity: 'hard' | 'soft';
};

export type DecisionTrace = {
  decisionId: string;
  lineItemId: string;
  outcome: Outcome;
  predicates: Predicate[];
  bindingPredicate: PredicateName | null;
  amountMinor: number;
  counterpartyId: string;
  policyHash: string;
  coreImageDigest: string;
  evaluatedAtMs: number;
  latencyMs: number;
  summary: string;
  signature: string;
};

export type LineItem = {
  lineItemId: string;
  vendorId: string;
  categoryCode: CategoryCode;
  estimatedAmountMinor: number;
  description: string;
};

export type RekhaEvent =
  | { t: 'task.started'; atMs: number; taskId: string; kind: TaskKind; description: string; plan: LineItem[]; mode: BehaviourMode }
  | { t: 'agent.thought'; atMs: number; taskId: string; text: string }
  | { t: 'quote.received'; atMs: number; lineItemId: string; vendorId: string; amountMinor: number; simElapsedMs: number }
  | { t: 'payment.requested'; atMs: number; lineItemId: string; factSheet: { amountMinor: number; [k: string]: unknown } }
  | { t: 'decision.made'; atMs: number; trace: DecisionTrace }
  | { t: 'ceremony.round'; atMs: number; decisionId: string; round: number; of: number }
  | { t: 'ceremony.aborted'; atMs: number; decisionId: string; atRound: number; reason: 'revoked' | 'timeout' }
  | { t: 'payment.settled'; atMs: number; decisionId: string; txHash: string; balanceAfterMinor: number }
  | { t: 'payment.held'; atMs: number; decisionId: string; expiresAtMs: number; amountMinor: number }
  | { t: 'hold.released'; atMs: number; decisionId: string; amountMinor: number }
  | { t: 'revocation'; atMs: number; epoch: number; source: 'owner' | 'guardian' | 'deadman'; latencyMs: number }
  | { t: 'lease.tick'; atMs: number; leaseId: string; ttlMs: number }
  | { t: 'attack.attempt'; atMs: number; technique: string; classNumber: number | null; blocked: boolean; revertReason: string; novel: boolean }
  | { t: 'core.status'; atMs: number; up: boolean; imageDigest: string };
