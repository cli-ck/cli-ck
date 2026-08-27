// Sibling declaration file for preview_bridge.js's CJS test-export hook —
// the runtime-injected copy is plain JS by necessity (see its header
// comment); this only exists so tests/preview_bridge.test.ts gets real
// types instead of `any` when it imports the actual shipped script.
declare const bridge: {
  resolveLocator: (locator: string, root?: ParentNode) => Element | null;
  parseLocator: (locator: string) => { kind: string; value: string };
  elementRole: (el: Element) => string | null;
  accessibleName: (el: Element) => string;
  parseRoleLocator: (value: string) => { role: string; name: string | null };
  buildSnapshot: (root?: Element) => string;
  readPrimitive: (
    locator: string,
  ) => { text: string; value: string | null; checked: boolean | null } | null;
  cssSelector: (el: Element) => string;
  clickPrimitive: (locator: string) => Promise<true>;
  fillPrimitive: (locator: string, value: string) => Promise<true>;
  waitPrimitive: (locatorOrMs: string | number) => Promise<boolean>;
  // biome-ignore lint/suspicious/noExplicitAny: the script can return anything
  runScript: (js: string) => Promise<any>;
};
export default bridge;
