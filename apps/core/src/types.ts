/**
 * Shared types — mirrors docs/API.md exactly.
 * B produces these; A's evaluator and C's frontend consume them.
 * Do NOT add free-text string fields to FactSheet — see API.md §3.
 */

import { z } from 'zod';

export type Currency = 'INR';

/**
 * Order matters: the index of each code IS the bit position the on-chain
 * `permittedCategories` bitmap uses (PolicyModule._categoryPermitted does
 * `(permittedCategories >> categoryCode) & 1`). Do not reorder.
 *
 * The array is the single source of truth; `CategoryCode` is derived from it so
 * the string union and the integer mapping cannot drift apart.
 */
export const CATEGORY_CODES = [
  'PACKAGING',   // 0
  'ADVERTISING', // 1
  'CONTENT',     // 2
  'COMPUTE',     // 3
  'LOGISTICS',   // 4
  'SOFTWARE',    // 5
  'UTILITIES',   // 6
  'OTHER',       // 7
] as const;

export type CategoryCode = (typeof CATEGORY_CODES)[number];

/** String category code -> its integer bit index, mirroring the Solidity uint8. */
export const CATEGORY_INDEX: Readonly<Record<CategoryCode, number>> = Object.freeze(
  Object.fromEntries(CATEGORY_CODES.map((c, i) => [c, i])) as Record<CategoryCode, number>,
);

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

/** The 14 predicates, in the fixed order PolicyModule.validate evaluates them. */
export const PREDICATE_NAMES = [
  'agentSignature',      // 1  hard
  'coreSignature',       // 2  hard
  'coreImage',           // 3  hard
  'revocationEpoch',     // 4  hard
  'leaseExpiry',         // 5  hard
  'nonce',               // 6  hard
  'categoryPermitted',   // 7  hard
  'counterpartyTier',    // 8  hard
  'counterpartyAge',     // 9  soft
  'counterpartySettled', // 10 soft
  'priceBand',           // 11 soft
  'perTxCap',            // 12 hard
  'windowCap',           // 13 hard
  'cumulativeCap',       // 14 hard
] as const;

export type PredicateName = (typeof PREDICATE_NAMES)[number];

export type Severity = 'hard' | 'soft';

// Soft-fail bitmask bits, matching PolicyModule.SOFT_FAIL_* constants.
export const SOFT_FAIL_AGE = 0x1;     // bit0 -> predicate 9  (counterpartyAge)
export const SOFT_FAIL_SETTLED = 0x2; // bit1 -> predicate 10 (counterpartySettled)
export const SOFT_FAIL_PRICE = 0x4;   // bit2 -> predicate 11 (priceBand)

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
  severity: Severity;
};

export type DecisionTrace = {
  decisionId: string;
  lineItemId: string;
  outcome: Outcome;
  predicates: Predicate[];
  bindingPredicate: PredicateName | null;
  /**
   * bit0=age, bit1=settled, bit2=price. Additive over API.md §4, which predates
   * schema 1.1.0 — that version added `PaymentHeld(bytes32, uint16 softFailBitmask)`
   * to PolicyModule (API.md §9), so the trace has to be able to carry the value
   * the event emits. 0 for every outcome that is not HELD.
   */
  softFailBitmask: number;
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
  /**
   * A payment that is on chain. `txHash` always came off a mined receipt.
   *
   * `balanceAfterMinor` is RekhaAccount's INRx balance read AT `blockNumber`,
   * and is null when that read could not be completed — the money still moved,
   * we just cannot state the resulting balance. Consumers must render null as
   * "unavailable"; substituting a local figure is how the console ended up
   * showing a pre-payment balance next to a real settlement.
   */
  | { t: 'payment.settled'; atMs: number; decisionId: string; txHash: string; blockNumber: number; amountMinor: number; balanceAfterMinor: number | null; balanceSource: 'chain' | 'unavailable' }
  | { t: 'payment.held'; atMs: number; decisionId: string; expiresAtMs: number; amountMinor: number }
  | { t: 'hold.released'; atMs: number; decisionId: string; amountMinor: number }
    // latencyMs: when nothing NEW can be approved — immediate, the epoch is
  // already bumped. worstCaseStopMs: when spending is definitely over, i.e.
  // the lease TTL, because a lease already issued stays valid until it
  // expires. Reporting only the first as "freeze latency" overstates it.
  | { t: 'revocation'; atMs: number; epoch: number; source: 'owner' | 'guardian' | 'deadman'; latencyMs: number; worstCaseStopMs?: number }
  | { t: 'lease.tick'; atMs: number; leaseId: string; ttlMs: number }
  // `status` and `stage` exist because `blocked` alone could not tell three
  // different things apart. An attack class that threw, and a response the
  // classifier did not recognise, both used to arrive here as blocked:true —
  // so the scoreboard counted our own harness breaking as a defence.
  //   status  'blocked' stopped · 'through' it worked · 'errored' never tested
  //   stage   which layer stopped it: the typed-schema input boundary, a named
  //           policy predicate, or the deployed contract. null when none did.
  | { t: 'attack.attempt'; atMs: number; technique: string; classNumber: number | null; blocked: boolean; revertReason: string; novel: boolean; status: 'blocked' | 'through' | 'errored'; stage: 'input' | 'policy' | 'chain' | null }
  | { t: 'core.status'; atMs: number; up: boolean; imageDigest: string };

export type ApiError = {
  error: {
    code: string;
    message: string;
    predicate?: PredicateName;
    decisionId?: string;
  };
};

// ---------------------------------------------------------------------------
//  Evaluator-side types
// ---------------------------------------------------------------------------
//
// A's evaluator was written against its own `FactSheet` / `MandateState`, which
// are NOT the ones above. Reconciling them (FIX.md TASK 1) resolved as follows,
// with docs/API.md authoritative wherever the two genuinely disagreed:
//
//  - `FactSheet` and `MandateState` keep the API.md shapes exactly. They are the
//    wire types: what B's routes validate, what C's frontend renders.
//
//  - The evaluator's "MandateState" is not a mandate record at all — it carries
//    per-request fields (`requestRevocationEpoch`, `leaseExpiryS`) that belong to
//    one payment, not to the mandate. So it is a distinct concept and gets a
//    distinct name, `PolicyState`, rather than being merged into API.md's type.
//    That also settles the one head-on conflict, `permittedCategories`: API.md's
//    `MandateState` keeps `CategoryCode[]`, and the on-chain bitmap form stays on
//    `PolicyState` where PolicyModule's `>> categoryCode & 1` actually needs it.
//
//  - `coreImageDigest` stays OFF the FactSheet, as API.md §3 has it. It is the
//    core's own attestation of what code is running; it is not a fact the agent
//    supplies, and putting it on the injection-safe boundary type would invite
//    exactly that. `PolicyFactSheet` adds it for the evaluator, and the core
//    fills it from its own config.

/** Signature validity for predicates 1-2. Cannot be re-derived off-chain, so it
 *  is supplied and merely recorded. */
export type SignaturesValid = {
  agent: boolean;
  core: boolean;
};

/**
 * A FactSheet plus the core image digest the decision is being made under.
 *
 * The digest is not part of the API.md FactSheet (see the note above); the core
 * attaches it from its own configuration immediately before evaluating.
 */
export type PolicyFactSheet = FactSheet & {
  /** 0x… 66 chars. Predicate 3 compares this to PolicyState.coreImageDigest. */
  coreImageDigest: string;
};

/**
 * Everything the evaluator needs that is not in the FactSheet: the authoritative
 * on-chain policy/account state, plus the per-request authorization envelope
 * vouched for by the dual signature.
 *
 * All money is integer paise. All timestamps here are UNIX *seconds*, to match
 * `block.timestamp` — note this differs from API.md's `MandateState`, which uses
 * milliseconds (`windowStartMs`, `lastHeartbeatMs`). The names differ too, so
 * the two cannot be confused at a call site.
 */
export type PolicyState = {
  // --- Tunable policy (constructor / setPolicy) ---
  perTxCapMinor: number;
  windowCapMinor: number;
  windowSeconds: number;
  cumulativeCapMinor: number;
  /** 256-bit category allow-list bitmap; bit i set => category index i permitted. */
  permittedCategories: bigint;
  tier2MinAgeDays: number;
  tier2MinSettledTxns: number;
  tier2MaxPriceBandZ: number;
  tier2CapMinor: number;

  // --- Attestation ---
  /** Approved core image; predicate 3 fails closed if this is the zero hash. */
  coreImageDigest: string;

  // --- Revocation / rolling accounting (mutable) ---
  revocationEpoch: number;
  /** UNIX seconds. 0 means "no window open". */
  windowStart: number;
  windowSpentMinor: number;
  cumulativeSpentMinor: number;
  /** Nonces already burned by recordSpend (predicate 6). */
  usedNonces: Set<number>;

  // --- Deadman / freeze (operational guard, ahead of the 14 predicates) ---
  /** UNIX seconds. */
  lastHeartbeat: number;
  deadmanSeconds: number;
  frozen: boolean;

  // --- Counterparty registry (authoritative tier per address) ---
  /** address -> tier {1,2,3}; absent/0 = unknown = blocked. */
  counterpartyRegistry: Map<string, number>;

  // --- Per-request authorization envelope (signed, not in the FactSheet) ---
  /** Epoch the request was signed under (predicate 4). */
  requestRevocationEpoch: number;
  /** Lease expiry, UNIX seconds (predicate 5: now > expiry => expired). */
  leaseExpiryS: number;

  // --- Metadata copied into the trace, not used in evaluation ---
  policyHash: string;
};

// ---------------------------------------------------------------------------
//  Runtime schemas
// ---------------------------------------------------------------------------

const hexAddress = z.string().regex(/^0x[0-9a-f]{40}$/, 'counterpartyId must be a 20-byte lower-hex address');
const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/, 'must be a 32-byte lower-hex hash');

const intInRange = (min: number, max: number, label: string) =>
  z.number().int(`${label} must be an integer`).min(min, `${label} >= ${min}`).max(max, `${label} <= ${max}`);

/**
 * API.md §3 FactSheetRules, exactly. `.strict()` rejects unknown keys so the
 * policy layer can never be handed attacker-authored text. Do not weaken this.
 */
export const FactSheetSchema = z
  .object({
    amountMinor: intInRange(0, 1_000_000_000, 'amountMinor'),
    currency: z.literal('INR'),
    categoryCode: z.enum(CATEGORY_CODES),
    counterpartyId: hexAddress,
    counterpartyTier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    counterpartyAgeDays: intInRange(0, 65_535, 'counterpartyAgeDays'),
    counterpartySettledTxns: intInRange(0, 4_294_967_295, 'counterpartySettledTxns'),
    priceBandZ: intInRange(-128, 127, 'priceBandZ'),
    taskId: z.string().regex(/^tsk_[0-9a-f]{6,}$/, 'taskId'),
    lineItemId: z.string().regex(/^li_[0-9a-f]{6,}_\d{2}$/, 'lineItemId'),
    leaseId: z.string().regex(/^lse_[0-9a-f]{6,}$/, 'leaseId'),
    nonce: z.number().int().min(0, 'nonce >= 0'),
  })
  .strict();

/** The evaluator's input: a FactSheet with the core's attested image digest. */
export const PolicyFactSheetSchema = FactSheetSchema.extend({
  coreImageDigest: hex32,
}).strict();

export const PolicyStateSchema = z
  .object({
    perTxCapMinor: z.number().int().min(0),
    windowCapMinor: z.number().int().min(0),
    windowSeconds: z.number().int().min(0),
    cumulativeCapMinor: z.number().int().min(0),
    permittedCategories: z.bigint().min(0n),
    tier2MinAgeDays: z.number().int().min(0),
    tier2MinSettledTxns: z.number().int().min(0),
    tier2MaxPriceBandZ: z.number().int().min(-128).max(127),
    tier2CapMinor: z.number().int().min(0),
    coreImageDigest: hex32.or(z.literal('0x' + '0'.repeat(64))),
    revocationEpoch: z.number().int().min(0),
    windowStart: z.number().int().min(0),
    windowSpentMinor: z.number().int().min(0),
    cumulativeSpentMinor: z.number().int().min(0),
    usedNonces: z.set(z.number().int().min(0)),
    lastHeartbeat: z.number().int().min(0),
    deadmanSeconds: z.number().int().min(0),
    frozen: z.boolean(),
    counterpartyRegistry: z.map(z.string(), z.number().int().min(0).max(3)),
    requestRevocationEpoch: z.number().int().min(0),
    leaseExpiryS: z.number().int().min(0),
    policyHash: z.string(),
  })
  .strict();
