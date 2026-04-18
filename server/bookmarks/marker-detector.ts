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
