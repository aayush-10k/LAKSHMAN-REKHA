'use client';

import { useState } from 'react';
import type { DecisionTrace } from '../types';
import { Amount } from './Amount';
import { Icon } from './Icon';
import { formatLatency } from '../lib/format';

/**
 * The decision panel — every predicate, and which one bound.
 *
 * This is the Key-2 feature and the thing a judge is most likely to ask about,
 * because it is the difference between a product that refuses payments and one
 * that can say why. A REFUSED decision that does not name the predicate it
 * failed on is just a rejection.
 *
 * Replaces two near-identical implementations that had drifted apart:
 * DecisionPanel in console/page.tsx and PredicateTrace in playground/page.tsx.
 * One table, one set of column headings, one definition of "binding".
 *
 * ── The summary text comes from the core, never from here ─────────────────
 * `trace.summary` is written by the core's explain.ts alongside the decision it
 * describes. Generating a sentence client-side from the predicate list would
 * mean the words on screen and the decision on chain had different authors, and
 * the first time they disagreed the interface would be lying. There is no
 * fallback string for that reason.
 */

type Props = {
  trace: DecisionTrace;
  /** Hide the outcome heading when the caller already renders one. */
  hideOutcome?: boolean;
};

/**
 * Long hex elided in the middle, with the full value kept in `title`.
 *
 * coreImage carries two 66-character digests in its inputs and a third as its
 * expected value. Rendered whole they force the table wider than the panel and
 * push the Actual and Pass columns off screen entirely — the two columns the
 * table exists for. Eliding is display-only; nothing here changes the value, and
 * the untruncated string is one hover away.
 */
const elide = (v: string | number): string => {
  const s = String(v);
  return s.length > 22 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;
};

const OUTCOME_CLASS: Record<string, string> = {
  APPROVED: 'text-status-success border-status-success',
  HELD: 'text-status-warning border-status-warning',
  REFUSED: 'text-status-error border-status-error',
};

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="rounded-sm border border-muted px-2 py-0.5 font-mono text-[10px] text-on-surface-variant transition-colors hover:border-primary hover:text-primary"
      title={`Copy ${label}`}
      onClick={() => {
        // Deliberately no empty catch: if the clipboard is unavailable the
        // button must not flash "copied" for something that did not happen.
        navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          (e: Error) => console.error(`[decision] could not copy ${label}:`, e.message),
        );
      }}
    >
      {copied ? 'copied' : 'copy'}
    </button>
  );
}

export function PredicateTable({ trace, hideOutcome = false }: Props) {
  const outcomeClass = OUTCOME_CLASS[trace.outcome] ?? 'text-on-surface border-muted';

  return (
    <div className="flex flex-col gap-4">
      {!hideOutcome && (
        <div
          className={`inline-flex w-fit items-center gap-2 rounded-sm border bg-surface-container px-3 py-1.5 font-mono text-label-mono font-bold uppercase tracking-widest ${outcomeClass}`}
        >
          {trace.outcome}
        </div>
      )}

      {/* From the core. Not assembled here. */}
      <p className="font-body text-body-md text-on-surface">{trace.summary}</p>

      <div className="flex items-center gap-4 border-y border-muted py-2 font-mono text-label-mono text-on-surface-variant">
        <span title="Time the core spent evaluating all 14 predicates">
          {formatLatency(trace.latencyMs)}
        </span>
        <Amount minor={trace.amountMinor} className="text-on-surface" />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left font-mono text-[11px]">
          <thead>
            <tr className="border-b border-muted text-[10px] uppercase tracking-wider text-on-surface-variant">
              <th className="py-2 pr-3 font-medium">Predicate</th>
              <th className="py-2 pr-3 font-medium">Expected</th>
              <th className="py-2 pr-3 font-medium">Actual</th>
              <th className="w-8 py-2 text-center font-medium">Pass</th>
            </tr>
          </thead>
          <tbody>
            {trace.predicates.map((pred) => {
              const binding = pred.name === trace.bindingPredicate;
              return (
                <tr
                  key={pred.name}
                  className={
                    binding
                      ? 'border-b border-muted/50 bg-status-error/10'
                      : 'border-b border-muted/50'
                  }
                >
                  <td className="py-2 pr-3 align-top">
                    <span className={binding ? 'text-status-error' : 'text-on-surface'}>
                      {pred.name}
                    </span>
                    {binding && (
                      <span className="ml-1.5 rounded-sm bg-status-error px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-surface-container-lowest">
                        binding
                      </span>
                    )}
                    {/* The inputs the predicate was evaluated on. Without these
                        the table says a rule failed but not what it was looking
                        at, which is the first thing anyone asks next. */}
                    {Object.keys(pred.inputs).length > 0 && (
                      <span className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-on-surface-variant/70">
                        {Object.entries(pred.inputs).map(([k, v]) => (
                          <span key={k} title={`${k} = ${String(v)}`}>
                            {k}=<span className="text-data-hash">{elide(v)}</span>
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 align-top text-on-surface-variant" title={pred.expected}>
                    {elide(pred.expected)}
                  </td>
                  <td
                    className={`py-2 pr-3 align-top ${pred.passed ? 'text-on-surface' : 'text-status-error'}`}
                    title={pred.actual}
                  >
                    {elide(pred.actual)}
                  </td>
                  <td className="py-2 text-center align-top">
                    <Icon
                      name={pred.passed ? 'check' : 'close'}
                      size={12}
                      strokeWidth={2}
                      className={`inline ${pred.passed ? 'text-status-success' : 'text-status-error'}`}
                    />
                    <span className="sr-only">{pred.passed ? 'passed' : 'failed'}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-1.5">
        {[
          { label: 'policy', value: trace.policyHash, name: 'policy hash' },
          { label: 'image', value: trace.coreImageDigest, name: 'core image digest' },
        ].map((h) => (
          <div key={h.label} className="flex items-center gap-2 font-mono text-[10px]">
            <span className="min-w-[42px] uppercase tracking-wider text-on-surface-variant">
              {h.label}
            </span>
            <code className="text-data-hash">{h.value.slice(0, 18)}…</code>
            <CopyButton value={h.value} label={h.name} />
          </div>
        ))}
      </div>
    </div>
  );
}
