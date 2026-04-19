/**
 * Sessions + events routes.
 *
 *   GET /api/sessions
 *     → [{ id, label, firstPrompt, turnCount, totalTokens, timeAgo }], most
 *       recent first. Label falls back to firstPrompt[:80] then to id.
 *
 *   GET /api/sessions/:id/events?start=&end=&types=
 *     → interleaved span + ledger events in source order, filtered and paginated.
 *
 *   GET /api/sessions/:id/spans/:spanId
 *     → { span, inputs, outputs, ledgerSnapshot } for a single span.
 *
 * Thin route layer: all querying delegates to the Store's typed methods.
 */

import { Router, type Request, type Response } from 'express';

import { composeLabel } from '../identity/session-label';
import type { Store, SpanRow, LedgerEntryRow, TurnRow } from '../pipeline/store';

const router = Router();

function timeAgo(iso: string | undefined, now = Date.now()): string {
  if (!iso) return 'unknown';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  const diff = Math.max(0, Math.floor((now - t) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

router.get('/', (req: Request, res: Response) => {
  const store = req.app.locals.store as Store;
  const rows = store.listSessions();

  const summaries = rows.map((s) => {
    const events = store.listEvents(s.id);
    const turns = store.listTurns(s.id);
    const turnIds = new Set<string>();
    for (const e of events) {
      if (e.kind === 'span' && (e as SpanRow & { kind: 'span' }).turnId) {
        turnIds.add((e as SpanRow & { kind: 'span' }).turnId as string);
      }
      if (e.kind === 'ledger' && (e as LedgerEntryRow & { kind: 'ledger' }).turnId) {
        turnIds.add((e as LedgerEntryRow & { kind: 'ledger' }).turnId as string);
      }
    }
    for (const t of turns) turnIds.add(t.id);

    // L13: totalTokens is max-per-turn `usage.{input,output,cacheCreation,cacheRead}Tokens`
    // — the same formula the CONTEXT gauge and the reconciler use. Ledger
    // sums under-report real context-window pressure by ~40x because spans
    // only carry per-tool content tokens, not system prompt + cache + history.
    // A session card's progress bar is framed against a 200 k ceiling, so
    // max-per-turn is the right number (not a session-wide sum, which would
    // trivially exceed the ceiling on any realistic session).
    let maxPerTurn = 0;
    let anyTurnHasUsage = false;
    for (const t of turns) {
      if (!t.usage) continue;
      anyTurnHasUsage = true;
      const total =
        (Number(t.usage.inputTokens) || 0) +
        (Number(t.usage.outputTokens) || 0) +
        (Number(t.usage.cacheCreationTokens) || 0) +
        (Number(t.usage.cacheReadTokens) || 0);
      if (total > maxPerTurn) maxPerTurn = total;
    }
    // Legacy fallback: imports before turn usage was recorded have no
    // turn.usage. Sum the ledger tokens so the card isn't stuck at 0.
    let totalTokens = maxPerTurn;
    if (!anyTurnHasUsage) {
      const ledgerEntries = events.filter((e) => e.kind === 'ledger') as Array<
        LedgerEntryRow & { kind: 'ledger' }
      >;
      totalTokens = ledgerEntries.reduce((n, l) => n + (l.tokens ?? 0), 0);
    }

    const label = composeLabel(s);
    return {
      id: s.id,
      label,
      slug: s.slug ?? null,
      gitBranch: s.gitBranch ?? null,
      firstPrompt: s.firstPrompt ?? null,
      turnCount: turnIds.size,
      totalTokens,
      timeAgo: timeAgo(s.startTs ?? s.endTs),
      startTs: s.startTs ?? null,
      endTs: s.endTs ?? null,
    };
  });

  summaries.sort((a, b) => {
    const aTs = a.startTs ?? '';
    const bTs = b.startTs ?? '';
    if (aTs === bTs) return a.id < b.id ? -1 : 1;
    return aTs < bTs ? 1 : -1;
  });

  res.json(summaries);
});

router.get('/:id/events', (req: Request, res: Response) => {
  const store = req.app.locals.store as Store;
  const id = String(req.params.id);
  const session = store.getSession(id);
  if (!session) {
    res.status(404).json({ error: 'session not found', id });
    return;
  }

  const { start, end, types } = req.query;
  const opts: { start?: string; end?: string; types?: string[]; limit?: number } = {};
  if (typeof start === 'string') opts.start = start;
  if (typeof end === 'string') opts.end = end;
  if (typeof types === 'string' && types.length > 0) {
    opts.types = types.split(',').filter(Boolean);
  }

  const events = store.listEvents(id, opts);

  // L2.4 CRITICAL — prepend `turn` wire events so the UI CONTEXT gauge can
  // read real per-turn model usage (system prompt + cached context + history
  // + assistant reply) instead of span content sums. Span sums under-report
  // real context-window pressure by ~40x on Claude Code sessions because
  // spans only carry per-tool content tokens. See `self-check.ts` line 110
  // for the same computation server-side (reconciler.parentReported).
  const turnEvents = store.listTurns(id).map((t) => {
    const evt: {
      kind: 'turn';
      id: string;
      sessionId: string;
      index: number;
      startTs?: string;
      endTs?: string;
      usage?: TurnRow['usage'];
    } = {
      kind: 'turn',
      id: t.id,
      sessionId: t.sessionId,
      index: t.turnIndex,
    };
    if (t.startTs !== undefined) evt.startTs = t.startTs;
    if (t.endTs !== undefined) evt.endTs = t.endTs;
    if (t.usage !== undefined) evt.usage = t.usage;
    return evt;
  });

  res.json([...turnEvents, ...events]);
});

router.get('/:id/spans/:spanId', (req: Request, res: Response) => {
  const store = req.app.locals.store as Store;
  const id = String(req.params.id);
  const spanId = String(req.params.spanId);
  const session = store.getSession(id);
  if (!session) {
    res.status(404).json({ error: 'session not found', id });
    return;
  }
  const events = store.listEvents(id);
  const span = events.find(
    (e): e is SpanRow & { kind: 'span' } => e.kind === 'span' && e.id === spanId
  );
  if (!span) {
    res.status(404).json({ error: 'span not found', id: spanId });
    return;
  }
  const ledgerSnapshot = events.filter(
    (e): e is LedgerEntryRow & { kind: 'ledger' } =>
      e.kind === 'ledger' && e.introducedBySpanId === spanId
  );
  res.json({
    span,
    inputs: span.inputs ?? null,
    outputs: span.outputs ?? null,
    ledgerSnapshot,
  });
});

export default router;
