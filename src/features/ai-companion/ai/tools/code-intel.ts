import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { checkReadableCanonical } from "../lib/security";
import type { ToolContext } from "./context";

let sidecarSession: Promise<number> | undefined;

function session() {
  sidecarSession ??= native.codeIntelSpawn().catch((error) => {
    sidecarSession = undefined;
    throw error;
  });
  return sidecarSession;
}

async function request(payload: Record<string, unknown>) {
  try {
    return await native.codeIntelRequest(await session(), payload);
  } catch (error) {
    sidecarSession = undefined;
    throw error;
  }
}

async function workspaceRoot(ctx: ToolContext) {
  const root = ctx.getWorkspaceRoot();
  if (!root) return { ok: false as const, error: "no workspace is open." };
  const safety = await checkReadableCanonical(root, native.canonicalize);
  return safety.ok
    ? { ok: true as const, root: safety.canonical }
    : { ok: false as const, error: safety.reason };
}

export function buildCodeIntelTools(ctx: ToolContext) {
  return {
    trace_code: tool({
      description:
        "Trace a function's callers and callees in the open workspace. Use this before reading many files when you need the local call chain. Read-only; TypeScript/JavaScript call edges are most complete.",
      inputSchema: z.object({
        function_name: z.string().min(1).describe("Function name to trace."),
      }),
      execute: async ({ function_name }) => {
        const root = await workspaceRoot(ctx);
        if (!root.ok) return { error: root.error };
        try {
          return await request({
            type: "trace_call_chain",
            repo_path: root.root,
            function_name,
            direction: "both",
            depth: 2,
            include_tests: false,
            mode: "calls",
          });
        } catch (error) {
          return { error: String(error), root: root.root };
        }
      },
    }),
    get_exact_code: tool({
      description:
        "Get the exact source for a function or class in the open workspace. Use a qualified name when available. Read-only; returns the smallest matching declaration without graph neighbors to conserve context.",
      inputSchema: z.object({
        qualified_name: z
          .string()
          .min(1)
          .describe("Qualified or unambiguous function/class name."),
      }),
      execute: async ({ qualified_name }) => {
        const root = await workspaceRoot(ctx);
        if (!root.ok) return { error: root.error };
        try {
          return await request({
            type: "get_code_snippet",
            repo_path: root.root,
            qualified_name,
            include_neighbors: false,
          });
        } catch (error) {
          return { error: String(error), root: root.root };
        }
      },
    }),
    analyze_diff_impact: tool({
      description:
        "Show which functions may be affected by the current workspace changes versus main. Use before edits or review to find the inbound blast radius. Read-only; depth is capped to keep context focused.",
      inputSchema: z.object({}),
      execute: async () => {
        const root = await workspaceRoot(ctx);
        if (!root.ok) return { error: root.error };
        try {
          return await request({
            type: "diff_impact",
            repo_path: root.root,
            base: "main",
            direction: "inbound",
            depth: 2,
          });
        } catch (error) {
          return { error: String(error), root: root.root };
        }
      },
    }),
  } as const;
}
