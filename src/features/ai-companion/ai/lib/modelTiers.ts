import {
  deriveModelTier,
  getModelContextLimit,
  type ModelInfo,
  type ModelTier,
  providerNeedsKey,
} from "../config";
import type { ProviderKeys } from "./keyring";
import { getAllEffectiveModelsSnapshot } from "./modelDiscovery";

const TIER_ORDER: readonly ModelTier[] = ["light", "standard", "heavy"];

/** Same threshold compact.ts starts hard-truncating history at (see
 *  compactModelMessagesDetailed). Routing a turn to a model that would
 *  immediately trigger that truncation defeats the point of routing to it
 *  for cost — so a tier is only "safe" here if it wouldn't. */
const CONTEXT_SAFETY_MARGIN = 0.7;

function fitsContext(m: ModelInfo, estimatedTokens: number): boolean {
  return estimatedTokens <= getModelContextLimit(m.id) * CONTEXT_SAFETY_MARGIN;
}

/** Next stronger tier, or null when already at "heavy" — used to offer a
 *  retry after a lighter tier stalls on a turn. */
export function nextTierUp(tier: ModelTier): ModelTier | null {
  const idx = TIER_ORDER.indexOf(tier);
  return idx >= 0 && idx < TIER_ORDER.length - 1 ? TIER_ORDER[idx + 1] : null;
}

/** Models the user can actually call right now — has a key (or the provider
 *  is keyless), from the live-enriched catalog. */
export function availableModelsForTiers(keys: ProviderKeys): ModelInfo[] {
  return getAllEffectiveModelsSnapshot().filter(
    (m) => !providerNeedsKey(m.provider) || !!keys[m.provider],
  );
}

/** Resolves a tier to a concrete model: user override first, else the first
 *  available model that auto-derives to that tier. Falls back upward through
 *  the remaining tiers (escalating is safer than under-provisioning), then —
 *  as a last resort, so the caller never ends up with nothing — downward.
 *  Returns undefined only when `available` is empty entirely.
 *
 *  `estimatedTokens`, when passed, additionally restricts candidates to
 *  models whose context window comfortably fits the current conversation —
 *  routing a turn to a tier so small it immediately forces a lossy history
 *  compaction isn't actually a saving. Omit it for callers that aren't
 *  resolving a model for a real request (e.g. a cost-savings estimate).
 *
 *  `isHighFriction`, when passed, de-prioritizes (never excludes outright) a
 *  candidate that's been unreliable — see modelFriction.ts. A tier with only
 *  a flagged candidate still returns it; friction only breaks ties within a
 *  tier, it never leaves the caller with nothing. */
export function resolveTierModel(
  tier: ModelTier,
  available: readonly ModelInfo[],
  overrides: Partial<Record<ModelTier, string>>,
  estimatedTokens?: number,
  isHighFriction?: (modelId: string) => boolean,
): ModelInfo | undefined {
  const pool =
    estimatedTokens != null
      ? available.filter((m) => fitsContext(m, estimatedTokens))
      : available;
  // Nothing fits the conversation at all — fall back to the unfiltered pool
  // rather than stranding the caller with zero candidates; the existing
  // compaction path in aiAgent.ts still protects the request either way.
  const searchPool = pool.length > 0 ? pool : available;
  const startIdx = TIER_ORDER.indexOf(tier);
  const tryTier = (t: ModelTier): ModelInfo | undefined => {
    const overrideId = overrides[t];
    if (overrideId) {
      const m = searchPool.find((x) => x.id === overrideId);
      if (m) return m;
    }
    const inTier = searchPool.filter((x) => deriveModelTier(x) === t);
    if (isHighFriction) {
      const healthy = inTier.find((x) => !isHighFriction(x.id));
      if (healthy) return healthy;
    }
    return inTier[0];
  };
  for (let i = startIdx; i < TIER_ORDER.length; i++) {
    const hit = tryTier(TIER_ORDER[i]);
    if (hit) return hit;
  }
  for (let i = startIdx - 1; i >= 0; i--) {
    const hit = tryTier(TIER_ORDER[i]);
    if (hit) return hit;
  }
  return undefined;
}
