/**
 * Selection / drawer state. Separate store so timeline re-renders don't wipe
 * inspector state and vice-versa.
 *
 * Mode B ("focus range") lives here too — the timeline dims rows out of range
 * and the FocusBar reads startTs/endTs for its save action.
 */

import { create } from 'zustand';

export type FocusRange = { startTs?: string; endTs?: string };

export type SelectionState = {
  selectedSpanId: string | null;
  drawerOpen: boolean;
  helpOpen: boolean;
  focusRange: FocusRange;
  contextMenuRowId: string | null;

  selectSpan: (id: string | null) => void;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleHelp: () => void;
  setHelp: (open: boolean) => void;

  setFocusStart: (ts: string) => void;
  setFocusEnd: (ts: string) => void;
  clearFocus: () => void;
  openContextMenu: (rowId: string) => void;
  closeContextMenu: () => void;
};

export const useSelectionStore = create<SelectionState>((set) => ({
  selectedSpanId: null,
  drawerOpen: false,
  helpOpen: false,
  focusRange: {},
  contextMenuRowId: null,

  selectSpan(id) {
    set({ selectedSpanId: id, drawerOpen: id !== null });
  },
  openDrawer() {
    set({ drawerOpen: true });
  },
  closeDrawer() {
    set({ drawerOpen: false });
  },
  toggleHelp() {
    set((s) => ({ helpOpen: !s.helpOpen }));
  },
  setHelp(open) {
    set({ helpOpen: open });
  },

  setFocusStart(ts) {
    set((s) => ({ focusRange: { ...s.focusRange, startTs: ts } }));
  },
  setFocusEnd(ts) {
    set((s) => ({ focusRange: { ...s.focusRange, endTs: ts } }));
  },
  clearFocus() {
    set({ focusRange: {} });
  },
  openContextMenu(rowId) {
    set({ contextMenuRowId: rowId });
  },
  closeContextMenu() {
    set({ contextMenuRowId: null });
  },
}));

/**
 * True iff the given row timestamp lies within the configured focus range.
 *
 * Rules:
 *  - No startTs + no endTs → everything in range.
 *  - startTs only → ts >= startTs.
 *  - endTs only → ts <= endTs.
 *  - both → inclusive [startTs, endTs].
 *  - row ts missing → treat as in range (don't hide events with no timestamp).
 */
export function inFocusRange(rowTs: string | undefined, range: FocusRange): boolean {
  if (!range.startTs && !range.endTs) return true;
  if (!rowTs) return true;
  if (range.startTs && rowTs < range.startTs) return false;
  if (range.endTs && rowTs > range.endTs) return false;
  return true;
}
