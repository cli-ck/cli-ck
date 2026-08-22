import {
  frictionRateOf,
  isHighFrictionEntry,
  nextFrictionEntry,
  type FrictionEntry,
} from "@/features/ai-companion/ai/lib/modelFriction";
import { describe, expect, it } from "vitest";

describe("nextFrictionEntry", () => {
  it("increments the matching outcome", () => {
    const e = nextFrictionEntry({ ok: 2, stepCap: 1 }, "ok");
    expect(e).toEqual({ ok: 3, stepCap: 1 });
  });

  it("starts fresh from undefined", () => {
    expect(nextFrictionEntry(undefined, "stepCap")).toEqual({
      ok: 0,
      stepCap: 1,
    });
  });

  it("halves both counters once the sample cap is crossed", () => {
    const e = nextFrictionEntry({ ok: 30, stepCap: 10 }, "ok");
    // 30 + 10 + 1 = 41 > 40 -> decay
    expect(e).toEqual({ ok: 15, stepCap: 5 });
  });
});

describe("frictionRateOf / isHighFrictionEntry", () => {
  it("reads 0 with too few samples, even at 100% step-cap", () => {
    const e: FrictionEntry = { ok: 0, stepCap: 3 };
    expect(frictionRateOf(e)).toBe(0);
    expect(isHighFrictionEntry(e)).toBe(false);
  });

  it("flags a model whose recent turns mostly hit the step cap", () => {
    const e: FrictionEntry = { ok: 2, stepCap: 3 };
    expect(frictionRateOf(e)).toBeCloseTo(0.6);
    expect(isHighFrictionEntry(e)).toBe(true);
  });

  it("does not flag a mostly-healthy model", () => {
    const e: FrictionEntry = { ok: 8, stepCap: 1 };
    expect(isHighFrictionEntry(e)).toBe(false);
  });
});
