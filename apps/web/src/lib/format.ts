/**
 * Evaluation latency, at the precision the core actually measured.
 *
 * The core times the evaluator with performance.now() (see signing/sign.ts), so
 * this receives a real sub-millisecond figure rather than the integer 0 that
 * used to arrive. Both surfaces that show a decision use this, because they were
 * previously disagreeing: the console printed `<1ms` — an inference, not a
 * reading — and the decision panel printed a literal `0ms`, which reads as *not
 * measured* rather than *fast*.
 *
 * A zero is still rendered as `<0.01ms` and never as `0ms`: a clock that returns
 * exactly zero has told us the work was below its resolution, not that it took
 * no time.
 */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '<0.01ms';
  if (ms < 0.01) return '<0.01ms';
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
}
