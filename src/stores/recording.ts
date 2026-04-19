/**
 * Mode A — interactive "record" state. One recording at a time; stopping
 * PATCHes endTs onto the open bookmark.
 *
 * The store never stashes an HTTP error — if POST fails we roll back state
 * and surface the error via `error` so the button can render it briefly.
 */

import { create } from 'zustand';

import { apiPatch, apiPost } from '../lib/api';

export type RecordingState = {
  isRecording: boolean;
  currentBookmarkId: string | null;
  startTs: string | null;
  label: string | null;
  error: string | null;

  startRecording: (sessionId: string, label?: string, spanId?: string) => Promise<void>;
  stopRecording: () => Promise<void>;
};

type BookmarkResponse = { id: string };

export const useRecordingStore = create<RecordingState>((set, get) => ({
  isRecording: false,
  currentBookmarkId: null,
  startTs: null,
  label: null,
  error: null,

  async startRecording(sessionId, label, spanId) {
    if (get().isRecording) return;
    const startTs = new Date().toISOString();
    const trimmed = (label ?? '').trim();
    // Build payload — only include spanId when we have one (server ignores
    // unknown fields but we keep the wire minimal for clarity).
    const payload: Record<string, unknown> = {
      sessionId,
      label: trimmed,
      source: 'record',
      startTs,
    };
    if (spanId) payload.spanId = spanId;
    try {
      const res = await apiPost<BookmarkResponse>('/api/bookmarks', payload);
      set({
        isRecording: true,
        currentBookmarkId: res.id,
        startTs,
        label: trimmed,
        error: null,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  async stopRecording() {
    const { isRecording, currentBookmarkId } = get();
    if (!isRecording || !currentBookmarkId) return;
    const endTs = new Date().toISOString();
    try {
      await apiPatch(`/api/bookmarks/${encodeURIComponent(currentBookmarkId)}`, { endTs });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
    set({
      isRecording: false,
      currentBookmarkId: null,
      startTs: null,
      label: null,
    });
  },
}));
