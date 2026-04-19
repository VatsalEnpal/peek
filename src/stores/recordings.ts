/**
 * Recordings store — v0.3 L3.
 *
 * Fetches the recordings list from /api/recordings and subscribes to SSE
 * events to keep it live:
 *   recording:started  → inject new row, pinned as live
 *   recording:ended    → flip status + stamp endTs on the matching row
 *   span:new           → if the event carries a recordingId, bump the
 *                        matching row's toolCount (best-effort; the next
 *                        refetch reconciles exact values)
 *
 * This file keeps the same shape conventions as src/stores/session.ts so the
 * two pages stay visually uniform: flat zustand slice, typed summary, no
 * selector memoisation (each component picks what it needs).
 */

import { create } from 'zustand';

import { apiGet } from '../lib/api';

export type RecordingStatus = 'recording' | 'closed' | 'auto-closed' | 'auto-closed-by-new-start';

export type RecordingSummary = {
  id: string;
  name: string;
  sessionId: string;
  startTs: string;
  endTs: string | null;
  status: RecordingStatus;
  createdAt: string;
  durationMs: number | null;
  toolCount: number;
  apiCount: number;
  totalTokens: number;
};

export type RecordingsState = {
  recordings: RecordingSummary[];
  loading: boolean;
  error: string | null;
  fetchRecordings: () => Promise<void>;
  applyStarted: (
    row: Partial<RecordingSummary> & {
      id: string;
      name: string;
      sessionId: string;
      startTs: string;
    }
  ) => void;
  applyEnded: (row: { id: string; endTs?: string; status?: RecordingStatus }) => void;
  incrementCounters: (
    recordingId: string,
    delta: { tools?: number; api?: number; tokens?: number }
  ) => void;
};

export const useRecordingsStore = create<RecordingsState>((set, get) => ({
  recordings: [],
  loading: false,
  error: null,

  async fetchRecordings(): Promise<void> {
    set({ loading: true, error: null });
    try {
      const rows = await apiGet<RecordingSummary[]>('/api/recordings');
      set({ recordings: rows, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'failed to load recordings',
      });
    }
  },

  applyStarted(row): void {
    const existing = get().recordings.find((r) => r.id === row.id);
    if (existing) return; // idempotent
    const next: RecordingSummary = {
      id: row.id,
      name: row.name,
      sessionId: row.sessionId,
      startTs: row.startTs,
      endTs: null,
      status: 'recording',
      createdAt: row.startTs,
      durationMs: null,
      toolCount: row.toolCount ?? 0,
      apiCount: row.apiCount ?? 0,
      totalTokens: row.totalTokens ?? 0,
    };
    set((state) => ({ recordings: [next, ...state.recordings] }));
  },

  applyEnded({ id, endTs, status }): void {
    set((state) => ({
      recordings: state.recordings.map((r) => {
        if (r.id !== id) return r;
        const newEndTs = endTs ?? r.endTs ?? null;
        const newStatus: RecordingStatus = status ?? 'closed';
        let durationMs = r.durationMs;
        if (newEndTs) {
          const a = Date.parse(r.startTs);
          const b = Date.parse(newEndTs);
          if (Number.isFinite(a) && Number.isFinite(b)) durationMs = b - a;
        }
        return { ...r, endTs: newEndTs, status: newStatus, durationMs };
      }),
    }));
  },

  incrementCounters(id, delta): void {
    set((state) => ({
      recordings: state.recordings.map((r) =>
        r.id === id
          ? {
              ...r,
              toolCount: r.toolCount + (delta.tools ?? 0),
              apiCount: r.apiCount + (delta.api ?? 0),
              totalTokens: r.totalTokens + (delta.tokens ?? 0),
            }
          : r
      ),
    }));
  },
}));
