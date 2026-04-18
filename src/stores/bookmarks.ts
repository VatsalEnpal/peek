/**
 * Client-side bookmarks cache — keyed by sessionId. SessionPicker fetches a
 * session's bookmarks the first time the user expands it; cached entries are
 * shown instantly on subsequent expansions.
 */

import { create } from 'zustand';

import { listBookmarks, type BookmarkDto } from '../lib/api';

export type BookmarksState = {
  bySession: Record<string, BookmarkDto[]>;
  loading: boolean;
  error: string | null;

  fetchForSession: (sessionId: string) => Promise<void>;
  invalidate: (sessionId?: string) => void;
};

export const useBookmarksStore = create<BookmarksState>((set, get) => ({
  bySession: {},
  loading: false,
  error: null,

  async fetchForSession(sessionId) {
    if (get().bySession[sessionId]) return; // cache hit
    set({ loading: true, error: null });
    try {
      const bms = await listBookmarks(sessionId);
      set((s) => ({
        loading: false,
        bySession: { ...s.bySession, [sessionId]: bms },
      }));
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  invalidate(sessionId) {
    if (!sessionId) {
      set({ bySession: {} });
      return;
    }
    set((s) => {
      const next = { ...s.bySession };
      delete next[sessionId];
      return { bySession: next };
    });
  },
}));
