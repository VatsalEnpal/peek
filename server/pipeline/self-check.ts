/**
 * Runtime reconciliation self-check.
 *
 * Compares a parent subagent's reported token total against the sum of its
 * child ledger tokens. A small drift is expected (tokenizer rounding across
 * tools), but large drifts mean we've lost or duplicated usage rows and
 * must be surfaced loudly rather than silently normalized.
 */

import type { Session, TurnReconciliation } from './model';

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

// ---------------------------------------------------------------------------
// Per-turn reconciliation (L1.5 — v0.2 builder plan line 177).
//
// For each Turn in an assembled Session:
//   parentReported = sum(turn.usage.{inputTokens,outputTokens,
//                                    cacheCreationTokens,cacheReadTokens})
//   childSum       = sum(span.tokensConsumed) over spans where
//                    span.turnId === turn.id
//   drift          = |childSum - parentReported| / parentReported
//
// Mutates `turn.reconciliation` in place for every turn with a `usage`
// object, and also returns a flat array of results so callers can log /
// surface drift without re-walking the session. Warnings are emitted via
// `console.warn` for turns where drift exceeds the threshold — this is
// observability, never fatal.
// ---------------------------------------------------------------------------

export type TurnReconciliationResult = TurnReconciliation & { turnId: string };

const DEFAULT_TURN_THRESHOLD = 0.05; // 5% per plan line 177

export function reconcileTurnTokens(
  session: Session,
  threshold: number = DEFAULT_TURN_THRESHOLD
): TurnReconciliationResult[] {
  const results: TurnReconciliationResult[] = [];

  // Index spans by turnId so each turn gets its own childSum in O(n).
  const spansByTurn = new Map<string, number>();
  for (const span of session.spans) {
    if (!span.turnId) continue;
    const prev = spansByTurn.get(span.turnId) ?? 0;
    spansByTurn.set(span.turnId, prev + (Number(span.tokensConsumed) || 0));
  }

  for (const turn of session.turns) {
    if (!turn.usage) continue;

    const u = turn.usage;
    const parentReported =
      (Number(u.inputTokens) || 0) +
      (Number(u.outputTokens) || 0) +
      (Number(u.cacheCreationTokens) || 0) +
      (Number(u.cacheReadTokens) || 0);
    const childSum = spansByTurn.get(turn.id) ?? 0;

    let drift: number;
    let match: boolean;
    if (parentReported === 0) {
      // Special case mirrors reconcileSubagentTokens: match iff childSum also 0.
      drift = childSum === 0 ? 0 : Infinity;
      match = childSum === 0;
    } else {
      drift = Math.abs(childSum - parentReported) / parentReported;
      match = drift <= threshold;
    }

    const reconciliation: TurnReconciliation = {
      match,
      drift,
      parentReported,
      childSum,
      threshold,
    };
    turn.reconciliation = reconciliation;
    results.push({ turnId: turn.id, ...reconciliation });

    // Drift is expected on real Claude Code sessions because spans only carry
    // tool-content tokens (a few dozen per call) while Turn.usage includes
    // system prompt + cached context + history + assistant output. The UI
    // gauge reads Turn.usage directly (L2.4-critical fix) so this is an
    // internal-consistency signal, not a user-facing error. Gate behind
    // PEEK_DEBUG so the CLI stays quiet by default.
    if (!match && process.env.PEEK_DEBUG) {
      const driftPct = drift === Infinity ? 'Infinity' : (drift * 100).toFixed(2);
      const thresholdPct = (threshold * 100).toFixed(2);
      // eslint-disable-next-line no-console
      console.warn(
        `[peek-trace] turn ${turn.id} (#${turn.index}) drift ${driftPct}% between ` +
          `Turn.usage=${parentReported} and sum(spans.tokensConsumed)=${childSum} ` +
          `exceeds threshold ${thresholdPct}%`
      );
    }
  }

  return results;
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
