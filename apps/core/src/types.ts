import { z } from 'zod';

// ---------------------------------------------------------------------------
//  Primitive enums / unions
// ---------------------------------------------------------------------------

export type Currency = 'INR';

// Order matters: the index of each code IS the bit position the on-chain
// `permittedCategories` bitmap uses (PolicyModule._categoryPermitted does
// `(permittedCategories >> categoryCode) & 1`). The Solidity `categoryCode` is a
// uint8; this array is the single source of truth mapping the string form used
// off-chain to that integer. Do not reorder.
export const CATEGORY_CODES = [
  'PACKAGING', // 0
  'ADVERTISING', // 1
  'CONTENT', // 2
  'COMPUTE', // 3
  'LOGISTICS', // 4
  'SOFTWARE', // 5
  'UTILITIES', // 6
  'OTHER', // 7
] as const;

export type CategoryCode = (typeof CATEGORY_CODES)[number];

/** String category code -> its integer bit index, mirroring the Solidity uint8. */
export const CATEGORY_INDEX: Readonly<Record<CategoryCode, number>> = Object.freeze(
  Object.fromEntries(CATEGORY_CODES.map((c, i) => [c, i])) as Record<CategoryCode, number>,
);

export type Outcome = 'APPROVED' | 'HELD' | 'REFUSED';
export type CounterpartyTier = 1 | 2 | 3;

// The 14 predicates, in the fixed order PolicyModule.validate evaluates them.
export const PREDICATE_NAMES = [
  'agentSignature', // 1  hard
  'coreSignature', // 2  hard
  'coreImage', // 3  hard
  'revocationEpoch', // 4  hard
  'leaseExpiry', // 5  hard
  'nonce', // 6  hard
  'categoryPermitted', // 7  hard
  'counterpartyTier', // 8  hard
  'counterpartyAge', // 9  soft
  'counterpartySettled', // 10 soft
  'priceBand', // 11 soft
  'perTxCap', // 12 hard
  'windowCap', // 13 hard
  'cumulativeCap', // 14 hard
] as const;

export type PredicateName = (typeof PREDICATE_NAMES)[number];

export type Severity = 'hard' | 'soft';

// Soft-fail bitmask bits, matching PolicyModule.SOFT_FAIL_* constants.
export const SOFT_FAIL_AGE = 0x1; // bit0 -> predicate 9  (counterpartyAge)
export const SOFT_FAIL_SETTLED = 0x2; // bit1 -> predicate 10 (counterpartySettled)
export const SOFT_FAIL_PRICE = 0x4; // bit2 -> predicate 11 (priceBand)

// ---------------------------------------------------------------------------
//  FactSheet — mirrors PaymentRequest's policy-relevant, injection-safe facts.
// ---------------------------------------------------------------------------
//
// CRITICAL: no free-text string field ever. Every string here is an ID, address
// or hash constrained by a fixed regex. `.strict()` rejects unknown keys so the
// policy layer can never be handed attacker-authored text. Do not weaken this.

const hexAddress = z.string().regex(/^0x[0-9a-f]{40}$/, 'counterpartyId must be a 20-byte lower-hex address');
const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/, 'must be a 32-byte lower-hex hash');

const intInRange = (min: number, max: number, label: string) =>
  z.number().int(`${label} must be an integer`).min(min, `${label} >= ${min}`).max(max, `${label} <= ${max}`);

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
    coreImageDigest: hex32,
    taskId: z.string().regex(/^tsk_[0-9a-f]{6,}$/, 'taskId'),
    lineItemId: z.string().regex(/^li_[0-9a-f]{6,}_\d{2}$/, 'lineItemId'),
    leaseId: z.string().regex(/^lse_[0-9a-f]{6,}$/, 'leaseId'),
    nonce: z.number().int().min(0, 'nonce >= 0'),
  })
  .strict();

export type FactSheet = z.infer<typeof FactSheetSchema>;

// ---------------------------------------------------------------------------
//  MandateState — everything the evaluator needs that is NOT in the FactSheet.
// ---------------------------------------------------------------------------
//
// The FactSheet is deliberately narrow (injection-safe payment facts only), so
// the authoritative on-chain account/policy state plus the per-request
// authorization envelope (lease expiry, the epoch the request was signed under)
// live here instead. These are numbers/hashes vouched for by the dual signature,
// never attacker free-text — so keeping them out of the FactSheet costs nothing.
//
// All money is integer paise. All timestamps are UNIX seconds (to match
// block.timestamp). Amounts/caps are kept below Number.MAX_SAFE_INTEGER by
// construction so plain-number arithmetic is exact (see HANDOFF-TS.md).

export const MandateStateSchema = z
  .object({
    // --- Tunable policy (constructor / setPolicy) ---
    perTxCapMinor: z.number().int().min(0),
    windowCapMinor: z.number().int().min(0),
    windowSeconds: z.number().int().min(0),
    cumulativeCapMinor: z.number().int().min(0),
    /** 256-bit category allow-list bitmap; bit i set => category index i permitted. */
    permittedCategories: z.bigint().min(0n),
    tier2MinAgeDays: z.number().int().min(0),
    tier2MinSettledTxns: z.number().int().min(0),
    tier2MaxPriceBandZ: z.number().int().min(-128).max(127),
    tier2CapMinor: z.number().int().min(0),

    // --- Attestation / signer config ---
    /** Approved core image; predicate 3 fails closed if this is the zero hash. */
    coreImageDigest: hex32.or(z.literal('0x' + '0'.repeat(64))),

    // --- Revocation / rolling accounting (mutable) ---
    /** Current on-chain epoch (predicate 4 compares the request's epoch to this). */
    revocationEpoch: z.number().int().min(0),
    windowStart: z.number().int().min(0),
    windowSpentMinor: z.number().int().min(0),
    cumulativeSpentMinor: z.number().int().min(0),
    /** Nonces already burned by recordSpend (predicate 6). */
    usedNonces: z.set(z.number().int().min(0)),

    // --- Deadman / freeze (operational guard, ahead of the 14 predicates) ---
    lastHeartbeat: z.number().int().min(0),
    deadmanSeconds: z.number().int().min(0),
    frozen: z.boolean(),

    // --- Counterparty registry (authoritative tier per address) ---
    /** address -> tier {1,2,3}; absent/0 = unknown = blocked. */
    counterpartyRegistry: z.map(z.string(), z.number().int().min(0).max(3)),

    // --- Per-request authorization envelope (signed, not in the FactSheet) ---
    /** Epoch the request was signed under (predicate 4). */
    requestRevocationEpoch: z.number().int().min(0),
    /** Lease expiry, UNIX seconds (predicate 5: now > expiry => expired). */
    leaseExpiryS: z.number().int().min(0),

    // --- Metadata copied into the trace, not used in evaluation ---
    policyHash: z.string(),
  })
  .strict();

export type MandateState = z.infer<typeof MandateStateSchema>;

/** Signature validity for predicates 1-2. Cannot be re-derived off-chain, so it
 *  is supplied and merely recorded (see CLAUDE.md Part 2). */
export type SignaturesValid = {
  agent: boolean;
  core: boolean;
};

// ---------------------------------------------------------------------------
//  Trace types
// ---------------------------------------------------------------------------

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
  predicates: Predicate[]; // ALL evaluated, in order
  bindingPredicate: PredicateName | null;
  softFailBitmask: number; // bit0=age, bit1=settled, bit2=price
  amountMinor: number;
  counterpartyId: string;
  policyHash: string;
  coreImageDigest: string;
  evaluatedAtMs: number;
  latencyMs: number;
  summary: string;
  signature: string; // filled by the signing layer, '' here
};
