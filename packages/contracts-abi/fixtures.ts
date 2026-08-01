// Shared demo fixtures. Import the contract types from this package once they
// are added; these values intentionally mirror docs/API.md §11 exactly.

export const FIXTURE_FACTSHEET_OK = {
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
} as const;

export const FIXTURE_FACTSHEET_COUNTERFEIT = {
  ...FIXTURE_FACTSHEET_OK,
  amountMinor: 376000,
  counterpartyId: '0xf1e2d3c4b5a6978869504132abcdef0123456789',
  counterpartyTier: 2,
  counterpartyAgeDays: 2,
  counterpartySettledTxns: 0,
  priceBandZ: -41,
  lineItemId: 'li_0c4e11_02',
  nonce: 1042,
} as const;

export const FIXTURE_TRACE_APPROVED = {
  decisionId: 'dec_a91f22',
  lineItemId: 'li_0c4e11_01',
  outcome: 'APPROVED',
  predicates: [
    { name: 'agentSignature', inputs: {}, expected: 'valid', actual: 'valid', passed: true, severity: 'hard' },
    { name: 'coreSignature', inputs: {}, expected: 'valid', actual: 'valid', passed: true, severity: 'hard' },
    { name: 'coreImage', inputs: {}, expected: 'sha256:9f2c…', actual: 'sha256:9f2c…', passed: true, severity: 'hard' },
    { name: 'revocationEpoch', inputs: { lease: 7 }, expected: '7', actual: '7', passed: true, severity: 'hard' },
    { name: 'leaseExpiry', inputs: {}, expected: '> now', actual: '+3.2s', passed: true, severity: 'hard' },
    { name: 'nonce', inputs: { nonce: 1041 }, expected: 'unused', actual: 'unused', passed: true, severity: 'hard' },
    { name: 'categoryPermitted', inputs: { code: 'PACKAGING' }, expected: 'permitted', actual: 'permitted', passed: true, severity: 'hard' },
    { name: 'counterpartyTier', inputs: { tier: 1 }, expected: 'tier 1 or 2', actual: 'tier 1', passed: true, severity: 'hard' },
    { name: 'perTxCap', inputs: {}, expected: '<= 2500000', actual: '940000', passed: true, severity: 'hard' },
    { name: 'windowCap', inputs: {}, expected: '<= 5000000', actual: '1284000', passed: true, severity: 'hard' },
    { name: 'cumulativeCap', inputs: {}, expected: '<= 20000000', actual: '1284000', passed: true, severity: 'hard' },
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
} as const;

export const FIXTURE_TRACE_HELD = {
  ...FIXTURE_TRACE_APPROVED,
  decisionId: 'dec_b02e91',
  lineItemId: 'li_0c4e11_02',
  outcome: 'HELD',
  bindingPredicate: 'counterpartyAge',
  amountMinor: 376000,
  counterpartyId: '0xf1e2d3c4b5a6978869504132abcdef0123456789',
  summary: 'Held. This vendor is 2 days old; vendors in this tier need 30. Nothing has been charged — cancel or let it settle in 90 seconds.',
} as const;

export const FIXTURE_TRACE_REFUSED = {
  ...FIXTURE_TRACE_APPROVED,
  decisionId: 'dec_c73d10',
  outcome: 'REFUSED',
  bindingPredicate: 'perTxCap',
  amountMinor: 4999000,
  summary: 'Refused. ₹49,990 exceeds the per-payment cap of ₹25,000. Nothing was charged.',
} as const;

export const FIXTURE_EVENTS = [
  { t: 'task.started', atMs: 1754049600000, taskId: 'tsk_0c4e11', kind: 'procure', description: 'Order 100 glass bottles, 500ml', mode: 'normal', plan: [] },
  { t: 'agent.thought', atMs: 1754049600400, taskId: 'tsk_0c4e11', text: 'Checking Meridian Packaging for 500ml stock…' },
  { t: 'quote.received', atMs: 1754049600900, lineItemId: 'li_0c4e11_01', vendorId: 'ven_meridian', amountMinor: 940000, simElapsedMs: 240000 },
  { t: 'payment.requested', atMs: 1754049601000, lineItemId: 'li_0c4e11_01', factSheet: FIXTURE_FACTSHEET_OK },
  { t: 'decision.made', atMs: 1754049601011, trace: FIXTURE_TRACE_APPROVED },
  { t: 'ceremony.round', atMs: 1754049601020, decisionId: 'dec_a91f22', round: 1, of: 3 },
  { t: 'ceremony.round', atMs: 1754049601090, decisionId: 'dec_a91f22', round: 2, of: 3 },
  { t: 'ceremony.round', atMs: 1754049601160, decisionId: 'dec_a91f22', round: 3, of: 3 },
  { t: 'payment.settled', atMs: 1754049601380, decisionId: 'dec_a91f22', txHash: '0x7e91…', balanceAfterMinor: 4060000 },
] as const;

export const FIXTURE_ATTACK_RUN = [
  { t: 'attack.attempt', atMs: 1754049700000, technique: 'structuring', classNumber: 1, blocked: true, revertReason: 'WindowCapExceeded', novel: false },
  { t: 'attack.attempt', atMs: 1754049700120, technique: 'lease replay', classNumber: 3, blocked: true, revertReason: 'NonceAlreadyUsed', novel: false },
  { t: 'attack.attempt', atMs: 1754049700240, technique: 'rail bypass', classNumber: 5, blocked: true, revertReason: 'InvalidCoreSignature', novel: false },
  { t: 'attack.attempt', atMs: 1754049700390, technique: 'nonce-gap timing exploit', classNumber: null, blocked: true, revertReason: 'LeaseExpired', novel: true },
] as const;
