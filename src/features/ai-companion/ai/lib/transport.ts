import type { UIMessage } from "@ai-sdk/react";
import { AUTO_MODEL_ID, type CustomEndpoint, DEFAULT_MODEL_ID, type ModelTier } from "../config";
import type { ToolContext } from "../tools/tools";
import { type AgentUsageDelta, runAgentStream } from "./aiAgent";
import type { CustomEndpointKeys, ProviderKeys } from "./keyring";
import { availableModelsForTiers, resolveTierModel } from "./modelTiers";
import { native } from "./native";
import {
  classifyMessageTier,
  findLastUserMessage,
  lastMessageHasImage,
} from "./taskClassifier";

const OZ_MD_MAX_BYTES = 32 * 1024;
type MemoryCacheEntry = { content: string | null; mtime: number };
const projectMemoryCache = new Map<string, MemoryCacheEntry>();

async function readOzMd(workspaceRoot: string | null): Promise<string | null> {
  if (!workspaceRoot) return null;
  const path = `${workspaceRoot.replace(/\/$/, "")}/OZ.md`;
  const cached = projectMemoryCache.get(workspaceRoot);
  if (cached && Date.now() - cached.mtime < 30_000) return cached.content;
  try {
    const r = await native.readFile(path);
    if (r.kind !== "text") {
      projectMemoryCache.set(workspaceRoot, { content: null, mtime: Date.now() });
      return null;
    }
    const content =
      r.content.length > OZ_MD_MAX_BYTES
        ? r.content.slice(0, OZ_MD_MAX_BYTES)
        : r.content;
    projectMemoryCache.set(workspaceRoot, { content, mtime: Date.now() });
    return content;
  } catch {
    projectMemoryCache.set(workspaceRoot, { content: null, mtime: Date.now() });
    return null;
  }
}

type LiveSnapshot = {
  cwd: string | null;
  terminalPrivate: boolean;
  workspaceRoot: string | null;
  activeFile: string | null;
};

/** The local/freeform provider fields, all sourced from the same preferences
 *  slice — bundled into one getter instead of one per field. */
type LocalProviderConfig = {
  lmstudioBaseURL?: string;
  lmstudioModelId?: string;
  mlxBaseURL?: string;
  mlxModelId?: string;
  ollamaBaseURL?: string;
  ollamaModelId?: string;
  openaiCompatibleBaseURL?: string;
  openaiCompatibleModelId?: string;
  openaiCompatibleContextLimit?: number;
  openrouterModelId?: string;
  customEndpoints?: readonly CustomEndpoint[];
};

type Deps = {
  getKeys: () => ProviderKeys;
  toolContext: ToolContext;
  getModelId: () => string;
  getModelTiers?: () => Partial<Record<ModelTier, string>>;
  getCustomInstructions: () => string;
  getAgentPersona: () => { name: string; instructions: string } | null;
  getLive: () => LiveSnapshot;
  getLocalProviderConfig?: () => LocalProviderConfig;
  getCustomEndpointKeys?: () => CustomEndpointKeys;
  onStep?: (step: string | null) => void;
  onUsage?: (delta: AgentUsageDelta, modelId: string) => void;
  onCompact?: (info: { droppedCount: number }) => void;
  onFinishMeta?: (info: {
    hitStepCap: boolean;
    finishReason: string;
    modelId: string;
    /** Tier the turn was routed to under Auto mode; null when the user has a
     *  specific model selected (no routing decision was made). */
    autoTier: ModelTier | null;
  }) => void;
  getPlanMode?: () => boolean;
};

type SendOptions = {
  messages: UIMessage[];
  abortSignal?: AbortSignal;
  [k: string]: unknown;
};

/**
 * Turn a stream error into the message shown to the user. Replaces the AI SDK's
 * default mask ("An error occurred.") so real provider/model errors are visible.
 * Exported for tests.
 */
export function forwardStreamError(error: unknown): string {
  if (error == null) return "Unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Resolves the Auto sentinel to a concrete model for this turn only —
 *  classified from the outgoing message, never mutates the stored selection.
 *  Returns the raw id unchanged when the user has a specific model selected. */
function resolveEffectiveModelId(
  rawModelId: string,
  messages: readonly UIMessage[],
  keys: ProviderKeys,
  tierOverrides: Partial<Record<ModelTier, string>>,
): { modelId: string; autoTier: ModelTier | null } {
  if (rawModelId !== AUTO_MODEL_ID) {
    return { modelId: rawModelId, autoTier: null };
  }
  const autoTier = classifyMessageTier(messages);
  let available = availableModelsForTiers(keys);
  if (lastMessageHasImage(messages)) {
    available = available.filter((m) => m.tags?.includes("vision"));
  }
  const resolved = resolveTierModel(autoTier, available, tierOverrides);
  return { modelId: resolved?.id ?? DEFAULT_MODEL_ID, autoTier };
}

export function createContextAwareTransport(deps: Deps) {
  const run = async (options: SendOptions) => {
    const live = deps.getLive();
    const projectMemory = await readOzMd(live.workspaceRoot);
    const envBlock = formatEnvBlock(live);
    const messagesForRun = envBlock
      ? injectEnvIntoLastUser(options.messages, envBlock)
      : options.messages;
    const { modelId, autoTier } = resolveEffectiveModelId(
      deps.getModelId(),
      messagesForRun,
      deps.getKeys(),
      deps.getModelTiers?.() ?? {},
    );
    const result = await runAgentStream({
      keys: deps.getKeys(),
      modelId,
      customInstructions: deps.getCustomInstructions(),
      agentPersona: deps.getAgentPersona(),
      toolContext: deps.toolContext,
      onStep: deps.onStep,
      onUsage: deps.onUsage
        ? (delta) => deps.onUsage?.(delta, modelId)
        : undefined,
      onCompact: deps.onCompact,
      onFinishMeta: deps.onFinishMeta
        ? (info) => deps.onFinishMeta?.({ ...info, modelId, autoTier })
        : undefined,
      ...deps.getLocalProviderConfig?.(),
      customEndpointKeys: deps.getCustomEndpointKeys?.(),
      planMode: deps.getPlanMode?.(),
      projectMemory,
      uiMessages: messagesForRun,
      abortSignal: options.abortSignal,
    });
    return result.toUIMessageStream({
      originalMessages: options.messages,
      // The AI SDK masks stream errors as the generic "An error occurred." by
      // default. Oz is a local BYOK app — there is no server secret to protect
      // — so forward the real provider/model error to the user instead, or every
      // failure (bad model id, auth, rate limit, tool error) is undiagnosable.
      onError: forwardStreamError,
    });
  };

  return {
    sendMessages: run,
    async reconnectToStream(): Promise<null> {
      return null;
    },
  };
}

function injectEnvIntoLastUser(
  messages: UIMessage[],
  envBlock: string,
): UIMessage[] {
  const found = findLastUserMessage(messages);
  if (!found) return messages;
  const { message: m, index: i } = found;
  const parts = m.parts as ReadonlyArray<{ type: string; text?: string }>;
  let textIdx = -1;
  for (let j = 0; j < parts.length; j++) {
    if (parts[j].type === "text") {
      textIdx = j;
      break;
    }
  }
  const nextParts =
    textIdx === -1
      ? [{ type: "text", text: envBlock }, ...parts]
      : parts.map((p, idx) =>
          idx === textIdx
            ? { ...p, text: `${envBlock}\n\n${p.text ?? ""}` }
            : p,
        );
  const out = messages.slice();
  out[i] = { ...m, parts: nextParts } as UIMessage;
  return out;
}

function formatEnvBlock(live: LiveSnapshot): string | null {
  const lines: string[] = [];
  if (live.workspaceRoot) lines.push(`workspace_root: ${live.workspaceRoot}`);
  if (live.cwd) lines.push(`active_terminal_cwd: ${live.cwd}`);
  if (live.activeFile) lines.push(`active_file: ${live.activeFile}`);
  if (live.terminalPrivate) lines.push("active_terminal_mode: private");
  if (lines.length === 0) return null;
  return `<env>\n${lines.join("\n")}\n</env>`;
}

export const CONTEXT_BLOCK_RE =
  /^<terminal-context[^>]*>[\s\S]*?<\/terminal-context>\n*/;

export function stripContextBlock(text: string): string {
  return text.replace(CONTEXT_BLOCK_RE, "");
}
