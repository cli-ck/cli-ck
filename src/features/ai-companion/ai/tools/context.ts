import type {
  InspectedElementFacts,
  PreviewRunResult,
} from "@/features/workspace-core/preview";

export type ToolContext = {
  /** Active terminal tab cwd, used to resolve relative paths. Null = home. */
  getCwd: () => string | null;
  /** Workspace root (explorer root). Used by tools that operate over the project. */
  getWorkspaceRoot: () => string | null;
  /** Last N lines of the active terminal buffer (or null if not a terminal tab). */
  getTerminalContext: () => string | null;
  isActiveTerminalPrivate: () => boolean;
  /**
   * Type a string into the active terminal at the prompt — without executing.
   * Returns false if there is no active terminal tab to inject into.
   */
  injectIntoActivePty: (text: string) => boolean;
  /** Open a new preview tab (in-app iframe) at the given URL. */
  openPreview: (url: string) => boolean;
  /**
   * Arms click-to-inspect on the active (or most-recently-open) preview
   * tab and waits for the user to click an element, returning structured
   * facts about it. Resolves `null` if there's no preview tab open, or the
   * user doesn't click anything before the tool's own timeout.
   */
  requestElementInspection: () => Promise<InspectedElementFacts | null>;
  /**
   * Runs `js` inside the active (or most-recently-open) preview tab's page,
   * with `click(locator)`/`fill(locator, value)`/`wait(locator | ms)`/
   * `read(locator)` bound as locals — one script per call, not one tool
   * call per action. Resolves `null` if there's no preview tab open.
   */
  runInPreview: (
    js: string,
    opts?: { includeSnapshot?: boolean },
  ) => Promise<PreviewRunResult | null>;
  /** Spawn a Claude Code agent in a new terminal tab, bound to this session. */
  spawnAgent: (prompt: string) => { tabId: number; leafId: number } | null;
  /** Read the terminal scrollback tail of a managed agent's leaf. */
  readAgentOutput: (leafId: number) => string | null;
  readCache: Map<string, { size: number; hash: number }>;
  /** Active chat session id — used by tools that persist per-session state (todos). */
  getSessionId: () => string | null;
  /**
   * Basenames the current task's own prompt said not to touch (e.g. "do not
   * change foo.test.js"). Populated per-turn by aiAgent.ts from the latest
   * user message; mutating tools reject writes to these files outright
   * rather than relying on the model to honor the instruction.
   */
  protectedFiles?: Set<string>;
  /**
   * Skips the `tool-approval-request` pause on mutating tools. Only ever
   * true for the headless benchmark runner (scripts/headless-agent) — the
   * GUI never sets this, so approval behavior there is unchanged.
   */
  autoApprove?: boolean;
};

export function resolvePath(rawPath: string, cwd: string | null): string {
  if (rawPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rawPath))
    return rawPath;
  if (!cwd)
    throw new Error(
      `cannot resolve relative path "${rawPath}": no active terminal cwd. Pass an absolute path.`,
    );
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  return cwd.endsWith(sep) ? `${cwd}${rawPath}` : `${cwd}${sep}${rawPath}`;
}

export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? p : p.slice(i + 1);
}
