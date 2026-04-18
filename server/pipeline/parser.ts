/**
 * JSONL parser for Claude Code session files.
 *
 * Splits input on `\n`, parses each non-empty line as JSON, and optionally
 * records malformed lines as gap entries so downstream consumers can render
 * "missing data" indicators instead of silently dropping corrupt history.
 */

export type Gap = {
  /** 1-indexed source line number of the malformed line. */
  lineNumber: number;
  /** The raw, unparsed line content (without trailing newline). */
  raw: string;
  /** Human-readable error message from JSON.parse. */
  error: string;
};

export type ParseResult = {
  events: any[];
  gaps: Gap[];
};

export type ParseOpts = {
  /**
   * When true, malformed lines are pushed to `gaps`. When false or omitted,
   * malformed lines are silently skipped. Empty lines are never recorded as
   * gaps regardless of this flag.
   */
  trackGaps?: boolean;
};

export function parseJsonl(content: string, opts: ParseOpts = {}): ParseResult {
  const events: any[] = [];
  const gaps: Gap[] = [];
  const trackGaps = opts.trackGaps === true;

  if (content.length === 0) {
    return { events, gaps };
  }

  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Skip empty lines (including the empty trailing segment produced by a
    // terminating `\n`). These are not gaps.
    if (raw.length === 0) continue;

    try {
      const parsed = JSON.parse(raw);
      events.push(parsed);
    } catch (err) {
      if (trackGaps) {
        gaps.push({
          lineNumber: i + 1,
          raw,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { events, gaps };
}
