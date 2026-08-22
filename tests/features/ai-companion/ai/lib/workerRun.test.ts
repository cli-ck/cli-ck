import { toolFilterForRole } from "@/features/ai-companion/ai/lib/workerRun";
import { describe, expect, it } from "vitest";

describe("toolFilterForRole", () => {
  it("keeps planner and reviewer read-only", () => {
    for (const role of ["planner", "reviewer"] as const) {
      const filter = toolFilterForRole(role);
      expect(filter("read_file")).toBe(true);
      expect(filter("grep")).toBe(true);
      expect(filter("write_file")).toBe(false);
      expect(filter("bash_run")).toBe(false);
    }
  });

  it("gives builder and step full tool access", () => {
    for (const role of ["builder", "step"] as const) {
      const filter = toolFilterForRole(role);
      expect(filter("write_file")).toBe(true);
      expect(filter("bash_run")).toBe(true);
      expect(filter("edit")).toBe(true);
    }
  });

  it("blocks recursive spawn/managed-agent tools for every role", () => {
    for (const role of ["planner", "builder", "reviewer", "step"] as const) {
      const filter = toolFilterForRole(role);
      expect(filter("run_subagent")).toBe(false);
      expect(filter("spawn_worker")).toBe(false);
      expect(filter("spawn_team")).toBe(false);
      expect(filter("spawn_coding_agent")).toBe(false);
    }
  });
});
