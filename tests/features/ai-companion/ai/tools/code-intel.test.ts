import { describe, expect, it, vi } from "vitest";

const sidecar = vi.hoisted(() => ({
  canonicalize: vi.fn(async (path: string) => path),
  codeIntelSpawn: vi.fn(async () => 42),
  codeIntelRequest: vi.fn(async () => ({ callers: [], callees: [] })),
}));

vi.mock("@/features/ai-companion/ai/lib/native", () => ({ native: sidecar }));

import { buildCodeIntelTools } from "@/features/ai-companion/ai/tools/code-intel";
import type { ToolContext } from "@/features/ai-companion/ai/tools/context";

const context = {
  getCwd: () => "/work/click",
  getWorkspaceRoot: () => "/work/click",
} as ToolContext;

const execution = { toolCallId: "test", messages: [], context: {} };

describe("Code Intel AI tools", () => {
  it("traces a function through the shared sidecar session", async () => {
    const tools = buildCodeIntelTools(context);

    await tools.trace_code.execute({ function_name: "saveWorkspace" }, execution);

    expect(sidecar.codeIntelSpawn).toHaveBeenCalledTimes(1);
    expect(sidecar.codeIntelRequest).toHaveBeenCalledWith(42, {
      type: "trace_call_chain",
      repo_path: "/work/click",
      function_name: "saveWorkspace",
      direction: "both",
      depth: 2,
      include_tests: false,
      mode: "calls",
    });
  });

  it("looks up exact source without expanding graph neighbors", async () => {
    const tools = buildCodeIntelTools(context);

    await tools.get_exact_code.execute(
      { qualified_name: "workspace.save" },
      execution,
    );

    expect(sidecar.codeIntelRequest).toHaveBeenCalledWith(42, {
      type: "get_code_snippet",
      repo_path: "/work/click",
      qualified_name: "workspace.save",
      include_neighbors: false,
    });
  });

  it("maps the current change's inbound impact from main", async () => {
    const tools = buildCodeIntelTools(context);

    await tools.analyze_diff_impact.execute({}, execution);

    expect(sidecar.codeIntelRequest).toHaveBeenCalledWith(42, {
      type: "diff_impact",
      repo_path: "/work/click",
      base: "main",
      direction: "inbound",
      depth: 2,
    });
  });
});
