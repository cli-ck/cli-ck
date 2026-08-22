import { generateText, stepCountIs } from "ai";
import {
  DEFAULT_MODEL_ID,
  getModel,
  type ModelId,
  type ModelTier,
} from "../config";
import { buildLanguageModel } from "../lib/aiAgent";
import type { ProviderKeys } from "../lib/keyring";
import type { ToolContext } from "../tools/context";
import { buildFsTools } from "../tools/fs";
import { buildSearchTools } from "../tools/search";
import { SUBAGENTS, type SubagentType } from "./registry";

/** Step ceiling by requested tier — a "light" spawn should stay cheap even
 *  when it doesn't converge, not run exactly as long as a "heavy" one.
 *  Exported for tests only; call sites should go through runSubagent(). */
export const SUBAGENT_MAX_STEPS: Record<ModelTier, number> = {
  light: 6,
  standard: 12,
  heavy: 20,
};

type Args = {
  type: SubagentType;
  prompt: string;
  keys: ProviderKeys;
  modelId: string;
  tier: ModelTier;
  toolContext: ToolContext;
  lmstudioBaseURL?: string;
  onStep?: (label: string) => void;
};

type RunResult = {
  summary: string;
  stepCount: number;
  durationMs: number;
};

export async function runSubagent({
  type,
  prompt,
  keys,
  modelId,
  tier,
  toolContext,
  lmstudioBaseURL,
  onStep,
}: Args): Promise<RunResult> {
  const def = SUBAGENTS[type];
  if (!def) throw new Error(`unknown subagent type: ${type}`);

  const readOnly: Record<string, unknown> = {
    ...buildFsTools(toolContext),
    ...buildSearchTools(toolContext),
  };
  const tools: Record<string, unknown> = {};
  for (const t of def.tools) {
    if (t in readOnly) tools[t] = readOnly[t];
  }

  const model = await buildLanguageModel(
    getModel(modelId as ModelId).provider,
    keys,
    getModel(modelId as ModelId).id,
    { lmstudioBaseURL },
  );

  const start = Date.now();
  const result = await generateText({
    model,
    system: def.systemPrompt,
    prompt,
    tools: tools as Parameters<typeof generateText>[0]["tools"],
    stopWhen: stepCountIs(SUBAGENT_MAX_STEPS[tier]),
    onStepFinish: (step) => {
      if (!onStep) return;
      const last = step.toolCalls?.[step.toolCalls.length - 1];
      if (last) onStep(`${type}: ${last.toolName}`);
    },
  });

  return {
    summary: result.text || "(no output)",
    stepCount: result.steps?.length ?? 0,
    durationMs: Date.now() - start,
  };
}

export const DEFAULT_SUBAGENT_MODEL: ModelId = DEFAULT_MODEL_ID;
