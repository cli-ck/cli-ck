import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type UIMessage,
} from "ai";
import {
  DEFAULT_MODEL_ID,
  endpointIdFromCompatModel,
  getModelContextLimit,
  isCompatModelId,
  LMSTUDIO_DEFAULT_BASE_URL,
  MAX_AGENT_STEPS,
  MLX_DEFAULT_BASE_URL,
  modelKeepsReasoning,
  OLLAMA_DEFAULT_BASE_URL,
  providerNeedsKey,
  resolveModel,
  selectSystemPrompt,
  type CustomEndpoint,
  type ProviderId,
} from "../config";
import { basename, resolvePath } from "../tools/context";
import { buildTools, type ToolContext } from "../tools/tools";
import { compactModelMessagesDetailed } from "./compact";
import type { ProviderKeys, CustomEndpointKeys } from "./keyring";
import {
  CATALOG_PROVIDERS,
  findLiveModel,
  useModelCatalogStore,
} from "./modelDiscovery";
import { createClaudeCliFetch, detectClaudeCli } from "./claudeCli";
import { native } from "./native";
import {
  createCodexFetch,
  getCodexAuth,
  getPreferredAuthMethod,
} from "./oauth/codexAuth";
import { createProxyFetch } from "./proxyFetch";

/** resolveModel only knows the static MODELS catalog; a model chosen from a
 *  provider's live-fetched list needs the same-shaped fallback here too. The
 *  catalog is populated by a background refresh kicked off from the UI, so a
 *  cold start (e.g. a saved default that's a live-only model, sent before
 *  any component has mounted to trigger that refresh) can hit this before
 *  the catalog has loaded — await one refresh pass across every provider
 *  with a configured key before giving up. */
async function resolveModelWithLiveFallback(
  modelId: string,
  endpoints: readonly CustomEndpoint[],
  keys: ProviderKeys,
) {
  try {
    return resolveModel(modelId, endpoints);
  } catch (e) {
    const live = findLiveModel(modelId);
    if (live) return live;
    await Promise.all(
      CATALOG_PROVIDERS.map((p) => {
        const apiKey = keys[p];
        return apiKey
          ? useModelCatalogStore.getState().refresh(p, apiKey)
          : undefined;
      }),
    );
    const liveAfterRefresh = findLiveModel(modelId);
    if (liveAfterRefresh) return liveAfterRefresh;
    throw e;
  }
}

const localProxyFetch = createProxyFetch({ allowPrivateNetwork: true });

const TOOL_LABELS: Record<string, (input: Record<string, unknown>) => string> =
  {
    read_file: (i) => `Reading ${shortPath(i.path)}`,
    list_directory: (i) => `Listing ${shortPath(i.path)}`,
    grep: (i) => `Grepping ${ellipsize(String(i.pattern ?? ""), 40)}`,
    glob: (i) => `Globbing ${ellipsize(String(i.pattern ?? ""), 40)}`,
    edit: (i) => `Editing ${shortPath(i.path)}`,
    multi_edit: (i) => `Editing ${shortPath(i.path)}`,
    write_file: (i) => `Writing ${shortPath(i.path)}`,
    create_directory: (i) => `Creating ${shortPath(i.path)}`,
    bash_run: (i) => `Running ${ellipsize(String(i.command ?? ""), 60)}`,
    bash_background: (i) =>
      `Spawning ${ellipsize(String(i.command ?? ""), 60)}`,
    bash_logs: () => `Reading logs`,
    bash_list: () => `Listing background processes`,
    bash_kill: () => `Stopping background process`,
    suggest_command: (i) =>
      `Suggesting ${ellipsize(String(i.command ?? ""), 60)}`,
    todo_write: (i) =>
      `Updating plan (${Array.isArray(i.todos) ? i.todos.length : 0} items)`,
    run_subagent: (i) => `Spawning ${String(i.type ?? "subagent")} subagent`,
    spawn_worker: (i) => `Spawning worker: ${ellipsize(String(i.label ?? i.prompt ?? "step"), 40)}`,
    spawn_team: (i) =>
      `Spawning team (${Array.isArray(i.teammates) ? i.teammates.length : 0})`,
  };

function shortPath(p: unknown): string {
  if (typeof p !== "string") return "";
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function ellipsize(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

export function latestUserText(uiMessages: UIMessage[]): string {
  for (let i = uiMessages.length - 1; i >= 0; i--) {
    const m = uiMessages[i];
    if (m.role !== "user") continue;
    return m.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

const PROTECTED_FILE_RE =
  /\b(?:do not|don't|never)\s+(?:change|modify|touch|edit)\s+([a-zA-Z0-9_\-./]+\.\w+)/gi;

export function extractProtectedFiles(promptText: string): Set<string> {
  const out = new Set<string>();
  for (const m of promptText.matchAll(PROTECTED_FILE_RE)) {
    out.add(basename(m[1]));
  }
  return out;
}

/** Union of whatever the caller already had protected (e.g. a worker
 *  inheriting its parent session's set) with what this turn's own prompt
 *  text says — never a replace. A delegated step's prompt is not the only
 *  source of truth for what must stay untouched. */
export function mergeProtectedFiles(
  inherited: Set<string> | undefined,
  derived: Set<string>,
): Set<string> {
  return inherited ? new Set([...inherited, ...derived]) : derived;
}

// Fix 2: skip the mandatory separate read_file round-trip for existing-file
// edits — but only for a fresh session in a small, directly-scoped
// directory. Blindly marking every file in a large real project as
// "already read" would defeat the read-before-edit safety invariant it's
// meant to enforce; this only fires where that invariant costs a real user
// nothing (a handful of files, none seen yet this session).
export const PRESEED_MAX_FILES = 20;

async function preSeedReadCacheForSmallCwd(ctx: ToolContext): Promise<void> {
  if (ctx.readCache.size > 0) return;
  const cwd = ctx.getCwd();
  if (!cwd) return;
  try {
    const entries = await native.readDir(cwd);
    const files = entries.filter((e) => e.kind === "file");
    if (files.length === 0 || files.length > PRESEED_MAX_FILES) return;
    for (const e of files) {
      const abs = resolvePath(e.name, cwd);
      try {
        const r = await native.readFile(abs);
        if (r.kind !== "text") continue;
        ctx.readCache.set(abs, { size: r.size, hash: djb2(r.content) });
      } catch {
        // best-effort — a single unreadable file shouldn't block the rest
      }
    }
  } catch {
    // best-effort — pre-seeding is an optimization, never a requirement
  }
}

export type BuildModelOptions = {
  modelIdOverride?: string;
  lmstudioBaseURL?: string;
  mlxBaseURL?: string;
  ollamaBaseURL?: string;
  openaiCompatibleBaseURL?: string;
};

const modelCache = new Map<string, LanguageModel>();

export async function buildLanguageModel(
  provider: ProviderId,
  keys: ProviderKeys,
  resolvedModelId: string,
  options: BuildModelOptions = {},
  customEndpointKey?: string | null,
): Promise<LanguageModel> {
  // Codex login stands in for a plain API key on "openai", and a detected
  // claude CLI stands in for one on "anthropic", so the "needs a key" guard
  // below has to know about both before it rejects a setup that never has
  // an api key at all.
  const codexAuth = provider === "openai" ? await getCodexAuth() : null;
  const claudeCliPath = provider === "anthropic" ? await detectClaudeCli() : null;
  const preferredAuthMethod =
    codexAuth || claudeCliPath
      ? await getPreferredAuthMethod(provider)
      : "apikey";
  const useCodex = !!codexAuth && preferredAuthMethod !== "apikey";
  const useClaudeCli = !!claudeCliPath && preferredAuthMethod !== "apikey";

  if (
    providerNeedsKey(provider) &&
    !keys[provider] &&
    !codexAuth &&
    !claudeCliPath
  ) {
    throw new Error(
      `No API key configured for ${provider}. Open Settings → AI to add one.`,
    );
  }
  const key = keys[provider] ?? "";
  const lmstudioURL = options.lmstudioBaseURL ?? LMSTUDIO_DEFAULT_BASE_URL;
  const mlxURL = options.mlxBaseURL ?? MLX_DEFAULT_BASE_URL;
  const ollamaURL = options.ollamaBaseURL ?? OLLAMA_DEFAULT_BASE_URL;
  const compatURL = options.openaiCompatibleBaseURL ?? "";
  const epKey = customEndpointKey ?? "";
  const authTag = useCodex ? "codex" : useClaudeCli ? "claude-cli" : "";
  const cacheKey = `${provider} ${key} ${epKey} ${resolvedModelId} ${lmstudioURL} ${mlxURL} ${ollamaURL} ${compatURL} ${authTag}`;
  const hit = modelCache.get(cacheKey);
  if (hit) return hit;

  let built: LanguageModel;
  switch (provider) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      built = useCodex
        ? createOpenAI({ apiKey: "codex-oauth", fetch: createCodexFetch() }).responses(
            resolvedModelId,
          )
        : createOpenAI({ apiKey: key })(resolvedModelId);
      break;
    }
    case "anthropic": {
      if (useClaudeCli) {
        const { createOpenAICompatible } = await import(
          "@ai-sdk/openai-compatible"
        );
        built = createOpenAICompatible({
          name: "claude-cli",
          // Never actually dialed, createClaudeCliFetch() intercepts every
          // call and runs the local CLI instead.
          baseURL: "http://localhost/claude-cli",
          apiKey: "claude-cli",
          fetch: createClaudeCliFetch(),
        })(resolvedModelId);
      } else {
        const { createAnthropic } = await import("@ai-sdk/anthropic");
        built = createAnthropic({ apiKey: key })(resolvedModelId);
      }
      break;
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      built = createGoogleGenerativeAI({ apiKey: key })(resolvedModelId);
      break;
    }
    case "xai": {
      const { createXai } = await import("@ai-sdk/xai");
      built = createXai({ apiKey: key })(resolvedModelId);
      break;
    }
    case "cerebras": {
      const { createCerebras } = await import("@ai-sdk/cerebras");
      built = createCerebras({ apiKey: key })(resolvedModelId);
      break;
    }
    case "deepseek": {
      const { createOpenAICompatible } = await import(
        "@ai-sdk/openai-compatible"
      );
      built = createOpenAICompatible({
        name: "deepseek",
        baseURL: "https://api.deepseek.com",
        apiKey: key,
      })(resolvedModelId);
      break;
    }
    case "mistral": {
      const { createOpenAICompatible } = await import(
        "@ai-sdk/openai-compatible"
      );
      built = createOpenAICompatible({
        name: "mistral",
        baseURL: "https://api.mistral.ai/v1",
        apiKey: key,
      })(resolvedModelId);
      break;
    }
    case "groq": {
      const { createGroq } = await import("@ai-sdk/groq");
      built = createGroq({ apiKey: key })(resolvedModelId);
      break;
    }
    case "openrouter": {
      const { createOpenAICompatible } = await import(
        "@ai-sdk/openai-compatible"
      );
      built = createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: key,
        headers: {
          "HTTP-Referer": "https://cli-ck.ai",
          "X-Title": "cli-ck",
        },
      })(resolvedModelId);
      break;
    }
    case "openai-compatible": {
      if (!compatURL) {
        throw new Error(
          "OpenAI-compatible provider has no base URL. Set it in Settings → Models.",
        );
      }
      const { createOpenAICompatible } = await import(
        "@ai-sdk/openai-compatible"
      );
      built = createOpenAICompatible({
        name: "openai-compatible",
        baseURL: compatURL,
        apiKey: epKey || key || undefined,
        fetch: localProxyFetch,
      })(resolvedModelId);
      break;
    }
    case "lmstudio": {
      const { createOpenAICompatible } = await import(
        "@ai-sdk/openai-compatible"
      );
      built = createOpenAICompatible({
        name: "lmstudio",
        baseURL: lmstudioURL,
        fetch: localProxyFetch,
      })(resolvedModelId);
      break;
    }
    case "mlx": {
      const { createOpenAICompatible } = await import(
        "@ai-sdk/openai-compatible"
      );
      built = createOpenAICompatible({
        name: "mlx",
        baseURL: mlxURL,
        fetch: localProxyFetch,
      })(resolvedModelId);
      break;
    }
    case "ollama": {
      const { createOpenAICompatible } = await import(
        "@ai-sdk/openai-compatible"
      );
      built = createOpenAICompatible({
        name: "ollama",
        baseURL: ollamaURL,
        fetch: localProxyFetch,
      })(resolvedModelId);
      break;
    }
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported provider: ${_exhaustive as ProviderId}`);
    }
  }
  modelCache.set(cacheKey, built);
  return built;
}

export type LocalProviderConfig = {
  lmstudioBaseURL?: string;
  lmstudioModelId?: string;
  mlxBaseURL?: string;
  mlxModelId?: string;
  ollamaBaseURL?: string;
  ollamaModelId?: string;
  openaiCompatibleBaseURL?: string;
  openaiCompatibleModelId?: string;
  openrouterModelId?: string;
  customEndpoints?: readonly CustomEndpoint[];
  customEndpointKeys?: CustomEndpointKeys;
};

export async function buildConfiguredLanguageModel(
  modelId: string,
  keys: ProviderKeys,
  local: LocalProviderConfig = {},
): Promise<LanguageModel> {
  if (isCompatModelId(modelId)) {
    const eid = endpointIdFromCompatModel(modelId);
    const ep = local.customEndpoints?.find((e) => e.id === eid);
    if (!ep) throw new Error(`Custom endpoint not found: ${eid}`);
    if (!ep.modelId.trim()) {
      throw new Error(`${ep.name}: no model id set. Open Settings → Models.`);
    }
    return buildLanguageModel(
      "openai-compatible",
      keys,
      ep.modelId.trim(),
      { openaiCompatibleBaseURL: ep.baseURL },
      local.customEndpointKeys?.[eid],
    );
  }
  const m = await resolveModelWithLiveFallback(modelId, [], keys);
  let resolvedId: string = m.id;
  if (m.id === "lmstudio-local") {
    if (!local.lmstudioModelId?.trim()) {
      throw new Error(
        "LM Studio: no model id set. Open Settings → Models and enter the model id loaded in LM Studio.",
      );
    }
    resolvedId = local.lmstudioModelId.trim();
  } else if (m.id === "mlx-local") {
    if (!local.mlxModelId?.trim()) {
      throw new Error(
        "MLX: no model id set. Open Settings → Models and enter the model id served by mlx_lm.server.",
      );
    }
    resolvedId = local.mlxModelId.trim();
  } else if (m.id === "ollama-local") {
    if (!local.ollamaModelId?.trim()) {
      throw new Error(
        "Ollama: no model id set. Open Settings → Models and enter the model id (e.g. the name from `ollama list`).",
      );
    }
    resolvedId = local.ollamaModelId.trim();
  } else if (m.id === "openai-compatible-custom") {
    if (!local.openaiCompatibleModelId?.trim()) {
      throw new Error(
        "OpenAI-compatible: no model id set. Open Settings → Models.",
      );
    }
    resolvedId = local.openaiCompatibleModelId.trim();
  } else if (m.id === "openrouter-custom") {
    if (!local.openrouterModelId?.trim()) {
      throw new Error(
        "OpenRouter: no model id set. Open Settings → Models and enter an OpenRouter model id (e.g. anthropic/claude-sonnet-4-6).",
      );
    }
    resolvedId = local.openrouterModelId.trim();
  }
  return buildLanguageModel(m.provider, keys, resolvedId, {
    lmstudioBaseURL: local.lmstudioBaseURL,
    mlxBaseURL: local.mlxBaseURL,
    ollamaBaseURL: local.ollamaBaseURL,
    openaiCompatibleBaseURL: local.openaiCompatibleBaseURL,
  });
}

const PLAN_MODE_PROMPT = `## PLAN MODE — ACTIVE
Mutating tools (write_file, edit, multi_edit, create_directory) will queue their changes for the user to review as a single diff. Do NOT execute bash_run or bash_background while plan mode is active — restrict yourself to reads (read_file, grep, glob, list_directory) and the queued mutations. After queueing the full set of edits, stop and return a brief summary; do not continue acting until the user has accepted/rejected.`;

function buildStableSystem(
  modelId: string,
  persona: { name: string; instructions: string } | null,
  customInstructions: string | undefined,
  projectMemory: string | null,
  modelNotes: string | undefined,
): string {
  const base = selectSystemPrompt(modelId);
  const personaBlock = persona?.instructions.trim()
    ? `\n\n## ACTIVE AGENT — ${persona.name}\n${persona.instructions.trim()}`
    : "";
  const customBlock = customInstructions?.trim()
    ? `\n\n## USER CUSTOM INSTRUCTIONS — follow unless they conflict with safety rules above\n${customInstructions.trim()}`
    : "";
  const memoryBlock =
    projectMemory && projectMemory.trim().length > 0
      ? `\n\n## PROJECT — cli-ck.md\n${projectMemory.trim()}`
      : "";
  const notesBlock = modelNotes?.trim()
    ? `\n\n## KNOWN LIMITATIONS OF THIS MODEL (user-written) — work around these\n${modelNotes.trim()}`
    : "";
  return `${base}${memoryBlock}${personaBlock}${customBlock}${notesBlock}`;
}

// OpenAI / Gemini / DeepSeek apply prefix caching automatically; only
// Anthropic needs explicit breakpoints. Mark the stable system prefix and
// the rotating conversation tail.
function withCacheMarker<T extends ModelMessage | SystemModelMessage>(m: T): T {
  return {
    ...m,
    providerOptions: {
      ...(m.providerOptions ?? {}),
      anthropic: { cacheControl: { type: "ephemeral" as const } },
    },
  };
}

// Marks the first system instruction and the last conversation message as
// Anthropic prompt-cache breakpoints. Split into two arrays (`instructions`
// vs `messages`) since ai@7.0.42 rejects role:"system" entries inside
// `messages` by default (see the streamText call below).
function applyCacheBreakpoints(
  instructions: SystemModelMessage[],
  messages: ModelMessage[],
  provider: ProviderId,
): { instructions: SystemModelMessage[]; messages: ModelMessage[] } {
  if (provider !== "anthropic") return { instructions, messages };
  const outInstructions = instructions.slice();
  if (outInstructions.length > 0)
    outInstructions[0] = withCacheMarker(outInstructions[0]);
  const outMessages = messages.slice();
  const lastIdx = outMessages.length - 1;
  if (lastIdx >= 0)
    outMessages[lastIdx] = withCacheMarker(outMessages[lastIdx]);
  return { instructions: outInstructions, messages: outMessages };
}

// Fix 3: drop the tools that are provably inert without an active terminal
// tab — they cost real schema tokens on every call regardless of whether
// they're used, and can't do anything useful with nothing to act on. Search
// (grep/glob), subagent, todo, and managed-agent tools are left untouched:
// those are real capability a task may need regardless of terminal state,
// not something safe to guess about.
const TERMINAL_ONLY_TOOLS = new Set([
  "bash_background",
  "bash_logs",
  "bash_list",
  "bash_kill",
  "suggest_command",
  "open_preview",
  "get_terminal_output",
]);

function trimTerminalOnlyTools<T extends Record<string, unknown>>(
  tools: T,
  ctx: ToolContext,
): T {
  if (ctx.getTerminalContext() !== null) return tools;
  const out = { ...tools };
  for (const name of TERMINAL_ONLY_TOOLS) delete out[name];
  return out;
}

// Fix 4: once 2+ newer tool-result messages exist after an older one, drop
// its (potentially large) file/command output — the model already moved
// past it, and every later step otherwise re-pays to carry it in context.
function pruneToolHistory(messages: ModelMessage[]): ModelMessage[] {
  const toolMsgIdx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "tool") toolMsgIdx.push(i);
  });
  const keepFrom =
    toolMsgIdx.length > 2 ? toolMsgIdx[toolMsgIdx.length - 2] : -1;
  return messages.map((m, i) => {
    if (m.role !== "tool" || i >= keepFrom || !Array.isArray(m.content))
      return m;
    return {
      ...m,
      content: m.content.map((part) => {
        if (part.type !== "tool-result") return part;
        const out = part.output as
          | { type?: string; value?: Record<string, unknown> }
          | Record<string, unknown>;
        const val =
          out && typeof out === "object" && "value" in out
            ? (out as { value?: Record<string, unknown> }).value
            : (out as Record<string, unknown>);
        if (
          val &&
          typeof val === "object" &&
          typeof val.content === "string" &&
          val.content.length > 200
        ) {
          const trimmedVal = {
            ...val,
            content: "[omitted — superseded by a later step]",
          };
          const trimmedOut =
            out && typeof out === "object" && "value" in out
              ? { ...out, value: trimmedVal }
              : trimmedVal;
          return { ...part, output: trimmedOut };
        }
        return part;
      }),
    } as ModelMessage;
  });
}

export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

export type AgentUsageDelta = AgentUsage & {
  lastInputTokens: number;
  lastCachedTokens: number;
};

const EMPTY_USAGE: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
};

export type RunAgentOptions = {
  keys: ProviderKeys;
  modelId?: string;
  customInstructions?: string;
  agentPersona?: { name: string; instructions: string } | null;
  toolContext: ToolContext;
  onStep?: (step: string | null) => void;
  onUsage?: (delta: AgentUsageDelta) => void;
  onCompact?: (info: { droppedCount: number }) => void;
  onFinishMeta?: (info: { hitStepCap: boolean; finishReason: string }) => void;
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
  customEndpointKeys?: CustomEndpointKeys;
  planMode?: boolean;
  projectMemory?: string | null;
  /** Free-text notes the user wrote for this specific model (Settings →
   *  Models), e.g. "weak at CSS, don't ask it to write frontend styles". */
  modelNotes?: string;
  uiMessages: UIMessage[];
  abortSignal?: AbortSignal;
  /** Restricts the built toolset to tools passing this predicate. Used to
   *  strip recursion-prone tools (run_subagent, spawn_worker, ...) from a
   *  disposable worker run without duplicating buildTools' wiring. Omit to
   *  keep the full toolset (main session behavior, unchanged). */
  toolFilter?: (toolName: string) => boolean;
  /** Step ceiling for this run. Omit to use MAX_AGENT_STEPS (main session
   *  behavior, unchanged) — a disposable worker run passes a tier-scaled
   *  budget (see SUBAGENT_MAX_STEPS) so a "light" step doesn't cost as much
   *  runway as a "heavy" one. */
  maxSteps?: number;
};

export async function runAgentStream(opts: RunAgentOptions) {
  const modelId = opts.modelId ?? DEFAULT_MODEL_ID;
  const model = await buildConfiguredLanguageModel(modelId, opts.keys, {
    lmstudioBaseURL: opts.lmstudioBaseURL,
    lmstudioModelId: opts.lmstudioModelId,
    mlxBaseURL: opts.mlxBaseURL,
    mlxModelId: opts.mlxModelId,
    ollamaBaseURL: opts.ollamaBaseURL,
    ollamaModelId: opts.ollamaModelId,
    openaiCompatibleBaseURL: opts.openaiCompatibleBaseURL,
    openaiCompatibleModelId: opts.openaiCompatibleModelId,
    openrouterModelId: opts.openrouterModelId,
    customEndpoints: opts.customEndpoints,
    customEndpointKeys: opts.customEndpointKeys,
  });
  const endpoints = opts.customEndpoints ?? [];
  const info = await resolveModelWithLiveFallback(
    modelId,
    endpoints,
    opts.keys,
  );
  const provider = info.provider;

  const stableSystem = buildStableSystem(
    modelId,
    opts.agentPersona ?? null,
    opts.customInstructions,
    opts.projectMemory ?? null,
    opts.modelNotes,
  );

  const history = await convertToModelMessages(opts.uiMessages);
  const keepsReasoning = modelKeepsReasoning(info);
  const prunedHistory = pruneMessages({
    messages: history,
    reasoning: keepsReasoning ? "none" : "before-last-message",
    emptyMessages: "remove",
  });
  const compatCtxOverride = isCompatModelId(modelId)
    ? endpoints.find((e) => e.id === endpointIdFromCompatModel(modelId))
        ?.contextLimit
    : opts.openaiCompatibleContextLimit;
  const compact = compactModelMessagesDetailed(
    prunedHistory,
    getModelContextLimit(modelId, compatCtxOverride),
  );
  const compactedHistory = compact.messages;
  if (compact.compacted) {
    opts.onCompact?.({ droppedCount: compact.droppedCount });
  }

  const instructions: SystemModelMessage[] = [
    { role: "system", content: stableSystem },
  ];
  if (opts.planMode) {
    instructions.push({ role: "system", content: PLAN_MODE_PROMPT });
  }

  const { instructions: finalInstructions, messages: finalMessages } =
    applyCacheBreakpoints(instructions, compactedHistory, provider);

  // Fix 2 + Fix 5 setup: pre-seed the read-before-edit cache for small,
  // freshly-started scopes, and derive this turn's protected-file set from
  // what the user actually asked not to touch. Union with whatever the
  // caller already supplied (e.g. a worker run inheriting the parent
  // session's protected files) rather than overwriting it — a delegated
  // step's own prompt text is not the only source of truth for what must
  // stay untouched.
  await preSeedReadCacheForSmallCwd(opts.toolContext);
  const effectiveToolContext: ToolContext = {
    ...opts.toolContext,
    protectedFiles: mergeProtectedFiles(
      opts.toolContext.protectedFiles,
      extractProtectedFiles(latestUserText(opts.uiMessages)),
    ),
  };
  let tools = trimTerminalOnlyTools(
    buildTools(effectiveToolContext),
    effectiveToolContext,
  );
  if (opts.toolFilter) {
    const filter = opts.toolFilter;
    tools = Object.fromEntries(
      Object.entries(tools).filter(([name]) => filter(name)),
    ) as typeof tools;
  }

  let stepsSeen = 0;
  return streamText({
    model,
    instructions: finalInstructions,
    messages: finalMessages,
    // The stable system prompt is embedded as messages[0] above rather than
    // passed via the separate `system`/`instructions` option. That was
    // already true before this change, but adding `prepareStep` (which
    // returns a `messages` override per step) pushes the request through a
    // stricter per-step validation path that rejects an embedded system
    // message unless this is declared explicitly — observed as
    // AI_InvalidPromptError without it, on both ai@7.0.42 and ai@7.0.77.
    allowSystemInMessages: true,
    tools,
    stopWhen: stepCountIs(opts.maxSteps ?? MAX_AGENT_STEPS),
    abortSignal: opts.abortSignal,
    prepareStep: ({ messages: stepMessages }) => ({
      messages: pruneToolHistory(stepMessages),
    }),
    onStepFinish: (step) => {
      stepsSeen++;
      if (opts.onStep) {
        const last = step.toolCalls?.[step.toolCalls.length - 1];
        if (last) {
          const label = TOOL_LABELS[last.toolName];
          opts.onStep(
            label
              ? label((last.input ?? {}) as Record<string, unknown>)
              : `Calling ${last.toolName}`,
          );
        } else if (step.text) {
          opts.onStep("Writing");
        }
      }
      if (opts.onUsage && step.usage) {
        const u = step.usage;
        const stepInput = u.inputTokens ?? 0;
        const stepCached = u.inputTokenDetails?.cacheReadTokens ?? 0;
        opts.onUsage({
          inputTokens: stepInput,
          outputTokens: u.outputTokens ?? 0,
          cachedInputTokens: stepCached,
          lastInputTokens: stepInput,
          lastCachedTokens: stepCached,
        });
      }
    },
    onFinish: (result) => {
      opts.onStep?.(null);
      const finishReason =
        (result as { finishReason?: string } | undefined)?.finishReason ?? "";
      opts.onFinishMeta?.({
        hitStepCap: stepsSeen >= (opts.maxSteps ?? MAX_AGENT_STEPS),
        finishReason,
      });
    },
  });
}

export { EMPTY_USAGE };
