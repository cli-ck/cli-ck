import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";

export function buildBrowserTools(ctx: ToolContext) {
  return {
    browser_execute: tool({
      description:
        "Run a script against the open preview pane's page — one call, not one tool-per-action. `js` is the body of an async function with four locals bound: click(locator), fill(locator, value), wait(locator | ms), read(locator). A locator is `css:`, `xpath:`, `text:`, `role:name[...]`, or `testid:` prefixed (bare strings are treated as css:). Whatever the script returns is JSON-serialized back to you. Use this instead of separate click/fill/wait calls — compile the whole interaction into one script. Requires a preview tab to already be open (see open_preview). Set include_snapshot to get a compact `ref=N role=... name=\"...\"` listing of interactive elements back — cheaper and more precise than a screenshot when you need to see what's on the page. Example js: `await click('role:button[Sign in]'); await fill('css:#email', 'a@b.com'); return await read('css:.status');`. Asks for user approval.",
      inputSchema: z.object({
        js: z.string().describe("Async function body to run in the preview page."),
        include_snapshot: z
          .boolean()
          .optional()
          .describe("Return a compact element listing alongside the result. Default true."),
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
          return { error: result.error ?? "script failed", snapshot: result.snapshot };
        }
        return { result: result.result, snapshot: result.snapshot };
      },
    }),
  } as const;
}
