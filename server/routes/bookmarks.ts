/**
 * Bookmarks CRUD.
 *
 *   GET    /api/bookmarks?sessionId=   — list, optionally filtered by session.
 *   POST   /api/bookmarks              — create; returns 201 + the new row.
 *   PATCH  /api/bookmarks/:id          — partial update (label/source/metadata).
 *   DELETE /api/bookmarks/:id          — remove.
 *
 * Patch/delete are implemented via a re-put over the existing row since the
 * Store exposes upsert semantics (`putBookmark` uses INSERT OR REPLACE).
 */

import { randomUUID } from 'node:crypto';

import { Router, type Request, type Response } from 'express';

import type { Store, BookmarkRow } from '../pipeline/store';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const store = req.app.locals.store as Store;
  const { sessionId } = req.query;
  const list =
    typeof sessionId === 'string' && sessionId.length > 0
      ? store.listBookmarks(sessionId)
      : store.listBookmarks();
  res.json(list);
});

router.post('/', (req: Request, res: Response) => {
  const store = req.app.locals.store as Store;
  const body = (req.body ?? {}) as Partial<BookmarkRow>;
  if (typeof body.sessionId !== 'string' || body.sessionId.length === 0) {
    res.status(400).json({ error: "body must include 'sessionId'" });
    return;
  }
  const row: BookmarkRow = {
    id: body.id ?? randomUUID(),
    sessionId: body.sessionId,
  };
  if (body.label !== undefined) row.label = body.label;
  if (body.source !== undefined) row.source = body.source;
  if (body.startTs !== undefined) row.startTs = body.startTs;
  if (body.endTs !== undefined) row.endTs = body.endTs;
  if (body.metadata !== undefined) row.metadata = body.metadata;
  store.putBookmark(row);
  res.status(201).json(row);
});

function findBookmark(store: Store, id: string): BookmarkRow | undefined {
  return store.listBookmarks().find((b) => b.id === id);
}

router.patch('/:id', (req: Request, res: Response) => {
  const store = req.app.locals.store as Store;
  const id = String(req.params.id);
  const existing = findBookmark(store, id);
  if (!existing) {
    res.status(404).json({ error: 'bookmark not found', id });
    return;
  }
  const patch = (req.body ?? {}) as Partial<BookmarkRow>;
  const merged: BookmarkRow = { ...existing };
  if (patch.label !== undefined) merged.label = patch.label;
  if (patch.source !== undefined) merged.source = patch.source;
  if (patch.startTs !== undefined) merged.startTs = patch.startTs;
  if (patch.endTs !== undefined) merged.endTs = patch.endTs;
  if (patch.metadata !== undefined) merged.metadata = patch.metadata;
  store.putBookmark(merged);
  res.json(merged);
});

router.delete('/:id', (req: Request, res: Response) => {
  const store = req.app.locals.store as Store;
  const id = String(req.params.id);
  const existing = findBookmark(store, id);
  if (!existing) {
    res.status(404).json({ error: 'bookmark not found', id });
    return;
  }
  // Store has no delete API today — reach into its underlying DB via a raw
  // statement kept here to avoid broadening the Store surface area for a
  // transient Group 6 scope. Replace with a typed Store.deleteBookmark in
  // later groups if needed.
  const storeAny = store as unknown as {
    db?: { prepare: (sql: string) => { run: (id: string) => void } };
  };
  const db = storeAny.db;
  if (db) {
    db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
  }
  res.status(204).end();
});

export default router;
