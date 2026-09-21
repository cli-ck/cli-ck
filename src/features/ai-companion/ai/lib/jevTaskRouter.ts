import type { ModelTier } from "../config";
import type { TaskKind } from "./taskClassifier";
import type { JevRouteDecision } from "./taskRouting";

const JEV_SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
const TASK_MAX_CHARS = 6_000;

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type JevTaskRoutingJob = {
  task: string;
  taskKind: TaskKind;
  eligibleTiers: readonly ModelTier[];
  estimatedInputTokens: number;
  hasImage: boolean;
  hasRecentToolActivity: boolean;
};

type JevTaskRouterOptions = {
  apiKey: string;
  fetcher?: Fetcher;
  signal?: AbortSignal;
};

/**
 * Runs Jev's sole Qlik v1 job: choose one pre-authorized model tier for the
 * current task. The caller must still validate the answer locally before it
 * resolves a model or dispatches an agent turn.
 */
export async function runJevTaskRoutingJob(
  job: JevTaskRoutingJob,
  { apiKey, fetcher = fetch, signal }: JevTaskRouterOptions,
): Promise<JevRouteDecision | null> {
  const criteria = Object.fromEntries(
    job.eligibleTiers.map((tier) => [tier, tierDescription(tier)]),
  );
  if (Object.keys(criteria).length === 0) return null;

  try {
    const response = await fetcher(JEV_SYSTEM_ONE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "jev-latest",
        state: {
          task: redactTask(job.task).slice(0, TASK_MAX_CHARS),
          task_kind: job.taskKind,
          estimated_input_tokens: job.estimatedInputTokens,
          has_image: job.hasImage,
          has_recent_tool_activity: job.hasRecentToolActivity,
        },
        questions: {
          route: {
            type: "choice",
            instructions:
              "Choose the least costly eligible tier likely to complete this task correctly. Choose only from the provided criteria.",
            criteria,
          },
        },
      }),
      signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      answers?: {
        route?: {
          choice?: unknown;
          confidence?: unknown;
          probabilities?: Record<string, unknown>;
        };
      };
    };
    const route = data.answers?.route;
    const selectedProbability =
      typeof route?.choice === "string"
        ? route.probabilities?.[route.choice]
        : undefined;
    if (
      !route ||
      typeof route.choice !== "string" ||
      typeof route.confidence !== "number" ||
      typeof selectedProbability !== "number"
    ) {
      return null;
    }
    return {
      tier: route.choice,
      confidence: route.confidence,
      selectedProbability,
    };
  } catch {
    return null;
  }
}

function redactTask(task: string): string {
  return task
    .trim()
    .replace(/\b(authorization\s*:\s*bearer)\s+\S+/gi, "$1 [REDACTED]")
    .replace(
      /\b(?:sk|gsk|xai)-[A-Za-z0-9_-]{12,}\b|\b(?:sk|gsk)_[A-Za-z0-9_-]{12,}\b/g,
      "[REDACTED]",
    )
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET)|api[_-]?key|token|secret)\s*([=:])\s*[^\s,;]+/gi,
      "$1$2[REDACTED]",
    );
}

function tierDescription(tier: ModelTier): string {
  switch (tier) {
    case "light":
      return "Bounded lookup, explanation, or simple edit.";
    case "standard":
      return "Normal multi-step coding or tool-assisted task.";
    case "heavy":
      return "Architecture, security, difficult debugging, broad change, or high uncertainty.";
  }
}
