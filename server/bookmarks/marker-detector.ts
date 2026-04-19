import { randomUUID } from 'node:crypto';
import type { Session } from '../pipeline/model';

export type MarkerBookmark = {
  id: string;
  sessionId: string;
  label: string;
  source: 'marker';
  startTs: string;
  endTs?: string;
  metadata?: { warnings?: string[] };
};

/**
 * Strict, anchored marker recogniser.
 *
 * Matches a user_prompt whose entire payload IS a marker directive, e.g.:
 *
 *   /peek_start NAME
 *   @peek-start NAME
 *   /peek_end
 *   @peek-end
 *
 * Sigil may be `@` or `/`; separator may be `-` or `_`; case-insensitive on
 * the sigil+keyword segment; name (when present) preserves its original
 * casing and internal whitespace, with leading/trailing whitespace trimmed.
 *
 * Plain-prose mentions like "I will @peek-start later" do NOT match — the
 * regex is anchored and rejects anything after the name that isn't
 * whitespace. The v0.2.0 loose inline fallback was removed in v0.3 (L1.2)
 * per the spec — "only match as the WHOLE user_prompt text, not prose".
 */
const MARKER_REGEX = /^\s*(?:@|\/)peek[-_](start|end)(?:\s+(.+?))?\s*$/i;

export type MarkerMatch = { type: 'start' | 'end'; name?: string };

export function matchMarker(text: string): MarkerMatch | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const m = text.match(MARKER_REGEX);
  if (!m) return null;
  const type = m[1].toLowerCase() as 'start' | 'end';
  const rawName = m[2];
  if (rawName === undefined) return { type };
  const name = rawName.trim();
  if (name.length === 0) return { type };
  return { type, name };
}

type TextEvent = { text: string; ts?: string; turnId?: string; uuid?: string };

function extractUserTexts(session: Session, rawEvents?: any[]): TextEvent[] {
  if (rawEvents) {
    return rawEvents
      .filter((e) => e?.type === 'user')
      .map((e) => {
        const c = e.message?.content;
        const text =
          typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? c
                  .filter((b: any) => b?.type === 'text')
                  .map((b: any) => b.text ?? '')
                  .join('\n')
              : '';
        return { text, ts: e.timestamp, uuid: e.uuid };
      });
  }
  return session.turns.map((t) => ({ text: '', ts: t.startTs }));
}

export function detectMarkers(session: Session, rawEvents?: any[]): MarkerBookmark[] {
  const texts = extractUserTexts(session, rawEvents);
  const bookmarks: MarkerBookmark[] = [];
  const warnings: string[] = [];

  // Deterministic bookmark id — derived from the *starting* event's uuid so
  // re-importing the same JSONL produces identical ids and `INSERT OR REPLACE`
  // becomes a no-op instead of a duplicate. Falls back to randomUUID when the
  // source event lacks a uuid (hand-built test fixtures).
  let open: { label: string; startTs: string; startUuid?: string } | null = null;

  for (const ev of texts) {
    if (!ev.text) continue;

    // Strict anchored matcher only — the v0.2.0 loose inline fallback was
    // removed in v0.3 (L1.2) so prose mentioning "@peek-end" in docs can no
    // longer mint stray bookmarks.
    const strict = matchMarker(ev.text);
    if (!strict) continue;

    if (strict.type === 'start') {
      if (open) {
        warnings.push(
          `nested /peek_start or @peek-start while "${open.label}" was open; keeping original`
        );
        continue;
      }
      const label = strict.name ?? 'unlabeled';
      open = {
        label,
        startTs: ev.ts ?? new Date().toISOString(),
      };
      if (ev.uuid !== undefined) open.startUuid = ev.uuid;
    } else {
      // type === 'end'
      if (!open) {
        warnings.push('orphan /peek_end or @peek-end with no start; ignored');
        continue;
      }
      const id = open.startUuid ? `bm-${open.startUuid}` : `bm-${randomUUID()}`;
      bookmarks.push({
        id,
        sessionId: session.id,
        label: open.label,
        source: 'marker',
        startTs: open.startTs,
        endTs: ev.ts,
        metadata: warnings.length ? { warnings: [...warnings] } : undefined,
      });
      open = null;
    }
  }

  if (open) {
    const id = open.startUuid ? `bm-${open.startUuid}` : `bm-${randomUUID()}`;
    bookmarks.push({
      id,
      sessionId: session.id,
      label: open.label,
      source: 'marker',
      startTs: open.startTs,
      metadata: { warnings: ['unclosed @peek-start; endTs omitted'] },
    });
  }

  return bookmarks;
}
