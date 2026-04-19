/**
 * Marker API — v0.2.1 L1.3.
 *
 *   POST /api/markers
 *     body: { type: 'start' | 'end', name?: string, sessionId?: string, timestamp?: string }
 *     → 201 { id, type, label, sessionId, startTs, endTs? }
 *     side-effects: writes a bookmark row (source='marker') and broadcasts
 *                   `marker:opened` or `marker:closed` over SSE.
 *
 * `sessionId` defaults to the literal string `"live"` — Claude Code slash
 * commands have no reliable way to know the session UUID, so Peek uses a
 * sentinel session row that the watcher keeps pinned to the currently
 * appending JSONL. (The watcher side of that lives in L1.1; in isolation
 * the API still works and tests seed the sentinel explicitly.)
 *
 * `type='end'` with no matching open marker is still persisted as a closed
 * bookmark with only `endTs` set — orphans are a legitimate state (user
 * ran `/peek_end` without a prior start) and the UI renders them as a
 * single timestamp pin.
 */

import { randomUUID } from 'node:crypto';

import express, { Router, type Request, type Response, type NextFunction } from 'express';

import type { Store, BookmarkRow } from '../pipeline/store';
import { broadcast } from './sse';

const LIVE_SENTINEL_SESSION_ID = 'live';

// C2 from code review: the slash-command flow pipes an attacker-controlled
// `name` into a curl body. The server-side validation here is defense-in-depth
// against any caller (not just the Claude Code slash commands):
//   - NAME_MAX_LENGTH caps label size at 256 UTF-16 code units (matches the
//     bookmark UI's visual budget)
//   - SESSION_ID_MAX_LENGTH bounds the FK column length so pathologically
//     long ids can't bloat the DB
//   - BODY_BYTE_LIMIT is a per-router cap (global express.json is 50mb for
//     large imports; markers should never need more than a handful of bytes)
const NAME_MAX_LENGTH = 256;
const SESSION_ID_MAX_LENGTH = 128;
const BODY_BYTE_LIMIT = '16kb';

const router = Router();

// Per-router body limit. 413 is returned for payloads above 16kb; this
// intentionally does NOT inherit the 50mb limit on the global parser.
router.use(express.json({ limit: BODY_BYTE_LIMIT }));

// Enforce Content-Type: application/json — `express.json` silently skips
// non-matching requests, which would leave req.body === {} and bypass the
// real validation logic. Reject early with 400.
router.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'POST') {
    next();
    return;
  }
  const ct = req.headers['content-type'] ?? '';
  if (typeof ct !== 'string' || !ct.toLowerCase().includes('application/json')) {
    res.status(400).json({ error: "Content-Type must be 'application/json'" });
    return;
  }
  next();
});

type MarkerRequestBody = {
  type?: unknown;
  name?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
};

router.post('/', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as MarkerRequestBody;
  const type = body.type;
  if (type !== 'start' && type !== 'end') {
    res.status(400).json({ error: "body must include type: 'start' | 'end'" });
    return;
  }
  // sessionId validation: bound length BEFORE falling back to the sentinel so
  // a malicious client can't sneak a 10MB string past by also omitting some
  // other field.
  if (body.sessionId !== undefined && typeof body.sessionId !== 'string') {
    res.status(400).json({ error: 'sessionId must be a string' });
    return;
  }
  if (typeof body.sessionId === 'string' && body.sessionId.length > SESSION_ID_MAX_LENGTH) {
    res.status(400).json({ error: `sessionId exceeds ${SESSION_ID_MAX_LENGTH} chars` });
    return;
  }
  // name validation: must be string if present, length-capped.
  if (body.name !== undefined && typeof body.name !== 'string') {
    res.status(400).json({ error: 'name must be a string' });
    return;
  }
  if (typeof body.name === 'string' && body.name.length > NAME_MAX_LENGTH) {
    res.status(400).json({ error: `name exceeds ${NAME_MAX_LENGTH} chars` });
    return;
  }
  const store = req.app.locals.store as Store;
  const sessionId =
    typeof body.sessionId === 'string' && body.sessionId.length > 0
      ? body.sessionId
      : LIVE_SENTINEL_SESSION_ID;
  const ts = typeof body.timestamp === 'string' ? body.timestamp : new Date().toISOString();
  const name = typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : undefined;

  if (type === 'start') {
    const row: BookmarkRow = {
      id: randomUUID(),
      sessionId,
      source: 'marker',
      startTs: ts,
    };
    if (name !== undefined) row.label = name;
    store.putBookmark(row);
    const wire = { id: row.id, type: 'start' as const, sessionId, label: row.label, startTs: ts };
    broadcast('marker:opened', wire);
    res.status(201).json(wire);
    return;
  }

  // type === 'end' — locate the most recent open marker (source='marker',
  // endTs undefined) for this session and close it. If none exists, persist
  // a pin-only bookmark with just `endTs` set.
  const existing = store
    .listBookmarks(sessionId)
    .filter((b) => b.source === 'marker' && b.endTs === undefined)
    .sort((a, b) => (a.startTs ?? '').localeCompare(b.startTs ?? ''));
  const open = existing[existing.length - 1];
  if (open) {
    open.endTs = ts;
    store.putBookmark(open);
    const wire = {
      id: open.id,
      type: 'end' as const,
      sessionId,
      label: open.label,
      startTs: open.startTs,
      endTs: ts,
    };
    broadcast('marker:closed', wire);
    res.status(201).json(wire);
    return;
  }

  const row: BookmarkRow = {
    id: randomUUID(),
    sessionId,
    source: 'marker',
    endTs: ts,
    metadata: { orphanEnd: true },
  };
  if (name !== undefined) row.label = name;
  store.putBookmark(row);
  const wire = { id: row.id, type: 'end' as const, sessionId, label: row.label, endTs: ts };
  broadcast('marker:closed', wire);
  res.status(201).json(wire);
});

export default router;
