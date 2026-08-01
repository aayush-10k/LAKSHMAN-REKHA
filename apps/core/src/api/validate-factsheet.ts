/**
 * FactSheet validation — mirrors API.md §3 FactSheetRules exactly.
 * Every field range-checked on entry to the core.
 * Any field out of range → whole extraction rejected.
 * Unknown keys dropped silently and logged.
 *
 * CRITICAL: no free-text string field may ever pass through here.
 * If you see a proposed addition of description/vendorName/note → reject it.
 */

import { z } from 'zod';
import type { FactSheet } from '../types.js';

const CATEGORY_CODES = ['PACKAGING', 'ADVERTISING', 'CONTENT', 'COMPUTE', 'LOGISTICS', 'SOFTWARE', 'UTILITIES', 'OTHER'] as const;

export const FactSheetSchema = z.object({
  amountMinor:             z.number().int().min(0).max(1_000_000_000),
  currency:                z.literal('INR'),
  categoryCode:            z.enum(CATEGORY_CODES),
  counterpartyId:          z.string().regex(/^0x[0-9a-f]{40}$/),
  counterpartyTier:        z.union([z.literal(1), z.literal(2), z.literal(3)]),
  counterpartyAgeDays:     z.number().int().min(0).max(65_535),
  counterpartySettledTxns: z.number().int().min(0).max(4_294_967_295),
  priceBandZ:              z.number().int().min(-128).max(127),
  taskId:                  z.string().regex(/^tsk_[0-9a-f]{6,}$/),
  lineItemId:              z.string().regex(/^li_[0-9a-f]{6,}_\d{2}$/),
  leaseId:                 z.string().regex(/^lse_[0-9a-f]{6,}$/),
  nonce:                   z.number().int().min(0),
}).strict(); // .strict() — extra keys FAIL. This is the injection guard.

export type ValidationResult =
  | { ok: true; factSheet: FactSheet }
  | { ok: false; reason: string; fields: string[] };

/**
 * Validate and strip an untrusted object into a FactSheet.
 * Unknown keys are dropped before parsing (defense in depth).
 */
export function validateFactSheet(raw: unknown): ValidationResult {
  // Strip unknown keys before parsing — belt-and-suspenders
  const stripped = stripUnknown(raw);
  const result = FactSheetSchema.safeParse(stripped);

  if (result.success) {
    return { ok: true, factSheet: result.data as FactSheet };
  }

  const fields = result.error.issues.map((i) => i.path.join('.'));
  const reason = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  console.error('[factsheet] validation failed:', reason);
  return { ok: false, reason, fields };
}

const ALLOWED_KEYS = new Set([
  'amountMinor', 'currency', 'categoryCode', 'counterpartyId',
  'counterpartyTier', 'counterpartyAgeDays', 'counterpartySettledTxns',
  'priceBandZ', 'taskId', 'lineItemId', 'leaseId', 'nonce',
]);

function stripUnknown(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const dropped: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (ALLOWED_KEYS.has(k)) {
      out[k] = v;
    } else {
      dropped.push(k);
    }
  }
  if (dropped.length > 0) {
    console.warn('[factsheet] stripped unknown keys:', dropped.join(', '));
  }
  return out;
}
