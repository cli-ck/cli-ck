import { describe, expect, it } from "vitest";
import { flattenMessagesForClaudeCli } from "./claudeCli";

describe("flattenMessagesForClaudeCli", () => {
  it("labels each turn by role", () => {
    const out = flattenMessagesForClaudeCli([
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
    expect(out).toBe("System: Be concise.\n\nUser: Hi\n\nAssistant: Hello");
  });

  it("joins text parts from an array-shaped content field", () => {
    const out = flattenMessagesForClaudeCli([
      {
        role: "user",
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      },
    ]);
    expect(out).toBe("User: line one\nline two");
  });

  it("drops non-text parts and empty turns", () => {
    const out = flattenMessagesForClaudeCli([
      { role: "user", content: [{ type: "image", text: "ignored" }] },
      { role: "user", content: "" },
      { role: "user", content: "real message" },
    ]);
    expect(out).toBe("User: real message");
  });

  it("defaults an unknown role to User", () => {
    const out = flattenMessagesForClaudeCli([{ content: "no role given" }]);
    expect(out).toBe("User: no role given");
  });

  it("returns an empty string for no usable messages", () => {
    expect(flattenMessagesForClaudeCli([])).toBe("");
    expect(flattenMessagesForClaudeCli([{ role: "user", content: "" }])).toBe("");
  });
});
