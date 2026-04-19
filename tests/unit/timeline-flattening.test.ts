/**
 * Unit tests for BLOCKING-1 fix: child spans (parentSpanId != null) must
 * surface in the top-level timeline alongside their parents.
 *
 * These tests pin the Option A "flat chronological stream" contract:
 *   - Every span passing chip filters is emitted exactly once.
 *   - `depth` reflects parent-chain length (for visual indentation).
 *   - `hasChildren` is true iff any other span in the payload has this
 *     span as its parent.
 *   - Orphan children (parentSpanId points at a span not in the payload)
 *     are rescued as depth-0 rows, not silently dropped.
 *   - Duplicate span ids collapse to the first occurrence.
 *   - Null/invalid startTs sinks to the bottom of the chronological sort.
 */

import { describe, expect, it } from 'vitest';

import { CHIP_DEFS } from '../../src/lib/icons';
import { buildTimelineRows, type ChipKey, type StoreEvent } from '../../src/stores/session';

const ALL_CHIPS: Set<ChipKey> = new Set(CHIP_DEFS.map((c) => c.key as ChipKey));

function span(
  id: string,
  type: string,
  startTs: string | undefined,
  extra: Record<string, unknown> = {}
): StoreEvent {
  const base: Record<string, unknown> = {
    kind: 'span',
    id,
    sessionId: 'sess',
    type,
    name: (extra.name as string | undefined) ?? type,
  };
  if (startTs !== undefined) base.startTs = startTs;
  for (const [k, v] of Object.entries(extra)) {
    if (k === 'name') continue; // already handled
    base[k] = v;
  }
  return base as StoreEvent;
}

describe('buildTimelineRows — BLOCKING-1 child spans in stream (Option A)', () => {
  it('surfaces tool_call children of an api_call parent by name (Bash/Read/Grep)', () => {
    const events: StoreEvent[] = [
      span('api-1', 'api_call', '2026-04-18T09:00:00Z', { name: 'claude-3 request' }),
      span('tool-bash', 'tool_call', '2026-04-18T09:00:01Z', {
        parentSpanId: 'api-1',
        name: 'Bash',
      }),
      span('tool-read', 'tool_call', '2026-04-18T09:00:02Z', {
        parentSpanId: 'api-1',
        name: 'Read',
      }),
      span('tool-grep', 'tool_call', '2026-04-18T09:00:03Z', {
        parentSpanId: 'api-1',
        name: 'Grep',
      }),
    ];

    const rows = buildTimelineRows(events, ALL_CHIPS, new Set());

    const names = rows.map((r) => r.name);
    // THE acceptance-equivalent assertion: Bash, Read, Grep are present in
    // the rendered row list without any expand click.
    expect(names).toContain('Bash');
    expect(names).toContain('Read');
    expect(names).toContain('Grep');
    // All four spans (parent + 3 children) emit exactly once.
    expect(rows.length).toBe(4);
  });

  it('tags the parent with hasChildren and indents children (depth > 0)', () => {
    const events: StoreEvent[] = [
      span('api-1', 'api_call', '2026-04-18T09:00:00Z'),
      span('tool-1', 'tool_call', '2026-04-18T09:00:01Z', { parentSpanId: 'api-1' }),
      span('tool-2', 'tool_call', '2026-04-18T09:00:02Z', { parentSpanId: 'api-1' }),
    ];

    const rows = buildTimelineRows(events, ALL_CHIPS, new Set());
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('api-1')?.depth).toBe(0);
    expect(byId.get('api-1')?.hasChildren).toBe(true);
    expect(byId.get('tool-1')?.depth).toBe(1);
    expect(byId.get('tool-1')?.hasChildren).toBe(false);
    expect(byId.get('tool-2')?.depth).toBe(1);
  });

  it('rescues orphan children (parent not in payload) as depth-0 rows', () => {
    const events: StoreEvent[] = [
      // parentSpanId points at a span ID that was never ingested — e.g. a
      // subagent handoff boundary. Must still render, not be dropped.
      span('tool-orphan', 'tool_call', '2026-04-18T09:00:00Z', {
        parentSpanId: 'nonexistent-parent',
        name: 'Bash',
      }),
    ];
    const rows = buildTimelineRows(events, ALL_CHIPS, new Set());
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('Bash');
    expect(rows[0].depth).toBe(0);
    expect(rows[0].hasChildren).toBe(false);
  });

  it('expanded-set is a no-op under Option A (flat stream)', () => {
    const events: StoreEvent[] = [
      span('api-1', 'api_call', '2026-04-18T09:00:00Z'),
      span('tool-1', 'tool_call', '2026-04-18T09:00:01Z', { parentSpanId: 'api-1' }),
    ];
    const collapsed = buildTimelineRows(events, ALL_CHIPS, new Set());
    const expanded = buildTimelineRows(events, ALL_CHIPS, new Set(['api-1']));
    expect(collapsed.map((r) => r.id)).toEqual(expanded.map((r) => r.id));
    expect(collapsed.length).toBe(2);
  });

  it('sorts chronologically by startTs with null/invalid sunk to the bottom', () => {
    const events: StoreEvent[] = [
      span('c', 'tool_call', '2026-04-18T09:00:03Z', { name: 'C' }),
      span('a', 'tool_call', '2026-04-18T09:00:01Z', { name: 'A' }),
      span('null-ts', 'tool_call', undefined, { name: 'Z' }),
      span('b', 'tool_call', '2026-04-18T09:00:02Z', { name: 'B' }),
    ];
    const rows = buildTimelineRows(events, ALL_CHIPS, new Set());
    expect(rows.map((r) => r.name)).toEqual(['A', 'B', 'C', 'Z']);
  });

  it('deduplicates spans with the same id (defensive — keeps first)', () => {
    const events: StoreEvent[] = [
      span('dup', 'tool_call', '2026-04-18T09:00:00Z', { name: 'first' }),
      span('dup', 'tool_call', '2026-04-18T09:00:01Z', { name: 'second' }),
    ];
    const rows = buildTimelineRows(events, ALL_CHIPS, new Set());
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('first');
  });

  it('caps depth at 4 so pathologically-nested traces do not indent off-screen', () => {
    // Build a 7-deep chain.
    const events: StoreEvent[] = [
      span('d0', 'api_call', '2026-04-18T09:00:00Z'),
      span('d1', 'tool_call', '2026-04-18T09:00:01Z', { parentSpanId: 'd0' }),
      span('d2', 'tool_call', '2026-04-18T09:00:02Z', { parentSpanId: 'd1' }),
      span('d3', 'tool_call', '2026-04-18T09:00:03Z', { parentSpanId: 'd2' }),
      span('d4', 'tool_call', '2026-04-18T09:00:04Z', { parentSpanId: 'd3' }),
      span('d5', 'tool_call', '2026-04-18T09:00:05Z', { parentSpanId: 'd4' }),
      span('d6', 'tool_call', '2026-04-18T09:00:06Z', { parentSpanId: 'd5' }),
    ];
    const rows = buildTimelineRows(events, ALL_CHIPS, new Set());
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('d0')?.depth).toBe(0);
    expect(byId.get('d1')?.depth).toBe(1);
    expect(byId.get('d4')?.depth).toBe(4);
    // Anything deeper is clamped — never exceeds the cap.
    expect(byId.get('d5')?.depth).toBe(4);
    expect(byId.get('d6')?.depth).toBe(4);
  });

  it('still respects chip filters — toggling tools off drops tool_call children', () => {
    const events: StoreEvent[] = [
      span('api-1', 'api_call', '2026-04-18T09:00:00Z'),
      span('tool-1', 'tool_call', '2026-04-18T09:00:01Z', {
        parentSpanId: 'api-1',
        name: 'Bash',
      }),
    ];
    const noTools = new Set<ChipKey>([...ALL_CHIPS].filter((k) => k !== 'tools'));
    const rows = buildTimelineRows(events, noTools, new Set());
    expect(rows.map((r) => r.id)).toEqual(['api-1']);
  });
});
