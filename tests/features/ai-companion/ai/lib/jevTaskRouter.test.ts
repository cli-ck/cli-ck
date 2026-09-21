import { runJevTaskRoutingJob } from "@/features/ai-companion/ai/lib/jevTaskRouter";
import { describe, expect, it, vi } from "vitest";

describe("runJevTaskRoutingJob", () => {
  it("turns a typed Jev choice into Qlik's routing decision shape", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          answers: {
            route: {
              type: "choice",
              choice: "heavy",
              confidence: 0.93,
              probabilities: { light: 0.01, standard: 0.06, heavy: 0.93 },
            },
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      runJevTaskRoutingJob(
        {
          task: "Trace this intermittent authentication failure across services.",
          taskKind: "code",
          eligibleTiers: ["light", "standard", "heavy"],
          estimatedInputTokens: 900,
          hasImage: false,
          hasRecentToolActivity: true,
        },
        { apiKey: "test-key", fetcher },
      ),
    ).resolves.toEqual({
      tier: "heavy",
      confidence: 0.93,
      selectedProbability: 0.93,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.typesafe.ai/v1/systemone",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("redacts authorization credentials before sending task text to Jev", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          answers: {
            route: {
              choice: "light",
              confidence: 0.99,
              probabilities: { light: 0.99 },
            },
          },
        }),
        { status: 200 },
      ),
    );

    await runJevTaskRoutingJob(
      {
        task: "Use Authorization: Bearer super-secret-token to call the service.",
        taskKind: "code",
        eligibleTiers: ["light"],
        estimatedInputTokens: 12,
        hasImage: false,
        hasRecentToolActivity: false,
      },
      { apiKey: "test-key", fetcher },
    );

    const body = JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string);
    expect(body.state.task).toContain("Authorization: Bearer [REDACTED]");
    expect(body.state.task).not.toContain("super-secret-token");
  });

  it("redacts provider API keys before sending task text to Jev", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          answers: {
            route: {
              choice: "light",
              confidence: 0.99,
              probabilities: { light: 0.99 },
            },
          },
        }),
        { status: 200 },
      ),
    );
    const providerKey = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";

    await runJevTaskRoutingJob(
      {
        task: `Use ${providerKey} for this request.`,
        taskKind: "code",
        eligibleTiers: ["light"],
        estimatedInputTokens: 12,
        hasImage: false,
        hasRecentToolActivity: false,
      },
      { apiKey: "test-key", fetcher },
    );

    const body = JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string);
    expect(body.state.task).toContain("[REDACTED]");
    expect(body.state.task).not.toContain(providerKey);
  });

  it("redacts environment-style secret assignments before sending task text to Jev", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          answers: {
            route: {
              choice: "light",
              confidence: 0.99,
              probabilities: { light: 0.99 },
            },
          },
        }),
        { status: 200 },
      ),
    );
    const secret = "openai-api-key-value";

    await runJevTaskRoutingJob(
      {
        task: `OPENAI_API_KEY=${secret}`,
        taskKind: "code",
        eligibleTiers: ["light"],
        estimatedInputTokens: 12,
        hasImage: false,
        hasRecentToolActivity: false,
      },
      { apiKey: "test-key", fetcher },
    );

    const body = JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string);
    expect(body.state.task).toBe("OPENAI_API_KEY=[REDACTED]");
  });
});
