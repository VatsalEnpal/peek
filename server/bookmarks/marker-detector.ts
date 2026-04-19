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

const START_REGEX = /@peek-start(?:[ \t]+([^\n]*))?/;
const END_REGEX = /@peek-end\b/;

/**
 * Strict, anchored marker recogniser introduced in v0.2.1 (L1.3).
 *
 * Matches a single line whose sole payload is a marker directive, e.g.:
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
 * whitespace. Unanchored detection (legacy `detectMarkers`) remains for the
 * v0.2.0 importer path so we don't regress the existing acceptance tests.
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

type TextEvent = { text: string; ts?: string; turnId?: string };

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
        return { text, ts: e.timestamp };
      });
  }
  return session.turns.map((t) => ({ text: '', ts: t.startTs }));
}

export function detectMarkers(session: Session, rawEvents?: any[]): MarkerBookmark[] {
  const texts = extractUserTexts(session, rawEvents);
  const bookmarks: MarkerBookmark[] = [];
  const warnings: string[] = [];

  let open: { label: string; startTs: string } | null = null;

  for (const ev of texts) {
    if (!ev.text) continue;
    const startMatch = ev.text.match(START_REGEX);
    const endMatch = ev.text.match(END_REGEX);

    if (startMatch) {
      if (open) {
        warnings.push(`nested @peek-start while "${open.label}" was open; keeping original`);
      } else {
        const label = (startMatch[1] ?? '').trim() || 'unlabeled';
        open = { label, startTs: ev.ts ?? new Date().toISOString() };
      }
    }

    if (endMatch) {
      if (!open) {
        warnings.push('orphan @peek-end with no @peek-start; ignored');
        continue;
      }
      bookmarks.push({
        id: `bm-${randomUUID()}`,
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
    bookmarks.push({
      id: `bm-${randomUUID()}`,
      sessionId: session.id,
      label: open.label,
      source: 'marker',
      startTs: open.startTs,
      metadata: { warnings: ['unclosed @peek-start; endTs omitted'] },
    });
  }

  return bookmarks;
}
