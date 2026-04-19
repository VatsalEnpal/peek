import type { Session } from '../pipeline/model';

const COMMAND_TAG_RE =
  /<(?:local-command-caveat|command-name|command-message|command-args)>[\s\S]*?<\/(?:local-command-caveat|command-name|command-message|command-args)>/g;

function cleanPrompt(raw: string | undefined): string {
  if (!raw) return '';
  return raw.replace(COMMAND_TAG_RE, '').trim();
}

function timeAgo(ts: string | undefined, now: Date = new Date()): string {
  if (!ts) return 'unknown';
  const then = new Date(ts).getTime();
  if (isNaN(then)) return 'unknown';
  const deltaMs = Math.max(0, now.getTime() - then);
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** Compose a human-readable session label per the plan's identity spec. */
export function composeLabel(
  session: Pick<Session, 'id' | 'slug' | 'gitBranch' | 'firstPrompt' | 'startTs'>,
  now?: Date
): string {
  const slug = session.slug ?? session.id.slice(0, 8);
  const cleaned = cleanPrompt(session.firstPrompt);
  const first = cleaned.length > 40 ? `${cleaned.slice(0, 40)}…` : cleaned || '(no prompt)';
  const branch = session.gitBranch ?? 'no-branch';
  const ago = timeAgo(session.startTs, now);
  return `${slug} · "${first}" · ${branch} · ${ago}`;
}

export { cleanPrompt, timeAgo };
