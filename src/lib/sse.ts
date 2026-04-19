/**
 * Browser-side SSE subscriber — v0.2.1 L2.1.
 *
 * Thin wrapper around the native `EventSource` that:
 *   - Targets `/api/events/stream` (the L1 endpoint).
 *   - Dispatches the four live-mode events to the supplied callback:
 *     `session:new`, `span:new`, `marker:opened`, `marker:closed`.
 *   - Reconnects automatically with exponential backoff — 1s, 2s, 4s, 8s,
 *     16s, capped at 30s — and resets the schedule after a successful
 *     `open` event.
 *   - Returns an unsubscribe function that closes the socket and cancels any
 *     pending reconnect timer so React effects can clean up without leaks.
 *
 * The callback receives `(eventName, parsedJsonPayload)`. Frames whose `data:`
 * field isn't valid JSON are dropped (logged to the console for diagnostics)
 * — we never want a badly-formatted frame to throw out of the event pump.
 */

const STREAM_URL = '/api/events/stream';

const EVENT_NAMES = [
  'session:new',
  'span:new',
  'marker:opened',
  'marker:closed',
] as const;

const BACKOFF_SCHEDULE_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

export type SseEventName = (typeof EVENT_NAMES)[number];

export type SseListener = (event: string, data: unknown) => void;

/**
 * Subscribe to the live SSE stream.
 *
 * @param onEvent  Callback invoked for each named event. Data is the parsed
 *                 JSON payload from the `data:` frame.
 * @returns        Unsubscribe function — call to stop receiving events and
 *                 close the underlying connection.
 */
export function subscribe(onEvent: SseListener): () => void {
  let currentSource: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffIndex = 0;
  let cancelled = false;

  const open = (): void => {
    if (cancelled) return;
    const es = new EventSource(STREAM_URL);
    currentSource = es;

    es.onopen = (): void => {
      // A successful open resets the backoff — the next disconnect starts
      // fresh at the 1s step.
      backoffIndex = 0;
    };

    for (const name of EVENT_NAMES) {
      es.addEventListener(name, (ev: MessageEvent): void => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(ev.data as string);
        } catch {
          // Drop malformed frames rather than surface an exception into the
          // React render path; live-mode noise must never crash the UI.
          // eslint-disable-next-line no-console
          console.warn('[peek-sse] dropped malformed frame for', name);
          return;
        }
        onEvent(name, parsed);
      });
    }

    es.onerror = (): void => {
      // EventSource fires `error` both on transient drops and permanent
      // failures. We always close + reconnect with backoff; the native
      // auto-reconnect retries too fast and ignores server-side 503s.
      try {
        es.close();
      } catch {
        /* ignore */
      }
      if (currentSource === es) currentSource = null;
      scheduleReconnect();
    };
  };

  const scheduleReconnect = (): void => {
    if (cancelled) return;
    if (reconnectTimer !== null) return; // already pending
    const delay =
      BACKOFF_SCHEDULE_MS[Math.min(backoffIndex, BACKOFF_SCHEDULE_MS.length - 1)] ??
      30_000;
    backoffIndex = Math.min(backoffIndex + 1, BACKOFF_SCHEDULE_MS.length - 1);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  };

  open();

  return () => {
    cancelled = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (currentSource !== null) {
      try {
        currentSource.close();
      } catch {
        /* ignore */
      }
      currentSource = null;
    }
  };
}
