import { usePreferencesStore } from "@/features/layout-chrome/settings/preferences";
import { tool } from "ai";
import { z } from "zod";
import { SUBAGENTS, type SubagentType } from "../agents/registry";
import { runSubagent } from "../agents/runSubagent";
import { availableModelsForTiers, resolveTierModel } from "../lib/modelTiers";
import { useAiChatStore } from "../store/aiChatStore";
import type { ToolContext } from "./context";

const TYPE_KEYS = Object.keys(SUBAGENTS) as [SubagentType, ...SubagentType[]];

export function buildSubagentTools(ctx: ToolContext) {
  return {
    run_subagent: tool({
      description: `Spawn an isolated subagent with its own restricted toolset and a fresh message history. Use when you need to delegate a self-contained read-only investigation (large search, code review, security audit) without polluting your own context. The subagent returns a single text summary; pick a 'type' that matches its job.

Types:
${TYPE_KEYS.map((k) => `- ${k}: ${SUBAGENTS[k].description} Allowed tiers: ${SUBAGENTS[k].allowedTiers.join(", ")}.`).join("\n")}

Tiers (light = cheapest/fastest, standard = balanced, heavy = strongest/most expensive) map to whatever concrete model the user has configured for each — omit 'tier' to use the persona's default (its lightest allowed tier); only ask for a heavier tier when the task genuinely needs it, or as a retry after a lighter tier failed on the same task.

Auto-executes (no approval) — subagents are read-only by design.`,
      inputSchema: z.object({
        type: z.enum(TYPE_KEYS),
        tier: z
          .enum(["light", "standard", "heavy"])
          .optional()
          .describe(
            "Model weight class for this spawn. Omit to use the persona's default tier.",
          ),
        prompt: z
          .string()
          .describe(
            "Self-contained instruction. The subagent has no memory of prior conversation — include all relevant context.",
          ),
        description: z
          .string()
          .optional()
          .describe("Short label shown in the chat UI for the spawn card."),
      }),
      execute: async ({ type, tier, prompt, description }) => {
        const { apiKeys, selectedModelId, patchAgentMeta } =
          useAiChatStore.getState();
        const def = SUBAGENTS[type];
        const requestedTier = tier ?? def.allowedTiers[0];
        if (!def.allowedTiers.includes(requestedTier)) {
          return {
            error: `Tier "${requestedTier}" is not allowed for "${type}". Allowed tiers: ${def.allowedTiers.join(", ")}.`,
            type,
          };
        }
        const { modelTiers } = usePreferencesStore.getState();
        const available = availableModelsForTiers(apiKeys);
        const resolved = resolveTierModel(requestedTier, available, modelTiers);
        const modelId = resolved?.id ?? selectedModelId;
        try {
          const r = await runSubagent({
            type,
            prompt,
            keys: apiKeys,
            modelId,
            toolContext: ctx,
            onStep: (label) => patchAgentMeta({ step: label }),
          });
          return {
            type,
            description,
            summary: r.summary,
            stepCount: r.stepCount,
            durationMs: r.durationMs,
          };
        } catch (e) {
          return { error: String(e), type };
        }
      },
    }),
  } as const;
}
