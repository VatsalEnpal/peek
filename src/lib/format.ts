/**
 * Display formatters. Keep pure — no React, no stores.
 * Monospace-column-safe (fixed-width outputs) so the timeline stays grid-locked.
 */

/** `HH:MM:SS` in local TZ. Returns `--:--:--` for missing input. */
export function formatClock(iso: string | undefined | null): string {
  if (!iso) return '--:--:--';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '--:--:--';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
}

/** Thousand-separated integer. `12_345` → `"12,345"`. `null/undefined` → `"—"`. */
export function formatTokens(n: number | undefined | null): string {
  if (n === undefined || n === null) return '—';
  return n.toLocaleString('en-US');
}

/** Short human duration: `842ms`, `3.2s`, `1m24s`. */
export function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/** Truncate with ellipsis, preserving a monospace-friendly max column. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}
