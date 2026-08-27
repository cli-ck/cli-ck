import { Chat, type UIMessage } from "@ai-sdk/react";
import {
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type ChatTransport,
} from "ai";
import { SUBAGENT_MAX_STEPS } from "../agents/runSubagent";
import { DEFAULT_MODEL_ID, type ModelTier } from "../config";
import type { ToolContext } from "../tools/context";
import {
  createContextAwareTransport,
  type LocalProviderConfig,
} from "./transport";
import type { CustomEndpointKeys, ProviderKeys } from "./keyring";
import { isHighFriction } from "./modelFriction";
import { availableModelsForTiers, resolveTierModel } from "./modelTiers";
import type { TaskKind } from "./taskClassifier";

/** Tools a disposable worker must never see: spawning another worker/team or
 *  an external CLI agent recursively, or reaching into the parent session's
 *  managed-agent state (worker sessions are their own throwaway id); plus
 *  todo_write, which persists to disk keyed by session id (see lib/todos.ts)
 *  and would otherwise leave an orphaned `todos:worker:<uuid>` entry behind
 *  forever since a worker session is never explicitly deleted; plus
 *  inspect_ui_element, which waits on a live user click in the UI — a
 *  worker runs unattended, so it would just burn its own timeout budget
 *  waiting for a click that never comes. */
const WORKER_BLOCKED_TOOLS = new Set([
  "run_subagent",
  "spawn_worker",
  "spawn_team",
  "spawn_coding_agent",
  "send_to_agent",
  "read_agent_output",
  "todo_write",
  "inspect_ui_element",
]);

export type WorkerRole = "planner" | "builder" | "reviewer" | "step";

/** Role implies task domain closely enough to skip re-classifying each
 *  worker's prompt: planner/reviewer only ever read, builder only ever
 *  mutates. "step" (spawn_worker) covers either, so it stays "general" —
 *  the model isn't known yet when a step worker is created (see
 *  createWorkerChat), only once its prompt is sent. */
export const KIND_FOR_ROLE: Record<WorkerRole, TaskKind> = {
  planner: "read",
  reviewer: "read",
  builder: "code",
  step: "general",
};

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
  /** Protected-file basenames inherited from the parent session (see
   *  aiAgent.ts) — enforced regardless of whether the delegating prompt
   *  restates them, so a worker can't accidentally touch a file the
   *  original request said not to. */
  protectedFiles?: Set<string>;
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
 *  get everything except the blocked tools (recursion + session-scoped
 *  persistence a worker shouldn't touch). */
export function toolFilterForRole(role: WorkerRole): (name: string) => boolean {
  if (role === "planner" || role === "reviewer") {
    return (name) => READ_ONLY_TOOLS.has(name);
  }
  return (name) => !WORKER_BLOCKED_TOOLS.has(name);
}

/** Builds a fresh, non-persisted Chat for one worker run. Never registered in
 *  the session store's `chats` map (see aiChatStore.ts) — nothing about it is
 *  written to disk, and it's discarded once the caller drops the reference.
 *
 *  `modelIdOverride`, when given and currently available, is used directly
 *  instead of resolving `tier` — lets a caller (e.g. spawn_team) pin an
 *  exact model per role instead of only picking from the tier bucket. Falls
 *  back to tier resolution if the id isn't available (key missing, model no
 *  longer in the live catalog, ...). */
export function createWorkerChat(
  deps: WorkerDeps,
  role: WorkerRole,
  tier: ModelTier,
  modelIdOverride?: string,
): WorkerHandle {
  const id = `worker:${crypto.randomUUID()}`;
  const available = availableModelsForTiers(deps.getKeys());
  const overrideHit = modelIdOverride
    ? available.find((m) => m.id === modelIdOverride)
    : undefined;
  const modelId =
    overrideHit?.id ??
    resolveTierModel(tier, available, deps.getModelTiers(), undefined, (id) =>
      isHighFriction(id, KIND_FOR_ROLE[role]),
    )?.id ??
    DEFAULT_MODEL_ID;

  const readCache = new Map<string, { size: number; hash: number }>();
  const toolContext: ToolContext = {
    getCwd: deps.getCwd,
    getWorkspaceRoot: deps.getWorkspaceRoot,
    getTerminalContext: deps.getTerminalContext,
    isActiveTerminalPrivate: deps.isActiveTerminalPrivate,
    injectIntoActivePty: deps.injectIntoActivePty,
    openPreview: deps.openPreview,
    requestElementInspection: async () => null,
    spawnAgent: () => null,
    readAgentOutput: () => null,
    readCache,
    getSessionId: () => id,
    protectedFiles: deps.protectedFiles,
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
    maxSteps: SUBAGENT_MAX_STEPS[tier],
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
    for (const p of m.parts as ReadonlyArray<{
      type: string;
      state?: string;
    }>) {
      if (p.type.startsWith("tool-") && p.state === "approval-requested") {
        return true;
      }
    }
  }
  return false;
}

const POLL_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Worker runs are unattended (no live user watching every one, especially
 *  under spawn_team). Without a ceiling, a worker stuck on an approval
 *  nobody answers — or a main-turn abort that abandons it — polls forever:
 *  a leaked timer plus, worse, a live provider stream that keeps running
 *  and billing after everyone stopped caring. Generous enough for a real
 *  multi-step build; still a hard stop. */
export const WORKER_TIMEOUT_MS = 10 * 60_000;

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
 *  `sendAutomaticallyWhen` kicking off the resumed request.
 *
 *  Past WORKER_TIMEOUT_MS the run is force-stopped via chat.stop() (aborts
 *  the in-flight request) rather than left to poll indefinitely. */
export async function runWorkerToCompletion(
  handle: WorkerHandle,
  prompt: string,
): Promise<{ summary: string; toolCalls: number; timedOut: boolean }> {
  const { chat } = handle;
  await chat.sendMessage({ text: prompt });
  const deadline = Date.now() + WORKER_TIMEOUT_MS;
  let consecutiveSettled = 0;
  let timedOut = false;
  while (consecutiveSettled < 2) {
    if (isSettled(chat)) {
      consecutiveSettled++;
    } else {
      consecutiveSettled = 0;
    }
    if (consecutiveSettled >= 2) break;
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    await sleep(POLL_MS);
  }
  if (timedOut) {
    await chat.stop();
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
    summary: timedOut
      ? `(worker timed out after ${Math.round(WORKER_TIMEOUT_MS / 60_000)} minutes — likely stuck awaiting approval; stopped)`
      : summary ||
        (chat.status === "error" ? "(worker errored)" : "(no output)"),
    toolCalls,
    timedOut,
  };
}
