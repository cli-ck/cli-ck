import { describe, expect, it } from "vitest";
import { forwardStreamError } from "./transport";

// Locks the invariant behind the "An error occurred." bug: the chat transport
// must surface the real provider/model error, never the AI SDK's default mask.
describe("forwardStreamError", () => {
  it("forwards a real Error's message", () => {
    expect(forwardStreamError(new Error("model gpt-5.4-mini not found"))).toBe(
      "model gpt-5.4-mini not found",
    );
  });

  it("passes string errors through", () => {
    expect(forwardStreamError("429 rate limit exceeded")).toBe(
      "429 rate limit exceeded",
    );
  });

  it("handles null / undefined without throwing", () => {
    expect(forwardStreamError(null)).toBe("Unknown error");
    expect(forwardStreamError(undefined)).toBe("Unknown error");
  });

  it("serializes plain-object errors (e.g. provider JSON bodies)", () => {
    expect(forwardStreamError({ status: 401, message: "Unauthorized" })).toBe(
      '{"status":401,"message":"Unauthorized"}',
    );
  });

  it("never returns the AI SDK's masked default", () => {
    for (const e of [new Error("boom"), "boom", { code: 500 }, 42]) {
      expect(forwardStreamError(e)).not.toBe("An error occurred.");
    }
  });
});
