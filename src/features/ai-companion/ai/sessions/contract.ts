export type SessionId = string;
export type AgentId = string;
export type ProviderId = string;

export type SessionStatus =
  | "created"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type SessionCapability =
  | "attachments"
  | "tool_calls"
  | "approvals"
  | "cancellation"
  | "resume";

export type SessionIdentity = {
  sessionId: SessionId;
  agentId: AgentId;
  providerId: ProviderId;
  workspaceId: string | null;
};

export type SessionSnapshot = SessionIdentity & {
  status: SessionStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export type SessionAttachment = {
  name: string;
  mediaType: string;
  uri?: string;
  text?: string;
};

export type SessionEvent =
  | {
      type: "session.created";
      snapshot: SessionSnapshot;
    }
  | {
      type: "turn.started";
      turnId: string;
      prompt: string;
      attachments: SessionAttachment[];
    }
  | {
      type: "message.delta";
      turnId: string;
      text: string;
    }
  | {
      type: "tool.requested";
      turnId: string;
      toolCallId: string;
      toolName: string;
      arguments: unknown;
    }
  | {
      type: "tool.approval";
      turnId: string;
      toolCallId: string;
      approved: boolean;
      reason?: string;
    }
  | {
      type: "tool.result";
      turnId: string;
      toolCallId: string;
      output: unknown;
      isError: boolean;
    }
  | {
      type: "turn.progress";
      turnId: string;
      label: string;
    }
  | {
      type: "turn.completed";
      turnId: string;
    }
  | {
      type: "session.completed";
    }
  | {
      type: "session.failed";
      error: string;
      retryable: boolean;
    }
  | {
      type: "session.cancelled";
      reason?: string;
    };

export type VersionedSessionEvent = {
  revision: number;
  at: number;
  event: SessionEvent;
};

export type SessionCommand =
  | {
      type: "prompt";
      prompt: string;
      attachments?: SessionAttachment[];
    }
  | { type: "approve_tool"; toolCallId: string; reason?: string }
  | { type: "reject_tool"; toolCallId: string; reason?: string }
  | { type: "cancel"; reason?: string };

export type SessionProvider = {
  id: ProviderId;
  capabilities: readonly SessionCapability[];
  start(input: SessionStartInput): Promise<SessionSnapshot>;
  dispatch(session: SessionSnapshot, command: SessionCommand): Promise<void>;
};

export type SessionStartInput = {
  identity: SessionIdentity;
  now?: number;
};

const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export function applySessionEvent(
  snapshot: SessionSnapshot,
  event: VersionedSessionEvent,
): SessionSnapshot {
  if (event.revision !== snapshot.revision + 1) {
    throw new Error(
      `session revision mismatch: expected ${snapshot.revision + 1}, got ${event.revision}`,
    );
  }
  if (TERMINAL_STATUSES.has(snapshot.status)) {
    throw new Error(`session is already ${snapshot.status}`);
  }

  let status = snapshot.status;
  switch (event.event.type) {
    case "session.created":
      throw new Error("session.created can only be the first event");
    case "turn.started":
      status = "running";
      break;
    case "tool.approval":
      status = event.event.approved ? "running" : "waiting_for_approval";
      break;
    case "session.completed":
      status = "completed";
      break;
    case "session.failed":
      status = "failed";
      break;
    case "session.cancelled":
      status = "cancelled";
      break;
    case "message.delta":
    case "tool.requested":
    case "tool.result":
    case "turn.progress":
    case "turn.completed":
      break;
  }

  return {
    ...snapshot,
    status,
    revision: event.revision,
    updatedAt: event.at,
  };
}

export function replaySession(
  initial: SessionSnapshot,
  events: readonly VersionedSessionEvent[],
): SessionSnapshot {
  return events.reduce(applySessionEvent, initial);
}
