import {
  deriveModelTier,
  type ModelInfo,
  type ModelTier,
  providerNeedsKey,
} from "../config";
import type { ProviderKeys } from "./keyring";
import { getAllEffectiveModelsSnapshot } from "./modelDiscovery";

const TIER_ORDER: readonly ModelTier[] = ["light", "standard", "heavy"];

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
 *  Returns undefined only when `available` is empty entirely. */
export function resolveTierModel(
  tier: ModelTier,
  available: readonly ModelInfo[],
  overrides: Partial<Record<ModelTier, string>>,
): ModelInfo | undefined {
  const startIdx = TIER_ORDER.indexOf(tier);
  const tryTier = (t: ModelTier): ModelInfo | undefined => {
    const overrideId = overrides[t];
    if (overrideId) {
      const m = available.find((x) => x.id === overrideId);
      if (m) return m;
    }
    return available.find((x) => deriveModelTier(x) === t);
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
