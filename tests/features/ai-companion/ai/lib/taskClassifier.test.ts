import {
  classifyTaskKind,
  classifyTaskKindFromText,
} from "@/features/ai-companion/ai/lib/taskClassifier";
import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";

function userMessage(text: string): UIMessage {
  return {
    id: "1",
    role: "user",
    parts: [{ type: "text", text }],
  } as UIMessage;
}

describe("classifyTaskKindFromText", () => {
  it("classifies an implementation request as code", () => {
    expect(classifyTaskKindFromText("refactor the auth module")).toBe("code");
  });

  it("classifies a file reference as code", () => {
    expect(classifyTaskKindFromText("fix the bug in workerRun.ts")).toBe(
      "code",
    );
  });

  it("classifies a plain lookup question as read", () => {
    expect(classifyTaskKindFromText("what is a closure in JavaScript")).toBe(
      "read",
    );
  });

  it("falls back to general when neither signal fires", () => {
    expect(classifyTaskKindFromText("thanks, that helps")).toBe("general");
  });
});

describe("classifyTaskKind", () => {
  it("treats sustained tool activity as code regardless of the latest text", () => {
    const messages = [
      {
        id: "a",
        role: "assistant",
        parts: [{ type: "tool-write_file", state: "output-available" }],
      },
      {
        id: "b",
        role: "assistant",
        parts: [{ type: "tool-bash_run", state: "output-available" }],
      },
      userMessage("now do the same for utils.ts"),
    ] as unknown as UIMessage[];
    expect(classifyTaskKind(messages)).toBe("code");
  });

  it("falls back to text classification with no sustained activity", () => {
    expect(classifyTaskKind([userMessage("why does this happen")])).toBe(
      "read",
    );
  });
});
