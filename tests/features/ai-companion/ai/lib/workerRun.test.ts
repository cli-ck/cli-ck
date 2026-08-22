import {
  runWorkerToCompletion,
  toolFilterForRole,
  WORKER_TIMEOUT_MS,
  type WorkerHandle,
} from "@/features/ai-companion/ai/lib/workerRun";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("blocks todo_write for every role (would leak an orphaned todos: entry)", () => {
    for (const role of ["planner", "builder", "reviewer", "step"] as const) {
      expect(toolFilterForRole(role)("todo_write")).toBe(false);
    }
  });
});

type FakeChatState = {
  status: string;
  messages: unknown[];
};

function fakeHandle(initial: FakeChatState) {
  const state: FakeChatState = { ...initial };
  const chat = {
    get status() {
      return state.status;
    },
    get messages() {
      return state.messages;
    },
    sendMessage: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const handle = {
    id: "worker:test",
    role: "step",
    modelId: "test-model",
    chat,
  } as unknown as WorkerHandle;
  return { handle, state };
}

describe("runWorkerToCompletion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the assistant's text once the chat settles", async () => {
    const { handle } = fakeHandle({
      status: "ready",
      messages: [
        {
          role: "assistant",
          parts: [{ type: "text", text: "done" }],
        },
      ],
    });
    const promise = runWorkerToCompletion(handle, "do the thing");
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result.summary).toBe("done");
    expect(result.timedOut).toBe(false);
  });

  it("force-stops and reports a timeout if the chat never settles", async () => {
    const { handle } = fakeHandle({ status: "streaming", messages: [] });
    const promise = runWorkerToCompletion(handle, "do the thing");
    await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS + 1000);
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(handle.chat.stop).toHaveBeenCalledOnce();
    expect(result.summary).toContain("timed out");
  });
});
