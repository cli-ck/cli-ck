// Stand-in for @/features/shell-pty/terminal's barrel export, used only by
// this headless runner. tools/agent.ts imports `writeToSession` from that
// barrel to relay agent output into a live GUI pty pane; the real barrel
// also re-exports React components that transitively pull in @xterm/xterm,
// which isn't pre-bundled outside a real Vite dev server and breaks SSR
// module loading. Headless runs never have a live pty pane
// (toolContext.injectIntoActivePty always returns false here), so this
// no-op is behaviorally equivalent for benchmarking purposes.
export function writeToSession(_leafId: number, _data: string): boolean {
  return false;
}
