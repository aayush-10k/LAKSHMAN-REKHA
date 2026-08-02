import type { DecisionTrace, Predicate, PredicateName } from './types.js';

// Templates only — no LLM. This text is read by a non-technical owner and by
// judges: say what happened and what it means for their money, always state
// whether money moved, never apologise, never hedge, never say "error".

/** Paise -> "₹X" / "₹X.YZ" with Indian digit grouping. */
export function money(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const rem = paise % 100;
  const grouped = groupIndian(rupees);
  return rem === 0 ? `₹${grouped}` : `₹${grouped}.${String(rem).padStart(2, '0')}`;
}

function groupIndian(n: number): string {
  const s = Math.trunc(n).toString();
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  let rest = s.slice(0, -3);
  const parts: string[] = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) parts.unshift(rest);
  return `${parts.join(',')},${last3}`;
}

/** Short, readable form of a 20-byte address. */
function shortCp(id: string): string {
  return id.length >= 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

/** Friendly label for each predicate (used in the full breakdown). */
const LABELS: Readonly<Record<PredicateName, string>> = {
  agentSignature: 'Agent signature',
  coreSignature: 'Core signature',
  coreImage: 'Core software image',
  revocationEpoch: 'Authorisation current',
  leaseExpiry: 'Payment lease valid',
  nonce: 'Not already paid',
  categoryPermitted: 'Category permitted',
  counterpartyTier: 'Counterparty approved',
  counterpartyAge: 'Counterparty age',
  counterpartySettled: 'Counterparty track record',
  priceBand: 'Price within range',
  perTxCap: 'Per-payment cap',
  windowCap: 'Window spending limit',
  cumulativeCap: 'Lifetime spending limit',
};

function num(p: Predicate, key: string): number {
  const v = p.inputs[key];
  return typeof v === 'number' ? v : Number(v ?? 0);
}
function str(p: Predicate, key: string): string {
  const v = p.inputs[key];
  return v === undefined ? '' : String(v);
}

/**
 * One human sentence explaining why a predicate failed. There is exactly one
 * template per predicate; every branch is covered by an explain.test.ts case,
 * and none may render the literal "undefined".
 */
export function reasonFor(p: Predicate): string {
  switch (p.name) {
    case 'agentSignature':
      return 'the agent did not sign this payment';
    case 'coreSignature':
      return 'the core did not sign this payment';
    case 'coreImage':
      return 'the core is not running the approved software image';
    case 'revocationEpoch':
      return 'this payment was authorised under an old, since-revoked mandate';
    case 'leaseExpiry':
      return 'the payment lease had already expired';
    case 'nonce':
      return 'this payment was already made once';
    case 'categoryPermitted':
      return `${str(p, 'categoryCode').toLowerCase()} payments are not permitted`;
    case 'counterpartyTier':
      return 'this counterparty is not approved for payments';
    case 'counterpartyAge': {
      return `the counterparty is newer than allowed (${num(p, 'ageDays')} days, needs ${num(p, 'minAgeDays')})`;
    }
    case 'counterpartySettled':
      return `the counterparty has too few settled payments (${num(p, 'settledTxns')}, needs ${num(p, 'minSettledTxns')})`;
    case 'priceBand':
      return 'the price is outside the expected range';
    case 'perTxCap': {
      const perTx = num(p, 'perTxCapMinor');
      const hasTier2 = p.inputs.tier2CapMinor !== undefined;
      const cap = hasTier2 ? Math.min(perTx, num(p, 'tier2CapMinor')) : perTx;
      return `${money(num(p, 'amountMinor'))} is over the ${money(cap)} per-payment cap`;
    }
    case 'windowCap':
      return `${money(num(p, 'amountMinor'))} would exceed the ${money(num(p, 'windowCapMinor'))} limit for the current spending window`;
    case 'cumulativeCap':
      return `${money(num(p, 'amountMinor'))} would exceed the ${money(num(p, 'cumulativeCapMinor'))} lifetime spending limit`;
  }
}

function bindingReason(trace: DecisionTrace): string {
  const b = trace.bindingPredicate;
  if (b === null) return '';
  const pred = trace.predicates.find((p) => p.name === b);
  return pred ? reasonFor(pred) : '';
}

function softFailReasons(trace: DecisionTrace): string[] {
  return trace.predicates.filter((p) => p.severity === 'soft' && !p.passed).map(reasonFor);
}

/** One line for the transaction feed. */
export function summarize(trace: DecisionTrace): string {
  const amt = money(trace.amountMinor);
  const cp = shortCp(trace.counterpartyId);

  switch (trace.outcome) {
    case 'APPROVED':
      return `Approved. ${amt} was paid to ${cp}.`;
    case 'HELD': {
      const reasons = softFailReasons(trace);
      const because = reasons.length > 0 ? reasons.join('; ') : 'it needs review';
      return `On hold. ${amt} to ${cp} is on hold because ${because} — cancel it or let it settle.`;
    }
    case 'REFUSED': {
      // Operational freeze: no predicates were even evaluated.
      if (trace.bindingPredicate === null) {
        if (trace.predicates.length === 0) {
          return `Refused. Spending is frozen right now. Nothing was charged.`;
        }
        return `Refused. This payment did not pass policy. Nothing was charged.`;
      }
      return `Refused. ${capitalise(bindingReason(trace))}. Nothing was charged.`;
    }
  }
}

/** Full breakdown for the decision panel. */
export function explain(trace: DecisionTrace): string {
  const amt = money(trace.amountMinor);
  const cp = shortCp(trace.counterpartyId);
  const lines: string[] = [];

  lines.push(summarize(trace));
  lines.push('');
  lines.push(`Counterparty: ${cp}`);
  lines.push(`Amount: ${amt}`);

  if (trace.predicates.length > 0) {
    lines.push('');
    lines.push('Checks:');
    for (const p of trace.predicates) {
      const mark = p.passed ? '✓' : '✗';
      const label = LABELS[p.name];
      lines.push(p.passed ? `  ${mark} ${label}` : `  ${mark} ${label} — ${reasonFor(p)}`);
    }
  }

  lines.push('');
  switch (trace.outcome) {
    case 'APPROVED':
      lines.push(`${amt} was paid to ${cp}.`);
      break;
    case 'HELD': {
      const reasons = softFailReasons(trace);
      if (reasons.length > 0) {
        lines.push(`On hold because ${reasons.join('; ')}.`);
      }
      lines.push(`${amt} is on hold — cancel it or let it settle.`);
      break;
    }
    case 'REFUSED':
      lines.push('Nothing was charged.');
      break;
  }

  return lines.join('\n');
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
