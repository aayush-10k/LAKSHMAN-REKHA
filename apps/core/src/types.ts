/**
 * Shared types — mirrors docs/API.md exactly.
 * B produces these; A's evaluator and C's frontend consume them.
 * Do NOT add free-text string fields to FactSheet — see API.md §3.
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

export type TaskKind =
  | 'procure'
  | 'ads'
  | 'content'
  | 'compute'
  | 'logistics'
  | 'subscription';

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

// THE SECURITY BOUNDARY — no free-text string fields ever
export type FactSheet = {
  amountMinor: number;           // integer paise, 0…1_000_000_000
  currency: Currency;
  categoryCode: CategoryCode;
  counterpartyId: string;        // 0x… 42 chars lowercase
  counterpartyTier: CounterpartyTier;
  counterpartyAgeDays: number;   // 0…65535 — FROM REGISTRY ONLY
  counterpartySettledTxns: number; // 0…4_294_967_295 — FROM REGISTRY ONLY
  priceBandZ: number;            // -128…127 integer
  taskId: string;                // tsk_…
  lineItemId: string;            // li_…_NN
  leaseId: string;               // lse_…
  nonce: number;                 // uint64
};

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

export type MandateState = {
  mandateId: string;
  ownerAddress: string;
  guardianAddress: string | null;
  agentSignerAddress: string;
  coreSignerAddress: string;
  revocationEpoch: number;
  policyHash: string;
  perTxCapMinor: number;
  windowCapMinor: number;
  windowSeconds: number;
  cumulativeCapMinor: number;
  windowStartMs: number;
  windowSpentMinor: number;
  cumulativeSpentMinor: number;
  permittedCategories: CategoryCode[];
  tier2MinAgeDays: number;
  tier2MinSettledTxns: number;
  tier2MaxPriceBandZ: number;
  tier2CapMinor: number;
  lastHeartbeatMs: number;
  deadmanSeconds: number;
  frozen: boolean;
};

export type LineItem = {
  lineItemId: string;
  vendorId: string;
  categoryCode: CategoryCode;
  estimatedAmountMinor: number;
  description: string; // display only — NEVER enters a FactSheet
};

export type RekhaEvent =
  | { t: 'task.started'; atMs: number; taskId: string; kind: TaskKind; description: string; plan: LineItem[]; mode: BehaviourMode }
  | { t: 'agent.thought'; atMs: number; taskId: string; text: string }
  | { t: 'quote.received'; atMs: number; lineItemId: string; vendorId: string; amountMinor: number; simElapsedMs: number }
  | { t: 'payment.requested'; atMs: number; lineItemId: string; factSheet: FactSheet }
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

export type ApiError = {
  error: {
    code: string;
    message: string;
    predicate?: PredicateName;
    decisionId?: string;
  };
};
