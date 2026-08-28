import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { useBrowserAutomationStore } from "../store/browserAutomationStore";
import type { ToolContext } from "./context";

export function buildBrowserTools(ctx: ToolContext) {
  return {
    browser_execute: tool({
      description:
        "Run a script against the open preview pane's page — one call, not one tool-per-action. `js` is the body of an async function with four locals bound: click(locator), fill(locator, value), wait(locator | ms), read(locator). A locator is `css:`, `xpath:`, `text:`, `role:name[...]`, or `testid:` prefixed (bare strings are treated as css:). Whatever the script returns is JSON-serialized back to you. Use this instead of separate click/fill/wait calls — compile the whole interaction into one script. Requires a preview tab to already be open (see open_preview). Set include_snapshot to get a compact `ref=N role=... name=\"...\"` listing of interactive elements back — cheaper and more precise than a screenshot when you need to see what's on the page. Example js: `await click('role:button[Sign in]'); await fill('css:#email', 'a@b.com'); return await read('css:.status');`. Asks for user approval.",
      inputSchema: z.object({
        js: z
          .string()
          .describe("Async function body to run in the preview page."),
        include_snapshot: z
          .boolean()
          .optional()
          .describe(
            "Return a compact element listing alongside the result. Default true.",
          ),
      }),
      needsApproval: !ctx.autoApprove,
      execute: async ({ js, include_snapshot }) => {
        const result = await ctx.runInPreview(js, {
          includeSnapshot: include_snapshot ?? true,
        });
        if (!result) {
          return {
            error:
              "no preview tab is open — call open_preview first, then retry.",
          };
        }
        if (!result.ok) {
          return {
            error: result.error ?? "script failed",
            snapshot: result.snapshot,
          };
        }
        return { result: result.result, snapshot: result.snapshot };
      },
    }),

    browser_automate: tool({
      description:
        "Run a script against a real, separate browser window — for testing against sites the preview iframe can't reach (external URLs, auth flows, anything outside the local dev server). Launches on first call, using the system's installed Chrome; stays open (and visible — the user can see it) across calls until close_session is set or browser_automation_stop is called elsewhere. Same script model as browser_execute: `js` is an async function body with click(locator)/fill(locator, value)/wait(locator | ms)/read(locator) bound. Pass url to navigate there first (real navigation, waits for load). Set include_snapshot for a compact `ref=N role=... name=\"...\"` element listing. Prefer browser_execute for the app's own dev preview — reach for this only when you actually need a real, separate browser. Asks for user approval.",
      inputSchema: z.object({
        url: z
          .string()
          .optional()
          .describe("Navigate here first, before running js."),
        js: z.string().describe("Async function body to run in the page."),
        include_snapshot: z
          .boolean()
          .optional()
          .describe(
            "Return a compact element listing alongside the result. Default true.",
          ),
        close_session: z
          .boolean()
          .optional()
          .describe("Close the browser window after this call. Default false."),
      }),
      needsApproval: !ctx.autoApprove,
      execute: async ({ url, js, include_snapshot, close_session }) => {
        let result: Awaited<ReturnType<typeof native.browserAutomationRun>>;
        try {
          result = await native.browserAutomationRun(js, {
            url,
            includeSnapshot: include_snapshot ?? true,
          });
        } catch (e) {
          // Only a launch/navigation-infrastructure failure reaches here
          // (e.g. no Chrome installed) — a script error or bad locator
          // comes back as {ok:false, error} above, not a rejection.
          return { error: String(e) };
        }
        if (close_session) {
          await native.browserAutomationStop().catch(() => {});
          useBrowserAutomationStore.getState().setInactive();
        } else {
          useBrowserAutomationStore.getState().setActive(result.url);
        }
        if (!result.ok) {
          return {
            error: result.error ?? "script failed",
            snapshot: result.snapshot,
            url: result.url,
          };
        }
        return {
          result: result.result,
          snapshot: result.snapshot,
          url: result.url,
        };
      },
    }),
  } as const;
}
