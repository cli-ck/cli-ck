import { create } from "zustand";

/**
 * Client-side mirror of whether a `browser_automate` session is running —
 * not polled from the backend. The only two ways a session starts/stops in
 * v1 are the exact two call sites that already update this (browser.ts's
 * tool execute, and the status bar's own Stop button), so this stays
 * accurate without periodic IPC overhead. If a second way to control the
 * session shows up later, this earns a real status poll then.
 */
type BrowserAutomationStore = {
  active: boolean;
  url: string | null;
  setActive: (url: string | null) => void;
  setInactive: () => void;
};

export const useBrowserAutomationStore = create<BrowserAutomationStore>(
  (set) => ({
    active: false,
    url: null,
    setActive: (url) => set({ active: true, url }),
    setInactive: () => set({ active: false, url: null }),
  }),
);
