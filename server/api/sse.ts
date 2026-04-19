/**
 * Server-Sent Events endpoint — v0.2.1 L1.2.
 *
 * `GET /api/events/stream` holds the connection open, emits a keep-alive
 * comment every HEARTBEAT_MS, and forwards every event passed to the
 * module-level `broadcast(event, data)` helper to all live subscribers.
 *
 * Event names used by Peek live-mode:
 *   - `session:new`      — importer created a new session row
 *   - `span:new`         — importer appended a span to an existing session
 *   - `marker:opened`    — POST /api/markers `type=start`
 *   - `marker:closed`    — POST /api/markers `type=end` (or start->end in JSONL)
 *
 * Fan-out is a simple Set of Response objects; we remove clients on the
 * socket `close` event. No back-pressure handling — events are tiny.
 */

import { Router, type Request, type Response } from 'express';

const HEARTBEAT_MS = 15_000;

const clients = new Set<Response>();

/**
 * Send a single SSE event to every connected subscriber.
 * Silent on empty subscriber sets so callers don't have to check first.
 */
export function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // Broken pipe — the close handler will purge the client; don't rethrow.
    }
  }
}

/** Test-only helper: count live subscribers. Exported for integration tests. */
export function subscriberCount(): number {
  return clients.size;
}

const router = Router();

router.get('/stream', (req: Request, res: Response) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Flush headers immediately so the client transitions out of the request
  // phase — otherwise no `data` events reach the handler until the response
  // buffer fills.
  res.flushHeaders?.();

  // Initial comment to confirm the stream is open. Comments (leading `:`) are
  // ignored by EventSource but keep proxies from closing the socket for idle.
  res.write(': peek-sse connected\n\n');

  clients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    } catch {
      // ignore — close handler cleans up.
    }
  }, HEARTBEAT_MS);
  // Don't keep the event loop alive just for heartbeats (matters for tests
  // and for `peek serve` shutdown under SIGTERM).
  heartbeat.unref?.();

  const cleanup = (): void => {
    clearInterval(heartbeat);
    clients.delete(res);
  };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
  res.on('close', cleanup);
});

export default router;
