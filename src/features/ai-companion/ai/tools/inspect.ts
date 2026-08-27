import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";

export function buildInspectTools(ctx: ToolContext) {
  return {
    inspect_ui_element: tool({
      description:
        "Ask the user to click an element in the open preview pane, then return structured facts about it: CSS selector, a capped set of computed styles, ARIA attributes, bounding rect, and (when the previewed app is React in dev mode) a file:line source pointer. Cheaper and more precise than asking for a screenshot — use this instead of guessing at a selector or asking the user to describe styling. Requires a preview tab to already be open (see open_preview) and pauses until the user clicks an element or ~60s elapses.",
      inputSchema: z.object({}),
      execute: async () => {
        const facts = await ctx.requestElementInspection();
        if (!facts) {
          return {
            error:
              "no element was selected — either no preview tab is open, or the user didn't click anything in time. Ask the user to open a preview (open_preview) and try again.",
          };
        }
        return facts;
      },
    }),
  } as const;
}
