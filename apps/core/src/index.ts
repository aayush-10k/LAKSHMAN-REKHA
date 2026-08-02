export { evaluate } from './evaluator.js';
export { summarize, explain, money, reasonFor } from './explain.js';
export {
  FactSheetSchema,
  PolicyFactSheetSchema,
  PolicyStateSchema,
  CATEGORY_CODES,
  CATEGORY_INDEX,
  PREDICATE_NAMES,
  SOFT_FAIL_AGE,
  SOFT_FAIL_SETTLED,
  SOFT_FAIL_PRICE,
} from './types.js';
// --- A6: lease issuer ---
export {
  issueLease,
  validateLease,
  leaseDigest,
  getLease,
  leaseStoreSize,
  clearLeaseStore,
  mandateIdFor,
  RevokedError,
  LeaseInvalidError,
  LEASE_TTL_MS,
  type Lease,
} from './lease/index.js';

// --- A7: 2-of-2 signing service ---
export {
  coreSign,
  agentSign,
  buildPaymentRequest,
  hashRequest,
  leaseIdToBytes32,
  CHAIN_ID,
  POLICY_MODULE_ADDRESS,
  REKHA_ACCOUNT_ADDRESS,
  INRX_ADDRESS,
  CORE_SIGNER_ADDRESS,
  AGENT_SIGNER_ADDRESS,
  DEPLOYED_TARGET,
  type CoreSignResult,
  type PaymentRequestStruct,
  type PolicyTarget,
} from './signing/index.js';

// --- key shares ---
export {
  setCoreKey,
  setAgentKey,
  resetKeys,
  coreSignerAddress,
  agentSignerAddress,
} from './keys.js';

export type {
  Currency,
  CategoryCode,
  Outcome,
  CounterpartyTier,
  // API.md wire types
  FactSheet,
  MandateState,
  // evaluator-side types (see the reconciliation note in types.ts)
  PolicyFactSheet,
  PolicyState,
  SignaturesValid,
  Predicate,
  PredicateName,
  Severity,
  DecisionTrace,
} from './types.js';
