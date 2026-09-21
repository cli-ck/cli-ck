import type { ModelTier } from "../config";

export const JEV_ROUTE_CONFIDENCE_THRESHOLD = 0.85;

/** Off makes no request, shadow records a suggestion but keeps local Auto,
 * and active may use a locally revalidated Jev decision. */
export type JevRoutingMode = "off" | "shadow" | "active";

export type JevRouteDecision = {
  tier: string;
  confidence: number;
  selectedProbability: number;
};

export type TaskRoute = {
  tier: ModelTier;
  source: "jev" | "local";
  fallbackReason:
    | "missing-decision"
    | "ineligible-tier"
    | "low-confidence"
    | null;
};

/**
 * Resolves the one decision Jev may make for Auto mode: select an already
 * eligible model tier. Provider calls, candidate construction, and every
 * capability/policy check stay outside this pure boundary.
 */
export function resolveTaskRoute({
  fallbackTier,
  eligibleTiers,
  decision,
  confidenceThreshold = JEV_ROUTE_CONFIDENCE_THRESHOLD,
}: {
  fallbackTier: ModelTier;
  eligibleTiers: readonly ModelTier[];
  decision?: JevRouteDecision | null;
  confidenceThreshold?: number;
}): TaskRoute {
  if (!decision) {
    return {
      tier: fallbackTier,
      source: "local",
      fallbackReason: "missing-decision",
    };
  }

  if (!eligibleTiers.includes(decision.tier as ModelTier)) {
    return {
      tier: fallbackTier,
      source: "local",
      fallbackReason: "ineligible-tier",
    };
  }

  if (
    !Number.isFinite(decision.confidence) ||
    !Number.isFinite(decision.selectedProbability) ||
    decision.confidence > 1 ||
    decision.selectedProbability > 1 ||
    decision.confidence < confidenceThreshold ||
    decision.selectedProbability < confidenceThreshold
  ) {
    return {
      tier: fallbackTier,
      source: "local",
      fallbackReason: "low-confidence",
    };
  }

  return {
    tier: decision.tier as ModelTier,
    source: "jev",
    fallbackReason: null,
  };
}
