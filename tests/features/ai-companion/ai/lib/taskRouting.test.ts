import { resolveTaskRoute } from "@/features/ai-companion/ai/lib/taskRouting";
import { describe, expect, it } from "vitest";

describe("resolveTaskRoute", () => {
  it("accepts a confident Jev choice only when it is an eligible tier", () => {
    expect(
      resolveTaskRoute({
        fallbackTier: "standard",
        eligibleTiers: ["light", "standard", "heavy"],
        decision: {
          tier: "light",
          confidence: 0.91,
          selectedProbability: 0.89,
        },
      }),
    ).toEqual({
      tier: "light",
      source: "jev",
      fallbackReason: null,
    });
  });

  it("falls back locally when a provider returns malformed confidence", () => {
    expect(
      resolveTaskRoute({
        fallbackTier: "standard",
        eligibleTiers: ["light", "standard", "heavy"],
        decision: {
          tier: "light",
          confidence: Number.NaN,
          selectedProbability: 0.99,
        },
      }),
    ).toEqual({
      tier: "standard",
      source: "local",
      fallbackReason: "low-confidence",
    });
  });

  it("falls back locally when a provider returns an impossible probability", () => {
    expect(
      resolveTaskRoute({
        fallbackTier: "standard",
        eligibleTiers: ["light", "standard", "heavy"],
        decision: {
          tier: "heavy",
          confidence: 0.99,
          selectedProbability: 1.01,
        },
      }),
    ).toEqual({
      tier: "standard",
      source: "local",
      fallbackReason: "low-confidence",
    });
  });
});
