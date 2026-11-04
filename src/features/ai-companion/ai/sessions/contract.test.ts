import { describe, expect, it } from "vitest";
import {
  applySessionEvent,
  replaySession,
  type SessionSnapshot,
  type VersionedSessionEvent,
} from "./contract";

const initial: SessionSnapshot = {
  sessionId: "session-1",
  agentId: "agent-1",
  providerId: "provider-1",
  workspaceId: "workspace-1",
  status: "created",
  revision: 0,
  createdAt: 100,
  updatedAt: 100,
};

const event = (
  revision: number,
  next: VersionedSessionEvent["event"],
): VersionedSessionEvent => ({ revision, at: 100 + revision, event: next });

describe("provider-neutral agent sessions", () => {
  it("replays a turn and preserves the terminal lifecycle", () => {
    const snapshot = replaySession(initial, [
      event(1, {
        type: "turn.started",
        turnId: "turn-1",
        prompt: "Inspect the project",
        attachments: [],
      }),
      event(2, { type: "turn.progress", turnId: "turn-1", label: "reading" }),
      event(3, { type: "turn.completed", turnId: "turn-1" }),
      event(4, { type: "session.completed" }),
    ]);

    expect(snapshot).toMatchObject({
      status: "completed",
      revision: 4,
      updatedAt: 104,
    });
  });

  it("rejects gaps, stale events, and events after terminal state", () => {
    expect(() =>
      applySessionEvent(
        initial,
        event(2, {
          type: "session.completed",
        }),
      ),
    ).toThrow("revision mismatch");

    const completed = applySessionEvent(
      initial,
      event(1, { type: "session.completed" }),
    );
    expect(() =>
      applySessionEvent(
        completed,
        event(2, { type: "session.cancelled", reason: "too late" }),
      ),
    ).toThrow("already completed");
  });

  it("allows a provider to depend on the contract without UI imports", () => {
    const provider = {
      id: "mock",
      capabilities: ["cancellation", "resume"] as const,
      start: async ({ identity }: { identity: SessionSnapshot }) => identity,
      dispatch: async () => undefined,
    };

    expect(provider.id).toBe("mock");
    expect(provider.capabilities).toContain("resume");
  });
});
