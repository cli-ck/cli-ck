import { Chat, type UIMessage } from "@ai-sdk/react";
import {
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type ChatTransport,
} from "ai";
import { DEFAULT_MODEL_ID, type ModelTier } from "../config";
import type { ToolContext } from "../tools/context";
import {
  createContextAwareTransport,
  type LocalProviderConfig,
} from "./transport";
import type { CustomEndpointKeys, ProviderKeys } from "./keyring";
import { availableModelsForTiers, resolveTierModel } from "./modelTiers";

/** Tools a disposable worker must never see: spawning another worker/team or
 *  an external CLI agent recursively, or reaching into the parent session's
 *  managed-agent state (worker sessions are their own throwaway id). */
const RECURSION_BLOCKED_TOOLS = new Set([
  "run_subagent",
  "spawn_worker",
  "spawn_team",
  "spawn_coding_agent",
  "send_to_agent",
  "read_agent_output",
]);

export type WorkerRole = "planner" | "builder" | "reviewer" | "step";

const ROLE_INSTRUCTIONS: Record<WorkerRole, string> = {
  planner:
    "You are the planner. Read what's needed, then return a concrete, ordered step list for the builder to execute. Do not write or run anything yourself.",
  builder:
    "You are the builder. Implement the assigned work using your tools. Mutating calls (write_file, edit, bash_run, ...) still require the user's approval, same as any other agent.",
  reviewer:
    "You are the reviewer. Inspect the specified change and report actionable findings only: correctness, architecture, performance, security. Read-only — do not attempt to fix anything yourself.",
  step: "You are executing one self-contained step of a larger plan handed to you by the main agent. Do only this step, then stop and summarize what you did.",
};

export type WorkerDeps = {
  getKeys: () => ProviderKeys;
  getWorkspaceRoot: () => string | null;
  getCwd: () => string | null;
  getTerminalContext: () => string | null;
  isActiveTerminalPrivate: () => boolean;
  injectIntoActivePty: (text: string) => boolean;
  openPreview: (url: string) => boolean;
  getModelTiers: () => Partial<Record<ModelTier, string>>;
  getLocalProviderConfig: () => LocalProviderConfig;
  getCustomEndpointKeys: () => CustomEndpointKeys;
};

export type WorkerHandle = {
  id: string;
  role: WorkerRole;
  modelId: string;
  chat: Chat<UIMessage>;
};

const READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_directory",
  "grep",
  "glob",
]);

/** Pure — the actual tool-access decision per role, directly testable
 *  without constructing a Chat (see workerRun.test.ts). planner/reviewer
 *  never get a mutating tool no matter what buildTools returns; builder/step
 *  get everything except the recursion-prone tools. */
export function toolFilterForRole(role: WorkerRole): (name: string) => boolean {
  if (role === "planner" || role === "reviewer") {
    return (name) => READ_ONLY_TOOLS.has(name);
  }
  return (name) => !RECURSION_BLOCKED_TOOLS.has(name);
}

/** Builds a fresh, non-persisted Chat for one worker run. Never registered in
 *  the session store's `chats` map (see aiChatStore.ts) — nothing about it is
 *  written to disk, and it's discarded once the caller drops the reference. */
export function createWorkerChat(
  deps: WorkerDeps,
  role: WorkerRole,
  tier: ModelTier,
): WorkerHandle {
  const id = `worker:${crypto.randomUUID()}`;
  const available = availableModelsForTiers(deps.getKeys());
  const resolved = resolveTierModel(tier, available, deps.getModelTiers());
  const modelId = resolved?.id ?? DEFAULT_MODEL_ID;

  const readCache = new Map<string, { size: number; hash: number }>();
  const toolContext: ToolContext = {
    getCwd: deps.getCwd,
    getWorkspaceRoot: deps.getWorkspaceRoot,
    getTerminalContext: deps.getTerminalContext,
    isActiveTerminalPrivate: deps.isActiveTerminalPrivate,
    injectIntoActivePty: deps.injectIntoActivePty,
    openPreview: deps.openPreview,
    spawnAgent: () => null,
    readAgentOutput: () => null,
    readCache,
    getSessionId: () => id,
  };

  const transport = createContextAwareTransport({
    getKeys: deps.getKeys,
    toolContext,
    getModelId: () => modelId,
    getCustomInstructions: () => "",
    getAgentPersona: () => ({
      name: role[0].toUpperCase() + role.slice(1),
      instructions: ROLE_INSTRUCTIONS[role],
    }),
    getLive: () => ({
      cwd: deps.getCwd(),
      terminalPrivate: deps.isActiveTerminalPrivate(),
      workspaceRoot: deps.getWorkspaceRoot(),
      activeFile: null,
    }),
    getLocalProviderConfig: deps.getLocalProviderConfig,
    getCustomEndpointKeys: deps.getCustomEndpointKeys,
    toolFilter: toolFilterForRole(role),
  }) as unknown as ChatTransport<UIMessage>;

  const chat = new Chat<UIMessage>({
    id,
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });
  return { id, role, modelId, chat };
}

function hasPendingApproval(messages: readonly UIMessage[]): boolean {
  for (const m of messages) {
    for (const p of m.parts as ReadonlyArray<{ type: string; state?: string }>) {
      if (p.type.startsWith("tool-") && p.state === "approval-requested") {
        return true;
      }
    }
  }
  return false;
}

const POLL_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isSettled(chat: WorkerHandle["chat"]): boolean {
  return (
    chat.status !== "submitted" &&
    chat.status !== "streaming" &&
    !hasPendingApproval(chat.messages)
  );
}

/** Sends `prompt` and waits for the run to fully settle, including any
 *  approval round-trips (the AI SDK's `sendMessage()` promise only spans one
 *  request; `sendAutomaticallyWhen` silently re-sends after each approval
 *  response, so completion has to be observed by polling chat state). Two
 *  consecutive "settled" polls are required before returning — a single
 *  check can land in the brief gap between an approval response landing and
 *  `sendAutomaticallyWhen` kicking off the resumed request. */
export async function runWorkerToCompletion(
  handle: WorkerHandle,
  prompt: string,
): Promise<{ summary: string; toolCalls: number }> {
  const { chat } = handle;
  await chat.sendMessage({ text: prompt });
  let consecutiveSettled = 0;
  while (consecutiveSettled < 2) {
    if (isSettled(chat)) {
      consecutiveSettled++;
    } else {
      consecutiveSettled = 0;
    }
    await sleep(POLL_MS);
  }
  const last = chat.messages[chat.messages.length - 1];
  const summary =
    last?.role === "assistant"
      ? (last.parts as ReadonlyArray<{ type: string; text?: string }>)
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("\n")
          .trim()
      : "";
  const toolCalls = chat.messages.reduce((n, m) => {
    return (
      n +
      (m.parts as ReadonlyArray<{ type: string }>).filter((p) =>
        p.type.startsWith("tool-"),
      ).length
    );
  }, 0);
  return {
    summary: summary || (chat.status === "error" ? "(worker errored)" : "(no output)"),
    toolCalls,
  };
}
