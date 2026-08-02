import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { MODELS, type ModelInfo, type ProviderId } from "../config";
import { createProxyFetch } from "./proxyFetch";

const cloudFetch = createProxyFetch();
const localFetch = createProxyFetch({ allowPrivateNetwork: true });

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  allowPrivateNetwork: boolean,
): Promise<unknown> {
  try {
    const res = await (allowPrivateNetwork ? localFetch : cloudFetch)(url, {
      headers,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function idsFromDataList(json: unknown): string[] | null {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  return data
    .map((m) =>
      m && typeof m === "object" ? (m as { id?: unknown }).id : null,
    )
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Every OpenAI-compatible /models endpoint (openai, xai, groq, cerebras,
 *  deepseek, mistral, openrouter, and any local server — LM Studio, MLX,
 *  Ollama, custom endpoints) returns this same `{data:[{id}]}` shape. */
export async function fetchOpenAICompatibleModelIds(
  baseURL: string,
  apiKey?: string | null,
  allowPrivateNetwork = false,
): Promise<string[] | null> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const url = `${baseURL.trim().replace(/\/+$/, "")}/models`;
  return idsFromDataList(await fetchJson(url, headers, allowPrivateNetwork));
}

export async function fetchAnthropicModelIds(
  apiKey: string,
): Promise<string[] | null> {
  const json = await fetchJson(
    "https://api.anthropic.com/v1/models",
    { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    false,
  );
  return idsFromDataList(json);
}

export async function fetchGoogleModelIds(
  apiKey: string,
): Promise<string[] | null> {
  const json = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
    {},
    false,
  );
  const models = (json as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return null;
  return models
    .map((m) => {
      const name =
        m && typeof m === "object" ? (m as { name?: unknown }).name : null;
      return typeof name === "string" ? name.replace(/^models\//, "") : null;
    })
    .filter((id): id is string => !!id);
}

/** Live model-list base URL per cloud provider — same base URLs already used
 *  to build chat completions (see aiAgent.ts). Providers not listed here
 *  (anthropic, google) have their own fetch functions above; providers whose
 *  model id is user-typed at runtime (openrouter, lmstudio, mlx, ollama,
 *  openai-compatible) are deliberately excluded — see CATALOG_PROVIDERS. */
const CATALOG_BASE_URL: Partial<Record<ProviderId, string>> = {
  openai: "https://api.openai.com/v1",
  xai: "https://api.x.ai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  deepseek: "https://api.deepseek.com",
  mistral: "https://api.mistral.ai/v1",
};

/** Providers whose *model picker* (Settings default model, chat model
 *  dropdown) should reflect the live catalog. OpenRouter/local providers pick
 *  a model by typing an id into a dedicated field instead (see
 *  useModelIdSuggestions) — merging their potentially huge live lists into
 *  this picker would break how a selection resolves to a running model. */
export const CATALOG_PROVIDERS: readonly ProviderId[] = [
  "openai",
  "anthropic",
  "google",
  "xai",
  "cerebras",
  "groq",
  "deepseek",
  "mistral",
];

async function fetchLiveIdsForProvider(
  provider: ProviderId,
  apiKey: string,
): Promise<string[] | null> {
  if (provider === "anthropic") return fetchAnthropicModelIds(apiKey);
  if (provider === "google") return fetchGoogleModelIds(apiKey);
  const baseURL = CATALOG_BASE_URL[provider];
  if (!baseURL) return null;
  return fetchOpenAICompatibleModelIds(baseURL, apiKey);
}

/** Static config.ts entries enrich whatever the live list returns, matched by
 *  id. A live id with no static match still renders — with a minimal generic
 *  label — rather than being dropped. */
function mergeLiveModels(
  provider: ProviderId,
  liveIds: readonly string[],
  staticModels: readonly ModelInfo[],
): ModelInfo[] {
  const byId = new Map(staticModels.map((m) => [m.id, m]));
  return liveIds.map(
    (id) =>
      byId.get(id) ?? {
        id,
        provider,
        label: id,
        hint: "Live",
        description: "Reported by the provider's live model list.",
        capabilities: { intelligence: 3, speed: 3, cost: 3 },
      },
  );
}

const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

type CatalogStatus = "idle" | "loading" | "ok" | "error";

type CatalogState = {
  models: Partial<Record<ProviderId, ModelInfo[]>>;
  status: Partial<Record<ProviderId, CatalogStatus>>;
  fetchedAt: Partial<Record<ProviderId, number>>;
  refresh: (
    provider: ProviderId,
    apiKey: string | null | undefined,
    force?: boolean,
  ) => Promise<void>;
};

const inflight = new Map<ProviderId, Promise<void>>();

// ponytail: in-memory only, cleared on app restart — a real cache would
// persist to disk; the 2h TTL + background refresh makes that unnecessary.
export const useModelCatalogStore = create<CatalogState>()((set, get) => ({
  models: {},
  status: {},
  fetchedAt: {},
  refresh: (provider, apiKey, force = false) => {
    if (!apiKey || !CATALOG_PROVIDERS.includes(provider)) {
      return Promise.resolve();
    }
    const state = get();
    const fresh = state.fetchedAt[provider];
    if (
      !force &&
      state.status[provider] === "ok" &&
      fresh &&
      Date.now() - fresh < CACHE_TTL_MS
    ) {
      return Promise.resolve();
    }
    const existing = inflight.get(provider);
    if (existing) return existing;

    const run = (async () => {
      set((s) => ({ status: { ...s.status, [provider]: "loading" } }));
      const staticModels = MODELS.filter((m) => m.provider === provider);
      const liveIds = await fetchLiveIdsForProvider(provider, apiKey);
      if (liveIds && liveIds.length > 0) {
        set((s) => ({
          models: {
            ...s.models,
            [provider]: mergeLiveModels(provider, liveIds, staticModels),
          },
          status: { ...s.status, [provider]: "ok" },
          fetchedAt: { ...s.fetchedAt, [provider]: Date.now() },
        }));
      } else {
        // Fetch failed or came back empty — keep last-good cache if we have
        // one, else fall back to today's static list. Never end up empty.
        set((s) => ({
          models: s.models[provider]
            ? s.models
            : { ...s.models, [provider]: staticModels },
          status: { ...s.status, [provider]: "error" },
        }));
      }
    })().finally(() => inflight.delete(provider));
    inflight.set(provider, run);
    return run;
  },
}));

/** A live-fetched model id that isn't in the static MODELS array won't
 *  resolve via config.ts's `resolveModel`/`getModel` (they only look at
 *  MODELS). Callers that resolve a possibly-live model id — building the
 *  actual language model, rendering the current selection — should check
 *  this first (or catch the "Unknown model" throw and fall back to it). */
export function findLiveModel(modelId: string): ModelInfo | undefined {
  const { models } = useModelCatalogStore.getState();
  for (const list of Object.values(models)) {
    const hit = list?.find((m) => m.id === modelId);
    if (hit) return hit;
  }
  return undefined;
}

/** Non-reactive lookup for use inside a loop over providers — call the
 *  `models` hook once at the top of the component, then use this per item
 *  instead of calling a hook per iteration. */
export function effectiveModelsFor(
  liveModels: Partial<Record<ProviderId, ModelInfo[]>>,
  provider: ProviderId,
): ModelInfo[] {
  return liveModels[provider] ?? MODELS.filter((m) => m.provider === provider);
}

/** Effective catalog across every provider, for the flat searchable chat
 *  model picker. Freeform providers (openrouter/local/custom) are untouched
 *  static placeholders — they resolve via a separately-typed model id. */
export function useAllEffectiveModels(): ModelInfo[] {
  const models = useModelCatalogStore((s) => s.models);
  return useMemo(() => {
    const seen = new Set(Object.keys(models) as ProviderId[]);
    const overridden = Object.values(models).flatMap((v) => v ?? []);
    const rest = MODELS.filter((m) => !seen.has(m.provider));
    return [...overridden, ...rest];
  }, [models]);
}

export const OPENROUTER_MODELS_BASE_URL = "https://openrouter.ai/api/v1";

/** Live model-id suggestions for a freeform (typed) model field — OpenRouter,
 *  LM Studio, MLX, Ollama, or a custom OpenAI-compatible endpoint. Silently
 *  empty on failure; the field stays a plain text input either way. */
export function useModelIdSuggestions(
  baseURL: string,
  apiKey: string | null | undefined,
  allowPrivateNetwork: boolean,
): string[] {
  const [ids, setIds] = useState<string[]>([]);
  const trimmedBase = baseURL.trim();
  useEffect(() => {
    if (!trimmedBase) {
      setIds([]);
      return;
    }
    let cancelled = false;
    void fetchOpenAICompatibleModelIds(
      trimmedBase,
      apiKey,
      allowPrivateNetwork,
    ).then((r) => {
      if (!cancelled && r) setIds(r);
    });
    return () => {
      cancelled = true;
    };
  }, [trimmedBase, apiKey, allowPrivateNetwork]);
  return ids;
}
