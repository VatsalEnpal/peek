/**
 * Unit tests for `buildTimelineRows` / `spanVisible` against the current
 * server SpanType enum.
 *
 * Guards the invariant that BLOCKING finding #1 is fixed: when no chip
 * filter is explicitly toggled off, ALL non-`unknown` span types render in
 * the timeline. These assertions catch future drift if the server enum is
 * ever renamed again without updating `CHIP_DEFS`.
 */

import { describe, expect, it } from 'vitest';

import { CHIP_DEFS } from '../../src/lib/icons';
import {
  buildTimelineRows,
  spanVisible,
  type ChipKey,
  type StoreEvent,
} from '../../src/stores/session';

const ALL_CHIPS: Set<ChipKey> = new Set(CHIP_DEFS.map((c) => c.key as ChipKey));

function span(
  id: string,
  type: string,
  startTs: string,
  extra: Record<string, unknown> = {}
): StoreEvent {
  return {
    kind: 'span',
    id,
    sessionId: 'sess',
    type,
    name: type,
    startTs,
    ...extra,
  } as StoreEvent;
}

describe('buildTimelineRows — server SpanType coverage', () => {
  const EVENTS: StoreEvent[] = [
    span('s1', 'user_prompt', '2026-04-18T09:00:01Z'),
    span('s2', 'api_call', '2026-04-18T09:00:02Z'),
    span('s3', 'tool_call', '2026-04-18T09:00:03Z'),
    span('s4', 'subagent', '2026-04-18T09:00:04Z'),
    span('s5', 'hook_fire', '2026-04-18T09:00:05Z'),
    span('s6', 'skill_activation', '2026-04-18T09:00:06Z'),
    span('s7', 'unknown', '2026-04-18T09:00:07Z'),
  ];

  it('all 7 types render when every chip is active (default)', () => {
    const rows = buildTimelineRows(EVENTS, ALL_CHIPS, new Set());
    const types = rows.map((r) => r.type).sort();
    expect(types).toEqual([
      'api_call',
      'hook_fire',
      'skill_activation',
      'subagent',
      'tool_call',
      'unknown',
      'user_prompt',
    ]);
  });

  it('non-`unknown` types stay visible when chips are touched — filters are additive-subtractive per chip', () => {
    // Toggle `tools` off — everything except tool_call stays.
    const noTools = new Set<ChipKey>([...ALL_CHIPS].filter((k) => k !== 'tools'));
    const rows = buildTimelineRows(EVENTS, noTools, new Set());
    const types = rows.map((r) => r.type);
    expect(types).not.toContain('tool_call');
    expect(types).toContain('user_prompt');
    expect(types).toContain('api_call');
    expect(types).toContain('subagent');
    expect(types).toContain('skill_activation');
    expect(types).toContain('hook_fire');
  });
});

describe('spanVisible — chip → SpanType mapping', () => {
  it('`prompts` chip governs user_prompt', () => {
    expect(spanVisible('user_prompt', new Set(['prompts']))).toBe(true);
    expect(spanVisible('user_prompt', new Set())).toBe(false);
  });
  it('`api` chip governs api_call and thinking_block', () => {
    expect(spanVisible('api_call', new Set(['api']))).toBe(true);
    expect(spanVisible('thinking_block', new Set(['api']))).toBe(true);
    expect(spanVisible('api_call', new Set())).toBe(false);
  });
  it('`tools` chip governs tool_call and mcp_call', () => {
    expect(spanVisible('tool_call', new Set(['tools']))).toBe(true);
    expect(spanVisible('mcp_call', new Set(['tools']))).toBe(true);
  });
  it('`subagents` chip governs subagent', () => {
    expect(spanVisible('subagent', new Set(['subagents']))).toBe(true);
  });
  it('`skills` chip governs skill_activation', () => {
    expect(spanVisible('skill_activation', new Set(['skills']))).toBe(true);
  });
  it('`hooks` chip governs hook_fire', () => {
    expect(spanVisible('hook_fire', new Set(['hooks']))).toBe(true);
  });
  it('`files` chip governs memory_read', () => {
    expect(spanVisible('memory_read', new Set(['files']))).toBe(true);
    expect(spanVisible('memory_read', new Set())).toBe(false);
  });
  it('`unknown` is always visible (no chip covers it)', () => {
    expect(spanVisible('unknown', new Set())).toBe(true);
    expect(spanVisible('unknown', new Set(['prompts']))).toBe(true);
  });
});

describe('buildTimelineRows — tokens fallback picks tokensConsumed first', () => {
  // The exact token column logic lives in the component; this asserts the
  // raw span fields survive the walker so the component can read them.
  it('preserves tokensConsumed and tokens on the output rows', () => {
    const events: StoreEvent[] = [
      span('s1', 'tool_call', '2026-04-18T09:00:01Z', { tokensConsumed: 1234, tokens: 9999 }),
      span('s2', 'tool_call', '2026-04-18T09:00:02Z', { tokens: 42 }),
      span('s3', 'tool_call', '2026-04-18T09:00:03Z', { tokensConsumed: 0 }),
    ];
    const rows = buildTimelineRows(events, ALL_CHIPS, new Set());
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('s1')?.tokensConsumed).toBe(1234);
    expect(byId.get('s1')?.tokens).toBe(9999);
    expect(byId.get('s2')?.tokens).toBe(42);
    // Zero is a valid numeric value and must NOT be dropped.
    expect(byId.get('s3')?.tokensConsumed).toBe(0);
  });
});
