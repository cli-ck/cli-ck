import { usePreferencesStore } from "@/features/layout-chrome/settings/preferences";
import { useWorkerRunsStore } from "@/features/ai-companion/agents/store/workerRunsStore";
import { tool } from "ai";
import { z } from "zod";
import type { ModelTier } from "../config";
import {
  createWorkerChat,
  runWorkerToCompletion,
  type WorkerDeps,
  type WorkerRole,
} from "../lib/workerRun";
import { useAiChatStore } from "../store/aiChatStore";
import type { ToolContext } from "./context";

const TIER_ENUM = z.enum(["light", "standard", "heavy"]);

function buildWorkerDeps(): WorkerDeps {
  const { apiKeys, customEndpointKeys, live } = useAiChatStore.getState();
  const prefs = usePreferencesStore.getState();
  return {
    getKeys: () => apiKeys,
    getWorkspaceRoot: live.getWorkspaceRoot,
    getCwd: live.getCwd,
    getTerminalContext: live.getTerminalContext,
    isActiveTerminalPrivate: live.isActiveTerminalPrivate,
    injectIntoActivePty: live.injectIntoActivePty,
    openPreview: live.openPreview,
    getModelTiers: () => prefs.modelTiers,
    getCustomEndpointKeys: () => customEndpointKeys,
    getLocalProviderConfig: () => ({
      lmstudioBaseURL: prefs.lmstudioBaseURL,
      lmstudioModelId: prefs.lmstudioModelId,
      mlxBaseURL: prefs.mlxBaseURL,
      mlxModelId: prefs.mlxModelId,
      ollamaBaseURL: prefs.ollamaBaseURL,
      ollamaModelId: prefs.ollamaModelId,
      openaiCompatibleBaseURL: prefs.openaiCompatibleBaseURL,
      openaiCompatibleModelId: prefs.openaiCompatibleModelId,
      openaiCompatibleContextLimit: prefs.openaiCompatibleContextLimit,
      openrouterModelId: prefs.openrouterModelId,
      customEndpoints: prefs.customEndpoints,
    }),
  };
}

async function spawnAndRun(
  role: WorkerRole,
  kind: "step" | "team",
  tier: ModelTier,
  prompt: string,
  label: string,
  parentSessionId: string,
) {
  const handle = createWorkerChat(buildWorkerDeps(), role, tier);
  useWorkerRunsStore.getState().register({
    id: handle.id,
    role,
    modelId: handle.modelId,
    label,
    kind,
    parentSessionId,
    chat: handle.chat,
    status: "running",
  });
  try {
    const result = await runWorkerToCompletion(handle, prompt);
    useWorkerRunsStore.getState().setStatus(handle.id, "done");
    return {
      role,
      modelId: handle.modelId,
      summary: result.summary,
      toolCalls: result.toolCalls,
    };
  } catch (e) {
    useWorkerRunsStore.getState().setStatus(handle.id, "error");
    return { role, modelId: handle.modelId, error: String(e) };
  }
}

export function buildWorkerTools(ctx: ToolContext) {
  return {
    spawn_worker: tool({
      description:
        "Spawn a disposable worker with a FRESH context and full tool access (including file writes and shell commands — each mutating call still needs the user's approval, same as your own). Use this to execute ONE self-contained step of a larger task instead of doing every step in this ever-growing conversation. Pair with todo_write: write the plan first, then spawn one worker per step with only that step's instructions. Auto-executes (no approval) — spawning itself is inert, the worker's own mutating calls are each gated individually.",
      inputSchema: z.object({
        prompt: z
          .string()
          .min(1)
          .describe(
            "Self-contained instruction for exactly one step. The worker has no memory of this conversation — include all context it needs.",
          ),
        tier: TIER_ENUM.optional().describe(
          "Model weight class for this step. Omit for 'standard'.",
        ),
        label: z
          .string()
          .optional()
          .describe("Short label shown in the chat UI for this step."),
      }),
      execute: async ({ prompt, tier, label }) => {
        const sessionId = ctx.getSessionId();
        if (!sessionId) return { error: "no active chat session" };
        return spawnAndRun(
          "step",
          "step",
          tier ?? "standard",
          prompt,
          label ?? "Step",
          sessionId,
        );
      },
    }),

    spawn_team: tool({
      description:
        "Spawn multiple disposable workers CONCURRENTLY, each a different role/model, to work a task together — e.g. a planner to break down the work, a builder to implement it, a reviewer to audit the result. All run and stream at once, each with its own tool access and approval gate. Use for substantial tasks that benefit from a specialized model per role rather than one model doing everything sequentially. Auto-executes (no approval) — spawning itself is inert.",
      inputSchema: z.object({
        teammates: z
          .array(
            z.object({
              role: z.enum(["planner", "builder", "reviewer"]),
              prompt: z
                .string()
                .min(1)
                .describe("Self-contained instruction for this teammate."),
              tier: TIER_ENUM.optional().describe(
                "Model weight class. Omit for the role's default (planner/reviewer: standard, builder: heavy).",
              ),
              label: z.string().optional(),
            }),
          )
          .min(1)
          .max(4),
      }),
      execute: async ({ teammates }) => {
        const sessionId = ctx.getSessionId();
        if (!sessionId) return { error: "no active chat session" };
        const results = await Promise.all(
          teammates.map((t) =>
            spawnAndRun(
              t.role,
              "team",
              t.tier ?? (t.role === "builder" ? "heavy" : "standard"),
              t.prompt,
              t.label ?? t.role,
              sessionId,
            ),
          ),
        );
        return { teammates: results };
      },
    }),
  } as const;
}
