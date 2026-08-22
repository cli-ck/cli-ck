import type { ModelInfo } from "@/features/ai-companion/ai/config";
import { resolveTierModel } from "@/features/ai-companion/ai/lib/modelTiers";
import { describe, expect, it } from "vitest";

// Real ids so getModelContextLimit resolves a real window: qwen-3-32b = 32_000,
// claude-sonnet-5 = 1_000_000 (see MODEL_CONTEXT_LIMITS).
const smallLight: ModelInfo = {
  id: "qwen-3-32b",
  provider: "groq",
  label: "Small",
  hint: "small",
  description: "light tier, tiny context window",
  capabilities: { intelligence: 2, speed: 5, cost: 5 },
};
const bigHeavy: ModelInfo = {
  id: "claude-sonnet-5",
  provider: "anthropic",
  label: "Big",
  hint: "big",
  description: "heavy tier, huge context window",
  capabilities: { intelligence: 5, speed: 2, cost: 1 },
};
const pool = [smallLight, bigHeavy];

describe("resolveTierModel", () => {
  it("picks the requested tier when no token estimate is given (unchanged behavior)", () => {
    expect(resolveTierModel("light", pool, {})).toBe(smallLight);
  });

  it("escalates past a tier whose context window can't hold the conversation", () => {
    // 50k tokens clears qwen-3-32b's 0.7 * 32_000 = 22_400 safety margin but
    // fits comfortably under claude-sonnet-5's 1M window.
    expect(resolveTierModel("light", pool, {}, 50_000)).toBe(bigHeavy);
  });

  it("falls back to the unfiltered pool when nothing fits, instead of returning nothing", () => {
    expect(resolveTierModel("light", pool, {}, 5_000_000)).toBe(smallLight);
  });
});

describe("resolveTierModel friction", () => {
  const light2: ModelInfo = {
    id: "qwen-flaky",
    provider: "groq",
    label: "Small (flaky)",
    hint: "small",
    description: "light tier, second candidate",
    capabilities: { intelligence: 2, speed: 5, cost: 5 },
  };
  const pool2 = [smallLight, light2, bigHeavy];

  it("prefers a non-flagged candidate in the same tier over a flagged one", () => {
    const isHighFriction = (id: string) => id === "qwen-3-32b";
    expect(resolveTierModel("light", pool2, {}, undefined, isHighFriction)).toBe(
      light2,
    );
  });

  it("still returns the only candidate in a tier even if it's flagged", () => {
    const isHighFriction = () => true;
    expect(resolveTierModel("heavy", pool2, {}, undefined, isHighFriction)).toBe(
      bigHeavy,
    );
  });

  it("ignores friction entirely when the callback is omitted (unchanged behavior)", () => {
    expect(resolveTierModel("light", pool2, {})).toBe(smallLight);
  });
});
