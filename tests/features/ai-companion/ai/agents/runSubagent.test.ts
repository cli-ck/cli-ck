import { SUBAGENT_MAX_STEPS } from "@/features/ai-companion/ai/agents/runSubagent";
import { describe, expect, it } from "vitest";

describe("SUBAGENT_MAX_STEPS", () => {
  it("increases monotonically with tier weight", () => {
    expect(SUBAGENT_MAX_STEPS.light).toBeLessThan(SUBAGENT_MAX_STEPS.standard);
    expect(SUBAGENT_MAX_STEPS.standard).toBeLessThan(SUBAGENT_MAX_STEPS.heavy);
  });
});
