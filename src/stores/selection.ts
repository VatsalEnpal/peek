/**
 * Selection / drawer state. Separate store so timeline re-renders don't wipe
 * inspector state and vice-versa.
 */

import { create } from 'zustand';

export type SelectionState = {
  selectedSpanId: string | null;
  drawerOpen: boolean;
  helpOpen: boolean;

  selectSpan: (id: string | null) => void;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleHelp: () => void;
  setHelp: (open: boolean) => void;
};

export const useSelectionStore = create<SelectionState>((set) => ({
  selectedSpanId: null,
  drawerOpen: false,
  helpOpen: false,

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
}));
