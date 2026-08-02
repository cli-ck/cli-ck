import { usePreferencesStore } from "@/features/layout-chrome/settings/preferences";
import { Chat, type UIMessage } from "@ai-sdk/react";
import {
  type ChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import { AUTO_MODEL_ID, getModel, type ModelId, providerNeedsKey } from "../config";
import { BUILTIN_AGENTS } from "../lib/agents";
import { createContextAwareTransport } from "../lib/transport";
import type { ToolContext } from "../tools/tools";
import { useAiAgentsStore } from "./aiAgentsStore";
import {
  chats,
  getActiveProviderKey,
  seedMessages,
  touchChat,
  useAiChatStore,
} from "./aiChatStore";
import { usePlanStore } from "./planStore";

function makeChat(sessionId: string): Chat<UIMessage> {
  const readCache = new Map<string, { size: number; hash: number }>();
  const toolContext: ToolContext = {
    getCwd: () => useAiChatStore.getState().live.getCwd(),
    getWorkspaceRoot: () => useAiChatStore.getState().live.getWorkspaceRoot(),
    getTerminalContext: () => useAiChatStore.getState().live.getTerminalContext(),
    isActiveTerminalPrivate: () =>
      useAiChatStore.getState().live.isActiveTerminalPrivate(),
    injectIntoActivePty: (text) =>
      useAiChatStore.getState().live.injectIntoActivePty(text),
    openPreview: (url) => useAiChatStore.getState().live.openPreview(url),
    spawnAgent: (prompt) =>
      useAiChatStore.getState().live.spawnManagedAgent(prompt, sessionId),
    readAgentOutput: (leafId) =>
      useAiChatStore.getState().live.readLeafBuffer(leafId),
    readCache,
    getSessionId: () => sessionId,
  };

  const transport = createContextAwareTransport({
    getKeys: () => useAiChatStore.getState().apiKeys,
    toolContext,
    getModelId: () => useAiChatStore.getState().selectedModelId,
    getCustomInstructions: () =>
      usePreferencesStore.getState().customInstructions,
    getAgentPersona: () => {
      const { activeId, customAgents } = useAiAgentsStore.getState();
      const all = [...BUILTIN_AGENTS, ...customAgents];
      const a = all.find((x) => x.id === activeId) ?? BUILTIN_AGENTS[0];
      return { name: a.name, instructions: a.instructions };
    },
    getLive: () => {
      const live = useAiChatStore.getState().live;
      return {
        cwd: live.getCwd(),
        terminalPrivate: live.isActiveTerminalPrivate(),
        workspaceRoot: live.getWorkspaceRoot(),
        activeFile: live.getActiveFile(),
      };
    },
    getPlanMode: () => usePlanStore.getState().active,
    getLocalProviderConfig: () => {
      const p = usePreferencesStore.getState();
      return {
        lmstudioBaseURL: p.lmstudioBaseURL,
        lmstudioModelId: p.lmstudioModelId,
        mlxBaseURL: p.mlxBaseURL,
        mlxModelId: p.mlxModelId,
        ollamaBaseURL: p.ollamaBaseURL,
        ollamaModelId: p.ollamaModelId,
        openaiCompatibleBaseURL: p.openaiCompatibleBaseURL,
        openaiCompatibleModelId: p.openaiCompatibleModelId,
        openaiCompatibleContextLimit: p.openaiCompatibleContextLimit,
        openrouterModelId: p.openrouterModelId,
        customEndpoints: p.customEndpoints,
      };
    },
    getCustomEndpointKeys: () => useAiChatStore.getState().customEndpointKeys,
    onStep: (step) => {
      useAiChatStore.getState().patchAgentMeta({ step });
    },
    onCompact: (info) => {
      useAiChatStore.getState().patchAgentMeta({
        compactionNotice: { droppedCount: info.droppedCount, at: Date.now() },
      });
    },
    getModelTiers: () => usePreferencesStore.getState().modelTiers,
    onFinishMeta: (info) => {
      useAiChatStore.getState().patchAgentMeta({
        hitStepCap: info.hitStepCap,
        lastTurnModelId: info.modelId,
        lastTurnAutoTier: info.autoTier,
      });
    },
    onUsage: (delta, modelId) => {
      const cur = useAiChatStore.getState().agentMeta.tokens;
      useAiChatStore.getState().patchAgentMeta({
        tokens: {
          inputTokens: cur.inputTokens + delta.inputTokens,
          outputTokens: cur.outputTokens + delta.outputTokens,
          cachedInputTokens: cur.cachedInputTokens + delta.cachedInputTokens,
        },
        lastInputTokens: delta.lastInputTokens,
        lastCachedTokens: delta.lastCachedTokens,
      });
      useAiChatStore.getState().appendTurnUsage({
        modelId,
        usage: {
          inputTokens: delta.inputTokens,
          outputTokens: delta.outputTokens,
          cachedInputTokens: delta.cachedInputTokens,
        },
      });
    },
  }) as unknown as ChatTransport<UIMessage>;

  const initialMessages = seedMessages.get(sessionId);
  seedMessages.delete(sessionId);

  return new Chat<UIMessage>({
    id: sessionId,
    transport,
    messages: initialMessages,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onError: (e) => {
      useAiChatStore.getState().patchAgentMeta({
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    },
  });
}

export function getOrCreateChat(sessionId: string): Chat<UIMessage> {
  const existing = chats.get(sessionId);
  if (existing) {
    touchChat(sessionId, existing);
    return existing;
  }
  const c = makeChat(sessionId);
  touchChat(sessionId, c);
  return c;
}

export async function sendMessage(text: string): Promise<boolean> {
  const state = useAiChatStore.getState();
  const sessionId = state.activeSessionId;
  if (!sessionId) return false;
  const needsKeyCheck =
    state.selectedModelId === AUTO_MODEL_ID ||
    providerNeedsKey(getModel(state.selectedModelId as ModelId).provider);
  if (needsKeyCheck && !getActiveProviderKey()) return false;
  const c = getOrCreateChat(sessionId);
  await c.sendMessage({ text });
  return true;
}
