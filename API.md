# API.md — The Frozen Interfaces

**This file is the contract between the three workstreams.**

Nobody writes feature code until this is committed. After that, everyone builds against these shapes using the fixtures at the bottom — not against each other's running code.

**Schema version: 1.0.0** — bump the minor for additive changes, the major for anything breaking.

---

## 0. RULES FOR CHANGING THIS FILE

| Change | Cost | Process |
|---|---|---|
| **Add** an optional field | Cheap | Just do it. Note it in the PR title. Bump minor version. |
| **Add** a required field | Medium | Tell the other two in chat before merging. |
| **Rename / retype / redefine** a field | Expensive | All three agree, all three update in the **same commit**. |
| **Delete** a field | Expensive | Deprecate first, remove after everyone has migrated. |
| **Add a string field to `FactSheet`** | **Breaks the product** | See §3. Requires all three to explicitly sign off in writing. Default answer is no. |

**Never change a field in place.** Add the new one, migrate, delete the old one later. In-place changes break all three workstreams at the same moment and are the fastest way to lose a day.

---

## 1. PRIMITIVES — get these wrong and everything downstream is wrong

### Money

**All amounts are integers in paise. Never floats. Never rupees.**

```
₹9,400.00   →   940000
₹1.50       →   150
₹50,000.00  →   5000000
```

Field names carrying money **always** end in `Minor`. If a field holds money and doesn't end in `Minor`, it's a bug.

Formatting to "₹9,400.00" happens **only** in the frontend, at render time. No service ever sends a formatted string.

### Time

Milliseconds since epoch, as a `number`. Never ISO strings, never seconds.

```typescript
timestamp: 1754049600000   // ✅
timestamp: "2026-08-01T12:00:00Z"   // ❌
timestamp: 1754049600      // ❌ seconds
```

The simulated clock is separate and always labelled `simElapsedMs`.

### IDs

Prefixed strings. The prefix tells you what it is at a glance in a log.

| Prefix | Thing | Example |
|---|---|---|
| `agt_` | Agent | `agt_7f3a9b21` |
| `tsk_` | Task | `tsk_0c4e11` |
| `li_` | Line item | `li_0c4e11_02` |
| `dec_` | Decision | `dec_a91f22` |
| `lse_` | Lease | `lse_44b7e0` |
| `ven_` | Vendor | `ven_meridian` |

### Addresses and hashes

Lowercase `0x` hex strings, always. Addresses 42 chars, hashes 66 chars.

---

## 2. SHARED ENUMS

Closed sets. Adding a value is an additive change; removing one is breaking.

```typescript
type Currency = 'INR';

type CategoryCode =
  | 'PACKAGING'
  | 'ADVERTISING'
  | 'CONTENT'
  | 'COMPUTE'
  | 'LOGISTICS'
  | 'SOFTWARE'
  | 'UTILITIES'
  | 'OTHER';

type TaskKind =
  | 'procure'
  | 'ads'
  | 'content'
  | 'compute'
  | 'logistics'
  | 'subscription';

type BehaviourMode =
  | 'normal'
  | 'hallucinating'
  | 'injected'
  | 'compromised'
  | 'overreach'
  | 'colluding';

type Outcome = 'APPROVED' | 'HELD' | 'REFUSED';

type CounterpartyTier = 1 | 2 | 3;
// 1 = identity allowlist, full caps
// 2 = attribute allowlist, reduced caps, held if predicates fail
// 3 = hard block
```

---

## 3. FactSheet — THE SECURITY BOUNDARY

The single most important type in the system. Everything the policy engine ever sees.

```typescript
type FactSheet = {
  // what
  amountMinor: number;              // integer paise, 0 … 10_000_000_00
  currency: Currency;
  categoryCode: CategoryCode;

  // who
  counterpartyId: string;           // 0x… address, 42 chars lowercase
  counterpartyTier: CounterpartyTier;
  counterpartyAgeDays: number;      // 0 … 65535 — FROM THE REGISTRY, NOT THE PAGE
  counterpartySettledTxns: number;  // 0 … 4_294_967_295 — FROM THE REGISTRY

  // context
  priceBandZ: number;               // -128 … 127, integer. Deviation from market.

  // linkage
  taskId: string;
  lineItemId: string;
  leaseId: string;
  nonce: number;                    // uint64
};
```

### The rules that make this work

1. **No string field may ever be added that carries free text.** The `string` fields present are IDs and addresses with fixed formats, validated by regex. A field like `description`, `vendorName`, `note`, or `productTitle` would let attacker-authored prose reach the policy engine — which is exactly the attack we claim is impossible.

2. **Every field is range-checked on entry to the core.** Out of range → the whole extraction is rejected, nothing is evaluated, nothing is approved.

3. **`counterpartyAgeDays` and `counterpartySettledTxns` come from the vendor registry, never from the vendor's page.** A page cannot be allowed to claim its own age. This is the single line of defence against the counterfeit-storefront attack.

4. **`categoryCode` is looked up from a table**, never taken as text from a page.

### Validation, exact

```typescript
const FactSheetRules = {
  amountMinor:             { type: 'int', min: 0, max: 1_000_000_000 },
  currency:                { enum: ['INR'] },
  categoryCode:            { enum: CATEGORY_CODES },
  counterpartyId:          { regex: /^0x[0-9a-f]{40}$/ },
  counterpartyTier:        { enum: [1, 2, 3] },
  counterpartyAgeDays:     { type: 'int', min: 0, max: 65_535 },
  counterpartySettledTxns: { type: 'int', min: 0, max: 4_294_967_295 },
  priceBandZ:              { type: 'int', min: -128, max: 127 },
  taskId:                  { regex: /^tsk_[0-9a-f]{6,}$/ },
  lineItemId:              { regex: /^li_[0-9a-f]{6,}_\d{2}$/ },
  leaseId:                 { regex: /^lse_[0-9a-f]{6,}$/ },
  nonce:                   { type: 'int', min: 0 },
};
```

Unknown keys are **dropped silently and logged**, never passed through.

---

## 4. DecisionTrace — Key 2's testimony

Produced by A's evaluator. Carried by B. Rendered by C.

```typescript
type Predicate = {
  name: PredicateName;
  inputs: Record<string, number | string>;
  expected: string;       // human-readable, e.g. '<= 2500000'
  actual: string;         // human-readable, e.g. '940000'
  passed: boolean;
  severity: 'hard' | 'soft';   // hard → REFUSED, soft → HELD
};

type DecisionTrace = {
  decisionId: string;
  lineItemId: string;
  outcome: Outcome;
  predicates: Predicate[];        // ALL of them, in evaluation order
  bindingPredicate: PredicateName | null;   // the one that decided it
  amountMinor: number;
  counterpartyId: string;
  policyHash: string;             // 0x… 66 chars
  coreImageDigest: string;        // sha256:… — what code decided this
  evaluatedAtMs: number;
  latencyMs: number;
  summary: string;                // English, rendered by A's template engine
  signature: string;              // core signs the whole trace
};
```

### Predicate names — must match Solidity custom errors exactly

Evaluation order is fixed. A's TypeScript evaluator and A's Solidity contract must run these in this order.

| # | `PredicateName` | Severity | Solidity custom error |
|---|---|---|---|
| 1 | `agentSignature` | hard | `InvalidAgentSignature` |
| 2 | `coreSignature` | hard | `InvalidCoreSignature` |
| 3 | `coreImage` | hard | `CoreImageMismatch` |
| 4 | `revocationEpoch` | hard | `StaleRevocationEpoch` |
| 5 | `leaseExpiry` | hard | `LeaseExpired` |
| 6 | `nonce` | hard | `NonceAlreadyUsed` |
| 7 | `categoryPermitted` | hard | `CategoryNotPermitted` |
| 8 | `counterpartyTier` | hard | `CounterpartyBlocked` |
| 9 | `counterpartyAge` | soft | `CounterpartyTooNew` |
| 10 | `counterpartySettled` | soft | `CounterpartyUnproven` |
| 11 | `priceBand` | soft | `PriceOutsideBand` |
| 12 | `perTxCap` | hard | `PerTxCapExceeded` |
| 13 | `windowCap` | hard | `WindowCapExceeded` |
| 14 | `cumulativeCap` | hard | `CumulativeCapExceeded` |

**Outcome rules:**
- Any `hard` predicate fails → `REFUSED`, stop evaluating, that's the binding predicate
- All hard pass, any `soft` fails → `HELD`, first failing soft is binding
- All pass → `APPROVED`, `bindingPredicate` is `null`
- **Anything unexpected → `REFUSED`.** Never fall through to approval.

**Tier logic:** tier 1 skips predicates 9–11 entirely. Tier 3 fails predicate 8. Tier 2 runs 9–11.

---

## 5. Mandate state

```typescript
type MandateState = {
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
  tier2CapMinor: number;            // reduced cap for tier-2 counterparties

  lastHeartbeatMs: number;
  deadmanSeconds: number;
  frozen: boolean;
};
```

---

## 6. HTTP API

Base: `/v1`. All responses JSON. All errors use §7.

### `POST /agent/pair`
```typescript
Request:  { pairingCode: string }        // 6 chars, shown in the console
Response: { agentId: string; shareA: string; mandateId: string }
```

### `POST /lease/renew`
```typescript
Request:  { agentId: string }
Response: {
  leaseId: string;
  expiresAtMs: number;       // now + 5000
  revocationEpoch: number;
  policyHash: string;
  signature: string;
}
```
Returns `409 REVOKED` if the mandate is frozen. Returns nothing renewable if the core is down — **that is the fail-closed path, and it is correct behaviour.**

### `POST /payment/request`
```typescript
Request:  { factSheet: FactSheet }
Response: {
  decisionId: string;
  outcome: Outcome;
  trace: DecisionTrace;
  partialSig: string | null;   // core's signature share, only when APPROVED
  holdExpiresAtMs: number | null;  // only when HELD
}
```

### `POST /payment/settle`
```typescript
Request:  { decisionId: string; agentSig: string }
Response: { txHash: string; balanceAfterMinor: number; blockNumber: number }
```

### `POST /hold/cancel`
```typescript
Request:  { decisionId: string }
Response: { released: true; amountMinor: number }
```

### `POST /task/create`
```typescript
Request:  { description: string; mode: BehaviourMode }
Response: { taskId: string; plan: LineItem[] }

type LineItem = {
  lineItemId: string;
  vendorId: string;
  categoryCode: CategoryCode;
  estimatedAmountMinor: number;
  description: string;   // display only — NEVER enters a FactSheet
};
```

> Note the `description` field here. It is safe **only** because it never crosses into the core. If anyone wires it into a `FactSheet`, the security model is gone.

### `GET /events`
Server-Sent Events. See §8.

### `GET /audit/export`
```typescript
Response: {
  version: '1.0.0';
  mandateId: string;
  exportedAtMs: number;
  decisions: DecisionTrace[];
  settlements: Array<{ decisionId: string; txHash: string; blockNumber: number }>;
  revocations: Array<{ epoch: number; source: string; atMs: number }>;
  signature: string;
}
```

---

## 7. ERROR SHAPE

Every non-2xx response:

```typescript
type ApiError = {
  error: {
    code: string;        // machine-readable, SCREAMING_SNAKE
    message: string;     // human-readable, safe to show a user
    predicate?: PredicateName;
    decisionId?: string;
  };
};
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `FACTSHEET_INVALID` | Range check or regex failed |
| 401 | `UNAUTHENTICATED` | No session |
| 403 | `LEASE_EXPIRED` | Lease TTL passed |
| 403 | `REVOKED` | `revocationEpoch` moved |
| 403 | `FROZEN` | Dead-man or manual freeze |
| 409 | `NONCE_USED` | Replay |
| 409 | `DECISION_NOT_APPROVED` | Settle attempted on a HELD/REFUSED decision |
| 422 | `POLICY_REFUSED` | Evaluator returned REFUSED — `predicate` names which |
| 429 | `RATE_LIMITED` | ~~Lease-renewal griefing defence~~ — **NOT IMPLEMENTED.** No rate limiting exists anywhere in the core, so nothing can currently return this. Attack class 12 is stopped by the fail-closed property only (no leases → spending stops), which is a different and weaker claim. Documented here rather than deleted so the gap is visible instead of merely absent |
| 503 | `CORE_UNAVAILABLE` | Fail-closed. **Never retried into an approval.** |

---

## 8. EVENT STREAM

`GET /v1/events` — SSE. Every message is one `RekhaEvent`. C listens to this and to nothing else.

```typescript
type RekhaEvent =
  | { t: 'task.started';      atMs: number; taskId: string; kind: TaskKind;
      description: string; plan: LineItem[]; mode: BehaviourMode }
  | { t: 'agent.thought';     atMs: number; taskId: string; text: string }
  | { t: 'quote.received';    atMs: number; lineItemId: string; vendorId: string;
      amountMinor: number; simElapsedMs: number }
  | { t: 'payment.requested'; atMs: number; lineItemId: string; factSheet: FactSheet }
  | { t: 'decision.made';     atMs: number; trace: DecisionTrace }
  | { t: 'ceremony.round';    atMs: number; decisionId: string; round: number; of: number }
  | { t: 'ceremony.aborted';  atMs: number; decisionId: string; atRound: number;
      reason: 'revoked' | 'timeout' }
  | { t: 'payment.settled';   atMs: number; decisionId: string; txHash: string;
      balanceAfterMinor: number }
  | { t: 'payment.held';      atMs: number; decisionId: string; expiresAtMs: number;
      amountMinor: number }
  | { t: 'hold.released';     atMs: number; decisionId: string; amountMinor: number }
  | { t: 'revocation';        atMs: number; epoch: number;
      source: 'owner' | 'guardian' | 'deadman'; latencyMs: number }
  | { t: 'lease.tick';        atMs: number; leaseId: string; ttlMs: number }
  | { t: 'attack.attempt';    atMs: number; technique: string; classNumber: number | null;
      blocked: boolean; revertReason: string; novel: boolean }
  | { t: 'core.status';       atMs: number; up: boolean; imageDigest: string };
```

**`agent.thought` is display-only.** It is attacker-influenced text. Render it, never parse it, never let it drive logic.

**`ceremony.round` and `ceremony.aborted` drive demo moment M3.** They must fire reliably.

**`attack.attempt` drives the Rogue Mode scoreboard (M2).** `novel: true` marks LLM-generated variants.

---

## 9. ON-CHAIN INTERFACE

What A deploys and C reads directly from the browser.

```solidity
struct PaymentRequest {
    uint256 amountMinor;
    address counterparty;
    uint8   counterpartyTier;
    uint16  counterpartyAgeDays;
    uint32  counterpartySettledTxns;
    int8    priceBandZ;
    uint8   categoryCode;
    bytes32 leaseId;
    uint64  nonce;
    uint64  revocationEpoch;
    uint64  leaseExpiry;
}

// PolicyModule
function validate(PaymentRequest calldata req, bytes calldata agentSig, bytes calldata coreSig) external view returns (bool);
function revoke() external;                 // owner or guardian
function heartbeat() external;              // owner
function checkDeadman() external;           // anyone
function revocationEpoch() external view returns (uint64);
function policyHash() external view returns (bytes32);
function coreImageDigest() external view returns (bytes32);

// RekhaAccount
function execute(PaymentRequest calldata req, bytes calldata agentSig, bytes calldata coreSig) external;
function balanceMinor() external view returns (uint256);

// Events
event PaymentExecuted(bytes32 indexed decisionId, address counterparty, uint256 amountMinor);
event Revoked(uint64 newEpoch, address by);
event PolicyUpdated(bytes32 newPolicyHash);
```

**Custom errors** — names must match §4 exactly. C reads these off failed transactions and shows them verbatim to the judge, so they are user-facing copy.

**C's REVOKE ALL button calls `PolicyModule.revoke()` directly from the user's wallet.** It must not go through B's API. That independence is the kill-switch score.

---

## 10. WHO PRODUCES, WHO CONSUMES

| Type | Produced by | Consumed by |
|---|---|---|
| `FactSheet` | B (extractor) | A (evaluator), C (display) |
| `DecisionTrace` | A (evaluator) | B (API), C (decision panel) |
| `MandateState` | A (contract + core) | B, C |
| `LineItem` | B (task engine) | C |
| `RekhaEvent` | B (event bus) | C |
| Custom errors | A (contract) | C (rendered verbatim) |
| `ApiError` | B | C |

**Read it this way:** if you *produce* a type, this file tells you what you must emit. If you *consume* one, this file tells you what you may rely on. Anything not written here, you may not rely on.

---

## 11. FIXTURES — build against these from day one

Copy into `packages/contracts-abi/fixtures.ts`. Every one is valid under §3–§8. C builds the entire UI from these before B's services exist.

```typescript
export const FIXTURE_FACTSHEET_OK: FactSheet = {
  amountMinor: 940000,
  currency: 'INR',
  categoryCode: 'PACKAGING',
  counterpartyId: '0x8a3f21d0c4b9e7f6a1d2c3b4e5f6a7b8c9d0e1f2',
  counterpartyTier: 1,
  counterpartyAgeDays: 412,
  counterpartySettledTxns: 1183,
  priceBandZ: 2,
  taskId: 'tsk_0c4e11',
  lineItemId: 'li_0c4e11_01',
  leaseId: 'lse_44b7e0',
  nonce: 1041,
};

export const FIXTURE_FACTSHEET_COUNTERFEIT: FactSheet = {
  ...FIXTURE_FACTSHEET_OK,
  amountMinor: 376000,
  counterpartyId: '0xf1e2d3c4b5a6978869504132abcdef0123456789',
  counterpartyTier: 2,
  counterpartyAgeDays: 2,
  counterpartySettledTxns: 0,
  priceBandZ: -41,
  lineItemId: 'li_0c4e11_02',
  nonce: 1042,
};

export const FIXTURE_TRACE_APPROVED: DecisionTrace = {
  decisionId: 'dec_a91f22',
  lineItemId: 'li_0c4e11_01',
  outcome: 'APPROVED',
  predicates: [
    { name: 'agentSignature',   inputs: {}, expected: 'valid', actual: 'valid', passed: true,  severity: 'hard' },
    { name: 'coreSignature',    inputs: {}, expected: 'valid', actual: 'valid', passed: true,  severity: 'hard' },
    { name: 'coreImage',        inputs: {}, expected: 'sha256:9f2c…', actual: 'sha256:9f2c…', passed: true, severity: 'hard' },
    { name: 'revocationEpoch',  inputs: { lease: 7 }, expected: '7', actual: '7', passed: true, severity: 'hard' },
    { name: 'leaseExpiry',      inputs: {}, expected: '> now', actual: '+3.2s', passed: true, severity: 'hard' },
    { name: 'nonce',            inputs: { nonce: 1041 }, expected: 'unused', actual: 'unused', passed: true, severity: 'hard' },
    { name: 'categoryPermitted',inputs: { code: 'PACKAGING' }, expected: 'permitted', actual: 'permitted', passed: true, severity: 'hard' },
    { name: 'counterpartyTier', inputs: { tier: 1 }, expected: 'tier 1 or 2', actual: 'tier 1', passed: true, severity: 'hard' },
    { name: 'perTxCap',         inputs: {}, expected: '<= 2500000', actual: '940000', passed: true, severity: 'hard' },
    { name: 'windowCap',        inputs: {}, expected: '<= 5000000', actual: '1284000', passed: true, severity: 'hard' },
    { name: 'cumulativeCap',    inputs: {}, expected: '<= 20000000', actual: '1284000', passed: true, severity: 'hard' },
  ],
  bindingPredicate: null,
  amountMinor: 940000,
  counterpartyId: '0x8a3f21d0c4b9e7f6a1d2c3b4e5f6a7b8c9d0e1f2',
  policyHash: '0x4c1b…',
  coreImageDigest: 'sha256:9f2c…',
  evaluatedAtMs: 1754049600000,
  latencyMs: 11,
  summary: 'Approved. ₹9,400 to Meridian Packaging — known vendor, within all caps.',
  signature: '0xab34…',
};

export const FIXTURE_TRACE_HELD: DecisionTrace = {
  ...FIXTURE_TRACE_APPROVED,
  decisionId: 'dec_b02e91',
  lineItemId: 'li_0c4e11_02',
  outcome: 'HELD',
  bindingPredicate: 'counterpartyAge',
  amountMinor: 376000,
  counterpartyId: '0xf1e2d3c4b5a6978869504132abcdef0123456789',
  summary: 'Held. This vendor is 2 days old; vendors in this tier need 30. Nothing has been charged — cancel or let it settle in 90 seconds.',
};

export const FIXTURE_TRACE_REFUSED: DecisionTrace = {
  ...FIXTURE_TRACE_APPROVED,
  decisionId: 'dec_c73d10',
  outcome: 'REFUSED',
  bindingPredicate: 'perTxCap',
  amountMinor: 4999000,
  summary: 'Refused. ₹49,990 exceeds the per-payment cap of ₹25,000. Nothing was charged.',
};

export const FIXTURE_EVENTS: RekhaEvent[] = [
  { t: 'task.started', atMs: 1754049600000, taskId: 'tsk_0c4e11', kind: 'procure',
    description: 'Order 100 glass bottles, 500ml', mode: 'normal', plan: [] },
  { t: 'agent.thought', atMs: 1754049600400, taskId: 'tsk_0c4e11',
    text: 'Checking Meridian Packaging for 500ml stock…' },
  { t: 'quote.received', atMs: 1754049600900, lineItemId: 'li_0c4e11_01',
    vendorId: 'ven_meridian', amountMinor: 940000, simElapsedMs: 240000 },
  { t: 'payment.requested', atMs: 1754049601000, lineItemId: 'li_0c4e11_01',
    factSheet: FIXTURE_FACTSHEET_OK },
  { t: 'decision.made', atMs: 1754049601011, trace: FIXTURE_TRACE_APPROVED },
  { t: 'ceremony.round', atMs: 1754049601020, decisionId: 'dec_a91f22', round: 1, of: 3 },
  { t: 'ceremony.round', atMs: 1754049601090, decisionId: 'dec_a91f22', round: 2, of: 3 },
  { t: 'ceremony.round', atMs: 1754049601160, decisionId: 'dec_a91f22', round: 3, of: 3 },
  { t: 'payment.settled', atMs: 1754049601380, decisionId: 'dec_a91f22',
    txHash: '0x7e91…', balanceAfterMinor: 4060000 },
];

export const FIXTURE_ATTACK_RUN: RekhaEvent[] = [
  { t: 'attack.attempt', atMs: 1754049700000, technique: 'structuring',
    classNumber: 1, blocked: true, revertReason: 'WindowCapExceeded', novel: false },
  { t: 'attack.attempt', atMs: 1754049700120, technique: 'lease replay',
    classNumber: 3, blocked: true, revertReason: 'NonceAlreadyUsed', novel: false },
  { t: 'attack.attempt', atMs: 1754049700240, technique: 'rail bypass',
    classNumber: 5, blocked: true, revertReason: 'InvalidCoreSignature', novel: false },
  { t: 'attack.attempt', atMs: 1754049700390, technique: 'nonce-gap timing exploit',
    classNumber: null, blocked: true, revertReason: 'LeaseExpired', novel: true },
];
```

---

## 12. THE CONTRACT TEST — your safety net

Add this to CI. It fails in seconds when shapes drift, instead of at integration.

```typescript
// packages/contracts-abi/contract.test.ts
import { z } from 'zod';
import * as F from './fixtures';

const FactSheetSchema = z.object({
  amountMinor: z.number().int().min(0).max(1_000_000_000),
  currency: z.literal('INR'),
  categoryCode: z.enum(CATEGORY_CODES),
  counterpartyId: z.string().regex(/^0x[0-9a-f]{40}$/),
  counterpartyTier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  counterpartyAgeDays: z.number().int().min(0).max(65_535),
  counterpartySettledTxns: z.number().int().min(0),
  priceBandZ: z.number().int().min(-128).max(127),
  taskId: z.string().regex(/^tsk_[0-9a-f]{6,}$/),
  lineItemId: z.string().regex(/^li_[0-9a-f]{6,}_\d{2}$/),
  leaseId: z.string().regex(/^lse_[0-9a-f]{6,}$/),
  nonce: z.number().int().min(0),
}).strict();   // .strict() — extra keys FAIL. This is the injection guard.

test('every fixture satisfies its schema', () => {
  FactSheetSchema.parse(F.FIXTURE_FACTSHEET_OK);
  FactSheetSchema.parse(F.FIXTURE_FACTSHEET_COUNTERFEIT);
});

test('FactSheet has no free-text string fields', () => {
  const ALLOWED_STRINGS = ['currency','categoryCode','counterpartyId','taskId','lineItemId','leaseId'];
  const actual = Object.entries(F.FIXTURE_FACTSHEET_OK)
    .filter(([, v]) => typeof v === 'string').map(([k]) => k);
  expect(actual.sort()).toEqual(ALLOWED_STRINGS.sort());
  // If this fails, someone added a text field to the security boundary.
  // Do not "fix" it by updating ALLOWED_STRINGS. Talk to the other two.
});

test('predicate names match Solidity custom errors', () => {
  const solidityErrors = readCustomErrorsFromABI('PolicyModule');
  for (const [predicate, error] of PREDICATE_ERROR_MAP) {
    expect(solidityErrors).toContain(error);
  }
});

test('no money field is a float or misnamed', () => {
  for (const obj of [F.FIXTURE_FACTSHEET_OK, F.FIXTURE_TRACE_APPROVED]) {
    for (const [k, v] of Object.entries(obj)) {
      if (k.endsWith('Minor')) expect(Number.isInteger(v)).toBe(true);
    }
  }
});
```

---

## 13. IF SOMETHING ISN'T IN THIS FILE

**Person C:** you need a field that doesn't exist. Don't invent it, don't fake it in the component, don't `any` it. Post in the group chat: *"decision panel needs X — who produces it?"* Then it gets added here first, and to code second.

**Person B:** you're passing something through that isn't defined. Either define it here or stop passing it. Undefined data in the stream is how C's screens break silently in front of a judge.

**Person A:** your evaluator emits something the trace doesn't describe. Add it to `Predicate.inputs` — that field is deliberately open so you can enrich a trace without a schema change. Anything structural comes here first.

**The instinct to fix a mismatch locally is the thing to resist.** A quick cast in one file becomes three incompatible mental models by evening. Ninety seconds editing this file saves an hour of integration.