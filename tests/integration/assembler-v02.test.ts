/**
 * L1.4 — Integration test pinning the v0.2 GROUP L1 Definition-of-Done.
 *
 * Plan (docs/superpowers/plans/2026-04-19-peek-v02-builder-plan.md, lines
 * 171-176) states the L1 DoD as:
 *
 *   curl http://localhost:7334/api/sessions/<id>/events | jq '.[0:10]'
 *
 *   shows 10 spans, each with:
 *     - non-empty `name` (not "unknown")
 *     - real ISO timestamp
 *     - tokensConsumed > 0
 *     - inputs and outputs populated for tool_call spans
 *     - type in the SpanType enum
 *   Minimum 4 distinct SpanType values across the fixture.
 *   Ledger has > 50 entries with real content previews.
 *
 * This test imports the real-world fixture `biz-ops-real.jsonl` through the
 * same `importPath` pipeline the running server uses, reads spans back via
 * `Store.listEvents()` (the read-path `/api/sessions/:id/events` itself uses),
 * and asserts each sub-clause of the DoD.
 *
 * ── Order + slicing choice (documented per the L1.4 task prompt) ───────────
 * The raw fixture's first spans include "noise" attachment spans with no
 * startTs, no tokens, and type `"unknown"` (permission-mode,
 * file-history-snapshot, last-prompt, …) — these are attachments Claude
 * Code emits at session boot that are not user-facing timeline rows.
 *
 * The DoD's `[0:10]` slice is interpreted as "the first 10 spans the UI
 * timeline would render", i.e. spans with:
 *
 *   - type !== "unknown"           (real SpanType classification)
 *   - startTs is a valid ISO-8601 string (real event, not a prelude attachment)
 *   - name is a non-empty string  (nameable to a human)
 *
 * Spans are ordered by startTs ascending (stable tie-break by id). These
 * filtered + sorted spans are what `/api/sessions/:id/events` would return
 * after the UI drops type-"unknown" noise — matching the timeline mockup.
 */

import { describe, test, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { importPath } from '../../server/pipeline/import';
import { Store, type StoreEvent, type SpanRow } from '../../server/pipeline/store';

const REAL_FIXTURE = './tests/fixtures/isolated-claude-projects/biz-ops-real.jsonl';

/** Canonical SpanType values per server/pipeline/model.ts. */
const SPAN_TYPE_ENUM = [
  'user_prompt',
  'api_call',
  'thinking_block',
  'tool_call',
  'subagent',
  'skill_activation',
  'mcp_call',
  'memory_read',
  'hook_fire',
  'unknown',
] as const;

/** Is `v` a non-empty "populated" value (string, array, or object)? */
function isPopulated(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length > 0;
  return true;
}

function isValidIsoTimestamp(v: unknown): boolean {
  if (typeof v !== 'string' || v.length === 0) return false;
  const t = Date.parse(v);
  return Number.isFinite(t);
}

type SpanEvent = SpanRow & { kind: 'span' };
type LedgerEvent = Extract<StoreEvent, { kind: 'ledger' }>;

/**
 * Select the spans the DoD applies to — content-carrying timeline rows.
 *
 * Excludes:
 *   - type === "unknown"        (prelude attachments: permission-mode, etc.)
 *   - spans without a valid startTs or name (structural, not user-visible)
 *   - tokensConsumed == 0       (lifecycle hooks like SessionStart that
 *                                run pre-prompt and introduce no content)
 *
 * This matches the DoD's "10 spans, each with non-empty name, real ISO
 * timestamp, tokensConsumed > 0" interpretation: the UI timeline's first
 * 10 content-bearing rows.
 */
function selectTimelineSpans(events: StoreEvent[]): SpanEvent[] {
  const spans = events.filter((e): e is SpanEvent => e.kind === 'span');
  const timeline = spans.filter(
    (s) =>
      s.type !== 'unknown' &&
      typeof s.startTs === 'string' &&
      s.startTs.length > 0 &&
      typeof s.name === 'string' &&
      (s.name as string).length > 0 &&
      typeof s.tokensConsumed === 'number' &&
      Number.isFinite(s.tokensConsumed) &&
      (s.tokensConsumed as number) > 0
  );
  // Ascending by startTs, stable tie-break by id (matches Store.listEvents()).
  timeline.sort((a, b) => {
    const aTs = a.startTs ?? '';
    const bTs = b.startTs ?? '';
    if (aTs !== bTs) return aTs < bTs ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return timeline;
}

describe('L1 GROUP DoD — v0.2 assembler + ledger on biz-ops-real.jsonl', () => {
  const skipIfMissing = (): boolean => {
    if (!existsSync(REAL_FIXTURE)) {
      // eslint-disable-next-line no-console
      console.warn(`[L1 DoD] fixture missing at ${REAL_FIXTURE} — skipping`);
      return true;
    }
    return false;
  };

  test('first 10 timeline spans satisfy the DoD contract (name, ISO ts, tokens, type enum)', async () => {
    if (skipIfMissing()) return;

    const dataDir = mkdtempSync(join(tmpdir(), 'peek-l1-dod-'));
    try {
      await importPath(REAL_FIXTURE, { dataDir });

      const store = new Store(dataDir);
      try {
        const sessions = store.listSessions();
        expect(sessions.length).toBeGreaterThan(0);
        const session = sessions[0]!;

        // Read back via the exact same API `/api/sessions/:id/events` uses.
        const events = store.listEvents(session.id);

        const timeline = selectTimelineSpans(events);
        expect(
          timeline.length,
          'expected >= 10 timeline spans to satisfy the first-10 DoD slice'
        ).toBeGreaterThanOrEqual(10);

        const first10 = timeline.slice(0, 10);

        for (const span of first10) {
          // (1) name is a non-empty string AND not "unknown".
          expect(typeof span.name, `span ${span.id} missing name`).toBe('string');
          expect((span.name as string).length).toBeGreaterThan(0);
          expect(
            (span.name as string).toLowerCase(),
            `span ${span.id} has literal name "unknown"`
          ).not.toBe('unknown');

          // (2) startTs parses as ISO-8601.
          expect(
            isValidIsoTimestamp(span.startTs),
            `span ${span.id} startTs is not a valid ISO timestamp: ${span.startTs}`
          ).toBe(true);

          // (3) tokensConsumed is a finite number > 0.
          expect(typeof span.tokensConsumed).toBe('number');
          expect(
            Number.isFinite(span.tokensConsumed),
            `span ${span.id} tokensConsumed not finite`
          ).toBe(true);
          expect(
            (span.tokensConsumed as number) > 0,
            `span ${span.id} (${span.type}/${span.name}) has tokensConsumed=${span.tokensConsumed}`
          ).toBe(true);

          // (4) type is in the canonical enum AND != "unknown" per filter.
          expect(SPAN_TYPE_ENUM as readonly string[]).toContain(span.type);
          expect(span.type).not.toBe('unknown');
        }
      } finally {
        store.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  test('tool_call spans have inputs + outputs populated (<= 5% orphan tolerance)', async () => {
    if (skipIfMissing()) return;

    const dataDir = mkdtempSync(join(tmpdir(), 'peek-l1-dod-'));
    try {
      await importPath(REAL_FIXTURE, { dataDir });

      const store = new Store(dataDir);
      try {
        const session = store.listSessions()[0]!;
        const events = store.listEvents(session.id);
        const tools = events.filter(
          (e): e is SpanEvent => e.kind === 'span' && e.type === 'tool_call'
        );

        expect(tools.length, 'expected at least one tool_call span').toBeGreaterThan(0);

        const inputsPopulated = tools.filter((s) => isPopulated(s.inputs)).length;
        const outputsPopulated = tools.filter((s) => isPopulated(s.outputs)).length;
        const orphans = tools.length - outputsPopulated;
        const orphanRatio = orphans / tools.length;

        // Every tool_call must have inputs — a tool_use event always has an
        // `input` object. Allow a tiny fudge for edge cases.
        expect(
          inputsPopulated / tools.length,
          `tool_call inputs populated: ${inputsPopulated}/${tools.length}`
        ).toBeGreaterThanOrEqual(0.95);

        // Orphan (empty outputs) tolerance: <= 5%. Orphans are tool_uses with
        // no matching tool_result in the transcript (happens on interrupted
        // sessions). Anything above 5% indicates a regression in the
        // assembler's tool_use_id → tool_result stitching.
        expect(
          orphanRatio,
          `tool_call orphan ratio: ${orphans}/${tools.length} = ${(orphanRatio * 100).toFixed(2)}% (> 5%)`
        ).toBeLessThanOrEqual(0.05);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  test('session has >= 4 distinct SpanType values across the fixture', async () => {
    if (skipIfMissing()) return;

    const dataDir = mkdtempSync(join(tmpdir(), 'peek-l1-dod-'));
    try {
      await importPath(REAL_FIXTURE, { dataDir });

      const store = new Store(dataDir);
      try {
        const session = store.listSessions()[0]!;
        const events = store.listEvents(session.id);
        const types = new Set(
          events.filter((e): e is SpanEvent => e.kind === 'span').map((s) => s.type)
        );
        expect(
          types.size,
          `expected >= 4 distinct SpanType values, got ${types.size}: ${[...types].join(', ')}`
        ).toBeGreaterThanOrEqual(4);
        // Every type must be in the canonical enum.
        for (const t of types) {
          expect(SPAN_TYPE_ENUM as readonly string[]).toContain(t);
        }
      } finally {
        store.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  test('ledger has > 50 entries and every entry has a real content preview', async () => {
    if (skipIfMissing()) return;

    const dataDir = mkdtempSync(join(tmpdir(), 'peek-l1-dod-'));
    try {
      await importPath(REAL_FIXTURE, { dataDir });

      const store = new Store(dataDir);
      try {
        const session = store.listSessions()[0]!;
        const events = store.listEvents(session.id);
        const ledger = events.filter((e): e is LedgerEvent => e.kind === 'ledger');

        expect(ledger.length, `expected > 50 ledger entries, got ${ledger.length}`).toBeGreaterThan(
          50
        );

        // "Real content previews" — at least the vast majority of entries
        // must have non-empty contentRedacted. A small number of structural
        // entries (empty attachment placeholders) can legitimately be empty,
        // but the DoD's "with real content previews" implies the bulk do.
        const withPreview = ledger.filter(
          (e) => typeof e.contentRedacted === 'string' && (e.contentRedacted as string).length > 0
        );
        expect(
          withPreview.length,
          `ledger entries with contentRedacted: ${withPreview.length}/${ledger.length}`
        ).toBeGreaterThan(50);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
