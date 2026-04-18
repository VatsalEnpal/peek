/**
 * Runtime reconciliation self-check.
 *
 * Compares a parent subagent's reported token total against the sum of its
 * child ledger tokens. A small drift is expected (tokenizer rounding across
 * tools), but large drifts mean we've lost or duplicated usage rows and
 * must be surfaced loudly rather than silently normalized.
 */

export type ReconcileInput = {
  /** Parent's reported total (from subagent footer totalTokens). */
  parentReported: number;
  /** Child ledger tokens — sum these and compare against parentReported. */
  childTokens: number[];
};

export type ReconcileResult =
  | { match: true; drift: number }
  | { match: false; drift: number; loud: string };

const DEFAULT_THRESHOLD = 0.005; // 0.5%

/**
 * Compute drift between a parent subagent's reported total and the sum of its
 * children, and report whether that drift is within `threshold` (fractional,
 * e.g. 0.005 = 0.5%).
 *
 * - drift = |childSum - parentReported| / parentReported
 * - parentReported === 0 is a special case: match iff childSum === 0, otherwise
 *   mismatch with drift = Infinity.
 */
export function reconcileSubagentTokens(
  input: ReconcileInput,
  threshold: number = DEFAULT_THRESHOLD
): ReconcileResult {
  const { parentReported, childTokens } = input;
  const childSum = childTokens.reduce((acc, n) => acc + n, 0);

  // Guard: parentReported = 0.
  if (parentReported === 0) {
    if (childSum === 0) {
      return { match: true, drift: 0 };
    }
    return {
      match: false,
      drift: Infinity,
      loud: formatLoud({
        parentReported,
        childSum,
        drift: Infinity,
        threshold,
      }),
    };
  }

  const drift = Math.abs(childSum - parentReported) / parentReported;

  if (drift <= threshold) {
    return { match: true, drift };
  }

  return {
    match: false,
    drift,
    loud: formatLoud({ parentReported, childSum, drift, threshold }),
  };
}

function formatLoud(args: {
  parentReported: number;
  childSum: number;
  drift: number;
  threshold: number;
}): string {
  const { parentReported, childSum, drift, threshold } = args;
  const driftPct = drift === Infinity ? 'Infinity' : (drift * 100).toFixed(2);
  const thresholdPct = (threshold * 100).toFixed(2);
  return `Drift ${driftPct}% between parent.totalTokens=${parentReported} and sum(children)=${childSum} exceeds threshold ${thresholdPct}%`;
}
