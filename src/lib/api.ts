/**
 * Minimal fetch wrapper. Base URL is empty so the Vite dev-server proxy (or the
 * bundled server in prod) handles routing to `/api/*`. Override with
 * `VITE_PEEK_API_BASE` for split-process dev.
 */

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const BASE = env.VITE_PEEK_API_BASE ?? '';

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, body, msg);
  }
  return body as T;
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'GET', signal });
  return parse<T>(res);
}

export async function apiPost<T>(
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body ?? {}),
  });
  return parse<T>(res);
}

export async function apiPatch<T>(
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body ?? {}),
  });
  return parse<T>(res);
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE' });
  return parse<T>(res);
}

// --- Bookmark helpers (thin wrappers kept here to centralise path strings) ---

export type BookmarkDto = {
  id: string;
  sessionId: string;
  label?: string;
  source?: 'record' | 'focus' | 'marker' | string;
  startTs?: string;
  endTs?: string;
  metadata?: Record<string, unknown>;
};

export async function listBookmarks(sessionId?: string): Promise<BookmarkDto[]> {
  const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  return apiGet<BookmarkDto[]>(`/api/bookmarks${qs}`);
}

export async function createBookmark(
  body: Omit<BookmarkDto, 'id'> & { id?: string }
): Promise<BookmarkDto> {
  return apiPost<BookmarkDto>('/api/bookmarks', body);
}

export async function updateBookmark(
  id: string,
  patch: Partial<Pick<BookmarkDto, 'label' | 'endTs' | 'startTs' | 'metadata'>>
): Promise<BookmarkDto> {
  return apiPatch<BookmarkDto>(`/api/bookmarks/${encodeURIComponent(id)}`, patch);
}
